// Task 24: missed demand (deduplicated per session, no personal data), the funnel by step per day and kiosk, the
// restock suggestion, the Talab CSV, and the weekly owner report (Monday 09:00 Tashkent, outbox, retry, no chat id).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin, dayKey } from '../src/admin/routes.js';
import { restock } from '../src/demand.js';
import { reportWeek, weeklyReport, flushWeeklyReport } from '../src/notify/telegram.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, store, owner, top, other;

const call = async (method, p, body, token, lang) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...(lang && { 'accept-language': lang }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = text;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: json };
};
const admin = (method, p, body, lang) => call(method, `/api/admin${p}`, body, owner, lang);
const setStock = (productId, size, quantity) => db('product_stock').where({ product_id: productId, size }).update({ quantity, reserved: 0 });
const missedRows = (where) => db('missed_demand').where(where);
const recommend = (extra = {}) => call('POST', '/api/recommend', { store_id: store, gender: 'male', sizes: { top: 'L', bottom: 'L' }, ...extra });
const PHONE = '+998907776655', NAME = 'Dilnoza Karimova';

before(async () => {
  await db.migrate.latest();
  await seed(db);
  store = (await db('stores').orderBy('id').first()).id;
  await createAdmin(db, { email: 'own@smartfit.uz', password: 'own-pass-1', storeId: store });
  server = createApp(db, { telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = (await admin('POST', '/login', { email: 'own@smartfit.uz', password: 'own-pass-1' })).body.token;
  [top, other] = await db('products').where({ store_id: store, category: 'top' }).whereIn('gender', ['male', 'unisex'])
    .where('temp_min', '<=', 15).where('temp_max', '>=', 15).orderBy('id').limit(2);
});
after(async () => {
  server.close();
  await db.destroy();
});

test('missed demand: once per results screen, again for a new size or a new customer, only items with 0 free stock', async () => {
  await setStock(top.id, 'L', 0);
  await setStock(top.id, 'XL', 0);
  await setStock(other.id, 'L', 5);
  const first = await recommend();
  assert.equal(first.status, 200);
  const rec = first.body.rec;
  assert.equal((await missedRows({ session: rec, product_id: top.id, size: 'L' })).length, 1);
  assert.equal((await missedRows({ session: rec, product_id: other.id })).length, 0, 'a size in stock is not missed');
  assert.ok((await missedRows({ session: rec })).every((m) => m.source === 'recommend' && m.store_id === store));
  const n = (await missedRows({ session: rec })).length;

  // The same screen asking again (rec) adds nothing; the − / + size step adds the new size only.
  assert.equal((await recommend({ rec })).body.rec, rec);
  assert.equal((await missedRows({ session: rec })).length, n, 'deduplicated per session');
  await recommend({ rec, sizes: { top: 'XL', bottom: 'L' } });
  assert.equal((await missedRows({ session: rec, product_id: top.id, size: 'XL' })).length, 1);
  assert.equal((await missedRows({ session: rec, product_id: top.id })).length, 2);

  // A new customer (no rec) counts again.
  const second = (await recommend()).body.rec;
  assert.notEqual(second, rec);
  assert.equal((await missedRows({ product_id: top.id, size: 'L' })).length, 2);

  // Shoes without a size and accessories are never "missed": no size was asked for.
  assert.equal((await db('missed_demand as m').join('products as p', 'p.id', 'm.product_id').whereIn('p.category', ['shoes', 'accessory'])).length, 0);
});

test('missed demand from the cart: a sold-out size is logged once per session, and never with a phone, name or photo', async () => {
  const session = 'd'.repeat(32);
  for (let i = 0; i < 2; i++) {
    const r = await call('POST', '/api/cart/items', { store_id: store, items: [{ product_id: top.id, size: 'L' }], rec: session });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'out_of_stock');
  }
  const rows = await missedRows({ session });
  assert.deepEqual(rows.map((m) => [m.product_id, m.size, m.source]), [[top.id, 'L', 'cart']]);

  // Changing a cart line to a sold-out size counts under the cart token.
  await setStock(top.id, 'M', 3);
  const cart = (await call('POST', '/api/cart/items', { store_id: store, items: [{ product_id: top.id, size: 'M' }] })).body;
  const patch = await call('PATCH', `/api/cart/${cart.token}/items/${cart.items[0].id}`, { size: 'XL' });
  assert.equal(patch.status, 409);
  assert.equal((await missedRows({ session: cart.token, product_id: top.id, size: 'XL' })).length, 1);

  // A customer who checks out: their name and phone go to the order, never into either log.
  const done = await call('POST', `/api/cart/${cart.token}/checkout`, { fulfillment: 'pickup', name: NAME, phone: PHONE });
  assert.equal(done.status, 201);
  for (const [table, cols] of [['missed_demand', ['created_at', 'id', 'mode', 'product_id', 'session', 'size', 'source', 'store_id']], ['funnel_events', ['created_at', 'device', 'id', 'mode', 'step', 'store_id', 'visit']]]) {
    assert.deepEqual(Object.keys(await db(table).columnInfo()).sort(), cols, `${table}: no personal columns`);
    const dump = JSON.stringify(await db(table));
    assert.ok(!dump.includes('998907776655') && !dump.includes('Dilnoza'), `${table}: no phone or name`);
  }
});

test('funnel: one event per visit and step, drop-off per day and per kiosk, unknown devices count as phones', async () => {
  const bad = [[{ store_id: store, visit: 'x', step: 'start' }, 400], [{ store_id: store, visit: 'a'.repeat(32), step: 'pay' }, 400], [{ store_id: 99999, visit: 'a'.repeat(32), step: 'start' }, 404]];
  for (const [body, status] of bad) assert.equal((await call('POST', '/api/funnel', body)).status, status);

  const device = 'e'.repeat(32);
  await call('POST', '/api/kiosk/ping', { store_id: store, device });
  const send = (visit, step, dev) => call('POST', '/api/funnel', { store_id: store, visit, step, ...(dev && { device: dev }) });
  const [v1, v2, v3] = ['1', '2', '3'].map((c) => c.repeat(32));
  for (const step of ['start', 'size', 'outfits', 'cart', 'order', 'start']) assert.equal((await send(v1, step, device)).status, 204);
  for (const step of ['start', 'size']) await send(v2, step, 'f'.repeat(32)); // no heartbeat from this "kiosk"
  await send(v3, 'outfits'); // a refresh on the results screen: a new visit that starts there
  assert.equal((await db('funnel_events').where({ visit: v1 })).length, 5, 'deduplicated per visit');
  assert.equal((await db('funnel_events').where({ visit: v2 }).whereNotNull('device')).length, 0);

  const { funnel } = (await admin('GET', '/demand')).body;
  assert.deepEqual(funnel.total, { start: 3, size: 3, outfits: 2, cart: 1, order: 1 });
  const today = funnel.per_day.find((d) => d.day === dayKey(Date.now()));
  assert.deepEqual({ ...today, day: undefined }, { day: undefined, ...funnel.total });
  assert.equal(funnel.per_day.length, 14);
  const kiosk = funnel.per_kiosk.find((k) => k.kiosk === 'eeeeee');
  const phone = funnel.per_kiosk.find((k) => k.kiosk === null);
  assert.deepEqual([kiosk.start, kiosk.order, phone.start, phone.size, phone.outfits, phone.order], [1, 1, 2, 2, 1, 0]);
  assert.ok(!JSON.stringify(funnel).includes(device), 'only the short kiosk id leaves the server');
});

test('restock suggestion: missed + sold in the window − free stock, never below 0; CSV in the admin language', async () => {
  assert.equal(restock({ missed: 3, sold: 2, stock: 1 }), 4);
  assert.equal(restock({ missed: 1, sold: 0, stock: 5 }), 0);
  assert.equal(restock({ missed: 2, sold: 1, stock: -1 }), 3, 'an oversold size counts as 0, not as extra demand');

  // Sell one L of `top`, then it is sold out again.
  await setStock(top.id, 'L', 1);
  const cart = (await call('POST', '/api/cart/items', { store_id: store, items: [{ product_id: top.id, size: 'L' }] })).body;
  const { order } = (await call('POST', `/api/cart/${cart.token}/checkout`, { fulfillment: 'pickup', name: NAME, phone: PHONE })).body;
  assert.equal((await admin('POST', `/orders/${order.id}/pay`, {})).status, 200);

  const { items, days } = (await admin('GET', '/demand')).body;
  assert.equal(days, 14);
  const row = items.find((x) => x.product_id === top.id && x.size === 'L');
  const free = await db('product_stock').where({ product_id: top.id, size: 'L' }).first();
  assert.deepEqual([row.missed, row.sold, row.stock], [3, 1, free.quantity - free.reserved]); // 2 results screens + 1 cart
  assert.equal(row.suggest, Math.max(0, 3 + 1 - row.stock));
  assert.ok(items.every((x, i) => i === 0 || items[i - 1].missed >= x.missed), 'most missed first');
  assert.equal((await admin('GET', '/demand?days=7')).body.days, 7);
  assert.equal((await admin('GET', '/demand?days=5')).body.days, 14, 'other windows fall back to 14 days');

  const csv = await admin('GET', '/demand/export');
  assert.equal(csv.status, 200);
  assert.ok(csv.body.startsWith('"Kiyim";"SKU (artikul)";"Do\'kon";"O\'lcham";"So\'ralgan";"Kutmoqda";"Sotilgan";"Qoldiq";"Buyurtma qilish"'), csv.body.slice(0, 120));
  assert.ok(csv.body.includes(`"${top.name}";"${top.sku}"`) && csv.body.includes(`"L";"3";"0";"1";"${row.stock}";"${row.suggest}"`), csv.body);
  assert.ok((await admin('GET', '/demand/export', undefined, 'ru')).body.includes('"Спрашивали"'));
});

test('weekly report: due Monday 09:00 Tashkent (UTC+5), whatever the server clock zone', () => {
  const at = (s) => Date.parse(s);
  assert.equal(reportWeek(at('2026-11-09T03:59:59Z')), '2026-11-02', 'Monday 08:59 in Tashkent: last week is still the newest');
  assert.equal(reportWeek(at('2026-11-09T04:00:00Z')), '2026-11-09', 'Monday 09:00 in Tashkent');
  assert.equal(reportWeek(at('2026-11-08T20:00:00Z')), '2026-11-02', 'already Monday 01:00 in Tashkent, still Sunday in UTC');
  assert.equal(reportWeek(at('2026-11-15T18:59:59Z')), '2026-11-09', 'Sunday 23:59 in Tashkent');
  assert.equal(reportWeek(at('2026-11-15T19:00:00Z')), '2026-11-09', 'Monday 00:00 in Tashkent, before 09:00');
  assert.equal(reportWeek(at('2027-01-04T04:00:00Z')), '2027-01-04', 'across a year end');
});

test('weekly report: sent once per week, retried after a network error, never without a chat id', async () => {
  const sent = [];
  let failWith = null;
  const telegram = async (chat, text) => {
    if (failWith) throw Object.assign(new Error('down'), { code: failWith });
    sent.push({ chat, text });
  };
  const monday = Date.parse('2026-11-09T04:00:00Z');
  const week = async () => (await db('stores').where({ id: store }).first()).report_week;

  await flushWeeklyReport(db, telegram, monday);
  assert.equal(sent.length, 0, 'no chat id: nothing sent');
  assert.equal(await week(), null, 'and nothing marked');

  const set = await admin('PATCH', `/stores/${store}`, { report_chat_id: 'abc' });
  assert.equal(set.status, 400);
  assert.equal((await admin('PATCH', `/stores/${store}`, { report_chat_id: '-100123456' })).body.report_chat_id, -100123456);

  failWith = 502;
  await flushWeeklyReport(db, telegram, monday);
  assert.equal(await week(), null, 'a network error leaves it unsent');
  failWith = null;
  await flushWeeklyReport(db, telegram, monday);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, -100123456);
  assert.equal(await week(), '2026-11-09');
  await flushWeeklyReport(db, telegram, monday + 60_000);
  await flushWeeklyReport(db, telegram, monday + 3 * 86400000);
  assert.equal(sent.length, 1, 'once per week');
  assert.ok(sent[0].text.startsWith(`${(await db('stores').where({ id: store }).first()).name}: haftalik hisobot, 02.11–08.11`), sent[0].text);

  await flushWeeklyReport(db, telegram, monday + 7 * 86400000 - 1000);
  assert.equal(sent.length, 1, 'next Monday 08:59: not yet');
  failWith = 403; // the bot was removed from the chat: give up on this week instead of retrying every round
  await flushWeeklyReport(db, telegram, monday + 7 * 86400000);
  assert.equal(await week(), '2026-11-16');
  failWith = null;
  await flushWeeklyReport(db, telegram, monday + 7 * 86400000 + 5000);
  assert.equal(sent.length, 1);
});

test('weekly report text: sales, conversion, top items, missed demand top 5, low stock', async () => {
  // The week that contains now: the Monday after this one (Tashkent date).
  const local = new Date(Date.now() + 5 * 3600 * 1000);
  const next = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - ((local.getUTCDay() + 6) % 7) + 7)).toISOString().slice(0, 10);
  const s = await db('stores').where({ id: store }).first();
  const text = await weeklyReport(db, s, next);
  const lines = text.split('\n');
  assert.match(lines[1], /^Savdo: 1 ta buyurtma, [\d ]+ so'm$/);
  assert.equal(lines[2], 'Obraz: 0 ta, alohida kiyim: 0 ta, katalog: 1 ta', 'task 30: sales by how the customer chose');
  assert.equal(lines[3], 'Konversiya: 33% (3 ta tashrifdan 1 ta buyurtma)');
  assert.ok(text.includes(`Eng ko'p sotilgan:\n• ${top.name} — 1 dona`), text);
  assert.ok(text.includes(`Talab bor, lekin qolmagan (top 5):\n• ${top.name} — L: 3 marta`), text);
  assert.ok(lines.filter((l) => l.startsWith('• ') && l.includes(' marta')).length <= 5);
  assert.match(text, /Kam qolgan o'lchamlar: \d+ ta\n• .+: tugadi/);
  assert.ok(!text.includes('998907776655') && !text.includes('Dilnoza'), 'no customer data in the report');
});
