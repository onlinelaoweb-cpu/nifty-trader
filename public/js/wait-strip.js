/* ⏸ "WAIT strip" — display only (13 Oct 2026).
 * Under the big signal box, when the engine says WAIT, say in plain Hinglish (a child should get it):
 *   1) kyun WAIT   — the engine's own reason, translated (nothing new is decided here)
 *   2) kab badlega — what would have to change before a signal can appear
 *   3) five gate chips (✅/❌) taken from the engine's own quality gate, and how far "bharosa" (confidence) is from the 60% minimum.
 * It only RE-READS fields the server already sends (signal, confidence, reason[], qualityGate, entryWindow). It makes NO network call,
 * uses NO AI, and never changes a signal, a gate or a trade. Rule-based text, so the same state always gives the same words.
 * When a real BUY CALL / BUY PUT is showing, or the market is closed, the strip stays hidden and the big box looks as before.
 *
 * compute() is pure (loadable in Node for tests); render() touches the DOM and never throws into the page.
 * Mount: <div id="ws-card"></div> inside .signal-wrap, right under #signal-card. */
(function (root) {
  'use strict';
  var NEED = 60;   // the engine's own minimum confidence (server.js MIN_SIGNAL_CONFIDENCE / combineSignals gate)

  function num(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clean(r) { return String(r == null ? '' : r).replace(/<[^>]*>/g, '').replace(/^[\s⛔🔒⏳🚫ℹ️⚠️✅📈📉]+/u, '').trim(); }

  // Each rule: test on the engine's raw reason text -> plain-language why / unlock. First match wins (reasons are checked in priority order).
  var RULES = [
    { re: /Trend Lock:.*?(\d+)\s*min left/i, f: function (m) { return { tone: 'soon', why: 'Direction palti hai, par abhi pakki nahi hui.', unlock: 'Lagbhag ' + m[1] + ' minute mein pata chalega ki palat sachchi hai ya nahi.' }; } },
    { re: /Trend Lock/i, f: function () { return { tone: 'soon', why: 'Direction palti hai, par abhi pakki nahi hui.', unlock: 'Kuch minute mein pata chalega ki palat sachchi hai ya nahi.' }; } },
    { re: /Signal confirming/i, f: function () { return { tone: 'soon', why: 'Signal ban raha hai, bas doosri baar confirm hona baaki hai.', unlock: 'Agle 1–2 refresh mein (kuch second).' }; } },
    { re: /ADX\s*([\d.]+)\s*<\s*([\d.]+).*?(Choppy|sideways)/i, f: function (m) { return { tone: 'wait', why: 'Bazaar side-ways ghoom raha hai, koi saaf trend nahi.', unlock: 'Trend ki taakat (ADX) ' + m[1] + ' se badhkar ' + m[2] + ' ke upar jaaye.' }; } },
    { re: /MTF not aligned\s*\((\d)\/3 bull,\s*(\d)\/3 bear\)/i, f: function (m) { return { tone: 'wait', why: '5-minute, 15-minute aur 1-ghante ke chart ek taraf nahi hain (' + m[1] + ' upar, ' + m[2] + ' neeche).', unlock: 'Teeno chart ek hi taraf dikhayein.' }; } },
    { re: /RSI not aligned for (CALL|PUT)/i, f: function (m) { return { tone: 'wait', why: 'Taakat-meter (RSI) abhi ' + (m[1].toUpperCase() === 'CALL' ? 'upar' : 'neeche') + ' ke trade ke liye sahi jagah par nahi hai.', unlock: 'RSI sahi zone mein aaye.' }; } },
    { re: /VIX\s*[\d.]+\s*[≥>]=?\s*20/i, f: function () { return { tone: 'wait', why: 'Dar ka meter (VIX) 20 se upar hai, option bahut mehnge hain.', unlock: 'VIX 20 se neeche aaye.' }; } },
    { re: /Delta.*contradicts/i, f: function () { return { tone: 'wait', why: 'Khareed-bikri ka flow signal se ulta bol raha hai.', unlock: 'Flow signal ki taraf mud jaaye.' }; } },
    { re: /POC/i, f: function () { return { tone: 'wait', why: 'Bhav us level ke paas hai jahan sabse zyada sauda hua — wahan bhav aksar atakta hai.', unlock: 'Bhav us level se saaf bahar nikle.' }; } },
    { re: /Premium already \+?(\d+)%/i, f: function (m) { return { tone: 'wait', why: 'Option aaj hi ' + m[1] + '% badh chuka hai — ab ghusna late hoga.', unlock: 'Thoda pichhe hat kar (pullback) phir se bane.' }; } },
    { re: /Physics Law-3/i, f: function () { return { tone: 'wait', why: 'Bhav bhaag chuka hai — daudte bhav ke pichhe bhaagna theek nahi.', unlock: 'Bhav thoda wapas aaye (pullback).' }; } },
    { re: /Physics Law-1/i, f: function () { return { tone: 'wait', why: 'Chart ki chaal ulti ya side-ways hai.', unlock: 'Chaal signal ki taraf saaf ho jaaye.' }; } },
    { re: /range pocket/i, f: function () { return { tone: 'wait', why: 'Bhav do level ke beech phansa hai — jhoota breakout ka khatra.', unlock: 'Bhav kisi ek level ko saaf paar kare.' }; } },
    { re: /(High-Conviction Filter|Confidence)\D{0,12}(\d+)%\s*(?:confidence\s*)?<\s*(\d+)%/i, f: function (m) { return { tone: 'wait', why: 'Signal ka bharosa kam hai (' + m[2] + '%, kam se kam ' + m[3] + '% chahiye).', unlock: 'Zyada indicators ek hi taraf jaayein.' }; } }
  ];

  // Quick order the engine itself uses: hard blocks (⛔) and locks (🔒) first, then confirmation waits (⏳), then the rest.
  function ordered(reasons) {
    var a = [], b = [], c = [];
    (reasons || []).forEach(function (r) {
      var t = String(r == null ? '' : r);
      if (/^\s*(⛔|🔒)/u.test(t)) a.push(t); else if (/^\s*⏳/u.test(t)) b.push(t); else c.push(t);
    });
    return a.concat(b, c);
  }

  function timeNote(ew) {
    if (!ew) return null;
    if (ew.status === 'volatile') return { why: 'Subah ke pehle 45 minute mein bhav bahut uchhalta hai.', unlock: '10:00 baje ke baad.' };
    if (ew.status === 'theta') return { why: 'Dopahar ke baad option ka daam waqt ke saath tezi se ghatne lagta hai (time-decay).', unlock: 'Kal subah 10:00 baje ke baad.' };
    if (ew.status === 'pre') return { why: 'Bazaar abhi khula nahi hai.', unlock: '09:15 ke baad.' };
    return null;
  }

  function compute(s) {
    s = s || {};
    var sig = s.signal || 'WAIT', ew = s.entryWindow || null;
    if (sig !== 'WAIT' || !ew || ew.status === 'closed') return { show: false };

    var conf = num(s.confidence); if (conf === null) conf = 0;
    var reasons = ordered(Array.isArray(s.reason) ? s.reason : (s.noTrade && s.noTrade.reasons) || []);
    var pick = null, raw = null, i, k, m;
    for (i = 0; i < reasons.length && !pick; i++) {
      for (k = 0; k < RULES.length; k++) {
        m = RULES[k].re.exec(reasons[i]);
        if (m) { pick = RULES[k].f(m); raw = reasons[i]; break; }
      }
    }
    var tn = timeNote(ew);
    var hardLeft = null;
    if (!pick) {
      // an engine block we have no friendly wording for — never hide it, show it short
      for (i = 0; i < reasons.length; i++) { if (/^\s*(⛔|🔒)/u.test(reasons[i])) { hardLeft = clean(reasons[i]); break; } }
    }
    var why, unlock, tone;
    if (pick) { why = pick.why; unlock = pick.unlock; tone = pick.tone; }
    else if (hardLeft) { why = 'Engine ne ek safety check par roka: ' + (hardLeft.length > 110 ? hardLeft.slice(0, 107) + '…' : hardLeft); unlock = 'Jab woh check theek ho jaaye.'; tone = 'wait'; }
    else if (tn) { why = tn.why; unlock = tn.unlock; tone = 'wait'; }
    else { why = 'Abhi koi safety check nahi rok raha — bas indicators itne zor se ek taraf nahi hain.'; unlock = 'Bharosa ' + NEED + '% tak pahunche aur teeno chart ek taraf hon.'; tone = 'idle'; }

    var qg = s.qualityGate || {};
    var gates = [];
    function g(key, label, v) { if (v === true || v === false) gates.push({ k: key, label: label, ok: v }); }
    g('trend', 'Trend', qg.adxTrend);
    g('charts', 'Charts ek taraf', qg.mtfAligned);
    g('rsi', 'RSI', qg.rsiClean);
    g('vix', 'VIX', qg.vixSafe);
    if (ew.safe === true || ew.safe === false) gates.push({ k: 'time', label: 'Time', ok: ew.safe === true });

    return {
      show: true, tone: tone, why: why, unlock: unlock, conf: Math.round(conf), need: NEED,
      confPct: Math.max(0, Math.min(100, conf)), gates: gates, raw: raw, timeNote: (pick || hardLeft) && tn ? tn.why : null
    };
  }

  // ── DOM ──
  var cssDone = false;
  function injectCss() {
    if (cssDone || typeof document === 'undefined') return; cssDone = true;
    var st = document.createElement('style');
    st.textContent =
      '.signal-wrap.ws-on .signal-card.wait .conf-wrap,.signal-wrap.ws-on .signal-card.wait .conf-ticks,.signal-wrap.ws-on .signal-card.wait #conf-text{display:none !important;}' +
      '.signal-wrap.ws-on .signal-card.wait{padding-bottom:8px;border-bottom-left-radius:0;border-bottom-right-radius:0;}' +
      '.ws-box{border:2px solid rgba(255,187,0,0.5);border-top:0;border-radius:0 0 var(--card-radius,12px) var(--card-radius,12px);background:var(--bg2);padding:10px 12px 11px;text-align:left;}' +
      '.ws-box.soon{border-color:rgba(0,255,136,0.45);}' +
      '.ws-row{font-size:14px;line-height:1.5;color:var(--text);margin-bottom:6px;}' +
      '.ws-row b{font-family:\'Orbitron\',monospace;font-size:10px;letter-spacing:1.5px;color:var(--dim);display:block;margin-bottom:1px;}' +
      '.ws-chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 6px;}' +
      '.ws-chip{font-size:12px;font-family:\'Share Tech Mono\',monospace;padding:3px 9px;border-radius:99px;border:1px solid var(--border);background:var(--bg3);color:var(--text);}' +
      '.ws-chip.ok{border-color:var(--green);color:var(--green);} .ws-chip.no{border-color:var(--red);color:var(--red);}' +
      '.ws-bar{position:relative;height:8px;border-radius:6px;background:rgba(26,58,90,0.5);border:1px solid var(--border);overflow:visible;margin:6px 0 3px;}' +
      '.ws-bar i{display:block;height:100%;border-radius:6px;background:var(--amber);}' +
      '.ws-bar u{position:absolute;top:-3px;width:2px;height:14px;background:var(--green);text-decoration:none;}' +
      '.ws-conf{font-size:12px;color:var(--dim);font-family:\'Share Tech Mono\',monospace;}' +
      '.ws-note{font-size:12px;color:var(--dim);margin-top:4px;}';
    document.head.appendChild(st);
  }

  function html(r) {
    var chips = r.gates.map(function (x) { return '<span class="ws-chip ' + (x.ok ? 'ok' : 'no') + '">' + (x.ok ? '✅ ' : '❌ ') + esc(x.label) + '</span>'; }).join('');
    return '<div class="ws-box ' + (r.tone === 'soon' ? 'soon' : '') + '">' +
      '<div class="ws-row"><b>KYUN RUKE HAIN</b>' + esc(r.why) + '</div>' +
      '<div class="ws-row"><b>KAB BADLEGA</b>' + esc(r.unlock) + '</div>' +
      (chips ? '<div class="ws-chips">' + chips + '</div>' : '') +
      '<div class="ws-bar"><i style="width:' + r.confPct + '%"></i><u style="left:' + r.need + '%"></u></div>' +
      '<div class="ws-conf">Bharosa ' + r.conf + '% · signal ke liye ' + r.need + '% chahiye</div>' +
      (r.timeNote ? '<div class="ws-note">⏱ ' + esc(r.timeNote) + '</div>' : '') +
      '</div>';
  }

  function render(s) {
    try {
      if (typeof document === 'undefined') return;
      var host = document.getElementById('ws-card'); if (!host) return;
      var r = compute(s);
      var wrap = host.parentNode;
      if (!r.show) { host.innerHTML = ''; host.style.display = 'none'; if (wrap && wrap.classList) wrap.classList.remove('ws-on'); return; }
      injectCss();
      host.style.display = 'block';
      host.innerHTML = html(r);
      if (wrap && wrap.classList) wrap.classList.add('ws-on');
    } catch (e) { try { console.warn('[WaitStrip]', e && e.message); } catch (_) {} }
  }

  var api = { compute: compute, render: render, NEED: NEED };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WaitStrip = api;
})(typeof window !== 'undefined' ? window : this);