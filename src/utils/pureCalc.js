// ── Pure calculation helpers (PCR, ADX, candle aggregation) ──────────────
// Extracted verbatim from server.js (13 Sep refactor, Phase 1).
// None of these touch marketState — each takes plain data in, returns a
// value out. Safe to unit-test in isolation.
const { RSI, EMA } = require('technicalindicators');

function pcrLabel(v) {
    if (!v) return 'N/A';
    if (v > 1.3) return 'BULLISH';   // was >1.5 — too rare, almost never fired
    if (v < 0.8) return 'BEARISH';   // was <0.7 — missed mildly bearish setups
    return 'NEUTRAL';
}

function pcrScore(v) {
    if (!v || isNaN(v)) return 0;
    if (v >= 1.5) return  3;   // heavy call-writing protection → very bullish
    if (v >= 1.3) return  2;
    if (v >= 1.1) return  1;
    if (v >= 0.9) return  0;   // neutral band
    if (v >= 0.7) return -1;
    if (v >= 0.5) return -2;
    return -3;                  // extreme put build-up → very bearish
}

function calculateADX(candles, period = 14) {
    if (!candles || candles.length < period * 2 + 2) return null;
    try {
        // ROOT CAUSE FIX: Do NOT filter flat candles (high==low).
        // Filtering creates time gaps between surviving bars — a bar 15min after
        // the previous one has a huge True Range (|close gap| = 50-200pts for Nifty)
        // which makes Wilder's smoothing produce ADX > 100 indefinitely.
        //
        // Instead: keep ALL candles. For flat bars (high==low or null OHLC),
        // use close-based True Range = |close[i] - close[i-1]|.
        // This preserves time-continuity and gives correct small TR for flat bars.
        const valid = candles.filter(c => c.close != null);
        if (valid.length < period * 2 + 2) return null;
        const tr = [], dmp = [], dmm = [];
        for (let i = 1; i < valid.length; i++) {
            const c  = valid[i],   pc = valid[i - 1];
            const h  = c.high  ?? c.close;
            const l  = c.low   ?? c.close;
            const ph = pc.high ?? pc.close;
            const pl = pc.low  ?? pc.close;
            const pclose = pc.close;
            // True Range: use full Wilder formula when OHLC is real,
            // fall back to |close - prevClose| for flat/index-only bars
            const trVal = (h === l)
                ? Math.abs(c.close - pclose)           // flat bar: close-only TR
                : Math.max(h - l, Math.abs(h - pclose), Math.abs(l - pclose));
            tr.push(trVal);
            // flat bar: DM+ = DM- = 0 (no directional movement possible)
            // Without this, DM can EXCEED TR → DI > 100% → ADX explodes to 300+
            const up = (h === l) ? 0 : (h - ph);
            const dn = (h === l) ? 0 : (pl - l);
            dmp.push(up > dn && up > 0 ? up : 0);
            dmm.push(dn > up && dn > 0 ? dn : 0);
        }
        // Wilder's running smooth: seed = sum of first `period` bars, then iterate
        function wilderSmooth(arr) {
            // FIXED: Wilder initial = AVERAGE of first `period` values (not sum)
            // Using sum caused ADX initial value to be 14x too large → ADX > 100 permanently
            let s = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
            const out = [s];
            for (let i = period; i < arr.length; i++) { s = (s * (period - 1) + arr[i]) / period; out.push(s); }
            return out;
        }
        const atr  = wilderSmooth(tr);
        const sdmp = wilderSmooth(dmp);
        const sdmm = wilderSmooth(dmm);
        const dip  = sdmp.map((v, i) => atr[i] > 0 ? (v / atr[i]) * 100 : 0);
        const dim  = sdmm.map((v, i) => atr[i] > 0 ? (v / atr[i]) * 100 : 0);
        const dx   = dip .map((v, i) => { const s = v + dim[i]; return s > 0 ? (Math.abs(v - dim[i]) / s) * 100 : 0; });
        const adxArr = wilderSmooth(dx);
        const n = adxArr.length - 1;
        const adxVal = parseFloat(adxArr[n].toFixed(2));
        // ADX is mathematically bounded 0–100; anything above means data quality issue
        if (adxVal > 100 || adxVal < 0) {
            // Throttle this warning to once per 5 min to avoid log spam
            const now = Date.now();
            if (!calculateADX._lastWarn || now - calculateADX._lastWarn > 300_000) {
                console.warn(`⚠️ ADX out of range (${adxVal}) — opening-bar gap in data, suppressing until fixed`);
                calculateADX._lastWarn = now;
            }
            return null;
        }
        return {
            adx    : adxVal,
            diPlus : parseFloat(Math.min(100, dip[dip.length - 1]).toFixed(2)),
            diMinus: parseFloat(Math.min(100, dim[dim.length - 1]).toFixed(2))
        };
    } catch (_) { return null; }
}

function _linRegSlope(points) {
    // points: [{x, y}] — returns slope (y per unit x) via least squares, or null if <2 distinct x
    const n = points.length;
    if (n < 2) return null;
    const sumX = points.reduce((a, p) => a + p.x, 0);
    const sumY = points.reduce((a, p) => a + p.y, 0);
    const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
    const sumXX = points.reduce((a, p) => a + p.x * p.x, 0);
    const denom = (n * sumXX - sumX * sumX);
    if (denom === 0) return null; // all same x (no time spread yet)
    return (n * sumXY - sumX * sumY) / denom;
}

function _pcrTimeToMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return (h * 60 + m) - (9 * 60 + 15); // minutes since 09:15 IST open
}

function calcPCRSlope(history) {
    if (!history || history.length < 2) {
        return { slopePerHour: null, recentSlopePerHour: null, trend: 'FLAT', label: 'PCR Slope — collecting data…', sessionHigh: null, sessionLow: null, sessionOpen: null };
    }
    const pts = history.map(h => ({ x: _pcrTimeToMinutes(h.time), y: h.pcr }));

    const slopePerMin = _linRegSlope(pts);
    const slopePerHour = slopePerMin !== null ? parseFloat((slopePerMin * 60).toFixed(3)) : null;

    const recentPts = pts.slice(-10);
    const recentSlopePerMin = _linRegSlope(recentPts);
    const recentSlopePerHour = recentSlopePerMin !== null ? parseFloat((recentSlopePerMin * 60).toFixed(3)) : null;

    const pcrVals = history.map(h => h.pcr);
    const sessionHigh = Math.max(...pcrVals);
    const sessionLow  = Math.min(...pcrVals);
    const sessionOpen = history[0].pcr;

    // Trend label driven by the RECENT slope (more actionable than the full-day
    // drift) — threshold tuned so small noise doesn't flip-flop the label.
    const s = recentSlopePerHour ?? slopePerHour;
    let trend, emoji;
    if (s === null)        { trend = 'FLAT';    emoji = '➖'; }
    else if (s > 0.15)     { trend = 'RISING';  emoji = '📈'; }   // PCR climbing → put writers piling in → bullish drift
    else if (s < -0.15)    { trend = 'FALLING'; emoji = '📉'; }   // PCR falling → call writers piling in → bearish drift
    else                    { trend = 'FLAT';    emoji = '➖'; }

    const dirNote = trend === 'RISING'  ? 'put writers building (bullish drift)'
                  : trend === 'FALLING' ? 'call writers building (bearish drift)'
                  : 'no clear directional build-up';
    const label = `${emoji} PCR Slope ${s !== null ? (s > 0 ? '+' : '') + s.toFixed(2) : '--'}/hr — ${dirNote}`;

    return { slopePerHour, recentSlopePerHour, trend, label, sessionHigh, sessionLow, sessionOpen };
}

function aggregateCandles(candles1m, minutesPerBar) {
    if (!candles1m || candles1m.length === 0) return [];
    const bars = [];
    let current = null, barStartMin = null;
    for (const c of candles1m) {
        const d = new Date(c.time);
        const istMin = Math.floor(d.getTime() / 60000); // minute-resolution bucket key
        const bucket = Math.floor(istMin / minutesPerBar);
        if (barStartMin !== bucket) {
            if (current) bars.push(current);
            current = { open: c.open, high: c.high, low: c.low, close: c.close, time: c.time };
            barStartMin = bucket;
        } else {
            current.high  = Math.max(current.high, c.high);
            current.low   = Math.min(current.low, c.low);
            current.close = c.close;
        }
    }
    if (current) bars.push(current);
    return bars;
}

function computeCrudeIndicators(candles1m) {
    const closes = candles1m.filter(c => c.close != null).map(c => c.close);

    // RSI(9) — same period as NIFTY's 1m RSI (indicators.js calcRSI), for a
    // consistent "how it reads" comparison between the two instruments.
    let rsi = null;
    if (closes.length >= 10) {
        const r = RSI.calculate({ values: closes, period: 9 });
        if (r.length > 0) rsi = parseFloat(r[r.length - 1].toFixed(2));
    }

    let ema9 = null, ema21 = null;
    if (closes.length >= 9) {
        const e = EMA.calculate({ values: closes, period: 9 });
        if (e.length > 0) ema9 = parseFloat(e[e.length - 1].toFixed(2));
    }
    if (closes.length >= 21) {
        const e = EMA.calculate({ values: closes, period: 21 });
        if (e.length > 0) ema21 = parseFloat(e[e.length - 1].toFixed(2));
    }

    const adxResult = calculateADX(candles1m, 14); // null until 30+ candles, same as NIFTY

    return {
        rsi, ema9, ema21,
        adx    : adxResult?.adx     ?? null,
        diPlus : adxResult?.diPlus  ?? null,
        diMinus: adxResult?.diMinus ?? null,
        candleCount: candles1m.length,
    };
}

function crudeTFDirection(candles) {
    const ind = computeCrudeIndicators(candles);
    if (ind.ema9 == null || ind.ema21 == null || ind.diPlus == null || ind.diMinus == null) return null;
    const emaBullish = ind.ema9 > ind.ema21;
    const diBullish  = ind.diPlus > ind.diMinus;
    if (emaBullish && diBullish)   return 'BULL';
    if (!emaBullish && !diBullish) return 'BEAR';
    return null; // disagree — no clean read
}

// ── Phase 2 additions (13 Sep) — extracted verbatim from server.js ───────
// mirrors NIFTY's confidence bands
const CRUDE_MIN_CONFIDENCE      = 65; // base gate, mirrors NIFTY's combineSignals()
const CRUDE_HIGH_CONVICTION_MIN = 70; // stricter filter, mirrors NIFTY's 3-Sep addition —
                                       // tune independently once real crude signals accumulate,
                                       // exactly like NIFTY's own filter was tuned after the fact.

function computeDecayedConfidence(entryConfidence, entryDelta, entryRSI, curDelta, curRSI, direction) {
    if (entryConfidence == null || entryDelta == null || entryRSI == null || curDelta == null || curRSI == null) return entryConfidence;
    const deltaMoveAgainst = direction === 'BUY CALL' ? Math.max(0, entryDelta - curDelta) : Math.max(0, curDelta - entryDelta);
    const rsiMoveAgainst   = direction === 'BUY CALL' ? Math.max(0, entryRSI - curRSI)     : Math.max(0, curRSI - entryRSI);
    // Smooth ramp: fully decayed (capped at 70% reduction) at a 30pt Delta swing
    // or a 20pt RSI swing — twice the Exit Warning's 15pt/5pt thresholds, so this
    // decays gradually well before those binary alerts would fire.
    const deltaDecay = Math.min(1, deltaMoveAgainst / 30);
    const rsiDecay    = Math.min(1, rsiMoveAgainst / 20);
    const overallDecay = Math.max(deltaDecay, rsiDecay);
    const decayed = Math.round(entryConfidence * (1 - overallDecay * 0.7));
    return Math.max(decayed, Math.round(entryConfidence * 0.3));
}

function bsEstimate(S, K, T, sigma, type) {
    const r = 0.0625;  // RBI repo rate (updated June 2026 — was 0.065)
    if (T <= 0) return Math.max(0, type === 'CE' ? S - K : K - S);
    const d1 = (Math.log(S/K) + (r + 0.5*sigma*sigma)*T) / (sigma*Math.sqrt(T));
    const d2 = d1 - sigma*Math.sqrt(T);
    const N  = x => {
        const a=[0.254829592,-0.284496736,1.421413741,-1.453152027,1.061405429],p=0.3275911;
        const s=x<0?-1:1; x=Math.abs(x)/Math.sqrt(2);
        const t=1/(1+p*x),y=1-(((((a[4]*t+a[3])*t)+a[2])*t+a[1])*t+a[0])*t*Math.exp(-x*x);
        return 0.5*(1+s*y);
    };
    return type === 'CE'
        ? S*N(d1) - K*Math.exp(-r*T)*N(d2)
        : K*Math.exp(-r*T)*N(-d2) - S*N(-d1);
}

function computeMurarkaRuleStrike(signal, nifty, vix) {
    const effectiveVix = vix || 15;
    const isBull = signal === 'BUY CALL';
    const atm = Math.round(nifty / 50) * 50;
    if (effectiveVix > 20) return isBull ? atm + 250 : atm - 250; // extrapolated
    if (effectiveVix > 15) return isBull ? atm + 200 : atm - 200; // confirmed
    if (effectiveVix > 10) return isBull ? atm + 150 : atm - 150; // confirmed
    return atm; // VIX <= 10 → ATM (extrapolated)
}

function buildTradeCoach(strikeData) {
    if (!strikeData || !strikeData.entry) return null;
    const { entry, sl, target } = strikeData;

    // Ideal entry zone: tight band around the current live/estimated premium.
    // Chase ceiling: hard cap — paying meaningfully more than current premium
    // for the same setup means the easy part of the move is already captured.
    const idealLow      = parseFloat((entry * 0.96).toFixed(2));
    const idealHigh      = parseFloat((entry * 1.02).toFixed(2));
    const chaseCeiling   = parseFloat((entry * 1.10).toFixed(2));

    const risk = entry - sl;

    return {
        idealEntryLow  : idealLow,
        idealEntryHigh : idealHigh,
        idealEntryLabel: `₹${idealLow}–${idealHigh}`,
        chaseCeiling,
        chaseWarning   : `Do NOT chase above ₹${chaseCeiling}`,
        ifMissed       : 'Missed the zone? Wait for a pullback — don\'t chase.',
        plan: [
            { atPct: 20, premium: parseFloat((entry * 1.20).toFixed(2)), action: 'Move SL to cost (breakeven)' },
            { atPct: 30, premium: parseFloat((entry * 1.30).toFixed(2)), action: 'Book 50% of the position' },
            { atPct: 40, premium: parseFloat((entry * 1.40).toFixed(2)), action: 'Exit remaining — full booking' },
        ],
        riskPerLot: parseFloat(risk.toFixed(2)),
        note: 'Entry-zone guidance for a fresh trade. Once logged in the Journal, the R-multiple trailing-SL system takes over for actual exit alerts.',
    };
}

function buildScalpPlan(strikeData) {
    if (!strikeData || !strikeData.entry) return null;
    const { entry } = strikeData;

    // +18% / -10% — deliberately smaller than the main +50%/-25% plan so it's
    // realistically reachable within 10-20 min rather than needing a full
    // trend move. R:R ~1.8:1, tighter than the main plan's 1:2 but the whole
    // point here is speed over ratio.
    const scalpTarget = parseFloat((entry * 1.18).toFixed(2));
    const scalpSL     = parseFloat((entry * 0.90).toFixed(2));

    const now = new Date();
    const reviewBy   = new Date(now.getTime() + 10 * 60 * 1000);
    const hardExitBy = new Date(now.getTime() + 20 * 60 * 1000);
    const fmt = d => d.toLocaleTimeString('en-IN', { hour12: true, hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

    return {
        entry,
        scalpTarget, scalpSL,
        scalpTgtPct: 18, scalpSlPct: 10,
        reviewByLabel: fmt(reviewBy),
        hardExitByLabel: fmt(hardExitBy),
    };
}

function buildEngineChecklist(qualityGate, allFactorsActive) {
    if (!qualityGate) return null;

    const core = [
        { key: 'mtfAligned',    label: 'MTF Aligned (5m/15m/1H)' },
        { key: 'deltaAligned',  label: 'Delta Confirms' },
        { key: 'adxTrend',      label: 'ADX Trending' },
        { key: 'vixSafe',       label: 'VIX Safe Zone' },
        { key: 'rsiClean',      label: 'RSI Clean' },
        { key: 'safeWindow',    label: 'Safe Entry Window' },
        { key: 'srClear',       label: 'Clear of S/R Wall' },
        { key: 'physicsLaw1',   label: 'Trend Structure (Physics Law-1)' },
        { key: 'physicsLaw3',   label: 'Not Chasing (Physics Law-3)' },
        { key: 'pocClear',      label: 'Clear of POC' },
        { key: 'convictionOk',  label: 'Trend Conviction' },
    ];
    const extra = [
        { key: 'contradictionOk',  label: 'Contradiction Score Clear' },
        { key: 'sequenceAligned',  label: 'Sequence Check Aligned' },
        { key: 'breadthAligned',   label: 'Market Breadth Aligned' },
        { key: 'dynLevelsClear',   label: 'Clear of Range Pocket' },
        { key: 'renkoAligned',     label: 'Renko Trend Aligned' },
        { key: 'gapClear',         label: 'Opening Gap Aligned' },
        { key: 'regimeClear',      label: 'Not Range Regime' },
        { key: 'bosChochAligned',  label: 'Structure (BOS/CHOCH) Aligned' },
        { key: 'newsClear',        label: 'News Sentiment Clear' },
    ];

    const rows = core.concat(allFactorsActive ? extra : []);
    // A gate value of null/undefined means "not evaluated / unknown at this
    // point in the session" (e.g. physicsLaw1 before enough candles exist) —
    // treated as passed for display, matching how qualityGate.passed itself
    // already treats `!== false` as a pass. Only an explicit false counts
    // against the checklist, same semantics as the real gate.
    const items = rows
        .filter(r => qualityGate[r.key] !== undefined)
        .map(r => ({ label: r.label, passed: qualityGate[r.key] !== false }));

    const passedCount = items.filter(i => i.passed).length;
    return {
        items,
        passedCount,
        totalCount: items.length,
        summary: `${passedCount} / ${items.length} Passed`,
    };
}

function withTimeout(promise, ms, label) {
    let resolved = false;
    return Promise.race([
        promise.then(result => { resolved = true; return result; }),
        new Promise(resolve => setTimeout(() => {
            if (!resolved) console.warn(`⏱ ${label} timed out after ${ms}ms — continuing`);
            resolve(null);
        }, ms))
    ]);
}

function detectCandlePatternForTF(candles) {
    if (!candles || candles.length < 2) return { pattern: 'NONE', direction: 'NEUTRAL', strength: 0, reason: '' };

    const c  = candles[candles.length - 1];
    const p  = candles[candles.length - 2];

    if (!c?.open || !c?.high || !c?.low || !c?.close) return { pattern: 'NONE', direction: 'NEUTRAL', strength: 0, reason: '' };

    const body        = Math.abs(c.close - c.open);
    const range       = c.high - c.low;
    const upperWick   = c.high - Math.max(c.open, c.close);
    const lowerWick   = Math.min(c.open, c.close) - c.low;
    const isBullCandle = c.close > c.open;
    const isBearCandle = c.close < c.open;
    const bodyRatio   = range > 0 ? body / range : 0;

    if (bodyRatio < 0.10 && range > 0)
        return { pattern: 'DOJI', direction: 'NEUTRAL', strength: 1, reason: `➕ Doji — indecision` };

    if (lowerWick >= 2 * body && upperWick <= 0.3 * body && lowerWick > 0) {
        const str = lowerWick >= 3 * body ? 3 : 2;
        return { pattern: 'HAMMER', direction: 'BULLISH', strength: str, reason: `🔨 Hammer` };
    }
    if (upperWick >= 2 * body && lowerWick <= 0.3 * body && upperWick > 0 && isBearCandle) {
        const str = upperWick >= 3 * body ? 3 : 2;
        return { pattern: 'SHOOTING_STAR', direction: 'BEARISH', strength: str, reason: `⭐ Shooting Star` };
    }
    if (upperWick >= 2 * body && lowerWick <= 0.3 * body && isBullCandle)
        return { pattern: 'INVERTED_HAMMER', direction: 'BULLISH', strength: 1, reason: `🕯️ Inv. Hammer` };

    const pBody = Math.abs(p.close - p.open);
    const pBear = p.close < p.open;
    const pBull = p.close > p.open;

    if (isBullCandle && pBear && body > 0 && pBody > 0 && c.open <= p.close && c.close >= p.open) {
        const str = body >= 1.5 * pBody ? 3 : 2;
        return { pattern: 'BULLISH_ENGULFING', direction: 'BULLISH', strength: str, reason: `🟢 Bull Engulfing` };
    }
    if (isBearCandle && pBull && body > 0 && pBody > 0 && c.open >= p.close && c.close <= p.open) {
        const str = body >= 1.5 * pBody ? 3 : 2;
        return { pattern: 'BEARISH_ENGULFING', direction: 'BEARISH', strength: str, reason: `🔴 Bear Engulfing` };
    }
    if (isBullCandle && bodyRatio >= 0.75)
        return { pattern: 'STRONG_BULL', direction: 'BULLISH', strength: 2, reason: `📈 Strong Bull` };
    if (isBearCandle && bodyRatio >= 0.75)
        return { pattern: 'STRONG_BEAR', direction: 'BEARISH', strength: 2, reason: `📉 Strong Bear` };

    return { pattern: 'NONE', direction: 'NEUTRAL', strength: 0, reason: '' };
}

function detectLiquiditySweepReversal(candles) {
    const NONE = { detected: false, direction: null, strength: 0, reason: '' };
    if (!Array.isArray(candles) || candles.length < 7) return NONE;

    const sweep    = candles[candles.length - 2];   // candle that broke the range
    const reversal = candles[candles.length - 1];   // candle reclaiming (may be forming)
    const lookback = candles.slice(candles.length - 7, candles.length - 2); // 5 bars prior

    // ── Bug guard: malformed candle fields ───────────────────────────────────
    // resample() (multiTimeframe.js) sets `open: c.close` (prev bar's close),
    // not the actual opening price. For fullReclaim and strongBody to be
    // meaningful, open must be a valid non-zero price, and close must differ
    // from open (a doji has body 0 — never a strong reversal signal anyway).
    // Guard against 0/undefined/null to avoid spurious strength boosts.
    if (!sweep.low || !sweep.high || !sweep.open || !sweep.close) return NONE;
    if (!reversal.close || !reversal.open || reversal.open === 0) return NONE;
    if (!lookback.every(c => c.low > 0 && c.high > 0)) return NONE;

    const refLow  = Math.min(...lookback.map(c => c.low));
    const refHigh = Math.max(...lookback.map(c => c.high));

    const avgVol = lookback.reduce((s, c) => s + (c.volume || 0), 0) / lookback.length;
    // Skip volume gate when data is clearly from Yahoo tick-polling (avgVol ≤ 2 means
    // the "volume" is just a tick counter, not real exchange volume).
    const volOK  = avgVol > 2 ? (reversal.volume || 0) >= avgVol * 1.5 : true;

    const revBody    = Math.abs(reversal.close - reversal.open);
    const revRange   = reversal.high - reversal.low;
    // strongBody: body covers ≥50% of the candle's total range.
    // Guards against doji/spinning-top candles firing as "strong reversal".
    // revRange must be > 0 (it always will be on any real move, but guard anyway).
    const strongBody = revRange > 10 ? (revBody / revRange) >= 0.5 : false;  // also require > 10pt range (not a tiny candle)

    // ── Bullish: support swept, level reclaimed, decisive bull candle ─────────
    if (sweep.low < refLow && reversal.close > refLow && reversal.close > reversal.open && strongBody) {
        const fullReclaim = reversal.close > sweep.open;  // closed back above the whole sweep bar
        const strength    = 1 + (volOK ? 1 : 0) + (fullReclaim ? 1 : 0); // 1..3
        const pts         = Math.round(reversal.close - refLow);
        return {
            detected: true, direction: 'BULLISH', strength,
            reason: `🎯 Liquidity Sweep — swept below ${refLow.toFixed(0)}, reclaimed ${reversal.close.toFixed(0)} (+${pts}pt)`
                  + (volOK ? ' + vol spike' : '') + (fullReclaim ? ' + full reclaim' : ' (partial — still forming)'),
            sweepLevel: refLow, volConfirmed: volOK, fullReclaim
        };
    }

    // ── Bearish: resistance swept, failed back below it, decisive bear candle ─
    if (sweep.high > refHigh && reversal.close < refHigh && reversal.close < reversal.open && strongBody) {
        const fullReclaim = reversal.close < sweep.open;
        const strength    = 1 + (volOK ? 1 : 0) + (fullReclaim ? 1 : 0);
        const pts         = Math.round(refHigh - reversal.close);
        return {
            detected: true, direction: 'BEARISH', strength,
            reason: `🎯 Liquidity Sweep — spiked above ${refHigh.toFixed(0)}, failed back ${reversal.close.toFixed(0)} (-${pts}pt)`
                  + (volOK ? ' + vol spike' : '') + (fullReclaim ? ' + full reclaim' : ' (partial — still forming)'),
            sweepLevel: refHigh, volConfirmed: volOK, fullReclaim
        };
    }

    return NONE;
}

function computeCrudeMTF(candles1m) {
    const tf1m = crudeTFDirection(candles1m);
    const tf5m = crudeTFDirection(aggregateCandles(candles1m, 5));
    // 15m intentionally omitted — see comment above.
    const available = [tf1m, tf5m].filter(x => x !== null);
    const bullCount = available.filter(x => x === 'BULL').length;
    const bearCount = available.filter(x => x === 'BEAR').length;
    return { tf1m, tf5m, availableCount: available.length, bullCount, bearCount };
}

function computeCrudeSignal(candles1m, crudePCR = null) {
    const candles3m = aggregateCandles(candles1m, 3);
    const ind = computeCrudeIndicators(candles3m);
    const reasons = [];

    if (ind.rsi == null || ind.ema9 == null || ind.ema21 == null || ind.adx == null) {
        return { signal: 'WAIT', confidence: 0, reasons: ['⏳ Not enough candles yet for a signal (3m basis needs ~90min into session for ADX)'], indicators: ind };
    }

    const emaBullish = ind.ema9 > ind.ema21;
    const diBullish   = ind.diPlus > ind.diMinus;
    let signal = 'WAIT';
    if (emaBullish && diBullish)   { signal = 'BUY CALL'; reasons.push(`📈 EMA9>EMA21 (${ind.ema9} vs ${ind.ema21}) + DI+ ${ind.diPlus} > DI- ${ind.diMinus}`); }
    else if (!emaBullish && !diBullish) { signal = 'BUY PUT'; reasons.push(`📉 EMA9<EMA21 (${ind.ema9} vs ${ind.ema21}) + DI- ${ind.diMinus} > DI+ ${ind.diPlus}`); }
    else { reasons.push('↔️ EMA and DI direction disagree — no clean bias'); return { signal: 'WAIT', confidence: 0, reasons, indicators: ind }; }

    const mtf = computeCrudeMTF(candles1m);
    const signalDir = signal === 'BUY CALL' ? 'BULL' : 'BEAR';
    if (mtf.tf5m === signalDir) {
        reasons.push(`ℹ️ 1m/5m context: 5m agrees (${signalDir})`);
    } else if (mtf.tf5m !== null) {
        reasons.push(`ℹ️ 1m/5m context: 5m shows ${mtf.tf5m} (informational only, not blocking)`);
    }

    const pcrDir = crudePCR?.pcr == null ? null
                 : crudePCR.pcr > 1.3 ? 'BULL'
                 : crudePCR.pcr < 0.8 ? 'BEAR'
                 : 'NEUTRAL';
    if (pcrDir && pcrDir !== 'NEUTRAL' && pcrDir !== signalDir) {
        reasons.push(`⛔ PCR ${crudePCR.pcr} disagrees (signal:${signalDir} vs PCR:${pcrDir}) — WAIT`);
        return { signal: 'WAIT', confidence: 0, reasons, indicators: ind, mtf, pcr: crudePCR };
    }
    if (pcrDir === signalDir) {
        reasons.push(`✅ PCR ${crudePCR.pcr} confirms ${signalDir}`);
    } else if (!crudePCR) {
        reasons.push('⏳ PCR not available yet — proceeding without it');
    }

    if (signal === 'BUY CALL' && ind.rsi >= 70) {
        reasons.push(`⛔ RSI ${ind.rsi} overbought (need <70) — WAIT`);
        return { signal: 'WAIT', confidence: 0, reasons, indicators: ind };
    }
    if (signal === 'BUY PUT' && ind.rsi <= 30) {
        reasons.push(`⛔ RSI ${ind.rsi} oversold (need >30) — WAIT`);
        return { signal: 'WAIT', confidence: 0, reasons, indicators: ind };
    }

    if (ind.adx < 20) {
        reasons.push(`⛔ ADX ${ind.adx} < 20 — no real trend, WAIT`);
        return { signal: 'WAIT', confidence: 0, reasons, indicators: ind };
    }

    let confidence = 50;
    if (ind.adx >= 30) { confidence += 20; reasons.push(`ADX ${ind.adx} strong (+20)`); }
    else                { confidence += 8;  reasons.push(`ADX ${ind.adx} weak (+8)`); }

    const emaGapPct = Math.abs(ind.ema9 - ind.ema21) / ind.ema21 * 100;
    if (emaGapPct > 0.1) { confidence += 15; reasons.push(`EMA gap ${emaGapPct.toFixed(2)}% — real separation, not razor-edge (+15)`); }

    const diDominance = Math.abs(ind.diPlus - ind.diMinus);
    if (diDominance > 10) { confidence += 10; reasons.push(`DI dominance ${diDominance.toFixed(1)} — clear direction (+10)`); }

    confidence = Math.min(95, confidence); // never claim near-certain — same ceiling philosophy as NIFTY

    if (confidence < CRUDE_MIN_CONFIDENCE) {
        reasons.unshift(`⛔ Confidence ${confidence}% < ${CRUDE_MIN_CONFIDENCE}% minimum — edge too thin for option buyer, WAIT`);
        return { signal: 'WAIT', confidence: 0, reasons, indicators: ind };
    }
    if (confidence < CRUDE_HIGH_CONVICTION_MIN) {
        reasons.unshift(`🚫 High-Conviction Filter: ${confidence}% < ${CRUDE_HIGH_CONVICTION_MIN}% required — held at WAIT`);
        return { signal: 'WAIT', confidence: 0, reasons, indicators: ind };
    }

    return { signal, confidence, reasons, indicators: ind, mtf, pcr: crudePCR };
}

function computeMurarkaZone(pcr, spot, vwap, isExpiry) {
    const bullThr = isExpiry ? 1.10 : 1.15;
    const bearThr = isExpiry ? 0.80 : 0.75;
    let zone, label, color;
    if (pcr === null) { zone = 'AVOID'; label = 'PCR N/A — Awaiting data'; color = 'amber'; }
    else if (pcr > bullThr)  { zone = 'BULL'; label = `PCR ${pcr.toFixed(2)} &gt; ${bullThr} — BUY CE Zone ✅`; color = 'green'; }
    else if (pcr < bearThr)  { zone = 'BEAR'; label = `PCR ${pcr.toFixed(2)} &lt; ${bearThr} — BUY PE Zone 🔻`; color = 'red'; }
    else                     { zone = 'AVOID'; label = `PCR ${pcr !== null ? pcr.toFixed(2) : '--'} in ${bearThr}–${bullThr} — AVOID ⚠️`; color = 'amber'; }

    // Murarka Entry Alert: PCR in actionable zone + spot within ±0.2% of VWAP
    let murarkaEntry = { active: false, side: null, label: 'No Murarka setup', reason: '' };
    if (zone !== 'AVOID' && spot && vwap && vwap > 0) {
        const vwapDist = Math.abs((spot - vwap) / vwap) * 100;
        if (vwapDist <= 0.2) {
            const side = zone === 'BULL' ? 'CE' : 'PE';
            murarkaEntry = {
                active: true,
                side,
                label: `🎯 Murarka Entry! Buy ${side} — PCR ${zone} + Near VWAP (${vwapDist.toFixed(2)}% away)`,
                reason: `PCR=${pcr?.toFixed(2)} | VWAP=₹${vwap?.toFixed(0)} | Spot=₹${spot?.toFixed(0)}`
            };
        } else {
            murarkaEntry = {
                active: false, side: zone === 'BULL' ? 'CE' : 'PE',
                label: `PCR Zone ${zone} ✅ — Wait for VWAP touch (${vwapDist.toFixed(2)}% away)`,
                reason: `Need spot ≤0.2% from VWAP for Murarka entry`
            };
        }
    }

    return { pcrZone: { zone, label, color, pcr }, murarkaEntry };
}

module.exports = {
    pcrLabel, pcrScore, calculateADX, _linRegSlope, _pcrTimeToMinutes,
    calcPCRSlope, aggregateCandles, computeCrudeIndicators, crudeTFDirection,
    computeDecayedConfidence, bsEstimate, computeMurarkaRuleStrike,
    buildTradeCoach, buildScalpPlan, buildEngineChecklist, withTimeout,
    detectCandlePatternForTF, detectLiquiditySweepReversal, computeMurarkaZone,
    computeCrudeMTF, computeCrudeSignal,
};
