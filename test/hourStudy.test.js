'use strict';
const assert = require('assert');
const { computeHourStudy, formatHourText, costPct, BUCKETS } = require('../src/utils/hourStudy');
const IST = 5.5 * 3600 * 1000;
// build a UTC timestamp from an IST date + hh:mm
const at = (d, hh, mm) => Date.parse(d + 'T00:00:00Z') + (hh * 60 + mm) * 60000 - IST;

// costPct: entry 100, slip 1pt each side (2) + 0.07% x2 (0.14) + 40/130 (0.3077) = 2.4477 pts -> 2.4%
assert.ok(Math.abs(costPct(100, { slipPts: 1, chargePct: 0.07, brokerage: 40, qty: 130 }) - 2.4477) < 0.01);
assert.strictEqual(costPct(0, { slipPts: 1, chargePct: 0.07, brokerage: 40, qty: 130 }), null);

// synthetic data: 12 weekdays (Oct 1..16 skipping weekends not needed — just distinct dates), 14:30+ always +10%, 11:00 hour +10% older days only, 09:15 hour -5%
const days = ['2026-10-01','2026-10-02','2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16'];
const rows = []; let id = 1;
days.forEach((d, i) => {
    rows.push({ id: id++, source: 'A', fire_ts: at(d, 14, 45), coach_result: 10, entry_premium: 100 });
    rows.push({ id: id++, source: 'A', fire_ts: at(d, 11, 10), coach_result: i < 6 ? 10 : -10, entry_premium: 100 });
    rows.push({ id: id++, source: 'A', fire_ts: at(d, 9, 30), coach_result: -5, entry_premium: 100 });
});
let r = computeHourStudy(rows, { minN: 5, minHalfN: 3 });
assert.strictEqual(r.daysCovered, 12);
const h = Object.fromEntries(r.hours.map(x => [x.bucket, x]));
assert.strictEqual(h['14:30+'].n, 12); assert.ok(h['14:30+'].avgNet > 7 && h['14:30+'].avgNet < 8, 'gross 10 minus ~2.4 cost');
assert.strictEqual(h['14:30+'].holds, true);
assert.strictEqual(h['11:00-12:00'].holds, false, 'good in older half only must not hold');
assert.ok(/fails a half/.test(h['11:00-12:00'].verdict) || /not positive/.test(h['11:00-12:00'].verdict));
assert.strictEqual(h['09:15-10:00'].holds, false); assert.ok(h['09:15-10:00'].avgNet < -5);
assert.strictEqual(h['12:00-13:00'].n, 0); assert.strictEqual(h['12:00-13:00'].verdict, 'no data');
assert.strictEqual(r.passed, 1); assert.strictEqual(r.qualifying, 3); assert.strictEqual(r.expectedByLuckAlone, 0.8);

// thin: default minN=20 with 12 trades -> not qualifying, never "holds"
r = computeHourStudy(rows);
assert.ok(r.hours.every(x => !x.holds)); assert.ok(/thin/.test(r.hours.find(x => x.bucket === '14:30+').verdict));

// decluster: two same-source fires 10 min apart count once
r = computeHourStudy([
    { id: 1, source: 'A', fire_ts: at('2026-10-13', 13, 5), coach_result: 5, entry_premium: 50 },
    { id: 2, source: 'A', fire_ts: at('2026-10-13', 13, 15), coach_result: 5, entry_premium: 50 },
    { id: 3, source: 'B', fire_ts: at('2026-10-13', 13, 15), coach_result: 5, entry_premium: 50 },
], { minN: 1, minHalfN: 1 });
assert.strictEqual(r.dropped, 1); assert.strictEqual(r.hours.find(x => x.bucket === '13:00-14:00').n, 2);

// coach_result clamped to [-100,100]; junk rows skipped; pre-open skipped
r = computeHourStudy([
    { id: 1, source: 'A', fire_ts: at('2026-10-13', 10, 0), coach_result: 900, entry_premium: 50 },
    { id: 2, source: 'A', fire_ts: at('2026-10-13', 10, 40), coach_result: null, entry_premium: 50 },
    { id: 3, source: 'A', fire_ts: at('2026-10-13', 10, 50), coach_result: 5, entry_premium: 0 },
    { id: 4, source: 'A', fire_ts: at('2026-10-13', 8, 50), coach_result: 5, entry_premium: 50 },
    { id: 5, source: 'A', fire_ts: 'junk', coach_result: 5, entry_premium: 50 },
]);
assert.strictEqual(r.overall.n, 1); assert.strictEqual(r.hours.find(x => x.bucket === '10:00-11:00').avgGross, 100); assert.strictEqual(r.skipped, 4);

// expiry filter: 2026-10-13 is a Tuesday
const two = [
    { id: 1, source: 'A', fire_ts: at('2026-10-13', 11, 0), coach_result: 5, entry_premium: 50 },
    { id: 2, source: 'A', fire_ts: at('2026-10-14', 11, 0), coach_result: 5, entry_premium: 50 },
];
assert.strictEqual(computeHourStudy(two, { expiry: 'only' }).overall.n, 1);
assert.strictEqual(computeHourStudy(two, { expiry: 'exclude' }).overall.n, 1);
assert.strictEqual(computeHourStudy(two, { expiry: 'all' }).overall.n, 2);

// empty / null input never throws
assert.strictEqual(computeHourStudy([]).overall.n, 0); assert.strictEqual(computeHourStudy(null).hours.length, BUCKETS.length);
// text output renders
const txt = formatHourText(computeHourStudy(rows, { minN: 5, minHalfN: 3 }), { instrument: 'NIFTY', days: 60 });
assert.ok(/HOUR-OF-DAY STUDY/.test(txt) && /14:30\+/.test(txt) && /luck alone/.test(txt));
assert.ok(typeof formatHourText(computeHourStudy([])) === 'string');
// cheap-premium entries are excluded (not allowed to drown the average) and net is floored at -100
r = computeHourStudy([
    { id: 1, source: 'A', fire_ts: at('2026-10-13', 15, 0), coach_result: 5, entry_premium: 2 },
    { id: 2, source: 'B', fire_ts: at('2026-10-13', 15, 0), coach_result: 5, entry_premium: 40 },
]);
assert.strictEqual(r.lowPremium, 1); assert.strictEqual(r.overall.n, 1); assert.ok(r.overall.avgNet > -2 && r.overall.avgNet < 0, 'gross 5 minus ~5.9 cost on a 40-pt premium');
r = computeHourStudy([{ id: 1, source: 'A', fire_ts: at('2026-10-13', 15, 0), coach_result: -100, entry_premium: 12 }], { minPremium: 1 });
assert.strictEqual(r.overall.avgNet, -100, 'net never below -100');
r = computeHourStudy([{ id: 1, source: 'A', fire_ts: at('2026-10-13', 15, 0), coach_result: 5, entry_premium: 2 }], { minPremium: 0 });
assert.strictEqual(r.overall.n, 1, 'minPremium 0 keeps everything');
console.log('hourStudy OK');