/**
 * nseData.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Auto-fetches from NSE every N minutes:
 *   • PCR (total chain + ATM) + Max Pain   via option-chain-indices
 *   • FII / DII cash-market net flows       via fiidiiTradeReact
 *
 * NSE blocks cold requests without a valid browser session cookie.
 * Strategy: GET nseindia.com → capture Set-Cookie → reuse for all API calls.
 * Cookie is refreshed proactively every 15 min AND on any 401/403.
 *
 * Both datasets hold their last-good value across transient failures so
 * combineSignals() always has something to work with.
 *
 * Exports
 * ───────
 *   startNSEScheduler(getSpotPrice)   call once at server startup
 *   getPCRState()                     latest PCR snapshot + metadata
 *   getFIIState()                     latest FII/DII snapshot + metadata
 *   getOIBuildupState()               latest OI Buildup snapshot + metadata
 *   getEarlyMomState()                latest Early Momentum snapshot + metadata
 *   interpretPCR(pcr)                 → { signal, strength, label }
 *   interpretFII(netFII, netDII)      → { signal, strength, label }
 *   interpretOIBuildup(state)         → { signal, strength, label }
 *   interpretEarlyMomentum(state)     → { score, signal, strength, label, votes }
 *   isExpiryDay()                     true on Nifty weekly expiry (Tuesday)
 *
 * Early Momentum — WHY IT'S FASTER
 * ─────────────────────────────────
 * Root causes of late signals in the old implementation:
 *   1. Ignored NSE's native changeinOpenInterest (intraday Δ, available cycle 1).
 *      Was computing OI diff manually → needed 2 cycles (6 min) to warm up.
 *   2. No premium velocity — LTP moves 30–60s BEFORE OI changes.
 *   3. No order-book pressure — totalBuyQty/totalSellQty per strike ignored.
 *   4. No IV skew — impliedVolatility per row ignored.
 *   5. ATM-only PCR misses cluster effect; ATM ±100pt is far more sensitive.
 *
 * Fix: 7-vote scoring system (range −5 to +5) using all the above.
 */

'use strict';
const axios = require('axios');

// ═══════════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════════

const BASE_URL   = 'https://www.nseindia.com';
const OC_URL     = `${BASE_URL}/api/option-chain-indices?symbol=NIFTY`;
const FIIDII_URL = `${BASE_URL}/api/fiidiiTradeReact`;
const TIMEOUT_MS = 12_000;   // 12s — enough for slow NSE responses from Railway; retry handles timeouts

const PCR_INTERVAL_MS    =  6 * 60 * 1000;   // re-fetch PCR every 6 min (ScraperAPI free tier: ~1375 calls/month)
const FIIDII_INTERVAL_MS = 15 * 60 * 1000;   // re-fetch FII/DII every 15 min
const COOKIE_TTL_MS      = 15 * 60 * 1000;   // proactive cookie re-warm

// ── ScraperAPI proxy config ───────────────────────────────────────────────────
// Railway US-West IPs get rate-limited by NSE within minutes of market open.
// ScraperAPI rotates residential IPs + handles cookies automatically.
// Free tier: 1000 calls/month → enough for PCR (3 min interval × 6.5 hr × 22 days ≈ 2860)
// So use SCRAPER_TIER=basic (₹0 free) for PCR only; direct for FII/DII (15 min = manageable).
//
// Setup: Add SCRAPERAPI_KEY=your_key to Railway env vars.
// Get free key at: https://scraperapi.com (no card needed for free tier)
//
// Fallback: if key not set, tries direct NSE (may timeout on Railway)
const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY || null;
const SCRAPERAPI_BASE = 'https://api.scraperapi.com';

// FII/DII uses a longer timeout because Railway→NSE latency spikes more on this endpoint
const FIIDII_TIMEOUT_MS  = 20_000;   // 20s dedicated timeout for FII/DII

// NSE will 403 any request that doesn't look like a real browser.
// Chrome 130 UA + sec-fetch + sec-ch-ua headers required (2026 anti-scraping update).
const HEADERS = {
    'User-Agent'        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept'            : 'application/json, text/plain, */*',
    'Accept-Language'   : 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding'   : 'gzip, deflate, br',
    'Referer'           : 'https://www.nseindia.com/option-chain',
    'Connection'        : 'keep-alive',
    'DNT'               : '1',
    'sec-fetch-dest'    : 'empty',
    'sec-fetch-site'    : 'same-origin',
    'sec-fetch-mode'    : 'cors',
    'sec-ch-ua'         : '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    'sec-ch-ua-mobile'  : '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Cache-Control'     : 'no-cache',
    'Pragma'            : 'no-cache',
};

// ═══════════════════════════════════════════════════════════════════════════════
// Cookie management
// ═══════════════════════════════════════════════════════════════════════════════

let _cookie   = null;
let _cookieAt = 0;

async function refreshCookie() {
    try {
        const res = await axios.get(BASE_URL, {
            headers        : { ...HEADERS, Accept: 'text/html' },
            timeout        : 10_000,   // fail fast — 10 s matches spec
            maxRedirects   : 3,
            // Don't throw on 4xx so we can inspect the response
            validateStatus : s => s < 500,
        });
        const raw = res.headers['set-cookie'];
        if (raw && raw.length) {
            _cookie   = raw.map(c => c.split(';')[0]).join('; ');
            _cookieAt = Date.now();
            console.log('🍪 NSE cookie refreshed');
            return true;
        }
        console.warn('NSE cookie: homepage returned no Set-Cookie headers');
    } catch (e) {
        console.error('NSE cookie refresh failed:', e.message);
    }
    return false;
}

async function getCookie() {
    if (!_cookie || Date.now() - _cookieAt > COOKIE_TTL_MS) {
        await refreshCookie();
    }
    return _cookie;
}

// ── Shared axios wrapper with validateStatus so 403s don't throw ──────────────
// BUG FIX: original code had `if (res.status === 403)` after a plain axios.get,
// but axios throws on 4xx by default — that branch was never reached.
// Now we set validateStatus: () => true so we always get a response object back.
async function nseGet(url, extraHeaders = {}) {
    const cookie = await getCookie();
    return axios.get(url, {
        headers        : { ...HEADERS, ...extraHeaders, Cookie: cookie },
        timeout        : TIMEOUT_MS,
        validateStatus : () => true,   // ← never throw on HTTP error codes
    });
}

// Handles the 401/403 → re-warm → retry pattern in one place
async function nseGetWithRetry(url) {
    let res = await nseGet(url);

    if (res.status === 401 || res.status === 403) {
        console.warn(`NSE: ${res.status} on ${url} — re-authenticating...`);
        _cookie = null;
        await refreshCookie();
        res = await nseGet(url);   // one retry with fresh cookie
    }

    return res;
}

// ── ScraperAPI fetch — bypasses NSE IP rate-limit ────────────────────────────
// ScraperAPI handles cookies + residential IP rotation automatically.
// Returns parsed JSON data directly (not an axios response object).
// Returns null on failure so caller can fall back to direct NSE.
async function scraperAPIFetch(targetUrl) {
    if (!SCRAPERAPI_KEY) return null;
    try {
        const apiUrl = `${SCRAPERAPI_BASE}/?api_key=${SCRAPERAPI_KEY}&url=${encodeURIComponent(targetUrl)}&keep_headers=true`;
        const res = await axios.get(apiUrl, {
            timeout        : 30_000,   // ScraperAPI can be slow — 30s
            validateStatus : () => true,
            headers        : { ...HEADERS },
        });
        if (res.status !== 200) {
            console.warn(`[ScraperAPI] HTTP ${res.status} for ${targetUrl}`);
            return null;
        }
        // NSE returns JSON; scraperAPI passes it through
        const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        return data;
    } catch (e) {
        console.warn(`[ScraperAPI] Fetch failed: ${e.message}`);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function isExpiryDay() {
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return ist.getDay() === 2;   // Tuesday
}

function calcATMStrike(spotPrice) {
    return Math.round(spotPrice / 50) * 50;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Max Pain
// ═══════════════════════════════════════════════════════════════════════════════

function calcMaxPain(records) {
    if (!Array.isArray(records) || records.length < 5) return null;

    const oiMap = {};
    for (const row of records) {
        const strike = row.strikePrice;
        if (!strike) continue;
        oiMap[strike] = {
            ceOI: row.CE?.openInterest || 0,
            peOI: row.PE?.openInterest || 0,
        };
    }
    const strikes = Object.keys(oiMap).map(Number).sort((a, b) => a - b);
    if (strikes.length < 3) return null;

    let minPain = Infinity, maxPainStrike = null;
    for (const S of strikes) {
        let totalPain = 0;
        for (const K of strikes) {
            const { ceOI, peOI } = oiMap[K];
            if (S > K) totalPain += (S - K) * ceOI;
            if (S < K) totalPain += (K - S) * peOI;
        }
        if (totalPain < minPain) { minPain = totalPain; maxPainStrike = S; }
    }
    return { strike: maxPainStrike, totalPain: minPain };
}

// ═══════════════════════════════════════════════════════════════════════════════
// OI Buildup — state + logic
// ═══════════════════════════════════════════════════════════════════════════════
//
// OI Buildup matrix (options chain perspective):
//
//   CE OI ↑  → call writers adding positions → bearish (resistance building)
//   CE OI ↓  → call unwinding               → bullish (resistance weakening)
//   PE OI ↑  → put writers adding positions → bullish (support building)
//   PE OI ↓  → put unwinding               → bearish (support weakening)
//
// PCR change reinforces or diverges from the OI delta signal.
//
// Key levels derived from absolute OI:
//   Strike with highest CE OI  → major resistance (call wall)
//   Strike with highest PE OI  → major support    (put wall)
//
// Strike with biggest OI addition this cycle → fresh smart-money activity.

const _oiBuildup = {
    // Aggregate OI deltas vs previous fetch
    totalCEoiChange  : null,
    totalPEoiChange  : null,
    pcrChange        : null,   // pcr delta since last cycle

    // Key strike levels
    maxCEoiStrike    : null,   // call wall (resistance)
    maxPEoiStrike    : null,   // put wall  (support)
    maxCEoiVal       : null,   // OI at call wall
    maxPEoiVal       : null,   // OI at put wall

    // Strike with biggest new OI addition this cycle
    maxCEoiAddStrike : null,
    maxPEoiAddStrike : null,
    maxCEoiAdd       : null,
    maxPEoiAdd       : null,

    // Top-5 most active buildup strikes (for UI tables)
    topCEbuildup     : [],   // [{ strike, ceOI, ceOIChange }, ...]
    topPEbuildup     : [],   // [{ strike, peOI, peOIChange }, ...]

    // Interpreted signal
    signal           : 'NEUTRAL',
    strength         : 0,
    label            : 'OI Buildup — awaiting data',

    fetchedAt        : null,
    prevFetchedAt    : null,
    fetchCount       : 0,
    lastError        : null,
};

// Previous-cycle snapshots for delta calculation
let _prevStrikeOI = {};   // { [strike]: { ceOI, peOI } }
let _prevPCR      = null;

/**
 * calcOIBuildup(records, currentPCR)
 * Called inside _fetchPCR after a successful option-chain parse.
 * Mutates _prevStrikeOI and _prevPCR so the NEXT cycle has a baseline.
 */
function calcOIBuildup(records, currentPCR) {
    if (!Array.isArray(records) || records.length === 0) return null;

    // ── Build current strike map ──────────────────────────────────────────────
    const currMap = {};
    for (const row of records) {
        const s = row.strikePrice;
        if (!s) continue;
        currMap[s] = {
            ceOI: row.CE?.openInterest || 0,
            peOI: row.PE?.openInterest || 0,
        };
    }

    // ── Compute deltas ────────────────────────────────────────────────────────
    const hasPrev = Object.keys(_prevStrikeOI).length > 0;

    let totalCEoiChange = 0, totalPEoiChange = 0;
    let maxCEoiStrike = null, maxPEoiStrike = null;
    let maxCEoiVal = 0, maxPEoiVal = 0;
    let maxCEoiAddStrike = null, maxPEoiAddStrike = null;
    let maxCEoiAdd = -Infinity, maxPEoiAdd = -Infinity;

    const strikeRows = [];

    for (const [sStr, curr] of Object.entries(currMap)) {
        const s      = Number(sStr);
        const prev   = _prevStrikeOI[s] || { ceOI: curr.ceOI, peOI: curr.peOI };  // first fetch = 0 delta
        const ceDiff = hasPrev ? curr.ceOI - prev.ceOI : 0;
        const peDiff = hasPrev ? curr.peOI - prev.peOI : 0;

        totalCEoiChange += ceDiff;
        totalPEoiChange += peDiff;

        if (curr.ceOI > maxCEoiVal) { maxCEoiVal = curr.ceOI; maxCEoiStrike = s; }
        if (curr.peOI > maxPEoiVal) { maxPEoiVal = curr.peOI; maxPEoiStrike = s; }
        if (ceDiff    > maxCEoiAdd) { maxCEoiAdd = ceDiff;    maxCEoiAddStrike = s; }
        if (peDiff    > maxPEoiAdd) { maxPEoiAdd = peDiff;    maxPEoiAddStrike = s; }

        strikeRows.push({ strike: s, ceOI: curr.ceOI, peOI: curr.peOI, ceOIChange: ceDiff, peOIChange: peDiff });
    }

    // Top-5 CE buildup (largest CE OI addition this cycle)
    const topCEbuildup = [...strikeRows]
        .sort((a, b) => b.ceOIChange - a.ceOIChange)
        .slice(0, 5)
        .map(({ strike, ceOI, ceOIChange }) => ({ strike, ceOI, ceOIChange }));

    // Top-5 PE buildup (largest PE OI addition this cycle)
    const topPEbuildup = [...strikeRows]
        .sort((a, b) => b.peOIChange - a.peOIChange)
        .slice(0, 5)
        .map(({ strike, peOI, peOIChange }) => ({ strike, peOI, peOIChange }));

    const pcrChange = (hasPrev && _prevPCR !== null && currentPCR !== null)
        ? parseFloat((currentPCR - _prevPCR).toFixed(3))
        : null;

    // ── Persist for next cycle ────────────────────────────────────────────────
    // Deep-copy so mutations don't bleed through
    _prevStrikeOI = Object.fromEntries(
        Object.entries(currMap).map(([k, v]) => [k, { ...v }])
    );
    _prevPCR = currentPCR;

    return {
        totalCEoiChange  : Math.round(totalCEoiChange),
        totalPEoiChange  : Math.round(totalPEoiChange),
        pcrChange,
        maxCEoiStrike,
        maxPEoiStrike,
        maxCEoiVal       : Math.round(maxCEoiVal),
        maxPEoiVal       : Math.round(maxPEoiVal),
        maxCEoiAddStrike,
        maxPEoiAddStrike,
        maxCEoiAdd       : Math.round(maxCEoiAdd === -Infinity ? 0 : maxCEoiAdd),
        maxPEoiAdd       : Math.round(maxPEoiAdd === -Infinity ? 0 : maxPEoiAdd),
        topCEbuildup,
        topPEbuildup,
    };
}

/**
 * interpretOIBuildup({ totalCEoiChange, totalPEoiChange, pcrChange })
 *
 * Smart-money read:
 *   Put writers active (PE OI ↑)  → bullish (they sell puts = they expect market to hold/rise)
 *   Call writers active (CE OI ↑) → bearish (they sell calls = they expect market to cap/fall)
 *   PCR rising confirms bull; PCR falling confirms bear.
 *
 * Returns { signal: 'BULL'|'BEAR'|'NEUTRAL', strength: 0-2, label }
 */
function interpretOIBuildup({ totalCEoiChange, totalPEoiChange, pcrChange } = {}) {
    if (totalCEoiChange === null || totalPEoiChange === null)
        return { signal: 'NEUTRAL', strength: 0, label: 'OI Buildup — awaiting data' };

    const OI_THRESH  = 50_000;   // contracts — below this treat as noise
    const PCR_DELTA  = 0.02;     // minimum PCR move to be meaningful

    const peRising   = totalPEoiChange >  OI_THRESH;
    const peFalling  = totalPEoiChange < -OI_THRESH;
    const ceRising   = totalCEoiChange >  OI_THRESH;
    const ceFalling  = totalCEoiChange < -OI_THRESH;
    const pcrUp      = pcrChange !== null && pcrChange >  PCR_DELTA;
    const pcrDown    = pcrChange !== null && pcrChange < -PCR_DELTA;

    const fmt = v => {
        if (v === null) return 'N/A';
        const k = Math.round(v / 1000);
        return `${k >= 0 ? '+' : ''}${k}K`;
    };
    const pcrStr = pcrChange !== null
        ? ` | PCR Δ${pcrChange >= 0 ? '+' : ''}${pcrChange}`
        : '';
    const base = `PE OI Δ${fmt(totalPEoiChange)} | CE OI Δ${fmt(totalCEoiChange)}${pcrStr}`;

    // ── Strong BULL ───────────────────────────────────────────────────────────
    // Put writers adding big + PCR rising = maximum conviction support
    if (peRising && !ceRising && pcrUp)
        return { signal: 'BULL', strength: 2, label: `${base} — Put writing + PCR ↑ 🐂` };

    // CE unwinding (call writers exiting = resistance melting) + PCR rising
    if (ceFalling && !peFalling && pcrUp)
        return { signal: 'BULL', strength: 2, label: `${base} — Call unwinding + PCR ↑ 🐂` };

    // ── Mild BULL ─────────────────────────────────────────────────────────────
    if (peRising && !ceRising)
        return { signal: 'BULL', strength: 1, label: `${base} — Put writing active ✅` };

    if (ceFalling && !peFalling)
        return { signal: 'BULL', strength: 1, label: `${base} — Call unwinding ✅` };

    if (peRising && ceRising && pcrUp)
        return { signal: 'BULL', strength: 1, label: `${base} — Both writing, PCR ↑ (slight bull)` };

    // ── Strong BEAR ───────────────────────────────────────────────────────────
    if (ceRising && !peRising && pcrDown)
        return { signal: 'BEAR', strength: 2, label: `${base} — Call writing + PCR ↓ 🐻` };

    if (peFalling && !ceFalling && pcrDown)
        return { signal: 'BEAR', strength: 2, label: `${base} — Put unwinding + PCR ↓ 🐻` };

    // ── Mild BEAR ─────────────────────────────────────────────────────────────
    if (ceRising && !peRising)
        return { signal: 'BEAR', strength: 1, label: `${base} — Call writing active ⚠️` };

    if (peFalling && !ceFalling)
        return { signal: 'BEAR', strength: 1, label: `${base} — Put unwinding ⚠️` };

    if (ceRising && peRising && pcrDown)
        return { signal: 'BEAR', strength: 1, label: `${base} — Both writing, PCR ↓ (slight bear)` };

    // ── NEUTRAL ───────────────────────────────────────────────────────────────
    return { signal: 'NEUTRAL', strength: 0, label: `${base} — Low OI activity / mixed` };
}



// ═══════════════════════════════════════════════════════════════════════════════
// Early Momentum Detector
// ═══════════════════════════════════════════════════════════════════════════════
//
// SIGNAL SCORING — vote-based, range −9 to +9:
//
//   +1  NSE intraday PE OI Δ > CE OI Δ (whole chain, dynamic thr 10K–30K by session)
//   +1  ATM-cluster (±100pt) PE OI Δ > CE OI Δ        ← 5x more sensitive
//   +1  ATM CE premium velocity > +2.5% this cycle     ← LEADING: price before OI
//   −1  ATM PE premium velocity > +2.5% this cycle     ← LEADING: put demand
//   +1  ATM CE buy-pressure > 65% (order book)         ← LEADING: real-time orders
//   −1  ATM PE buy-pressure > 65% (order book)
//   +1  IV skew: CE IV > PE IV + 3  (call demand skew)
//   −1  IV skew: PE IV > CE IV + 3  (fear / put demand skew)
//   ±1  Strike OI Shift: dominant single-strike CE/PE buildup (Murarka primary read)
//   ±1  Wall Alignment: top-3 buildup strikes concentrated on same side
//
//   [CE/PE Velocity includes streak note after 2+ consecutive cycles]
//   [OI thresholds dynamically scale: 10K at open, 20K early, 30K mid-session]
//
//   score ≥ +4 → BULL strength 2   (⚡ Early CE momentum)
//   score +2/+3 → BULL strength 1  (↗ CE lean)
//   score 0/±1  → NEUTRAL
//   score −2/−3 → BEAR strength 1  (↘ PE lean)
//   score ≤ −4 → BEAR strength 2   (⚡ Early PE momentum)

const _earlyMom = {
    // NSE-native intraday OI deltas (available 
