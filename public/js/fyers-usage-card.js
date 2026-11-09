/* 📈 "Fyers API Usage" card for the Tools tab (9 Nov 2026) — how many Fyers data calls this app sent today vs the Fyers Standard-plan limits
 * (5 per second, 50 per minute, 5,000 per day). Reads the token-protected /api/fyers-usage (read-only counter, resets on restart/redeploy).
 * summarize() is pure (loadable in Node for tests); the DOM part never throws into the page. Nothing here touches signals, alerts or orders. */
(function (root) {
  'use strict';
  function num(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null; }
  function fmt(x) { x = num(x); return x === null ? '--' : Math.round(x).toLocaleString('en-IN'); }
  // u = /api/fyers-usage response  ->  { level: 'ok'|'warn'|'bad', pct, headline, detail, hours, notes[] }
  function summarize(u) {
    if (!u || u.ok === false || num(u.dataCallsToday) === null) return { level: 'warn', pct: 0, headline: 'Usage data nahi mila', detail: '', hours: '', notes: [] };
    var L = u.limits || { perSec: 5, perMin: 50, perDay: 5000 };
    var used = num(u.dataCallsToday), day = num(L.perDay) || 5000;
    var pct = num(u.dailyLimitUsedPct); if (pct === null) pct = Math.round(used / day * 1000) / 10;
    var left = Math.max(0, day - used), notes = [], level = 'ok';
    if (pct >= 80) level = 'warn';
    if (pct >= 95) level = 'bad';
    if ((num(u.status429Today) || 0) > 0) { level = 'bad'; notes.push('Aaj ' + u.status429Today + ' baar Fyers ne 429 (rok) diya' + (u.last429At ? ' — aakhri ' + u.last429At : '')); }
    if ((num(u.minutesOverPerMinLimit) || 0) > 0) { if (level === 'ok') level = 'warn'; notes.push('Per-minute limit ' + u.minutesOverPerMinLimit + ' minute paar hui (Fyers 3 se zyada baar par din bhar block kar deta hai)'); }
    if ((num(u.secondsOverPerSecLimit) || 0) > 0) { if (level === 'ok') level = 'warn'; notes.push('Per-second limit ' + u.secondsOverPerSecLimit + ' second paar hui'); }
    if (pct >= 80 && level !== 'bad') notes.push('Din ka ' + Math.round(pct) + '% use ho chuka — aur polling mat jodo');
    var hrs = u.dataCallsByHourIST || {}, hk = Object.keys(hrs).map(Number).sort(function (a, b) { return a - b; });
    var hours = hk.map(function (k) { return k + ':' + hrs[k]; }).join('  ');
    return {
      level: level, pct: pct,
      headline: fmt(used) + ' / ' + fmt(day) + ' calls (' + (Math.round(pct * 10) / 10) + '%) — ' + fmt(left) + ' baaki',
      detail: 'Peak ' + fmt(u.peakPerMinute) + '/min (limit ' + fmt(L.perMin) + ') · ' + fmt(u.peakPerSecond) + '/sec (limit ' + fmt(L.perSec) + ') · abhi ' + fmt(u.callsLastMinute) + '/min',
      hours: hours, notes: notes
    };
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  var last = null, mounted = false;
  function draw() {
    var host = $('fu-card'); if (!host) return;
    var s = last ? summarize(last) : { level: 'warn', pct: 0, headline: 'Check ho raha hai…', detail: '', hours: '', notes: [] };
    var col = s.level === 'ok' ? 'var(--green,#35c27a)' : s.level === 'bad' ? 'var(--red,#ff6b6b)' : 'var(--amber,#f0b429)';
    var w = Math.max(0, Math.min(100, s.pct || 0));
    host.innerHTML = '<div class="tool-card"><div class="tool-title">📈 FYERS API USAGE (aaj)</div>'
      + '<div style="font-size:13px;font-weight:600;color:' + col + '">' + esc(s.headline) + '</div>'
      + '<div style="height:8px;border-radius:4px;background:rgba(128,128,128,.25);margin:6px 0;overflow:hidden"><div style="height:100%;width:' + w + '%;background:' + col + '"></div></div>'
      + (s.detail ? '<div style="font-size:11px;color:var(--dim,#889);line-height:1.5">' + esc(s.detail) + '</div>' : '')
      + (s.hours ? '<div style="font-size:11px;color:var(--dim,#889);line-height:1.5;margin-top:4px">Ghante-wise (IST): ' + esc(s.hours) + '</div>' : '')
      + s.notes.map(function (n) { return '<div style="font-size:11px;color:' + col + ';margin-top:4px">⚠ ' + esc(n) + '</div>'; }).join('')
      + '<div style="font-size:10px;color:var(--dim,#889);margin-top:6px">Ye app ne jitna bheja uski ginti hai. Restart / redeploy par 0 se shuru hoti hai. Sirf dekhne ke liye.</div></div>';
  }
  function refresh() {
    try {
      fetch('/api/fyers-usage').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) { last = j; draw(); }).catch(function () { last = null; draw(); });
    } catch (e) {}
  }
  function render() {
    try {
      var host = $('fu-card'); if (!host || mounted) return;
      mounted = true; draw(); refresh(); setInterval(refresh, 120000);
    } catch (e) { try { console.warn('[FyersUsageCard]', e && e.message); } catch (_) {} }
  }
  var api = { summarize: summarize, render: render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.FyersUsageCard = api;
    if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render(); }
  }
})(typeof window !== 'undefined' ? window : this);