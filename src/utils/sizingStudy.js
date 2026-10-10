'use strict';
// ── Position-sizing study (10 Oct 2026) ────────────────────────────────────────────────────────────
// QUESTION (from the Murarka stop-loss webinar): "if the stop is bigger, take fewer lots; if it is smaller, take more, so the rupee
// risk stays constant". In this app the stop is a fixed % of the premium (e.g. -15%), so the rupee risk of 1 lot = 15% x premium x lot
// size: an expensive premium risks more rupees than a cheap one. Does sizing every trade to the SAME rupee risk (and a daily loss stop /
// shrinking after losses) give a smoother and better result than a flat number of lots?
// HOW: takes the per-trade % result of the declustered trade population (Trade-Coach grid, before brokerage) and replays it, in time
// order, under four sizing rules. Rupee P&L = result% x entry premium x lot size x lots. The % results do not change with size, so
// this measures risk/smoothness (worst day, drawdown, return per drawdown), not a better edge.
//   FIXED_1                    1 lot on every trade (reference)
//   RISK_PARITY                lots = risk Rs / (|SL%| x premium x lot size), rounded, 1..maxLots
//   RISK_PARITY_DAY_STOP       risk parity, but stop taking trades for the day once the day is down dayStopR x risk
//   RISK_PARITY_HALF_AFTER_2L  risk parity, half size (min 1) after two losing trades in a row, back to full after a win
// HONEST LIMITS: few days of one regime; a rule that trades fewer/smaller after losses can only look better on a sample where losses
// cluster; slippage and brokerage are ignored. Research only — paper trading, nothing here feeds signals or alerts. PURE.

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r0 = v => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v);
const r2 = v => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
const istDay = ts => new Date(ts + 330 * 60000).toISOString().slice(0, 10);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function lotsForRisk(entry, slPct, riskRs, lotSize, maxLots) {
    const perLot = (Math.abs(slPct) / 100) * entry * lotSize;
    if (!(perLot > 0)) return 1;
    return clamp(Math.round(riskRs / perLot), 1, maxLots);
}

// trades: [{ fireTs, source, entryPremium, resultPct }]
function runScheme(trades, name, p) {
    let cum = 0, peak = 0, maxDD = 0, losses = 0, taken = 0, lotsSum = 0, wins = 0;
    const dayPnl = new Map(), tradeRs = [];
    for (const t of trades) {
        const day = istDay(t.fireTs);
        let lots;
        if (name === 'FIXED_1') lots = 1;
        else lots = lotsForRisk(t.entryPremium, p.slPct, p.riskRs, p.lotSize, p.maxLots);
        if (name === 'RISK_PARITY_DAY_STOP' && (dayPnl.get(day) || 0) <= -p.dayStopR * p.riskRs) continue;
        if (name === 'RISK_PARITY_HALF_AFTER_2L' && losses >= 2) lots = Math.max(1, Math.round(lots / 2));
        const rs = (t.resultPct / 100) * t.entryPremium * p.lotSize * lots;
        taken++; lotsSum += lots; tradeRs.push(rs);
        if (rs > 0) wins++;
        losses = t.resultPct < 0 ? losses + 1 : 0;
        dayPnl.set(day, (dayPnl.get(day) || 0) + rs);
        cum += rs; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum;
    }
    const days = [...dayPnl.values()];
    return {
        scheme: name, tradesTaken: taken, tradesSkipped: trades.length - taken, avgLots: taken ? r2(lotsSum / taken) : null,
        totalRs: r0(cum), avgRsPerTrade: taken ? r0(cum / taken) : null, winPct: taken ? Math.round(1000 * wins / taken) / 10 : null,
        worstTradeRs: tradeRs.length ? r0(Math.min(...tradeRs)) : null, worstDayRs: days.length ? r0(Math.min(...days)) : null,
        bestDayRs: days.length ? r0(Math.max(...days)) : null, maxDrawdownRs: r0(maxDD),
        returnPerDrawdown: maxDD > 0 ? r2(cum / maxDD) : null, tradingDays: days.length,
    };
}

function computeSizingStudy(trades, opts = {}) {
    const p = { riskRs: opts.riskRs ?? 2000, lotSize: opts.lotSize ?? 65, slPct: opts.slPct ?? -15, maxLots: opts.maxLots ?? 10, dayStopR: opts.dayStopR ?? 3 };
    const list = (trades || []).filter(t => t && t.entryPremium > 0 && Number.isFinite(t.resultPct) && Number.isFinite(t.fireTs)).sort((a, b) => a.fireTs - b.fireTs);
    const schemes = ['FIXED_1', 'RISK_PARITY', 'RISK_PARITY_DAY_STOP', 'RISK_PARITY_HALF_AFTER_2L'].map(n => runScheme(list, n, p));
    const buckets = [['premium < 60', t => t.entryPremium < 60], ['premium 60-120', t => t.entryPremium >= 60 && t.entryPremium < 120], ['premium >= 120', t => t.entryPremium >= 120]]
        .map(([label, test]) => {
            const l = list.filter(test), res = l.map(t => t.resultPct);
            return { label, n: l.length, avgPct: r2(mean(res)), winPct: l.length ? Math.round(1000 * res.filter(v => v > 0).length / l.length) / 10 : null,
                     avgLotsAtRiskParity: l.length ? r2(mean(l.map(t => lotsForRisk(t.entryPremium, p.slPct, p.riskRs, p.lotSize, p.maxLots)))) : null,
                     oneLotRiskRs: l.length ? r0((Math.abs(p.slPct) / 100) * mean(l.map(t => t.entryPremium)) * p.lotSize) : null };
        });
    const rp = list.map(t => lotsForRisk(t.entryPremium, p.slPct, p.riskRs, p.lotSize, p.maxLots));
    return {
        tradesUsed: list.length, assumptions: p, schemes, byPremium: buckets,
        lotsAtRiskParity: list.length ? { min: Math.min(...rp), median: median(rp), max: Math.max(...rp) } : null,
        note: `Fixed rupee risk per trade = Rs ${p.riskRs} (change with &risk=). Stop assumed ${p.slPct}% of premium, lot size ${p.lotSize}, lots capped at ${p.maxLots}. Because the stop is a fixed % of premium, risk parity simply means fewer lots on expensive premiums and more on cheap ones. The % result of each trade is unchanged by size, so this compares risk and smoothness, not edge. Before brokerage; few days of one regime.`,
    };
}

function formatSizingText(res) {
    const L = [];
    const f = v => v === null || v === undefined ? '-' : (v > 0 ? '+' : '') + v;
    L.push('POSITION-SIZING STUDY — flat lots vs fixed-rupee-risk sizing (Murarka: bigger stop -> fewer lots)');
    L.push(`Trades used: ${res.tradesUsed}.  Risk Rs ${res.assumptions.riskRs}/trade, stop ${res.assumptions.slPct}%, lot ${res.assumptions.lotSize}, max ${res.assumptions.maxLots} lots`);
    L.push('');
    L.push('SCHEME                      taken  skip  avgLots   total Rs  avg Rs/trade  win%   worstTrade  worstDay   maxDD   ret/DD');
    for (const s of res.schemes) L.push(`${s.scheme.padEnd(27)} ${String(s.tradesTaken).padStart(5)} ${String(s.tradesSkipped).padStart(5)} ${String(s.avgLots ?? '-').padStart(8)} ${String(f(s.totalRs)).padStart(10)} ${String(f(s.avgRsPerTrade)).padStart(13)} ${String(s.winPct ?? '-').padStart(5)} ${String(f(s.worstTradeRs)).padStart(11)} ${String(f(s.worstDayRs)).padStart(9)} ${String(s.maxDrawdownRs ?? '-').padStart(7)} ${String(s.returnPerDrawdown ?? '-').padStart(7)}`);
    L.push('');
    L.push('BY PREMIUM LEVEL (does a cheap or an expensive premium behave differently?)');
    for (const b of res.byPremium) L.push(`  ${b.label.padEnd(16)} n=${String(b.n).padStart(3)}  avg ${String(f(b.avgPct)).padStart(6)}%  win ${String(b.winPct ?? '-').padStart(5)}%  1-lot risk Rs ${b.oneLotRiskRs ?? '-'}  lots at risk parity ${b.avgLotsAtRiskParity ?? '-'}`);
    if (res.lotsAtRiskParity) L.push(`  lots at risk parity: min ${res.lotsAtRiskParity.min}, median ${res.lotsAtRiskParity.median}, max ${res.lotsAtRiskParity.max}`);
    L.push('');
    L.push(res.note);
    return L.join('\n');
}

module.exports = { lotsForRisk, runScheme, computeSizingStudy, formatSizingText };