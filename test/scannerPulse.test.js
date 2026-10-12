'use strict';
const assert = require('assert');
const SP = require('../public/js/scanner-pulse');

const R = (name, pct, ratio, burst, ctx, sector) => ({ name, ltp: 100, pctChange: pct, ratio, burstRatio: burst, priceContext: ctx || '', sector: sector || 'Other' });
const rows = [
  R('A', 1.2, 3, 4, '20d high breakout', 'Banks'), R('B', 0.8, 2, 1, '', 'Banks'), R('C', 0.5, 2.2, 3.5, '', 'Banks'),
  R('D', -0.9, 2, 1, '20d low breakdown', 'IT'), R('E', 0.1, 3, 1, '', 'Other'), R('F', 0.4, 2, 1, '', 'Other'),
];
const r = SP.compute(rows);
assert.strictEqual(r.total, 6);
assert.strictEqual(r.counts.up, 4); assert.strictEqual(r.counts.down, 1);
assert.strictEqual(r.counts.breakout, 1); assert.strictEqual(r.counts.breakdown, 1); assert.strictEqual(r.counts.burst, 2);
assert.strictEqual(r.cls, 'bull'); assert.ok(/kharidari/.test(r.verdict));
const sec = r.tiles.find(t => t.key === 'sector');
assert.strictEqual(sec.cls, 'neu'); assert.strictEqual(sec.val, 'Banks');
assert.ok(r.chips.some(c => /flat/.test(c.t) && /E/.test(c.t)), 'E: heavy volume, flat price');
assert.deepStrictEqual(SP.filterRows(rows, 'burst').map(x => x.name), ['A', 'C']);
assert.deepStrictEqual(SP.filterRows(rows, 'breakdown').map(x => x.name), ['D']);
assert.strictEqual(SP.filterRows(rows, null).length, 6);
assert.strictEqual(SP.filterRows(rows, 'nope').length, 6);

// bearish mirror
const bear = SP.compute([R('X', -1, 2, 1), R('Y', -2, 2, 1), R('Z', -0.6, 2, 1), R('W', 0.5, 2, 1)]);
assert.strictEqual(bear.cls, 'bear'); assert.ok(/bikwali/.test(bear.verdict));
// mixed
assert.ok(/mixed/.test(SP.compute([R('X', 1, 2, 1), R('Y', -1, 2, 1)]).verdict));
// empty / garbage
const e = SP.compute([]); assert.strictEqual(e.total, 0); assert.ok(/Shaant/.test(e.verdict));
assert.strictEqual(SP.compute(null).total, 0);
assert.strictEqual(SP.compute([null, {}, { name: 'Q' }]).total, 1);
assert.strictEqual(SP.compute([{ name: 'Q' }]).counts.up, 0, 'missing pctChange is neither up nor down');
// no sector cluster when spread out
assert.strictEqual(SP.compute([R('a', 1, 2, 1, '', 'Banks'), R('b', 1, 2, 1, '', 'IT'), R('c', 1, 2, 1, '', 'Auto')]).tiles.find(t => t.key === 'sector').cls, 'wait');
// apply() without DOM must not throw and returns rows
assert.strictEqual(SP.apply({ results: rows }).length, 6);
assert.deepStrictEqual(SP.apply(null), []);
console.log('scannerPulse OK');