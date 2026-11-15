'use strict';
const assert = require('assert');
const T = require('../src/utils/trendShadow');
const mk = (arr) => arr.map((c, i) => ({ ts: 't' + i, o: c, h: c + 5, l: c - 5, c }));
assert.strictEqual(T.compute(mk([1, 2, 3])).state, 'NO_DATA');
// sma
assert.deepStrictEqual(T.sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
// steady uptrend -> LONG
const up = mk(Array.from({ length: 80 }, (_, i) => 100 + i * 3));
const r = T.compute(up);
assert.strictEqual(r.state, 'LONG'); assert.ok(r.open.floating > 0); assert.strictEqual(r.stDir, 1);
// uptrend then sharp drop -> closed LONG trade, then SHORT/FLAT
const dn = mk([...Array.from({ length: 70 }, (_, i) => 100 + i * 3), ...Array.from({ length: 25 }, (_, i) => 310 - i * 12)]);
const r2 = T.compute(dn);
assert.ok(r2.trades.length >= 1 && r2.trades[0].side === 'LONG');
assert.ok(['SHORT', 'FLAT'].includes(r2.state));
// parseAngel drops forming bar
const now = Date.parse('2026-11-13T11:30:00+05:30');
const rows = [['2026-11-13T09:15:00+05:30', 1, 2, 1, 2, 0], ['2026-11-13T10:15:00+05:30', 1, 2, 1, 2, 0], ['2026-11-13T11:15:00+05:30', 1, 2, 1, 2, 0]];
assert.strictEqual(T.parseAngel(rows, now).length, 2);
console.log('trendShadow ok');
