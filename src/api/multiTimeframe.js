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


function calcIndicators(candles) {
    if (!candles || candles.length < 5) {
        return {
            rsi  : null,
            ema9 : null,
            ema21: null,
            vwap : null,
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

    // Score
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
    const signal = pct >= 60 ? 'BULLISH' : pct <= 40 ? 'BEARISH' : 'NEUTRAL';
    const score  = parseFloat((pct).toFixed(0));

    return { rsi, ema9, ema21, vwap, close, signal, score };
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

    // Alignment check
    const signals = [tf5m.signal, tf15m.signal, tf1h.signal];
    const bullCount = signals.filter(s => s === 'BULLISH').length;
    const bearCount = signals.filter(s => s === 'BEARISH').length;

    let mtfSignal    = 'WAIT';
    let mtfStrength  = 'WEAK';
    let mtfConfidence = 0;

    if (bullCount === 3) {
        mtfSignal     = 'BUY CALL';
        mtfStrength   = 'STRONG';
        mtfConfidence = 90;
    } else if (bullCount === 2) {
        mtfSignal     = 'BUY CALL';
        mtfStrength   = 'MODERATE';
        mtfConfidence = 65;
    } else if (bearCount === 3) {
        mtfSignal     = 'BUY PUT';
        mtfStrength   = 'STRONG';
        mtfConfidence = 90;
    } else if (bearCount === 2) {
        mtfSignal     = 'BUY PUT';
        mtfStrength   = 'MODERATE';
        mtfConfidence = 65;
    } else {
        mtfSignal     = 'WAIT';
        mtfStrength   = 'WEAK';
        mtfConfidence = 20;
    }

    console.log(
        `MTF → 5m:${tf5m.signal}`,
        `15m:${tf15m.signal}`,
        `1h:${tf1h.signal}`,
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
