'use strict';
// Liquidity-sweep study (research only, feeds nothing). Tests the "stop-hunt then reversal" idea on daily NIFTY candles:
//   BULL sweep = today's low undercuts the lowest low of the previous N days, but the day CLOSES back above that level.
//   BEAR sweep = today's high exceeds the highest high of the previous N days, but the day CLOSES back below it.
//   Placebo    = true break (undercut AND close beyond the level) -> "breakdown/breakout", the opposite reading.
// Question: after a sweep, do the next 1/3/5 days move in the reversal direction more than the baseline?
const num = v => Number(v);
const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
// z for mean(a) vs mean(b); h = horizon overlap correction (effective n = n / h)
function z(a, b, h) {
    if (a.length < 5 || b.length < 5) return null;
    const se = Math.sqrt(sd(a) ** 2 / (a.length / h) + sd(b) ** 2 / (b.length / h));
    return se > 0 ? r2((mean(a) - mean(b)) / se) : null;
}
function stats(a) { return { n: a.length, meanPct: r2(mean(a)), upPct: a.length ? r2(100 * a.filter(x => x > 0).length / a.length) : null }; }

function runSweepStudy(raw, opt = {}) {
    const c = raw.map(x => ({ date: x.date, open: num(x.open), high: num(x.high), low: num(x.low), close: num(x.close) }))
        .filter(x => [x.open, x.high, x.low, x.close].every(Number.isFinite));
    const lookbacks = opt.lookbacks || [5, 10, 20], horizons = opt.horizons || [1, 3, 5];
    const out = { candles: c.length, variants: [] };
    for (const N of lookbacks) {
        const ev = { bullSweep: [], bearSweep: [], breakdown: [], breakout: [] };   // indexes
        for (let t = N; t < c.length; t++) {
            const w = c.slice(t - N, t), lo = Math.min(...w.map(x => x.low)), hi = Math.max(...w.map(x => x.high));
            if (c[t].low < lo) (c[t].close > lo ? ev.bullSweep : ev.breakdown).push(t);
            if (c[t].high > hi) (c[t].close < hi ? ev.bearSweep : ev.breakout).push(t);
        }
        const rows = [];
        for (const h of horizons) {
            const ret = t => (t + h < c.length ? (c[t + h].close / c[t].close - 1) * 100 : null);
            const get = idx => idx.map(ret).filter(Number.isFinite);
            const base = []; for (let t = N; t + h < c.length; t++) base.push(ret(t));
            const bull = get(ev.bullSweep), bear = get(ev.bearSweep).map(x => -x),            // bear sweep: reversal = DOWN, so flip sign
                  down = get(ev.breakdown).map(x => -x), up = get(ev.breakout);                // placebo: continuation direction
            rows.push({ h, baseline: stats(base), bullSweepFwd: stats(bull), bearSweepFwd_downIsPositive: stats(bear),
                breakdownFwd_downIsPositive: stats(down), breakoutFwd: stats(up),
                zBullSweepVsBase: z(bull, base, h), zBearSweepVsBaseFlipped: z(bear, base.map(x => -x), h),
                zSweepVsTrueBreak: z([...bull, ...bear], [...down, ...up], h) });
        }
        out.variants.push({ lookback: N, counts: { bullSweep: ev.bullSweep.length, bearSweep: ev.bearSweep.length, breakdown: ev.breakdown.length, breakout: ev.breakout.length }, rows });
    }
    const zs = out.variants.flatMap(v => v.rows.flatMap(r => [r.zBullSweepVsBase, r.zBearSweepVsBaseFlipped])).filter(Number.isFinite);
    const best = zs.length ? Math.max(...zs.map(Math.abs)) : null;
    out.verdict = best === null ? 'NOT ENOUGH DATA'
        : best >= 3 ? `POSSIBLE EDGE (best |z| = ${best}) — still needs an out-of-sample check before any use`
        : best >= 2 ? `WEAK / UNCONFIRMED (best |z| = ${best}; ${zs.length} tests, so one |z|>=2 is expected by chance)`
        : `NO EDGE: sweep-and-reclaim does not beat the baseline (best |z| = ${best}; ${zs.length} tests, none >= 2)`;
    out.note = 'Daily bars only: tests the idea, not an intraday implementation. Bear sweeps are shown with sign flipped (positive = fell as the reversal idea predicts). z uses an overlap correction for multi-day horizons.';
    return out;
}

function formatSweepText(s) {
    const o = [`LIQUIDITY SWEEP STUDY (daily NIFTY, ${s.candles} candles, research only)`,
        'Bull sweep = low undercuts prior N-day low but close reclaims it. Bear sweep = mirror at highs. Placebo = true breakdown / breakout.', ''];
    for (const v of s.variants) {
        o.push(`■ lookback ${v.lookback}d  | bull sweeps ${v.counts.bullSweep} · bear sweeps ${v.counts.bearSweep} · breakdowns ${v.counts.breakdown} · breakouts ${v.counts.breakout}`);
        for (const r of v.rows) {
            const f = (k, x) => `${k} n${x.n} mean ${x.meanPct}% hit ${x.upPct}%`;
            o.push(`  h=${r.h}d  ${f('base', r.baseline)} | ${f('BULL-sweep', r.bullSweepFwd)} z=${r.zBullSweepVsBase} | ${f('BEAR-sweep(down+)', r.bearSweepFwd_downIsPositive)} z=${r.zBearSweepVsBaseFlipped} | sweep-vs-true-break z=${r.zSweepVsTrueBreak}`);
        }
    }
    o.push('', 'VERDICT: ' + s.verdict, s.note);
    return o.join('\n');
}
module.exports = { runSweepStudy, formatSweepText };