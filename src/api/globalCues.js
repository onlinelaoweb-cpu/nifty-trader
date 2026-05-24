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

// ── Intraday OHLCV fetcher (1-min bars, last N minutes) ──
// Returns array of { time, open, high, low, close, volume } sorted oldest→newest
async function fetchIntradayBars(symbol, intervalMins = 1, lookbackMins = 30) {
    try {
        const range    = lookbackMins <= 60 ? '1d' : '5d';
        const interval = `${intervalMins}m`;
        const res = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
            `?interval=${interval}&range=${range}`,
            {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
                timeout: 8000
            }
        );
        const result = res.data?.chart?.result?.[0];
        if (!result) return [];

        const timestamps = result.timestamp || [];
        const ohlcv      = result.indicators?.quote?.[0] || {};
        const bars = timestamps.map((t, i) => ({
            time   : t * 1000,                   // ms epoch
            open   : ohlcv.open?.[i]   ?? null,
            high   : ohlcv.high?.[i]   ?? null,
            low    : ohlcv.low?.[i]    ?? null,
            close  : ohlcv.close?.[i]  ?? null,
            volume : ohlcv.volume?.[i] ?? 0,
        })).filter(b => b.close !== null);

        // Keep only bars within the lookback window
        const cutoff = Date.now() - lookbackMins * 60 * 1000;
        return bars.filter(b => b.time >= cutoff);
    } catch (e) {
        return [];
    }
}

// ── VWAP calculator from a list of bars ─────────────────
// Standard VWAP: cumSum(typical_price * volume) / cumSum(volume)
// Returns the VWAP value up to (and including) the last bar in the array.
function calcVWAP(bars) {
    let cumPV = 0, cumVol = 0;
    for (const b of bars) {
        const typical = (b.high + b.low + b.close) / 3;
        cumPV  += typical * b.volume;
        cumVol += b.volume;
    }
    return cumVol > 0 ? cumPV / cumVol : null;
}

// ── BankNifty VWAP-cross leading indicator ────────────────
//
//  Logic:
//    1. Fetch 1-min intraday bars for ^NSEBANK.
//    2. Compute VWAP from the session open to NOW.
//    3. Look at the bar that closed ~5 minutes ago ("leading bar").
//    4. If the leading bar's close crossed above VWAP  → bullish lead (+1)
//       If the leading bar's close crossed below VWAP → bearish lead (-1)
//       Otherwise neutral (0)
//    5. Crossing = previous bar was on one side, leading bar is on the other.
//
//  Returns an object:
//    {
//      signal      : +1 | -1 | 0,
//      label       : 'ABOVE_VWAP' | 'BELOW_VWAP' | 'NEUTRAL',
//      crossedAt   : ISO timestamp | null,   // when the cross happened
//      bnPrice     : number | null,           // current BN price
//      vwap        : number | null,           // current session VWAP
//      distancePct : number | null,           // (price-vwap)/vwap*100
//      reason      : string                   // human-readable explanation
//    }
//
async function bankNiftyVWAPLead() {
    const LOOK_BACK_MINS = 390; // full session (6.5 h max) for accurate VWAP
    const LEAD_OFFSET    = 5;   // "5 minutes ago" bar index from the end

    const bars = await fetchIntradayBars('^NSEBANK', 1, LOOK_BACK_MINS);

    const empty = {
        signal: 0, label: 'NEUTRAL', crossedAt: null,
        bnPrice: null, vwap: null, distancePct: null,
        reason: 'Insufficient BankNifty intraday data'
    };

    if (bars.length < LEAD_OFFSET + 2) return empty;

    // Full-session VWAP
    const vwap = calcVWAP(bars);
    if (!vwap) return empty;

    const latest      = bars[bars.length - 1];
    const leadingBar  = bars[bars.length - LEAD_OFFSET];      // ~5 min ago
    const priorBar    = bars[bars.length - LEAD_OFFSET - 1];  // bar before that

    const bnPrice     = parseFloat(latest.close.toFixed(2));
    const vwapR       = parseFloat(vwap.toFixed(2));
    const distancePct = parseFloat(((bnPrice - vwapR) / vwapR * 100).toFixed(3));

    const leadWasAbove  = leadingBar.close  > vwap;
    const priorWasAbove = priorBar.close    > vwap;
    const crossedUp     = !priorWasAbove && leadWasAbove;
    const crossedDown   = priorWasAbove  && !leadWasAbove;

    // Current live position (for label)
    const liveAbove = bnPrice > vwapR;

    if (crossedUp) {
        return {
            signal      :  1,
            label       : 'ABOVE_VWAP',
            crossedAt   : new Date(leadingBar.time).toISOString(),
            bnPrice, vwap: vwapR, distancePct,
            reason      : `BankNifty crossed ABOVE VWAP ~5 min ago (₹${bnPrice} > VWAP ₹${vwapR}) — Bullish lead for Nifty`
        };
    }
    if (crossedDown) {
        return {
            signal      : -1,
            label       : 'BELOW_VWAP',
            crossedAt   : new Date(leadingBar.time).toISOString(),
            bnPrice, vwap: vwapR, distancePct,
            reason      : `BankNifty crossed BELOW VWAP ~5 min ago (₹${bnPrice} < VWAP ₹${vwapR}) — Bearish lead for Nifty`
        };
    }

    // No fresh cross — still report position for context
    return {
        signal      : 0,
        label       : liveAbove ? 'ABOVE_VWAP' : 'BELOW_VWAP',
        crossedAt   : null,
        bnPrice, vwap: vwapR, distancePct,
        reason      : liveAbove
            ? `BankNifty holding above VWAP (₹${bnPrice} vs ₹${vwapR}) — no fresh cross`
            : `BankNifty holding below VWAP (₹${bnPrice} vs ₹${vwapR}) — no fresh cross`
    };
}

// ── Score: +1 bullish, -1 bearish, 0 neutral ─────────
function score(changePct, reverseLogic) {
    if (changePct === null || changePct === undefined) return 0;
    const threshold = 0.3;
    if (reverseLogic) {
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

    // Fetch all in parallel — including BankNifty VWAP lead
    const [
        dow, nasdaq, sp500,
        nikkei, hangseng, shanghai, dax, ftse,
        usdinr, dxy,
        crude, brent, gold, silver,
        banknifty, niftyIT, niftyAuto, niftyMetal,
        bnVWAPLead   // ← NEW
    ] = await Promise.all([
        fetchQuote('^DJI'),
        fetchQuote('^IXIC'),
        fetchQuote('^GSPC'),
        fetchQuote('^N225'),
        fetchQuote('^HSI'),
        fetchQuote('000001.SS'),
        fetchQuote('^GDAXI'),
        fetchQuote('^FTSE'),
        fetchQuote('USDINR=X'),
        fetchQuote('DX-Y.NYB'),
        fetchQuote('CL=F'),
        fetchQuote('BZ=F'),
        fetchQuote('GC=F'),
        fetchQuote('SI=F'),
        fetchQuote('^NSEBANK'),
        fetchQuote('^CNXIT'),
        fetchQuote('^CNXAUTO'),
        fetchQuote('^CNXMETAL'),
        bankNiftyVWAPLead(),   // ← NEW: intraday VWAP-cross detector
    ]);

    // ── Build global state ────────────────────────────
    const globalData = {
        us: {
            dow    : dow    ? { ...dow,    name: 'Dow Jones', score: score(dow?.changePct)    } : null,
            nasdaq : nasdaq ? { ...nasdaq, name: 'NASDAQ',    score: score(nasdaq?.changePct) } : null,
            sp500  : sp500  ? { ...sp500,  name: 'S&P 500',  score: score(sp500?.changePct)  } : null,
        },
        asia: {
            nikkei   : nikkei   ? { ...nikkei,   name: 'Nikkei',    score: score(nikkei?.changePct)   } : null,
            hangseng : hangseng ? { ...hangseng, name: 'Hang Seng', score: score(hangseng?.changePct) } : null,
            shanghai : shanghai ? { ...shanghai, name: 'Shanghai',  score: score(shanghai?.changePct) } : null,
        },
        europe: {
            dax  : dax  ? { ...dax,  name: 'DAX',  score: score(dax?.changePct)  } : null,
            ftse : ftse ? { ...ftse, name: 'FTSE', score: score(ftse?.changePct) } : null,
        },
        currency: {
            usdinr : usdinr ? { ...usdinr, name: 'USD/INR', score: score(usdinr?.changePct, true) } : null,
            dxy    : dxy    ? { ...dxy,    name: 'DXY',     score: score(dxy?.changePct,    true) } : null,
        },
        commodities: {
            crude  : crude  ? { ...crude,  name: 'Crude WTI', score: score(crude?.changePct,  true) } : null,
            brent  : brent  ? { ...brent,  name: 'Brent',     score: score(brent?.changePct,  true) } : null,
            gold   : gold   ? { ...gold,   name: 'Gold',      score: score(gold?.changePct,   true) } : null,
            silver : silver ? { ...silver, name: 'Silver',    score: score(silver?.changePct)       } : null,
        },
        sectors: {
            bankNifty  : banknifty  ? { ...banknifty,  name: 'Bank Nifty',  score: score(banknifty?.changePct)  } : null,
            niftyIT    : niftyIT    ? { ...niftyIT,    name: 'Nifty IT',    score: score(niftyIT?.changePct)    } : null,
            niftyAuto  : niftyAuto  ? { ...niftyAuto,  name: 'Nifty Auto',  score: score(niftyAuto?.changePct)  } : null,
            niftyMetal : niftyMetal ? { ...niftyMetal, name: 'Nifty Metal', score: score(niftyMetal?.changePct) } : null,
        },

        // ── NEW: BankNifty VWAP leading indicator ─────────
        // Populated regardless of market hours; signal=0 when market closed.
        bankNiftyLeadSignal: bnVWAPLead,
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

    // Sectors — HIGH weight (3x)
    if (globalData.sectors.bankNifty) { allScores.push(globalData.sectors.bankNifty.score * 3); allScores.push(globalData.sectors.bankNifty.score * 3); allScores.push(globalData.sectors.bankNifty.score * 3); }
    if (globalData.sectors.niftyIT)   { allScores.push(globalData.sectors.niftyIT.score * 2);   allScores.push(globalData.sectors.niftyIT.score * 2); }
    [globalData.sectors.niftyAuto, globalData.sectors.niftyMetal].forEach(d => {
        if (d) allScores.push(d.score);
    });

    const total   = allScores.reduce((a, b) => a + b, 0);
    const maxPoss = allScores.length;
    const pct     = maxPoss > 0 ? (total / maxPoss) * 100 : 0;

    let globalBias   = 'NEUTRAL';
    let globalScore  = Math.round(50 + pct * 0.5);
    let globalReason = [];

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

    // Key alerts (original)
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

    // ── NEW: BankNifty VWAP-cross alert ───────────────
    const bnLead = globalData.bankNiftyLeadSignal;
    if (bnLead.signal === 1) {
        globalReason.push(`🏦 ${bnLead.reason}`);
    } else if (bnLead.signal === -1) {
        globalReason.push(`🏦 ${bnLead.reason}`);
    }

    globalData.bias      = globalBias;
    globalData.score     = globalScore;
    globalData.reasons   = globalReason;
    globalData.updatedAt = new Date().toISOString();

    // Log summary
    console.log(`🌍 Global: ${globalBias} (score:${globalScore})`);
    if (globalData.currency.usdinr)       console.log(`   USD/INR: ${globalData.currency.usdinr.price} (${globalData.currency.usdinr.changePct}%)`);
    if (globalData.commodities.crude)     console.log(`   Crude: $${globalData.commodities.crude.price} (${globalData.commodities.crude.changePct}%)`);
    if (globalData.sectors.bankNifty)     console.log(`   BankNifty: ${globalData.sectors.bankNifty.price} (${globalData.sectors.bankNifty.changePct}%)`);
    console.log(`   BN VWAP Lead: signal=${bnLead.signal} | ${bnLead.reason}`);

    return globalData;
}

module.exports = { fetchGlobalCues, bankNiftyVWAPLead };
