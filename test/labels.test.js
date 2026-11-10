// Task 32: QR labels on garments: the label link (/q/<store>/<product> → that store's item page, scan logged), the
// fitting-room request from a label's item page, the admin label sheet and the "scanned often, rarely bought" report.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, tableNames } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { dbTime } from '../src/recommend/routes.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
delete process.env.PUBLIC_URL;
const db = testDb();
let server, base, limited, limitedBase, tashkent, samarkand, owner, manager, samOwner, superToken, tops, sam;

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
};
const admin = (p, token = owner) => call('GET', `/api/admin${p}`, undefined, { authorization: `Bearer ${token}` });
const login = async (email, password) => (await call('POST', '/api/admin/login', { email, password })).body.token;
const scan = async (storeId, productId, b = base, method = 'GET') => {
  const res = await fetch(`${b}/q/${storeId}/${productId}`, { method, redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), retry: res.headers.get('retry-after'), cache: res.headers.get('cache-control') };
};
const scans = () => db('qr_scans').count({ n: '*' }).then(([{ n }]) => Number(n));
const tokenOf = (location) => new URLSearchParams(location.split('?')[1]).get('scan');

before(async () => {
  await db.migrate.latest();
  await seed(db); // one organisation per demo store
  [tashkent, samarkand] = (await db('stores').orderBy('id')).map((s) => s.id);
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  await createAdmin(db, { email: 'own@smartfit.uz', password: 'own-pass-1', storeId: tashkent });
  await createAdmin(db, { email: 'mgr@smartfit.uz', password: 'mgr-pass-1', storeId: tashkent, role: 'manager' });
  await createAdmin(db, { email: 'sam@smartfit.uz', password: 'sam-pass-1', storeId: samarkand });
  server = createApp(db, { stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }), limits: { scan: 0 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  limited = createApp(db, { stylist: null, limits: { scan: 2 } }).listen(0);
  await new Promise((r) => limited.once('listening', r));
  limitedBase = `http://127.0.0.1:${limited.address().port}`;
  [superToken, owner, manager, samOwner] = await Promise.all([login('boss@smartfit.uz', 'boss-pass-1'), login('own@smartfit.uz', 'own-pass-1'),
    login('mgr@smartfit.uz', 'mgr-pass-1'), login('sam@smartfit.uz', 'sam-pass-1')]);
  tops = await db('products').where({ store_id: tashkent, category: 'top' }).orderBy('id');
  sam = await db('products').where({ store_id: samarkand, category: 'top' }).orderBy('id').first();
  for (const p of [...tops.slice(0, 4), sam]) await db('product_stock').where({ product_id: p.id, size: 'M' }).update({ quantity: 5, reserved: 0 });
});
after(async () => {
  server.close();
  limited.close();
  await db.destroy();
});

test('label link: that store\'s product in stock → its item page with a scan token, logged without personal data; anything else is not logged', async () => {
  const [p] = tops;
  const before = await scans();
  const r = await scan(tashkent, p.id);
  assert.equal(r.status, 302);
  assert.match(r.location, new RegExp(`^/m\\?store=${tashkent}&item=${p.id}&scan=[a-f0-9]{32}$`));
  assert.equal(r.cache, 'no-store', 'every scan reaches the server');
  const row = await db('qr_scans').where({ token: tokenOf(r.location) }).first();
  assert.deepEqual([row.store_id, row.product_id], [tashkent, p.id]);
  assert.deepEqual(Object.keys(row).sort(), ['created_at', 'id', 'product_id', 'store_id', 'token'], 'no IP, device or customer column');
  assert.notEqual(tokenOf((await scan(tashkent, p.id)).location), tokenOf(r.location), 'a token per scan');
  assert.equal(await scans(), before + 2);

  // The product must belong to that store: the phone still opens the item page there (which says it is not found), unlogged.
  assert.equal((await scan(samarkand, p.id)).location, `/m?store=${samarkand}&item=${p.id}`);
  // ...and be visible: no free stock in any size (all held in carts counts as none).
  const [, gone] = tops;
  await db('product_stock').where({ product_id: gone.id }).update({ quantity: 2, reserved: 2 });
  assert.equal((await scan(tashkent, gone.id)).location, `/m?store=${tashkent}&item=${gone.id}`);
  assert.equal((await scan(tashkent, 99999)).location, `/m?store=${tashkent}&item=99999`);
  assert.equal((await scan(tashkent, 'x')).location, `/m?store=${tashkent}`);
  assert.equal((await scan(tashkent, 99999999999)).location, `/m?store=${tashkent}`, 'beyond an integer id: no query (Postgres would throw)');
  assert.equal((await scan(99999999999, p.id)).location, '/m');
  assert.equal((await scan('x', p.id)).location, '/m');
  assert.equal((await scan(tashkent, p.id, base, 'HEAD')).status, 302);
  assert.equal(await scans(), before + 2, 'none of those, nor a HEAD (link preview), was logged');

  // The page it lands on is the customer app, cold (no session needed).
  const page = await fetch(base + r.location);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script type="module" src="\/app\/app\.js/);

  // Over the rate limit the customer is still sent on, just not counted; no 429 from a label.
  const n = await scans();
  const many = await Promise.all([1, 2, 3, 4].map(() => scan(tashkent, p.id, limitedBase)));
  assert.ok(many.every((x) => x.status === 302 && x.retry === null), JSON.stringify(many));
  assert.equal(many.filter((x) => tokenOf(x.location)).length, 2);
  assert.equal(await scans(), n + 2);
  assert.ok((await tableNames(db)).includes('qr_scans'));
});

test('fitting room from a label\'s item page: the scan token stands in for the results screen, same store and stock rules', async () => {
  const [p, gone, q] = tops;
  const token = tokenOf((await scan(tashkent, p.id)).location);
  const fit = (body) => call('POST', '/api/recommend/fitting', { scan: token, cabin: 3, items: [{ product_id: p.id, size: 'M' }], ...body });
  const r = await fit();
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = await db('fitting_requests').where({ id: r.body.id }).first();
  assert.equal(row.store_id, tashkent);
  assert.equal(row.recommendation_id, null);
  assert.equal(row.scan_id, (await db('qr_scans').where({ token }).first('id')).id);
  assert.equal((await fit({ items: [{ product_id: q.id, size: 'M' }] })).status, 201, 'a "goes well with" item of the same store');
  assert.equal((await fit({ items: [{ product_id: sam.id, size: 'M' }] })).status, 404, "another store's product");
  assert.equal((await fit({ items: [{ product_id: gone.id, size: 'M' }] })).status, 409, 'no free stock');
  assert.equal((await fit({ scan: 'f'.repeat(32) })).status, 404);
  assert.equal((await fit({ scan: 'nope' })).status, 400);
  assert.equal((await call('POST', '/api/recommend/fitting', { cabin: 3, items: [{ product_id: p.id, size: 'M' }] })).status, 400, 'neither rec nor scan');
  assert.equal((await fit()).status, 201);
  assert.equal((await fit()).status, 429, 'at most 3 open requests per scan, like per results screen');
  // The admin queue shows it like any other.
  assert.ok((await admin('/fitting', manager)).body.some((f) => f.id === r.body.id));
});

test('label sheet: only products in the caller\'s stores, each with the label URL and its QR', async () => {
  const [p, q] = tops;
  const r = await admin(`/labels?ids=${q.id},${p.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.items.map((x) => x.id), [q.id, p.id], 'in the order asked');
  assert.equal(r.body.items[0].url, `${base}/q/${tashkent}/${q.id}`);
  assert.match(r.body.items[0].svg, /^<svg[^>]*viewBox/);
  assert.ok(r.body.items[0].store_name && 'name_ru' in r.body.items[0] && 'sku' in r.body.items[0]);
  process.env.PUBLIC_URL = 'https://shop.example.uz/';
  try {
    assert.equal((await admin(`/labels?ids=${p.id}`, manager)).body.items[0].url, `https://shop.example.uz/q/${tashkent}/${p.id}`);
  } finally {
    delete process.env.PUBLIC_URL;
  }
  // Another organisation's product (alone or mixed in) is not found; the super-admin may print both.
  assert.equal((await admin(`/labels?ids=${sam.id}`)).status, 404);
  assert.equal((await admin(`/labels?ids=${p.id},${sam.id}`, manager)).status, 404);
  assert.equal((await admin(`/labels?ids=${p.id}`, samOwner)).status, 404);
  assert.equal((await admin(`/labels?ids=${p.id},${sam.id}`, superToken)).body.items.length, 2);
  for (const bad of ['', 'x', '0', '1.5', '99999999999', Array.from({ length: 101 }, (_, i) => i + 1).join(',')]) assert.equal((await admin(`/labels?ids=${bad}`)).status, 400, bad);
  assert.equal((await admin(`/labels?ids=${p.id},${p.id}`)).body.items.length, 1, 'a repeat is one label');
});

test('report: scanned often but rarely bought, per store scope, in the Talab window', async () => {
  await db('qr_scans').del();
  await db('fitting_requests').whereNotNull('scan_id').del();
  const [a, , b, c] = tops;
  for (const [p, n] of [[a, 5], [b, 3], [c, 1]]) for (let i = 0; i < n; i++) await scan(tashkent, p.id);
  for (let i = 0; i < 2; i++) await scan(samarkand, sam.id);
  await db('qr_scans').insert({ token: 'e'.repeat(32), store_id: tashkent, product_id: c.id, created_at: dbTime(Date.now() - 40 * 86400000) }); // outside 30 days
  // b sells 3 (scanned 3 times: fully converted), a sells 1 of 5.
  for (const p of [a, b, b, b]) {
    const cart = (await call('POST', '/api/cart/items', { store_id: tashkent, items: [{ product_id: p.id, size: 'M' }] })).body;
    const { order } = (await call('POST', `/api/cart/${cart.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '+998901234567' })).body;
    assert.equal((await call('POST', `/api/admin/orders/${order.id}/pay`, {}, { authorization: `Bearer ${manager}` })).status, 200);
  }
  const list = async (token, q = '') => (await admin(`/demand?days=30${q}`, token)).body.scans;
  const mine = await list(owner);
  assert.deepEqual(mine.map((x) => x.product_id), [a.id, c.id, b.id], 'scans − sold, most first');
  assert.deepEqual(mine.map((x) => [x.scans, x.store_id]), [[5, tashkent], [1, tashkent], [3, tashkent]], 'the 40-day-old scan is outside the window');
  assert.deepEqual([mine[0].sold, mine[0].rate], [1, 20]);
  assert.deepEqual([mine[2].sold, mine[2].rate], [3, 100]);
  assert.ok(mine[0].name && mine[0].store_name);
  assert.deepEqual((await list(manager)).map((x) => x.product_id), mine.map((x) => x.product_id), 'a manager sees their store');
  // Isolation: the other organisation sees only its own; ?store_id can't widen it; the super-admin sees both or narrows.
  assert.deepEqual((await list(samOwner)).map((x) => [x.product_id, x.scans]), [[sam.id, 2]]);
  assert.deepEqual(await list(samOwner, `&store_id=${tashkent}`), []);
  assert.deepEqual(await list(manager, `&store_id=${samarkand}`), []);
  assert.equal((await list(superToken)).length, 4);
  assert.deepEqual((await list(superToken, `&store_id=${samarkand}`)).map((x) => x.product_id), [sam.id]);
  assert.deepEqual((await admin('/demand?days=7', owner)).body.scans.map((x) => x.product_id), [a.id, c.id, b.id]);
});
