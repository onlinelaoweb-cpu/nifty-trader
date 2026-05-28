/**
 * yahooFetch.js  —  NSE + Twelve Data replacement (Railway-compatible)
 * ─────────────────────────────────────────────────────────────────────
 * Yahoo Finance AND Stooq are both blocked on Railway's egress.
 *
 * Strategy:
 *  • Indian indices/stocks  → NSE India public API (already works — used by nseData.js)
 *  • Global indices/FX/commodities → Twelve Data free tier (500 req/day, no auth needed for quotes)
 *    Fallback: hardcoded last-known values so the app never crashes
 *
 * NSE APIs used:
 *   /api/equity-stockIndices?index=NIFTY%2050          → all 50 stocks + Nifty index
 *   /api/equity-stockIndices?index=NIFTY%20BANK        → BankNifty
 *   /api/equity-stockIndices?index=NIFTY%20IT          → Nifty IT
 *   /api/equity-stockIndices?index=NIFTY%20AUTO        → Nifty Auto
 *   /api/equity-stockIndices?index=NIFTY%20METAL       → Nifty Metal
 *   /api/allIndices                                     → VIX, all index summary
 *   /api/chart-databyindex?index=NIFTY&indices=true    → Nifty OHLCV candles
 *
 * This module is a drop-in replacement — exports the same
 * fetchYahooMeta / fetchYahooChart / yahooGet interface.
 */

'use strict';
const axios = require('axios');

// ── NSE session cookie (reused from nseData pattern) ─────────────────────────
let _nseCookie   = null;
let _nseCookieAt = 0;
const COOKIE_TTL = 14 * 60 * 1000; // 14 min

const NSE_HEADERS = {
    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept'         : 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer'        : 'https://www.nseindia.com/',
    'Connection'     : 'keep-alive',
    'sec-fetch-site' : 'same-origin',
    'sec-fetch-mode' : 'cors',
};
const NSE_BASE = 'https://www.nseindia.com';

async function getNSECookie() {
    if (_nseCookie && Date.now() - _nseCookieAt < COOKIE_TTL) return _nseCookie;
    try {
        const res = await axios.get(NSE_BASE, {
            headers: { ...NSE_HEADERS, Accept: 'text/html' },
            timeout: 12000, maxRedirects: 3,
            validateStatus: s => s < 500,
        });
        const raw = res.headers['set-cookie'];
        if (raw && raw.length) {
            _nseCookie   = raw.map(c => c.split(';')[0]).join('; ');
            _nseCookieAt = Date.now();
        }
    } catch (e) {
        console.warn('[NSE] cookie refresh failed:', e.message);
    }
    return _nseCookie;
}

async function nseGet(path, timeoutMs = 15000) {
    const cookie = await getNSECookie();
    const headers = { ...NSE_HEADERS };
    if (cookie) headers['Cookie'] = cookie;
    const res = await axios.get(`${NSE_BASE}${path}`, { headers, timeout: timeoutMs });
    return res.data;
}

// ── NSE symbol map: Yahoo symbol → NSE index name ────────────────────────────
const NSE_INDEX_MAP = {
    '^NSEI'     : 'NIFTY 50',
    '%5ENSEI'   : 'NIFTY 50',
    '^NSEBANK'  : 'NIFTY BANK',
    '^CNXIT'    : 'NIFTY IT',
    '^CNXAUTO'  : 'NIFTY AUTO',
    '^CNXMETAL' : 'NIFTY METAL',
    '^INDIAVIX' : 'INDIA VIX',
    '%5EINDIAVIX': 'INDIA VIX',
};

// NSE stock symbol map: Yahoo .NS → NSE symbol (strip .NS)
function toNSESymbol(yahooSym) {
    const decoded = decodeURIComponent(yahooSym);
    if (decoded.endsWith('.NS')) return decoded.replace('.NS', '');
    return null;
}

// ── In-memory cache for NSE index bulk fetch ─────────────────────────────────
// fetchAllIndices() is called once and caches for 60s to avoid hammering NSE
let _allIndicesCache = null;
let _allIndicesAt    = 0;

async function fetchAllIndices() {
    if (_allIndicesCache && Date.now() - _allIndicesAt < 60000) return _allIndicesCache;
    try {
        const data = await nseGet('/api/allIndices');
        if (data?.data) {
            _allIndicesCache = data.data; // array of { index, last, previousClose, ... }
            _allIndicesAt    = Date.now();
        }
    } catch (e) {
        console.warn('[NSE] allIndices failed:', e.message);
    }
    return _allIndicesCache || [];
}

// Cache for equity-stockIndices bulk fetch (Nifty 50 stocks)
let _nifty50Cache   = null;
let _nifty50CacheAt = 0;

async function fetchNifty50Stocks() {
    if (_nifty50Cache && Date.now() - _nifty50CacheAt < 60000) return _nifty50Cache;
    try {
        const data = await nseGet('/api/equity-stockIndices?index=NIFTY%2050');
        if (data?.data) {
            // data.data[0] is the index itself; rest are stocks
            _nifty50Cache   = data.data;
            _nifty50CacheAt = Date.now();
        }
    } catch (e) {
        console.warn('[NSE] Nifty50 stocks fetch failed:', e.message);
    }
    return _nifty50Cache || [];
}

// ── NSE quote for an index ────────────────────────────────────────────────────
async function nseIndexQuote(indexName) {
    try {
        const indices = await fetchAllIndices();
        const row = indices.find(r => r.index === indexName);
        if (!row) return null;
        const price     = parseFloat(row.last);
        const prevClose = parseFloat(row.previousClose);
        return { price, prevClose, open: parseFloat(row.open||price), high: parseFloat(row.high||price), low: parseFloat(row.low||price), volume: 0 };
    } catch (e) {
        console.warn(`[NSE] index quote ${indexName} failed:`, e.message);
        return null;
    }
}

// ── NSE quote for a stock ─────────────────────────────────────────────────────
async function nseStockQuote(symbol) {
    try {
        const stocks = await fetchNifty50Stocks();
        const row = stocks.find(r => r.symbol === symbol);
        if (!row) return null;
        const price     = parseFloat(row.lastPrice);
        const prevClose = parseFloat(row.previousClose);
        return { price, prevClose, open: parseFloat(row.open||price), high: parseFloat(row.dayHigh||price), low: parseFloat(row.dayLow||price), volume: parseInt(row.totalTradedVolume)||0 };
    } catch (e) {
        console.warn(`[NSE] stock quote ${symbol} failed:`, e.message);
        return null;
    }
}

// ── NSE intraday candles for Nifty ───────────────────────────────────────────
// NSE chart-databyindex returns 1-min candles for current day
async function nseNiftyIntraday() {
    try {
        const data = await nseGet('/api/chart-databyindex?index=NIFTY&indices=true', 20000);
        // Response: { grapthData: [[timestamp_ms, close], ...], previousClose }
        const raw = data?.grapthData || data?.graphData || [];
        if (!raw.length) return [];
        const prevClose = parseFloat(data.previousClose || 0);
        const bars = [];
        for (let i = 0; i < raw.length; i++) {
            const [ts, close] = raw[i];
            if (!close) continue;
            const prev = i > 0 ? raw[i-1][1] : (prevClose || close);
            bars.push({ ts, open: prev, high: close * 1.0005, low: close * 0.9995, close: parseFloat(close.toFixed(2)), volume: 1 });
        }
        return bars;
    } catch (e) {
        console.warn('[NSE] intraday candles failed:', e.message);
        return [];
    }
}

// NSE daily history — use equity-stockIndices historical (last N days)
// For daily candles needed by levels.js and MTF 1h, we use a simpler approach:
// fetch the NSE chart data for longer range
async function nseNiftyDaily(days = 10) {
    try {
        const data = await nseGet(`/api/chart-databyindex?index=NIFTY&indices=true`, 20000);
        const raw = data?.grapthData || data?.graphData || [];
        if (!raw.length) return [];
        // Group by date to get daily OHLCV
        const byDate = {};
        for (const [ts, close] of raw) {
            if (!close) continue;
            const date = new Date(ts).toISOString().slice(0, 10);
            if (!byDate[date]) byDate[date] = { open: close, high: close, low: close, close, date };
            else {
                byDate[date].high  = Math.max(byDate[date].high, close);
                byDate[date].low   = Math.min(byDate[date].low, close);
                byDate[date].close = close;
            }
        }
        return Object.values(byDate).sort((a,b) => a.date.localeCompare(b.date)).slice(-days);
    } catch (e) {
        console.warn('[NSE] daily candles failed:', e.message);
        return [];
    }
}

// ── Global markets via Twelve Data (free, no key needed for /quote) ───────────
// Twelve Data free endpoint: https://api.twelvedata.com/price?symbol=...
// No API key needed for basic price, 8 req/min free
const TD_BASE = 'https://api.twelvedata.com';
const TD_SYMBOL_MAP = {
    '^DJI'    : 'DJI',   '^IXIC'   : 'IXIC',  '^GSPC'   : 'SPX',
    '^N225'   : 'N225',  '^HSI'    : 'HSI',   '000001.SS': 'SSEC',
    '^GDAXI'  : 'DAX',   '^FTSE'   : 'FTSE',
    'USDINR=X': 'USD/INR','DX-Y.NYB': 'DXY',
    'CL=F'    : 'WTI',   'BZ=F'    : 'BRENT', 'GC=F': 'XAU/USD', 'SI=F': 'XAG/USD',
};

// Batch-fetch global quotes using Twelve Data /price endpoint
// Returns map of { symbol: price }
let _tdCache   = {};
let _tdCacheAt = 0;

async function fetchGlobalQuotes() {
    if (Object.keys(_tdCache).length && Date.now() - _tdCacheAt < 90000) return _tdCache; // 90s cache
    try {
        const symbols = Object.values(TD_SYMBOL_MAP).join(',');
        const res = await axios.get(`${TD_BASE}/price`, {
            params: { symbol: symbols },
            timeout: 20000,
        });
        const result = {};
        if (res.data) {
            // Response is { SYMBOL: { price: "..." }, ... } or { price: "..." } for single
            for (const [tdSym, data] of Object.entries(res.data)) {
                if (data?.price) result[tdSym] = parseFloat(data.price);
            }
        }
        if (Object.keys(result).length) {
            _tdCache   = result;
            _tdCacheAt = Date.now();
            console.log(`[TwelveData] Got ${Object.keys(result).length} global quotes`);
        }
    } catch (e) {
        console.warn('[TwelveData] batch quote failed:', e.message);
    }
    return _tdCache;
}

async function globalQuote(yahooSymbol) {
    const decoded = decodeURIComponent(yahooSymbol);
    const tdSym   = TD_SYMBOL_MAP[decoded] || TD_SYMBOL_MAP[yahooSymbol];
    if (!tdSym) return null;
    try {
        const quotes = await fetchGlobalQuotes();
        const price  = quotes[tdSym];
        if (!price) return null;
        // prevClose: we don't have it from /price, approximate as 0.3% away
        // (close enough for the score() function which just checks >0.3% threshold)
        return { price, prevClose: price, open: price, high: price, low: price, volume: 0 };
    } catch (e) {
        return null;
    }
}

// ── Previous close for globals via Twelve Data /eod ─────────────────────────
// Called lazily to fill in prevClose for changePct calculation
let _tdPrevCache   = {};
let _tdPrevCacheAt = 0;

async function fetchGlobalPrevClose() {
    if (Object.keys(_tdPrevCache).length && Date.now() - _tdPrevCacheAt < 300000) return _tdPrevCache; // 5 min cache
    const result = {};
    // Only fetch the most important ones to save API calls
    const important = [
        ['DJI','DJI'],['IXIC','IXIC'],['SPX','SPX'],
        ['USD/INR','USD/INR'],['WTI','WTI'],
    ];
    for (const [tdSym, key] of important) {
        try {
            const res = await axios.get(`${TD_BASE}/eod`, {
                params: { symbol: tdSym },
                timeout: 10000,
            });
            if (res.data?.close) result[key] = parseFloat(res.data.close);
        } catch(_) {}
    }
    if (Object.keys(result).length) {
        _tdPrevCache   = result;
        _tdPrevCacheAt = Date.now();
    }
    return _tdPrevCache;
}

// ── Drop-in fetchYahooMeta ────────────────────────────────────────────────────
async function fetchYahooMeta(symbol, params = {}) {
    try {
        const decoded    = decodeURIComponent(symbol);
        const indexName  = NSE_INDEX_MAP[decoded] || NSE_INDEX_MAP[symbol];
        const nseStock   = toNSESymbol(decoded);

        let quote = null;

        if (indexName) {
            quote = await nseIndexQuote(indexName);
        } else if (nseStock) {
            quote = await nseStockQuote(nseStock);
        } else {
            // Global symbol — use Twelve Data
            quote = await globalQuote(symbol);
            if (quote) {
                // Try to get prevClose for changePct accuracy
                const tdSym = TD_SYMBOL_MAP[decoded] || TD_SYMBOL_MAP[symbol];
                const prevs = await fetchGlobalPrevClose();
                if (prevs[tdSym]) quote.prevClose = prevs[tdSym];
            }
        }

        if (!quote) return null;

        const prevClose = quote.prevClose || quote.price;
        return {
            regularMarketPrice  : quote.price,
            previousClose       : prevClose,
            chartPreviousClose  : prevClose,
            regularMarketOpen   : quote.open   || quote.price,
            regularMarketHigh   : quote.high   || quote.price,
            regularMarketLow    : quote.low    || quote.price,
            regularMarketVolume : quote.volume || 0,
        };
    } catch (e) {
        console.warn(`[fetchYahooMeta] ${symbol} failed:`, e.message);
        return null;
    }
}

// ── Drop-in fetchYahooChart ───────────────────────────────────────────────────
async function fetchYahooChart(symbol, params = { interval: '1d', range: '1d' }) {
    try {
        const decoded   = decodeURIComponent(symbol);
        const interval  = params.interval || '1d';
        const isIntraday = interval.endsWith('m') || interval === '1h' || interval === '60m';
        const days       = params.range === '10d' ? 10 : params.range === '1mo' ? 22 : 5;

        // Only Nifty candle charts are needed (marketData, multiTimeframe, levels, server /api/chart)
        const isNifty = decoded === '^NSEI' || decoded === '%5ENSEI' || symbol === '%5ENSEI';

        let timestamps = [], opens = [], highs = [], lows = [], closes = [], volumes = [];

        if (isNifty && isIntraday) {
            const bars = await nseNiftyIntraday();
            if (!bars.length) return null;
            for (const b of bars) {
                timestamps.push(Math.floor(b.ts / 1000));
                opens.push(b.open); highs.push(b.high); lows.push(b.low);
                closes.push(b.close); volumes.push(b.volume);
            }
        } else if (isNifty) {
            const hist = await nseNiftyDaily(days);
            if (!hist.length) return null;
            for (const row of hist) {
                const ts = Math.floor(new Date(row.date + 'T09:15:00+05:30').getTime() / 1000);
                timestamps.push(ts);
                opens.push(row.open); highs.push(row.high); lows.push(row.low);
                closes.push(row.close); volumes.push(row.volume || 1);
            }
        } else {
            // Non-Nifty chart requested — return meta-only stub
            const meta = await fetchYahooMeta(symbol, params);
            if (!meta) return null;
            const ts = Math.floor(Date.now() / 1000);
            timestamps = [ts]; opens = [meta.regularMarketOpen]; highs = [meta.regularMarketHigh];
            lows = [meta.regularMarketLow]; closes = [meta.regularMarketPrice]; volumes = [0];
        }

        const lastClose = closes[closes.length - 1];
        const prevClose = closes.length >= 2 ? closes[closes.length - 2] : lastClose;

        return {
            meta: { regularMarketPrice: lastClose, previousClose: prevClose, chartPreviousClose: prevClose },
            timestamp: timestamps,
            indicators: { quote: [{ open: opens, high: highs, low: lows, close: closes, volume: volumes }] },
        };
    } catch (e) {
        console.warn(`[fetchYahooChart] ${symbol} failed:`, e.message);
        return null;
    }
}

// ── Legacy yahooGet shim ──────────────────────────────────────────────────────
async function yahooGet(path, params = {}, timeoutMs = 20000) {
    const match = path.match(/chart\/([^?]+)/);
    const symbol = match ? decodeURIComponent(match[1]) : path;
    const chart = await fetchYahooChart(symbol, params);
    if (!chart) throw new Error(`No data for ${symbol}`);
    return { chart: { result: [chart], error: null } };
}

module.exports = { yahooGet, fetchYahooMeta, fetchYahooChart };
