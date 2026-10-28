'use strict';
// 28 Oct — pick the REAL previous-day daily bar (not today's running high/low).
// levels.js used NSE's live index row (today's high/low + previousClose) as "previous day", so Prev Day High/Low
// and all pivots followed today's developing range. A bar is accepted only if it is dated before today (IST)
// and its close matches the live previousClose within tolPct — a guard against a missing/stale day.
function isoDate(d) {
    if (!d) return null;
    const s = String(d);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t + 5.5 * 3600 * 1000).toISOString().slice(0, 10) : null;
}

function pickPrevDayBar(bars, todayISO, prevClose, tolPct = 0.15) {
    if (!Array.isArray(bars) || !todayISO) return null;
    const prior = bars
        .map(b => ({ b, d: isoDate(b && b.date) }))
        .filter(x => x.d && x.d < todayISO && Number(x.b.high) > 0 && Number(x.b.low) > 0 && Number(x.b.high) >= Number(x.b.low))
        .sort((a, b) => a.d.localeCompare(b.d));
    if (!prior.length) return null;
    const last = prior[prior.length - 1].b;
    const pc = Number(prevClose);
    if (pc > 0 && Math.abs(Number(last.close) - pc) / pc * 100 > tolPct) return null;   // not yesterday's bar
    return { high: Number(last.high), low: Number(last.low), close: Number(last.close), open: Number(last.open) || Number(last.close) };
}

module.exports = { pickPrevDayBar, isoDate };