const axios = require('axios');

// ── Yahoo Finance fetcher ─────────────────────────────
async function fetchQuote(symbol) {
    try {
        const res = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
            {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
                timeout: 8000
            }
        );
        const meta = res.data?.chart?.result?.[0]?.meta;
        if (!meta || !meta.regularMarketPrice) return null;

        const price     = parseFloat(meta.regularMarketPrice.toFixed(2));
        const prevClose = meta.previousClose || meta.chartPreviousClose || price;
        const change    = parseFloat((price - prevClose).toFixed(2));
        const changePct = prevClose > 0
            ? parseFloat(((change / prevClose) * 100).toFixed(2))
            : 0;

        return { price, prevClose, change, changePct };
    } catch (e) {
        return null;
    }
}

// ── Score: +1 bullish, -1 bearish, 0 neutral ─────────
function score(changePct, reverseLogic) {
    if (changePct === null || changePct === undefined) return 0;
    const threshold = 0.3;
    if (reverseLogic) {
        // e.g. USD/INR — rupee weakening (number going UP) = bearish for market
        if (changePct > threshold)  return -1;
        if (changePct < -threshold) return  1;
    } else {
        if (changePct > threshold)  return  1;
        if (changePct < -threshold) return -1;
    }
    return 0;
}

// ── Main: Fetch all global cues ───────────────────────
async function fetchGlobalCues() {
    console.log('🌍 Fetching global cues...');

    // Fetch all in parallel
    const [
        dow, nasdaq, sp500,
        nikkei, hangseng, shanghai, dax, ftse,
        usdinr, dxy,
        crude, brent, gold, silver,
        banknifty, niftyIT, niftyAuto, niftyMetal
    ] = await Promise.all([
        fetchQuote('^DJI'),       // Dow Jones
        fetchQuote('^IXIC'),      // NASDAQ
        fetchQuote('^GSPC'),      // S&P 500
        fetchQuote('^N225'),      // Nikkei
        fetchQuote('^HSI'),       // Hang Seng
        fetchQuote('000001.SS'),  // Shanghai
        fetchQuote('^GDAXI'),     // DAX Germany
        fetchQuote('^FTSE'),      // FTSE UK
        fetchQuote('USDINR=X'),   // USD/INR
        fetchQuote('DX-Y.NYB'),   // Dollar Index
        fetchQuote('CL=F'),       // Crude Oil WTI
        fetchQuote('BZ=F'),       // Crude Brent
        fetchQuote('GC=F'),       // Gold
        fetchQuote('SI=F'),       // Silver
        fetchQuote('^NSEBANK'),   // Bank Nifty
        fetchQuote('^CNXIT'),     // Nifty IT
        fetchQuote('^CNXAUTO'),   // Nifty Auto
        fetchQuote('^CNXMETAL'),  // Nifty Metal
    ]);

    // ── Build global state ────────────────────────────
    const globalData = {
        // US Markets
        us: {
            dow    : dow    ? { ...dow,    name: 'Dow Jones',  score: score(dow?.changePct)    } : null,
            nasdaq : nasdaq ? { ...nasdaq, name: 'NASDAQ',     score: score(nasdaq?.changePct) } : null,
            sp500  : sp500  ? { ...sp500,  name: 'S&P 500',   score: score(sp500?.changePct)  } : null,
        },
        // Asian Markets
        asia: {
            nikkei   : nikkei   ? { ...nikkei,   name: 'Nikkei',    score: score(nikkei?.changePct)   } : null,
            hangseng : hangseng ? { ...hangseng, name: 'Hang Seng', score: score(hangseng?.changePct) } : null,
            shanghai : shanghai ? { ...shanghai, name: 'Shanghai',  score: score(shanghai?.changePct) } : null,
        },
        // European Markets
        europe: {
            dax  : dax  ? { ...dax,  name: 'DAX',  score: score(dax?.changePct)  } : null,
            ftse : ftse ? { ...ftse, name: 'FTSE', score: score(ftse?.changePct) } : null,
        },
        // Currency
        currency: {
            usdinr : usdinr ? { ...usdinr, name: 'USD/INR', score: score(usdinr?.changePct, true) } : null,
            dxy    : dxy    ? { ...dxy,    name: 'DXY',     score: score(dxy?.changePct,    true) } : null,
        },
        // Commodities
        commodities: {
            crude  : crude  ? { ...crude,  name: 'Crude WTI', score: score(crude?.changePct,  true) } : null,
            brent  : brent  ? { ...brent,  name: 'Brent',     score: score(brent?.changePct,  true) } : null,
            gold   : gold   ? { ...gold,   name: 'Gold',      score: score(gold?.changePct,   true) } : null,
            silver : silver ? { ...silver, name: 'Silver',    score: score(silver?.changePct)  } : null,
        },
        // Indian Sectors
        sectors: {
            bankNifty  : banknifty  ? { ...banknifty,  name: 'Bank Nifty', score: score(banknifty?.changePct)  } : null,
            niftyIT    : niftyIT    ? { ...niftyIT,    name: 'Nifty IT',   score: score(niftyIT?.changePct)    } : null,
            niftyAuto  : niftyAuto  ? { ...niftyAuto,  name: 'Nifty Auto', score: score(niftyAuto?.changePct)  } : null,
            niftyMetal : niftyMetal ? { ...niftyMetal, name: 'Nifty Metal',score: score(niftyMetal?.changePct) } : null,
        }
    };

    // ── Calculate composite bias score ────────────────
    const allScores = [];

    // US Markets — HIGH weight (3x)
    [globalData.us.dow, globalData.us.nasdaq, globalData.us.sp500].forEach(d => {
        if (d) { allScores.push(d.score * 3); allScores.push(d.score * 3); allScores.push(d.score * 3); }
    });

    // Asian Markets — MEDIUM weight (2x)
    [globalData.asia.nikkei, globalData.asia.hangseng, globalData.asia.shanghai].forEach(d => {
        if (d) { allScores.push(d.score * 2); allScores.push(d.score * 2); }
    });

    // European Markets — LOW weight (1x)
    [globalData.europe.dax, globalData.europe.ftse].forEach(d => {
        if (d) allScores.push(d.score);
    });

    // Currency — HIGH weight (2x)
    if (globalData.currency.usdinr) {
        allScores.push(globalData.currency.usdinr.score * 2);
        allScores.push(globalData.currency.usdinr.score * 2);
    }

    // Commodities — MEDIUM weight
    if (globalData.commodities.crude) { allScores.push(globalData.commodities.crude.score * 2); allScores.push(globalData.commodities.crude.score * 2); }
    if (globalData.commodities.gold)  allScores.push(globalData.commodities.gold.score);

    // Sectors — HIGH weight (3x — most direct impact)
    if (globalData.sectors.bankNifty) { allScores.push(globalData.sectors.bankNifty.score * 3); allScores.push(globalData.sectors.bankNifty.score * 3); allScores.push(globalData.sectors.bankNifty.score * 3); }
    if (globalData.sectors.niftyIT)   { allScores.push(globalData.sectors.niftyIT.score * 2);   allScores.push(globalData.sectors.niftyIT.score * 2); }
    [globalData.sectors.niftyAuto, globalData.sectors.niftyMetal].forEach(d => {
        if (d) allScores.push(d.score);
    });

    const total   = allScores.reduce((a, b) => a + b, 0);
    const maxPoss = allScores.length;
    const pct     = maxPoss > 0 ? (total / maxPoss) * 100 : 0;

    let globalBias    = 'NEUTRAL';
    let globalScore   = Math.round(50 + pct * 0.5);
    let globalReason  = [];

    if (pct > 20) {
        globalBias = 'BULLISH';
        globalReason.push('Global cues supportive ✅');
    } else if (pct < -20) {
        globalBias = 'BEARISH';
        globalReason.push('Global cues negative ⚠️');
    } else {
        globalBias = 'NEUTRAL';
        globalReason.push('Mixed global signals');
    }

    // Key alerts
    if (globalData.currency.usdinr?.changePct > 0.5) {
        globalReason.push(`⚠️ Rupee weakening (₹${globalData.currency.usdinr.price}) — FII outflow risk`);
    }
    if (globalData.commodities.crude?.changePct > 1.5) {
        globalReason.push(`⚠️ Crude rising ${globalData.commodities.crude.changePct}% — inflation risk`);
    }
    if (globalData.us.nasdaq?.changePct < -1) {
        globalReason.push(`⚠️ NASDAQ down ${globalData.us.nasdaq.changePct}% — Tech selling`);
    }
    if (globalData.sectors.bankNifty?.changePct > 0.5) {
        globalReason.push(`✅ Bank Nifty +${globalData.sectors.bankNifty.changePct}% — Strong support`);
    }
    if (globalData.sectors.bankNifty?.changePct < -0.5) {
        globalReason.push(`⚠️ Bank Nifty ${globalData.sectors.bankNifty.changePct}% — Weak banks`);
    }
    if (globalData.sectors.niftyIT?.changePct > 1) {
        globalReason.push(`✅ IT Sector +${globalData.sectors.niftyIT.changePct}% — Carrying market`);
    }

    globalData.bias    = globalBias;
    globalData.score   = globalScore;
    globalData.reasons = globalReason;
    globalData.updatedAt = new Date().toISOString();

    // Log summary
    console.log(`🌍 Global: ${globalBias} (score:${globalScore})`);
    if (globalData.currency.usdinr) console.log(`   USD/INR: ${globalData.currency.usdinr.price} (${globalData.currency.usdinr.changePct}%)`);
    if (globalData.commodities.crude) console.log(`   Crude: $${globalData.commodities.crude.price} (${globalData.commodities.crude.changePct}%)`);
    if (globalData.sectors.bankNifty) console.log(`   BankNifty: ${globalData.sectors.bankNifty.price} (${globalData.sectors.bankNifty.changePct}%)`);

    return globalData;
}

module.exports = { fetchGlobalCues };

