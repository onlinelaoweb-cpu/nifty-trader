/* NET P&L (after charges) for the Signal Journal — display only (15 Nov 2026).
 * The Journal's P&L is GROSS. This shows what is left after brokerage + statutory charges, for two ways of trading, so the forward-test verdict
 * (Profit Factor >= 1.1) is judged on money that would really stay in the account:
 *   • Rs 0 BROKERAGE — Stoxkart manual orders, and also any zero-brokerage API broker (e.g. Kotak Neo claims zero-brokerage API orders; verify current pricing): statutory charges still apply, so the numbers are identical
 *   • Rs 20/ORDER — Stoxkart API/auto orders: Rs 20 per order (2 orders per round trip)
 * Charges for an options BUY round trip (premium bought at p1, sold at p2, qty units) — rates in force from FY 2026-27:
 *   STT 0.15% of the premium SOLD (NSE/FATAX/73524, 31 Mar 2026) · NSE transaction charge incl. IPFT 0.03553% of buy+sell premium (NSE/FA/73061, 27 Feb 2026)
 *   SEBI fee Rs 10 per crore · stamp duty 0.003% of the premium BOUGHT · GST 18% on (brokerage + NSE charge + SEBI fee).
 * These rates change when NSE/Govt revise them: edit RATES below. Slippage is NOT added here (the Journal already tracks it separately).
 * Trades whose exit was an unverified EOD placeholder are left out (their P&L 0 is not a real fill).
 * Display only — never changes a journal row, a signal, a gate or a trade. compute() is pure (loadable in Node for tests). */
(function (root) {
  'use strict';
  var RATES = { stt: 0.0015, nse: 0.0003553, sebiPerCr: 10, stamp: 0.00003, gst: 0.18 };
  var BROKERAGE = { manual: 0, automation: 20 };   // Rs per order

  function num(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null; }
  function r2(x) { return Math.round(x * 100) / 100; }

  // total charges (Rs) for one closed options-buy round trip
  function charges(buyPrem, sellPrem, qty, brokeragePerOrder) {
    var p1 = num(buyPrem), p2 = num(sellPrem), q = num(qty), b = num(brokeragePerOrder);
    if (p1 === null || p2 === null || q === null || p1 < 0 || p2 < 0 || q <= 0) return null;
    if (b === null || b < 0) b = 0;
    var buyT = p1 * q, sellT = p2 * q, tot = buyT + sellT;
    var brokerage = 2 * b;
    var stt = RATES.stt * sellT, nse = RATES.nse * tot, sebi = RATES.sebiPerCr * tot / 1e7, stamp = RATES.stamp * buyT;
    var gst = RATES.gst * (brokerage + nse + sebi);
    return { brokerage: brokerage, stt: stt, nse: nse, sebi: sebi, stamp: stamp, gst: gst, total: brokerage + stt + nse + sebi + stamp + gst };
  }

  function pf(arr) {
    var w = 0, l = 0;
    arr.forEach(function (x) { if (x > 0) w += x; else if (x < 0) l += -x; });
    return l > 0 ? w / l : (w > 0 ? Infinity : null);
  }

  // trades: Journal rows {premium, exit, lots, pnl, time, notes}; lotSize: units per lot; todayStr: new Date().toDateString()
  function compute(trades, lotSize, todayStr) {
    var ls = num(lotSize) > 0 ? Number(lotSize) : 65;
    var all = { n: 0, gross: [], manual: [], auto: [], chg: 0 }, day = { n: 0, gross: 0, manual: 0, auto: 0, chg: 0 };
    var skipped = 0;
    (Array.isArray(trades) ? trades : []).forEach(function (t) {
      if (!t || t.exit === null || t.exit === undefined) return;                   // still open
      if (/EOD close unverified/.test(String(t.notes || ''))) { skipped++; return; }
      var qty = (num(t.lots) || 0) * ls;
      var cm = charges(t.premium, t.exit, qty, BROKERAGE.manual), ca = charges(t.premium, t.exit, qty, BROKERAGE.automation);
      var g = num(t.pnl); if (g === null && num(t.premium) !== null && num(t.exit) !== null) g = (t.exit - t.premium) * qty;
      if (!cm || !ca || g === null) { skipped++; return; }
      all.n++; all.gross.push(g); all.manual.push(g - cm.total); all.auto.push(g - ca.total); all.chg += cm.total;
      if (todayStr && new Date(t.time).toDateString() === todayStr) {
        day.n++; day.gross += g; day.manual += g - cm.total; day.auto += g - ca.total; day.chg += cm.total;
      }
    });
    function sum(a) { return a.reduce(function (s, x) { return s + x; }, 0); }
    if (!all.n) return { show: false, skipped: skipped };
    return {
      show: true, skipped: skipped,
      today: { n: day.n, gross: Math.round(day.gross), manual: Math.round(day.manual), auto: Math.round(day.auto), statutory: Math.round(day.chg), autoExtra: Math.round(day.n * 2 * BROKERAGE.automation * (1 + RATES.gst)) },
      total: {
        n: all.n, gross: Math.round(sum(all.gross)), manual: Math.round(sum(all.manual)), auto: Math.round(sum(all.auto)),
        statutory: Math.round(all.chg), perTradeManual: r2(all.chg / all.n), perTradeAuto: r2((all.chg + all.n * 2 * BROKERAGE.automation * (1 + RATES.gst)) / all.n),
        pfGross: pf(all.gross), pfManual: pf(all.manual), pfAuto: pf(all.auto)
      }
    };
  }

  function inr(n) { return (n >= 0 ? '+₹' : '−₹') + Math.abs(n).toLocaleString('en-IN'); }
  function pfTxt(x) { return x === null ? '--' : x === Infinity ? '∞' : x.toFixed(2); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function html(r) {
    var t = r.total, d = r.today, col = function (n) { return n > 0 ? 'var(--green)' : n < 0 ? 'var(--red)' : 'var(--dim)'; };
    var line = function (label, g, m, a) {
      return '<div style="margin-bottom:3px;"><b style="color:var(--text);">' + esc(label) + '</b> — gross <span style="color:' + col(g) + '">' + esc(inr(g)) + '</span> · net (manual ya zero-brokerage API, ₹0) <span style="color:' + col(m) + ';font-weight:700;">' + esc(inr(m)) +
        '</span> · net (₹20/order automation) <span style="color:' + col(a) + ';font-weight:700;">' + esc(inr(a)) + '</span></div>';
    };
    return '<div style="margin-bottom:4px;font-family:\'Orbitron\',monospace;font-size:11px;letter-spacing:1.2px;color:var(--cyan,#4fd1ff);">💸 KHARCHE KE BAAD (NET P&amp;L)</div>' +
      (d.n ? line('Aaj (' + d.n + ' trade)', d.gross, d.manual, d.auto) : '') +
      line('Ab tak (' + t.n + ' band trade)', t.gross, t.manual, t.auto) +
      '<div style="margin-top:3px;">Profit Factor — gross <b>' + pfTxt(t.pfGross) + '</b> · net ₹0-brokerage <b>' + pfTxt(t.pfManual) + '</b> · net ₹20/order <b>' + pfTxt(t.pfAuto) +
      '</b> (verdict ke liye ≥ 1.1 chahiye)</div>' +
      '<div style="margin-top:3px;">Har trade par kharcha: ₹0-brokerage (manual ya zero-brokerage API) ~₹' + t.perTradeManual.toFixed(0) + ' (sirf STT, exchange, stamp, GST), ₹20/order automation ~₹' + t.perTradeAuto.toFixed(0) + '.' +
      (r.skipped ? ' ' + r.skipped + ' trade chhode gaye (EOD exit verify nahi tha).' : '') + ' Slippage isme nahi joda.</div>';
  }

  function render(trades, lotSize) {
    try {
      if (typeof document === 'undefined') return;
      var host = document.getElementById('j-net-wrap'); if (!host) return;
      var r = compute(trades, lotSize, new Date().toDateString());
      if (!r.show) { host.style.display = 'none'; host.innerHTML = ''; return; }
      host.innerHTML = html(r); host.style.display = 'block';
    } catch (e) { try { console.warn('[NetPnl]', e && e.message); } catch (_) {} }
  }

  var api = { compute: compute, charges: charges, render: render, RATES: RATES, BROKERAGE: BROKERAGE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NetPnl = api;
})(typeof window !== 'undefined' ? window : this);
