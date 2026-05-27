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

// ── Volume spike detection ────────────────────────────
// Compares the current candle's tick-volume against the rolling average of
// the last 10 CLOSED candles. A "spike" = current volume ≥ 1.5× the average.
//
// Why tick volume works here:
//   On the Angel One WebSocket feed, each tick ≈ one trade observation. More
//   ticks per minute = more activity = a real proxy for volume. On the Yahoo
//   Finance fallback the poller runs every 3 min, so all candles get volume ≈ 1
//   and spikes can't be detected — the function returns false in that case.
//
// A volume spike in the direction of the signal adds conviction:
//   bull breakout with rising volume → genuine buying pressure
//   bear breakdown with rising volume → genuine selling pressure
//   breakout on LOW volume → suspect (could be thin-book manipulation)
//
// The spike flag is passed through processIndicators() and used in server.js
// to add +1 point when spike direction matches the emerging signal.
function calcVolumeSpike() {
    if (!currentCandle) return false;

    const recent = candleHistory.slice(-10);
    if (recent.length < 5) return false;   // not enough history yet

    const avgVol = recent.reduce((s, c) => s + c.volume, 0) / recent.length;

    // Guard: if average volume ≤ 2 ticks, we're on Yahoo fallback (1 tick/poll).
    // Spikes are meaningless on polling data — return false to avoid false signals.
    if (avgVol <= 2) return false;

    return currentCandle.volume >= avgVol * 1.5;
}

// ── Momentum confirmation gate ────────────────────────
// Returns the last *closed* candle (not the in-progress one).
// The in-progress candle body can flip many times mid-minute,
// so we only trust a fully closed candle for body direction.
function getLastClosedCandle() {
    return candleHistory.length > 0 ? candleHistory[candleHistory.length - 1] : null;
}

// ── BankNifty VWAP leading indicator ─────────────────
// bnLeadSignal is the object from globalCues.bankNiftyLeadSignal:
//   { signal: +1 | -1 | 0, reason: string, crossedAt: string|null }
// Weight = 1 (same as one indicator point). Only fires on a FRESH cross
// (signal !== 0). Passed in from server.js where globalData is available.
function getIndicatorSignal(price, rsi, ema9, ema21, vwap, bnLeadSignal) {
    const reasons = [];

    // ── Step 1: score each indicator independently ────
    // (kept so the UI can still show partial context even on a WAIT)
    let bull = 0, bear = 0;

    // ── BankNifty VWAP Lead (weight: 1) ──────────────
    // BankNifty leads Nifty ~70% of the time intraday.
    // A fresh VWAP cross 5 min ago is an early directional signal.
    if (bnLeadSignal && bnLeadSignal.signal !== 0) {
        if (bnLeadSignal.signal === 1) {
            bull += 1;
            reasons.push(`🏦 ${bnLeadSignal.reason}`);
        } else {
            bear += 1;
            reasons.push(`🏦 ${bnLeadSignal.reason}`);
        }
    }

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

    // ── Step 2: momentum confirmation gate ───────────
    // All three structural conditions must align AND the last closed
    // candle body must confirm the direction. If momentum has already
    // turned (e.g. bearish body on a bullish setup), we suppress the
    // signal even if the score would have triggered it.
    const lastCandle   = getLastClosedCandle();
    const bullishBody  = lastCandle && lastCandle.close > lastCandle.open;
    const bearishBody  = lastCandle && lastCandle.close < lastCandle.open;

    const bullGate =
        vwap   !== null && price > vwap &&   // price above VWAP
        ema9   !== null && ema21 !== null &&
        ema9   > ema21 &&                    // uptrend
        bullishBody;                         // last candle closed green

    const bearGate =
        vwap   !== null && price < vwap &&   // price below VWAP
        ema9   !== null && ema21 !== null &&
        ema9   < ema21 &&                    // downtrend
        bearishBody;                         // last candle closed red

    // ── Step 3: derive final signal ──────────────────
    const total = bull + bear;
    if (total === 0) return { signal: 'WAIT', confidence: 0, reasons: ['Collecting data...'] };

    const pct = (bull / total) * 100;

    if (pct >= 65 && bullGate) {
        return { signal: 'BUY CALL', confidence: Math.round(pct), reasons };
    }

    if (pct <= 35 && bearGate) {
        return { signal: 'BUY PUT', confidence: Math.round(100 - pct), reasons };
    }

    // Score favours a direction but momentum gate blocked it
    if (pct >= 65 && !bullGate) {
        const missing = [];
        if (!lastCandle || !bullishBody) missing.push('last candle not bullish');
        if (vwap === null || price <= vwap) missing.push('price not above VWAP');
        if (ema9 === null || ema21 === null || ema9 <= ema21) missing.push('EMA9 ≤ EMA21');
        reasons.push(`⏳ Bullish score but momentum gate blocked (${missing.join(', ')})`);
        return { signal: 'WAIT', confidence: 30, reasons };
    }

    if (pct <= 35 && !bearGate) {
        const missing = [];
        if (!lastCandle || !bearishBody) missing.push('last candle not bearish');
        if (vwap === null || price >= vwap) missing.push('price not below VWAP');
        if (ema9 === null || ema21 === null || ema9 >= ema21) missing.push('EMA9 ≥ EMA21');
        reasons.push(`⏳ Bearish score but momentum gate blocked (${missing.join(', ')})`);
        return { signal: 'WAIT', confidence: 30, reasons };
    }

    // Mixed signals
    reasons.push('Mixed signals — no trade');
    return { signal: 'WAIT', confidence: 30, reasons };
}

// bnLeadSignal is optional — pass globalData.bankNiftyLeadSignal from server.js.
// If omitted (undefined/null) the BankNifty lead block is silently skipped,
// so existing callers without globalData stay fully backward-compatible.
function processIndicators(price, bnLeadSignal) {
    addTick(price);
    const rsi         = calcRSI();
    const ema9        = calcEMA(9);
    const ema21       = calcEMA(21);
    const vwap        = calcVWAP();
    const volumeSpike = calcVolumeSpike();   // ← NEW: true when current candle volume ≥ 1.5× avg
    const { signal, confidence, reasons } = getIndicatorSignal(price, rsi, ema9, ema21, vwap, bnLeadSignal);
    return { rsi, ema9, ema21, vwap, volumeSpike, signal, confidence, reasons, priceCount: priceHistory.length, initialized };
}

// ✅ Export candle history for chart (multi-day — used by /api/candles)
function getCandleHistory() {
    const all = currentCandle
        ? [...candleHistory, currentCandle]
        : [...candleHistory];
    return all.slice(-60); // last 60 candles
}

// ✅ Export today-only session candles (no overnight gaps — used by server.js ADX)
// sessionCandles resets at 9:15 IST so it never contains multi-day price gaps.
// Overnight gaps cause Wilder's smoothing to produce ADX values > 100 (invalid).
function getSessionCandles() {
    return currentCandle
        ? [...sessionCandles, currentCandle]
        : [...sessionCandles];
}

module.exports = { processIndicators, initializeHistory, getCandleHistory, getSessionCandles };
