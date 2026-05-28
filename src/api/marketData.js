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

// ── Nifty price — memory-first ────────────────────────────────────────────────
async function fetchNiftyData() {
    try {
        // ── Source 1: In-memory candles from WebSocket ────────────────────────
        const memCandles = getCandleHistory();
        if (memCandles && memCandles.length >= 5) {
            const last      = memCandles[memCandles.length - 1];
            const prev      = memCandles[memCandles.length - 2];
            const price     = parseFloat(last.close.toFixed(2));
            const prevClose = parseFloat(prev.close.toFixed(2));
            const change    = parseFloat((price - prevClose).toFixed(2));
            const changePct = prevClose > 0 ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
            const closes    = memCandles.map(c => parseFloat(c.close.toFixed(2)));
            console.log(`NIFTY(memory): ${price} | Candles: ${memCandles.length}`);
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