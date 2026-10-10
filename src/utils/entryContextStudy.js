'use strict';
// ── Entry-context study (10 Oct 2026) ───────────────────────────────────────────────────────────────
// QUESTION: Nitin Murarka's rule is "enter on the REACTION (pullback to VWAP / 38-62% Fibonacci retracement), not on the ACTION
// (chasing a move that already ran)". The app already scores this ("Law 3") but never stored it, so it was never checked against
// results. market_snapshot_log now records VWAP and the latest impulse leg every 5 minutes. For every trigger outcome this study
// finds the last snapshot before the signal fired, works out where the signal's spot price sat relative to VWAP and to the
// impulse leg, and compares the Trade-Coach result of the buckets (does entering near VWAP / in the 38-62% zone really do better?).
// HONEST LIMITS: snapshots are 5 minutes apart (VWAP/impulse can be up to ~5 min stale); only trades fired after the logging started
// can be used; buckets are small at first; a bucket only counts as consistent if it beats the overall average in BOTH halves.
// Research only — nothing here feeds signals, gates or alerts. PURE.

const OF = require('./orderflowContext');

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = v => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;

function sideOf(direction) {
    const d = String(direction || '').toUpperCase();
    if (/CALL|BULL|\bCE\b|LONG|BUY_CALL/.test(d)) return 1;
    if (/PUT|BEAR|\bPE\b|SHORT|BUY_PUT/.test(d)) return -1;
    return null;
}

// last snapshot at or before ms, no older than tolMs. snaps sorted ascending by ms.
function snapshotAtOrBefore(snaps, ms, tolMs) {
    let lo = 0, hi = snaps.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (snaps[mid].ms <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans >= 0 && ms - snaps[ans].ms <= tolMs ? ans : -1;
}

const VWAP_BUCKETS = [
    { label: 'wrong side of VWAP (> 0.15% against the trade)', test: a => a < -0.15 },
    { label: 'AT VWAP (within 0.15%)', test: a => a >= -0.15 && a <= 0.15 },
    { label: 'slightly extended (0.15-0.35% with the trade)', test: a => a > 0.15 && a <= 0.35 },
    { label: 'EXTENDED / chasing (> 0.35% with the trade)', test: a => a > 0.35 },
];
const FIB_BUCKETS = [
    { label: 'shallow pullback (< 23.6%)', test: r => r < 23.6 },
    { label: '23.6-38.2%', test: r => r >= 23.6 && r < 38.2 },
    { label: 'REACTION ZONE 38.2-61.8%', test: r => r >= 38.2 && r <= 61.8 },
    { label: '61.8-78.6%', test: r => r > 61.8 && r <= 78.6 },
    { label: 'deep (> 78.6%, trend-change risk)', test: r => r > 78.6 },
];

function bucketStats(items, overall, halfCut) {
    const results = items.map(i => i.result), peaks = items.map(i => i.peak);
    const old = items.filter(i => i.fireTs < halfCut).map(i => i.result), nw = items.filter(i => i.fireTs >= halfCut).map(i => i.result);
    return {
        n: items.length, days: new Set(items.map(i => i.day)).size,
        avgPct: r2(mean(results)), medianPct: r2(median(results)),
        winPct: items.length ? Math.round(1000 * results.filter(v => v > 0).length / items.length) / 10 : null,
        reach10Pct: items.length ? Math.round(1000 * peaks.filter(v => v >= 10).length / items.length) / 10 : null,
        vsOverall: items.length ? r2(mean(results) - overall.avg) : null,
        olderHalfVsOverall: old.length ? r2(mean(old) - overall.olderAvg) : null,
        newerHalfVsOverall: nw.length ? r2(mean(nw) - overall.newerAvg) : null,
    };
}

// trades: [{ id, source, direction, fireTs, entryPrice(spot at fire), entryPremium, path:[{ts,premium}] }]
// snaps : [{ ms, vwap, fibDir('UP'|'DOWN'|null), fibL0, fibL100, zone }]
// simulate(entryPremium, path) -> { coachResult } | null      opts: { tolMin=7, declusterMin=30, minN=15, decluster(items, minutes) }
function computeEntryContextStudy(trades, snaps, simulate, opts = {}) {
    const tolMs = (opts.tolMin ?? 7) * 60000, minN = opts.minN ?? 15;
    const S = (snaps || []).filter(s => s && Number.isFinite(s.ms)).sort((a, b) => a.ms - b.ms);
    const usable = (trades || []).filter(t => t && t.entryPremium > 0 && t.entryPrice > 0 && Array.isArray(t.path) && t.path.length >= 3 && Number.isFinite(t.fireTs) && sideOf(t.direction) !== null);
    const used = typeof opts.decluster === 'function' ? opts.decluster(usable, opts.declusterMin ?? 30) : usable;

    const A = OF.annotateBars(S);                       // same indices as S: adds barVol / delta from futures volume steps
    const rows = [];
    let noSnapshot = 0, noVwap = 0;
    for (const t of used) {
        const sim = simulate(t.entryPremium, [...t.path].sort((a, b) => a.ts - b.ts));
        if (!sim) continue;
        const side = sideOf(t.direction);
        const i = snapshotAtOrBefore(S, t.fireTs, tolMs);
        if (i < 0) { noSnapshot++; continue; }
        const s = S[i];
        if (!(s.vwap > 0)) { noVwap++; continue; }
        const dist = ((t.entryPrice - s.vwap) / s.vwap) * 100, aligned = dist * side;
        let retrace = null, fibState;
        if (!s.fibDir || !Number.isFinite(s.fibL0) || !Number.isFinite(s.fibL100) || s.fibL0 === s.fibL100) fibState = 'no impulse leg';
        else if ((s.fibDir === 'UP' ? 1 : -1) !== side) fibState = 'impulse AGAINST the trade';
        else { retrace = ((t.entryPrice - s.fibL0) / (s.fibL100 - s.fibL0)) * 100; fibState = 'aligned'; }
        const peak = Math.max(...t.path.map(p => ((p.premium - t.entryPremium) / t.entryPremium) * 100));
        const day = new Date(t.fireTs + 330 * 60000).toISOString().slice(0, 10);
        const avgRange = OF.priorAvgRange(S, day), spanNow = s.dayHigh > 0 && s.dayLow > 0 ? s.dayHigh - s.dayLow : null;
        rows.push({ id: t.id, source: t.source || '?', fireTs: t.fireTs, day, result: sim.coachResult, peak, alignedVwapPct: aligned, retrace, fibState, zone: s.zone || null,
            sweepB: s.sweep !== undefined ? OF.sweepBucket(s.sweep, side) : null,
            vaB: OF.valueAreaBucket(t.entryPrice, s, side),
            rangeB: avgRange && spanNow !== null ? OF.rangeUsedBucket((spanNow / avgRange) * 100) : null,
            flowB: OF.classifyFlow(A, i, side), absB: OF.classifyAbsorption(A, i, side),
            gammaB: OF.gammaFlipBucket(t.entryPrice, s.gammaFlip), pinB: OF.maxGammaBucket(t.entryPrice, s.maxGamma) });
    }
    rows.sort((a, b) => a.fireTs - b.fireTs);

    const half = Math.floor(rows.length / 2), halfCut = rows.length ? rows[half]?.fireTs ?? Infinity : Infinity;
    const oldRows = rows.filter(r => r.fireTs < halfCut), newRows = rows.filter(r => r.fireTs >= halfCut);
    const overall = { avg: mean(rows.map(r => r.result)) ?? 0, olderAvg: mean(oldRows.map(r => r.result)) ?? 0, newerAvg: mean(newRows.map(r => r.result)) ?? 0 };

    const mk = (label, list) => ({ label, ...bucketStats(list, overall, halfCut) });
    const byVwap = VWAP_BUCKETS.map(b => mk(b.label, rows.filter(r => b.test(r.alignedVwapPct))));
    const fibAligned = rows.filter(r => r.fibState === 'aligned');
    const byFib = [...FIB_BUCKETS.map(b => mk(b.label, fibAligned.filter(r => b.test(r.retrace)))),
        mk('impulse AGAINST the trade', rows.filter(r => r.fibState === 'impulse AGAINST the trade')), mk('no impulse leg', rows.filter(r => r.fibState === 'no impulse leg'))];
    const zones = [...new Set(rows.map(r => r.zone || 'unknown'))].sort();
    const byZone = zones.map(z => mk(z, rows.filter(r => (r.zone || 'unknown') === z)));
    // the Murarka combination: at VWAP OR inside the 38.2-61.8 zone, versus everything else
    const isReaction = r => (r.alignedVwapPct >= -0.15 && r.alignedVwapPct <= 0.15) || (r.retrace !== null && r.retrace >= 38.2 && r.retrace <= 61.8);
    const reactionVsAction = [mk('REACTION entry (at VWAP or 38.2-61.8% retrace)', rows.filter(isReaction)), mk('everything else', rows.filter(r => !isReaction(r)))];

    // dynamic buckets for the order-flow / level slices (only labels that actually occur; rows with no data for a slice are left out of it)
    const dyn = (key, order) => {
        const labels = [...new Set(rows.map(r => r[key]).filter(Boolean))];
        labels.sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)) || (a < b ? -1 : 1));
        return labels.map(l => mk(l, rows.filter(r => r[key] === l)));
    };
    const bySweep = dyn('sweepB', ['prev-day level SWEPT & reclaimed, trade WITH the reversal', 'prev-day level swept, trade AGAINST the reversal', 'no sweep in last 15 min']);
    const byValueArea = dyn('vaB', []);
    const byRangeUsed = dyn('rangeB', ['range used < 50% of usual', 'range used 50-75%', 'range used 75-100%', 'range used > 100% (already stretched)']);
    const byFlow = dyn('flowB', ['CONFIRMED', 'MIXED', 'AGAINST', 'DIVERGENCE']);
    const byAbsorption = dyn('absB', ['ABSORPTION_AT_EXTREME', 'ABSORPTION', 'NONE']);

    const byGammaFlip = dyn('gammaB', ['ABOVE gamma flip (positive-gamma side)', 'AT gamma-flip level (+-0.15%)', 'BELOW gamma flip (negative-gamma side)']);
    const byMaxGamma = dyn('pinB', ['PINNED: within 0.15% of max-gamma strike', 'near max-gamma strike (0.15-0.4%)', 'away from max-gamma strike (> 0.4%)']);

    const verdictFor = b => {
        if (b.n < minN) return 'thin';
        if (b.olderHalfVsOverall === null || b.newerHalfVsOverall === null) return 'one half only';
        return b.olderHalfVsOverall > 0 && b.newerHalfVsOverall > 0 ? 'ABOVE average in both halves' : b.olderHalfVsOverall < 0 && b.newerHalfVsOverall < 0 ? 'below average in both halves' : 'mixed';
    };
    for (const list of [byVwap, byFib, byZone, reactionVsAction, bySweep, byValueArea, byRangeUsed, byFlow, byAbsorption, byGammaFlip, byMaxGamma]) for (const b of list) b.verdict = verdictFor(b);

    return {
        tradesUsed: rows.length, tradesConsidered: used.length, skippedNoSnapshot: noSnapshot, skippedNoVwap: noVwap,
        overall: { avgPct: r2(overall.avg), winPct: rows.length ? Math.round(1000 * rows.filter(r => r.result > 0).length / rows.length) / 10 : null },
        reactionVsAction, byVwap, byFib, byZone, bySweep, byValueArea, byRangeUsed, byFlow, byAbsorption, byGammaFlip, byMaxGamma,
        note: 'VWAP/impulse come from the last 5-min snapshot before the signal (up to ~7 min old). Only signals fired after the context logging started are usable, so n starts small. A bucket counts only if it is above the overall average in BOTH halves with enough trades; several buckets are compared, so one will look good by chance.',
    };
}

function formatEntryContextText(res) {
    const f = v => v === null || v === undefined ? '-' : (v > 0 ? '+' : '') + v;
    const L = [];
    L.push('ENTRY-CONTEXT STUDY — does entering on the REACTION (VWAP / Fibonacci pullback) beat entering on the ACTION?');
    L.push(`Trades used: ${res.tradesUsed} of ${res.tradesConsidered} (no snapshot before the signal: ${res.skippedNoSnapshot}, no VWAP in snapshot: ${res.skippedNoVwap}).  Overall avg ${f(res.overall.avgPct)}%  win ${res.overall.winPct ?? '-'}%`);
    const block = (title, list) => {
        L.push('');
        L.push(title);
        for (const b of list) L.push(`  ${b.label.padEnd(52)} n=${String(b.n).padStart(3)} (${b.days}d)  avg ${String(f(b.avgPct)).padStart(6)}%  win ${String(b.winPct ?? '-').padStart(5)}%  reach+10 ${String(b.reach10Pct ?? '-').padStart(5)}%  vs overall ${String(f(b.vsOverall)).padStart(6)}  halves ${f(b.olderHalfVsOverall)}/${f(b.newerHalfVsOverall)}  ${b.verdict}`);
    };
    block('REACTION vs ACTION', res.reactionVsAction);
    block('BY DISTANCE FROM VWAP (positive = price already moved in the trade direction)', res.byVwap);
    block('BY FIBONACCI RETRACEMENT of the latest impulse leg (only when the leg is in the trade direction)', res.byFib);
    block('BY APP "Law 3" ZONE LABEL (direction-agnostic)', res.byZone);
    if ((res.bySweep || []).length) block('PREVIOUS-DAY HIGH/LOW SWEEP (wick beyond the level, then close back inside)', res.bySweep);
    if ((res.byValueArea || []).length) block('LOCATION vs VALUE AREA (VAH / VAL / POC)', res.byValueArea);
    if ((res.byRangeUsed || []).length) block('DAY RANGE USED so far vs the average range of the previous days', res.byRangeUsed);
    if ((res.byFlow || []).length) block('FUTURES VOLUME-DELTA PROXY over the last 30 min (bar delta = step volume x close position in bar; NOT a footprint)', res.byFlow);
    if ((res.byAbsorption || []).length) block('ABSORPTION (heavy futures volume, small range) in the last 10 min', res.byAbsorption);
    if ((res.byGammaFlip || []).length) block('GAMMA REGIME - spot vs the Option-Greeks gamma-flip level (snapshot value, can be ~5 min old)', res.byGammaFlip);
    if ((res.byMaxGamma || []).length) block('PIN - distance to the max-gamma strike', res.byMaxGamma);
    L.push('');
    L.push(res.note);
    return L.join('\n');
}

module.exports = { sideOf, snapshotAtOrBefore, computeEntryContextStudy, formatEntryContextText };