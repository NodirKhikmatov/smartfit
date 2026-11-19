// Task 31: "Kelganda xabar bering". Bot updates and the Telegram sender are simulated: there is no real bot here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { handleUpdate, flushStockAlerts, stockAlertText } from '../src/notify/telegram.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
delete process.env.PUBLIC_URL;
const db = testDb();
const BOT = { token: '1:x', username: 'smartfit_test_bot' };
let server, base, tashkent, samarkand, owner, manager, samOwner, superToken, products;

const call = async (method, path, body, headers = {}, raw) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
};
const admin = (method, p, body, token = owner, raw) => call(method, `/api/admin${p}`, body, { authorization: `Bearer ${token}`, ...(raw && { 'content-type': 'text/csv' }) }, raw);
const login = async (email, password) => (await call('POST', '/api/admin/login', { email, password })).body.token;

// Bot chat (what the bot said) and the customer's messages to it.
let chat = [];
const send = async (to, text) => void chat.push({ to, text });
const msg = (from, extra) => handleUpdate(db, { update_id: 1, message: { chat: { id: from, type: 'private' }, from: { id: from, language_code: 'uz' }, ...extra } }, send, { base: 'https://shop.test' });
const contact = (from) => msg(from, { contact: { phone_number: `99890${from}`, first_name: 'Aziz', user_id: from } });
const setStock = (productId, size, quantity, reserved = 0) => db('product_stock').where({ product_id: productId, size }).update({ quantity, reserved });
const pageToken = (text) => /\/profile\/([a-f0-9]{32})/.exec(text)?.[1];

// The restock messages the notifier would send.
let out = [];
const tg = async (to, text) => void out.push({ to, text });
const flush = () => flushStockAlerts(db, tg);

// Wait for a size of a product (stock set to 0 first) as Telegram user `from`; returns the profile page token if a
// profile was made in this step.
async function wait(from, p, size = 'M', lang = 'uz') {
  await setStock(p.id, size, 0);
  const r = await call('POST', '/api/profile/alert', { store_id: p.store_id, product_id: p.id, size, lang });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.url, /^https:\/\/t\.me\/smartfit_test_bot\?start=a_[a-f0-9]{32}$/);
  await msg(from, { text: `/start ${new URL(r.body.url).searchParams.get('start')}` });
  const page = chat.at(-1).text.includes('/delete') ? (await contact(from), pageToken(chat.at(-1).text)) : null;
  assert.equal((await call('GET', `/api/profile/token/${r.body.poll}`)).body.state, 'done', 'the screen learns it was kept');
  return page;
}

before(async () => {
  await db.migrate.latest();
  await seed(db); // one organisation per demo store
  [tashkent, samarkand] = (await db('stores').orderBy('id')).map((s) => s.id);
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  await createAdmin(db, { email: 'own@smartfit.uz', password: 'own-pass-1', storeId: tashkent });
  await createAdmin(db, { email: 'mgr@smartfit.uz', password: 'mgr-pass-1', storeId: tashkent, role: 'manager' });
  await createAdmin(db, { email: 'sam@smartfit.uz', password: 'sam-pass-1', storeId: samarkand });
  server = createApp(db, { telegram: BOT, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }), limits: { profile: 0, profilePoll: 0 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  [superToken, owner, manager, samOwner] = await Promise.all([login('boss@smartfit.uz', 'boss-pass-1'), login('own@smartfit.uz', 'own-pass-1'),
    login('mgr@smartfit.uz', 'mgr-pass-1'), login('sam@smartfit.uz', 'sam-pass-1')]);
  products = await db('products').where({ store_id: tashkent }).whereIn('category', ['top', 'bottom', 'outerwear']).whereNotNull('sku').orderBy('id');
});
after(async () => {
  server.close();
  await db.destroy();
});

test('the request: only a sold-out size of this store; a new customer consents with the contact, a known one is done at /start', async () => {
  const [p] = products;
  await setStock(p.id, 'M', 2);
  const inStock = await call('POST', '/api/profile/alert', { store_id: tashkent, product_id: p.id, size: 'M' });
  assert.deepEqual([inStock.status, inStock.body.code], [409, 'alert_in_stock']);
  await setStock(p.id, 'M', 2, 2); // all held in carts = none free
  assert.equal((await call('POST', '/api/profile/alert', { store_id: tashkent, product_id: p.id, size: 'M' })).status, 201);
  assert.equal((await call('POST', '/api/profile/alert', { store_id: samarkand, product_id: p.id, size: 'M' })).status, 404, "another store's product");
  assert.equal((await call('POST', '/api/profile/alert', { store_id: tashkent, product_id: p.id, size: '42' })).status, 400, 'not a size of this item');
  assert.equal((await call('POST', '/api/profile/alert', { store_id: tashkent, product_id: 'x', size: 'M' })).status, 404);

  chat = [];
  const page = await wait(701, p);
  assert.ok(chat[0].text.includes('Raqamni') || chat[0].text.includes('raqamingizni'), 'a new customer is asked for consent + contact');
  assert.ok(page, 'the bot sent the profile page link');
  assert.ok(chat.at(-1).text.includes(p.name) && chat.at(-1).text.includes('(M)'), chat.at(-1).text);
  const prof = await db('customer_profiles').where({ telegram_user_id: 701 }).first();
  const rows = await db('stock_alerts').where({ profile_id: prof.id });
  assert.deepEqual(rows.map((a) => [a.product_id, a.size, a.store_id, a.notified_at]), [[p.id, 'M', tashkent, null]]);

  chat = [];
  assert.equal(await wait(701, p, 'L'), null, 'a known customer: no contact asked again');
  assert.equal(chat.length, 1);
  assert.ok(chat[0].text.includes('(L)'));
  await wait(701, p, 'L'); // the same size again keeps one row
  assert.equal(await db('stock_alerts').where({ profile_id: prof.id }).count({ n: '*' }).then(([r]) => Number(r.n)), 2);
  // A used link does nothing for someone else.
  await setStock(p.id, 'S', 0);
  const r = await call('POST', '/api/profile/alert', { store_id: tashkent, product_id: p.id, size: 'S' });
  const start = `/start ${new URL(r.body.url).searchParams.get('start')}`;
  await msg(702, { text: start });
  await msg(703, { text: start });
  assert.match(chat.at(-1).text, /eskirgan/);
  assert.equal(await db('customer_profiles').where({ telegram_user_id: 703 }).first(), undefined);
});

test('each restock path (admin edit, CSV import, stock sync API, a return) sends exactly one message; none while 0 free', async () => {
  const [, a, b, c, d] = products;
  const from = { edit: 711, csv: 712, sync: 713, ret: 714 };
  // The return needs a handed-over order of product d before anyone waits for it.
  await setStock(d.id, 'M', 5);
  const cart = (await call('POST', '/api/cart/items', { store_id: tashkent, items: [{ product_id: d.id, size: 'M' }] })).body;
  const { order } = (await call('POST', `/api/cart/${cart.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '+998901234567' })).body;
  for (const [step, body] of [['pay', { method: 'cash' }], ['status', { status: 'packing' }], ['status', { status: 'delivered' }]]) {
    assert.equal((await admin('POST', `/orders/${order.id}/${step}`, body, manager)).status, 200);
  }
  await wait(from.edit, a);
  await wait(from.csv, b);
  await wait(from.sync, c);
  await wait(from.ret, d);

  out = [];
  await flush();
  assert.deepEqual(out, [], 'nothing while the sizes have 0 free');
  await setStock(a.id, 'M', 1, 1); // stock came, but a cart holds it
  await flush();
  assert.deepEqual(out, [], 'held units are not free');

  const sentTo = (who) => out.filter((m) => m.to === who);
  const once = async (who, p, raise) => {
    const r = await raise();
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
    await flush();
    await flush(); // a second round sends nothing more
    assert.equal(sentTo(who).length, 1, `one message for ${p.name}`);
    assert.ok(sentTo(who)[0].text.includes(p.name) && sentTo(who)[0].text.includes('(M)'), sentTo(who)[0].text);
  };
  await once(from.edit, a, () => admin('PATCH', `/products/${a.id}`, { stock: { M: 3 } }));
  await once(from.csv, b, () => admin('POST', '/products/import', undefined, owner, `sku;M\n${b.sku};4\n`));
  const key = (await admin('POST', '/sync-keys', { name: 'Kassa' })).body.key;
  await once(from.sync, c, () => call('POST', '/api/sync/stock', { items: [{ sku: c.sku, size: 'M', quantity: 2 }] }, { authorization: `Bearer ${key}` }));
  const line = (await admin('GET', `/orders/${order.id}`, undefined, manager)).body.items[0];
  await once(from.ret, d, () => admin('POST', `/orders/${order.id}/returns`, { key: 'f'.repeat(32), item_id: line.id, kind: 'return', reason: 'disliked', quantity: 1, restock: true }, manager));
  assert.equal(out.length, 4);

  // Sold out again and back: the request was used up, so no second message.
  await setStock(a.id, 'M', 0);
  await flush();
  await setStock(a.id, 'M', 5);
  await flush();
  assert.equal(sentTo(from.edit).length, 1);
});

test('the message links the item page with PUBLIC_URL; a blocked bot is given up, a network error retried', async () => {
  const p = products[5];
  assert.equal(stockAlertText({ size: 'M', lang: 'ru', store_name: 'Do\'kon', name: 'Hudi', name_ru: 'Худи', store_id: 3, product_id: 9 }, 'https://shop.test/'),
    "Do'kon: «Худи» (M) снова в продаже! Успейте купить.\nhttps://shop.test/m?store=3&item=9");
  assert.ok(!stockAlertText({ size: 'ONE', lang: 'uz', store_name: 'X', name: 'Kepka', store_id: 1, product_id: 2 }, undefined).includes('http'));
  await wait(721, p);
  await wait(722, products[4], 'L'); // a profile made in Uzbek…
  await wait(722, p, 'M', 'ru'); // …asks for this one in Russian
  await setStock(p.id, 'M', 1);
  const errs = [];
  const flaky = async (to) => { throw Object.assign(new Error('x'), { code: to === 721 ? 403 : 502 }); };
  const quiet = console.error;
  console.error = (...a) => errs.push(a);
  try { await flushStockAlerts(db, flaky); } finally { console.error = quiet; }
  const rows = await db('stock_alerts as a').join('customer_profiles as c', 'c.id', 'a.profile_id').where('a.product_id', p.id).select('c.telegram_user_id', 'a.notified_at');
  assert.ok(rows.find((r) => r.telegram_user_id === 721).notified_at, 'blocked: marked');
  assert.equal(rows.find((r) => r.telegram_user_id === 722).notified_at, null, '502: retried next round');
  out = [];
  await flush();
  assert.deepEqual(out.map((m) => m.to), [722]);
  assert.match(out[0].text, /снова в продаже/, 'in the language the customer asked in');
});

test('the profile page lists and cancels waiting requests; deleting the profile (page or /delete) removes them', async () => {
  const [p, q] = [products[6], products[7]];
  const page = await wait(731, p);
  await wait(731, q);
  const me = (await call('GET', `/api/profile/me/${page}`)).body;
  assert.deepEqual(me.alerts.map((a) => [a.product_id, a.size]).sort(), [[p.id, 'M'], [q.id, 'M']].sort());
  assert.ok(me.alerts.every((a) => a.store_name && a.name && a.created_at));
  // Someone else's page can't cancel it.
  const mine = me.alerts.find((a) => a.product_id === p.id);
  const other = await wait(732, p);
  assert.equal((await call('DELETE', `/api/profile/me/${other}/alerts/${mine.id}`)).status, 404);
  assert.equal((await call('DELETE', `/api/profile/me/${page}/alerts/${mine.id}`)).status, 204);
  assert.equal((await call('DELETE', `/api/profile/me/${page}/alerts/${mine.id}`)).status, 404);
  assert.equal((await call('GET', `/api/profile/me/${page}`)).body.alerts.length, 1);
  // A cancelled request is not sent; the other customer's is.
  await setStock(p.id, 'M', 3);
  out = [];
  await flush();
  assert.deepEqual(out.map((m) => m.to), [732]);

  const id731 = (await db('customer_profiles').where({ telegram_user_id: 731 }).first()).id;
  assert.equal((await call('DELETE', `/api/profile/me/${page}`)).status, 204);
  assert.equal((await db('stock_alerts').where({ profile_id: id731 })).length, 0);
  const r = products[8];
  await wait(733, r);
  await msg(733, { text: '/delete' });
  assert.equal((await db('stock_alerts as a').join('customer_profiles as c', 'c.id', 'a.profile_id').where('c.telegram_user_id', 733)).length, 0);
  assert.equal((await db('stock_alerts').where({ product_id: r.id })).length, 0);
});

test('admin Talab: people waiting per product and size, scoped to the admin\'s stores; the suggestion counts them', async () => {
  const p = products[9];
  const sam = await db('products').where({ store_id: samarkand }).whereIn('category', ['top', 'bottom']).orderBy('id').first();
  await wait(741, p, 'L');
  await wait(742, p, 'L');
  await wait(743, sam, 'S');
  const row = (items, prod, size) => items.find((x) => x.product_id === prod.id && x.size === size);
  for (const token of [owner, manager]) {
    const items = (await admin('GET', '/demand', undefined, token)).body.items;
    const x = row(items, p, 'L');
    assert.deepEqual([x.waiting, x.stock], [2, 0], 'listed even without missed demand in the window');
    assert.ok(x.suggest >= 2, 'the restock suggestion covers the people waiting');
    assert.ok(items.every((i) => i.store_id === tashkent), "never another organisation's rows");
  }
  const samItems = (await admin('GET', '/demand', undefined, samOwner)).body.items;
  assert.equal(row(samItems, sam, 'S').waiting, 1);
  assert.equal(row(samItems, p, 'L'), undefined);
  const all = (await admin('GET', '/demand', undefined, superToken)).body.items;
  assert.ok(row(all, p, 'L') && row(all, sam, 'S'), 'a super-admin sees both');
  assert.equal(row((await admin('GET', `/demand?store_id=${samarkand}`, undefined, superToken)).body.items, p, 'L'), undefined, 'super narrowed to one store');
  const csv = await admin('GET', '/demand/export', undefined, samOwner);
  assert.ok(csv.body.includes('"Kutmoqda"') && !csv.body.includes(p.name), 'export is scoped too');
  // Once sent, the person is no longer waiting.
  await setStock(p.id, 'L', 1);
  await flush();
  assert.equal(row((await admin('GET', '/demand')).body.items, p, 'L')?.waiting ?? 0, 0);
});
