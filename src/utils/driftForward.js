'use strict';
// ── Forward test #3: Sustained Drift + trailing exit (pre-registered 27 Nov 2026) ───────────────────────────────────────────
// WHY: forward test #1 (scalp, all triggers) FAILED. The 60-day studies showed only two small leads: the Sustained Drift trigger
// (HOLD +Rs 161/trade, n=159, the only trigger positive after costs) and a trailing exit (BOOK20_TRAIL12) that beat the live grid in
// BOTH halves. Both were found by looking at ~12 triggers x ~9 exits, so they may be luck. This tests exactly that ONE combination on
// signals fired AFTER the rule was written down. RECORD-ONLY: it replays premium paths the app already stores; it places no order,
// and changes no signal, gate, alert or display. PURE (no I/O) — the endpoint in server.js does the database read.
// Do not change the rule or the pass conditions after looking at results.
const { simulateRule, decluster } = require('./exitRuleStudy');

const IST = 330 * 60000;
const istDay = ts => new Date(ts + IST).toISOString().slice(0, 10);
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const median = a => { if (!a.length) return null; const x = [...a].sort((p, q) => p - q), m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
const r2 = v => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
const pf = list => { const w = list.filter(x => x > 0).reduce((s, x) => s + x, 0), l = -list.filter(x => x < 0).reduce((s, x) => s + x, 0); return l > 0 ? r2(w / l) : null; };

const SOURCE = 'Sustained Drift';
// exit rule (percent of entry premium): hard stop -15%; book half at +20% and lock breakeven; trail the rest 12 points below its peak; else out at the end of the stored path (~90 min)
const RULE = { name: 'Sustained Drift + BOOK20_TRAIL12 (SL -15%)', source: SOURCE, exit: { slPct: -15, halfAt: 20, beAt: 20, fullAt: null, trailGap: 12 },
    slipPts: 0.5, chargePct: 0.07, brokerage: 0, qty: 65, declusterMin: 30, minPremium: 10 };
const CRITERIA = { minTrades: 150, minDays: 30, minProfitFactor: 1.2, maxBestTradeSharePct: 15 };

function rupees(entry, exitPx, o) {
    const gross = (exitPx - entry) * o.qty, slip = 2 * o.slipPts * o.qty, charges = o.qty * (entry + exitPx) * (o.chargePct / 100) + o.brokerage;
    return { gross, cost: slip + charges, net: gross - slip - charges };
}

// outcomes: [{ id, source, fireTs(ms), entryPremium, path:[{ts(ms), premium}] }]; opts: { startTs (ms), rule?, criteria? }
function evaluate(outcomes, opts = {}) {
    const rule = { ...RULE, ...(opts.rule || {}) }, crit = { ...CRITERIA, ...(opts.criteria || {}) };
    const startTs = Number.isFinite(opts.startTs) ? opts.startTs : 0;
    const all = Array.isArray(outcomes) ? outcomes : [];
    const usable = all.filter(x => x && x.source === rule.source && x.fireTs >= startTs && x.entryPremium >= rule.minPremium && Array.isArray(x.path) && x.path.length >= 3 && Number.isFinite(x.fireTs))
        .map(x => ({ ...x, path: [...x.path].sort((a, b) => a.ts - b.ts) }));
    const used = decluster(usable, rule.declusterMin);
    const rows = [];
    for (const t of used) {
        const s = simulateRule(t.entryPremium, t.path, t.fireTs, rule.exit);
        if (!s) continue;
        const exitPx = t.entryPremium * (1 + s.result / 100);
        rows.push({ fireTs: t.fireTs, day: istDay(t.fireTs), pct: s.result, reason: s.reason, ...rupees(t.entryPremium, exitPx, rule) });
    }
    rows.sort((a, b) => a.fireTs - b.fireTs);
    const nets = rows.map(r => r.net), n = rows.length, days = new Set(rows.map(r => r.day)).size;
    const total = nets.reduce((s, x) => s + x, 0), avg = n ? total / n : null;
    const half = Math.floor(n / 2), oAvg = half ? mean(nets.slice(0, half)) : null, nAvg = n - half ? mean(nets.slice(half)) : null;
    const best = n ? Math.max(...nets) : null, worst = n ? Math.min(...nets) : null;
    const bestShare = total > 0 && best > 0 ? 100 * best / total : null;
    const dm = new Map();
    for (const r of rows) { const d = dm.get(r.day) || { day: r.day, n: 0, netRs: 0 }; d.n++; d.netRs += r.net; dm.set(r.day, d); }
    const daily = [...dm.values()].map(d => ({ day: d.day, n: d.n, netRs: r2(d.netRs) }));
    const profitFactor = pf(nets);
    const checks = [
        { name: 'enough trades', need: `>= ${crit.minTrades}`, have: n, ok: n >= crit.minTrades },
        { name: 'enough trading days', need: `>= ${crit.minDays}`, have: days, ok: days >= crit.minDays },
        { name: 'net average after costs', need: '> 0', have: r2(avg), ok: avg !== null && avg > 0 },
        { name: 'older half AND newer half', need: 'both > 0', have: `${r2(oAvg)} / ${r2(nAvg)}`, ok: oAvg !== null && nAvg !== null && oAvg > 0 && nAvg > 0 },
        { name: 'profit factor', need: `>= ${crit.minProfitFactor}`, have: profitFactor, ok: profitFactor === null ? total > 0 : profitFactor >= crit.minProfitFactor },
        { name: 'best single trade share of total profit (not one lucky trade)', need: `<= ${crit.maxBestTradeSharePct}%`, have: bestShare === null ? '-' : r2(bestShare) + '%', ok: total > 0 && bestShare !== null && bestShare <= crit.maxBestTradeSharePct },
    ];
    const enough = checks[0].ok && checks[1].ok, failed = checks.filter(c => !c.ok).map(c => c.name);
    return {
        rule, criteria: crit, startTs: startTs || null, trades: n, days, netAvgRs: r2(avg), netTotalRs: r2(total), medianNetRs: r2(median(nets)),
        worstNetRs: r2(worst), bestNetRs: r2(best), profitFactor, winPct: n ? Math.round(1000 * nets.filter(x => x > 0).length / n) / 10 : null,
        older: { n: half, netAvgRs: r2(oAvg) }, newer: { n: n - half, netAvgRs: r2(nAvg) }, daily, checks,
        status: !enough ? 'COLLECTING' : (failed.length ? 'FAIL' : 'PASS'),
        reasons: !enough ? [`need ${crit.minTrades} trades over ${crit.minDays} trading days (have ${n} / ${days})`] : failed,
    };
}

function formatText(res, meta = {}) {
    const f = v => v === null || v === undefined ? '-' : (v > 0 ? '+' : '') + v, r = res.rule, L = [];
    L.push(`FORWARD TEST #3  NIFTY  ${r.source} only  (signals fired on or after ${meta.start || '?'} only)`);
    L.push(`RULE (fixed in advance): ${r.name}. Stop ${r.exit.slPct}% of premium; book half at +${r.exit.halfAt}% and lock breakeven; trail the rest ${r.exit.trailGap} points below its peak; else out when the stored path ends (~90 min).`);
    L.push(`Costs: ${r.slipPts} pt slippage each side + ${r.chargePct}% charges each side + Rs ${r.brokerage} brokerage, qty ${r.qty} (1 lot). Signals declustered ${r.declusterMin} min.`);
    L.push(`STATUS: ${res.status}${res.status === 'COLLECTING' ? '  (interim numbers below mean nothing yet)' : ''}`);
    res.reasons.forEach(x => L.push(`  - ${x}`));
    L.push('');
    L.push(`Trades ${res.trades} over ${res.days} day(s). Net avg ${f(res.netAvgRs)} Rs, total ${f(res.netTotalRs)} Rs, median ${f(res.medianNetRs)}, win ${res.winPct ?? '-'}%, PF ${res.profitFactor ?? '-'}, worst ${f(res.worstNetRs)}, best ${f(res.bestNetRs)}.`);
    L.push(`Older half ${f(res.older.netAvgRs)} (n=${res.older.n})  |  newer half ${f(res.newer.netAvgRs)} (n=${res.newer.n})`);
    L.push('');
    L.push('PASS CONDITIONS (all must hold once enough trades are in):');
    res.checks.forEach(c => L.push(`  [${c.ok ? 'x' : ' '}] ${c.name}: need ${c.need}, have ${c.have === null || c.have === undefined || c.have === 'null / null' ? '-' : c.have}`));
    if (res.daily.length) { L.push(''); L.push('DAY BY DAY (trades, net Rs):'); res.daily.forEach(d => L.push(`  ${d.day}  n=${String(d.n).padStart(3)}  ${f(d.netRs)}`)); }
    L.push('');
    L.push('A pass is NOT proof and is NOT permission to trade this live — paper-trade it next. A fail means the earlier lead was probably luck. Do not change the rule after looking.');
    return L.join('\n');
}

module.exports = { evaluate, formatText, RULE, CRITERIA, SOURCE };
