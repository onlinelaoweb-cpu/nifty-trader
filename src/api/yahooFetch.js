/**
 * yahooFetch.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralised Yahoo Finance fetcher with multi-host fallback.
 *
 * Railway (and some other PaaS) blocks query1.finance.yahoo.com at the egress
 * level. This module tries hosts in order until one succeeds:
 *   1. query2.finance.yahoo.com  (different CDN edge, usually passes Railway)
 *   2. query1.finance.yahoo.com  (original — kept as last resort)
 *
 * All callers (marketData, globalCues, breadth) import from here instead of
 * building their own axios calls, so the fallback logic lives in one place.
 */

'use strict';
const axios = require('axios');

const YAHOO_HOSTS = [
    'https://query2.finance.yahoo.com',
    'https://query1.finance.yahoo.com',
];

const DEFAULT_HEADERS = {
    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept'         : 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * yahooGet(path, params, timeoutMs)
 * Tries each host in YAHOO_HOSTS until one returns a 200 with data.
 * path: e.g. '/v8/finance/chart/%5ENSEI'
 * params: query string object e.g. { interval:'1m', range:'1d' }
 */
async function yahooGet(path, params = {}, timeoutMs = 10000) {
    let lastErr = null;
    for (const host of YAHOO_HOSTS) {
        try {
            const res = await axios.get(`${host}${path}`, {
                params,
                headers: DEFAULT_HEADERS,
                timeout: timeoutMs,
            });
            // Validate we got actual chart data, not an error envelope
            if (res.data?.chart?.result?.[0]) return res.data;
            // Yahoo sometimes returns 200 with an error body
            const errMsg = res.data?.chart?.error?.description || 'Empty result';
            console.warn(`[Yahoo] ${host}${path} → 200 but no data: ${errMsg}`);
        } catch (e) {
            lastErr = e;
            console.warn(`[Yahoo] ${host}${path} failed: ${e.message} — trying next host`);
        }
    }
    throw lastErr || new Error('All Yahoo Finance hosts failed');
}

/**
 * fetchYahooMeta(symbol, params)
 * Returns the `meta` object from a chart response, or null on failure.
 * This is the standard pattern used by marketData, globalCues, breadth.
 */
async function fetchYahooMeta(symbol, params = { interval: '1d', range: '1d' }) {
    try {
        const encoded = encodeURIComponent(symbol);
        const data    = await yahooGet(`/v8/finance/chart/${encoded}`, params);
        return data?.chart?.result?.[0]?.meta || null;
    } catch (e) {
        return null;
    }
}

/**
 * fetchYahooChart(symbol, params)
 * Returns the full chart result[0] (meta + timestamps + indicators), or null.
 * Used by marketData (candles) and globalCues (intraday bars).
 */
async function fetchYahooChart(symbol, params = { interval: '1d', range: '1d' }) {
    try {
        const encoded = encodeURIComponent(symbol);
        const data    = await yahooGet(`/v8/finance/chart/${encoded}`, params);
        return data?.chart?.result?.[0] || null;
    } catch (e) {
        return null;
    }
}

module.exports = { yahooGet, fetchYahooMeta, fetchYahooChart };
