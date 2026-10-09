'use strict';
// ── MTF "chase" study (9 Oct) ─────────────────────────────────────────────────
// Question: the MTF tracker only calls a lead STRONG when 5m + 15m + 1h all agree, which needs the slowest
// timeframe to turn — so by then the move may already be done (9 Oct: Nifty +200 pts, STRONG CALL came at RSI 79).
// Does a lead that fires AFTER a big run in its own direction do worse than one that fires early?
//
// Pure functions (no DB, no clock) so they can be unit-tested. Inputs:
//   trades: closed signal_performance rows of the MTF tracker
//   snaps : market_snapshot_log rows { ts, nifty, rsi }  (5-minute cadence)
// Output: per-trade tags + bucket tables. Research only — nothing here changes a signal.

const num = v => { const x = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(x) ? null : x; };
const r1 = x => Math.round(x * 10) / 10;
const toMs = v => (v instanceof Date ? v.getTime() : new Date(v).getTime());
const istDay = ms => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
const istMinOfDay = ms => { const d = new Date(ms + 330 * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

// latest snapshot at or before t, but not older than maxGapMs; snaps must be sorted by ts ascending
function snapAtOrBefore(snaps, t, maxGapMs) {
    let lo = 0, hi = snaps.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (snaps[mid]._ms <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    if (best < 0) return null;
    return t - snaps[best]._ms <= maxGapMs ? snaps[best] : null;
}

// realised % return of one trade from its stored exit premium; falls back to the target/SL level if the
// exit premium is missing. Returns { ret, basis } or null when neither exists. Before brokerage/slippage.
function tradeReturn(t) {
    const entry = num(t.entry), exit = num(t.exit_premium);
    if (!(entry > 0)) return null;
    if (exit !== null && exit >= 0) return { ret: r1(((exit - entry) / entry) * 100), basis: 'exit' };
    if (t.target_hit && num(t.target) > 0) return { ret: r1(((num(t.target) - entry) / entry) * 100), basis: 'target' };
    if (t.sl_hit && num(t.sl) > 0) return { ret: r1(((num(t.sl) - entry) / entry) * 100), basis: 'sl' };
    return null;
}

const bucketSession = ms => { const m = istMinOfDay(ms); return m < 10 * 60 + 30 ? 'OPEN 09:15-10:30' : m < 13 * 60 + 30 ? 'MID 10:30-13:30' : 'LATE 13:30+'; };
const bucketRun60 = x => x === null ? null : x <= 0 ? '60m: AGAINST/FLAT (<=0 pts)' : x < 50 ? '60m: SMALL (0-50 pts)' : x < 100 ? '60m: MEDIUM (50-100 pts)' : '60m: EXTENDED (>=100 pts)';
const bucketRunDay = x => x === null ? null : x <= 0 ? 'DAY: AGAINST/FLAT (<=0 pts)' : x < 75 ? 'DAY: SMALL (0-75 pts)' : x < 150 ? 'DAY: MEDIUM (75-150 pts)' : 'DAY: EXTENDED (>=150 pts)';
// RSI seen from the trade's side: a PUT at RSI 20 is as stretched as a CALL at RSI 80
const bucketRsi = x => x === null ? null : x < 60 ? 'RSI(side): <60' : x < 70 ? 'RSI(side): 60-70' : 'RSI(side): >=70';

function tagTrades(trades, snaps, opts = {}) {
    const maxGapMs = (opts.maxGapMin ?? 10) * 60000;
    const sn = (snaps || []).map(s => ({ ...s, _ms: toMs(s.ts) })).filter(s => Number.isFinite(s._ms)).sort((a, b) => a._ms - b._ms);
    // first snapshot of each IST day (only if it is within the opening 15 minutes -> a usable "day open")
    const dayOpen = new Map();
    for (const s of sn) {
        const k = istDay(s._ms);
        if (!dayOpen.has(k) && istMinOfDay(s._ms) <= 9 * 60 + 30 && num(s.nifty) > 0) dayOpen.set(k, num(s.nifty));
    }
    const cov = { trades: 0, withReturn: 0, withSnapshot: 0, withRun60: 0, withRunDay: 0, withRsi: 0 };
    const out = [];
    for (const t of trades || []) {
        cov.trades++;
        const ms = toMs(t.ts);
        const sig = String(t.signal || '').toUpperCase();
        const dir = sig === 'BUY CALL' ? 1 : sig === 'BUY PUT' ? -1 : 0;
        const rr = tradeReturn(t);
        if (!Number.isFinite(ms) || !dir || !rr) continue;
        cov.withReturn++;
        const s0 = snapAtOrBefore(sn, ms, maxGapMs);
        const n0 = s0 ? num(s0.nifty) : null;
        if (s0) cov.withSnapshot++;
        const s60 = n0 !== null ? snapAtOrBefore(sn, ms - 60 * 60000, maxGapMs) : null;
        const n60 = s60 ? num(s60.nifty) : null;
        const run60 = n0 !== null && n60 !== null ? dir * (n0 - n60) : null;
        const open = dayOpen.get(istDay(ms)) ?? null;
        const runDay = n0 !== null && open !== null ? dir * (n0 - open) : null;
        const rsiRaw = s0 ? num(s0.rsi) : null;
        const rsiSide = rsiRaw === null ? null : dir === 1 ? rsiRaw : 100 - rsiRaw;
        if (run60 !== null) cov.withRun60++; if (runDay !== null) cov.withRunDay++; if (rsiSide !== null) cov.withRsi++;
        out.push({
            id: t.id, ts: ms, day: istDay(ms), signal: sig, leadQuality: t.lead_quality || null,
            ret: rr.ret, retBasis: rr.basis, maxGain: num(t.max_gain_pct), maxAdverse: num(t.max_adverse_pct),
            targetHit: !!t.target_hit, slHit: !!t.sl_hit,
            run60: run60 === null ? null : r1(run60), runDay: runDay === null ? null : r1(runDay), rsiSide: rsiSide === null ? null : r1(rsiSide),
            buckets: {
                leadQuality: t.lead_quality || null,
                session: bucketSession(ms),
                run60: bucketRun60(run60), runDay: bucketRunDay(runDay), rsi: bucketRsi(rsiSide),
            },
        });
    }
    return { rows: out, coverage: cov };
}

const avg = a => a.length ? r1(a.reduce((s, x) => s + x, 0) / a.length) : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return r1(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };

function summarise(rows) {
    const rets = rows.map(r => r.ret);
    const gains = rows.map(r => r.maxGain).filter(x => x !== null), adv = rows.map(r => r.maxAdverse).filter(x => x !== null);
    return {
        n: rows.length, days: new Set(rows.map(r => r.day)).size,
        avgReturnPct: avg(rets), medianReturnPct: median(rets),
        winRatePct: rows.length ? Math.round((100 * rets.filter(x => x > 0).length) / rows.length) : null,
        targetHits: rows.filter(r => r.targetHit).length, slHits: rows.filter(r => r.slHit).length,
        avgBestGainPct: avg(gains), avgWorstDrawdownPct: avg(adv),
    };
}

const DIMENSIONS = ['leadQuality', 'session', 'run60', 'runDay', 'rsi'];

function computeMtfChaseStudy(tagged, opts = {}) {
    const minN = opts.minN ?? 8;
    const all = tagged.slice().sort((a, b) => a.ts - b.ts);
    const overall = summarise(all);
    const mid = all.length >> 1;
    const older = all.slice(0, mid), newer = all.slice(mid);
    const dims = {};
    for (const d of DIMENSIONS) {
        const m = new Map();
        for (const r of all) { const b = r.buckets[d]; if (b) { if (!m.has(b)) m.set(b, []); m.get(b).push(r); } }
        dims[d] = [...m.entries()].map(([bucket, rs]) => {
            const s = summarise(rs);
            const o = rs.filter(r => older.includes(r)), nw = rs.filter(r => newer.includes(r));
            return { bucket, ...s, vsOverallPct: s.avgReturnPct !== null && overall.avgReturnPct !== null ? r1(s.avgReturnPct - overall.avgReturnPct) : null,
                     olderHalfAvg: avg(o.map(r => r.ret)), olderHalfN: o.length, newerHalfAvg: avg(nw.map(r => r.ret)), newerHalfN: nw.length,
                     thin: s.n < minN };
        }).sort((a, b) => a.bucket < b.bucket ? -1 : 1);
    }
    // the headline: early (small run) vs extended (big run) leads, 60-minute lens
    const grp = (pred) => summarise(all.filter(pred));
    const earlyVsLate = {
        early: grp(r => r.run60 !== null && r.run60 < 50),
        extended: grp(r => r.run60 !== null && r.run60 >= 50),
        note: 'early = Nifty moved < 50 pts in the trade direction over the previous 60 min; extended = 50+ pts already done before the lead fired',
    };
    return { overall, dimensions: dims, earlyVsLate, minN };
}

module.exports = { tradeReturn, tagTrades, computeMtfChaseStudy, summarise, bucketSession, bucketRun60, bucketRunDay, bucketRsi, DIMENSIONS };