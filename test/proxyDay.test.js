'use strict';
const assert = require('assert');
const P = require('../src/utils/proxyDay');

// 2026-10-16 (Fri) 09:15 IST = 03:45Z. Build 5-min snapshots with cumulative futures volume.
const t0 = Date.UTC(2026, 9, 16, 3, 45);
const mk = (i, vol, clv, nifty, rng = 0.1) => ({ ms: t0 + i * 5 * 60000, nifty, futVol: vol, barClv: clv, barRngPct: rng, dayHigh: 23200, dayLow: 23000 });
// i=0 is 09:15 (no previous step -> no delta). Steps i=1..: each adds 1000 volume, clv +1 => delta +1000, clv -0.5 => -500
const snaps = [mk(0, 5000, 0, 23100), mk(1, 6000, 1, 23101), mk(2, 7000, 1, 23102), mk(3, 8000, -0.5, 23099),   // 09:20,09:25,09:30
    mk(4, 9000, 1, 23105), mk(5, 10000, 1, 23108), mk(6, 11000, 1, 23110)];                                  // 09:35,09:40,09:45
const r = P.buildProxyDay(snaps, '2026-10-16');
assert.strictEqual(r.snapshots, 7); assert.strictEqual(r.usableSteps, 6); assert.strictEqual(r.gapSteps, 0);   // the 09:15 snapshot itself closes no bar
assert.deepStrictEqual(r.bins.map(b => b.time), ['09:15', '09:30']);
// 09:15 bar: steps ending 09:20 (+1000), 09:25 (+1000), 09:30 (-500) -> delta 1500 (step ending 09:30 belongs to the 09:15 bar); the 09:15 snapshot closes no bar
assert.strictEqual(r.bins[0].volume, 3000); assert.strictEqual(r.bins[0].delta, 1500); assert.strictEqual(r.bins[0].cumDelta, 1500); assert.strictEqual(r.bins[0].gaps, 0);
assert.strictEqual(r.bins[1].volume, 3000); assert.strictEqual(r.bins[1].delta, 3000); assert.strictEqual(r.bins[1].cumDelta, 4500);
assert.strictEqual(r.bins[1].deltaShare, 1);
assert.strictEqual(r.bins[1].open, 23099); assert.strictEqual(r.bins[1].close, 23110); assert.strictEqual(r.bins[1].chgPts, 11);
// other day is excluded; empty / bad input never throws
assert.strictEqual(P.buildProxyDay(snaps, '2026-10-15').bins.length, 0);
assert.strictEqual(P.buildProxyDay(null, '2026-10-16').bins.length, 0);
assert(/No usable bars/.test(P.formatProxyDayText(P.buildProxyDay([], '2026-10-16'))));
// a gap > 8 minutes gives no delta (not a guess)
const gap = [mk(0, 5000, 0, 23100), mk(1, 6000, 1, 23101), { ...mk(4, 9000, 1, 23105) }];
const rg = P.buildProxyDay(gap, '2026-10-16'); assert.strictEqual(rg.usableSteps, 1); assert.strictEqual(rg.gapSteps, 1);
// volume reset (cumulative goes down) gives no delta
const rs = P.buildProxyDay([mk(0, 9000, 0, 23100), mk(1, 100, 1, 23101)], '2026-10-16'); assert.strictEqual(rs.usableSteps, 0);
// absorption: 8 normal steps (vol 1000, range 0.2), then a step with vol 3000 and range 0.05 -> flagged
const ab = []; let v = 1000;
for (let i = 0; i < 9; i++) { ab.push(mk(i, v, 0.2, 23100 + i, 0.2)); v += 1000; }
ab.push(mk(9, v + 2000, 0.2, 23109, 0.05));
const ra = P.buildProxyDay(ab, '2026-10-16'); assert(ra.bins.some(b => b.absorption === 'ABSORPTION' || b.absorption === 'AT_DAY_LOW' || b.absorption === 'AT_DAY_HIGH'));
assert(P.formatProxyDayText(r).includes('NOT a footprint'));
console.log('proxyDay tests passed');