'use strict';
const assert = require('assert');
const { declusterLeads } = require('../src/utils/leadDecluster');
const ee = require('../src/utils/entryExitQuality');
const rg = require('../src/utils/mtfLeadRegime');

const T = m => new Date(Date.UTC(2026, 9, 9, 4, 0) + m * 60000);
const get = x => x.ms, side = x => x.side;

// first lead kept, same-side leads inside the gap skipped, gap measured from the last KEPT lead
let items = [{ ms: 0, side: 'P' }, { ms: 10 * 60000, side: 'P' }, { ms: 59 * 60000, side: 'P' }, { ms: 60 * 60000, side: 'P' }, { ms: 61 * 60000, side: 'P' }];
assert.deepStrictEqual(declusterLeads(items, 60, get, side).map(x => x.ms / 60000), [0, 60]);
// other side is independent
items = [{ ms: 0, side: 'P' }, { ms: 5 * 60000, side: 'C' }, { ms: 6 * 60000, side: 'P' }, { ms: 7 * 60000, side: 'C' }];
assert.deepStrictEqual(declusterLeads(items, 60, get, side).map(x => x.side + x.ms / 60000), ['P0', 'C5']);
// input order does not matter, original order of kept items is preserved
items = [{ ms: 30 * 60000, side: 'P' }, { ms: 0, side: 'P' }];
assert.deepStrictEqual(declusterLeads(items, 60, get, side).map(x => x.ms / 60000), [0]);
// off / empty / bad input
assert.strictEqual(declusterLeads(items, 0, get, side).length, 2);
assert.strictEqual(declusterLeads(items, undefined, get, side).length, 2);
assert.deepStrictEqual(declusterLeads(null, 60, get, side), []);
// items without a time are always kept
assert.strictEqual(declusterLeads([{ ms: NaN, side: 'P' }, { ms: NaN, side: 'P' }], 60, get, side).length, 2);

// ── tracker scorecard: raw vs one-per-60-min
const lead = (min, sig, ret) => ({ id: min, ts: T(min), signal: sig, option_type: sig === 'BUY CALL' ? 'CE' : 'PE', entry: 100, exit_premium: 100 + ret, max_gain_pct: 10, lead_quality: 'Strong Confluence', target_hit: false, sl_hit: false });
const trades = [lead(0, 'BUY PUT', 50), lead(2, 'BUY PUT', 50), lead(4, 'BUY PUT', 50), lead(6, 'BUY PUT', 50), lead(120, 'BUY CALL', -20), lead(125, 'BUY CALL', -20)];
const rawT = ee.computeTrackerScorecard(trades, { minN: 1 });
assert.strictEqual(rawT.all.n, 6); assert.strictEqual(rawT.rawLeads, 6); assert.strictEqual(rawT.declusterMin, 0);
assert.strictEqual(rawT.all.avgReturnPct, 26.7);
const dT = ee.computeTrackerScorecard(trades, { minN: 1, declusterMin: 60 });
assert.strictEqual(dT.rawLeads, 6); assert.strictEqual(dT.usedLeads, 2); assert.strictEqual(dT.all.n, 2); assert.strictEqual(dT.declusterMin, 60);
assert.strictEqual(dT.all.avgReturnPct, 15);
assert.strictEqual(dT.recent.length, 2);
assert.strictEqual(dT.byLeadQuality[0].n, 2);
// text mentions the mode
const txt = ee.formatScorecardText({ gridUsed: { name: 'X' }, scorecard: { outcomesUsed: 0, outcomesBeforeDecluster: 0, all: { n: 0, entry: {}, exit: {}, diagnosis: '' }, sources: [] }, tracker: dT });
assert.ok(txt.includes('one lead per 60 min per side') && txt.includes('6 raw leads'));

// ── regime study honours it too
const snaps = [];
for (let k = 0; k < 60; k++) snaps.push({ ts: T(k * 5 - 60), nifty: 22000 + k, mtf_5m_adx: 30, mtf_15m_adx: 30, mtf_1h_adx: 30 });
const rr = rg.computeLeadRegimeStudy(trades, snaps, { minN: 1 });
assert.strictEqual(rr.leads, 6); assert.strictEqual(rr.rawLeads, 6); assert.strictEqual(rr.declusterMin, 0);
const rd = rg.computeLeadRegimeStudy(trades, snaps, { minN: 1, declusterMin: 60 });
assert.strictEqual(rd.leads, 2); assert.strictEqual(rd.rawLeads, 6); assert.strictEqual(rd.all.avgReturnPct, 15);
assert.ok(rg.formatLeadRegimeText(rd).includes('6 raw leads -> 2 used'));
assert.ok(rg.formatLeadRegimeText(rr).includes('not declustered'));

console.log('leadDecluster tests passed');