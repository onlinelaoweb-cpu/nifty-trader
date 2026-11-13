'use strict';
/**
 * sahiFallback.js — LAST-RESORT Nifty spot (LTP) from Sahi, read-only (13 Nov 2026).
 *
 * WHEN IT RUNS
 *  • Only from pollYahooPrice(), and only AFTER the normal chain (fetchMarketData: Fyers/NSE/Yahoo)
 *    returned no price AND the Angel WS is silent. If the primary gives a price this file is never called,
 *    so the app's data is byte-for-byte unchanged on a healthy day.
 *  • OFF unless SAHI_FALLBACK=1 (and SAHI_ENABLED=1 + Sahi keys, same as the shadow).
 *
 * WHAT IT DOES NOT DO
 *  • Spot/LTP only. No option chain, no PCR, no OI, no candles → nothing here can reach a gate.
 *    (Sahi PCR is the full chain, the app's PCR is ~42 strikes: different basis, so it stays out.)
 *  • No order endpoint (sahi.js has none; token scope is marketdata.read).
 *  • Never throws; returns null on anything doubtful.
 *
 * SAFETY CHECKS on every price: finite & > 0; last_trade_time (if Sahi gives one) not older than
 * maxAgeMs; price within maxJumpPct of the last price the app already trusted (bad-tick guard).
 */
const sahi = require('./sahi');

const stats = { used: 0, rejected: 0, errors: 0, lastUsedAt: null, lastReject: null };
let _lastLog = 0;
const _log = (m) => { if (Date.now() - _lastLog > 60 * 1000) { _lastLog = Date.now(); console.warn('[Sahi-Fallback] ' + m); } };

function enabled() {
    return String(process.env.SAHI_FALLBACK || '') === '1' && String(process.env.SAHI_ENABLED || '') === '1' && sahi.isConfigured();
}

// Pure check — exported for tests. Returns { ok, price, reason }.
function validate(l, o) {
    const now = (o && o.now) || Date.now(), maxAgeMs = (o && o.maxAgeMs) || 90 * 1000, maxJump = (o && o.maxJumpPct) || 1.5;
    if (!l || typeof l.ltp !== 'number' || !isFinite(l.ltp) || l.ltp <= 0) return { ok: false, reason: 'empty ltp' };
    if (l.ts) {
        const t = typeof l.ts === 'number' ? l.ts : Date.parse(l.ts);
        if (isFinite(t) && now - t > maxAgeMs) return { ok: false, reason: 'stale ' + Math.round((now - t) / 1000) + 's' };
    }
    const ref = o && o.lastKnown;
    if (ref > 0 && Math.abs(l.ltp - ref) / ref * 100 > maxJump) return { ok: false, reason: `jump ${l.ltp} vs last ${ref}` };
    return { ok: true, price: l.ltp };
}

// → { price, ms } or null. opts: { lastKnown, now }
async function getNiftySpot(opts) {
    if (!enabled()) return null;
    try {
        const id = await sahi.niftyIndexId();
        const t0 = Date.now();
        const l = (await sahi.getLtp([id]))[id];
        const ms = Date.now() - t0;
        const v = validate(l, opts);
        if (!v.ok) { stats.rejected++; stats.lastReject = v.reason; _log('rejected Sahi price: ' + v.reason); return null; }
        stats.used++; stats.lastUsedAt = new Date().toISOString();
        _log(`primary gave no price — using Sahi LTP ${v.price} (${ms}ms)`);
        return { price: v.price, ms };
    } catch (e) {
        stats.errors++; _log('failed: ' + e.message);
        return null;
    }
}

module.exports = { enabled, validate, getNiftySpot, status: () => ({ ...stats, enabled: enabled() }) };
