'use strict';
const assert = require('assert');
const O = require('../src/utils/orderflowContext');
const E = require('../src/utils/entryContextStudy');

const c = (h, l, cl) => ({ open: cl, high: h, low: l, close: cl });
// lastBarSummary: close at the high -> +1, at the low -> -1, mid -> 0, flat -> 0
assert.strictEqual(O.lastBarSummary([c(101, 99, 100), c(105, 100, 105)], 5).clv, 1);
assert.strictEqual(O.lastBarSummary([c(105, 100, 100), c(105, 100, 100)], 5).clv, -1);
assert.strictEqual(O.lastBarSummary([c(110, 100, 105), c(110, 100, 105)], 5).clv, 0);
assert.strictEqual(O.lastBarSummary([c(100, 100, 100), c(100, 100, 100)], 5).clv, 0);
assert.strictEqual(O.lastBarSummary([c(1, 1, 1)], 5), null); assert.strictEqual(O.lastBarSummary(null), null);

// sweep: wick above PDH 22600 and latest close back below = 'PDH'; still above = null (no reclaim); below PDL and back above = 'PDL'
const base = []; for (let k = 0; k < 10; k++) base.push(c(22590, 22580, 22585));
assert.strictEqual(O.detectPrevDaySweep([...base, c(22612, 22590, 22595), c(22596, 22588, 22590)], 22600, 22400), 'PDH');
assert.strictEqual(O.detectPrevDaySweep([...base, c(22612, 22590, 22610), c(22615, 22605, 22612)], 22600, 22400), null);
const low = []; for (let k = 0; k < 10; k++) low.push(c(22420, 22410, 22415));
assert.strictEqual(O.detectPrevDaySweep([...low, c(22415, 22390, 22398), c(22420, 22398, 22412)], 22600, 22400), 'PDL');
assert.strictEqual(O.detectPrevDaySweep([c(1, 1, 1)], 5, 1), null);
assert.strictEqual(O.detectPrevDaySweep(base, null, null), null);

// buildContextExtras never throws, nulls on bad input
const ex = O.buildContextExtras({ price: 22500, dayHigh: 22600, dayLow: 22400, futVolume: 1234567.8, poc: { poc: 22500, vah: 22550, val: 22450 }, pdh: 22650, pdl: 22350, candles: base });
assert.strictEqual(ex.futVol, 1234568); assert.strictEqual(ex.vah, 22550); assert.strictEqual(ex.sweep, null); assert.strictEqual(ex.pdh, 22650);
assert.doesNotThrow(() => O.buildContextExtras(null)); assert.strictEqual(O.buildContextExtras({}).futVol, null); assert.strictEqual(O.buildContextExtras({ futVolume: 0 }).futVol, null);

// annotateBars: volume steps, day boundary / gap / reset -> null
const T0 = Date.UTC(2026, 9, 8, 4, 0);
const S = [{ ms: T0, futVol: 1000, barClv: 1, nifty: 100 }, { ms: T0 + 300000, futVol: 1500, barClv: 1, nifty: 101 }, { ms: T0 + 1500000, futVol: 2500, barClv: 1, nifty: 102 }, { ms: T0 + 1800000, futVol: 100, barClv: 1, nifty: 103 }];
const A = O.annotateBars(S);
assert.strictEqual(A[0].barVol, null); assert.strictEqual(A[1].barVol, 500); assert.strictEqual(A[1].delta, 500); assert.strictEqual(A[2].barVol, null); assert.strictEqual(A[3].barVol, null);

// priorAvgRange: needs >= 3 earlier days
const days = []; for (let d = 1; d <= 5; d++) days.push({ ms: Date.UTC(2026, 9, d, 8, 0), dayHigh: 22600 + d, dayLow: 22400 + d - 100 * (d % 2) });
const avg = O.priorAvgRange(days, '2026-10-06'); assert.ok(avg > 150 && avg < 300);
assert.strictEqual(O.priorAvgRange(days, '2026-10-03'), null);

// flow classification: 6 steps, each 1000 vol; clv +1 -> CONFIRMED for a call, DIVERGENCE for a put that "progressed"
const mkA = (clv, price0, step) => { const a = []; for (let k = 0; k < 8; k++) a.push({ ms: T0 + k * 300000, nifty: price0 + k * step, barVol: 1000, delta: 1000 * clv, barClv: clv, barRngPct: 0.1, dayHigh: 200, dayLow: 100 }); return a; };
assert.strictEqual(O.classifyFlow(mkA(1, 100, 1), 7, 1), 'CONFIRMED');
assert.strictEqual(O.classifyFlow(mkA(-1, 100, 1), 7, 1), 'DIVERGENCE');     // price up, selling volume, call trade
assert.strictEqual(O.classifyFlow(mkA(-1, 100, -1), 7, 1), 'AGAINST');
assert.strictEqual(O.classifyFlow(mkA(0.05, 100, 1), 7, 1), 'MIXED');
assert.strictEqual(O.classifyFlow(mkA(1, 100, 1), 2, 1), null);

// absorption: 10 normal steps (vol 1000, range 0.2) then a step vol 3000 range 0.05 at the day low
const ab = []; for (let k = 0; k < 10; k++) ab.push({ ms: T0 + k * 300000, nifty: 150, barVol: 1000, barRngPct: 0.2, dayHigh: 200, dayLow: 100 });
ab.push({ ms: T0 + 10 * 300000, nifty: 105, barVol: 3000, barRngPct: 0.05, dayHigh: 200, dayLow: 100 });
assert.strictEqual(O.classifyAbsorption(ab, 10, 1), 'ABSORPTION_AT_EXTREME');
assert.strictEqual(O.classifyAbsorption(ab, 10, -1), 'ABSORPTION');
const ab2 = ab.slice(0, 10); assert.strictEqual(O.classifyAbsorption(ab2, 9, 1), 'NONE');
assert.strictEqual(O.classifyAbsorption(ab.slice(0, 4), 3, 1), null);

// value area / sweep / range buckets
const va = { poc: 22500, vah: 22550, val: 22450 };
assert.strictEqual(O.valueAreaBucket(22600, va, 1), 'ABOVE value area, trade WITH it');
assert.strictEqual(O.valueAreaBucket(22600, va, -1), 'ABOVE value area, trade AGAINST it');
assert.strictEqual(O.valueAreaBucket(22400, va, -1), 'BELOW value area, trade WITH it');
assert.strictEqual(O.valueAreaBucket(22548, va, 1), 'AT value-area edge (VAH/VAL +-0.1%)');
assert.strictEqual(O.valueAreaBucket(22500, va, 1), 'AT POC (+-0.1%)');
assert.strictEqual(O.valueAreaBucket(22560, { poc: 22500, vah: 22650, val: 22350 }, 1), 'inside value area (middle)');
assert.strictEqual(O.valueAreaBucket(22520, {}, 1), null);
assert.ok(O.sweepBucket('PDL', 1).includes('WITH')); assert.ok(O.sweepBucket('PDL', -1).includes('AGAINST')); assert.ok(O.sweepBucket(null, 1).startsWith('no sweep'));
assert.strictEqual(O.rangeUsedBucket(40), 'range used < 50% of usual'); assert.strictEqual(O.rangeUsedBucket(120), 'range used > 100% (already stretched)'); assert.strictEqual(O.rangeUsedBucket(null), null);

// ── integration with the study: trades after a PDL sweep (call) win +20, others -10 ──
const D0 = Date.UTC(2026, 9, 1, 4, 0);
const snaps = [];
for (let d = 0; d < 6; d++) for (let k = 0; k < 60; k++) {
    const ms = D0 + d * 86400000 + k * 300000;
    snaps.push({ ms, nifty: 22500, vwap: 22500, fibDir: null, fibL0: NaN, fibL100: NaN, zone: 'NEUTRAL',
        futVol: 100000 + k * 1000, barClv: 0.5, barRngPct: 0.1, dayHigh: 22600, dayLow: 22400, vah: 22550, val: 22450, poc: 22500,
        sweep: (d >= 3 && k % 2 === 0) ? 'PDL' : null });
}
const trades = [], path = [{ ts: 1, premium: 100 }, { ts: 2, premium: 101 }, { ts: 3, premium: 102 }];
for (let n = 0; n < 60; n++) { const d = 3 + (n % 3), k = 5 + (n * 2) % 50, swept = k % 2 === 0; trades.push({ id: n, source: 'X', direction: 'BULLISH', fireTs: D0 + d * 86400000 + k * 300000 + 60000, entryPrice: 22500, entryPremium: 100, path: path.map(p => ({ ...p })) }); trades[n].win = swept; }
const sim = (e, p) => ({ coachResult: 0 });
let calls = 0; const simByTrade = (entry, pth) => { return { coachResult: 0 }; };
const res = E.computeEntryContextStudy(trades, snaps, (en, pa) => { calls++; return { coachResult: (calls % 2 === 0) ? 20 : -10 }; }, { declusterMin: 0, minN: 5 });
assert.ok(res.bySweep.length >= 1); assert.ok(res.byValueArea.some(b => b.label === 'AT POC (+-0.1%)'));
assert.ok(res.byRangeUsed.length >= 1); assert.ok(res.byFlow.length >= 1); assert.ok(Array.isArray(res.byAbsorption));
assert.ok(res.bySweep.every(b => typeof b.verdict === 'string'));
const txt = E.formatEntryContextText(res); assert.ok(txt.includes('PREVIOUS-DAY HIGH/LOW SWEEP')); assert.ok(txt.includes('VALUE AREA'));
// old snapshots without the new fields: no new slices, no crash
const oldSnaps = snaps.map(s => ({ ms: s.ms, vwap: s.vwap, fibDir: null, fibL0: NaN, fibL100: NaN, zone: 'NEUTRAL' }));
const r2 = E.computeEntryContextStudy(trades, oldSnaps, sim, { declusterMin: 0 });
assert.strictEqual(r2.bySweep.length, 0); assert.strictEqual(r2.byFlow.length, 0); assert.strictEqual(r2.byValueArea.length, 0);
assert.doesNotThrow(() => E.formatEntryContextText(r2));

console.log('orderflowContext tests passed');