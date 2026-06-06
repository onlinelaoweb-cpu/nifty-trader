'use strict';
// levels.js — Support/Resistance pivot levels
//
// Candle source: in-memory history from Angel WebSocket (getCandleHistory).
// Falls back to NSE allIndices for prev-day OHLC if memory has < 2 days.
// This avoids the NSE daily chart endpoint that times out from Railway.

const { fetchAllIndices, fetchYahooChart } = require('./yahooFetch');
const { getCandleHistory } = require('./indicators');

// Cache weekly OHLC — refresh once per day
let _weeklyCache = null;
let _weeklyCacheAt = 0;

async function getWeeklyOHLC() {
    // Refresh once every 60 min
    if (_weeklyCache && Date.now() - _weeklyCacheAt < 60 * 60 * 1000) {
        return _weeklyCache;
    }
    try {
        // Get last 5 trading days daily candles
        const { nseNiftyDaily } = require('./yahooFetch');
        const days = await nseNiftyDaily(7);
        if (days && days.length >= 3) {
            _weeklyCache = {
                high  : Math.max(...days.map(d => d.high)),
                low   : Math.min(...days.map(d => d.low)),
                open  : days[0].open,
                close : days[days.length - 1].close,
            };
            _weeklyCacheAt = Date.now();
            console.log(`[SR] Weekly OHLC: H=${_weeklyCache.high} L=${_weeklyCache.low} (${days.length} days)`);
            return _weeklyCache;
        }
    } catch (e) {
        console.warn('[SR] Weekly OHLC fetch failed:', e.message);
    }
    return null;
}

// Get prev-day OHLC from allIndices (confirmed working from Railway)
async function getPrevDayOHLC() {
    try {
        const indices = await fetchAllIndices();
        const row = indices.find(r => r.index === 'NIFTY 50' || r.indexSymbol === 'NIFTY 50');
        if (!row) return null;
        // FIX: use daily high/low (row.high / row.low) FIRST.
        // The old code used yearHigh/yearLow as the primary source which caused
        // pivot points to be calculated off the 52-week range instead of
        // yesterday's range — producing wildly incorrect R1/R2/S1/S2 levels.
        return {
            high : parseFloat(row.high  || row.yearHigh  || row.last),
            low  : parseFloat(row.low   || row.yearLow   || row.last),
            close: parseFloat(row.previousClose || row.last),
            open : parseFloat(row.open  || row.last),
        };
    } catch (e) { return null; }
}

// Derive prev-day OHLC from in-memory 1m candles
function getPrevDayFromMemory(candles) {
    if (!candles || candles.length < 30) return null;
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIST   = new Date(Date.now() + IST_OFFSET_MS);
    const todayStr = nowIST.toISOString().slice(0, 10);
    // Separate today vs yesterday candles
    const yesterday = candles.filter(c => {
        if (!c.ts) return false;
        const d = new Date(c.ts + IST_OFFSET_MS).toISOString().slice(0, 10);
        return d < todayStr;
    });
    const today = candles.filter(c => {
        if (!c.ts) return false;
        const d = new Date(c.ts + IST_OFFSET_MS).toISOString().slice(0, 10);
        return d === todayStr;
    });
    const src = yesterday.length >= 10 ? yesterday : candles.slice(0, Math.floor(candles.length / 2));
    if (src.length === 0) return null;
    return {
        high : Math.max(...src.map(c => c.high)),
        low  : Math.min(...src.map(c => c.low)),
        close: src[src.length - 1].close,
        open : src[0].close,
    };
}

async function calculateSRLevels(currentPrice, maxPainData = null) {
    try {
        // Try memory first, then allIndices
        const memCandles = getCandleHistory();
        let ohlc = getPrevDayFromMemory(memCandles);
        if (!ohlc) ohlc = await getPrevDayOHLC();
        if (!ohlc) return null;

        const pdH = parseFloat(ohlc.high.toFixed(0));
        const pdL = parseFloat(ohlc.low.toFixed(0));
        const pdC = parseFloat(ohlc.close.toFixed(0));

        // Pivot points
        const pp = parseFloat(((pdH + pdL + pdC) / 3).toFixed(0));
        const r1 = parseFloat((2 * pp - pdL).toFixed(0));
        const r2 = parseFloat((pp + pdH - pdL).toFixed(0));
        const r3 = parseFloat((pdH + 2 * (pp - pdL)).toFixed(0));
        const s1 = parseFloat((2 * pp - pdH).toFixed(0));
        const s2 = parseFloat((pp - pdH + pdL).toFixed(0));
        const s3 = parseFloat((pdL - 2 * (pdH - pp)).toFixed(0));

        // Week high/low — use proper 5-day daily data (not 1m memory candles)
        // 1m candles only have 2-3 days, so weekly high/low was inaccurate before
        const weeklyOHLC = await getWeeklyOHLC();
        const wHigh = weeklyOHLC
            ? parseFloat(weeklyOHLC.high.toFixed(0))
            : parseFloat(Math.max(...(memCandles.length > 0 ? memCandles.map(c => c.high) : [pdH])).toFixed(0));
        const wLow  = weeklyOHLC
            ? parseFloat(weeklyOHLC.low.toFixed(0))
            : parseFloat(Math.min(...(memCandles.length > 0 ? memCandles.map(c => c.low) : [pdL])).toFixed(0));

        const levels = [
            { price: r3,    type: 'R3',  label: 'Pivot R3',      strength: 1 },
            { price: r2,    type: 'R2',  label: 'Pivot R2',      strength: 2 },
            { price: wHigh, type: 'WH',  label: 'Week High',     strength: 3 },
            { price: pdH,   type: 'PDH', label: 'Prev Day High', strength: 3 },
            { price: r1,    type: 'R1',  label: 'Pivot R1',      strength: 2 },
            { price: pp,    type: 'PP',  label: 'Pivot Point',   strength: 3 },
            { price: s1,    type: 'S1',  label: 'Pivot S1',      strength: 2 },
            { price: pdL,   type: 'PDL', label: 'Prev Day Low',  strength: 3 },
            { price: wLow,  type: 'WL',  label: 'Week Low',      strength: 3 },
            { price: s2,    type: 'S2',  label: 'Pivot S2',      strength: 2 },
            { price: s3,    type: 'S3',  label: 'Pivot S3',      strength: 1 },
        ];

        if (maxPainData?.strike) {
            const onExpiry = maxPainData.expiryDay;
            levels.push({ price: maxPainData.strike, type: 'MP',
                label: onExpiry ? 'Max Pain 🎯 EXPIRY' : 'Max Pain', strength: onExpiry ? 5 : 4 });
        }

        const dedupedLevels = levels
            .filter((l, i, arr) => arr.findIndex(x => x.price === l.price) === i)
            .sort((a, b) => b.price - a.price);

        const above   = dedupedLevels.filter(l => l.price > currentPrice);
        const below   = dedupedLevels.filter(l => l.price < currentPrice);
        const nearRes = above.length > 0 ? above[above.length - 1] : null;
        const nearSup = below.length > 0 ? below[0] : null;

        console.log(`S/R: PP=${pp} R1=${r1} S1=${s1} | Res:${nearRes?.price} Sup:${nearSup?.price}`);
        return { pp, r1, r2, r3, s1, s2, s3, pdH, pdL, pdC, wHigh, wLow,
                 levels: dedupedLevels, nearRes, nearSup,
                 maxPain: maxPainData || null, updatedAt: new Date().toISOString() };
    } catch (err) {
        console.error('S/R levels error:', err.message);
        return null;
    }
}

module.exports = { calculateSRLevels };
