'use strict';
// ── Higher-timeframe candle cache (9 Oct) ─────────────────────────────────────
// The MTF vote logger needs 15m and 1h candles for CRUDE and BITCOIN, which the server only builds as short in-memory 1m series.
// This wraps a fetcher with a time-to-live so the exchange / Yahoo is called rarely:
//   15m bars refreshed at most every ttl15Ms, 1h bars at most every ttl1hMs (1h bars barely change, so fetch them less).
// On a failed or empty fetch the LAST GOOD bars are kept (a rate-limit 429 must not blank the vote), and a failure waits retryMs before the next try.
// A call that is already in flight is shared, so two callers never double-fetch. Pure apart from the injected fetchers and clock.

function createHtfCache({ fetch15, fetch1h, ttl15Ms = 10 * 60000, ttl1hMs = 30 * 60000, retryMs = 2 * 60000, now = Date.now, log = () => {} }) {
    const slot = (fetcher, ttl, name) => ({ name, fetcher, ttl, bars: null, okAt: 0, tryAt: 0, inflight: null, fails: 0 });
    const s15 = slot(fetch15, ttl15Ms, '15m'), s1h = slot(fetch1h, ttl1hMs, '1h');

    async function refresh(s) {
        const t = now();
        const fresh = s.bars && t - s.okAt < s.ttl;
        const cooling = t - s.tryAt < retryMs && s.fails > 0;
        if (fresh || cooling) return;
        if (s.inflight) return s.inflight;
        s.tryAt = t;
        s.inflight = (async () => {
            try {
                const bars = await s.fetcher();
                if (Array.isArray(bars) && bars.length) { s.bars = bars; s.okAt = now(); s.fails = 0; }
                else { s.fails++; log(`[htf] ${s.name} fetch returned no bars (kept ${s.bars ? s.bars.length : 0} old)`); }
            } catch (e) { s.fails++; log(`[htf] ${s.name} fetch error: ${e && e.message}`); }
            finally { s.inflight = null; }
        })();
        return s.inflight;
    }

    return {
        async get() {
            await Promise.all([refresh(s15), refresh(s1h)]);
            const t = now();
            return {
                c15: s15.bars, c1h: s1h.bars,
                age15Min: s15.bars ? Math.round((t - s15.okAt) / 60000) : null, age1hMin: s1h.bars ? Math.round((t - s1h.okAt) / 60000) : null,
            };
        },
    };
}

module.exports = { createHtfCache };