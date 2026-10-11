'use strict';
// Read-only study of the tracked Bitcoin defined-risk spreads (signal_outcomes.spread_*).
// Trades fired on the same day move together, so every verdict is made on DAY averages, not on raw rows.
const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
const r1 = x => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const isWeekend = d => { const w = new Date(d).getUTCDay(); return w === 0 || w === 6; };   // Sat/Sun UTC, same as the liquidity gate
const dayKey = d => new Date(d).toISOString().slice(0, 10);

function stat(rows) {
    const pct = rows.map(r => r.pct), single = rows.map(r => r.single).filter(Number.isFinite);
    const byDay = {}; for (const r of rows) (byDay[r.day] = byDay[r.day] || []).push(r.pct);
    const dayMeans = Object.values(byDay).map(mean);
    const w = rows.filter(r => r.result === 'WIN').length, l = rows.filter(r => r.result === 'LOSS').length, f = rows.filter(r => r.result === 'FLAT').length;
    const se = dayMeans.length > 1 ? sd(dayMeans) / Math.sqrt(dayMeans.length) : null;
    return { n: rows.length, days: dayMeans.length, win: w, loss: l, flat: f, winRatePct: w + l ? r1(100 * w / (w + l)) : null,
        avgPct: r1(mean(pct)), medianPct: r1(median(pct)), avgOfDayAvgs: r1(mean(dayMeans)),
        tDay: se ? r1(mean(dayMeans) / se) : null, singleLegLtpAvgPct: r1(mean(single)) };
}

function runBtcSpreadStudy(raw, opt = {}) {
    const rows = raw.map(x => ({ source: x.source || 'UNKNOWN', ts: x.fire_ts, day: dayKey(x.fire_ts), weekend: isWeekend(x.fire_ts),
            pct: num(x.spread_pct_move), result: x.spread_result, single: num(x.premium_pct_move), direction: x.direction }))
        .filter(r => Number.isFinite(r.pct) && r.result && r.result !== 'NO_DATA');
    const group = fn => { const m = {}; for (const r of rows) (m[fn(r)] = m[fn(r)] || []).push(r); return Object.fromEntries(Object.entries(m).map(([k, g]) => [k, stat(g)])); };
    const minN = opt.minN || 30, minDays = opt.minDays || 4;
    const all = stat(rows), wk = stat(rows.filter(r => r.weekend)), wd = stat(rows.filter(r => !r.weekend));
    let verdict;
    if (all.n < minN || all.days < minDays) verdict = `NOT ENOUGH DATA (need ${minN}+ spreads on ${minDays}+ days; have ${all.n} on ${all.days})`;
    else if (all.tDay >= 2) verdict = `EDGE: spreads win on average after bid-ask cost (day t=${all.tDay})`;
    else if (all.tDay <= -2) verdict = `LOSING: spreads lose on average after bid-ask cost (day t=${all.tDay})`;
    else verdict = `NO CLEAR EDGE (day t=${all.tDay}) — result is within noise`;
    return { all, weekend: wk, weekday: wd, bySource: group(r => r.source), byDirection: group(r => r.direction || 'NA'), verdict,
        note: 'Executable pricing (pay ask / get bid). WIN/LOSS = +/-10% on the debit at ~30 min. t is computed on per-day averages. single-leg numbers use last-traded price and are NOT like-for-like.' };
}

function formatBtcSpreadText(s) {
    const L = (k, g) => `  ${k.padEnd(16)} n${g.n} days${g.days} | win ${g.winRatePct ?? '-'}% (W${g.win}/L${g.loss}/F${g.flat}) | avg ${g.avgPct ?? '-'}% med ${g.medianPct ?? '-'}% | dayAvg ${g.avgOfDayAvgs ?? '-'}% t=${g.tDay ?? '-'} | single-leg ltp ${g.singleLegLtpAvgPct ?? '-'}%`;
    const out = ['BTC SPREAD STUDY (tracked Bull Call / Bear Put, executable bid/ask)', L('ALL', s.all), L('WEEKEND', s.weekend), L('WEEKDAY', s.weekday), '', 'By source:'];
    for (const [k, g] of Object.entries(s.bySource)) out.push(L(k.slice(0, 16), g));
    out.push('', 'By direction:'); for (const [k, g] of Object.entries(s.byDirection)) out.push(L(k, g));
    out.push('', 'VERDICT: ' + s.verdict, s.note);
    return out.join('\n');
}
module.exports = { runBtcSpreadStudy, formatBtcSpreadText };