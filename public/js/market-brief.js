/* "MARKET BRIEF" strip — display only (15 Nov 2026).
 * Two plain-Hinglish cards built ONLY from fields the server already sends in the live state (no network call, no AI, no cost):
 *   • entryWindow 'pre'    (before 09:15)  -> "SUBAH KA BRIEF"  : last close, key levels, global mood, VIX, PCR, FII+DII, today's events, expiry
 *   • entryWindow 'closed' (after 15:30 / weekend) -> "AAKHRI SESSION KI REPORT": day move and range, did price break/reclaim PDL/PDH, gap, breadth, PCR, FII+DII, health, what is next
 * During market hours the card stays hidden (the other strips handle the live session).
 * It never changes a signal, a gate, a journal row or a trade. Same state -> same words.
 * compute(s, nowMs) is pure (loadable in Node for tests); render(s) touches the DOM and never throws into the page.
 * Mount: <div id="mb-card"></div> under #gw-card. */
(function (root) {
  'use strict';

  function num(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null; }
  function field(o, k) { return o && typeof o === 'object' ? num(o[k]) : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sgn(n, d) { return (n > 0 ? '+' : '') + n.toFixed(d == null ? 0 : d); }
  function level(s, type) {
    var ls = s && s.srLevels && Array.isArray(s.srLevels.levels) ? s.srLevels.levels : [];
    for (var i = 0; i < ls.length; i++) if (ls[i] && ls[i].type === type && num(ls[i].price) !== null) return Number(ls[i].price);
    return null;
  }
  function istDate(ms) { return new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }

  // shared lines ------------------------------------------------------------
  function vixLine(s) {
    var v = num(s.vix); if (v === null || v <= 0) return null;
    var t = v < 15 ? 'shaant — premium sasta' : v < 20 ? 'normal se thoda upar — premium mehnga hone laga' : v < 25 ? 'ooncha — jhatke bade ho sakte hain' : 'bahut ooncha — size chhota rakho';
    return { k: 'vix', icon: '🌡️', title: 'VIX ' + v.toFixed(1), text: t + '.' };
  }
  function pcrLine(s) {
    var p = num(s.pcr); if (p === null || p <= 0) return null;
    var z = p > 1.3 ? 'bullish (puts zyada likhe gaye)' : p < 0.8 ? 'bearish (calls zyada likhe gaye)' : 'beech mein — koi saaf jhukaav nahi';
    var a = num(s.atmPcr);
    return { k: 'pcr', icon: '⚖️', title: 'PCR ' + p.toFixed(2) + (a !== null && a > 0 ? ' · ATM ' + a.toFixed(2) : ''), text: z + '.' };
  }
  function fiiLine(s) {
    var f = field(s.fii, 'net'), d = field(s.dii, 'net');
    if (f === null && d === null) return null;
    var tot = (f || 0) + (d || 0);
    var parts = [];
    if (f !== null) parts.push('FII ' + sgn(f) + ' Cr');
    if (d !== null) parts.push('DII ' + sgn(d) + ' Cr');
    return { k: 'fii', icon: '💼', title: 'FII + DII ' + sgn(tot) + ' Cr', text: parts.join(' · ') + '. Ye pichhle poore din ka paisa hai, aaj ki chaal nahi.' };
  }
  function nextLines(s, now) {
    var out = [];
    var dte = num(s.daysToExpiry);
    if (dte !== null && dte >= 0) {
      out.push({ k: 'exp', icon: '⏳', title: 'Weekly expiry ' + (dte < 1 ? 'aaj' : dte < 2 ? 'kal' : Math.floor(dte) + ' din mein'),
        text: dte <= 2 ? 'Expiry paas hai — premium tez ghatega (theta) aur Max Pain ke aaspaas bhav khinch sakta hai. Size chhota rakho.' : 'Abhi expiry door hai, theta dheere kaam kar raha hai.' });
    }
    var evs = Array.isArray(s.calendarEvents) ? s.calendarEvents : [];
    var today = istDate(now), lim = istDate(now + 2 * 86400000);
    var hi = evs.filter(function (e) { return e && e.impact === 'high' && e.category !== 'expiry' && e.date >= today && e.date <= lim; }).slice(0, 3);
    if (hi.length) {
      out.push({ k: 'ev', icon: '📅', title: 'Bade events (agle 2 din)',
        text: hi.map(function (e) { return (e.date === today ? 'aaj' : e.date) + (e.time ? ' ' + e.time : '') + ' — ' + String(e.title || '').slice(0, 60); }).join('; ') + '. Event ke aaspaas bhav achanak bhaag sakta hai.' });
    }
    return out;
  }

  // 1) subah ka brief --------------------------------------------------------
  function brief(s, now) {
    var items = [];
    var close = num(s.lastClose) || num(s.nifty), chg = num(s.change), pct = num(s.changePct);
    if (close !== null && close > 0) {
      items.push({ k: 'close', icon: '🔔', title: 'Kal ka close ' + close.toFixed(0) + (chg !== null && pct !== null ? ' (' + sgn(chg) + ' pts, ' + sgn(pct, 2) + '%)' : ''),
        text: 'Aaj ka gap isi se naapa jayega. 09:15–10:00 gap-fill window hai, engine 10:00 tak wait karta hai.' });
    }
    var pdl = level(s, 'PDL'), pdh = level(s, 'PDH'), mp = level(s, 'MP');
    var ls = [];
    if (pdh !== null) ls.push('kal ka high ' + Math.round(pdh));
    if (pdl !== null) ls.push('kal ka low ' + Math.round(pdl));
    if (mp !== null) ls.push('Max Pain ' + Math.round(mp));
    if (ls.length) items.push({ k: 'lvl', icon: '📍', title: 'Aaj ke levels', text: ls.join(' · ') + '. In par bhav ruk ya palat sakta hai; toot-te dikhe to 15-minute candle ke band hone ka wait karo.' });
    var g = s.global && s.global.bias;
    if (g) items.push({ k: 'glob', icon: '🌍', title: 'Global mood: ' + g, text: g === 'BULLISH' ? 'Duniya ke bazaar mazboot hain — opening ko sahara mil sakta hai.' : g === 'BEARISH' ? 'Duniya ke bazaar kamzor hain — opening par dabaav aa sakta hai.' : 'Duniya ke bazaar mile-jule hain.' });
    [vixLine(s), pcrLine(s), fiiLine(s)].forEach(function (x) { if (x) items.push(x); });
    nextLines(s, now).forEach(function (x) { items.push(x); });
    return items.length ? { show: true, mode: 'brief', title: 'SUBAH KA BRIEF', items: items } : { show: false };
  }

  // 2) aakhri session ki report ---------------------------------------------
  function report(s, now) {
    var items = [];
    var chg = num(s.change), pct = num(s.changePct), px = num(s.nifty);
    var lo = num(s.wsLow), hi = num(s.wsHigh);
    if (lo !== null && lo <= 0) lo = null;
    if (hi !== null && hi <= 0) hi = null;
    if (px !== null && px > 0 && chg !== null && pct !== null) {
      var rng = lo !== null && hi !== null && hi >= lo ? ' · din ka range ' + Math.round(lo) + '–' + Math.round(hi) + ' (' + Math.round(hi - lo) + ' pts)' : '';
      items.push({ k: 'day', icon: chg >= 0 ? '📈' : '📉', title: 'Nifty ' + px.toFixed(0) + ' (' + sgn(chg) + ' pts, ' + sgn(pct, 2) + '%)', text: 'Din ' + (chg >= 0 ? 'upar' : 'neeche') + ' band hua' + rng + '.' });
    }
    var pg = s.premarketGap, gp = pg && pg.available ? field(pg, 'gapPct') : null;
    if (gp !== null && Math.abs(gp) >= 0.3) items.push({ k: 'gap', icon: gp < 0 ? '⬇️' : '⬆️', title: (gp < 0 ? 'Gap-down ' : 'Gap-up ') + Math.abs(gp).toFixed(2) + '% khula', text: 'Aise din pehle 45 minute ke jhatke se bacho, 10:00 ke baad hi entry sochna.' });
    var pdl = level(s, 'PDL'), pdh = level(s, 'PDH');
    if (pdl !== null && lo !== null && lo < pdl - 10) {
      items.push({ k: 'pdl', icon: '🧱', title: 'Kal ka low (' + Math.round(pdl) + ') toota',
        text: 'Din ka low ' + Math.round(lo) + ' gaya (' + Math.round(pdl - lo) + ' pts neeche). ' + (px !== null && px >= pdl ? 'Bhav wapas upar band hua — jhoota breakdown nikla.' : 'Bhav neeche hi band hua — breakdown tikka.') });
    }
    if (pdh !== null && hi !== null && hi > pdh + 10) {
      items.push({ k: 'pdh', icon: '🧱', title: 'Kal ka high (' + Math.round(pdh) + ') paar hua',
        text: 'Din ka high ' + Math.round(hi) + ' gaya (' + Math.round(hi - pdh) + ' pts upar). ' + (px !== null && px <= pdh ? 'Bhav wapas neeche band hua — jhoota breakout nikla.' : 'Bhav upar hi band hua — breakout tikka.') });
    }
    var adv = field(s.breadth, 'advances'), dec = field(s.breadth, 'declines');
    if (adv !== null && dec !== null && adv + dec > 0) items.push({ k: 'br', icon: '📊', title: 'Breadth ' + adv + '↑ / ' + dec + '↓', text: adv > dec * 1.5 ? 'Zyadatar stocks upar the — move kaafi stocks mein tha.' : dec > adv * 1.5 ? 'Zyadatar stocks neeche the — kamzori kaafi stocks mein thi.' : 'Stocks mile-jule rahe.' });
    var tp = field(s.dayType, 'trendProbability'), rp = field(s.dayType, 'rangeProbability');
    if (tp !== null && rp !== null && tp + rp > 0) items.push({ k: 'dt', icon: '🧭', title: 'Din ka type: trend ' + Math.round(tp) + '% / range ' + Math.round(rp) + '%', text: tp >= rp ? 'Din trend jaisa raha.' : 'Din range (idhar-udhar) jaisa raha.' });
    var mh = s.marketHealth, mt = field(mh, 'total');
    if (mt !== null) items.push({ k: 'mh', icon: '🩺', title: 'Market health ' + Math.round(mt) + '/100', text: (mh.label || '') + '.' });
    [pcrLine(s), vixLine(s), fiiLine(s)].forEach(function (x) { if (x) items.push(x); });
    nextLines(s, now).forEach(function (x) { items.push(x); });
    return items.length ? { show: true, mode: 'report', title: 'AAKHRI SESSION KI REPORT', items: items } : { show: false };
  }

  function compute(s, nowMs) {
    s = s || {};
    var st = s.entryWindow && s.entryWindow.status;
    var now = num(nowMs) !== null ? Number(nowMs) : Date.now();
    if (st === 'pre') return brief(s, now);
    if (st === 'closed') return report(s, now);
    return { show: false };
  }

  // ── DOM ──
  var cssDone = false;
  function injectCss() {
    if (cssDone || typeof document === 'undefined') return; cssDone = true;
    var st = document.createElement('style');
    st.textContent =
      '.mb-box{margin-top:8px;border:1px solid var(--border,rgba(255,255,255,0.15));border-radius:10px;background:var(--bg2);padding:9px 12px 10px;text-align:left;}' +
      '.mb-h{font-family:\'Orbitron\',monospace;font-size:11px;letter-spacing:1.4px;color:var(--cyan,#4fd1ff);margin-bottom:6px;}' +
      '.mb-item{margin-bottom:7px;}.mb-t{font-size:13px;font-weight:600;color:var(--text);}' +
      '.mb-x{font-size:12.5px;line-height:1.45;color:var(--dim);}' +
      '.mb-n{font-size:11.5px;color:var(--dim);margin-top:4px;}';
    document.head.appendChild(st);
  }
  function html(r) {
    return '<div class="mb-box"><div class="mb-h">' + esc(r.title) + '</div>' +
      r.items.map(function (x) { return '<div class="mb-item"><div class="mb-t">' + x.icon + ' ' + esc(x.title) + '</div><div class="mb-x">' + esc(x.text) + '</div></div>'; }).join('') +
      '<div class="mb-n">Sirf dekhne ke liye — signal, gate ya trade par koi asar nahi.</div></div>';
  }
  function render(s) {
    try {
      if (typeof document === 'undefined') return;
      var host = document.getElementById('mb-card'); if (!host) return;
      var r = compute(s);
      if (!r.show) { host.innerHTML = ''; host.style.display = 'none'; return; }
      injectCss();
      host.style.display = 'block';
      host.innerHTML = html(r);
    } catch (e) { try { console.warn('[MarketBrief]', e && e.message); } catch (_) {} }
  }

  var api = { compute: compute, render: render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MarketBrief = api;
})(typeof window !== 'undefined' ? window : this);
