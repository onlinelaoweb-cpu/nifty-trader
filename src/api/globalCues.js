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

// FIX (Jun 2026): BN lead signal was firing on EVERY refresh all day (e.g. once BN
// is +1.69%, every 2-min global refresh returned signal=1 and added a bull vote each time).
// Fix: track last confirmed direction. Signal fires only when direction CHANGES
// (neutral→bull, bull→bear, etc). Same direction on next refresh = signal=0 (no repeat vote).
let _bnLastDir = 0;  // 0=neutral, 1=bull, -1=bear — persists across calls

async function bankNiftyVWAPLead() {
    // Uses allIndices quote only — no intraday NSE call (which times out from Railway).
    // Without tick data we can't compute a true VWAP cross, so we use the
    // day's changePct as a directional proxy: >0.3% = above-VWAP-equivalent.
    //
    // FIX (Jun 2026): fetchAllIndices() can silently replay a stale cached row for
    // up to 15 min during a Railway NSE rate-limit backoff (it returns the last good
    // array, not empty, so the BankNifty row is always "found" even when ancient).
    // That made this signal freeze on the same changePct for over an hour.
    // Fix: if the allIndices cache is older than its normal 4-min refresh window,
    // skip it and pull a fresh quote directly from Yahoo instead.
    const empty = { signal: 0, label: 'NEUTRAL', crossedAt: null, bnPrice: null, vwap: null, distancePct: null, reason: 'BankNifty intraday unavailable — using day change proxy' };
    const STALE_AFTER_MS = 4 * 60 * 1000; // matches ALL_INDICES_OK_TTL in yahooFetch.js
    try {
        const { fetchAllIndices, getAllIndicesCacheAge, yahooDirectQuote } = require('./yahooFetch');

        let bnPrice, prevClose, stale = false;

        const cacheAge = getAllIndicesCacheAge();
        if (cacheAge <= STALE_AFTER_MS) {
            const indices = await fetchAllIndices();
            const row = indices.find(r => r.index === 'NIFTY BANK' || r.indexSymbol === 'NIFTY BANK');
            if (row) {
                bnPrice   = parseFloat(row.last || row.previousClose);
                prevClose = parseFloat(row.previousClose || bnPrice);
            }
        }

        // No fresh NSE row (either stale cache or row missing) — go straight to Yahoo.
        if (bnPrice == null || isNaN(bnPrice)) {
            const q = await yahooDirectQuote('%5ENSEBANK');
            if (!q) return empty;
            bnPrice   = q.price;
            prevClose = q.prevClose;
            stale     = true; // means "served via Yahoo fallback", not "data is old"
        }

        const changePct = prevClose > 0 ? parseFloat(((bnPrice - prevClose) / prevClose * 100).toFixed(3)) : 0;
        const sourceTag = stale ? ' (yahoo)' : '';
        const newDir = changePct > 0.3 ? 1 : changePct < -0.3 ? -1 : 0;
        // Only fire a non-zero signal when direction CHANGES — prevents repeated bull/bear
        // votes on every 2-min refresh once BN has established its direction for the day.
        const fireSignal = (newDir !== 0 && newDir !== _bnLastDir) ? newDir : 0;
        _bnLastDir = newDir;
        if (fireSignal === 1)  return { signal:  1, label: 'ABOVE_VWAP', crossedAt: new Date().toISOString(), bnPrice, vwap: null, distancePct: changePct, reason: `BankNifty up ${changePct}% today — Bullish lead for Nifty ✅${sourceTag}` };
        if (fireSignal === -1) return { signal: -1, label: 'BELOW_VWAP', crossedAt: new Date().toISOString(), bnPrice, vwap: null, distancePct: changePct, reason: `BankNifty down ${changePct}% today — Bearish lead for Nifty ⚠️${sourceTag}` };
        return { signal: 0, label: newDir === 1 ? 'ABOVE_VWAP' : newDir === -1 ? 'BELOW_VWAP' : 'NEUTRAL', crossedAt: null, bnPrice, vwap: null, distancePct: changePct, reason: `BankNifty ${changePct > 0 ? '+' : ''}${changePct}% — direction unchanged, no new vote${sourceTag}` };
    } catch (e) { return empty; }
}

// ── Nifty vs BankNifty Correlation Analysis ──────────────────────────────────
// Compares intraday direction and relative strength of Nifty vs BankNifty.
// Returns a correlation object used by AI signals and frontend display.
async function niftyBNCorrelation(niftyChangePct, bnChangePct) {
    try {
        if (niftyChangePct == null || bnChangePct == null) {
            return { status: 'UNAVAILABLE', label: '--', detail: '', multiplier: 1.0, reason: 'Price data unavailable' };
        }

        // Direction agreement
        const niftyDir = niftyChangePct > 0.15 ? 1 : niftyChangePct < -0.15 ? -1 : 0;
        const bnDir    = bnChangePct   > 0.15 ? 1 : bnChangePct   < -0.15 ? -1 : 0;
        const aligned  = niftyDir !== 0 && bnDir !== 0 && niftyDir === bnDir;
        const diverge  = niftyDir !== 0 && bnDir !== 0 && niftyDir !== bnDir;

        // BN leads Nifty — measure relative strength ratio
        // e.g. BN +2.97% vs Nifty +1.99% → BN leading strongly (ratio 1.49)
        const ratio = niftyChangePct !== 0 ? Math.abs(bnChangePct / niftyChangePct) : null;

        // BankNifty sector weight ~34% of Nifty — if BN move >> Nifty, it's driving
        const bnLeading    = ratio != null && ratio >= 1.3 && aligned;
        const bnLagging    = ratio != null && ratio <= 0.7 && aligned;
        const bnDivergence = diverge;

        let status = 'ALIGNED', label = '', detail = '', multiplier = 1.0, reason = '';

        if (bnDivergence) {
            status     = 'DIVERGE';
            label      = '⚡ DIVERGENCE';
            detail     = `BN ${bnChangePct > 0 ? '+' : ''}${bnChangePct.toFixed(2)}% vs Nifty ${niftyChangePct > 0 ? '+' : ''}${niftyChangePct.toFixed(2)}%`;
            multiplier = 0.7;  // reduce signal confidence — mixed tape
            reason     = `⚠️ BankNifty ${bnDir > 0 ? 'bullish' : 'bearish'} while Nifty ${niftyDir > 0 ? 'bullish' : 'bearish'} — conflicting signals`;
        } else if (bnLeading) {
            status     = 'BN_LEADING';
            label      = `🏦 BN LEADING`;
            detail     = `BN ${bnChangePct > 0 ? '+' : ''}${bnChangePct.toFixed(2)}% vs Nifty ${niftyChangePct > 0 ? '+' : ''}${niftyChangePct.toFixed(2)}%`;
            multiplier = 1.2;  // amplify — BN confirming & leading move
            reason     = `🏦 BankNifty leading Nifty (${Math.round((ratio-1)*100)}% stronger) — high conviction ${bnDir > 0 ? 'bullish' : 'bearish'}`;
        } else if (bnLagging) {
            status     = 'BN_LAGGING';
            label      = `🔶 BN LAGGING`;
            detail     = `BN ${bnChangePct > 0 ? '+' : ''}${bnChangePct.toFixed(2)}% vs Nifty ${niftyChangePct > 0 ? '+' : ''}${niftyChangePct.toFixed(2)}%`;
            multiplier = 0.85; // mild reduction — move missing bank participation
            reason     = `⚠️ Nifty moving but BankNifty lagging — weak conviction without banking support`;
        } else if (aligned) {
            status     = 'ALIGNED';
            label      = `✅ ALIGNED`;
            detail     = `BN ${bnChangePct > 0 ? '+' : ''}${bnChangePct.toFixed(2)}% / Nifty ${niftyChangePct > 0 ? '+' : ''}${niftyChangePct.toFixed(2)}%`;
            multiplier = 1.0;
            reason     = `✅ BankNifty & Nifty aligned — confirming move`;
        } else {
            // One or both near flat
            status     = 'FLAT';
            label      = `— FLAT`;
            detail     = `BN ${bnChangePct > 0 ? '+' : ''}${bnChangePct.toFixed(2)}% / Nifty ${niftyChangePct > 0 ? '+' : ''}${niftyChangePct.toFixed(2)}%`;
            multiplier = 1.0;
            reason     = `Both indices near flat — no directional lead`;
        }

        return { status, label, detail, multiplier, reason, bnChangePct, niftyChangePct, ratio: ratio ? parseFloat(ratio.toFixed(2)) : null };
    } catch (e) {
        return { status: 'UNAVAILABLE', label: '--', detail: '', multiplier: 1.0, reason: 'Correlation error: ' + e.message };
    }
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

    // ── Nifty vs BankNifty correlation ────────────────────────────────────────
    // Uses today's changePct from both indices (already fetched above).
    // niftySpot changePct comes from GIFT Nifty proxy (same symbol used for pre-market)
    const niftySpotPct = giftNifty?.changePct ?? null;
    const bnPct        = banknifty?.changePct ?? null;
    const bnCorrelation = await niftyBNCorrelation(niftySpotPct, bnPct);
    globalData.bnCorrelation = bnCorrelation;

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
    // Add BN correlation context to reasons
    if (bnCorrelation.status === 'DIVERGE')    reasons.push(bnCorrelation.reason);
    if (bnCorrelation.status === 'BN_LEADING') reasons.push(bnCorrelation.reason);

    Object.assign(globalData, { bias: globalBias, score: globalScore, reasons, updatedAt: new Date().toISOString() });
    console.log(`🌍 Global: ${globalBias} (score:${globalScore})`);
    if (globalData.sectors.bankNifty) console.log(`   BankNifty: ${globalData.sectors.bankNifty.price} (${globalData.sectors.bankNifty.changePct}%)`);
    console.log(`   BN VWAP Lead: signal=${bnVWAPLead.signal} | ${bnVWAPLead.reason}`);
    return globalData;
}

module.exports = { fetchGlobalCues, bankNiftyVWAPLead, niftyBNCorrelation };