/**
 * historicalData.js — 1 Year Nifty Historical Data Pipeline
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE:
 *   Fetch 1 year of Nifty 50 daily OHLCV data from Yahoo Finance and store
 *   in PostgreSQL (nifty_daily_history table). Once stored, data is served
 *   from DB on every request — no redundant API calls.
 *
 * USED BY:
 *   - levels.js      → 52-week high/low, major pivot zones, demand/supply areas
 *   - server.js      → /api/backtest endpoint
 *   - server.js      → /api/historical endpoint (frontend chart)
 *
 * HOW IT WORKS:
 *   1. On startup: check if DB has >= 200 rows (1 year ≈ 252 trading days)
 *   2. If not: fetch from Yahoo Finance (free, no auth needed)
 *   3. Daily: top-up with yesterday's candle at 6 PM IST
 *   4. Provides helper functions for S/R detection from 1-year data
 *
 * DATA STORED PER ROW:
 *   date, open, high, low, close, volume, prev_close, change_pct
 */

'use strict';
const axios = require('axios');

// ── DB pool reference (injected from server.js) ───────────────────────────────
let _pool = null;

function injectDBPool(pool) {
    _pool = pool;
}

// ── In-memory cache (so S/R functions don't hit DB every tick) ───────────────
let _histCache    = [];   // [{date, open, high, low, close, volume, change_pct}]
let _histCacheAt  = 0;
const HIST_CACHE_TTL = 30 * 60 * 1000;  // 30 min — refresh from DB once per 30 min

// ── Table init ────────────────────────────────────────────────────────────────
async function initHistoricalTable() {
    if (!_pool) return;
    try {
        await _pool.query(`
            CREATE TABLE IF NOT EXISTS nifty_daily_history (
                id          SERIAL PRIMARY KEY,
                date        DATE UNIQUE NOT NULL,
                open        NUMERIC,
                high        NUMERIC,
                low         NUMERIC,
                close       NUMERIC,
                volume      BIGINT DEFAULT 0,
                prev_close  NUMERIC,
                change_pct  NUMERIC,
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await _pool.query(`CREATE INDEX IF NOT EXISTS idx_nifty_hist_date ON nifty_daily_history(date DESC)`);
        console.log('✅ nifty_daily_history table ready');
    } catch (e) {
        console.error('[HistData] Table init error:', e.message);
    }
}

// ── Fetch from Yahoo Finance — 1 year of ^NSEI daily candles ────────────────
// Uses query1/query2 alternately — no auth needed, Railway compatible
async function fetchFromYahoo(days = 365) {
    const YAHOO_HEADERS = {
        'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept'         : 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer'        : 'https://finance.yahoo.com/',
    };

    // Try both Yahoo endpoints — one usually works on Railway
    const URLS = [
        `https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1y`,
        `https://query2.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1y`,
    ];

    for (const url of URLS) {
        try {
            console.log(`[HistData] Fetching 1y from Yahoo: ${url.split('?')[0]}`);
            const res = await axios.get(url, {
                headers       : YAHOO_HEADERS,
                timeout       : 20000,
                validateStatus: s => s < 500,
            });

            const result = res.data?.chart?.result?.[0];
            if (!result) continue;

            const timestamps = result.timestamp || [];
            const quote      = result.indicators?.quote?.[0];
            if (!Array.isArray(timestamps) || !quote?.close) continue;

            const candles = [];
            for (let i = 0; i < timestamps.length; i++) {
                const c = quote.close[i];
                if (c == null || c <= 0) continue;
                // Convert UTC timestamp to IST date string
                const dateIST = new Date((timestamps[i] * 1000) + (5.5 * 60 * 60 * 1000))
                    .toISOString().slice(0, 10);
                candles.push({
                    date      : dateIST,
                    open      : parseFloat((quote.open[i]   || c).toFixed(2)),
                    high      : parseFloat((quote.high[i]   || c).toFixed(2)),
                    low       : parseFloat((quote.low[i]    || c).toFixed(2)),
                    close     : parseFloat(c.toFixed(2)),
                    volume    : parseInt(quote.volume[i]) || 0,
                });
            }

            // Calculate prev_close and change_pct
            for (let i = 0; i < candles.length; i++) {
                const prev = i > 0 ? candles[i - 1].close : candles[i].open;
                candles[i].prev_close  = prev;
                candles[i].change_pct  = parseFloat(((candles[i].close - prev) / prev * 100).toFixed(3));
            }

            console.log(`[HistData] ✅ Yahoo returned ${candles.length} daily candles`);
            return candles;
        } catch (e) {
            console.warn(`[HistData] Yahoo failed (${url.includes('query1') ? 'q1' : 'q2'}): ${e.message}`);
        }
    }
    return [];
}

// ── Save candles to DB (upsert — safe to re-run) ─────────────────────────────
async function saveCandles(candles) {
    if (!_pool || candles.length === 0) return 0;
    let saved = 0;
    for (const c of candles) {
        try {
            const r = await _pool.query(
                `INSERT INTO nifty_daily_history (date, open, high, low, close, volume, prev_close, change_pct)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT (date) DO UPDATE SET
                    open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
                    close=EXCLUDED.close, volume=EXCLUDED.volume,
                    prev_close=EXCLUDED.prev_close, change_pct=EXCLUDED.change_pct`,
                [c.date, c.open, c.high, c.low, c.close, c.volume, c.prev_close, c.change_pct]
            );
            if (r.rowCount > 0) saved++;
        } catch (e) {
            // Silent — usually duplicate date conflict on re-run
        }
    }
    console.log(`[HistData] Saved/updated ${saved}/${candles.length} candles to DB`);
    return saved;
}

// ── Count rows in DB ─────────────────────────────────────────────────────────
async function getDBRowCount() {
    if (!_pool) return 0;
    try {
        const r = await _pool.query('SELECT COUNT(*) FROM nifty_daily_history');
        return parseInt(r.rows[0].count) || 0;
    } catch (_) { return 0; }
}

// ── Load from DB into memory cache ───────────────────────────────────────────
async function loadFromDB(days = 365) {
    if (!_pool) return [];
    try {
        const r = await _pool.query(
            `SELECT date::text, open, high, low, close, volume, prev_close, change_pct
             FROM nifty_daily_history
             ORDER BY date DESC
             LIMIT $1`,
            [days]
        );
        const rows = r.rows
            .map(row => ({
                date      : row.date,
                open      : parseFloat(row.open),
                high      : parseFloat(row.high),
                low       : parseFloat(row.low),
                close     : parseFloat(row.close),
                volume    : parseInt(row.volume) || 0,
                prev_close: parseFloat(row.prev_close || row.close),
                change_pct: parseFloat(row.change_pct || 0),
            }))
            .reverse(); // oldest first
        return rows;
    } catch (e) {
        console.error('[HistData] DB load error:', e.message);
        return [];
    }
}

// ── Main init — called at startup ────────────────────────────────────────────
async function initHistoricalData() {
    if (!_pool) {
        console.warn('[HistData] No DB pool — historical data disabled');
        return;
    }

    await initHistoricalTable();

    const count = await getDBRowCount();
    console.log(`[HistData] DB has ${count} daily candles`);

    if (count < 200) {
        // Need to seed — fetch 1 year from Yahoo
        console.log('[HistData] Seeding 1 year of data from Yahoo Finance...');
        const candles = await fetchFromYahoo(365);
        if (candles.length > 0) {
            await saveCandles(candles);
            console.log(`[HistData] ✅ Seeded ${candles.length} candles (${candles[0].date} → ${candles[candles.length-1].date})`);
        } else {
            console.error('[HistData] ❌ Yahoo fetch failed — no historical data');
        }
    } else {
        console.log(`[HistData] DB already has ${count} candles — checking for recent gaps...`);
        // Top up any missing recent candles
        await topUpRecentCandles();
    }

    // Load into memory cache
    _histCache   = await loadFromDB(365);
    _histCacheAt = Date.now();
    console.log(`[HistData] Memory cache loaded: ${_histCache.length} candles`);
}

// ── Top-up: fetch last 10 days to fill recent gaps ──────────────────────────
async function topUpRecentCandles() {
    if (!_pool) return;
    try {
        // Get the most recent date in DB
        const r = await _pool.query('SELECT MAX(date)::text as max_date FROM nifty_daily_history');
        const lastDate = r.rows[0]?.max_date;
        if (!lastDate) return;

        const daysSinceLast = Math.floor((Date.now() - new Date(lastDate).getTime()) / (24 * 60 * 60 * 1000));
        if (daysSinceLast <= 1) {
            console.log('[HistData] Data is current — no top-up needed');
            return;
        }

        console.log(`[HistData] Last data: ${lastDate} (${daysSinceLast} days ago) — fetching recent candles...`);
        const candles = await fetchFromYahoo(30); // fetch last 30 days
        if (candles.length > 0) {
            const newCandles = candles.filter(c => c.date > lastDate);
            if (newCandles.length > 0) {
                await saveCandles(newCandles);
                console.log(`[HistData] Top-up: added ${newCandles.length} new candles`);
            }
        }
    } catch (e) {
        console.error('[HistData] Top-up error:', e.message);
    }
}

// ── Daily top-up scheduler (called from server.js setInterval) ───────────────
async function dailyTopUp() {
    const candles = await fetchFromYahoo(10); // just last 10 days
    if (candles.length > 0) {
        await saveCandles(candles);
        // Refresh memory cache
        _histCache   = await loadFromDB(365);
        _histCacheAt = Date.now();
        console.log(`[HistData] Daily top-up complete — cache now ${_histCache.length} candles`);
    }
}

// ── Public getter — returns memory cache or reloads from DB ─────────────────
async function getHistoricalCandles(days = 252) {
    if (_histCache.length >= 200 && Date.now() - _histCacheAt < HIST_CACHE_TTL) {
        return _histCache.slice(-days);
    }
    // Reload
    _histCache   = await loadFromDB(365);
    _histCacheAt = Date.now();
    return _histCache.slice(-days);
}

// ═════════════════════════════════════════════════════════════════════════════
// S/R LEVEL HELPERS — used by levels.js to build richer pivots from 1-year data
// ═════════════════════════════════════════════════════════════════════════════

// 52-week high and low — most important institutional levels
async function get52WeekHighLow() {
    const candles = await getHistoricalCandles(252);
    if (candles.length < 20) return null;
    return {
        high     : Math.max(...candles.map(c => c.high)),
        low      : Math.min(...candles.map(c => c.low)),
        highDate : candles.reduce((a, b) => b.high > a.high ? b : a).date,
        lowDate  : candles.reduce((a, b) => b.low  < a.low  ? b : a).date,
    };
}

// Monthly high/low for current month and last 3 months
async function getMonthlyLevels() {
    const candles = await getHistoricalCandles(90);
    if (candles.length < 10) return null;
    // Group by month
    const months = {};
    for (const c of candles) {
        const key = c.date.slice(0, 7); // YYYY-MM
        if (!months[key]) months[key] = { high: c.high, low: c.low };
        else {
            months[key].high = Math.max(months[key].high, c.high);
            months[key].low  = Math.min(months[key].low,  c.low);
        }
    }
    return Object.entries(months)
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 3)
        .map(([month, v]) => ({ month, ...v }));
}

// Volume-weighted price clusters — areas where Nifty spent most time
// These are natural support/resistance zones where institutions traded heavily
async function getVolumeClusterLevels(currentPrice, bandWidth = 200) {
    const candles = await getHistoricalCandles(252);
    if (candles.length < 50) return [];

    // Count how many candles had close within each 200-point band
    const bands = {};
    for (const c of candles) {
        const band = Math.round(c.close / bandWidth) * bandWidth;
        if (!bands[band]) bands[band] = { count: 0, totalVol: 0, price: band };
        bands[band].count++;
        bands[band].totalVol += c.volume;
    }

    // Sort by count (most-visited levels)
    const sorted = Object.values(bands)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map(b => ({
            price   : b.price,
            visits  : b.count,
            strength: b.count >= 10 ? 3 : b.count >= 5 ? 2 : 1,
            label   : `Volume Zone ${b.price}`,
        }));

    return sorted;
}

// Recent swing highs and lows (last 30 days, 5-candle pivot)
async function getSwingLevels() {
    const candles = await getHistoricalCandles(30);
    if (candles.length < 10) return { highs: [], lows: [] };

    const highs = [], lows = [];
    for (let i = 2; i < candles.length - 2; i++) {
        const c  = candles[i];
        const isSwingHigh =
            c.high > candles[i-1].high && c.high > candles[i-2].high &&
            c.high > candles[i+1].high && c.high > candles[i+2].high;
        const isSwingLow  =
            c.low  < candles[i-1].low  && c.low  < candles[i-2].low  &&
            c.low  < candles[i+1].low  && c.low  < candles[i+2].low;
        if (isSwingHigh) highs.push({ price: parseFloat(c.high.toFixed(0)), date: c.date, strength: 2 });
        if (isSwingLow)  lows.push ({ price: parseFloat(c.low.toFixed(0)),  date: c.date, strength: 2 });
    }
    return {
        highs: highs.slice(-3),  // last 3 swing highs
        lows : lows.slice(-3),   // last 3 swing lows
    };
}

// ── Complete SR package for levels.js ────────────────────────────────────────
async function getHistoricalSRPackage(currentPrice) {
    try {
        const [weekHighLow, monthly, swings] = await Promise.all([
            get52WeekHighLow(),
            getMonthlyLevels(),
            getSwingLevels(),
        ]);
        return { weekHighLow, monthly, swings };
    } catch (e) {
        console.error('[HistData] SR package error:', e.message);
        return null;
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE
// Runs your existing signals from signal_log against historical price outcomes
// ═════════════════════════════════════════════════════════════════════════════

async function runBacktest(options = {}) {
    if (!_pool) return { error: 'No DB configured' };

    const {
        signalType = null,   // 'BUY CALL' | 'BUY PUT' | null (both)
        gateOnly   = false,  // only quality-gate-passed signals
        minConf    = 0,      // min confidence %
        limit      = 200,
    } = options;

    try {
        // 1. Pull signals from signal_log
        let query = `
            SELECT id, ts, signal, confidence, nifty, rsi, vix, pcr, adx,
                   mtf_signal, mtf_aligned, quality_gate, entry_window, reasons
            FROM signal_log
        `;
        const params = [];
        const where  = [];
        if (signalType) { params.push(signalType); where.push(`signal=$${params.length}`); }
        if (gateOnly)   { where.push('quality_gate=TRUE'); }
        if (minConf > 0){ params.push(minConf); where.push(`confidence>=$${params.length}`); }
        if (where.length) query += ' WHERE ' + where.join(' AND ');
        params.push(limit);
        query += ` ORDER BY ts DESC LIMIT $${params.length}`;

        const sigRes = await _pool.query(query, params);
        const signals = sigRes.rows;

        if (signals.length === 0) return {
            totalSignals: 0,
            message: 'No signals in log yet. Signals auto-log when BUY CALL/PUT fires on dashboard.'
        };

        // 2. For each signal, find next-day close from nifty_daily_history
        //    Simulate: entry at signal's nifty price, check +1 day close
        //    WIN = price moved in signal direction by >= 0.5%
        //    LOSS = price moved against OR no move
        const results = [];
        const histCandles = await getHistoricalCandles(365);

        for (const sig of signals) {
            const entryDate = sig.ts.toISOString().slice(0, 10);
            const entryIdx  = histCandles.findIndex(c => c.date >= entryDate);

            let outcome = 'UNKNOWN', exitPrice = null, returnPct = null;

            if (entryIdx !== -1 && entryIdx < histCandles.length - 1) {
                const nextDay = histCandles[entryIdx + 1];
                exitPrice  = nextDay.close;
                const entryPrice = parseFloat(sig.nifty);

                if (entryPrice > 0 && exitPrice > 0) {
                    returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
                    // CALL: profit if Nifty goes UP | PUT: profit if Nifty goes DOWN
                    if (sig.signal === 'BUY CALL') {
                        outcome = returnPct >= 0.3 ? 'WIN' : returnPct <= -0.3 ? 'LOSS' : 'NEUTRAL';
                    } else {
                        outcome = returnPct <= -0.3 ? 'WIN' : returnPct >= 0.3 ? 'LOSS' : 'NEUTRAL';
                    }
                    // Estimate premium P&L (rough: 1% nifty move ≈ 30% option move for ATM)
                    const optionReturn = returnPct * (sig.signal === 'BUY CALL' ? 30 : -30);
                    results.push({
                        id          : sig.id,
                        date        : entryDate,
                        signal      : sig.signal,
                        confidence  : sig.confidence,
                        niftyEntry  : entryPrice,
                        niftyExit   : exitPrice,
                        niftyMove   : parseFloat(returnPct.toFixed(3)),
                        outcome,
                        optionReturn: parseFloat(optionReturn.toFixed(1)),
                        qualityGate : sig.quality_gate,
                        vix         : sig.vix,
                        rsi         : sig.rsi,
                        adx         : sig.adx,
                        mtfAligned  : sig.mtf_aligned,
                    });
                }
            }
        }

        // 3. Compute stats
        const wins    = results.filter(r => r.outcome === 'WIN').length;
        const losses  = results.filter(r => r.outcome === 'LOSS').length;
        const neutral = results.filter(r => r.outcome === 'NEUTRAL').length;
        const total   = wins + losses + neutral;
        const winRate = total > 0 ? parseFloat(((wins / (wins + losses || 1)) * 100).toFixed(1)) : 0;
        const avgConf = total > 0 ? parseFloat((results.reduce((s,r) => s + r.confidence, 0) / total).toFixed(1)) : 0;

        // 4. Stats by condition
        const gatePassedWins  = results.filter(r => r.qualityGate && r.outcome === 'WIN').length;
        const gatePassedTotal = results.filter(r => r.qualityGate).length;
        const gateWinRate     = gatePassedTotal > 0 ? parseFloat(((gatePassedWins / gatePassedTotal) * 100).toFixed(1)) : null;

        const callWins    = results.filter(r => r.signal === 'BUY CALL' && r.outcome === 'WIN').length;
        const callTotal   = results.filter(r => r.signal === 'BUY CALL').length;
        const putWins     = results.filter(r => r.signal === 'BUY PUT'  && r.outcome === 'WIN').length;
        const putTotal    = results.filter(r => r.signal === 'BUY PUT').length;

        // 5. ADX analysis — do high ADX signals win more?
        const adxResults = results.filter(r => r.adx > 0);
        const highADXWins  = adxResults.filter(r => r.adx >= 25 && r.outcome === 'WIN').length;
        const highADXTotal = adxResults.filter(r => r.adx >= 25).length;

        // 6. Best performing conditions
        const insights = [];
        if (gateWinRate && gateWinRate > winRate + 5) {
            insights.push(`✅ Quality Gate improves win rate by ${(gateWinRate - winRate).toFixed(1)}% (${gateWinRate}% vs ${winRate}%)`);
        }
        if (highADXTotal >= 5) {
            const highADXRate = parseFloat(((highADXWins / highADXTotal) * 100).toFixed(1));
            if (highADXRate > winRate) {
                insights.push(`📈 ADX ≥25 signals win ${highADXRate}% vs overall ${winRate}% — ADX filter is working`);
            }
        }
        if (callTotal >= 5 && putTotal >= 5) {
            const callWinRate = parseFloat(((callWins / callTotal) * 100).toFixed(1));
            const putWinRate  = parseFloat(((putWins  / putTotal)  * 100).toFixed(1));
            if (callWinRate > putWinRate + 10) insights.push(`📊 CALL signals performing better (${callWinRate}% vs ${putWinRate}%)`);
            if (putWinRate  > callWinRate + 10) insights.push(`📊 PUT signals performing better (${putWinRate}% vs ${callWinRate}%)`);
        }

        return {
            totalSignals      : signals.length,
            analyzedSignals   : total,
            wins, losses, neutral,
            winRate,
            avgConfidence     : avgConf,
            gateWinRate,
            gatePassedTotal,
            callStats : { wins: callWins,  total: callTotal,  winRate: callTotal  > 0 ? parseFloat(((callWins / callTotal) * 100).toFixed(1)) : 0 },
            putStats  : { wins: putWins,   total: putTotal,   winRate: putTotal   > 0 ? parseFloat(((putWins  / putTotal)  * 100).toFixed(1)) : 0 },
            highADXStats: { wins: highADXWins, total: highADXTotal, winRate: highADXTotal > 0 ? parseFloat(((highADXWins / highADXTotal) * 100).toFixed(1)) : 0 },
            insights,
            recentResults     : results.slice(0, 20),  // last 20 for display
            generatedAt       : new Date().toISOString(),
        };

    } catch (e) {
        console.error('[Backtest] Error:', e.message);
        return { error: e.message };
    }
}

module.exports = {
    injectDBPool,
    initHistoricalData,
    dailyTopUp,
    getHistoricalCandles,
    getHistoricalSRPackage,
    get52WeekHighLow,
    getMonthlyLevels,
    getSwingLevels,
    runBacktest,
};
