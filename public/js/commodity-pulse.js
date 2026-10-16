/* 🛢️/₿ "Crude Pulse" and "Bitcoin Pulse" cards — display only (12 Oct).
 * One plain-language read of the Crude Live / Bitcoin Live tab: which way the trend leans, whether the ADX gate is open,
 * RSI zone, 1m/5m agreement, PCR, where price sits in today's range, and — most useful — WHY the engine is still on WAIT
 * (e.g. "confidence 68% < 70% needed"). It only RE-READS /api/crude-live and /api/bitcoin-live. It never changes a signal or a trade.
 * Mount points: <div id="crp-card"></div> (crude) and <div id="btp-card"></div> (bitcoin). Reuses the Pulse card styles of index.html.
 * compute() is pure (loadable in Node for tests); render() touches the DOM and never throws into the page.
 * Thresholds mirror the engine (src/utils/pureCalc.js): ADX < 20 = hard WAIT, ADX >= 30 = "strong", RSI 70/30 block, EMA gap > 0.1% = real separation. */
(function (root) {
  'use strict';
  function n(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var KIND = {
    crude:   { pfx: 'crp', name: 'CRUDE',   live: 'CRUDEOIL', cur: '₹', minConf: 'CRUDE', lvlStep: 50 },
    bitcoin: { pfx: 'btp', name: 'BITCOIN', live: 'BITCOIN',  cur: '$', minConf: 'BITCOIN' },
  };
  var ADX_GATE = 20, ADX_STRONG = 30, GAP_REAL = 0.1, GAP_FLAT = 0.03;

  function fmt(v, k) { var c = KIND[k].cur; return c + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

  // 16 Oct — support/resistance slider (display only), like the Nifty tab's. Levels are MECHANICAL and need no extra API call:
  // today's High / Low / Open, yesterday's close, and round numbers every `lvlStep`. They are reference points, not a proven edge.
  function computeLevels(kind, d, price) {
    var K = KIND[kind]; if (!K || !K.lvlStep || price === null || !(price > 0)) return null;
    var step = K.lvlStep, eps = step * 0.02, cand = [];
    function add(label, v, named) { v = n(v); if (v !== null && v > 0) cand.push({ label: label, price: v, named: !!named }); }
    add('Aaj ka High', d.high, true); add('Aaj ka Low', d.low, true); add('Aaj ka Open', d.open, true); add('Kal ka Close', d.prevClose, true);
    var base = Math.floor(price / step) * step;
    for (var k = -2; k <= 3; k++) { var rp = base + k * step; add('Round ' + rp, rp, false); }
    // de-duplicate: a named level wins over a round number sitting on it; two levels within eps merge
    cand.sort(function (a, b) { return a.price - b.price || (b.named ? 1 : 0) - (a.named ? 1 : 0); });
    var lv = [];
    cand.forEach(function (c) { var last = lv[lv.length - 1]; if (last && Math.abs(last.price - c.price) <= eps) { if (c.named && !last.named) lv[lv.length - 1] = c; } else lv.push(c); });
    var sup = null, res = null;
    lv.forEach(function (c) { if (c.price < price - eps) sup = c; else if (c.price > price + eps && !res) res = c; });
    if (!sup || !res || !(res.price > sup.price)) return null;
    var pos = Math.max(2, Math.min(98, 100 * (price - sup.price) / (res.price - sup.price)));
    var list = lv.filter(function (c) { return c.named || (c.price >= sup.price - eps && c.price <= res.price + eps); })
      .map(function (c) { return { label: c.label, price: c.price, dist: c.price - price }; })
      .sort(function (a, b) { return Math.abs(a.dist) - Math.abs(b.dist); }).slice(0, 7);
    return { sup: sup, res: res, pos: pos, supD: price - sup.price, resD: res.price - price,
             mid: pos < 30 ? 'support ke paas' : pos > 70 ? 'resistance ke paas' : 'beech mein', list: list };
  }

  // Pure: live payload -> { verdict, cls, count, sum, tiles[], chips[], held }
  function compute(kind, d) {
    var K = KIND[kind] || KIND.crude;
    d = d || {};
    var ind = d.indicators || {}, sig = d.signal || {}, mtf = sig.mtf || {};
    var tiles = [], chips = [], votes = { bull: 0, bear: 0 };
    var tile = function (id, label, cls, val, full) { tiles.push({ id: id, label: label, cls: cls, val: val, full: full }); };
    var price = n(d.price), isLive = d.session === K.live;
    // 15 Oct: Bitcoin's own window (16:00-08:50) overlaps Crude's evening session, and getActiveSession() returns only ONE
    // session (Crude wins 17:30-23:55), so Bitcoin showed BAND while live. /api/bitcoin-live already sends windowOpen.
    if (kind === 'bitcoin' && typeof d.windowOpen === 'boolean') isLive = d.windowOpen;

    // TREND: EMA9 vs EMA21 gap
    var e9 = n(ind.ema9), e21 = n(ind.ema21), gap = null, trend = null;
    if (e9 !== null && e21 !== null && e21 > 0) {
      gap = (e9 - e21) / e21 * 100;
      trend = Math.abs(gap) < GAP_FLAT ? 'flat' : gap > 0 ? 'bull' : 'bear';
    }
    if (trend === 'bull') votes.bull++; else if (trend === 'bear') votes.bear++;
    tile('tr', 'TREND', trend === 'bull' ? 'bull' : trend === 'bear' ? 'bear' : 'wait',
      trend === null ? '--' : trend === 'flat' ? 'FLAT' : trend === 'bull' ? 'UPAR ▲' : 'NEECHE ▼',
      trend === null ? 'EMA data abhi nahi aaya.' :
      'EMA9 ' + e9.toFixed(1) + ' vs EMA21 ' + e21.toFixed(1) + ' — gap ' + (gap >= 0 ? '+' : '') + gap.toFixed(2) + '%. ' +
      (trend === 'flat' ? 'Dono lagbhag barabar — koi saaf trend nahi.' : Math.abs(gap) > GAP_REAL ? 'Saaf separation (>' + GAP_REAL + '%), trend asli lag raha hai.' : 'Direction hai par gap chhota (<' + GAP_REAL + '%) — kamzor.'));

    // ADX gate
    var adx = n(ind.adx);
    var adxCls = adx === null ? 'wait' : adx >= ADX_STRONG ? 'bull' : adx >= ADX_GATE ? 'neu' : 'bear';
    tile('adx', 'ADX', adxCls, adx === null ? '--' : adx.toFixed(1) + (adx >= ADX_STRONG ? ' 💪' : adx >= ADX_GATE ? ' 🟡' : ' 💤'),
      adx === null ? 'ADX data nahi.' :
      adx < ADX_GATE ? 'Value ' + adx.toFixed(1) + ' < ' + ADX_GATE + ' — market sideways hai; engine yahan trade hi nahi leta (hard WAIT).' :
      adx < ADX_STRONG ? 'Value ' + adx.toFixed(1) + ' — gate khula (≥' + ADX_GATE + ') par trend abhi strong nahi (<' + ADX_STRONG + ').' :
      'Value ' + adx.toFixed(1) + ' ≥ ' + ADX_STRONG + ' — strong trend.');

    // RSI zone
    var rsi = n(ind.rsi);
    tile('rsi', 'RSI', rsi === null ? 'wait' : rsi >= 70 || rsi <= 30 ? 'neu' : 'wait', rsi === null ? '--' : rsi.toFixed(1) + (rsi >= 70 ? ' 🔥' : rsi <= 30 ? ' 🧊' : ''),
      rsi === null ? 'RSI data nahi.' : rsi >= 70 ? 'Overbought (≥70) — engine yahan naya BUY CALL nahi deta, pullback ka risk.' : rsi <= 30 ? 'Oversold (≤30) — engine yahan naya BUY PUT nahi deta, bounce ka risk.' : 'Neutral zone (30–70) — dono taraf jagah hai.');

    // 1m / 5m MTF
    var t1 = mtf.tf1m, t5 = mtf.tf5m, m1 = t1 === 'BULL' ? 1 : t1 === 'BEAR' ? -1 : 0, m5 = t5 === 'BULL' ? 1 : t5 === 'BEAR' ? -1 : 0;
    var haveMtf = !!(t1 || t5);
    if (m1 > 0) votes.bull++; if (m1 < 0) votes.bear++; if (m5 > 0) votes.bull++; if (m5 < 0) votes.bear++;
    var mtfCls = !haveMtf ? 'wait' : (m1 && m1 === m5) ? (m1 > 0 ? 'bull' : 'bear') : 'neu';
    tile('mtf', '1m · 5m', mtfCls, !haveMtf ? '--' : (t1 || '--') + ' · ' + (t5 || '--'),
      !haveMtf ? 'MTF trend abhi nahi bana (candles kam ho sakte hain).' : (m1 && m1 === m5) ? 'Dono timeframe ek hi taraf (' + t1 + ') — alignment achha.' : '1m ' + (t1 || '--') + ', 5m ' + (t5 || '--') + ' — dono ek saath nahi; mixed.');

    // PCR (same cut-offs as the Nifty pulse: >1.2 bullish-leaning, <0.8 bearish-leaning)
    var pcr = d.pcr && n(d.pcr.pcr) !== null ? Number(d.pcr.pcr) : null;
    var pcrCls = pcr === null ? 'wait' : pcr > 1.2 ? 'bull' : pcr < 0.8 ? 'bear' : 'neu';
    if (pcrCls === 'bull') votes.bull++; else if (pcrCls === 'bear') votes.bear++;
    tile('pcr', 'PCR', pcrCls, pcr === null ? '--' : pcr.toFixed(2),
      pcr === null ? 'PCR data nahi.' : pcr > 1.2 ? 'PCR ' + pcr.toFixed(2) + ' — puts zyada (support ka sanket, upar ka jhukav).' : pcr < 0.8 ? 'PCR ' + pcr.toFixed(2) + ' — calls zyada (resistance/neeche ka jhukav).' : 'PCR ' + pcr.toFixed(2) + ' — neutral.');

    // Position in today's range
    var hi = n(d.high), lo = n(d.low), pos = null;
    if (price !== null && hi !== null && lo !== null && hi > lo && price >= lo * 0.999 && price <= hi * 1.001) pos = Math.max(0, Math.min(100, (price - lo) / (hi - lo) * 100));
    tile('rng', 'DAY RANGE', pos === null ? 'wait' : 'neu', pos === null ? '--' : Math.round(pos) + '%',
      pos === null ? 'Aaj ka high/low abhi nahi.' : 'Price aaj ke range (' + fmt(lo, kind) + ' – ' + fmt(hi, kind) + ') mein ' + Math.round(pos) + '% par: ' + (pos >= 80 ? 'high ke paas (chase karne se bacho).' : pos <= 20 ? 'low ke paas.' : 'beech mein.'));

    // Signal + WHY held (parses the engine's own filter reason)
    var sg = sig.signal || 'WAIT', conf = n(sig.confidence) || 0, reasons = Array.isArray(sig.reasons) ? sig.reasons : [];
    var held = null;
    for (var i = 0; i < reasons.length; i++) {
      var m = /High-Conviction Filter:\s*(\d+)%[^<]*<\s*(\d+)%/.exec(String(reasons[i]));
      if (m) { held = { have: Number(m[1]), need: Number(m[2]) }; break; }
    }
    var blocked = null;
    for (var j = 0; j < reasons.length && !blocked; j++) { if (/⛔/.test(String(reasons[j]))) blocked = String(reasons[j]).replace(/^[•\s]+/, ''); }
    var isSig = sg === 'BUY CALL' || sg === 'BUY PUT';
    tile('sig', 'SIGNAL', sg === 'BUY CALL' ? 'bull' : sg === 'BUY PUT' ? 'bear' : 'wait', sg + (isSig ? ' ' + conf + '%' : ''),
      isSig ? 'Engine ne ' + sg + ' diya, confidence ' + conf + '%.' : held ? 'WAIT — setup ban raha tha (' + held.have + '%) par ' + held.need + '% chahiye; ' + (held.need - held.have) + ' point kam.' : blocked ? 'WAIT — ' + blocked : 'WAIT — abhi koi clean setup nahi.');

    // chips
    if (held) chips.push({ t: '🚫 Filter ne roka: ' + held.have + '% < ' + held.need + '% — ' + (held.need - held.have) + ' pt kam', c: 'var(--amber)' });
    else if (blocked && !isSig) chips.push({ t: blocked.length > 70 ? blocked.slice(0, 68) + '…' : blocked, c: 'var(--amber)' });
    if (adx !== null && adx < ADX_GATE) chips.push({ t: '💤 ADX ' + adx.toFixed(1) + ' — sideways, signal ka intezaar', c: 'var(--dim)' });
    if (rsi !== null && (rsi >= 70 || rsi <= 30)) chips.push({ t: (rsi >= 70 ? '🔥 RSI overbought' : '🧊 RSI oversold') + ' ' + rsi.toFixed(0), c: 'var(--amber)' });
    if (pos !== null && pos >= 90 && trend !== 'bull') chips.push({ t: '⚠️ Price day-high ke paas par EMA trend upar nahi', c: 'var(--amber)' });
    if (pos !== null && pos <= 10 && trend !== 'bear') chips.push({ t: '⚠️ Price day-low ke paas par EMA trend neeche nahi', c: 'var(--amber)' });
    if (haveMtf && m1 && m5 && m1 !== m5) chips.push({ t: '↔️ 1m aur 5m alag dishaon mein', c: 'var(--dim)' });
    if (trend && trend !== 'flat' && m5 && ((trend === 'bull') !== (m5 > 0))) chips.push({ t: '↔️ EMA trend aur 5m trend ulte', c: 'var(--dim)' });

    // verdict
    var verdict, cls = '';
    if (isSig) { verdict = (sg === 'BUY CALL' ? '🟢 ' : '🔴 ') + K.name + ' ' + sg + ' — ' + conf + '% confidence'; cls = sg === 'BUY CALL' ? 'bull' : 'bear'; }
    else if (adx !== null && adx < ADX_GATE) verdict = '😴 ' + K.name + ' sideways — signal ka intezaar';
    else if (votes.bull >= 3 && votes.bear === 0) { verdict = '🟡 Jhukav upar ki taraf, par signal nahi'; cls = ''; }
    else if (votes.bear >= 3 && votes.bull === 0) { verdict = '🟠 Jhukav neeche ki taraf, par signal nahi'; cls = ''; }
    else if (votes.bull && votes.bear) verdict = '⚪ Mixed — indicators ek dusre se alag';
    else verdict = '⏸️ WAIT — abhi koi clean setup nahi';
    if (!isLive && d.session) verdict = '🌙 ' + verdict + ' (aakhri data)';
    var sum = (price !== null ? fmt(price, kind) + (n(d.changePct) !== null ? ' (' + (d.changePct >= 0 ? '+' : '') + Number(d.changePct).toFixed(2) + '%)' : '') + ' · ' : '') + 'upar ' + votes.bull + ' · neeche ' + votes.bear + ' vote';
    return { verdict: verdict, cls: cls, count: isLive ? 'LIVE' : 'BAND', sum: sum, tiles: tiles, chips: chips, held: held, votes: votes, live: isLive, lvl: computeLevels(kind, d, price) };
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  var store = { crude: [], bitcoin: [] };
  function $(id) { return document.getElementById(id); }
  function injectCss() {
    if ($('cmp-css')) return;
    var st = document.createElement('style'); st.id = 'cmp-css';
    st.textContent = '#crp-card,#btp-card{margin-bottom:10px}#crp-card .pulse-grid,#btp-card .pulse-grid{grid-template-columns:repeat(3,1fr)}@media(min-width:560px){#crp-card .pulse-grid,#btp-card .pulse-grid{grid-template-columns:repeat(6,1fr)}}#crp-card .pt[data-i="6"],#btp-card .pt[data-i="6"]{grid-column:1/-1}.cmp-note{font-size:10.5px;color:var(--dim);opacity:.75;line-height:1.4;margin-top:8px}.cmp-lvls{margin-top:8px;border-top:1px solid var(--border);padding-top:6px}.cmp-lv{display:flex;justify-content:space-between;gap:8px;font-size:11px;font-family:monospace;color:var(--dim);padding:1px 0}.cmp-lv span:nth-child(2){color:var(--fg)}.cmp-up{color:var(--red)}.cmp-dn{color:var(--green)}';
    document.head.appendChild(st);
  }
  function ensureMarkup(kind, host) {
    if (host.getAttribute('data-cmp')) return;
    host.setAttribute('data-cmp', '1');
    var p = KIND[kind].pfx;
    host.innerHTML = '<div class="pulse-card" id="' + p + '-box"><div class="pulse-head"><div class="pulse-verdict" id="' + p + '-verdict">Collecting data…</div><div class="pulse-count" id="' + p + '-count">--</div></div>'
      + '<div class="pulse-sum" id="' + p + '-sum">Waiting for data…</div><div class="pulse-extra" id="' + p + '-extra" style="display:none"></div>'
      + (KIND[kind].lvlStep ? '<div class="pulse-lvl" id="' + p + '-lvl" style="display:none"><div class="pl-row"><span class="pl-s" id="' + p + '-pl-s">--</span><div class="pl-track"><div class="pl-dot" id="' + p + '-pl-dot" style="left:50%"></div></div><span class="pl-r" id="' + p + '-pl-r">--</span></div><div class="pl-sub"><span id="' + p + '-pl-sd">--</span><span id="' + p + '-pl-mid">--</span><span id="' + p + '-pl-rd">--</span></div><div class="cmp-lvls" id="' + p + '-lvls"></div></div>' : '')
      + '<div class="pulse-grid" id="' + p + '-grid"></div><div class="pulse-detail" id="' + p + '-detail">Kisi tile pe tap karo — matlab yahin dikhega</div>'
      + '<div class="cmp-note">Sirf dekhne ke liye — signals ya trades par koi asar nahi. Ye engine ke apne rules (ADX gate 20, RSI 70/30, filter) ko seedha bhasha mein padhta hai.</div></div>';
    host.addEventListener('click', function (e) {
      var el = e.target; while (el && el !== host && !(el.getAttribute && el.getAttribute('data-i') !== null)) el = el.parentNode;
      if (!el || el === host) return;
      var i = Number(el.getAttribute('data-i')), t = store[kind][i], dd = $(p + '-detail'); if (!t || !dd) return;
      dd.textContent = t.label + ' → ' + t.full;
      var all = host.querySelectorAll('.pt'); for (var k = 0; k < all.length; k++) all[k].classList.toggle('sel', k === i);
    });
  }
  function render(kind, d) {
    try {
      var K = KIND[kind]; if (!K) return;
      var host = $(K.pfx + '-card'); if (!host) return;
      injectCss(); ensureMarkup(kind, host);
      var r = compute(kind, d), p = K.pfx;
      var selIdx = -1; var old = host.querySelector('.pt.sel'); if (old) selIdx = Number(old.getAttribute('data-i'));
      store[kind] = r.tiles;
      var v = $(p + '-verdict'); v.textContent = r.verdict; v.style.color = r.cls === 'bull' ? 'var(--green)' : r.cls === 'bear' ? 'var(--red)' : 'var(--amber)';
      var box = $(p + '-box'); box.classList.remove('bull', 'bear'); if (r.cls) box.classList.add(r.cls);
      $(p + '-count').textContent = r.count; $(p + '-sum').textContent = r.sum;
      var ex = $(p + '-extra'); ex.innerHTML = r.chips.map(function (c) { return '<span class="pe-chip" style="color:' + c.c + ';border-color:' + c.c + '">' + esc(c.t) + '</span>'; }).join(''); ex.style.display = r.chips.length ? 'flex' : 'none';
      var lvEl = $(p + '-lvl');
      if (lvEl) {
        var L = r.lvl;
        if (L) {
          lvEl.style.display = 'block';
          $(p + '-pl-s').textContent = L.sup.price; $(p + '-pl-r').textContent = L.res.price;
          $(p + '-pl-dot').style.left = L.pos + '%';
          $(p + '-pl-sd').textContent = L.supD.toFixed(0) + ' pts niche'; $(p + '-pl-rd').textContent = L.resD.toFixed(0) + ' pts upar'; $(p + '-pl-mid').textContent = L.mid;
          $(p + '-lvls').innerHTML = L.list.map(function (c) { return '<div class="cmp-lv"><span>' + esc(c.label) + '</span><span>' + c.price + '</span><span class="' + (c.dist >= 0 ? 'cmp-up' : 'cmp-dn') + '">' + (c.dist >= 0 ? '▲' : '▼') + Math.abs(c.dist).toFixed(0) + '</span></div>'; }).join('');
        } else lvEl.style.display = 'none';
      }
      $(p + '-grid').innerHTML = r.tiles.map(function (t, i) { return '<div class="pt ' + t.cls + (i === selIdx ? ' sel' : '') + '" data-i="' + i + '"><div class="pt-l">' + esc(t.label) + '</div><div class="pt-v">' + esc(t.val) + '</div></div>'; }).join('');
      if (selIdx >= 0 && r.tiles[selIdx]) $(p + '-detail').textContent = r.tiles[selIdx].label + ' → ' + r.tiles[selIdx].full;
    } catch (e) { try { console.warn('[CommodityPulse]', e && e.message); } catch (_) {} }
  }

  var api = { compute: compute, render: render, KIND: KIND };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CommodityPulse = api;
})(typeof window !== 'undefined' ? window : this);