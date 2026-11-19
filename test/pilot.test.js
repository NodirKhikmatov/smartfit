import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { json, testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin, createStore } from '../src/admin/routes.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
delete process.env.PUBLIC_URL;
const db = testDb();
let server, proxied, base, proxiedBase, tashkent, samarkand, superToken, samToken;

const call = async (method, path, body, token, { at = base, headers = {} } = {}) => {
  const res = await fetch(at + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const login = async (email, password) => (await call('POST', '/api/admin/login', { email, password })).body.token;
const recommend = (extra = {}, store = tashkent) => call('POST', '/api/recommend', { store_id: store, gender: 'male', sizes: { top: 'M', bottom: 'M' }, ...extra });
const logRow = (token) => db('recommendation_logs').where({ token }).first();

// Puts one top (size M) in a cart, optionally from a results screen, and checks out.
async function order({ rec, fulfillment = 'pickup', paid = true } = {}) {
  const p = await db('products').where({ store_id: tashkent, category: 'top' }).orderBy('id').first();
  await db('product_stock').where({ product_id: p.id, size: 'M' }).increment('quantity', 1);
  const cart = await call('POST', '/api/cart/items', { store_id: tashkent, items: [{ product_id: p.id, size: 'M' }], rec });
  assert.equal(cart.status, 200);
  const body = { fulfillment, name: 'Aziz', phone: '+998901234567', ...(fulfillment === 'delivery' && { address: "Amir Temur ko'chasi 1" }) };
  const r = await call('POST', `/api/cart/${cart.body.token}/checkout`, body);
  assert.equal(r.status, 201);
  if (paid) assert.equal((await call('POST', `/api/admin/orders/${r.body.order.id}/pay`, { method: 'cash' }, superToken)).status, 200);
  return r.body.order;
}

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [tashkent, samarkand] = (await db('stores').orderBy('id')).map((s) => s.id);
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  await createAdmin(db, { email: 'sam@smartfit.uz', password: 'sam-pass-1', storeId: samarkand });
  const weather = async () => ({ temperature: 20, apparent_temperature: 20, raining: false, wind_speed: 3, source: 'live' });
  server = createApp(db, { weather, stylist: null, telegram: null, trustProxy: '' }).listen(0);
  proxied = createApp(db, { weather, stylist: null, telegram: null, trustProxy: '1' }).listen(0);
  await Promise.all([server, proxied].map((s) => new Promise((r) => s.once('listening', r))));
  base = `http://127.0.0.1:${server.address().port}`;
  proxiedBase = `http://127.0.0.1:${proxied.address().port}`;
  superToken = await login('boss@smartfit.uz', 'boss-pass-1');
  samToken = await login('sam@smartfit.uz', 'sam-pass-1');
});
after(async () => {
  server.close();
  proxied.close();
  await db.destroy();
});

test('pilot: a results screen is one log row; −/+ re-queries reuse it, another store or a bad token starts a new one', async () => {
  const first = await recommend();
  assert.equal(first.status, 200);
  assert.match(first.body.rec, /^[a-f0-9]{32}$/);
  const again = await recommend({ rec: first.body.rec, sizes: { top: 'L', bottom: 'L' } });
  assert.equal(again.body.rec, first.body.rec);
  assert.equal(json((await logRow(first.body.rec)).sizes).top, 'L', 'the re-query updated the row');
  assert.equal(Number((await db('recommendation_logs').where({ token: first.body.rec }).count({ n: '*' }))[0].n), 1);
  const other = await recommend({ rec: first.body.rec }, samarkand);
  assert.notEqual(other.body.rec, first.body.rec);
  const bad = await recommend({ rec: 'not-a-token' });
  assert.notEqual(bad.body.rec, first.body.rec);
});

test('pilot: "Kiyib ko\'rdim" marks the log once; bad or unknown tokens are refused', async () => {
  const { rec } = (await recommend()).body;
  assert.equal((await call('POST', '/api/recommend/tried', { rec: 'x' })).status, 400);
  assert.equal((await call('POST', '/api/recommend/tried', { rec: 'a'.repeat(32) })).status, 404);
  assert.equal((await call('POST', '/api/recommend/tried', { rec })).status, 204);
  const at = (await logRow(rec)).tried_at;
  assert.ok(at);
  assert.equal((await call('POST', '/api/recommend/tried', { rec })).status, 204);
  assert.equal(String((await logRow(rec)).tried_at), String(at), 'first tap kept');
});

test('pilot: adding from a results screen accepts it and the order carries it; other stores\' tokens are ignored', async () => {
  const { rec } = (await recommend()).body;
  const sam = (await recommend({}, samarkand)).body.rec;
  const o = await order({ rec });
  assert.ok((await logRow(rec)).accepted_at);
  assert.equal((await db('orders').where({ id: o.id }).first()).recommendation_id, (await logRow(rec)).id);
  const plain = await order({ rec: sam }); // Samarkand token in a Tashkent cart
  assert.equal((await logRow(sam)).accepted_at, null);
  assert.equal((await db('orders').where({ id: plain.id }).first()).recommendation_id, null);
});

test('pilot report: shown → accepted → tried → bought, delivery orders and average order value, store-scoped', async () => {
  await db('orders').update({ recommendation_id: null });
  await db('carts').update({ recommendation_id: null });
  await db('recommendation_logs').del();
  await db('payment_transactions').del();
  await db('order_items').del();
  await db('orders').del();

  const recs = [];
  for (let i = 0; i < 4; i++) recs.push((await recommend()).body.rec);
  await call('POST', '/api/recommend/tried', { rec: recs[0] });
  await call('POST', '/api/recommend/tried', { rec: recs[1] });
  const a = await order({ rec: recs[0] }); // accepted, tried, bought (pickup)
  const b = await order({ rec: recs[1], fulfillment: 'delivery' }); // accepted, tried, bought (delivery)
  await order({ rec: recs[2], paid: false }); // accepted, never paid
  const c = await order(); // bought without a suggestion: counts in orders and the average only
  const refunded = await order({ rec: recs[3] });
  assert.equal((await call('POST', `/api/admin/orders/${refunded.id}/status`, { status: 'cancelled' }, superToken)).status, 200);

  const s = (await call('GET', '/api/admin/stats?days=7', undefined, superToken)).body;
  const total = a.total + b.total + c.total;
  assert.deepEqual(s.pilot, { shown: 4, accepted: 4, tried: 2, bought: 2, orders: 3, delivery_orders: 1, revenue: total, avg_order: Math.round(total / 3) });
  assert.ok(Number.isInteger(s.pilot.avg_order));

  const sam = (await call('GET', '/api/admin/stats?days=7', undefined, samToken)).body;
  assert.deepEqual(sam.pilot, { shown: 0, accepted: 0, tried: 0, bought: 0, orders: 0, delivery_orders: 0, revenue: 0, avg_order: 0 });
  const forced = (await call('GET', `/api/admin/stats?days=7&store_id=${tashkent}`, undefined, samToken)).body;
  assert.equal(forced.pilot.orders, 0, 'a manager cannot read another store by store_id');
});

test('TRUST_PROXY: behind Caddy the forwarded scheme reaches the QR URL; without it headers are ignored', async () => {
  const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'fit.example.uz' };
  const direct = await call('GET', `/api/admin/stores/${tashkent}/qr`, undefined, superToken, { headers });
  assert.match(direct.body.url, /^http:\/\//);
  const viaProxy = await call('GET', `/api/admin/stores/${tashkent}/qr`, undefined, superToken, { at: proxiedBase, headers });
  assert.match(viaProxy.body.url, /^https:\/\//);
});

test('createStore: validates and inserts; the new store serves recommendations', async () => {
  const ok = { name: 'Smart Fit Buxoro', city: 'Buxoro', lat: '39.7747', lon: '64.4286', address: 'Navoiy 1', delivery_fee: '15000', free_delivery_threshold: '' };
  await assert.rejects(createStore(db, ok), /organization_id/, 'several organisations: the CLI must name one');
  const id = await createStore(db, { ...ok, orgId: (await db('organizations').orderBy('id').first()).id });
  const s = await db('stores').where({ id }).first();
  assert.deepEqual([s.city, s.lat, s.delivery_fee, s.free_delivery_threshold], ['Buxoro', 39.7747, 15000, null]);
  for (const bad of [{ name: '' }, { lat: '91' }, { lon: 'x' }, { delivery_fee: '-1' }, { delivery_fee: '1.5' }, { free_delivery_threshold: '0' }, { address: undefined }]) {
    await assert.rejects(createStore(db, { ...ok, orgId: 1, ...bad }), JSON.stringify(bad));
  }
  assert.equal((await call('GET', `/api/stores/${id}`)).body.city, 'Buxoro');
});
