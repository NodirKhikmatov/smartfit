// Task 21: security headers, rate limits, open-cart cap, self-hosted vendor files, kiosk PWA, heartbeat and staff exit PIN.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb } from './helpers/db.js';
import { createApp, CSP } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { VENDOR, MODEL, fetchModel, sha256 } from '../src/vendor.js';
import { limitConfig } from '../src/limits.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
const weather = async () => ({ temperature: 12, apparent_temperature: 10, raining: false, wind_speed: 2, source: 'live' });
const servers = [];
let base, store1, store2, ownerToken, otherOwnerToken, managerToken;
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const listen = (app) => new Promise((ok) => {
  const s = app.listen(0, () => ok(`http://127.0.0.1:${s.address().port}`));
  servers.push(s);
});
const call = async (url, method = 'GET', body, headers = {}) => {
  const res = await fetch(url, { method, headers: { ...(body && { 'content-type': 'application/json' }), ...headers }, body: body && JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, body: json, text };
};
const admin = (method, p, body, token) => call(`${base}/api/admin${p}`, method, body, { authorization: `Bearer ${token}` });
const login = async (email, password) => (await call(`${base}/api/admin/login`, 'POST', { email, password })).body.token;
const freeItem = async (storeId) => db('product_stock as s').join('products as p', 'p.id', 's.product_id')
  .where('p.store_id', storeId).whereRaw('s.quantity - s.reserved >= 3').first('p.id as product_id', 's.size');

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [store1, store2] = (await db('stores').orderBy('id')).map((s) => s.id);
  await createAdmin(db, { email: 'own1@smartfit.uz', password: 'owner-pass-1', storeId: store1 });
  await createAdmin(db, { email: 'own2@smartfit.uz', password: 'owner-pass-2', storeId: store2 });
  await createAdmin(db, { email: 'man1@smartfit.uz', password: 'manager-pass', storeId: store1, role: 'manager' });
  base = await listen(createApp(db, { weather, stylist: null, telegram: null }));
  ownerToken = await login('own1@smartfit.uz', 'owner-pass-1');
  otherOwnerToken = await login('own2@smartfit.uz', 'owner-pass-2');
  managerToken = await login('man1@smartfit.uz', 'manager-pass');
});
after(async () => {
  for (const s of servers) s.close();
  await db.destroy();
});

// --- X1 headers

test('security headers on HTML and API responses; CSP is same-origin plus OSM tiles, no inline code', async () => {
  for (const p of ['/', '/landing/landing.js', '/kiosk?store=1', '/m?store=1', '/admin/', '/order/abc', '/api/health', '/api/nope', '/app/app.js', `${VENDOR.leaflet.path}/leaflet.js`]) {
    const r = await call(base + p);
    assert.equal(r.headers.get('content-security-policy'), CSP, p);
    assert.match(r.headers.get('permissions-policy'), /camera=\(self\)/, p);
    assert.ok(r.headers.get('referrer-policy'), p);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
  }
  assert.match(CSP, /frame-ancestors 'none'/);
  assert.match(CSP, /object-src 'none'/);
  assert.doesNotMatch(CSP, /'unsafe-inline'|'unsafe-eval'|\*/);
  const hosts = CSP.match(/https?:\/\/[^\s;]+/g);
  assert.deepEqual(hosts, ['https://tile.openstreetmap.org'], 'the only third-party origin is the map tiles');
  assert.equal((await call(`${base}/order/abc`)).headers.get('referrer-policy'), 'no-referrer', 'the status page keeps its stricter policy');
  assert.equal((await call(`${base}/kiosk`)).headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
});

test('no inline <script>/<style> or style="" in the product pages, and no runtime CDN URL left in browser code', () => {
  for (const p of ['public/app/index.html', 'public/app/order.html', 'public/app/profile.html', 'public/admin/index.html', 'public/landing/index.html']) {
    const html = read(p);
    assert.doesNotMatch(html, /<style|style="|<script(?![^>]*\bsrc=)/, p);
    assert.doesNotMatch(html, /\son[a-z]+="/, `${p}: inline event handler`);
  }
  for (const p of ['public/app/app.js', 'public/app/pose.js', 'public/app/kiosk.js', 'public/admin/admin.js', 'public/app/order.js', 'public/app/profile.js', 'public/landing/landing.js', 'public/landing/index.html', 'public/landing/landing.css']) {
    const urls = read(p).match(/https?:\/\/[^'"`\s)]+/g) ?? [];
    for (const u of urls) assert.match(u, /^https:\/\/(tile\.openstreetmap\.org|www\.openstreetmap\.org|t\.me)\//, `${p}: ${u}`);
  }
});

// --- X2 rate limits

test('rate limits: 429 with Retry-After per route bucket, then reset as tokens refill', async () => {
  let clock = 1_000_000;
  const url = await listen(createApp(db, { weather, stylist: null, telegram: null, limits: { recommend: 2, size: 2, cart: 3, login: 2 }, now: () => clock }));
  const rec = () => call(`${url}/api/recommend`, 'POST', { store_id: store1, gender: 'male', sizes: { top: 'M', bottom: 'M', shoes: '42' } });
  assert.equal((await rec()).status, 200);
  assert.equal((await rec()).status, 200);
  const r = await rec();
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'rate_limited');
  assert.equal(r.headers.get('retry-after'), '30', '2 per minute → one token every 30 s');
  assert.equal((await call(`${url}/api/recommend`, 'POST', {}, { 'accept-language': 'ru' })).body.error, 'Слишком много запросов. Подождите немного и повторите');
  // Other buckets are separate.
  assert.equal((await call(`${url}/api/size`, 'POST', { gender: 'male', height: 176 })).status, 200);
  clock += 30_000;
  assert.equal((await rec()).status, 200, 'one token back after Retry-After');
  assert.equal((await rec()).status, 429);
  clock += 60_000;
  assert.equal((await rec()).status, 200);
  assert.equal((await rec()).status, 200, 'refilled to the full burst');

  // Login: the bucket runs before the password check, even for right passwords.
  for (let i = 0; i < 2; i++) assert.equal((await call(`${url}/api/admin/login`, 'POST', { email: 'x@y.uz', password: 'wrong-pass' })).status, 401);
  const l = await call(`${url}/api/admin/login`, 'POST', { email: 'own1@smartfit.uz', password: 'owner-pass-1' });
  assert.equal(l.status, 429);
  assert.ok(Number(l.headers.get('retry-after')) > 0);
  // Cart: any /api/cart/* route counts.
  for (let i = 0; i < 3; i++) assert.equal((await call(`${url}/api/cart/${'0'.repeat(32)}`)).status, 404);
  assert.equal((await call(`${url}/api/cart/${'0'.repeat(32)}`)).status, 429);
});

test('limits come from env (0 = off), with defaults that leave room for a whole store on one IP', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { RATE_RECOMMEND_PER_MIN: '5', RATE_CART_PER_MIN: '0', MAX_OPEN_CARTS_PER_IP: '7', RATE_SIZE_PER_MIN: 'abc' });
    const c = limitConfig();
    assert.equal(c.recommend, 5);
    assert.equal(c.cart, 0);
    assert.equal(c.openCarts, 7);
    assert.equal(c.size, 30, 'garbage falls back to the default');
  } finally {
    process.env = saved;
  }
  const d = limitConfig();
  assert.ok(d.recommend >= 60 && d.cart >= 300 && d.openCarts >= 30 && d.login >= 10);
});

test('a normal kiosk session (five customers in a row) never meets a limit at the defaults', async () => {
  const url = await listen(createApp(db, { weather, stylist: null, telegram: null }));
  const item = await freeItem(store1);
  for (let customer = 0; customer < 5; customer++) {
    const codes = [];
    codes.push((await call(`${url}/api/stores/${store1}`)).status);
    for (let i = 0; i < 2; i++) codes.push((await call(`${url}/api/size`, 'POST', { gender: 'female', height: 165, weight: 58 })).status);
    for (let i = 0; i < 6; i++) codes.push((await call(`${url}/api/recommend`, 'POST', { store_id: store1, gender: 'female', sizes: { top: 'S', bottom: 'S', shoes: '38' } })).status);
    const cart = await call(`${url}/api/cart/items`, 'POST', { store_id: store1, items: [item] });
    codes.push(cart.status);
    for (let i = 0; i < 4; i++) codes.push((await call(`${url}/api/cart/${cart.body.token}`)).status);
    codes.push((await call(`${url}/api/cart/${cart.body.token}/extend`, 'POST', {})).status);
    codes.push((await call(`${url}/api/cart/${cart.body.token}`, 'DELETE')).status);
    codes.push((await call(`${url}/api/kiosk/ping`, 'POST', { store_id: store1, device: 'ab'.repeat(16) })).status);
    assert.ok(codes.every((c) => c < 400), `customer ${customer}: ${codes}`);
  }
});

test('open-cart cap per client IP: the next new cart is refused, a closed cart frees a slot, other IPs are unaffected', async () => {
  const url = await listen(createApp(db, { weather, stylist: null, telegram: null, trustProxy: '1', limits: { openCarts: 2 } }));
  const item = await freeItem(store1);
  const open = (ip, token) => call(`${url}/api/cart/items`, 'POST', { store_id: store1, token, items: [item] }, { 'x-forwarded-for': ip });
  const a = await open('10.0.0.1'), b = await open('10.0.0.1');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const c = await open('10.0.0.1');
  assert.equal(c.status, 429);
  assert.equal(c.body.code, 'too_many_carts');
  assert.equal((await open('10.0.0.1', a.body.token)).status, 200, 'adding to an open cart still works');
  assert.equal((await open('10.0.0.2')).status, 200, 'another client');
  assert.equal((await call(`${url}/api/cart/${b.body.token}`, 'DELETE', undefined, { 'x-forwarded-for': '10.0.0.1' })).status, 204);
  assert.equal((await open('10.0.0.1')).status, 200, 'slot freed');
  const row = await db('carts').where({ token: a.body.token }).first();
  assert.match(row.client, /^[0-9a-f]{16}$/);
  assert.notEqual(row.client, '10.0.0.1', 'the IP itself is not stored');
  // An expired cart doesn't count either.
  await db('carts').where({ token: a.body.token }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await open('10.0.0.1')).status, 200);
});

// --- X3/X4 vendor files and caching

test('vendor files: pinned MediaPipe and Leaflet same-origin with a one-year immutable cache; the client points at them', async () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.dependencies['@mediapipe/tasks-vision'], /^\d+\.\d+\.\d+$/, 'exact version');
  assert.match(pkg.dependencies.leaflet, /^\d+\.\d+\.\d+$/, 'exact version');
  assert.equal(VENDOR.mediapipe.path, `/vendor/tasks-vision@${pkg.dependencies['@mediapipe/tasks-vision']}`);
  assert.equal(VENDOR.leaflet.path, `/vendor/leaflet@${pkg.dependencies.leaflet}`);
  assert.ok(read('public/app/app.js').includes(`const LEAFLET = '${VENDOR.leaflet.path}/'`));
  for (const [p, type] of [
    [`${VENDOR.mediapipe.path}/vision_bundle.mjs`, /javascript/],
    [`${VENDOR.mediapipe.path}/wasm/vision_wasm_internal.js`, /javascript/],
    [`${VENDOR.mediapipe.path}/wasm/vision_wasm_internal.wasm`, /^application\/wasm/],
    [`${VENDOR.leaflet.path}/leaflet.js`, /javascript/],
    [`${VENDOR.leaflet.path}/leaflet.css`, /^text\/css/],
    [`${VENDOR.leaflet.path}/images/marker-icon.png`, /^image\/png/],
  ]) {
    const res = await fetch(base + p, { method: 'HEAD' });
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), type, p);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable', p);
    assert.ok(res.headers.get('etag'), p);
  }
  assert.equal((await fetch(`${base}/vendor/leaflet@0.0.1/leaflet.js`)).status, 404, 'other versions are not served');
  // Not versioned: revalidated every time (etag), never immutable.
  const html = await fetch(`${base}/kiosk`);
  assert.ok(html.headers.get('etag'));
  assert.doesNotMatch(html.headers.get('cache-control'), /immutable/);
});

test('pose model: served same-origin when downloaded; the download keeps only a file with the pinned sha256', async (t) => {
  assert.match(MODEL.url, /^https:\/\/storage\.googleapis\.com\/mediapipe-models\//);
  assert.ok(MODEL.path.includes(MODEL.sha256.slice(0, 8)), 'the path carries the checksum, so it can be immutable');
  const dir = mkdtempSync(join(tmpdir(), 'smartfit-model-'));
  const good = Buffer.from('model bytes');
  const fake = { url: 'https://example.invalid/m', sha256: sha256(good), file: join(dir, 'sub', 'm.task') };
  await assert.rejects(fetchModel({ model: fake, fetchImpl: async () => new Response('tampered') }), /checksum mismatch/);
  assert.ok(!existsSync(fake.file), 'a bad download is never kept');
  await assert.rejects(fetchModel({ model: fake, fetchImpl: async () => new Response('', { status: 503 }) }), /HTTP 503/);
  assert.equal(await fetchModel({ model: fake, fetchImpl: async () => new Response(good) }), 'downloaded');
  assert.equal(await fetchModel({ model: fake, fetchImpl: async () => { throw new Error('no network needed'); } }), 'present');

  if (!existsSync(MODEL.file)) return t.skip('run `npm run vendor` to fetch the model');
  const res = await fetch(base + MODEL.path, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(sha256(readFileSync(MODEL.file)), MODEL.sha256);
});

// --- Kiosk PWA

test('service worker: shell list has no /api/ or photo entries, every entry is served, vendor is cache-first', async () => {
  const sw = read('public/app/sw.js');
  const shell = JSON.parse(sw.match(/const SHELL = (\[[\s\S]*?\]);/)[1]);
  assert.ok(shell.length > 10);
  for (const p of shell) {
    assert.doesNotMatch(p, /^\/(api|uploads)\b/, p);
    assert.equal((await fetch(base + p, { method: 'HEAD' })).status, 200, p);
  }
  assert.ok(shell.includes('/kiosk') && shell.includes('/app/kiosk.js'));
  // Only /vendor/ and the shell list are ever handled; everything else (API, /uploads) falls through to the network.
  const code = sw.replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /url\.pathname\.startsWith\('\/vendor\/'\)/);
  assert.doesNotMatch(code, /\/api\/|\/uploads/);
  const res = await fetch(`${base}/kiosk-sw.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

test('manifest: fullscreen kiosk that starts at this store', async () => {
  const m = await call(`${base}/kiosk.webmanifest?store=${store2}`);
  assert.match(m.headers.get('content-type'), /application\/manifest\+json/);
  assert.equal(m.body.display, 'fullscreen');
  assert.equal(m.body.start_url, `/kiosk?store=${store2}`);
  assert.equal(m.body.scope, '/kiosk');
  for (const i of m.body.icons) assert.equal((await fetch(base + i.src)).status, 200, i.src);
  assert.equal((await call(`${base}/kiosk.webmanifest?store=1%22x`)).body.start_url, '/kiosk', 'only an integer store id gets in');
});

test('kiosk heartbeat: upsert per device, store-scoped online/last seen on the dashboard', async () => {
  const ping = (store_id, device) => call(`${base}/api/kiosk/ping`, 'POST', { store_id, device });
  await db('kiosks').del();
  assert.equal((await ping(store1, 'nothex!')).status, 400);
  assert.equal((await ping(999, 'cd'.repeat(16))).status, 404);
  assert.equal((await ping(store1, 'cd'.repeat(16))).status, 204);
  assert.equal((await ping(store1, 'cd'.repeat(16))).status, 204, 'same device: one row');
  assert.equal((await ping(store2, 'ef'.repeat(16))).status, 204);
  assert.equal(Number((await db('kiosks').where({ store_id: store1, device: 'cd'.repeat(16) }).count({ n: '*' }))[0].n), 1);
  await db('kiosks').insert({ store_id: store1, device: '12'.repeat(16), last_seen_at: new Date(Date.now() - 10 * 60_000).toISOString() });

  const d1 = (await admin('GET', '/dashboard', undefined, managerToken)).body.kiosks;
  assert.deepEqual(d1.map((k) => [k.id, k.online]), [['cdcdcd', true], ['121212', false]], 'newest first; 10 min silent = offline');
  assert.ok(d1.every((k) => k.store_id === store1 && !('device' in k)), 'only this store, never the full device id');
  assert.ok(Date.parse(d1[0].last_seen_at) > Date.now() - 60_000);
  const d2 = (await admin('GET', '/dashboard', undefined, otherOwnerToken)).body.kiosks;
  assert.deepEqual(d2.map((k) => k.id), ['efefef']);
});

test('kiosk heartbeat: at most 20 devices per store; week-old ones make room', async () => {
  await db('kiosks').where({ store_id: store2 }).del();
  const old = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
  await db('kiosks').insert(Array.from({ length: 20 }, (_, i) => ({ store_id: store2, device: i.toString(16).padStart(32, '0'), last_seen_at: i ? new Date().toISOString() : old })));
  assert.equal((await call(`${base}/api/kiosk/ping`, 'POST', { store_id: store2, device: 'aa'.repeat(16) })).status, 204, 'the stale one was pruned');
  assert.equal((await call(`${base}/api/kiosk/ping`, 'POST', { store_id: store2, device: 'bb'.repeat(16) })).status, 429);
  assert.equal((await call(`${base}/api/kiosk/ping`, 'POST', { store_id: store2, device: 'aa'.repeat(16) })).status, 204, 'known devices keep pinging');
});

test('staff exit PIN: set by owner only, hashed, audited without the PIN, checked by /api/kiosk/exit', async () => {
  const exit = (pin, store_id = store1) => call(`${base}/api/kiosk/exit`, 'POST', { store_id, pin });
  assert.equal((await exit('1234')).body.code, 'kiosk_pin_unset');
  assert.equal((await admin('GET', `/stores/${store1}`, undefined, ownerToken)).body.kiosk_pin_set, false);

  assert.equal((await admin('PATCH', `/stores/${store1}`, { kiosk_pin: '4821' }, managerToken)).status, 403);
  assert.equal((await admin('PATCH', `/stores/${store1}`, { kiosk_pin: '4821' }, otherOwnerToken)).status, 404);
  for (const bad of ['12', '123456789', '12a4', 4821]) assert.equal((await admin('PATCH', `/stores/${store1}`, { kiosk_pin: bad }, ownerToken)).status, 400, String(bad));
  const before = Number((await db('audit_log').count({ n: '*' }))[0].n);
  const r = await admin('PATCH', `/stores/${store1}`, { kiosk_pin: '4821' }, ownerToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.kiosk_pin_set, true);
  assert.ok(!JSON.stringify(r.body).includes('4821') && !('kiosk_pin_hash' in r.body));
  const rows = await db('audit_log').where('id', '>', 0).orderBy('id', 'desc').limit(Number((await db('audit_log').count({ n: '*' }))[0].n) - before);
  assert.deepEqual(rows.map((a) => a.action), ['store.kiosk_pin'], 'one row, and no store.update when nothing else changed');
  assert.ok(!JSON.stringify(rows).includes('4821') && !JSON.stringify(rows).includes('scrypt'), 'the audit row holds neither PIN nor hash');
  const hash = (await db('stores').where({ id: store1 }).first()).kiosk_pin_hash;
  assert.match(hash, /^scrypt\$/);
  const get = await admin('GET', `/stores/${store1}`, undefined, managerToken);
  assert.equal(get.body.kiosk_pin_set, true);
  assert.ok(!('kiosk_pin_hash' in get.body));
  // Empty = unchanged, and other edits don't touch it.
  assert.equal((await admin('PATCH', `/stores/${store1}`, { kiosk_pin: '', delivery_fee: 12000 }, ownerToken)).status, 200);
  assert.equal((await db('stores').where({ id: store1 }).first()).kiosk_pin_hash, hash);

  const bad = await exit('0000');
  assert.equal(bad.status, 403);
  assert.equal(bad.body.code, 'bad_pin');
  assert.equal((await exit(null)).status, 403);
  assert.equal((await exit('4821')).status, 204);
  assert.equal((await exit('4821', store2)).body.code, 'kiosk_pin_unset', 'a PIN is per store');
  const tries = await exit('1111');
  assert.equal(tries.status, 429, 'PIN tries have their own small bucket (5/min)');
  assert.ok(Number(tries.headers.get('retry-after')) > 0);
});

test('migration 011 down and up', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await seed(m);
    await m.migrate.down(); // 017
    await m.migrate.down(); // 016
    await m.migrate.down(); // 015
    await m.migrate.down(); // 014
    await m.migrate.down(); // 013
    await m.migrate.down(); // 012
    await m.migrate.down(); // 011
    assert.ok(!('kiosk_pin_hash' in (await m('stores').first())));
    assert.ok((await m('products').count({ n: '*' }))[0].n > 80, 'down kept the data');
    await m.migrate.latest();
    assert.ok('kiosk_pin_hash' in (await m('stores').first()));
  } finally {
    await m.destroy();
  }
});
