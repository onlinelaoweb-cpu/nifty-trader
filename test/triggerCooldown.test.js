const assert = require('assert');
const { shouldFireAfterCooldown: f } = require('../src/utils/triggerCooldown');
const MIN = 60000, CD = 30 * MIN, T = 1_000_000_000;
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok -', name); };

t('first fire (no history) fires', () => assert.strictEqual(f(null, 'CE', T, CD), true));
t('same side within cooldown is blocked (16 Oct: 22:44 -> 22:53 / 23:01 / 23:11 / 23:14)', () => {
    const last = { side: 'CE', at: T };
    [9, 17, 27, 30 - 1].forEach(m => assert.strictEqual(f(last, 'CE', T + m * MIN, CD), false));
});
t('same side after cooldown fires again', () => {
    assert.strictEqual(f({ side: 'CE', at: T }, 'CE', T + 30 * MIN, CD), true);
    assert.strictEqual(f({ side: 'CE', at: T }, 'CE', T + 31 * MIN, CD), true);
});
t('opposite side always fires, even inside cooldown', () => assert.strictEqual(f({ side: 'CE', at: T }, 'PE', T + MIN, CD), true));
t('no side -> never fires', () => { assert.strictEqual(f(null, null, T, CD), false); assert.strictEqual(f(null, undefined, T, CD), false); });
t('bad history / bad inputs fail open (fire), never throw', () => {
    assert.strictEqual(f({ side: 'CE' }, 'CE', T, CD), true);
    assert.strictEqual(f({ side: 'CE', at: T }, 'CE', NaN, CD), true);
    assert.strictEqual(f({ side: 'CE', at: T }, 'CE', T + MIN, 0), true);
});
console.log(`[triggerCooldown] ${n} tests passed`);