'use strict';
const assert = require('assert');
const data = require('../src/data/goLiveChecklist');
const GL = require('../public/js/golive-card.js');

// content sanity
assert.strictEqual(data.gates.length, 5);
data.gates.forEach(g => { assert.ok(g.id && g.title && g.items.length >= 5, g.id); g.items.forEach(t => assert.ok(typeof t === 'string' && t.length > 10)); });
assert.strictEqual(new Set(data.gates.map(g => g.id)).size, 5, 'unique gate ids');
const flat = JSON.stringify(data);
assert.ok(!/[A-Za-z0-9_-]{40,}/.test(flat.replace(/\s/g, ' ')) , 'no long token-like string in content');

// fmt: escapes html, renders code spans
assert.strictEqual(GL.fmt('a <b> `APP_TOKEN` & c'), 'a &lt;b&gt; <code>APP_TOKEN</code> &amp; c');

// summarize
let s = GL.summarize(data, {});
const total = data.gates.reduce((a, g) => a + g.items.length, 0);
assert.strictEqual(s.total, total); assert.strictEqual(s.done, 0); assert.strictEqual(s.live, false);
const all = {}; data.gates.forEach(g => g.items.forEach((_, i) => { all[g.id + ':' + i] = true; }));
s = GL.summarize(data, all);
assert.strictEqual(s.done, total); assert.strictEqual(s.gatesComplete, 5); assert.strictEqual(s.live, true);
const one = {}; data.gates[0].items.forEach((_, i) => { one['g1:' + i] = true; });
s = GL.summarize(data, one);
assert.strictEqual(s.gatesComplete, 1); assert.strictEqual(s.live, false); assert.strictEqual(s.gates[0].complete, true);
assert.strictEqual(GL.summarize(null, null).live, false, 'empty data is never "live"');
console.log('goLive OK');