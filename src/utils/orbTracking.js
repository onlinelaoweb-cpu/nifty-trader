// ── ORB (Opening Range Breakout) tracking ─────────────────────────────────
// Extracted verbatim from server.js (14 Sep refactor). orbState is now an
// explicit parameter instead of module-scope `let` variables — since it's
// the same object reference server.js already holds, mutations here are
// visible to server.js immediately, same as before. Zero behavior change.
//
// server.js owns the state object; shape:
//   { high: null, low: null, date: null, breakUpTime: null, breakDownTime: null }
const { getIST } = require('./timeWindows');
const { getSessionCandles } = require('../api/indicators');

// First 15 minutes of the session (9:15–9:30 IST) often sets the tone for the
// rest of the day. Once locked, price breaking cleanly above/below it is a
// useful directional filter — reduces false entries while price is still
// inside the morning's initial balance.
function updateORB(orbState) {
    const todayStr = getIST().toISOString().slice(0, 10);
    if (orbState.date !== todayStr) {
        orbState.high = null; orbState.low = null; orbState.date = todayStr;
        orbState.breakUpTime = null; orbState.breakDownTime = null;
    }
    if (orbState.high !== null) return; // already locked for today

    const candles = getSessionCandles(); // 9:15 IST onward, 1 candle per minute
    if (candles.length >= 15) {
        const first15 = candles.slice(0, 15);
        orbState.high = Math.max(...first15.map(c => c.high));
        orbState.low  = Math.min(...first15.map(c => c.low));
    }
}

function getORBStatus(price, orbState) {
    if (orbState.high === null || orbState.low === null) {
        return { status: 'FORMING', label: '⏳ Opening range forming (need 15 min)', high: null, low: null };
    }
    if (price > orbState.high) return { status: 'BROKEN_UP',   label: `🔼 ORB Broken Up (&gt;${orbState.high.toFixed(0)})`,   high: orbState.high, low: orbState.low };
    if (price < orbState.low)  return { status: 'BROKEN_DOWN', label: `🔽 ORB Broken Down (&lt;${orbState.low.toFixed(0)})`, high: orbState.high, low: orbState.low };
    return { status: 'INSIDE', label: `↔️ Inside Opening Range (${orbState.low.toFixed(0)}–${orbState.high.toFixed(0)})`, high: orbState.high, low: orbState.low };
}

// 5 Sep — Breakout regime freshness tracking (audit: weekly Breakout regime
// showed -0.129R avg over 42 signals). Hypothesis: getORBStatus() is a pure
// live price-vs-fixed-range check with no time dimension — it tags a fresh
// 9:35am breakout thrust and a stale 1:45pm re-test of the same level
// (after hours of chop) identically as "ORB Breakout". Rather than guess,
// track WHEN each direction first broke today so signal_log can record the
// breakout's age at fire time — then decide with data whether stale breakouts
// are the ones dragging the regime negative, instead of blocking the whole
// category and possibly discarding genuinely-fresh, well-performing ones.
function trackORBBreakoutFreshness(status, orbState) {
    // Sets the timestamp on the FIRST tick of a new break, and clears it the
    // moment price comes back inside the range (or flips to the other side)
    // — so if it re-breaks later the same day, that's treated as a fresh
    // breakout with its own age, not still "aged" from the earlier one.
    // Reset also happens wholesale on day rollover, inside updateORB().
    if (status === 'BROKEN_UP') {
        if (orbState.breakUpTime === null) orbState.breakUpTime = Date.now();
    } else {
        orbState.breakUpTime = null;
    }
    if (status === 'BROKEN_DOWN') {
        if (orbState.breakDownTime === null) orbState.breakDownTime = Date.now();
    } else {
        orbState.breakDownTime = null;
    }
}

function getORBBreakoutAgeMin(status, orbState) {
    const ts = status === 'BROKEN_UP' ? orbState.breakUpTime : status === 'BROKEN_DOWN' ? orbState.breakDownTime : null;
    return ts ? Math.round((Date.now() - ts) / 60000) : null;
}

module.exports = { updateORB, getORBStatus, trackORBBreakoutFreshness, getORBBreakoutAgeMin };
