'use strict';
const assert = require('assert');
const { runRangeFadeStudy, formatRangeFadeText, simulate } = require('../src/utils/rangeFadeStudy');
const T0 = 1_700_000_000;
// deterministic mean-reverting sideways series: oscillates 99..101 around 100, 5m bars
function sideways(n, amp = 1, period = 20) {
    return Array.from({ length: n }, (_, i) => { const c = 100 + amp * Math.sin(2 * Math.PI * i / period); const o = i ? 100 + amp * Math.sin(2 * Math.PI * (i - 1) / period) : c;
        return { t: T0 + i * 300, o, h: Math.max(o, c) + 0.02, l: Math.min(o, c) - 0.02, c }; });
}
// 1) clean oscillation: fading edges makes money (gross > 0), trades exist, both sides fire
let r = runRangeFadeStudy(sideways(3000), 'BTC', { hurdlePct: 0.05, minN: 20, minDays: 2 });
assert.ok(r.edge.n > 20, 'trades: ' + r.edge.n);
assert.ok(r.edge.avgGrossPct > 0, JSON.stringify(r.edge));
assert.ok(r.edgeLong.n > 0 && r.edgeShort.n > 0);
// 2) pure trend: no sideways windows -> no fades
const trend = Array.from({ length: 600 }, (_, i) => ({ t: T0 + i * 300, o: 100 + i * 0.5, h: 100.6 + i * 0.5, l: 99.9 + i * 0.5, c: 100.5 + i * 0.5 }));
assert.strictEqual(simulate(trend).trades.length, 0);
// 3) gap in data resets the window (no trade spans a 1-hour hole)
const gapped = sideways(300).map((b, i) => (i >= 150 ? { ...b, t: b.t + 3600 } : b));
assert.ok(simulate(gapped).trades.every(x => x.t < T0 + 150 * 300 || x.t > T0 + 150 * 300 + 3600 + 48 * 300));
// 4) impossible cost hurdle -> "MOVES TOO SMALL" or no edge, never POSSIBLE EDGE
r = runRangeFadeStudy(sideways(3000), 'BTC', { hurdlePct: 5, minN: 20, minDays: 2 });
assert.ok(!r.verdict.startsWith('POSSIBLE EDGE'), r.verdict);
// 5) tiny data -> not enough data; junk rows dropped; text renders
r = runRangeFadeStudy([{ t: NaN, o: 1, h: 1, l: 1, c: 1 }], 'NIFTY');
assert.ok(r.verdict.startsWith('NOT ENOUGH DATA'));
assert.ok(formatRangeFadeText([r, { instrument: 'CRUDE', error: 'x' }]).includes('DATA ERROR'));
console.log('rangeFadeStudy tests passed');