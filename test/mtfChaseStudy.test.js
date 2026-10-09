'use strict';
const assert = require('assert');
const L = require('../src/utils/mtfChaseStudy');

// ── tradeReturn
assert.deepStrictEqual(L.tradeReturn({ entry: 100, exit_premium: 130 }), { ret: 30, basis: 'exit' });
assert.deepStrictEqual(L.tradeReturn({ entry: 100, exit_premium: null, target_hit: true, target: 150 }), { ret: 50, basis: 'target' });
assert.deepStrictEqual(L.tradeReturn({ entry: 100, exit_premium: null, sl_hit: true, sl: 75 }), { ret: -25, basis: 'sl' });
assert.strictEqual(L.tradeReturn({ entry: 100, exit_premium: null }), null);
assert.strictEqual(L.tradeReturn({ entry: 0, exit_premium: 10 }), null);
assert.deepStrictEqual(L.tradeReturn({ entry: 100, exit_premium: 0 }), { ret: -100, basis: 'exit' });   // expired worthless is a real -100%

// ── buckets
assert.strictEqual(L.bucketRun60(0), '60m: AGAINST/FLAT (<=0 pts)');
assert.strictEqual(L.bucketRun60(49.9), '60m: SMALL (0-50 pts)');
assert.strictEqual(L.bucketRun60(50), '60m: MEDIUM (50-100 pts)');
assert.strictEqual(L.bucketRun60(100), '60m: EXTENDED (>=100 pts)');
assert.strictEqual(L.bucketRun60(null), null);
assert.strictEqual(L.bucketRunDay(200), 'DAY: EXTENDED (>=150 pts)');
assert.strictEqual(L.bucketRsi(79.6), 'RSI(side): >=70');
assert.strictEqual(L.bucketRsi(65), 'RSI(side): 60-70');
assert.strictEqual(L.bucketRsi(null), null);

// IST session: 04:03 UTC = 09:33 IST -> OPEN ; 05:30 UTC = 11:00 IST -> MID ; 09:00 UTC = 14:30 IST -> LATE
const D = (h, m) => Date.UTC(2026, 9, 9, h, m);
assert.strictEqual(L.bucketSession(D(4, 3)), 'OPEN 09:15-10:30');
assert.strictEqual(L.bucketSession(D(5, 30)), 'MID 10:30-13:30');
assert.strictEqual(L.bucketSession(D(9, 0)), 'LATE 13:30+');

// ── tagTrades: day opens 22240 at 09:20 IST (03:50 UTC); at 09:50 IST it is 22420 with RSI 79 -> CALL ran +180 on the day, +150 in 60m? (only 09:20 is >=60m earlier? no -> run60 null)
const snaps = [
    { ts: new Date(D(3, 50)), nifty: 22240, rsi: 50 },
    { ts: new Date(D(4, 20)), nifty: 22300, rsi: 62 },
    { ts: new Date(D(4, 50)), nifty: 22420, rsi: 79 },
    { ts: new Date(D(5, 50)), nifty: 22350, rsi: 30 },
];
const trades = [
    // CALL at 04:53 UTC (10:23 IST) right after snapshot 04:50 -> run60 vs snapshot at/before 03:53 => 03:50 (22240) => +180
    { id: 1, ts: new Date(D(4, 53)), signal: 'BUY CALL', entry: 140, exit_premium: 100, lead_quality: 'Strong Confluence', max_gain_pct: 4, max_adverse_pct: -30 },
    // PUT at 05:52 UTC (11:22 IST): nifty 22350, rsi 30 -> side RSI 70 ; run60 vs 04:52 -> snapshot 04:50 (22420) => PUT ran +70
    { id: 2, ts: new Date(D(5, 52)), signal: 'BUY PUT', entry: 100, exit_premium: 90, lead_quality: 'Moderate' },
    // no usable exit -> dropped
    { id: 3, ts: new Date(D(5, 52)), signal: 'BUY PUT', entry: 100, exit_premium: null },
    // no snapshot within gap (06:50 UTC, last snap 05:50 => 60 min) -> kept (it has a return) but no run/rsi tags
    { id: 4, ts: new Date(D(6, 50)), signal: 'BUY CALL', entry: 100, exit_premium: 120, lead_quality: 'Strong Confluence' },
];
const { rows, coverage } = L.tagTrades(trades, snaps, { maxGapMin: 10 });
assert.strictEqual(rows.length, 3);
assert.strictEqual(coverage.trades, 4); assert.strictEqual(coverage.withReturn, 3); assert.strictEqual(coverage.withSnapshot, 2);
const r1 = rows.find(r => r.id === 1), r2 = rows.find(r => r.id === 2), r4 = rows.find(r => r.id === 4);
assert.strictEqual(r1.ret, -28.6); assert.strictEqual(r1.run60, 180); assert.strictEqual(r1.runDay, 180); assert.strictEqual(r1.rsiSide, 79);
assert.strictEqual(r1.buckets.run60, '60m: EXTENDED (>=100 pts)'); assert.strictEqual(r1.buckets.rsi, 'RSI(side): >=70');
assert.strictEqual(r2.run60, 70); assert.strictEqual(r2.rsiSide, 70)
assert.strictEqual(r2.runDay, -(22350 - 22240));                                                                                        // PUT: market went UP on the day -> -110
assert.strictEqual(r4.run60, null); assert.strictEqual(r4.rsiSide, null); assert.strictEqual(r4.buckets.run60, null);

// ── computeMtfChaseStudy on a synthetic set: extended leads lose, early leads win
const many = [];
for (let i = 0; i < 20; i++) {
    const early = i % 2 === 0;
    many.push({ id: i, ts: D(4, 0) + i * 86400000, day: 'd' + i, ret: early ? 20 : -20, maxGain: 5, maxAdverse: -5, targetHit: false, slHit: false,
                run60: early ? 10 : 120, buckets: { leadQuality: 'Strong Confluence', session: 'OPEN 09:15-10:30', run60: early ? L.bucketRun60(10) : L.bucketRun60(120), runDay: null, rsi: null } });
}
const st = L.computeMtfChaseStudy(many, { minN: 8 });
assert.strictEqual(st.overall.n, 20); assert.strictEqual(st.overall.avgReturnPct, 0);
assert.strictEqual(st.earlyVsLate.early.avgReturnPct, 20); assert.strictEqual(st.earlyVsLate.extended.avgReturnPct, -20);
const ext = st.dimensions.run60.find(b => b.bucket.includes('EXTENDED'));
assert.strictEqual(ext.n, 10); assert.strictEqual(ext.avgReturnPct, -20); assert.strictEqual(ext.vsOverallPct, -20); assert.strictEqual(ext.thin, false);
assert.strictEqual(st.dimensions.runDay.length, 0);                              // all-null dimension -> no buckets
assert.strictEqual(L.computeMtfChaseStudy([], {}).overall.n, 0);                  // empty input does not throw
assert.strictEqual(L.computeMtfChaseStudy([many[0]], { minN: 8 }).dimensions.run60[0].thin, true);

console.log('mtfChaseStudy tests passed');