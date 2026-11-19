// Task 46: ratings and reviews after a purchase. Only a handed-over order line, once, through the order's own token;
// returned and exchanged lines; averages from visible reviews only and from REVIEW_MIN; the catalogue sort and the
// mall search use the same number; hiding (owner, reason, audited) and the one answer; plain-text limits; rate limit;
// store scope in admin; "delete my data"; the Telegram line; the demo seed; migration 036.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testDb, json } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed, seedDemoReviews, DEMO_REVIEWS } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { REVIEW_MIN, fitSummary, reviewText } from '../src/reviews.js';
import { deleteProfiles } from '../src/profile.js';
import { message } from '../src/notify/telegram.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, store, store2, owner, manager, owner2, top, bottom, acc;

const call = async (method, p, body, token, b = base) => {
  const res = await fetch(b + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const admin = (method, p, body, token = manager) => call(method, `/api/admin${p}`, body, token);
const login = async (email, password) => (await admin('POST', '/login', { email, password })).body.token;
const review = (o, body) => call('POST', `/api/orders/${o.token}/reviews`, body);
const item = async (p, s = store) => (await call('GET', `/api/catalog/${s}/items/${p.id}`)).body.item;

// A pickup order of one unit per product (same size each); paid and handed over unless told otherwise.
async function order(products, { size = 'M', pay = true, deliver = true, phone = '+998901234567', storeId = store } = {}) {
  let cart;
  for (const p of products) {
    const s = p.category === 'accessory' ? 'ONE' : size;
    await db('product_stock').where({ product_id: p.id, size: s }).update({ quantity: 10, reserved: 0 });
    cart = (await call('POST', '/api/cart/items', { token: cart?.token, store_id: storeId, items: [{ product_id: p.id, size: s }] })).body;
  }
  const { order: o, track } = (await call('POST', `/api/cart/${cart.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone })).body;
  const tok = storeId === store ? manager : owner2;
  const steps = [...(pay ? [['pay', { method: 'cash' }]] : []), ...(pay && deliver ? [['status', { status: 'packing' }], ['status', { status: 'delivered' }]] : [])];
  for (const [step, body] of steps) assert.ok([200, 201].includes((await admin('POST', `/orders/${o.id}/${step}`, body, tok)).status));
  return { ...o, token: track.url.split('/').pop() };
}
const rate = async (p, rating, fit = 'right', text) => {
  const o = await order([p]);
  const r = await review(o, { item: o.items[0].id, rating, fit, ...(text && { text }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { o, id: (await db('product_reviews').where({ order_item_id: o.items[0].id }).first()).id };
};

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [store, store2] = (await db('stores').orderBy('id').select('id')).map((s) => s.id);
  await createAdmin(db, { email: 'own@smartfit.uz', password: 'own-pass-1', storeId: store });
  await createAdmin(db, { email: 'mgr@smartfit.uz', password: 'mgr-pass-1', storeId: store, role: 'manager' });
  await createAdmin(db, { email: 'own2@smartfit.uz', password: 'own-pass-2', storeId: store2 });
  server = createApp(db, { telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }), limits: { review: 0 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await login('own@smartfit.uz', 'own-pass-1');
  manager = await login('mgr@smartfit.uz', 'mgr-pass-1');
  owner2 = await login('own2@smartfit.uz', 'own-pass-2');
  const first = (category, offset = 0) => db('products').where({ store_id: store, category, audience: 'adult' }).orderBy('id').offset(offset).first();
  [top, bottom, acc] = [await first('top'), await first('bottom'), await first('accessory')];
});
after(async () => {
  server.close();
  await db.destroy();
});

test('only a handed-over line can be reviewed, once per line, through its own order token; no name, phone or profile', async () => {
  const unpaid = await order([top], { pay: false });
  assert.deepEqual([(await review(unpaid, { item: unpaid.items[0].id, rating: 5, fit: 'right' })).body.code], ['review_not_yet']);
  const paid = await order([top], { deliver: false });
  assert.equal((await review(paid, { item: paid.items[0].id, rating: 5, fit: 'right' })).status, 409, 'paid but not handed over');
  const status = (await call('GET', `/api/orders/${paid.token}`)).body;
  assert.equal(status.fit_open, false);

  const o = await order([top, acc]);
  const other = await order([top]);
  assert.equal((await call('POST', `/api/orders/${'f'.repeat(32)}/reviews`, { item: o.items[0].id, rating: 5, fit: 'right' })).status, 404, 'unknown token');
  assert.equal((await call('POST', '/api/orders/not-a-token/reviews', { item: o.items[0].id, rating: 5, fit: 'right' })).status, 404);
  assert.equal((await review(other, { item: o.items[0].id, rating: 5, fit: 'right' })).status, 404, "another order's line through this token");
  // A double submit (two taps, two tabs) makes one review.
  const body = { item: o.items[0].id, rating: 4, fit: 'small', text: 'Biroz tor' };
  const [a, b] = await Promise.all([review(o, body), review(o, body)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409], `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`);
  assert.equal([a, b].find((r) => r.status === 409).body.code, 'review_exists');
  assert.equal((await review(o, { ...body, rating: 1 })).body.code, 'review_exists', 'no editing (decided)');
  const rows = await db('product_reviews').where({ order_item_id: o.items[0].id });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].rating, rows[0].fit, rows[0].text, rows[0].product_id, rows[0].store_id], [4, 'small', 'Biroz tor', top.id, store]);
  const cols = Object.keys(rows[0]).join(' ');
  assert.ok(!/phone|name|profile|telegram|ip|client/.test(cols), `no personal column: ${cols}`);
  assert.equal((await db('order_items').where({ id: o.items[0].id }).first()).fit, 'small', 'the fit answer is the task 23 answer of the line too');
  // The accessory gets a rating without a fit answer.
  assert.equal((await review(o, { item: o.items[1].id, rating: 5, fit: 'right' })).status, 400, 'no fit for one-size items');
  assert.equal((await review(o, { item: o.items[1].id, rating: 5 })).status, 201);
  const view = (await call('GET', `/api/orders/${o.token}`)).body;
  assert.deepEqual(view.items.map((i) => [i.sized, i.review?.rating, i.review?.fit ?? null]), [[true, 4, 'small'], [false, 5, null]]);
  assert.ok(!JSON.stringify(view).includes('Aziz') && !JSON.stringify(view).includes('+998'), 'still no name or phone on the status page');
});

test('rating, fit and text are checked; text is plain, length-limited and comes back as typed, never as markup', async () => {
  const o = await order([top]);
  const line = o.items[0].id;
  for (const bad of [{ rating: 0, fit: 'right' }, { rating: 6, fit: 'right' }, { rating: 4.5, fit: 'right' }, { rating: '5', fit: 'right' }, { rating: 5, fit: 'tight' },
    { rating: 5 }, { rating: 5, fit: 'right', text: 42 }, { fit: 'right' }]) {
    assert.equal((await review(o, { item: line, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await review(o, { item: String(line), rating: 5, fit: 'right' })).status, 404, 'item must be the line id');
  const long = await review(o, { item: line, rating: 5, fit: 'right', text: 'a'.repeat(501) });
  assert.deepEqual([long.status, long.body.code], [400, 'review_text']);
  assert.equal(await db('product_reviews').where({ order_item_id: line }).first(), undefined, 'nothing stored by the refused tries');
  const markup = '<img src=x onerror=alert(1)> <b>zo\'r</b>‮​\u0007\n\n\n\nyaxshi';
  assert.equal((await review(o, { item: line, rating: 5, fit: 'right', text: markup })).status, 201);
  const kept = (await db('product_reviews').where({ order_item_id: line }).first()).text;
  assert.equal(kept, "<img src=x onerror=alert(1)> <b>zo'r</b>\n\nyaxshi", 'bidi, zero-width and control characters out; tags kept as plain text');
  assert.equal(reviewText('   '), null);
  assert.equal(reviewText('a'.repeat(500)).length, 500);
  // Every page that shows review text sets it as text: no innerHTML anywhere in them.
  for (const f of ['public/app/order.js', 'public/app/group.js', 'public/shared/ui.js']) {
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')), f);
  }
  const app = readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8');
  const part = app.slice(app.indexOf('function reviewSum'), app.indexOf('// The chosen size has none free here'));
  assert.ok(part.includes('textContent: r.text') && !/innerHTML/.test(part), 'item page reviews are text');
  const adm = readFileSync(new URL('../public/admin/admin.js', import.meta.url), 'utf8');
  const list = adm.slice(adm.indexOf('// ---------- Task 46: reviews'), adm.indexOf("const rejf = $('rejectForm')"));
  assert.ok(list.includes('textContent: v.text') && !/innerHTML/.test(list), 'admin list is text');
});

test('averages: visible reviews only, shown from REVIEW_MIN; the fit summary is a hint and never moves the engine size', async () => {
  const p = await db('products').where({ store_id: store, category: 'top', audience: 'adult' }).orderBy('id').offset(3).first();
  assert.deepEqual((await item(p)).rating, { avg: null, count: 0, fit: null });
  await rate(p, 5, 'small', 'Yaxshi');
  await rate(p, 4, 'small');
  let r = (await item(p)).rating;
  assert.deepEqual(r, { avg: null, count: 2, fit: null }, 'below the minimum: count only');
  const { id: third } = await rate(p, 2, 'right');
  r = (await item(p)).rating;
  assert.equal(REVIEW_MIN, 3);
  assert.deepEqual(r, { avg: 3.7, count: 3, fit: 'small' }, '11 / 3 = 3.67 → 3.7; 2 of 3 said small');
  // Hiding one takes it out of the average, the count and the list (the average needs 3 again).
  assert.equal((await admin('POST', `/reviews/${third}/hide`, { reason: 'Sinov uchun' }, owner)).status, 200);
  const it = await item(p);
  assert.deepEqual(it.rating, { avg: null, count: 2, fit: null });
  assert.equal(it.reviews.length, 2);
  assert.ok(it.reviews.every((x) => !('order_id' in x) && !('phone' in x)), 'no order or person in the public list');
  assert.deepEqual(Object.keys(it.reviews[0]).sort(), ['created_at', 'fit', 'rating', 'reply', 'returned', 'size', 'text']);
  await admin('POST', `/reviews/${third}/show`, undefined, owner);
  // The fit summary is a hint line; the size the engine picks is unchanged (task 23's offset needs 5 answers and says so on the card).
  assert.equal((await item(p)).fit_offset, 0);
  assert.equal((await db('products').where({ id: p.id }).first()).fit_offset, null, 'no override written');
  // fitSummary rules.
  assert.equal(fitSummary({ small: 1, right: 1 }), null);
  assert.equal(fitSummary({ small: 2, right: 1 }), 'small');
  assert.equal(fitSummary({ big: 2, right: 2 }), 'mixed');
  assert.equal(fitSummary({ right: 3 }), 'right');
});

test('a returned line keeps its review, marked, in the average (decided); an exchanged line shows the kept size', async () => {
  const p = await db('products').where({ store_id: store, category: 'bottom', audience: 'adult' }).orderBy('id').offset(2).first();
  const ret = await rate(p, 1, 'small', 'Kichik');
  const ex = await rate(p, 4, 'small');
  await rate(p, 4, 'right');
  const key = (c) => c.repeat(32);
  assert.equal((await admin('POST', `/orders/${ret.o.id}/returns`, { key: key('a'), item_id: ret.o.items[0].id, kind: 'return', reason: 'too_small', quantity: 1, restock: true })).status, 201);
  await db('product_stock').where({ product_id: p.id, size: 'L' }).update({ quantity: 5, reserved: 0 });
  assert.equal((await admin('POST', `/orders/${ex.o.id}/returns`, { key: key('b'), item_id: ex.o.items[0].id, kind: 'exchange', reason: 'too_small', quantity: 1, restock: true, new_size: 'L' })).status, 201);
  const it = await item(p);
  assert.deepEqual(it.rating, { avg: 3, count: 3, fit: 'small' }, 'the returned 1 still counts');
  assert.deepEqual(it.reviews.map((x) => [x.rating, x.size, x.returned]), [[4, 'M', false], [4, 'L', false], [1, 'M', true]]);
  const status = (await call('GET', `/api/orders/${ret.o.token}`)).body.items[0];
  assert.deepEqual([status.returned, status.kept_size], [true, null]);
  assert.equal((await call('GET', `/api/orders/${ex.o.token}`)).body.items[0].kept_size, 'L');
  // An exchange before the review: the customer reviews the size they kept.
  const late = await order([p]);
  await db('product_stock').where({ product_id: p.id, size: 'L' }).update({ quantity: 5, reserved: 0 });
  await admin('POST', `/orders/${late.id}/returns`, { key: key('c'), item_id: late.items[0].id, kind: 'exchange', reason: 'too_small', quantity: 1, restock: true, new_size: 'L' });
  assert.equal((await call('GET', `/api/orders/${late.token}`)).body.items[0].kept_size, 'L');
  assert.equal((await review(late, { item: late.items[0].id, rating: 5, fit: 'right' })).status, 201);
  assert.equal((await item(p)).reviews[0].size, 'L');
});

test('catalogue sort by rating and the mall search tiles use the same visible average; bad sort 400', async () => {
  const [a, b] = await db('products').where({ store_id: store, category: 'outerwear', audience: 'adult' }).orderBy('id').limit(2);
  for (const r of [3, 3, 3]) await rate(a, r);
  for (const r of [5, 5, 4]) await rate(b, r);
  const list = (await call('GET', `/api/catalog/${store}?sort=rating`)).body.items;
  const ids = list.map((x) => x.id);
  assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id), 'better average first');
  const rated = list.filter((x) => x.rating.avg != null);
  assert.deepEqual(rated.map((x) => x.rating.avg), [...rated.map((x) => x.rating.avg)].sort((x, y) => y - x), 'rated items by average, descending');
  assert.ok(list.findIndex((x) => x.rating.avg == null) > rated.length - 1 || !list.some((x) => x.rating.avg == null), 'unrated after rated');
  assert.equal(list.find((x) => x.id === b.id).rating.avg, 4.7);
  const plain = (await call('GET', `/api/catalog/${store}`)).body.items;
  assert.equal(plain.find((x) => x.id === b.id).rating.avg, 4.7, 'the default order carries the rating too');
  assert.equal((await call('GET', `/api/catalog/${store}?sort=price`)).status, 400);
  // Mall search: the same number; a shop the mall hides stays out with its ratings.
  const mall = (await db('stores').where({ id: store }).first()).mall_id;
  const found = (await call('GET', `/api/malls/${mall}/search?q=${encodeURIComponent(b.name.slice(0, 6))}`)).body.items.find((x) => x.id === b.id);
  assert.deepEqual(found.rating, (await item(b)).rating);
  await db('stores').where({ id: store }).update({ mall_hidden: true });
  assert.ok(!(await call('GET', `/api/malls/${mall}/search?q=${encodeURIComponent(b.name.slice(0, 6))}`)).body.items.some((x) => x.store_id === store));
  await db('stores').where({ id: store }).update({ mall_hidden: false });
});

test('hiding (owner, reason, audited) and the one answer (owner or manager); the customer sees the answer and the hidden mark', async () => {
  const { o, id } = await rate(bottom, 2, 'small', 'Yoqmadi');
  assert.equal((await admin('POST', `/reviews/${id}/hide`, { reason: 'Haqoratli' }, manager)).status, 403, 'a manager does not hide (decided)');
  for (const reason of [undefined, '', '  ', 'ab', 'x'.repeat(201)]) assert.equal((await admin('POST', `/reviews/${id}/hide`, { reason }, owner)).status, 400, String(reason));
  assert.equal((await admin('POST', `/reviews/${id}/hide`, { reason: 'Haqoratli so\'z' }, owner)).status, 200);
  assert.equal((await admin('POST', `/reviews/${id}/hide`, { reason: 'Yana' }, owner)).body.code, 'review_hidden');
  const audit = await db('audit_log').where({ action: 'review.hide', entity_id: id });
  assert.equal(audit.length, 1);
  assert.match(JSON.stringify(json(audit[0].after)), /Haqoratli/);
  const mine = (await call('GET', `/api/orders/${o.token}`)).body.items[0].review;
  assert.deepEqual([mine.hidden, 'hidden_reason' in mine], [true, false], 'the customer sees it hidden, not the reason');
  assert.ok(!(await item(bottom)).reviews.some((x) => x.text === 'Yoqmadi'));
  const list = (await admin('GET', '/reviews?show=hidden', undefined, owner)).body;
  assert.ok(list.items.some((x) => x.id === id && x.hidden_reason === "Haqoratli so'z"));
  assert.equal((await admin('POST', `/reviews/${id}/show`, undefined, manager)).status, 403);
  assert.equal((await admin('POST', `/reviews/${id}/show`, undefined, owner)).status, 200);
  // One answer: two parallel clicks answer once; a manager may answer.
  const [a, b] = await Promise.all([admin('POST', `/reviews/${id}/reply`, { text: 'Uzr, almashtirib beramiz' }), admin('POST', `/reviews/${id}/reply`, { text: 'Ikkinchi javob' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((await admin('POST', `/reviews/${id}/reply`, { text: 'Yana' }, owner)).body.code, 'review_replied');
  assert.equal((await admin('POST', '/reviews/999999/reply', { text: 'Salom' })).status, 404);
  for (const text of [undefined, 'a', 'x'.repeat(501)]) assert.equal((await admin('POST', `/reviews/${(await rate(bottom, 3)).id}/reply`, { text })).status, 400);
  const pub = (await item(bottom)).reviews.find((x) => x.text === 'Yoqmadi');
  assert.ok(['Uzr, almashtirib beramiz', 'Ikkinchi javob'].includes(pub.reply));
  assert.equal((await call('GET', `/api/orders/${o.token}`)).body.items[0].review.reply, pub.reply);
  assert.equal((await db('audit_log').where({ action: 'review.reply', entity_id: id })).length, 1);
  assert.equal((await admin('GET', '/reviews?show=nope', undefined, owner)).status, 400);
  const low = (await admin('GET', '/reviews?show=low', undefined, owner)).body.items;
  assert.ok(low.length && low.every((x) => x.rating <= 2));
});

test('admin scope: a shop never sees another shop\'s reviews; the mall admin sees none; the report and the dashboard', async () => {
  const p2 = await db('products').where({ store_id: store2, category: 'top', audience: 'adult' }).orderBy('id').first();
  const o2 = await order([p2], { storeId: store2 });
  assert.equal((await review(o2, { item: o2.items[0].id, rating: 1, fit: 'big', text: 'SHOP2-ONLY' })).status, 201);
  for (const q of ['', `?store_id=${store2}`, '?show=low']) {
    const r = await admin('GET', `/reviews${q}`, undefined, owner);
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.body).includes('SHOP2-ONLY') && r.body.items.every((x) => x.store_id === store), q);
    assert.ok(r.body.products.every((x) => x.store_id === store));
  }
  const id2 = (await db('product_reviews').where({ text: 'SHOP2-ONLY' }).first()).id;
  for (const [path, body] of [['hide', { reason: 'Begona' }], ['show', undefined], ['reply', { text: 'Begona' }]]) {
    assert.equal((await admin('POST', `/reviews/${id2}/${path}`, body, owner)).status, 404, path);
  }
  const own2 = (await admin('GET', '/reviews', undefined, owner2)).body;
  assert.deepEqual(own2.items.map((x) => x.text), ['SHOP2-ONLY']);
  assert.deepEqual(own2.products.map((x) => [x.product_id, x.avg, x.fit.big]), [[p2.id, 1, 1]]);
  // A mall admin reaches none of it.
  const mall = (await db('stores').where({ id: store }).first()).mall_id;
  await createAdmin(db, { email: 'mall@smartfit.uz', password: 'mall-pass-1', mallId: mall });
  const mallTok = await login('mall@smartfit.uz', 'mall-pass-1');
  for (const [m, p] of [['GET', '/reviews'], ['POST', `/reviews/${id2}/hide`], ['POST', `/reviews/${id2}/reply`], ['GET', '/dashboard']]) {
    assert.equal((await admin(m, p, m === 'GET' ? undefined : { reason: 'abc', text: 'abc' }, mallTok)).status, 403, `${m} ${p}`);
  }
  // Report: lowest average first; the dashboard shows the same, five at most, scoped.
  const rep = (await admin('GET', '/reviews', undefined, owner)).body.products;
  assert.deepEqual(rep.map((x) => x.avg), [...rep.map((x) => x.avg)].sort((a, b) => a - b));
  const dash = (await admin('GET', '/dashboard', undefined, owner)).body.reviews;
  assert.deepEqual(dash, rep.slice(0, 5));
  assert.ok(!(await admin('GET', '/dashboard', undefined, owner2)).body.reviews.some((x) => x.store_id === store));
});

test('the review route is rate-limited per IP', async () => {
  const limited = createApp(db, { telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }), limits: { review: 2 } }).listen(0);
  await new Promise((r) => limited.once('listening', r));
  try {
    const url = `http://127.0.0.1:${limited.address().port}`;
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await call('POST', `/api/orders/${'e'.repeat(32)}/reviews`, { item: 1, rating: 5 }, undefined, url)).status);
    assert.deepEqual(codes, [404, 404, 429, 429]);
    assert.equal((await call('GET', `/api/orders/${'e'.repeat(32)}`, undefined, undefined, url)).status, 404, 'the status page is not in that bucket');
  } finally {
    limited.close();
  }
});

test('a read-only shop\'s customer can still review (decided); its admin cannot hide or answer', async () => {
  const p = await db('products').where({ store_id: store, category: 'shoes', audience: 'adult' }).orderBy('id').first();
  const o = await order([p], { size: (await db('product_stock').where({ product_id: p.id }).orderBy('size').first()).size });
  const org = (await db('stores').where({ id: store }).first()).organization_id;
  await db('organizations').where({ id: org }).update({ plan: 'pro', paid_until: '2020-01-01' });
  try {
    assert.equal((await review(o, { item: o.items[0].id, rating: 5, fit: 'right' })).status, 201);
    const id = (await db('product_reviews').where({ order_item_id: o.items[0].id }).first()).id;
    assert.equal((await admin('POST', `/reviews/${id}/reply`, { text: 'Rahmat' }, owner)).body.code, 'plan_readonly');
    assert.equal((await admin('POST', `/reviews/${id}/hide`, { reason: 'Sabab' }, owner)).body.code, 'plan_readonly');
    assert.equal((await admin('GET', '/reviews', undefined, owner)).status, 200, 'reading stays');
  } finally {
    await db('organizations').where({ id: org }).update({ plan: 'biznes', paid_until: null });
  }
});

test('"delete my data" takes the customer\'s reviews in that organisation; the Telegram hand-over line asks for the rating', async () => {
  const o = await order([top], { phone: '+998935550011' });
  await review(o, { item: o.items[0].id, rating: 3, fit: 'right', text: 'Mening fikrim' });
  const o2 = await order([top], { phone: '+998935550012' });
  await review(o2, { item: o2.items[0].id, rating: 3, fit: 'right', text: 'Boshqa odam' });
  const org = (await db('stores').where({ id: store }).first()).organization_id;
  const [{ id }] = await db('customer_profiles').insert({ organization_id: org, telegram_user_id: 99001, phone: '+998935550011', name: 'Aziz', consent_at: new Date().toISOString() }).returning('id');
  await deleteProfiles(db, [id]);
  assert.equal(await db('product_reviews').where({ text: 'Mening fikrim' }).first(), undefined);
  assert.ok(await db('product_reviews').where({ text: 'Boshqa odam' }).first(), "another customer's review stays");
  const msg = message({ store_name: 'Demo', number: 7, status: 'delivered', payment_status: 'paid', fulfillment: 'pickup', notify_token: 'a'.repeat(32), total: 1 }, 'https://x.uz/order/aaa');
  assert.match(msg, /baholang/);
  assert.match(msg, /https:\/\/x\.uz\/order\/aaa$/);
  assert.doesNotMatch(message({ store_name: 'Demo', number: 7, status: 'packing', payment_status: 'paid', fulfillment: 'pickup', total: 1 }, 'https://x.uz/o'), /baholang/);
});

test('demo seed: the demo item pages show an average, a fit summary and a shop answer; migration 036 down and up', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await seed(m);
    assert.equal((await m('product_reviews').count({ n: '*' }))[0].n, 0, 'seed() (the tests) adds no reviews');
    await seedDemoReviews(m);
    const app = createApp(m, { telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }) }).listen(0);
    await new Promise((r) => app.once('listening', r));
    try {
      const url = `http://127.0.0.1:${app.address().port}`;
      const s1 = (await m('stores').orderBy('id').first()).id;
      const first = (c) => m('products').where({ store_id: s1, category: c, audience: 'adult' }).orderBy('id').first();
      const t = (await call('GET', `/api/catalog/${s1}/items/${(await first('top')).id}`, undefined, undefined, url)).body.item;
      const avg = (l) => Math.round((l.reduce((a, [r]) => a + r, 0) / l.length) * 10) / 10;
      assert.deepEqual(t.rating, { avg: avg(DEMO_REVIEWS.top), count: 4, fit: 'right' });
      const b = (await call('GET', `/api/catalog/${s1}/items/${(await first('bottom')).id}`, undefined, undefined, url)).body.item;
      assert.deepEqual(b.rating, { avg: avg(DEMO_REVIEWS.bottom), count: 3, fit: 'small' });
      assert.ok(b.reviews.some((x) => x.reply));
      // The demo orders stay out of the 7/30-day numbers.
      assert.equal((await m('orders').where('created_at', '>', new Date(Date.now() - 31 * 86_400_000).toISOString()).count({ n: '*' }))[0].n, 0);
    } finally {
      app.close();
    }
    await m.migrate.down(); // 043
    await m.migrate.down(); // 042
    await m.migrate.down(); // 041
    await m.migrate.down(); // 040
    await m.migrate.down(); // 039
    await m.migrate.down(); // 038
    await m.migrate.down(); // 037
    await m.migrate.down();
    assert.equal(await m.schema.hasTable('product_reviews'), false);
    await m.migrate.latest();
    assert.equal(await m.schema.hasTable('product_reviews'), true);
  } finally {
    await m.destroy();
  }
});
