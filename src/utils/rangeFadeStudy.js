'use strict';
// Sideways "range fade" study (research only, feeds nothing). Pre-registered rules, NOT tuned on the data:
//   Sideways at bar t  = over the last N=48 bars (levels use bars t-N..t-1):
//                        efficiency ratio ER <= 0.30  AND  range width <= 10 x ATR(14).
//   Signal             = close in the bottom 10% of that range -> LONG (call-buy-the-dip idea),
//                        top 10% -> SHORT (put-buy-the-top idea). Cooldown = H bars.
//   Exit               = after H=12 bars at the close, or earlier at a stop 0.2 x range-width beyond the range edge (intrabar).
// Reported on the UNDERLYING (gross), then net of a rough option-cost hurdle per instrument (a stand-in, replace with a measured one).
// Verdict needs: net > 0 in BOTH halves of the data, n >= 50, >= 5 days, day-level t >= 2.
const P = { N: 48, ER_MAX: 0.30, WIDTH_ATR_MAX: 10, EDGE: 0.10, H: 12, STOP_W: 0.2, ATR_N: 14, GAP_SEC: 20 * 60 };
const HURDLE_PCT = { NIFTY: 0.20, CRUDE: 0.35, BTC: 0.35 };   // rough option round-trip break-even in % of underlying (BTC: from the spread study fit)
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const r3 = x => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const day = t => new Date(t * 1000).toISOString().slice(0, 10);

function simulate(bars, opt = {}) {
    const p = { ...P, ...opt }, n = bars.length, trades = [];
    const tr = i => Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    let nextOk = 0, skippedGap = 0, sidewaysBars = 0;
    for (let t = p.N + 1; t < n - 1; t++) {
        if (t < nextOk) continue;
        let gap = false; for (let i = t - p.N; i <= t; i++) if (bars[i].t - bars[i - 1].t > p.GAP_SEC) { gap = true; break; }
        if (gap) continue;
        let hi = -Infinity, lo = Infinity, path = 0;
        for (let i = t - p.N; i < t; i++) { hi = Math.max(hi, bars[i].h); lo = Math.min(lo, bars[i].l); path += Math.abs(bars[i].c - bars[i - 1].c); }
        const w = hi - lo; if (!(w > 0) || !(path > 0)) continue;
        const er = Math.abs(bars[t - 1].c - bars[t - p.N - 1].c) / path;
        let atr = 0; for (let i = t - p.ATR_N; i < t; i++) atr += tr(i); atr /= p.ATR_N;
        if (!(er <= p.ER_MAX) || !(w <= p.WIDTH_ATR_MAX * atr)) continue;
        sidewaysBars++;
        const pos = (bars[t].c - lo) / w, side = pos <= p.EDGE ? 1 : pos >= 1 - p.EDGE ? -1 : 0;
        const mid = pos > 0.4 && pos < 0.6;                     // baseline: entries from the middle of the same sideways ranges
        if (!side && !mid) continue;
        const dir = side || (t % 2 ? 1 : -1);                   // baseline direction alternates (drift cancels)
        if (t + p.H >= n) continue;
        let bad = false; for (let i = t + 1; i <= t + p.H; i++) if (bars[i].t - bars[i - 1].t > p.GAP_SEC) { bad = true; break; }
        if (bad) { skippedGap++; continue; }
        const entry = bars[t].c, stop = dir === 1 ? lo - p.STOP_W * w : hi + p.STOP_W * w;
        let exit = bars[t + p.H].c, stopped = false, worst = 0;
        for (let i = t + 1; i <= t + p.H; i++) {
            const adverse = dir === 1 ? (bars[i].l / entry - 1) * 100 : (1 - bars[i].h / entry) * 100; worst = Math.min(worst, adverse);
            if (dir === 1 ? bars[i].l <= stop : bars[i].h >= stop) { exit = dir === 1 ? Math.min(stop, bars[i].o) : Math.max(stop, bars[i].o); stopped = true; break; }
        }
        trades.push({ t: bars[t].t, day: day(bars[t].t), dir, kind: side ? 'EDGE' : 'MID', gross: dir * (exit / entry - 1) * 100, stopped, mae: worst });
        nextOk = t + p.H;
    }
    return { trades, skippedGap, sidewaysBars };
}

function summarize(tr, hurdle) {
    const g = tr.map(x => x.gross), net = g.map(x => x - hurdle), byDay = {};
    tr.forEach((x, i) => (byDay[x.day] = byDay[x.day] || []).push(net[i]));
    const dm = Object.values(byDay).map(mean), se = dm.length > 1 ? sd(dm) / Math.sqrt(dm.length) : null;
    return { n: tr.length, days: dm.length, avgGrossPct: r3(mean(g)), medianGrossPct: r3(median(g)), avgNetPct: r3(mean(net)), hitPct: tr.length ? r2(100 * g.filter(x => x > 0).length / tr.length) : null,
        stoppedPct: tr.length ? r2(100 * tr.filter(x => x.stopped).length / tr.length) : null, avgMaePct: r3(mean(tr.map(x => x.mae))), tDayNet: se ? r2(mean(dm) / se) : null };
}

function runRangeFadeStudy(bars, name, opt = {}) {
    const hurdle = opt.hurdlePct ?? HURDLE_PCT[name] ?? 0.3, clean = bars.filter(b => [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite) && b.c > 0);
    const sim = simulate(clean, opt), edge = sim.trades.filter(x => x.kind === 'EDGE'), mid = sim.trades.filter(x => x.kind === 'MID');
    const half = clean.length ? clean[Math.floor(clean.length / 2)].t : 0, h1 = edge.filter(x => x.t < half), h2 = edge.filter(x => x.t >= half);
    const out = { instrument: name, bars: clean.length, hurdlePct: hurdle, sidewaysBars: sim.sidewaysBars, skippedGapTrades: sim.skippedGap,
        edge: summarize(edge, hurdle), edgeLong: summarize(edge.filter(x => x.dir === 1), hurdle), edgeShort: summarize(edge.filter(x => x.dir === -1), hurdle),
        baselineMid: summarize(mid, hurdle), firstHalf: summarize(h1, hurdle), secondHalf: summarize(h2, hurdle), sensitivityH: {} };
    for (const H of [6, 24]) out.sensitivityH[H] = summarize(simulate(clean, { ...opt, H }).trades.filter(x => x.kind === 'EDGE'), hurdle).avgNetPct;
    const e = out.edge, minN = opt.minN || 50, minDays = opt.minDays || 5;
    out.verdict = e.n < minN || e.days < minDays ? `NOT ENOUGH DATA (need ${minN}+ fades on ${minDays}+ days; have ${e.n} on ${e.days})`
        : e.avgNetPct > 0 && e.tDayNet >= 2 && out.firstHalf.avgNetPct > 0 && out.secondHalf.avgNetPct > 0 ? `POSSIBLE EDGE: net +${e.avgNetPct}% per fade after the ${hurdle}% cost hurdle (t=${e.tDayNet}, both halves positive) — needs a real option-premium test next`
        : e.avgGrossPct > 0 && e.avgNetPct <= 0 ? `MOVES TOO SMALL: fading edges is slightly right (gross ${e.avgGrossPct}%) but not enough to pay the ${hurdle}% option cost`
        : `NO EDGE: fading range edges does not make money (gross ${e.avgGrossPct}%, net ${e.avgNetPct}%, t=${e.tDayNet})`;
    return out;
}

function formatRangeFadeText(results) {
    const L = (k, s) => `    ${k.padEnd(11)} n${s.n} days${s.days} | gross avg ${s.avgGrossPct ?? '-'}% med ${s.medianGrossPct ?? '-'}% hit ${s.hitPct ?? '-'}% | net ${s.avgNetPct ?? '-'}% t=${s.tDayNet ?? '-'} | stopped ${s.stoppedPct ?? '-'}% | avg worst dip ${s.avgMaePct ?? '-'}%`;
    const o = ['SIDEWAYS RANGE-FADE STUDY (5m bars, underlying only, research only)',
        `Rules fixed in advance: sideways = last ${P.N} bars with efficiency ratio <= ${P.ER_MAX} and width <= ${P.WIDTH_ATR_MAX} ATR; long in bottom ${P.EDGE * 100}% / short in top ${P.EDGE * 100}% of the range; exit after ${P.H} bars or ${P.STOP_W} range-widths beyond the edge.`,
        'net = gross minus a rough option-cost hurdle (replace with a measured one). Baseline = entries from the middle of the same ranges.', ''];
    for (const r of results) {
        if (r.error) { o.push(`■ ${r.instrument}: DATA ERROR — ${r.error}`, ''); continue; }
        o.push(`■ ${r.instrument}  (${r.bars} bars, ${r.sidewaysBars} sideways bars, cost hurdle ${r.hurdlePct}%)`, L('ALL FADES', r.edge), L('long (dip)', r.edgeLong), L('short (top)', r.edgeShort), L('MID baseline', r.baselineMid),
            L('1st half', r.firstHalf), L('2nd half', r.secondHalf), `    hold sensitivity (net): 6 bars ${r.sensitivityH[6]}% | 24 bars ${r.sensitivityH[24]}%`, `    VERDICT: ${r.verdict}`, '');
    }
    o.push('Caution: 5m bars cover ~60 days only, and one hypothesis × 3 instruments is 3 tests — a single borderline result should not be trusted.');
    return o.join('\n');
}

async function fetchYahooBars(symbol, axios, range = '60d', interval = '5m') {
    const hosts = ['query1', 'query2'];
    for (const h of hosts) {
        try {
            const res = await axios.get(`https://${h}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`, { params: { interval, range }, timeout: 20000,
                headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', Accept: 'application/json' } });
            const r = res.data?.chart?.result?.[0], q = r?.indicators?.quote?.[0]; if (!r || !q) continue;
            return r.timestamp.map((t, i) => ({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] })).filter(b => [b.o, b.h, b.l, b.c].every(Number.isFinite));
        } catch (e) { /* try next host */ }
    }
    return null;
}
module.exports = { runRangeFadeStudy, formatRangeFadeText, fetchYahooBars, simulate, P, HURDLE_PCT };