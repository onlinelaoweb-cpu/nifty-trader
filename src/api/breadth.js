'use strict';
// breadth.js — Advance/Decline data for Nifty 50
//
// Strategy (Railway-compatible, 2-tier):
//   Tier 1: fetchNifty50Stocks() from yahooFetch — uses equity-stockIndices endpoint.
//           This is the richest source (all 50 stocks with prices).
//   Tier 2: fetchAllIndices() fallback — allIndices IS working reliably from Railway.
//           It contains Nifty50 sub-indices (NIFTY BANK, NIFTY IT, etc.) that we
//           use as a proxy for sector-level breadth when stock data is unavailable.
//
// The NSE equity-stockIndices endpoint returns 404 from Railway IPs as of May 2026,
// so Tier 2 is the primary live source until NSE fixes their routing.

const { fetchNifty50Stocks, fetchAllIndices } = require('./yahooFetch');

// Weighted Nifty 50 stocks (used with Tier 1 data)
const NIFTY_STOCKS = [
    { symbol: 'RELIANCE',   name: 'RELIANCE',  weight: 9.2 },
    { symbol: 'HDFCBANK',   name: 'HDFC BANK', weight: 8.1 },
    { symbol: 'ICICIBANK',  name: 'ICICI BANK',weight: 7.2 },
    { symbol: 'INFY',       name: 'INFY',      weight: 5.8 },
    { symbol: 'TCS',        name: 'TCS',       weight: 5.1 },
    { symbol: 'KOTAKBANK',  name: 'KOTAK',     weight: 3.9 },
    { symbol: 'LT',         name: 'L&T',       weight: 3.8 },
    { symbol: 'SBIN',       name: 'SBI',       weight: 3.2 },
    { symbol: 'AXISBANK',   name: 'AXIS BANK', weight: 3.0 },
    { symbol: 'BHARTIARTL', name: 'BHARTI',    weight: 2.8 },
    { symbol: 'ITC',        name: 'ITC',       weight: 2.7 },
    { symbol: 'WIPRO',      name: 'WIPRO',     weight: 2.3 },
    { symbol: 'HCLTECH',    name: 'HCL TECH',  weight: 2.2 },
    { symbol: 'MARUTI',     name: 'MARUTI',    weight: 2.1 },
    { symbol: 'BAJFINANCE', name: 'BAJ FIN',   weight: 2.0 },
    { symbol: 'TITAN',      name: 'TITAN',     weight: 1.8 },
    { symbol: 'ASIANPAINT', name: 'ASIAN PAI', weight: 1.7 },
    { symbol: 'NTPC',       name: 'NTPC',      weight: 1.6 },
    { symbol: 'POWERGRID',  name: 'POWERGRID', weight: 1.5 },
    { symbol: 'NESTLEIND',  name: 'NESTLE',    weight: 1.4 },
];

// Sector sub-indices from allIndices — used as Tier 2 breadth proxy
// Each one has a changePct field that tells us sector direction
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

// ── Tier 1: Individual stock breadth ─────────────────────────────────────────
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

    if (fetchedCount < 8) return null;   // not enough data
    return buildResult(advances, declines, unchanged, bullWeight, bearWeight, stocks, 'stocks');
}

// ── Tier 2: Sector index breadth (fallback) ───────────────────────────────────
async function fetchBreadthFromIndices() {
    const allIdx = await fetchAllIndices();
    if (!allIdx || allIdx.length === 0) return null;

    let advances = 0, declines = 0, unchanged = 0, fetchedCount = 0;
    let bullWeight = 0, bearWeight = 0;
    const stocks = [];   // reuse same field name so UI doesn't need changes

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
        stocks, updatedAt: new Date().toISOString()
    };
}

async function fetchAdvanceDecline() {
    try {
        console.log('📊 Fetching A/D data...');
        // Try Tier 1 first (individual stocks)
        const tier1 = await fetchBreadthFromStocks();
        if (tier1) return tier1;
        // Fall back to Tier 2 (sector indices — always works from Railway)
        console.log('📊 Stock data unavailable — using sector indices for A/D');
        return await fetchBreadthFromIndices();
    } catch (err) {
        console.error('A/D fetch error:', err.message);
        return null;
    }
}

module.exports = { fetchAdvanceDecline };