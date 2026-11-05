'use strict';
const assert = require('assert');
const C = require('../src/utils/counterTrendStudy');

assert.strictEqual(C.sideOf('BULLISH'), 1); assert.strictEqual(C.sideOf('BEARISH'), -1); assert.strictEqual(C.sideOf('PE'), -1); assert.strictEqual(C.sideOf('WAIT'), null);
const sn = [{ ms: 0 }, { ms: 300000 }];
assert.strictEqual(C.snapshotAtOrBefore(sn, 400000, 420000), 1); assert.strictEqual(C.snapshotAtOrBefore(sn, 2000000, 420000), -1);

// trendAt: price 0.5% above VWAP (+1), day move +0.8% (+1), MTF BUY CALL (+1) -> +3 ; needs >= 2 signs
assert.strictEqual(C.trendAt(22610, { vwap: 22500, mtfSignal: 'BUY CALL' }, 22430).score, 3);
assert.strictEqual(C.trendAt(22400, { vwap: 22500, mtfSignal: 'BUY PUT' }, 22500).score, -3);        // -0.44% vs VWAP, -0.44% day, PUT -> all three down
assert.strictEqual(C.trendAt(22500, { vwap: 22500, mtfSignal: 'WAIT' }, 22500).score, 0);            // all neutral
assert.strictEqual(C.trendAt(22500, { vwap: NaN, mtfSignal: null }, 0), null);                          // < 2 signs

// ── scenario: 40 days-worth of alerts. Up-trend snapshots (price above VWAP, +0.8% on the day, MTF BUY CALL):
// CALL alerts win +20, PUT alerts (against trend) lose -15. Down-trend snapshots mirror it.
const T0 = Date.UTC(2026, 9, 8, 4, 0);                          // 09:30 IST
const mkPath = (e) => [0, 1, 2, 3].map(i => ({ ts: 10 + i, premium: e }));
const snaps = [], trades = [];
for (let d = 0; d < 10; d++) {
    const base = T0 + d * 86400000, up = d % 2 === 0;
    const open = 22500, px = up ? 22680 : 22320, vwap = up ? 22560 : 22440;       // +-0.8% on the day, +-0.5% vs VWAP
    snaps.push({ ms: base - 600000, nifty: open, vwap: open, mtfSignal: 'WAIT' });  // first snapshot of the day
    for (let k = 0; k < 6; k++) snaps.push({ ms: base + k * 300000, nifty: px, vwap, mtfSignal: up ? 'BUY CALL' : 'BUY PUT' });
    for (let k = 0; k < 4; k++) {
        const dir = k % 2 === 0 ? 'BULLISH' : 'BEARISH', side = dir === 'BULLISH' ? 1 : -1;
        trades.push({ id: d * 10 + k, source: k < 2 ? 'Brahmastra' : 'Murarka', direction: dir, fireTs: base + k * 360000 + 60000, entryPrice: px, entryPremium: 100, path: mkPath(100), _with: (up ? 1 : -1) === side });
    }
}
// the simulator cannot see the trade, so key the result on the path marker: put WITH/AGAINST into path[0].ts
for (const t of trades) t.path[0].ts = t._with ? 1 : 2;   // 1 / 2 are unique markers (other samples use ts >= 10)
const simW = (entry, path) => ({ coachResult: path.find(p => p.ts === 1) ? 20 : -15 });
const res = C.computeCounterTrendStudy(trades, snaps, simW, { tolMin: 7, declusterMin: 0, minN: 10 });
assert.strictEqual(res.tradesUsed, 40); assert.strictEqual(res.skippedNoSnapshot, 0); assert.strictEqual(res.skippedTooFewSigns, 0);
const against = res.byRelation.find(b => b.label.startsWith('AGAINST')), withT = res.byRelation.find(b => b.label.startsWith('WITH'));
assert.strictEqual(against.n, 20); assert.strictEqual(against.avgPct, -15); assert.strictEqual(against.winPct, 0);
assert.strictEqual(withT.n, 20); assert.strictEqual(withT.avgPct, 20); assert.strictEqual(withT.winPct, 100);
assert.strictEqual(against.verdict, 'below average in both halves'); assert.strictEqual(withT.verdict, 'ABOVE average in both halves');
// direction matrix: PUT in UP day-trend is the losing cell, CALL in UP the winning one
assert.strictEqual(res.byDirection.find(b => b.label === 'PUT in UP day-trend').avgPct, -15);
assert.strictEqual(res.byDirection.find(b => b.label === 'CALL in UP day-trend').avgPct, 20);
// replay: skipping the 20 AGAINST trades removes -300 and keeps +400
assert.strictEqual(res.replay.before.n, 40); assert.strictEqual(res.replay.after.n, 20); assert.strictEqual(res.replay.skipped.n, 20);
assert.strictEqual(res.replay.skipped.sumPct, -300); assert.strictEqual(res.replay.after.sumPct, 400); assert.strictEqual(res.replay.before.sumPct, 100);
assert.strictEqual(res.replay.verdict, 'skipping them would have helped in BOTH halves');
// per strategy rows exist for both sources
assert.deepStrictEqual(res.bySource.map(s => s.source).sort(), ['Brahmastra', 'Murarka']);
// thin sample is labelled thin, not judged
const thin = C.computeCounterTrendStudy(trades.slice(0, 6), snaps, simW, { declusterMin: 0, minN: 15 });
assert.strictEqual(thin.byRelation.find(b => b.label.startsWith('AGAINST')).verdict, 'thin');
assert.ok(thin.replay.verdict.startsWith('thin'));
// no snapshot / no trend signs are counted, not crashed
assert.strictEqual(C.computeCounterTrendStudy(trades, [], simW, {}).tradesUsed, 0);
assert.strictEqual(C.computeCounterTrendStudy([], snaps, simW, {}).tradesUsed, 0);
assert.ok(C.formatCounterTrendText(res).includes('REPLAY'));
console.log('counterTrendStudy tests OK');