// ── Trend Rider setup (15 Sep) ────────────────────────────────────────────
// Purpose: on a genuinely trending day, combineSignals' own gates (rsiClean,
// adxTrend as mean-reversion-style safety checks) can correctly sit out a
// sustained, extended move — extreme RSI reads as "exhausted, don't chase"
// there, which is the RIGHT call on a choppy day but can miss a real trend
// day where sustained extreme RSI is continuation, not exhaustion. This is
// a deliberately DIFFERENT philosophy, not a loosened version of the Main
// Engine's gates — those stay exactly as they are (see 15 Sep analysis:
// the Main Engine's caution on 15 Sep was correct given the actual gate
// values, and touching it would trade that correctness away on other days).
//
// Distinguishes genuine trend continuation from a single spike using THREE
// independent checks, all of which must agree:
//   1. Trend day confirmed (dayType.trendProbability + MTF alignment) —
//      already-computed, reliable signals, not re-derived here.
//   2. SUSTAINED extreme RSI (multiple recent candles, not one tick) +
//      structural confirmation (consistent higher-highs or lower-lows) —
//      a one-candle RSI spike doesn't pass; a multi-candle grind does.
//   3. Pullback-and-resume entry timing — waits for price to pull back
//      toward EMA9 and resume in the trend direction, rather than firing
//      at the raw extreme (which is exactly the "chasing" combineSignals'
//      own Physics Law-3 gate exists to avoid).
//
// Exploratory tier, same as Fast/Stock Momentum and 52-Week Reversal —
// genuinely harder problem than those (trend-vs-exhaustion has no clean
// mechanical answer), expect a lower hit rate, tune from real outcomes.
const { RSI, EMA } = require('technicalindicators');

const TREND_RIDER_MIN_TREND_PROB   = 60;   // dayType.trendProbability floor
const TREND_RIDER_MIN_ADX          = 25;   // real trend strength, stricter than combineSignals' own 20 floor
const TREND_RIDER_RSI_EXTREME_HIGH = 65;   // bullish extreme threshold
const TREND_RIDER_RSI_EXTREME_LOW  = 35;   // bearish extreme threshold
const TREND_RIDER_SUSTAIN_WINDOW   = 6;    // candles to check for sustained extreme
const TREND_RIDER_SUSTAIN_MIN      = 4;    // of those 6, how many must be extreme
const TREND_RIDER_STRUCTURE_WINDOW = 8;    // candles to check for HH/LL structure
const TREND_RIDER_STRUCTURE_MIN    = 4;    // of 7 comparisons, how many must confirm structure — tolerates a 2-3 candle pullback within a real trend
const TREND_RIDER_PULLBACK_RATIO   = 0.6;  // current EMA9 distance must be ≤60% of the recent max extension — adaptive, not a fixed %, since EMA lag scales with how fast the trend is moving

function computeTrendRiderSetup(candles, dayType, mtf, adx) {
    if (!dayType || dayType.trendProbability < TREND_RIDER_MIN_TREND_PROB) return null;
    if (!mtf || !mtf.aligned) return null;
    const direction = mtf.signal === 'BUY CALL' ? 'BULLISH' : mtf.signal === 'BUY PUT' ? 'BEARISH' : null;
    if (!direction) return null;

    if (!adx || adx.adx == null || adx.adx < TREND_RIDER_MIN_ADX) return null;

    if (!candles || candles.length < 30) return null;
    const closes = candles.map(c => c.close).filter(c => c != null);
    if (closes.length < 30) return null;

    const rsiSeries = RSI.calculate({ values: closes, period: 9 });
    const ema9Series = EMA.calculate({ values: closes, period: 9 });
    if (rsiSeries.length < TREND_RIDER_SUSTAIN_WINDOW || ema9Series.length < TREND_RIDER_SUSTAIN_WINDOW) return null;

    // Check 1: sustained extreme, not a one-candle spike.
    const recentRSI = rsiSeries.slice(-TREND_RIDER_SUSTAIN_WINDOW);
    const extremeCount = direction === 'BULLISH'
        ? recentRSI.filter(r => r >= TREND_RIDER_RSI_EXTREME_HIGH).length
        : recentRSI.filter(r => r <= TREND_RIDER_RSI_EXTREME_LOW).length;
    if (extremeCount < TREND_RIDER_SUSTAIN_MIN) return null;

    // Check 2: structural confirmation — consistent higher-highs (bullish) or
    // lower-lows (bearish) over the recent window. Tolerant of 2-3 pullback
    // candles within the window (real trends aren't monotonic every candle).
    const recentCandles = candles.slice(-TREND_RIDER_STRUCTURE_WINDOW);
    if (recentCandles.length < TREND_RIDER_STRUCTURE_WINDOW) return null;
    let structureHits = 0;
    for (let i = 1; i < recentCandles.length; i++) {
        if (direction === 'BULLISH' && recentCandles[i].high > recentCandles[i-1].high) structureHits++;
        if (direction === 'BEARISH' && recentCandles[i].low  < recentCandles[i-1].low)  structureHits++;
    }
    if (structureHits < TREND_RIDER_STRUCTURE_MIN) return null;

    // Check 3: pullback-and-resume entry timing. EMA9 is a moving-average of
    // closes.slice(0, -(period-1)) worth of data — ema9Series[i] corresponds
    // to closes[closes.length - ema9Series.length + i], not closes[i]
    // directly, since the EMA needs `period` warm-up candles before its
    // first value. emaOffset below re-aligns the two series correctly.
    const emaOffset = closes.length - ema9Series.length;
    const distanceAt = (closesIdx) => {
        const emaIdx = closesIdx - emaOffset;
        if (emaIdx < 0 || emaIdx >= ema9Series.length) return null;
        const c = closes[closesIdx], e = ema9Series[emaIdx];
        return e > 0 ? Math.abs((c - e) / e) * 100 : null;
    };

    const sustainStartIdx = closes.length - TREND_RIDER_SUSTAIN_WINDOW;
    const sustainDistances = [];
    for (let i = sustainStartIdx; i < closes.length; i++) {
        const d = distanceAt(i);
        if (d != null) sustainDistances.push(d);
    }
    const maxExtension = sustainDistances.length ? Math.max(...sustainDistances) : null;
    const currentDist = distanceAt(closes.length - 1);
    if (maxExtension == null || currentDist == null || maxExtension <= 0) return null;

    // Adaptive pullback: current distance from EMA9 must have shrunk to
    // ≤60% of how far price extended during the sustained-extreme run —
    // scales with the trend's own volatility instead of a fixed % that
    // would be too tight in a fast trend and too loose in a slow one.
    const pulledBackEnough = currentDist <= maxExtension * TREND_RIDER_PULLBACK_RATIO;
    if (!pulledBackEnough) return null;

    const lastCandle = candles[candles.length - 1];
    if (lastCandle.open == null || lastCandle.close == null) return null;
    const resuming = direction === 'BULLISH' ? lastCandle.close > lastCandle.open : lastCandle.close < lastCandle.open;
    if (!resuming) return null;

    return {
        direction,
        trendProbability: dayType.trendProbability,
        adx: parseFloat(adx.adx.toFixed(1)),
        rsi: parseFloat(recentRSI[recentRSI.length - 1].toFixed(1)),
        extremeCount,
        ema9: parseFloat(ema9Series[ema9Series.length - 1].toFixed(1)),
        ltp: closes[closes.length - 1],
        pullbackDistPct: parseFloat(currentDist.toFixed(3)),
        maxExtensionPct: parseFloat(maxExtension.toFixed(3)),
    };
}

module.exports = { computeTrendRiderSetup };
