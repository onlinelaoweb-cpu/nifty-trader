'use strict';
// 28 Oct: ATM strike roll must not create fake CE/PE change (false CALL/PUT BUYERS).
// server.js can't be required, so the function source is extracted and run in a vm.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
const m = src.match(/function updateOptionFlow\([\s\S]*?\n\}\n/);
assert(m, 'updateOptionFlow not found');
const ctx = {
  marketState: { optionFlow: { atmCEpremium: null, atmPEpremium: null, ceChange: 0, peChange: 0, dominance: 'NEUTRAL', history: [] } },
  atmCEpremiumOpen: null, atmPEpremiumOpen: null, premiumOpenDate: null,
  ceOptionPremiumSeries: [], peOptionPremiumSeries: [], lastOptFlowStrike: null,
  getIST: () => new Date(Date.UTC(2026, 9, 28, 6, 0)), // any fixed time
};
vm.createContext(ctx);
vm.runInContext(m[0] + '\nthis.upd = updateOptionFlow;', ctx);
const f = () => ctx.marketState.optionFlow;

ctx.upd(195, 185, 22600);             // first poll of day
assert.strictEqual(f().dominance, 'NEUTRAL');
ctx.upd(196, 184, 22600);             // same strike, small move
assert.strictEqual(f().dominance, 'NEUTRAL');
ctx.upd(173, 207, 22650);             // ROLL: premiums differ by strike only
assert.strictEqual(f().ceChange, 0); assert.strictEqual(f().peChange, 0);
assert.strictEqual(f().dominance, 'NEUTRAL');
assert.strictEqual(f().history.length, 0, 'roll poll must not be logged');
assert.strictEqual(f().atmCEpremium, 173); // display level is the new ATM's
ctx.upd(195, 185, 22600);             // roll back
assert.strictEqual(f().dominance, 'NEUTRAL'); assert.strictEqual(f().history.length, 0);
// real move on the same strike still detected
ctx.upd(206, 175, 22600);             // CE +5.6%, PE -5.4%
assert.strictEqual(f().dominance, 'CALL BUYERS');
assert.strictEqual(f().history.length, 1);
// manual route (no strike) keeps old behaviour
ctx.upd(180, 190, null);
assert.notStrictEqual(f().ceChange, 0);
console.log('optionFlowRoll ok');