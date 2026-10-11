'use strict';
// Supply / Demand zone study (11 Oct). RESEARCH ONLY — read-only, nothing here feeds signals or alerts.
//
// A DEMAND zone = the small "base" (1–3 quiet candles) right before a strong impulse candle that leaves upward;
// a SUPPLY zone = the same before a strong impulse down. Question this answers: when price comes back and FIRST
// touches such a zone, does it react (bounce) more often than it does at a placebo level of the same width placed
// 1–1.5 ATR away? If not, zones add nothing over a random line and are not worth showing in the app.
//
// Candles: [{date, open, high, low, close}] oldest → newest (daily here; works on any timeframe).

const num = v => Number(v);
const trueRange = (c, prev) => Math.max(c.high - c.low, prev ? Math.abs(c.high - prev.close) : 0, prev ? Math.abs(c.low - prev.close) : 0);

function atrAt(candles, i, n = 14) {
    if (i < 1) return null;
    const from = Math.max(1, i - n + 1);
    let s = 0, k = 0;
    for (let j = from; j <= i; j++) { s += trueRange(candles[j], candles[j - 1]); k++; }
    return k ? s / k : null;
}

function detectZones(candles, opt = {}) {
    const o = { impulseAtr: 1.6, bodyFrac: 0.6, baseAtr: 0.8, maxBase: 3, maxWidthAtr: 1.0, atrN: 14, ...opt };
    const zones = [];
    for (let k = o.atrN + 1; k < candles.length; k++) {
        const atr = atrAt(candles, k - 1, o.atrN);
        const c = candles[k];
        if (!atr || !(atr > 0)) continue;
        const range = c.high - c.low, body = Math.abs(c.close - c.open);
        if (range < o.impulseAtr * atr || body < o.bodyFrac * range) continue;
        const up = c.close > c.open;
        // base = consecutive quiet candles immediately before the impulse
        let b = k - 1, n = 0;
        while (b >= 1 && n < o.maxBase && (candles[b].high - candles[b].low) <= o.baseAtr * atr) { b--; n++; }
        if (!n) continue;
        const base = candles.slice(b + 1, k);
        const lo = Math.min(...base.map(x => x.low)), hi = Math.max(...base.map(x => x.high));
        if (hi - lo > o.maxWidthAtr * atr) continue;
        if (up && !(c.close > hi)) continue;       // impulse must clearly leave the base
        if (!up && !(c.close < lo)) continue;
        zones.push({ type: up ? 'DEMAND' : 'SUPPLY', lo, hi, formedIdx: k, atr, date: c.date });
    }
    return zones;
}

// First touch after formation, while the zone is still valid (not closed through). Returns outcome or null.
function evaluateZone(candles, z, opt = {}) {
    const o = { horizon: 3, targetAtr: 1.0, stopAtr: 0.25, minGap: 1, ...opt };
    const demand = z.type === 'DEMAND';
    for (let j = z.formedIdx + 1 + o.minGap; j < candles.length; j++) {
        const c = candles[j];
        if (demand ? c.close < z.lo : c.close > z.hi) return null;           // closed through → zone dead before any clean touch
        const touched = demand ? c.low <= z.hi : c.high >= z.lo;
        if (!touched) continue;
        const entry = demand ? z.hi : z.lo;
        const target = demand ? entry + o.targetAtr * z.atr : entry - o.targetAtr * z.atr;
        const stop = demand ? z.lo - o.stopAtr * z.atr : z.hi + o.stopAtr * z.atr;
        let result = 'flat', mfe = 0, mae = 0;
        for (let h = j; h < Math.min(candles.length, j + o.horizon); h++) {
            const x = candles[h];
            const favour = demand ? x.high - entry : entry - x.low;
            const adverse = demand ? entry - x.low : x.high - entry;
            mfe = Math.max(mfe, favour); mae = Math.max(mae, adverse);
            const hitStop = demand ? x.low <= stop : x.high >= stop;
            const hitTgt = demand ? x.high >= target : x.low <= target;
            if (hitStop) { result = 'fail'; break; }                          // same-bar stop+target → counted as fail (conservative)
            if (hitTgt) { result = 'bounce'; break; }
        }
        return { idx: j, date: c.date, type: z.type, result, mfeAtr: mfe / z.atr, maeAtr: mae / z.atr };
    }
    return null;
}

function tally(events) {
    const n = events.length;
    const b = events.filter(e => e.result === 'bounce').length, f = events.filter(e => e.result === 'fail').length;
    const avg = k => (n ? events.reduce((a, e) => a + e[k], 0) / n : null);
    const r = x => (x === null ? null : Math.round(x * 100) / 100);
    return { n, bounce: b, fail: f, flat: n - b - f, bouncePct: n ? Math.round(1000 * b / n) / 10 : null, failPct: n ? Math.round(1000 * f / n) / 10 : null, avgMfeAtr: r(avg('mfeAtr')), avgMaeAtr: r(avg('maeAtr')) };
}

function zTest(a, b) { // two-proportion z on bounce rate (real vs placebo)
    if (!a.n || !b.n) return null;
    const p1 = a.bounce / a.n, p2 = b.bounce / b.n, p = (a.bounce + b.bounce) / (a.n + b.n);
    const se = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n));
    return se > 0 ? Math.round(((p1 - p2) / se) * 100) / 100 : null;
}

function runZoneStudy(rawCandles, opt = {}) {
    const candles = rawCandles.map(c => ({ date: c.date, open: num(c.open), high: num(c.high), low: num(c.low), close: num(c.close) }))
        .filter(c => [c.open, c.high, c.low, c.close].every(Number.isFinite));
    const zones = detectZones(candles, opt);
    const real = zones.map(z => evaluateZone(candles, z, opt)).filter(Boolean);
    // placebo: identical zone width/formation, price shifted ±1.0 / ±1.5 ATR (deterministic, no randomness)
    const placebo = [];
    for (const z of zones) for (const sh of [1, 1.5, -1, -1.5]) {
        const d = sh * z.atr;
        const ev = evaluateZone(candles, { ...z, lo: z.lo + d, hi: z.hi + d }, opt);
        if (ev) placebo.push(ev);
    }
    const out = { candles: candles.length, zonesFound: zones.length, real: tally(real), placebo: tally(placebo),
        realDemand: tally(real.filter(e => e.type === 'DEMAND')), realSupply: tally(real.filter(e => e.type === 'SUPPLY')) };
    out.z = zTest(out.real, out.placebo);
    const minN = opt.minN || 30;
    const enough = out.real.n >= minN && out.placebo.n >= minN;
    out.verdict = !enough ? `NOT ENOUGH DATA (need ${minN}+ touched zones and placebo touches)`
        : out.z >= 1.64 ? 'ZONES SHOW AN EDGE over placebo levels (p<0.05, one-sided) — worth showing in the app'
            : out.z <= -1.64 ? 'ZONES DO WORSE than random levels — do not use'
                : 'NO CLEAR EDGE over placebo levels — not worth building into the app';
    out.recent = zones.slice(-5).map(z => ({ type: z.type, lo: Math.round(z.lo), hi: Math.round(z.hi), date: z.date }));
    return out;
}

function formatText(r) {
    const t = (n, x) => `${n}: touched ${x.n} · bounce ${x.bouncePct}% · fail ${x.failPct}% · flat ${x.n ? Math.round(1000 * x.flat / x.n) / 10 : null}% · avg best ${x.avgMfeAtr} ATR / worst ${x.avgMaeAtr} ATR`;
    return ['SUPPLY/DEMAND ZONE STUDY (daily candles, research only)', `${r.candles} candles · ${r.zonesFound} zones found`,
        t('REAL zones   ', r.real), t('  demand       ', r.realDemand), t('  supply       ', r.realSupply), t('PLACEBO levels', r.placebo),
        `z-score (real vs placebo bounce rate): ${r.z}`, `VERDICT: ${r.verdict}`].join('\n');
}

module.exports = { atrAt, detectZones, evaluateZone, runZoneStudy, formatText, tally, zTest };