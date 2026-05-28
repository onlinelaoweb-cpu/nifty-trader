/**
 * yahooFetch.js  →  stooqFetch.js (drop-in replacement)
 * ─────────────────────────────────────────────────────────────────────────────
 * Yahoo Finance is blocked on Railway's egress.
 * This module replaces every Yahoo Finance call with Stooq CSV API, which
 * works on Railway and covers all required Indian + global symbols.
 *
 * Stooq CSV endpoint:
 *   https://stooq.com/q/d/l/?s=<SYMBOL>&i=d          (daily)
 *   https://stooq.com/q/l/?s=<SYMBOL>&f=sd2t2ohlcv   (quote snapshot)
 *
 * Symbol mapping  (Yahoo → Stooq):
 *   ^NSEI        → ^nfu   (Nifty 50 futures proxy) / use nsei.in stooq symbol
 *   ^NSEBANK     → ^nbu
 *   ^CNXIT       → ^nitu (Nifty IT)
 *   ^CNXAUTO     → ^nauto
 *   ^CNXMETAL    → ^nmet
 *   ^INDIAVIX    → ^indiavix
 *   RELIANCE.NS  → RELIANCE.NS  (stooq supports .NS suffix)
 *   ^DJI         → ^dji
 *   ^IXIC        → ^ndq
 *   ^GSPC        → ^spx
 *   ^N225        → ^nkx
 *   ^HSI         → ^hsi
 *   000001.SS    → 000001.sh (Shanghai — stooq uses .sh)
 *   ^GDAXI       → ^dax
 *   ^FTSE        → ^ftm (FTSE 100)
 *   USDINR=X     → usdinr  (stooq forex)
 *   DX-Y.NYB     → ^dxy
 *   CL=F         → cl.f
 *   BZ=F         → bz.f
 *   GC=F         → gc.f
 *   SI=F         → si.f
 */

'use strict';
const axios = require('axios');

// ── Symbol translation table: Yahoo → Stooq ───────────────────────────────
const SYMBOL_MAP = {
    // Indian indices
    '^NSEI'        : '^nfu',
    '%5ENSEI'      : '^nfu',
    '^NSEBANK'     : '^nbu',
    '%5ENSENEXT50' : '^nfm',
    '^CNXIT'       : '^cnxit',
    '^CNXAUTO'     : '^cnxauto',
    '^CNXMETAL'    : '^cnxmetal',
    '^INDIAVIX'    : '^indiavix',
    '%5EINDIAVIX'  : '^indiavix',
    // US indices
    '^DJI'         : '^dji',
    '^IXIC'        : '^ndq',
    '^GSPC'        : '^spx',
    // Asia
    '^N225'        : '^nkx',
    '^HSI'         : '^hsi',
    '000001.SS'    : '000001.sh',
    // Europe
    '^GDAXI'       : '^dax',
    '^FTSE'        : '^ftm',
    // FX
    'USDINR=X'     : 'usdinr',
    'DX-Y.NYB'     : '^dxy',
    // Commodities (futures)
    'CL=F'         : 'cl.f',
    'BZ=F'         : 'bz.f',
    'GC=F'         : 'gc.f',
    'SI=F'         : 'si.f',
};

const STOOQ_BASE = 'https://stooq.com';

const DEFAULT_HEADERS = {
    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer'        : 'https://stooq.com/',
};

/** Decode Yahoo-style symbol (may be URL-encoded) → Stooq symbol */
function toStooq(yahooSymbol) {
    const decoded = decodeURIComponent(yahooSymbol);
    return SYMBOL_MAP[decoded] || SYMBOL_MAP[yahooSymbol] || decoded.toLowerCase().replace('^', '^');
}

/**
 * stooqQuote(symbol)
 * Fetches latest quote snapshot from Stooq's l/ endpoint.
 * Returns { price, prevClose, open, high, low, volume, date } or null.
 *
 * Stooq l/ format:  Date,Time,Open,High,Low,Close,Volume
 * with header line: Symbol,...
 */
async function stooqQuote(symbol, timeoutMs = 12000) {
    const stooqSym = toStooq(symbol);
    // f=sd2t2ohlcv → Symbol, Date, Time, Open, High, Low, Close, Volume
    const url = `${STOOQ_BASE}/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcv&e=csv`;
    try {
        const res = await axios.get(url, { headers: DEFAULT_HEADERS, timeout: timeoutMs, responseType: 'text' });
        const lines = res.data.trim().split('\n').filter(l => l.trim() && !l.startsWith('No data'));
        if (lines.length < 2) {
            console.warn(`[Stooq] ${stooqSym} → no data rows`);
            return null;
        }
        // lines[0] = header, lines[1] = data
        const vals = lines[1].split(',');
        // Symbol,Date,Time,Open,High,Low,Close,Volume
        //   0     1    2    3    4    5    6      7
        const close  = parseFloat(vals[6]);
        const open   = parseFloat(vals[3]);
        const high   = parseFloat(vals[4]);
        const low    = parseFloat(vals[5]);
        const volume = parseInt(vals[7]) || 0;
        if (!close || isNaN(close)) {
            console.warn(`[Stooq] ${stooqSym} → invalid close: ${vals[6]}`);
            return null;
        }
        return { price: close, open, high, low, volume, prevClose: null, date: vals[1] };
    } catch (e) {
        console.warn(`[Stooq] quote ${stooqSym} failed: ${e.message}`);
        return null;
    }
}

/**
 * stooqHistory(symbol, days)
 * Fetches daily OHLCV history from Stooq d/l/ endpoint.
 * Returns array of { date, open, high, low, close, volume } sorted ascending.
 */
async function stooqHistory(symbol, days = 10, timeoutMs = 12000) {
    const stooqSym = toStooq(symbol);
    // Stooq daily CSV — returns last N trading days automatically (no date range needed)
    const url = `${STOOQ_BASE}/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;
    try {
        const res = await axios.get(url, { headers: DEFAULT_HEADERS, timeout: timeoutMs, responseType: 'text' });
        const lines = res.data.trim().split('\n').filter(l => l.trim() && !l.startsWith('Date') && !l.startsWith('No data'));
        if (!lines.length) {
            console.warn(`[Stooq] history ${stooqSym} → empty`);
            return [];
        }
        const rows = lines.map(line => {
            const [date, open, high, low, close, volume] = line.split(',');
            return {
                date,
                open  : parseFloat(open),
                high  : parseFloat(high),
                low   : parseFloat(low),
                close : parseFloat(close),
                volume: parseInt(volume) || 0,
            };
        }).filter(r => r.close && !isNaN(r.close));
        // Stooq returns newest-first; reverse to ascending
        rows.reverse();
        return rows.slice(-days);
    } catch (e) {
        console.warn(`[Stooq] history ${stooqSym} failed: ${e.message}`);
        return [];
    }
}

/**
 * stooqIntraday(symbol, intervalMins, lookbackMins)
 * Fetches intraday bars from Stooq's intraday endpoint.
 * interval: 1, 5, 15, 60 (minutes)
 * Returns array of { ts (unix ms), open, high, low, close, volume } ascending.
 */
async function stooqIntraday(symbol, intervalMins = 1, lookbackMins = 390, timeoutMs = 15000) {
    const stooqSym = toStooq(symbol);
    // Stooq intraday: i=5 (5-min), i=60 (hourly) etc.
    const url = `${STOOQ_BASE}/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=${intervalMins}`;
    try {
        const res = await axios.get(url, { headers: DEFAULT_HEADERS, timeout: timeoutMs, responseType: 'text' });
        const lines = res.data.trim().split('\n').filter(l => l.trim() && !l.startsWith('Date') && !l.startsWith('No data'));
        if (!lines.length) {
            console.warn(`[Stooq] intraday ${stooqSym} ${intervalMins}m → empty`);
            return [];
        }
        const cutoff = Date.now() - lookbackMins * 60 * 1000;
        const bars = [];
        for (const line of lines) {
            const parts = line.split(',');
            // Date, Time, Open, High, Low, Close, Volume
            if (parts.length < 6) continue;
            const [date, time, open, high, low, close, volume] = parts;
            const tsStr = `${date}T${time || '00:00:00'}+05:30`;  // IST
            const ts = new Date(tsStr).getTime();
            const c = parseFloat(close);
            if (!c || isNaN(c)) continue;
            if (ts < cutoff) continue;
            bars.push({
                ts,
                open  : parseFloat(open),
                high  : parseFloat(high),
                low   : parseFloat(low),
                close : c,
                volume: parseInt(volume) || 0,
            });
        }
        // Ensure ascending order
        bars.sort((a, b) => a.ts - b.ts);
        return bars;
    } catch (e) {
        console.warn(`[Stooq] intraday ${stooqSym} ${intervalMins}m failed: ${e.message}`);
        return [];
    }
}

// ── Drop-in replacements for fetchYahooMeta / fetchYahooChart ────────────────

/**
 * fetchYahooMeta(symbol, params)
 * Returns a meta-like object: { regularMarketPrice, previousClose, ... }
 * Compatible with all callers in marketData.js, globalCues.js, breadth.js.
 */
async function fetchYahooMeta(symbol, params = {}) {
    try {
        const quote = await stooqQuote(symbol);
        if (!quote) return null;

        // If we don't have prevClose from the snapshot, fetch from history
        let prevClose = quote.prevClose;
        if (!prevClose) {
            const hist = await stooqHistory(symbol, 3);
            // hist[-1] is today/latest, hist[-2] is previous close
            if (hist.length >= 2) {
                prevClose = hist[hist.length - 2].close;
            } else {
                prevClose = quote.price; // fallback: flat
            }
        }

        return {
            regularMarketPrice : quote.price,
            previousClose      : prevClose,
            chartPreviousClose : prevClose,
            regularMarketOpen  : quote.open,
            regularMarketHigh  : quote.high,
            regularMarketLow   : quote.low,
            regularMarketVolume: quote.volume,
        };
    } catch (e) {
        console.warn(`[Stooq] fetchYahooMeta(${symbol}) failed: ${e.message}`);
        return null;
    }
}

/**
 * fetchYahooChart(symbol, params)
 * Returns a chart-result-like object compatible with marketData.js callers.
 * Uses intraday bars for intraday intervals, daily history otherwise.
 */
async function fetchYahooChart(symbol, params = { interval: '1d', range: '1d' }) {
    try {
        const interval = params.interval || '1d';
        const isIntraday = interval.endsWith('m') || interval === '1h' || interval === '60m';
        const intervalMins = isIntraday
            ? parseInt(interval) || (interval === '1h' || interval === '60m' ? 60 : 1)
            : null;

        // Determine lookback from range
        let lookbackMins = 390; // 1 trading day
        if (params.range === '5d') lookbackMins = 5 * 390;
        if (params.range === '1mo') lookbackMins = 22 * 390;

        let timestamps = [];
        let opens = [], highs = [], lows = [], closes = [], volumes = [];

        if (isIntraday) {
            const bars = await stooqIntraday(symbol, intervalMins, lookbackMins);
            if (!bars.length) return null;
            for (const b of bars) {
                timestamps.push(Math.floor(b.ts / 1000)); // unix seconds (Yahoo compat)
                opens.push(b.open);
                highs.push(b.high);
                lows.push(b.low);
                closes.push(b.close);
                volumes.push(b.volume);
            }
        } else {
            const days = params.range === '10d' ? 10 : params.range === '1mo' ? 22 : 5;
            const hist = await stooqHistory(symbol, days);
            if (!hist.length) return null;
            for (const row of hist) {
                const ts = Math.floor(new Date(row.date + 'T09:15:00+05:30').getTime() / 1000);
                timestamps.push(ts);
                opens.push(row.open);
                highs.push(row.high);
                lows.push(row.low);
                closes.push(row.close);
                volumes.push(row.volume);
            }
        }

        const lastClose = closes[closes.length - 1];
        const prevClose = closes.length >= 2 ? closes[closes.length - 2] : lastClose;

        // Build Yahoo-compatible chart result shape
        return {
            meta: {
                regularMarketPrice : lastClose,
                previousClose      : prevClose,
                chartPreviousClose : prevClose,
            },
            timestamp: timestamps,
            indicators: {
                quote: [{
                    open  : opens,
                    high  : highs,
                    low   : lows,
                    close : closes,
                    volume: volumes,
                }],
            },
        };
    } catch (e) {
        console.warn(`[Stooq] fetchYahooChart(${symbol}) failed: ${e.message}`);
        return null;
    }
}

/** Legacy yahooGet — not used by internal callers but exported for safety */
async function yahooGet(path, params = {}, timeoutMs = 12000) {
    // Extract symbol from path like /v8/finance/chart/%5ENSEI
    const match = path.match(/chart\/([^?]+)/);
    const symbol = match ? decodeURIComponent(match[1]) : path;
    const chart = await fetchYahooChart(symbol, params);
    if (!chart) throw new Error(`[Stooq] no data for ${symbol}`);
    // Wrap in Yahoo envelope shape for any legacy callers
    return { chart: { result: [chart], error: null } };
}

module.exports = { yahooGet, fetchYahooMeta, fetchYahooChart, stooqQuote, stooqHistory, stooqIntraday };
