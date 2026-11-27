/* 📝 "Paper Trade" tab (27 Nov 2026) — virtual NIFTY OPTION trades, broker-app style: an option chain (CALL | strike | PUT with OI and LTP) for the nearest weekly expiry;
 * tap a premium to open an order ticket: BUY/SELL, Intraday / Carry Forward, lots, MARKET / LIMIT / TRIGGER, DAY / IOC, optional SL / target on the premium.
 * MARKET fills at the live premium +/- slippage; LIMIT / TRIGGER wait as pending orders; approximate charges are deducted when a trade closes; Carry Forward trades stay
 * open overnight and settle at intrinsic value on expiry. Nothing here touches a broker, a signal, a gate or the Signal Journal. Trades live in THIS browser only
 * (localStorage). The pure functions are loadable in Node for tests; the DOM part never throws into the page. */
(function (root) {
  'use strict';
  var KEY = 'vn_paper_v1', LOT = 65, MAX_CLOSED = 200, CAPITAL = 500000, MARGIN_RATE = 0.11, SLIP = 0.5;   // margin ~11% of index value per lot (approx. futures-style margin; also used for option SELL)
  function n(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function inr(x) { var a = Math.abs(Math.round(x)); return (x < 0 ? '-' : (x > 0 ? '+' : '')) + '₹' + a.toLocaleString('en-IN'); }
  function inr2(x) { return '₹' + Math.round(x).toLocaleString('en-IN'); }
  function pts(x) { return (x > 0 ? '+' : '') + x.toFixed(1); }
  function r2(x) { return Math.round(x * 100) / 100; }
  function tick(x) { return Math.round(x * 20) / 20; }   // option price tick 0.05
  function istDay(ts) { try { return new Date(ts + 19800000).toISOString().slice(0, 10); } catch (e) { return ''; } }
  function istMin(ts) { try { var d = new Date(ts + 19800000); return d.getUTCHours() * 60 + d.getUTCMinutes(); } catch (e) { return 0; } }
  function blank() { return { seq: 0, capital: CAPITAL, open: [], closed: [], pending: [], log: [] }; }
  function note(st, now, text) { st.log = st.log || []; st.log.unshift({ ts: now, text: text }); if (st.log.length > 20) st.log.length = 20; }

  // points made by a trade if closed at `price`
  function trPts(t, price) { return t.side === 'BUY' ? price - t.entry : t.entry - price; }
  function trRs(t, price) { return trPts(t, price) * t.qty; }
  function realized(st) { var s = 0; st.closed.forEach(function (t) { s += t.rs; }); return s; }
  function marginUsed(st) { var s = 0; st.open.forEach(function (t) { s += t.margin || 0; }); return s; }
  // ctx: a number (index price, old style) or { nifty, chain }. Option trades are marked at their contract's live premium, else the last one seen.
  function asCtx(c) { return c !== null && typeof c === 'object' ? c : { nifty: n(c), chain: null }; }
  function premFor(chain, opt, k, exp) {
    if (!chain || !Array.isArray(chain.rows)) return null;
    if (exp && chain.expiry && exp !== chain.expiry) return null;   // the chain shows another expiry now: this contract is not in it
    for (var i = 0; i < chain.rows.length; i++) { var r = chain.rows[i]; if (r.k === k) { var v = opt === 'CE' ? r.ce : r.pe; return v > 0 ? v : null; } }
    return null;
  }
  function markOf(t, c) { if (t.opt) { var v = premFor(c.chain, t.opt, t.strike, t.expiry); return v > 0 ? v : (n(t.lastLtp) > 0 ? n(t.lastLtp) : null); } return n(c.nifty) > 0 ? n(c.nifty) : null; }
  // approx. option charges (Rs) for a buy price + sell price: flat Rs20 x 2 orders, STT 0.1% on the sell side, exchange 0.03503%, SEBI, stamp 0.003% on buy, GST 18%
  function optCharges(buyPx, sellPx, qty) {
    var b = buyPx * qty, sv = sellPx * qty, brk = 40, exch = 0.0003503 * (b + sv), sebi = 0.000001 * (b + sv);
    return brk + 0.001 * sv + exch + sebi + 0.00003 * b + 0.18 * (brk + exch + sebi);
  }
  function unreal(st, c) { c = asCtx(c); var s = 0; st.open.forEach(function (t) { var m = markOf(t, c); if (m > 0) s += trRs(t, m); }); return s; }
  // profit/loss that changes spendable cash: everything except a BOUGHT option (its premium was already paid out of cash)
  function unrealCash(st, c) { c = asCtx(c); var s = 0; st.open.forEach(function (t) { if (t.opt && t.side === 'BUY') return; var m = markOf(t, c); if (m > 0) s += trRs(t, m); }); return s; }
  // account view: balance = capital + closed P&L; equity adds open P&L; free = cash left after premium paid / margin held
  function account(st, price) {
    var cap = n(st.capital) > 0 ? Number(st.capital) : CAPITAL, bal = cap + realized(st), eq = bal + unreal(st, price), mu = marginUsed(st);
    // max drawdown on closed-trade balance, oldest -> newest
    var run = cap, peak = cap, dd = 0, ord = st.closed.slice().reverse();
    ord.forEach(function (t) { run += t.rs; if (run > peak) peak = run; var d = peak > 0 ? (peak - run) / peak : 0; if (d > dd) dd = d; });
    return { capital: cap, balance: bal, equity: eq, marginUsed: mu, free: bal + unrealCash(st, price) - mu, maxDdPct: dd * 100 };
  }

  // st: state; returns { ok, error? } and mutates st  (old index-point trade, kept so earlier trades and tests still work)
  function openTrade(st, o) {
    var price = n(o.price), lots = Math.floor(n(o.lots) || 0), lot = n(o.lot) || LOT;
    if (o.side !== 'BUY' && o.side !== 'SELL') return { ok: false, error: 'BUY ya SELL chuno' };
    if (!(price > 0)) return { ok: false, error: 'Live Nifty bhav nahi mila' };
    if (!(lots >= 1 && lots <= 50)) return { ok: false, error: 'Lots 1 se 50 ke beech rakho' };
    var slP = n(o.slPts), tgP = n(o.tgPts);
    if (slP !== null && slP <= 0) return { ok: false, error: 'SL points 0 se zyada hone chahiye' };
    if (tgP !== null && tgP <= 0) return { ok: false, error: 'Target points 0 se zyada hone chahiye' };
    if (st.open.length >= 10) return { ok: false, error: 'Ek saath 10 se zyada open trade nahi' };
    var need = price * lot * lots * MARGIN_RATE, acc = account(st, price);
    if (need > acc.free) {
      var maxL = Math.max(0, Math.floor(acc.free / (price * lot * MARGIN_RATE)));
      return { ok: false, error: 'Margin kam hai: ' + lots + ' lot ke liye ₹' + Math.round(need).toLocaleString('en-IN') + ' chahiye, free ₹' + Math.max(0, Math.round(acc.free)).toLocaleString('en-IN') + (maxL ? ' (max ' + maxL + ' lot)' : '') };
    }
    var buy = o.side === 'BUY';
    st.seq += 1;
    st.open.push({ id: st.seq, side: o.side, entry: price, lots: lots, qty: lots * lot, margin: need, entryTs: o.now,
      sl: slP !== null ? (buy ? price - slP : price + slP) : null, tg: tgP !== null ? (buy ? price + tgP : price - tgP) : null });
    return { ok: true };
  }

  // ---- option orders ----
  // SL / target level from a { v, u:'%'|'₹' } spec: % is measured from the fill price in the losing / winning direction; ₹ is an absolute premium
  function resolveLv(spec, fill, side, kind) {
    if (!spec) return null; var v = n(spec.v); if (v === null) return null;
    if (spec.u !== '%') return v;
    var buy = side === 'BUY', dir = kind === 'sl' ? (buy ? -1 : 1) : (buy ? 1 : -1);
    return tick(fill * (1 + dir * v / 100));
  }
  // really open the position at fillPx (checks SL/target sanity, slot and cash/margin)
  function fillOrder(st, o, fillPx, now) {
    var buy = o.side === 'BUY', lot = n(o.lot) || LOT, lots = o.lots, qty = lots * lot;
    var sl = n(o.slPrem) !== null ? n(o.slPrem) : resolveLv(o.slSpec, fillPx, o.side, 'sl'), tg = n(o.tgPrem) !== null ? n(o.tgPrem) : resolveLv(o.tgSpec, fillPx, o.side, 'tg');
    if (buy) {
      if (sl !== null && !(sl > 0 && sl < fillPx)) return { ok: false, error: 'SL premium entry (' + fillPx.toFixed(2) + ') se neeche aur 0 se upar hona chahiye' };
      if (tg !== null && !(tg > fillPx)) return { ok: false, error: 'Target premium entry (' + fillPx.toFixed(2) + ') se upar hona chahiye' };
    } else {
      if (sl !== null && !(sl > fillPx)) return { ok: false, error: 'SELL mein SL premium entry (' + fillPx.toFixed(2) + ') se upar hona chahiye' };
      if (tg !== null && !(tg > 0 && tg < fillPx)) return { ok: false, error: 'SELL mein target premium entry (' + fillPx.toFixed(2) + ') se neeche aur 0 se upar hona chahiye' };
    }
    if (st.open.length >= 10) return { ok: false, error: 'Ek saath 10 se zyada open trade nahi' };
    var spot = n(o.spot) || n(o.chain && o.chain.spot) || 0;
    if (!buy && !(spot > 0)) return { ok: false, error: 'Live Nifty bhav nahi mila' };
    var need = buy ? fillPx * qty : spot * qty * MARGIN_RATE, acc = account(st, { nifty: spot || null, chain: o.chain });
    if (need > acc.free) {
      var maxL = Math.max(0, Math.floor(acc.free / (need / lots)));
      return { ok: false, error: (buy ? 'Paisa kam hai: ' : 'Margin kam hai: ') + lots + ' lot ke liye ₹' + Math.round(need).toLocaleString('en-IN') + ' chahiye, free ₹' + Math.max(0, Math.round(acc.free)).toLocaleString('en-IN') + (maxL ? ' (max ' + maxL + ' lot)' : '') };
    }
    st.seq += 1;
    st.open.push({ id: st.seq, side: o.side, opt: o.opt, strike: o.strike, expiry: o.expiry || '', product: o.product === 'CARRY' ? 'CARRY' : 'INTRADAY', otype: o.otype || 'MARKET', entry: fillPx,
      lastLtp: n(o.ltp) || fillPx, lastSpot: spot || null, lots: lots, qty: qty, margin: need, entryTs: now, sl: sl, tg: tg });
    return { ok: true };
  }
  // Place an NIFTY option order. o: { opt:'CE'|'PE', strike, chain, lots, side:'BUY'|'SELL', product:'INTRADAY'|'CARRY', type:'MARKET'|'LIMIT'|'TRIGGER', price, validity:'DAY'|'IOC',
  //   slPrem/tgPrem (absolute) or slSpec/tgSpec {v,u}, now, lot?, expiry? }.  MARKET fills now at the live premium +/- slippage; LIMIT / TRIGGER wait (pending) unless LIMIT is already marketable.
  function openOption(st, o) {
    var side = o.side === 'SELL' ? 'SELL' : 'BUY', buy = side === 'BUY', lots = Math.floor(n(o.lots) || 0), lot = n(o.lot) || LOT, k = n(o.strike);
    var type = o.type === 'LIMIT' || o.type === 'TRIGGER' ? o.type : 'MARKET', validity = o.validity === 'IOC' ? 'IOC' : 'DAY', product = o.product === 'CARRY' ? 'CARRY' : 'INTRADAY';
    if (o.opt !== 'CE' && o.opt !== 'PE') return { ok: false, error: 'CALL (CE) ya PUT (PE) chuno' };
    if (k === null) return { ok: false, error: 'Strike chuno' };
    var exp = o.expiry || (o.chain && o.chain.expiry) || '', ltp = premFor(o.chain, o.opt, k, exp);
    if (!(ltp > 0)) return { ok: false, error: 'Is strike ka live premium nahi mila — doosra strike chuno' };
    if (!(lots >= 1 && lots <= 50)) return { ok: false, error: 'Lots 1 se 50 ke beech rakho' };
    var base = { opt: o.opt, strike: k, expiry: exp, side: side, lots: lots, lot: lot, product: product, otype: type, spot: n(o.spot) || n(o.chain && o.chain.spot), chain: o.chain, ltp: ltp,
      slPrem: o.slPrem, tgPrem: o.tgPrem, slSpec: o.slSpec, tgSpec: o.tgSpec };
    var price = n(o.price), fp;
    if (type === 'MARKET') {
      fp = buy ? r2(ltp + SLIP) : Math.max(0.05, r2(ltp - SLIP));
      var rm = fillOrder(st, base, fp, o.now); return rm.ok ? { ok: true, filled: true } : rm;
    }
    if (!(price > 0)) return { ok: false, error: (type === 'LIMIT' ? 'Limit' : 'Trigger') + ' price daalo' };
    if (type === 'LIMIT') {
      if (buy ? ltp <= price : ltp >= price) {   // already marketable: fills now, never worse than the limit
        fp = buy ? Math.min(price, r2(ltp + SLIP)) : Math.max(price, r2(ltp - SLIP));
        var rl = fillOrder(st, base, fp, o.now); return rl.ok ? { ok: true, filled: true } : rl;
      }
      if (validity === 'IOC') return { ok: false, error: 'IOC: us limit par abhi fill nahi ho sakta — order cancel' };
    } else {
      if (validity === 'IOC') return { ok: false, error: 'IOC sirf LIMIT/MARKET ke saath chalta hai' };
      if (buy ? !(price > ltp) : !(price < ltp)) return { ok: false, error: 'Trigger BUY ke liye abhi ke premium (' + ltp.toFixed(2) + ') se upar, SELL ke liye neeche hona chahiye' };
    }
    if ((st.pending || []).length >= 10) return { ok: false, error: 'Ek saath 10 se zyada pending order nahi' };
    st.pending = st.pending || []; st.seq += 1;
    st.pending.push({ id: st.seq, opt: o.opt, strike: k, expiry: exp, side: side, lots: lots, lot: lot, product: product, type: type, price: price, validity: validity,
      slPrem: n(o.slPrem), tgPrem: n(o.tgPrem), slSpec: o.slSpec || null, tgSpec: o.tgSpec || null, placedTs: o.now });
    return { ok: true, pending: true };
  }
  function cancelPending(st, id, now, why) {
    var p = (st.pending || []).filter(function (x) { return x.id === id; })[0]; if (!p) return false;
    st.pending = st.pending.filter(function (x) { return x.id !== id; });
    note(st, now, '#' + p.id + ' ' + p.side + ' ' + p.strike + ' ' + p.opt + ' ' + p.type + ' cancel' + (why ? ' — ' + why : '')); return true;
  }
  // pending LIMIT / TRIGGER orders: fill when the live premium reaches them
  function processPending(st, c, now) {
    c = asCtx(c); var done = 0;
    (st.pending || []).slice().forEach(function (p) {
      var ltp = premFor(c.chain, p.opt, p.strike, p.expiry); if (!(ltp > 0)) return;
      var buy = p.side === 'BUY', go, fp;
      if (p.type === 'LIMIT') { go = buy ? ltp <= p.price : ltp >= p.price; fp = buy ? Math.min(p.price, r2(ltp + SLIP)) : Math.max(p.price, r2(ltp - SLIP)); }
      else { go = buy ? ltp >= p.price : ltp <= p.price; fp = buy ? r2(ltp + SLIP) : Math.max(0.05, r2(ltp - SLIP)); }
      if (!go) return;
      st.pending = st.pending.filter(function (x) { return x.id !== p.id; });
      var r = fillOrder(st, { opt: p.opt, strike: p.strike, expiry: p.expiry, side: p.side, lots: p.lots, lot: p.lot, product: p.product, otype: p.type, spot: c.nifty, chain: c.chain, ltp: ltp,
        slPrem: p.slPrem, tgPrem: p.tgPrem, slSpec: p.slSpec, tgSpec: p.tgSpec }, fp, now);
      note(st, now, '#' + p.id + ' ' + p.side + ' ' + p.strike + ' ' + p.opt + (r.ok ? ' ' + p.type + ' fill @ ' + fp.toFixed(2) : ' cancel — ' + r.error)); done++;
    });
    return done;
  }
  function cancelAllPending(st, now, why) { var c = 0; (st.pending || []).slice().forEach(function (p) { if (cancelPending(st, p.id, now, why)) c++; }); return c; }

  function closeAt(st, t, price, now, reason, noSlip) {
    st.open = st.open.filter(function (x) { return x.id !== t.id; });
    if (t.opt) {   // option: exit slightly worse than the mark (slippage) unless it settled at expiry; approximate charges deducted
      var buy = t.side === 'BUY', ex = noSlip ? Math.max(0, r2(price)) : (buy ? Math.max(0.05, r2(price - SLIP)) : r2(price + SLIP));
      var ch = buy ? optCharges(t.entry, ex, t.qty) : optCharges(ex, t.entry, t.qty), gross = (buy ? ex - t.entry : t.entry - ex) * t.qty;
      st.closed.unshift({ id: t.id, side: t.side, opt: t.opt, strike: t.strike, product: t.product, otype: t.otype, sl: t.sl, tg: t.tg, entry: t.entry, exit: ex, lots: t.lots, qty: t.qty, entryTs: t.entryTs, exitTs: now, reason: reason,
        pts: gross / t.qty, charges: ch, rs: gross - ch });
      if (st.closed.length > MAX_CLOSED) st.closed.length = MAX_CLOSED;
      return;
    }
    st.closed.unshift({ id: t.id, side: t.side, entry: t.entry, exit: price, lots: t.lots, qty: t.qty, entryTs: t.entryTs, exitTs: now, reason: reason,
      pts: trPts(t, price), rs: trRs(t, price) });
    if (st.closed.length > MAX_CLOSED) st.closed.length = MAX_CLOSED;
  }
  function closeTrade(st, id, price, now) {
    var p = n(price); if (!(p > 0)) return false;
    var t = st.open.filter(function (x) { return x.id === id; })[0]; if (!t) return false;
    closeAt(st, t, p, now, 'Haath se band'); return true;
  }
  // live tick: closes any trade whose SL / target was touched (fills at the SL/target level, paper-trade simplification) and remembers the last premium / spot
  function onTick(st, price, now) {
    var c = asCtx(price), hit = 0;
    st.open.slice().forEach(function (t) {
      var p = markOf(t, c); if (!(p > 0)) return;
      if (t.opt) { t.lastLtp = p; if (n(c.nifty) > 0) t.lastSpot = n(c.nifty); }
      var buy = t.side === 'BUY';
      if (t.sl !== null && (buy ? p <= t.sl : p >= t.sl)) { closeAt(st, t, t.sl, now, 'SL laga'); hit++; }
      else if (t.tg !== null && (buy ? p >= t.tg : p <= t.tg)) { closeAt(st, t, t.tg, now, 'Target mila'); hit++; }
    });
    return hit;
  }
  // option contracts past their expiry settle at intrinsic value of the last Nifty seen
  function contractExpired(t, now) {
    if (!t.opt || !t.expiry) return false;
    var today = istDay(now); return t.expiry < today || (t.expiry === today && istMin(now) >= 930);
  }
  function settleExpired(st, c, now) {
    c = asCtx(c); var k = 0;
    st.open.slice().forEach(function (t) {
      if (!contractExpired(t, now)) return;
      var sp = n(t.lastSpot) > 0 ? n(t.lastSpot) : n(c.nifty); if (!(sp > 0)) return;
      closeAt(st, t, t.opt === 'CE' ? Math.max(0, sp - t.strike) : Math.max(0, t.strike - sp), now, 'Expiry settle', true); k++;
    });
    return k;
  }
  // close every open trade (intradayOnly: leave CARRY FORWARD option trades running)
  function squareOffAll(st, price, now, reason, intradayOnly) {
    var cx = asCtx(price), c = 0;
    st.open.slice().forEach(function (t) {
      if (intradayOnly && t.product === 'CARRY') return;
      var p = markOf(t, cx); if (p > 0) { closeAt(st, t, p, now, reason || 'Din ka end'); c++; }
    });
    return c;
  }
  function setCapital(st, v) {
    var c = n(v); if (!(c >= 10000 && c <= 100000000)) return { ok: false, error: 'Capital ₹10,000 se ₹10 crore ke beech rakho' };
    if (st.open.length) return { ok: false, error: 'Capital badalne se pehle open trades band karo' };
    st.capital = Math.round(c); return { ok: true };
  }
  function stats(st) {
    var c = st.closed, wins = 0, gp = 0, gl = 0, net = 0, best = null, worst = null;
    c.forEach(function (t) { net += t.rs; if (t.rs > 0) { wins++; gp += t.rs; } else if (t.rs < 0) gl += -t.rs; best = best === null ? t.rs : Math.max(best, t.rs); worst = worst === null ? t.rs : Math.min(worst, t.rs); });
    return { n: c.length, wins: wins, winPct: c.length ? Math.round(100 * wins / c.length) : null, net: net, pf: gl > 0 ? gp / gl : (gp > 0 ? null : null), best: best, worst: worst };
  }
  function openPnl(st, price) {
    var c = asCtx(price), s = 0, any = false;
    st.open.forEach(function (t) { var m = markOf(t, c); if (m > 0) { s += trRs(t, m); any = true; } });
    return any || !st.open.length ? s : null;
  }
  // can a new trade be placed now? (live market only)
  function marketLive(s) { var w = s && s.entryWindow && s.entryWindow.status; return w === 'volatile' || w === 'trade' || w === 'caution' || w === 'theta'; }

  // ---- storage ----
  var mem = null;
  function load() {
    try { var raw = root.localStorage && root.localStorage.getItem(KEY); if (raw) { var o = JSON.parse(raw); if (o && Array.isArray(o.open) && Array.isArray(o.closed)) { o.seq = o.seq || 0; if (!(n(o.capital) > 0)) o.capital = CAPITAL; if (!Array.isArray(o.pending)) o.pending = []; if (!Array.isArray(o.log)) o.log = []; return o; } } } catch (e) { /* ignore */ }
    return mem || blank();
  }
  function save(st) { mem = st; try { root.localStorage && root.localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* ignore */ } }

  // ---- DOM ----
  var st = null, mounted = false, lastPrice = null, lastLive = false, lastS = null, msg = '', confirmReset = false, chain = null, chainTs = 0, fetching = false, view = 'chain', scrolled = false,
      order = { opt: 'CE', strike: null, side: 'BUY', product: 'INTRADAY', lots: '1', ptype: 'MARKET', price: '', validity: 'DAY', sl: '', slu: '%', tg: '', tgu: '%' }, search = '';
  function $(id) { return typeof document !== 'undefined' ? document.getElementById(id) : null; }
  function hhmm(ts) { try { var d = new Date(ts + 19800000); return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2); } catch (e) { return ''; } }
  function col(x) { return x > 0 ? 'var(--green)' : (x < 0 ? 'var(--red)' : 'var(--dim)'); }
  function ctx() { return { nifty: lastPrice, chain: chain }; }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function expLabel(iso) { try { var d = new Date(iso + 'T00:00:00Z'); return ('0' + d.getUTCDate()).slice(-2) + ' ' + MON[d.getUTCMonth()]; } catch (e) { return iso || ''; } }
  function expLabelY(iso) { try { return expLabel(iso) + ' ' + String(iso).slice(2, 4); } catch (e) { return iso || ''; } }
  function fmtOI(v) { v = Math.abs(v); return v >= 1e7 ? (v / 1e7).toFixed(2) + ' Cr' : (v >= 1e5 ? (v / 1e5).toFixed(2) + ' L' : (v >= 1e3 ? (v / 1e3).toFixed(1) + ' K' : String(Math.round(v)))); }
  function fmtCh(v) { return (v > 0 ? '+' : (v < 0 ? '-' : '')) + fmtOI(v); }
  function styleOnce() {
    if (typeof document === 'undefined' || $('pt-style')) return;
    var e = document.createElement('style'); e.id = 'pt-style';
    e.textContent = '.ptx-seg{display:flex;background:var(--bg3);border-radius:22px;padding:3px;gap:2px}.ptx-seg button{flex:1;border:0;background:transparent;color:var(--dim);padding:9px 6px;border-radius:20px;font-weight:700;font-size:13px;cursor:pointer}' +
      '.ptx-seg button.on{background:#12a65a;color:#fff}.ptx-seg.sell button.on{background:#e8472f}.ptx-seg button:disabled{opacity:.4}' +
      '.ptx-box{background:var(--bg3);border-radius:12px;padding:12px;margin-bottom:10px}.ptx-lbl{font-size:11px;letter-spacing:1px;color:var(--dim);font-weight:700;margin-bottom:6px}' +
      '.ptx-in{width:100%;box-sizing:border-box;padding:10px;background:rgba(0,0,0,.25);color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:16px;text-align:center}' +
      '.ptx-chain{max-height:56vh;overflow:auto;border:1px solid var(--border);border-radius:10px;position:relative}' +
      '.ptx-row{display:grid;grid-template-columns:1fr 1fr 74px 1fr 1fr;text-align:center;font-size:12px;border-bottom:1px solid rgba(255,255,255,.05)}.ptx-row>div{padding:9px 2px;cursor:pointer}' +
      '.ptx-hd{position:sticky;top:0;z-index:2;background:var(--bg2,#0d1626);font-size:10px;color:var(--dim);letter-spacing:.5px}.ptx-hd>div{cursor:default;padding:6px 2px}' +
      '.ptx-ci{background:rgba(0,150,136,.30)}.ptx-pi{background:rgba(92,99,200,.30)}.ptx-k{font-weight:700;font-size:14px;background:rgba(0,0,0,.22);display:flex;align-items:center;justify-content:center;cursor:default!important}' +
      '.ptx-atm{height:0;border-top:2px dashed #2f7bff;position:relative;margin:12px 0}.ptx-atm span{position:absolute;left:50%;top:-11px;transform:translateX(-50%);background:#2f7bff;color:#fff;font-size:11px;font-weight:700;padding:1px 9px;border-radius:5px}' +
      '.ptx-go{width:100%;padding:14px;border:0;border-radius:26px;font-size:16px;font-weight:800;color:#fff;cursor:pointer}.ptx-step{width:44px;border:0;background:transparent;color:var(--text);font-size:22px;cursor:pointer}';
    (document.head || document.documentElement).appendChild(e);
  }
  function rowFor(k) { return chain && Array.isArray(chain.rows) ? chain.rows.filter(function (r) { return r.k === k; })[0] : null; }
  function atmStrike() {
    if (!chain || !chain.rows || !chain.rows.length) return null;
    var sp = n(chain.spot) || lastPrice || 0, bk = chain.rows[0].k, bd = 1e9;
    chain.rows.forEach(function (r) { var d = Math.abs(r.k - sp); if (d < bd) { bd = d; bk = r.k; } }); return bk;
  }
  function oiCell(oi, ch) { return '<div style="font-weight:600;">' + (oi > 0 ? fmtOI(oi) : '--') + '</div>' + (ch === null || ch === undefined ? '' : '<div style="font-size:11px;color:' + col(ch) + ';">' + fmtCh(ch) + '</div>'); }
  function rowsHtml() {
    if (!chain || !chain.rows || !chain.rows.length) return '<div style="padding:14px;font-size:12px;color:var(--amber);">Option chain abhi nahi aayi — thodi der mein dobara dekho.</div>';
    var spot = n(chain.spot) || lastPrice || 0, q = String(search || '').replace(/[^0-9]/g, ''), h = [], placed = false, any = false;
    chain.rows.forEach(function (r) {
      if (q && String(r.k).indexOf(q) < 0) return;
      any = true;
      if (!placed && !q && r.k > spot) { h.push('<div class="ptx-atm" id="pt-atm"><span>' + (spot > 0 ? spot.toFixed(2) : '--') + '</span></div>'); placed = true; }
      var ci = r.k < spot, pi = r.k > spot;
      h.push('<div class="ptx-row">' +
        '<div class="' + (ci ? 'ptx-ci' : '') + '" data-pt-pick="CE:' + r.k + '">' + oiCell(r.ceOi, r.ceOiCh) + '</div>' +
        '<div class="' + (ci ? 'ptx-ci' : '') + '" data-pt-pick="CE:' + r.k + '"><b>' + (r.ce > 0 ? r.ce.toFixed(2) : '--') + '</b></div>' +
        '<div class="ptx-k">' + r.k.toLocaleString('en-IN') + '</div>' +
        '<div class="' + (pi ? 'ptx-pi' : '') + '" data-pt-pick="PE:' + r.k + '"><b>' + (r.pe > 0 ? r.pe.toFixed(2) : '--') + '</b></div>' +
        '<div class="' + (pi ? 'ptx-pi' : '') + '" data-pt-pick="PE:' + r.k + '">' + oiCell(r.peOi, r.peOiCh) + '</div></div>');
    });
    if (!placed && !q && any) h.push('<div class="ptx-atm" id="pt-atm"><span>' + (spot > 0 ? spot.toFixed(2) : '--') + '</span></div>');
    if (!any) h.push('<div style="padding:14px;font-size:12px;color:var(--dim);">Ye strike nahi mila.</div>');
    return h.join('');
  }
  function accountStrip(A) {
    return '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:12px;text-align:center;margin-bottom:8px;">' +
      '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Balance</div><b style="color:' + col(A.equity - A.capital) + ';">' + inr2(A.equity) + '</b></div>' +
      '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Free cash</div><b>' + inr2(Math.max(0, A.free)) + '</b></div>' +
      '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Max drawdown</div><b style="color:' + (A.maxDdPct > 0 ? 'var(--red)' : 'var(--dim)') + ';">' + A.maxDdPct.toFixed(1) + '%</b></div></div>';
  }
  function drawChain(host) {
    var live = marketLive(lastS), c = ctx(), A = account(st, c), ps = openPnl(st, c), S = stats(st), h = [], s = lastS || {};
    var chg = n(s.change), pct = n(s.changePct);
    h.push('<div class="tool-card"><div class="tool-title">📝 PAPER TRADE <span style="font-size:11px;color:var(--dim);font-weight:400;">virtual — asli paisa nahi</span></div>');
    h.push('<div style="font-size:12px;color:var(--dim);margin-bottom:8px;line-height:1.5;">Nifty options ka apna manual trade: chain mein CALL/PUT ka premium dabao, order ticket kholo. Broker, signal ya Signal Journal se koi link nahi. Record sirf isi phone/browser mein save hota hai.</div>');
    h.push(accountStrip(A));
    h.push('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><div><div style="font-weight:700;">NIFTY <span style="font-size:11px;color:var(--dim);">Indices ' + (live ? '🟢 LIVE' : '🌙 band') + '</span></div></div><div style="text-align:right;"><div style="font-family:\'Share Tech Mono\',monospace;font-size:20px;font-weight:700;color:' + col(chg) + ';">' + (lastPrice > 0 ? lastPrice.toFixed(2) : '--') + '</div>' + (chg !== null ? '<div style="font-size:12px;color:' + col(chg) + ';">' + (chg > 0 ? '+' : '') + chg.toFixed(2) + (pct !== null ? ' (' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%)' : '') + '</div>' : '') + '</div></div>');
    h.push('<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;"><input id="pt-search" class="ptx-in" style="text-align:left;font-size:14px;" inputmode="numeric" placeholder="🔍 Search Strike Price" value="' + esc(search) + '">' +
      '<select class="ptx-in" style="font-size:14px;"><option>Expiry: ' + esc(chain && chain.expiry ? expLabelY(chain.expiry) : '--') + '</option></select></div>');
    h.push('<div class="ptx-chain" id="pt-chainbox"><div class="ptx-row ptx-hd"><div>CALL<br>OI · chg</div><div>CALL<br>LTP</div><div></div><div>PUT<br>LTP</div><div>PUT<br>OI · chg</div></div><div id="pt-rows">' + rowsHtml() + '</div></div>');
    h.push('<div style="font-size:11px;color:var(--dim);margin:6px 0 8px;">Premium ya OI dabao → order ticket. Sirf nearest weekly expiry · MARKET fill = premium ± ₹' + SLIP + ' slippage · charges band hone par kat-te hain (approx.) · naye order sirf 09:15–15:30' + (live ? '' : ' (abhi market band hai)') + '</div>');
    if (msg) h.push('<div style="font-size:12px;color:var(--amber);margin-bottom:6px;">' + esc(msg) + '</div>');
    // open trades
    h.push('<div style="font-size:12px;letter-spacing:1px;color:var(--dim);margin:6px 0 4px;">OPEN TRADES (' + st.open.length + ')' + (ps !== null && st.open.length ? ' · abhi <b style="color:' + col(ps) + ';">' + inr(ps) + '</b>' : '') + '</div>');
    if (!st.open.length) h.push('<div style="font-size:12px;color:var(--dim);">Koi open trade nahi.</div>');
    st.open.forEach(function (t) {
      var m = markOf(t, c), p = m > 0 ? trPts(t, m) : 0, r = m > 0 ? trRs(t, m) : 0, name = t.opt ? 'NIFTY ' + t.strike + ' ' + t.opt : 'INDEX', sell = t.side === 'SELL';
      h.push('<div style="border:1px solid var(--border);border-radius:8px;padding:6px 8px;margin-bottom:5px;font-size:12px;">' +
        '<div style="display:flex;justify-content:space-between;"><b style="color:' + (sell ? 'var(--red)' : 'var(--green)') + ';">' + name + ' · ' + t.side + ' ' + t.lots + ' lot @ ' + t.entry.toFixed(2) + '</b><span style="color:var(--dim);">' + hhmm(t.entryTs) + (t.product === 'CARRY' ? ' · CARRY' : '') + '</span></div>' +
        '<div style="color:var(--dim);">' + (t.opt ? 'Abhi ₹' + (m > 0 ? m.toFixed(2) : '--') + ' · ' : '') + 'SL ' + (t.sl !== null ? t.sl.toFixed(2) : '--') + ' · Target ' + (t.tg !== null ? t.tg.toFixed(2) : '--') + '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:3px;"><span style="color:' + col(r) + ';font-weight:700;">' + pts(p) + ' pts · ' + inr(r) + '</span>' +
        '<button data-pt-close="' + t.id + '" class="tg-btn" style="padding:3px 10px;font-size:12px;">Band karo</button></div></div>');
    });
    // pending orders
    var pend = st.pending || [];
    h.push('<div style="font-size:12px;letter-spacing:1px;color:var(--dim);margin:8px 0 4px;">PENDING ORDERS (' + pend.length + ')</div>');
    if (!pend.length) h.push('<div style="font-size:12px;color:var(--dim);">Koi pending order nahi.</div>');
    pend.forEach(function (p) {
      var cur = premFor(chain, p.opt, p.strike, p.expiry);
      h.push('<div style="border:1px dashed var(--border);border-radius:8px;padding:6px 8px;margin-bottom:5px;font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:6px;"><span><b style="color:' + (p.side === 'SELL' ? 'var(--red)' : 'var(--green)') + ';">' + p.side + ' ' + p.strike + ' ' + p.opt + '</b> · ' + p.lots + ' lot · ' + p.type + ' ' + p.price.toFixed(2) + ' · ' + p.validity + '<br><span style="color:var(--dim);">abhi ₹' + (cur > 0 ? cur.toFixed(2) : '--') + (p.product === 'CARRY' ? ' · Carry' : ' · Intraday') + '</span></span>' +
        '<button data-pt-cancel="' + p.id + '" class="tg-btn" style="padding:3px 10px;font-size:12px;">Cancel</button></div>');
    });
    // results
    h.push('<div style="font-size:12px;letter-spacing:1px;color:var(--dim);margin:8px 0 4px;">NATIJA (band hue ' + S.n + ' trade, charges ke baad)</div>');
    if (S.n) {
      h.push('<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:12px;text-align:center;margin-bottom:6px;">' +
        '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Net</div><b style="color:' + col(S.net) + ';">' + inr(S.net) + '</b></div>' +
        '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Jeet</div><b>' + S.winPct + '% (' + S.wins + '/' + S.n + ')</b></div>' +
        '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Profit factor</div><b>' + (S.pf === null ? '--' : S.pf.toFixed(2)) + '</b></div></div>');
      if (S.n < 20) h.push('<div style="font-size:11px;color:var(--dim);margin-bottom:6px;">⚠ ' + S.n + ' trade bahut kam hain — kam se kam 20–30 trade ke baad hi natije par bharosa karo.</div>');
      st.closed.slice(0, 8).forEach(function (t) {
        h.push('<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid var(--border);"><span>' + (t.opt ? t.side + ' ' + t.strike + ' ' + t.opt + ' ' : t.side + ' ') + t.lots + 'L ' + t.entry.toFixed(1) + '→' + t.exit.toFixed(1) + ' <span style="color:var(--dim);">' + esc(t.reason) + ' ' + hhmm(t.exitTs) + '</span></span><b style="color:' + col(t.rs) + ';">' + inr(t.rs) + '</b></div>');
      });
    } else h.push('<div style="font-size:12px;color:var(--dim);">Abhi koi band trade nahi.</div>');
    if ((st.log || []).length) {
      h.push('<div style="font-size:12px;letter-spacing:1px;color:var(--dim);margin:8px 0 4px;">ORDER LOG</div>');
      st.log.slice(0, 5).forEach(function (l) { h.push('<div style="font-size:11px;color:var(--dim);">' + hhmm(l.ts) + ' · ' + esc(l.text) + '</div>'); });
    }
    h.push('<div style="margin-top:8px;display:flex;gap:6px;align-items:center;justify-content:space-between;"><span style="display:flex;gap:4px;align-items:center;font-size:11px;color:var(--dim);">Capital ₹<input id="pt-cap" type="number" min="10000" step="10000" value="' + esc(st.capital) + '" style="width:92px;padding:3px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;"><button data-pt-cap="1" class="tg-btn" style="padding:3px 8px;font-size:11px;">Set</button></span><button data-pt-reset="1" class="tg-btn" style="padding:3px 10px;font-size:11px;opacity:.8;">' + (confirmReset ? 'Pakka? Sab mit jayega — dobara dabao' : 'Paper account reset') + '</button></div>');
    h.push('</div>');
    var old = $('pt-chainbox'), top = old ? old.scrollTop : 0;
    host.innerHTML = h.join('');
    var box = $('pt-chainbox'); if (!box) return;
    var atm = $('pt-atm');
    if (!scrolled && atm) { box.scrollTop = Math.max(0, atm.offsetTop - box.clientHeight / 2); scrolled = true; } else box.scrollTop = top;
  }
  function orderCalc() {
    var o = order, row = rowFor(o.strike), ltp = row ? (o.opt === 'CE' ? row.ce : row.pe) : null, buy = o.side === 'BUY', lot = (chain && n(chain.lot)) || LOT, lots = Math.max(0, Math.floor(n(o.lots) || 0)), qty = lots * lot;
    var spot = (chain && n(chain.spot)) || lastPrice || 0, px = o.ptype === 'MARKET' ? (ltp > 0 ? (buy ? ltp + SLIP : Math.max(0.05, ltp - SLIP)) : null) : n(o.price);
    var margin = px > 0 && qty > 0 ? (buy ? px * qty : spot * qty * MARGIN_RATE) + optCharges(px, px, qty) : 0;
    return { ltp: ltp, qty: qty, lot: lot, lots: lots, px: px, margin: margin, spot: spot, buy: buy };
  }
  function drawOrder(host) {
    var o = order, C = orderCalc(), A = account(st, ctx()), live = marketLive(lastS), buy = o.side === 'BUY', h = [], s = lastS || {};
    var exp = chain && chain.expiry ? expLabel(chain.expiry) : '';
    h.push('<div class="tool-card">');
    h.push('<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;"><div style="display:flex;align-items:center;gap:8px;min-width:0;"><button data-pt-back="1" class="tg-btn" style="padding:4px 12px;font-size:18px;">‹</button><div style="min-width:0;"><b>NIFTY</b> <span style="color:var(--dim);font-size:13px;">' + esc(exp) + ' ' + o.opt + ' ' + o.strike + '</span></div></div>' +
      '<div class="ptx-seg' + (buy ? '' : ' sell') + '" style="width:140px;"><button data-pt-oside="BUY" class="' + (buy ? 'on' : '') + '">Buy</button><button data-pt-oside="SELL" class="' + (buy ? '' : 'on') + '">Sell</button></div></div>');
    h.push('<div style="font-size:18px;font-weight:700;margin-bottom:10px;color:' + col(0) + ';">₹' + (C.ltp > 0 ? C.ltp.toFixed(2) : '--') + ' <span style="font-size:12px;color:var(--dim);font-weight:400;">live premium · Nifty ' + (C.spot > 0 ? C.spot.toFixed(2) : '--') + '</span></div>');
    h.push('<div class="ptx-seg" style="margin-bottom:10px;"><button data-pt-prod="CARRY" class="' + (o.product === 'CARRY' ? 'on' : '') + '">Carry Forward</button><button data-pt-prod="INTRADAY" class="' + (o.product === 'INTRADAY' ? 'on' : '') + '">Intraday</button></div>');
    h.push('<div class="ptx-box"><div class="ptx-lbl">QUANTITY (LOTS)</div><div style="display:flex;align-items:center;background:rgba(0,0,0,.25);border-radius:10px;"><button class="ptx-step" data-pt-step="-1">−</button><input id="pt-lots" class="ptx-in" style="border:0;background:transparent;font-size:20px;font-weight:700;" type="number" min="1" max="50" step="1" value="' + esc(o.lots) + '"><button class="ptx-step" data-pt-step="1">+</button></div><div style="font-size:12px;color:var(--dim);margin-top:6px;">1 Lot = ' + C.lot + ' Qty · total qty ' + C.qty + '</div></div>');
    h.push('<div class="ptx-box"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;"><div class="ptx-lbl" style="margin:0;">PRICE</div><div class="ptx-seg" style="flex:1;max-width:250px;"><button data-pt-ptype="LIMIT" class="' + (o.ptype === 'LIMIT' ? 'on' : '') + '">LIMIT</button><button data-pt-ptype="MARKET" class="' + (o.ptype === 'MARKET' ? 'on' : '') + '">MARKET</button><button data-pt-ptype="TRIGGER" class="' + (o.ptype === 'TRIGGER' ? 'on' : '') + '">TRIGGER</button></div></div>' +
      (o.ptype === 'MARKET' ? '<div class="ptx-in" style="color:var(--dim);font-weight:700;">AT MARKET</div>' : '<input id="pt-price" class="ptx-in" type="number" step="0.05" min="0" inputmode="decimal" placeholder="' + (o.ptype === 'LIMIT' ? 'Limit price' : 'Trigger price') + '" value="' + esc(o.price) + '">') + '</div>');
    h.push('<div class="ptx-box"><div class="ptx-lbl">SL / TARGET (optional, premium par)</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
      '<span style="display:flex;gap:3px;"><input id="pt-sl" class="ptx-in" style="font-size:14px;min-width:0;" type="number" min="0" step="any" inputmode="decimal" placeholder="SL" value="' + esc(o.sl) + '"><select id="pt-slu" class="ptx-in" style="width:52px;padding:2px;font-size:14px;"><option value="%"' + (o.slu === '%' ? ' selected' : '') + '>%</option><option value="₹"' + (o.slu === '₹' ? ' selected' : '') + '>₹</option></select></span>' +
      '<span style="display:flex;gap:3px;"><input id="pt-tg" class="ptx-in" style="font-size:14px;min-width:0;" type="number" min="0" step="any" inputmode="decimal" placeholder="Target" value="' + esc(o.tg) + '"><select id="pt-tgu" class="ptx-in" style="width:52px;padding:2px;font-size:14px;"><option value="%"' + (o.tgu === '%' ? ' selected' : '') + '>%</option><option value="₹"' + (o.tgu === '₹' ? ' selected' : '') + '>₹</option></select></span></div>' +
      (C.px > 0 ? '<div style="font-size:11px;color:var(--dim);margin-top:6px;line-height:1.5;">' + (function () {
        var sl = resolveLv({ v: o.sl, u: o.slu }, C.px, o.side, 'sl'), tg = resolveLv({ v: o.tg, u: o.tgu }, C.px, o.side, 'tg'), b = [];
        if (sl !== null) b.push('SL ₹' + sl.toFixed(2) + ' → nuksaan ≈ ' + inr2(Math.abs(C.px - sl) * C.qty));
        if (tg !== null) b.push('Target ₹' + tg.toFixed(2) + ' → faayda ≈ ' + inr2(Math.abs(tg - C.px) * C.qty));
        return b.join('<br>');
      })() + '</div>' : '') + '</div>');
    h.push('<div style="margin-bottom:6px;font-size:16px;font-weight:700;">Validity</div><div class="ptx-seg" style="width:190px;margin-bottom:10px;"><button data-pt-val="DAY" class="' + (o.validity === 'DAY' ? 'on' : '') + '">DAY</button><button data-pt-val="IOC" class="' + (o.validity === 'IOC' ? 'on' : '') + '">IOC</button></div>');
    h.push('<div class="ptx-box" style="display:flex;align-items:center;gap:10px;opacity:.55;"><input type="checkbox" disabled style="width:20px;height:20px;"><div><b>AMO (After Market Order)</b><div style="font-size:11px;color:var(--dim);">paper mein abhi nahi — order sirf 09:15–15:30 mein lagte hain</div></div></div>');
    if (msg) h.push('<div style="font-size:12px;color:var(--amber);margin-bottom:6px;">' + esc(msg) + '</div>');
    h.push('<div style="display:flex;justify-content:space-between;align-items:flex-end;margin:10px 2px 8px;"><div><div style="font-size:13px;color:var(--dim);">Required Margin <span style="color:var(--green);text-decoration:underline;">(Inc. Charges)</span></div><div style="font-size:20px;font-weight:700;">' + inr2(C.margin) + '</div></div><div style="text-align:right;"><div style="font-size:13px;color:var(--dim);">Balance</div><div style="font-size:20px;font-weight:700;">' + inr2(Math.max(0, A.free)) + '</div></div></div>');
    var ok = live && C.ltp > 0;
    h.push('<button data-pt-place="1" class="ptx-go" style="background:' + (buy ? '#12a65a' : '#e8472f') + ';' + (ok ? '' : 'opacity:.45;') + '"' + (ok ? '' : ' disabled') + '>' + (buy ? 'BUY' : 'SELL') + (o.ptype === 'MARKET' ? '' : ' · ' + o.ptype) + '</button>');
    if (!live) h.push('<div style="font-size:11px;color:var(--dim);margin-top:6px;text-align:center;">Market band hai — order 09:15–15:30 mein hi.</div>');
    h.push('</div>');
    host.innerHTML = h.join('');
  }
  function draw() {
    var host = $('pt-card'); if (!host) return;
    styleOnce();
    if (view === 'order') drawOrder(host); else drawChain(host);
  }
  function readForm() {
    var m = { lots: 'pt-lots', price: 'pt-price', sl: 'pt-sl', tg: 'pt-tg', slu: 'pt-slu', tgu: 'pt-tgu' };
    Object.keys(m).forEach(function (k) { var e = $(m[k]); if (e) order[k] = e.value; });
    var se = $('pt-search'); if (se) search = se.value;
  }
  function onClick(e) {
    try {
      var el = e.target && e.target.closest ? e.target.closest('[data-pt-pick],[data-pt-back],[data-pt-oside],[data-pt-prod],[data-pt-ptype],[data-pt-val],[data-pt-step],[data-pt-place],[data-pt-close],[data-pt-cancel],[data-pt-reset],[data-pt-cap]') : null; if (!el) return;
      readForm(); var now = Date.now(), a = function (k) { return el.getAttribute(k); }, has = function (k) { return el.hasAttribute(k); };
      if (has('data-pt-pick')) {
        var pr = a('data-pt-pick').split(':'); order.opt = pr[0] === 'PE' ? 'PE' : 'CE'; order.strike = Number(pr[1]); order.side = 'BUY'; order.ptype = 'MARKET'; order.price = ''; order.validity = 'DAY'; order.sl = ''; order.tg = ''; msg = ''; confirmReset = false;   /* every new ticket opens as Buy / Market (product and lots are remembered) */ view = 'order'; try { window.scrollTo(0, 0); } catch (x) { /* ignore */ }
      } else if (has('data-pt-back')) { view = 'chain'; msg = ''; }
      else if (has('data-pt-oside')) order.side = a('data-pt-oside') === 'SELL' ? 'SELL' : 'BUY';
      else if (has('data-pt-prod')) order.product = a('data-pt-prod') === 'CARRY' ? 'CARRY' : 'INTRADAY';
      else if (has('data-pt-ptype')) { order.ptype = a('data-pt-ptype'); if (order.ptype === 'TRIGGER' && order.validity === 'IOC') order.validity = 'DAY'; }
      else if (has('data-pt-val')) order.validity = a('data-pt-val') === 'IOC' ? 'IOC' : 'DAY';
      else if (has('data-pt-step')) { var l = Math.max(1, Math.min(50, Math.floor(n(order.lots) || 1) + Number(a('data-pt-step')))); order.lots = String(l); }
      else if (has('data-pt-place')) {
        if (!marketLive(lastS)) msg = 'Market band hai — paper trade 09:15–15:30 mein hi.';
        else {
          var r = openOption(st, { opt: order.opt, strike: order.strike, chain: chain, spot: lastPrice, lots: order.lots, side: order.side, product: order.product, type: order.ptype, price: order.price, validity: order.validity,
            slSpec: { v: order.sl, u: order.slu }, tgSpec: { v: order.tg, u: order.tgu }, lot: chain && chain.lot, expiry: chain && chain.expiry, now: now });
          if (r.ok) { save(st); msg = r.pending ? 'Order pending list mein lag gaya — premium us level par aate hi fill hoga.' : 'Order fill ho gaya.'; view = 'chain'; if (r.pending) note(st, now, order.side + ' ' + order.strike + ' ' + order.opt + ' ' + order.ptype + ' ' + order.price + ' pending'); save(st); }
          else msg = r.error;
        }
      } else if (has('data-pt-close')) {
        confirmReset = false; var id = Number(a('data-pt-close')), tr = st.open.filter(function (x) { return x.id === id; })[0], mk = tr ? markOf(tr, ctx()) : null;
        msg = mk > 0 && closeTrade(st, id, mk, now) ? '' : 'Bhav nahi mila — thodi der baad try karo'; save(st);
      } else if (has('data-pt-cancel')) { cancelPending(st, Number(a('data-pt-cancel')), now, 'haath se'); save(st); msg = ''; }
      else if (has('data-pt-cap')) { confirmReset = false; var ci = $('pt-cap'), cr = setCapital(st, ci ? ci.value : null); msg = cr.ok ? 'Capital set ho gaya.' : cr.error; if (cr.ok) save(st); }
      else if (has('data-pt-reset')) {
        if (confirmReset) { var keepCap = st.capital; st = blank(); st.capital = keepCap; save(st); confirmReset = false; msg = 'Paper account reset ho gaya.'; } else { confirmReset = true; msg = ''; }
      }
      draw();
    } catch (err) { try { console.warn('[PaperTrade]', err && err.message); } catch (_) {} }
  }
  function onChange(e) {   // unit dropdowns: save the form and redraw so SL / target lines follow
    try { var id = e.target && e.target.id; if (id === 'pt-slu' || id === 'pt-tgu') { readForm(); draw(); } } catch (err) { /* ignore */ }
  }
  function onInput(e) {    // strike search filters only the rows (keeps the keyboard / focus)
    try { if (e.target && e.target.id === 'pt-search') { search = e.target.value; var r = $('pt-rows'); if (r) r.innerHTML = rowsHtml(); } } catch (err) { /* ignore */ }
  }
  // fill pending orders, SL / target hits, expiry settle, 15:30 square-off (intraday only) and day-end clean-up. Returns true when something changed.
  function step(now) {
    var live = marketLive(lastS), changed = false, c = ctx(), today = istDay(now);
    var stale = st.open.filter(function (t) { return istDay(t.entryTs) !== today && t.product !== 'CARRY'; });   // intraday trades left from an earlier day settle at the last price seen
    if (stale.length) {
      var pg = lastS && lastS.premarketGap, pc = pg && pg.available ? n(pg.prevClose) : null, px = pc > 0 ? pc : lastPrice;
      stale.forEach(function (t) { var m = t.opt ? n(t.lastLtp) : px; if (m > 0) { closeAt(st, t, m, now, t.opt ? 'Pichhle din ka end (last bhav)' : 'Pichhle din ka end'); changed = true; } });
    }
    (st.pending || []).slice().forEach(function (p) { if (istDay(p.placedTs) !== today) { cancelPending(st, p.id, now, 'din badal gaya'); changed = true; } });
    if (live && processPending(st, c, now)) changed = true;
    if (live && onTick(st, c, now)) changed = true;
    if (settleExpired(st, c, now)) changed = true;
    if (lastLive && !live) {   // market just closed: DAY orders lapse, intraday positions square off at the last price
      if (cancelAllPending(st, now, 'din ka end')) changed = true;
      if (st.open.length && squareOffAll(st, c, now, 'Din ka end (15:30)', true)) changed = true;
    }
    lastLive = live;
    if (changed) save(st);
    return changed;
  }
  function redrawIfIdle() {
    var ae = typeof document !== 'undefined' ? document.activeElement : null;
    if (ae && ae.id && ae.id.indexOf('pt-') === 0 && ae.id !== 'pt-chainbox') return;   // do not redraw while the person is typing in a box
    draw();
  }
  function fetchChain() {
    try {
      if (fetching || typeof fetch !== 'function' || (typeof document !== 'undefined' && document.hidden)) return;
      var now = Date.now(); if (now - chainTs < (marketLive(lastS) ? 5000 : 60000) && chain) return;
      fetching = true; chainTs = now;
      fetch('/api/paper-chain', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
        fetching = false;
        if (j && j.ok && Array.isArray(j.rows)) { chain = j; try { if (st) { step(Date.now()); if (mounted) redrawIfIdle(); } } catch (e) { /* ignore */ } }
      }).catch(function () { fetching = false; });
    } catch (e) { fetching = false; }
  }
  // called with every app-state update
  function render(s) {
    try {
      var host = $('pt-card'); if (!host) return;
      if (!st) st = load();
      lastS = s || lastS;
      var p = s && n(s.nifty) > 0 ? n(s.nifty) : null;
      if (p !== null) lastPrice = p;
      step(Date.now());
      fetchChain();
      if (!mounted) { mounted = true; host.addEventListener('click', onClick); host.addEventListener('change', onChange); host.addEventListener('input', onInput); draw(); return; }
      redrawIfIdle();
    } catch (e) { try { console.warn('[PaperTrade]', e && e.message); } catch (_) {} }
  }
  var api = { processPending: processPending, cancelPending: cancelPending, cancelAllPending: cancelAllPending, settleExpired: settleExpired, openOption: openOption, optCharges: optCharges, premFor: premFor, SLIP: SLIP, account: account, setCapital: setCapital, blank: blank, openTrade: openTrade, closeTrade: closeTrade, onTick: onTick, squareOffAll: squareOffAll, stats: stats, openPnl: openPnl, trPts: trPts, marketLive: marketLive, render: render, spot: function () { return lastPrice; }, LOT: LOT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaperTrade = api;
})(typeof window !== 'undefined' ? window : this);
