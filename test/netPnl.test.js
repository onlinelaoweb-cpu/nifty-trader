'use strict';
const assert = require('assert');
const N = require('../public/js/net-pnl');
const near = (a, b, e = 0.01) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

// worked example: 1 lot (65), buy 120, sell 132, Rs20/order -> Rs 67.19
let c = N.charges(120, 132, 65, 20);
near(c.brokerage, 40); near(c.stt, 12.87); near(c.nse, 5.82); near(c.sebi, 0.02); near(c.stamp, 0.23); near(c.gst, 8.25); near(c.total, 67.19, 0.02);
// manual: no brokerage, GST only on exchange + SEBI fees
c = N.charges(120, 132, 65, 0);
near(c.brokerage, 0); near(c.total, 12.87 + 5.82 + 0.02 + 0.23 + 0.18 * (5.82 + 0.02), 0.02);
// invalid input
assert.strictEqual(N.charges('x', 1, 65, 0), null); assert.strictEqual(N.charges(10, 12, 0, 0), null); assert.strictEqual(N.charges(-1, 12, 65, 0), null);

const T = (premium, exit, lots, day, extra) => Object.assign({ premium, exit, lots, pnl: Math.round((exit - premium) * lots * 65), time: day }, extra || {});
const today = new Date('2026-11-16T10:30:00+05:30'); const ts = today.toDateString();
const trades = [
  T(100, 110, 1, '2026-11-16T10:30:00+05:30'),                 // +650 gross
  T(100, 95, 1, '2026-11-16T11:30:00+05:30'),                  // -325 gross
  T(80, 80, 1, '2026-11-13T11:30:00+05:30'),                   // flat 0 gross -> a small loss after charges
  { premium: 90, exit: null, lots: 1, pnl: 0, time: '2026-11-16T12:00:00+05:30' },                       // open -> ignored
  T(90, 90, 1, '2026-11-13T12:00:00+05:30', { notes: '⚠️ EOD close unverified — no live exit premium was known' }), // skipped
];
let r = N.compute(trades, 65, ts);
assert.ok(r.show); assert.strictEqual(r.total.n, 3); assert.strictEqual(r.skipped, 1);
assert.strictEqual(r.today.n, 2); assert.strictEqual(r.today.gross, 325); assert.ok(r.today.manual < 325 && r.today.auto < r.today.manual);
assert.strictEqual(r.total.gross, 325); assert.ok(r.total.manual < r.total.gross && r.total.auto < r.total.manual);
// extra automation cost = 2 orders * Rs20 * 1.18 per trade
assert.ok(Math.abs((r.total.perTradeAuto - r.total.perTradeManual) - 47.2) < 0.01, r.total.perTradeAuto + ' ' + r.total.perTradeManual);
// gross PF 650/325 = 2.0 ; net is lower
near(r.total.pfGross, 2.0, 1e-9); assert.ok(r.total.pfManual < 2 && r.total.pfAuto < r.total.pfManual);
// PF edge cases + empty / garbage
assert.strictEqual(N.compute([], 65, ts).show, false); assert.strictEqual(N.compute(null, 65, ts).show, false);
assert.strictEqual(N.compute([{ premium: 'a', exit: 5, lots: 1, pnl: 'z' }, null, 5], 65, ts).show, false);
const onlyWin = N.compute([T(100, 120, 1, '2026-11-16T10:00:00+05:30')], 65, ts); assert.strictEqual(onlyWin.total.pfGross, Infinity);
assert.doesNotThrow(() => N.render(trades, 65));
console.log('netPnl tests passed');
