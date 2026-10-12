'use strict';
const assert = require('assert');
const TP = require('../public/js/tools-pulse');

// 1) basic sizing: ₹1,00,000, 1.5% risk, premium 100, lot 65 -> SL 85, risk/lot 975 -> floor(1500/975)=1
const NOW = Date.UTC(2026, 9, 12, 4, 0);   // 09:30 IST
let r = TP.compute({ capital: 100000, riskPct: 1.5, premium: 100, lotSize: 65, vix: 14, dte: 3, nowMs: NOW });
assert.ok(r.ok); assert.strictEqual(r.lots, 1);
assert.ok(Math.abs(r.levels.sl - 85) < 1e-9 && Math.abs(r.levels.target - 125) < 1e-9 && Math.abs(r.levels.half - 115) < 1e-9 && Math.abs(r.levels.be - 110) < 1e-9);
assert.strictEqual(Math.round(r.maxLoss), 975); assert.strictEqual(Math.round(r.invest), 6500); assert.strictEqual(Math.round(r.targetPnl), 1625);
assert.strictEqual(r.timeStopAt, '11:00'); assert.ok(!r.timeStopPastClose);
assert.ok(r.charges > 0 && r.charges < 0.1 * r.targetPnl + 200, 'charges small but nonzero');
assert.ok(r.netRR > 0 && r.netRR < r.rr, 'charges reduce reward:risk');
assert.strictEqual(r.warns.length, 0); assert.strictEqual(r.cls, 'bull');

// 2) more capital -> more lots; manual override
assert.strictEqual(TP.compute({ capital: 300000, riskPct: 2, premium: 100, lotSize: 65 }).lots, 6);
assert.strictEqual(TP.compute({ capital: 300000, riskPct: 2, premium: 100, lotSize: 65, lots: 2 }).lots, 2);

// 3) 0 lots warning
r = TP.compute({ capital: 20000, riskPct: 1, premium: 150, lotSize: 65 });
assert.strictEqual(r.lots, 0); assert.strictEqual(r.cls, 'bear'); assert.ok(r.warns.some(w => /0|1 lot ka SL-risk/.test(w.t)));
assert.strictEqual(r.maxLoss, 0); assert.strictEqual(r.charges, 0);

// 4) risk-heavy / expiry / VIX / late time-stop warnings
r = TP.compute({ capital: 100000, riskPct: 5, premium: 100, lotSize: 65, vix: 22, dte: 0.5, nowMs: Date.UTC(2026, 9, 12, 9, 0) });   // 14:30 IST -> 16:00 stop
assert.strictEqual(r.cls, 'bear');
assert.ok(r.warns.some(w => /zyada hai/.test(w.t)) && r.warns.some(w => /Expiry/.test(w.t)) && r.warns.some(w => /VIX/.test(w.t)) && r.warns.some(w => /market close/.test(w.t)));
assert.ok(r.timeStopPastClose && r.timeStopAt === '16:00');

// 5) missing inputs never throw
assert.ok(!TP.compute({}).ok); assert.strictEqual(TP.compute({ premium: 100 }).levels.sl, 85);
assert.ok(/Capital/.test(TP.compute({ premium: 100 }).msg));
assert.ok(!TP.compute(null).ok);
assert.ok(!TP.compute({ capital: 1e5, riskPct: 2, premium: -5 }).levels);

// 6) ATM estimate sanity: Nifty 24000, VIX 15, 3 DTE ~ ₹120-200, theta negative-ish positive loss/day
const e = TP.atmEstimate(24000, 15, 3);
assert.strictEqual(e.strike, 24000); assert.ok(e.premium > 100 && e.premium < 250, 'ATM premium ' + e.premium); assert.ok(e.thetaPerDay > 0);
assert.strictEqual(TP.atmEstimate(null, 15, 3), null); assert.strictEqual(TP.atmEstimate(24000, 0, 3), null);
assert.strictEqual(TP.atmEstimate(24010, 15, 0).premium, 0 + Math.max(0, 24010 - 24000));
// render without DOM must not throw
TP.render({ nifty: 24000 });
console.log('toolsPulse OK');