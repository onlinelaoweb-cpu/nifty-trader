'use strict';
const assert = require('assert');
const { headlinesKey, decide, pickText, describeReply } = require('../src/utils/newsGate');

// ── headlinesKey: order / case / spacing do not matter; different news gives a different key ──
const a = headlinesKey(['RBI holds rate', 'Nifty  hits   record', 'FII buy']);
const b = headlinesKey(['fii buy', 'nifty hits record', ' RBI holds rate ']);
assert.strictEqual(a, b, 'same headlines in another order/case must give the same key');
assert.notStrictEqual(a, headlinesKey(['RBI holds rate', 'Nifty hits record', 'FII sell']));
assert.strictEqual(headlinesKey([]), '');
assert.strictEqual(headlinesKey(null), '');
assert.strictEqual(headlinesKey(['', '  ', null]), '', 'blank headlines are ignored');
assert.strictEqual(headlinesKey(['x']).length, 40, 'sha1 hex');

// ── decide ──
assert.strictEqual(decide({ marketDay: false, key: 'k', lastKey: null }), 'closed');
assert.strictEqual(decide({ marketDay: false, key: 'k', lastKey: 'k' }), 'closed', 'closed wins over same');
assert.strictEqual(decide({ marketDay: true, key: 'k', lastKey: 'k' }), 'same');
assert.strictEqual(decide({ marketDay: true, key: 'k2', lastKey: 'k' }), 'call');
assert.strictEqual(decide({ marketDay: true, key: 'k', lastKey: null }), 'call');
assert.strictEqual(decide({ marketDay: true, key: '', lastKey: '' }), 'call', 'empty key never counts as "same"');

// ── pickText: skips thinking blocks, tolerates junk ──
assert.strictEqual(pickText({ content: [{ type: 'text', text: '{"score":10}' }] }), '{"score":10}');
assert.strictEqual(pickText({ content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: '{"score":-5}' }] }), '{"score":-5}');
assert.strictEqual(pickText({ content: [{ type: 'thinking', thinking: '...' }] }), '');
assert.strictEqual(pickText({ content: [{ type: 'text', text: '   ' }] }), '');
assert.strictEqual(pickText({ content: [] }), '');
assert.strictEqual(pickText({}), '');
assert.strictEqual(pickText(null), '');

// ── describeReply ──
assert.strictEqual(describeReply(null), 'no response body');
assert.strictEqual(
    describeReply({ stop_reason: 'max_tokens', content: [{ type: 'thinking' }], usage: { input_tokens: 420, output_tokens: 200 } }),
    'stop_reason=max_tokens blocks=[thinking] tokens in=420 out=200');
assert.strictEqual(describeReply({}), 'stop_reason=? blocks=[none] tokens in=? out=?');

console.log('newsGate OK');