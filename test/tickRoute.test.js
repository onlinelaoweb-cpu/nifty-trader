'use strict';
const assert = require('assert');
const { isCrudeTick } = require('../src/utils/tickRoute');

// the 28 Oct case: crude socket still open after the crude window ended (clock says BITCOIN/CLOSED) -> still a crude tick
assert.strictEqual(isCrudeTick('CRUDEOIL', 'BITCOIN'), true);
assert.strictEqual(isCrudeTick('CRUDEOIL', 'CLOSED'), true);
assert.strictEqual(isCrudeTick('CRUDEOIL', 'NIFTY'), true);
assert.strictEqual(isCrudeTick('CRUDEOIL', 'CRUDEOIL'), true);
// the reverse: NIFTY socket still open at 17:30 when the clock flips to crude -> must stay a NIFTY tick
assert.strictEqual(isCrudeTick('NIFTY 50', 'CRUDEOIL'), false);
assert.strictEqual(isCrudeTick('NIFTY 50', 'NIFTY'), false);
assert.strictEqual(isCrudeTick('NIFTY 50', 'CLOSED'), false);
// no label (other callers): old clock-based behaviour
assert.strictEqual(isCrudeTick(undefined, 'CRUDEOIL'), true);
assert.strictEqual(isCrudeTick(null, 'NIFTY'), false);
assert.strictEqual(isCrudeTick('', 'CLOSED'), false);
console.log('tickRoute tests OK');