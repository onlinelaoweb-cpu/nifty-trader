// fyersUsage.js — 15 Oct 2026
// READ-ONLY counter for Fyers API calls. It never changes, delays, retries or blocks a call: it only counts what the app sends so the
// real daily / per-minute / per-second usage can be compared with Fyers' Standard-plan Data-API limits (5/sec, 50/min, 5,000/day).
// Counts are what THIS app sends (attempts, including ones that came back 429) — Fyers' own meter may differ slightly.
// In memory only: a restart/redeploy resets it (the periodic log line keeps the history in Railway logs).

const LIMITS = { perSec: 5, perMin: 50, perDay: 5000 };   // Fyers Standard plan, Data APIs (fyers.in/api-docs/v3/getting-started/plans-and-limits, 11 Oct 2026)

function istParts(ms) {
    const d = new Date(ms + 5.5 * 3600 * 1000);
    return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

function createFyersUsage({ now = Date.now } = {}) {
    let S;
    const fresh = (date) => ({
        date, data: 0, other: 0, status429: 0, last429At: null,
        byEndpoint: {}, byHour: {},
        secBuckets: new Map(), minBuckets: new Map(),          // rolling, pruned
        peakPerSec: 0, secondsOver: 0, peakPerMin: 0, minutesOver: 0,
        _secOver: new Set(), _minOver: new Set(),
    });
    S = fresh(istParts(now()).date);

    function roll() {
        const t = istParts(now());
        if (t.date !== S.date) S = fresh(t.date);
    }

    function endpointOf(url) {
        try {
            const u = new URL(url);
            if (!/(^|\.)fyers\.in$/i.test(u.hostname)) return null;
            return u.pathname;
        } catch (e) { return null; }
    }

    // record one outgoing call
    function record(url) {
        try {
            const ep = endpointOf(url);
            if (!ep) return false;
            roll();
            const ms = now();
            S.byEndpoint[ep] = (S.byEndpoint[ep] || 0) + 1;
            if (!ep.startsWith('/data/')) { S.other++; return true; }
            S.data++;
            const h = istParts(ms).hour;
            S.byHour[h] = (S.byHour[h] || 0) + 1;
            const sec = Math.floor(ms / 1000), min = Math.floor(ms / 60000);
            const ns = (S.secBuckets.get(sec) || 0) + 1; S.secBuckets.set(sec, ns);
            const nm = (S.minBuckets.get(min) || 0) + 1; S.minBuckets.set(min, nm);
            if (ns > S.peakPerSec) S.peakPerSec = ns;
            if (nm > S.peakPerMin) S.peakPerMin = nm;
            if (ns > LIMITS.perSec && !S._secOver.has(sec)) { S._secOver.add(sec); S.secondsOver++; }
            if (nm > LIMITS.perMin && !S._minOver.has(min)) { S._minOver.add(min); S.minutesOver++; }
            for (const k of S.secBuckets.keys()) if (k < sec - 120) S.secBuckets.delete(k);
            for (const k of S.minBuckets.keys()) if (k < min - 10) S.minBuckets.delete(k);
            return true;
        } catch (e) { return false; }
    }

    function record429(url) {
        try {
            const ep = endpointOf(url);
            if (!ep) return;
            roll();
            S.status429++; S.last429At = new Date(now()).toISOString();
        } catch (e) { /* never throw */ }
    }

    function snapshot() {
        roll();
        const ms = now(), min = Math.floor(ms / 60000);
        const pct = Math.round((S.data / LIMITS.perDay) * 1000) / 10;
        return {
            date: S.date, limits: LIMITS,
            dataCallsToday: S.data, dailyLimitUsedPct: pct,
            callsThisMinute: S.minBuckets.get(min) || 0,
            callsLastMinute: S.minBuckets.get(min - 1) || 0,
            peakPerSecond: S.peakPerSec, secondsOverPerSecLimit: S.secondsOver,
            peakPerMinute: S.peakPerMin, minutesOverPerMinLimit: S.minutesOver,
            status429Today: S.status429, last429At: S.last429At,
            otherFyersCallsToday: S.other,
            byEndpoint: { ...S.byEndpoint }, dataCallsByHourIST: { ...S.byHour },
            note: 'Counts are what this app sent (incl. calls answered 429). Resets on restart/redeploy. Fyers blocks the user for the rest of the day if the per-minute limit is exceeded more than 3 times in a day.',
        };
    }

    function summaryLine() {
        const s = snapshot();
        return `📈 [FyersUsage ${s.date}] data calls ${s.dataCallsToday}/${s.limits.perDay} (${s.dailyLimitUsedPct}%) · peak ${s.peakPerMinute}/min (>${s.limits.perMin}: ${s.minutesOverPerMinLimit} min) · peak ${s.peakPerSecond}/sec (>${s.limits.perSec}: ${s.secondsOverPerSecLimit} sec) · 429s ${s.status429Today}`;
    }

    return { record, record429, snapshot, summaryLine, LIMITS };
}

module.exports = { createFyersUsage, LIMITS };