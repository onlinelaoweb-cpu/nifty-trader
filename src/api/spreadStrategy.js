// ── Spread / Hedging Strategy Engine ─────────────────────────────────────────
// Suggests option spread strategies based on market conditions.
// Called when ADX < threshold (sideways) or when directional trade has hedge value.
//
// Strategies covered:
//   IRON_CONDOR      — ADX < 20, sideways, sell both wings, collect theta
//   BULL_CALL_SPREAD — Bullish bias but VIX low, reduce cost via short call
//   BEAR_PUT_SPREAD  — Bearish bias but VIX low, reduce cost via short put
//   SHORT_STRANGLE   — Very low VIX + very sideways, sell OTM CE + PE
//
// Returns null if no spread is appropriate.

const { daysToNextExpiry } = (() => {
    // Inline DTE calculation (mirrors server.js logic, no circular require)
    function daysToNextExpiry() {
        const now = new Date();
        const ist = new Date(now.getTime() + 5.5 * 3600000);
        const day = ist.getDay(); // 0=Sun,1=Mon,...,6=Sat
        // FIX (30 Jul 2026): weekly NSE index expiry moved from Thursday to
        // Tuesday, effective 1 Sept 2025 (SEBI circular) — same bug class as
        // the getCurrentFyersFutSymbol() fix in nseData.js. This was still
        // targeting the old Thursday, which would silently corrupt every DTE
        // value fed into the Black-Scholes estimate and the near-expiry
        // theta-decay flag below (nearExpiry = dte<=2).
        // Next Tuesday (NSE weekly expiry)
        let daysAhead = (2 - day + 7) % 7 || 7;
        const expiry = new Date(ist);
        expiry.setDate(ist.getDate() + daysAhead);
        expiry.setHours(15, 30, 0, 0);
        const msLeft = expiry - ist;
        return Math.max(0.04, msLeft / (1000 * 60 * 60 * 24));
    }
    return { daysToNextExpiry };
})();

// Black-Scholes call/put estimate (standalone — no server dependency)
function bsEst(S, K, T, sigma, type) {
    const r = 0.0625;
    if (T <= 0) return Math.max(0, type === 'CE' ? S - K : K - S);
    function erf(x) {
        const t = 1 / (1 + 0.3275911 * Math.abs(x));
        const y = 1 - (((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);
        return x >= 0 ? y : -y;
    }
    function N(x) { return (1 + erf(x / Math.sqrt(2))) / 2; }
    const d1 = (Math.log(S/K) + (r + 0.5*sigma*sigma)*T) / (sigma*Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    if (type === 'CE') return parseFloat((S*N(d1) - K*Math.exp(-r*T)*N(d2)).toFixed(2));
    return parseFloat((K*Math.exp(-r*T)*N(-d2) - S*N(-d1)).toFixed(2));
}

function roundToStrike(price, width = 50) {
    return Math.round(price / width) * width;
}

// ── Main function ─────────────────────────────────────────────────────────────
// marketState fields used: nifty, vix, adx, mtf.signal, pcr, pcrZone, swingTrend
function suggestSpreadStrategy(marketState) {
    const { nifty, vix, adx } = marketState;
    if (!nifty || nifty <= 0 || !vix || !adx) return null;

    const atm      = roundToStrike(nifty);
    const dte      = daysToNextExpiry();
    const T        = dte / 365;
    const sigma    = vix / 100;
    const mtfSig   = marketState.mtf?.signal   ?? 'WAIT';
    const swing    = marketState.swingTrend?.trend ?? 'UNKNOWN';
    const pcrZone  = marketState.pcrZone?.zone ?? 'AVOID';

    // ── Condition checks ──────────────────────────────────────────────────────
    const isSideways     = adx < 20 || swing === 'SIDEWAYS';
    const isBullish      = mtfSig === 'BUY CALL' && swing === 'UPTREND';
    const isBearish      = mtfSig === 'BUY PUT'  && swing === 'DOWNTREND';
    const vixLow         = vix < 14;
    const vixVeryLow     = vix < 12;
    const nearExpiry     = dte <= 2;   // Monday/Tuesday — theta decay fast

    // ── Strategy selection ────────────────────────────────────────────────────

    // 1. IRON CONDOR — ADX < 20, sideways, collect theta from both sides
    //    Best when: sideways + low VIX + near expiry
    if (isSideways && vixLow) {
        const wingWidth = vixVeryLow ? 100 : 150;  // tighter wings when calmer

        const shortCEStrike = atm + 100;             // sell slightly OTM CE
        const longCEStrike  = atm + 100 + wingWidth; // buy further OTM CE (protection)
        const shortPEStrike = atm - 100;             // sell slightly OTM PE
        const longPEStrike  = atm - 100 - wingWidth; // buy further OTM PE (protection)

        const shortCEPrem = bsEst(nifty, shortCEStrike, T, sigma, 'CE');
        const longCEPrem  = bsEst(nifty, longCEStrike,  T, sigma, 'CE');
        const shortPEPrem = bsEst(nifty, shortPEStrike, T, sigma, 'PE');
        const longPEPrem  = bsEst(nifty, longPEStrike,  T, sigma, 'PE');

        const netCredit    = parseFloat(((shortCEPrem - longCEPrem) + (shortPEPrem - longPEPrem)).toFixed(2));
        const maxLoss      = parseFloat((wingWidth - netCredit).toFixed(2));
        const breakEvenUp  = shortCEStrike + netCredit;
        const breakEvenDn  = shortPEStrike - netCredit;

        if (netCredit > 0) {
            return {
                strategy    : 'IRON_CONDOR',
                label       : '🦅 Iron Condor — Sideways Theta Play',
                reason      : `ADX ${adx.toFixed(1)} (sideways) + VIX ${vix} (low) → sell premium, collect theta`,
                legs        : [
                    { action: 'SELL', strike: shortCEStrike, type: 'CE', premium: shortCEPrem },
                    { action: 'BUY',  strike: longCEStrike,  type: 'CE', premium: longCEPrem  },
                    { action: 'SELL', strike: shortPEStrike, type: 'PE', premium: shortPEPrem },
                    { action: 'BUY',  strike: longPEStrike,  type: 'PE', premium: longPEPrem  },
                ],
                netCredit,
                maxProfit   : netCredit,
                maxLoss,
                breakEvenUp,
                breakEvenDn,
                profitZone  : `${shortPEStrike}–${shortCEStrike}`,
                dte         : parseFloat(dte.toFixed(1)),
                note        : nearExpiry
                    ? '⚡ Near expiry — theta decay fast, exit by 15:00'
                    : '📅 Hold till expiry if Nifty stays in profit zone',
            };
        }
    }

    // 2. BULL CALL SPREAD — Bullish but VIX low, reduce premium cost
    //    Sell higher CE to offset cost of buying ATM CE
    if (isBullish && vixLow) {
        const buyStrike  = atm;           // buy ATM CE
        const sellStrike = atm + 150;     // sell OTM CE 150 points above

        const buyPrem    = bsEst(nifty, buyStrike,  T, sigma, 'CE');
        const sellPrem   = bsEst(nifty, sellStrike, T, sigma, 'CE');
        const netDebit   = parseFloat((buyPrem - sellPrem).toFixed(2));
        const maxProfit  = parseFloat((150 - netDebit).toFixed(2));
        const breakEven  = atm + netDebit;

        if (netDebit > 0 && maxProfit > 0) {
            return {
                strategy   : 'BULL_CALL_SPREAD',
                label      : '📈 Bull Call Spread — Bullish with Cost Hedge',
                reason     : `Bullish signal + VIX ${vix} low → buying naked CE is expensive relative to move. Sell ${sellStrike} CE to cut cost by ₹${sellPrem}`,
                legs       : [
                    { action: 'BUY',  strike: buyStrike,  type: 'CE', premium: buyPrem  },
                    { action: 'SELL', strike: sellStrike, type: 'CE', premium: sellPrem },
                ],
                netDebit,
                maxProfit,
                maxLoss    : netDebit,
                breakEven,
                profitZone : `Above ${breakEven.toFixed(0)}`,
                dte        : parseFloat(dte.toFixed(1)),
                note       : `Max profit if Nifty reaches ${sellStrike}+ by expiry. Risk limited to ₹${netDebit} vs naked CE ₹${buyPrem}`,
            };
        }
    }

    // 3. BEAR PUT SPREAD — Bearish but VIX low, reduce cost
    if (isBearish && vixLow) {
        const buyStrike  = atm;           // buy ATM PE
        const sellStrike = atm - 150;     // sell OTM PE 150 points below

        const buyPrem    = bsEst(nifty, buyStrike,  T, sigma, 'PE');
        const sellPrem   = bsEst(nifty, sellStrike, T, sigma, 'PE');
        const netDebit   = parseFloat((buyPrem - sellPrem).toFixed(2));
        const maxProfit  = parseFloat((150 - netDebit).toFixed(2));
        const breakEven  = atm - netDebit;

        if (netDebit > 0 && maxProfit > 0) {
            return {
                strategy   : 'BEAR_PUT_SPREAD',
                label      : '📉 Bear Put Spread — Bearish with Cost Hedge',
                reason     : `Bearish signal + VIX ${vix} low → sell ${sellStrike} PE to cut cost by ₹${sellPrem}`,
                legs       : [
                    { action: 'BUY',  strike: buyStrike,  type: 'PE', premium: buyPrem  },
                    { action: 'SELL', strike: sellStrike, type: 'PE', premium: sellPrem },
                ],
                netDebit,
                maxProfit,
                maxLoss    : netDebit,
                breakEven,
                profitZone : `Below ${breakEven.toFixed(0)}`,
                dte        : parseFloat(dte.toFixed(1)),
                note       : `Max profit if Nifty drops to ${sellStrike} by expiry`,
            };
        }
    }

    // 4. SHORT STRANGLE — Very low VIX + strong sideways (ADX < 15)
    //    More aggressive than Iron Condor — no protection wings, higher credit
    //    Only suggest when ADX very low AND near expiry (theta fast)
    if (adx < 15 && vixVeryLow && nearExpiry) {
        const sellCEStrike = atm + 150;
        const sellPEStrike = atm - 150;

        const cePrem = bsEst(nifty, sellCEStrike, T, sigma, 'CE');
        const pePrem = bsEst(nifty, sellPEStrike, T, sigma, 'PE');
        const credit = parseFloat((cePrem + pePrem).toFixed(2));

        return {
            strategy   : 'SHORT_STRANGLE',
            label      : '⚡ Short Strangle — Very Low VIX Theta Capture',
            reason     : `ADX ${adx.toFixed(1)} (very choppy) + VIX ${vix} (very low) + near expiry → max theta capture`,
            legs       : [
                { action: 'SELL', strike: sellCEStrike, type: 'CE', premium: cePrem },
                { action: 'SELL', strike: sellPEStrike, type: 'PE', premium: pePrem },
            ],
            netCredit  : credit,
            maxProfit  : credit,
            maxLoss    : 'Unlimited — hedge with Iron Condor wings if unsure',
            breakEvenUp: sellCEStrike + credit,
            breakEvenDn: sellPEStrike - credit,
            profitZone : `${sellPEStrike}–${sellCEStrike}`,
            dte        : parseFloat(dte.toFixed(1)),
            note       : '⚠️ NAKED SELL — requires margin. Exit immediately if Nifty breaks profit zone',
        };
    }

    return null;  // No spread appropriate right now
}

module.exports = { suggestSpreadStrategy };