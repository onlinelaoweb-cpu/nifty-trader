// ── Delta Exchange India — Bitcoin Options Data (25 Sep) ─────────────────────
// New exchange integration for the Bitcoin-options feature. Delta Exchange
// India (api.india.delta.exchange) is an FIU-registered crypto derivatives
// exchange offering CE/PE-style BTC/ETH options with INR settlement —
// genuinely the closest match to how this app already treats NIFTY/Crude
// options. ALL market-data endpoints used here (tickers, option-chain,
// products) are PUBLIC — no API key or authentication needed, confirmed
// against Delta's own docs (docs.delta.exchange). Authentication would only
// be needed for placing/managing actual orders, which this integration does
// NOT do — it is read-only market data, mirroring how the rest of this
// app's exploratory-trigger infrastructure works.
const axios = require('axios');

const DELTA_BASE = 'https://api.india.delta.exchange';

// Fetch the live ticker for a single product symbol (e.g. 'BTCUSD' for the
// perpetual, or a specific option symbol like 'C-BTC-90000-310125').
// Public endpoint — no auth. Returns null on any failure rather than
// throwing, matching this codebase's established fetch-function pattern.
async function fetchDeltaTicker(symbol) {
    try {
        const res = await axios.get(`${DELTA_BASE}/v2/tickers/${symbol}`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'vardaan-ai-node' },
            timeout: 10_000,
        });
        if (!res.data?.success || !res.data?.result) return null;
        const t = res.data.result;
        return {
            symbol: t.symbol,
            close: parseFloat(t.close),
            open: parseFloat(t.open),
            high: parseFloat(t.high),
            low: parseFloat(t.low),
            markPrice: parseFloat(t.mark_price),
            spotPrice: t.spot_price ? parseFloat(t.spot_price) : null,
            oi: t.oi ? parseFloat(t.oi) : null,
            volume: t.volume ? parseFloat(t.volume) : 0,
            bestBid: t.quotes?.best_bid ? parseFloat(t.quotes.best_bid) : null,
            bestAsk: t.quotes?.best_ask ? parseFloat(t.quotes.best_ask) : null,
            greeks: t.greeks || null,
        };
    } catch (e) {
        console.warn('[Delta] fetchDeltaTicker error:', e.response?.status || e.message);
        return null;
    }
}

// Find the nearest (soonest-expiring) LIVE BTC options expiry date, in
// DD-MM-YYYY format (Delta's own expected format for the option-chain
// query). Delta lists daily/weekly/monthly expiries simultaneously — this
// picks the earliest live one, mirroring how getCrudeOilFutureToken() picks
// the front-month crude contract elsewhere in this codebase.
async function getNearestBTCExpiry() {
    try {
        const res = await axios.get(`${DELTA_BASE}/v2/products`, {
            params: { contract_types: 'call_options,put_options', states: 'live', underlying_asset_symbols: 'BTC', page_size: 200 },
            headers: { 'Accept': 'application/json', 'User-Agent': 'vardaan-ai-node' },
            timeout: 10_000,
        });
        if (!res.data?.success || !Array.isArray(res.data?.result)) return null;
        const expiries = res.data.result
            .map(p => p.settlement_time)
            .filter(Boolean)
            .map(t => new Date(t))
            .filter(d => !isNaN(d.getTime()) && d.getTime() > Date.now());
        if (!expiries.length) return null;
        const nearest = new Date(Math.min(...expiries.map(d => d.getTime())));
        const dd = String(nearest.getDate()).padStart(2, '0');
        const mm = String(nearest.getMonth() + 1).padStart(2, '0');
        const yyyy = nearest.getFullYear();
        return `${dd}-${mm}-${yyyy}`;
    } catch (e) {
        console.warn('[Delta] getNearestBTCExpiry error:', e.response?.status || e.message);
        return null;
    }
}

// Fetch the full BTC option chain (all CE+PE strikes) for a given expiry
// (DD-MM-YYYY format, from getNearestBTCExpiry()). Public endpoint — no
// auth. Returns { pcr, callOi, putOi, atmStrike, atmCEpremium, atmPEpremium,
// rows } — same shape philosophy as fetchCrudePCR() elsewhere in this
// codebase, so downstream trigger code can follow the same pattern.
async function fetchDeltaOptionChain(expiryDateDDMMYYYY, spotPrice = null) {
    try {
        const res = await axios.get(`${DELTA_BASE}/v2/tickers`, {
            params: { contract_types: 'call_options,put_options', underlying_asset_symbols: 'BTC', expiry_date: expiryDateDDMMYYYY },
            headers: { 'Accept': 'application/json', 'User-Agent': 'vardaan-ai-node' },
            timeout: 10_000,
        });
        if (!res.data?.success || !Array.isArray(res.data?.result)) return null;
        const rows = res.data.result;
        if (!rows.length) return null;

        let callOi = 0, putOi = 0;
        for (const r of rows) {
            const oi = parseFloat(r.oi) || 0;
            if (r.contract_type === 'call_options') callOi += oi;
            else if (r.contract_type === 'put_options') putOi += oi;
        }
        const pcr = callOi > 0 ? parseFloat((putOi / callOi).toFixed(3)) : null;

        // ATM strike + premium extraction, same pattern as fetchCrudePCR's
        // own ATM CE/PE premium logic — strikes are typically in round
        // increments; find the strike closest to spot among live rows.
        let atmStrike = null, atmCEpremium = null, atmPEpremium = null;
        if (spotPrice > 0) {
            const strikes = [...new Set(rows.map(r => parseFloat(r.strike_price)).filter(s => !isNaN(s)))];
            if (strikes.length) {
                atmStrike = strikes.reduce((best, s) => Math.abs(s - spotPrice) < Math.abs(best - spotPrice) ? s : best, strikes[0]);
                for (const r of rows) {
                    if (parseFloat(r.strike_price) !== atmStrike) continue;
                    const ltp = parseFloat(r.close);
                    if (r.contract_type === 'call_options' && ltp > 0) atmCEpremium = ltp;
                    else if (r.contract_type === 'put_options' && ltp > 0) atmPEpremium = ltp;
                }
            }
        }

        return { pcr, callOi, putOi, atmStrike, atmCEpremium, atmPEpremium, expiry: expiryDateDDMMYYYY, rowCount: rows.length };
    } catch (e) {
        console.warn('[Delta] fetchDeltaOptionChain error:', e.response?.status || e.message);
        return null;
    }
}

module.exports = { fetchDeltaTicker, getNearestBTCExpiry, fetchDeltaOptionChain };
