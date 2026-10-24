const assert = require('assert');
const { buildConfluenceEntries, evaluateConfluence, formatConfluenceText, CONFLUENCE_RULE } = require('../src/utils/confluenceRule');

const M = 60000, DAY = 24 * 60 * M;
const sig = (src, min, dir = 'CE') => ({ source: src, direction: dir, fireTs: min * M, entryPremium: 100, path: [] });

// ── entries: the 3rd DIFFERENT trigger inside 30 min of the window's first signal ─────────────────────────────
{
    let e = buildConfluenceEntries([sig('A', 0), sig('B', 3), sig('C', 7)], 30, 3);
    assert.strictEqual(e.length, 1); assert.strictEqual(e[0].source, 'C'); assert.strictEqual(e[0].fireTs, 7 * M); assert.strictEqual(e[0].triggers, 3);
    assert.strictEqual(buildConfluenceEntries([sig('A', 0), sig('A', 3), sig('B', 7)], 30, 3).length, 0);          // same trigger twice is not confluence
    assert.strictEqual(buildConfluenceEntries([sig('A', 0), sig('B', 3), sig('C', 31)], 30, 3).length, 0);          // 3rd one outside the window -> new window
    assert.strictEqual(buildConfluenceEntries([sig('A', 0, 'CE'), sig('B', 3, 'PE'), sig('C', 7, 'CE')], 30, 3).length, 0);   // directions never mix
    e = buildConfluenceEntries([sig('A', 0), sig('B', 3), sig('C', 7), sig('D', 9), sig('E', 12)], 30, 3);
    assert.strictEqual(e.length, 1);                                                                                // one entry per window, not one per extra trigger
    e = buildConfluenceEntries([sig('A', 0), sig('B', 3), sig('C', 7), sig('A', 40), sig('B', 41), sig('C', 42)], 30, 3);
    assert.strictEqual(e.length, 2); assert.strictEqual(e[1].fireTs, 42 * M);
}

// ── synthetic forward data ─────────────────────────────────────────────────────────────────────────────────────
const START = Date.UTC(2026, 9, 26, 3, 45, 0);                                // Mon 26 Oct 09:15 IST
// one confluence group: A at t0, B at t0+2, C at t0+4 (entry = C, premium 100). pathFn(minutesAfterEntry) -> premium
function group(i, pathFn, perDay = 20) {
    const t0 = START + Math.floor(i / perDay) * DAY + (i % perDay) * 45 * M, out = [];
    ['A', 'B', 'C'].forEach((src, k) => {
        const fireTs = t0 + k * 2 * M, entryTs = t0 + 4 * M;
        out.push({ id: i * 3 + k, source: src, direction: 'CE', fireTs, entryPremium: 100, path: [0, 5, 10, 15, 30, 55, 60, 65].map(m => ({ ts: fireTs + m * M, premium: pathFn(fireTs + m * M - entryTs) / 1 })) });
    });
    return out;
}
const mkAll = (n, fn) => Array.from({ length: n }, (_, i) => group(i, fn)).flat();
const rising = ms => { const m = ms / M; return m < 0 ? 100 : m < 8 ? 100 + m : m < 12 ? 112 : 120; };    // +12% by minute ~10 then 120
const falling = ms => { const m = ms / M; return m < 0 ? 100 : 90 + (m < 5 ? 5 : 0); };

{
    // before the start date nothing counts
    const early = mkAll(10, rising).map(x => ({ ...x, fireTs: x.fireTs - 10 * DAY, path: x.path.map(p => ({ ...p, ts: p.ts - 10 * DAY })) }));
    const none = evaluateConfluence(early, { startTs: START - 3600000 });
    assert.strictEqual(none.b1.trades, 0); assert.strictEqual(none.b1.status, 'COLLECTING'); assert.strictEqual(none.b2.status, 'COLLECTING');
    // too few -> COLLECTING
    const few = evaluateConfluence(mkAll(30, rising), { startTs: START - 3600000 });
    assert.strictEqual(few.entries, 30); assert.strictEqual(few.b1.status, 'COLLECTING'); assert.ok(few.b1.reasons[0].includes('need 100'));
    // steady winners, plenty of trades and days -> both PASS (rising path is up >=5% at 10 min -> B2 takes them)
    const good = evaluateConfluence(mkAll(120, rising), { startTs: START - 3600000 });
    assert.ok(good.b1.trades === 120 && good.b1.days >= 6, JSON.stringify([good.b1.trades, good.b1.days]));
    assert.ok(good.b1.netAvgRs > 0);
}
{
    const rule = { minTrades: 100, minDays: 5 };
    const good = evaluateConfluence(mkAll(120, rising), { startTs: START - 3600000, criteria: rule });
    assert.strictEqual(good.b1.status, 'PASS'); assert.strictEqual(good.b2.status, 'PASS'); assert.ok(good.b2.trades === 120);
    // B2 enters LATER at ~110 and earns less per trade than B1 (entry at 100) on this path
    assert.ok(good.b2.netAvgRs < good.b1.netAvgRs);
    // falling path: B1 loses (stop hit), B2 never confirms -> zero trades, stays COLLECTING (not a pass)
    const bad = evaluateConfluence(mkAll(120, falling), { startTs: START - 3600000, criteria: rule });
    assert.strictEqual(bad.b1.status, 'FAIL'); assert.strictEqual(bad.b2.trades, 0); assert.strictEqual(bad.b2.status, 'COLLECTING');
    assert.strictEqual(evaluateConfluence(null).entries, 0); assert.strictEqual(evaluateConfluence([{}, null]).b1.status, 'COLLECTING');
    const txt = formatConfluenceText(good, { start: '2026-10-26' });
    assert.ok(txt.includes('FORWARD TEST #2') && txt.includes('B1') && txt.includes('B2') && txt.includes('3 TRIGGERS + 10-MIN CONFIRM') && txt.includes('Day by day'));
    assert.ok(formatConfluenceText(good, { backtest: true, days: 60 }).includes('proves NOTHING'));
    assert.strictEqual(CONFLUENCE_RULE.need, 3);
}
{   // one lucky trade carrying the profit -> FAIL on the outlier bar
    const lucky = mkAll(120, ms => (ms / M < 0 ? 100 : 101)).map(x => x);
    const big = lucky.map(x => x.id >= 3 * 50 && x.id < 3 * 51 ? { ...x, path: x.path.map(p => ({ ...p, premium: p.ts - x.fireTs >= 55 * M ? 400 : p.premium })) } : x);
    const r = evaluateConfluence(big, { startTs: START - 3600000, criteria: { minTrades: 100, minDays: 5 } });
    assert.ok(r.b1.netTotalRs > 0, String(r.b1.netTotalRs));
    assert.strictEqual(r.b1.status, 'FAIL'); assert.ok(r.b1.reasons.some(x => x.includes('best single trade')));
}
console.log('confluenceRule tests OK');