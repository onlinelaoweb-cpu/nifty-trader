'use strict';
const assert = require('assert');
const { createJumbaa, evaluateJumbaa } = require('../src/utils/jumbaaSignal');
const IST = 19800000;
const at = (h, m, s = 0) => Date.UTC(2026, 9, 23, h, m, s) - IST;   // IST clock time on 23 Oct 2026
const lv = [{ price: 22570, type: 'ML', label: 'Monthly Low' }, { price: 22600, type: 'X', label: 'X' }];
const feed = (j, list, extra) => { let out = null; for (const [h, m, p] of list) { const r = j.step(Object.assign({ ms: at(h, m), price: p, levels: lv, smartBias: 'BULLISH', adx1h: 30 }, extra)); if (r && r.fired) out = r; } return out; };

// up-cross: bar 10:00-10:14 closes 22550, bar 10:15-10:29 closes 22590 (crosses 22570), next bar tick makes it count
let j = createJumbaa();
let s = feed(j, [[10, 1, 22540], [10, 14, 22550], [10, 16, 22560], [10, 29, 22590], [10, 31, 22592]]);
assert(s && s.direction === 'BULLISH' && s.side === 'CALL' && s.level === 22570 && s.levelsCrossed === 1);
// wrong smart-money bias blocks it
j = createJumbaa(); s = feed(j, [[10, 1, 22540], [10, 14, 22550], [10, 16, 22560], [10, 29, 22590], [10, 31, 22592]], { smartBias: 'BEARISH' });
assert.strictEqual(s, null); assert.strictEqual(j.stats.blockedBias, 1);
// low ADX blocks it
j = createJumbaa(); s = feed(j, [[10, 1, 22540], [10, 14, 22550], [10, 16, 22560], [10, 29, 22590], [10, 31, 22592]], { adx1h: 18 });
assert.strictEqual(s, null); assert.strictEqual(j.stats.blockedAdx, 1);
// down-cross -> PUT with bearish bias
j = createJumbaa(); s = feed(j, [[11, 1, 22620], [11, 14, 22610], [11, 16, 22600], [11, 29, 22580], [11, 31, 22575]], { smartBias: 'STRONGLY_BEARISH' });
assert(s && s.side === 'PUT' && s.level === 22600);
// a wick through the level that closes back on the same side is NOT a cross
j = createJumbaa(); s = feed(j, [[10, 1, 22540], [10, 14, 22550], [10, 16, 22600], [10, 20, 22545], [10, 29, 22555], [10, 31, 22556]]);
assert.strictEqual(s, null);
// outside the 09:30-14:00 window -> blocked
j = createJumbaa(); s = feed(j, [[14, 31, 22540], [14, 44, 22550], [14, 46, 22560], [14, 59, 22590], [15, 1, 22592]]);
assert.strictEqual(s, null); assert.strictEqual(j.stats.blockedWindow, 1);
// 30-min same-direction cooldown
j = createJumbaa({ cooldownMin: 60 }); feed(j, [[10, 1, 22540], [10, 14, 22550], [10, 16, 22560], [10, 29, 22590], [10, 31, 22592]]);
s = feed(j, [[10, 44, 22560], [10, 46, 22565], [10, 59, 22580], [11, 1, 22583]], { levels: [{ price: 22570 }] });
assert.strictEqual(j.stats.fired, 1); assert.strictEqual(j.stats.blockedCooldown, 1); assert.strictEqual(s, null);
// bad input never throws
assert.strictEqual(createJumbaa().step(null), null); assert.strictEqual(createJumbaa().step({ ms: NaN, price: 1 }), null);

// evaluation: 3 signals only -> TOO FEW; 30 good signals -> passes; mixed halves -> no evidence
const row = (i, d, mv) => ({ ts: new Date(at(10, 0) + i * 3600000).toISOString(), direction: d, nifty: 22500, nifty_15: 22500 + mv / 2, nifty_30: 22500 + mv * 0.7, nifty_60: d === 'BULLISH' ? 22500 + mv : 22500 - mv });
assert(/TOO FEW/.test(evaluateJumbaa([row(0, 'BULLISH', 20), row(1, 'BEARISH', 20), row(2, 'BULLISH', 20)]).verdict));
const good = Array.from({ length: 30 }, (_, i) => row(i, i % 2 ? 'BEARISH' : 'BULLISH', 20));
const eg = evaluateJumbaa(good); assert(/PASSES/.test(eg.verdict)); assert.strictEqual(eg.all.avg60, 20); assert.strictEqual(eg.puts.avg60, 20);
const bad = Array.from({ length: 30 }, (_, i) => row(i, 'BULLISH', i < 15 ? 60 : -30));
assert(/NO EVIDENCE/.test(evaluateJumbaa(bad).verdict));
assert.deepStrictEqual(evaluateJumbaa(null).all.n, 0);
// a blocked cross is still returned, with every reason it was blocked
j = createJumbaa(); let last = null;
for (const [h, m, p] of [[10, 1, 22540], [10, 14, 22550], [10, 16, 22560], [10, 29, 22590], [10, 31, 22592]]) { const r = j.step({ ms: at(h, m), price: p, levels: lv, smartBias: 'BEARISH', adx1h: 18 }); if (r) last = r; }
assert(last && last.fired === false && last.blockedBy.includes('bias') && last.blockedBy.includes('adx') && last.adx1h === 18);
console.log('jumbaaSignal tests OK');

// ── Jumbaa-B (live cross) ──
{
    const { createJumbaaLive, evaluateLive } = require('../src/utils/jumbaaSignal');
    const L = [{ price: 22570, type: 'ML', label: 'Monthly Low' }];
    const run = (j, list, extra) => { const all = []; for (const [h, m, s, p] of list) all.push(...j.step(Object.assign({ ms: at(h, m, s), price: p, levels: L, smartBias: 'BULLISH', adx1h: 30 }, extra))); return all; };
    // below, then clears the level by > 3 pts -> one live CALL cross, no candle close needed
    let j = createJumbaaLive(); let r = run(j, [[10, 0, 0, 22560], [10, 0, 10, 22565], [10, 0, 20, 22575]]);
    assert.strictEqual(r.length, 1); assert(r[0].fired && r[0].side === 'CALL' && r[0].level === 22570 && r[0].price === 22575);
    // a wick that stays inside the 3-pt buffer is NOT a cross
    j = createJumbaaLive(); r = run(j, [[10, 0, 0, 22560], [10, 0, 10, 22572], [10, 0, 20, 22562]]);
    assert.strictEqual(r.length, 0);
    // whipsaw inside 5 minutes is suppressed (counted, not logged)
    j = createJumbaaLive(); r = run(j, [[10, 0, 0, 22560], [10, 0, 10, 22575], [10, 0, 20, 22562], [10, 0, 30, 22576]]);
    assert.strictEqual(r.length, 2); assert.strictEqual(r.filter(x => x.side === 'CALL').length, 1); assert.strictEqual(j.stats.suppressed, 1);   // CALL, PUT logged; the 2nd CALL inside 5 min is suppressed
    // wrong bias / low ADX -> logged as blocked with reasons
    j = createJumbaaLive(); r = run(j, [[10, 0, 0, 22560], [10, 0, 10, 22575]], { smartBias: 'BEARISH', adx1h: 18 });
    assert(r.length === 1 && r[0].fired === false && r[0].blockedBy.includes('bias') && r[0].blockedBy.includes('adx'));
    // a 4-minute hole in the ticks resets the sides: no fake cross across the gap
    j = createJumbaaLive(); r = run(j, [[10, 0, 0, 22560], [10, 4, 0, 22580]]); assert.strictEqual(r.length, 0);
    // a new day starts clean
    j = createJumbaaLive(); run(j, [[10, 0, 0, 22560]]); r = j.step({ ms: at(10, 0, 20) + 86400000, price: 22580, levels: L, smartBias: 'BULLISH', adx1h: 30 }); assert.strictEqual(r.length, 0);
    // levels far from price are ignored (nearPts 150)
    j = createJumbaaLive(); r = []; for (const [s, p] of [[0, 22300], [10, 22310]]) r.push(...j.step({ ms: at(10, 0, s), price: p, levels: L, smartBias: 'BULLISH', adx1h: 30 })); assert.strictEqual(r.length, 0);
    // bad input never throws
    assert.deepStrictEqual(createJumbaaLive().step(null), []); assert.deepStrictEqual(createJumbaaLive().step({ ms: NaN, price: 1 }), []);
    // evaluation
    const e = (i, mv) => ({ ts: new Date(at(10, 0) + i * 3600000).toISOString(), direction: i % 2 ? 'BEARISH' : 'BULLISH', nifty: 22500, px_1m: null, px_5m: null, px_15m: 22500 + (i % 2 ? -mv : mv), px_30m: 22500 + (i % 2 ? -mv : mv) });
    assert(/TOO FEW/.test(evaluateLive([e(0, 20), e(1, 20)]).verdict));
    const ok = evaluateLive(Array.from({ length: 30 }, (_, i) => e(i, 15))); assert(/PASSES/.test(ok.verdict)); assert.strictEqual(ok.all.avg15, 15);
    assert(/NO EVIDENCE/.test(evaluateLive(Array.from({ length: 30 }, (_, i) => e(i, i < 15 ? 50 : -30))).verdict));
    assert.strictEqual(evaluateLive(null).all.n, 0);
    console.log('jumbaaLive tests OK');
}

// ── breadth split ──
{
    const { splitByBreadth } = require('../src/utils/jumbaaSignal');
    const s = splitByBreadth([{ direction: 'BEARISH', breadth_sig: 'BEARISH' }, { direction: 'BULLISH', breadth_sig: 'BULLISH' }, { direction: 'BULLISH', breadth_sig: 'BEARISH' },
        { direction: 'BEARISH', breadth_sig: 'BULLISH' }, { direction: 'BULLISH', breadth_sig: 'NEUTRAL' }, { direction: 'BULLISH', breadth_sig: null }]);
    assert.strictEqual(s.agree.length, 2); assert.strictEqual(s.against.length, 2); assert.strictEqual(s.neutral.length, 2);
    assert.deepStrictEqual(splitByBreadth(null), { agree: [], against: [], neutral: [] });
    console.log('jumbaaBreadth tests OK');
}