import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed, CATALOGUE } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { hashPassword, verifyPassword, signToken, verifyToken, TOKEN_TTL_MS } from '../src/admin/auth.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const inStore = (code) => CATALOGUE.filter((p) => p.stores.includes(code)).length;
const db = testDb();
let server, base, tashkent, samarkand, superToken, tashToken;

const api = async (path, { token, method = 'GET', body } = {}) => {
  const res = await fetch(`${base}/api/admin${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const login = async (email, password) => (await api('/login', { method: 'POST', body: { email, password } })).body.token;
const newProduct = (extra) => ({ name: 'Test kurtka', category: 'outerwear', gender: 'unisex', color: 'qora', price: 500000, temp_min: -5, temp_max: 10, ...extra });

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [tashkent, samarkand] = (await db('stores').orderBy('id')).map((s) => s.id);
  await createAdmin(db, { email: 'Boss@SmartFit.uz', password: 'super-pass-1' });
  await createAdmin(db, { email: 'tash@smartfit.uz', password: 'tash-pass-1', storeId: tashkent });
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  superToken = await login('boss@smartfit.uz', 'super-pass-1');
  tashToken = await login('tash@smartfit.uz', 'tash-pass-1');
});
after(async () => {
  server.close();
  await db.destroy();
});

test('scrypt hash verifies only the right password', async () => {
  const h = await hashPassword('secret-123');
  assert.match(h, /^scrypt\$/);
  assert.equal(await verifyPassword('secret-123', h), true);
  assert.equal(await verifyPassword('secret-124', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('token lasts 12 hours and rejects tampering', () => {
  const now = Date.now();
  const { token } = signToken('k', 7, now);
  assert.equal(verifyToken('k', token, now), 7);
  assert.equal(verifyToken('k', token, now + TOKEN_TTL_MS - 1), 7);
  assert.equal(verifyToken('k', token, now + TOKEN_TTL_MS), null, 'expired after 12h');
  assert.equal(verifyToken('other', token, now), null, 'wrong secret');
  const forged = Buffer.from(JSON.stringify({ sub: 1, exp: now + 1e9 })).toString('base64url') + '.' + token.split('.')[1];
  assert.equal(verifyToken('k', forged, now), null, 'payload swap');
});

test('login: wrong password and unknown email get the same 401', async () => {
  const a = await api('/login', { method: 'POST', body: { email: 'tash@smartfit.uz', password: 'nope-nope' } });
  const b = await api('/login', { method: 'POST', body: { email: 'ghost@smartfit.uz', password: 'nope-nope' } });
  assert.equal(a.status, 401);
  assert.deepEqual(a, b);
  const ok = await api('/login', { method: 'POST', body: { email: ' TASH@smartfit.uz ', password: 'tash-pass-1' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.admin, { id: ok.body.admin.id, email: 'tash@smartfit.uz', role: 'manager', store_id: tashkent });
  assert.ok(!('password_hash' in ok.body.admin));
});

test('admin routes need a valid token', async () => {
  assert.equal((await api('/products')).status, 401);
  assert.equal((await api('/products', { token: 'abc.def' })).status, 401);
  assert.equal((await api('/me', { token: tashToken })).body.role, 'manager');
});

test('super-admin sees all stores, manager only their own', async () => {
  assert.equal((await api('/stores', { token: superToken })).body.length, 2);
  assert.deepEqual((await api('/stores', { token: tashToken })).body.map((s) => s.id), [tashkent]);
  const all = (await api('/products', { token: superToken })).body;
  assert.equal(all.length, inStore('T') + inStore('S'));
  const own = (await api('/products', { token: tashToken })).body;
  assert.equal(own.length, inStore('T'));
  assert.ok(own.every((p) => p.store_id === tashkent));
  assert.equal((await api(`/products?store_id=${samarkand}`, { token: tashToken })).body.length, 0);
});

test('store manager cannot read or change another store\'s products', async () => {
  const other = await db('products').where({ store_id: samarkand }).first();
  const before = await db('product_stock').where({ product_id: other.id });

  assert.equal((await api(`/products/${other.id}`, { token: tashToken })).status, 404);
  assert.equal((await api(`/products/${other.id}`, { token: tashToken, method: 'PATCH', body: { price: 1, stock: { M: 99 } } })).status, 404);
  assert.equal((await api(`/products/${other.id}`, { token: tashToken, method: 'DELETE' })).status, 404);
  assert.equal((await api('/products', { token: tashToken, method: 'POST', body: newProduct({ store_id: samarkand }) })).status, 403);

  assert.deepEqual(await db('products').where({ id: other.id }).first(), other);
  assert.deepEqual(await db('product_stock').where({ product_id: other.id }), before);
  assert.equal(Number((await db('products').where({ store_id: samarkand }).count({ n: '*' }))[0].n), inStore('S'));
});

test('search and category filter', async () => {
  const jinsi = (await api('/products?q=JINSI', { token: tashToken })).body;
  assert.deepEqual(jinsi.map((p) => p.name).sort(), ['Isitilgan jinsi', 'Jinsi kurtka', 'Jinsi shorti', 'Klassik jinsi', 'Premium jinsi', 'Slim jinsi']);
  const shoes = (await api('/products?category=shoes', { token: tashToken })).body;
  assert.ok(shoes.length > 0 && shoes.every((p) => p.category === 'shoes'));
  assert.deepEqual(shoes[0].stock.map((s) => s.size), ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45']);
  assert.equal(typeof shoes[0].waterproof, 'boolean');
});

test('manager adds, edits and deletes a product with a size table', async () => {
  const created = await api('/products', { token: tashToken, method: 'POST', body: newProduct({ stock: { M: 3, L: 1 } }) });
  assert.equal(created.status, 201);
  const p = created.body;
  assert.equal(p.store_id, tashkent);
  assert.deepEqual(p.stock.map((s) => [s.size, s.quantity]), [['XS', 0], ['S', 0], ['M', 3], ['L', 1], ['XL', 0], ['XXL', 0]]);

  const edited = await api(`/products/${p.id}`, { token: tashToken, method: 'PATCH', body: { price: 450000, discount_price: 400000, stock: { M: 0, XL: 2 } } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.price, 450000);
  assert.equal(edited.body.name, 'Test kurtka', 'untouched fields kept');
  assert.deepEqual(edited.body.stock.filter((s) => s.quantity).map((s) => s.size), ['L', 'XL']);

  assert.equal((await api(`/products/${p.id}`, { token: tashToken, method: 'DELETE' })).status, 204);
  assert.equal(await db('products').where({ id: p.id }).first(), undefined);
  assert.equal((await db('product_stock').where({ product_id: p.id })).length, 0);
});

test('super-admin must pick an existing store when adding', async () => {
  assert.equal((await api('/products', { token: superToken, method: 'POST', body: newProduct() })).status, 400);
  assert.equal((await api('/products', { token: superToken, method: 'POST', body: newProduct({ store_id: 999 }) })).status, 400);
  const ok = await api('/products', { token: superToken, method: 'POST', body: newProduct({ store_id: samarkand, category: 'shoes', stock: { 42: 2 } }) });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.store_id, samarkand);
  await db('products').where({ id: ok.body.id }).del();
});

test('invalid product data is rejected with a message', async () => {
  const bad = [
    { name: '' },
    { category: 'hat' },
    { gender: 'x' },
    { price: 100.5 },
    { price: '100' },
    { discount_price: 600000 },
    { temp_min: 20, temp_max: 10 },
    { stock: { XXXL: 1 } },
    { stock: { M: -1 } },
    { stock: { 42: 1 } },
  ];
  for (const extra of bad) {
    const res = await api('/products', { token: tashToken, method: 'POST', body: newProduct(extra) });
    assert.equal(res.status, 400, JSON.stringify(extra));
    assert.ok(res.body.error && res.body.error !== "Noto'g'ri so'rov", `specific message for ${JSON.stringify(extra)}`);
  }
  const p = await db('products').where({ store_id: tashkent, category: 'top' }).first();
  const res = await api(`/products/${p.id}`, { token: tashToken, method: 'PATCH', body: { category: 'shoes' } });
  assert.equal(res.status, 400, 'size group cannot change');
});

test('stock cannot drop below reserved, and ordered products cannot be deleted', async () => {
  const p = await db('products').where({ store_id: tashkent, category: 'accessory' }).first();
  await db('product_stock').where({ product_id: p.id, size: 'ONE' }).update({ quantity: 5, reserved: 2 });
  const res = await api(`/products/${p.id}`, { token: tashToken, method: 'PATCH', body: { stock: { ONE: 1 } } });
  assert.equal(res.status, 409);
  assert.equal((await api(`/products/${p.id}`, { token: tashToken, method: 'DELETE' })).status, 409);
  await db('product_stock').where({ product_id: p.id }).update({ reserved: 0 });

  const [{ id: orderId }] = await db('orders')
    .insert({ store_id: tashkent, customer_name: 'A', phone: '+998901234567', fulfillment: 'pickup', subtotal: p.price, total: p.price })
    .returning('id');
  await db('order_items').insert({ order_id: orderId, product_id: p.id, size: 'ONE', quantity: 1, unit_price: p.price });
  const del = await api(`/products/${p.id}`, { token: tashToken, method: 'DELETE' });
  assert.equal(del.status, 409);
  assert.ok(await db('products').where({ id: p.id }).first());
});

test('deleted admin loses access immediately', async () => {
  await createAdmin(db, { email: 'temp@smartfit.uz', password: 'temp-pass-1', storeId: samarkand });
  const token = await login('temp@smartfit.uz', 'temp-pass-1');
  assert.equal((await api('/me', { token })).status, 200);
  await db('admins').where({ email: 'temp@smartfit.uz' }).del();
  assert.equal((await api('/me', { token })).status, 401);
});

test('createAdmin validates input', async () => {
  await assert.rejects(createAdmin(db, { email: 'bad', password: 'long-enough' }));
  await assert.rejects(createAdmin(db, { email: 'a@b.uz', password: 'short' }));
  await assert.rejects(createAdmin(db, { email: 'a@b.uz', password: 'long-enough', storeId: NaN }), /store_id/);
});

test('login locks an IP after 10 failures', async () => {
  for (let i = 0; i < 10; i++) await api('/login', { method: 'POST', body: { email: 'x@y.uz', password: 'wrong-pass' } });
  const res = await api('/login', { method: 'POST', body: { email: 'tash@smartfit.uz', password: 'tash-pass-1' } });
  assert.equal(res.status, 429);
});

test('GET /admin serves the admin page', async () => {
  const res = await fetch(`${base}/admin/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>/);
});
