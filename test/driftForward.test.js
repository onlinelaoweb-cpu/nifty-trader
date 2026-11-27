'use strict';
const assert = require('assert');
const D = require('../src/utils/driftForward');
const MIN = 60000, T0 = Date.parse('2026-11-30T04:00:00Z');
const mk = (i, premiums, src = 'Sustained Drift') => ({ id: i, source: src, fireTs: T0 + i * 3600000, entryPremium: 100,
    path: premiums.map((p, k) => ({ ts: T0 + i * 3600000 + k * 5 * MIN, premium: p })) });
// empty / wrong source ignored
assert.strictEqual(D.evaluate([], { startTs: T0 }).status, 'COLLECTING');
assert.strictEqual(D.evaluate([mk(1, [100, 110, 120], 'ORB')], { startTs: T0 }).trades, 0);
// before start ignored
assert.strictEqual(D.evaluate([mk(-5, [100, 110, 120])], { startTs: T0 }).trades, 0);
// stop-loss: -15% -> exit at -15% of premium
let r = D.evaluate([mk(1, [100, 95, 84])], { startTs: T0 });
assert.strictEqual(r.trades, 1); assert.ok(r.netTotalRs < 0);
// winner: runs to +40% then trails out -> positive
r = D.evaluate([mk(1, [100, 110, 122, 135, 140, 126, 120])], { startTs: T0 });
assert.ok(r.netTotalRs > 0, 'trail should lock profit');
// cost model: flat trade loses costs
r = D.evaluate([mk(1, [100, 100, 100, 100])], { startTs: T0, rule: { exit: { slPct: -15, halfAt: 20, beAt: 20, fullAt: null, trailGap: 12 } } });
assert.ok(r.netTotalRs < 0 && Math.abs(r.netTotalRs) < 400);
// pass / fail logic with tiny criteria
const wins = Array.from({ length: 6 }, (_, i) => mk(i + 1, [100, 110, 122, 135, 140, 126, 120]));
const crit = { minTrades: 5, minDays: 1, minProfitFactor: 1.2, maxBestTradeSharePct: 50 };
r = D.evaluate(wins, { startTs: T0, criteria: crit }); assert.strictEqual(r.status, 'PASS'); assert.ok(r.checks.every(c => c.ok));
const losses = Array.from({ length: 6 }, (_, i) => mk(i + 1, [100, 95, 84]));
assert.strictEqual(D.evaluate(losses, { startTs: T0, criteria: crit }).status, 'FAIL');
// declustering: two signals 10 min apart count once
const a = mk(1, [100, 110, 122, 135]), b = { ...mk(1, [100, 110, 122, 135]), id: 99, fireTs: a.fireTs + 10 * MIN };
assert.strictEqual(D.evaluate([a, b], { startTs: T0 }).trades, 1);
// text output renders
assert.ok(/FORWARD TEST #3/.test(D.formatText(D.evaluate(wins, { startTs: T0, criteria: crit }), { start: '2026-11-30' })));
console.log('driftForward tests passed');
