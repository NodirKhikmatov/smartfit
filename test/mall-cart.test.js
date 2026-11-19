// Task 38: one cart across the shops of a mall. A mall cart holds one store cart per shop; one checkout makes one order
// per shop and a mall order group, in one transaction. Money never mixes (each shop's bundle, promo code, points and
// instalments by its own rules); after checkout the shops' orders live apart; each shop sees only its own order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { changeStatus, releaseExpired } from '../src/cart/cart.js';
import { t } from '../public/shared/i18n.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, mall, s1, s2, s3, org1, org2, owner1, owner2, staff1, mallAdmin;

const call = async (method, p, body, token) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
};
const admin = (method, p, body, token) => call(method, `/api/admin${p}`, body, token);
const login = async (email, password) => (await admin('POST', '/login', { email, password })).body.token;

// The first top / bottom of a store at this price with plenty of stock.
async function product(store, category = 'top', price = 100000) {
  const p = await db('products').where({ store_id: store, category }).orderBy('id').first();
  await db('products').where({ id: p.id }).update({ price, discount_price: null });
  await db('product_stock').where({ product_id: p.id }).update({ quantity: 50, reserved: 0 });
  return { ...p, size: (await db('product_stock').where({ product_id: p.id }).orderBy('size').first()).size };
}
const add = (body) => call('POST', '/api/mall-cart/items', { mall_id: mall, ...body });
const addOne = (token, store, p) => add({ token, store_id: store, items: [{ product_id: p.id, size: p.size }] });
const checkout = (token, extra = {}) => call('POST', `/api/mall-cart/${token}/checkout`, { name: 'Malika Karimova', phone: '+998935554433', ...extra });
const reserved = async (p) => Number((await db('product_stock').where({ product_id: p.id, size: p.size }).first()).reserved);
// A mall cart with one top in shop 1 (100 000) and one top in shop 2 (200 000).
async function twoShops() {
  const a = await product(s1, 'top', 100000), b = await product(s2, 'top', 200000);
  const one = await addOne(null, s1, a);
  assert.equal(one.status, 200, JSON.stringify(one.body));
  const two = await addOne(one.body.token, s2, b);
  assert.equal(two.status, 200, JSON.stringify(two.body));
  return { a, b, cart: two.body };
}
const shopOf = (cart, store) => cart.shops.find((s) => s.store.id === store).cart;

before(async () => {
  await db.migrate.latest();
  await seed(db); // two demo shops (two organisations), both in the demo mall
  [s1, s2] = (await db('stores').orderBy('id')).map((s) => s.id);
  [org1, org2] = (await db('stores').orderBy('id')).map((s) => s.organization_id);
  mall = (await db('malls').first()).id;
  await db('stores').where({ id: s1 }).update({ mall_floor: '2', mall_unit: '214' });
  // s3: another store of shop 1's organisation, outside the mall.
  [{ id: s3 }] = await db('stores').insert({ name: 'Tashqi filial', city: 'Toshkent', address: 'Navoiy 5', lat: 41.3, lon: 69.25, organization_id: org1 }).returning('id');
  const { id: _, sku, created_at, updated_at, ...p } = await db('products').where({ store_id: s1, category: 'top' }).orderBy('id').first();
  const [{ id: p3 }] = await db('products').insert({ ...p, store_id: s3, sku: null }).returning('id');
  await db('product_stock').insert({ product_id: p3, size: 'M', quantity: 5 });
  await createAdmin(db, { email: 'owner1@smartfit.uz', password: 'owner-pass-1', storeId: s1 });
  await createAdmin(db, { email: 'owner2@smartfit.uz', password: 'owner-pass-2', storeId: s2 });
  await createAdmin(db, { email: 'staff1@smartfit.uz', password: 'staff-pass-1', storeId: s1, role: 'staff' });
  await createAdmin(db, { email: 'mall@smartfit.uz', password: 'mall-pass-1', mallId: mall });
  server = createApp(db, { telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }), limits: { cart: 0, openCarts: 1 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner1 = await login('owner1@smartfit.uz', 'owner-pass-1');
  owner2 = await login('owner2@smartfit.uz', 'owner-pass-2');
  staff1 = await login('staff1@smartfit.uz', 'staff-pass-1');
  mallAdmin = await login('mall@smartfit.uz', 'mall-pass-1');
});
after(async () => {
  server.close();
  await db.destroy();
});

test('a cart with two shops: grouped by shop, one hold time, and one checkout makes two orders and one group', async () => {
  await db('carts').del(); // the open-carts limit is 1 per client here: a mall cart counts once
  const { a, b, cart } = await twoShops();
  assert.equal(cart.count, 2);
  const s2row = await db('stores').where({ id: s2 }).first();
  assert.deepEqual(cart.shops.map((s) => [s.store.id, s.store.floor, s.store.unit]), [[s1, '2', '214'], [s2, s2row.mall_floor, s2row.mall_unit]]);
  assert.deepEqual(cart.shops.map((s) => s.cart.totals.pickup.total), [100000, 200000], 'each shop its own total');
  assert.deepEqual(cart.shops.map((s) => s.cart.payments), [['cashier'], ['cashier']], 'a mall cart pays at each cashier only');
  const rows = await db('carts').where({ mall_token: cart.token });
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((r) => String(r.expires_at))).size, 1, 'every shop holds for the same 15 minutes');
  // A change in one shop through the plain cart routes extends the other shop's hold too.
  await db('carts').where({ mall_token: cart.token }).update({ expires_at: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await call('POST', `/api/cart/${shopOf(cart, s2).token}/extend`, {})).status, 200);
  for (const r of await db('carts').where({ mall_token: cart.token })) assert.ok(Date.parse(r.expires_at) > Date.now() + 14 * 60_000);

  const seq = (await db('malls').where({ id: mall }).first()).order_seq;
  const r = await checkout(cart.token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.number, seq + 1);
  assert.match(r.body.track.url, /\/mall-order\/[a-f0-9]{32}$/);
  assert.match(r.body.track.svg, /^<svg/);
  assert.deepEqual(r.body.orders.map((o) => [o.store.id, o.total, o.status, o.payment_status, o.fulfillment]),
    [[s1, 100000, 'new', 'pending', 'pickup'], [s2, 200000, 'new', 'pending', 'pickup']]);
  const orders = await db('orders').where({ group_number: r.body.number }).orderBy('id');
  assert.deepEqual(orders.map((o) => o.store_id), [s1, s2]);
  assert.equal(new Set(orders.map((o) => o.group_id)).size, 1);
  assert.equal((await db('order_groups').where({ id: orders[0].group_id }).first()).mall_id, mall);
  assert.equal(await db('carts').where({ mall_token: cart.token }).first(), undefined, 'the carts became the orders');
  assert.deepEqual([await reserved(a), await reserved(b)], [1, 1], 'the orders own the holds now');
  assert.equal((await checkout(cart.token)).status, 404, 'a mall cart checks out once');

  // The group status page: every shop's name, floor, unit, order number and status; no name or phone.
  const token = new URL(r.body.track.url).pathname.split('/').pop();
  const page = await call('GET', `/api/order-groups/${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.number, r.body.number);
  assert.deepEqual(page.body.orders.map((o) => [o.store.name, o.store.floor, o.store.unit, o.number, o.status]),
    orders.map((o, i) => [r.body.orders[i].store.name, i ? s2row.mall_floor : '2', i ? s2row.mall_unit : '214', o.number, 'new']));
  assert.ok(!/Malika|935554433/.test(JSON.stringify(page.body)));
  assert.match(page.body.orders[0].track, /^\/order\/[a-f0-9]{32}$/);
  assert.equal((await call('GET', page.body.orders[0].track.replace('/order/', '/api/orders/'))).body.number, orders[0].number);
  assert.equal((await call('GET', `/api/order-groups/${'0'.repeat(32)}`)).status, 404);
  const html = await fetch(`${base}/mall-order/${token}`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('referrer-policy'), 'no-referrer');
});

test('a failed reservation or a failed shop creates nothing, and the error names the shop', async () => {
  await db('carts').del();
  // An outfit whose second line is sold out: nothing of it is added (all or nothing per add).
  const top = await product(s1, 'top'), bottom = await product(s1, 'bottom');
  await db('product_stock').where({ product_id: bottom.id, size: bottom.size }).update({ quantity: 0 });
  const out = await add({ store_id: s1, items: [{ product_id: top.id, size: top.size }, { product_id: bottom.id, size: bottom.size }] });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'out_of_stock');
  assert.deepEqual(out.body.item, { product_id: bottom.id, size: bottom.size });
  assert.equal(await reserved(top), 0);
  assert.equal(await db('carts').first(), undefined);

  // At checkout shop 2's promo code stopped working: no order, no group, every hold and cart stays.
  const { a, b, cart } = await twoShops();
  const [{ id: code }] = await db('promo_codes').insert({ organization_id: org2, code: 'MALL10', kind: 'percent', value: 10 }).returning('id');
  const on = await call('POST', `/api/cart/${shopOf(cart, s2).token}/promo`, { code: 'mall10' });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  await db('promo_codes').where({ id: code }).update({ active: false });
  const [orders, groups, seq] = [await db('orders').count({ n: '*' }), await db('order_groups').count({ n: '*' }), (await db('malls').where({ id: mall }).first()).order_seq];
  const r = await checkout(cart.token);
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.store, { id: s2, name: (await db('stores').where({ id: s2 }).first()).name });
  assert.deepEqual([await db('orders').count({ n: '*' }), await db('order_groups').count({ n: '*' }), (await db('malls').where({ id: mall }).first()).order_seq], [orders, groups, seq]);
  assert.equal((await db('carts').where({ mall_token: cart.token })).length, 2);
  assert.deepEqual([await reserved(a), await reserved(b)], [1, 1]);
  assert.equal((await db('promo_codes').where({ id: code }).first()).used, 0);
  // Removing the code fixes it; name and phone are checked before any shop.
  await call('DELETE', `/api/cart/${shopOf(cart, s2).token}/promo`);
  const bad = await checkout(cart.token, { phone: '123' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.store, undefined);
  assert.equal((await checkout(cart.token)).status, 201);
});

test('money per shop: bundle, promo code, points and instalments follow each shop\'s own rules', async () => {
  await db('carts').del();
  const { cart } = await twoShops();
  const c1 = shopOf(cart, s1), c2 = shopOf(cart, s2);
  // Shop 1: a 10 % bundle on its own outfit; shop 2: its own promo code. Shop 1's code doesn't work in shop 2's cart.
  const a2 = await product(s1, 'bottom', 50000);
  await db('stores').where({ id: s1 }).update({ bundle_percent: 10 });
  assert.equal((await addOne(cart.token, s1, a2)).status, 200);
  await db('carts').where({ token: c1.token }).update({ bundles: JSON.stringify([[c1.items[0].product_id, a2.id].sort((x, y) => x - y)]) });
  await db('promo_codes').insert([{ organization_id: org1, code: 'ONE20', kind: 'percent', value: 20 }, { organization_id: org2, code: 'TWO5K', kind: 'fixed', value: 5000 }]);
  assert.equal((await call('POST', `/api/cart/${c2.token}/promo`, { code: 'ONE20' })).body.code, 'promo_invalid', 'another organisation\'s code');
  assert.equal((await call('POST', `/api/cart/${c2.token}/promo`, { code: 'TWO5K' })).status, 200);
  // Points: shop 1's organisation has them on and this customer linked shop 1's part; shop 2 has none.
  await db('organizations').where({ id: org1 }).update({ cashback_percent: 5, points_max_share: 50 });
  const [{ id: profile }] = await db('customer_profiles').insert({ organization_id: org1, telegram_user_id: 77, phone: '+998935554433', consent_at: new Date().toISOString() }).returning('id');
  const [{ id: old }] = await db('orders').insert({ store_id: s1, number: 999, customer_name: 'A', phone: '+998935554433', fulfillment: 'pickup', subtotal: 1, delivery_fee: 0, total: 1 }).returning('id');
  await db('points_ledger').insert({ organization_id: org1, profile_id: profile, order_id: old, kind: 'earn', amount: 30000, ref: `earn:${old}` });
  await db('carts').where({ token: c1.token }).update({ profile_id: profile });
  // Instalments: shop 2 offers 3 months at 10 %.
  await db('stores').where({ id: s2 }).update({ instalment_on: true, instalment_terms: JSON.stringify([{ months: 3, percent: 10 }]) });
  const view = (await call('GET', `/api/mall-cart/${cart.token}`)).body;
  const v1 = shopOf(view, s1), v2 = shopOf(view, s2);
  assert.deepEqual([v1.discounts.bundle, v1.discounts.promo, v1.points.max, v1.totals.pickup.instalments], [15000, 0, 30000, undefined]);
  assert.deepEqual([v2.discounts.bundle, v2.discounts.promo, v2.points, v2.totals.pickup.instalments.length], [0, 5000, undefined, 1]);
  // Points asked for shop 2 (not linked, other organisation): refused, naming shop 2, nothing created.
  const no = await checkout(cart.token, { shops: [{ store_id: s2, points: 1000 }] });
  assert.deepEqual([no.status, no.body.code, no.body.store.id], [409, 'points_unavailable', s2]);
  assert.equal(await db('order_groups').where({ number: no.body.number ?? -1 }).first(), undefined);
  const r = await checkout(cart.token, { shops: [{ store_id: s1, points: 30000 }, { store_id: s2, instalment: 3 }], total: 1, subtotal: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const [o1, o2] = await db('orders').where({ group_number: r.body.number }).orderBy('id');
  // Shop 1: 150 000 − 15 000 bundle − 30 000 points; shop 2: 200 000 − 5 000 code, 3 months of ceil(195 000 × 1.1 / 3).
  assert.deepEqual([o1.subtotal, o1.bundle_discount, o1.promo_discount, o1.points_discount, o1.total, o1.instalment_months], [150000, 15000, 0, 30000, 105000, null]);
  assert.deepEqual([o2.subtotal, o2.bundle_discount, o2.promo_code, o2.promo_discount, o2.points_discount, o2.total, o2.instalment_months, o2.instalment_monthly], [200000, 0, 'TWO5K', 5000, 0, 195000, 3, 71500]);
  assert.equal(Number((await db('points_ledger').where({ profile_id: profile }).sum({ n: 'amount' }))[0].n), 0, 'spent from shop 1\'s organisation');
  assert.equal(o1.profile_id, profile);
  assert.equal(o2.profile_id, null);
  await db('organizations').where({ id: org1 }).update({ cashback_percent: 0 });
  await db('stores').whereIn('id', [s1, s2]).update({ bundle_percent: 0, instalment_on: false });
});

test('after checkout the shops are independent: one cancelled or expired leaves the other alone', async () => {
  await db('carts').del();
  const { a, b, cart } = await twoShops();
  const r = await checkout(cart.token);
  const [o1, o2] = await db('orders').where({ group_number: r.body.number }).orderBy('id');
  assert.equal((await admin('POST', `/orders/${o1.id}/pay`, {}, owner1)).status, 200);
  assert.ok(await changeStatus(db, o1.id, 'cancelled'));
  assert.deepEqual([(await db('orders').where({ id: o2.id }).first()).status, await reserved(b)], ['new', 1], 'shop 2 untouched by shop 1\'s cancel');
  await db('orders').where({ id: o2.id }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });
  await releaseExpired(db);
  assert.deepEqual([(await db('orders').where({ id: o2.id }).first()).status, await reserved(b)], ['cancelled', 0]);
  const o1now = await db('orders').where({ id: o1.id }).first();
  assert.deepEqual([o1now.status, o1now.payment_status], ['cancelled', 'paid'], 'shop 1\'s paid cancel stays as it was');
  assert.equal(await reserved(a), 0);
  const page = (await call('GET', `/api/order-groups/${new URL(r.body.track.url).pathname.split('/').pop()}`)).body;
  assert.deepEqual(page.orders.map((o) => [o.status, o.payment_status]), [['cancelled', 'paid'], ['cancelled', 'cancelled']]);
});

test('only shown shops of that mall; a shop\'s products only in its own part; limits; parallel checkouts', async () => {
  await db('carts').del();
  const p1 = await product(s1), p2 = await product(s2);
  const p3 = await db('products').where({ store_id: s3 }).first();
  assert.equal((await addOne(null, s3, { id: p3.id, size: 'M' })).status, 404, 'a shop outside the mall');
  assert.equal((await add({ mall_id: 999999, store_id: s1, items: [{ product_id: p1.id, size: p1.size }] })).status, 404, 'another mall');
  assert.equal((await addOne(null, s1, p2)).body.code, 'product_not_found', 'shop 2\'s product in shop 1\'s part');
  await db('stores').where({ id: s2 }).update({ mall_hidden: true });
  assert.equal((await addOne(null, s2, p2)).status, 404, 'a hidden shop');
  await db('stores').where({ id: s2 }).update({ mall_hidden: false });
  assert.equal((await add({ store_id: s1, items: [] })).status, 400);
  // A dead or foreign token starts a new mall cart; the plain cart routes can't add another shop to a store cart.
  const one = await addOne('f'.repeat(32), s1, p1);
  assert.equal(one.status, 200);
  assert.notEqual(one.body.token, 'f'.repeat(32));
  const plain = await call('POST', '/api/cart/items', { token: shopOf(one.body, s1).token, store_id: s2, items: [{ product_id: p2.id, size: p2.size }] });
  assert.equal(plain.status, 429, 'a second, plain cart counts against the open-carts limit (1 here)');
  // Parallel checkouts of one mall cart: one group.
  await addOne(one.body.token, s2, p2);
  const both = await Promise.all([checkout(one.body.token), checkout(one.body.token)]);
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 404]);
  assert.equal((await db('orders').where({ group_number: both.find((r) => r.status === 201).body.number })).length, 2);
  // Emptying a mall cart gives every hold back.
  const again = await addOne(null, s1, p1);
  await addOne(again.body.token, s2, p2);
  assert.equal((await call('DELETE', `/api/mall-cart/${again.body.token}`)).status, 204);
  assert.equal(await db('carts').where({ mall_token: again.body.token }).first(), undefined);
  assert.deepEqual([await reserved(p1), await reserved(p2)], [1, 1], 'only the checked-out orders hold');
  assert.equal((await call('GET', `/api/mall-cart/${again.body.token}`)).status, 404);
  assert.equal((await checkout('nope')).status, 404);
});

test('each shop sees only its own order with the mall order mark; the mall admin gets no order data', async () => {
  await db('carts').del();
  const { cart } = await twoShops();
  const r = await checkout(cart.token);
  const [o1, o2] = await db('orders').where({ group_number: r.body.number }).orderBy('id');
  // Admin list, drawer, cashier lookup and CSV of shop 1: its own order, marked; shop 2's is out of reach.
  const list = (await admin('GET', '/orders?limit=200', undefined, owner1)).body.items;
  assert.ok(list.some((o) => o.id === o1.id && o.group_number === r.body.number));
  assert.ok(!list.some((o) => o.id === o2.id));
  assert.equal((await admin('GET', `/orders/${o1.id}`, undefined, owner1)).body.group_number, r.body.number);
  assert.equal((await admin('GET', `/orders/${o2.id}`, undefined, owner1)).status, 404);
  assert.equal((await admin('POST', `/orders/${o2.id}/pay`, {}, owner1)).status, 404);
  assert.equal((await admin('GET', `/orders?number=${o2.number}&store_id=${s2}`, undefined, owner1)).body.items.length, 0);
  const csv = await fetch(`${base}/api/admin/orders/export`, { headers: { authorization: `Bearer ${owner1}` } }).then((x) => x.text());
  const shop2 = (await db('stores').where({ id: s2 }).first()).name;
  assert.ok(csv.split('\n')[0].includes(t('adm.csv.mall_order', {}, 'uz')), 'the CSV has the mall order column');
  assert.ok(!csv.includes(shop2));
  const csv2 = await fetch(`${base}/api/admin/orders/export`, { headers: { authorization: `Bearer ${owner2}` } }).then((x) => x.text());
  assert.ok(!csv2.includes((await db('stores').where({ id: s1 }).first()).name));
  // Staff app of shop 1: its paid order only, marked; no sums.
  assert.equal((await admin('POST', `/orders/${o1.id}/pay`, {}, owner1)).status, 200);
  assert.equal((await admin('POST', `/orders/${o2.id}/pay`, {}, owner2)).status, 200);
  const floor = (await admin('GET', '/staff', undefined, staff1)).body.orders;
  assert.ok(floor.some((o) => o.id === o1.id && o.group_number === r.body.number));
  assert.ok(!floor.some((o) => o.id === o2.id));
  assert.equal((await admin('POST', `/orders/${o2.id}/status`, { status: 'packing' }, staff1)).status, 404);
  // The mall admin: 403 on order routes, counts only on the dashboard.
  for (const p of ['/orders', `/orders/${o1.id}`, '/orders/export', '/staff']) assert.equal((await admin('GET', p, undefined, mallAdmin)).status, 403, p);
  const dash = await admin('GET', '/mall', undefined, mallAdmin);
  assert.equal(dash.status, 200);
  assert.ok(!/Malika|935554433|"total"\s*:\s*[1-9]\d{4}/.test(JSON.stringify(dash.body)));
});

test('migration 028 down and up', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await seed(m);
    assert.ok('group_number' in (await m('orders').columnInfo()));
    await m.migrate.down(); // 038
    await m.migrate.down(); // 037
    await m.migrate.down(); // 036
    await m.migrate.down(); // 035
    await m.migrate.down(); // 034
    await m.migrate.down(); // 033
    await m.migrate.down(); // 032
    await m.migrate.down(); // 031
    await m.migrate.down(); // 030
    await m.migrate.down(); // 029
    await m.migrate.down(); // 028
    assert.ok(!('group_number' in (await m('orders').columnInfo())));
    assert.ok(!('mall_token' in (await m('carts').columnInfo())));
    assert.ok(!('order_seq' in (await m('malls').columnInfo())));
    assert.equal(await m.schema.hasTable('order_groups'), false);
    await m.migrate.latest();
    assert.ok('mall_token' in (await m('carts').columnInfo()));
  } finally {
    await m.destroy();
  }
});
