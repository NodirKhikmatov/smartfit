// Task 50: who sold it. The seller is set once: the cashier who took the money, else whoever hands the order over; the
// one who served its fitting-room request comes first; an online order has none until it is handed over; a super-admin
// is never one. Commission = floor(percent × (total − delivery fee)), the percent frozen on the order; a return takes it
// back so that partial returns add up to a full one. The personal percent; the report (manager: own store, owner: own
// organisation, staff and mall: 403) and its CSV; "Mening sotuvlarim" = the caller's own numbers only; a mall group
// order's parts each have their own seller; migration 040.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { testDb, json } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { insertOrder, markPaid, storeOf } from '../src/cart/cart.js';
import { commission } from '../src/admin/sellers.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, a1, a2, b1, mall, ownerA, managerA1, managerA2, staff1, staff2, ownerB, superToken, mallToken;
const ids = {};

const call = async (method, p, body, token) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
};
const admin = (method, p, body, token) => call(method, `/api/admin${p}`, body, token);
const login = async (email, password) => (await admin('POST', '/login', { email, password })).body.token;
const sellerOf = (id) => db('orders').where({ id }).first('seller_id', 'seller_percent');
const hex = () => randomBytes(16).toString('hex');

// A product in `store` with 100 of S/M/L at this price.
async function product(store, price) {
  const p = await db('products').where({ store_id: a1, category: 'top', audience: 'adult' }).orderBy('id').first();
  const { id: _i, sku: _s, barcode: _b, created_at: _c, updated_at: _u, ...rest } = p;
  const [{ id }] = await db('products').insert({ ...rest, store_id: store, name: `Sotuv ${price}`, price, discount_price: null }).returning('id');
  await db('product_stock').insert(['S', 'M', 'L'].map((size) => ({ product_id: id, size, quantity: 100 })));
  return db('products').where({ id }).first();
}
// One unpaid order straight through insertOrder (as a checkout makes it). Lines = [[product, quantity]].
async function order(storeId, lines, { delivery = false, promo = 0, points = 0, method = 'cashier', rec = null, group = {} } = {}) {
  const store = await storeOf(db, storeId);
  return db.transaction(async (trx) => {
    for (const [p, q] of lines) await trx('product_stock').where({ product_id: p.id, size: 'M' }).increment('reserved', q);
    return insertOrder(trx, store, { customer_name: 'Aziz', phone: '+998901234567', fulfillment: delivery ? 'delivery' : 'pickup', address: delivery ? 'Chilonzor 5' : null, lat: null, lon: null },
      lines.map(([p, quantity]) => ({ product_id: p.id, size: 'M', quantity, unit_price: p.price })),
      { method, notifyToken: hex(), recommendationId: rec, pr: { bundle_discount: 0, promo_discount: promo, discounts: lines.map((_, i) => (i === 0 ? promo : 0)) }, points, group });
  });
}
const pay = (id, token) => admin('POST', `/orders/${id}/pay`, { method: 'cash' }, token);
const step = (id, status, token) => admin('POST', `/orders/${id}/status`, { status }, token);
async function handOver(id, token) {
  for (const s of ['packing', 'delivered']) assert.equal((await step(id, s, token)).status, 200);
}
const report = async (token, q = '') => {
  const r = await admin('GET', `/sellers${q}`, undefined, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
// Earlier tests' sales and returns moved to 2019, so this month's numbers below are this test's own.
async function slate() {
  const old = '2019-06-01T00:00:00.000Z';
  await db('orders').whereNotNull('paid_at').update({ paid_at: old });
  await db('orders').whereNotNull('seller_at').update({ seller_at: old });
  await db('order_returns').update({ created_at: '2019-06-01 00:00:00' });
}
const rowOf = (rep, id) => rep.sellers.find((x) => x.seller_id === id);

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [a1, b1] = (await db('stores').orderBy('id')).map((s) => s.id);
  mall = (await db('malls').first()).id;
  const orgA = (await db('stores').where({ id: a1 }).first()).organization_id;
  [{ id: a2 }] = await db('stores').insert({ name: 'A filial', city: 'Toshkent', address: 'Chilonzor 1', lat: 41.28, lon: 69.2, organization_id: orgA }).returning('id');
  const people = [['owner.a@smartfit.uz', 'owner-pass-1', a1, 'owner'], ['mgr.a1@smartfit.uz', 'mgr-pass-1', a1, 'manager'], ['mgr.a2@smartfit.uz', 'mgr-pass-2', a2, 'manager'],
    ['staff.a1@smartfit.uz', 'staff-pass-1', a1, 'staff'], ['staff2.a1@smartfit.uz', 'staff-pass-2', a1, 'staff'], ['owner.b@smartfit.uz', 'owner-pass-2', b1, 'owner']];
  for (const [email, password, storeId, role] of people) await createAdmin(db, { email, password, storeId, role });
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  await createAdmin(db, { email: 'mall@smartfit.uz', password: 'mall-pass-1', mallId: mall });
  for (const a of await db('admins').select('id', 'email')) ids[a.email.split('@')[0]] = a.id;
  server = createApp(db, { telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }),
    limits: { recommend: 0, cart: 0, catalog: 0, mall: 0, promo: 0 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  [ownerA, managerA1, managerA2, staff1, staff2, ownerB, superToken, mallToken] = await Promise.all([['owner.a', 'owner-pass-1'], ['mgr.a1', 'mgr-pass-1'], ['mgr.a2', 'mgr-pass-2'],
    ['staff.a1', 'staff-pass-1'], ['staff2.a1', 'staff-pass-2'], ['owner.b', 'owner-pass-2'], ['boss', 'boss-pass-1'], ['mall', 'mall-pass-1']].map(([u, p]) => login(`${u}@smartfit.uz`, p)));
  // Store a1: commission 7 %, a delivery fee; store b1 commission 5 %.
  assert.equal((await admin('PATCH', `/stores/${a1}`, { commission_percent: 7, delivery_fee: 25000, free_delivery_threshold: null }, ownerA)).status, 200);
  assert.equal((await admin('PATCH', `/stores/${b1}`, { commission_percent: 5 }, ownerB)).status, 200);
});
after(async () => {
  server.close();
  await db.destroy();
});

test('commission rounds down to whole so\'m and never goes below zero', () => {
  assert.equal(commission(231914, 7), 16233); // 16233.98
  assert.equal(commission(100, 7), 7);
  assert.equal(commission(99, 1), 0);
  assert.equal(commission(-5, 10), 0);
  assert.equal(commission(1000, null), 0);
});

test('store setting: owner sets 0…50, manager read-only, staff and mall refused, audited', async () => {
  const get = await admin('GET', `/stores/${a1}`, undefined, managerA1);
  assert.equal(get.body.commission_percent, 7);
  assert.equal((await admin('PATCH', `/stores/${a1}`, { commission_percent: 8 }, managerA1)).status, 403);
  for (const bad of [-1, 51, 2.5, '7']) assert.equal((await admin('PATCH', `/stores/${a1}`, { commission_percent: bad }, ownerA)).status, 400, `percent ${bad}`);
  for (const tok of [staff1, mallToken]) assert.equal((await admin('PATCH', `/stores/${a1}`, { commission_percent: 9 }, tok)).status, 403);
  assert.equal((await admin('PATCH', `/stores/${a1}`, { commission_percent: 9 }, ownerB)).status, 404, 'another organisation');
  assert.equal((await db('stores').where({ id: a1 }).first()).commission_percent, 7);
  const row = await db('audit_log').where({ action: 'store.update', entity_id: a1 }).orderBy('id', 'desc').first();
  assert.equal(json(row.after).commission_percent, 7);
});

test('the seller is set once: cashier, hand-over, fitting room, online, super; the percent is frozen', async () => {
  const p = await product(a1, 100000);
  // Cashier: the manager who takes the money; a later hand-over by staff changes nothing.
  const o1 = await order(a1, [[p, 1]]);
  assert.equal((await pay(o1, managerA1)).status, 200);
  assert.deepEqual(await sellerOf(o1), { seller_id: ids['mgr.a1'], seller_percent: 7 });
  await handOver(o1, staff1);
  assert.equal((await sellerOf(o1)).seller_id, ids['mgr.a1'], 'not overwritten by the hand-over');
  // Online (Click/Payme): no seller until a staff member hands it over; the packing step is not a hand-over.
  const o2 = await order(a1, [[p, 1]], { method: 'click' });
  assert.equal(await markPaid(db, o2), true);
  assert.equal((await sellerOf(o2)).seller_id, null);
  assert.equal((await step(o2, 'packing', staff1)).status, 200);
  assert.equal((await sellerOf(o2)).seller_id, null);
  assert.equal((await step(o2, 'delivered', staff2)).status, 200);
  assert.deepEqual(await sellerOf(o2), { seller_id: ids['staff2.a1'], seller_percent: 7 });
  // Fitting room: the one who accepted the request wins over the cashier (and over whoever closed it).
  const [{ id: rec }] = await db('recommendation_logs').insert({ store_id: a1, product_ids: '[]', source: 'rules' }).returning('id');
  await db('fitting_requests').insert({ store_id: a1, recommendation_id: rec, cabin: 3, items: '[]', status: 'done', accepted_by: ids['staff.a1'], accepted_at: new Date().toISOString(), done_by: ids['staff2.a1'] });
  const o3 = await order(a1, [[p, 1]], { rec });
  assert.equal((await pay(o3, managerA1)).status, 200);
  assert.equal((await sellerOf(o3)).seller_id, ids['staff.a1']);
  // A request of another store with the same recommendation doesn't count.
  const [{ id: rec2 }] = await db('recommendation_logs').insert({ store_id: a1, product_ids: '[]', source: 'rules' }).returning('id');
  await db('fitting_requests').insert({ store_id: a2, recommendation_id: rec2, cabin: 1, items: '[]', accepted_by: ids['mgr.a2'] });
  const o4 = await order(a1, [[p, 1]], { rec: rec2 });
  assert.equal((await pay(o4, managerA1)).status, 200);
  assert.equal((await sellerOf(o4)).seller_id, ids['mgr.a1']);
  // A super-admin at the cashier is never the seller; the hand-over then sets it.
  const o5 = await order(a1, [[p, 1]]);
  assert.equal((await pay(o5, superToken)).status, 200);
  assert.equal((await sellerOf(o5)).seller_id, null);
  await handOver(o5, staff1);
  assert.equal((await sellerOf(o5)).seller_id, ids['staff.a1']);
  // A super hand-over of an online order leaves it without a seller.
  const o6 = await order(a1, [[p, 1]], { method: 'payme' });
  await markPaid(db, o6);
  await handOver(o6, superToken);
  assert.equal((await sellerOf(o6)).seller_id, null);
  // The percent is the one in force then: a store change later rewrites nothing.
  assert.equal((await admin('PATCH', `/stores/${a1}`, { commission_percent: 9 }, ownerA)).status, 200);
  assert.equal((await sellerOf(o1)).seller_percent, 7);
  assert.equal((await admin('PATCH', `/stores/${a1}`, { commission_percent: 7 }, ownerA)).status, 200);
});

test('personal percent: owner sets it per member, null = the store\'s; manager, other org and a mall admin refused', async () => {
  const set = (id, v, token = ownerA) => admin('PATCH', `/team/${id}`, { commission_percent: v }, token);
  const r = await set(ids['staff.a1'], 3);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.commission_percent, 3);
  assert.equal((await admin('GET', '/team', undefined, ownerA)).body.members.find((m) => m.id === ids['staff.a1']).commission_percent, 3);
  for (const bad of [-1, 51, 1.5, 'x']) assert.equal((await set(ids['staff.a1'], bad)).status, 400, `percent ${bad}`);
  assert.equal((await set(ids['staff.a1'], 4, managerA1)).status, 403, 'a manager cannot');
  assert.equal((await set(ids['staff.a1'], 4, ownerB)).status, 404, 'another organisation');
  assert.equal((await set(ids['owner.a'], 4)).status, 404, 'not yourself');
  assert.equal((await set(ids.mall, 4, superToken)).status, 400, 'a mall admin never sells');
  assert.equal((await db('admins').where({ id: ids['staff.a1'] }).first()).commission_percent, 3);
  const audited = await db('audit_log').where({ action: 'team.commission', entity_id: ids['staff.a1'] }).first();
  assert.equal(json(audited.after).commission_percent, 3);

  const p = await product(a1, 50000);
  const o = await order(a1, [[p, 1]]);
  await pay(o, superToken);
  await handOver(o, staff1);
  assert.deepEqual(await sellerOf(o), { seller_id: ids['staff.a1'], seller_percent: 3 }, 'personal percent wins');
  const o2 = await order(a1, [[p, 1]]);
  await pay(o2, superToken);
  await handOver(o2, staff2);
  assert.equal((await sellerOf(o2)).seller_percent, 7, 'no personal percent: the store\'s');
  assert.equal((await set(ids['staff.a1'], null)).body.commission_percent, null);
});

test('commission on the paid sum after promo and points, without delivery; a partial then a full return take it back', async () => {
  await slate();
  const p = await product(a1, 123457);
  // 2 × 123 457 − promo 10 000 − points 5 000 + delivery 25 000 = 256 914; the sold sum is 231 914.
  const o = await order(a1, [[p, 2]], { delivery: true, promo: 10000, points: 5000 });
  const row = await db('orders').where({ id: o }).first();
  assert.deepEqual([row.total, row.delivery_fee], [256914, 25000]);
  assert.equal((await pay(o, managerA1)).status, 200);
  for (const s of ['packing', 'shipping', 'delivered']) assert.equal((await step(o, s, staff1)).status, 200);
  let rep = await report(managerA1);
  assert.deepEqual(rowOf(rep, ids['mgr.a1']), { ...rowOf(rep, ids['mgr.a1']), orders: 1, sum: 231914, returns: 0, refunded: 0, commission: 16233 });
  // Partial return of one unit: refund 115 957 (half the line after its discounts); the order keeps floor(7 % × 115 957) = 8116.
  const item = await db('order_items').where({ order_id: o }).first();
  const ret = (q) => admin('POST', `/orders/${o}/returns`, { key: hex(), item_id: item.id, kind: 'return', reason: 'too_small', quantity: q, restock: true }, managerA1);
  assert.equal((await ret(1)).status, 201);
  rep = await report(managerA1);
  assert.deepEqual([rowOf(rep, ids['mgr.a1']).returns, rowOf(rep, ids['mgr.a1']).refunded, rowOf(rep, ids['mgr.a1']).commission], [1, 115957, 8116]);
  // The rest: nothing is left, to the so'm.
  assert.equal((await ret(1)).status, 201);
  rep = await report(managerA1);
  assert.deepEqual([rowOf(rep, ids['mgr.a1']).orders, rowOf(rep, ids['mgr.a1']).returns, rowOf(rep, ids['mgr.a1']).refunded, rowOf(rep, ids['mgr.a1']).commission], [1, 2, 231914, 0]);
  // An exchange moves no money and no commission.
  const o2 = await order(a1, [[p, 1]]);
  await pay(o2, managerA1);
  await handOver(o2, staff1);
  const item2 = await db('order_items').where({ order_id: o2 }).first();
  assert.equal((await admin('POST', `/orders/${o2}/returns`, { key: hex(), item_id: item2.id, kind: 'exchange', reason: 'too_small', quantity: 1, restock: true, new_size: 'L' }, managerA1)).status, 201);
  rep = await report(managerA1);
  assert.deepEqual([rowOf(rep, ids['mgr.a1']).orders, rowOf(rep, ids['mgr.a1']).returns, rowOf(rep, ids['mgr.a1']).commission], [2, 2, commission(123457, 7)]);
  // A paid order cancelled before it left the store counts nowhere.
  const o3 = await order(a1, [[p, 1]]);
  await pay(o3, managerA1);
  assert.equal((await step(o3, 'cancelled', managerA1)).status, 200);
  assert.equal(rowOf(await report(managerA1), ids['mgr.a1']).orders, 2);
  // A return made in a later period takes the commission back then, not from the sale's period.
  const today = (await report(managerA1)).to;
  await db('order_returns').where({ order_id: o }).update({ created_at: '2020-01-15 10:00:00' });
  rep = await report(managerA1, `?from=${today}&to=${today}`);
  assert.equal(rowOf(rep, ids['mgr.a1']).commission, 16233 + commission(123457, 7));
  const old = await report(managerA1, '?from=2020-01-01&to=2020-01-31');
  assert.deepEqual([rowOf(old, ids['mgr.a1']).orders, rowOf(old, ids['mgr.a1']).returns, rowOf(old, ids['mgr.a1']).commission], [0, 2, -16233]);
});

test('report and "Mening sotuvlarim": manager own store, owner own organisation, staff only themselves; mall and staff refused', async () => {
  await slate();
  const p1 = await product(a1, 100000), p2 = await product(a2, 200000), pb = await product(b1, 300000);
  const sell = async (store, prod, payer, hander) => {
    const o = await order(store, [[prod, 1]]);
    assert.equal((await pay(o, payer)).status, 200);
    if (hander) await handOver(o, hander);
    return o;
  };
  await sell(a1, p1, superToken, staff1); // staff1: 100 000 at 7 %
  await sell(a1, p1, superToken, staff1); // staff1: 2 orders
  await sell(a1, p1, superToken, staff2); // staff2: 1 order
  await sell(a2, p2, managerA2); // manager A2: 200 000
  await sell(b1, pb, ownerB); // owner B: 300 000 at 5 %
  const online = await order(a1, [[p1, 1]], { method: 'click' });
  await markPaid(db, online); // paid, nobody sold it yet

  const m1 = await report(managerA1);
  assert.deepEqual(m1.sellers.map((x) => x.seller_id).sort(), [ids['staff.a1'], ids['staff2.a1']].sort(), 'manager: their store only');
  assert.deepEqual([rowOf(m1, ids['staff.a1']).orders, rowOf(m1, ids['staff.a1']).sum, rowOf(m1, ids['staff.a1']).commission, rowOf(m1, ids['staff.a1']).percent], [2, 200000, 14000, 7]);
  assert.deepEqual(m1.no_seller, { orders: 1, sum: 100000 });
  assert.deepEqual(m1.totals, { orders: 3, sum: 300000, returns: 0, refunded: 0, commission: 21000 });
  assert.equal((await report(managerA1, `?store_id=${a2}`)).sellers.length, 0, '?store_id cannot widen');
  assert.deepEqual((await report(managerA2)).sellers.map((x) => x.seller_id), [ids['mgr.a2']]);
  const oA = await report(ownerA);
  assert.equal(oA.sellers.length, 3, 'owner: both stores of the organisation');
  assert.ok(!oA.sellers.some((x) => x.seller_id === ids['owner.b']));
  assert.deepEqual((await report(ownerA, `?store_id=${a2}`)).sellers.map((x) => x.seller_id), [ids['mgr.a2']]);
  assert.equal((await report(ownerA, `?store_id=${b1}`)).sellers.length, 0);
  assert.deepEqual((await report(ownerB)).sellers.map((x) => [x.seller_id, x.commission]), [[ids['owner.b'], 15000]]);
  assert.equal((await report(superToken)).sellers.length, 4);
  for (const tok of [staff1, mallToken]) {
    assert.equal((await admin('GET', '/sellers', undefined, tok)).status, 403);
    assert.equal((await admin('GET', '/sellers/export', undefined, tok)).status, 403);
  }
  assert.equal((await admin('GET', '/me/sales', undefined, mallToken)).status, 403, 'the mall admin never sees any of it');
  for (const q of ['?from=2026-02-30', '?from=2026-05-02&to=2026-05-01', '?from=2020-01-01&to=2026-01-01', '?to=x']) assert.equal((await admin('GET', `/sellers${q}`, undefined, ownerA)).status, 400, q);

  // CSV: one row per seller, the total and the orders with no seller.
  const res = await fetch(`${base}/api/admin/sellers/export?lang=uz`, { headers: { authorization: `Bearer ${managerA1}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  assert.ok(csv.includes('staff.a1@smartfit.uz') && csv.includes('14000') && csv.includes('Sotuvchisiz'), csv);
  assert.ok(!csv.includes('mgr.a2@') && !csv.includes('owner.b@'));

  // Staff: their own numbers, never anyone else's; the same numbers as the report.
  const mine = await admin('GET', '/me/sales', undefined, staff1);
  assert.equal(mine.status, 200);
  assert.deepEqual([mine.body.orders, mine.body.sum, mine.body.commission, mine.body.percent], [2, 200000, 14000, 7]);
  assert.ok(!JSON.stringify(mine.body).includes('@'), 'no other person in it');
  assert.equal((await admin('GET', '/me/sales?seller_id=' + ids['staff2.a1'], undefined, staff1)).body.orders, 2, 'a parameter cannot read someone else');
  assert.equal((await admin('GET', '/me/sales', undefined, staff2)).body.orders, 1);
  assert.equal((await admin('GET', '/me/sales?period=today', undefined, staff1)).body.orders, 2);
  assert.equal((await admin('GET', '/me/sales?period=last_month', undefined, staff1)).body.orders, 0);
  assert.equal((await admin('GET', '/me/sales?period=year', undefined, staff1)).status, 400);
  assert.equal((await admin('GET', '/me/sales', undefined, superToken)).body.orders, 0, 'a super-admin never sells');
});

test('a mall group order: each shop\'s part is its own order with its own seller and its own shop\'s percent', async () => {
  await slate();
  const [{ id: gid }] = await db('order_groups').insert({ mall_id: mall, number: 77, token: hex() }).returning('id');
  const group = { group_id: gid, group_number: 77 };
  const pa = await product(a1, 100000), pb = await product(b1, 100000);
  const partA = await order(a1, [[pa, 1]], { group }), partB = await order(b1, [[pb, 1]], { group });
  assert.equal((await pay(partA, managerA1)).status, 200);
  assert.deepEqual(await sellerOf(partA), { seller_id: ids['mgr.a1'], seller_percent: 7 });
  assert.equal((await sellerOf(partB)).seller_id, null, 'the other shop\'s part waits for its own cashier');
  assert.equal((await pay(partB, managerA1)).status, 404, 'shop A cannot take shop B\'s part');
  assert.equal((await pay(partB, ownerB)).status, 200);
  assert.deepEqual(await sellerOf(partB), { seller_id: ids['owner.b'], seller_percent: 5 });
  assert.deepEqual((await report(ownerB)).sellers.map((x) => [x.seller_id, x.commission]), [[ids['owner.b'], 5000]]);
  assert.deepEqual((await report(managerA1)).sellers.map((x) => [x.seller_id, x.commission]), [[ids['mgr.a1'], 7000]]);
});

test('migration 040: down drops the seller and commission columns, up brings them back', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await m.migrate.down(); // 042
    await m.migrate.down(); // 041
    await m.migrate.down(); // 040
    for (const [t, c] of [['orders', 'seller_id'], ['orders', 'seller_at'], ['orders', 'seller_percent'], ['stores', 'commission_percent'], ['admins', 'commission_percent']]) {
      assert.equal(await m.schema.hasColumn(t, c), false, `${t}.${c}`);
    }
    await m.migrate.latest();
    assert.ok(await m.schema.hasColumn('orders', 'seller_id'));
    assert.ok(await m.schema.hasColumn('stores', 'commission_percent'));
  } finally {
    await m.destroy();
  }
});
