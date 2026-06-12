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
        calcMomentumBreakdown }                      = require('./src/api/indicators');
const { fetchMarketData }           = require('./src/api/marketData');
const { analyzeMultiTimeframe }     = require('./src/api/multiTimeframe');
const { fetchGlobalCues }           = require('./src/api/globalCues');
const { fetchAdvanceDecline,
        injectAngelSession }        = require('./src/api/breadth');
const { calculateSRLevels }         = require('./src/api/levels');
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
    injectAngelSession: injectAngelSessionNSE,   // nseData Angel session for PCR
    triggerInitialPCR,                            // fire first PCR after Angel login
} = require('./src/api/nseData');
const {
    sendSignalAlert, sendMTFAlert,
    sendMorningSummary, sendVIXAlert,
    sendCloseSummary, sendExitAlert,
    sendNishanebaazAlert, sendRawMessage, isConfigured
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
    calendarEvents: [],
    btst: null,
    momentum: { signal: 'NONE', strength: 0, velocity: 0, volumeRatio: 0, candleBody: 0, reason: '', canTrade: false },
    smartMoney: { bias: 'NEUTRAL', score: 0, label: 'Smart Money — awaiting data', components: [] },
};

// ── Trade Journal ─────────────────────────────────────
let trades       = [];
let tradeCounter = 1;
let events       = [];

// ── Helpers ───────────────────────────────────────────
let historyLoaded=false, prevSignal='WAIT', prevMTFAligned=false;
let morningSummarySent=false, closeSummarySent=false, vixAlertSent=false;
let nishanebaazAlertSent=false;  // one-shot: fired once at 14:00 per day
let pcrClearedToday=false;   // guards the one-shot stale-manual-PCR wipe at 09:15
let signalStreak = { signal: 'WAIT', count: 0 }; // consecutive same-signal counter
let btstSentToday=false;     // one-shot: BTST/STBT Telegram alert per day
let telegramAlertInFlight=false; // race-condition guard — prevents duplicate sends when onTick fires concurrently
let ema920AlertSentToday=false;  // one-shot: 9:20 AM EMA-VWAP setup alert per day

function isMarketOpen() {
    const ist = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}));
    const day = ist.getDay();
    if (day === 0 || day === 6) return false;  // weekend
    const yyyy = ist.getFullYear(), mm = String(ist.getMonth()+1).padStart(2,'0'), dd = String(ist.getDate()).padStart(2,'0');
    // NSE holidays — keep in sync with nseData.js NSE_HOLIDAYS set
    const NSE_HOLIDAYS_SRV = new Set(['2026-01-26','2026-02-19','2026-03-25','2026-04-01','2026-04-10','2026-04-14','2026-05-01','2026-08-15','2026-10-02','2026-10-20','2026-10-24','2026-11-04','2026-11-05','2026-12-25']);
    if (NSE_HOLIDAYS_SRV.has(`${yyyy}-${mm}-${dd}`)) return false;
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

// NSE 2026 official market holidays (exchange closed)
// Source: NSE circular + verified against official NSE website
const NSE_HOLIDAYS_2026 = new Set([
    '2026-01-26',  // Republic Day
    '2026-03-02',  // Holi
    '2026-03-20',  // Ram Navami (Shri Ram Navami)  ← some sources say Mar 26; verify
    '2026-04-02',  // Mahavir Jayanti
    '2026-04-03',  // Good Friday
    '2026-04-14',  // Dr. Baba Saheb Ambedkar Jayanti
    '2026-05-01',  // Maharashtra Day
    '2026-05-28',  // Bakri Id (Eid ul-Adha)
    '2026-06-26',  // Muharram
    '2026-08-15',  // Independence Day (Saturday — already weekend, no extra closure)
    '2026-09-14',  // Ganesh Chaturthi
    '2026-10-02',  // Mahatma Gandhi Jayanti
    '2026-10-20',  // Dussehra
    '2026-11-10',  // Diwali Balipratipada
    '2026-11-24',  // Guru Nanak Jayanti
    '2026-12-25',  // Christmas
]);

// NSE 2027 PROJECTED holidays — based on fixed national holidays + calculated religious dates.
// ⚠️  NSE publishes the official list in Nov/Dec of the preceding year.
//     VERIFY and update this list once the official NSE circular is released (expected Nov 2026).
// Fixed holidays confirmed: Republic Day (Jan 26), Independence Day (Aug 15),
//   Gandhi Jayanti (Oct 2), Christmas (Dec 25).
// Religious dates are calculated from the Islamic/Hindu calendar and match
//   the Drik Panchang / calendarlabs.com 2027 projections — subject to moon sighting.
const NSE_HOLIDAYS_2027 = new Set([
    '2027-01-26',  // Republic Day (Tuesday)
    '2027-02-17',  // Maha Shivratri (Wednesday) — projected
    '2027-03-05',  // Holi (Friday) — projected
    '2027-03-19',  // Id-ul-Fitr / Eid (Friday) — projected (moon-sighting dependent)
    '2027-03-26',  // Good Friday (Friday)
    '2027-03-29',  // Mahavir Jayanti (Monday) — projected
    '2027-04-14',  // Dr. Baba Saheb Ambedkar Jayanti (Wednesday)
    '2027-05-01',  // Maharashtra Day (Saturday — already weekend, kept for completeness)
    '2027-05-17',  // Bakri Id / Eid ul-Adha (Monday) — projected
    '2027-06-06',  // Muharram (Sunday — likely no extra closure if on weekend)
    '2027-08-15',  // Independence Day (Sunday — already weekend)
    '2027-09-02',  // Ganesh Chaturthi (Thursday) — projected
    '2027-10-02',  // Mahatma Gandhi Jayanti (Saturday — already weekend)
    '2027-10-08',  // Dussehra (Friday) — projected
    '2027-10-29',  // Diwali Laxmi Pujan (Friday) — projected
    '2027-10-30',  // Diwali Balipratipada (Saturday — already weekend)
    '2027-11-13',  // Guru Nanak Jayanti (Saturday — already weekend)
    '2027-12-24',  // Christmas observed (Friday, as Dec 25 is Saturday) — TBC
    '2027-12-25',  // Christmas Day (Saturday)
]);

function isNSEHoliday(date) {
    const ist = date || new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const yyyy = ist.getFullYear();
    const mm   = String(ist.getMonth() + 1).padStart(2, '0');
    const dd   = String(ist.getDate()).padStart(2, '0');
    const key  = `${yyyy}-${mm}-${dd}`;
    if (yyyy === 2026) return NSE_HOLIDAYS_2026.has(key);
    if (yyyy === 2027) {
        // Using projected list — warn once per day if running in 2027 without official update
        if (mm === '01' && dd === '01') {
            console.warn('[isNSEHoliday] Using PROJECTED 2027 holidays — verify against official NSE circular!');
        }
        return NSE_HOLIDAYS_2027.has(key);
    }
    // Beyond 2027: log warning, treat every weekday as trading day (conservative fallback)
    console.warn(`[isNSEHoliday] No holiday data for ${yyyy} — update NSE_HOLIDAYS_${yyyy} before year start.`);
    return false;

}

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

    // ── Candle Pattern ────────────────────────────────────────────────────────
    // Adds 1-3 votes depending on pattern strength.
    // Strong patterns (Engulfing str=3) = 2 votes, moderate (Hammer str=2) = 1 vote.
    const cp = detectCandlePattern();
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
    // candlePattern already set in scoring block above

    const adxVal      = adxData?.adx ?? null;

    // ── ADX Breakout Override — catches trending days where 1h ADX lags ──────
    // Problem (observed June 12): Nifty rallied 400pts but 1h ADX stayed <20 until
    // 14:22 IST because Wilder's smoothing takes 30-45 mins to respond to a breakout.
    // The signal fired late (14:22) after most of the move was done.
    // Fix: If 15m ADX >= 22 AND 5m ADX >= 25, the short-term trend is clearly strong
    // enough to trade even if 1h ADX hasn't caught up yet.
    // This is the "breakout exception" — we still require BOTH shorter TFs to confirm
    // strongly, so it doesn't fire on random noise.
    const adx5m  = marketState.mtf?.tf5m?.adx  ?? null;
    const adx15m = marketState.mtf?.tf15m?.adx ?? null;
    const shortTfBreakout = (adx15m !== null && adx15m >= 22) && (adx5m !== null && adx5m >= 25);

    // adxTooWeak: block when 1m ADX < 20 UNLESS short-TF breakout exception fires
    const adxTooWeak  = adxVal !== null && adxVal < 20 && !shortTfBreakout;

    if (shortTfBreakout && adxVal !== null && adxVal < 20) {
        reasons.push(`⚡ Breakout exception: 5m ADX ${adx5m?.toFixed(1)} + 15m ADX ${adx15m?.toFixed(1)} strong — 1h ADX lag waived`);
    }

    if (adxVal !== null) {
        if      (adxVal >= 40) reasons.push(`🔥 ADX ${adxVal} — Explosive trend (wider SL advised)`);
        else if (adxVal >= 25) reasons.push(`📈 ADX ${adxVal} — Strong trend confirmed ✅`);
        else if (adxVal >= 20) reasons.push(`⚠️ ADX ${adxVal} — Trend forming (weak, confidence capped 60%)`);
        // <20 handled in gate reason below — no need to add here
    }

    const qualityGate = {
        // 1. All three timeframes must agree (with ADX ≥ 20 per TF)
        mtfAligned : marketState.mtf.aligned,

        // 2. RSI multi-timeframe filter:
        //    CALL entry: 15m RSI > 55 AND 5m RSI > 55 (trend + entry alignment)
        //    PUT  entry: 15m RSI < 45 AND 5m RSI < 45
        //    Also: 1m RSI must not be stretched (< 70 for calls, > 30 for puts)
        //    If MTF RSI is null (data not yet loaded), fall back to 1m RSI check only.
        rsiClean   : (() => {
            if (rawSignal === 'WAIT') return true;
            const rsi5m  = marketState.mtf?.tf5m?.rsi  ?? null;
            const rsi15m = marketState.mtf?.tf15m?.rsi ?? null;
            if (rawSignal === 'BUY CALL') {
                const mtfOk = (rsi15m === null || rsi15m > 55) && (rsi5m === null || rsi5m > 55);
                const notOverbought = rsi === null || rsi < 70;
                return mtfOk && notOverbought;
            }
            if (rawSignal === 'BUY PUT') {
                const mtfOk = (rsi15m === null || rsi15m < 45) && (rsi5m === null || rsi5m < 45);
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
        //    null  = not evaluated (rawSignal was already WAIT, no entry to protect).
        //    true  = evaluated and clear.
        //    false = blocked (set inside the gate block below).
        srClear    : rawSignal !== 'WAIT' ? true : null
    };
    // qualityGate.passed is computed AFTER the S/R block so srClear=false cannot produce stale passed=true

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

    // Recompute passed HERE — srClear may have been flipped to false inside the gate block above.
    qualityGate.passed = qualityGate.mtfAligned && qualityGate.rsiClean
                      && qualityGate.safeWindow  && qualityGate.vixSafe
                      && qualityGate.adxTrend    && (qualityGate.srClear !== false);
    marketState.qualityGate = qualityGate;

    // ── ADX weak-trend confidence cap ────────────────────────────────────────
    // Signal passes gate (ADX 20–25) but trend is not fully confirmed.
    // Cap confidence at 60% so the UI doesn't show a strong conviction call.
    if (signal !== 'WAIT' && adxVal !== null && adxVal < 25) {
        const before = confidence;
        confidence = Math.min(confidence, 60);
        if (confidence < before) reasons.push(`⚠️ Confidence capped at 60% — ADX ${adxVal} < 25 (trend weak, full size risky)`);
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

        // Grade
        const grade = qs >= 80 ? 'A+' : qs >= 65 ? 'A' : qs >= 50 ? 'B' : qs >= 35 ? 'C' : 'D';
        const gradeColor = qs >= 80 ? '🟢' : qs >= 65 ? '🟢' : qs >= 50 ? '🟡' : '🔴';

        marketState.entryQuality = { score: qs, grade, gradeColor, breakdown: scoreBreakdown };
        // Add to reasons for display
        reasons.push(`${gradeColor} Entry Quality: ${qs}/100 (${grade}) — ${scoreBreakdown.slice(0,3).join(' | ')}`);
    } else {
        marketState.entryQuality = { score: 0, grade: '-', gradeColor: '⚪', breakdown: [] };
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
// Strategy: After 9:15 first candle closes, check EMA9 + EMA21 vs VWAP.
//   Both below VWAP → PUT setup (bearish bias confirmed)
//   Both above VWAP → CALL setup (bullish bias confirmed)
//   Mixed            → NO TRADE (indecisive — stay out)
//
// Why 9:20 AM?
//   9:15 candle is noise — institutional orders still settling.
//   9:20 first 5-min candle has closed — real direction established.
//   Premium is still cheap before big players show their hand.
//
// Rules enforced:
//   1. Fires ONCE per day only (ema920AlertSentToday flag)
//   2. Window: 9:20–9:30 AM only (10 min window, after that skip)
//   3. Requires NIFTY price > 0 (live data must be available)
//   4. EMA9 AND EMA21 must BOTH be on same side of VWAP (no mixed signals)
// ═══════════════════════════════════════════════════════════════════════════════
async function check920Setup() {
    if (!isConfigured()) return;
    if (ema920AlertSentToday) return;

    const ist  = getIST();
    const mins = ist.getHours() * 60 + ist.getMinutes();
    if (mins < 560 || mins > 570) return;  // 9:20–9:30 AM only

    const { nifty, ema9, ema21, vwap } = marketState;
    if (!nifty || nifty <= 0 || !ema9 || !ema21 || !vwap) return;

    const atmStrike = Math.round(nifty / 50) * 50;
    const vwapFmt   = vwap.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const ema9Fmt   = ema9.toFixed(2);
    const ema21Fmt  = ema21.toFixed(2);
    const niftyFmt  = nifty.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const pcrLine   = marketState.pcr ? `PCR: ${marketState.pcr} (${marketState.pcrSignal})` : 'PCR: Fetching...';
    const vixLine   = marketState.vix ? `VIX: ${marketState.vix} — ${marketState.vixSignal}` : 'VIX: --';

    // PRIMARY signal: PRICE vs VWAP (freshest — resets daily at 9:15)
    // CONFIRMATION: EMA9 + EMA21 both on same side
    // All 3 must agree → clean setup. Any mismatch → NO TRADE.
    // (Old version used only EMA vs VWAP — wrong because EMA carries multi-day history)
    const priceAbove = nifty > vwap;
    const ema9Above  = ema9  > vwap;
    const ema21Above = ema21 > vwap;

    // ── CALL SETUP ────────────────────────────────────────────────────────────
    if (priceAbove && ema9Above && ema21Above) {
        ema920AlertSentToday = true;
        await sendRawMessage(
`🟢 <b>VARDAAN 9:20 SETUP — CALL BUY</b>

✅ Price (${niftyFmt}) ABOVE VWAP (${vwapFmt})
✅ EMA9 (${ema9Fmt}) ABOVE VWAP
✅ EMA21 (${ema21Fmt}) ABOVE VWAP
📈 All 3 bullish — strong setup confirmed

🎯 <b>Action: BUY ${atmStrike} CE (ATM)</b>
💰 Target: +25–30% premium gain
🛑 Stop Loss: −20% premium loss
⏰ Time Stop: Exit by 11:00 AM

${pcrLine} | ${vixLine}

⚠️ <b>1 TRADE ONLY TODAY — No revenge trading</b>`);
        console.log(`📱 [9:20] CALL SETUP | Price:${niftyFmt} EMA9:${ema9Fmt} EMA21:${ema21Fmt} > VWAP:${vwapFmt}`);
        return;
    }

    // ── PUT SETUP ─────────────────────────────────────────────────────────────
    if (!priceAbove && !ema9Above && !ema21Above) {
        ema920AlertSentToday = true;
        await sendRawMessage(
`🔴 <b>VARDAAN 9:20 SETUP — PUT BUY</b>

✅ Price (${niftyFmt}) BELOW VWAP (${vwapFmt})
✅ EMA9 (${ema9Fmt}) BELOW VWAP
✅ EMA21 (${ema21Fmt}) BELOW VWAP
📉 All 3 bearish — strong setup confirmed

🎯 <b>Action: BUY ${atmStrike} PE (ATM)</b>
💰 Target: +25–30% premium gain
🛑 Stop Loss: −20% premium loss
⏰ Time Stop: Exit by 11:00 AM

${pcrLine} | ${vixLine}

⚠️ <b>1 TRADE ONLY TODAY — No revenge trading</b>`);
        console.log(`📱 [9:20] PUT SETUP | Price:${niftyFmt} EMA9:${ema9Fmt} EMA21:${ema21Fmt} < VWAP:${vwapFmt}`);
        return;
    }

    // ── NO TRADE: Mixed signals ───────────────────────────────────────────────
    ema920AlertSentToday = true;
    const pricePos = priceAbove ? 'ABOVE' : 'BELOW';
    const ema9pos  = ema9Above  ? 'above' : 'below';
    const ema21pos = ema21Above ? 'above' : 'below';
    await sendRawMessage(
`⚪ <b>VARDAAN 9:20 SETUP — NO TRADE</b>

⚠️ Mixed signals — market indecisive at open
Price (${niftyFmt}) is ${pricePos} VWAP (${vwapFmt})
EMA9 (${ema9Fmt}) is ${ema9pos} VWAP
EMA21 (${ema21Fmt}) is ${ema21pos} VWAP

❌ <b>Not all 3 aligned — skip opening trade today</b>
💡 Wait for 10:30 AM cleaner setup or sit out

${vixLine}`);
    console.log(`📱 [9:20] NO TRADE | Price:${priceAbove?'↑':'↓'} EMA9:${ema9Above?'↑':'↓'} EMA21:${ema21Above?'↑':'↓'} vs VWAP:${vwapFmt}`);
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
    if (h===9&&m>=16&&m<=20&&!morningSummarySent) { morningSummarySent=true; await sendMorningSummary(marketState); return; }
    if (h===14&&m===0&&!nishanebaazAlertSent) { nishanebaazAlertSent=true; await sendNishanebaazAlert(marketState); }
    if (h===15&&m>=30&&!closeSummarySent) {
        closeSummarySent=true;
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
    } finally {
        telegramAlertInFlight = false;
    }
}

async function updatePrice(price, change, changePct, source) {
    const indicators=processIndicators(price, marketState.global?.bankNiftyLeadSignal ?? null);
    const { signal, confidence, reasons }=combineSignals(indicators);
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
    marketState.rsi=indicators.rsi; marketState.ema9=indicators.ema9;
    marketState.ema21=indicators.ema21; marketState.vwap=indicators.vwap;
    marketState.reason=reasons; marketState.lastUpdated=new Date().toISOString();
    marketState.connected=true; marketState.source=source; marketState.dataPoints=indicators.priceCount;
    marketState.candleSource=getCandleSource();
    // ── Smart Money Bias ──────────────────────────────────────────────────────
    marketState.smartMoney = computeSmartMoneyBias();
    if (source==='yahoo') console.log(`NIFTY:${price} RSI:${indicators.rsi||'--'} → ${signal}(${confidence}%)`);
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
    // On weekends/outside hours: still poll price (keeps app responsive)
    // but all heavy processing is skipped via isNSEMarketDay() guards above
    if (!isMarketOpen()) return;
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
        if (!isMarketOpen()) return;
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
    const lastKnown = marketState.nifty;
    if (lastKnown > 0) {
        const pctMove = Math.abs((price - lastKnown) / lastKnown) * 100;
        if (pctMove > 5) {
            console.warn(`[WS] Tick rejected: ${price} is ${pctMove.toFixed(1)}% from last known ${lastKnown} — possible wrong packet offset`);
            return;
        }
    }

    _lastTickAt = Date.now();  // update watchdog timestamp on every tick

    // ── Throttle: update price display on every tick, but only run full ───────
    // indicator calculation (ADX/EMA/RSI/VWAP) once per second to avoid spam
    const now = Date.now();
    const runIndicators = (now - _lastIndicatorRun) >= 1000;
    if (runIndicators) _lastIndicatorRun = now;

    const prev=marketState.nifty||price, change=parseFloat((price-prev).toFixed(2));
    const chgPct=prev>0?parseFloat(((change/prev)*100).toFixed(2)):0;

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
    }
}

async function refreshMarketData() {
    if (!isNSEMarketDay()) {
        console.log('[Scheduler] Outside market hours — skipping refreshMarketData');
        return;
    }
    // When market is closed, preserve last known price as lastClose so the
    // frontend can show "23,382 · CLOSED" instead of blank "--".
    if (!isMarketOpen()) {
        if (marketState.nifty > 0) {
            marketState.lastClose = marketState.nifty;  // save before zeroing
            marketState.nifty     = 0;
            marketState.change    = 0;
            marketState.changePct = 0;
            marketState.connected = false;
            marketState.source    = 'none';
        }
        marketState.marketClosed = true;
    } else {
        marketState.marketClosed = false;
    }
    const { niftyData, vixData }=await fetchMarketData();
    if (niftyData?.closes?.length>0&&!historyLoaded) { initializeHistory(niftyData.closes,niftyData.candles); historyLoaded=true; console.log(`History: ${niftyData.closes.length} candles`); }
    if (vixData) { marketState.vix=vixData.vix; marketState.vixChange=vixData.change; marketState.vixSignal=vixData.signal; marketState.vixNote=vixData.note; marketState.strikeRange=vixData.strikeRange; }
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
            signal        : preMarket ? 'NEUTRAL' : d.mtfSignal,
            strength      : preMarket ? 'WEAK'    : d.mtfStrength,
            confidence    : preMarket ? 0         : d.mtfConfidence,
            aligned       : preMarket ? false      : d.aligned,
            bullCount     : preMarket ? 0          : d.bullCount,
            bearCount     : preMarket ? 0          : d.bearCount,
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
    } catch(e) { console.error('MTF:', e.message); }
}
async function refreshGlobal() { try { const g=await fetchGlobalCues(); if(g) marketState.global=g; } catch(e) { console.error('Global:',e.message); } }
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

        // ── Inject DB pool into historical data module ────────────────────────
        injectHistDBPool(dbPool);
        console.log('✅ Historical data module connected to DB');
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
    // FIX: OTM premium no longer uses hardcoded 0.55× multiplier.
    // For ATM: use live NSE LTP directly (most accurate).
    // For OTM+50: calculate with Black-Scholes using REAL DTE so premium is meaningful.
    // The 0.55× approximation was off by 20–40% depending on IV and DTE.
    const dte = daysToNextExpiry();   // real days to next Tuesday expiry
    let entryPremium = null;
    if (pcrState && pcrState.atmCEpremium && pcrState.atmPEpremium) {
        if (type === 'CE') {
            entryPremium = strike === atm
                ? pcrState.atmCEpremium
                : (vix ? parseFloat(bsEstimate(nifty, strike, dte / 365, vix / 100, 'CE').toFixed(2)) : null);
        } else {
            entryPremium = strike === atm
                ? pcrState.atmPEpremium
                : (vix ? parseFloat(bsEstimate(nifty, strike, dte / 365, vix / 100, 'PE').toFixed(2)) : null);
        }
    }

    // If no live premium available, use Black-Scholes with real DTE (not hardcoded 3 days)
    if (!entryPremium && vix) {
        const sigma = vix / 100;
        const T = dte / 365;  // FIX: real days to expiry, not hardcoded 3
        entryPremium = parseFloat(bsEstimate(nifty, strike, T, sigma, type).toFixed(2));
    }

    if (!entryPremium || entryPremium <= 0) return null;

    // ── VIX-dynamic SL (Murarka strategy) ────────────────────────────────────
    // Flat 25% SL is too tight on high-VIX days (frequent noise stops) and
    // too loose on calm days (poor R:R). Scale SL width with realised volatility:
    //   VIX < 12  → 20% SL (tight, calm market, premiums cheap)
    //   VIX 12-16 → 25% SL (baseline)
    //   VIX 16-20 → 30% SL (wider, more premium noise)
    //   VIX > 20  → 35% SL (very wide, but signal is blocked by gate anyway)
    // Target always = SL risk × 2 (1:2 R:R) from entry.
    let slPct = 0.25;  // default
    if (vix) {
        if      (vix < 12) slPct = 0.20;
        else if (vix < 16) slPct = 0.25;
        else if (vix < 20) slPct = 0.30;
        else               slPct = 0.35;
    }
    const slWidth  = parseFloat((entryPremium * slPct).toFixed(2));
    const sl       = parseFloat((entryPremium - slWidth).toFixed(2));
    const target   = parseFloat((entryPremium + slWidth * 2).toFixed(2));  // 1:2 R:R

    return { type, strike, entry: entryPremium, sl, target };
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

    // Heartbeat every 25s — keeps Railway/proxy from closing idle connection
    const hb = setInterval(() => {
        try { res.write(':heartbeat\n\n'); } catch(_) { clearInterval(hb); }
    }, 25000);

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
    setTimeout(() => setInterval(refreshMTF,            5*60*1000), 30*1000);
    setTimeout(() => setInterval(refreshGlobal,         5*60*1000), 60*1000);
    setTimeout(() => setInterval(refreshBreadth,        2*60*1000), 90*1000);   // 2 min — breadth is fast-changing
    setTimeout(() => setInterval(refreshSR,            10*60*1000), 120*1000);
    setTimeout(() => setInterval(refreshPCR,            3*60*1000), 150*1000);
    setTimeout(() => setInterval(syncFIIToMarketState, 20*60*1000), 5*1000);    // FIX: sync FII always, even after market close
    setTimeout(() => setInterval(fetchCalendarEvents, 60*60*1000), 180*1000); // refresh calendar hourly
    // BUG FIX: old code ran check920Setup every 30s from boot to shutdown = 2,880 calls/day.
    // It returned early outside 9:20–9:30, so no functional bug but pure CPU waste.
    // Now: check every 30s but only between 9:15 and 9:35 AM IST.
    setInterval(() => {
        const ist = getIST();
        const istMin = ist.getHours() * 60 + ist.getMinutes();
        if (istMin >= 555 && istMin <= 575) check920Setup();  // 9:15–9:35 window only
    }, 30*1000);
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