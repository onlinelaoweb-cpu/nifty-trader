require('dotenv').config();

const express  = require('express');
const http     = require('http');
const cors     = require('cors');
const axios    = require('axios');

const loginAngel                    = require('./src/api/angelAuth');
const startWebSocket                = require('./src/api/websocket');
const { processIndicators,
        initializeHistory,
        getCandleHistory,
        getSessionCandles,
        loadCandlesFromYahoo }      = require('./src/api/indicators');
const { fetchMarketData }           = require('./src/api/marketData');
const { analyzeMultiTimeframe }     = require('./src/api/multiTimeframe');
const { fetchGlobalCues }           = require('./src/api/globalCues');
const { fetchAdvanceDecline,
        injectAngelSession }        = require('./src/api/breadth');
const { calculateSRLevels }         = require('./src/api/levels');
const {
    startNSEScheduler,
    getPCRState, getFIIState, getOIBuildupState, getEarlyMomState,
    getCurrentFIINet, getCurrentDIINet,
    interpretEarlyMomentum, interpretOIBuildup,
    isExpiryDay,
} = require('./src/api/nseData');
const {
    sendSignalAlert, sendMTFAlert,
    sendMorningSummary, sendVIXAlert,
    sendCloseSummary, sendExitAlert, isConfigured
}                                   = require('./src/api/telegram');

const app    = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json());
app.use(express.static('public', { etag: false, maxAge: 0 }));

const PORT    = process.env.PORT || 8080;
const LOT_SIZE = 75;   // Nifty 50 lot size (updated Nov 2024 by SEBI: 50 → 75)

// ── Market State ──────────────────────────────────────
let marketState = {
    nifty: 0, change: 0, changePct: 0,
    signal: 'WAIT', confidence: 0,
    rsi: null, ema9: null, ema21: null, vwap: null,
    pcr: null, atmPcr: null, pcrSignal: 'N/A', atmPcrSignal: 'N/A',
    pcrSource: 'manual', // 'auto' when NSE fetch succeeds
    vix: null, vixChange: null, vixSignal: 'N/A', vixNote: '', strikeRange: 'ATM ±200',
    mtf: {
        signal: 'WAIT', strength: 'WEAK', confidence: 0,
        aligned: false, bullCount: 0, bearCount: 0,
        tf5m:  { rsi:null,ema9:null,ema21:null,vwap:null,signal:'NEUTRAL',score:50 },
        tf15m: { rsi:null,ema9:null,ema21:null,vwap:null,signal:'NEUTRAL',score:50 },
        tf1h:  { rsi:null,ema9:null,ema21:null,vwap:null,signal:'NEUTRAL',score:50 }
    },
    global: {
        bias:'NEUTRAL', score:50, reasons:['Loading...'],
        updatedAt:null, us:{}, asia:{}, europe:{}, currency:{}, commodities:{}, sectors:{}
    },
    breadth: {
        advances:0, declines:0, unchanged:0, total:0,
        adRatio:0, breadthPct:50, weightedBull:50,
        breadthSignal:'NEUTRAL', bullWeight:0, bearWeight:0,
        stocks:[], updatedAt:null
    },
    srLevels: null,
    maxPain: { strike: null, expiryDay: false, totalPain: null, updatedAt: null },
    pcrHistory: [],
    fii: { buy:null, sell:null, net:null },
    dii: { buy:null, sell:null, net:null },
    optionFlow: { atmCEpremium:null, atmPEpremium:null, ceChange:0, peChange:0, dominance:'NEUTRAL', history:[] },
    reason: ['Waiting...'], lastUpdated:null, connected:false, source:'none', dataPoints:0,
    adx: null,
    earlyMom: { score: null, signal: 'NEUTRAL', strength: 0, label: 'Early Momentum — awaiting data', votes: [] },
    oiBuildup: { signal: 'NEUTRAL', strength: 0, label: 'OI Buildup — awaiting data', maxCEoiStrike: null, maxPEoiStrike: null, totalCEoiChange: null, totalPEoiChange: null },
    entryWindow: { status:'closed', label:'Market Closed', safe:false },
    qualityGate: { mtfAligned:false, rsiClean:true, safeWindow:false, vixSafe:true, adxTrend:true, srClear:true, passed:false },
    calendarEvents: []
};

// ── Trade Journal ─────────────────────────────────────
let trades       = [];
let tradeCounter = 1;
let events       = [];

// ── Helpers ───────────────────────────────────────────
let historyLoaded=false, prevSignal='WAIT', prevMTFAligned=false;
let morningSummarySent=false, closeSummarySent=false, vixAlertSent=false;
let pcrClearedToday=false;   // guards the one-shot stale-manual-PCR wipe at 09:15

function isMarketOpen() {
    const ist = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}));
    const m   = ist.getHours()*60 + ist.getMinutes();
    return m >= 555 && m <= 930;
}
function getIST() { return new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'})); }
function isSafeEntryWindow() {
    const ist = getIST();
    const m   = ist.getHours()*60 + ist.getMinutes();
    if (m < 555) return { status:'pre',      label:'Pre-Open',                safe:false, reason:'Market not open yet' };
    if (m < 570) return { status:'volatile', label:'Volatile (9:15–9:30)',    safe:false, reason:'Gap-fill window — wait for 9:30' };
    if (m < 870) return { status:'trade',    label:'Safe Entry (9:30–14:30)', safe:true,  reason:null };
    if (m <= 930) return { status:'theta',   label:'Theta Zone (14:30–15:30)',safe:false, reason:'Theta decay accelerating — avoid new entries' };
    return              { status:'closed',   label:'Market Closed',           safe:false, reason:'Market closed' };
}

// PCR label — displayed on UI (thresholds tuned for real Nifty option chain behaviour)
function pcrLabel(v) {
    if (!v) return 'N/A';
    if (v > 1.3) return 'BULLISH';   // was >1.5 — too rare, almost never fired
    if (v < 0.8) return 'BEARISH';   // was <0.7 — missed mildly bearish setups
    return 'NEUTRAL';
}

// Graduated PCR score used for signal weighting (-3 to +3)
// More nuanced than binary label — avoids cliff-edge on/off behaviour
function pcrScore(v) {
    if (!v || isNaN(v)) return 0;
    if (v >= 1.5) return  3;   // heavy call-writing protection → very bullish
    if (v >= 1.3) return  2;
    if (v >= 1.1) return  1;
    if (v >= 0.9) return  0;   // neutral band
    if (v >= 0.7) return -1;
    if (v >= 0.5) return -2;
    return -3;                  // extreme put build-up → very bearish
}

// ── ADX Calculator — Wilder's smoothing, period=14 ───────────────────────────
// Uses candle history already stored in memory (no extra API calls / packages).
// Returns { adx, diPlus, diMinus } or null when insufficient data.
function calculateADX(candles, period = 14) {
    if (!candles || candles.length < period * 2 + 2) return null;
    try {
        // Filter out flat candles (high == low) — zero True Range causes DI explosion
        const valid = candles.filter(c =>
            c.high != null && c.low != null && c.close != null && c.high > c.low
        );
        if (valid.length < period * 2 + 2) return null;
        const tr = [], dmp = [], dmm = [];
        for (let i = 1; i < valid.length; i++) {
            const h = valid[i].high,   l = valid[i].low,   pc = valid[i - 1].close;
            const ph = valid[i - 1].high, pl = valid[i - 1].low;
            tr .push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
            const up = h - ph, dn = pl - l;
            dmp.push(up > dn && up > 0 ? up : 0);
            dmm.push(dn > up && dn > 0 ? dn : 0);
        }
        // Wilder's running smooth: seed = sum of first `period` bars, then iterate
        function wilderSmooth(arr) {
            let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
            const out = [s];
            for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); }
            return out;
        }
        const atr  = wilderSmooth(tr);
        const sdmp = wilderSmooth(dmp);
        const sdmm = wilderSmooth(dmm);
        const dip  = sdmp.map((v, i) => atr[i] > 0 ? (v / atr[i]) * 100 : 0);
        const dim  = sdmm.map((v, i) => atr[i] > 0 ? (v / atr[i]) * 100 : 0);
        const dx   = dip .map((v, i) => { const s = v + dim[i]; return s > 0 ? (Math.abs(v - dim[i]) / s) * 100 : 0; });
        const adxArr = wilderSmooth(dx);
        const n = adxArr.length - 1;
        const adxVal = parseFloat(adxArr[n].toFixed(2));
        // ADX is mathematically bounded 0–100; anything above means data quality issue
        if (adxVal > 100 || adxVal < 0) {
            console.warn(`⚠️ ADX out of range (${adxVal}) — overnight gap in data, skipping`);
            return null;
        }
        return {
            adx    : adxVal,
            diPlus : parseFloat(Math.min(100, dip[dip.length - 1]).toFixed(2)),
            diMinus: parseFloat(Math.min(100, dim[dim.length - 1]).toFixed(2))
        };
    } catch (_) { return null; }
}

function trackPCRHistory(pcr) {
    if (!pcr) return;
    const ist  = getIST();
    const time = `${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;
    marketState.pcrHistory.push({ time, pcr: parseFloat(pcr.toFixed(2)), signal: pcrLabel(pcr) });
    if (marketState.pcrHistory.length > 50) marketState.pcrHistory.shift();
}

function updateOptionFlow(atmCE, atmPE) {
    const prev = marketState.optionFlow;
    const ceChange = atmCE && prev.atmCEpremium ? parseFloat((((atmCE-prev.atmCEpremium)/prev.atmCEpremium)*100).toFixed(2)) : 0;
    const peChange = atmPE && prev.atmPEpremium ? parseFloat((((atmPE-prev.atmPEpremium)/prev.atmPEpremium)*100).toFixed(2)) : 0;
    let dominance = 'NEUTRAL';
    if      (ceChange > 1 && ceChange > peChange+1)  dominance = 'CALL BUYERS';
    else if (peChange > 1 && peChange > ceChange+1)  dominance = 'PUT BUYERS';
    else if (ceChange < -1 && ceChange < peChange-1) dominance = 'CALL SELLERS';
    else if (peChange < -1 && peChange < ceChange-1) dominance = 'PUT SELLERS';
    const ist = getIST();
    const time = `${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;
    const history = [...(prev.history||[])];
    if (dominance !== 'NEUTRAL') { history.push({time,dominance,ceChange,peChange}); if(history.length>20) history.shift(); }
    marketState.optionFlow = { atmCEpremium:atmCE||prev.atmCEpremium, atmPEpremium:atmPE||prev.atmPEpremium, ceChange, peChange, dominance, history };
}

// ── Signal Generator ──────────────────────────────────
function combineSignals(indicators) {
    // ── Gate 1: safe time window (IST) ────────────────
    const ew = isSafeEntryWindow();
    marketState.entryWindow = ew;
    if (!ew.safe) {
        marketState.qualityGate = { mtfAligned:false, rsiClean:true, safeWindow:false, vixSafe:true, adxTrend:true, srClear:true, passed:false };
        return {
            signal     : 'WAIT',
            confidence : 0,
            reasons    : [`⏰ ${ew.reason}`, ...(indicators.reasons||[]).slice(0,2)]
        };
    }

    // ── Bull / bear vote tally ────────────────────────
    let bull=0, bear=0;
    const reasons=[...(indicators.reasons||[])];

    // ── PCR — graduated score (-3 to +3) ─────────────────────────────────────
    // Replaces old binary BULLISH/BEARISH: threshold >1.5/<0.7 almost never fired.
    // Now every reading contributes proportionally, positive or negative.
    if (marketState.pcr !== null) {
        const ps = pcrScore(marketState.pcr);
        if      (ps >= 2)  { bull += ps;           reasons.push(`PCR ${marketState.pcr} — Strongly Bullish ✅`); }
        else if (ps === 1) { bull += 1;            reasons.push(`PCR ${marketState.pcr} — Mildly Bullish ✅`); }
        else if (ps <= -2) { bear += Math.abs(ps); reasons.push(`PCR ${marketState.pcr} — Strongly Bearish ⚠️`); }
        else if (ps === -1){ bear += 1;            reasons.push(`PCR ${marketState.pcr} — Mildly Bearish ⚠️`); }
        else               {                       reasons.push(`PCR ${marketState.pcr} — Neutral`); }
    }

    // ── ATM PCR — 1.5× weight (nearest strikes = real money intent) ──────────
    // ATM PCR tells you what writers are actually doing at the current price.
    // It's more accurate than broad PCR, so it gets heavier weighting.
    if (marketState.atmPcr !== null) {
        const as = pcrScore(marketState.atmPcr);
        const w = Math.min(Math.max(Math.round(as * 1.5), -4), 4); // cap ±4
        if      (w > 0) { bull += w;  reasons.push(`ATM PCR ${marketState.atmPcr} — Bullish near-strike ✅ (+${w}pts)`); }
        else if (w < 0) { bear += -w; reasons.push(`ATM PCR ${marketState.atmPcr} — Bearish near-strike ⚠️ (+${-w}pts)`); }
        else            {             reasons.push(`ATM PCR ${marketState.atmPcr} — Neutral near-strike`); }
    }
    if (marketState.vix) {
        if      (marketState.vixChange < -0.5) { bull++; reasons.push(`VIX falling (${marketState.vix}) ✅`); }
        else if (marketState.vixChange >  0.5) { bear++; reasons.push(`VIX rising (${marketState.vix}) ⚠️`); }
        if (marketState.vix > 20) reasons.push(`⚠️ VIX ${marketState.vix} ≥ 20 — ${marketState.vixNote}`);
    }
    if (marketState.global.bias==='BULLISH') { bull+=2; reasons.push('Global cues bullish ✅'); }
    else if (marketState.global.bias==='BEARISH') { bear+=2; reasons.push('Global cues bearish ⚠️'); }
    const bn = marketState.global.sectors?.bankNifty;
    if (bn?.changePct > 0.5) bull+=2; else if (bn?.changePct < -0.5) bear+=2;

    // ── BankNifty VWAP leading indicator (+1 / -1) ────
    // BankNifty leads Nifty ~70% of the time intraday.
    // Only fires on a FRESH VWAP cross 5 min ago (signal !== 0).
    const bnLead = marketState.global?.bankNiftyLeadSignal;
    if (bnLead?.signal === 1)  { bull += 1; reasons.push(`🏦 ${bnLead.reason}`); }
    if (bnLead?.signal === -1) { bear += 1; reasons.push(`🏦 ${bnLead.reason}`); }
    const br = marketState.breadth;
    if      (br.breadthSignal==='BULLISH') { bull+=2; reasons.push(`A/D ${br.advances}↑/${br.declines}↓ Bullish ✅`); }
    else if (br.breadthSignal==='BEARISH') { bear+=2; reasons.push(`A/D ${br.advances}↑/${br.declines}↓ Bearish ⚠️`); }
    else if (br.advances>0||br.declines>0) reasons.push(`A/D ${br.advances}↑/${br.declines}↓ Mixed`);
    const fx=marketState.global.currency?.usdinr;
    if (fx?.changePct > 0.5) { bear++; reasons.push(`Rupee weak ₹${fx.price} ⚠️`); }
    const cr=marketState.global.commodities?.crude;
    if (cr?.changePct > 1.5) { bear++; reasons.push(`Crude rising ${cr.changePct}% ⚠️`); }
    if (marketState.fii.net!==null) {
        if      (marketState.fii.net > 0) { bull++; reasons.push(`FII Buy ₹${marketState.fii.net}Cr ✅`); }
        else if (marketState.fii.net < 0) { bear++; reasons.push(`FII Sell ₹${marketState.fii.net}Cr ⚠️`); }
    }

    // ── Max pain gravity (expiry day only) ────────────
    // On Tuesday, price is pulled toward max pain by pinning pressure.
    // A spot well above max pain means call writers will defend → bearish pull.
    // A spot well below means put writers will defend → bullish pull.
    // "Near" = within 0.5 % — treat as magnet zone, no directional bias.
    const mp = marketState.maxPain;
    if (mp?.strike && mp.expiryDay && marketState.nifty > 0) {
        const distPct = ((marketState.nifty - mp.strike) / mp.strike) * 100;
        if      (distPct >  0.5) { bear += 2; reasons.push(`🎯 Max Pain ${mp.strike} below spot — expiry gravity bearish ⚠️`); }
        else if (distPct < -0.5) { bull += 2; reasons.push(`🎯 Max Pain ${mp.strike} above spot — expiry gravity bullish ✅`); }
        else                     {            reasons.push(`🎯 Spot near Max Pain ${mp.strike} — expiry magnet zone`); }
    }
    if (marketState.mtf.aligned) {
        if      (marketState.mtf.signal==='BUY CALL') { bull+=3; reasons.push('All 3 timeframes BULLISH 🔥'); }
        else if (marketState.mtf.signal==='BUY PUT')  { bear+=3; reasons.push('All 3 timeframes BEARISH 🔥'); }
    } else if (marketState.mtf.bullCount===2) { bull++; reasons.push('2/3 TF bullish'); }
    else if   (marketState.mtf.bearCount===2) { bear++; reasons.push('2/3 TF bearish'); }

    // ── Real-time indicator signal ────────────────────────────────────────────
    // Weight reduced from 3 → 2 to address double-counting:
    // The MTF already includes a 5m component derived from the same Yahoo NSEI
    // feed. When MTF is aligned, the 1m indicator almost always agrees (they're
    // correlated) — adding full 3 pts from both inflates confidence unjustifiably.
    // Reducing to 2 keeps the indicator meaningful (it has its own momentum gate
    // the MTF doesn't have) without double-inflating the bull/bear pool.
    bull += indicators.signal==='BUY CALL' ? 2 : 0;
    bear += indicators.signal==='BUY PUT'  ? 2 : 0;

    // ── Volume spike confirmation (+1) ────────────────────────────────────────
    // A volume spike in the direction of the signal adds genuine conviction:
    // a bull breakout on rising volume = real buying pressure, not thin-book noise.
    // Only meaningful on the Angel One WebSocket feed (tick volume is a real proxy).
    // On Yahoo fallback all candles have volume ≈ 1, so calcVolumeSpike() returns
    // false and this block never fires — no phantom votes on polling data.
    if (indicators.volumeSpike) {
        if      (indicators.signal === 'BUY CALL') { bull += 1; reasons.push('📊 Volume spike — buying pressure confirmed ✅'); }
        else if (indicators.signal === 'BUY PUT')  { bear += 1; reasons.push('📊 Volume spike — selling pressure confirmed ✅'); }
    }

    // ── DII (Domestic Institutional Investors) ────────────────────────────────
    // DII net buy/sell direction is a supporting (not leading) signal.
    // Weight = 1 (same as FII). DII are more contrarian than FII but their
    // net direction on a given day indicates domestic fund positioning.
    if (marketState.dii.net !== null) {
        if      (marketState.dii.net > 0) { bull += 1; reasons.push(`DII Buy ₹${marketState.dii.net}Cr ✅`); }
        else if (marketState.dii.net < 0) { bear += 1; reasons.push(`DII Sell ₹${Math.abs(marketState.dii.net)}Cr ⚠️`); }
    }

    // ── Early Momentum — 7-vote leading signal (no warmup) ────────────────────
    // score ranges −5 to +5. Mapped to vote weight: each 2 score points = 1 vote.
    // Leads other signals by 30–60s (premium velocity) or 1 full cycle (OI delta).
    // Weighted HIGHER than FII/DII because it's intraday real-time, not daily.
    const em = marketState.earlyMom;
    if (em && em.score !== null) {
        const emVotes = Math.sign(em.score) * Math.min(Math.ceil(Math.abs(em.score) / 2), 3);
        if (emVotes > 0) {
            bull += emVotes;
            reasons.push(`⚡ Early Momentum CE: ${em.label} (+${emVotes}pts)`);
        } else if (emVotes < 0) {
            bear += Math.abs(emVotes);
            reasons.push(`⚡ Early Momentum PE: ${em.label} (+${Math.abs(emVotes)}pts)`);
        }
    }

    // Raw directional intention from the vote tally
    const total = bull + bear;
    let rawSignal = 'WAIT', rawConfidence = 0;
    if (total > 0) {
        const pct = (bull / total) * 100;
        if      (pct >= 65) { rawSignal = 'BUY CALL'; rawConfidence = Math.round(pct); }
        else if (pct <= 35) { rawSignal = 'BUY PUT';  rawConfidence = Math.round(100 - pct); }
        else                { rawSignal = 'WAIT';     rawConfidence = 30; reasons.push('Mixed signals'); }
    }

    // ── Entry quality gate ────────────────────────────
    // All five conditions must pass before a directional signal is issued.
    // The scoring above still runs in full so the UI can show the underlying
    // bull/bear breakdown even when the gate blocks the final call.
    const rsi = indicators.rsi;

    // ── ADX — trend strength filter ──────────────────────────────────────────
    // ADX < 20 = choppy/sideways = worst environment for option buyers.
    // In a ranging market, premiums decay fast (theta) with no directional move.
    // ADX >= 20 but < 25 = weak trend forming — allow signal but cap confidence.
    // ADX >= 25 = confirmed trend — full signal strength.
    // ADX >= 40 = explosive move — warn about wide premiums.
    // Use session-only candles (9:15 IST onwards, no overnight gaps).
    // getCandleHistory() contains multi-day data — overnight price gaps cause
    // Wilder's smoothing to produce ADX > 100 (invalid). sessionCandles has no gaps.
    const sessionCandlesForADX = getSessionCandles();

    // FIX 3: Only engage ADX gate when we have 60+ session candles.
    // Before ~10:00 AM the Wilder warm-up window (30 bars) hasn't settled,
    // producing noisy ADX readings that either block valid setups or—worse—
    // falsely confirm trend on a gap-open bar. 60 bars ≈ 60 minutes of 1m
    // data, which reliably puts us past 10:15 IST before ADX gates anything.
    const adxData = sessionCandlesForADX.length >= 60
        ? calculateADX(sessionCandlesForADX)
        : null;
    if (sessionCandlesForADX.length < 60) {
        const remaining = 60 - sessionCandlesForADX.length;
        reasons.push(`⏳ ADX gate inactive — need ${remaining} more candles (before ~10:00 AM)`);
    }
    marketState.adx = adxData;   // expose to frontend via /api/signal

    const adxVal      = adxData?.adx ?? null;
    const adxTooWeak  = adxVal !== null && adxVal < 20;

    if (adxVal !== null) {
        if      (adxVal >= 40) reasons.push(`🔥 ADX ${adxVal} — Explosive trend (wider SL advised)`);
        else if (adxVal >= 25) reasons.push(`📈 ADX ${adxVal} — Strong trend confirmed ✅`);
        else if (adxVal >= 20) reasons.push(`⚠️ ADX ${adxVal} — Trend forming (weak, confidence capped 60%)`);
        // <20 handled in gate reason below — no need to add here
    }

    const qualityGate = {
        // 1. All three timeframes must agree (with ADX ≥ 20 per TF)
        mtfAligned : marketState.mtf.aligned,

        // 2. RSI must not already be stretched in the direction of entry.
        //    For a CALL entry: RSI < 70 (not overbought — chasing a crowded move).
        //    For a PUT  entry: RSI > 30 (not oversold  — fading a washed-out move).
        //    WAIT signals are unconditionally clean (no direction to check).
        rsiClean   : rawSignal === 'WAIT' || rsi === null
                     || (rawSignal === 'BUY CALL' && rsi < 70)
                     || (rawSignal === 'BUY PUT'  && rsi > 30),

        // 3. Safe time window — already enforced at the top of this function.
        safeWindow : true,

        // 4. VIX below 20: elevated vol inflates premiums and widens spreads,
        //    making option-buying risk/reward unfavourable.
        vixSafe    : !marketState.vix || marketState.vix < 20,

        // 5. ADX >= 20: trend must exist before betting directional premium.
        //    When ADX data is unavailable (insufficient history), default to true
        //    so we don't silently block signals during early session.
        adxTrend   : !adxTooWeak,

        // 6. FIX 4: Price must not be within 30 pts of an S/R level.
        //    Evaluated inside the gate block below; initialise to true here.
        srClear    : true
    };
    qualityGate.passed = qualityGate.mtfAligned && qualityGate.rsiClean
                      && qualityGate.safeWindow  && qualityGate.vixSafe
                      && qualityGate.adxTrend    && qualityGate.srClear;

    // Persist gate state so the UI can show which checks are passing / failing
    marketState.qualityGate = qualityGate;

    // FIX 2: Hard cap confidence at 85%.
    // The vote tally has many inputs (PCR, ATM PCR, breadth, global, MTF, FII,
    // max pain, BankNifty lead…) so in extreme conditions all vote the same way
    // and rawConfidence can reach 100%. 100% is epistemically wrong — no intraday
    // signal has 100% certainty. Capped at 85 to keep the UI honest and prevent
    // traders from over-sizing positions on "perfect" setups.
    rawConfidence = Math.min(rawConfidence, 85);

    // Gate decision — check in priority order.
    // ADX is checked FIRST because a choppy market invalidates everything else.
    let signal = rawSignal, confidence = rawConfidence;
    if (rawSignal !== 'WAIT') {
        if (!qualityGate.adxTrend) {
            signal = 'WAIT'; confidence = 0;
            reasons.push(`⛔ ADX ${adxVal} < 20 — Sideways/choppy market. No trend = theta decay kills option buyers. Wait for ADX ≥ 20`);
        } else if (!qualityGate.mtfAligned) {
            signal = 'WAIT'; confidence = 0;
            reasons.push(`⛔ MTF not aligned (${marketState.mtf.bullCount}/3 bull, ${marketState.mtf.bearCount}/3 bear) — wait for all-3 agreement`);
        } else if (!qualityGate.rsiClean) {
            signal = 'WAIT'; confidence = 0;
            const extreme = rawSignal === 'BUY CALL' ? `overbought (${rsi})` : `oversold (${rsi})`;
            reasons.push(`⛔ RSI already ${extreme} — entry is chasing, skip`);
        } else if (!qualityGate.vixSafe) {
            signal = 'WAIT'; confidence = 0;
            reasons.push(`⛔ VIX ${marketState.vix} ≥ 20 — option premium too expensive for buyer, skip`);
        } else {
            // ── FIX 4: S/R proximity gate ─────────────────────────────────────────
            // If price is within 30 points of a known Support/Resistance level, the
            // risk/reward for option buyers is poor: price may stall or snap back at
            // that level. The 30-pt buffer covers one full premium spread on Nifty.
            // Exception: Max Pain levels get 50-pt buffer on expiry day (stronger wall).
            // A WAIT here means "wait for a decisive break past the level, then re-enter."
            const srLvls = marketState.srLevels?.levels;
            if (srLvls?.length > 0 && marketState.nifty > 0) {
                const bufferPts = marketState.maxPain?.expiryDay ? 50 : 30;
                const nearbyLevel = srLvls.find(lvl =>
                    Math.abs(marketState.nifty - lvl.price) <= bufferPts
                );
                if (nearbyLevel) {
                    const dist = Math.abs(marketState.nifty - nearbyLevel.price).toFixed(0);
                    signal     = 'WAIT';
                    confidence = 0;
                    qualityGate.srClear = false;
                    reasons.push(
                        `⛔ S/R wall: ${nearbyLevel.label || nearbyLevel.type} @ ${nearbyLevel.price} ` +
                        `(${dist} pts away, buffer ${bufferPts} pts) — wait for clean break`
                    );
                }
            }
        }
    }

    // ── ADX weak-trend confidence cap ────────────────────────────────────────
    // Signal passes gate (ADX 20–25) but trend is not fully confirmed.
    // Cap confidence at 60% so the UI doesn't show a strong conviction call.
    if (signal !== 'WAIT' && adxVal !== null && adxVal < 25) {
        const before = confidence;
        confidence = Math.min(confidence, 60);
        if (confidence < before) reasons.push(`⚠️ Confidence capped at 60% — ADX ${adxVal} < 25 (trend weak, full size risky)`);
    }

    return { signal, confidence, reasons };
}

async function checkTelegramAlerts(newSignal) {
    if (!isConfigured()||!isMarketOpen()) return;
    const ist=getIST(), h=ist.getHours(), m=ist.getMinutes();
    if (h===9&&m>=16&&m<=20&&!morningSummarySent) { morningSummarySent=true; await sendMorningSummary(marketState); return; }
    if (h===15&&m>=30&&!closeSummarySent) { closeSummarySent=true; await sendCloseSummary(marketState); setTimeout(()=>{morningSummarySent=false;closeSummarySent=false;vixAlertSent=false;pcrClearedToday=false;},6*60*60*1000); return; }
    if (newSignal!==prevSignal&&newSignal!=='WAIT') {
        await sendSignalAlert(marketState,prevSignal);
        // ── Trigger AI suggestion on fresh signal (costs 1 API call here only) ──
        if (marketState.qualityGate.passed) {
            try {
                const pcrState   = getPCRState();
                const strikeData = pickStrikeAndPremium(newSignal, marketState.nifty, marketState.vix, pcrState);
                if (strikeData) {
                    const winRate = await getWinRateFromHistory(strikeData.type);
                    await getAITradeSuggestion(marketState, strikeData, winRate);
                    console.log(`🤖 AI suggestion triggered by fresh signal: ${newSignal}`);
                }
            } catch(e) { console.error('AI on signal trigger:', e.message); }
        }
    }
    if (marketState.mtf.aligned&&!prevMTFAligned) await sendMTFAlert(marketState);
    prevMTFAligned=marketState.mtf.aligned;
    if (marketState.vix>20&&!vixAlertSent) { vixAlertSent=true; await sendVIXAlert(marketState.vix,marketState.vixNote); }
    if (marketState.vix<=20) vixAlertSent=false;
}

async function updatePrice(price, change, changePct, source) {
    const indicators=processIndicators(price, marketState.global?.bankNiftyLeadSignal ?? null);
    const { signal, confidence, reasons }=combineSignals(indicators);
    marketState.nifty=price; marketState.change=change; marketState.changePct=changePct;
    marketState.signal=signal; marketState.confidence=confidence;
    marketState.rsi=indicators.rsi; marketState.ema9=indicators.ema9;
    marketState.ema21=indicators.ema21; marketState.vwap=indicators.vwap;
    marketState.reason=reasons; marketState.lastUpdated=new Date().toISOString();
    marketState.connected=true; marketState.source=source; marketState.dataPoints=indicators.priceCount;
    if (source==='yahoo') console.log(`NIFTY:${price} RSI:${indicators.rsi||'--'} → ${signal}(${confidence}%)`);
    await checkTelegramAlerts(signal);
    prevSignal=signal;
}

function onTick(tickData) {
    const price=tickData.price; if(!price||price<=0) return;
    const prev=marketState.nifty||price, change=parseFloat((price-prev).toFixed(2));
    const chgPct=prev>0?parseFloat(((change/prev)*100).toFixed(2)):0;
    updatePrice(price,change,chgPct,'websocket');
}

async function refreshMarketData() {
    // Clear stale price when market is closed so UI shows '--' not yesterday's close
    if (!isMarketOpen() && marketState.nifty > 0) {
        marketState.nifty     = 0;
        marketState.change    = 0;
        marketState.changePct = 0;
        marketState.connected = false;
        marketState.source    = 'none';
    }
    const { niftyData, vixData }=await fetchMarketData();
    if (niftyData?.closes?.length>0&&!historyLoaded) { initializeHistory(niftyData.closes,niftyData.candles); historyLoaded=true; console.log(`History: ${niftyData.closes.length} candles`); }
    if (vixData) { marketState.vix=vixData.vix; marketState.vixChange=vixData.change; marketState.vixSignal=vixData.signal; marketState.vixNote=vixData.note; marketState.strikeRange=vixData.strikeRange; }
    if (niftyData?.price>0 && isMarketOpen()) {
        if (marketState.source!=='websocket') await updatePrice(niftyData.price,niftyData.change,niftyData.changePct,'yahoo');
        else { marketState.change=niftyData.change; marketState.changePct=niftyData.changePct; }
    }
}

async function refreshMTF() {
    try {
        // ── Re-seed candles from Yahoo if NSE is blocked ──────────────────────
        // getSessionCandles() returns [] when NSE intraday is blocked (Railway IP ban).
        // Yahoo Finance ^NSEI 5m candles are never blocked — use as silent fallback.
        const { getSessionCandles: _getSC } = require('./src/api/indicators');
        if (_getSC().length < 5) {
            loadCandlesFromYahoo().catch(e => console.warn('[Yahoo MTF refresh]', e.message));
        }

        const d = await analyzeMultiTimeframe();
        if (!d) return;

        // ── Pre-market gate ────────────────────────────
        // Before 09:15 IST the candle history is overnight/multi-day data.
        // Store the raw timeframe readings so they're ready the moment the
        // session opens, but force the composite badge to NEUTRAL so it
        // can't show a directional call based on stale pre-market data.
        const ist = getIST();
        const mins = ist.getHours() * 60 + ist.getMinutes();
        const preMarket = mins < 555;   // 09:15 = 555 minutes from midnight

        marketState.mtf = {
            signal    : preMarket ? 'NEUTRAL' : d.mtfSignal,
            strength  : preMarket ? 'WEAK'    : d.mtfStrength,
            confidence: preMarket ? 0         : d.mtfConfidence,
            aligned   : preMarket ? false      : d.aligned,
            bullCount : preMarket ? 0          : d.bullCount,
            bearCount : preMarket ? 0          : d.bearCount,
            tf5m      : d.tf5m,
            tf15m     : d.tf15m,
            tf1h      : d.tf1h
        };
    } catch(e) { console.error('MTF:', e.message); }
}
async function refreshGlobal() { try { const g=await fetchGlobalCues(); if(g) marketState.global=g; } catch(e) { console.error('Global:',e.message); } }
async function refreshBreadth() { try { const d=await fetchAdvanceDecline(); if(d) marketState.breadth=d; } catch(e) { console.error('Breadth:',e.message); } }
async function refreshSR() { try { if(marketState.nifty>0) { const sr=await calculateSRLevels(marketState.nifty, marketState.maxPain?.strike ? marketState.maxPain : null); if(sr) marketState.srLevels=sr; } } catch(e) { console.error('SR:',e.message); } }

async function refreshPCR() {
    if (!isMarketOpen() || marketState.nifty <= 0) return;

    // ── One-shot stale-data wipe ───────────────────────
    // Manual values entered yesterday persist in marketState until the first
    // successful NSE fetch. Clear them now so they don't pollute the signal
    // during the gap between 09:15 and the first successful auto-fetch.
    if (!pcrClearedToday && marketState.pcrSource === 'manual') {
        marketState.pcr          = null;
        marketState.atmPcr       = null;
        marketState.pcrSignal    = 'N/A';
        marketState.atmPcrSignal = 'N/A';
        marketState.pcrHistory   = [];
        pcrClearedToday          = true;
        console.log('🧹 Stale manual PCR cleared for new session');
    }
    try {
        // nseData.js scheduler fetches on its own interval — we just READ the state.
        const pcrState = getPCRState();
        if (!pcrState || !pcrState.pcr) return;

        // Update PCR
        marketState.pcr        = pcrState.pcr;
        marketState.pcrSignal  = pcrLabel(pcrState.pcr);
        trackPCRHistory(pcrState.pcr);

        // Update ATM PCR
        if (pcrState.atmPcr) {
            marketState.atmPcr       = pcrState.atmPcr;
            marketState.atmPcrSignal = pcrLabel(pcrState.atmPcr);
        }

        // Feed live ATM premiums into option flow tracker
        if (pcrState.atmCEpremium || pcrState.atmPEpremium) {
            updateOptionFlow(pcrState.atmCEpremium, pcrState.atmPEpremium);
            // Check open trades for SL/target hits using fresh premiums
            await updateOpenTradesMTM();
        }

        marketState.pcrSource = 'auto';
        console.log(`✅ PCR auto-updated: ${pcrState.pcr} | ATM: ${pcrState.atmPcr} (source: NSE)`);

        // ── Max pain ──────────────────────────────────────
        if (pcrState.maxPain?.strike) {
            marketState.maxPain = {
                strike    : pcrState.maxPain.strike,
                totalPain : pcrState.maxPain.totalPain,
                expiryDay : pcrState.expiryDay,
                updatedAt : new Date().toISOString()
            };
            if (pcrState.expiryDay) {
                console.log(`🎯 Max Pain: ${pcrState.maxPain.strike} ⚡ EXPIRY DAY`);
            } else {
                console.log(`🎯 Max Pain: ${pcrState.maxPain.strike}`);
            }

            // Live-patch srLevels so the dashboard reflects max pain immediately
            if (marketState.srLevels) {
                marketState.srLevels.maxPain = marketState.maxPain;
                marketState.srLevels.levels = marketState.srLevels.levels
                    .filter(l => l.type !== 'MP');
                const onExpiry = pcrState.expiryDay;
                marketState.srLevels.levels.push({
                    price   : pcrState.maxPain.strike,
                    type    : 'MP',
                    label   : onExpiry ? 'Max Pain 🎯 EXPIRY' : 'Max Pain',
                    strength: onExpiry ? 5 : 4
                });
                marketState.srLevels.levels.sort((a, b) => b.price - a.price);
            }
        }

        // ── Early Momentum — sync from nseData internal state ─────────────────
        const emState = getEarlyMomState();
        if (emState && emState.score !== null) {
            marketState.earlyMom = {
                score    : emState.score,
                signal   : emState.signal,
                strength : emState.strength,
                label    : emState.label,
                votes    : emState.votes || [],
                fetchedAt: emState.fetchedAt,
            };
        }

        // ── OI Buildup — sync from nseData internal state ─────────────────────
        const oiState = getOIBuildupState();
        if (oiState && oiState.signal) {
            marketState.oiBuildup = {
                signal         : oiState.signal,
                strength       : oiState.strength,
                label          : oiState.label,
                maxCEoiStrike  : oiState.maxCEoiStrike,
                maxPEoiStrike  : oiState.maxPEoiStrike,
                totalCEoiChange: oiState.totalCEoiChange,
                totalPEoiChange: oiState.totalPEoiChange,
                pcrChange      : oiState.pcrChange,
                topCEbuildup   : oiState.topCEbuildup,
                topPEbuildup   : oiState.topPEbuildup,
                fetchedAt      : oiState.fetchedAt,
            };
        }

        // ── FII/DII — sync from nseData auto-fetch ────────────────────────────
        // nseData fetches FII/DII every 15 min on its own; we read it here.
        const fiiState = getFIIState();
        if (fiiState.fiiNet !== null) {
            marketState.fii = { buy: fiiState.fiiBuy, sell: fiiState.fiiSell, net: fiiState.fiiNet };
        }
        if (fiiState.diiNet !== null) {
            marketState.dii = { buy: fiiState.diiBuy, sell: fiiState.diiSell, net: fiiState.diiNet };
        }

    } catch(e) {
        console.error('refreshPCR:', e.message);
    }
}

// ── Economic Calendar Auto-Fetch ──────────────────────────────────────────────
let _calendarCache = [];
let _calendarFetchedDate = null;

const HARDCODED_INDIA_EVENTS = [
  { title: 'RBI MPC Decision',   date: '2025-06-06', impact: 'high',   country: 'IN', category: 'monetary'   },
  { title: 'RBI MPC Decision',   date: '2025-08-06', impact: 'high',   country: 'IN', category: 'monetary'   },
  { title: 'Union Budget 2025',  date: '2025-07-24', impact: 'high',   country: 'IN', category: 'fiscal'     },
  { title: 'India CPI Inflation',date: '2025-06-12', impact: 'medium', country: 'IN', category: 'inflation'  },
  { title: 'India IIP Data',     date: '2025-06-12', impact: 'medium', country: 'IN', category: 'industrial' },
  { title: 'India GDP Q4',       date: '2025-05-30', impact: 'high',   country: 'IN', category: 'gdp'        },
];

async function fetchCalendarEvents() {
  const ist      = getIST();
  const todayStr = `${ist.getFullYear()}-${String(ist.getMonth()+1).padStart(2,'0')}-${String(ist.getDate()).padStart(2,'0')}`;

  // Only fetch once per calendar day
  if (_calendarFetchedDate === todayStr && _calendarCache.length > 0) return;

  try {
    const events2 = [];
    const sevenDaysLater = new Date(ist);
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
    const toStr = `${sevenDaysLater.getFullYear()}-${String(sevenDaysLater.getMonth()+1).padStart(2,'0')}-${String(sevenDaysLater.getDate()).padStart(2,'0')}`;

    const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
    if (FINNHUB_KEY) {
      const url = `https://finnhub.io/api/v1/calendar/economic?from=${todayStr}&to=${toStr}&token=${FINNHUB_KEY}`;
      const r   = await axios.get(url, { timeout: 8000 });
      const data = r.data?.economicCalendar || [];

      const IMPORTANT = [
        'Fed Interest Rate Decision','FOMC','US CPI','US NFP','Nonfarm Payroll',
        'US GDP','ECB Interest Rate','BOJ','US PPI','US Retail Sales','US ISM',
        'India CPI','India GDP','India IIP','RBI'
      ];

      for (const ev of data) {
        if (!ev.event) continue;
        const isImportant = IMPORTANT.some(k => ev.event.toLowerCase().includes(k.toLowerCase()));
        if (!isImportant && ev.impact !== 'high') continue;
        events2.push({
          title   : ev.event,
          date    : ev.time ? ev.time.slice(0, 10) : todayStr,
          time    : ev.time ? ev.time.slice(11, 16) : '--:--',
          impact  : ev.impact  || 'medium',
          country : ev.country || 'US',
          actual  : ev.actual   || null,
          estimate: ev.estimate || null,
          previous: ev.previous || null,
          category: 'macro',
        });
      }
    }

    // Merge hardcoded India events
    for (const ev of HARDCODED_INDIA_EVENTS) {
      if (ev.date >= todayStr) {
        const exists = events2.some(e => e.title === ev.title && e.date === ev.date);
        if (!exists) events2.push({ ...ev, time: '10:00', category: ev.category });
      }
    }

    // Add NSE weekly expiry (every Thursday)
    const d2 = new Date(ist);
    for (let i = 0; i <= 7; i++) {
      const dd = new Date(d2); dd.setDate(dd.getDate() + i);
      if (dd.getDay() === 4) {
        const ds = `${dd.getFullYear()}-${String(dd.getMonth()+1).padStart(2,'0')}-${String(dd.getDate()).padStart(2,'0')}`;
        events2.push({ title: 'NSE Weekly F&O Expiry', date: ds, time: '15:30', impact: 'high', country: 'IN', category: 'expiry' });
        break;
      }
    }

    // Sort by date+time, high impact first
    events2.sort((a, b) => {
      const dt = (a.date + 'T' + (a.time || '00:00')).localeCompare(b.date + 'T' + (b.time || '00:00'));
      if (dt !== 0) return dt;
      const order = { high: 0, medium: 1, low: 2 };
      return (order[a.impact] || 1) - (order[b.impact] || 1);
    });

    _calendarCache = events2;
    _calendarFetchedDate = todayStr;
    marketState.calendarEvents = events2;
    console.log(`📅 Calendar: ${events2.length} events loaded (${events2.filter(e => e.impact === 'high').length} HIGH impact)`);

    scheduleEventAlerts(events2);
  } catch (e) {
    console.error('Calendar fetch error:', e.message);
    // Fallback to hardcoded only
    _calendarCache = HARDCODED_INDIA_EVENTS.filter(e => e.date >= (() => { const i = getIST(); return `${i.getFullYear()}-${String(i.getMonth()+1).padStart(2,'0')}-${String(i.getDate()).padStart(2,'0')}`; })()).map(e => ({ ...e, time: '10:00' }));
    marketState.calendarEvents = _calendarCache;
  }
}

// Schedule Telegram warning 30 min before each HIGH impact event today
const _alertedEvents = new Set();
function scheduleEventAlerts(evList) {
  if (!isConfigured()) return;
  const ist      = getIST();
  const todayStr = `${ist.getFullYear()}-${String(ist.getMonth()+1).padStart(2,'0')}-${String(ist.getDate()).padStart(2,'0')}`;
  for (const ev of evList) {
    if (ev.date !== todayStr || ev.impact !== 'high' || !ev.time || ev.time === '--:--') continue;
    const key = ev.title + ev.date;
    if (_alertedEvents.has(key)) continue;
    const [h, m] = ev.time.split(':').map(Number);
    const eventMs = new Date(ist).setHours(h, m, 0, 0);
    const alertMs = eventMs - 30 * 60 * 1000;
    const delay   = alertMs - Date.now();
    if (delay > 0 && delay < 8 * 60 * 60 * 1000) {
      _alertedEvents.add(key);
      setTimeout(async () => {
        const msg = `⚠️ HIGH IMPACT EVENT IN 30 MIN\n📌 ${ev.title}\n🕐 ${ev.time} IST\n🌍 ${ev.country}\nConsider reducing position size or avoiding new entries.`;
        try {
          const bot = require('./src/api/telegram');
          if (bot.sendRawMessage) await bot.sendRawMessage(msg);
        } catch(_) {}
      }, delay);
      console.log(`📅 Alert scheduled: ${ev.title} at ${ev.time} (in ${Math.round(delay/60000)} min)`);
    }
  }
}

app.get('/api/calendar', (req, res) => res.json(marketState.calendarEvents || []));

// ── Trade journal helpers ─────────────────────────────
function getTradeSummary() {
    const closed = trades.filter(t=>t.status==='CLOSED');
    const totalPnl = closed.reduce((s,t)=>s+(t.pnl||0), 0);
    const winners  = closed.filter(t=>t.pnl>0).length;
    const losers   = closed.filter(t=>t.pnl<0).length;
    const winRate  = (winners+losers)>0 ? Math.round((winners/(winners+losers))*100) : 0;
    const openPnl  = trades.filter(t=>t.status==='OPEN'&&t.currentPnl!=null).reduce((s,t)=>s+(t.currentPnl||0),0);
    return { totalPnl, openPnl, winners, losers, winRate, totalTrades:trades.length, openTrades:trades.filter(t=>t.status==='OPEN').length };
}

// ── Exit monitor — runs every time live premiums arrive ──
// Uses live ATM premiums from optionFlow (updated by refreshPCR every 3 min).
// Fires a Telegram exit alert ONCE per trade per threshold via alertSent flags.
// P&L is premium-based, not Nifty-move-based.
async function updateOpenTradesMTM() {
    const price = marketState.nifty;
    if (!price) return;

    const atmCE = marketState.optionFlow.atmCEpremium;
    const atmPE = marketState.optionFlow.atmPEpremium;

    for (const t of trades.filter(t => t.status === 'OPEN')) {
        // Nifty move (kept for UI display)
        t.niftyCurrent = price;
        t.niftyMove    = parseFloat((price - (t.niftyAtEntry || price)).toFixed(0));

        // Pick the live premium that matches this trade's type
        const livePremium = t.type === 'CE' ? atmCE : atmPE;
        if (!livePremium || !t.premium) continue;

        t.currentPremium = livePremium;
        t.currentPnl     = parseFloat(((livePremium - t.premium) * t.lots * LOT_SIZE).toFixed(0));

        // ── Threshold calculation ────────────────────────
        const entry   = t.premium;
        const risk    = t.sl > 0 ? (entry - t.sl) : entry * 0.25;  // fallback: 25% of entry
        const sl      = t.sl > 0 ? t.sl : parseFloat((entry * 0.75).toFixed(2));
        const target1R  = parseFloat((entry + risk).toFixed(2));         // 1:1
        const target15R = parseFloat((entry + risk * 1.5).toFixed(2));   // 1:1.5

        // Initialise alert-sent guards on first pass
        if (!t.alertSent) t.alertSent = { sl: false, target1R: false, target15R: false };

        // ── SL hit ──────────────────────────────────────
        if (!t.alertSent.sl && livePremium <= sl) {
            t.alertSent.sl = true;
            console.log(`🛑 SL hit: Trade #${t.id} ${t.type} ${t.strike} — premium ₹${livePremium} ≤ SL ₹${sl}`);
            if (isConfigured()) await sendExitAlert(t, 'STOP_LOSS', livePremium);
        }

        // ── Target 1:1 ──────────────────────────────────
        if (!t.alertSent.target1R && livePremium >= target1R) {
            t.alertSent.target1R = true;
            console.log(`✅ Target 1R hit: Trade #${t.id} — premium ₹${livePremium} ≥ ₹${target1R}`);
            if (isConfigured()) await sendExitAlert(t, 'TARGET_1R', livePremium);
        }

        // ── Target 1:1.5 ────────────────────────────────
        if (!t.alertSent.target15R && livePremium >= target15R) {
            t.alertSent.target15R = true;
            console.log(`🎯 Target 1.5R hit: Trade #${t.id} — premium ₹${livePremium} ≥ ₹${target15R}`);
            if (isConfigured()) await sendExitAlert(t, 'TARGET_1_5R', livePremium);
        }
    }
}

// ── TRADE SUGGESTION ENGINE ──────────────────────────────────────────────────
// Added block — paste this entire section into server.js just before the
// "── Routes ────" comment line.

// ── PostgreSQL Trade History (Railway DB) ────────────────────────────────────
const { Pool } = require('pg');
let dbPool = null;

async function initDB() {
    if (!process.env.DATABASE_URL) {
        console.log('⚠️  No DATABASE_URL — trade history will not be saved to DB');
        return;
    }
    try {
        dbPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS trade_history (
                id          SERIAL PRIMARY KEY,
                ts          TIMESTAMPTZ DEFAULT NOW(),
                signal_type TEXT,
                strike      INT,
                entry       NUMERIC,
                sl          NUMERIC,
                target      NUMERIC,
                nifty_level NUMERIC,
                rsi         NUMERIC,
                vix         NUMERIC,
                pcr         NUMERIC,
                mtf_signal  TEXT,
                adx         NUMERIC,
                confidence  INT,
                outcome     TEXT DEFAULT 'OPEN',
                exit_price  NUMERIC,
                pnl         NUMERIC
            )
        `);
        console.log('✅ PostgreSQL trade_history table ready');
    } catch (e) {
        console.error('DB init error:', e.message);
        dbPool = null;
    }
}

async function saveTradeToHistory(tradeData) {
    if (!dbPool) return;
    try {
        await dbPool.query(
            `INSERT INTO trade_history (signal_type,strike,entry,sl,target,nifty_level,rsi,vix,pcr,mtf_signal,adx,confidence)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
                tradeData.type, tradeData.strike, tradeData.entry,
                tradeData.sl, tradeData.target, tradeData.niftyLevel,
                tradeData.rsi, tradeData.vix, tradeData.pcr,
                tradeData.mtfSignal, tradeData.adx, tradeData.confidence
            ]
        );
    } catch (e) {
        console.error('DB save error:', e.message);
    }
}

async function getWinRateFromHistory(signalType) {
    if (!dbPool) return null;
    try {
        const r = await dbPool.query(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins
             FROM trade_history
             WHERE signal_type=$1 AND outcome IN ('WIN','LOSS')
             ORDER BY ts DESC LIMIT 50`,
            [signalType]
        );
        const row = r.rows[0];
        if (!row || parseInt(row.total) === 0) return null;
        return Math.round((parseInt(row.wins) / parseInt(row.total)) * 100);
    } catch (e) {
        return null;
    }
}

// ── Strike + Premium Picker ────────────────────────────────────────────────
// Picks the right strike and reads live LTP from option chain already in memory
function pickStrikeAndPremium(signal, nifty, vix, pcrState) {
    if (!nifty || nifty <= 0) return null;

    const isBull = signal === 'BUY CALL';
    const type   = isBull ? 'CE' : 'PE';
    const atm    = Math.round(nifty / 50) * 50;

    // Strike selection logic:
    // VIX < 13: market calm → OTM by 50pt (cheaper premium, more leverage)
    // VIX 13-18: normal → ATM (best liquidity)
    // VIX > 18: volatile → ATM (don't go OTM, decay risk too high)
    let strike = atm;
    if (vix && vix < 13) {
        strike = isBull ? atm + 50 : atm - 50;
    }

    // Try to get live LTP from pcrState option chain data
    let entryPremium = null;
    if (pcrState && pcrState.atmCEpremium && pcrState.atmPEpremium) {
        if (type === 'CE') {
            // If OTM by 50, approximate: ATM CE premium × 0.55 (rough OTM discount)
            entryPremium = strike === atm
                ? pcrState.atmCEpremium
                : parseFloat((pcrState.atmCEpremium * 0.55).toFixed(2));
        } else {
            entryPremium = strike === atm
                ? pcrState.atmPEpremium
                : parseFloat((pcrState.atmPEpremium * 0.55).toFixed(2));
        }
    }

    // If no live premium available, use Black-Scholes estimate
    if (!entryPremium && vix) {
        const sigma = vix / 100;
        const T = 3 / 365; // assume 3 days to expiry
        entryPremium = parseFloat(bsEstimate(nifty, strike, T, sigma, type).toFixed(2));
    }

    if (!entryPremium || entryPremium <= 0) return null;

    // SL = 25% of premium (standard option buyer SL)
    // Target = 50% gain on premium (1:2 R:R)
    const sl     = parseFloat((entryPremium * 0.75).toFixed(2));
    const target = parseFloat((entryPremium * 1.50).toFixed(2));

    return { type, strike, entry: entryPremium, sl, target };
}

// Simple Black-Scholes call/put price estimate
function bsEstimate(S, K, T, sigma, type) {
    const r = 0.065;
    if (T <= 0) return Math.max(0, type === 'CE' ? S - K : K - S);
    const d1 = (Math.log(S/K) + (r + 0.5*sigma*sigma)*T) / (sigma*Math.sqrt(T));
    const d2 = d1 - sigma*Math.sqrt(T);
    const N  = x => {
        const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429],p=0.3275911;
        const s=x<0?-1:1; x=Math.abs(x)/Math.sqrt(2);
        const t=1/(1+p*x),y=1-(((((a[4]*t+a[3])*t)+a[2])*t+a[1])*t+a[0])*t*Math.exp(-x*x);
        return 0.5*(1+s*y);
    };
    return type === 'CE'
        ? S*N(d1) - K*Math.exp(-r*T)*N(d2)
        : K*Math.exp(-r*T)*N(-d2) - S*N(-d1);
}

// ── AI Trade Suggestion via Claude API ────────────────────────────────────────
// Only called when a FRESH signal fires (BUY CALL or BUY PUT transition).
// The cached result is served to the frontend on every /api/trade-suggestion poll.
// This means at most 3-5 API calls per trading day — cost under ₹5/day.
let lastAISuggestion    = null;
let lastAISuggestionSignal = null;  // the signal string that triggered last AI call

async function getAITradeSuggestion(state, strikeData, winRate) {
    if (!process.env.ANTHROPIC_API_KEY) return null;

    // Only call AI when signal has CHANGED to a new direction
    // (fresh BUY CALL or BUY PUT — not a repeat of the same signal)
    const currentSignal = state.signal + '_' + state.nifty;  // direction + rough level
    if (lastAISuggestion && lastAISuggestionSignal === state.signal) {
        return lastAISuggestion;  // return cached — no API call
    }

    try {
        const winRateLine = winRate !== null ? `Past similar setups win rate: ${winRate}%` : 'Not enough past trade data yet.';

        const prompt = `You are a Nifty 50 options trading assistant for an Indian retail option BUYER.

Current market snapshot:
- Nifty: ${state.nifty}
- Signal: ${state.signal} (confidence: ${state.confidence}%)
- RSI (1m): ${state.rsi}
- VIX: ${state.vix} (${state.vixSignal})
- PCR: ${state.pcr} (${state.pcrSignal})
- ATM PCR: ${state.atmPcr}
- ADX: ${state.adx ? state.adx.adx : 'N/A'}
- MTF aligned: ${state.mtf.aligned} (${state.mtf.bullCount}/3 bull, ${state.mtf.bearCount}/3 bear)
- OI Buildup: ${state.oiBuildup.signal} — ${state.oiBuildup.label}
- Early Momentum score: ${state.earlyMom.score} — ${state.earlyMom.label}
- Entry window: ${state.entryWindow.label}
- Quality gate passed: ${state.qualityGate.passed}
- Suggested strike: ${strikeData ? strikeData.type + ' ' + strikeData.strike + ' @ ₹' + strikeData.entry : 'N/A'}
- ${winRateLine}

Based on ALL the above, give a concise trade suggestion. Keep reasoning to 2 sentences max.
Reply ONLY in this exact JSON format (no extra text, no markdown):
{"action":"BUY CE or BUY PE or WAIT","strike":24300,"entry":85,"sl":64,"target":128,"reasoning":"Two sentences max explaining why.","confidence":"HIGH or MEDIUM or LOW"}`;

        const res = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 300,
            messages: [{ role: 'user', content: prompt }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            timeout: 15000
        });

        const text = res.data?.content?.[0]?.text || '';
        const cleaned = text.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        parsed.generatedAt = new Date().toISOString();

        lastAISuggestion       = parsed;
        lastAISuggestionSignal = state.signal;  // mark which signal triggered this

        // Save to DB for training
        if (parsed.action !== 'WAIT' && strikeData) {
            await saveTradeToHistory({
                type: strikeData.type, strike: strikeData.strike,
                entry: strikeData.entry, sl: strikeData.sl, target: strikeData.target,
                niftyLevel: state.nifty, rsi: state.rsi, vix: state.vix,
                pcr: state.pcr, mtfSignal: state.mtf.signal,
                adx: state.adx?.adx, confidence: state.confidence
            });
            console.log(`💾 Trade saved to DB: ${strikeData.type} ${strikeData.strike}`);
        }

        console.log(`🤖 AI suggestion: ${parsed.action} | Strike: ${parsed.strike} | Entry: ₹${parsed.entry}`);
        return parsed;

    } catch (e) {
        console.error('AI suggestion error:', e.message);
        return null;
    }
}

// ── /api/trade-suggestion endpoint ────────────────────────────────────────────
// Called by the dashboard every 30 seconds when quality gate is passed.
// Returns: { type, strike, entry, sl, target, reasoning, confidence, winRate }


app.get('/api/trade-suggestion', async (req, res) => {
    // This route NEVER triggers an AI call directly.
    // AI is called only when a fresh signal fires in checkTelegramAlerts().
    // Here we just return the latest cached data instantly — no API cost.
    try {
        const pcrState   = getPCRState();
        const strikeData = marketState.qualityGate.passed && marketState.signal !== 'WAIT'
            ? pickStrikeAndPremium(marketState.signal, marketState.nifty, marketState.vix, pcrState)
            : null;
        const winRate = strikeData ? await getWinRateFromHistory(strikeData.type) : null;
        res.json({
            qualityGatePassed : marketState.qualityGate.passed,
            signal            : marketState.signal,
            confidence        : marketState.confidence,
            strikeData        : strikeData,
            aiSuggestion      : lastAISuggestion,   // cached — only refreshes on new signal
            winRate           : winRate,
            entryWindow       : marketState.entryWindow,
            nifty             : marketState.nifty
        });
    } catch (e) {
        console.error('trade-suggestion route:', e.message);
        res.json({ qualityGatePassed: false, signal: 'WAIT', error: e.message });
    }
});

// Update trade outcome in DB (call when you manually exit a trade)
app.post('/api/trade-history/outcome', async (req, res) => {
    const { id, outcome, exitPrice } = req.body;
    if (!dbPool) return res.json({ success: false, msg: 'No DB configured' });
    try {
        const pnl = exitPrice ? parseFloat(exitPrice) : null;
        await dbPool.query(
            'UPDATE trade_history SET outcome=$1, exit_price=$2, pnl=$3 WHERE id=$4',
            [outcome, exitPrice || null, pnl, id]
        );
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, msg: e.message });
    }
});

// View full trade history from DB
app.get('/api/trade-history', async (req, res) => {
    if (!dbPool) return res.json({ rows: [], msg: 'No DB — add DATABASE_URL to Railway' });
    try {
        const r = await dbPool.query('SELECT * FROM trade_history ORDER BY ts DESC LIMIT 100');
        res.json({ rows: r.rows });
    } catch (e) {
        res.json({ rows: [], error: e.message });
    }
});


// ── Routes ────────────────────────────────────────────
app.get('/api/signal',  (req,res) => { updateOpenTradesMTM(); res.json(marketState); });
app.get('/api/candles', (req,res) => res.json(getCandleHistory()));

// Chart historical data — fetched server-side to avoid browser CORS restrictions
app.get('/api/chart', async (req,res) => {
    const tf = req.query.tf || '5m';
    const intervalMap = { '5m':'5m', '15m':'15m', '1h':'60m' };
    const rangeMap    = { '5m':'5d', '15m':'5d', '1h':'1mo' };
    const interval = intervalMap[tf] || '5m';
    const range    = rangeMap[tf]    || '5d';
    try {
        const { fetchYahooChart } = require('./src/api/yahooFetch');  // Stooq-backed
        const result = await fetchYahooChart('%5ENSEI', { interval, range, includePrePost: false });
        const q = result?.indicators?.quote?.[0];
        if (!q) return res.json([]);
        const { open, high, low, close, volume } = q;
        const candles = [];
        for (let i = 0; i < close.length; i++) {
            if (close[i] != null && high[i] != null && low[i] != null) {
                candles.push({ open: open[i] || close[i], high: high[i], low: low[i], close: close[i], volume: volume[i] || 1 });
            }
        }
        res.json(candles);
    } catch (err) {
        console.error('Chart API error:', err.message);
        res.json([]);
    }
});
app.get('/api/global',  (req,res) => res.json(marketState.global));
app.get('/api/breadth', (req,res) => res.json(marketState.breadth));
app.get('/api/levels',  (req,res) => res.json(marketState.srLevels));

app.get('/api/health',  (req,res) => res.json({
    status:marketState.connected?'live':'waiting',
    nifty:marketState.nifty, vix:marketState.vix,
    globalBias:marketState.global.bias,
    advances:marketState.breadth.advances,
    declines:marketState.breadth.declines,
    telegram:isConfigured()?'configured':'not configured',
    source:marketState.source
}));

// PCR
app.post('/api/pcr', (req,res) => {
    const {pcr,atmPcr}=req.body;
    if(pcr!=null)    { marketState.pcr=parseFloat(pcr);    marketState.pcrSignal=pcrLabel(marketState.pcr);    trackPCRHistory(marketState.pcr); }
    if(atmPcr!=null) { marketState.atmPcr=parseFloat(atmPcr); marketState.atmPcrSignal=pcrLabel(marketState.atmPcr); }
    res.json({success:true});
});

// NSE Early Momentum + OI Buildup debug endpoints
app.get('/api/early-momentum', (req,res) => res.json(getEarlyMomState()));
app.get('/api/oi-buildup',     (req,res) => res.json(getOIBuildupState()));
app.get('/api/pcr-state',      (req,res) => res.json(getPCRState()));

// FII DII
app.post('/api/fiidii', (req,res) => {
    const {fiiBuy,fiiSell,diiBuy,diiSell}=req.body;
    if(fiiBuy!=null&&fiiSell!=null) marketState.fii={buy:parseFloat(fiiBuy),sell:parseFloat(fiiSell),net:parseFloat((fiiBuy-fiiSell).toFixed(2))};
    if(diiBuy!=null&&diiSell!=null) marketState.dii={buy:parseFloat(diiBuy),sell:parseFloat(diiSell),net:parseFloat((diiBuy-diiSell).toFixed(2))};
    res.json({success:true});
});

// Option Flow
app.post('/api/optionflow', (req,res) => {
    const {atmCE,atmPE}=req.body;
    updateOptionFlow(atmCE?parseFloat(atmCE):null, atmPE?parseFloat(atmPE):null);
    res.json({success:true, dominance:marketState.optionFlow.dominance});
});

// ── TRADE JOURNAL ─────────────────────────────────────
app.post('/api/trade/add', (req,res) => {
    const {type,strike,premium,lots,sl,notes}=req.body;
    const ist=getIST();
    const time=`${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;
    const trade = {
        id:tradeCounter++, time, type, strike:parseInt(strike),
        premium:parseFloat(premium), lots:parseInt(lots)||1,
        sl:parseFloat(sl)||0, exitPremium:null, pnl:null,
        status:'OPEN', notes:notes||'',
        niftyAtEntry:marketState.nifty,
        niftyCurrent:marketState.nifty, niftyMove:0
    };
    trades.push(trade);
    console.log(`📔 Trade: ${type} ${strike} @₹${premium} × ${lots}lots`);
    res.json({success:true, trade});
});

app.post('/api/trade/exit', (req,res) => {
    const {id,exitPremium}=req.body;
    const trade=trades.find(t=>t.id===id);
    if(!trade) return res.json({success:false,msg:'Not found'});
    trade.exitPremium=parseFloat(exitPremium);
    trade.pnl=parseFloat(((trade.exitPremium-trade.premium)*trade.lots*LOT_SIZE).toFixed(0));
    trade.status='CLOSED';
    const ist=getIST();
    trade.exitTime=`${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;
    console.log(`📔 Exit: P&L ${trade.pnl>=0?'+':''}₹${trade.pnl}`);
    res.json({success:true, trade});
});

app.delete('/api/trade/:id', (req,res) => {
    trades=trades.filter(t=>t.id!==parseInt(req.params.id));
    res.json({success:true});
});

app.get('/api/trades', (req,res) => {
    res.json({ trades:[...trades].reverse(), summary:getTradeSummary() });
});

// ── EVENTS CALENDAR ───────────────────────────────────
app.post('/api/event', (req,res) => {
    const {time,title,impact}=req.body;
    events.push({id:Date.now(),time,title,impact:impact||'medium'});
    events.sort((a,b)=>a.time.localeCompare(b.time));
    res.json({success:true});
});

app.get('/api/events', (req,res) => res.json(events));

app.delete('/api/event/:id', (req,res) => {
    events=events.filter(e=>e.id!==parseInt(req.params.id));
    res.json({success:true});
});

// Telegram test
app.post('/api/telegram/test', async (req,res) => {
    if(!isConfigured()) return res.json({success:false,msg:'Not configured'});
    await sendMorningSummary(marketState);
    res.json({success:true,msg:'Test sent!'});
});

app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(__dirname + '/public/index.html');
});

// Serve stub sw.js
app.get('/sw.js', (req,res) => { res.setHeader('Content-Type','application/javascript'); res.send('// Service Worker stub'); });

// Serve real manifest.json from disk (fixes PWA install on Android + iOS)
app.get('/manifest.json', (req,res) => res.sendFile(__dirname+'/public/manifest.json'));

// Serve PNG icons for PWA install prompt and apple-touch-icon
// Place icon-192.png, icon-512.png, apple-touch-icon.png in public/icons/
app.use('/icons', require('express').static(__dirname+'/public/icons'));
app.get('/apple-touch-icon.png', (req,res) => res.sendFile(__dirname+'/public/icons/apple-touch-icon.png'));

// ── Init ──────────────────────────────────────────────
let _intervalsStarted = false;

function startPollingIntervals() {
    if (_intervalsStarted) return;          // guard — only ever runs once
    _intervalsStarted = true;
    // Stagger intervals by 30s each so they never all fire at the same time.
    // This prevents NSE from seeing a burst of 6 requests every 3 minutes.
    setTimeout(() => setInterval(refreshMarketData, 3*60*1000), 0);
    setTimeout(() => setInterval(refreshMTF,        5*60*1000), 30*1000);
    setTimeout(() => setInterval(refreshGlobal,     5*60*1000), 60*1000);
    setTimeout(() => setInterval(refreshBreadth,    3*60*1000), 90*1000);
    setTimeout(() => setInterval(refreshSR,        10*60*1000), 120*1000);
    setTimeout(() => setInterval(refreshPCR,        3*60*1000), 150*1000);
    setTimeout(() => setInterval(fetchCalendarEvents, 60*60*1000), 180*1000); // refresh calendar hourly
    console.log('Polling intervals started (x1)');
}

// Retries Angel login only — intervals and initial data are already running
async function tryAngelLogin() {
    const auth = await loginAngel();
    if (auth) {
        console.log('Angel Login Success');
        injectAngelSession({
            jwtToken : auth.jwtToken,
            apiKey   : process.env.ANGEL_API_KEY,
        });
        startWebSocket(auth, onTick);
    }
    else      { console.log('Yahoo Finance fallback — retry in 30s'); setTimeout(tryAngelLogin, 30000); }
}

// ── Wrap any async task with a hard timeout so it never hangs startup ─────────
function withTimeout(promise, ms, label) {
    let resolved = false;
    return Promise.race([
        promise.then(result => { resolved = true; return result; }),
        new Promise(resolve => setTimeout(() => {
            if (!resolved) console.warn(`⏱ ${label} timed out after ${ms}ms — continuing`);
            resolve(null);
        }, ms))
    ]);
}

async function initializeLiveData() {
    console.log('Starting VardaanNifty AI...');
    console.log('Telegram:', isConfigured()?'✅':'❌');

    // DB init — non-blocking; app works fine without it
    initDB().catch(e => console.error('DB init error:', e.message));

    // NSE scheduler fires its own async fetches (non-blocking per nseData.js fix)
    startNSEScheduler(() => marketState.nifty);

    // Initial data load — staggered to avoid hammering NSE with simultaneous requests.
    // NSE blocks Railway IPs that send too many concurrent requests at startup.
    // Each group waits for the previous to finish before starting.
    console.log('📡 Initial data load — staggered to avoid NSE rate limits...');
    // ── Seed candle history from Yahoo Finance first ──────────────────────────
    // NSE intraday candle API is blocked on Railway IPs. Yahoo Finance ^NSEI
    // is not blocked and gives us today's 5m candles to warm up RSI/EMA/VWAP/ADX
    // before the first refreshMarketData() call completes.
    await withTimeout(loadCandlesFromYahoo(), 15000, 'loadCandlesFromYahoo');
    await withTimeout(refreshMarketData(), 25000, 'refreshMarketData');
    await new Promise(r => setTimeout(r, 3000));
    await withTimeout(refreshGlobal(),     15000, 'refreshGlobal');
    await new Promise(r => setTimeout(r, 2000));
    await withTimeout(refreshBreadth(),    20000, 'refreshBreadth');
    await new Promise(r => setTimeout(r, 2000));
    await withTimeout(refreshMTF(), 20000, 'refreshMTF');
    await new Promise(r => setTimeout(r, 2000));
    await Promise.all([
        withTimeout(refreshSR(),  15000, 'refreshSR'),
        withTimeout(refreshPCR(), 15000, 'refreshPCR'),
    ]);
    await withTimeout(fetchCalendarEvents(), 10000, 'fetchCalendarEvents');

    // Polling intervals start regardless of whether initial fetches succeeded
    startPollingIntervals();

    // ── Bug fix: ensure frontend exits splash screen even when market is closed ──
    // When market is closed, nifty=0 and connected=false, which traps the frontend
    // on 'Initialising markets...' forever. Mark initialisation as done so the UI
    // can render properly (it will show '--' for price, which is correct).
    if (!marketState.connected) {
        marketState.connected = true;
        marketState.source    = 'init';
        console.log('✅ Init complete — market closed, frontend unblocked');
    }

    // Angel login runs after server is listening — retries in the background
    // and never block the HTTP server from accepting frontend connections.
    tryAngelLogin().catch(e => console.error('Angel login error:', e.message));
}

// ── Listen FIRST so the frontend is never blocked by init ────────────────────
// initializeLiveData() runs in the background. The frontend gets the default
// marketState (nifty:0, signal:'WAIT') immediately, then live data populates
// within 3-20 seconds as each fetch completes.
server.listen(PORT, () => {
    console.log(`VardaanNifty AI running on port ${PORT}`);
    server.keepAliveTimeout = 120000;
    server.headersTimeout   = 125000;
    // Start init AFTER server is already accepting connections
    initializeLiveData().catch(e => console.error('Init error:', e.message));
});