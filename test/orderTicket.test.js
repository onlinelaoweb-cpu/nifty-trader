'use strict';
const assert = require('assert');
const T = require('../src/utils/orderTicket');

assert.strictEqual(T.LIVE_ORDERING_ENABLED, false);
const base = { optionType: 'CE', strike: 25000, lots: 2, orderType: 'LIMIT', entryPrice: 100, slPrice: 80, targetPrice: 140 };

// good ticket: numbers
const r = T.buildTicket(base, { lotSize: 65 });
assert.strictEqual(r.ok, true); assert.strictEqual(r.liveOrderingEnabled, false);
const t = r.ticket;
assert.strictEqual(t.mode, 'DRY_RUN'); assert.strictEqual(t.sent, false);
assert.strictEqual(t.quantity, 130);
assert.strictEqual(t.risk.maxLossRs, 2600); assert.strictEqual(t.risk.targetProfitRs, 5200); assert.strictEqual(t.risk.rr, 2);
assert.deepStrictEqual(t.stopLoss, { orderType: 'SL-LIMIT', trigger: 80, limit: 78.4, side: 'SELL' });
assert.deepStrictEqual(t.target, { orderType: 'LIMIT', price: 140, side: 'SELL' });
assert.strictEqual(t.entry.price, 100);

// percent inputs + tick rounding
const p = T.buildTicket({ ...base, slPrice: '', targetPrice: '', slPct: 20, targetPct: 40, entryPrice: 123.37 });
assert.strictEqual(p.ok, true); assert.strictEqual(p.ticket.stopLoss.trigger, 98.7); assert.strictEqual(p.ticket.target.price, 172.7);
// absolute price wins over percent
assert.strictEqual(T.buildTicket({ ...base, slPct: 50 }).ticket.stopLoss.trigger, 80);

// MARKET order: entry price field 0 + warning
const m = T.buildTicket({ ...base, orderType: 'MARKET' });
assert.strictEqual(m.ok, true); assert.strictEqual(m.ticket.entry.price, 0); assert(m.warnings.some(w => /MARKET/.test(w)));

// hard validation errors
const bad = x => T.buildTicket({ ...base, ...x });
assert.strictEqual(bad({ optionType: 'XX' }).ok, false);
assert.strictEqual(bad({ strike: 25025 }).ok, false);
assert.strictEqual(bad({ lots: 0 }).ok, false); assert.strictEqual(bad({ lots: 1.5 }).ok, false); assert.strictEqual(bad({ lots: 11 }).ok, false);
assert.strictEqual(bad({ entryPrice: 0 }).ok, false); assert.strictEqual(bad({ entryPrice: '' }).ok, false);
assert.strictEqual(bad({ slPrice: 100 }).ok, false); assert.strictEqual(bad({ slPrice: 120 }).ok, false);     // SL must be below entry
assert.strictEqual(bad({ targetPrice: 100 }).ok, false); assert.strictEqual(bad({ targetPrice: 90 }).ok, false); // target above entry
assert.strictEqual(bad({ slPrice: '', slPct: '' }).ok, false);
assert.strictEqual(bad({ expiry: '25-10-2026' }).ok, false); assert.strictEqual(bad({ expiry: '2026-10-20' }).ok, true);
assert.strictEqual(bad({ orderType: 'STOP' }).ok, false);
assert.strictEqual(T.buildTicket(null).ok, false); assert.strictEqual(T.buildTicket({}).ok, false);

// warnings (not errors)
const w = T.buildTicket({ ...base, targetPrice: 110 }); assert.strictEqual(w.ok, true); assert(w.warnings.some(x => /Reward:Risk/.test(x)));
const deep = T.buildTicket({ ...base, slPrice: 30 }); assert.strictEqual(deep.ok, true); assert(deep.warnings.some(x => /aadha/.test(x)));

// a sell/short can never be built: there is no side input
assert.strictEqual(T.buildTicket({ ...base, side: 'SELL' }).ticket.side, 'BUY');

// ── T1/T2/T3 ladder (1+2+3 lots), trailing, time stop ──
const L = { optionType: 'CE', strike: 25000, orderType: 'LIMIT', entryPrice: 100, slPct: 20, trailMode: 'STEP', timeStop: '15:10',
  targets: [{ pct: 20, lots: 1 }, { pct: 30, lots: 2 }, { pct: 40, lots: 3 }] };
const lr = T.buildTicket(L); assert(lr.ok, JSON.stringify(lr.errors));
const lt = lr.ticket;
assert.strictEqual(lt.lots, 6); assert.strictEqual(lt.quantity, 6 * 65);                      // total lots blank -> sum
assert.deepStrictEqual(lt.targets.map(x => [x.price, x.lots, x.quantity]), [[120, 1, 65], [130, 2, 130], [140, 3, 195]]);
assert.strictEqual(lt.stopLoss.trigger, 80);
assert.strictEqual(lt.risk.maxLossRs, 20 * 390); assert.strictEqual(lt.risk.targetProfitRs, 20 * 65 + 30 * 130 + 40 * 195);
assert.strictEqual(lt.timeStop.at, '15:10'); assert.strictEqual(lt.managedByApp, true); assert.strictEqual(lt.sent, false);
// scenarios: SL, T1 (rest at entry), T1+T2 (rest at T1), all
assert.deepStrictEqual(lt.scenarios.map(x => x.rs), [-7800, 1300, 1300 + 3900 + 3 * 65 * 20, 1300 + 3900 + 7800]);
// POINTS trail never drops below the original SL and is flagged worst-case
const pt = T.buildTicket({ ...L, trailMode: 'POINTS', trailPoints: 50 }); assert(pt.ok);
assert(pt.ticket.scenarios[1].rs >= -7800);
assert.strictEqual(T.buildTicket({ ...L, trailMode: 'POINTS' }).ok, false);                   // points missing
// lots must add up when total is given; at most 3 targets; ordering; cap
assert.strictEqual(T.buildTicket({ ...L, lots: 5 }).ok, false); assert.strictEqual(T.buildTicket({ ...L, lots: 6 }).ok, true);
assert.strictEqual(T.buildTicket({ ...L, targets: [...L.targets, { pct: 50, lots: 1 }] }).ok, false);
assert.strictEqual(T.buildTicket({ ...L, targets: [{ pct: 30, lots: 1 }, { pct: 20, lots: 1 }] }).ok, false);   // T2 below T1
assert.strictEqual(T.buildTicket({ ...L, targets: [{ pct: 20, lots: 5 }, { pct: 30, lots: 6 }] }).ok, false);   // 11 lots > cap
assert.strictEqual(T.buildTicket({ ...L, targets: [{ pct: 20, lots: 0 }] }).ok, false);
assert.strictEqual(T.buildTicket({ ...L, targets: [{ pct: -5, lots: 1 }] }).ok, false);                          // below entry
assert.strictEqual(T.buildTicket({ ...L, timeStop: '25:99' }).ok, false); assert.strictEqual(T.buildTicket({ ...L, trailMode: 'X' }).ok, false);
// single legacy target still works and needs no app management
const one = T.buildTicket({ ...base }); assert(one.ok); assert.strictEqual(one.ticket.targets.length, 1); assert.strictEqual(one.ticket.managedByApp, false);
console.log('orderTicket tests OK');
