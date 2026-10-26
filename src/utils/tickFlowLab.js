'use strict';
// ── Tick-flow LAB (17 Oct 2026) ──────────────────────────────────────────────────────────────────────────────────────────
// PURPOSE: ONE feasibility question - can the FREE Angel One feed (already used by the app) give enough trade-level detail on the
// NIFTY FUTURES to build an approximate footprint (buy/sell volume per bar) that is close to a real footprint such as Dhan DEXT T3?
// It is a RECORD-ONLY diagnostic. It never touches signals, gates, alerts, the Auto Journal or any live rule, and it costs nothing.
//
// HOW: a SECOND Angel WebSocket connection (Angel allows 3 per client code; the app's own connection stays untouched) subscribes ONE token -
// the nearest NIFTY futures contract - in SnapQuote mode (mode 3 = last traded qty, cumulative volume, best-5 bid/ask, OI).
// Every packet is classified two ways (both standard and simple, decided in advance, no tuning):
//   TICK RULE  : price up vs previous packet = buy, down = sell, unchanged = same side as the last move.
//   QUOTE RULE : trade at/above the PREVIOUS packet's best ask = buy, at/below the previous best bid = sell, otherwise the tick rule.
// Trade size = increase of cumulative volume between packets. Per-minute rows go to Postgres (tickflow_lab_min); 15-minute bars are built on read.
//
// WHAT THE LAB MUST ANSWER (the report prints the numbers; it does not decide anything):
//   1. COVERAGE  = sum(last traded qty) / sum(volume increase). Near 100% and several packets/second = every trade is seen = footprint feasible.
//                  Low coverage (many trades hidden inside one packet) = the feed is snapshots; the result can only be a rough trend proxy.
//   2. LAYOUT    : the byte layout below is from the Angel docs as remembered - the report shows sanity counters + raw samples so a wrong layout is obvious.
//   3. ACCURACY  : compare the 15-min delta columns with DEXT T3 (NIFTY futures, 15m) for the same day - by eye, descriptive only.
// RULES: no trading rule or gate may use this until it has been compared with DEXT over several days AND pre-registered separately.
//
// SnapQuote packet (little-endian), 379 bytes:
//   0 mode | 1 exchange type | 2-26 token (25B text) | 27 seq i64 | 35 exchange ts i64 | 43 LTP u32 (paise) | 51 last traded qty i64 | 59 avg price i64 |
//   67 volume i64 | 75 total buy qty f64 | 83 total sell qty f64 | 91 open | 99 high | 107 low | 115 close (i64 paise) |
//   123 last trade ts i64 | 131 open interest i64 | 139 OI change % f64 | 147..346 best-5: 10 x { flag i16 (1=buy,0=sell), qty i64, price i64 paise, orders i16 }.
// (OHLC offsets 91..115 were already verified live by the app's own parser; the rest is checked by the sanity counters.)

const IST_MS = 330 * 60000;
// 17 Oct: since 3 Aug 2026 NSE index derivatives trade until 15:40 (cash has a closing auction 15:15-15:35), so the lab now records until 15:42 and has a 26th bar (15:30-15:45)
const SESSION_START_MIN = 9 * 60 + 14, SESSION_END_MIN = 15 * 60 + 42, BAR_START_MIN = 9 * 60 + 15, BAR_MIN = 15, N_BARS = 26;
const SCRIP_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const WS_URL = 'wss://smartapisocket.angelone.in/smart-stream';
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const fin = v => Number.isFinite(v) ? v : null;
const r1 = v => v === null || v === undefined ? null : Math.round(v * 10) / 10;
const r2 = v => v === null || v === undefined ? null : Math.round(v * 100) / 100;

function istParts(ms) {
    const d = new Date(ms + IST_MS);
    return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}
const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

// ── packet parser (pure) ─────────────────────────────────────────────────────────────────────────────────────────────────
function parseSnapQuote(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 123) return null;
    const mode = buf.readUInt8(0);
    if (mode !== 2 && mode !== 3) return null;
    const big = o => Number(buf.readBigInt64LE(o));
    const t = {
        mode, len: buf.length, exch: buf.readUInt8(1), token: buf.toString('utf8', 2, 27).replace(/\0+$/, ''),
        seq: big(27), exchTs: big(35), ltp: buf.readUInt32LE(43) / 100, ltq: big(51), atp: big(59) / 100, volume: big(67),
        totBuy: fin(buf.readDoubleLE(75)), totSell: fin(buf.readDoubleLE(83)),
        open: big(91) / 100, high: big(99) / 100, low: big(107) / 100, close: big(115) / 100,
        oi: null, bid: null, ask: null, bidQty: null, askQty: null
    };
    if (mode === 3 && buf.length >= 347) {
        t.oi = big(131);
        for (let i = 0; i < 10; i++) {
            const off = 147 + i * 20, flag = buf.readInt16LE(off), qty = big(off + 2), price = big(off + 10) / 100;
            if (!(qty > 0) || !(price > 0)) continue;
            if (flag === 1) { if (t.bid === null || price > t.bid) { t.bid = price; t.bidQty = qty; } }
            else if (flag === 0) { if (t.ask === null || price < t.ask) { t.ask = price; t.askQty = qty; } }
        }
    }
    return t;
}

// ── classifier (pure, stateful object) ───────────────────────────────────────────────────────────────────────────────────
function createFlow() { return { vol: null, ltp: null, dir: 0, bid: null, ask: null }; }
// returns { dv, tickDir, quoteDir, byQuote, volDrop }; dv = trade size since the previous packet (0 when nothing traded)
function flowStep(f, t) {
    const out = { dv: 0, tickDir: 0, quoteDir: 0, byQuote: false, volDrop: false };
    const move = f.ltp === null ? 0 : Math.sign(t.ltp - f.ltp);
    if (f.vol !== null && t.volume < f.vol) out.volDrop = true;
    else if (f.vol !== null && t.volume > f.vol) {
        out.dv = t.volume - f.vol;
        out.tickDir = move || f.dir;
        if (f.ask > 0 && t.ltp >= f.ask) { out.quoteDir = 1; out.byQuote = true; }
        else if (f.bid > 0 && t.ltp <= f.bid) { out.quoteDir = -1; out.byQuote = true; }
        else out.quoteDir = out.tickDir;
    }
    if (move) f.dir = move;
    f.vol = t.volume; f.ltp = t.ltp;
    if (t.bid > 0 && t.ask > 0) { f.bid = t.bid; f.ask = t.ask; }
    return out;
}

// ── minute bucket (pure) ─────────────────────────────────────────────────────────────────────────────────────────────────
function newBucket(ts) {
    return { ts, ticks: 0, events: 0, vol: 0, ltqSum: 0, exactN: 0, multiN: 0, oddN: 0, buyTick: 0, sellTick: 0, unTick: 0, buyQ: 0, sellQ: 0, unQ: 0, qByQuote: 0,
        o: null, h: null, l: null, c: null, spreadSum: 0, spreadN: 0, totBuy: null, totSell: null };
}
function addToBucket(b, t, s) {
    b.ticks++;
    if (t.ltp > 0) { if (b.o === null) b.o = t.ltp; b.h = b.h === null ? t.ltp : Math.max(b.h, t.ltp); b.l = b.l === null ? t.ltp : Math.min(b.l, t.ltp); b.c = t.ltp; }
    if (t.bid > 0 && t.ask >= t.bid) { b.spreadSum += t.ask - t.bid; b.spreadN++; }
    if (t.totBuy !== null) b.totBuy = t.totBuy;
    if (t.totSell !== null) b.totSell = t.totSell;
    if (s.dv > 0) {
        const ltq = Number(t.ltq) || 0;
        b.events++; b.vol += s.dv; b.ltqSum += Math.min(Math.max(ltq, 0), s.dv);
        if (ltq === s.dv) b.exactN++; else if (s.dv > ltq) b.multiN++; else b.oddN++;
        if (s.tickDir > 0) b.buyTick += s.dv; else if (s.tickDir < 0) b.sellTick += s.dv; else b.unTick += s.dv;
        if (s.quoteDir > 0) b.buyQ += s.dv; else if (s.quoteDir < 0) b.sellQ += s.dv; else b.unQ += s.dv;
        if (s.byQuote) b.qByQuote += s.dv;
    }
}

// ── nearest NIFTY futures token from the Angel ScripMaster TEXT (no JSON.parse of the whole file -> small memory) ────────
function findNiftyFutToken(text, nowMs) {
    if (typeof text !== 'string') return null;
    const today = istParts(nowMs).day.split('-').map(Number);
    const todayMs = Date.UTC(today[0], today[1] - 1, today[2]);
    const re = /"instrumenttype"\s*:\s*"FUTIDX"/g;
    let m, best = null;
    while ((m = re.exec(text)) !== null) {
        const a = text.lastIndexOf('{', m.index), b = text.indexOf('}', m.index);
        if (a < 0 || b < 0) continue;
        let o; try { o = JSON.parse(text.slice(a, b + 1)); } catch (e) { continue; }
        if (!o || o.name !== 'NIFTY' || o.exch_seg !== 'NFO' || !o.token || !o.expiry) continue;
        const p = String(o.expiry).match(/^(\d{2})([A-Za-z]{3})(\d{4})$/);
        if (!p || MONTHS[p[2].toUpperCase()] === undefined) continue;
        const exp = Date.UTC(Number(p[3]), MONTHS[p[2].toUpperCase()], Number(p[1]));
        if (exp < todayMs) continue;
        if (!best || exp < best.expMs) best = { token: String(o.token), symbol: o.symbol, expiry: o.expiry, expMs: exp };
    }
    return best;
}

// ── report (pure) ────────────────────────────────────────────────────────────────────────────────────────────────────────
// rows: minute rows (camelCase, numbers). Returns 15-minute bars + totals.
function buildDayReport(rows, day) {
    const bars = Array.from({ length: N_BARS }, (_, i) => ({ label: hhmm(BAR_START_MIN + i * BAR_MIN), minutes: 0, ticks: 0, events: 0, vol: 0, ltqSum: 0, buyTick: 0, sellTick: 0, buyQ: 0, sellQ: 0, unTick: 0, unQ: 0, qByQuote: 0,
        open: null, high: null, low: null, close: null, spreadSum: 0, spreadN: 0 }));
    let outside = 0;
    const sorted = [...(rows || [])].sort((x, y) => x.ts - y.ts);
    for (const r of sorted) {
        const m = istParts(r.ts).min, idx = Math.floor((m - BAR_START_MIN) / BAR_MIN);
        if (idx < 0 || idx >= N_BARS) { outside++; continue; }
        const b = bars[idx];
        b.minutes++; b.ticks += r.ticks; b.events += r.events; b.vol += r.vol; b.ltqSum += r.ltqSum;
        b.buyTick += r.buyTick; b.sellTick += r.sellTick; b.unTick += r.unTick; b.buyQ += r.buyQ; b.sellQ += r.sellQ; b.unQ += r.unQ; b.qByQuote += r.qByQuote;
        b.spreadSum += r.spreadSum; b.spreadN += r.spreadN;
        if (r.o !== null) { if (b.open === null) b.open = r.o; b.close = r.c; b.high = b.high === null ? r.h : Math.max(b.high, r.h); b.low = b.low === null ? r.l : Math.min(b.low, r.l); }
    }
    let cT = 0, cQ = 0;
    const out = bars.filter(b => b.minutes > 0).map(b => {
        const dT = b.buyTick - b.sellTick, dQ = b.buyQ - b.sellQ; cT += dT; cQ += dQ;
        return { label: b.label, minutes: b.minutes, ticks: b.ticks, ticksPerSec: r1(b.ticks / (b.minutes * 60)), events: b.events, vol: b.vol,
            coveragePct: b.vol > 0 ? r1(b.ltqSum / b.vol * 100) : null, deltaTick: dT, deltaQuote: dQ, buyQuote: b.buyQ, sellQuote: b.sellQ, cumTick: cT, cumQuote: cQ,
            quoteSharePct: b.vol > 0 ? r1(b.qByQuote / b.vol * 100) : null, unclassPct: b.vol > 0 ? r1(b.unQ / b.vol * 100) : null,
            open: b.open, close: b.close, chg: b.open !== null ? r2(b.close - b.open) : null, avgSpread: b.spreadN ? r2(b.spreadSum / b.spreadN) : null };
    });
    const T = bars.reduce((a, b) => ({ minutes: a.minutes + b.minutes, ticks: a.ticks + b.ticks, events: a.events + b.events, vol: a.vol + b.vol, ltq: a.ltq + b.ltqSum }), { minutes: 0, ticks: 0, events: 0, vol: 0, ltq: 0 });
    return { day, bars: out, outsideSessionMinutes: outside,
        totals: { minutes: T.minutes, ticks: T.ticks, events: T.events, vol: T.vol, ticksPerSec: T.minutes ? r1(T.ticks / (T.minutes * 60)) : null,
            coveragePct: T.vol > 0 ? r1(T.ltq / T.vol * 100) : null, cumTick: cT, cumQuote: cQ } };
}

function formatLabText(rep, stats, raws, meta = {}) {
    const L = [];
    L.push(`TICK-FLOW LAB (record-only, free Angel feed) - IST day ${rep.day}${meta.symbol ? ' - ' + meta.symbol : ''}`);
    L.push('NOT a footprint, NOT a signal. Compare the delta columns with DEXT T3 (NIFTY futures 15m) by eye. No rule may use this yet.');
    const t = rep.totals;
    L.push(`TOTAL: ${t.minutes} minutes with data | ${t.ticks} packets (${t.ticksPerSec}/s) | ${t.events} trade events | volume ${t.vol} | coverage ${t.coveragePct}% | day-end cum delta: tick-rule ${t.cumTick}, quote-rule ${t.cumQuote}`);
    L.push('READ: coverage near 100% and several packets/s = every trade is seen (footprint feasible). Coverage far below ~60% = snapshot feed (rough proxy only).');
    L.push('');
    L.push('bar   | min | pkt/s | events | volume   | cover% | d(tick) | d(quote) | cum(tick) | cum(quote) | quote% | unclass% | open->close (chg) | spread');
    for (const b of rep.bars) {
        L.push(`${b.label} | ${String(b.minutes).padStart(3)} | ${String(b.ticksPerSec).padStart(5)} | ${String(b.events).padStart(6)} | ${String(b.vol).padStart(8)} | ${String(b.coveragePct).padStart(6)} | ${String(b.deltaTick).padStart(7)} | ${String(b.deltaQuote).padStart(8)} | ${String(b.cumTick).padStart(9)} | ${String(b.cumQuote).padStart(10)} | ${String(b.quoteSharePct).padStart(6)} | ${String(b.unclassPct).padStart(8)} | ${b.open}->${b.close} (${b.chg}) | ${b.avgSpread}`);
    }
    L.push('');
    if (rep.outsideSessionMinutes) L.push(`minutes outside 09:15-15:30 (ignored): ${rep.outsideSessionMinutes}`);
    if (stats) {
        L.push('SANITY COUNTERS (layout check - all should be ~0 except packets/parsedOk):');
        L.push(JSON.stringify(stats));
    }
    if (raws && raws.length) {
        L.push('', `RAW SAMPLES (${raws.length}, newest last) - to verify the byte layout:`);
        for (const r of raws) L.push(`${r.label} len=${r.len} parsed=${JSON.stringify(r.parsed)}\n  hex=${String(r.hex).slice(0, 160)}...`);
    }
    return L.join('\n');
}

// ── the lab (runtime) ────────────────────────────────────────────────────────────────────────────────────────────────────
function createTickFlowLab({ dbPool, now = Date.now, log = () => {}, env = process.env, wsFactory = null, fetchScrip = null, bootDelayMs = 90000, onAuthFail = null }) {
    const cfg = { enabled: ['true', 'on', '1', 'yes'].includes(String(env.TICKFLOW_LAB || '').toLowerCase()), tokenOverride: env.TICKFLOW_FUT_TOKEN || null, bootDelayMs };
    const freshStats = () => ({ connects: 0, closes: 0, packets: 0, parsedOk: 0, smallMsgs: 0, unparsed: 0, badLen: 0, otherMode: 0, wrongToken: 0, ltpOutOfRange: 0, volDrop: 0, crossedBook: 0, ltqZeroOnTrade: 0, exchTsSample: null });
    const S = { started: false, bootAt: now(), timers: [], auth: null, ws: null, connecting: false, fut: null, futDay: null, flow: createFlow(), bucket: null, day: null,
        stats: freshStats(), rawCount: 0, rawQueue: [], lastPacketAt: 0, connectedAt: 0, notBefore: 0, auth401: false, lastAuthFixAt: 0, backoffMs: 5000, failures: 0, heartbeat: null, saving: false, pending: [], today: [] };
    const L = { rows: [], day: null, at: 0, loading: false };   // DB minutes of today, read now and then (never per tick)

    async function ensureTables() {
        await dbPool.query(`CREATE TABLE IF NOT EXISTS tickflow_lab_min (ts TIMESTAMPTZ PRIMARY KEY, sym TEXT, ticks INT, events INT, vol BIGINT, ltq_sum BIGINT, exact_n INT, multi_n INT, odd_n INT,
            buy_tick BIGINT, sell_tick BIGINT, un_tick BIGINT, buy_q BIGINT, sell_q BIGINT, un_q BIGINT, q_by_quote BIGINT, o NUMERIC, h NUMERIC, l NUMERIC, c NUMERIC, spread_sum NUMERIC, spread_n INT, tot_buy NUMERIC, tot_sell NUMERIC)`);
        await dbPool.query(`CREATE TABLE IF NOT EXISTS tickflow_lab_day (day TEXT PRIMARY KEY, sym TEXT, stats JSONB, updated TIMESTAMPTZ DEFAULT NOW())`);
        await dbPool.query(`CREATE TABLE IF NOT EXISTS tickflow_lab_raw (id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT NOW(), day TEXT, label TEXT, len INT, hex TEXT, parsed JSONB)`);
    }
    async function saveBucket(b) {
        if (!b || !b.ticks) return;
        await dbPool.query(`INSERT INTO tickflow_lab_min (ts, sym, ticks, events, vol, ltq_sum, exact_n, multi_n, odd_n, buy_tick, sell_tick, un_tick, buy_q, sell_q, un_q, q_by_quote, o, h, l, c, spread_sum, spread_n, tot_buy, tot_sell)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
            ON CONFLICT (ts) DO UPDATE SET sym=$2, ticks=$3, events=$4, vol=$5, ltq_sum=$6, exact_n=$7, multi_n=$8, odd_n=$9, buy_tick=$10, sell_tick=$11, un_tick=$12, buy_q=$13, sell_q=$14, un_q=$15, q_by_quote=$16, o=$17, h=$18, l=$19, c=$20, spread_sum=$21, spread_n=$22, tot_buy=$23, tot_sell=$24`,
            [new Date(b.ts), S.fut && S.fut.symbol, b.ticks, b.events, b.vol, b.ltqSum, b.exactN, b.multiN, b.oddN, b.buyTick, b.sellTick, b.unTick, b.buyQ, b.sellQ, b.unQ, b.qByQuote, b.o, b.h, b.l, b.c, b.spreadSum, b.spreadN, b.totBuy, b.totSell]);
    }
    async function flush() {
        if (!dbPool || S.saving) return; S.saving = true;
        try {
            const done = S.pending.splice(0);
            for (const b of done) await saveBucket(b);
            if (S.bucket) await saveBucket(S.bucket);
            if (S.day) await dbPool.query(`INSERT INTO tickflow_lab_day (day, sym, stats) VALUES ($1,$2,$3) ON CONFLICT (day) DO UPDATE SET sym=$2, stats=$3, updated=NOW()`, [S.day, S.fut && S.fut.symbol, JSON.stringify(S.stats)]);
            const raws = S.rawQueue.splice(0);
            for (const r of raws) await dbPool.query(`INSERT INTO tickflow_lab_raw (day, label, len, hex, parsed) VALUES ($1,$2,$3,$4,$5)`, [r.day, r.label, r.len, r.hex, JSON.stringify(r.parsed)]);
        } catch (e) { log(`[TickFlowLab] save failed: ${e.message}`); }
        finally { S.saving = false; }
    }

    // one raw binary message from the socket. Never throws.
    function handleMessage(raw, atMs = now()) {
        try {
            const p = istParts(atMs);
            if (S.day !== p.day) { S.day = p.day; S.stats = freshStats(); S.rawCount = 0; S.flow = createFlow(); S.today = []; }
            const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            S.stats.packets++; S.lastPacketAt = atMs;
            if (buf.length < 123) { S.stats.smallMsgs++; if (S.stats.smallMsgs <= 3) log(`[TickFlowLab] small msg len=${buf.length}: ${buf.toString('utf8', 0, Math.min(buf.length, 120))}`); return false; }
            const t = parseSnapQuote(buf);
            if (!t) { S.stats.unparsed++; return false; }
            if (t.mode !== 3) S.stats.otherMode++;
            if (t.mode === 3 && buf.length !== 379) S.stats.badLen++;
            if (S.fut && t.token !== String(S.fut.token)) { S.stats.wrongToken++; return false; }
            if (!(t.ltp > 10000 && t.ltp < 40000)) { S.stats.ltpOutOfRange++; return false; }
            S.stats.parsedOk++;
            if (S.stats.exchTsSample === null) S.stats.exchTsSample = t.exchTs;
            if (S.rawCount < 30 && (S.stats.parsedOk <= 5 || S.stats.parsedOk % 20000 === 0)) {
                S.rawCount++;
                S.rawQueue.push({ day: p.day, label: `#${S.stats.parsedOk}`, len: buf.length, hex: buf.toString('hex'), parsed: { ...t } });
            }
            const s = flowStep(S.flow, t);
            if (s.volDrop) S.stats.volDrop++;
            if (t.bid !== null && t.ask !== null && t.bid > t.ask) S.stats.crossedBook++;
            if (s.dv > 0 && !(t.ltq > 0)) S.stats.ltqZeroOnTrade++;
            const minStart = Math.floor(atMs / 60000) * 60000;
            if (!S.bucket || S.bucket.ts !== minStart) {
                if (S.bucket) { S.pending.push(S.bucket); S.today.push(S.bucket); }
                S.bucket = newBucket(minStart);
                flush().catch(() => {});
            }
            addToBucket(S.bucket, t, s);
            return true;
        } catch (e) { return false; }
    }

    async function resolveFuture() {
        const today = istParts(now()).day;
        if (S.fut && S.futDay === today) return S.fut;
        if (cfg.tokenOverride) { S.fut = { token: String(cfg.tokenOverride), symbol: 'NIFTY-FUT(env)', expiry: null }; S.futDay = today; return S.fut; }
        let text;
        if (typeof fetchScrip === 'function') text = await fetchScrip();
        else {
            const axios = require('axios');
            const r = await axios.get(SCRIP_URL, { timeout: 60000, responseType: 'text', transformResponse: [d => d], maxContentLength: 400 * 1024 * 1024 });
            text = r.data;
        }
        const f = findNiftyFutToken(text, now());
        text = null;
        if (!f) throw new Error('no NIFTY futures contract found in ScripMaster');
        S.fut = f; S.futDay = today;
        log(`[TickFlowLab] futures contract: ${f.symbol} (token ${f.token}, expiry ${f.expiry})`);
        return f;
    }

    function cleanupSocket() { if (S.heartbeat) clearInterval(S.heartbeat); S.heartbeat = null; S.ws = null; S.connecting = false; }

    async function connect() {
        if (S.ws || S.connecting || !S.auth || !S.auth.feedToken) return;
        S.connecting = true;
        try {
            const fut = await resolveFuture();
            const WS = wsFactory || ((url, opts) => new (require('ws'))(url, opts));
            const ws = WS(WS_URL, { headers: { Authorization: S.auth.jwtToken, 'x-api-key': env.ANGEL_API_KEY, 'x-client-code': env.ANGEL_CLIENT_ID, 'x-feed-token': S.auth.feedToken } });
            S.ws = ws; S.stats.connects++; S.connectedAt = now(); S.lastPacketAt = now();
            S.flow = createFlow();                  // volume traded while we were disconnected must not become one fake giant trade
            ws.on('open', () => {
                ws.send(JSON.stringify({ correlationID: 'tickflowlab', action: 1, params: { mode: 3, tokenList: [{ exchangeType: 2, tokens: [fut.token] }] } }));
                log(`[TickFlowLab] connected, subscribed ${fut.symbol} (mode 3)`);
                S.heartbeat = setInterval(() => { try { if (ws.readyState === 1) ws.ping(); } catch (e) { /* ignore */ } }, 30000);
            });
            ws.on('message', raw => { handleMessage(raw); });
            ws.on('error', err => { log(`[TickFlowLab] socket error: ${err && err.message}`); if (/401/.test(String(err && err.message))) S.auth401 = true; });
            ws.on('close', code => {
                S.stats.closes++;
                if (S.ws !== ws) return;            // an intentional / stale close (already detached): no back-off, no reconnect bookkeeping
                const lived = now() - S.connectedAt;
                cleanupSocket();
                if (lived > 60000) { S.backoffMs = 5000; S.failures = 0; } else { S.failures++; S.backoffMs = Math.min(S.backoffMs * 2, 120000); }
                S.notBefore = now() + (S.failures >= 8 ? 600000 : S.backoffMs);
                // 26 Oct — two 401s in a row = the Angel token is stale: ask the app for a fresh login (at most once per 10 min)
                if (S.auth401 && S.failures >= 2 && typeof onAuthFail === 'function' && now() - S.lastAuthFixAt > 600000) {
                    S.lastAuthFixAt = now(); S.auth401 = false;
                    log('[TickFlowLab] token looks stale (401) - asking for a fresh Angel login');
                    Promise.resolve().then(() => onAuthFail()).catch(e => log(`[TickFlowLab] fresh login failed: ${e && e.message}`));
                }
                log(`[TickFlowLab] socket closed (${code}) after ${Math.round(lived / 1000)}s - retry in ${Math.round((S.notBefore - now()) / 1000)}s`);
                flush().catch(() => {});
            });
            S.connecting = false;
        } catch (e) {
            cleanupSocket(); S.failures++; S.notBefore = now() + 300000;
            log(`[TickFlowLab] connect failed: ${e.message} - retry in 5 min`);
        }
    }
    function disconnect() { const w = S.ws; cleanupSocket(); try { if (w) w.close(); } catch (e) { /* ignore */ } }

    // runs every 20s: connect inside the NSE futures session (Mon-Fri 09:14-15:42 IST), disconnect outside, restart a stalled socket
    function schedule() {
        if (!cfg.enabled || !S.started) return;
        const t = now(), p = istParts(t), inSession = p.dow >= 1 && p.dow <= 5 && p.min >= SESSION_START_MIN && p.min < SESSION_END_MIN;
        if (inSession) {
            if (S.ws && t - S.lastPacketAt > 90000 && t - S.connectedAt > 90000) { log('[TickFlowLab] no packets for 90s - restarting socket'); disconnect(); S.notBefore = t + 5000; }
            if (!S.ws && !S.connecting && S.auth && t >= S.notBefore && t - S.bootAt >= cfg.bootDelayMs) connect().catch(e => log(`[TickFlowLab] connect error: ${e.message}`));
        } else if (S.ws) { disconnect(); flush().catch(() => {}); }
    }

    function setAuth(auth) { S.auth = auth && auth.feedToken ? { jwtToken: auth.jwtToken, feedToken: auth.feedToken } : null; S.failures = 0; S.notBefore = 0; S.auth401 = false; }
    async function start() {
        if (S.started || !cfg.enabled || !dbPool) { if (!cfg.enabled) log('[TickFlowLab] TICKFLOW_LAB not set - not started'); return; }
        await ensureTables();
        S.started = true; S.bootAt = now();
        S.timers.push(setInterval(() => { try { schedule(); } catch (e) { /* ignore */ } }, 20000));
        S.timers.push(setInterval(() => { flush().catch(() => {}); }, 30000));
        log('🔬 [TickFlowLab] started (record-only, NIFTY futures, free Angel feed)');
    }
    function stop() { S.timers.forEach(clearInterval); S.timers = []; S.started = false; disconnect(); }

    async function report({ day } = {}) {
        if (!dbPool) return { ok: false, error: 'DB not connected' };
        let d = String(day || '').trim();
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: 'date must look like 2026-10-19 (IST day)' };
        if (!d) {
            const m = await dbPool.query(`SELECT MAX(ts) AS t FROM tickflow_lab_min`);
            if (!m.rows[0] || !m.rows[0].t) return { ok: false, error: 'No lab rows yet (the lab records only Mon-Fri 09:15-15:30 IST, about 90s after a deploy/restart)' };
            d = istParts(new Date(m.rows[0].t).getTime()).day;
        }
        const from = new Date(Date.parse(d + 'T00:00:00+05:30')), to = new Date(from.getTime() + 24 * 3600 * 1000);
        const r = await dbPool.query(`SELECT * FROM tickflow_lab_min WHERE ts >= $1 AND ts < $2 ORDER BY ts ASC`, [from, to]);
        const rows = r.rows.map(x => ({ ts: new Date(x.ts).getTime(), ticks: Number(x.ticks), events: Number(x.events), vol: Number(x.vol), ltqSum: Number(x.ltq_sum), buyTick: Number(x.buy_tick), sellTick: Number(x.sell_tick),
            unTick: Number(x.un_tick), buyQ: Number(x.buy_q), sellQ: Number(x.sell_q), unQ: Number(x.un_q), qByQuote: Number(x.q_by_quote), o: num(x.o), h: num(x.h), l: num(x.l), c: num(x.c), spreadSum: Number(x.spread_sum), spreadN: Number(x.spread_n) }));
        const st = await dbPool.query(`SELECT sym, stats FROM tickflow_lab_day WHERE day = $1`, [d]);
        const rw = await dbPool.query(`SELECT label, len, hex, parsed FROM tickflow_lab_raw WHERE day = $1 ORDER BY id DESC LIMIT 8`, [d]);
        const rep = buildDayReport(rows, d);
        return { ok: true, ...rep, symbol: st.rows[0] ? st.rows[0].sym : null, stats: st.rows[0] ? st.rows[0].stats : null, raws: rw.rows.reverse(),
            live: { enabled: cfg.enabled, started: S.started, connected: !!S.ws, hasAuth: !!S.auth, lastPacketAgoSec: S.lastPacketAt ? Math.round((now() - S.lastPacketAt) / 1000) : null } };
    }

    // ── live card (24 Oct): built from memory + a rarely-refreshed DB read; never touches the broker API ─────────────────
    async function refreshRows() {
        if (!dbPool || L.loading) return; L.loading = true;
        try {
            const d = istParts(now()).day, from = new Date(Date.parse(d + 'T00:00:00+05:30')), to = new Date(from.getTime() + 24 * 3600 * 1000);
            const r = await dbPool.query(`SELECT * FROM tickflow_lab_min WHERE ts >= $1 AND ts < $2 ORDER BY ts ASC`, [from, to]);
            L.rows = r.rows.map(x => ({ ts: new Date(x.ts).getTime(), ticks: Number(x.ticks), events: Number(x.events), vol: Number(x.vol), ltqSum: Number(x.ltq_sum), buyTick: Number(x.buy_tick), sellTick: Number(x.sell_tick),
                unTick: Number(x.un_tick), buyQ: Number(x.buy_q), sellQ: Number(x.sell_q), unQ: Number(x.un_q), qByQuote: Number(x.q_by_quote), o: num(x.o), h: num(x.h), l: num(x.l), c: num(x.c), spreadSum: Number(x.spread_sum), spreadN: Number(x.spread_n) }));
            L.day = d; L.at = now();
        } catch (e) { L.at = now(); }          // retry in 5 min, not on every tick
        finally { L.loading = false; }
    }
    // null when there is nothing live to show (lab off, not started, or no packet for 2 minutes)
    function livePayload() {
        if (!S.started) return null;
        const t = now(), p = istParts(t);
        if (!S.lastPacketAt || t - S.lastPacketAt > 120000) return null;
        if (L.day !== p.day || t - L.at > 300000) refreshRows().catch(() => {});
        return mergeLiveCard({ dbRows: L.day === p.day ? L.rows : [], todayBuckets: S.today, current: S.bucket, day: p.day, symbol: S.fut && S.fut.symbol,
            live: { connected: !!S.ws, lastPacketAgoSec: Math.round((t - S.lastPacketAt) / 1000) }, nowMs: t });
    }
    return { cfg, start, stop, setAuth, report, flush, schedule, livePayload, _handleMessage: handleMessage, _state: S };
}

// 24 Oct — DISPLAY-ONLY card payload for the dashboard (volume + approximate delta per 15 min). Pure.
// delta = the lab's quote-rule delta (buy volume minus sell volume it could classify; it sees only a sample of trades, so it is approximate).
// Nothing here feeds signals, gates or alerts.
function toCardPayload(rep, nowMs = Date.now()) {
    if (!rep || !rep.ok) return { success: false, error: (rep && rep.error) || 'no report' };
    const bars = (rep.bars || []).map(b => ({ label: b.label, vol: Number(b.vol) || 0, delta: Number(b.deltaQuote) || 0, cum: Number(b.cumQuote) || 0,
        buy: Number(b.buyQuote) || 0, sell: Number(b.sellQuote) || 0,
        coveragePct: b.coveragePct === undefined ? null : b.coveragePct, partial: b.minutes < BAR_MIN }));
    const t = rep.totals || {};
    const ist = istParts(nowMs);
    return { success: true, enabled: true, day: rep.day, isToday: rep.day === ist.day, symbol: rep.symbol || null,
        live: rep.live ? { connected: !!rep.live.connected, lastPacketAgoSec: rep.live.lastPacketAgoSec } : null,
        bars, totals: { vol: Number(t.vol) || 0, delta: Number(t.cumQuote) || 0, buy: bars.reduce((a, b) => a + b.buy, 0), sell: bars.reduce((a, b) => a + b.sell, 0),
            coveragePct: t.coveragePct === undefined ? null : t.coveragePct } };
}

// minute bucket (in memory) -> the row shape buildDayReport expects
function bucketToRow(b) {
    return { ts: b.ts, ticks: b.ticks, events: b.events, vol: b.vol, ltqSum: b.ltqSum, buyTick: b.buyTick, sellTick: b.sellTick, unTick: b.unTick, buyQ: b.buyQ, sellQ: b.sellQ, unQ: b.unQ,
        qByQuote: b.qByQuote, o: b.o, h: b.h, l: b.l, c: b.c, spreadSum: b.spreadSum, spreadN: b.spreadN };
}

// PURE: DB rows (older minutes, may be stale) + this process's own completed minutes + the minute still forming -> card payload.
// Memory wins over the DB for the same minute, so a minute never disappears between a flush and the next DB read.
function mergeLiveCard({ dbRows = [], todayBuckets = [], current = null, day, symbol = null, live = null, nowMs = Date.now() }) {
    const byTs = new Map();
    for (const r of dbRows) byTs.set(r.ts, r);
    for (const b of todayBuckets) if (b && b.ticks) byTs.set(b.ts, bucketToRow(b));
    if (current && current.ticks) byTs.set(current.ts, bucketToRow(current));
    const rep = { ok: true, ...buildDayReport([...byTs.values()], day), symbol, live };
    const card = toCardPayload(rep, nowMs);
    if (card.success) { card.last = current && current.c !== null ? current.c : null; card.serverTs = nowMs; }
    return card;
}

module.exports = { mergeLiveCard, bucketToRow, toCardPayload, parseSnapQuote, createFlow, flowStep, newBucket, addToBucket, findNiftyFutToken, buildDayReport, formatLabText, istParts, createTickFlowLab };