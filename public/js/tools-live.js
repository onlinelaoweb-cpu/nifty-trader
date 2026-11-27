/* 🔴 "Asli chain" card + auto-fill for the Tools tab — display only.
 * Reads the existing read-only /api/paper-chain (already-cached server data, no extra Fyers calls) and shows REAL ITM/ATM/OTM CE & PE premiums next to the
 * Black-Scholes model numbers, the implied volatility (IV) that real ATM premium implies, and the real theta from it.
 * It also pre-fills the premium boxes (theta / sizing / SL calculators) and Nifty/DTE with live values — only while the user has not typed into them.
 * It never changes how data is fetched or shown elsewhere; every step is wrapped so a failure here cannot break the page. */
(function (root) {
  'use strict';
  var R = 0.065, LOT = 65;
  function ncdf(x) { var t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989422804014327 * Math.exp(-x * x / 2); var p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x >= 0 ? 1 - p : p; }
  function npdf(x) { return 0.3989422804014327 * Math.exp(-x * x / 2); }
  function price(S, K, T, sig, call) {
    if (!(T > 0) || !(sig > 0)) return call ? Math.max(0, S - K) : Math.max(0, K - S);
    var sq = Math.sqrt(T), d1 = (Math.log(S / K) + (R + sig * sig / 2) * T) / (sig * sq), d2 = d1 - sig * sq, disc = Math.exp(-R * T);
    return call ? S * ncdf(d1) - K * disc * ncdf(d2) : K * disc * ncdf(-d2) - S * ncdf(-d1);
  }
  function thetaDay(S, K, T, sig, call) {
    if (!(T > 0) || !(sig > 0)) return 0;
    var sq = Math.sqrt(T), d1 = (Math.log(S / K) + (R + sig * sig / 2) * T) / (sig * sq), d2 = d1 - sig * sq, disc = Math.exp(-R * T);
    return (-(S * npdf(d1) * sig) / (2 * sq) + (call ? -R * K * disc * ncdf(d2) : R * K * disc * ncdf(-d2))) / 365;
  }
  // implied volatility by bisection; null when the premium is outside what BS can produce (below intrinsic / above spot)
  function impliedVol(prem, S, K, T, call) {
    if (!(prem > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;
    var lo = 0.01, hi = 3, pl = price(S, K, T, lo, call), ph = price(S, K, T, hi, call);
    if (prem < pl - 0.01 || prem > ph + 0.01) return null;
    for (var i = 0; i < 80; i++) { var mid = (lo + hi) / 2; if (price(S, K, T, mid, call) < prem) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  // years to expiry (15:30 IST on the expiry date); expiry 'YYYY-MM-DD'
  function yearsTo(expiry, nowMs) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(expiry || ''); if (!m) return null;
    var end = Date.UTC(+m[1], +m[2] - 1, +m[3], 15, 30) - 19800000;
    return Math.max(0, end - nowMs) / 86400000 / 365;
  }
  function row(rows, k) { for (var i = 0; i < rows.length; i++) if (rows[i].k === k) return rows[i]; return null; }
  // chain = /api/paper-chain payload; vix optional (model comparison only)
  function compute(chain, nowMs, vix) {
    if (!chain || !chain.ok || !Array.isArray(chain.rows) || !(chain.spot > 0)) return null;
    var S = chain.spot, atm = chain.atm || Math.round(S / 50) * 50, T = yearsTo(chain.expiry, nowMs);
    var picks = { 'ITM CE': [atm - 100, 'ce'], 'ATM CE': [atm, 'ce'], 'OTM CE': [atm + 100, 'ce'], 'ITM PE': [atm + 100, 'pe'], 'ATM PE': [atm, 'pe'], 'OTM PE': [atm - 100, 'pe'] };
    var out = { spot: S, atm: atm, expiry: chain.expiry, dte: T == null ? null : T * 365, lines: [], iv: null, ivCe: null, ivPe: null, theta: null, source: chain.source, fetchedAt: chain.fetchedAt };
    Object.keys(picks).forEach(function (name) {
      var k = picks[name][0], side = picks[name][1], call = side === 'ce', r = row(chain.rows, k), p = r && r[side] > 0 ? r[side] : null;
      var model = (vix > 0 && T != null) ? price(S, k, T, vix / 100, call) : null;
      out.lines.push({ name: name, strike: k, real: p, model: model });
    });
    var a = row(chain.rows, atm);
    if (a && T > 0) {
      out.ivCe = a.ce > 0 ? impliedVol(a.ce, S, atm, T, true) : null;
      out.ivPe = a.pe > 0 ? impliedVol(a.pe, S, atm, T, false) : null;
      var ivs = [out.ivCe, out.ivPe].filter(function (v) { return v != null; });
      if (ivs.length) { out.iv = ivs.reduce(function (s, v) { return s + v; }, 0) / ivs.length; }
      if (out.ivCe != null) out.theta = thetaDay(S, atm, T, out.ivCe, true);
    }
    return out;
  }
  var api = { compute: compute, impliedVol: impliedVol, price: price, yearsTo: yearsTo };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.ToolsLive = api;

  // ───────────── DOM (browser only) ─────────────
  var touched = {}, last = null, timer = null, busy = false, lastAt = 0;
  var AUTO = ['th-premium', 'ps-entry', 'sl-premium', 'calc-nifty', 'calc-vix', 'calc-dte', 'th-dte', 'sl-vix'];
  function el(id) { return document.getElementById(id); }
  function visible() { var p = el('panel-tools'); return !!p && p.offsetParent !== null && !document.hidden; }
  function vixNow() { try { if (typeof _lastState !== 'undefined' && _lastState && _lastState.vix > 0) return _lastState.vix; } catch (e) {} return null; }
  function setAuto(id, v) { var e = el(id); if (!e || touched[id] || v == null || !isFinite(v)) return; var s = String(v); if (e.value !== s) e.value = s; }
  function fmt(x, d) { return x == null ? '--' : '₹' + x.toFixed(d == null ? 1 : d); }
  function render(c) {
    var host = el('tl-card'); if (!host) return;
    if (!c) { host.innerHTML = ''; return; }
    var vix = vixNow(), age = c.fetchedAt ? Math.max(0, Math.round((Date.now() - c.fetchedAt) / 1000)) : null;
    var rows = c.lines.map(function (l) {
      var diff = (l.real != null && l.model != null) ? l.real - l.model : null;
      return '<div class="res-card"><div class="res-label">' + l.name + ' ' + l.strike + '</div><div class="res-val">' + fmt(l.real) + '</div><div class="res-sub">model ' + fmt(l.model, 0) + (diff != null ? ' · ' + (diff >= 0 ? '+' : '') + diff.toFixed(0) : '') + '</div></div>';
    }).join('');
    var ivTxt = c.iv != null ? (c.iv * 100).toFixed(1) + '%' : '--';
    var th = c.theta != null ? c.theta : null;
    host.innerHTML = '<div class="tool-card"><div class="tool-title">🔴 ASLI CHAIN (LIVE)</div>' +
      '<div class="tool-note" style="margin:0 0 8px">Nifty ' + Math.round(c.spot) + ' · ATM ' + c.atm + ' · expiry ' + (c.expiry || '--') + (c.dte != null ? ' (' + c.dte.toFixed(1) + ' din)' : '') + ' · ' + (c.source || 'chain') + (age != null ? ' · ' + age + 's pehle' : '') + '</div>' +
      '<div class="result-grid-3">' + rows + '</div>' +
      '<div class="result-grid-3" style="margin-top:8px">' +
      '<div class="res-card"><div class="res-label">ATM IV (asli)</div><div class="res-val" style="color:var(--blue)">' + ivTxt + '</div><div class="res-sub">' + (vix ? 'VIX ' + vix.toFixed(1) : 'premium se nikla') + '</div></div>' +
      '<div class="res-card"><div class="res-label">ASLI THETA/DIN</div><div class="res-val" style="color:var(--red)">' + (th != null ? '-' + Math.abs(th).toFixed(2) : '--') + '</div><div class="res-sub">' + (th != null ? '₹' + Math.abs(th * LOT).toFixed(0) + ' / lot' : 'ATM CE') + '</div></div>' +
      '<div class="res-card"><div class="res-label">PREMIUM</div><div class="res-val" style="color:var(--amber)">' + fmt(c.lines[1].real, 1) + '</div><div class="res-sub">calculators mein auto-fill</div></div></div>' +
      '<div class="tool-note">Asli premium = option chain ka last price. "model" = Black-Scholes jo VIX se bana (sirf andaaza). Theta yahan asli ATM premium se nikli IV par based hai — neeche wale Theta tracker ka thumb-rule iska andaaza hai. Sirf display.</div></div>';
  }
  function apply(c) {
    if (!c) return;
    var atmCe = c.lines[1].real;
    setAuto('calc-nifty', Math.round(c.spot));
    var v = vixNow(); if (v) { setAuto('calc-vix', v.toFixed(2)); setAuto('sl-vix', v.toFixed(2)); }
    if (c.dte != null) { var d = Math.max(0, Math.round(c.dte)); setAuto('calc-dte', d); setAuto('th-dte', d); }
    if (atmCe != null) { var p = Math.round(atmCe); setAuto('th-premium', p); setAuto('ps-entry', p); setAuto('sl-premium', p); }
    try { if (typeof autoATM === 'function') autoATM(); } catch (e) {}
    ['calcTheta', 'calcPositionSize', 'calcSL'].forEach(function (f) { try { if (typeof root[f] === 'function') root[f](); } catch (e) {} });
  }
  function tick(force) {
    if (busy || !visible()) return;
    if (force !== true && Date.now() - lastAt < 14000) return;
    busy = true; lastAt = Date.now();
    fetch('/api/paper-chain', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      last = compute(j, Date.now(), vixNow()); render(last); apply(last);
    }).catch(function () {}).then(function () { busy = false; });
  }
  function init() {
    AUTO.forEach(function (id) { var e = el(id); if (e) e.addEventListener('input', function (ev) { if (ev.isTrusted) touched[id] = true; }); });
    if (!el('tl-card')) { var tp = el('tp-card'); if (tp && tp.parentNode) { var d = document.createElement('div'); d.id = 'tl-card'; tp.parentNode.insertBefore(d, tp); } }
    tick(true); timer = setInterval(tick, 3000);   // cheap visibility check every 3 s; a real fetch only every ~15 s while the Tools tab is open
    document.addEventListener('visibilitychange', function () { tick(); });
    document.addEventListener('click', function () { setTimeout(tick, 400); }, true);   // tab switch -> refresh at once
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : this);
