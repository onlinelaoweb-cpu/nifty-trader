'use strict';
const assert = require('assert');
const P = require('../public/js/paper-trade');
let st = P.blank();
// validation
assert.strictEqual(P.openTrade(st, { side: 'BUY', price: null, lots: 1 }).ok, false);
assert.strictEqual(P.openTrade(st, { side: 'X', price: 100, lots: 1 }).ok, false);
assert.strictEqual(P.openTrade(st, { side: 'BUY', price: 100, lots: 0 }).ok, false);
assert.strictEqual(P.openTrade(st, { side: 'BUY', price: 100, lots: 1, slPts: -5 }).ok, false);
// BUY with SL 20 / target 40
assert.strictEqual(P.openTrade(st, { side: 'BUY', price: 25000, lots: 2, slPts: 20, tgPts: 40, now: 1 }).ok, true);
const t = st.open[0]; assert.strictEqual(t.qty, 130); assert.strictEqual(t.sl, 24980); assert.strictEqual(t.tg, 25040);
assert.strictEqual(P.openPnl(st, 25010), 1300);
assert.strictEqual(P.onTick(st, 25030, 2), 0);
assert.strictEqual(P.onTick(st, 25041, 3), 1);
assert.strictEqual(st.closed[0].reason, 'Target mila'); assert.strictEqual(st.closed[0].rs, 5200); assert.strictEqual(st.open.length, 0);
// SELL hits SL
P.openTrade(st, { side: 'SELL', price: 25000, lots: 1, slPts: 10, now: 4 });
assert.strictEqual(P.onTick(st, 25011, 5), 1);
assert.strictEqual(st.closed[0].reason, 'SL laga'); assert.strictEqual(st.closed[0].rs, -650);
// manual close of a SELL in profit
P.openTrade(st, { side: 'SELL', price: 25000, lots: 1, now: 6 });
assert.strictEqual(P.closeTrade(st, st.open[0].id, 24990, 7), true);
assert.strictEqual(st.closed[0].rs, 650);
assert.strictEqual(P.closeTrade(st, 999, 100, 8), false);
// stats
const S = P.stats(st); assert.strictEqual(S.n, 3); assert.strictEqual(S.wins, 2); assert.strictEqual(S.net, 5200 - 650 + 650);
assert.ok(Math.abs(S.pf - (5850 / 650)) < 1e-9);
// square off
P.openTrade(st, { side: 'BUY', price: 100, lots: 1, now: 9 });
assert.strictEqual(P.squareOffAll(st, 110, 10), 1); assert.strictEqual(st.open.length, 0);
// market-live gate
assert.strictEqual(P.marketLive({ entryWindow: { status: 'trade' } }), true);
assert.strictEqual(P.marketLive({ entryWindow: { status: 'pre' } }), false);
assert.strictEqual(P.marketLive({}), false);
// max open trades
const s2 = P.blank(); for (let i = 0; i < 10; i++) assert.ok(P.openTrade(s2, { side: 'BUY', price: 100, lots: 1, now: i }).ok);
assert.strictEqual(P.openTrade(s2, { side: 'BUY', price: 100, lots: 1, now: 11 }).ok, false);
console.log('paperTrade tests passed');
