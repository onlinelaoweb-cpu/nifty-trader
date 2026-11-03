'use strict';
/**
 * sahi.js — Sahi broker API, READ-ONLY market data (3 Nov 2026).
 *
 * SAFETY
 *  • Token is minted with scope ['marketdata.read'] only → it cannot place orders even if leaked.
 *  • No order endpoint exists in this file. Nothing here feeds signals/journals: it only shadows
 *    (logs a comparison against the app's live numbers) until we decide otherwise.
 *  • OFF unless SAHI_ENABLED=1 and SAHI_KEY_ID / SAHI_SECRET / SAHI_TOTP_SECRET are set.
 *  • Secrets, TOTP codes and tokens are never logged.
 *
 * Doc facts used: prices are integer paise; quotes/ltp keyed by instrument_id (string);
 * ltp & quotes 1 req/s (100 ids each); candles 2/s; optionchain 2/s & 120/min;
 * token lives to 06:00 IST, no refresh → mint again; TOTP key: key_id + secret + 6-digit totp.
 * Auth/API base URLs are NOT in the public docs (email developers@sahi.com) → env SAHI_AUTH_URL /
 * SAHI_API_URL. Defaults below are a best guess (SDK talks to apis.sahi.com) and are unverified.
 */
const axios = require('axios');
const { TOTP, Secret } = require('otpauth');

const NIFTY_INDEX_ID_FALLBACK = 10854;           // from Sahi docs sample (Nifty 50 index)
const SCRIP_URL = 'https://assets.sahi.com/external/instruments.csv';

function cfg() {
    return {
        enabled : String(process.env.SAHI_ENABLED || '') === '1',
        keyId   : (process.env.SAHI_KEY_ID || '').trim(),
        secret  : (process.env.SAHI_SECRET || '').trim(),
        totp    : (process.env.SAHI_TOTP_SECRET || '').trim(),
        authUrl : (process.env.SAHI_AUTH_URL || 'https://apis.sahi.com').replace(/\/+$/, ''),
        apiUrl  : (process.env.SAHI_API_URL  || 'https://apis.sahi.com').replace(/\/+$/, ''),
    };
}
function isConfigured() { const c = cfg(); return !!(c.keyId && c.secret && c.totp); }

// ── tiny rate limiter: keep a minimum gap between calls of the same kind ─────
const MIN_GAP_MS = { ltp: 1100, quotes: 1100, candles: 550, chain: 550, expiries: 250 };
const _lastCall = {};
let _sleep = (ms) => new Promise(r => setTimeout(r, ms));
let _now = () => Date.now();
async function _throttle(kind) {
    const gap = MIN_GAP_MS[kind] || 500;
    const wait = (_lastCall[kind] || 0) + gap - _now();
    _lastCall[kind] = Math.max(_now(), (_lastCall[kind] || 0) + gap);   // reserve the slot so parallel callers queue up
    if (wait > 0) await _sleep(wait);
}

// ── auth ─────────────────────────────────────────────────────────────────────
let _tok = null;            // { access_token, expMs }
let _mintBlockedUntil = 0;  // backoff after a failed mint (wrong TOTP is rate-limited: 10/min)
let _mintInflight = null;
const stats = { mints: 0, mintFails: 0, lastError: null, calls: 0, httpErrors: 0 };

function _code(secretB32) {
    return new TOTP({ secret: Secret.fromBase32(secretB32.toUpperCase().replace(/\s/g, '')), digits: 6, period: 30, algorithm: 'SHA1' }).generate();
}

async function mintToken(force) {
    if (!force && _tok && _tok.expMs - _now() > 60 * 1000) return _tok.access_token;
    if (_mintInflight) return _mintInflight;
    if (_now() < _mintBlockedUntil) throw new Error('sahi mint backoff');
    const c = cfg();
    if (!isConfigured()) throw new Error('sahi not configured');
    _mintInflight = (async () => {
        try {
            const r = await axios.post(c.authUrl + '/api/v1/apikeys/token',
                { key_id: c.keyId, secret: c.secret, totp: _code(c.totp), scopes: ['marketdata.read'] },
                { timeout: 10000, headers: { 'Content-Type': 'application/json' } });
            const d = r.data || {};
            if (!d.access_token) throw new Error('mint: no access_token');
            const expMs = d.expires_at ? Date.parse(d.expires_at) : _now() + (d.expires_in || 3600) * 1000;
            _tok = { access_token: d.access_token, expMs };
            stats.mints++;
            return _tok.access_token;
        } catch (e) {
            stats.mintFails++;
            const st = e.response && e.response.status, code = e.response && e.response.data && e.response.data.code;
            // 401 InvalidTotp/Unauthorized, 403 not approved, 429 → wait a minute before touching it again
            _mintBlockedUntil = _now() + 65 * 1000;
            stats.lastError = `mint ${st || ''} ${code || e.message}`.trim();
            throw new Error(stats.lastError);
        } finally { _mintInflight = null; }
    })();
    return _mintInflight;
}

async function _get(kind, path, params) {
    await _throttle(kind);
    const c = cfg();
    for (let attempt = 0; attempt < 2; attempt++) {
        const token = await mintToken(attempt === 1);
        try {
            stats.calls++;
            const r = await axios.get(c.apiUrl + path, { params, timeout: 10000, headers: { Authorization: 'Bearer ' + token }, paramsSerializer: _ser });
            return r.data;
        } catch (e) {
            const st = e.response && e.response.status;
            if (st === 401 && attempt === 0) { _tok = null; continue; }   // expired/revoked → mint once more
            stats.httpErrors++;
            stats.lastError = `${path} ${st || ''} ${(e.response && e.response.data && e.response.data.code) || e.message}`.trim();
            throw new Error(stats.lastError);
        }
    }
}
// repeat params for arrays: i=1&i=2
function _ser(p) {
    return Object.entries(p || {}).flatMap(([k, v]) => Array.isArray(v) ? v.map(x => `${encodeURIComponent(k)}=${encodeURIComponent(x)}`) : (v === undefined || v === null ? [] : [`${encodeURIComponent(k)}=${encodeURIComponent(v)}`])).join('&');
}

// ── scrip master ─────────────────────────────────────────────────────────────
function parseCsv(text) {            // RFC 4180: quotes, escaped quotes, commas/newlines inside quotes
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
        else if (ch === '"') q = true;
        else if (ch === ',') { row.push(f); f = ''; }
        else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
        else if (ch !== '\r') f += ch;
    }
    if (f.length || row.length) { row.push(f); rows.push(row); }
    if (!rows.length) return [];
    const head = rows[0].map(h => h.trim());
    return rows.slice(1).filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
}

let _scrip = null;
async function loadScrip() {          // public file, no auth; cached per IST day by caller restart (server restarts daily anyway)
    if (_scrip && _now() - _scrip.at < 12 * 3600 * 1000) return _scrip;
    const r = await axios.get(SCRIP_URL, { timeout: 30000, responseType: 'text', transformResponse: x => x });
    const rows = parseCsv(String(r.data || ''));
    const idx = {};
    for (const x of rows) if (x.instrument_type === 'IDX') idx[(x.company_name || '').toLowerCase()] = Number(x.id);
    _scrip = { at: _now(), rows: rows.length, indices: idx };
    return _scrip;
}
async function niftyIndexId() {
    try { const s = await loadScrip(); return s.indices['nifty 50'] || NIFTY_INDEX_ID_FALLBACK; } catch (e) { return NIFTY_INDEX_ID_FALLBACK; }
}

// ── market data (all values converted from paise → rupees) ───────────────────
const R = (p) => (p === null || p === undefined) ? null : p / 100;

async function getLtp(ids) {
    const list = [].concat(ids).slice(0, 100);
    const d = await _get('ltp', '/v1/marketdata/ltp', { i: list });
    const out = {};
    for (const id of list) { const v = d && d.data && d.data[String(id)]; out[id] = v ? { ltp: R(v.last_trade_price), ts: v.last_trade_time || null } : null; }
    return out;
}
async function getQuotes(ids) {
    const list = [].concat(ids).slice(0, 100);
    const d = await _get('quotes', '/v1/marketdata/quotes', { i: list });
    const out = {};
    for (const id of list) {
        const v = d && d.data && d.data[String(id)];
        out[id] = v ? { ltp: R(v.last_trade_price), ts: v.last_trade_time || null, volume: v.volume_today, oi: v.open_interest, prevOi: v.prev_open_interest,
                        bids: (v.best_buys || []).map(b => ({ price: R(b.price), qty: b.qty })), asks: (v.best_sells || []).map(b => ({ price: R(b.price), qty: b.qty })) } : null;
    }
    return out;
}
async function getCandles(id, size, fromMs, toMs, opts) {
    const d = await _get('candles', '/v1/marketdata/candles', { instrument_id: id, size, from: fromMs, to: toMs, include_partial: !!(opts && opts.partial), oi: !!(opts && opts.oi) });
    return ((d && d.candles) || []).map(c => ({ time: c[0], open: R(c[1]), high: R(c[2]), low: R(c[3]), close: R(c[4]), volume: c[5], oi: c.length > 6 ? c[6] : undefined }));
}
async function getExpiries(underlyingId) {
    const d = await _get('expiries', '/v1/marketdata/optionchain/expiries', { underlying_id: underlyingId });
    return (d && d.expiries) || [];
}
async function getOptionChain(underlyingId, expiry) {
    const d = await _get('chain', '/v1/marketdata/optionchain', { underlying_id: underlyingId, expiry });
    const leg = (l) => l ? { id: l.instrument_id, ltp: R(l.last_trade_price), vol: l.volume_today, oi: l.open_interest, prevOi: l.prev_open_interest, iv: l.implied_volatility, delta: l.greeks ? l.greeks.delta : null } : null;
    return { expiry: d.expiry, spot: R(d.last_price), strikes: (d.strikes || []).map(s => ({ strike: R(s.strike), ce: leg(s.ce), pe: leg(s.pe) })) };
}

// PCR (total OI), ATM-window PCR (±atmN strikes), OI change since prev day, biggest OI walls.
function chainStats(chain, atmN) {
    const n = atmN || 5, ss = (chain && chain.strikes) || [];
    if (!ss.length) return null;
    const sum = (arr, f) => arr.reduce((a, s) => a + (f(s) || 0), 0);
    const ceOi = sum(ss, s => s.ce && s.ce.oi), peOi = sum(ss, s => s.pe && s.pe.oi);
    const spot = chain.spot;
    let atm = null;
    if (spot) atm = ss.reduce((b, s) => (b === null || Math.abs(s.strike - spot) < Math.abs(b.strike - spot)) ? s : b, null);
    const ai = atm ? ss.indexOf(atm) : -1;
    const win = ai >= 0 ? ss.slice(Math.max(0, ai - n), ai + n + 1) : [];
    const wCe = sum(win, s => s.ce && s.ce.oi), wPe = sum(win, s => s.pe && s.pe.oi);
    const top = (side) => ss.reduce((b, s) => (s[side] && (s[side].oi || 0) > (b ? b[side].oi : -1)) ? s : b, null);
    const tc = top('ce'), tp = top('pe');
    return {
        expiry: chain.expiry, spot, atmStrike: atm ? atm.strike : null, strikes: ss.length,
        ceOi, peOi, pcr: ceOi > 0 ? +(peOi / ceOi).toFixed(3) : null, atmPcr: wCe > 0 ? +(wPe / wCe).toFixed(3) : null,
        ceOiChg: sum(ss, s => s.ce && s.ce.oi) - sum(ss, s => s.ce && s.ce.prevOi), peOiChg: sum(ss, s => s.pe && s.pe.oi) - sum(ss, s => s.pe && s.pe.prevOi),
        callWall: tc ? tc.strike : null, putWall: tp ? tp.strike : null,
    };
}

// ── shadow compare (display/log only) ────────────────────────────────────────
const shadow = { n: 0, sumAbs: 0, maxAbs: 0, chainN: 0, lastChain: null };
function shadowSummary() { return shadow.n ? { samples: shadow.n, avgAbsNifty: +(shadow.sumAbs / shadow.n).toFixed(2), maxAbsNifty: +shadow.maxAbs.toFixed(2), chainSamples: shadow.chainN } : { samples: 0 }; }

function startShadow(getState, opts) {
    if (!cfg().enabled) { console.log('[Sahi] shadow OFF (SAHI_ENABLED!=1)'); return null; }
    if (!isConfigured()) { console.log('[Sahi] SAHI_ENABLED=1 but SAHI_KEY_ID / SAHI_SECRET / SAHI_TOTP_SECRET missing — shadow not started'); return null; }
    const every = (opts && opts.everyMs) || 60 * 1000;
    let tick = 0, lastWarn = 0, lastSummaryDay = '';
    const warn = (m) => { if (Date.now() - lastWarn > 10 * 60 * 1000) { lastWarn = Date.now(); console.warn('[Sahi] ' + m); } };
    console.log('[Sahi] shadow ON — read-only, scope marketdata.read');
    return setInterval(async () => {
        try {
            const st = getState(), ist = st.ist, mins = ist.getHours() * 60 + ist.getMinutes(), dow = ist.getDay();
            const live = dow >= 1 && dow <= 5 && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 31;
            const day = ist.getFullYear() + '-' + (ist.getMonth() + 1) + '-' + ist.getDate();
            if (!live) {   // one summary line after close
                if (mins > 15 * 60 + 40 && dow >= 1 && dow <= 5 && shadow.n && lastSummaryDay !== day) { lastSummaryDay = day; console.log('[Sahi] day summary ' + JSON.stringify(shadowSummary()) + ' | ' + JSON.stringify({ mints: stats.mints, mintFails: stats.mintFails, httpErrors: stats.httpErrors, calls: stats.calls, last: stats.lastError })); }
                return;
            }
            tick++;
            const id = await niftyIndexId();
            const t0 = Date.now();
            const l = (await getLtp([id]))[id];
            const ms = Date.now() - t0;
            if (!l || !l.ltp) { warn('nifty ltp empty'); return; }
            const app = st.nifty, diff = app ? l.ltp - app : null;
            if (diff !== null) { shadow.n++; shadow.sumAbs += Math.abs(diff); shadow.maxAbs = Math.max(shadow.maxAbs, Math.abs(diff)); }
            let chainTxt = '';
            if (tick % 5 === 1) {   // option chain every ~5 min (limit is 120/min, we use 12/hour)
                const ex = await getExpiries(id);
                if (ex.length) {
                    const cs = chainStats(await getOptionChain(id, ex[0]));
                    if (cs) { shadow.chainN++; shadow.lastChain = cs; chainTxt = ` | chain ${cs.expiry} PCR ${cs.pcr} (app ${st.pcr ?? '-'}) atmPCR ${cs.atmPcr} (app ${st.atmPcr ?? '-'}) walls C${cs.callWall}/P${cs.putWall}`; }
                }
            }
            if (tick % 5 === 1 || (diff !== null && Math.abs(diff) > 15)) console.log(`[Sahi] nifty ${l.ltp} vs app ${app ?? '-'} diff ${diff === null ? '-' : diff.toFixed(2)} | ${ms}ms${chainTxt}`);
        } catch (e) { warn('shadow tick failed: ' + e.message); }
    }, every);
}

module.exports = {
    isConfigured, mintToken, getLtp, getQuotes, getCandles, getExpiries, getOptionChain, chainStats,
    parseCsv, loadScrip, niftyIndexId, startShadow, shadowSummary, status: () => ({ ...stats, tokenOk: !!(_tok && _tok.expMs > _now()), shadow: shadowSummary() }),
    _t: { reset() { _tok = null; _mintBlockedUntil = 0; _mintInflight = null; for (const k of Object.keys(_lastCall)) delete _lastCall[k]; stats.mints = stats.mintFails = stats.calls = stats.httpErrors = 0; }, setClock(now, sleep) { _now = now; _sleep = sleep; } },
};