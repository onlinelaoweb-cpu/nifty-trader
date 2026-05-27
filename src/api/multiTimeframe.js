const axios = require('axios');
const { RSI, EMA, VWAP } = require('technicalindicators');

// ── Fetch candles from Yahoo Finance ─────────────────
async function fetchCandles(interval, range) {
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=${interval}&range=${range}&includePrePost=false`;

        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept'    : 'application/json'
            },
            timeout: 10000
        });

        const result     = res.data?.chart?.result?.[0];
        const quotes     = result?.indicators?.quote?.[0];
        const timestamps = result?.timestamp || [];
        if (!quotes) return [];

        const closes  = quotes.close  || [];
        const highs   = quotes.high   || [];
        const lows    = quotes.low    || [];
        const volumes = quotes.volume || [];

        const candles = [];
        for (let i = 0; i < closes.length; i++) {
            if (closes[i] != null && highs[i] != null && lows[i] != null) {
                candles.push({
                    ts    : timestamps[i] ? timestamps[i] * 1000 : null,   // ← unix ms
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

// ── Filter candles to the current IST trading session ─
// VWAP must reset at 09:15 IST each day; using multi-day
// candles inflates/deflates the anchor and produces the
// cross-timeframe divergence seen in the MTF output.
function todaySessionCandles(candles) {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;           // UTC+5:30
    const nowIST  = new Date(Date.now() + IST_OFFSET_MS);
    const todayStr = nowIST.toISOString().slice(0, 10);    // "YYYY-MM-DD"

    const session = candles.filter(c => {
        if (!c.ts) return false;
        const istDate = new Date(c.ts + IST_OFFSET_MS).toISOString().slice(0, 10);
        return istDate === todayStr;
    });

    // Fallback: if market hasn't opened yet or timestamps missing,
    // use the last 80 candles (≈ one 5-min session) so VWAP
    // never silently go multi-day.
    return session.length >= 2 ? session : candles.slice(-80);
}

// ── ADX Calculator (Wilder's smoothing, period=14) ────
// Shared with server.js logic — kept in sync manually.
// Uses today's session candles only to avoid overnight gap distortion.
// Returns { adx, diPlus, diMinus } or null when insufficient data.
function calculateADX(candles, period = 14) {
    // FIX 3: Require 60+ candles before ADX fires.
    // Early session (< 60 bars) ADX is noisy and tends to read high
    // due to Wilder's warm-up phase, producing false "trend confirmed" signals
    // before 10:00 AM. With fewer than 60 bars we simply skip the gate.
    if (!candles || candles.length < Math.max(period * 2 + 2, 60)) return null;
    try {
        const valid = candles.filter(c =>
            c.high != null && c.low != null && c.close != null && c.high > c.low
        );
        if (valid.length < Math.max(period * 2 + 2, 60)) return null;

        const tr = [], dmp = [], dmm = [];
        for (let i = 1; i < valid.length; i++) {
            const h = valid[i].high,   l = valid[i].low,   pc = valid[i - 1].close;
            const ph = valid[i - 1].high, pl = valid[i - 1].low;
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
        const n = adxArr.length - 1;
        const adxVal = parseFloat(adxArr[n].toFixed(2));
        if (adxVal > 100 || adxVal < 0) {
            console.warn(`⚠️ MTF ADX out of range (${adxVal}) — skipping`);
            return null;
        }
        return {
            adx    : adxVal,
            diPlus : parseFloat(Math.min(100, dip[dip.length - 1]).toFixed(2)),
            diMinus: parseFloat(Math.min(100, dim[dim.length - 1]).toFixed(2))
        };
    } catch (_) { return null; }
}

function calcIndicators(candles) {
    if (!candles || candles.length < 5) {
        return {
            rsi  : null,
            ema9 : null,
            ema21: null,
            vwap : null,
            adx  : null,   // ← NEW
            close: null,
            signal: 'NEUTRAL',
            score : 0
        };
    }

    const closes  = candles.map(c => c.close);
    const close   = closes[closes.length - 1];

    // RSI
    let rsi = null;
    if (closes.length >= 15) {
        const rsiResult = RSI.calculate({ values: closes, period: 14 });
        rsi = rsiResult.length > 0
            ? parseFloat(rsiResult[rsiResult.length - 1].toFixed(2))
            : null;
    }

    // EMA 9
    let ema9 = null;
    if (closes.length >= 9) {
        const r = EMA.calculate({ values: closes, period: 9 });
        ema9 = r.length > 0 ? parseFloat(r[r.length - 1].toFixed(2)) : null;
    }

    // EMA 21
    let ema21 = null;
    if (closes.length >= 21) {
        const r = EMA.calculate({ values: closes, period: 21 });
        ema21 = r.length > 0 ? parseFloat(r[r.length - 1].toFixed(2)) : null;
    }

    // VWAP — today's session only (resets at 09:15 IST)
    let vwap = null;
    const sessionCandles = todaySessionCandles(candles);
    if (sessionCandles.length >= 2) {
        try {
            const r = VWAP.calculate({
                high  : sessionCandles.map(c => c.high),
                low   : sessionCandles.map(c => c.low),
                close : sessionCandles.map(c => c.close),
                volume: sessionCandles.map(c => c.volume)
            });
            vwap = r.length > 0 ? parseFloat(r[r.length - 1].toFixed(2)) : null;
        } catch(e) {}
    }

    // ── FIX 1: Per-TF ADX check ───────────────────────
    // Only compute ADX from today's session candles for this TF.
    // Multi-day candles cause Wilder's warm-up distortion (ADX > 100).
    // If ADX < 20, this timeframe is sideways/choppy and should NOT
    // count toward MTF alignment — even if RSI/EMA/VWAP look bullish.
    const adxData  = calculateADX(sessionCandles);
    const adxVal   = adxData?.adx ?? null;
    const adxValid = adxVal === null || adxVal >= 20;   // null = not enough data → don't penalise

    // Score (only contributes when ADX confirms trend)
    let bull = 0, bear = 0;

    if (rsi !== null) {
        if (rsi < 35)        { bull += 2; }
        else if (rsi > 65)   { bear += 2; }
        else if (rsi >= 50)  { bull += 1; }
        else                 { bear += 1; }
    }

    if (ema9 !== null && ema21 !== null) {
        if (ema9 > ema21)    { bull += 2; }
        else                 { bear += 2; }
    }

    if (vwap !== null) {
        if (close > vwap)    { bull += 2; }
        else                 { bear += 2; }
    }

    const total  = bull + bear;
    const pct    = total > 0 ? (bull / total) * 100 : 50;

    // FIX 1 (continued): A TF signal is only BULLISH/BEARISH when ADX confirms trend.
    // If ADX < 20 for this TF, force NEUTRAL regardless of indicator score — a
    // sideways TF should never count as "aligned" in the composite MTF badge.
    let signal;
    if (!adxValid) {
        signal = 'NEUTRAL';   // choppy TF — excluded from alignment count
    } else {
        signal = pct >= 60 ? 'BULLISH' : pct <= 40 ? 'BEARISH' : 'NEUTRAL';
    }

    const score = parseFloat((pct).toFixed(0));

    return { rsi, ema9, ema21, vwap, adx: adxVal, close, signal, score };
}

// ── Analyze all timeframes ────────────────────────────
async function analyzeMultiTimeframe() {
    console.log('📊 Fetching multi-timeframe data...');

    const [c5m, c15m, c1h] = await Promise.all([
        fetchCandles('5m',  '5d'),
        fetchCandles('15m', '5d'),
        fetchCandles('60m', '1mo')
    ]);

    const tf5m  = calcIndicators(c5m);
    const tf15m = calcIndicators(c15m);
    const tf1h  = calcIndicators(c1h);

    // FIX 1 (final): Alignment only counts TFs whose ADX >= 20 (or ADX unavailable).
    // A TF forced to NEUTRAL by ADX < 20 does not contribute a bull or bear vote.
    // This prevents 3/3 "aligned" calls on choppy mornings where all TFs are ranging.
    const signals   = [tf5m.signal, tf15m.signal, tf1h.signal];
    const bullCount = signals.filter(s => s === 'BULLISH').length;
    const bearCount = signals.filter(s => s === 'BEARISH').length;

    // Log which TFs were suppressed by ADX
    [tf5m, tf15m, tf1h].forEach((tf, i) => {
        const label = ['5m','15m','1h'][i];
        if (tf.adx !== null && tf.adx < 20) {
            console.log(`⚠️ MTF: ${label} ADX ${tf.adx} < 20 → forced NEUTRAL (excluded from alignment)`);
        }
    });

    let mtfSignal    = 'WAIT';
    let mtfStrength  = 'WEAK';
    let mtfConfidence = 0;

    if (bullCount === 3) {
        mtfSignal     = 'BUY CALL';
        mtfStrength   = 'STRONG';
        mtfConfidence = 85;    // FIX 2: hard cap — never exceed 85%
    } else if (bullCount === 2) {
        mtfSignal     = 'BUY CALL';
        mtfStrength   = 'MODERATE';
        mtfConfidence = 60;
    } else if (bearCount === 3) {
        mtfSignal     = 'BUY PUT';
        mtfStrength   = 'STRONG';
        mtfConfidence = 85;    // FIX 2: hard cap — never exceed 85%
    } else if (bearCount === 2) {
        mtfSignal     = 'BUY PUT';
        mtfStrength   = 'MODERATE';
        mtfConfidence = 60;
    } else {
        mtfSignal     = 'WAIT';
        mtfStrength   = 'WEAK';
        mtfConfidence = 20;
    }

    console.log(
        `MTF → 5m:${tf5m.signal}(ADX:${tf5m.adx??'--'})`,
        `15m:${tf15m.signal}(ADX:${tf15m.adx??'--'})`,
        `1h:${tf1h.signal}(ADX:${tf1h.adx??'--'})`,
        `→ ${mtfSignal} (${mtfStrength})`
    );

    return {
        tf5m,
        tf15m,
        tf1h,
        mtfSignal,
        mtfStrength,
        mtfConfidence,
        bullCount,
        bearCount,
        aligned: bullCount === 3 || bearCount === 3
    };
}

module.exports = { analyzeMultiTimeframe };
