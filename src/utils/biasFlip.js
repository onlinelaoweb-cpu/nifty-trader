'use strict';
// biasFlip.js — "Bias Flip Watch" (30 Oct 2026). DISPLAY ONLY: nothing here feeds signals, gates, alerts or journals.
//
// Reads a handful of things the app already computes, turns each into  +1 (bullish) / -1 (bearish) / 0,
// adds them into one score, and tells the trader WHEN the market's bias switched (e.g. put bias -> bullish).
//
//   EARLY factors  (move first, noisier):  orderFlow, pcr, oiFlow, earlyMom, vwap
//   CONFIRM factors (arrive later, firmer): mtfLead, brahmastra, structure, engine
//
// Bias is held with hysteresis so it does not flicker:  enter BULL/BEAR at |score| >= 3, leave only when it
// falls back inside +-1, and a change must be seen on two evaluations in a row.
// "early" warning: while bias is X, two or more EARLY factors already point the other way.

const ENTER = 3, EXIT = 1, DEBOUNCE = 2;
const FLASH_FLIP_MS = 5 * 60 * 1000, FLASH_TURN_MS = 3 * 60 * 1000;
const BRAH_FRESH_MS = 60 * 60 * 1000;
const MAX_EVENTS = 20;

const FACTOR_DEFS = [
    { key: 'orderFlow',  group: 'early',   label: 'Order Flow' },
    { key: 'pcr',        group: 'early',   label: 'PCR trend' },
    { key: 'oiFlow',     group: 'early',   label: 'OI buildup' },
    { key: 'earlyMom',   group: 'early',   label: 'Early Momentum' },
    { key: 'vwap',       group: 'early',   label: 'VWAP' },
    { key: 'mtfLead',    group: 'confirm', label: 'MTF lead' },
    { key: 'brahmastra', group: 'confirm', label: 'Brahmastra' },
    { key: 'structure',  group: 'confirm', label: 'Structure (BOS/CHOCH)' },
    { key: 'engine',     group: 'confirm', label: 'Main engine' },
];

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const str = v => (typeof v === 'string' ? v.toUpperCase() : '');
function sideFromText(t) {
    const u = str(t);
    if (!u) return 0;
    if (/BULL|CALL/.test(u) && !/BEAR|PUT/.test(u)) return 1;
    if (/BEAR|PUT/.test(u) && !/BULL|CALL/.test(u)) return -1;
    return 0;
}
const sideWord = s => s > 0 ? 'bullish' : s < 0 ? 'bearish' : 'neutral';

// inputs: { nifty, vwap, pcrTrend, earlyMomSignal, oiSignal, mtfSignal, engineSignal, bosEvent,
//           brahmastra:{direction, atMs}, orderFlowBars:[{label, delta, vol, partial}] }
function readFactors(inp, nowMs) {
    const out = {};

    // Order Flow: last two COMPLETED 15-min bars must agree and net at least 10K (approx delta, see Order Flow card)
    const bars = Array.isArray(inp.orderFlowBars) ? inp.orderFlowBars.filter(b => b && !b.partial && num(b.delta) !== null) : [];
    if (bars.length >= 2) {
        const a = Number(bars[bars.length - 1].delta), b = Number(bars[bars.length - 2].delta);
        const net = a + b;
        if (a > 0 && b > 0 && net >= 10000) out.orderFlow = { side: 1, note: `last 2 bars buyers +${Math.round(net / 1000)}K` };
        else if (a < 0 && b < 0 && net <= -10000) out.orderFlow = { side: -1, note: `last 2 bars sellers ${Math.round(net / 1000)}K` };
        else out.orderFlow = { side: 0, note: 'bars mixed / chhote' };
    } else out.orderFlow = { side: 0, note: 'bars abhi kam' };

    const pt = str(inp.pcrTrend);
    out.pcr = pt === 'RISING' ? { side: 1, note: 'PCR upar chadh raha' }
            : pt === 'FALLING' ? { side: -1, note: 'PCR neeche gir raha' } : { side: 0, note: 'PCR flat' };

    const oi = sideFromText(inp.oiSignal);
    out.oiFlow = { side: oi, note: oi > 0 ? 'put writing / call unwinding' : oi < 0 ? 'call writing / put unwinding' : 'OI shaant' };

    const em = sideFromText(inp.earlyMomSignal);
    out.earlyMom = { side: em, note: em ? `radar ${sideWord(em)}` : 'radar neutral' };

    const nifty = num(inp.nifty), vwap = num(inp.vwap);
    if (nifty !== null && vwap !== null && vwap > 0) {
        const d = (nifty - vwap) / vwap;
        out.vwap = d > 0.0003 ? { side: 1, note: 'spot VWAP ke upar' } : d < -0.0003 ? { side: -1, note: 'spot VWAP ke neeche' } : { side: 0, note: 'VWAP ke paas' };
    } else out.vwap = { side: 0, note: 'VWAP nahi' };

    const m = sideFromText(inp.mtfSignal);
    out.mtfLead = { side: m, note: m ? `MTF ${m > 0 ? 'BUY CALL' : 'BUY PUT'}` : 'MTF wait' };

    const br = inp.brahmastra;
    if (br && br.direction && num(br.atMs) !== null && nowMs - Number(br.atMs) <= BRAH_FRESH_MS) {
        const s = sideFromText(br.direction);
        const ago = Math.max(0, Math.round((nowMs - Number(br.atMs)) / 60000));
        out.brahmastra = { side: s, note: `${sideWord(s)} alert ${ago} min pehle` };
    } else out.brahmastra = { side: 0, note: 'koi taaza alert nahi' };

    const st = sideFromText(inp.bosEvent);
    out.structure = { side: st, note: st ? String(inp.bosEvent).replace('_', ' ').toLowerCase() : 'structure break nahi' };

    const en = sideFromText(inp.engineSignal);
    out.engine = { side: en, note: en ? `engine ${en > 0 ? 'BUY CALL' : 'BUY PUT'}` : 'engine WAIT' };

    return out;
}

function createBiasTracker() {
    let day = '';
    let bias = 'NEUTRAL', biasSince = null, pending = null, pendingN = 0;
    let events = [], flash = null, seq = 0;
    let fstate = {};   // key -> { side, since }

    function reset() { bias = 'NEUTRAL'; biasSince = null; pending = null; pendingN = 0; events = []; flash = null; fstate = {}; }

    function targetBias(score) {
        if (bias === 'BULL' && score >= EXIT) return 'BULL';
        if (bias === 'BEAR' && score <= -EXIT) return 'BEAR';
        if (score >= ENTER) return 'BULL';
        if (score <= -ENTER) return 'BEAR';
        return 'NEUTRAL';
    }

    // inp as in readFactors + { dayKey:'2026-10-30', live:boolean }
    function update(inp, nowMs = Date.now()) {
        const dayKey = inp.dayKey || '';
        if (dayKey && dayKey !== day) { day = dayKey; reset(); }
        const f = readFactors(inp, nowMs);

        const list = FACTOR_DEFS.map(d => {
            const cur = f[d.key] || { side: 0, note: '' };
            const prev = fstate[d.key];
            if (!prev || prev.side !== cur.side) fstate[d.key] = { side: cur.side, since: nowMs };
            return { key: d.key, group: d.group, label: d.label, side: cur.side, note: cur.note, sinceMs: fstate[d.key].since };
        });
        const score = list.reduce((a, x) => a + x.side, 0);

        if (inp.live !== false) {
            const target = targetBias(score);
            if (target === bias) { pending = null; pendingN = 0; }
            else {
                if (pending === target) pendingN++; else { pending = target; pendingN = 1; }
                if (pendingN >= DEBOUNCE) {
                    const from = bias;
                    const kind = (from === 'BULL' && target === 'BEAR') || (from === 'BEAR' && target === 'BULL') ? 'FLIP'
                               : target === 'NEUTRAL' ? 'FADE' : 'TURN';
                    bias = target; biasSince = nowMs; pending = null; pendingN = 0;
                    const ev = { id: ++seq, atMs: nowMs, from, to: target, kind, score,
                        why: (target === 'NEUTRAL' ? [] : list.filter(x => x.side === (target === 'BULL' ? 1 : -1)).map(x => x.label)) };
                    events.unshift(ev); if (events.length > MAX_EVENTS) events.pop();
                    if (target !== 'NEUTRAL') flash = { side: target, kind, level: 'flip', untilMs: nowMs + (kind === 'FLIP' ? FLASH_FLIP_MS : FLASH_TURN_MS), eventId: ev.id };
                    else flash = null;
                }
            }
        }

        // early warning: bias still X (or neutral) but 2+ EARLY factors already lean the other way
        let early = null;
        if (inp.live !== false) {
            const ea = list.filter(x => x.group === 'early');
            const bull = ea.filter(x => x.side > 0), bear = ea.filter(x => x.side < 0);
            if (bias !== 'BULL' && bull.length >= 2 && bull.length > bear.length) early = { toward: 'BULL', count: bull.length, labels: bull.map(x => x.label) };
            else if (bias !== 'BEAR' && bear.length >= 2 && bear.length > bull.length) early = { toward: 'BEAR', count: bear.length, labels: bear.map(x => x.label) };
        }

        if (flash && nowMs >= flash.untilMs) flash = null;
        let show = null;
        if (flash) show = { side: flash.side, level: 'flip', kind: flash.kind, untilMs: flash.untilMs, eventId: flash.eventId };
        else if (early) show = { side: early.toward, level: 'early', kind: 'EARLY', untilMs: null, eventId: null };

        return {
            live: inp.live !== false, day, bias, biasSince, score, factors: list, early, flash: show,
            events: events.slice(0, 8), serverNowMs: nowMs,
        };
    }
    return { update };
}

module.exports = { readFactors, createBiasTracker, FACTOR_DEFS, ENTER, EXIT, DEBOUNCE };