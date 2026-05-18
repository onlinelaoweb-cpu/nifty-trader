const { RSI, EMA, VWAP } = require('technicalindicators');

// ── Price + Candle History ────────────────────────────
let priceHistory  = [];
let candleHistory = [];
let currentCandle = null;
let lastMinute    = null;
let initialized   = false;

// ── Initialize with Yahoo candle history ──────────────
function initializeHistory(closes, candles) {
    if (!closes || closes.length === 0) return;

    priceHistory  = [...closes];
    candleHistory = candles ? [...candles] : [];
    initialized   = true;

    console.log(`✅ Indicators initialized: ${priceHistory.length} prices loaded`);
    console.log(`   RSI ready: ${priceHistory.length >= 15 ? 'YES' : 'NO (need ' + (15 - priceHistory.length) + ' more)'}`);
    console.log(`   EMA ready: ${priceHistory.length >= 21 ? 'YES' : 'NO (need ' + (21 - priceHistory.length) + ' more)'}`);
}

// ── Add new tick ──────────────────────────────────────
function addTick(price) {
    const now    = new Date();
    const minute = now.getMinutes();

    // 1-min candle logic
    if (!currentCandle || minute !== lastMinute) {
        if (currentCandle) {
            candleHistory.push({ ...currentCandle });
            if (candleHistory.length > 200) candleHistory.shift();
        }
        currentCandle = {
            open  : price,
            high  : price,
            low   : price,
            close : price,
            volume: 1
        };
        lastMinute = minute;
    } else {
        currentCandle.high   = Math.max(currentCandle.high, price);
        currentCandle.low    = Math.min(currentCandle.low, price);
        currentCandle.close  = price;
        currentCandle.volume += 1;
    }

    // Price history
    priceHistory.push(price);
    if (priceHistory.length > 300) priceHistory.shift();
}

// ── RSI ───────────────────────────────────────────────
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

// ── EMA ───────────────────────────────────────────────
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

// ── VWAP ──────────────────────────────────────────────
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

// ── Signal from indicators ────────────────────────────
function getIndicatorSignal(price, rsi, ema9, ema21, vwap) {
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
        } else if (rsi >= 50) {
            bullScore++;
            reasons.push(`RSI ${rsi} — Bullish zone`);
        } else {
            bearScore++;
            reasons.push(`RSI ${rsi} — Bearish zone`);
        }
    }

    // EMA Cross
    if (ema9 !== null && ema21 !== null) {
        if (ema9 > ema21) {
            bullScore += 2;
            reasons.push(`EMA9(${ema9}) > EMA21(${ema21}) — Uptrend ✅`);
        } else {
            bearScore += 2;
            reasons.push(`EMA9(${ema9}) < EMA21(${ema21}) — Downtrend ⚠️`);
        }
    }

    // VWAP
    if (vwap !== null) {
        if (price > vwap) {
            bullScore += 2;
            reasons.push(`Price above VWAP(${vwap}) ✅`);
        } else {
            bearScore += 2;
            reasons.push(`Price below VWAP(${vwap}) ⚠️`);
        }
    }

    const total = bullScore + bearScore;
    if (total === 0) {
        return {
            signal    : 'WAIT',
            confidence: 0,
            reasons   : ['Collecting data...']
        };
    }

    const pct = (bullScore / total) * 100;
    let signal     = 'WAIT';
    let confidence = 0;

    if (pct >= 65) {
        signal = 'BUY CALL'; confidence = Math.round(pct);
    } else if (pct <= 35) {
        signal = 'BUY PUT';  confidence = Math.round(100 - pct);
    } else {
        signal = 'WAIT';     confidence = 30;
        reasons.push('Mixed signals — no trade');
    }

    return { signal, confidence, reasons };
}

// ── Main export ───────────────────────────────────────
function processIndicators(price) {
    addTick(price);

    const rsi  = calcRSI();
    const ema9  = calcEMA(9);
    const ema21 = calcEMA(21);
    const vwap  = calcVWAP();

    const { signal, confidence, reasons } =
        getIndicatorSignal(price, rsi, ema9, ema21, vwap);

    return {
        rsi, ema9, ema21, vwap,
        signal, confidence, reasons,
        priceCount: priceHistory.length,
        initialized
    };
}

module.exports = { processIndicators, initializeHistory };
