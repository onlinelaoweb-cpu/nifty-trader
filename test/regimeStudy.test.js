'use strict';
const assert = require('assert');
const R = require('../src/utils/regimeStudy');

// buckets
assert.strictEqual(R.bucketHealth(39), 'HEALTH LOW (<40)'); assert.strictEqual(R.bucketHealth(40), 'HEALTH MID (40-60)');
assert.strictEqual(R.bucketHealth(59.9), 'HEALTH MID (40-60)'); assert.strictEqual(R.bucketHealth(60), 'HEALTH HIGH (>=60)');
assert.strictEqual(R.bucketHealth(null), null); assert.strictEqual(R.bucketHealth(''), null);
assert.strictEqual(R.bucketLiveDay(30, 70), 'RANGE-LIKE (range>=60)'); assert.strictEqual(R.bucketLiveDay(65, 20), 'TREND-LIKE (trend>=60)');
assert.strictEqual(R.bucketLiveDay(50, 50), 'UNCLEAR'); assert.strictEqual(R.bucketLiveDay(null, null), null);
assert.strictEqual(R.bucketLiveDay(70, 70), 'RANGE-LIKE (range>=60)', 'range wins a tie (same as regimeClear)');
assert.strictEqual(R.bucketEngine('BUY CALL', 'BULLISH'), 'ENGINE AGREES'); assert.strictEqual(R.bucketEngine('BUY PUT', 'BEARISH'), 'ENGINE AGREES');
assert.strictEqual(R.bucketEngine('BUY PUT', 'BULLISH'), 'ENGINE OPPOSES'); assert.strictEqual(R.bucketEngine('WAIT', 'BULLISH'), 'ENGINE WAIT');
assert.strictEqual(R.bucketEngine(null, 'BULLISH'), null); assert.strictEqual(R.bucketEngine('BUY CALL', 'NEUTRAL'), null);

// attachRegime picks the latest snapshot at/before the fire and carries the new fields; old rows (no health cols) -> null buckets
const t0 = Date.parse('2026-10-08T05:30:00Z');
const snaps = [
    { ts: t0 - 20 * 60000, vix: 14, mtf_15m_adx: 22, signal: 'WAIT' },                                               // old-style row
    { ts: t0 - 4 * 60000, vix: 14, mtf_15m_adx: 27, signal: 'BUY CALL', health_total: 72, trend_prob: 65, range_prob: 20 },
    { ts: t0 + 1 * 60000, vix: 14, mtf_15m_adx: 10, signal: 'WAIT', health_total: 10, trend_prob: 0, range_prob: 90 }, // AFTER the fire: must not be used
];
const fires = [{ id: 1, source: 'Brahmastra', direction: 'BULLISH', fire_ts: t0, result: 'WIN', coach_result: 5 }];
let out = R.attachRegime(fires, snaps, [], { adxTf: '15m' });
assert.deepStrictEqual([out.rows[0].regime.health, out.rows[0].regime.liveDay, out.rows[0].regime.engine, out.rows[0].regime.adx],
    ['HEALTH HIGH (>=60)', 'TREND-LIKE (trend>=60)', 'ENGINE AGREES', 'TREND (>=25)']);
assert.strictEqual(out.coverage.withHealth, 1); assert.strictEqual(out.coverage.withEngine, 1);
out = R.attachRegime(fires, [snaps[0]], [], { adxTf: '15m', maxGapMin: 30 });   // only the old-style row
assert.deepStrictEqual([out.rows[0].regime.health, out.rows[0].regime.liveDay, out.rows[0].regime.engine], [null, null, 'ENGINE WAIT']);

// computeRegimeStudy exposes the three new dimensions (rows with null buckets are simply skipped)
const rows = [];
for (let d = 1; d <= 6; d++) for (let k = 0; k < 6; k++) {
    const ts = Date.UTC(2026, 9, d, 5, 30) + k * 3600000;
    rows.push({ id: d * 10 + k, source: 'Brahmastra', direction: 'BULLISH', fire_ts: ts, result: 'WIN', coach_result: 3,
        regime: { adx: 'TREND (>=25)', vix: 'MID (13-15)', session: 'MID 10:30-13:30', dayType: null,
                  health: k % 2 ? 'HEALTH HIGH (>=60)' : null, liveDay: null, engine: 'ENGINE WAIT' } });
}
const st = R.computeRegimeStudy(rows, { minN: 5, minDays: 3, minHalfN: 3 });
assert.ok(st.dimensions.health['HEALTH HIGH (>=60)'], 'health bucket present');
assert.ok(st.dimensions.engine['ENGINE WAIT'], 'engine bucket present');
assert.ok(!st.dimensions.liveDay || Object.keys(st.dimensions.liveDay).length === 0, 'null liveDay skipped');
console.log('regimeStudy: all tests passed');