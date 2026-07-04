'use strict';
// marketData.js — Nifty price + VIX
//
// Price source priority:
//   1. In-memory candle history (built from Angel One WebSocket ticks) — zero latency, no NSE call
//   2. NSE allIndices fallback — works from Railway, used on startup before WS warms up
//   3. NSE intraday candles — last resort, often times out from Railway US West IPs
//
// VIX: NSE allIndices (confirmed working from Railway)

const { fetchYahooMeta, fetchAllIndices } = require('./yahooFetch');
const { getCandleHistory, getSessionCandles } = require('./indicators');
const { getHistoricalCandles } = require('./historicalData');

// ── VIX from allIndices (confirmed working) ───────────────────────────────────
async function fetchVIX() {
    try {
        const indices = await fetchAllIndices();
        const row = indices.find(r => r.index === 'INDIA VIX' || r.indexSymbol === 'INDIA VIX');
        if (!row) {
            // Fallback to NSE meta endpoint
            const meta = await fetchYahooMeta('%5EINDIAVIX');
            if (!meta) return null;
            const vix = parseFloat(meta.regularMarketPrice.toFixed(2));
            const prevClose = meta.previousClose || vix;
            const change = parseFloat((vix - prevClose).toFixed(2));
            return buildVIX(vix, change, prevClose);
        }
        const vix       = parseFloat(row.last || row.previousClose);
        const prevClose = parseFloat(row.previousClose || vix);
        const change    = parseFloat((vix - prevClose).toFixed(2));
        return buildVIX(vix, change, prevClose);
    } catch (err) {
        console.error('VIX fetch error:', err.message);
        return null;
    }
}

function buildVIX(vix, change, prevClose) {
    function vixInfo(v) {
        if (v < 12) return { signal: 'VERY LOW',  note: 'Market complacent', range: 'ATM ±150' };
        if (v < 15) return { signal: 'LOW',       note: 'Normal market',     range: 'ATM ±150' };
        if (v < 20) return { signal: 'MODERATE',  note: 'Some uncertainty',  range: 'ATM ±200' };
        if (v < 25) return { signal: 'HIGH',       note: 'Elevated fear',    range: 'ATM ±250' };
        if (v < 30) return { signal: 'VERY HIGH',  note: 'Reduce qty 50%',   range: 'ATM ±300' };
        return             { signal: 'EXTREME',    note: 'Avoid trading',    range: 'AVOID'    };
    }
    const info = vixInfo(vix);
    const changePct = prevClose > 0 ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
    console.log(`VIX: ${vix} (${change >= 0 ? '+' : ''}${change}) — ${info.signal}`);
    return { vix, change, changePct, ...info };
}

// ── Real previous-trading-day close (from nifty_daily_history DB table) ──────
// FIX: the old logic used the second-to-last 1-MINUTE candle as "prevClose",
// which is really just "1 minute ago's price" — not yesterday's close. During
// live trading this gave a tiny, near-meaningless "change" (masked most of the
// time because onTick() overrides it while WS is active), and on a day the
// market never opens (weekend/holiday, frozen price) it was blatantly wrong:
// last-two-candles-in-a-frozen-buffer are nearly identical, giving "change"
// values like -0.75 instead of the real prior-session move.
// The daily_history table already stores a proper `prev_close` per row —
// this reads it with the correct logic for both live and closed markets:
//   • If the LATEST daily row is TODAY (its EOD data already committed —
//     true when viewing after today's close, e.g. evening or a later weekend
//     day) → use that row's own prev_close (yesterday vs the day before).
//   • Otherwise (still mid-session, today's row not written yet) → use the
//     latest row's close directly (that IS yesterday's close).
async function getRealPrevClose() {
    try {
        const rows = await getHistoricalCandles(2);
        if (!rows || rows.length === 0) return null;
        const latest = rows[rows.length - 1];
        const todayStr = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
            .toISOString().slice(0, 10);
        return latest.date === todayStr ? latest.prev_close : latest.close;
    } catch (e) {
        console.warn('[MarketData] getRealPrevClose failed:', e.message);
        return null;
    }
}

// ── Nifty price — memory-first ────────────────────────────────────────────────
async function fetchNiftyData() {
    try {
        // ── Source 1: In-memory candles from WebSocket ────────────────────────
        const memCandles = getCandleHistory();
        if (memCandles && memCandles.length >= 5) {
            const last      = memCandles[memCandles.length - 1];
            const price     = parseFloat(last.close.toFixed(2));
            // FIX: prevClose now from the daily-history table (real previous
            // trading day's close), not the second-to-last 1-min candle.
            const realPrevClose = await getRealPrevClose();
            const prevClose = realPrevClose > 0 ? parseFloat(realPrevClose.toFixed(2))
                                                 : parseFloat(memCandles[memCandles.length - 2].close.toFixed(2)); // fallback if DB unavailable
            const change    = parseFloat((price - prevClose).toFixed(2));
            const changePct = prevClose > 0 ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
            const closes    = memCandles.map(c => parseFloat(c.close.toFixed(2)));
            console.log(`NIFTY(memory): ${price} | Candles: ${memCandles.length} | prevClose: ${prevClose}${realPrevClose ? ' (daily-history)' : ' (fallback: prev candle)'}`);
            return { price, prevClose, change, changePct, closes, candles: memCandles };
        }

        // ── Source 2: NSE allIndices (confirmed working from Railway) ─────────
        const indices = await fetchAllIndices();
        const niftyRow = indices.find(r => r.index === 'NIFTY 50' || r.indexSymbol === 'NIFTY 50');
        if (niftyRow) {
            const price     = parseFloat(niftyRow.last || niftyRow.previousClose);
            const prevClose = parseFloat(niftyRow.previousClose || price);
            const change    = parseFloat((price - prevClose).toFixed(2));
            const changePct = prevClose > 0 ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
            console.log(`NIFTY(allIndices): ${price}`);
            // No candle history yet — return empty arrays, WS will populate later
            return { price, prevClose, change, changePct, closes: [], candles: [] };
        }

        // ── Source 3: NSE intraday (last resort — often times out on Railway) ──
        const result = await fetchYahooMeta('%5ENSEI');
        if (!result) return null;
        const price     = parseFloat(result.regularMarketPrice.toFixed(2));
        const prevClose = result.previousClose || price;
        const change    = parseFloat((price - prevClose).toFixed(2));
        const changePct = prevClose > 0 ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
        console.log(`NIFTY(NSE meta): ${price}`);
        return { price, prevClose, change, changePct, closes: [], candles: [] };

    } catch (err) {
        console.error('NIFTY fetch error:', err.message);
        return null;
    }
}

async function fetchMarketData() {
    const [niftyData, vixData] = await Promise.all([fetchNiftyData(), fetchVIX()]);
    return { niftyData, pcrData: null, vixData };
}

module.exports = { fetchMarketData };