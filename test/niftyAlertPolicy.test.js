'use strict';
const assert = require('assert');
const { createNiftyAlertPolicy, parseHHMM, parseIntOr } = require('../src/utils/niftyAlertPolicy');
const ist = (d, h, m) => Date.UTC(2026, 9, d, h, m) - 5.5 * 3600 * 1000;   // 2026-10-<d> h:m IST

// defaults
let p = createNiftyAlertPolicy({});
assert.deepStrictEqual(p.decide('Brahmastra', ist(8, 11, 0)), { live: true, counted: true, reason: null });
assert.strictEqual(p.decide('Fast Momentum', ist(8, 11, 0)).live, false, 'not on allowlist');
assert.strictEqual(p.decide('Brahmastra', ist(8, 9, 40)).live, false, 'before 10:30');
assert.strictEqual(p.decide('Brahmastra', ist(8, 10, 29)).live, false, '10:29 still blocked');
assert.strictEqual(p.decide('Brahmastra', ist(8, 10, 30)).live, true, '10:30 allowed');
assert.strictEqual(p.decide('Classic', ist(8, 9, 20)).live, true, 'Classic exempt even early');
assert.strictEqual(p.decide('Classic', ist(8, 9, 20)).counted, false, 'Classic not counted');

// cap = 3, only recordLive counts
p = createNiftyAlertPolicy({});
for (let i = 0; i < 3; i++) { assert.strictEqual(p.decide('Murarka', ist(8, 11, i)).live, true); p.recordLive(ist(8, 11, i)); }
const capped = p.decide('Brahmastra', ist(8, 12, 0));
assert.strictEqual(capped.live, false); assert.ok(/cap reached \(3\/3\)/.test(capped.reason));
assert.strictEqual(p.decide('Classic', ist(8, 12, 0)).live, true, 'Classic unaffected by cap');
// decide() alone never consumes the cap
p = createNiftyAlertPolicy({});
for (let i = 0; i < 10; i++) p.decide('Murarka', ist(8, 11, 0));
assert.strictEqual(p.status(ist(8, 11, 0)).today.liveSent, 0);
// next IST day resets
p = createNiftyAlertPolicy({}); for (let i = 0; i < 3; i++) p.recordLive(ist(8, 11, 0));
assert.strictEqual(p.decide('Murarka', ist(8, 12, 0)).live, false);
assert.strictEqual(p.decide('Murarka', ist(9, 11, 0)).live, true, 'new day resets');
// IST midnight boundary uses IST, not UTC: 23:50 IST d8 and 00:10 IST d9 are different days
p = createNiftyAlertPolicy({ NIFTY_NO_LIVE_BEFORE: '00:00' }); for (let i = 0; i < 3; i++) p.recordLive(ist(8, 23, 50));
assert.strictEqual(p.decide('Murarka', ist(9, 0, 10)).live, true);

// env overrides
p = createNiftyAlertPolicy({ NIFTY_LIVE_ALERT_SOURCES: 'ALL', NIFTY_NO_LIVE_BEFORE: '10:00', NIFTY_MAX_LIVE_ALERTS_PER_DAY: '0' });
assert.strictEqual(p.decide('Fast Momentum', ist(8, 10, 0)).live, true);
assert.strictEqual(p.decide('Fast Momentum', ist(8, 9, 59)).live, false);
for (let i = 0; i < 50; i++) p.recordLive(ist(8, 11, 0));
assert.strictEqual(p.decide('Fast Momentum', ist(8, 11, 1)).live, true, 'cap 0 = no cap');
p = createNiftyAlertPolicy({ NIFTY_ALERT_POLICY: 'off' });
assert.deepStrictEqual(p.decide('ORB', ist(8, 9, 16)), { live: true, counted: false, reason: null });
p = createNiftyAlertPolicy({ NIFTY_LIVE_ALERT_SOURCES: '' });
assert.strictEqual(p.decide('Brahmastra', ist(8, 11, 0)).live, false, 'empty allowlist = nothing live (except exempt)');

// bad input falls back to defaults
assert.strictEqual(parseHHMM('abc', 630), 630); assert.strictEqual(parseHHMM('25:00', 630), 630); assert.strictEqual(parseHHMM('9:45', 630), 585);
assert.strictEqual(parseIntOr('x', 3), 3); assert.strictEqual(parseIntOr('-2', 3), 3); assert.strictEqual(parseIntOr('0', 3), 0);
console.log('niftyAlertPolicy: all tests passed');