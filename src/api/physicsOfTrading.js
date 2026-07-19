'use strict';
// physicsOfTrading.js — "Physics of Trading" framework (Nitin Murarka / Nifty ke Nishanebaaz)
//
// Three Newton's Laws applied to trading, mapped onto VardaanNifty AI:
//
//   LAW 1 — Inertia ("Trend is your friend")
//     A trend (higher-highs/higher-lows, or lower-lows/lower-highs) stays in
//     motion until a real reversal force acts on it. Don't assume a top/bottom
//     just because price "looks extended". VardaanNifty AI already does most
//     of this via MTF alignment (5m/15m/1h) — this module adds an explicit
//     swing-structure check (HH/HL or LH/LL) as a second, independent vote.
//
//   LAW 2 — Acceleration (F = m·a → Force ≈ Volume × Price Momentum)
//     Force is read from Volume, OI buildup, PCR, Advance-Decline, VIX —
//     VardaanNifty AI already computes and scores ALL of these (PCR confluence,
//     volume spike, OI buildup interpretation, breadth). No new code needed
//     here; calcForceLabel() below just produces one human-readable summary
//     line from data the system already has, for display/Telegram use.
//
//   LAW 3 — Action/Reaction (every move has an equal & opposite reaction)
//     THIS IS THE MISSING PIECE. The video's core actionable rule: never
//     enter options on the "action" (the sharp move itself) — wait for the
//     "reaction" (pullback/retracement) and enter there. Two entry methods:
//       (a) Entry at VWAP — price reacts near VWAP and resumes trend direction
//       (b) Fibonacci retracement — commonly the 38.2%–61.8% zone of the move
//     Beyond ~78.6% retracement = treat it as a likely trend change, not a
//     reaction — don't take the entry on the old-trend assumption.
//
// This module is intentionally self-contained (pure functions, no I/O) so it
// slots into server.js's existing Entry Quality Score block as one more
// scored component, exactly like the ADX/PCR/RSI/MTF/S-R/Candle components
// already there.

// ─────────────────────────────────────────────────────────────────────────
// LAW 1 — Swing structure (HH/HL or LH/LL) over the recent session candles
// ─────────────────────────────────────────────────────────────────────────
// Simple 3-bar pivot detection: a candle is a "swing high" if its high is
// greater than the highs of the candles immediately before and after it
// (and similarly for swing lows). We then check whether the last two swing
// highs are rising (higher-high) AND the last two swing lows are rising
// (higher-low) for an uptrend — or the mirror for a downtrend.
//
// lookback: how many recent closed candles to scan (default 30, e.g. last
// 30 one-minute candles ≈ last 30 min of session — tune via the `candles`
// you pass in; pass 5m/15m candles for a higher-timeframe read).
function findSwingPoints(candles, lookback = 30) {
    const c = candles.slice(-lookback);
    const swingHighs = [];
    const swingLows  = [];

    for (let i = 1; i < c.length - 1; i++) {
        const prev = c[i - 1], cur = c[i], next = c[i + 1];
        if (cur.high > prev.high && cur.high > next.high) {
            swingHighs.push({ index: i, price: cur.high });
        }
        if (cur.low < prev.low && cur.low < next.low) {
            swingLows.push({ index: i, price: cur.low });
        }
    }
    return { swingHighs, swingLows };
}

// Returns: { trend: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS' | 'UNKNOWN', reason: string }
function getSwingTrend(candles, lookback = 30) {
    if (!candles || candles.length < 8) {
        return { trend: 'UNKNOWN', reason: 'Not enough candles for swing structure' };
    }

    const { swingHighs, swingLows } = findSwingPoints(candles, lookback);

    if (swingHighs.length < 2 || swingLows.length < 2) {
        return { trend: 'UNKNOWN', reason: 'Not enough swing points yet' };
    }

    const lastTwoHighs = swingHighs.slice(-2);
    const lastTwoLows  = swingLows.slice(-2);

    const higherHigh = lastTwoHighs[1].price > lastTwoHighs[0].price;
    const higherLow  = lastTwoLows[1].price  > lastTwoLows[0].price;
    const lowerHigh  = lastTwoHighs[1].price < lastTwoHighs[0].price;
    const lowerLow   = lastTwoLows[1].price  < lastTwoLows[0].price;

    if (higherHigh && higherLow) {
        return { trend: 'UPTREND', reason: `HH ${lastTwoHighs[0].price}→${lastTwoHighs[1].price}, HL ${lastTwoLows[0].price}→${lastTwoLows[1].price}` };
    }
    if (lowerHigh && lowerLow) {
        return { trend: 'DOWNTREND', reason: `LH ${lastTwoHighs[0].price}→${lastTwoHighs[1].price}, LL ${lastTwoLows[0].price}→${lastTwoLows[1].price}` };
    }

    // ── FIX: majority-vote + net-direction fallback ──────────────────────────
    // Comparing ONLY the last two swing highs/lows was too fragile: a single
    // small bounce/consolidation candle right after a sharp, strong move (e.g.
    // a fast crash) flips one pivot and the whole read falls through to
    // SIDEWAYS — even while ADX is EXPLOSIVE and RSI is deep in oversold/
    // overbought territory confirming a real, obvious trend. Real case seen:
    // a -546pt / -2.2% one-directional session showed "No clear trend —
    // choppy/sideways" here purely because the last 30min window (post-crash
    // consolidation) had one counter-swing.
    // Fallback: vote across ALL consecutive swing pairs in the window (not
    // just the last one) AND require the net direction (first swing point vs
    // last swing point) to agree — so an isolated bounce can't flip the read,
    // but genuine range-bound chop (no net movement) still correctly shows
    // SIDEWAYS.
    const dir = (a, b) => a > b ? 'UP' : a < b ? 'DOWN' : 'FLAT';
    const highPairs = swingHighs.slice(1).map((h, i) => dir(h.price, swingHighs[i].price));
    const lowPairs  = swingLows.slice(1).map((l, i) => dir(l.price, swingLows[i].price));
    const upVotes   = highPairs.filter(x => x === 'UP').length   + lowPairs.filter(x => x === 'UP').length;
    const downVotes = highPairs.filter(x => x === 'DOWN').length + lowPairs.filter(x => x === 'DOWN').length;

    const netHighDir = dir(swingHighs[swingHighs.length - 1].price, swingHighs[0].price);
    const netLowDir   = dir(swingLows[swingLows.length - 1].price,  swingLows[0].price);

    if (upVotes > downVotes && netHighDir !== 'DOWN' && netLowDir !== 'DOWN') {
        return { trend: 'UPTREND', reason: `Majority swing vote UP (${upVotes} vs ${downVotes}) — net ${swingLows[0].price}→${swingHighs[swingHighs.length - 1].price}` };
    }
    if (downVotes > upVotes && netHighDir !== 'UP' && netLowDir !== 'UP') {
        return { trend: 'DOWNTREND', reason: `Majority swing vote DOWN (${downVotes} vs ${upVotes}) — net ${swingHighs[0].price}→${swingLows[swingLows.length - 1].price}` };
    }

    return { trend: 'SIDEWAYS', reason: 'Mixed swing structure — no clean HH/HL or LH/LL, and no clear majority' };
}

// ─────────────────────────────────────────────────────────────────────────
// LAW 2 — Force summary (display-only; scoring already exists elsewhere)
// ─────────────────────────────────────────────────────────────────────────
// Takes data VardaanNifty AI already computes (PCR, OI buildup interpretation,
// volume spike, VIX, advance-decline) and produces one human-readable line,
// e.g. for Telegram alerts or the dashboard "Physics" panel.
function calcForceLabel({ pcr, oiInterpretation, volumeSpike, vix, adRatio } = {}) {
    const bits = [];
    if (pcr != null) {
        if (pcr > 1.2)      bits.push('PCR bullish');
        else if (pcr < 0.8) bits.push('PCR bearish');
        else                bits.push('PCR neutral');
    }
    if (oiInterpretation) bits.push(`OI: ${oiInterpretation}`);
    if (volumeSpike)      bits.push('Volume spike ✅');
    if (vix != null)      bits.push(vix < 14 ? 'VIX low (stable force)' : vix > 20 ? 'VIX high (active force)' : 'VIX moderate');
    if (adRatio != null)  bits.push(adRatio > 1 ? 'A/D bullish' : adRatio < 1 ? 'A/D bearish' : 'A/D flat');

    return bits.length ? bits.join(' | ') : 'Force data unavailable';
}

// ─────────────────────────────────────────────────────────────────────────
// LAW 3 — Fibonacci retracement of the most recent impulse swing
// ─────────────────────────────────────────────────────────────────────────
// Given a swing low and swing high (the last clean impulse move), returns
// the standard retracement levels. `direction` is 'UP' (low→high impulse,
// so retracement pulls back DOWN from the high) or 'DOWN' (high→low impulse,
// retracement pulls back UP from the low).
function calcFibonacciLevels(swingLow, swingHigh, direction) {
    const range = swingHigh - swingLow;
    if (range <= 0) return null;

    const pct = (p) => direction === 'UP'
        ? swingHigh - range * p   // retracing down from the high
        : swingLow  + range * p;  // retracing up from the low

    return {
        level0     : direction === 'UP' ? swingHigh : swingLow,   // 0% = start of reaction
        level236   : pct(0.236),
        level382   : pct(0.382),
        level500   : pct(0.5),
        level618   : pct(0.618),
        level786   : pct(0.786),
        level100   : direction === 'UP' ? swingLow : swingHigh,   // 100% = full reversal
    };
}

// Finds the most recent impulse leg (last swing low → last swing high, or
// vice versa, whichever is more recent) to build Fibonacci levels from.
// KEY FIX: without a minimum swing-size filter, any 3-bar micro-wick (5-6
// points on a 1m chart) qualifies as an "impulse" — all Fib levels end up
// packed into a Rs.5 range, and retrace% blows up to 300-400% because
// current price is far outside that tiny range (as seen on dashboard at
// 10:01 — 390% retrace, 5-point swing). We now enforce:
//   1. minSwingPct  — leg must be >= 0.20% of price (~48 pts at Nifty 24000)
//   2. minSwingPts  — hard floor of 30 pts for safety on low-vol days
// Also increased default lookback 30 -> 60 so we scan a full hour of 1m
// candles and are more likely to find a real swing leg.
function getLatestImpulseFibo(candles, lookback = 60) {
    const MIN_SWING_PCT = 0.20;  // 0.20% of price ~ 48 pts at Nifty 24000
    const MIN_SWING_PTS = 30;    // absolute floor regardless of price level

    const { swingHighs, swingLows } = findSwingPoints(candles, lookback);
    if (!swingHighs.length || !swingLows.length) return null;

    const lastHigh = swingHighs[swingHighs.length - 1];
    const lastLow  = swingLows[swingLows.length - 1];

    let direction, swingLow, swingHigh;
    if (lastHigh.index > lastLow.index) {
        direction = 'UP';
        swingHigh = lastHigh.price;
        const priorLow = [...swingLows].reverse().find(l => l.index < lastHigh.index);
        swingLow = priorLow ? priorLow.price : lastLow.price;
    } else {
        direction = 'DOWN';
        swingLow = lastLow.price;
        const priorHigh = [...swingHighs].reverse().find(h => h.index < lastLow.index);
        swingHigh = priorHigh ? priorHigh.price : lastHigh.price;
    }

    // ── Minimum swing size guard ─────────────────────────────────────────
    const swingSize = swingHigh - swingLow;
    const swingPct  = swingLow > 0 ? (swingSize / swingLow) * 100 : 0;
    if (swingSize < MIN_SWING_PTS || swingPct < MIN_SWING_PCT) {
        return null;  // micro-swing, not a meaningful impulse leg
    }

    const fib = calcFibonacciLevels(swingLow, swingHigh, direction);
    if (!fib) return null;
    return { direction, swingLow, swingHigh, fib };
}

// ─────────────────────────────────────────────────────────────────────────
// LAW 2 — Volume confirmation of a reaction (Force ≈ Volume × Momentum)
// ─────────────────────────────────────────────────────────────────────────
// A healthy pullback/reaction should happen on DECLINING volume — it means
// the move is just a pause, not new selling/buying pressure. If volume is
// SPIKING during what looks like a "reaction", that's a red flag — it may
// be genuine reversal pressure, not a clean pullback to re-enter on.
//
// Compares the average volume of the last `recentN` candles (the reaction
// itself) against the average volume of the `recentN` candles before that
// (the original impulse move).
function getVolumeConfirmation(candles, recentN = 5) {
    if (!candles || candles.length < recentN * 2) {
        return { confirmed: null, reason: 'Not enough candles for volume check', volRatio: null };
    }

    const reactionCandles = candles.slice(-recentN);
    const impulseCandles  = candles.slice(-recentN * 2, -recentN);

    const avg = (arr) => arr.reduce((s, c) => s + (c.volume || 0), 0) / arr.length;
    const reactionVol = avg(reactionCandles);
    const impulseVol   = avg(impulseCandles);

    if (impulseVol <= 0) {
        return { confirmed: null, reason: 'No volume data on this feed (Yahoo fallback)', volRatio: null };
    }

    const volRatio = reactionVol / impulseVol;

    if (volRatio <= 0.85) {
        return { confirmed: true, reason: `Volume declining on the pullback (${volRatio.toFixed(2)}x of impulse) — healthy reaction`, volRatio };
    }
    if (volRatio >= 1.3) {
        return { confirmed: false, reason: `⚠️ Volume rising during the "reaction" (${volRatio.toFixed(2)}x of impulse) — could be real reversal pressure, not a clean pullback`, volRatio };
    }
    return { confirmed: null, reason: `Volume roughly flat (${volRatio.toFixed(2)}x of impulse) — inconclusive`, volRatio };
}

// ─────────────────────────────────────────────────────────────────────────
// LAW 3 — Reaction-Zone Entry Gate (the key actionable rule)
// ─────────────────────────────────────────────────────────────────────────
// Classifies the CURRENT price relative to (a) VWAP and (b) the latest
// Fibonacci retracement zone, and decides whether this is "entry on the
// reaction" (good — what the video recommends) or "entry on the action"
// (chasing a move that already happened — what the video warns against).
//
// Params:
//   price            current spot price
//   vwap             today's session VWAP (already computed in indicators.js)
//   candles          recent session candles (1m or higher TF), used to find
//                    the latest swing/impulse for Fibonacci levels
//   signalDirection  'BUY CALL' | 'BUY PUT' | null — the direction the rest
//                    of the system is currently leaning, so we know whether
//                    a pullback toward VWAP/Fibo is "with the trend" or not
//
// Returns: { zone, score (0-15), reason, vwapDistPct, fiboInfo }
//   zone: 'ON_REACTION' | 'ON_ACTION' | 'TREND_CHANGE_RISK' | 'NEUTRAL'
function getReactionZoneGate(price, vwap, candles, signalDirection) {
    if (price == null) {
        return { zone: 'NEUTRAL', score: 0, reason: 'No price data', vwapDistPct: null, fiboInfo: null };
    }

    // BUG FIX (warm-up): right after the 9:15 session reset, VWAP starts out
    // equal (or very close) to the first tick's price purely by construction
    // — NOT because of a real pullback. Without this guard, the very first
    // few minutes of every session would falsely score a "perfect reaction"
    // (price == vwap by coincidence) and inflate Entry Quality Score on data
    // too thin to trust. Mirrors the existing ADX 60-candle warm-up gate.
    const MIN_WARMUP_CANDLES = 15;
    const candleCount = candles ? candles.length : 0;
    if (candleCount < MIN_WARMUP_CANDLES) {
        return {
            zone: 'NEUTRAL', score: 8,
            reason: `⏳ Physics gate warming up — need ${MIN_WARMUP_CANDLES - candleCount} more session candles before VWAP/Fibonacci zones are trustworthy`,
            vwapDistPct: null, fiboInfo: null,
        };
    }

    const vwapDistPct = (vwap != null && vwap > 0) ? ((price - vwap) / vwap) * 100 : null;
    const impulse = candles ? getLatestImpulseFibo(candles) : null;

    // ── VWAP reaction check ──────────────────────────────────────────────
    // "Near VWAP" = within ±0.15% of spot (tight zone — Nifty ~24-25k means
    // ~0.15% ≈ 35-40 points, a realistic pullback-to-VWAP distance intraday).
    const nearVWAP = vwapDistPct !== null && Math.abs(vwapDistPct) <= 0.15;

    // ── Fibonacci reaction check ─────────────────────────────────────────
    let inFiboReactionZone = false;
    let beyondFiboReversal = false;
    let fiboReason = null;

    if (impulse) {
        const { direction, fib } = impulse;
        // Reaction zone = between 38.2% and 61.8% retracement of the move
        const lo = Math.min(fib.level382, fib.level618);
        const hi = Math.max(fib.level382, fib.level618);
        inFiboReactionZone = price >= lo && price <= hi;

        // Beyond 78.6% retracement → treat as trend-change risk, not a clean reaction
        const beyondLo = Math.min(fib.level786, fib.level100);
        const beyondHi = Math.max(fib.level786, fib.level100);
        beyondFiboReversal = price >= beyondLo && price <= beyondHi;

        fiboReason = `Impulse ${direction} (${impulse.swingLow.toFixed(0)}→${impulse.swingHigh.toFixed(0)}), price at ${(((price - fib.level0) / (fib.level100 - fib.level0)) * 100).toFixed(0)}% retrace`;
    }

    // ── Combine into a single classification ─────────────────────────────
    // signalDirection tells us which way the system wants to trade. A
    // reaction is only useful if it's a pullback WITHIN the existing trend,
    // not an entry chasing a candle that already ran far from VWAP/Fibo.
    if (beyondFiboReversal) {
        return {
            zone: 'TREND_CHANGE_RISK', score: 3,
            reason: `⚠️ Price beyond 78.6% retracement — ${fiboReason || 'possible trend change, not a clean reaction'}`,
            vwapDistPct, fiboInfo: impulse,
        };
    }

    if (nearVWAP || inFiboReactionZone) {
        const parts = [];
        if (nearVWAP)          parts.push(`price within ${Math.abs(vwapDistPct).toFixed(2)}% of VWAP`);
        if (inFiboReactionZone) parts.push('within 38.2%–61.8% Fibonacci reaction zone');

        const volCheck = getVolumeConfirmation(candles);
        let score = 15;
        let volNote = '';
        if (volCheck.confirmed === true) {
            score = 15; // full marks — textbook reaction
            volNote = ` | ${volCheck.reason}`;
        } else if (volCheck.confirmed === false) {
            score = 8;  // still a reaction zone, but volume disagrees — dock points, don't kill it
            volNote = ` | ${volCheck.reason}`;
        } else if (volCheck.reason) {
            volNote = ` | ${volCheck.reason}`;
        }

        return {
            zone: 'ON_REACTION', score,
            reason: `✅ Entry on reaction, not action — ${parts.join(' & ')}${volNote}`,
            vwapDistPct, fiboInfo: impulse, volumeConfirmation: volCheck,
        };
    }

    // Far from VWAP and outside the Fibo reaction band = likely chasing the action
    if (vwapDistPct !== null && Math.abs(vwapDistPct) > 0.35) {
        return {
            zone: 'ON_ACTION', score: 0,
            reason: `⛔ Price ${Math.abs(vwapDistPct).toFixed(2)}% away from VWAP — looks like chasing the action, wait for reaction`,
            vwapDistPct, fiboInfo: impulse,
        };
    }

    return {
        zone: 'NEUTRAL', score: 8,
        reason: 'Neither clearly on reaction nor clearly chasing — neutral',
        vwapDistPct, fiboInfo: impulse,
    };
}

// ─────────────────────────────────────────────────────────────────────────
// BOS / CHOCH — Smart Money Concepts structure break detection
// ─────────────────────────────────────────────────────────────────────────
// Reuses the SAME swing points findSwingPoints()/getSwingTrend() already
// compute above — no new candle logic, just a different, more specific
// read of the same structure:
//
//   BOS   (Break of Structure)  = price closes beyond the last swing point
//                                 IN THE DIRECTION of the established trend
//                                 → trend continuation confirmed
//   CHOCH (Change of Character) = price closes beyond the last swing point
//                                 AGAINST the established trend → the
//                                 FIRST specific warning sign of a possible
//                                 reversal, at a precise price level
//
// Why this is more than what getSwingTrend() alone already gives: the
// existing UPTREND/DOWNTREND/SIDEWAYS classification is a smoothed,
// majority-vote read across the whole lookback window — useful as a
// standing regime check, but it only updates once enough swing pairs
// accumulate. CHOCH fires the INSTANT price actually violates the most
// recent swing level, which is a sharper, earlier, and more falsifiable
// signal — exactly the kind of concrete level-break event that would flag
// a counter-trend pullback attempting to reverse the trend, rather than
// just "the last few swings looked mixed".
function detectBOSCHOCH(candles, lookback = 30) {
    if (!candles || candles.length < 10) {
        return { event: 'NONE', label: 'BOS/CHOCH — not enough candles' };
    }

    const { trend } = getSwingTrend(candles, lookback);
    const { swingHighs, swingLows } = findSwingPoints(candles, lookback);
    if (swingHighs.length === 0 || swingLows.length === 0) {
        return { event: 'NONE', label: 'BOS/CHOCH — no swing points yet', trend };
    }

    const lastHigh  = swingHighs[swingHighs.length - 1];
    const lastLow   = swingLows[swingLows.length - 1];
    const lastClose = candles[candles.length - 1].close;

    let event = 'NONE', label = 'BOS/CHOCH — no structure break yet', level = null;

    if (trend === 'UPTREND') {
        if (lastClose > lastHigh.price) {
            event = 'BOS_BULLISH'; level = lastHigh.price;
            label = `🟢 BOS (Bullish) — closed above swing high ${lastHigh.price}, uptrend continuation`;
        } else if (lastClose < lastLow.price) {
            event = 'CHOCH_BEARISH'; level = lastLow.price;
            label = `⚠️ CHOCH (Bearish) — closed below swing low ${lastLow.price}, uptrend structure broken — possible reversal`;
        }
    } else if (trend === 'DOWNTREND') {
        if (lastClose < lastLow.price) {
            event = 'BOS_BEARISH'; level = lastLow.price;
            label = `🔴 BOS (Bearish) — closed below swing low ${lastLow.price}, downtrend continuation`;
        } else if (lastClose > lastHigh.price) {
            event = 'CHOCH_BULLISH'; level = lastHigh.price;
            label = `⚠️ CHOCH (Bullish) — closed above swing high ${lastHigh.price}, downtrend structure broken — possible reversal`;
        }
    }
    // SIDEWAYS/UNKNOWN trend: no established direction to break FOR or
    // AGAINST, so no BOS/CHOCH is meaningful — leave as NONE.

    return {
        event, label, level, trend,
        lastHigh: lastHigh.price, lastLow: lastLow.price,
        generatedAt: new Date().toISOString(),
    };
}

module.exports = {
    getSwingTrend,
    detectBOSCHOCH,
    calcForceLabel,
    calcFibonacciLevels,
    getLatestImpulseFibo,
    getVolumeConfirmation,
    getReactionZoneGate,
};
