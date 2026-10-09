'use strict';
const assert = require('assert');
const L = require('../src/utils/entryExitQuality');
const delayLib = require('../src/utils/coachDelayBacktest');

// stub of the Trade-Coach state machine: SL / full exit / time exit (the real one is injected in server.js)
const rnd = x => parseFloat(x.toFixed(2));
const simulate = (entry, path, grid) => {
    if (!(entry > 0) || !path?.length) return null;
    for (const s of path) {
        const pct = (s.premium / entry - 1) * 100;
        if (pct <= grid.slPct) return { coachResult: rnd(pct), coachExitReason: 'stop_loss' };
        if (pct >= grid.fullExitAt) return { coachResult: rnd(pct), coachExitReason: 'full_target' };
    }
    return { coachResult: rnd((path[path.length - 1].premium / entry - 1) * 100), coachExitReason: 'time_exit' };
};
const grid = { name: 'T', slPct: -15, fullExitAt: 25 };
const MIN = 60000, T0 = Date.UTC(2026, 9, 9, 4, 0);
const mk = (id, source, k, pcts) => ({ id, source, fireTs: T0 + k * 3600000, entryPremium: 100, path: pcts.map((p, i) => ({ ts: T0 + k * 3600000 + (i + 1) * 5 * MIN, premium: 100 + p })) });

// ── scoreOutcome
const A = L.scoreOutcome(mk(1, 'X', 0, [4, 8, 12, 26]), simulate, grid);
assert.strictEqual(A.mfe, 26); assert.strictEqual(A.mae, 0); assert.strictEqual(A.reach5, true); assert.strictEqual(A.timeTo5, 10); assert.strictEqual(A.result, 26); assert.strictEqual(A.exitReason, 'full_target');
assert.strictEqual(A.betterEntry, 0); assert.strictEqual(A.touched15ButNegative, false);
const B = L.scoreOutcome(mk(2, 'X', 1, [-6, -3, 6, 12, -2]), simulate, grid);
assert.strictEqual(B.maeBefore5, -6); assert.strictEqual(B.betterEntry, -6); assert.strictEqual(B.result, -2); assert.strictEqual(B.exitReason, 'time_exit');
const C = L.scoreOutcome(mk(3, 'X', 2, [10, 16, 5, -16]), simulate, grid);
assert.strictEqual(C.touched15ButNegative, true); assert.strictEqual(C.timeTo5, 5); assert.strictEqual(C.exitReason, 'stop_loss');
const D = L.scoreOutcome(mk(4, 'X', 3, [-5, -8, -9]), simulate, grid);
assert.strictEqual(D.reach5, false); assert.strictEqual(D.timeTo5, null); assert.strictEqual(D.maeBefore5, -9); assert.strictEqual(D.mfe, 0);
assert.strictEqual(L.scoreOutcome({ id: 9, entryPremium: 0, path: [] }, simulate, grid), null);
assert.strictEqual(L.scoreOutcome(mk(5, 'X', 4, [3]), simulate, grid), null);   // one sample is not a path

// ── summariseTrades
const s = L.summariseTrades([A, B, C, D], 1);
assert.strictEqual(s.n, 4); assert.strictEqual(s.entry.reach5Pct, 75); assert.strictEqual(s.entry.reach10Pct, 75);
assert.strictEqual(s.exit.avgPeakGainPct, 13.5); assert.strictEqual(s.exit.avgResultPct, -0.2); assert.strictEqual(s.exit.captureRatio, 0.15);
assert.strictEqual(s.exit.touched15ButNegative, 1); assert.deepStrictEqual(s.exit.exitReasonMix, { full_target: 1, time_exit: 2, stop_loss: 1 });
assert.strictEqual(s.diagnosis, 'EXIT (reaches +10% but keeps little)');
assert.strictEqual(L.summariseTrades([A, B], 5).diagnosis, 'TOO FEW TRADES');
// entry problem: nothing ever reaches +5%
const bad = [10, 11, 12, 13].map((i, k) => L.scoreOutcome(mk(i, 'Y', 10 + k, [-2, -4, -6]), simulate, grid));
assert.strictEqual(L.summariseTrades(bad, 2).diagnosis, 'ENTRY (rarely goes our way / dips first)');
// healthy: reaches +10 and keeps most of it
const good = [20, 21, 22, 23].map((i, k) => L.scoreOutcome(mk(i, 'Z', 20 + k, [6, 12, 26]), simulate, grid));
assert.strictEqual(L.summariseTrades(good, 2).diagnosis, 'NO CLEAR LEAK');

// ── computeScorecard: groups by source, declusters within a source
const outs = [mk(1, 'X', 0, [4, 8, 12, 26]), mk(2, 'X', 1, [-6, -3, 6, 12, -2]), mk(3, 'X', 2, [10, 16, 5, -16]), mk(4, 'Y', 3, [-5, -8, -9]),
              { ...mk(5, 'X', 0, [4, 8, 12, 26]), fireTs: T0 + 5 * MIN }];   // 5 min after outcome 1 -> dropped by 30-min decluster
const sc = L.computeScorecard(outs, simulate, grid, { minN: 1, declusterMin: 30, decluster: delayLib.declusterOutcomes });
assert.strictEqual(sc.outcomesBeforeDecluster, 5); assert.strictEqual(sc.outcomesUsed, 4);
assert.strictEqual(sc.sources.find(x => x.source === 'X').n, 3); assert.strictEqual(sc.sources.find(x => x.source === 'Y').n, 1);
assert.strictEqual(L.computeScorecard([], simulate, grid, {}).outcomesUsed, 0);

// ── tracker scorecard
const tr = L.computeTrackerScorecard([
    { entry: 100, exit_premium: 150, max_gain_pct: 50, max_adverse_pct: -5, target_hit: true, sl_hit: false, lead_quality: 'Strong Confluence', post_close_max_gain_pct: 10 },
    { entry: 100, exit_premium: 75, max_gain_pct: 12, max_adverse_pct: -25, target_hit: false, sl_hit: true, lead_quality: 'Strong Confluence' },
    { entry: 100, exit_premium: 98, max_gain_pct: 8, max_adverse_pct: -16, target_hit: false, sl_hit: false, lead_quality: 'Moderate' },
    { entry: 0, exit_premium: 98 },
], { minN: 2 });
assert.strictEqual(tr.all.n, 3); assert.strictEqual(tr.all.targetHits, 1); assert.strictEqual(tr.all.slHits, 1); assert.strictEqual(tr.all.timeouts, 1);
assert.strictEqual(tr.all.avgReturnPct, 7.7);
const strong = tr.byLeadQuality.find(q => q.quality === 'Strong Confluence');
assert.strictEqual(strong.n, 2); assert.strictEqual(strong.avgReturnPct, 12.5); assert.strictEqual(strong.captureRatio, 0.4); assert.strictEqual(strong.avgGainAfterCloseWithinShadowWindowPct, 10);
assert.strictEqual(tr.byLeadQuality.find(q => q.quality === 'Moderate').thin, true);

// ── text format does not throw and names the diagnosis
const txt = L.formatScorecardText({ gridUsed: grid, scorecard: sc, tracker: tr });
assert.ok(txt.includes('ENTRY / EXIT SCORECARD') && txt.includes('MTF TRACKER LEADS'));

console.log('entryExitQuality tests passed');