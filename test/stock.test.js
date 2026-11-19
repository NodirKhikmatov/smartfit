// Task 47: receiving and stocktake in the staff app, stock movements and the product's history.
// Receiving adds stock and writes a movement; a replayed scan (same phone id) applies once, also in parallel; a count's
// differences, the manager-only confirm (compared at confirm time), reserved units; another store's product refused;
// the back-in-stock alert; store and organisation isolation; a read-only organisation; every stock path writes a
// movement; migration 037.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { flushStockAlerts } from '../src/notify/telegram.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, a1, a2, b1, orgA, ownerA, managerA1, staff1, staffA2, ownerB, superToken;

const call = async (method, p, body, token, raw) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': raw ? 'text/csv' : 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
};
const admin = (method, p, body, token, raw) => call(method, `/api/admin${p}`, body, token, raw);
const login = async (email, password) => (await admin('POST', '/login', { email, password })).body.token;
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const qty = async (productId, size) => (await db('product_stock').where({ product_id: productId, size }).first())?.quantity;
const setStock = (productId, size, quantity, reserved = 0) => db('product_stock').where({ product_id: productId, size }).update({ quantity, reserved });
const top = (store, n = 0) => db('products').where({ store_id: store, category: 'top' }).orderBy('id').offset(n).first();
const open = async (token, body) => {
  const r = await admin('POST', '/stock/sessions', { key: randomUUID(), ...body }, token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const scan = (token, session, product, size, quantity, key = randomUUID()) => admin('POST', '/stock/scans', { key, session: session.key, product_id: product.id, size, quantity }, token);

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [a1, b1] = (await db('stores').orderBy('id')).map((s) => s.id);
  orgA = (await db('stores').where({ id: a1 }).first()).organization_id;
  [{ id: a2 }] = await db('stores').insert({ name: 'A filial', city: 'Toshkent', address: 'Chilonzor 1', lat: 41.28, lon: 69.2, organization_id: orgA }).returning('id');
  const { id: _, created_at, updated_at, ...p } = await top(a1);
  const [{ id: pA2 }] = await db('products').insert({ ...p, store_id: a2, sku: null }).returning('id');
  await db('product_stock').insert({ product_id: pA2, size: 'M', quantity: 5 });
  await createAdmin(db, { email: 'owner.a@smartfit.uz', password: 'owner-pass-1', storeId: a1 });
  await createAdmin(db, { email: 'mgr.a1@smartfit.uz', password: 'mgr-pass-1', storeId: a1, role: 'manager' });
  await createAdmin(db, { email: 'staff.a1@smartfit.uz', password: 'staff-pass-1', storeId: a1, role: 'staff' });
  await createAdmin(db, { email: 'staff.a2@smartfit.uz', password: 'staff-pass-2', storeId: a2, role: 'staff' });
  await createAdmin(db, { email: 'owner.b@smartfit.uz', password: 'owner-pass-2', storeId: b1 });
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  server = createApp(db, { telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  ownerA = await login('owner.a@smartfit.uz', 'owner-pass-1');
  managerA1 = await login('mgr.a1@smartfit.uz', 'mgr-pass-1');
  staff1 = await login('staff.a1@smartfit.uz', 'staff-pass-1');
  staffA2 = await login('staff.a2@smartfit.uz', 'staff-pass-2');
  ownerB = await login('owner.b@smartfit.uz', 'owner-pass-2');
  superToken = await login('boss@smartfit.uz', 'boss-pass-1');
});
after(async () => {
  server.close();
  await db.destroy();
});

test('receiving: a scan adds stock at once and writes a movement and an audit row; a replayed scan applies once', async () => {
  const p = await top(a1);
  await setStock(p.id, 'L', 2);
  const key = randomUUID();
  const s = await open(staff1, { kind: 'receive', note: 'Yetkazuvchi: Moda Tex, faktura 17' });
  assert.deepEqual([s.kind, s.status, s.store_id, s.note, s.created_email], ['receive', 'open', a1, 'Yetkazuvchi: Moda Tex, faktura 17', 'staff.a1@smartfit.uz']);
  // The session itself is idempotent too (created offline, sent twice).
  const again = await admin('POST', '/stock/sessions', { key: s.key, kind: 'receive' }, staff1);
  assert.deepEqual([again.status, again.body.id], [200, s.id]);

  const r = await scan(staff1, s, p, 'L', 3, key);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await qty(p.id, 'L'), 5);
  const m = await db('stock_movements').where({ product_id: p.id }).orderBy('id', 'desc').first();
  assert.deepEqual([m.size, m.delta, m.quantity_before, m.quantity_after, m.reason, m.admin_email, m.session_id, m.store_id], ['L', 3, 2, 5, 'receive', 'staff.a1@smartfit.uz', s.id, a1]);
  const au = await db('audit_log').where({ action: 'stock.receive' }).orderBy('id', 'desc').first();
  assert.equal(au.entity_id, p.id);

  // The same scan again (the offline queue resent it): 200, nothing applied twice.
  const replay = await scan(staff1, s, p, 'L', 3, key);
  assert.deepEqual([replay.status, replay.body.replay, replay.body.id], [200, true, r.body.id]);
  assert.equal(await qty(p.id, 'L'), 5);
  // Five copies at the same moment (a double tap and retries): one applies.
  const k2 = randomUUID();
  const all = await Promise.all(Array.from({ length: 5 }, () => scan(staff1, s, p, 'L', 2, k2)));
  assert.deepEqual(all.map((x) => x.status).sort(), [200, 200, 200, 200, 201], JSON.stringify(all.map((x) => x.body)));
  assert.equal(await qty(p.id, 'L'), 7);
  assert.equal(Number((await db('stock_scans').where({ key: k2 }).count({ n: '*' }))[0].n), 1);
  assert.equal(Number((await db('stock_movements').where({ product_id: p.id, reason: 'receive' }).count({ n: '*' }))[0].n), 2);

  // Rejected, and nothing changes: a size the product doesn't have, bad quantities, an unknown session.
  assert.equal((await scan(staff1, s, p, '42', 1)).body.code, 'bad_size');
  for (const n of [0, -1, 1001, 1.5, '2']) assert.equal((await scan(staff1, s, p, 'L', n)).status, 400, String(n));
  assert.equal((await admin('POST', '/stock/scans', { key: 'short', session: s.key, product_id: p.id, size: 'L', quantity: 1 }, staff1)).status, 400);
  assert.equal((await scan(staff1, { key: randomUUID() }, p, 'L', 1)).body.code, 'stock_session_missing');
  assert.equal(await qty(p.id, 'L'), 7);

  // The list shows the session with its count; closing it ends the scans.
  const list = (await admin('GET', '/stock/sessions', undefined, staff1)).body;
  assert.deepEqual(['scans', 'units'].map((k) => list.open.find((x) => x.id === s.id)[k]), [2, 5]);
  const detail = (await admin('GET', `/stock/sessions/${s.id}`, undefined, staff1)).body;
  assert.deepEqual(detail.scans.map((x) => [x.size, x.quantity]), [['L', 2], ['L', 3]]);
  assert.equal((await admin('POST', `/stock/sessions/${s.id}/close`, {}, staff1)).body.status, 'closed');
  assert.equal((await scan(staff1, s, p, 'L', 1)).body.code, 'stock_session_closed');
  assert.equal((await admin('POST', `/stock/sessions/${s.id}/close`, {}, staff1)).status, 409);
  assert.equal(await qty(p.id, 'L'), 7);
});

test('another store\'s product is refused (same organisation and another one); the catalogue is the session\'s store only', async () => {
  const s = await open(staff1, { kind: 'receive' });
  const pA2 = await db('products').where({ store_id: a2 }).first();
  const pB = await top(b1);
  for (const p of [pA2, pB, { id: 999999 }]) {
    const r = await scan(staff1, s, p, 'M', 1);
    assert.deepEqual([r.status, r.body.code], [404, 'stock_not_here']);
  }
  assert.equal(await qty(pA2.id, 'M'), 5);
  const cat = (await admin('GET', '/stock/catalog', undefined, staff1)).body;
  assert.equal(cat.store_id, a1);
  assert.ok(cat.products.length > 0 && cat.products.every((p) => Array.isArray(p.sizes)));
  assert.ok(!cat.products.some((p) => p.id === pA2.id || p.id === pB.id));
  assert.equal((await admin('GET', `/stock/catalog?store_id=${a2}`, undefined, staff1)).status, 404);
  assert.equal((await admin('GET', `/stock/catalog?store_id=${b1}`, undefined, ownerA)).status, 404);
  assert.equal((await admin('GET', '/stock/catalog', undefined, ownerA)).status, 400, 'an owner of two stores names one');
  assert.equal((await admin('GET', `/stock/catalog?store_id=${a2}`, undefined, ownerA)).body.store_id, a2);
});

test('the back-in-stock alert fires when receiving brings a size back from 0, once', async () => {
  const p = await top(a1, 1);
  await setStock(p.id, 'S', 0);
  const [{ id: profile }] = await db('customer_profiles').insert({ organization_id: orgA, telegram_user_id: 515001, phone: '+998901234500', name: 'Aziza', consent_at: new Date().toISOString() }).returning('id');
  await db('stock_alerts').insert({ profile_id: profile, store_id: a1, product_id: p.id, size: 'S', lang: 'uz' });
  const out = [];
  const tg = async (to, text) => void out.push({ to, text });
  await flushStockAlerts(db, tg);
  assert.equal(out.length, 0, 'nothing while 0');
  const s = await open(staff1, { kind: 'receive' });
  assert.equal((await scan(staff1, s, p, 'S', 4)).status, 201);
  await flushStockAlerts(db, tg);
  await flushStockAlerts(db, tg);
  assert.deepEqual(out.map((m) => m.to), [515001]);
  assert.match(out[0].text, /yana sotuvda/);
});

test('a count: staff scan a shelf, the differences against the stock now, only a manager confirms, once', async () => {
  const [p, q] = [await top(a1, 2), await top(a1, 3)];
  await db('products').whereIn('id', [p.id, q.id]).update({ shelf_location: 'ZZ-9' });
  await db('product_stock').whereIn('product_id', [p.id, q.id]).update({ quantity: 0, reserved: 0 });
  await setStock(p.id, 'M', 4);
  await setStock(p.id, 'L', 2);
  await setStock(q.id, 'S', 3);
  assert.equal((await admin('POST', '/stock/sessions', { key: randomUUID(), kind: 'count' }, staff1)).body.code, 'stock_scope', 'a count names a category or a shelf');
  const s = await open(staff1, { kind: 'count', shelf: 'zz-9 ' });
  assert.equal(s.shelf, 'zz-9');
  // Staff count: M 4 + 1, then a miscount taken back; L 2 (no change); q's S not found at all.
  for (const [size, n] of [['M', 4], ['M', 2], ['M', -1], ['L', 2]]) assert.equal((await scan(staff1, s, p, size, n)).status, 201);
  assert.equal((await scan(staff1, s, p, 'L', -3)).body.code, 'stock_count_negative', 'a line never goes below 0');
  const other = await db('products as pr').join('product_stock as ps', 'ps.product_id', 'pr.id').where({ 'pr.store_id': a1, 'ps.size': 'M' })
    .whereNotIn('pr.id', [p.id, q.id]).orderBy('pr.id').first('pr.id');
  assert.equal((await scan(staff1, s, other, 'M', 1)).body.code, 'stock_out_of_scope');
  assert.equal(await qty(p.id, 'M'), 4, 'counting changes nothing yet');

  const v = (await admin('GET', `/stock/sessions/${s.id}`, undefined, staff1)).body;
  assert.equal(v.can_confirm, false, 'staff count, a manager confirms');
  const line = (x, size) => v.lines.find((l) => l.product_id === x.id && l.size === size);
  assert.deepEqual(['counted', 'quantity', 'diff'].map((k) => line(p, 'M')[k]), [5, 4, 1]);
  assert.deepEqual(['counted', 'quantity', 'diff'].map((k) => line(p, 'L')[k]), [2, 2, 0]);
  assert.deepEqual(['counted', 'quantity', 'diff'].map((k) => line(q, 'S')[k]), [0, 3, -3], 'an unscanned size with stock counts as 0');
  assert.equal(line(q, 'M'), undefined, 'sizes with no stock and no scan are left out');

  const body = { lines: v.lines.filter((l) => l.diff).map((l) => ({ product_id: l.product_id, size: l.size, quantity: l.quantity })) };
  assert.equal((await admin('POST', `/stock/sessions/${s.id}/confirm`, body, staff1)).status, 403);
  // A sale between the look and the confirm: nothing is applied, the manager looks again.
  await setStock(p.id, 'M', 3);
  const changed = await admin('POST', `/stock/sessions/${s.id}/confirm`, body, managerA1);
  assert.deepEqual([changed.status, changed.body.code], [409, 'stock_changed']);
  assert.equal(await qty(q.id, 'S'), 3);
  assert.equal((await db('stock_sessions').where({ id: s.id }).first()).status, 'open');
  const v2 = (await admin('GET', `/stock/sessions/${s.id}`, undefined, managerA1)).body;
  assert.equal(v2.can_confirm, true);
  const body2 = { lines: v2.lines.filter((l) => l.diff).map((l) => ({ product_id: l.product_id, size: l.size, quantity: l.quantity })) };
  const [c1, c2] = await Promise.all([admin('POST', `/stock/sessions/${s.id}/confirm`, body2, managerA1), admin('POST', `/stock/sessions/${s.id}/confirm`, body2, ownerA)]);
  assert.deepEqual([c1.status, c2.status].sort(), [200, 409], 'one confirm wins');
  assert.equal((c1.status === 200 ? c1 : c2).body.applied, 2);
  assert.deepEqual([await qty(p.id, 'M'), await qty(p.id, 'L'), await qty(q.id, 'S')], [5, 2, 0]);
  const moves = await db('stock_movements').where({ session_id: s.id, reason: 'count' }).orderBy('id');
  assert.deepEqual(moves.map((m) => `${m.product_id} ${m.size} ${m.quantity_before}→${m.quantity_after}`).sort(), [`${p.id} M 3→5`, `${q.id} S 3→0`].sort());
  const au = await db('audit_log').where({ action: 'stock.count', entity_id: s.id }).first();
  assert.ok(au, 'audited');
  assert.equal((await scan(staff1, s, p, 'M', 1)).body.code, 'stock_session_closed');
  assert.equal((await admin('GET', `/stock/sessions/${s.id}`, undefined, managerA1)).body.can_confirm, false);
});

test('reserved units: a count compares with total stock, never sets it below what carts hold; a category count', async () => {
  const p = await top(a1, 4);
  await db('product_stock').where({ product_id: p.id }).update({ quantity: 0, reserved: 0 });
  await setStock(p.id, 'M', 5);
  // Two units held by a customer's cart (still on the shelf).
  for (let i = 0; i < 2; i++) assert.equal((await call('POST', '/api/cart/items', { store_id: a1, items: [{ product_id: p.id, size: 'M' }] })).status, 200);
  assert.equal((await db('product_stock').where({ product_id: p.id, size: 'M' }).first()).reserved, 2);
  const s = await open(staff1, { kind: 'count', category_id: p.category_id });
  assert.equal((await scan(staff1, s, p, 'M', 1)).status, 201);
  let v = (await admin('GET', `/stock/sessions/${s.id}`, undefined, managerA1)).body;
  let l = v.lines.find((x) => x.product_id === p.id && x.size === 'M');
  assert.deepEqual([l.counted, l.quantity, l.reserved, l.blocked], [1, 5, 2, true]);
  const r = await admin('POST', `/stock/sessions/${s.id}/confirm`, { lines: [{ product_id: p.id, size: 'M', quantity: 5 }] }, managerA1);
  assert.deepEqual([r.status, r.body.code], [409, 'stock_below_reserved']);
  assert.match(r.body.error, /2/);
  assert.equal(await qty(p.id, 'M'), 5);
  // Found one more in a fitting room: 2 counted = the 2 held. Allowed; the carts keep their holds.
  assert.equal((await scan(staff1, s, p, 'M', 1)).status, 201);
  v = (await admin('GET', `/stock/sessions/${s.id}`, undefined, managerA1)).body;
  l = v.lines.find((x) => x.product_id === p.id && x.size === 'M');
  assert.equal(l.blocked, false);
  assert.equal((await admin('POST', `/stock/sessions/${s.id}/confirm`, { lines: [{ product_id: p.id, size: 'M', quantity: 5 }] }, managerA1)).status, 200);
  const row = await db('product_stock').where({ product_id: p.id, size: 'M' }).first();
  assert.deepEqual([row.quantity, row.reserved], [2, 2]);
  assert.equal((await admin('POST', '/stock/sessions', { key: randomUUID(), kind: 'count', category_id: 999999 }, staff1)).status, 400);
});

test('every stock path writes a movement; the product page shows the history, newest first', async () => {
  const p = await top(a1, 5);
  await db('products').where({ id: p.id }).update({ sku: 'MOVE-1' });
  // Admin form, CSV, the sync API, a sale at the cashier, a paid order cancelled.
  assert.equal((await admin('PATCH', `/products/${p.id}`, { stock: { M: 9 } }, managerA1)).status, 200);
  assert.equal((await admin('POST', '/products/import', undefined, managerA1, `id,M\n${p.id},8\n`)).status, 200);
  const key = (await admin('POST', '/sync-keys', { name: 'Kassa' }, ownerA)).body.key;
  const sync = await fetch(`${base}/api/sync/stock`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ items: [{ sku: 'MOVE-1', size: 'M', quantity: 7 }] }) });
  assert.equal(sync.status, 200);
  const cart = await call('POST', '/api/cart/items', { store_id: a1, items: [{ product_id: p.id, size: 'M' }] });
  const o = (await call('POST', `/api/cart/${cart.body.token}/checkout`, { fulfillment: 'pickup', name: 'Dilnoza', phone: '+998907776655' })).body.order;
  assert.equal((await admin('POST', `/orders/${o.id}/pay`, { method: 'cash' }, managerA1)).status, 200);
  assert.equal((await admin('POST', `/orders/${o.id}/status`, { status: 'cancelled' }, managerA1)).status, 200);
  const h = await admin('GET', `/products/${p.id}/movements`, undefined, managerA1);
  assert.equal(h.status, 200);
  const rows = h.body.items.filter((x) => x.size === 'M').map((x) => [x.reason, x.quantity_before, x.quantity_after]);
  assert.deepEqual(rows.slice(0, 5), [['cancel', 6, 7], ['sale', 7, 6], ['sync', 8, 7], ['csv', 9, 8], ['admin', rows[4][1], 9]]);
  const items = h.body.items;
  assert.equal(items.find((x) => x.reason === 'sale').order_number, o.number);
  assert.equal(items.find((x) => x.reason === 'sync').admin_email, 'API: Kassa');
  assert.equal(items.find((x) => x.reason === 'admin').admin_email, 'mgr.a1@smartfit.uz');
  assert.equal((await admin('GET', `/products/${p.id}/movements?limit=2`, undefined, managerA1)).body.items.length, 2);
  // Scope: staff never reach admin product routes; another organisation gets 404.
  assert.equal((await admin('GET', `/products/${p.id}/movements`, undefined, staff1)).status, 403);
  assert.equal((await admin('GET', `/products/${p.id}/movements`, undefined, ownerB)).status, 404);
  assert.equal((await admin('GET', `/products/${p.id}/movements`, undefined, superToken)).status, 200);
});

test('store isolation: staff of one store never see or touch another store\'s sessions; a phone id is never reused across stores', async () => {
  const sA2 = await open(staffA2, { kind: 'receive', note: 'A2 qabul' });
  const sA1 = await open(staff1, { kind: 'receive' });
  const pA2 = await db('products').where({ store_id: a2 }).first();
  assert.ok(!(await admin('GET', '/stock/sessions', undefined, staff1)).body.open.some((s) => s.id === sA2.id));
  assert.equal((await admin('GET', `/stock/sessions/${sA2.id}`, undefined, staff1)).status, 404);
  assert.equal((await admin('POST', `/stock/sessions/${sA2.id}/close`, {}, staff1)).status, 404);
  assert.equal((await admin('POST', `/stock/sessions/${sA2.id}/confirm`, { lines: [] }, managerA1)).status, 404, 'a manager of a1 can\'t confirm a2');
  assert.equal((await scan(staff1, sA2, pA2, 'M', 1)).body.code, 'stock_session_missing');
  assert.equal((await admin('POST', '/stock/sessions', { key: randomUUID(), kind: 'receive', store_id: a2 }, staff1)).status, 404);
  assert.equal(await qty(pA2.id, 'M'), 5);
  // Another organisation: nothing at all.
  assert.equal((await admin('GET', '/stock/sessions', undefined, ownerB)).body.open.length, 0);
  assert.equal((await admin('GET', `/stock/sessions/${sA1.id}`, undefined, ownerB)).status, 404);
  // A key already used in a2 is not answered for a1 (no leak of what was scanned there).
  const k = randomUUID();
  assert.equal((await scan(staffA2, sA2, pA2, 'M', 1, k)).status, 201);
  assert.equal((await admin('POST', '/stock/scans', { key: k, session: sA1.key, product_id: pA2.id, size: 'M', quantity: 1 }, staff1)).body.code, 'stock_key_used');
  assert.equal((await admin('POST', '/stock/sessions', { key: sA2.key, kind: 'receive' }, staff1)).body.code, 'stock_key_used');
  // The owner sees both stores' sessions; super sees all.
  const own = (await admin('GET', '/stock/sessions', undefined, ownerA)).body.open.map((s) => s.id);
  assert.ok(own.includes(sA1.id) && own.includes(sA2.id));
  assert.equal((await admin('GET', `/stock/sessions/${sA2.id}`, undefined, superToken)).status, 200);
});

test('a read-only organisation can\'t receive or count', async () => {
  const s = await open(staff1, { kind: 'receive' });
  const p = await top(a1);
  await db('organizations').where({ id: orgA }).update({ plan: 'pro', paid_until: '2020-01-01' });
  try {
    assert.equal((await admin('POST', '/stock/sessions', { key: randomUUID(), kind: 'receive' }, staff1)).body.code, 'plan_readonly');
    assert.equal((await scan(staff1, s, p, 'M', 1)).body.code, 'plan_readonly');
    assert.equal((await admin('GET', '/stock/sessions', undefined, staff1)).status, 200, 'reading still works');
  } finally {
    await db('organizations').where({ id: orgA }).update({ plan: 'biznes', paid_until: null });
  }
});

test('staff app: the scan screens ship, the service worker cache is bumped, no inline code, camera only through BarcodeDetector', async () => {
  const js = read('public/staff/staff.js'), html = read('public/staff/index.html'), sw = read('public/staff/sw.js');
  assert.match(sw, /const CACHE = 'sf-staff-v4'/);
  assert.match(js, /'BarcodeDetector' in window/);
  assert.match(js, /\/stock\/scans/);
  assert.match(html, /id="stockHome"/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)|style=/);
  assert.doesNotMatch(js, /innerHTML/);
});

test('migration 037: down drops the stock tables, up brings them back', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    assert.ok(await m.schema.hasTable('stock_movements'));
    await m.migrate.down(); // 043
    await m.migrate.down(); // 042
    await m.migrate.down(); // 041
    await m.migrate.down(); // 040
    await m.migrate.down(); // 039
    await m.migrate.down(); // 038
    await m.migrate.down();
    for (const t of ['stock_movements', 'stock_scans', 'stock_sessions']) assert.equal(await m.schema.hasTable(t), false, t);
    await m.migrate.latest();
    assert.ok(await m.schema.hasTable('stock_scans'));
    await assert.rejects(m('stock_movements').insert({ store_id: 1, product_id: 1, size: 'M', delta: 1, quantity_before: 0, quantity_after: 1, reason: 'gift' }));
  } finally {
    await m.destroy();
  }
});
