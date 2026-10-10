'use strict';
// ── Order-flow / level context (10 Oct 2026) ────────────────────────────────────────────────────────
// Ideas taken from the Blooming Bull sessions, turned into things we can LOG and then TEST (nothing here changes signals):
//   1. liquidity sweep of the PREVIOUS DAY high/low (wick beyond the level, then close back inside = reclaim)
//   2. how much of the usual daily range has already been used (reaction at day high/low matters only after the range is spent)
//   3. location against the Value Area (VAH / VAL / POC)
//   4. a bar-level volume-delta PROXY from NIFTY FUTURES volume (Fyers cumulative volume, differenced between 5-min snapshots) and
//      absorption (heavy volume, tiny range).  HONEST LIMIT: this is NOT a footprint. The buy/sell split of a bar is estimated from
//      where the bar closed inside its own range (close near the high = buyers, near the low = sellers). Treat it as a hint to test.
// Everything here is PURE (no I/O) so it is unit-tested.

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const r2 = v => v === null ? null : Math.round(v * 100) / 100;

// Last n 1-minute candles -> one bar. Returns { clv (-1..+1), rngPct } or null.
// clv = (2*close - high - low) / (high - low): +1 close at the high, -1 at the low, 0 mid-range.
function lastBarSummary(candles, n = 5) {
    const c = (candles || []).filter(x => x && num(x.high) !== null && num(x.low) !== null && num(x.close) !== null);
    if (c.length < 2) return null;
    const bars = c.slice(-n);
    const hi = Math.max(...bars.map(x => Number(x.high))), lo = Math.min(...bars.map(x => Number(x.low))), cl = Number(bars[bars.length - 1].close);
    if (!(cl > 0) || hi < lo) return null;
    const rng = hi - lo;
    return { clv: rng > 0 ? r2((2 * cl - hi - lo) / rng) : 0, rngPct: r2((rng / cl) * 100) };
}

// Sweep of the previous-day high/low inside the last `lookback` 1-minute candles.
// 'PDH' = a wick went ABOVE the previous-day high and the latest close is back BELOW it (bearish trap);
// 'PDL' = a wick went BELOW the previous-day low and the latest close is back ABOVE it (bullish trap).
// Merely touching without a reclaim (price still beyond the level) is not a sweep.
function detectPrevDaySweep(candles, pdh, pdl, lookback = 15) {
    const c = (candles || []).filter(x => x && num(x.high) !== null && num(x.low) !== null && num(x.close) !== null).slice(-lookback);
    if (c.length < 3) return null;
    const last = Number(c[c.length - 1].close), hi = Math.max(...c.map(x => Number(x.high))), lo = Math.min(...c.map(x => Number(x.low)));
    const H = num(pdh), L = num(pdl);
    const upSweep = H !== null && hi > H && last < H, dnSweep = L !== null && lo < L && last > L;
    if (upSweep && dnSweep) return null;      // both in one window = noise, say nothing
    return upSweep ? 'PDH' : dnSweep ? 'PDL' : null;
}

// Everything saveMarketSnapshot stores for this study. input: { price, dayHigh, dayLow, futVolume, poc:{poc,vah,val}, pdh, pdl, candles }
// Returns plain numbers/strings or nulls (never throws).
function buildContextExtras(input) {
    try {
        const i = input || {};
        const bar = lastBarSummary(i.candles, 5);
        const poc = i.poc || {};
        return {
            poc: num(poc.poc), vah: num(poc.vah), val: num(poc.val),
            pdh: num(i.pdh), pdl: num(i.pdl),
            dayHigh: num(i.dayHigh), dayLow: num(i.dayLow),
            futVol: num(i.futVolume) !== null && num(i.futVolume) > 0 ? Math.round(num(i.futVolume)) : null,
            barClv: bar ? bar.clv : null, barRngPct: bar ? bar.rngPct : null,
            sweep: detectPrevDaySweep(i.candles, i.pdh, i.pdl, 15),
        };
    } catch (e) { return { poc: null, vah: null, val: null, pdh: null, pdl: null, dayHigh: null, dayLow: null, futVol: null, barClv: null, barRngPct: null, sweep: null }; }
}

// ── analysis helpers (used by the study) ────────────────────────────────────────────────────────────

const istDay = ms => new Date(ms + 330 * 60000).toISOString().slice(0, 10);

// snaps: ascending [{ ms, nifty, futVol, barClv, barRngPct, dayHigh, dayLow }]. Adds .barVol (futures volume in this 5-min step, null if unknowable)
// and .delta (= barVol * barClv). Steps across a day boundary, a gap > gapMin, or a volume reset give null (not a guess).
function annotateBars(snaps, gapMin = 8) {
    const out = [];
    for (let k = 0; k < snaps.length; k++) {
        const s = { ...snaps[k], barVol: null, delta: null };
        const p = k > 0 ? snaps[k - 1] : null;
        if (p && p.futVol > 0 && s.futVol > 0 && istDay(p.ms) === istDay(s.ms) && s.ms - p.ms <= gapMin * 60000 && s.futVol >= p.futVol) {
            s.barVol = s.futVol - p.futVol;
            s.delta = s.barClv === null || s.barClv === undefined ? null : s.barVol * s.barClv;
        }
        out.push(s);
    }
    return out;
}

// Usual daily range = mean of the (dayHigh - dayLow) of up to `maxDays` earlier days (last snapshot of each day). Needs >= minDays.
function priorAvgRange(snaps, dayStr, maxDays = 10, minDays = 3) {
    const byDay = new Map();
    for (const s of snaps) {
        if (!(s.dayHigh > 0 && s.dayLow > 0 && s.dayHigh >= s.dayLow)) continue;
        const d = istDay(s.ms);
        if (d >= dayStr) continue;
        byDay.set(d, s.dayHigh - s.dayLow);                  // ascending input -> the last write is the day's final range
    }
    const ranges = [...byDay.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1).slice(0, maxDays).map(e => e[1]);
    return ranges.length >= minDays ? ranges.reduce((a, b) => a + b, 0) / ranges.length : null;
}

// Flow classification at index idx over the previous `bars` steps.
//   'CONFIRMED'  : estimated delta over the window points WITH the trade (> +10% of window volume)
//   'DIVERGENCE' : price progressed with the trade over the window but the delta points AGAINST it (< -10%)
//   'AGAINST'    : delta points against the trade without price progress
//   'MIXED'      : in between      |   null: not enough volume data
function classifyFlow(A, idx, side, bars = 6) {
    if (idx < bars) return null;
    let vol = 0, del = 0, n = 0;
    for (let k = idx - bars + 1; k <= idx; k++) { if (A[k].barVol > 0 && A[k].delta !== null) { vol += A[k].barVol; del += A[k].delta; n++; } }
    if (n < Math.ceil(bars / 2) || vol <= 0) return null;
    const share = (del / vol) * side;
    const progress = (A[idx].nifty - A[idx - bars].nifty) * side;
    if (share > 0.1) return 'CONFIRMED';
    if (share < -0.1) return progress > 0 ? 'DIVERGENCE' : 'AGAINST';
    return 'MIXED';
}

// Absorption in the last `look` steps: a step whose volume is >= 1.5x the day's earlier average step volume while its range is <= 0.6x
// the day's earlier average bar range. Returns 'NONE' | 'ABSORPTION' | 'ABSORPTION_AT_EXTREME' (the latter: bar sits in the outer 25% of
// the day's range on the side the trade leans against — low for a call, high for a put) | null when volume data is not usable.
function classifyAbsorption(A, idx, side, look = 2) {
    const day = istDay(A[idx].ms);
    const earlier = [];
    for (let k = 0; k < idx - look + 1 && k < A.length; k++) { if (istDay(A[k].ms) === day && A[k].barVol > 0 && A[k].barRngPct > 0) earlier.push(A[k]); }
    if (earlier.length < 6) return null;
    const avgVol = earlier.reduce((a, b) => a + b.barVol, 0) / earlier.length, avgRng = earlier.reduce((a, b) => a + b.barRngPct, 0) / earlier.length;
    let found = null;
    for (let k = Math.max(0, idx - look + 1); k <= idx; k++) {
        const b = A[k];
        if (b.barVol > 0 && b.barRngPct !== null && b.barRngPct !== undefined && b.barVol >= 1.5 * avgVol && b.barRngPct <= 0.6 * avgRng) found = b;
    }
    if (!found) return 'NONE';
    const span = found.dayHigh - found.dayLow;
    if (span > 0) {
        const pos = (found.nifty - found.dayLow) / span;
        if ((side === 1 && pos <= 0.25) || (side === -1 && pos >= 0.75)) return 'ABSORPTION_AT_EXTREME';
    }
    return 'ABSORPTION';
}

// Value-area location bucket for a trade entered at `price` (side +1 call / -1 put).
function valueAreaBucket(price, snap, side) {
    const { poc, vah, val } = snap;
    if (!(price > 0) || !(vah > 0) || !(val > 0) || vah < val) return null;
    const tol = price * 0.001;                                 // 0.1%
    if (price > vah + tol) return side === 1 ? 'ABOVE value area, trade WITH it' : 'ABOVE value area, trade AGAINST it';
    if (price < val - tol) return side === -1 ? 'BELOW value area, trade WITH it' : 'BELOW value area, trade AGAINST it';
    if (Math.abs(price - vah) <= tol || Math.abs(price - val) <= tol) return 'AT value-area edge (VAH/VAL +-0.1%)';
    if (poc > 0 && Math.abs(price - poc) <= tol) return 'AT POC (+-0.1%)';
    return 'inside value area (middle)';
}

function sweepBucket(sweep, side) {
    if (!sweep) return 'no sweep in last 15 min';
    const withTrade = (sweep === 'PDL' && side === 1) || (sweep === 'PDH' && side === -1);
    return withTrade ? 'prev-day level SWEPT & reclaimed, trade WITH the reversal' : 'prev-day level swept, trade AGAINST the reversal';
}

function rangeUsedBucket(pct) {
    if (pct === null || pct === undefined) return null;
    if (pct < 50) return 'range used < 50% of usual';
    if (pct < 75) return 'range used 50-75%';
    if (pct < 100) return 'range used 75-100%';
    return 'range used > 100% (already stretched)';
}

// Gamma regime from the Option-Greeks dashboard's flip level: above the flip dealers are net long gamma (moves get damped / pinned),
// below it they are net short gamma (moves get amplified). +-0.15% around the flip is its own bucket because the regime is unclear there.
function gammaFlipBucket(price, flip) {
    if (!(price > 0) || !(flip > 0)) return null;
    const d = ((price - flip) / flip) * 100;
    if (Math.abs(d) <= 0.15) return 'AT gamma-flip level (+-0.15%)';
    return d > 0 ? 'ABOVE gamma flip (positive-gamma side)' : 'BELOW gamma flip (negative-gamma side)';
}

// Distance to the max-gamma strike (where option open interest concentrates gamma - the classic "pin").
function maxGammaBucket(price, strike) {
    if (!(price > 0) || !(strike > 0)) return null;
    const d = Math.abs((price - strike) / strike) * 100;
    if (d <= 0.15) return 'PINNED: within 0.15% of max-gamma strike';
    if (d <= 0.4) return 'near max-gamma strike (0.15-0.4%)';
    return 'away from max-gamma strike (> 0.4%)';
}

module.exports = { gammaFlipBucket, maxGammaBucket, lastBarSummary, detectPrevDaySweep, buildContextExtras, annotateBars, priorAvgRange, classifyFlow, classifyAbsorption, valueAreaBucket, sweepBucket, rangeUsedBucket, istDay };