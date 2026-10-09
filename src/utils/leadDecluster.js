'use strict';
// ── One lead per event (10 Oct) ───────────────────────────────────────────────
// The MTF tracker (especially in Aug, with a looser cooldown) logged many leads within minutes of each other on the SAME side:
// one price move counted 5–7 times (18 Aug 10:02–10:13: seven +50% targets). Averages over raw leads reward the days with the most
// duplicates. This keeps the FIRST lead of each side and then skips further same-side leads until gapMin minutes have passed since
// the last KEPT lead — what a trader who acts on the first alert would actually have had.
// gapMin <= 0 (or missing) returns everything unchanged. Items without a usable time are always kept. Pure function.

function declusterLeads(items, gapMin, getMs, getSide) {
    const list = Array.isArray(items) ? items.slice() : [];
    if (!(gapMin > 0)) return list;
    const withMs = list.map((x, i) => ({ x, i, ms: getMs(x) }));
    const timed = withMs.filter(o => Number.isFinite(o.ms)).sort((a, b) => a.ms - b.ms || a.i - b.i);
    const keepIdx = new Set(withMs.filter(o => !Number.isFinite(o.ms)).map(o => o.i));
    const lastKept = new Map();
    for (const o of timed) {
        const side = String(getSide(o.x) ?? 'x');
        if (lastKept.has(side) && o.ms - lastKept.get(side) < gapMin * 60000) continue;
        lastKept.set(side, o.ms);
        keepIdx.add(o.i);
    }
    return list.filter((_, i) => keepIdx.has(i));
}

module.exports = { declusterLeads };