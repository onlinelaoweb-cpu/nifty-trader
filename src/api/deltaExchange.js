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

// ── Circuit breaker (27 Sep, audit fix) ──────────────────────────────────────
// Matches the failStreak/backoffUntil pattern already used for Angel calls
// in breadth.js and volumeScanner.js. Before this fix, Delta Exchange had
// none: fetchDeltaTicker alone is called every 1s (fast tick) plus again
// every 60s (refreshBitcoin), with no circuit breaker anywhere. If Railway's
// IP is ever rate-limited or blocked by Delta — the same failure class
// already hit repeatedly with NSE/Angel from this exact server — every
// function below would keep retrying every single second forever, spamming
// logs and never easing up. Shared across all 4 exported functions since
// they all hit the same host/IP — one block affects all of them together.
// Tracked on genuine request failures (network error, timeout, non-2xx —
// which is exactly how a 429 rate-limit response would surface, since axios
// throws on non-2xx by default), not on a clean success:false JSON reply,
// which can be a normal API-level response rather than a connectivity block.
const _delta = { failStreak: 0, backoffUntil: 0 };

function deltaBackoffActive() {
    return Date.now() < _delta.backoffUntil;
}
function deltaRecordSuccess() {
    _delta.failStreak = 0;
    _delta.backoffUntil = 0;
}
function deltaRecordFailure(label) {
    _delta.failStreak++;
    if (_delta.failStreak >= 3) {
        _delta.backoffUntil = Date.now() + 30 * 60 * 1000; // 30 min — same duration as the established Angel pattern
        console.warn(`[Delta] ${label} failed (streak ${_delta.failStreak}) — backing off 30 min, all Delta Exchange calls paused`);
    } else {
        console.warn(`[Delta] ${label} failed (streak ${_delta.failStreak}/3)`);
    }
}

// Fetch the live ticker for a single product symbol (e.g. 'BTCUSD' for the
// perpetual, or a specific option symbol like 'C-BTC-90000-310125').
// Public endpoint — no auth. Returns null on any failure rather than
// throwing, matching this codebase's established fetch-function pattern.
async function fetchDeltaTicker(symbol) {
    if (deltaBackoffActive()) return null;
    try {
        const res = await axios.get(`${DELTA_BASE}/v2/tickers/${symbol}`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'vardaan-ai-node' },
            timeout: 10_000,
        });
        if (!res.data?.success || !res.data?.result) return null;
        const t = res.data.result;
        deltaRecordSuccess();
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
        deltaRecordFailure('fetchDeltaTicker');
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
    if (deltaBackoffActive()) return null;
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
        deltaRecordSuccess();
        return `${dd}-${mm}-${yyyy}`;
    } catch (e) {
        deltaRecordFailure('getNearestBTCExpiry');
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
    if (deltaBackoffActive()) return null;
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

        deltaRecordSuccess();
        return { pcr, callOi, putOi, atmStrike, atmCEpremium, atmPEpremium, expiry: expiryDateDDMMYYYY, rowCount: rows.length };
    } catch (e) {
        deltaRecordFailure('fetchDeltaOptionChain');
        console.warn('[Delta] fetchDeltaOptionChain error:', e.response?.status || e.message);
        return null;
    }
}

// Fetch historical 1m OHLCV candles for warm-starting candles1m after a
// restart — without this, RSI/EMA/ADX would need to rebuild purely from
// live polls (60s cadence), taking 15-60+ minutes after every restart
// before any indicator is ready, unlike NIFTY/Crude which warm-start from
// Yahoo/DB history immediately at boot. Endpoint confirmed via Delta's own
// published API guide (cdn.india.deltaex.org/v2/history/candles); public,
// no auth needed. start/end are UNIX seconds.
async function fetchDeltaHistoricalCandles(symbol, resolution, startUnixSec, endUnixSec) {
    if (deltaBackoffActive()) return null;
    try {
        const res = await axios.get('https://cdn.india.deltaex.org/v2/history/candles', {
            params: { resolution, symbol, start: startUnixSec, end: endUnixSec },
            headers: { 'Accept': 'application/json', 'User-Agent': 'vardaan-ai-node' },
            timeout: 15_000,
        });
        if (!res.data?.success || !Array.isArray(res.data?.result)) return null;
        const candles = res.data.result
            .map(c => ({
                time: c.time, open: parseFloat(c.open), high: parseFloat(c.high),
                low: parseFloat(c.low), close: parseFloat(c.close), volume: parseFloat(c.volume || 0),
            }))
            .filter(c => !isNaN(c.close) && c.close > 0)
            .sort((a, b) => a.time - b.time); // chronological order
        deltaRecordSuccess();
        return candles;
    } catch (e) {
        deltaRecordFailure('fetchDeltaHistoricalCandles');
        console.warn('[Delta] fetchDeltaHistoricalCandles error:', e.response?.status || e.message);
        return null;
    }
}

// Moved to the end (was previously above fetchDeltaHistoricalCandles's own
// definition — harmless due to function hoisting, but confusing to read;
// cosmetic fix, no behavior change).
module.exports = { fetchDeltaTicker, getNearestBTCExpiry, fetchDeltaOptionChain, fetchDeltaHistoricalCandles };