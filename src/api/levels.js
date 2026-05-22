const axios = require('axios');

async function calculateSRLevels(currentPrice) {
    try {
        const res = await axios.get(
            'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=10d',
            { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }
        );

        const result = res.data?.chart?.result?.[0];
        const quotes = result?.indicators?.quote?.[0];
        if (!quotes) return null;

        const highs  = quotes.high?.filter(v => v != null)  || [];
        const lows   = quotes.low?.filter(v => v != null)   || [];
        const closes = quotes.close?.filter(v => v != null) || [];

        if (closes.length < 2) return null;

        const pdH = parseFloat(highs[highs.length - 2].toFixed(0));
        const pdL = parseFloat(lows[lows.length - 2].toFixed(0));
        const pdC = parseFloat(closes[closes.length - 2].toFixed(0));

        // Pivot points
        const pp = parseFloat(((pdH + pdL + pdC) / 3).toFixed(0));
        const r1 = parseFloat((2 * pp - pdL).toFixed(0));
        const r2 = parseFloat((pp + pdH - pdL).toFixed(0));
        const r3 = parseFloat((pdH + 2 * (pp - pdL)).toFixed(0));
        const s1 = parseFloat((2 * pp - pdH).toFixed(0));
        const s2 = parseFloat((pp - pdH + pdL).toFixed(0));
        const s3 = parseFloat((pdL - 2 * (pdH - pp)).toFixed(0));

        // Week high/low (last 5 days)
        const wHigh = parseFloat(Math.max(...highs.slice(-5)).toFixed(0));
        const wLow  = parseFloat(Math.min(...lows.slice(-5)).toFixed(0));

        const levels = [
            { price: r3,    type: 'R3',  label: 'Pivot R3',         strength: 1 },
            { price: r2,    type: 'R2',  label: 'Pivot R2',         strength: 2 },
            { price: wHigh, type: 'WH',  label: 'Week High',        strength: 3 },
            { price: pdH,   type: 'PDH', label: 'Prev Day High',    strength: 3 },
            { price: r1,    type: 'R1',  label: 'Pivot R1',         strength: 2 },
            { price: pp,    type: 'PP',  label: 'Pivot Point',      strength: 3 },
            { price: s1,    type: 'S1',  label: 'Pivot S1',         strength: 2 },
            { price: pdL,   type: 'PDL', label: 'Prev Day Low',     strength: 3 },
            { price: wLow,  type: 'WL',  label: 'Week Low',         strength: 3 },
            { price: s2,    type: 'S2',  label: 'Pivot S2',         strength: 2 },
            { price: s3,    type: 'S3',  label: 'Pivot S3',         strength: 1 },
        ]
        .filter((l, i, arr) => {
            // Remove duplicate prices
            return arr.findIndex(x => x.price === l.price) === i;
        })
        .sort((a, b) => b.price - a.price);

        // Find nearest S/R to current price
        const above = levels.filter(l => l.price > currentPrice);
        const below = levels.filter(l => l.price < currentPrice);
        const nearRes = above.length > 0 ? above[above.length - 1] : null;
        const nearSup = below.length > 0 ? below[0] : null;

        console.log(`S/R: PP=${pp} R1=${r1} S1=${s1} | Near Res:${nearRes?.price} Sup:${nearSup?.price}`);

        return {
            pp, r1, r2, r3, s1, s2, s3,
            pdH, pdL, pdC, wHigh, wLow,
            levels, nearRes, nearSup,
            updatedAt: new Date().toISOString()
        };

    } catch (err) {
        console.error('S/R levels error:', err.message);
        return null;
    }
}

module.exports = { calculateSRLevels };
