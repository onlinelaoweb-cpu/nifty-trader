const { RSI, EMA, VWAP } = require('technicalindicators');
const axios = require('axios');

let priceHistory  = [];
let candleHistory = [];
let currentCandle = null;
let lastMinute    = null;   // now stores hours*60+minutes, not just minutes
let initialized   = false;

// ── Candle resolution tracking ────────────────────────
// 'websocket' = true 1-min ticks from Angel One (accurate)
// 'yahoo_5m'  = 5-min candles from Yahoo Finance (disguised as 1m — RSI/volume degrade)
// 'yahoo_1m'  = 1-min candles from Yahoo Finance (acceptable but polled, not streamed)
let candleSource = 'websocket';

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
    console.log(`   RSI ready: ${priceHistory.length >= 10 ? 'YES' : 'NO'}`);
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
    // RSI(9) on 1-min feed — responds faster than RSI(14) on short timeframes.
    // Needs at least 10 bars (9+1) to produce a value.
    const period = 9;
    if (priceHistory.length < period + 1) return null;
    const r = RSI.calculate({ values: priceHistory, period });
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
// the last 10 CLOSED candles. A "spike" = current volume ≥ 2.0× the average.
//
// Why 2.0× (was 1.5×):
//   1.5× fired too often — minor fluctuations triggered it. 2.0× means the
//   candle has roughly double the normal activity, a genuine surge. Keeps the
//   volume vote meaningful rather than adding noise on every other bar.
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

    return currentCandle.volume >= avgVol * 2.0;
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
        // Option buyer zones: 40/60 for momentum, 30/70 are hard OB/OS
        if      (rsi < 40)  { bull += 2; reasons.push(`RSI ${rsi} — Oversold, reversal zone ✅`); }
        else if (rsi > 60)  { bear += 2; reasons.push(`RSI ${rsi} — Overbought, pullback zone ⚠️`); }
        else if (rsi >= 52) { bull++;    reasons.push(`RSI ${rsi} — Bullish momentum zone`); }
        else if (rsi <= 48) { bear++;    reasons.push(`RSI ${rsi} — Bearish momentum zone`); }
        else                {            reasons.push(`RSI ${rsi} — Neutral band (48–52)`); }
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
    // candle must have a meaningful body (not a doji).
    // Doji candles = indecision. Body must be ≥25% of the full candle range.
    // Tiny wicks-only candles frequently cause false signals for option buyers.
    const lastCandle    = getLastClosedCandle();
    const candleRange   = lastCandle ? (lastCandle.high - lastCandle.low) : 0;
    const candleBody    = lastCandle ? Math.abs(lastCandle.close - lastCandle.open) : 0;
    const meaningfulBody = lastCandle && candleRange > 0 && (candleBody / candleRange) >= 0.25;
    const bullishBody   = lastCandle && lastCandle.close > lastCandle.open && meaningfulBody;
    const bearishBody   = lastCandle && lastCandle.close < lastCandle.open && meaningfulBody;

    const bullGate =
        vwap   !== null && price > vwap &&   // price above VWAP
        ema9   !== null && ema21 !== null &&
        ema9   > ema21 &&                    // uptrend
        bullishBody;                         // last candle: meaningful green body

    const bearGate =
        vwap   !== null && price < vwap &&   // price below VWAP
        ema9   !== null && ema21 !== null &&
        ema9   < ema21 &&                    // downtrend
        bearishBody;                         // last candle: meaningful red body

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

// ── Yahoo Finance candle bootstrap ───────────────────
// Called once at server startup (and on every refreshMTF cycle) to seed
// candleHistory when NSE is blocked (Railway IP ban is very common).
// ^NSEI = Nifty 50 index on Yahoo Finance — free, no auth, no IP ban.
//
// Strategy: try 1m candles first (more accurate for RSI(9)/entry timing).
// If 1m is throttled/empty, fall back to 5m and tag candleSource='yahoo_5m'
// so the UI can warn that indicators are running on lower resolution.
async function loadCandlesFromYahoo() {
    const ATTEMPTS = [
        { interval: '1m', label: 'yahoo_1m',
          urls: [
              'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1m&range=1d',
              'https://query2.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1m&range=1d',
          ]},
        { interval: '5m', label: 'yahoo_5m',
          urls: [
              'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=5m&range=1d',
              'https://query2.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=5m&range=1d',
          ]},
    ];

    for (const attempt of ATTEMPTS) {
        for (const url of attempt.urls) {
            try {
                const res = await axios.get(url, {
                    timeout: 12000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json',
                    },
                });
                const result = res.data?.chart?.result?.[0];
                if (!result) continue;

                const timestamps = result.timestamp || [];
                const q = result.indicators?.quote?.[0] || {};
                if (timestamps.length === 0) continue;

                // Convert to IST and build candle array
                const newCandles = [];
                for (let i = 0; i < timestamps.length; i++) {
                    const close = q.close?.[i];
                    if (close == null || isNaN(close)) continue;
                    newCandles.push({
                        time  : timestamps[i] * 1000,
                        open  : q.open?.[i]   ?? close,
                        high  : q.high?.[i]   ?? close,
                        low   : q.low?.[i]    ?? close,
                        close,
                        volume: q.volume?.[i] ?? 1,
                    });
                }
                if (newCandles.length === 0) continue;

                // Seed priceHistory and candleHistory — only if we have more data than currently loaded
                if (newCandles.length > candleHistory.length) {
                    const closes = newCandles.map(c => c.close);
                    initializeHistory(closes, newCandles);
                    // Also seed sessionCandles with today's candles for accurate VWAP
                    sessionCandles = [...newCandles.slice(-80)];
                    candleSource = attempt.label;
                    const resNote = attempt.label === 'yahoo_5m'
                        ? ' ⚠️ 5m resolution — RSI/volume less precise' : '';
                    console.log(`📈 [Yahoo] Loaded ${newCandles.length} Nifty ${attempt.interval} candles — indicators warm${resNote}`);
                }
                return newCandles.length;
            } catch (e) {
                console.warn(`[Yahoo candles] ${url.includes('query1') ? 'query1' : 'query2'} ${attempt.interval} failed: ${e.message}`);
            }
        }
    }
    console.warn('[Yahoo candles] All URLs failed — starting cold');
    return 0;
}

function getCandleSource() { return candleSource; }

module.exports = { processIndicators, initializeHistory, getCandleHistory, getSessionCandles, loadCandlesFromYahoo, getCandleSource };