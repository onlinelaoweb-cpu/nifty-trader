'use strict';
const assert = require('assert');
const WS = require('../public/js/wait-strip');

const ewTrade = { status: 'trade', label: 'Safe Entry (10:00–14:00)', safe: true };
const qgOk = { adxTrend: true, mtfAligned: true, rsiClean: true, vixSafe: true };
const base = (o) => Object.assign({ signal: 'WAIT', confidence: 4, reason: [], qualityGate: qgOk, entryWindow: ewTrade }, o || {});

// hidden when a real signal is showing, or when the market is closed / no window info
assert.strictEqual(WS.compute(base({ signal: 'BUY CALL', confidence: 72 })).show, false);
assert.strictEqual(WS.compute(base({ signal: 'BUY PUT' })).show, false);
assert.strictEqual(WS.compute(base({ entryWindow: { status: 'closed', safe: false } })).show, false);
assert.strictEqual(WS.compute(base({ entryWindow: null })).show, false);
assert.strictEqual(WS.compute(null).show, false);

// the 13 Oct 10:54 screenshot case: WAIT, 4%, every gate fine, no blocking reason -> honest "no safety check, signals just not strong"
let r = WS.compute(base());
assert.strictEqual(r.show, true); assert.strictEqual(r.tone, 'idle'); assert.strictEqual(r.conf, 4); assert.strictEqual(r.need, 60);
assert.ok(/koi safety check nahi/.test(r.why), r.why);
assert.ok(r.gates.length === 5 && r.gates.every(g => g.ok), 'five gates, all green');
assert.deepStrictEqual(r.gates.map(g => g.k), ['trend', 'charts', 'rsi', 'vix', 'time']);

// plain-language translation of the engine's own reasons
r = WS.compute(base({ reason: ['⛔ ADX 12 < 13 (VIX 13.5) — Choppy/sideways market. Wait for ADX ≥ 13'], qualityGate: Object.assign({}, qgOk, { adxTrend: false }) }));
assert.ok(/side-ways/.test(r.why) && /12/.test(r.unlock) && /13/.test(r.unlock), r.why + ' | ' + r.unlock);
assert.strictEqual(r.gates.find(g => g.k === 'trend').ok, false);

r = WS.compute(base({ reason: ['⛔ MTF not aligned (1/3 bull, 2/3 bear) — wait for all-3 agreement'], qualityGate: Object.assign({}, qgOk, { mtfAligned: false }) }));
assert.ok(/1 upar, 2 neeche/.test(r.why), r.why);

r = WS.compute(base({ reason: ['⛔ RSI not aligned for CALL — 15m:50 5m:52 1m:60 (need 15m>55, 5m>55, 1m<70)'] }));
assert.ok(/RSI/.test(r.why) && /upar/.test(r.why));
r = WS.compute(base({ reason: ['⛔ RSI not aligned for PUT — 15m:50 5m:52 1m:60 (need 15m<45, 5m<45, 1m>30)'] }));
assert.ok(/neeche/.test(r.why));

r = WS.compute(base({ reason: ['⛔ VIX 21.4 ≥ 20 — option premium too expensive for buyer, skip'] }));
assert.ok(/VIX/.test(r.why) && /20/.test(r.unlock));

r = WS.compute(base({ reason: ['⛔ Premium already +46% today — overextended, fresh entry not recommended (wait for pullback/pause)'] }));
assert.ok(/46%/.test(r.why));

r = WS.compute(base({ reason: ['🚫 High-Conviction Filter: 45% confidence < 60% required — held at WAIT'] }));
assert.ok(/45%/.test(r.why) && /60%/.test(r.why), r.why);
r = WS.compute(base({ reason: ['⛔ Confidence 52% < 60% minimum — edge too thin for option buyer, wait'] }));
assert.ok(/52%/.test(r.why));

// "almost there" states get the green 'soon' tone
r = WS.compute(base({ confidence: 40, reason: ['⏳ Signal confirming — cycle 1/2 (waiting for 2nd confirmation)'] }));
assert.strictEqual(r.tone, 'soon'); assert.ok(/confirm/.test(r.why));
r = WS.compute(base({ reason: ['🔒 Trend Lock: BUY PUT reversal pending confirmation (~4 min left) — holding BUY CALL'] }));
assert.strictEqual(r.tone, 'soon'); assert.ok(/4 minute/.test(r.unlock));

// priority: a hard block (⛔) beats a confirmation wait (⏳) and plain context lines, whatever the original order
r = WS.compute(base({ reason: ['📈 ADX 28 — Trend building', '⏳ Signal confirming — cycle 1/2', '⛔ VIX 22 ≥ 20 — option premium too expensive for buyer, skip'] }));
assert.ok(/VIX/.test(r.why), r.why);

// an engine block with no friendly wording is still shown (shortened), never hidden
r = WS.compute(base({ reason: ['⛔ Some brand new gate says no because of reasons ' + 'x'.repeat(200)] }));
assert.ok(/Engine ne ek safety check par roka/.test(r.why) && r.why.length < 170, r.why.length);

// time windows
r = WS.compute(base({ entryWindow: { status: 'volatile', safe: false } }));
assert.ok(/pehle 45 minute/.test(r.why) && /10:00/.test(r.unlock)); assert.strictEqual(r.gates.find(g => g.k === 'time').ok, false);
r = WS.compute(base({ entryWindow: { status: 'theta', safe: false } }));
assert.ok(/time-decay/.test(r.why));
// engine reason present + bad time -> engine reason leads, time shown as a note
r = WS.compute(base({ reason: ['⛔ VIX 22 ≥ 20 — option premium too expensive for buyer, skip'], entryWindow: { status: 'theta', safe: false } }));
assert.ok(/VIX/.test(r.why) && /time-decay/.test(r.timeNote));

// reasons may come from noTrade.reasons when s.reason is missing
r = WS.compute({ signal: 'WAIT', confidence: 10, entryWindow: ewTrade, qualityGate: qgOk, noTrade: { active: true, reasons: ['VIX 25 ≥ 20 — option premium too expensive for buyer, skip'] } });
assert.ok(/VIX/.test(r.why));

// confidence bar is clamped; missing/garbage values do not throw
assert.strictEqual(WS.compute(base({ confidence: 250 })).confPct, 100);
assert.strictEqual(WS.compute(base({ confidence: -5 })).confPct, 0);
assert.strictEqual(WS.compute(base({ confidence: 'abc' })).conf, 0);
assert.doesNotThrow(() => WS.compute({ signal: 'WAIT', entryWindow: ewTrade, reason: [null, undefined, 5, {}] }));
assert.doesNotThrow(() => WS.compute({ signal: 'WAIT', entryWindow: ewTrade, qualityGate: { adxTrend: null } }));
assert.strictEqual(WS.compute({ signal: 'WAIT', entryWindow: ewTrade, qualityGate: { adxTrend: null } }).gates.length, 1, 'unknown (null) gates are not drawn; time gate still is');

// 15 Oct — momentum-gate-blocked wording (the 11:55 screenshot: bullish score, last candle a Doji)
r = WS.compute(base({ reason: ['Mixed signals', '⏳ Bullish score but momentum gate blocked (last candle not bullish)'] }));
assert.strictEqual(r.tone, 'soon');
assert.ok(/upar ki taraf/.test(r.why) && /pichhli 1-minute candle hari/.test(r.why), r.why);
r = WS.compute(base({ reason: ['⏳ Bearish score but momentum gate blocked (last candle not bearish, price not below VWAP, EMA9 ≥ EMA21)'] }));
assert.ok(/neeche ki taraf/.test(r.why) && /VWAP ke neeche nahi/.test(r.why) && /EMA21 ke neeche nahi/.test(r.why), r.why);

// 15 Oct — real vote split replaces the fixed 30% when the server sends it
r = WS.compute(base({ confidence: 30, voteTally: { bull: 7, bear: 5, bullPct: 58, needPct: 65 } }));
assert.ok(r.vote && r.vote.lead === 'BULL' && r.vote.leadPct === 58 && r.vote.bull === 7 && r.vote.bear === 5 && r.vote.need === 65);
r = WS.compute(base({ voteTally: { bull: 2, bear: 6, bullPct: 25, needPct: 65 } }));
assert.ok(r.vote.lead === 'BEAR' && r.vote.leadPct === 75);
assert.strictEqual(WS.compute(base()).vote, null, 'no tally -> old bar');
assert.strictEqual(WS.compute(base({ voteTally: { bull: 0, bear: 0, bullPct: null } })).vote, null);
assert.doesNotThrow(() => WS.compute(base({ voteTally: 'junk' })));

// render() is safe in Node (no DOM)
assert.doesNotThrow(() => WS.render(base()));

// no network / AI anywhere in the module
const src = require('fs').readFileSync(require('path').join(__dirname, '../public/js/wait-strip.js'), 'utf8');
assert.ok(!/fetch\(|XMLHttpRequest|anthropic|axios/i.test(src), 'strip must not call any API');

console.log('waitStrip OK');