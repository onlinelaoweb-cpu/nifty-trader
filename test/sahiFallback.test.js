'use strict';
process.env.SAHI_KEY_ID = 'pk_test'; process.env.SAHI_SECRET = 'sahi_sk_test'; process.env.SAHI_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const assert = require('assert');
const axios = require('axios');
let gets = 0, reply = null, fail = false;
axios.post = async () => ({ data: { access_token: 'tok', expires_at: new Date(Date.now() + 3600e3).toISOString() } });
axios.get = async (url) => { gets++; if (fail) { const e = new Error('boom'); e.response = { status: 500, data: {} }; throw e; } return { data: reply }; };
const sahi = require('../src/api/sahi');
sahi._t.setClock(() => Date.now(), async () => {});
const fb = require('../src/api/sahiFallback');

(async () => {
  // 1) off by default: no env flag → returns null and makes no HTTP call
  delete process.env.SAHI_FALLBACK; process.env.SAHI_ENABLED = '1';
  assert.strictEqual(fb.enabled(), false);
  assert.strictEqual(await fb.getNiftySpot({ lastKnown: 25000 }), null);
  assert.strictEqual(gets, 0, 'disabled → no call');
  process.env.SAHI_FALLBACK = '1';
  assert.strictEqual(fb.enabled(), true);
  process.env.SAHI_ENABLED = '0'; assert.strictEqual(fb.enabled(), false, 'needs SAHI_ENABLED=1 too'); process.env.SAHI_ENABLED = '1';

  // 2) validate (pure)
  const now = Date.parse('2026-11-13T05:00:00Z');
  assert.strictEqual(fb.validate(null, { now }).ok, false);
  assert.strictEqual(fb.validate({ ltp: 0 }, { now }).ok, false);
  assert.strictEqual(fb.validate({ ltp: NaN }, { now }).ok, false);
  assert.strictEqual(fb.validate({ ltp: 25000, ts: '2026-11-13T04:50:00Z' }, { now }).ok, false, 'stale 10 min');
  assert.strictEqual(fb.validate({ ltp: 25000, ts: '2026-11-13T04:59:30Z' }, { now }).ok, true, 'fresh 30s');
  assert.strictEqual(fb.validate({ ltp: 25000, ts: null }, { now }).ok, true, 'no ts → rely on jump guard');
  assert.strictEqual(fb.validate({ ltp: 25400 }, { now, lastKnown: 25000 }).ok, false, '+1.6% jump rejected');
  assert.strictEqual(fb.validate({ ltp: 25100 }, { now, lastKnown: 25000 }).ok, true, '+0.4% ok');
  assert.strictEqual(fb.validate({ ltp: 25100 }, { now }).ok, true, 'no reference → accepted');

  // 3) happy path: paise → rupees, spot only (one ltp call, nothing else)
  reply = { data: { '10854': { last_trade_price: 2512550, last_trade_time: null } } };
  gets = 0;
  const r = await fb.getNiftySpot({ lastKnown: 25100 });
  assert.ok(r && r.price === 25125.5, 'paise → rupees');
  assert.strictEqual(fb.status().used, 1);

  // 4) bad tick rejected, never throws
  reply = { data: { '10854': { last_trade_price: 2000000, last_trade_time: null } } };
  assert.strictEqual(await fb.getNiftySpot({ lastKnown: 25100 }), null);
  assert.strictEqual(fb.status().rejected, 1);
  fail = true;
  assert.strictEqual(await fb.getNiftySpot({ lastKnown: 25100 }), null, 'HTTP error → null, no throw');
  assert.ok(fb.status().errors >= 1);

  // 5) module exposes no chain/PCR/order functions
  assert.deepStrictEqual(Object.keys(fb).sort(), ['enabled', 'getNiftySpot', 'status', 'validate']);
  console.log('sahiFallback tests passed');
})().catch(e => { console.error(e); process.exit(1); });
