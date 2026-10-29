'use strict';
const assert = require('assert');
const L = require('../src/utils/tickFlowLab');

// ── synthetic SnapQuote packet (379 bytes) following the documented layout ─────────────────────────────────────────────
function pkt({ token = '35003', ltp = 23100, ltq = 75, vol = 1000, bid = 23099.95, ask = 23100.05, bq = 150, aq = 225, mode = 3, len = 379, totBuy = 5000, totSell = 4000, oi = 12345 }) {
    const b = Buffer.alloc(len);
    b.writeUInt8(mode, 0); b.writeUInt8(2, 1); b.write(token, 2, 'utf8'); b.writeBigInt64LE(7n, 27); b.writeBigInt64LE(1760000000000n, 35);
    b.writeUInt32LE(Math.round(ltp * 100), 43); b.writeBigInt64LE(BigInt(ltq), 51); b.writeBigInt64LE(BigInt(Math.round(ltp * 100)), 59); b.writeBigInt64LE(BigInt(vol), 67);
    b.writeDoubleLE(totBuy, 75); b.writeDoubleLE(totSell, 83);
    [23000, 23200, 22950, 23050].forEach((p, i) => b.writeBigInt64LE(BigInt(p * 100), 91 + i * 8));
    if (len >= 347) {
        b.writeBigInt64LE(1760000000000n, 123); b.writeBigInt64LE(BigInt(oi), 131);
        // best 5 buy: flags 1, prices descending from bid; best 5 sell: flags 0, ascending from ask
        for (let i = 0; i < 5; i++) { const o = 147 + i * 20; b.writeInt16LE(1, o); b.writeBigInt64LE(BigInt(bq + i), o + 2); b.writeBigInt64LE(BigInt(Math.round((bid - i * 0.05) * 100)), o + 10); b.writeInt16LE(3, o + 18); }
        for (let i = 0; i < 5; i++) { const o = 147 + (5 + i) * 20; b.writeInt16LE(0, o); b.writeBigInt64LE(BigInt(aq + i), o + 2); b.writeBigInt64LE(BigInt(Math.round((ask + i * 0.05) * 100)), o + 10); b.writeInt16LE(2, o + 18); }
    }
    return b;
}

// parser
const t = L.parseSnapQuote(pkt({}));
assert.strictEqual(t.mode, 3); assert.strictEqual(t.len, 379); assert.strictEqual(t.token, '35003'); assert.strictEqual(t.ltp, 23100); assert.strictEqual(t.ltq, 75); assert.strictEqual(t.volume, 1000);
assert.strictEqual(t.totBuy, 5000); assert.strictEqual(t.totSell, 4000); assert.strictEqual(t.open, 23000); assert.strictEqual(t.high, 23200); assert.strictEqual(t.low, 22950); assert.strictEqual(t.close, 23050);
assert.strictEqual(t.oi, 12345); assert.strictEqual(t.bid, 23099.95); assert.strictEqual(t.bidQty, 150); assert.strictEqual(t.ask, 23100.05); assert.strictEqual(t.askQty, 225);
assert.strictEqual(L.parseSnapQuote(pkt({ mode: 2, len: 123 })).bid, null);           // quote mode: no book
assert.strictEqual(L.parseSnapQuote(Buffer.alloc(40)), null);                           // ack / too short
assert.strictEqual(L.parseSnapQuote(pkt({ mode: 1 })), null);                           // other mode
assert.strictEqual(L.parseSnapQuote('x'), null);

// classifier
const f = L.createFlow();
let s = L.flowStep(f, { ltp: 100, volume: 1000, bid: 99.95, ask: 100.05 });
assert.strictEqual(s.dv, 0);                                                           // first packet only seeds
s = L.flowStep(f, { ltp: 100.05, volume: 1075, bid: 100, ask: 100.1 });                // traded at previous ask -> buy by both rules
assert.deepStrictEqual([s.dv, s.tickDir, s.quoteDir, s.byQuote], [75, 1, 1, true]);
s = L.flowStep(f, { ltp: 100.05, volume: 1100, bid: 100, ask: 100.1 });                // same price: tick rule keeps last direction (buy); inside the spread -> quote rule falls back to tick
assert.deepStrictEqual([s.dv, s.tickDir, s.quoteDir, s.byQuote], [25, 1, 1, false]);
s = L.flowStep(f, { ltp: 100, volume: 1150, bid: 99.95, ask: 100.05 });                // down to previous bid -> sell
assert.deepStrictEqual([s.dv, s.tickDir, s.quoteDir, s.byQuote], [50, -1, -1, true]);
s = L.flowStep(f, { ltp: 100, volume: 1150, bid: 99.95, ask: 100.05 });                // no volume change = no trade
assert.strictEqual(s.dv, 0);
s = L.flowStep(f, { ltp: 100, volume: 10, bid: 99.95, ask: 100.05 });                  // cumulative volume went DOWN -> flagged, no delta
assert.strictEqual(s.volDrop, true); assert.strictEqual(s.dv, 0);
s = L.flowStep(f, { ltp: 100, volume: 60, bid: 99.95, ask: 100.05 });                  // continues from the new base
assert.strictEqual(s.dv, 50);

// block print: a single increment >= BLOCK_MIN stays in volume (dv) but gets no direction
{
  const fb = L.createFlow();
  L.flowStep(fb, { ltp: 100, volume: 1000, bid: 99.95, ask: 100.05 });
  const sb = L.flowStep(fb, { ltp: 100.05, volume: 1000 + L.BLOCK_MIN, bid: 100, ask: 100.1 });
  assert.deepStrictEqual([sb.dv, sb.block, sb.tickDir, sb.quoteDir, sb.byQuote], [L.BLOCK_MIN, true, 0, 0, false]);
  const sn = L.flowStep(fb, { ltp: 100.05, volume: 1000 + L.BLOCK_MIN + 40, bid: 100, ask: 100.1 });  // normal trade after it still classifies
  assert.strictEqual(sn.block, false); assert.strictEqual(sn.dv, 40); assert.notStrictEqual(sn.tickDir, 0);
  const s0 = L.flowStep(L.createFlow(), { ltp: 100, volume: 5 }, 0);                                    // blockMin 0 = feature off
  assert.strictEqual(s0.block, false);
}

// bucket + coverage
const b = L.newBucket(0), fl = L.createFlow();
for (const x of [{ ltp: 100, volume: 1000, ltq: 0 }, { ltp: 100.05, volume: 1075, ltq: 75, bid: 100, ask: 100.1 }, { ltp: 100, volume: 1175, ltq: 60, bid: 99.95, ask: 100.05 }]) L.addToBucket(b, x, L.flowStep(fl, x));
assert.strictEqual(b.ticks, 3); assert.strictEqual(b.events, 2); assert.strictEqual(b.vol, 175); assert.strictEqual(b.ltqSum, 135); assert.strictEqual(b.exactN, 1); assert.strictEqual(b.multiN, 1);
assert.strictEqual(b.buyTick, 75); assert.strictEqual(b.sellTick, 100); assert.strictEqual(b.o, 100); assert.strictEqual(b.h, 100.05);

// futures token finder: picks the nearest non-expired NIFTY FUTIDX, ignores BANKNIFTY / options / expired
const scrip = '[' + [
    { token: '1', symbol: 'NIFTY27OCT26FUT', name: 'NIFTY', expiry: '27OCT2026', instrumenttype: 'FUTIDX', exch_seg: 'NFO' },
    { token: '2', symbol: 'NIFTY24NOV26FUT', name: 'NIFTY', expiry: '24NOV2026', instrumenttype: 'FUTIDX', exch_seg: 'NFO' },
    { token: '3', symbol: 'NIFTY29SEP26FUT', name: 'NIFTY', expiry: '29SEP2026', instrumenttype: 'FUTIDX', exch_seg: 'NFO' },
    { token: '4', symbol: 'BANKNIFTY27OCT26FUT', name: 'BANKNIFTY', expiry: '27OCT2026', instrumenttype: 'FUTIDX', exch_seg: 'NFO' },
    { token: '5', symbol: 'NIFTY27OCT2623000CE', name: 'NIFTY', expiry: '27OCT2026', instrumenttype: 'OPTIDX', exch_seg: 'NFO' }
].map(o => JSON.stringify(o)).join(',') + ']';
const now = Date.UTC(2026, 9, 19, 4, 0);
let fut = L.findNiftyFutToken(scrip, now); assert.strictEqual(fut.token, '1'); assert.strictEqual(fut.symbol, 'NIFTY27OCT26FUT');
fut = L.findNiftyFutToken(scrip, Date.UTC(2026, 9, 27, 4, 0)); assert.strictEqual(fut.token, '1');   // expiry day itself still counts
fut = L.findNiftyFutToken(scrip, Date.UTC(2026, 9, 28, 4, 0)); assert.strictEqual(fut.token, '2');   // day after expiry -> next month
assert.strictEqual(L.findNiftyFutToken('[]', now), null); assert.strictEqual(L.findNiftyFutToken(null, now), null);

// day report: 15-min bars, cumulative delta, coverage
const m0 = Date.UTC(2026, 9, 19, 3, 45);                                             // 09:15 IST
const row = (i, o) => ({ ts: m0 + i * 60000, ticks: 60, events: 10, vol: 1000, ltqSum: 900, buyTick: 600, sellTick: 400, unTick: 0, buyQ: 700, sellQ: 300, unQ: 0, qByQuote: 500, o: 100, h: 101, l: 99, c: 100.5, spreadSum: 1, spreadN: 10, ...o });
const rows = [row(0), row(1), row(14), row(15, { buyTick: 100, sellTick: 900 }), row(-1)];  // last = 09:14 (outside)
const rep = L.buildDayReport(rows, '2026-10-19');
assert.strictEqual(rep.bars.length, 2); assert.strictEqual(rep.outsideSessionMinutes, 1);
assert.strictEqual(rep.bars[0].label, '09:15'); assert.strictEqual(rep.bars[0].minutes, 3); assert.strictEqual(rep.bars[0].vol, 3000); assert.strictEqual(rep.bars[0].coveragePct, 90);
assert.strictEqual(rep.bars[0].deltaTick, 600); assert.strictEqual(rep.bars[0].deltaQuote, 1200);
assert.strictEqual(rep.bars[1].label, '09:30'); assert.strictEqual(rep.bars[1].deltaTick, -800); assert.strictEqual(rep.bars[1].cumTick, -200);
assert.strictEqual(rep.totals.cumTick, -200); assert.strictEqual(rep.totals.coveragePct, 90);
const txt = L.formatLabText(rep, { packets: 5 }, [], { symbol: 'X' });
assert(/TICK-FLOW LAB/.test(txt) && /09:30/.test(txt) && /SANITY COUNTERS/.test(txt));
assert.strictEqual(L.buildDayReport([], '2026-10-19').bars.length, 0);

// IST helpers
assert.deepStrictEqual(L.istParts(m0), { day: '2026-10-19', min: 555, dow: 1 });

// lab runtime with a fake DB and a fake socket (no network)
(async () => {
    const queries = [];
    const dbPool = { query: async (sql, p) => { queries.push({ sql, p }); return { rows: [] }; } };
    const sockets = [];
    const wsFactory = () => { const h = {}; const ws = { readyState: 1, sent: [], on: (e, fn) => { h[e] = fn; }, send: m => ws.sent.push(m), ping() {}, close: () => { h.close && h.close(1000); }, h }; sockets.push(ws); return ws; };
    let clock = Date.UTC(2026, 9, 19, 3, 50);                                       // Mon 09:20 IST
    const lab = L.createTickFlowLab({ dbPool, now: () => clock, log: () => {}, env: { TICKFLOW_LAB: 'true', ANGEL_API_KEY: 'k', ANGEL_CLIENT_ID: 'c' }, wsFactory, fetchScrip: async () => scrip, bootDelayMs: 0 });
    await lab.start();
    assert(queries.some(q => /CREATE TABLE IF NOT EXISTS tickflow_lab_min/.test(q.sql)));
    lab.schedule();                                                                   // no auth yet -> nothing
    assert.strictEqual(sockets.length, 0);
    lab.setAuth({ jwtToken: 'j', feedToken: 'f' });
    lab.schedule(); await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(sockets.length, 1);
    sockets[0].h.open();
    const sub = JSON.parse(sockets[0].sent[0]); assert.strictEqual(sub.params.mode, 3); assert.strictEqual(sub.params.tokenList[0].exchangeType, 2); assert.deepStrictEqual(sub.params.tokenList[0].tokens, ['1']);
    // packets: seed, buy, sell; wrong token and garbage are counted, never thrown
    assert.strictEqual(lab._handleMessage(pkt({ token: '1', ltp: 23100, vol: 1000 }), clock), true);
    assert.strictEqual(lab._handleMessage(pkt({ token: '1', ltp: 23100.05, vol: 1075, ltq: 75, bid: 23100, ask: 23100.1 }), clock + 1000), true);
    assert.strictEqual(lab._handleMessage(pkt({ token: '1', ltp: 23100, vol: 1125, ltq: 50, bid: 23099.95, ask: 23100.05 }), clock + 2000), true);
    assert.strictEqual(lab._handleMessage(pkt({ token: '999' }), clock + 3000), false);
    assert.strictEqual(lab._handleMessage(Buffer.from('pong'), clock + 3000), false);
    assert.strictEqual(lab._handleMessage(pkt({ token: '1', ltp: 5 }), clock + 3000), false);
    const st = lab._state;
    assert.strictEqual(st.stats.parsedOk, 3); assert.strictEqual(st.stats.wrongToken, 1); assert.strictEqual(st.stats.smallMsgs, 1); assert.strictEqual(st.stats.ltpOutOfRange, 1);
    assert.strictEqual(st.bucket.vol, 125); assert.strictEqual(st.bucket.buyTick, 75); assert.strictEqual(st.bucket.sellTick, 50); assert.strictEqual(st.bucket.buyQ, 75); assert.strictEqual(st.bucket.sellQ, 50);
    // minute roll-over moves the bucket to the DB
    lab._handleMessage(pkt({ token: '1', ltp: 23101, vol: 1200, ltq: 75 }), clock + 61000);
    await new Promise(r => setTimeout(r, 30)); await lab.flush(); await new Promise(r => setTimeout(r, 30));
    assert(queries.some(q => /INSERT INTO tickflow_lab_min/.test(q.sql)));
    assert(queries.some(q => /INSERT INTO tickflow_lab_raw/.test(q.sql)));
    assert(queries.some(q => /INSERT INTO tickflow_lab_day/.test(q.sql)));
    // outside the session the socket is closed (Sat 10:00 IST) and nothing reconnects
    clock = Date.UTC(2026, 9, 17, 4, 30); lab.schedule();
    assert.strictEqual(st.ws, null);
    lab.schedule(); await new Promise(r => setTimeout(r, 20)); assert.strictEqual(sockets.length, 1);
    // disabled by default
    const off = L.createTickFlowLab({ dbPool, env: {}, log: () => {} }); await off.start(); assert.strictEqual(off._state.started, false);
    lab.stop();
    console.log('tickFlowLab tests OK');
})().catch(e => { console.error(e); process.exit(1); });
// 26 Oct — two 401s in a row ask the app for a fresh Angel login (once per 10 min), and setAuth reconnects at once
(async () => {
    const L = require('../src/utils/tickFlowLab');
    const dbPool = { query: async () => ({ rows: [] }) };
    const sockets = [];
    const wsFactory = () => { const h = {}; const ws = { readyState: 1, on: (e, fn) => { h[e] = fn; }, send() {}, ping() {}, close() {}, h }; sockets.push(ws); return ws; };
    let clock = Date.UTC(2026, 9, 26, 3, 50), asked = 0;
    const lab = L.createTickFlowLab({ dbPool, now: () => clock, log: () => {}, env: { TICKFLOW_LAB: 'true', ANGEL_API_KEY: 'k', ANGEL_CLIENT_ID: 'c' }, wsFactory, fetchScrip: async () => scrip, bootDelayMs: 0, onAuthFail: async () => { asked++; } });
    await lab.start();
    lab.setAuth({ jwtToken: 'old', feedToken: 'old' });
    for (let i = 0; i < 3; i++) {
        lab.schedule(); await new Promise(r => setTimeout(r, 15));
        const w = sockets[sockets.length - 1]; w.h.error({ message: 'Unexpected server response: 401' }); w.h.close(1006);
        clock += 200000;
    }
    await new Promise(r => setTimeout(r, 15));
    assert.strictEqual(asked, 1, 'asked once, not on every failure');
    const n = sockets.length;
    lab.setAuth({ jwtToken: 'new', feedToken: 'new' }); lab.schedule(); await new Promise(r => setTimeout(r, 15));
    assert.strictEqual(sockets.length, n + 1, 'fresh token reconnects at once');
    lab.stop();
    console.log('tickFlowLab auth-refresh OK');
})().catch(e => { console.error(e); process.exit(1); });

// ── 29 Oct: yesterday's last minute must not appear on the new day's card ──────────────────────────
(async () => {
    const queries = [];
    const dbPool = { query: async (sql, p) => { queries.push({ sql, p }); return { rows: [] }; } };
    const sockets = [];
    const wsFactory = () => { const h = {}; const ws = { readyState: 1, sent: [], on: (e, fn) => { h[e] = fn; }, send: m => ws.sent.push(m), ping() {}, close: () => {}, h }; sockets.push(ws); return ws; };
    let clock = Date.UTC(2026, 9, 28, 10, 0);                                         // Wed 28 Oct 15:30 IST (closing minutes)
    const lab = L.createTickFlowLab({ dbPool, now: () => clock, log: () => {}, env: { TICKFLOW_LAB: 'true', ANGEL_API_KEY: 'k', ANGEL_CLIENT_ID: 'c' }, wsFactory, fetchScrip: async () => scrip, bootDelayMs: 0 });
    await lab.start();
    lab._handleMessage(pkt({ token: '1', ltp: 22775, vol: 1000 }), clock);
    lab._handleMessage(pkt({ token: '1', ltp: 22775.05, vol: 1075, ltq: 75, bid: 22775, ask: 22775.1 }), clock + 1000);   // yesterday's last bucket (15:30)
    const yBucketTs = lab._state.bucket.ts;
    // next day 09:14:30 IST = 03:44:30 UTC — first packet of the new day
    clock = Date.UTC(2026, 9, 29, 3, 44, 30);
    lab._handleMessage(pkt({ token: '1', ltp: 22700, vol: 5000 }), clock);
    lab._handleMessage(pkt({ token: '1', ltp: 22700.05, vol: 5100, ltq: 100, bid: 22700, ask: 22700.1 }), clock + 1000);
    const st = lab._state;
    assert.strictEqual(st.day, '2026-10-29');
    assert(!st.today.some(b => b.ts === yBucketTs), 'yesterday bucket must not be in today list');
    assert(st.bucket.ts !== yBucketTs && st.bucket.ts >= Date.UTC(2026, 9, 29, 3, 44), 'current bucket is today minute');
    assert(st.pending.some(b => b.ts === yBucketTs) || queries.some(q => /INSERT INTO tickflow_lab_min/.test(q.sql)), 'yesterday bucket still goes to DB');
    await new Promise(r => setTimeout(r, 30));
    const card = lab.livePayload();
    assert(card && card.success);
    assert(!card.bars.some(b => b.label === '15:30'), 'no stray 15:30 bar on the morning card');
    // pure guard: other-day minutes are ignored by mergeLiveCard
    const mk = (ts, vol) => ({ ts, ticks: 5, events: 5, vol, ltqSum: vol, buyTick: 0, sellTick: 0, unTick: 0, buyQ: vol, sellQ: 0, unQ: 0, qByQuote: vol, o: 1, h: 1, l: 1, c: 1, spreadSum: 0, spreadN: 0 });
    const p2 = L.mergeLiveCard({ dbRows: [], todayBuckets: [mk(yBucketTs, 50), mk(Date.UTC(2026, 9, 29, 3, 45), 70)], current: null, day: '2026-10-29', symbol: 'X' });
    assert.deepStrictEqual(p2.bars.map(b => b.label), ['09:15']); assert.strictEqual(p2.bars[0].vol, 70);
    lab.stop();
    console.log('tickFlowLab day-rollover OK');
})().catch(e => { console.error(e); process.exit(1); });
