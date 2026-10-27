'use strict';
// tickRoute.js — 28 Oct 2026
// Decides whether a websocket tick belongs to the CRUDEOIL path or the NIFTY path.
//
// The old rule used only the CLOCK (getActiveSession() === 'CRUDEOIL'). The crude window ends 23:55 IST and the socket is switched back to NIFTY by a
// watcher up to ~90 s later, so a crude tick arriving in that gap was handled as a NIFTY tick. After a restart (the first tick is accepted without
// the 5% sanity guard) that wrote crude's ~9,505 into marketState.nifty, and the real NIFTY snapshot after the reconnect (22,749) was then rejected
// as "139% away" -> the Nifty tile, VWAP, RSI showed crude values until the morning (seen 28 Oct, 00:13, after a 23:50 deploy).
// The socket already knows what it subscribed to, so each tick now carries that label and the label decides. Ticks with no label (any other caller)
// keep the old clock-based behaviour.
function isCrudeTick(tickLabel, activeSession) {
    if (tickLabel === 'CRUDEOIL') return true;
    if (tickLabel) return false;                 // a NIFTY-labelled tick is never crude, even if the clock says crude time
    return activeSession === 'CRUDEOIL';
}
module.exports = { isCrudeTick };