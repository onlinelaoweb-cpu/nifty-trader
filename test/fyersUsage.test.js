'use strict';
const assert = require('assert');
const { createFyersUsage } = require('../src/utils/fyersUsage');

// 2026-10-15 10:00:00 IST = 04:30:00 UTC
let t = Date.UTC(2026, 9, 15, 4, 30, 0);
const u = createFyersUsage({ now: () => t });

// non-Fyers URLs are ignored
assert.strictEqual(u.record('https://query1.finance.yahoo.com/v8/chart'), false);
assert.strictEqual(u.record('not a url'), false);
assert.strictEqual(u.snapshot().dataCallsToday, 0);

// 12 option-chain calls in the same second (like Combined PCR) -> peak 12/sec, 1 second over the 5/sec limit
for (let i = 0; i < 12; i++) u.record('https://api-t1.fyers.in/data/options-chain-v3');
let s = u.snapshot();
assert.strictEqual(s.dataCallsToday, 12);
assert.strictEqual(s.peakPerSecond, 12);
assert.strictEqual(s.secondsOverPerSecLimit, 1);
assert.strictEqual(s.minutesOverPerMinLimit, 0);
assert.strictEqual(s.byEndpoint['/data/options-chain-v3'], 12);
assert.strictEqual(s.dataCallsByHourIST['10'], 12);

// 45 more in the same minute (different seconds) -> 57 in the minute -> 1 minute over the 50/min limit (counted once)
for (let i = 0; i < 45; i++) { t += 1000; u.record('https://api-t1.fyers.in/data/quotes'); }
s = u.snapshot();
assert.strictEqual(s.minutesOverPerMinLimit, 1);
assert.ok(s.peakPerMinute >= 51);

// auth / non-data calls are counted separately and do not count toward the Data-API daily limit
const before = s.dataCallsToday;
u.record('https://api-t1.fyers.in/api/v3/validate-refresh-token');
s = u.snapshot();
assert.strictEqual(s.dataCallsToday, before);
assert.strictEqual(s.otherFyersCallsToday, 1);

// 429 counter
u.record429('https://api-t1.fyers.in/data/quotes');
u.record429('https://example.com/x');          // ignored
s = u.snapshot();
assert.strictEqual(s.status429Today, 1);
assert.ok(s.last429At);

// summary line mentions totals
assert.ok(/data calls \d+\/5000/.test(u.summaryLine()));

// the counter resets on a new IST day
t = Date.UTC(2026, 9, 15, 20, 0, 0);          // 16 Oct 01:30 IST
s = u.snapshot();
assert.strictEqual(s.date, '2026-10-16');
assert.strictEqual(s.dataCallsToday, 0);
assert.strictEqual(s.status429Today, 0);

// never throws on garbage
assert.doesNotThrow(() => { u.record(undefined); u.record(null); u.record429(undefined); });

console.log('fyersUsage OK');