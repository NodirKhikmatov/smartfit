// Task 51: closing the day at the cashier. A cashier payment always says how (cash | card | instalment, instalment only
// for an instalment order); the day's report per store by method (Click/Payme from their callbacks, "unknown" for
// cashier orders paid before this task), points, discounts, refunds (a return or a paid order's cancel, the way it was
// paid) and the cash expected in the drawer; closing once, fixed afterwards, cut at an early closing; who may close
// (manager: own store, owner: own organisation, staff and mall never); the history; the staff app's till list; migration 041.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin, dayKey, dayStart, DAY_MS } from '../src/admin/routes.js';
import { insertOrder, markPaid, storeOf } from '../src/cart/cart.js';
import { dbTime } from '../src/recommend/routes.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, a1, a2, b1, mall, ownerA, managerA1, managerA2, staff1, ownerB, superToken, mallToken;

const call = async (method, p, body, token) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const admin = (method, p, body, token) => call(method, `/api/admin${p}`, body, token);
const login = async (email, password) => (await admin('POST', '/login', { email, password })).body.token;
const hex = () => randomBytes(16).toString('hex');
const today = () => dayKey(Date.now());
const daysAgo = (n) => dayKey(dayStart(today()) - n * DAY_MS);
const at = (day, hh) => new Date(dayStart(day) + hh * 3600000).toISOString(); // hh:00 Tashkent on that day

async function product(store, price) {
  const p = await db('products').where({ store_id: a1, category: 'top', audience: 'adult' }).orderBy('id').first();
  const { id: _i, sku: _s, barcode: _b, created_at: _c, updated_at: _u, ...rest } = p;
  const [{ id }] = await db('products').insert({ ...rest, store_id: store, name: `Kassa ${price}`, price, discount_price: null }).returning('id');
  await db('product_stock').insert(['S', 'M', 'L'].map((size) => ({ product_id: id, size, quantity: 100 })));
  return db('products').where({ id }).first();
}
// One unpaid pickup order of one unit straight through insertOrder (as a checkout makes it).
async function order(storeId, price, { method = 'cashier', promo = 0, points = 0, instalment = null } = {}) {
  const store = await storeOf(db, storeId);
  const p = await product(storeId, price);
  const id = await db.transaction(async (trx) => {
    await trx('product_stock').where({ product_id: p.id, size: 'M' }).increment('reserved', 1);
    return insertOrder(trx, store, { customer_name: 'Aziz', phone: '+998901234567', fulfillment: 'pickup', address: null, lat: null, lon: null },
      [{ product_id: p.id, size: 'M', quantity: 1, unit_price: price }], { method, notifyToken: hex(), pr: { bundle_discount: 0, promo_discount: promo, discounts: [promo] }, points, instalment });
  });
  return db('orders').where({ id }).first();
}
const pay = (id, method, token = managerA2) => admin('POST', `/orders/${id}/pay`, method === undefined ? {} : { method }, token);
async function handOver(id, token = managerA2) {
  for (const s of ['packing', 'delivered']) assert.equal((await admin('POST', `/orders/${id}/status`, { status: s }, token)).status, 200);
}
async function giveBack(id, refund, token = managerA2) {
  const item = await db('order_items').where({ order_id: id }).first('id');
  const r = await admin('POST', `/orders/${id}/returns`, { key: hex(), item_id: item.id, kind: 'return', reason: 'disliked', quantity: 1, restock: true, refund }, token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
}
const report = async (q, token = managerA2) => {
  const r = await admin('GET', `/cash${q}`, undefined, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [a1, b1] = (await db('stores').orderBy('id')).map((s) => s.id);
  mall = (await db('malls').first()).id;
  const orgA = (await db('stores').where({ id: a1 }).first()).organization_id;
  // a2: a store with no seeded orders, so its numbers are this file's own.
  [{ id: a2 }] = await db('stores').insert({ name: 'A filial', city: 'Toshkent', address: 'Chilonzor 1', lat: 41.28, lon: 69.2, organization_id: orgA }).returning('id');
  const people = [['owner.a@smartfit.uz', 'owner-pass-1', a1, 'owner'], ['mgr.a1@smartfit.uz', 'mgr-pass-1', a1, 'manager'], ['mgr.a2@smartfit.uz', 'mgr-pass-2', a2, 'manager'],
    ['staff.a1@smartfit.uz', 'staff-pass-1', a1, 'staff'], ['owner.b@smartfit.uz', 'owner-pass-2', b1, 'owner']];
  for (const [email, password, storeId, role] of people) await createAdmin(db, { email, password, storeId, role });
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  await createAdmin(db, { email: 'mall@smartfit.uz', password: 'mall-pass-1', mallId: mall });
  server = createApp(db, { telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }),
    limits: { recommend: 0, cart: 0, catalog: 0, mall: 0, promo: 0 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  [ownerA, managerA1, managerA2, staff1, ownerB, superToken, mallToken] = await Promise.all([['owner.a', 'owner-pass-1'], ['mgr.a1', 'mgr-pass-1'], ['mgr.a2', 'mgr-pass-2'],
    ['staff.a1', 'staff-pass-1'], ['owner.b', 'owner-pass-2'], ['boss', 'boss-pass-1'], ['mall', 'mall-pass-1']].map(([u, p]) => login(`${u}@smartfit.uz`, p)));
});
after(async () => {
  server.close();
  await db.destroy();
});

test('a cashier payment needs a method: cash or card, instalment only (and always) for an instalment order', async () => {
  const o = await order(a1, 100000);
  for (const m of [undefined, '', 'cheque', 'click', 'instalment']) {
    const r = await pay(o.id, m, managerA1);
    assert.deepEqual([r.status, r.body.code], [400, 'invalid'], String(m));
  }
  assert.equal((await db('orders').where({ id: o.id }).first()).payment_status, 'pending', 'nothing was paid');
  const ok = await pay(o.id, 'card', managerA1);
  assert.deepEqual([ok.status, ok.body.paid_with, ok.body.payment_status], [200, 'card', 'paid']);
  assert.equal((await pay(o.id, 'card', managerA1)).status, 409, 'once');
  const inst = await order(a1, 300000, { instalment: { months: 6, percent: 10 } });
  assert.equal((await pay(inst.id, 'cash', managerA1)).status, 400, 'an instalment order is paid by instalment');
  assert.equal((await pay(inst.id, 'instalment', managerA1)).body.paid_with, 'instalment');
  // Staff take payments too; their answer carries no customer details.
  const s = await order(a1, 50000);
  const r = await pay(s.id, 'cash', staff1);
  assert.deepEqual([r.status, r.body.paid_with, 'phone' in r.body, 'customer_name' in r.body], [200, 'cash', false, false]);
  // A Click order the customer paid at the till after all: it is a cashier payment now.
  const c = await order(a1, 40000, { method: 'click' });
  assert.equal((await pay(c.id, 'cash', managerA1)).body.paid_with, 'cash');
  const audit = await db('audit_log').where({ action: 'order.pay', entity_id: r.body.id }).first();
  assert.ok(audit, 'the payment is audited');
});

test('the staff app lists orders waiting at the till, soonest to lapse first, without phone or address', async () => {
  const o = await order(a1, 77000);
  const d = (await admin('GET', '/staff', undefined, staff1)).body;
  const row = d.pending.find((x) => x.id === o.id);
  assert.ok(row);
  assert.deepEqual([row.total, row.payment_method, row.items.length], [77000, 'cashier', 1]);
  assert.ok(row.pay_ms > 0 && row.pay_ms <= 15 * 60000);
  assert.ok(!JSON.stringify(d.pending).includes('+998901234567'));
  assert.ok(d.pending.every((x) => x.store_id === a1), 'their own store only');
  await pay(o.id, 'cash', staff1);
  assert.ok(!(await admin('GET', '/staff', undefined, staff1)).body.pending.some((x) => x.id === o.id), 'gone once paid');
});

test('the day by method: totals, points, discounts, refunds the way it was paid, and the cash expected', async () => {
  const cash = await order(a2, 100000, { promo: 10000 }); // 90 000
  const card = await order(a2, 200000);
  const click = await order(a2, 50000, { method: 'click' });
  const payme = await order(a2, 70000, { method: 'payme', points: 20000 }); // 50 000
  const inst = await order(a2, 300000, { instalment: { months: 12, percent: 25 } });
  const old = await order(a2, 30000); // paid before task 51: no method
  const cashToo = await order(a2, 15000);
  assert.equal((await pay(cash.id, 'cash')).status, 200);
  assert.equal((await pay(card.id, 'card')).status, 200);
  assert.equal((await pay(inst.id, 'instalment')).status, 200);
  assert.equal((await pay(cashToo.id, 'cash')).status, 200);
  for (const o of [click, payme]) assert.ok(await markPaid(db, o.id)); // their callbacks
  assert.ok(await markPaid(db, old.id, Date.now(), null));
  // Same-day refunds: part of the cash order back (handed over, then returned), the card order cancelled before it left.
  await handOver(cash.id);
  await giveBack(cash.id, 30000);
  assert.equal((await admin('POST', `/orders/${card.id}/status`, { status: 'cancelled' }, managerA2)).status, 200);
  const r = await report('');
  assert.deepEqual([r.store_id, r.day, r.closed], [a2, today(), null]);
  assert.deepEqual(r.sales, { cash: { orders: 2, sum: 105000 }, card: { orders: 1, sum: 200000 }, click: { orders: 1, sum: 50000 }, payme: { orders: 1, sum: 50000 },
    instalment: { orders: 1, sum: 300000 }, unknown: { orders: 1, sum: 30000 } });
  assert.deepEqual(r.refunds, { cash: 30000, card: 200000, click: 0, payme: 0, instalment: 0, unknown: 0 });
  assert.deepEqual([r.points, r.discounts, r.sales_total, r.refunds_total, r.net], [20000, 10000, 735000, 230000, 505000]);
  assert.equal(r.expected_cash, 75000, 'cash sales 105 000 − cash refund 30 000; card, Click, Payme, instalment and unknown never in the drawer');
  // The same numbers for owner and super with ?store_id; the manager's default is their store and today.
  assert.deepEqual((await report(`?store_id=${a2}&day=${today()}`, ownerA)).sales, r.sales);
  assert.equal((await report(`?store_id=${a2}`, superToken)).expected_cash, 75000);
  // A refund of yesterday's sale belongs to today; yesterday keeps the sale.
  const y = await order(a2, 60000);
  await pay(y.id, 'cash');
  await handOver(y.id);
  await db('orders').where({ id: y.id }).update({ paid_at: at(daysAgo(1), 12) });
  await giveBack(y.id, 60000);
  const yest = await report(`?day=${daysAgo(1)}`);
  assert.deepEqual([yest.sales.cash, yest.refunds.cash, yest.expected_cash], [{ orders: 1, sum: 60000 }, 0, 60000]);
  const now = await report('');
  assert.deepEqual([now.sales.cash.orders, now.refunds.cash, now.expected_cash], [2, 90000, 15000]);
});

test('closing: once per store and day, audited, fixed afterwards, and in the history', async () => {
  const day = daysAgo(1);
  const before = await report(`?day=${day}`);
  assert.equal((await admin('POST', '/cash/close', { day, counted: -1 }, managerA2)).status, 400);
  assert.equal((await admin('POST', '/cash/close', { day, counted: 1.5 }, managerA2)).status, 400);
  assert.equal((await admin('POST', '/cash/close', { day, counted: 1, note: 'x'.repeat(501) }, managerA2)).status, 400);
  assert.equal((await admin('POST', '/cash/close', { day, counted: 1, note: { a: 1 } }, managerA2)).status, 400);
  // Two clicks at once: one closes, the other is told the day is closed.
  const both = await Promise.all([1, 2].map(() => admin('POST', '/cash/close', { day, counted: before.expected_cash - 5000, note: '  5 ming kam  ' }, managerA2)));
  assert.deepEqual(both.map((x) => x.status).sort(), [201, 409], JSON.stringify(both.map((x) => x.body)).slice(0, 400));
  assert.equal(both.find((x) => x.status === 409).body.code, 'day_closed');
  const c = both.find((x) => x.status === 201).body;
  assert.deepEqual([c.closed.expected_cash, c.closed.counted_cash, c.closed.difference, c.closed.note, c.closed.closed_email], [60000, 55000, -5000, '5 ming kam', 'mgr.a2@smartfit.uz']);
  assert.deepEqual(c.sales, before.sales);
  assert.equal((await admin('POST', '/cash/close', { store_id: a2, day, counted: 0 }, ownerA)).status, 409, 'the owner can\'t close it again either');
  assert.equal(await db('cash_closings').where({ store_id: a2, day }).count({ n: '*' }).then(([x]) => Number(x.n)), 1);
  const audit = await db('audit_log').where({ action: 'cash.close', store_id: a2 }).first();
  assert.deepEqual([audit.entity, audit.entity_label, (typeof audit.after === 'string' ? JSON.parse(audit.after) : audit.after).difference], ['cash', day, -5000]);
  // Fixed: data that later lands in that day (here moved there by hand) never changes the closed report.
  const late = await order(a2, 99000);
  await pay(late.id, 'cash');
  await db('orders').where({ id: late.id }).update({ paid_at: at(day, 15) });
  const fixed = await report(`?day=${day}`);
  assert.deepEqual([fixed.sales.cash, fixed.expected_cash, fixed.closed.id], [{ orders: 1, sum: 60000 }, 60000, c.closed.id]);
  // History: newest day first, with who closed and the note; another store's manager sees none of it.
  assert.equal((await admin('POST', '/cash/close', { day: daysAgo(2), counted: 0 }, managerA2)).status, 201);
  const h = (await admin('GET', '/cash/closings', undefined, managerA2)).body;
  assert.deepEqual([h.total, h.items[0].day, h.items[1].day, h.items[0].note], [2, day, daysAgo(2), '5 ming kam']);
  assert.deepEqual((await admin('GET', '/cash/closings?limit=1&offset=1', undefined, managerA2)).body.items.map((x) => x.day), [daysAgo(2)]);
  for (const tok of [managerA1, ownerB]) {
    assert.equal((await admin('GET', '/cash/closings', undefined, tok)).body.total, 0);
    assert.equal((await admin('GET', `/cash/closings?store_id=${a2}`, undefined, tok)).body.total, 0, '?store_id never widens');
  }
  assert.equal((await admin('GET', `/cash/closings?store_id=${a2}`, undefined, ownerA)).body.total, 2);
  assert.equal((await admin('GET', '/cash/closings', undefined, superToken)).body.total, 2);
});

test('a day closed before midnight ends there: what comes after belongs to the next day', async () => {
  const [d1, d2] = [daysAgo(6), daysAgo(5)];
  const early = await order(a2, 11000);
  const after = await order(a2, 22000);
  for (const o of [early, after]) await pay(o.id, 'cash');
  await db('orders').where({ id: early.id }).update({ paid_at: at(d1, 18) });
  await db('orders').where({ id: after.id }).update({ paid_at: at(d1, 21) }); // after the 20:00 closing
  // The 20:00 closing of d1, as POST /cash/close would have written it then.
  const rep1 = await report(`?day=${d1}`);
  assert.equal(rep1.expected_cash, 33000, 'not closed yet: the whole day');
  await db('cash_closings').insert({ store_id: a2, day: d1, closed_at: at(d1, 20), closed_by: null, expected_cash: 11000, counted_cash: 11000, difference: 0, report: JSON.stringify({ ...rep1, expected_cash: 11000 }) });
  const rep2 = await report(`?day=${d2}`);
  assert.deepEqual([rep2.from, rep2.sales.cash, rep2.expected_cash], [at(d1, 20), { orders: 1, sum: 22000 }, 22000]);
  // A refund made after the early closing belongs to the next day too.
  await handOver(early.id);
  await giveBack(early.id, 11000);
  await db('order_returns').where({ order_id: early.id }).update({ created_at: dbTime(dayStart(d1) + 22 * 3600000) });
  assert.equal((await report(`?day=${d2}`)).refunds.cash, 11000);
});

test('who may read and close: managers their store, owners their organisation, super any; staff and the mall role never', async () => {
  for (const tok of [staff1, mallToken]) {
    assert.equal((await admin('GET', '/cash', undefined, tok)).status, 403);
    assert.equal((await admin('POST', '/cash/close', { counted: 0 }, tok)).status, 403);
    assert.equal((await admin('GET', '/cash/closings', undefined, tok)).status, 403);
  }
  assert.equal(await db('cash_closings').where({ store_id: a1 }).first(), undefined, 'staff closed nothing');
  // Another store or organisation: not found, nothing written.
  assert.equal((await admin('GET', `/cash?store_id=${a2}`, undefined, managerA1)).status, 404);
  assert.equal((await admin('POST', '/cash/close', { store_id: a2, day: daysAgo(3), counted: 0 }, managerA1)).status, 404);
  assert.equal((await admin('POST', '/cash/close', { store_id: a1, counted: 0 }, ownerB)).status, 404);
  assert.equal((await admin('GET', `/cash?store_id=${b1}`, undefined, ownerA)).status, 404);
  assert.equal((await admin('GET', '/cash?store_id=999999', undefined, superToken)).status, 404);
  assert.equal(await db('cash_closings').where({ day: daysAgo(3) }).first(), undefined);
  // Several stores: say which one.
  for (const tok of [ownerA, superToken]) assert.deepEqual([(await admin('GET', '/cash', undefined, tok)).body.code], ['required']);
  assert.equal((await report('', managerA1)).store_id, a1, 'a manager has one store');
  // Days: a real Tashkent day, not in the future.
  for (const d of ['2026-02-30', '20-01-01', 'today', dayKey(Date.now() + 2 * DAY_MS)]) assert.equal((await admin('GET', `/cash?day=${d}`, undefined, managerA1)).status, 400, d);
  // The owner closes a store of their organisation; a super closes org B's.
  assert.equal((await admin('POST', '/cash/close', { store_id: a1, day: daysAgo(3), counted: 0 }, ownerA)).status, 201);
  assert.equal((await admin('POST', '/cash/close', { store_id: b1, day: daysAgo(3), counted: 0 }, superToken)).status, 201);
  assert.equal((await admin('GET', `/cash/closings?store_id=${b1}`, undefined, ownerB)).body.items[0].closed_email, 'boss@smartfit.uz');
});

test('migration 041 goes down and up', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await m.migrate.down(); // 044
    await m.migrate.down(); // 043
    await m.migrate.down(); // 042
    await m.migrate.down();
    assert.equal(await m.schema.hasTable('cash_closings'), false);
    for (const c of ['paid_with', 'cancelled_at']) assert.equal(await m.schema.hasColumn('orders', c), false, c);
    await m.migrate.latest();
    assert.ok(await m.schema.hasTable('cash_closings'));
    assert.ok(await m.schema.hasColumn('orders', 'paid_with'));
  } finally {
    await m.destroy();
  }
});
