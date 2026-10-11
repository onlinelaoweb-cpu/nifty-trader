'use strict';
// Renko study (11 Oct) — RESEARCH ONLY, nothing here feeds signals, gates, alerts or the UI.
//
// Part 1 (daily history): does the Renko trend state (the same BULLISH / BEARISH / NOISY / MIXED read the app computes from
//   the last 7 bricks) carry any information about the NEXT days' move? Tested on stored daily NIFTY candles.
//   Honest limit: this tests the CONCEPT on daily bars; the app itself runs on 1-minute bars (see part 2).
// Part 2 (Auto Journal): once alerts are logged with their Renko state (auto_journal_trades.ctx.renko), compare real paper
//   trades that passed the Renko gate with those that did not.
const { classifyBricks } = require('../api/renko');

const num = v => Number(v);
const r2 = x => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

function atrSeries(c, n = 14) { // simple rolling ATR, null until n bars
    const out = new Array(c.length).fill(null), tr = [];
    for (let i = 0; i < c.length; i++) {
        tr.push(i === 0 ? c[i].high - c[i].low : Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
        if (i >= n) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += tr[j]; out[i] = s / n; }
    }
    return out;
}

// Walk the closes once; brick size is re-read after every brick (percent of base level, or ATR) so a long history stays comparable.
// Returns state[t] = Renko trend read using ONLY data up to day t.
function renkoStates(candles, brickFn) {
    const states = new Array(candles.length).fill('INSUFFICIENT');
    const bricks = []; let base = candles[0].close;
    for (let t = 1; t < candles.length; t++) {
        let size = brickFn(t, base);
        if (size && size > 0) {
            let diff = candles[t].close - base;
            while (diff >= size) { bricks.push('up'); base += size; diff -= size; size = brickFn(t, base) || size; }
            while (diff <= -size) { bricks.push('down'); base -= size; diff += size; size = brickFn(t, base) || size; }
        }
        states[t] = classifyBricks(bricks).trend;
    }
    return states;
}

function fwdStats(rets) {
    const n = rets.length;
    return { n, meanPct: r2(mean(rets)), upPct: n ? Math.round(1000 * rets.filter(x => x > 0).length / n) / 10 : null, meanAbsPct: r2(mean(rets.map(Math.abs))) };
}

// Welch z for (mean A − mean B); overlapping h-day windows are not independent, so the effective sample is divided by h (conservative).
function welchZ(a, b, h = 1) {
    if (a.length < 5 || b.length < 5) return null;
    const va = sd(a) ** 2 / (a.length / h), vb = sd(b) ** 2 / (b.length / h), se = Math.sqrt(va + vb);
    return se > 0 ? r2((mean(a) - mean(b)) / se) : null;
}

function evaluateVariant(candles, states, h) {
    const by = { BULLISH: [], BEARISH: [], NOISY: [], MIXED: [], INSUFFICIENT: [] }, all = [];
    for (let t = 0; t + h < candles.length; t++) {
        const ret = (candles[t + h].close / candles[t].close - 1) * 100;
        (by[states[t]] || by.INSUFFICIENT).push(ret); all.push(ret);
    }
    const stats = {}; for (const k of Object.keys(by)) stats[k] = fwdStats(by[k]);
    return { h, all: fwdStats(all), states: stats, edgeBullVsBear: r2((mean(by.BULLISH) ?? NaN) - (mean(by.BEARISH) ?? NaN)), z: welchZ(by.BULLISH, by.BEARISH, h),
        // "noise filter" claim: does the NOISY state precede smaller/less directional moves?
        noisyVsTrend: { noisyAbs: stats.NOISY.meanAbsPct, trendAbs: r2(mean([...by.BULLISH, ...by.BEARISH].map(Math.abs))) } };
}

function runRenkoStudy(raw, opt = {}) {
    const candles = raw.map(c => ({ date: c.date, open: num(c.open), high: num(c.high), low: num(c.low), close: num(c.close) }))
        .filter(c => [c.open, c.high, c.low, c.close].every(Number.isFinite));
    const atr = atrSeries(candles);
    const variants = opt.variants || [
        { name: '0.4% brick', fn: (t, base) => base * 0.004 },
        { name: '0.6% brick', fn: (t, base) => base * 0.006 },
        { name: '1.0% brick', fn: (t, base) => base * 0.010 },
        { name: '1x ATR(14) brick', fn: (t) => atr[t] },
    ];
    const horizons = opt.horizons || [1, 3, 5];
    const out = { candles: candles.length, variants: [] };
    for (const v of variants) {
        const states = renkoStates(candles, v.fn);
        const live = states.filter(s => s !== 'INSUFFICIENT').length;
        out.variants.push({ name: v.name, daysWithState: live, results: horizons.map(h => evaluateVariant(candles, states, h)) });
    }
    const sig = out.variants.flatMap(v => v.results.map(r => ({ v: v.name, h: r.h, z: r.z, n: Math.min(r.states.BULLISH.n, r.states.BEARISH.n) })));
    const minN = opt.minN || 40;
    const usable = sig.filter(s => s.z !== null && s.n >= minN);
    const strong = usable.filter(s => Math.abs(s.z) >= 2.0);
    out.verdict = !usable.length ? `NOT ENOUGH DATA (need ${minN}+ BULLISH and BEARISH days)`
        : strong.length === 0 ? `NO EDGE: Renko BULLISH vs BEARISH state does not separate next-day/3-day/5-day returns (best |z| = ${Math.max(...usable.map(s => Math.abs(s.z)))}; ${usable.length} variant/horizon tests, none |z| ≥ 2)`
            : `SOME SEPARATION in ${strong.length} of ${usable.length} tests (${strong.map(s => `${s.v} h${s.h} z=${s.z}`).join('; ')}) — with ${usable.length} tests expect ~${Math.round(usable.length * 0.05 * 10) / 10} false positives by luck; confirm before trusting`;
    return out;
}

function formatRenkoText(r) {
    const L = ['RENKO STUDY (daily NIFTY candles, research only)', `${r.candles} candles. State = app's own 7-brick read (BULLISH/BEARISH/NOISY/MIXED), using data up to that day only.`,
        'mean% = average next-h-day return after that state; up% = share of up days; z = BULLISH vs BEARISH mean difference (overlap-corrected).', ''];
    for (const v of r.variants) {
        L.push(`■ ${v.name} (${v.daysWithState} days with a state)`);
        for (const x of v.results) {
            const f = k => { const s = x.states[k]; return `${k} n${s.n} mean ${s.meanPct}% up ${s.upPct}%`; };
            L.push(`  h=${x.h}d  baseline mean ${x.all.meanPct}% up ${x.all.upPct}% | ${f('BULLISH')} | ${f('BEARISH')} | ${f('NOISY')} | z=${x.z}`);
            L.push(`        avg |move| after NOISY ${x.noisyVsTrend.noisyAbs}% vs after a clear trend ${x.noisyVsTrend.trendAbs}%`);
        }
    }
    L.push('', `VERDICT: ${r.verdict}`, 'Limit: daily bars test the idea, not the app\'s 1-minute implementation — see /api/renko-journal-study once Auto Journal has logged alerts with their Renko state.');
    return L.join('\n');
}

// ── Part 2: Auto Journal rows (closed NIFTY paper trades) carrying ctx.renko ──
function summarizeByRenko(rows, opt = {}) {
    const closed = rows.filter(r => r.realized_pct !== null && r.realized_pct !== undefined && r.ctx && r.ctx.renko);
    const stat = a => ({ n: a.length, winPct: a.length ? Math.round(1000 * a.filter(x => x > 0).length / a.length) / 10 : null, avgPct: r2(mean(a)), medianPct: r2(median(a)) });
    const pct = r => Number(r.realized_pct);
    const aligned = closed.filter(r => r.ctx.renko.aligned === true).map(pct), blocked = closed.filter(r => r.ctx.renko.aligned === false).map(pct);
    const byTrend = {}; for (const r of closed) (byTrend[r.ctx.renko.trend || 'UNKNOWN'] ||= []).push(pct(r));
    const bySource = {};
    for (const r of closed) { const k = r.source || '?'; const g = (bySource[k] ||= { aligned: [], blocked: [] }); (r.ctx.renko.aligned ? g.aligned : g.blocked).push(pct(r)); }
    const out = { closedWithRenko: closed.length, passedGate: stat(aligned), failedGate: stat(blocked), byTrend: Object.fromEntries(Object.entries(byTrend).map(([k, v]) => [k, stat(v)])),
        bySource: Object.fromEntries(Object.entries(bySource).map(([k, g]) => [k, { passed: stat(g.aligned), failed: stat(g.blocked) }])), z: welchZ(aligned, blocked, 1) };
    const minN = opt.minN || 30;
    out.verdict = aligned.length < minN || blocked.length < minN ? `NOT ENOUGH DATA YET (need ${minN}+ closed trades in BOTH groups; have ${aligned.length} passed / ${blocked.length} failed)`
        : out.z >= 1.64 ? 'Renko-PASS trades did better than Renko-FAIL trades (p<0.05, one-sided) — the gate is adding value'
            : out.z <= -1.64 ? 'Renko-PASS trades did WORSE — the gate is hurting; consider removing it'
                : 'NO CLEAR DIFFERENCE between passed and failed — the gate is not proven; do not tighten it, consider loosening';
    return out;
}

function formatJournalText(s) {
    const l = (n, x) => `${n}: n ${x.n} · win ${x.winPct}% · avg ${x.avgPct}% · median ${x.medianPct}%`;
    const L = ['RENKO vs AUTO JOURNAL (closed NIFTY paper trades, Renko state recorded at fire time)', `${s.closedWithRenko} closed trades with a Renko record`, l('PASSED gate (aligned)', s.passedGate), l('FAILED gate         ', s.failedGate), `z (passed vs failed avg): ${s.z}`, ''];
    for (const [k, v] of Object.entries(s.byTrend)) L.push('  ' + l('Renko ' + k, v));
    L.push('', 'By strategy:'); for (const [k, g] of Object.entries(s.bySource)) L.push(`  ${k}: passed n${g.passed.n} avg ${g.passed.avgPct}% | failed n${g.failed.n} avg ${g.failed.avgPct}%`);
    L.push('', `VERDICT: ${s.verdict}`); return L.join('\n');
}

module.exports = { atrSeries, renkoStates, runRenkoStudy, formatRenkoText, summarizeByRenko, formatJournalText, welchZ };