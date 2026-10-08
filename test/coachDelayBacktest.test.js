'use strict';
const assert = require('assert');
const L = require('../src/utils/coachDelayBacktest');

// stub of the Trade-Coach state machine (SL / full exit / time exit) — the real one is injected in server.js
const simulate = (entry, path, grid) => {
    if (!(entry > 0) || !path?.length) return null;
    for (const s of path) {
        const pct = (s.premium / entry - 1) * 100;
        if (pct <= grid.slPct) return { coachResult: pct };
        if (pct >= grid.fullExitAt) return { coachResult: pct };
    }
    return { coachResult: (path[path.length - 1].premium / entry - 1) * 100 };
};
const grid = { slPct: -15, fullExitAt: 25 };
const MIN = 60000, T0 = Date.UTC(2026, 9, 1, 4, 0);
const mk = (i, premiums) => ({ id: i, source: 'A', fireTs: T0 + i * 3600000, entryPremium: 100, path: premiums.map((p, k) => ({ ts: T0 + i * 3600000 + (k * 5 + 1) * MIN, premium: p })) });
const GOOD = [100, 110, 125, 140, 150], BAD = [100, 92, 80, 70, 60];
const outcomes = [];
for (let i = 0; i < 60; i++) outcomes.push(mk(i, i % 2 ? BAD : GOOD));

const out = L.computeDelayBacktest(outcomes, simulate, grid, { minHalfN: 10 });
assert.strictEqual(out.outcomesUsed, 60);
const v = (d, c) => out.variants.find(x => x.delayMin === d && x.confirmPctAboveEntry === c);
// baseline per signal: good -> +40? (first threshold crossed: 125 -> +25), bad -> -15 (92 is -8, 80 is -20 -> -20). Check exact numbers:
const base = (25 + -20) / 2;
assert.strictEqual(v(5, 0).baselinePerSignalAvg, base);
// confirm >= 0% after 5 min: bad signals (premium 92 at +6min) are skipped, good ones entered at 110
assert.strictEqual(v(5, 0).skipped, 30); assert.strictEqual(v(5, 0).entered, 30);
assert.strictEqual(v(5, 0).skippedSignalsIfTheyHadBeenTaken.avg, -20);
assert.ok(v(5, 0).delta > 0, 'filter should help in this synthetic set');
assert.strictEqual(v(5, 0).verdict, 'BEATS BASELINE IN BOTH HALVES — a lead worth paper-testing, not proof');
// no filter: everything entered; waiting only costs (bad entry at 92 still ends at SL, good entry at 110 is worse than 100)
assert.strictEqual(v(5, null).entered, 60); assert.strictEqual(v(5, null).skipped, 0);
// results sorted by delta, best first
for (let i = 1; i < out.variants.length; i++) assert.ok(out.variants[i - 1].delta >= out.variants[i].delta);
// confirm +5% (good moved +10%) still enters the good ones; +20% skips everything
const strict = L.computeDelayBacktest(outcomes, simulate, grid, { minHalfN: 10, confirms: [5, 20], delays: [5] });
assert.strictEqual(strict.variants.find(x => x.confirmPctAboveEntry === 5).entered, 30);
assert.strictEqual(strict.variants.find(x => x.confirmPctAboveEntry === 20).entered, 0);
assert.strictEqual(strict.variants.find(x => x.confirmPctAboveEntry === 20).perSignalAvg, 0);

// insufficient sample -> honest verdict
const tiny = L.computeDelayBacktest(outcomes.slice(0, 6), simulate, grid, { minHalfN: 30 });
assert.ok(/^INSUFFICIENT/.test(tiny.variants[0].verdict));

// de-clustering: same source 10 min apart -> second dropped; different source kept
const a = mk(1, GOOD), b = { ...mk(1, GOOD), id: 99, fireTs: a.fireTs + 10 * MIN }, c2 = { ...b, id: 100, source: 'B' };
assert.strictEqual(L.declusterOutcomes([a, b, c2], 30).length, 2);
assert.strictEqual(L.declusterOutcomes([a, b, c2], 0).length, 3);

// bad inputs are ignored, not crashed on
const junk = [mk(1, [100, 101]), { id: 5, source: 'A', fireTs: T0, entryPremium: 0, path: [] }, null, mk(2, [100, 105, 110]),
    { id: 7, source: 'A', fireTs: NaN, entryPremium: 100, path: GOOD.map((p, k) => ({ ts: k, premium: p })) }];
const j = L.computeDelayBacktest(junk, simulate, grid, { minHalfN: 1 });
assert.strictEqual(j.outcomesBeforeDecluster, 1, 'only the 3-sample outcome with valid fields is usable');
// a delay beyond the last sample leaves nothing to trade -> outcome is not testable for that variant
const late = L.computeDelayBacktest([mk(2, [100, 105, 110])], simulate, grid, { delays: [15], confirms: [null], minHalfN: 1 });
assert.strictEqual(late.variants[0].signals, 0);
console.log('coachDelayBacktest: all tests passed');