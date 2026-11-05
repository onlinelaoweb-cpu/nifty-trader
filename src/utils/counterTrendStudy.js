'use strict';
// ── Counter-trend study (6 Nov 2026) ─────────────────────────────────────────────────────────────────────────────────────
// QUESTION: on 5 Nov (a +2.4% trend-up day) all five PE alerts hit their stop (-Rs15,600) while the CE alerts made +Rs9,351. Murarka's
// PCR rule can fire a PE on PCR alone even when the day is clearly bullish. Is "alert AGAINST the live trend" a losing bucket over the
// whole record, and what would the record look like if those alerts had been skipped?
// HOW: for each NIFTY trade (Trade-Coach result, before brokerage) the last 5-min snapshot before the alert gives three trend signs,
// all known AT THE TIME (no look-ahead):
//   1. price vs VWAP (dead zone +-0.15%)
//   2. move since the day's first snapshot (dead zone +-0.35%)
//   3. the MTF signal stored in the snapshot (BUY CALL = up, BUY PUT = down, WAIT = no vote)
// trendScore = sum of the three signs (-3..+3). A trade is judged by side x trendScore: +2/+3 = WITH trend, -2/-3 = AGAINST trend.
// Then it replays the record with the AGAINST (-2/-3) trades removed. Needs at least two usable signs per trade.
// HONEST LIMITS: only trades after the snapshot logging began; small buckets (look at n and both halves); the day-move sign is measured
// from the first snapshot, so a gap is not counted; results are before brokerage/slippage; a filter that wins on a short, mostly
// trending sample can lose on a choppy one. Research only — nothing here feeds signals, gates or alerts. PURE.

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const r2 = v => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
const r1 = v => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
const istDay = ts => new Date(ts + 330 * 60000).toISOString().slice(0, 10);

function sideOf(direction) {
    const d = String(direction || '').toUpperCase();
    if (/CALL|BULL|\bCE\b|LONG|BUY_CALL/.test(d)) return 1;
    if (/PUT|BEAR|\bPE\b|SHORT|BUY_PUT/.test(d)) return -1;
    return null;
}

function snapshotAtOrBefore(snaps, ms, tolMs) {
    let lo = 0, hi = snaps.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (snaps[mid].ms <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans >= 0 && ms - snaps[ans].ms <= tolMs ? ans : -1;
}

const VWAP_DEAD = 0.15, DAY_DEAD = 0.35;

// the three trend signs at one moment. dayOpen = first snapshot nifty of that IST day. Returns { score, votes } or null (< 2 usable signs)
function trendAt(spot, snap, dayOpen) {
    const signs = [];
    if (snap && snap.vwap > 0 && spot > 0) { const d = ((spot - snap.vwap) / snap.vwap) * 100; signs.push(d > VWAP_DEAD ? 1 : d < -VWAP_DEAD ? -1 : 0); }
    if (dayOpen > 0 && spot > 0) { const m = ((spot - dayOpen) / dayOpen) * 100; signs.push(m >= DAY_DEAD ? 1 : m <= -DAY_DEAD ? -1 : 0); }
    if (snap && snap.mtfSignal) { const s = sideOf(snap.mtfSignal); if (s !== null) signs.push(s); else if (/WAIT|NEUTRAL|MIXED/i.test(String(snap.mtfSignal))) signs.push(0); }
    if (signs.length < 2) return null;
    return { score: signs.reduce((a, b) => a + b, 0), votes: signs.length };
}

const REL_BUCKETS = [
    { label: 'AGAINST trend (score -2/-3 vs the trade)', test: k => k <= -2 },
    { label: 'slightly against (-1)', test: k => k === -1 },
    { label: 'neutral (0)', test: k => k === 0 },
    { label: 'slightly with (+1)', test: k => k === 1 },
    { label: 'WITH trend (score +2/+3)', test: k => k >= 2 },
];

function stats(list, overallAvg, halfCut) {
    const n = list.length;
    const old = list.filter(r => r.fireTs < halfCut), nw = list.filter(r => r.fireTs >= halfCut);
    const avg = mean(list.map(r => r.result));
    const rel = (arr) => arr.length ? mean(arr.map(r => r.result)) - overallAvg : null;
    return {
        n, days: new Set(list.map(r => r.day)).size,
        avgPct: r2(avg), sumPct: r1(list.reduce((s, r) => s + r.result, 0)), winPct: n ? r1(100 * list.filter(r => r.result > 0).length / n) : null,
        olderHalfVsOverall: rel(old) === null ? null : r2(rel(old)), newerHalfVsOverall: rel(nw) === null ? null : r2(rel(nw)),
    };
}

// trades: [{ id, source, direction, fireTs, entryPrice(spot at fire), entryPremium, path:[{ts,premium}] }]
// snaps : [{ ms, nifty, vwap, mtfSignal }]
// simulate(entryPremium, path) -> { coachResult } | null      opts: { tolMin=7, declusterMin=30, minN=15, decluster(items, minutes) }
function computeCounterTrendStudy(trades, snaps, simulate, opts = {}) {
    const tolMs = (opts.tolMin ?? 7) * 60000, minN = opts.minN ?? 15;
    const S = (snaps || []).filter(s => s && Number.isFinite(s.ms)).sort((a, b) => a.ms - b.ms);
    const firstOfDay = new Map();
    for (const s of S) { const d = istDay(s.ms); if (!firstOfDay.has(d) && s.nifty > 0) firstOfDay.set(d, s.nifty); }
    const usable = (trades || []).filter(t => t && t.entryPremium > 0 && t.entryPrice > 0 && Array.isArray(t.path) && t.path.length >= 3 && Number.isFinite(t.fireTs) && sideOf(t.direction) !== null);
    const used = typeof opts.decluster === 'function' ? opts.decluster(usable, opts.declusterMin ?? 30) : usable;

    const rows = [];
    let noSnapshot = 0, tooFewSigns = 0;
    for (const t of used) {
        const sim = simulate(t.entryPremium, [...t.path].sort((a, b) => a.ts - b.ts));
        if (!sim) continue;
        const side = sideOf(t.direction);
        const i = snapshotAtOrBefore(S, t.fireTs, tolMs);
        if (i < 0) { noSnapshot++; continue; }
        const day = istDay(t.fireTs), tr = trendAt(t.entryPrice, S[i], firstOfDay.get(day));
        if (!tr) { tooFewSigns++; continue; }
        rows.push({ id: t.id, source: t.source || '?', side, fireTs: t.fireTs, day, result: sim.coachResult, trendScore: tr.score, rel: tr.score * side });
    }
    rows.sort((a, b) => a.fireTs - b.fireTs);

    const half = Math.floor(rows.length / 2), halfCut = rows.length ? rows[half]?.fireTs ?? Infinity : Infinity;
    const overallAvg = mean(rows.map(r => r.result)) ?? 0;
    const mk = (label, list) => ({ label, ...stats(list, overallAvg, halfCut) });
    const verdictFor = b => {
        if (b.n < minN) return 'thin';
        if (b.olderHalfVsOverall === null || b.newerHalfVsOverall === null) return 'one half only';
        return b.olderHalfVsOverall > 0 && b.newerHalfVsOverall > 0 ? 'ABOVE average in both halves' : b.olderHalfVsOverall < 0 && b.newerHalfVsOverall < 0 ? 'below average in both halves' : 'mixed';
    };

    const byRelation = REL_BUCKETS.map(b => mk(b.label, rows.filter(r => b.test(r.rel))));
    const trendName = k => k >= 2 ? 'UP day-trend' : k <= -2 ? 'DOWN day-trend' : 'no clear trend';
    const byDirection = [];
    for (const [sd, nm] of [[1, 'CALL'], [-1, 'PUT']]) for (const tn of ['UP day-trend', 'no clear trend', 'DOWN day-trend']) byDirection.push(mk(`${nm} in ${tn}`, rows.filter(r => r.side === sd && trendName(r.trendScore) === tn)));
    const sources = [...new Set(rows.map(r => r.source))].sort();
    const bySource = sources.map(sc => {
        const list = rows.filter(r => r.source === sc);
        return { source: sc, all: mk('all', list), against: mk('AGAINST trend', list.filter(r => r.rel <= -2)), withTrend: mk('not against', list.filter(r => r.rel > -2)) };
    });
    for (const b of [...byRelation, ...byDirection]) b.verdict = verdictFor(b);

    const kept = rows.filter(r => r.rel > -2), dropped = rows.filter(r => r.rel <= -2);
    const sum = a => a.reduce((s, r) => s + r.result, 0);
    const replay = {
        before: { n: rows.length, avgPct: r2(overallAvg), sumPct: r1(sum(rows)), winPct: rows.length ? r1(100 * rows.filter(r => r.result > 0).length / rows.length) : null },
        after: { n: kept.length, avgPct: r2(mean(kept.map(r => r.result))), sumPct: r1(sum(kept)), winPct: kept.length ? r1(100 * kept.filter(r => r.result > 0).length / kept.length) : null },
        skipped: { n: dropped.length, avgPct: r2(mean(dropped.map(r => r.result))), sumPct: r1(sum(dropped)) },
        // does the skip help in BOTH halves? (sum of the skipped trades' result in each half; negative = skipping them would have helped)
        skippedOlderHalfSumPct: r1(sum(dropped.filter(r => r.fireTs < halfCut))), skippedNewerHalfSumPct: r1(sum(dropped.filter(r => r.fireTs >= halfCut))),
    };
    replay.verdict = dropped.length < minN ? 'thin — too few skipped trades to judge'
        : replay.skippedOlderHalfSumPct < 0 && replay.skippedNewerHalfSumPct < 0 ? 'skipping them would have helped in BOTH halves'
        : replay.skippedOlderHalfSumPct > 0 && replay.skippedNewerHalfSumPct > 0 ? 'skipping them would have HURT in both halves'
        : 'mixed — no consistent edge yet';

    return {
        tradesUsed: rows.length, tradesConsidered: used.length, skippedNoSnapshot: noSnapshot, skippedTooFewSigns: tooFewSigns,
        overall: { avgPct: r2(overallAvg), winPct: rows.length ? r1(100 * rows.filter(r => r.result > 0).length / rows.length) : null },
        byRelation, byDirection, bySource, replay,
        note: 'Trend signs come from the last 5-min snapshot before the alert (up to ~7 min old): price vs VWAP, move since the first snapshot of the day, and the stored MTF signal. A bucket counts only if n >= minN and it is on the same side of the overall average in BOTH halves. Results are Trade-Coach % of premium before brokerage. Research only — not a gate.',
    };
}

function formatCounterTrendText(res) {
    const f = v => v === null || v === undefined ? '-' : (v > 0 ? '+' : '') + v;
    const L = [];
    L.push('COUNTER-TREND STUDY — do alerts fired AGAINST the live trend lose, and what if they were skipped?');
    L.push(`Trades used: ${res.tradesUsed} of ${res.tradesConsidered} (no snapshot before the alert: ${res.skippedNoSnapshot}, fewer than 2 trend signs: ${res.skippedTooFewSigns}).  Overall avg ${f(res.overall.avgPct)}%  win ${res.overall.winPct ?? '-'}%`);
    const block = (title, list) => {
        L.push(''); L.push(title);
        for (const b of list) L.push(`  ${b.label.padEnd(44)} n=${String(b.n).padStart(3)} (${b.days}d)  avg ${String(f(b.avgPct)).padStart(6)}%  sum ${String(f(b.sumPct)).padStart(7)}%  win ${String(b.winPct ?? '-').padStart(5)}%  ${b.verdict || ''}`);
    };
    block('BY TREND RELATION (trend score x trade side)', res.byRelation);
    block('BY DIRECTION x DAY-TREND', res.byDirection);
    L.push(''); L.push('BY STRATEGY (against trend vs not)');
    for (const s of res.bySource) L.push(`  ${s.source.padEnd(18)} against: n=${s.against.n} avg ${f(s.against.avgPct)}% win ${s.against.winPct ?? '-'}%   |   not against: n=${s.withTrend.n} avg ${f(s.withTrend.avgPct)}% win ${s.withTrend.winPct ?? '-'}%`);
    const r = res.replay;
    L.push(''); L.push('REPLAY — skip every AGAINST-trend alert');
    L.push(`  before: n=${r.before.n} avg ${f(r.before.avgPct)}% sum ${f(r.before.sumPct)}% win ${r.before.winPct ?? '-'}%`);
    L.push(`  after : n=${r.after.n} avg ${f(r.after.avgPct)}% sum ${f(r.after.sumPct)}% win ${r.after.winPct ?? '-'}%`);
    L.push(`  skipped: n=${r.skipped.n} avg ${f(r.skipped.avgPct)}% sum ${f(r.skipped.sumPct)}%  (older half ${f(r.skippedOlderHalfSumPct)}%, newer half ${f(r.skippedNewerHalfSumPct)}%)`);
    L.push(`  verdict: ${r.verdict}`);
    L.push(''); L.push(res.note);
    return L.join('\n');
}

module.exports = { sideOf, snapshotAtOrBefore, trendAt, computeCounterTrendStudy, formatCounterTrendText };