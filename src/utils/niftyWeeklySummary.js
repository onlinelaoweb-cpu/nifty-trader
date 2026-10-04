// ── NIFTY weekly Telegram report — pure formatter (3 Oct) ─────────────────
// Sent Sunday night (see server.js niftyWeeklySummaryTick). No I/O in here:
// server.js fetches the numbers, so formatting + verdict rules are unit-testable.
//
// What it answers (the 3-4 week decision the user set up):
//   1. How many signals did the live engine give vs the original "Classic" rule?
//   2. For signals a NEWER gate held back: did they win or lose? (=> is that gate
//      protecting money or costing winners?)
//   3. Does the Delta-Response "SLOW RESPONSE" warning actually predict worse trades?
//
// Verdicts are only issued with MIN_TRUST_N (30) resolved rows in the bucket, and
// the neutral band means "no clear difference" is a legitimate answer.

const MIN_TRUST_N = 30;
const GATE_VERDICT_PCT = 3;      // avg Trade-Coach % of the blocked signals: > +3 costing winners, < -3 protecting
const RESP_VERDICT_PTS = 10;     // warned vs judged-not-warned target-hit % gap (percentage points)

const num = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? null : Number(v);
const pct1 = v => { const n = num(v); return n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`; };
const plain1 = v => { const n = num(v); return n === null ? '—' : `${n.toFixed(1)}%`; };
const n0 = v => num(v) ?? 0;

function find(rows, bucket) { return (Array.isArray(rows) ? rows : []).find(r => r.bucket === bucket) || null; }

function gateVerdict(row) {
    const n = n0(row.coach_n);
    if (n < MIN_TRUST_N) return { icon: '⏳', text: `collecting (${n}/${MIN_TRUST_N})` };
    const avg = num(row.avg_coach_pct);
    if (avg === null) return { icon: '⏳', text: 'no result yet' };
    if (avg > GATE_VERDICT_PCT)  return { icon: '⚠️', text: 'blocked signals were WINNING — this gate may be costing you trades' };
    if (avg < -GATE_VERDICT_PCT) return { icon: '✅', text: 'blocked signals were LOSING — this gate is protecting you' };
    return { icon: '↔️', text: 'no clear difference — gate is neutral so far' };
}

// d = { week:{ classic:{total,live_fired,held_back}, live:{main,mtf_strong_sent} },
//       buckets:[{bucket,n,n7,dir_n,dir_win_pct,coach_n,avg_coach_pct,median_coach_pct}],
//       deltaResp:[{bucket:'WARNED'|'JUDGED_NOT_WARNED',trades,target_hit_pct,sl_hit_pct,avg_max_adverse_pct}] }
function formatNiftyWeeklySummary(d, weekKey) {
    const L = ['📅 <b>NIFTY weekly report</b>' + (weekKey ? ` (${weekKey})` : ''), '━━━━━━━━━━━━━━━━━━'];

    // 1 ── signal volume
    const c = d?.week?.classic, lv = d?.week?.live;
    L.push('🏛️ <b>Classic (original 6-filter rule) vs live engine</b> — this week');
    L.push(`Live engine: ${n0(lv?.main)} main + ${n0(lv?.mtf_strong_sent)} MTF-strong alerts`);
    if (!c || n0(c.total) === 0) L.push('Classic: no signals logged yet.');
    else L.push(`Classic: ${n0(c.total)} signals — ${n0(c.live_fired)} also fired by live engine, ${n0(c.held_back)} held back by a newer gate`);

    // 2 ── how the two groups performed (all-time, resolved only)
    const buckets = d?.buckets || [];
    const live = find(buckets, 'Live engine ALSO fired'), held = find(buckets, 'Held back by a newer gate');
    L.push('━━━━━━━━━━━━━━━━━━');
    L.push('📊 <b>Results so far</b> (Trade-Coach premium sim, avg / median)');
    const line = (name, r) => r
        ? `${name}: ${n0(r.coach_n)} trades · avg ${pct1(r.avg_coach_pct)} · median ${pct1(r.median_coach_pct)} · direction right ${plain1(r.dir_win_pct)}${n0(r.coach_n) < MIN_TRUST_N ? ` ⚠️ only ${n0(r.coach_n)}/${MIN_TRUST_N}` : ''}`
        : `${name}: no data yet`;
    L.push(line('Live engine fired', live));
    L.push(line('Held back by gates', held));
    if (live && held && n0(live.coach_n) >= MIN_TRUST_N && n0(held.coach_n) >= MIN_TRUST_N) {
        const diff = num(held.avg_coach_pct) - num(live.avg_coach_pct);
        L.push(diff > GATE_VERDICT_PCT ? '⚠️ Held-back signals are doing BETTER than the ones the live engine fires.'
             : diff < -GATE_VERDICT_PCT ? '✅ Held-back signals are doing WORSE — the gates are filtering well overall.'
             : '↔️ No clear difference between fired and held-back signals.');
    }

    // 3 ── per-gate
    const gates = buckets.filter(r => typeof r.bucket === 'string' && r.bucket.startsWith('blocked by: '))
        // real gates first (most evidence first); the 1-tick "timing only" row is informational, so it goes last
        .sort((a, b) => (/timing only/i.test(a.bucket) - /timing only/i.test(b.bucket)) || (n0(b.coach_n) - n0(a.coach_n))).slice(0, 7);
    L.push('━━━━━━━━━━━━━━━━━━');
    L.push('🚧 <b>Gate by gate</b> (a signal can be held by several gates; rows overlap)');
    if (!gates.length) L.push('No held-back signals resolved yet.');
    for (const g of gates) {
        const name = g.bucket.slice('blocked by: '.length);
        if (/timing only/i.test(name)) { L.push(`• ${name}: ${n0(g.n)} signals — just a 1-tick delay, not a real filter`); continue; }
        const v = gateVerdict(g);
        L.push(`• ${name}: ${n0(g.coach_n)} resolved · avg ${pct1(g.avg_coach_pct)} ${v.icon} ${v.text}`);
    }

    // 4 ── delta response
    const dr = d?.deltaResp || [];
    const w = find(dr, 'WARNED'), nw = find(dr, 'JUDGED_NOT_WARNED');
    L.push('━━━━━━━━━━━━━━━━━━');
    L.push('🐢 <b>Delta-Response warning — does it predict trouble?</b>');
    if (!w && !nw) L.push('No trades judged yet.');
    else {
        const dl = (name, r) => r ? `${name}: ${n0(r.trades)} trades · target hit ${plain1(r.target_hit_pct)} · SL hit ${plain1(r.sl_hit_pct)} · avg worst dip ${pct1(r.avg_max_adverse_pct)}` : `${name}: none`;
        L.push(dl('Warned', w)); L.push(dl('Not warned', nw));
        if (w && nw && n0(w.trades) >= MIN_TRUST_N && n0(nw.trades) >= MIN_TRUST_N) {
            const gap = num(nw.target_hit_pct) - num(w.target_hit_pct);
            L.push(gap >= RESP_VERDICT_PTS ? '✅ Warned trades hit target clearly less often — the warning is useful.'
                 : gap <= -RESP_VERDICT_PTS ? '⚠️ Warned trades did NOT do worse — the warning may be a false alarm.'
                 : '↔️ No clear difference yet.');
        } else L.push(`⏳ Need ${MIN_TRUST_N}+ trades in both groups before judging.`);
    }

    L.push('━━━━━━━━━━━━━━━━━━');
    L.push('<i>Measured, not proven. Past results don\'t guarantee future ones. Vardaan AI weekly report</i>');
    return L.join('\n');
}

module.exports = { formatNiftyWeeklySummary, gateVerdict, MIN_TRUST_N, GATE_VERDICT_PCT, RESP_VERDICT_PTS };