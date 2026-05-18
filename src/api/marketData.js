const axios = require('axios');

// ── NIFTY Price from Yahoo Finance ────────────────────
async function fetchNiftyPrice() {
    try {
        const res = await axios.get(
            'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1m&range=1d',
            { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }
        );
        const meta = res.data?.chart?.result?.[0]?.meta;
        if (!meta) return null;

        const price     = parseFloat(meta.regularMarketPrice.toFixed(2));
        const prevClose = meta.previousClose;
        const change    = parseFloat((price - prevClose).toFixed(2));
        const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));

        console.log(`NIFTY (Yahoo): ${price} (${change >= 0 ? '+' : ''}${change})`);
        return { price, prevClose, change, changePct };

    } catch (err) {
        console.error('NIFTY Yahoo fetch error:', err.message);
        return null;
    }
}

// ── PCR from NSE via Proxy ────────────────────────────
async function fetchPCR() {
    // Try multiple methods
    const methods = [
        fetchPCRviaNSE,
        fetchPCRviaProxy
    ];

    for (const method of methods) {
        const result = await method();
        if (result) return result;
    }

    console.log('PCR: All methods failed');
    return null;
}

// Method 1: Direct NSE with full browser headers
async function fetchPCRviaNSE() {
    try {
        // Step 1: Get cookies
        const homeRes = await axios.get('https://www.nseindia.com/', {
            headers: {
                'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept'          : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language' : 'en-IN,en;q=0.9',
                'Accept-Encoding' : 'gzip, deflate, br',
                'Connection'      : 'keep-alive',
                'Cache-Control'   : 'max-age=0',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest'  : 'document',
                'Sec-Fetch-Mode'  : 'navigate',
                'Sec-Fetch-Site'  : 'none',
                'Pragma'          : 'no-cache'
            },
            timeout: 12000
        });

        const cookies = homeRes.headers['set-cookie']
            ?.map(c => c.split(';')[0])
            ?.join('; ') || '';

        if (!cookies) return null;

        // Step 2: Wait 2s like a real browser
        await new Promise(r => setTimeout(r, 2000));

        // Step 3: Fetch option chain
        const res = await axios.get(
            'https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY',
            {
                headers: {
                    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept'         : 'application/json, text/plain, */*',
                    'Accept-Language': 'en-IN,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Referer'        : 'https://www.nseindia.com/option-chain',
                    'Cookie'         : cookies,
                    'Connection'     : 'keep-alive',
                    'Sec-Fetch-Dest' : 'empty',
                    'Sec-Fetch-Mode' : 'cors',
                    'Sec-Fetch-Site' : 'same-origin',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                timeout: 12000
            }
        );

        return parsePCR(res.data);

    } catch (err) {
        console.error('PCR NSE direct failed:', err.message);
        return null;
    }
}

// Method 2: Via allorigins proxy
async function fetchPCRviaProxy() {
    try {
        const target = 'https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY';
        const proxy  = `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`;

        const res = await axios.get(proxy, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 15000
        });

        return parsePCR(res.data);

    } catch (err) {
        console.error('PCR proxy failed:', err.message);
        return null;
    }
}

// Parse option chain → calculate PCR
function parsePCR(data) {
    const records = data?.records?.data;
    if (!records || records.length === 0) return null;

    let totalCallOI = 0;
    let totalPutOI  = 0;
    const atmPrice  = data?.records?.underlyingValue;
    const atmStrike = atmPrice ? Math.round(atmPrice / 50) * 50 : null;
    let atmCallOI   = 0;
    let atmPutOI    = 0;

    records.forEach(item => {
        const ce = item?.CE?.openInterest || 0;
        const pe = item?.PE?.openInterest || 0;
        totalCallOI += ce;
        totalPutOI  += pe;
        if (atmStrike && Math.abs(item.strikePrice - atmStrike) <= 150) {
            atmCallOI += ce;
            atmPutOI  += pe;
        }
    });

    const pcr    = totalCallOI > 0
        ? parseFloat((totalPutOI / totalCallOI).toFixed(2)) : null;
    const atmPcr = atmCallOI > 0
        ? parseFloat((atmPutOI / atmCallOI).toFixed(2)) : null;

    function pcrLabel(v) {
        if (!v) return 'N/A';
        if (v > 1.5) return 'BULLISH';
        if (v < 0.7) return 'BEARISH';
        return 'NEUTRAL';
    }

    console.log(`PCR: ${pcr} (${pcrLabel(pcr)}) | ATM PCR: ${atmPcr}`);

    return {
        pcr, atmPcr,
        pcrSignal   : pcrLabel(pcr),
        atmPcrSignal: pcrLabel(atmPcr),
        atmStrike,
        underlyingValue: atmPrice
    };
}

// ── India VIX from Yahoo Finance ──────────────────────
async function fetchVIX() {
    try {
        const res = await axios.get(
            'https://query1.finance.yahoo.com/v8/finance/chart/%5EINDIAVIX?interval=1m&range=1d',
            { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }
        );

        const meta = res.data?.chart?.result?.[0]?.meta;
        if (!meta) return null;

        const vix       = parseFloat(meta.regularMarketPrice.toFixed(2));
        const prevClose = meta.previousClose;
        const change    = parseFloat((vix - prevClose).toFixed(2));

        function vixInfo(v) {
            if (v < 12) return { signal:'VERY LOW',  note:'Market complacent', range:'ATM ±150' };
            if (v < 15) return { signal:'LOW',       note:'Normal market',     range:'ATM ±150' };
            if (v < 20) return { signal:'MODERATE',  note:'Some uncertainty',  range:'ATM ±200' };
            if (v < 25) return { signal:'HIGH',      note:'Elevated fear',     range:'ATM ±250' };
            if (v < 30) return { signal:'VERY HIGH', note:'Reduce qty 50%',    range:'ATM ±300' };
            return             { signal:'EXTREME',   note:'Avoid trading',     range:'AVOID'   };
        }

        const info = vixInfo(vix);
        console.log(`VIX: ${vix} (${change >= 0 ? '+' : ''}${change}) — ${info.signal}`);

        return { vix, change,
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

// ── Combined ──────────────────────────────────────────
async function fetchMarketData() {
    const [niftyData, pcrData, vixData] = await Promise.all([
        fetchNiftyPrice(),
        fetchPCR(),
        fetchVIX()
    ]);
    return { niftyData, pcrData, vixData };
}

module.exports = { fetchMarketData };
