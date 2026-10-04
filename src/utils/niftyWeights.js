// ── Official Nifty 50 weights — UPDATE THIS FILE ONCE A MONTH ─────────────
// Source: NSE Indices "Nifty 50 Factsheet" (niftyindices.com → Reports → Index
// Factsheet → Nifty 50). Official, free-float market-cap based.
//
// The factsheet only publishes the TOP 10 stocks and the SECTOR weights — not all
// 50 stocks — so that is all this file holds. Nothing here is estimated: every
// number below is copied from the factsheet. Weights drift with prices every day,
// so they are only exact on the factsheet date (`asOf`); the card shows a stale
// warning once they are older than STALE_AFTER_DAYS.
//
// Monthly update (5 minutes): download the new factsheet PDF, send it to Claude,
// get back a replacement of this file, push it. Also re-check the top-10 NAMES
// after each rebalance (cut-offs 31 Jan / 31 Jul, effective end-March / end-Sept):
// if a new stock enters the top 10 it needs a `yahoo` symbol (NSE symbol + ".NS").
//
// Note: this file is used ONLY by the "Who is driving Nifty" card. It does NOT feed
// the breadth/engine weights in breadth.js (kept separate on purpose while the
// Classic-vs-live measurement is running).

const NIFTY_WEIGHTS = {
    asOf: '2026-09-30',
    source: 'NSE Indices Nifty 50 factsheet, 30 Sep 2026',
    staleAfterDays: 45,
    top10: [
        { symbol: 'HDFCBANK',   yahoo: 'HDFCBANK.NS',   name: 'HDFC Bank',      sector: 'Financial Services',          weight: 10.38 },
        { symbol: 'ICICIBANK',  yahoo: 'ICICIBANK.NS',  name: 'ICICI Bank',     sector: 'Financial Services',          weight: 9.05 },
        { symbol: 'RELIANCE',   yahoo: 'RELIANCE.NS',   name: 'Reliance',       sector: 'Oil, Gas & Consumable Fuels', weight: 7.58 },
        { symbol: 'BHARTIARTL', yahoo: 'BHARTIARTL.NS', name: 'Bharti Airtel',  sector: 'Telecommunication',           weight: 5.10 },
        { symbol: 'LT',         yahoo: 'LT.NS',         name: 'L&T',            sector: 'Construction',                weight: 4.20 },
        { symbol: 'SBIN',       yahoo: 'SBIN.NS',       name: 'SBI',            sector: 'Financial Services',          weight: 3.79 },
        { symbol: 'AXISBANK',   yahoo: 'AXISBANK.NS',   name: 'Axis Bank',      sector: 'Financial Services',          weight: 3.37 },
        { symbol: 'INFY',       yahoo: 'INFY.NS',       name: 'Infosys',        sector: 'Information Technology',      weight: 3.35 },
        { symbol: 'KOTAKBANK',  yahoo: 'KOTAKBANK.NS',  name: 'Kotak Bank',     sector: 'Financial Services',          weight: 2.93 },
        { symbol: 'M&M',        yahoo: 'M&M.NS',        name: 'M&M',            sector: 'Automobile and Auto Components', weight: 2.52 },
    ],
    // `indexKey` = key in marketState.global.sectors (the live sector index the app already
    // fetches) used ONLY to show an approximate live move for that sector. Where the app's
    // index is not the same basket as NSE's sector, `proxy` says so — the number is then "~".
    sectors: [
        { name: 'Financial Services',             weight: 37.45, indexKey: 'bankNifty',   proxy: 'Nifty Bank (banks only — NBFCs/insurers/BSE not included)' },
        { name: 'Oil, Gas & Consumable Fuels',    weight: 9.39 },
        { name: 'Information Technology',         weight: 7.52,  indexKey: 'niftyIT' },
        { name: 'Automobile and Auto Components', weight: 6.65,  indexKey: 'niftyAuto' },
        { name: 'Fast Moving Consumer Goods',     weight: 5.50,  indexKey: 'niftyFMCG' },
        { name: 'Telecommunication',              weight: 5.10 },
        { name: 'Metals & Mining',                weight: 4.86,  indexKey: 'niftyMetal' },
        { name: 'Healthcare',                     weight: 4.74,  indexKey: 'niftyPharma', proxy: 'Nifty Pharma (hospitals not included)' },
        { name: 'Construction',                   weight: 4.20 },
        { name: 'Consumer Services',              weight: 3.05 },
        { name: 'Consumer Durables',              weight: 2.85 },
        { name: 'Power',                          weight: 2.59 },
        { name: 'Services',                       weight: 2.42 },
        { name: 'Construction Materials',         weight: 2.34 },
        { name: 'Capital Goods',                  weight: 1.33 },
    ],
};

// Sanity checks that catch a typo when the file is updated (run in tests and logged at boot).
// Returns an array of problems; empty array = file is consistent.
function validateNiftyWeights(w = NIFTY_WEIGHTS) {
    const problems = [];
    const r2 = n => Math.round(n * 100) / 100;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w.asOf || '')) problems.push(`asOf "${w.asOf}" is not YYYY-MM-DD`);
    if (!Array.isArray(w.top10) || w.top10.length !== 10) problems.push(`top10 has ${w.top10?.length} entries, expected 10`);
    const top = w.top10 || [];
    for (let i = 1; i < top.length; i++) if (top[i].weight > top[i - 1].weight) problems.push(`top10 not sorted by weight at ${top[i].symbol}`);
    for (const s of top) {
        if (!(s.weight > 0 && s.weight < 25)) problems.push(`${s.symbol}: implausible weight ${s.weight}`);
        if (!s.yahoo || !/\.NS$/.test(s.yahoo)) problems.push(`${s.symbol}: yahoo symbol missing or not *.NS`);
        if (!w.sectors.some(x => x.name === s.sector)) problems.push(`${s.symbol}: sector "${s.sector}" not in sectors list`);
    }
    const topSum = r2(top.reduce((a, s) => a + s.weight, 0));
    if (topSum < 35 || topSum > 70) problems.push(`top10 sum ${topSum}% looks wrong`);
    const secSum = r2((w.sectors || []).reduce((a, s) => a + s.weight, 0));
    if (Math.abs(secSum - 100) > 0.15) problems.push(`sector weights sum to ${secSum}%, expected ~100`);
    // a stock can never weigh more than the whole of its sector, and the stocks of one sector can't exceed it
    for (const sec of w.sectors || []) {
        const inSec = r2(top.filter(s => s.sector === sec.name).reduce((a, s) => a + s.weight, 0));
        if (inSec > sec.weight + 0.01) problems.push(`${sec.name}: top-10 stocks (${inSec}%) exceed the sector weight (${sec.weight}%)`);
    }
    return problems;
}

module.exports = { NIFTY_WEIGHTS, validateNiftyWeights };