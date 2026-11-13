/* ⚠️ "GAP + LEVEL WATCH" strip — display only (14 Nov 2026).
 * Built after 13 Nov: a gap-down open flushed Nifty through Prev Day Low (25143) down to 25077 in 5 minutes, then reclaimed it by 09:35.
 * Anyone who sold into the break (bought PUTs) before 10:00 was caught. The app itself waited until 10:03 (Murarka gap-fill window), but nothing
 * on the screen SAID why the early move was dangerous. This strip says it, in plain Hinglish, using only fields the server already sends:
 *   • gap       — marketState.premarketGap (open vs prev close), shown only in the 09:15–10:00 window and only for a gap of 0.3% or more
 *   • break     — price is below Prev Day Low (or above Prev Day High) with the day's extreme beyond it, during 09:15–10:00
 *   • reclaim   — the day's low went under PDL (or the high over PDH) by 10+ pts but price is back on the right side of it = "jhoota breakout/breakdown"
 * It makes NO network call, uses NO AI, and never changes a signal, a gate, a journal row or a trade. Same state -> same words.
 * compute() is pure (loadable in Node for tests); render() touches the DOM and never throws into the page.
 * Mount: <div id="gw-card"></div> right under #ws-card. */
(function (root) {
  'use strict';
  var GAP_MIN = 0.3;     // % — below this a gap is ordinary (the server's own GAP_UP/GAP_DOWN zone starts at 0.15)
  var BREAK_PTS = 10;    // how far the day's extreme must go past PDL/PDH to count as a real break

  function num(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function level(s, type) {
    var ls = s && s.srLevels && Array.isArray(s.srLevels.levels) ? s.srLevels.levels : [];
    for (var i = 0; i < ls.length; i++) if (ls[i] && ls[i].type === type && num(ls[i].price) !== null) return Number(ls[i].price);
    return null;
  }

  function compute(s) {
    s = s || {};
    var ew = s.entryWindow || {};
    if (!ew.status || ew.status === 'closed' || ew.status === 'pre') return { show: false };
    var early = ew.status === 'volatile';                // 09:15–10:00
    var price = num(s.nifty), lo = num(s.wsLow), hi = num(s.wsHigh);
    if (price !== null && price <= 0) price = null;
    if (lo !== null && lo <= 0) lo = null;
    if (hi !== null && hi <= 0) hi = null;
    var pdl = level(s, 'PDL'), pdh = level(s, 'PDH');
    var items = [];

    // 1) gap — only before 10:00
    var pg = s.premarketGap, gp = pg && pg.available ? num(pg.gapPct) : null;
    if (early && gp !== null && Math.abs(gp) >= GAP_MIN) {
      var down = gp < 0, pts = num(pg.gapPts);
      items.push({
        k: 'gap', icon: down ? '📉' : '📈',
        title: (down ? 'GAP-DOWN ' : 'GAP-UP ') + Math.abs(gp).toFixed(2) + '%' + (pts !== null ? ' (' + (pts > 0 ? '+' : '') + pts.toFixed(0) + ' pts)' : ''),
        text: 'Bazaar kal ke close se ' + (down ? 'neeche' : 'upar') + ' khula. Pehle 45 minute mein bhav aksar gap bharne ko ' + (down ? 'wapas upar' : 'wapas neeche') +
              ' palat jaata hai, aur beech mein ek tez jhatka (flush) aam hai. Engine 10:00 tak intezaar karta hai — apni entry bhi 10:00 ke baad hi sochna.'
      });
    }

    // 2) levels — break in progress (early) and false break / reclaim (any time)
    if (price !== null) {
      if (pdl !== null) {
        if (early && price < pdl) {
          items.push({
            k: 'brk-dn', icon: '⚠️', title: 'KAL KA LOW (' + Math.round(pdl) + ') TOOTA HUA HAI',
            text: 'Bhav abhi ' + Math.round(price) + ' par hai, kal ke low se ' + Math.round(pdl - price) + ' pts neeche. Subah ke pehle 45 minute mein aisa breakdown aksar palat jaata hai — ' +
                  'ek 15-minute candle PDL ke neeche band hone se pehle ise pakka mat maano, aur girte bhav ke peeche PUT mat daudao.'
          });
        } else if (lo !== null && lo < pdl - BREAK_PTS && price >= pdl) {
          items.push({
            k: 'reclaim-dn', icon: '🔄', title: 'JHOOTA BREAKDOWN? — PDL WAPAS LE LIYA',
            text: 'Din ka low ' + Math.round(lo) + ' tak gaya (kal ke low ' + Math.round(pdl) + ' se ' + Math.round(pdl - lo) + ' pts neeche), par bhav ab ' + Math.round(price) +
                  ' par wapas upar hai. Aise reclaim ke baad PUT mein naya sauda ya size badhana risky hota hai — bounce ka khatra.'
          });
        }
      }
      if (pdh !== null) {
        if (early && price > pdh) {
          items.push({
            k: 'brk-up', icon: '⚠️', title: 'KAL KA HIGH (' + Math.round(pdh) + ') PAAR HUA HAI',
            text: 'Bhav abhi ' + Math.round(price) + ' par hai, kal ke high se ' + Math.round(price - pdh) + ' pts upar. Pehle 45 minute ka breakout aksar palat jaata hai — ' +
                  'ek 15-minute candle PDH ke upar band hone se pehle pakka mat maano, aur chadhte bhav ke peeche CALL mat daudao.'
          });
        } else if (hi !== null && hi > pdh + BREAK_PTS && price <= pdh) {
          items.push({
            k: 'reclaim-up', icon: '🔄', title: 'JHOOTA BREAKOUT? — PDH WAPAS NEECHE',
            text: 'Din ka high ' + Math.round(hi) + ' tak gaya (kal ke high ' + Math.round(pdh) + ' se ' + Math.round(hi - pdh) + ' pts upar), par bhav ab ' + Math.round(price) +
                  ' par wapas neeche hai. Aise reclaim ke baad CALL mein naya sauda ya size badhana risky hota hai — palatne ka khatra.'
          });
        }
      }
    }

    if (!items.length) return { show: false };
    return { show: true, items: items };
  }

  // ── DOM ──
  var cssDone = false;
  function injectCss() {
    if (cssDone || typeof document === 'undefined') return; cssDone = true;
    var st = document.createElement('style');
    st.textContent =
      '.gw-box{margin-top:8px;border:2px solid rgba(255,187,0,0.55);border-radius:10px;background:var(--bg2);padding:9px 12px 10px;text-align:left;}' +
      '.gw-item{margin-bottom:8px;}.gw-item:last-of-type{margin-bottom:4px;}' +
      '.gw-t{font-family:\'Orbitron\',monospace;font-size:11px;letter-spacing:1.2px;color:var(--amber);margin-bottom:2px;}' +
      '.gw-x{font-size:13.5px;line-height:1.5;color:var(--text);}' +
      '.gw-n{font-size:11.5px;color:var(--dim);margin-top:4px;}';
    document.head.appendChild(st);
  }

  function html(r) {
    return '<div class="gw-box">' +
      r.items.map(function (x) { return '<div class="gw-item"><div class="gw-t">' + x.icon + ' ' + esc(x.title) + '</div><div class="gw-x">' + esc(x.text) + '</div></div>'; }).join('') +
      '<div class="gw-n">Sirf dekhne ke liye — signal, gate ya trade par koi asar nahi.</div></div>';
  }

  function render(s) {
    try {
      if (typeof document === 'undefined') return;
      var host = document.getElementById('gw-card'); if (!host) return;
      var r = compute(s);
      if (!r.show) { host.innerHTML = ''; host.style.display = 'none'; return; }
      injectCss();
      host.style.display = 'block';
      host.innerHTML = html(r);
    } catch (e) { try { console.warn('[GapWatch]', e && e.message); } catch (_) {} }
  }

  var api = { compute: compute, render: render, GAP_MIN: GAP_MIN, BREAK_PTS: BREAK_PTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GapWatch = api;
})(typeof window !== 'undefined' ? window : this);
