require('dotenv').config();

const express = require('express');
const http    = require('http');
const cors    = require('cors');

const loginAngel    = require('./src/api/angelAuth');
const startWebSocket = require('./src/api/websocket');

const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 8080;

// ── Market State ─────────────────────────────────────
let marketState = {
    nifty      : 0,
    high       : 0,
    low        : 0,
    prevClose  : 0,
    change     : 0,
    changePct  : 0,
    signal     : 'WAIT',
    confidence : 0,
    reason     : [],
    lastUpdated: null
};

// ── Signal Generator ─────────────────────────────────
function generateSignal(price, high, low) {
    const reasons  = [];
    let   bullScore = 0;
    let   bearScore = 0;

    // Range position
    const range    = high - low;
    const position = range > 0
        ? ((price - low) / range) * 100
        : 50;

    if (position > 65) {
        bullScore++;
        reasons.push('Price in upper range');
    } else if (position < 35) {
        bearScore++;
        reasons.push('Price in lower range');
    } else {
        reasons.push('Price mid-range — wait');
    }

    // Change %
    if (marketState.changePct > 0.3) {
        bullScore++;
        reasons.push(`Up ${marketState.changePct.toFixed(2)}% today`);
    } else if (marketState.changePct < -0.3) {
        bearScore++;
        reasons.push(`Down ${marketState.changePct.toFixed(2)}% today`);
    }

    // Signal decision
    let signal    = 'WAIT';
    let confidence = 0;

    if (bullScore > bearScore) {
        signal     = 'BUY CALL';
        confidence = Math.min(bullScore * 40, 80);
    } else if (bearScore > bullScore) {
        signal     = 'BUY PUT';
        confidence = Math.min(bearScore * 40, 80);
    } else {
        signal     = 'WAIT';
        confidence = 20;
        reasons.push('Mixed signals — no trade');
    }

    return { signal, confidence, reasons };
}

// ── Callback — WebSocket se data aayega yahan ────────
function onTick(tickData) {
    const price = tickData.price;

    // Update high/low
    if (marketState.high === 0 || price > marketState.high) {
        marketState.high = price;
    }
    if (marketState.low === 0 || price < marketState.low) {
        marketState.low = price;
    }

    // Change calculation
    if (marketState.prevClose > 0) {
        marketState.change    = parseFloat(
            (price - marketState.prevClose).toFixed(2)
        );
        marketState.changePct = parseFloat(
            ((marketState.change / marketState.prevClose) * 100).toFixed(2)
        );
    }

    // Generate signal
    const { signal, confidence, reasons } = generateSignal(
        price,
        marketState.high,
        marketState.low
    );

    // ✅ State update
    marketState.nifty       = price;
    marketState.signal      = signal;
    marketState.confidence  = confidence;
    marketState.reason      = reasons;
    marketState.lastUpdated = new Date().toISOString();

    console.log(
        `NIFTY: ${price} | Signal: ${signal} | Confidence: ${confidence}%`
    );
}

// ── API Routes ────────────────────────────────────────
app.get('/api/signal', (req, res) => {
    res.json(marketState);
});

app.get('/api/health', (req, res) => {
    res.json({
        status     : 'ok',
        connected  : marketState.nifty > 0,
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
        startWebSocket(auth, onTick); // ✅ callback pass
    } else {
        console.log('Angel Login Failed — retrying in 30s...');
        setTimeout(initializeLiveData, 30000);
    }
}

initializeLiveData();

server.listen(PORT, () => {
    console.log(`VardaanNifty AI running on port ${PORT}`);
});
