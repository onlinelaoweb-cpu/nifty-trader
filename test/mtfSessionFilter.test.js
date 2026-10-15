'use strict';
const assert = require('assert');
const { filterSessionBars1m } = require('../src/api/multiTimeframe');

// helper: IST hh:mm on 15 Oct 2026 -> epoch ms
const at = (h, m) => Date.UTC(2026, 9, 15, h, m) - 5.5 * 3600 * 1000;
const bar = (h, m) => ({ ts: at(h, m), open: 1, high: 2, low: 1, close: 1.5 });

// 08:55..09:14 junk + 09:15..09:45 real
const bars = [];
for (let m = 55; m < 60; m++) bars.push(bar(8, m));
for (let m = 0; m < 15; m++) bars.push(bar(9, m));
for (let m = 15; m <= 59; m++) bars.push(bar(9, m));
const out = filterSessionBars1m(bars);
assert.strictEqual(out.length, 45);                     // 09:15..09:59
assert.strictEqual(out[0].ts, at(9, 15));
assert.ok(out.every(c => c.ts >= at(9, 15)));

// 15:30 kept, 15:31 dropped
const b2 = [bar(9, 15), bar(9, 16), bar(9, 17), bar(9, 18), bar(9, 19), bar(9, 20), bar(9, 21), bar(9, 22), bar(9, 23), bar(9, 24),
            bar(9, 25), bar(9, 26), bar(9, 27), bar(9, 28), bar(15, 29), bar(15, 30), bar(15, 31)];
const o2 = filterSessionBars1m(b2);
assert.strictEqual(o2.length, 16);
assert.strictEqual(o2[o2.length - 1].ts, at(15, 30));

// fewer than 15 survivors -> unchanged
const few = [bar(8, 55), bar(9, 0), bar(9, 15), bar(9, 16)];
assert.strictEqual(filterSessionBars1m(few), few);

// missing timestamp -> unchanged
const noTs = [bar(9, 15), { open: 1, high: 1, low: 1, close: 1 }];
assert.strictEqual(filterSessionBars1m(noTs), noTs);

// empty / non-array safe
assert.deepStrictEqual(filterSessionBars1m([]), []);
assert.strictEqual(filterSessionBars1m(null), null);

console.log('mtfSessionFilter OK');