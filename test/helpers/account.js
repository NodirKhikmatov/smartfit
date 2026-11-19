// Task 54: the account routes every role reaches, for the route walks. Run in this order on one signed-in account:
// sign-ins, a new secret, two-step on, new recovery codes, off, "hamma joydan chiqish" (the token moves on via setToken).
import assert from 'node:assert/strict';
import { totp, fromBase32, stepOf } from '../../src/admin/twostep.js';

export const codeFor = (secret, now = Date.now()) => totp(fromBase32(secret), stepOf(now));

export const PUBLIC_ACCOUNT = ['POST /login/code', 'POST /reset/check', 'POST /reset/accept'];

export function accountWalk(admin, getToken, setToken, password) {
  let secret;
  const ok = async (status, method, path, body) => {
    const r = await admin(method, path, body, getToken());
    assert.equal(r.status, status, JSON.stringify(r.body));
    return r;
  };
  return {
    'GET /me/security': () => ok(200, 'GET', '/me/security'),
    'GET /me/two-step/new': async () => { secret = (await ok(200, 'GET', '/me/two-step/new')).body.secret; },
    'POST /me/two-step': () => ok(201, 'POST', '/me/two-step', { secret, code: codeFor(secret) }),
    'POST /me/two-step/codes': () => ok(201, 'POST', '/me/two-step/codes', { password: password() }),
    'POST /me/two-step/off': () => ok(204, 'POST', '/me/two-step/off', { password: password() }),
    'POST /me/logout-all': async () => setToken((await ok(200, 'POST', '/me/logout-all')).body.token),
  };
}
