/* 🧭 "Breadth Pulse" card — display only (12 Oct).
 * One plain-language read of the whole Breadth tab: stocks up/down, weight-wise breadth, sectors, banks, PCR trend and
 * FII+DII, shown as tiles (green / amber / red) with a one-line verdict. It only RE-READS numbers the app already has
 * (s.breadth, s.global.sectors, s.pcrHistory, s.pcrSlope, s.fii, s.dii). It never changes a signal, a gate or a trade.
 * Mount point: <div id="bp-card"></div> at the top of the Breadth panel. Reuses the Pulse card styles of index.html.
 * compute() is pure (also loadable in Node for tests); render() touches the DOM and never throws into the page. */
(function (root) {
  'use strict';
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function n(v) { return isNum(v) ? v : (v !== null && v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null); }
  function sg(v, d) { return (v > 0 ? '+' : '') + v.toFixed(d == null ? 2 : d); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var SECTORS = [['bankNifty', 'BANK'], ['niftyIT', 'IT'], ['niftyAuto', 'AUTO'], ['niftyMetal', 'METAL'], ['niftyPharma', 'PHARMA'], ['niftyFMCG', 'FMCG'],
    ['niftyRealty', 'REALTY'], ['niftyMedia', 'MEDIA'], ['niftyEnergy', 'ENERGY'], ['niftyInfra', 'INFRA'], ['niftyPSUBank', 'PSU BNK']];

  function sectorRows(sectors) {
    var out = [];
    if (!sectors) return out;
    SECTORS.forEach(function (kv) {
      var s = sectors[kv[0]] || sectors[kv[0].toLowerCase()];
      if (!s) return;
      var chg = n(s.changePct != null ? s.changePct : s.change);
      if (chg !== null) out.push({ key: kv[0], label: kv[1], chg: chg });
    });
    return out;
  }

  // Pure: state -> { verdict, cls, bull, bear, neu, live, tiles[], lines[], chips[] }
  function compute(s) {
    s = s || {};
    var tiles = [], lines = [], chips = [];
    var tile = function (id, label, cls, val, full) { tiles.push({ id: id, label: label, cls: cls, val: val, full: full }); };

    // 1. Stocks up vs down (simple count)
    var b = s.breadth, up = 0, dn = 0, unch = 0, total = 0, wBull = null;
    if (b && (n(b.advances) !== null || n(b.declines) !== null)) {
      up = n(b.advances) || 0; dn = n(b.declines) || 0; unch = n(b.unchanged) || 0; total = up + dn + unch;
      wBull = n(b.weightedBull);
    }
    var countsCls = 'wait';
    if (total > 0) {
      var upShare = up / total;
      countsCls = upShare >= 0.6 ? 'bull' : upShare <= 0.4 ? 'bear' : 'neu';
      tile('bp-ad', 'STOCKS', countsCls, up + '↑ ' + dn + '↓',
        'Top stocks mein ' + up + ' upar, ' + dn + ' neeche' + (unch ? ', ' + unch + ' unchanged' : '') + ' (' + total + ' mein se). Simple ginti — chhote bade sab barabar.');
      lines.push(dn > up ? dn + '/' + total + ' stocks neeche' : up > dn ? up + '/' + total + ' stocks upar' : 'stocks barabar upar-neeche');
    } else tile('bp-ad', 'STOCKS', 'wait', '--', 'Stocks ka data abhi aa raha hai…');

    // 2. Weight-wise breadth
    if (wBull !== null && total > 0) {
      var wCls = wBull >= 60 ? 'bull' : wBull <= 40 ? 'bear' : 'neu';
      tile('bp-w', 'WEIGHT', wCls, wBull + '% bull',
        'Index weight ke hisaab se sirf ' + wBull + '% stocks upar hain. Bade stocks (ICICI, HDFC, Reliance…) ka asar zyada hota hai, isliye ye Nifty ke zyada kareeb hai.');
      lines.push('weight-wise ' + wBull + '% hi upar');
      // narrow move: count and weight disagree strongly
      if (countsCls === 'bull' && wCls === 'bear') chips.push({ t: '⚠️ Kam stocks upar par bade neeche — Nifty ke liye kamzor', c: 'var(--amber)' });
      if (countsCls === 'bear' && wCls === 'bull') chips.push({ t: '⚠️ Zyada stocks neeche par bade upar — Nifty ko sahara', c: 'var(--amber)' });
    } else tile('bp-w', 'WEIGHT', 'wait', '--', 'Weight-wise breadth abhi available nahi.');

    // 3. Sectors up vs down
    var secs = sectorRows(s.global && s.global.sectors);
    if (secs.length >= 4) {
      var su = secs.filter(function (x) { return x.chg > 0; }).length, sd = secs.filter(function (x) { return x.chg < 0; }).length;
      var sCls = su / secs.length >= 2 / 3 ? 'bull' : sd / secs.length >= 2 / 3 ? 'bear' : 'neu';
      var best = secs.reduce(function (a, x) { return x.chg > a.chg ? x : a; }), worst = secs.reduce(function (a, x) { return x.chg < a.chg ? x : a; });
      tile('bp-sec', 'SECTORS', sCls, su + '↑ ' + sd + '↓',
        secs.length + ' sector index mein ' + su + ' upar, ' + sd + ' neeche. Sabse majboot ' + best.label + ' ' + sg(best.chg) + '%, sabse kamzor ' + worst.label + ' ' + sg(worst.chg) + '%. (Media jaise chhote index kabhi akele bhaag jaate hain — unhe zyada mat padho.)');
      lines.push(secs.length + ' mein ' + sd + ' sector neeche');
      lines.push('sabse kamzor ' + worst.label + ' ' + sg(worst.chg) + '%, sabse majboot ' + best.label + ' ' + sg(best.chg) + '%');
    } else tile('bp-sec', 'SECTORS', 'wait', '--', 'Sector data abhi aa raha hai…');

    // 4. Banks (largest weight in Nifty)
    var bank = secs.filter(function (x) { return x.key === 'bankNifty'; })[0];
    if (bank) {
      var bCls = bank.chg >= 0.3 ? 'bull' : bank.chg <= -0.3 ? 'bear' : 'neu';
      tile('bp-bank', 'BANKS', bCls, sg(bank.chg) + '%', 'Bank Nifty ' + sg(bank.chg) + '%. Nifty mein banks ka weight sabse bada hai (~35-40%), isliye inki chaal index ko seedha kheenchti hai.');
    } else tile('bp-bank', 'BANKS', 'wait', '--', 'Bank Nifty data abhi available nahi.');

    // 5. PCR level + trend
    var hist = Array.isArray(s.pcrHistory) ? s.pcrHistory : [];
    var lastPcr = hist.length ? n(hist[hist.length - 1].pcr) : n(s.pcr);
    var slope = s.pcrSlope && s.pcrSlope.trend ? s.pcrSlope.trend : null;
    if (lastPcr !== null) {
      var pCls = lastPcr > 1.2 ? 'bull' : lastPcr < 0.8 ? 'bear' : 'neu';
      var pTrendTxt = slope === 'RISING' ? 'PCR badh raha hai (put writing — halka bullish drift)' : slope === 'FALLING' ? 'PCR gir raha hai (call writing — halka bearish drift)' : 'PCR ka koi saaf trend nahi';
      tile('bp-pcr', 'PCR', pCls, lastPcr.toFixed(2) + (slope === 'RISING' ? ' ↗' : slope === 'FALLING' ? ' ↘' : ' →'),
        'PCR ' + lastPcr.toFixed(2) + (pCls === 'bear' ? ' (0.8 se neeche = bearish zone)' : pCls === 'bull' ? ' (1.2 se upar = bullish zone)' : ' (beech ka neutral zone)') + '. ' + pTrendTxt + '.');
      lines.push('PCR ' + lastPcr.toFixed(2));
    } else tile('bp-pcr', 'PCR', 'wait', '--', 'PCR data abhi aa raha hai…');

    // 6. FII + DII (money flow, independent of the stock count)
    var fii = s.fii && n(s.fii.net) !== null ? n(s.fii.net) : null, dii = s.dii && n(s.dii.net) !== null ? n(s.dii.net) : null;
    var instCls = 'wait', combined = null;
    if (fii !== null || dii !== null) {
      combined = (fii || 0) + (dii || 0);
      instCls = combined >= 500 ? 'bull' : combined <= -500 ? 'bear' : 'neu';
      tile('bp-inst', 'FII+DII', instCls, sg(Math.round(combined), 0) + ' Cr',
        'FII net ' + (fii !== null ? sg(Math.round(fii), 0) : '--') + ' Cr, DII net ' + (dii !== null ? sg(Math.round(dii), 0) + '' : '--') + ' Cr, milake ' + sg(Math.round(combined), 0) + ' Cr. Ye paise ka flow hai, stocks ki ginti se alag cheez.');
    } else tile('bp-inst', 'FII+DII', 'wait', '--', 'FII/DII data abhi aa raha hai (aam taur par shaam ko).');

    // tally + verdict
    var bull = tiles.filter(function (t) { return t.cls === 'bull'; }).length, bear = tiles.filter(function (t) { return t.cls === 'bear'; }).length;
    var live = tiles.filter(function (t) { return t.cls !== 'wait'; }).length, neu = live - bull - bear;
    // the four breadth tiles (stocks / weight / sectors / banks) vs the money-flow tile
    var breadthTiles = tiles.filter(function (t) { return ['bp-ad', 'bp-w', 'bp-sec', 'bp-bank'].indexOf(t.id) >= 0 && t.cls !== 'wait'; });
    var bB = breadthTiles.filter(function (t) { return t.cls === 'bull'; }).length, bR = breadthTiles.filter(function (t) { return t.cls === 'bear'; }).length;
    var verdict, cls;
    if (live < 3) { verdict = 'Collecting data…'; cls = ''; }
    else if (bR >= 3 && bR > bB) { verdict = '🔴 Breadth kamzor'; cls = 'bear'; }
    else if (bB >= 3 && bB > bR) { verdict = '🟢 Breadth mazboot'; cls = 'bull'; }
    else if (bR > bB) { verdict = '🟠 Breadth halka kamzor'; cls = ''; }
    else if (bB > bR) { verdict = '🟡 Breadth halka mazboot'; cls = ''; }
    else { verdict = '⚪ Breadth mixed'; cls = ''; }

    // disagreement between breadth (stocks) and money flow
    if (breadthTiles.length >= 3 && instCls !== 'wait') {
      if (bR >= 3 && bR > bB && instCls === 'bull') chips.push({ t: '⚠️ Stocks kamzor par FII+DII net kharid — dono alag bol rahe hain', c: 'var(--amber)' });
      if (bB >= 3 && bB > bR && instCls === 'bear') chips.push({ t: '⚠️ Stocks mazboot par FII+DII net bechna — dono alag bol rahe hain', c: 'var(--amber)' });
    }
    return { verdict: verdict, cls: cls, bull: bull, bear: bear, neu: neu, live: live, tiles: tiles, lines: lines, chips: chips };
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  var lastTiles = [];
  function injectCss() {
    if (document.getElementById('bp-css')) return;
    var st = document.createElement('style'); st.id = 'bp-css';
    st.textContent = '#bp-card{margin-bottom:8px}#bp-card .pulse-grid{grid-template-columns:repeat(3,1fr)}@media(min-width:560px){#bp-card .pulse-grid{grid-template-columns:repeat(6,1fr)}}'
      + '#bp-note{font-size:10.5px;color:var(--dim);opacity:.75;line-height:1.4;margin-top:8px}';
    document.head.appendChild(st);
  }
  function ensureMarkup(host) {
    if (host.getAttribute('data-bp')) return;
    host.setAttribute('data-bp', '1');
    host.innerHTML = '<div class="pulse-card" id="bp-box"><div class="pulse-head"><div class="pulse-verdict" id="bp-verdict">Collecting data…</div><div class="pulse-count" id="bp-count">--</div></div>'
      + '<div class="pulse-tally"><div class="pt-bull" id="bp-t-bull" style="width:0%"></div><div class="pt-neu" id="bp-t-neu" style="width:100%"></div><div class="pt-bear" id="bp-t-bear" style="width:0%"></div></div>'
      + '<div class="pulse-tally-lab"><span style="color:var(--green)">BULL <b id="bp-n-bull">0</b></span><span style="color:var(--dim)">NEUTRAL <b id="bp-n-neu">0</b></span><span style="color:var(--red)">BEAR <b id="bp-n-bear">0</b></span></div>'
      + '<div class="pulse-sum" id="bp-sum">Waiting for breadth data…</div><div class="pulse-extra" id="bp-extra" style="display:none"></div>'
      + '<div class="pulse-grid" id="bp-grid"></div><div class="pulse-detail" id="bp-detail">Kisi tile pe tap karo — poori detail yahan dikhegi</div>'
      + '<div id="bp-note">Sirf dekhne ke liye — signals ya trades par koi asar nahi. Ginti (stocks) aur paise ka flow (FII+DII) alag cheezein hain, dono alag ho sakte hain.</div></div>';
    host.addEventListener('click', function (e) {
      var el = e.target; while (el && el !== host && !(el.getAttribute && el.getAttribute('data-bpi') !== null)) el = el.parentNode;
      if (!el || el === host) return;
      var i = Number(el.getAttribute('data-bpi')), t = lastTiles[i], d = document.getElementById('bp-detail');
      if (!t || !d) return;
      d.textContent = t.label + ' → ' + t.full;
      var all = host.querySelectorAll('#bp-grid .pt'); for (var k = 0; k < all.length; k++) all[k].classList.toggle('sel', k === i);
    });
  }
  function render(s) {
    try {
      var host = document.getElementById('bp-card'); if (!host) return;
      injectCss(); ensureMarkup(host);
      var r = compute(s); lastTiles = r.tiles;
      var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
      var w = function (id, v) { var e = document.getElementById(id); if (e) e.style.width = v + '%'; };
      var pct = function (k) { return r.live ? (100 * k / r.live) : 0; };
      w('bp-t-bull', pct(r.bull)); w('bp-t-bear', pct(r.bear)); w('bp-t-neu', r.live ? pct(r.neu) : 100);
      set('bp-n-bull', r.bull); set('bp-n-bear', r.bear); set('bp-n-neu', r.neu);
      var st = document.getElementById('status-txt'), closed = !!st && st.textContent !== 'LIVE';
      var v = document.getElementById('bp-verdict');
      if (v) { v.textContent = (closed ? '🌙 Aakhri · ' : '') + r.verdict.replace(/^[^A-Za-z]+/, function (m) { return closed ? '' : m; }); v.style.color = r.cls === 'bull' ? 'var(--green)' : r.cls === 'bear' ? 'var(--red)' : 'var(--amber)'; }
      var box = document.getElementById('bp-box'); if (box) { box.classList.remove('bull', 'bear'); if (r.cls) box.classList.add(r.cls); }
      set('bp-count', r.live ? r.live + ' indicators' : '--');
      var sum = document.getElementById('bp-sum'); if (sum) sum.textContent = r.lines.length ? r.lines.join(' · ') : 'Waiting for breadth data…';
      var ex = document.getElementById('bp-extra');
      if (ex) { ex.innerHTML = r.chips.map(function (c) { return '<span class="pe-chip" style="color:' + c.c + ';border-color:' + c.c + '">' + esc(c.t) + '</span>'; }).join(''); ex.style.display = r.chips.length ? 'flex' : 'none'; }
      var grid = document.getElementById('bp-grid');
      if (grid) grid.innerHTML = r.tiles.map(function (t, i) { return '<div class="pt ' + t.cls + '" data-bpi="' + i + '"><div class="pt-l">' + esc(t.label) + '</div><div class="pt-v">' + esc(t.val) + '</div></div>'; }).join('');
    } catch (e) { try { console.warn('[BreadthPulse]', e && e.message); } catch (_) {} }
  }

  var api = { compute: compute, render: render, sectorRows: sectorRows };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BreadthPulse = api;
})(typeof window !== 'undefined' ? window : this);