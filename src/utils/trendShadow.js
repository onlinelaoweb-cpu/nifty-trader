'use strict';
// 15 Nov — SHADOW ONLY. Hypothetical "Nifty 1H 50-MA + Supertrend" rule log.
// Rule (as described in a trader interview; exact parameters were NOT stated,
// so these are ASSUMPTIONS): 1-hour candles, entry filter = close vs SMA(50),
// trailing stop = Supertrend(ATR 10, multiplier 3).
//   LONG  entry : bar closes above SMA50 AND Supertrend is UP (flat before)
//   SHORT entry : bar closes below SMA50 AND Supertrend is DOWN (flat before)
//   Exit        : Supertrend flips against the position (its line = trailing stop)
// Pure functions; no I/O, no orders, nothing feeds the signal engine.

const MA_PERIOD = 50, ST_PERIOD = 10, ST_MULT = 3;

function sma(closes, n) {
    const out = new Array(closes.length).fill(null);
    let sum = 0;
    for (let i = 0; i < closes.length; i++) {
        sum += closes[i];
        if (i >= n) sum -= closes[i - n];
        if (i >= n - 1) out[i] = sum / n;
    }
    return out;
}

// Wilder ATR + classic Supertrend. candles: [{h,l,c}]. Returns [{line, dir}] (dir 1 up, -1 down)
function supertrend(candles, period = ST_PERIOD, mult = ST_MULT) {
    const n = candles.length, out = new Array(n).fill(null);
    if (n <= period) return out;
    const tr = candles.map((x, i) => i === 0 ? x.h - x.l
        : Math.max(x.h - x.l, Math.abs(x.h - candles[i - 1].c), Math.abs(x.l - candles[i - 1].c)));
    let atr = 0;
    for (let i = 1; i <= period; i++) atr += tr[i];
    atr /= period;
    let fub = 0, flb = 0, dir = 1;
    for (let i = period; i < n; i++) {
        if (i > period) atr = (atr * (period - 1) + tr[i]) / period;
        const mid = (candles[i].h + candles[i].l) / 2;
        const ub = mid + mult * atr, lb = mid - mult * atr;
        if (i === period) { fub = ub; flb = lb; dir = candles[i].c >= mid ? 1 : -1; }
        else {
            const pc = candles[i - 1].c;
            fub = (ub < fub || pc > fub) ? ub : fub;
            flb = (lb > flb || pc < flb) ? lb : flb;
            if (dir === 1 && candles[i].c < flb) dir = -1;
            else if (dir === -1 && candles[i].c > fub) dir = 1;
        }
        out[i] = { line: dir === 1 ? flb : fub, dir };
    }
    return out;
}

// Replays completed candles. Returns { state, price, ma, stLine, stDir, open, trades, bars }
function compute(candles) {
    const empty = { state: 'NO_DATA', bars: candles ? candles.length : 0, trades: [], open: null };
    if (!Array.isArray(candles) || candles.length < MA_PERIOD) return empty;
    const ma = sma(candles.map(x => x.c), MA_PERIOD);
    const st = supertrend(candles);
    const trades = []; let pos = null;
    for (let i = MA_PERIOD - 1; i < candles.length; i++) {
        if (!st[i] || ma[i] === null) continue;
        const c = candles[i].c;
        if (pos && pos.side === 'LONG' && st[i].dir === -1) { trades.push({ ...pos, exitTs: candles[i].ts, exit: c, pts: c - pos.entry }); pos = null; }
        else if (pos && pos.side === 'SHORT' && st[i].dir === 1) { trades.push({ ...pos, exitTs: candles[i].ts, exit: c, pts: pos.entry - c }); pos = null; }
        if (!pos) {
            if (c > ma[i] && st[i].dir === 1) pos = { side: 'LONG', entryTs: candles[i].ts, entry: c };
            else if (c < ma[i] && st[i].dir === -1) pos = { side: 'SHORT', entryTs: candles[i].ts, entry: c };
        }
    }
    const i = candles.length - 1;
    const price = candles[i].c;
    return {
        state: pos ? pos.side : 'FLAT', bars: candles.length, price,
        ma: ma[i], stLine: st[i] && st[i].line, stDir: st[i] && st[i].dir,
        open: pos ? { ...pos, floating: pos.side === 'LONG' ? price - pos.entry : pos.entry - price } : null,
        trades,
        totalPts: trades.reduce((a, t) => a + t.pts, 0),
        asOf: candles[i].ts,
    };
}

// Angel ONE_HOUR rows [ts,o,h,l,c,v] -> candles, dropping a still-forming last bar
function parseAngel(rows, nowMs = Date.now()) {
    if (!Array.isArray(rows)) return [];
    return rows.map(r => ({ ts: r[0], t: Date.parse(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4] }))
        .filter(x => isFinite(x.c) && x.c > 0 && isFinite(x.t) && x.t + 3600e3 <= nowMs + 60e3);
}

const api = { compute, sma, supertrend, parseAngel, MA_PERIOD, ST_PERIOD, ST_MULT };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
