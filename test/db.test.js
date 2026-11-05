import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { seed, CATALOGUE } from '../src/db/seed.js';

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

test('seed: Tashkent and Samarkand stores, 25 items each', async () => {
  const stores = await db('stores').orderBy('id');
  assert.deepEqual(stores.map((s) => s.city), ['Toshkent', 'Samarqand']);
  for (const s of stores) {
    const [{ n }] = await db('products').where({ store_id: s.id }).count({ n: '*' });
    assert.equal(Number(n), 25);
  }
});

test('seed: all categories and seasons, stock per size', async () => {
  const products = await db('products');
  const cats = new Set(products.map((p) => p.category));
  assert.deepEqual([...cats].sort(), ['accessory', 'bottom', 'outerwear', 'shoes', 'top']);
  assert.ok(products.some((p) => p.temp_max <= 0), 'winter items');
  assert.ok(products.some((p) => p.temp_min >= 18), 'summer items');
  assert.ok(products.some((p) => p.temp_min <= 10 && p.temp_max >= 15 && p.temp_max <= 25), 'spring/autumn items');
  assert.ok(products.some((p) => p.waterproof), 'waterproof items');

  const stock = await db('product_stock');
  for (const p of products) {
    const rows = stock.filter((r) => r.product_id === p.id);
    assert.ok(rows.length >= 1, `no stock rows for ${p.name}`);
    assert.ok(rows.some((r) => r.quantity > 0), `${p.name} fully sold out`);
  }
  assert.ok(stock.some((r) => r.quantity === 0), 'some sizes should be sold out');
});

test('seed: each required category has ≥2 items per gender at −10, 5, 15, 30 °C', () => {
  for (const g of ['male', 'female']) {
    for (const t of [-10, 5, 15, 30]) {
      const cats = ['top', 'bottom', 'shoes', ...(t < 18 ? ['outerwear'] : [])];
      for (const c of cats) {
        const n = CATALOGUE.filter(([, cat, gen, , , , , min, max]) => cat === c && (gen === g || gen === 'unisex') && min <= t && t <= max).length;
        assert.ok(n >= 2, `${g} ${t}°C ${c}: only ${n}`);
      }
    }
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
  assert.equal(Number(n), 50);
  assert.equal((await db('stores')).length, 2);
});
