require('dotenv').config();

const express  = require('express');
const http     = require('http');
const cors     = require('cors');

const loginAngel         = require('./src/api/angelAuth');
const startWebSocket     = require('./src/api/websocket');
const { processIndicators } = require('./src/api/indicators');

const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 8080;

// ── Market State ──────────────────────────────────────
let marketState = {
    nifty      : 0,
    signal     : 'WAIT',
    confidence : 0,
    rsi        : null,
    ema9       : null,
    ema21      : null,
    vwap       : null,
    change     : 0,
    changePct  : 0,
    reason     : ['Waiting for market data...'],
    lastUpdated: null,
    connected  : false
};

let prevClose = 0;

// ── Tick Callback ─────────────────────────────────────
function onTick(tickData) {
    const price = tickData.price;

    // Change from prev close
    if (prevClose > 0) {
        marketState.change    = parseFloat(
            (price - prevClose).toFixed(2)
        );
        marketState.changePct = parseFloat(
            ((marketState.change / prevClose) * 100).toFixed(2)
        );
    }

    // Process indicators
    const indicators = processIndicators(price);

    // ✅ Update full state
    marketState.nifty       = price;
    marketState.signal      = indicators.signal;
    marketState.confidence  = indicators.confidence;
    marketState.rsi         = indicators.rsi;
    marketState.ema9        = indicators.ema9;
    marketState.ema21       = indicators.ema21;
    marketState.vwap        = indicators.vwap;
    marketState.reason      = indicators.reasons;
    marketState.lastUpdated = new Date().toISOString();
    marketState.connected   = true;

    console.log(
        `NIFTY: ${price}`,
        `| RSI: ${indicators.rsi}`,
        `| VWAP: ${indicators.vwap}`,
        `| ${indicators.signal}`,
        `(${indicators.confidence}%)`
    );
}

// ── API Routes ────────────────────────────────────────
app.get('/api/signal', (req, res) => {
    res.json(marketState);
});

app.get('/api/health', (req, res) => {
    res.json({
        status     : marketState.connected ? 'live' : 'waiting',
        nifty      : marketState.nifty,
        lastUpdated: marketState.lastUpdated
    });
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// ── Init ──────────────────────────────────────────────
async function initializeLiveData() {
    console.log('Starting VardaanNifty AI...');

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
