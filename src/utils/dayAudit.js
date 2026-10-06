// ── Day audit — pure helpers (7 Oct) ──────────────────────────────────────
// The SQL lives in server.js (/api/day-audit); everything that INTERPRETS the numbers lives here so it
// can be unit-tested: the day's range, a plain-language reading of how tradable the day was for this app's
// 30-minute check, tracked-trade outcomes, and the plain-text version for reading on a phone.
// Display/audit only.

const WIN_LOSS_THRESHOLD_PCT = 0.15;   // the app's own 30-min WIN/LOSS threshold (see Signal Outcomes Tracking)
const GAVE_BACK_FROM_PCT = 25, GAVE_BACK_TO_PCT = 5;   // a trade that was +25% at its best and ended <= +5% "gave it back"
const MOSTLY_FLAT_PCT = 60;            // "mostly flat day" when at least this share of resolved checks were FLAT
const n = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const r1 = v => v === null ? null : Math.round(v * 10) / 10;
const r2 = v => v === null ? null : Math.round(v * 100) / 100;

// row = { first, last, lo, hi, fires } from SQL (entry prices of that day's fires, in time order)
function deriveRange(row) {
    const first = n(row?.first), last = n(row?.last), lo = n(row?.lo), hi = n(row?.hi);
    if (first === null || last === null || lo === null || hi === null || !(first > 0)) return null;
    return {
        first: r2(first), last: r2(last), lo: r2(lo), hi: r2(hi),
        rangePts: r2(hi - lo), rangePct: r2(((hi - lo) / first) * 100),
        netPts: r2(last - first), netPct: r2(((last - first) / first) * 100),
    };
}

function totals(sources) {
    const t = { fires: 0, wins: 0, losses: 0, flats: 0, pending: 0 };
    for (const s of sources || []) { t.fires += n(s.fires) || 0; t.wins += n(s.wins) || 0; t.losses += n(s.losses) || 0; t.flats += n(s.flats) || 0; t.pending += n(s.pending) || 0; }
    const resolved = t.wins + t.losses + t.flats;
    return { ...t, resolved,
        dirWinPct: t.wins + t.losses > 0 ? r1(100 * t.wins / (t.wins + t.losses)) : null,
        flatPct: resolved > 0 ? r1(100 * t.flats / resolved) : null };
}

// A plain sentence about the day. Only states what the numbers show.
function readingFor(tot, range) {
    if (!tot || !tot.fires) return 'No signals logged for this day.';
    const parts = [];
    if (range) parts.push(`range ${range.rangePts} pts (${range.rangePct}%)`);
    if (tot.resolved >= 5 && tot.flatPct !== null) {
        parts.push(tot.flatPct >= MOSTLY_FLAT_PCT
            ? `${tot.flatPct}% of the 30-min checks were FLAT (move under ±${WIN_LOSS_THRESHOLD_PCT}%) — a day that barely moved against this app's yardstick`
            : `${tot.flatPct}% of the checks were FLAT — the rest were decisive moves`);
    } else if (tot.resolved < 5) parts.push(`only ${tot.resolved} signals resolved so far — too early to judge`);
    if (tot.pending > 0) parts.push(`${tot.pending} still pending`);
    return parts.join(' · ');
}

// signal_performance row -> a readable trade line
function tradeOutcome(r) {
    const entry = n(r.entry), exit = n(r.exit_premium);
    let outcome = 'OPEN';
    if (r.closed) outcome = r.target_hit ? 'TARGET' : r.sl_hit ? 'STOP' : (r.partial_win ? 'PARTIAL' : 'TIMEOUT');
    const pnlPerShare = (entry !== null && exit !== null) ? exit - entry : null;
    return {
        id: r.id, time: r.time_ist || null, source: r.source || null, signal: r.signal, type: r.option_type, strike: n(r.strike),
        entry, sl: n(r.sl), target: n(r.target), exitPremium: exit, outcome,
        pnlPct: (pnlPerShare !== null && entry > 0) ? r1((pnlPerShare / entry) * 100) : null,
        pnlPerShare: pnlPerShare === null ? null : r2(pnlPerShare),
        bestGainPct: n(r.max_gain_pct) === null ? null : r1(n(r.max_gain_pct)), worstDipPct: n(r.max_adverse_pct) === null ? null : r1(n(r.max_adverse_pct)),
        minutes: n(r.time_taken_min), leadQuality: r.lead_quality || null,
    };
}

// The tracker stores a STOP at the stop LEVEL (-25%), but the premium had usually already gone further by the time
// it was checked (every ~30 s; a 0-1 DTE option can move Rs 3-5 in that time) — the alert on 6 Oct said -27% and
// -31.5% while the stored result said -25%. So for a STOP the audit also reports the worst point the premium reached
// (max_adverse_pct, the low seen), which is what the stop alert actually saw. A stop is exited at/near its low.
function withStopSlippage(t, lot) {
    if (t.outcome !== 'STOP' || t.worstDipPct === null || t.pnlPct === null || !(t.entry > 0)) return t;
    if (t.worstDipPct >= t.pnlPct) return t;             // no extra drop beyond the stored result
    return { ...t,
        slippagePct: r1(t.worstDipPct - t.pnlPct),
        pnlPerLotAtWorst: lot ? Math.round(t.entry * (t.worstDipPct / 100) * lot) : null };
}

function tradeSummary(trades, lot) {
    const closed = trades.filter(t => t.outcome !== 'OPEN');
    const withPnl = trades.filter(t => t.pnlPerShare !== null);
    // total if every STOP is taken at the worst point the alert saw (others as stored)
    const asAlerted = lot && withPnl.length
        ? Math.round(withPnl.reduce((a, t) => a + (t.pnlPerLotAtWorst !== undefined && t.pnlPerLotAtWorst !== null ? t.pnlPerLotAtWorst / lot : t.pnlPerShare) * lot, 0)) : null;
    return {
        n: trades.length, closed: closed.length, open: trades.length - closed.length,
        targetHits: trades.filter(t => t.outcome === 'TARGET').length, stops: trades.filter(t => t.outcome === 'STOP').length,
        timeouts: trades.filter(t => t.outcome === 'TIMEOUT' || t.outcome === 'PARTIAL').length,
        avgPnlPct: withPnl.length ? r1(withPnl.reduce((a, t) => a + (t.pnlPct ?? 0), 0) / withPnl.length) : null,
        totalPnlPerLot: lot && withPnl.length ? Math.round(withPnl.reduce((a, t) => a + t.pnlPerShare * lot, 0)) : null,
        totalPnlPerLotAsAlerted: asAlerted,
        // closed trades that were up >= GAVE_BACK_FROM_PCT at their best but finished at or below +GAVE_BACK_TO_PCT
        gaveBack: closed.filter(t => t.bestGainPct !== null && t.bestGainPct >= GAVE_BACK_FROM_PCT && t.pnlPct !== null && t.pnlPct <= GAVE_BACK_TO_PCT).length,
        lot: lot || null,
    };
}

const f = v => (v === null || v === undefined) ? '—' : v;
const sg = v => v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v}`;
const rs = v => v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '-' : ''}₹${Math.abs(v)}`;   // +₹169 / -₹962
const pl = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;

function formatDayAuditText(a) {
    const L = [`📋 DAY AUDIT — ${a.date}`];
    for (const ins of Object.keys(a.instruments || {})) {
        const d = a.instruments[ins];
        L.push('', `━━ ${ins} ━━`);
        const hasTrades = !!(d.trackedTrades && d.trackedTrades.length);
        if (!d.totals || !d.totals.fires) {
            L.push('No signals logged this day.');
            if (!hasTrades) continue;      // tracked trades exist independently of the exploratory triggers — never hide them
        }
        if (d.totals && d.totals.fires) {
        if (d.range) L.push(`Price ${d.range.first} → ${d.range.last} (net ${sg(d.range.netPts)} pts, ${sg(d.range.netPct)}%) · low ${d.range.lo} · high ${d.range.hi} · range ${d.range.rangePts} pts (${d.range.rangePct}%)`);
        const t = d.totals;
        L.push(`${t.fires} fires · WIN ${t.wins} / LOSS ${t.losses} / FLAT ${t.flats} / pending ${t.pending} · direction right ${f(t.dirWinPct)}%`);
        L.push(`➜ ${d.reading}`);
        L.push('By trigger:');
        for (const s of d.bySource) {
            L.push(` • ${s.source}: ${s.fires} (▲${s.bull} ▼${s.bear}) W${s.wins} L${s.losses} F${s.flats}${s.pending ? ' P' + s.pending : ''}` +
                   `${s.coachN ? ` · coach avg ${sg(s.coachAvg)}% (n=${s.coachN})` : ''}`);
        }
        }
        if (hasTrades) {
            L.push('Tracked trades:');
            for (const x of d.trackedTrades) {
                L.push(` • ${x.time || '--:--'} ${x.source || ''} ${x.type || ''} ${f(x.strike)} @${f(x.entry)} → ${x.outcome}` +
                       `${x.pnlPct !== null ? ` ${sg(x.pnlPct)}%` : ''}${x.pnlPerLot !== undefined && x.pnlPerLot !== null ? ` (${rs(x.pnlPerLot)}/lot)` : ''}` +
                       ` · best ${sg(x.bestGainPct)}% · worst ${sg(x.worstDipPct)}%${x.minutes ? ` · ${x.minutes} min` : ''}` +
                       `${x.slippagePct !== undefined ? ` · ⚠️ stop saw ${sg(x.worstDipPct)}% (${rs(x.pnlPerLotAtWorst)}/lot) — ${Math.abs(x.slippagePct)} pts past the stop level` : ''}`);
            }
            const s = d.tradeSummary;
            L.push(`   total: ${s.n} trades · target ${s.targetHits} · stop ${s.stops} · other ${s.timeouts} · open ${s.open}` +
                   `${s.totalPnlPerLot !== null ? ` · ${rs(s.totalPnlPerLot)}/lot` : ''}`);
            if (s.totalPnlPerLotAsAlerted !== null && s.totalPnlPerLotAsAlerted !== s.totalPnlPerLot) {
                L.push(`   stops taken at the worst point the alert saw: ${rs(s.totalPnlPerLotAsAlerted)}/lot (the stored figure above takes each stop at its -25% level)`);
            }
            if (s.gaveBack) L.push(`   ${pl(s.gaveBack, 'trade')} were up ${GAVE_BACK_FROM_PCT}%+ at their best but ended at ${GAVE_BACK_TO_PCT}% or below (gave it back)`);
        }
        if (d.combosToday && d.combosToday.list && d.combosToday.list.length) {
            L.push('Combos that completed today (ANECDOTAL — a few events only):');
            for (const c of d.combosToday.list) L.push(` • ${c.combo} ${c.direction}: ${pl(c.n, 'event')} · direction ${f(c.dirWinPct)}%${c.coachN ? ` · coach avg ${sg(c.coachAvg)}%` : ''}`);
        }
    }
    if (a.notes) L.push('', ...a.notes.map(x => 'ℹ️ ' + x));
    return L.join('\n');
}

module.exports = { deriveRange, totals, readingFor, tradeOutcome, withStopSlippage, tradeSummary, GAVE_BACK_FROM_PCT, GAVE_BACK_TO_PCT, formatDayAuditText, WIN_LOSS_THRESHOLD_PCT, MOSTLY_FLAT_PCT };