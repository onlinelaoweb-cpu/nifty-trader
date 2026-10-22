'use strict';
// 22 Oct 2026 - PROBABILITY PROFILE (read-only). Turns the Auto Journal's CLOSED paper trades into one honest table per engine:
// win %, average win / loss, payoff ratio, expectancy, worst losing streak, max drawdown, exit-reason mix, and how many trades were
// "correlated" (same instrument + direction + strike fired by another engine within CORR_MIN minutes = the same bet counted twice).
// It never changes a signal, a rule, a stored row or a threshold. Costs/slippage are NOT in the journal, so every number is gross.

const CORR_MIN = 3;          // minutes: same instrument+direction+strike inside this window = correlated duplicate
const MIN_N = 30;            // below this the profile is "too few trades" - shown, but flagged
const r1 = v => (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v * 10) / 10;
const r0 = v => (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v);
const num = v => (v === null || v === undefined || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : null);

// Wilson 95% interval for a win rate (n small -> wide, which is the honest message)
function wilson(w, n) {
    if (!n) return null;
    const z = 1.96, p = w / n, d = 1 + z * z / n;
    const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
    return [r1(Math.max(0, c - h) * 100), r1(Math.min(1, c + h) * 100)];
}

// Marks trades that duplicate an earlier trade (any engine) on the same instrument+direction+strike inside CORR_MIN minutes.
// Returns a Set of trade indexes (into the given array) that are duplicates. The EARLIEST trade of a cluster is the "independent" one.
function correlatedSet(trades) {
    const idx = trades.map((t, i) => ({ i, ts: new Date(t.fire_ts).getTime(), k: `${t.instrument}|${String(t.direction || t.side || '').toUpperCase()}|${num(t.strike)}` }))
        .filter(x => Number.isFinite(x.ts)).sort((a, b) => a.ts - b.ts);
    const lastKept = new Map(), dup = new Set();
    for (const x of idx) {
        const prev = lastKept.get(x.k);
        if (prev !== undefined && x.ts - prev <= CORR_MIN * 60000) dup.add(x.i);
        else lastKept.set(x.k, x.ts);
    }
    return dup;
}

function profileOf(list, dupSet, indexOf) {
    const closed = list.filter(t => t.state === 'CLOSED' && num(t.realized_pct) !== null)
        .sort((a, b) => new Date(a.fire_ts) - new Date(b.fire_ts));
    const n = closed.length;
    const wins = closed.filter(t => num(t.realized_pct) > 0), losses = closed.filter(t => num(t.realized_pct) <= 0);
    const sum = a => a.reduce((s, t) => s + num(t.realized_pct), 0);
    const avgWin = wins.length ? sum(wins) / wins.length : null, avgLoss = losses.length ? sum(losses) / losses.length : null;
    const expectancy = n ? sum(closed) / n : null;
    // payoff = average win / |average loss|; breakeven point = win rate needed for expectancy 0 at this payoff
    const payoff = (avgWin !== null && avgLoss !== null && avgLoss < 0) ? avgWin / Math.abs(avgLoss) : null;
    const breakevenWin = payoff !== null ? 100 / (1 + payoff) : null;
    // worst losing streak + max drawdown (cumulative % in time order; simple sum, not compounded)
    let streak = 0, worstStreak = 0, cum = 0, peak = 0, maxDd = 0;
    for (const t of closed) {
        const p = num(t.realized_pct);
        if (p <= 0) { streak++; worstStreak = Math.max(worstStreak, streak); } else streak = 0;
        cum += p; peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum);
    }
    const rsKnown = closed.filter(t => num(t.realized_rs) !== null);
    const exits = {};
    for (const t of closed) { const k = t.exit_reason || 'unknown'; exits[k] = (exits[k] || 0) + 1; }
    const corr = closed.filter(t => dupSet.has(indexOf.get(t))).length;
    const indep = closed.filter(t => !dupSet.has(indexOf.get(t)));
    return {
        n, open: list.filter(t => t.state === 'OPEN').length,
        winPct: n ? r1(wins.length / n * 100) : null, winCI95: wilson(wins.length, n),
        avgWinPct: r1(avgWin), avgLossPct: r1(avgLoss), payoff: payoff === null ? null : Math.round(payoff * 100) / 100,
        breakevenWinPct: r1(breakevenWin), expectancyPct: r1(expectancy),
        totalPct: r1(sum(closed)), totalRs: rsKnown.length ? r0(rsKnown.reduce((s, t) => s + num(t.realized_rs), 0)) : null, rsKnownOf: `${rsKnown.length}/${n}`,
        worstLosingStreak: worstStreak, maxDrawdownPct: r1(maxDd),
        exitMix: exits, correlated: corr, independentN: indep.length,
        independentExpectancyPct: indep.length ? r1(sum(indep) / indep.length) : null,
        enough: n >= MIN_N
    };
}

// trades: rows from auto_journal_trades (instrument, source, direction/side, strike, fire_ts, state, realized_pct, realized_rs, exit_reason)
function buildProfile(trades) {
    const all = Array.isArray(trades) ? trades : [];
    const dup = correlatedSet(all), indexOf = new Map(all.map((t, i) => [t, i]));
    const keys = [...new Set(all.map(t => `${t.instrument}|${t.source}`))].sort();
    const groups = keys.map(k => {
        const [instrument, source] = k.split('|');
        return { instrument, source, ...profileOf(all.filter(t => t.instrument === instrument && t.source === source), dup, indexOf) };
    });
    const insts = [...new Set(all.map(t => t.instrument))].sort();
    const byInstrument = insts.map(i => ({ instrument: i, source: 'ALL ENGINES', ...profileOf(all.filter(t => t.instrument === i), dup, indexOf) }));
    return { corrWindowMin: CORR_MIN, minN: MIN_N, groups, byInstrument };
}

function profileText(p, meta = {}) {
    const f = v => (v === null || v === undefined ? '-' : String(v));
    const L = [`PROBABILITY PROFILE - last ${f(meta.days)} day(s), CLOSED paper trades only, GROSS (no brokerage/slippage). Read-only; changes nothing.`,
        `Correlated = same instrument+direction+strike as an earlier trade within ${p.corrWindowMin} min (same bet counted twice). Reliable only from ${p.minN}+ closed trades per row.`, ''];
    const row = g => {
        L.push(`${g.instrument} | ${g.source}: ${g.n} closed${g.open ? ` (+${g.open} open)` : ''}${g.enough ? '' : '  [TOO FEW - do not trust]'}`);
        if (!g.n) { L.push('  no closed trades'); return; }
        L.push(`  win ${f(g.winPct)}% (95% range ${g.winCI95 ? g.winCI95[0] + '-' + g.winCI95[1] : '-'}) | avg win ${f(g.avgWinPct)}% | avg loss ${f(g.avgLossPct)}% | payoff ${f(g.payoff)} | win% needed to break even ${f(g.breakevenWinPct)}%`);
        L.push(`  expectancy ${f(g.expectancyPct)}% per trade | total ${f(g.totalPct)}% | Rs ${f(g.totalRs)} (known for ${g.rsKnownOf}) | worst losing streak ${g.worstLosingStreak} | max drawdown ${f(g.maxDrawdownPct)} pts of %`);
        L.push(`  correlated duplicates ${g.correlated} -> independent trades ${g.independentN}, independent expectancy ${f(g.independentExpectancyPct)}%`);
        L.push(`  exits: ${Object.entries(g.exitMix).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    };
    for (const g of p.groups) { row(g); L.push(''); }
    L.push('--- per instrument (all engines together) ---');
    for (const g of p.byInstrument) { row(g); L.push(''); }
    L.push('Win% counts any trade closed above 0 as a win (a -1% breakeven stop is a loss). Max drawdown = biggest fall of the running sum of trade %. Observation only - not financial advice.');
    return L.join('\n');
}

module.exports = { buildProfile, profileText, correlatedSet, wilson, CORR_MIN, MIN_N };