'use strict';
const assert = require('assert');
const P = require('../src/utils/probProfile');
const t = (o) => ({ state: 'CLOSED', instrument: 'NIFTY', source: 'MTF', direction: 'BULLISH', strike: 25000, fire_ts: '2026-10-21T04:00:00Z', exit_reason: 'Target hit', realized_pct: 10, realized_rs: 1000, ...o });

// 21 Oct 2026 crude as shown in the journal
const crude = [
    t({ instrument: 'CRUDE', source: 'Murarka', strike: 9350, fire_ts: '2026-10-21T12:10:00Z', exit_reason: 'Time stop', realized_pct: -12.8, realized_rs: -13260 }),
    t({ instrument: 'CRUDE', source: 'Murarka', strike: 9250, fire_ts: '2026-10-21T14:01:00Z', exit_reason: 'Time stop', realized_pct: -9.1, realized_rs: -9180 }),
    t({ instrument: 'CRUDE', source: 'Brahmastra', strike: 9250, fire_ts: '2026-10-21T14:02:00Z', exit_reason: 'Time stop', realized_pct: -9.5, realized_rs: -9700 }),
    t({ instrument: 'CRUDE', source: 'Brahmastra', direction: 'BEARISH', strike: 9300, fire_ts: '2026-10-21T14:56:00Z', exit_reason: 'Time stop', realized_pct: 2.4, realized_rs: 2440 }),
];
const p = P.buildProfile(crude);
const mur = p.groups.find(g => g.source === 'Murarka'), bra = p.groups.find(g => g.source === 'Brahmastra'), all = p.byInstrument[0];
assert.strictEqual(mur.n, 2); assert.strictEqual(mur.winPct, 0); assert.strictEqual(mur.worstLosingStreak, 2);
assert.strictEqual(mur.totalRs, -22440); assert.strictEqual(bra.totalRs, -7260);          // matches the journal screen
assert.strictEqual(all.totalRs, -29700); assert.strictEqual(all.n, 4); assert.strictEqual(all.winPct, 25);
// the 19:31 / 19:32 pair (same strike + direction, 1 min apart, two engines) = 1 correlated duplicate
assert.strictEqual(all.correlated, 1); assert.strictEqual(all.independentN, 3);
assert.strictEqual(bra.correlated, 1);                                                    // the later one is the duplicate
assert.strictEqual(mur.correlated, 0);
assert.strictEqual(all.enough, false);                                                     // 4 trades -> flagged
// different strike, or gap > 3 min -> NOT correlated
const d2 = P.correlatedSet([t({}), t({ source: 'B', strike: 25050 }), t({ source: 'C', fire_ts: '2026-10-21T04:10:00Z' })]);
assert.strictEqual(d2.size, 0);
// expectancy / payoff / breakeven maths: 2 wins of +20, 2 losses of -10 -> win 50, payoff 2, breakeven win 33.3, expectancy +5
const m = P.buildProfile([t({ realized_pct: 20, fire_ts: '2026-10-20T04:00:00Z', strike: 1 }), t({ realized_pct: -10, fire_ts: '2026-10-20T05:00:00Z', strike: 2 }), t({ realized_pct: 20, fire_ts: '2026-10-20T06:00:00Z', strike: 3 }), t({ realized_pct: -10, fire_ts: '2026-10-20T07:00:00Z', strike: 4 })]).groups[0];
assert.strictEqual(m.winPct, 50); assert.strictEqual(m.payoff, 2); assert.strictEqual(m.breakevenWinPct, 33.3); assert.strictEqual(m.expectancyPct, 5);
assert.strictEqual(m.maxDrawdownPct, 10); assert.strictEqual(m.worstLosingStreak, 1);
// open trades and rows without realized_pct are ignored; unknown Rs is not summed as zero
const o = P.buildProfile([t({ state: 'OPEN', realized_pct: null }), t({ realized_rs: null, strike: 9 })]).groups[0];
assert.strictEqual(o.n, 1); assert.strictEqual(o.open, 1); assert.strictEqual(o.totalRs, null); assert.strictEqual(o.rsKnownOf, '0/1');
// empty / bad input never throws
assert.deepStrictEqual(P.buildProfile(null).groups, []); assert.deepStrictEqual(P.buildProfile([]).byInstrument, []);
// Wilson range is wide for tiny n and tightens with n
assert(P.wilson(2, 4)[1] - P.wilson(2, 4)[0] > P.wilson(50, 100)[1] - P.wilson(50, 100)[0]);
// text view renders, flags small samples, and states it is read-only / gross
const txt = P.profileText(p, { days: 1 });
assert(/TOO FEW/.test(txt) && /Read-only/.test(txt) && /GROSS/.test(txt) && /CRUDE \| Murarka: 2 closed/.test(txt) && /not financial advice/.test(txt));
assert(P.profileText(P.buildProfile([]), { days: 7 }).includes('PROBABILITY PROFILE'));
console.log('probProfile tests OK');