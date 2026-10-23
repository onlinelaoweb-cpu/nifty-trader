'use strict';
// The page (public/index.html) keeps its own copy of the NSE holiday list for the "Next session" label and countdown. A copy that drifts
// from the backend list (src/api/nseData.js NSE_HOLIDAYS) shows a wrong "Next session" (found on 24 Oct: 7 wrong/missing dates).
// This test fails the build if the two lists ever differ, and checks that the page script still parses.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const grab = (src, re) => { const m = re.exec(src); assert(m, 'holiday list not found: ' + re); return [...m[1].matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map(x => x[1]).sort(); };
const backend = grab(read('src/api/nseData.js'), /const NSE_HOLIDAYS = new Set\(\[([\s\S]*?)\]\)/);
const page = grab(read('public/index.html'), /const NSE_HOLIDAYS_2026 = new Set\(\[([\s\S]*?)\]\)/);
assert(backend.length >= 10, 'backend list looks empty');
assert.deepStrictEqual(page, backend, 'index.html holiday list differs from src/api/nseData.js');
backend.forEach(d => { const wd = new Date(d + 'T00:00:00Z').getUTCDay(); assert(wd >= 1 && wd <= 5 || d === '2026-08-15', d + ' is a weekend day in the list (only 15 Aug is kept for documentation)'); });
// no second copy of a hard-coded holiday set may creep back into the page
assert.strictEqual((read('public/index.html').match(/new Set\(\[\s*'2026-/g) || []).length, 1, 'only one holiday Set literal allowed in index.html');
// every inline <script> of the page must still be valid JavaScript
const html = read('public/index.html'); let n = 0;
for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) { new vm.Script(m[1], { filename: 'index.html#script' + (++n) }); }
assert(n >= 1, 'no inline script found');
console.log('holidayListSync tests OK (' + backend.length + ' holidays, ' + n + ' inline script(s) parse)');