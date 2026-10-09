'use strict';
const assert = require('assert');
const { createHtfCache } = require('../src/utils/htfCache');

(async () => {
    let t = 1_000_000, calls15 = 0, calls1h = 0, fail15 = false;
    const bars = n => Array.from({ length: n }, (_, i) => ({ close: i + 1 }));
    const c = createHtfCache({
        fetch15: async () => { calls15++; if (fail15) throw new Error('429'); return bars(50); },
        fetch1h: async () => { calls1h++; return bars(40); },
        ttl15Ms: 10 * 60000, ttl1hMs: 30 * 60000, retryMs: 2 * 60000, now: () => t,
    });

    // first call fetches both; repeat calls inside the TTL do not fetch again
    let r = await c.get();
    assert.strictEqual(calls15, 1); assert.strictEqual(calls1h, 1); assert.strictEqual(r.c15.length, 50); assert.strictEqual(r.c1h.length, 40);
    t += 5 * 60000; await c.get();
    assert.strictEqual(calls15, 1); assert.strictEqual(calls1h, 1);

    // 15m refreshes after its TTL, 1h still not
    t += 6 * 60000; r = await c.get();
    assert.strictEqual(calls15, 2); assert.strictEqual(calls1h, 1); assert.strictEqual(r.age15Min, 0); assert.strictEqual(r.age1hMin, 11);

    // a failing fetch keeps the old bars, and does not retry until retryMs has passed
    fail15 = true; t += 11 * 60000; r = await c.get();
    assert.strictEqual(calls15, 3); assert.strictEqual(r.c15.length, 50);
    t += 60000; await c.get(); assert.strictEqual(calls15, 3);          // cooling down
    t += 2 * 60000; await c.get(); assert.strictEqual(calls15, 4);      // retried
    fail15 = false; t += 3 * 60000; r = await c.get(); assert.strictEqual(calls15, 5); assert.strictEqual(r.age15Min, 0);

    // an empty result counts as a failure and keeps the old bars; a first-ever failure gives null, not a throw
    const c2 = createHtfCache({ fetch15: async () => [], fetch1h: async () => { throw new Error('x'); }, now: () => t });
    r = await c2.get(); assert.strictEqual(r.c15, null); assert.strictEqual(r.c1h, null); assert.strictEqual(r.age15Min, null);

    // concurrent callers share one in-flight fetch
    let n = 0;
    const c3 = createHtfCache({ fetch15: async () => { n++; await new Promise(res => setTimeout(res, 20)); return bars(5); }, fetch1h: async () => bars(5), now: () => t });
    await Promise.all([c3.get(), c3.get(), c3.get()]);
    assert.strictEqual(n, 1);

    console.log('htfCache tests passed');
})().catch(e => { console.error(e); process.exit(1); });