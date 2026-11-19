// Task 43: mall promotions. A shop sees and edits only its own offers; the states and the approval rule; the picture
// checks; only approved offers inside their dates show on the mall (a shop's own screen needs no approval); the mall
// admin's scope and slide settings; counts (numbers only, rate-limited); the seed; migration 033.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDb, json } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, uploadDir, s1, s2, s3, s4, orgA, orgB, mallA, mallB, ownerA, ownerB, managerA, mallTokenA, mallTokenB;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
const dayAfter = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const iso = (ms) => new Date(ms).toISOString();

const call = async (method, p, body, token, { raw, type, url = base } = {}) => {
  const res = await fetch(url + p, {
    method,
    headers: { 'content-type': type || 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
};
const admin = (method, p, body, token, opts) => call(method, `/api/admin${p}`, body, token, opts);
const login = async (email, password) => (await admin('POST', '/login', { email, password })).body.token;
const offerBody = (o = {}) => ({ store_id: s1, title: 'Qishki chegirma', title_ru: 'Зимняя скидка', starts_on: today(), ends_on: dayAfter(today(), 7), ...o });
// A row straight in the table, for the date and state edges.
async function row(store, o = {}) {
  const s = await db('stores').where({ id: store }).first();
  const [{ id }] = await db('offers').insert({ organization_id: s.organization_id, store_id: store, mall_id: s.mall_id, title: 'Aksiya', title_ru: 'Акция',
    starts_at: iso(Date.now() - 60000), ends_at: iso(Date.now() + 86400000), image_url: '/uploads/offers/x.png', status: 'approved', ...o }).returning('id');
  return id;
}
const mallIds = async (mall = mallA) => (await call('GET', `/api/malls/${mall}/offers`)).body.offers.map((o) => o.id);
const storeIds = async (store) => (await call('GET', `/api/stores/${store}`)).body.offers.map((o) => o.id);

before(async () => {
  await db.migrate.latest();
  await seed(db); // two demo shops (orgs), both in the demo mall, with its demo offers
  await db('offers').del(); // this file makes its own
  [s1, s2] = (await db('stores').orderBy('id')).map((s) => s.id);
  [orgA, orgB] = (await db('stores').orderBy('id')).map((s) => s.organization_id);
  mallA = (await db('malls').first()).id;
  [{ id: mallB }] = await db('malls').insert({ name: 'Ikkinchi markaz', city: 'Toshkent', address: 'Navoiy 5' }).returning('id');
  const STORE = { city: 'Toshkent', address: 'Navoiy 5', lat: 41.3, lon: 69.25 };
  [{ id: s3 }] = await db('stores').insert({ ...STORE, name: 'A filial (B markaz)', organization_id: orgA, mall_id: mallB }).returning('id'); // org A in mall B
  [{ id: s4 }] = await db('stores').insert({ ...STORE, name: 'A filial (markazsiz)', organization_id: orgA }).returning('id'); // org A, no mall
  await createAdmin(db, { email: 'owner.a@smartfit.uz', password: 'owner-pass-1', storeId: s1 });
  await createAdmin(db, { email: 'owner.b@smartfit.uz', password: 'owner-pass-2', storeId: s2 });
  await createAdmin(db, { email: 'mgr.a@smartfit.uz', password: 'mgr-pass-1', storeId: s1, role: 'manager' });
  await createAdmin(db, { email: 'mall.a@smartfit.uz', password: 'mall-pass-1', mallId: mallA });
  await createAdmin(db, { email: 'mall.b@smartfit.uz', password: 'mall-pass-2', mallId: mallB });
  uploadDir = await mkdtemp(path.join(tmpdir(), 'sf-offers-'));
  server = createApp(db, { uploadDir, telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  ownerA = await login('owner.a@smartfit.uz', 'owner-pass-1');
  ownerB = await login('owner.b@smartfit.uz', 'owner-pass-2');
  managerA = await login('mgr.a@smartfit.uz', 'mgr-pass-1');
  mallTokenA = await login('mall.a@smartfit.uz', 'mall-pass-1');
  mallTokenB = await login('mall.b@smartfit.uz', 'mall-pass-2');
});
after(async () => {
  server.close();
  await db.destroy();
  await rm(uploadDir, { recursive: true, force: true });
});

test('a shop writes its own offers: validation, links of its own only, the picture checks, the states and the approval rule', async () => {
  assert.equal((await admin('GET', '/offers', undefined, managerA)).status, 403, 'offers are the owner\'s');
  assert.equal((await admin('POST', '/offers', offerBody(), managerA)).status, 403);
  // Validation: both titles, lengths that keep the kiosk layout, dates, one link at most, and of this shop only.
  for (const bad of [{ title_ru: '' }, { title: 'x'.repeat(61) }, { body: 'x'.repeat(161) }, { body_ru: 'x'.repeat(161) }, { ends_on: dayAfter(today(), -1) },
    { starts_on: '2026-02-30x' }, { ends_on: null }, { title: { $gt: '' } }]) {
    assert.equal((await admin('POST', '/offers', offerBody(bad), ownerA)).status, 400, JSON.stringify(bad));
  }
  const productB = await db('products').where({ store_id: s2 }).first();
  const [{ id: product3 }] = await db('products').insert({ ...(({ id, created_at, updated_at, ...p }) => p)(await db('products').where({ store_id: s1 }).first()), store_id: s3, sku: null }).returning('id');
  const [{ id: promoA }] = await db('promo_codes').insert({ organization_id: orgA, code: 'QISH20', kind: 'percent', value: 20 }).returning('id');
  const [{ id: promoA3 }] = await db('promo_codes').insert({ organization_id: orgA, store_id: s3, code: 'FILIAL', kind: 'percent', value: 5 }).returning('id');
  const [{ id: promoB }] = await db('promo_codes').insert({ organization_id: orgB, code: 'BKOD', kind: 'percent', value: 5 }).returning('id');
  for (const link of [{ product_id: productB.id }, { product_id: product3 }, { promo_code_id: promoB }, { promo_code_id: promoA3 }, { promo_code_id: promoA, product_id: productB.id }]) {
    const r = await admin('POST', '/offers', offerBody(link), ownerA);
    assert.equal(r.status, 400, JSON.stringify(link));
    assert.equal(r.body.code, 'invalid');
  }
  assert.equal((await admin('POST', '/offers', offerBody({ store_id: s2 }), ownerA)).status, 404, 'another shop\'s store');

  // A draft; Tashkent days in, Tashkent days out.
  const r = await admin('POST', '/offers', offerBody({ promo_code_id: promoA, body: '  Hammasiga 20%  ' }), ownerA);
  assert.equal(r.status, 201);
  const o = r.body;
  assert.deepEqual([o.status, o.in_mall, o.mall_id, o.body, o.link], ['draft', true, null, 'Hammasiga 20%', { kind: 'promo', code: 'QISH20' }]);
  assert.deepEqual([o.starts_on, o.ends_on], [today(), dayAfter(today(), 7)]);
  const stored = await db('offers').where({ id: o.id }).first();
  assert.equal(Date.parse(stored.starts_at), Date.parse(`${today()}T00:00:00+05:00`), 'from the start of the first Tashkent day');
  assert.equal(Date.parse(stored.ends_at), Date.parse(`${dayAfter(today(), 8)}T00:00:00+05:00`), 'to the end of the last one');
  assert.deepEqual(await storeIds(s1), [], 'a draft shows nowhere');

  // The picture: raster types by magic bytes only (no SVG from users), ≤ 2 MB, a random name under /uploads/offers/.
  assert.equal((await admin('POST', `/offers/${o.id}/submit`, undefined, ownerA)).body.code, 'offer_image', 'a slide needs a picture');
  for (const [raw, type] of [[Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'], [Buffer.from('GIF89a' + 'x'.repeat(20)), 'image/gif'], [Buffer.alloc(0), 'image/png']]) {
    assert.equal((await admin('POST', `/offers/${o.id}/image`, undefined, ownerA, { raw, type })).status, 400, type);
  }
  assert.equal((await admin('POST', `/offers/${o.id}/image`, undefined, ownerA, { raw: Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]), type: 'image/png' })).status, 413);
  const img = await admin('POST', `/offers/${o.id}/image`, undefined, ownerA, { raw: png, type: 'text/html' });
  assert.match(img.body.image_url, new RegExp(`^/uploads/offers/${o.id}-[0-9a-f]{16}\\.png$`), 'the type comes from the bytes, not the header');
  assert.deepEqual(await readdir(path.join(uploadDir, 'offers')), [path.basename(img.body.image_url)]);

  // Submit → waiting for the mall; shown on its own screen at once, not on the mall.
  const sub = await admin('POST', `/offers/${o.id}/submit`, undefined, ownerA);
  assert.deepEqual([sub.body.status, sub.body.mall_id], ['submitted', mallA]);
  assert.equal((await admin('POST', `/offers/${o.id}/submit`, undefined, ownerA)).status, 409);
  assert.deepEqual(await storeIds(s1), [o.id]);
  assert.deepEqual(await mallIds(), []);
  const audit = await db('audit_log').where({ action: 'offer.submit', entity_id: o.id }).first();
  assert.equal(audit.store_id, s1);

  // Approved → on the mall. Ending sooner keeps the approval; anything else goes back to the mall admin.
  const ok = await admin('POST', `/mall/offers/${o.id}/approve`, undefined, mallTokenA);
  assert.equal(ok.body.status, 'approved');
  assert.deepEqual(await mallIds(), [o.id]);
  const approvedAudit = await db('audit_log').where({ action: 'offer.approve', entity_id: o.id }).first();
  assert.deepEqual([approvedAudit.store_id, approvedAudit.admin_email], [s1, 'mall.a@smartfit.uz'], 'in the shop\'s own audit log');
  const edit = async (b) => (await admin('PATCH', `/offers/${o.id}`, b, ownerA)).body.status;
  const approve = () => admin('POST', `/mall/offers/${o.id}/approve`, undefined, mallTokenA);
  assert.equal(await edit({ ends_on: dayAfter(today(), 3) }), 'approved', 'ending sooner');
  assert.equal(await edit({ ends_on: dayAfter(today(), 3) }), 'approved', 'no change');
  assert.equal(await edit({ ends_on: dayAfter(today(), 10) }), 'submitted', 'running longer');
  assert.deepEqual(await mallIds(), [], 'gone from the mall until approved again');
  assert.deepEqual(await storeIds(s1), [o.id], 'still on its own screen');
  for (const change of [{ title: 'Yangi sarlavha' }, { body_ru: 'Новый текст' }, { starts_on: dayAfter(today(), -1) }, { promo_code_id: null }]) {
    await approve();
    assert.equal(await edit(change), 'submitted', JSON.stringify(change));
  }
  await approve();
  const img2 = await admin('POST', `/offers/${o.id}/image`, undefined, ownerA, { raw: Buffer.concat([png, Buffer.from([1])]), type: 'image/png' });
  assert.equal(img2.body.status, 'submitted', 'a new picture');
  assert.deepEqual(await readdir(path.join(uploadDir, 'offers')), [path.basename(img2.body.image_url)], 'the old file is gone');

  // Rejected: the reason reaches the shop; the offer is gone everywhere; an edit keeps it rejected until resubmitted.
  assert.equal((await admin('POST', `/mall/offers/${o.id}/reject`, { reason: 'x'.repeat(201) }, mallTokenA)).status, 400);
  assert.equal((await admin('POST', `/mall/offers/${o.id}/reject`, { reason: 'Rasm xira, aniqroq yuklang' }, mallTokenA)).body.status, 'rejected');
  const mine = (await admin('GET', '/offers', undefined, ownerA)).body.find((x) => x.id === o.id);
  assert.deepEqual([mine.status, mine.reject_reason], ['rejected', 'Rasm xira, aniqroq yuklang']);
  assert.deepEqual([await mallIds(), await storeIds(s1)], [[], []]);
  assert.equal(await edit({ title: 'Tuzatildi' }), 'rejected');
  const again = await admin('POST', `/offers/${o.id}/submit`, undefined, ownerA);
  assert.deepEqual([again.body.status, again.body.reject_reason], ['submitted', null]);

  // A store outside any mall: no approval step, its own screens only; the mall admin never sees it.
  const solo = (await admin('POST', '/offers', offerBody({ store_id: s4 }), ownerA)).body;
  assert.equal(solo.in_mall, false);
  await admin('POST', `/offers/${solo.id}/image`, undefined, ownerA, { raw: png, type: 'image/png' });
  const pub = await admin('POST', `/offers/${solo.id}/submit`, undefined, ownerA);
  assert.deepEqual([pub.body.status, pub.body.mall_id], ['approved', null]);
  assert.equal(await (async () => (await admin('PATCH', `/offers/${solo.id}`, { title: 'Boshqa' }, ownerA)).body.status)(), 'approved', 'no mall, no review');
  assert.deepEqual(await storeIds(s4), [solo.id]);
  assert.ok(!(await admin('GET', '/mall/offers', undefined, mallTokenA)).body.offers.some((x) => x.id === solo.id));
  assert.equal((await admin('POST', `/mall/offers/${solo.id}/approve`, undefined, mallTokenA)).status, 404);

  // Another shop's owner never sees, edits or deletes it; delete removes the offer, its counts and its picture.
  assert.ok(!(await admin('GET', '/offers', undefined, ownerB)).body.some((x) => x.id === o.id));
  for (const [m, p, b] of [['PATCH', `/offers/${o.id}`, { title: 'B' }], ['DELETE', `/offers/${o.id}`], ['POST', `/offers/${o.id}/submit`]]) assert.equal((await admin(m, p, b, ownerB)).status, 404);
  assert.equal((await admin('POST', `/offers/${o.id}/image`, undefined, ownerB, { raw: png, type: 'image/png' })).status, 404);
  await db('offer_stats').insert({ offer_id: o.id, day: today(), shown: 3 });
  assert.equal((await admin('DELETE', `/offers/${o.id}`, undefined, ownerA)).status, 204);
  assert.equal(await db('offers').where({ id: o.id }).first(), undefined);
  assert.equal(await db('offer_stats').where({ offer_id: o.id }).first(), undefined);
  assert.deepEqual(await readdir(path.join(uploadDir, 'offers')), (await db('offers').whereNotNull('image_url')).map((x) => path.basename(x.image_url)).filter((f) => f !== 'x.png'));
  await db('offers').del();
});

test('only approved offers inside their dates show on the mall, on time; a shop\'s own screen needs no approval', async () => {
  const live = await row(s1, { title: 'Ikkinchi', sort: 2 });
  const first = await row(s2, { title: 'Birinchi', sort: 1 });
  const waiting = await row(s1, { status: 'submitted' });
  const rejected = await row(s1, { status: 'rejected', reject_reason: 'Yo\'q' });
  const draft = await row(s1, { status: 'draft' });
  const expired = await row(s1, { ends_at: iso(Date.now() - 1) });
  const future = await row(s1, { starts_at: iso(Date.now() + 60000) });
  const otherMall = await row(s3);
  assert.deepEqual(await mallIds(), [first, live], 'approved, current, in the mall admin\'s order');
  assert.deepEqual(await mallIds(mallB), [otherMall]);
  assert.deepEqual((await storeIds(s1)).sort(), [live, waiting].sort(), 'its own screen: approved or waiting; never rejected, draft, ended or not started');
  for (const id of [rejected, draft, expired, future]) assert.ok(!(await storeIds(s1)).includes(id));
  // On time without a restart: one that ends in a second goes, one that starts in a second comes.
  const ending = await row(s1, { ends_at: iso(Date.now() + 1000), sort: 3 });
  const starting = await row(s1, { starts_at: iso(Date.now() + 1000), sort: 4 });
  assert.deepEqual(await mallIds(), [first, live, ending]);
  await new Promise((r) => setTimeout(r, 1100));
  assert.deepEqual(await mallIds(), [first, live, starting]);
  // A shop the mall hides: off the mall screen, still on its own. A shop that left the mall: off it too.
  await db('stores').where({ id: s2 }).update({ mall_hidden: true });
  assert.deepEqual(await mallIds(), [live, starting]);
  assert.deepEqual(await storeIds(s2), [first]);
  await db('stores').where({ id: s2 }).update({ mall_hidden: false, mall_id: null });
  assert.deepEqual(await mallIds(), [live, starting]);
  await db('stores').where({ id: s2 }).update({ mall_id: mallA });

  // What a customer gets: no state, organisation or counts; the shop's place; a public code while it works; an item
  // only while it is shown and in stock (else the offer opens the shop).
  const p = await db('products').where({ store_id: s1, category: 'top' }).orderBy('id').first();
  await db('product_stock').where({ product_id: p.id }).update({ quantity: 2, reserved: 0 });
  const [{ id: code }] = await db('promo_codes').insert({ organization_id: orgA, code: 'OCHIQ', kind: 'fixed', value: 5000 }).returning('id');
  await db('offers').where({ id: live }).update({ product_id: p.id });
  await db('offers').where({ id: starting }).update({ promo_code_id: code });
  const get = async (id) => (await call('GET', `/api/malls/${mallA}/offers`)).body.offers.find((x) => x.id === id);
  const shown = await get(live);
  assert.deepEqual(Object.keys(shown).sort(), ['body', 'body_ru', 'code', 'id', 'image_url', 'item_id', 'store', 'title', 'title_ru']);
  assert.deepEqual(shown.store, { id: s1, name: (await db('stores').where({ id: s1 }).first()).name, floor: '1', unit: '104' });
  assert.equal(shown.item_id, p.id);
  assert.equal((await get(starting)).code, 'OCHIQ');
  await db('product_stock').where({ product_id: p.id }).update({ reserved: db.raw('quantity') });
  assert.equal((await get(live)).item_id, null, 'sold out → the shop');
  await db('product_stock').where({ product_id: p.id }).update({ reserved: 0 });
  await db('categories').where({ id: p.category_id }).update({ hidden: true });
  assert.equal((await get(live)).item_id, null, 'hidden → the shop');
  await db('categories').where({ id: p.category_id }).update({ hidden: false });
  await db('promo_codes').where({ id: code }).update({ active: false });
  assert.equal((await get(starting)).code, null, 'a code switched off is not shown');
  assert.equal((await call('GET', '/api/malls/999999/offers')).status, 404);
  assert.equal((await call('GET', `/api/malls/${mallA}/offers`)).body.seconds, 8);
  await db('offers').del();
});

test('the mall admin: only what shops submitted to their mall, approve / reject, the slide order and seconds', async () => {
  const a1 = await row(s1, { status: 'submitted' }), a2 = await row(s2, { status: 'approved', sort: 1 }), a3 = await row(s2, { status: 'approved', sort: 2 });
  const draft = await row(s1, { status: 'draft' }), b1 = await row(s3, { status: 'submitted' });
  const list = (await admin('GET', '/mall/offers', undefined, mallTokenA)).body;
  assert.deepEqual(list.offers.map((o) => o.id), [a1, a2, a3], 'waiting first, then approved in order; no drafts, no other mall');
  assert.ok(!JSON.stringify(list).match(/organization_id|price|phone|customer/), 'no shop data beyond what it submitted');
  assert.deepEqual((await admin('GET', '/mall/offers', undefined, mallTokenB)).body.offers.map((o) => o.id), [b1]);
  for (const [m, p, b] of [['POST', `/mall/offers/${a1}/approve`], ['POST', `/mall/offers/${a1}/reject`, { reason: 'X' }], ['POST', `/mall/offers/${draft}/approve`]]) {
    assert.equal((await admin(m, p, b, mallTokenB)).status, 404, `${p} from mall B`);
  }
  assert.equal((await admin('POST', `/mall/offers/${draft}/approve`, undefined, mallTokenA)).status, 404, 'a draft is the shop\'s');
  assert.equal((await admin('POST', `/mall/offers/${a2}/approve`, undefined, mallTokenA)).status, 409);
  assert.equal((await admin('POST', `/mall/offers/${a1}/approve`, undefined, mallTokenA)).status, 200);
  assert.deepEqual(await mallIds(), [a2, a3, a1], 'a newly approved one goes last');
  // Seconds 4–30 (integers); the order is this mall's approved offers only, each once; the ones left out follow.
  for (const bad of [{ seconds: 3 }, { seconds: 31 }, { seconds: '8' }, { seconds: 7.5 }, { order: [b1] }, { order: [a1, a1] }, { order: [draft] }, { order: 'a1' }]) {
    assert.equal((await admin('PATCH', '/mall/slides', bad, mallTokenA)).status, 400, JSON.stringify(bad));
  }
  const r = await admin('PATCH', '/mall/slides', { seconds: 12, order: [a1, a3] }, mallTokenA);
  assert.deepEqual(r.body, { seconds: 12, order: [a1, a3, a2] });
  assert.deepEqual(await mallIds(), [a1, a3, a2]);
  assert.equal((await call('GET', `/api/malls/${mallA}/offers`)).body.seconds, 12);
  assert.equal((await call('GET', `/api/malls/${mallB}/offers`)).body.seconds, 8, 'another mall keeps its own');
  const slides = await db('audit_log').where({ action: 'mall.slides' }).orderBy('id', 'desc').first();
  assert.deepEqual(json(slides.after), { seconds: 12, order: [a1, a3, a2] });
  // A reject can take an approved offer down; the reason is required.
  assert.equal((await admin('POST', `/mall/offers/${a3}/reject`, { reason: '  ' }, mallTokenA)).status, 400);
  assert.equal((await admin('POST', `/mall/offers/${a3}/reject`, { reason: 'Muddati o\'tgan narx' }, mallTokenA)).body.status, 'rejected');
  assert.deepEqual(await mallIds(), [a1, a2]);
  // Shop roles never reach the mall routes.
  for (const tok of [ownerA, managerA]) assert.equal((await admin('GET', '/mall/offers', undefined, tok)).status, 403);
  await db('offers').del();
  await db('malls').update({ slide_seconds: 8 });
});

test('counts: shown and tapped per offer and day, numbers only, once per IP every 30 s, rate-limited', async () => {
  let clock = Date.now();
  const app = createApp(db, { uploadDir, telegram: null, stylist: null, limits: { offer: 6 }, now: () => clock, weather: async () => ({ temperature: 15, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => app.once('listening', r));
  const url = `http://127.0.0.1:${app.address().port}`;
  try {
    const a = await row(s1), b = await row(s2, { status: 'submitted' }), draft = await row(s1, { status: 'draft' }), ended = await row(s1, { ends_at: iso(Date.now() - 1000) });
    clock = Date.now();
    const ev = (body) => call('POST', '/api/offers/events', body, null, { url });
    assert.equal((await ev({ shown: [a, b, draft, ended, 999999, a] })).status, 204);
    assert.equal((await ev({ tapped: a })).status, 204);
    const stats = async () => Object.fromEntries((await db('offer_stats').orderBy('offer_id')).map((s) => [s.offer_id, [s.shown, s.tapped]]));
    assert.deepEqual(await stats(), { [a]: [1, 1], [b]: [1, 0] }, 'only live offers, each once per request');
    assert.equal((await db('offer_stats').first()).day, today());
    assert.deepEqual(Object.keys(await db('offer_stats').first()).sort(), ['day', 'offer_id', 'shown', 'tapped'], 'counts only: no customer, device or IP');
    await ev({ shown: [a], tapped: a });
    assert.deepEqual(await stats(), { [a]: [1, 1], [b]: [1, 0] }, 'the same IP again within 30 s counts nothing');
    clock += 31_000;
    await ev({ shown: [a], tapped: a });
    assert.deepEqual(await stats(), { [a]: [2, 2], [b]: [1, 0] });
    for (const bad of [{ shown: 'x' }, { shown: [0] }, { shown: Array.from({ length: 21 }, (_, i) => i + 1) }, { tapped: -1 }, { tapped: 'a' }]) {
      assert.equal((await ev(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await ev({ shown: [a] })).status, 429, 'the per-IP bucket (6 a minute here)');
    // The shop sees its own counts; the mall admin sees every one of the mall's; another shop sees none of them.
    assert.deepEqual((({ shown, tapped }) => [shown, tapped])((await admin('GET', '/offers', undefined, ownerA)).body.find((o) => o.id === a)), [2, 2]);
    const mallView = (await admin('GET', '/mall/offers', undefined, mallTokenA)).body.offers;
    assert.deepEqual(mallView.filter((o) => [a, b].includes(o.id)).map((o) => [o.id, o.shown, o.tapped]), [[b, 1, 0], [a, 2, 2]]);
    assert.ok(!(await admin('GET', '/offers', undefined, ownerB)).body.some((o) => o.id === a));
  } finally {
    app.close();
    await db('offers').del();
    await db('offer_stats').del();
  }
});

test('seed: the demo mall shows two approved offers and one waiting for its admin', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await seed(m);
    const rows = await m('offers').orderBy('id');
    assert.deepEqual(rows.map((o) => o.status), ['approved', 'approved', 'submitted']);
    assert.ok(rows.every((o) => o.mall_id === 1 && o.image_url && o.title && o.title_ru && o.body && o.body_ru));
    assert.ok(rows[0].product_id, 'one opens an item');
  } finally {
    await m.destroy();
  }
});

test('customer screens: offer text only as text, no sound, the slide fade respects prefers-reduced-motion', async () => {
  const js = await readFile(new URL('../public/app/offers.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|<audio|<video|new Audio|\.play\(/);
  const css = await readFile(new URL('../public/app/app.css', import.meta.url), 'utf8');
  const motion = css.match(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.slide \{[^}]*\}\s*\}/);
  assert.ok(motion && /animation/.test(motion[0]), 'the fade only with no-preference');
  assert.equal(css.replace(motion[0], '').match(/\.slide[^{]*\{[^}]*animation/), null, 'no other slide animation');
  // The idle slides start only from the kiosk's idle path, after the reset.
  const app = await readFile(new URL('../public/app/app.js', import.meta.url), 'utf8');
  assert.match(app, /watchIdle\(document, \{ onIdle: \(\) => \{ reset\(\); attract\(true\); \} \}\)/);
});

test('migration 033 down and up', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await m.migrate.down(); // 043
    await m.migrate.down(); // 042
    await m.migrate.down(); // 041
    await m.migrate.down(); // 040
    await m.migrate.down(); // 039
    await m.migrate.down(); // 038
    await m.migrate.down(); // 037
    await m.migrate.down(); // 036
    await m.migrate.down(); // 035
    await m.migrate.down(); // 034
    await m.migrate.down();
    assert.ok(!(await m.schema.hasTable('offers')) && !(await m.schema.hasTable('offer_stats')));
    assert.ok(!('slide_seconds' in (await m('malls').columnInfo())));
    await m.migrate.latest();
    assert.ok(await m.schema.hasTable('offers'));
    assert.equal((await m('malls').columnInfo()).slide_seconds.defaultValue?.replace(/'/g, ''), '8');
    await assert.rejects(m('offers').insert({ organization_id: 1, store_id: 1, title: 'x', title_ru: 'x', starts_at: iso(0), ends_at: iso(1), status: 'live' }), 'status CHECK');
  } finally {
    await m.destroy();
  }
});
