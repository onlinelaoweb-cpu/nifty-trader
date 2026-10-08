'use strict';
// ── NIFTY live-alert policy (7 Oct 2026) ───────────────────────────────────────────────────────────
// WHY: the data (regime study / signal accuracy, 16 trading days) shows no NIFTY exploratory trigger with
// a proven edge, ~10 triggers alerting independently = over-trading, and the 09:15-10:30 window alone has
// a pooled Trade-Coach average of -2.1% (median -12%, only 29% of trades positive).
// WHAT: decides whether a NIFTY exploratory trigger may send a LIVE (instant) Telegram alert. When it
// may not, the caller sends it to the existing batched digest instead. Nothing is dropped from tracking:
// the fire is still logged, tracked and scored, so the effect of this policy stays measurable.
//
// Rules, in order (first match wins):
//   1. NIFTY_ALERT_POLICY=off              -> everything live (old behaviour)
//   2. source in NIFTY_POLICY_EXEMPT       -> live, not counted (default: Classic — it has its own daily cap)
//   2b. source in NIFTY_LIVE_PRIORITY_SOURCES -> live, not counted, NEVER held by the early-session rule or the daily cap
//                                             (default: Brahmastra — the one trigger with a consistent record; 8 Oct, so a
//                                             proven signal is not blocked just because other alerts used up the cap).
//                                             Set it to empty (NIFTY_LIVE_PRIORITY_SOURCES=) to switch this off.
//   3. NIFTY_LIVE_ALERT_SOURCES            -> only these sources may be live (default: Brahmastra,Murarka).
//                                             "ALL" disables just this rule.
//   4. before NIFTY_NO_LIVE_BEFORE (IST)   -> digest (default 10:30)
//   5. NIFTY_MAX_LIVE_ALERTS_PER_DAY       -> after this many live alerts today, digest (default 3; 0 = no cap)
// The daily counter lives in memory (resets at IST midnight and on restart). PURE otherwise: the clock is passed in.

const IST_MS = 5.5 * 3600 * 1000;

function parseList(v, dflt) {
    const raw = (v === undefined || v === null) ? dflt : String(v);
    return raw.split(',').map(x => x.trim()).filter(Boolean);
}
function parseHHMM(v, dfltMin) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
    if (!m) return dfltMin;
    const h = Number(m[1]), mi = Number(m[2]);
    return (h >= 0 && h < 24 && mi >= 0 && mi < 60) ? h * 60 + mi : dfltMin;
}
function parseIntOr(v, dflt) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
}
const istDay = ms => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istMinute = ms => { const d = new Date(ms + IST_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hhmm = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function createNiftyAlertPolicy(env = process.env) {
    const enabled = String(env.NIFTY_ALERT_POLICY || 'on').toLowerCase() !== 'off';
    const liveList = parseList(env.NIFTY_LIVE_ALERT_SOURCES, 'Brahmastra,Murarka');
    const allowAll = liveList.some(x => x.toUpperCase() === 'ALL');
    const liveSources = new Set(liveList);
    const exempt = new Set(parseList(env.NIFTY_POLICY_EXEMPT, 'Classic'));
    const priority = new Set(parseList(env.NIFTY_LIVE_PRIORITY_SOURCES, 'Brahmastra'));
    const noLiveBeforeMin = parseHHMM(env.NIFTY_NO_LIVE_BEFORE, 10 * 60 + 30);
    const maxLive = parseIntOr(env.NIFTY_MAX_LIVE_ALERTS_PER_DAY, 3);
    const state = { day: null, live: 0, digested: 0 };

    function rollDay(nowMs) {
        const d = istDay(nowMs);
        if (state.day !== d) { state.day = d; state.live = 0; state.digested = 0; }
    }

    // -> { live: boolean, counted: boolean, reason: string|null }
    function decide(source, nowMs = Date.now()) {
        rollDay(nowMs);
        if (!enabled) return { live: true, counted: false, reason: null };
        if (exempt.has(source)) return { live: true, counted: false, reason: null };
        if (priority.has(source)) return { live: true, counted: false, reason: null };   // priority: bypasses allowlist, early hold and cap
        if (!allowAll && !liveSources.has(source)) {
            return { live: false, counted: false, reason: `${source} is not on the live allowlist (${[...liveSources].join(', ') || 'empty'})` };
        }
        if (istMinute(nowMs) < noLiveBeforeMin) {
            return { live: false, counted: false, reason: `before ${hhmm(noLiveBeforeMin)} IST — early-session signals have been the weakest window` };
        }
        if (maxLive > 0 && state.live >= maxLive) {
            return { live: false, counted: false, reason: `daily live-alert cap reached (${state.live}/${maxLive})` };
        }
        return { live: true, counted: true, reason: null };
    }
    function recordLive(nowMs = Date.now()) { rollDay(nowMs); state.live++; }
    function recordDigested(nowMs = Date.now()) { rollDay(nowMs); state.digested++; }
    function status(nowMs = Date.now()) {
        rollDay(nowMs);
        return {
            enabled, liveSources: allowAll ? 'ALL' : [...liveSources], exempt: [...exempt], prioritySources: [...priority],
            noLiveBefore: hhmm(noLiveBeforeMin), maxLivePerDay: maxLive || 'no cap',
            today: { day: state.day, liveSent: state.live, sentToDigestByPolicy: state.digested },
        };
    }
    return { decide, recordLive, recordDigested, status };
}

module.exports = { createNiftyAlertPolicy, parseList, parseHHMM, parseIntOr, istMinute, istDay };