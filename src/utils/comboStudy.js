// ── Trigger COMBINATION study (7 Oct) ─────────────────────────────────────
// Question: when two (or three) different exploratory triggers fire the SAME direction within a few
// minutes of each other, does the later one do better than usual? This replaces eyeballing one day's
// Telegram messages — one day has only a handful of events; the whole history has hundreds.
//
// HOW AN EVENT IS DEFINED
//   For every fire F (the "confirming" trigger), look back `windowMin` minutes for fires of OTHER sources
//   in the same direction. Each distinct partner source p gives a pair-combo {F.source, p}; each distinct
//   pair of partners gives a triple-combo. The event's outcome is F's own outcome (30-min direction result
//   and the Trade-Coach premium simulation) — i.e. what you would actually have got by entering when the
//   combo completed, not by looking at either trigger alone.
//
// WHY IT IS BUILT TO BE HARD TO FOOL
//   * DE-CLUSTERING: a combo that keeps re-firing every few minutes would count one market move ten
//     times. Within a combo, events closer than `declusterMin` minutes are dropped (their outcomes overlap).
//   * DAYS, not just trades: trades from the same day move together, so a combo needs >= minDays distinct
//     days as well as >= minN events.
//   * SPLIT-HALF CHECK: the days are cut into an older and a newer half; a combo only "holds" if its average
//     is positive in BOTH halves. Even with NO real edge, a random combo passes this about 1 time in 4 —
//     the result reports how many combos passed and how many would be expected by luck alone.
//   * Brahmastra is excluded by default: it fires BECAUSE other triggers agreed, so pairing it with its own
//     members is circular.
// Display/research only — nothing here feeds signals, gates or alerts.
//
// PURE: rows in, stats out (no I/O, no clock).

const IST_MS = 5.5 * 3600 * 1000;
const clampPct = v => Math.max(-100, Math.min(100, v));
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const r1 = v => v === null ? null : Math.round(v * 10) / 10;
const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dayKey = ms => new Date(ms + IST_MS).toISOString().slice(0, 10);   // IST calendar date

function summarize(events) {
    const resolved = events.filter(e => e.result === 'WIN' || e.result === 'LOSS' || e.result === 'FLAT');
    const wins = resolved.filter(e => e.result === 'WIN').length, losses = resolved.filter(e => e.result === 'LOSS').length;
    const coach = events.map(e => e.coach).filter(v => v !== null).map(clampPct);
    return {
        n: events.length,
        days: new Set(events.map(e => e.day)).size,
        dirN: wins + losses,
        dirWinPct: wins + losses > 0 ? r1(100 * wins / (wins + losses)) : null,
        flatPct: resolved.length ? r1(100 * resolved.filter(e => e.result === 'FLAT').length / resolved.length) : null,
        coachN: coach.length,
        coachAvg: coach.length ? r1(coach.reduce((a, b) => a + b, 0) / coach.length) : null,
        coachMedian: coach.length ? r1(median(coach)) : null,
        coachPositivePct: coach.length ? r1(100 * coach.filter(v => v > 0).length / coach.length) : null,
    };
}

function computeComboStudy(rows, opts = {}) {
    const windowMs = (opts.windowMin ?? 10) * 60000;
    const declusterMs = (opts.declusterMin ?? 30) * 60000;
    const minN = opts.minN ?? 30, minDays = opts.minDays ?? 4, topK = opts.topK ?? 12;
    const sizes = (opts.sizes && opts.sizes.length ? opts.sizes : [2, 3]).filter(s => s === 2 || s === 3);
    const exclude = new Set(opts.exclude ?? ['Brahmastra']);
    const minHalfN = opts.minHalfN ?? 10;

    // normalise + sort
    const data = [];
    for (const r of rows || []) {
        const ts = typeof r.fire_ts === 'number' ? r.fire_ts : Date.parse(r.fire_ts);
        if (!Number.isFinite(ts) || (r.direction !== 'BULLISH' && r.direction !== 'BEARISH') || !r.source) continue;
        data.push({ id: r.id, ts, src: String(r.source), dir: r.direction, result: r.result || null, coach: num(r.coach_result), day: dayKey(ts) });
    }
    data.sort((a, b) => a.ts - b.ts || (a.id ?? 0) - (b.id ?? 0));

    const baseline = summarize(data);
    const bySource = {};
    for (const d of data) (bySource[d.src] = bySource[d.src] || []).push(d);

    // ── build events ──
    const combos = new Map();   // key -> { sources, events: [] }
    const push = (key, srcs, ev) => { let c = combos.get(key); if (!c) { c = { sources: srcs, events: [] }; combos.set(key, c); } c.events.push(ev); };
    let lo = 0;
    for (let i = 0; i < data.length; i++) {
        const f = data[i];
        while (lo < i && data[lo].ts < f.ts - windowMs) lo++;
        if (exclude.has(f.src)) continue;
        const partners = new Set();
        for (let j = lo; j < i; j++) {
            const p = data[j];
            if (p.dir === f.dir && p.src !== f.src && !exclude.has(p.src)) partners.add(p.src);
        }
        if (!partners.size) continue;
        const ps = [...partners];
        if (sizes.includes(2)) for (const p of ps) { const srcs = [f.src, p].sort(); push(srcs.join(' + ') + ' | ' + f.dir, srcs, f); }
        if (sizes.includes(3)) for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) {
            const srcs = [f.src, ps[a], ps[b]].sort(); push(srcs.join(' + ') + ' | ' + f.dir, srcs, f);
        }
    }

    // ── de-cluster, summarise, split-half ──
    const out = [];
    let droppedByCluster = 0;
    for (const [key, c] of combos) {
        const evs = c.events.slice().sort((a, b) => a.ts - b.ts);
        const kept = []; let last = -Infinity;
        for (const e of evs) { if (e.ts - last >= declusterMs) { kept.push(e); last = e.ts; } else droppedByCluster++; }
        const stats = summarize(kept);
        const dayList = [...new Set(kept.map(e => e.day))].sort();
        const cut = dayList[Math.floor(dayList.length / 2)];                 // first day of the newer half
        const older = kept.filter(e => e.day < cut), newer = kept.filter(e => e.day >= cut);
        const so = summarize(older), sn = summarize(newer);
        const qualifies = stats.n >= minN && stats.days >= minDays && stats.coachN >= Math.min(minN, 10);
        // "testable" = BOTH halves have enough premium results to judge. When the premium simulation only exists for
        // the newer days (it started later than the direction tracking), a combo cannot be tested — that is NOT the same as failing.
        const testable = qualifies && dayList.length >= 2 && so.coachN >= minHalfN && sn.coachN >= minHalfN;
        const holds = testable && so.coachAvg > 0 && sn.coachAvg > 0;
        out.push({
            combo: key.split(' | ')[0], direction: key.split(' | ')[1], size: c.sources.length, ...stats, qualifies, testable, holds,
            verdict: !qualifies ? 'TOO FEW' : !testable ? 'UNTESTABLE (premium results cover only one half)' : holds ? 'HOLDS' : 'FAILS',
            olderHalf: { n: so.n, coachN: so.coachN, coachAvg: so.coachAvg, dirWinPct: so.dirWinPct },
            newerHalf: { n: sn.n, coachN: sn.coachN, coachAvg: sn.coachAvg, dirWinPct: sn.dirWinPct },
        });
    }
    const q = out.filter(x => x.qualifies);
    const byAvg = (a, b) => (b.coachAvg ?? -1e9) - (a.coachAvg ?? -1e9);
    const best = q.slice().sort(byAvg).slice(0, topK);
    const worst = q.slice().sort((a, b) => -byAvg(a, b)).slice(0, topK);
    const holdsCount = q.filter(x => x.holds).length;
    return {
        params: { windowMin: windowMin(opts), declusterMin: opts.declusterMin ?? 30, minN, minDays, sizes, exclude: [...exclude] },
        fires: data.length, days: baseline.days, baseline,
        perSource: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, summarize(v)])),
        combosTested: out.length, qualifying: q.length, qualifyingTestable: q.filter(x => x.testable).length, holdsBothHalves: holdsCount,
        // P(both halves positive | no edge) ≈ 1/4 — and only combos that CAN be tested can pass, so only they count
        expectedByLuckAlone: Math.round(q.filter(x => x.testable).length * 0.25 * 10) / 10,
        droppedByDeclustering: droppedByCluster,
        best, worst,
        holding: q.filter(x => x.holds).sort(byAvg).slice(0, topK),
        // Only when asked (opts.includeAll): EVERY combo that completed, even with 1 event or no premium data —
        // used by the one-day audit, where nothing can reach minN. Most events first.
        ...(opts.includeAll ? { all: out.slice().sort((a, b) => b.n - a.n || (b.coachAvg ?? -1e9) - (a.coachAvg ?? -1e9)) } : {}),
    };
}
function windowMin(o) { return o.windowMin ?? 10; }

// ── SINGLE-TRIGGER study ──────────────────────────────────────────────────
// Same safeguards as the combination study, applied to each trigger on its own, so that "Brahmastra shows +4.7%"
// can be tested instead of believed: de-clustered (events of one trigger closer than declusterMin are merged),
// needs distinct DAYS, and the older-half / newer-half check ("holds" = positive Trade-Coach average in BOTH).
// With K triggers tested, SOME will look good by chance: expectedByLuckAlone is 25% of those that qualify.
// opts: { declusterMin=30, minN=30, minDays=4, minHalfN=10, bySide=false (split BULLISH/BEARISH) }
// Display/research only. PURE.
function computeTriggerStudy(rows, opts = {}) {
    const declusterMs = (opts.declusterMin ?? 30) * 60000;
    const minN = opts.minN ?? 30, minDays = opts.minDays ?? 4, minHalfN = opts.minHalfN ?? 10, minHalfDirN = opts.minHalfDirN ?? 8;
    const LOPSIDED_PCT = 80;
    const data = [];
    for (const r of rows || []) {
        const ts = typeof r.fire_ts === 'number' ? r.fire_ts : Date.parse(r.fire_ts);
        if (!Number.isFinite(ts) || (r.direction !== 'BULLISH' && r.direction !== 'BEARISH') || !r.source) continue;
        data.push({ id: r.id, ts, src: String(r.source), dir: r.direction, result: r.result || null, coach: num(r.coach_result), day: dayKey(ts) });
    }
    data.sort((a, b) => a.ts - b.ts || (a.id ?? 0) - (b.id ?? 0));
    const baselineRaw = summarize(data);
    // What an AVERAGE fire of that instrument earned, by direction. If the market trended, bullish fires have a tailwind
    // that has nothing to do with the trigger — so a trigger is also compared with a baseline of the SAME direction mix.
    const baseBull = summarize(data.filter(d => d.dir === 'BULLISH')), baseBear = summarize(data.filter(d => d.dir === 'BEARISH'));
    const groups = new Map();
    for (const d of data) {
        const key = opts.bySide ? `${d.src} | ${d.dir}` : d.src;
        let g = groups.get(key); if (!g) { g = { source: d.src, direction: opts.bySide ? d.dir : null, rows: [] }; groups.set(key, g); }
        g.rows.push(d);
    }
    const out = []; let dropped = 0;
    for (const g of groups.values()) {
        const kept = []; let last = -Infinity;
        for (const e of g.rows) { if (e.ts - last >= declusterMs) { kept.push(e); last = e.ts; } else dropped++; }
        const st = summarize(kept);
        const dayList = [...new Set(kept.map(e => e.day))].sort();
        const cut = dayList[Math.floor(dayList.length / 2)];
        const so = summarize(kept.filter(e => e.day < cut)), sn = summarize(kept.filter(e => e.day >= cut));
        const qualifies = st.n >= minN && st.days >= minDays && st.coachN >= Math.min(minN, 10);
        // premium-based check: needs enough premium results in BOTH halves; "can't test" is not "failed"
        const testable = qualifies && dayList.length >= 2 && so.coachN >= minHalfN && sn.coachN >= minHalfN;
        const holds = testable && so.coachAvg > 0 && sn.coachAvg > 0;
        // direction-based check (informational): the 30-min WIN/LOSS tracking covers the whole window
        const dirTestable = dayList.length >= 2 && so.dirN >= minHalfDirN && sn.dirN >= minHalfDirN;
        const dirHolds = dirTestable && so.dirWinPct > 50 && sn.dirWinPct > 50;
        const nb = kept.filter(e => e.dir === 'BULLISH').length, bullPct = kept.length ? r1(100 * nb / kept.length) : null;
        // baseline with the same bullish/bearish mix as this trigger
        let mixBase = null;
        if (kept.length) {
            const bb = baseBull.coachAvg, be = baseBear.coachAvg, wb = nb / kept.length;
            if (wb === 1) mixBase = bb; else if (wb === 0) mixBase = be; else if (bb !== null && be !== null) mixBase = wb * bb + (1 - wb) * be;
        }
        out.push({ source: g.source, direction: g.direction, rawFires: g.rows.length, ...st, qualifies, testable, holds,
            verdict: !qualifies ? 'TOO FEW' : !testable ? 'UNTESTABLE (premium results cover only one half)' : holds ? 'HOLDS' : 'FAILS',
            dirTestable, dirHolds,
            bullPct, lopsided: !opts.bySide && bullPct !== null && (bullPct >= LOPSIDED_PCT || bullPct <= 100 - LOPSIDED_PCT),
            vsBaseline: (st.coachAvg !== null && baselineRaw.coachAvg !== null) ? r1(st.coachAvg - baselineRaw.coachAvg) : null,
            vsMixBaseline: (st.coachAvg !== null && mixBase !== null) ? r1(st.coachAvg - mixBase) : null,
            olderHalf: { n: so.n, coachN: so.coachN, coachAvg: so.coachAvg, dirN: so.dirN, dirWinPct: so.dirWinPct },
            newerHalf: { n: sn.n, coachN: sn.coachN, coachAvg: sn.coachAvg, dirN: sn.dirN, dirWinPct: sn.dirWinPct } });
    }
    const byAvg = (a, b) => (b.coachAvg ?? -1e9) - (a.coachAvg ?? -1e9);
    const q = out.filter(x => x.qualifies), tq = q.filter(x => x.testable);
    return {
        params: { declusterMin: opts.declusterMin ?? 30, minN, minDays, minHalfN, minHalfDirN, bySide: !!opts.bySide },
        fires: data.length, days: baselineRaw.days, baseline: baselineRaw,
        baselineBySide: { BULLISH: { n: baseBull.n, coachAvg: baseBull.coachAvg, dirWinPct: baseBull.dirWinPct }, BEARISH: { n: baseBear.n, coachAvg: baseBear.coachAvg, dirWinPct: baseBear.dirWinPct } },
        triggersTested: out.length, qualifying: q.length, qualifyingTestable: tq.length, holdsBothHalves: q.filter(x => x.holds).length,
        expectedByLuckAlone: Math.round(tq.length * 0.25 * 10) / 10,   // only triggers that CAN be tested can pass by luck
        droppedByDeclustering: dropped,
        triggers: out.slice().sort((a, b) => (b.qualifies - a.qualifies) || byAvg(a, b)),
    };
}

module.exports = { computeComboStudy, computeTriggerStudy, summarize, dayKey };