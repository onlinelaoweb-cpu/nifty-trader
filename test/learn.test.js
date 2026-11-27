'use strict';
const assert = require('assert');
const L = require('../public/js/learn');
const near = (a, b, t, m) => assert.ok(Math.abs(a - b) <= t, `${m || ''} got ${a} want ${b}`);
// Black-Scholes reference (S=K=100, T=1, r=5%, vol=20%): call 10.4506, put 5.5735, call delta 0.6368, vega 0.3752/pt, theta -0.01757/day
let c = L.bs(100, 100, 1, 0.05, 0.2, 'CE'), p = L.bs(100, 100, 1, 0.05, 0.2, 'PE');
near(c.price, 10.4506, 0.01, 'call'); near(p.price, 5.5735, 0.01, 'put'); near(c.delta, 0.6368, 0.001, 'delta'); near(p.delta, c.delta - 1, 1e-9, 'put delta'); near(c.vega, 0.3752, 0.002, 'vega'); near(c.theta, -0.01757, 0.0005, 'theta');
near(c.price - p.price, 100 - 100 * Math.exp(-0.05), 0.01, 'put-call parity');
assert.strictEqual(L.bs(25100, 25000, 0, 0.065, 0.15, 'CE').price, 100, 'expiry = intrinsic'); assert.strictEqual(L.bs(24900, 25000, 0, 0.065, 0.15, 'CE').price, 0);
let a = L.bs(25600, 25600, 5 / 365, 0.065, 0.15, 'CE'); assert.ok(a.price > 100 && a.price < 250 && a.delta > 0.45 && a.delta < 0.6 && a.theta < 0 && a.vega > 0, 'ATM weekly sane: ' + JSON.stringify(a));
assert.ok(L.bs(25600, 25600, 1 / 365, 0.065, 0.15, 'CE').theta < a.theta, 'theta is bigger (more negative) nearer expiry');
// payoff: bull call spread from the lesson (buy 25500 CE 160, sell 25700 CE 80)
const legs = [{ type: 'CE', side: 'BUY', strike: 25500, premium: 160 }, { type: 'CE', side: 'SELL', strike: 25700, premium: 80 }];
assert.strictEqual(L.payoff(legs, 25000), -80); assert.strictEqual(L.payoff(legs, 26000), 120); assert.strictEqual(L.payoff(legs, 25580), 0);
let S = L.summarize(legs, 25600); assert.strictEqual(S.maxProfit, 120); assert.strictEqual(S.maxLoss, -80); assert.deepStrictEqual(S.breakevens, [25580]); assert.ok(!S.profitOpenUp && !S.lossOpenUp);
// long call / short call / short put open-ended flags
S = L.summarize([{ type: 'CE', side: 'BUY', strike: 25600, premium: 90 }], 25600); assert.ok(S.profitOpenUp && !S.lossOpenUp); assert.strictEqual(S.maxLoss, -90); assert.deepStrictEqual(S.breakevens, [25690]);
S = L.summarize([{ type: 'CE', side: 'SELL', strike: 25600, premium: 90 }], 25600); assert.ok(S.lossOpenUp && !S.profitOpenUp); assert.strictEqual(S.maxProfit, 90);
S = L.summarize([{ type: 'PE', side: 'SELL', strike: 25600, premium: 90 }], 25600); assert.ok(S.lossOpenDown && !S.lossOpenUp);
// straddle breakevens = strike +/- total premium
S = L.summarize([{ type: 'CE', side: 'BUY', strike: 25600, premium: 90 }, { type: 'PE', side: 'BUY', strike: 25600, premium: 85 }], 25600); assert.deepStrictEqual(S.breakevens, [25425, 25775]);
// every preset builds, has sane premiums, and iron condor has defined risk both ways
Object.keys(L.PRESETS).forEach(n => { const lg = L.buildLegs(n, 25600, 4, 15); assert.ok(lg.length >= 1 && lg.every(x => x.premium >= 0.05 && x.strike % 50 === 0), n); });
const ic = L.summarize(L.buildLegs('Iron Condor', 25600, 4, 15), 25600); assert.ok(!ic.lossOpenUp && !ic.lossOpenDown && !ic.profitOpenUp && ic.maxProfit > 0 && ic.maxLoss < 0);
// position sizing (lesson b5): 5L, 1%, premium 100, SL 20% -> 3 lots
let z = L.sizeLots(500000, 1, 100, 20, 65); assert.strictEqual(z.riskRs, 5000); assert.strictEqual(z.perLot, 1300); assert.strictEqual(z.lots, 3); assert.strictEqual(L.sizeLots(500000, 1, 0, 20, 65).lots, 0);
// missions tick from the paper state
let m = L.missions({ open: [], closed: [] }); assert.strictEqual(m.filter(x => x.done).length, 0);
m = L.missions({ open: [{ opt: 'CE', side: 'SELL', product: 'CARRY', otype: 'LIMIT', sl: 130, tg: null }], closed: [{ opt: 'PE', side: 'BUY', reason: 'SL laga', otype: 'TRIGGER', sl: 10 }] });
const d = Object.fromEntries(m.map(x => [x.id, x.done])); assert.ok(d.m1 && d.m2 && d.m3 && d.m4 && d.m5 && d.m6 && d.m7 && d.m8 && !d.m9 && !d.m10);
m = L.missions({ open: [], closed: new Array(30).fill({ opt: 'CE', side: 'BUY', reason: 'Haath se band' }) }); assert.ok(m.find(x => x.id === 'm10').done);
// every lesson is complete and its quiz answers are in range
L.LESSONS.forEach(l => { assert.ok(l.title && l.pts.length >= 3 && l.ex && l.quiz.length === 2, l.id); l.quiz.forEach(q => { assert.ok(q.a >= 0 && q.a < q.o.length && q.why, l.id); }); });
assert.strictEqual(new Set(L.LESSONS.map(l => l.id)).size, L.LESSONS.length);
console.log('learn tests passed');
