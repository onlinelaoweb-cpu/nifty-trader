'use strict';
const assert = require('assert');
const GP = require('../public/js/global-pulse');

// 12 Oct close, 22:35 IST (as pasted by the user)
const NOW = Date.UTC(2026, 9, 12, 17, 5);   // 22:35 IST
const g = {
    us: { dow: { changePct: 1.23 }, nasdaq: { changePct: 0.20 }, sp500: { changePct: 0.49 } },
    europe: { dax: { changePct: 1.90 }, ftse: { changePct: 2.06 } },
    asia: { giftNifty: { changePct: -0.70 }, nikkei: { changePct: -0.02 }, hangseng: { changePct: 2.04 }, shanghai: { changePct: -0.43 } },
    currency: { usdinr: { price: 95.76, changePct: -1.09 }, dxy: { price: 102.59, changePct: 0.37 } },
    commodities: { crude: { changePct: 2.18 }, gold: { changePct: -0.75 } },
};
const events = [
    { date: '2026-12-03', time: '10:00', impact: 'high', country: 'IN', title: 'RBI MPC Decision' },
    { date: '2026-02-04', time: '10:00', impact: 'high', country: 'IN', title: 'old' },          // already past -> ignored
    { date: '2026-10-13', time: '10:00', impact: 'medium', country: 'IN', title: 'India CPI Inflation' },
    { date: '2026-11-30', time: '10:00', impact: 'high', country: 'IN', title: 'India GDP Q2 FY27' },
    { date: '2026-10-14', time: '10:00', impact: 'low', country: 'IN', title: 'small' },
];
const r = GP.compute({ global: g, calendarEvents: events }, NOW);
const t = id => r.tiles.find(x => x.id === id);
assert.strictEqual(t('gp-us').cls, 'bull'); assert.strictEqual(t('gp-eu').cls, 'bull'); assert.strictEqual(t('gp-as').cls, 'bull');
assert.strictEqual(t('gp-gift').cls, 'bear');
assert.strictEqual(t('gp-fx').cls, 'bull', 'USD/INR down = rupee stronger = good, even though the price is above 87');
assert.strictEqual(t('gp-cr').cls, 'bear');
assert.strictEqual(r.bull, 4); assert.strictEqual(r.bear, 2); assert.strictEqual(r.live, 6);   // event tile is not counted
assert.ok(/halke positive/.test(r.verdict));
assert.ok(r.chips.some(c => /Duniya upar par GIFT Nifty neeche/.test(c.t)));
// next event = tomorrow's CPI (sorted, past and low-impact ignored)
assert.strictEqual(t('gp-ev').val, 'KAL 10:00'); assert.ok(/India CPI/.test(t('gp-ev').full));
assert.ok(r.chips.some(c => /India CPI Inflation kal/.test(c.t)));
assert.ok(!t('gp-ev').counts);

// event timing around "today": earlier-today event is skipped, later-today event counts
const todayEv = [{ date: '2026-10-12', time: '09:00', impact: 'high', country: 'US', title: 'gone' }, { date: '2026-10-12', time: '23:00', impact: 'high', country: 'US', title: 'Fed speech' }];
const ne = GP.nextEvent(todayEv, NOW); assert.strictEqual(ne.ev.title, 'Fed speech'); assert.strictEqual(ne.days, 0);
assert.strictEqual(GP.nextEvent([], NOW), null); assert.strictEqual(GP.nextEvent(undefined, NOW), null);
assert.strictEqual(GP.nextEvent([{ date: 'bad', impact: 'high' }], NOW), null);
// far event -> green "clear-ish", no chip
const far = GP.compute({ global: g, calendarEvents: [events[0]] }, NOW);
assert.strictEqual(far.tiles.find(x => x.id === 'gp-ev').cls, 'bull'); assert.ok(!far.chips.some(c => /RBI/.test(c.t)));

// rupee weak day -> bear; crude falling -> bull
const weak = GP.compute({ global: { currency: { usdinr: { price: 96.5, changePct: 0.8 } }, commodities: { crude: { changePct: -2 } } } }, NOW);
assert.strictEqual(weak.tiles.find(x => x.id === 'gp-fx').cls, 'bear'); assert.strictEqual(weak.tiles.find(x => x.id === 'gp-cr').cls, 'bull');
// world down + GIFT up -> opposite chip
const dn = GP.compute({ global: { us: { dow: { changePct: -1 }, sp500: { changePct: -1 } }, europe: { dax: { changePct: -1 } }, asia: { giftNifty: { changePct: 0.5 } } } }, NOW);
assert.ok(dn.chips.some(c => /Duniya neeche par GIFT Nifty upar/.test(c.t)));
// missing data never throws
for (const bad of [undefined, null, {}, { global: {} }, { global: { us: null, currency: 'x' }, calendarEvents: 'no' }]) {
    const e = GP.compute(bad, NOW); assert.strictEqual(e.tiles.length, 7); assert.strictEqual(e.verdict, 'Collecting data…');
}
console.log('globalPulse tests passed');