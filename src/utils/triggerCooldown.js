// Same-side cooldown for exploratory triggers whose "active" flag can flip on/off
// around a threshold edge (e.g. crude Murarka: spot hovering at the edge of the
// +/-0.2% VWAP band). Without this every re-entry into the band is a new alert.
// Pure function: no clock, no state of its own.
//
//   last     : { side, at } of the previous ALERTED fire, or null
//   side     : 'CE' | 'PE' of the candidate fire
//   now      : current time in ms
//   cooldown : minimum gap in ms between two alerts of the SAME side
//
// Returns true when the candidate should fire. A different side always fires.
function shouldFireAfterCooldown(last, side, now, cooldownMs) {
    if (!side) return false;
    if (!last || !last.side || !Number.isFinite(last.at)) return true;
    if (last.side !== side) return true;
    if (!Number.isFinite(now) || !(cooldownMs > 0)) return true;
    return (now - last.at) >= cooldownMs;
}

module.exports = { shouldFireAfterCooldown };