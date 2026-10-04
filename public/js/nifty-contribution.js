/* ⚖️ "Nifty kaun chala raha hai" card — display only (3 Oct).
 * Reads /api/nifty-contribution (official NSE top-10 + sector weights × live % moves).
 * Self-contained: injects its own CSS, uses only the app's CSS variables (so the day/night
 * theme works), refreshes every 60 s ONLY while the card is on screen, and never throws into
 * the rest of the page. Mount point: <div id="nc-card"></div> in index.html. */
(function () {
  'use strict';
  var REFRESH_MS = 60000, CHECK_MS = 15000;
  var lastFetch = 0, busy = false, timer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function pct(v, d) { return isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(d == null ? 2 : d) + '%' : '—'; }
  function pts(v) {
    if (!isNum(v)) return '—';
    var a = Math.abs(v), t = a >= 10 ? Math.round(v) : v.toFixed(1);
    return (v > 0 ? '+' : '') + t + ' pts';
  }
  function col(v) { return !isNum(v) || Math.abs(v) < 0.005 ? 'var(--dim)' : v > 0 ? 'var(--green)' : 'var(--red)'; }

  function injectCss() {
    if (document.getElementById('nc-style')) return;
    var st = document.createElement('style');
    st.id = 'nc-style';
    st.textContent =
      '.nc-card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:8px;}' +
      '.nc-head{display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:4px;}' +
      '.nc-title{font-family:Orbitron,monospace;font-size:12px;color:var(--amber);letter-spacing:2px;}' +
      '.nc-tag{font-size:9px;letter-spacing:1px;padding:2px 6px;border-radius:8px;border:1px solid var(--border);color:var(--dim);white-space:nowrap;}' +
      '.nc-sub{font-size:10px;color:var(--dim);margin-bottom:6px;line-height:1.4;}' +
      '.nc-warn{font-size:10px;color:var(--amber);border:1px solid var(--amber);border-radius:6px;padding:4px 6px;margin-bottom:6px;}' +
      '.nc-verdict{font-size:11px;color:var(--text);background:var(--bg3);border-radius:6px;padding:6px 8px;margin-bottom:6px;line-height:1.4;}' +
      '.nc-row{display:grid;grid-template-columns:1.25fr .7fr .8fr .9fr;gap:4px;align-items:center;font-size:11px;padding:3px 0;border-bottom:1px solid var(--border);}' +
      '.nc-row:last-child{border-bottom:none;}' +
      '.nc-name{color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.nc-w{color:var(--dim);text-align:right;font-size:10px;}' +
      '.nc-pc,.nc-pt{text-align:right;font-variant-numeric:tabular-nums;}' +
      '.nc-bar{grid-column:1 / -1;height:3px;border-radius:2px;background:var(--bg3);margin-top:-1px;}' +
      '.nc-bar>i{display:block;height:3px;border-radius:2px;}' +
      '.nc-rest{background:var(--bg3);border-radius:6px;padding:4px 6px;margin-top:4px;border:1px dashed var(--border);}' +
      '.nc-tot{display:flex;justify-content:space-between;font-size:11px;margin-top:6px;color:var(--text);}' +
      '.nc-sech{font-size:10px;color:var(--dim);letter-spacing:1px;margin:8px 0 3px;}' +
      '.nc-sec{display:grid;grid-template-columns:1.6fr .6fr .8fr .8fr;gap:4px;font-size:10px;padding:2px 0;}' +
      '.nc-foot{font-size:9px;color:var(--dim);margin-top:6px;line-height:1.4;}';
    document.head.appendChild(st);
  }

  function verdictText(v) {
    if (!v) return 'Data abhi poora nahi — quotes ya Nifty number missing.';
    var t = isNum(v.topAvgMove) ? pct(v.topAvgMove) : '—', r = isNum(v.restImpliedMove) ? '≈ ' + pct(v.restImpliedMove) : '—';
    if (v.kind === 'BROAD') return '✅ Move broad hai — top-10 (' + t + ') aur baaki 40 (' + r + ') dono ek hi taraf.';
    if (v.kind === 'DIVERGENT') return '⚠️ Move narrow/divergent — top-10 ek taraf (' + t + '), baaki 40 dusri taraf (' + r + '). Sirf heavyweights par bharosa mat karo.';
    if (v.kind === 'FLAT') return '➖ Dono baskets lagbhag flat (' + t + ' / ' + r + ').';
    if (v.kind === 'ONE_SIDED') return '↔️ Ek basket flat, doosra move kar raha hai (top-10 ' + t + ' / baaki 40 ' + r + ').';
    return 'Data abhi poora nahi — quotes ya Nifty number missing.';
  }

  function render(d) {
    var el = document.getElementById('nc-card');
    if (!el) return;
    injectCss();
    var rows = Array.isArray(d.top10) ? d.top10 : [];
    var maxAbs = 0;
    rows.forEach(function (r) { if (isNum(r.pts) && Math.abs(r.pts) > maxAbs) maxAbs = Math.abs(r.pts); });
    if (d.rest && isNum(d.rest.pts) && Math.abs(d.rest.pts) > maxAbs) maxAbs = Math.abs(d.rest.pts);

    var h = '<div class="nc-card">';
    h += '<div class="nc-head"><div class="nc-title">⚖️ NIFTY KAUN CHALA RAHA HAI</div>' +
         '<div class="nc-tag">' + (d.marketClosed ? 'LAST SESSION' : 'LIVE') + '</div></div>';
    var topW = d.topSummary && isNum(d.topSummary.weight) ? d.topSummary.weight : null;
    h += '<div class="nc-sub">Top-10 stocks' + (topW !== null ? ' = ' + topW.toFixed(1) + '% of Nifty' : '') +
         ' · official NSE weights (' + esc(d.asOf) + ')</div>';
    if (d.stale) h += '<div class="nc-warn">⚠️ Weights ' + esc(d.ageDays) + ' din purane hain — NSE factsheet se <b>niftyWeights.js</b> update karo.</div>';
    if (d.quoteSource === 'none') h += '<div class="nc-warn">Stock quotes abhi nahi mil rahe — thodi der baad try karo.</div>';
    h += '<div class="nc-verdict">' + esc(verdictText(d.verdict)) + '</div>';

    rows.forEach(function (r) {
      var w = maxAbs > 0 && isNum(r.pts) ? Math.min(100, Math.round(Math.abs(r.pts) / maxAbs * 100)) : 0;
      h += '<div class="nc-row">' +
           '<div class="nc-name">' + esc(r.name) + '</div>' +
           '<div class="nc-w">' + (isNum(r.weight) ? r.weight.toFixed(1) + '%' : '') + '</div>' +
           '<div class="nc-pc" style="color:' + col(r.changePct) + ';">' + (r.hasQuote ? pct(r.changePct) : 'n/a') + '</div>' +
           '<div class="nc-pt" style="color:' + col(r.pts) + ';font-weight:700;">' + (r.hasQuote ? pts(r.pts) : '—') + '</div>' +
           '<div class="nc-bar"><i style="width:' + w + '%;background:' + col(r.pts) + ';"></i></div></div>';
    });

    if (d.rest) {
      var rw = maxAbs > 0 && isNum(d.rest.pts) ? Math.min(100, Math.round(Math.abs(d.rest.pts) / maxAbs * 100)) : 0;
      h += '<div class="nc-rest"><div class="nc-row">' +
           '<div class="nc-name">Baaki ' + (d.rest.partial ? '(40 + n/a)' : '40') + ' <span style="color:var(--dim);">· derived</span></div>' +
           '<div class="nc-w">' + (isNum(d.rest.weight) ? d.rest.weight.toFixed(1) + '%' : '') + '</div>' +
           '<div class="nc-pc" style="color:' + col(d.rest.impliedMovePct) + ';">' + (isNum(d.rest.impliedMovePct) ? '≈ ' + pct(d.rest.impliedMovePct) : '—') + '</div>' +
           '<div class="nc-pt" style="color:' + col(d.rest.pts) + ';font-weight:700;">' + pts(d.rest.pts) + '</div>' +
           '<div class="nc-bar"><i style="width:' + rw + '%;background:' + col(d.rest.pts) + ';"></i></div></div></div>';
    }

    var n = d.nifty || {};
    h += '<div class="nc-tot"><span>Nifty total' + (n.source === 'yahoo' || n.source === 'app' ? ' <span style="color:var(--dim);font-size:9px;">(' + esc(n.source) + ')</span>' : '') + '</span>' +
         '<span style="color:' + col(n.change) + ';font-weight:700;">' + pts(n.change) + ' (' + pct(n.changePct) + ')</span></div>';
    if (n.source === 'none') {
      h += '<div class="nc-sub" style="margin-top:4px;">Nifty ka move abhi bharosemand nahi mila, isliye "Baaki 40" aur verdict band hain (sirf top-10 ka asar upar dikh raha hai).</div>';
    }
    if (d.top3 && isNum(d.top3.sharePct)) {
      h += '<div class="nc-sub" style="margin-top:4px;">Top-' + d.top3.names.length + ' ' + (d.top3.kind === 'lifters' ? 'lifters' : 'draggers') +
           ' (' + d.top3.names.map(esc).join(', ') + ') = ' + d.top3.sharePct + '% of net move (' + pts(d.top3.pts) + ')</div>';
    }

    var secs = Array.isArray(d.sectors) ? d.sectors : [];
    if (secs.length) {
      h += '<div class="nc-sech">SECTOR WEIGHTS (official) · live move jahan app mein sector index hai</div>';
      secs.forEach(function (s) {
        var live = isNum(s.indexChangePct);
        h += '<div class="nc-sec" title="' + esc(s.proxy || '') + '">' +
             '<div style="color:var(--text);">' + esc(s.name) + (s.proxy ? ' *' : '') + '</div>' +
             '<div style="text-align:right;color:var(--dim);">' + s.weight.toFixed(1) + '%</div>' +
             '<div style="text-align:right;color:' + col(s.indexChangePct) + ';">' + (live ? pct(s.indexChangePct) : '') + '</div>' +
             '<div style="text-align:right;color:' + col(s.pts) + ';">' + (live ? '~' + pts(s.pts) : '') + '</div></div>';
      });
    }
    h += '<div class="nc-foot">Asar = weight × % move. "Baaki 40" = Nifty ka asli move − top-10 (andaza, quotes thode late ho sakte hain). ' +
         '* sector index NSE ke sector se poora match nahi karta, isliye ~. Sirf dekhne ke liye — signals par koi asar nahi. ' +
         'Source: ' + esc(d.source) + ' · quotes: ' + esc(d.quoteSource) + '.</div>';
    h += '</div>';
    el.innerHTML = h;
  }

  function renderError(msg) {
    var el = document.getElementById('nc-card');
    if (!el) return;
    injectCss();
    if (el.getAttribute('data-ok') === '1') return; // keep the last good card instead of blanking it
    el.innerHTML = '<div class="nc-card"><div class="nc-head"><div class="nc-title">⚖️ NIFTY KAUN CHALA RAHA HAI</div></div>' +
                   '<div class="nc-sub">Data abhi load nahi hua (' + esc(msg) + '). Thodi der mein dobara try hoga.</div></div>';
  }

  function load() {
    if (busy) return Promise.resolve();
    busy = true; lastFetch = Date.now();
    var tok = '';
    try { tok = localStorage.getItem('vn_token') || ''; } catch (e) { /* private mode */ }
    return fetch('/api/nifty-contribution', { headers: tok ? { 'x-app-token': tok } : {} })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        if (!d || !d.success) throw new Error((d && d.error) || 'no data');
        render(d);
        var el = document.getElementById('nc-card'); if (el) el.setAttribute('data-ok', '1');
      })
      .catch(function (e) { renderError(e && e.message ? e.message : 'error'); })
      .then(function () { busy = false; }, function () { busy = false; });
  }

  function visible() {
    var el = document.getElementById('nc-card');
    return !!el && el.offsetParent !== null && !document.hidden;
  }
  function tick() { if (visible() && Date.now() - lastFetch >= REFRESH_MS) load(); }

  function start() {
    var el = document.getElementById('nc-card');
    if (timer || !el) return;
    injectCss();
    if (!el.innerHTML.trim()) {
      el.innerHTML = '<div class="nc-card"><div class="nc-head"><div class="nc-title">⚖️ NIFTY KAUN CHALA RAHA HAI</div></div>' +
                     '<div class="nc-sub">Load ho raha hai…</div></div>';
    }
    setTimeout(function () { if (visible()) load(); }, 1500);
    timer = setInterval(tick, CHECK_MS);
    // The card sits inside a tab that is hidden until opened: when it scrolls/tabs into view, load
    // right away instead of waiting for the next 15 s check.
    if ('IntersectionObserver' in window) {
      try {
        new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting && Date.now() - lastFetch >= REFRESH_MS) { load(); break; }
          }
        }).observe(el);
      } catch (e) { /* older browsers: the 15 s check still covers it */ }
    }
  }
  window.NiftyContribution = { refresh: load, _render: render, _start: start };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();