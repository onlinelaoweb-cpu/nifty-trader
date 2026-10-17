/* 🧾 "Order Ticket (DRY RUN)" card for the Tools tab (17 Oct 2026).
 * You type a manual NIFTY option BUY (entry + SL + target); the server checks it and shows what WOULD be sent. NOTHING is sent to any broker,
 * and these tickets are kept separate from the paper-trade journal. toPayload()/summary() are pure (loadable in Node for tests);
 * the DOM part never throws into the page. */
(function (root) {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // f: raw form values (strings) -> request body
  function toPayload(f) {
    var b = { optionType: f.optionType, strike: f.strike, expiry: f.expiry || '', lots: f.lots, orderType: f.orderType, entryPrice: f.entryPrice };
    if (f.slUnit === '%') b.slPct = f.sl; else b.slPrice = f.sl;
    if (Array.isArray(f.targets)) {                       // T1/T2/T3 ladder: [{v, lots}] (empty rows skipped), total lots = sum when blank
      b.targets = f.targets.filter(function (t) { return t && (String(t.v || '') !== '' || String(t.lots || '') !== ''); })
        .map(function (t) { var o = { lots: t.lots }; if (f.tgUnit === '%') o.pct = t.v; else o.price = t.v; return o; });
    } else if (f.tgUnit === '%') b.targetPct = f.tg; else b.targetPrice = f.tg;
    if (f.trailMode && f.trailMode !== 'NONE') { b.trailMode = f.trailMode; if (f.trailMode === 'POINTS') b.trailPoints = f.trailPoints; }
    if (f.timeStop) b.timeStop = f.timeStop;
    return b;
  }
  // server response -> { ok, lines: [html strings] }
  function summary(r) {
    if (!r) return { ok: false, lines: ['Jawab nahi mila'] };
    if (!r.ok) return { ok: false, lines: (r.errors || ['error']).map(esc) };
    var t = r.ticket, k = t.risk, lines = [];
    lines.push('<b>NIFTY ' + esc(t.strike) + ' ' + esc(t.optionType) + '</b> · BUY ' + esc(t.lots) + ' lot (' + esc(t.quantity) + ' qty) · ' + esc(t.entry.orderType) + ' @ ' + esc(t.entry.expectedPrice));
    lines.push('SL: trigger ' + esc(t.stopLoss.trigger) + ' / limit ' + esc(t.stopLoss.limit));
    (t.targets && t.targets.length ? t.targets : [{ n: 1, price: t.target.price, lots: t.lots }]).forEach(function (x) { lines.push('T' + esc(x.n) + ': ' + esc(x.price) + ' · ' + esc(x.lots) + ' lot'); });
    if (t.trail && t.trail.mode !== 'NONE') lines.push('Trailing: ' + esc(t.trail.rule));
    if (t.timeStop) lines.push('Time stop: ' + esc(t.timeStop.rule));
    (t.scenarios || []).forEach(function (c) { lines.push('• ' + esc(c.name) + ': ₹' + esc(c.rs)); });
    lines.push('Max nuksaan ₹' + esc(k.maxLossRs) + ' · Target faayda ₹' + esc(k.targetProfitRs) + ' · R:R ' + esc(k.rr));
    (r.warnings || []).forEach(function (w) { lines.push('⚠️ ' + esc(w)); });
    lines.push('<i>' + esc(t.note) + (r.id ? ' (ticket #' + esc(r.id) + ' log hua)' : '') + '</i>');
    return { ok: true, lines: lines };
  }
  function $(id) { return document.getElementById(id); }
  var mounted = false;
  var FIELD = 'width:100%;padding:8px;border-radius:6px;border:1px solid var(--border,#334);background:transparent;color:inherit;font-size:13px;box-sizing:border-box';
  function inp(id, ph, extra) { return '<input id="ot-' + id + '" placeholder="' + ph + '" ' + (extra || '') + ' style="' + FIELD + '">'; }
  function draw() {
    var host = $('ot-card'); if (!host) return;
    host.innerHTML = '<div class="tool-card"><div class="tool-title">🧾 ORDER TICKET (dry-run)</div>'
      + '<div style="font-size:11px;color:var(--amber,#f0b429);margin-bottom:8px">Sirf check aur log. Stoxkart ko KUCH NAHI bheja jaata. Paper journal se alag.</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">'
      + '<select id="ot-optionType" style="' + FIELD + '"><option value="CE">CALL (CE)</option><option value="PE">PUT (PE)</option></select>'
      + inp('strike', 'Strike (jaise 25000)', 'inputmode="numeric"')
      + inp('lots', 'Total lots (khali = T1+T2+T3)', 'inputmode="numeric"')
      + '<select id="ot-orderType" style="' + FIELD + '"><option value="LIMIT">LIMIT</option><option value="MARKET">MARKET</option></select>'
      + inp('entryPrice', 'Entry premium', 'inputmode="decimal"')
      + inp('expiry', 'Expiry YYYY-MM-DD (optional)')
      + '<div style="display:flex;gap:4px">' + inp('sl', 'SL', 'inputmode="decimal"') + '<select id="ot-slUnit" style="' + FIELD + ';width:64px"><option value="price">₹</option><option value="%">%</option></select></div>'
      + '<select id="ot-tgUnit" style="' + FIELD + '"><option value="price">Target ₹ price</option><option value="%">Target % (entry se)</option></select>'
      + '<div></div>'
      + [1, 2, 3].map(function (n) { return '<div style="display:flex;gap:4px">' + inp('t' + n, 'T' + n + ' target', 'inputmode="decimal"') + '</div>' + inp('t' + n + 'lots', 'T' + n + ' lots', 'inputmode="numeric"'); }).join('')
      + '<select id="ot-trailMode" style="' + FIELD + '"><option value="NONE">Trailing nahi</option><option value="STEP">Trailing STEP (T1→entry, T2→T1)</option><option value="POINTS">Trailing POINTS</option></select>'
      + inp('trailPoints', 'Trail points (POINTS ke liye)', 'inputmode="decimal"')
      + inp('timeStop', 'Time stop HH:MM (jaise 15:10)')
      + '</div><button type="button" data-ot-go="1" style="width:100%;margin-top:8px;padding:11px;border:0;border-radius:8px;background:var(--blue,#4c8dff);color:#fff;font-size:14px;cursor:pointer">Check + dry-run log karo</button>'
      + '<div id="ot-out" style="font-size:12px;line-height:1.6;margin-top:8px"></div><div id="ot-recent" style="font-size:11px;color:var(--dim,#889);margin-top:6px"></div></div>';
  }
  function val(id) { var e = $('ot-' + id); return e ? String(e.value).trim() : ''; }
  function submit() {
    var out = $('ot-out'); if (!out) return;
    out.textContent = 'check ho raha hai…';
    var body = toPayload({ optionType: val('optionType'), strike: val('strike'), expiry: val('expiry'), lots: val('lots'), orderType: val('orderType'), entryPrice: val('entryPrice'), sl: val('sl'), slUnit: val('slUnit'), tgUnit: val('tgUnit'),
      targets: [1, 2, 3].map(function (n) { return { v: val('t' + n), lots: val('t' + n + 'lots') }; }), trailMode: val('trailMode'), trailPoints: val('trailPoints'), timeStop: val('timeStop') });
    fetch('/api/order-ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) { var s = summary(j); out.innerHTML = '<div style="color:' + (s.ok ? 'var(--green,#35c27a)' : 'var(--red,#ff6b6b)') + '">' + (s.ok ? '✅ Theek hai' : '❌ Sudhaaro') + '</div>' + s.lines.join('<br>'); if (s.ok) recent(); })
      .catch(function () { out.textContent = 'network error'; });
  }
  function recent() {
    fetch('/api/order-ticket/list?limit=5').then(function (r) { return r.json(); }).then(function (j) {
      var el = $('ot-recent'); if (!el || !j || !j.rows) return;
      el.innerHTML = j.rows.length ? 'Pichhle dry-run tickets:<br>' + j.rows.map(function (x) {
        var t = x.ticket || {}; return '#' + esc(x.id) + ' ' + esc(t.strike) + ' ' + esc(t.optionType) + ' · ' + esc(t.lots) + ' lot · SL ' + esc(t.stopLoss && t.stopLoss.trigger) + ' · ' + esc((t.targets || [t.target || {}]).map(function (q, k) { return 'T' + (k + 1) + ' ' + q.price; }).join(' / '));
      }).join('<br>') : '';
    }).catch(function () {});
  }
  function render() {
    try {
      var host = $('ot-card'); if (!host || mounted) return;
      mounted = true; draw();
      host.addEventListener('click', function (e) { try { if (e.target && e.target.closest && e.target.closest('[data-ot-go]')) submit(); } catch (err) {} });
      recent();
    } catch (e) { try { console.warn('[OrderTicket]', e && e.message); } catch (_) {} }
  }
  var api = { toPayload: toPayload, summary: summary, render: render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.OrderTicket = api;
    if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render(); }
  }
})(typeof window !== 'undefined' ? window : this);