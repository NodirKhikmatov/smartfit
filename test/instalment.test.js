// Task 35: "Muddatli to'lov" at the cashier. The monthly amount (integer so'm, rounded up, on what the customer owes
// after bundle, promo code and points, delivery included); the setting off by default and screens unchanged; the store
// setting (validation, owner only, organisation scope, audit); an unknown term refused; an order fully paid by points
// can't choose instalments; the flag reaching the order, the admin list, CSV, the staff app, the status page and the
// report; an old order keeping its figures after the setting changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { monthly, plan, termsOf, validTerms } from '../src/cart/instalment.js';
import { handleUpdate } from '../src/notify/telegram.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
const BOT = { token: '1:x', username: 'smartfit_test_bot' };
const weather = async () => ({ temperature: 15, apparent_temperature: 14, raining: false, wind_speed: 3, source: 'live' });
let server, base, tash, sam, orgA, owner, ownerB, manager, staff, top;

const call = async (method, p, body, token) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
};
const admin = (method, p, body, token = owner) => call(method, `/api/admin${p}`, body, token);
const login = async (email, password) => (await call('POST', '/api/admin/login', { email, password })).body.token;
const TERMS = [{ months: 3, percent: 0 }, { months: 6, percent: 12 }, { months: 12, percent: 25 }];
const setInst = (on, terms = TERMS, store = tash) => db('stores').where({ id: store }).update({ instalment_on: on, instalment_terms: JSON.stringify(terms) });

async function cart(unitPrice = 200000, store = tash) {
  await db('products').where({ id: top.id }).update({ price: unitPrice, discount_price: null });
  return (await call('POST', '/api/cart/items', { store_id: store, items: [{ product_id: top.id, size: 'M' }] })).body;
}
const checkout = (c, extra = {}) => call('POST', `/api/cart/${c.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '+998901112233', ...extra });

// Telegram, simulated against the same DB (points need a profile linked to the cart).
const send = async () => {};
const msg = (from, extra) => handleUpdate(db, { update_id: 1, message: { chat: { id: from, type: 'private' }, from: { id: from, language_code: 'uz' }, ...extra } }, send, { base: 'https://shop.test' });
const startLink = (from, url) => msg(from, { text: `/start ${new URL(url).searchParams.get('start')}` });
const contact = (from, phone) => msg(from, { contact: { phone_number: phone.replace('+', ''), first_name: 'Aziz', user_id: from } });

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [tash, sam] = (await db('stores').orderBy('id')).map((s) => s.id);
  orgA = (await db('stores').where({ id: tash }).first()).organization_id;
  top = await db('products').where({ store_id: tash, category: 'top' }).orderBy('id').first();
  await db('product_stock').where({ product_id: top.id, size: 'M' }).update({ quantity: 1000 });
  await createAdmin(db, { email: 'owner@smartfit.uz', password: 'owner-pass-1', storeId: tash });
  await createAdmin(db, { email: 'owner.b@smartfit.uz', password: 'owner-pass-2', storeId: sam });
  await createAdmin(db, { email: 'mgr@smartfit.uz', password: 'mgr-pass-1', storeId: tash, role: 'manager' });
  await createAdmin(db, { email: 'staff@smartfit.uz', password: 'staff-pass-1', storeId: tash, role: 'staff' });
  server = createApp(db, { weather, stylist: null, telegram: BOT, limits: { promo: 1000, cart: 0, recommend: 0, profile: 0, profilePoll: 0 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await login('owner@smartfit.uz', 'owner-pass-1');
  ownerB = await login('owner.b@smartfit.uz', 'owner-pass-2');
  manager = await login('mgr@smartfit.uz', 'mgr-pass-1');
  staff = await login('staff@smartfit.uz', 'staff-pass-1');
});
after(async () => {
  server.close();
  await db.destroy();
});

test('the monthly amount: integer so\'m, rounded up, markup on the whole amount', () => {
  assert.equal(monthly(300000, 3, 0), 100000);
  assert.equal(monthly(100000, 3, 0), 33334, '33 333.33 → up');
  assert.equal(monthly(200000, 6, 12), 37334, '224 000 / 6 = 37 333.33 → up');
  assert.equal(monthly(200000, 12, 25), 20834, '250 000 / 12 = 20 833.33 → up');
  assert.equal(monthly(1, 24, 0), 1);
  assert.equal(monthly(999999999, 24, 100), Math.ceil((999999999 * 2) / 24), 'no float drift on big sums');
  for (let owed = 1; owed < 5000; owed += 37) {
    for (const t of TERMS) {
      const m = monthly(owed, t.months, t.percent);
      assert.ok(Number.isInteger(m) && m * t.months * 100 >= owed * (100 + t.percent) && (m - 1) * t.months * 100 < owed * (100 + t.percent), `${owed} ${t.months}`);
    }
  }
  assert.equal(plan(null, 100000), undefined);
  assert.equal(plan(TERMS, 0), undefined, 'nothing left to pay → no instalments');
  assert.deepEqual(plan(TERMS, 300000).map((x) => x.monthly), [100000, 56000, 31250]);
  assert.equal(termsOf({ instalment_on: false, instalment_terms: JSON.stringify(TERMS) }), null);
  assert.equal(termsOf({ instalment_on: 1, instalment_terms: '[]' }), null);
  assert.deepEqual(validTerms([{ months: 12, percent: 25 }, { months: 3, percent: 0 }]), [{ months: 3, percent: 0 }, { months: 12, percent: 25 }]);
  for (const bad of [[{ months: 5, percent: 0 }], [{ months: 3, percent: -1 }], [{ months: 3, percent: 101 }], [{ months: 3, percent: 1.5 }],
    [{ months: 3, percent: 0 }, { months: 3, percent: 5 }], 'nope', '{"a":1}', 7, [null]]) {
    assert.throws(() => validTerms(bad), /./, JSON.stringify(bad));
  }
});

test('off by default: cart, item page and order exactly as before; a term is refused', async () => {
  const c = await cart();
  assert.deepEqual(Object.keys(c.totals.pickup), ['subtotal', 'delivery_fee', 'total']);
  assert.deepEqual(Object.keys(c.totals.delivery), ['subtotal', 'delivery_fee', 'total']);
  const item = (await call('GET', `/api/catalog/${tash}/items/${top.id}`)).body.item;
  assert.equal('instalments' in item, false);
  const r = await checkout(c, { instalment: 3 });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'instalment_term');
  const o = (await checkout(c)).body.order;
  assert.deepEqual([o.total, o.payment_method, o.instalment_months, o.instalment_percent, o.instalment_monthly], [200000, 'cashier', null, null, null]);
  const s = (await admin('GET', `/stores/${tash}`)).body;
  assert.deepEqual([s.instalment_on, s.instalment_terms], [false, []]);
});

test('store setting: owner edits with validation and an audit row; manager read-only; another organisation 404', async () => {
  const bad = [{ instalment_on: true, instalment_terms: [] }, { instalment_on: 'yes', instalment_terms: TERMS }, { instalment_terms: [{ months: 7, percent: 0 }] },
    { instalment_terms: [{ months: 3, percent: 0 }, { months: 3, percent: 1 }] }, { instalment_terms: 'garbage' }, { instalment_terms: [{ months: 6, percent: 101 }] }];
  for (const b of bad) {
    const r = await admin('PATCH', `/stores/${tash}`, b);
    assert.equal(r.status, 400, JSON.stringify(b));
  }
  assert.equal((await admin('PATCH', `/stores/${tash}`, { instalment_on: true, instalment_terms: TERMS }, manager)).status, 403);
  assert.equal((await admin('PATCH', `/stores/${tash}`, { instalment_on: true, instalment_terms: TERMS }, ownerB)).status, 404);
  assert.equal((await admin('GET', `/stores/${tash}`, undefined, ownerB)).status, 404);
  const r = await admin('PATCH', `/stores/${tash}`, { instalment_on: true, instalment_terms: [...TERMS].reverse() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.instalment_on, r.body.instalment_terms], [true, TERMS], 'stored shortest first');
  assert.deepEqual((await admin('GET', `/stores/${tash}`, undefined, manager)).body.instalment_terms, TERMS, 'the manager reads it');
  const a = await db('audit_log').where({ action: 'store.update', store_id: tash }).orderBy('id', 'desc').first();
  assert.deepEqual(typeof a.after === 'string' ? JSON.parse(a.after) : a.after, { instalment_on: true, instalment_terms: TERMS });
  const n = await db('audit_log').count({ n: '*' });
  assert.equal((await admin('PATCH', `/stores/${tash}`, { instalment_terms: TERMS })).status, 200);
  assert.deepEqual(await db('audit_log').count({ n: '*' }), n, 'no change → no audit row');
  // Switched off, the terms are kept for next time.
  assert.equal((await admin('PATCH', `/stores/${tash}`, { instalment_on: false })).body.instalment_terms.length, 3);
  assert.equal((await db('stores').where({ id: sam }).first()).instalment_on ? 1 : 0, 0, 'the other organisation untouched');
  await setInst(false);
});

test('on: item page and cart show server monthly amounts; checkout stores the term; the total is unchanged', async () => {
  await setInst(true);
  await db('stores').where({ id: tash }).update({ delivery_fee: 30000, free_delivery_threshold: null });
  try {
    const item = (await call('GET', `/api/catalog/${tash}/items/${top.id}`)).body.item;
    assert.deepEqual(item.instalments, plan(TERMS, item.unit_price));
    const c = await cart(200000);
    assert.deepEqual(c.totals.pickup.instalments, [{ months: 3, percent: 0, monthly: 66667 }, { months: 6, percent: 12, monthly: 37334 }, { months: 12, percent: 25, monthly: 20834 }]);
    assert.deepEqual(c.totals.delivery.instalments.map((x) => x.monthly), plan(TERMS, 230000).map((x) => x.monthly), 'delivery included');
    for (const bad of [{ instalment: 9 }, { instalment: 0 }]) assert.equal((await checkout(c, bad)).body.code, 'instalment_term');
    for (const bad of [{ instalment: '6' }, { instalment: 6.5 }, { instalment: 6, payment: 'payme' }]) assert.equal((await checkout(c, bad)).status, 400, JSON.stringify(bad));
    const r = await checkout(c, { instalment: 6, fulfillment: 'delivery', address: 'Chilonzor 5, 12-uy', total: 1, instalment_monthly: 1 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = r.body.order;
    assert.deepEqual([o.total, o.payment_method, o.instalment_months, o.instalment_percent, o.instalment_monthly], [230000, 'cashier', 6, 12, monthly(230000, 6, 12)]);
    // A later change of the setting doesn't touch the order.
    await setInst(true, [{ months: 6, percent: 30 }]);
    const later = (await admin('GET', `/orders/${o.id}`)).body;
    assert.deepEqual([later.instalment_percent, later.instalment_monthly, later.total], [12, monthly(230000, 6, 12), 230000]);
  } finally {
    await setInst(false);
    await db('stores').where({ id: tash }).update({ delivery_fee: 0 });
  }
});

test('on what the customer owes: after a promo code; nothing left to pay (promo or points) → no instalments', async () => {
  await setInst(true);
  try {
    const code = (await admin('POST', '/promos', { code: 'INST10', kind: 'percent', value: 10 })).body;
    const c = await cart(200000);
    const withCode = (await call('POST', `/api/cart/${c.token}/promo`, { code: 'INST10' })).body;
    assert.equal(withCode.totals.pickup.total, 180000);
    assert.equal(withCode.totals.pickup.instalments[0].monthly, 60000);
    const free = (await admin('POST', '/promos', { code: 'INSTFREE', kind: 'percent', value: 100 })).body;
    const c2 = await cart(200000);
    const zero = (await call('POST', `/api/cart/${c2.token}/promo`, { code: 'INSTFREE' })).body;
    assert.equal(zero.totals.pickup.total, 0);
    assert.equal('instalments' in zero.totals.pickup, false);
    assert.equal((await checkout(zero, { instalment: 3 })).body.code, 'instalment_term');
    for (const p of [code, free]) await admin('PATCH', `/promos/${p.id}`, { active: false });

    // Points paying the whole order (share 100 %): the points totals carry no instalments and checkout refuses a term.
    await db('organizations').where({ id: orgA }).update({ cashback_percent: 5, points_max_share: 100 });
    const reg = await call('POST', '/api/profile/link', { store_id: tash, lang: 'uz', gender: 'male', top: 'M', bottom: 'L' });
    await startLink(4001, reg.body.url);
    await contact(4001, '+998901114001');
    const prof = await db('customer_profiles').where({ telegram_user_id: 4001, organization_id: orgA }).first();
    const earned = (await checkout(await cart(200000))).body.order;
    await db('points_ledger').insert({ organization_id: orgA, profile_id: prof.id, order_id: earned.id, kind: 'earn', amount: 500000, ref: `earn:${earned.id}` });
    const c3 = await cart(200000);
    const lr = await call('POST', '/api/profile/login', { store_id: tash, lang: 'uz', cart: c3.token });
    await startLink(4001, lr.body.url);
    await contact(4001, '+998901114001');
    const linked = (await call('GET', `/api/cart/${c3.token}`)).body;
    assert.equal(linked.points.max, 200000);
    assert.equal(linked.points.totals.pickup.total, 0);
    assert.equal('instalments' in linked.points.totals.pickup, false);
    assert.ok(linked.totals.pickup.instalments, 'without points the term is still offered');
    assert.equal((await checkout(linked, { points: 200000, instalment: 3, phone: '+998901114001' })).body.code, 'instalment_term');
    // Part paid by points: the monthly amount is on the rest.
    await db('organizations').where({ id: orgA }).update({ points_max_share: 50 });
    const half = (await call('GET', `/api/cart/${c3.token}`)).body;
    assert.deepEqual(half.points.totals.pickup.instalments[0], { months: 3, percent: 0, monthly: 33334 });
    const o = (await checkout(half, { points: 100000, instalment: 3, phone: '+998901114001' })).body.order;
    assert.deepEqual([o.total, o.points_discount, o.instalment_monthly], [100000, 100000, 33334]);
  } finally {
    await setInst(false);
    await db('organizations').where({ id: orgA }).update({ cashback_percent: 0, points_max_share: 50 });
  }
});

test('the flag reaches the admin list and drawer, the CSV, the staff app, the status page and the report', async () => {
  await setInst(true);
  try {
    const plain = (await checkout(await cart(100000))).body.order;
    const r = await checkout(await cart(300000), { instalment: 12 });
    const o = r.body.order;
    const list = (await admin('GET', `/orders?q=${o.number}`)).body.items[0];
    assert.deepEqual([list.instalment_months, list.instalment_monthly], [12, 31250]);
    const view = (await admin('GET', `/orders/${o.id}`)).body;
    assert.deepEqual([view.instalment_months, view.instalment_percent, view.instalment_monthly, view.total], [12, 25, 31250, 300000]);
    const status = (await call('GET', new URL(r.body.track.url).pathname.replace('/order/', '/api/orders/'))).body;
    assert.deepEqual([status.instalment_months, status.instalment_monthly, status.total], [12, 31250, 300000]);
    assert.equal('instalment_percent' in status, false);
    // The other organisation never sees it.
    assert.equal((await admin('GET', `/orders/${o.id}`, undefined, ownerB)).status, 404);

    for (const x of [plain, o]) assert.equal((await admin('POST', `/orders/${x.id}/pay`, {})).status, 200);
    const csv = await call('GET', `/api/admin/orders/export?q=${o.number}`, undefined, owner);
    const [head, row] = csv.body.replace('﻿', '').trim().split('\r\n');
    assert.match(head, /"Muddatli, oy";"Oyiga, so'm"/);
    assert.match(row, /"12";"31250"/);
    const plainRow = (await call('GET', `/api/admin/orders/export?q=${plain.number}`, undefined, owner)).body.trim().split('\r\n')[1];
    assert.match(plainRow, /"Kassada";"";"";/i);

    const queue = (await admin('GET', '/staff', undefined, staff)).body.orders;
    assert.equal(queue.find((x) => x.id === o.id).instalment_months, 12);
    assert.equal(queue.find((x) => x.id === plain.id).instalment_months, null);
    assert.equal('instalment_monthly' in queue[0], false, 'staff see the term, not sums');

    const stats = (await admin('GET', '/stats?days=7')).body.instalments;
    const paid = await db('orders').where({ store_id: tash, payment_status: 'paid' }).whereNot('status', 'cancelled');
    const inst = paid.filter((x) => x.instalment_months != null);
    assert.equal(stats.orders, inst.length);
    assert.equal(stats.share, Math.round((inst.length * 100) / paid.length));
    assert.equal(stats.avg_total, Math.round(inst.reduce((a, x) => a + x.total, 0) / inst.length));
    assert.deepEqual((await admin('GET', '/stats?days=7', undefined, ownerB)).body.instalments, { orders: 0, share: 0, avg_total: 0 }, 'org B: nothing of A');
  } finally {
    await setInst(false);
  }
});
