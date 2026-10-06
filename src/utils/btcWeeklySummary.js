// ── Bitcoin weekly Telegram summary — pure helpers (3 Oct) ────────────────
// No I/O here: server.js fetches the numbers and passes them in, so the
// formatting and the "is it time to send?" logic are unit-testable.

const MIN_TRUST_N = 30;    // same sample floor the app's auto-mute uses
// Trades fired on the same day are NOT independent: Bitcoin fires 100+ signals a day and they all feel the
// same market move together. 205 weekend trades from ONE weekend is really one observation, so a verdict also
// needs at least this many distinct days of data in the bucket (4 = two full weekends for the weekend bucket).
const MIN_TRUST_DAYS = 4;

// Sunday 21:00-23:59 IST (evening before the trading week starts).
// `ist` is a Date already shifted to IST wall-clock (the app's getIST()).
function weekKeyIST(ist) {
    // ISO-8601 year-week, computed on the IST wall-clock date.
    const d = new Date(Date.UTC(ist.getFullYear(), ist.getMonth(), ist.getDate()));
    const day = d.getUTCDay() || 7;            // Mon=1 … Sun=7
    d.setUTCDate(d.getUTCDate() + 4 - day);    // nearest Thursday
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function isWeeklySummaryDue(ist, lastSentWeekKey) {
    if (ist.getDay() !== 0) return false;      // Sunday only
    if (ist.getHours() < 21) return false;     // 21:00 IST onwards (window runs to midnight)
    return lastSentWeekKey !== weekKeyIST(ist);
}

const f1 = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? '—' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)}%`;
const n0 = v => Number(v) || 0;

// days is optional: null/undefined (older data shape) skips the day check instead of blocking everything.
function trustTag(n, days) {
    const why = [];
    if (n0(n) < MIN_TRUST_N) why.push(`only ${n0(n)}/${MIN_TRUST_N} trades`);
    if (days !== null && days !== undefined && n0(days) < MIN_TRUST_DAYS) why.push(`only ${n0(days)}/${MIN_TRUST_DAYS} days`);
    return why.length ? ` ⚠️ ${why.join(', ')} — too few to trust` : '';
}
function trusted(n, days) { return n0(n) >= MIN_TRUST_N && (days === null || days === undefined || n0(days) >= MIN_TRUST_DAYS); }
const daysTxt = d => (d === null || d === undefined) ? '' : ` over ${n0(d)} day${n0(d) === 1 ? '' : 's'}`;

// d = { spread: {n7, n_all, avg_all, median_all, wins_all, losses_all, sl_avg_all, sl_median_all, avg7, median7},
//       split:  [{bucket:'WEEKEND'|'WEEKDAY', n, avg, median, n7}],
//       muted:  ['Fast Momentum', ...] }
function formatBtcWeeklySummary(d, weekKey) {
    const L = ['📅 <b>Bitcoin weekly report</b>' + (weekKey ? ` (${weekKey})` : ''), '━━━━━━━━━━━━━━━━━━'];

    const s = d?.spread;
    L.push('🧮 <b>Defined-risk spread</b> (Bull Call / Bear Put, executable bid/ask)');
    if (!s || n0(s.n_all) === 0) {
        L.push('No resolved spread trades yet — still collecting.');
    } else {
        const decided = n0(s.wins_all) + n0(s.losses_all);
        const wr = decided > 0 ? `${Math.round(100 * n0(s.wins_all) / decided)}%` : '—';
        L.push(`This week: ${n0(s.n7)} trades · avg ${f1(s.avg7)} · median ${f1(s.median7)}`);
        L.push(`All-time: ${n0(s.n_all)} trades${daysTxt(s.days_all)} · avg ${f1(s.avg_all)} · median ${f1(s.median_all)} · win ${wr}${trustTag(s.n_all, s.days_all)}`);
        // NOT a like-for-like comparison, so no "better/worse than naked" verdict is given: the spread is priced at
        // real bid/ask on both legs, the naked figure at last-traded price (no bid-ask cost at all). Part of any gap is
        // trading cost, not strategy. Shown for reference only.
        L.push(`Naked option, last-traded price (no bid-ask cost, so NOT comparable): avg ${f1(s.sl_avg_all)} · median ${f1(s.sl_median_all)}`);
        if (trusted(s.n_all, s.days_all) && Number(s.avg_all) < 0) L.push('🔴 Spread average is negative over enough days — no edge shown yet.');
    }

    L.push('━━━━━━━━━━━━━━━━━━');
    L.push('🌙 <b>Weekend vs weekday</b> (Trade-Coach avg / median, UTC Sat-Sun)');
    const split = Array.isArray(d?.split) ? d.split : [];
    if (!split.length) {
        L.push('No data yet.');
    } else {
        for (const b of ['WEEKEND', 'WEEKDAY']) {
            const r = split.find(x => x.bucket === b);
            if (!r) { L.push(`${b}: no data`); continue; }
            L.push(`${b}: ${n0(r.n)} trades (${n0(r.n7)} this week)${daysTxt(r.days)} · avg ${f1(r.avg)} · median ${f1(r.median)}${trustTag(r.n, r.days)}`);
        }
        const w = split.find(x => x.bucket === 'WEEKEND'), k = split.find(x => x.bucket === 'WEEKDAY');
        if (w && k && trusted(w.n, w.days) && trusted(k.n, k.days)) {
            L.push(Number(w.avg) < Number(k.avg) - 2 ? '⚠️ Weekend is doing worse — keep the liquidity gate on.'
                 : Number(w.avg) > Number(k.avg) + 2 ? '✅ Weekend is NOT worse here.'
                 : '↔️ No clear weekend difference.');
        } else {
            L.push(`⏳ No weekend-vs-weekday verdict yet — needs ${MIN_TRUST_N}+ trades AND ${MIN_TRUST_DAYS}+ days in both groups.`);
        }
    }

    L.push('━━━━━━━━━━━━━━━━━━');
    const muted = Array.isArray(d?.muted) ? d.muted : [];
    L.push(muted.length ? `🔇 <b>Muted Bitcoin triggers:</b> ${muted.join(', ')}` : '🔊 No Bitcoin trigger is muted right now.');
    L.push('<i>Past results don\'t guarantee future ones. Vardaan AI weekly report</i>');
    return L.join('\n');
}

module.exports = { weekKeyIST, isWeeklySummaryDue, formatBtcWeeklySummary, MIN_TRUST_N, MIN_TRUST_DAYS };