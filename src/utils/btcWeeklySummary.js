// ── Bitcoin weekly Telegram summary — pure helpers (3 Oct) ────────────────
// No I/O here: server.js fetches the numbers and passes them in, so the
// formatting and the "is it time to send?" logic are unit-testable.

const MIN_TRUST_N = 30; // same sample floor the app's auto-mute uses

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

function trustTag(n) {
    return n0(n) >= MIN_TRUST_N ? '' : ` ⚠️ only ${n0(n)}/${MIN_TRUST_N} — too few to trust`;
}

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
        L.push(`All-time: ${n0(s.n_all)} trades · avg ${f1(s.avg_all)} · median ${f1(s.median_all)} · win ${wr}${trustTag(s.n_all)}`);
        L.push(`Naked option (last-traded, flattering) same period: avg ${f1(s.sl_avg_all)} · median ${f1(s.sl_median_all)}`);
        if (n0(s.n_all) >= MIN_TRUST_N) {
            const beats = Number(s.avg_all) > Number(s.sl_avg_all);
            L.push(beats ? '↗️ Spread avg is better than naked, even with bid-ask cost counted.'
                         : '↘️ Spread avg is NOT better than naked option.');
            if (Number(s.avg_all) < 0) L.push('🔴 Spread average is still negative — no edge shown yet.');
        }
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
            L.push(`${b}: ${n0(r.n)} trades (${n0(r.n7)} this week) · avg ${f1(r.avg)} · median ${f1(r.median)}${trustTag(r.n)}`);
        }
        const w = split.find(x => x.bucket === 'WEEKEND'), k = split.find(x => x.bucket === 'WEEKDAY');
        if (w && k && n0(w.n) >= MIN_TRUST_N && n0(k.n) >= MIN_TRUST_N) {
            L.push(Number(w.avg) < Number(k.avg) - 2 ? '⚠️ Weekend is doing worse — keep the liquidity gate on.'
                 : Number(w.avg) > Number(k.avg) + 2 ? '✅ Weekend is NOT worse here.'
                 : '↔️ No clear weekend difference.');
        }
    }

    L.push('━━━━━━━━━━━━━━━━━━');
    const muted = Array.isArray(d?.muted) ? d.muted : [];
    L.push(muted.length ? `🔇 <b>Muted Bitcoin triggers:</b> ${muted.join(', ')}` : '🔊 No Bitcoin trigger is muted right now.');
    L.push('<i>Past results don\'t guarantee future ones. Vardaan AI weekly report</i>');
    return L.join('\n');
}

module.exports = { weekKeyIST, isWeeklySummaryDue, formatBtcWeeklySummary, MIN_TRUST_N };