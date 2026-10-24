const assert = require('assert');
const { toCardPayload, buildDayReport } = require('../src/utils/tickFlowLab');

// minute rows: IST 2026-10-23 09:15.. ; ts in ms (UTC) = IST - 5:30
const IST0 = Date.UTC(2026, 9, 23, 9, 15) - 330 * 60000;
const row = (min, o) => ({ ts: IST0 + min * 60000, ticks: 100, events: 10, vol: 1000, ltqSum: 200, buyTick: 0, sellTick: 0, buyQ: o.buy || 0, sellQ: o.sell || 0, unTick: 0, unQ: 0, qByQuote: 150, o: 100, h: 101, l: 99, c: 100.5, spreadSum: 5, spreadN: 1 });
const rows = []; for (let m = 0; m < 15; m++) rows.push(row(m, { buy: 120, sell: 80 }));          // bar 1: delta +40 per min -> +600
for (let m = 15; m < 30; m++) rows.push(row(m, { buy: 50, sell: 150 }));                          // bar 2: -1500
for (let m = 30; m < 35; m++) rows.push(row(m, { buy: 100, sell: 0 }));                           // bar 3 partial (5 min): +500
const rep = { ok: true, ...buildDayReport(rows, '2026-10-23'), symbol: 'NIFTY27OCT26FUT', live: { connected: true, lastPacketAgoSec: 2 } };

{
    const p = toCardPayload(rep, Date.UTC(2026, 9, 23, 6, 0));                                   // 11:30 IST same day
    assert.strictEqual(p.success, true); assert.strictEqual(p.isToday, true); assert.strictEqual(p.day, '2026-10-23'); assert.strictEqual(p.symbol, 'NIFTY27OCT26FUT');
    assert.strictEqual(p.bars.length, 3);
    assert.deepStrictEqual(p.bars.map(b => b.label), ['09:15', '09:30', '09:45']);
    assert.deepStrictEqual(p.bars.map(b => b.delta), [600, -1500, 500]);
    assert.deepStrictEqual(p.bars.map(b => b.cum), [600, -900, -400]);
    assert.deepStrictEqual(p.bars.map(b => b.partial), [false, false, true]);
    assert.strictEqual(p.bars[0].vol, 15000); assert.strictEqual(p.totals.vol, 35000); assert.strictEqual(p.totals.delta, -400);
    assert.strictEqual(p.live.connected, true);
    assert.strictEqual(toCardPayload(rep, Date.UTC(2026, 9, 26, 6, 0)).isToday, false);          // a later day -> shown as "pichhla din"
}
{
    assert.strictEqual(toCardPayload(null).success, false);
    assert.strictEqual(toCardPayload({ ok: false, error: 'No lab rows yet' }).error, 'No lab rows yet');
    const empty = toCardPayload({ ok: true, ...buildDayReport([], '2026-10-23'), symbol: null });
    assert.strictEqual(empty.success, true); assert.strictEqual(empty.bars.length, 0); assert.strictEqual(empty.totals.vol, 0);
}
console.log('orderflowCard tests OK');