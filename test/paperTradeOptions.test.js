'use strict';
const assert = require('assert');
const P = require('../public/js/paper-trade');
const chain = (ce, pe) => ({ spot: 25000, lot: 65, expiry: '2026-12-01', rows: [{ k: 24900, ce: ce + 100, pe: pe - 40 }, { k: 25000, ce, pe }, { k: 25100, ce: 0, pe: pe + 60 }] });
let st = P.blank(), ch = chain(120, 110);
// validation
assert.strictEqual(P.openOption(st, { opt: 'XX', strike: 25000, chain: ch, lots: 1 }).ok, false);
assert.strictEqual(P.openOption(st, { opt: 'CE', strike: 25100, chain: ch, lots: 1 }).ok, false, 'no premium for that strike');
assert.strictEqual(P.openOption(st, { opt: 'CE', strike: 25000, chain: ch, lots: 0 }).ok, false);
assert.strictEqual(P.openOption(st, { opt: 'CE', strike: 25000, chain: ch, lots: 1, slPrem: 130 }).ok, false, 'SL above entry');
assert.strictEqual(P.openOption(st, { opt: 'CE', strike: 25000, chain: ch, lots: 1, tgPrem: 100 }).ok, false, 'target below entry');
// buy: fills at ltp + slippage, cash used = premium x qty
assert.strictEqual(P.openOption(st, { opt: 'CE', strike: 25000, chain: ch, lots: 2, slPrem: 100, tgPrem: 150, now: 1 }).ok, true);
const t = st.open[0]; assert.strictEqual(t.entry, 120.5); assert.strictEqual(t.qty, 130); assert.strictEqual(t.margin, 120.5 * 130);
let a = P.account(st, { nifty: 25000, chain: ch }); assert.strictEqual(a.free, 500000 - 120.5 * 130);
// mark follows the strike premium; PUT trade marks on the PE side
assert.strictEqual(P.openPnl(st, { nifty: 25000, chain: chain(130.5, 100) }), 10 * 130);
// SL hit on premium -> exit one slippage below the SL level, charges deducted
assert.strictEqual(P.onTick(st, { nifty: 24950, chain: chain(99, 150) }, 2), 0 + 1);
let c = st.closed[0]; assert.strictEqual(c.reason, 'SL laga'); assert.strictEqual(c.exit, 99.5);
const ch1 = P.optCharges(120.5, 99.5, 130); assert.ok(ch1 > 40 && ch1 < 80, 'charges ~ Rs 40-80: ' + ch1);
assert.ok(Math.abs(c.rs - ((99.5 - 120.5) * 130 - ch1)) < 1e-6);
// target hit
P.openOption(st, { opt: 'PE', strike: 25000, chain: ch, lots: 1, tgPrem: 130, now: 3 });
assert.strictEqual(P.onTick(st, { nifty: 24900, chain: chain(80, 140) }, 4), 1);
assert.strictEqual(st.closed[0].reason, 'Target mila'); assert.strictEqual(st.closed[0].opt, 'PE'); assert.ok(st.closed[0].rs > 0);
// strike missing from a later chain: keep last premium, no crash, no fill
P.openOption(st, { opt: 'CE', strike: 25000, chain: ch, lots: 1, slPrem: 100, now: 5 });
assert.strictEqual(P.onTick(st, { nifty: 25000, chain: { rows: [] } }, 6), 0);
assert.strictEqual(P.squareOffAll(st, { nifty: 25000, chain: ch }, 7, 'x'), 1); assert.strictEqual(st.open.length, 0);
// not enough cash
const s2 = P.blank(); assert.strictEqual(P.setCapital(s2, 10000).ok, true);
const r = P.openOption(s2, { opt: 'CE', strike: 25000, chain: ch, lots: 2, now: 1 }); assert.strictEqual(r.ok, false); assert.ok(/Paisa kam/.test(r.error));
// legacy index trade still works alongside
const s3 = P.blank(); assert.ok(P.openTrade(s3, { side: 'BUY', price: 25000, lots: 1, now: 1 }).ok);
assert.ok(P.openOption(s3, { opt: 'CE', strike: 25000, chain: ch, lots: 1, now: 2 }).ok);
assert.strictEqual(P.openPnl(s3, { nifty: 25010, chain: chain(130.5, 100) }), 650 + 650);
console.log('paperTrade options tests passed');
