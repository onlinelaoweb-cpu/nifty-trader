/* ✅ "Go-Live Checklist" card for the Tools tab — display only (13 Oct 2026).
 * Content comes from the token-protected /api/go-live-checklist route (never a public static file). Ticks are saved in this
 * browser only (localStorage, wrapped in try/catch). Nothing here touches signals, journal or orders.
 * summarize() / fmt() are pure (loadable in Node for tests); the DOM part never throws into the page. */
(function (root) {
  'use strict';
  var KEY = 'vn_golive_ticks_v1';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // escape first, then turn `code` spans into <code>
  function fmt(s) { return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>'); }
  // ticks: { 'g1:0': true, ... }  ->  per-gate and total counts
  function summarize(data, ticks) {
    ticks = ticks || {};
    var out = { total: 0, done: 0, gates: [] };
    ((data && data.gates) || []).forEach(function (g) {
      var n = (g.items || []).length, d = 0;
      for (var i = 0; i < n; i++) if (ticks[g.id + ':' + i]) d++;
      out.gates.push({ id: g.id, total: n, done: d, complete: n > 0 && d === n });
      out.total += n; out.done += d;
    });
    out.gatesComplete = out.gates.filter(function (g) { return g.complete; }).length;
    out.live = out.gates.length > 0 && out.gatesComplete === out.gates.length;
    return out;
  }

  var data = null, ticks = {}, loading = false, failed = false, mounted = false, openGate = null;
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(ticks)); } catch (e) {} }
  function $(id) { return document.getElementById(id); }
  function injectCss() {
    if ($('gl-css')) return;
    var st = document.createElement('style'); st.id = 'gl-css';
    st.textContent = '#gl-card .gl-bar{height:6px;background:var(--border,#223);border-radius:4px;overflow:hidden;margin:6px 0 8px}#gl-card .gl-bar i{display:block;height:100%;background:var(--green,#2ecc71)}'
      + '#gl-card .gl-g{border:1px solid var(--border,#223);border-radius:8px;margin-bottom:6px}#gl-card .gl-h{display:flex;justify-content:space-between;gap:8px;padding:9px 10px;cursor:pointer;font-size:13px}'
      + '#gl-card .gl-h b{font-weight:700}#gl-card .gl-b{padding:0 10px 8px;font-size:12px;line-height:1.5}#gl-card .gl-n{color:var(--dim,#889);margin:2px 0 6px}'
      + '#gl-card label{display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-top:1px solid var(--border,#223);cursor:pointer}#gl-card label input{margin-top:3px}'
      + '#gl-card label.on span{color:var(--dim,#889);text-decoration:line-through}#gl-card code{background:rgba(127,127,127,.18);padding:0 4px;border-radius:3px}'
      + '#gl-card .gl-v{font-size:13px;font-weight:700;margin-top:4px}';
    document.head.appendChild(st);
  }
  function draw() {
    var host = $('gl-card'); if (!host) return;
    if (failed) { host.innerHTML = '<div class="tool-card"><div class="tool-title">✅ GO-LIVE CHECKLIST</div><div class="gl-n" style="font-size:12px">Abhi load nahi hua (login/token check karo), thodi der baad phir try karo.</div></div>'; return; }
    if (!data) { host.innerHTML = '<div class="tool-card"><div class="tool-title">✅ GO-LIVE CHECKLIST</div><div style="font-size:12px;color:var(--dim)">Loading…</div></div>'; return; }
    var sm = summarize(data, ticks), pct = sm.total ? Math.round(sm.done * 100 / sm.total) : 0;
    var h = '<div class="tool-card"><div class="tool-title">✅ GO-LIVE CHECKLIST</div>'
      + '<div style="font-size:12px;line-height:1.5">' + fmt(data.intro) + '</div>'
      + '<div class="gl-bar"><i style="width:' + pct + '%"></i></div>'
      + '<div class="gl-v" style="color:' + (sm.live ? 'var(--green)' : 'var(--amber)') + '">' + sm.done + '/' + sm.total + ' tick · ' + sm.gatesComplete + '/' + sm.gates.length + ' gates poore · '
      + (sm.live ? 'Paanchon gates poore: ab bhi pehle 1-lot pilot, seedha size nahi.' : 'LIVE NAHI — paper trading hi.') + '</div><div style="height:8px"></div>';
    data.gates.forEach(function (g, gi) {
      var s = sm.gates[gi], open = openGate === g.id;
      h += '<div class="gl-g"><div class="gl-h" data-gl-open="' + esc(g.id) + '"><b>' + (s.complete ? '✅ ' : '⬜ ') + esc(g.title) + '</b><span style="color:var(--dim)">' + s.done + '/' + s.total + (open ? ' ▲' : ' ▼') + '</span></div>';
      if (open) {
        h += '<div class="gl-b"><div class="gl-n">' + fmt(g.note) + '</div>';
        g.items.forEach(function (t, i) { var k = g.id + ':' + i, on = !!ticks[k]; h += '<label class="' + (on ? 'on' : '') + '"><input type="checkbox" data-gl-k="' + esc(k) + '"' + (on ? ' checked' : '') + '><span>' + fmt(t) + '</span></label>'; });
        h += '</div>';
      }
      h += '</div>';
    });
    h += '<div class="gl-n" style="font-size:11px;margin-top:6px">' + fmt(data.disclaimer) + ' Ticks sirf is browser mein save hote hain.</div></div>';
    host.innerHTML = h;
  }
  function onClick(e) {
    try {
      var t = e.target, o = t.closest && t.closest('[data-gl-open]');
      if (o) { var id = o.getAttribute('data-gl-open'); openGate = openGate === id ? null : id; draw(); return; }
      var k = t.getAttribute && t.getAttribute('data-gl-k');
      if (k) { if (t.checked) ticks[k] = true; else delete ticks[k]; save(); draw(); }
    } catch (err) { try { console.warn('[GoLive]', err && err.message); } catch (_) {} }
  }
  function fetchData() {
    if (loading || data) return; loading = true;
    fetch('/api/go-live-checklist').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { data = j; failed = false; loading = false; draw(); })
      .catch(function () { failed = true; loading = false; draw(); });
  }
  // called on every tick by the page; does real work only once
  function render() {
    try {
      var host = $('gl-card'); if (!host || mounted) return;
      mounted = true; ticks = load(); injectCss(); host.addEventListener('click', onClick); draw(); fetchData();
    } catch (e) { try { console.warn('[GoLive]', e && e.message); } catch (_) {} }
  }
  var api = { summarize: summarize, fmt: fmt, render: render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GoLive = api;
})(typeof window !== 'undefined' ? window : this);