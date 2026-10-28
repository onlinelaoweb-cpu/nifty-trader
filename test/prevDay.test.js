'use strict';
const assert = require('assert');
const { pickPrevDayBar, isoDate } = require('../src/utils/prevDay');
const bars = [
  { date: '2026-10-26', open: 22600, high: 22700, low: 22550, close: 22640 },
  { date: '2026-10-27', open: 22660, high: 22810, low: 22620, close: 22749.75 },   // yesterday
  { date: '2026-10-28', open: 22678, high: 22778, low: 22498, close: 22712 },      // today (running) — must NOT be used
];
let b = pickPrevDayBar(bars, '2026-10-28', 22749.75);
assert.deepStrictEqual([b.high, b.low, b.close], [22810, 22620, 22749.75]);
// yesterday missing -> last bar is 26th, close does not match previousClose -> reject (caller falls back)
assert.strictEqual(pickPrevDayBar([bars[0], bars[2]], '2026-10-28', 22749.75), null);
// only today -> null
assert.strictEqual(pickPrevDayBar([bars[2]], '2026-10-28', 22749.75), null);
// NSE-style date string, unsorted input
b = pickPrevDayBar([bars[2], { ...bars[1], date: '27-Oct-2026' }], '2026-10-28', 22749.75);
assert(b && b.high === 22810);
assert.strictEqual(isoDate('garbage'), null);
// no prevClose known -> still picks last prior day
assert(pickPrevDayBar(bars, '2026-10-28', NaN).high === 22810);
console.log('prevDay ok');