/* Smart Money card notes — display only (15 Nov 2026).
 * The Institutional Bias card hides the FII / DII / PCR rows (11 Oct) but their points are still inside the score, and at night both visible rows
 * just say "Awaiting data". This adds three plain-Hinglish helpers, built only from fields the server already sends (smartMoney.components,
 * signal, reason[], entryWindow). It makes no network call and never changes a score, a signal, a gate or a trade.
 *   • closedText   — "Market band — data 09:15 ke baad" instead of a bare "Awaiting data" before/after the session
 *   • scoreLine    — "Score = live (OI + ATM flow) + background (FII+DII pichhle din ka, PCR)" so the number is explainable
 *   • effectLine   — what Smart Money did to the CURRENT signal's confidence (server only applies it when the signal is not WAIT)
 * compute() is pure (loadable in Node for tests). */
(function (root) {
  'use strict';
  var BG = ['FII Flow', 'DII Flow', 'PCR Level'];
  function num(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null; }
  function sgn(n) { return (n > 0 ? '+' : '') + n; }
  function clean(r) { return String(r == null ? '' : r).replace(/<[^>]*>/g, '').trim(); }

  function compute(sm, s) {
    sm = sm || {}; s = s || {};
    var comps = Array.isArray(sm.components) ? sm.components : [];
    var bg = 0, live = 0;
    comps.forEach(function (c) {
      var p = c && num(c.pts); if (p === null) return;
      if (BG.indexOf(c.label) >= 0) bg += p; else live += p;
    });
    var total = num(sm.score); if (total === null) total = live + bg;
    var st = s.entryWindow && s.entryWindow.status;
    var closed = st === 'closed' || st === 'pre';

    var scoreLine = bg !== 0
      ? 'Score ' + sgn(total) + ' = live ' + sgn(live) + ' (OI + ATM flow) ' + (bg > 0 ? '+ ' : '− ') + 'background ' + Math.abs(bg) + ' (FII+DII pichhle din ka, PCR). Din bhar live asar sirf OI aur ATM flow ka hai.'
      : null;

    var sig = s.signal, effectLine;
    if (!sig || sig === 'WAIT') {
      effectLine = 'Abhi signal WAIT hai — Smart Money ka confidence par koi asar nahi (ye tabhi lagta hai jab BUY CALL / BUY PUT ban raha ho).';
    } else {
      var rs = Array.isArray(s.reason) ? s.reason : [];
      var hit = null;
      for (var i = 0; i < rs.length; i++) if (/Smart Money/i.test(String(rs[i]))) { hit = clean(rs[i]); break; }
      effectLine = hit ? 'Is signal par asar: ' + hit : 'Is signal par Smart Money ne confidence nahi badla (neutral).';
    }
    return { scoreLine: scoreLine, effectLine: effectLine, closedText: closed ? 'Market band — data 09:15 ke baad' : null, live: live, bg: bg, total: total };
  }

  var api = { compute: compute };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SmNotes = api;
})(typeof window !== 'undefined' ? window : this);
