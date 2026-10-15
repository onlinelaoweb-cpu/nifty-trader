'use strict';
process.env.FYERS_ACCESS_TOKEN = 'test-token';
process.env.FYERS_APP_ID = 'TESTAPP-100';
const assert = require('assert');
const axios = require('axios');

let calls = [];
let reply = null;
axios.get = async (url, cfg) => { calls.push({ url, symbols: cfg && cfg.params && cfg.params.symbols }); if (reply instanceof Error) throw reply; return { data: reply }; };

const { fetchFyersQuotesMulti } = require('../src/api/nseData');

(async () => {
  const FUT = 'NSE:NIFTY26OCTFUT', IDX = 'NSE:NIFTY50-INDEX';

  // both symbols answered in ONE call
  reply = { s: 'ok', d: [
    { n: FUT, v: { lp: 23010.5, volume: 12345678, open_price: 22800, high_price: 23020, low_price: 22790, prev_close_price: 22650 } },
    { n: IDX, v: { lp: 22972, volume: 0, open_price: 22705, high_price: 22980, low_price: 22690, prev_close_price: 22622.7 } },
  ] };
  let out = await fetchFyersQuotesMulti([FUT, IDX]);
  assert.strictEqual(calls.length, 1, 'one HTTP call for two symbols');
  assert.strictEqual(calls[0].symbols, FUT + ',' + IDX);
  assert.strictEqual(out[FUT].volume, 12345678);
  assert.strictEqual(out[IDX].ltp, 22972);
  assert.strictEqual(out[IDX].high, 22980);
  assert.strictEqual(out[IDX].close, 22622.7);

  // a symbol with no price is left out (caller falls back to the single call)
  reply = { s: 'ok', d: [{ n: FUT, v: { lp: 0 } }, { n: IDX, v: { lp: 22972, volume: 0, open_price: 1, high_price: 2, low_price: 1, prev_close_price: 1 } }] };
  out = await fetchFyersQuotesMulti([FUT, IDX]);
  assert.ok(!(FUT in out) && IDX in out);

  // bad / error responses return an empty map and never throw
  reply = { s: 'error', code: -16, message: 'x' };
  assert.deepStrictEqual(await fetchFyersQuotesMulti([FUT, IDX]), {});
  reply = '<html>blocked</html>';
  assert.deepStrictEqual(await fetchFyersQuotesMulti([FUT, IDX]), {});
  reply = new Error('boom');
  assert.deepStrictEqual(await fetchFyersQuotesMulti([FUT, IDX]), {});

  // empty input makes no call
  calls = [];
  assert.deepStrictEqual(await fetchFyersQuotesMulti([]), {});
  assert.strictEqual(calls.length, 0);

  console.log('fyersQuotesMulti OK');
})().catch(e => { console.error(e); process.exit(1); });