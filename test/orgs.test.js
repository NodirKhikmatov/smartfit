// Task 22: organisations (isolation on every admin endpoint), migration 012, the landing page's demo form, and the
// invite → wizard flow that ends in a store the customer app can use.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin, createAdminRouter } from '../src/admin/routes.js';
import { flushDemoRequests } from '../src/notify/telegram.js';
import { landingLooks, LANDING_TEMPS } from '../src/landing.js';
import { requiredCategories } from '../src/recommend/engine.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let server, base, uploadDir, orgA, orgB, a1, a2, b1, superToken, ownerA, managerA2, ownerB;

const call = async (method, p, body, token, { raw, type, ip } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': type || 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...(ip && { 'x-forwarded-for': ip }) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
};
const admin = (method, p, body, token, opts) => call(method, `/api/admin${p}`, body, token, opts);
const login = async (email, password) => (await admin('POST', '/login', { email, password })).body.token;
const tokenOf = (url) => new URL(url).hash.split('token=')[1];
const STORE = { name: 'Moda Chilonzor', city: 'Toshkent', address: 'Bunyodkor 1', lat: 41.28, lon: 69.2 };

before(async () => {
  await db.migrate.latest();
  await seed(db); // two demo organisations, one store each
  [a1, b1] = (await db('stores').orderBy('id')).map((s) => s.id);
  [orgA, orgB] = (await db('stores').orderBy('id')).map((s) => s.organization_id);
  [{ id: a2 }] = await db('stores').insert({ ...STORE, name: 'A filial', organization_id: orgA }).returning('id');
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  await createAdmin(db, { email: 'owner.a@smartfit.uz', password: 'owner-pass-1', storeId: a1 });
  await createAdmin(db, { email: 'mgr.a2@smartfit.uz', password: 'mgr-pass-1', storeId: a2, role: 'manager' });
  await createAdmin(db, { email: 'owner.b@smartfit.uz', password: 'owner-pass-2', storeId: b1 });
  uploadDir = await mkdtemp(path.join(tmpdir(), 'sf-orgs-'));
  server = createApp(db, { uploadDir, telegram: null, stylist: null, trustProxy: '1', weather: async () => ({ temperature: 15, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  superToken = await login('boss@smartfit.uz', 'boss-pass-1');
  ownerA = await login('owner.a@smartfit.uz', 'owner-pass-1');
  managerA2 = await login('mgr.a2@smartfit.uz', 'mgr-pass-1');
  ownerB = await login('owner.b@smartfit.uz', 'owner-pass-2');
});
after(async () => {
  server.close();
  await db.destroy();
  await rm(uploadDir, { recursive: true, force: true });
});

// One of each kind of record in org B, for the isolation walk.
async function orgBRecords() {
  const product = await db('products').where({ store_id: b1, category: 'top' }).orderBy('id').first();
  await db('product_stock').where({ product_id: product.id, size: 'M' }).update({ quantity: 9, reserved: 0 });
  const cart = await call('POST', '/api/cart/items', { store_id: b1, items: [{ product_id: product.id, size: 'M' }] });
  const order = (await call('POST', `/api/cart/${cart.body.token}/checkout`, { fulfillment: 'pickup', name: 'Bobur', phone: '+998901112233' })).body.order;
  const [{ id: fitting }] = await db('fitting_requests').insert({ store_id: b1, cabin: 4, items: JSON.stringify([]) }).returning('id');
  const invite = (await admin('POST', '/team/invites', { email: `b.inv${Date.now()}@smartfit.uz` }, ownerB)).body;
  const key = (await admin('POST', '/sync-keys', { name: 'Kassa B' }, ownerB)).body;
  await createAdmin(db, { email: `b.mgr${Date.now()}@smartfit.uz`, password: 'bmgr-pass-1', storeId: b1, role: 'manager' });
  const member = await db('admins').where({ store_id: b1, role: 'manager' }).orderBy('id', 'desc').first();
  // Task 24: org B's missed demand (with a SKU only org B has) and a funnel visit.
  await db('products').where({ id: product.id }).update({ sku: 'ORGB-ONLY-1' });
  await db('missed_demand').insert({ store_id: b1, product_id: product.id, size: 'L', session: 'b'.repeat(32), source: 'recommend' });
  await db('funnel_events').insert({ store_id: b1, visit: 'c'.repeat(32), step: 'order' });
  await db('qr_scans').insert({ token: 'd'.repeat(32), store_id: b1, product_id: product.id }); // task 32: a label scan
  await db('recommendation_logs').insert({ store_id: b1, product_ids: '[]', source: 'rules', occasion: 'party' }); // task 33
  const promo = (await admin('POST', '/promos', { code: 'ORGBPROMO', kind: 'percent', value: 10, store_id: b1 }, ownerB)).body; // task 26
  // Task 34: org B has points on and a customer with points from that order (same name and phone the walk looks for).
  await db('organizations').where({ id: orgB }).update({ cashback_percent: 5 });
  const [{ id: profile }] = await db('customer_profiles').insert({ organization_id: orgB, telegram_user_id: 777001, phone: '+998901112233', name: 'Bobur', consent_at: new Date().toISOString() }).returning('id');
  await db('points_ledger').insert({ organization_id: orgB, profile_id: profile, order_id: order.id, kind: 'earn', amount: 5000, ref: `earn:${order.id}` });
  return { product, order, fitting, invite, key, member, promo };
}

// The isolation walk: every admin route, called by org A's owner against org B's records. A route not listed here
// fails the test, so a new endpoint can't skip the org check.
test('org isolation: an owner of org A never reads or changes org B, on every admin endpoint', async () => {
  const B = await orgBRecords();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  const json = (r) => JSON.stringify(r.body);
  const noB = (r) => {
    assert.equal(r.status, 200, json(r));
    const ids = new Set();
    JSON.stringify(r.body, (k, v) => { if (k === 'store_id') ids.add(v); return v; });
    assert.ok(!ids.has(b1), `no org B store in ${json(r).slice(0, 200)}`);
    assert.ok(!json(r).includes(B.order.customer_name ?? 'Bobur') && !json(r).includes('+998901112233'), 'no org B customer');
  };
  const refused = (r) => assert.ok([403, 404].includes(r.status), `${r.status} ${json(r)}`);
  const checks = {
    'GET /me': async () => assert.equal((await admin('GET', '/me', undefined, ownerA)).body.organization_id, orgA),
    'GET /stores': async () => assert.deepEqual((await admin('GET', '/stores', undefined, ownerA)).body.map((s) => s.id).sort(), [a1, a2].sort()),
    'GET /stores/:id/qr': async () => refused(await admin('GET', `/stores/${b1}/qr`, undefined, ownerA)),
    'GET /labels': async () => refused(await admin('GET', `/labels?ids=${B.product.id}`, undefined, ownerA)), // task 32
    'GET /products': async () => {
      noB(await admin('GET', '/products?limit=100', undefined, ownerA));
      const r = await admin('GET', `/products?store_id=${b1}`, undefined, ownerA);
      assert.equal(r.body.total, 0, '?store_id cannot widen the scope');
    },
    'GET /products/:id': async () => refused(await admin('GET', `/products/${B.product.id}`, undefined, ownerA)),
    'POST /products': async () => refused(await admin('POST', '/products', { name: 'X', category: 'top', gender: 'male', color: 'oq', price: 1000, temp_min: 0, temp_max: 30, store_id: b1 }, ownerA)),
    'PATCH /products/:id': async () => refused(await admin('PATCH', `/products/${B.product.id}`, { price: 1 }, ownerA)),
    'DELETE /products/:id': async () => refused(await admin('DELETE', `/products/${B.product.id}`, undefined, ownerA)),
    'PATCH /products/:id/fit': async () => refused(await admin('PATCH', `/products/${B.product.id}/fit`, { offset: 1 }, ownerA)),
    'POST /products/import': async () => {
      const r = await admin('POST', `/products/import?store_id=${b1}`, undefined, ownerA, { raw: 'name,category,gender,color,price,temp_min,temp_max,M\nX,top,male,oq,1000,0,30,1\n', type: 'text/csv' });
      assert.equal(r.status, 400);
      assert.equal(r.body.errors[0].code, 'store_forbidden');
      const r2 = await admin('POST', '/products/import', undefined, ownerA, { raw: `id,price\n${B.product.id},1\n`, type: 'text/csv' });
      assert.equal(r2.status, 400, 'an org B product id is unknown');
    },
    'POST /products/:id/image': async () => refused(await admin('POST', `/products/${B.product.id}/image`, undefined, ownerA, { raw: png, type: 'image/png' })),
    'DELETE /products/:id/image': async () => refused(await admin('DELETE', `/products/${B.product.id}/image`, undefined, ownerA)),
    'GET /orders': async () => {
      noB(await admin('GET', '/orders?limit=100', undefined, ownerA));
      assert.equal((await admin('GET', `/orders?number=${B.order.number}`, undefined, ownerA)).body.items.filter((o) => o.store_id === b1).length, 0);
    },
    'GET /orders/export': async () => {
      const r = await admin('GET', '/orders/export', undefined, ownerA);
      assert.equal(r.status, 200);
      assert.ok(!String(r.body).includes('Bobur'), 'no org B order in the export');
    },
    'GET /orders/unseen': async () => {
      const mine = (await admin('GET', '/orders/unseen?since=0', undefined, ownerA)).body;
      assert.notEqual(mine.latest, B.order.id);
    },
    'GET /orders/:id': async () => refused(await admin('GET', `/orders/${B.order.id}`, undefined, ownerA)),
    'POST /orders/:id/pay': async () => refused(await admin('POST', `/orders/${B.order.id}/pay`, {}, ownerA)),
    'POST /orders/:id/status': async () => refused(await admin('POST', `/orders/${B.order.id}/status`, { status: 'cancelled' }, ownerA)),
    'POST /orders/:id/returns': async () => refused(await admin('POST', `/orders/${B.order.id}/returns`, { key: 'b'.repeat(32), item_id: B.order.items[0].id, kind: 'return', reason: 'too_small', quantity: 1, restock: true }, ownerA)),
    'GET /fitting': async () => noB(await admin('GET', '/fitting', undefined, ownerA)),
    'POST /fitting/:id/done': async () => refused(await admin('POST', `/fitting/${B.fitting}/done`, {}, ownerA)),
    'POST /fitting/:id/accept': async () => refused(await admin('POST', `/fitting/${B.fitting}/accept`, {}, ownerA)),
    'GET /staff': async () => {
      const r = await admin('GET', '/staff', undefined, ownerA);
      noB(r);
      assert.ok(!r.body.stores.some((s) => s.id === b1) && !JSON.stringify(r.body).includes('ORGB-ONLY-1'), 'no org B store or stock');
    },
    'GET /stats': async () => {
      const r = await admin('GET', `/stats?store_id=${b1}`, undefined, ownerA);
      assert.equal(r.status, 200);
      assert.equal(r.body.recommendations ?? r.body.totals?.recommendations ?? 0, 0);
    },
    'GET /dashboard': async () => noB(await admin('GET', '/dashboard', undefined, ownerA)),
    'GET /demand': async () => {
      noB(await admin('GET', '/demand?days=30', undefined, ownerA));
      const r = await admin('GET', `/demand?store_id=${b1}`, undefined, ownerA);
      assert.equal(r.body.items.length, 0, '?store_id cannot widen the scope');
      assert.equal(r.body.funnel.total.start, 0);
      assert.equal(r.body.funnel.per_kiosk.length, 0);
      assert.equal(r.body.scans.length, 0, 'no org B label scans');
      assert.ok(r.body.occasions.every((o) => o.customers === 0 && o.orders === 0), 'no org B occasion demand');
    },
    'GET /demand/export': async () => {
      for (const q of ['', `?store_id=${b1}`]) {
        const r = await admin('GET', `/demand/export${q}`, undefined, ownerA);
        assert.equal(r.status, 200);
        assert.ok(!String(r.body).includes('ORGB-ONLY-1'), 'no org B row in the export');
      }
    },
    'GET /stores/:id': async () => refused(await admin('GET', `/stores/${b1}`, undefined, ownerA)),
    'PATCH /stores/:id': async () => refused(await admin('PATCH', `/stores/${b1}`, { delivery_fee: 1 }, ownerA)),
    'POST /stores': async () => {
      const r = await admin('POST', '/stores', { ...STORE, name: 'A uchinchi', organization_id: orgB }, ownerA);
      assert.equal(r.status, 201);
      assert.equal(r.body.organization_id, orgA, 'an owner always adds to their own organisation');
      await db('stores').where({ id: r.body.id }).del();
    },
    'GET /team': async () => {
      const r = await admin('GET', '/team', undefined, ownerA);
      assert.ok(r.body.members.every((m) => m.organization_id === orgA), 'only org A members');
      assert.ok(!r.body.invites.some((i) => i.id === B.invite.id));
    },
    'POST /team/invites': async () => refused(await admin('POST', '/team/invites', { email: 'x@smartfit.uz', store_id: b1 }, ownerA)),
    'DELETE /team/invites/:id': async () => refused(await admin('DELETE', `/team/invites/${B.invite.id}`, undefined, ownerA)),
    'PATCH /team/:id': async () => refused(await admin('PATCH', `/team/${B.member.id}`, { disabled: true }, ownerA)),
    'GET /sync-keys': async () => noB(await admin('GET', '/sync-keys', undefined, ownerA)),
    'POST /sync-keys': async () => refused(await admin('POST', '/sync-keys', { name: 'X', store_id: b1 }, ownerA)),
    'DELETE /sync-keys/:id': async () => refused(await admin('DELETE', `/sync-keys/${B.key.id}`, undefined, ownerA)),
    'GET /audit': async () => {
      noB(await admin('GET', '/audit?limit=100', undefined, ownerA));
      assert.equal((await admin('GET', `/audit?store_id=${b1}`, undefined, ownerA)).body.total, 0);
    },
    // Task 36: categories belong to the organisation; org B's are never listed, changed, deleted or used by org A.
    'GET /categories': async () => {
      for (const q of ['', `?organization_id=${orgB}`, `?store_id=${b1}`]) {
        const r = await admin('GET', `/categories${q}`, undefined, ownerA);
        assert.equal(r.status, 200);
        assert.ok(r.body.length && r.body.every((c) => c.organization_id === orgA), 'only org A categories');
      }
    },
    'POST /categories': async () => {
      const r = await admin('POST', '/categories', { name: 'A toifa', name_ru: 'A категория', size_kind: 'one', organization_id: orgB, store_id: b1 }, ownerA);
      assert.equal(r.status, 201);
      assert.equal(r.body.organization_id, orgA, 'an owner always adds to their own organisation');
      await db('categories').where({ id: r.body.id }).del();
    },
    'PATCH /categories/:id': async () => {
      const c = await db('categories').where({ organization_id: orgB }).first();
      refused(await admin('PATCH', `/categories/${c.id}`, { name: 'Buzildi' }, ownerA));
      assert.equal((await db('categories').where({ id: c.id }).first()).name, c.name);
      // Nor can an org A product take it, by id or by its name.
      const p = await db('products').whereIn('store_id', [a1, a2]).first();
      assert.equal((await admin('PATCH', `/products/${p.id}`, { category_id: c.id }, ownerA)).status, 400);
      assert.equal((await admin('POST', '/products', { name: 'X', category_id: c.id, gender: 'male', color: 'oq', price: 1000, temp_min: 0, temp_max: 30, store_id: a1 }, ownerA)).status, 400);
    },
    'DELETE /categories/:id': async () => {
      const c = await db('categories').where({ organization_id: orgB }).orderBy('id', 'desc').first();
      refused(await admin('DELETE', `/categories/${c.id}`, undefined, ownerA));
      assert.ok(await db('categories').where({ id: c.id }).first());
    },
    'POST /categories/:id/image': async () => {
      const c = await db('categories').where({ organization_id: orgB }).first();
      refused(await admin('POST', `/categories/${c.id}/image`, undefined, ownerA, { raw: png, type: 'image/png' }));
    },
    'DELETE /categories/:id/image': async () => {
      const c = await db('categories').where({ organization_id: orgB }).first();
      refused(await admin('DELETE', `/categories/${c.id}/image`, undefined, ownerA));
    },
    'GET /promos': async () => {
      for (const q of ['', `?organization_id=${orgB}`]) {
        const r = await admin('GET', `/promos${q}`, undefined, ownerA);
        assert.equal(r.status, 200);
        assert.ok(r.body.every((p) => p.organization_id === orgA) && !r.body.some((p) => p.code === 'ORGBPROMO'), 'no org B code');
      }
    },
    'POST /promos': async () => {
      refused(await admin('POST', '/promos', { code: 'AINB1', kind: 'percent', value: 50, store_id: b1 }, ownerA));
      const r = await admin('POST', '/promos', { code: 'ORGBPROMO', kind: 'percent', value: 50, organization_id: orgB }, ownerA);
      assert.equal(r.status, 201, 'the same code text is free in another organisation');
      assert.equal(r.body.organization_id, orgA, 'an owner always creates in their own organisation');
      await db('promo_codes').where({ id: r.body.id }).del();
    },
    'PATCH /promos/:id': async () => {
      refused(await admin('PATCH', `/promos/${B.promo.id}`, { value: 99 }, ownerA));
      const mine = (await admin('POST', '/promos', { code: 'AMOVE1', kind: 'percent', value: 5 }, ownerA)).body;
      refused(await admin('PATCH', `/promos/${mine.id}`, { store_id: b1 }, ownerA)); // can't move a code into org B's store
      await db('promo_codes').where({ id: mine.id }).del();
    },
    // Task 34: org B's points setting and customer list (names, phones) are org B's.
    'GET /points': async () => {
      refused(await admin('GET', `/points?store_id=${b1}`, undefined, ownerA));
      const r = await admin('GET', '/points', undefined, ownerA);
      noB(r);
      assert.equal(r.body.outstanding, 0);
    },
    'PATCH /points': async () => {
      refused(await admin('PATCH', '/points', { store_id: b1, cashback_percent: 20 }, ownerA));
      const r = await admin('PATCH', '/points', { cashback_percent: 3 }, ownerA);
      assert.equal(r.status, 200);
      await db('organizations').where({ id: orgA }).update({ cashback_percent: 0 });
    },
    // Task 37: malls are super's; a mall's own routes are the mall admin's. A shop owner gets neither, even in that mall.
    'GET /malls': async () => refused(await admin('GET', '/malls', undefined, ownerA)),
    'POST /malls': async () => refused(await admin('POST', '/malls', { name: 'X', city: 'T', address: 'A', admin_email: 'm@smartfit.uz' }, ownerA)),
    'PATCH /malls/:id': async () => refused(await admin('PATCH', '/malls/1', { store_ids: [] }, ownerA)),
    'DELETE /malls/:id': async () => refused(await admin('DELETE', '/malls/1', undefined, ownerA)),
    'POST /malls/:id/invites': async () => refused(await admin('POST', '/malls/1/invites', { email: 'm@smartfit.uz' }, ownerA)),
    'GET /mall': async () => refused(await admin('GET', '/mall', undefined, ownerA)),
    'PATCH /mall': async () => refused(await admin('PATCH', '/mall', { name: 'X' }, ownerA)),
    'GET /mall/qr': async () => refused(await admin('GET', '/mall/qr', undefined, ownerA)),
    'POST /mall/logo': async () => refused(await admin('POST', '/mall/logo', undefined, ownerA, { raw: png, type: 'image/png' })),
    'DELETE /mall/logo': async () => refused(await admin('DELETE', '/mall/logo', undefined, ownerA)),
    'POST /mall/shops': async () => refused(await admin('POST', '/mall/shops', { name: 'X', owner_email: 'x3@smartfit.uz' }, ownerA)),
    'PATCH /mall/stores/:id': async () => refused(await admin('PATCH', `/mall/stores/${b1}`, { hidden: true }, ownerA)),
    'POST /mall/stores/:id/logo': async () => refused(await admin('POST', `/mall/stores/${b1}/logo`, undefined, ownerA, { raw: png, type: 'image/png' })),
    'DELETE /mall/stores/:id/logo': async () => refused(await admin('DELETE', `/mall/stores/${b1}/logo`, undefined, ownerA)),
    'GET /orgs': async () => refused(await admin('GET', '/orgs', undefined, ownerA)),
    'POST /orgs': async () => refused(await admin('POST', '/orgs', { name: 'X', owner_email: 'x2@smartfit.uz' }, ownerA)),
    'GET /demo-requests': async () => refused(await admin('GET', '/demo-requests', undefined, ownerA)),
    'PATCH /demo-requests/:id': async () => refused(await admin('PATCH', '/demo-requests/1', { handled: true }, ownerA)),
  };
  // Not about stores: credentials, the invite flow and the caller's own password.
  const NOT_SCOPED = ['POST /login', 'POST /invite/check', 'POST /invite/accept', 'POST /me/password'];
  const routes = createAdminRouter(db).stack.filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).filter((m) => m !== '_all' && m !== 'head').map((m) => `${m.toUpperCase()} ${l.route.path}`));
  assert.deepEqual(routes.filter((r) => !NOT_SCOPED.includes(r) && !checks[r]).sort(), [], 'every admin route has an isolation check');
  for (const [route, check] of Object.entries(checks)) {
    if (routes.includes(route)) await check().catch((err) => { err.message = `${route}: ${err.message}`; throw err; });
  }
  // Nothing of org B changed.
  const p = await db('products').where({ id: B.product.id }).first();
  assert.equal(p.price, B.product.price);
  assert.equal(p.fit_offset, null);
  assert.equal((await db('order_returns').where({ order_id: B.order.id })).length, 0);
  assert.equal((await db('orders').where({ id: B.order.id }).first()).status, 'new');
  assert.equal((await db('admins').where({ id: B.member.id }).first()).disabled_at, null);
  assert.equal((await db('sync_keys').where({ id: B.key.id }).first()).revoked_at, null);
  assert.equal((await db('promo_codes').where({ id: B.promo.id }).first()).value, 10);
  assert.equal((await db('organizations').where({ id: orgB }).first()).cashback_percent, 5);
  const bStore = await db('stores').where({ id: b1 }).first();
  assert.equal(Boolean(bStore.mall_hidden), false);
  assert.equal(bStore.logo_url, null);
  assert.ok(await db('malls').where({ id: 1 }).first(), 'the demo mall is still there');
});

test('an owner works across every store of their organisation; a manager stays in one store', async () => {
  const [p2] = await db('products').where({ store_id: a1 }).limit(1);
  // a2 has no products yet: the owner adds one there by naming the store, and sees both stores' products.
  const r = await admin('POST', '/products', { name: 'Filial ko\'ylak', category: 'top', gender: 'unisex', color: 'oq', price: 90000, temp_min: 0, temp_max: 30, store_id: a2, stock: { M: 2 } }, ownerA);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const all = (await admin('GET', '/products?limit=100', undefined, ownerA)).body.items;
  assert.ok(all.some((p) => p.store_id === a1) && all.some((p) => p.store_id === a2));
  assert.equal((await admin('PATCH', `/stores/${a2}`, { delivery_fee: 5000 }, ownerA)).status, 200, 'owner edits any store of the organisation');
  // The manager of a2 sees only a2.
  const mine = (await admin('GET', '/products?limit=100', undefined, managerA2)).body.items;
  assert.ok(mine.length && mine.every((p) => p.store_id === a2));
  assert.equal((await admin('GET', `/products/${p2.id}`, undefined, managerA2)).status, 404);
  assert.equal((await admin('PATCH', `/stores/${a2}`, { delivery_fee: 1 }, managerA2)).status, 403);
  // The owner may invite a manager to either store, and disables managers of the organisation.
  const inv = await admin('POST', '/team/invites', { email: `a2.new${Date.now()}@smartfit.uz`, store_id: a2 }, ownerA);
  assert.equal(inv.status, 201);
  assert.equal(inv.body.organization_id, orgA);
  const mgr = await db('admins').where({ email: 'mgr.a2@smartfit.uz' }).first();
  assert.equal((await admin('GET', '/team', undefined, ownerA)).body.members.find((m) => m.id === mgr.id).can_manage, true);
});

test('migration 012: existing stores, owners, managers and invites land in one default organisation and stay reachable', async () => {
  const m = testDb();
  try {
    for (let i = 0; i < 11; i++) await m.migrate.up(); // up to 011_hardening
    const ins = async (t, row) => (await m(t).insert(row).returning('id'))[0].id;
    const s1 = await ins('stores', { name: 'Eski 1', city: 'Toshkent', lat: 41, lon: 69, address: 'A' });
    const s2 = await ins('stores', { name: 'Eski 2', city: 'Samarqand', lat: 39, lon: 66, address: 'B' });
    const { hashPassword } = await import('../src/admin/auth.js');
    const pw = await hashPassword('old-pass-12');
    await ins('admins', { email: 'super@old.uz', password_hash: pw, role: 'super', store_id: null });
    const own = await ins('admins', { email: 'own@old.uz', password_hash: pw, role: 'owner', store_id: s1 });
    await ins('admins', { email: 'mgr@old.uz', password_hash: pw, role: 'manager', store_id: s2 });
    await ins('admin_invites', { token_hash: 'a'.repeat(64), email: 'inv@old.uz', role: 'manager', store_id: s2, created_by: own, expires_at: new Date(Date.now() + 1e6).toISOString() });
    await ins('audit_log', { admin_id: own, admin_email: 'own@old.uz', store_id: s1, action: 'store.update', entity: 'store' });
    const [{ id: p }] = await m('products').insert({ store_id: s1, name: 'Ko\'ylak', category: 'top', gender: 'male', color: 'oq', price: 1000, temp_min: 0, temp_max: 30 }).returning('id');
    await m.migrate.up();
    const orgs = await m('organizations');
    assert.equal(orgs.length, 1, 'one default organisation');
    assert.ok((await m('stores')).every((s) => s.organization_id === orgs[0].id));
    const admins = await m('admins').orderBy('id');
    assert.deepEqual(admins.map((a) => [a.email, a.role, a.organization_id]), [['super@old.uz', 'super', null], ['own@old.uz', 'owner', orgs[0].id], ['mgr@old.uz', 'manager', orgs[0].id]]);
    assert.equal((await m('admin_invites').first()).organization_id, orgs[0].id);
    // The rebuild kept the links that point at admins (audit log) and products.
    assert.equal((await m('audit_log').first()).admin_id, own, 'audit rows still name their admin');
    assert.ok(await m('products').where({ id: p }).first());
    await assert.rejects(m('admins').insert({ email: 'dup@old.uz', password_hash: pw, role: 'manager', store_id: null, organization_id: orgs[0].id }), 'a manager still needs a store');
    await assert.rejects(m('admins').insert({ email: 'own@old.uz', password_hash: pw, role: 'super' }), 'email still unique');
    // An owner without a store is now allowed (made by an org invite).
    await m('admins').insert({ email: 'new.owner@old.uz', password_hash: pw, role: 'owner', organization_id: orgs[0].id });
    // Reachable through the API: the old owner signs in and sees both of their organisation's stores.
    await m.migrate.latest(); // the app runs on the current schema (task 36: categories)
    const app = createApp(m, { telegram: null }).listen(0);
    await new Promise((r) => app.once('listening', r));
    try {
      const url = `http://127.0.0.1:${app.address().port}/api/admin`;
      const post = (p, b, t) => fetch(url + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(t && { authorization: `Bearer ${t}` }) }, body: b && JSON.stringify(b) }).then((r) => r.json());
      const tok = (await post('/login', { email: 'own@old.uz', password: 'old-pass-12' })).token;
      assert.deepEqual((await post('/stores', undefined, tok)).map((s) => s.id).sort(), [s1, s2].sort());
      assert.equal((await post('/products', undefined, tok)).total, 1);
    } finally {
      app.close();
    }
    // Down: back to 011 shape (store-less owners go), and up again.
    for (let i = 26; i > 12; i--) await m.migrate.down(); // 026 … 013
    await m.migrate.down();
    assert.ok(!('organization_id' in (await m('stores').first())));
    assert.equal(await m('admins').where({ email: 'new.owner@old.uz' }).first(), undefined);
    assert.equal((await m('admins').count({ n: '*' }))[0].n, 3);
    assert.equal((await m('audit_log').first()).admin_id, own);
    await m.migrate.up();
    assert.equal((await m('organizations')).length, 1);
  } finally {
    await m.destroy();
  }
});

test('demo request form: validated, stored, rate-limited per IP, listed for the super-admin, sent to Telegram once', async () => {
  const ip = '203.0.113.7';
  const post = (b, lang) => call('POST', '/api/demo-requests' + (lang ? `?lang=${lang}` : ''), b, undefined, { ip });
  const ok = { name: 'Dilnoza', phone: '90 123 45 67', company: 'Moda Uz', city: 'Toshkent', stores: 3, message: 'Ikki filial bor' };
  const bad = await post({ ...ok, phone: '123' }, 'ru');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'phone');
  assert.match(bad.body.error, /Номер|номер/);
  const r = await post(ok);
  assert.equal(r.status, 201);
  assert.equal((await post({ ...ok, company: '' })).body.code, 'required', 'third request still counts against the limit');
  const r429 = await post(ok);
  assert.equal(r429.status, 429);
  assert.ok(Number(r429.headers.get('retry-after')) > 0);
  // Other IPs are not affected; validation per field.
  const other = (b) => call('POST', '/api/demo-requests', b, undefined, { ip: '203.0.113.8' });
  for (const [patch, code] of [[{ name: 'A' }, 'invalid'], [{ company: '' }, 'required'], [{ stores: 0 }, 'invalid']]) {
    assert.equal((await other({ ...ok, ...patch })).body.code, code, JSON.stringify(patch));
  }
  const row = await db('demo_requests').where({ id: r.body.id }).first();
  assert.deepEqual([row.phone, row.company, row.stores, row.lang, row.notified_at], ['+998901234567', 'Moda Uz', 3, 'uz', null]);
  // Super-admin sees and handles it; nobody else does.
  const list = await admin('GET', '/demo-requests', undefined, superToken);
  assert.equal(list.body.items[0].company, 'Moda Uz');
  assert.equal((await admin('PATCH', `/demo-requests/${r.body.id}`, { handled: true }, superToken)).status, 200);
  assert.equal((await db('audit_log').orderBy('id', 'desc').first()).action, 'demo.handle');
  assert.equal((await admin('GET', '/demo-requests', undefined, ownerA)).status, 403);
  // Telegram: nothing without a chat id; once with one; a failure is retried.
  const sent = [];
  const send = async (chat, text) => { sent.push([chat, text]); };
  await flushDemoRequests(db, send, '');
  assert.equal(sent.length, 0);
  await flushDemoRequests(db, async () => { throw Object.assign(new Error('down'), { code: 502 }); }, '12345');
  assert.equal((await db('demo_requests').where({ id: r.body.id }).first()).notified_at, null, 'retried next round');
  await flushDemoRequests(db, send, '12345');
  await flushDemoRequests(db, send, '12345');
  assert.equal(sent.length, 1, 'sent once');
  assert.equal(sent[0][0], 12345);
  assert.match(sent[0][1], /Moda Uz/);
  assert.match(sent[0][1], /\+998901234567/);
});

test('onboarding: super-admin creates an organisation and owner invite; the wizard makes a store that works', async () => {
  const org = await admin('POST', '/orgs', { name: 'Moda Uz', owner_email: 'Owner@Moda.uz' }, superToken);
  assert.equal(org.status, 201);
  assert.equal(org.body.invite.role, 'owner');
  assert.equal(org.body.invite.store_id, null);
  assert.equal((await admin('POST', '/orgs', { name: '', owner_email: 'x@moda.uz' }, superToken)).status, 400);
  const token = tokenOf(org.body.invite.url);
  assert.deepEqual((await admin('POST', '/invite/check', { token })).body, { email: 'owner@moda.uz', role: 'owner', store_name: null, org_name: 'Moda Uz' });
  const acc = await admin('POST', '/invite/accept', { token, password: 'moda-pass-1' });
  assert.equal(acc.status, 201);
  const owner = acc.body.token;
  assert.deepEqual([acc.body.admin.role, acc.body.admin.store_id, acc.body.admin.organization_id], ['owner', null, org.body.id]);
  // No store yet: nothing to see, and nothing leaks from other organisations.
  assert.deepEqual((await admin('GET', '/stores', undefined, owner)).body, []);
  assert.equal((await admin('GET', '/products', undefined, owner)).body.total, 0);
  assert.equal((await admin('GET', '/orders', undefined, owner)).body.total, 0);
  assert.equal((await admin('POST', '/sync-keys', { name: 'X' }, owner)).status, 400, 'needs a store first');
  // Step 1: the store profile.
  assert.equal((await admin('POST', '/stores', { ...STORE, lat: 200 }, owner)).status, 400);
  const s = await admin('POST', '/stores', { ...STORE, delivery_fee: 15000 }, owner);
  assert.equal(s.status, 201);
  assert.equal((await db('admins').where({ email: 'owner@moda.uz' }).first()).store_id, s.body.id, 'the first store becomes the owner\'s own');
  const listed = (await admin('GET', '/orgs', undefined, superToken)).body.find((o) => o.id === org.body.id);
  assert.deepEqual([listed.name, listed.stores, listed.admins, listed.invites], ['Moda Uz', 1, 1, 0]);
  // Step 2: the sample CSV as offered for download.
  const sample = await call('GET', '/admin/sample-products.csv');
  assert.equal(sample.status, 200);
  const csv = read('public/admin/sample-products.csv');
  const imp = await admin('POST', `/products/import?store_id=${s.body.id}`, undefined, owner, { raw: csv, type: 'text/csv' });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.created, 52);
  // Step 3: the QR for the phone app.
  const qr = await admin('GET', `/stores/${s.body.id}/qr`, undefined, owner);
  assert.match(qr.body.url, new RegExp(`/m\\?store=${s.body.id}$`));
  assert.match(qr.body.svg, /^<svg/);
  // The store works for customers: listed, and the kiosk gets 3 outfits from what was imported.
  assert.ok((await call('GET', '/api/stores')).body.some((x) => x.id === s.body.id));
  for (const gender of ['male', 'female']) {
    const rec = await call('POST', '/api/recommend', { store_id: s.body.id, gender, sizes: { top: 'M', bottom: 'M', shoes: '40' } });
    assert.equal(rec.status, 200, JSON.stringify(rec.body));
    assert.equal(rec.body.outfits.length, 3, gender);
    const ids = rec.body.outfits.flatMap((o) => o.items.map((i) => i.id));
    assert.equal(Number((await db('products').whereIn('id', ids).whereNot('store_id', s.body.id).count({ n: '*' }))[0].n), 0, 'only this store\'s items');
  }
  // The new organisation's owner sees none of the demo organisations' data, and they none of theirs.
  assert.equal((await admin('GET', `/stores/${s.body.id}`, undefined, ownerA)).status, 404);
  assert.equal((await admin('GET', `/stores/${a1}`, undefined, owner)).status, 404);
});

test('landing page: served at / under the CSP, its outfit card comes from the real engine', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  const html = await r.text();
  assert.match(html, /<link rel="stylesheet" href="\/shared\/ui\.css">/);
  assert.match(html, /href="\/kiosk\?store=1"/, 'kiosk demo link');
  assert.match(html, /href="\/m\?store=1"/, 'phone demo link');
  assert.match(html, /id="demoForm"/);
  assert.doesNotMatch(read('public/landing/landing.css'), /#[0-9a-f]{3,8}\b/i, 'colours only through ui.css tokens');
  for (const p of ['/landing/landing.js', '/landing/landing.css', '/landing/img/kiosk-start.jpg', '/landing/qr.svg', '/landing/looks/SF-TP-01.svg']) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
  const looks = await (await fetch(`${base}/landing/looks.json`)).json();
  assert.deepEqual(looks.map((l) => l.t), LANDING_TEMPS);
  assert.deepEqual(looks, landingLooks());
  for (const l of looks) {
    for (const c of requiredCategories(l.t, false)) assert.ok(l.items.some((i) => i.category === c), `${l.t}°: ${c}`);
    for (const i of l.items) assert.equal((await fetch(base + i.image)).status, 200, i.image);
  }
});
