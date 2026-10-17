'use strict';
// ── Fyers daily-token reminder (17 Oct 2026) ─────────────────────────────────────────────────────────────────────────────
// Fyers access tokens expire every day at ~06:00 IST (Fyers' written reply, 16 Oct). The app cannot renew it by itself (manual 2FA login), so on a
// weekday morning it sends ONE Telegram nudge at/after 08:30 IST - and one more at/after 09:00 - ONLY if the token in the environment is missing or
// already expired / about to expire. If the token was renewed (a fresh expiry far enough ahead) it stays silent. Nothing else changes: no API call,
// no trading rule. The expiry is read from the token itself (a JWT 'exp' claim; the signature is NOT checked - this is only a reminder).

const IST_MS = 330 * 60000;
function istParts(ms) {
    const d = new Date(ms + IST_MS);
    return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}

// expiry in ms, or null when the token is not a readable JWT
function tokenExpMs(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length < 2) return null;
        const json = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        const e = Number(json.exp);
        return Number.isFinite(e) && e > 0 ? e * 1000 : null;
    } catch (e) { return null; }
}

// { remind: bool, reason } - sentToday = how many reminders were already sent on this IST day
function decide({ token, nowMs, sentToday = 0, minAheadMs = 2 * 3600 * 1000 }) {
    const p = istParts(nowMs);
    if (p.dow < 1 || p.dow > 5) return { remind: false, reason: 'weekend' };
    if (p.min < 8 * 60 + 30 || p.min >= 9 * 60 + 15) return { remind: false, reason: 'outside 08:30-09:15 IST' };
    const slot = p.min >= 9 * 60 ? 2 : 1;                       // first nudge from 08:30, second from 09:00
    if (sentToday >= slot) return { remind: false, reason: 'already sent for this slot' };
    if (!token) return { remind: true, reason: 'FYERS_ACCESS_TOKEN missing' };
    const exp = tokenExpMs(token);
    if (exp === null) return slot === 1 ? { remind: true, reason: 'token expiry not readable' } : { remind: false, reason: 'token expiry not readable (already nudged once)' };
    if (exp - nowMs < minAheadMs) return { remind: true, reason: exp < nowMs ? 'token expired' : 'token expires within 2 hours' };
    return { remind: false, reason: 'token is fresh' };
}

function buildMessage(reason) {
    return `🔑 <b>Fyers token renew karo</b> (9:15 se pehle)\nAbhi: ${reason}.\nRenew karke Railway mein <code>FYERS_ACCESS_TOKEN</code> update karo. Token ke bina PCR, futures volume aur crude history band rehte hain.`;
}

// stateful helper used by the server timer: createReminder({ getToken, send, now }).tick()
function createReminder({ getToken, send, now = Date.now, log = () => {} }) {
    const S = { day: null, sent: 0 };
    async function tick() {
        const t = now(), day = istParts(t).day;
        if (S.day !== day) { S.day = day; S.sent = 0; }
        const d = decide({ token: getToken(), nowMs: t, sentToday: S.sent });
        if (!d.remind) return false;
        S.sent++;
        try { await send(buildMessage(d.reason)); log(`[FyersReminder] sent (${d.reason})`); } catch (e) { log(`[FyersReminder] send failed: ${e.message}`); }
        return true;
    }
    return { tick, _state: S };
}

module.exports = { tokenExpMs, decide, buildMessage, createReminder };