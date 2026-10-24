'use strict';
// ── Winner-anatomy study (24 Oct 2026) ──────────────────────────────────────────────────────────────────────
// QUESTIONS: (1) What do the BIG winners (top 10% of trades) and the ordinary winners look like at the moment of entry — which trigger,
// hour, weekday, premium level, how many triggers fired together, and how the premium behaved in the first 10 minutes?
// (2) Can an exit rule (a trailing stop, or cutting early if the trade is not working) keep more of the big winners than a plain stop?
// WHY: the scalp-cost study showed the profit sits in a few trend days and the median trade loses. If those few trades can be recognised
// early, a rule could be built around them; if they cannot, the honest answer is that they are luck and risk control is the only edge.
// HOW: signals fired within CLUSTER minutes in the SAME direction (any trigger) are ONE independent event — the first signal is the entry,
// and "confluence" is how many different triggers fired in that window. Each event is replayed on its stored premium path (~5 min samples)
// under 5 exit rules, with slippage + charges. Classes use the SL15 result (the same rule as the forward test).
// HONEST LIMITS: ~18 days of one regime; maybe 10-30 big events, so every bucket below is tiny. Features were looked at AFTER the fact, with
// many buckets, so a "lift" is a LEAD to test forward, never proof. 5-minute samples: trail/stop fills are approximate (stop checked
// before the new peak = conservative). Nothing here feeds signals or alerts. PURE (no I/O).

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const r2 = v => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
const IST = 5.5 * 3600000;
const istDay = ts => new Date(ts + IST).toISOString().slice(0, 10);
const istWeekday = ts => new Date(ts + IST).getUTCDay();
const istStamp = ts => new Date(ts + IST).toISOString().slice(0, 16).replace('T', ' ');
const istMinutes = ts => { const d = new Date(ts + IST); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const median = a => { if (!a.length) return null; const x = [...a].sort((p, q) => p - q), m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
const pf = list => { const w = list.filter(x => x > 0).reduce((s, x) => s + x, 0), l = -list.filter(x => x < 0).reduce((s, x) => s + x, 0); return l > 0 ? r2(w / l) : (w > 0 ? null : 0); };

const VARIANTS = [
    { name: 'HOLD', sl: null, act: null, gap: null, cutMin: null },
    { name: 'SL15', sl: 15, act: null, gap: null, cutMin: null },
    { name: 'SL15+CUT10', sl: 15, act: null, gap: null, cutMin: 10 },     // at ~10 min, if the premium is below entry, leave
    { name: 'TRAIL15/12', sl: 15, act: 15, gap: 12, cutMin: null },        // after +15 pts, stop follows the peak at 12 pts below
    { name: 'TRAIL25/20', sl: 15, act: 25, gap: 20, cutMin: null },        // after +25 pts, stop follows the peak at 20 pts below
];

// one trade on one path. Returns { exitPx, reason } or null. Stop is tested against the PREVIOUS peak, then the sample updates the peak.
function simulateRule(entry, path, fireTs, rule, timeoutMin, stopFill = 'worse') {
    if (!(entry > 0) || !Array.isArray(path) || !path.length || !Number.isFinite(fireTs)) return null;
    const limitTs = fireTs + timeoutMin * 60000;
    let peak = entry, lastPx = null, cutDone = false;
    for (const s of path) {
        if (!(s.premium > 0) || !Number.isFinite(s.ts)) continue;
        if (s.ts > limitTs) break;
        lastPx = s.premium;
        let stop = rule.sl !== null ? entry - rule.sl : null;
        if (rule.act !== null && peak >= entry + rule.act) stop = Math.max(stop !== null ? stop : -Infinity, peak - rule.gap);
        if (stop !== null && s.premium <= stop) return { exitPx: stopFill === 'level' ? stop : Math.min(stop, s.premium), reason: peak >= entry + (rule.act ?? Infinity) ? 'trail' : 'sl' };
        if (rule.cutMin !== null && !cutDone && s.ts >= fireTs + rule.cutMin * 60000) {
            cutDone = true;
            if (s.premium < entry) return { exitPx: s.premium, reason: 'cut' };
        }
        if (s.premium > peak) peak = s.premium;
    }
    if (lastPx === null) return null;
    return { exitPx: lastPx, reason: 'timeout' };
}

function tradeRupees(entry, exitPx, o) {
    const gross = (exitPx - entry) * o.qty, slip = 2 * o.slipPts * o.qty;
    const charges = o.qty * (entry + exitPx) * (o.chargePct / 100) + o.brokerage;
    return { gross, cost: slip + charges, net: gross - slip - charges };
}

// signals within `minutes` of the first signal, same direction -> one event (first signal is the entry); confluence = distinct triggers
function buildEvents(items, minutes) {
    const list = [...items].sort((a, b) => a.fireTs - b.fireTs), events = [], open = new Map();
    for (const o of list) {
        const key = o.direction || '?', cur = open.get(key);
        if (cur && o.fireTs - cur.fireTs < minutes * 60000) { cur.sources.add(o.source || '?'); cur.signals++; continue; }
        const ev = { ...o, sources: new Set([o.source || '?']), signals: 1 };
        open.set(key, ev); events.push(ev);
    }
    return events.map(e => ({ ...e, confluence: e.sources.size }));
}

function earlyMovePct(entry, path, fireTs) {      // premium change % at the sample closest to +10 min (7.5 to 12.5 min), else null
    let best = null, bd = Infinity;
    for (const s of path) {
        if (!(s.premium > 0)) continue;
        const d = Math.abs(s.ts - (fireTs + 10 * 60000));
        if (d <= 2.5 * 60000 && d < bd) { bd = d; best = s.premium; }
    }
    return best === null ? null : 100 * (best - entry) / entry;
}

const FEATURES = {
    confluence: e => e.confluence >= 3 ? '3+ triggers together' : (e.confluence === 2 ? '2 triggers together' : '1 trigger alone'),
    hour: e => { const m = istMinutes(e.fireTs); return m < 630 ? '09:15-10:30' : m < 720 ? '10:30-12:00' : m < 810 ? '12:00-13:30' : '13:30-15:30'; },
    day: e => istWeekday(e.fireTs) === 2 ? 'Tuesday (expiry)' : 'other days',
    premium: e => e.entryPremium < 60 ? 'entry premium < 60' : e.entryPremium < 100 ? 'entry 60-100' : e.entryPremium < 150 ? 'entry 100-150' : 'entry 150+',
    direction: e => e.direction || '?',
    trigger: e => [...e.sources][0],
    early10: e => e.early === null ? 'no 10-min sample' : e.early < -5 ? '10 min: down more than 5%' : e.early < 0 ? '10 min: down 0-5%' : e.early < 5 ? '10 min: up 0-5%' : e.early < 10 ? '10 min: up 5-10%' : '10 min: up 10%+',
};

function computeWinnerStudy(outcomes, opts = {}) {
    const o = {
        clusterMin: opts.clusterMin ?? 30, timeoutMin: opts.timeoutMin ?? 60, stopFill: opts.stopFill === 'level' ? 'level' : 'worse',
        slipPts: opts.slipPts ?? 0.5, chargePct: opts.chargePct ?? 0.07, brokerage: opts.brokerage ?? 0, qty: opts.qty ?? 130,
        minPremium: opts.minPremium ?? 10, minEvents: opts.minEvents ?? 40, minBucket: opts.minBucket ?? 12, bigPct: opts.bigPct ?? 10,
    };
    const all = Array.isArray(outcomes) ? outcomes : [];
    const usable = all.filter(x => x && x.entryPremium >= o.minPremium && Array.isArray(x.path) && x.path.length >= 3 && Number.isFinite(x.fireTs))
        .map(x => ({ ...x, path: [...x.path].sort((a, b) => a.ts - b.ts) }));
    const events = buildEvents(usable, o.clusterMin);
    const rows = [];
    for (const e of events) {
        const res = {}; let ok = true;
        for (const v of VARIANTS) {
            const s = simulateRule(e.entryPremium, e.path, e.fireTs, v, o.timeoutMin, o.stopFill);
            if (!s) { ok = false; break; }
            res[v.name] = { ...tradeRupees(e.entryPremium, s.exitPx, o), exitPx: s.exitPx, reason: s.reason };
        }
        if (!ok) continue;
        let peak = e.entryPremium; for (const s of e.path) { if (s.ts > e.fireTs + o.timeoutMin * 60000) break; if (s.premium > peak) peak = s.premium; }
        rows.push({ ...e, day: istDay(e.fireTs), early: earlyMovePct(e.entryPremium, e.path, e.fireTs), peak, res });
    }
    rows.sort((a, b) => a.fireTs - b.fireTs);
    const n = rows.length, days = new Set(rows.map(r => r.day)).size;

    const variants = VARIANTS.map(v => {
        const nets = rows.map(r => r.res[v.name].net), half = Math.floor(n / 2);
        const total = nets.reduce((s, x) => s + x, 0), avg = n ? total / n : null;
        const sorted = [...nets].sort((a, b) => b - a), trim = sorted.slice(Math.ceil(n * 0.1));
        const exTop = trim.length ? mean(trim) : null, best = n ? sorted[0] : null;
        const oAvg = half ? mean(nets.slice(0, half)) : null, nAvg = n - half ? mean(nets.slice(half)) : null;
        let verdict;
        if (n < o.minEvents) verdict = 'TOO FEW EVENTS';
        else if (avg <= 0) verdict = 'LOSES AFTER COSTS';
        else if (exTop <= 0) verdict = 'POSITIVE, OUTLIER-DRIVEN';
        else if (oAvg > 0 && nAvg > 0) verdict = 'PASS';
        else verdict = 'POSITIVE, NOT PROVEN';
        return {
            name: v.name, n, netAvgRs: r2(avg), netTotalRs: r2(total), medianNetRs: r2(median(nets)), netAvgExTop10Rs: r2(exTop), bestNetRs: r2(best),
            worstNetRs: r2(n ? sorted[n - 1] : null), winPct: n ? Math.round(1000 * nets.filter(x => x > 0).length / n) / 10 : null, profitFactor: pf(nets),
            bestSharePct: total > 0 && best > 0 ? r2(100 * best / total) : null, older: { n: half, netAvgRs: r2(oAvg) }, newer: { n: n - half, netAvgRs: r2(nAvg) },
            avgHitReason: ['sl', 'trail', 'cut', 'timeout'].map(k => [k, n ? Math.round(1000 * rows.filter(r => r.res[v.name].reason === k).length / n) / 10 : 0]),
            verdict,
        };
    });

    // classes by SL15 result
    const focus = 'SL15', nets = rows.map(r => r.res[focus].net);
    const thr = n ? [...nets].sort((a, b) => b - a)[Math.max(0, Math.ceil(n * o.bigPct / 100) - 1)] : null;
    const cls = r => { const x = r.res[focus].net; return x > 0 && x >= thr ? 'big' : x > 0 ? 'avgwin' : 'loser'; };
    const totalProfit = nets.filter(x => x > 0).reduce((s, x) => s + x, 0);
    const classes = ['big', 'avgwin', 'loser'].map(c => {
        const rs = rows.filter(r => cls(r) === c), ns = rs.map(r => r.res[focus].net);
        return {
            cls: c, n: rs.length, netAvgRs: r2(mean(ns)), netTotalRs: r2(ns.reduce((s, x) => s + x, 0)),
            shareOfWinProfitPct: c === 'loser' || !totalProfit ? null : r2(100 * ns.reduce((s, x) => s + x, 0) / totalProfit),
            avgPeakGainPts: r2(mean(rs.map(r => r.peak - r.entryPremium))), avgConfluence: r2(mean(rs.map(r => r.confluence))), avgEarlyPct: r2(mean(rs.filter(r => r.early !== null).map(r => r.early))),
        };
    });
    const baseBig = n ? 100 * rows.filter(r => cls(r) === 'big').length / n : 0, baseWin = n ? 100 * rows.filter(r => r.res[focus].net > 0).length / n : 0;
    const profile = {};
    for (const [fname, fn] of Object.entries(FEATURES)) {
        const g = new Map();
        for (const r of rows) { const k = fn(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
        profile[fname] = [...g.entries()].map(([bucket, rs]) => {
            const bigPct = 100 * rs.filter(r => cls(r) === 'big').length / rs.length, winPct = 100 * rs.filter(r => r.res[focus].net > 0).length / rs.length;
            return { bucket, n: rs.length, days: new Set(rs.map(r => r.day)).size, bigPct: r2(bigPct), winPct: r2(winPct), netAvgRs: r2(mean(rs.map(r => r.res[focus].net))),
                liftBig: baseBig > 0 ? r2(bigPct / baseBig) : null, few: rs.length < o.minBucket };
        }).sort((a, b) => b.n - a.n);
    }
    const bigList = rows.filter(r => cls(r) === 'big').sort((a, b) => b.res[focus].net - a.res[focus].net).slice(0, 12).map(r => ({
        time: istStamp(r.fireTs), weekday: WD[istWeekday(r.fireTs)], trigger: [...r.sources][0], triggers: r.confluence, direction: r.direction || '?', entry: r2(r.entryPremium), peak: r2(r.peak),
        early10Pct: r2(r.early), netSL15: r2(r.res.SL15.net), netTrail: r2(r.res['TRAIL15/12'].net), netHold: r2(r.res.HOLD.net),
    }));
    return {
        params: o, signalsBefore: all.length, signalsUsed: usable.length, events: n, days, eventsPerDay: days ? r2(n / days) : null,
        bigThresholdRs: r2(thr), baseBigPct: r2(baseBig), baseWinPct: r2(baseWin), variants, classes, profile, bigList,
    };
}

function formatWinnerText(res, meta = {}) {
    const L = [], f = v => v === null || v === undefined ? '-' : (v > 0 ? '+' : '') + v, p = res.params;
    L.push(`WINNER ANATOMY  ${meta.instrument || 'NIFTY'}  (last ${meta.days || '?'} days)`);
    L.push(`${res.signalsUsed} signals -> ${res.events} independent EVENTS (same direction within ${p.clusterMin} min = one event, any trigger) over ${res.days} day(s) = ${res.eventsPerDay ?? '-'} events/day.`);
    L.push(`Exit: ${p.timeoutMin} min max. Costs: ${p.slipPts} pt slippage each side + ${p.chargePct}% charges each side + Rs ${p.brokerage} brokerage, qty ${p.qty}. Stop fill: ${p.stopFill === 'level' ? 'at the level (optimistic)' : 'level or WORSE (conservative)'}.`);
    L.push('');
    L.push('A) EXIT RULES on the same events (net Rs per event)');
    L.push('RULE         avg        median     best10%-removed  best      worst     win%  PF    best-trade share  older/newer          verdict');
    for (const v of res.variants) L.push(`${v.name.padEnd(12)} ${String(f(v.netAvgRs)).padEnd(10)} ${String(f(v.medianNetRs)).padEnd(10)} ${String(f(v.netAvgExTop10Rs)).padEnd(16)} ${String(f(v.bestNetRs)).padEnd(9)} ${String(f(v.worstNetRs)).padEnd(9)} ${String(v.winPct).padEnd(5)} ${String(v.profitFactor ?? '-').padEnd(5)} ${String(v.bestSharePct === null ? '-' : v.bestSharePct + '%').padEnd(17)} ${f(v.older.netAvgRs)} / ${f(v.newer.netAvgRs)}   ${v.verdict}`);
    L.push('   SL15+CUT10 = leave at ~10 min if below entry. TRAIL15/12 = after +15 pts the stop follows the peak 12 pts below. TRAIL25/20 = after +25 pts, 20 below.');
    L.push('');
    L.push(`B) WHO ARE THE WINNERS? (SL15 result; BIG = top ${p.bigPct}% of events, i.e. net >= Rs ${f(res.bigThresholdRs)}; base: ${res.baseBigPct}% big, ${res.baseWinPct}% winners)`);
    L.push('CLASS        events  avg net Rs   total net Rs   share of winners\' profit   avg peak gain (pts)  avg triggers together  avg 10-min move %');
    const nm = { big: 'BIG winner', avgwin: 'avg winner', loser: 'loser' };
    for (const c of res.classes) L.push(`${nm[c.cls].padEnd(12)} ${String(c.n).padEnd(7)} ${String(f(c.netAvgRs)).padEnd(12)} ${String(f(c.netTotalRs)).padEnd(14)} ${String(c.shareOfWinProfitPct === null ? '-' : c.shareOfWinProfitPct + '%').padEnd(26)} ${String(c.avgPeakGainPts).padEnd(20)} ${String(c.avgConfluence).padEnd(22)} ${f(c.avgEarlyPct)}`);
    L.push('');
    L.push('C) WHAT IS KNOWN AT ENTRY (or after 10 min) — chance of a BIG winner vs the base rate. lift 2.0 = twice as likely. "(few)" = under ' + p.minBucket + ' events, ignore.');
    const titles = { confluence: 'How many triggers fired together', hour: 'Time of day (IST)', day: 'Weekday', premium: 'Entry premium', direction: 'Direction', trigger: 'First trigger', early10: 'Premium move after 10 minutes (known only after entry)' };
    for (const [k, rows] of Object.entries(res.profile)) {
        L.push(titles[k] || k);
        for (const r of rows) L.push(`  ${r.bucket.padEnd(30)} n=${String(r.n).padStart(3)} (${r.days}d)  big ${String(r.bigPct).padStart(5)}%  lift ${String(r.liftBig ?? '-').padStart(4)}  win ${String(r.winPct).padStart(5)}%  net avg ${String(f(r.netAvgRs)).padStart(8)}${r.few ? '  (few)' : ''}`);
    }
    L.push('');
    L.push('D) THE BIG WINNERS (SL15 net Rs; what a trailing stop / plain hold would have given)');
    for (const b of res.bigList) L.push(`  ${b.time} ${b.weekday} ${String(b.trigger).padEnd(18)} ${b.direction} triggers=${b.triggers}  entry ${String(b.entry).padStart(7)} peak ${String(b.peak).padStart(7)}  10-min ${String(f(b.early10Pct)).padStart(6)}%   SL15 ${f(b.netSL15)}  TRAIL15/12 ${f(b.netTrail)}  HOLD ${f(b.netHold)}`);
    L.push('');
    L.push('READ THIS: 5 exit rules were tried and ~25 buckets looked at, on a handful of days and a few big events. A bucket that looks good is a hypothesis for the forward test, not a rule. If the lifts disappear when the test runs forward, the big winners were luck, and the edge (if any) is only in cutting losses.');
    return L.join('\n');
}

module.exports = { simulateRule, buildEvents, computeWinnerStudy, formatWinnerText, VARIANTS };