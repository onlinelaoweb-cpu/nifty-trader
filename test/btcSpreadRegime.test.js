'use strict';
const assert = require('assert');
const { runBtcSpreadRegime, formatBtcSpreadRegimeText } = require('../src/utils/btcSpreadRegime');
// synthetic: spread% = -8 + 20 * move% (so break-even move = 0.4%)
let id = 0;
function mk(day, entry, movePct, dir = 'BULLISH') {
    const sign = dir === 'BULLISH' ? 1 : -1, evalPx = entry * (1 + sign * movePct / 100), pct = -8 + 20 * movePct;
    return { fire_ts: `2026-10-${day}T05:${String(id++ % 60).padStart(2, '0')}:00Z`, direction: dir, entry_price: entry, eval_price: evalPx, spread_pct_move: pct, spread_result: pct >= 10 ? 'WIN' : pct <= -10 ? 'LOSS' : 'FLAT' };
}
const rows = [];
for (let d = 1; d <= 8; d++) for (let k = 0; k < 6; k++) {
    const volatile = d % 2 === 0, entry = 80000 + (volatile ? k * 400 : k * 40), mv = (volatile ? 0.6 + d * 0.01 : 0.05 + d * 0.002) * (k % 2 ? 1 : 0.9);
    rows.push(mk(String(d).padStart(2, '0'), entry, mv, k % 3 ? 'BULLISH' : 'BEARISH'));
}
const s = runBtcSpreadRegime(rows);
assert.strictEqual(s.n, 48); assert.strictEqual(s.days.length, 8);
assert.ok(s.regime.high.avgSpreadPct > s.regime.low.avgSpreadPct, JSON.stringify(s.regime));
assert.ok(s.regime.high.avgSpreadPct > 0 && s.regime.low.avgSpreadPct < 0);
assert.ok(Math.abs(s.breakEven.breakEvenMovePct - 0.4) < 0.01, JSON.stringify(s.breakEven));
assert.ok(s.verdict.startsWith('VOLATILE DAYS PAY'), s.verdict);
assert.ok(formatBtcSpreadRegimeText(s).includes('break-even move'));
// everything loses even on wide days -> NOT JUST SIDEWAYS
const bad = []; for (let d = 1; d <= 8; d++) for (let k = 0; k < 6; k++) bad.push({ ...mk(String(d).padStart(2, '0'), 80000 + (d % 2 ? k * 40 : k * 400), 0.1), spread_pct_move: -12 - k, spread_result: 'LOSS' });
assert.ok(runBtcSpreadRegime(bad).verdict.startsWith('NOT JUST SIDEWAYS'), runBtcSpreadRegime(bad).verdict);
// too little / junk
assert.ok(runBtcSpreadRegime([{ fire_ts: '2026-10-01T00:00:00Z', direction: 'BULLISH', entry_price: 0, eval_price: 1, spread_pct_move: 1, spread_result: 'WIN' }]).verdict.startsWith('NOT ENOUGH DATA'));
console.log('btcSpreadRegime tests passed');