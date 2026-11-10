// Task 27: customer profile through Telegram (no SMS). Bot updates are simulated: there is no real bot token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { handleUpdate } from '../src/notify/telegram.js';
import { SAVE_MS, LOGIN_MS } from '../src/profile.js';

delete process.env.PUBLIC_URL;
const db = testDb();
const BOT = { token: '1:x', username: 'smartfit_test_bot' };
const weather = async () => ({ temperature: 15, apparent_temperature: 14, raining: false, wind_speed: 3, source: 'live' });
let server, base, tashkent, samarkand;
const listen = async (app) => {
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  return s;
};
const call = async (method, path, body, url = base) => {
  const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

// Simulated bot: what it sent, and the messages a customer's Telegram would deliver.
let sent = [];
const send = async (chat, text, extra) => void sent.push({ chat, text, extra });
const msg = (from, extra, now) => handleUpdate(db, { update_id: 1, message: { chat: { id: from, type: 'private' }, from: { id: from, language_code: 'uz' }, ...extra } }, send, { base: 'https://shop.test', now });
const param = (url) => new URL(url).searchParams.get('start');
const start = (from, url, now) => msg(from, { text: `/start ${param(url)}` }, now);
const contact = (from, { phone = '998901112233', user_id = from, now } = {}) => msg(from, { contact: { phone_number: phone, first_name: 'Aziz', last_name: 'Karimov', user_id } }, now);
const last = () => sent.at(-1);
const tokenOf = (url) => param(url).slice(2);
const pageToken = (text) => /\/profile\/([a-f0-9]{32})/.exec(text)?.[1];

async function recommend(store) {
  const r = await call('POST', '/api/recommend', { store_id: store, gender: 'male', sizes: { top: 'M', bottom: 'M', shoes: null }, budget: null });
  assert.equal(r.status, 200);
  return { rec: r.body.rec, looks: r.body.outfits.map((o) => o.items.map((i) => i.id)) };
}
async function order(store, phone, status) {
  const p = await db('products').where({ store_id: store, category: 'top' }).orderBy('id').first();
  await db('product_stock').where({ product_id: p.id, size: 'M' }).increment('quantity', 1);
  const c = await call('POST', '/api/cart/items', { store_id: store, items: [{ product_id: p.id, size: 'M' }] });
  const { lat, lon } = await db('stores').where({ id: store }).first();
  const o = await call('POST', `/api/cart/${c.body.token}/checkout`, { fulfillment: 'delivery', name: 'Aziz Karimov', phone, address: 'Amir Temur 1, kv 5', lat, lon });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  if (status) await db('orders').where({ id: o.body.order.id }).update({ status, payment_status: 'paid' });
  return o.body.order.id;
}
// Save a profile end to end; returns the profile page token from the bot's message.
async function saveProfile(from, store, body = {}) {
  const r = await call('POST', '/api/profile/link', { store_id: store, lang: 'uz', gender: 'male', height: 178, weight: 74, top: 'M', bottom: 'L', ...body });
  assert.equal(r.status, 201);
  await start(from, r.body.url);
  await contact(from);
  return { link: r.body, page: pageToken(last().text) };
}

before(async () => {
  await db.migrate.latest();
  await seed(db); // one organisation per demo store
  [tashkent, samarkand] = (await db('stores').orderBy('id')).map((s) => s.id);
  server = await listen(createApp(db, { weather, stylist: null, telegram: BOT, limits: { profile: 0, profilePoll: 0 } }));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await db.destroy();
});

test('without a Telegram bot the feature hides: no routes, the store view says profile: false', async () => {
  const off = await listen(createApp(db, { weather, stylist: null, telegram: null }));
  const url = `http://127.0.0.1:${off.address().port}`;
  try {
    assert.equal((await call('POST', '/api/profile/link', { store_id: tashkent }, url)).status, 404);
    assert.equal((await call('POST', '/api/profile/login', { store_id: tashkent }, url)).status, 404);
    assert.equal((await call('GET', `/api/stores/${tashkent}`, undefined, url)).body.profile, false);
  } finally {
    off.close();
  }
  assert.equal((await call('GET', `/api/stores/${tashkent}`)).body.profile, true);
  assert.equal((await call('POST', '/api/profile/link', { store_id: 9999 })).status, 404);
});

test('save: the deep link is single-use and expires; only the opener\'s own contact finishes it', async () => {
  sent = [];
  const { rec, looks } = await recommend(tashkent);
  const r = await call('POST', '/api/profile/link', { store_id: tashkent, lang: 'ru', gender: 'male', height: 178, weight: 74, shoes: '42', top: 'M', bottom: 'L', shoulder: 44.6, hip: 35.2, rec, looks });
  assert.equal(r.status, 201);
  assert.match(r.body.url, /^https:\/\/t\.me\/smartfit_test_bot\?start=p_[a-f0-9]{32}$/);
  assert.match(r.body.svg, /^<svg/);
  assert.equal(r.body.expires_ms, SAVE_MS);
  const poll = () => call('GET', `/api/profile/token/${r.body.poll}`);
  assert.equal((await poll()).body.state, 'new');
  assert.equal((await call('GET', `/api/profile/token/${tokenOf(r.body.url)}`)).status, 404, 'the QR / link token alone reads nothing');

  await start(111, r.body.url);
  assert.equal(last().chat, 111);
  assert.match(last().text, /Smart Fit Toshkent/, 'consent names the organisation');
  assert.match(last().text, /фото никогда/, 'consent in the language of the screen');
  assert.equal(last().extra.reply_markup.keyboard[0][0].request_contact, true);
  assert.equal((await poll()).body.state, 'opened');

  // Someone else opening the same link (forwarded, photographed): refused, the link stays the first user's.
  await start(222, r.body.url);
  assert.equal(last().chat, 222);
  assert.match(last().text, /eskirgan/);
  await contact(222);
  assert.equal(await db('customer_profiles').where({ telegram_user_id: 222 }).first(), undefined);
  // The opener forwards someone else's contact card: refused.
  await contact(111, { user_id: 222, phone: '998907776655' });
  assert.match(last().text, /o'zingizning/);
  await contact(111, { user_id: null });
  assert.equal(await db('customer_profiles').where({ telegram_user_id: 111 }).first(), undefined);
  assert.equal((await poll()).body.state, 'opened');

  await contact(111);
  const p = await db('customer_profiles').where({ telegram_user_id: 111 }).first();
  const org = (await db('stores').where({ id: tashkent }).first()).organization_id;
  assert.equal(p.organization_id, org);
  assert.equal(p.phone, '+998901112233');
  assert.equal(p.name, 'Aziz Karimov');
  assert.deepEqual([p.lang, p.gender, p.height, p.weight, p.shoes, p.top, p.bottom, p.shoulder, p.hip], ['ru', 'male', 178, 74, '42', 'M', 'L', 45, 35]);
  assert.equal(Number(await db('customer_looks').where({ profile_id: p.id }).count({ n: '*' }).first().then((x) => x.n)), looks.length);
  assert.ok(pageToken(last().text), 'the profile page link goes to the bot chat');
  assert.match(last().text, /\/delete/);
  assert.deepEqual(last().extra, { reply_markup: { remove_keyboard: true } });
  assert.deepEqual((await poll()).body, { state: 'done', expires_ms: 0 }, 'the screen learns "saved", nothing more');

  // Used: opening or sharing again changes nothing.
  sent = [];
  await start(111, r.body.url);
  assert.match(last().text, /eskirgan/);
  await contact(111, { phone: '998900000000' });
  assert.equal((await db('customer_profiles').where({ id: p.id }).first()).phone, '+998901112233');

  // A link nobody opened in time.
  const late = await call('POST', '/api/profile/link', { store_id: tashkent });
  await start(111, late.body.url, Date.now() + SAVE_MS + 1000);
  assert.match(last().text, /eskirgan/);
  await db('profile_tokens').where({ token: tokenOf(late.body.url) }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await call('GET', `/api/profile/token/${late.body.poll}`)).body.state, 'expired');
  // A save link can't be used as a login link (or the other way round).
  const other = await call('POST', '/api/profile/link', { store_id: tashkent });
  await msg(111, { text: `/start k_${tokenOf(other.body.url)}` });
  assert.match(last().text, /eskirgan/);
  assert.equal((await call('GET', `/api/profile/token/${'0'.repeat(32)}`)).status, 404);
  assert.equal((await call('GET', '/api/profile/token/not-a-token')).status, 404);
});

test('no image data anywhere in the profile: only whitelisted numbers, sizes and real looks are kept', async () => {
  const photo = `data:image/jpeg;base64,${'A'.repeat(5000)}`;
  const { rec, looks } = await recommend(tashkent);
  const forged = [[looks[0][0], 999999]];
  await saveProfile(333, tashkent, { photo, image: photo, height: photo, weight: '74', top: photo, shoes: 44, pose: { shoulder: 0.2 }, name: 'X', phone: '+998900000000', rec, looks: [...forged, looks[0]] });
  const p = await db('customer_profiles').where({ telegram_user_id: 333 }).first();
  assert.equal(p.height, null, 'a string is not a height');
  assert.equal(p.weight, null);
  assert.equal(p.top, null);
  assert.equal(p.shoes, '44');
  assert.equal(p.phone, '+998901112233', 'the phone comes only from the Telegram contact');
  assert.equal(p.name, 'Aziz Karimov');
  const lookRows = await db('customer_looks').where({ profile_id: p.id });
  assert.deepEqual(lookRows.map((l) => JSON.parse(l.items)), [[...looks[0]].sort((a, b) => a - b)], 'the forged look is dropped');
  for (const table of ['customer_profiles', 'customer_looks', 'profile_tokens']) {
    const rows = await db(table);
    for (const row of rows) {
      for (const [k, v] of Object.entries(row)) {
        assert.doesNotMatch(String(v ?? ''), /data:|base64|[A-Za-z0-9+/=]{200,}/, `${table}.${k}`);
        assert.doesNotMatch(k, /photo|image|pose/, `${table} has no image column`);
      }
    }
  }
});

test('a profile belongs to one organisation: login, orders and the page stay inside it', async () => {
  sent = [];
  const { page } = await saveProfile(444, tashkent);
  const mine = await order(tashkent, '+998901112233', 'delivered');
  const otherOrg = await order(samarkand, '+998901112233', 'delivered');
  const stranger = await order(tashkent, '+998905554433', 'delivered');
  const view = (await call('GET', `/api/profile/me/${page}`)).body;
  assert.equal(view.organization, (await db('organizations as o').join('stores as s', 's.organization_id', 'o.id').where('s.id', tashkent).first('o.name')).name);
  const numbers = new Set(view.orders.map((o) => o.number));
  const num = async (id) => (await db('orders').where({ id }).first()).number;
  assert.ok(numbers.has(await num(mine)));
  assert.equal(view.orders.length, await db('orders as o').where('o.store_id', tashkent).where('o.phone', '+998901112233').count({ n: '*' }).first().then((x) => Number(x.n)));
  assert.ok(view.orders.every((o) => o.store_name === 'Smart Fit Toshkent'), `no order of the other organisation (${otherOrg}) or another phone (${stranger})`);
  assert.ok(view.orders.every((o) => /^\/order\/[a-f0-9]{32}$/.test(o.url)));

  // Kiosk login in the other organisation's store: no profile there.
  const k = await call('POST', '/api/profile/login', { store_id: samarkand, lang: 'uz' });
  await start(444, k.body.url);
  assert.match(last().text, /Samarqand/);
  await contact(444);
  assert.match(last().text, /profilingiz yo'q/);
  assert.deepEqual((await call('GET', `/api/profile/token/${k.body.poll}`)).body, { state: 'missing', expires_ms: 0 });
  // Saving there makes a second, separate profile.
  await saveProfile(444, samarkand, { height: 160 });
  const rows = await db('customer_profiles').where({ telegram_user_id: 444 }).orderBy('id');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.height), [178, 160]);
});

test('kiosk login: the QR token is single-use and short-lived; the kiosk gets sizes once, never name or phone', async () => {
  sent = [];
  await saveProfile(555, tashkent, { shoes: '43', shoulder: 46, hip: 34 });
  const k = await call('POST', '/api/profile/login', { store_id: tashkent, lang: 'uz' });
  assert.equal(k.status, 201);
  assert.match(k.body.url, /\?start=k_[a-f0-9]{32}$/);
  assert.equal(k.body.expires_ms, LOGIN_MS);
  const poll = () => call('GET', `/api/profile/token/${k.body.poll}`);
  assert.notEqual(k.body.poll, tokenOf(k.body.url));
  await start(555, k.body.url);
  assert.match(last().text, /Smart Fit Toshkent/);
  assert.equal(last().extra.reply_markup.keyboard[0][0].request_contact, true, 'the phone confirms with the contact');
  assert.equal((await poll()).body.state, 'opened');
  await contact(555);
  assert.match(last().text, /Tayyor/);
  const [a, b] = await Promise.all([poll(), poll()]);
  const got = [a, b].filter((x) => x.status === 200);
  assert.equal(got.length, 1, 'two parallel polls: exactly one gets the sizes');
  assert.deepEqual(got[0].body, { state: 'done', profile: { lang: 'uz', gender: 'male', height: 178, weight: 74, shoes: '43', top: 'M', bottom: 'L', shoulder: 46, hip: 34, fit: null, jeans: null, chest: null, waist: null, hips: null } });
  assert.equal((await poll()).status, 404, 'gone after one read');
  await start(555, k.body.url);
  assert.match(last().text, /eskirgan/);

  // Short-lived: three minutes.
  const late = await call('POST', '/api/profile/login', { store_id: tashkent, lang: 'uz' });
  await start(555, late.body.url, Date.now() + LOGIN_MS + 1000);
  assert.match(last().text, /eskirgan/);
  // Opened in time, but the contact comes after expiry: nothing happens.
  const slow = await call('POST', '/api/profile/login', { store_id: tashkent, lang: 'uz' });
  await start(555, slow.body.url);
  await contact(555, { now: Date.now() + LOGIN_MS + 1000 });
  assert.match(last().text, /eskirgan/);
  await db('profile_tokens').where({ token: tokenOf(slow.body.url) }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await call('GET', `/api/profile/token/${slow.body.poll}`)).body.state, 'expired');
});

test('delete my data: the page and /delete remove the profile; finished orders keep only the sale record', async () => {
  sent = [];
  const { page } = await saveProfile(666, tashkent);
  assert.equal((await call('GET', `/api/profile/me/${page}`)).status, 200);
  const done = await order(tashkent, '+998901112233', 'delivered');
  const open = await order(tashkent, '+998901112233', null);
  const otherOrg = await order(samarkand, '+998901112233', 'delivered');
  const id = (await db('customer_profiles').where({ telegram_user_id: 666 }).first()).id;

  // /profile gives a fresh link; the old one stops working.
  await msg(666, { text: '/profile' });
  const fresh = pageToken(last().text);
  assert.ok(fresh && fresh !== page);
  assert.equal((await call('GET', `/api/profile/me/${page}`)).status, 404);

  assert.equal((await call('DELETE', `/api/profile/me/${fresh}`)).status, 204);
  assert.equal(await db('customer_profiles').where({ id }).first(), undefined);
  assert.equal((await db('customer_looks').where({ profile_id: id })).length, 0);
  assert.equal((await db('profile_tokens').where({ profile_id: id })).length, 0);
  assert.equal((await call('GET', `/api/profile/me/${fresh}`)).status, 404);
  const o = await db('orders').where({ id: done }).first();
  assert.deepEqual([o.customer_name, o.address, o.lat, o.lon, o.telegram_chat_id], ['—', null, null, null, null]);
  assert.equal(o.phone, '+998901112233', 'kept for the receipt, returns and the per-phone promo limit');
  assert.ok(o.total > 0 && o.number > 0);
  assert.equal((await db('orders').where({ id: open }).first()).customer_name, 'Aziz Karimov', 'an open order is still being served');
  assert.equal((await db('orders').where({ id: otherOrg }).first()).customer_name, 'Aziz Karimov', 'another organisation is not touched');

  // /delete in the bot removes every profile of that Telegram user.
  await saveProfile(777, tashkent);
  await saveProfile(777, samarkand);
  await msg(777, { text: '/delete' });
  assert.match(last().text, /o'chirildi/);
  assert.equal((await db('customer_profiles').where({ telegram_user_id: 777 })).length, 0);
  await msg(777, { text: '/delete' });
  assert.match(last().text, /saqlanmagan/);
});

test('rate limits: new links and login QRs, the profile page and polling each have a per-IP bucket', async () => {
  const s = await listen(createApp(db, { weather, stylist: null, telegram: BOT, limits: { profile: 2, profilePoll: 2 } }));
  const url = `http://127.0.0.1:${s.address().port}`;
  try {
    const a = await call('POST', '/api/profile/link', { store_id: tashkent }, url);
    assert.equal(a.status, 201);
    assert.equal((await call('POST', '/api/profile/login', { store_id: tashkent }, url)).status, 201);
    const third = await call('POST', '/api/profile/link', { store_id: tashkent }, url);
    assert.equal(third.status, 429);
    assert.equal(third.body.code, 'rate_limited');
    assert.equal((await call('GET', `/api/profile/me/${'a'.repeat(32)}`, undefined, url)).status, 429);
    const poll = () => call('GET', `/api/profile/token/${a.body.poll}`, undefined, url);
    assert.equal((await poll()).status, 200);
    assert.equal((await poll()).status, 200);
    assert.equal((await poll()).status, 429);
  } finally {
    s.close();
  }
});
