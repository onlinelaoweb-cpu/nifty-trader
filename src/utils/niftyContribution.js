// ── "Who is driving Nifty?" — contribution maths + quote fetch (3 Oct) ────────
// Contribution of a stock to the index move = its weight × its % move.
//   index points = (weight/100) × (changePct/100) × previous close of Nifty
// Weights come from niftyWeights.js (OFFICIAL top-10 + sector weights from the NSE
// factsheet). The other 40 stocks are NOT estimated: their combined contribution is
// DERIVED as (Nifty's actual move) − (top-10 contribution), and labelled as derived.
//
// WHERE THE NIFTY MOVE COMES FROM (important — a real bug was found here on 4 Oct):
//   1. Yahoo's index quote (^NSEI) fetched in the SAME request as the stocks — same moment, same
//      source, so "index − top-10" is a like-for-like subtraction and it still works when the
//      market is closed (it then shows the last session's move).
//   2. else the app's own live Nifty, but ONLY when the market is open and the number is real.
//   3. else NOTHING: the derived "rest" line and the verdict are switched off. The app zeroes
//      marketState.nifty/change on weekends; that 0 is "no data", never "Nifty did not move".
//
// Everything below except fetchTopQuotes() is PURE (no I/O, no clock) so it is
// unit-testable. Display only — nothing here feeds signals, gates or alerts.

const DAY_MS = 86400000;
const DOMINANCE_RATIO = 2;   // one basket must move >= 2x the other to be called 'dominant'
const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const r2 = v => v === null ? null : Math.round(v * 100) / 100;
const r1 = v => v === null ? null : Math.round(v * 10) / 10;

function weightAgeDays(weights, nowMs) {
    const t = Date.parse(weights.asOf + 'T00:00:00+05:30');
    return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / DAY_MS)) : null;
}

// quotes: { SYMBOL: { price, changePct } }  (symbol = NSE symbol, e.g. 'HDFCBANK', 'M&M')
// nifty : { price, change, changePct, prevClose }  — the app's own live Nifty numbers
// sectors: marketState.global.sectors  ({ bankNifty:{changePct}, niftyIT:{changePct}, ... })
function computeNiftyContribution({ weights, quotes, nifty, indexQuote, sectors, nowMs, marketClosed, quoteSource, quotesAt }) {
    const q = quotes || {};
    // ── Which Nifty numbers can be trusted? (see header) ──
    const appPrev = (() => {
        const p = num(nifty?.prevClose);
        if (p && p > 0) return p;
        const price = num(nifty?.price), ch = num(nifty?.change);
        return price && ch !== null ? price - ch : null;
    })();
    const yIdx = (() => {                                  // Yahoo ^NSEI, sanity-checked
        const price = num(indexQuote?.price), prev = num(indexQuote?.prevClose);
        if (!(price > 0) || !(prev > 0) || Math.abs(price / prev - 1) > 0.15) return null;
        return { price, prevClose: prev, change: price - prev, changePct: ((price - prev) / prev) * 100 };
    })();
    const appLive = !marketClosed && num(nifty?.price) > 0 && num(nifty?.change) !== null && appPrev > 0;
    let basis = null;
    if (yIdx) basis = { ...yIdx, source: 'yahoo' };
    else if (appLive) basis = { price: num(nifty.price), prevClose: appPrev, change: num(nifty.change),
                                changePct: num(nifty.changePct) ?? (num(nifty.change) / appPrev) * 100, source: 'app' };
    // Per-stock points need a base level; with no trustworthy index data the app's prevClose is used
    // (off by <1% at most) so the stock rows still show — only the derived 'rest' and verdict are disabled.
    const prevClose = basis ? basis.prevClose : (appPrev > 0 ? appPrev : null);
    const niftyPts = basis ? basis.change : null;
    const niftyPct = basis ? basis.changePct : null;

    const pts = (weight, pct) => (prevClose && pct !== null) ? (weight / 100) * (pct / 100) * prevClose : null;

    const rows = weights.top10.map(s => {
        const pct = num(q[s.symbol]?.changePct);
        const p = pts(s.weight, pct);
        return {
            symbol: s.symbol, name: s.name, weight: s.weight,
            price: num(q[s.symbol]?.price), changePct: pct === null ? null : r2(pct),
            pts: p === null ? null : r1(p),
            idxPct: pct === null ? null : r2((s.weight / 100) * pct),   // contribution in "% of index" units
            hasQuote: pct !== null,
        };
    });
    const priced = rows.filter(r => r.hasQuote);
    const missing = rows.filter(r => !r.hasQuote).map(r => r.symbol);
    // biggest movers first; stocks with no quote go to the bottom
    rows.sort((a, b) => (b.hasQuote - a.hasQuote) || (Math.abs(b.pts ?? 0) - Math.abs(a.pts ?? 0)));

    const topWeight = priced.reduce((a, r) => a + r.weight, 0);
    // no priced stock => no top-10 number at all (a 0 here would make the whole index look like 'rest')
    const topPtsRaw = (prevClose && priced.length) ? priced.reduce((a, r) => a + pts(r.weight, r.changePct), 0) : null;
    const topIdxPct = priced.reduce((a, r) => a + (r.weight / 100) * r.changePct, 0);
    const topAvgMove = topWeight > 0 ? (topIdxPct / (topWeight / 100)) : null;       // weighted average % move of the priced top-10

    // Everything not priced above = "rest" (the other 40 + any top-10 stock with no quote)
    const restWeight = 100 - topWeight;
    let restPtsRaw = null, restImpliedMove = null;
    if (niftyPts !== null && topPtsRaw !== null) {
        restPtsRaw = niftyPts - topPtsRaw;
        restImpliedMove = (prevClose && restWeight > 0) ? (restPtsRaw / ((restWeight / 100) * prevClose)) * 100 : null;
    }

    // Plain classification — signs only (no invented thresholds beyond "is it basically flat")
    const EPS = 0.05; // % — below this a basket is treated as flat
    let verdict = { kind: 'NA' };
    if (topAvgMove !== null && restImpliedMove !== null) {
        const a = Math.abs(topAvgMove) < EPS ? 0 : Math.sign(topAvgMove);
        const b = Math.abs(restImpliedMove) < EPS ? 0 : Math.sign(restImpliedMove);
        const kind = a === 0 && b === 0 ? 'FLAT' : (a !== 0 && b !== 0 && a === b) ? 'BROAD' : (a !== 0 && b !== 0) ? 'DIVERGENT' : 'ONE_SIDED';
        // When both baskets move the same way, say WHICH one moved much more. "Much" = at least DOMINANCE_RATIO times
        // the other's size (a plain, visible rule — not a statistical test). Otherwise they are about equal.
        let dominant = null;
        if (kind === 'BROAD') {
            const ratio = Math.abs(restImpliedMove) / Math.abs(topAvgMove);
            dominant = ratio >= DOMINANCE_RATIO ? 'rest' : ratio <= 1 / DOMINANCE_RATIO ? 'top10' : null;
        }
        verdict = { kind, dominant, direction: kind === 'BROAD' ? a : null,
                    topAvgMove: r2(topAvgMove), restImpliedMove: r2(restImpliedMove) };
    }

    // Who pushed the net move the most? The three biggest contributors IN THE SAME DIRECTION as the net move
    // (draggers when the index fell, lifters when it rose), and their share of that net move. Contributors
    // pulling the other way are deliberately not mixed in — a "share" with the opposite sign is meaningless.
    // Shown only when the net move is big enough (>= 10 pts) to mean something.
    let top3 = null;
    if (niftyPts !== null && Math.abs(niftyPts) >= 10) {
        const dir = Math.sign(niftyPts);
        const same = priced.filter(r => Math.sign(r.pts) === dir).sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)).slice(0, 3);
        if (same.length) {
            const sum = same.reduce((a, r) => a + r.pts, 0);
            top3 = { kind: dir < 0 ? 'draggers' : 'lifters', names: same.map(r => r.name), pts: r1(sum), sharePct: Math.round((sum / niftyPts) * 100) };
        }
    }

    // Sectors: official weight (always) + live move of the matching app index where there is one
    const sec = weights.sectors.map(s => {
        const pct = s.indexKey ? num(sectors?.[s.indexKey]?.changePct) : null;
        const p = pct !== null ? pts(s.weight, pct) : null;
        return { name: s.name, weight: s.weight, indexChangePct: pct === null ? null : r2(pct), pts: p === null ? null : r1(p), proxy: s.proxy || null };
    });

    const ageDays = weightAgeDays(weights, nowMs ?? 0);
    return {
        asOf: weights.asOf, source: weights.source, ageDays,
        stale: ageDays !== null && ageDays > (weights.staleAfterDays ?? 45),
        marketClosed: !!marketClosed, quoteSource: quoteSource || 'none', quotesAt: quotesAt || null,
        nifty: { price: basis ? r2(basis.price) : null, change: niftyPts === null ? null : r1(niftyPts), changePct: niftyPct === null ? null : r2(niftyPct), prevClose: prevClose === null ? null : r2(prevClose), source: basis ? basis.source : 'none' },
        top10: rows,
        topSummary: { weight: r2(topWeight), pts: topPtsRaw === null ? null : r1(topPtsRaw), avgMovePct: topAvgMove === null ? null : r2(topAvgMove), missing },
        rest: { weight: r2(restWeight), pts: restPtsRaw === null ? null : r1(restPtsRaw), impliedMovePct: restImpliedMove === null ? null : r2(restImpliedMove), derived: true, partial: missing.length > 0 },
        verdict, top3, sectors: sec,
    };
}

// Yahoo "spark" batch quote — the same no-auth endpoint breadth.js already relies on from Railway.
// Stocks AND the Nifty index (^NSEI) go in ONE request so every number is from the same moment.
// Symbols are URL-encoded ("M&M.NS", "^NSEI"). Returns { quotes: {SYMBOL:{price,changePct}}, index } or null
// when no stock quote came back. `index` is { price, prevClose } or null (the card then falls back, see header).
async function fetchTopQuotes(axios, yahooSymbols, indexSymbol = '^NSEI') {
    const HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/', 'Origin': 'https://finance.yahoo.com',
    };
    const all = indexSymbol ? [...yahooSymbols, indexSymbol] : yahooSymbols;
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${all.map(encodeURIComponent).join(',')}&range=1d&interval=1d&indicators=close&includeTimestamps=false`;
    try {
        const res = await axios.get(url, { timeout: 10000, headers: HEADERS });
        const spark = res.data?.spark?.result;
        if (!Array.isArray(spark)) return null;
        const quotes = {};
        let index = null;
        for (const s of spark) {
            const raw = String(s.symbol || '');
            const meta = s.response?.[0]?.meta || {};
            const price = num(meta.regularMarketPrice);
            const prev = num(meta.chartPreviousClose) ?? num(meta.previousClose);
            if (!(price > 0) || !(prev > 0)) continue;
            if (indexSymbol && raw === indexSymbol) { index = { price: r2(price), prevClose: r2(prev) }; continue; }
            const sym = raw.replace(/\.NS$/, '');
            if (sym) quotes[sym] = { price: r2(price), changePct: r2(((price - prev) / prev) * 100) };
        }
        return Object.keys(quotes).length ? { quotes, index } : null;
    } catch (e) {
        console.warn('[NiftyContribution] Yahoo spark failed:', e.response?.status || e.message);
        return null;
    }
}

// Fallback when Yahoo is unreachable: reuse the stocks[] the breadth module already holds.
function quotesFromBreadth(breadthStocks) {
    if (!Array.isArray(breadthStocks)) return null;
    const out = {};
    for (const s of breadthStocks) {
        const pct = num(s.changePct);
        if (s.symbol && pct !== null) out[s.symbol] = { price: num(s.price), changePct: pct };
    }
    return Object.keys(out).length ? out : null;
}

module.exports = { computeNiftyContribution, fetchTopQuotes, quotesFromBreadth, weightAgeDays };