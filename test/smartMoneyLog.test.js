'use strict';
const assert = require('assert');
const { buildRow, summarize } = require('../src/utils/smartMoneyLog');
// the 23 Oct screen: FII +888, DII +3235, PCR 0.76 -> +2 BULLISH
const state = { nifty: 22600, pcr: 0.762, fii: { net: 888, date: '23-Oct-2026', updatedAt: '2026-10-23T17:47:00.000Z' }, dii: { net: 3235 },
    smartMoney: { bias: 'BULLISH', score: 2, components: [
        { label: 'OI Buildup', value: 'Awaiting data', pts: 0, bull: null }, { label: 'FII Flow', value: 'Net Buy ₹888Cr', pts: 2, bull: true },
        { label: 'DII Flow', value: 'Net Buy ₹3235Cr', pts: 1, bull: true }, { label: 'PCR Level', value: '0.76 — Mildly Bearish', pts: -1, bull: false },
        { label: 'ATM Flow', value: 'CE/PE=0.87 — Balanced', pts: 0, bull: null } ] } };
const r = buildRow(state);
assert.strictEqual(r.bias, 'BULLISH'); assert.strictEqual(r.score, 2);
assert.strictEqual(r.fii_pts + r.dii_pts + r.pcr_pts + r.oi_pts + r.atm_pts, r.score);       // the parts add up to the total
assert.strictEqual(r.fii_net, 888); assert.strictEqual(r.dii_net, 3235); assert.strictEqual(r.pcr, 0.76); assert.strictEqual(r.atm_ratio, 0.87);
assert.strictEqual(r.fii_dii_date, '23-Oct-2026'); assert.strictEqual(r.oi_label, 'Awaiting data'); assert.strictEqual(r.nifty, 22600);
// missing / partial input never throws
assert.strictEqual(buildRow(null), null); assert.strictEqual(buildRow({}), null); assert.strictEqual(buildRow({ smartMoney: { bias: 'NEUTRAL', components: [] } }).score, null);
const p = buildRow({ smartMoney: { bias: 'NEUTRAL', score: 0, components: [{ label: 'FII Flow', value: 'x', pts: 'abc' }] } }); assert.strictEqual(p.fii_pts, null); assert.strictEqual(p.fii_net, null);
// summary: one IST day, bias flips once, static FII/DII date
const rows = [
    { ts: '2026-10-23T04:00:00Z', bias: 'BEARISH', score: -2, fii_dii_date: '22-Oct-2026' }, { ts: '2026-10-23T05:00:00Z', bias: 'BEARISH', score: -2, fii_dii_date: '22-Oct-2026' },
    { ts: '2026-10-23T06:00:00Z', bias: 'NEUTRAL', score: 0, fii_dii_date: '22-Oct-2026' } ];
const s = summarize(rows); assert.strictEqual(s.length, 1);
assert.strictEqual(s[0].changes, 1); assert.strictEqual(s[0].firstBias, 'BEARISH'); assert.strictEqual(s[0].lastBias, 'NEUTRAL'); assert.strictEqual(s[0].scoreMin, -2); assert.strictEqual(s[0].scoreMax, 0);
assert.deepStrictEqual(s[0].fiiDiiDates, ['22-Oct-2026']);
assert.deepStrictEqual(summarize(null), []);
console.log('smartMoneyLog tests OK');