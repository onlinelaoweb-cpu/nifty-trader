'use strict';
const assert = require('assert');
const { parseGrowwFiiDii } = require('../src/utils/fiidiiAlt');
const html = '<table><tr><th>Date</th><th>FII Buy</th></tr><tr><td>13 Nov 2026</td><td>18,339.57</td><td>12,603.02</td><td>+5,736.55</td><td>11,745.95</td><td>13,999.53</td><td>-2,253.58</td></tr><tr><td>12 Nov 2026</td><td>1</td></tr></table>';
const r = parseGrowwFiiDii(html);
assert.deepStrictEqual(r, { date: '2026-11-13', fiiBuy: 18339.57, fiiSell: 12603.02, fiiNet: 5736.55, diiBuy: 11745.95, diiSell: 13999.53, diiNet: -2253.58 });
// inconsistent numbers (layout changed) -> null, never a guess
assert.strictEqual(parseGrowwFiiDii(html.replace('+5,736.55', '+9,999.00')), null);
assert.strictEqual(parseGrowwFiiDii('<html>nothing</html>'), null);
assert.strictEqual(parseGrowwFiiDii(''), null);
console.log('fiidiiAlt ok');
