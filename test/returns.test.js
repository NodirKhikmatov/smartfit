// Task 23: returns and size exchanges, "how did it fit?" from the status page, the per-product fit offset and its use
// when the engine picks an item's size, and the dashboard's return numbers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { filterCandidates } from '../src/recommend/engine.js';
import { fitOffset, shiftSize, fitStats, FIT_MIN } from '../src/size/size.js';
import { message } from '../src/notify/telegram.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, store, owner, manager, top;

const call = async (method, p, body, token) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const admin = (method, p, body, token = manager) => call(method, `/api/admin${p}`, body, token);
const login = async (email, password) => (await admin('POST', '/login', { email, password })).body.token;
const key = () => Math.random().toString(16).slice(2).padEnd(16, '0').repeat(2).slice(0, 32);
const stock = async (productId, size) => (await db('product_stock').where({ product_id: productId, size }).first()).quantity;
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

// A paid, handed-over pickup order of `qty` units of one product in one size; `token` is the status page token.
async function delivered(productId, size = 'M', qty = 1, { deliver = true } = {}) {
  await db('product_stock').where({ product_id: productId, size }).update({ quantity: 10, reserved: 0 });
  let cart;
  for (let i = 0; i < qty; i++) cart = (await call('POST', '/api/cart/items', { token: cart?.token, store_id: store, items: [{ product_id: productId, size }] })).body;
  const { order, track } = (await call('POST', `/api/cart/${cart.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '+998901234567' })).body;
  if (deliver) for (const [step, body] of [['pay', {}], ['status', { status: 'packing' }], ['status', { status: 'delivered' }]]) await admin('POST', `/orders/${order.id}/${step}`, body);
  return { ...order, token: track.url.split('/').pop() };
}

before(async () => {
  await db.migrate.latest();
  await seed(db);
  store = (await db('stores').orderBy('id').first()).id;
  await createAdmin(db, { email: 'own@smartfit.uz', password: 'own-pass-1', storeId: store });
  await createAdmin(db, { email: 'mgr@smartfit.uz', password: 'mgr-pass-1', storeId: store, role: 'manager' });
  server = createApp(db, { telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await login('own@smartfit.uz', 'own-pass-1');
  manager = await login('mgr@smartfit.uz', 'mgr-pass-1');
  top = await db('products').where({ store_id: store, category: 'top' }).whereIn('gender', ['male', 'unisex']).where('temp_min', '<=', 15).where('temp_max', '>=', 15).orderBy('id').first();
});
after(async () => {
  server.close();
  await db.destroy();
});

test('a return restocks once: a double submit (sequential or parallel) changes nothing, and units never pass the line', async () => {
  const o = await delivered(top.id, 'M', 2);
  const line = o.items[0];
  const before = await stock(top.id, 'M');
  const body = { key: key(), item_id: line.id, kind: 'return', reason: 'too_small', quantity: 1, restock: true };
  const [a, b] = await Promise.all([admin('POST', `/orders/${o.id}/returns`, body), admin('POST', `/orders/${o.id}/returns`, body)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201], `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`);
  assert.equal((await admin('POST', `/orders/${o.id}/returns`, body)).status, 200, 'a later resend is answered, not repeated');
  assert.equal(await stock(top.id, 'M'), before + 1, 'stock came back once');
  const view = (await admin('GET', `/orders/${o.id}`)).body;
  assert.equal(view.returns.length, 1);
  assert.equal(view.items[0].returned, 1);
  assert.equal(view.returns[0].refund, line.unit_price, 'refund defaults to the returned share of the line');
  // The second unit with a new key works; a third doesn't exist.
  assert.equal((await admin('POST', `/orders/${o.id}/returns`, { ...body, key: key(), restock: false })).status, 201);
  assert.equal(await stock(top.id, 'M'), before + 1, 'restock: false leaves stock alone');
  const over = await admin('POST', `/orders/${o.id}/returns`, { ...body, key: key() });
  assert.deepEqual([over.status, over.body.code], [409, 'return_too_many'], 'nothing left on the line');
  assert.equal((await admin('POST', `/orders/${o.id}/returns`, { ...body, key: key(), quantity: 3 })).status, 400, 'more than the line ever had');
  assert.equal((await db('order_returns').where({ order_id: o.id })).length, 2);
  const audit = await db('audit_log').where({ action: 'order.return', entity_id: o.id });
  assert.equal(audit.length, 2, 'one audit row per return');
});

test('refunds never exceed the paid line; exchanges move stock and need free stock in the new size', async () => {
  const o = await delivered(top.id, 'M', 1);
  const line = o.items[0];
  const base = { item_id: line.id, kind: 'return', reason: 'disliked', quantity: 1, restock: true };
  assert.equal((await admin('POST', `/orders/${o.id}/returns`, { ...base, key: key(), refund: line.unit_price + 1 })).status, 400);
  assert.equal((await admin('POST', `/orders/${o.id}/returns`, { ...base, key: key(), refund: -1 })).status, 400);
  assert.equal((await admin('POST', `/orders/${o.id}/returns`, { ...base, key: key(), reason: 'lost' })).status, 400);
  assert.equal((await admin('POST', `/orders/${o.id}/returns`, { ...base, key: 'nope' })).status, 400);
  // Exchange M → L while L is sold out: refused and nothing changed (the claim and the key row roll back).
  await db('product_stock').where({ product_id: top.id, size: 'L' }).update({ quantity: 0, reserved: 0 });
  const m = await stock(top.id, 'M');
  const ex = { item_id: line.id, kind: 'exchange', reason: 'too_small', quantity: 1, restock: true, new_size: 'L' };
  const sold = await admin('POST', `/orders/${o.id}/returns`, { ...ex, key: key() });
  assert.equal(sold.status, 409, JSON.stringify(sold.body));
  assert.equal(await stock(top.id, 'M'), m);
  assert.equal((await db('order_items').where({ id: line.id }).first()).returned, 0);
  assert.equal((await admin('POST', `/orders/${o.id}/returns`, { ...ex, key: key(), refund: 5 })).status, 400, 'an exchange refunds nothing');
  await db('product_stock').where({ product_id: top.id, size: 'L' }).update({ quantity: 2 });
  assert.equal((await admin('POST', `/orders/${o.id}/returns`, { ...ex, key: key() })).status, 201);
  assert.equal(await stock(top.id, 'M'), m + 1);
  assert.equal(await stock(top.id, 'L'), 1);
  // A partial refund is fine; an order that wasn't handed over can't be returned.
  const o2 = await delivered(top.id, 'S', 1);
  const r = await admin('POST', `/orders/${o2.id}/returns`, { ...base, item_id: o2.items[0].id, key: key(), refund: 1000 });
  assert.equal(r.body.returns[0].refund, 1000);
  const pending = await delivered(top.id, 'S', 1, { deliver: false });
  const nd = await admin('POST', `/orders/${pending.id}/returns`, { ...base, item_id: pending.items[0].id, key: key() });
  assert.equal(nd.status, 409);
  assert.equal(nd.body.code, 'return_not_delivered');
  // Another order's line is not found.
  assert.equal((await admin('POST', `/orders/${o2.id}/returns`, { ...base, item_id: line.id, key: key() })).status, 404);
});

test('fit feedback only through the order\'s own status token, after hand-over, one answer per line', async () => {
  const mine = await delivered(top.id, 'M', 1);
  const other = await delivered(top.id, 'M', 1);
  const item = mine.items[0].id;
  const page = (await call('GET', `/api/orders/${mine.token}`)).body;
  assert.equal(page.fit_open, true);
  assert.equal(page.items[0].id, item);
  assert.ok(!JSON.stringify(page).includes('Aziz') && !JSON.stringify(page).includes('+998'), 'still no name or phone');
  assert.equal((await call('POST', `/api/orders/${other.token}/fit`, { item, fit: 'small' })).status, 404, 'another order\'s token');
  assert.equal((await call('POST', `/api/orders/${'0'.repeat(32)}/fit`, { item, fit: 'small' })).status, 404);
  assert.equal((await call('POST', `/api/orders/${mine.token}/fit`, { item, fit: 'tight' })).status, 400);
  assert.equal((await call('POST', `/api/orders/${mine.token}/fit`, { item, fit: 'small' })).status, 200);
  assert.equal((await call('POST', `/api/orders/${mine.token}/fit`, { item, fit: 'right' })).status, 200, 'a new answer replaces the old');
  assert.deepEqual((await db('order_items').where({ order_id: mine.id })).map((i) => i.fit), ['right']);
  assert.equal((await call('GET', `/api/orders/${mine.token}`)).body.items[0].fit, 'right');
  const early = await delivered(top.id, 'M', 1, { deliver: false });
  assert.equal((await call('GET', `/api/orders/${early.token}`)).body.fit_open, false);
  const r = await call('POST', `/api/orders/${early.token}/fit`, { item: early.items[0].id, fit: 'small' });
  assert.equal(r.status, 409);
  const acc = await db('products').where({ store_id: store, category: 'accessory' }).first();
  await db('product_stock').where({ product_id: acc.id }).update({ quantity: 5, reserved: 0 });
  const ao = await delivered(acc.id, 'ONE', 1);
  assert.equal((await call('POST', `/api/orders/${ao.token}/fit`, { item: ao.items[0].id, fit: 'big' })).status, 404, 'accessories have no fit');
});

test('offset rule: at least 5 answers, a clear majority, the owner override wins, the shift is clamped', () => {
  assert.equal(FIT_MIN, 5);
  assert.equal(fitOffset({ small: 4 }), 0, 'never below 5 answers');
  assert.equal(fitOffset({ small: 5 }), 1);
  assert.equal(fitOffset({ big: 3, right: 2 }), -1);
  assert.equal(fitOffset({ small: 3, right: 3 }), 0, 'half is not a majority');
  assert.equal(fitOffset({ small: 3, big: 3, right: 1 }), 0);
  assert.equal(fitOffset({ small: 9 }, 0), 0, 'override 0 = true to size');
  assert.equal(fitOffset({}, -1), -1, 'override works without answers');
  assert.equal(shiftSize(SIZES, 'M', 1), 'L');
  assert.equal(shiftSize(SIZES, 'XXL', 1), 'XXL', 'clamped at the top');
  assert.equal(shiftSize(SIZES, 'XS', -1), 'XS', 'clamped at the bottom');
  assert.equal(shiftSize(['36', '37', '38'], '37', -1), '36');
});

test('the engine offers a size up for a product that runs small, never a sold-out size, and the card gets the hint', async () => {
  const p = await db('products').where({ store_id: store, category: 'top', audience: 'adult' }).whereIn('gender', ['male', 'unisex']).where('temp_min', '<=', 15).where('temp_max', '>=', 15).orderBy('id', 'desc').first();
  await db('product_stock').where({ product_id: p.id }).update({ quantity: 3, reserved: 0 });
  const find = async (top) => (await filterCandidates(db, { storeId: store, gender: 'male', sizes: { top, bottom: 'M' }, temperature: 15 })).find((c) => c.id === p.id);
  assert.equal((await find('M')).size, 'M', 'no answers yet: own size');
  // Four "small" answers and one size return "too small" on another line = five signals.
  const o = await delivered(p.id, 'M', 1);
  await db('order_items').insert(Array.from({ length: 4 }, () => ({ order_id: o.id, product_id: p.id, size: 'M', quantity: 1, unit_price: 1, fit: 'small' })));
  assert.equal(fitOffset((await fitStats(db, [p.id])).get(p.id)), 0, 'four answers are not enough');
  await admin('POST', `/orders/${o.id}/returns`, { key: key(), item_id: o.items[0].id, kind: 'return', reason: 'too_small', quantity: 1, restock: true });
  assert.deepEqual((await fitStats(db, [p.id])).get(p.id), { small: 5, right: 0, big: 0 });
  const up = await find('M');
  assert.equal(up.size, 'L');
  assert.equal(up.fit_offset, 1);
  assert.equal(up.fit_from, 'M');
  const xxl = await find('XXL');
  assert.equal(xxl.size, 'XXL', 'clamped to the largest size');
  assert.equal(xxl.fit_from, null);
  await db('product_stock').where({ product_id: p.id, size: 'L' }).update({ quantity: 0 });
  assert.equal(await find('M'), undefined, 'L sold out: not offered at all, and not in M either');
  await db('product_stock').where({ product_id: p.id, size: 'L' }).update({ quantity: 3 });
  // The size returns win over the customer's own answer on the same line.
  await db('order_items').where({ id: o.items[0].id }).update({ fit: 'big' });
  assert.equal((await fitStats(db, [p.id])).get(p.id).small, 5);

  // Owner override: a manager can't, the owner can (0 = true to size), null goes back to automatic.
  assert.equal((await admin('PATCH', `/products/${p.id}/fit`, { offset: 0 })).status, 403);
  assert.equal((await admin('PATCH', `/products/${p.id}/fit`, { offset: 2 }, owner)).status, 400);
  const set = await admin('PATCH', `/products/${p.id}/fit`, { offset: 0 }, owner);
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.fit, { small: 5, right: 0, big: 0, auto: 1, override: 0, offset: 0 });
  assert.equal((await find('M')).size, 'M');
  assert.equal((await admin('PATCH', `/products/${p.id}/fit`, { offset: null }, owner)).body.fit.offset, 1);
  // Through the API: the recommendation carries the hint for the card.
  const rec = (await call('POST', '/api/recommend', { store_id: store, gender: 'male', sizes: { top: 'M', bottom: 'M' } })).body;
  for (const item of rec.outfits.flatMap((x) => x.items)) {
    if (item.id === p.id) assert.deepEqual([item.size, item.fit_offset, item.fit_from], ['L', 1, 'M']);
    else assert.equal(item.fit_offset, 0);
  }
});

test('dashboard: return rate and top return reasons, store-scoped', async () => {
  const d = (await admin('GET', '/dashboard')).body.returns;
  const rows = await db('order_returns').where({ store_id: store });
  assert.equal(d.units, rows.reduce((a, r) => a + r.quantity, 0));
  assert.ok(d.sold >= d.units && d.sold > 0);
  assert.equal(d.refund, rows.reduce((a, r) => a + r.refund, 0));
  assert.equal(d.reasons[0].reason, 'too_small', 'most units first');
  assert.ok(d.reasons.every((r, i) => i === 0 || d.reasons[i - 1].units >= r.units));
  const other = await db('stores').whereNot({ id: store }).first();
  await createAdmin(db, { email: 'other@smartfit.uz', password: 'other-pass-1', storeId: other.id });
  assert.equal((await admin('GET', '/dashboard', undefined, await login('other@smartfit.uz', 'other-pass-1'))).body.returns.units, 0);
});

test('the handed-over Telegram message asks how it fit, with the status page link', () => {
  const o = { store_name: 'Moda', number: 7, status: 'delivered', payment_status: 'paid', fulfillment: 'pickup', total: 1000 };
  const text = message(o, 'https://fit.example/order/abc');
  assert.match(text, /mos keldimi/);
  assert.ok(text.endsWith('https://fit.example/order/abc'));
  assert.doesNotMatch(message({ ...o, status: 'packing' }, 'https://fit.example/order/abc'), /mos keldimi/);
  assert.doesNotMatch(message(o), /mos keldimi/, 'no link (PUBLIC_URL unset): no question it can\'t answer');
});
