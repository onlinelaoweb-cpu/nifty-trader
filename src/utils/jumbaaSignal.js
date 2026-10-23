'use strict';
// 23 Oct 2026 - JUMBAA SIGNAL (shadow test, record-only). Prabhash's own manual method turned into one rule:
//   a 15-minute candle CLOSES beyond a key Support/Resistance level (crossing it)
//   + Smart Money bias agrees with the cross direction (BULLISH / STRONGLY_BULLISH for up, BEARISH / STRONGLY_BEARISH for down)
//   + 1h ADX >= 25 (a trend exists)
// -> one signal, CALL side on an up-cross, PUT side on a down-cross. PCR is NOT used (his decision, 23 Oct).
// It never sends Telegram, never touches a live signal, a gate or a broker. It only logs, then forward index moves are measured later.
// Pure state machine: no DB, no clock (caller passes ms). Pre-registered verdict is in evaluateJumbaa().

const BAR_MS = 15 * 60000, IST_MS = 19800000, DAY_MS = 86400000;
const DEFAULTS = { adxMin: 25, cooldownMin: 30, fromMin: 9 * 60 + 30, toMin: 14 * 60 };
const BULL = new Set(['BULLISH', 'STRONGLY_BULLISH']), BEAR = new Set(['BEARISH', 'STRONGLY_BEARISH']);
const fin = v => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)));
const r1 = x => Math.round(x * 10) / 10;

function createJumbaa(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const st = { day: null, bucket: null, last: null, prevClose: null, lastFire: { BULLISH: 0, BEARISH: 0 } };
    const stats = { barsClosed: 0, crosses: 0, blockedBias: 0, blockedAdx: 0, blockedCooldown: 0, blockedWindow: 0, fired: 0 };
    // in: { ms, price, levels:[{price,type,label}], smartBias, adx1h }. Returns null (no cross) or a cross record: fired true/false + blockedBy[].
    function step(inp) {
        const ms = Number(inp && inp.ms), price = Number(inp && inp.price);
        if (!Number.isFinite(ms) || !Number.isFinite(price) || price <= 0) return null;
        const day = Math.floor((ms + IST_MS) / DAY_MS), b = Math.floor((ms + IST_MS) / BAR_MS);
        if (st.day !== day) { st.day = day; st.bucket = b; st.last = price; st.prevClose = null; return null; }
        if (b === st.bucket) { st.last = price; return null; }
        // a new 15-min bar has started: the previous bar's last price is its close
        const close = st.last, prevClose = st.prevClose, gap = b - st.bucket;
        st.prevClose = close; st.bucket = b; st.last = price; stats.barsClosed++;
        if (gap > 1 || prevClose === null) { if (gap > 1) st.prevClose = null; return null; }   // missed ticks -> do not compare across a hole
        const lv = (Array.isArray(inp.levels) ? inp.levels : []).filter(l => l && fin(l.price)).map(l => Object.assign({}, l, { price: Number(l.price) }));
        const dir = close > prevClose ? 'BULLISH' : close < prevClose ? 'BEARISH' : null;
        if (!dir) return null;
        const crossed = lv.filter(l => dir === 'BULLISH' ? (prevClose < l.price && close > l.price) : (prevClose > l.price && close < l.price));
        if (!crossed.length) return null;
        stats.crosses++;
        const istMin = Math.floor(((ms + IST_MS) % DAY_MS) / 60000);
        // Every cross is returned (fired or not) with ALL the reasons it was blocked, so filters can be studied later without re-running history.
        const bias = String(inp.smartBias || '').toUpperCase(), blockedBy = [];
        if (istMin < o.fromMin || istMin > o.toMin) { blockedBy.push('window'); stats.blockedWindow++; }
        if (!(dir === 'BULLISH' ? BULL.has(bias) : BEAR.has(bias))) { blockedBy.push('bias'); stats.blockedBias++; }
        if (!fin(inp.adx1h) || Number(inp.adx1h) < o.adxMin) { blockedBy.push('adx'); stats.blockedAdx++; }
        if (!blockedBy.length && ms - st.lastFire[dir] < o.cooldownMin * 60000) { blockedBy.push('cooldown'); stats.blockedCooldown++; }
        const fired = blockedBy.length === 0;
        if (fired) { st.lastFire[dir] = ms; stats.fired++; }
        const pick = crossed.slice().sort((a, c) => Math.abs(a.price - close) - Math.abs(c.price - close))[0];
        return { fired, blockedBy, ms, direction: dir, side: dir === 'BULLISH' ? 'CALL' : 'PUT', close, prevClose, level: pick.price,
            levelType: pick.type || null, levelLabel: pick.label || pick.name || null, levelsCrossed: crossed.length,
            smartBias: bias, adx1h: fin(inp.adx1h) ? Number(inp.adx1h) : null };
    }
    return { step, stats, state: st, options: o };
}

// rows: [{ ts, direction, nifty, nifty_15, nifty_30, nifty_60 }]  (nifty_X = first snapshot reading X minutes later, or null)
// Pre-registered (23 Oct 2026, before any data): after >= 30 signals with a 60-min reading, average directional index move at 60 min
// must be >= +15 pts (about the cost + spread of an ATM option round trip) AND positive in BOTH time halves. Else NO EVIDENCE.
function evaluateJumbaa(rows, opts) {
    const o = Object.assign({ minN: 30, minPts: 15 }, opts || {});
    const sign = d => (String(d).toUpperCase().startsWith('BULL') ? 1 : -1);
    const items = (Array.isArray(rows) ? rows : []).map(r => {
        const n0 = Number(r.nifty), s = sign(r.direction), mv = k => (fin(r['nifty_' + k]) && Number.isFinite(n0)) ? (Number(r['nifty_' + k]) - n0) * s : null;
        return { ts: new Date(r.ts).getTime(), direction: String(r.direction).toUpperCase(), m15: mv(15), m30: mv(30), m60: mv(60) };
    }).filter(x => Number.isFinite(x.ts)).sort((a, b) => a.ts - b.ts);
    const avg = a => a.length ? r1(a.reduce((s, x) => s + x, 0) / a.length) : null;
    const col = (list, k) => list.map(x => x[k]).filter(v => v !== null);
    const stat = list => ({ n: list.length, avg15: avg(col(list, 'm15')), avg30: avg(col(list, 'm30')), avg60: avg(col(list, 'm60')), n60: col(list, 'm60').length,
        hit60Pct: col(list, 'm60').length ? Math.round(100 * col(list, 'm60').filter(v => v > 0).length / col(list, 'm60').length) : null });
    const res60 = items.filter(x => x.m60 !== null), mid = Math.floor(res60.length / 2);
    const h1 = stat(res60.slice(0, mid)), h2 = stat(res60.slice(mid)), all = stat(items);
    let verdict;
    if (all.n60 < o.minN) verdict = `TOO FEW - ${all.n60} of ${o.minN} signals have a 60-min reading. No conclusion.`;
    else if (all.avg60 >= o.minPts && h1.avg60 > 0 && h2.avg60 > 0) verdict = `PASSES the pre-registered bar (avg 60-min move ${all.avg60} pts >= ${o.minPts}, positive in both halves). Still index points, not option P&L - paper-test next.`;
    else verdict = `NO EVIDENCE - avg 60-min move ${all.avg60} pts (need >= ${o.minPts}) or halves disagree (${h1.avg60} / ${h2.avg60}).`;
    return { all, calls: stat(items.filter(x => x.direction === 'BULLISH')), puts: stat(items.filter(x => x.direction === 'BEARISH')), half1: h1, half2: h2, minN: o.minN, minPts: o.minPts, verdict };
}


// ── JUMBAA-B (23 Oct) - the SAME rule, but the cross is caught LIVE (tick by tick) the moment price clears a level by bufferPts,
// instead of waiting for the 15-minute candle to close (variant A). Reason: Prabhash trades the first seconds after a level breaks, and
// 23 Oct data showed candle-close entries (A) were late (10 crosses, only 1 still ahead 15 min later). Record-only, same filters as A.
// A cross is counted when the confirmed side of a level flips (above = price >= level + buffer, below = price <= level - buffer;
// inside the buffer the previous side is kept, so a wick that does not clear the buffer is not a cross).
const LIVE_DEFAULTS = { bufferPts: 3, adxMin: 25, cooldownMin: 30, refractoryMin: 5, fromMin: 9 * 60 + 30, toMin: 14 * 60, gapResetMs: 3 * 60000, nearPts: 150, maxPerDay: 60 };
function createJumbaaLive(opts) {
    const o = Object.assign({}, LIVE_DEFAULTS, opts || {});
    const st = { day: null, lastMs: 0, sides: new Map(), lastCross: new Map(), lastFire: { BULLISH: 0, BEARISH: 0 }, today: 0 };
    const stats = { ticks: 0, crosses: 0, suppressed: 0, blockedBias: 0, blockedAdx: 0, blockedCooldown: 0, blockedWindow: 0, fired: 0, capped: 0 };
    function step(inp) {
        const ms = Number(inp && inp.ms), price = Number(inp && inp.price);
        if (!Number.isFinite(ms) || !Number.isFinite(price) || price <= 0) return [];
        const day = Math.floor((ms + IST_MS) / DAY_MS);
        const lv = (Array.isArray(inp.levels) ? inp.levels : []).filter(l => l && fin(l.price) && Math.abs(Number(l.price) - price) <= o.nearPts).map(l => Object.assign({}, l, { price: Number(l.price) }));
        const reset = st.day !== day || (st.lastMs && ms - st.lastMs > o.gapResetMs);
        if (st.day !== day) { st.day = day; st.today = 0; st.lastCross.clear(); }
        st.lastMs = ms; stats.ticks++;
        if (reset) st.sides.clear();
        const out = [];
        for (const l of lv) {
            const key = String(Math.round(l.price * 100));
            const ns = price >= l.price + o.bufferPts ? 'U' : price <= l.price - o.bufferPts ? 'D' : null;
            if (!ns) continue;
            const prev = st.sides.get(key);
            st.sides.set(key, ns);
            if (!prev || prev === ns || reset) continue;
            const dir = ns === 'U' ? 'BULLISH' : 'BEARISH', ck = key + dir;
            if (st.lastCross.has(ck) && ms - st.lastCross.get(ck) < o.refractoryMin * 60000) { stats.suppressed++; continue; }
            st.lastCross.set(ck, ms); stats.crosses++;
            if (st.today >= o.maxPerDay) { stats.capped++; continue; }
            st.today++;
            const istMin = Math.floor(((ms + IST_MS) % DAY_MS) / 60000), bias = String(inp.smartBias || '').toUpperCase(), blockedBy = [];
            if (istMin < o.fromMin || istMin > o.toMin) { blockedBy.push('window'); stats.blockedWindow++; }
            if (!(dir === 'BULLISH' ? BULL.has(bias) : BEAR.has(bias))) { blockedBy.push('bias'); stats.blockedBias++; }
            if (!fin(inp.adx1h) || Number(inp.adx1h) < o.adxMin) { blockedBy.push('adx'); stats.blockedAdx++; }
            if (!blockedBy.length && ms - st.lastFire[dir] < o.cooldownMin * 60000) { blockedBy.push('cooldown'); stats.blockedCooldown++; }
            const fired = blockedBy.length === 0;
            if (fired) { st.lastFire[dir] = ms; stats.fired++; }
            out.push({ fired, blockedBy, ms, direction: dir, side: dir === 'BULLISH' ? 'CALL' : 'PUT', price, level: l.price, levelType: l.type || null,
                levelLabel: l.label || l.name || null, smartBias: bias, adx1h: fin(inp.adx1h) ? Number(inp.adx1h) : null });
        }
        return out;
    }
    return { step, stats, state: st, options: o };
}

// rows: [{ direction, nifty (entry), px_1m, px_5m, px_15m, px_30m, ts }] - px_X = Nifty X minutes after the cross (null if not recorded yet).
// Pre-registered (23 Oct 2026, before any data): >= 30 fired crosses with a 15-min reading, average 15-min move >= +10 pts AND average 30-min
// move >= +10 pts AND the 15-min average positive in both time halves. Else NO EVIDENCE. A and B are read side by side, not merged.
function evaluateLive(rows, opts) {
    const o = Object.assign({ minN: 30, minPts: 10 }, opts || {});
    const avg = a => a.length ? r1(a.reduce((s, x) => s + x, 0) / a.length) : null;
    const items = (Array.isArray(rows) ? rows : []).map(r => {
        const e = Number(r.nifty), s = String(r.direction).toUpperCase().startsWith('BULL') ? 1 : -1, mv = k => (fin(r['px_' + k + 'm']) && Number.isFinite(e)) ? (Number(r['px_' + k + 'm']) - e) * s : null;
        return { ts: new Date(r.ts).getTime(), m1: mv(1), m5: mv(5), m15: mv(15), m30: mv(30) };
    }).filter(x => Number.isFinite(x.ts)).sort((a, b) => a.ts - b.ts);
    const col = (l, k) => l.map(x => x[k]).filter(v => v !== null);
    const stat = l => ({ n: l.length, avg1: avg(col(l, 'm1')), avg5: avg(col(l, 'm5')), avg15: avg(col(l, 'm15')), avg30: avg(col(l, 'm30')), n15: col(l, 'm15').length,
        hit15Pct: col(l, 'm15').length ? Math.round(100 * col(l, 'm15').filter(v => v > 0).length / col(l, 'm15').length) : null });
    const r15 = items.filter(x => x.m15 !== null), mid = Math.floor(r15.length / 2), all = stat(items), h1 = stat(r15.slice(0, mid)), h2 = stat(r15.slice(mid));
    let verdict;
    if (all.n15 < o.minN) verdict = `TOO FEW - ${all.n15} of ${o.minN} crosses have a 15-min reading. No conclusion.`;
    else if (all.avg15 >= o.minPts && all.avg30 !== null && all.avg30 >= o.minPts && h1.avg15 > 0 && h2.avg15 > 0) verdict = `PASSES the pre-registered bar (avg 15m ${all.avg15}, 30m ${all.avg30} pts >= ${o.minPts}, positive in both halves). Index points, not option P&L - paper-test next.`;
    else verdict = `NO EVIDENCE - avg 15m ${all.avg15}, 30m ${all.avg30} pts (need >= ${o.minPts} both) or halves disagree (${h1.avg15} / ${h2.avg15}).`;
    return { all, half1: h1, half2: h2, minN: o.minN, minPts: o.minPts, verdict };
}

// rows: fired crosses with { direction, breadth_sig }. agree = BEARISH breadth with a PUT-side (BEARISH) cross or BULLISH breadth with a CALL-side (BULLISH)
// cross; against = the opposite; neutral = breadth NEUTRAL or unknown. Prabhash's 24 Oct observation: bearish breadth -> put bias, bullish -> call bias.
function splitByBreadth(rows) {
    const out = { agree: [], against: [], neutral: [] };
    for (const r of Array.isArray(rows) ? rows : []) {
        const b = String(r && r.breadth_sig || '').toUpperCase(), d = String(r && r.direction || '').toUpperCase();
        if ((b !== 'BULLISH' && b !== 'BEARISH') || !d) out.neutral.push(r);
        else if (b === d) out.agree.push(r); else out.against.push(r);
    }
    return out;
}

module.exports = { splitByBreadth, createJumbaa, evaluateJumbaa, createJumbaaLive, evaluateLive, DEFAULTS, LIVE_DEFAULTS };