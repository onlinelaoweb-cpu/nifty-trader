/**
 * yahooFetch.js  —  NSE-only replacement (Railway-compatible)
 * ─────────────────────────────────────────────────────────────────────
 * FIX v2 (2026-05-29):
 *  • intraday candles: tries 3 URL formats, 8s timeout each, returns
 *    STALE CACHE on all failures so RSI never drops to '--'
 *  • daily candles: same stale-cache pattern + NSE historical API fallback
 *  • nifty50 stocks: unchanged (pre-open fallback already working)
 *  • global symbols: still return null gracefully (handled by scoring system)
 *
 * FIX v3 (2026-06-03):
 *  • nseNiftyIntraday: reduced per-URL timeout 15s→8s (3 URLs × 8s = 24s max
 *    before Yahoo fallback, vs 45s before)
 *  • nseNiftyIntraday: added Yahoo Finance query1.finance.yahoo.com/v8/finance/chart
 *    as final fallback when ALL NSE URLs timeout (Railway IP ban / off-hours)
 *    — eliminates "[NSE] intraday: all URLs failed, no usable cache" error
 *    — Chart tab and RSI stay live even when NSE blocks Railway IP
 */

'use strict';
const axios = require('axios');

// ── NSE session cookie ────────────────────────────────────────────────────────
let _nseCookie   = null;
let _nseCookieAt = 0;
const COOKIE_TTL = 14 * 60 * 1000;

const NSE_HEADERS = {
    'User-Agent'        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept'            : 'application/json, text/plain, */*',
    'Accept-Language'   : 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding'   : 'gzip, deflate, br',
    'Referer'           : 'https://www.nseindia.com/',
    'Connection'        : 'keep-alive',
    'sec-fetch-dest'    : 'empty',
    'sec-fetch-site'    : 'same-origin',
    'sec-fetch-mode'    : 'cors',
    'sec-ch-ua'         : '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    'sec-ch-ua-mobile'  : '?0',
    'sec-ch-ua-platform': '"Windows"',
};
const NSE_BASE = 'https://www.nseindia.com';

// ── Cookie fetch — serialised so parallel startup calls don't all hit NSE ────
let _cookieFetchPromise = null;

async function getNSECookie() {
    if (_nseCookie && Date.now() - _nseCookieAt < COOKIE_TTL) return _nseCookie;
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

// ── nseGet — single attempt, fail fast ───────────────────────────────────────
// validateStatus: accept 200-299 and 404 (return null data) — 404 no longer
// throws, so the NIFTY50_URLS waterfall can continue to the next URL cleanly.
async function nseGet(path, timeoutMs = 15000) {
    const cookie = await getNSECookie();
    const headers = { ...NSE_HEADERS };
    if (cookie) headers['Cookie'] = cookie;
    const res = await axios.get(`${NSE_BASE}${path}`, {
        headers,
        timeout: timeoutMs,
        validateStatus: s => s < 500,   // 404 returns null data, not a throw
    });
    if (res.status === 404) {
        console.warn(`[NSE] 404 on ${path} — skipping`);
        return null;
    }
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

const GLOBAL_SYMBOLS = new Set([
    '^DJI','^IXIC','^GSPC','^N225','^HSI','000001.SS',
    '^GDAXI','^FTSE','USDINR=X','DX-Y.NYB',
    'CL=F','BZ=F','GC=F','SI=F',
    '%5ENSEI',       // GIFT Nifty proxy — Nifty spot via Yahoo
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
let _allIndicesCache        = null;
let _allIndicesAt           = 0;
let _allIndicesFailed       = false;  // true after a timeout — retry sooner
let _allIndicesFetch        = null;
let _allIndicesFailStreak   = 0;      // consecutive failure count
const ALL_INDICES_BACKOFF_AFTER = 5;              // failures before long backoff (was 3 — too aggressive)
const ALL_INDICES_BACKOFF_TTL   = 15 * 60 * 1000; // 15 min — stop hammering NSE when rate-limited
const ALL_INDICES_RETRY_TTL     = 30_000;          // 30s retry after a single failure
const ALL_INDICES_OK_TTL        = 240_000;         // 4 min cache on success

async function fetchAllIndices() {
    // After 3+ consecutive failures: back off for 15 min — Railway IP is rate-limited.
    // Single failure: retry after 30s. Success: cache for 4 min.
    let ttl;
    if (_allIndicesFailStreak >= ALL_INDICES_BACKOFF_AFTER) {
        ttl = ALL_INDICES_BACKOFF_TTL;
    } else {
        ttl = _allIndicesFailed ? ALL_INDICES_RETRY_TTL : ALL_INDICES_OK_TTL;
    }
    if (Date.now() - _allIndicesAt < ttl) return _allIndicesCache || [];
    if (_allIndicesFetch) return _allIndicesFetch;
    _allIndicesFetch = (async () => {
        try {
            const data = await nseGet('/api/allIndices', 20000);  // 20s — NSE allIndices can be slow from Railway
            if (data?.data) {
                _allIndicesCache      = data.data;
                _allIndicesAt         = Date.now();
                _allIndicesFailed     = false;
                _allIndicesFailStreak = 0;
                console.log(`[NSE] allIndices loaded (${data.data.length} indices)`);
            } else {
                _allIndicesAt         = Date.now();
                _allIndicesFailed     = true;
                _allIndicesFailStreak++;
                if (_allIndicesFailStreak >= ALL_INDICES_BACKOFF_AFTER) {
                    console.warn(`[NSE] allIndices failed ${_allIndicesFailStreak}× in a row — backing off for 15 min (Railway rate-limit)`);
                }
            }
        } catch (e) {
            _allIndicesAt         = Date.now();
            _allIndicesFailed     = true;
            _allIndicesFailStreak++;
            if (_allIndicesFailStreak >= ALL_INDICES_BACKOFF_AFTER) {
                console.warn(`[NSE] allIndices failed ${_allIndicesFailStreak}× in a row — backing off for 15 min (Railway rate-limit): ${e.message}`);
            } else {
                console.warn('[NSE] allIndices failed:', e.message);
            }
        } finally {
            _allIndicesFetch = null;
        }
        return _allIndicesCache || [];
    })();
    return _allIndicesFetch;
}

// Returns how many ms old the allIndices cache is — Infinity if never fetched.
// Used by callers (e.g. bankNiftyVWAPLead) that need to know if a "successful"
// lookup is actually a stale value being replayed during a Railway NSE backoff.
function getAllIndicesCacheAge() {
    if (!_allIndicesAt) return Infinity;
    return Date.now() - _allIndicesAt;
}

// ── Bulk NSE Nifty 50 stocks cache ───────────────────────────────────────────
let _nifty50Cache   = null;
let _nifty50CacheAt = 0;
let _nifty50Fetch   = null;

// Tried in order — first success wins.
// equity-stockIndices is 404 on Railway as of May 2026.
// market-data-pre-open returns full Nifty50 pre-open list incl. prev-close/LTP.
const NIFTY50_URLS = [
    { url: '/api/market-data-pre-open?key=NIFTY',        extract: extractPreOpen      },
    { url: '/api/market-data-pre-open?key=NIFTY50',      extract: extractPreOpen      },
    { url: '/api/equity-stockIndices?index=NIFTY%2050',  extract: extractStockIndex   },
    { url: '/api/equity-stockIndices?index=NIFTY+50',    extract: extractStockIndex   },
    { url: '/api/equity-stockIndices?index=NIFTY50',     extract: extractStockIndex   },
];

function extractPreOpen(data) {
    if (!data) return null;   // guard against 404 null
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

function extractStockIndex(data) {
    if (!data) return null;   // guard against 404 null
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
    // During market hours (9:15-15:30 IST) cache for 60s so failed URLs retry quickly.
    // Outside market hours cache for 5 min.
    const istNow  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const istMin  = istNow.getHours() * 60 + istNow.getMinutes();
    const inMarket = istMin >= 555 && istMin <= 930;   // 9:15-15:30
    const cacheTTL = inMarket ? 60_000 : 300_000;

    if (Date.now() - _nifty50CacheAt < cacheTTL) return _nifty50Cache || [];
    if (_nifty50Fetch) return _nifty50Fetch;
    _nifty50Fetch = (async () => {
        try {
            for (const { url, extract } of NIFTY50_URLS) {
                try {
                    const data = await nseGet(url);
                    if (!data) continue;   // 404 returns null — try next URL
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
            console.warn('[NSE] All Nifty50 URLs failed — sector-index breadth will be used');
            _nifty50CacheAt = Date.now() - cacheTTL + 30_000;   // retry in 30s, not full TTL
        } finally {
            _nifty50Fetch = null;
        }
        return _nifty50Cache || [];
    })();
    return _nifty50Fetch;
}

// ── Yahoo Finance symbol map for Indian indices (NSE fallback) ───────────────
const YAHOO_FALLBACK_MAP = {
    'INDIA VIX'  : '%5EINDIAVIX',
    'NIFTY BANK' : '%5ENSEBANK',
    'NIFTY IT'   : '%5ECNXIT',
    'NIFTY AUTO' : '%5ECNXAUTO',
    'NIFTY METAL': '%5ECNXMETAL',
    'NIFTY 50'   : '%5ENSEI',
};

// ── Yahoo Finance direct HTTP (used only as NSE fallback) ────────────────────
async function yahooDirectQuote(yahooSymbol) {
    try {
        // No crumb needed — query2 chart endpoint works without auth on Railway
        const url = `https://query2.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=2d`;
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'Accept'    : 'application/json',
            'Referer'   : 'https://finance.yahoo.com/',
        };
        const res = await axios.get(url, { timeout: 8000, headers });
        const result = res.data?.chart?.result?.[0];
        if (!result) return null;
        const meta      = result.meta;
        const price     = parseFloat((meta.regularMarketPrice  || 0).toFixed(2));
        const prevClose = parseFloat((meta.chartPreviousClose  || meta.previousClose || price).toFixed(2));
        if (!price) return null;
        return {
            price,
            prevClose,
            open  : parseFloat((meta.regularMarketOpen    || price).toFixed(2)),
            high  : parseFloat((meta.regularMarketDayHigh || price).toFixed(2)),
            low   : parseFloat((meta.regularMarketDayLow  || price).toFixed(2)),
            volume: meta.regularMarketVolume || 0,
        };
    } catch (e) {
        console.warn(`[Yahoo fallback] ${yahooSymbol}:`, e.message);
        return null;
    }
}

// ── NSE index quote — NSE first, Yahoo Finance fallback ───────────────────────
async function nseIndexQuote(indexName) {
    try {
        const indices = await fetchAllIndices();
        const row     = indices.find(r => r.index === indexName);
        if (row) {
            const price     = parseFloat(row.last);
            const prevClose = parseFloat(row.previousClose);
            return {
                price,
                prevClose,
                open  : parseFloat(row.open   || price),
                high  : parseFloat(row.high   || price),
                low   : parseFloat(row.low    || price),
                volume: 0,
            };
        }
        // NSE blocked / not found — try Yahoo Finance directly
        const yahooSym = YAHOO_FALLBACK_MAP[indexName];
        if (yahooSym) {
            console.warn(`[NSE] index not found: ${indexName} — trying Yahoo fallback`);
            const q = await yahooDirectQuote(yahooSym);
            if (q) { console.log(`[Yahoo fallback] ${indexName}: ${q.price}`); return q; }
        }
        console.warn(`[NSE] index not found: ${indexName}`);
        return null;
    } catch (e) {
        // NSE threw an error — try Yahoo before giving up
        const yahooSym = YAHOO_FALLBACK_MAP[indexName];
        if (yahooSym) {
            console.warn(`[NSE] index quote ${indexName} error — trying Yahoo fallback`);
            const q = await yahooDirectQuote(yahooSym);
            if (q) { console.log(`[Yahoo fallback] ${indexName}: ${q.price}`); return q; }
        }
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
        return {
            price,
            prevClose,
            open  : parseFloat(row.open      || price),
            high  : parseFloat(row.dayHigh   || price),
            low   : parseFloat(row.dayLow    || price),
            volume: parseInt(row.totalTradedVolume) || 0,
        };
    } catch (e) {
        console.warn(`[NSE] stock quote ${nseSym}:`, e.message);
        return null;
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// INTRADAY CANDLES — KEY FIX
// Tries 3 URL formats, 15s timeout each (Railway→NSE latency can spike).
// On all failures: returns STALE CACHE (up to 30 min old) so RSI stays alive.
// Previously: returned [] on failure → RSI = '--' → dashboard WAIT forever.
// ═════════════════════════════════════════════════════════════════════════════
let _intradayCache   = [];   // persists successful fetches across calls
let _intradayCacheAt = 0;
let _intradayFetch   = null; // serialise concurrent callers
let _nseFails        = 0;    // consecutive NSE failures — after 3, skip NSE for session
let _nseBlockedUntil = 0;    // epoch ms — skip NSE until this time

const INTRADAY_URLS = [
    '/api/chart-databyindex?index=NIFTY&indices=true',
    '/api/chart-databyindex?index=NIFTY%2050&indices=true',
    '/api/chart-databyindex?index=NIFTY+50&indices=true',
];

// Stale cache TTL: return old bars for up to 5 minutes before retrying NSE
const INTRADAY_LIVE_TTL  =  5 * 60 * 1000;  // 5 min — live refresh window
const INTRADAY_STALE_TTL = 30 * 60 * 1000;  // 30 min — max stale age

async function nseNiftyIntraday() {
    const age = Date.now() - _intradayCacheAt;

    // Fresh cache — return immediately, don't hit NSE
    if (_intradayCache.length > 0 && age < INTRADAY_LIVE_TTL) {
        return _intradayCache;
    }
    // Serialise concurrent callers
    if (_intradayFetch) return _intradayFetch;

    _intradayFetch = (async () => {
        try {
            // ── Skip NSE entirely if it has been consistently blocked ──────────
            // After 3 consecutive all-URL failures, Railway IP is clearly banned.
            // Skip NSE for 30 min and go straight to Yahoo — saves 9s per cycle.
            const nseBlocked = Date.now() < _nseBlockedUntil;
            if (!nseBlocked) {
                let nseAnySuccess = false;
                for (const url of INTRADAY_URLS) {
                    try {
                        // 3s timeout — NSE from Railway either responds fast or not at all
                        const data = await nseGet(url, 3000);
                    const raw  = data?.grapthData || data?.graphData || [];
                    if (!raw.length) continue;

                    const prevClose = parseFloat(data.previousClose || 0);
                    const bars = [];
                    for (let i = 0; i < raw.length; i++) {
                        const [ts, close] = raw[i];
                        if (!close) continue;
                        const prev = i > 0 ? raw[i - 1][1] : (prevClose || close);
                        bars.push({
                            ts,
                            open  : prev,
                            high  : close * 1.0005,
                            low   : close * 0.9995,
                            close : parseFloat(close.toFixed(2)),
                            volume: 1,
                        });
                    }

                    if (bars.length > 0) {
                        console.log(`[NSE] intraday bars: ${bars.length} via ${url}`);
                        _intradayCache   = bars;
                        _intradayCacheAt = Date.now();
                        _nseFails = 0; // reset failure counter on success
                        nseAnySuccess = true;
                        return _intradayCache;
                    }
                } catch (e) {
                    console.warn(`[NSE] intraday candles failed (${url}): ${e.message}`);
                }
            }
                // All NSE URLs failed this cycle
                if (!nseAnySuccess) {
                    _nseFails++;
                    if (_nseFails >= 3) {
                        // Block NSE for 30 min — Railway IP is banned, stop wasting 9s per cycle
                        _nseBlockedUntil = Date.now() + 30 * 60 * 1000;
                        console.warn(`[NSE] intraday: blocked after ${_nseFails} failures — skipping NSE for 30 min, using Yahoo only`);
                        _nseFails = 0;
                    }
                }
            } else {
                console.log('[NSE] intraday: NSE IP-blocked — going straight to Yahoo fallback');
            }

            // ── ALL NSE URLs failed — try Yahoo Finance 1m as fallback ─────────
            console.warn('[NSE] intraday: all NSE URLs failed — trying Yahoo Finance 1m fallback...');
            try {
                const yhRes = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI', {
                    params  : { interval: '1m', range: '1d', includePrePost: false },
                    headers : {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
                        'Accept'    : 'application/json',
                    },
                    timeout : 12000,
                    validateStatus: s => s < 500,
                });
                const result = yhRes.data?.chart?.result?.[0];
                const timestamps = result?.timestamp;
                const quote      = result?.indicators?.quote?.[0];
                if (Array.isArray(timestamps) && timestamps.length > 5 && quote?.close) {
                    const bars = [];
                    for (let i = 0; i < timestamps.length; i++) {
                        const c = quote.close[i];
                        if (c == null) continue;
                        const o = quote.open[i]   || c;
                        const h = quote.high[i]   || c;
                        const l = quote.low[i]    || c;
                        const v = quote.volume[i] || 1;
                        bars.push({ ts: timestamps[i] * 1000, open: o, high: h, low: l, close: parseFloat(c.toFixed(2)), volume: v });
                    }
                    if (bars.length > 5) {
                        console.log(`[NSE] intraday Yahoo fallback ✅ — ${bars.length} bars`);
                        _intradayCache   = bars;
                        _intradayCacheAt = Date.now();
                        return _intradayCache;
                    }
                }
            } catch (yhErr) {
                console.warn('[NSE] intraday Yahoo fallback failed:', yhErr.message);
            }

            // ── Stale cache still usable ─────────────────────────────────────
            if (_intradayCache.length > 0 && age < INTRADAY_STALE_TTL) {
                // Return stale cache — RSI keeps working with yesterday's bars
                console.warn(`[NSE] intraday: all URLs failed — returning stale cache (${Math.round(age / 60000)}m old)`);
                return _intradayCache;
            }

            // Everything failed — return empty (RSI will show --)
            console.warn('[NSE] intraday: all URLs failed, no usable cache');
            return [];
        } finally {
            _intradayFetch = null;
        }
    })();
    return _intradayFetch;
}

// ═════════════════════════════════════════════════════════════════════════════
// DAILY CANDLES — KEY FIX
// Strategy 1: derive from intraday chart endpoint (same 3 URLs, 8s each)
// Strategy 2: NSE historical API (/api/historical/indicesHistory)
// On all failures: return stale cache so MTF/ADX stays alive
// ═════════════════════════════════════════════════════════════════════════════
let _dailyCache   = [];
let _dailyCacheAt = 0;
let _dailyFetch   = null;

const DAILY_LIVE_TTL  = 10 * 60 * 1000;  // 10 min
const DAILY_STALE_TTL = 60 * 60 * 1000;  // 60 min

async function nseNiftyDaily(days = 10) {
    const age = Date.now() - _dailyCacheAt;

    if (_dailyCache.length > 0 && age < DAILY_LIVE_TTL) {
        return _dailyCache;
    }
    if (_dailyFetch) return _dailyFetch;

    _dailyFetch = (async () => {
        try {
            // ── Strategy 1: derive daily OHLC by grouping intraday chart data ──
            for (const url of INTRADAY_URLS) {
                try {
                    const data = await nseGet(url, 15000);
                    const raw  = data?.grapthData || data?.graphData || [];
                    if (!raw.length) continue;

                    const byDate = {};
                    for (const [ts, close] of raw) {
                        if (!close) continue;
                        const date = new Date(ts).toISOString().slice(0, 10);
                        if (!byDate[date]) {
                            byDate[date] = { open: close, high: close, low: close, close, date };
                        } else {
                            byDate[date].high  = Math.max(byDate[date].high, close);
                            byDate[date].low   = Math.min(byDate[date].low, close);
                            byDate[date].close = close;
                        }
                    }
                    const rows = Object.values(byDate)
                        .sort((a, b) => a.date.localeCompare(b.date))
                        .slice(-days);

                    if (rows.length > 0) {
                        console.log(`[NSE] daily candles: ${rows.length} days (from ${url})`);
                        _dailyCache   = rows;
                        _dailyCacheAt = Date.now();
                        return _dailyCache;
                    }
                } catch (e) {
                    console.warn(`[NSE] daily candles failed (${url}): ${e.message}`);
                }
            }

            // ── Strategy 2: NSE historical indices API ─────────────────────────
            try {
                const today = new Date();
                const from  = new Date(today);
                from.setDate(from.getDate() - 45); // fetch 45 days, slice to `days`
                const fmt = d =>
                    `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;
                const histUrl = `/api/historical/indicesHistory?indexType=NIFTY%2050&from=${fmt(from)}&to=${fmt(today)}`;
                const data    = await nseGet(histUrl, 12000);

                // Response shape varies — handle both known formats
                const rows =
                    data?.data?.indexCloseOnlineRecords ||
                    data?.data?.indexTurnoverRecords    ||
                    (Array.isArray(data?.data) ? data.data : null);

                if (Array.isArray(rows) && rows.length > 0) {
                    const hist = rows
                        .filter(r => r.EOD_CLOSE_INDEX_VAL || r.CLOSE)
                        .map(r => ({
                            date : (r.EOD_TIMESTAMP || r.TIMESTAMP || r.DATE || '').slice(0, 10),
                            open : parseFloat(r.EOD_OPEN_INDEX_VAL  || r.OPEN  || r.EOD_CLOSE_INDEX_VAL || r.CLOSE),
                            high : parseFloat(r.EOD_HIGH_INDEX_VAL  || r.HIGH  || r.EOD_CLOSE_INDEX_VAL || r.CLOSE),
                            low  : parseFloat(r.EOD_LOW_INDEX_VAL   || r.LOW   || r.EOD_CLOSE_INDEX_VAL || r.CLOSE),
                            close: parseFloat(r.EOD_CLOSE_INDEX_VAL || r.CLOSE),
                        }))
                        .filter(r => r.date && r.close > 0)
                        .sort((a, b) => a.date.localeCompare(b.date))
                        .slice(-days);

                    if (hist.length > 0) {
                        console.log(`[NSE] daily from historical API: ${hist.length} days`);
                        _dailyCache   = hist;
                        _dailyCacheAt = Date.now();
                        return _dailyCache;
                    }
                }
            } catch (e) {
                console.warn('[NSE] historical API failed:', e.message);
            }

            // ── Strategy 3: Yahoo Finance ^NSEI daily candles (Railway-safe) ──
            // NSE chart & historical APIs both timeout from Railway's US IPs.
            // Yahoo Finance never blocks Railway — use as primary fallback.
            try {
                const yhRes = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI', {
                    params  : { interval: '1d', range: '3mo', includePrePost: false },
                    headers : {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
                        'Accept'    : 'application/json',
                    },
                    timeout : 12000,
                    validateStatus: s => s < 500,
                });
                const result     = yhRes.data?.chart?.result?.[0];
                const timestamps = result?.timestamp;
                const quote      = result?.indicators?.quote?.[0];
                if (Array.isArray(timestamps) && timestamps.length > 3 && quote?.close) {
                    const yhBars = [];
                    for (let i = 0; i < timestamps.length; i++) {
                        const c = quote.close[i];
                        if (c == null) continue;
                        const o = quote.open[i]   || c;
                        const h = quote.high[i]   || c;
                        const l = quote.low[i]    || c;
                        const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
                        yhBars.push({ date, open: parseFloat(o.toFixed(2)), high: parseFloat(h.toFixed(2)), low: parseFloat(l.toFixed(2)), close: parseFloat(c.toFixed(2)) });
                    }
                    const sliced = yhBars.filter(b => b.close > 0).slice(-days);
                    if (sliced.length > 0) {
                        console.log(`[NSE] daily Yahoo fallback ✅ — ${sliced.length} days`);
                        _dailyCache   = sliced;
                        _dailyCacheAt = Date.now();
                        return _dailyCache;
                    }
                }
            } catch (yhErr) {
                console.warn('[NSE] daily Yahoo fallback failed:', yhErr.message);
            }

            // ── All strategies failed — return stale cache if usable ───────────
            if (_dailyCache.length > 0 && age < DAILY_STALE_TTL) {
                console.warn(`[NSE] daily: all sources failed — returning stale cache (${Math.round(age / 60000)}m old)`);
                return _dailyCache;
            }

            console.warn('[NSE] daily: all sources failed, no usable cache');
            return [];
        } finally {
            _dailyFetch = null;
        }
    })();
    return _dailyFetch;
}

// ── fetchYahooMeta (drop-in) ──────────────────────────────────────────────────
async function fetchYahooMeta(symbol, params = {}) {
    try {
        const decoded   = decodeURIComponent(symbol);
        const indexName = NSE_INDEX_MAP[decoded] || NSE_INDEX_MAP[symbol];
        const nseSym    = toNSESymbol(decoded);

        // Global symbols (world indices, forex, commodities) — fetch directly from Yahoo Finance
        if (isGlobal(symbol)) {
            const q = await yahooDirectQuote(encodeURIComponent(decoded));
            if (!q) return null;
            return {
                regularMarketPrice  : q.price,
                previousClose       : q.prevClose,
                chartPreviousClose  : q.prevClose,
                regularMarketOpen   : q.open   || q.price,
                regularMarketHigh   : q.high   || q.price,
                regularMarketLow    : q.low    || q.price,
                regularMarketVolume : q.volume || 0,
            };
        }

        let quote = null;
        if (indexName)     quote = await nseIndexQuote(indexName);
        else if (nseSym)   quote = await nseStockQuote(nseSym);

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
        const isNifty    =
            decoded === '^NSEI' ||
            decoded === '%5ENSEI' ||
            symbol  === '%5ENSEI' ||
            NSE_INDEX_MAP[decoded] === 'NIFTY 50';

        if (!isNifty) {
            // Non-Nifty chart: single-point stub from meta
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

// ── Yahoo Finance batch quote for Nifty 50 weighted stocks ───────────────────
// Used as Tier 2.5 breadth fallback when NSE equity-stockIndices is 404 on Railway.
// Fetches up to 50 .NS symbols in ONE request — fast and Railway-compatible.
const NIFTY50_YAHOO_SYMBOLS = [
    'RELIANCE.NS','HDFCBANK.NS','ICICIBANK.NS','INFY.NS','TCS.NS',
    'KOTAKBANK.NS','LT.NS','SBIN.NS','AXISBANK.NS','BHARTIARTL.NS',
    'ITC.NS','WIPRO.NS','HCLTECH.NS','MARUTI.NS','BAJFINANCE.NS',
    'TITAN.NS','ASIANPAINT.NS','NTPC.NS','POWERGRID.NS','NESTLEIND.NS',
];

// ── Yahoo Finance batch quote — no-auth approach ─────────────────────────────
// Railway blocks Yahoo auth endpoints (consent.yahoo.com, query2, etc.)
// Solution: use Yahoo's /v7/finance/spark endpoint — no crumb/cookie needed,
// returns price + prevClose for multiple symbols in one call.

let _yahooStocksCache   = null;
let _yahooStocksCacheAt = 0;

async function fetchNifty50FromYahoo() {
    const istNow   = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const istMin   = istNow.getHours() * 60 + istNow.getMinutes();
    const inMarket = istMin >= 555 && istMin <= 930;
    const cacheTTL = inMarket ? 60_000 : 300_000;

    if (_yahooStocksCache && Date.now() - _yahooStocksCacheAt < cacheTTL) return _yahooStocksCache;

    const symbols = NIFTY50_YAHOO_SYMBOLS.join(',');
    const HEADERS = {
        'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept'         : 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer'        : 'https://finance.yahoo.com/',
        'Origin'         : 'https://finance.yahoo.com',
    };

    // Attempt 1: spark endpoint — no auth required, returns price history + meta
    try {
        const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols}&range=1d&interval=1d&indicators=close&includeTimestamps=false`;
        const res = await axios.get(url, { timeout: 10000, headers: HEADERS });
        const spark = res.data?.spark?.result;
        if (Array.isArray(spark) && spark.length >= 5) {
            const rows = spark.map(s => {
                const symbol    = (s.symbol || '').replace('.NS', '');
                const meta      = s.response?.[0]?.meta || {};
                const price     = parseFloat((meta.regularMarketPrice       || 0).toFixed(2));
                const prevClose = parseFloat((meta.chartPreviousClose       || meta.previousClose || price).toFixed(2));
                return { symbol, lastPrice: price, previousClose: prevClose };
            }).filter(r => r.lastPrice > 0);

            if (rows.length >= 5) {
                _yahooStocksCache   = rows;
                _yahooStocksCacheAt = Date.now();
                console.log(`[Yahoo] Nifty50 spark: ${rows.length} stocks loaded ✅`);
                return rows;
            }
        }
    } catch (e) {
        console.warn(`[Yahoo] spark failed: ${e.response?.status || e.message}`);
    }

    // Attempt 2: v8/finance/quote with formatted=false (sometimes works without crumb)
    try {
        const url = `https://query2.finance.yahoo.com/v8/finance/quote?symbols=${symbols}&fields=regularMarketPrice,regularMarketPreviousClose&formatted=false&region=IN&lang=en-IN`;
        const res = await axios.get(url, { timeout: 10000, headers: HEADERS });
        const quotes = res.data?.quoteResponse?.result;
        if (Array.isArray(quotes) && quotes.length >= 5) {
            const rows = quotes.map(q => ({
                symbol      : (q.symbol || '').replace('.NS', ''),
                lastPrice   : parseFloat((q.regularMarketPrice         || 0).toFixed(2)),
                previousClose: parseFloat((q.regularMarketPreviousClose || 0).toFixed(2)),
            })).filter(r => r.lastPrice > 0);

            if (rows.length >= 5) {
                _yahooStocksCache   = rows;
                _yahooStocksCacheAt = Date.now();
                console.log(`[Yahoo] Nifty50 v8 quote: ${rows.length} stocks loaded ✅`);
                return rows;
            }
        }
    } catch (e) {
        console.warn(`[Yahoo] v8 quote failed: ${e.response?.status || e.message}`);
    }

    // Attempt 3: v7/finance/quote with query2 host
    try {
        const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&fields=regularMarketPrice,regularMarketPreviousClose`;
        const res = await axios.get(url, { timeout: 10000, headers: HEADERS });
        const quotes = res.data?.quoteResponse?.result;
        if (Array.isArray(quotes) && quotes.length >= 5) {
            const rows = quotes.map(q => ({
                symbol      : (q.symbol || '').replace('.NS', ''),
                lastPrice   : parseFloat((q.regularMarketPrice         || 0).toFixed(2)),
                previousClose: parseFloat((q.regularMarketPreviousClose || 0).toFixed(2)),
            })).filter(r => r.lastPrice > 0);

            if (rows.length >= 5) {
                _yahooStocksCache   = rows;
                _yahooStocksCacheAt = Date.now();
                console.log(`[Yahoo] Nifty50 v7 query2: ${rows.length} stocks loaded ✅`);
                return rows;
            }
        }
    } catch (e) {
        console.warn(`[Yahoo] v7 query2 failed: ${e.response?.status || e.message}`);
    }

    console.warn('[Yahoo] All Nifty50 batch attempts failed — sector fallback will be used');
    return null;
}

module.exports = { yahooGet, fetchYahooMeta, fetchYahooChart, fetchNifty50Stocks, fetchAllIndices, fetchNifty50FromYahoo, nseNiftyDaily, getAllIndicesCacheAge, yahooDirectQuote };
