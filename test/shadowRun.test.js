const assert = require('assert');
const { runIsolated, shouldRunShadow, summarizeShadow, snapshot, restore } = require('../src/utils/shadowRun');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok -', name); };

t('restores added keys, changed keys and removed keys on the top level', () => {
    const s = { a: 1, b: 'x', c: null };
    const r = runIsolated([s], () => { s.a = 99; delete s.b; s.z = 5; return 'done'; });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.value, 'done');
    assert.deepStrictEqual(s, { a: 1, b: 'x', c: null });
});
t('restores one level of nesting (existing nested object mutated in place)', () => {
    const pot = { bosChoch: 'old', keep: 1 };
    const s = { physicsOfTrading: pot, other: 2 };
    runIsolated([s], () => { s.physicsOfTrading.bosChoch = 'new'; s.physicsOfTrading.extra = 1; delete s.physicsOfTrading.keep; });
    assert.strictEqual(s.physicsOfTrading, pot);
    assert.deepStrictEqual(pot, { bosChoch: 'old', keep: 1 });
});
t('restores a replaced nested object back to the SAME reference', () => {
    const q = { passed: true }; const s = { qualityGate: q };
    runIsolated([s], () => { s.qualityGate = { passed: false }; });
    assert.strictEqual(s.qualityGate, q); assert.strictEqual(q.passed, true);
});
t('restores several targets and still restores when fn throws', () => {
    const a = { x: 1 }, b = { y: { k: 1 } };
    const r = runIsolated([a, b], () => { a.x = 2; b.y.k = 2; b.new = 1; throw new Error('boom'); });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'boom');
    assert.deepStrictEqual(a, { x: 1 }); assert.deepStrictEqual(b, { y: { k: 1 } });
});
t('rejects an async fn (returns error, state restored)', () => {
    const a = { x: 1 };
    const r = runIsolated([a], () => { a.x = 2; return Promise.resolve(1); });
    assert.strictEqual(r.ok, false); assert.strictEqual(a.x, 1);
});
t('arrays and Dates are left as references (documented limit)', () => {
    const arr = [1, 2]; const d = new Date(0); const s = { arr, d };
    runIsolated([s], () => { s.arr = [9]; s.d = new Date(5); });
    assert.strictEqual(s.arr, arr); assert.strictEqual(s.d, d);
});
t('shouldRunShadow: only 09:15-09:59 IST, enabled, trading day, throttled', () => {
    const base = { enabled: true, isTradingDay: true, nowMs: 1_000_000, lastRunMs: 0, minGapMs: 60000 };
    assert.strictEqual(shouldRunShadow({ ...base, nowIstMinutes: 555 }), true);
    assert.strictEqual(shouldRunShadow({ ...base, nowIstMinutes: 599 }), true);
    assert.strictEqual(shouldRunShadow({ ...base, nowIstMinutes: 554 }), false);
    assert.strictEqual(shouldRunShadow({ ...base, nowIstMinutes: 600 }), false);
    assert.strictEqual(shouldRunShadow({ ...base, nowIstMinutes: 570, enabled: false }), false);
    assert.strictEqual(shouldRunShadow({ ...base, nowIstMinutes: 570, isTradingDay: false }), false);
    assert.strictEqual(shouldRunShadow({ ...base, nowIstMinutes: 570, lastRunMs: 1_000_000 - 30000 }), false);
    assert.strictEqual(shouldRunShadow({ ...base, nowIstMinutes: 570, lastRunMs: 1_000_000 - 60000 }), true);
    assert.strictEqual(shouldRunShadow({ ...base, nowIstMinutes: NaN }), false);
});
t('summarizeShadow: fires only for a non-WAIT signal with confidence; bad input is safe', () => {
    const s = summarizeShadow({ signal: 'BUY CALL', confidence: 72.4, reasons: ['a', 'b'] }, { voteTally: { bull: 9, bear: 3, bullPct: 75 }, qualityGate: { passed: false, mtfAligned: true, adxTrend: false } });
    assert.strictEqual(s.wouldFire, true); assert.strictEqual(s.confidence, 72); assert.strictEqual(s.bullPct, 75);
    assert.strictEqual(s.gate.passed, false); assert.strictEqual(s.gate.adxTrend, false);
    const w = summarizeShadow({ signal: 'WAIT', confidence: 30 }, null);
    assert.strictEqual(w.wouldFire, false); assert.strictEqual(w.bull, null); assert.strictEqual(w.gate.passed, null);
    const bad = summarizeShadow(null, undefined);
    assert.strictEqual(bad.signal, 'WAIT'); assert.strictEqual(bad.wouldFire, false); assert.deepStrictEqual(bad.reasons, []);
});
console.log(`[shadowRun] ${n} tests passed`);