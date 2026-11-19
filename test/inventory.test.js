// Task 20: SKU + barcode, per-store low-stock threshold and Telegram alerts, stock sync API with per-store keys.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, json } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { flushLowStock } from '../src/notify/telegram.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, tashkent, samarkand, ownerToken, managerToken, samToken, superToken;

const call = async (method, p, body, headers = {}, raw) => {
  const res = await fetch(base + p, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const admin = (method, p, body, token, raw) => call(method, `/api/admin${p}`, body, { authorization: `Bearer ${token}`, ...(raw && { 'content-type': 'text/csv' }) }, raw);
const login = async (email, password) => (await call('POST', '/api/admin/login', { email, password })).body.token;
const sync = (key, items) => call('POST', '/api/sync/stock', { items }, key === undefined ? {} : { authorization: `Bearer ${key}` });
const newKey = async (token = ownerToken, body = { name: 'Kassa 1' }) => (await admin('POST', '/sync-keys', body, token)).body;
const stockOf = async (store, sku, size) => db('product_stock as ps').join('products as p', 'p.id', 'ps.product_id')
  .where({ 'p.store_id': store, 'p.sku': sku, 'ps.size': size }).first('ps.*');

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [tashkent, samarkand] = (await db('stores').orderBy('id')).map((s) => s.id);
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  await createAdmin(db, { email: 'owner@smartfit.uz', password: 'owner-pass-1', storeId: tashkent });
  await createAdmin(db, { email: 'mgr@smartfit.uz', password: 'mgr-pass-1', storeId: tashkent, role: 'manager' });
  await createAdmin(db, { email: 'sam@smartfit.uz', password: 'sam-pass-1', storeId: samarkand });
  server = createApp(db, { telegram: null, weather: async () => ({ temperature: 5, raining: false, source: 'live' }) }).listen(0);
  // The migration test blocks the event loop for seconds (sync SQLite); a 5 s keep-alive close firing then races the next request.
  server.keepAliveTimeout = 0;
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  [superToken, ownerToken, managerToken, samToken] = await Promise.all([
    login('boss@smartfit.uz', 'boss-pass-1'), login('owner@smartfit.uz', 'owner-pass-1'), login('mgr@smartfit.uz', 'mgr-pass-1'), login('sam@smartfit.uz', 'sam-pass-1')]);
});
after(async () => {
  server.close();
  await db.destroy();
});

test('migration 010: unique SKU per store, threshold default 1, existing lows pre-marked, down reverts', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await seed(m);
    await m.migrate.down(); // 044
    await m.migrate.down(); // 043
    await m.migrate.down(); // 042
    await m.migrate.down(); // 041
    await m.migrate.down(); // 040
    await m.migrate.down(); // 039
    await m.migrate.down(); // 038
    await m.migrate.down(); // 037
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
    await m.migrate.down(); // 015
    await m.migrate.down(); // 014
    await m.migrate.down(); // 013
    await m.migrate.down(); // 012
    await m.migrate.down(); // 011
    await m.migrate.down(); // 010
    const p = await m('products').where({ sku: 'SF-TP-01' }).first();
    await m('product_stock').where({ product_id: p.id }).update({ quantity: 0, reserved: 0 });
    await m.migrate.up();
    assert.equal((await m('stores').first()).low_stock_threshold, 1);
    assert.ok((await m('product_stock').where({ product_id: p.id })).every((s) => Boolean(s.low_alerted)), 'already low: not alerted again');
    await assert.rejects(m('products').insert({ ...p, id: undefined }), 'same SKU in the same store');
    await m('products').insert({ ...p, id: undefined, sku: null });
    await m('products').insert({ ...p, id: undefined, sku: null }); // many without a SKU
    await m.migrate.down();
    assert.ok(!('barcode' in (await m('products').first())));
    assert.ok((await m('products').count({ n: '*' }))[0].n > 80, 'down kept the products');
  } finally {
    await m.destroy();
  }
});

test('SKU and barcode: validated, unique per store (409), same SKU allowed in another store, searchable', async () => {
  const body = { name: 'SKU test', category: 'top', gender: 'unisex', color: 'oq', price: 100000, temp_min: 0, temp_max: 30, sku: 'T-100', barcode: '4780001234567' };
  const a = await admin('POST', '/products', body, ownerToken);
  assert.equal(a.status, 201);
  assert.equal(a.body.sku, 'T-100');
  assert.equal(a.body.barcode, '4780001234567');
  assert.equal(a.body.low_stock_threshold, 1);
  const dup = await admin('POST', '/products', body, ownerToken);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'sku_taken');
  assert.equal((await admin('POST', '/products', body, samToken)).status, 201, 'another store may use the same SKU');
  const other = await admin('POST', '/products', { ...body, sku: 'T-101' }, ownerToken);
  assert.equal((await admin('PATCH', `/products/${other.body.id}`, { sku: 'T-100' }, ownerToken)).status, 409, 'edit onto a taken SKU');
  assert.equal((await admin('PATCH', `/products/${other.body.id}`, { name: 'Boshqa nom' }, ownerToken)).status, 200, 'own SKU is not a clash');
  for (const sku of ['=1+2', 'a b', '-12', 'x'.repeat(41)]) assert.equal((await admin('POST', '/products', { ...body, sku }, ownerToken)).status, 400, sku);
  assert.equal((await admin('POST', '/products', { ...body, sku: null, barcode: '@x' }, ownerToken)).status, 400);
  const found = await admin('GET', '/products?q=T-100', undefined, ownerToken);
  assert.deepEqual(found.body.items.map((p) => p.id), [a.body.id]);
});

test('CSV import upserts by SKU in the row\'s store; a SKU twice in one file is an error', async () => {
  const before = await stockOf(tashkent, 'SF-TP-01', 'M');
  const n = Number((await db('products').where({ store_id: tashkent }).count({ n: '*' }))[0].n);
  const csv = 'sku;price;M\nSF-TP-01;;7\nNEW-CSV-1;;2\n';
  const fail = await admin('POST', '/products/import', undefined, ownerToken, csv);
  assert.equal(fail.status, 400, 'a new SKU still needs name, category…');
  assert.equal((await stockOf(tashkent, 'SF-TP-01', 'M')).quantity, before.quantity, 'all-or-nothing');
  const ok = await admin('POST', '/products/import', undefined, ownerToken,
    'sku;name;category;gender;color;price;temp_min;temp_max;M\nSF-TP-01;;;;;;;;7\nNEW-CSV-1;CSV ko\'ylak;top;unisex;oq;90000;0;30;2\n');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body, { created: 1, updated: 1 });
  assert.equal((await stockOf(tashkent, 'SF-TP-01', 'M')).quantity, 7);
  assert.equal((await stockOf(samarkand, 'SF-TP-01', 'M'))?.quantity === 7, false, 'the other store is untouched');
  assert.equal(Number((await db('products').where({ store_id: tashkent }).count({ n: '*' }))[0].n), n + 1);
  const twice = await admin('POST', '/products/import', undefined, ownerToken,
    'sku;name;category;gender;color;price;temp_min;temp_max\nDUP-1;A;top;unisex;oq;90000;0;30\nDUP-1;B;top;unisex;oq;90000;0;30\n');
  assert.equal(twice.status, 400);
  assert.equal(twice.body.errors[0].line, 3);
  assert.equal(await db('products').where({ sku: 'DUP-1' }).first(), undefined);
  // Super-admin: the row's store_id picks where the SKU is looked up.
  const sup = await admin('POST', '/products/import', undefined, superToken, `store_id;sku;M\n${samarkand};SF-TP-01;4\n`);
  assert.deepEqual(sup.body, { created: 0, updated: 1 });
  assert.equal((await stockOf(samarkand, 'SF-TP-01', 'M')).quantity, 4);
  assert.equal((await stockOf(tashkent, 'SF-TP-01', 'M')).quantity, 7);
});

test('sync keys: owner/super only, shown once and stored hashed, every action audited', async () => {
  assert.equal((await admin('GET', '/sync-keys', undefined, managerToken)).status, 403);
  assert.equal((await admin('POST', '/sync-keys', { name: 'x' }, managerToken)).status, 403);
  assert.equal((await admin('POST', '/sync-keys', { name: '' }, ownerToken)).status, 400);
  assert.equal((await admin('POST', '/sync-keys', { name: 'x', store_id: samarkand }, ownerToken)).status, 403, 'owner: own store only');
  const k = await newKey();
  assert.match(k.key, /^sfk_[A-Za-z0-9_-]{32}$/);
  const row = await db('sync_keys').where({ id: k.id }).first();
  assert.notEqual(row.key_hash, k.key);
  assert.ok(!JSON.stringify(await db('sync_keys')).includes(k.key), 'the key itself is never stored');
  const log = await db('audit_log').where({ action: 'sync_key.create', entity_id: k.id }).first();
  assert.ok(log && !JSON.stringify(log).includes(k.key), 'audited without the key');
  const list = (await admin('GET', '/sync-keys', undefined, ownerToken)).body;
  assert.ok(list.some((x) => x.id === k.id && x.prefix === k.key.slice(0, 10) && !('key' in x) && !('key_hash' in x)));
  assert.ok(!(await admin('GET', '/sync-keys', undefined, samToken)).body.some((x) => x.id === k.id), 'other store does not see it');
  assert.equal((await admin('DELETE', `/sync-keys/${k.id}`, undefined, samToken)).status, 404, 'other store cannot revoke it');
  const s = await newKey(superToken, { name: 'Sam 1C', store_id: samarkand });
  assert.equal(s.store_id, samarkand);
});

test('sync: a revoked, unknown or missing key gets 401', async () => {
  const k = await newKey();
  const item = [{ sku: 'SF-TP-01', size: 'L', quantity: 9 }];
  assert.equal((await sync(k.key, item)).status, 200);
  assert.equal((await admin('DELETE', `/sync-keys/${k.id}`, undefined, ownerToken)).status, 204);
  assert.ok(await db('audit_log').where({ action: 'sync_key.revoke', entity_id: k.id }).first());
  for (const key of [k.key, undefined, '', 'sfk_' + 'a'.repeat(32), k.key.slice(0, -1), 'Bearer x'.repeat(500)]) {
    const r = await sync(key, item);
    assert.equal(r.status, 401, String(key).slice(0, 20));
    assert.equal(r.body.code, 'sync_key');
  }
  assert.equal((await admin('GET', '/sync-keys', undefined, ownerToken)).body.some((x) => x.id === k.id), false, 'revoked keys leave the list');
  // An admin session token is not a sync key, and a sync key is not an admin token.
  assert.equal((await sync(ownerToken, item)).status, 401);
  const live = await newKey();
  assert.equal((await admin('GET', '/products', undefined, live.key)).status, 401);
});

test('sync: scoped to the key\'s store, all-or-nothing, never below reserved, limits, audit and last use', async () => {
  const k = await newKey();
  const onlySam = (await db('products').where({ store_id: samarkand }).whereNotIn('sku', db('products').where({ store_id: tashkent }).whereNotNull('sku').select('sku')).first()).sku;
  const samBefore = await stockOf(samarkand, 'SF-TP-01', 'S');

  // Store scope: a SKU only Samarqand has is unknown to a Toshkent key; a shared SKU changes Toshkent only.
  const scoped = await sync(k.key, [{ sku: onlySam, size: 'M', quantity: 3 }]);
  assert.equal(scoped.status, 400);
  assert.equal(scoped.body.errors[0].code, 'sync_sku');
  assert.equal((await sync(k.key, [{ sku: 'SF-TP-01', size: 'S', quantity: 11 }])).status, 200);
  assert.equal((await stockOf(tashkent, 'SF-TP-01', 'S')).quantity, 11);
  assert.equal((await stockOf(samarkand, 'SF-TP-01', 'S')).quantity, samBefore.quantity);

  // Below reserved: refused for that row, and the good rows of the same batch are not applied either.
  const held = await stockOf(tashkent, 'SF-TP-01', 'M');
  await db('product_stock').where({ id: held.id }).update({ quantity: 6, reserved: 4 });
  const xl = await stockOf(tashkent, 'SF-TP-01', 'XL');
  const r = await sync(k.key, [{ sku: 'SF-TP-01', size: 'XL', quantity: xl.quantity + 5 }, { sku: 'SF-TP-01', size: 'M', quantity: 3 }]);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'sync_rows');
  assert.deepEqual(r.body.errors.map((e) => [e.index, e.code]), [[1, 'size_reserved']]);
  assert.equal((await stockOf(tashkent, 'SF-TP-01', 'XL')).quantity, xl.quantity, 'batch rolled back');
  assert.equal((await stockOf(tashkent, 'SF-TP-01', 'M')).quantity, 6);
  // Exactly the reserved amount is fine (nothing free, nothing oversold).
  const ok = await sync(k.key, [{ sku: 'SF-TP-01', size: 'XL', quantity: xl.quantity + 5 }, { sku: 'SF-TP-01', size: 'm', quantity: 4 }, { sku: 'SF-TP-01', size: 'S', quantity: 11 }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body, { updated: 2, unchanged: 1 });
  assert.equal((await stockOf(tashkent, 'SF-TP-01', 'M')).quantity, 4);

  const log = await db('audit_log').where({ action: 'stock.sync' }).orderBy('id', 'desc').first();
  assert.equal(log.store_id, tashkent);
  assert.equal(log.admin_id, null);
  assert.equal(log.admin_email, 'API: Kassa 1');
  assert.deepEqual(json(log.after), { 'SF-TP-01 XL': xl.quantity + 5, 'SF-TP-01 M': 4 });
  assert.ok((await db('sync_keys').where({ id: k.id }).first()).last_used_at);
  const n = Number((await db('audit_log').where({ action: 'stock.sync' }).count({ n: '*' }))[0].n);
  assert.deepEqual((await sync(k.key, [{ sku: 'SF-TP-01', size: 'S', quantity: 11 }])).body, { updated: 0, unchanged: 1 });
  assert.equal(Number((await db('audit_log').where({ action: 'stock.sync' }).count({ n: '*' }))[0].n), n, 'no change, no audit row');

  // Row validation and limits.
  const bad = await sync(k.key, [
    { sku: 'SF-TP-01', size: '42', quantity: 1 }, { sku: 'SF-TP-01', size: 'L', quantity: -1 }, { sku: 'SF-TP-01', size: 'L', quantity: 1.5 },
    { sku: '', size: 'L', quantity: 1 }, { sku: 'SF-TP-01', size: 'L', quantity: '3' }, null,
    { sku: 'SF-TP-01', size: 'XS', quantity: 1 }, { sku: 'SF-TP-01', size: 'XS', quantity: 2 },
  ]);
  assert.deepEqual(bad.body.errors.map((e) => e.code), ['bad_size', 'invalid_qty', 'invalid_qty', 'invalid', 'invalid_qty', 'invalid', 'sync_dup']);
  assert.equal((await sync(k.key, [])).status, 400);
  assert.equal((await call('POST', '/api/sync/stock', { items: 'x' }, { authorization: `Bearer ${k.key}` })).status, 400);
  const many = await sync(k.key, Array.from({ length: 1001 }, (_, i) => ({ sku: `S${i}`, size: 'M', quantity: 1 })));
  assert.equal(many.status, 400);
  assert.equal(many.body.code, 'sync_too_many');
  // Russian error text on request.
  const ru = await call('POST', '/api/sync/stock?lang=ru', { items: [{ sku: onlySam, size: 'M', quantity: 1 }] }, { authorization: `Bearer ${k.key}` });
  assert.match(ru.body.error, /[Ѐ-ӿ]/);
});

test('low-stock threshold: a store setting that drives the dashboard and the low filter', async () => {
  assert.equal((await admin('PATCH', `/stores/${tashkent}`, { low_stock_threshold: -1 }, ownerToken)).status, 400);
  assert.equal((await admin('PATCH', `/stores/${tashkent}`, { low_stock_threshold: 1001 }, ownerToken)).status, 400);
  assert.equal((await admin('PATCH', `/stores/${tashkent}`, { low_stock_threshold: 0 }, managerToken)).status, 403);
  const low = async () => (await admin('GET', '/dashboard', undefined, ownerToken)).body.low_stock.total;
  const filtered = async () => (await admin('GET', '/products?filter=low&limit=1', undefined, ownerToken)).body.total;
  const set = async (n) => assert.equal((await admin('PATCH', `/stores/${tashkent}`, { low_stock_threshold: n }, ownerToken)).body.low_stock_threshold, n);
  await set(0);
  const atZero = await low();
  await set(3);
  const atThree = await low();
  assert.ok(atThree > atZero, `${atThree} > ${atZero}`);
  assert.equal(await filtered(), atThree, 'dashboard count and the "see all" list agree');
  assert.equal((await admin('GET', '/dashboard', undefined, ownerToken)).body.low_stock.items[0].low_stock_threshold, 3);
  assert.deepEqual(json((await db('audit_log').where({ action: 'store.update' }).orderBy('id', 'desc').first()).after), { low_stock_threshold: 3 });
  await set(1);
});

test('low-stock alert: sent once per crossing to the store\'s staff chat (mocked sender)', async () => {
  const sent = [];
  const telegram = async (chat, text) => { sent.push({ chat, text }); };
  const p = await db('products').where({ store_id: tashkent, sku: 'SF-OW-01' }).first();
  const sizeRow = await db('product_stock').where({ product_id: p.id, size: 'L' }).first();
  await db('product_stock').where({ id: sizeRow.id }).update({ quantity: 10, reserved: 0 });
  await db('stores').update({ telegram_chat_id: null });
  await flushLowStock(db, telegram); // settle whatever the seed left low
  await db('product_stock').update({ low_alerted: true });
  await db('stores').where({ id: tashkent }).update({ telegram_chat_id: -100777, low_stock_threshold: 2 });

  await flushLowStock(db, telegram);
  assert.equal(sent.length, 0, 'nothing crossed');
  // Crossing down through the sync API: 10 → 2 (at the threshold).
  const k = await newKey();
  assert.equal((await sync(k.key, [{ sku: 'SF-OW-01', size: 'L', quantity: 2 }])).status, 200);
  await flushLowStock(db, telegram);
  await flushLowStock(db, telegram);
  assert.equal(sent.length, 1, 'once');
  assert.equal(sent[0].chat, -100777);
  assert.match(sent[0].text, /SF-OW-01/);
  assert.match(sent[0].text, /L: 2 dona qoldi/);
  // Still low, lower still: no new message. Back above, then down again: a second crossing, a second message.
  await db('product_stock').where({ id: sizeRow.id }).update({ quantity: 0 });
  await flushLowStock(db, telegram);
  assert.equal(sent.length, 1);
  await db('product_stock').where({ id: sizeRow.id }).update({ quantity: 8 });
  await flushLowStock(db, telegram);
  assert.equal(sent.length, 1, 'recovery is silent');
  assert.equal(Boolean((await db('product_stock').where({ id: sizeRow.id }).first()).low_alerted), false);
  // Cart holds count: free = quantity - reserved.
  await db('product_stock').where({ id: sizeRow.id }).update({ reserved: 7 });
  await flushLowStock(db, telegram);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /L: 1 dona qoldi/);
  // A failed send (network) is retried next round; a gone chat (403) is not retried forever.
  await db('product_stock').where({ id: sizeRow.id }).update({ reserved: 0, quantity: 9 });
  await flushLowStock(db, telegram);
  await db('product_stock').where({ id: sizeRow.id }).update({ quantity: 1 });
  let calls = 0;
  await flushLowStock(db, async () => { calls++; throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); });
  await flushLowStock(db, telegram);
  assert.equal(calls, 1);
  assert.equal(sent.length, 3, 'retried after the failure');
  // Another store's chat never gets this store's sizes; no chat → nothing sent.
  assert.ok(sent.every((s) => s.chat === -100777));
  await db('stores').where({ id: tashkent }).update({ telegram_chat_id: null, low_stock_threshold: 1 });
});
