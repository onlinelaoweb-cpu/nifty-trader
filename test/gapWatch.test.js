'use strict';
const assert = require('assert');
const GW = require('../public/js/gap-watch');

// 13 Nov 2026: prev close 25299.35, open ~25210 (gap -0.35%), PDL 25143, flush to 25077, reclaim by 09:35
const lv = { levels: [{ price: 25143, type: 'PDL' }, { price: 25353, type: 'PDH' }, { price: 25300, type: 'MP' }] };
const gap = { available: true, gapPct: -0.35, gapPts: -89.5, zone: 'GAP_DOWN' };
const EARLY = { status: 'volatile' }, TRADE = { status: 'trade' };
const base = (o) => Object.assign({ entryWindow: EARLY, premarketGap: gap, srLevels: lv, wsLow: 25077.5, wsHigh: 25210, nifty: 25115 }, o);

// 09:24 — below PDL inside the gap-fill window: gap note + "PDL toota hua hai"
let r = GW.compute(base());
assert.ok(r.show); assert.deepStrictEqual(r.items.map(i => i.k), ['gap', 'brk-dn']);
assert.ok(/GAP-DOWN 0\.35%/.test(r.items[0].title)); assert.ok(/25143/.test(r.items[1].title));
assert.ok(/PUT mat daudao/.test(r.items[1].text));

// 09:36 — PDL reclaimed, day low 66 pts under it: gap note + false-breakdown note
r = GW.compute(base({ nifty: 25155 }));
assert.deepStrictEqual(r.items.map(i => i.k), ['gap', 'reclaim-dn']);
assert.ok(/risky/.test(r.items[1].text));

// 11:00 — after 10:00 the gap note is gone but the reclaim note stays while the situation holds
r = GW.compute(base({ entryWindow: TRADE, nifty: 25191 }));
assert.deepStrictEqual(r.items.map(i => i.k), ['reclaim-dn']);

// later the same day price makes a new low below PDL (after 10:00): nothing to say
r = GW.compute(base({ entryWindow: TRADE, nifty: 25070, wsLow: 25054 }));
assert.strictEqual(r.show, false);

// small gap (-0.2%) is ordinary
r = GW.compute(base({ premarketGap: { available: true, gapPct: -0.2, gapPts: -50 }, nifty: 25200, wsLow: 25180 }));
assert.strictEqual(r.show, false);
// exactly at the threshold counts
r = GW.compute(base({ premarketGap: { available: true, gapPct: -0.3, gapPts: -76 }, nifty: 25200, wsLow: 25180 }));
assert.deepStrictEqual(r.items.map(i => i.k), ['gap']);

// shallow poke (< 10 pts) under PDL that recovers is not a "break"
r = GW.compute(base({ entryWindow: TRADE, premarketGap: null, nifty: 25150, wsLow: 25138 }));
assert.strictEqual(r.show, false);

// gap-up mirror: PDH broken early, then false breakout
const up = { available: true, gapPct: 0.42, gapPts: 105 };
r = GW.compute(base({ premarketGap: up, nifty: 25380, wsHigh: 25390, wsLow: 25340 }));
assert.deepStrictEqual(r.items.map(i => i.k), ['gap', 'brk-up']); assert.ok(/CALL mat daudao/.test(r.items[1].text));
r = GW.compute(base({ entryWindow: TRADE, premarketGap: up, nifty: 25340, wsHigh: 25390, wsLow: 25300 }));
assert.deepStrictEqual(r.items.map(i => i.k), ['reclaim-up']);

// closed / pre-open / missing data: hidden, never throws
assert.strictEqual(GW.compute(base({ entryWindow: { status: 'closed' } })).show, false);
assert.strictEqual(GW.compute(base({ entryWindow: { status: 'pre' } })).show, false);
assert.strictEqual(GW.compute({}).show, false);
assert.strictEqual(GW.compute(null).show, false);
assert.strictEqual(GW.compute(base({ srLevels: null, premarketGap: null })).show, false);
assert.strictEqual(GW.compute(base({ nifty: 0, wsLow: 0, wsHigh: 0, premarketGap: null })).show, false);
assert.strictEqual(GW.compute(base({ nifty: 'x', wsLow: 'y', premarketGap: { available: true, gapPct: 'z' } })).show, false);

// render() without a DOM is a silent no-op
assert.doesNotThrow(() => GW.render(base()));
console.log('gapWatch tests passed');
