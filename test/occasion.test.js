// Task 33, "Qayerga kiyasiz?": the optional occasion only re-ranks (outfits, single items, swaps, the Claude prompt),
// an unknown value is rejected, the stock > 0 rule still holds, the rules work without a Claude key, it is logged
// without personal data, the Talab page counts demand per occasion, and requests without one answer exactly as before.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testDb } from './helpers/db.js';
import { noOccasionCases, compact } from './helpers/answers.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { buildOutfits, singleItems, swapOptions, OCCASIONS } from '../src/recommend/engine.js';
import { createStylist } from '../src/recommend/stylist.js';
import { OCCASIONS as APP_OCCASIONS, toRequest, routeData } from '../public/app/flow.js';
import { DICT } from '../public/shared/i18n.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, aiServer, base, aiBase, stores, token;
let weather = { temperature: 5, apparent_temperature: 3, raining: false, wind_speed: 2, source: 'live' };
let stylistAnswer = null, stylistSeen = null;
const stylist = async (input) => {
  stylistSeen = input;
  if (stylistAnswer instanceof Error) throw stylistAnswer;
  return stylistAnswer;
};

const call = async (method, path, body, auth, at = base) => {
  const res = await fetch(at + path, { method, headers: { 'content-type': 'application/json', ...(auth && { authorization: `Bearer ${auth}` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const SIZES = { top: 'L', bottom: 'L', shoes: '42' };
const recommend = (extra = {}, at = base) => call('POST', '/api/recommend', { store_id: stores[0], gender: 'male', sizes: SIZES, ...extra }, null, at);
const allItems = (b) => (b.groups ? b.groups.flatMap((g) => g.items) : [...b.outfits.flatMap((o) => o.items), ...(b.partial?.items ?? [])]);
const fitting = (b, occasion) => allItems(b).filter((p) => OCCASIONS[occasion].includes(p.style)).length;

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
});
after(async () => {
  server.close();
  aiServer.close();
  await db.destroy();
});

// Pure candidates: worn all year, in stock.
let nextId = 5000;
const item = (category, unit_price, style, extra = {}) => ({ id: nextId++, category, price: unit_price, discount_price: null, unit_price, temp_min: -30, temp_max: 40, waterproof: false, color: 'qora', style, ...extra });

test('requests without an occasion answer exactly as before task 33 (recorded answers, 64 requests)', async () => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/no-occasion.json', import.meta.url), 'utf8'));
  const cases = noOccasionCases(stores);
  assert.equal(cases.length, expected.length);
  for (const [i, c] of cases.entries()) {
    weather = { temperature: c.weather[0], apparent_temperature: c.weather[0], raining: c.weather[1], wind_speed: 2, source: 'live' };
    const r = await call('POST', '/api/recommend', c.body);
    assert.equal(r.status, 200);
    assert.deepEqual(compact(r.body), expected[i], `case ${i}: ${JSON.stringify(c)}`);
    // An explicit null is the same as none.
    if (i % 8 === 0) assert.deepEqual(compact((await call('POST', '/api/recommend', { ...c.body, occasion: null })).body), expected[i]);
  }
  weather = { temperature: 5, apparent_temperature: 3, raining: false, wind_speed: 2, source: 'live' };
});

test('an unknown occasion is rejected, on /recommend (both modes) and /recommend/swap', async () => {
  for (const occasion of ['wedding', 'WORK', '', ' work', 'constructor', 'toString', '__proto__', 1, true, ['work'], { work: 1 }]) {
    for (const extra of [{}, { want: ['top'] }]) {
      const r = await recommend({ occasion, ...extra });
      assert.equal(r.status, 400, JSON.stringify(occasion));
      assert.match(r.body.error, /Qayerga kiyasiz/);
    }
  }
  const ok = await recommend({ occasion: 'work' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.occasion, 'work');
  const o = ok.body.outfits[0];
  const swap = (occasion) => call('POST', '/api/recommend/swap', { store_id: stores[0], gender: 'male', sizes: SIZES, occasion, items: o.items.map((i) => i.id), replace: o.items[0].id });
  assert.equal((await swap('party')).status, 200);
  assert.equal((await swap('beach')).status, 400);
  // The kiosk and the server share one list.
  assert.deepEqual(APP_OCCASIONS, Object.keys(OCCASIONS));
  for (const lang of ['uz', 'ru']) for (const k of ['any', 'title', 'hint', ...APP_OCCASIONS]) assert.ok(DICT[lang][`kiosk.occasion.${k}`], `${lang} kiosk.occasion.${k}`);
});

test('the occasion changes the ranking: pure outfits, single items and swaps; it never adds or drops an item', () => {
  // The casual items rank first (cheaper, budget given); work wants classic.
  const C = { top: [item('top', 100, 'casual'), item('top', 110, 'casual'), item('top', 300, 'classic')],
    bottom: [item('bottom', 100, 'casual'), item('bottom', 400, 'classic')], shoes: [item('shoes', 100, 'sport'), item('shoes', 150, 'classic')] };
  const all = Object.values(C).flat();
  const ctx = { temperature: 25, raining: false, budget: 1_000_000 };
  const ids = (r) => r.outfits.map((o) => o.items.map((p) => p.id));
  const plain = buildOutfits(all, ctx);
  assert.deepEqual(plain, buildOutfits(all, { ...ctx, occasion: null }));
  const work = buildOutfits(all, { ...ctx, occasion: 'work' });
  assert.deepEqual(ids(plain)[0], [C.top[0].id, C.bottom[0].id, C.shoes[0].id]);
  assert.deepEqual(ids(work)[0], [C.top[2].id, C.bottom[1].id, C.shoes[1].id], 'work → classic first');
  assert.deepEqual(ids(buildOutfits(all, { ...ctx, occasion: 'sport' }))[0], [C.top[0].id, C.bottom[0].id, C.shoes[0].id], 'no sport top: still an outfit');
  // Budget still rules: a classic outfit over budget is not shown in its place.
  assert.ok(buildOutfits(all, { ...ctx, budget: 300, occasion: 'work' }).outfits.every((o) => o.total <= 300));

  const single = (occasion) => singleItems(all, { ...ctx, want: ['top'], occasion })[0].items.map((p) => p.id);
  assert.deepEqual(single(null), C.top.map((p) => p.id));
  assert.deepEqual(single('party'), [C.top[2].id, C.top[0].id, C.top[1].id]);
  assert.deepEqual(new Set(single('party')), new Set(single(null)), 'only the order changes');

  const outfit = [C.top[0], C.bottom[0], C.shoes[0]];
  const swaps = (occasion) => swapOptions(all, { items: outfit, replace: C.top[0].id, ...ctx, occasion }).map((o) => o.swap);
  assert.deepEqual(swaps(null), [C.top[1].id, C.top[2].id]);
  assert.deepEqual(swaps('work'), [C.top[2].id, C.top[1].id]);
});

test('the occasion changes the ranking on the seed: more fitting styles, same stock rule; Claude gets it', async () => {
  const plain = (await recommend()).body;
  for (const occasion of Object.keys(OCCASIONS)) {
    const r = (await recommend({ occasion })).body;
    assert.equal(r.source, 'rules', 'no Claude key → the rules');
    assert.ok(fitting(r, occasion) >= fitting(plain, occasion), occasion);
  }
  for (const occasion of ['work', 'sport']) {
    const r = (await recommend({ occasion })).body;
    assert.ok(fitting(r, occasion) > fitting(plain, occasion), `${occasion} moves its styles up`);
    assert.notDeepEqual(r.outfits[0].items.map((p) => p.id), plain.outfits[0].items.map((p) => p.id));
  }
  const s0 = (await recommend({ want: ['top', 'bottom'] })).body, s1 = (await recommend({ want: ['top', 'bottom'], occasion: 'work' })).body;
  assert.ok(fitting(s1, 'work') >= fitting(s0, 'work'));
  assert.notDeepEqual(s1.groups[0].items.map((p) => p.id), s0.groups[0].items.map((p) => p.id), 'single items re-ranked');
  assert.deepEqual(s1.groups.map((g) => g.items.length), s0.groups.map((g) => g.items.length), 'as many items per category (a better-fitting one can move into the top 6)');

  // Claude: the occasion code goes in; any failure → the rules' occasion ranking.
  stylistAnswer = new Error('boom');
  const failed = (await recommend({ occasion: 'work' }, aiBase)).body;
  assert.equal(stylistSeen.occasion, 'work');
  assert.equal(failed.source, 'rules');
  assert.deepEqual(failed.outfits, (await recommend({ occasion: 'work' })).body.outfits);
  await recommend({ want: ['top'], occasion: 'travel' }, aiBase);
  assert.equal(stylistSeen.occasion, 'travel');
  assert.equal(stylistSeen.mode, 'single');
  await recommend({}, aiBase);
  assert.equal(stylistSeen.occasion, null);
  stylistAnswer = null;
});

test('the stock > 0 rule holds with an occasion: sold-out and fully reserved classic tops never come back', async () => {
  const classic = await db('products').where({ store_id: stores[0], category: 'top', style: 'classic' }).whereIn('gender', ['male', 'unisex']).select('id');
  const keep = await db('product_stock').whereIn('product_id', classic.map((p) => p.id)).where({ size: 'L' }).select('id', 'quantity', 'reserved');
  try {
    for (const [i, s] of keep.entries()) await db('product_stock').where({ id: s.id }).update(i % 2 ? { quantity: 0, reserved: 0 } : { quantity: 2, reserved: 2 });
    const gone = new Set(classic.map((p) => p.id));
    for (const extra of [{}, { want: ['top'] }]) for (const occasion of ['work', 'party']) {
      for (const [temperature, raining] of [[-10, false], [5, false], [15, true], [30, false]]) {
        weather = { ...weather, temperature, raining };
        const r = (await recommend({ occasion, ...extra })).body;
        const shown = [...allItems(r), ...(r.outfits ?? []).flatMap((o) => o.alternative?.items ?? []), ...(r.groups ?? []).flatMap((g) => g.items.flatMap((p) => [p.alternative, ...p.pairs].filter(Boolean)))];
        assert.ok(shown.length);
        assert.ok(!shown.some((p) => gone.has(p.id)), 'no sold-out classic top in L');
        for (const p of shown) {
          const sizes = p.size ? [p.size] : p.sizes;
          for (const size of sizes) assert.ok(await db('product_stock').where({ product_id: p.id, size }).whereRaw('quantity - reserved > 0').first(), `${p.id} ${size} in stock`);
        }
      }
    }
  } finally {
    for (const s of keep) await db('product_stock').where({ id: s.id }).update({ quantity: s.quantity, reserved: s.reserved });
    weather = { ...weather, temperature: 5, raining: false };
  }
});

test('the Claude message: OCCASION and one line only when an occasion was picked', async () => {
  const seen = [];
  const fake = { messages: { create: async (params) => (seen.push(params), { stop_reason: 'refusal', content: [] }) } };
  const ask = createStylist({ client: fake });
  const input = { weather, sizes: SIZES, budget: null, candidates: [item('top', 100, 'classic')] };
  await ask(input);
  await ask({ ...input, occasion: null });
  await ask({ ...input, occasion: 'party' });
  await ask({ ...input, mode: 'single', want: ['top'], occasion: 'party', lang: 'ru' });
  const text = (p) => p.messages[0].content.at(-1).text;
  const data = (p) => JSON.parse(text(p).split('\n').at(-1));
  assert.equal(text(seen[0]), text(seen[1]), 'null = no occasion');
  assert.ok(!('OCCASION' in data(seen[0])) && !text(seen[0]).includes('OCCASION'));
  assert.equal(text(seen[0]).split('\n').length, 2, 'the same two lines as before');
  assert.equal(data(seen[2]).OCCASION, "Bayram / to'y");
  assert.match(text(seen[2]), /OCCASION — mijoz bu kiyimni qayerga kiyadi/);
  assert.equal(data(seen[3]).OCCASION, "Bayram / to'y", 'always the Uzbek name, like the prompts');
  assert.ok(data(seen[3]).WANT);
});

test('logged on the results screen without personal data; the Talab page counts customers and paid orders per occasion', async () => {
  const work = await recommend({ occasion: 'work' });
  const single = await recommend({ want: ['shoes'], occasion: 'sport' });
  const none = await recommend();
  const occ = async (rec) => (await db('recommendation_logs').where({ token: rec }).first()).occasion;
  assert.deepEqual([await occ(work.body.rec), await occ(single.body.rec), await occ(none.body.rec)], ['work', 'sport', null]);
  // A −/+ re-query (same rec) keeps one row and its new occasion.
  await recommend({ occasion: 'party', rec: work.body.rec });
  assert.equal(await occ(work.body.rec), 'party');
  const cols = Object.keys(await db('recommendation_logs').columnInfo());
  assert.ok(!cols.some((c) => /phone|name|photo|height|weight|address/.test(c)), String(cols));

  // Exact numbers: only fresh logs (older ones moved out of the window).
  await db('recommendation_logs').update({ created_at: '2000-01-01 00:00:00' });
  const recs = [];
  for (const occasion of ['work', 'work', 'travel', null]) recs.push((await recommend(occasion ? { occasion } : {})).body);
  const order = async (rec, paid) => {
    const p = rec.outfits[0].items[0];
    const cart = await call('POST', '/api/cart/items', { store_id: stores[0], items: [{ product_id: p.id, size: p.size ?? p.sizes[0] }], rec: rec.rec });
    const r = await call('POST', `/api/cart/${cart.body.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '+998901234567' });
    assert.equal(r.status, 201);
    if (paid) assert.equal((await call('POST', `/api/admin/orders/${r.body.order.id}/pay`, { method: 'cash' }, token)).status, 200);
  };
  await order(recs[0], true);
  await order(recs[2], false); // unpaid: not counted
  await order(recs[3], true);
  const { occasions } = (await call('GET', '/api/admin/demand', undefined, token)).body;
  assert.deepEqual(occasions, [
    { occasion: 'daily', customers: 0, orders: 0 }, { occasion: 'work', customers: 2, orders: 1 }, { occasion: 'party', customers: 0, orders: 0 },
    { occasion: 'sport', customers: 0, orders: 0 }, { occasion: 'travel', customers: 1, orders: 0 }, { occasion: null, customers: 1, orders: 1 },
  ]);
  const other = (await call('GET', `/api/admin/demand?store_id=${stores[1]}`, undefined, token)).body.occasions;
  assert.ok(other.every((o) => o.customers === 0), 'narrowed to another store: none of these');
});

test('kiosk form: the occasion goes into the request and the saved route only from the fixed list', () => {
  const v = { gender: 'female', height: '165', weight: '', shoes: '38', budget: '', want: null };
  assert.equal(toRequest({ ...v, occasion: 'travel' }, 1).request.occasion, 'travel');
  for (const occasion of ['', 'beach', undefined, '__proto__']) assert.ok(!('occasion' in toRequest({ ...v, occasion }, 1).request), String(occasion));
  assert.equal(routeData({ screen: 'form', form: { ...v, occasion: 'work' } }).form.occasion, 'work');
  assert.equal(routeData({ screen: 'form', form: { ...v, occasion: '<b>x</b>' } }).form.occasion, '');
});
