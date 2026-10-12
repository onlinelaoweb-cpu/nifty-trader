'use strict';
// ── Journal day study (12 Oct) — read-only research ───────────────────────────────────────────────────────
// Question: for one day's Auto Journal paper trades, what did the market look like when the winners were opened and
// when the losers were opened, and what did the market do AFTER each stop-loss (did it come back and then go our way)?
// Inputs: the day's auto_journal_trades rows + that day's market_snapshot_log rows (5-minute cadence, so every
// spot-based number below is only as fine as 5 minutes). Purely descriptive: it does NOT propose or change any rule.
// Small samples and same-strike clusters are called out in the text so the numbers are not over-read.

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const r1 = v => v === null ? null : Math.round(v * 10) / 10;
const r2 = v => v === null ? null : Math.round(v * 100) / 100;
const MIN = 60000;
const CLUSTER_GAP_MIN = 90;      // same direction + strike, opened within this gap of the previous one => same cluster (one bet)
const AFTER_MIN = [30, 60];      // look-ahead after an exit

function istMinutesOfDay(ts) { const d = new Date(ts); return ((d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440); }
function istClock(ts) { const m = istMinutesOfDay(ts); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function bucketOf(minOfDay) { return minOfDay < 600 ? 'before 10:00' : minOfDay < 720 ? '10:00-12:00' : minOfDay < 840 ? '12:00-14:00' : '14:00+'; }
function median(a) { const v = a.filter(x => x !== null && Number.isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; }

// snaps: ascending by ts. Latest snapshot at or before ts, but only if it is not older than maxAgeMin.
function snapAtOrBefore(snaps, ts, maxAgeMin = 10) {
    let best = null;
    for (const s of snaps) { if (s.ts <= ts) best = s; else break; }
    return best && (ts - best.ts) <= maxAgeMin * MIN ? best : null;
}
// First snapshot at or after ts (within maxAgeMin) — used for the look-ahead after an exit.
function snapAtOrAfter(snaps, ts, maxAgeMin = 10) {
    for (const s of snaps) if (s.ts >= ts) return (s.ts - ts) <= maxAgeMin * MIN ? s : null;
    return null;
}

function normalizeTrades(rows) {
    return (rows || []).map(r => ({
        id: r.id, source: r.source, direction: String(r.direction || '').toUpperCase(), side: r.side || null, strike: num(r.strike),
        fireTs: new Date(r.fire_ts).getTime(), exitTs: r.exit_ts ? new Date(r.exit_ts).getTime() : null,
        state: r.state, entryPremium: num(r.entry_premium), underlying: num(r.underlying), realizedPct: num(r.realized_pct),
        exitReason: r.exit_reason || null, peakPct: num(r.peak_pct),
    })).filter(t => Number.isFinite(t.fireTs) && (t.direction === 'BULLISH' || t.direction === 'BEARISH')).sort((a, b) => a.fireTs - b.fireTs);
}
function normalizeSnaps(rows) {
    return (rows || []).map(r => ({
        ts: new Date(r.ts).getTime(), nifty: num(r.nifty), dayHigh: num(r.day_high), dayLow: num(r.day_low), vwapDistPct: num(r.vwap_dist_pct),
        mtfSignal: r.mtf_signal || null, adx5: num(r.mtf_5m_adx), adx15: num(r.mtf_15m_adx), adx1h: num(r.mtf_1h_adx), pcr: num(r.pcr), signal: r.signal || null,
    })).filter(s => Number.isFinite(s.ts) && s.nifty !== null).sort((a, b) => a.ts - b.ts);
}

function assignClusters(trades) {
    const last = new Map(); let next = 1;
    for (const t of trades) {
        const key = t.direction + '|' + t.strike, prev = last.get(key);
        if (prev && (t.fireTs - prev.fireTs) <= CLUSTER_GAP_MIN * MIN) t.cluster = prev.cluster; else t.cluster = next++;
        last.set(key, { fireTs: t.fireTs, cluster: t.cluster });
    }
    return trades;
}

function analyzeTrade(t, snaps) {
    const sign = t.direction === 'BULLISH' ? 1 : -1;
    const eSnap = snapAtOrBefore(snaps, t.fireTs);
    const entrySpot = t.underlying !== null ? t.underlying : (eSnap ? eSnap.nifty : null);
    const minOfDay = istMinutesOfDay(t.fireTs);
    const out = {
        id: t.id, source: t.source, direction: t.direction, strike: t.strike, side: t.side, time: istClock(t.fireTs), bucket: bucketOf(minOfDay),
        minSinceOpen: minOfDay - 555, cluster: t.cluster, state: t.state, resultPct: t.realizedPct, exitReason: t.exitReason, exitTime: t.exitTs ? istClock(t.exitTs) : null,
        entrySpot: r1(entrySpot), mtfAtEntry: eSnap ? eSnap.mtfSignal : null, adx5AtEntry: eSnap ? eSnap.adx5 : null, vwapDistPct: eSnap ? r2(eSnap.vwapDistPct) : null, pcr: eSnap ? eSnap.pcr : null,
        rangeDoneAtEntry: null, mfePts: null, maePts: null, exitSpot: null, afterPts: {},
    };
    // how much of the day's range had already been travelled in our direction when we entered (high = late / chasing)
    if (eSnap && entrySpot !== null && eSnap.dayHigh !== null && eSnap.dayLow !== null && eSnap.dayHigh > eSnap.dayLow) {
        const range = eSnap.dayHigh - eSnap.dayLow;
        const done = sign === 1 ? (entrySpot - eSnap.dayLow) / range : (eSnap.dayHigh - entrySpot) / range;
        out.rangeDoneAtEntry = r2(Math.max(0, Math.min(1, done)));
    }
    if (entrySpot !== null && t.exitTs) {
        const inside = snaps.filter(s => s.ts >= t.fireTs && s.ts <= t.exitTs);
        if (inside.length) {
            const moves = inside.map(s => sign * (s.nifty - entrySpot));
            out.mfePts = r1(Math.max(0, ...moves)); out.maePts = r1(Math.min(0, ...moves));
        }
        const xs = snapAtOrBefore(snaps, t.exitTs);
        if (xs) {
            out.exitSpot = r1(xs.nifty);
            for (const m of AFTER_MIN) {
                const a = snapAtOrAfter(snaps, t.exitTs + m * MIN, 10);
                out.afterPts[m] = a ? r1(sign * (a.nifty - xs.nifty)) : null;   // + = market kept going OUR way after the exit
            }
        }
    }
    return out;
}

function summarize(rows) {
    const g = a => ({
        n: a.length, clusters: new Set(a.map(x => x.cluster)).size,
        medMinSinceOpen: median(a.map(x => x.minSinceOpen)), medRangeDone: median(a.map(x => x.rangeDoneAtEntry)),
        medMfe: median(a.map(x => x.mfePts)), medMae: median(a.map(x => x.maePts)), medAdx5: median(a.map(x => x.adx5AtEntry)),
        medAfter30: median(a.map(x => x.afterPts[30] ?? null)), medAfter60: median(a.map(x => x.afterPts[60] ?? null)),
        resumed60: a.filter(x => x.afterPts[60] !== null && x.afterPts[60] !== undefined && x.afterPts[60] > 0).length,
        haveAfter60: a.filter(x => x.afterPts[60] !== null && x.afterPts[60] !== undefined).length,
    });
    const closed = rows.filter(r => r.state === 'CLOSED' && r.resultPct !== null);
    const wins = closed.filter(r => r.resultPct > 0), losses = closed.filter(r => r.resultPct <= 0);
    const byBucket = {};
    for (const r of closed) { const b = byBucket[r.bucket] || (byBucket[r.bucket] = { n: 0, wins: 0, sumPct: 0 }); b.n++; if (r.resultPct > 0) b.wins++; b.sumPct += r.resultPct; }
    for (const b of Object.values(byBucket)) b.avgPct = r1(b.sumPct / b.n);
    const bySource = {};
    for (const r of closed) { const b = bySource[r.source] || (bySource[r.source] = { n: 0, wins: 0, sumPct: 0 }); b.n++; if (r.resultPct > 0) b.wins++; b.sumPct += r.resultPct; }
    for (const b of Object.values(bySource)) b.avgPct = r1(b.sumPct / b.n);
    return { closed: closed.length, open: rows.length - closed.length, clusters: new Set(rows.map(x => x.cluster)).size, wins: g(wins), losses: g(losses), byBucket, bySource };
}

function runJournalDayStudy(tradeRows, snapRows) {
    const trades = assignClusters(normalizeTrades(tradeRows)), snaps = normalizeSnaps(snapRows);
    const rows = trades.map(t => analyzeTrade(t, snaps));
    return { snapshots: snaps.length, trades: rows, summary: summarize(rows) };
}

const f = (v, d = 1) => v === null || v === undefined ? '--' : (typeof v === 'number' ? v.toFixed(d) : String(v));
function formatJournalDayText(study, date) {
    const L = [`JOURNAL DAY STUDY — ${date}`, `(read-only, descriptive. ${study.snapshots} five-minute snapshots, so spot numbers are ±5 min. Nothing here changes any rule.)`, ''];
    if (!study.trades.length) { L.push('No Auto Journal trades for this day.'); return L.join('\n'); }
    L.push('time   source        trade          result    exit   MFE  MAE  rangeDone  mtf@entry     adx5  after30 after60  cl');
    for (const r of study.trades) {
        L.push([r.time.padEnd(6), String(r.source).padEnd(13), `${r.strike} ${r.side || ''}`.padEnd(14),
            (r.state === 'CLOSED' ? f(r.resultPct) + '%' : 'OPEN').padEnd(9), (r.exitReason || '--').slice(0, 9).padEnd(7),
            f(r.mfePts).padStart(4), f(r.maePts).padStart(4), (r.rangeDoneAtEntry === null ? '--' : Math.round(r.rangeDoneAtEntry * 100) + '%').padStart(9),
            String(r.mtfAtEntry || '--').padEnd(13), f(r.adx5AtEntry).padStart(5), f(r.afterPts[30]).padStart(7), f(r.afterPts[60]).padStart(7), String(r.cluster).padStart(3)].join(' '));
    }
    L.push('', 'MFE/MAE = best / worst the spot went in our direction between entry and exit (points). rangeDone = share of the day\'s high-low range already travelled in our direction at entry (high = late).',
        'after30/60 = spot move in our direction 30/60 min after the exit (+ = market kept going our way, i.e. we were early/stopped out by a wobble).', '');
    const s = study.summary, row = (name, g) => `  ${name.padEnd(7)} n${g.n} (${g.clusters} clusters) | median minutes after open ${f(g.medMinSinceOpen, 0)} | rangeDone ${g.medRangeDone === null ? '--' : Math.round(g.medRangeDone * 100) + '%'} | MFE ${f(g.medMfe)} MAE ${f(g.medMae)} | adx5 ${f(g.medAdx5)} | after30 ${f(g.medAfter30)} after60 ${f(g.medAfter60)} | resumed our way after 60m: ${g.resumed60}/${g.haveAfter60}`;
    L.push(`Closed ${s.closed}, open ${s.open}, independent clusters (same strike+direction within ${CLUSTER_GAP_MIN} min = one bet): ${s.clusters}`, row('WINNERS', s.wins), row('LOSERS', s.losses), '');
    L.push('By time of day:'); for (const [k, b] of Object.entries(s.byBucket)) L.push(`  ${k.padEnd(13)} n${b.n} wins ${b.wins} avg ${f(b.avgPct)}%`);
    L.push('', 'By source:'); for (const [k, b] of Object.entries(s.bySource)) L.push(`  ${k.padEnd(13)} n${b.n} wins ${b.wins} avg ${f(b.avgPct)}%`);
    L.push('', 'READ WITH CARE: one day, a handful of trades, 5-minute spot data, and trades in the same cluster are one bet counted several times.',
        'Use this to form a question for the multi-day audit, not as a rule. A pattern only counts if it shows up on several different days.');
    return L.join('\n');
}


// ── Multi-day view (13 Oct) ────────────────────────────────────────────────────────────────────────────────────────
// Same read-only per-trade analysis, run for several IST days and pooled, plus a few fixed slices that match the questions written down
// for the unified audit (late entries, MTF-opposite entries, trades with / against the day's direction, "wobble" stops).
// Descriptive only: results are premium % as journaled (no brokerage / STT / slippage), small groups are flagged "thin".
function istDateOf(ts) { return new Date(ts + 330 * 60000).toISOString().slice(0, 10); }
function grp(a) {
    const closed = a.filter(r => r.state === 'CLOSED' && r.resultPct !== null);
    const byCl = new Map();
    for (const r of closed) { const c = byCl.get(r.cluster) || []; c.push(r.resultPct); byCl.set(r.cluster, c); }
    const clAvg = [...byCl.values()].map(v => v.reduce((x, y) => x + y, 0) / v.length);
    const sum = closed.reduce((x, r) => x + r.resultPct, 0);
    return {
        n: closed.length, wins: closed.filter(r => r.resultPct > 0).length, avgPct: closed.length ? r1(sum / closed.length) : null,
        clusters: byCl.size, clusterWins: clAvg.filter(v => v > 0).length, clusterAvgPct: clAvg.length ? r1(clAvg.reduce((x, y) => x + y, 0) / clAvg.length) : null,
        thin: closed.length < 10 || byCl.size < 5,
    };
}
function isCounterMtf(r) { return (r.direction === 'BULLISH' && r.mtfAtEntry === 'BUY PUT') || (r.direction === 'BEARISH' && r.mtfAtEntry === 'BUY CALL'); }
function runJournalMultiDay(tradeRows, snapRows) {
    const trades = normalizeTrades(tradeRows), snaps = normalizeSnaps(snapRows);
    const days = [...new Set([...trades.map(t => istDateOf(t.fireTs)), ...snaps.map(x => istDateOf(x.ts))])].sort();
    const perDay = [], all = [];
    days.forEach((d, i) => {
        const dt = assignClusters(trades.filter(t => istDateOf(t.fireTs) === d)), ds = snaps.filter(x => istDateOf(x.ts) === d);
        const first = ds.length ? ds[0].nifty : null, last = ds.length ? ds[ds.length - 1].nifty : null;
        const movePct = first && last ? r2((last - first) / first * 100) : null;
        const dayType = movePct === null ? null : movePct <= -0.3 ? 'DOWN' : movePct >= 0.3 ? 'UP' : 'FLAT';
        const rows = dt.map(t => { const r = analyzeTrade(t, ds); r.cluster = i * 1000 + t.cluster; r.date = d; r.dayType = dayType;
            r.withDay = dayType === 'FLAT' || dayType === null ? null : ((r.direction === 'BEARISH') === (dayType === 'DOWN')); return r; });
        all.push(...rows);
        if (rows.length) perDay.push({ date: d, movePct, dayType, snapshots: ds.length, ...grp(rows) });
    });
    const closed = all.filter(r => r.state === 'CLOSED' && r.resultPct !== null);
    const stops = closed.filter(r => /^stop/i.test(r.exitReason || ''));
    const withAfter = stops.filter(r => r.afterPts[60] !== null && r.afterPts[60] !== undefined);
    const slices = {
        late95: { late: grp(closed.filter(r => r.rangeDoneAtEntry !== null && r.rangeDoneAtEntry >= 0.95)), notLate: grp(closed.filter(r => r.rangeDoneAtEntry !== null && r.rangeDoneAtEntry < 0.95)) },
        counterMtf: { counter: grp(closed.filter(isCounterMtf)), other: grp(closed.filter(r => !isCounterMtf(r))) },
        dayDirection: { withDay: grp(closed.filter(r => r.withDay === true)), againstDay: grp(closed.filter(r => r.withDay === false)), flatDay: grp(closed.filter(r => r.withDay === null)) },
        wobbleStops: { stops: stops.length, haveAfter60: withAfter.length, resumed60: withAfter.filter(r => r.afterPts[60] > 0).length, medAfter60: median(withAfter.map(r => r.afterPts[60])) },
    };
    return { days: perDay, trades: all, summary: summarize(all), pooled: grp(all), slices };
}
function formatJournalMultiDayText(st, from, to) {
    const L = [`JOURNAL MULTI-DAY STUDY — ${from} to ${to}`, '(read-only, descriptive. Premium % as journaled: brokerage, STT, slippage NOT included. Same strike+direction within ' + CLUSTER_GAP_MIN + ' min = one bet. Nothing here changes any rule.)', ''];
    if (!st.trades.length) { L.push('No Auto Journal Nifty trades in this window.'); return L.join('\n'); }
    const g = x => `n${x.n} wins ${x.wins} avg ${f(x.avgPct)}% | ${x.clusters} bets, ${x.clusterWins} won, avg/bet ${f(x.clusterAvgPct)}%${x.thin ? '  (thin — too few to read)' : ''}`;
    L.push('date        day move  type  trades  bets  wins  avg%   (avg per bet)');
    for (const d of st.days) L.push([d.date, (d.movePct === null ? '--' : (d.movePct > 0 ? '+' : '') + d.movePct.toFixed(2) + '%').padStart(8), String(d.dayType || '--').padEnd(5), String(d.n).padStart(6), String(d.clusters).padStart(5), String(d.wins).padStart(5), f(d.avgPct).padStart(6), ('(' + f(d.clusterAvgPct) + ')').padStart(9)].join('  '));
    L.push('', 'ALL DAYS POOLED: ' + g(st.pooled), '');
    const s = st.summary, row = (name, x) => `  ${name.padEnd(7)} n${x.n} (${x.clusters} bets) | MFE ${f(x.medMfe)} MAE ${f(x.medMae)} | rangeDone ${x.medRangeDone === null ? '--' : Math.round(x.medRangeDone * 100) + '%'} | adx5 ${f(x.medAdx5)} | after60 ${f(x.medAfter60)} | resumed our way after 60m: ${x.resumed60}/${x.haveAfter60}`;
    L.push(row('WINNERS', s.wins), row('LOSERS', s.losses), '');
    L.push('By time of day:'); for (const [k, b] of Object.entries(s.byBucket)) L.push(`  ${k.padEnd(13)} n${b.n} wins ${b.wins} avg ${f(b.avgPct)}%`);
    L.push('', 'By source:'); for (const [k, b] of Object.entries(s.bySource)) L.push(`  ${k.padEnd(13)} n${b.n} wins ${b.wins} avg ${f(b.avgPct)}%`);
    const sl = st.slices;
    L.push('', 'AUDIT QUESTIONS (fixed in advance):',
        '  Late entry (95%+ of the day\'s range already travelled):', '    late     ' + g(sl.late95.late), '    not late ' + g(sl.late95.notLate),
        '  Entry opposite to the 5m MTF signal at that moment:', '    opposite ' + g(sl.counterMtf.counter), '    other    ' + g(sl.counterMtf.other),
        '  Trade direction vs the day\'s direction (day move >= 0.3% either way):', '    with day    ' + g(sl.dayDirection.withDay), '    against day ' + g(sl.dayDirection.againstDay), '    flat day    ' + g(sl.dayDirection.flatDay),
        `  Stop-losses: ${sl.wobbleStops.stops}; with 60-min-after data ${sl.wobbleStops.haveAfter60}; market went our way again after 60 min in ${sl.wobbleStops.resumed60} (median ${f(sl.wobbleStops.medAfter60)} pts).`,
        '    (a high share here only says stops were early on THESE days; it does not say a wider stop pays — that needs the exit-rule study with costs.)');
    L.push('', 'READ WITH CARE: ' + st.days.length + ' day(s), 5-minute spot data, and several slices looked at at once — some will look good by luck. Anything "thin" is noise.',
        'Only a pattern that holds on most days, in both halves of the period, and after costs counts. Use this to decide what to test, not as a rule.');
    return L.join('\n');
}

module.exports = { runJournalMultiDay, formatJournalMultiDayText, istDateOf, grp, isCounterMtf, runJournalDayStudy, formatJournalDayText, normalizeTrades, normalizeSnaps, assignClusters, analyzeTrade, summarize, snapAtOrBefore, snapAtOrAfter, istMinutesOfDay, istClock, bucketOf, median };