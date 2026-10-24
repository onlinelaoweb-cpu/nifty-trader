const assert = require('assert');
const { simulateScalp, tradeRupees, computeScalpCostStudy, formatScalpCostText } = require('../src/utils/scalpCostStudy');

const M = 60000;
const P = (...pairs) => pairs.map(([m, premium]) => ({ ts: m * M, premium }));   // minutes after fire (fireTs = 0)

// ── simulateScalp ────────────────────────────────────────────────────────────────────────────────────────────
{
    // target hit: fills at the target LEVEL, not at the (higher) sample
    let s = simulateScalp(100, P([0, 100], [5, 103], [10, 108]), 0, 5, 4, 30);
    assert.deepStrictEqual(s, { exitPx: 105, reason: 'tp' });
    // stop hit: sample 95.5 is already below the 96 level -> stop-market fills at the worse sampled price
    s = simulateScalp(100, P([0, 100], [5, 97], [10, 95.5]), 0, 5, 4, 30);
    assert.strictEqual(s.reason, 'sl');
    assert.strictEqual(s.exitPx, 95.5);                          // stop-market fills at the sampled price when it is worse
    // gap through the stop: worse of (level, sample)
    s = simulateScalp(100, P([0, 100], [5, 90], [10, 120]), 0, 8, 4, 30);
    assert.deepStrictEqual(s, { exitPx: 90, reason: 'sl' });
    // exactly on the stop level fills at the level
    s = simulateScalp(100, P([0, 100], [5, 96]), 0, 8, 4, 30);
    assert.deepStrictEqual(s, { exitPx: 96, reason: 'sl' });
    // timeout: only samples inside the window count; later spike is ignored
    s = simulateScalp(100, P([0, 100], [10, 101], [20, 102], [31, 150]), 0, 8, 4, 30);
    assert.deepStrictEqual(s, { exitPx: 102, reason: 'timeout' });
    // HOLD (no target, no stop)
    s = simulateScalp(100, P([0, 100], [10, 90], [25, 120]), 0, null, null, 30);
    assert.deepStrictEqual(s, { exitPx: 120, reason: 'timeout' });
    // bad inputs
    assert.strictEqual(simulateScalp(0, P([0, 1]), 0, 4, 4, 30), null);
    assert.strictEqual(simulateScalp(100, [], 0, 4, 4, 30), null);
    assert.strictEqual(simulateScalp(100, P([40, 105]), 0, 4, 4, 30), null);          // nothing inside the window
    assert.strictEqual(simulateScalp(100, null, 0, 4, 4, 30), null);
    assert.strictEqual(simulateScalp(100, P([0, 100]), NaN, 4, 4, 30), null);
}

// ── tradeRupees: hand-computed ──────────────────────────────────────────────────────────────────────────────────
{
    const c = tradeRupees(100, 105, { qty: 100, slipPts: 1, chargePct: 0.07, brokerage: 40 });
    assert.strictEqual(Math.round(c.gross * 100) / 100, 500);
    assert.strictEqual(Math.round(c.cost * 100) / 100, 254.35);          // slip 200 + charges 100*205*0.0007 = 14.35 + brokerage 40
    assert.strictEqual(Math.round(c.net * 100) / 100, 245.65);
    const z = tradeRupees(100, 100, { qty: 100, slipPts: 0, chargePct: 0, brokerage: 0 });
    assert.deepStrictEqual(z, { gross: 0, cost: 0, net: 0 });
}

// ── synthetic study ─────────────────────────────────────────────────────────────────────────────────────────
const DAY = 24 * 60 * M, BASE = Date.UTC(2026, 9, 5, 4, 0, 0);                 // 5 Oct 2026 09:30 IST
function makeTrades(count, moveFn, source = 'Brahmastra') {
    const out = [];
    for (let i = 0; i < count; i++) {
        const day = Math.floor(i / 20), slot = i % 20;
        const fireTs = BASE + day * DAY + slot * 40 * M;                   // 40 min apart -> survives the 30 min decluster
        const path = [0, 5, 10, 15, 20, 25, 30].map(m => ({ ts: fireTs + m * M, premium: moveFn(m, i) }));
        out.push({ id: i + 1, source, fireTs, entryPremium: 100, path });
    }
    return out;
}
const free = { slipPts: 0, chargePct: 0, brokerage: 0, qty: 100 };

{   // every trade runs +6 by minute 10 and stays -> TP4/SL4 hits the target for exactly +4 pts = Rs 400, HOLD earns +6 = Rs 600
    const res = computeScalpCostStudy(makeTrades(80, m => m < 10 ? 100 + m * 0.6 : 106), free);
    assert.strictEqual(res.tradesUsed, 80); assert.strictEqual(res.days, 4); assert.strictEqual(res.tradesPerDay, 20);
    const hold = res.variants.find(v => v.name === 'HOLD'), tp4 = res.variants.find(v => v.name === 'TP4/SL4');
    assert.strictEqual(hold.netAvgRs, 600); assert.strictEqual(hold.verdict, 'PASS');
    assert.strictEqual(tp4.netAvgRs, 400); assert.strictEqual(tp4.hitTpPct, 100); assert.strictEqual(tp4.winPct, 100);
    assert.strictEqual(tp4.older.n, 40); assert.strictEqual(tp4.newer.n, 40); assert.strictEqual(tp4.verdict, 'PASS');
    assert.strictEqual(tp4.netTotalRs, 32000);
    const tp12 = res.variants.find(v => v.name === 'TP12/SL4');                 // +12 never reached -> exits at the 30-min timeout (+6)
    assert.strictEqual(tp12.hitTpPct, 0); assert.strictEqual(tp12.timeoutPct, 100); assert.strictEqual(tp12.netAvgRs, 600);
    assert.strictEqual(res.variantsTried, 16); assert.strictEqual(res.variants.length, 17);      // 12 target/stop + 4 stop-only + HOLD
    const so = res.variants.find(v => v.name === 'HOLD+SL10');                  // no target, wide stop never touched -> same as HOLD
    assert.ok(so && so.tp === null && so.sl === 10); assert.strictEqual(so.netAvgRs, 600); assert.strictEqual(so.hitSlPct, 0);
    assert.strictEqual(computeScalpCostStudy(makeTrades(80, m => 106), { ...free, slOnly: [] }).variants.length, 13);
}

{   // costs turn a small winner into a loser: +2 pts gross, 1 pt slippage each side = 0 before charges, brokerage pushes it negative
    const res = computeScalpCostStudy(makeTrades(80, m => 100 + (m > 0 ? 2 : 0)), { slipPts: 1, chargePct: 0.07, brokerage: 40, qty: 100 });
    const hold = res.variants[0];
    assert.strictEqual(hold.grossAvgRs, 200);
    assert.ok(hold.netAvgRs < 0, 'net must be negative after costs');
    assert.strictEqual(hold.verdict, 'LOSES AFTER COSTS');
    assert.ok(res.costPerDayRs > 0 && res.costPerTradeRs > 200);
}

{   // losing trades: every one falls 6 pts -> stop variants lose, nothing passes
    const res = computeScalpCostStudy(makeTrades(80, m => m < 10 ? 100 - m * 0.6 : 94), free);
    assert.ok(res.variants.every(v => v.verdict === 'LOSES AFTER COSTS'));
    assert.strictEqual(res.variants.find(v => v.name === 'TP4/SL4').hitSlPct, 100);
    // path samples at 97 then 94: the stop (96) is only seen at 94 -> stop-market fills at the worse sampled price = -6 pts = Rs -600
    assert.strictEqual(res.variants.find(v => v.name === 'TP4/SL4').netAvgRs, -600);
}

{   // positive on average but only in the older half -> NOT PROVEN (never PASS)
    const t = makeTrades(80, (m, i) => i < 40 ? (m < 10 ? 100 + m * 0.6 : 106) : (m < 10 ? 100 - m * 0.1 : 99));
    const res = computeScalpCostStudy(t, free);
    const hold = res.variants[0];
    assert.ok(hold.netAvgRs > 0 && hold.older.netAvgRs > 0 && hold.newer.netAvgRs < 0);
    assert.strictEqual(hold.verdict, 'POSITIVE, NOT PROVEN');
}

{   // too few trades never gets a verdict
    const res = computeScalpCostStudy(makeTrades(30, m => m < 10 ? 100 + m * 0.6 : 106), free);
    assert.ok(res.variants.every(v => v.verdict === 'TOO FEW TRADES'));
}

{   // decluster: signals 10 min apart from one trigger collapse to one per 30 min
    const dense = makeTrades(40, m => 106).map((x, i) => ({ ...x, fireTs: BASE + i * 10 * M, path: [0, 5, 10, 15, 20, 25, 30].map(m => ({ ts: BASE + i * 10 * M + m * M, premium: 106 })) }));
    const res = computeScalpCostStudy(dense, free);
    assert.strictEqual(res.tradesBeforeDecluster, 40); assert.strictEqual(res.tradesUsed, 14);   // 400 min span / 30 -> 14 kept
}

{   // cheap entries and short / bad paths are dropped; garbage never throws
    const tr = makeTrades(80, m => 106);
    tr[0].entryPremium = 5; tr[1].path = [{ ts: tr[1].fireTs, premium: 100 }]; tr[2] = null; tr[3].fireTs = NaN;
    const res = computeScalpCostStudy(tr, free);
    assert.strictEqual(res.tradesUsed, 76);
    assert.doesNotThrow(() => computeScalpCostStudy(null));
    assert.doesNotThrow(() => computeScalpCostStudy([], {}));
    assert.doesNotThrow(() => computeScalpCostStudy([{}, { entryPremium: 'x' }, { path: 3 }]));
    assert.strictEqual(computeScalpCostStudy([]).tradesUsed, 0);
}

{   // per-trigger split + text output
    const a = makeTrades(40, m => m < 10 ? 100 + m * 0.6 : 106, 'Brahmastra');
    const b = makeTrades(40, m => m < 10 ? 100 - m * 0.6 : 94, 'S/R Bounce').map(x => ({ ...x, id: x.id + 1000 }));
    const res = computeScalpCostStudy([...a, ...b], free);
    const hold = res.variants[0];
    const ps = Object.fromEntries(hold.perSource.map(s => [s.source, s.netAvgRs]));
    assert.strictEqual(ps['Brahmastra'], 600); assert.strictEqual(ps['S/R Bounce'], -600);
    const txt = formatScalpCostText(res, { instrument: 'NIFTY', days: 30 });
    assert.ok(txt.includes('SCALP-COST STUDY') && txt.includes('HOLD') && txt.includes('TP4/SL4') && txt.includes('PER TRIGGER'));
    assert.ok(/cannot be resolved/.test(txt));
}


// ── v2: stop-fill option ─────────────────────────────────────────────────────────────────────────────────────
{
    const gap = P([0, 100], [5, 90], [10, 120]);                                  // gaps straight through a 4-pt stop
    assert.deepStrictEqual(simulateScalp(100, gap, 0, null, 4, 30), { exitPx: 90, reason: 'sl' });              // default = worse
    assert.deepStrictEqual(simulateScalp(100, gap, 0, null, 4, 30, 'worse'), { exitPx: 90, reason: 'sl' });
    assert.deepStrictEqual(simulateScalp(100, gap, 0, null, 4, 30, 'level'), { exitPx: 96, reason: 'sl' });     // optimistic
    const worse = computeScalpCostStudy(makeTrades(80, m => m < 5 ? 100 : (m < 10 ? 90 : 90)), { ...free, stopFill: 'worse' });
    const level = computeScalpCostStudy(makeTrades(80, m => m < 5 ? 100 : (m < 10 ? 90 : 90)), { ...free, stopFill: 'level' });
    assert.strictEqual(worse.params.stopFill, 'worse'); assert.strictEqual(level.params.stopFill, 'level');
    assert.strictEqual(worse.variants.find(v => v.name === 'HOLD+SL10').netAvgRs, -1000);   // 10-pt stop, premium 90 -> fills at 90
    assert.strictEqual(level.variants.find(v => v.name === 'HOLD+SL10').netAvgRs, -1000);   // 100-10 = 90 level, same here
    const w4 = worse.variants.find(v => v.name === 'TP4/SL4').netAvgRs, l4 = level.variants.find(v => v.name === 'TP4/SL4').netAvgRs;
    assert.strictEqual(w4, -1000); assert.strictEqual(l4, -400);                              // 'level' is never worse than 'worse'
    assert.ok(l4 >= w4);
    assert.strictEqual(computeScalpCostStudy(makeTrades(80, m => 106), { ...free, stopFill: 'junk' }).params.stopFill, 'worse');
}

// ── v2: robustness stats and the outlier-driven verdict ─────────────────────────────────────────────────────────
{   // 72 small losers (-2 pts) + 8 huge winners (+40 pts), spread over both halves -> positive average, but only because of the winners
    const t = makeTrades(80, (m, i) => (i % 10 === 5 ? 140 : 98));
    const res = computeScalpCostStudy(t, free);
    const hold = res.variants[0];
    assert.strictEqual(hold.netAvgRs, (8 * 4000 - 72 * 200) / 80);                    // +220 per trade on average
    assert.strictEqual(hold.medianNetRs, -200); assert.strictEqual(hold.worstNetRs, -200); assert.strictEqual(hold.bestNetRs, 4000);
    assert.strictEqual(hold.netAvgExTop10Rs, -200);                                   // best 10% (8 trades) removed -> only losers left
    assert.ok(hold.older.netAvgRs > 0 && hold.newer.netAvgRs > 0);                    // halves alone would have said PASS
    assert.strictEqual(hold.verdict, 'POSITIVE, OUTLIER-DRIVEN');
}
{   // evenly spread winners stay a PASS and show a positive median
    const res = computeScalpCostStudy(makeTrades(80, m => m < 10 ? 100 + m * 0.6 : 106), free);
    const hold = res.variants[0];
    assert.strictEqual(hold.verdict, 'PASS'); assert.strictEqual(hold.medianNetRs, 600); assert.strictEqual(hold.netAvgExTop10Rs, 600); assert.strictEqual(hold.worstNetRs, 600);
    const txt = formatScalpCostText(res, { instrument: 'NIFTY', days: 30 });
    assert.ok(txt.includes('ROBUSTNESS') && txt.includes('worst trade') && txt.includes('HOLD+SL10') && txt.includes('conservative'));
    assert.ok(formatScalpCostText(computeScalpCostStudy(makeTrades(80, m => 106), { ...free, stopFill: 'level' })).includes('optimistic'));
}

console.log('scalpCostStudy tests OK');