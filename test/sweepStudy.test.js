'use strict';
const assert = require('assert');
const { runSweepStudy, formatSweepText } = require('../src/utils/sweepStudy');
// flat base at 100 (low 99, high 101), then day 6: low 98 undercuts, close 100.5 reclaims -> bull sweep; then +5% drift
const base = Array.from({ length: 6 }, (_, i) => ({ date: `d${i}`, open: 100, high: 101, low: 99, close: 100 }));
const c = [...base, { date: 'sw', open: 100, high: 101, low: 98, close: 100.5 }, { date: 'n1', open: 100.5, high: 106, low: 100, close: 105 }, ...Array.from({ length: 6 }, (_, i) => ({ date: 'x' + i, open: 105, high: 106, low: 104.5, close: 105 }))];
let s = runSweepStudy(c, { lookbacks: [5], horizons: [1] });
assert.strictEqual(s.variants[0].counts.bullSweep, 1);
assert.strictEqual(s.variants[0].counts.breakdown, 0);
assert.ok(Math.abs(s.variants[0].rows[0].bullSweepFwd.meanPct - 4.48) < 0.05, JSON.stringify(s.variants[0].rows[0].bullSweepFwd));
// a TRUE break (closes below level) is the placebo, not a sweep
const d = [...base, { date: 'bd', open: 100, high: 100.5, low: 97, close: 97.5 }, { date: 'n', open: 97.5, high: 98, low: 96, close: 96.5 }];
s = runSweepStudy(d, { lookbacks: [5], horizons: [1] });
assert.strictEqual(s.variants[0].counts.breakdown, 2); assert.strictEqual(s.variants[0].counts.bullSweep, 0);   // the follow-on day also closes below the (new) level
// bear sweep: high exceeds, closes back under -> counted as bear sweep, fall counts positive
const e = [...base, { date: 'bs', open: 100, high: 103, low: 99.5, close: 100 }, { date: 'n', open: 100, high: 100, low: 95, close: 96 }];
s = runSweepStudy(e, { lookbacks: [5], horizons: [1] });
assert.strictEqual(s.variants[0].counts.bearSweep, 1);
assert.ok(s.variants[0].rows[0].bearSweepFwd_downIsPositive.meanPct > 3.5);
// junk rows dropped, too little data -> verdict, text renders
s = runSweepStudy([{ date: 'a', open: 'x', high: 1, low: 1, close: 1 }]);
assert.strictEqual(s.candles, 0); assert.strictEqual(s.verdict, 'NOT ENOUGH DATA');
assert.ok(formatSweepText(s).includes('VERDICT'));
console.log('sweepStudy tests passed');