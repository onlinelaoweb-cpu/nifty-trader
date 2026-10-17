'use strict';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const L = require('../src/utils/fyersLogin');

const jwt = expSec => 'h.' + Buffer.from(JSON.stringify({ exp: expSec })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.s';
const NOW = Date.UTC(2026, 9, 19, 3, 0);                       // Mon 19 Oct 08:30 IST
const fresh = jwt(Math.floor((NOW + 20 * 3600000) / 1000)), stale = jwt(Math.floor((NOW - 3600000) / 1000));

// hash matches the documented appId:secret SHA-256
assert.strictEqual(L.appIdHash('A-100', 'S'), require('crypto').createHash('sha256').update('A-100:S').digest('hex'));

// auth code extraction
const code = 'eyJhbGciOiJIUzI1NiJ9.eyJhdXRoIjoiY29kZSJ9.abcdefghijk1234567890';
assert.strictEqual(L.extractAuthCode(`https://trade.fyers.in/api-login/redirect-uri/index.html?s=ok&code=200&auth_code=${code}&state=vardaannifty`), code);
assert.strictEqual(L.extractAuthCode(`auth_code=${code}`), code);
assert.strictEqual(L.extractAuthCode(`  ${code}  `), code);
assert.strictEqual(L.extractAuthCode(''), null); assert.strictEqual(L.extractAuthCode('hello'), null); assert.strictEqual(L.extractAuthCode(null), null);

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fyl-'));
    let cur = '', posted = null;
    const env = { FYERS_APP_ID: '2U5JAL826U-100', FYERS_SECRET_ID: 'SECRETX' };
    const mk = (post, extra = {}) => L.createFyersLogin({ env: () => ({ ...env, ...(extra.env || {}) }), post, apply: t => { cur = t; }, current: () => cur, dir, now: () => NOW });

    // login URL carries the app id and the registered redirect, never the secret
    const lg = mk(async () => ({ data: {} }));
    const u = lg.loginUrl(); assert(u.includes('client_id=2U5JAL826U-100') && u.includes('generate-authcode') && !u.includes('SECRETX'));
    assert.strictEqual(mk(null, { env: { FYERS_APP_ID: '' } }).loginUrl(), null);

    // status: no token / stale / fresh
    assert.strictEqual(lg.status().hasToken, false);
    cur = stale; assert.strictEqual(lg.status().valid, false);
    cur = fresh; const st = lg.status(); assert.strictEqual(st.valid, true); assert(st.minutesLeft > 1000 && /IST$/.test(st.expiresAt)); assert.strictEqual(st.configured, true);
    cur = '';

    // good exchange: sends hash + code, applies token, saves file, result never contains the token
    const ok = mk(async (url, body) => { posted = { url, body }; return { data: { s: 'ok', code: 200, access_token: fresh, refresh_token: 'RRR' } }; });
    const r = await ok.exchange(`https://x/?auth_code=${code}&state=s`);
    assert.strictEqual(r.ok, true); assert.strictEqual(cur, fresh); assert.strictEqual(r.saved, true);
    assert(!JSON.stringify(r).includes(fresh) && !JSON.stringify(r).includes('RRR'));
    assert.strictEqual(posted.url, 'https://api-t1.fyers.in/api/v3/validate-authcode');
    assert.deepStrictEqual(posted.body, { grant_type: 'authorization_code', appIdHash: L.appIdHash('2U5JAL826U-100', 'SECRETX'), code });
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'fyers-token.json'), 'utf8')).access_token, fresh);

    // bad inputs / Fyers errors never change the token
    cur = 'KEEP';
    assert.strictEqual((await ok.exchange('garbage')).ok, false); assert.strictEqual(cur, 'KEEP');
    assert.strictEqual((await mk(async () => ({ data: { s: 'error', message: 'invalid code' } })).exchange(code)).ok, false); assert.strictEqual(cur, 'KEEP');
    const thrown = await mk(async () => { const e = new Error('boom'); e.response = { data: { message: 'auth_code expired' } }; throw e; }).exchange(code);
    assert.strictEqual(thrown.ok, false); assert(/expired/.test(thrown.error)); assert.strictEqual(cur, 'KEEP');
    assert.strictEqual((await mk(null, { env: { FYERS_SECRET_ID: '' } }).exchange(code)).ok, false);

    // loadSaved: newer saved token beats an older env token; an older/expired one never overrides
    cur = stale; assert.strictEqual(ok.loadSaved(), true); assert.strictEqual(cur, fresh);
    cur = jwt(Math.floor((NOW + 40 * 3600000) / 1000)); const later = cur; assert.strictEqual(ok.loadSaved(), false); assert.strictEqual(cur, later);
    fs.writeFileSync(path.join(dir, 'fyers-token.json'), JSON.stringify({ access_token: stale })); cur = ''; assert.strictEqual(ok.loadSaved(), false); assert.strictEqual(cur, '');
    fs.unlinkSync(path.join(dir, 'fyers-token.json')); assert.strictEqual(ok.loadSaved(), false);

    // unwritable folder is not fatal
    fs.writeFileSync(path.join(dir, 'afile'), 'x');                                 // a FILE in the way -> mkdir must fail
    const bad = L.createFyersLogin({ env: () => env, post: async () => ({ data: { s: 'ok', access_token: fresh } }), apply: t => { cur = t; }, current: () => cur, dir: path.join(dir, 'afile', 'sub'), now: () => NOW });
    const rb = await bad.exchange(code); assert.strictEqual(rb.ok, true); assert.strictEqual(rb.saved, false);

    // page: no secrets embedded, reads key from its own address
    const html = L.renderPage(); assert(html.includes('/api/fyers-login/exchange') && html.includes("get('key')") && !/SECRETX|APP_TOKEN\s*=/.test(html));
    console.log('fyersLogin tests OK');
})().catch(e => { console.error(e); process.exit(1); });