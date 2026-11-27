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
// ---- virtual capital / margin ----
{
  const a = P.blank(); assert.strictEqual(P.account(a, 25000).capital, 500000); assert.strictEqual(P.account(a, 25000).free, 500000);
  // 1 lot @25000 needs 25000*65*0.11 = 178,750
  assert.ok(P.openTrade(a, { side: 'BUY', price: 25000, lots: 1, now: 1 }).ok);
  assert.ok(Math.abs(P.account(a, 25000).marginUsed - 178750) < 1e-6);
  assert.ok(P.openTrade(a, { side: 'BUY', price: 25000, lots: 1, now: 2 }).ok);       // 357,500 used, 142,500 free
  const r = P.openTrade(a, { side: 'BUY', price: 25000, lots: 1, now: 3 });
  assert.strictEqual(r.ok, false); assert.ok(/Margin kam/.test(r.error));
  // open loss reduces free margin
  assert.ok(P.account(a, 24900).free < P.account(a, 25000).free);
  // closed P&L moves the balance; drawdown is measured on closed balance
  P.closeTrade(a, a.open[0].id, 24900, 4);                    // -100*65 = -6,500
  const ac = P.account(a, 24900); assert.strictEqual(ac.balance, 500000 - 6500); assert.ok(ac.maxDdPct > 1.29 && ac.maxDdPct < 1.31);
  // capital changes only with no open trades and in range
  assert.strictEqual(P.setCapital(a, 100000).ok, false);
  P.squareOffAll(a, 24900, 5); assert.strictEqual(P.setCapital(a, 9999).ok, false); assert.strictEqual(P.setCapital(a, 200000).ok, true);
  assert.strictEqual(P.account(a, 24900).capital, 200000);
  const r2 = P.openTrade(a, { side: 'BUY', price: 25000, lots: 2, now: 6 }); assert.strictEqual(r2.ok, false); assert.ok(/max 1 lot/.test(r2.error));
}
console.log('paperTrade capital tests passed');
