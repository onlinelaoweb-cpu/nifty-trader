'use strict';
// ── ATR shadow variant (17 Oct 2026) ─────────────────────────────────────────────────────────────────────────────────────
// PURPOSE: test ONE pre-registered idea on NEW data only - "fixed SL/target ignores how volatile the day is; scale it by ATR".
// It is a SHADOW: every NIFTY paper trade in the Auto Journal gets a twin that is managed by a volatility-scaled grid. The real
// journal trade, the Telegram alert and every live rule stay exactly as they are. Nothing here places an order or sends an alert.
//
// PRE-REGISTERED VARIANT (do not tune after seeing results):
//   factor = clamp( ATR_at_entry / reference_ATR , 0.75 , 1.5 )
//   reference_ATR = average entry-ATR of the previous 60 shadow trades (needs >= 10; until then factor = 1 and the row is marked 'no_ref')
//   variant grid  = base grid (SL, breakeven, half-book, target) AND the trail points, each multiplied by factor, rounded to 0.5
//   everything else (time stop, square-off, no-data close, 2 lots, half-book split) is identical to the real journal trade.
// VERDICT RULE (compareRows): only rows with basis 'atr' count; n >= 30 closed pairs; variant avg better than real by >= 2 percentage points;
//   both time halves point the same way. Anything less = "NO EVIDENCE YET" / "NO CLEAR DIFFERENCE". Costs hit both sides equally, so they cancel.
// SCOPE: NIFTY only (crude and Bitcoin have no ATR reading in the app). The premium path of every shadow trade is stored so other rules can be replayed offline.

const { coachInit, coachStep, pnlOf, pastSquareOff } = require('./autoJournal');

const FACTOR_MIN = 0.75, FACTOR_MAX = 1.5, REF_MIN_N = 10, REF_WINDOW = 60, PATH_CAP = 900;
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const r2 = v => v === null ? null : Math.round(v * 100) / 100;
const half = v => Math.round(v * 2) / 2;

// average of the most recent REF_WINDOW positive ATR readings; null when fewer than REF_MIN_N
function refAtr(list) {
    const a = (Array.isArray(list) ? list : []).map(num).filter(v => v !== null && v > 0).slice(-REF_WINDOW);
    if (a.length < REF_MIN_N) return null;
    return a.reduce((x, y) => x + y, 0) / a.length;
}
function computeFactor(atr, ref) {
    const a = num(atr), r = num(ref);
    if (!(a > 0) || !(r > 0)) return { factor: 1, basis: 'no_ref' };
    return { factor: r2(Math.max(FACTOR_MIN, Math.min(FACTOR_MAX, a / r))), basis: 'atr' };
}
function scaleGrid(grid, f) {
    const g = grid || {};
    return { name: 'ATR_SHADOW', slPct: half((g.slPct ?? -20) * f), breakevenAt: half((g.breakevenAt ?? 20) * f), halfBookAt: half((g.halfBookAt ?? 30) * f), fullExitAt: half((g.fullExitAt ?? 40) * f) };
}

// pure: real vs variant, per closed pair. rows: [{ base_pct, var_pct, basis, fire_ts }]
function compareRows(rows, o = {}) {
    const minN = o.minN ?? 30, minDiff = o.minDiffPp ?? 2;
    const pairs = (rows || []).filter(r => r.basis === 'atr' && num(r.base_pct) !== null && num(r.var_pct) !== null)
        .map(r => ({ b: Number(r.base_pct), v: Number(r.var_pct), t: new Date(r.fire_ts).getTime() })).sort((x, y) => x.t - y.t);
    const avg = a => a.length ? r2(a.reduce((x, y) => x + y, 0) / a.length) : null;
    const win = a => a.length ? Math.round(a.filter(x => x > 0).length / a.length * 1000) / 10 : null;
    const stat = ps => ({ n: ps.length, avgReal: avg(ps.map(p => p.b)), avgVariant: avg(ps.map(p => p.v)), winReal: win(ps.map(p => p.b)), winVariant: win(ps.map(p => p.v)),
        worstReal: ps.length ? Math.min(...ps.map(p => p.b)) : null, worstVariant: ps.length ? Math.min(...ps.map(p => p.v)) : null,
        diffPp: ps.length ? r2(avg(ps.map(p => p.v)) - avg(ps.map(p => p.b))) : null });
    const all = stat(pairs), mid = Math.floor(pairs.length / 2), first = stat(pairs.slice(0, mid)), second = stat(pairs.slice(mid));
    const agree = first.diffPp !== null && second.diffPp !== null && Math.sign(first.diffPp) === Math.sign(second.diffPp) && first.diffPp !== 0;
    let verdict;
    if (pairs.length < minN) verdict = `NO EVIDENCE YET (${pairs.length}/${minN} closed pairs)`;
    else if (all.diffPp >= minDiff && agree && first.diffPp > 0) verdict = 'VARIANT BETTER (both halves agree) - still only a paper result, confirm before any change';
    else if (all.diffPp <= -minDiff && agree && first.diffPp < 0) verdict = 'VARIANT WORSE (both halves agree) - keep the fixed grid';
    else verdict = 'NO CLEAR DIFFERENCE - keep the fixed grid';
    return { rule: `factor=clamp(ATR/ref,${FACTOR_MIN},${FACTOR_MAX}); n>=${minN}; diff>=${minDiff}pp; both halves agree`, ...all, halves: { first, second, agree }, verdict };
}

function createAtrShadow({ dbPool, getStrikePremium, now = Date.now, log = () => {}, env = process.env, timeStopMin = 90, trailPts = 10, noDataCloseMin = 10, tickMs = 10000, lots = 2 }) {
    const cfg = { enabled: String(env.ATR_SHADOW || 'on').toLowerCase() !== 'off', timeStopMin, trailPts, noDataCloseMin, tickMs, lots };
    const S = { open: new Map(), atrs: [], timers: [], started: false, ticking: false };

    async function ensureTable() {
        await dbPool.query(`CREATE TABLE IF NOT EXISTS auto_journal_shadow (
            trade_id INT PRIMARY KEY, instrument TEXT, source TEXT, direction TEXT, strike NUMERIC, chain_id TEXT, entry_premium NUMERIC, opened_ts TIMESTAMPTZ,
            atr NUMERIC, ref_atr NUMERIC, factor NUMERIC, basis TEXT, base_grid JSONB, var_grid JSONB, coach JSONB, trail_pts NUMERIC,
            state TEXT DEFAULT 'OPEN', exits JSONB DEFAULT '[]', exit_reason TEXT, exit_ts TIMESTAMPTZ, realized_pct NUMERIC, last_premium NUMERIC, last_data_ts TIMESTAMPTZ, path JSONB DEFAULT '[]')`);
    }
    const save = t => dbPool.query(`UPDATE auto_journal_shadow SET state=$2, coach=$3, exits=$4, exit_reason=$5, exit_ts=$6, realized_pct=$7, last_premium=$8, last_data_ts=$9, path=$10 WHERE trade_id=$1`,
        [t.id, t.state, JSON.stringify(t.coach), JSON.stringify(t.exits), t.exitReason || null, t.exitTs ? new Date(t.exitTs) : null, t.realizedPct ?? null, t.lastPremium,
            t.lastDataTs ? new Date(t.lastDataTs) : null, JSON.stringify(t.path)]).catch(e => log(`[AtrShadow] save failed: ${e.message}`));

    function closeTrade(t, premium, reason) {
        const frac = 1 - t.exits.reduce((a, e) => a + e.frac, 0);
        if (frac > 1e-9) t.exits.push({ premium, frac: r2(frac), reason, ts: now() });
        t.state = 'CLOSED'; t.exitReason = reason; t.exitTs = now(); t.realizedPct = pnlOf(t.entry, t.exits, t.lots, null).pct; t.lastPremium = premium;
        S.open.delete(t.id);
    }

    // called by the Auto Journal right after a real paper trade opens (never throws into it)
    async function open({ id, instrument, source, direction, strike, chainId, entry, grid, atr, openedAt }) {
        if (!cfg.enabled || !S.started || instrument !== 'NIFTY' || !(entry > 0)) return false;
        const ref = refAtr(S.atrs), { factor, basis } = computeFactor(atr, ref);
        if (num(atr) > 0) S.atrs.push(Number(atr));
        if (S.atrs.length > REF_WINDOW * 2) S.atrs = S.atrs.slice(-REF_WINDOW);
        const vg = scaleGrid(grid, factor), tp = half(cfg.trailPts * factor), coach = coachInit(entry, vg, cfg.lots);
        const t = { id, instrument, source, direction, strike: Number(strike), chainId: chainId || null, entry, lots: cfg.lots, coach, trailPts: tp, openedAt: openedAt || now(),
            lastPremium: entry, lastDataTs: now(), exits: [], state: 'OPEN', path: [[0, entry]] };
        await dbPool.query(`INSERT INTO auto_journal_shadow (trade_id, instrument, source, direction, strike, chain_id, entry_premium, opened_ts, atr, ref_atr, factor, basis, base_grid, var_grid, coach, trail_pts, last_premium, last_data_ts, path)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$7,NOW(),$17) ON CONFLICT (trade_id) DO NOTHING`,
            [id, instrument, source, direction, t.strike, t.chainId, entry, new Date(t.openedAt), num(atr), ref, factor, basis, JSON.stringify(grid), JSON.stringify(vg), JSON.stringify(coach), tp, JSON.stringify(t.path)]);
        S.open.set(id, t);
        log(`🌓 [AtrShadow] #${id} NIFTY ${direction} factor ${factor} (${basis}) SL ${vg.slPct}% target ${vg.fullExitAt}%`);
        return true;
    }

    async function tick() {
        if (S.ticking) return; S.ticking = true;
        try {
            for (const t of [...S.open.values()]) {
                try {
                    const prem = getStrikePremium(t.instrument, t.direction, t.strike, t.chainId);
                    let changed = false;
                    if (prem > 0) {
                        if (prem !== t.lastPremium && t.path.length < PATH_CAP) { t.path.push([Math.round((now() - t.openedAt) / 1000), prem]); changed = true; }
                        t.lastPremium = prem; t.lastDataTs = now();
                    }
                    if (pastSquareOff(t.instrument, now()) && t.lastPremium > 0) { closeTrade(t, t.lastPremium, 'eod_exit'); await save(t); continue; }
                    if (!(prem > 0)) { if (now() - t.lastDataTs > cfg.noDataCloseMin * 60000) { closeTrade(t, t.lastPremium, 'no_data'); await save(t); } continue; }
                    const res = coachStep(t.coach, prem, now() - t.openedAt, { timeStopMs: cfg.timeStopMin * 60000, trailPts: t.trailPts });
                    for (const a of res.actions) {
                        if (a.type === 'EXIT_ALL') { closeTrade(t, prem, a.reason); changed = true; break; }
                        if (a.type === 'BOOK_HALF') { const sell = Math.floor(t.lots / 2); t.exits.push({ premium: prem, frac: sell / t.lots, reason: 'half_book', ts: now() }); changed = true; }
                        if (a.type === 'MOVE_SL_TO_BE') changed = true;
                    }
                    if (changed || now() - (t.lastSaved || 0) > 60000) { t.lastSaved = now(); await save(t); }
                } catch (e) { log(`[AtrShadow] tick error #${t.id}: ${e.message}`); }
            }
        } finally { S.ticking = false; }
    }

    async function restore() {
        const r = await dbPool.query(`SELECT * FROM auto_journal_shadow WHERE state='OPEN'`);
        for (const x of r.rows) S.open.set(x.trade_id, { id: x.trade_id, instrument: x.instrument, source: x.source, direction: x.direction, strike: Number(x.strike), chainId: x.chain_id, entry: Number(x.entry_premium),
            lots: cfg.lots, coach: x.coach, trailPts: Number(x.trail_pts), openedAt: new Date(x.opened_ts).getTime(), lastPremium: Number(x.last_premium) || Number(x.entry_premium), lastDataTs: now(), exits: x.exits || [], state: 'OPEN', path: x.path || [] });
        const a = await dbPool.query(`SELECT atr FROM auto_journal_shadow WHERE atr IS NOT NULL ORDER BY trade_id DESC LIMIT ${REF_WINDOW}`);
        S.atrs = a.rows.map(z => Number(z.atr)).reverse();
        if (r.rows.length) log(`[AtrShadow] restored ${r.rows.length} open shadow trade(s)`);
    }
    async function start() {
        if (S.started || !cfg.enabled || !dbPool) { if (!cfg.enabled) log('[AtrShadow] ATR_SHADOW=off - not started'); return; }
        await ensureTable(); await restore();
        S.timers.push(setInterval(() => { tick().catch(e => log(`[AtrShadow] tick error: ${e.message}`)); }, cfg.tickMs));
        S.started = true; log('🌓 [AtrShadow] started (NIFTY only, record-only)');
    }
    function stop() { S.timers.forEach(clearInterval); S.timers = []; S.started = false; }

    async function report({ days = 30 } = {}) {
        if (!dbPool) return { enabled: cfg.enabled, started: S.started, rows: [] };
        const d = Math.min(120, Math.max(1, parseInt(days, 10) || 30));
        const r = await dbPool.query(`SELECT s.trade_id, s.source, s.direction, s.atr, s.ref_atr, s.factor, s.basis, s.var_grid, s.state AS var_state, s.realized_pct AS var_pct, s.exit_reason AS var_exit,
                a.realized_pct AS base_pct, a.exit_reason AS base_exit, a.state AS base_state, a.fire_ts
            FROM auto_journal_shadow s JOIN auto_journal_trades a ON a.id = s.trade_id
            WHERE a.fire_ts >= NOW() - ($1::int * INTERVAL '1 day') ORDER BY a.fire_ts DESC LIMIT 1000`, [d]);
        const rows = r.rows.map(x => ({ ...x, factor: num(x.factor), atr: num(x.atr), ref_atr: num(x.ref_atr), var_pct: num(x.var_pct), base_pct: num(x.base_pct) }));
        const closed = rows.filter(x => x.var_state === 'CLOSED' && x.base_state === 'CLOSED');
        return { enabled: cfg.enabled, started: S.started, days: d, total: rows.length, openNow: S.open.size, closedPairs: closed.length, noRef: rows.filter(x => x.basis === 'no_ref').length,
            comparison: compareRows(closed), rows: rows.slice(0, 200) };
    }
    return { cfg, start, stop, open, tick, report, _state: S };
}

module.exports = { FACTOR_MIN, FACTOR_MAX, REF_MIN_N, REF_WINDOW, refAtr, computeFactor, scaleGrid, compareRows, createAtrShadow };