'use strict';
// optionGreeks.js — Real Black-Scholes Greeks (Delta/Gamma/Theta/Vega) + Gamma
// Exposure (GEX), Max Gamma Strike, Gamma Flip Level.
//
// ChatGPT audit ("Option Greeks Dashboard"): "Display Delta, Gamma, Theta,
// Vega, Gamma Exposure (GEX), Max Gamma Strike, Gamma Flip Level — these
// explain why options move even when Nifty doesn't."
//
// No new API or data source needed. Reuses:
//   - the SAME Black-Scholes machinery server.js already has in bsEstimate()
//     (d1/d2, the same normal-CDF polynomial approximation, same RBI repo
//     rate assumption — kept in sync, see R below)
//   - the option-chain `records` array already fetched for PCR/OI-Buildup
//     (server.js refreshPCR() → pcrState.records)
// Implied volatility uses India VIX (marketState.vix / 100) as a single
// portfolio-wide IV rather than back-solving per-strike IV from premiums —
// VIX is already Nifty's own 30-day IV benchmark used elsewhere in this app,
// and this avoids Newton-Raphson convergence failure modes for a dashboard
// feature that just needs to be directionally right, not exchange-precise.

const R = 0.0625;   // RBI repo rate — MUST stay in sync with bsEstimate() in server.js

function normCDF(x) {
    const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429], p = 0.3275911;
    const s = x < 0 ? -1 : 1; x = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a[4] * t + a[3]) * t) + a[2]) * t + a[1]) * t + a[0]) * t * Math.exp(-x * x);
    return 0.5 * (1 + s * y);
}
function normPDF(x) {
    return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
}

// Returns { delta, gamma, theta, vega } for one option leg, or null if inputs
// are unusable (expired/zero vol/etc.)
// S = spot, K = strike, T = years-to-expiry, sigma = annualized IV (0.14 = 14%)
function calcGreeks(S, K, T, sigma, type) {
    if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return null;
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (R + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;

    const delta = type === 'CE' ? normCDF(d1) : normCDF(d1) - 1;
    const gamma = normPDF(d1) / (S * sigma * sqrtT);
    const vega  = (S * normPDF(d1) * sqrtT) / 100;   // ₹ change per 1 percentage-point IV move
    const theta = type === 'CE'
        ? (-(S * normPDF(d1) * sigma) / (2 * sqrtT) - R * K * Math.exp(-R * T) * normCDF(d2)) / 365
        : (-(S * normPDF(d1) * sigma) / (2 * sqrtT) + R * K * Math.exp(-R * T) * normCDF(-d2)) / 365;

    return {
        delta: parseFloat(delta.toFixed(4)),
        gamma: parseFloat(gamma.toFixed(6)),
        theta: parseFloat(theta.toFixed(2)),   // ₹ decay per calendar day, per share
        vega:  parseFloat(vega.toFixed(2)),    // ₹ change per 1pt IV move, per share
    };
}

// Full-chain dashboard: ATM Greeks + Gamma Exposure map + Max Gamma Strike +
// Gamma Flip Level.
// records  : same NSE/Fyers option-chain array PCR/OI-Buildup already use
//            (each row: { strikePrice, CE:{openInterest}, PE:{openInterest} })
// spot     : current Nifty price
// vixPct   : India VIX (e.g. 13.5, NOT 0.135) — used as IV proxy
// daysToExpiry : fractional days (same value server.js's daysToNextExpiry() gives)
// lotSize  : Nifty lot size (server.js LOT_SIZE const)
function computeOptionGreeksDashboard(records, spot, vixPct, daysToExpiry, lotSize) {
    if (!Array.isArray(records) || records.length === 0 || !spot || !vixPct || daysToExpiry == null) {
        return { available: false, label: 'Option Greeks — awaiting data' };
    }

    const sigma = vixPct / 100;
    const T = Math.max(daysToExpiry, 0.04) / 365;

    const atmStrike = Math.round(spot / 50) * 50;
    const atmCE = calcGreeks(spot, atmStrike, T, sigma, 'CE');
    const atmPE = calcGreeks(spot, atmStrike, T, sigma, 'PE');
    if (!atmCE || !atmPE) return { available: false, label: 'Option Greeks — calc error (bad spot/vix/expiry input)' };

    let totalGEX = 0;
    let maxGammaStrike = null, maxGammaVal = -Infinity;
    const strikeGEX = [];

    for (const row of records) {
        const K = row.strikePrice;
        if (!K) continue;
        const ceOI = row.CE?.openInterest || 0;
        const peOI = row.PE?.openInterest || 0;
        if (ceOI === 0 && peOI === 0) continue;

        const ceG = calcGreeks(spot, K, T, sigma, 'CE');
        const peG = calcGreeks(spot, K, T, sigma, 'PE');
        if (!ceG || !peG) continue;

        // Standard retail GEX convention (SpotGamma-style public trackers):
        // dealers are assumed net SHORT the calls / LONG the puts they sold to
        // option BUYERS (this app's own audience) — so call OI contributes
        // positive dealer gamma, put OI negative. Treat magnitude as the
        // meaningful number; sign as directional context only, not a precise
        // dealer-positioning fact (real dealer books aren't public).
        const strikeGexVal = (ceOI * ceG.gamma - peOI * peG.gamma) * lotSize * spot * spot * 0.01;
        totalGEX += strikeGexVal;
        strikeGEX.push({ strike: K, gex: strikeGexVal });

        const strikeGammaMagnitude = (ceOI * ceG.gamma + peOI * peG.gamma) * lotSize;
        if (strikeGammaMagnitude > maxGammaVal) { maxGammaVal = strikeGammaMagnitude; maxGammaStrike = K; }
    }

    // Gamma Flip Level — the strike where cumulative GEX (scanned low→high
    // strike) crosses zero. Below it dealers are typically net-short gamma
    // (tends to amplify moves); above it, net-long gamma (tends to dampen
    // moves into a range). Same "flip level" concept popular GEX trackers use.
    strikeGEX.sort((a, b) => a.strike - b.strike);
    let cumulative = 0, gammaFlipLevel = null, prevCum = 0;
    for (const row of strikeGEX) {
        prevCum = cumulative;
        cumulative += row.gex;
        if (prevCum !== 0 && Math.sign(prevCum) !== Math.sign(cumulative)) {
            gammaFlipLevel = row.strike;
            break;
        }
    }

    const regime = totalGEX >= 0
        ? 'Positive GEX — dealers likely net-long gamma, moves tend to stay dampened/range-bound'
        : 'Negative GEX — dealers likely net-short gamma, moves tend to be amplified/trending';

    const gexCr = parseFloat((totalGEX / 1e7).toFixed(1));   // ₹ Crores, more readable for Indian retail users

    return {
        available: true,
        atmStrike, atmCE, atmPE,
        totalGEX: parseFloat(totalGEX.toFixed(0)), gexCr,
        maxGammaStrike, gammaFlipLevel, regime,
        label: `🔬 ATM Δ ${atmCE.delta}/${atmPE.delta} · Γ ${atmCE.gamma} · GEX ₹${gexCr}Cr · Max Gamma ${maxGammaStrike ?? '--'} · Flip ${gammaFlipLevel ?? '--'}`,
        generatedAt: new Date().toISOString(),
    };
}

module.exports = { calcGreeks, computeOptionGreeksDashboard };