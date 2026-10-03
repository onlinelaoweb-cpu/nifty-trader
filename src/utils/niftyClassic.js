// ── NIFTY "Classic" engine — shadow tracker (3 Oct) ──────────────────────
// WHY: since June the live engine gained ~10 extra hard gates (POC, Delta,
// Trend Conviction, Physics Law 1/3, Trend Lock, 60% floor ...) and the number
// of signals fell from "several a day" to ~5 in 20 trading days. Nobody knows
// whether those gates removed good or bad signals. This module re-creates the
// ORIGINAL (June) decision rule IN PARALLEL, never touching the live engine, so
// every Classic signal — fired by the live engine or blocked by a newer gate —
// gets tracked with the same outcome pipeline the Bitcoin triggers use.
//
// "Classic" = the live engine's own raw vote (>=65% one side), passing the 6
// original gates (ADX, MTF all-aligned, RSI, VIX<20, safe window, S/R wall),
// June's confidence rule (>=65 after the ADX<25 cap -> 60 and the 5m-dissent
// cap -> 55, both of which therefore BLOCK) and June's 2-consecutive-cycle
// confirmation. It is a faithful re-creation of the RULE, not June's literal
// code — vote inputs/ADX floors are today's.
//
// Everything here is PURE (clock passed in) so it can be unit-tested.

const CLASSIC_MIN_CONF = 65;

// Newer gates that can turn a Classic signal into a live WAIT, in the order they
// appear in qualityGate. Only flags that HARD-block today are listed
// (contradictionOk / sequenceAligned / breadth... are informational unless
// ALL_FACTORS_HARD_GATE=true, so they are not blame-worthy by default).
const NEW_GATE_KEYS = ['deltaAligned', 'pocClear', 'convictionOk', 'premiumOk', 'physicsLaw1', 'physicsLaw3'];
const NEW_GATE_LABELS = {
    deltaAligned: 'Delta', pocClear: 'POC', convictionOk: 'Trend Conviction', premiumOk: 'Premium already +40%',
    physicsLaw1: 'Physics Law-1', physicsLaw3: 'Physics Law-3', dynLevelsClear: 'Dynamic Levels',
    sequenceAligned: 'Sequence', contradictionOk: 'Contradiction',
    other: 'Confidence floor / confirmation / Trend Lock',
};

// snap = values captured inside combineSignals right after the original gate block:
//   { gateSignal: 'BUY CALL'|'BUY PUT'|'WAIT', confidence, adxVal, mtfAligned, mtfSoft, cautionZone }
// Returns { direction: 'BUY CALL'|'BUY PUT'|null, confidence, why }
function classicCandidate(snap) {
    if (!snap || !snap.gateSignal || snap.gateSignal === 'WAIT') return { direction: null, confidence: 0, why: 'no signal after the 6 original gates' };
    let c = Number(snap.confidence) || 0;
    if (snap.adxVal != null && snap.adxVal < 25) c = Math.min(c, 60);           // June: ADX<25 -> cap 60 (below the 65 floor)
    if (!snap.mtfAligned && snap.mtfSoft)        c = Math.min(c, 55);           // 5m dissenting -> cap 55
    if (snap.cautionZone)                         c = Math.min(c, 70);           // 14:00-14:30 caution cap (still >= 65)
    if (c < CLASSIC_MIN_CONF) return { direction: null, confidence: c, why: `confidence ${c}% < ${CLASSIC_MIN_CONF}%` };
    return { direction: snap.gateSignal, confidence: c, why: null };
}

// Which newer gates are blocking right now? qualityGate = marketState.qualityGate.
// finalSignal = the live engine's final decision at the same moment.
function blockedByNewGates(qualityGate, finalSignal, classicDirection, extra = {}) {
    if (!classicDirection || finalSignal === classicDirection) return [];
    const out = [];
    for (const k of NEW_GATE_KEYS) if (qualityGate && qualityGate[k] === false) out.push(k);
    if (extra.dynLevelsHardBlocked) out.push('dynLevelsClear');
    if (!out.length) out.push('other'); // confidence floor, 2-cycle confirmation, Trend Lock etc. (no per-gate flag exists for those)
    return out;
}

// Stateful dedupe: 2 consecutive cycles to confirm (as June), fire once per
// "run" of the same direction, and at most once per cooldown per direction so a
// flickering signal can't create dozens of rows (the Bitcoin Main Engine had
// exactly that bug).
function createClassicTracker(opts = {}) {
    const cooldownMs = opts.cooldownMs ?? 20 * 60 * 1000;
    const needCycles = opts.needCycles ?? 2;
    let streak = { dir: null, count: 0 };
    let armed = null;                       // direction already fired and still being held
    const lastFire = { 'BUY CALL': -Infinity, 'BUY PUT': -Infinity }; // -Infinity = never fired (0 would read as 'fired at epoch 0')
    return {
        step(direction, nowMs) {
            if (!direction) { streak = { dir: null, count: 0 }; armed = null; return { fire: false }; }
            streak = streak.dir === direction ? { dir: direction, count: streak.count + 1 } : { dir: direction, count: 1 };
            if (streak.count < needCycles) return { fire: false, reason: 'confirming' };
            if (armed === direction) return { fire: false, reason: 'already fired this run' };
            if (nowMs - lastFire[direction] < cooldownMs) return { fire: false, reason: 'cooldown' };
            lastFire[direction] = nowMs; armed = direction;
            return { fire: true };
        },
    };
}

const toDir = d => d === 'BUY CALL' ? 'BULLISH' : d === 'BUY PUT' ? 'BEARISH' : null;
const roundTo = (v, step) => Math.round(v / step) * step;

// Telegram text (HTML). Sent ONLY for Classic signals the live engine did NOT
// fire itself (when it did, its own alert already exists).
function buildClassicMessage({ direction, nifty, confidence, blockedBy, vix, atmStrike, atmPremium, reasons }) {
    const bull = direction === 'BUY CALL';
    const names = (blockedBy || []).map(k => NEW_GATE_LABELS[k] || k).join(', ');
    const lines = [
        `${bull ? '🟢' : '🔴'} <b>CLASSIC ${direction}</b> — NIFTY ${Math.round(nifty)}`,
        `Original 6-filter engine says ${bull ? 'bullish' : 'bearish'} (raw confidence ${confidence}%${vix ? `, VIX ${Number(vix).toFixed(1)}` : ''}).`,
        `🚧 <b>Live engine is holding back</b> — blocked by: ${names || 'n/a'}.`,
    ];
    if (atmStrike) lines.push(`🎯 ATM ${atmStrike} ${bull ? 'CE' : 'PE'}${atmPremium > 0 ? ` @ ₹${Number(atmPremium).toFixed(1)}` : ''} (premium SL -20%, then follow the Trade-Coach exits)`);
    if (Array.isArray(reasons) && reasons.length) lines.push(`ℹ️ ${reasons.slice(0, 2).join(' | ')}`);
    lines.push('⚠️ <b>Experimental</b> — being measured against the live engine; use small size until the track record below proves it.');
    lines.push('<i>Vardaan AI — Classic engine (shadow tracking)</i>');
    return lines.join('\n');
}

module.exports = { CLASSIC_MIN_CONF, NEW_GATE_KEYS, NEW_GATE_LABELS, classicCandidate, blockedByNewGates, createClassicTracker, buildClassicMessage, toDir, roundTo };