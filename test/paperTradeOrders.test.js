'use strict';
const assert = require('assert');
const P = require('../public/js/paper-trade');
const mk = (ce, pe, expiry) => ({ spot: 25000, lot: 65, expiry: expiry || '2026-12-01', rows: [{ k: 25000, ce, pe }, { k: 25100, ce: ce - 50, pe: pe + 60 }] });
const T = (d, hh, mm) => Date.parse(d + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00+05:30');
const o = (st, ch, x) => P.openOption(st, Object.assign({ opt: 'CE', strike: 25000, chain: ch, spot: 25000, lots: 1, now: T('2026-11-27', 10, 0) }, x));

// SELL (writing): fills below the ltp, margin = 11% of spot x qty, profit when premium falls, SL above entry
let st = P.blank(), ch = mk(100, 90);
assert.strictEqual(o(st, ch, { side: 'SELL', slPrem: 90 }).ok, false, 'SELL SL must be above entry');
assert.strictEqual(o(st, ch, { side: 'SELL', tgPrem: 120 }).ok, false, 'SELL target must be below entry');
assert.strictEqual(o(st, ch, { side: 'SELL', slSpec: { v: 30, u: '%' }, tgSpec: { v: 40, u: '%' } }).ok, true);
let t = st.open[0]; assert.strictEqual(t.entry, 99.5); assert.strictEqual(t.margin, 25000 * 65 * 0.11); assert.strictEqual(t.sl, 129.35); assert.strictEqual(t.tg, 59.7);
assert.strictEqual(P.openPnl(st, { nifty: 25000, chain: mk(80, 90) }), (99.5 - 80) * 65);
assert.strictEqual(P.onTick(st, { nifty: 25000, chain: mk(59, 90) }, 1), 1);   // target (premium fell 40%)
let c = st.closed[0]; assert.strictEqual(c.side, 'SELL'); assert.strictEqual(c.reason, 'Target mila'); assert.strictEqual(c.exit, 60.2);   // buy-back one slippage above the target level
const exp = (99.5 - 60.2) * 65 - P.optCharges(60.2, 99.5, 65); assert.ok(Math.abs(c.rs - exp) < 1e-6 && c.rs > 0);

// LIMIT BUY below market waits, then fills (never above the limit)
st = P.blank();
let r = o(st, mk(100, 90), { type: 'LIMIT', price: 90 }); assert.ok(r.ok && r.pending); assert.strictEqual(st.pending.length, 1); assert.strictEqual(st.open.length, 0);
assert.strictEqual(P.processPending(st, { nifty: 25000, chain: mk(95, 90) }, 2), 0);
assert.strictEqual(P.processPending(st, { nifty: 25000, chain: mk(89, 90) }, 3), 1);
assert.strictEqual(st.pending.length, 0); assert.strictEqual(st.open[0].entry, 89.5);
// marketable LIMIT BUY fills at once; IOC that cannot fill is refused
st = P.blank(); r = o(st, mk(100, 90), { type: 'LIMIT', price: 105 }); assert.ok(r.ok && r.filled); assert.strictEqual(st.open[0].entry, 100.5);
assert.strictEqual(o(st, mk(100, 90), { type: 'LIMIT', price: 80, validity: 'IOC' }).ok, false);
// TRIGGER: BUY needs trigger above ltp; fills on touch as market; SELL needs it below; IOC not allowed
st = P.blank(); assert.strictEqual(o(st, mk(100, 90), { type: 'TRIGGER', price: 95 }).ok, false);
assert.strictEqual(o(st, mk(100, 90), { type: 'TRIGGER', price: 110, validity: 'IOC' }).ok, false);
r = o(st, mk(100, 90), { type: 'TRIGGER', price: 110 }); assert.ok(r.pending);
assert.strictEqual(P.processPending(st, { nifty: 25000, chain: mk(111, 90) }, 4), 1); assert.strictEqual(st.open[0].entry, 111.5);
st = P.blank(); assert.strictEqual(o(st, mk(100, 90), { side: 'SELL', type: 'TRIGGER', price: 105 }).ok, false); assert.ok(o(st, mk(100, 90), { side: 'SELL', type: 'TRIGGER', price: 90 }).pending);
// cancel + day-end cancel
assert.strictEqual(P.cancelPending(st, st.pending[0].id, 5, 'x'), true); assert.strictEqual(st.pending.length, 0);
o(st, mk(100, 90), { type: 'LIMIT', price: 80 }); assert.strictEqual(P.cancelAllPending(st, 6, 'din ka end'), 1);
// a pending order that cannot be afforded when it triggers is cancelled with a log line, nothing opens
st = P.blank(); P.setCapital(st, 10000); st.pending.push({ id: 9, opt: 'CE', strike: 25000, expiry: '2026-12-01', side: 'BUY', lots: 5, lot: 65, product: 'INTRADAY', type: 'LIMIT', price: 100, validity: 'DAY', placedTs: 1 });
assert.strictEqual(P.processPending(st, { nifty: 25000, chain: mk(99, 90) }, 7), 1); assert.strictEqual(st.open.length, 0); assert.ok(/cancel/.test(st.log[0].text));

// CARRY survives the 15:30 square-off, intraday does not
st = P.blank(); ch = mk(100, 90);
o(st, ch, { product: 'CARRY' }); o(st, ch, { product: 'INTRADAY' });
assert.strictEqual(P.squareOffAll(st, { nifty: 25000, chain: ch }, 8, 'Din ka end', true), 1); assert.strictEqual(st.open.length, 1); assert.strictEqual(st.open[0].product, 'CARRY');
// expiry settle at intrinsic (no slippage): CE ITM pays, OTM expires worthless
st = P.blank(); o(st, ch, { strike: 25000, product: 'CARRY' }); st.open[0].lastSpot = 25120; st.open[0].lastLtp = 130;
assert.strictEqual(P.settleExpired(st, { nifty: 25120, chain: ch }, T('2026-12-01', 14, 0)), 0, 'not yet expiry close');
assert.strictEqual(P.settleExpired(st, { nifty: 25120, chain: ch }, T('2026-12-01', 15, 31)), 1);
c = st.closed[0]; assert.strictEqual(c.reason, 'Expiry settle'); assert.strictEqual(c.exit, 120);
st = P.blank(); o(st, ch, { opt: 'PE', strike: 25000, product: 'CARRY' }); st.open[0].lastSpot = 25120;
assert.strictEqual(P.settleExpired(st, { nifty: 25200, chain: mk(1, 1, '2026-12-08') }, T('2026-12-02', 9, 20)), 1); assert.strictEqual(st.closed[0].exit, 0);
// a carried trade is marked from the chain only while that expiry is listed; otherwise it keeps its last premium
st = P.blank(); o(st, ch, { product: 'CARRY' }); st.open[0].lastLtp = 123;
assert.strictEqual(P.openPnl(st, { nifty: 25000, chain: mk(300, 300, '2026-12-08') }), (123 - 100.5) * 65);
console.log('paperTrade orders tests passed');
{ const P = require('../public/js/paper-trade.js'); const now = Date.UTC(2026, 10, 30, 6, 0), yest = now - 86400000;
  const st = P.blank(); st.closed = [{ rs: 500, exitTs: now - 60000 }, { rs: -200, exitTs: now - 120000 }, { rs: 900, exitTs: yest }];
  const d = P.dayStats(st, now, -50); assert.strictEqual(d.n, 2); assert.strictEqual(d.net, 300); assert.strictEqual(d.combined, 250); assert.strictEqual(d.wins, 1);
  const d2 = P.dayStats(st, now + 86400000, null); assert.strictEqual(d2.n, 0); assert.strictEqual(d2.combined, 0); console.log('dayStats ok'); }
