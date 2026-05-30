/**
 * yahooFetch.js  —  NSE-only replacement (Railway-compatible)
 * ─────────────────────────────────────────────────────────────────────
 * FIX v2 (2026-05-29):
 *  • intraday candles: tries 3 URL formats, 8s timeout each, returns
 *    STALE CACHE on all failures so RSI never drops to '--'
 *  • daily candles: same stale-cache pattern + NSE historical API fallback
 *  • nifty50 stocks: unchanged (pre-open fallback already working)
 *  • global symbols: still return null gracefully (handled by scoring system)
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
async function nseGet(path, timeoutMs = 10000) {
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
let _allIndicesCache   = null;
let _allIndicesAt      = 0;
let _allIndicesFailed  = false;  // true after a timeout — retry sooner
let _allIndicesFetch   = null;

async function fetchAllIndices() {
    // On success: cache for 4 min. On failure: retry after 30s (not 4 min).
    const ttl = _allIndicesFailed ? 30000 : 240000;
    if (Date.now() - _allIndicesAt < ttl) return _allIndicesCache || [];
    if (_allIndicesFetch) return _allIndicesFetch;
    _allIndicesFetch = (async () => {
        try {
            const data = await nseGet('/api/allIndices');
            if (data?.data) {
                _allIndicesCache  = data.data;
                _allIndicesAt     = Date.now();
                _allIndicesFailed = false;
                console.log(`[NSE] allIndices loaded (${data.data.length} indices)`);
            } else {
                _allIndicesAt     = Date.now();
                _allIndicesFailed = true;
            }
        } catch (e) {
            console.warn('[NSE] allIndices failed:', e.message);
            _allIndicesAt     = Date.now();
            _allIndicesFailed = true;
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
        const auth = await getYahooCrumb();
        const crumbParam = auth?.crumb ? `&crumb=${encodeURIComponent(auth.crumb)}` : '';
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=2d${crumbParam}`;
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept'    : 'application/json',
            'Referer'   : 'https://finance.yahoo.com/',
        };
        if (auth?.cookie) headers['Cookie'] = auth.cookie;
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
// Tries 3 URL formats, 8s timeout each.
// On all failures: returns STALE CACHE (up to 30 min old) so RSI stays alive.
// Previously: returned [] on failure → RSI = '--' → dashboard WAIT forever.
// ═════════════════════════════════════════════════════════════════════════════
let _intradayCache   = [];   // persists successful fetches across calls
let _intradayCacheAt = 0;
let _intradayFetch   = null; // serialise concurrent callers

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
            for (const url of INTRADAY_URLS) {
                try {
                    // 8 s timeout — fail fast so we don't hang the whole cycle
                    const data = await nseGet(url, 8000);
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
                        return _intradayCache;
                    }
                } catch (e) {
                    console.warn(`[NSE] intraday candles failed (${url}): ${e.message}`);
                }
            }

            // ── ALL URLs failed ──────────────────────────────────────────────
            if (_intradayCache.length > 0 && age < INTRADAY_STALE_TTL) {
                // Return stale cache — RSI keeps working with yesterday's bars
                console.warn(`[NSE] intraday: all URLs failed — returning stale cache (${Math.round(age / 60000)}m old)`);
                return _intradayCache;
            }

            // Cache too old or empty — return empty (RSI will show --)
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
                    const data = await nseGet(url, 8000);
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

let _yahooStocksCache   = null;
let _yahooStocksCacheAt = 0;

// ── Yahoo crumb/cookie auth (required since ~2024) ────────────────────────────
let _yahooCrumb      = null;
let _yahooCookie     = null;
let _yahooCrumbAt    = 0;
const YAHOO_CRUMB_TTL = 55 * 60 * 1000;  // 55 min

async function getYahooCrumb() {
    if (_yahooCrumb && Date.now() - _yahooCrumbAt < YAHOO_CRUMB_TTL) {
        return { crumb: _yahooCrumb, cookie: _yahooCookie };
    }
    try {
        // Step 1: hit finance.yahoo.com to get session cookie
        const homeRes = await axios.get('https://finance.yahoo.com/', {
            timeout: 8000,
            headers: {
                'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                'Accept'         : 'text/html,application/xhtml+xml,*/*',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            maxRedirects: 5,
        });
        const rawCookies = homeRes.headers['set-cookie'] || [];
        const cookieStr  = rawCookies.map(c => c.split(';')[0]).join('; ');
        if (!cookieStr) { console.warn('[Yahoo] No cookie from homepage'); return null; }

        // Step 2: fetch crumb using the session cookie
        const crumbRes = await axios.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                'Cookie'    : cookieStr,
                'Accept'    : '*/*',
                'Referer'   : 'https://finance.yahoo.com/',
            },
        });
        const crumb = typeof crumbRes.data === 'string' ? crumbRes.data.trim() : null;
        if (!crumb || crumb.length < 3) { console.warn('[Yahoo] Bad crumb:', crumb); return null; }

        _yahooCrumb   = crumb;
        _yahooCookie  = cookieStr;
        _yahooCrumbAt = Date.now();
        console.log('[Yahoo] Crumb refreshed ✅');
        return { crumb, cookie: cookieStr };
    } catch (e) {
        console.warn('[Yahoo] Crumb fetch failed:', e.message);
        return null;
    }
}

async function fetchNifty50FromYahoo() {
    const istNow  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const istMin  = istNow.getHours() * 60 + istNow.getMinutes();
    const inMarket = istMin >= 555 && istMin <= 930;   // 9:15-15:30
    const cacheTTL = inMarket ? 60_000 : 300_000;

    if (_yahooStocksCache && Date.now() - _yahooStocksCacheAt < cacheTTL) return _yahooStocksCache;

    try {
        const symbols = NIFTY50_YAHOO_SYMBOLS.join(',');

        // Get crumb+cookie for auth
        const auth = await getYahooCrumb();
        const headers = {
            'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept'         : 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer'        : 'https://finance.yahoo.com/',
        };
        if (auth?.cookie) headers['Cookie'] = auth.cookie;

        // Try v8/finance/quote with crumb (new required endpoint)
        const crumbParam = auth?.crumb ? `&crumb=${encodeURIComponent(auth.crumb)}` : '';
        const urlV8 = `https://query1.finance.yahoo.com/v8/finance/quote?symbols=${symbols}&fields=regularMarketPrice,regularMarketPreviousClose,regularMarketChangePercent${crumbParam}`;

        let quotes = null;
        try {
            const res = await axios.get(urlV8, { timeout: 10000, headers });
            quotes = res.data?.quoteResponse?.result;
        } catch (e1) {
            console.warn(`[Yahoo] v8 quote failed (${e1.response?.status || e1.message}) — trying v7...`);
            // Fallback: v7 with crumb
            const urlV7 = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&fields=regularMarketPrice,regularMarketPreviousClose,regularMarketChangePercent${crumbParam}`;
            const res2  = await axios.get(urlV7, { timeout: 10000, headers });
            quotes = res2.data?.quoteResponse?.result;
        }

        if (!Array.isArray(quotes) || quotes.length < 5) return null;

        const rows = quotes.map(q => {
            const symbol    = (q.symbol || '').replace('.NS', '');
            const price     = parseFloat((q.regularMarketPrice         || 0).toFixed(2));
            const prevClose = parseFloat((q.regularMarketPreviousClose || price).toFixed(2));
            return { symbol, lastPrice: price, previousClose: prevClose };
        }).filter(r => r.lastPrice > 0);

        _yahooStocksCache   = rows;
        _yahooStocksCacheAt = Date.now();
        console.log(`[Yahoo] Nifty50 batch quote: ${rows.length} stocks loaded ✅`);
        return rows;
    } catch (e) {
        // Invalidate crumb on 401 so next call re-fetches
        if (e.response?.status === 401) {
            _yahooCrumb = null;
            _yahooCrumbAt = 0;
            console.warn('[Yahoo] Nifty50 batch quote 401 — crumb invalidated, will retry next cycle');
        } else {
            console.warn(`[Yahoo] Nifty50 batch quote failed: ${e.message}`);
        }
        return null;
    }
}

module.exports = { yahooGet, fetchYahooMeta, fetchYahooChart, fetchNifty50Stocks, fetchAllIndices, fetchNifty50FromYahoo };