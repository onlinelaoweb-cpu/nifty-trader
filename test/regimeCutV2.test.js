const assert = require('assert');
const { evaluateRegimeCutV2, CONFIRMATION_START_MS } = require('../src/utils/regimeCutV2');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok -', name); };
const D = 24 * 3600 * 1000, T0 = CONFIRMATION_START_MS + 9 * 3600 * 1000;           // 17 Oct 09:00 IST
const snapsFor = (arr) => arr.map(([ms, adx]) => ({ ts: new Date(ms).toISOString(), mtf_1h_adx: adx }));
// builds k leads alternating sides, 2h apart (never declustered), starting day d
function mk(startMs, k, ret, adx, idStart) {
    const items = [], snaps = [];
    for (let i = 0; i < k; i++) {
        const ms = startMs + i * 2 * 3600 * 1000;
        items.push({ id: idStart + i, ts: new Date(ms).toISOString(), side: i % 2 ? 'BULLISH' : 'BEARISH', ret });
        snaps.push([ms - 60000, adx]);
    }
    return { items, snaps };
}

t('before 17 Oct leads are excluded from the confirmation test (and shown as DESCRIPTIVE with since=all)', () => {
    const a = mk(CONFIRMATION_START_MS - 5 * D, 30, 10, 30, 1);
    const r = evaluateRegimeCutV2(a.items, snapsFor(a.snaps));
    assert.strictEqual(r.counts.inScope, 0); assert.ok(/NO EVIDENCE YET/.test(r.verdict));
    const d = evaluateRegimeCutV2(a.items, snapsFor(a.snaps), { since: 'all' });
    assert.strictEqual(d.counts.inScope, 30); assert.ok(/DESCRIPTIVE/.test(d.verdict));
});
t('costs are subtracted (3 pp) and ADX 25 is trend, 24.9 is range', () => {
    const items = [{ id: 1, ts: new Date(T0).toISOString(), side: 'BULLISH', ret: 10 }, { id: 2, ts: new Date(T0 + 3 * 3600000).toISOString(), side: 'BULLISH', ret: 10 }];
    const r = evaluateRegimeCutV2(items, snapsFor([[T0 - 1000, 25], [T0 + 3 * 3600000 - 1000, 24.9]]));
    assert.strictEqual(r.trend.n, 1); assert.strictEqual(r.range.n, 1); assert.strictEqual(r.trend.avgNet, 7); assert.strictEqual(r.range.avgNet, 7);
});
t('too few leads per bucket -> NO EVIDENCE YET even if the numbers look great', () => {
    const a = mk(T0, 10, 40, 30, 1), b = mk(T0 + 30 * 3600000, 5, -20, 15, 100);
    const r = evaluateRegimeCutV2(a.items.concat(b.items), snapsFor(a.snaps.concat(b.snaps)));
    assert.ok(/NO EVIDENCE YET/.test(r.verdict)); assert.strictEqual(r.range.n, 5);
});
t('PASS needs 20+/bucket, margin >= 5 pp and the same direction in both halves', () => {
    // interleave trend and range leads over time so both halves contain both buckets
    const items = [], snaps = [];
    for (let i = 0; i < 80; i++) {
        const ms = T0 + i * 2 * 3600000, trend = i % 2 === 0;
        items.push({ id: i, ts: new Date(ms).toISOString(), side: i % 4 < 2 ? 'BULLISH' : 'BEARISH', ret: trend ? 15 : 2 });
        snaps.push([ms - 1000, trend ? 30 : 15]);
    }
    const r = evaluateRegimeCutV2(items, snapsFor(snaps));
    assert.ok(r.trend.n >= 20 && r.range.n >= 20, JSON.stringify(r.counts));
    assert.strictEqual(r.diffTrendMinusRangePp, 13); assert.strictEqual(r.halves.agree, true); assert.ok(/^PASS/.test(r.verdict));
});
t('margin met overall but one half reversed -> NO EVIDENCE', () => {
    const items = [], snaps = [];
    for (let i = 0; i < 80; i++) {
        const ms = T0 + i * 2 * 3600000, trend = i % 2 === 0, firstHalf = i < 40;
        const ret = firstHalf ? (trend ? 30 : 0) : (trend ? 0 : 6);
        items.push({ id: i, ts: new Date(ms).toISOString(), side: i % 4 < 2 ? 'BULLISH' : 'BEARISH', ret });
        snaps.push([ms - 1000, trend ? 30 : 15]);
    }
    const r = evaluateRegimeCutV2(items, snapsFor(snaps));
    assert.ok(r.diffTrendMinusRangePp >= 5, String(r.diffTrendMinusRangePp)); assert.strictEqual(r.halves.agree, false); assert.ok(/^NO EVIDENCE - /.test(r.verdict));
});
t('same-side leads inside 60 min are declustered; unresolved and snapshot-less leads are not counted as matched', () => {
    const items = [{ id: 1, ts: new Date(T0).toISOString(), side: 'BULLISH', ret: 5 }, { id: 2, ts: new Date(T0 + 20 * 60000).toISOString(), side: 'BULLISH', ret: 5 },
        { id: 3, ts: new Date(T0 + 3 * 3600000).toISOString(), side: 'BEARISH', ret: null }, { id: 4, ts: new Date(T0 + 5 * 3600000).toISOString(), side: 'BEARISH', ret: 1 }];
    const r = evaluateRegimeCutV2(items, snapsFor([[T0 - 1000, 30]]));
    assert.strictEqual(r.counts.resolved, 3); assert.strictEqual(r.counts.afterDecluster, 2); assert.strictEqual(r.counts.matchedToSnapshot, 1);
});
t('garbage input never throws', () => {
    const r = evaluateRegimeCutV2(null, undefined); assert.strictEqual(r.counts.resolved, 0); assert.ok(/NO EVIDENCE YET/.test(r.verdict));
    evaluateRegimeCutV2([{ id: 1, ts: 'nope', side: 'x', ret: 'abc' }], [{ ts: 'bad' }]);
});
console.log(`[regimeCutV2] ${n} tests passed`);