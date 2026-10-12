/* 🧰 "Trade Planner" card for the Tools tab — display only (12 Oct).
 * Capital + risk % + entry premium  ->  lots, stop-loss / break-even / half-book / target prices, rupee loss & profit,
 * rough charges, the 90-min time-stop clock time, and plain warnings (expiry day, high VIX, risk too big, 0 lots).
 * Nifty and live Nifty/VIX/DTE are pre-filled from the app's own state; premium can be filled with a Black-Scholes ATM estimate.
 * Levels use the app's Nifty Trade-Coach grid (SL -15%, BE +10%, half +15%, target +25%, 90-min time stop). The live alert can scale
 * these slightly, so the alert's own numbers always win. Nothing here sends orders or changes any signal or journal.
 * compute() is pure (loadable in Node for tests); render()/mount touch the DOM and never throw into the page. */
(function (root) {
  'use strict';
  function n(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function inr(x) { var a = Math.abs(Math.round(x)); return (x < 0 ? '-' : '') + '₹' + a.toLocaleString('en-IN'); }

  var GRID = { slPct: -15, breakevenAt: 10, halfBookAt: 15, fullExitAt: 25 };
  var TIME_STOP_MIN = 90;
  var SLIP_PTS = 1;          // assumed slippage, premium points per side

  function cdf(x) { var a = 0.2316419, t = 1 / (1 + a * Math.abs(x)); var p = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); var d = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI); return x >= 0 ? 1 - d * p : d * p; }
  function bs(S, K, T, sigma, isCall) {
    if (!(S > 0) || !(K > 0)) return null;
    if (!(T > 0) || !(sigma > 0)) return isCall ? Math.max(0, S - K) : Math.max(0, K - S);
    var d1 = (Math.log(S / K) + (0.05 + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T)), d2 = d1 - sigma * Math.sqrt(T);
    return isCall ? S * cdf(d1) - K * Math.exp(-0.05 * T) * cdf(d2) : K * Math.exp(-0.05 * T) * cdf(-d2) - S * cdf(-d1);
  }
  // ATM premium estimate + theta per day (₹ per unit) from live Nifty / VIX / DTE
  function atmEstimate(nifty, vix, dte) {
    nifty = n(nifty); vix = n(vix); dte = n(dte);
    if (nifty === null || vix === null || dte === null || nifty <= 0 || vix <= 0) return null;
    var K = Math.round(nifty / 50) * 50, sigma = vix / 100, T = Math.max(dte, 0) / 365;
    var p = bs(nifty, K, T, sigma, true); if (p === null) return null;
    var th = T > 0 ? p - bs(nifty, K, Math.max(0, T - 1 / 365), sigma, true) : 0;
    return { strike: K, premium: Math.round(p * 10) / 10, thetaPerDay: Math.round(th * 10) / 10 };
  }
  function istClock(ms) {
    var d = new Date(ms + 330 * 60000);
    return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2);
  }
  function istMin(ms) { var d = new Date(ms + 330 * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); }

  // Pure. in: { capital, riskPct, premium, lotSize, vix, dte, nowMs, lots(optional override) }
  function compute(inp) {
    inp = inp || {};
    var cap = n(inp.capital), rp = n(inp.riskPct), prem = n(inp.premium), lot = n(inp.lotSize) || 65;
    var out = { ok: false, warns: [], levels: null };
    if (prem === null || prem <= 0) { out.msg = 'Entry premium daalo (ya "Live estimate" dabao)'; return out; }
    var lv = {
      entry: prem,
      sl: prem * (1 + GRID.slPct / 100), be: prem * (1 + GRID.breakevenAt / 100),
      half: prem * (1 + GRID.halfBookAt / 100), target: prem * (1 + GRID.fullExitAt / 100),
    };
    out.levels = lv;
    var riskPerLot = (prem - lv.sl) * lot, investPerLot = prem * lot;
    out.riskPerLot = riskPerLot; out.investPerLot = investPerLot;
    if (cap === null || cap <= 0 || rp === null || rp <= 0) { out.msg = 'Capital aur risk % daalo'; out.ok = false; return out; }
    var riskAmt = cap * rp / 100;
    var lots = inp.lots != null && n(inp.lots) !== null ? Math.max(0, Math.floor(n(inp.lots))) : Math.floor(riskAmt / riskPerLot);
    out.riskAmt = riskAmt; out.lots = lots; out.qty = lots * lot;
    out.maxLoss = lots * riskPerLot;                                   // price-based SL loss, before charges
    out.invest = lots * investPerLot;
    out.targetPnl = lots * (lv.target - prem) * lot;                   // all lots exit at target
    // with 2+ lots the coach books half at +15% and rides the rest: blended best case
    out.halfPnl = lots * (lv.half - prem) * lot;
    // rough round-trip charges: STT 0.1% on sell value + ~0.07% exchange/GST/stamp on turnover, plus slippage both sides. Brokerage assumed 0.
    var sellAt = lv.target, buyVal = lots * lot * prem, sellVal = lots * lot * sellAt;
    out.charges = lots ? 0.001 * sellVal + 0.0007 * (buyVal + sellVal) + 2 * SLIP_PTS * lots * lot : 0;
    out.chargesSl = lots ? 0.001 * lots * lot * lv.sl + 0.0007 * (buyVal + lots * lot * lv.sl) + 2 * SLIP_PTS * lots * lot : 0;
    out.riskPctOfCap = cap > 0 ? out.maxLoss / cap * 100 : null;
    out.investPctOfCap = cap > 0 ? out.invest / cap * 100 : null;
    out.rr = riskPerLot > 0 ? (lv.target - prem) / (prem - lv.sl) : null;
    // net R:R after charges (both sides)
    out.netRR = out.maxLoss + out.chargesSl > 0 ? (out.targetPnl - out.charges) / (out.maxLoss + out.chargesSl) : null;
    if (inp.nowMs != null) {
      var stopMs = inp.nowMs + TIME_STOP_MIN * 60000;
      out.timeStopAt = istClock(stopMs);
      out.timeStopPastClose = istMin(stopMs) > 15 * 60 + 30 || istMin(stopMs) < istMin(inp.nowMs);
    }
    var w = out.warns;
    if (lots === 0) w.push({ c: 'bear', t: '⛔ 1 lot ka SL-risk ' + inr(riskPerLot) + ' hai — tumhare ' + rp + '% risk (' + inr(riskAmt) + ') se zyada. Capital badhao, risk % badhao ya sasta premium lo.' });
    if (rp > 3) w.push({ c: 'bear', t: '⚠️ ' + rp + '% risk per trade zyada hai — 1–2% rakhna safe mana jata hai.' });
    else if (rp > 2) w.push({ c: 'neu', t: 'Risk ' + rp + '% — thoda aggressive; 1–2% safe zone.' });
    if (lots > 0 && out.investPctOfCap > 60) w.push({ c: 'neu', t: 'Invest ' + Math.round(out.investPctOfCap) + '% capital ka — option buy mein premium hi margin hai, par ek hi trade mein itna fasa mat rakho.' });
    var dte = n(inp.dte), vix = n(inp.vix);
    if (dte !== null && dte < 1) w.push({ c: 'bear', t: '⏳ Expiry aaj/kal — theta bahut tez, premium jaldi gal sakta hai. Time stop ka dhyan rakho.' });
    if (vix !== null && vix >= 20) w.push({ c: 'neu', t: 'VIX ' + vix.toFixed(1) + ' high — premium mehenga aur swings bade; SL jaldi lag sakta hai.' });
    if (out.timeStopPastClose) w.push({ c: 'neu', t: '🕒 90-min time stop (' + out.timeStopAt + ') market close ke baad padta hai — close se pehle exit plan karo.' });
    if (lots > 0 && out.netRR !== null && out.netRR < 1.2) w.push({ c: 'neu', t: 'Charges + slippage ke baad reward:risk sirf ' + out.netRR.toFixed(2) + ' — chhote premium par kharcha bhaari padta hai.' });
    out.ok = true;
    out.cls = lots === 0 || rp > 3 ? 'bear' : w.length ? '' : 'bull';
    out.verdict = lots === 0 ? '⛔ Is setup ke liye 0 lot' : (lots + (lots === 1 ? ' lot' : ' lots') + ' — risk ' + inr(out.maxLoss) + ' (' + out.riskPctOfCap.toFixed(1) + '% capital)');
    return out;
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  var state = null, LS = 'vn_tp_v1';
  function lsGet() { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (_) { return {}; } }
  function lsSet(o) { try { localStorage.setItem(LS, JSON.stringify(o)); } catch (_) {} }
  function $(id) { return document.getElementById(id); }
  function injectCss() {
    if ($('tp-css')) return;
    var st = document.createElement('style'); st.id = 'tp-css';
    st.textContent = '#tp-card{margin-bottom:10px}#tp-card .tp-live{font-size:11px;color:var(--dim);font-family:"Share Tech Mono",monospace;margin:-4px 0 10px}#tp-card .tp-btns{display:flex;gap:8px;margin:2px 0 10px}#tp-card .tp-btns button{flex:1;font-size:11px;padding:7px 6px;background:rgba(255,255,255,.06);border:1px solid var(--border);color:var(--text,inherit);border-radius:8px;cursor:pointer}#tp-card .tp-lv{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin:10px 0}#tp-card .tp-lv>div{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:5px 4px;text-align:center}#tp-card .tp-lv b{display:block;font-size:12.5px;font-family:"Share Tech Mono",monospace}#tp-card .tp-lv span{font-size:9px;letter-spacing:1px;color:var(--dim)}#tp-card .tp-w{font-size:11.5px;line-height:1.45;margin-top:6px}#tp-card .tp-w.bear{color:var(--red)}#tp-card .tp-w.neu{color:var(--amber)}#tp-note{font-size:10.5px;color:var(--dim);opacity:.75;line-height:1.4;margin-top:8px}';
    document.head.appendChild(st);
  }
  function ensureMarkup(host) {
    if (host.getAttribute('data-tp')) return;
    host.setAttribute('data-tp', '1');
    var saved = lsGet();
    host.innerHTML = '<div class="tool-card" id="tp-box"><div class="tool-title">🧭 TRADE PLANNER <span style="font-size:10px;opacity:.7;letter-spacing:0">— capital se lots, SL aur target ek jagah</span></div>'
      + '<div class="tp-live" id="tp-live">Live data ka intezaar…</div>'
      + '<div class="tool-grid">'
      + '<div class="tool-field"><label>CAPITAL (₹)</label><input class="tool-input" id="tp-cap" type="number" inputmode="decimal" placeholder="100000" step="1000" value="' + esc(saved.cap || '') + '"/></div>'
      + '<div class="tool-field"><label>RISK % PER TRADE</label><input class="tool-input" id="tp-risk" type="number" inputmode="decimal" placeholder="1.5" step="0.5" min="0.25" max="10" value="' + esc(saved.risk || '') + '"/></div>'
      + '<div class="tool-field"><label>ENTRY PREMIUM (₹)</label><input class="tool-input" id="tp-prem" type="number" inputmode="decimal" placeholder="alert wala premium" step="0.5" value=""/></div>'
      + '<div class="tool-field"><label>LOTS (khali = auto)</label><input class="tool-input" id="tp-lots" type="number" inputmode="numeric" placeholder="auto" step="1" min="0" value=""/></div>'
      + '</div>'
      + '<div class="tp-btns"><button type="button" id="tp-est">⚡ Live ATM estimate bharo</button><button type="button" id="tp-push">⬇️ Neeche ke calculators mein bhi bharo</button></div>'
      + '<div id="tp-out"></div>'
      + '<div id="tp-note">Sirf hisaab ke liye — koi order ya signal change nahi hota. Levels Nifty Trade-Coach grid ke hain (SL −15%, BE +10%, half +15%, target +25%); live alert thoda scale kar sakta hai, to alert ke number hi final. Charges andaaza hain (brokerage 0 maan kar).</div></div>';
    ['tp-cap', 'tp-risk', 'tp-prem', 'tp-lots'].forEach(function (id) { $(id).addEventListener('input', function () { var s = lsGet(); s.cap = $('tp-cap').value; s.risk = $('tp-risk').value; lsSet(s); draw(); }); });
    $('tp-est').addEventListener('click', function () {
      var e = state ? atmEstimate(state.nifty, state.vix, state.daysToExpiry) : null;
      if (!e) { $('tp-live').textContent = 'Live Nifty/VIX/DTE abhi nahi mila — premium khud daalo.'; return; }
      $('tp-prem').value = e.premium; draw();
    });
    $('tp-push').addEventListener('click', function () {
      var p = $('tp-prem').value; if (!p) return;
      var cap = $('tp-cap').value, risk = $('tp-risk').value;
      [['th-premium', p], ['ps-entry', p], ['sl-premium', p], ['ps-capital', cap], ['ps-risk', risk]].forEach(function (kv) { var e = $(kv[0]); if (e && kv[1] !== '' && kv[1] != null) { e.value = kv[1]; try { e.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {} } });
      var sl = compute({ capital: cap, riskPct: risk, premium: p, lotSize: state && state.lotSize }); var pe = $('ps-sl'); if (pe && sl.levels) { pe.value = Math.round(sl.levels.sl * 10) / 10; try { pe.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {} }
      $('tp-live').textContent = 'Neeche ke calculators mein premium / capital / risk / SL bhar diya ✅'; setTimeout(function () { var l = $('tp-live'); if (l) { l.textContent = ''; draw(); } }, 3500);
    });
  }
  function draw() {
    var host = $('tp-card'); if (!host || !host.getAttribute('data-tp')) return;
    var s = state || {};
    var lot = n(s.lotSize) || 65;
    var live = $('tp-live');
    if (live && n(s.nifty) !== null && live.textContent.indexOf('✅') < 0) {
      var e = atmEstimate(s.nifty, s.vix, s.daysToExpiry);
      live.textContent = 'Nifty ' + Math.round(s.nifty) + (n(s.vix) !== null ? ' · VIX ' + Number(s.vix).toFixed(1) : '') + (n(s.daysToExpiry) !== null ? ' · ' + Number(s.daysToExpiry).toFixed(1) + 'd DTE' : '') + ' · 1 lot = ' + lot + (e ? ' · ATM ' + e.strike + ' ≈ ₹' + e.premium + ' (theta ≈ ₹' + e.thetaPerDay + '/din)' : '');
    }
    var r = compute({ capital: $('tp-cap').value, riskPct: $('tp-risk').value, premium: $('tp-prem').value, lotSize: lot, vix: s.vix, dte: s.daysToExpiry, nowMs: Date.now(), lots: $('tp-lots').value === '' ? null : $('tp-lots').value });
    var out = $('tp-out'); if (!out) return;
    var box = $('tp-box'); if (box) { box.classList.remove('bull', 'bear'); if (r.cls) box.classList.add(r.cls); }
    if (!r.levels) { out.innerHTML = '<div class="tp-w neu">' + esc(r.msg || '') + '</div>'; return; }
    var lv = r.levels, f = function (x) { return '₹' + (Math.round(x * 10) / 10); };
    var html = '';
    if (r.ok) {
      html += '<div class="pulse-verdict" style="color:' + (r.cls === 'bull' ? 'var(--green)' : r.cls === 'bear' ? 'var(--red)' : 'var(--amber)') + ';margin:4px 0 8px">' + esc(r.verdict) + '</div>'
        + '<div class="result-grid-4"><div class="res-card"><div class="res-label">QTY</div><div class="res-val">' + r.qty + '</div><div class="res-sub">' + r.lots + '×' + lot + '</div></div>'
        + '<div class="res-card"><div class="res-label">MAX LOSS</div><div class="res-val" style="color:var(--red)">' + inr(r.maxLoss) + '</div><div class="res-sub">+ ' + inr(r.chargesSl) + ' charges</div></div>'
        + '<div class="res-card"><div class="res-label">INVEST</div><div class="res-val" style="color:var(--blue)">' + inr(r.invest) + '</div><div class="res-sub">' + Math.round(r.investPctOfCap) + '% capital</div></div>'
        + '<div class="res-card"><div class="res-label">TARGET</div><div class="res-val" style="color:var(--green)">' + inr(r.targetPnl) + '</div><div class="res-sub">net ' + inr(r.targetPnl - r.charges) + '</div></div></div>';
    } else html += '<div class="tp-w neu">' + esc(r.msg || '') + ' — levels neeche dekh sakte ho.</div>';
    html += '<div class="tp-lv"><div><span>SL</span><b style="color:var(--red)">' + f(lv.sl) + '</b></div><div><span>BE +10%</span><b>' + f(lv.be) + '</b></div><div><span>HALF +15%</span><b style="color:var(--amber)">' + f(lv.half) + '</b></div><div><span>TARGET</span><b style="color:var(--green)">' + f(lv.target) + '</b></div><div><span>TIME STOP</span><b>' + (r.timeStopAt || '--') + '</b></div></div>';
    if (r.ok) html += '<div class="tp-w" style="color:var(--dim)">Reward:Risk ' + (r.rr ? r.rr.toFixed(2) : '--') + ' (charges ke baad ' + (r.netRR ? r.netRR.toFixed(2) : '--') + ') · 1 lot SL-risk ' + inr(r.riskPerLot) + ' · Risk budget ' + inr(r.riskAmt) + '</div>';
    html += r.warns.map(function (w) { return '<div class="tp-w ' + w.c + '">' + esc(w.t) + '</div>'; }).join('');
    out.innerHTML = html;
  }
  function render(s) {
    try {
      state = s || state;
      var host = $('tp-card'); if (!host) return;
      injectCss(); ensureMarkup(host); draw();
    } catch (e) { try { console.warn('[ToolsPulse]', e && e.message); } catch (_) {} }
  }

  var api = { compute: compute, atmEstimate: atmEstimate, render: render, GRID: GRID, istClock: istClock };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ToolsPulse = api;
})(typeof window !== 'undefined' ? window : this);