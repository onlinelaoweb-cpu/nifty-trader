'use strict';
// ── Trigger plan block for live Telegram alerts (10 Oct) ──────────────────────
// Exploratory triggers have no strike / SL / target of their own. For a LIVE alert only, show what a paper trader would
// have used: the ATM strike locked at fire time + the instrument's Trade-Coach grid (SL, breakeven, half-book, full exit).
// Display only. Nothing here changes whether an alert is sent, muted, digested or tracked.
// Pure function (no DB, no clock, no network).

const r2 = x => Math.round(x * 100) / 100;
const fmtStrike = v => Number(v) >= 1000 ? Math.round(Number(v)).toLocaleString('en-IN') : String(Number(v));

// msg already carries its own SL / stop-loss plan (Classic, some Murarka texts) -> do not show a second, different one
function alreadyHasPlan(msg) {
    return /\bSL\b|stop[\s-]?loss/i.test(String(msg || ''));
}

// lock = { strike, premium }   grid = { name, slPct, breakevenAt, halfBookAt, fullExitAt }   opts: { instrument, trailPts }
// All levels are shown as option-premium RUPEE values worked out from the exact entry premium (no percentages).
// Mapping from the instrument's Trade-Coach grid:  SL = slPct   |   T1 = breakeven trigger (move SL to cost)   |   Half book = halfBookAt
//   T2 = halfway between half-book and final   |   T3 / Final = fullExitAt (the app's tested full exit)
// Trailing SL: at T1 the SL moves to the entry price; after the half-book it trails `trailPts` percentage points of the entry premium
// below the peak (the same rule the Auto Journal uses; trailPts 0 hides that clause).
// returns the HTML text block, or null when there is nothing trustworthy to show
function buildTriggerPlanBlock({ direction, lock, grid, msg, instrument, trailPts = 10 }) {
    if (!lock || !grid) return null;
    const entry = Number(lock.premium), strike = Number(lock.strike);
    if (!(entry > 0) || !(strike > 0)) return null;
    if (alreadyHasPlan(msg)) return null;
    const side = direction === 'BULLISH' ? 'CE' : direction === 'BEARISH' ? 'PE' : null;
    if (!side) return null;
    const tickRounded = instrument === 'NIFTY' || instrument === 'CRUDE';
    const rnd = v => (tickRounded ? Math.round(v / 0.05) * 0.05 : v);
    const fmt = v => String(r2(rnd(v)));
    const at = pct => entry * (1 + pct / 100);
    const entryTxt = fmt(entry);
    const t2 = (grid.halfBookAt + grid.fullExitAt) / 2;
    const trail = trailPts > 0 ? ` · after the half-book trail ₹${fmt(entry * trailPts / 100)} below the peak` : '';
    return [
        `🎯 <b>${fmtStrike(strike)} ${side}</b> · Entry ₹${entryTxt} (zone ₹${fmt(entry * 0.96)}–${fmt(entry * 1.02)}, don't chase above ₹${fmt(entry * 1.10)})`,
        `🛑 SL ₹${fmt(at(grid.slPct))}`,
        `🔒 Trailing SL: at ₹${fmt(at(grid.breakevenAt))} move SL to ₹${entryTxt} (cost)${trail}`,
        `📗 Half book (sell half) ₹${fmt(at(grid.halfBookAt))}`,
        `🎯 T1 ₹${fmt(at(grid.breakevenAt))} · T2 ₹${fmt(at(t2))} · T3 / Final ₹${fmt(at(grid.fullExitAt))}`,
        `<i>Paper plan: ATM at fire time + ${grid.name} Trade-Coach rules — the trigger itself defines no SL/target. Entry is the last chain price, so a real fill can differ.</i>`,
    ].join('\n');
}

// put block just above the last <i>footer</i> line, or at the end when there is none
function insertBeforeFooter(msg, block) {
    if (!block) return msg;
    const parts = String(msg).split('\n');
    const idx = parts.map(l => l.trim().startsWith('<i>')).lastIndexOf(true);
    return idx >= 0 ? [...parts.slice(0, idx), block, ...parts.slice(idx)].join('\n') : `${msg}\n${block}`;
}

module.exports = { buildTriggerPlanBlock, insertBeforeFooter, alreadyHasPlan };