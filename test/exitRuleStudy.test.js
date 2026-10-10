'use strict';
const assert = require('assert');
const L = require('../src/utils/exitRuleStudy');

// ── reference = verbatim copy of simulateTradeCoachCore (server.js) so BASE can be proven identical
function ref(entryPremium, pathSamples, thresholds) {
    if (!(entryPremium > 0) || !pathSamples?.length) return null;
    const { slPct = -20, breakevenAt = 20, halfBookAt = 30, fullExitAt = 40 } = thresholds || {};
    let remaining = 100, slLevel = slPct, realizedPct = 0;
    for (const sample of pathSamples) {
        if (remaining <= 0) break;
        const pct = ((sample.premium - entryPremium) / entryPremium) * 100;
        if (pct <= slLevel) { realizedPct += (remaining / 100) * pct; remaining = 0; break; }
        if (pct >= fullExitAt) { realizedPct += (remaining / 100) * pct; remaining = 0; break; }
        if (remaining === 100 && pct >= halfBookAt) { realizedPct += 0.5 * pct; remaining = 50; }
        if (slLevel === slPct && pct >= breakevenAt) slLevel = 0;
    }
    if (remaining > 0) { const lastPct = ((pathSamples[pathSamples.length - 1].premium - entryPremium) / entryPremium) * 100; realizedPct += (remaining / 100) * lastPct; }
    return { coachResult: parseFloat(realizedPct.toFixed(2)) };
}

// deterministic pseudo-random walk paths
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const T0 = Date.UTC(2026, 9, 8, 4, 0);   // 09:30 IST
const mkOutcome = (id, src, minOffset) => {
    const entry = 80 + rnd() * 80, path = []; let p = entry;
    for (let k = 1; k <= 18; k++) { p = Math.max(1, p * (1 + (rnd() - 0.47) * 0.12)); path.push({ ts: T0 + (minOffset + k * 5) * 60000, premium: p }); }
    return { id, source: src, fireTs: T0 + minOffset * 60000, entryPremium: entry, path };
};

const grid = { slPct: -15, breakevenAt: 10, halfBookAt: 15, fullExitAt: 25 };
const baseRule = L.buildVariants(grid).find(v => v.name === 'BASE').rule;
for (let i = 0; i < 400; i++) {
    const o = mkOutcome(i, 'X', 0);
    assert.strictEqual(L.simulateRule(o.entryPremium, o.path, o.fireTs, baseRule).result, ref(o.entryPremium, o.path, grid).coachResult, 'BASE must equal the live simulator (path ' + i + ')');
}

// ── scripted scenarios
const P = (entry, pcts) => pcts.map((x, i) => ({ ts: T0 + (i + 1) * 5 * 60000, premium: entry * (1 + x / 100) }));
// 1. straight to stop
assert.strictEqual(L.simulateRule(100, P(100, [-5, -16]), T0, baseRule).result, -16);
// 2. trail: +25 books 50% (+12.5), then peak 50 -> trail stop at 35 (gap 15): second half exits at the sample that falls to <=35 (34)
const trail = { slPct: -15, beAt: 25, halfAt: 25, fullAt: null, trailGap: 15, timeStop: null, earlyCut: null };
let s = L.simulateRule(100, P(100, [26, 50, 34]), T0, trail);
assert.strictEqual(s.reason, 'trail_stop'); assert.strictEqual(s.result, parseFloat((0.5 * 26 + 0.5 * 34).toFixed(2)));
// 3. trail never rides beyond: without a drop it ends by time exit at last sample
s = L.simulateRule(100, P(100, [26, 40, 60]), T0, trail); assert.strictEqual(s.reason, 'time_exit');
// 4. time stop: nothing above +5 by 45 min -> exit at that sample
const ts = { ...baseRule, timeStop: { min: 45, peak: 5 } };
s = L.simulateRule(100, P(100, [1, 2, 0, 1, 2, 1, 0, 1, 2, 1]), T0, ts); assert.strictEqual(s.reason, 'time_stop');
// time stop does NOT fire if it already reached the peak level
s = L.simulateRule(100, P(100, [6, 1, 0, 1, 2, 1, 0, 1, 2, 1]), T0, ts); assert.notStrictEqual(s.reason, 'time_stop');
// 5. early cut: -9% in the first 15 min -> exit at -9 (not -15)
const ec = { ...baseRule, earlyCut: { withinMin: 15, pct: -8 } };
s = L.simulateRule(100, P(100, [-3, -9, -20]), T0, ec); assert.strictEqual(s.reason, 'early_cut'); assert.strictEqual(s.result, -9);
// early cut ignored after the window
s = L.simulateRule(100, P(100, [1, 1, 1, 1, -9, -20]), T0, ec); assert.strictEqual(s.reason, 'stop_loss');
// 6. bad input
assert.strictEqual(L.simulateRule(0, P(100, [1]), T0, baseRule), null);
assert.strictEqual(L.simulateRule(100, [], T0, baseRule), null);

// ── hour buckets (IST)
assert.strictEqual(L.hourBucket(Date.UTC(2026, 9, 8, 4, 0)), '09:15-10:30');      // 09:30 IST
assert.strictEqual(L.hourBucket(Date.UTC(2026, 9, 8, 6, 0)), '10:30-12:00');      // 11:30 IST
assert.strictEqual(L.hourBucket(Date.UTC(2026, 9, 8, 8, 0)), '12:00-14:00');      // 13:30 IST
assert.strictEqual(L.hourBucket(Date.UTC(2026, 9, 8, 9, 30)), '14:00-15:30');     // 15:00 IST

// ── full study on synthetic data
const outs = []; for (let i = 0; i < 160; i++) outs.push(mkOutcome(i, i % 2 ? 'Alpha' : 'Beta', i * 40 + (i % 3)));
const study = L.computeExitRuleStudy(outs, grid, { declusterMin: 30, minHalfN: 30, minSourceN: 15, referenceSim: ref });
assert.ok(study.faithfulness.startsWith('OK'), study.faithfulness);
assert.strictEqual(study.variants.length, 9);
assert.strictEqual(study.variants[0].name, 'BASE'); assert.strictEqual(study.variants[0].deltaVsBase, 0);
assert.ok(study.tradesUsed > 100);
assert.ok(study.variants.every(v => v.verdict && typeof v.n === 'number'));
assert.strictEqual(study.byHour.length, 4);
// tiny sample -> INSUFFICIENT, never a lead
const tiny = L.computeExitRuleStudy(outs.slice(0, 10), grid, { minHalfN: 30 });
assert.ok(tiny.variants.filter(v => v.name !== 'BASE').every(v => v.verdict.startsWith('INSUFFICIENT')));
// ── day gaps: Mon close 100 -> Tue open 101 (+1%), Tue close 101 -> Wed open 101.1 (+0.1%); Thu has no previous close -> unknown
const snap = (day, hh, mm, px) => ({ ts: new Date(Date.UTC(2026, 9, day, hh - 5, mm - 30)), nifty: px });   // IST -> UTC
const gaps = L.computeDayGaps([snap(5, 9, 20, 99), snap(5, 15, 30, 100), snap(6, 9, 16, 101), snap(6, 15, 25, 101), snap(7, 9, 17, 101.1), snap(9, 9, 20, 102)]);
assert.strictEqual(gaps['2026-10-06'], 1); assert.strictEqual(gaps['2026-10-07'], 0.1);
assert.strictEqual(gaps['2026-10-09'], undefined);   // 8 Oct has no close snapshot, 7 Oct has no close either -> unknown
assert.strictEqual(gaps['2026-10-05'], undefined);   // first day, no previous close
assert.deepStrictEqual(L.computeDayGaps(null), {});
// day-type slices: 6 Oct 2026 is a Tuesday (expiry), 7 Oct is a Wednesday
const dayOuts = [];
for (const [day, n] of [[6, 20], [7, 20], [9, 20]]) for (let i = 0; i < n; i++) { const o = mkOutcome(day * 100 + i, 'Alpha', 0); const base = Date.UTC(2026, 9, day, 4, 0) + i * 40 * 60000 - T0; dayOuts.push({ ...o, fireTs: o.fireTs + base, path: o.path.map(p => ({ ...p, ts: p.ts + base })) }); }
const dt = L.computeExitRuleStudy(dayOuts, grid, { declusterMin: 0, nifty: true, dayGaps: gaps, gapPct: 0.4 });
const exp = dt.byDayType.expiry.find(s => s.label === 'expiry day (Tue)'), oth = dt.byDayType.expiry.find(s => s.label === 'other days');
assert.strictEqual(exp.n, 20); assert.strictEqual(oth.n, 40);
assert.strictEqual(dt.byDayType.gap.find(s => s.label.startsWith('gap-up')).n, 20);
assert.strictEqual(dt.byDayType.gap.find(s => s.label.startsWith('no gap')).n, 20);
assert.strictEqual(dt.byDayType.gap.find(s => s.label === 'gap unknown').n, 20);
assert.ok(L.formatExitRuleText(dt).includes('BY EXPIRY DAY') && L.formatExitRuleText(dt).includes('BY GAP AT OPEN'));
assert.strictEqual(L.computeExitRuleStudy(dayOuts, grid, { declusterMin: 0 }).byDayType, undefined);   // not NIFTY -> no day-type slices

// text renders; empty / bad input never throws
assert.ok(L.formatExitRuleText(study).includes('PER TRIGGER') && L.formatExitRuleText(study).includes('BY TIME OF DAY'));
assert.strictEqual(L.computeExitRuleStudy([], grid).tradesUsed, 0);
assert.strictEqual(L.computeExitRuleStudy(null, grid).tradesUsed, 0);
assert.doesNotThrow(() => L.formatExitRuleText(L.computeExitRuleStudy(null, grid)));

console.log('exitRuleStudy tests passed');