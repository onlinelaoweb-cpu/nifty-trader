'use strict';
const assert = require('assert');
const R = require('../src/utils/fyersTokenReminder');

const jwt = expSec => 'h.' + Buffer.from(JSON.stringify({ exp: expSec })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.s';
const at = (d, h, m) => Date.UTC(2026, 9, d, h, m) - 330 * 60000;          // IST wall clock -> epoch ms (Oct 2026)

// expiry reading
assert.strictEqual(R.tokenExpMs(jwt(1760000000)), 1760000000000);
assert.strictEqual(R.tokenExpMs('abc'), null); assert.strictEqual(R.tokenExpMs(''), null); assert.strictEqual(R.tokenExpMs(null), null); assert.strictEqual(R.tokenExpMs('a.@@@.c'), null);

const mon = d => d;                                                           // 19 Oct 2026 is a Monday
// yesterday's token (expired at 06:00 IST today) -> remind at 08:30
const expired = jwt(Math.floor(at(19, 6, 0) / 1000));
assert.deepStrictEqual(R.decide({ token: expired, nowMs: at(19, 8, 30), sentToday: 0 }), { remind: true, reason: 'token expired' });
// renewed this morning (valid until tomorrow 06:00) -> silent
const fresh = jwt(Math.floor(at(20, 6, 0) / 1000));
assert.strictEqual(R.decide({ token: fresh, nowMs: at(19, 8, 40), sentToday: 0 }).remind, false);
// missing token -> remind; unreadable token -> only the first nudge
assert.strictEqual(R.decide({ token: '', nowMs: at(19, 8, 31), sentToday: 0 }).reason, 'FYERS_ACCESS_TOKEN missing');
assert.strictEqual(R.decide({ token: 'opaque', nowMs: at(19, 8, 31), sentToday: 0 }).remind, true);
assert.strictEqual(R.decide({ token: 'opaque', nowMs: at(19, 9, 1), sentToday: 1 }).remind, false);
// about to expire (within 2h) counts as needing renewal
assert.strictEqual(R.decide({ token: jwt(Math.floor(at(19, 9, 0) / 1000)), nowMs: at(19, 8, 35), sentToday: 0 }).reason, 'token expires within 2 hours');
// slots: first from 08:30, second from 09:00, never more than two; nothing outside 08:30-09:15 or on weekends
assert.strictEqual(R.decide({ token: expired, nowMs: at(19, 8, 45), sentToday: 1 }).remind, false);
assert.strictEqual(R.decide({ token: expired, nowMs: at(19, 9, 0), sentToday: 1 }).remind, true);
assert.strictEqual(R.decide({ token: expired, nowMs: at(19, 9, 5), sentToday: 2 }).remind, false);
assert.strictEqual(R.decide({ token: expired, nowMs: at(19, 8, 29), sentToday: 0 }).remind, false);
assert.strictEqual(R.decide({ token: expired, nowMs: at(19, 9, 15), sentToday: 0 }).remind, false);
assert.strictEqual(R.decide({ token: expired, nowMs: at(17, 8, 45), sentToday: 0 }).reason, 'weekend');         // Sat
assert.strictEqual(R.decide({ token: expired, nowMs: at(18, 8, 45), sentToday: 0 }).reason, 'weekend');         // Sun

// stateful reminder: two messages max per day, resets next day, send errors never throw
(async () => {
    let clock = at(19, 8, 30), tok = expired; const sent = [];
    const rem = R.createReminder({ getToken: () => tok, send: async m => { sent.push(m); }, now: () => clock });
    assert.strictEqual(await rem.tick(), true); assert.strictEqual(sent.length, 1); assert(/Fyers token renew karo/.test(sent[0]));
    clock = at(19, 8, 40); assert.strictEqual(await rem.tick(), false);
    clock = at(19, 9, 0); assert.strictEqual(await rem.tick(), true); assert.strictEqual(sent.length, 2);
    clock = at(19, 9, 10); assert.strictEqual(await rem.tick(), false);
    clock = at(20, 8, 30); tok = jwt(Math.floor(at(21, 6, 0) / 1000)); assert.strictEqual(await rem.tick(), false);   // renewed -> silent
    clock = at(21, 8, 30); tok = expired; const bad = R.createReminder({ getToken: () => tok, send: async () => { throw new Error('tg down'); }, now: () => clock });
    assert.strictEqual(await bad.tick(), true);                                                                           // send failure is swallowed
    console.log('fyersTokenReminder tests OK');
})().catch(e => { console.error(e); process.exit(1); });