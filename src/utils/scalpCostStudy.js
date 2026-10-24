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

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const r2 = v => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
const IST = 5.5 * 3600000;
const istDay = ts => new Date(ts + IST).toISOString().slice(0, 10);

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
    };
    const all = Array.isArray(outcomes) ? outcomes : [];
    const usable = all.filter(x => x && x.entryPremium >= o.minPremium && Array.isArray(x.path) && x.path.length >= 3 && Number.isFinite(x.fireTs))
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
            res[v.name] = { ...tradeRupees(t.entryPremium, s.exitPx, o), reason: s.reason };
        }
        if (ok) rows.push({ fireTs: t.fireTs, source: t.source || '?', day: istDay(t.fireTs), res });
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

    const holdCost = outVariants[0] ? outVariants[0].costAvgRs : null;
    const tradesPerDay = days ? r2(rows.length / days) : null;
    return {
        params: o, tradesBeforeDecluster: all.length, tradesUsed: rows.length, days, tradesPerDay,
        costPerTradeRs: holdCost, costPerDayRs: tradesPerDay !== null && holdCost !== null ? r2(tradesPerDay * holdCost) : null,
        variantsTried: variants.length - 1, variants: outVariants,
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

module.exports = { simulateScalp, tradeRupees, buildVariants, decluster, computeScalpCostStudy, formatScalpCostText };