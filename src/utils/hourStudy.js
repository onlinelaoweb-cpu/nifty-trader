'use strict';
// ── Hour-of-day study (14 Oct 2026) ──────────────────────────────────────────
// Question: does the time of day a signal fires change how the Trade-Coach trade ends — AFTER costs, and in BOTH halves of the period?
// Source rows: signal_outcomes (instrument NIFTY, coach_result = Trade-Coach simulated result in % of entry premium).
// Safeguards (same spirit as the trigger / combo studies):
//   * DE-CLUSTER: events of one source closer than declusterMin minutes are merged (their outcomes overlap).
//   * COSTS: round trip = 2 x slippage points + 2 x charges% of entry premium + flat brokerage / quantity, turned into % of entry premium.
//   * SPLIT-HALF: distinct days are cut into an older and a newer half; an hour "holds" only if its NET average is positive in BOTH.
//   * LUCK WARNING: with K hours tested, about 25% of K pass the split-half test by chance alone; the result says how many were expected.
// Display / research only — nothing here feeds signals, gates or alerts. PURE: rows in, stats out (no I/O, no clock).

const IST_MS = 5.5 * 3600 * 1000;
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const r1 = v => v === null || v === undefined ? null : Math.round(v * 10) / 10;
const clampPct = v => Math.max(-100, Math.min(100, v));
const istParts = ts => { const d = new Date(ts + IST_MS); return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() }; };

const BUCKETS = [
    { label: '09:15-10:00', from: 555, to: 600 },
    { label: '10:00-11:00', from: 600, to: 660 },
    { label: '11:00-12:00', from: 660, to: 720 },
    { label: '12:00-13:00', from: 720, to: 780 },
    { label: '13:00-14:00', from: 780, to: 840 },
    { label: '14:00-14:30', from: 840, to: 870 },
    { label: '14:30+',      from: 870, to: 24 * 60 },
];
const bucketOf = min => BUCKETS.find(b => min >= b.from && min < b.to) || null;

// cost of one round trip, in % of the entry premium
function costPct(entryPremium, o) {
    if (!(entryPremium > 0)) return null;
    const pts = 2 * o.slipPts + 2 * entryPremium * (o.chargePct / 100) + (o.brokerage / Math.max(1, o.qty));
    return pts / entryPremium * 100;
}

function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function summarize(items) {
    const n = items.length;
    if (!n) return { n: 0, days: 0, avgGross: null, avgNet: null, medianNet: null, winPctNet: null };
    const net = items.map(e => e.net);
    return {
        n, days: new Set(items.map(e => e.day)).size,
        avgGross: r1(items.reduce((a, e) => a + e.gross, 0) / n), avgNet: r1(net.reduce((a, b) => a + b, 0) / n),
        medianNet: r1(median(net)), winPctNet: Math.round(net.filter(x => x > 0).length / n * 100),
    };
}

// rows: [{id, source, fire_ts, coach_result, entry_premium}]
// opts: { declusterMin=30, minN=20, minDays=4, minHalfN=8, slipPts=1, chargePct=0.07, brokerage=40, qty=130, minPremium=10, expiry:'all'|'only'|'exclude' (Tuesday) }
// minPremium: entries cheaper than this (premium points) are left out. A fixed 1-pt slippage + brokerage on a 2-pt option is a 100%+ "cost",
// which says nothing about the hour and drowns the average (first live run: 14:30+ showed net -67% vs gross +1.5%). Net is also floored at -100%.
function computeHourStudy(rows, opts = {}) {
    const o = {
        declusterMin: opts.declusterMin ?? 30, minN: opts.minN ?? 20, minDays: opts.minDays ?? 4, minHalfN: opts.minHalfN ?? 8,
        slipPts: opts.slipPts ?? 1, chargePct: opts.chargePct ?? 0.07, brokerage: opts.brokerage ?? 40, qty: opts.qty ?? 130, minPremium: opts.minPremium ?? 10,
        expiry: opts.expiry || 'all',
    };
    const data = []; let skipped = 0, lowPremium = 0;
    for (const r of rows || []) {
        const ts = typeof r.fire_ts === 'number' ? r.fire_ts : Date.parse(r.fire_ts);
        const res = num(r.coach_result), ep = num(r.entry_premium);
        if (!Number.isFinite(ts) || res === null || ep === null || !(ep > 0)) { skipped++; continue; }
        if (ep < o.minPremium) { lowPremium++; continue; }
        const p = istParts(ts), b = bucketOf(p.min);
        if (!b) { skipped++; continue; }                                    // before 09:15 / after midnight: ignore
        if (o.expiry === 'only' && p.dow !== 2) continue;
        if (o.expiry === 'exclude' && p.dow === 2) continue;
        const gross = clampPct(res), c = costPct(ep, o);
        data.push({ id: r.id, src: String(r.source || '?'), ts, day: p.day, bucket: b.label, gross, net: Math.max(-100, gross - c), cost: c });
    }
    data.sort((a, b) => a.ts - b.ts || (a.id ?? 0) - (b.id ?? 0));
    // de-cluster per source
    const lastBySrc = new Map(), kept = []; let dropped = 0;
    for (const e of data) {
        const last = lastBySrc.get(e.src) ?? -Infinity;
        if (e.ts - last >= o.declusterMin * 60000) { kept.push(e); lastBySrc.set(e.src, e.ts); } else dropped++;
    }
    const allDays = [...new Set(kept.map(e => e.day))].sort();
    const cut = allDays[Math.floor(allDays.length / 2)];                     // days < cut = older half, days >= cut = newer half
    const overall = summarize(kept);
    const hours = BUCKETS.map(b => {
        const items = kept.filter(e => e.bucket === b.label);
        const st = summarize(items);
        const so = summarize(items.filter(e => e.day < cut)), sn = summarize(items.filter(e => e.day >= cut));
        const qualifies = st.n >= o.minN && st.days >= o.minDays && so.n >= o.minHalfN && sn.n >= o.minHalfN;
        const holds = qualifies && so.avgNet > 0 && sn.avgNet > 0;
        let verdict;
        if (!st.n) verdict = 'no data';
        else if (!qualifies) verdict = 'thin — too few trades/days/half to read';
        else if (holds) verdict = 'positive after costs in BOTH halves (a lead, not proof)';
        else if (st.avgNet > 0) verdict = 'positive overall but fails a half — likely luck';
        else verdict = 'not positive after costs';
        return { bucket: b.label, ...st, olderHalf: { n: so.n, avgNet: so.avgNet }, newerHalf: { n: sn.n, avgNet: sn.avgNet }, vsOverallNet: st.avgNet === null || overall.avgNet === null ? null : r1(st.avgNet - overall.avgNet), qualifies, holds, verdict };
    });
    const qualifying = hours.filter(h => h.qualifies).length;
    return {
        params: o, cutDay: cut || null, daysCovered: allDays.length, dropped, skipped, lowPremium, overall, hours,
        passed: hours.filter(h => h.holds).length, qualifying, expectedByLuckAlone: r1(qualifying * 0.25),
    };
}

function formatHourText(res, meta = {}) {
    const f = v => v === null || v === undefined ? '-' : (v > 0 ? '+' : '') + v;
    const L = [];
    L.push(`HOUR-OF-DAY STUDY — ${meta.instrument || 'NIFTY'} | source ${meta.source || 'ALL'} | last ${meta.days ?? '?'} days | days with data ${res.daysCovered}`);
    L.push('(read-only. Result = Trade-Coach simulated trade, % of entry premium. NET = after costs. Nothing here changes any rule.)');
    L.push(`Costs per round trip: ${res.params.slipPts} pt slippage each side + ${res.params.chargePct}% charges each side + ₹${res.params.brokerage} brokerage over ${res.params.qty} units. De-cluster ${res.params.declusterMin} min per source. Expiry day (Tue): ${res.params.expiry}. Entries under ${res.params.minPremium} pts premium left out (${res.lowPremium ?? 0} rows); net floored at -100%.`);
    L.push(`Older/newer half cut at ${res.cutDay || '-'} (days before = older).`);
    L.push('');
    L.push(`ALL HOURS: n${res.overall.n} days ${res.overall.days} | gross ${f(res.overall.avgGross)}% net ${f(res.overall.avgNet)}% | win(net) ${res.overall.winPctNet ?? '-'}%`);
    L.push('');
    L.push('hour         n  days  gross%   net%  median%  win%   older/newer net%      vs all');
    for (const h of res.hours) {
        L.push(`${h.bucket.padEnd(12)} ${String(h.n).padStart(3)} ${String(h.days).padStart(5)} ${String(f(h.avgGross)).padStart(7)} ${String(f(h.avgNet)).padStart(6)} ${String(f(h.medianNet)).padStart(8)} ${String(h.winPctNet ?? '-').padStart(5)}   ${String(f(h.olderHalf.avgNet)).padStart(6)} / ${String(f(h.newerHalf.avgNet)).padEnd(6)}   ${String(f(h.vsOverallNet)).padStart(6)}   ${h.verdict}`);
    }
    L.push('');
    L.push(`${res.passed} of ${res.qualifying} qualifying hours pass the both-halves test; about ${res.expectedByLuckAlone} would pass by luck alone with no real effect.`);
    L.push('READ WITH CARE: 7 hours are looked at together, so one will look good by luck. A real lead must (1) hold in both halves, (2) stay positive after costs, (3) repeat on new days. Use this to decide what to paper-test, not as a rule.');
    return L.join('\n');
}

module.exports = { computeHourStudy, formatHourText, BUCKETS, costPct };