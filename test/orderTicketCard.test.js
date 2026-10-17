'use strict';
const assert = require('assert');
const C = require('../public/js/order-ticket.js');
const T = require('../src/utils/orderTicket');

// form -> request body
assert.deepStrictEqual(C.toPayload({ optionType: 'CE', strike: '25000', expiry: '', lots: '1', orderType: 'LIMIT', entryPrice: '100', sl: '80', slUnit: 'price', tg: '40', tgUnit: '%' }),
  { optionType: 'CE', strike: '25000', expiry: '', lots: '1', orderType: 'LIMIT', entryPrice: '100', slPrice: '80', targetPct: '40' });
assert.strictEqual(C.toPayload({ sl: '20', slUnit: '%', tg: '5', tgUnit: 'price' }).slPct, '20');

// summary: ok, error, null, and HTML escaping
const good = T.buildTicket({ optionType: 'PE', strike: 24900, lots: 1, orderType: 'LIMIT', entryPrice: 100, slPrice: 80, targetPct: 40 });
const s = C.summary({ ...good, id: 7 }); assert.strictEqual(s.ok, true); assert(s.lines.join(' ').includes('Max nuksaan') && /ticket #7/.test(s.lines.join(' ')));
const e = C.summary(T.buildTicket({ optionType: 'CE', strike: 25025, lots: 1, entryPrice: 100, slPrice: 80, targetPrice: 120 })); assert.strictEqual(e.ok, false); assert(e.lines.length >= 1);
assert.strictEqual(C.summary(null).ok, false);
assert(!C.summary({ ok: false, errors: ['<script>x</script>'] }).lines[0].includes('<script>'));

// ladder payload + summary
const pl = C.toPayload({ optionType: 'CE', strike: '25000', lots: '', orderType: 'LIMIT', entryPrice: '100', sl: '20', slUnit: '%', tgUnit: '%',
  targets: [{ v: '20', lots: '1' }, { v: '30', lots: '2' }, { v: '40', lots: '3' }, { v: '', lots: '' }], trailMode: 'POINTS', trailPoints: '10', timeStop: '15:10' });
assert.strictEqual(pl.targets.length, 3); assert.deepStrictEqual(pl.targets[1], { lots: '2', pct: '30' });
assert.strictEqual(pl.trailMode, 'POINTS'); assert.strictEqual(pl.trailPoints, '10'); assert.strictEqual(pl.timeStop, '15:10');
assert.strictEqual(C.toPayload({ sl: '1', slUnit: 'price', tgUnit: 'price', targets: [], trailMode: 'NONE' }).trailMode, undefined);
const lad = T.buildTicket(pl);
assert(lad.ok, JSON.stringify(lad.errors));
const ls = C.summary(lad); assert(ls.ok); const txt = ls.lines.join(' ');
assert(/T1:/.test(txt) && /T3:/.test(txt) && /Trailing:/.test(txt) && /Time stop:/.test(txt) && /Saare targets/.test(txt));
console.log('orderTicketCard tests OK');
