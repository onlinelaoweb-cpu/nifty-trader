// ── REGIME study (7 Oct) ──────────────────────────────────────────────────
// Question: do the triggers work in some market regimes and fail in others? The side-split of the trigger study
// showed that Fast Momentum, S/R Bounce and Trend Rider flip from "always right" to "always wrong" between the older
// and newer half of the data — the signature of trend-followers whose record is the regime they happened to meet.
//
// Each NIFTY fire is tagged with the regime AT THE MOMENT IT FIRED (tradable information), from the app's own
// 5-minute market_snapshot_log (latest snapshot at/before the fire, within maxGapMin):
//   adx   — ADX of the chosen timeframe (default 15m):  RANGE (<20) · WEAK (20-25) · TREND (>=25)
//   vix   — VIX:                                         LOW (<13) · MID (13-15) · HIGH (>=15)   (15 = the app's ELEVATED tier)
//   session — IST time of day:                           OPEN 09:15-10:30 · MID 10:30-13:30 · LATE 13:30-15:30
// and with ONE hindsight tag (research only — NOT knowable at fire time):
//   dayType — from that day's OHLC (nifty_daily_history): TREND DAY if |close-open| / (high-low) >= 0.5, else RANGE DAY.
//
// Same safeguards as the other studies: each trigger's fires are de-clustered (30 min) BEFORE bucketing, a cell needs
// minN events AND minDays distinct days, "holds" needs a positive premium average in BOTH the older and newer half of the
// days, and expectedByLuckAlone says how many cells would pass by chance (25% of the TESTABLE qualifying cells).
// With 12 triggers x 11 buckets there are ~130 cells: some WILL look good by luck. Display/research only. PURE.
const { summarize, dayKey } = require('./comboStudy');

const IST_MS = 5.5 * 3600 * 1000;
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const r1 = v => v === null ? null : Math.round(v * 10) / 10;

const bucketAdx = v => { const x = num(v); return x === null ? null : x < 20 ? 'RANGE (<20)' : x < 25 ? 'WEAK (20-25)' : 'TREND (>=25)'; };
const bucketVix = v => { const x = num(v); return x === null || x <= 0 ? null : x < 13 ? 'LOW (<13)' : x < 15 ? 'MID (13-15)' : 'HIGH (>=15)'; };
function bucketSession(ms) {
    const d = new Date(ms + IST_MS), m = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (m >= 555 && m < 630) return 'OPEN 09:15-10:30';
    if (m >= 630 && m < 810) return 'MID 10:30-13:30';
    if (m >= 810 && m <= 930) return 'LATE 13:30-15:30';
    return 'OFF-HOURS';
}
function dayTypeOf(row) {
    const o = num(row?.open), h = num(row?.high), l = num(row?.low), c = num(row?.close);
    if (o === null || h === null || l === null || c === null || !(h > l)) return null;
    return Math.abs(c - o) / (h - l) >= 0.5 ? 'TREND DAY' : 'RANGE DAY';
}

// fires: [{id, source, direction, fire_ts, result, coach_result}]; snapshots: [{ts, vix, mtf_5m_adx, mtf_15m_adx, mtf_1h_adx}] (any order)
// dailyRows: [{date:'YYYY-MM-DD', open, high, low, close}]; opts: { adxTf:'5m'|'15m'|'1h', maxGapMin, todayKey }
function attachRegime(fires, snapshots, dailyRows, opts = {}) {
    const adxCol = { '5m': 'mtf_5m_adx', '15m': 'mtf_15m_adx', '1h': 'mtf_1h_adx' }[opts.adxTf || '15m'] || 'mtf_15m_adx';
    const maxGap = (opts.maxGapMin ?? 10) * 60000;
    const snaps = (snapshots || []).map(s => ({ ts: typeof s.ts === 'number' ? s.ts : Date.parse(s.ts), vix: num(s.vix), adx: num(s[adxCol]) }))
        .filter(s => Number.isFinite(s.ts)).sort((a, b) => a.ts - b.ts);
    const dayMap = new Map(); for (const d of dailyRows || []) { const t = dayTypeOf(d); if (t && d.date) dayMap.set(String(d.date).slice(0, 10), t); }
    const out = []; const gaps = [];
    const cov = { fires: 0, withSnapshot: 0, withAdx: 0, withVix: 0, withDayType: 0 };
    let j = 0;
    const sorted = (fires || []).map(f => ({ ...f, _ts: typeof f.fire_ts === 'number' ? f.fire_ts : Date.parse(f.fire_ts) })).filter(f => Number.isFinite(f._ts)).sort((a, b) => a._ts - b._ts);
    for (const f of sorted) {
        cov.fires++;
        while (j + 1 < snaps.length && snaps[j + 1].ts <= f._ts) j++;
        const s = snaps.length && snaps[j].ts <= f._ts && f._ts - snaps[j].ts <= maxGap ? snaps[j] : null;
        if (s) { cov.withSnapshot++; gaps.push((f._ts - s.ts) / 60000); }
        const adx = s ? bucketAdx(s.adx) : null, vix = s ? bucketVix(s.vix) : null;
        if (adx) cov.withAdx++; if (vix) cov.withVix++;
        const dk = dayKey(f._ts);
        const dayType = opts.todayKey && dk >= opts.todayKey ? null : (dayMap.get(dk) || null);   // today's candle is still forming
        if (dayType) cov.withDayType++;
        out.push({ id: f.id, source: f.source, direction: f.direction, fire_ts: f._ts, result: f.result, coach_result: f.coach_result,
                   regime: { adx, vix, session: bucketSession(f._ts), dayType } });
    }
    gaps.sort((a, b) => a - b);
    cov.medianGapMin = gaps.length ? r1(gaps[gaps.length >> 1]) : null;
    cov.snapshotRows = snaps.length;
    cov.snapshotFirst = snaps.length ? new Date(snaps[0].ts).toISOString() : null;
    cov.snapshotLast = snaps.length ? new Date(snaps[snaps.length - 1].ts).toISOString() : null;
    cov.dailyRows = dayMap.size;
    return { rows: out, coverage: cov };
}

const DIMENSIONS = ['adx', 'vix', 'session', 'dayType'];

function computeRegimeStudy(tagged, opts = {}) {
    const declusterMs = (opts.declusterMin ?? 30) * 60000;
    const minN = opts.minN ?? 20, minDays = opts.minDays ?? 4, minHalfN = opts.minHalfN ?? 10, topK = opts.topK ?? 10;
    // 1) de-cluster each trigger on its own, once
    const bySrc = new Map();
    for (const r of tagged || []) {
        if ((r.direction !== 'BULLISH' && r.direction !== 'BEARISH') || !r.source) continue;
        const e = { id: r.id, ts: r.fire_ts, src: String(r.source), dir: r.direction, result: r.result || null, coach: num(r.coach_result), day: dayKey(r.fire_ts), regime: r.regime || {} };
        (bySrc.get(e.src) || bySrc.set(e.src, []).get(e.src)).push(e);
    }
    const kept = []; let dropped = 0;
    for (const evs of bySrc.values()) {
        evs.sort((a, b) => a.ts - b.ts); let last = -Infinity;
        for (const e of evs) { if (e.ts - last >= declusterMs) { kept.push(e); last = e.ts; } else dropped++; }
    }
    // 2) per dimension: pooled stats of every bucket + a cell per (trigger, bucket)
    const halves = list => {
        const days = [...new Set(list.map(e => e.day))].sort();
        const cut = days[Math.floor(days.length / 2)];
        return { days, older: summarize(list.filter(e => e.day < cut)), newer: summarize(list.filter(e => e.day >= cut)) };
    };
    const dimensions = {}; const allCells = [];
    for (const dim of DIMENSIONS) {
        const buckets = new Map();
        for (const e of kept) { const b = e.regime[dim]; if (b) (buckets.get(b) || buckets.set(b, []).get(b)).push(e); }
        const outB = {};
        for (const [b, list] of buckets) {
            const pooled = summarize(list), cellsBySrc = new Map();
            for (const e of list) (cellsBySrc.get(e.src) || cellsBySrc.set(e.src, []).get(e.src)).push(e);
            const cells = [];
            for (const [src, evs] of cellsBySrc) {
                const st = summarize(evs), h = halves(evs);
                const qualifies = st.n >= minN && st.days >= minDays && st.coachN >= Math.min(minN, 10);
                const testable = qualifies && h.days.length >= 2 && h.older.coachN >= minHalfN && h.newer.coachN >= minHalfN;
                const holds = testable && h.older.coachAvg > 0 && h.newer.coachAvg > 0;
                const cell = { dimension: dim, bucket: b, source: src, ...st, qualifies, testable, holds,
                    verdict: !qualifies ? 'TOO FEW' : !testable ? 'UNTESTABLE (premium results cover only one half)' : holds ? 'HOLDS' : 'FAILS',
                    vsBucket: (st.coachAvg !== null && pooled.coachAvg !== null) ? r1(st.coachAvg - pooled.coachAvg) : null,
                    olderHalf: { n: h.older.n, coachN: h.older.coachN, coachAvg: h.older.coachAvg, dirN: h.older.dirN, dirWinPct: h.older.dirWinPct },
                    newerHalf: { n: h.newer.n, coachN: h.newer.coachN, coachAvg: h.newer.coachAvg, dirN: h.newer.dirN, dirWinPct: h.newer.dirWinPct } };
                cells.push(cell); allCells.push(cell);
            }
            cells.sort((a, c) => (c.qualifies - a.qualifies) || ((c.coachAvg ?? -1e9) - (a.coachAvg ?? -1e9)));
            outB[b] = { pooled, cells };
        }
        dimensions[dim] = outB;
    }
    const q = allCells.filter(c => c.qualifies), tq = q.filter(c => c.testable);
    const byAvg = (a, c) => (c.coachAvg ?? -1e9) - (a.coachAvg ?? -1e9);
    return {
        params: { declusterMin: opts.declusterMin ?? 30, minN, minDays, minHalfN },
        keptEvents: kept.length, droppedByDeclustering: dropped, baseline: summarize(kept),
        cellsTested: allCells.length, qualifying: q.length, qualifyingTestable: tq.length,
        holdsBothHalves: q.filter(c => c.holds).length, expectedByLuckAlone: Math.round(tq.length * 0.25 * 10) / 10,
        best: q.slice().sort(byAvg).slice(0, topK), worst: q.slice().sort((a, c) => -byAvg(a, c)).slice(0, topK),
        holding: q.filter(c => c.holds).sort(byAvg).slice(0, topK),
        dimensions,
    };
}

module.exports = { attachRegime, computeRegimeStudy, bucketAdx, bucketVix, bucketSession, dayTypeOf, DIMENSIONS };