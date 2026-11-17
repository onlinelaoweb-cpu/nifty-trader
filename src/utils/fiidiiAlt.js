'use strict';
// 17 Nov — FALLBACK source for FII/DII cash data when NSE blocks Railway's IP.
// Source: Groww's public FII/DII page (HTML table, latest row first). The page layout is NOT a documented
// API, so parsing is defensive and VALIDATED: a parse is accepted only if, for both FII and DII,
// net == buy - sell (within Rs 1 Cr). A layout change then yields null (logged) instead of wrong numbers.
const URL = 'https://www.groww.in/fii-dii-data';
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function _text(html) {
    return String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}
const _ok = (b, s, n) => [b, s, n].every(Number.isFinite) && b > 0 && s > 0 && Math.abs((b - s) - n) <= 1;

function parseGrowwFiiDii(html) {
    const t = _text(html);
    const re = /(\d{1,2})[\s-]+([A-Za-z]{3})[a-z]*[\s,-]+(\d{4})/g;
    let m;
    while ((m = re.exec(t))) {
        const mo = MON[m[2].toLowerCase()];
        if (mo === undefined) continue;
        const tail = t.slice(m.index + m[0].length, m.index + m[0].length + 260);
        const nums = (tail.match(/[+-]?\d[\d,]*\.?\d*/g) || []).slice(0, 8)
            .map(x => parseFloat(x.replace(/,/g, ''))).filter(Number.isFinite);
        if (nums.length < 6) continue;
        const [a, b, c, d, e, f] = nums;
        // layout A: FII buy,sell,net, DII buy,sell,net      layout B: DII first
        const date = `${m[3]}-${String(mo + 1).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
        if (_ok(a, b, c) && _ok(d, e, f)) return { date, fiiBuy: a, fiiSell: b, fiiNet: c, diiBuy: d, diiSell: e, diiNet: f };
        return null;   // first dated row did not validate: layout changed, do not guess
    }
    return null;
}

async function fetchGrowwFiiDii(axios) {
    const r = await axios.get(URL, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept': 'text/html' } });
    const p = parseGrowwFiiDii(r.data);
    if (!p) throw new Error('groww parse failed (layout changed?) len=' + String(r.data || '').length);
    return p;
}

module.exports = { parseGrowwFiiDii, fetchGrowwFiiDii, URL };
