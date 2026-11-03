'use strict';
process.env.SAHI_KEY_ID = 'pk_test'; process.env.SAHI_SECRET = 'sahi_sk_test'; process.env.SAHI_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const assert = require('assert');
const axios = require('axios');
let posts = [], gets = [], getReply = null, mint401 = false, getFail = [];
axios.post = async (url, body) => { posts.push({ url, body }); if (mint401) { const e = new Error('x'); e.response = { status: 401, data: { code: 'InvalidTotp' } }; throw e; }
  return { data: { access_token: 'tok' + posts.length, expires_at: new Date(Date.now() + 3600e3).toISOString() } }; };
axios.get = async (url, cfg) => { gets.push({ url, auth: cfg.headers && cfg.headers.Authorization, qs: cfg.paramsSerializer ? cfg.paramsSerializer(cfg.params) : '' });
  if (getFail.length) { const st = getFail.shift(); const e = new Error('x'); e.response = { status: st, data: { code: 'UNAUTHORIZED' } }; throw e; }
  return { data: typeof getReply === 'function' ? getReply(url) : getReply }; };
const sahi = require('../src/api/sahi');
sahi._t.setClock(() => Date.now(), async () => {});   // no real waiting in tests

(async () => {
  // mint: marketdata scope only, 6-digit totp, token reused
  getReply = { data: { '10854': { last_trade_price: 2344080, last_trade_time: null }, '1': null } };
  let r = await sahi.getLtp([10854, 1]);
  assert.strictEqual(r[10854].ltp, 23440.8, 'paise → rupees');
  assert.strictEqual(r[1], null, 'unknown id → null');
  assert.deepStrictEqual(posts[0].body.scopes, ['marketdata.read']);
  assert.ok(/^\d{6}$/.test(posts[0].body.totp));
  assert.strictEqual(gets[0].qs, 'i=10854&i=1', 'ids repeated');
  assert.strictEqual(gets[0].auth, 'Bearer tok1');
  await sahi.getLtp([10854]);
  assert.strictEqual(posts.length, 1, 'token reused, one mint per day');

  // 401 mid-day → re-mint once and retry
  getFail = [401];
  await sahi.getLtp([10854]);
  assert.strictEqual(posts.length, 2, 're-minted after 401');
  assert.strictEqual(gets[gets.length - 1].auth, 'Bearer tok2');

  // failed mint backs off (does not hammer the rate-limited auth endpoint)
  sahi._t.reset(); posts = []; mint401 = true;
  await assert.rejects(() => sahi.getLtp([1]), /mint 401 InvalidTotp/);
  await assert.rejects(() => sahi.getLtp([1]), /backoff/);
  assert.strictEqual(posts.length, 1, 'second call did not hit mint');
  mint401 = false; sahi._t.reset();

  // quotes + candles + chain parsing
  getReply = { data: { '5': { last_trade_price: 15275, volume_today: 10, open_interest: 500, prev_open_interest: 400, best_buys: [{ price: 15250, qty: 65, num_orders: 2 }], best_sells: [] } } };
  const q = (await sahi.getQuotes(5))[5];
  assert.strictEqual(q.ltp, 152.75); assert.strictEqual(q.bids[0].price, 152.5); assert.strictEqual(q.oi, 500);
  getReply = { candles: [[1, 100, 110, 90, 105, 7, 3]], has_more: false };
  const c = (await sahi.getCandles(5, '1m', 0, 1, { oi: true }))[0];
  assert.deepStrictEqual([c.open, c.high, c.low, c.close, c.volume, c.oi], [1, 1.1, 0.9, 1.05, 7, 3]);
  getReply = { underlying_id: 10854, expiry: '2026-11-03', last_price: 2344000, strikes: [
    { strike: 2330000, ce: { instrument_id: 1, last_trade_price: 100, open_interest: 100, prev_open_interest: 80 }, pe: { instrument_id: 2, last_trade_price: 100, open_interest: 300, prev_open_interest: 250 } },
    { strike: 2340000, ce: { instrument_id: 3, last_trade_price: 100, open_interest: 400, prev_open_interest: 300 }, pe: { instrument_id: 4, last_trade_price: 100, open_interest: 200, prev_open_interest: 200 } },
    { strike: 2350000, ce: { instrument_id: 5, last_trade_price: 100, open_interest: 500, prev_open_interest: 500 }, pe: null } ] };
  const ch = await sahi.getOptionChain(10854, '2026-11-03');
  assert.strictEqual(ch.strikes[0].strike, 23300); assert.strictEqual(ch.spot, 23440);
  const cs = sahi.chainStats(ch, 1);
  assert.strictEqual(cs.ceOi, 1000); assert.strictEqual(cs.peOi, 500); assert.strictEqual(cs.pcr, 0.5);
  assert.strictEqual(cs.atmStrike, 23400); assert.strictEqual(cs.callWall, 23500); assert.strictEqual(cs.putWall, 23300);
  assert.strictEqual(cs.ceOiChg, 120); assert.strictEqual(cs.peOiChg, 50);
  assert.strictEqual(sahi.chainStats({ strikes: [] }), null);

  // CSV parser: quotes, commas inside quotes, CRLF, header-name access
  const rows = sahi.parseCsv('id,company_name,instrument_type\r\n10854,"Nifty 50",IDX\r\n9,"A, ""B"" Ltd",STK\r\n');
  assert.strictEqual(rows.length, 2); assert.strictEqual(rows[0].company_name, 'Nifty 50'); assert.strictEqual(rows[1].company_name, 'A, "B" Ltd');

  // shadow stays off unless flag set
  assert.strictEqual(sahi.startShadow(() => ({})), null);
  console.log('sahi.test.js OK');
})().catch(e => { console.error(e); process.exit(1); });