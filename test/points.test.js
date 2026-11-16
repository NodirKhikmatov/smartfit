// Task 34: cashback points. Off by default; earn on hand-over (once, even with a status set twice or in parallel), spend
// at checkout (cap, balance, two checkouts racing for one balance), a promo code together with points, spent points
// back on cancel / expiry / return, clawback on return, delivery never paid by points, organisation isolation of the
// ledger and the admin list, "delete my data", the profile page and the bot, and migration 026 down/up.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { releaseExpired, HOLD_MS } from '../src/cart/cart.js';
import { earnPoints, maxSpend, pointsConfig, checkSpend, spend } from '../src/cart/points.js';
import { handleUpdate } from '../src/notify/telegram.js';
import { createDb } from '../src/db/index.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
const BOT = { token: '1:x', username: 'smartfit_test_bot' };
const weather = async () => ({ temperature: 15, apparent_temperature: 14, raining: false, wind_speed: 3, source: 'live' });
let server, base, tash, tash2, sam, orgA, orgB, owner, ownerB, manager2;

const call = async (method, p, body, token) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const admin = (method, p, body, token = owner) => call(method, `/api/admin${p}`, body, token);
const login = async (email, password) => (await call('POST', '/api/admin/login', { email, password })).body.token;

// Telegram, simulated against the same DB.
const sent = [];
const send = async (chat, text, extra) => void sent.push({ chat, text, extra });
const msg = (from, extra) => handleUpdate(db, { update_id: 1, message: { chat: { id: from, type: 'private' }, from: { id: from, language_code: 'uz' }, ...extra } }, send, { base: 'https://shop.test' });
const startLink = (from, url) => msg(from, { text: `/start ${new URL(url).searchParams.get('start')}` });
const contact = (from, phone) => msg(from, { contact: { phone_number: phone.replace('+', ''), first_name: 'Aziz', user_id: from } });

// A profile in the store's organisation for Telegram user `from` with this phone.
async function profile(store, from, phone) {
  const r = await call('POST', '/api/profile/link', { store_id: store, lang: 'uz', gender: 'male', top: 'M', bottom: 'L' });
  await startLink(from, r.body.url);
  await contact(from, phone);
  return db('customer_profiles').where({ telegram_user_id: from, organization_id: (await db('stores').where({ id: store }).first()).organization_id }).first();
}
// "Ballarni ishlatish" on a cart: the one-time login with the cart token, confirmed in Telegram.
async function linkCart(c, from, phone, store = c.store_id) {
  const r = await call('POST', '/api/profile/login', { store_id: store, lang: 'uz', cart: c.token });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await startLink(from, r.body.url);
  assert.match(sent.at(-1).text, /keshbek ballaringizni ulash/, 'the bot says the points go to this cart');
  await contact(from, phone);
  return (await call('GET', `/api/cart/${c.token}`)).body;
}
// A cart of `n` units of one top at this price.
async function cart(store, unitPrice = 200000, n = 1) {
  const p = await db('products').where({ store_id: store, category: 'top' }).orderBy('id').first();
  await db('products').where({ id: p.id }).update({ price: unitPrice, discount_price: null });
  await db('product_stock').where({ product_id: p.id, size: 'M' }).update({ quantity: 1000 });
  let body;
  for (let i = 0; i < n; i++) body = (await call('POST', '/api/cart/items', { token: body?.token, store_id: store, items: [{ product_id: p.id, size: 'M' }] })).body;
  return body;
}
const checkout = (c, extra = {}) => call('POST', `/api/cart/${c.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '+998901112233', ...extra });
async function order(store, extra = {}, unitPrice = 200000, n = 1) {
  const r = await checkout(await cart(store, unitPrice, n), extra);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.order;
}
const step = (o, status, token = owner) => admin('POST', `/orders/${o.id}/status`, { status }, token);
async function deliver(o, token = owner) {
  assert.equal((await admin('POST', `/orders/${o.id}/pay`, {}, token)).status, 200);
  assert.equal((await step(o, 'packing', token)).status, 200);
  if (o.fulfillment === 'delivery') assert.equal((await step(o, 'shipping', token)).status, 200);
  return step(o, 'delivered', token);
}
const rows = (q) => db('points_ledger').where(q).orderBy('id');
const balance = async (profileId) => Number((await db('points_ledger').where({ profile_id: profileId }).sum({ n: 'amount' }))[0].n ?? 0);
const setPoints = (org, cashback_percent, points_max_share = 50) => db('organizations').where({ id: org }).update({ cashback_percent, points_max_share });
let keyN = 0;
const key = () => (++keyN).toString(16).padStart(32, '0');

before(async () => {
  await db.migrate.latest();
  await seed(db); // two organisations, one store each
  [tash, sam] = (await db('stores').orderBy('id')).map((s) => s.id);
  [orgA, orgB] = (await db('stores').orderBy('id')).map((s) => s.organization_id);
  [{ id: tash2 }] = await db('stores').insert({ name: 'A filial', city: 'Toshkent', address: 'Chilonzor 1', lat: 41.28, lon: 69.2, delivery_fee: 25000, organization_id: orgA }).returning('id');
  const { id: _id, sku: _sku, barcode: _b, created_at: _c, updated_at: _u, ...top } = await db('products').where({ store_id: tash, category: 'top' }).orderBy('id').first();
  const [{ id: top2 }] = await db('products').insert({ ...top, store_id: tash2 }).returning('id');
  await db('product_stock').insert({ product_id: top2, size: 'M', quantity: 1000 });
  await createAdmin(db, { email: 'owner@smartfit.uz', password: 'owner-pass-1', storeId: tash });
  await createAdmin(db, { email: 'owner.b@smartfit.uz', password: 'owner-pass-2', storeId: sam });
  await createAdmin(db, { email: 'mgr2@smartfit.uz', password: 'mgr-pass-2', storeId: tash2, role: 'manager' });
  server = createApp(db, { weather, stylist: null, telegram: BOT, limits: { promo: 1000, cart: 0, recommend: 0, profile: 0, profilePoll: 0 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await login('owner@smartfit.uz', 'owner-pass-1');
  ownerB = await login('owner.b@smartfit.uz', 'owner-pass-2');
  manager2 = await login('mgr2@smartfit.uz', 'mgr-pass-2');
});
after(async () => {
  server.close();
  await db.destroy();
});

test('off by default: no points in the cart, totals as before, nothing earned, checkout refuses points', async () => {
  const p = await profile(tash, 1001, '+998901110001');
  const c = await cart(tash);
  assert.equal(c.points, undefined);
  assert.equal(c.totals.pickup.total, 200000);
  assert.equal((await checkout(c, { phone: '+998901110001', points: 1000 })).body.code, 'points_unavailable');
  const o = await order(tash, { phone: '+998901110001' });
  assert.equal(o.points_discount, 0);
  assert.equal(o.total, 200000);
  assert.equal((await deliver(o)).status, 200);
  assert.equal((await rows({ profile_id: p.id })).length, 0);
  assert.equal((await admin('GET', '/points')).body.cashback_percent, 0);
});

test('earn on hand-over: once, on the money paid for the goods, also with the status set twice or in parallel', async () => {
  await setPoints(orgA, 5);
  const p = await profile(tash, 1002, '+998901110002');
  const o = await order(tash, { phone: '+998901110002' }, 199999);
  await admin('POST', `/orders/${o.id}/pay`, {});
  assert.equal((await rows({ profile_id: p.id })).length, 0, 'paid is not enough: a paid order can still be cancelled');
  await step(o, 'packing');
  const both = await Promise.all([step(o, 'delivered'), step(o, 'delivered')]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await step(o, 'delivered')).status, 409);
  await db.transaction((trx) => earnPoints(trx, o.id)); // a repeated call is ignored by the unique ref
  const r = await rows({ order_id: o.id });
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'earn');
  assert.equal(r[0].amount, 9999, 'floor(5 % of 199 999)');
  assert.equal(r[0].profile_id, p.id, 'found by the Telegram-verified phone');
  // Delivery: the fee earns nothing.
  const d = await order(tash2, { phone: '+998901110002', fulfillment: 'delivery', address: 'Amir Temur 1, kv 5' }, 100000);
  assert.equal(d.delivery_fee, 25000);
  await deliver(d);
  assert.equal((await rows({ order_id: d.id }))[0].amount, 5000);
  // No profile with that phone in this organisation: nothing.
  const x = await order(tash, { phone: '+998909999999' });
  await deliver(x);
  assert.equal((await rows({ order_id: x.id })).length, 0);
});

test('spend at checkout: linked in Telegram, the cap, more than the balance, the server totals', async () => {
  await setPoints(orgA, 10, 50);
  const p = await profile(tash, 1003, '+998901110003');
  const first = await order(tash, { phone: '+998901110003' }, 600000);
  await deliver(first); // earns 60 000
  assert.equal(await balance(p.id), 60000);

  const c = await cart(tash, 100000);
  assert.deepEqual(c.points, { percent: 10, share: 50, linked: false, balance: 0, max: 0, totals: c.points.totals });
  assert.equal((await checkout(c, { points: 1 })).body.code, 'points_unavailable', 'not linked');
  const linked = await linkCart(c, 1003, '+998901110003');
  assert.match(sent.at(-1).text, /60\s000/);
  assert.equal(linked.points.linked, true);
  assert.equal(linked.points.balance, 60000);
  assert.equal(linked.points.max, 50000, 'the cap: 50 % of 100 000');
  assert.equal(linked.points.totals.pickup.total, 50000);
  assert.equal(linked.totals.pickup.total, 100000, 'without points the total is unchanged');
  for (const [points, code] of [[50001, 'points_cap'], [-1, 'invalid'], [1.5, 'invalid'], ['9', 'invalid']]) {
    const r = await checkout(c, { points, phone: '+998901110003' });
    assert.equal(r.body.code, code, `${points}`);
  }
  const r = await checkout(c, { points: 50000, phone: '+998901110003' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.order.points_discount, 50000);
  assert.equal(r.body.order.total, 50000);
  assert.equal(await balance(p.id), 10000);
  const items = await db('order_items').where({ order_id: r.body.order.id });
  assert.equal(items.reduce((s, i) => s + i.points, 0), 50000);
  assert.equal(items.reduce((s, i) => s + i.discount, 0), 50000);
  // More than the balance (under the cap).
  const c2 = await linkCart(await cart(tash, 100000), 1003, '+998901110003');
  assert.equal(c2.points.max, 10000);
  assert.equal((await checkout(c2, { points: 10001 })).body.code, 'points_balance');
  // The order earns on what was paid in money: 10 % of 50 000.
  await deliver(r.body.order);
  assert.equal((await rows({ ref: `earn:${r.body.order.id}` }))[0].amount, 5000);
});

test('two checkouts racing for one balance: one spends, the other is refused; never below zero', async () => {
  await setPoints(orgA, 10, 100);
  const p = await profile(tash, 1004, '+998901110004');
  await deliver(await order(tash, { phone: '+998901110004' }, 1000000)); // 100 000 points
  const carts = [];
  for (let i = 0; i < 4; i++) carts.push(await linkCart(await cart(tash, 100000), 1004, '+998901110004'));
  assert.ok(carts.every((c) => c.points.max === 100000));
  const res = await Promise.all(carts.map((c) => checkout(c, { points: 100000, phone: '+998901110004' })));
  assert.deepEqual(res.map((r) => r.status).sort(), [201, 409, 409, 409], JSON.stringify(res.map((r) => r.body.code)));
  assert.ok(res.filter((r) => r.status === 409).every((r) => r.body.code === 'points_balance'));
  assert.equal(await balance(p.id), 0);
  assert.equal((await rows({ profile_id: p.id, kind: 'spend' })).length, 1);
});

// Deterministic version of the race: A has checked and spent but not committed when B checks. B must wait for A's
// row lock and then see A's spend (without the lock, Postgres would let B read the old balance).
test('the balance check waits for an open spend of the same customer', async () => {
  await setPoints(orgA, 10, 100);
  const p = await profile(tash, 1011, '+998901110011');
  const paid = await order(tash, { phone: '+998901110011' }, 500000);
  await deliver(paid); // 50 000
  const cfg = await pointsConfig(db, tash);
  const a = await db.transaction();
  let bDone = false, b;
  try {
    await checkSpend(a, cfg, p.id, 100000, 50000);
    await spend(a, cfg, p.id, paid.id, 50000);
    b = db.transaction(async (trx) => {
      await checkSpend(trx, cfg, p.id, 100000, 50000);
      bDone = true;
    });
    b.catch(() => {}); // awaited below
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(bDone, false, 'B waits while A holds the lock');
    await a.commit();
  } finally {
    if (!a.isCompleted()) await a.rollback().catch(() => {}); // a failed check must not leave A open
  }
  await assert.rejects(b, (err) => err.publicKey === 'err.points_balance');
  assert.equal(await balance(p.id), 0);
});

test('a promo code together with points: bundle, promo, then points on what is left; delivery never paid by points', async () => {
  await setPoints(orgA, 10, 100);
  const p = await profile(tash2, 1005, '+998901110005');
  await deliver(await order(tash, { phone: '+998901110005' }, 3000000)); // 300 000 points
  const code = (await admin('POST', '/promos', { code: 'BALL10', kind: 'percent', value: 10 })).body;
  const c = await cart(tash2, 200000);
  await call('POST', `/api/cart/${c.token}/promo`, { code: code.code });
  const linked = await linkCart(c, 1005, '+998901110005');
  assert.equal(linked.discounts.promo, 20000);
  assert.equal(linked.points.max, 180000, 'points come after the promo code');
  assert.equal(linked.points.totals.delivery.total, 25000, 'the delivery fee stays');
  assert.equal(linked.points.totals.delivery.delivery_fee, linked.totals.delivery.delivery_fee, 'points do not change the free-delivery threshold');
  const r = await checkout(c, { points: 180000, phone: '+998901110005', fulfillment: 'delivery', address: 'Amir Temur 1, kv 5' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const o = r.body.order;
  assert.deepEqual([o.subtotal, o.promo_discount, o.points_discount, o.delivery_fee, o.total], [200000, 20000, 180000, 25000, 25000]);
  assert.equal(await balance(p.id), 120000);
  assert.equal(maxSpend(100, -5, 100), 0, 'a negative balance spends nothing');
  const status = (await call('GET', `/api/orders/${(await db('orders').where({ id: o.id }).first()).notify_token}`)).body;
  assert.equal(status.points_discount, 180000);
});

test('cancel, expiry and a Payme-style refund give the spent points back once', async () => {
  await setPoints(orgA, 10, 100);
  const p = await profile(tash, 1006, '+998901110006');
  await deliver(await order(tash, { phone: '+998901110006' }, 1000000)); // 100 000
  const spendOn = async () => {
    const c = await linkCart(await cart(tash, 50000), 1006, '+998901110006');
    const r = await checkout(c, { points: 30000, phone: '+998901110006' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.order;
  };
  // Unpaid, cancelled twice in parallel.
  const a = await spendOn();
  assert.equal(await balance(p.id), 70000);
  const both = await Promise.all([step(a, 'cancelled'), step(a, 'cancelled')]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await balance(p.id), 100000);
  // Expired (the 15-minute hold), swept twice.
  const b = await spendOn();
  await releaseExpired(db, Date.now() + HOLD_MS + 1000);
  await releaseExpired(db, Date.now() + HOLD_MS + 2000);
  assert.equal((await db('orders').where({ id: b.id }).first()).status, 'cancelled');
  assert.equal(await balance(p.id), 100000);
  // Paid, then cancelled before it left the store.
  const c = await spendOn();
  await admin('POST', `/orders/${c.id}/pay`, {});
  assert.equal((await step(c, 'cancelled')).status, 200);
  assert.equal(await balance(p.id), 100000);
  assert.equal((await rows({ profile_id: p.id, kind: 'refund' })).length, 3);
  assert.equal((await rows({ order_id: c.id, kind: 'earn' })).length, 0, 'a cancelled order earns nothing');
});

test('return: earned points are clawed back in proportion, spent points come back; an exchange changes nothing', async () => {
  await setPoints(orgA, 10, 50);
  const p = await profile(tash, 1007, '+998901110007');
  const o = await order(tash, { phone: '+998901110007' }, 100001, 3);
  await deliver(o);
  const [earn] = await rows({ order_id: o.id, kind: 'earn' });
  assert.equal(earn.amount, 30000); // floor(10 % of 300 003)
  const line = await db('order_items').where({ order_id: o.id }).first();
  const ret = (qty, kind = 'return', extra = {}) => admin('POST', `/orders/${o.id}/returns`, { key: key(), item_id: line.id, kind, reason: 'too_big', quantity: qty, restock: true, ...extra });
  assert.equal((await ret(1, 'exchange', { new_size: 'L' })).status, 201);
  assert.equal((await rows({ order_id: o.id, kind: 'clawback' })).length, 0, 'an exchange keeps the points');
  const k = key();
  const twice = await Promise.all([1, 2].map(() => admin('POST', `/orders/${o.id}/returns`, { key: k, item_id: line.id, kind: 'return', reason: 'too_big', quantity: 1, restock: true })));
  assert.deepEqual(twice.map((r) => r.status).sort(), [200, 201], 'a double submit is one return');
  assert.equal((await rows({ order_id: o.id, kind: 'clawback' }))[0].amount, -10000, 'ceil(30 000 × 100 001 / 300 003)');
  assert.equal((await ret(1)).status, 201);
  const claws = await rows({ order_id: o.id, kind: 'clawback' });
  assert.equal(claws.reduce((s, r) => s + r.amount, 0), -20000, 'two of three units refunded → two thirds');
  assert.equal(await balance(p.id), 10000);

  // Spent points on a returned line come back, earned ones go; a balance can go below zero.
  const before = await balance(p.id);
  const c = await linkCart(await cart(tash, 10000, 2), 1007, '+998901110007');
  const r = await checkout(c, { points: c.points.max, phone: '+998901110007' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.order.points_discount, 10000);
  await deliver(r.body.order);
  assert.equal((await rows({ order_id: r.body.order.id, kind: 'earn' }))[0].amount, 1000);
  await db('points_ledger').insert({ organization_id: orgA, profile_id: p.id, order_id: r.body.order.id, kind: 'spend', amount: -(await balance(p.id)), ref: 'test:drain' });
  const l2 = await db('order_items').where({ order_id: r.body.order.id }).first();
  const rr = await admin('POST', `/orders/${r.body.order.id}/returns`, { key: key(), item_id: l2.id, kind: 'return', reason: 'defect', quantity: 1, restock: false });
  assert.equal(rr.status, 201, JSON.stringify(rr.body));
  assert.equal(rr.body.returns[0].refund, 5000, 'the money refund is only what was paid in money');
  const [back] = await rows({ order_id: r.body.order.id, kind: 'return' });
  const [claw] = await rows({ order_id: r.body.order.id, kind: 'clawback' });
  assert.deepEqual([back.amount, claw.amount], [5000, -500]);
  assert.equal(await balance(p.id), 4500);
  assert.ok(before > 0);
});

test('organisations: points of one shop never reach another, in checkout, earning and the admin list', async () => {
  await setPoints(orgA, 10, 100);
  await setPoints(orgB, 10, 100);
  const pa = await profile(tash, 1008, '+998901110008');
  await deliver(await order(tash, { phone: '+998901110008' }, 500000));
  assert.equal(await balance(pa.id), 50000);
  // In org B the same Telegram user has no profile: the login finds none and the cart stays unlinked.
  const cb = await cart(sam, 100000);
  const linked = await linkCart(cb, 1008, '+998901110008');
  assert.equal(linked.points.linked, false);
  assert.equal((await checkout(cb, { points: 1000, phone: '+998901110008' })).body.code, 'points_unavailable');
  // A cart of org B can't be linked through an org A login (the store must match the cart's).
  const cb2 = await cart(sam, 100000);
  const viaA = await linkCart(cb2, 1008, '+998901110008', tash);
  assert.equal(viaA.points.linked, false);
  // An org B order with the same phone earns nothing for the org A profile.
  const ob = await order(sam, { phone: '+998901110008' });
  await deliver(ob, ownerB);
  assert.equal((await rows({ order_id: ob.id })).length, 0);
  assert.equal(await balance(pa.id), 50000);
  // Admin: org B's owner never sees org A's customers or totals; org A's store is refused.
  const b = await admin('GET', '/points', undefined, ownerB);
  assert.equal(b.status, 200);
  assert.ok(!JSON.stringify(b.body).includes('+998901110008'));
  assert.equal((await admin('GET', `/points?store_id=${tash}`, undefined, ownerB)).status, 403);
  assert.equal((await admin('PATCH', '/points', { store_id: tash, cashback_percent: 0 }, ownerB)).status, 403);
  // Org A's owner sees them; a manager of the other org A store sees only customers from that store, and can't edit.
  const a = await admin('GET', '/points');
  assert.ok(a.body.customers.some((c) => c.phone === '+998901110008' && c.balance === 50000));
  assert.ok(a.body.outstanding >= 50000);
  const m = await admin('GET', '/points', undefined, manager2);
  assert.equal(m.status, 200);
  assert.ok(!m.body.customers.some((c) => c.phone === '+998901110008'), 'that customer bought only in the other store');
  assert.ok(m.body.customers.some((c) => c.phone === '+998901110005'), 'a customer of this store (promo test)');
  assert.equal(m.body.can_edit, false);
  assert.equal((await admin('PATCH', '/points', { cashback_percent: 0 }, manager2)).status, 403);
  // Setting validation.
  for (const body of [{ cashback_percent: 21 }, { cashback_percent: -1 }, { points_max_share: 101 }, { cashback_percent: '5' }]) {
    assert.equal((await admin('PATCH', '/points', body)).status, 400, JSON.stringify(body));
  }
  const ok = await admin('PATCH', '/points', { cashback_percent: 7, points_max_share: 30 });
  assert.deepEqual([ok.status, ok.body.cashback_percent, ok.body.points_max_share], [200, 7, 30]);
  assert.ok(await db('audit_log').where({ action: 'org.points' }).first());
});

test('profile page and bot show the balance and history; "delete my data" removes the ledger rows', async () => {
  await setPoints(orgA, 10, 100);
  const p = await profile(tash, 1009, '+998901110009');
  await deliver(await order(tash, { phone: '+998901110009' }, 300000));
  // The profile page link from /profile.
  await msg(1009, { text: '/profile' });
  const token = /\/profile\/([a-f0-9]{32})/.exec(sent.at(-1).text)[1];
  const page = (await call('GET', `/api/profile/me/${token}`)).body;
  assert.equal(page.points.balance, 30000);
  assert.equal(page.points.percent, 10);
  assert.equal(page.points.history[0].kind, 'earn');
  await msg(1009, { text: '/points' });
  assert.match(sent.at(-1).text, /30\s000/);
  assert.match(sent.at(-1).text, /\+30\s000/);
  // An open cart linked to the profile and an order that remembers it.
  const c = await linkCart(await cart(tash, 100000), 1009, '+998901110009');
  const o = (await checkout(c, { points: 10000, phone: '+998901110009' })).body.order;
  assert.equal((await db('orders').where({ id: o.id }).first()).profile_id, p.id);
  const c2 = await linkCart(await cart(tash, 100000), 1009, '+998901110009');
  assert.equal(c2.points.linked, true);
  assert.equal((await call('DELETE', `/api/profile/me/${token}`)).status, 204);
  assert.equal((await rows({ profile_id: p.id })).length, 0);
  assert.equal((await db('orders').where({ id: o.id }).first()).profile_id, null);
  assert.equal((await db('orders').where({ id: o.id }).first()).points_discount, 10000, 'the sale record keeps the sum');
  assert.equal((await call('GET', `/api/cart/${c2.token}`)).body.points.linked, false);
  assert.ok(!(await admin('GET', '/points')).body.customers.some((x) => x.phone === '+998901110009'));
  // The open order is cancelled later: nothing to give back, nothing breaks.
  assert.equal((await step(o, 'cancelled')).status, 200);
  await msg(1009, { text: '/points' });
  assert.match(sent.at(-1).text, /ball/i);
});

test('the cart unlinks; login with a bad cart token is refused', async () => {
  await setPoints(orgA, 10, 100);
  await profile(tash, 1010, '+998901110010');
  const c = await linkCart(await cart(tash), 1010, '+998901110010');
  assert.equal(c.points.linked, true);
  const off = await call('DELETE', `/api/cart/${c.token}/points`);
  assert.equal(off.body.points.linked, false);
  assert.equal((await checkout(c, { points: 1 })).body.code, 'points_unavailable');
  assert.equal((await call('POST', '/api/profile/login', { store_id: tash, lang: 'uz', cart: 'nope' })).status, 400);
});

test('migration 026: the orders CHECK holds points; down folds them into the subtotal; up again', async () => {
  const file = path.join(tmpdir(), `sf-points-${process.pid}.db`);
  const m = createDb({ databaseUrl: '', sqliteFile: file }); // SQLite's table rebuild; Postgres steps 026 down in orgs.test.js
  try {
    await m.migrate.latest();
    await seed(m);
    const store = await m('stores').orderBy('id').first();
    const [{ id }] = await m('orders').insert({ store_id: store.id, number: 1, customer_name: 'A', phone: '+998901112233', fulfillment: 'pickup', subtotal: 100000, points_discount: 30000, delivery_fee: 0, total: 70000 }).returning('id');
    await assert.rejects(m('orders').insert({ store_id: store.id, number: 2, customer_name: 'A', phone: '+998901112233', fulfillment: 'pickup', subtotal: 100000, points_discount: 30000, delivery_fee: 0, total: 100000 }));
    await assert.rejects(m('orders').insert({ store_id: store.id, number: 3, customer_name: 'A', phone: '+998901112233', fulfillment: 'pickup', subtotal: 100000, points_discount: 100001, delivery_fee: 0, total: -1 }));
    await m.migrate.down(); // 036
    await m.migrate.down(); // 035
    await m.migrate.down(); // 034
    await m.migrate.down(); // 033
    await m.migrate.down(); // 032
    await m.migrate.down(); // 031
    await m.migrate.down(); // 030
    await m.migrate.down(); // 029
    await m.migrate.down(); // 028
    await m.migrate.down(); // 027
    await m.migrate.down(); // 026
    const o = await m('orders').where({ id }).first();
    assert.deepEqual([o.subtotal, o.total, 'points_discount' in o], [70000, 70000, false]);
    await m.migrate.latest();
    assert.equal((await m('orders').where({ id }).first()).points_discount, 0);
  } finally {
    await m.destroy();
    await rm(file, { force: true });
  }
});
