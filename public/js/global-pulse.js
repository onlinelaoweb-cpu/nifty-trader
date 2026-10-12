/* 🌍 "Global Pulse" card — display only (12 Oct).
 * One plain-language read of the whole Global tab: US, Europe, Asia, GIFT Nifty, rupee, crude and the next big event,
 * as tiles (green / amber / red) with a one-line verdict. It only RE-READS numbers the app already has
 * (s.global.*, s.calendarEvents). It never changes a signal, a gate or a trade.
 * Mount point: <div id="gp-card"></div> at the top of the Global panel. Reuses the Pulse card styles of index.html.
 * compute() is pure (also loadable in Node for tests); render() touches the DOM and never throws into the page. */
(function (root) {
  'use strict';
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function n(v) { return isNum(v) ? v : (v !== null && v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null); }
  function sg(v, d) { return (v > 0 ? '+' : '') + v.toFixed(d == null ? 2 : d); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function chg(o) { return o ? n(o.changePct != null ? o.changePct : o.change) : null; }

  function avgOf(group, keys) {
    var vals = [];
    keys.forEach(function (k) { var v = group ? chg(group[k]) : null; if (v !== null) vals.push(v); });
    return vals.length ? { avg: vals.reduce(function (a, b) { return a + b; }, 0) / vals.length, n: vals.length, vals: vals } : null;
  }
  function istDate(ms) { return new Date(ms + 330 * 60000).toISOString().slice(0, 10); }
  function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }

  // Next high / medium impact event that has not happened yet (IST). Pure.
  function nextEvent(events, nowMs) {
    if (!Array.isArray(events) || !events.length) return null;
    var today = istDate(nowMs), istNow = new Date(nowMs + 330 * 60000), nowHM = String(istNow.getUTCHours()).padStart(2, '0') + ':' + String(istNow.getUTCMinutes()).padStart(2, '0');
    var list = events.filter(function (e) {
      if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(String(e.date || '')) || !/^(high|medium)$/i.test(String(e.impact || ''))) return false;
      if (e.date > today) return true;
      if (e.date < today) return false;
      return !e.time || e.time === '--:--' || e.time >= nowHM;   // today: still ahead (or untimed)
    }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.time || '').localeCompare(String(b.time || '')); });
    if (!list.length) return null;
    var e = list[0]; return { ev: e, days: dayDiff(today, e.date) };
  }

  // Pure: state -> { verdict, cls, bull, bear, neu, live, tiles[], lines[], chips[] }
  function compute(s, nowMs) {
    s = s || {}; nowMs = nowMs == null ? Date.now() : nowMs;
    var g = s.global || {}, tiles = [], lines = [], chips = [];
    var tile = function (id, label, cls, val, full, counts) { tiles.push({ id: id, label: label, cls: cls, val: val, full: full, counts: counts !== false }); };
    var tri = function (v, hi, lo) { return v >= hi ? 'bull' : v <= lo ? 'bear' : 'neu'; };

    var us = avgOf(g.us, ['dow', 'sp500', 'nasdaq']), eu = avgOf(g.europe, ['dax', 'ftse']), as = avgOf(g.asia, ['nikkei', 'hangseng', 'shanghai']);
    var gift = g.asia ? chg(g.asia.giftNifty) : null;
    if (us) { tile('gp-us', 'US', tri(us.avg, 0.4, -0.4), sg(us.avg) + '%', 'Dow, S&P 500 aur Nasdaq ka average ' + sg(us.avg) + '%. ' + (us.avg >= 0.4 ? 'US mazboot — Nifty ko aam taur par sahara.' : us.avg <= -0.4 ? 'US kamzor — Nifty par dabav aa sakta hai.' : 'US ka koi saaf signal nahi.')); lines.push('US ' + sg(us.avg) + '%'); }
    else tile('gp-us', 'US', 'wait', '--', 'US data abhi aa raha hai…');
    if (eu) { tile('gp-eu', 'EUROPE', tri(eu.avg, 0.4, -0.4), sg(eu.avg) + '%', 'DAX aur FTSE ka average ' + sg(eu.avg) + '%.'); lines.push('Europe ' + sg(eu.avg) + '%'); }
    else tile('gp-eu', 'EUROPE', 'wait', '--', 'Europe data abhi aa raha hai…');
    if (as) { tile('gp-as', 'ASIA', tri(as.avg, 0.4, -0.4), sg(as.avg) + '%', 'Nikkei, Hang Seng aur Shanghai ka average ' + sg(as.avg) + '%.'); lines.push('Asia ' + sg(as.avg) + '%'); }
    else tile('gp-as', 'ASIA', 'wait', '--', 'Asia data abhi aa raha hai…');
    if (gift !== null) { tile('gp-gift', 'GIFT NIFTY', tri(gift, 0.3, -0.3), sg(gift) + '%', 'GIFT Nifty ' + sg(gift) + '%. Ye Nifty ka sabse seedha sanket hai — agle open ka andaza (pakka nahi).'); lines.push('GIFT Nifty ' + sg(gift) + '%'); }
    else tile('gp-gift', 'GIFT NIFTY', 'wait', '--', 'GIFT Nifty data abhi aa raha hai…');

    // rupee: USD/INR UP = rupee weak = headwind for Nifty
    var fx = g.currency ? chg(g.currency.usdinr) : null, fxPx = g.currency && g.currency.usdinr ? n(g.currency.usdinr.price) : null, dxy = g.currency ? chg(g.currency.dxy) : null;
    if (fx !== null) {
      var fxCls = fx > 0.3 ? 'bear' : fx < -0.3 ? 'bull' : 'neu';
      tile('gp-fx', 'RUPEE', fxCls, fx > 0.3 ? 'Kamzor ↓' : fx < -0.3 ? 'Mazboot ↑' : 'Sthir',
        'USD/INR ' + (fxPx !== null ? '₹' + fxPx + ' ' : '') + '(' + sg(fx) + '%). ' + (fx > 0.3 ? 'Dollar mehenga = rupee kamzor — FII bechne ka dabav ho sakta hai.' : fx < -0.3 ? 'Dollar sasta = rupee mazboot — FII ke liye achha.' : 'Rupee lagbhag sthir.') + (dxy !== null ? ' Dollar Index ' + sg(dxy) + '%.' : ''));
      if (fx > 0.3 || fx < -0.3) lines.push(fx > 0 ? 'rupee kamzor' : 'rupee mazboot');
    } else tile('gp-fx', 'RUPEE', 'wait', '--', 'USD/INR data abhi aa raha hai…');

    // crude: India imports oil, so a sharp rise is a mild headwind
    var cr = g.commodities ? chg(g.commodities.crude) : null;
    if (cr !== null) {
      var crCls = cr > 1.5 ? 'bear' : cr < -1.5 ? 'bull' : 'neu';
      tile('gp-cr', 'CRUDE', crCls, sg(cr) + '%', 'Crude ' + sg(cr) + '%. India tel import karta hai, isliye tel ka tez mehenga hona Nifty ke liye halka headwind hai (aur sasta hona halka sahara).');
      lines.push('Crude ' + sg(cr) + '%');
    } else tile('gp-cr', 'CRUDE', 'wait', '--', 'Crude data abhi aa raha hai…');

    // next big event (does not count in the bull/bear tally)
    var ne = nextEvent(s.calendarEvents, nowMs);
    if (Array.isArray(s.calendarEvents) && s.calendarEvents.length) {
      if (ne) {
        var when = ne.days === 0 ? 'aaj' : ne.days === 1 ? 'kal' : ne.days + ' din baad';
        var evCls = ne.days <= 1 ? (/high/i.test(ne.ev.impact) ? 'bear' : 'neu') : 'bull';
        tile('gp-ev', 'NEXT EVENT', evCls, when.toUpperCase() + (ne.ev.time && ne.ev.time !== '--:--' ? ' ' + ne.ev.time : ''),
          ne.ev.title + ' (' + ne.ev.country + ', ' + ne.ev.impact + ' impact) — ' + when + (ne.ev.time && ne.ev.time !== '--:--' ? ' ' + ne.ev.time + ' IST' : '') + '. ' + (ne.days <= 1 ? 'Event se pehle chhota size ya wait behtar rehta hai.' : 'Abhi paas mein koi bada event nahi.'), false);
        if (ne.days <= 1) chips.push({ t: '📅 ' + ne.ev.title + ' ' + when + (ne.ev.time && ne.ev.time !== '--:--' ? ' ' + ne.ev.time : ''), c: ne.days === 0 || /high/i.test(ne.ev.impact) ? 'var(--red)' : 'var(--amber)' });
      } else tile('gp-ev', 'NEXT EVENT', 'bull', 'CLEAR', 'Aage koi high/medium impact event calendar mein nahi.', false);
    } else tile('gp-ev', 'NEXT EVENT', 'wait', '--', 'Calendar data abhi aa raha hai…', false);

    var counted = tiles.filter(function (t) { return t.counts; });
    var bull = counted.filter(function (t) { return t.cls === 'bull'; }).length, bear = counted.filter(function (t) { return t.cls === 'bear'; }).length;
    var live = counted.filter(function (t) { return t.cls !== 'wait'; }).length, neu = live - bull - bear;
    var diff = bull - bear, verdict, cls;
    if (live < 3) { verdict = 'Collecting data…'; cls = ''; }
    else if (diff >= 3) { verdict = '🟢 Global cues mazboot'; cls = 'bull'; }
    else if (diff >= 1) { verdict = '🟡 Global cues halke positive'; cls = ''; }
    else if (diff <= -3) { verdict = '🔴 Global cues kamzor'; cls = 'bear'; }
    else if (diff <= -1) { verdict = '🟠 Global cues halke negative'; cls = ''; }
    else { verdict = '⚪ Global cues mixed'; cls = ''; }

    // the world is up but the GIFT Nifty (Nifty's own signal) is down, or the reverse
    var world = [us, eu, as].filter(Boolean).filter(function (x) { return x.avg >= 0.4; }).length, worldDn = [us, eu, as].filter(Boolean).filter(function (x) { return x.avg <= -0.4; }).length;
    if (gift !== null && world >= 2 && gift <= -0.3) chips.push({ t: '⚠️ Duniya upar par GIFT Nifty neeche — Nifty ke liye neeche ka sanket', c: 'var(--amber)' });
    if (gift !== null && worldDn >= 2 && gift >= 0.3) chips.push({ t: '⚠️ Duniya neeche par GIFT Nifty upar — Nifty ka apna mood alag', c: 'var(--amber)' });
    return { verdict: verdict, cls: cls, bull: bull, bear: bear, neu: neu, live: live, tiles: tiles, lines: lines, chips: chips };
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  var lastTiles = [];
  function injectCss() {
    if (document.getElementById('gp-css')) return;
    var st = document.createElement('style'); st.id = 'gp-css';
    st.textContent = '#gp-card{margin-bottom:8px}#gp-card .pulse-grid{grid-template-columns:repeat(3,1fr)}@media(min-width:560px){#gp-card .pulse-grid{grid-template-columns:repeat(7,1fr)}}#gp-note{font-size:10.5px;color:var(--dim);opacity:.75;line-height:1.4;margin-top:8px}';
    document.head.appendChild(st);
  }
  function ensureMarkup(host) {
    if (host.getAttribute('data-gp')) return;
    host.setAttribute('data-gp', '1');
    host.innerHTML = '<div class="pulse-card" id="gp-box"><div class="pulse-head"><div class="pulse-verdict" id="gp-verdict">Collecting data…</div><div class="pulse-count" id="gp-count">--</div></div>'
      + '<div class="pulse-tally"><div class="pt-bull" id="gp-t-bull" style="width:0%"></div><div class="pt-neu" id="gp-t-neu" style="width:100%"></div><div class="pt-bear" id="gp-t-bear" style="width:0%"></div></div>'
      + '<div class="pulse-tally-lab"><span style="color:var(--green)">BULL <b id="gp-n-bull">0</b></span><span style="color:var(--dim)">NEUTRAL <b id="gp-n-neu">0</b></span><span style="color:var(--red)">BEAR <b id="gp-n-bear">0</b></span></div>'
      + '<div class="pulse-sum" id="gp-sum">Waiting for global data…</div><div class="pulse-extra" id="gp-extra" style="display:none"></div>'
      + '<div class="pulse-grid" id="gp-grid"></div><div class="pulse-detail" id="gp-detail">Kisi tile pe tap karo — poori detail yahan dikhegi</div>'
      + '<div id="gp-note">Sirf dekhne ke liye — signals ya trades par koi asar nahi. Global cues ek sanket hain, guarantee nahi — GIFT Nifty aur Nifty ka apna chart zyada maayne rakhte hain.</div></div>';
    host.addEventListener('click', function (e) {
      var el = e.target; while (el && el !== host && !(el.getAttribute && el.getAttribute('data-gpi') !== null)) el = el.parentNode;
      if (!el || el === host) return;
      var i = Number(el.getAttribute('data-gpi')), t = lastTiles[i], d = document.getElementById('gp-detail');
      if (!t || !d) return;
      d.textContent = t.label + ' → ' + t.full;
      var all = host.querySelectorAll('#gp-grid .pt'); for (var k = 0; k < all.length; k++) all[k].classList.toggle('sel', k === i);
    });
  }
  function render(s) {
    try {
      var host = document.getElementById('gp-card'); if (!host) return;
      injectCss(); ensureMarkup(host);
      var r = compute(s); lastTiles = r.tiles;
      var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
      var w = function (id, v) { var e = document.getElementById(id); if (e) e.style.width = v + '%'; };
      var pct = function (k) { return r.live ? (100 * k / r.live) : 0; };
      w('gp-t-bull', pct(r.bull)); w('gp-t-bear', pct(r.bear)); w('gp-t-neu', r.live ? pct(r.neu) : 100);
      set('gp-n-bull', r.bull); set('gp-n-bear', r.bear); set('gp-n-neu', r.neu);
      var st = document.getElementById('status-txt'), closed = !!st && st.textContent !== 'LIVE';
      var v = document.getElementById('gp-verdict');
      if (v) { v.textContent = (closed ? '🌙 Aakhri · ' : '') + r.verdict.replace(/^[^A-Za-z]+/, function (m) { return closed ? '' : m; }); v.style.color = r.cls === 'bull' ? 'var(--green)' : r.cls === 'bear' ? 'var(--red)' : 'var(--amber)'; }
      var box = document.getElementById('gp-box'); if (box) { box.classList.remove('bull', 'bear'); if (r.cls) box.classList.add(r.cls); }
      set('gp-count', r.live ? r.live + ' indicators' : '--');
      var sum = document.getElementById('gp-sum'); if (sum) sum.textContent = r.lines.length ? r.lines.join(' · ') : 'Waiting for global data…';
      var ex = document.getElementById('gp-extra');
      if (ex) { ex.innerHTML = r.chips.map(function (c) { return '<span class="pe-chip" style="color:' + c.c + ';border-color:' + c.c + '">' + esc(c.t) + '</span>'; }).join(''); ex.style.display = r.chips.length ? 'flex' : 'none'; }
      var grid = document.getElementById('gp-grid');
      if (grid) grid.innerHTML = r.tiles.map(function (t, i) { return '<div class="pt ' + t.cls + '" data-gpi="' + i + '"><div class="pt-l">' + esc(t.label) + '</div><div class="pt-v">' + esc(t.val) + '</div></div>'; }).join('');
    } catch (e) { try { console.warn('[GlobalPulse]', e && e.message); } catch (_) {} }
  }

  var api = { compute: compute, render: render, nextEvent: nextEvent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GlobalPulse = api;
})(typeof window !== 'undefined' ? window : this);