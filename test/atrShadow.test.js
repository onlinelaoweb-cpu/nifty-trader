'use strict';
const assert = require('assert');
const A = require('../src/utils/atrShadow');

// reference ATR needs >= 10 readings
assert.strictEqual(A.refAtr([10, 12, 11]), null);
assert.strictEqual(A.refAtr(new Array(10).fill(20)), 20);
assert.strictEqual(A.refAtr([...new Array(100).fill(1), ...new Array(60).fill(30)]), 30);   // only the last 60 count
// factor: clamp + no_ref fallback
assert.deepStrictEqual(A.computeFactor(20, 20), { factor: 1, basis: 'atr' });
assert.strictEqual(A.computeFactor(100, 20).factor, 1.5);
assert.strictEqual(A.computeFactor(1, 20).factor, 0.75);
assert.deepStrictEqual(A.computeFactor(20, null), { factor: 1, basis: 'no_ref' });
assert.deepStrictEqual(A.computeFactor(null, 20), { factor: 1, basis: 'no_ref' });
// grid scaling, rounded to 0.5
const g = { slPct: -15, breakevenAt: 10, halfBookAt: 15, fullExitAt: 25 };
assert.deepStrictEqual(A.scaleGrid(g, 1), { name: 'ATR_SHADOW', slPct: -15, breakevenAt: 10, halfBookAt: 15, fullExitAt: 25 });
assert.deepStrictEqual(A.scaleGrid(g, 1.5), { name: 'ATR_SHADOW', slPct: -22.5, breakevenAt: 15, halfBookAt: 22.5, fullExitAt: 37.5 });
assert.strictEqual(A.scaleGrid(g, 0.75).slPct, -11);

// compareRows verdicts
const mk = (n, base, vari, basis = 'atr') => Array.from({ length: n }, (_, i) => ({ base_pct: base, var_pct: vari, basis, fire_ts: new Date(Date.UTC(2026, 9, 20, 4, i)).toISOString() }));
assert(/NO EVIDENCE YET \(10\/30/.test(A.compareRows(mk(10, -5, 5)).verdict));
assert(/VARIANT BETTER/.test(A.compareRows(mk(40, -2, 3)).verdict));
assert(/VARIANT WORSE/.test(A.compareRows(mk(40, 3, -2)).verdict));
assert(/NO CLEAR DIFFERENCE/.test(A.compareRows(mk(40, 1, 2)).verdict));                  // diff 1pp < 2pp
assert(/NO EVIDENCE YET \(0\/30/.test(A.compareRows(mk(40, -2, 3, 'no_ref')).verdict));  // no_ref rows never count
{   // halves disagree -> not accepted even if overall diff is large
    const rows = [...mk(20, 0, 10), ...mk(20, 10, 0).map((r, i) => ({ ...r, fire_ts: new Date(Date.UTC(2026, 9, 25, 4, i)).toISOString() }))];
    assert(/NO CLEAR DIFFERENCE/.test(A.compareRows(rows).verdict));
}
assert.strictEqual(A.compareRows([{ base_pct: null, var_pct: 1, basis: 'atr', fire_ts: 1 }]).n, 0);

// engine: fake db + fake clock, one trade, variant wider than base so it survives a dip that stops the base
(async () => {
    const q = []; const dbPool = { query: async (sql, p) => { q.push(sql.slice(0, 30)); return { rows: [] }; } };
    let t = Date.UTC(2026, 9, 20, 4, 0), prem = 100;   // Tue 20 Oct 09:30 IST
    const sh = A.createAtrShadow({ dbPool, getStrikePremium: () => prem, now: () => t, env: {} });
    assert.strictEqual(await sh.open({ id: 1, instrument: 'NIFTY', direction: 'BULLISH', entry: 100, grid: {}, atr: 20 }), false);   // not started -> ignored
    await sh.start(); sh.stop(); sh._state.started = true;
    sh._state.atrs = new Array(10).fill(20);
    assert.strictEqual(await sh.open({ id: 1, instrument: 'CRUDE', direction: 'BULLISH', strike: 24000, entry: 100, grid: {}, atr: 20 }), false);   // NIFTY only
    const grid = { slPct: -15, breakevenAt: 10, halfBookAt: 15, fullExitAt: 25 };
    assert.strictEqual(await sh.open({ id: 2, instrument: 'NIFTY', direction: 'BULLISH', strike: 24000, entry: 100, grid, atr: 40 }), true);   // 2x ref -> factor 1.5
    const tr = sh._state.open.get(2);
    assert.strictEqual(tr.coach.slLevelPct, -22.5); assert.strictEqual(tr.coach.fullExitAt, 37.5); assert.strictEqual(tr.trailPts, 15);
    prem = 82; t += 60000; await sh.tick();                       // -18%: a -15% base stop would fire, -22.5% does not
    assert.strictEqual(sh._state.open.size, 1);
    prem = 76; t += 60000; await sh.tick();                       // -24%: variant stop
    assert.strictEqual(sh._state.open.size, 0);
    // path recorded and loop is exception-safe with a throwing quote source
    const sh2 = A.createAtrShadow({ dbPool, getStrikePremium: () => { throw new Error('x'); }, now: () => t, env: {}, log: () => {} });
    await sh2.start(); sh2.stop(); sh2._state.started = true; await sh2.open({ id: 3, instrument: 'NIFTY', direction: 'BEARISH', strike: 24000, entry: 100, grid, atr: 20 });
    await sh2.tick(); assert.strictEqual(sh2._state.open.size, 1);
    assert.strictEqual(A.createAtrShadow({ dbPool, getStrikePremium: () => 1, env: { ATR_SHADOW: 'off' } }).cfg.enabled, false);
    console.log('atrShadow tests passed');
})().catch(e => { console.error(e); process.exit(1); });