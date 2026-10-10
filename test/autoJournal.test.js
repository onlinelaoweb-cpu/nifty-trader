'use strict';
const assert = require('assert');
const J = require('../src/utils/autoJournal');

// ── pure parts ──
const grid = { slPct: -15, breakevenAt: 10, halfBookAt: 15, fullExitAt: 25 };
{   // stop loss
    const st = J.coachInit(100, grid, 2); const r = J.coachStep(st, 84, 0, {});
    assert.deepStrictEqual(r.actions, [{ type: 'EXIT_ALL', reason: 'stop_loss' }]);
}
{   // BE then half then trail
    const st = J.coachInit(100, grid, 2);
    let r = J.coachStep(st, 111, 0, {}); assert.deepStrictEqual(r.actions.map(a => a.type), ['MOVE_SL_TO_BE']);
    r = J.coachStep(st, 116, 0, {}); assert.deepStrictEqual(r.actions.map(a => a.type), ['BOOK_HALF']);
    r = J.coachStep(st, 122, 0, { trailPts: 10 }); assert.deepStrictEqual(r.actions, []);      // peak 22
    assert.strictEqual(J.effectiveStopPct(st, 10), 12);                                          // trail 22-10 = 12 > BE 0
    r = J.coachStep(st, 111, 0, { trailPts: 10 }); assert.deepStrictEqual(r.actions, [{ type: 'EXIT_ALL', reason: 'trail_stop' }]);
}
{   // trail off -> falls to BE stop only
    const st = J.coachInit(100, grid, 2); J.coachStep(st, 116, 0, {}); J.coachStep(st, 122, 0, {});
    assert.deepStrictEqual(J.coachStep(st, 111, 0, { trailPts: 0 }).actions, []);
    assert.deepStrictEqual(J.coachStep(st, 99, 0, { trailPts: 0 }).actions, [{ type: 'EXIT_ALL', reason: 'breakeven_stop' }]);
}
{   // 1 lot cannot split
    const st = J.coachInit(100, grid, 1); assert.deepStrictEqual(J.coachStep(st, 118, 0, {}).actions.map(a => a.type), ['MOVE_SL_TO_BE']);
}
{   // time stop
    const st = J.coachInit(100, grid, 2); assert.deepStrictEqual(J.coachStep(st, 101, 91 * 60000, { timeStopMs: 90 * 60000 }).actions, [{ type: 'EXIT_ALL', reason: 'time_exit' }]);
}
{   // pnl: half at 115, rest at 125, 2 lots x 65
    const p = J.pnlOf(100, [{ premium: 115, frac: 0.5 }, { premium: 125, frac: 0.5 }], 2, 65);
    assert.strictEqual(p.pct, 20); assert.strictEqual(p.rs, Math.round((15 * 0.5 + 25 * 0.5) * 2 * 65));
    assert.strictEqual(J.pnlOf(100, [{ premium: 90, frac: 1 }], 2, null).rs, null);
}
{   // windows (2026-10-12 Mon 10:30 IST = 05:00Z; Sun 11 Oct)
    const mon = Date.UTC(2026, 9, 12, 5, 0), sun = Date.UTC(2026, 9, 11, 5, 0);
    assert(J.inWindow('NIFTY', mon, 'entry')); assert(!J.inWindow('NIFTY', sun, 'entry')); assert(J.inWindow('BITCOIN', sun, 'entry'));
    assert(!J.inWindow('NIFTY', Date.UTC(2026, 9, 12, 9, 40), 'entry'));       // 15:10 IST: past entry end
    assert(J.pastSquareOff('NIFTY', Date.UTC(2026, 9, 12, 9, 51))); assert(!J.pastSquareOff('BITCOIN', mon));
}
{   // summarize
    const rows = [
        { instrument: 'NIFTY', source: 'A', state: 'CLOSED', realized_pct: 10, realized_rs: 650, fire_ts: '2026-10-12T05:00:00Z' },
        { instrument: 'NIFTY', source: 'A', state: 'CLOSED', realized_pct: -5, realized_rs: -300, fire_ts: '2026-10-12T06:00:00Z' },
        { instrument: 'NIFTY', source: 'A', state: 'OPEN', fire_ts: '2026-10-12T07:00:00Z' },
        { instrument: 'BITCOIN', source: 'B', state: 'CLOSED', realized_pct: 4, realized_rs: null, fire_ts: '2026-10-12T05:00:00Z' }];
    const s = J.summarize(rows); const a = s.find(x => x.key === 'NIFTY|A'), b = s.find(x => x.key === 'BITCOIN|B');
    assert.strictEqual(a.total, 3); assert.strictEqual(a.closed, 2); assert.strictEqual(a.open, 1); assert.strictEqual(a.winPct, 50); assert.strictEqual(a.avgPct, 2.5); assert.strictEqual(a.totalRs, 350);
    assert.strictEqual(b.totalRs, null); assert.strictEqual(a.trades[0].state, 'OPEN');
}

// ── engine with an in-memory fake pool ──
(async () => {
    let T = Date.UTC(2026, 9, 12, 5, 0, 0);
    const now = () => T;
    const tbl = []; let prem = 100, nid = 0;
    const db = { query: async (sql, a) => {
        if (/^\s*CREATE/.test(sql)) return { rows: [] };
        if (/INSERT INTO auto_journal_trades/.test(sql)) {
            if (tbl.find(r => r.source_id === a[0])) return { rows: [] };
            const row = { id: ++nid, source_id: a[0], entry: a[9], state: 'OPEN', exits: [] }; tbl.push(row); return { rows: [{ id: row.id }] };
        }
        if (/UPDATE auto_journal_trades/.test(sql)) { const r = tbl.find(x => x.id === a[0]); Object.assign(r, { state: a[1], coach: JSON.parse(a[2]), last_premium: a[3], stop_pct: a[6], exits: JSON.parse(a[7]), exit_reason: a[9], realized_pct: a[11], realized_rs: a[12] }); return { rows: [] }; }
        if (/FROM auto_journal_trades WHERE state='OPEN'/.test(sql)) return { rows: [] };
        return { rows: [] };
    } };
    const logs = [];
    const j = J.createAutoJournal({ dbPool: db, now, log: m => logs.push(m), env: { AUTO_JOURNAL_LOTS: '2', AUTO_JOURNAL_TRAIL_PTS: '10' }, getStrikePremium: () => prem });
    await j.start(); j._state.timers.forEach(clearInterval);
    const adv = async s => { T += s * 1000; await j.tick(); };
    const alert = (over = {}) => Object.assign({ instrument: 'NIFTY', source: 'Fast Momentum', direction: 'BULLISH', lock: { strike: 24500, chainId: null, premium: 100 }, grid, underlying: 24480 }, over);

    assert.strictEqual(await j.logLiveAlert(alert()), true); assert.strictEqual(tbl.length, 1); assert.strictEqual(tbl[0].entry, 100, 'entry equals the alert lock premium');
    assert.strictEqual(await j.logLiveAlert(alert()), false, 'same strategy+direction already open'); assert.strictEqual(j._state.skipped.duplicate, 1);
    assert.strictEqual(await j.logLiveAlert(alert({ direction: 'BEARISH' })), true, 'opposite direction is a separate trade');
    assert.strictEqual(await j.logLiveAlert(alert({ source: 'Brahmastra' })), true, 'other strategy is separate');
    assert.strictEqual(await j.logLiveAlert(alert({ lock: null })), false); assert.strictEqual(j._state.skipped.noChain, 1);
    assert.strictEqual(await j.logLiveAlert(alert({ direction: 'SIDEWAYS' })), false);

    prem = 116; await adv(10); assert.strictEqual(tbl[0].exits.length, 1, 'half booked');
    prem = 122; await adv(10); prem = 110; await adv(10);
    assert.strictEqual(tbl[0].state, 'CLOSED'); assert.strictEqual(tbl[0].exit_reason, 'trail_stop');
    assert.strictEqual(tbl[0].realized_pct, 13);              // 0.5*16 + 0.5*10

    // after it closes, the same strategy can journal again
    prem = 100; assert.strictEqual(await j.logLiveAlert(alert()), true);

    // square-off closes at the last premium; alerts after square-off are not journaled
    T = Date.UTC(2026, 9, 12, 9, 51, 0); await j.tick(); assert.ok(tbl.filter(t => t.state === 'OPEN').length === 0); assert(tbl.some(t => t.exit_reason === 'eod_exit'));
    assert.strictEqual(await j.logLiveAlert(alert({ source: 'Murarka' })), false); assert.strictEqual(j._state.skipped.late, 1);

    // switched off -> nothing logged
    const off = J.createAutoJournal({ dbPool: db, now, log: () => {}, env: { AUTO_JOURNAL: 'off' }, getStrikePremium: () => 1 }); await off.start();
    assert.strictEqual(await off.logLiveAlert(alert()), false);
    console.log('autoJournal tests passed');
})().catch(e => { console.error(e); process.exit(1); });