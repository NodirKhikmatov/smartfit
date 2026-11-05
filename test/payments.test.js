import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { releaseExpired, HOLD_MS } from '../src/cart/cart.js';
import { paymentConfig, paymentMethods } from '../src/cart/payments.js';

const ENV = {
  PAYME_MERCHANT_ID: 'pm-merchant', PAYME_KEY: 'pm-test-key',
  CLICK_SERVICE_ID: '111', CLICK_MERCHANT_ID: '222', CLICK_SECRET_KEY: 'click-secret',
  PUBLIC_URL: 'https://fit.example.uz/',
};
const db = testDb();
const weather = async () => ({ temperature: 5, apparent_temperature: 2, raining: false, wind_speed: 3, source: 'live' });
let server, off, base, offBase, store;

const listen = async (app) => {
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  return s;
};
before(async () => {
  await db.migrate.latest();
  await seed(db);
  store = (await db('stores').orderBy('id').first()).id;
  server = await listen(createApp(db, { weather, payments: paymentConfig(ENV) }));
  off = await listen(createApp(db, { weather, payments: paymentConfig({}) }));
  base = `http://localhost:${server.address().port}`;
  offBase = `http://localhost:${off.address().port}`;
});
after(async () => {
  server.close();
  off.close();
  await db.destroy();
});

const json = async (url, body, method = 'POST', headers = {}) => {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const stock = (product_id, size) => db('product_stock').where({ product_id, size }).first('quantity', 'reserved');
const orderRow = (id) => db('orders').where({ id }).first();

let n = 0;
// A fresh product line with 3 units of M, put in a new cart and checked out with `payment`.
async function order(payment, b = base) {
  const p = await db('products').where({ store_id: store, category: 'top' }).orderBy('id').offset(n++ % 5).first();
  await db('product_stock').where({ product_id: p.id, size: 'M' }).update({ quantity: 3, reserved: 0 });
  const cart = await json(`${b}/api/cart/items`, { store_id: store, items: [{ product_id: p.id, size: 'M' }] });
  assert.equal(cart.status, 200);
  const r = await json(`${b}/api/cart/${cart.body.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '901234567', payment });
  return { ...r, product: p.id };
}

// --- Payme
const auth = (key = ENV.PAYME_KEY) => ({ authorization: 'Basic ' + Buffer.from(`Paycom:${key}`).toString('base64') });
let rpcId = 0;
const payme = async (method, params, headers = auth()) => {
  const r = await json(`${base}/api/pay/payme`, { jsonrpc: '2.0', id: ++rpcId, method, params }, 'POST', headers);
  assert.equal(r.status, 200, 'Payme always gets HTTP 200');
  return r.body;
};
const ext = () => `pm-${Date.now()}-${++rpcId}`;

test('a provider without keys is off: hidden in the cart, refused at checkout, no callback route', async () => {
  assert.equal(paymentConfig({ PAYME_MERCHANT_ID: 'x' }).payme, null);
  assert.equal(paymentConfig({ CLICK_SERVICE_ID: '1', CLICK_MERCHANT_ID: '2' }).click, null);
  assert.deepEqual(Object.keys(paymentMethods(paymentConfig({}))), ['cashier']);
  const p = await db('products').where({ store_id: store, category: 'top' }).orderBy('id').first();
  await db('product_stock').where({ product_id: p.id, size: 'M' }).update({ quantity: 3, reserved: 0 });
  const cart = await json(`${offBase}/api/cart/items`, { store_id: store, items: [{ product_id: p.id, size: 'M' }] });
  assert.deepEqual(cart.body.payments, ['cashier']);
  const r = await json(`${offBase}/api/cart/${cart.body.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '901234567', payment: 'payme' });
  assert.equal(r.status, 400);
  assert.equal((await json(`${offBase}/api/pay/payme`, {}, 'POST', auth())).status, 404);
  assert.equal((await json(`${offBase}/api/pay/click/prepare`, {})).status, 404);
  // cashier still works there
  const ok = await json(`${offBase}/api/cart/${cart.body.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '901234567' });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body.payment, { method: 'cashier' });
});

test('checkout with Payme returns the checkout link with the server total in tiyin', async () => {
  const { status, body } = await order('payme');
  assert.equal(status, 201);
  assert.equal(body.order.payment_method, 'payme');
  const url = new URL(body.payment.url);
  assert.equal(url.origin, 'https://test.paycom.uz');
  const params = Buffer.from(url.pathname.slice(1), 'base64').toString();
  assert.equal(params, `m=pm-merchant;ac.order_id=${body.order.id};a=${body.order.total * 100};l=uz;c=https://fit.example.uz/m?store=${store}`);
});

test('Payme: auth, JSON and method errors come back as JSON-RPC errors', async () => {
  assert.equal((await payme('CheckTransaction', { id: 'x' }, auth('wrong'))).error.code, -32504);
  assert.equal((await payme('CheckTransaction', { id: 'x' }, {})).error.code, -32504);
  const bad = await fetch(`${base}/api/pay/payme`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: '{oops' });
  assert.equal(bad.status, 200);
  assert.equal((await bad.json()).error.code, -32700);
  assert.equal((await payme('Hack', {})).error.code, -32601);
  assert.equal((await payme('CheckTransaction', { id: 'nope' })).error.code, -31003);
});

test('Payme: CheckPerformTransaction checks the order and the exact amount', async () => {
  const { body: { order: o } } = await order('payme');
  assert.deepEqual((await payme('CheckPerformTransaction', { amount: o.total * 100, account: { order_id: String(o.id) } })).result, { allow: true });
  assert.equal((await payme('CheckPerformTransaction', { amount: o.total * 100 - 100, account: { order_id: o.id } })).error.code, -31001);
  assert.equal((await payme('CheckPerformTransaction', { amount: o.total, account: { order_id: o.id } })).error.code, -31001); // so'm instead of tiyin
  assert.equal((await payme('CheckPerformTransaction', { amount: o.total * 100, account: { order_id: 999999 } })).error.code, -31050);
  const { body: { order: cash } } = await order('cashier');
  assert.equal((await payme('CheckPerformTransaction', { amount: cash.total * 100, account: { order_id: cash.id } })).error.code, -31050);
});

test('Payme: create → perform pays once; duplicate perform changes nothing; cancel after perform returns the stock', async () => {
  const { body: { order: o }, product } = await order('payme');
  const id = ext();
  const params = { id, time: Date.now(), amount: o.total * 100, account: { order_id: o.id } };
  const created = (await payme('CreateTransaction', params)).result;
  assert.equal(created.state, 1);
  assert.deepEqual((await payme('CreateTransaction', params)).result, created, 'repeat create = same answer');
  assert.equal((await payme('CreateTransaction', { ...params, id: ext() })).error.code, -31008, 'one open transaction per order');

  const done = (await payme('PerformTransaction', { id })).result;
  assert.equal(done.state, 2);
  assert.equal((await orderRow(o.id)).payment_status, 'paid');
  assert.deepEqual(await stock(product, 'M'), { quantity: 2, reserved: 0 });
  assert.deepEqual((await payme('PerformTransaction', { id })).result, done, 'duplicate perform = same answer');
  assert.deepEqual(await stock(product, 'M'), { quantity: 2, reserved: 0 }, 'stock dropped once');

  const check = (await payme('CheckTransaction', { id })).result;
  assert.equal(check.state, 2);
  assert.equal(check.perform_time, done.perform_time);
  assert.equal(check.cancel_time, 0);

  const cancelled = (await payme('CancelTransaction', { id, reason: 5 })).result;
  assert.equal(cancelled.state, -2);
  assert.deepEqual((await payme('CancelTransaction', { id, reason: 5 })).result, cancelled, 'repeat cancel = same answer');
  assert.deepEqual(await stock(product, 'M'), { quantity: 3, reserved: 0 }, 'refund puts the stock back');
  const row = await orderRow(o.id);
  assert.equal(row.payment_status, 'cancelled');
  assert.equal(row.status, 'cancelled');
  assert.equal((await payme('PerformTransaction', { id })).error.code, -31008);

  const st = (await payme('GetStatement', { from: params.time - 60_000, to: Date.now() + 60_000 })).result.transactions.find((t) => t.id === id);
  assert.equal(st.amount, o.total * 100);
  assert.equal(st.state, -2);
  assert.equal(st.reason, 5);
  assert.deepEqual(st.account, { order_id: String(o.id) });
});

test('Payme: cancel before perform releases the hold; cancel after the order left the store is refused', async () => {
  const { body: { order: o }, product } = await order('payme');
  const id = ext();
  await payme('CreateTransaction', { id, time: Date.now(), amount: o.total * 100, account: { order_id: o.id } });
  assert.equal((await stock(product, 'M')).reserved, 1);
  assert.equal((await payme('CancelTransaction', { id, reason: 3 })).result.state, -1);
  assert.deepEqual(await stock(product, 'M'), { quantity: 3, reserved: 0 });
  assert.equal((await orderRow(o.id)).payment_status, 'cancelled');
  assert.equal((await payme('PerformTransaction', { id })).error.code, -31008);

  const shipped = await order('payme');
  const id2 = ext();
  await payme('CreateTransaction', { id: id2, time: Date.now(), amount: shipped.body.order.total * 100, account: { order_id: shipped.body.order.id } });
  await payme('PerformTransaction', { id: id2 });
  await db('orders').where({ id: shipped.body.order.id }).update({ status: 'shipping' });
  assert.equal((await payme('CancelTransaction', { id: id2, reason: 5 })).error.code, -31007);
  assert.equal((await payme('CheckTransaction', { id: id2 })).result.state, 2, 'refused cancel leaves it paid');
  assert.deepEqual(await stock(shipped.product, 'M'), { quantity: 2, reserved: 0 });
});

test('Payme: perform after the order expired is refused and the transaction is cancelled by timeout', async () => {
  const { body: { order: o }, product } = await order('payme');
  const id = ext();
  await payme('CreateTransaction', { id, time: Date.now(), amount: o.total * 100, account: { order_id: o.id } });
  await db('orders').where({ id: o.id }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await payme('PerformTransaction', { id })).error.code, -31008);
  const t = (await payme('CheckTransaction', { id })).result;
  assert.equal(t.state, -1);
  assert.equal(t.reason, 4);
  assert.deepEqual(await stock(product, 'M'), { quantity: 3, reserved: 0 });
});

// --- Click
const md5 = (s) => createHash('md5').update(s).digest('hex');
const form = async (path, fields) => {
  const res = await fetch(`${base}/api/pay/click/${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  assert.equal(res.status, 200);
  return res.json();
};
let clickN = 1000;
function clickFields(o, { action = 0, prepareId = '', amount = `${o.total}.00`, error = '0', trans = String(++clickN), secret = ENV.CLICK_SECRET_KEY } = {}) {
  const f = { click_trans_id: trans, service_id: ENV.CLICK_SERVICE_ID, click_paydoc_id: '77' + trans, merchant_trans_id: String(o.id), amount, action: String(action), error, error_note: 'Success', sign_time: '2026-11-06 12:00:00' };
  if (action) f.merchant_prepare_id = String(prepareId);
  f.sign_string = md5(f.click_trans_id + f.service_id + secret + f.merchant_trans_id + (action ? f.merchant_prepare_id : '') + f.amount + f.action + f.sign_time);
  return f;
}

test('checkout with Click returns the my.click.uz link', async () => {
  const { body } = await order('click');
  const url = new URL(body.payment.url);
  assert.equal(url.origin + url.pathname, 'https://my.click.uz/services/pay/');
  assert.equal(url.searchParams.get('amount'), `${body.order.total}.00`);
  assert.equal(url.searchParams.get('transaction_param'), String(body.order.id));
  assert.equal(url.searchParams.get('service_id'), '111');
});

test('Click: bad signature, wrong amount, unknown order and wrong action are refused', async () => {
  const { body: { order: o } } = await order('click');
  assert.equal((await form('prepare', clickFields(o, { secret: 'guess' }))).error, -1);
  const tampered = { ...clickFields(o), amount: '1.00' };
  assert.equal((await form('prepare', tampered)).error, -1, 'changing a signed field breaks the signature');
  assert.equal((await form('prepare', clickFields(o, { amount: `${o.total - 1000}.00` }))).error, -2);
  assert.equal((await form('prepare', clickFields({ ...o, id: 999999 }))).error, -5);
  const wrongAction = { ...clickFields(o), action: '1' }; // validly signed with the Prepare formula, but action 1
  wrongAction.sign_string = md5(wrongAction.click_trans_id + wrongAction.service_id + ENV.CLICK_SECRET_KEY + wrongAction.merchant_trans_id + wrongAction.amount + '1' + wrongAction.sign_time);
  assert.equal((await form('prepare', wrongAction)).error, -3);
  assert.equal((await form('prepare', { click_trans_id: '1' })).error, -8);
  assert.equal(await db('payment_transactions').where({ order_id: o.id }).first(), undefined, 'nothing recorded');
});

test('Click: prepare → complete pays once; duplicate complete is "already paid" and stock moves once', async () => {
  const { body: { order: o }, product } = await order('click');
  const trans = String(++clickN);
  const prep = await form('prepare', clickFields(o, { trans }));
  assert.equal(prep.error, 0);
  assert.ok(prep.merchant_prepare_id > 0);
  assert.equal((await form('prepare', clickFields(o, { trans }))).merchant_prepare_id, prep.merchant_prepare_id, 'repeat prepare = same id');
  assert.equal((await form('complete', clickFields(o, { trans, action: 1, prepareId: prep.merchant_prepare_id + 999 }))).error, -6);

  const done = await form('complete', clickFields(o, { trans, action: 1, prepareId: prep.merchant_prepare_id, amount: String(o.total) }));
  assert.equal(done.error, 0);
  assert.equal(done.merchant_confirm_id, prep.merchant_prepare_id);
  assert.equal((await orderRow(o.id)).payment_status, 'paid');
  assert.deepEqual(await stock(product, 'M'), { quantity: 2, reserved: 0 });

  assert.equal((await form('complete', clickFields(o, { trans, action: 1, prepareId: prep.merchant_prepare_id }))).error, -4);
  assert.deepEqual(await stock(product, 'M'), { quantity: 2, reserved: 0 }, 'stock dropped once');
  assert.equal((await form('prepare', clickFields(o))).error, -4, 'a paid order takes no new payment');
});

test('Click: a failed payment (error < 0 on complete) cancels the order and releases the hold', async () => {
  const { body: { order: o }, product } = await order('click');
  const trans = String(++clickN);
  const prep = await form('prepare', clickFields(o, { trans }));
  const r = await form('complete', clickFields(o, { trans, action: 1, prepareId: prep.merchant_prepare_id, error: '-5017' }));
  assert.equal(r.error, -9);
  assert.deepEqual(await stock(product, 'M'), { quantity: 3, reserved: 0 });
  assert.equal((await orderRow(o.id)).payment_status, 'cancelled');
  assert.equal((await form('complete', clickFields(o, { trans, action: 1, prepareId: prep.merchant_prepare_id }))).error, -9, 'no completing a cancelled one');
});

test('an unpaid online order expires after 15 min: stock comes back and the open transaction is cancelled', async () => {
  const { body: { order: o }, product } = await order('click');
  const prep = await form('prepare', clickFields(o));
  const row = await orderRow(o.id);
  assert.equal((await stock(product, 'M')).reserved, 1);
  await releaseExpired(db, new Date(row.expires_at).getTime() + 1);
  assert.deepEqual(await stock(product, 'M'), { quantity: 3, reserved: 0 });
  assert.equal((await orderRow(o.id)).status, 'cancelled');
  assert.equal((await db('payment_transactions').where({ id: prep.merchant_prepare_id }).first()).state, -1);
  assert.ok(new Date(row.expires_at).getTime() - Date.now() > HOLD_MS - 60_000, 'prepare gave the order a fresh 15 minutes');
});
