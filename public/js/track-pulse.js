/* 📋 "Track Record Pulse" card — display only (13 Oct).
 * One plain-language read of the whole Track Record tab: for every trigger / engine, "can this be luck?".
 * It only RE-READS what /api/signal-accuracy (per-source rows) and /api/engine-track-record (Main / MTF / Classic) already return.
 * It never changes a signal, a mute or a trade.
 *
 * How a source is graded (cautious on purpose — a track record is measured, not proven):
 *   ⚪ too little data    fewer than 10 resolved fires
 *   🟢 good signs         30+ fires, the direction win-rate's 95% range sits fully above 50% AND the Trade-Coach average is positive
 *   🔴 losing             30+ fires and the Trade-Coach average is -1.5% or worse (or the 95% range sits fully below 50%)
 *   🟡 undecided          everything else (10+ fires but the range still includes a coin-flip, or the signs disagree)
 * The 95% range is the Wilson interval for the direction win-rate: with n=20 and 60% wins the real rate could still be ~39–78%.
 * Many sources are graded at once, so one or two will look "good" by pure chance — treat 🟢 as "worth a closer look", never as proof.
 *
 * compute() is pure (loadable in Node for tests); update()/render() touch the DOM and never throw into the page.
 * Mount point: <div id="tp2-card"></div> at the top of the Track Record tab. Reuses the Pulse card styles of index.html. */
(function (root) {
  'use strict';
  function n(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sg(v, d) { if (v === null) return '--'; var x = Math.round(v * (d || 10)) / (d || 10); return (x > 0 ? '+' : '') + x + '%'; }

  var MIN_N = 10, SOLID_N = 30, Z = 1.96;
  var BAD_AVG = 1.5;   // a Trade-Coach average only counts as 'losing' at -1.5% or worse (a -0.5% average is inside the noise of a few hundred option trades)

  // Wilson 95% interval for a win-rate (wins out of nn). Returns [lo, hi] as fractions, or null.
  function wilson(wins, nn) {
    if (!(nn > 0) || wins < 0 || wins > nn) return null;
    var p = wins / nn, z2 = Z * Z, den = 1 + z2 / nn;
    var c = (p + z2 / (2 * nn)) / den, h = Z * Math.sqrt(p * (1 - p) / nn + z2 / (4 * nn * nn)) / den;
    return [Math.max(0, c - h), Math.min(1, c + h)];
  }

  // One grading rule for every kind of row. in: { name, wins, nDir, coachAvg, coachN }
  function grade(x) {
    var nDir = x.nDir || 0, ci = wilson(x.wins || 0, nDir), ca = n(x.coachAvg);
    var g;
    if (nDir < MIN_N) g = { k: 'few', icon: '⚪', label: 'bahut kam data' };
    else if (nDir >= SOLID_N && ca !== null && ca > 0 && ci && ci[0] > 0.5) g = { k: 'good', icon: '🟢', label: 'achhe sanket' };
    else if (nDir >= SOLID_N && ((ca !== null && ca <= -BAD_AVG) || (ci && ci[1] < 0.5))) g = { k: 'bad', icon: '🔴', label: 'ghate mein' };
    else g = { k: 'mid', icon: '🟡', label: 'tay nahi' };
    g.ci = ci; g.n = nDir; g.winPct = nDir ? Math.round(x.wins / nDir * 100) : null; g.coachAvg = ca; g.coachN = x.coachN || 0; g.name = x.name;
    return g;
  }
  function rangeTxt(g) { return g.ci ? Math.round(g.ci[0] * 100) + '–' + Math.round(g.ci[1] * 100) + '%' : '--'; }
  function line(g) {
    return g.icon + ' ' + g.name + ' — ' + g.label + ' (win ' + (g.winPct === null ? '--' : g.winPct + '%') + ', n=' + g.n + ', asli range ' + rangeTxt(g) +
      (g.coachAvg !== null ? ', Coach avg ' + sg(g.coachAvg) + ' n=' + g.coachN : '') + ')';
  }

  // Pure: sa = /api/signal-accuracy rows[], etr = /api/engine-track-record payload -> card model
  function compute(sa, etr) {
    var rows = Array.isArray(sa) ? sa : [], tiles = [], chips = [], all = [];
    var byInst = {};
    rows.forEach(function (r) {
      if (!r || !r.source) return;
      var wins = n(r.win_count) || 0, losses = n(r.loss_count) || 0;
      var g = grade({ name: r.source, wins: wins, nDir: wins + losses, coachAvg: r.avg_coach_pct_move, coachN: n(r.coach_resolved_count) || 0 });
      g.muted = !!r.muted; g.instrument = String(r.instrument || '?').toUpperCase();
      (byInst[g.instrument] || (byInst[g.instrument] = [])).push(g); all.push(g);
    });
    var count = function (a, k) { return a.filter(function (g) { return g.k === k; }).length; };
    var tileOf = function (id, label, a) {
      var s = count(a, 'good') + '🟢 ' + count(a, 'mid') + '🟡 ' + count(a, 'bad') + '🔴';
      var cls = !a.length ? 'wait' : count(a, 'bad') > count(a, 'good') ? 'bear' : count(a, 'good') ? 'bull' : 'neu';
      var full = !a.length ? label + ': abhi koi data nahi.' : label + ' — ' + a.length + ' source (' + count(a, 'few') + ' mein bahut kam data ⚪):\n' + a.slice().sort(function (x, y) { return y.n - x.n; }).map(line).join('\n');
      return { id: id, label: label, cls: cls, val: a.length ? s : '--', full: full };
    };
    ['NIFTY', 'CRUDE', 'BITCOIN'].forEach(function (k) { tiles.push(tileOf('tp2-' + k.toLowerCase(), k, byInst[k] || [])); });

    // engines (Main / MTF tracker rows + Classic)
    var eg = [], E = etr && etr.engines ? etr.engines : null;
    if (E) {
      ['main', 'mtf'].forEach(function (k) {
        var e = E[k]; if (!e || !(n(e.total) > 0)) return;
        var w = Math.round((n(e.winPct) || 0) * e.total / 100);
        eg.push(grade({ name: e.label || k, wins: w, nDir: e.total, coachAvg: e.avgResultPct, coachN: n(e.resultN) || 0 }));
      });
      var c = E.classic && E.classic.all;
      if (c && n(c.resolved) > 0) {
        var cw = n(c.wins) !== null ? c.wins : Math.round((n(c.dirWinPct) || 0) * c.resolved / 100);
        eg.push(grade({ name: (E.classic.label || 'Classic') + ' (sim)', wins: cw, nDir: c.resolved, coachAvg: c.avgCoachPct, coachN: n(c.coachN) || 0 }));
      }
    }
    var et = tileOf('tp2-eng', 'ENGINES', eg); tiles.push(et);
    var muted = all.filter(function (g) { return g.muted; });
    tiles.push({ id: 'tp2-mute', label: 'MUTED', cls: muted.length ? 'neu' : 'wait', val: String(muted.length),
      full: muted.length ? 'Auto-mute ne ye source band kiye: ' + muted.map(function (g) { return g.name + ' (' + g.instrument + ')'; }).join(', ') + '.' : 'Koi source auto-mute nahi hai.' });

    var everything = all.concat(eg);
    var tot = { good: count(everything, 'good'), mid: count(everything, 'mid'), bad: count(everything, 'bad'), few: count(everything, 'few') };
    var verdict, cls = '';
    if (!everything.length) verdict = '⏳ Track record abhi ban raha hai';
    else if (tot.good === 0 && tot.bad === 0) verdict = '🟡 Abhi koi source pakka nahi — zyada data chahiye';
    else if (tot.bad > tot.good) { verdict = '🔴 Zyadatar solid sources ghate mein'; cls = 'bear'; }
    else if (tot.good > 0 && tot.bad === 0) { verdict = '🟢 Kuch sources ke achhe sanket (proof nahi)'; cls = 'bull'; }
    else verdict = '🟡 Mixed — kuch achhe, kuch kharab';
    var sum = everything.length ? everything.length + ' source/engine · ' + tot.good + ' achhe · ' + tot.mid + ' tay nahi · ' + tot.bad + ' ghate mein · ' + tot.few + ' bahut kam data' : 'Data ka intezaar…';

    // best / worst by Trade-Coach average, only where there are 10+ coach-resolved fires
    var withCoach = all.filter(function (g) { return g.coachAvg !== null && g.coachN >= MIN_N; }).sort(function (a, b) { return b.coachAvg - a.coachAvg; });
    if (withCoach.length >= 2) {
      var b = withCoach[0], w = withCoach[withCoach.length - 1];
      chips.push({ t: '🏆 ' + b.name + ' (' + b.instrument + ') Coach avg ' + sg(b.coachAvg) + ' · n=' + b.coachN, c: 'var(--green)' });
      if (w.coachAvg < 0) chips.push({ t: '⚠️ ' + w.name + ' (' + w.instrument + ') Coach avg ' + sg(w.coachAvg) + ' · n=' + w.coachN, c: 'var(--red)' });
    }
    var thin = all.filter(function (g) { return g.k === 'few'; }).length;
    if (thin >= 3) chips.push({ t: '🧪 ' + thin + ' source mein 10 se kam fires — abhi mat padhna', c: 'var(--dim)' });
    // luck warning: how many "good" would appear by chance among that many tested sources
    var tested = all.filter(function (g) { return g.n >= SOLID_N; }).length;
    if (tested >= 6) chips.push({ t: '🎲 ' + tested + ' source saath mein tested — 1–2 sirf luck se achhe dikh sakte hain', c: 'var(--amber)' });
    return { verdict: verdict, cls: cls, count: everything.length ? String(everything.length) : '--', sum: sum, tiles: tiles, chips: chips, totals: tot, graded: all, engines: eg };
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  var data = { sa: null, etr: null }, lastTiles = [], selId = null;
  function $(id) { return document.getElementById(id); }
  function injectCss() {
    if ($('tp2-css')) return;
    var st = document.createElement('style'); st.id = 'tp2-css';
    st.textContent = '#tp2-card{margin-bottom:14px}#tp2-card .pulse-grid{grid-template-columns:repeat(3,1fr)}@media(min-width:560px){#tp2-card .pulse-grid{grid-template-columns:repeat(6,1fr)}}#tp2-detail{white-space:pre-line}#tp2-card .pt-v{font-size:12px}.tp2-note{font-size:10.5px;color:var(--dim);opacity:.75;line-height:1.4;margin-top:8px}';
    document.head.appendChild(st);
  }
  function ensureMarkup(host) {
    if (host.getAttribute('data-tp2')) return;
    host.setAttribute('data-tp2', '1');
    host.innerHTML = '<div class="pulse-card" id="tp2-box"><div class="pulse-head"><div class="pulse-verdict" id="tp2-verdict">Collecting data…</div><div class="pulse-count" id="tp2-count">--</div></div>'
      + '<div class="pulse-sum" id="tp2-sum">Waiting for data…</div><div class="pulse-extra" id="tp2-extra" style="display:none"></div>'
      + '<div class="pulse-grid" id="tp2-grid"></div><div class="pulse-detail" id="tp2-detail">Kisi tile pe tap karo — har source ka "luck ho sakta hai?" hisaab dikhega</div>'
      + '<div class="tp2-note">Sirf dekhne ke liye — signals, mute ya trades par koi asar nahi. "Asli range" = 95% sambhavit range (win-rate sirf sample se ek andaaza hai). 🟢 = kaafi data + range 50% se upar + Coach avg positive; ye saboot nahi, sirf "dhyan se dekhne layak" hai.</div></div>';
    host.addEventListener('click', function (e) {
      var el = e.target; while (el && el !== host && !(el.getAttribute && el.getAttribute('data-tid') !== null)) el = el.parentNode;
      if (!el || el === host) return;
      selId = el.getAttribute('data-tid'); paintDetail();
      var all = host.querySelectorAll('.pt'); for (var k = 0; k < all.length; k++) all[k].classList.toggle('sel', all[k].getAttribute('data-tid') === selId);
    });
  }
  function paintDetail() {
    var d = $('tp2-detail'); if (!d) return;
    var t = lastTiles.filter(function (x) { return x.id === selId; })[0];
    if (t) d.textContent = t.label + ' → ' + t.full;
  }
  function render() {
    try {
      var host = $('tp2-card'); if (!host) return;
      if (!data.sa && !data.etr) return;
      injectCss(); ensureMarkup(host);
      var r = compute(data.sa, data.etr); lastTiles = r.tiles;
      var v = $('tp2-verdict'); v.textContent = r.verdict; v.style.color = r.cls === 'bull' ? 'var(--green)' : r.cls === 'bear' ? 'var(--red)' : 'var(--amber)';
      var box = $('tp2-box'); box.classList.remove('bull', 'bear'); if (r.cls) box.classList.add(r.cls);
      $('tp2-count').textContent = r.count; $('tp2-sum').textContent = r.sum;
      var ex = $('tp2-extra'); ex.innerHTML = r.chips.map(function (c) { return '<span class="pe-chip" style="color:' + c.c + ';border-color:' + c.c + '">' + esc(c.t) + '</span>'; }).join(''); ex.style.display = r.chips.length ? 'flex' : 'none';
      $('tp2-grid').innerHTML = r.tiles.map(function (t) { return '<div class="pt ' + t.cls + (t.id === selId ? ' sel' : '') + '" data-tid="' + esc(t.id) + '"><div class="pt-l">' + esc(t.label) + '</div><div class="pt-v">' + esc(t.val) + '</div></div>'; }).join('');
      paintDetail();
    } catch (e) { try { console.warn('[TrackPulse]', e && e.message); } catch (_) {} }
  }
  // update({ sa: rows[] }) and/or update({ etr: payload }) — whichever fetch finished
  function update(o) { try { if (o && o.sa) data.sa = o.sa; if (o && o.etr) data.etr = o.etr; render(); } catch (e) { try { console.warn('[TrackPulse]', e && e.message); } catch (_) {} } }

  var api = { compute: compute, grade: grade, wilson: wilson, update: update, render: render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TrackPulse = api;
})(typeof window !== 'undefined' ? window : this);