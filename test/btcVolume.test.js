'use strict';
const assert = require('assert');
const { volumeRatioFromCandles } = require('../src/utils/btcVolume');
const mk = (n, vol) => Array.from({ length: n }, (_, i) => ({ time: 1000 + i * 300, volume: vol }));
// steady volume -> 1.0x, last candle spike -> 3x
let c = mk(25, 100); c[24].volume = 300;
let r = volumeRatioFromCandles(c, 1000 + 25 * 300, 300);
assert.ok(Math.abs(r.ratio - 3) < 1e-9, JSON.stringify(r));
// in-progress candle is ignored (last one not finished yet)
r = volumeRatioFromCandles(c, 1000 + 24 * 300 + 100, 300);
assert.ok(Math.abs(r.ratio - 1) < 1e-9, JSON.stringify(r));
// too little data / zero volume -> null
assert.strictEqual(volumeRatioFromCandles(mk(4, 100), 99999, 300), null);
assert.strictEqual(volumeRatioFromCandles(mk(25, 0), 99999, 300), null);
assert.strictEqual(volumeRatioFromCandles(null, 1, 300), null);
console.log('btcVolume tests passed');