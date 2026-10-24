const assert = require('assert');
const { simulateRule, buildEvents, computeWinnerStudy, formatWinnerText, VARIANTS } = require('../src/utils/winnerAnatomy');
const { evaluateForward, formatForwardText } = require('../src/utils/scalpCostStudy');

const M = 60000;
const P = (...pairs) => pairs.map(([m, premium]) => ({ ts: m * M, premium }));
const R = name => VARIANTS.find(v => v.name === name);

// ── simulateRule ────────────────────────────────────────────────────────────────────────────────────────────
{
    // plain stop: gaps through -15 -> fills at the sample (worse)
    let s = simulateRule(100, P([0, 100], [5, 70]), 0, R('SL15'), 60);
    assert.deepStrictEqual(s, { exitPx: 70, reason: 'sl' });
    assert.strictEqual(simulateRule(100, P([0, 100], [5, 70]), 0, R('SL15'), 60, 'level').exitPx, 85);
    // HOLD: just the last sample inside the window
    assert.deepStrictEqual(simulateRule(100, P([0, 100], [30, 60], [70, 500]), 0, R('HOLD'), 60), { exitPx: 60, reason: 'timeout' });
    // trail 15/12: runs to 130 (peak), then falls to 115 -> stop = 130-12 = 118, sample 115 is below -> exits at 115 (worse)
    s = simulateRule(100, P([0, 100], [5, 118], [10, 130], [15, 115], [20, 200]), 0, R('TRAIL15/12'), 60);
    assert.deepStrictEqual(s, { exitPx: 115, reason: 'trail' });
    // the SAME path under SL15 keeps riding to the end
    assert.strictEqual(simulateRule(100, P([0, 100], [5, 118], [10, 130], [15, 115], [20, 200]), 0, R('SL15'), 60).exitPx, 200);
    // trail does not trigger before activation (peak only +10)
    assert.strictEqual(simulateRule(100, P([0, 100], [5, 110], [10, 100], [15, 105]), 0, R('TRAIL15/12'), 60).reason, 'timeout');
    // stop is tested against the PREVIOUS peak: a single sample that jumps to 140 then the next at 129 (>=140-12=128) is NOT stopped
    assert.strictEqual(simulateRule(100, P([0, 100], [5, 140], [10, 129]), 0, R('TRAIL15/12'), 60).reason, 'timeout');
    // cut at 10 min if below entry
    s = simulateRule(100, P([0, 100], [5, 98], [10, 96], [15, 120]), 0, R('SL15+CUT10'), 60);
    assert.deepStrictEqual(s, { exitPx: 96, reason: 'cut' });
    assert.strictEqual(simulateRule(100, P([0, 100], [5, 98], [10, 101], [15, 120]), 0, R('SL15+CUT10'), 60).exitPx, 120);   // above entry at 10 min -> keeps going
    assert.strictEqual(simulateRule(0, P([0, 1]), 0, R('HOLD'), 60), null);
    assert.strictEqual(simulateRule(100, [], 0, R('HOLD'), 60), null);
}

// ── buildEvents ─────────────────────────────────────────────────────────────────────────────────────────────
{
    const mk = (src, min, dir) => ({ source: src, direction: dir, fireTs: min * M, entryPremium: 100, path: [] });
    const ev = buildEvents([mk('A', 0, 'CE'), mk('B', 3, 'CE'), mk('C', 5, 'PE'), mk('A', 40, 'CE'), mk('B', 41, 'CE'), mk('C', 42, 'CE')], 30);
    assert.strictEqual(ev.length, 3);                                           // CE@0 (A,B), PE@5, CE@40 (A,B,C)
    assert.strictEqual(ev[0].confluence, 2); assert.strictEqual(ev[1].confluence, 1); assert.strictEqual(ev[2].confluence, 3);
    assert.strictEqual(buildEvents([mk('A', 0, 'CE'), mk('A', 5, 'CE')], 30).length, 1);
    assert.strictEqual(buildEvents([mk('A', 0, 'CE'), mk('A', 31, 'CE')], 30).length, 2);
}

// ── synthetic study ─────────────────────────────────────────────────────────────────────────────────────────
const DAY = 24 * 60 * M, BASE = Date.UTC(2026, 9, 5, 4, 0, 0);            // Mon 5 Oct 2026 09:30 IST
// 100 events, 20 a day, 40 min apart. every 10th event is a BIG winner (path to 160, signalled by 3 triggers), others lose 5 pts slowly.
function events(count) {
    const out = []; let id = 1;
    for (let i = 0; i < count; i++) {
        const fireTs = BASE + Math.floor(i / 20) * DAY + (i % 20) * 40 * M, big = i % 10 === 5;
        const mkPath = () => [0, 5, 10, 15, 30, 60].map(m => ({ ts: fireTs + m * M, premium: big ? (m === 0 ? 100 : m === 5 ? 108 : m === 10 ? 112 : m === 15 ? 125 : m === 30 ? 140 : 160) : (m === 0 ? 100 : 95) }));
        const srcs = big ? ['A', 'B', 'C'] : ['A'];
        srcs.forEach((src, k) => out.push({ id: id++, source: src, direction: 'CE', fireTs: fireTs + k * 2 * M, entryPremium: 100, path: mkPath().map(p => ({ ...p, ts: p.ts + k * 2 * M })) }));
    }
    return out;
}
{
    const res = computeWinnerStudy(events(100), { slipPts: 0, chargePct: 0, brokerage: 0, qty: 100 });
    assert.strictEqual(res.events, 100); assert.strictEqual(res.days, 5);
    assert.strictEqual(res.signalsUsed, 100 + 10 * 2);
    const sl = res.variants.find(v => v.name === 'SL15'), hold = res.variants.find(v => v.name === 'HOLD');
    assert.strictEqual(hold.netAvgRs, (10 * 6000 - 90 * 500) / 100);          // -(450)+... = (60000-45000)/100 = 150
    assert.strictEqual(sl.medianNetRs, -500); assert.strictEqual(sl.bestNetRs, 6000);
    assert.strictEqual(hold.verdict, 'POSITIVE, OUTLIER-DRIVEN');
    // classes: 10 big winners (top 10%), 0 average winners, 90 losers
    const big = res.classes.find(c => c.cls === 'big'), avg = res.classes.find(c => c.cls === 'avgwin'), lose = res.classes.find(c => c.cls === 'loser');
    assert.strictEqual(big.n, 10); assert.strictEqual(avg.n, 0); assert.strictEqual(lose.n, 90);
    assert.strictEqual(big.avgConfluence, 3); assert.strictEqual(lose.avgConfluence, 1); assert.strictEqual(big.shareOfWinProfitPct, 100);
    // profile: 3 triggers together -> every one big (lift 10), 1 trigger alone -> none
    const c3 = res.profile.confluence.find(b => b.bucket === '3+ triggers together'), c1 = res.profile.confluence.find(b => b.bucket === '1 trigger alone');
    assert.strictEqual(c3.n, 10); assert.strictEqual(c3.bigPct, 100); assert.strictEqual(c3.liftBig, 10); assert.strictEqual(c1.bigPct, 0); assert.ok(c3.few);
    const e10 = res.profile.early10.find(b => b.bucket === '10 min: up 10%+'); assert.strictEqual(e10.n, 10);
    // trail: big path 100,108,112,125,140,160 -> never falls back 12 from peak -> same as hold 6000; losers hit nothing special (95 > 85) -> -500
    assert.strictEqual(res.variants.find(v => v.name === 'TRAIL15/12').bestNetRs, 6000);
    // cut10: losers are at 95 at the first sample >= 10 min (the 15-min one) -> cut at 95 = same -500; fine
    assert.strictEqual(res.variants.find(v => v.name === 'SL15+CUT10').netAvgRs, 150);
    assert.strictEqual(res.bigList.length, 10); assert.strictEqual(res.bigList[0].triggers, 3);
    const txt = formatWinnerText(res, { instrument: 'NIFTY', days: 30 });
    assert.ok(txt.includes('WINNER ANATOMY') && txt.includes('BIG winner') && txt.includes('lift') && txt.includes('READ THIS') && txt.includes('TRAIL25/20'));
}
{   // too few events, garbage input
    assert.strictEqual(computeWinnerStudy(events(20), {}).variants[0].verdict, 'TOO FEW EVENTS');
    const g = computeWinnerStudy([null, {}, { fireTs: 'x' }], {}); assert.strictEqual(g.events, 0); assert.strictEqual(g.classes.length, 3);
    assert.ok(typeof formatWinnerText(g) === 'string');
    assert.strictEqual(computeWinnerStudy(null).events, 0);
}
{   // forward test now also reports independent events
    const START = Date.UTC(2026, 9, 26, 3, 45, 0), out = [];
    for (let i = 0; i < 40; i++) {
        const fireTs = START + (i % 20) * 40 * M + Math.floor(i / 20) * DAY;
        for (const src of ['A', 'B']) out.push({ id: i * 2 + out.length, source: src, direction: 'CE', fireTs, entryPremium: 100, path: [0, 5, 30, 60].map(m => ({ ts: fireTs + m * M, premium: 105 })) });
    }
    const fw = evaluateForward(out, { startTs: START - 3600000 });
    assert.strictEqual(fw.trades, 80); assert.strictEqual(fw.events.n, 40);
    assert.ok(formatForwardText(fw, { start: '2026-10-26' }).includes('INDEPENDENT EVENTS'));
}
console.log('winnerAnatomy tests OK');