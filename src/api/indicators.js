const { RSI, EMA, VWAP } = require('technicalindicators');

// ── Price History Store ───────────────────────────────
const priceHistory  = [];  // raw prices
const candleHistory = [];  // OHLCV for VWAP

let currentCandle = null;
let lastCandleTime = null;

// ── Add new tick ─────────────────────────────────────
function addTick(price) {
    const now     = new Date();
    const minutes = now.getMinutes();

    // New 1-min candle
    if (!currentCandle || minutes !== lastCandleTime) {
        if (currentCandle) {
            candleHistory.push({ ...currentCandle });
            // Keep last 100 candles only
            if (candleHistory.length > 100) {
                candleHistory.shift();
            }
        }
        currentCandle  = {
            open  : price,
            high  : price,
            low   : price,
            close : price,
            volume: 1
        };
        lastCandleTime = minutes;
    } else {
        // Update current candle
        currentCandle.high   = Math.max(currentCandle.high, price);
        currentCandle.low    = Math.min(currentCandle.low, price);
        currentCandle.close  = price;
        currentCandle.volume += 1;
    }

    // Price history
    priceHistory.push(price);
    if (priceHistory.length > 200) {
        priceHistory.shift();
    }
}

// ── Calculate RSI ─────────────────────────────────────
function calcRSI() {
    if (priceHistory.length < 15) return null;
    const result = RSI.calculate({
        values : priceHistory,
        period : 14
    });
    return result.length > 0
        ? parseFloat(result[result.length - 1].toFixed(2))
        : null;
}

// ── Calculate EMA ─────────────────────────────────────
function calcEMA(period) {
    if (priceHistory.length < period) return null;
    const result = EMA.calculate({
        values : priceHistory,
        period
    });
    return result.length > 0
        ? parseFloat(result[result.length - 1].toFixed(2))
        : null;
}

// ── Calculate VWAP ────────────────────────────────────
function calcVWAP() {
    const candles = currentCandle
        ? [...candleHistory, currentCandle]
        : candleHistory;

    if (candles.length < 2) return null;

    const result = VWAP.calculate({
        high  : candles.map(c => c.high),
        low   : candles.map(c => c.low),
        close : candles.map(c => c.close),
        volume: candles.map(c => c.volume)
    });

    return result.length > 0
        ? parseFloat(result[result.length - 1].toFixed(2))
        : null;
}

// ── Generate Signal ───────────────────────────────────
function generateSignal(price, rsi, ema9, ema21, vwap) {
    const reasons   = [];
    let   bullScore = 0;
    let   bearScore = 0;

    // RSI
    if (rsi !== null) {
        if (rsi < 35) {
            bullScore += 2;
            reasons.push(`RSI ${rsi} — Oversold ✅`);
        } else if (rsi > 65) {
            bearScore += 2;
            reasons.push(`RSI ${rsi} — Overbought ⚠️`);
        } else if (rsi > 50) {
            bullScore++;
            reasons.push(`RSI ${rsi} — Bullish zone`);
        } else {
            bearScore++;
            reasons.push(`RSI ${rsi} — Bearish zone`);
        }
    }

    // EMA Crossover
    if (ema9 !== null && ema21 !== null) {
        if (ema9 > ema21) {
            bullScore += 2;
            reasons.push(`EMA9 > EMA21 — Uptrend ✅`);
        } else {
            bearScore += 2;
            reasons.push(`EMA9 < EMA21 — Downtrend ⚠️`);
        }
    }

    // VWAP
    if (vwap !== null) {
        if (price > vwap) {
            bullScore += 2;
            reasons.push(`Price above VWAP (${vwap}) ✅`);
        } else {
            bearScore += 2;
            reasons.push(`Price below VWAP (${vwap}) ⚠️`);
        }
    }

    // Signal decision
    let signal     = 'WAIT';
    let confidence = 0;
    const total    = bullScore + bearScore;

    if (total === 0) {
        reasons.push('Not enough data — wait');
        return { signal, confidence: 0, reasons };
    }

    const bullPct = (bullScore / total) * 100;

    if (bullPct >= 70) {
        signal     = 'BUY CALL';
        confidence = Math.round(bullPct);
    } else if (bullPct <= 30) {
        signal     = 'BUY PUT';
        confidence = Math.round(100 - bullPct);
    } else {
        signal     = 'WAIT';
        confidence = 30;
        reasons.push('Mixed signals — no trade');
    }

    return { signal, confidence, reasons };
}

// ── Main Export ───────────────────────────────────────
function processIndicators(price) {
    addTick(price);

    const rsi  = calcRSI();
    const ema9  = calcEMA(9);
    const ema21 = calcEMA(21);
    const vwap  = calcVWAP();

    const { signal, confidence, reasons } =
        generateSignal(price, rsi, ema9, ema21, vwap);

    return {
        rsi,
        ema9,
        ema21,
        vwap,
        signal,
        confidence,
        reasons,
        priceCount: priceHistory.length
    };
}

module.exports = { processIndicators };
