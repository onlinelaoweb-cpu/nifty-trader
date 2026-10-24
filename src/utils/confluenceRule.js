'use strict';
// ── Confluence rules — record-only forward test #2 (24 Oct 2026) ───────────────────────────────────────────────
// WHY: the winner-anatomy study (331 independent events, 18 days) found that big winners mostly came when several different triggers fired
// together in one direction, and when the premium was already up 5%+ after 10 minutes. BUT that study counted triggers firing AFTER the entry
// and looked at the 10-minute move after the entry — hindsight. These two rules are the tradable, no-hindsight versions. They are written
// down NOW, before any new data, and judged only on signals fired after the start date. In-sample numbers (the old 18 days) are shown only
// for orientation: the rules were chosen after seeing that data, so they prove nothing.
//   B1  "3 TRIGGERS": enter at the signal where the 3rd DIFFERENT trigger has fired in the same direction within 30 minutes of the first
//       one (at THAT signal's own entry premium); then plain HOLD + 15-point stop, out after 60 minutes (same exit as forward test #1).
//   B2  "3 TRIGGERS + 10-MIN CONFIRM": as B1, but do nothing unless, about 10 minutes after that entry, the premium is >= 5% above it;
//       then enter at that later premium and run the 15-point stop up to 50 more minutes.
// Costs are the same model as everything else (0.5 pt slippage each side, 0.07% charges each side, Rs 0 brokerage, qty 130).
// Nothing here places an order or changes a signal. PURE (no I/O).

const { simulateScalp, tradeRupees } = require('./scalpCostStudy');

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const r2 = v => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
const median = a => { if (!a.length) return null; const x = [...a].sort((p, q) => p - q), m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
const pf = list => { const w = list.filter(x => x > 0).reduce((s, x) => s + x, 0), l = -list.filter(x => x < 0).reduce((s, x) => s + x, 0); return l > 0 ? r2(w / l) : (w > 0 ? null : 0); };
const IST = 5.5 * 3600000, M = 60000;
const istDay = ts => new Date(ts + IST).toISOString().slice(0, 10);

const CONFLUENCE_RULE = { need: 3, windowMin: 30, sl: 15, timeoutMin: 60, confirmAtMin: 10, confirmPct: 5, confirmTimeoutMin: 50, stopFill: 'worse', slipPts: 0.5, chargePct: 0.07, brokerage: 0, qty: 130, minPremium: 10 };
const CONFLUENCE_CRITERIA = { minTrades: 100, minDays: 10, minProfitFactor: 1.1, maxBestTradeSharePct: 20 };

// entry = the signal at which the `need`-th different trigger has fired (same direction) inside windowMin of the window's first signal
function buildConfluenceEntries(items, windowMin = 30, need = 3) {
    const list = [...items].sort((a, b) => a.fireTs - b.fireTs), open = new Map(), out = [];
    for (const o of list) {
        const key = o.direction || '?', w = open.get(key);
        if (w && o.fireTs - w.start < windowMin * M) {
            w.sources.add(o.source || '?');
            if (!w.taken && w.sources.size >= need) { w.taken = true; out.push({ ...o, triggers: w.sources.size, windowStart: w.start }); }
        } else open.set(key, { start: o.fireTs, sources: new Set([o.source || '?']), taken: false });
    }
    return out;
}

function confirmSample(e, rule) {      // sample closest to +confirmAtMin (within 2.5 min) after the entry, else null
    let best = null, bd = Infinity;
    for (const s of e.path) {
        if (!(s.premium > 0)) continue;
        const d = Math.abs(s.ts - (e.fireTs + rule.confirmAtMin * M));
        if (d <= 2.5 * M && d < bd) { bd = d; best = s; }
    }
    return best;
}

function runRules(entries, rule) {
    const b1 = [], b2 = [];
    for (const e of entries) {
        const s1 = simulateScalp(e.entryPremium, e.path, e.fireTs, null, rule.sl, rule.timeoutMin, rule.stopFill);
        if (s1) b1.push({ fireTs: e.fireTs, day: istDay(e.fireTs), source: e.source || '?', triggers: e.triggers, direction: e.direction || '?', ...tradeRupees(e.entryPremium, s1.exitPx, rule), reason: s1.reason });
        const c = confirmSample(e, rule);
        if (c && c.premium >= e.entryPremium * (1 + rule.confirmPct / 100)) {
            const later = e.path.filter(s => s.ts > c.ts);
            const s2 = later.length ? simulateScalp(c.premium, later, c.ts, null, rule.sl, rule.confirmTimeoutMin, rule.stopFill) : null;
            if (s2) b2.push({ fireTs: c.ts, day: istDay(c.ts), source: e.source || '?', triggers: e.triggers, direction: e.direction || '?', ...tradeRupees(c.premium, s2.exitPx, rule), reason: s2.reason });
        }
    }
    return { b1, b2 };
}

function judge(rowsIn, crit) {
    const rows = [...rowsIn].sort((a, b) => a.fireTs - b.fireTs), nets = rows.map(r => r.net), n = rows.length, days = new Set(rows.map(r => r.day)).size;
    const total = nets.reduce((s, x) => s + x, 0), avg = n ? total / n : null, half = Math.floor(n / 2);
    const oAvg = half ? mean(nets.slice(0, half)) : null, nAvg = n - half ? mean(nets.slice(half)) : null;
    const best = n ? Math.max(...nets) : null, worst = n ? Math.min(...nets) : null, bestShare = total > 0 && best > 0 ? 100 * best / total : null, profitFactor = pf(nets);
    const checks = [
        { name: 'enough trades', need: `>= ${crit.minTrades}`, have: n, ok: n >= crit.minTrades },
        { name: 'enough trading days', need: `>= ${crit.minDays}`, have: days, ok: days >= crit.minDays },
        { name: 'net average after costs', need: '> 0', have: n ? r2(avg) : '-', ok: avg !== null && avg > 0 },
        { name: 'older half AND newer half', need: 'both > 0', have: n >= 2 ? `${r2(oAvg)} / ${r2(nAvg)}` : '-', ok: oAvg !== null && nAvg !== null && oAvg > 0 && nAvg > 0 },
        { name: 'profit factor', need: `>= ${crit.minProfitFactor}`, have: n ? (profitFactor ?? '-') : '-', ok: n > 0 && (profitFactor === null ? total > 0 : profitFactor >= crit.minProfitFactor) },
        { name: 'best single trade share of total profit', need: `<= ${crit.maxBestTradeSharePct}%`, have: bestShare === null ? '-' : r2(bestShare) + '%', ok: total > 0 && bestShare !== null && bestShare <= crit.maxBestTradeSharePct },
    ];
    const enough = checks[0].ok && checks[1].ok, failed = checks.filter(c => !c.ok).map(c => c.name);
    const dm = new Map(); for (const r of rows) { const d = dm.get(r.day) || { day: r.day, n: 0, netRs: 0 }; d.n++; d.netRs += r.net; dm.set(r.day, d); }
    return {
        trades: n, days, netAvgRs: r2(avg), netTotalRs: r2(total), medianNetRs: r2(median(nets)), worstNetRs: r2(worst), bestNetRs: r2(best), profitFactor: n ? profitFactor : null,
        winPct: n ? Math.round(1000 * nets.filter(x => x > 0).length / n) / 10 : null, older: { n: half, netAvgRs: r2(oAvg) }, newer: { n: n - half, netAvgRs: r2(nAvg) },
        daily: [...dm.values()].map(d => ({ day: d.day, n: d.n, netRs: r2(d.netRs) })), checks,
        status: !enough ? 'COLLECTING' : (failed.length ? 'FAIL' : 'PASS'), reasons: !enough ? [`need ${crit.minTrades} trades over ${crit.minDays} trading days (have ${n} / ${days})`] : failed,
    };
}

// outcomes: [{ source, direction, fireTs, entryPremium, path:[{ts,premium}] }]; opts: { startTs, rule?, criteria? }
function evaluateConfluence(outcomes, opts = {}) {
    const rule = { ...CONFLUENCE_RULE, ...(opts.rule || {}) }, crit = { ...CONFLUENCE_CRITERIA, ...(opts.criteria || {}) };
    const startTs = Number.isFinite(opts.startTs) ? opts.startTs : 0, all = Array.isArray(outcomes) ? outcomes : [];
    const usable = all.filter(x => x && x.fireTs >= startTs && x.entryPremium >= rule.minPremium && Array.isArray(x.path) && x.path.length >= 3 && Number.isFinite(x.fireTs))
        .map(x => ({ ...x, path: [...x.path].sort((a, b) => a.ts - b.ts) }));
    const entries = buildConfluenceEntries(usable, rule.windowMin, rule.need), { b1, b2 } = runRules(entries, rule);
    return { rule, criteria: crit, startTs: startTs || null, signals: usable.length, entries: entries.length, b1: judge(b1, crit), b2: judge(b2, crit) };
}

function formatConfluenceText(res, meta = {}) {
    const L = [], f = v => v === null || v === undefined ? '-' : (v > 0 ? '+' : '') + v, r = res.rule;
    L.push(meta.backtest ? `CONFLUENCE RULES — IN-SAMPLE LOOK-BACK (last ${meta.days} days) — these rules were chosen AFTER seeing this data, so this proves NOTHING; only the forward version counts` : `CONFLUENCE RULES — FORWARD TEST #2  NIFTY  (signals fired on or after ${meta.start || '?'} only)`);
    L.push(`B1 "3 TRIGGERS": enter when the ${r.need}rd different trigger fires in the same direction within ${r.windowMin} min of the first (at that signal's own premium); HOLD + ${r.sl}-pt stop (fills at the level or worse), out after ${r.timeoutMin} min.`);
    L.push(`B2 "3 TRIGGERS + 10-MIN CONFIRM": as B1, but only if ~${r.confirmAtMin} min later the premium is >= ${r.confirmPct}% above the entry; then enter at THAT premium, ${r.sl}-pt stop, up to ${r.confirmTimeoutMin} more min.`);
    L.push(`Costs: ${r.slipPts} pt slippage each side + ${r.chargePct}% charges each side + Rs ${r.brokerage} brokerage, qty ${r.qty}. Pass bars: ${res.criteria.minTrades}+ trades over ${res.criteria.minDays}+ days, both halves positive, PF >= ${res.criteria.minProfitFactor}, best trade <= ${res.criteria.maxBestTradeSharePct}% of profit.`);
    L.push(`${res.signals} signals -> ${res.entries} confluence entries.`);
    for (const [k, t] of [['B1', res.b1], ['B2', res.b2]]) {
        L.push('');
        L.push(`${k}  STATUS: ${t.status}${t.status === 'COLLECTING' && !meta.backtest ? '  (interim numbers mean nothing yet)' : ''}`);
        t.reasons.forEach(x => L.push(`  - ${x}`));
        L.push(`  Trades ${t.trades} over ${t.days} day(s). Net avg ${f(t.netAvgRs)} Rs, total ${f(t.netTotalRs)}, median ${f(t.medianNetRs)}, win ${t.winPct ?? '-'}%, PF ${t.profitFactor ?? '-'}, worst ${f(t.worstNetRs)}, best ${f(t.bestNetRs)}. Older half ${f(t.older.netAvgRs)} | newer half ${f(t.newer.netAvgRs)}.`);
        t.checks.forEach(c => L.push(`  [${c.ok ? 'x' : ' '}] ${c.name}: need ${c.need}, have ${c.have}`));
        if (t.daily.length && !meta.backtest) { L.push('  Day by day (trades, net Rs):'); t.daily.forEach(d => L.push(`    ${d.day}  n=${String(d.n).padStart(3)}  ${f(d.netRs)}`)); }
    }
    L.push('');
    L.push('A pass is NOT permission to trade live — it means the idea survived a clean test on one regime; paper-trade next. A fail means the earlier pattern was probably hindsight or luck. Do not change a rule after looking.');
    return L.join('\n');
}

module.exports = { CONFLUENCE_RULE, CONFLUENCE_CRITERIA, buildConfluenceEntries, evaluateConfluence, formatConfluenceText };