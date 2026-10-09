'use strict';
const assert = require('assert');
const L = require('../src/utils/mtfVoteStudy');

// ── normVote
assert.strictEqual(L.normVote('BULLISH'), 1); assert.strictEqual(L.normVote('BEAR'), -1);
assert.strictEqual(L.normVote('NEUTRAL'), null); assert.strictEqual(L.normVote('INSUFFICIENT'), null); assert.strictEqual(L.normVote(null), null); assert.strictEqual(L.normVote(1), 1);

// ── headline / rel
assert.strictEqual(L.headline('none', 'none'), '5m only'); assert.strictEqual(L.headline('against', 'agree'), '5m only');
assert.strictEqual(L.headline('agree', 'against'), '5m + 15m (1h not agreeing)'); assert.strictEqual(L.headline('agree', 'none'), '5m + 15m (1h not agreeing)');
assert.strictEqual(L.headline('agree', 'agree'), '5m + 15m + 1h');
assert.strictEqual(L.rel(1, 1), 'agree'); assert.strictEqual(L.rel(-1, 1), 'against'); assert.strictEqual(L.rel(null, 1), 'none');

// ── findEpisodes: streak of identical votes = one episode; a change or a time gap starts a new one; no 5m vote -> no episode
const T = m => ({ ts: new Date(Date.UTC(2026, 9, 9, 4, 0) + m * 60000) });
const rows = [
    { ...T(0),  price: 100, v5: 1, v15: null, v1h: null },
    { ...T(5),  price: 101, v5: 1, v15: null, v1h: null },   // same streak
    { ...T(10), price: 102, v5: 1, v15: 1,    v1h: null },   // change -> new episode
    { ...T(15), price: 103, v5: null, v15: 1, v1h: null },   // no 5m vote -> none
    { ...T(20), price: 104, v5: 1, v15: 1,    v1h: 1 },      // new episode
    { ...T(60), price: 110, v5: 1, v15: 1,    v1h: 1 },      // same votes but 40 min gap -> new episode
];
const norm = rows.map(r => ({ ms: r.ts.getTime(), v5: r.v5, v15: r.v15, v1h: r.v1h }));
assert.deepStrictEqual(L.findEpisodes(norm, 15), [0, 2, 4, 5]);

// ── computeVoteStudy: early (5m only) episodes drift against, all-three episodes keep going; PUT side handled
const rs = [];
let t = 0;
const add = (price, v5, v15, v1h) => { rs.push({ ts: new Date(Date.UTC(2026, 9, 9, 4, 0) + t * 60000), price, v5, v15, v1h }); t += 5; };
// 12 rows of 5m-only bull at 100 that then fall to 98 an hour later
add(100, 1, null, null); for (let i = 0; i < 12; i++) add(100 - i * 0.2, 1, null, null);
// votes flip to all-three-bull at 99.8 (later rows rise)
add(99, 1, 1, 1); for (let i = 1; i <= 12; i++) add(99 + i * 0.5, 1, 1, 1);
const st = L.computeVoteStudy(rs, { minN: 1 });
assert.strictEqual(st.episodes, 2);
const only5 = st.headline.find(h => h.group === '5m only'), all3 = st.headline.find(h => h.group === '5m + 15m + 1h');
assert.strictEqual(only5.n, 1); assert.strictEqual(all3.n, 1);
assert.ok(only5.horizons[30].avgPct < 0, '5m-only episode fell');
assert.ok(all3.horizons[30].avgPct > 0, 'all-three episode rose');
assert.strictEqual(all3.horizons[60].n, 1);
assert.strictEqual(st.coverage.with1h, 13); assert.strictEqual(st.coverage.with15m, 13);

// PUT side: price falling after a bear 5m vote counts as a positive result
const p = [
    { ts: T(0).ts,  price: 100, v5: -1, v15: -1, v1h: null },
    { ts: T(30).ts, price: 99,  v5: -1, v15: -1, v1h: null },
    { ts: T(35).ts, price: 99,  v5: -1, v15: -1, v1h: null },
];
const sp = L.computeVoteStudy(p, { minN: 1, horizons: [30] });
assert.strictEqual(sp.headline[0].group, '5m + 15m (1h not agreeing)');
assert.strictEqual(sp.headline[0].horizons[30].avgPts, 1); assert.strictEqual(sp.headline[0].horizons[30].avgPct, 1);
assert.strictEqual(sp.headline[0].horizons[30].heldPct, 100);

// forward price missing (no row within tolerance) -> horizon n=0, no crash; empty input does not throw
assert.strictEqual(L.computeVoteStudy([{ ts: T(0).ts, price: 100, v5: 1, v15: null, v1h: null }], { minN: 1 }).headline[0].horizons[15].n, 0);
assert.strictEqual(L.computeVoteStudy([], {}).episodes, 0);
assert.strictEqual(L.computeVoteStudy(null, {}).episodes, 0);
// bad prices dropped
assert.strictEqual(L.computeVoteStudy([{ ts: T(0).ts, price: 0, v5: 1 }, { ts: T(5).ts, price: 'x', v5: 1 }], {}).coverage.rows, 0);

console.log('mtfVoteStudy tests passed');