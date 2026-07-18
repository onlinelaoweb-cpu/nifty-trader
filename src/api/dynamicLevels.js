'use strict';
// dynamicLevels.js — Punch-style ATR-based intraday H1-H3 / L1-L3 levels
//
// Genesis: user runs a broker app (Punch) side-by-side with VardaanNifty AI.
// Punch's Scalper screen shows dynamic H1/H2/H3 (upside) and L1/L2/L3
// (downside) reference levels that update through the day. Punch doesn't
// publish its formula — this is our OWN best-effort approximation using a
// well-known public technique (ATR bands off the day's range), NOT a copy
// of any proprietary Punch calculation:
//
//   H1 = Day High + 0.5 × ATR(14)      L1 = Day Low − 0.5 × ATR(14)
//   H2 = Day High + 1.0 × ATR(14)      L2 = Day Low − 1.0 × ATR(14)
//   H3 = Day High + 1.5 × ATR(14)      L3 = Day Low − 1.5 × ATR(14)
//
// Rollout stance (per this app's own hard-won lesson — see renko.js,
// physicsOfTrading.js headers): new confirmation layers start as
// INFORMATIONAL + a light, capped confidence adjustment. They only earn a
// hard blocking-gate role after a few weeks of live signals show they
// actually add edge — the app has had multiple "zero trades" incidents
// from stacking too many hard conditions on day one. See server.js
// combineSignals() for exactly how light that touch is (a ±5-10%
// confidence nudge, not a WAIT override).

const { calcATR } = require('./renko');

// ── Compute the six ATR bands off today's day-high/day-low ───────────────────
// candles : multi-day candle buffer (same source Renko uses — getCandleHistory(true))
// dayHigh / dayLow : today's session high/low so far (marketState.wsHigh/wsLow)
function computeDynamicLevels(candles, dayHigh, dayLow) {
    if (!dayHigh || !dayLow || dayHigh <= 0 || dayLow <= 0 || dayHigh < dayLow) {
        return { available: false, label: 'Dynamic Levels — awaiting day high/low' };
    }

    const atr = calcATR(candles, 14);
    if (!atr || atr <= 0) {
        return { available: false, label: 'Dynamic Levels — awaiting ATR (need 15+ candles)' };
    }

    const r = n => parseFloat(n.toFixed(1));
    const h1 = r(dayHigh + 0.5 * atr);
    const h2 = r(dayHigh + 1.0 * atr);
    const h3 = r(dayHigh + 1.5 * atr);
    const l1 = r(dayLow  - 0.5 * atr);
    const l2 = r(dayLow  - 1.0 * atr);
    const l3 = r(dayLow  - 1.5 * atr);

    return {
        available: true,
        atr: r(atr),
        dayHigh: r(dayHigh), dayLow: r(dayLow),
        h1, h2, h3, l1, l2, l3,
        updatedAt: new Date().toISOString(),
    };
}

// ── Classify current price against the H/L ladder ───────────────────────────
// Returns a zone + booleans combineSignals()/confidenceBreakdown can use as
// an ADDITIVE confluence factor. Also used as-is for the Insights tab card.
function classifyDynamicLevels(levels, price) {
    if (!levels?.available || !price) {
        return {
            zone: 'UNKNOWN', label: 'Dynamic Levels — awaiting data',
            aboveH1: false, aboveH3: false, belowL1: false, belowL3: false,
            noTradeZone: false,
        };
    }
    const { h1, h3, l1, l3 } = levels;
    const aboveH3 = price > h3;
    const aboveH1 = price > h1;
    const belowL3 = price < l3;
    const belowL1 = price < l1;
    // Punch-style "range pocket" — price sitting between L1 and H1 (i.e. it
    // hasn't even cleared the FIRST band on either side). False-breakout
    // risk is higher here; treated as a soft confidence cap, not a block.
    const noTradeZone = !aboveH1 && !belowL1;

    let zone, label;
    if (aboveH3)      { zone = 'ABOVE_H3'; label = `🟢 Above Dynamic H3 (${h3}) — strong bullish structure, watch for profit-booking`; }
    else if (aboveH1) { zone = 'H1_H3';    label = `↗️ Between H1 (${h1}) and H3 (${h3}) — bullish zone, ${(h3 - price).toFixed(0)}pt to H3`; }
    else if (belowL3) { zone = 'BELOW_L3'; label = `🔴 Below Dynamic L3 (${l3}) — strong bearish structure, watch for bounce`; }
    else if (belowL1) { zone = 'L1_L3';    label = `↘️ Between L1 (${l1}) and L3 (${l3}) — bearish zone, ${(price - l3).toFixed(0)}pt to L3`; }
    else              { zone = 'INSIDE';   label = `↔️ Inside H1 (${h1})–L1 (${l1}) — range pocket, false-breakout risk higher`; }

    return { zone, label, aboveH1, aboveH3, belowL1, belowL3, noTradeZone };
}

module.exports = { computeDynamicLevels, classifyDynamicLevels };