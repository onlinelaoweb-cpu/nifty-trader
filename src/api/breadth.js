const axios = require('axios');

const NIFTY_STOCKS = [
    { symbol: 'RELIANCE.NS',   name: 'RELIANCE',   weight: 9.2  },
    { symbol: 'HDFCBANK.NS',   name: 'HDFC BANK',  weight: 8.1  },
    { symbol: 'ICICIBANK.NS',  name: 'ICICI BANK', weight: 7.2  },
    { symbol: 'INFY.NS',       name: 'INFY',        weight: 5.8  },
    { symbol: 'TCS.NS',        name: 'TCS',         weight: 5.1  },
    { symbol: 'KOTAKBANK.NS',  name: 'KOTAK',       weight: 3.9  },
    { symbol: 'LT.NS',         name: 'L&T',         weight: 3.8  },
    { symbol: 'SBIN.NS',       name: 'SBI',         weight: 3.2  },
    { symbol: 'AXISBANK.NS',   name: 'AXIS BANK',   weight: 3.0  },
    { symbol: 'BHARTIARTL.NS', name: 'BHARTI',      weight: 2.8  },
    { symbol: 'ITC.NS',        name: 'ITC',         weight: 2.7  },
    { symbol: 'WIPRO.NS',      name: 'WIPRO',       weight: 2.3  },
    { symbol: 'HCLTECH.NS',    name: 'HCL TECH',    weight: 2.2  },
    { symbol: 'MARUTI.NS',     name: 'MARUTI',      weight: 2.1  },
    { symbol: 'BAJFINANCE.NS', name: 'BAJ FIN',     weight: 2.0  },
    { symbol: 'TITAN.NS',      name: 'TITAN',       weight: 1.8  },
    { symbol: 'ASIANPAINT.NS', name: 'ASIAN PAI',   weight: 1.7  },
    { symbol: 'NTPC.NS',       name: 'NTPC',        weight: 1.6  },
    { symbol: 'POWERGRID.NS',  name: 'POWERGRID',   weight: 1.5  },
    { symbol: 'NESTLEIND.NS',  name: 'NESTLE',      weight: 1.4  }
];

// ✅ FIX: Use v8 chart API (same as NIFTY price — no auth needed)
async function fetchStockData(symbol) {
    try {
        const res = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Accept'    : 'application/json'
                },
                timeout: 8000
            }
        );

        const meta = res.data?.chart?.result?.[0]?.meta;
        if (!meta || !meta.regularMarketPrice) return null;

        const price     = parseFloat(meta.regularMarketPrice.toFixed(2));
        const prevClose = meta.previousClose || meta.chartPreviousClose || price;
        const change    = parseFloat((price - prevClose).toFixed(2));
        const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));

        return { price, change, changePct };
    } catch(e) {
        return null;
    }
}

async function fetchAdvanceDecline() {
    try {
        console.log('📊 Fetching A/D data...');

        // ✅ Fetch all 20 stocks in parallel using v8 chart API
        const results = await Promise.all(
            NIFTY_STOCKS.map(s => fetchStockData(s.symbol))
        );

        const stocks = [];
        let advances = 0, declines = 0, unchanged = 0;
        let bullWeight = 0, bearWeight = 0;

        results.forEach((data, i) => {
            const info = NIFTY_STOCKS[i];
            if (!data) return;

            const { price, change, changePct } = data;

            let status = 'unchanged';
            if (changePct > 0.1)       { advances++; status = 'up';   bullWeight += info.weight; }
            else if (changePct < -0.1) { declines++; status = 'down'; bearWeight += info.weight; }
            else                       { unchanged++; }

            stocks.push({
                name: info.name, symbol: info.symbol,
                weight: info.weight, price, change, changePct, status
            });
        });

        // Sort by % change descending
        stocks.sort((a, b) => b.changePct - a.changePct);

        const total      = advances + declines + unchanged;
        const adRatio    = declines > 0
            ? parseFloat((advances / declines).toFixed(2))
            : advances > 0 ? 9.99 : 0;
        const breadthPct = total > 0 ? Math.round((advances / total) * 100) : 50;

        const totalWeight  = bullWeight + bearWeight;
        const weightedBull = totalWeight > 0
            ? Math.round((bullWeight / totalWeight) * 100) : 50;

        let breadthSignal = 'NEUTRAL';
        if      (breadthPct >= 65 && weightedBull >= 60) breadthSignal = 'BULLISH';
        else if (breadthPct <= 35 && weightedBull <= 40) breadthSignal = 'BEARISH';

        console.log(`✅ A/D: ${advances}↑ ${declines}↓ ${unchanged}→ | ${breadthSignal}`);

        return {
            advances, declines, unchanged,
            total: advances + declines,
            adRatio, breadthPct, weightedBull, breadthSignal,
            bullWeight: parseFloat(bullWeight.toFixed(1)),
            bearWeight: parseFloat(bearWeight.toFixed(1)),
            stocks,
            updatedAt: new Date().toISOString()
        };

    } catch (err) {
        console.error('A/D fetch error:', err.message);
        return null;
    }
}

module.exports = { fetchAdvanceDecline };
