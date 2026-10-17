'use strict';
const assert = require('assert');
const C = require('../public/js/fyers-card.js');
assert.strictEqual(C.statusLine(null).level, 'warn');
assert.strictEqual(C.statusLine({ configured: false }).level, 'bad');
assert.strictEqual(C.statusLine({ configured: true, hasToken: false }).level, 'bad');
assert.strictEqual(C.statusLine({ configured: true, hasToken: true, valid: null }).level, 'warn');
const exp = C.statusLine({ configured: true, hasToken: true, valid: false, expiresAt: '2026-10-17 06:00 IST' });
assert.strictEqual(exp.level, 'bad'); assert(/expire ho chuka/.test(exp.text));
const ok = C.statusLine({ configured: true, hasToken: true, valid: true, expiresAt: '2026-10-18 06:00 IST', minutesLeft: 406 });
assert.strictEqual(ok.level, 'ok'); assert(/6 ghante/.test(ok.text));
const soon = C.statusLine({ configured: true, hasToken: true, valid: true, expiresAt: 'x', minutesLeft: 45 });
assert.strictEqual(soon.level, 'warn'); assert(/45 min/.test(soon.text));
assert(!/<script/i.test(C.statusLine({ configured: true, hasToken: true, valid: false, expiresAt: '<script>' }).text));   // escaped
assert.strictEqual(typeof C.render, 'function');
console.log('fyersCard tests OK');