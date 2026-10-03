// ── Bitcoin options liquidity assessment (3 Oct) ─────────────────────────
// BTC trades 24x7 but liquidity thins out on weekends (US desks and most
// market-makers are away), which widens option bid-ask spreads — a wide
// spread is a hidden cost paid on entry AND exit. Rather than guessing from
// the calendar alone, this measures the REAL bid-ask spread of the ATM option
// the signal would actually buy (Delta Exchange's own quotes), and uses the
// weekend flag only as an extra caution label.
//
// All functions are PURE (no I/O, clock passed in) so they can be unit-tested.
//
// "Weekend" = Saturday 00:00 UTC → Sunday 23:59 UTC (Sat 05:30 IST → Mon 05:29
// IST). UTC is used because that is when crypto liquidity genuinely follows
// the Western trading calendar.
//
// Thresholds are STARTING VALUES, not validated against this app's own data
// (there is none yet). Override via env vars; tune using
// /api/bitcoin-weekend-split once enough weekend fires have accumulated.
//   BTC_SPREAD_THIN_PCT  (default 3)  spread% above this → THIN   (alert sent with warning)
//   BTC_SPREAD_BLOCK_PCT (default 6)  spread% above this → BLOCK  (alert suppressed, still tracked)
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : d; };

function thresholds(env = process.env) {
    const thin  = num(env.BTC_SPREAD_THIN_PCT, 3);
    const block = Math.max(num(env.BTC_SPREAD_BLOCK_PCT, 6), thin); // block can never be below thin
    return { thin, block };
}

function isBitcoinWeekendThin(now = new Date()) {
    const d = now.getUTCDay(); // 0=Sun … 6=Sat
    return d === 0 || d === 6;
}

// quote = { bid, ask } for the specific option. Returns spread as % of mid.
function spreadPct(bid, ask) {
    if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
    const mid = (bid + ask) / 2;
    return mid > 0 ? ((ask - bid) / mid) * 100 : null;
}

// chain = marketState.bitcoin.pcr (from fetchDeltaOptionChain), direction = 'BULLISH'|'BEARISH'.
// Bullish signal → buys CE, bearish → buys PE (same convention as the whole app).
function assessBitcoinLiquidity(chain, direction, now = new Date(), env = process.env) {
    const weekend = isBitcoinWeekendThin(now);
    const { thin, block } = thresholds(env);
    const base = { weekend, spreadPct: null, level: 'UNKNOWN', reason: null, thin, block };

    const q = direction === 'BULLISH' ? chain?.atmCEquote : direction === 'BEARISH' ? chain?.atmPEquote : null;
    if (!chain || !q) {
        return { ...base, reason: 'ATM option quote not available — liquidity unverified' };
    }
    // One-sided or empty book = no real market to trade into.
    if (!(q.bid > 0) || !(q.ask > 0)) {
        return { ...base, level: 'BLOCK', reason: 'No two-sided market on ATM option (bid or ask missing)' };
    }
    const sp = spreadPct(q.bid, q.ask);
    if (sp === null) return { ...base, reason: 'Invalid ATM quote — liquidity unverified' };
    const rounded = Math.round(sp * 10) / 10;
    if (sp > block) return { ...base, spreadPct: rounded, level: 'BLOCK', reason: `ATM bid-ask spread ${rounded}% > ${block}% limit` };
    if (sp > thin)  return { ...base, spreadPct: rounded, level: 'THIN',  reason: `ATM bid-ask spread ${rounded}% > ${thin}% (wide)` };
    return { ...base, spreadPct: rounded, level: 'OK', reason: null };
}

// One-line Telegram block (HTML) describing the liquidity state.
function liquidityLine(a) {
    const wk = a.weekend ? '🌙 <b>WEEKEND</b> — thin liquidity hours. ' : '';
    if (a.level === 'OK')      return `💧 <b>Liquidity:</b> ${wk}ATM spread ${a.spreadPct}% (OK)`;
    if (a.level === 'THIN')    return `⚠️ <b>Liquidity THIN:</b> ${wk}${a.reason}. Limit order only, size half.`;
    if (a.level === 'UNKNOWN') return `❔ <b>Liquidity:</b> ${wk}${a.reason}`;
    return `⛔ <b>Liquidity BLOCK:</b> ${a.reason}`;
}

module.exports = { isBitcoinWeekendThin, spreadPct, assessBitcoinLiquidity, liquidityLine, thresholds };
