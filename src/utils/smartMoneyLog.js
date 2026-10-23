'use strict';
// 23 Oct 2026 - SMART MONEY LOG (record-only). The Smart Money bias was only a live number (computeSmartMoneyBias) and was never stored, so
// "what was the bias when I took that trade?" could not be answered. This builds one row per snapshot: the bias, the total score and each of the
// 5 parts (OI Buildup, FII, DII, PCR level, ATM flow), plus the date of the FII/DII figure (it is an end-of-day number, so it is usually
// from the PREVIOUS day while the market is open). Pure functions: no DB, no clock. It never changes a signal, gate or alert.

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = v => (v === null ? null : Math.round(v * 100) / 100);

// state = marketState. Returns a flat row, or null when there is no smart-money object yet.
function buildRow(state) {
    const sm = state && state.smartMoney;
    if (!sm || !sm.bias || !Array.isArray(sm.components)) return null;
    const part = label => sm.components.find(c => c && c.label === label) || null;
    const pts = c => (c ? num(c.pts) : null);
    const oi = part('OI Buildup'), fii = part('FII Flow'), dii = part('DII Flow'), pcr = part('PCR Level'), atm = part('ATM Flow');
    const f = state.fii || {}, d = state.dii || {};
    const ratio = (() => { const m = atm && /CE\/PE=([0-9.]+)/.exec(String(atm.value || '')); return m ? num(m[1]) : null; })();
    return {
        bias: String(sm.bias), score: num(sm.score),
        oi_pts: pts(oi), oi_label: oi ? String(oi.value || '').slice(0, 60) : null,
        fii_pts: pts(fii), fii_net: num(f.net), dii_pts: pts(dii), dii_net: num(d.net),
        pcr_pts: pts(pcr), pcr: r2(num(state.pcr)), atm_pts: pts(atm), atm_ratio: ratio,
        fii_dii_date: f.date ? String(f.date).slice(0, 20) : null, fii_dii_fetched_at: f.updatedAt ? String(f.updatedAt).slice(0, 30) : null,
        nifty: num(state.nifty),
    };
}

// rows: [{ ts, bias, score, fii_dii_date, nifty, ... }] oldest first. Per IST day: first/last bias, how many times it changed, score range,
// and which FII/DII dates were used - this is the "how static is it" view.
function summarize(rows) {
    const list = (Array.isArray(rows) ? rows : []).map(r => ({ ...r, t: new Date(r.ts).getTime() })).filter(r => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
    const dayOf = t => new Date(t + 19800000).toISOString().slice(0, 10);
    const days = new Map();
    for (const r of list) { const k = dayOf(r.t); if (!days.has(k)) days.set(k, []); days.get(k).push(r); }
    return [...days.entries()].map(([day, rs]) => {
        let changes = 0; for (let i = 1; i < rs.length; i++) if (rs[i].bias !== rs[i - 1].bias) changes++;
        const sc = rs.map(r => num(r.score)).filter(v => v !== null);
        return { day, rows: rs.length, firstBias: rs[0].bias, lastBias: rs[rs.length - 1].bias, changes,
            scoreMin: sc.length ? Math.min(...sc) : null, scoreMax: sc.length ? Math.max(...sc) : null,
            fiiDiiDates: [...new Set(rs.map(r => r.fii_dii_date).filter(Boolean))] };
    });
}

module.exports = { buildRow, summarize };