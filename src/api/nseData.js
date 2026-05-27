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
 *   interpretPCR(pcr)                 → { signal, strength, label }
 *   interpretFII(netFII, netDII)      → { signal, strength, label }
 *   interpretOIBuildup(state)         → { signal, strength, label }
 *   isExpiryDay()                     true on Nifty weekly expiry (Tuesday)
 */

'use strict';
const axios = require('axios');

// ═══════════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════════

const BASE_URL   = 'https://www.nseindia.com';
const OC_URL     = `${BASE_URL}/api/option-chain-indices?symbol=NIFTY`;
const FIIDII_URL = `${BASE_URL}/api/fiidiiTradeReact`;
const TIMEOUT_MS = 12_000;

const PCR_INTERVAL_MS    =  3 * 60 * 1000;   // re-fetch PCR every 3 min
const FIIDII_INTERVAL_MS = 15 * 60 * 1000;   // re-fetch FII/DII every 15 min
const COOKIE_TTL_MS      = 15 * 60 * 1000;   // proactive cookie re-warm

// NSE will 403 any request that doesn't look like a real browser
const HEADERS = {
    'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept'         : 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer'        : 'https://www.nseindia.com/option-chain',
    'Connection'     : 'keep-alive',
    'DNT'            : '1',
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
            timeout        : TIMEOUT_MS,
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

async function _fetchPCR(spotPrice) {
    if (!spotPrice || spotPrice <= 0) return;
    try {
        const res = await nseGetWithRetry(OC_URL);
        if (res.status !== 200) {
            _pcr.lastError = `HTTP ${res.status}`;
            console.warn(`[PCR] Unexpected status ${res.status}`);
            return;
        }
        const parsed = parsePCR(res.data, spotPrice);
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
            const records  = res.data?.records?.data;
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
    if (!Array.isArray(data) || data.length === 0) return null;

    // Data comes newest-first; group by date and pick the latest
    const byDate = {};
    for (const row of data) {
        const d = row.date || row.Date;
        if (!d) continue;
        if (!byDate[d]) byDate[d] = [];
        byDate[d].push(row);
    }

    // Most recent date
    const latestDate = Object.keys(byDate).sort().reverse()[0];
    if (!latestDate) return null;
    const rows = byDate[latestDate];

    let fiiRow = null, diiRow = null;
    for (const r of rows) {
        const cat = (r.category || r.Category || '').toUpperCase();
        if (cat.includes('FII') || cat.includes('FPI')) fiiRow = r;
        if (cat.includes('DII'))                        diiRow = r;
    }

    // Helper — NSE sometimes uses camelCase, sometimes Title Case
    const num = (obj, ...keys) => {
        if (!obj) return null;
        for (const k of keys) {
            const v = obj[k] ?? obj[k.charAt(0).toUpperCase() + k.slice(1)];
            if (v !== undefined && v !== null) return parseFloat(v);
        }
        return null;
    };

    return {
        date    : latestDate,
        fiiNet  : num(fiiRow, 'netValue',  'net_value',  'NET'),
        fiiBuy  : num(fiiRow, 'buyValue',  'buy_value',  'BUY'),
        fiiSell : num(fiiRow, 'sellValue', 'sell_value', 'SELL'),
        diiNet  : num(diiRow, 'netValue',  'net_value',  'NET'),
        diiBuy  : num(diiRow, 'buyValue',  'buy_value',  'BUY'),
        diiSell : num(diiRow, 'sellValue', 'sell_value', 'SELL'),
    };
}

async function _fetchFIIDII() {
    try {
        const res = await nseGetWithRetry(FIIDII_URL);
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

    // Immediate first fetch
    const spot = getSpotPrice();
    _fetchPCR(spot);
    _fetchFIIDII();

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

function getPCRState()       { return { ..._pcr }; }
function getFIIState()       { return { ..._fii }; }
function getOIBuildupState() { return { ..._oiBuildup }; }

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

    // Scalar getters (for combineSignals)
    getCurrentPCR,
    getCurrentATMPcr,
    getCurrentFIINet,
    getCurrentDIINet,

    // Interpreters (for combineSignals)
    interpretPCR,
    interpretFII,
    interpretOIBuildup,

    // Utilities
    isExpiryDay,
};
