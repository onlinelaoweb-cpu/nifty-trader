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

// lock = { strike, premium }   grid = { name, slPct, breakevenAt, halfBookAt, fullExitAt }
// returns the HTML text block, or null when there is nothing trustworthy to show
function buildTriggerPlanBlock({ direction, lock, grid, msg }) {
    if (!lock || !grid) return null;
    const entry = Number(lock.premium), strike = Number(lock.strike);
    if (!(entry > 0) || !(strike > 0)) return null;
    if (alreadyHasPlan(msg)) return null;
    const side = direction === 'BULLISH' ? 'CE' : direction === 'BEARISH' ? 'PE' : null;
    if (!side) return null;
    const at = pct => r2(entry * (1 + pct / 100));
    const sl = at(grid.slPct);
    const zoneLow = r2(entry * 0.96), zoneHigh = r2(entry * 1.02), chase = r2(entry * 1.10);
    return [
        `🎯 <b>${fmtStrike(strike)} ${side}</b> · entry ~₹${r2(entry)} (zone ₹${zoneLow}–${zoneHigh}, don't chase above ₹${chase})`,
        `🛑 SL ₹${sl} (${grid.slPct}%) · BE ₹${at(grid.breakevenAt)} (+${grid.breakevenAt}%) · book 50% ₹${at(grid.halfBookAt)} (+${grid.halfBookAt}%) · full ₹${at(grid.fullExitAt)} (+${grid.fullExitAt}%)`,
        `<i>Paper plan: ATM at fire time + ${grid.name} Trade-Coach grid — the trigger itself defines no SL/target. Premium is the last chain price, so a real fill can differ.</i>`,
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