'use strict';
// multiTimeframe.js — RSI/EMA/VWAP/ADX across 5m, 15m, 1h
//
// Candle source priority (same logic as marketData.js):
//   1. In-memory 1m candles from Angel WebSocket → resample to 5m/15m/1h
//   2. NSE intraday fallback (often times out from Railway — used only if memory empty)
//
// Resampling 1m → 5m/15m/1h avoids all NSE chart API calls entirely.
// Once the WebSocket has been running for 60+ minutes there is enough
// 1m history to produce reliable 5m (12+ bars), 15m (4+ bars), 1h (1+ bar).

const { RSI, EMA, VWAP } = require('technicalindicators');
const { fetchYahooChart } = require('./yahooFetch');
const { getCandleHistory, getSessionCandles } = require('./indicators');

// ── Resample 1m candles → higher timeframe ────────────────────────────────────
function resample(candles1m, periodMins) {
    if (!candles1m || candles1m.length === 0) return [];
    const out = [];
    let bucket = null;
    let count  = 0;
    for (const c of candles1m) {
        if (!bucket) {
            bucket = { open: c.close, high: c.high, low: c.low, close: c.close, volume: c.volume || 1, ts: c.ts };
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
    // Include partial last bucket so the latest price is always reflected
    if (bucket) out.push({ ...bucket });
    return out;
}

// ── Filter to today's IST session ────────────────────────────────────────────
function todaySessionCandles(candles) {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIST   = new Date(Date.now() + IST_OFFSET_MS);
    const todayStr = nowIST.toISOString().slice(0, 10);
    const session  = candles.filter(c => {
        if (!c.ts) return false;
        const istDate = new Date(c.ts + IST_OFFSET_MS).toISOString().slice(0, 10);
        return istDate === todayStr;
    });
    return session.length >= 2 ? session : candles.slice(-80);
}

// ── NSE fallback fetch (only used when memory is empty) ───────────────────────
async function fetchCandlesFromNSE(interval, range) {
    try {
        const result = await fetchYahooChart('%5ENSEI', { interval, range, includePrePost: false });
        if (!result) return [];
        const quotes     = result.indicators?.quote?.[0];
        const timestamps = result.timestamp || [];
        if (!quotes) return [];
        const closes  = quotes.close  || [];
        const highs   = quotes.high   || [];
        const lows    = quotes.low    || [];
        const volumes = quotes.volume || [];
        const candles = [];
        for (let i = 0; i < closes.length; i++) {
            if (closes[i] != null && highs[i] != null && lows[i] != null) {
                candles.push({
                    ts    : timestamps[i] ? timestamps[i] * 1000 : null,
                    close : parseFloat(closes[i].toFixed(2)),
                    high  : parseFloat(highs[i].toFixed(2)),
                    low   : parseFloat(lows[i].toFixed(2)),
                    volume: volumes[i] || 1
                });
            }
        }
        return candles;
    } catch (err) {
        console.error(`Candle fetch error (${interval}):`, err.message);
        return [];
    }
}

// ── ADX (Wilder's smoothing, period=14) ───────────────────────────────────────
function calculateADX(candles, period = 14) {
    if (!candles || candles.length < Math.max(period * 2 + 2, 60)) return null;
    try {
        const valid = candles.filter(c =>
            c.high != null && c.low != null && c.close != null && c.high > c.low
        );
        if (valid.length < Math.max(period * 2 + 2, 60)) return null;
        const tr = [], dmp = [], dmm = [];
        for (let i = 1; i < valid.length; i++) {
            const h = valid[i].high, l = valid[i].low, pc = valid[i-1].close;
            const ph = valid[i-1].high, pl = valid[i-1].low;
            tr .push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
            const up = h - ph, dn = pl - l;
            dmp.push(up > dn && up > 0 ? up : 0);
            dmm.push(dn > up && dn > 0 ? dn : 0);
        }
        function wilderSmooth(arr) {
            let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
            const out = [s];
            for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); }
            return out;
        }
        const atr  = wilderSmooth(tr);
        const sdmp = wilderSmooth(dmp);
        const sdmm = wilderSmooth(dmm);
        const dip  = sdmp.map((v, i) => atr[i] > 0 ? (v / atr[i]) * 100 : 0);
        const dim  = sdmm.map((v, i) => atr[i] > 0 ? (v / atr[i]) * 100 : 0);
        const dx   = dip.map((v, i) => { const s = v + dim[i]; return s > 0 ? (Math.abs(v - dim[i]) / s) * 100 : 0; });
        const adxArr = wilderSmooth(dx);
        const adxVal = parseFloat(adxArr[adxArr.length - 1].toFixed(2));
        if (adxVal > 100 || adxVal < 0) return null;
        return {
            adx    : adxVal,
            diPlus : parseFloat(Math.min(100, dip[dip.length - 1]).toFixed(2)),
            diMinus: parseFloat(Math.min(100, dim[dim.length - 1]).toFixed(2))
        };
    } catch (_) { return null; }
}

function calcIndicators(candles) {
    if (!candles || candles.length < 5) {
        return { rsi: null, ema9: null, ema21: null, vwap: null, adx: null, close: null, signal: 'NEUTRAL', score: 0 };
    }
    const closes = candles.map(c => c.close);
    const close  = closes[closes.length - 1];

    let rsi = null;
    if (closes.length >= 15) {
        const r = RSI.calculate({ values: closes, period: 14 });
        rsi = r.length > 0 ? parseFloat(r[r.length - 1].toFixed(2)) : null;
    }
    let ema9 = null;
    if (closes.length >= 9) {
        const r = EMA.calculate({ values: closes, period: 9 });
        ema9 = r.length > 0 ? parseFloat(r[r.length - 1].toFixed(2)) : null;
    }
    let ema21 = null;
    if (closes.length >= 21) {
        const r = EMA.calculate({ values: closes, period: 21 });
        ema21 = r.length > 0 ? parseFloat(r[r.length - 1].toFixed(2)) : null;
    }
    let vwap = null;
    const sessionC = todaySessionCandles(candles);
    if (sessionC.length >= 2) {
        try {
            const r = VWAP.calculate({
                high  : sessionC.map(c => c.high),
                low   : sessionC.map(c => c.low),
                close : sessionC.map(c => c.close),
                volume: sessionC.map(c => c.volume)
            });
            vwap = r.length > 0 ? parseFloat(r[r.length - 1].toFixed(2)) : null;
        } catch(e) {}
    }

    const adxData  = calculateADX(sessionC);
    const adxVal   = adxData?.adx ?? null;
    const adxValid = adxVal === null || adxVal >= 20;

    let bull = 0, bear = 0;
    if (rsi !== null) {
        if (rsi < 35) bull += 2; else if (rsi > 65) bear += 2;
        else if (rsi >= 50) bull += 1; else bear += 1;
    }
    if (ema9 !== null && ema21 !== null) {
        if (ema9 > ema21) bull += 2; else bear += 2;
    }
    if (vwap !== null) {
        if (close > vwap) bull += 2; else bear += 2;
    }

    const total  = bull + bear;
    const pct    = total > 0 ? (bull / total) * 100 : 50;
    const signal = !adxValid ? 'NEUTRAL' : pct >= 60 ? 'BULLISH' : pct <= 40 ? 'BEARISH' : 'NEUTRAL';
    const score  = parseFloat(pct.toFixed(0));

    return { rsi, ema9, ema21, vwap, adx: adxVal, close, signal, score };
}

async function analyzeMultiTimeframe() {
    console.log('📊 Fetching multi-timeframe data...');

    // ── Primary: resample in-memory 1m candles ────────────────────────────────
    const mem1m = getCandleHistory();
    let c5m, c15m, c1h;

    if (mem1m && mem1m.length >= 15) {
        // Enough in-memory data — resample, no NSE call needed
        c5m  = resample(mem1m, 5);
        c15m = resample(mem1m, 15);
        c1h  = resample(mem1m, 60);
        console.log(`📊 MTF using memory: ${mem1m.length} 1m bars → 5m:${c5m.length} 15m:${c15m.length} 1h:${c1h.length}`);
    } else {
        // Fallback: fetch from NSE (startup only, before WS warms up)
        console.log('📊 MTF memory empty — fetching from NSE (startup fallback)');
        [c5m, c15m, c1h] = await Promise.all([
            fetchCandlesFromNSE('5m',  '5d'),
            fetchCandlesFromNSE('15m', '5d'),
            fetchCandlesFromNSE('60m', '1mo')
        ]);
    }

    const tf5m  = calcIndicators(c5m);
    const tf15m = calcIndicators(c15m);
    const tf1h  = calcIndicators(c1h);

    const signals   = [tf5m.signal, tf15m.signal, tf1h.signal];
    const bullCount = signals.filter(s => s === 'BULLISH').length;
    const bearCount = signals.filter(s => s === 'BEARISH').length;

    [tf5m, tf15m, tf1h].forEach((tf, i) => {
        const label = ['5m','15m','1h'][i];
        if (tf.adx !== null && tf.adx < 20) {
            console.log(`⚠️ MTF: ${label} ADX ${tf.adx} < 20 → forced NEUTRAL`);
        }
    });

    let mtfSignal = 'WAIT', mtfStrength = 'WEAK', mtfConfidence = 0;
    if      (bullCount === 3) { mtfSignal = 'BUY CALL'; mtfStrength = 'STRONG';   mtfConfidence = 85; }
    else if (bullCount === 2) { mtfSignal = 'BUY CALL'; mtfStrength = 'MODERATE'; mtfConfidence = 60; }
    else if (bearCount === 3) { mtfSignal = 'BUY PUT';  mtfStrength = 'STRONG';   mtfConfidence = 85; }
    else if (bearCount === 2) { mtfSignal = 'BUY PUT';  mtfStrength = 'MODERATE'; mtfConfidence = 60; }
    else                      { mtfSignal = 'WAIT';     mtfStrength = 'WEAK';     mtfConfidence = 20; }

    console.log(
        `MTF → 5m:${tf5m.signal}(ADX:${tf5m.adx??'--'})`,
        `15m:${tf15m.signal}(ADX:${tf15m.adx??'--'})`,
        `1h:${tf1h.signal}(ADX:${tf1h.adx??'--'})`,
        `→ ${mtfSignal} (${mtfStrength})`
    );

    return { tf5m, tf15m, tf1h, mtfSignal, mtfStrength, mtfConfidence,
             bullCount, bearCount, aligned: bullCount === 3 || bearCount === 3 };
}

module.exports = { analyzeMultiTimeframe };