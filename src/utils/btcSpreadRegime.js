'use strict';
// Read-only: do the tracked BTC spreads lose only on sideways days, or on volatile days too?
// Uses signal_outcomes rows (underlying entry/eval price + spread result). Feeds nothing.
// Day range is a POST-HOC description of the day (from the signal entry prices seen that day), good for "what kind of day was it", not for live use.
const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
const r1 = x => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const r3 = x => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const dayKey = d => new Date(d).toISOString().slice(0, 10);

function group(rows) {
    const byDay = {}; for (const r of rows) (byDay[r.day] = byDay[r.day] || []).push(r.pct);
    const dm = Object.values(byDay).map(mean), se = dm.length > 1 ? sd(dm) / Math.sqrt(dm.length) : null;
    const w = rows.filter(r => r.result === 'WIN').length, l = rows.filter(r => r.result === 'LOSS').length;
    return { n: rows.length, days: dm.length, winRatePct: w + l ? r1(100 * w / (w + l)) : null, avgSpreadPct: r1(mean(rows.map(r => r.pct))),
        medianSpreadPct: r1(median(rows.map(r => r.pct))), tDay: se ? r1(mean(dm) / se) : null, avgDirMovePct: r3(mean(rows.map(r => r.move))) };
}

function ols(xs, ys) {   // y = a + b x
    const n = xs.length; if (n < 10) return null;
    const mx = mean(xs), my = mean(ys); let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
    if (!(sxx > 0)) return null;
    const b = sxy / sxx; return { a: my - b * mx, b };
}

function runBtcSpreadRegime(raw, opt = {}) {
    const rows = raw.map(x => {
        const e = num(x.entry_price), v = num(x.eval_price), sign = x.direction === 'BULLISH' ? 1 : x.direction === 'BEARISH' ? -1 : NaN;
        return { day: dayKey(x.fire_ts), entry: e, pct: num(x.spread_pct_move), result: x.spread_result, move: (v / e - 1) * 100 * sign };
    }).filter(r => Number.isFinite(r.pct) && Number.isFinite(r.move) && r.entry > 0 && r.result && r.result !== 'NO_DATA');
    const minDays = opt.minDays || 4, minN = opt.minN || 30;
    // per-day description
    const dayMap = {}; for (const r of rows) (dayMap[r.day] = dayMap[r.day] || []).push(r);
    const days = Object.entries(dayMap).map(([day, g]) => {
        const px = g.map(r => r.entry), rangePct = (Math.max(...px) - Math.min(...px)) / mean(px) * 100;
        return { day, n: g.length, rangePct: r3(rangePct), avgSpreadPct: r1(mean(g.map(r => r.pct))), avgDirMovePct: r3(mean(g.map(r => r.move))) };
    }).sort((a, b) => a.day.localeCompare(b.day));
    // low vs high range days (median split on day range)
    const med = median(days.map(d => d.rangePct)), highSet = new Set(days.filter(d => d.rangePct > med).map(d => d.day));
    const low = rows.filter(r => !highSet.has(r.day)), high = rows.filter(r => highSet.has(r.day));
    const g = { low: group(low), high: group(high), medianDayRangePct: r3(med) };
    // by direction-adjusted underlying move over the ~30 min hold
    const edges = [-Infinity, -0.3, -0.1, 0.1, 0.3, Infinity], names = ['< -0.3% (wrong way, big)', '-0.3..-0.1%', '-0.1..+0.1% (flat)', '+0.1..+0.3%', '> +0.3% (right way, big)'];
    const byMove = names.map((nm, i) => ({ bucket: nm, ...group(rows.filter(r => r.move >= edges[i] && r.move < edges[i + 1])) }));
    const fit = ols(rows.map(r => r.move), rows.map(r => r.pct));
    const breakEvenMovePct = fit && fit.b > 0 ? r3(-fit.a / fit.b) : null;
    let verdict;
    if (rows.length < minN || days.length < minDays) verdict = `NOT ENOUGH DATA (need ${minN}+ spreads on ${minDays}+ days; have ${rows.length} on ${days.length})`;
    else if (g.high.avgSpreadPct > 0 && g.high.tDay >= 2) verdict = `VOLATILE DAYS PAY: spreads are profitable on high-range days (t=${g.high.tDay}) while low-range days ${g.low.avgSpreadPct > 0 ? 'also pay' : 'lose'} — a volatility filter is worth a proper test`;
    else if (g.high.avgSpreadPct < 0) verdict = `NOT JUST SIDEWAYS: spreads lose on high-range days too (avg ${g.high.avgSpreadPct}%, t=${g.high.tDay}) — the signals/cost are the problem, not only the regime`;
    else verdict = 'INCONCLUSIVE: high-range days are not clearly better or worse';
    return { n: rows.length, days, regime: g, byMove, breakEven: { fit: fit ? { interceptPct: r1(fit.a), slopePerPct: r1(fit.b) } : null, breakEvenMovePct,
        meaning: 'about how far (in the signal direction, % of BTC price, within ~30 min) BTC must move for the average spread to break even' }, verdict,
        note: 'Day range is post-hoc (uses that day\'s signal entry prices). Few days = one regime; re-run after 2+ weeks. Signals on the same day move together, so t is on per-day averages.' };
}

function formatBtcSpreadRegimeText(s) {
    const G = (k, g) => `  ${k.padEnd(26)} n${g.n} days${g.days} | win ${g.winRatePct ?? '-'}% | avg ${g.avgSpreadPct ?? '-'}% med ${g.medianSpreadPct ?? '-'}% | t=${g.tDay ?? '-'} | avg move ${g.avgDirMovePct ?? '-'}%`;
    const o = [`BTC SPREAD x VOLATILITY STUDY (${s.n} resolved spreads, research only)`, 'Per day:'];
    for (const d of s.days) o.push(`  ${d.day}  n${String(d.n).padStart(3)}  day range ${d.rangePct}%  avg spread ${d.avgSpreadPct}%  avg move(dir) ${d.avgDirMovePct}%`);
    o.push('', `Low vs high range days (split at median ${s.regime.medianDayRangePct}%):`, G('LOW-range days', s.regime.low), G('HIGH-range days', s.regime.high),
        '', 'By how BTC moved in the signal direction (~30 min):'); for (const b of s.byMove) o.push(G(b.bucket, b));
    o.push('', s.breakEven.fit ? `Fit: spread% = ${s.breakEven.fit.interceptPct} + ${s.breakEven.fit.slopePerPct} x move%  →  break-even move ≈ ${s.breakEven.breakEvenMovePct ?? 'n/a'}%` : 'Fit: not enough rows',
        s.breakEven.meaning, '', 'VERDICT: ' + s.verdict, s.note);
    return o.join('\n');
}
module.exports = { runBtcSpreadRegime, formatBtcSpreadRegimeText };