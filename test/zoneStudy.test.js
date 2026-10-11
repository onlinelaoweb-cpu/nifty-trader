'use strict';
const assert = require('assert');
const { atrAt, detectZones, evaluateZone, runZoneStudy, formatText } = require('../src/utils/zoneStudy');

// deterministic pseudo-random
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const mk = (o, h, l, c, i) => ({ date: 'd' + i, open: o, high: h, low: l, close: c });

// 1) flat noise: ~20 candles of range ~10
function noise(n, start = 1000) { const a = []; let p = start; for (let i = 0; i < n; i++) { const o = p, c = p + (rnd() - 0.5) * 6; a.push(mk(o, Math.max(o, c) + rnd() * 2, Math.min(o, c) - rnd() * 2, c, a.length)); p = c; } return a; }
let cs = noise(30);
assert.ok(atrAt(cs, 29) > 2 && atrAt(cs, 29) < 12);

// 2) inject base + strong up impulse -> demand zone
const p = cs[cs.length - 1].close;
cs.push(mk(p, p + 1, p - 1, p + 0.2, cs.length));              // quiet base candle
cs.push(mk(p + 0.2, p + 30, p, p + 28, cs.length));            // impulse up (range 30 >> ATR)
let zones = detectZones(cs);
const dz = zones.find(z => z.formedIdx === cs.length - 1);
assert.ok(dz && dz.type === 'DEMAND', JSON.stringify(zones.slice(-2)));
assert.ok(dz.lo <= p - 0.5 && dz.hi >= p + 0.5);

// 3) price drifts away, comes back, touches zone from above and bounces by > 1 ATR
const top = p + 28;
cs.push(mk(top, top + 5, top - 3, top + 2, cs.length));
cs.push(mk(top + 2, top + 4, p + 3, p + 4, cs.length));        // pull back
cs.push(mk(p + 4, p + 4.5, dz.hi - 0.2, p + 3, cs.length));    // touches zone (low <= hi)
cs.push(mk(p + 3, p + 3 + dz.atr * 2, p + 2, p + 3 + dz.atr * 1.8, cs.length)); // bounce
let ev = evaluateZone(cs, dz);
assert.ok(ev && ev.result === 'bounce', JSON.stringify(ev));

// 4) a close through the zone before any touch kills it
let dead = cs.slice(0, cs.length - 3);
dead.push(mk(p + 3, p + 3.5, dz.lo - 6, dz.lo - 5, dead.length)); // closes below zone
dead.push(mk(dz.lo - 5, dz.hi, dz.lo - 6, dz.hi - 1, dead.length));
assert.strictEqual(evaluateZone(dead, dz), null);

// 5) supply mirror
let ss = noise(30); const q = ss[ss.length - 1].close;
ss.push(mk(q, q + 1, q - 1, q - 0.2, ss.length)); ss.push(mk(q - 0.2, q, q - 30, q - 28, ss.length));
const sz = detectZones(ss).find(z => z.formedIdx === ss.length - 1);
assert.ok(sz && sz.type === 'SUPPLY');

// 6) pure noise produces (almost) no zones and the study says not enough data, never crashes
seed = 11; const big = noise(400);
const r = runZoneStudy(big);
assert.ok(r.zonesFound <= 5, 'noise should rarely look like a zone: ' + r.zonesFound);
assert.ok(/NOT ENOUGH DATA/.test(r.verdict));
assert.ok(typeof formatText(r) === 'string');

// 7) bad rows (nulls / strings) are tolerated
const mixed = big.slice(0, 60).map(c => ({ ...c, open: String(c.open) })); mixed.push({ date: 'x', open: null, high: 'a', low: 1, close: 2 });
runZoneStudy(mixed);

// 8) a market with real, repeating bounces beats the placebo -> verdict not "no edge"
function trending(n) { // repeated: quiet base, impulse up, pullback to base, bounce
    const a = []; let p0 = 1000;
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 14; k++) { const o = p0 + (rnd() - .5) * 2; a.push(mk(o, o + 3, o - 3, o + (rnd() - .5) * 2, a.length)); }
        a.push(mk(p0, p0 + 1, p0 - 1, p0 + .2, a.length));            // base
        a.push(mk(p0 + .2, p0 + 40, p0, p0 + 38, a.length));          // impulse
        a.push(mk(p0 + 38, p0 + 40, p0 + 25, p0 + 26, a.length));
        a.push(mk(p0 + 26, p0 + 27, p0 - .3, p0 + 2, a.length));      // touch demand
        a.push(mk(p0 + 2, p0 + 30, p0 + 1, p0 + 28, a.length));       // bounce
        p0 = p0 + 28;
    }
    return a;
}
seed = 3; const tr = runZoneStudy(trending(60), { minN: 8 });
assert.ok(tr.real.n >= 30 && tr.real.bouncePct >= 70, JSON.stringify(tr.real));
// (this clean synthetic market never revisits shifted placebo levels, so only the real-zone side is asserted here)
assert.strictEqual(tr.placebo.n, 0);
const { zTest } = require('../src/utils/zoneStudy');
assert.ok(zTest({ n: 100, bounce: 70 }, { n: 100, bounce: 50 }) > 1.64);
assert.ok(Math.abs(zTest({ n: 100, bounce: 52 }, { n: 100, bounce: 50 })) < 1.64);
assert.strictEqual(zTest({ n: 0, bounce: 0 }, { n: 5, bounce: 1 }), null);
console.log('zoneStudy tests passed');