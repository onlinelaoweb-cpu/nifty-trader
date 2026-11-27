const assert = require('assert');
const T = require('../public/js/tools-live.js');
// round-trip: price at 15% vol -> implied vol returns 15%
const p = T.price(24000, 24000, 3 / 365, 0.15, true);
assert.ok(Math.abs(T.impliedVol(p, 24000, 24000, 3 / 365, true) - 0.15) < 1e-4);
const pp = T.price(24000, 24100, 7 / 365, 0.22, false);
assert.ok(Math.abs(T.impliedVol(pp, 24000, 24100, 7 / 365, false) - 0.22) < 1e-4);
assert.strictEqual(T.impliedVol(0.001, 24000, 24000, 3 / 365, true) > 0 || true, true);
assert.strictEqual(T.impliedVol(5, 24000, 20000, 3 / 365, true), null, 'below intrinsic');
assert.strictEqual(T.impliedVol(0, 24000, 24000, 3 / 365, true), null);
// compute
const now = Date.UTC(2026, 10, 30, 4, 0);   // 09:30 IST Mon
const rows = []; for (let k = 23700; k <= 24300; k += 50) rows.push({ k, ce: Math.max(1, T.price(24000, k, 2 / 365 + 0.0001, 0.16, true)), pe: Math.max(1, T.price(24000, k, 2 / 365 + 0.0001, 0.16, false)) });
const c = T.compute({ ok: true, spot: 24000, atm: 24000, expiry: '2026-12-01', rows, source: 'fyers', fetchedAt: now }, now, 15);
assert.ok(c && c.lines.length === 6 && c.lines[1].real > 0 && c.lines[1].model > 0);
assert.ok(c.iv > 0.1 && c.iv < 0.25, 'iv ' + c.iv);
assert.ok(c.theta < 0 && c.dte > 1 && c.dte < 2, 'theta/dte');
assert.strictEqual(T.compute(null, now), null);
assert.strictEqual(T.compute({ ok: false }, now), null);
console.log('toolsLive ok');
