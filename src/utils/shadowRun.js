'use strict';
// Isolated "what-if" run helper (17 Oct). Used by the Main Engine 09:15-10:00 shadow log:
// run a function that WRITES to shared state objects (marketState, orbState, ...), capture its return
// value, then put every touched object back exactly as it was. Pure: no I/O, no clock.
//
// What is restored: every top-level key of each target (value reference), plus one level of nesting for
// plain-object values (e.g. marketState.physicsOfTrading.bosChoch = ... mutates an existing object).
// What is NOT restored: anything deeper than two levels, arrays mutated in place, or module-level
// variables outside the targets - the caller must list those explicitly (see server.js).

function isPlain(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function snapshot(obj) {
    const keys = Object.keys(obj);
    const top = {};
    const nested = [];
    for (const k of keys) {
        const v = obj[k];
        top[k] = v;
        if (isPlain(v)) nested.push({ ref: v, copy: { ...v } });
    }
    return { keys: new Set(keys), top, nested };
}

function restore(obj, snap) {
    for (const k of Object.keys(obj)) if (!snap.keys.has(k)) delete obj[k];
    for (const k of snap.keys) obj[k] = snap.top[k];
    for (const { ref, copy } of snap.nested) {
        for (const k of Object.keys(ref)) if (!(k in copy)) delete ref[k];
        Object.assign(ref, copy);
    }
}

// targets: array of plain state objects. fn: synchronous function. Returns { ok, value, error }.
// State is restored even if fn throws. fn must be synchronous - an async fn would let other code run
// between the snapshot and the restore.
function runIsolated(targets, fn) {
    const snaps = targets.map(t => snapshot(t));
    try {
        const value = fn();
        if (value && typeof value.then === 'function') throw new Error('runIsolated: fn must be synchronous');
        return { ok: true, value, error: null };
    } catch (e) {
        return { ok: false, value: null, error: e && e.message ? e.message : String(e) };
    } finally {
        targets.forEach((t, i) => restore(t, snaps[i]));
    }
}

// Throttle + window decision for the shadow log. nowIstMinutes: minutes since 00:00 IST. lastRunMs: epoch ms of
// the previous shadow run (0 if none). Window is the Main Engine's Gate 1 "volatile" block: 09:15 <= t < 10:00.
function shouldRunShadow({ enabled, nowIstMinutes, isTradingDay, nowMs, lastRunMs, minGapMs }) {
    if (!enabled || !isTradingDay) return false;
    if (!Number.isFinite(nowIstMinutes) || nowIstMinutes < 555 || nowIstMinutes >= 600) return false;
    if (Number.isFinite(lastRunMs) && lastRunMs > 0 && (nowMs - lastRunMs) < (minGapMs || 60000)) return false;
    return true;
}

// Compact, DB-safe summary of one shadow result (what the Main Engine would have said with the time block off).
function summarizeShadow(result, marketSnap) {
    const r = result || {};
    const vt = (marketSnap && marketSnap.voteTally) || {};
    const qg = (marketSnap && marketSnap.qualityGate) || {};
    const sig = typeof r.signal === 'string' ? r.signal : 'WAIT';
    const conf = Number.isFinite(Number(r.confidence)) ? Math.round(Number(r.confidence)) : 0;
    return {
        signal: sig,
        confidence: conf,
        wouldFire: sig !== 'WAIT' && conf > 0,
        bull: Number.isFinite(Number(vt.bull)) ? Number(vt.bull) : null,
        bear: Number.isFinite(Number(vt.bear)) ? Number(vt.bear) : null,
        bullPct: Number.isFinite(Number(vt.bullPct)) ? Number(vt.bullPct) : null,
        reasons: Array.isArray(r.reasons) ? r.reasons.slice(0, 8).map(x => String(x).slice(0, 160)) : [],
        gate: {
            passed: qg.passed === true ? true : (qg.passed === false ? false : null),
            mtfAligned: qg.mtfAligned ?? null, rsiClean: qg.rsiClean ?? null, vixSafe: qg.vixSafe ?? null,
            adxTrend: qg.adxTrend ?? null, srClear: qg.srClear ?? null,
        },
    };
}

module.exports = { isPlain, snapshot, restore, runIsolated, shouldRunShadow, summarizeShadow };