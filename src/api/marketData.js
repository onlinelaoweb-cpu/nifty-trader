const axios = require('axios');

async function fetchNiftyData() {
    try {
        const res = await axios.get(
            'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1m&range=1d&includePrePost=false',
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Accept'    : 'application/json'
                },
                timeout: 10000
            }
        );

        const result = res.data?.chart?.result?.[0];
        const meta   = result?.meta;
        if (!meta) return null;

        const price     = parseFloat(meta.regularMarketPrice.toFixed(2));
        const prevClose = meta.previousClose;
        const change    = parseFloat((price - prevClose).toFixed(2));
        const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));

        const closes  = result?.indicators?.quote?.[0]?.close  || [];
        const highs   = result?.indicators?.quote?.[0]?.high   || [];
        const lows    = result?.indicators?.quote?.[0]?.low    || [];
        const volumes = result?.indicators?.quote?.[0]?.volume || [];

        const validCandles = [];
        const validCloses  = [];

        for (let i = 0; i < closes.length; i++) {
            if (closes[i] != null && highs[i] != null && lows[i] != null) {
                validCloses.push(parseFloat(closes[i].toFixed(2)));
                validCandles.push({
                    open  : closes[i],
                    high  : highs[i],
                    low   : lows[i],
                    close : closes[i],
                    volume: volumes[i] || 1
                });
            }
        }

        console.log(`NIFTY(Yahoo): ${price} | Candles: ${validCloses.length}`);

        return {
            price,
            prevClose,
            change,
            changePct,
            closes : validCloses,
            candles: validCandles
        };

    } catch (err) {
        console.error('NIFTY fetch error:', err.message);
        return null;
    }
}

async function fetchVIX() {
    try {
        const res = await axios.get(
            'https://query1.finance.yahoo.com/v8/finance/chart/%5EINDIAVIX?interval=1m&range=1d',
            {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 8000
            }
        );

        const meta = res.data?.chart?.result?.[0]?.meta;
        if (!meta) return null;

        const vix       = parseFloat(meta.regularMarketPrice.toFixed(2));
        const prevClose = meta.previousClose;
        const change    = parseFloat((vix - prevClose).toFixed(2));

        function vixInfo(v) {
            if (v < 12) return { signal: 'VERY LOW',  note: 'Market complacent', range: 'ATM ±150' };
            if (v < 15) return { signal: 'LOW',       note: 'Normal market',     range: 'ATM ±150' };
            if (v < 20) return { signal: 'MODERATE',  note: 'Some uncertainty',  range: 'ATM ±200' };
            if (v < 25) return { signal: 'HIGH',      note: 'Elevated fear',     range: 'ATM ±250' };
            if (v < 30) return { signal: 'VERY HIGH', note: 'Reduce qty 50%',    range: 'ATM ±300' };
            return             { signal: 'EXTREME',   note: 'Avoid trading',     range: 'AVOID'    };
        }

        const info = vixInfo(vix);
        console.log(`VIX: ${vix} (${change >= 0 ? '+' : ''}${change}) — ${info.signal}`);

        return {
            vix,
            change,
            changePct  : parseFloat(((change / prevClose) * 100).toFixed(2)),
            signal     : info.signal,
            note       : info.note,
            strikeRange: info.range
        };

    } catch (err) {
        console.error('VIX fetch error:', err.message);
        return null;
    }
}

async function fetchMarketData() {
    const [niftyData, vixData] = await Promise.all([
        fetchNiftyData(),
        fetchVIX()
    ]);
    return { niftyData, pcrData: null, vixData };
}

module.exports = { fetchMarketData };
