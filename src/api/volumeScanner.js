'use strict';
// volumeScanner.js — Phase 2 (6 Sep) of the volume-scanner feature.
//
// PURPOSE:
//   Flag F&O stocks trading unusual CASH-MARKET volume today vs their own
//   20-day average — a classic "something's happening in this stock" signal
//   for investing/trading, separate from the NIFTY/CRUDEOIL options engine.
//
// HOW IT WORKS:
//   1. Baseline (once/day): Angel's historical candle API, per stock, last
//      ~30 calendar days of daily candles → 20-day average volume. Angel
//      rate-limits historical calls (~3/sec) so this runs sequentially,
//      throttled, in the background — takes ~1-2 min for ~200 stocks.
//   2. Live (every 1-2 min, market hours only): Angel's getMarketData —
//      same bulk-quote endpoint breadth.js already uses for the Nifty 50
//      A/D panel — batched 50 tokens/call, so ~200 stocks = ~4 calls.
//   3. ratio = today's live volume / 20-day average. Sorted list of stocks
//      with the highest ratio = the scanner's output.
//
// Phase 1 (getFnOStockList in nseData.js) supplies the stock universe +
// tokens this module tracks. Fully standalone — does not touch the NIFTY
// WS feed, PCR, or any existing signal logic.

const axios = require('axios');
const { fetchFyersQuotesBulk, fetchFyersStockHistory } = require('./nseData');

// ── Sector classification (10 Sep) ────────────────────────────────────────
// Static mapping — no reliable free/live per-stock sector source exists
// (NSE's equity-stockIndices endpoint is confirmed 404 on Railway IPs
// elsewhere in this codebase, and Angel's ScripMaster carries no sector
// field). Scoped to the major, well-known F&O stocks — anything not listed
// here is honestly bucketed as "Other" rather than guessed, since a wrong
// sector label is worse than an admitted gap.
const SECTOR_MAP = {
    // Banking / Financial Services
    HDFCBANK:'Banking', ICICIBANK:'Banking', SBIN:'Banking', KOTAKBANK:'Banking',
    AXISBANK:'Banking', INDUSINDBK:'Banking', BANKBARODA:'Banking', PNB:'Banking',
    IDFCFIRSTB:'Banking', FEDERALBNK:'Banking', AUBANK:'Banking', BANDHANBNK:'Banking',
    BAJFINANCE:'Financial Services', BAJAJFINSV:'Financial Services', HDFCLIFE:'Financial Services',
    SBILIFE:'Financial Services', ICICIGI:'Financial Services', ICICIPRULI:'Financial Services',
    SHRIRAMFIN:'Financial Services', CHOLAFIN:'Financial Services', MUTHOOTFIN:'Financial Services',
    LICHSGFIN:'Financial Services', PFC:'Financial Services', RECLTD:'Financial Services',
    LICI:'Financial Services', SBICARD:'Financial Services', PAYTM:'Financial Services',
    // IT
    TCS:'IT', INFY:'IT', WIPRO:'IT', HCLTECH:'IT', TECHM:'IT', LTIM:'IT',
    PERSISTENT:'IT', COFORGE:'IT', MPHASIS:'IT', LTTS:'IT',
    // Auto
    MARUTI:'Auto', TATAMOTORS:'Auto', M_M:'Auto', BAJAJ_AUTO:'Auto', EICHERMOT:'Auto',
    HEROMOTOCO:'Auto', TVSMOTOR:'Auto', ASHOKLEY:'Auto', BALKRISIND:'Auto', BOSCHLTD:'Auto',
    MRF:'Auto', APOLLOTYRE:'Auto', MOTHERSON:'Auto', BHARATFORG:'Auto',
    // Pharma
    SUNPHARMA:'Pharma', DRREDDY:'Pharma', CIPLA:'Pharma', DIVISLAB:'Pharma', LUPIN:'Pharma',
    AUROPHARMA:'Pharma', BIOCON:'Pharma', TORNTPHARM:'Pharma', ALKEM:'Pharma', ZYDUSLIFE:'Pharma',
    LAURUSLABS:'Pharma', GLENMARK:'Pharma', ABBOTINDIA:'Pharma',
    // FMCG
    HINDUNILVR:'FMCG', ITC:'FMCG', NESTLEIND:'FMCG', BRITANNIA:'FMCG', TATACONSUM:'FMCG',
    DABUR:'FMCG', GODREJCP:'FMCG', MARICO:'FMCG', COLPAL:'FMCG', VBL:'FMCG', UBL:'FMCG',
    // Metal / Mining
    TATASTEEL:'Metal', JSWSTEEL:'Metal', HINDALCO:'Metal', VEDL:'Metal', SAIL:'Metal',
    NMDC:'Metal', JINDALSTEL:'Metal', NATIONALUM:'Metal', HINDZINC:'Metal', COALINDIA:'Metal',
    // Energy / Oil & Gas
    RELIANCE:'Energy', ONGC:'Energy', BPCL:'Energy', IOC:'Energy', GAIL:'Energy',
    HINDPETRO:'Energy', OIL:'Energy', ADANIGREEN:'Energy', ADANIENSOL:'Energy', NTPC:'Energy',
    POWERGRID:'Energy', TATAPOWER:'Energy', NHPC:'Energy',
    // Realty / Infra / Cement
    DLF:'Realty', GODREJPROP:'Realty', OBEROIRLTY:'Realty', PRESTIGE:'Realty',
    ULTRACEMCO:'Cement', SHREECEM:'Cement', AMBUJACEM:'Cement', ACC:'Cement', GRASIM:'Cement',
    LT:'Infra', ADANIPORTS:'Infra', GMRINFRA:'Infra', IRCTC:'Infra', CONCOR:'Infra',
    // Telecom / Media
    BHARTIARTL:'Telecom', IDEA:'Telecom', INDUSTOWER:'Telecom',
    ZEEL:'Media', SUNTV:'Media', PVRINOX:'Media',
    // Consumer Durables / Retail
    TITAN:'Consumer Durables', ASIANPAINT:'Consumer Durables', HAVELLS:'Consumer Durables',
    VOLTAS:'Consumer Durables', DIXON:'Consumer Durables', TRENT:'Retail', DMART:'Retail',
    // Chemicals
    PIDILITIND:'Chemicals', SRF:'Chemicals', UPL:'Chemicals', PIIND:'Chemicals',
    DEEPAKNTR:'Chemicals', AARTIIND:'Chemicals',
    // PSU / Defence
    BEL:'Defence', HAL:'Defence', BHEL:'PSU', BEML:'Defence',
    // Adani group / Conglomerate
    ADANIENT:'Conglomerate', ADANIPOWER:'Energy',
};
function getStockSector(name) {
    return SECTOR_MAP[name] || 'Other';
}

// ── Angel session (same pattern as breadth.js / nseData.js) ──────────────────
let _angelSession = null;
function injectAngelSession({ jwtToken, apiKey }) {
    _angelSession = { jwtToken, apiKey };
    console.log('[VolScan] ✅ Angel session injected');
}

function angelHeaders() {
    return {
        'Content-Type'     : 'application/json',
        'Accept'           : 'application/json',
        'Authorization'    : `Bearer ${_angelSession.jwtToken}`,
        'X-UserType'       : 'USER',
        'X-SourceID'       : 'WEB',
        'X-ClientLocalIP'  : '127.0.0.1',
        'X-ClientPublicIP' : '127.0.0.1',
        'X-MACAddress'     : '00:00:00:00:00:00',
        'X-PrivateKey'     : _angelSession.apiKey || '',
    };
}

// ── In-memory state ───────────────────────────────────────────────────────────
// Map<name, { token, symbol, baseline20d, liveVolume, ltp, pctChange, ratio, lastLiveAt }>
const _stockState   = new Map();
let _baselineDate    = null;   // YYYY-MM-DD — baselines computed once/day
let _baselineRunning = false;  // guard against overlapping runs

// Backoff for Angel IP block — same pattern as breadth.js's _angelAD. Angel's
// getMarketData is a documented, permanent HTML-block from Railway's IPs (see
// breadth.js's own comment), so retrying it every 90s cycle just wastes 5
// guaranteed-to-fail calls before falling back to Fyers anyway. After 3
// consecutive failures, skip Angel for 30 min and go straight to Fyers.
const _angelVol = { failStreak: 0, backoffUntil: 0 };

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Phase 3 (6 Sep) — shared updater for both Angel/Fyers live-volume paths.
// Pushes a {ts, cumVolume, ltp} snapshot to a rolling per-stock history so
// getBurstRatio() can measure "volume in the last N minutes" — cumulative
// day volume alone can't show a sudden acceleration, only the running total.
// 15 Sep — also stores ltp in the same snapshot (previously volume-only) so
// computeStockMomentum() can measure "price move in the last N minutes" off
// the exact same rolling window, no separate tracking structure needed.
// Capped to the last 12 samples (~18 min at the 90s poll interval) — more
// than enough for a 5-15 min burst/momentum window, without growing unbounded.
function updateStockLive(name, { token, symbol, volume, ltp, pctChange, source }) {
    const st = _stockState.get(name) || { token, symbol, name, history: [] };
    st.liveVolume = volume;
    st.ltp        = ltp;
    st.pctChange  = pctChange;
    st.lastLiveAt = Date.now();
    st.source     = source;
    if (!st.history) st.history = [];
    st.history.push({ ts: Date.now(), cumVolume: volume, ltp });
    if (st.history.length > 12) st.history.shift();
    _stockState.set(name, st);
}

// ── Baseline: N-day volume/price history per stock, via Angel historical
// candles. daysBack defaults to 32 (≈20 trading days, the original 20-day
// baseline use), but refreshVolumeBaselines() below calls this with a much
// longer range too, to also derive 52-week high/low from the SAME call —
// no extra API request, just a wider date window on the one already made.
async function fetchStockDailyVolumes(token, daysBack = 32) {
    const to   = new Date();
    const from = new Date(to.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const fmt  = (d) => {
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} 09:15`;
    };
    const res = await axios.post(
        'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData',
        {
            exchange    : 'NSE',
            symboltoken : String(token),
            interval    : 'ONE_DAY',
            fromdate    : fmt(from),
            todate      : fmt(to),
        },
        { headers: angelHeaders(), timeout: 10_000 }
    );
    if (!res.data?.status || !Array.isArray(res.data?.data)) return { volumes: [], closes: [], highs: [], lows: [] };
    // Each row: [timestamp, open, high, low, close, volume]
    // 10 Sep — also keep closes (for 20-day high/low price-action context),
    // not just volume.
    // 15 Sep — also keep highs/lows (daily extremes) for 52-week high/low.
    const volumes = res.data.data.map(row => Number(row[5]) || 0).filter(v => v > 0);
    const closes  = res.data.data.map(row => Number(row[4]) || 0).filter(v => v > 0);
    const highs   = res.data.data.map(row => Number(row[2]) || 0).filter(v => v > 0);
    const lows    = res.data.data.map(row => Number(row[3]) || 0).filter(v => v > 0);
    return { volumes, closes, highs, lows };
}

// Runs once per day (guarded by _baselineDate) — sequential + throttled to
// respect Angel's historical-API rate limit (~3 req/sec). ~200 stocks at
// 400ms apart ≈ 80s total; runs in the background, doesn't block anything.
// 15 Sep — date window widened from 32 to HISTORY_DAYS_BACK (380 calendar
// days ≈ 52 weeks + holiday buffer) so the SAME once-daily call also yields
// 52-week high/low and a recent-15-trading-day extreme, for the 52-Week
// Reversal setup — no extra API calls, just more days per existing request.
const HISTORY_DAYS_BACK = 380;
async function refreshVolumeBaselines(stockList) {
    const today = new Date().toISOString().slice(0, 10);
    if (_baselineDate === today || _baselineRunning) return;

    _baselineRunning = true;
    const haveAngel = !!_angelSession?.jwtToken;
    console.log(`[VolScan] Refreshing volume + 52w baselines for ${stockList.length} stocks... (Angel:${haveAngel ? 'yes' : 'no, using Fyers'})`);
    let ok = 0, failed = 0, viaFyers = 0;
    for (const stock of stockList) {
        try {
            let hist = { volumes: [], closes: [], highs: [], lows: [] };
            if (haveAngel) {
                try { hist = await fetchStockDailyVolumes(stock.token, HISTORY_DAYS_BACK); }
                catch (e) { /* fall through to Fyers below */ }
            }
            if (!hist.volumes.length) {
                hist = await fetchFyersStockHistory(`NSE:${stock.name}-EQ`, HISTORY_DAYS_BACK);
                if (hist.volumes.length) viaFyers++;
            }
            const vols = hist.volumes, closes = hist.closes, highs = hist.highs || [], lows = hist.lows || [];
            // Exclude today's (possibly still-forming) candle if present — use the
            // most recent 20 COMPLETE days.
            const last20 = vols.slice(0, -1).slice(-20);
            const usable = last20.length >= 5 ? last20 : vols.slice(-20); // fallback if too few
            const avg = usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : null;

            // 10 Sep — 20-day high/low from closes, for price-action context
            // ("is this stock ALSO breaking a level, not just moving volume").
            // Same exclude-today, min-5-days fallback logic as the volume avg.
            const closes20 = closes.slice(0, -1).slice(-20);
            const usableCloses = closes20.length >= 5 ? closes20 : closes.slice(-20);
            const high20d = usableCloses.length ? Math.max(...usableCloses) : null;
            const low20d  = usableCloses.length ? Math.min(...usableCloses) : null;

            // 15 Sep — 52-week high/low from the full daily highs/lows series
            // (not just closes — a close-only series understates the true
            // intraday extreme). Requires at least ~60 days of data before
            // trusting it as a real "52-week" figure, not a partial window.
            const highs52 = highs.slice(0, -1);
            const lows52  = lows.slice(0, -1);
            const high52w = highs52.length >= 60 ? Math.max(...highs52) : null;
            const low52w  = lows52.length  >= 60 ? Math.min(...lows52)  : null;

            // Recent 15-trading-day extreme — "was this stock near its 52w
            // extreme RECENTLY" (not months ago). Same highs/lows series,
            // just the tail end of it.
            const recentHighs15 = highs.slice(0, -1).slice(-15);
            const recentLows15  = lows.slice(0, -1).slice(-15);
            const recentHigh15d = recentHighs15.length ? Math.max(...recentHighs15) : null;
            const recentLow15d  = recentLows15.length  ? Math.min(...recentLows15)  : null;

            if (!_stockState.has(stock.name)) _stockState.set(stock.name, {});
            const st = _stockState.get(stock.name);
            st.token = stock.token; st.symbol = stock.symbol; st.name = stock.name;
            st.baseline20d = avg;
            st.high20d = high20d;
            st.low20d  = low20d;
            st.high52w = high52w;
            st.low52w  = low52w;
            st.recentHigh15d = recentHigh15d;
            st.recentLow15d  = recentLow15d;
            if (avg) ok++; else failed++;
        } catch (e) {
            failed++;
        }
        await sleep(400); // throttle — stay well under Angel's historical rate limit
    }
    _baselineDate = today;
    _baselineRunning = false;
    console.log(`[VolScan] Baselines done: ${ok} ok (${viaFyers} via Fyers fallback), ${failed} failed`);
}

// ── Live: today's volume + LTP, via Angel getMarketData (bulk, same pattern
// breadth.js already uses safely for the Nifty 50 A/D panel) ─────────────────
async function refreshLiveVolumes(stockList) {
    const batches = chunk(stockList, 50);

    for (const batch of batches) {
        // Re-checked per batch (not hoisted once above the loop) — otherwise
        // backoff triggered mid-cycle (e.g. on batch 3) wouldn't stop the
        // remaining batches in that same cycle from also hitting Angel.
        const haveAngel = !!_angelSession?.jwtToken && Date.now() >= _angelVol.backoffUntil;
        let handledViaAngel = false;
        if (haveAngel) {
            try {
                const res = await axios.post(
                    'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/getMarketData',
                    { mode: 'FULL', exchangeTokens: { NSE: batch.map(s => s.token) } },
                    { headers: angelHeaders(), timeout: 8_000 }
                );
                const isHtmlBlock = typeof res.data === 'string' && res.data.includes('<html');
                const fetched = Array.isArray(res.data?.data?.fetched) ? res.data.data.fetched
                              : Array.isArray(res.data?.data)           ? res.data.data
                              : [];
                if (!isHtmlBlock && fetched.length) {
                    for (const item of fetched) {
                        const token = String(item.symbolToken || item.symboltoken || '');
                        const match = batch.find(s => String(s.token) === token);
                        if (!match) continue;
                        updateStockLive(match.name, {
                            token: match.token, symbol: match.symbol,
                            volume: Number(item.tradeVolume ?? item.totalTradedVolume ?? item.volume ?? 0),
                            ltp: Number(item.ltp ?? item.lastPrice ?? 0),
                            pctChange: Number(item.percentChange ?? item.pChange ?? 0),
                            source: 'angel',
                        });
                    }
                    handledViaAngel = true;
                    _angelVol.failStreak = 0; _angelVol.backoffUntil = 0; // reset on success
                } else if (isHtmlBlock) {
                    _angelVol.failStreak++;
                    if (_angelVol.failStreak >= 3) {
                        _angelVol.backoffUntil = Date.now() + 30 * 60 * 1000; // 30 min
                        console.log(`[VolScan] Angel IP-blocked — backing off 30 min (streak ${_angelVol.failStreak}). Fyers fallback active.`);
                    } else {
                        console.warn(`[VolScan] Angel getMarketData HTML block (streak ${_angelVol.failStreak}/3) — falling back to Fyers for this batch`);
                    }
                }
            } catch (e) {
                _angelVol.failStreak++;
                if (_angelVol.failStreak >= 3) _angelVol.backoffUntil = Date.now() + 30 * 60 * 1000;
                console.warn('[VolScan] Angel live volume batch error, falling back to Fyers:', e.message);
            }
        }

        if (!handledViaAngel) {
            // Fyers fallback — same batch, via bulk quotes
            const fyersSymbols = batch.map(s => `NSE:${s.name}-EQ`);
            const quotes = await fetchFyersQuotesBulk(fyersSymbols);
            for (const q of quotes) {
                const stockName = q.symbol?.replace('NSE:', '').replace('-EQ', '');
                const match = batch.find(s => s.name === stockName);
                if (!match) continue;
                updateStockLive(match.name, {
                    token: match.token, symbol: match.symbol,
                    volume: q.volume, ltp: q.ltp, pctChange: q.pctChange,
                    source: 'fyers',
                });
            }
        }
    }
}

// ── Phase 3 (6 Sep) — 5-10 min burst detection ────────────────────────────────
// Cumulative day-volume alone can't show "this just started happening" — a
// stock could hit 3x its daily average by 3pm from a slow steady grind all
// day (already visible in the ratio) OR from a sudden burst in the last few
// minutes (the more actionable, momentum-worthy case). This measures the
// LATTER: volume actually traded in the last `windowMin` minutes, compared
// to what "average pace" would predict for that same window using the
// 20-day baseline spread evenly across the ~375-minute NSE trading day.
const NSE_TRADING_MINUTES = 375; // 9:15 AM – 3:30 PM
function computeBurstRatio(st, windowMin = 10) {
    if (!st.baseline20d || !st.history || st.history.length < 2) return null;
    const now = Date.now();
    const cutoff = now - windowMin * 60 * 1000;
    // Find the oldest snapshot that's still within the window (or the
    // earliest available if history doesn't go back that far yet).
    const past = st.history.find(h => h.ts >= cutoff) || st.history[0];
    const latest = st.history[st.history.length - 1];
    if (!past || past.ts === latest.ts) return null;

    const actualSpanMin = (latest.ts - past.ts) / 60000;
    if (actualSpanMin < 1) return null; // too little elapsed to mean anything

    const volumeInWindow  = latest.cumVolume - past.cumVolume;
    const expectedInWindow = (st.baseline20d / NSE_TRADING_MINUTES) * actualSpanMin;
    if (volumeInWindow <= 0 || expectedInWindow <= 0) return null;

    return parseFloat((volumeInWindow / expectedInWindow).toFixed(2));
}

// ── 15 Sep — per-stock Fast Momentum (stock-level counterpart to server.js's
// checkFastMomentumTrigger() for NIFTY) ───────────────────────────────────
// Same idea as computeBurstRatio() above but measuring PRICE move instead of
// volume, off the same rolling history — no true intraday ATR per stock is
// tracked, so the 20-day high/low range already computed in
// refreshVolumeBaselines() stands in as the volatility proxy: a wide-range
// stock needs a bigger move to count as "fast", a tight-range one needs less.
// This is a coarser proxy than NIFTY's real ATR(14) and should be treated as
// such — tune RANGE_FRACTION from real fired-alert accuracy once there's a
// track record, exactly like NIFTY's own ATR multiplier was.
const STOCK_MOMENTUM_WINDOW_MIN = 15;   // same window as NIFTY's Fast Momentum, for a comparable "in the last N min" read
const STOCK_MOMENTUM_MIN_PCT    = 1.5;  // absolute floor in % — never fire on a few-rupee wiggle in a quiet stock
const STOCK_MOMENTUM_RANGE_FRACTION = 0.08; // move must also clear 8% of the stock's own 20-day high-low range

function computeStockMomentum(st, windowMin = STOCK_MOMENTUM_WINDOW_MIN) {
    if (!st.history || st.history.length < 2 || !st.ltp) return null;
    const now = Date.now();
    const cutoff = now - windowMin * 60 * 1000;
    const past = st.history.find(h => h.ts >= cutoff) || st.history[0];
    const latest = st.history[st.history.length - 1];
    if (!past || past.ts === latest.ts || past.ltp == null || latest.ltp == null) return null;

    const actualSpanMin = (latest.ts - past.ts) / 60000;
    if (actualSpanMin < 1) return null; // too little elapsed to mean anything

    const movePts = latest.ltp - past.ltp;
    const movePct = past.ltp > 0 ? (movePts / past.ltp) * 100 : 0;

    // Threshold: the larger of the flat % floor and a fraction of the stock's
    // own 20-day range — same max(floor, volatility-scaled) shape as NIFTY's
    // Math.max(FAST_MOMENTUM_MIN_PTS, FAST_MOMENTUM_ATR_MULT * atr).
    const rangePts = (st.high20d != null && st.low20d != null) ? (st.high20d - st.low20d) : null;
    const rangeThresholdPts = rangePts ? rangePts * STOCK_MOMENTUM_RANGE_FRACTION : null;
    const floorThresholdPts = (STOCK_MOMENTUM_MIN_PCT / 100) * latest.ltp;
    const thresholdPts = rangeThresholdPts ? Math.max(floorThresholdPts, rangeThresholdPts) : floorThresholdPts;

    return {
        movePts: parseFloat(movePts.toFixed(2)),
        movePct: parseFloat(movePct.toFixed(2)),
        thresholdPts: parseFloat(thresholdPts.toFixed(2)),
        spanMin: parseFloat(actualSpanMin.toFixed(1)),
        ltp: latest.ltp,
    };
}

// Scans every tracked stock, returns only those whose move currently clears
// their own threshold — this is what server.js's periodic tick calls, same
// shape/role as getVolumeScannerSnapshot() above.
function getStockMomentumSnapshot(windowMin = STOCK_MOMENTUM_WINDOW_MIN) {
    const rows = [];
    for (const st of _stockState.values()) {
        const m = computeStockMomentum(st, windowMin);
        if (!m || Math.abs(m.movePts) < m.thresholdPts) continue;
        rows.push({
            name: st.name, symbol: st.symbol,
            direction: m.movePts > 0 ? 'BULLISH' : 'BEARISH',
            ...m,
        });
    }
    rows.sort((a, b) => Math.abs(b.movePts) - Math.abs(a.movePts));
    return rows;
}

// ── 15 Sep — 52-Week Reversal setup ───────────────────────────────────────
// Detects a stock that was recently near its 52-week low (or high), and has
// since bounced (or pulled back) away from that extreme with above-average
// volume — a classic "washout reversal" / "blow-off reversal" pattern.
// Deliberately conservative and slow-moving compared to Fast/Stock Momentum:
// this is about a multi-day setup forming, not a 15-min price spike, so it's
// checked against the once-daily-refreshed 52w/recent-15d fields, live-priced
// against st.ltp on every poll.
const REVERSAL_NEAR_PCT      = 0.05;  // recent 15d extreme must be within 5% of the 52w extreme to count as "was near it"
const REVERSAL_BOUNCE_PCT    = 0.04;  // price must have since moved ≥4% away from that recent extreme
const REVERSAL_VOLUME_BURST_MIN = 1.5; // burst ratio (computeBurstRatio, 10min window) must clear 1.5x baseline pace

function computeStockReversalSetup(st) {
    if (!st.ltp) return null;

    // Bullish case: was near 52w LOW, has since bounced UP off the recent low.
    if (st.low52w != null && st.recentLow15d != null) {
        const nearLow = (st.recentLow15d - st.low52w) / st.low52w <= REVERSAL_NEAR_PCT;
        const bouncePct = (st.ltp - st.recentLow15d) / st.recentLow15d;
        if (nearLow && bouncePct >= REVERSAL_BOUNCE_PCT) {
            const burst = computeBurstRatio(st, 10);
            if (burst != null && burst >= REVERSAL_VOLUME_BURST_MIN) {
                return {
                    direction: 'BULLISH_REVERSAL',
                    extreme: '52W_LOW', extremePrice: st.low52w, recentExtreme: st.recentLow15d,
                    movePct: parseFloat((bouncePct * 100).toFixed(2)),
                    burstRatio: burst, ltp: st.ltp,
                };
            }
        }
    }

    // Bearish case: was near 52w HIGH, has since pulled back DOWN off the recent high.
    if (st.high52w != null && st.recentHigh15d != null) {
        const nearHigh = (st.high52w - st.recentHigh15d) / st.high52w <= REVERSAL_NEAR_PCT;
        const pullbackPct = (st.recentHigh15d - st.ltp) / st.recentHigh15d;
        if (nearHigh && pullbackPct >= REVERSAL_BOUNCE_PCT) {
            const burst = computeBurstRatio(st, 10);
            if (burst != null && burst >= REVERSAL_VOLUME_BURST_MIN) {
                return {
                    direction: 'BEARISH_REVERSAL',
                    extreme: '52W_HIGH', extremePrice: st.high52w, recentExtreme: st.recentHigh15d,
                    movePct: parseFloat((pullbackPct * 100).toFixed(2)),
                    burstRatio: burst, ltp: st.ltp,
                };
            }
        }
    }

    return null;
}

function getStockReversalSnapshot() {
    const rows = [];
    for (const st of _stockState.values()) {
        const r = computeStockReversalSetup(st);
        if (!r) continue;
        rows.push({ name: st.name, symbol: st.symbol, ...r });
    }
    rows.sort((a, b) => b.burstRatio - a.burstRatio);
    return rows;
}

// ── Public: scanner snapshot, sorted by volume ratio descending ──────────────
// minRatio filters out noise (e.g. 1.2x isn't "unusual") — default 2x.
function getVolumeScannerSnapshot(minRatio = 2, sortBy = 'ratio') {
    const rows = [];
    for (const st of _stockState.values()) {
        if (!st.baseline20d || !st.liveVolume) continue;
        const ratio = st.liveVolume / st.baseline20d;
        if (ratio >= minRatio) {
            // 10 Sep — price-action context: is this ALSO a 20-day high/low
            // break, or just a volume spike with no new price extreme?
            let priceContext = null;
            if (st.ltp && st.high20d && st.ltp > st.high20d) priceContext = '20d high breakout';
            else if (st.ltp && st.low20d && st.ltp < st.low20d) priceContext = '20d low breakdown';

            rows.push({
                name: st.name, symbol: st.symbol, ltp: st.ltp, pctChange: st.pctChange,
                liveVolume: st.liveVolume, baseline20d: Math.round(st.baseline20d),
                ratio: parseFloat(ratio.toFixed(2)),
                burstRatio: computeBurstRatio(st),   // null until ~2+ live polls in
                source: st.source || null,
                priceContext,
                sector: getStockSector(st.name),
            });
        }
    }
    if (sortBy === 'burst') {
        rows.sort((a, b) => (b.burstRatio ?? -1) - (a.burstRatio ?? -1));
    } else {
        rows.sort((a, b) => b.ratio - a.ratio);
    }
    return rows;
}

function getVolumeScannerStatus() {
    return {
        stocksTracked  : _stockState.size,
        baselineDate   : _baselineDate,
        baselineRunning: _baselineRunning,
    };
}

// 10 Sep — sector-grouped rollup. Groups the same unusual-volume results by
// sector (see SECTOR_MAP above) — e.g. "is this a Banking-wide move, or one
// isolated stock?" Stocks not in SECTOR_MAP land under "Other".
function getVolumeScannerBySector(minRatio = 2) {
    const rows = getVolumeScannerSnapshot(minRatio, 'ratio');
    const bySector = {};
    for (const r of rows) {
        const sec = r.sector || 'Other';
        if (!bySector[sec]) bySector[sec] = { sector: sec, count: 0, avgRatio: 0, stocks: [] };
        bySector[sec].count++;
        bySector[sec].stocks.push(r.name);
        bySector[sec].avgRatio += r.ratio;
    }
    const grouped = Object.values(bySector).map(g => ({
        ...g, avgRatio: parseFloat((g.avgRatio / g.count).toFixed(2)),
    }));
    grouped.sort((a, b) => b.count - a.count);
    return grouped;
}

module.exports = {
    injectAngelSession,
    refreshVolumeBaselines,
    refreshLiveVolumes,
    getVolumeScannerSnapshot,
    getVolumeScannerStatus,
    getVolumeScannerBySector,
    computeStockMomentum,
    getStockMomentumSnapshot,
    computeStockReversalSetup,
    getStockReversalSnapshot,
};