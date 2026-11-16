// Task 18: paged/sorted/filtered admin lists, orders CSV export, the dashboard and the unseen-orders badge.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin, PAGE_MAX } from '../src/admin/routes.js';
import { toCsv, parseCsv } from '../src/admin/csv.js';
import { parseHash, buildHash, offsetOf, pageInfo, delta, share, niceTicks, compact, stockLevel } from '../public/admin/util.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, tashkent, samarkand, tashToken, samToken, superToken;

const call = async (path, { token, method = 'GET', body, raw = false } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return { status: res.status, headers: res.headers, text: Buffer.from(await res.arrayBuffer()).toString('utf8') }; // keeps the BOM
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const admin = (path, token) => call(`/api/admin${path}`, { token });
const login = async (email, password) => (await call('/api/admin/login', { method: 'POST', body: { email, password } })).body.token;

// A fresh order of one top (size M) in this store, taken at the cashier unless paid: false.
async function order(storeId, { name = 'Aziz', phone = '901234567', paid = true } = {}) {
  const p = await db('products').where({ store_id: storeId, category: 'top' }).orderBy('id').first();
  await db('product_stock').where({ product_id: p.id, size: 'M' }).update({ quantity: 50, reserved: 0 });
  const cart = await call('/api/cart/items', { method: 'POST', body: { store_id: storeId, items: [{ product_id: p.id, size: 'M' }] } });
  const r = await call(`/api/cart/${cart.body.token}/checkout`, { method: 'POST', body: { fulfillment: 'pickup', name, phone } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (paid) assert.equal((await call(`/api/admin/orders/${r.body.order.id}/pay`, { method: 'POST', token: storeId === tashkent ? tashToken : samToken })).status, 200);
  return { ...r.body.order, product_id: p.id };
}

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [tashkent, samarkand] = (await db('stores').orderBy('id')).map((s) => s.id);
  await createAdmin(db, { email: 'tash@smartfit.uz', password: 'tash-pass-1', storeId: tashkent });
  await createAdmin(db, { email: 'sam@smartfit.uz', password: 'sam-pass-1', storeId: samarkand });
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  const weather = async () => ({ temperature: 5, apparent_temperature: 2, raining: false, wind_speed: 3, source: 'live' });
  server = createApp(db, { weather, telegram: null }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  [tashToken, samToken, superToken] = await Promise.all([login('tash@smartfit.uz', 'tash-pass-1'), login('sam@smartfit.uz', 'sam-pass-1'), login('boss@smartfit.uz', 'boss-pass-1')]);
});
after(async () => {
  server.close();
  await db.destroy();
});

test('products: paging limits are clamped, pages do not overlap', async () => {
  const total = Number((await db('products').where({ store_id: tashkent }).count({ n: '*' }))[0].n);
  const big = (await admin('/products?limit=5000', tashToken)).body;
  assert.equal(big.limit, PAGE_MAX);
  assert.equal(big.items.length, Math.min(total, PAGE_MAX));
  assert.equal(big.total, total);
  const odd = (await admin('/products?limit=-3&offset=-9', tashToken)).body;
  assert.deepEqual([odd.limit, odd.offset], [1, 0], 'negative values clamp to the smallest page');
  const p1 = (await admin('/products?limit=10', tashToken)).body, p2 = (await admin('/products?limit=10&offset=10', tashToken)).body;
  assert.equal(p1.items.length, 10);
  assert.ok(!p1.items.some((a) => p2.items.some((b) => b.id === a.id)), 'pages do not overlap');
  const past = (await admin(`/products?offset=${total + 5}`, tashToken)).body;
  assert.deepEqual([past.items.length, past.total], [0, total]);
});

test('products: sorting by name, effective price and free stock; unknown sort/filter/dir refused', async () => {
  const get = async (q) => (await admin(`/products?limit=100&${q}`, tashToken)).body.items;
  const eff = (p) => p.discount_price ?? p.price;
  const free = (p) => p.stock.reduce((a, s) => a + s.quantity - s.reserved, 0);
  const asc = (xs) => xs.every((v, i) => i === 0 || xs[i - 1] <= v);
  assert.ok(asc((await get('sort=price&dir=asc')).map(eff)), 'price asc uses the discount price when set');
  assert.ok(asc((await get('sort=price&dir=desc')).map(eff).reverse()));
  assert.ok(asc((await get('sort=stock&dir=asc')).map(free)));
  const names = (await get('sort=name')).map((p) => p.name);
  assert.deepEqual(names, [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'name defaults to A→Z');
  const created = (await get('')).map((p) => p.id);
  assert.deepEqual(created, [...created].sort((a, b) => b - a), 'default: newest first');
  for (const bad of ['sort=id;drop table products', 'sort=password_hash', 'dir=sideways', 'filter=cheap', 'sort=price&dir=asc,1']) {
    const r = await admin(`/products?${bad}`, tashToken);
    assert.equal(r.status, 400, bad);
    assert.equal(r.body.code, 'invalid');
  }
});

test('products: low / out / no_image filters, always inside the manager\'s store', async () => {
  const [a, b, c] = await db('products').where({ store_id: tashkent, category: 'bottom' }).orderBy('id').limit(3);
  const other = await db('products').where({ store_id: samarkand, category: 'bottom', audience: 'adult' }).first();
  await db('product_stock').whereIn('product_id', [a.id, other.id]).update({ quantity: 0, reserved: 0 });
  await db('product_stock').where({ product_id: b.id }).update({ quantity: 5, reserved: 0 });
  await db('product_stock').where({ product_id: b.id, size: 'L' }).update({ quantity: 1 });
  await db('products').whereIn('id', [c.id, other.id]).update({ image_url: null });
  const ids = async (q, token = tashToken) => (await admin(`/products?limit=100&${q}`, token)).body.items.map((p) => p.id);

  const out = await ids('filter=out');
  assert.ok(out.includes(a.id) && !out.includes(b.id) && !out.includes(other.id));
  const low = await ids('filter=low');
  assert.ok(low.includes(b.id), 'one size with 1 left counts as running out');
  assert.ok(low.includes(a.id), 'the restock list also has fully sold-out products');
  const fine = await db('products').where({ store_id: tashkent }).whereNotIn('id', db('product_stock').where('quantity', '<=', 1).select('product_id')).first();
  assert.ok(!low.includes(fine.id), 'every size has 2+ left → not listed');
  const noImg = await ids('filter=no_image');
  assert.deepEqual(noImg, [c.id]);
  assert.deepEqual(await ids(`filter=no_image&store_id=${samarkand}`), [], 'a manager cannot widen the scope');
  assert.ok((await ids('filter=out', superToken)).includes(other.id), 'super-admin sees every store');
  assert.deepEqual(await ids(`filter=out&store_id=${samarkand}`, superToken), [other.id]);
  // Search also matches the SKU.
  const sku = (await db('products').where({ id: b.id }).first()).sku;
  assert.ok((await ids(`q=${encodeURIComponent(sku)}`)).includes(b.id));
});

test('orders: paging, search by number / phone / name, date range, store scope', async () => {
  const o1 = await order(tashkent, { name: 'Dilnoza Karimova', phone: '935550011' });
  const o2 = await order(tashkent, { name: 'Bobur', phone: '977771234', paid: false });
  const s1 = await order(samarkand, { name: 'Dilnoza Samarqand', phone: '935550011' });
  const list = async (q, token = tashToken) => (await admin(`/orders?${q}`, token)).body;

  const page = await list('limit=1');
  assert.equal(page.items.length, 1);
  assert.ok(page.total >= 2);
  assert.equal(page.items[0].id, o2.id, 'newest first');
  const oldest = (await list('limit=1&dir=asc')).items[0];
  assert.ok(oldest.id <= o1.id, 'dir=asc gives the oldest first');
  assert.equal((await list('limit=999')).limit, 100);

  assert.deepEqual((await list(`q=${o1.number}`)).items.map((o) => o.id).includes(o1.id), true, 'by display number');
  assert.deepEqual((await list('q=555 00 11')).items.map((o) => o.id), [o1.id], 'by phone digits, spaces ignored');
  assert.deepEqual((await list('q=dilnoza')).items.map((o) => o.id), [o1.id], 'by name, case-insensitive, own store only');
  assert.deepEqual((await list('q=dilnoza', superToken)).items.map((o) => o.id).sort(), [o1.id, s1.id].sort());
  assert.deepEqual((await list('payment=pending')).items.map((o) => o.id), [o2.id]);
  const pending = (await list('payment=pending')).items[0];
  assert.ok(pending.pay_ms > 0 && pending.pay_ms <= 15 * 60 * 1000, 'pending rows carry the time left to pay');

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
  assert.ok((await list(`from=${today}&to=${today}`)).items.some((o) => o.id === o1.id), 'today is inside today..today');
  assert.equal((await list(`from=${tomorrow}`)).total, 0);
  assert.equal((await list(`to=2020-01-01`)).total, 0);
  for (const bad of ['from=10.11.2026', 'to=2026-13-45', 'status=lost', 'payment=maybe', 'dir=up']) {
    assert.equal((await admin(`/orders?${bad}`, tashToken)).status, 400, bad);
  }
  assert.equal((await list(`store_id=${samarkand}`)).total, 0, 'a manager cannot widen the scope');
  assert.ok((await list('limit=100', samToken)).items.every((o) => o.store_id === samarkand));
});

test('orders CSV export: escaped against formulas, quoted, store-scoped, needs a token', async () => {
  const evil = await order(tashkent, { name: '=HYPERLINK("http://x.example","pay")' });
  await order(samarkand, { name: 'Other store buyer' });
  const r = await call('/api/admin/orders/export', { token: tashToken, raw: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="?orders-\d{4}-\d{2}-\d{2}\.csv/);
  assert.ok(r.text.startsWith('﻿'), 'BOM so Excel reads UTF-8');
  const rows = parseCsv(r.text);
  const row = rows.find((x) => x[0] === String(evil.number) && x[3].includes('HYPERLINK'));
  assert.equal(row[3], '\'=HYPERLINK("http://x.example","pay")', 'leading apostrophe, quotes kept');
  assert.equal(row[4], '998 90 123 45 67', 'phone as text, not a number or a formula');
  assert.ok(!rows.some((x) => x[3] === 'Other store buyer'), 'no other store\'s orders');
  assert.ok(rows.slice(1).every((x) => x.length === rows[0].length));
  const filtered = parseCsv((await call(`/api/admin/orders/export?q=${evil.number}&payment=paid`, { token: tashToken, raw: true })).text);
  assert.ok(filtered.slice(1).every((x) => x[0] === String(evil.number)), 'same filters as the list');
  assert.equal((await call('/api/admin/orders/export', { raw: true })).status, 401);
  assert.equal((await call('/api/admin/orders/export?from=nope', { token: tashToken, raw: true })).status, 400);
});

test('toCsv: every risky first character is neutralised', () => {
  const csv = toCsv([['=1+1', '+7', '-2', '@SUM(A1)', '\tx', '\rx', 'ok "quoted"', null, 5]]);
  assert.equal(csv, '﻿"\'=1+1";"\'+7";"\'-2";"\'@SUM(A1)";"\'\tx";"\'\rx";"ok ""quoted""";"";"5"\r\n');
});

test('unseen-orders badge counts newer orders in the admin\'s store only', async () => {
  const start = (await admin('/orders/unseen?since=0', tashToken)).body;
  const superStart = (await admin('/orders/unseen?since=0', superToken)).body;
  assert.ok(start.latest > 0);
  await order(samarkand);
  const mine = await order(tashkent);
  const next = (await admin(`/orders/unseen?since=${start.latest}`, tashToken)).body;
  assert.deepEqual(next, { count: 1, latest: mine.id }, 'the Samarqand order is not counted');
  assert.equal((await admin(`/orders/unseen?since=${superStart.latest}`, superToken)).body.count, 2);
  assert.equal((await admin('/orders/unseen?since=abc', tashToken)).status, 200);
});

test('dashboard: today vs yesterday, work queue, best sellers, running-out sizes; store-scoped', async () => {
  const before = (await admin('/dashboard', samToken)).body;
  const o = await order(samarkand);
  await order(samarkand, { paid: false });
  const d = (await admin('/dashboard', samToken)).body;
  assert.equal(d.days, 7);
  assert.equal(d.today.revenue, before.today.revenue + o.total);
  assert.equal(d.today.paid, before.today.paid + 1);
  assert.equal(d.today.prev.paid, 0, 'nothing was paid yesterday in a fresh DB');
  assert.equal(d.waiting.total, before.waiting.total + 2);
  assert.equal(d.waiting.unpaid, before.waiting.unpaid + 1);
  assert.ok(d.top_sold.some((x) => x.product_id === o.product_id && x.units >= 1 && x.revenue >= o.total));
  const samIds = (await db('products').where({ store_id: samarkand }).pluck('id'));
  assert.ok(d.low_stock.total > 0 && d.low_stock.items.length <= 6);
  assert.ok(d.low_stock.items.every((p) => samIds.includes(p.id)), 'only this store\'s products');
  assert.ok(d.low_stock.items.every((p) => p.stock.some((s) => s.quantity - s.reserved <= 1)));
  assert.ok(d.top_sold.every((x) => samIds.includes(x.product_id)));
  const forced = (await admin(`/dashboard?store_id=${tashkent}`, samToken)).body;
  assert.deepEqual([forced.today.paid, forced.waiting.total], [0, 0], 'a manager cannot read another store\'s numbers');
  assert.equal((await admin('/dashboard?days=30', superToken)).body.days, 30);
  assert.equal((await admin('/dashboard')).status, 401);
});

test('stats: per-day revenue and the previous period for the deltas', async () => {
  const s = (await admin('/stats?days=7', tashToken)).body;
  assert.equal(s.per_day.length, 7);
  const today = s.per_day.at(-1);
  assert.ok(today.revenue > 0 && today.orders > 0);
  assert.equal(s.per_day.reduce((a, d) => a + d.revenue, 0), s.pilot.revenue);
  assert.deepEqual(Object.keys(s.prev).sort(), ['pilot', 'total']);
  assert.equal(s.prev.pilot.orders, 0);
});

test('admin UI helpers: hash routes, paging text, deltas, scales', () => {
  assert.deepEqual(parseHash('#/products?filter=low&page=2'), { route: 'products', params: { filter: 'low', page: '2' } });
  assert.deepEqual(parseHash(''), { route: 'dashboard', params: {} });
  assert.deepEqual(parseHash('#/nope'), { route: 'dashboard', params: {} });
  assert.equal(buildHash('orders', { status: 'new', q: '', page: null }), '#/orders?status=new');
  assert.equal(buildHash('orders', {}), '#/orders');
  assert.equal(offsetOf('3', 25), 50);
  assert.equal(offsetOf('x', 25), 0);
  assert.deepEqual(pageInfo({ offset: 25, limit: 25, total: 60 }), { from: 26, to: 50, page: 2, pages: 3, prev: true, next: true });
  assert.deepEqual(pageInfo({ offset: 0, limit: 25, total: 0 }), { from: 0, to: 0, page: 1, pages: 1, prev: false, next: false });
  assert.equal(delta(120, 100), 20);
  assert.equal(delta(5, 0), null, 'nothing to compare with');
  assert.equal(delta(0, 4), -100);
  assert.equal(share(1, 3), 33);
  assert.equal(share(1, 30), 3.3);
  assert.equal(share(1, 0), null);
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(7), [0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(1_250_000), [0, 500000, 1000000, 1500000]);
  assert.equal(compact(1_250_000, { k: 'k', m: 'M' }), '1,3 M');
  assert.equal(compact(12_500, { k: 'k', m: 'M' }), '12,5 k');
  assert.equal(compact(9_500, { k: 'k', m: 'M' }), '9 500');
  assert.deepEqual([stockLevel(0), stockLevel(1), stockLevel(2)], [0, 1, 2]);
});
