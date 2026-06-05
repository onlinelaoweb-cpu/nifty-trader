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
// NSE option-chain URL — try multiple endpoints (NSE changes these periodically)
// Primary:   /api/option-chain-indices  (was working until mid-2026, now 404)
// Alternate: /api/option-chain-equities (sometimes works when indices returns 404)
// Mirror:    nsearchives subdomain (archive/delayed but better than nothing)
const OC_URLS = [
    `${BASE_URL}/api/option-chain-indices?symbol=NIFTY`,
    `${BASE_URL}/api/option-chain-equities?symbol=NIFTY`,
    `https://nsearchives.nseindia.com/content/fo/nifty_oc.json`,
];
const OC_URL = OC_URLS[0];  // kept for backward compat
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
// Strategy: render_js=false (NSE option-chain is a JSON API, not an HTML page —
// headless Chrome on a JSON endpoint returns HTML-wrapped JSON that fails parse).
// We pass the NSE session cookie we already have + country_code=in (India IP) +
// custom_headers=true so ScraperAPI forwards our browser headers to NSE.
// This satisfies NSE's two checks:
//   ① India IP      → country_code=in
//   ② Valid session → Cookie from our own refreshCookie() call
// Returns parsed JSON data directly. Returns null on failure.
// Track last ScraperAPI session warm timestamp
let _scraperSessionWarmedAt = 0;

async function scraperAPIFetch(targetUrl) {
    if (!SCRAPERAPI_KEY) return null;
    try {
        // NSE requires a 2-step session:
        // Step 1: Visit /option-chain HTML page to set the NSE session cookie
        // Step 2: Call the JSON API with that warmed session
        // We use session_number=1 so ScraperAPI reuses the same India IP session.
        // Warm once every 8 minutes (NSE session TTL ~10 min).
        const buildUrl = (target) =>
            `${SCRAPERAPI_BASE}/?api_key=${SCRAPERAPI_KEY}&url=${encodeURIComponent(target)}&render_js=false&country_code=in&session_number=1`;

        const nowMs = Date.now();
        if (nowMs - _scraperSessionWarmedAt > 8 * 60 * 1000) {
            // Warm the ScraperAPI session by visiting NSE option-chain page
            try {
                await axios.get(buildUrl('https://www.nseindia.com/option-chain'), {
                    timeout: 15_000, validateStatus: () => true,
                });
                _scraperSessionWarmedAt = nowMs;
                console.log('[ScraperAPI] Session warmed via /option-chain page');
            } catch (we) {
                console.warn('[ScraperAPI] Session warm failed:', we.message);
            }
        }

        // Now call the actual JSON API endpoints in order
        for (const ocUrl of OC_URLS) {
            try {
                const res = await axios.get(buildUrl(ocUrl), {
                    timeout: 35_000, validateStatus: () => true,
                });
                if (res.status !== 200) {
                    console.warn(`[ScraperAPI] HTTP ${res.status} for ${ocUrl.split('/').pop()}`);
                    continue;
                }
                const raw = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                if (raw?.records?.data) return raw;
                console.warn(`[ScraperAPI] Response missing records.data — status:200, body:${JSON.stringify(raw)?.slice(0,80)}`);
            } catch (e) {
                console.warn(`[ScraperAPI] Error on ${ocUrl.split('/').pop()}: ${e.message}`);
            }
        }
        return null;
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
    // NSE-native intraday OI deltas (available from fetch #1 — no warmup)
    intraCEoiChange   : null,   // sum of CE changeinOpenInterest, whole chain
    intraPEoiChange   : null,

    // ATM ±100pt cluster (5 strikes): 5× more sensitive than whole chain
    clusterCEoiChange : null,
    clusterPEoiChange : null,

    // Premium velocity — % LTP change vs previous cycle (LEADING signal)
    atmCEvelocity     : null,   // +ve = call buyers pushing CE price up
    atmPEvelocity     : null,   // +ve = put buyers pushing PE price up

    // Velocity streak (consecutive cycles in same direction)
    ceVelStreak       : 0,
    peVelStreak       : 0,

    // Order-book buy pressure at ATM (0–1 scale)
    atmCEbuyPressure  : null,   // totalBuyQty / (buyQty + sellQty) for CE
    atmPEbuyPressure  : null,

    // IV skew at ATM
    atmCEiv           : null,
    atmPEiv           : null,
    ivSkew            : null,   // PE IV − CE IV: +ve = fear/put-demand

    // Strike-by-strike OI shift (Murarka primary read)
    topCEbuildup      : [],     // [{strike, ceOI, ceOIChange}] top-5 CE additions
    topPEbuildup      : [],     // [{strike, peOI, peOIChange}] top-5 PE additions
    maxCEoiAddStrike  : null,   // strike with biggest CE OI addition this cycle
    maxPEoiAddStrike  : null,   // strike with biggest PE OI addition this cycle
    maxCEoiAdd        : null,
    maxPEoiAdd        : null,

    // Scoring output
    score             : null,   // −9 to +9
    signal            : 'NEUTRAL',
    strength          : 0,
    label             : 'Early Momentum — awaiting data',
    votes             : [],     // [{ name, vote, reason }] for transparency

    fetchedAt         : null,
    fetchCount        : 0,
    lastError         : null,
};

// Store previous ATM premiums for velocity calculation
let _prevATMce = null;
let _prevATMpe = null;

// Velocity streak tracking — consecutive cycles in same direction
let _ceVelStreak = 0;   // +ve = consecutive bullish cycles, -ve = bearish
let _peVelStreak = 0;

/**
 * getDynamicOIThreshold()
 * Returns a time-of-day-adjusted OI threshold for whole-chain signals.
 * Market open (9:15–9:45): very thin OI changes → use 10K
 * Early session (9:45–10:30): building momentum → 20K
 * Mid session (10:30–14:00): normal → 30K
 * Late session (14:00–15:30): can be thicker or noise → 25K
 */
function getDynamicOIThreshold() {
    const ist  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const hhmm = ist.getHours() * 60 + ist.getMinutes();
    if (hhmm < 9 * 60 + 45)  return 10_000;   // 9:15–9:45 open
    if (hhmm < 10 * 60 + 30) return 20_000;   // 9:45–10:30 early
    if (hhmm < 14 * 60)      return 30_000;   // 10:30–14:00 normal
    return 25_000;                              // 14:00–15:30 late
}

/**
 * getDynamicClusterThreshold()
 * ATM-cluster threshold also scales with time of day.
 */
function getDynamicClusterThreshold() {
    const ist  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const hhmm = ist.getHours() * 60 + ist.getMinutes();
    if (hhmm < 9 * 60 + 45)  return 2_000;
    if (hhmm < 10 * 60 + 30) return 4_000;
    return 6_000;
}

/**
 * parseEarlyMomentum(records, atm)
 * Extracts all early-signal data from a single option-chain response.
 * Called every PCR cycle with the raw records array and current ATM strike.
 */
function parseEarlyMomentum(records, atm) {
    if (!Array.isArray(records) || records.length === 0 || !atm) return null;

    // ATM ±100pt cluster (5 strikes at 50pt spacing)
    const cluster = new Set([atm - 100, atm - 50, atm, atm + 50, atm + 100]);

    let intraCEoiChange = 0, intraPEoiChange = 0;
    let clusterCEoiChange = 0, clusterPEoiChange = 0;
    let atmCEltp = null, atmPEltp = null;
    let atmCEiv = null, atmPEiv = null;
    let atmCEbuyPressure = null, atmPEbuyPressure = null;

    for (const row of records) {
        const s  = row.strikePrice;
        const ce = row.CE;
        const pe = row.PE;

        // ── 1. NSE-native intraday OI Δ (whole chain) ────────────────────────
        // changeinOpenInterest = today's OI − yesterday's close OI (NSE calculates)
        if (ce?.changeinOpenInterest) intraCEoiChange += ce.changeinOpenInterest;
        if (pe?.changeinOpenInterest) intraPEoiChange += pe.changeinOpenInterest;

        // ── 2. ATM-cluster intraday OI Δ ─────────────────────────────────────
        if (cluster.has(s)) {
            if (ce?.changeinOpenInterest) clusterCEoiChange += ce.changeinOpenInterest;
            if (pe?.changeinOpenInterest) clusterPEoiChange += pe.changeinOpenInterest;
        }

        // ── 3. ATM-only metrics ───────────────────────────────────────────────
        if (s === atm) {
            // Premium (LTP) for velocity
            if (ce) atmCEltp = ce.lastPrice  || null;
            if (pe) atmPEltp = pe.lastPrice  || null;

            // Implied volatility for skew
            if (ce) atmCEiv = ce.impliedVolatility || null;
            if (pe) atmPEiv = pe.impliedVolatility || null;

            // Order-book buy pressure
            if (ce) {
                const b = ce.totalBuyQuantity  || 0;
                const s_ = ce.totalSellQuantity || 0;
                if (b + s_ > 0) atmCEbuyPressure = parseFloat((b / (b + s_)).toFixed(3));
            }
            if (pe) {
                const b = pe.totalBuyQuantity  || 0;
                const s_ = pe.totalSellQuantity || 0;
                if (b + s_ > 0) atmPEbuyPressure = parseFloat((b / (b + s_)).toFixed(3));
            }
        }
    }

    // ── 4. Premium velocity (% change vs last cycle) ──────────────────────────
    // First cycle: _prevATMce/_prevATMpe are null → velocity = null (safe)
    const atmCEvelocity = (_prevATMce && atmCEltp && _prevATMce > 0)
        ? parseFloat((((atmCEltp - _prevATMce) / _prevATMce) * 100).toFixed(2))
        : null;
    const atmPEvelocity = (_prevATMpe && atmPEltp && _prevATMpe > 0)
        ? parseFloat((((atmPEltp - _prevATMpe) / _prevATMpe) * 100).toFixed(2))
        : null;

    // ── 5. Velocity streak tracking ──────────────────────────────────────────
    // Count consecutive cycles where velocity has same sign — persistence matters
    if (atmCEvelocity !== null) {
        if (atmCEvelocity > 0) _ceVelStreak = Math.max(0, _ceVelStreak) + 1;
        else if (atmCEvelocity < 0) _ceVelStreak = Math.min(0, _ceVelStreak) - 1;
        else _ceVelStreak = 0;
    }
    if (atmPEvelocity !== null) {
        if (atmPEvelocity > 0) _peVelStreak = Math.max(0, _peVelStreak) + 1;
        else if (atmPEvelocity < 0) _peVelStreak = Math.min(0, _peVelStreak) - 1;
        else _peVelStreak = 0;
    }

    const ivSkew = (atmPEiv !== null && atmCEiv !== null)
        ? parseFloat((atmPEiv - atmCEiv).toFixed(2))
        : null;

    // Persist premiums for next cycle velocity calculation
    if (atmCEltp) _prevATMce = atmCEltp;
    if (atmPEltp) _prevATMpe = atmPEltp;

    return {
        intraCEoiChange   : Math.round(intraCEoiChange),
        intraPEoiChange   : Math.round(intraPEoiChange),
        clusterCEoiChange : Math.round(clusterCEoiChange),
        clusterPEoiChange : Math.round(clusterPEoiChange),
        atmCEvelocity,
        atmPEvelocity,
        ceVelStreak       : _ceVelStreak,
        peVelStreak       : _peVelStreak,
        atmCEbuyPressure,
        atmPEbuyPressure,
        atmCEiv,
        atmPEiv,
        ivSkew,
    };
}

/**
 * interpretEarlyMomentum(state)
 * Vote-based scoring: each signal casts +1 (bull) or −1 (bear).
 * Returns { score, signal, strength, label, votes }
 */
function interpretEarlyMomentum(state = {}) {
    const {
        intraCEoiChange, intraPEoiChange,
        clusterCEoiChange, clusterPEoiChange,
        atmCEvelocity, atmPEvelocity,
        atmCEbuyPressure, atmPEbuyPressure,
        ivSkew,
        // Strike-by-strike shift analysis (Murarka primary read)
        topCEbuildup, topPEbuildup,
        maxCEoiAddStrike, maxPEoiAddStrike,
        maxCEoiAdd, maxPEoiAdd,
        ceVelStreak, peVelStreak,
    } = state;

    if (intraCEoiChange === null && intraPEoiChange === null)
        return { score: 0, signal: 'NEUTRAL', strength: 0,
                 label: 'Early Momentum — awaiting data', votes: [] };

    // ── Dynamic thresholds — scale with time of day ───────────────────────────
    const OI_CHAIN   = getDynamicOIThreshold();   // 10K→20K→30K by session
    const OI_CLUSTER = getDynamicClusterThreshold(); // 2K→4K→6K by session
    const VEL_MIN    = 2.5;      // % premium change per cycle (was 5 — too rare)
    const STREAK_MIN = 2;        // consecutive cycles before streak bonus
    const BP_MIN     = 0.65;     // buy-pressure threshold (65%)
    const IV_MIN     = 3;        // minimum IV skew difference to matter
    const STRIKE_ADD_MIN = 5_000; // min single-strike OI add to count as signal

    const votes = [];

    // ── Vote 1: Whole-chain intraday OI (dynamic threshold) ──────────────────
    if (intraPEoiChange !== null && intraCEoiChange !== null) {
        const diff = intraPEoiChange - intraCEoiChange;
        if (Math.abs(diff) >= OI_CHAIN) {
            const v = diff > 0 ? +1 : -1;
            const lbl = diff > 0
                ? `PE intra OI Δ+${Math.round(intraPEoiChange/1000)}K > CE Δ${Math.round(intraCEoiChange/1000)}K (thr ${OI_CHAIN/1000}K)`
                : `CE intra OI Δ+${Math.round(intraCEoiChange/1000)}K > PE Δ${Math.round(intraPEoiChange/1000)}K (thr ${OI_CHAIN/1000}K)`;
            votes.push({ name: 'Chain OI Δ', vote: v, reason: lbl });
        }
    }

    // ── Vote 2: ATM-cluster OI (dynamic threshold) ────────────────────────────
    if (clusterPEoiChange !== null && clusterCEoiChange !== null) {
        const diff = clusterPEoiChange - clusterCEoiChange;
        if (Math.abs(diff) >= OI_CLUSTER) {
            const v = diff > 0 ? +1 : -1;
            const lbl = diff > 0
                ? `ATM±100 PE Δ+${Math.round(clusterPEoiChange/1000)}K > CE Δ${Math.round(clusterCEoiChange/1000)}K`
                : `ATM±100 CE Δ+${Math.round(clusterCEoiChange/1000)}K > PE Δ${Math.round(clusterPEoiChange/1000)}K`;
            votes.push({ name: 'ATM Cluster OI', vote: v, reason: lbl });
        }
    }

    // ── Vote 3: CE premium velocity (LEADING) — 2.5% threshold ──────────────
    if (atmCEvelocity !== null && Math.abs(atmCEvelocity) >= VEL_MIN) {
        const v = atmCEvelocity > 0 ? +1 : -1;
        const streakNote = ceVelStreak && Math.abs(ceVelStreak) >= STREAK_MIN
            ? ` [${Math.abs(ceVelStreak)}-cycle streak]` : '';
        votes.push({ name: 'CE Velocity', vote: v,
            reason: `ATM CE LTP ${atmCEvelocity > 0 ? '+' : ''}${atmCEvelocity}%/cycle${streakNote}` });
    }

    // ── Vote 4: PE premium velocity (LEADING) — 2.5% threshold ──────────────
    // PE premium rising = put buyers active = bearish; PE falling = puts abandoned = bullish
    if (atmPEvelocity !== null && Math.abs(atmPEvelocity) >= VEL_MIN) {
        const v = atmPEvelocity > 0 ? -1 : +1;
        const streakNote = peVelStreak && Math.abs(peVelStreak) >= STREAK_MIN
            ? ` [${Math.abs(peVelStreak)}-cycle streak]` : '';
        votes.push({ name: 'PE Velocity', vote: v,
            reason: `ATM PE LTP ${atmPEvelocity > 0 ? '+' : ''}${atmPEvelocity}%/cycle${streakNote}` });
    }

    // ── Vote 5: CE order-book buy pressure (LEADING) ──────────────────────────
    if (atmCEbuyPressure !== null && atmCEbuyPressure >= BP_MIN) {
        votes.push({ name: 'CE Buy Pressure', vote: +1,
            reason: `CE buyers ${Math.round(atmCEbuyPressure * 100)}% of orders` });
    }

    // ── Vote 6: PE order-book buy pressure (LEADING) ──────────────────────────
    if (atmPEbuyPressure !== null && atmPEbuyPressure >= BP_MIN) {
        votes.push({ name: 'PE Buy Pressure', vote: -1,
            reason: `PE buyers ${Math.round(atmPEbuyPressure * 100)}% of orders` });
    }

    // ── Vote 7: IV skew ───────────────────────────────────────────────────────
    if (ivSkew !== null) {
        if (ivSkew < -IV_MIN) {   // CE IV > PE IV = call demand = bullish
            votes.push({ name: 'IV Skew', vote: +1,
                reason: `CE IV elevated (skew ${ivSkew.toFixed(1)})` });
        } else if (ivSkew > IV_MIN) {   // PE IV > CE IV = fear/put demand = bearish
            votes.push({ name: 'IV Skew', vote: -1,
                reason: `Fear skew PE IV > CE IV by ${ivSkew.toFixed(1)}` });
        }
    }

    // ── Vote 8 (NEW): Strike-by-strike OI shift — Murarka primary read ────────
    // The single strike with the biggest OI addition tells you where smart money
    // is writing. CE add at one strike = resistance building there (bearish lean).
    // PE add at one strike = support being written there (bullish lean).
    const hasCEshift = maxCEoiAdd != null && maxCEoiAdd >= STRIKE_ADD_MIN;
    const hasPEshift = maxPEoiAdd != null && maxPEoiAdd >= STRIKE_ADD_MIN;
    if (hasCEshift || hasPEshift) {
        // If both are building, compare magnitude — dominant one wins
        if (hasCEshift && (!hasPEshift || maxCEoiAdd >= maxPEoiAdd)) {
            votes.push({ name: 'Strike OI Shift', vote: -1,
                reason: `Call writing at ${maxCEoiAddStrike}: +${Math.round(maxCEoiAdd/1000)}K CE OI (resistance)` });
        } else if (hasPEshift) {
            votes.push({ name: 'Strike OI Shift', vote: +1,
                reason: `Put writing at ${maxPEoiAddStrike}: +${Math.round(maxPEoiAdd/1000)}K PE OI (support)` });
        }
    }

    // ── Vote 9 (NEW): Top-5 buildup alignment ─────────────────────────────────
    // If top-3 buildup strikes are all same side (CE or PE), it's a strong wall
    if (Array.isArray(topCEbuildup) && topCEbuildup.length >= 3) {
        const top3CEadd = topCEbuildup.slice(0, 3).reduce((s, r) => s + (r.ceOIChange || 0), 0);
        const top3PEadd = Array.isArray(topPEbuildup)
            ? topPEbuildup.slice(0, 3).reduce((s, r) => s + (r.peOIChange || 0), 0) : 0;
        if (top3CEadd > top3PEadd * 1.5 && top3CEadd >= 15_000) {
            votes.push({ name: 'Wall Alignment', vote: -1,
                reason: `Top-3 CE buildup +${Math.round(top3CEadd/1000)}K (call wall forming)` });
        } else if (top3PEadd > top3CEadd * 1.5 && top3PEadd >= 15_000) {
            votes.push({ name: 'Wall Alignment', vote: +1,
                reason: `Top-3 PE buildup +${Math.round(top3PEadd/1000)}K (put wall = support)` });
        }
    }

    // ── Tally ─────────────────────────────────────────────────────────────────
    const score = votes.reduce((s, v) => s + v.vote, 0);
    const bullReasons = votes.filter(v => v.vote > 0).map(v => v.reason);
    const bearReasons = votes.filter(v => v.vote < 0).map(v => v.reason);

    let signal, strength, label;

    if (score >= 4) {
        signal = 'BULL'; strength = 2;
        label = `⚡ Early CE momentum: ${bullReasons.join(' · ')}`;
    } else if (score >= 2) {
        signal = 'BULL'; strength = 1;
        label = `↗ CE lean: ${bullReasons.join(' · ') || 'weak bull signals'}`;
    } else if (score <= -4) {
        signal = 'BEAR'; strength = 2;
        label = `⚡ Early PE momentum: ${bearReasons.join(' · ')}`;
    } else if (score <= -2) {
        signal = 'BEAR'; strength = 1;
        label = `↘ PE lean: ${bearReasons.join(' · ') || 'weak bear signals'}`;
    } else {
        signal = 'NEUTRAL'; strength = 0;
        label = `No directional edge (score ${score > 0 ? '+' : ''}${score})`;
    }

    return { score, signal, strength, label, votes };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PCR — state + fetch + schedule
// ═══════════════════════════════════════════════════════════════════════════════

const _pcr = {
    pcr         : null,
    atmPcr      : null,
    atm         : null,
    atmCEpremium: null,
    atmPEpremium: null,
    totalCEoi   : null,
    totalPEoi   : null,
    maxPain     : null,
    expiryDay   : false,
    fetchedAt   : null,
    lastError   : null,
    fetchCount  : 0,
};

function parsePCR(data, spotPrice) {
    const records = data?.records?.data;
    if (!Array.isArray(records) || records.length === 0) return null;

    const atm = calcATMStrike(spotPrice);
    let totalCEoi = 0, totalPEoi = 0;
    let atmCEoi = 0, atmPEoi = 0;
    let atmCEpremium = null, atmPEpremium = null;

    for (const row of records) {
        const ce = row.CE, pe = row.PE;
        if (ce?.openInterest) totalCEoi += ce.openInterest;
        if (pe?.openInterest) totalPEoi += pe.openInterest;
        if (row.strikePrice === atm) {
            if (ce) { atmCEoi = ce.openInterest || 0; atmCEpremium = ce.lastPrice || null; }
            if (pe) { atmPEoi = pe.openInterest || 0; atmPEpremium = pe.lastPrice || null; }
        }
    }

    const pcr    = totalCEoi > 0 ? parseFloat((totalPEoi / totalCEoi).toFixed(2)) : null;
    const atmPcr = atmCEoi  > 0 ? parseFloat((atmPEoi  / atmCEoi ).toFixed(2)) : null;
    const maxPain = calcMaxPain(records);

    return { pcr, atmPcr, atm, atmCEpremium, atmPEpremium, totalCEoi, totalPEoi, maxPain };
}

// ── Market hours guard ────────────────────────────────────────────────────────
// Returns true if current IST time is within 9:10–15:35 (5-min buffer either side)
function isMarketHours() {
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const istMin = ist.getHours() * 60 + ist.getMinutes();
    return istMin >= 550 && istMin <= 935;   // 9:10 to 15:35
}

async function _fetchPCR(spotPrice) {
    if (!spotPrice || spotPrice <= 0) return;
    // Skip PCR fetch entirely outside market hours — NSE returns 404/garbage pre/post market
    if (!isMarketHours()) {
        console.log('[PCR] Market closed — skipping PCR fetch');
        return;
    }

    try {
        let pcrData = null;

        // ── Path A: ScraperAPI with session warming + URL rotation ──────────
        if (SCRAPERAPI_KEY) {
            console.log('[PCR] Trying ScraperAPI...');
            pcrData = await scraperAPIFetch(OC_URLS[0]);  // internally tries all OC_URLS
            if (pcrData?.records?.data) {
                console.log('[PCR] ScraperAPI ✅');
            } else {
                console.warn('[PCR] ScraperAPI exhausted all URLs — falling back to direct NSE');
                pcrData = null;
            }
        }

        // ── Path B: Direct NSE with URL rotation ─────────────────────────────
        if (!pcrData) {
            try { await refreshCookie(); } catch (e) {
                console.warn('[PCR] Cookie refresh failed — proceeding anyway:', e.message);
            }

            for (const ocUrl of OC_URLS) {
                let res = await nseGetWithRetry(ocUrl);
                if (!res || res.status !== 200) {
                    console.warn(`[PCR] Direct NSE ${res?.status ?? 'no-response'} on ${ocUrl.split('/').pop()} — waiting 3s...`);
                    await new Promise(r => setTimeout(r, 3000));
                    _cookie = null;
                    await refreshCookie().catch(() => {});
                    res = await nseGetWithRetry(ocUrl);
                }
                if (res?.status === 200 && res.data?.records?.data) {
                    pcrData = res.data;
                    console.log(`[PCR] Direct NSE ✅ (${ocUrl.split('/').pop()})`);
                    break;
                }
                console.warn(`[PCR] Direct NSE failed ${ocUrl.split('/').pop()}: ${res?.status ?? 'no-response'}`);
            }

            if (!pcrData) {
                _pcr.lastError = 'All PCR URLs failed (NSE 404) — using last cached value';
                console.error('[PCR] All paths failed for all URLs. NSE option chain endpoint may have changed.');
                return;  // keep last good _pcr values
            }
        }

        // ── Parse and commit ──────────────────────────────────────────────────
        const parsed = parsePCR(pcrData, spotPrice);
        if (!parsed || parsed.pcr === null) {
            _pcr.lastError = 'Empty or malformed OC data';
            return;
        }
        // Commit — only on success, so stale values survive transient failures
        Object.assign(_pcr, parsed, {
            expiryDay : isExpiryDay(),
            fetchedAt : new Date(),
            lastError : null,
            fetchCount: _pcr.fetchCount + 1,
        });
        console.log(`📊 [PCR] ${parsed.pcr} | ATM PCR: ${parsed.atmPcr} | ATM: ${parsed.atm} | MaxPain: ${parsed.maxPain?.strike ?? 'N/A'} [#${_pcr.fetchCount}]`);

        // ── OI Buildup — computed on every PCR cycle ──────────────────────────
        try {
            const records  = pcrData?.records?.data;
            const oiResult = calcOIBuildup(records, parsed.pcr);
            if (oiResult) {
                const oiSignal = interpretOIBuildup(oiResult);
                Object.assign(_oiBuildup, oiResult, {
                    signal       : oiSignal.signal,
                    strength     : oiSignal.strength,
                    label        : oiSignal.label,
                    prevFetchedAt: _oiBuildup.fetchedAt,
                    fetchedAt    : new Date(),
                    fetchCount   : _oiBuildup.fetchCount + 1,
                    lastError    : null,
                });
                const fmtK = v => `${v >= 0 ? '+' : ''}${Math.round(v / 1000)}K`;
                console.log(
                    `📈 [OI BUILDUP] PE Δ${fmtK(oiResult.totalPEoiChange)} | CE Δ${fmtK(oiResult.totalCEoiChange)}` +
                    ` | PCR Δ${oiResult.pcrChange ?? 'N/A'}` +
                    ` | PutWall: ${oiResult.maxPEoiStrike} | CallWall: ${oiResult.maxCEoiStrike}` +
                    ` → ${oiSignal.signal} [#${_oiBuildup.fetchCount}]`
                );
            }
        } catch (oiErr) {
            _oiBuildup.lastError = oiErr.message;
            console.error('[OI Buildup] Calc error:', oiErr.message);
        }

        // ── Early Momentum — 9-vote leading signal (no warmup needed) ─────────
        try {
            const emResult = parseEarlyMomentum(pcrData?.records?.data, parsed.atm);
            if (emResult) {
                // Merge in strike-level OI shift fields from oiResult (Murarka primary read)
                const oiState = getOIBuildupState();
                const emWithStrike = {
                    ...emResult,
                    topCEbuildup     : oiState.topCEbuildup   || [],
                    topPEbuildup     : oiState.topPEbuildup   || [],
                    maxCEoiAddStrike : oiState.maxCEoiAddStrike,
                    maxPEoiAddStrike : oiState.maxPEoiAddStrike,
                    maxCEoiAdd       : oiState.maxCEoiAdd,
                    maxPEoiAdd       : oiState.maxPEoiAdd,
                };
                const emSignal = interpretEarlyMomentum(emWithStrike);
                Object.assign(_earlyMom, emWithStrike, {
                    score     : emSignal.score,
                    signal    : emSignal.signal,
                    strength  : emSignal.strength,
                    label     : emSignal.label,
                    votes     : emSignal.votes,
                    fetchedAt : new Date(),
                    fetchCount: _earlyMom.fetchCount + 1,
                    lastError : null,
                });
                const scoreStr = `${emSignal.score >= 0 ? '+' : ''}${emSignal.score}`;
                console.log(
                    `⚡ [EARLY MOM] score=${scoreStr} → ${emSignal.signal} str=${emSignal.strength}` +
                    ` | ${emSignal.label.substring(0, 80)} [#${_earlyMom.fetchCount}]`
                );
            }
        } catch (emErr) {
            _earlyMom.lastError = emErr.message;
            console.error('[Early Mom] Calc error:', emErr.message);
        }
    } catch (e) {
        _pcr.lastError = e.message;
        console.error('[PCR] Fetch error:', e.message);
        // _pcr values unchanged — last good data remains available
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FII / DII — state + fetch + schedule
// ═══════════════════════════════════════════════════════════════════════════════
//
// NSE endpoint: /api/fiidiiTradeReact
// Returns an array of objects, one per category per day.
// We pick the most recent date's FII/FPI and DII rows.
//
// Typical shape:
//   [ { date, category, buyValue, sellValue, netValue }, ... ]
// where netValue = buyValue − sellValue in ₹ crore.
//
// FII net > 0  → buying (bullish flow into equities)
// DII net > 0  → buying (domestic institutions absorbing / defensive)
// Both positive = strong bull; both negative = strong bear.
// Divergence (FII−, DII+) = classic "FII selling, DII supporting" which is
// common in corrections but doesn't imply sustained downtrend on its own.

const _fii = {
    date      : null,   // IST date string of the data
    fiiNet    : null,   // FII net in ₹ crore  (+ = buy, − = sell)
    fiiBuy    : null,
    fiiSell   : null,
    diiNet    : null,   // DII net in ₹ crore
    diiBuy    : null,
    diiSell   : null,
    fetchedAt : null,
    lastError : null,
    fetchCount: 0,
};

function parseFIIDII(data) {
    // NSE fiidiiTradeReact can return either an array or { data: [...] }
    const rows = Array.isArray(data) ? data
               : Array.isArray(data?.data) ? data.data
               : null;
    if (!rows || rows.length === 0) return null;

    // Log first row keys once to help diagnose field-name mismatches
    if (rows.length > 0) {
        console.log('[FII/DII] Sample row keys:', Object.keys(rows[0]).join(', '));
        console.log('[FII/DII] Sample row:', JSON.stringify(rows[0]));
    }

    // Data comes newest-first; group by date and pick the latest
    const byDate = {};
    for (const row of rows) {
        const d = row.date || row.Date || row.tradeDate || row.TRADE_DATE || 'nodate';
        if (!byDate[d]) byDate[d] = [];
        byDate[d].push(row);
    }

    // Most recent date
    const latestDate = Object.keys(byDate).sort().reverse()[0];
    if (!latestDate) return null;
    const dateRows = byDate[latestDate];

    let fiiRow = null, diiRow = null;
    for (const r of dateRows) {
        // NSE uses 'FII/FPI', 'FII', 'FPI' for foreign and 'DII' for domestic
        const cat = (r.category || r.Category || r.CATEGORY || r.name || r.Name || '').toString().toUpperCase();
        if (cat.includes('FII') || cat.includes('FPI') || cat.includes('FOREIGN')) fiiRow = r;
        if (cat.includes('DII') || cat.includes('DOMESTIC'))                       diiRow = r;
    }

    if (!fiiRow && !diiRow) {
        console.warn('[FII/DII] Could not identify FII/DII rows in:', JSON.stringify(dateRows));
        return null;
    }

    // Helper — tries all key spellings; handles numbers stored as strings
    const num = (obj, ...keys) => {
        if (!obj) return null;
        for (const k of keys) {
            // try exact key, Title-case variant, UPPER_CASE variant
            const variants = [k, k.charAt(0).toUpperCase() + k.slice(1), k.toUpperCase(), k.replace(/([A-Z])/g,'_$1').toUpperCase()];
            for (const vk of variants) {
                const v = obj[vk];
                if (v !== undefined && v !== null && v !== '') return parseFloat(v);
            }
        }
        return null;
    };

    return {
        date    : latestDate,
        fiiNet  : num(fiiRow, 'netValue', 'net_value', 'NET', 'net', 'netval'),
        fiiBuy  : num(fiiRow, 'buyValue', 'buy_value', 'BUY', 'buy', 'buyval', 'grossPurchase', 'grossBuy'),
        fiiSell : num(fiiRow, 'sellValue', 'sell_value', 'SELL', 'sell', 'sellval', 'grossSale', 'grossSell'),
        diiNet  : num(diiRow, 'netValue', 'net_value', 'NET', 'net', 'netval'),
        diiBuy  : num(diiRow, 'buyValue', 'buy_value', 'BUY', 'buy', 'buyval', 'grossPurchase', 'grossBuy'),
        diiSell : num(diiRow, 'sellValue', 'sell_value', 'SELL', 'sell', 'sellval', 'grossSale', 'grossSell'),
    };
}

async function _fetchFIIDII() {
    // FII/DII data is end-of-day — NSE only updates it after 18:00 IST.
    // Widen to 6:00–22:00 window (was 8:00–22:00) so pre-market boot gets yesterday's data.
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const istMin = ist.getHours() * 60 + ist.getMinutes();
    if (istMin < 360 || istMin > 1320) {   // outside 6:00–22:00
        console.log('[FII/DII] Outside fetch window — skipping');
        return;
    }
    try {
        // -- Path A: ScraperAPI (bypasses Railway IP block) --
        if (SCRAPERAPI_KEY) {
            try {
                const scCookie = await getCookie();
                const scUrl = `${SCRAPERAPI_BASE}/?api_key=${SCRAPERAPI_KEY}&url=${encodeURIComponent(FIIDII_URL)}&render_js=false&country_code=in&session_number=1&custom_headers=true`;
                const scRes = await axios.get(scUrl, {
                    timeout: 30_000, validateStatus: () => true,
                    headers: { ...HEADERS, ...(scCookie ? { 'Cookie': scCookie } : {}) },
                });
                if (scRes.status === 200 && scRes.data) {
                    const parsed = parseFIIDII(scRes.data);
                    if (parsed) {
                        Object.assign(_fii, parsed, { fetchedAt: new Date(), lastError: null, fetchCount: _fii.fetchCount + 1 });
                        const fmt = v => v === null ? 'N/A' : `Rs.${v >= 0 ? '+' : ''}${v.toFixed(0)}Cr`;
                        console.log(`[FII/DII] ScraperAPI OK | FII: ${fmt(parsed.fiiNet)} DII: ${fmt(parsed.diiNet)}`);
                        return;
                    }
                }
            } catch (se) {
                console.warn('[FII/DII] ScraperAPI error:', se.message, '- trying direct NSE');
            }
        }

        // -- Path B: Direct NSE (bypasses Railway IP block) --
        // Use dedicated longer timeout for FII/DII
        const cookie = await getCookie();
        let res = await axios.get(FIIDII_URL, {
            headers        : { ...HEADERS, Cookie: cookie },
            timeout        : FIIDII_TIMEOUT_MS,
            validateStatus : () => true,
        });

        // Retry once on 401/403 or timeout-style empty response
        if (res.status === 401 || res.status === 403 || res.status >= 500) {
            console.warn(`[FII/DII] Status ${res.status} — re-authenticating and retrying...`);
            _cookie = null;
            await refreshCookie();
            const cookie2 = await getCookie();
            res = await axios.get(FIIDII_URL, {
                headers        : { ...HEADERS, Cookie: cookie2 },
                timeout        : FIIDII_TIMEOUT_MS,
                validateStatus : () => true,
            });
        }

        if (res.status !== 200) {
            _fii.lastError = `HTTP ${res.status}`;
            console.warn(`[FII] Unexpected status ${res.status}`);
            return;
        }
        const parsed = parseFIIDII(res.data);
        if (!parsed) {
            _fii.lastError = 'Empty or malformed FII/DII data';
            return;
        }
        Object.assign(_fii, parsed, {
            fetchedAt : new Date(),
            lastError : null,
            fetchCount: _fii.fetchCount + 1,
        });

        const fmt = v => v === null ? 'N/A' : `₹${v >= 0 ? '+' : ''}${v.toFixed(0)}Cr`;
        console.log(`💰 [FII/DII] ${parsed.date} | FII Net: ${fmt(parsed.fiiNet)} | DII Net: ${fmt(parsed.diiNet)} [#${_fii.fetchCount}]`);
    } catch (e) {
        _fii.lastError = e.message;
        console.error('[FII/DII] Fetch error:', e.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scheduler
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * startNSEScheduler(getSpotPrice)
 * Call once at server startup.
 * getSpotPrice: () => number — callback that returns the current Nifty spot.
 * This avoids a circular dependency between nseData and your price feed.
 */
function startNSEScheduler(getSpotPrice) {
    console.log('[NSE] 🚀 Starting NSE scheduler (PCR: 3 min | FII/DII: 15 min)');

    // Fire first fetches async — intentionally NOT awaited so the app never
    // hangs at startup if NSE is slow or unreachable.  State objects stay at
    // their null/default values until the fetch resolves; getPCRState() and
    // getFIIState() expose _fallback:true in the meantime so the frontend can
    // show "Live data unavailable, market may be closed" instead of spinning.
    const spot = getSpotPrice();
    _fetchPCR(spot).catch(e => console.error('[NSE] Initial PCR fetch error:', e.message));
    _fetchFIIDII().catch(e => console.error('[NSE] Initial FII fetch error:', e.message));

    // Recurring PCR fetch (needs live spot price each cycle)
    setInterval(() => _fetchPCR(getSpotPrice()), PCR_INTERVAL_MS);

    // Recurring FII/DII fetch
    setInterval(_fetchFIIDII, FIIDII_INTERVAL_MS);

    // Proactive cookie re-warm independent of fetch cycles
    setInterval(refreshCookie, COOKIE_TTL_MS);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Signal interpreters — drop these into combineSignals()
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * interpretPCR(pcr)
 * PCR > 1.3  → strong bull (heavy put OI = institutions hedging downside = market supported)
 * PCR 1.0–1.3 → mild bull
 * PCR 0.8–1.0 → neutral
 * PCR 0.6–0.8 → mild bear
 * PCR < 0.6  → strong bear (call-heavy = complacency = reversal risk)
 */
function interpretPCR(pcr) {
    if (pcr === null) return { signal: 'NEUTRAL', strength: 0, label: 'PCR N/A — awaiting data' };
    if (pcr  > 1.3)  return { signal: 'BULL',    strength: 2, label: `PCR ${pcr} — Strong Put OI ✅` };
    if (pcr >= 1.0)  return { signal: 'BULL',    strength: 1, label: `PCR ${pcr} — Mild Put bias ✅` };
    if (pcr >= 0.8)  return { signal: 'NEUTRAL', strength: 0, label: `PCR ${pcr} — Neutral` };
    if (pcr >= 0.6)  return { signal: 'BEAR',    strength: 1, label: `PCR ${pcr} — Mild Call bias ⚠️` };
    return                  { signal: 'BEAR',    strength: 2, label: `PCR ${pcr} — Strong Call OI ⚠️` };
}

/**
 * interpretFII(fiiNet, diiNet)
 * Both positive    → strong bull
 * FII+ only        → mild bull
 * DII+ / FII−      → neutral (DII supporting but FII selling)
 * Both negative    → strong bear
 * FII− only        → mild bear
 *
 * Values are in ₹ crore.  A 500 Cr threshold avoids noise on low-volume days.
 */
function interpretFII(fiiNet, diiNet) {
    if (fiiNet === null && diiNet === null)
        return { signal: 'NEUTRAL', strength: 0, label: 'FII/DII N/A — awaiting data' };

    const f = fiiNet ?? 0;
    const d = diiNet ?? 0;
    const THRESHOLD = 500;   // ₹ crore — below this treat as noise

    const fiiBull = f >  THRESHOLD;
    const fiiBear = f < -THRESHOLD;
    const diiBull = d >  THRESHOLD;
    const diiBear = d < -THRESHOLD;

    const fStr = `FII ₹${f >= 0 ? '+' : ''}${f.toFixed(0)}Cr`;
    const dStr = `DII ₹${d >= 0 ? '+' : ''}${d.toFixed(0)}Cr`;

    if (fiiBull && diiBull) return { signal: 'BULL',    strength: 2, label: `${fStr} | ${dStr} — Both buying ✅` };
    if (fiiBull)            return { signal: 'BULL',    strength: 1, label: `${fStr} — FII buying ✅` };
    if (fiiBear && diiBear) return { signal: 'BEAR',    strength: 2, label: `${fStr} | ${dStr} — Both selling ⚠️` };
    if (fiiBear)            return { signal: 'BEAR',    strength: 1, label: `${fStr} — FII selling ⚠️` };
    if (diiBull)            return { signal: 'NEUTRAL', strength: 0, label: `${fStr} | ${dStr} — DII supporting, FII flat` };
    return                         { signal: 'NEUTRAL', strength: 0, label: `${fStr} | ${dStr} — Mixed/flat flows` };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

// _fallback:true is present when no successful fetch has completed yet.
// The frontend should display "Live data unavailable, market may be closed"
// instead of a spinner when it sees this flag.
function getPCRState() {
    const snap = { ..._pcr };
    if (snap.fetchCount === 0) snap._fallback = true;
    return snap;
}
function getFIIState() {
    const snap = { ..._fii };
    if (snap.fetchCount === 0) snap._fallback = true;
    // Mark stale if last successful fetch was > 20 minutes ago
    if (snap.fetchedAt) {
        const ageMs = Date.now() - new Date(snap.fetchedAt).getTime();
        if (ageMs > 20 * 60 * 1000) snap._stale = true;
    }
    return snap;
}
function getOIBuildupState() { return { ..._oiBuildup }; }
function getEarlyMomState()  { return { ..._earlyMom }; }

// Convenience getters for combineSignals()
function getCurrentPCR()    { return _pcr.pcr; }
function getCurrentATMPcr() { return _pcr.atmPcr; }
function getCurrentFIINet() { return _fii.fiiNet; }
function getCurrentDIINet() { return _fii.diiNet; }

module.exports = {
    // Lifecycle
    startNSEScheduler,

    // Snapshots (for /debug routes)
    getPCRState,
    getFIIState,
    getOIBuildupState,
    getEarlyMomState,

    // Scalar getters (for combineSignals)
    getCurrentPCR,
    getCurrentATMPcr,
    getCurrentFIINet,
    getCurrentDIINet,

    // Interpreters (for combineSignals)
    interpretPCR,
    interpretFII,
    interpretOIBuildup,
    interpretEarlyMomentum,

    // Utilities
    isExpiryDay,
    isMarketHours,
};