'use strict';
const assert = require('assert');
const N = require('../public/js/sm-notes');
const comps = (o) => [
  { label: 'OI Buildup', pts: o.oi || 0 }, { label: 'FII Flow', pts: o.fii || 0 }, { label: 'DII Flow', pts: o.dii || 0 },
  { label: 'PCR Level', pts: o.pcr || 0 }, { label: 'ATM Flow', pts: o.atm || 0 }];

// 13 Nov close: FII +2, DII -1, PCR -1 => background 0? (+2-1-1)=0 -> no score line
let r = N.compute({ score: 0, components: comps({ fii: 2, dii: -1, pcr: -1 }) }, { entryWindow: { status: 'closed' }, signal: 'WAIT' });
assert.strictEqual(r.scoreLine, null); assert.strictEqual(r.closedText, 'Market band — data 09:15 ke baad');
assert.ok(/WAIT/.test(r.effectLine));
// background-heavy score is explained
r = N.compute({ score: -3, components: comps({ fii: -2, dii: -1, pcr: -1, atm: 1 }) }, { entryWindow: { status: 'trade' }, signal: 'WAIT' });
assert.strictEqual(r.live, 1); assert.strictEqual(r.bg, -4); assert.strictEqual(r.closedText, null);
assert.ok(/Score -3 = live \+1 .* − background 4/.test(r.scoreLine), r.scoreLine);
// real signal: shows the server's own confluence line (tags stripped)
r = N.compute({ score: 4, components: comps({ oi: 2, fii: 2 }) }, { entryWindow: { status: 'trade' }, signal: 'BUY CALL', reason: ['x', '<b>💰 Smart Money BULLISH (score 4) — confluence +4%</b>'] });
assert.ok(/^Is signal par asar: 💰 Smart Money BULLISH \(score 4\) — confluence \+4%$/.test(r.effectLine), r.effectLine);
r = N.compute({ score: 0, components: comps({}) }, { signal: 'BUY PUT', reason: ['nothing relevant'] });
assert.ok(/nahi badla/.test(r.effectLine));
r = N.compute({ score: -5, components: comps({ oi: -2 }) }, { signal: 'BUY CALL', reason: ['⚠️ Smart Money STRONGLY BEARISH (score -5) contradicts — confidence -15%'] });
assert.ok(/-15%/.test(r.effectLine));
// garbage never throws
assert.doesNotThrow(() => N.compute(null, null)); assert.doesNotThrow(() => N.compute({ components: 'x' }, { reason: 5 }));
assert.doesNotThrow(() => N.compute({ components: [null, { label: 'FII Flow', pts: 'a' }] }, {}));
console.log('smNotes tests passed');
