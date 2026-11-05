import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { refundPaid } from '../src/cart/cart.js';
import { flushNotifications, handleUpdate, telegramConfig, telegramApi, message } from '../src/notify/telegram.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = createDb({ databaseUrl: '', sqliteFile: ':memory:' });
const BOT = { token: '123:secret-bot-token', username: 'smartfit_test_bot' };
let server, base, botServer, botBase, tashkent, samarkand, tashToken, samToken, superToken;

const call = async (method, path, body, token, at = base) => {
  const res = await fetch(at + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const login = async (email, password) => (await call('POST', '/api/admin/login', { email, password })).body.token;
const stock = (product_id, size) => db('product_stock').where({ product_id, size }).first('quantity', 'reserved');
const setStatus = (id, status, token = tashToken) => call('POST', `/api/admin/orders/${id}/status`, { status }, token);

// A fresh order of one top (size M, 3 in stock) in this store. paid: taken at the cashier.
async function order(storeId, { fulfillment = 'pickup', paid = true, at = base } = {}) {
  const p = await db('products').where({ store_id: storeId, category: 'top' }).orderBy('id').first();
  await db('product_stock').where({ product_id: p.id, size: 'M' }).update({ quantity: 3, reserved: 0 });
  const cart = await call('POST', '/api/cart/items', { store_id: storeId, items: [{ product_id: p.id, size: 'M' }] }, undefined, at);
  const body = { fulfillment, name: 'Aziz', phone: '+998901234567', ...(fulfillment === 'delivery' && { address: "Amir Temur ko'chasi 1" }) };
  const r = await call('POST', `/api/cart/${cart.body.token}/checkout`, body, undefined, at);
  assert.equal(r.status, 201);
  const token = storeId === tashkent ? tashToken : samToken;
  if (paid) assert.equal((await call('POST', `/api/admin/orders/${r.body.order.id}/pay`, {}, token)).status, 200);
  return { id: r.body.order.id, product: p.id, notify: r.body.notify };
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
  botServer = createApp(db, { weather, telegram: BOT }).listen(0);
  await Promise.all([server, botServer].map((s) => new Promise((r) => s.once('listening', r))));
  base = `http://127.0.0.1:${server.address().port}`;
  botBase = `http://127.0.0.1:${botServer.address().port}`;
  tashToken = await login('tash@smartfit.uz', 'tash-pass-1');
  samToken = await login('sam@smartfit.uz', 'sam-pass-1');
  superToken = await login('boss@smartfit.uz', 'boss-pass-1');
});
after(async () => {
  server.close();
  botServer.close();
  await db.destroy();
});

test('order list: newest first, store-scoped, filtered by status, with the allowed next steps', async () => {
  const a = await order(tashkent), b = await order(samarkand, { paid: false });
  const mine = await call('GET', '/api/admin/orders', undefined, tashToken);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.every((o) => o.store_id === tashkent));
  const row = mine.body.find((o) => o.id === a.id);
  assert.deepEqual([row.status, row.payment_status, row.telegram], ['new', 'paid', false]);
  assert.deepEqual(row.next, ['packing', 'cancelled']);
  assert.ok(Math.abs(Date.parse(row.created_at) - Date.now()) < 60_000, 'created_at is read as UTC');
  assert.ok(!mine.body.some((o) => o.id === b.id));
  const all = await call('GET', '/api/admin/orders', undefined, superToken);
  assert.ok(all.body.some((o) => o.id === a.id) && all.body.some((o) => o.id === b.id));
  assert.deepEqual(all.body.map((o) => o.id), all.body.map((o) => o.id).sort((x, y) => y - x));
  assert.ok((await call('GET', `/api/admin/orders?store_id=${samarkand}`, undefined, superToken)).body.every((o) => o.store_id === samarkand));
  assert.equal((await call('GET', `/api/admin/orders?store_id=${samarkand}`, undefined, tashToken)).body.length, 0, "a manager can't widen the scope");
  await setStatus(a.id, 'packing');
  const packing = await call('GET', '/api/admin/orders?status=packing', undefined, tashToken);
  assert.ok(packing.body.length && packing.body.every((o) => o.status === 'packing'));
  assert.equal((await call('GET', '/api/admin/orders')).status, 401);
});

test("a store manager cannot read or change another store's orders", async () => {
  const o = await order(tashkent);
  assert.equal((await call('GET', `/api/admin/orders/${o.id}`, undefined, samToken)).status, 404);
  for (const s of ['packing', 'cancelled']) assert.equal((await setStatus(o.id, s, samToken)).status, 404);
  assert.deepEqual(await db('orders').where({ id: o.id }).first('status', 'payment_status'), { status: 'new', payment_status: 'paid' });
  assert.equal((await stock(o.product, 'M')).quantity, 2, 'no restock from the foreign cancel');
  assert.equal((await setStatus(o.id, 'packing')).status, 200);
  assert.equal((await setStatus(o.id, 'packing', superToken)).status, 409, 'super-admin may act, but the step is already done');
});

test('status flow: pickup skips shipping, delivery must ship, unpaid orders only cancel', async () => {
  const p = await order(tashkent);
  assert.equal((await setStatus(p.id, 'shipping')).status, 409, 'not from new');
  assert.equal((await setStatus(p.id, 'packing')).status, 200);
  assert.equal((await setStatus(p.id, 'shipping')).status, 409, 'pickup is never on the road');
  const done = await setStatus(p.id, 'delivered');
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.status, done.body.next], ['delivered', []]);
  for (const s of ['new', 'packing', 'cancelled']) assert.equal((await setStatus(p.id, s)).status, 409, `delivered → ${s}`);

  const d = await order(tashkent, { fulfillment: 'delivery' });
  await setStatus(d.id, 'packing');
  assert.equal((await setStatus(d.id, 'delivered')).status, 409, 'delivery must go through shipping');
  assert.deepEqual((await setStatus(d.id, 'shipping')).body.next, ['delivered']);
  assert.equal((await setStatus(d.id, 'cancelled')).status, 409, 'the parcel left the store');
  assert.equal((await setStatus(d.id, 'delivered')).body.status, 'delivered');

  const u = await order(tashkent, { paid: false });
  const r = await setStatus(u.id, 'packing');
  assert.equal(r.status, 409);
  assert.match(r.body.error, /to'lov/);
  for (const bad of [undefined, 'done', 'NEW', 1]) assert.equal((await setStatus(u.id, bad)).status, 400);
  assert.equal((await setStatus(999999, 'packing')).status, 404);
});

test('cancelling: an unpaid order releases its hold, a paid one restocks exactly once', async () => {
  const u = await order(tashkent, { paid: false });
  assert.deepEqual(await stock(u.product, 'M'), { quantity: 3, reserved: 1 });
  const c = await setStatus(u.id, 'cancelled');
  assert.deepEqual([c.body.status, c.body.payment_status], ['cancelled', 'cancelled']);
  assert.deepEqual(await stock(u.product, 'M'), { quantity: 3, reserved: 0 });

  const p = await order(tashkent);
  assert.deepEqual(await stock(p.product, 'M'), { quantity: 2, reserved: 0 });
  await setStatus(p.id, 'packing');
  const cancels = await Promise.all([1, 2, 3].map(() => setStatus(p.id, 'cancelled')));
  assert.deepEqual(cancels.map((r) => r.status).sort(), [200, 409, 409]);
  assert.deepEqual(await stock(p.product, 'M'), { quantity: 3, reserved: 0 }, 'back on the shelf once');
  assert.deepEqual(await db('orders').where({ id: p.id }).first('status', 'payment_status'), { status: 'cancelled', payment_status: 'paid' }, 'money still to refund');

  // Payme refund (cancel after perform) of an order the manager already cancelled: allowed, and no second restock.
  assert.equal(await db.transaction((trx) => refundPaid(trx, p.id)), true);
  assert.equal(await db.transaction((trx) => refundPaid(trx, p.id)), false);
  assert.deepEqual(await stock(p.product, 'M'), { quantity: 3, reserved: 0 });
  assert.equal((await db('orders').where({ id: p.id }).first()).payment_status, 'cancelled');
  // A refund of a paid, still-open order restocks it itself.
  const q = await order(tashkent);
  assert.equal(await db.transaction((trx) => refundPaid(trx, q.id)), true);
  assert.deepEqual(await stock(q.product, 'M'), { quantity: 3, reserved: 0 });
});

test('parallel status clicks: only one moves the order', async () => {
  const o = await order(tashkent);
  const r = await Promise.all([1, 2, 3].map(() => setStatus(o.id, 'packing')));
  assert.deepEqual(r.map((x) => x.status).sort(), [200, 409, 409]);
});

test('checkout returns a Telegram link (and QR) only when the bot is configured', async () => {
  const off = await order(tashkent);
  assert.equal(off.notify, null);
  const on = await order(tashkent, { at: botBase });
  const token = (await db('orders').where({ id: on.id }).first()).notify_token;
  assert.match(token, /^[a-f0-9]{32}$/);
  assert.equal(on.notify.url, `https://t.me/smartfit_test_bot?start=${token}`);
  assert.match(on.notify.svg, /^<svg/);
  assert.ok(!JSON.stringify(on).includes(BOT.token), 'the bot token never reaches the browser');
});

test('Telegram: linking by /start, a message per status change, never twice, never blocking', async () => {
  const sent = [];
  let failing = null;
  const telegram = async (chat, text) => {
    if (failing) throw failing;
    sent.push({ chat, text });
  };
  const flush = () => flushNotifications(db, { telegram });
  const o = await order(tashkent, { at: botBase });
  const token = (await db('orders').where({ id: o.id }).first()).notify_token;
  await flush();
  assert.equal(sent.length, 0, 'nothing before the customer links a chat');

  const replies = [];
  const reply = async (chat, text) => replies.push({ chat, text });
  const start = (chat, text, type = 'private') => handleUpdate(db, { update_id: 1, message: { text, chat: { id: chat, type } } }, reply);
  await start(5551, `/start ${'0'.repeat(32)}`);
  await start(5551, '/start');
  assert.equal(replies.length, 2);
  assert.match(replies[0].text, /topilmadi/);
  await start(5551, `/start ${token}`, 'group');
  await start(5551, `/start ${token}`);
  assert.equal(replies.length, 2, 'a good link gets the status message, not a reply');
  await start(7777, `/start ${token}`);
  assert.match(replies.at(-1).text, /boshqa Telegram/, 'the first chat keeps the order');

  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, 5551);
  assert.match(sent[0].text, new RegExp(`№${o.id} to'landi`));
  await flush();
  assert.equal(sent.length, 1, 'no repeat without a change');

  assert.equal((await setStatus(o.id, 'packing')).status, 200);
  await flush();
  assert.match(sent.at(-1).text, /yig'ilmoqda/);

  // Telegram down: the status change still succeeds, and the message goes out on the next round.
  failing = Object.assign(new Error('fetch failed'), { code: undefined });
  assert.equal((await setStatus(o.id, 'delivered')).status, 200);
  await flush();
  assert.equal(sent.length, 2);
  failing = null;
  await flush();
  assert.match(sent.at(-1).text, /topshirildi/);
  assert.equal(sent.length, 3);

  // Customer blocked the bot (403): the chat is dropped and the loop stops trying.
  const b = await order(tashkent, { at: botBase });
  await db('orders').where({ id: b.id }).update({ telegram_chat_id: 6000 });
  failing = Object.assign(new Error('sendMessage failed: 403'), { code: 403 });
  await flush();
  assert.equal((await db('orders').where({ id: b.id }).first()).telegram_chat_id, null);
  failing = null;
  await flush();
  assert.ok(!sent.some((m) => m.chat === 6000));
});

test('message texts: number, total, pickup vs delivery wording, refund note', () => {
  const o = { id: 7, store_name: 'Smart Fit Toshkent', total: 1250000, fulfillment: 'delivery' };
  assert.match(message({ ...o, status: 'new', payment_status: 'pending' }), /№7 qabul qilindi\. Jami: 1 250 000 so'm/);
  assert.match(message({ ...o, status: 'shipping', payment_status: 'paid' }), /yo'lda/);
  assert.match(message({ ...o, status: 'delivered', payment_status: 'paid' }), /yetkazildi/);
  assert.match(message({ ...o, status: 'delivered', payment_status: 'paid', fulfillment: 'pickup' }), /topshirildi/);
  assert.match(message({ ...o, status: 'cancelled', payment_status: 'paid' }), /pul qaytariladi/);
  assert.doesNotMatch(message({ ...o, status: 'cancelled', payment_status: 'cancelled' }), /pul/);
});

test('Telegram config and API errors', async () => {
  assert.equal(telegramConfig({}), null);
  assert.equal(telegramConfig({ TELEGRAM_BOT_TOKEN: 'x' }), null, 'username needed for the link');
  assert.deepEqual(telegramConfig({ TELEGRAM_BOT_TOKEN: ' t ', TELEGRAM_BOT_USERNAME: '@my_bot' }), { token: 't', username: 'my_bot' });
  assert.equal(telegramConfig({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_BOT_USERNAME: 'bad name/x' }), null);
  const calls = [];
  const api = telegramApi('123:SECRET', async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { json: async () => (calls.length === 1 ? { ok: true, result: { message_id: 1 } } : { ok: false, error_code: 403 }), status: 200 };
  });
  assert.deepEqual(await api('sendMessage', { chat_id: 1, text: 'hi' }), { message_id: 1 });
  assert.equal(calls[0].url, 'https://api.telegram.org/bot123:SECRET/sendMessage');
  const err = await api('sendMessage', { chat_id: 1, text: 'hi' }).catch((e) => e);
  assert.equal(err.code, 403);
  assert.ok(!err.message.includes('SECRET'));
});
