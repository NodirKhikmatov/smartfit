import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { watchIdle, IDLE_MS } from '../public/app/idle.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
const weather = { temperature: 12, apparent_temperature: 10, raining: true, wind_speed: 4, source: 'live' };
let server, base, tashkent, samarkand, superToken, tashToken;

const get = async (path, token) => {
  const res = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
};
const login = async (email, password) =>
  (await (await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).token;

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [tashkent, samarkand] = (await db('stores').orderBy('id')).map((s) => s.id);
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'super-pass-1' });
  await createAdmin(db, { email: 'tash@smartfit.uz', password: 'tash-pass-1', storeId: tashkent });
  server = createApp(db, { weather: async () => weather }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  superToken = await login('boss@smartfit.uz', 'super-pass-1');
  tashToken = await login('tash@smartfit.uz', 'tash-pass-1');
});
after(async () => {
  server.close();
  await db.destroy();
});

test('kiosk idle reset fires after 90 s without activity, and activity postpones it', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const target = new EventTarget();
    let resets = 0;
    const stop = watchIdle(target, { onIdle: () => resets++ });
    assert.equal(IDLE_MS, 90_000);

    mock.timers.tick(89_999);
    assert.equal(resets, 0);
    target.dispatchEvent(new Event('pointerdown')); // customer touches the screen: the 90 s restart
    mock.timers.tick(89_999);
    assert.equal(resets, 0);
    target.dispatchEvent(new Event('keydown'));
    mock.timers.tick(90_000);
    assert.equal(resets, 1, 'reset after 90 s idle');
    mock.timers.tick(10 * 90_000);
    assert.equal(resets, 1, 'fires once per idle period, not in a loop');

    target.dispatchEvent(new Event('input'));
    mock.timers.tick(90_000);
    assert.equal(resets, 2, 'the next customer gets their own reset');

    stop();
    target.dispatchEvent(new Event('pointerdown'));
    mock.timers.tick(90_000);
    assert.equal(resets, 2, 'stopped watcher never fires');
  } finally {
    mock.timers.reset();
  }
});

test('/kiosk and /m serve the same customer app and its scripts', async () => {
  const kiosk = await get(`/kiosk?store=${tashkent}`);
  const mobile = await get(`/m?store=${tashkent}`);
  assert.equal(kiosk.status, 200);
  assert.match(kiosk.type, /text\/html/);
  assert.equal(kiosk.text, mobile.text);
  assert.match(kiosk.text, /src="\/app\/app\.js"/);
  for (const f of ['app.js', 'idle.js']) {
    const r = await get(`/app/${f}`);
    assert.equal(r.status, 200, f);
    assert.match(r.type, /javascript/);
  }
  assert.equal((await get('/app/')).status, 404, 'no directory index');
});

test('GET /api/stores/:id gives the start screen its store name, weather and in-stock look photos', async () => {
  const r = await get(`/api/stores/${tashkent}`);
  assert.equal(r.status, 200);
  const { looks, categories, offers, ...rest } = JSON.parse(r.text);
  assert.deepEqual(offers.map((o) => o.title), ['Qishki kurtkalar −20%'], 'task 43: the shop\'s own current offers');
  assert.deepEqual(rest, { id: tashkent, name: 'Smart Fit Toshkent', city: 'Toshkent', weather, profile: false }); // no bot → no profile (task 27)
  assert.deepEqual(categories.map((c) => c.role), ['outerwear', 'top', 'bottom', 'shoes', 'accessory', 'outerwear', 'top', 'bottom', 'shoes'], 'task 36: the shop\'s categories in order');
  assert.deepEqual(categories.map((c) => c.audience), [...Array(5).fill('adult'), ...Array(4).fill('child')], 'task 40: then the children\'s ones');
  assert.deepEqual(looks.map((l) => l.category), ['outerwear', 'top', 'bottom', 'shoes'], 'one photo per main category');
  for (const l of looks) {
    const p = await db('products').where({ store_id: tashkent, image_url: l.image_url }).first();
    assert.ok(p.temp_min <= weather.temperature && p.temp_max >= weather.temperature, `${p.name} suits ${weather.temperature} °C`);
    const free = await db('product_stock').where({ product_id: p.id }).sum({ n: db.raw('quantity - reserved') }).first();
    assert.ok(Number(free.n) > 0, `${p.name} is in stock`);
  }
  // Sold out (or fully held by carts): never on the attract screen.
  const coat = await db('products').where({ store_id: tashkent, image_url: looks[0].image_url }).first();
  const saved = await db('product_stock').where({ product_id: coat.id }).select('id', 'reserved');
  await db('product_stock').where({ product_id: coat.id }).update({ reserved: db.ref('quantity') });
  try {
    const again = JSON.parse((await get(`/api/stores/${tashkent}`)).text).looks;
    assert.ok(!again.some((l) => l.image_url === coat.image_url), 'a fully reserved item is not shown');
  } finally {
    for (const s of saved) await db('product_stock').where({ id: s.id }).update({ reserved: s.reserved });
  }
  for (const bad of ['999999', 'abc', '0', '-1', '1.5']) assert.equal((await get(`/api/stores/${bad}`)).status, 404, bad);
});

test('GET /api/stores lists every store for the picker: id, name and city only', async () => {
  const r = await get('/api/stores');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), [
    { id: tashkent, name: 'Smart Fit Toshkent', city: 'Toshkent' },
    { id: samarkand, name: 'Smart Fit Samarqand', city: 'Samarqand' },
  ]);
});

test('admin QR: SVG that opens /m for the store, scoped to the manager store', async () => {
  const r = await get(`/api/admin/stores/${tashkent}/qr`, superToken);
  assert.equal(r.status, 200);
  const q = JSON.parse(r.text);
  assert.equal(q.url, `${base}/m?store=${tashkent}`);
  assert.equal(q.name, 'Smart Fit Toshkent');
  assert.match(q.svg, /^<svg [^>]*viewBox/);
  assert.ok(!/<script|on\w+=/i.test(q.svg), 'plain SVG only');

  assert.equal((await get(`/api/admin/stores/${tashkent}/qr`, tashToken)).status, 200);
  assert.equal((await get(`/api/admin/stores/${samarkand}/qr`, tashToken)).status, 404, 'manager cannot get another store QR');
  assert.equal((await get(`/api/admin/stores/${tashkent}/qr`)).status, 401);
  assert.equal((await get('/api/admin/stores/999999/qr', superToken)).status, 404);

  process.env.PUBLIC_URL = 'https://fit.example.uz/';
  try {
    assert.equal(JSON.parse((await get(`/api/admin/stores/${samarkand}/qr`, superToken)).text).url, `https://fit.example.uz/m?store=${samarkand}`);
  } finally {
    delete process.env.PUBLIC_URL;
  }
});
