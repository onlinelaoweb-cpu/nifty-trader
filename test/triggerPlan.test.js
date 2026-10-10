'use strict';
const assert = require('assert');
const { buildTriggerPlanBlock, insertBeforeFooter, alreadyHasPlan } = require('../src/utils/triggerPlan');

const NIFTY = { name: 'QUICK_SCALP', slPct: -15, breakevenAt: 10, halfBookAt: 15, fullExitAt: 25 };
const BTC = { name: 'WIDE_SL', slPct: -30, breakevenAt: 20, halfBookAt: 30, fullExitAt: 40 };

// NIFTY bullish: CE, rupee levels only (no percentages)
let b = buildTriggerPlanBlock({ direction: 'BULLISH', lock: { strike: 22550, premium: 100 }, grid: NIFTY, msg: 'x', instrument: 'NIFTY', trailPts: 10 });
assert.ok(b.includes('22,550 CE'), b);
assert.ok(b.includes('Entry ₹100 '), b);
assert.ok(b.includes('SL ₹85\n'), b);
assert.ok(b.includes('Trailing SL: at ₹110 move SL to ₹100 (cost)'), b);
assert.ok(b.includes('trail ₹10 below the peak'), b);
assert.ok(b.includes('Half book (sell half) ₹115'), b);
assert.ok(b.includes('T1 ₹110 · T2 ₹120 · T3 / Final ₹125'), b);
assert.ok(b.includes('zone ₹96–102'));
assert.ok(b.includes("don't chase above ₹110"));
assert.ok(b.includes('QUICK_SCALP'));
assert.ok(!/\d\s?%/.test(b), 'no percentages in the block');

// trailing off -> no trail clause
b = buildTriggerPlanBlock({ direction: 'BULLISH', lock: { strike: 22550, premium: 100 }, grid: NIFTY, msg: 'x', instrument: 'NIFTY', trailPts: 0 });
assert.ok(!b.includes('below the peak'));

// premium rounded to the 0.05 tick for NIFTY/CRUDE
b = buildTriggerPlanBlock({ direction: 'BULLISH', lock: { strike: 22550, premium: 87.35 }, grid: NIFTY, msg: 'x', instrument: 'NIFTY' });
assert.ok(b.includes('SL ₹74.25'), b);            // 87.35*0.85 = 74.2475 -> 74.25
assert.ok(b.includes('Entry ₹87.35'), b);

// bearish -> PE; other grid, non-tick instrument keeps 2 decimals
b = buildTriggerPlanBlock({ direction: 'BEARISH', lock: { strike: 80000, premium: 250.5 }, grid: BTC, msg: 'x', instrument: 'BITCOIN' });
assert.ok(b.includes('80,000 PE'));
assert.ok(b.includes('SL ₹175.35'), b);
assert.ok(b.includes('Final ₹350.7'), b);

// small strike (crude) is not comma-formatted
b = buildTriggerPlanBlock({ direction: 'BULLISH', lock: { strike: 580, premium: 12.4 }, grid: { name: 'STANDARD', slPct: -20, breakevenAt: 20, halfBookAt: 30, fullExitAt: 40 }, msg: 'x', instrument: 'CRUDE' });
assert.ok(b.includes('580 CE'));

// nothing trustworthy -> null (never a half-filled block)
assert.strictEqual(buildTriggerPlanBlock({ direction: 'BULLISH', lock: null, grid: NIFTY, msg: 'x' }), null);
assert.strictEqual(buildTriggerPlanBlock({ direction: 'BULLISH', lock: { strike: 22550, premium: 0 }, grid: NIFTY, msg: 'x' }), null);
assert.strictEqual(buildTriggerPlanBlock({ direction: 'BULLISH', lock: { strike: 0, premium: 100 }, grid: NIFTY, msg: 'x' }), null);
assert.strictEqual(buildTriggerPlanBlock({ direction: 'BULLISH', lock: { strike: 22550, premium: 'abc' }, grid: NIFTY, msg: 'x' }), null);
assert.strictEqual(buildTriggerPlanBlock({ direction: 'BULLISH', lock: { strike: 22550, premium: 100 }, grid: null, msg: 'x' }), null);
assert.strictEqual(buildTriggerPlanBlock({ direction: null, lock: { strike: 22550, premium: 100 }, grid: NIFTY, msg: 'x' }), null);

// message that already has its own SL plan (Classic) is left alone
assert.strictEqual(alreadyHasPlan('🎯 ATM 22550 CE @ ₹100 (premium SL -20%, then follow the Trade-Coach exits)'), true);
assert.strictEqual(alreadyHasPlan('Stop-loss below 22500'), true);
assert.strictEqual(alreadyHasPlan('stoploss 22500'), true);
assert.strictEqual(alreadyHasPlan('BRAHMASTRA 3 TRIGGERS ALIGNED, size small'), false);   // "ALIGNED"/"size" must not match
assert.strictEqual(alreadyHasPlan(''), false);
assert.strictEqual(alreadyHasPlan(null), false);
assert.strictEqual(buildTriggerPlanBlock({ direction: 'BULLISH', lock: { strike: 22550, premium: 100 }, grid: NIFTY, msg: 'premium SL -20%' }), null);

// footer handling
const msg = 'line1\ntrack record\n<i>Vardaan AI — X</i>';
assert.strictEqual(insertBeforeFooter(msg, 'PLAN'), 'line1\ntrack record\nPLAN\n<i>Vardaan AI — X</i>');
assert.strictEqual(insertBeforeFooter('a\nb', 'PLAN'), 'a\nb\nPLAN');
assert.strictEqual(insertBeforeFooter(msg, null), msg);

console.log('triggerPlan tests passed');