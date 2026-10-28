'use strict';
const assert = require('assert');
const { computeWeightsFromRows, validateAgainstOfficial, refreshAutoWeights, effectiveWeights, getAutoWeightsState } = require('../src/utils/niftyWeightsAuto');
const { NIFTY_WEIGHTS } = require('../src/utils/niftyWeights');

// synthetic 50-stock universe built so that the top-10 match the official weights exactly
const rows = NIFTY_WEIGHTS.top10.map(s => ({ symbol: s.symbol, ffmc: s.weight * 1000 }));
const rest = 100 - NIFTY_WEIGHTS.top10.reduce((a, s) => a + s.weight, 0);
for (let i = 0; i < 40; i++) rows.push({ symbol: 'X' + i, ffmc: (rest / 40) * 1000 });
rows.push({ symbol: 'NIFTY 50', ffmc: 0 });

const m = computeWeightsFromRows(rows);
assert(m && Math.abs(m.HDFCBANK - 10.38) < 0.02 && !m['NIFTY 50']);
assert.strictEqual(computeWeightsFromRows(rows.slice(0, 20)), null, 'too few rows');
assert.strictEqual(computeWeightsFromRows(rows.map(r => ({ ...r, ffmc: null }))), null, 'no ffmc');
assert.strictEqual(validateAgainstOfficial(m, NIFTY_WEIGHTS.top10), '');
assert(validateAgainstOfficial({ ...m, HDFCBANK: 3 }, NIFTY_WEIGHTS.top10).includes('HDFCBANK'));

(async () => {
  const quiet = { log() {}, warn() {} };
  // failure keeps defaults
  let applied = 'no';
  let r = await refreshAutoWeights({ fetchRows: async () => [], officialTop10: NIFTY_WEIGHTS.top10, applyToBreadth: () => { applied = 'yes'; }, log: quiet });
  assert.strictEqual(r.ok, false); assert.strictEqual(applied, 'no');
  assert.strictEqual(effectiveWeights(NIFTY_WEIGHTS), NIFTY_WEIGHTS, 'no auto state -> same object');
  r = await refreshAutoWeights({ fetchRows: async () => { throw new Error('404'); }, officialTop10: NIFTY_WEIGHTS.top10, log: quiet });
  assert.strictEqual(r.ok, false);
  // bad data (HDFC 3x too small) rejected
  const bad = rows.map(x => x.symbol === 'HDFCBANK' ? { ...x, ffmc: 100 } : x);
  r = await refreshAutoWeights({ fetchRows: async () => bad, officialTop10: NIFTY_WEIGHTS.top10, log: quiet });
  assert.strictEqual(r.ok, false); assert.strictEqual(getAutoWeightsState().weights, null);
  // good data applied
  r = await refreshAutoWeights({ fetchRows: async () => rows, officialTop10: NIFTY_WEIGHTS.top10, applyToBreadth: () => 7, log: quiet });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.applied, 7);
  const eff = effectiveWeights(NIFTY_WEIGHTS);
  assert.notStrictEqual(eff, NIFTY_WEIGHTS); assert.strictEqual(eff.sectors, NIFTY_WEIGHTS.sectors); assert(eff.source.includes('auto'));
  // env switch
  process.env.NIFTY_WEIGHTS_AUTO = '0';
  r = await refreshAutoWeights({ fetchRows: async () => rows, officialTop10: NIFTY_WEIGHTS.top10, log: quiet });
  assert.strictEqual(r.why, 'disabled');
  console.log('niftyWeightsAuto ok');
})();

// breadth table: applied only when all top-20 present; originals restored otherwise
{
  const { applyAutoWeights } = require('../src/api/breadth');
  const partial = { RELIANCE: 8, HDFCBANK: 11 };
  assert.strictEqual(applyAutoWeights(partial), 0, 'incomplete map must not apply');
}