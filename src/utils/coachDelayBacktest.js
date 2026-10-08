'use strict';
// ── Delayed-entry / confirmation backtest (8 Oct 2026) ─────────────────────────────────────────────
// QUESTION: the MTF Tracker audit showed 12 of 19 recent trades hit the stop having never gained more than ~15%
// (they went straight against the entry). If we WAIT a few minutes after the signal and only enter when the premium
// has already moved our way, do we avoid those trades — and does the money saved outweigh the worse entry price and
// the winners we skip?
// HOW: replays the premium PATHS already stored for each signal outcome (~5-minute samples, up to 90 minutes).
// For every signal it compares, on the SAME trades:
//   BASELINE      : enter at the signal's entry premium, follow the live Trade-Coach grid (what happens today)
//   DELAY d / confirm c : wait d minutes; enter at the first sample at/after that time ONLY if the premium is at least
//                   c% above the signal's entry (c = null -> always enter, i.e. the pure cost of waiting); then follow the
//                   same grid from the NEW entry price over the rest of the path.
// The fair headline number is perSignalAvg = average result per signal FIRED (a skipped signal counts 0) versus the
// baseline's average over the same signals. Also reported: what the skipped signals would have done (so you can see
// whether the filter really skips the bad ones) and the same comparison on the older/newer half of the days.
// HONEST LIMITS: ~5-minute path samples (a real order fills closer to its trigger); a few days of one market regime; 9
// variants are tried, so one or two will look good by luck — only a variant that beats baseline in BOTH halves counts, and
// even then it is a lead to paper-test, not proof. Research only: nothing here feeds signals, gates or alerts. PURE.

const DEFAULT_DELAYS = [5, 10, 15];
const DEFAULT_CONFIRMS = [null, 0, 5];   // percent above the signal's entry premium; null = no filter

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = v => v === null || v === undefined ? null : Math.round(v * 100) / 100;
const stats = a => ({ n: a.length, avg: r2(mean(a)), median: r2(median(a)), profitablePct: a.length ? Math.round(1000 * a.filter(v => v > 0).length / a.length) / 10 : null });

// outcomes: [{ id, source, fireTs(ms), entryPremium, path: [{ ts(ms), premium }] }] ; simulate(entryPremium, [{premium}], grid) -> { coachResult } | null
function declusterOutcomes(outcomes, minutes) {
    if (!minutes || minutes <= 0) return [...outcomes];
    const bySrc = new Map();
    for (const o of outcomes) (bySrc.get(o.source || '') || bySrc.set(o.source || '', []).get(o.source || '')).push(o);
    const kept = [];
    for (const list of bySrc.values()) {
        list.sort((a, b) => a.fireTs - b.fireTs); let last = -Infinity;
        for (const o of list) if (o.fireTs - last >= minutes * 60000) { kept.push(o); last = o.fireTs; }
    }
    return kept.sort((a, b) => a.fireTs - b.fireTs);
}

function runVariant(testable, simulate, grid, delayMin, confirmPct) {
    const rows = [];   // one per testable outcome: { fireTs, base, entered, result }
    for (const o of testable) {
        const base = simulate(o.entryPremium, o.path, grid);
        if (!base) continue;
        const idx = o.path.findIndex(p => p.ts >= o.fireTs + delayMin * 60000);
        if (idx < 0 || idx >= o.path.length - 1) continue;   // no sample at/after the delay, or nothing left to trade afterwards
        const p = o.path[idx].premium;
        if (!(p > 0)) continue;
        const move = (p / o.entryPremium - 1) * 100;
        if (confirmPct !== null && move < confirmPct) { rows.push({ fireTs: o.fireTs, base: base.coachResult, entered: false, result: 0 }); continue; }
        const sim = simulate(p, o.path.slice(idx + 1), grid);
        if (!sim) continue;
        rows.push({ fireTs: o.fireTs, base: base.coachResult, entered: true, result: sim.coachResult });
    }
    return rows;
}

function summarizeRows(rows) {
    const entered = rows.filter(r => r.entered), skipped = rows.filter(r => !r.entered);
    const perSignalAvg = mean(rows.map(r => r.result)), baseAvg = mean(rows.map(r => r.base));
    return {
        signals: rows.length, entered: entered.length, skipped: skipped.length,
        perSignalAvg: r2(perSignalAvg), baselinePerSignalAvg: r2(baseAvg),
        delta: perSignalAvg === null ? null : r2(perSignalAvg - baseAvg),
        enteredTrades: stats(entered.map(r => r.result)),
        baselineOnSameEntered: stats(entered.map(r => r.base)),
        skippedSignalsIfTheyHadBeenTaken: stats(skipped.map(r => r.base)),
    };
}

function computeDelayBacktest(outcomes, simulate, grid, opts = {}) {
    const delays = opts.delays || DEFAULT_DELAYS, confirms = opts.confirms || DEFAULT_CONFIRMS;
    const minHalf = opts.minHalfN ?? 30;
    const usable = (outcomes || []).filter(o => o && o.entryPremium > 0 && Array.isArray(o.path) && o.path.length >= 3 && Number.isFinite(o.fireTs))
        .map(o => ({ ...o, path: [...o.path].sort((a, b) => a.ts - b.ts) }));
    const used = declusterOutcomes(usable, opts.declusterMin ?? 30);
    const variants = [];
    for (const d of delays) for (const c of confirms) {
        const rows = runVariant(used, simulate, grid, d, c).sort((a, b) => a.fireTs - b.fireTs);
        const overall = summarizeRows(rows);
        const half = Math.floor(rows.length / 2);
        const older = summarizeRows(rows.slice(0, half)), newer = summarizeRows(rows.slice(half));
        let verdict;
        if (older.signals < minHalf || newer.signals < minHalf) verdict = `INSUFFICIENT — need ${minHalf}+ signals in each half (have ${older.signals}/${newer.signals})`;
        else if (older.delta > 0 && newer.delta > 0) verdict = 'BEATS BASELINE IN BOTH HALVES — a lead worth paper-testing, not proof';
        else verdict = 'NOT PROVEN — does not beat baseline in both halves';
        variants.push({ delayMin: d, confirmPctAboveEntry: c, ...overall, olderHalf: { signals: older.signals, delta: older.delta }, newerHalf: { signals: newer.signals, delta: newer.delta }, verdict });
    }
    variants.sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity));
    return { outcomesUsed: used.length, outcomesBeforeDecluster: usable.length, grid, variants };
}

module.exports = { computeDelayBacktest, declusterOutcomes, runVariant, summarizeRows, DEFAULT_DELAYS, DEFAULT_CONFIRMS };