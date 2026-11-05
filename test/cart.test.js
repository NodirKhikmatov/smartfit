import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { deliveryFee, totals, normalizePhone, releaseExpired, HOLD_MS } from '../src/cart/cart.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, tashkent, samarkand, tashToken, samToken;

const call = async (method, path, body, token) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const login = async (email, password) => (await call('POST', '/api/admin/login', { email, password })).body.token;
const stock = (product_id, size) => db('product_stock').where({ product_id, size }).first('quantity', 'reserved');
// A product of this store with exactly `qty` units of one size and nothing reserved.
async function item(storeId, qty = 3, category = 'top') {
  const p = await db('products').where({ store_id: storeId, category }).orderBy('id').first();
  const size = category === 'accessory' ? 'ONE' : category === 'shoes' ? '42' : 'M';
  await db('product_stock').where({ product_id: p.id, size }).update({ quantity: qty, reserved: 0 });
  return { ...p, size };
}
const add = (store_id, items, token) => call('POST', '/api/cart/items', { store_id, token, items });
const pickup = { fulfillment: 'pickup', name: 'Aziz', phone: '+998 90 123 45 67' };

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [tashkent, samarkand] = (await db('stores').orderBy('id')).map((s) => s.id);
  await createAdmin(db, { email: 'tash@smartfit.uz', password: 'tash-pass-1', storeId: tashkent });
  await createAdmin(db, { email: 'sam@smartfit.uz', password: 'sam-pass-1', storeId: samarkand });
  server = createApp(db, { weather: async () => ({ temperature: 5, apparent_temperature: 2, raining: false, wind_speed: 3, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tashToken = await login('tash@smartfit.uz', 'tash-pass-1');
  samToken = await login('sam@smartfit.uz', 'sam-pass-1');
});
after(async () => {
  server.close();
  await db.destroy();
});

test('delivery fee: pickup free, flat city fee, free only above the threshold', () => {
  const store = { delivery_fee: 25000, free_delivery_threshold: 1000000 };
  assert.equal(deliveryFee(store, 500000, 'pickup'), 0);
  assert.equal(deliveryFee(store, 500000, 'delivery'), 25000);
  assert.equal(deliveryFee(store, 1000000, 'delivery'), 25000, 'exactly the threshold is not above it');
  assert.equal(deliveryFee(store, 1000001, 'delivery'), 0);
  assert.equal(deliveryFee({ delivery_fee: 25000, free_delivery_threshold: null }, 9e8, 'delivery'), 25000, 'no threshold = never free');
  assert.equal(deliveryFee({ delivery_fee: 0, free_delivery_threshold: null }, 100, 'delivery'), 0);
  assert.deepEqual(totals(store, 700000, 'delivery'), { subtotal: 700000, delivery_fee: 25000, total: 725000 });
  assert.deepEqual(totals(store, 1200000, 'delivery'), { subtotal: 1200000, delivery_fee: 0, total: 1200000 });
});

test('phone numbers are normalised to +998XXXXXXXXX', () => {
  assert.equal(normalizePhone('+998 90 123-45-67'), '+998901234567');
  assert.equal(normalizePhone('90 123 45 67'), '+998901234567');
  assert.equal(normalizePhone('(998) 901234567'), '+998901234567');
  for (const bad of ['', '12345', '+7 901 234 56 78', '998 90 123 45 6a', 901234567]) assert.throws(() => normalizePhone(bad), /Telefon/);
});

test('adding holds stock, the cart totals come from the DB and ignore browser prices', async () => {
  const top = await item(tashkent, 3), shoes = await item(tashkent, 2, 'shoes');
  const r = await add(tashkent, [{ product_id: top.id, size: 'M', price: 1, unit_price: 1 }, { product_id: shoes.id, size: '42' }]);
  assert.equal(r.status, 200);
  assert.match(r.body.token, /^[a-f0-9]{32}$/);
  const expires = Date.parse(r.body.expires_at) - Date.now();
  assert.ok(expires > HOLD_MS - 5000 && expires <= HOLD_MS, '15-minute hold');
  assert.deepEqual(await stock(top.id, 'M'), { quantity: 3, reserved: 1 });
  assert.deepEqual(await stock(shoes.id, '42'), { quantity: 2, reserved: 1 });
  const unit = (p) => p.discount_price ?? p.price;
  const subtotal = unit(top) + unit(shoes);
  assert.deepEqual(r.body.items.map((i) => i.unit_price), [unit(top), unit(shoes)]);
  assert.equal(r.body.totals.pickup.total, subtotal);
  const store = await db('stores').where({ id: tashkent }).first();
  assert.deepEqual(r.body.totals.delivery, totals(store, subtotal, 'delivery'));

  // The same item again → quantity 2, two units held.
  const again = await add(tashkent, [{ product_id: top.id, size: 'M' }], r.body.token);
  assert.equal(again.body.token, r.body.token);
  assert.equal(again.body.items[0].quantity, 2);
  assert.deepEqual(await stock(top.id, 'M'), { quantity: 3, reserved: 2 });

  const order = await call('POST', `/api/cart/${r.body.token}/checkout`, { ...pickup, subtotal: 1, total: 1, delivery_fee: 0, items: [{ unit_price: 1 }] });
  assert.equal(order.status, 201);
  assert.equal(order.body.order.total, 2 * unit(top) + unit(shoes));
  assert.equal(order.body.order.delivery_fee, 0);
  assert.deepEqual(order.body.payment, { method: 'cashier' });
  assert.equal(order.body.order.phone, '+998901234567');
  const rows = await db('order_items').where({ order_id: order.body.order.id }).orderBy('id');
  assert.deepEqual(rows.map((i) => [i.product_id, i.size, i.quantity, i.unit_price]), [[top.id, 'M', 2, unit(top)], [shoes.id, '42', 1, unit(shoes)]]);
  assert.equal((await call('GET', `/api/cart/${r.body.token}`)).status, 404, 'cart is gone after checkout');
  assert.deepEqual(await stock(top.id, 'M'), { quantity: 3, reserved: 2 }, 'the order keeps the hold until paid');
});

test('the last unit cannot be held or sold twice, even with parallel requests', async () => {
  const last = await item(tashkent, 1);
  const tries = await Promise.all(Array.from({ length: 10 }, () => add(tashkent, [{ product_id: last.id, size: 'M' }])));
  assert.deepEqual(tries.map((t) => t.status).sort(), [200, ...Array(9).fill(409)]);
  assert.match(tries.find((t) => t.status === 409).body.error, /qolmadi/);
  assert.deepEqual(await stock(last.id, 'M'), { quantity: 1, reserved: 1 });

  // Whole outfit is all or nothing: the free item is not held when the other one is sold out.
  const free = await item(tashkent, 2, 'bottom');
  const outfit = await add(tashkent, [{ product_id: free.id, size: 'M' }, { product_id: last.id, size: 'M' }]);
  assert.equal(outfit.status, 409);
  assert.deepEqual(await stock(free.id, 'M'), { quantity: 2, reserved: 0 });

  const winner = tries.find((t) => t.status === 200).body.token;
  const { body } = await call('POST', `/api/cart/${winner}/checkout`, pickup);
  const pays = await Promise.all([1, 2, 3].map(() => call('POST', `/api/admin/orders/${body.order.id}/pay`, {}, tashToken)));
  assert.deepEqual(pays.map((p) => p.status).sort(), [200, 409, 409]);
  assert.deepEqual(await stock(last.id, 'M'), { quantity: 0, reserved: 0 }, 'stock drops once, on payment');
  const paid = pays.find((p) => p.status === 200).body;
  assert.equal(paid.payment_status, 'paid');
  assert.ok(paid.paid_at);
  assert.match(pays.find((p) => p.status === 409).body.error, /allaqachon/);
});

test('expired cart and unpaid order holds are released', async () => {
  const p = await item(tashkent, 2, 'accessory');
  const cart = (await add(tashkent, [{ product_id: p.id, size: 'ONE' }])).body;
  assert.deepEqual(await stock(p.id, 'ONE'), { quantity: 2, reserved: 1 });
  await releaseExpired(db, Date.now() + HOLD_MS - 60_000);
  assert.deepEqual(await stock(p.id, 'ONE'), { quantity: 2, reserved: 1 }, 'still inside 15 min');
  await releaseExpired(db, Date.now() + HOLD_MS + 1000);
  assert.deepEqual(await stock(p.id, 'ONE'), { quantity: 2, reserved: 0 }, 'released after 15 min');
  assert.equal((await call('GET', `/api/cart/${cart.token}`)).status, 404);

  // Lazy: the next cart request releases expired holds without the sweep timer.
  const c2 = (await add(tashkent, [{ product_id: p.id, size: 'ONE' }])).body;
  await db('carts').where({ token: c2.token }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await call('PATCH', `/api/cart/${c2.token}/items/${c2.items[0].id}`, { size: 'ONE' })).status, 404);
  assert.deepEqual(await stock(p.id, 'ONE'), { quantity: 2, reserved: 0 });
  // An expired token on add just opens a new cart.
  const c3 = await add(tashkent, [{ product_id: p.id, size: 'ONE' }], c2.token);
  assert.equal(c3.status, 200);
  assert.notEqual(c3.body.token, c2.token);

  const { body } = await call('POST', `/api/cart/${c3.body.token}/checkout`, pickup);
  await db('orders').where({ id: body.order.id }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });
  const pay = await call('POST', `/api/admin/orders/${body.order.id}/pay`, {}, tashToken);
  assert.equal(pay.status, 409);
  assert.match(pay.body.error, /bekor/);
  const o = await db('orders').where({ id: body.order.id }).first();
  assert.deepEqual([o.status, o.payment_status], ['cancelled', 'cancelled']);
  assert.deepEqual(await stock(p.id, 'ONE'), { quantity: 2, reserved: 0 }, 'unpaid order gives its stock back');
});

test('change size, remove a line and clear the cart move the holds', async () => {
  const p = await item(tashkent, 2);
  await db('product_stock').where({ product_id: p.id, size: 'L' }).update({ quantity: 1, reserved: 0 });
  await db('product_stock').where({ product_id: p.id, size: 'XL' }).update({ quantity: 0, reserved: 0 });
  const cart = (await add(tashkent, [{ product_id: p.id, size: 'M' }])).body;
  assert.ok(cart.items[0].sizes.includes('L') && !cart.items[0].sizes.includes('XL'), 'only sizes with free stock are offered');
  const line = cart.items[0].id;

  const xl = await call('PATCH', `/api/cart/${cart.token}/items/${line}`, { size: 'XL' });
  assert.equal(xl.status, 409);
  assert.deepEqual(await stock(p.id, 'M'), { quantity: 2, reserved: 1 }, 'failed change keeps the old hold');
  assert.equal((await call('PATCH', `/api/cart/${cart.token}/items/${line}`, { size: '42' })).status, 400);

  const l = await call('PATCH', `/api/cart/${cart.token}/items/${line}`, { size: 'L' });
  assert.equal(l.status, 200);
  assert.equal(l.body.items[0].size, 'L');
  assert.deepEqual(await stock(p.id, 'M'), { quantity: 2, reserved: 0 });
  assert.deepEqual(await stock(p.id, 'L'), { quantity: 1, reserved: 1 });

  const shoes = await item(tashkent, 1, 'shoes');
  const two = (await add(tashkent, [{ product_id: shoes.id, size: '42' }], cart.token)).body;
  const del = await call('DELETE', `/api/cart/${cart.token}/items/${two.items[1].id}`);
  assert.equal(del.body.items.length, 1);
  assert.deepEqual(await stock(shoes.id, '42'), { quantity: 1, reserved: 0 });

  assert.equal((await call('DELETE', `/api/cart/${cart.token}`)).status, 204);
  assert.deepEqual(await stock(p.id, 'L'), { quantity: 1, reserved: 0 });
  assert.equal((await call('DELETE', `/api/cart/${cart.token}`)).status, 204, 'clearing twice is fine');
});

test('cart input is validated: other store, bad size, cap, bad token', async () => {
  const sam = await item(samarkand, 3);
  const tash = await item(tashkent, 25);
  assert.equal((await add(tashkent, [{ product_id: sam.id, size: 'M' }])).status, 404, "another store's product");
  assert.equal((await add(tashkent, [{ product_id: tash.id, size: '42' }])).status, 400);
  assert.equal((await add(tashkent, [{ product_id: tash.id }])).status, 400);
  assert.equal((await add(tashkent, [])).status, 400);
  assert.equal((await add(999, [{ product_id: tash.id, size: 'M' }])).status, 404);
  let token;
  for (let i = 0; i < 2; i++) token = (await add(tashkent, Array(10).fill({ product_id: tash.id, size: 'M' }), token)).body.token;
  const over = await add(tashkent, [{ product_id: tash.id, size: 'M' }], token);
  assert.equal(over.status, 409);
  assert.match(over.body.error, /20/);
  assert.deepEqual(await stock(tash.id, 'M'), { quantity: 25, reserved: 20 });
  await call('DELETE', `/api/cart/${token}`);
  // A token from another store's cart opens a new cart for this store instead of mixing stores.
  const tashCart = (await add(tashkent, [{ product_id: tash.id, size: 'M' }])).body;
  const samCart = await add(samarkand, [{ product_id: sam.id, size: 'M' }], tashCart.token);
  assert.equal(samCart.status, 200);
  assert.notEqual(samCart.body.token, tashCart.token);
  assert.equal(samCart.body.store_id, samarkand);
  for (const t of [tashCart.token, samCart.body.token]) await call('DELETE', `/api/cart/${t}`);
  for (const t of ['nope', "x' or 1=1", 'a'.repeat(32)]) assert.equal((await call('GET', `/api/cart/${encodeURIComponent(t)}`)).status, 404);
});

test('checkout: delivery needs an address in the city, fee from store settings, free above the threshold', async () => {
  const store = await db('stores').where({ id: tashkent }).first();
  const coat = await item(tashkent, 3, 'outerwear');
  const cart = (await add(tashkent, [{ product_id: coat.id, size: 'M' }])).body;
  const url = `/api/cart/${cart.token}/checkout`;
  const delivery = { ...pickup, fulfillment: 'delivery', address: "Chilonzor 9-kvartal, 12-uy", lat: 41.28, lon: 69.2 };
  assert.equal((await call('POST', url, { ...delivery, address: '' })).status, 400);
  assert.equal((await call('POST', url, { ...delivery, phone: '123' })).status, 400);
  assert.equal((await call('POST', url, { ...delivery, name: '' })).status, 400);
  assert.equal((await call('POST', url, { ...delivery, fulfillment: 'drone' })).status, 400);
  assert.equal((await call('POST', url, { ...delivery, lat: 'x' })).status, 400);
  const far = await call('POST', url, { ...delivery, lat: 39.65, lon: 66.96 }); // Samarkand
  assert.equal(far.status, 422);
  assert.match(far.body.error, /Toshkent/);
  assert.equal((await call('POST', url, { ...delivery, payment: 'bitcoin' })).status, 400);

  const unit = coat.discount_price ?? coat.price;
  const ok = await call('POST', url, delivery);
  assert.equal(ok.status, 201);
  const fee = unit > store.free_delivery_threshold ? 0 : store.delivery_fee;
  assert.deepEqual([ok.body.order.subtotal, ok.body.order.delivery_fee, ok.body.order.total], [unit, fee, unit + fee]);
  assert.deepEqual([ok.body.order.address, ok.body.order.lat, ok.body.order.lon], [delivery.address, 41.28, 69.2]);

  // Above the threshold → free delivery.
  const c2 = (await add(tashkent, [{ product_id: coat.id, size: 'M' }, { product_id: coat.id, size: 'M' }])).body;
  assert.ok(2 * unit > store.free_delivery_threshold);
  assert.equal(c2.totals.delivery.delivery_fee, 0);
  const free = await call('POST', `/api/cart/${c2.token}/checkout`, { ...delivery, lat: undefined, lon: undefined });
  assert.deepEqual([free.body.order.delivery_fee, free.body.order.total], [0, 2 * unit]);
});

test("a store manager cannot see or pay another store's order", async () => {
  const p = await item(tashkent, 2);
  const cart = (await add(tashkent, [{ product_id: p.id, size: 'M' }])).body;
  const { body } = await call('POST', `/api/cart/${cart.token}/checkout`, pickup);
  assert.equal((await call('GET', `/api/admin/orders/${body.order.id}`, undefined, samToken)).status, 404);
  assert.equal((await call('POST', `/api/admin/orders/${body.order.id}/pay`, {}, samToken)).status, 404);
  assert.equal((await call('POST', `/api/admin/orders/${body.order.id}/pay`, {})).status, 401);
  assert.deepEqual(await stock(p.id, 'M'), { quantity: 2, reserved: 1 });
  const own = await call('GET', `/api/admin/orders/${body.order.id}`, undefined, tashToken);
  assert.equal(own.status, 200);
  assert.equal(own.body.items[0].name, p.name);
  assert.equal((await call('POST', `/api/admin/orders/${body.order.id}/pay`, {}, tashToken)).status, 200);
  assert.deepEqual(await stock(p.id, 'M'), { quantity: 1, reserved: 0 });
});

test('recommend lists the in-stock sizes of shoes when the shoe size is unknown', async () => {
  const r = await call('POST', '/api/recommend', { store_id: tashkent, gender: 'male', sizes: { top: 'M', bottom: 'M' } });
  const shoes = r.body.outfits.flatMap((o) => o.items).filter((i) => i.category === 'shoes');
  assert.ok(shoes.length);
  for (const s of shoes) {
    assert.equal(s.size, null);
    const free = await db('product_stock').where({ product_id: s.id }).whereRaw('quantity - reserved > 0').orderBy('id').pluck('size');
    assert.deepEqual(s.sizes, free);
  }
});
