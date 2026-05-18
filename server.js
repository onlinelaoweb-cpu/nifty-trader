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
    nifty       : 0,
    change      : 0,
    changePct   : 0,
    signal      : 'WAIT',
    confidence  : 0,
    rsi         : null,
    ema9        : null,
    ema21       : null,
    vwap        : null,
    pcr         : null,
    atmPcr      : null,
    pcrSignal   : 'N/A',
    atmPcrSignal: 'N/A',
    vix         : null,
    vixChange   : null,
    vixSignal   : 'N/A',
    vixNote     : '',
    strikeRange : 'ATM ±200',
    reason      : ['Waiting for market data...'],
    lastUpdated : null,
    connected   : false,
    source      : 'none'  // 'websocket' or 'yahoo'
};

// ── Combined Signal Generator ─────────────────────────
function combineSignals(indicators) {
    let bullScore = 0;
    let bearScore = 0;
    const reasons = [...(indicators.reasons || [])];

    // PCR
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

    // ATM PCR
    if (marketState.atmPcr !== null) {
        if (marketState.atmPcrSignal === 'BULLISH') {
            bullScore += 2;
            reasons.push(`ATM PCR ${marketState.atmPcr} — Bullish ✅`);
        } else if (marketState.atmPcrSignal === 'BEARISH') {
            bearScore += 2;
            reasons.push(`ATM PCR ${marketState.atmPcr} — Bearish ⚠️`);
        }
    }

    // VIX
    if (marketState.vix) {
        if (marketState.vixChange < -0.5) {
            bullScore++;
            reasons.push(`VIX falling (${marketState.vix}) ✅`);
        } else if (marketState.vixChange > 0.5) {
            bearScore++;
            reasons.push(`VIX rising (${marketState.vix}) ⚠️`);
        }
        if (marketState.vix > 25) {
            reasons.push(`⚠️ VIX HIGH — ${marketState.vixNote}`);
        }
    }

    // Indicator signal weight
    bullScore += indicators.signal === 'BUY CALL' ? 3 : 0;
    bearScore += indicators.signal === 'BUY PUT'  ? 3 : 0;

    const total    = bullScore + bearScore;
    let signal     = 'WAIT';
    let confidence = 0;

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

// ── Update price from any source ─────────────────────
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

    if (source === 'yahoo') {
        console.log(`NIFTY(Yahoo):${price} RSI:${indicators.rsi} VIX:${marketState.vix} → ${signal}(${confidence}%)`);
    }
}

// ── WebSocket tick callback ───────────────────────────
function onTick(tickData) {
    const price = tickData.price;
    if (!price || price <= 0) return;

    const prev    = marketState.nifty || price;
    const change  = parseFloat((price - prev).toFixed(2));
    const chgPct  = prev > 0
        ? parseFloat(((change / prev) * 100).toFixed(2)) : 0;

    updatePrice(price, change, chgPct, 'websocket');
}

// ── Yahoo Finance polling fallback ────────────────────
async function refreshMarketData() {
    const { niftyData, pcrData, vixData } = await fetchMarketData();

    // PCR update
    if (pcrData) {
        marketState.pcr          = pcrData.pcr;
        marketState.atmPcr       = pcrData.atmPcr;
        marketState.pcrSignal    = pcrData.pcrSignal;
        marketState.atmPcrSignal = pcrData.atmPcrSignal;
    }

    // VIX update
    if (vixData) {
        marketState.vix        = vixData.vix;
        marketState.vixChange  = vixData.change;
        marketState.vixSignal  = vixData.signal;
        marketState.vixNote    = vixData.note;
        marketState.strikeRange= vixData.strikeRange;
    }

    // NIFTY from Yahoo — use if WebSocket not giving data
    if (niftyData && niftyData.price > 0) {
        // Always update if no WebSocket data, or update every cycle
        if (marketState.source !== 'websocket' || !marketState.connected) {
            updatePrice(
                niftyData.price,
                niftyData.change,
                niftyData.changePct,
                'yahoo'
            );
        } else {
            // Still update change/changePct from Yahoo
            marketState.change    = niftyData.change;
            marketState.changePct = niftyData.changePct;
        }
    }
}

// ── API Routes ────────────────────────────────────────
app.get('/api/signal', (req, res) => res.json(marketState));

app.get('/api/health', (req, res) => res.json({
    status     : marketState.connected ? 'live' : 'waiting',
    nifty      : marketState.nifty,
    vix        : marketState.vix,
    pcr        : marketState.pcr,
    source     : marketState.source,
    lastUpdated: marketState.lastUpdated
}));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// ── Init ──────────────────────────────────────────────
async function initializeLiveData() {
    console.log('Starting VardaanNifty AI...');

    // First fetch immediately
    await refreshMarketData();

    // Refresh every 3 minutes
    setInterval(refreshMarketData, 3 * 60 * 1000);

    // Angel WebSocket for real-time ticks
    const auth = await loginAngel();
    if (auth) {
        console.log('Angel Login Success');
        startWebSocket(auth, onTick);
    } else {
        console.log('Angel Login Failed — Yahoo Finance fallback active');
        setTimeout(initializeLiveData, 30000);
    }
}

initializeLiveData();

server.listen(PORT, () => {
    console.log(`VardaanNifty AI running on port ${PORT}`);
});
