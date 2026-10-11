'use strict';
const assert = require('assert');
const { runBtcSpreadStudy, formatBtcSpreadText } = require('../src/utils/btcSpreadStudy');
const mk = (day, pct, result, source = 'A', dir = 'BULLISH') => ({ source, fire_ts: `2026-10-${day}T05:00:00Z`, spread_pct_move: pct, spread_result: result, premium_pct_move: pct + 5, direction: dir });
// too little data
let s = runBtcSpreadStudy([mk('05', 20, 'WIN')]);
assert.ok(s.verdict.startsWith('NOT ENOUGH DATA'), s.verdict);
// NO_DATA and null pct are dropped
s = runBtcSpreadStudy([mk('05', null, 'WIN'), mk('05', 10, 'NO_DATA')]);
assert.strictEqual(s.all.n, 0);
// consistent losers over many days -> LOSING
const rows = []; for (let d = 1; d <= 8; d++) for (let k = 0; k < 5; k++) rows.push(mk(String(d).padStart(2, '0'), -30 - k + (d % 3), 'LOSS'));
s = runBtcSpreadStudy(rows);
assert.ok(s.verdict.startsWith('LOSING'), s.verdict);
assert.strictEqual(s.all.n, 40); assert.strictEqual(s.all.days, 8); assert.strictEqual(s.all.winRatePct, 0);
// weekend split: 2026-10-10 is Saturday, 2026-10-11 Sunday, 2026-10-09 Friday
s = runBtcSpreadStudy([mk('10', 5, 'FLAT'), mk('11', 5, 'FLAT'), mk('09', 5, 'FLAT')]);
assert.strictEqual(s.weekend.n, 2); assert.strictEqual(s.weekday.n, 1);
// one huge day among noisy days must not fake an edge
const noisy = []; for (let d = 1; d <= 8; d++) for (let k = 0; k < 5; k++) noisy.push(mk(String(d).padStart(2, '0'), d === 1 ? 60 : (d % 2 ? 8 : -8), d === 1 ? 'WIN' : 'FLAT'));
s = runBtcSpreadStudy(noisy);
assert.ok(s.verdict.startsWith('NO CLEAR EDGE'), s.verdict);
assert.ok(formatBtcSpreadText(s).includes('VERDICT'));
console.log('btcSpreadStudy tests passed');