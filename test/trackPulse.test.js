'use strict';
const assert = require('assert');
const TP = require('../public/js/track-pulse');

// Wilson interval sanity: 12/20 = 60% -> roughly 39-78%; 0 of 0 -> null; extremes stay inside [0,1]
const w = TP.wilson(12, 20);
assert.ok(w[0] > 0.38 && w[0] < 0.40 && w[1] > 0.77 && w[1] < 0.80, 'wilson 12/20: ' + w);
assert.strictEqual(TP.wilson(0, 0), null);
assert.ok(TP.wilson(20, 20)[1] <= 1 && TP.wilson(0, 20)[0] >= 0);
assert.ok(TP.wilson(60, 100)[0] > 0.5, '60/100 is above a coin flip');
assert.ok(!(TP.wilson(15, 30)[0] > 0.5), '50% never beats a coin flip');

// grading rules
assert.strictEqual(TP.grade({ name: 'a', wins: 5, nDir: 9, coachAvg: 20 }).k, 'few');                      // under 10 fires
assert.strictEqual(TP.grade({ name: 'b', wins: 20, nDir: 40, coachAvg: 5 }).k, 'mid');                      // 50% win -> range includes 50%
assert.strictEqual(TP.grade({ name: 'c', wins: 70, nDir: 100, coachAvg: 3 }).k, 'good');                    // clear above 50% and Coach avg positive
assert.strictEqual(TP.grade({ name: 'd', wins: 70, nDir: 100, coachAvg: -2 }).k, 'bad');                    // direction ok but money-losing -> not good
assert.strictEqual(TP.grade({ name: 'h', wins: 70, nDir: 138, coachAvg: -0.8 }).k, 'mid');                  // a tiny negative average is noise, not 'losing'
assert.strictEqual(TP.grade({ name: 'i', wins: 55, nDir: 131, coachAvg: -1.0 }).k, 'mid');
assert.strictEqual(TP.grade({ name: 'j', wins: 60, nDir: 120, coachAvg: -1.5 }).k, 'bad');                  // -1.5% or worse counts
assert.strictEqual(TP.grade({ name: 'e', wins: 12, nDir: 40, coachAvg: null }).k, 'bad');                   // 30% win, range fully below 50%
assert.strictEqual(TP.grade({ name: 'f', wins: 14, nDir: 20, coachAvg: 4 }).k, 'mid');                      // 20 fires is never "good"
assert.strictEqual(TP.grade({ name: 'g', wins: 70, nDir: 100, coachAvg: null }).k, 'mid');                  // no Coach figure -> cannot be good

const row = (instrument, source, win, loss, coachN, avg, muted) => ({ instrument, source, win_count: win, loss_count: loss, flat_count: 3, coach_resolved_count: coachN, avg_coach_pct_move: avg, muted: !!muted });
const sa = [
    row('NIFTY', 'Brahmastra', 40, 14, 54, 7.2), row('NIFTY', 'Murarka', 20, 10, 30, 6.2), row('NIFTY', 'Index Confirm', 8, 22, 28, -2.9),
    row('NIFTY', 'Fast Momentum', 25, 32, 57, 5.7), row('NIFTY', 'Trend Rider', 6, 5, 9, 2.7), row('NIFTY', 'Volume Confirm', 4, 3, 7, 4.2),
    row('NIFTY', 'S/R Bounce', 18, 24, 42, 1.1), row('CRUDE', 'Sustained Drift', 3, 2, 5, null, true),
];
const etr = { engines: { main: { label: 'Main Engine', total: 25, winPct: 60, avgResultPct: 4.1, resultN: 25 }, mtf: { label: 'MTF Tracker', total: 5, winPct: 40, avgResultPct: 1, resultN: 5 },
    classic: { label: 'Classic', all: { logged: 20, resolved: 12, dirWinPct: 58, wins: 7, losses: 5, avgCoachPct: 2.2, coachN: 12 } } } };
const r = TP.compute(sa, etr);
const g = n => r.graded.find(x => x.name === n);
assert.strictEqual(g('Brahmastra').k, 'good');          // 40/54 = 74%, Coach +7.2
assert.strictEqual(g('Index Confirm').k, 'bad');        // 8/30 = 27%, Coach -2.9
assert.strictEqual(g('Trend Rider').k, 'mid');          // 11 direction-resolved fires: enough to look, not enough to decide
assert.strictEqual(g('Volume Confirm').k, 'few');       // 7 fires
assert.strictEqual(g('Fast Momentum').k, 'mid');        // 25/57 = 44%, positive Coach but the win range includes 50%
assert.strictEqual(g('Murarka').k, 'mid', 'a 30-fire 67% win-rate still has a range that includes a coin flip');
assert.strictEqual(g('Sustained Drift').muted, true);
// engines
assert.strictEqual(r.engines.length, 3);
assert.strictEqual(r.engines[0].k, 'mid');              // Main: 15/25, 25 fires -> mid
assert.strictEqual(r.engines[1].k, 'few');              // MTF: 5 fires
assert.strictEqual(r.engines[2].wins, undefined); assert.strictEqual(r.engines[2].n, 12);   // Classic (sim): 12 resolved
// tiles
const T = id => r.tiles.find(t => t.id === id);
assert.strictEqual(r.tiles.length, 5);
assert.ok(/1🟢/.test(T('tp2-nifty').val) && /1🔴/.test(T('tp2-nifty').val), T('tp2-nifty').val);
assert.strictEqual(T('tp2-bitcoin').val, '--'); assert.strictEqual(T('tp2-bitcoin').cls, 'wait');
assert.strictEqual(T('tp2-mute').val, '1'); assert.ok(/Sustained Drift/.test(T('tp2-mute').full));
assert.ok(/Brahmastra/.test(T('tp2-nifty').full) && /asli range/.test(T('tp2-nifty').full));
// verdict + chips
assert.strictEqual(r.totals.good, 1); assert.strictEqual(r.totals.bad, 1);
assert.ok(/Mixed/.test(r.verdict));
assert.ok(r.chips.some(c => /Brahmastra/.test(c.t) && /\+7.2/.test(c.t)));
assert.ok(r.chips.some(c => /Index Confirm/.test(c.t)));
assert.ok(!r.chips.some(c => /luck/.test(c.t)), 'only 5 sources have 30+ fires: no multiple-testing chip yet');
const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(x => row('NIFTY', x, 15, 20, 35, 1));
assert.ok(TP.compute(six, null).chips.some(c => /luck/.test(c.t)), '6 solid sources tested together: luck warning');
// nothing / garbage never throws
for (const x of [[null, null], [[], {}], [[null, {}, { source: 'x' }], { engines: {} }], [undefined, { engines: { main: { total: 'a' } } }]]) { const q = TP.compute(x[0], x[1]); assert.strictEqual(q.tiles.length, 5); assert.ok(q.verdict); }
assert.ok(/ban raha/.test(TP.compute([], null).verdict));
TP.update({ sa }); TP.render();     // no DOM: must not throw
console.log('trackPulse OK');