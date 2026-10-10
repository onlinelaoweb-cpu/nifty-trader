'use strict';
const assert = require('assert');
const E = require('../src/utils/entryContextStudy');

assert.strictEqual(E.sideOf('BULLISH'), 1); assert.strictEqual(E.sideOf('BUY CALL'), 1); assert.strictEqual(E.sideOf('BEARISH'), -1);
assert.strictEqual(E.sideOf('BUY PUT'), -1); assert.strictEqual(E.sideOf('CE'), 1); assert.strictEqual(E.sideOf('PE'), -1); assert.strictEqual(E.sideOf(null), null);

const rows = [{ ms: 0 }, { ms: 300000 }, { ms: 600000 }];
assert.strictEqual(E.snapshotAtOrBefore(rows, 650000, 420000), 2);
assert.strictEqual(E.snapshotAtOrBefore(rows, 1200000, 420000), -1);   // too old
assert.strictEqual(E.snapshotAtOrBefore(rows, -1, 420000), -1);
assert.strictEqual(E.snapshotAtOrBefore([], 5, 420000), -1);

// ── scenario: VWAP 22500. Trades AT VWAP win (+20), trades EXTENDED 0.5% above VWAP (CALL) lose (-15).
const T0 = Date.UTC(2026, 9, 8, 4, 0);                          // 09:30 IST
const snaps = []; for (let k = 0; k < 600; k++) snaps.push({ ms: T0 + k * 300000, vwap: 22500, fibDir: 'UP', fibL0: 22700, fibL100: 22400, zone: 'NEUTRAL' });
const mkPath = (entry) => [5, 10, 15, 20].map((m, i) => ({ ts: 0, premium: entry * (1 + 0.01 * i) }));
const trades = [];
for (let i = 0; i < 60; i++) {
    const atVwap = i % 2 === 0;
    trades.push({ id: i, source: 'X', direction: 'BULLISH', fireTs: T0 + i * 40 * 60000 + 120000, entryPrice: atVwap ? 22505 : 22613, entryPremium: 100, path: mkPath(100) });
}
// embed the result in the first path sample's ts so the simulator can read it (sorted copy keeps the objects)
for (const t of trades) t.path[0].ts = (t.id % 2 === 0) ? 1 : 2;                 // 1 = at-VWAP trade, 2 = extended trade
for (const t of trades) for (let k = 1; k < t.path.length; k++) t.path[k].ts = 10 + k;
const sim = (entry, path) => ({ coachResult: path.find(p => p.ts === 1) ? 20 : path.find(p => p.ts === 2) ? -15 : 0 });
const res = E.computeEntryContextStudy(trades, snaps, sim, { tolMin: 7, declusterMin: 0, minN: 10 });
assert.strictEqual(res.tradesUsed, 60); assert.strictEqual(res.skippedNoSnapshot, 0);
const at = res.byVwap.find(b => b.label.startsWith('AT VWAP')), ext = res.byVwap.find(b => b.label.startsWith('EXTENDED'));
assert.strictEqual(at.n, 30); assert.strictEqual(at.avgPct, 20); assert.strictEqual(ext.n, 30); assert.strictEqual(ext.avgPct, -15);
assert.strictEqual(at.verdict, 'ABOVE average in both halves'); assert.strictEqual(ext.verdict, 'below average in both halves');
assert.strictEqual(res.reactionVsAction[0].avgPct >= 0, true);

// PUT trade: price BELOW vwap means "extended with the trade" (aligned = dist * side)
const putT = [{ id: 1, source: 'X', direction: 'BEARISH', fireTs: T0 + 120000, entryPrice: 22387, entryPremium: 100, path: mkPath(100) }];   // -0.5% below VWAP
const pr = E.computeEntryContextStudy(putT, snaps, () => ({ coachResult: 1 }), { declusterMin: 0 });
assert.strictEqual(pr.byVwap.find(b => b.label.startsWith('EXTENDED')).n, 1);

// fibonacci: UP impulse 22400 -> 22700 (L0 = 22700 end of move, L100 = 22400 start). Price 22520 = 60% retrace -> REACTION ZONE; PUT against an UP impulse -> 'AGAINST'
const fr = E.computeEntryContextStudy([{ id: 1, source: 'X', direction: 'BULLISH', fireTs: T0 + 120000, entryPrice: 22520, entryPremium: 100, path: mkPath(100) }], snaps, () => ({ coachResult: 5 }), { declusterMin: 0 });
assert.strictEqual(fr.byFib.find(b => b.label.startsWith('REACTION ZONE')).n, 1);
const ag = E.computeEntryContextStudy(putT, snaps, () => ({ coachResult: 5 }), { declusterMin: 0 });
assert.strictEqual(ag.byFib.find(b => b.label === 'impulse AGAINST the trade').n, 1);

// missing snapshot / vwap are counted, never crash
const old = E.computeEntryContextStudy([{ id: 1, source: 'X', direction: 'BULLISH', fireTs: T0 - 99 * 3600000, entryPrice: 22500, entryPremium: 100, path: mkPath(100) }], snaps, () => ({ coachResult: 1 }), { declusterMin: 0 });
assert.strictEqual(old.tradesUsed, 0); assert.strictEqual(old.skippedNoSnapshot, 1);
const nov = E.computeEntryContextStudy(putT, [{ ms: T0, vwap: null }], () => ({ coachResult: 1 }), { declusterMin: 0 });
assert.strictEqual(nov.skippedNoVwap, 1);

// thin buckets are labelled, text renders, bad input never throws
assert.ok(E.computeEntryContextStudy(trades.slice(0, 6), snaps, sim, { declusterMin: 0, minN: 15 }).byVwap.every(b => b.verdict === 'thin' || b.n === 0 || b.verdict));
assert.ok(E.formatEntryContextText(res).includes('REACTION vs ACTION'));
assert.strictEqual(E.computeEntryContextStudy(null, null, () => null).tradesUsed, 0);
assert.doesNotThrow(() => E.formatEntryContextText(E.computeEntryContextStudy(null, null, () => null)));

console.log('entryContextStudy tests passed');