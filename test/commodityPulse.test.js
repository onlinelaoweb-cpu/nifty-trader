'use strict';
const assert = require('assert');
const CP = require('../public/js/commodity-pulse');
const T = (r, id) => r.tiles.find(t => t.id === id);

// Bitcoin as pasted 12 Oct 23:11 (session closed window, 5m BEAR, filter held at WAIT)
const btc = { session: 'NIFTY', price: 82415.5, open: 83955, high: 84320, low: 82346, indicators: { rsi: 46.7, adx: 29.0, ema9: 82443.2, ema21: 82470.1 },
  pcr: { pcr: 0.42 }, signal: { signal: 'WAIT', confidence: 0, mtf: {}, reasons: ['🚫 High-Conviction Filter: 68% < 70% required — held at WAIT', '📉 EMA9 DI+ 23.11', 'ADX 29.02 weak (+8)'] } };
let r = CP.compute('bitcoin', btc);
assert.strictEqual(T(r, 'tr').cls, 'bear'); assert.ok(/kamzor/.test(T(r, 'tr').full), 'gap -0.03%: direction but tiny gap');
assert.strictEqual(T(r, 'adx').cls, 'neu'); assert.ok(/gate khula/.test(T(r, 'adx').full), 'ADX 29 is gate-open but not strong');
assert.strictEqual(T(r, 'pcr').cls, 'bear');
assert.strictEqual(T(r, 'mtf').val, '--');
assert.deepStrictEqual(r.held, { have: 68, need: 70 });
assert.ok(r.chips.some(c => /68% < 70%/.test(c.t) && /2 pt/.test(c.t)));
assert.ok(/WAIT — setup ban raha tha \(68%\)/.test(T(r, 'sig').full));
assert.ok(/aakhri data/.test(r.verdict), 'not the BITCOIN session -> last data');
assert.strictEqual(r.count, 'BAND');
assert.ok(Math.round(parseFloat(T(r, 'rng').val)) === 4, 'near the day low: ' + T(r, 'rng').val);

// Crude as pasted: ADX 7.7 sideways, EMA flat, PCR 1.40, near day high
const cr = { session: 'CRUDEOIL', price: 8977, change: 96, changePct: 1.08, open: 8844, high: 8998, low: 8617, indicators: { rsi: 49.3, adx: 7.7, ema9: 8977.2, ema21: 8976.3 },
  pcr: { pcr: 1.40 }, signal: { signal: 'WAIT', confidence: 0, mtf: { tf1m: 'NEUTRAL', tf5m: 'NEUTRAL' }, reasons: ['↔️ EMA and DI direction disagree — no clean bias'] } };
r = CP.compute('crude', cr);
assert.strictEqual(T(r, 'tr').val, 'FLAT'); assert.strictEqual(T(r, 'adx').cls, 'bear'); assert.ok(/sideways/.test(T(r, 'adx').full));
assert.strictEqual(T(r, 'pcr').cls, 'bull'); assert.ok(/sideways/.test(r.verdict)); assert.strictEqual(r.count, 'LIVE'); assert.ok(!/aakhri/.test(r.verdict));
assert.ok(/94%/.test(T(r, 'rng').val) || Math.round(parseFloat(T(r, 'rng').val)) === 94);
assert.ok(r.chips.some(c => /ADX 7.7/.test(c.t)));
assert.ok(/₹8,977/.test(r.sum) && /\+1.08%/.test(r.sum));

// Active signal
r = CP.compute('crude', { session: 'CRUDEOIL', price: 100, indicators: { rsi: 55, adx: 33, ema9: 101, ema21: 100 }, pcr: { pcr: 1.3 }, signal: { signal: 'BUY CALL', confidence: 78, mtf: { tf1m: 'BULL', tf5m: 'BULL' }, reasons: [] } });
assert.strictEqual(r.cls, 'bull'); assert.ok(/BUY CALL — 78%/.test(r.verdict)); assert.strictEqual(T(r, 'mtf').cls, 'bull'); assert.strictEqual(T(r, 'adx').cls, 'bull');
assert.strictEqual(r.votes.bull, 4);
// tilt without signal
r = CP.compute('bitcoin', { session: 'BITCOIN', price: 100, indicators: { rsi: 55, adx: 25, ema9: 101, ema21: 100 }, pcr: { pcr: 1.3 }, signal: { signal: 'WAIT', mtf: { tf1m: 'BULL', tf5m: 'BULL' }, reasons: [] } });
assert.ok(/Jhukav upar/.test(r.verdict));
// RSI overbought chip, mixed votes, ⛔ blocked reason
r = CP.compute('bitcoin', { session: 'BITCOIN', price: 100, indicators: { rsi: 75, adx: 25, ema9: 101, ema21: 100 }, pcr: { pcr: 0.5 }, signal: { signal: 'WAIT', reasons: ['⛔ RSI 75 overbought (need <70) — WAIT'] } });
assert.ok(/Mixed/.test(r.verdict)); assert.ok(r.chips.some(c => /overbought/i.test(c.t))); assert.ok(/RSI 75/.test(T(r, 'sig').full));
// 15 Oct — Bitcoin window overlaps Crude's session: session says CRUDEOIL but windowOpen=true -> LIVE, not BAND
r = CP.compute('bitcoin', { session: 'CRUDEOIL', windowOpen: true, price: 100, indicators: { rsi: 50, adx: 14, ema9: 100, ema21: 100 }, signal: { signal: 'WAIT', reasons: [] } });
assert.strictEqual(r.count, 'LIVE'); assert.ok(!/aakhri data/.test(r.verdict)); assert.strictEqual(r.live, true);
r = CP.compute('bitcoin', { session: 'NIFTY', windowOpen: false, price: 100, indicators: { rsi: 50, adx: 14, ema9: 100, ema21: 100 }, signal: { signal: 'WAIT', reasons: [] } });
assert.strictEqual(r.count, 'BAND'); assert.ok(/aakhri data/.test(r.verdict));
r = CP.compute('crude', { session: 'NIFTY', windowOpen: true, price: 100, indicators: {}, signal: {} });
assert.strictEqual(r.count, 'BAND', 'crude ignores windowOpen');
// garbage / empty never throws
for (const x of [null, {}, { indicators: null, signal: null }, { session: 'X', price: 'abc' }]) { const q = CP.compute('crude', x); assert.strictEqual(q.tiles.length, 7); assert.ok(q.verdict); }
assert.ok(CP.compute('nope', {}).tiles.length === 7);
CP.render('crude', cr);   // no DOM: must not throw
console.log('commodityPulse OK');