'use strict';
// 28 Oct — automatic Nifty weights (like the futures contract auto-roll).
// Source: NSE per-stock free-float market cap (`ffmc`) from the Nifty 50 rows the app already
// fetches (yahooFetch.fetchNifty50Stocks). weight% = ffmc / sum(ffmc) * 100 — the same method NSE uses.
// Safe by design: every failure path keeps the static tables (niftyWeights.js / breadth.js) untouched.
//   • needs >= 45 rows with ffmc > 0
//   • the official top-10 (factsheet) must agree within MAX_DRIFT_PP, else the whole refresh is rejected
//   • env NIFTY_WEIGHTS_AUTO=0 switches it off
const MAX_DRIFT_PP = 2.5;
const MIN_ROWS = 45;

function computeWeightsFromRows(rows) {
    if (!Array.isArray(rows)) return null;
    const ok = rows.filter(r => r && r.symbol && !/^NIFTY/i.test(String(r.symbol)) && Number(r.ffmc) > 0);
    if (ok.length < MIN_ROWS) return null;
    const total = ok.reduce((s, r) => s + Number(r.ffmc), 0);
    if (!(total > 0)) return null;
    const map = {};
    for (const r of ok) map[String(r.symbol)] = Number(((Number(r.ffmc) / total) * 100).toFixed(2));
    return map;
}

// Returns '' when consistent, else the reason. officialTop10 = niftyWeights.js top10 array.
function validateAgainstOfficial(map, officialTop10, maxDrift = MAX_DRIFT_PP) {
    if (!map) return 'no map';
    for (const o of officialTop10 || []) {
        const a = map[o.symbol];
        if (a === undefined) return `${o.symbol} missing`;
        if (Math.abs(a - o.weight) > maxDrift) return `${o.symbol} ${a}% vs official ${o.weight}%`;
    }
    return '';
}

let _state = { weights: null, at: 0, n: 0 };

async function refreshAutoWeights({ fetchRows, officialTop10, applyToBreadth, log = console }) {
    if (process.env.NIFTY_WEIGHTS_AUTO === '0') return { ok: false, why: 'disabled' };
    try {
        const rows = await fetchRows();
        const withFfmc = (rows || []).filter(r => Number(r && r.ffmc) > 0).length;
        log.log(`[NiftyWeightsAuto] rows=${(rows || []).length} withFfmc=${withFfmc}`);
        const map = computeWeightsFromRows(rows);
        if (!map) return { ok: false, why: 'ffmc not available' };
        const bad = validateAgainstOfficial(map, officialTop10);
        if (bad) { log.warn(`[NiftyWeightsAuto] rejected — ${bad}`); return { ok: false, why: bad }; }
        _state = { weights: map, at: Date.now(), n: Object.keys(map).length };
        let applied = 0;
        if (typeof applyToBreadth === 'function') applied = applyToBreadth(map);
        log.log(`[NiftyWeightsAuto] OK — ${_state.n} stocks, breadth table updated: ${applied}`);
        return { ok: true, n: _state.n, applied };
    } catch (e) {
        log.warn('[NiftyWeightsAuto] error:', e.message);
        return { ok: false, why: e.message };
    }
}

// Official-file structure with top-10 weights swapped for the live ones (sectors stay as published).
function effectiveWeights(base) {
    if (!_state.weights) return base;
    const top10 = base.top10.map(s => (_state.weights[s.symbol] !== undefined ? { ...s, weight: _state.weights[s.symbol] } : s));
    return { ...base, top10, source: base.source + ' · top-10 live NSE free-float (auto)' };
}

function getAutoWeightsState() { return { ..._state }; }

module.exports = { computeWeightsFromRows, validateAgainstOfficial, refreshAutoWeights, effectiveWeights, getAutoWeightsState, MAX_DRIFT_PP, MIN_ROWS };