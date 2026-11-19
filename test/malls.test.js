// Task 37: shopping malls. Super-only mall CRUD; the mall role reaches only its own mall's routes (route walk) and
// sees summary numbers only; a shop invited by a mall lands in it; the public directory and search show only the
// mall's shown shops and in-stock items; a cart never mixes two shops; migration 024 up and down.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDb, isPg } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed, DEMO_MALL } from '../src/db/seed.js';
import { createAdmin, createAdminRouter, MALL_ROUTES } from '../src/admin/routes.js';
import { dbTime } from '../src/recommend/routes.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, uploadDir, s1, s2, s3, mallA, mallB, superToken, ownerA, managerA, mallTokenA, mallTokenB;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
// Task 44: a PNG header with a real IHDR size (width × height), enough for the plan's size check.
const planPng = (w, h) => { const b = Buffer.alloc(33); png.copy(b, 0, 0, 8); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };

const call = async (method, p, body, token, { raw, type } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': type || 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
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
const STORE = { name: 'Boshqa markaz do\'koni', city: 'Toshkent', address: 'Navoiy 5', lat: 41.3, lon: 69.25 };

before(async () => {
  await db.migrate.latest();
  await seed(db); // two demo shops, both in the demo mall
  [s1, s2] = (await db('stores').orderBy('id')).map((s) => s.id);
  mallA = (await db('malls').first()).id;
  [{ id: mallB }] = await db('malls').insert({ name: 'Ikkinchi markaz', city: 'Toshkent', address: 'Navoiy 5' }).returning('id');
  // s3: a store of the first shop's organisation, in mall B, with one item in stock.
  const orgA = (await db('stores').where({ id: s1 }).first()).organization_id;
  [{ id: s3 }] = await db('stores').insert({ ...STORE, organization_id: orgA, mall_id: mallB }).returning('id');
  const { id: _, created_at, updated_at, ...p } = await db('products').where({ store_id: s1, category: 'top' }).orderBy('id').first();
  const [{ id: p3 }] = await db('products').insert({ ...p, store_id: s3, sku: null, name: 'Faqat B markazda' }).returning('id');
  await db('product_stock').insert({ product_id: p3, size: 'M', quantity: 2 });
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  await createAdmin(db, { email: 'owner.a@smartfit.uz', password: 'owner-pass-1', storeId: s1 });
  await createAdmin(db, { email: 'mgr.a@smartfit.uz', password: 'mgr-pass-1', storeId: s1, role: 'manager' });
  await createAdmin(db, { email: 'mall.a@smartfit.uz', password: 'mall-pass-1', mallId: mallA });
  await createAdmin(db, { email: 'mall.b@smartfit.uz', password: 'mall-pass-2', mallId: mallB });
  uploadDir = await mkdtemp(path.join(tmpdir(), 'sf-malls-'));
  server = createApp(db, { uploadDir, telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  superToken = await login('boss@smartfit.uz', 'boss-pass-1');
  ownerA = await login('owner.a@smartfit.uz', 'owner-pass-1');
  managerA = await login('mgr.a@smartfit.uz', 'mgr-pass-1');
  mallTokenA = await login('mall.a@smartfit.uz', 'mall-pass-1');
  mallTokenB = await login('mall.b@smartfit.uz', 'mall-pass-2');
});
after(async () => {
  server.close();
  await db.destroy();
  await rm(uploadDir, { recursive: true, force: true });
});

// A paid (or not) pickup order in `store`. → the order
async function order(store, { paid = true } = {}) {
  const p = await db('products').where({ store_id: store, category: 'top' }).orderBy('id').first();
  await db('product_stock').where({ product_id: p.id, size: 'M' }).update({ quantity: 50, reserved: 0 });
  const cart = await call('POST', '/api/cart/items', { store_id: store, items: [{ product_id: p.id, size: 'M' }] });
  const r = await call('POST', `/api/cart/${cart.body.token}/checkout`, { fulfillment: 'pickup', name: 'Malika Karimova', phone: '+998935554433' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (paid) await db('orders').where({ id: r.body.order.id }).update({ payment_status: 'paid', paid_at: new Date().toISOString() });
  return r.body.order;
}

test('seed: one demo mall holds both demo shops', async () => {
  const m = await db('malls').where({ id: mallA }).first();
  assert.equal(m.name, DEMO_MALL.name);
  assert.deepEqual((await db('stores').where({ mall_id: mallA }).orderBy('id')).map((s) => s.id), [s1, s2]);
  assert.equal((await call('GET', `/kiosk?mall=${mallA}`)).status, 200);
  const manifest = (await call('GET', `/kiosk.webmanifest?mall=${mallA}`)).body;
  assert.equal(manifest.start_url, `/kiosk?mall=${mallA}`);
  assert.equal((await call('GET', '/kiosk.webmanifest?store=1&mall=1')).body.start_url, '/kiosk?store=1', 'a shop kiosk starts at its shop');
});

test('mall CRUD by super only: create with an admin link, edit, shops in and out, delete only when empty', async () => {
  const body = { name: 'Riviera test', city: 'Toshkent', address: 'Nurafshon 2', lat: 41.33, lon: 69.3, admin_email: 'riviera@smartfit.uz' };
  for (const tok of [ownerA, managerA, mallTokenA]) {
    assert.equal((await admin('GET', '/malls', undefined, tok)).status, 403);
    assert.equal((await admin('POST', '/malls', body, tok)).status, 403);
    assert.equal((await admin('PATCH', `/malls/${mallA}`, { name: 'X' }, tok)).status, 403);
    assert.equal((await admin('DELETE', `/malls/${mallB}`, undefined, tok)).status, 403);
    assert.equal((await admin('POST', `/malls/${mallA}/invites`, { email: 'z@smartfit.uz' }, tok)).status, 403);
  }
  assert.equal((await admin('POST', '/malls', { ...body, lon: null }, superToken)).status, 400, 'map point: both or neither');
  assert.equal((await admin('POST', '/malls', { ...body, name: ' ' }, superToken)).status, 400);
  assert.equal((await admin('POST', '/malls', { ...body, admin_email: 'nope' }, superToken)).status, 400);
  const r = await admin('POST', '/malls', body, superToken);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  assert.equal(r.body.invite.role, 'mall');
  // The link signs in a mall admin of this mall.
  const tok = tokenOf(r.body.invite.url);
  assert.deepEqual((await admin('POST', '/invite/check', { token: tok })).body, { email: 'riviera@smartfit.uz', role: 'mall', store_name: null, org_name: null, mall_name: 'Riviera test' });
  const acc = await admin('POST', '/invite/accept', { token: tok, password: 'riviera-pass-1' });
  assert.equal(acc.status, 201);
  assert.deepEqual(acc.body.admin, { id: acc.body.admin.id, email: 'riviera@smartfit.uz', role: 'mall', store_id: null, organization_id: null, mall_id: id });
  assert.equal((await admin('GET', '/mall', undefined, acc.body.token)).body.mall.name, 'Riviera test');
  // List with stores and admins.
  const list = (await admin('GET', '/malls', undefined, superToken)).body;
  assert.deepEqual(list.find((m) => m.id === mallA).stores.map((s) => s.id).sort(), [s1, s2].sort());
  assert.deepEqual(list.find((m) => m.id === id).admins.map((a) => a.email), ['riviera@smartfit.uz']);
  // A store already in another mall can't join; a free one can, and leaving clears its floor and unit.
  const taken = await admin('PATCH', `/malls/${id}`, { store_ids: [s3] }, superToken);
  assert.equal(taken.status, 409);
  assert.equal(taken.body.code, 'store_in_mall');
  const [{ id: free }] = await db('stores').insert({ ...STORE, name: 'Erkin', organization_id: (await db('stores').where({ id: s2 }).first()).organization_id }).returning('id');
  assert.equal((await admin('PATCH', `/malls/${id}`, { store_ids: [free], city: 'Tashkent' }, superToken)).status, 200);
  assert.equal((await db('stores').where({ id: free }).first()).mall_id, id);
  assert.equal((await db('malls').where({ id }).first()).city, 'Tashkent');
  await db('stores').where({ id: free }).update({ mall_floor: '3' });
  assert.equal((await admin('PATCH', `/malls/${id}`, { store_ids: 'x' }, superToken)).status, 400);
  assert.equal((await admin('PATCH', `/malls/${id}`, { store_ids: [999999] }, superToken)).status, 400);
  // Not empty → 409; empty → gone with its admins.
  const busy = await admin('DELETE', `/malls/${id}`, undefined, superToken);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'mall_in_use');
  assert.equal((await admin('PATCH', `/malls/${id}`, { store_ids: [] }, superToken)).status, 200);
  const left = await db('stores').where({ id: free }).first();
  assert.deepEqual([left.mall_id, left.mall_floor], [null, null]);
  assert.equal((await admin('DELETE', `/malls/${id}`, undefined, superToken)).status, 204);
  assert.equal(await db('malls').where({ id }).first(), undefined);
  assert.equal(await db('admins').where({ email: 'riviera@smartfit.uz' }).first(), undefined);
  assert.equal((await admin('GET', '/mall', undefined, acc.body.token)).status, 401, 'its admin is out');
  assert.equal((await admin('DELETE', `/malls/${id}`, undefined, superToken)).status, 404);
  // Another admin link for an existing mall.
  const inv = await admin('POST', `/malls/${mallB}/invites`, { email: 'second.b@smartfit.uz' }, superToken);
  assert.equal(inv.status, 201);
  assert.equal((await db('admin_invites').where({ id: inv.body.id }).first()).mall_id, mallB);
  // The CHECKs: a mall admin has a mall and nothing else.
  await assert.rejects(db('admins').insert({ email: 'bad1@smartfit.uz', password_hash: 'x', role: 'mall' }));
  await assert.rejects(db('admins').insert({ email: 'bad2@smartfit.uz', password_hash: 'x', role: 'mall', mall_id: mallA, store_id: s1, organization_id: 1 }));
});

// The route walk: every admin route, called with a mall admin's token. Only the mall routes answer; every product,
// order, customer, team and settings route is 403 before it runs (nothing written). A new admin route is closed to
// the mall role automatically unless it is listed in MALL_ROUTES.
test('route walk: a mall admin reaches only their own mall; every shop data route is 403, another mall 404', async () => {
  const o = await order(s1);
  const product = await db('products').where({ store_id: s1 }).first();
  const ids = { '/products/:id': product.id, '/orders/:id': o.id, '/fitting/:id': 1, '/stores/:id': s1, '/team/:id': 1, '/team/invites/:id': 1, '/sync-keys/:id': 1,
    '/promos/:id': 1, '/demo-requests/:id': 1, '/categories/:id': 1, '/malls/:id': mallB };
  // Task 43: an offer of shop s1 waiting for mall A, and one of s3 waiting for mall B.
  const offer = async (store, mall, title) => (await db('offers').insert({ organization_id: (await db('stores').where({ id: store }).first()).organization_id, store_id: store, mall_id: mall,
    title, title_ru: title, starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 86400000).toISOString(), image_url: '/uploads/offers/x.png', status: 'submitted' }).returning('id'))[0].id;
  const offerA = await offer(s1, mallA, 'A aksiya'), offerB = await offer(s3, mallB, 'B aksiya');
  ids['/offers/:id'] = offerA;
  // Task 44: a floor of each mall (mall A's from the seed) and mall A's kiosk spot.
  const floorA = (await db('mall_floors').where({ mall_id: mallA }).orderBy('id').first()).id;
  const [{ id: floorB }] = await db('mall_floors').insert({ mall_id: mallB, name: '3', plan_url: '/uploads/malls/b.png', plan_w: 10, plan_h: 10 }).returning('id');
  const spotA = (await db('mall_spots').where({ mall_id: mallA }).first()).id;
  const [{ id: spotB }] = await db('mall_spots').insert({ mall_id: mallB, floor_id: floorB, label: 'B kiosk', x: 1, y: 1 }).returning('id');
  const fill = (p) => p.replace(/^(\/[a-z-]+(?:\/invites)?)\/:id/, (m, head) => `${head}/${ids[`${head}/:id`]}`).replace('/mall/stores/:id', `/mall/stores/${s1}`).replace('/mall/offers/:id', `/mall/offers/${offerA}`)
    .replace('/mall/floors/:id', `/mall/floors/${floorA}`).replace('/mall/spots/:id', `/mall/spots/${spotA}`);
  const PUBLIC = ['POST /login', 'POST /invite/check', 'POST /invite/accept'];
  const ALLOWED = {
    'GET /me': async () => assert.equal((await admin('GET', '/me', undefined, mallTokenA)).body.mall_id, mallA),
    'POST /me/password': async () => {
      const r = await admin('POST', '/me/password', { current: 'mall-pass-1', password: 'mall-pass-1b' }, mallTokenA);
      assert.equal(r.status, 200);
      mallTokenA = r.body.token;
    },
    'GET /mall': async () => {
      const r = await admin('GET', '/mall', undefined, mallTokenA);
      assert.equal(r.body.mall.id, mallA);
      assert.deepEqual(r.body.shops.map((s) => s.id).sort(), [s1, s2].sort(), 'its own shops only');
    },
    'PATCH /mall': async () => {
      assert.equal((await admin('PATCH', '/mall', { name: 'Demo markaz', id: mallB }, mallTokenA)).body.id, mallA, 'always its own mall');
      assert.equal((await db('malls').where({ id: mallB }).first()).name, 'Ikkinchi markaz');
    },
    'GET /mall/qr': async () => {
      const r = await admin('GET', '/mall/qr', undefined, mallTokenA);
      assert.match(r.body.url, new RegExp(`/m\\?mall=${mallA}$`));
      assert.match(r.body.kiosk_url, new RegExp(`/kiosk\\?mall=${mallA}$`));
      assert.match(r.body.svg, /^<svg/);
    },
    'POST /mall/logo': async () => {
      const r = await admin('POST', '/mall/logo', undefined, mallTokenA, { raw: png, type: 'image/png' });
      assert.match(r.body.logo_url, /^\/uploads\/malls\/m\d+-[0-9a-f]{16}\.png$/);
      assert.equal((await admin('POST', '/mall/logo', undefined, mallTokenA, { raw: Buffer.from('<svg/>'), type: 'image/svg+xml' })).status, 400, 'magic bytes only');
    },
    'DELETE /mall/logo': async () => assert.equal((await admin('DELETE', '/mall/logo', undefined, mallTokenA)).status, 204),
    'POST /mall/shops': async () => assert.equal((await admin('POST', '/mall/shops', { name: 'Walk shop', owner_email: 'walk.shop@smartfit.uz' }, mallTokenA)).status, 201),
    'PATCH /mall/stores/:id': async () => {
      assert.equal((await admin('PATCH', `/mall/stores/${s1}`, { floor: '1', unit: '104' }, mallTokenA)).status, 200);
      assert.equal((await admin('PATCH', `/mall/stores/${s3}`, { hidden: true }, mallTokenA)).status, 404, 'a store of another mall');
      assert.equal((await admin('PATCH', `/mall/stores/${s1}`, { hidden: true }, mallTokenB)).status, 404, 'mall B never reaches mall A');
      assert.equal((await admin('PATCH', `/mall/stores/${s1}`, { hidden: 'yes' }, mallTokenA)).status, 400);
      assert.equal((await admin('PATCH', `/mall/stores/${s1}`, { floor: 'x'.repeat(21) }, mallTokenA)).status, 400);
    },
    'POST /mall/stores/:id/logo': async () => {
      assert.equal((await admin('POST', `/mall/stores/${s1}/logo`, undefined, mallTokenA, { raw: png, type: 'image/png' })).status, 200);
      assert.equal((await admin('POST', `/mall/stores/${s3}/logo`, undefined, mallTokenA, { raw: png, type: 'image/png' })).status, 404);
    },
    // Task 43: what shops submitted to this mall; another mall's offer is 404 both ways.
    'GET /mall/offers': async () => {
      const r = (await admin('GET', '/mall/offers', undefined, mallTokenA)).body.offers.map((o) => o.id);
      assert.ok(r.includes(offerA) && !r.includes(offerB), 'its own mall\'s offers only (and the seed\'s demo ones)');
      assert.deepEqual((await admin('GET', '/mall/offers', undefined, mallTokenB)).body.offers.map((o) => o.id), [offerB]);
    },
    'POST /mall/offers/:id/approve': async () => {
      assert.equal((await admin('POST', `/mall/offers/${offerB}/approve`, undefined, mallTokenA)).status, 404, 'another mall\'s offer');
      assert.equal((await admin('POST', `/mall/offers/${offerA}/approve`, undefined, mallTokenB)).status, 404, 'mall B never reaches mall A');
      assert.equal((await admin('POST', `/mall/offers/${offerA}/approve`, undefined, mallTokenA)).body.status, 'approved');
    },
    'POST /mall/offers/:id/reject': async () => {
      assert.equal((await admin('POST', `/mall/offers/${offerB}/reject`, { reason: 'Yo\'q' }, mallTokenA)).status, 404);
      assert.equal((await admin('POST', `/mall/offers/${offerA}/reject`, {}, mallTokenA)).status, 400, 'a reason is required');
      assert.equal((await admin('POST', `/mall/offers/${offerA}/reject`, { reason: 'Rasm xira' }, mallTokenA)).body.status, 'rejected');
      assert.equal((await db('offers').where({ id: offerB }).first()).status, 'submitted');
    },
    'PATCH /mall/slides': async () => {
      assert.equal((await admin('PATCH', '/mall/slides', { seconds: 3 }, mallTokenA)).status, 400);
      assert.equal((await admin('PATCH', '/mall/slides', { order: [offerB] }, mallTokenA)).status, 400, 'not its offer');
      assert.equal((await admin('PATCH', '/mall/slides', { seconds: 12 }, mallTokenA)).body.seconds, 12);
      assert.equal((await db('malls').where({ id: mallB }).first()).slide_seconds, 8);
    },
    // Task 44: the map. Mall A's admin reaches only mall A's floors, spots and shops; mall B's are 404 both ways.
    // Task 53: analytics of their own mall only (mall-stats.test.js has the numbers).
    'GET /mall/stats': async () => {
      await db('mall_stats').insert({ mall_id: mallB, day: new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10), hour: 1, kind: 'visit', channel: 'phone', word: '', n: 9 });
      assert.equal((await admin('GET', '/mall/stats', undefined, mallTokenA)).body.totals.visits, 0);
      assert.equal((await admin('GET', '/mall/stats', undefined, mallTokenB)).body.totals.visits, 9);
    },
    'GET /mall/stats/export': async () => assert.equal((await admin('GET', '/mall/stats/export', undefined, mallTokenA)).status, 200),
    'GET /mall/map': async () => {
      const r = (await admin('GET', '/mall/map', undefined, mallTokenA)).body;
      assert.ok(r.floors.every((f) => f.id !== floorB) && r.spots.every((k) => k.id !== spotB) && r.shops.every((s) => s.id !== s3));
      assert.deepEqual((await admin('GET', '/mall/map', undefined, mallTokenB)).body.spots.map((k) => k.id), [spotB]);
    },
    'POST /mall/floors/:id/plan': async () => {
      assert.equal((await admin('POST', `/mall/floors/${floorB}/plan`, undefined, mallTokenA, { raw: planPng(100, 50), type: 'image/png' })).status, 404, 'another mall\'s floor');
      assert.equal((await admin('POST', `/mall/floors/${floorA}/plan`, undefined, mallTokenB, { raw: planPng(100, 50), type: 'image/png' })).status, 404);
      assert.equal((await admin('POST', `/mall/floors/${floorA}/plan`, undefined, mallTokenA, { raw: planPng(100, 50), type: 'image/png' })).body.plan_w, 100);
    },
    'DELETE /mall/floors/:id/plan': async () => {
      assert.equal((await admin('DELETE', `/mall/floors/${floorB}/plan`, undefined, mallTokenA)).status, 404);
      assert.equal((await db('mall_floors').where({ id: floorB }).first()).plan_url, '/uploads/malls/b.png');
    },
    'POST /mall/spots': async () => {
      assert.equal((await admin('POST', '/mall/spots', { floor_id: floorB, label: 'X', pin: { x: 1, y: 1 } }, mallTokenA)).status, 400, 'another mall\'s floor');
      assert.equal((await admin('POST', '/mall/spots', { floor_id: floorA, label: 'Walk', pin: { x: 10, y: 20 } }, mallTokenA)).status, 201);
    },
    'PATCH /mall/spots/:id': async () => {
      assert.equal((await admin('PATCH', `/mall/spots/${spotB}`, { label: 'X' }, mallTokenA)).status, 404);
      assert.equal((await admin('PATCH', `/mall/spots/${spotA}`, { label: 'X' }, mallTokenB)).status, 404);
      assert.equal((await admin('PATCH', `/mall/spots/${spotA}`, { floor_id: floorB }, mallTokenB)).status, 404);
      assert.equal((await db('mall_spots').where({ id: spotB }).first()).label, 'B kiosk');
    },
    'DELETE /mall/spots/:id': async () => {
      assert.equal((await admin('DELETE', `/mall/spots/${spotB}`, undefined, mallTokenA)).status, 404);
      assert.ok(await db('mall_spots').where({ id: spotB }).first());
    },
    'DELETE /mall/stores/:id/logo': async () => {
      assert.equal((await admin('DELETE', `/mall/stores/${s3}/logo`, undefined, mallTokenA)).status, 404);
      assert.equal((await admin('DELETE', `/mall/stores/${s1}/logo`, undefined, mallTokenA)).status, 204);
    },
  };
  const routes = createAdminRouter(db).stack.filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).filter((m) => m !== '_all' && m !== 'head').map((m) => [m.toUpperCase(), l.route.path]));
  const names = routes.map(([m, p]) => `${m} ${p}`);
  for (const r of Object.keys(ALLOWED)) assert.ok(names.includes(r), `${r} exists`);
  // The gate's patterns allow exactly these routes, no more.
  assert.deepEqual(routes.filter(([m, p]) => MALL_ROUTES.some((re) => re.test(`${m} ${fill(p)}`))).map(([m, p]) => `${m} ${p}`).sort(), Object.keys(ALLOWED).sort());

  const auditBefore = (await db('audit_log').max({ id: 'id' }))[0].id;
  const snapshot = async () => JSON.stringify([await db('products').where({ id: product.id }).first(), await db('stores').whereIn('id', [s1, s3]).orderBy('id'),
    await db('orders').where({ id: o.id }).first('status', 'payment_status'), await db('malls').where({ id: mallB }).first()]);
  const was = await snapshot();
  let refused = 0;
  for (const [m, p] of routes) {
    const name = `${m} ${p}`;
    if (PUBLIC.includes(name) || ALLOWED[name]) continue;
    const r = await admin(m, fill(p), m === 'GET' ? undefined : { name: 'X', price: 1, status: 'cancelled', disabled: true, email: 'x@smartfit.uz', role: 'owner', code: 'MALL1', kind: 'percent', value: 50, handled: true, store_ids: [] }, mallTokenA);
    assert.equal(r.status, 403, `${name} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    assert.equal(r.body.code, 'forbidden');
    refused++;
  }
  assert.ok(refused > 50, `walked ${refused} refused routes`);
  assert.equal(await snapshot(), was, 'nothing changed');
  assert.equal((await db('audit_log').max({ id: 'id' }))[0].id, auditBefore, 'no audit row: nothing ran');
  for (const [route, check] of Object.entries(ALLOWED)) await check().catch((err) => { err.message = `${route}: ${err.message}`; throw err; });
});

test('mall dashboard: per-shop summary numbers only (visits, paid orders, kiosks online), never sums, prices or customers', async () => {
  await db('funnel_events').del();
  await db('kiosks').del();
  await db('orders').update({ payment_status: 'cancelled' });
  const at = (ms) => (isPg() ? dbTime(ms) : dbTime(ms).slice(0, 19));
  await db('funnel_events').insert([
    { store_id: s1, visit: 'a'.repeat(32), step: 'start', device: 'k'.repeat(32) },
    { store_id: s1, visit: 'a'.repeat(32), step: 'size', device: 'k'.repeat(32) },
    { store_id: s1, visit: 'b'.repeat(32), step: 'start', device: null },
    { store_id: s1, visit: 'c'.repeat(32), step: 'start', device: null, created_at: at(Date.now() - 10 * 86400000) }, // outside 7 days
    { store_id: s2, visit: 'd'.repeat(32), step: 'start', device: null },
    { store_id: s3, visit: 'e'.repeat(32), step: 'start', device: null }, // mall B
  ].map((e) => ({ created_at: at(Date.now() - 60000), ...e })));
  await order(s1);
  await order(s1);
  await order(s1, { paid: false });
  const cancelled = await order(s2);
  await db('orders').where({ id: cancelled.id }).update({ status: 'cancelled' });
  await order(s3);
  await db('kiosks').insert([
    { store_id: s1, device: '1'.repeat(32), last_seen_at: new Date().toISOString() },
    { store_id: s1, device: '2'.repeat(32), last_seen_at: new Date(Date.now() - 3600000).toISOString() },
    { store_id: s3, device: '3'.repeat(32), last_seen_at: new Date().toISOString() },
  ]);
  const r = await admin('GET', '/mall', undefined, mallTokenA);
  assert.equal(r.status, 200);
  const one = r.body.shops.find((s) => s.id === s1), two = r.body.shops.find((s) => s.id === s2);
  assert.deepEqual([one.visits, one.orders, one.kiosks], [{ kiosk: 1, phone: 1 }, 2, { count: 2, online: 1 }]);
  assert.deepEqual([two.visits, two.orders, two.kiosks], [{ kiosk: 0, phone: 1 }, 0, { count: 0, online: 0 }]);
  assert.deepEqual(r.body.totals, { shops: 2, visits: 3, kiosk_visits: 1, orders: 2, kiosks_online: 1, mall_outfits: 0 }); // task 42: the mall outfit screens count
  assert.equal((await admin('GET', '/mall?days=30', undefined, mallTokenA)).body.shops.find((s) => s.id === s1).visits.kiosk + 1, 2);
  assert.equal((await admin('GET', '/mall?days=30', undefined, mallTokenA)).body.shops.find((s) => s.id === s1).visits.phone, 2, 'the older visit is in 30 days');
  // Nothing of a shop's business beyond the counts: no money, prices, products, customers or team.
  const text = JSON.stringify(r.body);
  for (const bad of ['Malika', '+99893', 'revenue', 'price', 'subtotal', '"total":', 'phone":"+', 'email', 'sku', 'customer']) assert.ok(!text.includes(bad), `no ${bad} in ${text.slice(0, 300)}`);
  // Mall B sees only its own store.
  const b = (await admin('GET', '/mall', undefined, mallTokenB)).body;
  assert.deepEqual(b.shops.map((s) => [s.id, s.orders, s.kiosks.online]), [[s3, 1, 1]]);
});

test('inviting a shop puts it in the mall: org + owner link, its first store joins, later ones do not', async () => {
  assert.equal((await admin('POST', '/mall/shops', { name: '', owner_email: 'a@b.uz' }, mallTokenA)).status, 400);
  assert.equal((await admin('POST', '/mall/shops', { name: 'Kids', owner_email: 'owner.a@smartfit.uz' }, mallTokenA)).status, 409, 'email taken');
  const r = await admin('POST', '/mall/shops', { name: 'Bolajon kiyimlari', owner_email: 'bolajon@smartfit.uz' }, mallTokenA);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const org = await db('organizations').where({ id: r.body.organization_id }).first();
  assert.equal(org.mall_id, mallA);
  assert.equal((await db('categories').where({ organization_id: org.id })).length, 5, 'the five built-in categories');
  let dash = (await admin('GET', '/mall', undefined, mallTokenA)).body;
  assert.deepEqual(dash.pending.find((p) => p.organization_id === org.id), { organization_id: org.id, name: 'Bolajon kiyimlari', invite_open: true });
  assert.ok(!(await admin('GET', '/mall', undefined, mallTokenB)).body.pending.some((p) => p.organization_id === org.id), 'not in mall B');
  // The owner accepts, makes the first store in the wizard: it is in the mall.
  const acc = await admin('POST', '/invite/accept', { token: tokenOf(r.body.invite.url), password: 'bolajon-pass-1' });
  assert.equal(acc.status, 201);
  assert.equal(acc.body.admin.organization_id, org.id);
  const owner = acc.body.token;
  const first = await admin('POST', '/stores', { ...STORE, name: 'Bolajon Demo' }, owner);
  assert.equal(first.status, 201);
  assert.equal(first.body.mall_id, mallA);
  const second = await admin('POST', '/stores', { ...STORE, name: 'Bolajon Chilonzor' }, owner);
  assert.equal(second.body.mall_id, null, 'a later store may be anywhere');
  dash = (await admin('GET', '/mall', undefined, mallTokenA)).body;
  assert.ok(dash.shops.some((s) => s.id === first.body.id && s.org_name === 'Bolajon kiyimlari'));
  assert.ok(!dash.pending.some((p) => p.organization_id === org.id));
  // The new owner sees only their own stores, never the other shops of the mall.
  assert.deepEqual((await admin('GET', '/stores', undefined, owner)).body.map((s) => s.id).sort(), [first.body.id, second.body.id].sort());
  assert.equal((await admin('GET', `/products?store_id=${s1}`, undefined, owner)).body.total, 0);
  // An organisation super made without a mall: its store is in no mall.
  const plain = await admin('POST', '/orgs', { name: 'Mustaqil', owner_email: 'mustaqil@smartfit.uz' }, superToken);
  const ownerP = (await admin('POST', '/invite/accept', { token: tokenOf(plain.body.invite.url), password: 'mustaqil-pass-1' })).body.token;
  assert.equal((await admin('POST', '/stores', { ...STORE, name: 'Mustaqil 1' }, ownerP)).body.mall_id, null);
  // Clean up: these stores would show in the directory tests below.
  await db('stores').whereIn('id', [first.body.id, second.body.id]).update({ mall_id: null });
});

test('directory: only the shown shops of that mall, with floor, unit, logo and shown categories; nothing else of the shop', async () => {
  await db('stores').where({ id: s1 }).update({ mall_floor: '1', mall_unit: '104', mall_hidden: false });
  await db('stores').where({ id: s2 }).update({ mall_hidden: false });
  const orgA = (await db('stores').where({ id: s1 }).first()).organization_id;
  const hiddenCat = await db('categories').where({ organization_id: orgA }).orderBy('sort', 'desc').first();
  await db('categories').where({ id: hiddenCat.id }).update({ hidden: true });
  let r = await call('GET', `/api/malls/${mallA}`);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['address', 'city', 'floors', 'id', 'logo_url', 'name', 'shops', 'spots']); // task 44: floors, spots
  assert.deepEqual(r.body.shops.map((s) => s.id).sort(), [s1, s2].sort());
  const one = r.body.shops.find((s) => s.id === s1);
  assert.deepEqual(Object.keys(one).sort(), ['categories', 'closes_at', 'floor', 'id', 'logo_url', 'name', 'opens_at', 'pin', 'unit']); // task 44: hours, pin
  assert.deepEqual([one.floor, one.unit], ['1', '104']);
  assert.equal(one.categories.length, 8, 'hidden categories are not shown'); // task 40: 5 adult + 4 children's, one hidden
  assert.ok(!one.categories.some((c) => c.id === hiddenCat.id));
  assert.deepEqual(Object.keys(one.categories[0]).sort(), ['id', 'image_url', 'name', 'name_ru']);
  // A hidden shop is gone from the directory; a store of mall B never shows here.
  assert.equal((await admin('PATCH', `/mall/stores/${s2}`, { hidden: true }, mallTokenA)).status, 200);
  r = await call('GET', `/api/malls/${mallA}`);
  assert.deepEqual(r.body.shops.map((s) => s.id), [s1]);
  assert.deepEqual((await call('GET', `/api/malls/${mallB}`)).body.shops.map((s) => s.id), [s3]);
  for (const bad of ['999999', '99999999999', 'abc', '1.5', '-1']) assert.equal((await call('GET', `/api/malls/${bad}`)).status, 404, bad);
  assert.equal((await admin('PATCH', '/mall/stores/99999999999', { hidden: true }, mallTokenA)).status, 404);
  assert.equal((await admin('PATCH', '/malls/99999999999', { name: 'X' }, superToken)).status, 404);
  // The shop's own pages stay public as before.
  assert.equal((await call('GET', `/api/stores/${s2}`)).status, 200);
  await db('stores').where({ id: s2 }).update({ mall_hidden: false });
  await db('categories').where({ id: hiddenCat.id }).update({ hidden: false });
});

test('mall search: only stock > 0 items of the mall\'s shown shops and shown categories, with only the free sizes', async () => {
  const search = (q, id = mallA) => call('GET', `/api/malls/${id}/search?q=${encodeURIComponent(q)}`);
  let r = await search('sviter');
  assert.equal(r.status, 200);
  assert.ok(r.body.items.length >= 2);
  assert.ok(r.body.items.every((p) => [s1, s2].includes(p.store_id) && p.sizes.length && p.store_name), 'mall A shops only, in stock');
  assert.ok(r.body.items.some((p) => p.store_id === s1) && r.body.items.some((p) => p.store_id === s2), 'across shops');
  const hit = r.body.items.find((p) => p.store_id === s1);
  assert.deepEqual([hit.floor, hit.unit], ['1', '104']);
  // Sold out everywhere → gone; one size left → only that size.
  await db('product_stock').where({ product_id: hit.id }).update({ quantity: 0, reserved: 0 });
  assert.ok(!(await search('sviter')).body.items.some((p) => p.id === hit.id), 'stock 0 is never shown');
  await db('product_stock').where({ product_id: hit.id, size: 'L' }).update({ quantity: 2, reserved: 1 });
  assert.deepEqual((await search('sviter')).body.items.find((p) => p.id === hit.id).sizes, ['L']);
  await db('product_stock').where({ product_id: hit.id, size: 'L' }).update({ reserved: 2 });
  assert.ok(!(await search('sviter')).body.items.some((p) => p.id === hit.id), 'reserved units are not free');
  // Mall B's item only in mall B.
  assert.equal((await search('Faqat B')).body.items.length, 0);
  assert.equal((await search('Faqat B', mallB)).body.items[0].store_id, s3);
  // By category name, in Russian too; a hidden category or a hidden shop is not searched.
  const orgB = (await db('stores').where({ id: s2 }).first()).organization_id;
  const shoes = await db('categories').where({ organization_id: orgB, role: 'shoes' }).first();
  assert.ok((await search(shoes.name_ru)).body.items.some((p) => p.store_id === s2 && p.category_id === shoes.id));
  await db('categories').where({ id: shoes.id }).update({ hidden: true });
  assert.ok(!(await search(shoes.name_ru)).body.items.some((p) => p.category_id === shoes.id));
  await db('categories').where({ id: shoes.id }).update({ hidden: false });
  await db('stores').where({ id: s2 }).update({ mall_hidden: true });
  assert.ok(!(await search('sviter')).body.items.some((p) => p.store_id === s2));
  await db('stores').where({ id: s2 }).update({ mall_hidden: false });
  // Gender, and the input checks.
  assert.ok((await call('GET', `/api/malls/${mallA}/search?q=ko&gender=female`)).body.items.every((p) => ['female', 'unisex'].includes(p.gender)));
  assert.equal((await call('GET', `/api/malls/${mallA}/search?q=ko&gender=x`)).status, 400);
  assert.equal((await call('GET', `/api/malls/${mallA}/search?q=a&q=b`)).status, 400);
  assert.deepEqual((await search('k')).body.items, [], 'two letters at least');
  assert.equal((await search('%')).status, 200);
  assert.equal((await search('sviter', 999999)).status, 404);
  assert.ok((await search('a'.repeat(30))).body.items.length === 0);
});

test('the mall screen is rate-limited like the other public routes', async () => {
  const app = createApp(db, { telegram: null, stylist: null, limits: { mall: 2 }, weather: async () => ({ temperature: 15, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => app.once('listening', r));
  try {
    const url = `http://127.0.0.1:${app.address().port}/api/malls/${mallA}`;
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(i === 1 ? `${url}/search?q=sv` : url)).status);
    assert.deepEqual(codes, [200, 200, 429]);
  } finally {
    app.close();
  }
});

test('a cart never mixes two shops: another shop\'s item opens that shop\'s own cart', async () => {
  const item = async (store) => {
    const p = await db('products').where({ store_id: store, category: 'top' }).orderBy('id').first();
    await db('product_stock').where({ product_id: p.id, size: 'M' }).update({ quantity: 9, reserved: 0 });
    return p;
  };
  const p1 = await item(s1), p2 = await item(s2);
  const a = await call('POST', '/api/cart/items', { store_id: s1, items: [{ product_id: p1.id, size: 'M' }] });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  // Same token, another shop: a new cart for that shop; the first one keeps only its own item.
  const b = await call('POST', '/api/cart/items', { token: a.body.token, store_id: s2, items: [{ product_id: p2.id, size: 'M' }] });
  assert.equal(b.status, 200);
  assert.notEqual(b.body.token, a.body.token);
  assert.equal(b.body.store_id, s2);
  assert.deepEqual(b.body.items.map((i) => i.product_id), [p2.id]);
  const back = (await call('GET', `/api/cart/${a.body.token}`)).body;
  assert.deepEqual([back.store_id, back.items.map((i) => i.product_id)], [s1, [p1.id]]);
  // Another shop's product can't go into this shop's cart, with or without its store id.
  assert.equal((await call('POST', '/api/cart/items', { token: a.body.token, store_id: s1, items: [{ product_id: p2.id, size: 'M' }] })).status, 404);
  assert.equal((await call('POST', '/api/cart/items', { token: a.body.token, items: [{ product_id: p2.id, size: 'M' }] })).status, 404);
  assert.deepEqual((await call('GET', `/api/cart/${a.body.token}`)).body.items.map((i) => i.product_id), [p1.id]);
  // Each order is one shop's.
  const o = (await call('POST', `/api/cart/${a.body.token}/checkout`, { fulfillment: 'pickup', name: 'Sardor', phone: '+998901234500' })).body.order;
  assert.equal(o.store_id, s1);
  assert.ok((await db('order_items as i').join('products as p', 'p.id', 'i.product_id').where('i.order_id', o.id).select('p.store_id')).every((x) => x.store_id === s1));
});

test('migration 024: up and down with existing data', async () => {
  const m = testDb();
  try {
    for (let i = 0; i < 23; i++) await m.migrate.up(); // up to 023_categories
    const ins = async (t, row) => (await m(t).insert(row).returning('id'))[0].id;
    const org = await ins('organizations', { name: 'Eski brend' });
    const store = await ins('stores', { name: 'Eski', city: 'Toshkent', lat: 41, lon: 69, address: 'A', organization_id: org });
    const owner = await ins('admins', { email: 'old.owner@x.uz', password_hash: 'x', role: 'owner', organization_id: org, store_id: store });
    await ins('admin_invites', { token_hash: 'a'.repeat(64), email: 'inv@x.uz', role: 'manager', store_id: store, organization_id: org, expires_at: new Date(Date.now() + 1e6).toISOString() });
    await ins('audit_log', { admin_id: owner, admin_email: 'old.owner@x.uz', store_id: store, action: 'store.update', entity: 'store' });
    await m.migrate.up();
    const s = await m('stores').where({ id: store }).first();
    assert.deepEqual([s.mall_id, s.mall_floor, s.mall_unit, Boolean(s.mall_hidden), s.logo_url], [null, null, null, false, null]);
    assert.equal((await m('admins').where({ id: owner }).first()).role, 'owner');
    assert.equal((await m('admin_invites')).length, 1);
    assert.equal((await m('audit_log').first()).admin_id, owner, 'links kept through the rebuild');
    const mall = await ins('malls', { name: 'M', city: 'T', address: 'A' });
    const mallAdmin = await ins('admins', { email: 'm@x.uz', password_hash: 'x', role: 'mall', mall_id: mall });
    await ins('admin_invites', { token_hash: 'b'.repeat(64), email: 'm2@x.uz', role: 'mall', mall_id: mall, expires_at: new Date(Date.now() + 1e6).toISOString() });
    await ins('audit_log', { admin_id: mallAdmin, admin_email: 'm@x.uz', action: 'mall.update', entity: 'mall' });
    await assert.rejects(m('admin_invites').insert({ token_hash: 'c'.repeat(64), email: 'q@x.uz', role: 'owner', expires_at: new Date().toISOString() }), 'an owner invite still needs an organisation');
    await m('stores').where({ id: store }).update({ mall_id: mall, mall_floor: '2' });
    await m.migrate.down();
    assert.ok(!(await m.schema.hasTable('malls')));
    assert.ok(!('mall_id' in (await m('stores').first())));
    assert.equal(await m('admins').where({ role: 'mall' }).first(), undefined);
    assert.deepEqual((await m('admin_invites')).map((i) => i.email), ['inv@x.uz']);
    assert.equal((await m('audit_log').where({ admin_email: 'm@x.uz' }).first()).admin_id, null, 'the mall admin\'s audit row keeps the email');
    await assert.rejects(m('admin_invites').insert({ token_hash: 'd'.repeat(64), email: 'q@x.uz', role: 'manager', store_id: store, expires_at: new Date().toISOString() }), 'organization_id NOT NULL again');
    await assert.rejects(m('admins').insert({ email: 'm3@x.uz', password_hash: 'x', role: 'mall' }));
    await m.migrate.up();
    assert.equal((await m('stores').where({ id: store }).first()).mall_id, null);
  } finally {
    await m.destroy();
  }
});
