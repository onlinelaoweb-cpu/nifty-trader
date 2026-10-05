'use strict';
// ivSource.js — which implied volatility the app's Greeks maths should use.
// (5 Oct 2026) The app's Black-Scholes estimates were fed India VIX as "IV". VIX is a 30-day
// index; the weekly ATM option the app actually trades carries its own, usually HIGHER, IV
// (live check on 5 Oct: Fyers chain ATM IV 18.6 vs VIX 14.4 -> real theta ~20% heavier than the
// VIX-based estimate, and VIX-based "IV change" was blind to the option's own IV moves).
// nseData.js refreshes the ATM IV from the Fyers option chain (greeks=1) once a minute; everything
// that does Greeks maths asks getIvPct(vix) and silently falls back to VIX whenever the chain IV is
// missing, stale (> 10 min) or implausible — so behaviour is never WORSE than before.
const STALE_MS = 10 * 60 * 1000;
let atm = { iv: null, ts: 0 };

function setAtmIv(iv, ts = Date.now()) {
    const v = Number(iv);
    if (Number.isFinite(v) && v >= 5 && v <= 80) atm = { iv: v, ts };   // % points; reject garbage
}
function getAtmIvIfFresh() {
    return (atm.iv != null && (Date.now() - atm.ts) < STALE_MS) ? atm.iv : null;
}
// -> { iv: <% points>, source: 'chain' | 'vix' }
function getIvPct(vixFallback) {
    const f = getAtmIvIfFresh();
    return f != null ? { iv: f, source: 'chain' } : { iv: vixFallback, source: 'vix' };
}
module.exports = { setAtmIv, getAtmIvIfFresh, getIvPct };