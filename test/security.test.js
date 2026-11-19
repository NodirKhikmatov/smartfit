// Task 54: account security — password change and reset links, two-step login (TOTP + recovery codes), the organisation
// rule, "Kirishlar" and "hamma joydan chiqish", the login lock, and that no secret reaches a log, an audit row or a response.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, json } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { signToken } from '../src/admin/auth.js';
import { totp, matchStep, base32, fromBase32, stepOf, seal, unseal, STEP_MS } from '../src/admin/twostep.js';
import { codeFor } from './helpers/account.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret-54';
const db = testDb();
let server, base, tashkent, samarkand, clock = null;
const logs = [], responses = [];
// Each test signs in from its own address, so one test's wrong tries never lock the next one out.
let defaultIp = '10.0.0.1', ipN = 0;
beforeEach(() => { defaultIp = `10.9.${++ipN}.1`; });
const original = { info: console.info, log: console.log, warn: console.warn, error: console.error };

// Every request comes "from" an IP of the test's choosing (trust proxy 1 + X-Forwarded-For).
const call = async (method, p, body, token, ip = defaultIp) => {
  const res = await fetch(`${base}/api/admin${p}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  responses.push(text); // checked for secrets too
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const login = async (email, password, ip) => (await call('POST', '/login', { email, password }, undefined, ip)).body;
const tokenOf = (url) => new URL(url).hash.split('token=')[1];
const now = () => clock ?? Date.now();
let n = 0;
const member = async (role = 'manager', storeId = tashkent) => {
  const email = `m${++n}.${role}@smartfit.uz`;
  const id = await createAdmin(db, { email, password: 'member-pass-1', storeId, role });
  return { id, email, token: (await login(email, 'member-pass-1')).token };
};
// Two-step login on for a signed-in account → its secret and recovery codes.
async function enable(token) {
  const { secret, uri, svg } = (await call('GET', '/me/two-step/new', undefined, token)).body;
  assert.match(uri, /^otpauth:\/\/totp\/Smart%20Fit%3A.+\?secret=[A-Z2-7]{32}&issuer=Smart%20Fit/);
  assert.match(svg, /^<svg/);
  const r = await call('POST', '/me/two-step', { secret, code: codeFor(secret, now()) }, token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { secret, codes: r.body.recovery_codes };
}
let ownerToken, superToken;

before(async () => {
  for (const k of Object.keys(original)) console[k] = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  await db.migrate.latest();
  await seed(db);
  [tashkent, samarkand] = (await db('stores').orderBy('id')).map((s) => s.id);
  await createAdmin(db, { email: 'sec.super@smartfit.uz', password: 'super-pass-1' });
  await createAdmin(db, { email: 'sec.owner@smartfit.uz', password: 'owner-pass-1', storeId: tashkent });
  server = createApp(db, { telegram: null, trustProxy: '1', logRequests: true, now, weather: async () => ({ temperature: 5, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
  superToken = (await login('sec.super@smartfit.uz', 'super-pass-1')).token;
  ownerToken = (await login('sec.owner@smartfit.uz', 'owner-pass-1')).token;
});
after(async () => {
  Object.assign(console, original);
  server.close();
  await db.destroy();
});

test('TOTP: RFC 6238 vectors, ±1 step, never an older or the same step, base32 and the sealed secret', () => {
  const key = Buffer.from('12345678901234567890'); // RFC 6238 appendix B (SHA1), last 6 of the 8 digits
  for (const [t, code] of [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']]) assert.equal(totp(key, stepOf(t * 1000)), code, `t=${t}`);
  const t0 = 1_800_000_000_000, s = stepOf(t0);
  assert.equal(matchStep(key, totp(key, s), t0), s);
  assert.equal(matchStep(key, totp(key, s - 1), t0), s - 1, 'a phone 30 s behind');
  assert.equal(matchStep(key, totp(key, s + 1), t0), s + 1, 'a phone 30 s ahead');
  assert.equal(matchStep(key, totp(key, s - 2), t0), null);
  assert.equal(matchStep(key, totp(key, s + 2), t0), null);
  assert.equal(matchStep(key, totp(key, s), t0, s), null, 'the same code twice');
  assert.equal(matchStep(key, totp(key, s - 1), t0, s), null, 'an older code after a newer one');
  assert.equal(matchStep(key, totp(key, s + 1), t0, s), s + 1);
  for (const bad of ['', '12345', '1234567', 'abcdef', ' 123456']) assert.equal(matchStep(key, bad, t0), null);
  assert.equal(STEP_MS, 30_000);
  assert.deepEqual(fromBase32(base32(key)), key);
  assert.equal(base32(Buffer.from('foobar')), 'mzxw6ytboi'); // RFC 4648 test vector (lower case, no padding)
  const sealed = seal('k1', 'abcdefghijklmnop');
  assert.ok(!sealed.includes('abcdefghijklmnop'));
  assert.equal(unseal('k1', sealed), 'abcdefghijklmnop');
  assert.equal(unseal('k2', sealed), null, 'another ADMIN_TOKEN_SECRET can not read it');
  assert.equal(unseal('k1', sealed.slice(0, -2) + 'AA'), null, 'tampered');
});

test('password change: the current password is needed, every other session ends, this one goes on', async () => {
  const m = await member();
  const other = (await login(m.email, 'member-pass-1', '10.0.0.9')).token;
  assert.equal((await call('POST', '/me/password', { current: 'nope-nope', password: 'member-pass-2' }, m.token)).status, 400);
  assert.equal((await call('POST', '/me/password', { current: 'member-pass-1', password: 'short' }, m.token)).status, 400);
  const r = await call('POST', '/me/password', { current: 'member-pass-1', password: 'member-pass-2' }, m.token);
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/me', undefined, other)).status, 401, 'the other device is out at once');
  assert.equal((await call('GET', '/me', undefined, m.token)).status, 401, 'and this device\'s old token');
  assert.equal((await call('GET', '/me', undefined, r.body.token)).status, 200, 'the fresh one works');
  assert.equal((await login(m.email, 'member-pass-2')).admin.email, m.email);
});

test('who may reset whom: owner → own team, manager/staff/mall → no one, super → owners and others, nobody → a super or themselves', async () => {
  const mgr = await member('manager'), staff = await member('staff'), otherOrg = await member('manager', samarkand);
  await createAdmin(db, { email: 'sec.owner2@smartfit.uz', password: 'owner-pass-2', storeId: tashkent, role: 'owner' });
  const owner2 = await db('admins').where({ email: 'sec.owner2@smartfit.uz' }).first();
  const sup = await db('admins').where({ email: 'sec.super@smartfit.uz' }).first();
  const owner = await db('admins').where({ email: 'sec.owner@smartfit.uz' }).first();
  const reset = (id, token) => call('POST', `/team/${id}/reset`, undefined, token);
  assert.equal((await reset(mgr.id, ownerToken)).status, 201);
  assert.equal((await reset(staff.id, ownerToken)).status, 201);
  for (const id of [otherOrg.id, owner2.id, sup.id, owner.id, 999999]) assert.equal((await reset(id, ownerToken)).status, 404, `owner → ${id}`);
  for (const t of [mgr.token, staff.token]) assert.equal((await reset(owner.id, t)).status, 403);
  assert.equal((await reset(owner.id, superToken)).status, 201, 'super → an owner');
  assert.equal((await reset(otherOrg.id, superToken)).status, 201);
  assert.equal((await reset(sup.id, superToken)).status, 404, 'not yourself, never a super');
  const mallId = await createAdmin(db, { email: 'sec.mall@smartfit.uz', password: 'mall-pass-1', mallId: (await db('malls').first()).id });
  assert.equal((await reset(mgr.id, (await login('sec.mall@smartfit.uz', 'mall-pass-1')).token)).status, 403, 'a mall admin resets no one');
  assert.equal((await reset(mallId, superToken)).status, 201, 'super resets a mall admin');
  // A disabled account gets no link; disabling kills an open one.
  const gone = await member();
  const link = (await reset(gone.id, ownerToken)).body;
  assert.equal((await call('PATCH', `/team/${gone.id}`, { disabled: true }, ownerToken)).status, 200);
  assert.equal((await call('POST', '/reset/check', { token: tokenOf(link.url) })).status, 410);
  assert.equal((await reset(gone.id, ownerToken)).status, 409);
});

test('reset link: shown once, works once, expires, ends every session and turns two-step login off', async () => {
  const m = await member();
  const { secret } = await enable(m.token);
  const elsewhere = (await call('POST', '/login/code', { ticket: (await login(m.email, 'member-pass-1', '10.0.0.7')).ticket, code: codeFor(secret, now() + STEP_MS) }, undefined, '10.0.0.7')).body.token;
  const r = await call('POST', `/team/${m.id}/reset`, undefined, ownerToken);
  assert.match(r.body.url, /\/admin\/#\/reset\?token=[0-9a-f]{32}$/);
  assert.ok(Date.parse(r.body.expires_at) - Date.now() > 23.9 * 3600e3, '24 h');
  const token = tokenOf(r.body.url);
  assert.deepEqual((await call('POST', '/reset/check', { token })).body, { email: m.email });
  assert.equal((await call('POST', '/reset/accept', { token, password: 'short' })).status, 400);
  // A newer link replaces the older one.
  const r2 = await call('POST', `/team/${m.id}/reset`, undefined, ownerToken);
  assert.equal((await call('POST', '/reset/check', { token })).status, 410, 'the older link died');
  const t2 = tokenOf(r2.body.url);
  const done = await call('POST', '/reset/accept', { token: t2, password: 'member-new-1' });
  assert.equal(done.status, 200);
  assert.equal(done.body.admin.email, m.email);
  for (const old of [m.token, elsewhere]) assert.equal((await call('GET', '/me', undefined, old)).status, 401, 'every old session ends');
  assert.equal((await call('GET', '/me', undefined, done.body.token)).body.two_step.on, false, 'two-step login is off');
  assert.equal((await db('admin_recovery_codes').where({ admin_id: m.id })).length, 0);
  assert.equal((await call('POST', '/reset/accept', { token: t2, password: 'member-new-2' })).status, 410, 'once');
  assert.equal((await login(m.email, 'member-new-1')).admin.email, m.email, 'no code asked any more');
  // Expiry, malformed tokens, and parallel uses of one link.
  const r3 = await call('POST', `/team/${m.id}/reset`, undefined, ownerToken);
  await db('admin_resets').where({ admin_id: m.id }).whereNull('used_at').update({ expires_at: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await call('POST', '/reset/check', { token: tokenOf(r3.body.url) })).status, 410, 'expired');
  for (const bad of ['', 'x', 'a'.repeat(32), undefined, 12]) assert.equal((await call('POST', '/reset/check', { token: bad })).status, 410);
  const r4 = tokenOf((await call('POST', `/team/${m.id}/reset`, undefined, ownerToken)).body.url);
  const all = await Promise.all(Array.from({ length: 5 }, (_, i) => call('POST', '/reset/accept', { token: r4, password: `parallel-pass-${i}` })));
  assert.deepEqual(all.map((x) => x.status).sort(), [200, 410, 410, 410, 410]);
  const audit = await db('audit_log').whereIn('action', ['team.reset_link', 'account.reset']).where({ entity_id: m.id }).orderBy('id');
  assert.ok(audit.some((a) => a.action === 'team.reset_link' && a.admin_email === 'sec.owner@smartfit.uz'));
  assert.ok(audit.some((a) => a.action === 'account.reset' && a.admin_email === m.email));
});

test('two-step login: password then code, each code once, ±30 s, a ticket is not a session and dies with the sessions', async () => {
  const m = await member();
  clock = Date.now();
  try {
    const { secret } = await enable(m.token);
    const first = await login(m.email, 'member-pass-1');
    assert.deepEqual(Object.keys(first).sort(), ['ticket', 'two_step'], 'no token before the code');
    assert.equal((await call('GET', '/me', undefined, first.ticket)).status, 401, 'a ticket is no session');
    assert.equal((await call('POST', '/login/code', { ticket: m.token, code: codeFor(secret, clock) })).status, 401, 'a session is no ticket');
    // The code used to switch it on (this step) is spent; the next step's code works (phone 30 s ahead).
    assert.equal((await call('POST', '/login/code', { ticket: first.ticket, code: codeFor(secret, clock) })).status, 400, 'the setup code is spent');
    const ok = await call('POST', '/login/code', { ticket: first.ticket, code: codeFor(secret, clock + STEP_MS) });
    assert.equal(ok.status, 200);
    assert.equal((await call('GET', '/me', undefined, ok.body.token)).body.email, m.email);
    const again = await login(m.email, 'member-pass-1');
    assert.equal((await call('POST', '/login/code', { ticket: again.ticket, code: codeFor(secret, clock + STEP_MS) })).status, 400, 'no reuse');
    clock += 3 * STEP_MS;
    assert.equal((await call('POST', '/login/code', { ticket: again.ticket, code: codeFor(secret, clock - 2 * STEP_MS) })).status, 400, '60 s old');
    assert.equal((await call('POST', '/login/code', { ticket: again.ticket, code: codeFor(secret, clock + 2 * STEP_MS) })).status, 400, '60 s ahead');
    assert.equal((await call('POST', '/login/code', { ticket: again.ticket, code: codeFor(secret, clock - STEP_MS) })).status, 200, '30 s behind');
    // Parallel sign-ins with one code: one wins.
    clock += 2 * STEP_MS;
    const tickets = await Promise.all([1, 2, 3].map(() => login(m.email, 'member-pass-1')));
    const codes = await Promise.all(tickets.map((t) => call('POST', '/login/code', { ticket: t.ticket, code: codeFor(secret, clock) })));
    assert.deepEqual(codes.map((c) => c.status).sort(), [200, 400, 400]);
    // "Hamma joydan chiqish" also kills a ticket waiting for its code.
    const waiting = await login(m.email, 'member-pass-1');
    await call('POST', '/me/logout-all', undefined, ok.body.token);
    clock += 2 * STEP_MS;
    assert.equal((await call('POST', '/login/code', { ticket: waiting.ticket, code: codeFor(secret, clock) })).status, 401);
    // Two-step off needs the password; then login is one step again.
    const tok = (await call('POST', '/login/code', { ticket: (await login(m.email, 'member-pass-1')).ticket, code: codeFor(secret, clock) })).body.token;
    assert.equal((await call('POST', '/me/two-step/off', { password: 'wrong-pass' }, tok)).status, 400);
    assert.equal((await call('POST', '/me/two-step/off', { password: 'member-pass-1' }, tok)).status, 204);
    assert.ok((await login(m.email, 'member-pass-1')).token);
    assert.deepEqual((await db('audit_log').where({ entity_id: m.id, entity: 'account' }).orderBy('id').pluck('action')).filter((a) => a.startsWith('account.two_step') || a === 'account.logout_all'),
      ['account.two_step_on', 'account.logout_all', 'account.two_step_off']);
  } finally {
    clock = null;
  }
});

test('recovery codes: ten, shown once, each works once, new ones replace the old', async () => {
  const m = await member();
  const { codes } = await enable(m.token);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
  const use = async (code) => call('POST', '/login/code', { ticket: (await login(m.email, 'member-pass-1')).ticket, code });
  const r = await use(codes[0].toUpperCase().replace(/-/g, ' ')); // typed in capitals, with spaces
  assert.equal(r.status, 200);
  assert.equal((await use(codes[0])).status, 400, 'once');
  assert.equal((await call('GET', '/me/security', undefined, r.body.token)).body.two_step.codes_left, 9);
  const used = await db('audit_log').where({ action: 'account.recovery_used', entity_id: m.id }).first();
  assert.deepEqual(json(used.after), { left: 9 });
  assert.equal((await call('POST', '/me/two-step/codes', { password: 'wrong-pass' }, r.body.token)).status, 400);
  const fresh = await call('POST', '/me/two-step/codes', { password: 'member-pass-1' }, r.body.token);
  assert.equal(fresh.status, 201);
  assert.equal((await use(codes[1])).status, 400, 'the old set is gone');
  assert.equal((await use(fresh.body.recovery_codes[0])).status, 200);
  const sec = (await call('GET', '/me/security', undefined, r.body.token)).body;
  assert.equal(sec.logins[0].method, 'recovery');
});

test('the organisation rule: the owner turns it on for themselves first; members without it can only set it up', async () => {
  const m = await member(), s = await member('staff');
  assert.equal((await call('PATCH', '/org/two-step', { required: true }, m.token)).status, 403, 'an owner\'s switch');
  assert.equal((await call('PATCH', '/org/two-step', { required: true }, ownerToken)).status, 409, 'two_step_self');
  assert.equal((await call('PATCH', '/org/two-step', { required: 'yes' }, ownerToken)).status, 400);
  await db('organizations').update({ require_two_step: false });
  const owner = (await db('admins').where({ email: 'sec.owner@smartfit.uz' }).first());
  await enable(ownerToken);
  try {
    assert.deepEqual((await call('PATCH', '/org/two-step', { required: true }, ownerToken)).body, { require_two_step: true });
    // The manager's existing session: everything but the setup is 403 at once.
    const r = await call('GET', '/products', undefined, m.token);
    assert.deepEqual([r.status, r.body.code], [403, 'two_step_required']);
    assert.equal((await call('GET', '/staff', undefined, s.token)).status, 403, 'staff too');
    const me = (await call('GET', '/me', undefined, m.token)).body;
    assert.deepEqual(me.two_step, { on: false, setup: true });
    assert.equal((await call('GET', '/me/security', undefined, m.token)).body.two_step.required, true);
    assert.equal((await call('GET', '/orders', undefined, m.token)).status, 403, 'only the setup (and the own password)');
    await enable(m.token);
    assert.equal((await call('GET', '/products', undefined, m.token)).status, 200, 'set up: in');
    assert.equal((await call('POST', '/me/two-step/off', { password: 'member-pass-1' }, m.token)).body.code, 'two_step_org', 'can\'t turn it off');
    // Other organisations and a super are not touched by it.
    const other = await member('manager', samarkand);
    assert.equal((await call('GET', '/products', undefined, other.token)).status, 200);
    assert.equal((await call('GET', '/products', undefined, superToken)).status, 200);
    assert.equal((await call('PATCH', '/org/two-step', { required: false }, ownerToken)).status, 200);
    assert.equal((await call('GET', '/staff', undefined, s.token)).status, 200, 'off again: back in');
    const rows = await db('audit_log').where({ action: 'org.two_step', entity_id: owner.organization_id }).orderBy('id');
    assert.deepEqual(rows.map((x) => json(x.after).require_two_step), [true, false]);
  } finally {
    await db('organizations').update({ require_two_step: false });
    await db('admins').where({ id: owner.id }).update({ totp_secret: null, totp_enabled_at: null, totp_last_step: null });
  }
});

test('"Kirishlar" lists sign-ins and failed tries; "hamma joydan chiqish" refuses every other token at once; old tokens still work', async () => {
  const m = await member();
  await login(m.email, 'wrong-pass-1', '10.0.0.20');
  const phone = (await login(m.email, 'member-pass-1', '10.0.0.21')).token;
  const sec = (await call('GET', '/me/security', undefined, m.token)).body;
  assert.deepEqual(sec.logins.map((l) => [l.method, l.ok, l.ip, l.current]), [
    ['password', true, '10.0.0.21', false], ['password', false, '10.0.0.20', false], ['password', true, defaultIp, true]]);
  assert.match(sec.logins[0].agent, /iPhone/);
  assert.deepEqual(Object.keys(sec.logins[0]).sort(), ['agent', 'created_at', 'current', 'id', 'ip', 'method', 'ok']);
  assert.ok(!('org' in sec), 'the rule is the owner\'s');
  assert.deepEqual((await call('GET', '/me/security', undefined, ownerToken)).body.org, { require_two_step: false });
  const out = await call('POST', '/me/logout-all', undefined, m.token);
  assert.equal(out.status, 200);
  assert.equal((await call('GET', '/me', undefined, phone)).status, 401, 'the phone is out at once');
  assert.equal((await call('GET', '/me', undefined, m.token)).status, 401);
  assert.equal((await call('GET', '/me/security', undefined, out.body.token)).body.logins.find((l) => l.current)?.ip, defaultIp, 'the fresh token is still "this device"');
  // A token signed before this task (no sid) still works: deploying it signs nobody out.
  const admin = await db('admins').where({ id: m.id }).first();
  const legacy = signToken('test-secret-54', m.id, Date.now(), admin.token_version).token;
  assert.equal((await call('GET', '/me', undefined, legacy)).status, 200);
  // The log keeps the last 50 rows per account.
  for (let i = 0; i < 52; i++) await db('admin_logins').insert({ admin_id: m.id, method: 'password', ok: true });
  await login(m.email, 'member-pass-1');
  assert.equal(Number((await db('admin_logins').where({ admin_id: m.id }).count({ n: '*' }))[0].n), 50);
});

test('the lock: 5 wrong passwords lock that email from that IP only; 10 from one IP lock the IP; 5 wrong codes lock the account\'s second step', async () => {
  const m = await member();
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/login', { email: m.email, password: 'bad-pass' }, undefined, '10.1.0.1')).status, 401);
  assert.equal((await call('POST', '/login', { email: m.email, password: 'member-pass-1' }, undefined, '10.1.0.1')).status, 429, 'locked even with the right password');
  assert.equal((await call('POST', '/login', { email: m.email, password: 'member-pass-1' }, undefined, '10.1.0.2')).status, 200, 'the owner of the account, elsewhere, is not locked out');
  assert.equal((await call('POST', '/login', { email: 'sec.owner@smartfit.uz', password: 'owner-pass-1' }, undefined, '10.1.0.1')).status, 200, 'that IP, another email');
  const locked = await db('audit_log').where({ action: 'account.locked', entity_id: m.id }).first();
  assert.deepEqual(json(locked.after), { step: 1 });
  for (let i = 0; i < 10; i++) await call('POST', '/login', { email: `nobody${i}@smartfit.uz`, password: 'bad-pass' }, undefined, '10.1.0.3');
  assert.equal((await call('POST', '/login', { email: 'sec.owner@smartfit.uz', password: 'owner-pass-1' }, undefined, '10.1.0.3')).status, 429, 'a guessing IP');
  // Second step: per account, from any IP.
  const k = await member();
  const { secret } = await enable(k.token);
  for (let i = 0; i < 5; i++) {
    const t = (await login(k.email, 'member-pass-1', `10.2.0.${i}`)).ticket;
    assert.equal((await call('POST', '/login/code', { ticket: t, code: '000000' }, undefined, `10.2.0.${i}`)).status, 400);
  }
  const t = (await login(k.email, 'member-pass-1', '10.2.0.9')).ticket;
  assert.equal((await call('POST', '/login/code', { ticket: t, code: codeFor(secret, Date.now() + STEP_MS) }, undefined, '10.2.0.9')).status, 429);
  assert.ok(await db('audit_log').where({ action: 'account.locked', entity_id: k.id }).first());
  assert.equal((await db('admin_logins').where({ admin_id: k.id, ok: false, method: 'two_step' })).length, 5);
});

test('nothing secret in logs, audit rows, the database or responses beyond the one time it is shown', async () => {
  const m = await member();
  const { secret, codes } = await enable(m.token);
  const reset = await call('POST', `/team/${m.id}/reset`, undefined, ownerToken);
  const rtoken = tokenOf(reset.body.url);
  await call('POST', '/login/code', { ticket: (await login(m.email, 'member-pass-1')).ticket, code: codes[2] });
  await call('POST', '/reset/accept', { token: rtoken, password: 'member-pass-77' });
  const row = await db('admins').where({ id: m.id }).first();
  assert.equal(row.totp_secret, null, 'the reset turned it off');
  // The sealed secret at rest, while on.
  const k = await member();
  const s2 = (await enable(k.token)).secret;
  const sealed = (await db('admins').where({ id: k.id }).first()).totp_secret;
  assert.match(sealed, /^v1\./);
  assert.ok(!sealed.toLowerCase().includes(s2) && !sealed.includes(s2.toUpperCase()));
  const dump = JSON.stringify([await db('admin_recovery_codes'), await db('admin_resets'), await db('admin_logins'), await db('audit_log').where('id', '>', 0)]);
  for (const c of codes) assert.ok(!dump.includes(c) && !dump.includes(c.replace(/-/g, '')), 'recovery codes are stored hashed');
  assert.ok(!dump.includes(rtoken), 'reset tokens are stored hashed');
  assert.ok(!dump.includes(secret) && !dump.includes(s2));
  // Reading the account back never shows the secret, a code or a hash.
  for (const p of ['/me', '/me/security']) assert.doesNotMatch(JSON.stringify((await call('GET', p, undefined, k.token)).body), /totp|secret|hash|scrypt/i, p);
  assert.doesNotMatch(JSON.stringify((await call('GET', '/team', undefined, ownerToken)).body), /totp|secret|hash/i);
  assert.equal((await call('GET', '/me/two-step/new', undefined, k.token)).status, 409, 'no second secret while one is on');
  // Logs: request lines and anything else printed during this file.
  const printed = logs.join('\n');
  assert.match(printed, /\/api\/admin\/login\/code/, 'requests were logged');
  for (const word of [secret, s2, rtoken, ...codes, 'member-pass-1', 'member-pass-77']) assert.ok(!printed.includes(word), `log leaks ${word.slice(0, 4)}…`);
  // Responses: the secret only from /me/two-step/new, the codes only from enabling / new codes, the reset token only in its link.
  assert.equal(responses.filter((l) => l.includes(secret)).length, 1, 'the secret was shown once');
  assert.equal(responses.filter((l) => l.includes(codes[5])).length, 1, 'a recovery code was shown once');
  assert.equal(responses.filter((l) => l.includes(rtoken)).length, 1, 'the reset link was shown once');
  assert.equal(responses.filter((l) => l.includes('member-pass-1')).length, 0, 'passwords never');
});

test('migration 044 goes down and up', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await m.migrate.down(); // 044
    assert.equal(await m.schema.hasTable('admin_logins'), false);
    assert.equal(await m.schema.hasColumn('admins', 'totp_secret'), false);
    assert.equal(await m.schema.hasColumn('organizations', 'require_two_step'), false);
    await m.migrate.latest();
    for (const t of ['admin_logins', 'admin_resets', 'admin_recovery_codes']) assert.ok(await m.schema.hasTable(t), t);
  } finally {
    await m.destroy();
  }
});
