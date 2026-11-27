/* 📝 "Paper Trade" card for the Tools tab (27 Nov 2026) — virtual trades on the live Nifty index.
 * Press BUY or SELL at the live Nifty price (optional SL / target in points), watch live P&L, close by hand, or let SL / target / the
 * 15:30 close do it. Nothing here touches a broker, a signal, a gate or the Signal Journal. Trades are kept in THIS browser only
 * (localStorage), so each person on their own phone/PC has their own paper account.
 * P&L = points x lot size x lots (charges not included). The pure functions below are loadable in Node for tests;
 * the DOM part never throws into the page. */
(function (root) {
  'use strict';
  var KEY = 'vn_paper_v1', LOT = 65, MAX_CLOSED = 200, CAPITAL = 500000, MARGIN_RATE = 0.11;   // margin ~11% of index value per lot (approx. futures margin)
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
  function unreal(st, price) { var p = n(price); if (!(p > 0)) return 0; var s = 0; st.open.forEach(function (t) { s += trRs(t, p); }); return s; }
  // account view: balance = capital + closed P&L; equity adds open P&L; free = equity - margin held by open trades
  function account(st, price) {
    var cap = n(st.capital) > 0 ? Number(st.capital) : CAPITAL, bal = cap + realized(st), eq = bal + unreal(st, price), mu = marginUsed(st);
    // max drawdown on closed-trade balance, oldest -> newest
    var run = cap, peak = cap, dd = 0, ord = st.closed.slice().reverse();
    ord.forEach(function (t) { run += t.rs; if (run > peak) peak = run; var d = peak > 0 ? (peak - run) / peak : 0; if (d > dd) dd = d; });
    return { capital: cap, balance: bal, equity: eq, marginUsed: mu, free: eq - mu, maxDdPct: dd * 100 };
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
  function closeAt(st, t, price, now, reason) {
    st.open = st.open.filter(function (x) { return x.id !== t.id; });
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
    var p = n(price); if (!(p > 0)) return 0;
    var hit = 0;
    st.open.slice().forEach(function (t) {
      var buy = t.side === 'BUY';
      if (t.sl !== null && (buy ? p <= t.sl : p >= t.sl)) { closeAt(st, t, t.sl, now, 'SL laga'); hit++; }
      else if (t.tg !== null && (buy ? p >= t.tg : p <= t.tg)) { closeAt(st, t, t.tg, now, 'Target mila'); hit++; }
    });
    return hit;
  }
  function squareOffAll(st, price, now, reason) {
    var p = n(price); if (!(p > 0)) return 0;
    var c = 0; st.open.slice().forEach(function (t) { closeAt(st, t, p, now, reason || 'Din ka end'); c++; });
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
    var p = n(price); if (!(p > 0)) return null;
    var s = 0; st.open.forEach(function (t) { s += trRs(t, p); }); return s;
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
  var st = null, mounted = false, lastPrice = null, lastLive = false, lastS = null, msg = '', confirmReset = false, form = { lots: '1', sl: '', tg: '' };
  function $(id) { return typeof document !== 'undefined' ? document.getElementById(id) : null; }
  function hhmm(ts) { try { var d = new Date(ts + 19800000); return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2); } catch (e) { return ''; } }
  function col(x) { return x > 0 ? 'var(--green)' : (x < 0 ? 'var(--red)' : 'var(--dim)'); }
  function draw() {
    var host = $('pt-card'); if (!host) return;
    var live = marketLive(lastS), price = lastPrice, ps = openPnl(st, price), S = stats(st), h = [];
    h.push('<div class="tool-card"><div class="tool-title">📝 PAPER TRADE <span style="font-size:11px;color:var(--dim);font-weight:400;">virtual — asli paisa nahi</span></div>');
    h.push('<div style="font-size:12px;color:var(--dim);margin-bottom:8px;line-height:1.5;">Live Nifty par apna alag manual trade lo. Kisi broker, signal ya Signal Journal se koi link nahi. Ye record sirf isi phone/browser mein save hota hai.</div>');
    h.push('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="font-size:12px;color:var(--dim);">NIFTY ' + (live ? '🟢 LIVE' : '🌙 market band') + '</span><span style="font-family:\'Share Tech Mono\',monospace;font-size:20px;font-weight:700;">' + (price > 0 ? price.toFixed(2) : '--') + '</span></div>');
    var A = account(st, price);
    h.push('<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:12px;text-align:center;margin-bottom:8px;">' +
      '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Balance</div><b style="color:' + col(A.equity - A.capital) + ';">' + inr2(A.equity) + '</b></div>' +
      '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Free margin</div><b>' + inr2(Math.max(0, A.free)) + '</b></div>' +
      '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Max drawdown</div><b style="color:' + (A.maxDdPct > 0 ? 'var(--red)' : 'var(--dim)') + ';">' + A.maxDdPct.toFixed(1) + '%</b></div></div>');
    h.push('<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px;">' +
      '<label style="font-size:11px;color:var(--dim);">Lots<input id="pt-lots" type="number" min="1" max="50" step="1" value="' + esc(form.lots) + '" style="width:100%;padding:6px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;"></label>' +
      '<label style="font-size:11px;color:var(--dim);">SL (pts)<input id="pt-sl" type="number" min="1" step="1" placeholder="optional" value="' + esc(form.sl) + '" style="width:100%;padding:6px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;"></label>' +
      '<label style="font-size:11px;color:var(--dim);">Target (pts)<input id="pt-tg" type="number" min="1" step="1" placeholder="optional" value="' + esc(form.tg) + '" style="width:100%;padding:6px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;"></label></div>');
    var dis = live ? '' : ' disabled style="opacity:.45;"';
    h.push('<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px;">' +
      '<button data-pt-side="BUY" class="tg-btn"' + (live ? ' style="background:rgba(52,211,153,.18);border:1px solid var(--green);color:var(--green);"' : dis) + '>▲ BUY</button>' +
      '<button data-pt-side="SELL" class="tg-btn"' + (live ? ' style="background:rgba(248,113,113,.18);border:1px solid var(--red);color:var(--red);"' : dis) + '>▼ SELL</button></div>');
    h.push('<div style="font-size:11px;color:var(--dim);margin-bottom:8px;">1 lot = ' + LOT + ' qty · margin ≈ ' + Math.round(MARGIN_RATE * 100) + '% · capital ' + inr2(A.capital) + ' · P&amp;L = points × qty (charges alag) · naye trade sirf 09:15–15:30 mein' + (live ? '' : ' (abhi market band hai)') + '</div>');
    if (msg) h.push('<div style="font-size:12px;color:var(--amber);margin-bottom:6px;">' + esc(msg) + '</div>');
    // open trades
    h.push('<div style="font-size:12px;letter-spacing:1px;color:var(--dim);margin:6px 0 4px;">OPEN TRADES (' + st.open.length + ')' + (ps !== null && st.open.length ? ' · abhi <b style="color:' + col(ps) + ';">' + inr(ps) + '</b>' : '') + '</div>');
    if (!st.open.length) h.push('<div style="font-size:12px;color:var(--dim);">Koi open trade nahi.</div>');
    st.open.forEach(function (t) {
      var p = price > 0 ? trPts(t, price) : 0, r = price > 0 ? trRs(t, price) : 0;
      h.push('<div style="border:1px solid var(--border);border-radius:8px;padding:6px 8px;margin-bottom:5px;font-size:12px;">' +
        '<div style="display:flex;justify-content:space-between;"><b style="color:' + (t.side === 'BUY' ? 'var(--green)' : 'var(--red)') + ';">' + t.side + ' ' + t.lots + ' lot @ ' + t.entry.toFixed(2) + '</b><span style="color:var(--dim);">' + hhmm(t.entryTs) + '</span></div>' +
        '<div style="color:var(--dim);">SL ' + (t.sl !== null ? t.sl.toFixed(1) : '--') + ' · Target ' + (t.tg !== null ? t.tg.toFixed(1) : '--') + '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:3px;"><span style="color:' + col(r) + ';font-weight:700;">' + pts(p) + ' pts · ' + inr(r) + '</span>' +
        '<button data-pt-close="' + t.id + '" class="tg-btn" style="padding:3px 10px;font-size:12px;">Band karo</button></div></div>');
    });
    // stats
    h.push('<div style="font-size:12px;letter-spacing:1px;color:var(--dim);margin:8px 0 4px;">NATIJA (band hue ' + S.n + ' trade)</div>');
    if (S.n) {
      h.push('<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:12px;text-align:center;margin-bottom:6px;">' +
        '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Net</div><b style="color:' + col(S.net) + ';">' + inr(S.net) + '</b></div>' +
        '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Jeet</div><b>' + S.winPct + '% (' + S.wins + '/' + S.n + ')</b></div>' +
        '<div style="background:var(--bg3);border-radius:6px;padding:5px;"><div style="color:var(--dim);">Profit factor</div><b>' + (S.pf === null ? '--' : S.pf.toFixed(2)) + '</b></div></div>');
      if (S.n < 20) h.push('<div style="font-size:11px;color:var(--dim);margin-bottom:6px;">⚠ ' + S.n + ' trade bahut kam hain — kam se kam 20–30 trade ke baad hi natije par bharosa karo.</div>');
      st.closed.slice(0, 8).forEach(function (t) {
        h.push('<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid var(--border);"><span>' + t.side + ' ' + t.lots + 'L ' + t.entry.toFixed(1) + '→' + t.exit.toFixed(1) + ' <span style="color:var(--dim);">' + esc(t.reason) + ' ' + hhmm(t.exitTs) + '</span></span><b style="color:' + col(t.rs) + ';">' + inr(t.rs) + '</b></div>');
      });
    } else h.push('<div style="font-size:12px;color:var(--dim);">Abhi koi band trade nahi.</div>');
    h.push('<div style="margin-top:8px;display:flex;gap:6px;align-items:center;justify-content:space-between;"><span style="display:flex;gap:4px;align-items:center;font-size:11px;color:var(--dim);">Capital ₹<input id="pt-cap" type="number" min="10000" step="10000" value="' + esc(st.capital) + '" style="width:92px;padding:3px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;"><button data-pt-cap="1" class="tg-btn" style="padding:3px 8px;font-size:11px;">Set</button></span><button data-pt-reset="1" class="tg-btn" style="padding:3px 10px;font-size:11px;opacity:.8;">' + (confirmReset ? 'Pakka? Sab mit jayega — dobara dabao' : 'Paper account reset') + '</button></div>');
    h.push('</div>');
    host.innerHTML = h.join('');
  }
  function readForm() {
    var l = $('pt-lots'), s = $('pt-sl'), t = $('pt-tg');
    if (l) form.lots = l.value; if (s) form.sl = s.value; if (t) form.tg = t.value;
  }
  function onClick(e) {
    try {
      var el = e.target && e.target.closest ? e.target.closest('[data-pt-side],[data-pt-close],[data-pt-reset],[data-pt-cap]') : null; if (!el) return;
      readForm(); var now = Date.now();
      if (el.hasAttribute('data-pt-side')) {
        confirmReset = false;
        if (!marketLive(lastS)) { msg = 'Market band hai — paper trade 09:15–15:30 mein hi.'; }
        else {
          var r = openTrade(st, { side: el.getAttribute('data-pt-side'), price: lastPrice, lots: form.lots, slPts: form.sl, tgPts: form.tg, now: now });
          msg = r.ok ? '' : r.error; if (r.ok) save(st);
        }
      } else if (el.hasAttribute('data-pt-close')) {
        confirmReset = false; msg = closeTrade(st, Number(el.getAttribute('data-pt-close')), lastPrice, now) ? '' : 'Bhav nahi mila — thodi der baad try karo';
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
  // called with every app-state update
  function render(s) {
    try {
      var host = $('pt-card'); if (!host) return;
      if (!st) st = load();
      lastS = s || lastS;
      var p = s && n(s.nifty) > 0 ? n(s.nifty) : null, live = marketLive(s), now = Date.now(), changed = false;
      if (p !== null) lastPrice = p;
      // trades left open from an earlier day (page was closed at 15:30): settle at the real previous close
      var today = istDay(now), stale = st.open.filter(function (t) { return istDay(t.entryTs) !== today; });
      if (stale.length) {
        var pg = s && s.premarketGap, pc = pg && pg.available ? n(pg.prevClose) : null, px = pc > 0 ? pc : p;
        if (px > 0) { stale.forEach(function (t) { closeAt(st, t, px, now, 'Pichhle din ka end'); }); changed = true; }
      }
      if (live && p !== null && onTick(st, p, now)) changed = true;
      // market just closed with trades still open -> square off at the last live price
      if (lastLive && !live && st.open.length && lastPrice > 0) { squareOffAll(st, lastPrice, now, 'Din ka end (15:30)'); changed = true; }
      lastLive = live;
      if (changed) save(st);
      if (!mounted) { mounted = true; host.addEventListener('click', onClick); draw(); return; }
      // do not redraw while the person is typing in a box
      var ae = typeof document !== 'undefined' ? document.activeElement : null;
      if (ae && ae.id && ae.id.indexOf('pt-') === 0) return;
      draw();
    } catch (e) { try { console.warn('[PaperTrade]', e && e.message); } catch (_) {} }
  }
  var api = { account: account, setCapital: setCapital, blank: blank, openTrade: openTrade, closeTrade: closeTrade, onTick: onTick, squareOffAll: squareOffAll, stats: stats, openPnl: openPnl, trPts: trPts, marketLive: marketLive, render: render, LOT: LOT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaperTrade = api;
})(typeof window !== 'undefined' ? window : this);
