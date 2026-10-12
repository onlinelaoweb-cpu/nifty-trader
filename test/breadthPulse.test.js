'use strict';
const assert = require('assert');
const BP = require('../public/js/breadth-pulse');

// Today's real close (12 Oct): 2 up / 17 down / 1 unch, weighted bull 9%, banks -0.61%, PCR 0.66 falling, FII -3569 + DII +4743
const sectors = { bankNifty: { changePct: -0.61 }, niftyIT: { changePct: -0.79 }, niftyAuto: { changePct: 0.9 }, niftyMetal: { changePct: -0.41 }, niftyPharma: { changePct: 0.45 },
    niftyFMCG: { changePct: -1.67 }, niftyRealty: { changePct: 0.76 }, niftyMedia: { changePct: 4.6 }, niftyEnergy: { changePct: 0.2 }, niftyInfra: { changePct: -0.87 }, niftyPSUBank: { changePct: -1.18 } };
const day = { breadth: { advances: 2, declines: 17, unchanged: 1, weightedBull: 9 }, global: { sectors },
    pcrHistory: [{ pcr: 0.7 }, { pcr: 0.68 }, { pcr: 0.66 }], pcrSlope: { trend: 'FALLING' }, fii: { net: -3569 }, dii: { net: 4743 } };
const r = BP.compute(day);
const byId = id => r.tiles.find(t => t.id === id);
assert.strictEqual(byId('bp-ad').cls, 'bear');
assert.strictEqual(byId('bp-w').cls, 'bear');
assert.strictEqual(byId('bp-sec').cls, 'neu');          // 5 up / 6 down is not 2/3 either way
assert.strictEqual(byId('bp-bank').cls, 'bear');
assert.strictEqual(byId('bp-pcr').cls, 'bear');
assert.strictEqual(byId('bp-inst').cls, 'bull');        // +1174 Cr combined
assert.strictEqual(r.cls, 'bear'); assert.ok(/kamzor/.test(r.verdict));
assert.strictEqual(r.live, 6); assert.strictEqual(r.bull, 1); assert.strictEqual(r.bear, 4); assert.strictEqual(r.neu, 1);
assert.ok(r.chips.some(c => /FII\+DII net kharid/.test(c.t)), 'disagreement chip when stocks weak but money flow positive');
assert.ok(/17\/20 stocks neeche/.test(r.lines.join('|')));

// strong up day, FII+DII selling -> opposite disagreement chip
const up = BP.compute({ breadth: { advances: 15, declines: 4, unchanged: 1, weightedBull: 80 }, global: { sectors: { bankNifty: { changePct: 1 }, niftyIT: { changePct: 1 }, niftyAuto: { changePct: 1 }, niftyMetal: { changePct: 1 }, niftyPharma: { changePct: 1 }, niftyFMCG: { changePct: 1 }, niftyRealty: { changePct: 1 } } }, fii: { net: -2000 }, dii: { net: 500 } });
assert.strictEqual(up.cls, 'bull'); assert.ok(up.chips.some(c => /FII\+DII net bechna/.test(c.t)));

// narrow move: many stocks up but weight bearish
const narrow = BP.compute({ breadth: { advances: 14, declines: 5, unchanged: 1, weightedBull: 35 } });
assert.ok(narrow.chips.some(c => /Kam stocks upar par bade neeche|Zyada stocks upar/.test(c.t)) || narrow.tiles.find(t => t.id === 'bp-ad').cls === 'bull');
assert.strictEqual(narrow.tiles.find(t => t.id === 'bp-ad').cls, 'bull');
assert.ok(narrow.chips.some(c => /bade neeche/.test(c.t)));

// missing / empty data never throws and shows "collecting"
for (const bad of [undefined, null, {}, { breadth: {} }, { breadth: { advances: 'x' }, global: { sectors: null }, pcrHistory: 'no' }]) {
    const e = BP.compute(bad); assert.strictEqual(e.tiles.length, 6); assert.strictEqual(e.verdict, 'Collecting data…');
}
// string numbers from the API are tolerated
assert.strictEqual(BP.compute({ breadth: { advances: '3', declines: '16', unchanged: '1', weightedBull: '20' } }).tiles[0].cls, 'bear');
// sectors helper
assert.strictEqual(BP.sectorRows(sectors).length, 11);
console.log('breadthPulse tests passed');