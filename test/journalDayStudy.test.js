'use strict';
const assert = require('assert');
const J = require('../src/utils/journalDayStudy');

// IST time -> UTC ISO on 2026-10-12
const at = (hh, mm) => new Date(Date.UTC(2026, 9, 12, hh, mm) - 330 * 60000).toISOString();
assert.strictEqual(J.istClock(new Date(at(10, 12)).getTime()), '10:12');
assert.strictEqual(J.bucketOf(9 * 60 + 29), 'before 10:00');
assert.strictEqual(J.bucketOf(12 * 60), '12:00-14:00');

// synthetic falling day: 22600 -> 22400, 5-min snapshots with a bounce 11:40-12:20
const snaps = []; let p = 22600;
for (let m = 9 * 60 + 20; m <= 15 * 60; m += 5) {
    const hh = Math.floor(m / 60), mm = m % 60;
    if (m < 11 * 60 + 40) p -= 2; else if (m < 12 * 60 + 20) p += 3; else p -= 3;
    snaps.push({ ts: at(hh, mm), nifty: p, day_high: 22620, day_low: p - 10, vwap_dist_pct: -0.2, mtf_signal: 'BUY PUT', mtf_5m_adx: 24, mtf_15m_adx: 30, mtf_1h_adx: 20, pcr: 0.84, signal: 'WAIT' });
}
const spotAt = (hh, mm) => snaps.find(s => s.ts === at(hh, mm)).nifty;
const trades = [
    { id: 1, source: 'MTF', direction: 'BEARISH', side: 'PE', strike: 22400, fire_ts: at(11, 45), exit_ts: at(12, 12), state: 'CLOSED', entry_premium: 89.3, underlying: spotAt(11, 45), realized_pct: -17.7, exit_reason: 'Stop-loss' },
    { id: 2, source: 'Murarka', direction: 'BEARISH', side: 'PE', strike: 22400, fire_ts: at(12, 45), exit_ts: at(13, 30), state: 'CLOSED', entry_premium: 87.4, underlying: spotAt(12, 45), realized_pct: 14, exit_reason: 'Trailing stop' },
    { id: 3, source: 'MTF', direction: 'BEARISH', side: 'PE', strike: 22400, fire_ts: at(13, 10), exit_ts: null, state: 'OPEN', entry_premium: 90, underlying: spotAt(13, 10), realized_pct: null, exit_reason: null },
    { id: 4, source: 'MTF', direction: 'BULLISH', side: 'CE', strike: 22600, fire_ts: at(9, 29), exit_ts: at(10, 20), state: 'CLOSED', entry_premium: 88.1, underlying: spotAt(9, 30), realized_pct: -17.1, exit_reason: 'Stop-loss' },
];
const st = J.runJournalDayStudy(trades, snaps);
assert.strictEqual(st.trades.length, 4);
const by = id => st.trades.find(t => t.id === id);

// clusters: trades 2 and 3 are same strike+direction within 90 min -> one cluster; 1 is 58 min before 2 -> same cluster too (chain)
assert.strictEqual(by(2).cluster, by(3).cluster);
assert.strictEqual(by(1).cluster, by(2).cluster);
assert.notStrictEqual(by(4).cluster, by(1).cluster);

// trade 1: PE at 11:45 (bounce period) -> spot rose while we held, so MAE negative, MFE ~0; after exit the market resumed falling (+)
assert.ok(by(1).maePts < 0, 'bounce is adverse for a PE');
assert.ok(by(1).afterPts[60] > 0, 'market went our way after the stop');
// direction sign: CE with a falling market has negative excursion and the study treats BULLISH as +1
assert.ok(by(4).maePts < 0);
// open trade has no exit data, but entry data present
assert.strictEqual(by(3).exitSpot, null);
assert.strictEqual(by(3).state, 'OPEN');
// rangeDone for a PE = (high - spot)/(high - low); here low = spot-10 so range = high - spot + 10
const t2 = by(2); const sp = spotAt(12, 45); assert.strictEqual(t2.rangeDoneAtEntry, Math.round(((22620 - sp) / (22620 - (sp - 10))) * 100) / 100);

// summary
assert.strictEqual(st.summary.closed, 3); assert.strictEqual(st.summary.open, 1);
assert.strictEqual(st.summary.wins.n, 1); assert.strictEqual(st.summary.losses.n, 2);
assert.strictEqual(st.summary.byBucket['before 10:00'].n, 1);

// text renders and carries the caution
const txt = J.formatJournalDayText(st, '2026-10-12');
assert.ok(/READ WITH CARE/.test(txt) && /WINNERS/.test(txt) && /LOSERS/.test(txt));
// empty day
assert.ok(/No Auto Journal trades/.test(J.formatJournalDayText(J.runJournalDayStudy([], []), '2026-10-11')));
// missing snapshots must not throw
const st2 = J.runJournalDayStudy(trades, []); assert.strictEqual(st2.trades.length, 4); assert.strictEqual(st2.trades[0].maePts, null);

// ── multi-day ──────────────────────────────────────────────────────────────────────────────────────────────────────
const atD = (day, hh, mm) => new Date(Date.UTC(2026, 9, day, hh, mm) - 330 * 60000).toISOString();
function mkSnaps(day, start, step, mtf) {
    const out = []; let q = start;
    for (let m = 9 * 60 + 20; m <= 15 * 60; m += 5) { q += step; out.push({ ts: atD(day, Math.floor(m / 60), m % 60), nifty: q, day_high: start + 20, day_low: start - 200, vwap_dist_pct: 0, mtf_signal: mtf, mtf_5m_adx: 22, mtf_15m_adx: 25, mtf_1h_adx: 20, pcr: 0.9, signal: 'WAIT' }); }
    return out;
}
const snapsM = [...mkSnaps(9, 22600, -2, 'BUY PUT'), ...mkSnaps(12, 22400, 0.0, 'BUY PUT'), ...mkSnaps(13, 22400, 2, 'BUY CALL')];   // down day, flat day, up day
const mt = (id, day, hh, mm, dir, side, strike, res, reason, exitH, exitM) => ({ id, source: 'MTF', direction: dir, side, strike, fire_ts: atD(day, hh, mm), exit_ts: atD(day, exitH, exitM), state: 'CLOSED', entry_premium: 90, underlying: 22400, realized_pct: res, exit_reason: reason });
const tm = [
    mt(1, 9, 10, 0, 'BEARISH', 'PE', 22400, -16, 'stop_loss', 10, 30),     // with the down day
    mt(2, 9, 10, 20, 'BEARISH', 'PE', 22400, 20, 'full_target', 11, 0),    // same bet (cluster) as #1
    mt(3, 9, 12, 0, 'BULLISH', 'CE', 22600, -15, 'stop_loss', 12, 40),     // against the down day, opposite to BUY PUT
    mt(4, 12, 11, 0, 'BEARISH', 'PE', 22400, 10, 'trail_stop', 12, 0),     // flat day
    mt(5, 13, 11, 0, 'BULLISH', 'CE', 22400, 12, 'trail_stop', 12, 0),     // with the up day
    mt(6, 13, 13, 0, 'BEARISH', 'PE', 22300, -17, 'stop_loss', 13, 40),    // against the up day, opposite to BUY CALL
];
const ms = J.runJournalMultiDay(tm, snapsM);
assert.strictEqual(ms.days.length, 3);
assert.deepStrictEqual(ms.days.map(d => d.dayType), ['DOWN', 'FLAT', 'UP']);
assert.strictEqual(ms.trades.length, 6);
// clusters are per day: #1 and #2 are one bet; #4 and #5 never merge across days even with equal strike/direction
assert.strictEqual(ms.trades.find(t => t.id === 1).cluster, ms.trades.find(t => t.id === 2).cluster);
assert.notStrictEqual(ms.trades.find(t => t.id === 4).cluster, ms.trades.find(t => t.id === 1).cluster);
assert.strictEqual(ms.pooled.n, 6); assert.strictEqual(ms.pooled.clusters, 5);
assert.strictEqual(ms.slices.dayDirection.withDay.n, 3); assert.strictEqual(ms.slices.dayDirection.againstDay.n, 2); assert.strictEqual(ms.slices.dayDirection.flatDay.n, 1);
assert.strictEqual(ms.slices.counterMtf.counter.n, 2); assert.strictEqual(ms.slices.counterMtf.other.n, 4);
assert.strictEqual(ms.slices.counterMtf.counter.wins, 0);
assert.strictEqual(ms.slices.wobbleStops.stops, 3);
assert.ok(ms.pooled.thin, 'six trades is thin');
// per-bet averaging: bet {1,2} = (-16+20)/2 = +2 -> counted as one winning bet
assert.strictEqual(ms.days[0].clusters, 2); assert.strictEqual(ms.days[0].clusterWins, 1);
const mtx = J.formatJournalMultiDayText(ms, '2026-10-09', '2026-10-13');
assert.ok(/MULTI-DAY/.test(mtx) && /AUDIT QUESTIONS/.test(mtx) && /thin/.test(mtx) && /NOT included/.test(mtx) && /DOWN/.test(mtx) && /UP/.test(mtx));
// empty / no snapshots never throw
assert.ok(/No Auto Journal/.test(J.formatJournalMultiDayText(J.runJournalMultiDay([], []), 'a', 'b')));
assert.strictEqual(J.runJournalMultiDay(tm, []).trades.length, 6);
assert.strictEqual(J.istDateOf(new Date(atD(9, 0, 10)).getTime()), '2026-10-09');
console.log('journalDayStudy tests passed');