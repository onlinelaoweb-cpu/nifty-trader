/* 🔑 "Fyers Login" card for the Tools tab (17 Oct 2026) — shows today's Fyers token status and opens the in-app mobile login page.
 * The page itself is /api/fyers-login/page (server side exchanges the auth_code; no secret is ever typed or shown here).
 * statusLine() is pure (loadable in Node for tests); the DOM part never throws into the page. Nothing here touches signals or orders. */
(function (root) {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // s = /api/fyers-login/status .status  ->  { text, level: 'ok' | 'bad' | 'warn' }
  function statusLine(s) {
    if (!s) return { text: 'Status nahi mila', level: 'warn' };
    if (s.configured === false) return { text: 'FYERS_APP_ID / FYERS_SECRET_ID Railway mein set nahi hain', level: 'bad' };
    if (!s.hasToken) return { text: 'Token nahi hai — neeche se banao', level: 'bad' };
    if (s.valid === null || s.valid === undefined) return { text: 'Token hai (expiry padh nahi paaye)', level: 'warn' };
    if (!s.valid) return { text: 'Token expire ho chuka (' + esc(s.expiresAt) + ') — naya banao', level: 'bad' };
    var m = s.minutesLeft, left = m >= 120 ? Math.floor(m / 60) + ' ghante' : m + ' min';
    return { text: 'Token valid — ' + esc(s.expiresAt) + ' tak (' + left + ' baaki)', level: m < 120 ? 'warn' : 'ok' };
  }
  function $(id) { return document.getElementById(id); }
  function token() { try { return root._appToken || localStorage.getItem('vn_token') || ''; } catch (e) { return ''; } }
  var last = null, mounted = false;
  function draw() {
    var host = $('fy-card'); if (!host) return;
    var st = last ? statusLine(last) : { text: 'Check ho raha hai…', level: 'warn' };
    var col = st.level === 'ok' ? 'var(--green,#35c27a)' : st.level === 'bad' ? 'var(--red,#ff6b6b)' : 'var(--amber,#f0b429)';
    host.innerHTML = '<div class="tool-card"><div class="tool-title">🔑 FYERS LOGIN (roz subah)</div>'
      + '<div style="font-size:12px;line-height:1.5;color:' + col + '">' + st.text + '</div>'
      + '<div style="font-size:11px;color:var(--dim,#889);margin:4px 0 8px">Token roz ~6 baje expire hota hai. 9:15 se pehle naya banao — phone se bhi.</div>'
      + '<button type="button" data-fy-open="1" style="width:100%;padding:12px;border:0;border-radius:8px;background:var(--blue,#4c8dff);color:#fff;font-size:14px;cursor:pointer">Fyers login page kholo</button></div>';
  }
  function refresh() {
    try {
      fetch('/api/fyers-login/status').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) { last = j && j.status; draw(); }).catch(function () { last = null; draw(); });
    } catch (e) {}
  }
  function onClick(e) {
    try {
      var b = e.target && e.target.closest && e.target.closest('[data-fy-open]');
      if (!b) return;
      var t = token();
      window.open('/api/fyers-login/page' + (t ? '?key=' + encodeURIComponent(t) : ''), '_blank');
    } catch (err) { try { console.warn('[FyersCard]', err && err.message); } catch (_) {} }
  }
  // called once on load; refreshes every 2 minutes while the page is open
  function render() {
    try {
      var host = $('fy-card'); if (!host || mounted) return;
      mounted = true; host.addEventListener('click', onClick); draw(); refresh(); setInterval(refresh, 120000);
    } catch (e) { try { console.warn('[FyersCard]', e && e.message); } catch (_) {} }
  }
  var api = { statusLine: statusLine, render: render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.FyersCard = api;
    if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render(); }
  }
})(typeof window !== 'undefined' ? window : this);