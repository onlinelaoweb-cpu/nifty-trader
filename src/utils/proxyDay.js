'use strict';
// ── Order-flow PROXY, one IST day, in 15-minute bars (17 Oct 2026) ─────────────────────────────────────────────────────
// Read-only helper for /api/orderflow-proxy-day. Purpose: compare the app's volume-delta PROXY with a real footprint (e.g. Dhan DEXT T3)
// for the same day, bar by bar. Nothing here feeds signals, gates, alerts or the UI. Pure (no I/O).
// HONEST LIMIT: the proxy is NOT a footprint. Per ~5-min snapshot step: step volume = change in NIFTY FUTURES cumulative volume;
// delta = step volume x (close position inside the last 5 one-minute candles, -1..+1). It guesses the buy/sell split, it does not measure it.
// Steps across a data gap (> 8 min), a volume reset or a missing field give NO delta (never a guess) and are counted in `gaps`.
const OF = require('./orderflowContext');

const r2 = v => (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v * 100) / 100;
const istMinutes = ms => { const d = new Date(ms + 330 * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// snaps: ascending-or-not [{ ms, nifty, futVol, barClv, barRngPct, dayHigh, dayLow }] (any days). dayStr: 'YYYY-MM-DD' (IST).
function buildProxyDay(snaps, dayStr, o = {}) {
    const binMin = o.binMin || 15, openMin = o.openMin ?? 555, closeMin = o.closeMin ?? 930;   // 09:15 .. 15:30
    const day = (snaps || []).filter(s => s && Number.isFinite(s.ms) && OF.istDay(s.ms) === dayStr).sort((a, b) => a.ms - b.ms);
    const A = OF.annotateBars(day);
    const bins = new Map();
    let usable = 0, gapSteps = 0;
    A.forEach((s, i) => {
        const m = istMinutes(s.ms - 1);                          // a step ending exactly on a bar boundary belongs to the bar it closes
        if (m < openMin || m >= closeMin) return;
        const k = Math.floor((m - openMin) / binMin);
        if (!bins.has(k)) bins.set(k, { k, steps: 0, gaps: 0, vol: 0, delta: 0, prices: [], rngs: [], abs: new Set() });
        const b = bins.get(k);
        if (Number.isFinite(s.nifty) && s.nifty > 0) b.prices.push(s.nifty);
        if (s.barVol === null || s.delta === null || !Number.isFinite(s.delta)) { b.gaps++; gapSteps++; return; }
        b.steps++; usable++; b.vol += s.barVol; b.delta += s.delta;
        if (Number.isFinite(s.barRngPct)) b.rngs.push(s.barRngPct);
        const lo = OF.classifyAbsorption(A, i, 1, 1), hi = OF.classifyAbsorption(A, i, -1, 1);
        if (lo === 'ABSORPTION_AT_EXTREME') b.abs.add('AT_DAY_LOW');
        else if (hi === 'ABSORPTION_AT_EXTREME') b.abs.add('AT_DAY_HIGH');
        else if (lo === 'ABSORPTION') b.abs.add('ABSORPTION');
        else if (lo === 'NONE') b.abs.add('NONE');
    });
    const out = []; let cum = 0, prevClose = null;
    for (const k of [...bins.keys()].sort((a, b) => a - b)) {
        const b = bins.get(k);
        cum += b.delta;
        const hi = b.prices.length ? Math.max(...b.prices) : null, lo = b.prices.length ? Math.min(...b.prices) : null;
        const close = b.prices.length ? b.prices[b.prices.length - 1] : null, open = prevClose !== null ? prevClose : (b.prices.length ? b.prices[0] : null);
        if (close !== null) prevClose = close;
        const absorption = b.abs.has('AT_DAY_LOW') ? 'AT_DAY_LOW' : b.abs.has('AT_DAY_HIGH') ? 'AT_DAY_HIGH' : b.abs.has('ABSORPTION') ? 'ABSORPTION' : b.abs.has('NONE') ? 'NONE' : null;
        out.push({ time: hhmm(openMin + k * binMin), steps: b.steps, gaps: b.gaps, volume: Math.round(b.vol), delta: Math.round(b.delta), cumDelta: Math.round(cum),
            deltaShare: b.vol > 0 ? r2(b.delta / b.vol) : null, open: r2(open), close: r2(close), chgPts: open !== null && close !== null ? r2(close - open) : null,
            rangePct: hi !== null && close > 0 ? r2((hi - lo) / close * 100) : null,
            candleRngPct: b.rngs.length ? r2(b.rngs.reduce((x, y) => x + y, 0) / b.rngs.length) : null, absorption });
    }
    return { day: dayStr, binMin, snapshots: day.length, usableSteps: usable, gapSteps, bins: out };
}

function formatProxyDayText(res) {
    const L = [];
    L.push(`ORDER-FLOW PROXY - ${res.day} (IST), ${res.binMin}-minute bars, NIFTY futures volume`);
    L.push(`snapshots ${res.snapshots} | usable steps ${res.usableSteps} | gap steps (no delta) ${res.gapSteps}`);
    L.push('NOT a footprint: delta = step volume x close position in the last 5 one-minute candles (a guess of the buy/sell split). Volume is in the futures feed\'s own unit - compare SHAPE and SIGN with the real footprint, not the absolute size.');
    if (!res.bins.length) { L.push('', 'No usable bars for this day (market closed, or the futures-volume context columns have no rows for it).'); return L.join('\n'); }
    L.push('', 'time  | steps(gaps) | volume      | proxy delta | cum delta   | delta/vol | open -> close (chg) | range% | 5m-candle rng% | absorption');
    for (const b of res.bins) L.push(`${b.time} | ${b.steps}(${b.gaps})`.padEnd(20) + `| ${String(b.volume).padStart(11)} | ${String(b.delta).padStart(11)} | ${String(b.cumDelta).padStart(11)} | ${String(b.deltaShare ?? '-').padStart(9)} | ${b.open ?? '-'} -> ${b.close ?? '-'} (${b.chgPts ?? '-'}) | ${b.rangePct ?? '-'} | ${b.candleRngPct ?? '-'} | ${b.absorption ?? '-'}`);
    L.push('', 'Range% uses only the 5-minute snapshot prices inside the bar, so it is coarse (it under-states the true high-low range). 5m-candle rng% = the average high-low range of the last 5 one-minute candles at each snapshot (the number the absorption test uses); 0 means no usable candle data. Absorption: step volume >= 1.5x the day\'s earlier average while the 5-min range <= 0.6x its average (needs >= 6 earlier steps; blank = not enough data yet).');
    return L.join('\n');
}

module.exports = { buildProxyDay, formatProxyDayText, istMinutes, hhmm };