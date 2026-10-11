'use strict';
const assert = require('assert');
const R = require('../src/utils/renkoStudy');
const { renkoAlignedFor } = require('../src/api/renko');

let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let s = 0; for (let i = 0; i < 12; i++) s += rnd(); return s - 6; };
function series(n, phi) { // daily returns with autocorrelation phi
    const out = []; let p = 20000, prev = 0;
    for (let i = 0; i < n; i++) { const r = phi * prev + gauss() * 0.008; const o = p, c = p * (1 + r); out.push({ date: 'd' + i, open: o, high: Math.max(o, c) * 1.002, low: Math.min(o, c) * 0.998, close: c }); p = c; prev = r; }
    return out;
}

// alignment rule == the server gate rule
assert.strictEqual(renkoAlignedFor('BULLISH', true), true);
assert.strictEqual(renkoAlignedFor('BULLISH', false), false);
assert.strictEqual(renkoAlignedFor('BEARISH', false), true);
assert.strictEqual(renkoAlignedFor('BEARISH', true), false);
assert.strictEqual(renkoAlignedFor('NOISY', true), false);
assert.strictEqual(renkoAlignedFor('MIXED', false), false);
assert.strictEqual(renkoAlignedFor('INSUFFICIENT', true), true);
assert.strictEqual(renkoAlignedFor(undefined, true), true);

// a clean up-trend ends in a BULLISH state, a clean down-trend in BEARISH
const up = Array.from({ length: 60 }, (_, i) => ({ date: 'u' + i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i * 1.2 }));
assert.strictEqual(R.renkoStates(up, (t, b) => b * 0.004).slice(-1)[0], 'BULLISH');
const dn = up.map((c, i) => ({ ...c, close: 200 - i * 1.2 }));
assert.strictEqual(R.renkoStates(dn, (t, b) => b * 0.004).slice(-1)[0], 'BEARISH');

// pure random walk: no edge
const rw = R.runRenkoStudy(series(2500, 0), { minN: 30 });
assert.ok(rw.variants.length === 4 && rw.candles === 2500);
assert.ok(/NO EDGE|SOME SEPARATION/.test(rw.verdict), rw.verdict);
const maxZ = Math.max(...rw.variants.flatMap(v => v.results.map(x => Math.abs(x.z ?? 0))));
assert.ok(maxZ < 3.5, 'random walk should not show a big z, got ' + maxZ);

// strongly persistent returns: Renko BULLISH state should precede better next-day returns than BEARISH
const mom = R.runRenkoStudy(series(2500, 0.45), { minN: 30 });
const best = mom.variants.flatMap(v => v.results).find(x => x.h === 1 && x.z !== null);
assert.ok(best && best.edgeBullVsBear > 0 && best.z > 2, 'momentum series should show separation: ' + JSON.stringify(best && { e: best.edgeBullVsBear, z: best.z }));
assert.ok(/SOME SEPARATION/.test(mom.verdict));
assert.ok(R.formatRenkoText(mom).includes('VERDICT'));
assert.ok(/NOT ENOUGH DATA/.test(R.runRenkoStudy(series(40, 0)).verdict));

// journal comparison
const mk = (src, aligned, trend, pct) => ({ source: src, direction: 'BULLISH', realized_pct: pct, ctx: { renko: { trend, aligned, brickSize: 15 } } });
let rows = []; for (let i = 0; i < 40; i++) { rows.push(mk('Fast Momentum', true, 'BULLISH', 8 + gauss() * 6)); rows.push(mk('Fast Momentum', false, 'NOISY', -6 + gauss() * 6)); }
let js = R.summarizeByRenko(rows);
assert.strictEqual(js.passedGate.n, 40); assert.strictEqual(js.failedGate.n, 40); assert.ok(js.z > 5 && /did better/.test(js.verdict), js.verdict);
assert.ok(js.byTrend.NOISY.n === 40 && js.bySource['Fast Momentum'].passed.n === 40);
rows = []; for (let i = 0; i < 40; i++) { rows.push(mk('X', true, 'BULLISH', gauss() * 8)); rows.push(mk('X', false, 'MIXED', gauss() * 8)); }
assert.ok(/NO CLEAR DIFFERENCE/.test(R.summarizeByRenko(rows).verdict));
assert.ok(/NOT ENOUGH DATA/.test(R.summarizeByRenko(rows.slice(0, 10)).verdict));
assert.strictEqual(R.summarizeByRenko([{ source: 'a', realized_pct: 3, ctx: null }, { source: 'a', realized_pct: null, ctx: { renko: { trend: 'BULLISH', aligned: true } } }]).closedWithRenko, 0);
assert.ok(R.formatJournalText(js).includes('PASSED gate'));
console.log('renkoStudy tests passed');