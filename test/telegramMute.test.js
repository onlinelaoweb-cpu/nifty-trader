'use strict';
// Signals are muted unless TELEGRAM_SIGNALS=on; ops/summary messages still go out; isConfigured() keeps telling the truth.
const assert = require('assert');
process.env.TELEGRAM_BOT_TOKEN = 'T'; process.env.TELEGRAM_CHAT_ID = '1';
delete process.env.TELEGRAM_SIGNALS;
const axiosPath = require.resolve('axios');
const posts = [];
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { post: async (url, payload) => { posts.push(payload.text); return { data: { ok: true, result: { message_id: 7 } } }; } } };
const tg = require('../src/api/telegram');

(async () => {
  assert.ok(tg.isConfigured());                       // engines gate on this: must stay true
  assert.strictEqual(tg.signalsOn(), false);
  // every signal-type export is silent and returns null (never throws, even with junk args)
  const sigFns = ['sendSignalAlert', 'sendMTFAlert', 'sendScalpAlert', 'sendSignalTimeline', 'sendPartialProfitAlert', 'sendVolumeScannerAlert', 'sendExitAlert',
    'sendMomentumExitWarning', 'sendDeltaResponseWarning', 'sendEventIvWarning', 'sendNoProgressWarning', 'sendNishanebaazAlert', 'sendSpreadAlert', 'sendRawMessage'];
  for (const f of sigFns) assert.strictEqual(await tg[f]({}, 'x'), null, f);
  assert.strictEqual(posts.length, 0, 'muted signals must not reach Telegram');
  // ops message goes out
  await tg.sendOpsMessage('Fyers token reminder');
  assert.deepStrictEqual(posts, ['Fyers token reminder']);
  // switching on restores the original behaviour
  process.env.TELEGRAM_SIGNALS = 'ON';
  assert.strictEqual(tg.signalsOn(), true);
  await tg.sendRawMessage('live trigger alert');
  assert.strictEqual(posts.length, 2); assert.ok(/live trigger alert/.test(posts[1]));
  process.env.TELEGRAM_SIGNALS = 'off';
  await tg.sendRawMessage('muted again');
  assert.strictEqual(posts.length, 2);
  // exports the server imports still exist
  ['sendMorningSummary', 'sendVIXAlert', 'sendCloseSummary', 'sendWeeklyGateReview', 'sendOpsMessage', 'isConfigured', 'fmtReviewDate', 'fmtEodRsi'].forEach(k => assert.strictEqual(typeof tg[k], 'function', k));
  console.log('telegramMute tests passed');
})().catch(e => { console.error(e); process.exit(1); });
