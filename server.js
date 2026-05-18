require('dotenv').config();

const express  = require('express');
const http     = require('http');
const cors     = require('cors');

const loginAngel            = require('./src/api/angelAuth');
const startWebSocket        = require('./src/api/websocket');
const { processIndicators } = require('./src/api/indicators');
const { fetchMarketData }   = require('./src/api/marketData');

const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 8080;

// ── Market State ──────────────────────────────────────
let marketState = {
    // Price
    nifty      : 0,
    change     : 0,
    changePct  : 0,
    // Indicators
    signal     : 'WAIT',
    confidence : 0,
    rsi        : null,
    ema9       : null,
    ema21      : null,
    vwap       : null,
    // PCR
    pcr        : null,
    atmPcr     : null,
    pcrSignal  : 'N/A',
    atmPcrSignal: 'N/A',
    // VIX
    vix        : null,
    vixChange  : null,
    vixSignal  : 'N/A',
    vixNote    : '',
    strikeRange: 'ATM ±200',
    // Meta
    reason     : ['Waiting for market data...'],
    lastUpdated: null,
    connected  : false
};

let prevClose = 0;

// ── Generate Combined Signal ──────────────────────────
function combineSignals(indicators, pcrData, vixData) {
    let   bullScore = 0;
    let   bearScore = 0;
    const reasons   = [...(indicators.reasons || [])];

    // PCR scoring
    if (pcrData?.pcr !== null && pcrData?.pcr !== undefined) {
        if (pcrData.pcrSignal === 'BULLISH') {
            bullScore += 2;
            reasons.push(`PCR ${pcrData.pcr} — Bullish ✅`);
        } else if (pcrData.pcrSignal === 'BEARISH') {
            bearScore += 2;
            reasons.push(`PCR ${pcrData.pcr} — Bearish ⚠️`);
        } else {
            reasons.push(`PCR ${pcrData.pcr} — Neutral`);
        }
    }

    // ATM PCR scoring
    if (pcrData?.atmPcr !== null && pcrData?.atmPcr !== undefined) {
        if (pcrData.atmPcrSignal === 'BULLISH') {
            bullScore += 2;
            reasons.push(`ATM PCR ${pcrData.atmPcr} — Bullish ✅`);
        } else if (pcrData.atmPcrSignal === 'BEARISH') {
            bearScore += 2;
            reasons.push(`ATM PCR ${pcrData.atmPcr} — Bearish ⚠️`);
        }
    }

    // VIX scoring
    if (vixData?.vix) {
        if (vixData.change < -0.5) {
            bullScore++;
            reasons.push(`VIX falling ${vixData.vix} — Bullish ✅`);
        } else if (vixData.change > 0.5) {
            bearScore++;
            reasons.push(`VIX rising ${vixData.vix} — Bearish ⚠️`);
        }

        if (vixData.vix > 25) {
            reasons.push(`⚠️ VIX HIGH (${vixData.vix}) — ${vixData.note}`);
        }
    }

    // Combine with indicator score
    const indBull = indicators.signal === 'BUY CALL' ? 3 : 0;
    const indBear = indicators.signal === 'BUY PUT'  ? 3 : 0;
    bullScore += indBull;
    bearScore += indBear;

    const total   = bullScore + bearScore;
    let signal    = 'WAIT';
    let confidence = 0;

    if (total > 0) {
        const bullPct = (bullScore / total) * 100;
        if (bullPct >= 65) {
            signal     = 'BUY CALL';
            confidence = Math.round(bullPct);
        } else if (bullPct <= 35) {
            signal     = 'BUY PUT';
            confidence = Math.round(100 - bullPct);
        } else {
            signal     = 'WAIT';
            confidence = 30;
            reasons.push('Mixed signals — no trade');
        }
    }

    // VIX too high = override
    if (vixData?.vix > 30) {
        signal     = 'WAIT';
        confidence = 0;
        reasons.push('VIX > 30 — Avoid trading!');
    }

    return { signal, confidence, reasons };
}

// ── Tick Callback ─────────────────────────────────────
function onTick(tickData) {
    const price = tickData.price;

    if (prevClose > 0) {
        marketState.change    = parseFloat((price - prevClose).toFixed(2));
        marketState.changePct = parseFloat(
            ((marketState.change / prevClose) * 100).toFixed(2)
        );
    }

    const indicators = processIndicators(price);
    const { signal, confidence, reasons } = combineSignals(
        indicators,
        { pcr: marketState.pcr, atmPcr: marketState.atmPcr,
          pcrSignal: marketState.pcrSignal,
          atmPcrSignal: marketState.atmPcrSignal },
        { vix: marketState.vix, change: marketState.vixChange }
    );

    marketState.nifty       = price;
    marketState.signal      = signal;
    marketState.confidence  = confidence;
    marketState.rsi         = indicators.rsi;
    marketState.ema9        = indicators.ema9;
    marketState.ema21       = indicators.ema21;
    marketState.vwap        = indicators.vwap;
    marketState.reason      = reasons;
    marketState.lastUpdated = new Date().toISOString();
    marketState.connected   = true;

    console.log(
        `NIFTY:${price}`,
        `RSI:${indicators.rsi}`,
        `PCR:${marketState.pcr}`,
        `VIX:${marketState.vix}`,
        `→ ${signal}(${confidence}%)`
    );
}

// ── Fetch PCR + VIX every 3 minutes ──────────────────
async function refreshMarketData() {
    const { pcrData, vixData } = await fetchMarketData();

    if (pcrData) {
        marketState.pcr         = pcrData.pcr;
        marketState.atmPcr      = pcrData.atmPcr;
        marketState.pcrSignal   = pcrData.pcrSignal;
        marketState.atmPcrSignal= pcrData.atmPcrSignal;
    }

    if (vixData) {
        marketState.vix        = vixData.vix;
        marketState.vixChange  = vixData.change;
        marketState.vixSignal  = vixData.signal;
        marketState.vixNote    = vixData.note;
        marketState.strikeRange= vixData.strikeRange;
    }
}

// ── API Routes ────────────────────────────────────────
app.get('/api/signal', (req, res) => res.json(marketState));

app.get('/api/health', (req, res) => res.json({
    status     : marketState.connected ? 'live' : 'waiting',
    nifty      : marketState.nifty,
    vix        : marketState.vix,
    pcr        : marketState.pcr,
    lastUpdated: marketState.lastUpdated
}));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// ── Init ──────────────────────────────────────────────
async function initializeLiveData() {
    console.log('Starting VardaanNifty AI...');

    // Fetch PCR + VIX immediately
    await refreshMarketData();

    // Refresh every 3 minutes
    setInterval(refreshMarketData, 3 * 60 * 1000);

    const auth = await loginAngel();
    if (auth) {
        console.log('Angel Login Success');
        startWebSocket(auth, onTick);
    } else {
        console.log('Login Failed — retrying in 30s...');
        setTimeout(initializeLiveData, 30000);
    }
}

initializeLiveData();

server.listen(PORT, () => {
    console.log(`VardaanNifty AI running on port ${PORT}`);
});
