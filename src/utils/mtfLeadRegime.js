'use strict';
// ── MTF lead regime study (10 Oct) ────────────────────────────────────────────
// Question: the MTF tracker's closed leads did well on trending days (8–9 Oct) and badly on 5–7 Oct. Was the state of the
// market AT THE TIME of each lead already different — weaker ADX, a choppy last hour, a lead against the last hour's move,
// the time of day? If a clear difference shows up, it is a hypothesis for a later filter. This module never filters or
// alerts on anything.
//
// Inputs (both already in the DB):
//   leads     : closed signal_performance rows of the MTF tracker (ts, option_type|signal, entry, exit_premium, sl, target, target_hit, sl_hit, max_gain_pct, lead_quality)
//   snapshots : market_snapshot_log rows, every ~5 min (ts, nifty, rsi, vix, mtf_5m_adx, mtf_15m_adx, mtf_1h_adx, health_total, trend_prob, range_prob)
// Each lead is matched to the last snapshot at or before it (within tolMin) and to the 60 minutes of snapshots before it.
// Pure functions (no DB, no clock). With a few dozen leads from a handful of days this can only SHOW differences, not prove them —
// the result carries n and a `thin` flag, and many buckets on few leads will always produce some pattern by chance.

const { declusterLeads } = require('./leadDecluster');

const num = v => { const x = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(x) ? null : x; };
const r1 = x => Math.round(x * 10) / 10;
const r2 = x => Math.round(x * 100) / 100;
const avg = a => a.length ? r1(a.reduce((s, x) => s + x, 0) / a.length) : null;
const toMs = v => (v instanceof Date ? v.getTime() : new Date(v).getTime());
const istParts = ms => { const d = new Date(ms + 330 * 60000); return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() + d.getUTCMinutes() / 60 }; };

// realised % of a closed lead (same rule as entryExitQuality.computeTrackerScorecard)
function leadReturn(t) {
    const entry = num(t.entry); if (!(entry > 0)) return null;
    const exit = num(t.exit_premium), target = num(t.target), sl = num(t.sl);
    if (exit !== null) return r1(((exit - entry) / entry) * 100);
    if (t.target_hit && target > 0) return r1(((target - entry) / entry) * 100);
    if (t.sl_hit && sl > 0) return r1(((sl - entry) / entry) * 100);
    return null;
}

function leadSide(t) {
    const o = String(t.option_type || '').toUpperCase();
    if (o === 'CE' || o === 'CALL') return 1;
    if (o === 'PE' || o === 'PUT') return -1;
    const s = String(t.signal || '').toUpperCase();
    return s.includes('CALL') ? 1 : s.includes('PUT') ? -1 : null;
}

// last snapshot at or before ms, no older than tolMs; rows sorted by ms
function snapshotAtOrBefore(rows, ms, tolMs) {
    let lo = 0, hi = rows.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].ms <= ms) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best >= 0 && ms - rows[best].ms <= tolMs ? best : -1;
}

// how the index behaved in the hour before the lead. efficiency = |net move| / total path (1 = straight line, 0 = pure chop)
function hourBefore(rows, idx, side) {
    const end = rows[idx];
    const seg = [];
    for (let i = idx; i >= 0 && end.ms - rows[i].ms <= 60 * 60000; i--) seg.unshift(rows[i]);
    if (seg.length < 5 || !(seg[0].nifty > 0)) return null;
    let path = 0, hi = -Infinity, lo = Infinity;
    for (let i = 0; i < seg.length; i++) {
        hi = Math.max(hi, seg[i].nifty); lo = Math.min(lo, seg[i].nifty);
        if (i) path += Math.abs(seg[i].nifty - seg[i - 1].nifty);
    }
    const net = seg[seg.length - 1].nifty - seg[0].nifty;
    return { efficiency: path > 0 ? r2(Math.abs(net) / path) : null, range: r1(hi - lo), alignedMove: side === null ? null : r1(side * net) };
}

// bucket definitions: feature -> ordered list of [label, test]
const BUCKETS = {
    adx1h:      [['1h ADX < 20', v => v < 20], ['1h ADX 20–30', v => v >= 20 && v < 30], ['1h ADX ≥ 30', v => v >= 30]],
    adx15:      [['15m ADX < 25', v => v < 25], ['15m ADX 25–35', v => v >= 25 && v < 35], ['15m ADX ≥ 35', v => v >= 35]],
    adx5:       [['5m ADX < 25', v => v < 25], ['5m ADX 25–40', v => v >= 25 && v < 40], ['5m ADX ≥ 40', v => v >= 40]],
    efficiency: [['last hour choppy (eff < 0.25)', v => v < 0.25], ['last hour mixed (0.25–0.5)', v => v >= 0.25 && v < 0.5], ['last hour one-way (eff ≥ 0.5)', v => v >= 0.5]],
    alignedMove:[['lead AGAINST last hour move', v => v < 0], ['lead WITH last hour move', v => v >= 0]],
    hour:       [['before 10:00', v => v < 10], ['10:00–12:00', v => v >= 10 && v < 12], ['12:00 or later', v => v >= 12]],
    vix:        [['VIX < 13', v => v < 13], ['VIX 13–16', v => v >= 13 && v < 16], ['VIX ≥ 16', v => v >= 16]],
    trendProb:  [['trend prob < 40', v => v < 40], ['trend prob 40–60', v => v >= 40 && v < 60], ['trend prob ≥ 60', v => v >= 60]],
    health:     [['health < 50', v => v < 50], ['health 50–70', v => v >= 50 && v < 70], ['health ≥ 70', v => v >= 70]],
};
const FEATURE_LABEL = { adx1h: '1h ADX', adx15: '15m ADX', adx5: '5m ADX', efficiency: 'last-hour efficiency', alignedMove: 'last-hour move in lead direction (pts)', hour: 'hour (IST)', vix: 'VIX', trendProb: 'trend probability', health: 'market health' };

function summarise(rows, minN) {
    const n = rows.length;
    return {
        n, thin: n < minN,
        avgReturnPct: avg(rows.map(r => r.ret)),
        winPct: n ? Math.round((100 * rows.filter(r => r.ret > 0).length) / n) : null,
        slHits: rows.filter(r => r.sl).length,
        avgPeakPct: avg(rows.map(r => r.mfe).filter(x => x !== null)),
    };
}

function computeLeadRegimeStudy(rawLeads, rawSnaps, opts = {}) {
    const tolMs = (opts.tolMin ?? 10) * 60000, minN = opts.minN ?? 4;
    const snaps = (rawSnaps || []).map(s => ({
        ms: toMs(s.ts), nifty: num(s.nifty), rsi: num(s.rsi), vix: num(s.vix),
        adx5: num(s.mtf_5m_adx), adx15: num(s.mtf_15m_adx), adx1h: num(s.mtf_1h_adx),
        health: num(s.health_total), trendProb: num(s.trend_prob), rangeProb: num(s.range_prob),
    })).filter(s => Number.isFinite(s.ms) && s.nifty > 0).sort((a, b) => a.ms - b.ms);

    const leads = [];
    let unmatched = 0;
    for (const t of rawLeads || []) {
        const ret = leadReturn(t); if (ret === null) continue;
        const ms = toMs(t.ts); if (!Number.isFinite(ms)) continue;
        const side = leadSide(t);
        const idx = snapshotAtOrBefore(snaps, ms, tolMs);
        const { day, hour } = istParts(ms);
        const row = { id: t.id ?? null, ts: new Date(ms).toISOString(), day, side: side === 1 ? 'CALL' : side === -1 ? 'PUT' : null, quality: t.lead_quality || null,
                      ret, mfe: num(t.max_gain_pct), sl: !!t.sl_hit, target: !!t.target_hit, hour: r2(hour), matched: idx >= 0 };
        if (idx >= 0) {
            const s = snaps[idx], h = hourBefore(snaps, idx, side);
            Object.assign(row, { adx5: s.adx5, adx15: s.adx15, adx1h: s.adx1h, vix: s.vix, rsi: s.rsi, trendProb: s.trendProb, rangeProb: s.rangeProb, health: s.health,
                                 efficiency: h ? h.efficiency : null, range60: h ? h.range : null, alignedMove: h ? h.alignedMove : null });
        } else unmatched++;
        leads.push(row);
    }
    leads.sort((a, b) => (a.ts < b.ts ? -1 : 1));

    // 10 Oct — one lead per event (first lead of a side, then skip same-side leads for declusterMin minutes); 0 / missing = every lead
    const qualityFiltered = opts.qualityOnly ? leads.filter(l => l.quality === opts.qualityOnly) : leads;
    const use = declusterLeads(qualityFiltered, opts.declusterMin, l => Date.parse(l.ts), l => l.side);
    const good = use.filter(l => l.ret > 0), bad = use.filter(l => l.ret <= 0);

    const byFeature = [];
    for (const [feature, buckets] of Object.entries(BUCKETS)) {
        const have = use.filter(l => l.matched && num(l[feature]) !== null);
        if (!have.length) continue;
        byFeature.push({
            feature, label: FEATURE_LABEL[feature], withData: have.length,
            avgWhenPositive: avg(have.filter(l => l.ret > 0).map(l => l[feature])), avgWhenNotPositive: avg(have.filter(l => l.ret <= 0).map(l => l[feature])),
            buckets: buckets.map(([label, test]) => ({ label, ...summarise(have.filter(l => test(l[feature])), minN) })).filter(b => b.n > 0),
        });
    }
    const byDay = {};
    for (const l of use) (byDay[l.day] = byDay[l.day] || []).push(l);
    const days = Object.entries(byDay).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, rs]) => ({
        day, ...summarise(rs, minN),
        avgAdx1h: avg(rs.map(r => r.adx1h).filter(x => x !== null && x !== undefined)), avgAdx15: avg(rs.map(r => r.adx15).filter(x => x !== null && x !== undefined)),
        avgEfficiency: avg(rs.map(r => r.efficiency).filter(x => x !== null && x !== undefined)),
    }));
    return {
        rawLeads: qualityFiltered.length, declusterMin: opts.declusterMin > 0 ? opts.declusterMin : 0,
        leads: use.length, matchedToSnapshot: use.filter(l => l.matched).length, unmatched,
        positive: good.length, notPositive: bad.length, all: summarise(use, minN), days, byFeature, rows: use,
        note: 'A bucket is a hypothesis, not a rule: with a few dozen leads over a few days, some pattern will appear by chance. Read the day table first — if the ADX/efficiency pattern does not also separate the days, it is probably noise. Nothing here feeds a gate or alert.',
    };
}

function formatLeadRegimeText(res) {
    const f = v => v === null || v === undefined ? '--' : v;
    const L = [];
    L.push(res.declusterMin > 0 ? `One lead per event: first lead per side, then ${res.declusterMin} min gap (${res.rawLeads} raw leads -> ${res.leads} used)` : `Every lead counted (not declustered): ${res.rawLeads}`);
    L.push(`MTF LEAD REGIME STUDY — leads ${res.leads} (matched to a market snapshot: ${res.matchedToSnapshot}), positive ${res.positive}, not positive ${res.notPositive}`);
    L.push(`ALL  n=${res.all.n}  avg ${f(res.all.avgReturnPct)}%  win ${f(res.all.winPct)}%  SL ${res.all.slHits}  peak ${f(res.all.avgPeakPct)}%`);
    L.push('');
    L.push('BY DAY (does the market state separate the good days from the bad ones?)');
    for (const d of res.days) L.push(`  ${d.day}  n=${d.n}  avg ${f(d.avgReturnPct)}%  win ${f(d.winPct)}%  SL ${d.slHits}   | avg 1h ADX ${f(d.avgAdx1h)}  15m ADX ${f(d.avgAdx15)}  last-hour efficiency ${f(d.avgEfficiency)}`);
    L.push('');
    L.push('BY FEATURE (avg of the feature when the lead made money vs when it did not, then buckets)');
    for (const x of res.byFeature) {
        L.push(`  ${x.label}  [${x.withData} leads]  positive: ${f(x.avgWhenPositive)}  not positive: ${f(x.avgWhenNotPositive)}`);
        for (const b of x.buckets) L.push(`      ${b.label}: n=${b.n}${b.thin ? ' (thin)' : ''}  avg ${f(b.avgReturnPct)}%  win ${f(b.winPct)}%  SL ${b.slHits}`);
    }
    L.push('');
    L.push('LEADS (time IST order): day  hh.hh  side  ret%  | 5m/15m/1h ADX  eff  lastHrMove  vix');
    for (const r of res.rows) L.push(`  ${r.day} ${String(r.hour).padStart(5)} ${String(r.side || '?').padEnd(4)} ${String(r.ret).padStart(6)}%${r.sl ? ' SL' : r.target ? ' T ' : '   '} | ${f(r.adx5)}/${f(r.adx15)}/${f(r.adx1h)}  ${f(r.efficiency)}  ${f(r.alignedMove)}  ${f(r.vix)}${r.matched ? '' : '  (no snapshot)'}`);
    L.push('');
    L.push(res.note);
    return L.join('\n');
}

module.exports = { leadReturn, leadSide, snapshotAtOrBefore, hourBefore, computeLeadRegimeStudy, formatLeadRegimeText, BUCKETS };