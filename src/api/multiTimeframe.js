'use strict';
// multiTimeframe.js — RSI/EMA/VWAP/ADX across 5m, 15m, 1h
//
// ── Candle sourcing strategy (May 2026) ──────────────────────────────────────
//
//   Primary:  resample in-memory 1m candles from Angel WebSocket / Yahoo
//             getCandleHistory(true) returns ALL stored candles (up to 300)
//             instead of the old slice(-60), giving:
//               5m  → up to 60 bars   (was 12) ✅ reliable
//               15m → up to 20 bars   (was  4) ✅ EMA21 and RSI14 now possible
//               1h  → up to 5 bars    (was  1) ⚠️ still thin early session
//
//   Secondary: when resampled bars are still below per-TF minimums, fetch
//              Yahoo Finance historical candles for that specific timeframe.
//              Yahoo `5d` at 15m gives ~130 bars.  Yahoo `1mo` at 60m gives ~130 bars.
//              This covers the first 90 minutes of the session until memory fills up.
//
//   Per-TF minimum bar requirements (conservative — must ALL be met):
//     RSI(14) needs 15+ closes, EMA21 needs 22+ closes, ADX(14) needs 30+ valid candles.
//     If a TF can't meet minimums even after Yahoo fallback, it returns
//     signal:'INSUFFICIENT' and is excluded from bullCount/bearCount/aligned.
//
// ── Why this matters ─────────────────────────────────────────────────────────
//   With only 4 × 15m bars, EMA21 is undefined, RSI(14) is undefined, and
//   ADX is undefined — the entire TF was producing signal:'NEUTRAL' from a
//   score=50 default, which has no informational value but still participates
//   in the quality gate's mtfAligned check.  This caused the quality gate to
//   block real signals for the first 5–6 hours of the session on Railway.

const axios              = require('axios');
const { RSI, EMA, VWAP } = require('technicalindicators');
const { getCandleHistory, getSessionCandles }    = require('./indicators');

// ── Per-TF minimum candle thresholds ─────────────────────────────────────────
// RSI(14) warmup = 15, EMA21 warmup = 22, ADX(14) warmup = 30
// We use 30 as the universal minimum — if fewer bars are available after all
// fallbacks, the TF signal is marked INSUFFICIENT and excluded from voting.
const MIN_BARS = {
    '5m' : 22,   // 5m: 22 bars = 110 min. Achievable from memory within ~2h of open.
    '15m': 30,   // 15m: 30 bars = 7.5h. Needs Yahoo fallback for most of the session.
    '1h' : 30,   // 1h:  30 bars = 30h. Always needs Yahoo multi-day fallback.
};

// ── Resample 1m candles → higher timeframe ────────────────────────────────────
function resample(candles1m, periodMins) {
    if (!candles1m || candles1m.length === 0) return [];
    const out  = [];
    let bucket = null;
    let count  = 0;
    for (const c of candles1m) {
        if (!bucket) {
            bucket = { open: c.close, high: c.high, low: c.low, close: c.close, volume: c.volume || 1, ts: c.ts || c.time };
        } else {
            bucket.high   = Math.max(bucket.high, c.high);
            bucket.low    = Math.min(bucket.low,  c.low);
            bucket.close  = c.close;
            bucket.volume = (bucket.volume || 1) + (c.volume || 1);
        }
        count++;
        if (count >= periodMins) {
            out.push({ ...bucket });
            bucket = null;
            count  = 0;
        }
    }
    // Include partial last bucket so latest price is always reflected
    if (bucket) out.push({ ...bucket });
    return out;
}

// ── Filter to today's IST session ────────────────────────────────────────────
function todaySessionCandles(candles) {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIST        = new Date(Date.now() + IST_OFFSET_MS);
    const todayStr      = nowIST.toISOString().slice(0, 10);
    const session       = candles.filter(c => {
        const ts = c.ts || c.time;
        if (!ts) return false;
        const istDate = new Date(ts + IST_OFFSET_MS).toISOString().slice(0, 10);
        return istDate === todayStr;
    });
    return session.length >= 2 ? session : candles.slice(-80);
}

// ── Direct Yahoo Finance fallback (bypasses NSE/fetchYahooChart entirely) ─────
// fetchYahooChart in yahooFetch.js is actually an NSE wrapper — it times out on
// Railway IPs. This function hits Yahoo Finance's v8 chart API DIRECTLY with
// real HTTP calls. Yahoo Finance is not blocked on Railway. No cookies, no NSE.
//
// Cache TTL: 5 min per TF — avoids hammering Yahoo on every 5-min MTF cycle.
// Two query hosts (query1 / query2) — rotate on failure.
//
// TF → Yahoo interval / range:
//   5m  → interval=5m,  range=5d   → ~390 bars (5 days × ~78 bars/day)
//   15m → interval=15m, range=5d   → ~130 bars (5 days × ~26 bars/day)
//   1h  → interval=60m, range=1mo  → ~130 bars (~1 month of hourly)

const _yahooCache = {};   // { '15m': { ts, candles }, '1h': { ts, candles } }
const YAHOO_CACHE_TTL_MS = 5 * 60 * 1000;

const YAHOO_DIRECT_HEADERS = {
    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept'         : 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchCandlesFromYahoo(intervalKey) {
    // Return cached data if still fresh
    const cached = _yahooCache[intervalKey];
    if (cached && (Date.now() - cached.ts) < YAHOO_CACHE_TTL_MS) {
        return cached.candles;
    }

    const cfgMap = {
        '5m' : { interval: '5m',  range: '5d'  },
        '15m': { interval: '15m', range: '5d'  },
        '1h' : { interval: '60m', range: '1mo' },
    };
    const cfg = cfgMap[intervalKey];
    if (!cfg) return [];

    // Try query1 then query2 — Yahoo load-balances across these two hosts
    const SYMBOL = '%5ENSEI';  // ^NSEI = Nifty 50 index
    const urls = [
        `https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}?interval=${cfg.interval}&range=${cfg.range}&includePrePost=false`,
        `https://query2.finance.yahoo.com/v8/finance/chart/${SYMBOL}?interval=${cfg.interval}&range=${cfg.range}&includePrePost=false`,
    ];

    for (const url of urls) {
        try {
            const res = await axios.get(url, {
                timeout: 12000,
                headers: YAHOO_DIRECT_HEADERS,
            });
            const result = res.data?.chart?.result?.[0];
            if (!result) continue;

            const timestamps = result.timestamp || [];
            const q          = result.indicators?.quote?.[0] || {};
            if (!timestamps.length) continue;

            const candles = [];
            for (let i = 0; i < timestamps.length; i++) {
                const close = q.close?.[i];
                const high  = q.high?.[i];
                const low   = q.low?.[i];
                if (close == null || high == null || low == null) continue;
                candles.push({
                    ts    : timestamps[i] * 1000,
                    time  : timestamps[i] * 1000,
                    open  : parseFloat((q.open?.[i] ?? close).toFixed(2)),
                    high  : parseFloat(high.toFixed(2)),
                    low   : parseFloat(low.toFixed(2)),
                    close : parseFloat(close.toFixed(2)),
                    volume: q.volume?.[i] || 1,
                });
            }

            if (candles.length > 0) {
                console.log(`[MTF] Yahoo direct ${intervalKey}: ${candles.length} bars ✅`);
                _yahooCache[intervalKey] = { ts: Date.now(), candles };
                return candles;
            }
        } catch (err) {
            console.warn(`[MTF Yahoo direct] ${intervalKey} ${url.includes('query1') ? 'q1' : 'q2'} failed: ${err.message}`);
        }
    }

    console.warn(`[MTF Yahoo direct] ${intervalKey}: all URLs failed — MTF will use INSUFFICIENT for this TF`);
    return [];
}

// ── ADX (Wilder's smoothing, period=14) ───────────────────────────────────────
function calculateADX(candles, period = 14) {
    if (!candles || candles.length < period * 2 + 2) return null;
    try {
        // ROOT CAUSE FIX: keep ALL candles (don't filter flat ones).
        // Flat bar filter creates time gaps → huge TR between non-consecutive bars → ADX > 100.
        const valid = candles.filter(c => c.close != null);
        if (valid.length < period * 2 + 2) return null;
        const tr = [], dmp = [], dmm = [];
        for (let i = 1; i < valid.length; i++) {
            const c  = valid[i],   pc = valid[i-1];
            const h  = c.high  ?? c.close;
            const l  = c.low   ?? c.close;
            const ph = pc.high ?? pc.close;
            const pl = pc.low  ?? pc.close;
            const trVal = (h === l)
                ? Math.abs(c.close - pc.close)
                : Math.max(h - l, Math.abs(h - pc.close), Math.abs(l - pc.close));
            tr.push(trVal);
            // flat bar: DM+ = DM- = 0 — prevents DI > 100% when DM > TR
            const up = (h === l) ? 0 : (h - ph);
            const dn = (h === l) ? 0 : (pl - l);
            dmp.push(up > dn && up > 0 ? up : 0);
            dmm.push(dn > up && dn > 0 ? dn : 0);
        }
        function wilderSmooth(arr) {
            // FIXED: Wilder initial = AVERAGE of first `period` values (not sum)
            // Using sum caused ADX initial value to be 14x too large → ADX > 100 permanently
            let s = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
            const out = [s];
            for (let i = period; i < arr.length; i++) { s = (s * (period - 1) + arr[i]) / period; out.push(s); }
            return out;
        }
        const atr    = wilderSmooth(tr);
        const sdmp   = wilderSmooth(dmp);
        const sdmm   = wilderSmooth(dmm);
        const dip    = sdmp.map((v, i) => atr[i] > 0 ? (v / atr[i]) * 100 : 0);
        const dim    = sdmm.map((v, i) => atr[i] > 0 ? (v / atr[i]) * 100 : 0);
        const dx     = dip.map((v, i) => { const s = v + dim[i]; return s > 0 ? (Math.abs(v - dim[i]) / s) * 100 : 0; });
        const adxArr = wilderSmooth(dx);
        const adxVal = parseFloat(adxArr[adxArr.length - 1].toFixed(2));
        if (adxVal > 100 || adxVal < 0) {
            const now = Date.now();
            if (!calculateADX._lastWarn || now - calculateADX._lastWarn > 300_000) {
                console.warn(`⚠️ MTF ADX out of range (${adxVal}) — opening-bar gap, will resolve after warmup`);
                calculateADX._lastWarn = now;
            }
            return null;
        }
        return {
            adx    : adxVal,
            diPlus : parseFloat(Math.min(100, dip[dip.length - 1]).toFixed(2)),
            diMinus: parseFloat(Math.min(100, dim[dim.length - 1]).toFixed(2)),
        };
    } catch (_) { return null; }
}

// ── Compute indicators + signal for one timeframe ────────────────────────────
// Returns signal:'INSUFFICIENT' (not 'NEUTRAL') when candle count is below
// MIN_BARS so the caller can exclude this TF from the voting tally.
function calcIndicators(candles, tfLabel) {
    const minBars = MIN_BARS[tfLabel] || 22;

    // INSUFFICIENT guard — not enough candles for meaningful indicators
    if (!candles || candles.length < minBars) {
        return {
            rsi: null, ema9: null, ema21: null, vwap: null, adx: null,
            close: candles?.length ? candles[candles.length - 1].close : null,
            signal: 'INSUFFICIENT',
            score : 50,
            barCount: candles?.length || 0,
        };
    }

    const closes = candles.map(c => c.close);
    const close  = closes[closes.length - 1];

    // RSI(14) — needs at least 15 closes
    let rsi = null;
    if (closes.length >= 15) {
        try {
            const r = RSI.calculate({ values: closes, period: 14 });
            rsi = r.length > 0 ? parseFloat(r[r.length - 1].toFixed(2)) : null;
        } catch (_) {}
    }

    // EMA9 — needs at least 9 closes
    let ema9 = null;
    if (closes.length >= 9) {
        try {
            const r = EMA.calculate({ values: closes, period: 9 });
            ema9 = r.length > 0 ? parseFloat(r[r.length - 1].toFixed(2)) : null;
        } catch (_) {}
    }

    // EMA21 — needs at least 22 closes
    let ema21 = null;
    if (closes.length >= 22) {
        try {
            const r = EMA.calculate({ values: closes, period: 21 });
            ema21 = r.length > 0 ? parseFloat(r[r.length - 1].toFixed(2)) : null;
        } catch (_) {}
    }

    // VWAP — session candles only
    let vwap = null;
    const sessionC = todaySessionCandles(candles);
    if (sessionC.length >= 2) {
        try {
            const r = VWAP.calculate({
                high  : sessionC.map(c => c.high),
                low   : sessionC.map(c => c.low),
                close : sessionC.map(c => c.close),
                volume: sessionC.map(c => c.volume || 1),
            });
            vwap = r.length > 0 ? parseFloat(r[r.length - 1].toFixed(2)) : null;
        } catch (_) {}
    }

    // ADX(14) — min 30 candles (2 × period + buffer), used for NEUTRAL override only
    const adxData  = calculateADX(sessionC.length >= 30 ? sessionC : candles);
    const adxVal   = adxData?.adx ?? null;
    // ADX < 20 = choppy, override signal to NEUTRAL even if bull/bear votes pass
    const adxValid = adxVal === null || adxVal >= 20;

    // ── Bull / bear vote ──────────────────────────────
    let bull = 0, bear = 0;

    if (rsi !== null) {
        if      (rsi < 35) { bull += 2; }
        else if (rsi > 65) { bear += 2; }
        else if (rsi >= 50){ bull += 1; }
        else               { bear += 1; }
    }
    if (ema9 !== null && ema21 !== null) {
        if (ema9 > ema21) bull += 2; else bear += 2;
    } else if (ema9 !== null) {
        // EMA21 not yet available but EMA9 is — use close vs EMA9 as weaker signal
        if (close > ema9) bull += 1; else bear += 1;
    }
    if (vwap !== null) {
        if (close > vwap) bull += 2; else bear += 2;
    }

    const total  = bull + bear;
    const pct    = total > 0 ? (bull / total) * 100 : 50;
    // ADX choppy override: keep signal NEUTRAL so it doesn't pollute mtfAligned
    const signal = !adxValid  ? 'NEUTRAL'
                 : pct >= 60  ? 'BULLISH'
                 : pct <= 40  ? 'BEARISH'
                 :              'NEUTRAL';
    const score  = parseFloat(pct.toFixed(0));

    return { rsi, ema9, ema21, vwap, adx: adxVal, close, signal, score, barCount: candles.length };
}

// ── Main entry point ─────────────────────────────────────────────────────────
async function analyzeMultiTimeframe() {
    console.log('📊 Fetching multi-timeframe data...');

    // ── Step 1: Get full in-memory 1m candle buffer (up to 300) ──────────────
    // getCandleHistory(true) returns all stored candles, not just last 60.
    // This gives us 300 bars to resample, producing:
    //   5m  → up to 60 bars  (was 12)
    //   15m → up to 20 bars  (was  4)
    //   1h  → up to 5 bars   (was  1)
    const mem1m = getCandleHistory(true);

    let c5m, c15m, c1h;

    if (mem1m && mem1m.length >= 15) {
        c5m  = resample(mem1m, 5);
        c15m = resample(mem1m, 15);
        c1h  = resample(mem1m, 60);
        console.log(`📊 MTF using memory: ${mem1m.length} 1m bars → 5m:${c5m.length} 15m:${c15m.length} 1h:${c1h.length}`);
    } else {
        // Startup: memory empty, fetch all from Yahoo directly
        console.log('📊 MTF memory empty — fetching all TFs from Yahoo (startup fallback)');
        [c5m, c15m, c1h] = await Promise.all([
            fetchCandlesFromYahoo('5m'),
            fetchCandlesFromYahoo('15m'),
            fetchCandlesFromYahoo('1h'),
        ]);
    }

    // ── Step 2: Yahoo fallback per TF when resampled bars are insufficient ────
    // After resampling, check each TF against its minimum. If still short,
    // fetch historical Yahoo candles for that specific TF. This runs mostly
    // for 15m and 1h during the first 90 min of the session.
    const fetchPromises = [];

    // 5m Yahoo fallback — without this, 5m stays INSUFFICIENT for the entire
    // session if startup happens after ~9:50 AM with < 22 bars in memory.
    // Yahoo 5m gives today's bars directly so ADX and RSI compute from first cycle.
    if (c5m.length < MIN_BARS['5m']) {
        fetchPromises.push(
            fetchCandlesFromYahoo('5m').then(yc => {
                if (yc.length > c5m.length) {
                    console.log(`📊 MTF 5m: resampled ${c5m.length} bars < ${MIN_BARS['5m']} min → Yahoo gave ${yc.length} bars ✅`);
                    c5m = yc;
                }
            })
        );
    }

    if (c15m.length < MIN_BARS['15m']) {
        fetchPromises.push(
            fetchCandlesFromYahoo('15m').then(yc => {
                if (yc.length > c15m.length) {
                    console.log(`📊 MTF 15m: resampled ${c15m.length} bars < ${MIN_BARS['15m']} min → Yahoo gave ${yc.length} bars ✅`);
                    c15m = yc;
                }
            })
        );
    }

    if (c1h.length < MIN_BARS['1h']) {
        fetchPromises.push(
            fetchCandlesFromYahoo('1h').then(yc => {
                if (yc.length > c1h.length) {
                    console.log(`📊 MTF 1h: resampled ${c1h.length} bars < ${MIN_BARS['1h']} min → Yahoo gave ${yc.length} bars ✅`);
                    c1h = yc;
                }
            })
        );
    }

    if (fetchPromises.length > 0) {
        await Promise.all(fetchPromises);
    }

    // ── Step 3: Compute indicators per TF ────────────────────────────────────
    const tf5m  = calcIndicators(c5m,  '5m');
    const tf15m = calcIndicators(c15m, '15m');
    const tf1h  = calcIndicators(c1h,  '1h');

    // ── Step 4: Build MTF composite signal ───────────────────────────────────
    // INSUFFICIENT TFs are excluded from voting — they don't count as NEUTRAL
    // and don't block the quality gate. They are logged so the user knows.
    const validTFs    = [tf5m, tf15m, tf1h].filter(tf => tf.signal !== 'INSUFFICIENT');
    const allTFs      = [tf5m, tf15m, tf1h];
    const tfLabels    = ['5m', '15m', '1h'];

    allTFs.forEach((tf, i) => {
        const bars = tf.barCount ?? '?';
        if (tf.signal === 'INSUFFICIENT') {
            console.log(`⚠️ MTF ${tfLabels[i]}: INSUFFICIENT data (${bars} bars < ${MIN_BARS[tfLabels[i]]} min) — excluded from vote`);
        } else if (tf.adx !== null && tf.adx < 20) {
            console.log(`⚠️ MTF ${tfLabels[i]}: ADX ${tf.adx} < 20 → NEUTRAL override`);
        }
    });

    const bullCount = validTFs.filter(tf => tf.signal === 'BULLISH').length;
    const bearCount = validTFs.filter(tf => tf.signal === 'BEARISH').length;
    const validCount = validTFs.length;

    // aligned = all valid TFs agree (minimum 2 valid TFs required to claim alignment)
    const aligned = validCount >= 2 && (bullCount === validCount || bearCount === validCount);

    let mtfSignal = 'WAIT', mtfStrength = 'WEAK', mtfConfidence = 0;

    if (validCount === 0) {
        // No usable TFs at all — happens only in first few minutes of session
        mtfSignal = 'WAIT'; mtfStrength = 'WEAK'; mtfConfidence = 0;
    } else if (aligned && bullCount === validCount) {
        mtfStrength   = validCount === 3 ? 'STRONG' : 'MODERATE';
        mtfSignal     = 'BUY CALL';
        mtfConfidence = validCount === 3 ? 85 : 65;
    } else if (aligned && bearCount === validCount) {
        mtfStrength   = validCount === 3 ? 'STRONG' : 'MODERATE';
        mtfSignal     = 'BUY PUT';
        mtfConfidence = validCount === 3 ? 85 : 65;
    } else if (bullCount > bearCount) {
        mtfSignal = 'WAIT'; mtfStrength = 'WEAK'; mtfConfidence = 25;
    } else if (bearCount > bullCount) {
        mtfSignal = 'WAIT'; mtfStrength = 'WEAK'; mtfConfidence = 25;
    }

    // ── Step 5: Integrity log ─────────────────────────────────────────────────
    console.log(
        `MTF → 5m:${tf5m.signal}(${tf5m.barCount}bars,ADX:${tf5m.adx??'--'})`,
        `15m:${tf15m.signal}(${tf15m.barCount}bars,ADX:${tf15m.adx??'--'})`,
        `1h:${tf1h.signal}(${tf1h.barCount}bars,ADX:${tf1h.adx??'--'})`,
        `→ ${mtfSignal} (${mtfStrength}) [${validCount}/3 valid TFs]`
    );

    return {
        tf5m, tf15m, tf1h,
        mtfSignal, mtfStrength, mtfConfidence,
        bullCount, bearCount,
        aligned,
        validTFCount: validCount,
        tf5mWarming: tf5m.signal === 'INSUFFICIENT', // true during first ~22 min after restart
        tf5mBarsNeeded: tf5m.signal === 'INSUFFICIENT' ? (MIN_BARS['5m'] - (tf5m.barCount ?? 0)) : 0,
    };
}

module.exports = { analyzeMultiTimeframe };