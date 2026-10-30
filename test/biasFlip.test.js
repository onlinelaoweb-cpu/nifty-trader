'use strict';
const assert = require('assert');
const { readFactors, createBiasTracker } = require('../src/utils/biasFlip');

const T0 = Date.UTC(2026, 9, 30, 5, 0, 0);            // any fixed ms
const min = n => n * 60000;
const bar = (delta, partial = false) => ({ label: 'x', delta, vol: 100000, partial });
const base = { dayKey: '2026-10-30', live: true, nifty: 22950, vwap: 22962, pcrTrend: 'FLAT', earlyMomSignal: 'NEUTRAL', oiSignal: 'NEUTRAL',
               mtfSignal: 'WAIT', engineSignal: 'WAIT', bosEvent: 'NONE', brahmastra: null, orderFlowBars: [bar(-21000), bar(0)] };

// ── readFactors ─────────────────────────────────────────────
let f = readFactors({ ...base, orderFlowBars: [bar(9000), bar(36000)] }, T0);
assert.strictEqual(f.orderFlow.side, 1);                                   // two buyer bars, net 45K
f = readFactors({ ...base, orderFlowBars: [bar(9000), bar(-2000)] }, T0);
assert.strictEqual(f.orderFlow.side, 0);                                   // mixed
f = readFactors({ ...base, orderFlowBars: [bar(-21000), bar(-16000), bar(99000, true)] }, T0);
assert.strictEqual(f.orderFlow.side, -1);                                  // the still-forming bar is ignored
f = readFactors({ ...base, orderFlowBars: [bar(1000), bar(2000)] }, T0);
assert.strictEqual(f.orderFlow.side, 0);                                   // tiny net -> neutral
assert.strictEqual(readFactors({ ...base, pcrTrend: 'RISING' }, T0).pcr.side, 1);
assert.strictEqual(readFactors({ ...base, pcrTrend: 'FALLING' }, T0).pcr.side, -1);
assert.strictEqual(readFactors({ ...base, oiSignal: 'BULL' }, T0).oiFlow.side, 1);
assert.strictEqual(readFactors({ ...base, earlyMomSignal: 'BEAR' }, T0).earlyMom.side, -1);
assert.strictEqual(readFactors({ ...base, nifty: 23000, vwap: 22962 }, T0).vwap.side, 1);
assert.strictEqual(readFactors({ ...base, nifty: 22962, vwap: 22962 }, T0).vwap.side, 0);
assert.strictEqual(readFactors({ ...base, mtfSignal: 'BUY CALL' }, T0).mtfLead.side, 1);
assert.strictEqual(readFactors({ ...base, mtfSignal: 'BUY PUT' }, T0).mtfLead.side, -1);
assert.strictEqual(readFactors({ ...base, bosEvent: 'CHOCH_BULLISH' }, T0).structure.side, 1);
assert.strictEqual(readFactors({ ...base, bosEvent: 'BOS_BEARISH' }, T0).structure.side, -1);
assert.strictEqual(readFactors({ ...base, brahmastra: { direction: 'BULLISH', atMs: T0 - min(20) } }, T0).brahmastra.side, 1);
assert.strictEqual(readFactors({ ...base, brahmastra: { direction: 'BULLISH', atMs: T0 - min(90) } }, T0).brahmastra.side, 0);  // stale
// garbage in -> neutral, never throws
f = readFactors({}, T0);
assert.ok(Object.values(f).every(x => x.side === 0));

// ── tracker: put bias -> bullish flip (the 30 Oct morning story) ──
const tr = createBiasTracker();
const bearInp = { ...base, nifty: 22930, pcrTrend: 'FALLING', oiSignal: 'BEAR', earlyMomSignal: 'BEAR', mtfSignal: 'BUY PUT', engineSignal: 'BUY PUT',
                  brahmastra: { direction: 'BEARISH', atMs: T0 }, orderFlowBars: [bar(-21000), bar(-16000)] };
let r = tr.update(bearInp, T0);                          // first look: pending (debounce)
assert.strictEqual(r.bias, 'NEUTRAL');
r = tr.update(bearInp, T0 + 20000);                      // second look: confirmed
assert.strictEqual(r.bias, 'BEAR');
assert.strictEqual(r.events[0].kind, 'TURN');
assert.strictEqual(r.flash.side, 'BEAR');
assert.strictEqual(r.flash.level, 'flip');

// early signs of the turn: order flow + pcr + OI turn bullish, bias is still BEAR (score still <= -1) -> early warning
const turning = { ...bearInp, pcrTrend: 'RISING', oiSignal: 'BULL', orderFlowBars: [bar(9000), bar(36000)] };
r = tr.update(turning, T0 + min(10));
assert.strictEqual(r.bias, 'BEAR');                      // score: -(earlyMom,mtf,engine,brah) +(orderflow,pcr,oi) = -1 -> still bear
assert.ok(r.early && r.early.toward === 'BULL' && r.early.count >= 2);

// confirmation arrives: structure + brahmastra bullish, VWAP reclaimed, engine call
const bull = { ...turning, nifty: 23000, earlyMomSignal: 'BULL', mtfSignal: 'BUY CALL', engineSignal: 'BUY CALL', bosEvent: 'CHOCH_BULLISH',
               brahmastra: { direction: 'BULLISH', atMs: T0 + min(15) } };
r = tr.update(bull, T0 + min(15));
assert.strictEqual(r.bias, 'BEAR');                      // one look is not enough (debounce)
r = tr.update(bull, T0 + min(15) + 20000);
assert.strictEqual(r.bias, 'BULL');
assert.strictEqual(r.events[0].kind, 'FLIP');
assert.strictEqual(r.events[0].from, 'BEAR');
assert.strictEqual(r.flash.side, 'BULL');
assert.ok(r.flash.untilMs - (T0 + min(15) + 20000) === 5 * 60 * 1000);
assert.ok(r.events[0].why.includes('Order Flow'));

// flash expires, steady state remains
r = tr.update(bull, T0 + min(15) + 20000 + min(6));
assert.strictEqual(r.bias, 'BULL');
assert.strictEqual(r.flash, null);

// hysteresis: a single bearish factor does not drop bull bias
r = tr.update({ ...bull, pcrTrend: 'FALLING' }, T0 + min(30));
r = tr.update({ ...bull, pcrTrend: 'FALLING' }, T0 + min(30) + 20000);
assert.strictEqual(r.bias, 'BULL');

// market closed: no flip events are created, state keeps
const n1 = r.events.length;
r = tr.update({ ...base, live: false }, T0 + min(40));
assert.strictEqual(r.live, false);
assert.strictEqual(r.events.length, n1);
assert.strictEqual(r.flash, null);

// new day resets
r = tr.update({ ...base, dayKey: '2026-11-02' }, T0 + 3 * 86400000);
assert.strictEqual(r.bias, 'NEUTRAL');
assert.strictEqual(r.events.length, 0);

// factor "since" times only move when the side changes
const t2 = createBiasTracker();
let a = t2.update({ ...base, pcrTrend: 'RISING' }, T0);
let b = t2.update({ ...base, pcrTrend: 'RISING' }, T0 + 60000);
assert.strictEqual(a.factors.find(x => x.key === 'pcr').sinceMs, b.factors.find(x => x.key === 'pcr').sinceMs);
b = t2.update({ ...base, pcrTrend: 'FALLING' }, T0 + 120000);
assert.strictEqual(b.factors.find(x => x.key === 'pcr').sinceMs, T0 + 120000);

console.log('biasFlip tests passed');