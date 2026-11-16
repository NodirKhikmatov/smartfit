// Task 39: points expiry (FIFO lots, off by default, counted from the day it was turned on, never twice, safe beside a
// checkout and a second sweep), the Telegram reminder (once per batch, only with a bot), the profile page and /points,
// the owner's correction (bounds, reason, role, below zero, org isolation, audit) and the admin search and CSV.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, json } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { addMonths, lotsOf, expirePoints, expireProfile, remindExpiring, checkSpend, spend, pointsConfig } from '../src/cart/points.js';
import { handleUpdate } from '../src/notify/telegram.js';
import { deleteProfiles } from '../src/profile.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
const BOT = { token: '1:x', username: 'smartfit_test_bot' };
const weather = async () => ({ temperature: 15, apparent_temperature: 14, raining: false, wind_speed: 3, source: 'live' });
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2024, 0, 10, 12);
let server, base, tash, tash2, orgA, orgB, owner, ownerB, manager2, superT;

const call = async (method, p, body, token) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
};
const admin = (method, p, body, token = owner) => call(method, `/api/admin${p}`, body, token);
const login = async (email, password) => (await call('POST', '/api/admin/login', { email, password })).body.token;
const balance = async (id) => Number((await db('points_ledger').where({ profile_id: id }).sum({ n: 'amount' }))[0].n ?? 0);
const kinds = (id, kind) => db('points_ledger').where({ profile_id: id, kind }).orderBy('id');

let tg = 5000, num = 9000;
async function newProfile(org, name = 'Aziz', phone = `+99890${String(++tg).padStart(7, '0')}`) {
  const [{ id }] = await db('customer_profiles').insert({ organization_id: org, telegram_user_id: ++tg, phone, name, lang: 'uz', consent_at: new Date().toISOString() }).returning('id');
  return id;
}
async function newOrder(store) {
  const [{ id }] = await db('orders').insert({ store_id: store, number: ++num, customer_name: 'A', phone: '+998901112233', fulfillment: 'pickup', subtotal: 100000, delivery_fee: 0, total: 100000 }).returning('id');
  return id;
}
// A ledger row at a given time (ms). Order-bound kinds get an order of `store`.
let refN = 0;
async function row(org, profile, kind, amount, at, store = tash) {
  const order = ['earn', 'spend', 'refund', 'clawback', 'return'].includes(kind) ? await newOrder(store) : null;
  const [{ id }] = await db('points_ledger').insert({ organization_id: org, profile_id: profile, order_id: order, kind, amount, ref: `t${++refN}:${kind}`, created_at: new Date(at).toISOString() }).returning('id');
  return id;
}
const expiry = (org, months, since = null) => db('organizations').where({ id: org }).update({ points_expiry_months: months, points_expiry_since: since && new Date(since).toISOString() });
const orgRow = (id) => db('organizations').where({ id }).first('id', 'name', 'points_expiry_months', 'points_expiry_since');

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [tash] = (await db('stores').orderBy('id')).map((s) => s.id);
  [orgA, orgB] = (await db('stores').orderBy('id')).map((s) => s.organization_id);
  [{ id: tash2 }] = await db('stores').insert({ name: 'A filial', city: 'Toshkent', address: 'Chilonzor 1', lat: 41.28, lon: 69.2, organization_id: orgA }).returning('id');
  const sam = (await db('stores').orderBy('id'))[1].id;
  await createAdmin(db, { email: 'owner@smartfit.uz', password: 'owner-pass-1', storeId: tash });
  await createAdmin(db, { email: 'owner.b@smartfit.uz', password: 'owner-pass-2', storeId: sam });
  await createAdmin(db, { email: 'mgr2@smartfit.uz', password: 'mgr-pass-2', storeId: tash2, role: 'manager' });
  await createAdmin(db, { email: 'super@smartfit.uz', password: 'super-pass-1', role: 'super' });
  server = createApp(db, { weather, stylist: null, telegram: BOT, limits: { promo: 1000, cart: 0, recommend: 0, profile: 0, profilePoll: 0 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await login('owner@smartfit.uz', 'owner-pass-1');
  ownerB = await login('owner.b@smartfit.uz', 'owner-pass-2');
  manager2 = await login('mgr2@smartfit.uz', 'mgr-pass-2');
  superT = await login('super@smartfit.uz', 'super-pass-1');
});
after(async () => {
  server.close();
  await db.destroy();
});

test('lots: FIFO over a mixed history; a balance at or below zero has nothing to expire; months clamp to the month end', () => {
  const at = (m) => new Date(addMonths(T0, m)).toISOString();
  const rows = [
    { id: 1, amount: 100, created_at: at(0) }, // earn
    { id: 2, amount: 50, created_at: at(1) }, // earn
    { id: 3, amount: -30, created_at: at(2) }, // spend: 30 of row 1
    { id: 4, amount: 30, created_at: at(3) }, // refund of that spend: a new lot
    { id: 5, amount: -20, created_at: at(4) }, // clawback: 20 more of row 1
    { id: 6, amount: 10, created_at: at(5) }, // return of spent points: a new lot
  ];
  assert.deepEqual(lotsOf(rows, 6, 0).map((l) => [l.id, l.left, l.expires]),
    [[1, 50, addMonths(T0, 6)], [2, 50, addMonths(T0, 7)], [4, 30, addMonths(T0, 9)], [6, 10, addMonths(T0, 11)]]);
  // Below zero: earn 100, spend 80, clawback 50 → −30; nothing to expire. A later earn of 40 first pays the 30 back.
  const debt = [{ id: 1, amount: 100, created_at: at(0) }, { id: 2, amount: -80, created_at: at(0) }, { id: 3, amount: -50, created_at: at(1) }];
  assert.deepEqual(lotsOf(debt, 1, 0), []);
  assert.deepEqual(lotsOf([...debt, { id: 4, amount: 40, created_at: at(2) }], 1, 0).map((l) => [l.id, l.left]), [[4, 10]]);
  // since: a lot counts from the day expiry was turned on at the earliest.
  assert.equal(lotsOf([{ id: 1, amount: 5, created_at: at(0) }], 3, addMonths(T0, 10))[0].expires, addMonths(T0, 13));
  assert.equal(new Date(addMonths(Date.UTC(2025, 0, 31), 1)).toISOString().slice(0, 10), '2025-02-28');
  assert.equal(new Date(addMonths(Date.UTC(2024, 0, 31), 1)).toISOString().slice(0, 10), '2024-02-29');
});

test('off by default; the sweep expires exactly the unspent part, once, even run twice or in parallel', async () => {
  assert.equal((await orgRow(orgA)).points_expiry_months, 0, 'off by default');
  const p = await newProfile(orgA);
  const at = (m) => addMonths(T0, m);
  const r1 = await row(orgA, p, 'earn', 100, at(0));
  const r2 = await row(orgA, p, 'earn', 50, at(1));
  await row(orgA, p, 'spend', -30, at(2));
  await row(orgA, p, 'refund', 30, at(3));
  await row(orgA, p, 'clawback', -20, at(4));
  await row(orgA, p, 'return', 10, at(5));
  assert.equal(await expirePoints(db, at(20)), 0, 'expiry off: nothing expires however old');
  assert.equal(await balance(p), 140);

  await expiry(orgA, 6, T0 - DAY);
  assert.equal(await expirePoints(db, at(6) - 1000), 0, 'not yet');
  const now = at(6) + DAY;
  const runs = await Promise.all([expirePoints(db, now), expirePoints(db, now), expireProfile(db, await orgRow(orgA), p, now)]);
  assert.equal(runs.reduce((s, n) => s + n, 0), 50, 'the 50 left of the first earning, once across three parallel runs');
  assert.deepEqual((await kinds(p, 'expire')).map((r) => [r.amount, r.ref, r.order_id]), [[-50, `expire:${r1}`, null]]);
  assert.equal(await expirePoints(db, now), 0, 'a second sweep finds nothing');
  assert.equal(await balance(p), 90, 'the balance is still the sum of the rows');

  assert.equal(await expirePoints(db, at(7) + DAY), 50, 'next month: the second earning');
  assert.deepEqual((await kinds(p, 'expire')).map((r) => r.ref), [`expire:${r1}`, `expire:${r2}`]);
  assert.equal(await balance(p), 40, 'the refunded and returned points have their own, later term');

  // A negative balance expires nothing, however old its rows are.
  const neg = await newProfile(orgA);
  await row(orgA, neg, 'earn', 100, at(0));
  await row(orgA, neg, 'spend', -80, at(0) + 1000);
  await row(orgA, neg, 'clawback', -50, at(1));
  assert.equal(await expireProfile(db, await orgRow(orgA), neg, at(30)), 0);
  assert.equal(await balance(neg), -30);
  await expiry(orgA, 0);
});

test('turning expiry on in admin counts old points from that day: nothing is wiped at once', async () => {
  const p = await newProfile(orgA);
  await row(orgA, p, 'earn', 7000, Date.now() - 400 * DAY);
  const r = await admin('PATCH', '/points', { points_expiry_months: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const g = await orgRow(orgA);
  assert.ok(Math.abs(new Date(g.points_expiry_since).getTime() - Date.now()) < 60_000, 'since = now');
  assert.equal(await expirePoints(db), 0, 'the 400-day-old points are not wiped');
  await expirePoints(db, addMonths(Date.now(), 3) + DAY);
  assert.deepEqual((await kinds(p, 'expire')).map((r) => r.amount), [-7000], 'they expire 3 months after it was turned on');
  // Changing the term keeps the day; switching it off and on again starts from the new day.
  const since = g.points_expiry_since;
  await admin('PATCH', '/points', { points_expiry_months: 6 });
  assert.equal(String((await orgRow(orgA)).points_expiry_since), String(since));
  for (const body of [{ points_expiry_months: 37 }, { points_expiry_months: -1 }, { points_expiry_months: 1.5 }, { points_expiry_months: '3' }]) {
    assert.equal((await admin('PATCH', '/points', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await admin('PATCH', '/points', { points_expiry_months: 1 }, manager2)).status, 403);
  assert.equal((await admin('PATCH', '/points', { points_expiry_months: 0 })).status, 200);
  assert.equal((await admin('GET', '/points')).body.points_expiry_months, 0);
});

test('spending right before expiry uses the oldest points; a sweep beside a checkout never takes what it spends', async () => {
  await db('organizations').where({ id: orgA }).update({ cashback_percent: 5, points_max_share: 100 });
  const cfg = await pointsConfig(db, tash);
  const g = { ...(await orgRow(orgA)), points_expiry_months: 1, points_expiry_since: null };
  await expiry(orgA, 1);
  // Spent the day before: only the rest expires.
  const p = await newProfile(orgA);
  await row(orgA, p, 'earn', 100, T0);
  const due = addMonths(T0, 1);
  const o1 = await newOrder(tash);
  await db.transaction(async (trx) => { await checkSpend(trx, cfg, p, 1000, 60); await spend(trx, cfg, p, o1, 60); });
  assert.equal(await expirePoints(db, due + DAY), 40);
  assert.equal(await balance(p), 0);

  // A checkout and the sweep at the same moment (both take the profile-row lock): either the spend lands and the sweep
  // expires the rest, or the sweep goes first and the checkout fails with points_balance. Never both, never below zero.
  for (let i = 0; i < 4; i++) {
    const q = await newProfile(orgA);
    await row(orgA, q, 'earn', 100, T0);
    const o = await newOrder(tash);
    const checkout = db.transaction(async (trx) => { await checkSpend(trx, cfg, q, 1000, 60); await spend(trx, cfg, q, o, 60); }).then(() => 'spent', (e) => e.code ?? e.message);
    const [res, expired] = await Promise.all([checkout, expireProfile(db, g, q, due + DAY)]);
    const spent = -Number((await kinds(q, 'spend'))[0]?.amount ?? 0);
    assert.ok((res === 'spent' && spent === 60 && expired === 40) || (res !== 'spent' && spent === 0 && expired === 100), `${res} ${spent} ${expired}`);
    assert.equal(await balance(q), 0);
  }
  await expiry(orgA, 0);
  await db('organizations').where({ id: orgA }).update({ cashback_percent: 0, points_max_share: 50 });
});

test('the reminder: once per batch, only with a bot; a network error is retried, a blocked bot is not', async () => {
  const p = await newProfile(orgA);
  const now = Date.now();
  await expiry(orgA, 1, now - 400 * DAY);
  const soon = await row(orgA, p, 'earn', 12000, addMonths(now, -1) + 5 * DAY); // expires in 5 days
  await row(orgA, p, 'earn', 3000, addMonths(now, -1) + 20 * DAY); // in 20 days: not this batch
  const tgId = (await db('customer_profiles').where({ id: p }).first()).telegram_user_id;
  const sent = [];
  const send = async (chat, text) => void sent.push({ chat, text });
  await remindExpiring(db, null, now); // no bot: nothing, nothing marked
  assert.equal((await db('customer_profiles').where({ id: p }).first()).points_reminded_lot, null);
  // A network error gives the claim back.
  await remindExpiring(db, async () => { throw Object.assign(new Error('down'), { code: 502 }); }, now);
  assert.equal((await db('customer_profiles').where({ id: p }).first()).points_reminded_lot, null);
  await Promise.all([remindExpiring(db, send, now), remindExpiring(db, send, now)]);
  await remindExpiring(db, send, now + DAY);
  const mine = sent.filter((m) => m.chat === tgId);
  assert.equal(mine.length, 1, 'once');
  assert.match(mine[0].text, /12\s000 so'm ball/);
  assert.match(mine[0].text, new RegExp(new Date(addMonths(addMonths(now, -1) + 5 * DAY, 1)).toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\./g, '\\.')));
  // Fifteen days later the second lot comes into the window: a new batch, one more message.
  await remindExpiring(db, send, now + 15 * DAY);
  await remindExpiring(db, send, now + 16 * DAY);
  assert.equal(sent.filter((m) => m.chat === tgId).length, 2);
  assert.match(sent.at(-1).text, /3\s000 so'm/);
  // Blocked bot: marked, not retried.
  const b = await newProfile(orgA);
  await row(orgA, b, 'earn', 500, addMonths(now, -1) + 2 * DAY);
  await remindExpiring(db, async () => { throw Object.assign(new Error('blocked'), { code: 403 }); }, now);
  assert.ok((await db('customer_profiles').where({ id: b }).first()).points_reminded_lot);
  await expiry(orgA, 0);
});

test('profile page and /points show what expires next and when; expiry and correction rows have no order number', async () => {
  await db('organizations').where({ id: orgA }).update({ cashback_percent: 5 });
  const from = 88001;
  const sent = [];
  const send = async (chat, text) => void sent.push({ chat, text });
  const msg = (extra) => handleUpdate(db, { update_id: 1, message: { chat: { id: from, type: 'private' }, from: { id: from, language_code: 'uz' }, ...extra } }, send, { base: 'https://shop.test' });
  const link = await call('POST', '/api/profile/link', { store_id: tash, lang: 'uz', gender: 'male', top: 'M', bottom: 'L' });
  await msg({ text: `/start ${new URL(link.body.url).searchParams.get('start')}` });
  await msg({ contact: { phone_number: '998901118801', first_name: 'Aziz', user_id: from } });
  const page = sent.map((m) => /\/profile\/([a-f0-9]+)/.exec(m.text)?.[1]).find(Boolean);
  const p = (await db('customer_profiles').where({ telegram_user_id: from, organization_id: orgA }).first()).id;
  const now = Date.now();
  await expiry(orgA, 2, now - 400 * DAY);
  await row(orgA, p, 'earn', 700, addMonths(now, -3)); // already due (rows come in time order, as they do for real)
  await row(orgA, p, 'earn', 4000, addMonths(now, -2) + 3 * DAY);
  await row(orgA, p, 'earn', 1000, addMonths(now, -2) + 3 * DAY + 3600_000); // same day: counted with it
  await row(orgA, p, 'earn', 9000, addMonths(now, -1));
  assert.equal((await admin('POST', '/points/adjust', { profile_id: p, amount: 2500, reason: "Tug'ilgan kun sovg'asi" })).status, 200);
  await expirePoints(db, now);
  const me = (await call('GET', `/api/profile/me/${page}`)).body;
  assert.equal(me.points.expiry_months, 2);
  assert.equal(me.points.next.amount, 5000);
  assert.equal(new Date(me.points.next.at).getTime(), addMonths(addMonths(now, -2) + 3 * DAY, 2));
  assert.deepEqual([me.points.history[0].kind, me.points.history[0].amount, me.points.history[0].number], ['expire', -700, null]);
  assert.ok(me.points.history.some((h) => h.kind === 'adjust' && h.amount === 2500 && h.note === "Tug'ilgan kun sovg'asi" && h.number === null));
  assert.equal(me.points.balance, 4000 + 1000 + 9000 + 2500);
  sent.length = 0;
  await msg({ text: '/points' });
  assert.match(sent[0].text, /kuni 5\s000\sso.m kuyadi/);
  assert.match(sent[0].text, /Muddati tugadi/);
  assert.match(sent[0].text, /Do'kon tuzatishi · Tug'ilgan kun sovg'asi/);
  // "Delete my data" removes the expiry and correction rows with the rest.
  await deleteProfiles(db, [p]);
  assert.equal((await db('points_ledger').where({ profile_id: p })).length, 0);
  await expiry(orgA, 0);
  await db('organizations').where({ id: orgA }).update({ cashback_percent: 0 });
});

test('the correction: owner and super only, reason required, bounds, never below zero, org isolation, audited', async () => {
  const p = await newProfile(orgA, 'Dilnoza');
  await row(orgA, p, 'earn', 1000, Date.now());
  const adj = (body, token = owner) => admin('POST', '/points/adjust', { profile_id: p, ...body }, token);
  for (const body of [{ amount: 0, reason: 'Xato' }, { amount: 1.5, reason: 'Xato' }, { amount: '100', reason: 'Xato' }, { amount: 10_000_001, reason: 'Xato' },
    { amount: -10_000_001, reason: 'Xato' }, { amount: 100 }, { amount: 100, reason: '  ' }, { amount: 100, reason: 'ab' }, { amount: 100, reason: 'x'.repeat(201) }, { amount: 100, reason: 5 }]) {
    assert.equal((await adj(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await adj({ amount: 100, reason: 'Kassa xatosi' }, manager2)).status, 403, 'a manager can not');
  assert.equal((await adj({ amount: 100, reason: 'Kassa xatosi' }, ownerB)).status, 404, "another organisation's customer");
  assert.equal((await adj({ amount: 100, reason: 'Kassa xatosi', store_id: tash }, ownerB)).status, 403, "another organisation's store");
  assert.equal((await adj({ profile_id: 999999, amount: 100, reason: 'Kassa xatosi' })).status, 404);
  const below = await adj({ amount: -1001, reason: 'Kassa xatosi' });
  assert.deepEqual([below.status, below.body.code], [409, 'points_below_zero']);
  assert.equal(await balance(p), 1000, 'nothing written');

  const ok = await adj({ amount: -1000, reason: '  Kassa xatosi  ' });
  assert.deepEqual([ok.status, ok.body.balance], [200, 0]);
  const r = (await kinds(p, 'adjust'))[0];
  const me = await db('admins').where({ email: 'owner@smartfit.uz' }).first();
  assert.deepEqual([r.amount, r.note, r.admin_id, r.order_id, r.organization_id], [-1000, 'Kassa xatosi', me.id, null, orgA]);
  assert.match(r.ref, /^adjust:[a-f0-9]{24}$/);
  const a = await db('audit_log').where({ action: 'points.adjust', entity_id: p }).first();
  assert.equal(a.admin_id, me.id);
  assert.deepEqual(json(a.after), { balance: 0, amount: -1000, reason: 'Kassa xatosi' });
  assert.equal(json(a.before).balance, 1000);
  // Super can, in any organisation; added points raise even a balance below zero.
  await row(orgA, p, 'clawback', -300, Date.now());
  assert.deepEqual((await adj({ amount: 200, reason: 'Kompensatsiya', store_id: tash }, superT)).body, { balance: -100 });
  assert.equal((await adj({ amount: -1, reason: 'Kompensatsiya', store_id: tash }, superT)).status, 409);
  // Two parallel removals can't both pass the zero check.
  const q = await newProfile(orgA);
  await row(orgA, q, 'earn', 500, Date.now());
  const two = await Promise.all([1, 2].map(() => admin('POST', '/points/adjust', { profile_id: q, amount: -400, reason: 'Ikki marta' })));
  assert.deepEqual(two.map((x) => x.status).sort(), [200, 409]);
  assert.equal(await balance(q), 100);
});

test('added points expire like earned ones; removed points use up the oldest first', async () => {
  const p = await newProfile(orgA);
  await expiry(orgA, 1, T0 - DAY);
  await row(orgA, p, 'earn', 100, T0);
  await row(orgA, p, 'adjust', 50, T0 + 10 * DAY);
  await row(orgA, p, 'adjust', -30, T0 + 11 * DAY); // takes 30 of the earned 100
  assert.equal(await expirePoints(db, addMonths(T0, 1) + DAY), 70);
  assert.equal(await expirePoints(db, addMonths(T0 + 10 * DAY, 1) + DAY), 50, 'the added 50 expire a month after they were added');
  assert.equal(await balance(p), 0);
  await expiry(orgA, 0);
});

test('search by name or phone and the CSV: scoped like the list, formula-safe; mall admin and staff never get them', async () => {
  const evil = await newProfile(orgA, '=HYPERLINK("http://x","y")', '+998937770001');
  await row(orgA, evil, 'earn', 3500, Date.now(), tash);
  await row(orgA, evil, 'adjust', -500, Date.now());
  const other = await newProfile(orgA, 'Shahzoda Karimova', '+998937770002');
  await row(orgA, other, 'earn', 4000, Date.now(), tash2);
  const names = async (q, token = owner) => (await admin('GET', `/points?q=${encodeURIComponent(q)}`, undefined, token)).body.customers.map((c) => c.name);
  assert.deepEqual(await names('shahzoda'), ['Shahzoda Karimova'], 'any case');
  assert.deepEqual(await names('93 777 00 02'), ['Shahzoda Karimova'], 'phone digits');
  assert.deepEqual(await names('%'), (await admin('GET', '/points')).body.customers.map((c) => c.name), '% is not a wildcard (nothing left to filter)');
  assert.deepEqual(await names('zzz'), []);
  const s = (await admin('GET', '/points?q=937770')).body;
  assert.deepEqual([s.count, s.outstanding], [2, 7000], 'the KPIs follow the search');
  assert.deepEqual(await names('937770', manager2), ['Shahzoda Karimova'], "a manager: only customers from their store's orders");

  const csv = await admin('GET', '/points/export?q=937770');
  assert.equal(csv.status, 200);
  const lines = String(csv.body).replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^"Mijoz";"Telefon";"Balans"/);
  assert.ok(lines.some((l) => l.startsWith('"\'=HYPERLINK(""http://x"",""y"")";"998 93 777 00 01";"3000";"3500";"0";"0";"-500";"20')), lines.join('\n'));
  const m = String((await admin('GET', '/points/export', undefined, manager2)).body);
  assert.ok(m.includes('Shahzoda') && !m.includes('HYPERLINK'), "the manager's CSV is their store's customers");
  assert.match(String((await call('GET', '/api/admin/points/export?lang=ru', undefined, owner)).body), /"Покупатель";"Телефон"/);
  assert.equal((await admin('GET', '/points/export', undefined, ownerB)).body.includes?.('Shahzoda'), false);

  // A mall admin and staff are refused by their route gates.
  await createAdmin(db, { email: 'staff39@smartfit.uz', password: 'staff-pass-1', storeId: tash, role: 'staff' });
  const staff = await login('staff39@smartfit.uz', 'staff-pass-1');
  const [{ id: mall }] = await db('malls').insert({ name: 'M39', city: 'T', address: 'A' }).returning('id');
  await createAdmin(db, { email: 'mall39@smartfit.uz', password: 'mall-pass-1', role: 'mall', mallId: mall });
  const mallT = await login('mall39@smartfit.uz', 'mall-pass-1');
  for (const tok of [staff, mallT]) {
    for (const [method, p, body] of [['GET', '/points?q=a'], ['GET', '/points/export'], ['POST', '/points/adjust', { profile_id: other, amount: 1, reason: 'Sinov' }]]) {
      assert.equal((await admin(method, p, body, tok)).status, 403, `${method} ${p}`);
    }
  }
});

test('migration 029 down and up: expiry and correction rows go, order_id is required again; up brings it back', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await seed(m);
    const org = (await m('organizations').first()).id;
    const [{ id: p }] = await m('customer_profiles').insert({ organization_id: org, telegram_user_id: 1, phone: '+998901112233', consent_at: new Date().toISOString() }).returning('id');
    await m('points_ledger').insert({ organization_id: org, profile_id: p, order_id: null, kind: 'adjust', amount: 5, ref: 'adjust:x', admin_id: 1, note: 'Sinov' });
    await assert.rejects(m('points_ledger').insert({ organization_id: org, profile_id: p, kind: 'bonus', amount: 5, ref: 'b:1' }));
    await m.migrate.down(); // 035
    await m.migrate.down(); // 034
    await m.migrate.down(); // 033
    await m.migrate.down(); // 032
    await m.migrate.down(); // 031
    await m.migrate.down(); // 030
    await m.migrate.down();
    assert.equal((await m('points_ledger')).length, 0);
    assert.ok(!('note' in (await m('points_ledger').columnInfo())));
    assert.ok(!('points_expiry_months' in (await m('organizations').columnInfo())));
    await assert.rejects(m('points_ledger').insert({ organization_id: org, profile_id: p, order_id: null, kind: 'earn', amount: 5, ref: 'e:1' }));
    await m.migrate.latest();
    assert.equal((await m('organizations').first()).points_expiry_months, 0);
  } finally {
    await m.destroy();
  }
});
