// Task 25: catalogue, item page with "goes well with", other stores of the organisation, reserve there, outfit swap.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { pairWith, swapOptions } from '../src/recommend/engine.js';
import { RESERVE_MS } from '../src/catalog.js';
import { releaseExpired } from '../src/cart/cart.js';

const db = testDb();
const weather = { temperature: 5, apparent_temperature: 3, raining: false, wind_speed: 2, source: 'live' };
let server, base, tash, samar, branch, capped;

const call = async (path, body, b = base) => {
  const res = await fetch(b + '/api' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const free = async (product_id, size) => {
  const r = await db('product_stock').where({ product_id, size }).first('quantity', 'reserved');
  return r ? r.quantity - r.reserved : 0;
};
const SESSION = 'a'.repeat(32);

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [tash, samar] = (await db('stores').orderBy('id')).map((s) => s.id);
  // A second Toshkent branch in the same organisation, with copies (same SKU) of the first store's clothes.
  const org = (await db('stores').where({ id: tash }).first('organization_id')).organization_id;
  [{ id: branch }] = await db('stores').insert({ name: 'Smart Fit Chilonzor', city: 'Toshkent', lat: 41.28, lon: 69.2, address: 'Bunyodkor 1', organization_id: org }).returning('id');
  for (const p of await db('products').where({ store_id: tash }).whereIn('category', ['top', 'bottom'])) {
    const { id, created_at, updated_at, ...copy } = p;
    const [{ id: nid }] = await db('products').insert({ ...copy, store_id: branch }).returning('id');
    await db('product_stock').insert(['S', 'M', 'L'].map((size) => ({ product_id: nid, size, quantity: 4 })));
  }
  server = createApp(db, { weather: async () => weather, limits: { catalog: 0, recommend: 0 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  capped = createApp(db, { weather: async () => weather, limits: { catalog: 0, openCarts: 2 } }).listen(0);
  await new Promise((r) => capped.once('listening', r));
});
after(async () => {
  server.close();
  capped.close();
  await db.destroy();
});

test('catalogue: only items and sizes with free stock; filters by category, gender, size and price', async () => {
  const { status, body } = await call(`/catalog/${tash}`);
  assert.equal(status, 200);
  assert.ok(body.items.length > 30);
  for (const p of body.items) {
    assert.ok(p.sizes.length, `${p.id} has a size`);
    for (const s of p.sizes) assert.ok((await free(p.id, s)) > 0, `${p.id} ${s} in stock`);
    assert.equal(p.unit_price, p.discount_price ?? p.price);
  }
  // Sold out in every size (or fully held by carts) → gone from the list; one size gone → that size gone.
  const [a, b, c] = body.items.filter((p) => p.sizes.length > 2);
  await db('product_stock').where({ product_id: a.id }).update({ quantity: 0, reserved: 0 });
  await db('product_stock').where({ product_id: b.id }).update({ reserved: db.raw('quantity') });
  await db('product_stock').where({ product_id: c.id, size: c.sizes[0] }).update({ reserved: db.raw('quantity') });
  const after = (await call(`/catalog/${tash}`)).body.items;
  assert.ok(!after.some((p) => p.id === a.id || p.id === b.id));
  assert.ok(!after.find((p) => p.id === c.id).sizes.includes(c.sizes[0]));
  assert.equal((await call(`/catalog/${tash}/items/${a.id}`)).status, 404, 'no item page for a sold-out item');

  const list = async (q) => (await call(`/catalog/${tash}?${q}`)).body.items;
  assert.ok((await list('category=shoes')).every((p) => p.category === 'shoes'));
  assert.ok((await list('gender=female')).every((p) => ['female', 'unisex'].includes(p.gender)));
  const m = await list('size=M');
  assert.ok(m.length && m.every((p) => p.sizes.includes('M')));
  for (const p of m) assert.ok((await free(p.id, 'M')) > 0);
  const band = await list('min=300000&max=800000');
  assert.ok(band.length && band.every((p) => p.unit_price >= 300000 && p.unit_price <= 800000), 'price is what the customer pays');
  for (const q of ['category=hat', 'gender=unisex', 'size=XXXL', 'min=-1', 'max=1e9']) assert.equal((await call(`/catalog/${tash}?${q}`)).status, 400, q);
  assert.equal((await call('/catalog/9999')).status, 404);
});

test('item page: in-stock sizes only, and 2–4 pairs that never repeat, never include the item and are in stock', async () => {
  const items = (await call(`/catalog/${tash}`)).body.items;
  let checked = 0;
  for (const p of items) {
    const { status, body } = await call(`/catalog/${tash}/items/${p.id}`);
    assert.equal(status, 200);
    for (const s of body.item.sizes) assert.ok((await free(p.id, s)) > 0);
    const ids = body.pairs.map((x) => x.id);
    assert.ok(body.pairs.length <= 4);
    assert.equal(new Set(ids).size, ids.length, 'no repeats');
    assert.ok(!ids.includes(p.id), 'not the item itself');
    assert.equal(new Set(body.pairs.map((x) => x.category)).size, ids.length, 'one per category');
    assert.ok(!body.pairs.some((x) => x.category === p.category));
    for (const x of body.pairs) {
      assert.ok(x.sizes.length);
      if (p.gender !== 'unisex') assert.ok([p.gender, 'unisex'].includes(x.gender), 'gender matches');
    }
    if (body.pairs.length >= 2) checked++;
  }
  assert.ok(checked > items.length * 0.8, 'most items get at least two pairs');
  // An item of another store is not found through this store.
  const other = await db('products').where({ store_id: samar }).first('id');
  assert.equal((await call(`/catalog/${tash}/items/${other.id}`)).status, 404);
});

test('pairWith (pure): one per other category, same temperature window, outerwear only for cold-weather items', () => {
  const p = (id, category, temp_min, temp_max, extra = {}) => ({ id, category, temp_min, temp_max, color: 'qora', style: 'casual', ...extra });
  const tee = p(1, 'top', 18, 40);
  const pool = [tee, p(2, 'bottom', 15, 40), p(3, 'bottom', 20, 38), p(4, 'shoes', 10, 40), p(5, 'outerwear', -10, 25), p(6, 'accessory', 18, 40), p(7, 'bottom', -20, 5)];
  const pairs = pairWith(tee, pool);
  assert.deepEqual(pairs.map((x) => x.category), ['bottom', 'shoes', 'accessory'], 'no outerwear for a summer top');
  assert.ok(!pairs.some((x) => x.id === 7), 'not a winter item');
  assert.equal(pairs.find((x) => x.category === 'bottom').id, 3, 'closest season first');
  const sweater = p(10, 'top', -20, 10);
  assert.ok(pairWith(sweater, [...pool, p(11, 'outerwear', -25, 5)]).some((x) => x.category === 'outerwear'));
  // Colour rule: no second bright colour when a neutral one is there.
  const red = p(20, 'top', 0, 30, { color: 'qizil' });
  assert.equal(pairWith(red, [p(21, 'bottom', 0, 30, { color: 'sariq' }), p(22, 'bottom', 0, 30, { color: 'qora' })])[0].id, 22);
});

test('other stores: same SKU and size in this organisation only; a size with 0 here is logged as missed demand', async () => {
  const p = await db('products').where({ store_id: tash, category: 'top' }).whereNotNull('sku').orderBy('id').first('id', 'sku');
  await db('product_stock').where({ product_id: p.id, size: 'M' }).update({ quantity: 0, reserved: 0 });
  // The other organisation (Samarqand) has the same SKU with stock, which must never show.
  const samarCopy = await db('products').where({ store_id: samar, sku: p.sku }).first('id');
  if (samarCopy) await db('product_stock').where({ product_id: samarCopy.id, size: 'M' }).update({ quantity: 9, reserved: 0 });
  const { status, body } = await call('/catalog/elsewhere', { store_id: tash, product_id: p.id, size: 'M', session: SESSION });
  assert.equal(status, 200);
  assert.equal(body.here, 0);
  assert.deepEqual(body.stores.map((s) => s.store_id), [branch], 'only the same organisation');
  assert.deepEqual(Object.keys(body.stores[0]).sort(), ['address', 'city', 'count', 'name', 'product_id', 'store_id']);
  assert.equal(body.stores[0].count, 4);
  await call('/catalog/elsewhere', { store_id: tash, product_id: p.id, size: 'M', session: SESSION }); // same visit again
  const missed = await db('missed_demand').where({ product_id: p.id, size: 'M' });
  assert.equal(missed.length, 1, 'once per visit');
  assert.equal(missed[0].source, 'catalog');
  assert.equal(missed[0].store_id, tash);
  // In stock here → nothing logged. Sold out in the branch too → no store listed.
  await call('/catalog/elsewhere', { store_id: tash, product_id: p.id, size: 'L', session: SESSION });
  assert.equal(await db('missed_demand').where({ product_id: p.id, size: 'L' }).first(), undefined);
  const b = await db('products').where({ store_id: branch, sku: p.sku }).first('id');
  await db('product_stock').where({ product_id: b.id, size: 'S' }).update({ quantity: 0 });
  await db('product_stock').where({ product_id: p.id, size: 'S' }).update({ quantity: 0, reserved: 0 });
  assert.deepEqual((await call('/catalog/elsewhere', { store_id: tash, product_id: p.id, size: 'S' })).body.stores, []);
  // From the Samarqand organisation: Toshkent stores never appear.
  if (samarCopy) {
    await db('product_stock').where({ product_id: samarCopy.id, size: 'M' }).update({ quantity: 0 });
    assert.deepEqual((await call('/catalog/elsewhere', { store_id: samar, product_id: samarCopy.id, size: 'M' })).body.stores, []);
  }
  assert.equal((await call('/catalog/elsewhere', { store_id: tash, product_id: samarCopy?.id ?? 99999, size: 'M' })).status, 404, 'product of another store');
  assert.equal((await call('/catalog/elsewhere', { store_id: tash, product_id: p.id, size: '42' })).status, 400);
});

test('reserve there: a pickup order on the other store holds its stock; never across organisations; capped per client', async () => {
  const p = await db('products').where({ store_id: tash, category: 'bottom' }).whereNotNull('sku').orderBy('id').first('id', 'sku');
  const there = await db('products').where({ store_id: branch, sku: p.sku }).first('id', 'price', 'discount_price');
  const before = { here: await free(p.id, 'L'), there: await free(there.id, 'L') };
  const body = { from_store_id: tash, product_id: there.id, size: 'L', name: 'Aziz', phone: '90 123 45 67' };
  const r = await call('/catalog/reserve', body);
  assert.equal(r.status, 201);
  const o = r.body.order;
  assert.equal(o.store_id, branch);
  assert.deepEqual([o.fulfillment, o.payment_status, o.payment_method, o.status], ['pickup', 'pending', 'cashier', 'new']);
  assert.equal(o.total, there.discount_price ?? there.price, 'total computed by the server');
  assert.equal(o.delivery_fee, 0);
  assert.deepEqual(o.items.map((i) => [i.product_id, i.size, i.quantity]), [[there.id, 'L', 1]]);
  assert.ok(Math.abs(Date.parse(o.expires_at) - Date.now() - RESERVE_MS) < 60_000, 'held for 3 h');
  assert.equal(r.body.store.name, 'Smart Fit Chilonzor');
  assert.match(r.body.track.url, /\/order\/[a-f0-9]{32}$/);
  assert.equal(await free(there.id, 'L'), before.there - 1, 'held in that store');
  assert.equal(await free(p.id, 'L'), before.here, 'not in this one');
  assert.equal((await call(r.body.track.url.replace(/^.*\/order\//, '/orders/'))).status, 200, 'status page works');

  // Unpaid after 3 h → cancelled and the unit comes back.
  await releaseExpired(db, Date.now() + RESERVE_MS + 1000);
  assert.equal(await free(there.id, 'L'), before.there);
  assert.equal((await db('orders').where({ id: o.id }).first('status')).status, 'cancelled');

  // Another organisation's item, this store's own item, a missing one: all 404, nothing held.
  const samarItem = await db('products').where({ store_id: samar }).first('id');
  for (const bad of [{ product_id: samarItem.id, size: 'M' }, { product_id: p.id }, { from_store_id: samar }, { product_id: 999999 }]) {
    const res = await call('/catalog/reserve', { ...body, ...bad });
    assert.equal(res.status, 404, JSON.stringify(bad));
  }
  assert.equal((await call('/catalog/reserve', { ...body, size: '42' })).status, 400);
  assert.equal((await call('/catalog/reserve', { ...body, phone: '123' })).status, 400);
  await db('product_stock').where({ product_id: there.id, size: 'S' }).update({ quantity: 0, reserved: 0 });
  assert.equal((await call('/catalog/reserve', { ...body, size: 'S' })).status, 409, 'sold out there');

  // Per-client cap shared with carts (openCarts = 2 on this server).
  const cap = `http://127.0.0.1:${capped.address().port}`;
  assert.equal((await call('/catalog/reserve', body, cap)).status, 201);
  assert.equal((await call('/catalog/reserve', body, cap)).status, 201);
  const third = await call('/catalog/reserve', body, cap);
  assert.equal(third.status, 429);
  assert.equal(third.body.code, 'too_many_reserves');
});

test('swap: same category, in stock in the customer size, not in another outfit, within budget, priced by the server', async () => {
  const req = { store_id: tash, gender: 'male', sizes: { top: 'M', bottom: 'M', shoes: '42' } };
  const rec = (await call('/recommend', req)).body;
  assert.ok(rec.outfits.length >= 2);
  const [o, ...rest] = rec.outfits;
  const exclude = rest.flatMap((x) => x.items.map((i) => i.id));
  for (const old of o.items) {
    const { status, body } = await call('/recommend/swap', { ...req, items: o.items.map((i) => i.id), replace: old.id, exclude, relaxed: rec.relaxed });
    assert.equal(status, 200);
    for (const opt of body.options) {
      const x = opt.items.find((i) => i.id === opt.swap);
      assert.equal(x.category, old.category);
      assert.deepEqual(opt.items.map((i) => i.category), o.items.map((i) => i.category), 'outfit keeps its categories');
      assert.ok(!exclude.includes(x.id) && !o.items.some((i) => i.id === x.id), 'no item twice on the screen');
      assert.equal(opt.total, opt.items.reduce((s, i) => s + i.unit_price, 0));
      if (x.size) assert.ok((await free(x.id, x.size)) > 0);
      if (['top', 'bottom', 'outerwear'].includes(x.category)) assert.equal(x.size, 'M');
    }
  }
  // Budget: every option keeps the outfit within it.
  const budget = o.total + 50_000;
  const top = o.items.find((i) => i.category === 'top');
  const withBudget = (await call('/recommend/swap', { ...req, budget, items: o.items.map((i) => i.id), replace: top.id, relaxed: rec.relaxed })).body.options;
  assert.ok(withBudget.every((opt) => opt.total <= budget));
  // A sold-out outfit item → 409, not a silent change; bad input → 400.
  const ids = o.items.map((i) => i.id);
  await db('product_stock').where({ product_id: top.id, size: 'M' }).update({ reserved: db.raw('quantity') });
  assert.equal((await call('/recommend/swap', { ...req, items: ids, replace: ids.at(-1), relaxed: rec.relaxed })).status, 409);
  for (const bad of [{ replace: 1 }, { items: [...ids, ids[0]] }, { items: 'x' }, { exclude: ['a'] }]) {
    assert.equal((await call('/recommend/swap', { ...req, items: ids, replace: ids[0], ...bad })).status, 400, JSON.stringify(bad));
  }
});

test('swap: with nothing left in the outfit window it widens like the outfits do (±3, ±6 °C)', async () => {
  weather.temperature = 14; // at 14 °C every other men's top in M is either in another outfit or out of season
  try {
    const req = { store_id: tash, gender: 'male', sizes: { top: 'M', bottom: 'M', shoes: '42' } };
    const rec = (await call('/recommend', req)).body;
    const [o, ...rest] = rec.outfits;
    const top = o.items.find((i) => i.category === 'top');
    const { body } = await call('/recommend/swap', { ...req, items: o.items.map((i) => i.id), replace: top.id, exclude: rest.flatMap((x) => x.items.map((i) => i.id)), relaxed: rec.relaxed });
    assert.ok(body.options.length, 'options from a wider window');
    assert.ok(body.options.every((opt) => opt.items.find((i) => i.id === opt.swap).category === 'top'));
  } finally {
    weather.temperature = 5;
  }
});

test('swapOptions (pure): budget fallback offers only cheaper items when the outfit is already over budget', () => {
  const item = (id, category, unit_price, extra = {}) => ({ id, category, unit_price, temp_min: -10, temp_max: 30, waterproof: false, color: 'qora', ...extra });
  const items = [item(1, 'top', 300), item(2, 'bottom', 300), item(3, 'shoes', 300)];
  const pool = [...items, item(4, 'top', 500), item(5, 'top', 200), item(6, 'top', 100), item(7, 'bottom', 50)];
  const ctx = { items, replace: 1, temperature: 10 };
  assert.deepEqual(swapOptions(pool, ctx).map((o) => o.swap).sort(), [4, 5, 6], 'no budget: every other top');
  assert.deepEqual(swapOptions(pool, { ...ctx, budget: 900 }).map((o) => o.swap).sort(), [5, 6], 'within 900');
  assert.deepEqual(swapOptions(pool, { ...ctx, budget: 700 }).map((o) => o.swap).sort(), [5, 6], 'over budget (900 > 700): only cheaper');
  assert.deepEqual(swapOptions(pool, { ...ctx, exclude: [5] }).map((o) => o.swap).sort(), [4, 6], 'items of other outfits stay out');
  assert.deepEqual(swapOptions(pool, { ...ctx, replace: 99 }), []);
  const [best] = swapOptions(pool, { ...ctx, budget: 900 });
  assert.equal(best.total, best.items.reduce((s, i) => s + i.unit_price, 0));
  assert.deepEqual(best.items.map((i) => i.category), ['top', 'bottom', 'shoes']);
});
