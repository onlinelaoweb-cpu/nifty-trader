'use strict';
// ── Scalp-cost study (24 Oct 2026) ──────────────────────────────────────────
// QUESTION: if every exploratory signal were traded as a quick scalp — a FIXED premium-point target and stop-loss, and out after a short
// timeout — what is left AFTER brokerage, charges and slippage? Also: how many trades a day that means, and what that costs per day.
// WHY: SEBI's studies show more trades = bigger losses, and costs eat small targets. This puts a rupee number on that for THIS app's
// own signals instead of guessing. It does NOT test the live Trade-Coach rules (that is exitRuleStudy) — it tests plain scalp rules.
// HOW: replays the premium PATHS already stored in signal_outcome_path (~5-minute samples) for each declustered signal.
//   * Every variant (target T pts, stop S pts) runs on the SAME trades. HOLD = no target/stop, just exit at the timeout (the baseline).
//     HOLD+SLn = no target, only a wide protective stop of n premium points (the risk-limited version of HOLD).
//   * Stop fills at the stop level OR WORSE (stopFill 'worse', default: the sampled premium if it already gapped below) or exactly AT the level
//     (stopFill 'level', optimistic). Run both to get a range. Target fills at the target level (limit order).
//   * Costs: slippage each side + percentage charges on entry and exit premium + flat brokerage per round trip (same model as hourStudy).
//   * A variant PASSES only if its net average is positive in BOTH the older and the newer half, with enough trades.
// HONEST LIMITS: path samples are ~5 minutes apart, so a 1-2 minute scalp CANNOT be resolved — fills are approximate and the stop/target
// order inside one 5-minute gap is unknown (stop is checked first = conservative). A few days of one market regime. ~13 variants are
// tried, so one or two can look good by chance. Charge rates are defaults — check them against your own contract note. Research only:
// nothing here feeds signals, gates or alerts. PURE (no I/O).

const { buildEvents } = require('./winnerAnatomy');
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const r2 = v => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
const IST = 5.5 * 3600000;
const istDay = ts => new Date(ts + IST).toISOString().slice(0, 10);
const istWeekday = ts => new Date(ts + IST).getUTCDay();                 // 0 Sun .. 6 Sat; NSE weekly NIFTY expiry = Tuesday (2)
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const istStamp = ts => new Date(ts + IST).toISOString().slice(0, 16).replace('T', ' ');
const median = a => { if (!a.length) return null; const x = [...a].sort((p, q) => p - q), m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };

// peak premium and the biggest sample-to-sample jump inside the window — used to flag suspicious readings
function pathStats(entry, path, fireTs, timeoutMin) {
    const limitTs = fireTs + timeoutMin * 60000;
    let peak = entry, prev = entry, jump = 1;
    for (const s of path) {
        if (!(s.premium > 0) || !Number.isFinite(s.ts)) continue;
        if (s.ts > limitTs) break;
        if (s.premium > peak) peak = s.premium;
        if (prev > 0) jump = Math.max(jump, s.premium / prev, prev / s.premium);
        prev = s.premium;
    }
    return { peak, jump };
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

// one scalp on one stored path. tp/sl in premium POINTS (null = off). Returns { exitPx, reason } or null.
function simulateScalp(entry, path, fireTs, tp, sl, timeoutMin, stopFill = 'worse') {
    if (!(entry > 0) || !Array.isArray(path) || !path.length || !Number.isFinite(fireTs)) return null;
    const limitTs = fireTs + timeoutMin * 60000;
    let lastPx = null, sawAny = false;
    for (const s of path) {
        if (!(s.premium > 0) || !Number.isFinite(s.ts)) continue;
        if (s.ts > limitTs) break;
        sawAny = true; lastPx = s.premium;
        if (sl !== null && s.premium <= entry - sl) return { exitPx: stopFill === 'level' ? entry - sl : Math.min(entry - sl, s.premium), reason: 'sl' };   // 'worse': stop-market level or worse; 'level': at the level
        if (tp !== null && s.premium >= entry + tp) return { exitPx: entry + tp, reason: 'tp' };                         // limit: at the level
    }
    if (!sawAny) return null;
    return { exitPx: lastPx, reason: 'timeout' };
}

// costs in rupees for one round trip
function tradeRupees(entry, exitPx, o) {
    const gross = (exitPx - entry) * o.qty;
    const slip = 2 * o.slipPts * o.qty;
    const charges = o.qty * (entry + exitPx) * (o.chargePct / 100) + o.brokerage;
    return { gross, cost: slip + charges, net: gross - slip - charges };
}

function buildVariants(tps, sls, slOnly = []) {
    const v = [{ name: 'HOLD', tp: null, sl: null }];
    for (const sl of slOnly) v.push({ name: `HOLD+SL${sl}`, tp: null, sl });
    for (const tp of tps) for (const sl of sls) v.push({ name: `TP${tp}/SL${sl}`, tp, sl });
    return v;
}

const pf = list => { const w = list.filter(x => x > 0).reduce((s, x) => s + x, 0), l = -list.filter(x => x < 0).reduce((s, x) => s + x, 0); return l > 0 ? r2(w / l) : (w > 0 ? null : 0); };

// outcomes: [{ id, source, fireTs(ms), entryPremium, path:[{ts(ms), premium}] }]
// opts: { declusterMin=30, timeoutMin=30, tps=[4,6,8,12], sls=[4,6,8], slOnly=[10,15,20,30], stopFill='worse'|'level', slipPts=1, chargePct=0.07, brokerage=40, qty=130, minPremium=10,
//         minN=60, minHalfN=25, minSourceN=15 }
function computeScalpCostStudy(outcomes, opts = {}) {
    const o = {
        declusterMin: opts.declusterMin ?? 30, timeoutMin: opts.timeoutMin ?? 30,
        tps: opts.tps || [4, 6, 8, 12], sls: opts.sls || [4, 6, 8], slOnly: Array.isArray(opts.slOnly) ? opts.slOnly : [10, 15, 20, 30],
        stopFill: opts.stopFill === 'level' ? 'level' : 'worse',
        slipPts: opts.slipPts ?? 1, chargePct: opts.chargePct ?? 0.07, brokerage: opts.brokerage ?? 40, qty: opts.qty ?? 130,
        minPremium: opts.minPremium ?? 10, minN: opts.minN ?? 60, minHalfN: opts.minHalfN ?? 25, minSourceN: opts.minSourceN ?? 15,
        expiry: ['only', 'exclude'].includes(opts.expiry) ? opts.expiry : 'all', focus: typeof opts.focus === 'string' && opts.focus ? opts.focus : 'HOLD',
    };
    const all = Array.isArray(outcomes) ? outcomes : [];
    const usable = all.filter(x => x && x.entryPremium >= o.minPremium && Array.isArray(x.path) && x.path.length >= 3 && Number.isFinite(x.fireTs))
        .filter(x => o.expiry === 'all' || (o.expiry === 'only') === (istWeekday(x.fireTs) === 2))
        .map(x => ({ ...x, path: [...x.path].sort((a, b) => a.ts - b.ts) }));
    const used = decluster(usable, o.declusterMin);
    const variants = buildVariants(o.tps, o.sls, o.slOnly);

    const rows = [];
    for (const t of used) {
        const res = {};
        let ok = true;
        for (const v of variants) {
            const s = simulateScalp(t.entryPremium, t.path, t.fireTs, v.tp, v.sl, o.timeoutMin, o.stopFill);
            if (!s) { ok = false; break; }
            res[v.name] = { ...tradeRupees(t.entryPremium, s.exitPx, o), reason: s.reason, exitPx: s.exitPx };
        }
        if (ok) rows.push({ fireTs: t.fireTs, source: t.source || '?', day: istDay(t.fireTs), wd: istWeekday(t.fireTs), entry: t.entryPremium, ...pathStats(t.entryPremium, t.path, t.fireTs, o.timeoutMin), res });
    }
    rows.sort((a, b) => a.fireTs - b.fireTs);
    const days = new Set(rows.map(r => r.day)).size;
    const half = Math.floor(rows.length / 2), older = rows.slice(0, half), newer = rows.slice(half);
    const netAvg = (list, name) => mean(list.map(r => r.res[name].net));

    const outVariants = variants.map(v => {
        const nets = rows.map(r => r.res[v.name].net), grosses = rows.map(r => r.res[v.name].gross), costs = rows.map(r => r.res[v.name].cost);
        const share = k => rows.length ? Math.round(1000 * rows.filter(r => r.res[v.name].reason === k).length / rows.length) / 10 : null;
        const oAvg = netAvg(older, v.name), nAvg = netAvg(newer, v.name), avg = mean(nets);
        // robustness: is the average carried by a few big winners? (median, worst trade, average WITHOUT the best 10% of trades)
        const sorted = [...nets].sort((a, b) => a - b);
        const k = Math.floor(sorted.length * 0.1);
        const exTop = k > 0 ? mean(sorted.slice(0, sorted.length - k)) : avg;
        const med = sorted.length ? (sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2) : null;
        let verdict;
        if (rows.length < o.minN) verdict = 'TOO FEW TRADES';
        else if (avg === null || avg <= 0) verdict = 'LOSES AFTER COSTS';
        else if (exTop !== null && exTop <= 0) verdict = 'POSITIVE, OUTLIER-DRIVEN';
        else if (older.length >= o.minHalfN && newer.length >= o.minHalfN && oAvg > 0 && nAvg > 0) verdict = 'PASS';
        else verdict = 'POSITIVE, NOT PROVEN';
        const perSource = [];
        for (const src of [...new Set(rows.map(r => r.source))]) {
            const list = rows.filter(r => r.source === src);
            if (list.length >= o.minSourceN) perSource.push({ source: src, n: list.length, netAvgRs: r2(mean(list.map(r => r.res[v.name].net))) });
        }
        return {
            name: v.name, tp: v.tp, sl: v.sl, n: rows.length,
            netAvgRs: r2(avg), netTotalRs: r2(nets.reduce((s, x) => s + x, 0)), grossAvgRs: r2(mean(grosses)), costAvgRs: r2(mean(costs)),
            winPct: rows.length ? Math.round(1000 * nets.filter(x => x > 0).length / rows.length) / 10 : null, profitFactor: pf(nets),
            hitTpPct: share('tp'), hitSlPct: share('sl'), timeoutPct: share('timeout'),
            medianNetRs: r2(med), worstNetRs: r2(sorted.length ? sorted[0] : null), bestNetRs: r2(sorted.length ? sorted[sorted.length - 1] : null), netAvgExTop10Rs: r2(exTop),
            older: { n: older.length, netAvgRs: r2(oAvg) }, newer: { n: newer.length, netAvgRs: r2(nAvg) }, verdict, perSource,
        };
    });

    // best / worst 5 trades of the focus variant — to eyeball for data glitches (e.g. a premium that jumps 3x in one sample)
    const focusName = variants.some(v => v.name === o.focus) ? o.focus : 'HOLD';
    const byNet = [...rows].sort((a, b) => a.res[focusName].net - b.res[focusName].net);
    const pick = r => ({
        time: istStamp(r.fireTs), weekday: WD[r.wd], source: r.source, entry: r2(r.entry), exit: r2(r.res[focusName].exitPx), peak: r2(r.peak),
        netRs: r2(r.res[focusName].net), reason: r.res[focusName].reason, maxJump: r2(r.jump),
        flag: (r.res[focusName].exitPx / r.entry >= 3 || r.jump >= 1.8) ? 'CHECK DATA' : '',
    });
    const extremes = { variant: focusName, best: byNet.slice(-5).reverse().map(pick), worst: byNet.slice(0, 5).map(pick) };

    // expiry day (Tuesday) vs other days, per variant
    const grp = (list, name) => ({ n: list.length, days: new Set(list.map(r => r.day)).size, netAvgRs: r2(mean(list.map(r => r.res[name].net))), medianNetRs: r2(median(list.map(r => r.res[name].net))) });
    const expRows = rows.filter(r => r.wd === 2), otherRows = rows.filter(r => r.wd !== 2);
    const expirySplit = variants.map(v => ({ name: v.name, expiry: grp(expRows, v.name), other: grp(otherRows, v.name) }));

    const holdCost = outVariants[0] ? outVariants[0].costAvgRs : null;
    const tradesPerDay = days ? r2(rows.length / days) : null;
    return {
        params: o, tradesBeforeDecluster: all.length, tradesUsed: rows.length, days, tradesPerDay,
        costPerTradeRs: holdCost, costPerDayRs: tradesPerDay !== null && holdCost !== null ? r2(tradesPerDay * holdCost) : null,
        variantsTried: variants.length - 1, variants: outVariants, extremes, expirySplit,
    };
}

function formatScalpCostText(res, meta = {}) {
    const L = [], f = v => v === null || v === undefined ? '-' : (v > 0 ? '+' : '') + v;
    const p = res.params;
    L.push(`SCALP-COST STUDY  ${meta.instrument || ''} ${meta.source || 'ALL'}  (last ${meta.days || '?'} days)`);
    L.push(`Trades used: ${res.tradesUsed} of ${res.tradesBeforeDecluster} (declustered ${p.declusterMin} min per trigger) over ${res.days} day(s) = ${f(res.tradesPerDay)} trades/day.`);
    L.push(`Stop fill: ${p.stopFill === 'level' ? 'AT the stop level (optimistic)' : 'at the level or WORSE (sampled premium) (conservative)'}.`);
    L.push(`Exit: target / stop in PREMIUM POINTS, or out after ${p.timeoutMin} min. Costs: ${p.slipPts} pt slippage each side + ${p.chargePct}% charges each side + Rs ${p.brokerage} brokerage, qty ${p.qty}.`);
    L.push(`Typical cost of ONE round trip: Rs ${res.costPerTradeRs} -> about Rs ${res.costPerDayRs} per day at this trade count (before any gain or loss).`);
    L.push('');
    L.push('VARIANT      net avg Rs  net total Rs  gross avg  cost avg  win%   PF   TP%  SL%  time%  older/newer net avg   verdict');
    for (const v of res.variants) {
        L.push(`${v.name.padEnd(11)} ${String(f(v.netAvgRs)).padStart(10)} ${String(f(v.netTotalRs)).padStart(13)} ${String(f(v.grossAvgRs)).padStart(10)} ${String(v.costAvgRs ?? '-').padStart(9)} ${String(v.winPct ?? '-').padStart(5)} ${String(v.profitFactor ?? '-').padStart(5)} ${String(v.hitTpPct ?? '-').padStart(4)} ${String(v.hitSlPct ?? '-').padStart(4)} ${String(v.timeoutPct ?? '-').padStart(5)}   ${String(f(v.older.netAvgRs)).padStart(7)} / ${String(f(v.newer.netAvgRs)).padEnd(7)}  ${v.verdict}`);
    }
    L.push('');
    L.push('ROBUSTNESS (net Rs per trade) — is the average carried by a few big winners?');
    L.push('VARIANT      average   median   best 10% removed   worst trade   best trade');
    for (const v of res.variants) {
        L.push(`${v.name.padEnd(11)} ${String(f(v.netAvgRs)).padStart(8)} ${String(f(v.medianNetRs)).padStart(8)} ${String(f(v.netAvgExTop10Rs)).padStart(18)} ${String(f(v.worstNetRs)).padStart(13)} ${String(f(v.bestNetRs)).padStart(12)}`);
    }
    if (res.extremes) {
        L.push('');
        L.push(`BEST 5 and WORST 5 TRADES — ${res.extremes.variant} (look for CHECK DATA: premium jumped 3x or more between samples = maybe a bad reading)`);
        const line = t => `  ${t.time} ${t.weekday}  ${String(t.source).padEnd(18)} entry ${String(t.entry).padStart(7)} -> exit ${String(t.exit).padStart(7)} (peak ${t.peak})  ${String(f(t.netRs)).padStart(10)}  ${t.reason}  maxJump x${t.maxJump} ${t.flag}`;
        res.extremes.best.forEach(t => L.push(line(t)));
        L.push('  ...');
        res.extremes.worst.forEach(t => L.push(line(t)));
    }
    if (res.expirySplit) {
        L.push('');
        L.push(`EXPIRY DAY (Tuesday) vs OTHER DAYS — net Rs per trade (average / median), n and days in brackets${p.expiry !== 'all' ? `   [filter: ${p.expiry}]` : ''}`);
        for (const e of res.expirySplit) {
            L.push(`${e.name.padEnd(11)} expiry ${String(f(e.expiry.netAvgRs)).padStart(8)} / ${String(f(e.expiry.medianNetRs)).padEnd(8)} (n=${e.expiry.n}, ${e.expiry.days}d)   other ${String(f(e.other.netAvgRs)).padStart(8)} / ${String(f(e.other.medianNetRs)).padEnd(8)} (n=${e.other.n}, ${e.other.days}d)`);
        }
    }
    const base = res.variants[0];
    if (base && base.perSource.length) {
        L.push('');
        L.push('PER TRIGGER (net avg Rs per trade, n in brackets) — HOLD vs the 3 best variants overall');
        const best = [...res.variants].filter(v => v.name !== 'HOLD').sort((a, b) => (b.netAvgRs ?? -1e9) - (a.netAvgRs ?? -1e9)).slice(0, 3);
        for (const s of base.perSource) {
            const cells = best.map(v => { const x = v.perSource.find(y => y.source === s.source); return x ? `${v.name}:${f(x.netAvgRs)}` : null; }).filter(Boolean);
            L.push(`  ${s.source} [n=${s.n}]  HOLD ${f(s.netAvgRs)}  ${cells.join('  ')}`);
        }
    }
    L.push('');
    L.push(`${res.variantsTried} variants are tried, so one or two can look good by chance — only PASS (positive in both halves, ${p.minN}+ trades, and still positive after removing the best 10% of trades) counts, and even that is a lead to paper-test, not proof.`);
    L.push('Path samples are ~5 min apart: a 1-2 minute scalp cannot be resolved here, fills are approximate. Check charge rates against your own contract note.');
    return L.join('\n');
}

// ── Forward test (24 Oct 2026) ───────────────────────────────────────────────────────────────────────────────
// ONE rule, written down BEFORE seeing any new data, judged only on signals that fire AFTER the start date. Nothing is tuned afterwards.
// Why: the study above looked at the past with 16 variants — a lead, not proof. This asks the clean question: does the one rule that looked
// best in the past still make money on signals nobody had seen yet? Record-only: the app already records every signal and its premium
// path (signal_outcomes / signal_outcome_path); this just replays that path under the fixed rule. It places no order and changes no signal.
const FORWARD_RULE = { name: 'HOLD+SL15, 60 min', tp: null, sl: 15, timeoutMin: 60, stopFill: 'worse', slipPts: 0.5, chargePct: 0.07, brokerage: 0, qty: 130, declusterMin: 30, minPremium: 10 };
const FORWARD_CRITERIA = { minTrades: 300, minDays: 10, minProfitFactor: 1.1, maxBestTradeSharePct: 15 };

// outcomes: same shape as computeScalpCostStudy; opts: { startTs (ms), rule?, criteria? }
function evaluateForward(outcomes, opts = {}) {
    const rule = { ...FORWARD_RULE, ...(opts.rule || {}) }, crit = { ...FORWARD_CRITERIA, ...(opts.criteria || {}) };
    const startTs = Number.isFinite(opts.startTs) ? opts.startTs : 0;
    const all = Array.isArray(outcomes) ? outcomes : [];
    const usable = all.filter(x => x && x.fireTs >= startTs && x.entryPremium >= rule.minPremium && Array.isArray(x.path) && x.path.length >= 3 && Number.isFinite(x.fireTs))
        .map(x => ({ ...x, path: [...x.path].sort((a, b) => a.ts - b.ts) }));
    const used = decluster(usable, rule.declusterMin);
    const rows = [];
    for (const t of used) {
        const s = simulateScalp(t.entryPremium, t.path, t.fireTs, rule.tp, rule.sl, rule.timeoutMin, rule.stopFill);
        if (!s) continue;
        rows.push({ fireTs: t.fireTs, day: istDay(t.fireTs), source: t.source || '?', ...tradeRupees(t.entryPremium, s.exitPx, rule), reason: s.reason });
    }
    rows.sort((a, b) => a.fireTs - b.fireTs);
    // INFO ONLY (does not change PASS/FAIL): the same rule on independent EVENTS — triggers firing together in the same direction count once
    const evNets = [];
    for (const e of buildEvents(usable, rule.declusterMin)) {
        const s = simulateScalp(e.entryPremium, e.path, e.fireTs, rule.tp, rule.sl, rule.timeoutMin, rule.stopFill);
        if (s) evNets.push(tradeRupees(e.entryPremium, s.exitPx, rule).net);
    }
    const evTotal = evNets.reduce((a, b) => a + b, 0), evBest = evNets.length ? Math.max(...evNets) : null;
    const events = { n: evNets.length, netAvgRs: r2(evNets.length ? evTotal / evNets.length : null), netTotalRs: r2(evTotal), bestSharePct: evTotal > 0 && evBest > 0 ? r2(100 * evBest / evTotal) : null };
    const nets = rows.map(r => r.net), n = rows.length, days = new Set(rows.map(r => r.day)).size;
    const total = nets.reduce((s, x) => s + x, 0), avg = n ? total / n : null;
    const half = Math.floor(n / 2), oAvg = half ? mean(nets.slice(0, half)) : null, nAvg = n - half ? mean(nets.slice(half)) : null;
    const best = n ? Math.max(...nets) : null, worst = n ? Math.min(...nets) : null;
    const bestShare = total > 0 && best > 0 ? 100 * best / total : null;
    const dailyMap = new Map();
    for (const r of rows) { const d = dailyMap.get(r.day) || { day: r.day, n: 0, netRs: 0 }; d.n++; d.netRs += r.net; dailyMap.set(r.day, d); }
    const daily = [...dailyMap.values()].map(d => ({ day: d.day, n: d.n, netRs: r2(d.netRs) }));
    const profitFactor = pf(nets);
    const criteria = [
        { name: 'enough trades', need: `>= ${crit.minTrades}`, have: n, ok: n >= crit.minTrades },
        { name: 'enough trading days', need: `>= ${crit.minDays}`, have: days, ok: days >= crit.minDays },
        { name: 'net average after costs', need: '> 0', have: r2(avg), ok: avg !== null && avg > 0 },
        { name: 'older half AND newer half', need: 'both > 0', have: `${r2(oAvg)} / ${r2(nAvg)}`, ok: oAvg !== null && nAvg !== null && oAvg > 0 && nAvg > 0 },
        { name: 'profit factor', need: `>= ${crit.minProfitFactor}`, have: profitFactor, ok: profitFactor === null ? total > 0 : profitFactor >= crit.minProfitFactor },
        { name: 'best single trade share of total profit (not one lucky trade)', need: `<= ${crit.maxBestTradeSharePct}%`, have: bestShare === null ? '-' : r2(bestShare) + '%', ok: total > 0 && bestShare !== null && bestShare <= crit.maxBestTradeSharePct },
    ];
    const enough = criteria[0].ok && criteria[1].ok;
    const failed = criteria.filter(c => !c.ok).map(c => c.name);
    return {
        rule, criteria: crit, startTs: startTs || null, tradesBeforeDecluster: all.length, trades: n, days,
        netAvgRs: r2(avg), netTotalRs: r2(total), medianNetRs: r2(median(nets)), worstNetRs: r2(worst), bestNetRs: r2(best), profitFactor,
        winPct: n ? Math.round(1000 * nets.filter(x => x > 0).length / n) / 10 : null,
        older: { n: half, netAvgRs: r2(oAvg) }, newer: { n: n - half, netAvgRs: r2(nAvg) }, daily, checks: criteria, events,
        status: !enough ? 'COLLECTING' : (failed.length ? 'FAIL' : 'PASS'),
        reasons: !enough ? [`need ${crit.minTrades} trades over ${crit.minDays} trading days (have ${n} / ${days})`] : failed,
    };
}

function formatForwardText(res, meta = {}) {
    const L = [], f = v => v === null || v === undefined ? '-' : (v > 0 ? '+' : '') + v, r = res.rule;
    L.push(`SCALP FORWARD TEST  NIFTY  (signals fired on or after ${meta.start || '?'} only)`);
    L.push(`RULE (fixed in advance): ${r.name} — no target, stop ${r.sl} premium pts (fills at the level or worse), exit after ${r.timeoutMin} min. Costs: ${r.slipPts} pt slippage each side + ${r.chargePct}% charges each side + Rs ${r.brokerage} brokerage, qty ${r.qty}. Signals declustered ${r.declusterMin} min per trigger.`);
    L.push(`STATUS: ${res.status}${res.status === 'COLLECTING' ? '  (interim numbers below mean nothing yet)' : ''}`);
    res.reasons.forEach(x => L.push(`  - ${x}`));
    L.push('');
    L.push(`Trades ${res.trades} over ${res.days} day(s). Net avg ${f(res.netAvgRs)} Rs, total ${f(res.netTotalRs)} Rs, median ${f(res.medianNetRs)}, win ${res.winPct ?? '-'}%, PF ${res.trades ? (res.profitFactor ?? '-') : '-'}, worst ${f(res.worstNetRs)}, best ${f(res.bestNetRs)}.`);
    L.push(`Older half ${f(res.older.netAvgRs)} (n=${res.older.n})  |  newer half ${f(res.newer.netAvgRs)} (n=${res.newer.n})`);
    if (res.events) L.push(`INDEPENDENT EVENTS (info only; triggers firing together in one direction count once): ${res.events.n} events, net avg ${f(res.events.netAvgRs)} Rs, total ${f(res.events.netTotalRs)} Rs, best event = ${res.events.bestSharePct === null ? '-' : res.events.bestSharePct + '%'} of profit. Trust THIS count for "how many real trades".`);
    L.push('');
    L.push('PASS CONDITIONS (all must hold once enough trades are in):');
    res.checks.forEach(c => L.push(`  [${c.ok ? 'x' : ' '}] ${c.name}: need ${c.need}, have ${c.have === null || c.have === undefined || c.have === 'null / null' ? '-' : c.have}`));
    if (res.daily.length) {
        L.push('');
        L.push('DAY BY DAY (trades, net Rs):');
        res.daily.forEach(d => L.push(`  ${d.day}  n=${String(d.n).padStart(3)}  ${f(d.netRs)}`));
    }
    L.push('');
    L.push('A pass is NOT proof and is NOT permission to trade this live — it means the idea survived a clean test on one regime; paper-trade it next. A fail means the earlier result was probably luck. Do not change the rule after looking.');
    return L.join('\n');
}

module.exports = { simulateScalp, tradeRupees, buildVariants, decluster, computeScalpCostStudy, formatScalpCostText, FORWARD_RULE, FORWARD_CRITERIA, evaluateForward, formatForwardText };