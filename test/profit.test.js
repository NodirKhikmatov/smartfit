// Task 49: cost price and profit. The cost in the product form and the CSV; receiving with a "kirim narxi" (weighted
// average, applied once, staff can't set it); the cost frozen on the order line at the sale; the profit report with a
// bundle discount, a promo code, points, a return and a line sold below cost; a product without a cost counted apart;
// no cost in any customer, staff, mall or sync response (every response of this file is recorded and checked); org
// and store isolation; migration 039.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import express from 'express';
import { testDb, json } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin, createAdminRouter } from '../src/admin/routes.js';
import { insertOrder, markPaid, storeOf } from '../src/cart/cart.js';
import { lineProfit } from '../src/admin/profit.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, a1, a2, b1, mall, orgA, ownerA, managerA1, managerA2, staff1, ownerB, superToken, mallToken;

// Every response body of this file, with the token that asked. The leak test checks the ones not asked by super,
// an owner or a manager. express.response.send carries res.json too (it serialises, then sends).
const seen = [];
const send = express.response.send;
express.response.send = function (body) {
  seen.push({ who: (this.req.get('authorization') || '').slice(7), call: `${this.req.method} ${this.req.originalUrl}`, status: this.statusCode, body: Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '') });
  return send.call(this, body);
};

const call = async (method, p, body, token, raw) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': raw ? 'text/csv' : 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
};
const admin = (method, p, body, token, raw) => call(method, `/api/admin${p}`, body, token, raw);
const login = async (email, password) => (await admin('POST', '/login', { email, password })).body.token;
const costOf = async (id) => (await db('products').where({ id }).first('cost')).cost;
const top = (store, n = 0) => db('products').where({ store_id: store, category: 'top', audience: 'adult' }).orderBy('id').offset(n).first();
const scan = (token, session, product, size, quantity, extra = {}) => admin('POST', '/stock/scans', { key: randomUUID(), session: session.key, product_id: product.id, size, quantity, ...extra }, token);
async function openSession(token, body) {
  const r = await admin('POST', '/stock/sessions', { key: randomUUID(), ...body }, token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
// A copy of store a1's first top in `store` (sizes, category), with this price / cost and 100 of each size.
async function product(store, { price, cost = null, name }) {
  const { id: _i, sku: _s, barcode: _b, created_at: _c, updated_at: _u, ...p } = await top(a1);
  const [{ id }] = await db('products').insert({ ...p, store_id: store, name, price, discount_price: null, cost }).returning('id');
  await db('product_stock').insert(['S', 'M', 'L'].map((size) => ({ product_id: id, size, quantity: 100 })));
  return db('products').where({ id }).first();
}
// insertOrder expects the caller to hold the units already (a cart does that).
const hold = (trx, lines) => Promise.all(lines.map(([p, q]) => trx('product_stock').where({ product_id: p.id, size: 'M' }).increment('reserved', q)));
// One paid order straight through insertOrder + markPaid. lines = [[product, quantity]]; pr = discounts as price() gives them.
async function paidOrder(storeId, lines, { bundle = 0, promo = 0, code = null, points = 0, discounts = lines.map(() => 0) } = {}) {
  const store = await storeOf(db, storeId);
  const id = await db.transaction(async (trx) => (await hold(trx, lines), insertOrder(trx, store, { customer_name: 'Aziz', phone: '+998901234567', fulfillment: 'pickup', address: null, lat: null, lon: null },
    lines.map(([p, quantity]) => ({ product_id: p.id, size: 'M', quantity, unit_price: p.price })),
    { notifyToken: randomBytes(16).toString('hex'), pr: { bundle_discount: bundle, promo_discount: promo, discounts }, promo: code && { id: null, code }, points })));
  assert.equal(await markPaid(db, id), true);
  return db('orders').where({ id }).first();
}

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [a1, b1] = (await db('stores').orderBy('id')).map((s) => s.id);
  mall = (await db('malls').first()).id;
  orgA = (await db('stores').where({ id: a1 }).first()).organization_id;
  [{ id: a2 }] = await db('stores').insert({ name: 'A filial', city: 'Toshkent', address: 'Chilonzor 1', lat: 41.28, lon: 69.2, organization_id: orgA }).returning('id');
  await createAdmin(db, { email: 'owner.a@smartfit.uz', password: 'owner-pass-1', storeId: a1 });
  await createAdmin(db, { email: 'mgr.a1@smartfit.uz', password: 'mgr-pass-1', storeId: a1, role: 'manager' });
  await createAdmin(db, { email: 'mgr.a2@smartfit.uz', password: 'mgr-pass-2', storeId: a2, role: 'manager' });
  await createAdmin(db, { email: 'staff.a1@smartfit.uz', password: 'staff-pass-1', storeId: a1, role: 'staff' });
  await createAdmin(db, { email: 'owner.b@smartfit.uz', password: 'owner-pass-2', storeId: b1 });
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  await createAdmin(db, { email: 'mall@smartfit.uz', password: 'mall-pass-1', mallId: mall });
  server = createApp(db, { telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }),
    limits: { recommend: 0, cart: 0, catalog: 0, mall: 0, promo: 0 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  ownerA = await login('owner.a@smartfit.uz', 'owner-pass-1');
  managerA1 = await login('mgr.a1@smartfit.uz', 'mgr-pass-1');
  managerA2 = await login('mgr.a2@smartfit.uz', 'mgr-pass-2');
  staff1 = await login('staff.a1@smartfit.uz', 'staff-pass-1');
  ownerB = await login('owner.b@smartfit.uz', 'owner-pass-2');
  superToken = await login('boss@smartfit.uz', 'boss-pass-1');
  mallToken = await login('mall@smartfit.uz', 'mall-pass-1');
});
after(async () => {
  express.response.send = send;
  server.close();
  await db.destroy();
});

test('product form and CSV: the cost is set, kept on a partial edit, cleared, validated; owner B cannot touch it', async () => {
  const p = await top(a1);
  const set = (body, token = managerA1) => admin('PATCH', `/products/${p.id}`, body, token);
  const r = await set({ cost: 61000 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cost, 61000, 'the manager sees and sets it');
  assert.equal((await set({ name: p.name })).body.cost, 61000, 'a partial edit keeps it');
  for (const bad of [-1, 1.5, '12a', 2e9]) {
    const x = await set({ cost: bad });
    assert.equal(x.status, 400, `cost ${bad}`);
    assert.equal(x.body.code, 'invalid');
  }
  assert.equal(await costOf(p.id), 61000);
  assert.equal((await set({ cost: null })).body.cost, null, 'cleared');
  assert.equal((await set({ cost: 61000 }, ownerB)).status, 404, 'another organisation: not found');
  assert.equal(await costOf(p.id), null);
  // A new product with a cost.
  const { body: made, status } = await admin('POST', '/products', { name: 'Tannarx ko\'ylak', category: 'top', gender: 'male', color: 'oq', price: 150000, cost: 90000, temp_min: 0, temp_max: 30 }, ownerA);
  assert.equal(status, 201, JSON.stringify(made));
  assert.equal(made.cost, 90000);
  // CSV: the `cost` column in and out; a bad cell names the field.
  const csv = `id;name;cost\n${made.id};Tannarx ko'ylak;95 000\n`;
  const imp = await admin('POST', '/products/import', undefined, ownerA, csv);
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(await costOf(made.id), 95000);
  const bad = await admin('POST', '/products/import', undefined, ownerA, `id;cost\n${made.id};arzon\n`);
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.body), /Tannarx/);
  const out = await admin('GET', `/products/export?store_id=${a1}`, undefined, ownerA);
  const lines = out.body.replace(/^﻿/, '').split('\r\n');
  const head = lines[0].split(';').map((c) => c.replace(/"/g, ''));
  const row = lines.find((l) => l.startsWith(`"${made.id}";`)).split(';').map((c) => c.replace(/"/g, ''));
  assert.equal(row[head.indexOf('cost')], '95000');
  assert.equal((await admin('POST', '/products/import', undefined, ownerA, `id;cost\n${made.id};\n`)).status, 200);
  assert.equal(await costOf(made.id), 95000, 'on an update row an empty cell keeps the value (as for every column)');
  // The audit log keeps the change (owners and super read it).
  const log = await db('audit_log').where({ action: 'product.update', entity_id: p.id }).orderBy('id', 'desc').first();
  assert.ok('cost' in json(log.before) && 'cost' in json(log.after));
});

test('receiving: "kirim narxi" makes the cost the weighted average, once; staff cannot set it; a count takes none', async () => {
  const p = await product(a1, { price: 200000, cost: 100000, name: 'Kirim ko\'ylak' });
  await db('product_stock').where({ product_id: p.id }).update({ quantity: 0 });
  await db('product_stock').where({ product_id: p.id, size: 'M' }).update({ quantity: 10 });
  const s = await openSession(managerA1, { kind: 'receive', note: 'Faktura 49' });
  const key = randomUUID();
  const body = { key, session: s.key, product_id: p.id, size: 'L', quantity: 5, cost: 130000 };
  const r = await admin('POST', '/stock/scans', body, managerA1);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.cost, 110000, '(10 × 100 000 + 5 × 130 000) / 15');
  assert.equal(await costOf(p.id), 110000);
  // The same scan again (offline queue replay): nothing applied twice.
  const again = await admin('POST', '/stock/scans', body, managerA1);
  assert.equal(again.body.replay, true);
  assert.equal(await costOf(p.id), 110000);
  assert.equal((await db('product_stock').where({ product_id: p.id, size: 'L' }).first()).quantity, 5);
  // Rounded to whole so'm: 15 × 110 000 + 1 × 110 001 over 16.
  assert.equal((await scan(managerA1, s, p, 'S', 1, { cost: 110001 })).body.cost, 110000);
  // Without a cost the cost stays.
  assert.equal((await scan(managerA1, s, p, 'S', 4)).status, 201);
  assert.equal(await costOf(p.id), 110000);
  // Staff receive, but never set (or see) a cost: refused, nothing applied.
  const stocked = (await db('product_stock').where({ product_id: p.id, size: 'S' }).first()).quantity;
  const st = await scan(staff1, s, p, 'S', 3, { cost: 1 });
  assert.equal(st.status, 403);
  assert.equal((await db('product_stock').where({ product_id: p.id, size: 'S' }).first()).quantity, stocked);
  assert.equal(await costOf(p.id), 110000);
  assert.equal((await scan(managerA1, s, p, 'S', 1, { cost: -5 })).status, 400);
  // An unknown old cost, or no stock left: the delivery's cost as it is.
  const q = await product(a1, { price: 90000, name: 'Narxsiz' });
  assert.equal((await scan(ownerA, s, q, 'M', 2, { cost: 40000 })).body.cost, 40000);
  // A count records units, never a cost.
  const c = await openSession(managerA1, { kind: 'count', shelf: p.shelf_location });
  assert.equal((await scan(managerA1, c, p, 'M', 1, { cost: 1 })).status, 400);
  // The audit row keeps the cost before and after.
  const log = await db('audit_log').where({ action: 'stock.receive', entity_id: p.id }).orderBy('id').first();
  assert.equal(json(log.before).cost, 100000);
  assert.equal(json(log.after).cost, 110000);
  // Another organisation's manager can't scan into this session.
  assert.equal((await scan(ownerB, s, p, 'M', 1, { cost: 1 })).status, 404);
});

test('the cost is copied onto the order line at the sale; a later change leaves it', async () => {
  const p = await product(a1, { price: 180000, cost: 70000, name: 'Muzlatilgan' });
  const store = await storeOf(db, a1);
  const id = await db.transaction(async (trx) => (await hold(trx, [[p, 1]]), insertOrder(trx, store, { customer_name: 'Aziz', phone: '+998901234567', fulfillment: 'pickup', address: null, lat: null, lon: null },
    [{ product_id: p.id, size: 'M', quantity: 1, unit_price: p.price }], { notifyToken: randomBytes(16).toString('hex') })));
  assert.equal((await db('order_items').where({ order_id: id }).first()).unit_cost, null, 'not sold yet');
  await db('products').where({ id: p.id }).update({ cost: 75000 });
  assert.equal((await admin('POST', `/orders/${id}/pay`, { method: 'cash' }, managerA1)).status, 200);
  assert.equal((await db('order_items').where({ order_id: id }).first()).unit_cost, 75000, 'the cost at the sale');
  await admin('PATCH', `/products/${p.id}`, { cost: 99000 }, ownerA);
  assert.equal((await db('order_items').where({ order_id: id }).first()).unit_cost, 75000, 'kept');
  // Nor does the order view (a customer's status page shares it) carry it.
  const o = await admin('GET', `/orders/${id}`, undefined, managerA1);
  assert.ok(!JSON.stringify(o.body).includes('cost'));
});

test('lineProfit: discounts, a return put back, one written off, no cost, below cost', () => {
  const l = { quantity: 2, unit_price: 200000, discount: 30000, unit_cost: 120000 };
  assert.deepEqual(lineProfit(l), { units: 2, revenue: 370000, cost: 240000, below: false, paid: 370000 });
  assert.deepEqual(lineProfit({ ...l, back_units: 1, refund: 185000, restocked: 1 }), { units: 1, revenue: 185000, cost: 120000, below: false, paid: 370000 });
  assert.equal(lineProfit({ ...l, back_units: 1, refund: 185000, restocked: 0 }).cost, 240000, 'a written-off unit keeps its cost');
  assert.equal(lineProfit({ ...l, unit_cost: null }).cost, null);
  assert.equal(lineProfit({ ...l, unit_cost: 190000 }).below, true, '185 000 a unit paid against 190 000');
});

test('profit report: a bundle, a promo code, points, a return, a line below cost; a product without a cost apart', async () => {
  const [{ id: shop }] = await db('stores').insert({ name: 'Foyda do\'koni', city: 'Toshkent', address: 'Yunusobod 1', lat: 41.3, lon: 69.3, organization_id: orgA }).returning('id');
  const p = await product(shop, { price: 200000, cost: 120000, name: 'Foydali' });
  const n = await product(shop, { price: 150000, name: 'Tannarxsiz' });
  const b = await product(shop, { price: 200000, cost: 250000, name: 'Zarar' });
  // O1: 2 × P, promo KUZ10 −20 000 and 10 000 of points. O2: the product without a cost. O3: below cost. O4: bundle −10 000.
  const o1 = await paidOrder(shop, [[p, 2]], { promo: 20000, code: 'KUZ10', points: 10000, discounts: [20000] });
  await paidOrder(shop, [[n, 1]]);
  await paidOrder(shop, [[b, 1]]);
  await paidOrder(shop, [[p, 1]], { bundle: 10000, discounts: [10000] });
  // Left out: a paid order cancelled afterwards, and one never paid.
  const gone = await paidOrder(shop, [[p, 5]]);
  await db('orders').where({ id: gone.id }).update({ status: 'cancelled' });
  const store = await storeOf(db, shop);
  await db.transaction(async (trx) => (await hold(trx, [[p, 3]]), insertOrder(trx, store, { customer_name: 'Aziz', phone: '+998901234567', fulfillment: 'pickup', address: null, lat: null, lon: null },
    [{ product_id: p.id, size: 'M', quantity: 3, unit_price: p.price }], { notifyToken: randomBytes(16).toString('hex') })));
  // A return of one unit of O1, back on the shelf, refunded in full (185 000), and an exchange (moves no money).
  await db('orders').where({ id: o1.id }).update({ status: 'delivered' });
  const line = await db('order_items').where({ order_id: o1.id }).first();
  const ret = await admin('POST', `/orders/${o1.id}/returns`, { key: randomBytes(16).toString('hex'), item_id: line.id, kind: 'return', reason: 'disliked', quantity: 1, restock: true }, ownerA);
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  assert.equal(ret.body.returns[0].refund, 185000);
  assert.equal((await admin('POST', `/orders/${o1.id}/returns`, { key: randomBytes(16).toString('hex'), item_id: line.id, kind: 'exchange', reason: 'too_small', quantity: 1, restock: true, new_size: 'L' }, ownerA)).status, 201);

  const r = await admin('GET', `/profit?store_id=${shop}`, undefined, managerA1);
  assert.equal(r.status, 200);
  assert.equal(r.body.totals.units, 0, 'a manager of another store sees nothing of this one');
  const { body: rep, status } = await admin('GET', `/profit?store_id=${shop}&days=7`, undefined, ownerA);
  assert.equal(status, 200, JSON.stringify(rep));
  assert.equal(rep.days, 7);
  // Costed lines: O1 185 000 / 120 000, O3 200 000 / 250 000, O4 190 000 / 120 000.
  assert.deepEqual(rep.totals, { units: 3, revenue: 575000, cost: 490000, profit: 85000, no_cost_units: 1, no_cost_revenue: 150000, margin: 14.8 });
  assert.deepEqual(rep.discounts, { bundle: 10000, promo: 20000, points: 10000, total: 40000, promo_codes: [{ code: 'KUZ10', orders: 1, sum: 20000 }] });
  assert.equal(rep.per_day.length, 7);
  assert.deepEqual(rep.per_day.at(-1), { day: rep.to, ...rep.totals }, 'all of it today');
  assert.deepEqual(rep.products.map((x) => [x.name, x.profit, x.margin, x.no_cost_revenue]), [['Foydali', 135000, 36, 0], ['Tannarxsiz', 0, null, 150000], ['Zarar', -50000, -25, 0]]);
  assert.equal(rep.categories.length, 1);
  assert.equal(rep.categories[0].no_cost_revenue, 150000);
  assert.deepEqual(rep.below_cost.map((x) => [x.name, x.quantity, x.unit_paid, x.unit_cost, x.loss]), [['Zarar', 1, 200000, 250000, 50000]]);
  // Stock value at cost: everything on hand of the products with a cost; the one without is counted apart.
  const onHand = async (x) => Number((await db('product_stock').where({ product_id: x.id }).sum({ n: 'quantity' }))[0].n);
  assert.deepEqual(rep.stock, { value: (await onHand(p)) * 120000 + (await onHand(b)) * 250000, units: (await onHand(p)) + (await onHand(b)), no_cost_units: await onHand(n), no_cost_products: 1 });
  // A later cost change rewrites nothing.
  await db('products').where({ id: p.id }).update({ cost: 10 });
  assert.equal((await admin('GET', `/profit?store_id=${shop}&days=7`, undefined, ownerA)).body.totals.cost, 490000);
  // Super sees it; org B, staff and the mall admin don't.
  assert.equal((await admin('GET', `/profit?store_id=${shop}&days=7`, undefined, superToken)).body.totals.profit, 85000);
  const other = await admin('GET', `/profit?store_id=${shop}`, undefined, ownerB);
  assert.equal(other.status, 200);
  assert.deepEqual([other.body.totals.units, other.body.totals.no_cost_units, other.body.stock.units, other.body.discounts.total], [0, 0, 0, 0]);
  assert.equal((await admin('GET', '/profit', undefined, ownerB)).body.below_cost.length, 0, 'their own stores only');
  for (const tok of [staff1, mallToken]) assert.equal((await admin('GET', '/profit', undefined, tok)).status, 403);
  assert.equal((await admin('GET', '/profit?days=abc', undefined, ownerA)).body.days, 30, 'anything else: 30 days');
});

test('no cost in any customer, staff, mall or sync response (every response of this file and a GET walk)', async () => {
  // A distinctive cost on every product, so a renamed field would show up by its value.
  await db('products').update({ cost: db.raw('1000003 + id * 2') });
  const costs = (await db('products').select('cost')).map((x) => String(x.cost));
  const p = await top(a1);
  await db('product_stock').where({ product_id: p.id }).update({ quantity: 50, reserved: 0 });
  // Customer: kiosk store, outfit, catalogue, item page, mall, mall outfit and search, cart, checkout, status pages.
  const pub = (m, path, body) => call(m, path, body);
  await pub('GET', '/api/stores');
  await pub('GET', `/api/stores/${a1}`);
  const rec = (await pub('POST', '/api/recommend', { store_id: a1, gender: 'male', sizes: { top: 'M', bottom: 'M', shoes: '42' } })).body;
  assert.ok(rec.outfits?.length, JSON.stringify(rec).slice(0, 200));
  await pub('GET', `/api/catalog/${a1}`);
  await pub('GET', `/api/catalog/${a1}/items/${p.id}`);
  await pub('POST', '/api/catalog/elsewhere', { store_id: a1, product_id: p.id, size: 'M' });
  await pub('GET', `/api/malls/${mall}`);
  await pub('GET', `/api/malls/${mall}/offers`);
  await pub('GET', `/api/malls/${mall}/search?q=a`);
  await pub('POST', '/api/recommend/mall', { mall_id: mall, gender: 'male', sizes: { top: 'L', bottom: 'L', shoes: '42' } });
  const cart = (await pub('POST', '/api/cart/items', { store_id: a1, items: [{ product_id: p.id, size: 'M' }] })).body;
  await pub('GET', `/api/cart/${cart.token}`);
  const out = await pub('POST', `/api/cart/${cart.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '+998901234567' });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const status = new URL(out.body.track.url).pathname.replace('/order/', '/api/orders/');
  const paid = await admin('POST', `/orders/${out.body.order.id}/pay`, { method: 'cash' }, staff1); // task 51: staff take payments
  assert.equal(paid.status, 200);
  assert.ok((await db('order_items').where({ order_id: out.body.order.id }).first()).unit_cost > 1000000, 'the sold line carries a cost now');
  await pub('GET', status);
  const mc = (await pub('POST', '/api/mall-cart/items', { mall_id: mall, store_id: a1, items: [{ product_id: p.id, size: 'M' }] })).body;
  await pub('GET', `/api/mall-cart/${mc.token}`);
  const mo = await pub('POST', `/api/mall-cart/${mc.token}/checkout`, { name: 'Malika Karimova', phone: '+998935554433' });
  assert.equal(mo.status, 201, JSON.stringify(mo.body));
  await pub('GET', `/api/order-groups/${new URL(mo.body.track.url).pathname.split('/').pop()}`);
  // Sync API: a POS pushing stock.
  const key = (await admin('POST', '/sync-keys', { name: 'Kassa', store_id: a1 }, ownerA)).body.key;
  const synced = await fetch(`${base}/api/sync/stock`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ items: [{ sku: p.sku, size: 'M', quantity: 40 }] }) });
  assert.equal(synced.status, 200);
  // Staff: the floor poll, the stock catalogue and a receiving session with its scans.
  const s = await openSession(staff1, { kind: 'receive' });
  await scan(staff1, s, p, 'M', 1);
  await admin('GET', `/stock/sessions/${s.id}`, undefined, staff1);
  // A GET walk of every admin route as staff and as the mall admin (most are 403; the open ones must carry no cost).
  const ids = { ':id': p.id, ':scope': 'clothes' };
  const routes = createAdminRouter(db).stack.filter((l) => l.route && l.route.methods.get).map((l) => l.route.path.replace(/:\w+/g, (m) => ids[m] ?? 1));
  for (const tok of [staff1, mallToken]) for (const path of routes) await admin('GET', `${path}${path.includes('?') ? '&' : '?'}store_id=${a1}`, undefined, tok);
  for (const tok of [staff1, mallToken]) for (const path of ['/staff', '/stock/catalog', '/stock/sessions', '/mall', '/mall/map', '/mall/offers']) await admin('GET', path, undefined, tok);

  const trusted = new Set([ownerA, managerA1, managerA2, ownerB, superToken]);
  const checked = seen.filter((x) => !trusted.has(x.who) && !x.call.startsWith('POST /api/admin/login'));
  assert.ok(checked.length > 60, `checked ${checked.length} responses`);
  const roles = { public: 0, staff: 0, mall: 0, sync: 0 };
  for (const x of checked) {
    roles[x.who === staff1 ? 'staff' : x.who === mallToken ? 'mall' : x.call.startsWith('POST /api/sync') ? 'sync' : 'public']++;
    assert.doesNotMatch(x.body, /cost/i, `${x.call} (${x.status}) names a cost`);
    for (const c of costs) assert.doesNotMatch(x.body, new RegExp(`(?<![\\d.])${c}(?!\\d)`), `${x.call} carries a cost value`);
  }
  for (const [k, v] of Object.entries(roles)) assert.ok(v > 0, `${k} responses were checked`);
  // And the staff calls did reach data: the poll and the stock catalogue answered.
  assert.ok(checked.some((x) => x.who === staff1 && x.call.startsWith('GET /api/admin/stock/catalog') && x.status === 200));
  assert.ok(checked.some((x) => x.who === mallToken && x.call === 'GET /api/admin/mall' && x.status === 200));
});

test('migration 039: down drops the cost columns, up brings them back', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await m.migrate.down(); // 042
    await m.migrate.down(); // 041
    await m.migrate.down(); // 040
    await m.migrate.down();
    assert.equal(await m.schema.hasColumn('products', 'cost'), false);
    assert.equal(await m.schema.hasColumn('order_items', 'unit_cost'), false);
    await m.migrate.latest();
    assert.ok(await m.schema.hasColumn('products', 'cost'));
    assert.ok(await m.schema.hasColumn('order_items', 'unit_cost'));
  } finally {
    await m.destroy();
  }
});
