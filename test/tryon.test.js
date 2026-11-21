// Task 41: AI try-on with a fake provider. Off without a key; the store switch (audited, org-scoped) and its daily
// counter; consent every time; which items qualify (raster photo, adult outerwear/top/bottom, in stock, this shop);
// the daily, per-IP, parallel and size limits; timeout and provider errors; nothing on disk, in the DB or in the logs;
// no button for a child; and the FASHN adapter against a fake fetch, as the documentation describes the API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, tableNames } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { createFashn, TRYON_PARALLEL } from '../src/tryon.js';
import { tryonGarment, tryonItem } from '../public/app/flow.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
const uploadDir = mkdtempSync(join(tmpdir(), 'smartfit-tryon-'));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 3)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 5)]);
const photoOf = (n = 2000) => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(n, 9)]).toString('base64');
const PHOTO = photoOf();
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });

// The fake provider: behaviour set per test; it records what it was given.
let mode = 'ok', seen = [], gateP = null;
const fake = {
  name: 'FASHN',
  async tryOn(input, signal) {
    seen.push({ ...input, signal });
    if (mode === 'error') throw new Error('fashn PoseError');
    if (mode === 'echo') throw new Error(`provider said: ${input.person}`); // must never reach a log
    if (mode === 'hang' || mode === 'gate') {
      await new Promise((resolve, reject) => {
        if (mode === 'gate') gateP.then(resolve);
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return JPEG;
    }
    if (mode === 'junk') return Buffer.from('not an image');
    return JPEG;
  },
};

let servers = [], base, offBase, tightBase, slowBase, store, other, top, svgTop, kidTop, otherTop, token, ownerB;
const listen = async (app) => {
  const s = app.listen(0);
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${s.address().port}`;
};
const call = async (method, path, body, { auth, at = base, raw } = {}) => {
  const res = await fetch(at + path, { method, headers: { 'content-type': 'application/json', ...(auth && { authorization: `Bearer ${auth}` }) }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, type, cache: res.headers.get('cache-control'), body: type.startsWith('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const tryon = (extra = {}, at = base) => call('POST', '/api/tryon', { store_id: store, product_id: top.id, photo: PHOTO, consent: true, ...extra }, { at });
const admin = (method, path, body, auth = token) => call(method, `/api/admin${path}`, body, { auth });
const setStore = (id, v) => db('stores').where({ id }).update(v);
const used = async (id = store) => Number((await db('tryon_usage').where({ store_id: id, day: today() }).first())?.count ?? 0);

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [store, other] = (await db('stores').orderBy('id').select('id')).map((s) => s.id);
  // One adult top with a real (raster) photo, one adult top still on its SVG drawing, a child's top with a photo.
  const tops = (sid, audience) => db('products as p').where({ 'p.store_id': sid, 'p.category': 'top', 'p.audience': audience })
    .whereExists(db('product_stock as s').whereRaw('s.product_id = p.id').whereRaw('s.quantity - s.reserved > 0')).orderBy('p.id').select('p.*');
  const [a, b] = await tops(store, 'adult');
  [top, svgTop, kidTop, otherTop] = [a, b, (await tops(store, 'child'))[0], (await tops(other, 'adult'))[0]];
  mkdirSync(join(uploadDir, 'products'));
  for (const [p, buf, ext] of [[top, JPEG, 'jpg'], [kidTop, JPEG, 'jpg'], [otherTop, PNG, 'png']]) {
    p.image_url = `/uploads/products/${p.id}-0123456789abcdef.${ext}`;
    writeFileSync(join(uploadDir, 'products', `${p.id}-0123456789abcdef.${ext}`), buf);
    await db('products').where({ id: p.id }).update({ image_url: p.image_url });
  }
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  await createAdmin(db, { email: 'owner.b@smartfit.uz', password: 'owner-pass-1', storeId: other });
  const opts = { uploadDir, weather: async () => ({ temperature: 10, apparent_temperature: 10, raining: false, wind_speed: 1, source: 'live' }), stylist: null, telegram: null };
  base = await listen(createApp(db, { ...opts, tryon: fake, tryonTimeoutMs: 300, limits: { tryon: 0 } }));
  offBase = await listen(createApp(db, { ...opts, tryon: null }));
  tightBase = await listen(createApp(db, { ...opts, tryon: fake, limits: { tryon: 2 } }));
  slowBase = await listen(createApp(db, { ...opts, tryon: fake, limits: { tryon: 0 } })); // the real 45 s deadline
  token = (await call('POST', '/api/admin/login', { email: 'boss@smartfit.uz', password: 'boss-pass-1' })).body.token;
  ownerB = (await call('POST', '/api/admin/login', { email: 'owner.b@smartfit.uz', password: 'owner-pass-1' })).body.token;
});
after(async () => {
  for (const s of servers) s.close();
  await db.destroy();
  rmSync(uploadDir, { recursive: true, force: true });
});

test('off without a key: no route, no flag for the app, the admin says why', async () => {
  await setStore(store, { tryon_on: true });
  assert.equal((await tryon({}, offBase)).status, 404);
  assert.ok(!('tryon' in (await call('GET', `/api/stores/${store}`, undefined, { at: offBase })).body));
  const r = await call('GET', `/api/admin/stores/${store}/tryon`, undefined, { auth: token, at: offBase });
  assert.equal(r.body.available, false);
  assert.equal((await admin('GET', `/stores/${store}/tryon`)).body.available, true, 'the server with a key');
  assert.equal(createFashn({ apiKey: '' }), null);
  assert.equal(createFashn({ apiKey: '  '.trim() }), null);
});

test('the store switch: off by default, audited, validated; only then the app gets the provider name', async () => {
  await setStore(store, { tryon_on: false });
  const s = (await admin('GET', `/stores/${store}`)).body;
  assert.deepEqual([s.tryon_on, s.tryon_daily_limit], [false, 30]);
  assert.ok(!('tryon' in (await call('GET', `/api/stores/${store}`)).body), 'off: the store answer is as before');
  assert.equal((await tryon()).status, 403);
  for (const bad of [{ tryon_on: 'yes' }, { tryon_daily_limit: 0 }, { tryon_daily_limit: 1001 }, { tryon_daily_limit: 2.5 }]) {
    assert.equal((await admin('PATCH', `/stores/${store}`, bad)).status, 400, JSON.stringify(bad));
  }
  const r = await admin('PATCH', `/stores/${store}`, { tryon_on: true, tryon_daily_limit: 50 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.tryon_on, r.body.tryon_daily_limit], [true, 50]);
  const row = await db('audit_log').where({ action: 'store.update', entity_id: store }).orderBy('id', 'desc').first();
  const after = typeof row.after === 'string' ? JSON.parse(row.after) : row.after; // Postgres parses JSON columns
  assert.deepEqual([after.tryon_on, after.tryon_daily_limit], [true, 50]);
  assert.equal((await call('GET', `/api/stores/${store}`)).body.tryon, 'FASHN');
});

test('consent every time, a strict body and a JPEG photo', async () => {
  await setStore(store, { tryon_on: true, tryon_daily_limit: 100 });
  const before = await used();
  for (const consent of [undefined, false, 'true', 1]) {
    const r = await tryon({ consent });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'tryon_consent');
  }
  for (const bad of [{ image: PHOTO }, { photo: PHOTO.slice(23) }, { photo: 'data:image/png;base64,' + PNG.toString('base64') }, { photo: '' }, { photo: 'data:image/jpeg;base64,' + Buffer.alloc(40, 1).toString('base64') }]) {
    assert.equal((await tryon(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await call('POST', '/api/tryon', null, { raw: '[1]' })).status, 400);
  assert.equal((await tryon({ photo: photoOf(1_200_000) })).status, 400, 'over the photo cap');
  assert.equal((await tryon({ photo: photoOf(1_300_000) })).status, 400, 'over the photo cap (task 58 raised the JSON limit for drawn garments)');
  assert.equal((await tryon({ photo: photoOf(2_800_000) })).status, 413, 'over the JSON limit');
  assert.equal(await used(), before, 'nothing refused was counted');
});

test('a picture: the photo and the garment photo go to the provider, the bytes come back and are not kept', async () => {
  await setStore(store, { tryon_on: true, tryon_daily_limit: 100 });
  mode = 'ok';
  seen = [];
  const before = await used();
  const r = await tryon();
  assert.equal(r.status, 200);
  assert.equal(r.type, 'image/jpeg');
  assert.equal(r.cache, 'no-store');
  assert.ok(r.body.equals(JPEG));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].person, PHOTO);
  assert.equal(seen[0].garment, 'data:image/jpeg;base64,' + JPEG.toString('base64'));
  assert.equal(seen[0].category, 'tops');
  assert.equal(await used(), before + 1);
  const days = (await admin('GET', `/stores/${store}/tryon`)).body.days;
  assert.equal(days.length, 14);
  assert.deepEqual(days[0], { day: today(), count: before + 1 });
  // A PNG garment goes as PNG (the other store's top), counted for that store only.
  await setStore(other, { tryon_on: true });
  const o = await tryon({ store_id: other, product_id: otherTop.id });
  assert.equal(o.status, 200);
  assert.match(seen[1].garment, /^data:image\/png;base64,/);
  assert.equal(await used(other), 1);
  assert.equal(await used(), before + 1);
});

test('only an in-stock adult outerwear/top/bottom of this shop with a raster photo', async () => {
  await setStore(store, { tryon_on: true, tryon_daily_limit: 100 });
  const before = await used();
  assert.equal((await tryon({ product_id: svgTop.id })).status, 404, 'an SVG drawing');
  assert.equal((await tryon({ product_id: kidTop.id })).status, 404, "a child's item, even with a photo");
  assert.equal((await tryon({ product_id: otherTop.id })).status, 404, "another shop's item");
  assert.equal((await tryon({ product_id: 99999 })).status, 404);
  assert.equal((await tryon({ store_id: 99999 })).status, 404);
  const shoe = await db('products').where({ store_id: store, category: 'shoes', audience: 'adult' }).first();
  await db('products').where({ id: shoe.id }).update({ image_url: top.image_url });
  assert.equal((await tryon({ product_id: shoe.id })).status, 404, 'shoes are not a try-on garment');
  await db('products').where({ id: shoe.id }).update({ image_url: shoe.image_url });
  const stock = await db('product_stock').where({ product_id: top.id });
  await db('product_stock').where({ product_id: top.id }).update({ reserved: db.ref('quantity') });
  assert.equal((await tryon()).status, 404, 'sold out: never offered');
  for (const s of stock) await db('product_stock').where({ id: s.id }).update({ reserved: s.reserved });
  assert.equal(await used(), before);
  // The same rule in the browser (flow.js is shared with the server).
  assert.equal(tryonGarment(top), true);
  assert.equal(tryonGarment({ ...top, image_url: '/uploads/products/1-a.svg' }), false);
  assert.equal(tryonGarment({ ...top, image_url: '/uploads/products/../x.jpg' }), false);
  assert.equal(tryonGarment({ ...top, audience: 'child' }), false);
  assert.equal(tryonGarment({ ...top, category: 'accessory' }), false);
  assert.equal(tryonGarment({ ...top, category: null }), false, 'a role-less shop category');
});

test('the daily limit: a conditional count, then 429 and no button for the rest of the day', async () => {
  mode = 'ok';
  await db('tryon_usage').where({ store_id: store }).del();
  await setStore(store, { tryon_on: true, tryon_daily_limit: 3 });
  const rs = await Promise.all(Array.from({ length: 5 }, () => tryon()));
  assert.equal(rs.filter((r) => r.status === 200).length, 3, 'never more than the limit, even in parallel');
  assert.ok(rs.filter((r) => r.status !== 200).every((r) => [403, 429].includes(r.status)));
  assert.equal(await used(), 3);
  const r = await tryon();
  assert.equal(r.status, 403, 'the on/off check sees the limit first');
  assert.ok(!('tryon' in (await call('GET', `/api/stores/${store}`)).body), 'the app hides the button');
  await setStore(store, { tryon_daily_limit: 4 });
  assert.equal((await call('GET', `/api/stores/${store}`)).body.tryon, 'FASHN');
});

test('per-IP rate limit and the parallel cap', async () => {
  mode = 'ok';
  await setStore(store, { tryon_on: true, tryon_daily_limit: 1000 });
  const rs = [];
  for (let i = 0; i < 3; i++) rs.push((await tryon({}, tightBase)).status);
  assert.deepEqual(rs, [200, 200, 429]);
  mode = 'gate';
  seen = [];
  let release;
  gateP = new Promise((r) => (release = r));
  const waiting = Array.from({ length: TRYON_PARALLEL }, () => tryon({}, slowBase));
  while (seen.length < TRYON_PARALLEL) await new Promise((r) => setTimeout(r, 5));
  const busy = await tryon({}, slowBase);
  assert.equal(busy.status, 429);
  assert.equal(busy.body.code, 'tryon_busy');
  release();
  assert.deepEqual((await Promise.all(waiting)).map((r) => r.status), Array(TRYON_PARALLEL).fill(200));
  assert.equal((await tryon({}, slowBase)).status, 200, 'free again');
  mode = 'ok';
  seen = [];
});

test('timeout and provider errors give a short error and the reason only in the log; a closed request aborts', async () => {
  await setStore(store, { tryon_on: true, tryon_daily_limit: 1000 });
  const logged = [];
  const saved = console.warn;
  console.warn = (...a) => logged.push(a);
  try {
    mode = 'hang';
    seen = [];
    const t = await tryon();
    assert.equal(t.status, 504);
    assert.equal(t.body.code, 'tryon_failed');
    assert.equal(seen[0].signal.aborted, true, 'the provider call is aborted at the deadline');
    mode = 'error';
    const e = await tryon();
    assert.equal(e.status, 502);
    mode = 'junk';
    assert.equal((await tryon()).status, 502, 'not an image');
  } finally {
    console.warn = saved;
  }
  assert.deepEqual(logged.map(([x]) => x), [{ msg: 'tryon failed', reason: 'timeout' }, { msg: 'tryon failed', reason: 'fashn PoseError' }, { msg: 'tryon failed', reason: 'fashn bad output' }]);
  // The customer leaves while waiting: the request is aborted and the provider polling stops.
  mode = 'hang';
  seen = [];
  const ac = new AbortController();
  const p = fetch(`${base}/api/tryon`, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: store, product_id: top.id, photo: PHOTO, consent: true }) }).catch(() => null);
  while (!seen.length) await new Promise((r) => setTimeout(r, 5));
  ac.abort();
  await p;
  for (let i = 0; i < 50 && !seen[0].signal.aborted; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen[0].signal.aborted, true);
  mode = 'ok';
});

test('no photo or picture reaches disk, the DB or the logs (the task 6 check, extended)', async () => {
  await setStore(store, { tryon_on: true, tryon_daily_limit: 1000 });
  const filesBefore = readdirSync(join(uploadDir, 'products')).sort();
  const logged = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const saved = methods.map((m) => console[m]);
  for (const m of methods) console[m] = (...a) => logged.push(a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  try {
    for (const m of ['ok', 'echo', 'error', 'junk', 'hang']) {
      mode = m;
      await tryon();
    }
    await tryon({ consent: false });
    await tryon({ photo: photoOf(1_200_000) });
  } finally {
    methods.forEach((m, i) => (console[m] = saved[i]));
    mode = 'ok';
  }
  const leak = (s) => /data:image|base64|[A-Za-z0-9+/=]{200,}|\/9j\//.test(s);
  assert.ok(logged.length >= 3, 'the failures were logged');
  for (const line of logged) assert.ok(!leak(line), `log line: ${line.slice(0, 160)}`);
  for (const t of await tableNames(db)) {
    for (const row of await db(t)) for (const [col, v] of Object.entries(row)) assert.ok(!(typeof v === 'string' && leak(v)), `${t}.${col}`);
  }
  assert.deepEqual(Object.keys(await db('tryon_usage').first()).sort(), ['count', 'day', 'store_id'], 'counts per day only');
  assert.deepEqual(readdirSync(uploadDir).sort(), ['products']);
  assert.deepEqual(readdirSync(join(uploadDir, 'products')).sort(), filesBefore, 'nothing written');
});

test('org scoping of the setting and the counter', async () => {
  // owner.b runs the other store's organisation: it sees its own counter, never this store's, and can't switch it.
  assert.equal((await admin('GET', `/stores/${other}/tryon`, undefined, ownerB)).status, 200);
  assert.equal((await admin('GET', `/stores/${store}/tryon`, undefined, ownerB)).status, 404);
  const before = (await db('stores').where({ id: store }).first()).tryon_on;
  assert.equal((await admin('PATCH', `/stores/${store}`, { tryon_on: !before }, ownerB)).status, 404);
  assert.equal((await db('stores').where({ id: store }).first()).tryon_on, before);
});

test("the child path never gets the button: no garment of a child's, outfits of a child's result skipped", () => {
  const app = readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(!lastResult\?\.audience\) c\.querySelector\('\.outfit-foot'\)\.append\(tryon\.button\(o\.items\)\)/);
  assert.match(app, /tryon\.clear\(\); \/\/ the photo and the picture go before anything else/, 'the kiosk reset clears it');
  assert.match(app, /track\(name\);\n {2}tryon\.clear\(\);/, 'every screen change (Boshiga too) clears it');
  const outfit = [{ ...top, category: 'bottom', id: 2 }, { ...top, id: 1 }, { ...top, category: 'shoes', id: 3 }];
  assert.equal(tryonItem(outfit).id, 1, 'the top over the bottom');
  assert.equal(tryonItem([{ ...top, category: 'outerwear', id: 4 }, ...outfit]).id, 4, 'outerwear first');
  assert.equal(tryonItem(outfit.map((p) => ({ ...p, audience: 'child' }))), null);
  assert.equal(tryonItem([{ ...top, image_url: '/uploads/products/x.svg' }]), null);
});

// The adapter against a fake fetch: exactly the calls the FASHN documentation describes.
test('FASHN adapter: run, poll status, base64 output; errors and abort', async () => {
  const calls = [];
  const replies = [];
  const fetch = async (url, init) => {
    calls.push({ url, ...init, body: init.body && JSON.parse(init.body) });
    const [status, body] = replies.shift();
    return { ok: status < 300, status, json: async () => body };
  };
  const f = createFashn({ apiKey: 'fa-test-key', fetch, pollMs: 1 });
  assert.equal(f.name, 'FASHN');
  const out = 'data:image/jpeg;base64,' + JPEG.toString('base64');
  replies.push([200, { id: 'abc-1', error: null }], [200, { id: 'abc-1', status: 'in_queue' }], [200, { id: 'abc-1', status: 'processing' }], [200, { id: 'abc-1', status: 'completed', output: [out], error: null }]);
  const pic = await f.tryOn({ person: PHOTO, garment: 'data:image/png;base64,AAAA', category: 'tops' });
  assert.ok(pic.equals(JPEG));
  assert.equal(calls[0].url, 'https://api.fashn.ai/v1/run');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, 'Bearer fa-test-key');
  assert.deepEqual(calls[0].body, { model_name: 'tryon-v1.6', inputs: { model_image: PHOTO, garment_image: 'data:image/png;base64,AAAA', category: 'tops', mode: 'balanced', num_samples: 1, output_format: 'jpeg', return_base64: true } });
  assert.deepEqual(calls.slice(1).map((c) => [c.method, c.url]), Array(3).fill(['GET', 'https://api.fashn.ai/v1/status/abc-1']));
  replies.push([200, { id: 'x', error: null }], [200, { id: 'x', status: 'failed', error: { name: 'PoseError', message: 'no body' } }]);
  await assert.rejects(f.tryOn({ person: PHOTO, garment: PHOTO, category: 'tops' }), { message: 'fashn PoseError' });
  replies.push([429, { error: 'OutOfCredits', message: 'x' }]);
  await assert.rejects(f.tryOn({ person: PHOTO, garment: PHOTO, category: 'tops' }), { message: 'fashn http 429' });
  replies.push([200, { id: 'y', error: null }], [200, { id: 'y', status: 'completed', output: ['https://cdn.fashn.ai/y/output_0.jpg'] }]);
  await assert.rejects(f.tryOn({ person: PHOTO, garment: PHOTO, category: 'tops' }), { message: 'fashn bad output' }, 'only the base64 output we asked for');
  replies.push([200, { id: 'z', error: null }]);
  const ac = new AbortController();
  const slow = createFashn({ apiKey: 'k', fetch, pollMs: 10_000 });
  const p = slow.tryOn({ person: PHOTO, garment: PHOTO, category: 'bottoms' }, ac.signal);
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, { message: 'aborted' });
});
