/* 🔥 "Scanner Pulse" card — display only (12 Oct).
 * One plain-language read of the Volume Scanner list: how many heavy-volume stocks are rising vs falling, breakouts / breakdowns,
 * which stocks are bursting right now, and whether one sector is clustering. Tap a tile to filter the table below to just those stocks.
 * It only RE-READS /api/volume-scanner rows (name, ltp, pctChange, ratio, burstRatio, priceContext, sector). It never changes a signal or a trade.
 * Mount point: <div id="sp-card"></div> above the scanner table. Reuses the Pulse card styles of index.html.
 * compute() / filterRows() are pure (also loadable in Node for tests); render() / apply() touch the DOM and never throw into the page. */
(function (root) {
  'use strict';
  function n(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var MOVE = 0.3;     // % change beyond which a heavy-volume stock counts as clearly up / down
  var BURST = 3;      // 10-minute burst ratio treated as "bursting now"

  var FILTERS = {
    up:        function (r) { return n(r.pctChange) !== null && r.pctChange > MOVE; },
    down:      function (r) { return n(r.pctChange) !== null && r.pctChange < -MOVE; },
    breakout:  function (r) { return r.priceContext === '20d high breakout'; },
    breakdown: function (r) { return r.priceContext === '20d low breakdown'; },
    burst:     function (r) { return n(r.burstRatio) !== null && r.burstRatio >= BURST; },
  };
  function cleanRows(rows) { return (Array.isArray(rows) ? rows : []).filter(function (r) { return r && r.name; }); }
  function filterRows(rows, key) { rows = cleanRows(rows); return key && FILTERS[key] ? rows.filter(FILTERS[key]) : rows; }

  // Pure: scanner rows -> { total, verdict, cls, tiles[], chips[], lines[], counts{} }
  function compute(rows) {
    rows = cleanRows(rows);
    var tiles = [], chips = [], lines = [], total = rows.length;
    var cnt = {}; Object.keys(FILTERS).forEach(function (k) { cnt[k] = rows.filter(FILTERS[k]).length; });
    var tile = function (key, label, cls, val, full) { tiles.push({ key: key, label: label, cls: cls, val: val, full: full }); };
    var names = function (k, max) { return rows.filter(FILTERS[k]).slice(0, max || 4).map(function (r) { return r.name; }).join(', '); };

    tile('up', 'UPAR ▲', cnt.up ? 'bull' : 'wait', String(cnt.up), cnt.up ? 'Heavy volume ke saath ' + cnt.up + ' stock upar (>' + MOVE + '%): ' + names('up') + (cnt.up > 4 ? '…' : '') + '. Bhaari volume + upar price = kharidari ka dabav.' : 'Heavy volume ke saath koi stock saaf upar nahi.');
    tile('down', 'NEECHE ▼', cnt.down ? 'bear' : 'wait', String(cnt.down), cnt.down ? 'Heavy volume ke saath ' + cnt.down + ' stock neeche (<-' + MOVE + '%): ' + names('down') + (cnt.down > 4 ? '…' : '') + '. Bhaari volume + neeche price = bikwali ka dabav.' : 'Heavy volume ke saath koi stock saaf neeche nahi.');
    tile('breakout', 'BREAKOUT 🚀', cnt.breakout ? 'bull' : 'wait', String(cnt.breakout), cnt.breakout ? '20-din ke high ke upar nikle: ' + names('breakout') + '. Bhaari volume ke saath breakout zyada bharose ka hota hai.' : '20-din ke high ke upar koi stock nahi.');
    tile('breakdown', 'BREAKDOWN 🔻', cnt.breakdown ? 'bear' : 'wait', String(cnt.breakdown), cnt.breakdown ? '20-din ke low ke neeche gaye: ' + names('breakdown') + '. Bhaari volume ke saath breakdown kamzori ka saaf sanket hai.' : '20-din ke low ke neeche koi stock nahi.');
    tile('burst', 'BURST ⚡', cnt.burst ? 'neu' : 'wait', String(cnt.burst), cnt.burst ? 'Pichhle ~10 min mein volume ' + BURST + 'x+ tez: ' + names('burst') + '. Ye abhi ki halchal hai, din bhar ka nahi.' : 'Abhi koi stock achanak tez volume mein nahi.');

    // sector clustering (ignore the "Other" bucket)
    var bySec = {};
    rows.forEach(function (r) { var s = r.sector; if (s && s !== 'Other') { var b = bySec[s] || (bySec[s] = { n: 0, up: 0, dn: 0 }); b.n++; if (FILTERS.up(r)) b.up++; if (FILTERS.down(r)) b.dn++; } });
    var top = null; Object.keys(bySec).forEach(function (k) { if (!top || bySec[k].n > bySec[top].n) top = k; });
    var cluster = top && bySec[top].n >= 3 && bySec[top].n >= 0.35 * total ? top : null;
    if (cluster) {
      var cb = bySec[cluster];
      tile('sector', 'SECTOR', 'neu', cluster.length > 11 ? cluster.slice(0, 10) + '…' : cluster,
        cluster + ' ke ' + cb.n + ' stock (' + total + ' mein se) ek saath heavy volume mein' + (cb.up > cb.dn ? ', zyada upar.' : cb.dn > cb.up ? ', zyada neeche.' : '.') + ' Poora sector hil raha ho to move zyada bharose ka hota hai.');
      chips.push({ t: '🏷️ ' + cluster + ' mein ' + cb.n + '/' + total + ' — sector-wide volume' + (cb.up > cb.dn ? ' (upar)' : cb.dn > cb.up ? ' (neeche)' : ''), c: 'var(--amber)' });
    } else tile('sector', 'SECTOR', 'wait', '--', 'Koi ek sector heavy volume mein ghira hua nahi dikh raha.');

    var verdict, cls = '';
    if (!total) { verdict = '😴 Shaant — koi unusual volume nahi'; }
    else if (cnt.up >= 3 && cnt.up >= 2 * cnt.down) { verdict = '🟢 Volume upar ki taraf — kharidari'; cls = 'bull'; }
    else if (cnt.down >= 3 && cnt.down >= 2 * cnt.up) { verdict = '🔴 Volume neeche ki taraf — bikwali'; cls = 'bear'; }
    else if (cnt.up > cnt.down) { verdict = '🟡 Volume halka upar'; }
    else if (cnt.down > cnt.up) { verdict = '🟠 Volume halka neeche'; }
    else { verdict = '⚪ Volume mixed'; }
    if (total) { lines.push(total + ' stock heavy volume mein'); lines.push(cnt.up + ' upar, ' + cnt.down + ' neeche'); if (cnt.breakout || cnt.breakdown) lines.push(cnt.breakout + ' breakout, ' + cnt.breakdown + ' breakdown'); }
    // volume-heavy but price barely moves -> absorption, worth a glance (informational)
    var flat = rows.filter(function (r) { return n(r.pctChange) !== null && Math.abs(r.pctChange) <= MOVE && n(r.ratio) !== null && r.ratio >= 2.5; });
    if (flat.length) chips.push({ t: '👀 ' + flat.slice(0, 3).map(function (r) { return r.name; }).join(', ') + ': volume bhaari par price lagbhag flat', c: 'var(--dim)' });
    return { total: total, verdict: verdict, cls: cls, tiles: tiles, chips: chips, lines: lines, counts: cnt };
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  var activeKey = null, lastTiles = [];
  function injectCss() {
    if (document.getElementById('sp-css')) return;
    var st = document.createElement('style'); st.id = 'sp-css';
    st.textContent = '#sp-card{margin-bottom:10px}#sp-card .pulse-grid{grid-template-columns:repeat(3,1fr)}@media(min-width:560px){#sp-card .pulse-grid{grid-template-columns:repeat(6,1fr)}}#sp-note{font-size:10.5px;color:var(--dim);opacity:.75;line-height:1.4;margin-top:8px}';
    document.head.appendChild(st);
  }
  function ensureMarkup(host) {
    if (host.getAttribute('data-sp')) return;
    host.setAttribute('data-sp', '1');
    host.innerHTML = '<div class="pulse-card" id="sp-box"><div class="pulse-head"><div class="pulse-verdict" id="sp-verdict">Collecting data…</div><div class="pulse-count" id="sp-count">--</div></div>'
      + '<div class="pulse-sum" id="sp-sum">Waiting for scanner data…</div><div class="pulse-extra" id="sp-extra" style="display:none"></div>'
      + '<div class="pulse-grid" id="sp-grid"></div><div class="pulse-detail" id="sp-detail">Kisi tile pe tap karo — neeche ki list sirf wahi stocks dikhayegi (dobara tap = sab)</div>'
      + '<div id="sp-note">Sirf dekhne ke liye — signals ya trades par koi asar nahi. Volume ka matlab sirf halchal hai, direction ki guarantee nahi.</div></div>';
    host.addEventListener('click', function (e) {
      var el = e.target; while (el && el !== host && !(el.getAttribute && el.getAttribute('data-spk') !== null)) el = el.parentNode;
      if (!el || el === host) return;
      var key = el.getAttribute('data-spk');
      if (!FILTERS[key]) { var t0 = lastTiles.filter(function (t) { return t.key === key; })[0]; var d0 = document.getElementById('sp-detail'); if (t0 && d0) d0.textContent = t0.label + ' → ' + t0.full; return; }
      activeKey = activeKey === key ? null : key;
      try { if (typeof root.renderVolumeScannerUI === 'function' && root._lastScannerD) root.renderVolumeScannerUI(root._lastScannerD); } catch (_) {}
    });
  }
  function drawCard(rows) {
    var host = document.getElementById('sp-card'); if (!host) return;
    injectCss(); ensureMarkup(host);
    var r = compute(rows); lastTiles = r.tiles;
    var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
    var v = document.getElementById('sp-verdict');
    if (v) { v.textContent = r.verdict; v.style.color = r.cls === 'bull' ? 'var(--green)' : r.cls === 'bear' ? 'var(--red)' : 'var(--amber)'; }
    var box = document.getElementById('sp-box'); if (box) { box.classList.remove('bull', 'bear'); if (r.cls) box.classList.add(r.cls); }
    set('sp-count', r.total ? r.total + ' stocks' : '--');
    set('sp-sum', r.lines.length ? r.lines.join(' · ') : 'Abhi koi stock apne 20-din ke average se kaafi zyada volume mein nahi.');
    var ex = document.getElementById('sp-extra');
    if (ex) { ex.innerHTML = r.chips.map(function (c) { return '<span class="pe-chip" style="color:' + c.c + ';border-color:' + c.c + '">' + esc(c.t) + '</span>'; }).join(''); ex.style.display = r.chips.length ? 'flex' : 'none'; }
    var grid = document.getElementById('sp-grid');
    if (grid) grid.innerHTML = r.tiles.map(function (t) { return '<div class="pt ' + t.cls + (t.key === activeKey ? ' sel' : '') + '" data-spk="' + t.key + '"><div class="pt-l">' + esc(t.label) + '</div><div class="pt-v">' + esc(t.val) + '</div></div>'; }).join('');
    var d = document.getElementById('sp-detail');
    if (d) {
      if (activeKey) { var t = r.tiles.filter(function (x) { return x.key === activeKey; })[0]; d.textContent = 'Filter ON: ' + (t ? t.label : activeKey) + ' — neeche sirf ' + filterRows(rows, activeKey).length + ' stock dikh rahe hain. (Dobara tap = sab dikhao)'; }
      else d.textContent = 'Kisi tile pe tap karo — neeche ki list sirf wahi stocks dikhayegi (dobara tap = sab)';
    }
  }
  // Called by renderVolumeScannerUI: draws the card and returns the rows the table should show (never throws).
  function apply(d) {
    var rows = d && Array.isArray(d.results) ? d.results : [];
    try { drawCard(rows); } catch (e) { try { console.warn('[ScannerPulse]', e && e.message); } catch (_) {} return rows; }
    try { return filterRows(rows, activeKey); } catch (e) { return rows; }
  }

  var api = { compute: compute, filterRows: filterRows, apply: apply };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScannerPulse = api;
})(typeof window !== 'undefined' ? window : this);