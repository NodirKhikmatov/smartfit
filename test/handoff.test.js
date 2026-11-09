// Task 17: order status page, per-store order numbers, cart hold countdown/extend, kiosk → phone handoff,
// fitting-room requests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { HANDOFF_MS } from '../src/cart/cart.js';
import { flushFitting, flushNotifications } from '../src/notify/telegram.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
delete process.env.PUBLIC_URL;
const db = testDb();
let server, base, tashkent, samarkand, tashToken, samToken, superToken;

const call = async (method, path, body, token) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const login = async (email, password) => (await call('POST', '/api/admin/login', { email, password })).body.token;
const top = (store) => db('products').where({ store_id: store, category: 'top' }).orderBy('id').first();
async function cartWith(store, size = 'M') {
  const p = await top(store);
  await db('product_stock').where({ product_id: p.id, size }).increment('quantity', 1);
  const r = await call('POST', '/api/cart/items', { store_id: store, items: [{ product_id: p.id, size }] });
  assert.equal(r.status, 200);
  return r.body;
}
const checkout = (token) => call('POST', `/api/cart/${token}/checkout`, { fulfillment: 'pickup', name: 'Aziz Karimov', phone: '+998901234567' });

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [tashkent, samarkand] = (await db('stores').orderBy('id')).map((s) => s.id);
  await createAdmin(db, { email: 'tash@smartfit.uz', password: 'tash-pass-1', storeId: tashkent });
  await createAdmin(db, { email: 'sam@smartfit.uz', password: 'sam-pass-1', storeId: samarkand });
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  const weather = async () => ({ temperature: 15, apparent_temperature: 14, raining: false, wind_speed: 3, source: 'live' });
  server = createApp(db, { weather, stylist: null, telegram: { token: '1:x', username: 'smartfit_test_bot' } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  [tashToken, samToken, superToken] = await Promise.all([
    login('tash@smartfit.uz', 'tash-pass-1'), login('sam@smartfit.uz', 'sam-pass-1'), login('boss@smartfit.uz', 'boss-pass-1'),
  ]);
});
after(async () => {
  server.close();
  await db.destroy();
});

test('per-store order numbers: 1, 2, 3… in each store, no repeats under parallel checkouts', async () => {
  await db('orders').where({}).del();
  await db('stores').update({ order_seq: 0 });
  const carts = await Promise.all([...Array(6)].map((_, i) => cartWith(i % 2 ? samarkand : tashkent)));
  const done = await Promise.all(carts.map((c) => checkout(c.token)));
  assert.ok(done.every((r) => r.status === 201));
  const numbers = (store) => done.filter((r) => r.body.order.store_id === store).map((r) => r.body.order.number).sort();
  assert.deepEqual(numbers(tashkent), [1, 2, 3]);
  assert.deepEqual(numbers(samarkand), [1, 2, 3]);
  // The cashier finds an order by its display number, inside their own store only.
  const n2 = done.find((r) => r.body.order.store_id === samarkand && r.body.order.number === 2).body.order;
  const found = await call('GET', '/api/admin/orders?number=2', undefined, samToken);
  assert.deepEqual(found.body.map((o) => o.id), [n2.id]);
  assert.equal((await call('GET', '/api/admin/orders?number=2', undefined, superToken)).body.length, 2, 'super sees both stores\' № 2');
});

test('status page: by token only, no name, phone or address; unknown token → 404', async () => {
  const c = await cartWith(tashkent);
  const r = await checkout(c.token);
  assert.match(r.body.track.url, /\/order\/[a-f0-9]{32}$/);
  assert.match(r.body.track.svg, /^<svg/);
  const token = r.body.track.url.split('/').at(-1);
  const s = await call('GET', `/api/orders/${token}`);
  assert.equal(s.status, 200);
  assert.equal(s.body.number, r.body.order.number);
  assert.deepEqual([s.body.status, s.body.payment_status, s.body.store.name], ['new', 'pending', 'Smart Fit Toshkent']);
  assert.ok(s.body.pay_ms > 14 * 60_000 && s.body.pay_ms <= 15 * 60_000, 'pay-by countdown');
  assert.equal(s.body.items.length, 1);
  assert.match(s.body.telegram, /^https:\/\/t\.me\/smartfit_test_bot\?start=/);
  const raw = JSON.stringify(s.body);
  for (const secret of ['Aziz', '998901234567', 'customer_name', 'phone']) assert.ok(!raw.includes(secret), `no ${secret}`);
  for (const key of ['id', 'address', 'lat', 'lon', 'notify_token']) assert.ok(!(key in s.body), `no ${key}`); // store.address is the shop's
  assert.equal((await call('GET', `/api/orders/${'0'.repeat(32)}`)).status, 404);
  assert.equal((await call('GET', '/api/orders/x')).status, 404);
  // Paid: the countdown goes away and the timeline moves on.
  assert.equal((await call('POST', `/api/admin/orders/${r.body.order.id}/pay`, {}, tashToken)).status, 200);
  const paid = await call('GET', `/api/orders/${token}`);
  assert.deepEqual([paid.body.payment_status, paid.body.pay_ms], ['paid', null]);
  assert.ok(paid.body.paid_at);
  // The HTML page itself: served for any token, and it never sends the token on as a Referer.
  const page = await fetch(`${base}/order/${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await page.text(), /order\.js/);
});

test('the Telegram message carries the per-store number and, with PUBLIC_URL, the status page link', async () => {
  const c = await cartWith(tashkent);
  const { body } = await checkout(c.token);
  const token = body.track.url.split('/').at(-1);
  await db('orders').where({ id: body.order.id }).update({ telegram_chat_id: 42 });
  const sent = [];
  process.env.PUBLIC_URL = 'https://fit.example.uz/';
  try {
    await flushNotifications(db, { telegram: async (chat, text) => sent.push(text) });
  } finally {
    delete process.env.PUBLIC_URL;
  }
  const mine = sent.find((t) => t.includes(token));
  assert.ok(mine, 'a message with the status link was sent');
  assert.match(mine, new RegExp(`№${body.order.number} qabul qilindi[\\s\\S]*\\nhttps://fit\\.example\\.uz/order/${token}$`));
});

test('cart hold: hold_ms for the countdown, and "extend" gives a fresh 15 minutes', async () => {
  const c = await cartWith(tashkent);
  assert.ok(c.hold_ms > 14 * 60_000 && c.hold_ms <= 15 * 60_000);
  await db('carts').where({ token: c.token }).update({ expires_at: new Date(Date.now() + 60_000).toISOString() });
  assert.ok((await call('GET', `/api/cart/${c.token}`)).body.hold_ms <= 60_000, 'one minute left');
  const ext = await call('POST', `/api/cart/${c.token}/extend`);
  assert.equal(ext.status, 200);
  assert.ok(ext.body.hold_ms > 14 * 60_000);
  assert.equal((await call('POST', `/api/cart/${'0'.repeat(32)}/extend`)).status, 404);
});

test('handoff: a one-time QR moves the cart to the phone; the kiosk copy dies; reuse and expiry fail', async () => {
  const kiosk = await cartWith(tashkent);
  const h = await call('POST', `/api/cart/${kiosk.token}/handoff`);
  assert.equal(h.status, 200);
  const url = new URL(h.body.url);
  assert.equal(url.pathname, '/m');
  assert.equal(url.searchParams.get('store'), String(tashkent));
  const handoff = url.searchParams.get('handoff');
  assert.match(handoff, /^[a-f0-9]{32}$/);
  assert.match(h.body.svg, /^<svg/);
  assert.equal(h.body.ms, HANDOFF_MS);

  const phone = await call('POST', '/api/cart/claim', { handoff });
  assert.equal(phone.status, 200);
  assert.notEqual(phone.body.token, kiosk.token);
  assert.deepEqual(phone.body.items.map((i) => i.product_id), kiosk.items.map((i) => i.product_id), 'the same cart, holds kept');
  assert.equal((await call('GET', `/api/cart/${kiosk.token}`)).status, 404, 'the kiosk copy no longer works');
  assert.equal((await call('POST', `/api/cart/${kiosk.token}/extend`)).status, 404);
  assert.equal((await call('POST', '/api/cart/claim', { handoff })).status, 404, 'single use');
  assert.equal((await call('POST', '/api/cart/claim', { handoff: 'x' })).status, 404);

  // Parallel scans: exactly one phone gets the cart.
  const again = await call('POST', `/api/cart/${phone.body.token}/handoff`);
  const tok = new URL(again.body.url).searchParams.get('handoff');
  const race = await Promise.all([1, 2, 3].map(() => call('POST', '/api/cart/claim', { handoff: tok })));
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 404, 404]);

  // Expired QR.
  const k2 = await cartWith(tashkent);
  const h2 = await call('POST', `/api/cart/${k2.token}/handoff`);
  await db('carts').where({ token: k2.token }).update({ handoff_expires_at: new Date(Date.now() - 1000).toISOString() });
  const late = await call('POST', '/api/cart/claim', { handoff: new URL(h2.body.url).searchParams.get('handoff') });
  assert.equal(late.status, 404);
  assert.equal(late.body.code, 'handoff_invalid');
  assert.equal((await call('GET', `/api/cart/${k2.token}`)).status, 200, 'an unused kiosk cart is untouched');
});

test('fitting room: request reaches admin and the store chat once, marks the suggestion tried, store-scoped', async () => {
  const r = await call('POST', '/api/recommend', { store_id: tashkent, gender: 'male', sizes: { top: 'M', bottom: 'M', shoes: '42' } });
  assert.equal(r.status, 200);
  const { rec } = r.body;
  const outfit = r.body.outfits[0];
  const items = outfit.items.filter((i) => i.size).map((i) => ({ product_id: i.id, size: i.size }));

  assert.equal((await call('POST', '/api/recommend/fitting', { rec, cabin: 0, items })).status, 400);
  assert.equal((await call('POST', '/api/recommend/fitting', { rec, cabin: 3, items: [] })).status, 400);
  assert.equal((await call('POST', '/api/recommend/fitting', { rec: 'a'.repeat(32), cabin: 3, items })).status, 404);
  const other = await top(samarkand);
  assert.equal((await call('POST', '/api/recommend/fitting', { rec, cabin: 3, items: [{ product_id: other.id, size: 'M' }] })).status, 404, 'another store\'s product');
  const soldOut = items[0];
  const before = await db('product_stock').where({ product_id: soldOut.product_id, size: soldOut.size }).first();
  await db('product_stock').where({ id: before.id }).update({ reserved: before.quantity });
  assert.equal((await call('POST', '/api/recommend/fitting', { rec, cabin: 3, items })).status, 409, 'no free stock → not offered');
  await db('product_stock').where({ id: before.id }).update({ reserved: before.reserved });
  assert.equal((await db('recommendation_logs').where({ token: rec }).first()).tried_at, null);

  const ok = await call('POST', '/api/recommend/fitting', { rec, cabin: 3, items });
  assert.equal(ok.status, 201);
  assert.ok((await db('recommendation_logs').where({ token: rec }).first()).tried_at, 'counts as tried for the pilot report');

  // Admin orders screen: own store only.
  const mine = await call('GET', '/api/admin/fitting', undefined, tashToken);
  const req = mine.body.find((f) => f.id === ok.body.id);
  assert.equal(req.cabin, 3);
  assert.deepEqual(req.items.map((i) => [i.id, i.size]), items.map((i) => [i.product_id, i.size]));
  assert.ok(req.items.every((i) => i.name && 'shelf_location' in i));
  assert.ok(!(await call('GET', '/api/admin/fitting', undefined, samToken)).body.some((f) => f.id === ok.body.id));
  assert.equal((await call('POST', `/api/admin/fitting/${ok.body.id}/done`, {}, samToken)).status, 404, 'another store can\'t close it');

  // Store chat (mocked sender): nothing without a chat id, then exactly one message.
  const sent = [];
  const telegram = async (chat, text) => sent.push({ chat, text });
  await flushFitting(db, telegram);
  assert.equal(sent.length, 0);
  await db('stores').where({ id: tashkent }).update({ telegram_chat_id: -100123 });
  await flushFitting(db, telegram);
  await flushFitting(db, telegram);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, -100123);
  assert.match(sent[0].text, /^Kabina 3/);
  assert.ok(req.items.every((i) => sent[0].text.includes(i.name)));

  assert.equal((await call('POST', `/api/admin/fitting/${ok.body.id}/done`, {}, tashToken)).status, 204);
  assert.ok(!(await call('GET', '/api/admin/fitting', undefined, tashToken)).body.some((f) => f.id === ok.body.id));

  // Flood guard: at most 3 open requests per results screen.
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/recommend/fitting', { rec, cabin: 4, items })).status, 201);
  assert.equal((await call('POST', '/api/recommend/fitting', { rec, cabin: 4, items })).status, 429);
});
