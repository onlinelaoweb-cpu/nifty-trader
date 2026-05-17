require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const axios = require('axios');
const { RSI, EMA } = require('technicalindicators');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let marketState = {
    nifty: 0,
    signal: 'WAIT',
    confidence: 0,
    rsi: 0,
    ema9: 0,
    ema21: 0,
    reason: []
};

let candleData = [];

function calculateSignal() {

    if (candleData.length < 30) return;

    const closes = candleData.map(c => c.close);

    const rsi = RSI.calculate({
        values: closes,
        period: 14
    });

    const ema9 = EMA.calculate({
        values: closes,
        period: 9
    });

    const ema21 = EMA.calculate({
        values: closes,
        period: 21
    });

    const latestRSI = rsi[rsi.length - 1];
    const latestEMA9 = ema9[ema9.length - 1];
    const latestEMA21 = ema21[ema21.length - 1];

    marketState.rsi = latestRSI;
    marketState.ema9 = latestEMA9;
    marketState.ema21 = latestEMA21;

    let reasons = [];

    if (
        latestRSI > 55 &&
        latestEMA9 > latestEMA21
    ) {

        marketState.signal = 'BUY CALL';
        marketState.confidence = 82;

        reasons.push('EMA bullish crossover');
        reasons.push('RSI bullish momentum');

    }

    else if (
        latestRSI < 45 &&
        latestEMA9 < latestEMA21
    ) {

        marketState.signal = 'BUY PUT';
        marketState.confidence = 80;

        reasons.push('EMA bearish crossover');
        reasons.push('RSI bearish weakness');

    }

    else {

        marketState.signal = 'WAIT';
        marketState.confidence = 50;

        reasons.push('No clean setup');

    }

    marketState.reason = reasons;
}

function simulateLiveData() {

    let lastPrice =
        candleData.length > 0
            ? candleData[candleData.length - 1].close
            : 24800;

    const newPrice =
        lastPrice + (Math.random() - 0.5) * 50;

    marketState.nifty = Number(newPrice.toFixed(2));

    candleData.push({
        close: newPrice
    });

    if (candleData.length > 100) {
        candleData.shift();
    }

    calculateSignal();
}

setInterval(simulateLiveData, 3000);

app.get('/api/signal', (req, res) => {
    res.json(marketState);
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.use(express.static('public'));

server.listen(PORT, () => {
    console.log(`VardaanNifty AI running on ${PORT}`);
});
