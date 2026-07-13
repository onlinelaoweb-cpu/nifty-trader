// ── Renko Trend Filter (informational only) ──────────────────────────────────
// Added after reviewing a course (Red Bar Theory / Renko-based option buying)
// with the user. Renko charts strip out time and plot fixed-size price bricks,
// which filters a lot of the tick-noise a normal candle chart shows. The idea
// is genuinely useful; the course's proprietary indicator/strategy is not
// something we can or should copy.
//
// IMPORTANT — this module is DISPLAY-ONLY. It does NOT gate, block, or resize
// any signal. It exists so the Insights tab can show a Renko read alongside
// everything else, and so we can informally observe over a few weeks whether
// it actually adds predictive value before ever considering making it a real
// gate. Given the app's past experience with over-gating (multiple rounds of
// "zero trades" incidents from stacking too many hard conditions), a brand
// new confirmation layer earns a gating role only after it's been watched
// working for a while — not on day one.

// ── ATR (Average True Range), Wilder's smoothing ────────────────────────────
// Used only to size Renko bricks dynamically (bigger brick in a fast/volatile
// session, smaller brick in a quiet one) so the brick size doesn't need
// manual tuning as volatility regimes change.
function calcATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const cur  = candles[i];
        const prev = candles[i - 1];
        const tr = Math.max(
            cur.high - cur.low,
            Math.abs(cur.high - prev.close),
            Math.abs(cur.low  - prev.close)
        );
        trs.push(tr);
    }
    if (trs.length < period) return null;
    // Wilder's smoothing: seed with simple average of first `period` TRs, then
    // roll forward exponentially — same method used for RSI elsewhere in the app.
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
}

// ── Renko brick construction ────────────────────────────────────────────────
// Standard close-based Renko: track a running reference level; every time
// price closes brickSize away from it, stamp one (or more, on a big move)
// brick(s) in that direction and shift the reference level accordingly.
// This is a simplified/close-only construction (no explicit reversal
// threshold) — adequate for a trend/noise read, not for precise wick-level
// charting.
function buildBricks(closes, brickSize) {
    if (!closes || closes.length < 2 || !brickSize || brickSize <= 0) return [];
    const bricks = [];
    let base = closes[0];
    for (let i = 1; i < closes.length; i++) {
        let diff = closes[i] - base;
        while (diff >= brickSize) {
            bricks.push('up');
            base += brickSize;
            diff -= brickSize;
        }
        while (diff <= -brickSize) {
            bricks.push('down');
            base -= brickSize;
            diff += brickSize;
        }
    }
    return bricks;
}

// ── Trend / noise classification over the last N bricks ────────────────────
// - 6-7 same color out of last 7  → clear trend (BULLISH/BEARISH)
// - 3+ color flips in last 7      → NOISY (choppy, avoid chasing)
// - anything else                 → MIXED (no strong read either way)
function classifyBricks(bricks) {
    const LOOKBACK = 7;
    if (bricks.length < 4) {
        return { trend: 'INSUFFICIENT', lookback: bricks.length, flips: null, upCount: null, downCount: null };
    }
    const recent = bricks.slice(-LOOKBACK);
    const upCount   = recent.filter(b => b === 'up').length;
    const downCount = recent.filter(b => b === 'down').length;
    let flips = 0;
    for (let i = 1; i < recent.length; i++) {
        if (recent[i] !== recent[i - 1]) flips++;
    }
    let trend;
    if (flips >= 3) {
        trend = 'NOISY';
    } else if (upCount >= recent.length - 1 && upCount > downCount) {
        trend = 'BULLISH';
    } else if (downCount >= recent.length - 1 && downCount > upCount) {
        trend = 'BEARISH';
    } else {
        trend = 'MIXED';
    }
    return { trend, lookback: recent.length, flips, upCount, downCount };
}

// ── Main entry point ─────────────────────────────────────────────────────────
// candles: array of {open,high,low,close,...} — pass getCandleHistory(true)
// (1m bars) from indicators.js. Returns null if not enough data yet (e.g.
// pre-market / just after deploy).
function getRenkoAnalysis(candles) {
    if (!candles || candles.length < 20) {
        return { trend: 'INSUFFICIENT', brickSize: null, bricks: [], flips: null, note: 'Not enough candle history yet' };
    }
    const atr = calcATR(candles, 14);
    // Brick size: round ATR to nearest 5 points, floor 15 / cap 40. These
    // bounds are a starting point for Nifty's typical intraday ATR range —
    // revisit once we have a few weeks of live readings to compare against.
    let brickSize = atr ? Math.round(atr / 5) * 5 : 20;
    brickSize = Math.max(15, Math.min(40, brickSize));

    const closes = candles.map(c => c.close);
    const bricks = buildBricks(closes, brickSize);
    const { trend, lookback, flips, upCount, downCount } = classifyBricks(bricks);

    return {
        trend,              // 'BULLISH' | 'BEARISH' | 'NOISY' | 'MIXED' | 'INSUFFICIENT'
        brickSize,
        atr: atr ? parseFloat(atr.toFixed(1)) : null,
        totalBricks: bricks.length,
        lastBricks: bricks.slice(-7),   // for a simple 🟩🟥 strip in the UI
        lookback, flips, upCount, downCount,
    };
}

module.exports = { getRenkoAnalysis, calcATR, buildBricks };