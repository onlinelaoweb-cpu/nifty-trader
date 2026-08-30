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
    // Never overwrite a richer history with a smaller one.
    // refreshMarketData() fetches only the last 60 candles and will be called
    // right after loadCandlesFromYahoo() which seeds 376. Without this guard
    // the second call shrinks priceHistory from 376 → 60, degrading RSI/EMA.
    if (closes.length < priceHistory.length) {
        console.log(`⏭ Indicators skip re-init: new data (${closes.length}) smaller than current (${priceHistory.length}) — keeping richer history`);
        return;
    }
    priceHistory  = [...closes];
    candleHistory = candles ? [...candles] : [];
    initialized   = true;

    // Seed sessionCandles with TODAY market-hours-only candles (no overnight gaps).
    // Two-layer filter:
    //   Layer 1 — IST date must match today (excludes prior-day candles)
    //   Layer 2 — IST time must be >= 9:15 AM (minute >= 555)
    //             Yahoo Finance 1d range sometimes includes a pre-session bar at
    //             09:00-09:14 IST. That single bar sits on the same IST date so
    //             a date-only filter lets it through. The price gap between that
    //             pre-market print and the 09:15 open is treated as an overnight
    //             gap by Wilder's ADX smoothing, producing ADX ~350+ which is
    //             correctly rejected but silences ADX for the entire session.
    const todayStr = getISTDateStr();
    if (sessionDate !== todayStr) {
        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        const todayCandles = candleHistory.filter(c => {
            const epoch = c.time || c.ts;
            if (!epoch) return false;
            const istDate  = new Date(epoch + IST_OFFSET_MS);
            const dateStr  = istDate.toISOString().slice(0, 10);
            if (dateStr !== todayStr) return false;          // Layer 1: date guard
            const istMinute = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
            return istMinute >= 555;                         // Layer 2: >= 9:15 AM IST
        });
        sessionCandles = todayCandles.length > 0 ? todayCandles : [];
        sessionDate    = todayStr;
        console.log(`📅 VWAP seeded with ${sessionCandles.length} candles for today (market-hours filter)`);
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
            if (candleHistory.length > 150) candleHistory.shift();
            // Only add to sessionCandles during market hours (9:15–15:30)
            if (istMin >= 555 && istMin <= 930) {
                sessionCandles.push({ ...currentCandle });
                if (sessionCandles.length > 390) sessionCandles.shift(); // full 375-min session + buffer
            }

            // BUG FIX (granularity): priceHistory must hold ONE value per CLOSED
            // 1-minute candle, not one value per tick. Previously this pushed the
            // raw incoming tick price on every call to addTick() — and addTick()
            // runs on every websocket tick, throttled to ~once/sec by onTick()'s
            // runIndicators gate. With the 150-slot cap that meant priceHistory
            // held ~150 SECONDS (2.5 min) of tick noise instead of ~150 MINUTES
            // of candle closes. calcRSI()'s "RSI(9)" was therefore computed on
            // the last ~9 SECONDS of ticks, and calcEMA(21) on the last ~21
            // SECONDS — not minutes as the code comments intended. This produced
            // RSI swings of 30+ points within 2-3 minutes on essentially flat
            // price, EMA9≈EMA21 (both built from nearly the same few seconds of
            // data, making the "EMA cross" meaningless), and frequent false
            // "1m signals BEARISH but 15m BULLISH" conflicts in the 9:20 setup
            // check — the "1m" reading was sub-minute noise, not real momentum.
            // Fix: push the just-closed candle's close price, once per minute,
            // matching candleHistory's cadence and the RSI(9)/EMA(21) docstring.
            priceHistory.push(currentCandle.close);
            if (priceHistory.length > 150) priceHistory.shift();
        }
        currentCandle = { open: price, high: price, low: price, close: price, volume: 1, time: Date.now() };
        lastMinute    = istMin;
    } else {
        currentCandle.high   = Math.max(currentCandle.high, price);
        currentCandle.low    = Math.min(currentCandle.low, price);
        currentCandle.close  = price;
        currentCandle.volume += 1;
    }
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
// ── Relative Volume (RVOL) ────────────────────────────
// Upgraded from the old calcVolumeSpike() boolean (July 23 audit request:
// "volume should be a numeric decision input, not just spike/no-spike").
// Returns the actual ratio so a 2.0x spike and a 5.0x breakout can be told
// apart, instead of both just tripping the same true/false flag.
//
// ROOT CAUSE FIX (3 Aug audit — ChatGPT flagged 0.02x/0.04x/0.07x readings
// coexisting with "Lead Quality: Strong Confluence"): the old version compared
// currentCandle.volume (the STILL-FORMING candle — tick count starts at 1 and
// climbs to ~60 as the minute progresses) against avgVol from the last 10
// FULLY CLOSED candles (~60 ticks each). Called anywhere but the very last
// second of a minute, this is a partial-candle-vs-full-candle mismatch, not a
// real low-volume reading — 4 ticks into a new minute vs a ~57-tick average
// is mathematically going to read ~0.07x almost every time regardless of
// actual market activity. That's why it kept firing low no matter how strong
// the move was, and why it contradicted the Strong Confluence label.
// Fix: compare the last CLOSED candle's full volume against the average of
// the closed candles before it — both sides are now "whole minutes", so the
// ratio is finally apples-to-apples. Trade-off: RVOL now updates once per
// minute (at candle close) instead of continuously — a good trade since a
// mid-formation number was never meaningful to begin with.
function calcRVOL() {
    if (candleHistory.length < 6) return { rvol: null, avgVol: null, reliable: false };

    const lastClosed    = candleHistory[candleHistory.length - 1];
    const priorCandles  = candleHistory.slice(-11, -1); // up to 10 candles before lastClosed
    if (priorCandles.length < 5) return { rvol: null, avgVol: null, reliable: false };  // not enough history yet

    const avgVol = priorCandles.reduce((s, c) => s + c.volume, 0) / priorCandles.length;

    // Guard: if average volume ≤ 2 ticks, we're on Yahoo fallback (1 tick/poll).
    // RVOL is meaningless on polling data — mark unreliable so callers skip it
    // entirely rather than voting on phantom "spikes".
    if (avgVol <= 2) return { rvol: null, avgVol, reliable: false };

    const rvol = parseFloat((lastClosed.volume / avgVol).toFixed(2));
    return { rvol, avgVol: Math.round(avgVol), reliable: true };
}

// Backward-compatible boolean wrapper — same 2.0x threshold as before,
// used anywhere that only needs a yes/no (e.g. physicsOfTrading force label).
function calcVolumeSpike() {
    const { rvol, reliable } = calcRVOL();
    return reliable && rvol >= 2.0;
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
        // FIX: Align with quality gate thresholds (momentum strategy, not mean-reversion).
        // Gate requires RSI>55 for CALL and RSI<45 for PUT.
        // Old logic (RSI<40=bull, RSI>60=bear) was mean-reversion — created ghost votes
        // that inflated confidence even when the gate would block the signal.
        if      (rsi > 60)  { bull += 2; reasons.push(`RSI ${rsi} — Strong bullish momentum ✅`); }
        else if (rsi < 40)  { bear += 2; reasons.push(`RSI ${rsi} — Strong bearish momentum ⚠️`); }
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
    const volumeSpike = calcVolumeSpike();   // true when current candle volume ≥ 2.0× avg (backward-compat)
    const volumeRVOL  = calcRVOL();          // { rvol, avgVol, reliable } — numeric magnitude, July 23 upgrade
    const { signal, confidence, reasons } = getIndicatorSignal(price, rsi, ema9, ema21, vwap, bnLeadSignal);
    return { rsi, ema9, ema21, vwap, volumeSpike, volumeRVOL, signal, confidence, reasons, priceCount: priceHistory.length, initialized };
}

// ✅ Export candle history for chart (multi-day — used by /api/candles)
// full=false  → last 60 candles  (default — used by server.js 1m indicators & ADX)
// full=true   → all stored candles up to 150  (used by multiTimeframe.js for 15m/1h resampling)
// Why 60 default: server.js ADX uses session-only candles separately; the 1m RSI/EMA only
// needs recent history. Returning 150 there would be wasteful and risk overnight-gap ADX bugs.
// multiTimeframe.js needs the full buffer so resampling 1m→15m gives 20 bars instead of 4.
function getCandleHistory(full = false) {
    const all = currentCandle
        ? [...candleHistory, currentCandle]
        : [...candleHistory];
    return full ? all : all.slice(-60); // last 60 for 1m indicators, full for MTF resampling
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

                // Seed priceHistory and candleHistory — but ONLY when our own live data is
                // genuinely stale/insufficient, not just because Yahoo's fetch (which always
                // returns the FULL day, 300+ candles by afternoon) exceeds our intentionally-
                // capped 150-candle rolling window (see addTick()). The old condition
                // `newCandles.length > candleHistory.length` was permanently true from
                // ~150 minutes after market open (~11:45 AM) onwards — even while live WS
                // ticks were flowing fine — causing a full priceHistory/candleHistory
                // overwrite EVERY 2 minutes for the rest of the day. Each overwrite replaced
                // the clean, consistently-spaced WS-tick-driven series with Yahoo's own
                // (differently-timed, sometimes gappy during 429 throttling) series —
                // exactly why indicators appeared to "freeze"/misbehave starting ~11:30 AM.
                // Now: only reseed if candleHistory is actually thin (<100, i.e. a genuine
                // gap — startup, WS reconnect, or extended outage), OR our most recent candle
                // is meaningfully older than Yahoo's (our live feed has actually stalled).
                const ourLatestTs   = candleHistory.length ? (candleHistory[candleHistory.length - 1].time || candleHistory[candleHistory.length - 1].ts || 0) : 0;
                const yahooLatestTs = newCandles[newCandles.length - 1].time;
                const ourDataStale  = candleHistory.length < 100 || (yahooLatestTs - ourLatestTs) > 3 * 60 * 1000; // >3 min behind
                if (ourDataStale) {
                    const closes = newCandles.map(c => c.close);
                    initializeHistory(closes, newCandles);
                    // Seed sessionCandles: today + market-hours-only (>= 9:15 IST).
                    // Two-layer filter — same logic as initializeHistory():
                    //   Layer 1: IST date === today
                    //   Layer 2: IST minute >= 555 (9:15 AM) — excludes pre-market Yahoo bars
                    const todayForSeed  = getISTDateStr();
                    const IST_OFF       = 5.5 * 60 * 60 * 1000;
                    const todaySeedCdls = newCandles.filter(c => {
                        const epoch = c.time || c.ts;
                        if (!epoch) return false;
                        const istDate   = new Date(epoch + IST_OFF);
                        const dateStr   = istDate.toISOString().slice(0, 10);
                        if (dateStr !== todayForSeed) return false;    // Layer 1
                        const istMinute = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
                        return istMinute >= 555;                       // Layer 2: >= 9:15 AM
                    });
                    sessionCandles = todaySeedCdls.length > 0 ? todaySeedCdls : [];
                    sessionDate    = todayForSeed;
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

// ═══════════════════════════════════════════════════════════════════════════════
// MOMENTUM BREAKDOWN / BREAKOUT DETECTOR
// ─────────────────────────────────────────────────────────────────────────────
// Captures explosive directional moves — both breakdowns AND breakouts.
// Works symmetrically for BUY CALL (breakout) and BUY PUT (breakdown).
//
// Returns:
//   { signal: 'BREAKDOWN'|'BREAKOUT'|'NONE', strength: 0-5,
//     velocity: number, volumeRatio: number, candleBody: number,
//     reason: string, canTrade: boolean }
//
// Design — 5 independent evidence layers:
//   Layer 1 — VELOCITY    : 1m price moved ≥ 0.40% in last 3 closed candles
//                           (raised from 0.35% — reduces 1m noise false fires)
//   Layer 2 — CANDLE BODY : last 1m candle body ≥ 0.25% (impulsive, not doji)
//   Layer 3 — VOLUME      : volume ≥ 1.8× 20-bar avg (Angel WS only; N/A on Yahoo)
//   Layer 4 — ACCELERATION: 1m slope steepening — move accelerating not stalling
//   Layer 5 — 5M CONFIRM  : 5m candle slope agrees with 1m direction
//                           (key noise filter — eliminates 1m spikes against trend)
//
// Scoring:
//   strength ≥ 2 → canTrade = true, injects votes into combineSignals
//   strength ≥ 4 → high conviction (all 1m layers + 5m confirm)
//
// Cooldown: 5-minute cooldown after firing to prevent rapid re-firing
//           on same move (e.g. continuation candles of same impulse)
//
// Candle source: sessionCandles (9:15 IST onwards only — no overnight gap issues)
// ═══════════════════════════════════════════════════════════════════════════════

// Module-level cooldown state
let _momLastFiredAt   = 0;   // epoch ms of last canTrade fire
let _momLastSignal    = 'NONE'; // signal that last fired
const MOM_COOLDOWN_MS = 5 * 60 * 1000;  // 5-min cooldown — prevents re-voting on same momentum wave

function calcMomentumBreakdown() {
    const result = { signal: 'NONE', strength: 0, velocity: 0, volumeRatio: 0, candleBody: 0, reason: '', canTrade: false };

    // ── Use sessionCandles (today only, no overnight gaps) ────────────────────
    // candleHistory spans multiple days — overnight price gaps corrupt velocity.
    // sessionCandles resets at 9:15 IST so it's clean intraday data.
    const hist = sessionCandles.length >= 10 ? sessionCandles : candleHistory;
    if (hist.length < 15) return result;   // need at least 15 bars

    const last  = hist[hist.length - 1];   // most recent closed 1m candle
    const prev1 = hist[hist.length - 2];
    const prev2 = hist[hist.length - 3];
    const prev3 = hist[hist.length - 4];
    if (!last || !prev1 || !prev2 || !prev3) return result;

    const price = last.close;
    if (!price || price <= 0) return result;

    // ── Layer 1: Velocity — 3-candle 1m price move ───────────────────────────
    // Base threshold: 0.40% (96 pts on Nifty 24000) = genuine 3-min impulse.
    // Opening 30 min (9:15–9:45): raise to 0.55% — gap opens and volatility spikes
    // cause large 1m candles that aren't real trends, just mean-reversion noise.
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const istMinNow = nowIST.getHours() * 60 + nowIST.getMinutes();
    const isOpeningWindow = istMinNow >= 555 && istMinNow < 585; // 9:15–9:45
    const velThreshold = isOpeningWindow ? 0.55 : 0.40;

    const velocity = ((last.close - prev3.close) / prev3.close) * 100;
    result.velocity = parseFloat(velocity.toFixed(3));
    const velDown = velocity <= -velThreshold;
    const velUp   = velocity >=  velThreshold;
    const velFire = velDown || velUp;

    // ── Layer 2: Candle body — impulsive vs indecisive ────────────────────────
    // Doji / spinning top candles (body < 0.25%) are noise, not momentum.
    const body = Math.abs(last.close - last.open) / last.open * 100;
    result.candleBody = parseFloat(body.toFixed(3));
    const bodyFire = body >= 0.25;

    // ── Layer 3: Volume surge (Angel WebSocket only) ──────────────────────────
    // On Yahoo Finance, all candle volumes = 1 (fake) — guard with avgVol > 2.
    // 1.8× threshold kept — strong enough to signal institutional participation.
    const recentVols = hist.slice(-21, -1).map(c => c.volume || 1);
    const avgVol = recentVols.length > 0
        ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length
        : 0;
    const volRatio = avgVol > 2 ? (last.volume || 1) / avgVol : 0;
    result.volumeRatio = parseFloat(volRatio.toFixed(2));
    const volFire = volRatio >= 1.8;

    // ── Layer 4: Acceleration — 1m slope steepening ──────────────────────────
    // Recent 2-bar move must be larger than prior 2-bar move in the same direction.
    // 0.8× factor means: fires if recent ≥ 80% of prior (not just strictly larger)
    // — allows for a strong continuation even if slightly smaller than the impulse.
    const slope1 = last.close  - prev1.close;   // last 2-bar slope
    const slope2 = prev1.close - prev3.close;   // prior 2-bar slope
    const accelFire = Math.sign(slope1) === Math.sign(slope2) &&
                      Math.abs(slope1) > Math.abs(slope2) * 0.8;

    // ── Layer 5: 5m candle slope confirmation ────────────────────────────────
    // Key noise filter: a 1m spike AGAINST the 5m trend is usually a stop-hunt,
    // not a real move. Check last two 5m closes by resampling last 10 1m candles.
    // If 5m slope agrees with velocity direction → genuine move, not a spike.
    let fiveMFire = false;
    if (hist.length >= 10) {
        // Build last two 5m closes from 1m candles
        const last10 = hist.slice(-10);
        const fiveA_close = last10[4]?.close;   // close of 5m bar ending 5 bars ago
        const fiveB_close = last10[9]?.close;   // close of most recent 5m bar
        if (fiveA_close && fiveB_close) {
            const fiveSlope = fiveB_close - fiveA_close;
            // 5m slope direction must agree with 1m velocity direction
            fiveMFire = (velocity > 0 && fiveSlope > 0) ||
                        (velocity < 0 && fiveSlope < 0);
        }
    }

    // ── Direction gate ────────────────────────────────────────────────────────
    // Last candle must be a clean directional candle (not a spinning top).
    const isBearish = velocity < 0 && last.close < last.open;
    const isBullish = velocity > 0 && last.close > last.open;
    if (!isBearish && !isBullish) return result;

    // ── Strength scoring ──────────────────────────────────────────────────────
    let strength = 0;
    const reasons = [];
    if (velFire)   { strength++; reasons.push(`vel ${result.velocity}%`); }
    if (bodyFire)  { strength++; reasons.push(`body ${result.candleBody}%`); }
    if (volFire)   { strength++; reasons.push(`vol ${result.volumeRatio}x`); }
    if (accelFire) { strength++; reasons.push('accel'); }
    if (fiveMFire) { strength++; reasons.push('5m✓'); }   // 5m confirmation bonus

    if (strength < 2) return result;   // not enough evidence → noise

    const sigType = isBearish ? 'BREAKDOWN' : 'BREAKOUT';

    // ── Cooldown gate ─────────────────────────────────────────────────────────
    // After a valid fire, suppress re-firing for 5 minutes.
    // This prevents the same impulse from injecting multiple votes into combineSignals
    // as continuation 1m candles keep meeting thresholds on the same move.
    const now = Date.now();
    const inCooldown = (now - _momLastFiredAt) < MOM_COOLDOWN_MS;
    if (inCooldown && _momLastSignal === sigType) {
        // Return the signal for UI display but mark canTrade=false to suppress re-voting
        result.signal   = sigType;
        result.strength = strength;
        result.canTrade = false;
        result.reason   = `🔥 Momentum ${sigType} [${reasons.join(' | ')}] — cooldown`;
        return result;
    }

    // ── Fire! ─────────────────────────────────────────────────────────────────
    _momLastFiredAt = now;
    _momLastSignal  = sigType;

    result.signal   = sigType;
    result.strength = strength;
    result.canTrade = true;
    result.reason   = `🔥 Momentum ${sigType} [${reasons.join(' | ')}]`;

    return result;
}

// ── POC (Point of Control) ────────────────────────────────────────────────────
// Splits today's price range into buckets and finds the level with most volume.
// Returns { poc, vah, val, signal, label }
//   poc    = price level with highest volume (magnet)
//   vah    = Value Area High (top of 70% volume zone)
//   val    = Value Area Low  (bottom of 70% volume zone)
//   signal = 'ABOVE_POC' | 'BELOW_POC' | 'AT_POC' | 'INSUFFICIENT'
//
// How it helps:
//   - Price above POC + bullish MTF → CE entry valid (trend has force)
//   - Price below POC + bearish MTF → PE entry valid
//   - Price AT POC (±0.1%) → magnet zone, avoid entry — price will chop
//   - Price rejected at VAH/VAL → good reaction entry (Wyckoff Law 3)
function computePOC(candles) {
    const session = (candles || getSessionCandles());
    if (!session || session.length < 5) {
        return { poc: null, vah: null, val: null, signal: 'INSUFFICIENT', label: 'POC — not enough data' };
    }

    // Find session high/low for bucket range
    const highs  = session.map(c => c.high  ?? c.close);
    const lows   = session.map(c => c.low   ?? c.close);
    const hi     = Math.max(...highs);
    const lo     = Math.min(...lows);
    const range  = hi - lo;
    if (range < 10) {
        return { poc: null, vah: null, val: null, signal: 'INSUFFICIENT', label: 'POC — range too narrow' };
    }

    // 50-point buckets for Nifty (each bucket = 50pt price level)
    const BUCKET_SIZE = 50;
    const numBuckets  = Math.ceil(range / BUCKET_SIZE) + 1;
    const volBuckets  = new Array(numBuckets).fill(0);

    for (const c of session) {
        const vol    = c.volume || 1;
        const cLow   = c.low  ?? c.close;
        const cHigh  = c.high ?? c.close;
        // Distribute candle volume proportionally across price buckets it spans
        const bStart = Math.floor((cLow  - lo) / BUCKET_SIZE);
        const bEnd   = Math.floor((cHigh - lo) / BUCKET_SIZE);
        const bSpan  = Math.max(1, bEnd - bStart + 1);
        for (let b = bStart; b <= Math.min(bEnd, numBuckets - 1); b++) {
            volBuckets[b] += vol / bSpan;
        }
    }

    // POC = bucket with most volume
    let maxVol = 0, pocBucket = 0;
    for (let i = 0; i < volBuckets.length; i++) {
        if (volBuckets[i] > maxVol) { maxVol = volBuckets[i]; pocBucket = i; }
    }
    const poc = parseFloat((lo + pocBucket * BUCKET_SIZE + BUCKET_SIZE / 2).toFixed(2));

    // Value Area = 70% of total volume (expand outward from POC)
    const totalVol = volBuckets.reduce((s, v) => s + v, 0);
    const target   = totalVol * 0.70;
    let   vaVol    = volBuckets[pocBucket];
    let   vaLo     = pocBucket, vaHi = pocBucket;
    while (vaVol < target && (vaLo > 0 || vaHi < numBuckets - 1)) {
        const addLo = vaLo > 0              ? volBuckets[vaLo - 1] : 0;
        const addHi = vaHi < numBuckets - 1 ? volBuckets[vaHi + 1] : 0;
        if (addHi >= addLo && vaHi < numBuckets - 1) { vaHi++; vaVol += addHi; }
        else if (vaLo > 0)                            { vaLo--; vaVol += addLo; }
        else                                          { break; }
    }
    const vah = parseFloat((lo + vaHi * BUCKET_SIZE + BUCKET_SIZE).toFixed(2));
    const val = parseFloat((lo + vaLo * BUCKET_SIZE).toFixed(2));

    // Signal vs current price
    // TUNED (28 Aug 2026 — Prabhash: "pehle kaam ke signals aate the, ab kuch
    // nahi", weekly self-review showed "Clear of POC" blocking 76% of ALL
    // directional evaluations, by far the top bottleneck — best setup in the
    // system, Delta Confirm + 3/3 MTF + Trend Conviction + Below Dyn L3, was
    // starved to just 8 signals in 30 days despite an 88% win rate on those).
    // Root cause: POC itself is computed on 50-point buckets, so a ±0.1%
    // (~24pt on Nifty) chop-zone around it covers nearly the ENTIRE
    // highest-volume bucket — the gate was blocking almost by construction,
    // not just on genuine chop. Tightened to ±0.05% (~12pt) so it still
    // catches price sitting right on top of the POC magnet without eating
    // most of the bucket's width.
    const lastClose = session[session.length - 1]?.close ?? poc;
    const atPOC     = Math.abs(lastClose - poc) / poc < 0.0005; // within 0.05%
    const signal    = atPOC
        ? 'AT_POC'
        : lastClose > poc ? 'ABOVE_POC' : 'BELOW_POC';

    const label = `POC:${poc} | VAH:${vah} | VAL:${val} | Price ${signal.replace('_',' ')}`;
    return { poc, vah, val, signal, label, lastClose };
}

// ── Delta (Buy/Sell pressure imbalance) ──────────────────────────────────────
// Approximates delta from candle direction + volume since we don't have
// Level-2 tape data. Close > Open = buying pressure (positive delta).
// Close < Open = selling pressure (negative delta).
//
// Returns { delta, deltaPct, signal, divergence, label }
//   delta       = net buy - sell volume this session
//   deltaPct    = delta as % of total volume (−100 to +100)
//   signal      = 'BULLISH' | 'BEARISH' | 'NEUTRAL'
//   divergence  = true when price trend and delta trend disagree (reversal warning)
//
// Divergence examples from June 25:
//   Price rose 24,000 → 24,250 but delta was negative → sellers absorbing → PUT signal
//   Price fell 24,250 → 24,050 but delta was positive → buyers absorbing → CALL signal
function computeDelta(candles) {
    const session = (candles || getSessionCandles());
    if (!session || session.length < 3) {
        return { delta: 0, deltaPct: 0, signal: 'NEUTRAL', divergence: false, label: 'Delta — not enough data' };
    }

    let buyVol = 0, sellVol = 0;
    for (const c of session) {
        const vol  = c.volume || 1;
        const body = (c.close ?? 0) - (c.open ?? c.close ?? 0);
        if (body > 0)      { buyVol  += vol; }       // bullish candle
        else if (body < 0) { sellVol += vol; }        // bearish candle
        else {
            buyVol  += vol / 2;                        // doji = split evenly
            sellVol += vol / 2;
        }
    }

    const totalVol  = buyVol + sellVol;
    const delta     = buyVol - sellVol;
    const deltaPct  = totalVol > 0 ? parseFloat(((delta / totalVol) * 100).toFixed(1)) : 0;
    const signal    = deltaPct >  15 ? 'BULLISH'
                    : deltaPct < -15 ? 'BEARISH'
                    :                  'NEUTRAL';

    // Divergence: compare price direction (first→last close) vs delta direction
    const firstClose = session[0]?.close   ?? 0;
    const lastClose  = session[session.length - 1]?.close ?? 0;
    const priceUp    = lastClose > firstClose;
    const deltaPos   = delta > 0;
    const divergence = session.length >= 10 && (priceUp !== deltaPos) && Math.abs(deltaPct) > 10;

    const divLabel   = divergence
        ? (priceUp ? ' ⚠️ DIVERGENCE: Price up but sellers absorbing — reversal risk'
                   : ' ⚠️ DIVERGENCE: Price down but buyers absorbing — bounce risk')
        : '';
    const label = `Delta:${deltaPct > 0 ? '+' : ''}${deltaPct}% (${signal})${divLabel}`;

    return { delta: parseFloat(delta.toFixed(0)), deltaPct, signal, divergence, divergenceLabel: divLabel.trim(), label };
}

module.exports = { processIndicators, initializeHistory, getCandleHistory, getSessionCandles, loadCandlesFromYahoo, getCandleSource, calcMomentumBreakdown, computePOC, computeDelta };