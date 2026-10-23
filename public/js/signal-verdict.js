/* Signal scorecard verdict — pure, display only. Never mutes or changes a signal.
   Input: one row of /api/signal-accuracy. Output: { key, label, icon, reason }.
   Rule (decided on decisive = WIN+LOSS, FLATs excluded, like the win% itself):
     < 30 decisive            -> LOW DATA (no verdict on a small sample)
     else three votes, each +1 good / 0 neutral / -1 bad:
       win%            >= 55 good, < 45 bad
       premium median  >  0.5 good, < -0.5 bad   (needs >= 15 premium results, else neutral)
       coach  median   >  0.5 good, < -0.5 bad   (needs >= 15 coach results, else neutral)
     sum >= 2 STRONG, sum <= -2 WEAK, else WATCH. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SignalVerdict = api;
})(typeof self !== 'undefined' ? self : this, function () {
  var MIN_DECISIVE = 30, MIN_SIDE = 15, BAND = 0.5;
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function vote(v, n) { if (v === null || n < MIN_SIDE) return 0; return v > BAND ? 1 : (v < -BAND ? -1 : 0); }
  function verdict(row) {
    row = row || {};
    var w = num(row.win_count) || 0, l = num(row.loss_count) || 0, dec = w + l;
    if (dec < MIN_DECISIVE) return { key: 'low', icon: '⚪', label: 'LOW DATA', reason: dec + ' decisive of ' + MIN_DECISIVE + ' needed' };
    var win = 100 * w / dec;
    var vw = win >= 55 ? 1 : (win < 45 ? -1 : 0);
    var vp = vote(num(row.median_premium_pct_move), num(row.premium_resolved_count) || 0);
    var vc = vote(num(row.median_coach_pct_move), num(row.coach_resolved_count) || 0);
    var sum = vw + vp + vc;
    if (sum >= 2) return { key: 'strong', icon: '🟢', label: 'STRONG', reason: 'win%, premium, coach mostly positive' };
    if (sum <= -2) return { key: 'weak', icon: '🔴', label: 'WEAK', reason: 'win%, premium, coach mostly negative' };
    return { key: 'watch', icon: '🟡', label: 'WATCH', reason: 'mixed signals' };
  }
  return { verdict: verdict, MIN_DECISIVE: MIN_DECISIVE };
});