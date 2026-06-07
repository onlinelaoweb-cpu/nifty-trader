'use strict';
const { fetchYahooMeta, fetchYahooChart } = require('./yahooFetch');

async function fetchQuote(symbol) {
    try {
        const meta = await fetchYahooMeta(symbol);
        if (!meta || !meta.regularMarketPrice) return null;
        const price     = parseFloat(meta.regularMarketPrice.toFixed(2));
        const prevClose = meta.previousClose || meta.chartPreviousClose || price;
        const change    = parseFloat((price - prevClose).toFixed(2));
        const changePct = prevClose > 0 ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
        return { price, prevClose, change, changePct };
    } catch (e) { return null; }
}

async function fetchIntradayBars(symbol, intervalMins = 1, lookbackMins = 30) {
    try {
        const range  = lookbackMins <= 60 ? '1d' : '5d';
        const result = await fetchYahooChart(symbol, { interval: `${intervalMins}m`, range });
        if (!result) return [];
        const timestamps = result.timestamp || [];
        const ohlcv      = result.indicators?.quote?.[0] || {};
        const bars = timestamps.map((t, i) => ({
            time  : t * 1000,
            open  : ohlcv.open?.[i]   ?? null,
            high  : ohlcv.high?.[i]   ?? null,
            low   : ohlcv.low?.[i]    ?? null,
            close : ohlcv.close?.[i]  ?? null,
            volume: ohlcv.volume?.[i] ?? 0,
        })).filter(b => b.close !== null);
        const cutoff = Date.now() - lookbackMins * 60 * 1000;
        return bars.filter(b => b.time >= cutoff);
    } catch (e) { return []; }
}

function calcVWAP(bars) {
    let cumPV = 0, cumVol = 0;
    for (const b of bars) {
        const typical = (b.high + b.low + b.close) / 3;
        cumPV  += typical * b.volume;
        cumVol += b.volume;
    }
    return cumVol > 0 ? cumPV / cumVol : null;
}

async function bankNiftyVWAPLead() {
    // Uses allIndices quote only — no intraday NSE call (which times out from Railway).
    // Without tick data we can't compute a true VWAP cross, so we use the
    // day's changePct as a directional proxy: >0.3% = above-VWAP-equivalent.
    const empty = { signal: 0, label: 'NEUTRAL', crossedAt: null, bnPrice: null, vwap: null, distancePct: null, reason: 'BankNifty intraday unavailable — using day change proxy' };
    try {
        const { fetchAllIndices } = require('./yahooFetch');
        const indices = await fetchAllIndices();
        const row = indices.find(r => r.index === 'NIFTY BANK' || r.indexSymbol === 'NIFTY BANK');
        if (!row) return empty;
        const bnPrice   = parseFloat(row.last || row.previousClose);
        const prevClose = parseFloat(row.previousClose || bnPrice);
        const changePct = prevClose > 0 ? parseFloat(((bnPrice - prevClose) / prevClose * 100).toFixed(3)) : 0;
        if (changePct > 0.3)  return { signal:  1, label: 'ABOVE_VWAP', crossedAt: null, bnPrice, vwap: null, distancePct: changePct, reason: `BankNifty up ${changePct}% today — Bullish lead for Nifty ✅` };
        if (changePct < -0.3) return { signal: -1, label: 'BELOW_VWAP', crossedAt: null, bnPrice, vwap: null, distancePct: changePct, reason: `BankNifty down ${changePct}% today — Bearish lead for Nifty ⚠️` };
        return { signal: 0, label: 'NEUTRAL', crossedAt: null, bnPrice, vwap: null, distancePct: changePct, reason: `BankNifty flat ${changePct}% — no directional lead` };
    } catch (e) { return empty; }
}

function score(changePct, reverseLogic) {
    if (changePct == null) return 0;
    const t = 0.3;
    if (reverseLogic) { if (changePct > t) return -1; if (changePct < -t) return 1; }
    else              { if (changePct > t) return  1; if (changePct < -t) return -1; }
    return 0;
}

async function fetchGlobalCues() {
    console.log('🌍 Fetching global cues...');
    const [
        dow, nasdaq, sp500, nikkei, hangseng, shanghai, dax, ftse,
        usdinr, dxy, crude, brent, gold, silver,
        banknifty, niftyIT, niftyAuto, niftyMetal,
        giftNifty, bnVWAPLead,
        niftyPharma, niftyFMCG, niftyRealty, niftyMedia, niftyEnergy, niftyInfra, niftyPSUBank,
    ] = await Promise.all([
        fetchQuote('^DJI'), fetchQuote('^IXIC'), fetchQuote('^GSPC'),
        fetchQuote('^N225'), fetchQuote('^HSI'), fetchQuote('000001.SS'),
        fetchQuote('^GDAXI'), fetchQuote('^FTSE'),
        fetchQuote('USDINR=X'), fetchQuote('DX-Y.NYB'),
        fetchQuote('CL=F'), fetchQuote('BZ=F'), fetchQuote('GC=F'), fetchQuote('SI=F'),
        fetchQuote('^NSEBANK'), fetchQuote('^CNXIT'), fetchQuote('^CNXAUTO'), fetchQuote('^CNXMETAL'),
        fetchQuote('%5ENSEI'),   // GIFT Nifty — use Nifty spot as pre-market proxy (no reliable futures symbol on Yahoo)
        bankNiftyVWAPLead(),
        // Extended sectors for heatmap (fetched in parallel, no extra latency)
        fetchQuote('^CNXPHARMA'), fetchQuote('^CNXFMCG'), fetchQuote('^CNXREALTY'),
        fetchQuote('^CNXMEDIA'),  fetchQuote('^CNXENERGY'),fetchQuote('^CNXINFRA'),
        fetchQuote('^CNXPSUBANK'),
    ]);

    const mk = (d, name, rev) => d ? { ...d, name, score: score(d.changePct, rev) } : null;
    const globalData = {
        us         : { dow: mk(dow,'Dow Jones'), nasdaq: mk(nasdaq,'NASDAQ'), sp500: mk(sp500,'S&P 500') },
        asia       : { giftNifty: mk(giftNifty,'GIFT Nifty'), nikkei: mk(nikkei,'Nikkei'), hangseng: mk(hangseng,'Hang Seng'), shanghai: mk(shanghai,'Shanghai') },
        europe     : { dax: mk(dax,'DAX'), ftse: mk(ftse,'FTSE') },
        currency   : { usdinr: mk(usdinr,'USD/INR',true), dxy: mk(dxy,'DXY',true) },
        commodities: { crude: mk(crude,'Crude WTI',true), brent: mk(brent,'Brent',true), gold: mk(gold,'Gold',true), silver: mk(silver,'Silver') },
        sectors    : {
            bankNifty : mk(banknifty,'Bank Nifty'),  niftyIT  : mk(niftyIT,  'Nifty IT'),
            niftyAuto : mk(niftyAuto,'Nifty Auto'),  niftyMetal: mk(niftyMetal,'Nifty Metal'),
            niftyPharma : mk(niftyPharma, 'Nifty Pharma'),  niftyFMCG   : mk(niftyFMCG,   'Nifty FMCG'),
            niftyRealty : mk(niftyRealty, 'Nifty Realty'),  niftyMedia  : mk(niftyMedia,  'Nifty Media'),
            niftyEnergy : mk(niftyEnergy, 'Nifty Energy'),  niftyInfra  : mk(niftyInfra,  'Nifty Infra'),
            niftyPSUBank: mk(niftyPSUBank,'PSU Bank'),
        },
        bankNiftyLeadSignal: bnVWAPLead,
    };

    const allScores = [];
    [globalData.us.dow, globalData.us.nasdaq, globalData.us.sp500].forEach(d => { if (d) { allScores.push(d.score*3,d.score*3,d.score*3); } });
    [globalData.asia.nikkei, globalData.asia.hangseng, globalData.asia.shanghai].forEach(d => { if (d) { allScores.push(d.score*2,d.score*2); } });
    [globalData.europe.dax, globalData.europe.ftse].forEach(d => { if (d) allScores.push(d.score); });
    if (globalData.currency.usdinr) allScores.push(globalData.currency.usdinr.score*2, globalData.currency.usdinr.score*2);
    if (globalData.commodities.crude) allScores.push(globalData.commodities.crude.score*2, globalData.commodities.crude.score*2);
    if (globalData.commodities.gold)  allScores.push(globalData.commodities.gold.score);
    if (globalData.sectors.bankNifty) allScores.push(globalData.sectors.bankNifty.score*3, globalData.sectors.bankNifty.score*3, globalData.sectors.bankNifty.score*3);
    if (globalData.sectors.niftyIT)   allScores.push(globalData.sectors.niftyIT.score*2, globalData.sectors.niftyIT.score*2);
    [globalData.sectors.niftyAuto, globalData.sectors.niftyMetal].forEach(d => { if (d) allScores.push(d.score); });

    const pct = allScores.length > 0 ? (allScores.reduce((a,b)=>a+b,0) / allScores.length) * 100 : 0;
    const globalBias  = pct > 20 ? 'BULLISH' : pct < -20 ? 'BEARISH' : 'NEUTRAL';
    const globalScore = Math.round(50 + pct * 0.5);
    const reasons     = [pct > 20 ? 'Global cues supportive ✅' : pct < -20 ? 'Global cues negative ⚠️' : 'Mixed global signals'];

    if (globalData.currency.usdinr?.changePct > 0.5)  reasons.push(`⚠️ Rupee weakening (₹${globalData.currency.usdinr.price}) — FII outflow risk`);
    if (globalData.commodities.crude?.changePct > 1.5) reasons.push(`⚠️ Crude rising ${globalData.commodities.crude.changePct}% — inflation risk`);
    if (globalData.us.nasdaq?.changePct < -1)          reasons.push(`⚠️ NASDAQ down ${globalData.us.nasdaq.changePct}% — Tech selling`);
    if (globalData.sectors.bankNifty?.changePct > 0.5) reasons.push(`✅ Bank Nifty +${globalData.sectors.bankNifty.changePct}% — Strong support`);
    if (globalData.sectors.bankNifty?.changePct < -0.5)reasons.push(`⚠️ Bank Nifty ${globalData.sectors.bankNifty.changePct}% — Weak banks`);
    if (globalData.sectors.niftyIT?.changePct > 1)     reasons.push(`✅ IT Sector +${globalData.sectors.niftyIT.changePct}% — Carrying market`);
    if (bnVWAPLead.signal !== 0) reasons.push(`🏦 ${bnVWAPLead.reason}`);

    Object.assign(globalData, { bias: globalBias, score: globalScore, reasons, updatedAt: new Date().toISOString() });
    console.log(`🌍 Global: ${globalBias} (score:${globalScore})`);
    if (globalData.sectors.bankNifty) console.log(`   BankNifty: ${globalData.sectors.bankNifty.price} (${globalData.sectors.bankNifty.changePct}%)`);
    console.log(`   BN VWAP Lead: signal=${bnVWAPLead.signal} | ${bnVWAPLead.reason}`);
    return globalData;
}

module.exports = { fetchGlobalCues, bankNiftyVWAPLead };