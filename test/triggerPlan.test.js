'use strict';
const assert = require('assert');
const { buildTriggerPlanBlock, insertBeforeFooter, alreadyHasPlan } = require('../src/utils/triggerPlan');

const NIFTY = { name: 'QUICK_SCALP', slPct: -15, breakevenAt: 10, halfBookAt: 15, fullExitAt: 25 };
const BTC = { name: 'WIDE_SL', slPct: -30, breakevenAt: 20, halfBookAt: 30, fullExitAt: 40 };

// NIFTY bullish: CE, levels from the grid
let b = buildTriggerPlanBlock({ direction: 'BULLISH', lock: { strike: 22550, premium: 100 }, grid: NIFTY, msg: 'x' });
assert.ok(b.includes('22,550 CE'), b);
assert.ok(b.includes('entry ~₹100'));
assert.ok(b.includes('SL ₹85 (-15%)'));
assert.ok(b.includes('BE ₹110 (+10%)'));
assert.ok(b.includes('book 50% ₹115 (+15%)'));
assert.ok(b.includes('full ₹125 (+25%)'));
assert.ok(b.includes('zone ₹96–102'));
assert.ok(b.includes("don't chase above ₹110"));
assert.ok(b.includes('QUICK_SCALP'));

// bearish -> PE; other grid
b = buildTriggerPlanBlock({ direction: 'BEARISH', lock: { strike: 80000, premium: 250.5 }, grid: BTC, msg: 'x' });
assert.ok(b.includes('80,000 PE'));
assert.ok(b.includes('SL ₹175.35 (-30%)'));
assert.ok(b.includes('full ₹350.7 (+40%)'));

// small strike (crude) is not comma-formatted
b = buildTriggerPlanBlock({ direction: 'BULLISH', lock: { strike: 580, premium: 12.4 }, grid: { name: 'STANDARD', slPct: -20, breakevenAt: 20, halfBookAt: 30, fullExitAt: 40 }, msg: 'x' });
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