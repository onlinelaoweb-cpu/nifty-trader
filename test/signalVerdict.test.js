const assert = require('assert');
const { verdict } = require('../public/js/signal-verdict.js');
const R = (w, l, pm, cm, pn = 100, cn = 100) => ({ win_count: w, loss_count: l, median_premium_pct_move: pm, median_coach_pct_move: cm, premium_resolved_count: pn, coach_resolved_count: cn });
// real rows from the 24 Oct audit
assert.strictEqual(verdict(R(24, 15, '2.1', '6.3')).key, 'strong');      // NIFTY Brahmastra
assert.strictEqual(verdict(R(28, 21, '1.9', '3.9')).key, 'strong');      // NIFTY Murarka
assert.strictEqual(verdict(R(22, 9, '0.0', '1.6')).key, 'strong');       // CRUDE Brahmastra
assert.strictEqual(verdict(R(42, 30, '-0.3', '-0.3')).key, 'watch');     // NIFTY Broad Market Shift
assert.strictEqual(verdict(R(71, 56, '-1.4', '-0.5')).key, 'watch');     // NIFTY Fast Momentum
assert.strictEqual(verdict(R(23, 14, '0.2', '-6.5')).key, 'watch');      // NIFTY Index Confirm
assert.strictEqual(verdict(R(33, 48, '-4.4', '-6.8')).key, 'weak');      // NIFTY S/R Bounce
assert.strictEqual(verdict(R(86, 94, '-2.4', '-5.3')).key, 'weak');      // NIFTY Opt RSI
assert.strictEqual(verdict(R(90, 122, '-1.0', '-2.5')).key, 'weak');     // CRUDE Main Engine
assert.strictEqual(verdict(R(39, 33, '-2.0', '-3.6')).key, 'weak');      // CRUDE Murarka
// small sample never gets a verdict
assert.strictEqual(verdict(R(13, 14, '1.3', '-4.9')).key, 'low');        // 27 decisive
assert.strictEqual(verdict(R(11, 7, '1.7', '3.2')).key, 'low');          // CRUDE Trend Rider 18
assert.strictEqual(verdict(R(15, 14, '5', '5')).key, 'low');             // 29 -> still low
assert.notStrictEqual(verdict(R(16, 14, '5', '5')).key, 'low');          // 30 -> verdict
// missing / null / strings / garbage fail safe
assert.strictEqual(verdict(null).key, 'low');
assert.strictEqual(verdict({}).key, 'low');
assert.strictEqual(verdict({ win_count: '20', loss_count: '15', median_premium_pct_move: null, median_coach_pct_move: null, premium_resolved_count: '0', coach_resolved_count: '0' }).key, 'watch'); // win 57% only -> +1 -> watch
// too few premium/coach results are ignored (neutral) instead of trusted
assert.strictEqual(verdict(R(20, 15, '-9', '-9', 3, 3)).key, 'watch');
console.log('signalVerdict tests OK');