'use strict';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const assert = require('assert');
const { fmtReviewDate, fmtEodRsi } = require('../src/api/telegram');

// the 16 Oct bug: raw Date string in the weekly review header
assert.strictEqual(fmtReviewDate(new Date('2026-10-09T00:00:00.000Z')), '09 Oct');
assert.strictEqual(fmtReviewDate(new Date('2026-10-16T00:00:00.000Z')), '16 Oct');
assert.strictEqual(fmtReviewDate('2026-10-09'), '09 Oct');
assert.strictEqual(fmtReviewDate('2026-10-09T00:00:00.000Z'), '09 Oct');
assert.strictEqual(fmtReviewDate(null), '--');
assert.strictEqual(fmtReviewDate(''), '--');
assert.strictEqual(fmtReviewDate('junk'), 'junk');
assert.ok(!/GMT/.test(fmtReviewDate(new Date('2026-10-09T00:00:00.000Z'))));

// EOD RSI: label always, extreme flagged
assert.strictEqual(fmtEodRsi(null), '--');
assert.strictEqual(fmtEodRsi(undefined), '--');
assert.strictEqual(fmtEodRsi('abc'), '--');
assert.strictEqual(fmtEodRsi(52.3), '52.3 (RSI9·1m)');
assert.ok(/spike/.test(fmtEodRsi(93.06)) && /93.06/.test(fmtEodRsi(93.06)));
assert.ok(/spike/.test(fmtEodRsi(12)));
assert.ok(!/spike/.test(fmtEodRsi(84.9)));
console.log('telegramDisplay OK');