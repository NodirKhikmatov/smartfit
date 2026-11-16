// Task 26: promo codes (dates, minimum, total and per-phone limits under concurrent checkouts, inactive, wrong store /
// organisation, release on cancel and expiry, rate limit) and the "whole outfit" bundle discount, all computed server-side.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { releaseExpired, HOLD_MS } from '../src/cart/cart.js';
import { price, spread } from '../src/cart/promo.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, tash, tash2, sam, owner, ownerB, manager;
const weather = async () => ({ temperature: 15, apparent_temperature: 14, raining: false, wind_speed: 3, source: 'live' });

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
const day = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
let n = 0;
const uniq = (p) => `${p}${++n}${Date.now() % 100000}`;
const promo = async (body, token = owner) => {
  const r = await admin('POST', '/promos', { kind: 'percent', value: 10, ...body, code: body.code ?? uniq('C') }, token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
// A cart of one top (price p) at this store, with plenty of stock.
async function cart(storeId, unitPrice = 200000) {
  const p = await db('products').where({ store_id: storeId, category: 'top' }).orderBy('id').first();
  await db('products').where({ id: p.id }).update({ price: unitPrice, discount_price: null });
  await db('product_stock').where({ product_id: p.id, size: 'M' }).update({ quantity: 1000 });
  const r = await call('POST', '/api/cart/items', { store_id: storeId, items: [{ product_id: p.id, size: 'M' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const apply = (c, code) => call('POST', `/api/cart/${c.token}/promo`, { code });
const checkout = (c, extra = {}) => call('POST', `/api/cart/${c.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '+998901234567', ...extra });
const used = async (id) => (await db('promo_codes').where({ id }).first('used')).used;

before(async () => {
  await db.migrate.latest();
  await seed(db); // two organisations, one store each
  [tash, sam] = (await db('stores').orderBy('id')).map((s) => s.id);
  const { organization_id: orgA } = await db('stores').where({ id: tash }).first();
  [{ id: tash2 }] = await db('stores').insert({ name: 'A filial', city: 'Toshkent', address: 'Chilonzor 1', lat: 41.28, lon: 69.2, organization_id: orgA }).returning('id');
  const { id: _id, sku: _sku, barcode: _b, created_at: _c, updated_at: _u, ...top } = await db('products').where({ store_id: tash, category: 'top' }).orderBy('id').first();
  const [{ id: top2 }] = await db('products').insert({ ...top, store_id: tash2 }).returning('id');
  await db('product_stock').insert({ product_id: top2, size: 'M', quantity: 1000 });
  await createAdmin(db, { email: 'owner@smartfit.uz', password: 'owner-pass-1', storeId: tash });
  await createAdmin(db, { email: 'owner.b@smartfit.uz', password: 'owner-pass-2', storeId: sam });
  await createAdmin(db, { email: 'mgr@smartfit.uz', password: 'mgr-pass-1', storeId: tash, role: 'manager' });
  server = createApp(db, { weather, stylist: null, telegram: null, limits: { promo: 1000, cart: 0, recommend: 0 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await login('owner@smartfit.uz', 'owner-pass-1');
  ownerB = await login('owner.b@smartfit.uz', 'owner-pass-2');
  manager = await login('mgr@smartfit.uz', 'mgr-pass-1');
});
after(async () => {
  server.close();
  await db.destroy();
});

test('pricing: bundle first, then the promo on the rest, floor rounding, never below 0, line shares add up', () => {
  const lines = [{ product_id: 1, quantity: 1, unit_price: 99999 }, { product_id: 2, quantity: 1, unit_price: 50001 }, { product_id: 3, quantity: 2, unit_price: 33333 }];
  const r = price(lines, { bundles: [[1, 2]], bundlePercent: 10, promo: { kind: 'percent', value: 15, min_order: 0 } });
  assert.equal(r.subtotal, 216666);
  assert.equal(r.bundle_discount, 15000); // floor(150000 × 10%)
  assert.equal(r.promo_discount, Math.floor((216666 - 15000) * 0.15)); // 30249: on what is left after the bundle
  assert.equal(r.goods, 216666 - 15000 - 30249);
  assert.equal(r.discounts.reduce((a, b) => a + b, 0), r.bundle_discount + r.promo_discount);
  assert.equal(r.discounts[2] > 0, true, 'the promo share reaches non-bundle lines too');
  for (const d of [1, 7, 33333]) assert.equal(spread([5, 3, 1], Math.min(d, 9)).reduce((a, b) => a + b, 0), Math.min(d, 9));
  assert.deepEqual(spread([0, 10], 4), [0, 4], 'nothing on a 0 line');

  const fixed = price(lines, { promo: { kind: 'fixed', value: 10 ** 9, min_order: 0 } });
  assert.equal(fixed.goods, 0, 'a fixed code bigger than the cart takes it to 0, not below');
  assert.ok(fixed.discounts.every((d, i) => d <= lines[i].unit_price * lines[i].quantity));
  assert.equal(price(lines, { bundles: [[1, 9]], bundlePercent: 10 }).bundle_discount, 0, 'an outfit not all in the cart gives nothing');
  assert.equal(price(lines, { bundles: [[1, 2], [2, 3]], bundlePercent: 10 }).bundle_discount, 15000, 'one unit is in one bundle only');
  assert.equal(price(lines, { bundles: [[1, 2]], bundlePercent: 0 }).bundle_discount, 0, 'rule off');
  const under = price(lines, { bundles: [[1, 2]], bundlePercent: 50, promo: { kind: 'percent', value: 10, min_order: 200000 } });
  assert.equal(under.minOk, false, 'minimum is checked after the bundle');
  assert.equal(under.promo_discount, 0);
});

test('admin: validation, managers out, duplicate code 409, dates as Tashkent days', async () => {
  assert.equal((await admin('GET', '/promos', undefined, manager)).status, 403);
  assert.equal((await admin('POST', '/promos', { code: 'MGR1', kind: 'percent', value: 5 }, manager)).status, 403);
  for (const bad of [{ code: 'a' }, { code: 'bad code' }, { code: '=SUM1' }, { kind: 'half' }, { value: 101 }, { value: 0 }, { kind: 'fixed', value: 1.5 },
    { min_order: -1 }, { max_uses: 0 }, { max_per_phone: 0 }, { starts_on: '2026-13-01' }, { starts_on: day(5), ends_on: day(1) }, { active: 'yes' }]) {
    const r = await admin('POST', '/promos', { code: uniq('V'), kind: 'percent', value: 10, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const p = await promo({ code: 'yoz-2026', starts_on: day(0), ends_on: day(0) });
  assert.equal(p.code, 'YOZ-2026', 'stored upper case');
  assert.deepEqual([p.starts_on, p.ends_on], [day(0), day(0)], 'a one-day code reads back as that day');
  assert.equal((await admin('POST', '/promos', { code: 'Yoz-2026', kind: 'fixed', value: 1000 })).status, 409);
  assert.equal((await admin('POST', '/promos', { code: 'YOZ-2026', kind: 'fixed', value: 1000 }, ownerB)).status, 201, 'another organisation may use the same text');
  const off = await admin('PATCH', `/promos/${p.id}`, { active: false, code: 'HACK' });
  assert.equal(off.body.active, false);
  assert.equal(off.body.code, 'YOZ-2026', 'the code itself never changes');
  const list = (await admin('GET', '/promos')).body;
  assert.ok(list.some((x) => x.id === p.id) && list.every((x) => x.organization_id === p.organization_id));
});

test('codes: dates, inactive, wrong store, wrong organisation, organisation-wide; the cart shows the line', async () => {
  const anyStore = await promo({ value: 10 });
  const onlyTash2 = await promo({ store_id: tash2 });
  const future = await promo({ starts_on: day(2) });
  const past = await promo({ ends_on: day(-1) });
  const off = await promo({ active: false });
  const orgB = await promo({ code: uniq('B') }, ownerB);

  const c = await cart(tash);
  for (const [p, why] of [[onlyTash2, 'another store of the org'], [future, 'not started'], [past, 'ended'], [off, 'switched off'], [orgB, 'another organisation'], [{ code: 'NOPE-123' }, 'unknown'], [{ code: '' }, 'empty']]) {
    const r = await apply(c, p.code);
    assert.equal(r.status, 409, why);
    assert.equal(r.body.code, 'promo_invalid', `${why}: same answer, so a guesser learns nothing`);
  }
  const r = await apply(c, anyStore.code.toLowerCase());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.discounts, { bundle: 0, bundle_percent: 0, promo: 20000, code: { code: anyStore.code, error: null, min_order: 0 } });
  assert.deepEqual(r.body.totals.pickup, { subtotal: 200000, delivery_fee: 0, total: 180000 });
  assert.equal((await apply(await cart(tash2), anyStore.code)).status, 200, 'an organisation-wide code works in every store of it');
  assert.equal((await apply(await cart(tash2), onlyTash2.code)).status, 200);

  const ru = await fetch(`${base}/api/cart/${c.token}/promo`, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'ru' }, body: JSON.stringify({ code: 'NOPE-123' }) });
  assert.equal((await ru.json()).error, 'Этот промокод не действует');

  // Switched off after it was applied: the cart says so and takes nothing off; checkout refuses instead of charging more silently.
  await admin('PATCH', `/promos/${anyStore.id}`, { active: false });
  const view = (await call('GET', `/api/cart/${c.token}`)).body;
  assert.equal(view.discounts.code.error, 'err.promo_invalid');
  assert.equal(view.totals.pickup.total, 200000);
  assert.equal((await checkout(c)).body.code, 'promo_invalid');
  assert.equal((await call('DELETE', `/api/cart/${c.token}/promo`)).body.discounts.code, null);
  assert.equal((await checkout(c)).status, 201, 'without the code the order goes through');
});

test('minimum order: checked on the cart, refused at checkout below it, with the sum in the message', async () => {
  const p = await promo({ kind: 'fixed', value: 50000, min_order: 300000 });
  const c = await cart(tash, 200000);
  const r = await apply(c, p.code);
  assert.equal(r.status, 200, 'the code is fine, the cart is short');
  assert.equal(r.body.discounts.code.error, 'err.promo_min');
  assert.equal(r.body.discounts.promo, 0);
  const out = await checkout(c);
  assert.equal(out.status, 409);
  assert.match(out.body.error, /^Bu promo-kod 300\s000 so'mdan boshlab xaridga ishlaydi$/);
  assert.equal(await used(p.id), 0);
  const top = c.items[0];
  await db('product_stock').where({ product_id: top.product_id, size: 'L' }).update({ quantity: 50 });
  await call('POST', '/api/cart/items', { token: c.token, store_id: tash, items: [{ product_id: top.product_id, size: 'L' }] });
  const ok = await checkout(c);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.order.promo_discount, 50000);
  assert.equal(ok.body.order.total, 400000 - 50000);
  assert.equal(ok.body.order.items.reduce((s, i) => s + i.discount, 0), 50000);
});

test('total limit holds under concurrent checkouts; cancel and expiry give the use back', async () => {
  const p = await promo({ max_uses: 2 });
  const carts = await Promise.all(Array.from({ length: 6 }, () => cart(tash)));
  for (const c of carts) assert.equal((await apply(c, p.code)).status, 200);
  const res = await Promise.all(carts.map((c, i) => checkout(c, { phone: `+99890${String(1000000 + i)}` })));
  const ok = res.filter((r) => r.status === 201);
  assert.equal(ok.length, 2, res.map((r) => `${r.status} ${r.body.code ?? ''}`).join(', '));
  assert.ok(res.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.body.code === 'promo_used_up'));
  assert.equal(await used(p.id), 2);
  assert.equal((await apply(await cart(tash), p.code)).body.code, 'promo_used_up');

  // A manager cancels one unpaid order → one use is free again.
  const [a, b] = ok.map((r) => r.body.order);
  assert.equal((await admin('POST', `/orders/${a.id}/status`, { status: 'cancelled' }, manager)).status, 200);
  assert.equal(await used(p.id), 1);
  assert.equal((await admin('POST', `/orders/${a.id}/status`, { status: 'cancelled' }, manager)).status, 409, 'cancelled once');
  assert.equal(await used(p.id), 1, 'released once');
  // The other one expires unpaid → released by the sweep.
  await releaseExpired(db, Date.now() + HOLD_MS + 1000);
  assert.equal((await db('orders').where({ id: b.id }).first()).status, 'cancelled');
  assert.equal(await used(p.id), 0);
  // A paid order cancelled before it left the store releases too.
  const c = await cart(tash);
  await apply(c, p.code);
  const o = (await checkout(c)).body.order;
  await admin('POST', `/orders/${o.id}/pay`, {}, manager);
  assert.equal(await used(p.id), 1);
  await admin('POST', `/orders/${o.id}/status`, { status: 'cancelled' }, manager);
  assert.equal(await used(p.id), 0);
});

test('per-phone limit holds under concurrent checkouts and frees up when that order is cancelled', async () => {
  const p = await promo({ max_per_phone: 1 });
  const carts = await Promise.all(Array.from({ length: 4 }, () => cart(tash)));
  for (const c of carts.slice(0, 3)) await apply(c, p.code);
  const res = await Promise.all(carts.slice(0, 3).map((c) => checkout(c, { phone: '90 555 44 33' })));
  assert.deepEqual(res.map((r) => r.status).sort(), [201, 409, 409]);
  assert.ok(res.filter((r) => r.status === 409).every((r) => r.body.code === 'promo_used_up'));
  assert.equal(await used(p.id), 1, 'the refused checkouts gave their claim back (rolled back)');
  await apply(carts[3], p.code);
  assert.equal((await checkout(carts[3], { phone: '+998905554434' })).status, 201, 'another phone is fine');
  const mine = res.find((r) => r.status === 201).body.order;
  await admin('POST', `/orders/${mine.id}/status`, { status: 'cancelled' }, manager);
  const again = await cart(tash);
  await apply(again, p.code);
  assert.equal((await checkout(again, { phone: '+998905554433' })).status, 201, 'a cancelled order no longer counts for that phone');
});

test('the client cannot send its own discount, prices or bundle', async () => {
  const c = await cart(tash, 150000);
  const r = await checkout(c, { discount: 150000, promo_discount: 150000, bundle_discount: 150000, total: 1, subtotal: 1, promo_code_id: 1, promo: 'X' });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.order.subtotal, r.body.order.promo_discount, r.body.order.bundle_discount, r.body.order.total, r.body.order.promo_code], [150000, 0, 0, 150000, null]);
  // An "outfit" the server never showed (no rec, a made-up rec, or a set that isn't one of the rec's outfits) is no bundle.
  await db('stores').where({ id: tash }).update({ bundle_percent: 20 });
  try {
    const rec = (await call('POST', '/api/recommend', { store_id: tash, gender: 'male', sizes: { top: 'M', bottom: 'M', shoes: '42' } })).body;
    const items = rec.outfits[0].items;
    const fake = [...items.slice(1), (await db('products').where({ store_id: tash }).whereNotIn('id', rec.outfits.flatMap((o) => o.items.map((i) => i.id))).first()).id];
    for (const [outfit, recToken] of [[items.map((i) => i.id), undefined], [items.map((i) => i.id), 'f'.repeat(32)], [fake.map((x) => x.id ?? x), rec.rec]]) {
      const k = await call('POST', '/api/cart/items', { store_id: tash, items: items.map((i) => ({ product_id: i.id, size: i.size })), rec: recToken, outfit });
      assert.equal(k.status, 200);
      assert.equal(k.body.discounts.bundle, 0);
      await call('DELETE', `/api/cart/${k.body.token}`);
    }
  } finally {
    await db('stores').where({ id: tash }).update({ bundle_percent: 0 });
  }
});

test('bundle: a whole recommended outfit (also after a swap) gets N % off its items; checkout, status page and returns use it', async () => {
  await db('stores').where({ id: tash }).update({ bundle_percent: 10, delivery_fee: 30000, free_delivery_threshold: 1000 });
  try {
    const req = { store_id: tash, gender: 'male', sizes: { top: 'M', bottom: 'M', shoes: '42' } };
    const rec = (await call('POST', '/api/recommend', req)).body;
    assert.equal(rec.bundle_percent, 10);
    const o = rec.outfits[0];
    const add = (items, outfit, token) => call('POST', '/api/cart/items', { token, store_id: tash, items: items.map((i) => ({ product_id: i.id, size: i.size })), rec: rec.rec, outfit: outfit.map((i) => i.id) });
    // One item first, then the rest of the outfit: the outfit card sends the whole outfit, the server checks it.
    const first = await add(o.items.slice(0, 1), o.items);
    assert.equal(first.body.discounts.bundle, 0, 'not the whole outfit yet');
    const k = (await add(o.items.slice(1), o.items, first.body.token)).body;
    const sum = o.items.reduce((s, i) => s + i.unit_price, 0);
    assert.equal(k.discounts.bundle, Math.floor(sum / 10));
    assert.equal(k.totals.pickup.total, sum - Math.floor(sum / 10));
    // Removing one item breaks the outfit: no bundle.
    const line = k.items[0];
    const less = (await call('DELETE', `/api/cart/${k.token}/items/${line.id}`)).body;
    assert.equal(less.discounts.bundle, 0);
    const back = (await add([o.items.find((i) => i.id === line.product_id)], o.items, k.token)).body;
    assert.equal(back.discounts.bundle, Math.floor(sum / 10));

    // Bundle + a percent code: the code works on what is left; the free-delivery threshold looks at the discounted goods.
    const p = await promo({ value: 50 });
    const withCode = (await apply(back, p.code)).body;
    const afterBundle = sum - Math.floor(sum / 10);
    assert.equal(withCode.discounts.promo, Math.floor(afterBundle / 2));
    const out = await checkout(back, { fulfillment: 'delivery', address: 'Chilonzor 9, 12-uy' });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const order = out.body.order;
    assert.equal(order.bundle_discount, Math.floor(sum / 10));
    assert.equal(order.promo_discount, Math.floor(afterBundle / 2));
    assert.equal(order.promo_code, p.code);
    assert.equal(order.total, order.subtotal - order.bundle_discount - order.promo_discount + order.delivery_fee);
    assert.equal(order.items.reduce((s, i) => s + i.discount, 0), order.bundle_discount + order.promo_discount);

    const status = (await call('GET', new URL(out.body.track.url).pathname.replace('/order/', '/api/orders/'))).body;
    assert.deepEqual([status.bundle_discount, status.promo_discount, status.promo_code, status.total], [order.bundle_discount, order.promo_discount, p.code, order.total]);

    // Returns refund what the customer paid for that line, not its list price.
    for (const step of ['pay', 'packing', 'shipping', 'delivered']) await admin('POST', `/orders/${order.id}/${step === 'pay' ? 'pay' : 'status'}`, step === 'pay' ? {} : { status: step }, manager);
    const it = order.items[0];
    const tooMuch = await admin('POST', `/orders/${order.id}/returns`, { key: 'd'.repeat(32), item_id: it.id, kind: 'return', reason: 'too_big', quantity: 1, restock: true, refund: it.unit_price }, manager);
    assert.equal(tooMuch.status, 400, 'refund above what was paid');
    const ret = await admin('POST', `/orders/${order.id}/returns`, { key: 'e'.repeat(32), item_id: it.id, kind: 'return', reason: 'too_big', quantity: 1, restock: true }, manager);
    assert.equal(ret.status, 201);
    assert.equal(ret.body.returns[0].refund, it.unit_price - it.discount);

    // A swapped outfit is recommended too.
    const rec2 = (await call('POST', '/api/recommend', req)).body;
    const o2 = rec2.outfits[0];
    const exclude = rec2.outfits.slice(1).flatMap((x) => x.items.map((i) => i.id));
    let opt = null;
    for (const old of o2.items) {
      opt = (await call('POST', '/api/recommend/swap', { ...req, rec: rec2.rec, items: o2.items.map((i) => i.id), replace: old.id, exclude, relaxed: rec2.relaxed })).body.options[0];
      if (opt) break;
    }
    if (opt) {
      for (const i of opt.items) if (i.size) await db('product_stock').where({ product_id: i.id, size: i.size }).update({ quantity: 50 });
      const r2 = await call('POST', '/api/cart/items', { store_id: tash, items: opt.items.map((i) => ({ product_id: i.id, size: i.size })), rec: rec2.rec, outfit: opt.items.map((i) => i.id) });
      assert.equal(r2.status, 200, JSON.stringify(r2.body));
      const k2 = r2.body;
      assert.equal(k2.discounts.bundle, Math.floor(opt.total / 10), 'swapped outfit gets the bundle');
      await call('DELETE', `/api/cart/${k2.token}`);
    }
  } finally {
    await db('stores').where({ id: tash }).update({ bundle_percent: 0, delivery_fee: 0, free_delivery_threshold: null });
  }
});

test('a fully discounted order cannot go to Payme/Click (0 so\'m), only the cashier', async () => {
  const { createCartRouter } = await import('../src/cart/cart.js');
  const express = (await import('express')).default;
  const app = express().use(express.json()).use('/c', createCartRouter(db, { methods: { cashier: async () => ({ method: 'cashier' }), payme: async () => ({ method: 'payme', url: 'https://x' }) } }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.publicKey }));
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  try {
    const c = await cart(tash, 10000);
    await apply(c, (await promo({ kind: 'fixed', value: 50000 })).code);
    const post = (body) => fetch(`http://127.0.0.1:${srv.address().port}/c/${c.token}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r = await post({ fulfillment: 'pickup', name: 'Aziz', phone: '+998901234567', payment: 'payme' });
    assert.equal(r.status, 400);
    const ok = await post({ fulfillment: 'pickup', name: 'Aziz', phone: '+998901234567', payment: 'cashier' });
    assert.equal(ok.status, 201);
    const o = await db('orders').orderBy('id', 'desc').first();
    assert.deepEqual([o.subtotal, o.promo_discount, o.total], [10000, 10000, 0], 'total never below 0');
  } finally {
    srv.close();
  }
});

test('promo code tries are rate-limited per IP', async () => {
  const app = createApp(db, { weather, stylist: null, telegram: null, limits: { promo: 3, cart: 0 } }).listen(0);
  await new Promise((r) => app.once('listening', r));
  try {
    const c = await cart(tash);
    const url = `http://127.0.0.1:${app.address().port}/api/cart/${c.token}/promo`;
    const tries = [];
    for (let i = 0; i < 4; i++) tries.push((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: `GUESS${i}A` }) })).status);
    assert.deepEqual(tries, [409, 409, 409, 429]);
  } finally {
    app.close();
  }
});

test('migration 016: the orders CHECK holds discounts; down folds them in and keeps every order and line; up again', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await seed(m);
    const store = await m('stores').first('id');
    const p = await m('products').where({ store_id: store.id }).first('id');
    const row = { store_id: store.id, number: 1, customer_name: 'Aziz', phone: '+998901234567', fulfillment: 'pickup', subtotal: 100000, delivery_fee: 0 };
    await assert.rejects(m('orders').insert({ ...row, total: 100000, promo_discount: 10000 }), 'total must take the discount off');
    await assert.rejects(m('orders').insert({ ...row, total: -20000, promo_discount: 120000 }), 'discounts never above the subtotal');
    const [{ id }] = await m('orders').insert({ ...row, total: 85000, promo_discount: 10000, bundle_discount: 5000 }).returning('id');
    await m('order_items').insert({ order_id: id, product_id: p.id, size: 'M', quantity: 1, unit_price: 100000, discount: 15000 });
    await m.migrate.down(); // 031
    await m.migrate.down(); // 030
    await m.migrate.down(); // 029
    await m.migrate.down(); // 028
    await m.migrate.down(); // 027
    await m.migrate.down(); // 026
    await m.migrate.down(); // 025
    await m.migrate.down(); // 024
    await m.migrate.down(); // 023
    await m.migrate.down(); // 022
    await m.migrate.down(); // 021
    await m.migrate.down(); // 020
    await m.migrate.down(); // 019
    await m.migrate.down(); // 018
    await m.migrate.down(); // 017
    await m.migrate.down(); // 016
    const o = await m('orders').where({ id }).first();
    assert.deepEqual([o.subtotal, o.total, 'promo_discount' in o], [85000, 85000, false]);
    assert.equal((await m('order_items').where({ order_id: id })).length, 1, 'lines survive the rebuild');
    await m.migrate.latest();
    await m('orders').where({ id }).del();
    assert.equal((await m('order_items').where({ order_id: id })).length, 0, 'the rebuilt table keeps its foreign keys (cascade)');
  } finally {
    await m.destroy();
  }
});
