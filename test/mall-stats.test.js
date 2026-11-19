// Task 53: mall analytics. Each event counts once and only for its mall; the "markazda yo'q" list; the period maths;
// a mall admin never reads another mall or a shop's private numbers; a shop owner reads no mall analytics; the counter
// table has no personal columns; the event route's checks and rate limit; the weekly digest; migration 043.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin, dayKey, dayStart, DAY_MS } from '../src/admin/routes.js';
import { dbTime } from '../src/recommend/routes.js';
import { normWord, periodOf, PERIOD_MAX } from '../src/mall-stats.js';
import { flushMallReport, reportWeek } from '../src/notify/telegram.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, s1, s2, s3, mallA, mallB, tokA, tokB, owner, manager, boss;

const call = async (method, p, body, token, headers = {}) => {
  const res = await fetch(base + p, {
    method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, text, headers: res.headers };
};
const login = async (email, password) => (await call('POST', '/api/admin/login', { email, password })).body.token;
const event = (body) => call('POST', '/api/mall-events', body);
const stats = (token, q = '') => call('GET', `/api/admin/mall/stats${q}`, undefined, token);
const today = () => dayKey(Date.now());
const daysAgo = (n) => dayKey(dayStart(today()) + 12 * 3600_000 - n * DAY_MS);

async function order(store) {
  const p = await db('products').where({ store_id: store, category: 'top' }).orderBy('id').first();
  await db('product_stock').where({ product_id: p.id, size: 'M' }).update({ quantity: 50, reserved: 0 });
  const cart = await call('POST', '/api/cart/items', { store_id: store, items: [{ product_id: p.id, size: 'M' }] });
  const r = await call('POST', `/api/cart/${cart.body.token}/checkout`, { fulfillment: 'pickup', name: 'Malika Karimova', phone: '+998935554433' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await db('orders').where({ id: r.body.order.id }).update({ payment_status: 'paid', paid_at: new Date().toISOString() });
  return r.body.order;
}

before(async () => {
  await db.migrate.latest();
  await seed(db); // the demo mall holds both demo shops
  [s1, s2] = (await db('stores').orderBy('id')).map((s) => s.id);
  mallA = (await db('malls').first()).id;
  [{ id: mallB }] = await db('malls').insert({ name: 'Ikkinchi markaz', city: 'Toshkent', address: 'Navoiy 5' }).returning('id');
  const orgA = (await db('stores').where({ id: s1 }).first()).organization_id;
  [{ id: s3 }] = await db('stores').insert({ name: 'B do\'koni', city: 'Toshkent', address: 'Navoiy 5', lat: 41.3, lon: 69.25, organization_id: orgA, mall_id: mallB }).returning('id');
  const { id: _, created_at, updated_at, ...p } = await db('products').where({ store_id: s1, category: 'top' }).orderBy('id').first();
  const [{ id: p3 }] = await db('products').insert({ ...p, store_id: s3, sku: null, name: 'Qorbobo kostyumi' }).returning('id');
  await db('product_stock').insert({ product_id: p3, size: 'M', quantity: 2 });
  await createAdmin(db, { email: 'mall.a@smartfit.uz', password: 'mall-pass-1', mallId: mallA });
  await createAdmin(db, { email: 'mall.b@smartfit.uz', password: 'mall-pass-2', mallId: mallB });
  await createAdmin(db, { email: 'owner@smartfit.uz', password: 'owner-pass-1', storeId: s1 });
  await createAdmin(db, { email: 'mgr@smartfit.uz', password: 'mgr-pass-1', storeId: s1, role: 'manager' });
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  server = createApp(db, { telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  [tokA, tokB, owner, manager, boss] = await Promise.all([login('mall.a@smartfit.uz', 'mall-pass-1'), login('mall.b@smartfit.uz', 'mall-pass-2'),
    login('owner@smartfit.uz', 'owner-pass-1'), login('mgr@smartfit.uz', 'mgr-pass-1'), login('boss@smartfit.uz', 'boss-pass-1')]);
});
after(async () => {
  server?.close();
  await db.destroy();
});

test('the search word: normalised, capped, nothing personal kept', () => {
  assert.equal(normWord('  Issiq   SVITER! '), 'issiq sviter');
  assert.equal(normWord('KOʻYLAK'), "ko'ylak");
  assert.equal(normWord('ko‘ylak'), "ko'ylak");
  assert.equal(normWord('Куртка'), 'куртка');
  assert.equal(normWord('shim-42'), 'shim-42');
  assert.equal(normWord('a'), null);
  assert.equal(normWord('!!'), null);
  assert.equal(normWord('+998 90 123 45 67'), null); // a phone number typed into the search box
  assert.equal(normWord('ali@mail.uz'), null);
  assert.equal(normWord('x'.repeat(60)).length, 40);
  assert.equal(normWord(42), null);
});

test('period maths: defaults, presets, typed days, the previous period and the limits', () => {
  const now = Date.parse('2026-11-19T19:30:00Z'); // 00:30 on 20.11 in Tashkent
  const p = periodOf({}, now);
  assert.deepEqual([p.from, p.to, p.days, p.prev.from, p.prev.to], ['2026-11-14', '2026-11-20', 7, '2026-11-07', '2026-11-13']);
  assert.equal(p.keys.length, 7);
  assert.equal(p.keys[0], '2026-11-14');
  assert.equal(p.keys.at(-1), '2026-11-20');
  const m = periodOf({ days: '30' }, now);
  assert.deepEqual([m.from, m.to, m.prev.from, m.prev.to], ['2026-10-22', '2026-11-20', '2026-09-22', '2026-10-21']);
  const one = periodOf({ from: '2026-11-20' }, now);
  assert.deepEqual([one.from, one.to, one.days, one.prev.from, one.prev.to], ['2026-11-20', '2026-11-20', 1, '2026-11-19', '2026-11-19']);
  const y = periodOf({ from: '2025-12-30', to: '2026-01-02' }, now); // across a year end
  assert.deepEqual([y.days, y.keys, y.prev.from, y.prev.to], [4, ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'], '2025-12-26', '2025-12-29']);
  const f = periodOf({ from: '2024-02-28', to: '2024-03-01' }, now); // a leap day
  assert.deepEqual(f.keys, ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.equal(periodOf({ days: String(PERIOD_MAX) }, now).days, PERIOD_MAX);
  for (const q of [{ from: '2026-02-30' }, { from: '2026-11-21' }, { to: '2026-11-21' }, { from: '2026-11-10', to: '2026-11-09' }, { from: '20261110' },
    { days: '0' }, { days: 'x' }, { days: '1.5' }, { days: String(PERIOD_MAX + 1) }, { from: '2024-01-01', to: '2026-11-20' }, { from: ['2026-11-01'] }]) {
    assert.throws(() => periodOf(q, now), (e) => e.status === 400, JSON.stringify(q));
  }
  // One minute before Tashkent midnight it is still the 19th.
  assert.equal(periodOf({}, Date.parse('2026-11-19T18:59:00Z')).to, '2026-11-19');
});

test('events: each counts once, only for its mall; the found-nothing list; checks', async () => {
  const A = { mall_id: mallA };
  for (const b of [{ kind: 'visit', channel: 'kiosk' }, { kind: 'visit', channel: 'kiosk' }, { kind: 'visit', channel: 'phone' },
    { kind: 'shop', channel: 'phone', store_id: s1 }, { kind: 'pin', channel: 'kiosk', store_id: s2 },
    { kind: 'search', channel: 'kiosk', word: 'Sviter' }, { kind: 'search', channel: 'phone', word: 'sviter ' },
    { kind: 'search', channel: 'phone', word: 'Qorbobo' }, { kind: 'search', channel: 'kiosk', word: 'zzqq' }]) {
    const r = await event({ ...A, ...b });
    assert.equal(r.status, 204, JSON.stringify(b));
  }
  // Mall B: its own visit, a pin, and "Qorbobo" is found there (only mall B's shop has it).
  for (const b of [{ kind: 'visit', channel: 'phone' }, { kind: 'pin', channel: 'phone', store_id: s3 }, { kind: 'search', channel: 'phone', word: 'qorbobo' }]) {
    assert.equal((await event({ mall_id: mallB, ...b })).status, 204);
  }
  // Refused: nothing written.
  const rows = async () => Number((await db('mall_stats').sum({ n: 'n' }))[0].n);
  const was = await rows();
  for (const [b, status] of [
    [{ ...A, kind: 'order', channel: 'kiosk' }, 400], [{ ...A, kind: 'visit', channel: 'tv' }, 400], [{ ...A, kind: 'visit' }, 400],
    [{ mall_id: 999999, kind: 'visit', channel: 'kiosk' }, 404], [{ mall_id: '1', kind: 'visit', channel: 'kiosk' }, 400], [{ mall_id: 2 ** 31, kind: 'visit', channel: 'kiosk' }, 400],
    [{ ...A, kind: 'shop', channel: 'kiosk', store_id: s3 }, 404], [{ ...A, kind: 'pin', channel: 'kiosk', store_id: 999999 }, 404], [{ ...A, kind: 'shop', channel: 'kiosk' }, 404],
    [{ ...A, kind: 'visit', channel: 'kiosk', store_id: s1 }, 400], [{ ...A, kind: 'visit', channel: 'kiosk', word: 'x' }, 400],
    [{ ...A, kind: 'search', channel: 'kiosk', word: 'x'.repeat(61) }, 400], [{ ...A, kind: 'search', channel: 'kiosk', word: ['a'] }, 400],
  ]) assert.equal((await event(b)).status, status, JSON.stringify(b));
  // Kept out without an error: too short, a phone number, an e-mail.
  for (const word of ['a', '90 123 45 67', 'me@x.uz']) assert.equal((await event({ ...A, kind: 'search', channel: 'kiosk', word })).status, 204);
  // A shop the mall hides is not counted (it is not on the screen).
  await db('stores').where({ id: s2 }).update({ mall_hidden: true });
  assert.equal((await event({ ...A, kind: 'shop', channel: 'kiosk', store_id: s2 })).status, 404);
  await db('stores').where({ id: s2 }).update({ mall_hidden: false });
  assert.equal(await rows(), was);
  assert.equal(await db('mall_stats').where({ word: '90 123 45 67' }).first(), undefined);

  const a = (await stats(tokA)).body;
  assert.deepEqual([a.totals.visits, a.totals.kiosk_visits, a.totals.phone_visits], [3, 2, 1]);
  assert.deepEqual([a.totals.searches, a.totals.nothing, a.totals.shop_opens, a.totals.pin_opens], [4, 2, 1, 1]);
  assert.deepEqual(a.words, [{ word: 'sviter', n: 2 }, { word: 'qorbobo', n: 1 }, { word: 'zzqq', n: 1 }]);
  assert.deepEqual(a.nothing, [{ word: 'qorbobo', n: 1 }, { word: 'zzqq', n: 1 }]); // "Qorbobo" is only in mall B's shop
  const hour = new Date(Date.now() + 5 * 3600_000).getUTCHours();
  assert.deepEqual(a.per_hour[hour], { hour, kiosk: 2, phone: 1 });
  assert.equal(a.per_hour.reduce((x, h) => x + h.kiosk + h.phone, 0), 3);
  assert.deepEqual(a.per_day.at(-1), { day: today(), kiosk: 2, phone: 1 });
  assert.deepEqual(a.shops.map((s) => [s.id, s.opens, s.pins]), [[s1, 1, 0], [s2, 0, 1]]); // most opened first; never mall B's shop
  const b = (await stats(tokB)).body;
  assert.deepEqual([b.totals.visits, b.totals.searches, b.totals.nothing, b.totals.pin_opens], [1, 1, 0, 1]);
  assert.deepEqual(b.words, [{ word: 'qorbobo', n: 1 }]);
  assert.deepEqual(b.shops.map((s) => s.id), [s3]);
});

test('reused counts: offers, mall outfits and the cart, mall orders, shop orders; the previous period', async () => {
  const [offerA] = await db('offers').where({ mall_id: mallA }).orderBy('id').pluck('id');
  const [{ id: offerB }] = await db('offers').insert({ organization_id: (await db('stores').where({ id: s3 }).first()).organization_id, store_id: s3, mall_id: mallB,
    title: 'B', title_ru: 'B', starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + DAY_MS).toISOString(), status: 'approved' }).returning('id');
  await db('offer_stats').insert([{ offer_id: offerA, day: today(), shown: 5, tapped: 2 }, { offer_id: offerA, day: daysAgo(10), shown: 3, tapped: 1 },
    { offer_id: offerB, day: today(), shown: 50, tapped: 20 }]);
  // Mall outfits: two screens now (one reached the cart, in two shops: still one screen), one 10 days ago, one in mall B.
  const screen = async (mall, at, accepted = []) => {
    const [{ id }] = await db('mall_recs').insert({ mall_id: mall, token: Math.random().toString(16).slice(2).padEnd(32, '0'), created_at: dbTime(at) }).returning('id');
    for (const store of [s1, s2]) await db('recommendation_logs').insert({ store_id: store, product_ids: JSON.stringify([]), source: 'rules', mall_rec_id: id, accepted_at: accepted.includes(store) ? new Date().toISOString() : null });
  };
  await screen(mallA, Date.now(), [s1, s2]);
  await screen(mallA, Date.now() - 60_000);
  await screen(mallA, Date.now() - 10 * DAY_MS, [s1]);
  await screen(mallB, Date.now(), [s1]);
  await db('order_groups').insert([{ mall_id: mallA, number: 1, token: 'a'.repeat(32) }, { mall_id: mallB, number: 1, token: 'b'.repeat(32) }]);
  await db('order_groups').insert({ mall_id: mallA, number: 2, token: 'c'.repeat(32), created_at: dbTime(Date.now() - 9 * DAY_MS) });
  await order(s2);
  await order(s2);
  await order(s1);
  await db('mall_stats').insert({ mall_id: mallA, day: daysAgo(8), hour: 10, kind: 'visit', channel: 'kiosk', n: 4 }); // last week

  const a = (await stats(tokA)).body;
  assert.deepEqual([a.totals.offer_shown, a.totals.offer_tapped], [5, 2]);
  assert.deepEqual([a.totals.outfits, a.totals.outfits_cart, a.totals.groups, a.totals.orders], [2, 1, 1, 3]);
  assert.deepEqual([a.prev_totals.offer_shown, a.prev_totals.outfits, a.prev_totals.outfits_cart, a.prev_totals.groups, a.prev_totals.visits], [3, 1, 1, 1, 4]);
  assert.equal(a.totals.visits, 3); // last week's 4 stay there
  assert.deepEqual(a.shops.map((s) => [s.id, s.orders]), [[s1, 1], [s2, 2]]);
  assert.equal(a.per_day.length, 7);
  // 30 days: both weeks.
  const m = (await stats(tokA, '?days=30')).body;
  assert.deepEqual([m.days, m.totals.visits, m.totals.outfits, m.totals.groups, m.totals.offer_shown], [30, 7, 3, 2, 8]);
  // A typed period of exactly that old day.
  const old = (await stats(tokA, `?from=${daysAgo(8)}&to=${daysAgo(8)}`)).body;
  assert.deepEqual([old.days, old.totals.visits, old.per_hour[10].kiosk, old.prev.from], [1, 4, 4, daysAgo(9)]);
  assert.equal((await stats(tokA, '?from=2026-13-01')).status, 400);
  const b = (await stats(tokB)).body;
  assert.deepEqual([b.totals.offer_shown, b.totals.outfits, b.totals.outfits_cart, b.totals.groups, b.totals.orders], [50, 1, 1, 1, 0]);
});

test("access: a mall admin reads only their mall and no shop's private numbers; shop roles and super read none", async () => {
  for (const t of [owner, manager, boss]) {
    assert.equal((await stats(t)).status, 403);
    assert.equal((await call('GET', '/api/admin/mall/stats/export', undefined, t)).status, 403);
  }
  assert.equal((await stats()).status, 401);
  // There is no mall id in the path: ?mall_id= changes nothing.
  const a = await stats(tokA), b = await stats(tokB, `?mall_id=${mallA}`);
  assert.equal(b.body.shops.some((s) => s.id === s1), false);
  assert.notDeepEqual(a.body.totals, b.body.totals);
  // Counts only: no prices, sums, products, customers, costs or sellers in the answer.
  const text = JSON.stringify(a.body);
  const product = await db('products').where({ store_id: s1 }).first();
  for (const bad of ['Malika', '998935554433', product.name, 'price', 'revenue', 'sum', 'cost', 'seller', 'email', 'customer', 'org']) assert.ok(!text.includes(bad), bad);
  assert.deepEqual(Object.keys(a.body.shops[0]).sort(), ['floor', 'hidden', 'id', 'name', 'opens', 'orders', 'pins', 'unit']);
  // The summary page the mall already had says nothing about money either (unchanged), and the shop's routes stay 403.
  assert.equal((await call('GET', '/api/admin/orders', undefined, tokA)).status, 403);
  assert.equal((await call('GET', '/api/admin/stats', undefined, tokA)).status, 403);
});

test('CSV in the admin language: totals against the previous period, days, hours, words, shops', async () => {
  const uz = await call('GET', '/api/admin/mall/stats/export?days=7', undefined, tokA, { 'accept-language': 'uz' });
  assert.equal(uz.status, 200);
  assert.match(uz.headers.get('content-type'), /text\/csv/);
  assert.match(uz.headers.get('content-disposition'), /mall-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv/);
  const lines = uz.text.replace(/^﻿/, '').split('\r\n');
  const p = periodOf({}, Date.now());
  assert.equal(lines[0], `"Ko'rsatkich";"${p.from} – ${p.to}";"${p.prev.from} – ${p.prev.to}"`);
  assert.equal(lines[1], '"Tashriflar";"3";"4"');
  assert.ok(lines.includes('"sviter";"2"'));
  assert.ok(lines.includes('"Soat";"Kiosk";"Telefon"'));
  assert.equal(lines.filter((l) => /^"\d{2}:00"/.test(l)).length, 24);
  const ru = await call('GET', '/api/admin/mall/stats/export?lang=ru', undefined, tokA);
  assert.match(ru.text, /"Посещения";"3";"4"/);
  assert.match(ru.text, /"Нет в центре"/);
  assert.ok(!ru.text.includes('Malika'));
});

test('the counter table has no personal columns', async () => {
  const cols = Object.keys(await db('mall_stats').columnInfo()).sort();
  assert.deepEqual(cols, ['channel', 'day', 'hour', 'id', 'kind', 'mall_id', 'n', 'store_id', 'word']);
  for (const r of await db('mall_stats').select('word')) assert.ok(r.word.length <= 40 && !/\d{5}/.test(r.word.replace(/\D/g, '')));
});

test('the event route has its own rate limit', async () => {
  const app = createApp(db, { telegram: null, stylist: null, limits: { mallEvent: 3 } }).listen(0);
  await new Promise((r) => app.once('listening', r));
  const url = `http://127.0.0.1:${app.address().port}/api/mall-events`;
  const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mall_id: mallA, kind: 'visit', channel: 'phone' }) });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await post()).status, 204);
    const r = await post();
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    // Another bucket (the mall directory) is untouched by it.
    assert.equal((await fetch(`http://127.0.0.1:${app.address().port}/api/malls/${mallA}`)).status, 200);
  } finally {
    app.close();
  }
});

test('weekly digest in Telegram: off without the bot or a chat, once a week, counts only', async () => {
  const sent = [];
  const tg = async (chat, text) => { sent.push({ chat, text }); };
  await flushMallReport(db, null);
  await flushMallReport(db, tg);
  assert.equal(sent.length, 0); // no chat set
  // The mall admin sets the chat (audited); a bad one is 400.
  assert.equal((await call('PATCH', '/api/admin/mall', { report_chat_id: 'abc' }, tokA)).status, 400);
  const r = await call('PATCH', '/api/admin/mall', { report_chat_id: '-1001234567890' }, tokA);
  assert.equal(r.status, 200);
  assert.equal(r.body.report_chat_id, -1001234567890);
  assert.equal((await call('GET', '/api/admin/mall', undefined, tokA)).body.mall.report_chat_id, -1001234567890);
  const audits = await db('audit_log').where({ action: 'mall.update' }).select('after');
  assert.ok(audits.some((x) => JSON.stringify(x.after).includes('report_chat_id')));
  // Last week's numbers: a visit and a word on last Monday.
  const week = reportWeek();
  const monday = dayKey(dayStart(week) - 7 * DAY_MS);
  await db('mall_stats').insert([{ mall_id: mallA, day: monday, hour: 11, kind: 'visit', channel: 'phone', word: '', n: 6 }, { mall_id: mallA, day: monday, hour: 11, kind: 'nothing', channel: 'phone', word: 'palto', n: 2 }]);
  await flushMallReport(db, null); // no bot: nothing sent, nothing marked
  assert.equal((await db('malls').where({ id: mallA }).first()).report_week, null);
  await flushMallReport(db, tg);
  await flushMallReport(db, tg);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, -1001234567890);
  const { name } = await db('malls').where({ id: mallA }).first();
  assert.match(sent[0].text, new RegExp(`^${name}: haftalik tahlil`));
  assert.match(sent[0].text, /Tashriflar: \d+/);
  assert.match(sent[0].text, /• palto — 2/);
  assert.ok(!sent[0].text.includes('Malika') && !sent[0].text.includes("so'm"));
  assert.equal((await db('malls').where({ id: mallA }).first()).report_week, week);
  // A network error retries; 403 (bot blocked) gives the week up.
  await db('malls').where({ id: mallA }).update({ report_week: null });
  await flushMallReport(db, async () => { throw Object.assign(new Error('down'), { code: 502 }); });
  assert.equal((await db('malls').where({ id: mallA }).first()).report_week, null);
  await flushMallReport(db, async () => { throw Object.assign(new Error('blocked'), { code: 403 }); });
  assert.equal((await db('malls').where({ id: mallA }).first()).report_week, week);
  // Clearing the chat stops it.
  assert.equal((await call('PATCH', '/api/admin/mall', { report_chat_id: null }, tokA)).body.report_chat_id, null);
});

test("a deleted mall's counters go with it", async () => {
  const [{ id }] = await db('malls').insert({ name: 'Yopiladi', city: 'Toshkent', address: 'Navoiy 9' }).returning('id');
  assert.equal((await event({ mall_id: id, kind: 'visit', channel: 'phone' })).status, 204);
  assert.equal((await call('DELETE', `/api/admin/malls/${id}`, undefined, boss)).status, 204);
  assert.equal(await db('mall_stats').where({ mall_id: id }).first(), undefined);
  assert.equal((await event({ mall_id: id, kind: 'visit', channel: 'phone' })).status, 404);
});

test('migration 043 goes down and up', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await m('malls').insert({ name: 'Qoladi', city: 'Toshkent', address: 'Navoiy 1', report_chat_id: 123 });
    await m.migrate.down(); // 044
    await m.migrate.down(); // 043
    assert.equal(await m.schema.hasTable('mall_stats'), false);
    for (const c of ['report_chat_id', 'report_week']) assert.equal(await m.schema.hasColumn('malls', c), false, c);
    assert.ok(await m('malls').where({ name: 'Qoladi' }).first());
    await m.migrate.latest();
    assert.ok(await m.schema.hasTable('mall_stats'));
    assert.ok(await m.schema.hasColumn('malls', 'report_week'));
  } finally {
    await m.destroy();
  }
});
