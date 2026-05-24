const { RSI, EMA, VWAP } = require('technicalindicators');

let priceHistory  = [];
let candleHistory = [];
let currentCandle = null;
let lastMinute    = null;   // now stores hours*60+minutes, not just minutes
let initialized   = false;

// ── Session-scoped VWAP state ─────────────────────────
// Resets at 9:15 IST every day so VWAP only uses today's candles
let sessionCandles  = [];   // candles from 9:15 IST today only
let sessionDate     = null; // 'YYYY-MM-DD' of current session

function getISTMinute() {
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return ist.getHours() * 60 + ist.getMinutes();
}

function getISTDateStr() {
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return `${ist.getFullYear()}-${String(ist.getMonth()+1).padStart(2,'0')}-${String(ist.getDate()).padStart(2,'0')}`;
}

function checkSessionReset() {
    const today  = getISTDateStr();
    const istMin = getISTMinute();
    // New session: date changed OR it's exactly 9:15 on a fresh day
    if (sessionDate !== today && istMin >= 555) { // 555 = 9:15 AM
        sessionCandles = [];
        sessionDate    = today;
        console.log(`🔄 VWAP session reset for ${today}`);
    }
}

function initializeHistory(closes, candles) {
    if (!closes || closes.length === 0) return;
    priceHistory  = [...closes];
    candleHistory = candles ? [...candles] : [];
    initialized   = true;

    // Seed sessionCandles with only today's candles (last 75 = ~75 min of 1m bars)
    // This gives VWAP a warm start on app launch during market hours
    const todayStr = getISTDateStr();
    if (sessionDate !== todayStr) {
        sessionCandles = candleHistory.slice(-75);
        sessionDate    = todayStr;
        console.log(`📅 VWAP seeded with ${sessionCandles.length} candles for today`);
    }

    console.log(`✅ Indicators initialized: ${priceHistory.length} prices loaded`);
    console.log(`   RSI ready: ${priceHistory.length >= 15 ? 'YES' : 'NO'}`);
    console.log(`   EMA ready: ${priceHistory.length >= 21 ? 'YES' : 'NO'}`);
}

function addTick(price) {
    // Bug fix: use hours*60+minutes so :15 of 9AM ≠ :15 of 10AM
    const istMin = getISTMinute();

    // Reset VWAP session if new trading day
    checkSessionReset();

    if (!currentCandle || istMin !== lastMinute) {
        if (currentCandle) {
            candleHistory.push({ ...currentCandle });
            if (candleHistory.length > 300) candleHistory.shift();
            // Only add to sessionCandles during market hours (9:15–15:30)
            if (istMin >= 555 && istMin <= 930) {
                sessionCandles.push({ ...currentCandle });
                if (sessionCandles.length > 80) sessionCandles.shift(); // max 75-min session
            }
        }
        currentCandle = { open: price, high: price, low: price, close: price, volume: 1 };
        lastMinute    = istMin;
    } else {
        currentCandle.high   = Math.max(currentCandle.high, price);
        currentCandle.low    = Math.min(currentCandle.low, price);
        currentCandle.close  = price;
        currentCandle.volume += 1;
    }

    priceHistory.push(price);
    if (priceHistory.length > 300) priceHistory.shift();
}

function calcRSI() {
    if (priceHistory.length < 15) return null;
    const r = RSI.calculate({ values: priceHistory, period: 14 });
    return r.length > 0 ? parseFloat(r[r.length - 1].toFixed(2)) : null;
}

function calcEMA(period) {
    if (priceHistory.length < period) return null;
    const r = EMA.calculate({ values: priceHistory, period });
    return r.length > 0 ? parseFloat(r[r.length - 1].toFixed(2)) : null;
}

function calcVWAP() {
    // Use only today's session candles — not multi-day history
    const candles = currentCandle ? [...sessionCandles, currentCandle] : sessionCandles;
    if (candles.length < 2) return null;
    try {
        const r = VWAP.calculate({
            high  : candles.map(c => c.high),
            low   : candles.map(c => c.low),
            close : candles.map(c => c.close),
            volume: candles.map(c => c.volume)
        });
        return r.length > 0 ? parseFloat(r[r.length - 1].toFixed(2)) : null;
    } catch(e) { return null; }
}

function getIndicatorSignal(price, rsi, ema9, ema21, vwap) {
    const reasons = [];
    let bull = 0, bear = 0;

    if (rsi !== null) {
        if (rsi < 35)       { bull += 2; reasons.push(`RSI ${rsi} — Oversold ✅`); }
        else if (rsi > 65)  { bear += 2; reasons.push(`RSI ${rsi} — Overbought ⚠️`); }
        else if (rsi >= 50) { bull++;    reasons.push(`RSI ${rsi} — Bullish zone`); }
        else                { bear++;    reasons.push(`RSI ${rsi} — Bearish zone`); }
    }

    if (ema9 !== null && ema21 !== null) {
        if (ema9 > ema21)      { bull += 2; reasons.push(`EMA9(${ema9}) > EMA21(${ema21}) — Uptrend ✅`); }
        else if (ema9 < ema21) { bear += 2; reasons.push(`EMA9(${ema9}) < EMA21(${ema21}) — Downtrend ⚠️`); }
        else                   {            reasons.push(`EMA9 = EMA21(${ema9}) — Flat/consolidating`); }
    }

    if (vwap !== null) {
        if (price > vwap) { bull += 2; reasons.push(`Price above VWAP(${vwap}) ✅`); }
        else              { bear += 2; reasons.push(`Price below VWAP(${vwap}) ⚠️`); }
    }

    const total = bull + bear;
    if (total === 0) return { signal: 'WAIT', confidence: 0, reasons: ['Collecting data...'] };

    const pct = (bull / total) * 100;
    let signal = 'WAIT', confidence = 0;
    if (pct >= 65)      { signal = 'BUY CALL'; confidence = Math.round(pct); }
    else if (pct <= 35) { signal = 'BUY PUT';  confidence = Math.round(100 - pct); }
    else                { signal = 'WAIT';     confidence = 30; reasons.push('Mixed signals — no trade'); }

    return { signal, confidence, reasons };
}

function processIndicators(price) {
    addTick(price);
    const rsi  = calcRSI();
    const ema9  = calcEMA(9);
    const ema21 = calcEMA(21);
    const vwap  = calcVWAP();
    const { signal, confidence, reasons } = getIndicatorSignal(price, rsi, ema9, ema21, vwap);
    return { rsi, ema9, ema21, vwap, signal, confidence, reasons, priceCount: priceHistory.length, initialized };
}

// ✅ Export candle history for chart
function getCandleHistory() {
    const all = currentCandle
        ? [...candleHistory, currentCandle]
        : [...candleHistory];
    return all.slice(-60); // last 60 candles
}

module.exports = { processIndicators, initializeHistory, getCandleHistory };
