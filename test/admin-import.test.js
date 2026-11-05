import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { parseCsv } from '../src/admin/csv.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, uploadDir, tashkent, samarkand, superToken, tashToken;

const req = async (url, { token, method = 'GET', body, type = 'application/json' } = {}) => {
  const res = await fetch(`${base}/api/admin${url}`, {
    method,
    headers: { 'content-type': type, ...(token && { authorization: `Bearer ${token}` }) },
    body: type === 'application/json' && body ? JSON.stringify(body) : body,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const csv = (token, text) => req('/products/import', { token, method: 'POST', body: text, type: 'text/csv' });
const count = async (where = {}) => Number((await db('products').where(where).count({ n: '*' }))[0].n);
const productFiles = async () => readdir(path.join(uploadDir, 'products')).catch(() => []);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [tashkent, samarkand] = (await db('stores').orderBy('id')).map((s) => s.id);
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'super-pass-1' });
  await createAdmin(db, { email: 'tash@smartfit.uz', password: 'tash-pass-1', storeId: tashkent });
  uploadDir = await mkdtemp(path.join(tmpdir(), 'smartfit-uploads-'));
  server = createApp(db, { uploadDir }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password) => (await req('/login', { method: 'POST', body: { email, password } })).body.token;
  superToken = await login('boss@smartfit.uz', 'super-pass-1');
  tashToken = await login('tash@smartfit.uz', 'tash-pass-1');
});
after(async () => {
  server.close();
  await db.destroy();
  await rm(uploadDir, { recursive: true, force: true });
});

test('parseCsv handles quotes, embedded newlines, CRLF, BOM and ; delimiter', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, ""y""","multi\nline"\r\n'), [['a', 'b'], ['x, "y"', 'multi\nline']]);
  assert.deepEqual(parseCsv('a;b;c\n1,5;2;\n'), [['a', 'b', 'c'], ['1,5', '2', '']]);
  assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.throws(() => parseCsv('a\n"open'), /Unterminated/);
});

test('manager imports new products and updates stock by id', async () => {
  const existing = await db('products').where({ store_id: tashkent, category: 'shoes' }).first();
  const before = await count({ store_id: tashkent });
  const res = await csv(tashToken, [
    'name,category,gender,color,style,price,discount_price,temp_min,temp_max,waterproof,shelf_location,S,M,L,42,id,,',
    'Import futbolka,top,unisex,oq,casual,"129 000",,15,35,yo\'q,A-1,2,3,0,,',
    '"Kuzgi kurtka, yengil",outerwear,male,qora,,450000,399000,5,15,ha,,,1,,,',
    '',
    `,,,,,,,,,,,,,,7,${existing.id}`,
  ].join('\n'));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { created: 2, updated: 1 });
  assert.equal(await count({ store_id: tashkent }), before + 2);

  const tee = await db('products').where({ name: 'Import futbolka' }).first();
  assert.equal(tee.store_id, tashkent);
  assert.equal(tee.price, 129000);
  assert.equal(Number(tee.waterproof), 0); // SQLite 0/1, Postgres boolean
  const teeStock = await db('product_stock').where({ product_id: tee.id }).orderBy('id');
  assert.deepEqual(teeStock.map((s) => [s.size, s.quantity]), [['XS', 0], ['S', 2], ['M', 3], ['L', 0], ['XL', 0], ['XXL', 0]]);
  const jacket = await db('products').where({ name: 'Kuzgi kurtka, yengil' }).first();
  assert.equal(jacket.discount_price, 399000);
  assert.equal(Number(jacket.waterproof), 1);

  // The update row only touched size 42; the rest of the product is unchanged.
  const after = await db('products').where({ id: existing.id }).first();
  assert.equal(after.name, existing.name);
  assert.equal(after.price, existing.price);
  assert.equal((await db('product_stock').where({ product_id: existing.id, size: '42' }).first()).quantity, 7);
});

test('bad rows are reported by line and nothing is imported', async () => {
  const other = await db('products').where({ store_id: samarkand }).first();
  const own = await db('products').where({ store_id: tashkent, category: 'top' }).first();
  const before = await count();
  const ownStock = await db('product_stock').where({ product_id: own.id });
  const header = 'id,store_id,name,category,gender,color,price,discount_price,temp_min,temp_max,waterproof,M,42';
  const res = await csv(tashToken, [
    header,
    ',,Yaxshi qator,top,unisex,oq,100000,,10,30,,5,', // line 2: valid, must not be saved
    ',,,top,unisex,oq,100000,,10,30,,,', // 3: no name
    ',,Shlyapa,hat,unisex,oq,100000,,10,30,,,', // 4: bad category
    ',,Arzon,top,unisex,oq,abc,,10,30,,,', // 5: price not a number
    ',,Kasr,top,unisex,oq,100.5,,10,30,,,', // 6: price not an integer
    ',,Chegirma,top,unisex,oq,100000,200000,10,30,,,', // 7: discount ≥ price
    ',,Harorat,top,unisex,oq,100000,,30,10,,,', // 8: temp_min > temp_max
    ',,Razmer,top,unisex,oq,100000,,10,30,,,3', // 9: shoe size on a top
    ',,Manfiy,top,unisex,oq,100000,,10,30,,-1,', // 10: negative stock
    ',,"=HYPERLINK(""http://x"")",top,unisex,oq,100000,,10,30,,,', // 11: formula injection
    `,${samarkand},Boshqa,top,unisex,oq,100000,,10,30,,,`, // 12: another store
    `${other.id},,,,,,,,,,,1,`, // 13: another store's product
    `999999,,,,,,,,,,,1,`, // 14: unknown id
    `${own.id},,,,,,,,,,,9,`, // 15: valid update, must not be saved
    `${own.id},,,,,,,,,,,8,`, // 16: same id twice
    ',,Suv,top,unisex,oq,100000,,10,30,balki,,', // 17: bad waterproof
    ',,Ortiqcha,top,unisex,oq,100000,,10,30,,,,extra', // 18: too many cells
    ',,Bo\'sh ortiqcha,top,unisex,oq,100000,,10,30,,,,,', // 19: empty extra cells are fine
  ].join('\n'));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /15 ta qatorda xato/);
  assert.deepEqual(res.body.errors.map((e) => e.line), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18]);
  for (const e of res.body.errors) assert.ok(e.error && e.error !== "Noto'g'ri so'rov", `line ${e.line} has a message`);

  assert.equal(await count(), before, 'nothing created');
  assert.equal(await db('products').where({ name: 'Yaxshi qator' }).first(), undefined);
  assert.deepEqual(await db('product_stock').where({ product_id: own.id }), ownStock, 'valid update rolled back');
});

test('import rejects broken files as a whole', async () => {
  const cases = [
    ['', /bo'sh/],
    ['name,colour\nA,qora', /Noma'lum ustun: colour/],
    ['name,name\nA,B', /takrorlangan/],
    ['name,category\n"A,top', /qo'shtirnoq/],
    ['name,category\n\n', /kiyim yo'q/],
    [`name\n${'x\n'.repeat(2001)}`, /2000/],
  ];
  for (const [text, msg] of cases) {
    const res = await csv(tashToken, text);
    assert.equal(res.status, 400, text.slice(0, 30));
    assert.match(res.body.error, msg);
  }
  assert.equal((await csv(tashToken, 'a'.repeat(1024 * 1024 + 1))).status, 413);
  assert.equal((await csv(null, 'name\nA')).status, 401);
});

test('super-admin import needs a store per new row; ; delimited Excel files work', async () => {
  const header = 'store_id;name;category;gender;color;price;temp_min;temp_max;ONE';
  const missing = await csv(superToken, `${header}\n;Soat;accessory;unisex;qora;300000;-30;40;2`);
  assert.equal(missing.status, 400);
  assert.match(missing.body.errors[0].error, /Do'kon/);
  const ok = await csv(superToken, `${header}\n${samarkand};Soat;accessory;unisex;qora;300000;-30;40;2`);
  assert.deepEqual(ok.body, { created: 1, updated: 0 });
  const p = await db('products').where({ name: 'Soat' }).first();
  assert.equal(p.store_id, samarkand);
  assert.equal((await db('product_stock').where({ product_id: p.id }).first()).quantity, 2);
});

test('image upload: only real JPEG/PNG/WebP, stored under a random name and served safely', async () => {
  const p = await db('products').where({ store_id: tashkent }).first();
  const up = (body, type = 'image/png', token = tashToken, id = p.id) => req(`/products/${id}/image`, { token, method: 'POST', body, type });

  const html = await up(Buffer.from('<html><script>alert(1)</script>'), 'image/png');
  assert.equal(html.status, 400, 'content is sniffed, not trusted from the header');
  assert.equal((await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).status, 400);
  assert.equal((await up(Buffer.alloc(0))).status, 400);
  assert.equal((await up(Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]))).status, 413);
  const other = await db('products').where({ store_id: samarkand }).first();
  assert.equal((await up(PNG, 'image/png', tashToken, other.id)).status, 404, 'manager cannot touch another store');
  assert.deepEqual(await productFiles(), []);

  const first = await up(PNG, 'application/octet-stream');
  assert.equal(first.status, 200);
  assert.match(first.body.image_url, new RegExp(`^/uploads/products/${p.id}-[0-9a-f]{16}\\.png$`));
  const served = await fetch(base + first.body.image_url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await req(`/products/${p.id}`, { token: tashToken })).body.image_url, first.body.image_url);

  const second = await up(JPG, 'image/jpeg');
  assert.match(second.body.image_url, /\.jpg$/);
  assert.deepEqual(await productFiles(), [path.basename(second.body.image_url)], 'old image removed on replace');

  assert.equal((await req(`/products/${p.id}/image`, { token: tashToken, method: 'DELETE' })).status, 204);
  assert.deepEqual(await productFiles(), []);
  assert.equal((await db('products').where({ id: p.id }).first()).image_url, null);
});

test('deleting a product removes its image file', async () => {
  const created = await req('/products', { token: tashToken, method: 'POST', body: { name: 'Rasmli', category: 'top', gender: 'unisex', color: 'oq', price: 1000, temp_min: 0, temp_max: 30 } });
  await req(`/products/${created.body.id}/image`, { token: tashToken, method: 'POST', body: PNG, type: 'image/png' });
  assert.equal((await productFiles()).length, 1);
  assert.equal((await req(`/products/${created.body.id}`, { token: tashToken, method: 'DELETE' })).status, 204);
  assert.deepEqual(await productFiles(), []);
});

test('stats read recommendation_logs: empty first, then per day and top items, store-scoped', async () => {
  const empty = await req('/stats', { token: tashToken });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.total, 0);
  assert.equal(empty.body.per_day.length, 30);
  assert.ok(empty.body.per_day.every((d) => d.count === 0));
  assert.deepEqual(empty.body.top, []);
  assert.equal((await req('/stats')).status, 401);

  const [a, b] = await db('products').where({ store_id: tashkent }).orderBy('id').limit(2);
  const gone = await req('/products', { token: tashToken, method: 'POST', body: { name: 'Vaqtinchalik', category: 'top', gender: 'unisex', color: 'oq', price: 1000, temp_min: 0, temp_max: 30 } });
  const sam = await db('products').where({ store_id: samarkand }).first();
  const utc = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
  const log = (store_id, ids, created_at = utc(0)) => ({ store_id, product_ids: JSON.stringify(ids), source: 'rules', created_at });
  await db('recommendation_logs').insert([
    log(tashkent, [a.id, b.id, a.id]), // duplicate id in one log counts once
    log(tashkent, [a.id, gone.body.id]),
    log(tashkent, [a.id], utc(2 * 86400000)),
    log(tashkent, [b.id], utc(60 * 86400000)), // outside 30 days
    log(samarkand, [sam.id, sam.id]),
  ]);
  await req(`/products/${gone.body.id}`, { token: tashToken, method: 'DELETE' });

  const s = (await req('/stats', { token: tashToken })).body;
  assert.equal(s.total, 3);
  assert.equal(s.per_day.at(-1).count, 2, 'today');
  assert.equal(s.per_day.at(-3).count, 1, 'two days ago');
  assert.deepEqual(s.top.map((t) => [t.product_id, t.count]), [[a.id, 3], [b.id, 1], [gone.body.id, 1]]);
  assert.equal(s.top[0].name, a.name);
  assert.equal(s.top[2].name, null, 'deleted product still counted');
  assert.ok(!s.top.some((t) => t.product_id === sam.id), 'no other store data for a manager');
  assert.equal((await req(`/stats?store_id=${samarkand}`, { token: tashToken })).body.total, 0);

  assert.equal((await req('/stats?days=90', { token: tashToken })).body.total, 4);
  const all = (await req('/stats', { token: superToken })).body;
  assert.equal(all.total, 4);
  assert.equal((await req(`/stats?store_id=${samarkand}`, { token: superToken })).body.top[0].count, 1);
});
