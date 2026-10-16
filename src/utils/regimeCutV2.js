'use strict';
// ── Regime cut v2 (pre-registered 17 Oct, see Go-Live Checklist Gate 1) ───────────────────────────────────────────────
// Question: do leads fired in a TRENDING regime (1h ADX >= 25 at fire time) beat leads fired in a RANGE regime (1h ADX < 25)?
// Fixed before any confirmation data: threshold 25, round-trip costs 3 percentage points of premium per lead, at least 20
// declustered leads per bucket, range average at least 5 points worse than trend, same direction in both time halves.
// Anything short of that is "NO EVIDENCE" and no rule changes. Confirmation set = leads fired on/after 17 Oct 2026 IST;
// older leads may be shown (since = 'all') but are labelled DESCRIPTIVE because their ADX buckets were already seen.
// Pure functions: no DB, no clock. Used by /api/regime-cut-v2 for the MTF tracker and for Brahmastra.

const { declusterLeads } = require('./leadDecluster');

const CONFIRMATION_START_MS = Date.parse('2026-10-17T00:00:00+05:30');
const num = v => { const x = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(x) ? null : x; };
const r1 = x => Math.round(x * 10) / 10;
const toMs = v => (v instanceof Date ? v.getTime() : new Date(v).getTime());
const avg = a => a.length ? r1(a.reduce((s, x) => s + x, 0) / a.length) : null;

// snaps: [{ ts, mtf_1h_adx, ... }] -> sorted array with ms; returns last snapshot at/before ms within tolMs, else null
function prepareSnaps(snaps) {
    return (Array.isArray(snaps) ? snaps : []).map(s => ({ ms: toMs(s.ts), adx1h: num(s.mtf_1h_adx) }))
        .filter(s => Number.isFinite(s.ms)).sort((a, b) => a.ms - b.ms);
}
function snapAtOrBefore(sorted, ms, tolMs) {
    let lo = 0, hi = sorted.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (sorted[mid].ms <= ms) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best >= 0 && ms - sorted[best].ms <= tolMs ? sorted[best] : null;
}

function bucketStats(items, costPp) {
    const net = items.map(x => x.ret - costPp);
    return { n: items.length, avgNet: avg(net), avgGross: avg(items.map(x => x.ret)),
        winPct: items.length ? Math.round(100 * net.filter(x => x > 0).length / items.length) : null };
}

// items: [{ id, ts, side, ret }]  ret = percent return BEFORE costs (null/NaN = not resolved yet -> skipped)
// snaps: market_snapshot_log rows. opts: { thr=25, costPp=3, minN=20, minDiff=5, declusterMin=60, tolMin=10, since='confirmation'|'all' }
function evaluateRegimeCutV2(items, snaps, opts) {
    const o = Object.assign({ thr: 25, costPp: 3, minN: 20, minDiff: 5, declusterMin: 60, tolMin: 10, since: 'confirmation' }, opts || {});
    const confirmation = o.since !== 'all';
    const all = (Array.isArray(items) ? items : []).map(x => ({ id: x.id, ms: toMs(x.ts), side: x.side, ret: num(x.ret) }));
    const resolved = all.filter(x => Number.isFinite(x.ms) && x.ret !== null);
    const scoped = confirmation ? resolved.filter(x => x.ms >= CONFIRMATION_START_MS) : resolved;
    const used = declusterLeads(scoped, o.declusterMin, x => x.ms, x => x.side);
    const sorted = prepareSnaps(snaps);
    const tagged = used.map(x => {
        const s = snapAtOrBefore(sorted, x.ms, o.tolMin * 60000);
        const adx = s ? s.adx1h : null;
        return Object.assign({}, x, { adx1h: adx, regime: adx === null ? null : (adx >= o.thr ? 'trend' : 'range') });
    });
    const matched = tagged.filter(x => x.regime);
    const split = list => ({ trend: bucketStats(list.filter(x => x.regime === 'trend'), o.costPp), range: bucketStats(list.filter(x => x.regime === 'range'), o.costPp) });
    const whole = split(matched);
    const byTime = matched.slice().sort((a, b) => a.ms - b.ms);
    const mid = Math.floor(byTime.length / 2);
    const h1 = split(byTime.slice(0, mid)), h2 = split(byTime.slice(mid));
    const diff = (whole.trend.avgNet !== null && whole.range.avgNet !== null) ? r1(whole.trend.avgNet - whole.range.avgNet) : null;
    const dir = s => (s.trend.avgNet !== null && s.range.avgNet !== null) ? Math.sign(s.trend.avgNet - s.range.avgNet) : 0;
    const halvesAgree = dir(h1) !== 0 && dir(h1) === dir(h2) && dir(h1) === Math.sign(diff || 0);
    let verdict;
    if (!confirmation) verdict = 'DESCRIPTIVE ONLY - includes leads whose ADX buckets were already seen on 16 Oct; this is not the confirmation test.';
    else if (whole.trend.n < o.minN || whole.range.n < o.minN) verdict = `NO EVIDENCE YET - need ${o.minN}+ declustered leads in each bucket (trend ${whole.trend.n}, range ${whole.range.n}).`;
    else if (diff !== null && diff >= o.minDiff && halvesAgree) verdict = 'PASS - range regime is worse by the pre-registered margin in both halves. Next step is a 10-day paper filter test, not a live rule.';
    else verdict = 'NO EVIDENCE - minimum counts met but the margin and/or both-halves rule was not met. No rule changes.';
    return {
        rule: { thr: o.thr, costPp: o.costPp, minN: o.minN, minDiffPp: o.minDiff, declusterMin: o.declusterMin, confirmationFrom: '2026-10-17 IST', scope: confirmation ? 'confirmation' : 'all (descriptive)' },
        counts: { resolved: resolved.length, inScope: scoped.length, afterDecluster: used.length, matchedToSnapshot: matched.length },
        trend: whole.trend, range: whole.range, diffTrendMinusRangePp: diff,
        halves: { first: h1, second: h2, agree: halvesAgree }, verdict,
        rows: tagged.map(x => ({ id: x.id, ts: new Date(x.ms).toISOString(), side: x.side, ret: x.ret, adx1h: x.adx1h, regime: x.regime })),
    };
}

module.exports = { evaluateRegimeCutV2, CONFIRMATION_START_MS, snapAtOrBefore, prepareSnaps };