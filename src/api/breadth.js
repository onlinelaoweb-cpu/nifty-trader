'use strict';
// breadth.js — Advance/Decline data for Nifty 50
//
// Strategy (Railway-compatible, 3-tier):
//   Tier 1: Angel One SmartAPI getMarketData — server-designed REST API, no IP block.
//           Returns LTP + percentChange for all 50 Nifty stocks in ONE call.
//           Requires Angel session (injected after login via injectAngelSession()).
//
//   Tier 2: fetchNifty50Stocks() from yahooFetch — uses NSE equity-stockIndices.
//           Blocked by 404/timeout from Railway IPs as of May 2026.
//           Kept as fallback in case NSE ever fixes their routing.
//
//   Tier 3: fetchAllIndices() — allIndices IS working reliably from Railway.
//           Uses Nifty sub-indices (BANK, IT, AUTO, etc.) as sector-level breadth proxy.
//
// SETUP: Call injectAngelSession({ jwtToken, apiKey }) after Angel One login succeeds.
// The Angel session auto-refreshes when the main login re-runs every 24h.

const { fetchNifty50Stocks, fetchAllIndices, fetchNifty50FromYahoo } = require('./yahooFetch');
const axios = require('axios');

// ── Angel One session holder ──────────────────────────────────────────────────
let _angelSession = null;

/**
 * injectAngelSession({ jwtToken, apiKey })
 * Call this right after Angel One login succeeds in server.js / angelOne.js.
 * Example:
 *   const { injectAngelSession } = require('./breadth');
 *   injectAngelSession({ jwtToken: loginData.jwtToken, apiKey: process.env.ANGEL_API_KEY });
 */
function injectAngelSession({ jwtToken, apiKey }) {
    _angelSession = { jwtToken, apiKey };
    console.log('[A/D] ✅ Angel session injected — Tier 1 A/D active');
}

// ── Nifty 50 Angel One NSE instrument tokens ──────────────────────────────────
// Static list — update only when Nifty 50 rebalances (typically Mar/Sep).
// These are NSE segment tokens for Angel One getMarketData API.
const NIFTY50_ANGEL_TOKENS = [
    '3045',   // SBIN
    '1594',   // INFY
    '1660',   // ITC
    '2885',   // RELIANCE
    '5900',   // AXISBANK
    '1348',   // BAJAJ-AUTO
    '16675',  // BAJAJFINSV
    '317',    // BAJFINANCE
    '526',    // BHARTIARTL
    '4963',   // BPCL
    '20374',  // BRITANNIA
    '910',    // CIPLA
    '2303',   // COALINDIA
    '11536',  // DIVISLAB
    '14977',  // DRREDDY
    '1333',   // EICHERMOT
    '2882',   // GRASIM
    '1270',   // HCLTECH
    '1394',   // HDFCBANK
    '1330',   // HEROMOTOCO
    '438',    // HINDALCO
    '1624',   // HINDUNILVR
    '7229',   // ICICIBANK
    '18652',  // INDUSINDBK
    '11630',  // JSWSTEEL
    '1922',   // KOTAKBANK
    '2423',   // LT
    '11483',  // M&M
    '519',    // MARUTI
    '4244',   // NESTLEIND
    '2475',   // NTPC
    '11723',  // ONGC
    '4717',   // POWERGRID
    '3426',   // SUNPHARMA
    '3499',   // TCS
    '3721',   // TATAMOTORS
    '3746',   // TATASTEEL
    '11532',  // TECHM
    '1787',   // TITAN
    '508',    // ULTRACEMCO
    '2142',   // UPL
    '2916',   // WIPRO
    '13538',  // ADANIENT
    '25',     // ADANIPORTS
    '6463',   // APOLLOHOSP
    '20825',  // LTIM
    '21808',  // TATACONSUM
    '467',    // SHRIRAMFIN
    '16669',  // BEL
    '1232',   // ASIANPAINT
];

// Weighted Nifty 50 stocks (used with Tier 1 & Tier 2 data)
const NIFTY_STOCKS = [
    { symbol: 'RELIANCE',   name: 'RELIANCE',   weight: 9.2 },
    { symbol: 'HDFCBANK',   name: 'HDFC BANK',  weight: 8.1 },
    { symbol: 'ICICIBANK',  name: 'ICICI BANK', weight: 7.2 },
    { symbol: 'INFY',       name: 'INFY',       weight: 5.8 },
    { symbol: 'TCS',        name: 'TCS',        weight: 5.1 },
    { symbol: 'KOTAKBANK',  name: 'KOTAK',      weight: 3.9 },
    { symbol: 'LT',         name: 'L&T',        weight: 3.8 },
    { symbol: 'SBIN',       name: 'SBI',        weight: 3.2 },
    { symbol: 'AXISBANK',   name: 'AXIS BANK',  weight: 3.0 },
    { symbol: 'BHARTIARTL', name: 'BHARTI',     weight: 2.8 },
    { symbol: 'ITC',        name: 'ITC',        weight: 2.7 },
    { symbol: 'WIPRO',      name: 'WIPRO',      weight: 2.3 },
    { symbol: 'HCLTECH',    name: 'HCL TECH',   weight: 2.2 },
    { symbol: 'MARUTI',     name: 'MARUTI',     weight: 2.1 },
    { symbol: 'BAJFINANCE', name: 'BAJ FIN',    weight: 2.0 },
    { symbol: 'TITAN',      name: 'TITAN',      weight: 1.8 },
    { symbol: 'ASIANPAINT', name: 'ASIAN PAI',  weight: 1.7 },
    { symbol: 'NTPC',       name: 'NTPC',       weight: 1.6 },
    { symbol: 'POWERGRID',  name: 'POWERGRID',  weight: 1.5 },
    { symbol: 'NESTLEIND',  name: 'NESTLE',     weight: 1.4 },
    // Additional Nifty 50 constituents — weighted by approximate index contribution
    { symbol: 'BAJAJ-AUTO',  name: 'BAJAJ AUTO', weight: 1.4 },
    { symbol: 'BAJAJFINSV',  name: 'BAJ FINSV',  weight: 1.3 },
    { symbol: 'HINDUNILVR',  name: 'HUL',        weight: 1.3 },
    { symbol: 'SUNPHARMA',   name: 'SUN PHARM',  weight: 1.2 },
    { symbol: 'ADANIENT',    name: 'ADANI ENT',  weight: 1.2 },
    { symbol: 'ADANIPORTS',  name: 'ADANI PORTS',weight: 1.1 },
    { symbol: 'ULTRACEMCO',  name: 'ULTRA CEM',  weight: 1.1 },
    { symbol: 'M&M',         name: 'M&M',        weight: 1.0 },
    { symbol: 'TATAMOTORS',  name: 'TATA MOTORS',weight: 1.0 },
    { symbol: 'JSWSTEEL',    name: 'JSW STEEL',  weight: 0.9 },
    { symbol: 'TATASTEEL',   name: 'TATA STEEL', weight: 0.9 },
    { symbol: 'INDUSINDBK',  name: 'INDUSIND',   weight: 0.9 },
    { symbol: 'TECHM',       name: 'TECH M',     weight: 0.8 },
    { symbol: 'ONGC',        name: 'ONGC',       weight: 0.8 },
    { symbol: 'HINDALCO',    name: 'HINDALCO',   weight: 0.8 },
    { symbol: 'GRASIM',      name: 'GRASIM',     weight: 0.8 },
    { symbol: 'DRREDDY',     name: 'DR REDDY',   weight: 0.7 },
    { symbol: 'DIVISLAB',    name: 'DIVIS LAB',  weight: 0.7 },
    { symbol: 'CIPLA',       name: 'CIPLA',      weight: 0.7 },
    { symbol: 'EICHERMOT',   name: 'EICHER',     weight: 0.7 },
    { symbol: 'HEROMOTOCO',  name: 'HERO MOTO',  weight: 0.6 },
    { symbol: 'COALINDIA',   name: 'COAL IND',   weight: 0.6 },
    { symbol: 'BPCL',        name: 'BPCL',       weight: 0.6 },
    { symbol: 'BRITANNIA',   name: 'BRITANNIA',  weight: 0.6 },
    { symbol: 'APOLLOHOSP',  name: 'APOLLO HSP', weight: 0.6 },
    { symbol: 'LTIM',        name: 'LTIMindtree',weight: 0.6 },
    { symbol: 'TATACONSUM',  name: 'TATA CONS',  weight: 0.5 },
    { symbol: 'SHRIRAMFIN',  name: 'SHRIRAM FIN',weight: 0.5 },
    { symbol: 'UPL',         name: 'UPL',        weight: 0.4 },
    { symbol: 'BEL',         name: 'BEL',        weight: 0.4 },
];

// Sector sub-indices from allIndices — used as Tier 3 breadth proxy
const SECTOR_INDICES = [
    { index: 'NIFTY BANK',     name: 'BANK',    weight: 8.0 },
    { index: 'NIFTY IT',       name: 'IT',      weight: 5.5 },
    { index: 'NIFTY AUTO',     name: 'AUTO',    weight: 3.0 },
    { index: 'NIFTY FMCG',    name: 'FMCG',    weight: 2.5 },
    { index: 'NIFTY PHARMA',   name: 'PHARMA',  weight: 2.0 },
    { index: 'NIFTY METAL',    name: 'METAL',   weight: 1.8 },
    { index: 'NIFTY ENERGY',   name: 'ENERGY',  weight: 4.0 },
    { index: 'NIFTY INFRA',    name: 'INFRA',   weight: 2.0 },
    { index: 'NIFTY REALTY',   name: 'REALTY',  weight: 1.0 },
    { index: 'NIFTY MEDIA',    name: 'MEDIA',   weight: 0.8 },
];

// ── Tier 1: Angel One getMarketData — 50 stocks, no IP block ─────────────────
async function fetchBreadthFromAngel() {
    if (!_angelSession?.jwtToken) return null;

    // Angel getMarketData returns an error when the market is closed — skip Tier 1
    // outside trading hours (9:15–15:30 IST) to avoid noisy false failures.
    const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const istMin = istNow.getHours() * 60 + istNow.getMinutes();
    if (istMin < 555 || istMin > 930) {   // outside 9:15–15:30
        console.log('[A/D Tier1] Market closed — skipping Angel getMarketData');
        return null;
    }

    try {
        const res = await axios.post(
            'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/getMarketData',
            {
                mode           : 'FULL',
                exchangeTokens : { NSE: NIFTY50_ANGEL_TOKENS },
            },
            {
                headers: {
                    'Content-Type'     : 'application/json',
                    'Accept'           : 'application/json',
                    'Authorization'    : `Bearer ${_angelSession.jwtToken}`,
                    'X-UserType'       : 'USER',
                    'X-SourceID'       : 'WEB',
                    'X-ClientLocalIP'  : '127.0.0.1',
                    'X-ClientPublicIP' : '127.0.0.1',
                    'X-MACAddress'     : '00:00:00:00:00:00',
                    'X-PrivateKey'     : _angelSession.apiKey || '',
                },
                timeout: 8_000,
            }
        );

        // Detect WAF/firewall HTML block (Angel One blocks Railway IPs sometimes)
        if (typeof res.data === 'string' && res.data.includes('<html')) {
            // Silently fail — this is an IP block, not an API error
            return null;
        }

        // Angel API: status can be boolean true or string 'true' — normalise both.
        // Response shape: { status: true, data: { fetched: [...] } }  (standard)
        //              OR { status: true, data: [...] }                (some versions)
        const apiStatus = res.data?.status === true || res.data?.status === 'true';
        const fetched   = Array.isArray(res.data?.data?.fetched) ? res.data.data.fetched
                        : Array.isArray(res.data?.data)           ? res.data.data
                        : null;

        if (!apiStatus || !fetched) {
            const errMsg = res.data?.message || res.data?.errorcode || `HTTP ${res.status}`;
            const errCode = res.data?.errorcode || res.status;
            console.warn(`[A/D Tier1] Angel API error (${errCode}): ${errMsg}`);
            console.warn('[A/D Tier1] Full response:', JSON.stringify(res.data).substring(0, 200));
            return null;
        }

        const stocks = fetched;
        if (stocks.length < 10) {
            console.warn(`[A/D Tier1] Only ${stocks.length} stocks returned — skipping`);
            return null;
        }

        let advances = 0, declines = 0, unchanged = 0;
        let bullWeight = 0, bearWeight = 0;
        const stockList = [];

        for (const s of stocks) {
            // Angel FULL mode: percentChange = today's % move vs prev close
            const changePct = parseFloat(s.percentChange ?? s.netChange ?? '0');
            const price     = parseFloat(s.ltp ?? s.close ?? 0);
            const symbol    = s.tradingSymbol || s.symbolToken || '';

            // Try to match weight from NIFTY_STOCKS list
            const meta = NIFTY_STOCKS.find(n => symbol.includes(n.symbol));
            const weight = meta?.weight ?? 1.0;
            const name   = meta?.name   ?? symbol;

            let status = 'unchanged';
            if      (changePct >  0.1) { advances++; status = 'up';   bullWeight += weight; }
            else if (changePct < -0.1) { declines++; status = 'down'; bearWeight += weight; }
            else                        { unchanged++; }

            stockList.push({ name, symbol, weight, price, change: 0, changePct, status });
        }

        if ((advances + declines + unchanged) < 10) return null;
        return buildResult(advances, declines, unchanged, bullWeight, bearWeight, stockList, 'angel-nifty50');

    } catch (err) {
        console.warn('[A/D Tier1] Angel fetch error:', err.message);
        return null;
    }
}

// ── Tier 2: Individual stock breadth via NSE (may be blocked on Railway) ─────
async function fetchBreadthFromStocks() {
    const rows = await fetchNifty50Stocks();
    if (!rows || rows.length < 10) return null;

    let advances = 0, declines = 0, unchanged = 0, fetchedCount = 0;
    let bullWeight = 0, bearWeight = 0;
    const stocks = [];

    for (const info of NIFTY_STOCKS) {
        const row = rows.find(r => r.symbol === info.symbol);
        if (!row || !row.lastPrice) continue;
        fetchedCount++;
        const price     = parseFloat(row.lastPrice);
        const prevClose = parseFloat(row.previousClose || price);
        const change    = parseFloat((price - prevClose).toFixed(2));
        const changePct = prevClose > 0 ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
        let status = 'unchanged';
        if      (changePct >  0.1) { advances++; status = 'up';   bullWeight += info.weight; }
        else if (changePct < -0.1) { declines++; status = 'down'; bearWeight += info.weight; }
        else                        { unchanged++; }
        stocks.push({ name: info.name, symbol: info.symbol, weight: info.weight, price, change, changePct, status });
    }

    if (fetchedCount < 8) return null;
    return buildResult(advances, declines, unchanged, bullWeight, bearWeight, stocks, 'stocks');
}

// ── Tier 3: Sector index breadth (most reliable fallback from Railway) ────────
async function fetchBreadthFromIndices() {
    // Retry once on timeout — Railway cold-start can cause first allIndices call to fail
    let allIdx = await fetchAllIndices();
    if (!allIdx || allIdx.length === 0) {
        console.log('[A/D Tier3] First allIndices attempt failed — retrying in 3s...');
        await new Promise(r => setTimeout(r, 3000));
        allIdx = await fetchAllIndices();
    }
    if (!allIdx || allIdx.length === 0) return null;

    let advances = 0, declines = 0, unchanged = 0, fetchedCount = 0;
    let bullWeight = 0, bearWeight = 0;
    const stocks = [];

    for (const info of SECTOR_INDICES) {
        const row = allIdx.find(r => r.index === info.index || r.indexSymbol === info.index);
        if (!row) continue;
        fetchedCount++;
        const price     = parseFloat(row.last || row.previousClose || 0);
        const prevClose = parseFloat(row.previousClose || price);
        const changePct = row.percentChange != null
            ? parseFloat(row.percentChange)
            : (prevClose > 0 ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : 0);
        const change    = parseFloat((price - prevClose).toFixed(2));
        let status = 'unchanged';
        if      (changePct >  0.1) { advances++; status = 'up';   bullWeight += info.weight; }
        else if (changePct < -0.1) { declines++; status = 'down'; bearWeight += info.weight; }
        else                        { unchanged++; }
        stocks.push({ name: info.name, symbol: info.index, weight: info.weight, price, change, changePct, status });
    }

    if (fetchedCount < 4) return null;
    return buildResult(advances, declines, unchanged, bullWeight, bearWeight, stocks, 'sectors');
}

// ── Shared result builder (unchanged — UI compatibility preserved) ────────────
function buildResult(advances, declines, unchanged, bullWeight, bearWeight, stocks, source) {
    stocks.sort((a, b) => b.changePct - a.changePct);
    const total       = advances + declines + unchanged;
    const adRatio     = declines > 0 ? parseFloat((advances / declines).toFixed(2)) : advances > 0 ? 9.99 : 0;
    const breadthPct  = total > 0 ? Math.round((advances / total) * 100) : 50;
    const totalWeight = bullWeight + bearWeight;
    const weightedBull= totalWeight > 0 ? Math.round((bullWeight / totalWeight) * 100) : 50;
    const breadthSignal = breadthPct >= 65 && weightedBull >= 60 ? 'BULLISH'
                        : breadthPct <= 35 && weightedBull <= 40 ? 'BEARISH' : 'NEUTRAL';
    console.log(`✅ A/D (${source}): ${advances}↑ ${declines}↓ ${unchanged}→ | ${breadthSignal}`);
    return {
        advances, declines, unchanged, total: advances + declines,
        adRatio, breadthPct, weightedBull, breadthSignal,
        bullWeight: parseFloat(bullWeight.toFixed(1)),
        bearWeight: parseFloat(bearWeight.toFixed(1)),
        stocks, source, updatedAt: new Date().toISOString()
    };
}

// ── Tier 2.5: Yahoo Finance batch quote (Railway-compatible, no NSE needed) ──
async function fetchBreadthFromYahoo() {
    const rows = await fetchNifty50FromYahoo();
    if (!rows || rows.length < 8) return null;

    let advances = 0, declines = 0, unchanged = 0, fetchedCount = 0;
    let bullWeight = 0, bearWeight = 0;
    const stocks = [];

    for (const info of NIFTY_STOCKS) {
        const row = rows.find(r => r.symbol === info.symbol);
        if (!row || !row.lastPrice) continue;
        fetchedCount++;
        const price     = parseFloat(row.lastPrice);
        const prevClose = parseFloat(row.previousClose || price);
        const change    = parseFloat((price - prevClose).toFixed(2));
        const changePct = prevClose > 0 ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
        let status = 'unchanged';
        if      (changePct >  0.1) { advances++; status = 'up';   bullWeight += info.weight; }
        else if (changePct < -0.1) { declines++; status = 'down'; bearWeight += info.weight; }
        else                        { unchanged++; }
        stocks.push({ name: info.name, symbol: info.symbol, weight: info.weight, price, change, changePct, status });
    }

    if (fetchedCount < 8) return null;
    return buildResult(advances, declines, unchanged, bullWeight, bearWeight, stocks, 'yahoo-stocks');
}

// ── Main export — 4-tier waterfall ────────────────────────────────────────────
async function fetchAdvanceDecline() {
    try {
        console.log('📊 Fetching A/D data...');

        // Tier 1: Angel One (fastest, no IP block, 50 real stocks)
        const tier1 = await fetchBreadthFromAngel();
        if (tier1) return tier1;

        // Tier 2: NSE equity-stockIndices — 404 on Railway IPs as of May 2026.
        // Skipped to avoid 20-second timeout delays; re-enable if NSE fixes routing.
        // const tier2 = await fetchBreadthFromStocks();
        // if (tier2) return tier2;

        // Tier 2.5: Yahoo Finance batch quote (Railway-compatible, 20 weighted stocks)
        console.log('📊 Angel A/D unavailable — trying Yahoo Finance batch...');
        const tier25 = await fetchBreadthFromYahoo();
        if (tier25) return tier25;

        // Tier 3: Sector indices (most reliable fallback from Railway)
        console.log('📊 Yahoo stocks unavailable — using sector indices for A/D');
        return await fetchBreadthFromIndices();

    } catch (err) {
        console.error('A/D fetch error:', err.message);
        return null;
    }
}

module.exports = { fetchAdvanceDecline, injectAngelSession };