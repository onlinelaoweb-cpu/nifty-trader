/* 📝 "Paper Trade" card for the Tools tab (27 Nov 2026) — virtual NIFTY OPTION trades, Stoxkart-style: pick CALL/PUT and a strike from the live
 * chain (nearest weekly expiry), BUY at the live premium (+ small slippage), optional SL / target on the premium (Rs or %), watch live P&L, close by
 * hand, or let SL / target / the 15:30 close do it. Approximate charges are deducted on close. Older index-point trades still settle normally. Nothing here touches a broker, a signal, a gate or the Signal Journal. Trades are kept in THIS browser only
 * (localStorage), so each person on their own phone/PC has their own paper account.
 * P&L = points x lot size x lots (charges not included). The pure functions below are loadable in Node for tests;
 * the DOM part never throws into the page. */
(function (root) {
  'use strict';
  var KEY = 'vn_paper_v1', LOT = 65, MAX_CLOSED = 200, CAPITAL = 500000, MARGIN_RATE = 0.11, SLIP = 0.5;   // margin ~11% of index value per lot (approx. futures margin)
  function n(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function inr(x) { var a = Math.abs(Math.round(x)); return (x < 0 ? '-' : (x > 0 ? '+' : '')) + '₹' + a.toLocaleString('en-IN'); }
  function inr2(x) { return '₹' + Math.round(x).toLocaleString('en-IN'); }
  function pts(x) { return (x > 0 ? '+' : '') + x.toFixed(1); }
  function istDay(ts) { try { return new Date(ts + 19800000).toISOString().slice(0, 10); } catch (e) { return ''; } }
  function blank() { return { seq: 0, capital: CAPITAL, open: [], closed: [] }; }

  // points made by a trade if closed at `price`
  function trPts(t, price) { return t.side === 'BUY' ? price - t.entry : t.entry - price; }
  function trRs(t, price) { return trPts(t, price) * t.qty; }
  function realized(st) { var s = 0; st.closed.forEach(function (t) { s += t.rs; }); return s; }
  function marginUsed(st) { var s = 0; st.open.forEach(function (t) { s += t.margin || 0; }); return s; }
  // ctx: a number (index price, old style) or { nifty, chain }. Option trades are marked at their strike's live premium, else the last one seen.
  function asCtx(c) { return c !== null && typeof c === 'object' ? c : { nifty: n(c), chain: null }; }
  function premFor(chain, opt, k) {
    if (!chain || !Array.isArray(chain.rows)) return null;
    for (var i = 0; i < chain.rows.length; i++) { var r = chain.rows[i]; if (r.k === k) { var v = opt === 'CE' ? r.ce : r.pe; return v > 0 ? v : null; } }
    return null;
  }
  function markOf(t, c) { if (t.opt) { var v = premFor(c.chain, t.opt, t.strike); return v > 0 ? v : (n(t.lastLtp) > 0 ? n(t.lastLtp) : null); } return n(c.nifty) > 0 ? n(c.nifty) : null; }
  // approx. option-buying charges (Rs): flat Rs20 x 2 orders, STT 0.1% on sell, exchange 0.03503%, SEBI, stamp 0.003% on buy, GST 18%
  function optCharges(entry, exit, qty) {
    var b = entry * qty, sv = exit * qty, brk = 40, exch = 0.0003503 * (b + sv), sebi = 0.000001 * (b + sv);
    return brk + 0.001 * sv + exch + sebi + 0.00003 * b + 0.18 * (brk + exch + sebi);
  }
  function unreal(st, c) { c = asCtx(c); var s = 0; st.open.forEach(function (t) { var m = markOf(t, c); if (m > 0) s += trRs(t, m); }); return s; }
  function unrealIdx(st, c) { c = asCtx(c); var s = 0; st.open.forEach(function (t) { if (t.opt) return; var m = markOf(t, c); if (m > 0) s += trRs(t, m); }); return s; }
  // account view: balance = capital + closed P&L; equity adds open P&L; free = equity - margin held by open trades
  function account(st, price) {
    var cap = n(st.capital) > 0 ? Number(st.capital) : CAPITAL, bal = cap + realized(st), eq = bal + unreal(st, price), mu = marginUsed(st);   // option premium paid counts as cash used
    // max drawdown on closed-trade balance, oldest -> newest
    var run = cap, peak = cap, dd = 0, ord = st.closed.slice().reverse();
    ord.forEach(function (t) { run += t.rs; if (run > peak) peak = run; var d = peak > 0 ? (peak - run) / peak : 0; if (d > dd) dd = d; });
    return { capital: cap, balance: bal, equity: eq, marginUsed: mu, free: bal + unrealIdx(st, price) - mu, maxDdPct: dd * 100 };
  }

  // st: state; returns { ok, error? } and mutates st
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
  // BUY a NIFTY option. o: { opt:'CE'|'PE', strike, chain, lots, slPrem?, tgPrem? (absolute premium levels), now, lot?, expiry? }
  function openOption(st, o) {
    var lots = Math.floor(n(o.lots) || 0), lot = n(o.lot) || LOT, k = n(o.strike);
    if (o.opt !== 'CE' && o.opt !== 'PE') return { ok: false, error: 'CALL (CE) ya PUT (PE) chuno' };
    if (k === null) return { ok: false, error: 'Strike chuno' };
    var ltp = premFor(o.chain, o.opt, k);
    if (!(ltp > 0)) return { ok: false, error: 'Is strike ka live premium nahi mila — doosra strike chuno' };
    if (!(lots >= 1 && lots <= 50)) return { ok: false, error: 'Lots 1 se 50 ke beech rakho' };
    var fill = Math.round((ltp + SLIP) * 100) / 100, sl = n(o.slPrem), tg = n(o.tgPrem);
    if (sl !== null && !(sl > 0 && sl < fill)) return { ok: false, error: 'SL premium entry (' + fill.toFixed(2) + ') se neeche aur 0 se upar hona chahiye' };
    if (tg !== null && !(tg > fill)) return { ok: false, error: 'Target premium entry (' + fill.toFixed(2) + ') se upar hona chahiye' };
    if (st.open.length >= 10) return { ok: false, error: 'Ek saath 10 se zyada open trade nahi' };
    var cost = fill * lot * lots, acc = account(st, { nifty: n(o.chain && o.chain.spot), chain: o.chain });
    if (cost > acc.free) {
      var maxL = Math.max(0, Math.floor(acc.free / (fill * lot)));
      return { ok: false, error: 'Paisa kam hai: ' + lots + ' lot ke liye ₹' + Math.round(cost).toLocaleString('en-IN') + ' chahiye, free ₹' + Math.max(0, Math.round(acc.free)).toLocaleString('en-IN') + (maxL ? ' (max ' + maxL + ' lot)' : '') };
    }
    st.seq += 1;
    st.open.push({ id: st.seq, side: 'BUY', opt: o.opt, strike: k, expiry: o.expiry || '', entry: fill, ltp0: ltp, lastLtp: ltp, lots: lots, qty: lots * lot, margin: cost, entryTs: o.now, sl: sl, tg: tg });
    return { ok: true };
  }
  function closeAt(st, t, price, now, reason) {
    st.open = st.open.filter(function (x) { return x.id !== t.id; });
    if (t.opt) {   // option: sell slightly below the mark (slippage) and pay approximate charges
      var ex = Math.max(0.05, Math.round((price - SLIP) * 100) / 100), ch = optCharges(t.entry, ex, t.qty);
      st.closed.unshift({ id: t.id, side: t.side, opt: t.opt, strike: t.strike, entry: t.entry, exit: ex, lots: t.lots, qty: t.qty, entryTs: t.entryTs, exitTs: now, reason: reason,
        pts: ex - t.entry, charges: ch, rs: (ex - t.entry) * t.qty - ch });
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
  // live price tick: closes any trade whose SL / target was touched. Fills at the SL/target level (paper-trade simplification).
  function onTick(st, price, now) {
    var c = asCtx(price), hit = 0;
    st.open.slice().forEach(function (t) {
      var p = markOf(t, c); if (!(p > 0)) return;
      if (t.opt) t.lastLtp = p;
      var buy = t.side === 'BUY';
      if (t.sl !== null && (buy ? p <= t.sl : p >= t.sl)) { closeAt(st, t, t.sl, now, 'SL laga'); hit++; }
      else if (t.tg !== null && (buy ? p >= t.tg : p <= t.tg)) { closeAt(st, t, t.tg, now, 'Target mila'); hit++; }
    });
    return hit;
  }
  function squareOffAll(st, price, now, reason) {
    var cx = asCtx(price), c = 0;
    st.open.slice().forEach(function (t) { var p = markOf(t, cx); if (p > 0) { closeAt(st, t, p, now, reason || 'Din ka end'); c++; } });
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
    try { var raw = root.localStorage && root.localStorage.getItem(KEY); if (raw) { var o = JSON.parse(raw); if (o && Array.isArray(o.open) && Array.isArray(o.closed)) { o.seq = o.seq || 0; if (!(n(o.capital) > 0)) o.capital = CAPITAL; return o; } } } catch (e) { /* ignore */ }
    return mem || blank();
  }
  function save(st) { mem = st; try { root.localStorage && root.localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* ignore */ } }

  // ---- DOM ----
  var st = null, mounted = false, lastPrice = null, lastLive = false, lastS = null, msg = '', confirmReset = false, chain = null, chainTs = 0, fetching = false,
      form = { lots: '1', sl: '', tg: '', slu: '%', tgu: '%', opt: 'CE', strike: '' };
  function $(id) { return typeof document !== 'undefined' ? document.getElementById(id) : null; }
  function hhmm(ts) { try { var d = new Date(ts + 19800000); return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2); } catch (e) { return ''; } }
  function col(x) { return x > 0 ? 'var(--green)' : (x < 0 ? 'var(--red)' : 'var(--dim)'); }
  function ctx() { return { nifty: lastPrice, chain: chain }; }
  function expLabel(iso) { try { var d = new Date(iso + 'T00:00:00Z'); return d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]; } catch (e) { return iso || ''; } }
  // strikes shown in the dropdown: 8 either side of the one nearest spot
  function strikeRows() {
    if (!chain || !Array.isArray(chain.rows) || !chain.rows.length) return { rows: [], atm: null };
    var spot = n(chain.spot) || lastPrice || 0, bi = 0, bd = 1e9;
    chain.rows.forEach(function (r, i) { var d = Math.abs(r.k - spot); if (d < bd) { bd = d; bi = i; } });
    return { rows: chain.rows.slice(Math.max(0, bi - 8), bi + 9), atm: chain.rows[bi].k };
  }
  function slTgLevels(entry) {   // form SL / target -> absolute premium (null if blank)
    function lv(v, unit, dir) { var x = n(v); if (x === null) return null; return unit === '%' ? entry * (1 + dir * x / 100) : x; }
    return { sl: lv(form.sl, form.slu, -1), tg: lv(form.tg, form.tgu, 1) };
  }
  var FLD = 'width:100%;padding:6px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;';
  function draw() {
    var host = $('pt-card'); if (!host) return;
    var live = marketLive(lastS), price = lastPrice, c = ctx(), ps = openPnl(st, c), S = stats(st), h = [];
    h.push('<div class="tool-card"><div class="tool-title">📝 PAPER TRADE <span style="font-size:11px;color:var(--dim);font-weight:400;">virtual — asli paisa nahi</span></div>');
    h.push('<div style="font-size:12px;color:var(--dim);margin-bottom:8px;line-height:1.5;">Nifty option ka apna alag manual trade lo (strike, CALL/PUT, SL, target) — jaise broker app mein. Kisi broker, signal ya Signal Journal se koi link nahi. Ye record sirf isi phone/browser mein save hota hai.</div>');
    h.push('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="font-size:12px;color:var(--dim);">NIFTY ' + (live ? '🟢 LIVE' : '🌙 market band') + (chain && chain.expiry ? ' · expiry ' + esc(expLabel(chain.expiry)) : '') + '</span><span style="font-family:\'Share Tech Mono\',monospace;font-size:20px;font-weight:700;">' + (price > 0 ? price.toFixed(2) : '--') + '</span></div>');
    var A = account(st, c);
    h.push('<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:12px;text-align:center;margin-bottom:8px;">' +
      '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Balance</div><b style="color:' + col(A.equity - A.capital) + ';">' + inr2(A.equity) + '</b></div>' +
      '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Free cash</div><b>' + inr2(Math.max(0, A.free)) + '</b></div>' +
      '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Max drawdown</div><b style="color:' + (A.maxDdPct > 0 ? 'var(--red)' : 'var(--dim)') + ';">' + A.maxDdPct.toFixed(1) + '%</b></div></div>');
    // ---- order form ----
    var SR = strikeRows(), opt = form.opt === 'PE' ? 'PE' : 'CE', sel = n(form.strike);
    if (SR.rows.length && !SR.rows.some(function (r) { return r.k === sel; })) sel = SR.atm;
    var selRow = SR.rows.filter(function (r) { return r.k === sel; })[0], ltp = selRow ? (opt === 'CE' ? selRow.ce : selRow.pe) : null, fill = ltp > 0 ? ltp + SLIP : null;
    var lot = (chain && n(chain.lot)) || LOT, lots = Math.max(0, Math.floor(n(form.lots) || 0));
    h.push('<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">' +
      '<button data-pt-opt="CE" class="tg-btn" style="' + (opt === 'CE' ? 'background:rgba(52,211,153,.18);border:1px solid var(--green);color:var(--green);' : 'opacity:.6;') + '">CALL (CE)</button>' +
      '<button data-pt-opt="PE" class="tg-btn" style="' + (opt === 'PE' ? 'background:rgba(248,113,113,.18);border:1px solid var(--red);color:var(--red);' : 'opacity:.6;') + '">PUT (PE)</button></div>');
    if (SR.rows.length) {
      var optsH = SR.rows.map(function (r) {
        var pm = opt === 'CE' ? r.ce : r.pe, itm = opt === 'CE' ? r.k < (chain.spot || 0) : r.k > (chain.spot || 0), tag = r.k === SR.atm ? 'ATM' : (itm ? 'ITM' : 'OTM');
        return '<option value="' + r.k + '"' + (r.k === sel ? ' selected' : '') + (pm > 0 ? '' : ' disabled') + '>' + r.k + ' ' + tag + ' · ' + (pm > 0 ? '₹' + pm.toFixed(2) : 'no price') + '</option>';
      }).join('');
      h.push('<label style="font-size:11px;color:var(--dim);display:block;margin-bottom:8px;">Strike (premium abhi)<select id="pt-strike" style="' + FLD + '">' + optsH + '</select></label>');
    } else h.push('<div style="font-size:12px;color:var(--amber);margin-bottom:8px;">Option chain abhi nahi aayi — thodi der mein dobara dekho.</div>');
    h.push('<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px;">' +
      '<label style="font-size:11px;color:var(--dim);">Lots<input id="pt-lots" type="number" min="1" max="50" step="1" value="' + esc(form.lots) + '" style="' + FLD + '"></label>' +
      '<label style="font-size:11px;color:var(--dim);">SL<span style="display:flex;gap:3px;"><input id="pt-sl" type="number" min="0" step="any" placeholder="optional" value="' + esc(form.sl) + '" style="' + FLD + 'min-width:0;"><select id="pt-slu" style="' + FLD + 'width:46px;padding:2px;"><option value="%"' + (form.slu === '%' ? ' selected' : '') + '>%</option><option value="₹"' + (form.slu === '₹' ? ' selected' : '') + '>₹</option></select></span></label>' +
      '<label style="font-size:11px;color:var(--dim);">Target<span style="display:flex;gap:3px;"><input id="pt-tg" type="number" min="0" step="any" placeholder="optional" value="' + esc(form.tg) + '" style="' + FLD + 'min-width:0;"><select id="pt-tgu" style="' + FLD + 'width:46px;padding:2px;"><option value="%"' + (form.tgu === '%' ? ' selected' : '') + '>%</option><option value="₹"' + (form.tgu === '₹' ? ' selected' : '') + '>₹</option></select></span></label></div>');
    if (fill > 0 && lots >= 1) {
      var lv = slTgLevels(fill), qty = lots * lot, bits = ['Entry ≈ ₹' + fill.toFixed(2) + ' · qty ' + qty + ' · cost ≈ ' + inr2(fill * qty)];
      if (lv.sl !== null && lv.sl > 0 && lv.sl < fill) bits.push('SL ₹' + lv.sl.toFixed(2) + ' → max nuksaan ≈ ' + inr2((fill - lv.sl) * qty));
      if (lv.tg !== null && lv.tg > fill) bits.push('Target ₹' + lv.tg.toFixed(2) + ' → faayda ≈ ' + inr2((lv.tg - fill) * qty));
      h.push('<div style="font-size:11px;color:var(--dim);margin-bottom:6px;line-height:1.5;">' + bits.join('<br>') + '</div>');
    }
    var dis = live && fill > 0 ? '' : ' disabled style="opacity:.45;width:100%;"';
    h.push('<button data-pt-side="BUY" class="tg-btn"' + (live && fill > 0 ? ' style="width:100%;background:rgba(52,211,153,.18);border:1px solid var(--green);color:var(--green);"' : dis) + '>▲ BUY NIFTY ' + (sel || '') + ' ' + opt + (fill > 0 ? ' @ ₹' + fill.toFixed(2) : '') + '</button>');
    h.push('<div style="font-size:11px;color:var(--dim);margin:6px 0 8px;">Sirf BUY (CALL/PUT khareedna) · MARKET fill = live premium + ₹' + SLIP + ' slippage, exit mein bhi ₹' + SLIP + ' · 1 lot = ' + lot + ' qty · charges ~ band hone par kat-te hain (approx.) · capital ' + inr2(A.capital) + ' · naye trade sirf 09:15–15:30 mein' + (live ? '' : ' (abhi market band hai)') + ' · nearest weekly expiry hi</div>');
    if (msg) h.push('<div style="font-size:12px;color:var(--amber);margin-bottom:6px;">' + esc(msg) + '</div>');
    // open trades
    h.push('<div style="font-size:12px;letter-spacing:1px;color:var(--dim);margin:6px 0 4px;">OPEN TRADES (' + st.open.length + ')' + (ps !== null && st.open.length ? ' · abhi <b style="color:' + col(ps) + ';">' + inr(ps) + '</b>' : '') + '</div>');
    if (!st.open.length) h.push('<div style="font-size:12px;color:var(--dim);">Koi open trade nahi.</div>');
    st.open.forEach(function (t) {
      var m = markOf(t, c), p = m > 0 ? trPts(t, m) : 0, r = m > 0 ? trRs(t, m) : 0, name = t.opt ? 'NIFTY ' + t.strike + ' ' + t.opt : 'INDEX';
      h.push('<div style="border:1px solid var(--border);border-radius:8px;padding:6px 8px;margin-bottom:5px;font-size:12px;">' +
        '<div style="display:flex;justify-content:space-between;"><b style="color:' + (t.opt === 'PE' ? 'var(--red)' : (t.side === 'BUY' ? 'var(--green)' : 'var(--red)')) + ';">' + name + ' · ' + t.side + ' ' + t.lots + ' lot @ ' + t.entry.toFixed(2) + '</b><span style="color:var(--dim);">' + hhmm(t.entryTs) + '</span></div>' +
        '<div style="color:var(--dim);">' + (t.opt ? 'Abhi ₹' + (m > 0 ? m.toFixed(2) : '--') + ' · ' : '') + 'SL ' + (t.sl !== null ? t.sl.toFixed(2) : '--') + ' · Target ' + (t.tg !== null ? t.tg.toFixed(2) : '--') + '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:3px;"><span style="color:' + col(r) + ';font-weight:700;">' + pts(p) + ' pts · ' + inr(r) + '</span>' +
        '<button data-pt-close="' + t.id + '" class="tg-btn" style="padding:3px 10px;font-size:12px;">Band karo</button></div></div>');
    });
    // stats
    h.push('<div style="font-size:12px;letter-spacing:1px;color:var(--dim);margin:8px 0 4px;">NATIJA (band hue ' + S.n + ' trade, charges ke baad)</div>');
    if (S.n) {
      h.push('<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:12px;text-align:center;margin-bottom:6px;">' +
        '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Net</div><b style="color:' + col(S.net) + ';">' + inr(S.net) + '</b></div>' +
        '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Jeet</div><b>' + S.winPct + '% (' + S.wins + '/' + S.n + ')</b></div>' +
        '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Profit factor</div><b>' + (S.pf === null ? '--' : S.pf.toFixed(2)) + '</b></div></div>');
      if (S.n < 20) h.push('<div style="font-size:11px;color:var(--dim);margin-bottom:6px;">⚠ ' + S.n + ' trade bahut kam hain — kam se kam 20–30 trade ke baad hi natije par bharosa karo.</div>');
      st.closed.slice(0, 8).forEach(function (t) {
        h.push('<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid var(--border);"><span>' + (t.opt ? t.strike + ' ' + t.opt + ' ' : t.side + ' ') + t.lots + 'L ' + t.entry.toFixed(1) + '→' + t.exit.toFixed(1) + ' <span style="color:var(--dim);">' + esc(t.reason) + ' ' + hhmm(t.exitTs) + '</span></span><b style="color:' + col(t.rs) + ';">' + inr(t.rs) + '</b></div>');
      });
    } else h.push('<div style="font-size:12px;color:var(--dim);">Abhi koi band trade nahi.</div>');
    h.push('<div style="margin-top:8px;display:flex;gap:6px;align-items:center;justify-content:space-between;"><span style="display:flex;gap:4px;align-items:center;font-size:11px;color:var(--dim);">Capital ₹<input id="pt-cap" type="number" min="10000" step="10000" value="' + esc(st.capital) + '" style="width:92px;padding:3px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;"><button data-pt-cap="1" class="tg-btn" style="padding:3px 8px;font-size:11px;">Set</button></span><button data-pt-reset="1" class="tg-btn" style="padding:3px 10px;font-size:11px;opacity:.8;">' + (confirmReset ? 'Pakka? Sab mit jayega — dobara dabao' : 'Paper account reset') + '</button></div>');
    h.push('</div>');
    host.innerHTML = h.join('');
  }
  function readForm() {
    var m = { lots: 'pt-lots', sl: 'pt-sl', tg: 'pt-tg', slu: 'pt-slu', tgu: 'pt-tgu', strike: 'pt-strike' };
    Object.keys(m).forEach(function (k) { var e = $(m[k]); if (e) form[k] = e.value; });
  }
  function onClick(e) {
    try {
      var el = e.target && e.target.closest ? e.target.closest('[data-pt-side],[data-pt-opt],[data-pt-close],[data-pt-reset],[data-pt-cap]') : null; if (!el) return;
      readForm(); var now = Date.now();
      if (el.hasAttribute('data-pt-opt')) { confirmReset = false; form.opt = el.getAttribute('data-pt-opt') === 'PE' ? 'PE' : 'CE'; msg = ''; }
      else if (el.hasAttribute('data-pt-side')) {
        confirmReset = false;
        if (!marketLive(lastS)) { msg = 'Market band hai — paper trade 09:15–15:30 mein hi.'; }
        else {
          var SR = strikeRows(), sel = n(form.strike);
          if (SR.rows.length && !SR.rows.some(function (r) { return r.k === sel; })) sel = SR.atm;
          var ltp = premFor(chain, form.opt, sel), fillP = ltp > 0 ? ltp + SLIP : 0, lv = slTgLevels(fillP);
          var r = openOption(st, { opt: form.opt, strike: sel, chain: chain, lots: form.lots, slPrem: lv.sl, tgPrem: lv.tg, expiry: chain && chain.expiry, lot: chain && chain.lot, now: now });
          msg = r.ok ? '' : r.error; if (r.ok) save(st);
        }
      } else if (el.hasAttribute('data-pt-close')) {
        confirmReset = false; var id = Number(el.getAttribute('data-pt-close')), tr = st.open.filter(function (x) { return x.id === id; })[0], mk = tr ? markOf(tr, ctx()) : null;
        msg = mk > 0 && closeTrade(st, id, mk, now) ? '' : 'Bhav nahi mila — thodi der baad try karo';
        save(st);
      } else if (el.hasAttribute('data-pt-cap')) {
        confirmReset = false; var ci = $('pt-cap'), cr = setCapital(st, ci ? ci.value : null);
        msg = cr.ok ? 'Capital set ho gaya.' : cr.error; if (cr.ok) save(st);
      } else if (el.hasAttribute('data-pt-reset')) {
        if (confirmReset) { var keepCap = st.capital; st = blank(); st.capital = keepCap; save(st); confirmReset = false; msg = 'Paper account reset ho gaya.'; } else { confirmReset = true; msg = ''; }
      }
      draw();
    } catch (err) { try { console.warn('[PaperTrade]', err && err.message); } catch (_) {} }
  }
  function onChange(e) {   // strike / unit dropdowns: save the form and redraw so cost, SL and target lines follow
    try { var id = e.target && e.target.id; if (id === 'pt-strike' || id === 'pt-slu' || id === 'pt-tgu') { readForm(); draw(); } } catch (err) { /* ignore */ }
  }
  // fill SL / target hits, settle stale-day and 15:30 trades. Returns true when something changed.
  function step(now) {
    var live = marketLive(lastS), changed = false, c = ctx(), today = istDay(now);
    var stale = st.open.filter(function (t) { return istDay(t.entryTs) !== today; });
    if (stale.length) {
      var pg = lastS && lastS.premarketGap, pc = pg && pg.available ? n(pg.prevClose) : null, px = pc > 0 ? pc : lastPrice;
      stale.forEach(function (t) { var m = t.opt ? n(t.lastLtp) : px; if (m > 0) { closeAt(st, t, m, now, t.opt ? 'Pichhle din ka end (last bhav)' : 'Pichhle din ka end'); changed = true; } });
    }
    if (live && onTick(st, c, now)) changed = true;
    if (live) st.open.forEach(function (t) { if (t.opt) { var m = premFor(chain, t.opt, t.strike); if (m > 0) t.lastLtp = m; } });   // remember last premium for the 15:30 / next-day settle
    if (lastLive && !live && st.open.length && squareOffAll(st, c, now, 'Din ka end (15:30)')) changed = true;
    lastLive = live;
    if (changed) save(st);
    return changed;
  }
  function redrawIfIdle() {
    var ae = typeof document !== 'undefined' ? document.activeElement : null;
    if (ae && ae.id && ae.id.indexOf('pt-') === 0) return;   // do not redraw while the person is typing / choosing in a box
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
      if (!mounted) { mounted = true; host.addEventListener('click', onClick); host.addEventListener('change', onChange); draw(); return; }
      redrawIfIdle();
    } catch (e) { try { console.warn('[PaperTrade]', e && e.message); } catch (_) {} }
  }
  var api = { openOption: openOption, optCharges: optCharges, premFor: premFor, SLIP: SLIP, account: account, setCapital: setCapital, blank: blank, openTrade: openTrade, closeTrade: closeTrade, onTick: onTick, squareOffAll: squareOffAll, stats: stats, openPnl: openPnl, trPts: trPts, marketLive: marketLive, render: render, LOT: LOT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaperTrade = api;
})(typeof window !== 'undefined' ? window : this);
