require('dotenv').config();

const express  = require('express');
const http     = require('http');
const cors     = require('cors');

const loginAngel                       = require('./src/api/angelAuth');
const startWebSocket                   = require('./src/api/websocket');
const { processIndicators,
        initializeHistory }            = require('./src/api/indicators');
const { fetchMarketData }              = require('./src/api/marketData');
const { analyzeMultiTimeframe }        = require('./src/api/multiTimeframe');

const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 8080;

// ── Market State ──────────────────────────────────────
let marketState = {
    // Price
    nifty        : 0,
    change       : 0,
    changePct    : 0,
    // 1min signal
    signal       : 'WAIT',
    confidence   : 0,
    rsi          : null,
    ema9         : null,
    ema21        : null,
    vwap         : null,
    // PCR
    pcr          : null,
    atmPcr       : null,
    pcrSignal    : 'N/A',
    atmPcrSignal : 'N/A',
    // VIX
    vix          : null,
    vixChange    : null,
    vixSignal    : 'N/A',
    vixNote      : '',
    strikeRange  : 'ATM ±200',
    // Multi-timeframe
    mtf: {
        signal    : 'WAIT',
        strength  : 'WEAK',
        confidence: 0,
        aligned   : false,
        bullCount : 0,
        bearCount : 0,
        tf5m : { rsi:null, ema9:null, ema21:null, vwap:null, signal:'NEUTRAL', score:50 },
        tf15m: { rsi:null, ema9:null, ema21:null, vwap:null, signal:'NEUTRAL', score:50 },
        tf1h : { rsi:null, ema9:null, ema21:null, vwap:null, signal:'NEUTRAL', score:50 }
    },
    // Meta
    reason       : ['Waiting for market data...'],
    lastUpdated  : null,
    connected    : false,
    source       : 'none',
    dataPoints   : 0
};

let historyLoaded = false;

// ── Combined Signal ───────────────────────────────────
function combineSignals(indicators) {
    let bullScore = 0;
    let bearScore = 0;
    const reasons = [...(indicators.reasons || [])];

    if (marketState.pcr !== null) {
        if (marketState.pcrSignal === 'BULLISH') {
            bullScore += 2;
            reasons.push(`PCR ${marketState.pcr} — Bullish ✅`);
        } else if (marketState.pcrSignal === 'BEARISH') {
            bearScore += 2;
            reasons.push(`PCR ${marketState.pcr} — Bearish ⚠️`);
        } else {
            reasons.push(`PCR ${marketState.pcr} — Neutral`);
        }
    }

    if (marketState.vix) {
        if (marketState.vixChange < -0.5) {
            bullScore++;
            reasons.push(`VIX falling (${marketState.vix}) ✅`);
        } else if (marketState.vixChange > 0.5) {
            bearScore++;
            reasons.push(`VIX rising (${marketState.vix}) ⚠️`);
        }
    }

    // MTF alignment bonus
    if (marketState.mtf.aligned) {
        if (marketState.mtf.mtfSignal === 'BUY CALL') {
            bullScore += 3;
            reasons.push('All 3 timeframes BULLISH 🔥');
        } else if (marketState.mtf.mtfSignal === 'BUY PUT') {
            bearScore += 3;
            reasons.push('All 3 timeframes BEARISH 🔥');
        }
    } else if (marketState.mtf.bullCount === 2) {
        bullScore += 1;
        reasons.push(`2/3 timeframes bullish`);
    } else if (marketState.mtf.bearCount === 2) {
        bearScore += 1;
        reasons.push(`2/3 timeframes bearish`);
    }

    bullScore += indicators.signal === 'BUY CALL' ? 3 : 0;
    bearScore += indicators.signal === 'BUY PUT'  ? 3 : 0;

    const total = bullScore + bearScore;
    let signal = 'WAIT', confidence = 0;

    if (total > 0) {
        const pct = (bullScore / total) * 100;
        if (pct >= 65) {
            signal = 'BUY CALL'; confidence = Math.round(pct);
        } else if (pct <= 35) {
            signal = 'BUY PUT';  confidence = Math.round(100 - pct);
        } else {
            signal = 'WAIT';     confidence = 30;
            reasons.push('Mixed signals — no trade');
        }
    }

    if (marketState.vix > 30) {
        signal = 'WAIT'; confidence = 0;
        reasons.push('VIX > 30 — Avoid option buying!');
    }

    return { signal, confidence, reasons };
}

function updatePrice(price, change, changePct, source) {
    const indicators = processIndicators(price);
    const { signal, confidence, reasons } = combineSignals(indicators);

    marketState.nifty       = price;
    marketState.change      = change;
    marketState.changePct   = changePct;
    marketState.signal      = signal;
    marketState.confidence  = confidence;
    marketState.rsi         = indicators.rsi;
    marketState.ema9        = indicators.ema9;
    marketState.ema21       = indicators.ema21;
    marketState.vwap        = indicators.vwap;
    marketState.reason      = reasons;
    marketState.lastUpdated = new Date().toISOString();
    marketState.connected   = true;
    marketState.source      = source;
    marketState.dataPoints  = indicators.priceCount;
}

function onTick(tickData) {
    const price = tickData.price;
    if (!price || price <= 0) return;
    const prev   = marketState.nifty || price;
    const change = parseFloat((price - prev).toFixed(2));
    const chgPct = prev > 0
        ? parseFloat(((change / prev) * 100).toFixed(2)) : 0;
    updatePrice(price, change, chgPct, 'websocket');
}

// ── Refresh market data every 3 min ──────────────────
async function refreshMarketData() {
    const { niftyData, pcrData, vixData } = await fetchMarketData();

    if (niftyData?.closes?.length > 0 && !historyLoaded) {
        initializeHistory(niftyData.closes, niftyData.candles);
        historyLoaded = true;
    }

    if (pcrData) {
        marketState.pcr          = pcrData.pcr;
        marketState.atmPcr       = pcrData.atmPcr;
        marketState.pcrSignal    = pcrData.pcrSignal;
        marketState.atmPcrSignal = pcrData.atmPcrSignal;
    }

    if (vixData) {
        marketState.vix         = vixData.vix;
        marketState.vixChange   = vixData.change;
        marketState.vixSignal   = vixData.signal;
        marketState.vixNote     = vixData.note;
        marketState.strikeRange = vixData.strikeRange;
    }

    if (niftyData?.price > 0) {
        if (marketState.source !== 'websocket') {
            updatePrice(niftyData.price, niftyData.change, niftyData.changePct, 'yahoo');
        } else {
            marketState.change    = niftyData.change;
            marketState.changePct = niftyData.changePct;
        }
    }
}

// ── Refresh MTF every 5 min ───────────────────────────
async function refreshMTF() {
    const mtfData = await analyzeMultiTimeframe();
    if (mtfData) {
        marketState.mtf = {
            signal    : mtfData.mtfSignal,
            strength  : mtfData.mtfStrength,
            confidence: mtfData.mtfConfidence,
            aligned   : mtfData.aligned,
            bullCount : mtfData.bullCount,
            bearCount : mtfData.bearCount,
            tf5m      : mtfData.tf5m,
            tf15m     : mtfData.tf15m,
            tf1h      : mtfData.tf1h
        };
        console.log(`MTF updated: ${mtfData.mtfSignal} (${mtfData.mtfStrength})`);
    }
}

// ── Routes ────────────────────────────────────────────
app.get('/api/signal', (req, res) => res.json(marketState));

app.get('/api/health', (req, res) => res.json({
    status    : marketState.connected ? 'live' : 'waiting',
    nifty     : marketState.nifty,
    rsi       : marketState.rsi,
    mtfSignal : marketState.mtf.signal,
    mtfAligned: marketState.mtf.aligned,
    vix       : marketState.vix,
    source    : marketState.source,
    lastUpdated: marketState.lastUpdated
}));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// ── Init ──────────────────────────────────────────────
async function initializeLiveData() {
    console.log('Starting VardaanNifty AI...');

    await refreshMarketData();
    await refreshMTF();

    setInterval(refreshMarketData, 3 * 60 * 1000);
    setInterval(refreshMTF,        5 * 60 * 1000);

    const auth = await loginAngel();
    if (auth) {
        console.log('Angel Login Success');
        startWebSocket(auth, onTick);
    } else {
        console.log('Yahoo Finance fallback active');
        setTimeout(initializeLiveData, 30000);
    }
}

initializeLiveData();

server.listen(PORT, () => {
    console.log(`VardaanNifty AI running on port ${PORT}`);
});
