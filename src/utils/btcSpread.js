// ── Bitcoin defined-risk spread tracking helpers (3 Oct) ─────────────────
// Tracks what a DEFINED-RISK vertical spread would have done on each Bitcoin
// signal, instead of buying a single naked option:
//   BULLISH → Bull Call Spread : buy CE at the locked strike, sell CE further OTM
//   BEARISH → Bear Put Spread  : buy PE at the locked strike, sell PE further OTM
// Max loss = net debit paid. Max profit = strike width − debit.
//
// Pricing is EXECUTABLE, not last-traded: you pay the ask on the long leg and
// receive the bid on the short leg at entry; at exit you sell the long at the
// bid and buy back the short at the ask. So wide (weekend) spreads show up
// directly as worse results — which is the point. NOTE: this is stricter than
// the app's single-leg numbers, which use last-traded price, so the two are not
// apples-to-apples (the single-leg figures are flattered by ignoring bid-ask).
//
// All functions are PURE (they take the quotes map), so they are unit-testable.
// quotes shape (from fetchDeltaOptionChain): { "<strike>": { CE:{bid,ask}|null, PE:{bid,ask}|null } }

const SPREAD_WIN_THRESHOLD_PCT = 10; // same ±10% as the app's single-leg premium result

function sideFor(direction) { return direction === 'BULLISH' ? 'CE' : direction === 'BEARISH' ? 'PE' : null; }

// Pick the short-leg strike: `steps` listed strikes further out-of-the-money than
// the long strike, among strikes that currently have a two-sided quote.
// BULLISH (calls): higher strikes. BEARISH (puts): lower strikes.
function pickShortStrike(quotes, direction, longStrike, steps = 2) {
    const side = sideFor(direction);
    if (!side || !quotes || !(longStrike > 0)) return null;
    const n = Math.max(1, Math.floor(steps) || 1);
    const strikes = Object.keys(quotes)
        .map(Number)
        .filter(k => Number.isFinite(k) && quotes[String(k)]?.[side]?.bid > 0 && quotes[String(k)]?.[side]?.ask > 0);
    const out = direction === 'BULLISH'
        ? strikes.filter(k => k > longStrike).sort((a, b) => a - b)
        : strikes.filter(k => k < longStrike).sort((a, b) => b - a);
    return out.length >= n ? out[n - 1] : null;
}

// Entry net debit = pay ask on long, receive bid on short. null when either leg
// has no usable quote, or the numbers are economically impossible
// (debit <= 0, or debit >= strike width, which would be a guaranteed loss/arb error).
function spreadEntryDebit(quotes, direction, longStrike, shortStrike) {
    const side = sideFor(direction);
    const L = quotes?.[String(longStrike)]?.[side], S = quotes?.[String(shortStrike)]?.[side];
    if (!(L?.ask > 0) || !(S?.bid > 0)) return null;
    const debit = L.ask - S.bid;
    const width = Math.abs(shortStrike - longStrike);
    if (!(debit > 0) || !(width > 0) || debit >= width) return null;
    return debit;
}

// Exit value = sell long at bid, buy back short at ask. null if the long has no
// bid or the short has no ask (can't price the close — an honest gap, not a guess).
// Floored at 0 (a spread can't be worth less than nothing if held to expiry) and
// capped at the strike width (its maximum possible value).
function spreadExitValue(quotes, direction, longStrike, shortStrike) {
    const side = sideFor(direction);
    const L = quotes?.[String(longStrike)]?.[side], S = quotes?.[String(shortStrike)]?.[side];
    if (!(L?.bid > 0) || !(S?.ask > 0)) return null;
    const width = Math.abs(shortStrike - longStrike);
    return Math.min(width, Math.max(0, L.bid - S.ask));
}

function spreadOutcome(entryDebit, exitValue) {
    if (!(entryDebit > 0) || exitValue === null || exitValue === undefined || !Number.isFinite(exitValue)) return null;
    const pct = ((exitValue - entryDebit) / entryDebit) * 100;
    const result = pct >= SPREAD_WIN_THRESHOLD_PCT ? 'WIN' : pct <= -SPREAD_WIN_THRESHOLD_PCT ? 'LOSS' : 'FLAT';
    return { pct, result };
}

module.exports = { pickShortStrike, spreadEntryDebit, spreadExitValue, spreadOutcome, sideFor, SPREAD_WIN_THRESHOLD_PCT };
