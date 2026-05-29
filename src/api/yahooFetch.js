/**
 * yahooFetch.js  —  NSE-only replacement (Railway-compatible)
 * ─────────────────────────────────────────────────────────────────────
 * Yahoo Finance, Stooq, and Twelve Data are all blocked/require keys on Railway.
 *
 * Strategy:
 *  • ALL Indian data (Nifty, VIX, BankNifty, IT, Auto, Metal, all 50 stocks,
 *    candles, SR levels, MTF) → NSE India public API (proven to work)
 *  • Global indices (Dow, NASDAQ, Crude, Gold etc.) → return null gracefully
 *    The scoring system already handles nulls as 0 — app loads fine, just
 *    shows "Mixed global signals" instead of a directional bias.
 *    (When a real free global API is available it can be wired in here.)
 *
 * Exports same interface: fetchYahooMeta / fetchYahooChart / yahooGet
 */

'use strict';
const axios = require('axios');

// ── NSE session cookie ────────────────────────────────────────────────────────
let _nseCookie   = null;
let _nseCookieAt = 0;
const COOKIE_TTL = 14 * 60 * 1000;

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

// ── Cookie fetch — serialised so parallel startup calls don't all hit NSE at once
let _cookieFetchPromise = null;

async function getNSECookie() {
    if (_nseCookie && Date.now() - _nseCookieAt < COOKIE_TTL) return _nseCookie;
    // Serialise: if a refresh is already in flight, wait for it instead of firing another
    if (_cookieFetchPromise) return _cookieFetchPromise;
    _cookieFetchPromise = (async () => {
        try {
            const res = await axios.get(NSE_BASE, {
                headers: { ...NSE_HEADERS, Accept: 'text/html' },
                timeout: 15000, maxRedirects: 5,
                validateStatus: s => s < 500,
            });
            const raw = res.headers['set-cookie'];
            if (raw && raw.length) {
                _nseCookie   = raw.map(c => c.split(';')[0]).join('; ');
                _nseCookieAt = Date.now();
                console.log('[NSE] cookie refreshed');
            }
        } catch (e) {
            console.warn('[NSE] cookie refresh failed:', e.message);
        } finally {
            _cookieFetchPromise = null;
        }
        return _nseCookie;
    })();
    return _cookieFetchPromise;
}

// ── nseGet — single attempt, fail fast (no retry to avoid 36s hangs on Railway)
// Railway US-West IPs can get rate-limited by NSE; retrying just makes it worse.
// Callers that need resilience use the cache layer above to absorb transient failures.
async function nseGet(path, timeoutMs = 10000) {
    const cookie = await getNSECookie();
    const headers = { ...NSE_HEADERS };
    if (cookie) headers['Cookie'] = cookie;
    const res = await axios.get(`${NSE_BASE}${path}`, { headers, timeout: timeoutMs });
    return res.data;
}

// ── Symbol routing ────────────────────────────────────────────────────────────
const NSE_INDEX_MAP = {
    '^NSEI'      : 'NIFTY 50',
    '%5ENSEI'    : 'NIFTY 50',
    '^NSEBANK'   : 'NIFTY BANK',
    '^CNXIT'     : 'NIFTY IT',
    '^CNXAUTO'   : 'NIFTY AUTO',
    '^CNXMETAL'  : 'NIFTY METAL',
    '^INDIAVIX'  : 'INDIA VIX',
    '%5EINDIAVIX': 'INDIA VIX',
};

// Symbols that are global (not on NSE) — return null immediately, no fetch
const GLOBAL_SYMBOLS = new Set([
    '^DJI','^IXIC','^GSPC','^N225','^HSI','000001.SS',
    '^GDAXI','^FTSE','USDINR=X','DX-Y.NYB',
    'CL=F','BZ=F','GC=F','SI=F',
]);

function isGlobal(symbol) {
    const decoded = decodeURIComponent(symbol);
    return GLOBAL_SYMBOLS.has(decoded) || GLOBAL_SYMBOLS.has(symbol);
}

function toNSESymbol(symbol) {
    const decoded = decodeURIComponent(symbol);
    if (decoded.endsWith('.NS')) return decoded.replace('.NS', '');
    return null;
}

// ── Bulk NSE allIndices cache ─────────────────────────────────────────────────
let _allIndicesCache = null;
let _allIndicesAt    = 0;
let _allIndicesFetch = null;   // serialise concurrent callers

async function fetchAllIndices() {
    // BUG FIX: previously _allIndicesAt was never stamped on failure, so the
    // 240s TTL check was always expired -> every caller retried immediately,
    // creating a polling storm of NSE requests every 10s when NSE is blocking
    // Railway IPs.  Now we stamp _allIndicesAt on failure too, so the same
    // 4-minute backoff window applies whether the last fetch succeeded or failed.
    // Stale cache (if any) is still returned so the app stays functional.
    if (Date.now() - _allIndicesAt < 240000) return _allIndicesCache || [];
    if (_allIndicesFetch) return _allIndicesFetch;
    _allIndicesFetch = (async () => {
        try {
            const data = await nseGet('/api/allIndices');
            if (data?.data) {
                _allIndicesCache = data.data;
                _allIndicesAt    = Date.now();
                console.log(`[NSE] allIndices loaded (${data.data.length} indices)`);
            } else {
                // No data but no throw -- still stamp to avoid tight retry loop
                _allIndicesAt = Date.now();
            }
        } catch (e) {
            console.warn('[NSE] allIndices failed:', e.message);
            // Stamp so the 4-min TTL blocks further retries (prevents polling storm)
            _allIndicesAt = Date.now();
        } finally {
            _allIndicesFetch = null;
        }
        return _allIndicesCache || [];
    })();
    return _allIndicesFetch;
}

// ── Bulk NSE Nifty 50 stocks cache ───────────────────────────────────────────
let _nifty50Cache   = null;
let _nifty50CacheAt = 0;
let _nifty50Fetch   = null;   // serialise concurrent callers

// Candidate NSE endpoints tried in order — first success wins.
// equity-stockIndices and live-analysis-data are 404 on Railway as of May 2026.
// market-data-pre-open returns the full Nifty50 pre-open list incl. prev-close/LTP.
const NIFTY50_URLS = [
    { url: '/api/market-data-pre-open?key=NIFTY', extract: extractPreOpen },
    { url: '/api/equity-stockIndices?index=NIFTY%2050', extract: extractStockIndex },
    { url: '/api/equity-stockIndices?index=NIFTY+50',   extract: extractStockIndex },
];

// Parser for /api/market-data-pre-open?key=NIFTY
// Response shape: { data: { preOpenMarket: { preopen: [ {symbol,xDiff,lastPrice,previousClose,...} ] } } }
function extractPreOpen(data) {
    const rows = data?.data?.preOpenMarket?.preopen;
    if (!Array.isArray(rows) || rows.length < 10) return null;
    return rows
        .filter(r => r.symbol)
        .map(r => ({
            symbol           : r.symbol,
            lastPrice        : r.lastPrice  ?? r.iep  ?? r.previousClose,
            previousClose    : r.previousClose,
            open             : r.lastPrice  ?? r.iep,
            dayHigh          : r.lastPrice  ?? r.iep,
            dayLow           : r.lastPrice  ?? r.iep,
            totalTradedVolume: r.totalTradedVolume ?? r.quantity ?? 0,
        }));
}

// Parser for /api/equity-stockIndices (original format)
function extractStockIndex(data) {
    const rows = data?.data || data?.index?.rows;
    if (!Array.isArray(rows) || rows.length < 10) return null;
    return rows.map(r => ({
        symbol           : r.symbol,
        lastPrice        : r.lastPrice     ?? r.ltp   ?? r.last,
        previousClose    : r.previousClose ?? r.prevClose,
        open             : r.open,
        dayHigh          : r.dayHigh       ?? r.high,
        dayLow           : r.dayLow        ?? r.low,
        totalTradedVolume: r.totalTradedVolume ?? r.volume ?? 0,
    }));
}

async function fetchNifty50Stocks() {
    // BUG FIX: same polling storm fix as fetchAllIndices — stamp _nifty50CacheAt on
    // failure so the 5-min TTL blocks retries instead of hammering NSE every cycle.
    if (Date.now() - _nifty50CacheAt < 300000) return _nifty50Cache || [];
    if (_nifty50Fetch) return _nifty50Fetch;
    _nifty50Fetch = (async () => {
        try {
            for (const { url, extract } of NIFTY50_URLS) {
                try {
                    const data = await nseGet(url);
                    const rows = extract(data);
                    if (rows && rows.length > 10) {
                        _nifty50Cache   = rows;
                        _nifty50CacheAt = Date.now();
                        console.log(`[NSE] Nifty50 stocks loaded via ${url} (${rows.length} rows)`);
                        return _nifty50Cache;
                    }
                } catch (e) {
                    console.warn(`[NSE] Nifty50 stocks failed (${url}): ${e.message}`);
                }
            }
            // All URLs failed — stamp so we back off for 5 min (prevents polling storm)
            console.warn('[NSE] All Nifty50 URLs failed — sector-index breadth will be used');
            _nifty50CacheAt = Date.now();
        } finally {
            _nifty50Fetch = null;
        }
        return _nifty50Cache || [];
    })();
    return _nifty50Fetch;
}

// ── NSE index quote ───────────────────────────────────────────────────────────
async function nseIndexQuote(indexName) {
    try {
        const indices = await fetchAllIndices();
        const row     = indices.find(r => r.index === indexName);
        if (!row) { console.warn(`[NSE] index not found: ${indexName}`); return null; }
        const price     = parseFloat(row.last);
        const prevClose = parseFloat(row.previousClose);
        return { price, prevClose, open: parseFloat(row.open||price), high: parseFloat(row.high||price), low: parseFloat(row.low||price), volume: 0 };
    } catch (e) {
        console.warn(`[NSE] index quote ${indexName}:`, e.message);
        return null;
    }
}

// ── NSE stock quote ───────────────────────────────────────────────────────────
async function nseStockQuote(nseSym) {
    try {
        const stocks = await fetchNifty50Stocks();
        const row    = stocks.find(r => r.symbol === nseSym);
        if (!row) { console.warn(`[NSE] stock not found: ${nseSym}`); return null; }
        const price     = parseFloat(row.lastPrice);
        const prevClose = parseFloat(row.previousClose);
        return { price, prevClose, open: parseFloat(row.open||price), high: parseFloat(row.dayHigh||price), low: parseFloat(row.dayLow||price), volume: parseInt(row.totalTradedVolume)||0 };
    } catch (e) {
        console.warn(`[NSE] stock quote ${nseSym}:`, e.message);
        return null;
    }
}

// ── NSE intraday 1-min candles for Nifty ─────────────────────────────────────
async function nseNiftyIntraday() {
    try {
        const data = await nseGet('/api/chart-databyindex?index=NIFTY&indices=true', 12000);
        const raw  = data?.grapthData || data?.graphData || [];
        if (!raw.length) return [];
        const prevClose = parseFloat(data.previousClose || 0);
        const bars = [];
        for (let i = 0; i < raw.length; i++) {
            const [ts, close] = raw[i];
            if (!close) continue;
            const prev = i > 0 ? raw[i-1][1] : (prevClose || close);
            bars.push({ ts, open: prev, high: close * 1.0005, low: close * 0.9995, close: parseFloat(close.toFixed(2)), volume: 1 });
        }
        console.log(`[NSE] intraday bars: ${bars.length}`);
        return bars;
    } catch (e) {
        console.warn('[NSE] intraday candles failed:', e.message);
        return [];
    }
}

// ── NSE daily candles (derived from intraday grouping) ────────────────────────
async function nseNiftyDaily(days = 10) {
    try {
        const data = await nseGet('/api/chart-databyindex?index=NIFTY&indices=true', 12000);
        const raw  = data?.grapthData || data?.graphData || [];
        if (!raw.length) return [];
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
        const rows = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)).slice(-days);
        console.log(`[NSE] daily candles: ${rows.length} days`);
        return rows;
    } catch (e) {
        console.warn('[NSE] daily candles failed:', e.message);
        return [];
    }
}

// ── fetchYahooMeta (drop-in) ─────────────────────────────────────────────────
async function fetchYahooMeta(symbol, params = {}) {
    try {
        const decoded   = decodeURIComponent(symbol);
        const indexName = NSE_INDEX_MAP[decoded] || NSE_INDEX_MAP[symbol];
        const nseSym    = toNSESymbol(decoded);

        if (isGlobal(symbol)) {
            // Global symbols: return null — globalCues.js handles null gracefully
            return null;
        }

        let quote = null;
        if (indexName) {
            quote = await nseIndexQuote(indexName);
        } else if (nseSym) {
            quote = await nseStockQuote(nseSym);
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
        console.warn(`[fetchYahooMeta] ${symbol}:`, e.message);
        return null;
    }
}

// ── fetchYahooChart (drop-in) ─────────────────────────────────────────────────
async function fetchYahooChart(symbol, params = { interval: '1d', range: '1d' }) {
    try {
        const decoded    = decodeURIComponent(symbol);
        const interval   = params.interval || '1d';
        const isIntraday = interval.endsWith('m') || interval === '1h' || interval === '60m';
        const days       = params.range === '10d' ? 10 : params.range === '1mo' ? 22 : 5;
        const isNifty    = decoded === '^NSEI' || decoded === '%5ENSEI' || symbol === '%5ENSEI' || NSE_INDEX_MAP[decoded] === 'NIFTY 50';

        if (!isNifty) {
            // Non-Nifty chart: build single-point stub from meta
            const meta = await fetchYahooMeta(symbol, params);
            if (!meta) return null;
            const ts = Math.floor(Date.now() / 1000);
            return {
                meta,
                timestamp : [ts],
                indicators: { quote: [{ open: [meta.regularMarketOpen], high: [meta.regularMarketHigh], low: [meta.regularMarketLow], close: [meta.regularMarketPrice], volume: [0] }] },
            };
        }

        let timestamps = [], opens = [], highs = [], lows = [], closes = [], volumes = [];

        if (isIntraday) {
            const bars = await nseNiftyIntraday();
            if (!bars.length) return null;
            for (const b of bars) {
                timestamps.push(Math.floor(b.ts / 1000));
                opens.push(b.open); highs.push(b.high); lows.push(b.low);
                closes.push(b.close); volumes.push(b.volume);
            }
        } else {
            const hist = await nseNiftyDaily(days);
            if (!hist.length) return null;
            for (const row of hist) {
                const ts = Math.floor(new Date(row.date + 'T09:15:00+05:30').getTime() / 1000);
                timestamps.push(ts);
                opens.push(row.open); highs.push(row.high); lows.push(row.low);
                closes.push(row.close); volumes.push(row.volume || 1);
            }
        }

        const lastClose = closes[closes.length - 1];
        const prevClose = closes.length >= 2 ? closes[closes.length - 2] : lastClose;

        return {
            meta      : { regularMarketPrice: lastClose, previousClose: prevClose, chartPreviousClose: prevClose },
            timestamp : timestamps,
            indicators: { quote: [{ open: opens, high: highs, low: lows, close: closes, volume: volumes }] },
        };
    } catch (e) {
        console.warn(`[fetchYahooChart] ${symbol}:`, e.message);
        return null;
    }
}

// ── Legacy shim ───────────────────────────────────────────────────────────────
async function yahooGet(path, params = {}, timeoutMs = 20000) {
    const match  = path.match(/chart\/([^?]+)/);
    const symbol = match ? decodeURIComponent(match[1]) : path;
    const chart  = await fetchYahooChart(symbol, params);
    if (!chart) throw new Error(`No data for ${symbol}`);
    return { chart: { result: [chart], error: null } };
}

module.exports = { yahooGet, fetchYahooMeta, fetchYahooChart, fetchNifty50Stocks, fetchAllIndices };