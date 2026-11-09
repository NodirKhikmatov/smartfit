import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { seed, CATALOGUE, IMAGE_DIR } from '../src/db/seed.js';
import { createApp } from '../src/app.js';

const db = testDb();

before(async () => {
  await db.migrate.latest();
  await seed(db);
});
after(() => db.destroy());

test('all spec tables exist with key columns', async () => {
  const expected = {
    stores: ['name', 'city', 'lat', 'lon', 'address', 'delivery_fee', 'free_delivery_threshold'],
    products: ['store_id', 'name', 'category', 'gender', 'color', 'price', 'discount_price', 'temp_min', 'temp_max', 'waterproof', 'shelf_location', 'image_url'],
    product_stock: ['product_id', 'size', 'quantity', 'reserved'],
    carts: ['store_id', 'token', 'expires_at'],
    orders: ['store_id', 'customer_name', 'phone', 'fulfillment', 'address', 'status', 'payment_status', 'subtotal', 'delivery_fee', 'total'],
    order_items: ['order_id', 'product_id', 'size', 'quantity', 'unit_price'],
    admins: ['email', 'password_hash', 'role', 'store_id'],
    recommendation_logs: ['store_id', 'product_ids', 'source', 'created_at'],
  };
  for (const [table, cols] of Object.entries(expected)) {
    assert.ok(await db.schema.hasTable(table), `missing table ${table}`);
    const info = await db(table).columnInfo();
    for (const c of cols) assert.ok(info[c], `missing ${table}.${c}`);
  }
});

test('reseeding restarts ids: stores are 1 and 2 again, so printed QR links keep working', async () => {
  const fresh = testDb();
  try {
    await fresh.migrate.latest();
    await seed(fresh);
    const first = await fresh('products').orderBy('id').first('id');
    await fresh('carts').insert({ store_id: 1, token: 'a'.repeat(32), expires_at: new Date().toISOString() });
    await seed(fresh);
    assert.deepEqual(await fresh('stores').orderBy('id').pluck('id'), [1, 2]);
    assert.equal((await fresh('products').orderBy('id').first('id')).id, first.id);
    assert.equal((await fresh('carts').count({ n: '*' }))[0].n, 0, 'carts are wiped too');
  } finally {
    await fresh.destroy();
  }
});

const inStore = (code) => CATALOGUE.filter((p) => p.stores.includes(code));

test('seed: Tashkent and Samarkand stores, ≥ 60 items each, with per-store differences', async () => {
  const stores = await db('stores').orderBy('id');
  assert.deepEqual(stores.map((s) => s.city), ['Toshkent', 'Samarqand']);
  const skus = [];
  for (const [i, s] of stores.entries()) {
    const products = await db('products').where({ store_id: s.id });
    assert.equal(products.length, inStore('TS'[i]).length);
    assert.ok(products.length >= 60, `${s.city}: ${products.length} items`);
    assert.equal(new Set(products.map((p) => p.sku)).size, products.length, 'SKU unique per store');
    for (const p of products) {
      assert.match(p.sku, /^SF-[A-Z]{2}-\d{2}$/);
      assert.ok(p.description?.length > 10, `${p.sku} has a description`);
      assert.ok(p.name_ru, `${p.sku} has a Russian name`);
      assert.equal(p.image_url, `/uploads/products/demo-s${i + 1}-${p.sku.toLowerCase()}.svg`);
    }
    skus.push(new Set(products.map((p) => p.sku)));
  }
  assert.ok([...skus[0]].some((k) => !skus[1].has(k)) && [...skus[1]].some((k) => !skus[0].has(k)), 'each store has items the other lacks');
});

test('seed: all categories and seasons, price tiers, stock per size', async () => {
  const products = await db('products');
  const cats = new Set(products.map((p) => p.category));
  assert.deepEqual([...cats].sort(), ['accessory', 'bottom', 'outerwear', 'shoes', 'top']);
  assert.ok(products.some((p) => p.temp_max <= 0), 'winter items');
  assert.ok(products.some((p) => p.temp_min >= 18), 'summer items');
  assert.ok(products.some((p) => p.temp_min <= 10 && p.temp_max >= 15 && p.temp_max <= 25), 'spring/autumn items');
  assert.ok(products.some((p) => p.waterproof), 'waterproof items');
  assert.equal(new Set(products.map((p) => p.style)).size, 3, 'casual, classic and sport');

  // Economy (< 200 000), mid and premium (> 600 000) in every store, by the price the customer pays.
  for (const store of await db('stores')) {
    const prices = products.filter((p) => p.store_id === store.id).map((p) => p.discount_price ?? p.price);
    for (const [tier, test] of [['economy', (x) => x < 200000], ['mid', (x) => x >= 200000 && x <= 600000], ['premium', (x) => x > 600000]]) {
      assert.ok(prices.filter(test).length >= 5, `${store.city} ${tier}`);
    }
  }

  const stock = await db('product_stock');
  for (const p of products) {
    const rows = stock.filter((r) => r.product_id === p.id);
    assert.ok(rows.length >= 1, `no stock rows for ${p.name}`);
    assert.ok(rows.some((r) => r.quantity > 0), `${p.name} fully sold out`);
  }
  assert.ok(stock.some((r) => r.quantity === 0), 'some sizes should be sold out');
  assert.ok(stock.filter((r) => r.quantity >= 2).length / stock.length >= 0.9, 'most sizes have ≥ 2');
});

test('seed: every product has a demo image, copied to the upload dir and served', async () => {
  for (const p of CATALOGUE) {
    const svg = await readFile(path.join(IMAGE_DIR, `${p.sku}.svg`), 'utf8');
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, p.sku);
    assert.doesNotMatch(svg, /<script|on\w+=|href="http/i, `${p.sku}: no script or external reference`);
  }
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'smartfit-seed-'));
  try {
    await seed(db, { uploadDir });
    const server = createApp(db, { uploadDir, weather: async () => ({}) }).listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      for (const p of await db('products')) {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${p.image_url}`);
        assert.equal(res.status, 200, p.image_url);
        assert.equal(res.headers.get('content-type'), 'image/svg+xml');
        await res.arrayBuffer();
      }
    } finally {
      server.close();
    }
    // Re-seeding overwrites the same files instead of adding new ones.
    const before = (await readdir(path.join(uploadDir, 'products'))).length;
    await seed(db, { uploadDir });
    assert.equal((await readdir(path.join(uploadDir, 'products'))).length, before);
    assert.equal(before, inStore('T').length + inStore('S').length);
  } finally {
    await rm(uploadDir, { recursive: true, force: true });
  }
});

test('prices are stored as integer so\'m', async () => {
  const cols = await db('products').columnInfo();
  assert.equal(cols.price.type, 'integer');
  assert.equal(cols.discount_price.type, 'integer');
  const products = await db('products');
  for (const p of products) {
    assert.ok(Number.isInteger(p.price) && p.price > 0);
    if (p.discount_price !== null) assert.ok(Number.isInteger(p.discount_price) && p.discount_price < p.price);
  }
});

test('stock check blocks reserving more than quantity', async () => {
  const row = await db('product_stock').where('quantity', '>', 0).first();
  await assert.rejects(db('product_stock').where({ id: row.id }).update({ reserved: row.quantity + 1 }));
});

test('seed is repeatable', async () => {
  await seed(db);
  const [{ n }] = await db('products').count({ n: '*' });
  assert.equal(Number(n), inStore('T').length + inStore('S').length);
  assert.equal((await db('stores')).length, 2);
});
