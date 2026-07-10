require('dotenv').config();

const express  = require('express');
const http     = require('http');
const cors     = require('cors');
const axios    = require('axios');

const loginAngel                    = require('./src/api/angelAuth');
const startWebSocket                = require('./src/api/websocket');

// ── SSE: Server-Sent Events for instant frontend push ────────────────────────
const _sseClients = new Set();
function sseBroadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of _sseClients) {
        try { res.write(msg); } catch(_) { _sseClients.delete(res); }
    }
}
const { processIndicators,
        initializeHistory,
        getCandleHistory,
        getSessionCandles,
        loadCandlesFromYahoo, getCandleSource,
        calcMomentumBreakdown,
        computePOC, computeDelta }                    = require('./src/api/indicators');
const { fetchMarketData }           = require('./src/api/marketData');
const { analyzeMultiTimeframe }     = require('./src/api/multiTimeframe');
const { fetchGlobalCues }           = require('./src/api/globalCues');
const { fetchAdvanceDecline,
        injectAngelSession }        = require('./src/api/breadth');
const { calculateSRLevels }         = require('./src/api/levels');
const { getSwingTrend, getReactionZoneGate, calcForceLabel, getLatestImpulseFibo } = require('./src/api/physicsOfTrading');
const { suggestSpreadStrategy }     = require('./src/api/spreadStrategy');
const {
    injectDBPool      : injectHistDBPool,
    initHistoricalData,
    dailyTopUp        : histDailyTopUp,
    runBacktest,
    getHistoricalCandles,
}                                   = require('./src/api/historicalData');
const {
    startNSEScheduler,
    getPCRState, getFIIState, getOIBuildupState, getEarlyMomState,
    getCurrentFIINet, getCurrentDIINet,
    interpretEarlyMomentum, interpretOIBuildup,
    isExpiryDay,
    isNSEHoliday,
    injectAngelSession: injectAngelSessionNSE,   // nseData Angel session for PCR
    triggerInitialPCR,                            // fire first PCR after Angel login
    fetchFyersQuote,                              // real volume/OHLC for index (Angel WS sends 0)
    getCurrentFyersFutSymbol,                     // correct NSE:NIFTY{YY}{MMM}FUT symbol (NIFTY-I is invalid on Fyers)
} = require('./src/api/nseData');
const {
    sendSignalAlert, sendMTFAlert,
    sendMorningSummary, sendVIXAlert,
    sendCloseSummary, sendExitAlert,
    sendNishanebaazAlert, sendSpreadAlert, sendRawMessage, isConfigured
}                                   = require('./src/api/telegram');

const app    = express();
const server = http.createServer(app);
// CORS — allow only the Railway deployment domain and local dev.
// RAILWAY_PUBLIC_DOMAIN is set automatically by Railway at runtime.
const _allowedOrigins = [
    process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null,
    'http://localhost:8080',
    'http://localhost:3000',
].filter(Boolean);
app.use(cors({
    origin: (origin, cb) => {
        // Allow same-origin requests (no Origin header) and whitelisted origins
        if (!origin || _allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
        console.warn(`[CORS] Blocked request from origin: ${origin}`);
        cb(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-App-Token'],
}));
app.use(express.json());
app.use(express.static('public', { etag: false, maxAge: 0 }));

const PORT    = process.env.PORT || 8080;
const LOT_SIZE = 65;   // Nifty 50 lot size (revised Jan 2026 by NSE: 75 → 65)

// ── Market State ──────────────────────────────────────
let marketState = {
    nifty: 0, lastClose: 0, change: 0, changePct: 0, marketClosed: true,
    signal: 'WAIT', confidence: 0,
    rsi: null, ema9: null, ema21: null, vwap: null,
    pcr: null, atmPcr: null, pcrSignal: 'N/A', atmPcrSignal: 'N/A',
    pcrSource: 'pending', // 'auto' after first NSE fetch | 'manual' if user overrides
    pcrUnavailable: false, // true when NSE has never returned option chain data
    pcrFromIndex: 'NIFTY', // 'NIFTY' or 'BANKNIFTY' when PCR is a BankNifty proxy fallback
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
    candles5mRecent: [],
    sweepReversal: { detected: false, direction: null, strength: 0, reason: '' },
    pcrHistory: [],
    // PCR Slope — rate of change of PCR across the session (morning → close)
    pcrSlope: { slopePerHour: null, recentSlopePerHour: null, trend: 'FLAT', label: 'PCR Slope — awaiting data', sessionHigh: null, sessionLow: null, sessionOpen: null },
    // Standalone Fibonacci Retracement card — computed every cycle (independent of
    // active BUY signal) so the UI always shows the latest swing's fib levels.
    fiboCard: null,
    physicsOfTrading: {
        swingTrend: null,       // { direction:'UP'|'DOWN'|'SIDEWAYS', hhhl: bool, reason: str }
        reactionGate: null,     // { zone:'REACTION'|'ACTION'|'REVERSAL_RISK', score: num, reason: str }
        law1: { status:'WAIT', label:'Awaiting candle data…', direction:null },
        law2: { status:'WAIT', label:'Awaiting force data…', bullish:false, bearish:false, bits:[] },
        law3: { status:'WAIT', label:'Awaiting swing + price data…', zone:null, retracePct:null },
        entryReady: false,
        entryLabel: '⏳ Waiting for all 3 Laws…',
        entryColor: 'dim',
        updatedAt: null,
    },
    fii: { buy:null, sell:null, net:null },
    dii: { buy:null, sell:null, net:null },
    optionFlow: { atmCEpremium:null, atmPEpremium:null, ceChange:0, peChange:0, dominance:'NEUTRAL', history:[] },
    reason: ['Waiting...'], lastUpdated:null, connected:false, source:'none', dataPoints:0,
    adx: null,
    earlyMom: { score: null, signal: 'NEUTRAL', strength: 0, label: 'Early Momentum — awaiting data', votes: [] },
    oiBuildup: { signal: 'NEUTRAL', strength: 0, label: 'OI Buildup — awaiting data', maxCEoiStrike: null, maxPEoiStrike: null, totalCEoiChange: null, totalPEoiChange: null },
    poc:   { poc: null, vah: null, val: null, signal: 'INSUFFICIENT', label: 'POC — awaiting data' },
    delta: { delta: 0, deltaPct: 0, signal: 'NEUTRAL', divergence: false, label: 'Delta — awaiting data' },
    // ── WebSocket Mode 2 live fields (updated every tick from Angel WS) ───────
    wsVolume  : 0,     // session cumulative volume from WS (resets 9:15 AM)
    wsBuyQty  : 0,     // total buy orders at market — buying pressure
    wsSellQty : 0,     // total sell orders at market — selling pressure
    wsOpen    : 0,     // session open from WS
    wsHigh    : 0,     // session high from WS (live)
    wsLow     : 0,     // session low from WS (live)
    sessionOpenPrice: 0, // first valid tick of today — used for accurate day-change in Close Summary
    // ── Murarka Strategy fields ───────────────────────────────────────────────
    // PCR Zone: 'BULL' (>1.15) | 'AVOID' (0.75–1.15) | 'BEAR' (<0.75)
    pcrZone: { zone: 'AVOID', label: 'Awaiting PCR…', color: 'amber', pcr: null },
    // OI Imbalance Ratio = ΔPuts OI / ΔCalls OI (Murarka's key metric)
    oiImbalanceRatio: null,
    // Murarka Entry Alert: fires when PCR zone is active + price near VWAP
    murarkaEntry: { active: false, side: null, label: 'No setup yet', reason: '' },
    entryWindow: { status:'closed', label:'Market Closed', safe:false },
    qualityGate: { mtfAligned:false, rsiClean:true, safeWindow:false, vixSafe:true, adxTrend:true, srClear:true, passed:false },
    calendarEvents: [],
    btst: null,
    momentum: { signal: 'NONE', strength: 0, velocity: 0, volumeRatio: 0, candleBody: 0, reason: '', canTrade: false },
    smartMoney: { bias: 'NEUTRAL', score: 0, label: 'Smart Money — awaiting data', components: [] },
    // ── Candle pattern — initialized so frontend never stays on "Waiting for candle data..." ──
    candlePattern: { pattern: 'NONE', direction: 'NEUTRAL', strength: 0, reason: 'Waiting for session candles...' },
    cpMTF: { cp5m: null, cp15m: null, cp1h: null, cpBull: 0, cpBear: 0, cpConsensus: 'NEUTRAL', cpConsensusLabel: 'Waiting...' },
    // ── Trend Day vs Range Day — morning strategy guidance ────────────────────
    dayType: { trendProbability: 0, rangeProbability: 0, recommendation: { favor: 'NEUTRAL', avoid: '', label: 'Awaiting data...' }, adx: null, mtfAligned: false, orbStatus: 'FORMING' },
    // ── Trap Zone — VWAP/POC chop pocket warning ──────────────────────────────
    trapZone: { active: false, label: 'Trap Zone — awaiting data' },
    // ── Signal Performance — today's live tracking cards ──────────────────────
    signalPerformance: { open: [], todayAccuracy: null, todayCount: 0 },
    // ── Contradiction Score — 6-factor weighted bull/bear check ────────────────
    contradictionScore: { bullWeight: 0, bearWeight: 0, diff: 0, bullFactors: [], bearFactors: [], contradiction: false, result: 'NEUTRAL' },
    // ── Strict Sequential Agreement — MTF→PCR→Delta→ORB→VWAP→Value Area ────────
    agreementSequence: { passed: true, failedAt: null, steps: [] },
    // ── Trend Conviction Mode — stacked structural bias, active gate ───────────
    trendConviction: { active: null, bearConditions: [], bullConditions: [], bearCount: 0, bullCount: 0 },
    // ── Confidence Breakdown — top contributing factors for the active signal ─
    confidenceBreakdown: { items: [], final: 0 },
};

// ── Trade Journal ─────────────────────────────────────
let trades       = [];
let tradeCounter = 1;
let events       = [];
// ── Signal Performance Tracking (automatic, independent of Journal) ─────────
let openPerfRecords = [];   // records currently being tracked toward target/SL
const PERF_AUTOCLOSE_MIN = 90;  // auto-close untouched signals after 90 min (theta eats the edge past this)

// ── Helpers ───────────────────────────────────────────
let historyLoaded=false, prevSignal='WAIT', prevMTFAligned=false;
// ── Trend Lock state (signal-flip prevention) ──────────────────────────────
// External day-audit feedback flagged rapid CALL→PUT→CALL whipsaws (e.g. 12:50
// PM BUY CALL → 1:02 PM BUY PUT, only 12 min apart) as the single biggest
// quality issue — most were reversed again shortly after, costing traders on
// both sides of the flip. A full direction reversal (CALL↔PUT, not WAIT↔CALL
// or WAIT↔PUT — those aren't reversals) now needs to PERSIST for a minimum
// duration before it's allowed through as a real signal change.
let pendingFlipSignal = null;   // the opposite-direction signal currently "waiting to confirm"
let pendingFlipSince  = 0;      // ms timestamp when it first appeared
let lastDirectionalSignal = 'WAIT'; // last CONFIRMED non-WAIT signal actually shown to the user —
                                     // tracked separately from prevSignal because prevSignal gets
                                     // overwritten to 'WAIT' while a reversal is locked/pending,
                                     // which would otherwise let the very next cycle's opposite
                                     // signal sail through as a fresh "WAIT→PUT" (bypassing the lock).
let signalSince = 0; // ms timestamp when lastDirectionalSignal last CHANGED — powers "Signal Age" display
const TREND_LOCK_MS   = 10 * 60 * 1000; // 10 min — long enough to filter noise, short enough to stay responsive

// ── Opening Range Breakout (ORB) state ─────────────────────────────────────
// First 15 minutes (9:15–9:30 IST) often sets the tone for the rest of the
// session. Once that range is locked in, price breaking above/below it is a
// meaningful intraday filter (per external feedback review).
let orbHigh = null, orbLow = null, orbDate = null;

// ── Day-open option premium tracking (for Option Premium Filter) ──────────
// Freshly-computed once per day from the first valid ATM CE/PE premium seen.
// Used to detect "premium already overextended" before issuing a fresh entry.
let atmCEpremiumOpen = null, atmPEpremiumOpen = null, premiumOpenDate = null;
let lastMTFAlertAt=0, lastMTFAlertSignal='';  // cooldown: 30 min between same-direction MTF alerts
// ── MTF-tracker reversal persistence (soft, informational-tier cooldown) ────
// Problem observed live (10 Jul session): mtfSignalChanged bypasses the 60-min
// cooldown entirely, so when the MTF vote whipsaws (CALL→PUT→CALL within
// minutes — 12:31 PUT → 12:37 CALL → 12:55 PUT → 1:01 CALL → 1:21 PUT → 1:25
// CALL, all same afternoon), every single flip fired its own Telegram alert.
// This is ONLY a Telegram-noise fix — the Live/Insights tabs still show the
// MTF vote updating in real time regardless. Fix: a reversal (direction
// actually flips from the last alert's direction) must persist for
// MTF_REVERSAL_CONFIRM_MS before it's allowed to fire a new alert. This is
// deliberately soft (~10 min, not 20–30) and never blocks the FIRST alert of
// the day or a same-direction re-confirmation after the normal 60-min
// cooldown — only rapid direction flips are held back briefly.
let pendingMTFFlipSignal = null, pendingMTFFlipSince = 0;
const MTF_REVERSAL_CONFIRM_MS = 10 * 60 * 1000;
let morningSummarySent=false, closeSummarySent=false, vixAlertSent=false;
let nishanebaazAlertSent=false;  // one-shot: fired once at 14:00 per day
let pcrClearedToday=false;   // guards the one-shot stale-manual-PCR wipe at 09:15
let _pcrHistoryDate = null;  // IST date-string of the session pcrHistory currently belongs to
let signalStreak = { signal: 'WAIT', count: 0 }; // consecutive same-signal counter
let btstSentToday=false;     // one-shot: BTST/STBT Telegram alert per day
let telegramAlertInFlight=false; // race-condition guard — prevents duplicate sends when onTick fires concurrently
let ema920AlertSentToday=false;  // one-shot: 9:20 AM EMA-VWAP setup alert per day
let lastSignalFiredPrice=0;  // price level at which last SIGNAL CHANGED alert was sent
                             // prevents duplicate alerts when Nifty barely moves between ticks
let lastSpreadAlertAt=0;     // cooldown: spread strategy alert max once per 60 min
let lastSpreadStrategy='';   // last spread type sent — avoid repeat of same strategy
let _sessionOpenPrice=0;     // first valid price seen each trading day — used for
                              // accurate day's net change in Close Summary (wsOpen is
                              // always 0 for the Nifty index — WS Mode 2 doesn't send
                              // OHLC for indices, only for tradeable instruments)
let _sessionOpenDate='';     // IST date-string the above belongs to — reset daily

function isMarketOpen() {
    const ist = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}));
    const day = ist.getDay();
    if (day === 0 || day === 6) return false;  // weekend
    if (isNSEHoliday(ist)) return false;       // NSE holiday — sourced from nseData.js
    const m = ist.getHours()*60 + ist.getMinutes();
    return m >= 555 && m <= 930;
}
function getIST() { return new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'})); }
function isSafeEntryWindow() {
    const ist = getIST();
    const m   = ist.getHours()*60 + ist.getMinutes();
    if (m < 555) return { status:'pre',      label:'Pre-Open',                   safe:false, reason:'Market not open yet' };
    if (m < 600) return { status:'volatile', label:'Volatile (9:15–10:00)',        safe:false, reason:'Gap-fill window — wait for 10:00 (Murarka strategy)' };
    if (m < 840) return { status:'trade',    label:'Safe Entry (10:00–14:00)',      safe:true,  reason:null };
    if (m < 870) return { status:'caution',  label:'⚠️ Caution Zone (14:00–14:30)',safe:true,  reason:'Reduce position size — theta decay starting' };
    if (m <= 930) return { status:'theta',   label:'Theta Zone (14:30–15:30)',     safe:false, reason:'Theta decay accelerating — avoid new entries' };
    return              { status:'closed',   label:'Market Closed',               safe:false, reason:'Market closed' };
}

// Returns true if today is a weekday AND time is within NSE market window (9:00-15:35 IST)
// Used to skip heavy processing (PCR, MTF, breadth, SR) on weekends and outside market hours
// The app stays online but conserves Railway CPU/memory — fits within 500 hrs/month hobby plan

// NSE holiday data (NSE_HOLIDAYS_2026/2027) and isNSEHoliday() now live in
// src/api/nseData.js as the single source of truth, imported above — this
// avoids three separate (and previously inconsistent) holiday lists drifting
// out of sync with each other and with the official NSE circular.

function isNSEMarketDay() {
    const ist = getIST();
    const day = ist.getDay();          // 0=Sun, 1=Mon ... 5=Fri, 6=Sat
    const m   = ist.getHours()*60 + ist.getMinutes();
    if (day === 0 || day === 6) return false;   // Weekend
    if (isNSEHoliday(ist))     return false;   // NSE holiday
    return m >= 540 && m <= 935;                // 9:00 AM to 15:35 IST only
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

// ── Murarka PCR Zone + Entry Alert ────────────────────────────────────────────
// Based on CA Nitin Murarka (SMC Global) methodology:
//   PCR > 1.15 → Buy CE zone (bullish imbalance — put writers dominating)
//   PCR < 0.75 → Buy PE zone (bearish imbalance — call writers dominating)
//   0.75–1.15  → Avoid (market indecision — Murarka says don't trade)
// Entry trigger: PCR in zone AND spot within ±0.15% of VWAP (VWAP dip/bounce)
// On expiry days (Tuesday): tighten thresholds (1.1 / 0.8) — less noise
function computeMurarkaZone(pcr, spot, vwap, isExpiry) {
    const bullThr = isExpiry ? 1.10 : 1.15;
    const bearThr = isExpiry ? 0.80 : 0.75;
    let zone, label, color;
    if (pcr === null) { zone = 'AVOID'; label = 'PCR N/A — Awaiting data'; color = 'amber'; }
    else if (pcr > bullThr)  { zone = 'BULL'; label = `PCR ${pcr.toFixed(2)} > ${bullThr} — BUY CE Zone ✅`; color = 'green'; }
    else if (pcr < bearThr)  { zone = 'BEAR'; label = `PCR ${pcr.toFixed(2)} < ${bearThr} — BUY PE Zone 🔻`; color = 'red'; }
    else                     { zone = 'AVOID'; label = `PCR ${pcr !== null ? pcr.toFixed(2) : '--'} in ${bearThr}–${bullThr} — AVOID ⚠️`; color = 'amber'; }

    // Murarka Entry Alert: PCR in actionable zone + spot within ±0.2% of VWAP
    let murarkaEntry = { active: false, side: null, label: 'No Murarka setup', reason: '' };
    if (zone !== 'AVOID' && spot && vwap && vwap > 0) {
        const vwapDist = Math.abs((spot - vwap) / vwap) * 100;
        if (vwapDist <= 0.2) {
            const side = zone === 'BULL' ? 'CE' : 'PE';
            murarkaEntry = {
                active: true,
                side,
                label: `🎯 Murarka Entry! Buy ${side} — PCR ${zone} + Near VWAP (${vwapDist.toFixed(2)}% away)`,
                reason: `PCR=${pcr?.toFixed(2)} | VWAP=₹${vwap?.toFixed(0)} | Spot=₹${spot?.toFixed(0)}`
            };
        } else {
            murarkaEntry = {
                active: false, side: zone === 'BULL' ? 'CE' : 'PE',
                label: `PCR Zone ${zone} ✅ — Wait for VWAP touch (${vwapDist.toFixed(2)}% away)`,
                reason: `Need spot ≤0.2% from VWAP for Murarka entry`
            };
        }
    }

    return { pcrZone: { zone, label, color, pcr }, murarkaEntry };
}

// ── ADX Calculator — Wilder's smoothing, period=14 ───────────────────────────
// Uses candle history already stored in memory (no extra API calls / packages).
// Returns { adx, diPlus, diMinus } or null when insufficient data.
function calculateADX(candles, period = 14) {
    if (!candles || candles.length < period * 2 + 2) return null;
    try {
        // ROOT CAUSE FIX: Do NOT filter flat candles (high==low).
        // Filtering creates time gaps between surviving bars — a bar 15min after
        // the previous one has a huge True Range (|close gap| = 50-200pts for Nifty)
        // which makes Wilder's smoothing produce ADX > 100 indefinitely.
        //
        // Instead: keep ALL candles. For flat bars (high==low or null OHLC),
        // use close-based True Range = |close[i] - close[i-1]|.
        // This preserves time-continuity and gives correct small TR for flat bars.
        const valid = candles.filter(c => c.close != null);
        if (valid.length < period * 2 + 2) return null;
        const tr = [], dmp = [], dmm = [];
        for (let i = 1; i < valid.length; i++) {
            const c  = valid[i],   pc = valid[i - 1];
            const h  = c.high  ?? c.close;
            const l  = c.low   ?? c.close;
            const ph = pc.high ?? pc.close;
            const pl = pc.low  ?? pc.close;
            const pclose = pc.close;
            // True Range: use full Wilder formula when OHLC is real,
            // fall back to |close - prevClose| for flat/index-only bars
            const trVal = (h === l)
                ? Math.abs(c.close - pclose)           // flat bar: close-only TR
                : Math.max(h - l, Math.abs(h - pclose), Math.abs(l - pclose));
            tr.push(trVal);
            // flat bar: DM+ = DM- = 0 (no directional movement possible)
            // Without this, DM can EXCEED TR → DI > 100% → ADX explodes to 300+
            const up = (h === l) ? 0 : (h - ph);
            const dn = (h === l) ? 0 : (pl - l);
            dmp.push(up > dn && up > 0 ? up : 0);
            dmm.push(dn > up && dn > 0 ? dn : 0);
        }
        // Wilder's running smooth: seed = sum of first `period` bars, then iterate
        function wilderSmooth(arr) {
            // FIXED: Wilder initial = AVERAGE of first `period` values (not sum)
            // Using sum caused ADX initial value to be 14x too large → ADX > 100 permanently
            let s = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
            const out = [s];
            for (let i = period; i < arr.length; i++) { s = (s * (period - 1) + arr[i]) / period; out.push(s); }
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
            // Throttle this warning to once per 5 min to avoid log spam
            const now = Date.now();
            if (!calculateADX._lastWarn || now - calculateADX._lastWarn > 300_000) {
                console.warn(`⚠️ ADX out of range (${adxVal}) — opening-bar gap in data, suppressing until fixed`);
                calculateADX._lastWarn = now;
            }
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
    const dateStr = `${ist.getFullYear()}-${ist.getMonth()}-${ist.getDate()}`;
    // Hard reset at the first tick of a new IST calendar day — without this,
    // raising the cap to 200 means yesterday's tail-end ticks would linger
    // into this morning's array (the old 50-cap masked this by self-purging
    // fast; the manual-PCR guard elsewhere only fires conditionally, not
    // every day), corrupting the slope regression with mixed-day timestamps.
    if (_pcrHistoryDate !== dateStr) {
        marketState.pcrHistory = [];
        _pcrHistoryDate = dateStr;
    }
    const time = `${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;
    marketState.pcrHistory.push({ time, pcr: parseFloat(pcr.toFixed(2)), signal: pcrLabel(pcr) });
    // Cap at 200 — PCR refetches every 3 min, so a full 9:15→15:30 session is
    // ~125 ticks. 200 leaves headroom for manual entries / pre-post market.
    if (marketState.pcrHistory.length > 200) marketState.pcrHistory.shift();
    marketState.pcrSlope = calcPCRSlope(marketState.pcrHistory);
    savePCRTick(pcr, marketState.atmPcr, marketState.nifty, pcrLabel(pcr)).catch(()=>{});
}

// ── PCR Slope ──────────────────────────────────────────────────────────────
// "Slope" = rate of change of PCR across the session, in PCR-points-per-hour.
// Computed two ways:
//   1. slopePerHour       — least-squares regression over the WHOLE day's
//                            ticks (9:15 → now). Tells you the day's broad
//                            drift: are option writers building puts (bullish
//                            drift) or calls (bearish drift) as the day wears on.
//   2. recentSlopePerHour — same regression but only the last 10 ticks
//                            (~30 min). Tells you current/short-term momentum,
//                            which can diverge from the day's broad drift
//                            (e.g. day was bullish-drifting but last 30 min
//                            is reversing — useful early-warning signal).
// `time` is "HH:MM" IST — converted to minutes-since-market-open (9:15) for
// the regression x-axis so slope is denominated cleanly per hour.
function _pcrTimeToMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return (h * 60 + m) - (9 * 60 + 15); // minutes since 09:15 IST open
}

function _linRegSlope(points) {
    // points: [{x, y}] — returns slope (y per unit x) via least squares, or null if <2 distinct x
    const n = points.length;
    if (n < 2) return null;
    const sumX = points.reduce((a, p) => a + p.x, 0);
    const sumY = points.reduce((a, p) => a + p.y, 0);
    const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
    const sumXX = points.reduce((a, p) => a + p.x * p.x, 0);
    const denom = (n * sumXX - sumX * sumX);
    if (denom === 0) return null; // all same x (no time spread yet)
    return (n * sumXY - sumX * sumY) / denom;
}

function calcPCRSlope(history) {
    if (!history || history.length < 2) {
        return { slopePerHour: null, recentSlopePerHour: null, trend: 'FLAT', label: 'PCR Slope — collecting data…', sessionHigh: null, sessionLow: null, sessionOpen: null };
    }
    const pts = history.map(h => ({ x: _pcrTimeToMinutes(h.time), y: h.pcr }));

    const slopePerMin = _linRegSlope(pts);
    const slopePerHour = slopePerMin !== null ? parseFloat((slopePerMin * 60).toFixed(3)) : null;

    const recentPts = pts.slice(-10);
    const recentSlopePerMin = _linRegSlope(recentPts);
    const recentSlopePerHour = recentSlopePerMin !== null ? parseFloat((recentSlopePerMin * 60).toFixed(3)) : null;

    const pcrVals = history.map(h => h.pcr);
    const sessionHigh = Math.max(...pcrVals);
    const sessionLow  = Math.min(...pcrVals);
    const sessionOpen = history[0].pcr;

    // Trend label driven by the RECENT slope (more actionable than the full-day
    // drift) — threshold tuned so small noise doesn't flip-flop the label.
    const s = recentSlopePerHour ?? slopePerHour;
    let trend, emoji;
    if (s === null)        { trend = 'FLAT';    emoji = '➖'; }
    else if (s > 0.15)     { trend = 'RISING';  emoji = '📈'; }   // PCR climbing → put writers piling in → bullish drift
    else if (s < -0.15)    { trend = 'FALLING'; emoji = '📉'; }   // PCR falling → call writers piling in → bearish drift
    else                    { trend = 'FLAT';    emoji = '➖'; }

    const dirNote = trend === 'RISING'  ? 'put writers building (bullish drift)'
                  : trend === 'FALLING' ? 'call writers building (bearish drift)'
                  : 'no clear directional build-up';
    const label = `${emoji} PCR Slope ${s !== null ? (s > 0 ? '+' : '') + s.toFixed(2) : '--'}/hr — ${dirNote}`;

    return { slopePerHour, recentSlopePerHour, trend, label, sessionHigh, sessionLow, sessionOpen };
}

function updateOptionFlow(atmCE, atmPE) {
    // Capture the day's FIRST valid ATM premium reading — static reference for
    // the rest of the session, used by the Option Premium Filter below.
    const todayStr = getIST().toISOString().slice(0, 10);
    if (premiumOpenDate !== todayStr) { atmCEpremiumOpen = null; atmPEpremiumOpen = null; premiumOpenDate = todayStr; }
    if (atmCEpremiumOpen === null && atmCE > 0) atmCEpremiumOpen = atmCE;
    if (atmPEpremiumOpen === null && atmPE > 0) atmPEpremiumOpen = atmPE;

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
    const ceChangeFromOpen = atmCEpremiumOpen > 0 && atmCE > 0 ? parseFloat((((atmCE - atmCEpremiumOpen) / atmCEpremiumOpen) * 100).toFixed(1)) : 0;
    const peChangeFromOpen = atmPEpremiumOpen > 0 && atmPE > 0 ? parseFloat((((atmPE - atmPEpremiumOpen) / atmPEpremiumOpen) * 100).toFixed(1)) : 0;
    marketState.optionFlow = { atmCEpremium:atmCE||prev.atmCEpremium, atmPEpremium:atmPE||prev.atmPEpremium, ceChange, peChange, ceChangeFromOpen, peChangeFromOpen, dominance, history };
}

// ── Smart Money Bias Aggregator ───────────────────────────────────────────────
// Combines 4 institutional signals into a single directional read:
//   1. OI Buildup (Fresh Long / Fresh Short / Short Covering / Long Unwinding)
//   2. FII + DII Net Flow (institutional cash positioning)
//   3. PCR Extreme Levels (option writers' institutional intent)
//   4. ATM CE vs PE premium ratio (real-money directional bet at current price)
//
// Score range: −8 to +8.  >2 = BULLISH, <−2 = BEARISH, else NEUTRAL.
// Returns: { bias, score, label, components[] }
function computeSmartMoneyBias() {
    let score = 0;
    const components = [];

    // ── 1. OI Buildup: price × OI direction ──────────────────────────────────
    // Fresh Long (Price↑ OI↑) = smart money buying = +2
    // Short Covering (Price↑ OI↓) = shorts covering, weak rally = +1
    // Fresh Short (Price↓ OI↑) = smart money selling = −2
    // Long Unwinding (Price↓ OI↓) = bulls exiting = −1
    // interpretOIBuildup() returns signal:'BULL'|'BEAR'|'NEUTRAL' + strength:0|1|2
    // strength 2 = strong confirmation (PCR confirms), strength 1 = moderate
    const oi = marketState.oiBuildup;
    if (oi && oi.signal && oi.signal !== 'NEUTRAL') {
        const sig = oi.signal.toUpperCase();  // 'BULL' or 'BEAR'
        const str = oi.strength || 1;         // 1 or 2
        const pts = sig === 'BULL' ? str : -str;
        const shortLabel = oi.label
            ? oi.label.replace('OI Buildup — ', '').split(' — ')[0]  // trim prefix
            : (sig === 'BULL' ? 'Bullish OI 🐂' : 'Bearish OI 🐻');
        score += pts;
        components.push({ label: 'OI Buildup', value: shortLabel, pts, bull: sig === 'BULL' });
    } else {
        components.push({ label: 'OI Buildup', value: 'Awaiting data', pts: 0, bull: null });
    }

    // ── 2. FII + DII combined net flow ───────────────────────────────────────
    // FII net: strong institutional signal, weight 2 (±2 for >500Cr, ±1 otherwise)
    // DII net: supporting signal, weight 1
    const fii = marketState.fii;
    const dii = marketState.dii;
    // BUG2 FIX: use typeof check — net can be 0 (falsy) or non-numeric
    const fiiNet = (fii && typeof fii.net === 'number') ? fii.net : null;
    const diiNet = (dii && typeof dii.net === 'number') ? dii.net : null;
    if (fiiNet !== null) {
        const w = Math.abs(fiiNet) > 500 ? 2 : 1;
        if (fiiNet > 0) {
            score += w;
            components.push({ label: 'FII Flow', value: `Net Buy ₹${fiiNet.toFixed(0)}Cr`, pts: +w, bull: true });
        } else if (fiiNet < 0) {
            score -= w;
            components.push({ label: 'FII Flow', value: `Net Sell ₹${Math.abs(fiiNet).toFixed(0)}Cr`, pts: -w, bull: false });
        } else {
            components.push({ label: 'FII Flow', value: 'Net Flat ₹0Cr', pts: 0, bull: null });
        }
    } else {
        components.push({ label: 'FII Flow', value: 'Awaiting data', pts: 0, bull: null });
    }
    if (diiNet !== null) {
        if (diiNet > 0) {
            score += 1;
            components.push({ label: 'DII Flow', value: `Net Buy ₹${diiNet.toFixed(0)}Cr`, pts: +1, bull: true });
        } else if (diiNet < 0) {
            score -= 1;
            components.push({ label: 'DII Flow', value: `Net Sell ₹${Math.abs(diiNet).toFixed(0)}Cr`, pts: -1, bull: false });
        } else {
            components.push({ label: 'DII Flow', value: 'Net Flat ₹0Cr', pts: 0, bull: null });
        }
    } else {
        components.push({ label: 'DII Flow', value: 'Awaiting data', pts: 0, bull: null });
    }

    // ── 3. PCR Extreme Levels — institutional option writer intent ────────────
    // PCR > 1.3  = institutions writing puts heavily = bullish intent  (+2)
    // PCR 1.1-1.3 = mild bullish                                       (+1)
    // PCR 0.7-0.9 = mild bearish                                       (−1)
    // PCR < 0.7  = institutions writing calls heavily = bearish intent  (−2)
    const pcr = marketState.pcr;
    if (pcr !== null && pcr > 0) {
        if      (pcr > 1.3)             { score += 2; components.push({ label: 'PCR Level', value: `${pcr.toFixed(2)} — Put Writing 🐂`, pts: +2, bull: true }); }
        else if (pcr >= 1.1)            { score += 1; components.push({ label: 'PCR Level', value: `${pcr.toFixed(2)} — Mildly Bullish`, pts: +1, bull: true }); }
        else if (pcr >= 0.9)            {             components.push({ label: 'PCR Level', value: `${pcr.toFixed(2)} — Neutral zone`, pts: 0, bull: null }); }
        else if (pcr >= 0.7)            { score -= 1; components.push({ label: 'PCR Level', value: `${pcr.toFixed(2)} — Mildly Bearish`, pts: -1, bull: false }); }
        else                            { score -= 2; components.push({ label: 'PCR Level', value: `${pcr.toFixed(2)} — Call Writing 🐻`, pts: -2, bull: false }); }
    } else {
        components.push({ label: 'PCR Level', value: 'Awaiting data', pts: 0, bull: null });
    }

    // ── 4. ATM CE vs PE premium ratio — real-money directional bet ───────────
    // CE/PE ratio > 1.25 = call buyers more aggressive = bullish (+1)
    // CE/PE ratio < 0.80 = put buyers more aggressive = bearish  (−1)
    const optFlow = marketState.optionFlow;
    if (optFlow && optFlow.atmCEpremium && optFlow.atmPEpremium && optFlow.atmCEpremium > 0 && optFlow.atmPEpremium > 0) {
        const ratio = optFlow.atmCEpremium / optFlow.atmPEpremium;
        if (ratio > 1.25) {
            score += 1;
            components.push({ label: 'ATM Flow', value: `CE/PE=${ratio.toFixed(2)} — Call buyers dominant`, pts: +1, bull: true });
        } else if (ratio < 0.80) {
            score -= 1;
            components.push({ label: 'ATM Flow', value: `CE/PE=${ratio.toFixed(2)} — Put buyers dominant`, pts: -1, bull: false });
        } else {
            components.push({ label: 'ATM Flow', value: `CE/PE=${ratio.toFixed(2)} — Balanced`, pts: 0, bull: null });
        }
    } else {
        components.push({ label: 'ATM Flow', value: 'Awaiting premium data', pts: 0, bull: null });
    }

    // ── Derive final bias ─────────────────────────────────────────────────────
    let bias, label;
    if      (score >= 4) { bias = 'STRONGLY_BULLISH'; label = '📈 Strongly Bullish — Institutions buying'; }
    else if (score >= 2) { bias = 'BULLISH';           label = '📈 Bullish — Smart money positioned long'; }
    else if (score <= -4){ bias = 'STRONGLY_BEARISH';  label = '📉 Strongly Bearish — Institutions selling'; }
    else if (score <= -2){ bias = 'BEARISH';           label = '📉 Bearish — Smart money positioned short'; }
    else                 { bias = 'NEUTRAL';            label = '⚖️ Neutral — No clear institutional bias'; }

    return { bias, score, label, components, updatedAt: new Date().toISOString() };
}


// ── Candle Pattern Detector ────────────────────────────────────────────────────
// Generic candle pattern detector — accepts any candle array (for multi-TF use)
// Returns same shape as detectCandlePattern().
function detectCandlePatternForTF(candles) {
    if (!candles || candles.length < 2) return { pattern: 'NONE', direction: 'NEUTRAL', strength: 0, reason: '' };

    const c  = candles[candles.length - 1];
    const p  = candles[candles.length - 2];

    if (!c?.open || !c?.high || !c?.low || !c?.close) return { pattern: 'NONE', direction: 'NEUTRAL', strength: 0, reason: '' };

    const body        = Math.abs(c.close - c.open);
    const range       = c.high - c.low;
    const upperWick   = c.high - Math.max(c.open, c.close);
    const lowerWick   = Math.min(c.open, c.close) - c.low;
    const isBullCandle = c.close > c.open;
    const isBearCandle = c.close < c.open;
    const bodyRatio   = range > 0 ? body / range : 0;

    if (bodyRatio < 0.10 && range > 0)
        return { pattern: 'DOJI', direction: 'NEUTRAL', strength: 1, reason: `➕ Doji — indecision` };

    if (lowerWick >= 2 * body && upperWick <= 0.3 * body && lowerWick > 0) {
        const str = lowerWick >= 3 * body ? 3 : 2;
        return { pattern: 'HAMMER', direction: 'BULLISH', strength: str, reason: `🔨 Hammer` };
    }
    if (upperWick >= 2 * body && lowerWick <= 0.3 * body && upperWick > 0 && isBearCandle) {
        const str = upperWick >= 3 * body ? 3 : 2;
        return { pattern: 'SHOOTING_STAR', direction: 'BEARISH', strength: str, reason: `⭐ Shooting Star` };
    }
    if (upperWick >= 2 * body && lowerWick <= 0.3 * body && isBullCandle)
        return { pattern: 'INVERTED_HAMMER', direction: 'BULLISH', strength: 1, reason: `🕯️ Inv. Hammer` };

    const pBody = Math.abs(p.close - p.open);
    const pBear = p.close < p.open;
    const pBull = p.close > p.open;

    if (isBullCandle && pBear && body > 0 && pBody > 0 && c.open <= p.close && c.close >= p.open) {
        const str = body >= 1.5 * pBody ? 3 : 2;
        return { pattern: 'BULLISH_ENGULFING', direction: 'BULLISH', strength: str, reason: `🟢 Bull Engulfing` };
    }
    if (isBearCandle && pBull && body > 0 && pBody > 0 && c.open >= p.close && c.close <= p.open) {
        const str = body >= 1.5 * pBody ? 3 : 2;
        return { pattern: 'BEARISH_ENGULFING', direction: 'BEARISH', strength: str, reason: `🔴 Bear Engulfing` };
    }
    if (isBullCandle && bodyRatio >= 0.75)
        return { pattern: 'STRONG_BULL', direction: 'BULLISH', strength: 2, reason: `📈 Strong Bull` };
    if (isBearCandle && bodyRatio >= 0.75)
        return { pattern: 'STRONG_BEAR', direction: 'BEARISH', strength: 2, reason: `📉 Strong Bear` };

    return { pattern: 'NONE', direction: 'NEUTRAL', strength: 0, reason: '' };
}

// Detects: Hammer, Inverted Hammer, Shooting Star, Doji, Bullish/Bearish Engulfing
// Uses last 2 candles from session history.
// Returns: { pattern, direction, strength, reason }
// direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
// strength: 1 (weak) | 2 (moderate) | 3 (strong)
function detectCandlePattern() {
    const candles = getSessionCandles();
    if (candles.length < 2) return { pattern: 'NONE', direction: 'NEUTRAL', strength: 0, reason: '' };

    const c  = candles[candles.length - 1];  // latest closed candle
    const p  = candles[candles.length - 2];  // previous candle

    if (!c?.open || !c?.high || !c?.low || !c?.close) return { pattern: 'NONE', direction: 'NEUTRAL', strength: 0, reason: '' };

    const body        = Math.abs(c.close - c.open);
    const range       = c.high - c.low;
    const upperWick   = c.high - Math.max(c.open, c.close);
    const lowerWick   = Math.min(c.open, c.close) - c.low;
    const isBullCandle = c.close > c.open;
    const isBearCandle = c.close < c.open;
    const bodyRatio   = range > 0 ? body / range : 0;

    // ── Doji — indecision ────────────────────────────────────────────────────
    // Body < 10% of range = market indecision
    if (bodyRatio < 0.10 && range > 0) {
        return { pattern: 'DOJI', direction: 'NEUTRAL', strength: 1,
                 reason: `🕯️ Doji — indecision (body=${body.toFixed(1)} range=${range.toFixed(1)})` };
    }

    // ── Hammer — bullish reversal ─────────────────────────────────────────────
    // Lower wick >= 2× body, small upper wick, body in upper 1/3 of range
    if (lowerWick >= 2 * body && upperWick <= 0.3 * body && lowerWick > 0) {
        const str = lowerWick >= 3 * body ? 3 : 2;
        return { pattern: 'HAMMER', direction: 'BULLISH', strength: str,
                 reason: `🔨 Hammer — bullish reversal (lower wick=${lowerWick.toFixed(1)}, body=${body.toFixed(1)})` };
    }

    // ── Shooting Star — bearish reversal ──────────────────────────────────────
    // Upper wick >= 2× body, small lower wick, body in lower 1/3 of range
    if (upperWick >= 2 * body && lowerWick <= 0.3 * body && upperWick > 0) {
        const str = upperWick >= 3 * body ? 3 : 2;
        return { pattern: 'SHOOTING_STAR', direction: 'BEARISH', strength: str,
                 reason: `⭐ Shooting Star — bearish reversal (upper wick=${upperWick.toFixed(1)}, body=${body.toFixed(1)})` };
    }

    // ── Inverted Hammer — potential bullish reversal ──────────────────────────
    // Upper wick >= 2× body at bottom of downtrend
    if (upperWick >= 2 * body && lowerWick <= 0.3 * body && isBullCandle) {
        return { pattern: 'INVERTED_HAMMER', direction: 'BULLISH', strength: 1,
                 reason: `🕯️ Inverted Hammer — potential bullish reversal` };
    }

    // ── Bullish Engulfing ─────────────────────────────────────────────────────
    // Current bullish candle fully covers previous bearish candle body
    const pBody = Math.abs(p.close - p.open);
    const pBear = p.close < p.open;
    if (isBullCandle && pBear && body > 0 && pBody > 0) {
        if (c.open <= p.close && c.close >= p.open) {
            const str = body >= 1.5 * pBody ? 3 : 2;
            return { pattern: 'BULLISH_ENGULFING', direction: 'BULLISH', strength: str,
                     reason: `🟢 Bullish Engulfing — strong reversal (body=${body.toFixed(1)} > prev=${pBody.toFixed(1)})` };
        }
    }

    // ── Bearish Engulfing ─────────────────────────────────────────────────────
    // Current bearish candle fully covers previous bullish candle body
    const pBull = p.close > p.open;
    if (isBearCandle && pBull && body > 0 && pBody > 0) {
        if (c.open >= p.close && c.close <= p.open) {
            const str = body >= 1.5 * pBody ? 3 : 2;
            return { pattern: 'BEARISH_ENGULFING', direction: 'BEARISH', strength: str,
                     reason: `🔴 Bearish Engulfing — strong reversal (body=${body.toFixed(1)} > prev=${pBody.toFixed(1)})` };
        }
    }

    // ── Strong Bullish candle (Marubozu-like) ─────────────────────────────────
    if (isBullCandle && bodyRatio >= 0.75) {
        return { pattern: 'STRONG_BULL', direction: 'BULLISH', strength: 2,
                 reason: `📈 Strong Bull candle — momentum (body ${Math.round(bodyRatio*100)}% of range)` };
    }

    // ── Strong Bearish candle ──────────────────────────────────────────────────
    if (isBearCandle && bodyRatio >= 0.75) {
        return { pattern: 'STRONG_BEAR', direction: 'BEARISH', strength: 2,
                 reason: `📉 Strong Bear candle — momentum (body ${Math.round(bodyRatio*100)}% of range)` };
    }

    return { pattern: 'NONE', direction: 'NEUTRAL', strength: 0, reason: '' };
}

// ── Liquidity Sweep Reversal detector ─────────────────────────────────────────
// Catches the "stop-hunt then V-snap" pattern: price sweeps below (or above) a
// recent rolling range, then the very next candle reclaims it strongly on volume.
// This is the pattern behind big late-session reversals (institutions/algos hunt
// resting stops just past a known level, then short-covering/aggressive buying
// snaps price back through the whole range in 1 candle).
//
// `candles` = same 5m array from MTF. Last bar can be the still-FORMING current
// 5m candle (resample() includes it). That's intentional — fires 1-4 min into
// the reversal rather than waiting for full-close. Trade-off: partial candle can
// still reverse, so always use a tight initial SL on any entry off this.
//
// Strength tier:
//   3 = volume spike + full reclaim (close > sweep bar open) → highest conviction
//   2 = volume spike OR full reclaim (one of the two present)
//   1 = level reclaimed, no vol confirm, still forming → lowest conviction / heads-up only
// Gate in combineSignals only bypasses Theta Zone for strength >= 2.
function detectLiquiditySweepReversal(candles) {
    const NONE = { detected: false, direction: null, strength: 0, reason: '' };
    if (!Array.isArray(candles) || candles.length < 7) return NONE;

    const sweep    = candles[candles.length - 2];   // candle that broke the range
    const reversal = candles[candles.length - 1];   // candle reclaiming (may be forming)
    const lookback = candles.slice(candles.length - 7, candles.length - 2); // 5 bars prior

    // ── Bug guard: malformed candle fields ───────────────────────────────────
    // resample() (multiTimeframe.js) sets `open: c.close` (prev bar's close),
    // not the actual opening price. For fullReclaim and strongBody to be
    // meaningful, open must be a valid non-zero price, and close must differ
    // from open (a doji has body 0 — never a strong reversal signal anyway).
    // Guard against 0/undefined/null to avoid spurious strength boosts.
    if (!sweep.low || !sweep.high || !sweep.open || !sweep.close) return NONE;
    if (!reversal.close || !reversal.open || reversal.open === 0) return NONE;
    if (!lookback.every(c => c.low > 0 && c.high > 0)) return NONE;

    const refLow  = Math.min(...lookback.map(c => c.low));
    const refHigh = Math.max(...lookback.map(c => c.high));

    const avgVol = lookback.reduce((s, c) => s + (c.volume || 0), 0) / lookback.length;
    // Skip volume gate when data is clearly from Yahoo tick-polling (avgVol ≤ 2 means
    // the "volume" is just a tick counter, not real exchange volume).
    const volOK  = avgVol > 2 ? (reversal.volume || 0) >= avgVol * 1.5 : true;

    const revBody    = Math.abs(reversal.close - reversal.open);
    const revRange   = reversal.high - reversal.low;
    // strongBody: body covers ≥50% of the candle's total range.
    // Guards against doji/spinning-top candles firing as "strong reversal".
    // revRange must be > 0 (it always will be on any real move, but guard anyway).
    const strongBody = revRange > 10 ? (revBody / revRange) >= 0.5 : false;  // also require > 10pt range (not a tiny candle)

    // ── Bullish: support swept, level reclaimed, decisive bull candle ─────────
    if (sweep.low < refLow && reversal.close > refLow && reversal.close > reversal.open && strongBody) {
        const fullReclaim = reversal.close > sweep.open;  // closed back above the whole sweep bar
        const strength    = 1 + (volOK ? 1 : 0) + (fullReclaim ? 1 : 0); // 1..3
        const pts         = Math.round(reversal.close - refLow);
        return {
            detected: true, direction: 'BULLISH', strength,
            reason: `🎯 Liquidity Sweep — swept below ${refLow.toFixed(0)}, reclaimed ${reversal.close.toFixed(0)} (+${pts}pt)`
                  + (volOK ? ' + vol spike' : '') + (fullReclaim ? ' + full reclaim' : ' (partial — still forming)'),
            sweepLevel: refLow, volConfirmed: volOK, fullReclaim
        };
    }

    // ── Bearish: resistance swept, failed back below it, decisive bear candle ─
    if (sweep.high > refHigh && reversal.close < refHigh && reversal.close < reversal.open && strongBody) {
        const fullReclaim = reversal.close < sweep.open;
        const strength    = 1 + (volOK ? 1 : 0) + (fullReclaim ? 1 : 0);
        const pts         = Math.round(refHigh - reversal.close);
        return {
            detected: true, direction: 'BEARISH', strength,
            reason: `🎯 Liquidity Sweep — spiked above ${refHigh.toFixed(0)}, failed back ${reversal.close.toFixed(0)} (-${pts}pt)`
                  + (volOK ? ' + vol spike' : '') + (fullReclaim ? ' + full reclaim' : ' (partial — still forming)'),
            sweepLevel: refHigh, volConfirmed: volOK, fullReclaim
        };
    }

    return NONE;
}

// ── Signal Generator ──────────────────────────────────
// ── Opening Range Breakout (ORB) ────────────────────────────────────────────
// First 15 minutes of the session (9:15–9:30 IST) often sets the tone for the
// rest of the day. Once locked, price breaking cleanly above/below it is a
// useful directional filter — reduces false entries while price is still
// inside the morning's initial balance.
function updateORB() {
    const todayStr = getIST().toISOString().slice(0, 10);
    if (orbDate !== todayStr) { orbHigh = null; orbLow = null; orbDate = todayStr; }
    if (orbHigh !== null) return; // already locked for today

    const candles = getSessionCandles(); // 9:15 IST onward, 1 candle per minute
    if (candles.length >= 15) {
        const first15 = candles.slice(0, 15);
        orbHigh = Math.max(...first15.map(c => c.high));
        orbLow  = Math.min(...first15.map(c => c.low));
    }
}

function getORBStatus(price) {
    if (orbHigh === null || orbLow === null) {
        return { status: 'FORMING', label: '⏳ Opening range forming (need 15 min)', high: null, low: null };
    }
    if (price > orbHigh) return { status: 'BROKEN_UP',   label: `🔼 ORB Broken Up (>${orbHigh.toFixed(0)})`,   high: orbHigh, low: orbLow };
    if (price < orbLow)  return { status: 'BROKEN_DOWN', label: `🔽 ORB Broken Down (<${orbLow.toFixed(0)})`, high: orbHigh, low: orbLow };
    return { status: 'INSIDE', label: `↔️ Inside Opening Range (${orbLow.toFixed(0)}–${orbHigh.toFixed(0)})`, high: orbHigh, low: orbLow };
}

// ── Trend Day vs Range Day Detector ─────────────────────────────────────────
// Per external feedback: "This is one of the biggest improvements you can
// make" — knowing BEFORE taking trades whether today favors trend-following
// (option buying) or mean-reversion (iron-fly / selling / quick scalps) saves
// traders from fighting the day's actual character.
// Combines ADX (trend strength), MTF alignment, ORB breakout status, and
// momentum-breakout strength into a single 0-100 trend-probability score.
// Informational only — does NOT gate/block combineSignals(), it's a
// strategy-selection aid shown to the trader each morning.
function computeDayType() {
    const adxVal = marketState.adx?.adx ?? null;
    let trendScore = 0;
    if (adxVal !== null) trendScore += Math.min((adxVal / 40) * 40, 40);   // up to 40 pts
    if (marketState.mtf?.aligned)          trendScore += 30;               // all 3 TF agree
    else if (marketState.mtf?.softAligned) trendScore += 15;               // 15m+1h agree, 5m dissents
    const orbStatus = marketState.orb?.status;
    if (orbStatus === 'BROKEN_UP' || orbStatus === 'BROKEN_DOWN') trendScore += 20;
    const mom = marketState.momentum;
    if (mom?.canTrade && mom.strength >= 3) trendScore += 10;

    const trendProbability = Math.round(Math.min(trendScore, 100));
    const rangeProbability = Math.round(100 - trendProbability);

    const recommendation = trendProbability >= 60
        ? { favor: 'OPTION_BUYING',    avoid: 'Selling / Iron Fly',                 label: '✅ Recommended: Option Buying' }
        : rangeProbability >= 60
        ? { favor: 'RANGE_STRATEGIES', avoid: 'Fresh directional option buying',    label: '✅ Recommended: Iron Fly / Option Selling / Quick Scalps' }
        : { favor: 'NEUTRAL',          avoid: 'Oversized directional bets either way', label: '⚠️ Mixed signals — trade small, confirm before entry' };

    return {
        trendProbability, rangeProbability, recommendation,
        adx: adxVal, mtfAligned: !!marketState.mtf?.aligned, orbStatus: orbStatus ?? 'FORMING',
        generatedAt: new Date().toISOString(),
    };
}

// ── Trap Zone Detector — VWAP/POC chop pocket ───────────────────────────────
// When VWAP and POC sit close together AND price is squeezed inside that
// narrow band, the market tends to whipsaw rather than trend — fresh entries
// there get stopped out on noise. Flag it so the trader waits for a clean
// break of the band. Informational only — does not block combineSignals().
// ── Confidence Breakdown ─────────────────────────────────────────────────────
// Per feedback: "Instead of just Confidence: 81%, explain it" — shows the
// handful of factors doing the heavy lifting for the CURRENT active signal,
// in plain +/- points, ending at the real confidence number. This is a
// simplified, illustrative view of the top contributors — not a literal
// re-derivation of the full internal vote tally in combineSignals() (that
// engine has 25+ correlated inputs; a card listing all of them would be
// unreadable). Computed AFTER combineSignals() so marketState.signal /
// confidence are already final.
function computeConfidenceBreakdown() {
    const sig = marketState.signal;
    if (sig === 'WAIT' || !sig) return { items: [], final: 0, label: 'No active signal' };
    const isBull = sig === 'BUY CALL';
    const items = [];

    // Trend — MTF alignment
    if (marketState.mtf?.aligned) items.push({ label: 'Trend (3/3 TF aligned)', pts: 25 });
    else if ((isBull && marketState.mtf?.bullCount === 2) || (!isBull && marketState.mtf?.bearCount === 2)) {
        items.push({ label: 'Trend (2/3 TF aligned)', pts: 12 });
    }

    // Momentum — breakdown/breakout detector
    const mom = marketState.momentum;
    if (mom?.canTrade && ((isBull && mom.signal === 'BREAKOUT') || (!isBull && mom.signal === 'BREAKDOWN'))) {
        items.push({ label: `Momentum (${mom.signal.toLowerCase()}, strength ${mom.strength})`, pts: Math.round((mom.strength / 4) * 20) });
    }

    // Delta — order flow
    const deltaPct = marketState.delta?.deltaPct;
    if (deltaPct != null && ((isBull && deltaPct > 0) || (!isBull && deltaPct < 0))) {
        items.push({ label: `Delta (${deltaPct > 0 ? '+' : ''}${deltaPct}%)`, pts: Math.min(Math.round((Math.abs(deltaPct) / 100) * 15), 15) });
    }

    // PCR
    if ((isBull && marketState.pcrSignal === 'BULLISH') || (!isBull && marketState.pcrSignal === 'BEARISH')) {
        items.push({ label: `PCR (${marketState.pcr})`, pts: 10 });
    }

    // Proximity to Support/Resistance — penalty when signal direction is chasing INTO a wall
    const srLvls = marketState.srLevels?.levels;
    if (srLvls?.length && marketState.nifty > 0) {
        const near = srLvls.find(l => Math.abs(marketState.nifty - l.price) <= 30);
        if (near) {
            const isRes = near.price > marketState.nifty;
            if ((isBull && isRes) || (!isBull && !isRes)) {
                items.push({ label: `Near ${isRes ? 'Resistance' : 'Support'} (${near.label || near.type} @ ${near.price})`, pts: -10 });
            }
        }
    }

    // RSI extreme — penalty for chasing an already-stretched move
    const rsi = marketState.rsi;
    if (isBull && rsi != null && rsi > 68) items.push({ label: `RSI Overbought (${rsi})`, pts: -5 });
    if (!isBull && rsi != null && rsi < 32) items.push({ label: `RSI Oversold (${rsi})`, pts: -5 });

    return { items, final: marketState.confidence, generatedAt: new Date().toISOString() };
}

function computeTrapZone() {
    const price = marketState.nifty;
    const vwap  = marketState.vwap;
    const poc   = marketState.poc?.poc;
    if (!price || !vwap || !poc) {
        return { active: false, label: 'Trap Zone — awaiting data' };
    }
    const bandHi    = Math.max(vwap, poc);
    const bandLo    = Math.min(vwap, poc);
    const bandWidth = bandHi - bandLo;
    const TIGHT_BAND = 40;   // pts — VWAP/POC within this = a real chop pocket
    const BUFFER     = 10;   // pts — price also has to be inside/near the band
    const inBand = price >= (bandLo - BUFFER) && price <= (bandHi + BUFFER);
    const active = bandWidth <= TIGHT_BAND && inBand;

    return {
        active, vwap, poc, bandLo: Math.round(bandLo), bandHi: Math.round(bandHi), bandWidth: Math.round(bandWidth),
        label: active
            ? `⚠️ Trap Zone — between VWAP (${vwap.toFixed(0)}) and POC (${poc.toFixed(0)}) — expect whipsaws, wait for breakout`
            : `Clear — VWAP (${vwap.toFixed(0)}) / POC (${poc.toFixed(0)}) not forming a chop pocket`,
    };
}

// ── Contradiction Score ──────────────────────────────────────────────────────
// Per feedback: "Introduce a Contradiction Score" — instead of the many
// correlated votes inside combineSignals() all blending into one tally,
// this looks at 6 INDEPENDENT structural factors with fixed weights
// (MTF 40% / PCR 15% / Delta 15% / VWAP 10% / POC 10% / ORB 10% = 100%) and
// checks whether the bullish and bearish camps are BOTH substantial — i.e.
// genuinely contradicting each other — rather than one clearly dominating.
// When that happens, forcing a BUY CALL/BUY PUT out of the raw vote tally
// is exactly the failure mode flagged externally: "Bullish internals overpower
// bearish momentum" style false calls. Result: NO TRADE instead of a forced pick.
function computeContradictionScore() {
    const bullFactors = [], bearFactors = [];
    let bullWeight = 0, bearWeight = 0;

    // MTF — 40% (full weight if all 3 TF aligned, half if 2/3)
    const mtf = marketState.mtf;
    if (mtf?.aligned) {
        if (mtf.signal === 'BUY CALL') { bullWeight += 40; bullFactors.push('MTF (3/3 aligned)'); }
        else if (mtf.signal === 'BUY PUT') { bearWeight += 40; bearFactors.push('MTF (3/3 aligned)'); }
    } else if (mtf?.bullCount === 2) { bullWeight += 20; bullFactors.push('MTF (2/3 bullish)'); }
    else if (mtf?.bearCount === 2) { bearWeight += 20; bearFactors.push('MTF (2/3 bearish)'); }

    // PCR — 15%
    if (marketState.pcrSignal === 'BULLISH') { bullWeight += 15; bullFactors.push('PCR'); }
    else if (marketState.pcrSignal === 'BEARISH') { bearWeight += 15; bearFactors.push('PCR'); }

    // Delta — 15%
    if (marketState.delta?.signal === 'BULLISH') { bullWeight += 15; bullFactors.push('Delta'); }
    else if (marketState.delta?.signal === 'BEARISH') { bearWeight += 15; bearFactors.push('Delta'); }

    // VWAP — 10%
    if (marketState.nifty && marketState.vwap) {
        if (marketState.nifty > marketState.vwap) { bullWeight += 10; bullFactors.push('Above VWAP'); }
        else if (marketState.nifty < marketState.vwap) { bearWeight += 10; bearFactors.push('Below VWAP'); }
    }

    // POC — 10%
    if (marketState.poc?.signal === 'ABOVE_POC') { bullWeight += 10; bullFactors.push('Above POC'); }
    else if (marketState.poc?.signal === 'BELOW_POC') { bearWeight += 10; bearFactors.push('Below POC'); }

    // ORB — 10%
    if (marketState.orb?.status === 'BROKEN_UP') { bullWeight += 10; bullFactors.push('ORB Broken Up'); }
    else if (marketState.orb?.status === 'BROKEN_DOWN') { bearWeight += 10; bearFactors.push('ORB Broken Down'); }

    // Contradiction = BOTH sides carry substantial, conflicting weight —
    // not just one side dominating with the other side quiet/neutral.
    const contradiction = bullWeight >= 30 && bearWeight >= 30;
    const diff   = bullWeight - bearWeight;
    const result = contradiction ? 'NO_TRADE' : diff > 0 ? 'BULLISH' : diff < 0 ? 'BEARISH' : 'NEUTRAL';

    return {
        bullWeight, bearWeight, diff, bullFactors, bearFactors, contradiction, result,
        generatedAt: new Date().toISOString(),
    };
}

// ── Strict Sequential Agreement Gate ────────────────────────────────────────
// This is the EXACT check requested:
//   MTF → PCR → Delta → ORB → VWAP → Value Area (VAH/VAL)
//   If ALL agree with the raw direction → let it through
//   Else → NO TRADE
// Different from computeContradictionScore() above (which only blocks when
// BOTH sides carry substantial weight). This one walks the chain in order and
// stops at the FIRST factor that actively opposes the direction — a factor
// reading NEUTRAL/unavailable does not fail the check, only an outright
// opposite reading does.
function checkAgreementSequence(direction) {
    if (direction !== 'BUY CALL' && direction !== 'BUY PUT') {
        return { passed: true, failedAt: null, steps: [] };
    }
    const isBull  = direction === 'BUY CALL';
    const oppose  = isBull ? 'BEAR' : 'BULL';
    const steps   = [];

    // 1. MTF
    const mtf = marketState.mtf;
    const mtfDir = mtf?.aligned ? (mtf.signal === 'BUY CALL' ? 'BULL' : 'BEAR')
                 : mtf?.bullCount === 2 ? 'BULL' : mtf?.bearCount === 2 ? 'BEAR' : 'NEUTRAL';
    steps.push({ step: 'MTF', dir: mtfDir });

    // 2. PCR
    const pcrDir = marketState.pcrSignal === 'BULLISH' ? 'BULL' : marketState.pcrSignal === 'BEARISH' ? 'BEAR' : 'NEUTRAL';
    steps.push({ step: 'PCR', dir: pcrDir });

    // 3. Delta
    const deltaDir = marketState.delta?.signal === 'BULLISH' ? 'BULL' : marketState.delta?.signal === 'BEARISH' ? 'BEAR' : 'NEUTRAL';
    steps.push({ step: 'Delta', dir: deltaDir });

    // 4. ORB
    const orbDir = marketState.orb?.status === 'BROKEN_UP' ? 'BULL' : marketState.orb?.status === 'BROKEN_DOWN' ? 'BEAR' : 'NEUTRAL';
    steps.push({ step: 'ORB', dir: orbDir });

    // 5. VWAP
    const vwapDir = (marketState.nifty && marketState.vwap)
        ? (marketState.nifty > marketState.vwap ? 'BULL' : marketState.nifty < marketState.vwap ? 'BEAR' : 'NEUTRAL')
        : 'NEUTRAL';
    steps.push({ step: 'VWAP', dir: vwapDir });

    // 6. Value Area (VAH/VAL from the POC/volume-profile calc)
    const poc = marketState.poc;
    let vaDir = 'NEUTRAL';
    if (poc?.vah != null && poc?.val != null && marketState.nifty) {
        if (marketState.nifty > poc.vah) vaDir = 'BULL';
        else if (marketState.nifty < poc.val) vaDir = 'BEAR';
    }
    steps.push({ step: 'Value Area', dir: vaDir });

    // Walk the chain in order — first outright opposing factor kills it
    for (const s of steps) {
        if (s.dir === oppose) {
            return { passed: false, failedAt: s.step, steps };
        }
    }
    return { passed: true, failedAt: null, steps };
}

// ── Trend Conviction Mode ────────────────────────────────────────────────────
// Per external audit feedback (authenticity-checked — see notes below):
//   "Delta alone shouldn't reverse the trend" — a single strong-but-transient
//   delta spike could flip the raw vote tally against an otherwise clearly
//   one-directional structural picture (VWAP, Value Area, ORB, 15m/1H trend).
//   "Confidence should increase as multiple bearish/bullish conditions keep
//   strengthening" — instead of plateauing once the basic vote threshold
//   is crossed.
// This counts INDEPENDENT structural conditions (not correlated sub-votes of
// the same underlying number) in each direction. When enough stack up in one
// direction, that's "conviction" — strong enough that a raw signal pointing
// the OPPOSITE way should be treated with suspicion unless MTF itself has
// genuinely flipped (a real reversal), not just one factor (e.g. delta).
function computeTrendConviction() {
    const nifty = marketState.nifty;
    const vwap  = marketState.vwap;
    const val   = marketState.poc?.val;
    const vah   = marketState.poc?.vah;
    const delta = marketState.delta?.deltaPct;
    const orbStatus = marketState.orb?.status;
    const tf15m = marketState.mtf?.tf15m?.signal;
    const tf1h  = marketState.mtf?.tf1h?.signal;

    const bear = [], bull = [];

    if (nifty && vwap) {
        if (nifty < vwap) bear.push('Price below VWAP');
        else if (nifty > vwap) bull.push('Price above VWAP');
    }
    if (tf15m === 'BEARISH') bear.push('15m Bearish');
    if (tf15m === 'BULLISH') bull.push('15m Bullish');
    if (tf1h === 'BEARISH') bear.push('1H Bearish');
    if (tf1h === 'BULLISH') bull.push('1H Bullish');
    if (delta != null && delta <= -40) bear.push(`Delta ${delta}%`);
    if (delta != null && delta >=  40) bull.push(`Delta +${delta}%`);
    if (val != null && nifty && nifty < val) bear.push('Price below VAL');
    if (vah != null && nifty && nifty > vah) bull.push('Price above VAH');
    if (orbStatus === 'BROKEN_DOWN') bear.push('ORB Breakdown');
    if (orbStatus === 'BROKEN_UP')   bull.push('ORB Breakout');

    const CONVICTION_THRESHOLD = 4;   // of 6 possible independent conditions
    const active = bear.length >= CONVICTION_THRESHOLD ? 'BEARISH'
                 : bull.length >= CONVICTION_THRESHOLD ? 'BULLISH'
                 : null;

    return {
        active, bearConditions: bear, bullConditions: bull,
        bearCount: bear.length, bullCount: bull.length,
        generatedAt: new Date().toISOString(),
    };
}

function combineSignals(indicators) {
    // ── Gate 1: safe time window (IST) ────────────────
    const ew = isSafeEntryWindow();
    marketState.entryWindow = ew;
    if (!ew.safe) {
        // Theta Zone (14:30-15:30) normally blocks ALL new entries — correct
        // default, since fresh option buys late in the day bleed to theta fast.
        // But a CONFIRMED liquidity-sweep reversal (stop-hunt + strong snapback
        // on volume) is exactly the kind of fast, defined-risk, high-conviction
        // move that this gate would otherwise suppress entirely — and it's
        // usually driven by short-covering/institutional flow, not weak retail
        // momentum that theta eats alive. Carve a narrow, explicitly-labeled
        // exception for ONLY this one pattern; every other late-session signal
        // (normal PCR/RSI/EMA votes) stays blocked exactly as before.
        // Build fresh 5m candles from live 1m session candles at call-time,
        // NOT from marketState.candles5mRecent (that's up to 2 min stale from
        // the refreshMTF cycle). Using fresh data means the sweep fires within
        // the same tick the reversal bar becomes detectable — not 0-120 sec late.
        // Take last 35 1m bars (=7 5m bars, enough for lookback + sweep + reversal).
        const live1m   = getSessionCandles().slice(-35);
        const live5m   = (() => {
            const out = []; let bucket = null; let count = 0;
            for (const c of live1m) {
                if (!bucket) {
                    bucket = { open: c.open || c.close, high: c.high, low: c.low, close: c.close, volume: c.volume || 1 };
                } else {
                    bucket.high   = Math.max(bucket.high, c.high);
                    bucket.low    = Math.min(bucket.low,  c.low);
                    bucket.close  = c.close;
                    bucket.volume = (bucket.volume || 1) + (c.volume || 1);
                }
                if (++count >= 5) { out.push({ ...bucket }); bucket = null; count = 0; }
            }
            if (bucket) out.push({ ...bucket }); // include forming bar
            return out;
        })();
        const sweep = (ew.status === 'theta')
            ? detectLiquiditySweepReversal(live5m)
            : { detected: false };
        marketState.sweepReversal = sweep;

        if (!sweep.detected || sweep.strength < 2) {
            marketState.qualityGate = { mtfAligned:false, rsiClean:true, safeWindow:false, vixSafe:true, adxTrend:true, srClear:true, passed:false };
            return {
                signal     : 'WAIT',
                confidence : 0,
                reasons    : [`⏰ ${ew.reason}`, ...(indicators.reasons||[]).slice(0,2)]
            };
        }

        // Confidence mapped to sweep quality tier:
        //   strength 3 (vol spike + full reclaim) → 70% — clearest institutional confirmation
        //   strength 2 (one of vol/full reclaim)  → 55% — decent signal, smaller size
        // Both stay < 75 so they never rank as STRONG — correct for theta zone entries.
        let sweepConf = sweep.strength === 3 ? 70 : 55;
        const sweepReasons = [sweep.reason, `⏰ ${ew.label} — sweep-reversal exception (small size, tight SL, fast exit)`];

        // Bonus: if the reversal direction also points toward Max Pain, this is
        // often the magnet pulling price back — bump confidence and say so.
        if (marketState.maxPain?.strike && marketState.nifty > 0) {
            const towardMP = sweep.direction === 'BULLISH'
                ? marketState.maxPain.strike > marketState.nifty
                : marketState.maxPain.strike < marketState.nifty;
            if (towardMP) {
                sweepConf = Math.min(sweepConf + 10, 75);
                sweepReasons.push(`🧲 Aligned with Max Pain pull toward ${marketState.maxPain.strike}`);
            }
        }
        if (isExpiryDay()) {
            sweepReasons.push('⚡ Expiry day — extra gamma risk, keep size smaller + booking faster than usual');
        }

        marketState.qualityGate = { mtfAligned:false, rsiClean:true, safeWindow:true, vixSafe:true, adxTrend:true, srClear:true, passed:true };
        return {
            signal     : sweep.direction === 'BULLISH' ? 'BUY CALL' : 'BUY PUT',
            confidence : sweepConf,
            reasons    : sweepReasons
        };
    }

    // ── Bull / bear vote tally ────────────────────────
    let bull=0, bear=0;
    const reasons=[...(indicators.reasons||[])];

    // ── PCR — graduated score (-3 to +3) ─────────────────────────────────────
    // Replaces old binary BULLISH/BEARISH: threshold >1.5/<0.7 almost never fired.
    // Now every reading contributes proportionally, positive or negative.
    // FIX: When PCR is unavailable (all sources blocked/401/404), treat as NEUTRAL (1.0)
    // so the missing data doesn't silently kill confidence and block valid signals.
    // A null PCR means "we don't know" — not "bearish" — so 0 net votes is correct.
    // We still add +1 to both bull and bear (net 0) to keep the denominator honest
    // and show the PCR row in the UI as "unavailable" rather than simply absent.
    if (marketState.pcr !== null) {
        const ps = pcrScore(marketState.pcr);
        if      (ps >= 2)  { bull += ps;           reasons.push(`PCR ${marketState.pcr} — Strongly Bullish ✅`); }
        else if (ps === 1) { bull += 1;            reasons.push(`PCR ${marketState.pcr} — Mildly Bullish ✅`); }
        else if (ps <= -2) { bear += Math.abs(ps); reasons.push(`PCR ${marketState.pcr} — Strongly Bearish ⚠️`); }
        else if (ps === -1){ bear += 1;            reasons.push(`PCR ${marketState.pcr} — Mildly Bearish ⚠️`); }
        else               {                       reasons.push(`PCR ${marketState.pcr} — Neutral`); }
    } else {
        // PCR unavailable — treated as neutral, signal NOT blocked
        reasons.push(`PCR — ⚠️ Unavailable (API blocked/401) — treated as neutral, signal not affected`);
    }

    // ── ATM PCR — 1.5× weight (nearest strikes = real money intent) ──────────
    // ATM PCR tells you what writers are actually doing at the current price.
    // It's more accurate than broad PCR, so it gets heavier weighting.
    // FIX: Same neutral treatment when unavailable — don't silently drop points.
    if (marketState.atmPcr !== null) {
        const as = pcrScore(marketState.atmPcr);
        const w = Math.min(Math.max(Math.round(as * 1.5), -4), 4); // cap ±4
        if      (w > 0) { bull += w;  reasons.push(`ATM PCR ${marketState.atmPcr} — Bullish near-strike ✅ (+${w}pts)`); }
        else if (w < 0) { bear += -w; reasons.push(`ATM PCR ${marketState.atmPcr} — Bearish near-strike ⚠️ (+${-w}pts)`); }
        else            {             reasons.push(`ATM PCR ${marketState.atmPcr} — Neutral near-strike`); }
    } else {
        reasons.push(`ATM PCR — ⚠️ Unavailable — treated as neutral`);
    }
    if (marketState.vix) {
        if      (marketState.vixChange < -0.5) { bull++; reasons.push(`VIX falling (${marketState.vix}) ✅`); }
        else if (marketState.vixChange >  0.5) { bear++; reasons.push(`VIX rising (${marketState.vix}) ⚠️`); }
        if (marketState.vix > 20) reasons.push(`⚠️ VIX ${marketState.vix} ≥ 20 — ${marketState.vixNote}`);
    }
    // ── Global cues — but cap bull votes when BankNifty is strongly negative ──
    // Global bias (10/10 BULLISH) reflects overnight US/Asia data — it lags intraday.
    // On June 1-type days global was BULLISH while BN was -1.27% and Nifty grinding down.
    // If BankNifty is down > 0.8% today, treat global BULLISH as neutral (0 votes)
    // to prevent stale overnight optimism from diluting a real intraday bearish setup.
    const bnChangePct = marketState.global.sectors?.bankNifty?.changePct ?? 0;
    const globalLagging = bnChangePct < -0.8;  // BN down hard = global cue is stale
    if (marketState.global.bias==='BULLISH' && !globalLagging) { bull+=2; reasons.push('Global cues bullish ✅'); }
    else if (marketState.global.bias==='BULLISH' && globalLagging) { reasons.push(`Global BULLISH but BN ${bnChangePct.toFixed(2)}% — cue suppressed (intraday override)`); }
    else if (marketState.global.bias==='BEARISH') { bear+=2; reasons.push('Global cues bearish ⚠️'); }
    const bn = marketState.global.sectors?.bankNifty;
    // BUG FIX: The original code added bull/bear votes for BOTH bn.changePct (daily %)
    // AND bnLead (VWAP cross) — these are two signals derived from the same BankNifty data.
    // A bullish BN day was contributing 3 bull votes (2+1) from one correlated source,
    // skewing a 12-vote pool by 25%. Fixed: bn.changePct gets 1 vote (not 2), and
    // bnLead continues as-is (it's a fresh VWAP-cross event, not just a daily %).
    if (bn?.changePct > 0.5) bull+=1; else if (bn?.changePct < -0.5) bear+=1;

    // ── BankNifty VWAP leading indicator (+1 / -1) ────
    // BankNifty leads Nifty ~70% of the time intraday.
    // Only fires on a FRESH VWAP cross 5 min ago (signal !== 0).
    const bnLead = marketState.global?.bankNiftyLeadSignal;
    if (bnLead?.signal === 1)  { bull += 1; reasons.push(`🏦 ${bnLead.reason}`); }
    if (bnLead?.signal === -1) { bear += 1; reasons.push(`🏦 ${bnLead.reason}`); }

    // ── Nifty vs BankNifty correlation ─────────────────────────────────────
    // BN Leading = +1 vote confirming direction. Divergence = suppress 1 vote.
    const bnCorr = marketState.global?.bnCorrelation;
    if (bnCorr) {
        if (bnCorr.status === 'BN_LEADING') {
            // BN strongly leading: extra confirmation vote in direction of lead
            if (bnLead?.signal === 1)  { bull += 1; reasons.push(`🏦 BankNifty leading Nifty — strong bull confirmation ✅`); }
            if (bnLead?.signal === -1) { bear += 1; reasons.push(`🏦 BankNifty leading Nifty — strong bear confirmation ⚠️`); }
        } else if (bnCorr.status === 'DIVERGE') {
            // BN and Nifty going opposite — cancel 1 vote from whichever side built up
            if (bull > bear && bull > 0) { bull = Math.max(0, bull - 1); reasons.push(`⚡ BN/Nifty divergence — bull vote suppressed`); }
            else if (bear > bull && bear > 0) { bear = Math.max(0, bear - 1); reasons.push(`⚡ BN/Nifty divergence — bear vote suppressed`); }
        }
    }
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

    // ── ATM CE vs PE premium ratio — real-money directional bet ──────────────
    // If CE premium is rising faster than PE, option buyers are positioning CALL.
    // If PE premium is rising faster than CE, option buyers are positioning PUT.
    // This is a 1-point vote using live optionFlow data already on state.
    const optFlow = marketState.optionFlow;
    if (optFlow?.atmCEpremium && optFlow?.atmPEpremium && optFlow.atmCEpremium > 0 && optFlow.atmPEpremium > 0) {
        const premRatio = optFlow.atmCEpremium / optFlow.atmPEpremium;
        if (premRatio > 1.25) {
            bull += 1;
            reasons.push(`💰 CE premium ₹${optFlow.atmCEpremium} >> PE ₹${optFlow.atmPEpremium} — call buyers active ✅`);
        } else if (premRatio < 0.8) {
            bear += 1;
            reasons.push(`💰 PE premium ₹${optFlow.atmPEpremium} >> CE ₹${optFlow.atmCEpremium} — put buyers active ⚠️`);
        }
    }

    // ── Momentum Breakdown / Breakout detector ────────────────────────────────
    // Detects explosive candle moves (velocity + body + volume + acceleration).
    // Strength 2 = 1 vote, Strength 3 = 2 votes, Strength 4 = 3 votes.
    // Votes are directional — breakdown adds bear, breakout adds bull.
    // Only fires when canTrade=true (strength >= 2) to avoid noise.
    // This is what would have caught Friday's 14:30 collapse early.
    const mom = calcMomentumBreakdown();
    marketState.momentum = mom;
    if (mom.canTrade) {
        const momVotes = mom.strength - 1;   // str2=1, str3=2, str4=3
        if (mom.signal === 'BREAKDOWN') {
            bear += momVotes;
            reasons.push(`${mom.reason} (+${momVotes}pts ⚠️)`);
        } else if (mom.signal === 'BREAKOUT') {
            bull += momVotes;
            reasons.push(`${mom.reason} (+${momVotes}pts ✅)`);
        }
    }

    // ── Candle Pattern (5m TF — more reliable than 1m for signal voting) ───────
    // 1m candle patterns at open are too noisy (5 bars = 5 mins, any spike qualifies).
    // 5m candles are much more meaningful — each candle represents 5 real minutes.
    // Use cp5m from marketState.cpMTF (computed in refreshMTF every 2 min).
    // Fall back to 1m pattern only if 5m data isn't ready yet.
    const cp5mFromMTF = marketState.cpMTF?.cp5m;
    const cp = (cp5mFromMTF && cp5mFromMTF.pattern !== 'NONE')
        ? cp5mFromMTF
        : detectCandlePattern();  // 1m fallback only when 5m not ready
    marketState.candlePattern = cp;
    if (cp.strength >= 2 && cp.direction !== 'NEUTRAL') {
        const cpVotes = cp.strength - 1;  // str2=1 vote, str3=2 votes
        if (cp.direction === 'BULLISH') {
            bull += cpVotes;
            reasons.push(`${cp.reason} (+${cpVotes}pts ✅)`);
        } else if (cp.direction === 'BEARISH') {
            bear += cpVotes;
            reasons.push(`${cp.reason} (+${cpVotes}pts ⚠️)`);
        }
    } else if (cp.pattern !== 'NONE') {
        reasons.push(cp.reason);  // show even weak patterns as info
    }

    // ── Opening Range Breakout (ORB) — modest confirming vote ────────────────
    // Per external feedback: first 15-min range often sets the day's tone.
    // Weighted lightly (1 vote) since it's a confirming filter, not a leading
    // signal — a breakout WITH other votes agreeing is meaningful, a lone ORB
    // break with everything else neutral shouldn't force a trade by itself.
    try {
        updateORB();
        const orb = getORBStatus(marketState.nifty);
        marketState.orb = orb;
        if (orb.status === 'BROKEN_UP')        { bull += 1; reasons.push(`${orb.label} ✅`); }
        else if (orb.status === 'BROKEN_DOWN') { bear += 1; reasons.push(`${orb.label} ⚠️`); }
        else                                    reasons.push(orb.label);
    } catch (e) { console.warn('[ORB] error:', e.message); }

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

    // ── ADX — trend strength filter (VIX-dynamic floor) ─────────────────────
    // ADX floor is adjusted by VIX regime — low vol days (VIX < 14) have naturally
    // compressed ADX. Using a flat 20 threshold in low-vol kills every signal.
    //   VIX < 14  → floor = 13  (low vol regime, ADX 13+ is directional enough)
    //   VIX 14-18 → floor = 16  (normal regime)
    //   VIX >= 18 → floor = 20  (high vol / choppy, original strict threshold)
    // ADX >= floor+5 = confirmed trend — full signal strength.
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
    // candlePattern already set in scoring block above

    const adxVal      = adxData?.adx ?? null;

    // ── VIX-dynamic ADX floor ─────────────────────────────────────────────────
    const currentVix = marketState.vix ?? null;
    const adxFloor1m = currentVix !== null && currentVix < 14 ? 13
                     : currentVix !== null && currentVix < 18 ? 16
                     : 20;

    // ── ADX Breakout Override — catches trending days where 1h ADX lags ──────
    // Fix: If 15m ADX >= 22 AND 5m ADX >= 25, short-term trend is clearly strong
    // enough to trade even if 1h ADX hasn't caught up yet.
    const adx5m  = marketState.mtf?.tf5m?.adx  ?? null;
    const adx15m = marketState.mtf?.tf15m?.adx ?? null;
    const shortTfBreakout = (adx15m !== null && adx15m >= 22) && (adx5m !== null && adx5m >= 25);

    // adxTooWeak: block when ADX < dynamic floor UNLESS short-TF breakout fires
    const adxTooWeak  = adxVal !== null && adxVal < adxFloor1m && !shortTfBreakout;

    if (shortTfBreakout && adxVal !== null && adxVal < adxFloor1m) {
        reasons.push(`⚡ Breakout exception: 5m ADX ${adx5m?.toFixed(1)} + 15m ADX ${adx15m?.toFixed(1)} strong — ADX lag waived`);
    }

    if (adxVal !== null) {
        if      (adxVal >= 40)             reasons.push(`🔥 ADX ${adxVal} — Explosive trend (wider SL advised)`);
        else if (adxVal >= adxFloor1m + 5) reasons.push(`📈 ADX ${adxVal} — Strong trend confirmed ✅`);
        else if (adxVal >= adxFloor1m)     reasons.push(`⚠️ ADX ${adxVal} — Trend forming (weak, confidence capped 60%)`);
        // below floor handled in gate reason below
    }

    const qualityGate = {
        // 1. All three timeframes must agree (with ADX ≥ 20 per TF)
        //    softAligned = 15m+1h agree but 5m dissents — allowed through at capped confidence (≤55%)
        mtfAligned : marketState.mtf.aligned || marketState.mtf.softAligned,

        // 2. RSI multi-timeframe filter:
        //    CALL entry: 15m RSI > 55 AND 5m RSI > 55 (trend + entry alignment)
        //    PUT  entry: 15m RSI < 45 AND 5m RSI < 45
        //    Also: 1m RSI must not be stretched (< 70 for calls, > 30 for puts)
        //    If MTF RSI is null (data not yet loaded), fall back to 1m RSI check only.
        //    MORNING RELAXATION (before 10:30 AM): After a gap-open, 5m RSI takes
        //    45–60 min to recover above 55. Only require 15m RSI > 52 before 10:30.
        //    After 10:30, full strict gate (both 5m AND 15m) applies as before.
        rsiClean   : (() => {
            if (rawSignal === 'WAIT') return true;
            const rsi5m  = marketState.mtf?.tf5m?.rsi  ?? null;
            const rsi15m = marketState.mtf?.tf15m?.rsi ?? null;
            const istNow = getIST();
            const istMins = istNow.getHours() * 60 + istNow.getMinutes();
            const morning = istMins < 630; // before 10:30 AM
            if (rawSignal === 'BUY CALL') {
                const mtfOk = morning
                    ? (rsi15m === null || rsi15m > 52)  // morning: only 15m needs to be above 52
                    : (rsi15m === null || rsi15m > 55) && (rsi5m === null || rsi5m > 55); // full gate after 10:30
                const notOverbought = rsi === null || rsi < 70;
                return mtfOk && notOverbought;
            }
            if (rawSignal === 'BUY PUT') {
                const mtfOk = morning
                    ? (rsi15m === null || rsi15m < 48)  // morning: only 15m needs to be below 48
                    : (rsi15m === null || rsi15m < 45) && (rsi5m === null || rsi5m < 45); // full gate after 10:30
                const notOversold = rsi === null || rsi > 30;
                return mtfOk && notOversold;
            }
            return true;
        })(),

        // 3. Safe time window — already enforced at the top of this function.
        safeWindow : true,

        // 4. VIX below 20: elevated vol inflates premiums and widens spreads,
        //    making option-buying risk/reward unfavourable.
        vixSafe    : !marketState.vix || marketState.vix < 20,

        // 5. ADX >= 20: trend must exist before betting directional premium.
        //    When ADX data is unavailable (insufficient history), default to true
        //    so we don't silently block signals during early session.
        adxTrend   : !adxTooWeak,

        // 6. S/R proximity gate — only evaluated when a directional signal exists.
        //    null  = not evaluated (rawSignal was already WAIT, no entry to protect)
        //    true  = evaluated and clear.
        //    false = blocked (set inside the gate block below).
        srClear    : rawSignal !== 'WAIT' ? true : null,

        // 7. Physics Law 1 — swing structure gate (set inside the PoT scoring block).
        //    null  = UNKNOWN / early session (allow through).
        //    true  = trend aligns or neutral.
        //    false = confirmed counter-trend or SIDEWAYS = block.
        physicsLaw1 : null,

        // 8. Physics Law 3 — reaction zone gate (set inside the PoT scoring block).
        //    true  = price at reaction zone (near VWAP or 38–62% fib) or neutral.
        //    false = ON_ACTION (chasing a candle far from VWAP) = block.
        physicsLaw3 : true,
    };
    // qualityGate.passed is computed AFTER the S/R block so srClear=false cannot produce stale passed=true

    // Persist gate state so the UI can show which checks are passing / failing
    marketState.qualityGate = qualityGate;

    // FIX 2 (updated): Soft-compress confidence above 75% into a 75–85 band,
    // instead of hard-clipping everything above 85 down to a flat 85.
    // Why: the vote tally has many correlated inputs (PCR, ATM PCR, breadth,
    // global, MTF, FII, max pain, BankNifty lead…) so on a genuinely strong
    // day they mostly agree and rawConfidence can reach 95-100+. A flat
    // Math.min(rawConfidence, 85) made every strong setup display the exact
    // same "85%" — a 9-vote-to-1 day and a 6-vote-to-1 day looked identical.
    // 100% is still epistemically wrong (no intraday signal is certain), so
    // the ceiling stays at 85 — but now a 90% raw tally lands at 81%, a 100%
    // raw tally lands at 85%, preserving relative conviction instead of
    // flattening it. Below 75% raw, nothing changes (already granular there).
    if (rawConfidence > 75) {
        rawConfidence = Math.round(75 + (rawConfidence - 75) * 0.4);
    }
    rawConfidence = Math.min(rawConfidence, 85); // safety ceiling, should be a no-op now

    // Gate decision — check in priority order.
    // ADX is checked FIRST because a choppy market invalidates everything else.
    let signal = rawSignal, confidence = rawConfidence;
    if (rawSignal !== 'WAIT') {
        if (!qualityGate.adxTrend) {
            signal = 'WAIT'; confidence = 0;
            reasons.push(`⛔ ADX ${adxVal} < ${adxFloor1m} (VIX ${currentVix?.toFixed(1) ?? '?'}) — Choppy/sideways market. Wait for ADX ≥ ${adxFloor1m}`);
        } else if (!qualityGate.mtfAligned) {
            signal = 'WAIT'; confidence = 0;
            reasons.push(`⛔ MTF not aligned (${marketState.mtf.bullCount}/3 bull, ${marketState.mtf.bearCount}/3 bear) — wait for all-3 agreement`);
        } else if (!qualityGate.rsiClean) {
            signal = 'WAIT'; confidence = 0;
            const rsi5m  = marketState.mtf?.tf5m?.rsi  ?? null;
            const rsi15m = marketState.mtf?.tf15m?.rsi ?? null;
            if (rawSignal === 'BUY CALL') {
                reasons.push(`⛔ RSI not aligned for CALL — 15m:${rsi15m??'--'} 5m:${rsi5m??'--'} 1m:${rsi??'--'} (need 15m>55, 5m>55, 1m<70)`);
            } else {
                reasons.push(`⛔ RSI not aligned for PUT — 15m:${rsi15m??'--'} 5m:${rsi5m??'--'} 1m:${rsi??'--'} (need 15m<45, 5m<45, 1m>30)`);
            }
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
                // On expiry day: buffer is SMALLER (40pt) not larger, because Max Pain
                // is a gravity target — price moves TOWARD it, not stalls at it.
                // The 75pt buffer was blocking the entire session when Max Pain sat in
                // the day's trading range (e.g. June 1 — Max Pain = 23560, all-day range
                // 23500–23650 → never got a signal despite 86% bear vote).
                // On expiry day: also skip Max Pain levels from the proximity check —
                // the vote tally already handles them via the max pain gravity vote.
                const bufferPts = marketState.maxPain?.expiryDay ? 40 : 50;
                const nearbyLevel = srLvls.find(lvl => {
                    // On expiry day, exclude Max Pain from S/R gate — it's not a wall,
                    // it's a magnet. The max pain vote in combineSignals() handles this.
                    if (marketState.maxPain?.expiryDay && lvl.type === 'MP') return false;
                    return Math.abs(marketState.nifty - lvl.price) <= bufferPts;
                });
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

    // ── Price Action Level Analysis ──────────────────────────────────────────
    // After S/R gate: analyze WHAT the price is doing relative to levels.
    // This ADDS votes (unlike the gate above which BLOCKS).
    // Rules:
    // 1. Price bouncing from Support → BULLISH vote (+1 to +2)
    // 2. Price rejected from Resistance → BEARISH vote (+1 to +2)  
    // 3. Price breaking above Resistance → BULLISH confirmation (+2)
    // 4. Price breaking below Support → BEARISH confirmation (+2)
    // 5. Price in "no man's land" (far from any level) → neutral
    {
        const srLvls = marketState.srLevels?.levels;
        const price  = marketState.nifty;
        const prevPrice = marketState.prevNifty || price;  // previous tick price

        if (srLvls?.length > 0 && price > 0) {
            const BOUNCE_ZONE  = 25;   // within 25pts of level = in zone
            const BREAK_BUFFER = 15;   // 15pts past a level = confirmed break

            // Find nearest support and resistance
            const above = srLvls.filter(l => l.price > price);
            const below = srLvls.filter(l => l.price < price);
            const nearRes = above.length > 0 ? above[above.length - 1] : null;
            const nearSup = below.length > 0 ? below[0] : null;

            if (nearSup) {
                const distToSup = price - nearSup.price;
                const strBonus  = nearSup.strength >= 3 ? 2 : 1;  // PDH/PDL/PP/WH/WL = strong

                // Bouncing from Support — price is just above support and was lower before
                if (distToSup <= BOUNCE_ZONE && price >= prevPrice) {
                    bull += strBonus;
                    reasons.push(`🔄 Bouncing from ${nearSup.label} @ ${nearSup.price} (+${strBonus}pts ✅)`);
                    marketState.paSignal = { type: 'SUPPORT_BOUNCE', level: nearSup, dist: distToSup };
                }
                // Breaking below Support — price just fell through support
                else if (distToSup < 0 && Math.abs(distToSup) > BREAK_BUFFER && price < prevPrice) {
                    bear += strBonus + 1;
                    reasons.push(`💥 Break below ${nearSup.label} @ ${nearSup.price} — bearish breakdown! (+${strBonus+1}pts ⚠️)`);
                    marketState.paSignal = { type: 'SUPPORT_BREAK', level: nearSup, dist: distToSup };
                }
            }

            if (nearRes) {
                const distToRes = nearRes.price - price;
                const strBonus  = nearRes.strength >= 3 ? 2 : 1;

                // Rejected from Resistance — price near resistance and falling
                if (distToRes <= BOUNCE_ZONE && price <= prevPrice) {
                    bear += strBonus;
                    reasons.push(`🔄 Rejection at ${nearRes.label} @ ${nearRes.price} (+${strBonus}pts ⚠️)`);
                    marketState.paSignal = { type: 'RESISTANCE_REJECT', level: nearRes, dist: distToRes };
                }
                // Breaking above Resistance — price just pushed through
                else if (distToRes < 0 && Math.abs(distToRes) > BREAK_BUFFER && price > prevPrice) {
                    bull += strBonus + 1;
                    reasons.push(`🚀 Break above ${nearRes.label} @ ${nearRes.price} — bullish breakout! (+${strBonus+1}pts ✅)`);
                    marketState.paSignal = { type: 'RESISTANCE_BREAK', level: nearRes, dist: distToRes };
                }
            }
        }
    }

    // ── POC Gate — block entry when price is AT the POC magnet (chop zone) ────
    // AT_POC = price within 0.1% of highest-volume level → market will oscillate,
    // not trend. INSUFFICIENT = not enough data yet → let through (don't block early session).
    const pocSig = marketState.poc?.signal ?? 'INSUFFICIENT';
    qualityGate.pocClear = pocSig !== 'AT_POC';   // false = AT POC magnet → block

    // Direction alignment: BUY CALL needs price ABOVE POC (buyers in control).
    //                      BUY PUT needs price BELOW POC (sellers in control).
    // If INSUFFICIENT → allow (no data to block on).
    if (rawSignal !== 'WAIT' && pocSig !== 'INSUFFICIENT') {
        if (rawSignal === 'BUY CALL' && pocSig === 'BELOW_POC') qualityGate.pocClear = false;
        if (rawSignal === 'BUY PUT'  && pocSig === 'ABOVE_POC') qualityGate.pocClear = false;
    }

    // ── Delta Divergence Gate — warn when price and delta disagree ────────────
    // Divergence = price going up but sellers absorbing (or vice versa).
    // This is the most reliable reversal early warning from order flow.
    // We don't block on divergence alone — just reduce confidence (handled in Telegram).
    qualityGate.deltaOk = !(marketState.delta?.divergence ?? false);

    // ── Delta CONTRADICTION Gate — NEW ─────────────────────────────────────────
    // External review of a live day flagged this exact failure: Delta was +65.7%
    // (buyers clearly in control) yet the engine still issued BUY PUT from other
    // votes. Divergence (above) only catches price-near-extreme cases — it
    // missed this because price wasn't at a session high/low at the time. This
    // is a direct veto: real-time order-flow delta is one of the freshest, most
    // reliable inputs (updates every tick), so a signal that directly opposes a
    // STRONG delta reading (>25% either way) should not fire — the underlying
    // votes (PCR, global cues, FII/DII — all lagging/daily-granularity data)
    // are being outweighed by what large intraday buyers/sellers are doing right now.
    const deltaPct = marketState.delta?.deltaPct ?? null;
    qualityGate.deltaAligned = true;
    if (rawSignal !== 'WAIT' && deltaPct !== null && Math.abs(deltaPct) >= 25) {
        if (rawSignal === 'BUY PUT'  && deltaPct >  25) qualityGate.deltaAligned = false;
        if (rawSignal === 'BUY CALL' && deltaPct < -25) qualityGate.deltaAligned = false;
    }

    // ── Contradiction Score — NEW (informational for now) ────────────────────
    // 6-factor weighted check (MTF 40 / PCR 15 / Delta 15 / VWAP 10 / POC 10 /
    // ORB 10). NOTE: also made INFORMATIONAL, not blocking, for the same
    // reason as the sequence gate below — MTF alone carries 40% weight, so a
    // clearly-aligned MTF (40) plus just PCR+Delta disagreeing (15+15=30) was
    // already enough to trip "both ≥30%" and force NO TRADE — but that's
    // largely the SAME case the existing individual deltaAligned/pocClear
    // gates already handle at the raw-factor level. Stacked together with
    // those plus the sequence check, this was almost never letting a signal
    // through. Tracked + shown in INSIGHTS so real hit-rate can be observed
    // before re-enabling as a hard gate (likely with a higher threshold, e.g.
    // ≥40/≥40 instead of ≥30/≥30, once there's a few days of data).
    const contradictionScore = computeContradictionScore();
    marketState.contradictionScore = contradictionScore;
    qualityGate.contradictionOk = !(rawSignal !== 'WAIT' && contradictionScore.result === 'NO_TRADE');   // tracked, not enforced below

    // ── Strict Sequential Agreement — NEW (informational for now) ───────────
    // The exact requested chain: MTF → PCR → Delta → ORB → VWAP → Value Area.
    // NOTE: made INFORMATIONAL, not blocking. computeContradictionScore() above
    // and the individual deltaAligned/pocClear gates already cover the real
    // failure modes (both-sides-substantial conflict, strong opposing order
    // flow, wrong side of POC). Also requiring EVERY one of 6 factors to not
    // oppose — on top of all the gates already stacked (MTF/RSI/window/VIX/
    // ADX/S-R/physics/POC/delta/contradiction) — was blocking almost every
    // signal, since VWAP/ORB/Value Area routinely sit neutral-ish or briefly
    // lag even on genuinely good trend days. Logged + shown in the INSIGHTS
    // tab so its real-world hit rate can be observed before ever making it a
    // hard gate again.
    const agreementSequence = checkAgreementSequence(rawSignal);
    marketState.agreementSequence = agreementSequence;
    qualityGate.sequenceAligned = agreementSequence.passed;   // tracked, not enforced below

    // ── Trend Conviction Mode — NEW (computed BEFORE qualityGate.passed uses it) ──
    // Addresses a real gap: a single strong-but-transient factor (e.g. a delta
    // spike) could flip the raw vote tally AGAINST an otherwise overwhelming
    // structural picture (VWAP, Value Area, ORB, 15m/1H trend all one way).
    // Block ONLY when conviction is strong (4+ of 6 independent conditions)
    // AND MTF itself hasn't genuinely confirmed the counter-direction — i.e.
    // this isn't a real reversal, just one factor outvoting a stacked trend.
    const trendConviction = computeTrendConviction();
    marketState.trendConviction = trendConviction;
    const convictionOpposesSignal =
        (trendConviction.active === 'BEARISH' && rawSignal === 'BUY CALL') ||
        (trendConviction.active === 'BULLISH' && rawSignal === 'BUY PUT');
    const mtfGenuinelyConfirms = marketState.mtf?.aligned && marketState.mtf?.signal === rawSignal;
    qualityGate.convictionOk = !(convictionOpposesSignal && !mtfGenuinelyConfirms);

    // Recompute passed HERE — srClear may have been flipped to false inside the gate block above.
    // Physics gates: physicsLaw1=null means UNKNOWN (early session) → allow through.
    //                physicsLaw1=false means confirmed counter-trend/sideways → block.
    //                physicsLaw3=false means ON_ACTION (chasing) → block.
    qualityGate.passed = qualityGate.mtfAligned && qualityGate.rsiClean
                      && qualityGate.safeWindow  && qualityGate.vixSafe
                      && qualityGate.adxTrend    && (qualityGate.srClear !== false)
                      && (qualityGate.physicsLaw1 !== false)
                      && (qualityGate.physicsLaw3 !== false)
                      && (qualityGate.pocClear   !== false)   // AT_POC or wrong side = block
                      && qualityGate.deltaAligned              // strong opposing delta = block
                      && qualityGate.convictionOk;              // stacked structural trend opposes signal = block
                      // contradictionOk / sequenceAligned intentionally NOT included — informational only, see notes above
    marketState.qualityGate = qualityGate;

    if (rawSignal !== 'WAIT' && !qualityGate.deltaAligned) {
        signal = 'WAIT'; confidence = 0;
        reasons.push(`⛔ Delta ${deltaPct > 0 ? '+' : ''}${deltaPct}% strongly contradicts ${rawSignal} — order flow disagrees, wait for alignment`);
    }

    if (rawSignal !== 'WAIT' && !qualityGate.contradictionOk) {
        // Informational only — does NOT force WAIT. See note above.
        reasons.push(`ℹ️ Contradiction Score — Bullish ${contradictionScore.bullFactors.join('+')||'-'} (${contradictionScore.bullWeight}%) vs Bearish ${contradictionScore.bearFactors.join('+')||'-'} (${contradictionScore.bearWeight}%) — both sides substantial (not blocking)`);
    }

    if (rawSignal !== 'WAIT' && !qualityGate.sequenceAligned) {
        // Informational only — does NOT force WAIT. See note above.
        reasons.push(`ℹ️ Sequence check: ${agreementSequence.failedAt} disagrees with ${rawSignal} (not blocking)`);
    }

    // Trend Conviction — blocking message OR confidence boost (signal/confidence
    // already finalized above, so this only adjusts the reasons/confidence, it
    // does not need to touch qualityGate.passed again).
    if (rawSignal !== 'WAIT' && !qualityGate.convictionOk) {
        signal = 'WAIT'; confidence = 0;
        const conds = trendConviction.active === 'BEARISH' ? trendConviction.bearConditions : trendConviction.bullConditions;
        reasons.push(`⛔ Trend Conviction (${trendConviction.active}, ${conds.length}/6: ${conds.join(', ')}) contradicts ${rawSignal} without genuine MTF reversal — wait`);
    } else if (rawSignal !== 'WAIT' && !convictionOpposesSignal &&
               ((trendConviction.active === 'BEARISH' && rawSignal === 'BUY PUT') ||
                (trendConviction.active === 'BULLISH' && rawSignal === 'BUY CALL'))) {
        const conds = trendConviction.active === 'BEARISH' ? trendConviction.bearConditions : trendConviction.bullConditions;
        const boost = Math.min((conds.length - 3) * 4, 15);   // +4 per condition past 3, capped +15
        confidence = Math.min(confidence + boost, 98);
        reasons.push(`🔥 Trend Conviction (${trendConviction.active}, ${conds.length}/6: ${conds.join(', ')}) — confidence boosted +${boost}%`);
    }

    // ── Option Premium Filter — NEW ────────────────────────────────────────────
    // Per feedback: "Avoid buying options that are already overextended.
    // 24350 CE, Premium already +45% today. Fresh entry not recommended."
    // Chasing a premium that's already run 40%+ from the day's open means most
    // of the easy move is already captured — poor risk/reward for a fresh buyer,
    // and the position is much more exposed to a sharp pullback/profit-booking.
    qualityGate.premiumOk = true;
    if (signal !== 'WAIT') {
        const flow = marketState.optionFlow;
        const relevantChange = signal === 'BUY CALL' ? flow?.ceChangeFromOpen : flow?.peChangeFromOpen;
        if (relevantChange != null && relevantChange >= 40) {
            qualityGate.premiumOk = false;
            signal = 'WAIT'; confidence = 0;
            reasons.push(`⛔ Premium already +${relevantChange}% today — overextended, fresh entry not recommended (wait for pullback/pause)`);
        }
    }

    // ── ADX weak-trend confidence cap ────────────────────────────────────────
    // Signal passes gate but trend is not fully confirmed (ADX near floor).
    // Cap confidence at 60% so the UI doesn't show a strong conviction call.
    if (signal !== 'WAIT' && adxVal !== null && adxVal < adxFloor1m + 5) {
        const before = confidence;
        confidence = Math.min(confidence, 60);
        if (confidence < before) reasons.push(`⚠️ Confidence capped at 60% — ADX ${adxVal} < ${adxFloor1m + 5} (trend weak, full signal needs ADX ≥ ${adxFloor1m + 5})`);
    }

    // ── SoftAligned confidence cap — 5m dissenting ───────────────────────────
    // When 15m+1h agree but 5m is still choppy (morning pattern), gate is passed
    // but conviction is limited. Cap at 55% — below the 65% minimum threshold,
    // so this will be converted to WAIT below unless other votes push it higher.
    if (signal !== 'WAIT' && !marketState.mtf.aligned && marketState.mtf.softAligned) {
        const before = confidence;
        confidence = Math.min(confidence, 55);
        if (confidence < before) reasons.push(`⚠️ Confidence capped at 55% — 5m TF dissenting (15m+1h aligned, wait for 5m confirmation)`);
    }

    // ── Caution zone confidence cap (14:00–14:30) ─────────────────────────────
    // Theta decay accelerating — even valid signals have worse risk/reward.
    // Cap at 70% to prevent overconfident entries in the danger zone.
    if (signal !== 'WAIT' && ew.status === 'caution') {
        const before = confidence;
        confidence = Math.min(confidence, 70);
        if (confidence < before) reasons.push(`⚠️ Caution zone 14:00–14:30 — confidence capped at 70%, reduce size`);
    }

    // ── Minimum confidence gate — 65% ────────────────────────────────────────
    // As an option buyer, low-confidence entries lose to theta.
    // Only trade when confidence is ≥65% — below that, the edge doesn't justify premium cost.
    if (signal !== 'WAIT' && confidence < 65) {
        signal = 'WAIT';
        reasons.push(`⛔ Confidence ${confidence}% < 65% minimum — edge too thin for option buyer, wait`);
    }

    // ── Consecutive signal confirmation — 2 cycles needed ────────────────────
    // Signal must appear in 2 consecutive poll cycles (≈6 seconds) before firing.
    // Eliminates single-candle noise and RSI momentary spikes.
    if (signal !== 'WAIT') {
        if (signalStreak.signal === signal) {
            signalStreak.count++;
        } else {
            signalStreak = { signal, count: 1 };
        }
        if (signalStreak.count < 2) {
            reasons.push(`⏳ Signal confirming — cycle ${signalStreak.count}/2 (waiting for 2nd confirmation)`);
            signal = 'WAIT';
            confidence = Math.min(confidence, 40);
        } else {
            reasons.push(`✅ Signal confirmed ${signalStreak.count} consecutive cycles`);
        }
    } else {
        signalStreak = { signal: 'WAIT', count: 0 };
    }

    // Expose streak count to frontend
    marketState.signalStreak = signalStreak.count;

    // ── Entry Quality Score ────────────────────────────────────────────────────
    // 0–100 numeric score showing how confluent the entry is.
    // Only meaningful when signal !== 'WAIT'.
    // Components: ADX strength, PCR confluence, RSI alignment, S/R proximity, candle pattern, MTF alignment
    if (signal !== 'WAIT') {
        let qs = 0;
        const scoreBreakdown = [];

        // 1. ADX strength (0–25 pts)
        if (adxVal !== null) {
            if      (adxVal >= 40) { qs += 25; scoreBreakdown.push(`ADX:25 (${adxVal.toFixed(0)} very strong)`); }
            else if (adxVal >= 30) { qs += 20; scoreBreakdown.push(`ADX:20 (${adxVal.toFixed(0)} strong)`); }
            else if (adxVal >= 25) { qs += 15; scoreBreakdown.push(`ADX:15 (${adxVal.toFixed(0)} moderate)`); }
            else if (adxVal >= 20) { qs +=  8; scoreBreakdown.push(`ADX:8 (${adxVal.toFixed(0)} weak)`); }
            else                   { qs +=  0; scoreBreakdown.push(`ADX:0 (${adxVal.toFixed(0)} very weak)`); }
        }

        // 2. PCR confluence (0–20 pts)
        // FIX: use marketState.pcr directly (not ind.pcr?.pcr which is undefined)
        // FIX 2: When PCR unavailable (API blocked), award 10pts neutral — don't
        // penalize valid signals with 0pts just because Railway IPs are blocked.
        const pcr = marketState.pcr;
        if (pcr != null) {
            const pcrBullish = pcr > 1.2;
            const pcrBearish = pcr < 0.8;
            const signalBullish = signal === 'BUY CALL';   // FIX: space not underscore
            if ((signalBullish && pcrBullish) || (!signalBullish && pcrBearish)) {
                qs += 20; scoreBreakdown.push(`PCR:20 (${pcr.toFixed(2)} strong confluence)`);
            } else if ((signalBullish && pcr >= 1.0) || (!signalBullish && pcr <= 1.0)) {
                qs += 10; scoreBreakdown.push(`PCR:10 (${pcr.toFixed(2)} mild confluence)`);
            } else {
                qs +=  0; scoreBreakdown.push(`PCR:0 (${pcr.toFixed(2)} against signal)`);
            }
        } else {
            // PCR unavailable — award neutral score, mark clearly
            qs += 10; scoreBreakdown.push(`PCR:10 (unavailable — neutral assumed)`);
        }

        // 3. RSI alignment (0–15 pts)
        // FIX: use indicators.rsi (the function param) not ind.rsi
        const rsiQ = indicators.rsi;
        if (rsiQ != null) {
            const rsiBullish = rsiQ > 55 && rsiQ < 75;
            const rsiBearish = rsiQ < 45 && rsiQ > 25;
            if ((signal === 'BUY CALL' && rsiBullish) || (signal === 'BUY PUT' && rsiBearish)) {
                qs += 15; scoreBreakdown.push(`RSI:15 (${rsiQ.toFixed(0)} aligned)`);
            } else if (rsiQ >= 40 && rsiQ <= 60) {
                qs +=  5; scoreBreakdown.push(`RSI:5 (${rsiQ.toFixed(0)} neutral)`);
            } else {
                qs +=  0; scoreBreakdown.push(`RSI:0 (${rsiQ.toFixed(0)} against)`);
            }
        }

        // 4. MTF alignment (0–20 pts)
        // FIX: use marketState.mtf.signal (not ind.mtfSignal which is undefined)
        // marketState.mtf.signal is 'BUY CALL' / 'BUY PUT' / 'WAIT'
        const mtfSig = marketState.mtf?.signal;
        if (mtfSig) {
            const aligned = (signal === 'BUY CALL' && mtfSig === 'BUY CALL') || (signal === 'BUY PUT' && mtfSig === 'BUY PUT');
            const neutral = !mtfSig || mtfSig === 'WAIT';
            if (aligned)      { qs += 20; scoreBreakdown.push(`MTF:20 (aligned)`); }
            else if (neutral) { qs += 8;  scoreBreakdown.push(`MTF:8 (neutral)`); }
            else              { qs += 0;  scoreBreakdown.push(`MTF:0 (against)`); }
        }

        // 5. S/R proximity bonus (0–10 pts)
        const pa = marketState.paSignal;
        if (pa) {
            const bounceForCall   = signal === 'BUY CALL' && pa.type === 'SUPPORT_BOUNCE';
            const breakForCall    = signal === 'BUY CALL' && pa.type === 'RESISTANCE_BREAK';
            const rejectForPut    = signal === 'BUY PUT'  && pa.type === 'RESISTANCE_REJECT';
            const breakForPut     = signal === 'BUY PUT'  && pa.type === 'SUPPORT_BREAK';
            if (bounceForCall || breakForCall || rejectForPut || breakForPut) {
                qs += 10; scoreBreakdown.push(`S/R:10 (price action confirms)`);
            }
        }

        // 6. Candle pattern (0–10 pts)
        // FIX: use marketState.candlePattern (not ind.candlePattern which is undefined)
        const cp = marketState.candlePattern;
        if (cp && cp.direction !== 'NEUTRAL') {
            const cpAligned = (signal === 'BUY CALL' && cp.direction === 'BULLISH') || (signal === 'BUY PUT' && cp.direction === 'BEARISH');
            if (cpAligned) {
                const pts = cp.strength >= 3 ? 10 : 5;
                qs += pts; scoreBreakdown.push(`Candle:${pts} (${cp.pattern} aligned)`);
            }
        }

        // 7. Physics of Trading — Law 3: Reaction-Zone Entry (0–15 pts)
        // Core rule from "Physics of Trading" (Nitin Murarka): never enter on the
        // ACTION (the sharp move itself) — wait for and enter on the REACTION
        // (pullback to VWAP or 38.2%–61.8% Fibonacci retracement). Penalizes
        // entries that are chasing a candle that already ran far from VWAP.
        try {
            // BUG FIX: getCandleHistory(true) contains multi-day data — overnight
            // price gaps would create fake giant "swing" legs and wrong Fibonacci
            // levels (same issue already fixed for ADX above). Use session-only
            // candles instead, same as sessionCandlesForADX.
            const candlesForPhysics = getSessionCandles();
            const reactionGate = getReactionZoneGate(marketState.nifty, indicators.vwap, candlesForPhysics, signal);
            marketState.physicsOfTrading = marketState.physicsOfTrading || {};
            marketState.physicsOfTrading.reactionGate = reactionGate;
            qs += reactionGate.score;
            scoreBreakdown.push(`Law3-Reaction:${reactionGate.score} (${reactionGate.zone})`);
            reasons.push(reactionGate.reason);

            // Law 1 — swing trend structure (HH/HL or LH/LL), independent
            // second vote alongside the existing MTF alignment check.
            // GATE: SIDEWAYS or confirmed counter-trend = block signal.
            // UNKNOWN = early session, not enough data = allow through.
            const swing = getSwingTrend(candlesForPhysics, 30);
            marketState.physicsOfTrading.swingTrend = swing;
            const swingAligned =
                (signal === 'BUY CALL' && swing.trend === 'UPTREND') ||
                (signal === 'BUY PUT'  && swing.trend === 'DOWNTREND');
            const swingAgainst =
                (signal === 'BUY CALL' && (swing.trend === 'DOWNTREND' || swing.trend === 'SIDEWAYS')) ||
                (signal === 'BUY PUT'  && (swing.trend === 'UPTREND'   || swing.trend === 'SIDEWAYS'));
            // null = unknown (pass through), false = blocked, true = confirmed ok
            qualityGate.physicsLaw1 = swing.trend === 'UNKNOWN' ? null : !swingAgainst;
            if (swingAligned) {
                qs += 5; scoreBreakdown.push(`Law1-Trend:+5 (${swing.trend} confirmed — ${swing.reason})`);
                reasons.push(`⚛️ Law1 ✅ Swing ${swing.trend} aligns with ${signal}`);
            } else if (swingAgainst) {
                qs -= 5; scoreBreakdown.push(`Law1-Trend:-5 (${swing.trend} AGAINST ${signal})`);
                reasons.push(`⚛️ Law1 ❌ Swing ${swing.trend} AGAINST ${signal} — counter-trend blocked`);
            }
            // Law 3 hard gate: ON_ACTION = chasing a candle that already ran = block
            qualityGate.physicsLaw3 = (reactionGate.zone !== 'ON_ACTION');
            if (reactionGate.zone === 'ON_ACTION') {
                reasons.push(`⚛️ Law3 ❌ Chasing the action — ${Math.abs(reactionGate.vwapDistPct ?? 0).toFixed(2)}% from VWAP, not a reaction entry`);
            }
        } catch (e) {
            console.warn('[Physics] reaction-zone gate failed:', e.message);
        }

        // Normalize back to 0–100 scale: max raw score is now 120
        // (100 original components + 15 Law3-Reaction + 5 Law1-Trend).
        const qsRaw = qs;
        qs = Math.round((qsRaw / 120) * 100);

        const grade = qs >= 80 ? 'A+' : qs >= 65 ? 'A' : qs >= 50 ? 'B' : qs >= 35 ? 'C' : 'D';
        const gradeColor = qs >= 80 ? '🟢' : qs >= 65 ? '🟢' : qs >= 50 ? '🟡' : '🔴';

        marketState.entryQuality = { score: qs, grade, gradeColor, breakdown: scoreBreakdown };
        // Add to reasons for display
        reasons.push(`${gradeColor} Entry Quality: ${qs}/100 (${grade}) — ${scoreBreakdown.slice(0,3).join(' | ')}`);
    } else {
        marketState.entryQuality = { score: 0, grade: '-', gradeColor: '⚪', breakdown: [] };
    }

    // ── Standalone Fibonacci Retracement Card ────────────────────────────────
    // Unlike the Law-3 reaction gate above (which only computes when a
    // BUY signal is live), this runs every cycle regardless of signal so the
    // UI card always shows the latest swing's fib levels + where price sits.
    try {
        const fiboCandles = getSessionCandles();
        const impulse = fiboCandles ? getLatestImpulseFibo(fiboCandles) : null;
        if (impulse) {
            const { direction, swingLow, swingHigh, fib } = impulse;
            const price = marketState.nifty;
            const range = fib.level100 - fib.level0; // signed; 0%=start, 100%=end of impulse
            const retracePct = range !== 0 ? ((price - fib.level0) / range) * 100 : null;

            const lo = Math.min(fib.level382, fib.level618);
            const hi = Math.max(fib.level382, fib.level618);
            const inReactionZone = price >= lo && price <= hi;
            const beyondLo = Math.min(fib.level786, fib.level100);
            const beyondHi = Math.max(fib.level786, fib.level100);
            const beyondReversal = price >= beyondLo && price <= beyondHi;

            let zoneLabel, zoneColor;
            if (beyondReversal)      { zoneLabel = '⚠️ Beyond 78.6% — trend-change risk'; zoneColor = 'amber'; }
            else if (inReactionZone) { zoneLabel = '✅ In 38.2%–61.8% reaction zone'; zoneColor = 'green'; }
            else if (retracePct !== null && retracePct < 23.6 && retracePct > -23.6) { zoneLabel = '🏃 Near the action (shallow pullback)'; zoneColor = 'blue'; }
            else                      { zoneLabel = '— Outside key fib zones'; zoneColor = 'dim'; }

            marketState.fiboCard = {
                direction,                                  // 'UP' (retrace down) | 'DOWN' (retrace up)
                swingLow: parseFloat(swingLow.toFixed(1)),
                swingHigh: parseFloat(swingHigh.toFixed(1)),
                levels: {
                    l0:    parseFloat(fib.level0.toFixed(1)),
                    l236:  parseFloat(fib.level236.toFixed(1)),
                    l382:  parseFloat(fib.level382.toFixed(1)),
                    l50:   parseFloat(fib.level500.toFixed(1)),
                    l618:  parseFloat(fib.level618.toFixed(1)),
                    l786:  parseFloat(fib.level786.toFixed(1)),
                    l100:  parseFloat(fib.level100.toFixed(1))
                },
                price,
                retracePct: retracePct !== null ? parseFloat(retracePct.toFixed(1)) : null,
                zoneLabel, zoneColor,
                updatedAt: new Date().toISOString()
            };
        } else {
            // No valid impulse swing yet (start of day / candle gap) — clear
            // rather than leave a stale card showing a previous swing's levels.
            marketState.fiboCard = null;
        }
    } catch (e) {
        console.warn('[Fibo Card] failed:', e.message);
    }

    // ── Physics of Trading — consolidated 3-Law status for the new tab ────────
    // Runs every cycle so the Physics tab always shows live Law status even when
    // the main signal is WAIT.  Each Law is independently evaluated here.
    try {
        const pot = marketState.physicsOfTrading || {};

        // LAW 1 — Trend Inertia (swing structure HH/HL or LH/LL)
        const sw = pot.swingTrend;
        let law1 = { status: 'WAIT', label: 'Awaiting candle data…', direction: null };
        if (sw && sw.trend) {
            // getSwingTrend() returns .trend (UPTREND/DOWNTREND/SIDEWAYS/UNKNOWN), not .direction
            if (sw.trend === 'UPTREND')     law1 = { status: 'PASS', label: `✅ Uptrend — HH/HL structure confirmed (${sw.reason || ''})`, direction: 'UP' };
            else if (sw.trend === 'DOWNTREND') law1 = { status: 'PASS', label: `✅ Downtrend — LH/LL structure confirmed (${sw.reason || ''})`, direction: 'DOWN' };
            else if (sw.trend === 'SIDEWAYS') law1 = { status: 'FAIL', label: `❌ No clear trend — choppy/sideways structure`, direction: 'SIDEWAYS' };
            // UNKNOWN stays as WAIT (default above)
        }

        // LAW 2 — Force (PCR + OI + VIX + A/D + FII)
        const pcr2   = marketState.pcr    || null;
        const vix2   = marketState.vix    || null;
        const adR    = marketState.breadth?.adRatio || null;
        const fiiNet = marketState.fii?.net ?? null;
        // FIX Bug1: oiBuildup has no 'interpretation' field — use 'signal' instead
        const oiSignal = marketState.oiBuildup?.signal || null;  // 'BULL_LONG'|'BEAR_SHORT'|'NEUTRAL' etc.
        const pcrSlope2 = marketState.pcrSlope?.trend || null;

        const bits = [];
        let forceScore = 0;
        if (pcr2 != null) { bits.push(`PCR ${pcr2.toFixed(2)}`); if (pcr2 > 1.1) forceScore++; else if (pcr2 < 0.8) forceScore--; }
        if (pcrSlope2 === 'RISING') { bits.push('PCR rising ▲'); forceScore++; }
        else if (pcrSlope2 === 'FALLING') { bits.push('PCR falling ▼'); forceScore--; }
        if (vix2 != null) { bits.push(`VIX ${vix2.toFixed(1)}`); if (vix2 < 14) forceScore++; else if (vix2 > 20) forceScore--; }
        if (adR != null) { bits.push(`A/D ${adR.toFixed(1)}`); if (adR > 1.5) forceScore++; else if (adR < 0.7) forceScore--; }
        // FIX Bug2: FII threshold was 500Cr — too high for normal days (avg ±50-200Cr).
        // Lowered to 100Cr so FII net buying/selling actually contributes to force score.
        if (fiiNet != null) { bits.push(`FII ${fiiNet > 0 ? '+' : ''}${Math.round(fiiNet)}Cr`); if (fiiNet > 100) forceScore++; else if (fiiNet < -100) forceScore--; }
        // FIX Bug1 cont: use oiSignal (signal field) to determine OI direction
        if (oiSignal && oiSignal !== 'NEUTRAL') {
            const oiLabel = marketState.oiBuildup?.label || oiSignal;
            bits.push(`OI: ${oiSignal}`);
            const isBull = oiSignal.includes('BULL') || oiSignal.includes('LONG');
            const isBear = oiSignal.includes('BEAR') || oiSignal.includes('SHORT');
            if (isBull) forceScore++; else if (isBear) forceScore--;
        }

        let law2;
        const trendDir = law1.direction;
        const forceAligned = trendDir === 'UP' ? forceScore >= 2 : trendDir === 'DOWN' ? forceScore <= -2 : false;
        const forceWeak    = Math.abs(forceScore) < 2;
        // Direction-specific hints shown below force bits
        const forceHint = trendDir === 'UP'
            ? 'Need: PCR>1.1, PCR rising, VIX<14, A/D>1.5, FII buying'
            : trendDir === 'DOWN'
            ? 'Need: PCR<0.8, PCR falling, VIX>20, A/D<0.7, FII selling'
            : '';
        if (!trendDir || trendDir === 'SIDEWAYS') {
            law2 = { status: 'WAIT', label: `⏳ Force check pending — no trend direction yet`, bits, forceScore, forceHint: 'Wait for Law 1 trend first' };
        } else if (forceAligned) {
            law2 = { status: 'PASS', label: `✅ Force confirmed — ${trendDir === 'UP' ? 'Bullish' : 'Bearish'} momentum (score ${forceScore > 0 ? '+' : ''}${forceScore})`, bits, forceScore, forceHint };
        } else if (forceWeak) {
            law2 = { status: 'WAIT', label: `⏳ Weak/neutral force — score ${forceScore > 0 ? '+' : ''}${forceScore}, need ${trendDir === 'UP' ? '≥+2' : '≤-2'}`, bits, forceScore, forceHint };
        } else {
            law2 = { status: 'FAIL', label: `❌ Force AGAINST ${trendDir} trend — do not enter ${trendDir === 'UP' ? 'CALL' : 'PUT'} (score ${forceScore > 0 ? '+' : ''}${forceScore})`, bits, forceScore, forceHint };
        }

        // LAW 3 — Reaction zone (Fibonacci 38.2–61.8%)
        let law3 = { status: 'WAIT', label: 'Awaiting swing + price data…', zone: null, retracePct: null };
        const fibo = marketState.fiboCard;
        if (fibo && fibo.levels && fibo.price) {
            const rp = fibo.retracePct;
            // Direction context: for CALL (UP trend) we wait for price to PULL BACK into 38-62%.
            // For PUT (DOWN trend) we wait for price to BOUNCE UP into 38-62% of the fall.
            const isDown = (trendDir === 'DOWN') || (fibo.direction === 'DOWN');
            const reactionWord = isDown ? 'bounce (dead-cat)' : 'pullback';
            const waitWord     = isDown ? 'Wait for bounce up to 38–62% of fall' : 'Wait for pullback to 38–62%';
            if (fibo.zoneColor === 'green') {
                law3 = { status: 'PASS', label: `✅ Price in 38.2–61.8% ${reactionWord} zone (${rp != null ? rp.toFixed(0) + '%' : '--'} retrace) — ENTRY ZONE`, zone: 'REACTION', retracePct: rp };
            } else if (fibo.zoneColor === 'amber') {
                law3 = { status: 'FAIL', label: `⚠️ Price beyond 78.6% retrace — trend reversal risk, skip ${isDown ? 'PUT' : 'CALL'} entry`, zone: 'REVERSAL_RISK', retracePct: rp };
            } else if (fibo.zoneColor === 'blue') {
                law3 = { status: 'WAIT', label: `⏳ ${isDown ? 'Price still in downmove — ' : 'Price at action zone — '}${waitWord} (${rp != null ? rp.toFixed(0) + '%' : '--'} now)`, zone: 'ACTION', retracePct: rp };
            } else {
                law3 = { status: 'WAIT', label: `⏳ ${waitWord} before entering ${isDown ? 'PUT' : 'CALL'} (${rp != null ? rp.toFixed(0) + '%' : '--'} retrace now)`, zone: 'NEUTRAL', retracePct: rp };
            }
        }

        // Entry decision — ALL 3 laws must PASS
        const allPass   = law1.status === 'PASS' && law2.status === 'PASS' && law3.status === 'PASS';
        const anyFail   = law1.status === 'FAIL'  || law2.status === 'FAIL';
        const optionDir = law1.direction === 'UP' ? 'CALL' : law1.direction === 'DOWN' ? 'PUT' : null;
        let entryReady, entryLabel, entryColor;
        const failedLaw = law1.status === 'FAIL' ? '1' : law2.status === 'FAIL' ? '2' : law3.status === 'FAIL' ? '3' : null;
        if (allPass && optionDir) {
            entryReady  = true;
            entryLabel  = optionDir === 'PUT'
                ? `🚀 ALL 3 LAWS VERIFIED — BUY PUT NOW (reaction bounce in 38–62%)`
                : `🚀 ALL 3 LAWS VERIFIED — BUY CALL NOW (pullback in 38–62%)`;
            entryColor  = 'green';
        } else if (anyFail) {
            entryReady  = false;
            entryLabel  = `🚫 DO NOT ENTER — Law ${failedLaw} failed${optionDir ? ' (' + optionDir + ' side)' : ''}`;
            entryColor  = 'red';
        } else {
            const passed = [law1, law2, law3].filter(l => l.status === 'PASS').length;
            entryReady  = false;
            entryLabel  = `⏳ ${passed}/3 Laws verified${optionDir ? ' — watching for ' + optionDir + ' entry' : ' — waiting for trend'}`;
            entryColor  = 'amber';
        }

        marketState.physicsOfTrading = {
            ...pot,
            law1, law2, law3,
            entryReady, entryLabel, entryColor,
            optionDir,
            updatedAt: new Date().toISOString(),
        };
    } catch (e) {
        console.warn('[Physics tab] compute error:', e.message);
    }

    return { signal, confidence, reasons };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BTST / STBT Detector
// ─────────────────────────────────────────────────────────────────────────────
// Runs in the 3:00–3:20 PM window. Evaluates whether today's close setup is
// strong enough to carry overnight into tomorrow's open.
//
// BTST (Buy Today Sell Tomorrow) — long CALL overnight
// STBT (Sell Today Buy Tomorrow) — long PUT overnight
//
// Rules (all must pass):
//   1. Time: 3:00–3:20 PM IST only
//   2. Current signal must be BUY CALL or BUY PUT (not WAIT)
//   3. Confidence >= 62% (lower threshold than intraday — overnight has extra risk)
//   4. MTF 15m + 1h both aligned in signal direction
//   5. VIX < 18 (high VIX = gap risk)
//   6. PCR supports direction (BTST: pcr >= 1.0 | STBT: pcr <= 1.0)
//   7. Global cues not opposing (US futures direction)
//   8. NOT expiry day (Tuesday) — options die at 3:30, can't carry
//   9. Tomorrow is NOT expiry day — would be gap-down/gap-up risk into expiry
// ═══════════════════════════════════════════════════════════════════════════════
function evaluateBTST() {
    const ist = getIST();
    const h = ist.getHours(), m = ist.getMinutes();
    const istMin = h * 60 + m;

    // Clear stale BTST at market open (9:15 AM) only — not continuously through the day.
    // BUG FIX: old code cleared btst on every tick outside 3:00–3:20, so a 3:15 signal
    // was gone by 3:25 before the trader could confirm and place the order.
    if (istMin >= 555 && istMin <= 560) {
        // 9:15–9:20 AM: clear previous day's BTST so it doesn't pollute today's session
        marketState.btst = null;
    }

    // Only evaluate in 3:00–3:20 window
    if (istMin < 900 || istMin > 920) {
        return;  // Outside window — preserve any signal set during the evaluation window
    }

    const s = marketState;

    // Rule 8: Not expiry day (Tuesday)
    if (isExpiryDay()) {
        marketState.btst = { type: 'NONE', reason: 'Expiry day — options expire today, cannot carry' };
        return;
    }

    // Rule 9: Tomorrow not expiry day
    const tomorrowDay = (ist.getDay() + 1) % 7;
    if (tomorrowDay === 2) {  // 2 = Tuesday
        marketState.btst = { type: 'NONE', reason: 'Tomorrow is expiry — gap risk into expiry too high' };
        return;
    }

    // Rule 1+2: Valid directional signal
    const signal = s.signal;
    if (signal !== 'BUY CALL' && signal !== 'BUY PUT') {
        marketState.btst = { type: 'NONE', reason: 'No clear directional signal at close' };
        return;
    }

    const isBull = signal === 'BUY CALL';
    const type   = isBull ? 'BTST' : 'STBT';

    // Collect pass/fail conditions
    const checks = [];
    let fails = 0;

    // Rule 3: Confidence
    const confOk = s.confidence >= 62;
    checks.push({ label: `Confidence ${s.confidence}%`, pass: confOk, detail: 'need ≥62%' });
    if (!confOk) fails++;

    // Rule 4: MTF 15m + 1h aligned
    const tf15ok = isBull
        ? s.mtf.tf15m?.signal === 'BULLISH'
        : s.mtf.tf15m?.signal === 'BEARISH';
    const tf1hok = isBull
        ? s.mtf.tf1h?.signal === 'BULLISH'
        : s.mtf.tf1h?.signal === 'BEARISH';
    checks.push({ label: `15m TF ${s.mtf.tf15m?.signal||'--'}`, pass: tf15ok, detail: `need ${isBull?'BULLISH':'BEARISH'}` });
    checks.push({ label: `1h TF ${s.mtf.tf1h?.signal||'--'}`,  pass: tf1hok, detail: `need ${isBull?'BULLISH':'BEARISH'}` });
    if (!tf15ok) fails++;
    if (!tf1hok) fails++;

    // Rule 5: VIX < 18
    const vixOk = !s.vix || s.vix < 18;
    checks.push({ label: `VIX ${s.vix ?? '--'}`, pass: vixOk, detail: 'need <18' });
    if (!vixOk) fails++;

    // Rule 6: PCR direction
    const pcrOk = s.pcr === null ? true : (isBull ? s.pcr >= 1.0 : s.pcr <= 1.0);
    checks.push({ label: `PCR ${s.pcr ?? '--'}`, pass: pcrOk, detail: isBull ? 'need ≥1.0' : 'need ≤1.0' });
    if (!pcrOk) fails++;

    // Rule 7: Global cues not opposing
    const globalOk = s.global.bias !== (isBull ? 'BEARISH' : 'BULLISH');
    checks.push({ label: `Global ${s.global.bias}`, pass: globalOk, detail: 'must not oppose' });
    if (!globalOk) fails++;

    const passed = fails === 0;

    // ATM strike for the suggestion
    const atmStrike = s.nifty > 0 ? Math.round(s.nifty / 50) * 50 : null;
    const suggestedStrike = atmStrike
        ? (isBull ? atmStrike + 50 : atmStrike - 50)
        : null;

    marketState.btst = {
        type,           // 'BTST' | 'STBT' | 'NONE'
        passed,
        signal,
        confidence : s.confidence,
        strike     : suggestedStrike,
        atm        : atmStrike,
        nifty      : s.nifty,
        vix        : s.vix,
        pcr        : s.pcr,
        mtf15m     : s.mtf.tf15m?.signal || '--',
        mtf1h      : s.mtf.tf1h?.signal  || '--',
        globalBias : s.global.bias,
        checks,
        failCount  : fails,
        window     : '3:00–3:20 PM',
        exitTarget : 'Tomorrow 9:20–9:30 AM open',
        risk       : 'Gap risk present — use max 25% normal position size',
        generatedAt: new Date().toISOString(),
    };

    if (passed) {
        console.log(`🌙 [BTST] ${type} signal generated — ${signal} | Strike: ${suggestedStrike} | Conf: ${s.confidence}%`);
    } else {
        console.log(`🌙 [BTST] Conditions not met (${fails} fail) — ${checks.filter(c=>!c.pass).map(c=>c.label).join(', ')}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9:20 AM EMA-VWAP SETUP ALERT — "Vardaan Opening Setup"
// ═══════════════════════════════════════════════════════════════════════════════
// UPGRADED STRATEGY — multi-timeframe + A/D + PCR + VIX gating
//
// Why upgrade from 1m-only?
//   1m EMA/VWAP at 9:20 AM is extremely noisy — 5-min candle has only 5 bars,
//   EMA9 on 1m is just a 9-bar average of the first 5 minutes. A single spike
//   can make 1m EMA cross VWAP falsely.
//
// New logic — 4-layer confirmation:
//   LAYER 1 (Primary): 1m Price + EMA9 + EMA21 vs VWAP  [existing — fast read]
//   LAYER 2 (Trend):   5m MTF signal (BULLISH/BEARISH)   [RSI9+EMA+VWAP+ADX]
//   LAYER 3 (Breadth): A/D ratio — ≥1.5 bull, ≤0.7 bear [Nifty50 stock breath]
//   LAYER 4 (Options): PCR zone — confirms call/put bias  [not a hard gate]
//
// Decision matrix:
//   STRONG TRADE  = Layer1 + Layer2 + Layer3 all agree + PCR confirms  → fire alert
//   TRADE         = Layer1 + Layer2 agree, Layer3 mixed, PCR ok        → fire alert with caution
//   WEAK / SKIP   = Layer1 disagrees with Layer2                       → NO TRADE
//   HIGH RISK     = VIX > 20                                           → NO TRADE (market chaotic)
//
// Rules enforced:
//   1. Fires ONCE per day only (ema920AlertSentToday flag)
//   2. Window: 9:20–9:30 AM only
//   3. Requires live NIFTY price
//   4. 15m MTF used as tiebreaker when 5m is still INSUFFICIENT
// ═══════════════════════════════════════════════════════════════════════════════
async function check920Setup() {
    if (!isConfigured()) return;
    if (!isMarketOpen()) return;           // ← holiday / weekend / outside hours guard
    if (ema920AlertSentToday) return;

    const ist  = getIST();
    const mins = ist.getHours() * 60 + ist.getMinutes();
    if (mins < 560 || mins > 570) return;  // 9:20–9:30 AM only

    const { nifty, ema9, ema21, vwap } = marketState;
    if (!nifty || nifty <= 0 || !ema9 || !ema21 || !vwap) return;

    // ── Stale price guard — if change% is exactly 0.00 and no tick arrived,
    //    we have yesterday's close, not a live price. Skip to avoid false signal.
    if (marketState.change === 0 && marketState.changePct === 0) {
        console.log('[9:20] Skipping — price appears stale (change=0, no live tick yet)');
        return;
    }

    // ── LAYER 1: 1m Price + EMA vs VWAP ──────────────────────────────────────
    const priceAbove = nifty  > vwap;
    const ema9Above  = ema9   > vwap;
    const ema21Above = ema21  > vwap;
    const l1Bull = priceAbove && ema9Above && ema21Above;
    const l1Bear = !priceAbove && !ema9Above && !ema21Above;
    const l1Aligned = l1Bull || l1Bear;

    // ── LAYER 1b: 5m EMA/VWAP cross-check (noise filter for 1m at open) ────────
    // At 9:20, 1m EMA has only 5 bars — a single spike can flip it.
    // If 5m EMA/VWAP direction contradicts 1m, we treat Layer 1 as WEAK (not hard fail).
    const mtf5mEma  = marketState.mtf?.tf5m?.ema9  ?? null;
    const mtf5mVwap = marketState.mtf?.tf5m?.vwap  ?? null;
    let l1Confirmed = true;  // true = 5m agrees or unavailable; false = 5m contradicts
    if (mtf5mEma !== null && mtf5mVwap !== null) {
        const fiveAbove = mtf5mEma > mtf5mVwap;
        if (l1Bull && !fiveAbove)  l1Confirmed = false;  // 1m bull but 5m EMA below VWAP
        if (l1Bear && fiveAbove)   l1Confirmed = false;  // 1m bear but 5m EMA above VWAP
    }

    // ── LAYER 2: 5m MTF signal (falls back to 15m if 5m is INSUFFICIENT) ─────
    const mtf5m  = marketState.mtf?.tf5m;
    const mtf15m = marketState.mtf?.tf15m;
    const mtf5mSig  = mtf5m?.signal;   // 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'INSUFFICIENT'
    const mtf15mSig = mtf15m?.signal;
    // 5m has only 1 closed candle at 9:20 — may still be INSUFFICIENT
    // Use 15m as the primary higher-TF gate (more stable at open)
    const htfSig = (mtf15mSig && mtf15mSig !== 'INSUFFICIENT') ? mtf15mSig
                 : (mtf5mSig  && mtf5mSig  !== 'INSUFFICIENT') ? mtf5mSig
                 : null;
    const l2Bull = htfSig === 'BULLISH';
    const l2Bear = htfSig === 'BEARISH';
    const l2Available = htfSig !== null && htfSig !== 'NEUTRAL';
    const l2Agrees = (l1Bull && l2Bull) || (l1Bear && l2Bear);

    // ── LAYER 3: A/D Breadth ──────────────────────────────────────────────────
    const br       = marketState.breadth;
    const adRatio  = br?.adRatio   ?? null;  // advances/declines ratio
    const adSig    = br?.breadthSignal ?? null; // 'BULLISH'|'BEARISH'|'NEUTRAL'
    const adPct    = br?.breadthPct ?? 50;
    const l3Bull   = adSig === 'BULLISH' || adRatio >= 1.5;
    const l3Bear   = adSig === 'BEARISH' || adRatio <= 0.7;
    const l3Available = adRatio !== null;
    const l3Agrees = (l1Bull && l3Bull) || (l1Bear && l3Bear);

    // ── LAYER 4: PCR zone (soft gate — informs strength label, not a blocker) ─
    const pcr       = marketState.pcr;
    const pcrSig    = marketState.pcrSignal;  // 'BULLISH'|'BEARISH'|'NEUTRAL'
    const atmPcr    = marketState.atmPcr;
    const pcrBull   = pcrSig === 'BULLISH' || pcr > 1.0;
    const pcrBear   = pcrSig === 'BEARISH' || pcr < 0.8;
    const pcrAgrees = (l1Bull && pcrBull) || (l1Bear && pcrBear);

    // ── VIX risk gate ─────────────────────────────────────────────────────────
    const vix       = marketState.vix;
    const vixHigh   = vix && vix > 20;  // >20 = chaotic, skip trade

    // ── MTF detail lines for message ─────────────────────────────────────────
    const rsi5m    = mtf5m?.rsi   != null ? mtf5m.rsi.toFixed(1)   : '--';
    const rsi15m   = mtf15m?.rsi  != null ? mtf15m.rsi.toFixed(1)  : '--';
    const adx5m    = mtf5m?.adx   != null ? mtf5m.adx.toFixed(1)   : '--';
    const adx15m   = mtf15m?.adx  != null ? mtf15m.adx.toFixed(1)  : '--';

    // ── Formatted values ──────────────────────────────────────────────────────
    const atmStrike = Math.round(nifty / 50) * 50;
    const vwapFmt   = vwap.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const ema9Fmt   = ema9.toFixed(2);
    const ema21Fmt  = ema21.toFixed(2);
    const niftyFmt  = nifty.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const pcrFmt    = pcr   ? `PCR: ${pcr} (${pcrSig})` : 'PCR: --';
    const atmFmt    = atmPcr? `ATM PCR: ${atmPcr}` : '';
    const vixFmt    = vix   ? `VIX: ${vix} ${vixHigh ? '⚠️ HIGH' : '✅'}` : 'VIX: --';
    const adFmt     = adRatio != null
                    ? `A/D: ${br.advances}↑/${br.declines}↓ Ratio:${adRatio} (${adSig ?? 'NEUTRAL'})`
                    : 'A/D: Fetching...';
    const htfLabel  = (mtf15mSig && mtf15mSig !== 'INSUFFICIENT') ? `15m:${htfSig}` : `5m:${htfSig}`;

    // ── Determine overall setup quality ──────────────────────────────────────
    const layers    = [l1Aligned && l1Confirmed, l2Agrees && l2Available, l3Agrees && l3Available].filter(Boolean).length;
    // STRONG = all 3 layers agree + PCR confirms + 5m EMA confirms 1m
    const isStrong  = l1Aligned && l1Confirmed && l2Agrees && l3Agrees && pcrAgrees;
    // VALID  = Layer1 + Layer2 agree (Layer3 may be unavailable early)
    const isValid   = l1Aligned && (l2Agrees || !l2Available);
    // Direction
    const isBull    = l1Bull;

    ema920AlertSentToday = true;

    // ── VIX BLOCK — market too chaotic to trade ────────────────────────────────
    if (vixHigh) {
        await sendRawMessage(
`⛔ <b>VARDAAN 9:20 SETUP — BLOCKED (HIGH VIX)</b>

${vixFmt} — Market too volatile for opening trade
${pcrFmt}
${adFmt}

❌ <b>Skip today's opening trade — wait for VIX < 20</b>
💡 Re-evaluate at 10:30 AM if VIX stabilises`);
        console.log(`📱 [9:20] BLOCKED — VIX ${vix} > 20`);
        return;
    }

    // ── NO TRADE — 1m not aligned ────────────────────────────────────────────
    if (!l1Aligned) {
        const pricePos = priceAbove ? 'ABOVE' : 'BELOW';
        const ema9pos  = ema9Above  ? 'above' : 'below';
        const ema21pos = ema21Above ? 'above' : 'below';
        await sendRawMessage(
`⚪ <b>VARDAAN 9:20 SETUP — NO TRADE</b>

⚠️ Mixed 1m signals — price and EMAs not aligned
Price (${niftyFmt}) is ${pricePos} VWAP (${vwapFmt})
EMA9 (${ema9Fmt}) is ${ema9pos} VWAP
EMA21 (${ema21Fmt}) is ${ema21pos} VWAP

📊 <b>Higher TF (${htfLabel ?? 'N/A'})</b>
5m RSI: ${rsi5m} | 15m RSI: ${rsi15m}
${adFmt}
${pcrFmt} | ${vixFmt}

❌ <b>Skip — EMAs split across VWAP, no directional edge</b>
💡 Wait for 10:30 AM cleaner setup or sit out`);
        console.log(`📱 [9:20] NO TRADE | mixed 1m: price${priceAbove?'↑':'↓'} ema9${ema9Above?'↑':'↓'} ema21${ema21Above?'↑':'↓'}`);
        return;
    }

    // ── 1m aligned but CONFLICTS with higher TF ──────────────────────────────
    if (l2Available && !l2Agrees) {
        const dir = isBull ? 'BULLISH' : 'BEARISH';
        const opp = isBull ? 'BEARISH' : 'BULLISH';
        await sendRawMessage(
`🟡 <b>VARDAAN 9:20 SETUP — CONFLICT (SKIP)</b>

1m signals ${dir} but ${htfLabel} is ${opp}
Price (${niftyFmt}) ${isBull?'ABOVE':'BELOW'} VWAP (${vwapFmt})
EMA9: ${ema9Fmt} | EMA21: ${ema21Fmt}

📊 <b>Higher TF (${htfLabel})</b>
5m RSI: ${rsi5m} ADX: ${adx5m}
15m RSI: ${rsi15m} ADX: ${adx15m}
${adFmt}
${pcrFmt} | ${vixFmt}

⚠️ <b>1m and higher TF disagree — HIGH RISK, skip trade</b>
💡 Opening moves that fight the 15m trend fail 70% of the time`);
        console.log(`📱 [9:20] CONFLICT | 1m:${isBull?'BULL':'BEAR'} vs HTF:${htfSig}`);
        return;
    }

    // ── VALID TRADE — build strength label ───────────────────────────────────
    const l1ConfirmNote = !l1Confirmed ? '\n⚠️ 5m EMA/VWAP contradicts 1m — reduce size' : '';
    const strengthLabel = isStrong ? '🔥 STRONG SETUP (4/4 layers)' :
                          layers >= 2 ? `✅ GOOD SETUP (${layers}/4 layers)${l1ConfirmNote}` :
                          `⚠️ WEAK SETUP (${layers}/4 layers) — reduce size${l1ConfirmNote}`;
    const adConfirm  = l3Agrees  ? `✅ A/D ${isBull?'Bullish':'Bearish'} — ${br.advances}↑/${br.declines}↓`
                     : l3Available ? `⚠️ A/D Mixed — ${br.advances}↑/${br.declines}↓ (watch)`
                     : `⏳ A/D not yet available`;
    const pcrConfirm = pcrAgrees  ? `✅ ${pcrFmt}` : `⚠️ ${pcrFmt} (contra — reduce size)`;
    const htfConfirm = l2Agrees   ? `✅ ${htfLabel} — confirms direction`
                     : !l2Available ? `⏳ HTF warming up — 1m only`
                     : `⚠️ ${htfLabel}`;

    if (isBull) {
        await sendRawMessage(
`🟢 <b>VARDAAN 9:20 SETUP — CALL BUY</b>
${strengthLabel}

<b>Layer 1 — 1m Price + EMA vs VWAP:</b>
✅ Price (${niftyFmt}) ABOVE VWAP (${vwapFmt})
✅ EMA9 (${ema9Fmt}) ABOVE VWAP
✅ EMA21 (${ema21Fmt}) ABOVE VWAP

<b>Layer 2 — Higher TF:</b>
${htfConfirm}
5m RSI: ${rsi5m} ADX: ${adx5m} | 15m RSI: ${rsi15m} ADX: ${adx15m}

<b>Layer 3 — A/D Breadth:</b>
${adConfirm}

<b>Layer 4 — Options Flow:</b>
${pcrConfirm}${atmFmt ? '\n' + atmFmt : ''}
${vixFmt}

🎯 <b>Action: BUY ${atmStrike} CE (ATM)</b>
💰 Target: +25–30% premium gain
🛑 Stop Loss: −20% premium loss
⏰ Time Stop: Exit by 11:00 AM

⚠️ <b>1 TRADE ONLY TODAY — No revenge trading</b>`);
        console.log(`📱 [9:20] CALL SETUP | ${strengthLabel} | HTF:${htfSig} | A/D:${adRatio} | PCR:${pcr}`);
    } else {
        await sendRawMessage(
`🔴 <b>VARDAAN 9:20 SETUP — PUT BUY</b>
${strengthLabel}

<b>Layer 1 — 1m Price + EMA vs VWAP:</b>
✅ Price (${niftyFmt}) BELOW VWAP (${vwapFmt})
✅ EMA9 (${ema9Fmt}) BELOW VWAP
✅ EMA21 (${ema21Fmt}) BELOW VWAP

<b>Layer 2 — Higher TF:</b>
${htfConfirm}
5m RSI: ${rsi5m} ADX: ${adx5m} | 15m RSI: ${rsi15m} ADX: ${adx15m}

<b>Layer 3 — A/D Breadth:</b>
${adConfirm}

<b>Layer 4 — Options Flow:</b>
${pcrConfirm}${atmFmt ? '\n' + atmFmt : ''}
${vixFmt}

🎯 <b>Action: BUY ${atmStrike} PE (ATM)</b>
💰 Target: +25–30% premium gain
🛑 Stop Loss: −20% premium loss
⏰ Time Stop: Exit by 11:00 AM

⚠️ <b>1 TRADE ONLY TODAY — No revenge trading</b>`);
        console.log(`📱 [9:20] PUT SETUP | ${strengthLabel} | HTF:${htfSig} | A/D:${adRatio} | PCR:${pcr}`);
    }
}

async function checkTelegramAlerts(newSignal) {
    if (!isConfigured()||!isMarketOpen()) return;
    // ── Race-condition guard: onTick fires synchronously on every websocket tick,
    //    so multiple concurrent calls can pass a flag check before any one of them
    //    sets the flag. This in-flight lock ensures only one alert send runs at a time.
    if (telegramAlertInFlight) return;
    telegramAlertInFlight = true;
    try {
    const ist=getIST(), h=ist.getHours(), m=ist.getMinutes();
    if (h===9&&m>=16&&m<=20&&!morningSummarySent&&marketState.nifty>0) { morningSummarySent=true; await sendMorningSummary(marketState); return; }
    if (h===14&&m===0&&!nishanebaazAlertSent&&marketState.nifty>0) { nishanebaazAlertSent=true; await sendNishanebaazAlert(marketState); }
    if (h===15&&m>=30&&!closeSummarySent) {
        closeSummarySent=true;
        marketState.sessionOpenPrice = _sessionOpenPrice; // expose for accurate day-change calc
        await sendCloseSummary(marketState);
        setTimeout(() => {
            morningSummarySent=false; closeSummarySent=false; vixAlertSent=false;
            nishanebaazAlertSent=false; pcrClearedToday=false; btstSentToday=false;
            telegramAlertInFlight=false; ema920AlertSentToday=false;
            // Reset intraday trades so yesterday's trades don't show on next morning's fresh session
            trades = [];
            console.log('[Daily Reset] Intraday trades cleared for next session');
        }, 6*60*60*1000); // 6 hours after close = ~21:30 IST
        return;
    }
    // ── BTST/STBT Telegram alert — fires once in 3:00–3:20 window if signal passed ──
    if (!btstSentToday && marketState.btst?.passed) {
        btstSentToday = true;
        const b = marketState.btst;
        const emoji = b.type === 'BTST' ? '🟢' : '🔴';
        const msg = [
            `${emoji} *${b.type} SIGNAL DETECTED*`,
            ``,
            `📌 *${b.signal}* | Strike: *${b.strike}*`,
            `💪 Confidence: ${b.confidence}%`,
            `📊 PCR: ${b.pcr ?? '--'} | VIX: ${b.vix ?? '--'}`,
            `📈 15m: ${b.mtf15m} | 1h: ${b.mtf1h}`,
            `🌍 Global: ${b.globalBias}`,
            ``,
            `⏰ Window: ${b.window}`,
            `🎯 Exit: ${b.exitTarget}`,
            `⚠️ Risk: ${b.risk}`,
            ``,
            `_Informational only — verify manually before taking position_`
        ].join('\n');
        try {
            await sendRawMessage(msg);
            console.log(`🌙 [BTST] Telegram alert sent — ${b.type} ${b.signal} ${b.strike}`);
        } catch(e) { console.error('[BTST] Telegram error:', e.message); }
    }
    // Gate signal-changed alerts to market hours (9:15–15:30) only.
    // On container restart Yahoo data can make TFs look aligned instantly,
    // causing spurious SIGNAL CHANGED alerts at 3–8 AM before market opens.
    // Also require minimum 15-point price move from last fired level to prevent
    // rapid-fire duplicates when Nifty oscillates within a tight range (9:58 AM bug).
    const sigIst  = getIST();
    const sigMins = sigIst.getHours() * 60 + sigIst.getMinutes();
    const sigInMarketHours  = sigMins >= 555 && sigMins <= 930;
    const sigPriceMoved     = Math.abs((marketState.nifty || 0) - lastSignalFiredPrice) >= 15;
    if (newSignal!==prevSignal&&newSignal!=='WAIT'&&sigInMarketHours&&sigPriceMoved) {
        // Compute strikeData BEFORE sending alert so SL/Target appear in the message
        let strikeDataForAlert = null;
        try {
            const pcrState = getPCRState();
            strikeDataForAlert = pickStrikeAndPremium(newSignal, marketState.nifty, marketState.vix, pcrState);
            if (strikeDataForAlert) strikeDataForAlert.coach = buildTradeCoach(strikeDataForAlert);
        } catch(e) { console.warn('[Strike] compute error:', e.message); }

        if (strikeDataForAlert) {
            startSignalPerformance(newSignal, strikeDataForAlert).catch(e => console.warn('[SignalPerf] start error:', e.message));
        }

        await sendSignalAlert(marketState, prevSignal, strikeDataForAlert);
        lastSignalFiredPrice = marketState.nifty || 0;

        // ── Trigger AI suggestion on fresh signal (costs 1 API call here only) ──
        if (marketState.qualityGate.passed && strikeDataForAlert) {
            try {
                const winRate = await getWinRateFromHistory(strikeDataForAlert.type);
                await getAITradeSuggestion(marketState, strikeDataForAlert, winRate);
                console.log(`🤖 AI suggestion triggered by fresh signal: ${newSignal}`);
            } catch(e) { console.error('AI on signal trigger:', e.message); }
        }
    }
    // MTF alert cooldown: 60 min between same-direction alerts.
    // Also gated to actual market hours (9:15–15:30) only — prevents pre-market
    // spam on container restart when Yahoo data makes all TFs look aligned.
    //
    // BUG FIX (found in logs): the old condition `(!prevMTFAligned || mtfCooldownOk)`
    // let ANY aligned→false→aligned flicker bypass the cooldown entirely, even
    // seconds after the last alert. Since `oneHourLagging` toggles aligned on/off
    // as 1H data updates, this fired alerts every ~12 min instead of every 60 min
    // (seen in logs: 6:16, 6:28, 6:48, 7:02, 7:14, 7:26, 7:32 — all within cooldown).
    // Fix: cooldown is now absolute — only a genuine signal-type change (CALL↔PUT)
    // or 60 min elapsed can fire a new alert, regardless of aligned flicker.
    const MTF_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
    const mtfSignalNow  = marketState.mtf?.signal || '';
    const mtfIst        = getIST();
    const mtfMins       = mtfIst.getHours() * 60 + mtfIst.getMinutes();
    const mtfInWindow   = mtfMins >= 555 && mtfMins <= 930;  // 9:15–15:30 only
    const mtfTimeOk     = (Date.now() - lastMTFAlertAt) > MTF_ALERT_COOLDOWN_MS;
    const mtfSignalChanged = mtfSignalNow !== '' && mtfSignalNow !== lastMTFAlertSignal && lastMTFAlertSignal !== '';
    const mtfNeverFired = lastMTFAlertAt === 0;
    const mtfCooldownOk = mtfTimeOk || mtfSignalChanged || mtfNeverFired;

    // ── Reversal-persistence check (soft, ~10 min) — see notes at variable decl ──
    // A "reversal" here means mtfSignalChanged is the ONLY reason cooldown passed
    // (i.e. mtfTimeOk is false — we're still within the normal 60-min window and
    // would have been blocked, except the direction flipped). That's exactly the
    // whipsaw case. If mtfTimeOk is already true, or this is the day's first
    // alert, there's nothing to hold back — let it through immediately as before.
    const mtfIsReversalBypass = mtfSignalChanged && !mtfTimeOk && !mtfNeverFired;
    let mtfReversalConfirmed = true;
    if (mtfIsReversalBypass) {
        const now = Date.now();
        if (pendingMTFFlipSignal !== mtfSignalNow) {
            // New flip candidate — start the confirmation clock, hold this alert back.
            pendingMTFFlipSignal = mtfSignalNow;
            pendingMTFFlipSince = now;
            mtfReversalConfirmed = false;
        } else if (now - pendingMTFFlipSince < MTF_REVERSAL_CONFIRM_MS) {
            mtfReversalConfirmed = false;
        } else {
            // Persisted past the confirm window — genuine flip, let it through.
            pendingMTFFlipSignal = null; pendingMTFFlipSince = 0;
        }
    } else {
        // Not a reversal-bypass case — clear any stale pending flip tracker.
        pendingMTFFlipSignal = null; pendingMTFFlipSince = 0;
    }

    if (marketState.mtf.aligned && mtfInWindow && mtfCooldownOk && mtfReversalConfirmed) {
        let mtfStrikeData = null;
        try {
            const pcrStateMtf = getPCRState();
            mtfStrikeData = pickStrikeAndPremium(marketState.mtf.signal, marketState.nifty, marketState.vix, pcrStateMtf);
            if (mtfStrikeData) mtfStrikeData.coach = buildTradeCoach(mtfStrikeData);
        } catch(e) { console.warn('[MTF Strike] compute error:', e.message); }
        await sendMTFAlert(marketState, mtfStrikeData);
        lastMTFAlertAt     = Date.now();
        lastMTFAlertSignal = mtfSignalNow;
    }
    prevMTFAligned = marketState.mtf.aligned;
    if (marketState.vix>20&&!vixAlertSent) { vixAlertSent=true; await sendVIXAlert(marketState.vix,marketState.vixNote); }
    if (marketState.vix<=20) vixAlertSent=false;

    // ── Spread / Hedging Strategy Alert ──────────────────────────────────────
    // Fires when market conditions warrant a spread trade instead of naked buy.
    // Cooldown: once per 60 min, only during market hours, no repeat of same strategy.
    const spreadIst  = getIST();
    const spreadMins = spreadIst.getHours() * 60 + spreadIst.getMinutes();
    const spreadInHours = spreadMins >= 555 && spreadMins <= 900; // 9:15–15:00
    const spreadCooldownOk = (Date.now() - lastSpreadAlertAt) > 60 * 60 * 1000;
    if (spreadInHours && spreadCooldownOk) {
        try {
            const spread = suggestSpreadStrategy(marketState);
            if (spread && spread.strategy !== lastSpreadStrategy) {
                await sendSpreadAlert(spread, marketState);
                lastSpreadAlertAt  = Date.now();
                lastSpreadStrategy = spread.strategy;
                console.log(`📊 Spread alert sent: ${spread.strategy}`);
            }
        } catch(e) { console.error('[Spread] alert error:', e.message); }
    }
    } catch(e) {
        // Without this catch, any thrown error here (e.g. accessing a property on an
        // undefined marketState field inside one of the message templates) propagated
        // silently all the way up through updatePrice() with ZERO console output —
        // looked exactly like "nothing happened" even though a signal change occurred.
        console.error('❌ checkTelegramAlerts crashed:', e.message, '| newSignal:', newSignal, '\n', e.stack);
    } finally {
        telegramAlertInFlight = false;
    }
}

async function updatePrice(price, change, changePct, source) {
    // ── Track today's session-open price (independent of WS OHLC, which is
    // always 0 for the Nifty index). Reset once per IST calendar day so the
    // Close Summary's day-change calculation is always accurate.
    const _todayIst = getIST().toISOString().slice(0,10);
    if (_sessionOpenDate !== _todayIst && price > 0) {
        _sessionOpenDate  = _todayIst;
        _sessionOpenPrice = price;
        console.log(`[Session] New day open captured: ₹${price}`);
    }

    const indicators=processIndicators(price, marketState.global?.bankNiftyLeadSignal ?? null);
    let { signal, confidence, reasons }=combineSignals(indicators);

    // ── Trend Lock — block instant CALL↔PUT reversals until confirmed ────────
    // Only applies to a FULL direction reversal (the last CONFIRMED directional
    // signal and the new signal are opposite non-WAIT directions). WAIT→CALL,
    // WAIT→PUT, and a signal simply re-confirming its own direction are NOT
    // reversals — those pass through immediately as before.
    // NOTE: compares against lastDirectionalSignal, NOT prevSignal — prevSignal
    // gets set to 'WAIT' below while a reversal is pending/locked, which would
    // otherwise reset the comparison and let the very next cycle bypass the lock.
    const isReversal = signal !== 'WAIT' && lastDirectionalSignal !== 'WAIT' && signal !== lastDirectionalSignal;
    if (isReversal) {
        const now = Date.now();
        if (pendingFlipSignal !== signal) {
            // New reversal candidate — start the confirmation clock, hold at WAIT.
            pendingFlipSignal = signal;
            pendingFlipSince  = now;
            reasons.push(`🔒 Trend Lock: ${signal} reversal detected but not yet confirmed — holding ${lastDirectionalSignal} for up to ${TREND_LOCK_MS/60000} min`);
            signal = 'WAIT'; confidence = 0;
        } else if (now - pendingFlipSince < TREND_LOCK_MS) {
            // Same reversal candidate, still within the lock window — keep holding.
            const remainMin = Math.ceil((TREND_LOCK_MS - (now - pendingFlipSince)) / 60000);
            reasons.push(`🔒 Trend Lock: ${signal} reversal pending confirmation (~${remainMin} min left) — holding ${lastDirectionalSignal}`);
            signal = 'WAIT'; confidence = 0;
        } else {
            // Persisted past the lock window — confirmed, let it through.
            reasons.push(`🔓 Trend Lock: ${signal} reversal confirmed after ${TREND_LOCK_MS/60000} min — flip allowed`);
            pendingFlipSignal = null; pendingFlipSince = 0;
        }
    } else if (pendingFlipSignal !== null && signal !== pendingFlipSignal) {
        // The reversal candidate stopped reappearing (flickered back) — clear it,
        // this was noise, not a genuine trend change.
        pendingFlipSignal = null; pendingFlipSince = 0;
    }
    // Update the confirmed-direction tracker: only advances on a genuine non-WAIT
    // signal that made it through the lock above (still non-WAIT after locking).
    if (signal !== 'WAIT' && signal !== lastDirectionalSignal) signalSince = Date.now();
    if (signal !== 'WAIT') lastDirectionalSignal = signal;
    // ── Signal Age — how long the CURRENT directional signal has been active ──
    // Per feedback: helps a trader avoid entering very late into a signal that's
    // already run most of its course. WAIT has no meaningful "age".
    marketState.signalAge = (signal !== 'WAIT' && signalSince > 0)
        ? { seconds: Math.floor((Date.now() - signalSince) / 1000), label: null }
        : { seconds: 0, label: null };
    if (marketState.signalAge.seconds > 0) {
        const mins = Math.floor(marketState.signalAge.seconds / 60);
        marketState.signalAge.label = mins < 1 ? 'Just now' : `${mins} min`;
    }

    marketState.prevNifty = marketState.nifty || price;
    marketState.nifty=price; marketState.lastClose=price; marketState.change=change; marketState.changePct=changePct; marketState.marketClosed=false;
    // Push live tick to SSE clients (throttled — max 1 push per second)
    const _now = Date.now();
    if (!global._lastSsePush || _now - global._lastSsePush > 1000) {
        global._lastSsePush = _now;
        sseBroadcast('tick', { nifty: price, change, changePct, ts: _now });
    }
    marketState.signal=signal; marketState.confidence=confidence;
    // Derive strength from confidence so the frontend badge is meaningful
    marketState.strength = signal === 'WAIT' ? 'WEAK'
                         : confidence >= 75   ? 'STRONG'
                         : confidence >= 65   ? 'MODERATE'
                         :                      'WEAK';
    // ── Trade Quality grade — simple, glanceable position-sizing guide ────────
    // Per feedback: a bare "Confidence: 65%" number doesn't tell a trader how
    // much size to put on. A letter grade with a suggested size multiplier is
    // faster to act on, especially on mobile mid-session.
    marketState.tradeQuality = signal === 'WAIT' ? { grade: '—', sizeHint: 'No trade', pct: 0 }
                             : confidence >= 80   ? { grade: 'A+', sizeHint: 'Full size',    pct: 100 }
                             : confidence >= 70   ? { grade: 'A',  sizeHint: '75% size',      pct: 75  }
                             : confidence >= 60   ? { grade: 'B',  sizeHint: '50% size',      pct: 50  }
                             : confidence >= 50   ? { grade: 'C',  sizeHint: '25% size',      pct: 25  }
                                                  : { grade: 'D',  sizeHint: 'Skip — too weak',pct: 0  };
    marketState.rsi=indicators.rsi; marketState.ema9=indicators.ema9;
    marketState.ema21=indicators.ema21; marketState.vwap=indicators.vwap;
    marketState.reason=reasons; marketState.lastUpdated=new Date().toISOString();
    // ── NO TRADE mode — concise digest for WAIT states ────────────────────────
    // Per feedback: "Avoiding bad trades often improves results more than
    // finding extra good trades." A bare "WAIT" with a wall of technical
    // reasons is hard to scan; surface the 3 most decision-relevant ones.
    if (signal === 'WAIT') {
        // Prioritize gate-block reasons (⛔) and lock/structural reasons (🔒) —
        // these are WHY no trade is happening, not just background context.
        const priority = reasons.filter(r => r.startsWith('⛔') || r.startsWith('🔒'));
        const rest      = reasons.filter(r => !priority.includes(r));
        marketState.noTrade = {
            active : true,
            reasons: [...priority, ...rest].slice(0, 3).map(r => r.replace(/^[⛔🔒⏳]\s*/, '')),
        };
    } else {
        marketState.noTrade = { active: false, reasons: [] };
    }

    // ── Market Health Score (0-100) ───────────────────────────────────────────
    // Per feedback: "Instead of watching 10 different indicators, users can
    // understand the overall market condition at a glance." Aggregates trend
    // strength, momentum, volume conviction, options positioning, and breadth
    // into one number + sub-scores, independent of which direction (CALL/PUT)
    // is currently favored — this measures HOW STRONG the prevailing move is,
    // not which side to trade.
    try {
        // Trend /25 — ADX strength + MTF alignment
        let trendScore = 0;
        const adxV = marketState.adx?.adx ?? null;
        if (adxV !== null) trendScore += Math.min((adxV / 40) * 15, 15); // ADX contributes up to 15
        if (marketState.mtf?.aligned) trendScore += 10;
        else if (marketState.mtf?.bullCount === 2 || marketState.mtf?.bearCount === 2) trendScore += 5;

        // Momentum /20 — breakdown/breakout detector strength
        let momentumScore = 0;
        const momS = marketState.momentum;
        if (momS?.canTrade) momentumScore = Math.min((momS.strength / 4) * 20, 20);
        else momentumScore = 8; // baseline — no strong momentum either way isn't "unhealthy", just quiet

        // Volume /20 — order-flow delta conviction (magnitude, not direction)
        let volumeScore = 8; // baseline
        const deltaAbs = Math.abs(marketState.delta?.deltaPct ?? 0);
        if (deltaAbs > 0) volumeScore = Math.min(8 + (deltaAbs / 50) * 12, 20);

        // Options Flow /20 — PCR extremity + optionFlow dominance clarity
        let optionsScore = 8;
        if (marketState.pcr !== null) {
            const pcrExtremity = Math.min(Math.abs(marketState.pcr - 1) * 20, 12);
            optionsScore = 8 + pcrExtremity;
        }
        if (marketState.optionFlow?.dominance && marketState.optionFlow.dominance !== 'NEUTRAL') optionsScore = Math.min(optionsScore + 4, 20);

        // Breadth /15 — advance/decline clarity
        let breadthScore = 6;
        const br2 = marketState.breadth;
        if (br2?.breadthSignal === 'BULLISH' || br2?.breadthSignal === 'BEARISH') {
            const total = (br2.advances || 0) + (br2.declines || 0);
            const clarity = total > 0 ? Math.abs((br2.advances - br2.declines) / total) : 0;
            breadthScore = 6 + clarity * 9;
        }

        const healthTotal = Math.round(trendScore + momentumScore + volumeScore + optionsScore + breadthScore);
        // Bias direction for the label — bull/bear vote tally isn't accessible here
        // (it's local to combineSignals()), so use MTF bull/bear counts as the proxy.
        const biasIsBull = (marketState.mtf?.bullCount ?? 0) >= (marketState.mtf?.bearCount ?? 0);
        const healthLabel = healthTotal >= 80 ? (biasIsBull ? 'Strong Bullish Trend' : 'Strong Bearish Trend')
                           : healthTotal >= 60 ? (biasIsBull ? 'Moderate Bullish Bias' : 'Moderate Bearish Bias')
                           : healthTotal >= 40 ? 'Choppy / Mixed'
                           :                     'Weak / Avoid Trading';

        marketState.marketHealth = {
            total: Math.min(healthTotal, 100),
            trend: Math.round(trendScore), trendMax: 25,
            momentum: Math.round(momentumScore), momentumMax: 20,
            volume: Math.round(volumeScore), volumeMax: 20,
            optionsFlow: Math.round(optionsScore), optionsFlowMax: 20,
            breadth: Math.round(breadthScore), breadthMax: 15,
            label: healthLabel,
        };
    } catch (e) {
        console.warn('[MarketHealth] error:', e.message);
    }
    marketState.connected=true; marketState.source=source; marketState.dataPoints=indicators.priceCount;
    marketState.candleSource=getCandleSource();
    // ── Smart Money Bias ──────────────────────────────────────────────────────
    marketState.smartMoney = computeSmartMoneyBias();
    // ── POC + Delta — computed from today's session candles ───────────────────
    // Run on every price tick so qualityGate and Telegram can use fresh values.
    // computePOC/Delta read getSessionCandles() internally — no extra args needed.
    try { marketState.poc   = computePOC();   } catch(e) { console.warn('[POC] error:', e.message); }
    // Only run candle-body proxy delta when neither WS nor Fyers has provided
    // real volume data yet. Priority: websocket (true buy/sell qty, when Angel
    // sends it for non-index tokens) > fyers (volume-weighted range-position
    // proxy, real session volume) > candle-body proxy (weakest signal, only
    // used when neither live source is available).
    const _deltaSrc = marketState.delta?.source ?? '';
    if (_deltaSrc !== 'websocket' && _deltaSrc !== 'fyers') {
        try { marketState.delta = computeDelta(); } catch(e) { console.warn('[Delta] error:', e.message); }
    }
    // ── Trend Day vs Range Day + Trap Zone — informational strategy guidance ──
    try { marketState.dayType  = computeDayType();  } catch(e) { console.warn('[DayType] error:', e.message); }
    try { marketState.trapZone = computeTrapZone(); } catch(e) { console.warn('[TrapZone] error:', e.message); }
    try { marketState.confidenceBreakdown = computeConfidenceBreakdown(); } catch(e) { console.warn('[ConfBreakdown] error:', e.message); }
    if (source==='yahoo') console.log(`NIFTY:${price} RSI:${indicators.rsi||'--'} → ${signal}(${confidence}%) | POC:${marketState.poc?.poc??'--'} Delta:${marketState.delta?.deltaPct??'--'}%`);
    evaluateBTST();
    await checkTelegramAlerts(signal);
    // ── Auto-log every fresh BUY CALL / BUY PUT transition to signal_log ─────
    // Runs silently — does NOT block the signal pipeline. Captures full snapshot
    // (RSI, VIX, PCR, ADX, MTF, quality gate) for later review / pattern mining.
    if (signal !== 'WAIT' && signal !== prevSignal) {
        saveSignalToLog(signal, prevSignal).catch(e => console.error('signal log:', e.message));
    }
    prevSignal=signal;
}

// ── 1-min Yahoo price poller — fixes price freeze on Yahoo fallback ──────────
// refreshMarketData() runs every 3 min — too slow for frontend display.
// This poller fetches ONLY spot price every 60s so frontend sees fresh values.
// Skips automatically when Angel One WS is actively ticking.
async function pollYahooPrice() {
    // FIX: extended to 8:00 AM - 4:00 PM (not just isMarketOpen 9:15-15:30) so
    // that once the watchdog flips source to 'yahoo' on a pre/post-market stale
    // tick, this function can actually run and refresh the price. Previously
    // both used the same narrow window, so a stale tick outside 9:15-15:30
    // never got corrected until the next isMarketOpen() tick — hence the
    // multi-hour freeze seen in logs (24,094.80 stuck 5:17-7:32 AM).
    const ist  = getIST();
    const mins = ist.getHours() * 60 + ist.getMinutes();
    if (mins < 480 || mins > 960) return; // 8:00 AM – 4:00 PM
    if (marketState.source === 'websocket' && (Date.now() - _lastTickAt) < 90_000) return;
    try {
        const data = await fetchMarketData();
        if (data?.niftyData?.price > 0) {
            const p = data.niftyData.price;
            const change    = data.niftyData.change    ?? marketState.change;
            const changePct = data.niftyData.changePct ?? marketState.changePct;
            // BUG FIX: old code only patched nifty/change/changePct — skipped the full
            // indicator pipeline (EMA9/EMA21/RSI/VWAP/signal). So between 3-min refreshes
            // the signal, RSI, confidence were frozen at stale values while price showed live.
            // Now calls updatePrice() exactly like the WS tick handler does.
            await updatePrice(p, change, changePct, 'yahoo');
            console.log(`[Yahoo 1m] NIFTY: ${p}`);
        }
    } catch(e) { /* silent — non-critical */ }
}

// ── WebSocket tick watchdog ───────────────────────────────────────────────────
// Angel One WS sometimes goes silent (no ticks, no close event) during market
// hours — Railway sees it as "connected" but price freezes. Watchdog detects
// this: if no tick arrives for 3 min during market hours, reset source to
// 'yahoo' so refreshMarketData() starts updating price via Yahoo fallback.
let _lastTickAt = 0;
let _wsWatchdog  = null;

function startTickWatchdog() {
    if (_wsWatchdog) clearInterval(_wsWatchdog);
    _wsWatchdog = setInterval(() => {
        // FIX: previously gated by isMarketOpen() (9:15-15:30 only), so a stale
        // WS tick received just before/after market hours never got flagged —
        // price stayed frozen for hours (seen in logs: 24,094.80 frozen 5:17-7:32 AM).
        // Now checks during extended pre/post-market window (8:00-16:00) so any
        // leftover stale tick from yesterday's session or a phantom reconnect
        // gets caught and source falls back to Yahoo immediately.
        const ist  = getIST();
        const mins = ist.getHours() * 60 + ist.getMinutes();
        const inExtendedWindow = mins >= 480 && mins <= 960; // 8:00 AM – 4:00 PM
        if (!inExtendedWindow) return;
        const silentMs = Date.now() - _lastTickAt;
        if (_lastTickAt > 0 && silentMs > 3 * 60 * 1000 && marketState.source === 'websocket') {
            console.warn(`⚠️ [WS Watchdog] No tick for ${Math.round(silentMs/1000)}s — switching to Yahoo fallback`);
            marketState.source    = 'yahoo';
            marketState.connected = false;
        }
    }, 30 * 1000); // check every 30s
}

let _lastIndicatorRun = 0;  // throttle: only recalculate indicators once per second

async function onTick(tickData) {
    const price=tickData.price; if(!price||price<=0) return;

    // ── Sanity check: reject ticks that are >5% away from last known price ────
    // Prevents wrong-offset prices (sequence numbers misread as LTP) from
    // corrupting ADX/VWAP/EMA calculations. If last price is unknown, accept.
    //
    // BOOTSTRAP FIX: On startup, marketState.nifty holds yesterday's close
    // (loaded from DB/cache). The first live WS tick may differ by >5% (gap
    // open, circuit, or simply a different day). We skip the guard until the
    // first live tick has been accepted and marketState.nifty is updated from
    // a real tick. _wsBootstrapped is set to true after first accepted tick.
    const lastKnown = marketState.nifty;
    if (lastKnown > 0 && onTick._bootstrapped) {
        const pctMove = Math.abs((price - lastKnown) / lastKnown) * 100;
        if (pctMove > 5) {
            console.warn(`[WS] Tick rejected: ${price} is ${pctMove.toFixed(1)}% from last known ${lastKnown} — possible wrong packet offset`);
            return;
        }
    }
    if (!onTick._bootstrapped) {
        console.log(`[WS] Bootstrap tick accepted: ₹${price} (was: ${lastKnown || 'none'}) — guard active from next tick`);
        onTick._bootstrapped = true;
    }

    _lastTickAt = Date.now();  // update watchdog timestamp on every tick

    // ── Mode 2 fields — store live OHLCV + buy/sell qty from WS tick ─────────
    // volume  = session cumulative volume (resets each day at 9:15)
    // buyQty  = total buy orders at market  → buying pressure
    // sellQty = total sell orders at market → selling pressure
    // Delta from WS = buyQty - sellQty (real order flow, much better than candle-body proxy)
    if (tickData.volume  > 0) marketState.wsVolume  = tickData.volume;
    if (tickData.buyQty  > 0) marketState.wsBuyQty  = tickData.buyQty;
    if (tickData.sellQty > 0) marketState.wsSellQty = tickData.sellQty;
    if (tickData.open    > 0) marketState.wsOpen    = tickData.open;
    if (tickData.high    > 0) marketState.wsHigh    = tickData.high;
    if (tickData.low     > 0) marketState.wsLow     = tickData.low;

    // ── Real-time Delta from live WS buy/sell qty ─────────────────────────────
    // Override computeDelta() candle-body proxy when WS gives real order flow data.
    // wsDelta > 0 = more buy orders = bullish pressure
    // wsDelta < 0 = more sell orders = bearish pressure
    // Divergence: price making new session high but wsDelta trending negative = trap
    if (tickData.buyQty > 0 && tickData.sellQty > 0) {
        const total     = tickData.buyQty + tickData.sellQty;
        const wsDelta   = tickData.buyQty - tickData.sellQty;
        const deltaPct  = parseFloat(((wsDelta / total) * 100).toFixed(1));
        const signal    = deltaPct >  10 ? 'BULLISH'
                        : deltaPct < -10 ? 'BEARISH'
                        :                  'NEUTRAL';

        // Divergence: price at or near session high but sellers dominating
        const sessionHigh = marketState.wsHigh || price;
        const nearHigh    = price >= sessionHigh * 0.998;  // within 0.2% of high
        const nearLow     = price <= (marketState.wsLow || price) * 1.002;
        const divergence  = (nearHigh && deltaPct < -10) || (nearLow && deltaPct > 10);

        marketState.delta = {
            delta      : wsDelta,
            deltaPct,
            signal,
            divergence,
            divergenceLabel: divergence
                ? (nearHigh ? '⚠️ DIVERGENCE: Price near high but sellers dominating — reversal risk'
                            : '⚠️ DIVERGENCE: Price near low but buyers absorbing — bounce risk')
                : '',
            label  : `Delta:${deltaPct > 0 ? '+' : ''}${deltaPct}% (${signal}) [live WS]${divergence ? ' ⚠️' : ''}`,
            source : 'websocket',   // distinguishes from candle-body proxy
        };
    }

    // ── Throttle: update price display on every tick, but only run full ───────
    // indicator calculation (ADX/EMA/RSI/VWAP) once per second to avoid spam
    const now = Date.now();
    const runIndicators = (now - _lastIndicatorRun) >= 1000;
    if (runIndicators) _lastIndicatorRun = now;

    // ── FIX: change/changePct vs YESTERDAY'S CLOSE, not vs the last tick ─────
    // Previously: `prev = marketState.nifty` — but marketState.nifty gets
    // overwritten to the CURRENT price on every single tick (a few lines below,
    // and in updatePrice()). So on the very next tick, "change" was really just
    // (this tick − previous tick) — a few paise of noise — NOT the cumulative
    // move since yesterday's close that Telegram/header/Punch-style badge are
    // supposed to show. It only ever looked right for a moment after each 3-min
    // refreshMarketData() cycle silently overwrote it with the correct value,
    // then drifted back to near-zero on every WS tick until the next cycle.
    // Now: anchor to marketState.prevClose (yesterday's real close, captured
    // once by refreshMarketData() and static for the whole session) so every
    // tick's change is correct, all day, not just once every 3 minutes.
    const prev    = marketState.prevClose || marketState.nifty || price;
    const change  = parseFloat((price-prev).toFixed(2));
    const chgPct  = prev>0?parseFloat(((change/prev)*100).toFixed(2)):0;

    if (runIndicators) {
        await updatePrice(price,change,chgPct,'websocket');
    } else {
        // Just update price display without full indicator recalc
        marketState.nifty       = price;
        marketState.change      = change;
        marketState.changePct   = chgPct;
        marketState.lastUpdated = new Date().toISOString();
        marketState.connected   = true;
        marketState.source      = 'websocket';
        // FIX: also push tick to SSE so frontend gets realtime price updates
        // even when indicator recalc is throttled (runIndicators=false)
        if (!global._lastSsePush || now - global._lastSsePush > 1000) {
            global._lastSsePush = now;
            sseBroadcast('tick', { nifty: price, change, changePct: chgPct, ts: now });
        }
    }
}

async function refreshMarketData() {
    // FIX: previously returned here on non-trading days (weekends/holidays)
    // BEFORE ever calling fetchMarketData() — meaning marketState.prevClose
    // (and change/changePct) never got populated at all on a closed day.
    // Real broker apps (Punch, Groww, etc.) still show "vs Friday's close" on
    // a Saturday — so we still need this fetch. We just skip the LIVE-only
    // bits (indicator/history seeding, VIX, WS-dependent updates) below when
    // it's not a trading day.
    const isTradingDay = isNSEMarketDay();
    if (!isTradingDay) {
        console.log('[Scheduler] Outside market hours — refreshing prevClose/change only, skipping live indicators');
    }
    // When market is closed, preserve last known price as lastClose so the
    // frontend can show "23,382 · CLOSED" instead of blank "--".
    // FIX: no longer zeroing change/changePct here — those should keep
    // reflecting the actual last-session move vs prevClose (set below), not
    // reset to a misleading "+0 pts +0.00%".
    if (!isMarketOpen()) {
        if (marketState.nifty > 0) {
            marketState.lastClose = marketState.nifty;  // save before zeroing
            marketState.nifty     = 0;
            marketState.connected = false;
            marketState.source    = 'none';
        }
        marketState.marketClosed = true;
    } else {
        marketState.marketClosed = false;
    }
    const { niftyData, vixData }=await fetchMarketData();
    // FIX: capture the real previous-trading-day close (static, doesn't change
    // intraday) so onTick() can compute change/changePct against IT instead of
    // the last WS tick — see onTick() for why that was wrong. Also apply
    // change/changePct directly here so a closed-day restart shows the correct
    // last-session move immediately, without waiting for a live WS tick that
    // will never come today.
    if (niftyData?.prevClose > 0) marketState.prevClose = niftyData.prevClose;
    if (niftyData?.change != null)    marketState.change    = niftyData.change;
    if (niftyData?.changePct != null) marketState.changePct = niftyData.changePct;
    // FIX: on a FRESH server restart while market is closed (e.g. weekend
    // reboot), marketState.nifty starts at 0 — so the "capture before
    // zeroing" block above (`if (marketState.nifty > 0) lastClose = nifty`)
    // never fires even once, leaving lastClose stuck at 0 forever until
    // Monday's live trading. The frontend then shows blank "--" instead of
    // the frozen last price. Fall back to the freshly-fetched niftyData.price
    // (which correctly reflects the last session's close) whenever we don't
    // already have a lastClose from live memory.
    if (!isMarketOpen() && !(marketState.lastClose > 0) && niftyData?.price > 0) {
        marketState.lastClose = niftyData.price;
    }
    // FIX: VIX was being fetched successfully every cycle (visible in logs)
    // even on closed days, but the early `return` below prevented it from
    // ever reaching marketState — VIX has a meaningful "last close" value
    // too (e.g. "VIX closed 11.8 Friday"), so apply it regardless of trading day.
    if (vixData) { marketState.vix=vixData.vix; marketState.vixChange=vixData.change; marketState.vixSignal=vixData.signal; marketState.vixNote=vixData.note; marketState.strikeRange=vixData.strikeRange; }
    if (!isTradingDay) return; // rest of this function is live-market-only from here
    if (niftyData?.closes?.length>0&&!historyLoaded) { initializeHistory(niftyData.closes,niftyData.candles); historyLoaded=true; console.log(`History: ${niftyData.closes.length} candles`); }
    if (niftyData?.price>0 && isMarketOpen()) {
        // Always update via Yahoo if WS is not actively ticking (source != websocket,
        // or watchdog has already reset source to yahoo due to silent freeze).
        if (marketState.source!=='websocket') await updatePrice(niftyData.price,niftyData.change,niftyData.changePct,'yahoo');
        else { marketState.change=niftyData.change; marketState.changePct=niftyData.changePct; }
    }
}

async function refreshMTF() {
    if (!isNSEMarketDay()) return;
    try {
        // ── Re-seed candles from Yahoo if NSE is blocked ──────────────────────
        // getSessionCandles() returns [] when NSE intraday is blocked (Railway IP ban).
        // Yahoo Finance ^NSEI 5m candles are never blocked — use as silent fallback.
        const { getSessionCandles: _getSC } = require('./src/api/indicators');
        if (_getSC().length < 5) {
            loadCandlesFromYahoo().catch(e => console.warn('[Yahoo MTF refresh]', e.message));
        }

        const d = await analyzeMultiTimeframe(marketState.vix ?? null);
        if (!d) return;

        // ── Pre-market gate ────────────────────────────
        // Before 09:15 IST the candle history is overnight/multi-day data.
        // Store the raw timeframe readings so they're ready the moment the
        // session opens, but force the composite badge to NEUTRAL so it
        // can't show a directional call based on stale pre-market data.
        const ist = getIST();
        const mins = ist.getHours() * 60 + ist.getMinutes();
        const preMarket = mins < 555;   // 09:15 = 555 minutes from midnight

        // PCR contra cap: if PCR direction contradicts MTF signal, cap confidence at 60%.
        // e.g. PCR 0.828 (bearish/neutral) but MTF = BUY CALL → reduce conviction.
        let adjConfidence = d.mtfConfidence;
        if (!preMarket && d.mtfSignal !== 'WAIT' && marketState.pcrSignal) {
            const pcrBull = ['BULLISH', 'STRONG_BULL', 'MILD_BULL'].includes(marketState.pcrSignal);
            const pcrBear = ['BEARISH', 'STRONG_BEAR', 'MILD_BEAR'].includes(marketState.pcrSignal);
            const isBullCall = d.mtfSignal === 'BUY CALL';
            const isBearPut  = d.mtfSignal === 'BUY PUT';
            const contra = (isBullCall && pcrBear) || (isBearPut && pcrBull);
            if (contra) {
                adjConfidence = Math.min(adjConfidence, 60);
                console.log(`⚠️ PCR contra (${marketState.pcrSignal}) vs MTF ${d.mtfSignal} — confidence capped at 60%`);
            }
        }

        marketState.mtf = {
            signal        : preMarket ? 'NEUTRAL' : d.mtfSignal,
            strength      : preMarket ? 'WEAK'    : d.mtfStrength,
            confidence    : preMarket ? 0         : adjConfidence,
            aligned       : preMarket ? false      : d.aligned,
            softAligned   : preMarket ? false      : (d.softAligned ?? false),  // 15m+1h agree, 5m dissents
            oneHourLagging: preMarket ? false      : (d.oneHourLagging ?? false), // 5m+15m flipped vs 1H → 1H excluded
            bullCount     : preMarket ? 0          : d.bullCount,
            bearCount     : preMarket ? 0          : d.bearCount,
            validTFCount  : preMarket ? 0          : d.validTFCount ?? 0,  // used by telegram.js title
            validTFs      : preMarket ? 0          : d.validTFCount ?? 0, // ← fix: was missing, frontend checklist always showed 0/3
            tf5m          : d.tf5m,
            tf15m         : d.tf15m,
            tf1h          : d.tf1h,
            tf5mWarming   : d.tf5mWarming      ?? false, // true for ~22 min after restart
            tf5mBarsNeeded: d.tf5mBarsNeeded   ?? 0,     // how many more 5m bars until warm
        };

        // ── Per-timeframe candle patterns (5m / 15m / 1h) ─────────────────────
        // Uses the raw candle arrays returned by analyzeMultiTimeframe so we detect
        // patterns on the SAME bars used for RSI/EMA — fully consistent.
        const cp5m  = detectCandlePatternForTF(d.candles5m  || []);
        const cp15m = detectCandlePatternForTF(d.candles15m || []);
        const cp1h  = detectCandlePatternForTF(d.candles1h  || []);

        // Consensus: count bullish/bearish TF patterns (strength ≥ 2 counts as vote)
        const cpBull = [cp5m, cp15m, cp1h].filter(x => x.direction === 'BULLISH' && x.strength >= 2).length;
        const cpBear = [cp5m, cp15m, cp1h].filter(x => x.direction === 'BEARISH' && x.strength >= 2).length;
        let cpConsensus = 'NEUTRAL', cpConsensusLabel = '—';
        if (cpBull >= 2) { cpConsensus = 'BULLISH'; cpConsensusLabel = `🟢 ${cpBull}/3 TF Bullish`; }
        else if (cpBear >= 2) { cpConsensus = 'BEARISH'; cpConsensusLabel = `🔴 ${cpBear}/3 TF Bearish`; }
        else if (cpBull === 1 && cpBear === 0) cpConsensusLabel = '1/3 Bullish';
        else if (cpBear === 1 && cpBull === 0) cpConsensusLabel = '1/3 Bearish';
        else if (cpBull === 1 && cpBear === 1) cpConsensusLabel = '⚡ Mixed';

        marketState.cpMTF = { cp5m, cp15m, cp1h, cpBull, cpBear, cpConsensus, cpConsensusLabel };

        // Recent 5m candles for the liquidity-sweep-reversal detector (combineSignals
        // Gate 1 theta-zone exception) — same array used for MTF indicators above,
        // so it's consistent with everything else on the 5m timeframe. Last bar can
        // be the still-forming current candle (see resample() in multiTimeframe.js).
        marketState.candles5mRecent = (d.candles5m || []).slice(-10);
    } catch(e) { console.error('MTF:', e.message); }

    // ── Signal recalc trigger ─────────────────────────────────────────────────
    // MTF data just changed — recalc signal immediately instead of waiting for
    // next price tick (up to 60s on Yahoo fallback).
    if (marketState.nifty > 0 && isMarketOpen()) {
        try { await updatePrice(marketState.nifty, marketState.change ?? 0, marketState.changePct ?? 0, marketState.source ?? 'yahoo'); }
        catch(e) { console.error('[MTF signal trigger]', e.message); }
    }
}
async function refreshGlobal() {
    try { const g=await fetchGlobalCues(); if(g) marketState.global=g; } catch(e) { console.error('Global:',e.message); }
    // Signal recalc — BankNifty lead / global bias just refreshed
    if (marketState.nifty > 0 && isMarketOpen()) {
        try { await updatePrice(marketState.nifty, marketState.change ?? 0, marketState.changePct ?? 0, marketState.source ?? 'yahoo'); }
        catch(e) { console.error('[Global signal trigger]', e.message); }
    }
}
let _breadthInFlight = false;
async function refreshBreadth(force = false) {
    if (!force && !isNSEMarketDay()) return; // skip outside market hours unless forced (e.g. startup)
    if (_breadthInFlight) return; // prevent duplicate A/D fetches (e.g. post-login call overlapping staggered init)
    _breadthInFlight = true;
    try { const d=await fetchAdvanceDecline(); if(d) marketState.breadth=d; }
    catch(e) { console.error('Breadth:',e.message); }
    finally { _breadthInFlight = false; }
}
async function refreshSR() { if (!isNSEMarketDay()) return; try { if(marketState.nifty>0) { const sr=await calculateSRLevels(marketState.nifty, marketState.maxPain?.strike ? marketState.maxPain : null); if(sr) marketState.srLevels=sr; } } catch(e) { console.error('SR:',e.message); } }

async function refreshPCR() {
    if (!isNSEMarketDay()) return;
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
        if (!pcrState || !pcrState.pcr) {
            // PCR fetch failed — could be first startup OR all sources blocked (Railway IP ban).
            // Set pcrUnavailable whenever pcr is null regardless of _fallback flag,
            // so the UI always shows "NSE UNAVAIL" when we have no PCR data.
            marketState.pcrUnavailable = true;
            return;
        }
        marketState.pcrUnavailable = false;  // clear flag on success

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

        marketState.pcrSource  = 'auto';
        marketState.pcrFromIndex = pcrState.fromIndex || 'NIFTY';
        const srcLabel = pcrState.fromIndex === 'BANKNIFTY' ? `BankNifty proxy via ${pcrState.source}` : (pcrState.source || 'NSE');
        console.log(`✅ PCR auto-updated: ${pcrState.pcr} | ATM: ${pcrState.atmPcr} (source: ${srcLabel})`);

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

            // ── Murarka OI Imbalance Ratio: ΔPuts OI / ΔCalls OI ─────────────
            // The key metric Murarka reads from the option chain each morning.
            // > 1.0 = more puts being written (bullish bias)
            // < 1.0 = more calls being written (bearish bias)
            const pOI = oiState.totalPEoiChange;
            const cOI = oiState.totalCEoiChange;
            if (pOI !== null && cOI !== null && cOI !== 0) {
                marketState.oiImbalanceRatio = parseFloat((pOI / Math.abs(cOI)).toFixed(2));
            } else {
                marketState.oiImbalanceRatio = null;
            }
        }

        // ── Murarka PCR Zone + Entry Alert ────────────────────────────────────
        const { pcrZone, murarkaEntry } = computeMurarkaZone(
            marketState.pcr,
            marketState.nifty,
            marketState.vwap,
            isExpiryDay()
        );
        marketState.pcrZone     = pcrZone;
        marketState.murarkaEntry = murarkaEntry;

        // ── FII/DII — sync from nseData auto-fetch ────────────────────────────
        // nseData fetches FII/DII every 15 min on its own; we read it here.
        const fiiState = getFIIState();
        if (fiiState.fiiNet !== null) {
            marketState.fii = { buy: fiiState.fiiBuy, sell: fiiState.fiiSell, net: fiiState.fiiNet, updatedAt: fiiState.fetchedAt ? new Date(fiiState.fetchedAt).toISOString() : new Date().toISOString() };
        }
        if (fiiState.diiNet !== null) {
            marketState.dii = { buy: fiiState.diiBuy, sell: fiiState.diiSell, net: fiiState.diiNet, updatedAt: fiiState.fetchedAt ? new Date(fiiState.fetchedAt).toISOString() : new Date().toISOString() };
        }
        // BUG3 FIX: Refresh Smart Money Bias whenever OI/FII data updates (not only on price ticks)
        marketState.smartMoney = computeSmartMoneyBias();

    } catch(e) {
        console.error('refreshPCR:', e.message);
    }

    // ── Signal recalc trigger ─────────────────────────────────────────────────
    // PCR, OI buildup, Murarka zone, FII all just refreshed — recalc signal
    // immediately so the vote tally uses fresh PCR without waiting for next tick.
    if (marketState.nifty > 0 && isMarketOpen()) {
        try { await updatePrice(marketState.nifty, marketState.change ?? 0, marketState.changePct ?? 0, marketState.source ?? 'yahoo'); }
        catch(e) { console.error('[PCR signal trigger]', e.message); }
    }
}

// ── Fyers Volume/OHLC Refresh ─────────────────────────────────────────────────
// Angel One WS Mode 2 sends Vol:0 Buy:0 Sell:0 O:0 H:0 L:0 for the NIFTY 50
// INDEX token (26000) — indices have no order flow, so Angel doesn't send this
// data for them. Fyers' REST quote endpoint pulls from NSE's proper feed and
// DOES return real session volume + OHLC for the index.
//
// This reuses the same FYERS_ACCESS_TOKEN already configured for PCR — no new
// auth setup needed. Polled every 15s (not on every tick) to stay well under
// Fyers rate limits. Populates the same marketState.wsVolume/wsOpen/wsHigh/wsLow
// fields that WS Mode 2 was supposed to fill, so computeDelta() and the
// dashboard's volume display both get real data instead of always-zero.
async function refreshFyersVolume() {
    if (!isNSEMarketDay() || !isMarketOpen()) return;
    try {
        // NSE:NIFTY50-INDEX returns volume=0 (index has no actual traded volume).
        // "NSE:NIFTY-I" (Zerodha-style continuous-contract alias) is NOT a valid
        // Fyers symbol — it always failed silently and fell through to the
        // index-only fallback below, which is why Vol stayed "0.00Cr" forever
        // even though O/H/L/LTP looked fine (those came from the index fallback).
        // Fixed: use the real current-month contract symbol, e.g. NSE:NIFTY26JULFUT.
        const futSymbol = getCurrentFyersFutSymbol();
        let q = await fetchFyersQuote(futSymbol);

        // If futures volume still 0, the symbol format may have changed — log and skip
        if (!q || !q.ltp) {
            console.warn(`[Fyers Volume] ${futSymbol} failed — trying index as LTP-only`);
            q = await fetchFyersQuote('NSE:NIFTY50-INDEX');
        }

        if (!q || !q.ltp) {
            console.warn('[Fyers Volume] No quote returned — token may need refresh');
            return;
        }

        marketState.wsVolume = q.volume;
        marketState.wsOpen   = q.open;
        marketState.wsHigh   = q.high;
        marketState.wsLow    = q.low;

        const volCr = q.volume > 0 ? (q.volume / 1e7).toFixed(2) + 'Cr' : '0 (index-only LTP)';
        console.log(`[Fyers Volume] Vol:${volCr} | O:${q.open} H:${q.high} L:${q.low} | LTP:${q.ltp}`);

        // Recompute live delta now that we have real volume — same logic as
        // the WS onTick() handler, but using Fyers' aggregate volume instead
        // of per-tick buy/sell qty (Fyers index quote doesn't expose those,
        // only NSE's order book does — so this is volume-weighted, not a true
        // buy/sell split, but still far better than the candle-body proxy).
        if (q.volume > 0 && q.high > q.low) {
            // Approximate buy/sell split using where LTP sits in the day's range —
            // closer to high = more buying pressure, closer to low = more selling.
            const rangePos = (q.ltp - q.low) / (q.high - q.low); // 0 = at low, 1 = at high
            const buyShare = Math.max(0.1, Math.min(0.9, rangePos));
            const buyQty   = Math.round(q.volume * buyShare);
            const sellQty  = q.volume - buyQty;
            const deltaPct = parseFloat((((buyQty - sellQty) / q.volume) * 100).toFixed(1));
            const signal   = deltaPct > 10 ? 'BULLISH' : deltaPct < -10 ? 'BEARISH' : 'NEUTRAL';

            marketState.delta = {
                delta   : buyQty - sellQty,
                deltaPct,
                signal,
                divergence: false, // range-position proxy can't reliably detect divergence
                divergenceLabel: '',
                label   : `Delta:${deltaPct > 0 ? '+' : ''}${deltaPct}% (${signal}) [fyers-vol]`,
                source  : 'fyers',
            };
        }
    } catch(e) { console.error('[Fyers Volume]', e.message); }
}

// ── FII/DII Sync (runs always — not gated by market hours) ───────────────────
// refreshPCR() is skipped when market is closed, so FII data never syncs after 15:30.
// This standalone function runs every 20 min and ensures FII/DII always shows on breadth tab.
function syncFIIToMarketState() {
    try {
        const fiiState = getFIIState();
        if (fiiState.fiiNet !== null) {
            marketState.fii = { buy: fiiState.fiiBuy, sell: fiiState.fiiSell, net: fiiState.fiiNet, updatedAt: fiiState.fetchedAt ? new Date(fiiState.fetchedAt).toISOString() : new Date().toISOString() };
        }
        if (fiiState.diiNet !== null) {
            marketState.dii = { buy: fiiState.diiBuy, sell: fiiState.diiSell, net: fiiState.diiNet, updatedAt: fiiState.fetchedAt ? new Date(fiiState.fetchedAt).toISOString() : new Date().toISOString() };
        }
        if (fiiState.fiiNet !== null || fiiState.diiNet !== null) {
            marketState.smartMoney = computeSmartMoneyBias();
        }
    } catch(e) { console.error('syncFIIToMarketState:', e.message); }
}

// ── Economic Calendar Auto-Fetch ──────────────────────────────────────────────
let _calendarCache = [];
let _calendarFetchedDate = null;

const HARDCODED_INDIA_EVENTS = [
  // RBI MPC FY2026-27 schedule (decision announced on last day of 3-day meeting)
  { title: 'RBI MPC Decision',    date: '2026-06-05', impact: 'high',   country: 'IN', category: 'monetary'   },
  { title: 'RBI MPC Decision',    date: '2026-08-06', impact: 'high',   country: 'IN', category: 'monetary'   },
  { title: 'RBI MPC Decision',    date: '2026-10-08', impact: 'high',   country: 'IN', category: 'monetary'   },
  { title: 'RBI MPC Decision',    date: '2026-12-03', impact: 'high',   country: 'IN', category: 'monetary'   },
  { title: 'RBI MPC Decision',    date: '2027-02-04', impact: 'high',   country: 'IN', category: 'monetary'   },
  // India macro data releases (approximate monthly dates — NSE/MOSPI schedule)
  { title: 'India CPI Inflation', date: '2026-06-12', impact: 'medium', country: 'IN', category: 'inflation'  },
  { title: 'India WPI Inflation', date: '2026-06-15', impact: 'medium', country: 'IN', category: 'inflation'  },
  { title: 'India IIP Data',      date: '2026-06-12', impact: 'medium', country: 'IN', category: 'industrial' },
  { title: 'India CPI Inflation', date: '2026-07-14', impact: 'medium', country: 'IN', category: 'inflation'  },
  { title: 'India IIP Data',      date: '2026-07-11', impact: 'medium', country: 'IN', category: 'industrial' },
  { title: 'India CPI Inflation', date: '2026-08-13', impact: 'medium', country: 'IN', category: 'inflation'  },
  { title: 'India IIP Data',      date: '2026-08-12', impact: 'medium', country: 'IN', category: 'industrial' },
  { title: 'India GDP Q1 FY27',   date: '2026-08-31', impact: 'high',   country: 'IN', category: 'gdp'        },
  { title: 'India CPI Inflation', date: '2026-09-14', impact: 'medium', country: 'IN', category: 'inflation'  },
  { title: 'India CPI Inflation', date: '2026-10-13', impact: 'medium', country: 'IN', category: 'inflation'  },
  { title: 'India GDP Q2 FY27',   date: '2026-11-30', impact: 'high',   country: 'IN', category: 'gdp'        },
  { title: 'India CPI Inflation', date: '2026-11-12', impact: 'medium', country: 'IN', category: 'inflation'  },
  { title: 'India CPI Inflation', date: '2026-12-14', impact: 'medium', country: 'IN', category: 'inflation'  },
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

    // Add NSE weekly expiry (every Tuesday, effective Sep 2025)
    const d2 = new Date(ist);
    for (let i = 0; i <= 7; i++) {
      const dd = new Date(d2); dd.setDate(dd.getDate() + i);
      if (dd.getDay() === 2) {
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
    // Finnhub 403 = no API key or key invalid — not a crash, just no calendar data
    if (e?.response?.status === 403 || e?.response?.status === 401) {
      console.log('[Calendar] Finnhub key missing/invalid — using hardcoded India events only');
    } else {
      console.warn('Calendar fetch error:', e.message);
    }
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
          await sendRawMessage(msg);
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
//
// TRAILING SL (chandelier-style): once a trade reaches 1R profit, the fixed
// target is no longer the exit plan — instead SL starts trailing behind the
// trade's own peak premium, always at (peak − original risk). This means:
//   • At 1R    → trail SL sits at breakeven (entry)
//   • At 2R    → trail SL sits at entry+1R (locks in 1R)
//   • At 5R/10R → trail SL keeps following at (peak − 1R), so a trade CAN run
//                 to 5x, 10x etc. organically if the move keeps extending —
//                 no artificial fixed target caps it, but a pullback of one
//                 risk-unit from the peak locks in whatever was made.
// SL never moves down, only up (for CE) — same mirrored logic works for PE
// since we're comparing premium levels, not direction.
async function updateOpenTradesMTM() {
    const price = marketState.nifty;
    if (!price) return;

    // Piggyback signal-performance tracking on this same 30s cadence —
    // independent of the trades[] journal below.
    updateSignalPerformance().catch(e => console.warn('[SignalPerf] update error:', e.message));

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
        // VIX-dynamic fallback SL (matches pickStrikeAndPremium logic)
        const vixNow  = marketState.vix;
        let slFallbackPct = 0.25;
        if (vixNow) {
            if      (vixNow < 12) slFallbackPct = 0.20;
            else if (vixNow < 16) slFallbackPct = 0.25;
            else if (vixNow < 20) slFallbackPct = 0.30;
            else                  slFallbackPct = 0.35;
        }
        const risk    = t.sl > 0 ? (entry - t.sl) : entry * slFallbackPct;
        const sl      = t.sl > 0 ? t.sl : parseFloat((entry * (1 - slFallbackPct)).toFixed(2));
        const target1R  = parseFloat((entry + risk).toFixed(2));         // 1:1 — trailing activation point
        const target15R = parseFloat((entry + risk * 1.5).toFixed(2));   // 1:1.5 — informational checkpoint only

        // Initialise alert-sent guards + trailing state on first pass
        if (!t.alertSent) t.alertSent = { sl: false, target1R: false, target15R: false, trailSL: false };
        if (t.peakPremium == null) t.peakPremium = entry;

        // Track the best premium seen since entry (needed to trail from)
        if (livePremium > t.peakPremium) t.peakPremium = livePremium;

        // ── Trailing SL: only active once 1R profit has been reached ────
        const trailingActive = t.peakPremium >= target1R;
        if (trailingActive) {
            const candidateTrailSL = parseFloat((t.peakPremium - risk).toFixed(2));
            // Ratchet only upward — never lower an already-set trail SL
            t.trailSL = t.trailSL != null ? Math.max(t.trailSL, candidateTrailSL) : candidateTrailSL;
        }
        const effectiveSL = trailingActive ? t.trailSL : sl;

        // ── Hard SL hit (before 1R — original structural/VIX SL) ────────
        if (!t.alertSent.sl && !trailingActive && livePremium <= sl) {
            t.alertSent.sl = true;
            console.log(`🛑 SL hit: Trade #${t.id} ${t.type} ${t.strike} — premium ₹${livePremium} ≤ SL ₹${sl}`);
            if (isConfigured()) await sendExitAlert(t, 'STOP_LOSS', livePremium);
        }

        // ── Trailing SL hit (after 1R — locks in whatever profit was made) ─
        if (!t.alertSent.trailSL && trailingActive && livePremium <= effectiveSL) {
            t.alertSent.trailSL = true;
            console.log(`🎯 Trailing SL hit: Trade #${t.id} ${t.type} ${t.strike} — premium ₹${livePremium} ≤ trail ₹${effectiveSL} (peak was ₹${t.peakPremium})`);
            if (isConfigured()) await sendExitAlert(t, 'TRAILING_SL', livePremium, { peak: t.peakPremium, trailSL: effectiveSL });
        }

        // ── Target 1:1 — now just an informational checkpoint (trailing takes over) ──
        if (!t.alertSent.target1R && livePremium >= target1R) {
            t.alertSent.target1R = true;
            console.log(`✅ Target 1R hit: Trade #${t.id} — premium ₹${livePremium} ≥ ₹${target1R} — trailing SL now active`);
            if (isConfigured()) await sendExitAlert(t, 'TARGET_1R', livePremium);
        }

        // ── Target 1:1.5 — informational checkpoint ──────────────────────
        if (!t.alertSent.target15R && livePremium >= target15R) {
            t.alertSent.target15R = true;
            console.log(`🎯 Target 1.5R hit: Trade #${t.id} — premium ₹${livePremium} ≥ ₹${target15R}`);
            if (isConfigured()) await sendExitAlert(t, 'TARGET_1_5R', livePremium);
        }

        // ── Physics Law-1 trend-break — early warning while trailing ────
        // If the swing trend structure flips against the trade's direction
        // while it's in profit and trailing, that's a real-time reason the
        // trend that got us here may be over — send one heads-up (not a
        // forced exit, trailSL still governs the actual exit level).
        try {
            const swing = marketState.physicsOfTrading?.swingTrend;
            if (trailingActive && swing?.trend && !t.alertSent.trendBreak) {
                const against = (t.type === 'CE' && swing.trend === 'DOWNTREND') ||
                                (t.type === 'PE' && swing.trend === 'UPTREND');
                if (against) {
                    t.alertSent.trendBreak = true;
                    console.log(`⚠️ Trend break while trailing: Trade #${t.id} ${t.type} — swing now ${swing.trend}`);
                    if (isConfigured()) await sendExitAlert(t, 'TREND_BREAK', livePremium, { peak: t.peakPremium, trailSL: effectiveSL });
                }
            }
        } catch (e) {
            console.warn('[Trail] trend-break check failed:', e.message);
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
        dbPool.on('error', (err) => console.error('⚠️ DB pool error (idle client):', err.message));
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

        // ── signal_log table — auto-records every BUY CALL/PUT transition ──────
        // Lightweight table: one row per signal fire, no outcome tracking.
        // Gives you full signal history to review even without placing real trades.
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS signal_log (
                id          SERIAL PRIMARY KEY,
                ts          TIMESTAMPTZ DEFAULT NOW(),
                signal      TEXT,          -- 'BUY CALL' | 'BUY PUT'
                confidence  INT,
                nifty       NUMERIC,
                rsi         NUMERIC,
                ema9        NUMERIC,
                ema21       NUMERIC,
                vwap        NUMERIC,
                vix         NUMERIC,
                pcr         NUMERIC,
                atm_pcr     NUMERIC,
                adx         NUMERIC,
                mtf_signal  TEXT,
                mtf_aligned BOOLEAN,
                breadth_sig TEXT,
                prev_signal TEXT,          -- what signal was before this
                quality_gate BOOLEAN,
                entry_window TEXT,
                reasons     TEXT           -- JSON array of reason strings
            )
        `);
        console.log('✅ PostgreSQL signal_log table ready');

        // ── signal_performance table — automatic outcome tracking ──────────────
        // Unlike trade_history (manual journal, outcome set by user) and signal_log
        // (fire-and-forget snapshot), this table AUTOMATICALLY tracks what happened
        // AFTER each signal fired — no manual entry needed. Per feedback: "Every
        // signal should later display: Entry, High, Target Hit, Time Taken" so
        // accuracy can be published daily/weekly/monthly without relying on the
        // trader having actually placed and logged the trade.
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS signal_performance (
                id             SERIAL PRIMARY KEY,
                ts             TIMESTAMPTZ DEFAULT NOW(),
                trade_date     DATE DEFAULT (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE,
                signal         TEXT,       -- 'BUY CALL' | 'BUY PUT'
                option_type    TEXT,       -- 'CE' | 'PE'
                strike         INT,
                entry          NUMERIC,
                sl             NUMERIC,
                target         NUMERIC,
                high           NUMERIC,    -- best premium seen since entry (running)
                target_hit     BOOLEAN DEFAULT FALSE,
                sl_hit         BOOLEAN DEFAULT FALSE,
                closed         BOOLEAN DEFAULT FALSE,
                time_taken_min INT,
                closed_at      TIMESTAMPTZ,
                max_gain_pct   NUMERIC,    -- (high-entry)/entry*100 — best gain reached, whether or not target technically hit
                partial_win    BOOLEAN DEFAULT FALSE  -- max_gain_pct crossed the coach's own "+30% book 50%" stage
            )
        `);
        // ── Backward-compat for DBs created before this fix ─────────────────────
        // Real-world gap found: a genuinely profitable signal (10:01 am BUY CALL,
        // ₹148.2 → user manually booked ₹201, +36%) never technically touched the
        // official +50% target before PERF_AUTOCLOSE_MIN, so it auto-closed with
        // target_hit=false/sl_hit=false — counted as a flat miss in the accuracy
        // stat even though it was a clearly profitable trade. Binary target/SL
        // hides that. max_gain_pct + partial_win (crossing the AI Trade Coach's
        // own +30%/"book 50%" stage, the same threshold already shown to the
        // user) lets the summary report a realistic outcome instead of 0%.
        await dbPool.query(`ALTER TABLE signal_performance ADD COLUMN IF NOT EXISTS max_gain_pct NUMERIC`).catch(()=>{});
        await dbPool.query(`ALTER TABLE signal_performance ADD COLUMN IF NOT EXISTS partial_win BOOLEAN DEFAULT FALSE`).catch(()=>{});
        console.log('✅ PostgreSQL signal_performance table ready');

        // ── journal_trades table — manually entered trades from the Journal tab ──
        // Separate from trade_history (which is AI-suggested auto-saves).
        // Persists across Railway restarts — in-memory trades[] array does NOT.
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS journal_trades (
                id           SERIAL PRIMARY KEY,
                ts           TIMESTAMPTZ DEFAULT NOW(),
                time         TEXT,          -- HH:MM display time (IST)
                type         TEXT,          -- 'CE' | 'PE'
                strike       INT,
                premium      NUMERIC,
                lots         INT DEFAULT 1,
                sl           NUMERIC DEFAULT 0,
                notes        TEXT DEFAULT '',
                nifty_entry  NUMERIC,
                exit_premium NUMERIC,
                exit_time    TEXT,
                pnl          NUMERIC,
                status       TEXT DEFAULT 'OPEN'
            )
        `);
        console.log('✅ PostgreSQL journal_trades table ready');

        // ── pcr_intraday_history table — every PCR tick of the day, persisted ──
        // In-memory marketState.pcrHistory is capped/reset on Railway restarts.
        // This table lets the PCR-slope chart survive a redeploy/restart and
        // also lets you query past sessions later if needed.
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS pcr_intraday_history (
                id          SERIAL PRIMARY KEY,
                ts          TIMESTAMPTZ DEFAULT NOW(),
                trade_date  DATE DEFAULT (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE,
                time_ist    TEXT,           -- "HH:MM" IST, matches pcrHistory.time
                pcr         NUMERIC,
                atm_pcr     NUMERIC,
                nifty       NUMERIC,
                signal      TEXT
            )
        `);
        await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_pcr_intraday_date ON pcr_intraday_history(trade_date)`);
        console.log('✅ PostgreSQL pcr_intraday_history table ready');

        // ── Inject DB pool into historical data module ────────────────────────
        injectHistDBPool(dbPool);
        console.log('✅ Historical data module connected to DB');

        // ── Hydrate today's PCR history from DB ────────────────────────────────
        // On a mid-day Railway restart, in-memory marketState.pcrHistory starts
        // empty — without this, the live dashboard's PCR slope chart would look
        // like the day just started even though DB has the full session.
        try {
            const todayRows = await getTodayPCRHistory();
            if (todayRows && todayRows.length) {
                const ist = getIST();
                _pcrHistoryDate = `${ist.getFullYear()}-${ist.getMonth()}-${ist.getDate()}`;
                marketState.pcrHistory = todayRows.slice(-200).map(r => ({ time: r.time, pcr: r.pcr, signal: pcrLabel(r.pcr) }));
                marketState.pcrSlope = calcPCRSlope(marketState.pcrHistory);
                console.log(`✅ Hydrated ${marketState.pcrHistory.length} PCR ticks from DB (restart recovery)`);
            }
        } catch (e) { console.error('PCR history hydration error:', e.message); }
    } catch (e) {
        console.error('DB init error:', e.message);
        dbPool = null;
    }
}

// Persist one PCR tick to the DB (fire-and-forget — never blocks the poll cycle).
async function savePCRTick(pcr, atmPcr, nifty, signal) {
    if (!dbPool) return;
    try {
        const ist  = getIST();
        const time = `${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;
        await dbPool.query(
            `INSERT INTO pcr_intraday_history (time_ist, pcr, atm_pcr, nifty, signal) VALUES ($1,$2,$3,$4,$5)`,
            [time, pcr, atmPcr ?? null, nifty ?? null, signal ?? null]
        );
    } catch (e) { console.error('PCR tick save error:', e.message); }
}

// Today's full PCR series from DB — used by the slope chart to survive
// Railway restarts (in-memory marketState.pcrHistory resets on redeploy).
async function getTodayPCRHistory() {
    if (!dbPool) return null;
    try {
        const r = await dbPool.query(
            `SELECT time_ist AS time, pcr, atm_pcr, nifty, signal FROM pcr_intraday_history
             WHERE trade_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE ORDER BY ts ASC`
        );
        return r.rows.map(row => ({ time: row.time, pcr: parseFloat(row.pcr), atmPcr: row.atm_pcr ? parseFloat(row.atm_pcr) : null, nifty: row.nifty ? parseFloat(row.nifty) : null, signal: row.signal }));
    } catch (e) { console.error('getTodayPCRHistory error:', e.message); return null; }
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


// ── SSE payload builder — same shape as /api/signal ─────────────────────────
function buildSignalPayload() {
    try {
        const atmStrike = marketState.nifty > 0 ? Math.round(marketState.nifty / 50) * 50 : null;
        const daysToExp = parseFloat(daysToNextExpiry().toFixed(2));
        const { breadth: { stocks: _s, ...breadthRest }, ...rest } = marketState;
        return { ...rest, breadth: breadthRest, atmStrike, daysToExpiry: daysToExp, lotSize: LOT_SIZE };
    } catch(_) { return marketState; }
}

// ── Signal Log Writer ─────────────────────────────────────────────────────────
// Called every time combineSignals() produces a FRESH BUY CALL or BUY PUT
// (i.e. signal changed from previous). Records full market snapshot so you can
// review past setups, filter by quality gate, and spot patterns over time.
async function saveSignalToLog(signal, prevSig) {
    if (!dbPool) return;
    try {
        const s = marketState;
        await dbPool.query(
            `INSERT INTO signal_log
              (signal, confidence, nifty, rsi, ema9, ema21, vwap, vix, pcr, atm_pcr,
               adx, mtf_signal, mtf_aligned, breadth_sig, prev_signal,
               quality_gate, entry_window, reasons)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [
                signal, s.confidence, s.nifty, s.rsi, s.ema9, s.ema21, s.vwap,
                s.vix, s.pcr, s.atmPcr, s.adx?.adx ?? null,
                s.mtf?.signal ?? null, s.mtf?.aligned ?? false,
                s.breadth?.breadthSignal ?? null, prevSig,
                s.qualityGate?.passed ?? false, s.entryWindow?.label ?? null,
                JSON.stringify((s.reason || []).slice(0, 12))
            ]
        );
        console.log(`📝 Signal logged: ${signal} @ ₹${s.nifty} (conf:${s.confidence}%)`);
        // Push instant SSE to all connected clients — analytics + live tab update immediately
        sseBroadcast('signal', buildSignalPayload());
        sseBroadcast('new_signal', { signal, nifty: s.nifty, confidence: s.confidence,
            qualityGate: s.qualityGate?.passed ?? false, ts: new Date().toISOString() });
    } catch (e) {
        console.error('saveSignalToLog error:', e.message);
    }
}

// ── Signal Performance Tracking ──────────────────────────────────────────────
// Automatic, no manual entry required. Per feedback: "Every signal should
// later display: Entry, High, Target Hit, Time Taken" so accuracy can be
// published (today/weekly/monthly) even for signals the trader never actually
// placed a real order on. Independent of trade_history (manual journal) and
// signal_log (fire-and-forget snapshot) — this one watches the live premium
// after a signal fires and records what actually happened.
async function startSignalPerformance(signal, strikeData) {
    if (!strikeData || !strikeData.entry) return;
    const rec = {
        id: null,
        signal, type: strikeData.type, strike: strikeData.strike,
        entry: strikeData.entry, sl: strikeData.sl, target: strikeData.target,
        high: strikeData.entry, startTs: Date.now(),
    };
    openPerfRecords.push(rec);
    if (dbPool) {
        try {
            const r = await dbPool.query(
                `INSERT INTO signal_performance (signal, option_type, strike, entry, sl, target, high)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
                [signal, strikeData.type, strikeData.strike, strikeData.entry, strikeData.sl, strikeData.target, strikeData.entry]
            );
            rec.id = r.rows[0]?.id ?? null;
        } catch (e) { console.warn('[SignalPerf] insert error:', e.message); }
    }
}

// Called every ~30s (piggybacks on updateOpenTradesMTM's cadence) — updates
// running high, checks target/SL hit, and auto-closes stale records so a
// signal that never resolved doesn't hang open forever.
async function updateSignalPerformance() {
    if (openPerfRecords.length === 0) return;
    const atmCE = marketState.optionFlow?.atmCEpremium;
    const atmPE = marketState.optionFlow?.atmPEpremium;
    const stillOpen = [];

    for (const rec of openPerfRecords) {
        const live = rec.type === 'CE' ? atmCE : atmPE;
        const elapsedMin = Math.round((Date.now() - rec.startTs) / 60000);

        if (live) rec.high = Math.max(rec.high, live);

        let targetHit = live && live >= rec.target;
        let slHit     = live && live <= rec.sl;
        const timedOut = elapsedMin >= PERF_AUTOCLOSE_MIN;

        // ── Max gain % + partial-win credit ──────────────────────────────────
        // Fixes a real gap: a signal that ran up nicely (e.g. +36%) but got
        // auto-closed by PERF_AUTOCLOSE_MIN before technically touching the
        // official +50% target was previously recorded as target_hit=false,
        // sl_hit=false — a flat miss in the accuracy stat, even though it was
        // a genuinely profitable trade a trader would have booked manually.
        // partial_win uses the SAME +30% threshold the AI Trade Coach already
        // shows the user ("+30% → book 50%"), so it reflects a stage the app
        // itself already calls a good exit point, not an arbitrary number.
        const maxGainPct = rec.entry > 0 ? Math.round(((rec.high - rec.entry) / rec.entry) * 1000) / 10 : 0;
        const partialWin = !targetHit && !slHit && maxGainPct >= 30;

        if (targetHit || slHit || timedOut) {
            const closedAt = new Date().toISOString();
            const outcomeLabel = targetHit ? 'TARGET HIT ✅' : slHit ? 'SL HIT ⛔' : partialWin ? `PARTIAL WIN 🟡 (+${maxGainPct}%)` : 'TIMED OUT ⏳';
            console.log(`📊 [SignalPerf] ${rec.signal} ${rec.strike}${rec.type} closed — ${outcomeLabel} | Entry:${rec.entry} High:${rec.high} (+${maxGainPct}%) | ${elapsedMin} min`);
            if (dbPool && rec.id) {
                try {
                    await dbPool.query(
                        `UPDATE signal_performance SET high=$1, target_hit=$2, sl_hit=$3, closed=true, time_taken_min=$4, closed_at=$5, max_gain_pct=$6, partial_win=$7 WHERE id=$8`,
                        [rec.high, targetHit, slHit, elapsedMin, closedAt, maxGainPct, partialWin, rec.id]
                    );
                } catch (e) { console.warn('[SignalPerf] update error:', e.message); }
            }
        } else {
            stillOpen.push(rec);
        }
    }
    openPerfRecords = stillOpen;

    // Expose today's open cards for the frontend (ChatGPT-style "Entry/High/Target Hit/Time Taken" card)
    // gainPct added so the UI can show running profit even before target/SL/timeout resolves it.
    marketState.signalPerformance.open = openPerfRecords.map(r => ({
        signal: r.signal, type: r.type, strike: r.strike,
        entry: r.entry, high: r.high, sl: r.sl, target: r.target,
        gainPct: r.entry > 0 ? Math.round(((r.high - r.entry) / r.entry) * 1000) / 10 : 0,
        elapsedMin: Math.round((Date.now() - r.startTs) / 60000),
    }));
}

// Daily/weekly/monthly accuracy rollup — per feedback: "Over time you can
// publish: Today's accuracy, Weekly accuracy, Monthly accuracy."
async function getSignalPerformanceSummary() {
    if (!dbPool) return { today: null, weekly: null, monthly: null };
    const q = async (whereClause) => {
        const r = await dbPool.query(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN target_hit THEN 1 ELSE 0 END) AS hits,
                    SUM(CASE WHEN target_hit OR partial_win THEN 1 ELSE 0 END) AS real_hits,
                    ROUND(AVG(time_taken_min)) AS avg_time
             FROM signal_performance WHERE closed = true AND ${whereClause}`
        );
        const row = r.rows[0];
        const total = parseInt(row.total) || 0;
        if (total === 0) return { total: 0, accuracy: null, realAccuracy: null, avgTimeMin: null };
        // accuracy = strict (only official target technically touched).
        // realAccuracy = also credits trades that ran to the AI Coach's own
        // +30%/"book 50%" stage before timing out — a truer picture of whether
        // the signal was actually worth taking, not just whether it hit the
        // full +50% number exactly. See updateSignalPerformance() for why.
        return {
            total,
            accuracy: Math.round((parseInt(row.hits) / total) * 100),
            realAccuracy: Math.round((parseInt(row.real_hits) / total) * 100),
            avgTimeMin: row.avg_time ? parseInt(row.avg_time) : null,
        };
    };
    try {
        return {
            today  : await q(`trade_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE`),
            weekly : await q(`trade_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE - INTERVAL '7 days'`),
            monthly: await q(`trade_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE - INTERVAL '30 days'`),
        };
    } catch (e) {
        console.warn('[SignalPerf] summary error:', e.message);
        return { today: null, weekly: null, monthly: null };
    }
}

async function getWinRateFromHistory(signalType) {
    if (!dbPool) return null;

    try {
        // FIX: ORDER BY + LIMIT inside a plain aggregate is silently ignored by Postgres —
        // it still counts ALL matching rows. Use a subquery to select the 50 most recent
        // completed trades first, then aggregate over that bounded result set.
        const r = await dbPool.query(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins
             FROM (
               SELECT outcome FROM trade_history
               WHERE signal_type=$1 AND outcome IN ('WIN','LOSS')
               ORDER BY ts DESC
               LIMIT 50
             ) recent`,
            [signalType]
        );
        const row = r.rows[0];
        if (!row || parseInt(row.total) === 0) return null;
        return Math.round((parseInt(row.wins) / parseInt(row.total)) * 100);
    } catch (e) {
        return null;
    }
}


// ── Days to Next Weekly Expiry (Nifty = every Tuesday) ───────────────────────
// Returns fractional days remaining until next Tuesday 15:30 IST.
// Used in pickStrikeAndPremium() so BS estimates use real DTE instead of hardcoded 3 days.
// On expiry day (Tuesday) after 15:30 → returns 7 (next week).
// Minimum 0.04 (≈ 1 hr) so BS never divides by zero on intraday expiry morning.
function daysToNextExpiry() {
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay();   // 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
    // Days until next Tuesday
    let daysUntilTue = (2 - day + 7) % 7;
    if (daysUntilTue === 0) {
        // Today IS Tuesday — check if market already closed (after 15:30)
        const minNow = ist.getHours() * 60 + ist.getMinutes();
        if (minNow >= 930) daysUntilTue = 7;  // next Tuesday
    }
    // Remaining minutes today until 15:30
    const minsUntilClose = Math.max(0, 930 - (ist.getHours() * 60 + ist.getMinutes()));
    const fracToday = minsUntilClose / (24 * 60);
    const total = daysUntilTue + fracToday;
    return Math.max(0.04, total);  // minimum 1hr equivalent
}

// ── Strike + Premium Picker ────────────────────────────────────────────────
// Picks the right strike and reads live LTP from option chain already in memory
function pickStrikeAndPremium(signal, nifty, vix, pcrState) {
    if (!nifty || nifty <= 0) return null;
    // FIX: If VIX not yet fetched, use safe default (15 = moderate volatility)
    // so Black-Scholes fallback always runs instead of returning null
    const effectiveVix = vix || 15;

    const isBull = signal === 'BUY CALL';
    const type   = isBull ? 'CE' : 'PE';
    const atm    = Math.round(nifty / 50) * 50;

    // Strike selection logic:
    // VIX < 13: market calm → OTM by 50pt (cheaper premium, more leverage)
    // VIX 13-18: normal → ATM (best liquidity)
    // VIX > 18: volatile → ATM (don't go OTM, decay risk too high)
    let strike = atm;
    if (effectiveVix < 13) {
        strike = isBull ? atm + 50 : atm - 50;
    }

    // Try to get live LTP from pcrState option chain data
    // FIX: previously, OTM strikes (VIX<13 → ATM±50) ALWAYS used a Black-Scholes
    // estimate, even though the full option chain (pcrState.records) already has
    // every strike's REAL live LTP — records was fetched but never consulted for
    // non-ATM strikes. BS-vs-market divergence was 15-25%+ on observed signals
    // (BS said ₹131 for a strike that never traded above ~₹115 that day).
    // Now: look up the real LTP for the chosen strike first, BS is the fallback
    // only if that strike isn't present in the fetched chain (rare — chain covers
    // ATM±20 strikes, our OTM pick is only ±50 = 1 strike away).
    const dte = daysToNextExpiry();   // real days to next Tuesday expiry
    let entryPremium = null;

    if (strike === atm && pcrState && pcrState.atmCEpremium && pcrState.atmPEpremium) {
        entryPremium = type === 'CE' ? pcrState.atmCEpremium : pcrState.atmPEpremium;
    } else if (pcrState?.records?.length) {
        const rec = pcrState.records.find(r => r.strikePrice === strike);
        const liveLtp = type === 'CE' ? rec?.CE?.lastPrice : rec?.PE?.lastPrice;
        if (liveLtp > 0) entryPremium = liveLtp;
    }

    // If no live premium available, use Black-Scholes with real DTE (not hardcoded 3 days)
    if (!entryPremium) {  // always try BS — effectiveVix guaranteed
        const sigma = effectiveVix / 100;
        const T = dte / 365;  // FIX: real days to expiry, not hardcoded 3
        entryPremium = parseFloat(bsEstimate(nifty, strike, T, sigma, type).toFixed(2));
    }

    if (!entryPremium || entryPremium <= 0) return null;

    const sigma = effectiveVix / 100;
    const T     = dte / 365;

    // ── VIX-dynamic SL (Murarka strategy) — baseline / fallback ──────────────
    // Flat 25% SL is too tight on high-VIX days (frequent noise stops) and
    // too loose on calm days (poor R:R). Scale SL width with realised volatility:
    //   VIX < 12  → 20% SL (tight, calm market, premiums cheap)
    //   VIX 12-16 → 25% SL (baseline)
    //   VIX 16-20 → 30% SL (wider, more premium noise)
    //   VIX > 20  → 35% SL (very wide, but signal is blocked by gate anyway)
    // Target always = SL risk × 2 (1:2 R:R) from entry.
    let slPct = 0.25;  // default
    {
        if      (effectiveVix < 12) slPct = 0.20;
        else if (effectiveVix < 16) slPct = 0.25;
        else if (effectiveVix < 20) slPct = 0.30;
        else                        slPct = 0.35;
    }
    let slWidth  = parseFloat((entryPremium * slPct).toFixed(2));
    let sl       = parseFloat((entryPremium - slWidth).toFixed(2));
    let target   = parseFloat((entryPremium + slWidth * 2).toFixed(2));  // 1:2 R:R
    let slSource = 'vix-pct';

    // ── Structural SL from Physics Law-3 Fibonacci swing (preferred) ─────────
    // The flat VIX-% SL above has zero connection to actual chart structure —
    // it doesn't know where the last swing high/low or the 61.8% reaction zone
    // sits. marketState.fiboCard (same swing data the Physics tab shows) gives
    // real support/resistance on the SPOT. We translate that spot level into
    // premium terms using a Black-Scholes RATIO (not absolute BS price —
    // entryPremium above is still the real market LTP; only the *shape* of the
    // move SL-spot→entry-spot is taken from BS, anchored to the live premium).
    // Target is intentionally kept at the disciplined 1:2 R:R off this
    // structural risk — NOT the swing-high itself (tested: using the raw swing
    // high as target routinely implied 4–6x R:R, i.e. the premium nearly
    // doubling — optimistic and ignores theta decay before that level is hit).
    // Falls back to the VIX-% system above on ANY doubt: missing/misaligned
    // swing, level on the wrong side of price, or resulting risk outside a
    // sane 5–45% band.
    try {
        const fibo = marketState?.fiboCard;
        if (fibo && fibo.levels && fibo.swingHigh > fibo.swingLow) {
            let slSpot = null;
            if (isBull && fibo.direction === 'UP' && fibo.levels.l618 < nifty) {
                slSpot = fibo.levels.l618;   // 61.8% retrace below = structural invalidation
            } else if (!isBull && fibo.direction === 'DOWN' && fibo.levels.l618 > nifty) {
                slSpot = fibo.levels.l618;   // 61.8% retrace above = structural invalidation
            }

            if (slSpot !== null) {
                const bsNow  = bsEstimate(nifty,  strike, T, sigma, type);
                const bsAtSL = bsEstimate(slSpot, strike, T, sigma, type);

                if (bsNow > 0 && bsAtSL >= 0) {
                    const structSL = parseFloat((entryPremium * (bsAtSL / bsNow)).toFixed(2));
                    const risk     = entryPremium - structSL;
                    const riskPct  = risk / entryPremium;

                    if (risk > 0 && riskPct >= 0.05 && riskPct <= 0.45) {
                        sl       = structSL;
                        slWidth  = parseFloat(risk.toFixed(2));
                        target   = parseFloat((entryPremium + slWidth * 2).toFixed(2));  // keep 1:2 R:R
                        slSource = `fibo-swing (61.8% retrace @ ${slSpot.toFixed(0)} spot)`;
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[Strike] Fibo-structural SL failed, using VIX-% fallback:', e.message);
    }

    return { type, strike, entry: entryPremium, sl, target, slSource };
}

// ── AI Trade Coach ───────────────────────────────────────────────────────────
// Per feedback: "Create an AI Trade Coach instead of just an AI signal."
// Turns the raw entry/SL/target numbers from pickStrikeAndPremium() into
// plain-language guidance a trader can act on immediately:
//   1. An ideal entry ZONE (not a single price) + a hard "don't chase above"
//      ceiling — chasing a premium that's already run past the sane entry
//      band means most of the move is gone before you're even in.
//   2. What to do if the entry zone is missed (wait for pullback, don't chase).
//   3. A staged profit-management plan in plain % terms (move SL to cost,
//      book partial, exit) — this is a PREVIEW shown alongside the signal,
//      not a replacement for the R-multiple trailing-SL system that already
//      manages live journaled trades in updateOpenTradesMTM().
function buildTradeCoach(strikeData) {
    if (!strikeData || !strikeData.entry) return null;
    const { entry, sl, target } = strikeData;

    // Ideal entry zone: tight band around the current live/estimated premium.
    // Chase ceiling: hard cap — paying meaningfully more than current premium
    // for the same setup means the easy part of the move is already captured.
    const idealLow      = parseFloat((entry * 0.96).toFixed(2));
    const idealHigh      = parseFloat((entry * 1.02).toFixed(2));
    const chaseCeiling   = parseFloat((entry * 1.10).toFixed(2));

    const risk = entry - sl;

    return {
        idealEntryLow  : idealLow,
        idealEntryHigh : idealHigh,
        idealEntryLabel: `₹${idealLow}–${idealHigh}`,
        chaseCeiling,
        chaseWarning   : `Do NOT chase above ₹${chaseCeiling}`,
        ifMissed       : 'Missed the zone? Wait for a pullback — don\'t chase.',
        plan: [
            { atPct: 20, premium: parseFloat((entry * 1.20).toFixed(2)), action: 'Move SL to cost (breakeven)' },
            { atPct: 30, premium: parseFloat((entry * 1.30).toFixed(2)), action: 'Book 50% of the position' },
            { atPct: 40, premium: parseFloat((entry * 1.40).toFixed(2)), action: 'Exit remaining — full booking' },
        ],
        riskPerLot: parseFloat(risk.toFixed(2)),
        note: 'Entry-zone guidance for a fresh trade. Once logged in the Journal, the R-multiple trailing-SL system takes over for actual exit alerts.',
    };
}

// Simple Black-Scholes call/put price estimate
function bsEstimate(S, K, T, sigma, type) {
    const r = 0.0625;  // RBI repo rate (updated June 2026 — was 0.065)
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

    // Only call AI when signal has CHANGED to a new direction OR Nifty has moved
    // enough to warrant a fresh strike pick (>100 points from last call level).
    // FIX: old code cached on state.signal only — ignored price level entirely,
    // serving a stale 24050 CE suggestion when Nifty had moved to 24400.
    const niftyBracket = Math.round((state.nifty || 0) / 100) * 100;
    const currentSignal = state.signal + '_' + niftyBracket;  // direction + 100pt level
    if (lastAISuggestion && lastAISuggestionSignal === currentSignal) {
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
            model: 'claude-sonnet-4-6',
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
        lastAISuggestionSignal = currentSignal;  // FIX: key includes price bracket so cache invalidates on 100pt moves

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
    // Returns cached AI suggestion instantly. If gate just passed and no cached suggestion
    // exists yet (e.g. fresh page load, server restart), triggers AI call inline ONCE.
    try {
        const pcrState   = getPCRState();
        const strikeData = marketState.qualityGate.passed && marketState.signal !== 'WAIT'
            ? pickStrikeAndPremium(marketState.signal, marketState.nifty, marketState.vix, pcrState)
            : null;
        if (strikeData) strikeData.coach = buildTradeCoach(strikeData);
        const winRate = strikeData ? await getWinRateFromHistory(strikeData.type) : null;

        // If gate is passed but no AI suggestion cached yet, trigger one now
        let suggestion = lastAISuggestion;
        if (!suggestion && marketState.qualityGate.passed && marketState.signal !== 'WAIT' && strikeData) {
            try {
                suggestion = await getAITradeSuggestion(marketState, strikeData, winRate);
            } catch(e) { console.warn('Inline AI trigger:', e.message); }
        }

        res.json({
            qualityGatePassed : marketState.qualityGate.passed,
            signal            : marketState.signal,
            confidence        : marketState.confidence,
            strikeData        : strikeData,
            aiSuggestion      : suggestion,
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
app.post('/api/trade-history/outcome', requireToken, async (req, res) => {
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

// ── /api/signal-performance — automatic tracking, no manual entry needed ────
// Returns today's live open cards (Entry/High/Target Hit/Time Taken) plus
// today/weekly/monthly accuracy rollups.
app.get('/api/signal-performance', async (req, res) => {
    try {
        const summary = await getSignalPerformanceSummary();
        res.json({ open: marketState.signalPerformance.open, summary });
    } catch (e) {
        res.json({ open: [], summary: { today: null, weekly: null, monthly: null }, error: e.message });
    }
});


// ── Signal Log endpoint — auto-logged BUY CALL/PUT history ──────────────────
// Returns last N signal fires with full market context at fire time.
// Query params:
//   ?limit=N   — default 50, max 200
//   ?signal=BUY+CALL  — filter by direction
//   ?gate=true  — only show quality-gate-passed signals
app.get('/api/signal-log', async (req, res) => {
    if (!dbPool) return res.json({ rows: [], msg: 'No DB — add DATABASE_URL to Railway' });
    try {
        const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
        const sigFil = req.query.signal || null;   // 'BUY CALL' | 'BUY PUT' | null
        const gateFil= req.query.gate === 'true';  // true = only passed setups

        let q = 'SELECT id,ts,signal,confidence,nifty,rsi,vix,pcr,atm_pcr,adx,' +
                'mtf_signal,mtf_aligned,breadth_sig,prev_signal,quality_gate,' +
                'entry_window,reasons FROM signal_log';
        const params = [];
        const where  = [];
        if (sigFil)  { params.push(sigFil);  where.push(`signal=$${params.length}`); }
        if (gateFil) { where.push(`quality_gate=TRUE`); }
        if (where.length) q += ' WHERE ' + where.join(' AND ');
        params.push(limit);
        q += ` ORDER BY ts DESC LIMIT $${params.length}`;

        const r = await dbPool.query(q, params);

        // Parse reasons JSON back to array for clean frontend consumption
        const rows = r.rows.map(row => ({
            ...row,
            reasons: (() => { try { return JSON.parse(row.reasons || '[]'); } catch { return []; } })()
        }));
        res.json({ rows, count: rows.length });
    } catch (e) {
        res.json({ rows: [], error: e.message });
    }
});


// ── Simple API token guard for manual POST endpoints ─────────────────────────
// Set APP_TOKEN=yourSecretToken in Railway env vars to enable.
// Requests must send either:
//   Header:       X-App-Token: yourSecretToken
//   Query param:  ?key=yourSecretToken
// When APP_TOKEN is not set, all requests pass through (backward-compatible).
function requireToken(req, res, next) {
    const secret = process.env.APP_TOKEN;
    if (!secret) return next();  // not configured — allow all (default)
    const provided = req.headers['x-app-token'] || req.query.key;
    if (provided === secret) return next();
    console.warn(`[Auth] Blocked unauthorized POST to ${req.path} from ${req.ip}`);
    return res.status(401).json({ success: false, msg: 'Unauthorized — set X-App-Token header' });
}

// ── Routes ────────────────────────────────────────────
// Throttle MTM updates — no need to recalc P&L 20×/min.
// Premium values (atmCEpremium/atmPEpremium) change at the option-chain refresh cadence
// (~3 min), so running on every 3s frontend poll is pure CPU waste.
let _lastMTMRun = 0;
// Login probe — frontend uses this to verify password without exposing data
app.get('/api/auth/check', requireToken, (req, res) => res.json({ ok: true }));

app.get('/api/signal',  (req,res) => {
    const now = Date.now();
    if (now - _lastMTMRun >= 30_000) { updateOpenTradesMTM(); _lastMTMRun = now; }
    // Attach computed fields the frontend Strike Zone needs
    const atmStrike = marketState.nifty > 0 ? Math.round(marketState.nifty / 50) * 50 : null;
    const daysToExp = parseFloat(daysToNextExpiry().toFixed(2));
    // Strip breadth.stocks[] — 50-object array not needed by the signal endpoint.
    // It's ~30-50KB sent every 3 seconds for nothing; the breadth tab uses /api/breadth.
    const { breadth: { stocks: _stocks, ...breadthWithoutStocks }, ...stateRest } = marketState;
    // FIX: Expose lotSize so frontend never hardcodes 65. When NSE revises lot size,
    // update the server constant once and all P&L, SL, and position-size calcs stay correct.
    res.json({ ...stateRest, breadth: breadthWithoutStocks, atmStrike, daysToExpiry: daysToExp, lotSize: LOT_SIZE });
});
app.get('/api/candles', (req,res) => res.json(getCandleHistory()));

// ── SSE stream — client connects once, server pushes events instantly ─────────
app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');   // disable Nginx buffering on Railway
    res.flushHeaders();

    // Send current state immediately on connect so client doesn't wait
    res.write(`event: signal\ndata: ${JSON.stringify(buildSignalPayload())}\n\n`);

    _sseClients.add(res);
    console.log(`[SSE] Client connected (total: ${_sseClients.size})`);

    // Heartbeat every 8s — Railway proxy drops idle connections ~19s.
    // FIX: was 10s which was too close to the Railway timeout causing
    // disconnect/reconnect loop every 10-15s visible in logs.
    // Using 8s gives 2x safety margin vs the ~19s Railway SSE timeout.
    const hb = setInterval(() => {
        try { res.write(':hb\n\n'); } catch(_) { clearInterval(hb); }
    }, 8000);

    req.on('close', () => {
        clearInterval(hb);
        _sseClients.delete(res);
        console.log(`[SSE] Client disconnected (total: ${_sseClients.size})`);
    });
});

// Chart historical data — fetched server-side to avoid browser CORS restrictions
app.get('/api/chart', async (req,res) => {
    const tf = req.query.tf || '5m';
    // All intraday TFs are built from the same 1m intraday source then aggregated
    const tfMinutes = { '1m': 1, '5m': 5, '15m': 15, '1h': 60 };
    const minutes = tfMinutes[tf] || 5;
    try {
        const { fetchYahooChart } = require('./src/api/yahooFetch');
        // Always fetch 1m intraday bars (shared cache — no extra network cost)
        const result = await fetchYahooChart('%5ENSEI', { interval: '1m', range: '1d', includePrePost: false });
        const q = result?.indicators?.quote?.[0];
        if (!q) return res.json([]);
        const { open, high, low, close, volume } = q;
        const timestamps = result.timestamp || [];

        // Build raw 1m candles with timestamps
        const raw = [];
        for (let i = 0; i < close.length; i++) {
            if (close[i] != null && high[i] != null && low[i] != null) {
                raw.push({
                    ts    : (timestamps[i] || 0) * 1000,
                    open  : open[i] || close[i],
                    high  : high[i],
                    low   : low[i],
                    close : close[i],
                    volume: volume[i] || 1,
                });
            }
        }

        if (minutes === 1 || raw.length === 0) {
            // 1m — return as-is, strip timestamps for client
            return res.json(raw.map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })));
        }

        // Aggregate into N-minute candles by bucketing on IST time
        // Bucket key = floor(minuteOfDay / N) so 5m buckets are 09:15,09:20,…
        const buckets = new Map();
        const MS = minutes * 60 * 1000;
        for (const c of raw) {
            // Align to N-minute boundary from epoch (good enough for same-day grouping)
            const key = Math.floor(c.ts / MS) * MS;
            if (!buckets.has(key)) {
                buckets.set(key, { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
            } else {
                const b = buckets.get(key);
                b.high   = Math.max(b.high, c.high);
                b.low    = Math.min(b.low,  c.low);
                b.close  = c.close;      // last close in bucket
                b.volume += c.volume;
            }
        }

        const candles = Array.from(buckets.values());
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
app.post('/api/pcr', requireToken, (req,res) => {
    const {pcr,atmPcr}=req.body;
    if(pcr!=null)    {
        marketState.pcr       = parseFloat(pcr);
        marketState.pcrSignal = pcrLabel(marketState.pcr);
        trackPCRHistory(marketState.pcr);
        marketState.pcrSource = 'manual';   // mark as manual so signal engine uses it
        marketState.pcrManualSetAt = new Date().toISOString(); // FIX: pcr is float, store timestamp separately
        console.log(`[PCR] ✏️ Manual PCR set: ${pcr} (${marketState.pcrSignal})`);
    }
    if(atmPcr!=null) {
        marketState.atmPcr       = parseFloat(atmPcr);
        marketState.atmPcrSignal = pcrLabel(marketState.atmPcr);
        console.log(`[PCR] ✏️ Manual ATM PCR set: ${atmPcr}`);
    }
    // Push update to SSE clients immediately so signal refreshes without waiting for next poll
    sseBroadcast('signal', buildSignalPayload());
    res.json({success:true, pcr: marketState.pcr, pcrSignal: marketState.pcrSignal});
});

// NSE Early Momentum + OI Buildup debug endpoints
app.get('/api/early-momentum', (req,res) => res.json(getEarlyMomState()));
app.get('/api/oi-buildup',     (req,res) => res.json(getOIBuildupState()));
app.get('/api/pcr-state',      (req,res) => res.json(getPCRState()));
// Full day's PCR series (DB-backed, survives restarts) — used by the PCR
// Slope chart so "morning till closing" history isn't lost on a redeploy.
// Falls back to in-memory marketState.pcrHistory if DB isn't configured.
app.get('/api/pcr-history-today', async (req, res) => {
    const dbHistory = await getTodayPCRHistory();
    const history = (dbHistory && dbHistory.length) ? dbHistory : marketState.pcrHistory;
    // Recompute slope from whichever series is actually being returned —
    // marketState.pcrSlope can lag behind a longer DB-sourced series after
    // a mid-day restart (in-memory history resets to empty on every deploy).
    const slope = calcPCRSlope(history);
    res.json({ history, slope, source: (dbHistory && dbHistory.length) ? 'db' : 'memory' });
});
app.get('/api/fii-state',      (req,res) => res.json(getFIIState()));   // debug: raw FII/DII snapshot

// FII DII
app.post('/api/fiidii', requireToken, (req,res) => {
    const {fiiBuy,fiiSell,diiBuy,diiSell}=req.body;
    if(fiiBuy!=null&&fiiSell!=null) marketState.fii={buy:parseFloat(fiiBuy),sell:parseFloat(fiiSell),net:parseFloat((fiiBuy-fiiSell).toFixed(2)),updatedAt:new Date().toISOString()};
    if(diiBuy!=null&&diiSell!=null) marketState.dii={buy:parseFloat(diiBuy),sell:parseFloat(diiSell),net:parseFloat((diiBuy-diiSell).toFixed(2)),updatedAt:new Date().toISOString()};
    marketState.smartMoney = computeSmartMoneyBias();
    // Broadcast instantly to all SSE clients so FII/DII appears without waiting for next poll
    sseBroadcast('signal', buildSignalPayload());
    console.log(`💰 [FII/DII] Manual push — FII Net: ${marketState.fii?.net} | DII Net: ${marketState.dii?.net}`);
    res.json({success:true, fiiNet: marketState.fii?.net, diiNet: marketState.dii?.net});
});

// Option Flow
app.post('/api/optionflow', requireToken, (req,res) => {
    const {atmCE,atmPE}=req.body;
    updateOptionFlow(atmCE?parseFloat(atmCE):null, atmPE?parseFloat(atmPE):null);
    res.json({success:true, dominance:marketState.optionFlow.dominance});
});

// ── TRADE JOURNAL ─────────────────────────────────────
app.post('/api/trade/add', requireToken, async (req,res) => {
    const {type,strike,premium,lots,sl,notes}=req.body;
    const ist=getIST();
    const time=`${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;

    // ── Persist to DB first (if available) so trade survives a Railway restart ──
    let dbId = null;
    if (dbPool) {
        try {
            const r = await dbPool.query(
                `INSERT INTO journal_trades (time,type,strike,premium,lots,sl,notes,nifty_entry,status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN') RETURNING id`,
                [time, type, parseInt(strike), parseFloat(premium),
                 parseInt(lots)||1, parseFloat(sl)||0, notes||'',
                 marketState.nifty||0]
            );
            dbId = r.rows[0].id;
        } catch(e) {
            console.error('Journal DB save error:', e.message);
        }
    }

    const trade = {
        id: dbId ?? tradeCounter++,   // use DB id when available
        time, type, strike:parseInt(strike),
        premium:parseFloat(premium), lots:parseInt(lots)||1,
        sl:parseFloat(sl)||0, exitPremium:null, pnl:null,
        status:'OPEN', notes:notes||'',
        niftyAtEntry:marketState.nifty,
        niftyCurrent:marketState.nifty, niftyMove:0
    };
    trades.push(trade);
    console.log(`📔 Trade saved: ${type} ${strike} @₹${premium} × ${parseInt(lots)||1}lots (DB id:${dbId??'none'})`);
    res.json({success:true, trade});
});

app.post('/api/trade/exit', requireToken, async (req,res) => {
    const rawId=req.body.id;
    const id = typeof rawId === 'string' ? parseInt(rawId, 10) : rawId;
    const {exitPremium}=req.body;
    const trade=trades.find(t=>t.id===id);
    if(!trade) return res.json({success:false,msg:'Not found'});
    trade.exitPremium=parseFloat(exitPremium);
    trade.pnl=parseFloat(((trade.exitPremium-trade.premium)*trade.lots*LOT_SIZE).toFixed(0));
    trade.status='CLOSED';
    const ist=getIST();
    trade.exitTime=`${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;

    // ── Persist exit to DB ────────────────────────────────────────────────────
    if (dbPool) {
        try {
            await dbPool.query(
                `UPDATE journal_trades
                 SET exit_premium=$1, exit_time=$2, pnl=$3, status='CLOSED'
                 WHERE id=$4`,
                [trade.exitPremium, trade.exitTime, trade.pnl, id]
            );
        } catch(e) { console.error('Journal exit DB error:', e.message); }
    }

    console.log(`📔 Exit: P&L ${trade.pnl>=0?'+':''}₹${trade.pnl}`);
    res.json({success:true, trade});
});

app.delete('/api/trade/:id', requireToken, async (req,res) => {
    const tid = parseInt(req.params.id);
    trades = trades.filter(t => t.id !== tid);
    if (dbPool) {
        try {
            await dbPool.query('DELETE FROM journal_trades WHERE id=$1', [tid]);
        } catch(e) { console.error('Journal delete DB error:', e.message); }
    }
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
app.post('/api/telegram/test', requireToken, async (req,res) => {
    if(!isConfigured()) return res.json({success:false,msg:'Not configured — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing'});
    try {
        await sendMorningSummary(marketState);
        res.json({success:true,msg:'Test sent!'});
    } catch (e) {
        console.error('❌ /api/telegram/test failed:', e.message, e.stack);
        res.status(500).json({success:false, msg: e.message || 'Unknown server error'});
    }
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

// ── /api/historical — 1-year Nifty daily OHLCV ───────────────────────────────
// Query params: ?days=252 (default, 1 trading year) | ?days=30 | ?days=90
// Used by: frontend chart tab (1yr view), levels.js (52W SR levels), backtest
app.get('/api/historical', async (req, res) => {
    try {
        const days    = Math.min(parseInt(req.query.days) || 252, 365);
        const candles = await getHistoricalCandles(days);
        res.json({
            days   : candles.length,
            from   : candles[0]?.date   || null,
            to     : candles[candles.length - 1]?.date || null,
            candles,
        });
    } catch (e) {
        res.json({ candles: [], error: e.message });
    }
});

// ── /api/backtest — Signal accuracy analysis against 1-year historical data ──
// Reads signal_log (auto-recorded by Vardaan on every BUY CALL/PUT fire)
// and checks how Nifty actually moved the next day.
// WIN  = price moved >= 0.3% in signal direction
// LOSS = price moved >= 0.3% against signal
// Query params:
//   ?signal=BUY+CALL   filter by direction
//   ?gate=true          only quality-gate-passed signals
//   ?minConf=65         minimum confidence threshold
//   ?limit=200          max signals to analyze (default 200)
app.get('/api/backtest', async (req, res) => {
    try {
        const result = await runBacktest({
            signalType: req.query.signal || null,
            gateOnly  : req.query.gate   === 'true',
            minConf   : parseInt(req.query.minConf) || 0,
            limit     : Math.min(parseInt(req.query.limit) || 200, 500),
        });
        res.json(result);
    } catch (e) {
        res.json({ error: e.message });
    }
});

// ── /api/historical/topup — manual trigger to refresh historical data ─────────
app.post('/api/historical/topup', requireToken, async (req, res) => {
    try {
        await histDailyTopUp();
        const candles = await getHistoricalCandles(365);
        res.json({ success: true, count: candles.length, latest: candles[candles.length - 1]?.date });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ── Init ──────────────────────────────────────────────
let _intervalsStarted     = false;
let _angelLoggedIn        = false;   // true once Angel session is injected
let _initSequenceComplete = false;   // true once initializeLiveData() finishes; gates retry-only logic

function startPollingIntervals() {
    if (_intervalsStarted) return;          // guard — only ever runs once
    _intervalsStarted = true;
    // Stagger intervals by 30s each so they never all fire at the same time.
    // This prevents NSE from seeing a burst of 6 requests every 3 minutes.
    setTimeout(() => setInterval(refreshMarketData, 3*60*1000), 0);
    setTimeout(() => setInterval(pollYahooPrice,    60*1000),   15*1000); // 1-min price fix
    setTimeout(() => setInterval(refreshMTF,            2*60*1000), 30*1000);   // FIX: 5min→2min — RSI meters stay fresh
    setTimeout(() => setInterval(refreshGlobal,         2*60*1000), 60*1000);   // FIX: 5min→2min — BankNifty lead actually leads
    setTimeout(() => setInterval(refreshBreadth,        2*60*1000), 90*1000);   // 2 min — breadth is fast-changing
    setTimeout(() => setInterval(refreshSR,            10*60*1000), 120*1000);
    setTimeout(() => setInterval(refreshPCR,            3*60*1000), 150*1000);
    setTimeout(() => setInterval(refreshFyersVolume,      15*1000), 20*1000);   // real volume/OHLC via Fyers (Angel WS sends 0 for index)
    setTimeout(() => setInterval(syncFIIToMarketState, 20*60*1000), 5*1000);    // FIX: sync FII always, even after market close
    setTimeout(() => setInterval(fetchCalendarEvents, 60*60*1000), 180*1000); // refresh calendar hourly

    // ── ROOT CAUSE FIX — Periodic full-state SSE broadcast ────────────────────
    // BUG: sseBroadcast('signal', buildSignalPayload()) was ONLY called when a
    // new signal got saved to the DB (signal-change events). The 'tick' event
    // updates price/change every second (working fine), but VIX, RSI, PCR, ADX,
    // signal card, MTF, breadth, global, physics, suggested-trade, S/R levels —
    // everything that reads from the 'signal' SSE event — stayed FROZEN at
    // whatever value was present at the last signal-change, even though
    // refreshMTF/refreshGlobal/refreshBreadth/refreshPCR were updating
    // marketState correctly in memory every 2-3 min (confirmed in logs).
    // Fix: push the full payload every 5s regardless of signal change, so the
    // dashboard, breadth tab, global tab, physics tab, and guard tab all stay
    // live. The 'tick' event keeps handling sub-second price flashes.
    setInterval(() => {
        if (_sseClients.size > 0) {
            try { sseBroadcast('signal', buildSignalPayload()); } catch(e) { console.warn('[SSE periodic] broadcast error:', e.message); }
        }
    }, 5000);
    // DISABLED (per user request, July 2026): check920Setup() is a fully separate,
    // 1-minute-EMA/VWAP-only opening check that runs independently of the main
    // signal engine (which already has Trend Lock, Delta veto, MTF alignment,
    // ORB, etc.). Because 1-minute data is noisy, it frequently disagreed with
    // a legitimate STRONG signal from the main engine within the same minute —
    // e.g. a "STRONG BUY CALL — ALL 3 ALIGNED (83%)" at 9:19 AM followed by a
    // "9:20 SETUP — NO TRADE (mixed 1m signals)" at 9:20 AM, for the SAME move,
    // which later hit its target. That contradiction created exactly the kind
    // of uncertainty/fear that causes good signals to be skipped. The main
    // engine's own gates already cover this ground more reliably.
    // setInterval(() => {
    //     const ist = getIST();
    //     const istMin = ist.getHours() * 60 + ist.getMinutes();
    //     if (istMin >= 555 && istMin <= 575) check920Setup();  // 9:15–9:35 window only
    // }, 30*1000);
    startTickWatchdog(); // ← watchdog: detects silent WS freeze, falls back to Yahoo
    // Daily 6 PM IST top-up — fetch any new daily candles from Yahoo Finance
    setTimeout(() => setInterval(async () => {
        const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        if (ist.getHours() === 18 && ist.getMinutes() < 5) {
            console.log('[HistData] Daily 6PM top-up starting...');
            await histDailyTopUp();
        }
    }, 5 * 60 * 1000), 10000); // check every 5 min
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
        injectAngelSessionNSE({
            jwtToken : auth.jwtToken,
            apiKey   : process.env.ANGEL_API_KEY,
        });
        // Fire initial PCR fetch NOW — Angel session is ready so the Angel Market
        // Data path will work. Without this, first PCR fires 3 min after startup
        // (the scheduler interval), which is too late if container restarts.
        // FIX: marketState.nifty may be 0 at startup (price not yet fetched from websocket/REST).
        // Retry with 5s delay to allow nifty price to populate first.
        if (marketState.nifty > 0) {
            triggerInitialPCR(marketState.nifty);
        } else {
            setTimeout(() => {
                const spot = marketState.nifty || 0;
                if (spot > 0) {
                    console.log(`[PCR] Delayed initial PCR trigger — spot now ${spot}`);
                    triggerInitialPCR(spot);
                } else {
                    // Still 0 — wait for first tick then fire (max 30s)
                    let _pcrRetries = 0;
                    const _pcrRetryTimer = setInterval(() => {
                        _pcrRetries++;
                        if (marketState.nifty > 0) {
                            clearInterval(_pcrRetryTimer);
                            console.log(`[PCR] Retry #${_pcrRetries}: firing initial PCR at spot ${marketState.nifty}`);
                            triggerInitialPCR(marketState.nifty);
                        } else if (_pcrRetries >= 6) {
                            clearInterval(_pcrRetryTimer);
                            console.warn('[PCR] Initial PCR skipped — no spot price after 30s');
                        }
                    }, 5000);
                }
            }, 5000);
        }
        startWebSocket(auth, onTick);
        _angelLoggedIn = true;
        // On retry logins (after init is complete), immediately refresh breadth
        // with the real Angel Nifty50 data. During initial startup this is skipped
        // because initializeLiveData() calls refreshBreadth() 2s after tryAngelLogin()
        // returns — firing it here too causes the double A/D fetch seen in logs.
        if (_initSequenceComplete) {
            refreshBreadth(true).catch(e => console.error('Post-login breadth error:', e.message));
        }
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

    // DB init — awaited so dbPool is guaranteed ready before journal reload below.
    // Previously fire-and-forget (.catch) which caused a race: journal reload ran
    // before tables existed on a slow Railway DB connection.
    await initDB().catch(e => console.error('DB init error:', e.message));

    // ── Initialize 1-year historical data (non-blocking background task) ─────
    // First run: seeds 365 days from Yahoo Finance into PostgreSQL (~5-10s).
    // Subsequent runs: checks for gaps, tops up missing days only.
    // Does NOT block server startup — data loads in background.
    initHistoricalData().catch(e => console.error('[HistData] Init error:', e.message));

    // NSE scheduler fires its own async fetches (non-blocking per nseData.js fix)
    startNSEScheduler(() => marketState.nifty, () => marketState.global?.sectors?.bankNifty?.price ?? null);

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

    // ── Angel login BEFORE breadth ────────────────────────────────────────────
    // Login is attempted here with a 12s timeout. On success, Tier 1 Angel data
    // is used for the refreshBreadth() call below (real 50 stocks, not 10 sectors).
    // On timeout/failure, tryAngelLogin() keeps retrying internally every 30s and
    // calls refreshBreadth() automatically when it eventually succeeds.
    await withTimeout(tryAngelLogin(), 20000, 'angelLogin');  // FIX: 12s was too tight on Railway cold start — increased to 20s

    await new Promise(r => setTimeout(r, 2000));
    await withTimeout(refreshBreadth(true),    20000, 'refreshBreadth');
    await new Promise(r => setTimeout(r, 2000));
    await withTimeout(refreshMTF(), 20000, 'refreshMTF');
    await new Promise(r => setTimeout(r, 2000));
    await Promise.all([
        withTimeout(refreshSR(),  15000, 'refreshSR'),
        withTimeout(refreshPCR(), 15000, 'refreshPCR'),
    ]);
    syncFIIToMarketState(); // FIX: ensure FII/DII shows on breadth tab even after market close
    await withTimeout(fetchCalendarEvents(), 10000, 'fetchCalendarEvents');

    // ── Reload persisted journal trades from DB into memory ─────────────────
    // journal_trades rows survive Railway restarts. Re-populate trades[] so the
    // in-memory array (used for real-time MTM tracking) matches the DB on boot.
    if (dbPool) {
        try {
            const jRows = await dbPool.query(
                `SELECT * FROM journal_trades ORDER BY id ASC`
            );
            for (const row of jRows.rows) {
                trades.push({
                    id           : row.id,
                    time         : row.time,
                    type         : row.type,
                    strike       : row.strike,
                    premium      : parseFloat(row.premium),
                    lots         : row.lots,
                    sl           : parseFloat(row.sl || 0),
                    notes        : row.notes || '',
                    niftyAtEntry : parseFloat(row.nifty_entry || 0),
                    niftyCurrent : 0,
                    niftyMove    : 0,
                    exitPremium  : row.exit_premium ? parseFloat(row.exit_premium) : null,
                    exitTime     : row.exit_time || null,
                    pnl          : row.pnl ? parseFloat(row.pnl) : null,
                    status       : row.status || 'OPEN',
                });
                if (row.id >= tradeCounter) tradeCounter = row.id + 1;
            }
            console.log(`📔 Reloaded ${jRows.rows.length} journal trades from DB`);
        } catch(e) {
            console.error('Journal reload error:', e.message);
        }
    }

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

    _initSequenceComplete = true; // allow retry-login path to call refreshBreadth() independently

    // Note: if the withTimeout above resolved null (login still in-flight or slow),
    // tryAngelLogin() is ALREADY running in the background — it will call
    // refreshBreadth() automatically when it succeeds. No need to call it again.
}

// ── Listen FIRST so the frontend is never blocked by init ────────────────────
// initializeLiveData() runs in the background. The frontend gets the default
// marketState (nifty:0, signal:'WAIT') immediately, then live data populates
// within 3-20 seconds as each fetch completes.
server.listen(PORT, () => {
    console.log(`VardaanNifty AI running on port ${PORT}`);
    server.keepAliveTimeout = 120000;
    server.headersTimeout   = 125000;
    // Print outgoing IP for reference
    axios.get('https://api.ipify.org?format=json', { timeout: 5000 })
        .then(r => console.log(`[Railway] Outgoing IP: ${r.data.ip}`))
        .catch(() => console.log('[Railway] Could not fetch outgoing IP'));
    // Fyers startup status
    const fyersAppId  = (process.env.FYERS_APP_ID        || '').trim();
    const fyersToken  = (process.env.FYERS_ACCESS_TOKEN  || '').trim();
    const fyersRefresh= (process.env.FYERS_REFRESH_TOKEN || '').trim();
    if (fyersAppId && fyersRefresh) {
        console.log(`[Fyers] ✅ AppID + RefreshToken present — auto-refresh enabled (token refreshes on each restart)`);
    } else if (fyersAppId && !fyersRefresh) {
        const authUrl = `https://api-t1.fyers.in/api/v3/generate-authcode?client_id=${fyersAppId}&redirect_uri=https://trade.fyers.in/api-login/redirect-uri/index.html&response_type=code&state=vardaannifty`;
        console.log(`[Fyers] ⚠️  FYERS_REFRESH_TOKEN missing! Generate tokens at: ${authUrl}`);
    }
    if (fyersToken) {
        console.log(`[Fyers] ✅ Access token present (${fyersToken.slice(0,10)}...) — PCR via Fyers enabled`);
    }
    // Start init AFTER server is already accepting connections
    initializeLiveData().catch(e => console.error('Init error:', e.message));
});
// ── Process-level error guards ────────────────────────────────────────────────
// Without these, async errors that escape all try/catch blocks silently kill
// the Node process on Railway, producing an unexplained container restart.
// These handlers log the full stack so the cause is visible in Railway logs.
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Unhandled Rejection at:', promise, '— reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err.message, err.stack);
    // Do NOT call process.exit() — Railway restarts anyway, and exiting here
    // drops all in-flight requests. Let Node keep running unless it's truly fatal.
});