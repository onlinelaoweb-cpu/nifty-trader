'use strict';
const assert = require('assert');
const L = require('../src/utils/mtfLeadRegime');

// ── leadReturn: exit premium first, then target/SL, else null
assert.strictEqual(L.leadReturn({ entry: 100, exit_premium: 126.7 }), 26.7);
assert.strictEqual(L.leadReturn({ entry: 100, target_hit: true, target: 150 }), 50);
assert.strictEqual(L.leadReturn({ entry: 100, sl_hit: true, sl: 75 }), -25);
assert.strictEqual(L.leadReturn({ entry: 100 }), null);
assert.strictEqual(L.leadReturn({ entry: 0, exit_premium: 5 }), null);

// ── leadSide
assert.strictEqual(L.leadSide({ option_type: 'CE' }), 1);
assert.strictEqual(L.leadSide({ option_type: 'PE' }), -1);
assert.strictEqual(L.leadSide({ signal: 'BUY CALL' }), 1);
assert.strictEqual(L.leadSide({ signal: 'BUY PUT' }), -1);
assert.strictEqual(L.leadSide({}), null);

// ── snapshotAtOrBefore
const rows = [{ ms: 0 }, { ms: 300000 }, { ms: 600000 }];
assert.strictEqual(L.snapshotAtOrBefore(rows, 650000, 120000), 2);
assert.strictEqual(L.snapshotAtOrBefore(rows, 900000, 120000), -1);      // too old
assert.strictEqual(L.snapshotAtOrBefore(rows, -5, 120000), -1);          // nothing before
assert.strictEqual(L.snapshotAtOrBefore([], 5, 120000), -1);

// ── hourBefore: straight line -> efficiency 1, aligned move sign follows the side; zig-zag -> low efficiency
const mk = (vals) => vals.map((v, i) => ({ ms: i * 300000, nifty: v }));
const up = mk([100, 101, 102, 103, 104, 105, 106]);
let h = L.hourBefore(up, 6, 1);
assert.strictEqual(h.efficiency, 1); assert.strictEqual(h.alignedMove, 6); assert.strictEqual(h.range, 6);
h = L.hourBefore(up, 6, -1);
assert.strictEqual(h.alignedMove, -6);
const chop = mk([100, 103, 100, 103, 100, 103, 100]);
h = L.hourBefore(chop, 6, 1);
assert.strictEqual(h.efficiency, 0); assert.strictEqual(h.range, 3);
assert.strictEqual(L.hourBefore(mk([100, 101]), 1, 1), null);            // not enough history

// ── full study: trending day (high ADX, one-way) wins, choppy day (low ADX, zig-zag) loses
const T = (day, hh, mm) => new Date(Date.UTC(2026, 9, day, hh - 5, mm - 30));   // IST -> UTC
const snaps = [];
const addDay = (day, adx1h, adx15, pathFn) => {
    for (let k = 0; k < 40; k++) {                                  // 09:15 .. ~12:30 every 5 min
        const t = new Date(T(day, 9, 15).getTime() + k * 300000);
        snaps.push({ ts: t, nifty: pathFn(k), rsi: 55, vix: 14, mtf_5m_adx: 30, mtf_15m_adx: adx15, mtf_1h_adx: adx1h, health_total: 60, trend_prob: 50, range_prob: 40 });
    }
};
addDay(8, 35, 38, k => 22000 + k * 5);                              // one-way up
addDay(6, 15, 20, k => 22000 + (k % 2 ? 6 : 0));                    // chop
const leads = [
    { id: 1, ts: T(8, 11, 0), option_type: 'CE', entry: 100, exit_premium: 130, max_gain_pct: 35, lead_quality: 'Strong Confluence' },
    { id: 2, ts: T(8, 11, 30), option_type: 'CE', entry: 100, exit_premium: 120, max_gain_pct: 25, lead_quality: 'Strong Confluence' },
    { id: 3, ts: T(6, 11, 0), option_type: 'CE', entry: 100, sl_hit: true, sl: 75, max_gain_pct: 3, lead_quality: 'Strong Confluence' },
    { id: 4, ts: T(6, 11, 30), option_type: 'CE', entry: 100, sl_hit: true, sl: 75, max_gain_pct: 5, lead_quality: 'Strong Confluence' },
    { id: 5, ts: T(7, 11, 0), option_type: 'PE', entry: 100, exit_premium: 90, max_gain_pct: 2, lead_quality: 'Moderate' },   // no snapshots that day
    { id: 6, ts: T(8, 11, 0), option_type: 'CE', entry: 100 },                                                                // unresolved -> skipped
];
const res = L.computeLeadRegimeStudy(leads, snaps, { minN: 2 });
assert.strictEqual(res.leads, 5); assert.strictEqual(res.matchedToSnapshot, 4); assert.strictEqual(res.unmatched, 1);
assert.strictEqual(res.positive, 2); assert.strictEqual(res.notPositive, 3);
const d8 = res.days.find(d => d.day === '2026-10-08'), d6 = res.days.find(d => d.day === '2026-10-06');
assert.strictEqual(d8.avgReturnPct, 25); assert.strictEqual(d8.slHits, 0); assert.strictEqual(d8.avgAdx1h, 35); assert.strictEqual(d8.avgEfficiency, 1);
assert.strictEqual(d6.avgReturnPct, -25); assert.strictEqual(d6.slHits, 2); assert.strictEqual(d6.avgAdx1h, 15);
const adx1h = res.byFeature.find(f => f.feature === 'adx1h');
assert.strictEqual(adx1h.avgWhenPositive, 35); assert.strictEqual(adx1h.avgWhenNotPositive, 15);
assert.strictEqual(adx1h.buckets.find(b => b.label === '1h ADX < 20').avgReturnPct, -25);
assert.strictEqual(adx1h.buckets.find(b => b.label === '1h ADX ≥ 30').winPct, 100);
const eff = res.byFeature.find(f => f.feature === 'efficiency');
assert.strictEqual(eff.buckets.find(b => b.label.startsWith('last hour one-way')).n, 2);
assert.strictEqual(eff.buckets.find(b => b.label.startsWith('last hour choppy')).n, 2);
// the CE leads on the up day are WITH the last hour's move
const al = res.byFeature.find(f => f.feature === 'alignedMove');
assert.strictEqual(al.buckets.find(b => b.label === 'lead WITH last hour move').n >= 2, true);
assert.ok(res.note.length > 20);

// quality filter
assert.strictEqual(L.computeLeadRegimeStudy(leads, snaps, { qualityOnly: 'Strong Confluence' }).leads, 4);

// text output renders and lists every lead
const txt = L.formatLeadRegimeText(res);
assert.ok(txt.includes('BY DAY') && txt.includes('BY FEATURE') && txt.includes('(no snapshot)'));

// empty / bad input never throws
assert.strictEqual(L.computeLeadRegimeStudy([], []).leads, 0);
assert.strictEqual(L.computeLeadRegimeStudy(null, null).leads, 0);
assert.doesNotThrow(() => L.formatLeadRegimeText(L.computeLeadRegimeStudy(null, null)));

console.log('mtfLeadRegime tests passed');