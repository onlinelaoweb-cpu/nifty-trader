'use strict';
// greeksAttribution.js — "where did this trade's P&L actually come from?"
// (3 Oct 2026, from the options-Greeks webinar review — item 3)
//
// For one closed option trade, splits the premium change (₹ per share) into:
//   direction (delta, gamma-aware via the average of entry/exit delta)
//   time      (theta)
//   volatility(vega × change in India VIX, VIX being the app's IV proxy)
//   other     (residual: skew vs VIX, bid-ask, model error, target/SL slippage)
// so after a few weeks the data can answer: are the losers wrong direction,
// time decay, or IV crush? Pure function — no I/O, no marketState access.
//
// Approximations (deliberate, documented):
//  - Greeks are Black-Scholes using VIX as IV (same as the rest of the app).
//  - Theta: calendar-day theta spread over the 375-minute NSE session, capped at
//    one session — i.e. we assume a day's decay happens while the market is open.
//  - 'other' is NOT an error flag; small is good, large means the model missed.

const { calcGreeks } = require('../api/optionGreeks');

const SESSION_MIN = 375;

function r2(x) { return Math.round(x * 100) / 100; }

// rec     : the open-perf record — needs type, strike, entry, entryNiftyForTheta, entryVixForTheta, entryDTE
// exit    : { premium, spot, vix, dte, elapsedMin }
function computeGreeksAttribution(rec, exit) {
    try {
        if (!rec || !exit) return null;
        const spot0 = rec.entryNiftyForTheta, vix0 = rec.entryVixForTheta, dte0 = rec.entryDTE;
        const { premium, spot: spot1, vix: vix1, dte: dte1, elapsedMin } = exit;
        if (![spot0, vix0, dte0, premium, spot1, vix1, dte1, rec.entry, rec.strike].every(v => typeof v === 'number' && isFinite(v))) return null;
        if (!(spot0 > 0 && spot1 > 0 && vix0 > 0 && vix1 > 0 && rec.entry > 0)) return null;

        const g0 = calcGreeks(spot0, rec.strike, Math.max(dte0, 0.04) / 365, vix0 / 100, rec.type);
        const g1 = calcGreeks(spot1, rec.strike, Math.max(dte1, 0.04) / 365, vix1 / 100, rec.type);
        if (!g0 || !g1) return null;

        const avgDelta = (g0.delta + g1.delta) / 2;          // signed: CE +, PE −
        const avgVega  = (g0.vega  + g1.vega)  / 2;          // ₹ per 1 VIX point
        const avgTheta = (g0.theta + g1.theta) / 2;          // ₹ per calendar day (negative)

        const deltaPnl = avgDelta * (spot1 - spot0);
        const vegaPnl  = avgVega * (vix1 - vix0);
        const sessionFrac = Math.min(Math.max(elapsedMin || 0, 0), SESSION_MIN) / SESSION_MIN;
        const thetaPnl = avgTheta * sessionFrac;

        const actual = premium - rec.entry;
        const other  = actual - (deltaPnl + vegaPnl + thetaPnl);

        const parts = [
            { k: 'Direction', v: deltaPnl },
            { k: 'Time decay', v: thetaPnl },
            { k: 'IV change', v: vegaPnl },
        ];
        // main drag = the most negative of the three (only meaningful if it's actually negative)
        const worst = parts.slice().sort((a, b) => a.v - b.v)[0];
        const best  = parts.slice().sort((a, b) => b.v - a.v)[0];

        return {
            delta: r2(deltaPnl), theta: r2(thetaPnl), vega: r2(vegaPnl), other: r2(other),
            actual: r2(actual), exitSpot: r2(spot1), exitVix: r2(vix1),
            // only name a "drag" on a trade that actually lost money — on a winner it's noise
            mainDrag: (actual < 0 && worst.v < -0.5) ? worst.k : null,
            mainDriver: best.v > 0.5 ? best.k : null,
        };
    } catch (e) { return null; }
}

function fmtRs(v) { return `${v >= 0 ? '+' : '−'}₹${Math.abs(v).toFixed(1)}`; }

// One-line Telegram summary, per share.
function attributionLine(a) {
    if (!a) return '';
    return `🔬 P&L split (per share): Direction ${fmtRs(a.delta)} · Time ${fmtRs(a.theta)} · IV ${fmtRs(a.vega)} · Other ${fmtRs(a.other)}`
        + (a.mainDrag ? `\n   Biggest drag: ${a.mainDrag}` : '');
}

module.exports = { computeGreeksAttribution, attributionLine };