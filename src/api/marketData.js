const axios = require('axios');

// ── NSE Session (cookies chahiye) ─────────────────────
let nseSession = {
    cookies: '',
    lastFetch: 0
};

async function getNSECookies() {
    const now = Date.now();
    // Refresh cookies every 5 minutes
    if (nseSession.cookies && (now - nseSession.lastFetch) < 300000) {
        return nseSession.cookies;
    }
    try {
        const res = await axios.get('https://www.nseindia.com/', {
            headers: {
                'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection'     : 'keep-alive',
            },
            timeout: 10000
        });

        const cookies = res.headers['set-cookie'];
        if (cookies) {
            nseSession.cookies   = cookies
                .map(c => c.split(';')[0])
                .join('; ');
            nseSession.lastFetch = now;
            console.log('NSE cookies refreshed ✅');
        }
    } catch (err) {
        console.error('NSE cookie fetch failed:', err.message);
    }
    return nseSession.cookies;
}

// ── Fetch PCR from NSE Option Chain ───────────────────
async function fetchPCR() {
    try {
        const cookies = await getNSECookies();

        const res = await axios.get(
            'https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY',
            {
                headers: {
                    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                    'Accept'         : 'application/json, text/plain, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Referer'        : 'https://www.nseindia.com/option-chain',
                    'Cookie'         : cookies,
                    'Connection'     : 'keep-alive',
                    'sec-fetch-dest' : 'empty',
                    'sec-fetch-mode' : 'cors',
                    'sec-fetch-site' : 'same-origin',
                },
                timeout: 10000
            }
        );

        const data    = res.data;
        const records = data?.records?.data;

        if (!records) {
            console.log('PCR: No option chain data');
            return null;
        }

        // Calculate total PCR
        let totalCallOI = 0;
        let totalPutOI  = 0;

        // Calculate ATM PCR
        const atmPrice  = data?.records?.underlyingValue;
        const atmStrike = atmPrice
            ? Math.round(atmPrice / 50) * 50
            : null;

        let atmCallOI = 0;
        let atmPutOI  = 0;

        records.forEach(item => {
            const ce = item?.CE?.openInterest || 0;
            const pe = item?.PE?.openInterest || 0;

            totalCallOI += ce;
            totalPutOI  += pe;

            // ATM ±2 strikes
            if (atmStrike && Math.abs(item.strikePrice - atmStrike) <= 100) {
                atmCallOI += ce;
                atmPutOI  += pe;
            }
        });

        const pcr    = totalCallOI > 0
            ? parseFloat((totalPutOI / totalCallOI).toFixed(2))
            : null;

        const atmPcr = atmCallOI > 0
            ? parseFloat((atmPutOI / atmCallOI).toFixed(2))
            : null;

        // PCR interpretation
        function pcrSignal(val) {
            if (val === null) return 'N/A';
            if (val > 1.5)   return 'BULLISH';
            if (val < 0.7)   return 'BEARISH';
            return 'NEUTRAL';
        }

        console.log(`PCR: ${pcr} (${pcrSignal(pcr)}) | ATM PCR: ${atmPcr}`);

        return {
            pcr,
            atmPcr,
            totalCallOI,
            totalPutOI,
            pcrSignal   : pcrSignal(pcr),
            atmPcrSignal: pcrSignal(atmPcr),
            atmStrike,
            underlyingValue: atmPrice
        };

    } catch (err) {
        console.error('PCR fetch error:', err.message);
        return null;
    }
}

// ── Fetch India VIX from Yahoo Finance ────────────────
async function fetchVIX() {
    try {
        const res = await axios.get(
            'https://query1.finance.yahoo.com/v8/finance/chart/%5EINDIAVIX?interval=1m&range=1d',
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept'    : 'application/json'
                },
                timeout: 8000
            }
        );

        const meta = res.data?.chart?.result?.[0]?.meta;
        if (!meta) return null;

        const vix       = parseFloat(meta.regularMarketPrice.toFixed(2));
        const prevClose = meta.previousClose;
        const change    = parseFloat((vix - prevClose).toFixed(2));

        // VIX interpretation
        function vixSignal(v) {
            if (v < 12)  return { signal: 'VERY LOW',  color: 'green',  note: 'Market complacent' };
            if (v < 15)  return { signal: 'LOW',       color: 'green',  note: 'Normal market' };
            if (v < 20)  return { signal: 'MODERATE',  color: 'yellow', note: 'Some uncertainty' };
            if (v < 25)  return { signal: 'HIGH',      color: 'orange', note: 'Elevated fear' };
            if (v < 30)  return { signal: 'VERY HIGH', color: 'red',    note: 'Reduce qty 50%' };
            return         { signal: 'EXTREME',        color: 'red',    note: 'Avoid trading' };
        }

        // Strike range based on VIX
        function strikeRange(v) {
            if (v < 15)  return 'ATM ±150';
            if (v < 20)  return 'ATM ±200';
            if (v < 25)  return 'ATM ±250';
            if (v < 30)  return 'ATM ±300 (50% qty)';
            return               'AVOID';
        }

        const info = vixSignal(vix);

        console.log(`VIX: ${vix} (${change >= 0 ? '+' : ''}${change}) — ${info.signal}`);

        return {
            vix,
            prevClose,
            change,
            changePct  : parseFloat(((change / prevClose) * 100).toFixed(2)),
            signal     : info.signal,
            note       : info.note,
            color      : info.color,
            strikeRange: strikeRange(vix)
        };

    } catch (err) {
        console.error('VIX fetch error:', err.message);
        return null;
    }
}

// ── Combined Market Data ──────────────────────────────
async function fetchMarketData() {
    const [pcrData, vixData] = await Promise.all([
        fetchPCR(),
        fetchVIX()
    ]);

    return { pcrData, vixData };
}

module.exports = { fetchMarketData };
