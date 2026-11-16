// Task 19: store settings, team (roles, invites, disable), password change and the audit log.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDb } from './helpers/db.js';
import { createDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin, createAdminRouter } from '../src/admin/routes.js';
import { AUDIT_ACTIONS } from '../src/admin/audit.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, uploadDir, tashkent, samarkand, superToken, ownerToken, managerToken, samOwnerToken;

const call = async (method, p, body, token, { raw, type } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': type || 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const admin = (method, p, body, token, opts) => call(method, `/api/admin${p}`, body, token, opts);
const login = async (email, password) => (await admin('POST', '/login', { email, password })).body.token;
const tokenOf = (url) => new URL(url).hash.split('token=')[1];
const lastAudit = () => db('audit_log').orderBy('id', 'desc').first();
const auditCount = async () => Number((await db('audit_log').count({ n: '*' }))[0].n);

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [tashkent, samarkand] = (await db('stores').orderBy('id')).map((s) => s.id);
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  await createAdmin(db, { email: 'owner@smartfit.uz', password: 'owner-pass-1', storeId: tashkent });
  await createAdmin(db, { email: 'mgr@smartfit.uz', password: 'mgr-pass-1', storeId: tashkent, role: 'manager' });
  await createAdmin(db, { email: 'samowner@smartfit.uz', password: 'sam-pass-1', storeId: samarkand });
  uploadDir = await mkdtemp(path.join(tmpdir(), 'sf-settings-'));
  server = createApp(db, { uploadDir, telegram: null, weather: async () => ({ temperature: 5, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  superToken = await login('boss@smartfit.uz', 'boss-pass-1');
  ownerToken = await login('owner@smartfit.uz', 'owner-pass-1');
  managerToken = await login('mgr@smartfit.uz', 'mgr-pass-1');
  samOwnerToken = await login('samowner@smartfit.uz', 'sam-pass-1');
});
after(async () => {
  server.close();
  await db.destroy();
  await rm(uploadDir, { recursive: true, force: true });
});

test('migration 009: phase-1 managers become owners, super stays, old tokens keep working, down reverts', async () => {
  const m = testDb();
  try {
    for (let i = 0; i < 8; i++) await m.migrate.up(); // up to 008_handoff
    const [{ id: store }] = await m('stores').insert({ name: 'A', city: 'B', lat: 41, lon: 69, address: 'C' }).returning('id');
    await m('admins').insert([{ email: 's@x.uz', password_hash: 'x', role: 'super' }, { email: 'm@x.uz', password_hash: 'x', role: 'manager', store_id: store }]);
    await m.migrate.up();
    const rows = await m('admins').orderBy('id').select('id', 'email', 'role', 'store_id', 'token_version', 'disabled_at');
    assert.deepEqual(rows.map((a) => [a.role, a.store_id, a.token_version, a.disabled_at]), [['super', null, 0, null], ['owner', store, 0, null]]);
    // New rows get the next id, and the role CHECK and the email index are in place.
    const [{ id: next }] = await m('admins').insert({ email: 'n@x.uz', password_hash: 'x', role: 'manager', store_id: store }).returning('id');
    assert.ok(next > rows[1].id);
    await assert.rejects(m('admins').insert({ email: 'b@x.uz', password_hash: 'x', role: 'boss', store_id: store }));
    await assert.rejects(m('admins').insert({ email: 'c@x.uz', password_hash: 'x', role: 'owner' }), 'owner without a store');
    await assert.rejects(m('admins').insert({ email: 'm@x.uz', password_hash: 'x', role: 'super' }), 'email stays unique');
    await m.migrate.down();
    assert.deepEqual((await m('admins').orderBy('id').pluck('role')), ['super', 'manager', 'manager']);
  } finally {
    await m.destroy();
  }
  // A token signed before task 19 has no `ver`: it counts as version 0, which every admin has after the migration.
  const payload = Buffer.from(JSON.stringify({ sub: (await db('admins').where({ email: 'mgr@smartfit.uz' }).first()).id, exp: Date.now() + 60000 })).toString('base64url');
  const old = `${payload}.${createHmac('sha256', 'test-secret').update(payload).digest('base64url')}`;
  assert.equal((await admin('GET', '/me', undefined, old)).status, 200);
});

test('a manager reads the store profile but cannot edit settings, the team or read the audit log', async () => {
  const s = await admin('GET', `/stores/${tashkent}`, undefined, managerToken);
  assert.equal(s.status, 200);
  assert.equal(s.body.can_edit, false);
  assert.equal((await admin('PATCH', `/stores/${tashkent}`, { delivery_fee: 1 }, managerToken)).status, 403);
  assert.equal((await admin('GET', '/team', undefined, managerToken)).status, 403);
  assert.equal((await admin('POST', '/team/invites', { email: 'x@smartfit.uz', role: 'manager' }, managerToken)).status, 403);
  const owner = await db('admins').where({ email: 'owner@smartfit.uz' }).first();
  assert.equal((await admin('PATCH', `/team/${owner.id}`, { disabled: true }, managerToken)).status, 403);
  assert.equal((await admin('GET', '/audit', undefined, managerToken)).status, 403);
  assert.equal((await db('stores').where({ id: tashkent }).first()).delivery_fee !== 1, true);
  assert.equal((await db('admins').where({ id: owner.id }).first()).disabled_at, null);
});

test('an owner edits their own store (validated, audited) and cannot touch another store', async () => {
  await db('stores').where({ id: tashkent }).update({ order_seq: 7 });
  const me = await admin('GET', `/stores/${tashkent}`, undefined, ownerToken);
  assert.equal(me.body.can_edit, true);
  const upd = await admin('PATCH', `/stores/${tashkent}`, {
    address: 'Amir Temur 15', lat: '41.3', lon: 69.28, opens_at: '10:00', closes_at: '21:00', delivery_fee: 20000, free_delivery_threshold: 500000,
    telegram_chat_id: '-1001234567890', order_seq: 0, id: samarkand,
  }, ownerToken);
  assert.equal(upd.status, 200);
  const row = await db('stores').where({ id: tashkent }).first();
  assert.deepEqual([row.address, row.lat, row.opens_at, row.closes_at, row.delivery_fee, row.free_delivery_threshold, row.telegram_chat_id],
    ['Amir Temur 15', 41.3, '10:00', '21:00', 20000, 500000, -1001234567890]);
  assert.equal(row.order_seq, 7, 'order_seq is not a settings field');
  const a = await lastAudit();
  assert.equal(a.action, 'store.update');
  assert.equal(a.store_id, tashkent);
  const after = typeof a.after === 'string' ? JSON.parse(a.after) : a.after;
  assert.equal(after.delivery_fee, 20000);
  assert.ok(!('name' in after), 'only changed fields are kept');
  for (const bad of [{ opens_at: '25:00' }, { opens_at: null }, { telegram_chat_id: '@chat' }, { lat: 91 }, { delivery_fee: 1.5 }, { delivery_fee: -1 },
    { free_delivery_threshold: 0 }, { name: '' }, { address: 'x'.repeat(201) }]) {
    assert.equal((await admin('PATCH', `/stores/${tashkent}`, bad, ownerToken)).status, 400, JSON.stringify(bad));
  }
  const n = await auditCount();
  assert.equal((await admin('PATCH', `/stores/${tashkent}`, { delivery_fee: 20000 }, ownerToken)).status, 200);
  assert.equal(await auditCount(), n, 'a save without changes writes nothing');
  // Another store: invisible (404) for profile and settings; 403 when named in an invite.
  assert.equal((await admin('GET', `/stores/${samarkand}`, undefined, ownerToken)).status, 404);
  assert.equal((await admin('PATCH', `/stores/${samarkand}`, { delivery_fee: 1 }, ownerToken)).status, 404);
  assert.equal((await admin('POST', '/team/invites', { email: 'y@smartfit.uz', role: 'manager', store_id: samarkand }, ownerToken)).status, 403);
  const samOwner = await db('admins').where({ email: 'samowner@smartfit.uz' }).first();
  assert.equal((await admin('PATCH', `/team/${samOwner.id}`, { disabled: true }, ownerToken)).status, 404);
  const team = await admin('GET', '/team', undefined, ownerToken);
  assert.ok(team.body.members.every((m) => m.store_id === tashkent));
  assert.ok((await admin('GET', `/audit?store_id=${samarkand}`, undefined, ownerToken)).body.items.every((i) => i.store_id === tashkent));
  // An owner invites managers only, and can't disable another owner or themself.
  assert.equal((await admin('POST', '/team/invites', { email: 'o2@smartfit.uz', role: 'owner' }, ownerToken)).status, 403);
  const owner = await db('admins').where({ email: 'owner@smartfit.uz' }).first();
  assert.equal((await admin('PATCH', `/team/${owner.id}`, { disabled: true }, ownerToken)).status, 404);
  // A super-admin edits any store.
  assert.equal((await admin('PATCH', `/stores/${samarkand}`, { opens_at: '09:00', closes_at: '20:00' }, superToken)).status, 200);
});

test('invite: single use, expires, can be revoked; accepting signs in as a manager of that store', async () => {
  const inv = await admin('POST', '/team/invites', { email: ' New.Mgr@SmartFit.uz ', role: 'manager' }, ownerToken);
  assert.equal(inv.status, 201);
  assert.equal(inv.body.email, 'new.mgr@smartfit.uz');
  assert.equal(inv.body.store_id, tashkent);
  assert.match(inv.body.url, /\/admin\/#\/invite\?token=[0-9a-f]{32}$/);
  const token = tokenOf(inv.body.url);
  assert.ok(!(await db('admin_invites').where({ id: inv.body.id }).first()).token_hash.includes(token), 'only the hash is stored');
  assert.deepEqual((await admin('POST', '/invite/check', { token })).body, { email: 'new.mgr@smartfit.uz', role: 'manager', store_name: (await db('stores').where({ id: tashkent }).first()).name, org_name: (await db('organizations').join('stores', 'stores.organization_id', 'organizations.id').where('stores.id', tashkent).first('organizations.name')).name });
  assert.equal((await admin('POST', '/invite/accept', { token, password: 'short' })).status, 400);
  const ok = await admin('POST', '/invite/accept', { token, password: 'new-mgr-pass-1' });
  assert.equal(ok.status, 201);
  assert.deepEqual([ok.body.admin.role, ok.body.admin.store_id], ['manager', tashkent]);
  assert.equal((await admin('GET', '/me', undefined, ok.body.token)).body.email, 'new.mgr@smartfit.uz');
  assert.equal((await lastAudit()).action, 'team.join');
  // Used: a second accept or check is refused, and the account was made once.
  assert.equal((await admin('POST', '/invite/accept', { token, password: 'other-pass-1' })).status, 410);
  assert.equal((await admin('POST', '/invite/check', { token })).status, 410);
  assert.equal((await login('new.mgr@smartfit.uz', 'new-mgr-pass-1')) != null, true);
  // An existing admin's email can't be invited.
  assert.equal((await admin('POST', '/team/invites', { email: 'mgr@smartfit.uz' }, ownerToken)).status, 409);

  // Expired.
  const late = await admin('POST', '/team/invites', { email: 'late@smartfit.uz' }, ownerToken);
  await db('admin_invites').where({ id: late.body.id }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await admin('POST', '/invite/accept', { token: tokenOf(late.body.url), password: 'late-pass-1' })).status, 410);
  assert.ok(!(await admin('GET', '/team', undefined, ownerToken)).body.invites.some((i) => i.id === late.body.id), 'expired invites are not listed');

  // Parallel accepts: exactly one account.
  const race = await admin('POST', '/team/invites', { email: 'race@smartfit.uz' }, ownerToken);
  const tries = await Promise.all(Array.from({ length: 5 }, () => admin('POST', '/invite/accept', { token: tokenOf(race.body.url), password: 'race-pass-1' })));
  assert.deepEqual(tries.map((t) => t.status).sort(), [201, 410, 410, 410, 410]);

  // Revoked, and a re-invite replaces the open link.
  const rev = await admin('POST', '/team/invites', { email: 'rev@smartfit.uz' }, ownerToken);
  const again = await admin('POST', '/team/invites', { email: 'rev@smartfit.uz' }, ownerToken);
  assert.equal((await admin('POST', '/invite/check', { token: tokenOf(rev.body.url) })).status, 410, 'the older link died');
  assert.equal((await admin('DELETE', `/team/invites/${again.body.id}`, undefined, samOwnerToken)).status, 404, 'other store');
  assert.equal((await admin('DELETE', `/team/invites/${again.body.id}`, undefined, ownerToken)).status, 204);
  assert.equal((await admin('POST', '/invite/accept', { token: tokenOf(again.body.url), password: 'rev-pass-1' })).status, 410);
  for (const bad of ['', 'x', 'a'.repeat(32), undefined]) assert.equal((await admin('POST', '/invite/check', { token: bad })).status, 410);

  // Super-admin invites an owner to any store.
  const so = await admin('POST', '/team/invites', { email: 'owner2@smartfit.uz', role: 'owner', store_id: samarkand }, superToken);
  assert.equal(so.status, 201);
  assert.equal((await admin('POST', '/invite/accept', { token: tokenOf(so.body.url), password: 'owner2-pass-1' })).body.admin.role, 'owner');
  assert.equal((await admin('POST', '/team/invites', { email: 'z@smartfit.uz', role: 'super' }, superToken)).status, 400, 'no super via invite');
  assert.equal((await admin('POST', '/team/invites', { email: 'z@smartfit.uz', role: 'manager' }, superToken)).status, 400, 'super must name a store');
});

test('password change: needs the current password, ends every other session, keeps this one', async () => {
  await createAdmin(db, { email: 'pw@smartfit.uz', password: 'old-pass-123', storeId: tashkent, role: 'manager' });
  const a = await login('pw@smartfit.uz', 'old-pass-123');
  const b = await login('pw@smartfit.uz', 'old-pass-123');
  const wrong = await admin('POST', '/me/password', { current: 'nope-nope-1', password: 'new-pass-123' }, a);
  assert.equal(wrong.status, 400, 'a wrong current password is not a sign-out');
  assert.equal((await admin('POST', '/me/password', { current: 'old-pass-123', password: 'short' }, a)).status, 400);
  const ok = await admin('POST', '/me/password', { current: 'old-pass-123', password: 'new-pass-123' }, a);
  assert.equal(ok.status, 200);
  assert.equal((await admin('GET', '/me', undefined, a)).status, 401, 'this device\'s old token');
  assert.equal((await admin('GET', '/me', undefined, b)).status, 401, 'the other device');
  assert.equal((await admin('GET', '/me', undefined, ok.body.token)).status, 200, 'the new token');
  assert.equal((await admin('POST', '/login', { email: 'pw@smartfit.uz', password: 'old-pass-123' })).status, 401);
  assert.equal((await admin('POST', '/login', { email: 'pw@smartfit.uz', password: 'new-pass-123' })).status, 200);
  const log = await lastAudit();
  assert.equal(log.action, 'account.password');
  assert.equal(log.before, null);
  assert.equal(log.after, null, 'no password material in the log');
});

test('disable: sessions end at once, sign-in is refused, invites they sent die; enable lets them sign in again', async () => {
  await createAdmin(db, { email: 'gone@smartfit.uz', password: 'gone-pass-1', storeId: samarkand });
  const t = await login('gone@smartfit.uz', 'gone-pass-1');
  const sent = await admin('POST', '/team/invites', { email: 'fromgone@smartfit.uz' }, t);
  const gone = await db('admins').where({ email: 'gone@smartfit.uz' }).first();
  assert.equal((await admin('PATCH', `/team/${gone.id}`, { disabled: true }, samOwnerToken)).status, 404, 'an owner cannot disable another owner');
  assert.equal((await admin('PATCH', `/team/${gone.id}`, { disabled: 'yes' }, superToken)).status, 400);
  const off = await admin('PATCH', `/team/${gone.id}`, { disabled: true }, superToken);
  assert.equal(off.status, 200);
  assert.equal((await admin('GET', '/me', undefined, t)).status, 401);
  const refused = await admin('POST', '/login', { email: 'gone@smartfit.uz', password: 'gone-pass-1' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'account_disabled');
  assert.equal((await admin('POST', '/invite/check', { token: tokenOf(sent.body.url) })).status, 410);
  assert.equal((await lastAudit()).action, 'team.disable');
  assert.equal((await admin('PATCH', `/team/${gone.id}`, { disabled: false }, superToken)).status, 200);
  assert.equal((await admin('GET', '/me', undefined, t)).status, 401, 'old tokens stay dead after enabling');
  assert.equal((await admin('POST', '/login', { email: 'gone@smartfit.uz', password: 'gone-pass-1' })).status, 200);
  const supers = await db('admins').where({ role: 'super' }).first();
  assert.equal((await admin('PATCH', `/team/${supers.id}`, { disabled: true }, superToken)).status, 404, 'not yourself, never a super');
});

// The route walk: every mutating admin route must write an audit row. A new route without a recipe here fails the test,
// so nobody can add a mutation and forget the log.
test('every mutating admin route writes an audit row', async () => {
  const routes = createAdminRouter(db).stack.filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).filter((m) => m !== '_all' && m !== 'get' && m !== 'head').map((m) => `${m.toUpperCase()} ${l.route.path}`));
  const NOT_MUTATIONS = ['POST /login', 'POST /invite/check']; // read-only POSTs (credentials / token in the body)

  const product = async () => (await admin('POST', '/products', { name: 'Audit ko\'ylak', category: 'top', gender: 'unisex', color: 'oq', price: 100000, temp_min: 0, temp_max: 30, stock: { M: 3 } }, ownerToken)).body;
  async function pendingOrder() {
    const p = await db('products').where({ store_id: tashkent, category: 'top' }).orderBy('id').first();
    await db('product_stock').where({ product_id: p.id, size: 'M' }).update({ quantity: 5, reserved: 0 });
    const cart = await call('POST', '/api/cart/items', { store_id: tashkent, items: [{ product_id: p.id, size: 'M' }] });
    return (await call('POST', `/api/cart/${cart.body.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '+998901234567' })).body.order;
  }
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  const member = async () => {
    await createAdmin(db, { email: `walk${Date.now()}@smartfit.uz`, password: 'walk-pass-1', storeId: tashkent, role: 'manager' });
    return db('admins').orderBy('id', 'desc').first();
  };
  const newMall = () => admin('POST', '/malls', { name: `Walk mall ${Date.now()}`, city: 'Toshkent', address: 'Navoiy 1', admin_email: `mall${Date.now()}@smartfit.uz` }, superToken);
  let mallTok = null;
  const mallToken = async () => {
    if (!mallTok) {
      await createAdmin(db, { email: 'walk.mall@smartfit.uz', password: 'mall-pass-1', mallId: (await db('malls').orderBy('id').first()).id });
      mallTok = await login('walk.mall@smartfit.uz', 'mall-pass-1');
    }
    return mallTok;
  };
  const recipes = {
    'POST /products': ['product.create', () => admin('POST', '/products', { name: 'Yangi', category: 'top', gender: 'male', color: 'qora', price: 90000, temp_min: 0, temp_max: 25 }, ownerToken)],
    'PATCH /products/:id': ['product.update', async () => admin('PATCH', `/products/${(await product()).id}`, { price: 95000, stock: { M: 1 } }, ownerToken)],
    'DELETE /products/:id': ['product.delete', async () => admin('DELETE', `/products/${(await product()).id}`, undefined, ownerToken)],
    'POST /products/import': ['product.create', () => admin('POST', '/products/import', undefined, ownerToken,
      { raw: 'name,category,gender,color,price,temp_min,temp_max,M\nCSV ko\'ylak,top,unisex,oq,80000,0,30,2\n', type: 'text/csv' })],
    'POST /products/:id/image': ['product.image', async () => admin('POST', `/products/${(await product()).id}/image`, undefined, ownerToken, { raw: png, type: 'image/png' })],
    'DELETE /products/:id/image': ['product.image_delete', async () => {
      const p = await product();
      await admin('POST', `/products/${p.id}/image`, undefined, ownerToken, { raw: png, type: 'image/png' });
      return admin('DELETE', `/products/${p.id}/image`, undefined, ownerToken);
    }],
    'POST /orders/:id/pay': ['order.pay', async () => admin('POST', `/orders/${(await pendingOrder()).id}/pay`, {}, managerToken)],
    'POST /orders/:id/status': ['order.status', async () => admin('POST', `/orders/${(await pendingOrder()).id}/status`, { status: 'cancelled' }, managerToken)],
    'PATCH /products/:id/fit': ['product.fit', async () => admin('PATCH', `/products/${(await product()).id}/fit`, { offset: 1 }, ownerToken)],
    'POST /orders/:id/returns': ['order.return', async () => {
      const o = await pendingOrder();
      for (const step of ['pay', 'packing', 'delivered']) {
        await admin('POST', `/orders/${o.id}/${step === 'pay' ? 'pay' : 'status'}`, step === 'pay' ? {} : { status: step }, managerToken);
      }
      return admin('POST', `/orders/${o.id}/returns`, { key: 'c'.repeat(32), item_id: o.items[0].id, kind: 'return', reason: 'too_big', quantity: 1, restock: true }, managerToken);
    }],
    'POST /fitting/:id/done': ['fitting.done', async () => {
      const [{ id }] = await db('fitting_requests').insert({ store_id: tashkent, cabin: 2, items: JSON.stringify([]) }).returning('id');
      return admin('POST', `/fitting/${id}/done`, {}, managerToken);
    }],
    'POST /fitting/:id/accept': ['fitting.accept', async () => {
      const [{ id }] = await db('fitting_requests').insert({ store_id: tashkent, cabin: 3, items: JSON.stringify([]) }).returning('id');
      return admin('POST', `/fitting/${id}/accept`, {}, managerToken);
    }],
    'PATCH /stores/:id': ['store.update', () => admin('PATCH', `/stores/${tashkent}`, { delivery_fee: Math.floor(Math.random() * 1e6) + 1 }, ownerToken)],
    'POST /team/invites': ['team.invite', () => admin('POST', '/team/invites', { email: `inv${Date.now()}@smartfit.uz` }, ownerToken)],
    'DELETE /team/invites/:id': ['team.invite_revoke', async () => {
      const inv = await admin('POST', '/team/invites', { email: `del${Date.now()}@smartfit.uz` }, ownerToken);
      return admin('DELETE', `/team/invites/${inv.body.id}`, undefined, ownerToken);
    }],
    'POST /invite/accept': ['team.join', async () => {
      const inv = await admin('POST', '/team/invites', { email: `join${Date.now()}@smartfit.uz` }, ownerToken);
      return admin('POST', '/invite/accept', { token: tokenOf(inv.body.url), password: 'join-pass-1' });
    }],
    'PATCH /team/:id': ['team.disable', async () => admin('PATCH', `/team/${(await member()).id}`, { disabled: true }, ownerToken)],
    'POST /sync-keys': ['sync_key.create', () => admin('POST', '/sync-keys', { name: 'Kassa' }, ownerToken)],
    'DELETE /sync-keys/:id': ['sync_key.revoke', async () => admin('DELETE', `/sync-keys/${(await admin('POST', '/sync-keys', { name: 'Eski' }, ownerToken)).body.id}`, undefined, ownerToken)],
    'POST /stores': ['store.create', () => admin('POST', '/stores', { name: `Filial ${Date.now()}`, city: 'Toshkent', address: 'Chilonzor 1', lat: 41.28, lon: 69.2 }, ownerToken)],
    'POST /promos': ['promo.create', () => admin('POST', '/promos', { code: `WALK${Date.now()}`, kind: 'percent', value: 10 }, ownerToken)],
    'PATCH /promos/:id': ['promo.update', async () => {
      const p = (await admin('POST', '/promos', { code: `OFF${Date.now()}`, kind: 'fixed', value: 5000 }, ownerToken)).body;
      return admin('PATCH', `/promos/${p.id}`, { active: false }, ownerToken);
    }],
    // Task 36: categories (owner).
    'POST /categories': ['category.create', () => admin('POST', '/categories', { name: `Walk ${Date.now()}`, name_ru: `Обход ${Date.now()}`, size_kind: 'one' }, ownerToken)],
    'PATCH /categories/:id': ['category.update', async () => {
      const c = (await admin('POST', '/categories', { name: `Yangi ${Date.now()}`, name_ru: `Новая ${Date.now()}`, size_kind: 'one' }, ownerToken)).body;
      return admin('PATCH', `/categories/${c.id}`, { hidden: true }, ownerToken);
    }],
    'DELETE /categories/:id': ['category.delete', async () => {
      const c = (await admin('POST', '/categories', { name: `Bo'sh ${Date.now()}`, name_ru: `Пустая ${Date.now()}`, size_kind: 'one' }, ownerToken)).body;
      return admin('DELETE', `/categories/${c.id}`, undefined, ownerToken);
    }],
    'POST /categories/:id/image': ['category.image', async () => {
      const c = (await admin('POST', '/categories', { name: `Rasm ${Date.now()}`, name_ru: `Фото ${Date.now()}`, size_kind: 'one' }, ownerToken)).body;
      return admin('POST', `/categories/${c.id}/image`, undefined, ownerToken, { raw: png, type: 'image/png' });
    }],
    'DELETE /categories/:id/image': ['category.image', async () => {
      const c = (await admin('POST', '/categories', { name: `Rasmsiz ${Date.now()}`, name_ru: `Без фото ${Date.now()}`, size_kind: 'one' }, ownerToken)).body;
      await admin('POST', `/categories/${c.id}/image`, undefined, ownerToken, { raw: png, type: 'image/png' });
      return admin('DELETE', `/categories/${c.id}/image`, undefined, ownerToken);
    }],
    'POST /orgs': ['org.create', () => admin('POST', '/orgs', { name: 'Audit brand', owner_email: `org${Date.now()}@smartfit.uz` }, superToken)],
    // Task 34: the organisation's cashback setting (owner); a value that changes, so a row is written.
    'PATCH /points': ['org.points', async () => {
      const g = (await admin('GET', '/points', undefined, ownerToken)).body;
      return admin('PATCH', '/points', { cashback_percent: g.cashback_percent === 5 ? 6 : 5 }, ownerToken);
    }],
    // Task 39: an owner's correction of a customer's points.
    'POST /points/adjust': ['points.adjust', async () => {
      const store = await db('stores').where({ id: tashkent }).first('organization_id');
      const [{ id }] = await db('customer_profiles').insert({ organization_id: store.organization_id, telegram_user_id: Date.now(), phone: '+998901119999', name: 'Walk', consent_at: new Date().toISOString() }).returning('id');
      return admin('POST', '/points/adjust', { store_id: tashkent, profile_id: id, amount: 5000, reason: 'Aksiya sovg\'asi' }, ownerToken);
    }],
    // Task 37: malls (super) and the mall admin's own mall.
    'POST /malls': ['mall.create', () => newMall()],
    'PATCH /malls/:id': ['mall.update', async () => admin('PATCH', `/malls/${(await newMall()).body.id}`, { name: `Yangi ${Date.now()}`, store_ids: [] }, superToken)],
    'DELETE /malls/:id': ['mall.delete', async () => admin('DELETE', `/malls/${(await newMall()).body.id}`, undefined, superToken)],
    'POST /malls/:id/invites': ['team.invite', async () => admin('POST', `/malls/${(await newMall()).body.id}/invites`, { email: `mall2${Date.now()}@smartfit.uz` }, superToken)],
    'PATCH /mall': ['mall.update', async () => admin('PATCH', '/mall', { name: `Demo ${Date.now()}` }, await mallToken())],
    'POST /mall/logo': ['mall.logo', async () => admin('POST', '/mall/logo', undefined, await mallToken(), { raw: png, type: 'image/png' })],
    'DELETE /mall/logo': ['mall.logo', async () => admin('DELETE', '/mall/logo', undefined, await mallToken())],
    'POST /mall/shops': ['org.create', async () => admin('POST', '/mall/shops', { name: 'Mall brand', owner_email: `shop${Date.now()}@smartfit.uz` }, await mallToken())],
    'PATCH /mall/stores/:id': ['mall.store', async () => admin('PATCH', `/mall/stores/${tashkent}`, { floor: String(Date.now() % 1e6) }, await mallToken())],
    'POST /mall/stores/:id/logo': ['mall.store', async () => admin('POST', `/mall/stores/${tashkent}/logo`, undefined, await mallToken(), { raw: png, type: 'image/png' })],
    'DELETE /mall/stores/:id/logo': ['mall.store', async () => admin('DELETE', `/mall/stores/${tashkent}/logo`, undefined, await mallToken())],
    'PATCH /demo-requests/:id': ['demo.handle', async () => {
      const [{ id }] = await db('demo_requests').insert({ name: 'Aziz', phone: '+998901234567', company: 'Moda', lang: 'uz' }).returning('id');
      return admin('PATCH', `/demo-requests/${id}`, { handled: true }, superToken);
    }],
    'POST /me/password': ['account.password', async () => {
      const m = await member();
      return admin('POST', '/me/password', { current: 'walk-pass-1', password: 'walk-pass-2' }, await login(m.email, 'walk-pass-1'));
    }],
  };
  assert.deepEqual(Object.keys(recipes).sort(), routes.filter((r) => !NOT_MUTATIONS.includes(r)).sort(), 'every mutating route has a recipe here');
  for (const [route, [action, run]] of Object.entries(recipes)) {
    const before = (await db('audit_log').max({ id: 'id' }))[0].id ?? 0;
    const res = await run();
    assert.ok(res.status >= 200 && res.status < 300, `${route} → ${res.status} ${JSON.stringify(res.body)}`);
    const rows = await db('audit_log').where('id', '>', before);
    assert.ok(rows.some((r) => r.action === action), `${route} wrote ${action} (got ${rows.map((r) => r.action)})`);
    for (const r of rows) {
      assert.ok(AUDIT_ACTIONS.includes(r.action));
      assert.ok(r.admin_id && r.admin_email, `${route}: who did it`);
      assert.doesNotMatch(JSON.stringify([r.before, r.after]), /scrypt|password|token/i, `${route}: no secrets in the log`);
    }
  }
});

test('audit viewer: newest first, filters, before/after as objects, store-scoped', async () => {
  const p = (await admin('POST', '/products', { name: 'Narx testi', category: 'top', gender: 'unisex', color: 'oq', price: 200000, temp_min: 0, temp_max: 30 }, ownerToken)).body;
  await admin('PATCH', `/products/${p.id}`, { price: 180000 }, ownerToken);
  const hist = await admin('GET', `/audit?entity=product&entity_id=${p.id}`, undefined, ownerToken);
  assert.equal(hist.status, 200);
  assert.deepEqual(hist.body.items.map((i) => i.action), ['product.update', 'product.create']);
  assert.deepEqual([hist.body.items[0].before, hist.body.items[0].after], [{ price: 200000 }, { price: 180000 }]);
  assert.equal(hist.body.items[0].entity_label, 'Narx testi');
  assert.equal(hist.body.items[0].admin_email, 'owner@smartfit.uz');
  const owner = await db('admins').where({ email: 'owner@smartfit.uz' }).first();
  const byOwner = await admin('GET', `/audit?admin_id=${owner.id}&limit=100`, undefined, ownerToken);
  assert.ok(byOwner.body.items.length && byOwner.body.items.every((i) => i.admin_id === owner.id));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
  assert.ok((await admin('GET', `/audit?from=${today}&to=${today}`, undefined, ownerToken)).body.total > 0);
  assert.equal((await admin('GET', '/audit?from=2001-01-01&to=2001-01-02', undefined, ownerToken)).body.total, 0);
  assert.equal((await admin('GET', '/audit?entity=password', undefined, ownerToken)).status, 400);
  assert.equal((await admin('GET', '/audit?from=yesterday', undefined, ownerToken)).status, 400);
  assert.ok((await admin('GET', '/audit?limit=100', undefined, samOwnerToken)).body.items.every((i) => i.store_id === samarkand));
  const all = await admin('GET', '/audit?limit=100', undefined, superToken);
  assert.ok(new Set(all.body.items.map((i) => i.store_id)).size >= 2, 'super sees every store');
});

test('CLI: store:create and admin:create still work (owner by default, manager on request, super without a store)', async () => {
  const file = path.join(uploadDir, 'cli.db');
  const env = { ...process.env, DATABASE_URL: '', SQLITE_FILE: file, ADMIN_PASSWORD: 'cli-pass-123' };
  const run = (script, args) => promisify(execFile)(process.execPath, [new URL(`../src/admin/${script}`, import.meta.url).pathname, ...args], { env });
  const store = await run('create-store.js', ['Smart Fit Buxoro', 'Buxoro', '39.77', '64.43', 'Navoiy 1', '15000']);
  const id = store.stdout.match(/#(\d+)/)[1];
  await run('create-admin.js', ['boss@cli.uz']);
  await run('create-admin.js', ['owner@cli.uz', id]);
  await run('create-admin.js', ['mgr@cli.uz', id, 'manager']);
  await assert.rejects(run('create-admin.js', ['bad@cli.uz', id, 'boss']));
  const c = createDb({ databaseUrl: '', sqliteFile: file });
  try {
    assert.deepEqual((await c('admins').orderBy('id').select('email', 'role', 'store_id')).map((a) => [a.email, a.role, a.store_id]),
      [['boss@cli.uz', 'super', null], ['owner@cli.uz', 'owner', Number(id)], ['mgr@cli.uz', 'manager', Number(id)]]);
  } finally {
    await c.destroy();
  }
});
