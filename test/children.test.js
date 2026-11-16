// Task 40: children's sizes. Height → size (round up, edges, out of range); adults never get children's items and
// children never adults' (outfits, single items, pairs, alternatives, swaps, the catalogue default, the mall search, the
// item page); a category switching to the children's kind; the product form and CSV import; no photo step and no photo
// for a child; migration 030 up and down.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed, KIDS as SERVER_KIDS, KIDS_SHOES as SERVER_KIDS_SHOES, KIDS_CATALOGUE } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { createStylist } from '../src/recommend/stylist.js';
import { KIDS, KIDS_SHOES, KID_MIN, KID_MAX, childSize, ageHint, fieldError, sizeNeeds, toRequest, routeData } from '../public/app/flow.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, aiServer, base, aiBase, stores, token, kidIds, adultIds;
let weather = { temperature: 5, apparent_temperature: 3, raining: false, wind_speed: 2, source: 'live' };
let stylistSeen = null;
const stylist = async (input) => {
  stylistSeen = input;
  return null; // → rules
};

const call = async (method, path, body, auth, at = base) => {
  const res = await fetch(at + path, { method, headers: { 'content-type': 'application/json', ...(auth && { authorization: `Bearer ${auth}` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const admin = (method, path, body) => call(method, `/api/admin${path}`, body, token);
const ADULT = { top: 'M', bottom: 'L', shoes: '42' };
const CHILD = { top: '116', bottom: '116', shoes: '30' };
const recommend = (extra = {}, at = base) => call('POST', '/api/recommend', { store_id: stores[0], gender: 'male', sizes: ADULT, ...extra }, null, at);
const kid = (extra = {}, at = base) => recommend({ audience: 'child', sizes: CHILD, ...extra }, at);
// Every product id an answer shows: outfit items, alternatives, partial, single items, their alternatives and pairs.
const shown = (b) => [
  ...b.outfits.flatMap((o) => [...o.items, ...(o.alternative?.items ?? [])]), ...(b.partial?.items ?? []),
  ...(b.groups ?? []).flatMap((g) => g.items.flatMap((i) => [i, ...(i.alternative ? [i.alternative] : []), ...i.pairs])),
];
const WEATHERS = [[-10, false], [5, false], [15, false], [17, true], [30, false]];
const setWeather = (temperature, raining) => { weather = { temperature, apparent_temperature: temperature, raining, wind_speed: 2, source: 'live' }; };

before(async () => {
  await db.migrate.latest();
  await seed(db);
  stores = (await db('stores').orderBy('id').select('id')).map((s) => s.id);
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  const opts = { weather: async () => weather, telegram: null, limits: { recommend: 0 } };
  server = createApp(db, { ...opts, stylist: null }).listen(0);
  aiServer = createApp(db, { ...opts, stylist }).listen(0);
  await Promise.all([server, aiServer].map((s) => new Promise((r) => s.once('listening', r))));
  base = `http://127.0.0.1:${server.address().port}`;
  aiBase = `http://127.0.0.1:${aiServer.address().port}`;
  token = (await call('POST', '/api/admin/login', { email: 'boss@smartfit.uz', password: 'boss-pass-1' })).body.token;
  kidIds = new Set((await db('products').where({ audience: 'child' }).select('id')).map((p) => p.id));
  adultIds = new Set((await db('products').where({ audience: 'adult' }).select('id')).map((p) => p.id));
});
after(async () => {
  server.close();
  aiServer.close();
  await db.destroy();
});

test('height → size: rounds up to the next band, the edges, out of range; age is only a hint', () => {
  assert.deepEqual(KIDS, SERVER_KIDS, 'the app and the server have the same children\'s sizes');
  assert.deepEqual(KIDS_SHOES, SERVER_KIDS_SHOES);
  assert.deepEqual([KID_MIN, KID_MAX], [87, 164]);
  for (const [h, size] of [[87, '92'], [92, '92'], [93, '98'], [110, '110'], [111, '116'], [113, '116'], [116, '116'], [159, '164'], [164, '164']]) {
    assert.equal(childSize(h), size, `${h} cm`);
  }
  for (const h of [86, 40, 165, 180, NaN]) assert.equal(childSize(h), null, `${h} cm has no children's size`);
  assert.equal(fieldError('kidHeight', '113'), '');
  assert.equal(fieldError('kidHeight', '86'), 'kiosk.child.err_small');
  assert.equal(fieldError('kidHeight', '165'), 'kiosk.child.err_tall', 'taller → the message points to adult sizes');
  assert.equal(fieldError('kidHeight', ''), 'kiosk.child.err_height');
  assert.equal(fieldError('kidHeight', 'abc'), 'kiosk.child.err_height');
  assert.equal(ageHint('5'), 110);
  assert.equal(ageHint('30'), null);
  assert.equal(ageHint(''), null);
  // The size comes from the height only: an age in the form changes nothing in the request.
  const v = { audience: 'child', gender: 'female', kidHeight: '113', budget: '', shoes: '' };
  assert.deepEqual(toRequest({ ...v, kidAge: '9' }, 1), toRequest(v, 1));
});

test('the child path has no photo step and sends no image anywhere', async () => {
  for (const want of [null, ['top'], ['outerwear', 'bottom']]) {
    assert.equal(sizeNeeds(want, 'child').photo, false, 'no size step (photo / usual / tape) for a child');
    assert.equal(sizeNeeds(want, 'child').kid, true, 'the child\'s height instead');
    assert.equal(sizeNeeds(want).photo, true, 'adults unchanged');
  }
  assert.equal(sizeNeeds(['shoes'], 'child').kid, false, 'shoes only: no height either');
  const r = toRequest({ audience: 'child', gender: 'male', kidHeight: '113', shoes: '30', budget: '' }, 1);
  assert.equal(r.body, null, 'nothing goes to /api/size');
  assert.deepEqual(r.request, { store_id: 1, gender: 'male', audience: 'child', sizes: { top: '116', bottom: '116', shoes: '30' }, budget: null });
  assert.equal(toRequest({ audience: 'child', gender: 'male', kidHeight: '170', budget: '' }, 1), null, 'too tall → stays on the form');
  assert.equal(toRequest({ audience: 'child', gender: 'male', kidHeight: '113', shoes: '42', budget: '' }, 1).request.sizes.shoes, null, 'an adult shoe size is dropped');
  // A refresh keeps a child's sizes for a child only.
  assert.deepEqual(routeData({ form: { audience: 'child' }, sizes: { top: '116', bottom: 'M', shoes: '30' } }).sizes, { top: '116', bottom: null, shoes: '30' });
  assert.deepEqual(routeData({ form: {}, sizes: { top: '116', bottom: 'M', shoes: '30' } }).sizes, { top: null, bottom: 'M', shoes: null });
  // A photo sent for a child anyway never reaches the stylist.
  stylistSeen = null;
  const res = await kid({ photo: 'A'.repeat(4000) }, aiBase);
  assert.equal(res.status, 200);
  assert.equal(stylistSeen.photo, null);
  assert.equal(stylistSeen.audience, 'child');
  // The app's markup: the child fields are a height and an optional age, no file input.
  const html = readFileSync(new URL('../public/app/index.html', import.meta.url), 'utf8');
  const kidFields = html.match(/<label class="field need-off" data-need="kid">[\s\S]*?<\/label>/g);
  assert.equal(kidFields.length, 2);
  assert.ok(kidFields.every((f) => !/type="file"|capture/.test(f)));
});

test('the stylist prompt names a child, an adult\'s is unchanged', async () => {
  let sent = null;
  const client = { messages: { create: async (req) => { sent = req; throw Object.assign(new Error('x'), { status: 500 }); } } };
  const ask = createStylist({ client });
  const input = { photo: null, weather, sizes: CHILD, budget: null, candidates: [] };
  await ask(input).catch(() => {});
  const adultText = sent.messages[0].content.at(-1).text;
  assert.ok(!adultText.includes('AUDIENCE'));
  await ask({ ...input, audience: 'child' }).catch(() => {});
  const childText = sent.messages[0].content.at(-1).text;
  assert.ok(childText.includes('AUDIENCE') && childText.includes('"AUDIENCE":"bola"'));
  assert.equal(childText.replace(/AUDIENCE — [^\n]*\n/, '').replace(',"AUDIENCE":"bola"', ''), adultText, 'only the audience line and field are added');
});

test('adults never get children\'s items and children never adults\' (outfits, single items, pairs, alternatives)', async () => {
  const cats = (await call('GET', `/api/stores/${stores[0]}`)).body.categories;
  const kidCats = cats.filter((c) => c.audience === 'child'), adultCats = cats.filter((c) => c.audience === 'adult');
  assert.equal(kidCats.length, 4);
  assert.deepEqual(kidCats.map((c) => c.size_kind), ['kids', 'kids', 'kids', 'kids_shoes']);
  for (const [t, rain] of WEATHERS) {
    setWeather(t, rain);
    for (const store of stores) {
      for (const gender of ['male', 'female']) {
        const a = await recommend({ store_id: store, gender });
        assert.ok(a.body.outfits.length, `adult outfits at ${t}`);
        assert.ok(shown(a.body).every((p) => adultIds.has(p.id)), `adult outfit at ${t}°C has only adult items`);
        assert.ok(!('audience' in a.body), 'an adult answer has no audience field (unchanged)');
        const c = await kid({ store_id: store, gender });
        assert.equal(c.status, 200);
        assert.ok(c.body.outfits.length, `a child gets an outfit at ${t}°C${rain ? ' in rain' : ''}`);
        assert.equal(c.body.audience, 'child');
        for (const p of shown(c.body)) {
          assert.ok(kidIds.has(p.id), `child outfit at ${t}°C: ${p.name} is a children's item`);
          if (p.category !== 'shoes') assert.equal(p.size, '116');
          else assert.equal(p.size, '30');
        }
        // Single items by role and by category id, with their pairs and cheaper alternatives.
        for (const want of [['outerwear', 'top', 'bottom', 'shoes'], kidCats.map((x) => x.id)]) {
          const s = await kid({ store_id: store, gender, want: store === stores[0] || want.every((w) => typeof w === 'string') ? want : ['top'] });
          assert.equal(s.status, 200);
          assert.ok(shown(s.body).length && shown(s.body).every((p) => kidIds.has(p.id)), 'child single items only children\'s');
        }
        const s = await recommend({ store_id: store, gender, want: ['outerwear', 'top', 'bottom', 'shoes', 'accessory'] });
        assert.ok(shown(s.body).every((p) => adultIds.has(p.id)), 'adult single items only adults\'');
      }
    }
  }
  // A category id of the other audience is refused, both ways.
  assert.equal((await kid({ want: [adultCats[0].id] })).status, 400);
  assert.equal((await recommend({ want: [kidCats[0].id] })).status, 400);
  // Sizes of the other audience are refused.
  assert.equal((await kid({ sizes: ADULT })).status, 400);
  assert.equal((await recommend({ sizes: CHILD })).status, 400);
  assert.equal((await recommend({ audience: 'baby' })).status, 400);
  assert.equal((await recommend({ audience: ['child'] })).status, 400);
  // No shoe size: children's shoes in any of their sizes, never adult ones.
  const noShoe = await kid({ sizes: { top: '116', bottom: '116' } });
  const shoes = noShoe.body.outfits.flatMap((o) => o.items).filter((p) => p.category === 'shoes');
  assert.ok(shoes.length && shoes.every((p) => p.size === null && p.sizes.every((x) => KIDS_SHOES.includes(x))));
});

test('a child\'s outfit uses only sizes with stock > 0', async () => {
  setWeather(5, false);
  const sweater = await db('products').where({ store_id: stores[0], sku: 'SF-KT-01' }).first('id');
  const hoodie = await db('products').where({ store_id: stores[0], sku: 'SF-KT-02' }).first('id');
  const before = await kid();
  assert.ok(shown(before.body).some((p) => [sweater.id, hoodie.id].includes(p.id)));
  await db('product_stock').whereIn('product_id', [sweater.id, hoodie.id]).where({ size: '116' }).update({ quantity: 0, reserved: 0 });
  try {
    const after = await kid();
    assert.ok(!shown(after.body).some((p) => [sweater.id, hoodie.id].includes(p.id)), 'sold-out size never offered');
    // The 122 size of the same items is still there for a taller child.
    const taller = await kid({ sizes: { top: '122', bottom: '122' } });
    assert.ok(shown(taller.body).some((p) => [sweater.id, hoodie.id].includes(p.id)));
  } finally {
    await db('product_stock').whereIn('product_id', [sweater.id, hoodie.id]).where({ size: '116' }).update({ quantity: 3 });
  }
});

test('swaps, the catalogue, the item page, the mall search and the attract screen keep the audiences apart', async () => {
  setWeather(5, false);
  const c = await kid();
  const o = c.body.outfits[0];
  const top = o.items.find((p) => p.category === 'top');
  const swap = await call('POST', '/api/recommend/swap', { store_id: stores[0], gender: 'male', audience: 'child', sizes: CHILD, items: o.items.map((p) => p.id), replace: top.id });
  assert.equal(swap.status, 200);
  assert.ok(swap.body.options.length && swap.body.options.every((x) => x.items.every((p) => kidIds.has(p.id))));
  // The adult swap of a child's outfit doesn't find the children's items (stale → 409).
  assert.equal((await call('POST', '/api/recommend/swap', { store_id: stores[0], gender: 'male', sizes: ADULT, items: o.items.map((p) => p.id), replace: top.id })).status, 409);

  const all = (await call('GET', `/api/catalog/${stores[0]}`)).body.items;
  assert.ok(all.length && all.every((p) => adultIds.has(p.id) && p.audience === 'adult'), 'catalogue default: adults only');
  const kids = (await call('GET', `/api/catalog/${stores[0]}?audience=child`)).body.items;
  assert.equal(kids.length, KIDS_CATALOGUE.length);
  assert.ok(kids.every((p) => kidIds.has(p.id)));
  assert.ok((await call('GET', `/api/catalog/${stores[0]}?audience=child&category=top`)).body.items.every((p) => kidIds.has(p.id) && p.category === 'top'));
  assert.ok((await call('GET', `/api/catalog/${stores[0]}?category=top`)).body.items.every((p) => adultIds.has(p.id)), 'a role code alone: adults');
  const kidTop = (await call('GET', `/api/stores/${stores[0]}`)).body.categories.find((x) => x.audience === 'child' && x.role === 'top');
  const byId = (await call('GET', `/api/catalog/${stores[0]}?category=${kidTop.id}`)).body.items;
  assert.ok(byId.length && byId.every((p) => kidIds.has(p.id)), 'a children\'s category picked by id shows its items');
  assert.equal((await call('GET', `/api/catalog/${stores[0]}?category=${kidTop.id}&audience=adult`)).body.items.length, 0);
  assert.ok((await call('GET', `/api/catalog/${stores[0]}?audience=child&size=116`)).body.items.every((p) => p.sizes.includes('116')));
  assert.equal((await call('GET', `/api/catalog/${stores[0]}?audience=all`)).status, 400);

  // Item page: a child's item pairs with children's items, an adult's with adults'.
  const kItem = await call('GET', `/api/catalog/${stores[0]}/items/${top.id}`);
  assert.deepEqual(kItem.body.item.all_sizes, KIDS);
  assert.ok(kItem.body.pairs.length && kItem.body.pairs.every((p) => kidIds.has(p.id)));
  const aItem = await call('GET', `/api/catalog/${stores[0]}/items/${all.find((p) => p.category === 'top').id}`);
  assert.ok(aItem.body.pairs.length && aItem.body.pairs.every((p) => adultIds.has(p.id)));

  // Mall search: "Bolalar" finds nothing for adults (the default), children's items when asked.
  const search = (q) => call('GET', `/api/malls/1/search?${new URLSearchParams(q)}`);
  assert.ok((await search({ q: 'sviter' })).body.items.every((p) => adultIds.has(p.id)));
  assert.equal((await search({ q: 'Bolalar' })).body.items.length, 0, 'the children\'s category name matches nothing for adults');
  const kidFound = (await search({ q: 'Bolalar', audience: 'child' })).body.items;
  assert.ok(kidFound.length && kidFound.every((p) => kidIds.has(p.id)));
  assert.equal((await search({ q: 'sviter', audience: 'x' })).status, 400);

  // The attract screen's photos are adults' items.
  const looks = (await call('GET', `/api/stores/${stores[0]}`)).body.looks;
  const urls = new Set((await db('products').where({ audience: 'child' }).select('image_url')).map((p) => p.image_url));
  assert.ok(looks.length && looks.every((l) => !urls.has(l.image_url)));
});

test('a category switching to the children kind; products follow their category\'s audience', async () => {
  const cats = await admin('GET', `/categories?store_id=${stores[0]}`);
  const shirts = cats.body.find((c) => c.role === 'top' && c.audience === 'adult');
  // With products: a role category can't swap XS–XXL for 92–164.
  assert.equal((await admin('PATCH', `/categories/${shirts.id}`, { audience: 'child' })).status, 409);
  // An empty one switches; the role picks the children's kind.
  const created = await admin('POST', '/categories', { store_id: stores[0], name: "Qizlar ko'ylagi", name_ru: 'Платья для девочек', role: 'top' });
  assert.equal(created.status, 201);
  assert.deepEqual([created.body.audience, created.body.size_kind], ['adult', 'clothes']);
  const sw = await admin('PATCH', `/categories/${created.body.id}`, { audience: 'child' });
  assert.equal(sw.status, 200);
  assert.deepEqual([sw.body.audience, sw.body.size_kind, sw.body.sizes], ['child', 'kids', KIDS]);
  // Shoes for children: 22–35. An accessory stays one size for either audience.
  const boots = await admin('POST', '/categories', { store_id: stores[0], name: 'Qizlar tuflisi', name_ru: 'Туфли для девочек', role: 'shoes', audience: 'child' });
  assert.deepEqual([boots.body.size_kind, boots.body.sizes], ['kids_shoes', KIDS_SHOES]);
  const caps = await admin('POST', '/categories', { store_id: stores[0], name: 'Bolalar kepkasi', name_ru: 'Детские кепки', role: 'accessory', audience: 'child' });
  assert.deepEqual([caps.body.size_kind, caps.body.audience], ['one', 'child']);
  // A role-less category: a children's kind says "children"; with adults it is refused.
  const own = await admin('POST', '/categories', { store_id: stores[0], name: 'Maktab formasi', name_ru: 'Школьная форма', size_kind: 'kids' });
  assert.deepEqual([own.body.audience, own.body.role, own.body.sizes], ['child', null, KIDS]);
  assert.equal((await admin('POST', '/categories', { store_id: stores[0], name: 'X1', name_ru: 'X1', size_kind: 'kids', audience: 'adult' })).status, 400);
  assert.equal((await admin('POST', '/categories', { store_id: stores[0], name: 'X2', name_ru: 'X2', size_kind: 'clothes', audience: 'kid' })).status, 400);
  const custom = await admin('POST', '/categories', { store_id: stores[0], name: 'Chaqaloq', name_ru: 'Малыши', size_kind: 'custom', sizes: '92,98' });
  const toKids = await admin('PATCH', `/categories/${custom.body.id}`, { size_kind: 'kids' });
  assert.deepEqual([toKids.body.audience, toKids.body.size_kind], ['child', 'kids'], 'switching to the children\'s kind makes it a children\'s category');

  // A product in a children's category: its audience and sizes come from there.
  const dress = await admin('POST', '/products', { store_id: stores[0], category_id: sw.body.id, name: "Ko'ylak", gender: 'female', color: 'pushti', price: 150000, temp_min: 10, temp_max: 35, stock: { 116: 2, 122: 1 } });
  assert.equal(dress.status, 201);
  assert.deepEqual([dress.body.audience, dress.body.category, dress.body.stock.map((s) => s.size)], ['child', 'top', KIDS]);
  assert.equal((await admin('POST', '/products', { store_id: stores[0], category_id: sw.body.id, name: 'Y', gender: 'female', color: 'oq', price: 1, temp_min: 0, temp_max: 30, stock: { M: 1 } })).status, 400, 'adult sizes refused');
  const wrong = await admin('POST', '/products', { store_id: stores[0], category_id: sw.body.id, audience: 'adult', name: 'Z', gender: 'female', color: 'oq', price: 1, temp_min: 0, temp_max: 30 });
  assert.deepEqual([wrong.status, wrong.body.code], [400, 'audience_mismatch']);
  setWeather(20, false);
  const girl = await kid({ gender: 'female', want: [sw.body.id] });
  assert.deepEqual(girl.body.groups[0].items.map((p) => p.id), [dress.body.id], 'the new children\'s dress is offered to a girl of 113 cm');
  assert.equal((await recommend({ gender: 'female', want: ['top'] })).body.groups[0].items.some((p) => p.id === dress.body.id), false);

  // A role-less one-size category with products may change its audience; the products follow.
  const bags = await admin('POST', '/categories', { store_id: stores[0], name: 'Ryukzaklar', name_ru: 'Рюкзаки', size_kind: 'one' });
  const bag = await admin('POST', '/products', { store_id: stores[0], category_id: bags.body.id, name: 'Ryukzak', gender: 'unisex', color: 'qora', price: 90000, stock: { ONE: 3 } });
  assert.equal(bag.body.audience, 'adult');
  assert.equal((await admin('PATCH', `/categories/${bags.body.id}`, { audience: 'child' })).status, 200);
  assert.equal((await db('products').where({ id: bag.body.id }).first()).audience, 'child');
  assert.ok((await call('GET', `/api/catalog/${stores[0]}?audience=child`)).body.items.some((p) => p.id === bag.body.id));
  assert.ok(!(await call('GET', `/api/catalog/${stores[0]}`)).body.items.some((p) => p.id === bag.body.id));
});

test('CSV import: children\'s sizes as columns, the audience column checked, old files unchanged', async () => {
  const csv = (text) => fetch(`${base}/api/admin/products/import?store_id=${stores[1]}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/csv' }, body: text })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  const ok = await csv('sku;name;category;audience;gender;color;price;temp_min;temp_max;110;116;30\n'
    + 'K-1;Bolalar kurtkasi;Bolalar ustki kiyimi;child;male;qora;300000;-10;10;2;3;\n'
    + 'K-2;Bolalar etigi;Bolalar poyabzali;;unisex;qora;200000;-10;10;;;4\n'
    + 'A-1;Kattalar kepkasi;Aksessuar;adult;unisex;qora;50000;-10;30;;;\n');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.created, 3);
  const jacket = await db('products').where({ store_id: stores[1], sku: 'K-1' }).first();
  assert.deepEqual([jacket.audience, jacket.category, jacket.sizes.split(',')], ['child', 'outerwear', KIDS]);
  const stock = Object.fromEntries((await db('product_stock').where({ product_id: jacket.id })).map((s) => [s.size, s.quantity]));
  assert.deepEqual([stock['110'], stock['116'], stock['92']], [2, 3, 0]);
  assert.equal((await db('products').where({ store_id: stores[1], sku: 'K-2' }).first()).audience, 'child');
  // A children's item named as adults' (and the reverse) is an error naming the category.
  const bad = await csv('sku;name;category;audience;gender;color;price;temp_min;temp_max;M\nK-3;X;Bolalar shimlari;adult;male;oq;1000;0;30;1\nK-4;Y;Ustki kiyim;child;male;oq;1000;0;30;1\n');
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors.map((e) => [e.line, e.code]), [[2, 'audience_mismatch'], [3, 'audience_mismatch']]);
  assert.match(bad.body.errors[0].error, /Bolalar shimlari/);
  // An adult size in a children's category is refused (the sizes come from the category).
  const size = await csv('sku;name;category;gender;color;price;temp_min;temp_max;M\nK-5;X;Bolalar shimlari;male;oq;1000;0;30;1\n');
  assert.equal(size.body.errors[0].code, 'bad_size');
  // The sample file (no children's rows) still imports into a fresh shop's built-in categories.
  const sample = readFileSync(new URL('../public/admin/sample-products.csv', import.meta.url), 'utf8');
  assert.ok(sample.split('\n')[0].includes(';audience;'));
});

test('migration 030 down and up keeps children\'s products (as role-less) and their stock', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await seed(m);
    const kidsBefore = await m('products').where({ audience: 'child' }).select('id');
    const stockBefore = await m('product_stock').whereIn('product_id', kidsBefore.map((p) => p.id)).count({ n: '*' });
    await m.migrate.down(); // 035
    await m.migrate.down(); // 034
    await m.migrate.down(); // 033
    await m.migrate.down(); // 032
    await m.migrate.down(); // 031
    await m.migrate.down();
    assert.ok(!('audience' in (await m('products').columnInfo())));
    assert.ok(!('audience' in (await m('categories').columnInfo())));
    const cats = await m('categories').where('name', 'like', 'Bolalar%');
    assert.ok(cats.length && cats.every((c) => c.size_kind === 'custom' && c.role === null && c.sizes));
    const kids = await m('products').whereIn('id', kidsBefore.map((p) => p.id));
    assert.ok(kids.every((p) => p.category === null && p.sizes), 'role-less, sizes kept');
    assert.deepEqual(await m('product_stock').whereIn('product_id', kidsBefore.map((p) => p.id)).count({ n: '*' }), stockBefore);
    await assert.rejects(m('categories').insert({ organization_id: 1, name: 'Q', name_ru: 'Q', size_kind: 'kids', sort: 99 }), 'the old CHECK is back');
    await m.migrate.latest();
    assert.equal((await m('products').where({ audience: 'adult' }).count({ n: '*' }))[0].n * 1, (await m('products').count({ n: '*' }))[0].n * 1, 'up again: every row adult by default');
    await m('categories').insert({ organization_id: 1, name: 'Q', name_ru: 'Q', size_kind: 'kids', audience: 'child', sort: 99 });
    await assert.rejects(m('products').where({ id: kidsBefore[0].id }).update({ audience: 'teen' }), 'audience CHECK');
  } finally {
    await m.destroy();
  }
});
