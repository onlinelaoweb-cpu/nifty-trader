'use strict';
// ── Entry / Exit quality scorecard (9 Oct) ────────────────────────────────────
// Question: when a trigger loses money, was the ENTRY bad (price never went our way, or went against us first)
// or the EXIT bad (it did go our way, but we gave it back)?
//
// Two data sources, both already in the DB:
//   A. signal_outcomes + signal_outcome_path (premium sampled ~5 min for 90 min) -> every exploratory trigger,
//      scored with the live Trade-Coach grid. Entry side: how often +5% / +10% is reached, how long it takes, how deep it
//      dips first, how much cheaper a later entry within 15 min would have been. Exit side: capture ratio, give-back, "touched
//      +15% but ended negative", exit-reason mix.
//   B. signal_performance (MTF tracker leads that actually alerted): realised vs peak, SL/target/timeout mix, what the premium
//      did AFTER the tracker closed (post_close_max_gain_pct).
// Pure functions (no DB, no clock). Research only — nothing here feeds a signal, gate or alert.
// The diagnosis labels are rules of thumb on small samples, shown with n so they can be judged, not trusted blindly.

const num = v => { const x = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(x) ? null : x; };
const r1 = x => Math.round(x * 10) / 10;
const avg = a => a.length ? r1(a.reduce((s, x) => s + x, 0) / a.length) : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return r1(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
const pctOf = (k, n) => n ? Math.round((100 * k) / n) : null;

const REACH_LEVELS = [5, 10];
const EARLY_ENTRY_WINDOW_MIN = 15;

// one outcome -> per-trade metrics, or null when unusable. outcome = { id, source, fireTs, entryPremium, path:[{ts,premium}] }
function scoreOutcome(o, simulate, grid) {
    if (!o || !(o.entryPremium > 0) || !o.path || o.path.length < 2) return null;
    const sim = simulate(o.entryPremium, o.path, grid);
    if (!sim) return null;
    const pts = o.path.map(p => ({ min: (p.ts - o.fireTs) / 60000, pct: (p.premium / o.entryPremium - 1) * 100 })).filter(p => Number.isFinite(p.pct));
    if (pts.length < 2) return null;
    const mfe = Math.max(0, ...pts.map(p => p.pct));
    const mae = Math.min(0, ...pts.map(p => p.pct));
    const reach = {}, timeTo = {}, maeBefore = {};
    for (const L of REACH_LEVELS) {
        const idx = pts.findIndex(p => p.pct >= L);
        reach[L] = idx >= 0;
        timeTo[L] = idx >= 0 ? Math.max(0, r1(pts[idx].min)) : null;
        // deepest dip BEFORE the level was first reached (or over the whole path if never reached)
        maeBefore[L] = Math.min(0, ...pts.slice(0, idx >= 0 ? idx + 1 : pts.length).map(p => p.pct));
    }
    const early = pts.filter(p => p.min <= EARLY_ENTRY_WINDOW_MIN);
    const betterEntry = early.length ? Math.min(0, ...early.map(p => p.pct)) : 0;   // <= 0: how much cheaper a later entry in the window was
    return {
        id: o.id, source: o.source || '', fireTs: o.fireTs,
        mfe: r1(mfe), mae: r1(mae), result: sim.coachResult, exitReason: sim.coachExitReason || null,
        reach5: reach[5], reach10: reach[10], timeTo5: timeTo[5], timeTo10: timeTo[10], maeBefore5: r1(maeBefore[5]),
        betterEntry: r1(betterEntry),
        touched15ButNegative: mfe >= 15 && sim.coachResult < 0,
    };
}

function summariseTrades(rows, minN) {
    const n = rows.length;
    const winners = rows.filter(r => r.mfe > 0);
    const sumMfe = winners.reduce((s, r) => s + r.mfe, 0), sumRes = winners.reduce((s, r) => s + r.result, 0);
    const captureRatio = sumMfe > 0 ? Math.round((100 * sumRes) / sumMfe) / 100 : null;   // total realised / total peak, over trades that had a peak > 0
    const touched15 = rows.filter(r => r.mfe >= 15).length;
    const reasons = {};
    for (const r of rows) { const k = r.exitReason || 'unknown'; reasons[k] = (reasons[k] || 0) + 1; }
    const pReach5 = pctOf(rows.filter(r => r.reach5).length, n), pReach10 = pctOf(rows.filter(r => r.reach10).length, n);
    const out = {
        n,
        entry: {
            reach5Pct: pReach5, reach10Pct: pReach10,
            medianMinutesTo5: median(rows.filter(r => r.timeTo5 !== null).map(r => r.timeTo5)),
            medianDipBeforeGainPct: median(rows.map(r => r.maeBefore5)),
            avgWorstDrawdownPct: avg(rows.map(r => r.mae)),
            avgBetterEntryWithin15MinPct: avg(rows.map(r => r.betterEntry)),
        },
        exit: {
            avgPeakGainPct: avg(rows.map(r => r.mfe)), avgResultPct: avg(rows.map(r => r.result)),
            captureRatio, avgGiveBackPct: avg(winners.map(r => r.mfe - r.result)),
            touched15Pct: pctOf(touched15, n), touched15ButNegative: rows.filter(r => r.touched15ButNegative).length,
            exitReasonMix: reasons,
        },
        thin: n < minN,
    };
    // Rule-of-thumb diagnosis. ENTRY: most trades never even reach +5%, or dip hard first. EXIT: most reach +10% but little is kept.
    let diagnosis;
    if (n < minN) diagnosis = 'TOO FEW TRADES';
    else {
        const entryBad = (pReach5 !== null && pReach5 < 45) || (out.entry.medianDipBeforeGainPct !== null && out.entry.medianDipBeforeGainPct < -10);
        const exitBad = captureRatio !== null && pReach10 !== null && pReach10 >= 45 && captureRatio < 0.35;
        diagnosis = entryBad && exitBad ? 'ENTRY + EXIT' : entryBad ? 'ENTRY (rarely goes our way / dips first)' : exitBad ? 'EXIT (reaches +10% but keeps little)' : 'NO CLEAR LEAK';
    }
    out.diagnosis = diagnosis;
    return out;
}

function computeScorecard(outcomes, simulate, grid, opts = {}) {
    const minN = opts.minN ?? 15, declusterMin = opts.declusterMin ?? 30;
    const decluster = opts.decluster || (x => x);
    const kept = decluster(outcomes, declusterMin);
    const rows = [];
    for (const o of kept) { const s = scoreOutcome(o, simulate, grid); if (s) rows.push(s); }
    const bySource = {};
    for (const r of rows) (bySource[r.source] = bySource[r.source] || []).push(r);
    const sources = Object.entries(bySource).map(([source, rs]) => ({ source, ...summariseTrades(rs, minN) })).sort((a, b) => b.n - a.n);
    // time-wise view: newest trades first, one line each (for the in-app tab)
    const recent = rows.slice().sort((a, b) => b.fireTs - a.fireTs).slice(0, opts.recentLimit ?? 80).map(r => ({
        id: r.id, source: r.source, ts: new Date(r.fireTs).toISOString(), mfe: r.mfe, mae: r.mae, result: r.result, exitReason: r.exitReason,
        timeTo5: r.timeTo5, maeBefore5: r.maeBefore5, touched15ButNegative: r.touched15ButNegative,
    }));
    return { outcomesBeforeDecluster: outcomes.length, outcomesUsed: rows.length, all: summariseTrades(rows, minN), sources, recent, params: { minN, declusterMin } };
}

// ── B. MTF tracker leads (signal_performance rows, closed) ──
function computeTrackerScorecard(trades, opts = {}) {
    const minN = opts.minN ?? 10;
    const rows = [];
    for (const t of trades || []) {
        const entry = num(t.entry); if (!(entry > 0)) continue;
        const exit = num(t.exit_premium), mfe = num(t.max_gain_pct), mae = num(t.max_adverse_pct), post = num(t.post_close_max_gain_pct);
        const ret = exit !== null ? ((exit - entry) / entry) * 100 : t.target_hit && num(t.target) > 0 ? ((num(t.target) - entry) / entry) * 100 : t.sl_hit && num(t.sl) > 0 ? ((num(t.sl) - entry) / entry) * 100 : null;
        if (ret === null) continue;
        rows.push({ id: t.id ?? null, ts: t.ts ? new Date(t.ts).toISOString() : null, signal: t.signal || null, quality: t.lead_quality || 'unknown', ret: Math.round(ret * 10) / 10, mfe, mae, post, target: !!t.target_hit, sl: !!t.sl_hit, minutes: num(t.time_taken_min) });
    }
    const sum = rs => {
        const n = rs.length, pk = rs.filter(r => r.mfe !== null && r.mfe > 0);
        const sumPk = pk.reduce((s, r) => s + r.mfe, 0), sumRet = pk.reduce((s, r) => s + r.ret, 0);
        const posts = rs.filter(r => r.post !== null);
        return {
            n, thin: n < minN, avgReturnPct: avg(rs.map(r => r.ret)), winRatePct: pctOf(rs.filter(r => r.ret > 0).length, n),
            avgPeakGainPct: avg(rs.map(r => r.mfe).filter(x => x !== null)), avgWorstDrawdownPct: avg(rs.map(r => r.mae).filter(x => x !== null)),
            captureRatio: sumPk > 0 ? Math.round((100 * sumRet) / sumPk) / 100 : null,
            targetHits: rs.filter(r => r.target).length, slHits: rs.filter(r => r.sl).length, timeouts: rs.filter(r => !r.target && !r.sl).length,
            postCloseCoverage: posts.length, avgGainAfterCloseWithinShadowWindowPct: avg(posts.map(r => r.post)),
        };
    };
    const by = {};
    for (const r of rows) (by[r.quality] = by[r.quality] || []).push(r);
    const recent = rows.filter(r => r.ts).sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, opts.recentLimit ?? 60)
        .map(r => ({ id: r.id, ts: r.ts, signal: r.signal, quality: r.quality, ret: r.ret, mfe: r.mfe, mae: r.mae, post: r.post, outcome: r.target ? 'TARGET' : r.sl ? 'SL' : 'TIMEOUT', minutes: r.minutes }));
    return { all: sum(rows), byLeadQuality: Object.entries(by).map(([quality, rs]) => ({ quality, ...sum(rs) })).sort((a, b) => b.n - a.n), recent };
}

function formatScorecardText(res) {
    const L = [];
    const fmt = v => v === null || v === undefined ? '--' : v;
    L.push('ENTRY / EXIT SCORECARD (Trade-Coach grid: ' + (res.gridUsed?.name || '?') + ')');
    L.push('Trades used: ' + res.scorecard.outcomesUsed + ' of ' + res.scorecard.outcomesBeforeDecluster + ' (declustered). Before brokerage.');
    L.push('');
    for (const s of [{ source: 'ALL TRIGGERS', ...res.scorecard.all }, ...res.scorecard.sources]) {
        L.push((s.source || '?') + '  [n=' + s.n + (s.thin ? ', thin' : '') + ']  -> ' + s.diagnosis);
        L.push('  ENTRY  reach +5%: ' + fmt(s.entry.reach5Pct) + '%   reach +10%: ' + fmt(s.entry.reach10Pct) + '%   median min to +5%: ' + fmt(s.entry.medianMinutesTo5) + '   median dip first: ' + fmt(s.entry.medianDipBeforeGainPct) + '%   cheaper entry in 15 min: ' + fmt(s.entry.avgBetterEntryWithin15MinPct) + '%');
        L.push('  EXIT   avg peak: ' + fmt(s.exit.avgPeakGainPct) + '%   avg result: ' + fmt(s.exit.avgResultPct) + '%   kept ' + fmt(s.exit.captureRatio) + ' of the peak   gave back ' + fmt(s.exit.avgGiveBackPct) + '%   touched +15% but ended negative: ' + s.exit.touched15ButNegative);
    }
    if (res.tracker) {
        L.push('');
        L.push('MTF TRACKER LEADS (closed): n=' + res.tracker.all.n + '  avg return ' + fmt(res.tracker.all.avgReturnPct) + '%  kept ' + fmt(res.tracker.all.captureRatio) + ' of peak  target/SL/timeout ' + res.tracker.all.targetHits + '/' + res.tracker.all.slHits + '/' + res.tracker.all.timeouts);
        for (const q of res.tracker.byLeadQuality) L.push('  ' + q.quality + ': n=' + q.n + '  avg ' + fmt(q.avgReturnPct) + '%  peak ' + fmt(q.avgPeakGainPct) + '%  worst dip ' + fmt(q.avgWorstDrawdownPct) + '%  kept ' + fmt(q.captureRatio));
    }
    return L.join('\n');
}

module.exports = { scoreOutcome, summariseTrades, computeScorecard, computeTrackerScorecard, formatScorecardText, EARLY_ENTRY_WINDOW_MIN };