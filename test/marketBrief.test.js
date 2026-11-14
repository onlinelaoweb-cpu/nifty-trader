'use strict';
const assert = require('assert');
const MB = require('../public/js/market-brief');

const NOW = Date.parse('2026-11-16T03:00:00Z'); // Mon 16 Nov 08:30 IST
const lv = { levels: [{ price: 25143, type: 'PDL' }, { price: 25353, type: 'PDH' }, { price: 25300, type: 'MP' }] };
const cal = [
  { title: 'NSE Weekly F&O Expiry', date: '2026-11-17', time: '15:30', impact: 'high', category: 'expiry' },
  { title: 'US CPI', date: '2026-11-16', time: '19:00', impact: 'high', category: 'macro' },
  { title: 'Minor thing', date: '2026-11-16', impact: 'low' },
  { title: 'Far event', date: '2026-11-25', impact: 'high' },
];
const base = (o) => Object.assign({ entryWindow: { status: 'pre' }, nifty: 25144.3, lastClose: 25144.3, change: -155.05, changePct: -0.61, srLevels: lv,
  global: { bias: 'BEARISH' }, vix: 15.8, pcr: 0.76, atmPcr: 0.87, fii: { net: 5737 }, dii: { net: -2254 }, daysToExpiry: 1.6, calendarEvents: cal }, o);

// subah brief
let r = MB.compute(base(), NOW);
assert.ok(r.show); assert.strictEqual(r.mode, 'brief'); assert.strictEqual(r.title, 'SUBAH KA BRIEF');
assert.deepStrictEqual(r.items.map(i => i.k), ['close', 'lvl', 'glob', 'vix', 'pcr', 'fii', 'exp', 'ev']);
assert.ok(/25144/.test(r.items[0].title) && /-155/.test(r.items[0].title));
assert.ok(/25143/.test(r.items[1].text) && /25353/.test(r.items[1].text) && /25300/.test(r.items[1].text));
assert.ok(/VIX 15\.8/.test(r.items[3].title)); assert.ok(/PCR 0\.76 · ATM 0\.87/.test(r.items[4].title));
assert.ok(/\+3483 Cr/.test(r.items[5].title));
assert.ok(/kal/.test(r.items[6].title));
assert.ok(/US CPI/.test(r.items[7].text) && !/Far event|Minor thing|Expiry/.test(r.items[7].text));

// closed -> report: 13 Nov (gap-down, PDL broken then reclaimed, closed below it? close 25144 >= 25143 -> reclaimed)
const rep = base({ entryWindow: { status: 'closed' }, wsLow: 25054.4, wsHigh: 25246.3, premarketGap: { available: true, gapPct: -0.35, gapPts: -89.5 },
  breadth: { advances: 5, declines: 14 }, dayType: { trendProbability: 51, rangeProbability: 49 }, marketHealth: { total: 58, label: 'Choppy / Mixed' }, daysToExpiry: 3.6 });
r = MB.compute(rep, NOW);
assert.strictEqual(r.mode, 'report'); assert.strictEqual(r.title, 'AAKHRI SESSION KI REPORT');
const ks = r.items.map(i => i.k);
assert.deepStrictEqual(ks, ['day', 'gap', 'pdl', 'br', 'dt', 'mh', 'pcr', 'vix', 'fii', 'exp', 'ev']);
assert.ok(/25054/.test(r.items[2].text) && /jhoota breakdown/.test(r.items[2].text));
assert.ok(/192 pts/.test(r.items[0].text));
assert.ok(/5↑ \/ 14↓/.test(r.items[3].title));
// breakdown that held
r = MB.compute(Object.assign({}, rep, { nifty: 25100, change: -199 }), NOW);
assert.ok(/breakdown tikka/.test(r.items.find(i => i.k === 'pdl').text));
// breakout reclaimed / held
r = MB.compute(Object.assign({}, rep, { wsHigh: 25400, wsLow: 25130, nifty: 25340 }), NOW);
assert.ok(/jhoota breakout/.test(r.items.find(i => i.k === 'pdh').text));
r = MB.compute(Object.assign({}, rep, { wsHigh: 25400, wsLow: 25130, nifty: 25380 }), NOW);
assert.ok(/breakout tikka/.test(r.items.find(i => i.k === 'pdh').text));
// small gap, no break -> no gap/pdl/pdh items
r = MB.compute(Object.assign({}, rep, { premarketGap: { available: true, gapPct: -0.1 }, wsLow: 25138 }), NOW);
assert.ok(!r.items.some(i => ['gap', 'pdl', 'pdh'].includes(i.k)));

// hidden during the session / without state
['volatile', 'trade', 'caution', 'theta', undefined].forEach(st => assert.strictEqual(MB.compute(base({ entryWindow: st ? { status: st } : null }), NOW).show, false));
assert.strictEqual(MB.compute(null, NOW).show, false);
assert.strictEqual(MB.compute({}, NOW).show, false);
// missing / garbage data never throws
assert.strictEqual(MB.compute({ entryWindow: { status: 'pre' } }, NOW).show, false);
assert.doesNotThrow(() => MB.compute({ entryWindow: { status: 'closed' }, nifty: 'x', change: 'y', fii: {}, breadth: { advances: 'a' }, calendarEvents: 'bad', srLevels: { levels: 5 } }, NOW));
assert.doesNotThrow(() => MB.render(base()));
// VIX bands
const v = (x) => MB.compute(base({ vix: x }), NOW).items.find(i => i.k === 'vix').text;
assert.ok(/shaant/.test(v(12)) && /ooncha/.test(v(22)) && /bahut ooncha/.test(v(30)));
console.log('marketBrief tests passed');
