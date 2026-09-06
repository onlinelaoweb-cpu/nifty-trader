'use strict';
// volumeScanner.js — Phase 2 (6 Sep) of the volume-scanner feature.
//
// PURPOSE:
//   Flag F&O stocks trading unusual CASH-MARKET volume today vs their own
//   20-day average — a classic "something's happening in this stock" signal
//   for investing/trading, separate from the NIFTY/CRUDEOIL options engine.
//
// HOW IT WORKS:
//   1. Baseline (once/day): Angel's historical candle API, per stock, last
//      ~30 calendar days of daily candles → 20-day average volume. Angel
//      rate-limits historical calls (~3/sec) so this runs sequentially,
//      throttled, in the background — takes ~1-2 min for ~200 stocks.
//   2. Live (every 1-2 min, market hours only): Angel's getMarketData —
//      same bulk-quote endpoint breadth.js already uses for the Nifty 50
//      A/D panel — batched 50 tokens/call, so ~200 stocks = ~4 calls.
//   3. ratio = today's live volume / 20-day average. Sorted list of stocks
//      with the highest ratio = the scanner's output.
//
// Phase 1 (getFnOStockList in nseData.js) supplies the stock universe +
// tokens this module tracks. Fully standalone — does not touch the NIFTY
// WS feed, PCR, or any existing signal logic.

const axios = require('axios');

// ── Angel session (same pattern as breadth.js / nseData.js) ──────────────────
let _angelSession = null;
function injectAngelSession({ jwtToken, apiKey }) {
    _angelSession = { jwtToken, apiKey };
    console.log('[VolScan] ✅ Angel session injected');
}

function angelHeaders() {
    return {
        'Content-Type'     : 'application/json',
        'Accept'           : 'application/json',
        'Authorization'    : `Bearer ${_angelSession.jwtToken}`,
        'X-UserType'       : 'USER',
        'X-SourceID'       : 'WEB',
        'X-ClientLocalIP'  : '127.0.0.1',
        'X-ClientPublicIP' : '127.0.0.1',
        'X-MACAddress'     : '00:00:00:00:00:00',
        'X-PrivateKey'     : _angelSession.apiKey || '',
    };
}

// ── In-memory state ───────────────────────────────────────────────────────────
// Map<name, { token, symbol, baseline20d, liveVolume, ltp, pctChange, ratio, lastLiveAt }>
const _stockState   = new Map();
let _baselineDate    = null;   // YYYY-MM-DD — baselines computed once/day
let _baselineRunning = false;  // guard against overlapping runs

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Baseline: 20-day average volume per stock, via Angel historical candles ──
async function fetchStockDailyVolumes(token) {
    const to   = new Date();
    const from = new Date(to.getTime() - 32 * 24 * 60 * 60 * 1000); // ~32 calendar days back → ~20+ trading days
    const fmt  = (d) => {
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} 09:15`;
    };
    const res = await axios.post(
        'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData',
        {
            exchange    : 'NSE',
            symboltoken : String(token),
            interval    : 'ONE_DAY',
            fromdate    : fmt(from),
            todate      : fmt(to),
        },
        { headers: angelHeaders(), timeout: 10_000 }
    );
    if (!res.data?.status || !Array.isArray(res.data?.data)) return [];
    // Each row: [timestamp, open, high, low, close, volume]
    return res.data.data.map(row => Number(row[5]) || 0).filter(v => v > 0);
}

// Runs once per day (guarded by _baselineDate) — sequential + throttled to
// respect Angel's historical-API rate limit (~3 req/sec). ~200 stocks at
// 400ms apart ≈ 80s total; runs in the background, doesn't block anything.
async function refreshVolumeBaselines(stockList) {
    const today = new Date().toISOString().slice(0, 10);
    if (_baselineDate === today || _baselineRunning) return;
    if (!_angelSession?.jwtToken) { console.warn('[VolScan] No Angel session — skipping baseline refresh'); return; }

    _baselineRunning = true;
    console.log(`[VolScan] Refreshing 20-day volume baselines for ${stockList.length} stocks...`);
    let ok = 0, failed = 0;
    for (const stock of stockList) {
        try {
            const vols = await fetchStockDailyVolumes(stock.token);
            // Exclude today's (possibly still-forming) candle if present — use the
            // most recent 20 COMPLETE days.
            const last20 = vols.slice(0, -1).slice(-20);
            const usable = last20.length >= 5 ? last20 : vols.slice(-20); // fallback if too few
            const avg = usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : null;

            if (!_stockState.has(stock.name)) _stockState.set(stock.name, {});
            const st = _stockState.get(stock.name);
            st.token = stock.token; st.symbol = stock.symbol; st.name = stock.name;
            st.baseline20d = avg;
            ok++;
        } catch (e) {
            failed++;
        }
        await sleep(400); // throttle — stay well under Angel's historical rate limit
    }
    _baselineDate = today;
    _baselineRunning = false;
    console.log(`[VolScan] Baselines done: ${ok} ok, ${failed} failed`);
}

// ── Live: today's volume + LTP, via Angel getMarketData (bulk, same pattern
// breadth.js already uses safely for the Nifty 50 A/D panel) ─────────────────
async function refreshLiveVolumes(stockList) {
    if (!_angelSession?.jwtToken) return;
    const batches = chunk(stockList.map(s => s.token), 50);

    for (const batch of batches) {
        try {
            const res = await axios.post(
                'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/getMarketData',
                { mode: 'FULL', exchangeTokens: { NSE: batch } },
                { headers: angelHeaders(), timeout: 8_000 }
            );
            if (typeof res.data === 'string' && res.data.includes('<html')) {
                console.warn('[VolScan] Angel getMarketData HTML block (IP throttled) — skipping this batch');
                continue;
            }
            const fetched = Array.isArray(res.data?.data?.fetched) ? res.data.data.fetched
                          : Array.isArray(res.data?.data)           ? res.data.data
                          : [];
            for (const item of fetched) {
                const token  = String(item.symbolToken || item.symboltoken || '');
                const match  = stockList.find(s => String(s.token) === token);
                if (!match) continue;
                const st = _stockState.get(match.name) || { token: match.token, symbol: match.symbol, name: match.name };
                st.liveVolume = Number(item.tradeVolume ?? item.totalTradedVolume ?? item.volume ?? 0);
                st.ltp        = Number(item.ltp ?? item.lastPrice ?? 0);
                st.pctChange  = Number(item.percentChange ?? item.pChange ?? 0);
                st.lastLiveAt = Date.now();
                _stockState.set(match.name, st);
            }
        } catch (e) {
            console.warn('[VolScan] Live volume batch error:', e.message);
        }
    }
}

// ── Public: scanner snapshot, sorted by volume ratio descending ──────────────
// minRatio filters out noise (e.g. 1.2x isn't "unusual") — default 2x.
function getVolumeScannerSnapshot(minRatio = 2) {
    const rows = [];
    for (const st of _stockState.values()) {
        if (!st.baseline20d || !st.liveVolume) continue;
        const ratio = st.liveVolume / st.baseline20d;
        if (ratio >= minRatio) {
            rows.push({
                name: st.name, symbol: st.symbol, ltp: st.ltp, pctChange: st.pctChange,
                liveVolume: st.liveVolume, baseline20d: Math.round(st.baseline20d),
                ratio: parseFloat(ratio.toFixed(2)),
            });
        }
    }
    rows.sort((a, b) => b.ratio - a.ratio);
    return rows;
}

function getVolumeScannerStatus() {
    return {
        stocksTracked  : _stockState.size,
        baselineDate   : _baselineDate,
        baselineRunning: _baselineRunning,
    };
}

module.exports = {
    injectAngelSession,
    refreshVolumeBaselines,
    refreshLiveVolumes,
    getVolumeScannerSnapshot,
    getVolumeScannerStatus,
};