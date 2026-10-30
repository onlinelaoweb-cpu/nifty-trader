'use strict';
const assert = require('assert');
const { computeOiImbalance } = require('../src/utils/oiImbalance');
// 30 Oct 12:00 live case: puts +62,140, calls -549,250 (call unwinding) -> must NOT read as bearish
assert.strictEqual(computeOiImbalance(62140, -549250), 9.99);
// 09:49 and 11:21 cases (both sides written) keep their old values
assert.strictEqual(computeOiImbalance(263315, 683345), 0.39);
assert.strictEqual(computeOiImbalance(1170, 111865), 0.01);
// calls written, puts unwound -> bearish 0
assert.strictEqual(computeOiImbalance(-80000, 120000), 0);
// both unwound / nothing -> null
assert.strictEqual(computeOiImbalance(-5000, -9000), null);
assert.strictEqual(computeOiImbalance(0, 0), null);
assert.strictEqual(computeOiImbalance(null, 5), null);
assert.strictEqual(computeOiImbalance(NaN, 5), null);
// puts written, calls flat
assert.strictEqual(computeOiImbalance(50000, 0), 9.99);
console.log('oiImbalance tests passed');