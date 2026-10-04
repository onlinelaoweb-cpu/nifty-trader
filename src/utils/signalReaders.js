// ── Read-only marketState derived computations ────────────────────────────
// Extracted verbatim from server.js (13 Sep refactor, Phase 3). Every
// function here only READS marketState — none of them assign to it or
// mutate it (verified via grep for assignment/mutation operators before
// extraction). marketState is now an explicit first parameter instead of
// an implicit closure variable — since JS passes objects by reference,
// this is a pure relocation with zero behavior change: callers already
// hold the same marketState object and now just pass it in.
const { isExpiryDay } = require('../api/nseData');
const { getCandleHistory } = require('../api/indicators');
const { computeDynamicLevels, classifyDynamicLevels } = require('../api/dynamicLevels');
const { getIST, daysToNextExpiry } = require('./timeWindows');
const { bsEstimate } = require('./pureCalc');
const { calcGreeks } = require('../api/optionGreeks');

function computeSmartMoneyBias(marketState) {
    let score = 0;
    const components = [];

    const oi = marketState.oiBuildup;
    if (oi && oi.signal && oi.signal !== 'NEUTRAL') {
        const sig = oi.signal.toUpperCase();  // 'BULL' or 'BEAR'
        const str = oi.strength || 1;         // 1 or 2
        const pts = sig === 'BULL' ? str : -str;
        const shortLabel = oi.label
            ? oi.label.replace('OI Buildup — ', '').split(' — ')[0]  // trim prefix
            : (sig === 'BULL' ? 'Bullish OI 🐂' : 'Bearish OI 🐻');
        score += pts;
        components.push({ label: 'OI Buildup', value: shortLabel, pts, bull: sig === 'BULL' });
    } else {
        components.push({ label: 'OI Buildup', value: 'Awaiting data', pts: 0, bull: null });
    }

    const fii = marketState.fii;
    const dii = marketState.dii;
    const fiiNet = (fii && typeof fii.net === 'number') ? fii.net : null;
    const diiNet = (dii && typeof dii.net === 'number') ? dii.net : null;
    if (fiiNet !== null) {
        const w = Math.abs(fiiNet) > 500 ? 2 : 1;
        if (fiiNet > 0) {
            score += w;
            components.push({ label: 'FII Flow', value: `Net Buy ₹${fiiNet.toFixed(0)}Cr`, pts: +w, bull: true });
        } else if (fiiNet < 0) {
            score -= w;
            components.push({ label: 'FII Flow', value: `Net Sell ₹${Math.abs(fiiNet).toFixed(0)}Cr`, pts: -w, bull: false });
        } else {
            components.push({ label: 'FII Flow', value: 'Net Flat ₹0Cr', pts: 0, bull: null });
        }
    } else {
        components.push({ label: 'FII Flow', value: 'Awaiting data', pts: 0, bull: null });
    }
    if (diiNet !== null) {
        if (diiNet > 0) {
            score += 1;
            components.push({ label: 'DII Flow', value: `Net Buy ₹${diiNet.toFixed(0)}Cr`, pts: +1, bull: true });
        } else if (diiNet < 0) {
            score -= 1;
            components.push({ label: 'DII Flow', value: `Net Sell ₹${Math.abs(diiNet).toFixed(0)}Cr`, pts: -1, bull: false });
        } else {
            components.push({ label: 'DII Flow', value: 'Net Flat ₹0Cr', pts: 0, bull: null });
        }
    } else {
        components.push({ label: 'DII Flow', value: 'Awaiting data', pts: 0, bull: null });
    }

    const pcr = marketState.pcr;
    if (pcr !== null && pcr > 0) {
        if      (pcr > 1.3)             { score += 2; components.push({ label: 'PCR Level', value: `${pcr.toFixed(2)} — Put Writing 🐂`, pts: +2, bull: true }); }
        else if (pcr >= 1.1)            { score += 1; components.push({ label: 'PCR Level', value: `${pcr.toFixed(2)} — Mildly Bullish`, pts: +1, bull: true }); }
        else if (pcr >= 0.9)            {             components.push({ label: 'PCR Level', value: `${pcr.toFixed(2)} — Neutral zone`, pts: 0, bull: null }); }
        else if (pcr >= 0.7)            { score -= 1; components.push({ label: 'PCR Level', value: `${pcr.toFixed(2)} — Mildly Bearish`, pts: -1, bull: false }); }
        else                            { score -= 2; components.push({ label: 'PCR Level', value: `${pcr.toFixed(2)} — Call Writing 🐻`, pts: -2, bull: false }); }
    } else {
        components.push({ label: 'PCR Level', value: 'Awaiting data', pts: 0, bull: null });
    }

    const optFlow = marketState.optionFlow;
    if (optFlow && optFlow.atmCEpremium && optFlow.atmPEpremium && optFlow.atmCEpremium > 0 && optFlow.atmPEpremium > 0) {
        const ratio = optFlow.atmCEpremium / optFlow.atmPEpremium;
        if (ratio > 1.25) {
            score += 1;
            components.push({ label: 'ATM Flow', value: `CE/PE=${ratio.toFixed(2)} — Call buyers dominant`, pts: +1, bull: true });
        } else if (ratio < 0.80) {
            score -= 1;
            components.push({ label: 'ATM Flow', value: `CE/PE=${ratio.toFixed(2)} — Put buyers dominant`, pts: -1, bull: false });
        } else {
            components.push({ label: 'ATM Flow', value: `CE/PE=${ratio.toFixed(2)} — Balanced`, pts: 0, bull: null });
        }
    } else {
        components.push({ label: 'ATM Flow', value: 'Awaiting premium data', pts: 0, bull: null });
    }

    let bias, label;
    if      (score >= 4) { bias = 'STRONGLY_BULLISH'; label = '📈 Strongly Bullish — Institutions buying'; }
    else if (score >= 2) { bias = 'BULLISH';           label = '📈 Bullish — Smart money positioned long'; }
    else if (score <= -4){ bias = 'STRONGLY_BEARISH';  label = '📉 Strongly Bearish — Institutions selling'; }
    else if (score <= -2){ bias = 'BEARISH';           label = '📉 Bearish — Smart money positioned short'; }
    else                 { bias = 'NEUTRAL';            label = '⚖️ Neutral — No clear institutional bias'; }

    return { bias, score, label, components, updatedAt: new Date().toISOString() };
}

function computeDayType(marketState) {
    const adxVal = marketState.adx?.adx ?? null;
    let trendScore = 0;
    if (adxVal !== null) trendScore += Math.min((adxVal / 40) * 40, 40);   // up to 40 pts
    if (marketState.mtf?.aligned)          trendScore += 30;               // all 3 TF agree
    else if (marketState.mtf?.softAligned) trendScore += 15;               // 15m+1h agree, 5m dissents
    const orbStatus = marketState.orb?.status;
    if (orbStatus === 'BROKEN_UP' || orbStatus === 'BROKEN_DOWN') trendScore += 20;
    const mom = marketState.momentum;
    if (mom?.canTrade && mom.strength >= 3) trendScore += 10;

    const trendProbability = Math.round(Math.min(trendScore, 100));
    const rangeProbability = Math.round(100 - trendProbability);

    const recommendation = trendProbability >= 60
        ? { favor: 'OPTION_BUYING',    avoid: 'Selling / Iron Fly',                 label: '✅ Recommended: Option Buying' }
        : rangeProbability >= 60
        ? { favor: 'RANGE_STRATEGIES', avoid: 'Fresh directional option buying',    label: '✅ Recommended: Iron Fly / Option Selling / Quick Scalps' }
        : { favor: 'NEUTRAL',          avoid: 'Oversized directional bets either way', label: '⚠️ Mixed signals — trade small, confirm before entry' };

    return {
        trendProbability, rangeProbability, recommendation,
        adx: adxVal, mtfAligned: !!marketState.mtf?.aligned, orbStatus: orbStatus ?? 'FORMING',
        generatedAt: new Date().toISOString(),
    };
}

function computeConfidenceBreakdown(marketState) {
    const sig = marketState.signal;
    if (sig === 'WAIT' || !sig) return { items: [], final: 0, label: 'No active signal' };
    const isBull = sig === 'BUY CALL';
    const items = [];

    if (marketState.mtf?.aligned) items.push({ label: 'Trend (3/3 TF aligned)', pts: 25 });
    else if ((isBull && marketState.mtf?.bullCount === 2) || (!isBull && marketState.mtf?.bearCount === 2)) {
        items.push({ label: 'Trend (2/3 TF aligned)', pts: 12 });
    }

    const mom = marketState.momentum;
    if (mom?.canTrade && ((isBull && mom.signal === 'BREAKOUT') || (!isBull && mom.signal === 'BREAKDOWN'))) {
        items.push({ label: `Momentum (${mom.signal.toLowerCase()}, strength ${mom.strength})`, pts: Math.round((mom.strength / 4) * 20) });
    }

    const deltaPct = marketState.delta?.deltaPct;
    if (deltaPct != null && ((isBull && deltaPct > 0) || (!isBull && deltaPct < 0))) {
        items.push({ label: `Delta (${deltaPct > 0 ? '+' : ''}${deltaPct}%)`, pts: Math.min(Math.round((Math.abs(deltaPct) / 100) * 15), 15) });
    }

    if ((isBull && marketState.pcrSignal === 'BULLISH') || (!isBull && marketState.pcrSignal === 'BEARISH')) {
        items.push({ label: `PCR (${marketState.pcr})`, pts: 10 });
    }

    const srLvls = marketState.srLevels?.levels;
    if (srLvls?.length && marketState.nifty > 0) {
        const near = srLvls.find(l => Math.abs(marketState.nifty - l.price) <= 30);
        if (near) {
            const isRes = near.price > marketState.nifty;
            if ((isBull && isRes) || (!isBull && !isRes)) {
                items.push({ label: `Near ${isRes ? 'Resistance' : 'Support'} (${near.label || near.type} @ ${near.price})`, pts: -10 });
            }
        }
    }

    const rsi = marketState.rsi;
    if (isBull && rsi != null && rsi > 68) items.push({ label: `RSI Overbought (${rsi})`, pts: -5 });
    if (!isBull && rsi != null && rsi < 32) items.push({ label: `RSI Oversold (${rsi})`, pts: -5 });

    const dl = marketState.dynamicLevels;
    if (dl?.available) {
        if (isBull && dl.aboveH3) items.push({ label: `Above Dynamic H3 (${dl.h3})`, pts: 5 });
        else if (!isBull && dl.belowL3) items.push({ label: `Below Dynamic L3 (${dl.l3})`, pts: 5 });
        else if (dl.noTradeZone) items.push({ label: `Inside Dynamic H1–L1 range pocket`, pts: -10 });
    }

    const pg = marketState.premarketGap;
    if (pg?.available) {
        if (isBull && pg.zone === 'GAP_UP') items.push({ label: `Gap-up open (+${pg.gapPct}%)`, pts: 3 });
        else if (!isBull && pg.zone === 'GAP_DOWN') items.push({ label: `Gap-down open (${pg.gapPct}%)`, pts: 3 });
    }

    const sm = marketState.smartMoney;
    if (sm) {
        const bullish = sm.bias === 'BULLISH' || sm.bias === 'STRONGLY_BULLISH';
        const bearish = sm.bias === 'BEARISH' || sm.bias === 'STRONGLY_BEARISH';
        const strong  = sm.bias === 'STRONGLY_BULLISH' || sm.bias === 'STRONGLY_BEARISH';
        if (isBull && bullish) items.push({ label: `Smart Money ${sm.bias.replace('_',' ')} (${sm.score})`, pts: strong ? 8 : 4 });
        else if (!isBull && bearish) items.push({ label: `Smart Money ${sm.bias.replace('_',' ')} (${sm.score})`, pts: strong ? 8 : 4 });
        else if (isBull && bearish) items.push({ label: `Smart Money ${sm.bias.replace('_',' ')} contradicts (${sm.score})`, pts: strong ? -15 : -8 });
        else if (!isBull && bullish) items.push({ label: `Smart Money ${sm.bias.replace('_',' ')} contradicts (${sm.score})`, pts: strong ? -15 : -8 });
    }

    const bc = marketState.physicsOfTrading?.bosChoch;
    if (bc && bc.event !== 'NONE') {
        if (isBull && bc.event === 'BOS_BULLISH') items.push({ label: `BOS Bullish (above ${bc.level})`, pts: 5 });
        else if (!isBull && bc.event === 'BOS_BEARISH') items.push({ label: `BOS Bearish (below ${bc.level})`, pts: 5 });
        else if (isBull && bc.event === 'CHOCH_BEARISH') items.push({ label: `CHOCH Bearish (below ${bc.level})`, pts: -12 });
        else if (!isBull && bc.event === 'CHOCH_BULLISH') items.push({ label: `CHOCH Bullish (above ${bc.level})`, pts: -12 });
    }

    return { items, final: marketState.confidence, generatedAt: new Date().toISOString() };
}

function computeTrapZone(marketState) {
    const price = marketState.nifty;
    const vwap  = marketState.vwap;
    const poc   = marketState.poc?.poc;
    if (!price || !vwap || !poc) {
        return { active: false, label: 'Trap Zone — awaiting data' };
    }
    const bandHi    = Math.max(vwap, poc);
    const bandLo    = Math.min(vwap, poc);
    const bandWidth = bandHi - bandLo;
    const TIGHT_BAND = 40;   // pts — VWAP/POC within this = a real chop pocket
    const BUFFER     = 10;   // pts — price also has to be inside/near the band
    const inBand = price >= (bandLo - BUFFER) && price <= (bandHi + BUFFER);
    const active = bandWidth <= TIGHT_BAND && inBand;

    return {
        active, vwap, poc, bandLo: Math.round(bandLo), bandHi: Math.round(bandHi), bandWidth: Math.round(bandWidth),
        label: active
            ? `⚠️ Trap Zone — between VWAP (${vwap.toFixed(0)}) and POC (${poc.toFixed(0)}) — expect whipsaws, wait for breakout`
            : `Clear — VWAP (${vwap.toFixed(0)}) / POC (${poc.toFixed(0)}) not forming a chop pocket`,
    };
}

function computeDynamicLevelsState(marketState) {
    try {
        const candles = getCandleHistory(true);
        const levels  = computeDynamicLevels(candles, marketState.wsHigh, marketState.wsLow);
        const zoneInfo = classifyDynamicLevels(levels, marketState.nifty);
        return { ...levels, ...zoneInfo };
    } catch (e) {
        console.warn('[DynamicLevels] compute error:', e.message);
        return marketState.dynamicLevels || { available: false, label: 'Dynamic Levels — error' };
    }
}

function computeContradictionScore(marketState) {
    const bullFactors = [], bearFactors = [];
    let bullWeight = 0, bearWeight = 0;

    const mtf = marketState.mtf;
    if (mtf?.aligned) {
        if (mtf.signal === 'BUY CALL') { bullWeight += 40; bullFactors.push('MTF (3/3 aligned)'); }
        else if (mtf.signal === 'BUY PUT') { bearWeight += 40; bearFactors.push('MTF (3/3 aligned)'); }
    } else if (mtf?.bullCount === 2) { bullWeight += 20; bullFactors.push('MTF (2/3 bullish)'); }
    else if (mtf?.bearCount === 2) { bearWeight += 20; bearFactors.push('MTF (2/3 bearish)'); }

    if (marketState.pcrSignal === 'BULLISH') { bullWeight += 15; bullFactors.push('PCR'); }
    else if (marketState.pcrSignal === 'BEARISH') { bearWeight += 15; bearFactors.push('PCR'); }

    if (marketState.delta?.signal === 'BULLISH') { bullWeight += 15; bullFactors.push('Delta'); }
    else if (marketState.delta?.signal === 'BEARISH') { bearWeight += 15; bearFactors.push('Delta'); }

    if (marketState.nifty && marketState.vwap) {
        if (marketState.nifty > marketState.vwap) { bullWeight += 10; bullFactors.push('Above VWAP'); }
        else if (marketState.nifty < marketState.vwap) { bearWeight += 10; bearFactors.push('Below VWAP'); }
    }

    if (marketState.poc?.signal === 'ABOVE_POC') { bullWeight += 10; bullFactors.push('Above POC'); }
    else if (marketState.poc?.signal === 'BELOW_POC') { bearWeight += 10; bearFactors.push('Below POC'); }

    if (marketState.orb?.status === 'BROKEN_UP') { bullWeight += 10; bullFactors.push('ORB Broken Up'); }
    else if (marketState.orb?.status === 'BROKEN_DOWN') { bearWeight += 10; bearFactors.push('ORB Broken Down'); }

    const contradiction = bullWeight >= 30 && bearWeight >= 30;
    const diff   = bullWeight - bearWeight;
    const result = contradiction ? 'NO_TRADE' : diff > 0 ? 'BULLISH' : diff < 0 ? 'BEARISH' : 'NEUTRAL';

    return {
        bullWeight, bearWeight, diff, bullFactors, bearFactors, contradiction, result,
        generatedAt: new Date().toISOString(),
    };
}

function checkAgreementSequence(direction, marketState) {
    if (direction !== 'BUY CALL' && direction !== 'BUY PUT') {
        return { passed: true, failedAt: null, steps: [] };
    }
    const isBull  = direction === 'BUY CALL';
    const oppose  = isBull ? 'BEAR' : 'BULL';
    const steps   = [];

    const mtf = marketState.mtf;
    const mtfDir = mtf?.aligned ? (mtf.signal === 'BUY CALL' ? 'BULL' : 'BEAR')
                 : mtf?.bullCount === 2 ? 'BULL' : mtf?.bearCount === 2 ? 'BEAR' : 'NEUTRAL';
    steps.push({ step: 'MTF', dir: mtfDir });

    const pcrDir = marketState.pcrSignal === 'BULLISH' ? 'BULL' : marketState.pcrSignal === 'BEARISH' ? 'BEAR' : 'NEUTRAL';
    steps.push({ step: 'PCR', dir: pcrDir });

    const deltaDir = marketState.delta?.signal === 'BULLISH' ? 'BULL' : marketState.delta?.signal === 'BEARISH' ? 'BEAR' : 'NEUTRAL';
    steps.push({ step: 'Delta', dir: deltaDir });

    const orbDir = marketState.orb?.status === 'BROKEN_UP' ? 'BULL' : marketState.orb?.status === 'BROKEN_DOWN' ? 'BEAR' : 'NEUTRAL';
    steps.push({ step: 'ORB', dir: orbDir });

    const vwapDir = (marketState.nifty && marketState.vwap)
        ? (marketState.nifty > marketState.vwap ? 'BULL' : marketState.nifty < marketState.vwap ? 'BEAR' : 'NEUTRAL')
        : 'NEUTRAL';
    steps.push({ step: 'VWAP', dir: vwapDir });

    const poc = marketState.poc;
    let vaDir = 'NEUTRAL';
    if (poc?.vah != null && poc?.val != null && marketState.nifty) {
        if (marketState.nifty > poc.vah) vaDir = 'BULL';
        else if (marketState.nifty < poc.val) vaDir = 'BEAR';
    }
    steps.push({ step: 'Value Area', dir: vaDir });

    for (const s of steps) {
        if (s.dir === oppose) {
            return { passed: false, failedAt: s.step, steps };
        }
    }
    return { passed: true, failedAt: null, steps };
}

function computeTrendConviction(marketState) {
    const nifty = marketState.nifty;
    const vwap  = marketState.vwap;
    const val   = marketState.poc?.val;
    const vah   = marketState.poc?.vah;
    const pocSig = marketState.poc?.signal;
    const delta = marketState.delta?.deltaPct;
    const orbStatus = marketState.orb?.status;
    const tf15m = marketState.mtf?.tf15m?.signal;
    const tf1h  = marketState.mtf?.tf1h?.signal;

    const bear = [], bull = [];

    if (nifty && vwap) {
        if (nifty < vwap) bear.push('Price below VWAP');
        else if (nifty > vwap) bull.push('Price above VWAP');
    }
    if (tf15m === 'BEARISH') bear.push('15m Bearish');
    if (tf15m === 'BULLISH') bull.push('15m Bullish');
    if (tf1h === 'BEARISH') bear.push('1H Bearish');
    if (tf1h === 'BULLISH') bull.push('1H Bullish');
    if (delta != null && delta <= -40) bear.push(`Delta ${delta}%`);
    if (delta != null && delta >=  40) bull.push(`Delta +${delta}%`);
    if (val != null && nifty && nifty < val) bear.push('Price below VAL');
    if (vah != null && nifty && nifty > vah) bull.push('Price above VAH');
    if (pocSig === 'BELOW_POC') bear.push('Price below POC');
    if (pocSig === 'ABOVE_POC') bull.push('Price above POC');
    if (orbStatus === 'BROKEN_DOWN') bear.push('ORB Breakdown');
    if (orbStatus === 'BROKEN_UP')   bull.push('ORB Breakout');

    const CONVICTION_THRESHOLD = 4;   // of 7 possible independent conditions
    const active = bear.length >= CONVICTION_THRESHOLD ? 'BEARISH'
                 : bull.length >= CONVICTION_THRESHOLD ? 'BULLISH'
                 : null;

    return {
        active, bearConditions: bear, bullConditions: bull,
        bearCount: bear.length, bullCount: bull.length,
        generatedAt: new Date().toISOString(),
    };
}

// ── Absolute-VIX tiers for option BUYERS (4 Oct 2026, from options-Greeks webinar review) ──
// High VIX = expensive premiums = more theta + more IV-crush risk for a buyer, whatever the
// signal's own confidence says. Rule of thumb from the webinar, adopted as starting values:
//   VIX < 15        normal
//   15 – 20         "ELEVATED"  size capped to 50%
//   20 – 30         "HIGH"      size capped to 25%
//   >= 30           "EXTREME"   no option buying (size 0%)
// SIZE ONLY — never changes the signal, grade or confidence, and never blocks a signal from
// firing (same philosophy as the expiry / VIX-spike / Low-VIX caps). Every threshold is an env
// override; VIX_TIER_CAPS=off disables the whole feature. These are textbook starting points,
// NOT tuned on this app's own trades — the entry_vix column + /api/greeks-attribution exist so
// they can be checked against real outcomes.
const _num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const VIX_TIER_ENABLED = (process.env.VIX_TIER_CAPS || 'on').toLowerCase() !== 'off';
const VIX_T1 = _num(process.env.VIX_TIER1, 15), VIX_T2 = _num(process.env.VIX_TIER2, 20), VIX_T3 = _num(process.env.VIX_TIER3, 30);
const VIX_T1_PCT = _num(process.env.VIX_TIER1_PCT, 50), VIX_T2_PCT = _num(process.env.VIX_TIER2_PCT, 25);

// Returns null when no tier applies, else { tier, capPct, why }.
function vixTier(vix) {
    if (!VIX_TIER_ENABLED || !(vix > 0)) return null;
    const v = Math.round(vix * 10) / 10;
    if (vix >= VIX_T3) return { tier: 'EXTREME',  capPct: 0,          why: `VIX ${v} ≥ ${VIX_T3} — premiums over-expensive, IV-crush risk` };
    if (vix >= VIX_T2) return { tier: 'HIGH',     capPct: VIX_T2_PCT, why: `VIX ${v} ≥ ${VIX_T2} — expensive premiums, heavy theta/IV risk` };
    if (vix >= VIX_T1) return { tier: 'ELEVATED', capPct: VIX_T1_PCT, why: `VIX ${v} ≥ ${VIX_T1} — premiums getting expensive` };
    return null;
}

// ── Known-event IV-crush guard (4 Oct 2026, from options-Greeks webinar review) ──
// Before a KNOWN event (RBI policy, Budget, election result) option premiums are inflated by
// high IV; once the event is out, IV collapses ("IV crush") and a buyer can lose money even when
// the direction call was right. The older Event Countdown only caps CONFIDENCE in the last 3 h.
// This adds a SIZE cap that starts earlier:
//   24 h … 1 h before the event  -> size capped 50%   (PRE)
//   last 1 h                     -> size capped 25%   (NEAR)
// Scope: India, high-impact, with a known time INSIDE market hours (09:15-15:30 IST) — i.e. the
// RBI MPC decision. After-close releases (GDP, CPI) affect the NEXT day's open, not today's IV,
// so they are left to the existing countdown. SIZE ONLY — never changes the signal or confidence.
// Starting values from the webinar, not tuned on this app's trades. KNOWN_EVENT_GUARD=off disables.
const KEG_ENABLED  = (process.env.KNOWN_EVENT_GUARD || 'on').toLowerCase() !== 'off';
const KEG_PRE_H    = _num(process.env.KEG_PRE_HOURS, 24);
const KEG_NEAR_H   = _num(process.env.KEG_NEAR_HOURS, 1);
const KEG_PRE_PCT  = _num(process.env.KEG_PRE_PCT, 50);
const KEG_NEAR_PCT = _num(process.env.KEG_NEAR_PCT, 25);

function computeKnownEventGuard(marketState) {
    try {
        if (!KEG_ENABLED) return null;
        const nowMs = Date.now();   // real instant — event times below carry an explicit +05:30, so this must NOT be getIST().getTime() (that is IST wall-clock labelled as UTC on a UTC server = 5.5 h skew)
        let best = null, bestDiff = Infinity;
        for (const ev of (marketState.calendarEvents || [])) {
            if (ev.impact !== 'high' || ev.country !== 'IN') continue;
            if (ev.category === 'expiry') continue;                      // the weekly F&O expiry marker is NOT a news event
            if (!ev.time || ev.time === '--:--') continue;               // unknown time -> can't place it in the day
            const [hh, mm] = String(ev.time).split(':').map(Number);
            const mins = hh * 60 + (mm || 0);
            if (!(mins >= 555 && mins <= 930)) continue;                 // only events that land inside market hours
            const diff = new Date(`${ev.date}T${ev.time}:00+05:30`).getTime() - nowMs;
            if (diff > 0 && diff <= KEG_PRE_H * 3600000 && diff < bestDiff) { bestDiff = diff; best = ev; }
        }
        if (!best) return null;
        const hours = bestDiff / 3600000;
        const near = hours <= KEG_NEAR_H;
        const h = Math.floor(hours), m = Math.floor((hours - h) * 60);
        return {
            title: best.title, date: best.date, time: best.time,
            hoursRemaining: parseFloat(hours.toFixed(2)),
            tier: near ? 'NEAR' : 'PRE', capPct: near ? KEG_NEAR_PCT : KEG_PRE_PCT,
            why: `${best.title} in ${h}h ${m}m — premiums inflated, IV usually crashes after a known event`,
        };
    } catch (e) { return null; }
}

// ── Expiry-day LATE cap (4 Oct 2026) ─────────────────────────────────────────
// The existing expiry-day cap is a flat 50% all day. Theta and gamma are far heavier in the
// afternoon (see the theta hurdle: ~₹10/hr and 80%+ of a typical target's gain in 2 h near the
// close), so after a cut-off time on expiry day the cap tightens. Size only. Env:
// EXPIRY_LATE_CUTOFF ('HH:MM' IST, default 13:30), EXPIRY_LATE_PCT (default 25), EXPIRY_LATE_CAP=off.
const EXPIRY_LATE_ENABLED = (process.env.EXPIRY_LATE_CAP || 'on').toLowerCase() !== 'off';
const EXPIRY_LATE_PCT = _num(process.env.EXPIRY_LATE_PCT, 25);
const EXPIRY_LATE_MIN = (() => {
    const m = String(process.env.EXPIRY_LATE_CUTOFF || '13:30').match(/^(\d{1,2}):(\d{2})$/);
    return m ? (+m[1]) * 60 + (+m[2]) : 13 * 60 + 30;
})();
function expiryLateCap(ist) {
    if (!EXPIRY_LATE_ENABLED || !ist) return null;
    const mins = ist.getHours() * 60 + ist.getMinutes();
    if (mins < EXPIRY_LATE_MIN) return null;
    const hh = String(Math.floor(EXPIRY_LATE_MIN / 60)).padStart(2, '0'), mm = String(EXPIRY_LATE_MIN % 60).padStart(2, '0');
    return { capPct: EXPIRY_LATE_PCT, why: `expiry day after ${hh}:${mm} — theta/gamma at their heaviest` };
}

// ── Next-week alternative on expiry day (4 Oct 2026) — INFORMATION ONLY ──────────
// On expiry day a same-strike option for the FOLLOWING week costs more but decays far slower
// and carries less gamma risk (webinar's "on expiry day trade next week's option" advice).
// This only prices that alternative for the Telegram alert; the tracked signal, entry, SL and
// target are unchanged. Uses the same Black-Scholes/VIX estimate as the rest of the app.
function computeNextWeekAlt(nifty, strike, type, vixPct, dte, todayThetaPerHr) {
    try {
        if (!(dte > 0) || dte >= 1.0) return null;          // expiry day only
        const dteNext = dte + 7;
        const prem = bsEstimate(nifty, strike, dteNext / 365, vixPct / 100, type);
        const g = calcGreeks(nifty, strike, dteNext / 365, vixPct / 100, type);
        if (!(prem > 0) || !g || !g.theta || !g.delta) return null;
        const thetaPerHr = Math.abs(g.theta) / 6.25;
        return {
            strike, type, premium: Math.round(prem * 10) / 10,
            delta: parseFloat(Math.abs(g.delta).toFixed(2)),
            thetaPerHr: parseFloat(thetaPerHr.toFixed(1)),
            todayThetaPerHr: todayThetaPerHr != null ? todayThetaPerHr : null,
        };
    } catch (e) { return null; }
}

function computeMarketRegime(marketState) {
    const dt = marketState.dayType;
    const expiry = isExpiryDay();
    const vixSpike = !!marketState.tradeQuality?.vixCapped;
    const eventCaution = !!(marketState.eventCountdown?.available && marketState.eventCountdown.withinCautionWindow);
    const gapDay = Math.abs(marketState.premarketGap?.gapPct ?? 0) >= 0.5;
    const lowVix = marketState.vix > 0 && marketState.vix < 14;

    const tags = [];
    if (expiry) tags.push('EXPIRY');
    if (eventCaution) tags.push('EVENT_DAY');
    if (vixSpike) tags.push('HIGH_VIX');
    if (lowVix) tags.push('LOW_VIX');
    const vt = vixTier(marketState.vix);
    if (vt) tags.push(`VIX_${vt.tier}`);
    const keg = marketState.knownEventGuard;
    if (keg) tags.push('EVENT_IV_RISK');
    if (gapDay) tags.push('GAP_DAY');
    if (dt?.trendProbability >= 60) tags.push('TRENDING');
    else if (dt?.rangeProbability >= 60) tags.push('RANGE');
    if (tags.length === 0) tags.push('NORMAL');

    const activeRules = [];
    if (tags.includes('EXPIRY'))     activeRules.push('A+/A grade size capped 50% (Tuesday expiry)');
    if (tags.includes('EVENT_DAY'))  activeRules.push(`Confidence capped 60% (${marketState.eventCountdown?.title || 'high-impact event'} approaching)`);
    if (tags.includes('HIGH_VIX'))   activeRules.push('Size capped 50% (VIX spiked vs today\'s open)');
    if (tags.includes('LOW_VIX'))    activeRules.push('Size capped 65% (Low VIX regime — historically weakest expectancy: +0.31R vs +0.69-0.81R in Trending/Range)');
    if (keg) activeRules.push(`Size capped ${keg.capPct}% (${keg.why})`);
    if (vt) activeRules.push(`Size capped ${vt.capPct}%${vt.capPct === 0 ? " — no option buying" : ""} (${vt.why})`);
    if (tags.includes('GAP_DAY'))    activeRules.push(`Large ${marketState.premarketGap?.zone === 'GAP_UP' ? 'gap-up' : 'gap-down'} open (${marketState.premarketGap?.gapPct}%) — first-hour moves less reliable, gap-fill risk both ways`);
    if (tags.includes('RANGE'))      activeRules.push('Dynamic Levels no-trade range-pocket cap active');
    if (tags.includes('TRENDING'))   activeRules.push('Momentum/breakout confluence factors weighted normally');

    return {
        tags, activeRules,
        label: `🗺️ Regime: ${tags.join(' + ')}`,
        detail: activeRules.length ? activeRules.join(' · ') : 'No regime-specific overrides active right now',
        generatedAt: new Date().toISOString(),
    };
}

function computeDataHealth(marketState) {
    const issues = [];
    if (marketState.pcr === null)                              issues.push('PCR unavailable');
    if (marketState.vix === null)                              issues.push('India VIX unavailable');
    if (!marketState.delta || /awaiting/i.test(marketState.delta.label || '')) issues.push('Delta unavailable');
    if (!marketState.breadth?.updatedAt)                        issues.push('Market breadth unavailable');

    const healthy = issues.length === 0;
    const penalty = Math.min(issues.length * 8, 25);   // capped — same scale as other soft caps in this file
    return {
        healthy, issues, penalty,
        label: healthy ? '✅ All data feeds healthy' : `⚠️ ${issues.length} feed(s) degraded: ${issues.join(', ')}`,
        generatedAt: new Date().toISOString(),
    };
}

function computeEventCountdown(marketState) {
    const events = marketState.calendarEvents || [];
    // 4 Oct FIX: was `getIST().getTime()` — IST wall-clock treated as a UTC instant, then compared with event
    // times parsed WITH +05:30. On a UTC server (Railway) that made every event appear 5.5 h earlier than real,
    // so the 3 h caution window fired at the wrong time of day and the "in Xh Ym" label was wrong.
    const nowMs = Date.now();
    let nearest = null, minDiffMs = Infinity;

    for (const ev of events) {
        if (ev.impact !== 'high') continue;
        const timeStr = (ev.time && ev.time !== '--:--') ? ev.time : '00:00';
        const evMs = new Date(`${ev.date}T${timeStr}:00+05:30`).getTime();
        const diff = evMs - nowMs;
        if (diff > 0 && diff < minDiffMs) { minDiffMs = diff; nearest = ev; }
    }

    if (!nearest) return { available: false, label: 'No high-impact event in next 7 days' };

    const hoursRemaining = minDiffMs / 3600000;
    const h = Math.floor(hoursRemaining);
    const m = Math.floor((hoursRemaining - h) * 60);
    const withinCautionWindow = hoursRemaining <= 3;   // caution window before major event

    return {
        available: true, title: nearest.title, date: nearest.date, time: nearest.time,
        hoursRemaining: parseFloat(hoursRemaining.toFixed(2)), withinCautionWindow,
        label: withinCautionWindow
            ? `⏳ ${nearest.title} in ${h}h ${m}m — reduce size / avoid fresh entries`
            : `⏳ ${nearest.title} in ${h}h ${m}m`,
        generatedAt: new Date().toISOString(),
    };
}

function computeProbabilityEngine(marketState) {
    const sig  = marketState.signal;
    const conf = marketState.confidence || 50;
    const tc   = marketState.trendConviction;
    let bullish, bearish, sideways;

    if (sig === 'BUY CALL') {
        bullish  = conf;
        bearish  = Math.round((100 - conf) * 0.4);
        sideways = 100 - bullish - bearish;
    } else if (sig === 'BUY PUT') {
        bearish  = conf;
        bullish  = Math.round((100 - conf) * 0.4);
        sideways = 100 - bullish - bearish;
    } else {
        const bc = tc?.bullCount ?? 0, brc = tc?.bearCount ?? 0;
        const denom = bc + brc + 2;   // +2 damping so a 0/0 read doesn't divide by zero or look falsely extreme
        bullish  = Math.round((bc  / denom) * 100);
        bearish  = Math.round((brc / denom) * 100);
        sideways = 100 - bullish - bearish;
    }

    bullish  = Math.max(2, Math.min(96, bullish));
    bearish  = Math.max(2, Math.min(96, bearish));
    sideways = Math.max(2, 100 - bullish - bearish);
    const sum = bullish + bearish + sideways;
    bullish  = Math.round((bullish  / sum) * 100);
    bearish  = Math.round((bearish  / sum) * 100);
    sideways = 100 - bullish - bearish;

    return {
        bullish, bearish, sideways,
        label: `📊 Bullish ${bullish}% · Bearish ${bearish}% · Sideways ${sideways}%`,
        note: 'Derived from current signal confidence + Trend Conviction condition counts — an illustrative split, not an independent statistical model.',
        generatedAt: new Date().toISOString(),
    };
}

function buildSetupDNA(signal, marketState) {
    if (signal !== 'BUY CALL' && signal !== 'BUY PUT') return null;
    const isBull = signal === 'BUY CALL';
    const tags = [];

    const sweep = marketState.sweepReversal;
    if (sweep?.detected && ((isBull && sweep.direction === 'BULLISH') || (!isBull && sweep.direction === 'BEARISH'))) {
        tags.push('Liquidity Sweep');
    }
    const bc = marketState.physicsOfTrading?.bosChoch?.event;
    if (bc === 'BOS_BULLISH'   && isBull)  tags.push('BOS Bullish');
    if (bc === 'BOS_BEARISH'   && !isBull) tags.push('BOS Bearish');
    if (bc === 'CHOCH_BULLISH' && isBull)  tags.push('CHOCH Bullish');
    if (bc === 'CHOCH_BEARISH' && !isBull) tags.push('CHOCH Bearish');

    const orbStatus = marketState.orb?.status;
    if (orbStatus === 'BROKEN_UP'   && isBull)  tags.push('ORB Breakout');
    if (orbStatus === 'BROKEN_DOWN' && !isBull) tags.push('ORB Breakdown');

    const deltaPct = marketState.delta?.deltaPct;
    if (deltaPct != null && ((isBull && deltaPct >= 40) || (!isBull && deltaPct <= -40))) tags.push('Delta Confirm');

    if (marketState.mtf?.aligned) tags.push('3/3 MTF');

    const tc = marketState.trendConviction;
    if (tc?.active === (isBull ? 'BULLISH' : 'BEARISH')) tags.push('Trend Conviction');

    const dl = marketState.dynamicLevels;
    if (dl?.available) {
        if (isBull  && dl.aboveH3) tags.push('Above Dyn H3');
        if (!isBull && dl.belowL3) tags.push('Below Dyn L3');
    }

    if (tags.length === 0) return 'Baseline Vote-Tally';   // fired on the general vote tally, no single named factor stood out
    return tags.slice(0, 4).join(' + ');
}

function pickStrikeAndPremium(signal, nifty, vix, pcrState, marketState) {
    if (!nifty || nifty <= 0) return null;
    const effectiveVix = vix || 15;

    const isBull = signal === 'BUY CALL';
    const type   = isBull ? 'CE' : 'PE';
    const atm    = Math.round(nifty / 50) * 50;

    let strike = atm;
    if (effectiveVix < 13) {
        strike = isBull ? atm + 50 : atm - 50;
    }

    const dte = daysToNextExpiry();   // real days to next Tuesday expiry

    let positionSizeNote = null;
    if (dte <= 1)      positionSizeNote = '0-1 DTE — gamma/theta both high, consider smaller size than usual';
    else if (dte <= 2) positionSizeNote = '2 DTE — decay accelerating, size normal-to-slightly-reduced';
    let entryPremium = null;
    let premiumSource = 'bs';   // 'live' | 'bs' — surfaced to the trader below
    let premiumAgeSec = null;

    if (pcrState?.records?.length) {
        const rec = pcrState.records.find(r => r.strikePrice === strike);
        const liveLtp = type === 'CE' ? rec?.CE?.lastPrice : rec?.PE?.lastPrice;
        if (liveLtp > 0) { entryPremium = liveLtp; premiumSource = 'live'; }
    }
    if (premiumSource === 'live' && pcrState?.fetchedAt) {
        premiumAgeSec = Math.round((Date.now() - new Date(pcrState.fetchedAt).getTime()) / 1000);
    }

    if (!entryPremium) {  // always try BS — effectiveVix guaranteed
        const sigma = effectiveVix / 100;
        const T = dte / 365;  // FIX: real days to expiry, not hardcoded 3
        entryPremium = parseFloat(bsEstimate(nifty, strike, T, sigma, type).toFixed(2));
    }

    if (!entryPremium || entryPremium <= 0) return null;

    let strikeOI = 0, strikeVolume = 0, lowLiquidity = false;
    if (pcrState?.records?.length) {
        const rec = pcrState.records.find(r => r.strikePrice === strike);
        const side = rec ? (type === 'CE' ? rec.CE : rec.PE) : null;
        if (side) {
            strikeOI     = side.openInterest || 0;
            strikeVolume = side.volume || 0;
            if (strikeOI > 0 && (strikeOI < MIN_STRIKE_OI || strikeVolume < MIN_STRIKE_VOLUME)) {
                lowLiquidity = true;
            }
        }
    }

    const sigma = effectiveVix / 100;
    const T     = dte / 365;

    let slPct = 0.25, rrMultiplier = 2.0;  // defaults
    {
        if      (effectiveVix < 12) { slPct = 0.20; rrMultiplier = 2.5; }   // calm, trending — let it run
        else if (effectiveVix < 16) { slPct = 0.25; rrMultiplier = 2.0; }   // baseline (unchanged)
        else if (effectiveVix < 20) { slPct = 0.30; rrMultiplier = 1.75; }  // elevated noise — book a bit sooner
        else                        { slPct = 0.35; rrMultiplier = 1.5; }  // high vol — quick book (also gated out mostly)
    }
    let slWidth  = parseFloat((entryPremium * slPct).toFixed(2));
    let sl       = parseFloat((entryPremium - slWidth).toFixed(2));
    let target   = parseFloat((entryPremium + slWidth * rrMultiplier).toFixed(2));
    let slSource = 'vix-pct';

    try {
        const fibo = marketState?.fiboCard;
        if (fibo && fibo.levels && fibo.swingHigh > fibo.swingLow) {
            let slSpot = null;
            if (isBull && fibo.direction === 'UP' && fibo.levels.l618 < nifty) {
                slSpot = fibo.levels.l618;   // 61.8% retrace below = structural invalidation
            } else if (!isBull && fibo.direction === 'DOWN' && fibo.levels.l618 > nifty) {
                slSpot = fibo.levels.l618;   // 61.8% retrace above = structural invalidation
            }

            if (slSpot !== null) {
                const bsNow  = bsEstimate(nifty,  strike, T, sigma, type);
                const bsAtSL = bsEstimate(slSpot, strike, T, sigma, type);

                if (bsNow > 0 && bsAtSL >= 0) {
                    const structSL = parseFloat((entryPremium * (bsAtSL / bsNow)).toFixed(2));
                    const risk     = entryPremium - structSL;
                    const riskPct  = risk / entryPremium;

                    if (risk > 0 && riskPct >= 0.05 && riskPct <= 0.45) {
                        sl       = structSL;
                        slWidth  = parseFloat(risk.toFixed(2));
                        target   = parseFloat((entryPremium + slWidth * rrMultiplier).toFixed(2));  // keep VIX-scaled R:R
                        slSource = `fibo-swing (61.8% retrace @ ${slSpot.toFixed(0)} spot)`;
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[Strike] Fibo-structural SL failed, using VIX-% fallback:', e.message);
    }

    const bep = type === 'CE'
        ? parseFloat((strike + entryPremium).toFixed(2))
        : parseFloat((strike - entryPremium).toFixed(2));

    const thetaHurdle = computeThetaHurdle(nifty, strike, type, entryPremium, target, effectiveVix, dte);
    const nextWeekAlt = computeNextWeekAlt(nifty, strike, type, effectiveVix, dte, thetaHurdle ? thetaHurdle.thetaPerHr : null);

    return { type, strike, entry: entryPremium, sl, target, slSource, rrMultiplier, bep, premiumAgeSec, strikeOI, strikeVolume, lowLiquidity, positionSizeNote, thetaHurdle, nextWeekAlt };
}

// ── Theta hurdle (3 Oct 2026, from options-Greeks webinar review) ───────────
// "An option buyer is buying time": every hour in the trade costs theta, and the
// Nifty has to move enough just to pay for it before the trade makes a rupee.
// Uses the app's own Black-Scholes Greeks (VIX as IV proxy). INFORMATIONAL ONLY —
// shown in alerts, never gates a signal.
//   thetaPerHr  : BS calendar-day theta spread over ~6.25 trading hours (approximation)
//   ptsPerHr    : Nifty points needed per hour in your favour just to cover that decay (÷ |delta|)
//   heavy       : two hours of decay would eat >= 40% of the target's premium gain
function computeThetaHurdle(nifty, strike, type, entry, target, vixPct, dte) {
    try {
        const g = calcGreeks(nifty, strike, Math.max(dte, 0.04) / 365, vixPct / 100, type);
        if (!g || !g.theta || !g.delta) return null;
        const absDelta = Math.abs(g.delta);
        if (absDelta < 0.05) return null;
        const thetaPerHr = Math.abs(g.theta) / 6.25;
        const ptsPerHr   = thetaPerHr / absDelta;
        const targetGain = Math.max(target - entry, 0);
        const cost2h     = thetaPerHr * 2;
        const heavy      = targetGain > 0 && (cost2h / targetGain) >= 0.4;
        return {
            delta: parseFloat(absDelta.toFixed(2)),
            thetaPerHr: parseFloat(thetaPerHr.toFixed(1)),
            ptsPerHr: Math.round(ptsPerHr),
            cost2hPctOfTarget: targetGain > 0 ? Math.round((cost2h / targetGain) * 100) : null,
            heavy,
        };
    } catch (e) { return null; }
}

// MIN_STRIKE_OI / MIN_STRIKE_VOLUME used inside pickStrikeAndPremium() above
// — same env-driven values as server.js's own copy (kept in sync manually;
// see server.js's declaration for the canonical source).
const MIN_STRIKE_OI     = parseInt(process.env.MIN_STRIKE_OI)     || 50000;
const MIN_STRIKE_VOLUME = parseInt(process.env.MIN_STRIKE_VOLUME) || 10000;

module.exports = {
    computeSmartMoneyBias, computeDayType, computeConfidenceBreakdown,
    computeTrapZone, computeDynamicLevelsState, computeContradictionScore,
    checkAgreementSequence, computeTrendConviction, computeMarketRegime,
    computeDataHealth, computeEventCountdown, computeProbabilityEngine,
    buildSetupDNA, pickStrikeAndPremium, vixTier, computeKnownEventGuard, expiryLateCap,
};