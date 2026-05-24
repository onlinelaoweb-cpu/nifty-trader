/**
 * nseData.js
 * Auto-fetches PCR (total + ATM) from NSE live option chain.
 *
 * NSE blocks requests without a valid browser session cookie.
 * Strategy: GET nseindia.com first → capture Set-Cookie → use for API call.
 * Cookie is cached and reused; refreshed only when a 401/403 is received.
 */

const axios = require('axios');

// ── Config ────────────────────────────────────────────
const BASE_URL    = 'https://www.nseindia.com';
const OC_URL      = `${BASE_URL}/api/option-chain-indices?symbol=NIFTY`;
const TIMEOUT_MS  = 12000;

const HEADERS = {
    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept'         : 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer'        : 'https://www.nseindia.com/option-chain',
    'Connection'     : 'keep-alive',
    'DNT'            : '1',
};

// ── Cookie cache ──────────────────────────────────────
let _cookie        = null;
let _cookieAt      = 0;
const COOKIE_TTL   = 15 * 60 * 1000; // refresh cookie every 15 min

async function refreshCookie() {
    try {
        const res = await axios.get(BASE_URL, {
            headers : { ...HEADERS, Accept: 'text/html' },
            timeout : TIMEOUT_MS,
            maxRedirects: 3,
        });
        const raw = res.headers['set-cookie'];
        if (raw && raw.length) {
            // Join all cookie name=value pairs, strip attributes
            _cookie  = raw.map(c => c.split(';')[0]).join('; ');
            _cookieAt = Date.now();
            console.log('🍪 NSE cookie refreshed');
            return true;
        }
    } catch (e) {
        console.error('NSE cookie refresh failed:', e.message);
    }
    return false;
}

async function getCookie() {
    if (!_cookie || Date.now() - _cookieAt > COOKIE_TTL) {
        await refreshCookie();
    }
    return _cookie;
}

// ── Expiry detection ──────────────────────────────────
// Nifty weekly options expire every Tuesday (IST).
function isExpiryDay() {
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return ist.getDay() === 2;   // 0=Sun … 2=Tue … 6=Sat
}

// ── Max pain calculation ──────────────────────────────
// For every candidate settlement price S (each listed strike),
// compute the total rupee loss that option WRITERS would suffer:
//   call writers lose (S − K) × CE_OI  when S > K
//   put  writers lose (K − S) × PE_OI  when S < K
// The strike with the MINIMUM total writer loss is max pain —
// that is where the price is most likely to gravitate on expiry.
function calcMaxPain(records) {
    if (!Array.isArray(records) || records.length < 5) return null;

    // Build a strike → { ceOI, peOI } map from every row in the chain
    const oiMap = {};
    for (const row of records) {
        const strike = row.strikePrice;
        if (!strike) continue;
        oiMap[strike] = {
            ceOI: row.CE?.openInterest || 0,
            peOI: row.PE?.openInterest || 0
        };
    }
    const strikes = Object.keys(oiMap).map(Number).sort((a, b) => a - b);
    if (strikes.length < 3) return null;

    let minPain = Infinity, maxPainStrike = null;

    for (const S of strikes) {
        let totalPain = 0;
        for (const K of strikes) {
            const { ceOI, peOI } = oiMap[K];
            if (S > K) totalPain += (S - K) * ceOI;   // call writer loss
            if (S < K) totalPain += (K - S) * peOI;   // put  writer loss
        }
        if (totalPain < minPain) {
            minPain        = totalPain;
            maxPainStrike  = S;
        }
    }

    return {
        strike   : maxPainStrike,
        totalPain: minPain          // raw ₹ exposure — useful for gauging confidence
    };
}

// ── PCR calculation helpers ───────────────────────────
function calcATMStrike(spotPrice) {
    return Math.round(spotPrice / 50) * 50;
}

function parsePCR(data, spotPrice) {
    const records = data?.records?.data;
    if (!Array.isArray(records) || records.length === 0) return null;

    const atm          = calcATMStrike(spotPrice);
    let totalCEoi = 0, totalPEoi = 0;
    let atmCEoi   = 0, atmPEoi   = 0;
    let atmCEpremium = null, atmPEpremium = null;

    for (const row of records) {
        const ce = row.CE, pe = row.PE;
        if (ce?.openInterest) totalCEoi += ce.openInterest;
        if (pe?.openInterest) totalPEoi += pe.openInterest;

        if (row.strikePrice === atm) {
            if (ce) {
                atmCEoi      = ce.openInterest  || 0;
                atmCEpremium = ce.lastPrice      || null;
            }
            if (pe) {
                atmPEoi      = pe.openInterest  || 0;
                atmPEpremium = pe.lastPrice      || null;
            }
        }
    }

    const pcr    = totalCEoi > 0 ? parseFloat((totalPEoi / totalCEoi).toFixed(2)) : null;
    const atmPcr = atmCEoi  > 0 ? parseFloat((atmPEoi  / atmCEoi).toFixed(2))  : null;

    const maxPain = calcMaxPain(records);

    return { pcr, atmPcr, atm, atmCEpremium, atmPEpremium, totalCEoi, totalPEoi, maxPain, expiryDay: isExpiryDay() };
}

// ── Main export ───────────────────────────────────────
/**
 * fetchNSEPcr(spotPrice)
 * Returns: { pcr, atmPcr, atm, atmCEpremium, atmPEpremium } or null on failure.
 */
async function fetchNSEPcr(spotPrice) {
    if (!spotPrice || spotPrice <= 0) return null;

    const cookie = await getCookie();
    if (!cookie) {
        console.warn('NSE: no cookie — skipping PCR fetch');
        return null;
    }

    try {
        const res = await axios.get(OC_URL, {
            headers : { ...HEADERS, Cookie: cookie },
            timeout : TIMEOUT_MS,
        });

        if (res.status === 401 || res.status === 403) {
            // Cookie expired — force refresh and try once more
            console.warn('NSE: session expired, re-authenticating...');
            _cookie = null;
            const newCookie = await getCookie();
            if (!newCookie) return null;
            const retry = await axios.get(OC_URL, {
                headers : { ...HEADERS, Cookie: newCookie },
                timeout : TIMEOUT_MS,
            });
            return parsePCR(retry.data, spotPrice);
        }

        const result = parsePCR(res.data, spotPrice);
        if (result?.pcr) {
            console.log(`📊 NSE PCR: ${result.pcr} | ATM PCR: ${result.atmPcr} | ATM: ${result.atm}`);
        }
        return result;

    } catch (e) {
        // 401/403 thrown as error by axios
        if (e.response?.status === 401 || e.response?.status === 403) {
            console.warn('NSE: 401/403 — clearing cookie');
            _cookie = null;
        } else {
            console.error('NSE PCR fetch error:', e.message);
        }
        return null;
    }
}

module.exports = { fetchNSEPcr, isExpiryDay };
