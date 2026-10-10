'use strict';
// ── Auto Journal (10 Oct 2026) ───────────────────────────────────────────────────────────────────────────────────────────
// Every signal the app fires (the same *_log trigger tables the Track Record uses) is logged AUTOMATICALLY as a PAPER trade:
//   entry  = the ATM strike (nearest strike to the underlying price at fire) at the option-chain premium at that moment
//   manage = the app's own Trade-Coach grid for that instrument (SL -> breakeven lock -> half book -> full target) + time stop,
//            plus an optional TRAILING stop on the remaining half after the half-book (AUTO_JOURNAL_TRAIL_PTS, 0 = off)
// Nothing here places a real order or touches the manual journal (journal_trades). It is a separate table: auto_journal_trades.
// HONEST LIMITS (also shown in the UI): premiums come from the app's option chain, which refreshes about once a minute, so a stop/target is
// executed at the first premium seen beyond the level (it can overshoot); no spread/slippage/brokerage is modelled; a signal that arrives
// while the chain has no quote for the strike is skipped (and counted), not guessed.

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const r2 = v => v === null ? null : Math.round(v * 100) / 100;

// ── exit engine (same rules as simulateTradeCoachCore in server.js; kept here so this module has no dependencies) ──
function coachInit(entry, grid, lots) {
    const g = grid || {};
    return { entry, slPct: g.slPct ?? -20, breakevenAt: g.breakevenAt ?? 20, halfBookAt: g.halfBookAt ?? 30, fullExitAt: g.fullExitAt ?? 40,
        slLevelPct: g.slPct ?? -20, halfBooked: false, canSplit: lots >= 2, peakPct: 0 };
}
// returns { actions:[{type:'EXIT_ALL',reason}|{type:'BOOK_HALF'}|{type:'MOVE_SL_TO_BE'}], pct }
function coachStep(st, premium, ageMs, o = {}) {
    const pct = ((premium - st.entry) / st.entry) * 100, actions = [];
    if (pct > st.peakPct) st.peakPct = pct;
    if (pct <= st.slLevelPct) return { actions: [{ type: 'EXIT_ALL', reason: st.slLevelPct === 0 ? 'breakeven_stop' : 'stop_loss' }], pct };
    if (pct >= st.fullExitAt) return { actions: [{ type: 'EXIT_ALL', reason: 'full_target' }], pct };
    // trailing stop on the remainder, only after the half-book. It can only RAISE the stop, never lower it.
    if (o.trailPts > 0 && st.halfBooked && pct <= st.peakPct - o.trailPts && pct > st.slLevelPct) return { actions: [{ type: 'EXIT_ALL', reason: 'trail_stop' }], pct };
    if (o.timeStopMs && ageMs >= o.timeStopMs) return { actions: [{ type: 'EXIT_ALL', reason: 'time_exit' }], pct };
    if (st.canSplit && !st.halfBooked && pct >= st.halfBookAt) { st.halfBooked = true; actions.push({ type: 'BOOK_HALF' }); }
    if (st.slLevelPct === st.slPct && pct >= st.breakevenAt) { st.slLevelPct = 0; actions.push({ type: 'MOVE_SL_TO_BE' }); }
    return { actions, pct };
}

// The stop level currently protecting the trade, in % from entry (the higher of the fixed/BE stop and the trail).
function effectiveStopPct(st, trailPts) {
    let s = st.slLevelPct;
    if (trailPts > 0 && st.halfBooked) s = Math.max(s, st.peakPct - trailPts);
    return s;
}

// ── time windows (IST) ──
const istParts = ms => { const d = new Date(ms + 330 * 60000); return { day: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() }; };
const WINDOWS = {   // minutes of the IST day. entryEnd: no NEW entries after it. squareOff: everything still open is closed.
    NIFTY: { start: 9 * 60 + 15, entryEnd: 15 * 60, squareOff: 15 * 60 + 20, weekdaysOnly: true },
    CRUDE: { start: 9 * 60, entryEnd: 23 * 60, squareOff: 23 * 60 + 20, weekdaysOnly: true },
    BITCOIN: { start: 0, entryEnd: 24 * 60, squareOff: null, weekdaysOnly: false },
};
function inWindow(inst, ms, which) {
    const w = WINDOWS[inst]; if (!w) return false;
    const t = istParts(ms);
    if (w.weekdaysOnly && (t.dow === 0 || t.dow === 6)) return false;
    return t.minutes >= w.start && t.minutes < (which === 'squareOff' ? (w.squareOff || 24 * 60) : w.entryEnd);
}
const pastSquareOff = (inst, ms) => { const w = WINDOWS[inst]; if (!w || !w.squareOff) return false; const t = istParts(ms); return t.minutes >= w.squareOff; };

// ── P&L bookkeeping ──
// exits: [{ premium, frac (fraction of the original position), reason, ts }]
function pnlOf(entry, exits, lots, lotSize) {
    let pct = 0, rs = 0;
    for (const e of exits) { pct += ((e.premium - entry) / entry) * 100 * e.frac; rs += (e.premium - entry) * e.frac * lots * (lotSize || 0); }
    return { pct: r2(pct), rs: lotSize ? Math.round(rs) : null };
}

// ── summaries for the Journal tab (pure) ──
function summarize(rows) {
    const groups = new Map();
    for (const r of rows) {
        const key = `${r.instrument}|${r.source}`;
        if (!groups.has(key)) groups.set(key, { key, instrument: r.instrument, source: r.source, muted: !!r.muted, trades: [] });
        const g = groups.get(key); g.trades.push(r); if (r.muted) g.muted = true;
    }
    const out = [];
    for (const g of groups.values()) {
        const closed = g.trades.filter(t => t.state === 'CLOSED'), open = g.trades.filter(t => t.state === 'OPEN');
        const wins = closed.filter(t => t.realized_pct > 0);
        const sum = a => a.reduce((x, y) => x + (Number(y) || 0), 0);
        const rsKnown = closed.filter(t => t.realized_rs !== null && t.realized_rs !== undefined);
        out.push({ key: g.key, instrument: g.instrument, source: g.source, muted: g.muted, total: g.trades.length, open: open.length, closed: closed.length,
            winPct: closed.length ? Math.round(wins.length / closed.length * 1000) / 10 : null,
            avgPct: closed.length ? r2(sum(closed.map(t => t.realized_pct)) / closed.length) : null,
            totalRs: rsKnown.length ? Math.round(sum(rsKnown.map(t => t.realized_rs))) : null,
            best: closed.length ? Math.max(...closed.map(t => Number(t.realized_pct))) : null, worst: closed.length ? Math.min(...closed.map(t => Number(t.realized_pct))) : null,
            trades: g.trades.sort((a, b) => new Date(b.fire_ts) - new Date(a.fire_ts)) });
    }
    return out.sort((a, b) => (a.instrument === b.instrument ? b.total - a.total : a.instrument < b.instrument ? -1 : 1));
}

// ── the engine ──
function createAutoJournal({ dbPool, sources, lockStrikeAtFire, getStrikePremium, coachGridFor, mutedHas = () => false, now = Date.now, log = () => {}, env = process.env, lotSizes }) {
    const cfg = {
        enabled: String(env.AUTO_JOURNAL || 'on').toLowerCase() !== 'off',
        lots: Math.max(1, parseInt(env.AUTO_JOURNAL_LOTS, 10) || 2),                       // 2 so the half-book can really split
        trailPts: env.AUTO_JOURNAL_TRAIL_PTS === undefined || env.AUTO_JOURNAL_TRAIL_PTS === '' ? 10 : Math.max(0, Number(env.AUTO_JOURNAL_TRAIL_PTS) || 0),
        timeStopMin: Number(env.AUTO_JOURNAL_TIME_STOP_MIN) || 90,
        noDataCloseMin: Number(env.AUTO_JOURNAL_NO_DATA_MIN) || 10,
        maxSignalAgeMin: Number(env.AUTO_JOURNAL_MAX_SIGNAL_AGE_MIN) || 5,
        pollMs: Number(env.AUTO_JOURNAL_POLL_MS) || 10000, tickMs: Number(env.AUTO_JOURNAL_TICK_MS) || 10000,
        lotSizes: lotSizes || { NIFTY: 65, CRUDE: 100, BITCOIN: null },
    };
    const S = { lastIds: new Map(), open: new Map(), timers: [], skipped: { noChain: 0, stale: 0, window: 0 }, started: false, warned: new Set(), ticking: false, polling: false };

    async function ensureTable() {
        await dbPool.query(`CREATE TABLE IF NOT EXISTS auto_journal_trades (
            id SERIAL PRIMARY KEY, source_table TEXT NOT NULL, source_id BIGINT NOT NULL, instrument TEXT, source TEXT, direction TEXT, side TEXT,
            fire_ts TIMESTAMPTZ, logged_ts TIMESTAMPTZ DEFAULT NOW(), strike NUMERIC, chain_id TEXT, underlying NUMERIC, entry_premium NUMERIC,
            lots INT, lot_size INT, grid JSONB, coach JSONB, state TEXT DEFAULT 'OPEN', muted BOOLEAN DEFAULT FALSE, last_premium NUMERIC, last_data_ts TIMESTAMPTZ,
            peak_pct NUMERIC, stop_pct NUMERIC, exits JSONB DEFAULT '[]', events JSONB DEFAULT '[]', exit_reason TEXT, exit_ts TIMESTAMPTZ, realized_pct NUMERIC, realized_rs NUMERIC,
            UNIQUE (source_table, source_id))`);
        await dbPool.query(`CREATE INDEX IF NOT EXISTS auto_journal_state_idx ON auto_journal_trades (state, fire_ts DESC)`);
    }

    const watched = () => sources.filter(s => s.instrument === 'NIFTY' || s.instrument === 'CRUDE' || s.instrument === 'BITCOIN');
    async function primeIds() {
        for (const s of watched()) {
            try { const r = await dbPool.query(`SELECT COALESCE(MAX(id),0)::bigint AS m FROM ${s.table} WHERE ts < NOW() - INTERVAL '3 minutes'`); S.lastIds.set(s.table, Number(r.rows[0].m)); }
            catch (e) { if (!S.warned.has(s.table)) { S.warned.add(s.table); log(`[AutoJournal] cannot read ${s.table}: ${e.message}`); } }
        }
    }
    const save = async (t) => {
        await dbPool.query(`UPDATE auto_journal_trades SET state=$2, coach=$3, last_premium=$4, last_data_ts=$5, peak_pct=$6, stop_pct=$7, exits=$8, events=$9, exit_reason=$10, exit_ts=$11, realized_pct=$12, realized_rs=$13 WHERE id=$1`,
            [t.id, t.state, JSON.stringify(t.coach), t.lastPremium, t.lastDataTs ? new Date(t.lastDataTs) : null, t.coach.peakPct, t.stopPct, JSON.stringify(t.exits), JSON.stringify(t.events.slice(-40)), t.exitReason || null,
                t.exitTs ? new Date(t.exitTs) : null, t.realizedPct ?? null, t.realizedRs ?? null]).catch(e => log(`[AutoJournal] save failed: ${e.message}`));
    };
    const ev = (t, msg) => t.events.push({ at: new Date(now()).toISOString(), msg });

    function closeTrade(t, premium, reason) {
        const frac = 1 - t.exits.reduce((a, e) => a + e.frac, 0);
        if (frac > 1e-9) t.exits.push({ premium, frac: r2(frac), reason, ts: now() });
        const p = pnlOf(t.entry, t.exits, t.lots, t.lotSize);
        t.state = 'CLOSED'; t.exitReason = reason; t.exitTs = now(); t.realizedPct = p.pct; t.realizedRs = p.rs; t.lastPremium = premium;
        ev(t, `CLOSED @ ${premium} (${reason}) → ${p.pct}%${p.rs !== null ? ' / ' + p.rs + ' Rs' : ''}`);
        S.open.delete(t.id);
    }

    // a new signal row -> paper entry
    async function onSignal(s, row) {
        const direction = String(row.direction || '').toUpperCase();
        if (direction !== 'BULLISH' && direction !== 'BEARISH') return;
        const tsMs = new Date(row.ts).getTime(), price = num(row.price);
        if (!(price > 0)) return;
        if (now() - tsMs > cfg.maxSignalAgeMin * 60000) { S.skipped.stale++; return; }
        if (!inWindow(s.instrument, tsMs, 'entry')) { S.skipped.window++; return; }
        const lock = lockStrikeAtFire(s.instrument, direction, price);
        if (!lock || !(lock.premium > 0)) { S.skipped.noChain++; log(`[AutoJournal] skip ${s.instrument}|${s.source}: no strike/premium in chain`); return; }
        const grid = coachGridFor(s.instrument), lotSize = cfg.lotSizes[s.instrument] ?? null, muted = !!mutedHas(`${s.instrument}|${s.source}`);
        const coach = coachInit(lock.premium, grid, cfg.lots);
        const ins = await dbPool.query(`INSERT INTO auto_journal_trades (source_table, source_id, instrument, source, direction, side, fire_ts, strike, chain_id, underlying, entry_premium, lots, lot_size, grid, coach, muted, last_premium, last_data_ts, peak_pct, stop_pct, events)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$11,NOW(),0,$17,$18) ON CONFLICT (source_table, source_id) DO NOTHING RETURNING id`,
            [s.table, row.id, s.instrument, s.source, direction, direction === 'BULLISH' ? 'CE' : 'PE', new Date(tsMs), lock.strike, lock.chainId || null, price, lock.premium, cfg.lots, lotSize, JSON.stringify(grid), JSON.stringify(coach), muted, grid.slPct ?? -20,
                JSON.stringify([{ at: new Date(now()).toISOString(), msg: `ENTRY ${lock.strike} ${direction === 'BULLISH' ? 'CE' : 'PE'} @ ${lock.premium} (underlying ${price}) · SL ${grid.slPct}% · BE +${grid.breakevenAt}% · half +${grid.halfBookAt}% · target +${grid.fullExitAt}%${muted ? ' · strategy currently auto-muted' : ''}` }])]);
        if (!ins.rows.length) return;
        S.open.set(ins.rows[0].id, { id: ins.rows[0].id, instrument: s.instrument, source: s.source, direction, strike: lock.strike, chainId: lock.chainId || null, entry: lock.premium, lots: cfg.lots, lotSize, coach, grid,
            openedAt: now(), lastPremium: lock.premium, lastDataTs: now(), stopPct: grid.slPct ?? -20, exits: [], events: [], state: 'OPEN' });
        log(`📔 [AutoJournal] ${s.instrument}|${s.source} ${direction} → ${lock.strike} ${direction === 'BULLISH' ? 'CE' : 'PE'} @ ${lock.premium}`);
    }

    async function pollSignals() {
        if (S.polling) return; S.polling = true;
        try {
            for (const s of watched()) {
                if (!S.lastIds.has(s.table)) continue;
                if (!inWindow(s.instrument, now(), 'entry') && s.instrument !== 'BITCOIN') continue;   // nothing can be entered now -> do not even query
                let rows;
                try {
                    const where = s.whereExtra ? `AND ${s.whereExtra}` : '';
                    rows = (await dbPool.query(`SELECT id, ts, ${s.priceExpr} AS price, ${s.dirExpr} AS direction FROM ${s.table} WHERE id > $1 ${where} ORDER BY id ASC LIMIT 20`, [S.lastIds.get(s.table)])).rows;
                } catch (e) { if (!S.warned.has(s.table)) { S.warned.add(s.table); log(`[AutoJournal] poll ${s.table} failed: ${e.message}`); } continue; }
                for (const r of rows) {
                    S.lastIds.set(s.table, Math.max(S.lastIds.get(s.table), Number(r.id)));
                    try { await onSignal(s, r); } catch (e) { log(`[AutoJournal] entry error ${s.table}#${r.id}: ${e.message}`); }
                }
            }
        } finally { S.polling = false; }
    }

    async function tick() {
        if (S.ticking) return; S.ticking = true;
        try {
            for (const t of [...S.open.values()]) {
                try {
                    const prem = getStrikePremium(t.instrument, t.direction, t.strike, t.chainId);
                    if (prem > 0) { t.lastPremium = prem; t.lastDataTs = now(); }
                    if (pastSquareOff(t.instrument, now()) && t.lastPremium > 0) { closeTrade(t, t.lastPremium, 'eod_exit'); await save(t); continue; }
                    if (!(prem > 0)) {
                        if (now() - t.lastDataTs > cfg.noDataCloseMin * 60000) { closeTrade(t, t.lastPremium, 'no_data'); await save(t); }
                        continue;
                    }
                    const res = coachStep(t.coach, prem, now() - t.openedAt, { timeStopMs: cfg.timeStopMin * 60000, trailPts: cfg.trailPts });
                    let changed = false;
                    for (const a of res.actions) {
                        if (a.type === 'EXIT_ALL') { closeTrade(t, prem, a.reason); changed = true; break; }
                        if (a.type === 'MOVE_SL_TO_BE') { ev(t, `+${r2(res.pct)}% → stop moved to breakeven`); changed = true; }
                        if (a.type === 'BOOK_HALF') {
                            const sellLots = Math.floor(t.lots / 2), frac = sellLots / t.lots;
                            t.exits.push({ premium: prem, frac, reason: 'half_book', ts: now() });
                            ev(t, `+${r2(res.pct)}% → half booked (${sellLots} of ${t.lots} lots) @ ${prem}`); changed = true;
                        }
                    }
                    const sp = effectiveStopPct(t.coach, cfg.trailPts);
                    if (t.state === 'OPEN' && (sp !== t.stopPct)) { if (sp > t.stopPct && t.coach.halfBooked && cfg.trailPts > 0 && sp > t.coach.slLevelPct) ev(t, `trailing stop raised to ${r2(sp)}%`); t.stopPct = sp; changed = true; }
                    if (changed || now() - (t.lastSaved || 0) > 60000) { t.lastSaved = now(); await save(t); }
                } catch (e) { log(`[AutoJournal] tick error #${t.id}: ${e.message}`); }
            }
        } finally { S.ticking = false; }
    }

    async function restoreOpen() {
        const r = await dbPool.query(`SELECT * FROM auto_journal_trades WHERE state='OPEN'`);
        for (const row of r.rows) {
            S.open.set(row.id, { id: row.id, instrument: row.instrument, source: row.source, direction: row.direction, strike: Number(row.strike), chainId: row.chain_id, entry: Number(row.entry_premium), lots: row.lots, lotSize: row.lot_size,
                coach: row.coach, grid: row.grid, openedAt: new Date(row.fire_ts).getTime(), lastPremium: Number(row.last_premium) || Number(row.entry_premium), lastDataTs: now(), stopPct: Number(row.stop_pct), exits: row.exits || [], events: row.events || [], state: 'OPEN' });
        }
        if (r.rows.length) log(`[AutoJournal] restored ${r.rows.length} open paper trade(s)`);
    }

    async function start() {
        if (S.started) return;
        if (!cfg.enabled) { log('[AutoJournal] AUTO_JOURNAL=off — not started'); return; }
        if (!dbPool) { log('[AutoJournal] no database — not started'); return; }
        await ensureTable(); await restoreOpen(); await primeIds();
        S.timers.push(setInterval(() => { pollSignals().catch(e => log(`[AutoJournal] poll error: ${e.message}`)); }, cfg.pollMs));
        S.timers.push(setInterval(() => { tick().catch(e => log(`[AutoJournal] tick error: ${e.message}`)); }, cfg.tickMs));
        S.started = true; log(`📔 [AutoJournal] started — ${cfg.lots} lots/trade, trail ${cfg.trailPts} pts after half-book, time stop ${cfg.timeStopMin} min`);
    }
    function stop() { S.timers.forEach(clearInterval); S.timers = []; S.started = false; }

    // data for the Journal tab
    async function report({ days = 14 } = {}) {
        if (!dbPool) return { enabled: cfg.enabled, started: S.started, strategies: [] };
        const d = Math.min(90, Math.max(1, parseInt(days, 10) || 14));
        const r = await dbPool.query(`SELECT id, instrument, source, direction, side, fire_ts, strike, underlying, entry_premium, lots, lot_size, state, muted, last_premium, peak_pct, stop_pct, exits, events, exit_reason, exit_ts, realized_pct, realized_rs, coach
            FROM auto_journal_trades WHERE fire_ts >= NOW() - ($1::int * INTERVAL '1 day') ORDER BY fire_ts DESC LIMIT 3000`, [d]);
        const rows = r.rows.map(x => {
            const open = x.state === 'OPEN', entry = Number(x.entry_premium), last = Number(x.last_premium);
            const exits = x.exits || [];
            let livePct = null, liveRs = null;
            if (open && entry > 0 && last > 0) { const fracLeft = 1 - exits.reduce((a, e) => a + e.frac, 0); const p = pnlOf(entry, [...exits, { premium: last, frac: fracLeft }], x.lots, x.lot_size); livePct = p.pct; liveRs = p.rs; }
            const stopPrem = entry > 0 ? r2(entry * (1 + Number(x.stop_pct) / 100)) : null;
            const tgtPrem = x.coach && entry > 0 ? r2(entry * (1 + x.coach.fullExitAt / 100)) : null;
            return { ...x, strike: Number(x.strike), entry_premium: entry, last_premium: last || null, realized_pct: x.realized_pct === null ? null : Number(x.realized_pct), realized_rs: x.realized_rs === null ? null : Number(x.realized_rs),
                livePct, liveRs, stopPrem, tgtPrem, halfBooked: !!(x.coach && x.coach.halfBooked), coach: undefined };
        });
        return { enabled: cfg.enabled, started: S.started, config: { lots: cfg.lots, trailPts: cfg.trailPts, timeStopMin: cfg.timeStopMin }, skipped: S.skipped, days: d, strategies: summarize(rows) };
    }

    return { cfg, start, stop, report, pollSignals, tick, _state: S };
}

module.exports = { createAutoJournal, coachInit, coachStep, effectiveStopPct, pnlOf, summarize, inWindow, pastSquareOff, WINDOWS };