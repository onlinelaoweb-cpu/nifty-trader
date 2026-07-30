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
let _telegram = null;
try { _telegram = require('./telegram'); } catch (e) { /* optional — nseData can run without it in tests */ }

// One alert per calendar day — same dedup pattern as ema920AlertSentToday in
// server.js. Resets automatically since it's keyed off today's date string.
let _fyersAlertSentForDate = null;

// ── Angel One session ─────────────────────────────────────────────────────────
let _angelSession = null;
function injectAngelSession({ jwtToken, apiKey }) {
    _angelSession = { jwtToken, apiKey };
    console.log('[nseData] Angel session injected — PCR via Angel API enabled');
}

// Called from server.js after Angel login — fires initial PCR with session ready
function triggerInitialPCR(spotPrice) {
    if (!spotPrice || spotPrice <= 0) return;
    _fetchPCR(spotPrice).catch(e => console.error('[NSE] Initial PCR fetch error:', e.message));
}

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
    // v2 endpoint introduced mid-2026 — try before equities fallback
    `${BASE_URL}/api/option-chain-indices/v2?symbol=NIFTY`,
    `${BASE_URL}/api/option-chain-equities?symbol=NIFTY`,
    `${BASE_URL}/api/option-chain-equities/v2?symbol=NIFTY`,
    `https://nsearchives.nseindia.com/content/fo/nifty_oc.json`,
];
const OC_URL = OC_URLS[0];  // kept for backward compat
const FIIDII_URL = `${BASE_URL}/api/fiidiiTradeReact`;
const TIMEOUT_MS = 12_000;   // 12s — enough for slow NSE responses from Railway; retry handles timeouts

const PCR_INTERVAL_MS    =  3 * 60 * 1000;   // re-fetch PCR every 3 min
const FIIDII_INTERVAL_MS = 15 * 60 * 1000;   // re-fetch FII/DII every 15 min
const COOKIE_TTL_MS      = 15 * 60 * 1000;   // proactive cookie re-warm


// PCR sources: Fyers (primary) → Angel (secondary) → NSE direct (fallback)

// PCR sources: Fyers (primary) → Angel (secondary) → NSE direct (fallback)
const SCRAPERAPI_KEY  = null;   // disabled
const SCRAPERAPI_BASE = 'https://api.scraperapi.com';  // kept for reference only

// ── Fyers API config ───────────────────────────────────────────────────────────
// Fyers option chain — no IP restriction, access token expires daily.
// Required Railway env vars: FYERS_APP_ID, FYERS_ACCESS_TOKEN, FYERS_REFRESH_TOKEN
// On startup: auto-refresh access token using refresh token (valid 15 days).
const FYERS_APP_ID        = (process.env.FYERS_APP_ID        || '').trim() || null;
const FYERS_SECRET_ID     = (process.env.FYERS_SECRET_ID     || '').trim() || null;
let   FYERS_ACCESS_TOKEN  = (process.env.FYERS_ACCESS_TOKEN  || '').trim() || null;
let   FYERS_REFRESH_TOKEN = (process.env.FYERS_REFRESH_TOKEN || '').trim() || null;
const FYERS_PIN           = (process.env.FYERS_PIN           || '').trim() || '';
console.log(`[nseData] Fyers: AppID=${FYERS_APP_ID ? '✅' : '❌'} | AccessToken=${FYERS_ACCESS_TOKEN ? '✅ (' + FYERS_ACCESS_TOKEN.slice(0,10) + '...)' : '❌'} | RefreshToken=${FYERS_REFRESH_TOKEN ? '✅ present' : '❌ MISSING'}`);

// ── Fyers Auto Token Refresh ───────────────────────────────────────────────────
// Fyers access token expires every day at midnight.
// On every app startup, auto-refresh using refresh token so no manual work needed.
// Refresh token itself is valid for 15 days — after that regenerate manually once.
async function autoRefreshFyersToken() {
    if (!FYERS_REFRESH_TOKEN || !FYERS_APP_ID) {
        console.warn('[Fyers] ⚠️  Cannot auto-refresh — FYERS_REFRESH_TOKEN missing in Railway Variables');
        return;
    }
    try {
        const crypto = require('crypto');
        const appIdOnly = FYERS_APP_ID.split('-')[0]; // e.g. "2U5JAL826U" from "2U5JAL826U-100"
        // appIdHash = SHA256(app_id:secret_id) — secret_id needed for refresh
        // If FYERS_SECRET_ID not set, try without hash (some tokens work this way)
        let appIdHash = '';
        if (FYERS_SECRET_ID) {
            appIdHash = crypto.createHash('sha256')
                .update(`${FYERS_APP_ID}:${FYERS_SECRET_ID}`)
                .digest('hex');
        }

        const payload = {
            grant_type    : 'refresh_token',
            appIdHash     : appIdHash,
            refresh_token : FYERS_REFRESH_TOKEN,
            pin           : FYERS_PIN,
        };

        console.log('[Fyers] 🔄 Auto-refreshing access token using refresh token...');
        const res = await axios.post(
            'https://api-t1.fyers.in/api/v3/validate-refresh-token',
            payload,
            { headers: { 'Content-Type': 'application/json' }, timeout: 10_000 }
        );

        const d = res.data;
        if (d?.access_token) {
            FYERS_ACCESS_TOKEN = d.access_token.trim();
            // Update refresh token if a new one was returned
            if (d.refresh_token) FYERS_REFRESH_TOKEN = d.refresh_token.trim();
            console.log(`[Fyers] ✅ Access token auto-refreshed successfully (${FYERS_ACCESS_TOKEN.slice(0,10)}...)`);
        } else {
            console.warn(`[Fyers] ⚠️  Refresh failed: ${JSON.stringify(d)?.slice(0, 200)}`);
            console.warn('[Fyers] Using existing FYERS_ACCESS_TOKEN — may be expired. Regenerate manually at myapi.fyers.in if PCR fails.');
        }
    } catch (e) {
        const body = JSON.stringify(e.response?.data)?.slice(0, 200) || e.message;
        const isSebiDisabled = body.includes('-16') || body.includes('SEBI') || body.includes('disabled');
        if (isSebiDisabled) {
            // SEBI permanently disabled the refresh token API — this is expected, not an error.
            // The stored FYERS_ACCESS_TOKEN is used as-is. Update it manually each morning.
            console.log('[Fyers] ℹ️  Refresh token API disabled by SEBI — using stored access token. Update FYERS_ACCESS_TOKEN in Railway Variables each morning before 9:15 AM.');
        } else {
            console.warn(`[Fyers] ⚠️  Token refresh error (${e.response?.status || e.message}): ${body}`);
            console.warn('[Fyers] Using existing FYERS_ACCESS_TOKEN — update manually at myapi.fyers.in if PCR fails.');
            if (!FYERS_SECRET_ID) {
                console.warn('[Fyers] 🔎 Diagnosis hint: FYERS_SECRET_ID is not set, so appIdHash was sent empty. ' +
                    'Fyers\' refresh API requires SHA256(app_id:secret_id) — an empty/wrong hash produces exactly ' +
                    'this "invalid refresh token" error even when the refresh token itself is fine. Get the Secret ' +
                    'ID from myapi.fyers.in → your app → and set FYERS_SECRET_ID in Railway Variables before assuming the refresh token needs regenerating.');
            }
            // Alert once per day, not once per restart, so a redeploy-heavy morning
            // doesn't spam Telegram — but the FIRST failure each day still reaches
            // Prabhash proactively instead of only being discovered when PCR breaks.
            const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
            if (_telegram && _fyersAlertSentForDate !== todayStr) {
                _fyersAlertSentForDate = todayStr;
                _telegram.sendRawMessage(
                    `⚠️ <b>Fyers token refresh failed</b>\n` +
                    `${body}\n\n` +
                    (FYERS_SECRET_ID
                        ? `Using existing FYERS_ACCESS_TOKEN as fallback. If PCR stops updating, regenerate at myapi.fyers.in.`
                        : `🔎 FYERS_SECRET_ID is not set in Railway — this is the likely cause, not an expired refresh token. Add it before regenerating anything.`)
                ).catch(() => {});
            }
        }
    }
}
// Run on startup (non-blocking)
// DISABLED (25 July, per user request): user updates FYERS_ACCESS_TOKEN manually
// on Railway every day, so this refresh-token flow has no role in their actual
// workflow — it was only generating a daily "Fyers token refresh failed" Telegram
// alert for a mechanism that isn't being relied on. Function left intact (unused)
// in case FYERS_REFRESH_TOKEN + FYERS_SECRET_ID ever get sorted out and this
// becomes worth re-enabling — just uncomment the line below.
// autoRefreshFyersToken();

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
// Track last ScraperAPI session warm timestamp + captured cookies
let _scraperSessionWarmedAt = 0;
let _scraperNseCookie = null;   // NSE cookies captured from the warm step

async function scraperAPIFetch(targetUrl) {
    if (!SCRAPERAPI_KEY) return null;
    try {
        // NSE requires a 2-step session:
        // Step 1: Visit /option-chain HTML page via ScraperAPI → capture NSE Set-Cookie headers
        // Step 2: Call JSON API via ScraperAPI, forwarding those cookies via custom_headers=true
        //
        // KEY FIX: session_number=1 alone does NOT share cookies between ScraperAPI requests.
        // We must explicitly extract the NSE cookies from step 1 and inject them into step 2
        // using ScraperAPI's custom_headers parameter. This is what was missing.

        // Build ScraperAPI URL
        // Warm step uses render_js=true (headless browser — sets NSE JS cookies properly)
        // API step uses render_js=false (faster JSON fetch, reuses session cookies)
        const buildWarmUrl = (target) =>
            `${SCRAPERAPI_BASE}/?api_key=${SCRAPERAPI_KEY}&url=${encodeURIComponent(target)}&render_js=true&country_code=in&session_number=1`;
        const buildApiUrl = (target) =>
            `${SCRAPERAPI_BASE}/?api_key=${SCRAPERAPI_KEY}&url=${encodeURIComponent(target)}&render_js=false&country_code=in&session_number=1&custom_headers=true`;
        const buildUrl = buildApiUrl;  // backward compat for API calls below

        // Axios config that injects the NSE cookie as a forwarded header
        const axiosConfig = (cookie) => ({
            timeout: 35_000,
            validateStatus: () => true,
            // ScraperAPI forwards any headers we send directly to the target when custom_headers=true
            headers: {
                ...HEADERS,
                ...(cookie ? { 'Cookie': cookie } : {}),
            },
        });

        const nowMs = Date.now();
        // Re-warm every 8 minutes (NSE session TTL ~10 min)
        if (nowMs - _scraperSessionWarmedAt > 8 * 60 * 1000) {
            try {
                const warmRes = await axios.get(
                    buildWarmUrl('https://www.nseindia.com/option-chain'),
                    { timeout: 40_000, validateStatus: () => true,
                      headers: { ...HEADERS, Accept: 'text/html,application/xhtml+xml,*/*' } }
                );
                // Capture the NSE session cookies returned by ScraperAPI
                const setCookie = warmRes.headers['set-cookie'];
                if (setCookie && setCookie.length) {
                    _scraperNseCookie = setCookie.map(c => c.split(';')[0]).join('; ');
                }
                // Also use our own refreshed cookie as fallback
                if (!_scraperNseCookie && _cookie) {
                    _scraperNseCookie = _cookie;
                }
                _scraperSessionWarmedAt = nowMs;
                console.log('[ScraperAPI] Session warmed via /option-chain page');
            } catch (we) {
                console.warn('[ScraperAPI] Session warm failed:', we.message);
                // Use direct NSE cookie as fallback if warm failed
                if (_cookie) _scraperNseCookie = _cookie;
            }
        }

        // Now call the actual JSON API endpoints in order, injecting cookies
        for (const ocUrl of OC_URLS) {
            try {
                const res = await axios.get(buildUrl(ocUrl), axiosConfig(_scraperNseCookie || _cookie));
                if (res.status !== 200) {
                    console.warn(`[ScraperAPI] HTTP ${res.status} for ${ocUrl.split('/').pop()}`);
                    continue;
                }
                const raw = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                // Empty object = IP blocked silently
                if (raw && typeof raw === 'object' && Object.keys(raw).length === 0) {
                    console.warn(`[ScraperAPI] Empty object response (IP block?) for ${ocUrl.split('/').pop()}`);
                    continue;
                }
                // NSE has multiple response formats — normalise all to {records:{data:[]}}
                // Shape 1 (indices):  { records: { data: [...] } }
                // Shape 2 (equities): { data: [...], metadata: {...} }
                // Shape 3 (equities v2): { filtered: { data: [...] } }
                // Shape 4 (equities v3): { status: true, data: { filtered: { data: [...] } } }
                if (!raw?.records) {
                    if (raw?.data && Array.isArray(raw.data)) {
                        raw.records = { data: raw.data, expiryDates: raw.metadata?.expiryDates || [] };
                    } else if (raw?.filtered?.data && Array.isArray(raw.filtered.data)) {
                        raw.records = { data: raw.filtered.data, expiryDates: raw.expiryDates || [] };
                    } else if (raw?.data?.filtered?.data && Array.isArray(raw.data.filtered.data)) {
                        raw.records = { data: raw.data.filtered.data, expiryDates: [] };
                    }
                }
                if (raw?.records?.data && Array.isArray(raw.records.data) && raw.records.data.length > 0) return raw;
                console.warn(`[ScraperAPI] Response missing records.data — status:200, body:${JSON.stringify(raw)?.slice(0,150)}`);
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
    source      : null,   // 'fyers' | 'angel' | 'nse' | 'banknifty-fyers'
    fromIndex   : 'NIFTY', // 'NIFTY' | 'BANKNIFTY' — set to BANKNIFTY when used as fallback proxy
};

function parsePCR(data, spotPrice) {
    const records = data?.records?.data;
    if (!Array.isArray(records) || records.length === 0) return null;

    const atm = calcATMStrike(spotPrice);
    let totalCEoi = 0, totalPEoi = 0;
    let atmCEoi = 0, atmPEoi = 0;
    let atmCEpremium = null, atmPEpremium = null;
    const normalizedRecords = [];  // FIX: previously discarded — needed so OTM strike
                                    // premiums can use real LTP instead of always BS estimate

    for (const row of records) {
        const ce = row.CE, pe = row.PE;
        if (ce?.openInterest) totalCEoi += ce.openInterest;
        if (pe?.openInterest) totalPEoi += pe.openInterest;
        if (row.strikePrice === atm) {
            if (ce) { atmCEoi = ce.openInterest || 0; atmCEpremium = ce.lastPrice || null; }
            if (pe) { atmPEoi = pe.openInterest || 0; atmPEpremium = pe.lastPrice || null; }
        }
        normalizedRecords.push({
            strikePrice: row.strikePrice,
            CE: { openInterest: ce?.openInterest || 0, lastPrice: ce?.lastPrice || 0 },
            PE: { openInterest: pe?.openInterest || 0, lastPrice: pe?.lastPrice || 0 },
        });
    }

    const pcr    = totalCEoi > 0 ? parseFloat((totalPEoi / totalCEoi).toFixed(2)) : null;
    const atmPcr = atmCEoi  > 0 ? parseFloat((atmPEoi  / atmCEoi ).toFixed(2)) : null;
    const maxPain = calcMaxPain(records);

    return { pcr, atmPcr, atm, atmCEpremium, atmPEpremium, totalCEoi, totalPEoi, maxPain, records: normalizedRecords };
}

// ── Market hours guard ────────────────────────────────────────────────────────
// Returns true if current IST time is within 9:10–15:35 (5-min buffer either side)
// NSE 2026 holidays (keep in sync with server.js)
const NSE_HOLIDAYS = new Set([
    '2026-01-26','2026-03-02','2026-03-20','2026-04-02','2026-04-03',
    '2026-04-14','2026-05-01','2026-08-15','2026-08-27','2026-10-02',
    '2026-10-20','2026-10-21','2026-11-04','2026-12-25',
]);
function isNSEHoliday(dateObj) {
    // dateObj: a Date object in IST (or any Date — we extract IST date parts)
    const ist = dateObj || new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const yyyy = ist.getFullYear(), mm = String(ist.getMonth()+1).padStart(2,'0'), dd = String(ist.getDate()).padStart(2,'0');
    return NSE_HOLIDAYS.has(yyyy+'-'+mm+'-'+dd);
}

function isMarketHours() {
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay(); // 0=Sun, 6=Sat
    if (day === 0 || day === 6) return false;  // weekend
    const yyyy = ist.getFullYear(), mm = String(ist.getMonth()+1).padStart(2,'0'), dd = String(ist.getDate()).padStart(2,'0');
    if (NSE_HOLIDAYS.has(`${yyyy}-${mm}-${dd}`)) return false;  // NSE holiday
    const istMin = ist.getHours() * 60 + ist.getMinutes();
    return istMin >= 550 && istMin <= 935;   // 9:10 to 15:35
}


// ── Angel One Market Data PCR ─────────────────────────────────────────────────
// Uses Angel SmartAPI to fetch option OI for ATM ±7 strikes → compute PCR.
// Requires Angel session (injected via injectAngelSession).
// The ScripMaster JSON lists all NFO tokens — we download it once per day.
let _scripMasterCache = null;
let _scripMasterDate  = null;

async function getScripMaster() {
    const today = new Date().toISOString().slice(0, 10);
    if (_scripMasterCache && _scripMasterDate === today) return _scripMasterCache;
    try {
        const res = await axios.get(
            'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
            { timeout: 20_000, responseType: 'json' }
        );
        const total = Array.isArray(res.data) ? res.data.length : 0;
        // MEM FIX: full ScripMaster is 50K-100K instruments (~50-100MB).
        // We only ever use NIFTY NFO index options — filter immediately and
        // discard everything else so it doesn't sit in memory all day.
        const filtered = Array.isArray(res.data)
            ? res.data.filter(s =>
                s.exch_seg === 'NFO' &&
                s.instrumenttype === 'OPTIDX' &&
                s.name === 'NIFTY' &&
                s.expiry)
            : res.data;
        _scripMasterCache = filtered;
        _scripMasterDate  = today;
        console.log(`[ScripMaster] Loaded ${total} instruments → filtered to ${Array.isArray(filtered) ? filtered.length : 0} NIFTY NFO options`);
        return filtered;
    } catch (e) {
        console.warn('[ScripMaster] Fetch failed:', e.message);
        return _scripMasterCache;  // use stale if available
    }
}

async function fetchPCRFromAngel(spotPrice) {
    if (!_angelSession?.jwtToken) return null;
    if (!spotPrice || spotPrice <= 0) return null;

    // Market hours check
    const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const istMin = istNow.getHours() * 60 + istNow.getMinutes();
    if (istMin < 555 || istMin > 930) return null;

    try {
        const scrips = await getScripMaster();
        if (!scrips || !Array.isArray(scrips)) return null;

        // scrips is already pre-filtered to NIFTY NFO OPTIDX entries (see getScripMaster)
        const niftyOptions = scrips;
        if (niftyOptions.length === 0) {
            console.warn('[PCR-Angel] No NIFTY option tokens in ScripMaster');
            return null;
        }

        // Get nearest expiry date
        const today = new Date();
        const expiries = [...new Set(niftyOptions.map(s => s.expiry))].sort();
        const nearestExpiry = expiries.find(e => {
            // ScripMaster expiry format: "07JUL2026" = DDMMMYYYY
            const parts = e.match(/(\d{2})(\w{3})(\d{4})/);
            if (!parts) return false;
            const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
            const mIdx = months[parts[2].toUpperCase()];
            if (mIdx === undefined) return false;
            const expDate = new Date(parseInt(parts[3]), mIdx, parseInt(parts[1]));
            // Use start of today (midnight) for comparison so today's expiry is included
            const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
            return expDate >= todayStart;
        });
        if (!nearestExpiry) {
            console.warn('[PCR-Angel] No valid upcoming expiry found');
            return null;
        }

        // ATM strike (Nifty rounds to nearest 50)
        const atmStrike = Math.round(spotPrice / 50) * 50;
        const strikesToFetch = [];
        for (let i = -7; i <= 7; i++) strikesToFetch.push(atmStrike + i * 50);

        // Find tokens for these strikes on the nearest expiry
        const tokens = [];
        const strikeMap = {};  // token → { strike, optionType }

        // ScripMaster strike field format varies:
        //   Paise format: 2314300 (divide by 100 = 23143.00)
        //   Normal format: 23143 (use as-is)
        // Detect by checking if values are >> 10000 (paise) or ~10000-30000 (normal Nifty range)
        const sampleStrike = parseFloat(niftyOptions[0]?.strike || 0);
        const strikeDivisor = sampleStrike > 100000 ? 100 : 1;
        console.log(`[PCR-Angel] Strike format: sample=${sampleStrike} divisor=${strikeDivisor}`);

        for (const strike of strikesToFetch) {
            for (const optType of ['CE', 'PE']) {
                const s = niftyOptions.find(x =>
                    x.expiry === nearestExpiry &&
                    Math.abs(parseFloat(x.strike) / strikeDivisor - strike) < 1 &&
                    x.symbol.endsWith(optType)
                );
                if (s) {
                    tokens.push(s.token);
                    strikeMap[s.token] = { strike, optionType: optType };
                }
            }
        }

        if (tokens.length < 6) {
            // Fallback: if still too few, try without divisor (in case detection was wrong)
            const altDivisor = strikeDivisor === 100 ? 1 : 100;
            console.warn(`[PCR-Angel] Too few tokens (${tokens.length}) with divisor=${strikeDivisor}, retrying divisor=${altDivisor}`);
            tokens.length = 0;
            for (const k in strikeMap) delete strikeMap[k];
            for (const strike of strikesToFetch) {
                for (const optType of ['CE', 'PE']) {
                    const s = niftyOptions.find(x =>
                        x.expiry === nearestExpiry &&
                        Math.abs(parseFloat(x.strike) / altDivisor - strike) < 1 &&
                        x.symbol.endsWith(optType)
                    );
                    if (s) {
                        tokens.push(s.token);
                        strikeMap[s.token] = { strike, optionType: optType };
                    }
                }
            }
        }

        if (tokens.length < 6) {
            console.warn(`[PCR-Angel] Too few tokens found (${tokens.length}) for expiry ${nearestExpiry} — ATM:${atmStrike}`);
            return null;
        }
        console.log(`[PCR-Angel] Found ${tokens.length} tokens for expiry ${nearestExpiry}`);

        // Fetch market data for these tokens
        const res = await axios.post(
            'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/getMarketData',
            { mode: 'FULL', exchangeTokens: { NFO: tokens } },
            {
                headers: {
                    'Content-Type'     : 'application/json',
                    'Accept'           : 'application/json',
                    'Authorization'    : `Bearer ${_angelSession.jwtToken}`,
                    'X-UserType'       : 'USER',
                    'X-SourceID'       : 'WEB',
                    'X-ClientLocalIP'  : '127.0.0.1',
                    'X-ClientPublicIP' : '127.0.0.1',
                    'X-MACAddress'     : '00:00:00:00:00:00',
                    'X-PrivateKey'     : _angelSession.apiKey || '',
                },
                timeout: 10_000,
            }
        );

        if (typeof res.data === 'string' && res.data.includes('<html')) {
            console.warn('[PCR-Angel] HTML response (IP block) from Angel NFO getMarketData');
            return null;
        }
        // Log full response for diagnosis — Angel blocks Railway IPs on NFO endpoints
        console.log(`[PCR-Angel] getMarketData response status: ${res.status} | data keys: ${Object.keys(res.data || {}).join(', ')}`);
        const apiStatus = res.data?.status === true || res.data?.status === 'true';
        if (!apiStatus) {
            console.warn(`[PCR-Angel] API returned status=false | errorcode: ${res.data?.errorcode} | message: ${res.data?.message} | full: ${JSON.stringify(res.data).slice(0,200)}`);
            return null;
        }

        // Handle multiple response shapes from Angel getMarketData
        // Shape A: { status:true, data: { fetched: [...] } }
        // Shape B: { status:true, data: [...] }
        // Shape C: { status:true, fetched: [...] }
        const fetched = Array.isArray(res.data?.data?.fetched) ? res.data.data.fetched
                      : Array.isArray(res.data?.data)          ? res.data.data
                      : Array.isArray(res.data?.fetched)       ? res.data.fetched
                      : null;
        if (!fetched || fetched.length === 0) {
            console.warn(`[PCR-Angel] Empty fetched array | data type: ${typeof res.data?.data} | full: ${JSON.stringify(res.data).slice(0,200)}`);
            return null;
        }

        // Build a synthetic option chain compatible with parsePCR()
        // fetched items have: symbolToken, openInterest, netChange, tradeVolume, lastPrice, etc.
        let totalCeOI = 0, totalPeOI = 0, ceWall = 0, ceWallStrike = 0, peWall = 0, peWallStrike = 0;
        const records = [];
        const strikeRows = {};

        // Log first item to detect field name changes in Angel API response
        if (fetched.length > 0) {
            console.log(`[PCR-Angel] Sample fetched item keys: ${Object.keys(fetched[0]).join(', ')}`);
            console.log(`[PCR-Angel] Sample item: ${JSON.stringify(fetched[0]).slice(0, 200)}`);
        }

        let matchedCount = 0;
        for (const item of fetched) {
            // Angel API field name variants: symbolToken / token / scripCode / instrumentToken
            const tok = item.symbolToken || item.token || item.scripCode || item.instrumentToken || String(item.symboltoken || '');
            const info = strikeMap[tok] || strikeMap[String(tok)];
            if (!info) continue;
            matchedCount++;
            // OI field variants: openInterest / oi / openInterestQty
            const oi = parseInt(item.openInterest ?? item.oi ?? item.openInterestQty ?? 0);
            // Price field variants: lastPrice / ltp / closePrice
            const ltp = parseFloat(item.lastPrice ?? item.ltp ?? item.closePrice ?? 0);
            // OI change field variants: netChange / changeinOpenInterest / oiChange
            const oiChg = parseInt(item.netChange ?? item.changeinOpenInterest ?? item.oiChange ?? 0);
            const { strike, optionType } = info;
            if (!strikeRows[strike]) strikeRows[strike] = { strikePrice: strike };
            if (optionType === 'CE') {
                strikeRows[strike].CE = { openInterest: oi, lastPrice: ltp, changeinOpenInterest: oiChg };
                totalCeOI += oi;
                if (oi > ceWall) { ceWall = oi; ceWallStrike = strike; }
            } else {
                strikeRows[strike].PE = { openInterest: oi, lastPrice: ltp, changeinOpenInterest: oiChg };
                totalPeOI += oi;
                if (oi > peWall) { peWall = oi; peWallStrike = strike; }
            }
        }
        console.log(`[PCR-Angel] Matched ${matchedCount}/${fetched.length} items | CE OI:${totalCeOI} PE OI:${totalPeOI}`);

        if (totalCeOI === 0 || totalPeOI === 0) {
            console.warn('[PCR-Angel] Zero OI — token match failed or market closed. Check field names above.');
            return null;
        }

        const pcr = parseFloat((totalPeOI / totalCeOI).toFixed(3));
        const recordsArr = Object.values(strikeRows);

        // ATM PCR (±100 range around ATM)
        const atmRange = recordsArr.filter(r => Math.abs(r.strikePrice - atmStrike) <= 100);
        const atmCeOI = atmRange.reduce((s, r) => s + (r.CE?.openInterest || 0), 0);
        const atmPeOI = atmRange.reduce((s, r) => s + (r.PE?.openInterest || 0), 0);
        const atmPcr = atmCeOI > 0 ? parseFloat((atmPeOI / atmCeOI).toFixed(3)) : null;

        // FIX: extract ATM CE/PE LTP for optionFlow buyer/seller card
        const atmRow = strikeRows[atmStrike];
        const atmCEpremium = (atmRow?.CE?.lastPrice > 0) ? atmRow.CE.lastPrice : null;
        const atmPEpremium = (atmRow?.PE?.lastPrice > 0) ? atmRow.PE.lastPrice : null;

        console.log(`[PCR-Angel] ✅ PCR:${pcr} | ATM PCR:${atmPcr} | ATM:${atmStrike} | CE Wall:${ceWallStrike}(${ceWall}) | PE Wall:${peWallStrike}(${peWall}) | ATM CE:${atmCEpremium} PE:${atmPEpremium} | Expiry:${nearestExpiry}`);

        // Return in the format expected by parsePCR consumers
        return {
            pcr,
            atmPcr,
            atm          : atmStrike,
            ceWall       : { strike: ceWallStrike, oi: ceWall },
            peWall       : { strike: peWallStrike, oi: peWall },
            maxPain      : calcMaxPain(recordsArr),
            records      : recordsArr,
            source       : 'angel',
            atmCEpremium,   // FIX: buyer/seller activity card
            atmPEpremium,
        };
    } catch (e) {
        console.warn('[PCR-Angel] Error:', e.message);
        return null;
    }
}


// ── Fyers Quotes API — real volume/OHLC for NIFTY index ────────────────────────
// Angel One WS Mode 2 sends volume/OHLC = 0 for index tokens (26000 = NIFTY 50
// INDEX) because indices aren't traded directly — no order flow exists on them.
// Fyers' REST quote endpoint pulls from NSE's proper market-data feed and DOES
// return real session volume + OHLC for the index, even though it's not a
// tradeable instrument. No new WS connection needed — reuses the same
// FYERS_ACCESS_TOKEN already used for PCR (no extra auth setup required).
//
// Polled (not WS) — call this every 10-15s from server.js, not on every tick,
// to stay well under Fyers' rate limits.
//
// Returns { volume, open, high, low, close, ltp } or null on failure.
// ── Current-month NIFTY futures symbol for Fyers ─────────────────────────────
// Fyers does NOT support the Zerodha-style continuous-contract alias
// "NSE:NIFTY-I" — that symbol always fails on Fyers' quote endpoint, silently
// falling back to the plain index quote (which correctly has real O/H/L/LTP
// but volume is ALWAYS 0 for an index — indices have no traded volume).
// That's exactly why volume was stuck at "0.00Cr" — the primary futures
// symbol was never valid in the first place, so it always fell through.
//
// Fyers' real format is: NSE:NIFTY{YY}{MMM}FUT, e.g. NSE:NIFTY26JULFUT.
// Contracts roll on the monthly expiry.
//
// FIX (30 Jul 2026): SEBI's Oct-2024 circular moved ALL NSE index F&O expiry
// (weekly + monthly) from Thursday to Tuesday, effective 1 Sept 2025 — NSE
// contracts now expire on the LAST TUESDAY of the month, not last Thursday.
// The old lastThursday()-based check computed July 2026's "expiry" as
// Thu 30-Jul, but the real expiry was Tue 28-Jul — so on 29/30-Jul this
// function kept returning the already-expired NIFTY26JULFUT, which Fyers
// rejects with "Please provide a valid symbol" (code -300), and volume
// fell through to the index-only 0-volume fallback. This is exactly the
// stuck-volume bug — same symptom as the earlier "NSE:NIFTY-I" bug above,
// different cause (stale expiry day, not a bad alias).
function getCurrentFyersFutSymbol() {
    const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const y = istNow.getFullYear();
    const m = istNow.getMonth(); // 0-indexed

    // Last Tuesday of a given (year, month) — NSE's current monthly expiry day.
    const lastTuesday = (year, month) => {
        const d = new Date(year, month + 1, 0); // last calendar day of month
        const diff = (d.getDay() - 2 + 7) % 7;   // 2 = Tuesday
        d.setDate(d.getDate() - diff);
        return d;
    };

    let targetY = y, targetM = m;
    const thisMonthExpiry = lastTuesday(y, m);
    // If today is past this month's expiry date, roll to next month's contract.
    if (istNow.getDate() > thisMonthExpiry.getDate()) {
        targetM = m + 1;
        if (targetM > 11) { targetM = 0; targetY = y + 1; }
    }

    const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const yy = String(targetY).slice(-2);
    return `NSE:NIFTY${yy}${MONTHS[targetM]}FUT`;
}

async function fetchFyersQuote(symbol = 'NSE:NIFTY50-INDEX') {
    if (!FYERS_ACCESS_TOKEN || !FYERS_APP_ID) return null;

    try {
        const res = await axios.get(
            'https://api-t1.fyers.in/data/quotes',
            {
                params: { symbols: symbol },
                headers: {
                    'Authorization': `${FYERS_APP_ID}:${FYERS_ACCESS_TOKEN}`,
                    'Content-Type' : 'application/json',
                },
                timeout: 8_000,
            }
        );

        if (typeof res.data === 'string' && res.data.includes('<html')) {
            console.warn('[Fyers Quote] HTML response — auth/IP issue');
            return null;
        }

        const d = res.data;
        if (!d || d.s !== 'ok' || !Array.isArray(d.d) || d.d.length === 0) {
            console.warn(`[Fyers Quote] Bad response: s=${d?.s} | code=${d?.code} | msg=${d?.message || ''}`);
            return null;
        }

        const v = d.d[0]?.v;
        if (!v || !v.lp) {
            // DIAGNOSTIC IMPROVEMENT (29 Jul): "No quote data in response" alone
            // gave zero visibility into WHY — logging the raw value object here
            // so the next occurrence shows exactly what Fyers returned (e.g. a
            // differently-named price field for futures vs index quotes, a
            // present-but-zero lp, or a genuinely empty v) instead of guessing.
            console.warn(`[Fyers Quote] No quote data in response for ${symbol} | raw v: ${JSON.stringify(v)} | full d.d[0]: ${JSON.stringify(d.d[0])?.slice(0, 500)}`);
            return null;
        }

        return {
            ltp    : parseFloat(v.lp)           || 0,
            volume : parseInt(v.volume, 10)     || 0,
            open   : parseFloat(v.open_price)   || 0,
            high   : parseFloat(v.high_price)   || 0,
            low    : parseFloat(v.low_price)    || 0,
            close  : parseFloat(v.prev_close_price) || 0,
        };
    } catch (e) {
        console.warn(`[Fyers Quote] error: ${e.response?.status || e.message}`);
        return null;
    }
}

// ── Fyers API PCR ─────────────────────────────────────────────────────────────
// Fetches Nifty option chain from Fyers API v3 → computes PCR, ATM PCR, walls.
// Primary PCR source. Update FYERS_ACCESS_TOKEN daily before 9:15 AM.
async function fetchPCRFromFyers(spotPrice, opts = {}) {
    if (!FYERS_ACCESS_TOKEN || !FYERS_APP_ID) return null;
    if (!spotPrice || spotPrice <= 0) return null;

    const fyersSymbol = opts.fyersSymbol || 'NSE:NIFTY50-INDEX';
    const strikeStep  = opts.strikeStep  || 50;

    try {
        // Fyers option chain — confirmed from official fyers-apiv3 SDK source:
        // URL:    https://api-t1.fyers.in/data/options-chain-v3
        // Method: GET with query params
        // Auth:   "AppID:AccessToken" (NOT Bearer)
        // Header: version: "3" also required
        const res = await axios.get(
            'https://api-t1.fyers.in/data/options-chain-v3',
            {
                params: {
                    symbol     : fyersSymbol,
                    strikecount: 20,
                    timestamp  : '',
                },
                headers: {
                    'Authorization' : `${FYERS_APP_ID}:${FYERS_ACCESS_TOKEN}`,
                    'Content-Type'  : 'application/json',
                    'version'       : '3',
                },
                timeout: 10_000,
            }
        );

        if (typeof res.data === 'string' && res.data.includes('<html')) {
            console.warn('[PCR-Fyers] HTML response — IP block or auth issue');
            return null;
        }

        const d = res.data;
        if (!d || d.s !== 'ok' || !d.data?.optionsChain) {
            console.warn(`[PCR-Fyers] Bad response: s=${d?.s} | code=${d?.code} | msg=${d?.message || JSON.stringify(d)?.slice(0,200)}`);
            return null;
        }

        const chain = d.data.optionsChain;
        if (!chain || chain.length === 0) {
            console.warn('[PCR-Fyers] Empty options chain');
            return null;
        }

        // Fyers returns flat list: each row has option_type="CE" or "PE"
        // Group by strike price first
        const strikeMap = {};
        for (const row of chain) {
            const strike = Number(row.strike_price);
            if (!strikeMap[strike]) strikeMap[strike] = { CE: null, PE: null };
            if (row.option_type === 'CE') strikeMap[strike].CE = row;
            else if (row.option_type === 'PE') strikeMap[strike].PE = row;
        }

        // Compute PCR from grouped map
        let totalCeOI = 0, totalPeOI = 0;
        let ceWall = 0, ceWallStrike = 0, peWall = 0, peWallStrike = 0;
        const atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;
        let atmCeOI = 0, atmPeOI = 0;
        let atmCEpremium = null, atmPEpremium = null;  // FIX: ATM option LTP for buyer/seller card
        const records = [];

        for (const [strikeStr, sides] of Object.entries(strikeMap)) {
            const strike = Number(strikeStr);
            const ceOI   = Number(sides.CE?.oi  || 0);
            const peOI   = Number(sides.PE?.oi  || 0);
            const ceOIch = Number(sides.CE?.oich || 0);
            const peOIch = Number(sides.PE?.oich || 0);
            const ceLtp  = Number(sides.CE?.ltp  || 0);
            const peLtp  = Number(sides.PE?.ltp  || 0);

            totalCeOI += ceOI;
            totalPeOI += peOI;
            if (ceOI > ceWall) { ceWall = ceOI; ceWallStrike = strike; }
            if (peOI > peWall) { peWall = peOI; peWallStrike = strike; }
            if (strike === atmStrike) {
                atmCeOI = ceOI; atmPeOI = peOI;
                if (ceLtp > 0) atmCEpremium = ceLtp;
                if (peLtp > 0) atmPEpremium = peLtp;
            }

            records.push({
                strikePrice : strike,
                CE          : { openInterest: ceOI, changeinOpenInterest: ceOIch, lastPrice: ceLtp },
                PE          : { openInterest: peOI, changeinOpenInterest: peOIch, lastPrice: peLtp },
            });
        }

        if (totalCeOI === 0 && totalPeOI === 0) {
            console.warn('[PCR-Fyers] All OI values zero — market closed or bad data');
            return null;
        }

        const pcr    = totalCeOI > 0 ? +(totalPeOI / totalCeOI).toFixed(3) : 0;
        const atmPcr = atmCeOI   > 0 ? +(atmPeOI   / atmCeOI  ).toFixed(3) : 0;

        // Max pain — strike with minimum total loss for writers
        let maxPain = atmStrike;
        let minLoss = Infinity;
        for (const rec of records) {
            const s = rec.strikePrice;
            let loss = 0;
            for (const r2 of records) {
                loss += r2.CE.openInterest * Math.max(0, r2.strikePrice - s);
                loss += r2.PE.openInterest * Math.max(0, s - r2.strikePrice);
            }
            if (loss < minLoss) { minLoss = loss; maxPain = s; }
        }

        console.log(`[PCR-Fyers] ✅ PCR:${pcr} | ATM PCR:${atmPcr} | ATM:${atmStrike} | CE Wall:${ceWallStrike} | PE Wall:${peWallStrike} | MaxPain:${maxPain} | Strikes:${records.length}`);
        return { pcr, atmPcr, atm: atmStrike, ceWall: ceWallStrike, peWall: peWallStrike, maxPain, records, source: 'fyers', atmCEpremium, atmPEpremium };

    } catch (e) {
        const status = e.response?.status;
        const body   = JSON.stringify(e.response?.data)?.slice(0, 300) || e.message;
        if (status === 401) {
            console.error('[PCR-Fyers] ❌ 401 Unauthorized — FYERS_ACCESS_TOKEN expired! Regenerate token at myapi.fyers.in and update FYERS_ACCESS_TOKEN in Railway Variables.');
            FYERS_ACCESS_TOKEN = null;
        } else if (status === 403) {
            console.error(`[PCR-Fyers] ❌ 403 Forbidden — body: ${body}`);
        } else if (status === 500) {
            console.error(`[PCR-Fyers] ❌ 500 Server Error — body: ${body}`);
        } else {
            console.warn(`[PCR-Fyers] Error: ${status || e.message} — body: ${body}`);
        }
        return null;
    }
}


async function _fetchBankNiftyPCRFallback() {
    const bnSpot = _getBankNiftySpot();
    if (!bnSpot || bnSpot <= 0) {
        console.warn('[PCR-BankNifty] No BankNifty spot price available — skipping fallback');
        return null;
    }

    // Try Fyers first (same priority order as Nifty)
    if (FYERS_ACCESS_TOKEN && FYERS_APP_ID) {
        console.log('[PCR-BankNifty] Trying Fyers...');
        const r = await fetchPCRFromFyers(bnSpot, { fyersSymbol: 'NSE:NIFTYBANK-INDEX', strikeStep: 100 });
        if (r) return { ...r, source: 'banknifty-fyers' };
        console.warn('[PCR-BankNifty] Fyers failed — no further fallback for BankNifty PCR');
    }

    return null;
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

        // ── Path 0: Fyers API — primary PCR source (no IP restriction, 365-day token) ──
        if (FYERS_ACCESS_TOKEN && FYERS_APP_ID) {
            console.log('[PCR] Trying Fyers API...');
            const fyersResult = await fetchPCRFromFyers(spotPrice);
            if (fyersResult) {
                Object.assign(_pcr, {
                    pcr          : fyersResult.pcr,
                    atmPcr       : fyersResult.atmPcr,
                    atm          : fyersResult.atm,
                    ceWall       : fyersResult.ceWall,
                    peWall       : fyersResult.peWall,
                    maxPain      : fyersResult.maxPain,
                    atmCEpremium : fyersResult.atmCEpremium || null,  // FIX
                    atmPEpremium : fyersResult.atmPEpremium || null,  // FIX
                    records      : fyersResult.records || [],  // FIX: was computed (used locally for
                                    // OI-buildup/early-momentum) but never persisted — meant every
                                    // OTM strike premium in Telegram fell back to a Black-Scholes
                                    // estimate instead of the real live LTP already sitting right here.
                    expiryDay    : isExpiryDay(),
                    fetchedAt    : new Date(),
                    lastError    : null,
                    fetchCount   : _pcr.fetchCount + 1,
                    source       : 'fyers',
                    fromIndex    : 'NIFTY',
                });
                try {
                    const oib = calcOIBuildup(fyersResult.records || [], fyersResult.pcr);
                    if (oib) {
                        const oiSignal = interpretOIBuildup(oib);
                        Object.assign(_oiBuildup, oib, {
                            signal: oiSignal.signal, strength: oiSignal.strength,
                            label: oiSignal.label, fetchedAt: new Date(),
                            fetchCount: _oiBuildup.fetchCount + 1,
                        });
                    }
                    const emomRaw = parseEarlyMomentum(fyersResult.records || [], spotPrice);
                    if (emomRaw) {
                        const emSignal = interpretEarlyMomentum({
                            ...emomRaw,
                            topCEbuildup: _oiBuildup.topCEbuildup || [],
                            topPEbuildup: _oiBuildup.topPEbuildup || [],
                            maxCEoiAddStrike: _oiBuildup.maxCEoiAddStrike,
                            maxPEoiAddStrike: _oiBuildup.maxPEoiAddStrike,
                            maxCEoiAdd: _oiBuildup.maxCEoiAdd,
                            maxPEoiAdd: _oiBuildup.maxPEoiAdd,
                        });
                        Object.assign(_earlyMom, emomRaw, {
                            score: emSignal.score, signal: emSignal.signal,
                            strength: emSignal.strength, label: emSignal.label,
                            votes: emSignal.votes, fetchedAt: new Date(),
                        });
                    }
                } catch (_) {}
                return;  // ✅ Fyers success — skip all other paths
            }
            console.warn('[PCR] Fyers path failed — trying Angel/NSE fallback');
        }

        // ── Path A: ScraperAPI — REMOVED (trial ended) ───────────────────
        // Direct NSE below as final fallback

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
                if (res?.status === 200 && res.data) {
                    let d = res.data;
                    // NSE returns HTML (WAF block) even with HTTP 200 — detect and skip
                    if (typeof d === 'string' && d.includes('<html')) {
                        console.warn(`[PCR] Direct NSE returned HTML (IP block) for ${ocUrl.split('/').pop()}`);
                        continue;
                    }
                    // Parse string JSON if needed
                    if (typeof d === 'string') { try { d = JSON.parse(d); } catch(_) {} }

                    // Empty object {} = Railway IP silently blocked by NSE
                    if (d && typeof d === 'object' && Object.keys(d).length === 0) {
                        console.warn(`[PCR] Direct NSE returned empty object (IP block?) for ${ocUrl.split('/').pop()}`);
                        continue;
                    }
                    // NSE response shape variations — normalise all to {records:{data:[]}}:
                    // Shape 1 (indices):  { records: { data: [...] }, filtered: {...} }
                    // Shape 2 (equities): { data: [...], metadata: {...} }
                    // Shape 3 (equities v2): { filtered: { data: [...] } }
                    // Shape 4 (equities v3): { status: true, data: { filtered: { data: [...] } } }
                    if (!d?.records) {
                        if (d?.data && Array.isArray(d.data)) {
                            // Shape 2
                            d.records = { data: d.data, expiryDates: d.metadata?.expiryDates || [] };
                        } else if (d?.filtered?.data && Array.isArray(d.filtered.data)) {
                            // Shape 3
                            d.records = { data: d.filtered.data, expiryDates: d.expiryDates || [] };
                        } else if (d?.data?.filtered?.data && Array.isArray(d.data.filtered.data)) {
                            // Shape 4
                            d.records = { data: d.data.filtered.data, expiryDates: [] };
                        }
                    }
                    if (d?.records?.data && Array.isArray(d.records.data) && d.records.data.length > 0) {
                        pcrData = d;
                        console.log(`[PCR] Direct NSE ✅ (${ocUrl.split('/').pop()}) — ${d.records.data.length} strikes`);
                        break;
                    }
                    // Log body snippet so we can diagnose future format changes
                    console.warn(`[PCR] Direct NSE 200 but no usable data from ${ocUrl.split('/').pop()} — body: ${JSON.stringify(d)?.slice(0, 150)}`);
                }
                console.warn(`[PCR] Direct NSE failed ${ocUrl.split('/').pop()}: ${res?.status ?? 'no-response'}`);
            }

            if (!pcrData) {
                console.warn('[PCR] All Nifty PCR paths failed — trying BankNifty PCR as proxy...');
                const bnResult = await _fetchBankNiftyPCRFallback();
                if (bnResult) {
                    Object.assign(_pcr, {
                        pcr       : bnResult.pcr,
                        atmPcr    : bnResult.atmPcr,
                        atm       : bnResult.atm,
                        ceWall    : bnResult.ceWall,
                        peWall    : bnResult.peWall,
                        maxPain   : bnResult.maxPain,
                        expiryDay : isExpiryDay(),
                        fetchedAt : new Date(),
                        lastError : 'Nifty PCR unavailable — showing BankNifty PCR as proxy',
                        fetchCount: _pcr.fetchCount + 1,
                        source    : bnResult.source,
                        fromIndex : 'BANKNIFTY',
                    });
                    console.log(`[PCR] ✅ BankNifty proxy PCR:${bnResult.pcr} | ATM PCR:${bnResult.atmPcr} (source: ${bnResult.source})`);
                    return;
                }
                _pcr.lastError = 'All PCR URLs failed (NSE 404) — using last cached value';
                console.error('[PCR] All paths failed for all URLs (Nifty + BankNifty). NSE option chain endpoint may have changed.');
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
            source    : 'nse-direct',
            fromIndex : 'NIFTY',
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
    // Backoff: after 3 consecutive timeouts, skip for 60 min before retrying.
    // NSE FII/DII endpoint is reliably blocked from Railway IPs during market hours.
    // Retrying every 15 min just wastes 20s timeout each cycle for no gain.
    _failStreak : 0,
    _backoffUntil: 0,
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

    // Backoff guard: NSE FII/DII endpoint times out from Railway IPs during market hours.
    // After 3 consecutive failures, back off for 60 min to avoid wasting 20s per cycle.
    if (Date.now() < _fii._backoffUntil) {
        const minsLeft = Math.ceil((_fii._backoffUntil - Date.now()) / 60000);
        console.log(`[FII/DII] Backing off — ${minsLeft}m remaining (${_fii._failStreak} consecutive timeouts)`);
        return;
    }

    try {
        // -- Path A: Direct NSE --
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
        _fii._failStreak  = 0;   // reset backoff on success
        _fii._backoffUntil = 0;
        console.log(`💰 [FII/DII] ${parsed.date} | FII Net: ${fmt(parsed.fiiNet)} | DII Net: ${fmt(parsed.diiNet)} [#${_fii.fetchCount}]`);
    } catch (e) {
        _fii.lastError = e.message;
        _fii._failStreak++;
        if (_fii._failStreak >= 3) {
            const backoffMs = 60 * 60 * 1000; // 60 min
            _fii._backoffUntil = Date.now() + backoffMs;
            console.warn(`[FII/DII] ${_fii._failStreak} consecutive failures — backing off 60 min (NSE IP block on Railway)`);
        } else {
            console.error(`[FII/DII] Fetch error (streak ${_fii._failStreak}/3):`, e.message);
        }
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
let _nseSchedulerStarted = false;
let _getBankNiftySpot = () => null;
function startNSEScheduler(getSpotPrice, getBankNiftySpot) {
    if (_nseSchedulerStarted) {
        console.warn('[NSE] startNSEScheduler called more than once — skipping duplicate start');
        return;
    }
    _nseSchedulerStarted = true;
    if (typeof getBankNiftySpot === 'function') _getBankNiftySpot = getBankNiftySpot;
    console.log('[NSE] 🚀 Starting NSE scheduler (PCR: 3 min | FII/DII: 15 min)');

    // Fire first fetches async — intentionally NOT awaited so the app never
    // hangs at startup if NSE is slow or unreachable.  State objects stay at
    // their null/default values until the fetch resolves; getPCRState() and
    // getFIIState() expose _fallback:true in the meantime so the frontend can
    // show "Live data unavailable, market may be closed" instead of spinning.
    // NOTE: Initial _fetchPCR is NOT fired here — it fires from server.js after
    // Angel login completes (so _angelSession is ready for the Angel Market Data path).
    // See: triggerInitialPCR() exported below.
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
    injectAngelSession,   // call after Angel login to enable PCR via Angel Market Data
    triggerInitialPCR,    // call after Angel login to fire first PCR fetch (session ready)

    // Real volume/OHLC for the index (Angel WS Mode 2 sends 0 for index tokens)
    fetchFyersQuote,
    getCurrentFyersFutSymbol,

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
    isNSEHoliday,
};