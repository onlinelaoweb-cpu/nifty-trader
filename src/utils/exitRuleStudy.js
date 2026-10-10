'use strict';
// ── Exit-rule study (10 Oct 2026) ───────────────────────────────────────────────────────────────────
// QUESTION: almost every exploratory trigger reaches an average peak of ~24% but the live Trade-Coach grid keeps only ~0.22 of
// it. Would different EXIT rules keep more? The rules tried come from the Trade-Coach grid itself plus ideas from a stop-loss
// webinar by Nitin Murarka (book 50% at the first +20-25% target, then trail the rest at cost; do not lock breakeven too early;
// time stop when nothing moves; cut a trade that goes against you straight away).
// HOW: replays the premium PATHS already stored in signal_outcome_path (~5-minute samples, up to 90 minutes). Every variant is
// run on the SAME declustered trades, and BASE must reproduce the live grid exactly (checked against simulateTradeCoachCore).
// A variant only counts if it beats BASE in BOTH the older and the newer half of the days AND the sample is big enough.
// HONEST LIMITS: ~5-minute samples (real stop/target orders fill closer to their trigger); a few days of one market regime;
// ~9 variants are tried so one or two will look good by luck; before brokerage and slippage. Research only — nothing here feeds
// signals, gates or alerts. PURE (no I/O).

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = v => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
const stats = a => ({ n: a.length, avg: r2(mean(a)), median: r2(median(a)), winPct: a.length ? Math.round(1000 * a.filter(v => v > 0).length / a.length) / 10 : null });

// rule: { slPct, beAt, halfAt, fullAt, trailGap, timeStop:{min,peak}, earlyCut:{withinMin,pct} }  (null = rule off)
// Same state machine as simulateTradeCoachCore (SL check, full target, half book, breakeven lock) plus three optional extras.
function simulateRule(entryPremium, path, fireTs, rule) {
    if (!(entryPremium > 0) || !Array.isArray(path) || !path.length) return null;
    const { slPct = -20, beAt = null, halfAt = null, fullAt = null, trailGap = null, timeStop = null, earlyCut = null } = rule || {};
    let remaining = 100, slLevel = slPct, realized = 0, reason = null, peak = -Infinity;
    for (const s of path) {
        if (remaining <= 0) break;
        const pct = ((s.premium - entryPremium) / entryPremium) * 100;
        const mins = Number.isFinite(fireTs) && Number.isFinite(s.ts) ? (s.ts - fireTs) / 60000 : null;
        if (pct > peak) peak = pct;
        if (pct <= slLevel) { realized += (remaining / 100) * pct; remaining = 0; reason = slLevel === 0 ? 'breakeven_stop' : slLevel > 0 ? 'trail_stop' : 'stop_loss'; break; }
        if (fullAt !== null && pct >= fullAt) { realized += (remaining / 100) * pct; remaining = 0; reason = 'full_target'; break; }
        if (remaining === 100 && earlyCut && mins !== null && mins <= earlyCut.withinMin && pct <= earlyCut.pct) {
            realized += pct; remaining = 0; reason = 'early_cut'; break;
        }
        if (remaining === 100 && timeStop && mins !== null && mins >= timeStop.min && peak < timeStop.peak) {
            realized += pct; remaining = 0; reason = 'time_stop'; break;
        }
        if (remaining === 100 && halfAt !== null && pct >= halfAt) { realized += 0.5 * pct; remaining = 50; }
        if (beAt !== null && slLevel < 0 && pct >= beAt) slLevel = 0;
        if (trailGap !== null && remaining === 50 && peak - trailGap > slLevel) slLevel = peak - trailGap;
    }
    if (remaining > 0) {
        const last = ((path[path.length - 1].premium - entryPremium) / entryPremium) * 100;
        realized += (remaining / 100) * last; reason = 'time_exit';
    }
    return { result: parseFloat(realized.toFixed(2)), reason };
}

// The tried rules, all derived from the live grid g = { slPct, breakevenAt, halfBookAt, fullExitAt }.
function buildVariants(g) {
    const base = { slPct: g.slPct, beAt: g.breakevenAt, halfAt: g.halfBookAt, fullAt: g.fullExitAt, trailGap: null, timeStop: null, earlyCut: null };
    return [
        { name: 'BASE', note: 'live grid, unchanged', rule: base },
        { name: 'BE_LATE_20', note: 'same grid but lock breakeven only at +20% (no early lock)', rule: { ...base, beAt: 20 } },
        { name: 'BOOK20_THEN_COST', note: 'book 50% at +20%, rest stops at cost, full exit +35%', rule: { ...base, halfAt: 20, beAt: 20, fullAt: 35 } },
        { name: 'BOOK25_TRAIL15', note: 'book 50% at +25%, trail the rest 15 points below its peak (no fixed target)', rule: { ...base, halfAt: 25, beAt: 25, fullAt: null, trailGap: 15 } },
        { name: 'BOOK20_TRAIL12', note: 'book 50% at +20%, trail the rest 12 points below its peak', rule: { ...base, halfAt: 20, beAt: 20, fullAt: null, trailGap: 12 } },
        { name: 'TIME_45', note: 'base + exit at 45 min if it never reached +5%', rule: { ...base, timeStop: { min: 45, peak: 5 } } },
        { name: 'TIME_60', note: 'base + exit at 60 min if it never reached +10%', rule: { ...base, timeStop: { min: 60, peak: 10 } } },
        { name: 'EARLY_CUT_8', note: 'base + exit within 15 min if the premium is already -8%', rule: { ...base, earlyCut: { withinMin: 15, pct: -8 } } },
        { name: 'COMBO', note: 'book 50% at +20%, trail 12, time stop 45 min / +5%', rule: { ...base, halfAt: 20, beAt: 20, fullAt: null, trailGap: 12, timeStop: { min: 45, peak: 5 } } },
    ];
}

const IST_MS = 330 * 60000;
function hourBucket(ts) {
    if (!Number.isFinite(ts)) return null;
    const d = new Date(ts + IST_MS), m = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (m < 10 * 60 + 30) return '09:15-10:30';
    if (m < 12 * 60) return '10:30-12:00';
    if (m < 14 * 60) return '12:00-14:00';
    return '14:00-15:30';
}

const istDay = ts => Number.isFinite(ts) ? new Date(ts + IST_MS).toISOString().slice(0, 10) : null;
const istWeekday = ts => Number.isFinite(ts) ? new Date(ts + IST_MS).getUTCDay() : null;   // 0 = Sunday ... 2 = Tuesday (NIFTY weekly expiry)

// Day gap % = first snapshot between 09:15 and 09:30 IST vs the last snapshot between 15:15 and 15:40 IST of the previous
// trading day that has one. snaps: [{ ts: Date|ms, nifty }]. Returns { 'YYYY-MM-DD': gapPct }.
function computeDayGaps(snaps) {
    const rows = (snaps || []).map(s => ({ ms: new Date(s.ts).getTime(), px: Number(s.nifty) })).filter(r => Number.isFinite(r.ms) && r.px > 0).sort((a, b) => a.ms - b.ms);
    const open = new Map(), close = new Map();
    for (const r of rows) {
        const d = new Date(r.ms + IST_MS), m = d.getUTCHours() * 60 + d.getUTCMinutes(), day = d.toISOString().slice(0, 10);
        if (m >= 9 * 60 + 15 && m <= 9 * 60 + 30 && !open.has(day)) open.set(day, r.px);
        if (m >= 15 * 60 + 15 && m <= 15 * 60 + 40) close.set(day, r.px);   // keeps the latest in the window
    }
    const days = [...new Set([...open.keys(), ...close.keys()])].sort(), out = {};
    for (const day of open.keys()) {
        // the previous day WITH snapshots must itself have a close one (otherwise we would compare against an older close and call it a gap), and be at most 4 calendar days back (weekend + a holiday)
        const prev = days.filter(x => x < day).pop();
        if (prev && close.has(prev) && (Date.parse(day) - Date.parse(prev)) / 86400000 <= 4) out[day] = Math.round(((open.get(day) / close.get(prev) - 1) * 100) * 100) / 100;
    }
    return out;
}

function decluster(items, minutes) {
    if (!minutes || minutes <= 0) return [...items];
    const bySrc = new Map();
    for (const o of items) { const k = o.source || ''; if (!bySrc.has(k)) bySrc.set(k, []); bySrc.get(k).push(o); }
    const kept = [];
    for (const list of bySrc.values()) {
        list.sort((a, b) => a.fireTs - b.fireTs); let last = -Infinity;
        for (const o of list) if (o.fireTs - last >= minutes * 60000) { kept.push(o); last = o.fireTs; }
    }
    return kept.sort((a, b) => a.fireTs - b.fireTs);
}

// outcomes: [{ id, source, fireTs(ms), entryPremium, path:[{ts(ms), premium}] }]
// opts: { declusterMin=30, minHalfN=30, minSourceN=15, referenceSim(entry, path, grid) -> {coachResult} for the faithfulness check }
function computeExitRuleStudy(outcomes, grid, opts = {}) {
    const minHalf = opts.minHalfN ?? 30, minSource = opts.minSourceN ?? 15;
    const usable = (outcomes || []).filter(o => o && o.entryPremium > 0 && Array.isArray(o.path) && o.path.length >= 3 && Number.isFinite(o.fireTs))
        .map(o => ({ ...o, path: [...o.path].sort((a, b) => a.ts - b.ts) }));
    const used = decluster(usable, opts.declusterMin ?? 30);
    const variants = buildVariants(grid);

    // one row per trade, one result per variant
    const rows = used.map(o => {
        const res = {};
        for (const v of variants) { const s = simulateRule(o.entryPremium, o.path, o.fireTs, v.rule); res[v.name] = s ? s.result : null; }
        return { fireTs: o.fireTs, source: o.source || '?', hour: hourBucket(o.fireTs), res, o };
    }).filter(r => variants.every(v => r.res[v.name] !== null)).sort((a, b) => a.fireTs - b.fireTs);

    // faithfulness: BASE must equal the live simulator on every trade
    let mismatches = null;
    if (typeof opts.referenceSim === 'function') {
        mismatches = 0;
        for (const r of rows) { const ref = opts.referenceSim(r.o.entryPremium, r.o.path, grid); if (!ref || Math.abs(ref.coachResult - r.res.BASE) > 0.011) mismatches++; }
    }

    const half = Math.floor(rows.length / 2);
    const older = rows.slice(0, half), newer = rows.slice(half);
    const avgOf = (list, name) => mean(list.map(r => r.res[name]));
    const sources = [...new Set(rows.map(r => r.source))];

    const out = variants.map(v => {
        const all = rows.map(r => r.res[v.name]);
        const delta = (list) => list.length ? r2(avgOf(list, v.name) - avgOf(list, 'BASE')) : null;
        const dOld = delta(older), dNew = delta(newer);
        let verdict;
        if (v.name === 'BASE') verdict = 'reference';
        else if (older.length < minHalf || newer.length < minHalf) verdict = `INSUFFICIENT — need ${minHalf}+ trades in each half (have ${older.length}/${newer.length})`;
        else if (dOld > 0 && dNew > 0) verdict = 'BEATS BASE IN BOTH HALVES — a lead to paper-test, not proof';
        else verdict = 'NOT PROVEN — does not beat BASE in both halves';
        const perSource = sources.map(src => {
            const l = rows.filter(r => r.source === src);
            return { source: src, n: l.length, baseAvg: r2(avgOf(l, 'BASE')), avg: r2(avgOf(l, v.name)), delta: r2(avgOf(l, v.name) - avgOf(l, 'BASE')) };
        }).filter(s => s.n >= minSource).sort((a, b) => b.n - a.n);
        return {
            name: v.name, note: v.note, rule: v.rule, ...stats(all),
            deltaVsBase: r2(mean(all) - mean(rows.map(r => r.res.BASE))),
            olderHalf: { n: older.length, delta: dOld }, newerHalf: { n: newer.length, delta: dNew },
            verdict, perSource,
        };
    });

    const hours = ['09:15-10:30', '10:30-12:00', '12:00-14:00', '14:00-15:30'];
    const byHour = hours.map(h => {
        const l = rows.filter(r => r.hour === h);
        const o = { bucket: h, n: l.length, avgByVariant: {} };
        for (const v of variants) o.avgByVariant[v.name] = l.length ? r2(avgOf(l, v.name)) : null;
        return o;
    });

    // Day-type slices (NIFTY only): weekly-expiry day (Tuesday) and gap days (|open vs previous close| >= gapPct).
    let byDayType = null;
    if (opts.nifty) {
        const gaps = opts.dayGaps || {}, gapMin = opts.gapPct ?? 0.4;
        const tag = r => {
            const day = istDay(r.fireTs), g = gaps[day];
            return { expiry: istWeekday(r.fireTs) === 2 ? 'expiry day (Tue)' : 'other days', gap: g === undefined ? 'gap unknown' : Math.abs(g) >= gapMin ? (g > 0 ? `gap-up >= ${gapMin}%` : `gap-down >= ${gapMin}%`) : `no gap (< ${gapMin}%)` };
        };
        const tagged = rows.map(r => ({ r, t: tag(r) }));
        const slice = (key) => [...new Set(tagged.map(x => x.t[key]))].sort().map(label => {
            const l = tagged.filter(x => x.t[key] === label).map(x => x.r);
            const o = { label, n: l.length, days: new Set(l.map(r => istDay(r.fireTs))).size, avgByVariant: {} };
            for (const v of variants) o.avgByVariant[v.name] = l.length ? r2(avgOf(l, v.name)) : null;
            return o;
        });
        byDayType = { expiry: slice('expiry'), gap: slice('gap') };
    }

    return {
        tradesUsed: rows.length, tradesBeforeDecluster: usable.length, grid,
        faithfulness: mismatches === null ? 'not checked' : mismatches === 0 ? 'OK — BASE reproduces the live simulator on every trade' : `WARNING — BASE differs from the live simulator on ${mismatches} trade(s)`,
        variants: out, byHour, ...(byDayType ? { byDayType } : {}),
    };
}

function formatExitRuleText(res) {
    const L = [];
    const f = v => v === null || v === undefined ? '-' : (v > 0 ? '+' : '') + v;
    L.push(`EXIT-RULE STUDY  (live grid ${JSON.stringify(res.grid)})`);
    L.push(`Trades used: ${res.tradesUsed} of ${res.tradesBeforeDecluster} (declustered). Before brokerage. Faithfulness: ${res.faithfulness}`);
    L.push('');
    L.push('VARIANT              avg%   median%  win%   vs BASE   older/newer half   verdict');
    for (const v of res.variants) {
        L.push(`${v.name.padEnd(20)} ${String(f(v.avg)).padStart(6)} ${String(f(v.median)).padStart(8)} ${String(v.winPct ?? '-').padStart(5)} ${String(f(v.deltaVsBase)).padStart(9)}   ${f(v.olderHalf.delta)} / ${f(v.newerHalf.delta)}`.padEnd(78) + `  ${v.verdict}`);
        L.push(`    ${v.note}`);
    }
    L.push('');
    const base = res.variants.find(v => v.name === 'BASE');
    if (base && base.perSource.length) {
        L.push('PER TRIGGER (avg % per trade; delta vs BASE in brackets)');
        const names = res.variants.filter(v => v.name !== 'BASE').map(v => v.name);
        for (const s of base.perSource) {
            const cells = names.map(n => { const ps = res.variants.find(v => v.name === n).perSource.find(x => x.source === s.source); return ps ? `${n}:${f(ps.avg)}(${f(ps.delta)})` : ''; });
            L.push(`  ${s.source} [n=${s.n}] BASE ${f(s.baseAvg)}  ->  ${cells.join('  ')}`);
        }
        L.push('');
    }
    L.push('BY TIME OF DAY (IST, signal fire time) — avg % per trade');
    for (const h of res.byHour) L.push(`  ${h.bucket}  n=${h.n}  BASE ${f(h.avgByVariant.BASE)}  ` + Object.entries(h.avgByVariant).filter(([k]) => k !== 'BASE').map(([k, v]) => `${k}:${f(v)}`).join('  '));
    if (res.byDayType) {
        for (const [title, key] of [['BY EXPIRY DAY (Tuesday) — avg % per trade', 'expiry'], ['BY GAP AT OPEN (vs previous close) — avg % per trade', 'gap']]) {
            L.push('');
            L.push(title);
            for (const s of res.byDayType[key]) L.push(`  ${s.label}  n=${s.n} (${s.days} day${s.days === 1 ? '' : 's'})  BASE ${f(s.avgByVariant.BASE)}  ` + Object.entries(s.avgByVariant).filter(([k]) => k !== 'BASE').map(([k, v]) => `${k}:${f(v)}`).join('  '));
        }
    }
    L.push('');
    L.push('A variant only counts if it beats BASE in BOTH halves with enough trades. ~9 variants are tried, so one or two look good by chance. Paper-test any lead before it becomes a rule.');
    return L.join('\n');
}

module.exports = { simulateRule, buildVariants, hourBucket, computeDayGaps, decluster, computeExitRuleStudy, formatExitRuleText };