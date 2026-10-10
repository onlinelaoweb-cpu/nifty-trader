'use strict';
const assert = require('assert');
const S = require('../src/utils/sizingStudy');

// lotsForRisk: Rs 2000 risk, 15% stop, lot 65. premium 100 -> 1 lot risks 0.15*100*65 = 975 -> round(2.05)=2 ; premium 200 -> 1950 -> 1 ; premium 20 -> 195 -> round(10.2)=10 (cap 10)
assert.strictEqual(S.lotsForRisk(100, -15, 2000, 65, 10), 2);
assert.strictEqual(S.lotsForRisk(200, -15, 2000, 65, 10), 1);
assert.strictEqual(S.lotsForRisk(20, -15, 2000, 65, 10), 10);
assert.strictEqual(S.lotsForRisk(5, -15, 2000, 65, 6), 6);          // cap respected
assert.strictEqual(S.lotsForRisk(400, -15, 2000, 65, 10), 1);       // never below 1
assert.strictEqual(S.lotsForRisk(0, -15, 2000, 65, 10), 1);         // bad premium -> 1

const D = (day, hh, mm) => Date.UTC(2026, 9, day, hh - 5, mm - 30);   // IST -> UTC ms
const T = (fireTs, entryPremium, resultPct, source = 'A') => ({ fireTs, entryPremium, resultPct, source });

// FIXED_1 arithmetic: +10% of 100 premium * 65 = 650 ; -15% of 100 -> -975
let r = S.runScheme([T(D(6, 10, 0), 100, 10), T(D(6, 11, 0), 100, -15)], 'FIXED_1', { riskRs: 2000, lotSize: 65, slPct: -15, maxLots: 10, dayStopR: 3 });
assert.strictEqual(r.totalRs, -325); assert.strictEqual(r.tradesTaken, 2); assert.strictEqual(r.worstTradeRs, -975); assert.strictEqual(r.maxDrawdownRs, 975); assert.strictEqual(r.winPct, 50);

// RISK_PARITY: a -15% stop loses ~the risk amount whatever the premium (cheap 20 premium -> 10 lots -> -15%*20*65*10 = -1950 ; dear 200 -> 1 lot -> -1950)
const p = { riskRs: 2000, lotSize: 65, slPct: -15, maxLots: 10, dayStopR: 3 };
r = S.runScheme([T(D(6, 10, 0), 20, -15)], 'RISK_PARITY', p); assert.strictEqual(r.totalRs, -1950);
r = S.runScheme([T(D(6, 10, 0), 200, -15)], 'RISK_PARITY', p); assert.strictEqual(r.totalRs, -1950);

// DAY_STOP: after the day is down 3 x 2000 = 6000 the rest of that day is skipped, next day resumes
const losers = []; for (let k = 0; k < 6; k++) losers.push(T(D(6, 10, k * 10), 200, -15));   // each -1950 at 1 lot
losers.push(T(D(7, 10, 0), 200, 10));
r = S.runScheme(losers, 'RISK_PARITY_DAY_STOP', p);
assert.strictEqual(r.tradesTaken, 5);                    // day 1: -1950 x4 = -7800 (the stop trips after the 4th), day 2 resumes with 1 trade
assert.strictEqual(r.tradesSkipped, 2);
assert.strictEqual(r.worstDayRs, -7800);

// HALF_AFTER_2L: two losses at 20 premium (10 lots each), the 3rd trade is taken at half size (5 lots)
const hl = [T(D(6, 10, 0), 20, -15), T(D(6, 10, 30), 20, -15), T(D(6, 11, 0), 20, 10), T(D(6, 11, 30), 20, 10)];
r = S.runScheme(hl, 'RISK_PARITY_HALF_AFTER_2L', p);
// -1950, -1950, then +10% * 20 * 65 * 5 lots = +650 (a win resets), then full size 10 lots: +1300
assert.strictEqual(r.totalRs, -1950 - 1950 + 650 + 1300);
assert.strictEqual(r.avgLots, (10 + 10 + 5 + 10) / 4);

// full study
const trades = []; for (let i = 0; i < 40; i++) trades.push(T(D(6 + (i % 4), 10, (i * 7) % 50), 40 + (i % 9) * 25, (i % 5 === 0 ? -15 : i % 3 === 0 ? 12 : 4)));
const res = S.computeSizingStudy(trades, { riskRs: 2000 });
assert.strictEqual(res.tradesUsed, 40); assert.strictEqual(res.schemes.length, 4); assert.strictEqual(res.byPremium.length, 3);
assert.ok(res.schemes.every(x => Number.isFinite(x.totalRs)));
assert.strictEqual(res.byPremium.reduce((a, b) => a + b.n, 0), 40);
assert.ok(S.formatSizingText(res).includes('BY PREMIUM LEVEL'));
// empty / bad input never throws
assert.strictEqual(S.computeSizingStudy([]).tradesUsed, 0);
assert.strictEqual(S.computeSizingStudy(null).tradesUsed, 0);
assert.doesNotThrow(() => S.formatSizingText(S.computeSizingStudy(null)));

console.log('sizingStudy tests passed');