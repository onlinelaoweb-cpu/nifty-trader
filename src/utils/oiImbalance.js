'use strict';
// Murarka OI imbalance = (put OI being WRITTEN) / (call OI being WRITTEN) in one ~3-min cycle.
// 30 Oct fix: the old code used pOI / Math.abs(cOI). When calls were being UNWOUND (cOI = -549K, bullish) and puts
// were added (+62K) that gave 0.11 and the panel said "Call writers dominating (bearish)" — the opposite of the data.
// Only positive changes count as writing. Unwinding is not writing.
//   puts written, no calls written  -> 9.99 (cap, strongly bullish)
//   calls written, no puts written  -> 0
//   neither written (or no data)    -> null (UI shows quiet / awaiting)
const CAP = 9.99;
function computeOiImbalance(putChange, callChange) {
    if (putChange == null || callChange == null || !Number.isFinite(putChange) || !Number.isFinite(callChange)) return null;
    const pW = Math.max(putChange, 0), cW = Math.max(callChange, 0);
    if (pW === 0 && cW === 0) return null;
    if (cW === 0) return CAP;
    return parseFloat(Math.min(CAP, pW / cW).toFixed(2));
}
module.exports = { computeOiImbalance, CAP };