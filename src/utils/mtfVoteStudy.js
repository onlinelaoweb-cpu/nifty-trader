'use strict';
// ── MTF vote study (9 Oct) ────────────────────────────────────────────────────
// Question: does it pay to wait for the slow timeframes? Compare, at the moment each streak of votes STARTS:
//   "5m only"            : 5m has a direction, 15m does not agree with it
//   "5m + 15m"           : 5m and 15m agree, 1h does not agree (against / no read / not available)
//   "5m + 15m + 1h"      : all three agree
// by what the UNDERLYING price did over the next 15 / 30 / 60 minutes in that direction.
//
// Data: mtf_vote_log rows written every 5 min for NIFTY / CRUDE / BITCOIN, alert or no alert.
//   { ts, price, v5, v15, v1h }   v* = 1 (bull), -1 (bear), null (no clean read / not enough bars / not available)
// Pure functions (no DB, no clock). Research only — nothing here feeds a signal, gate or alert.
// Returns are on the underlying price (not option premium), before costs. They answer "did the direction hold", not "did the option pay".

const num = v => { const x = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(x) ? null : x; };
const r2 = x => Math.round(x * 100) / 100;
const avg = a => a.length ? r2(a.reduce((s, x) => s + x, 0) / a.length) : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return r2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
const toMs = v => (v instanceof Date ? v.getTime() : new Date(v).getTime());

// 'BULLISH' | 'BULL' | 1 -> 1 ; 'BEARISH' | 'BEAR' | -1 -> -1 ; anything else (NEUTRAL, INSUFFICIENT, null...) -> null
function normVote(v) {
    if (v === 1 || v === -1) return v;
    const s = String(v ?? '').toUpperCase();
    if (s === 'BULLISH' || s === 'BULL') return 1;
    if (s === 'BEARISH' || s === 'BEAR') return -1;
    return null;
}

// how a slower timeframe relates to the 5m direction
const rel = (v, dir) => v === null || v === undefined ? 'none' : v === dir ? 'agree' : 'against';

function headline(r15, r1h) {
    if (r15 !== 'agree') return '5m only';
    return r1h === 'agree' ? '5m + 15m + 1h' : '5m + 15m (1h not agreeing)';
}

// first row of every streak of identical (v5, v15, v1h) votes that has a 5m direction. A gap longer than gapMin ends a streak.
function findEpisodes(rows, gapMin) {
    const out = [];
    let prev = null;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const same = prev && r.ms - prev.ms <= gapMin * 60000 && r.v5 === prev.v5 && r.v15 === prev.v15 && r.v1h === prev.v1h;
        if (!same && r.v5 !== null) out.push(i);
        prev = r;
    }
    return out;
}

// price of the first row at/after ms, no more than tolMs later; rows sorted by ms
function priceAtOrAfter(rows, from, ms, tolMs) {
    let lo = from, hi = rows.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].ms >= ms) { best = mid; hi = mid - 1; } else lo = mid + 1; }
    if (best < 0) return null;
    return rows[best].ms - ms <= tolMs ? rows[best].price : null;
}

function summarise(eps, horizons, minN) {
    const out = { n: eps.length, days: new Set(eps.map(e => e.day)).size, thin: eps.length < minN, horizons: {} };
    for (const h of horizons) {
        const k = eps.filter(e => e.fwd[h] !== null && e.fwd[h] !== undefined);
        const mid = k.length >> 1;
        const older = k.slice(0, mid), newer = k.slice(mid);
        out.horizons[h] = {
            n: k.length,
            avgPct: avg(k.map(e => e.fwd[h].pct)), medianPct: median(k.map(e => e.fwd[h].pct)), avgPts: avg(k.map(e => e.fwd[h].pts)),
            heldPct: k.length ? Math.round((100 * k.filter(e => e.fwd[h].pct > 0).length) / k.length) : null,
            olderHalfAvgPct: avg(older.map(e => e.fwd[h].pct)), newerHalfAvgPct: avg(newer.map(e => e.fwd[h].pct)),
        };
    }
    return out;
}

function computeVoteStudy(rawRows, opts = {}) {
    const horizons = opts.horizons || [15, 30, 60];
    const minN = opts.minN ?? 10, gapMin = opts.episodeGapMin ?? 15;
    const rows = (rawRows || []).map(r => ({ ms: toMs(r.ts), price: num(r.price), v5: normVote(r.v5), v15: normVote(r.v15), v1h: normVote(r.v1h) }))
        .filter(r => Number.isFinite(r.ms) && r.price > 0).sort((a, b) => a.ms - b.ms);
    const cov = { rows: rows.length, with5m: rows.filter(r => r.v5 !== null).length, with15m: rows.filter(r => r.v15 !== null).length, with1h: rows.filter(r => r.v1h !== null).length };
    const idx = findEpisodes(rows, gapMin);
    const eps = idx.map(i => {
        const r = rows[i], dir = r.v5;
        const r15 = rel(r.v15, dir), r1h = rel(r.v1h, dir);
        const fwd = {};
        for (const h of horizons) {
            const p = priceAtOrAfter(rows, i, r.ms + h * 60000, Math.max(10, h / 2) * 60000);
            fwd[h] = p === null ? null : { pts: r2(dir * (p - r.price)), pct: r2(dir * (p / r.price - 1) * 100) };
        }
        return { ms: r.ms, day: new Date(r.ms + 330 * 60000).toISOString().slice(0, 10), dir, r15, r1h,
                 pattern: `5m ${dir === 1 ? 'BULL' : 'BEAR'} | 15m ${r15} | 1h ${r1h}`, group: headline(r15, r1h), fwd };
    });
    const groups = new Map();
    for (const e of eps) { if (!groups.has(e.group)) groups.set(e.group, []); groups.get(e.group).push(e); }
    const ORDER = ['5m only', '5m + 15m (1h not agreeing)', '5m + 15m + 1h'];
    const headlineRows = ORDER.filter(g => groups.has(g)).map(g => ({ group: g, ...summarise(groups.get(g), horizons, minN) }));
    const pats = new Map();
    for (const e of eps) { if (!pats.has(e.pattern)) pats.set(e.pattern, []); pats.get(e.pattern).push(e); }
    const patternRows = [...pats.entries()].map(([pattern, es]) => ({ pattern, ...summarise(es, horizons, minN) })).sort((a, b) => b.n - a.n);
    return { coverage: cov, episodes: eps.length, horizons, minN, headline: headlineRows, patterns: patternRows,
             note: 'Episode = first snapshot of a streak of identical 5m/15m/1h votes. Forward result = move of the underlying price in the 5m direction, before costs. 1h = none means the instrument has no 1h read.' };
}

module.exports = { normVote, findEpisodes, computeVoteStudy, headline, rel };