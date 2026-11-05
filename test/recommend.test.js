import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { json, testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { filterCandidates, buildOutfits } from '../src/recommend/engine.js';
import { createWeather, CACHE_MS } from '../src/recommend/weather.js';

const db = testDb();
let server, base, tashkent;
let fakeWeather = { temperature: 5, apparent_temperature: 2, raining: false, wind_speed: 3, source: 'live' };

before(async () => {
  await db.migrate.latest();
  await seed(db);
  tashkent = (await db('stores').orderBy('id').first()).id;
  server = createApp(db, { weather: async () => fakeWeather }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await db.destroy();
});

const recommend = async (body) => {
  const res = await fetch(`${base}/api/recommend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const ids = (outfit) => outfit.items.map((i) => i.id);
const cats = (outfit) => outfit.items.map((i) => i.category);

// Synthetic candidates for the pure engine: n items per category, distinct prices.
let nextId = 1;
const item = (category, unit_price, extra = {}) => ({
  id: nextId++, category, price: unit_price, discount_price: null, unit_price, temp_min: -30, temp_max: 40, waterproof: false, ...extra,
});
const pool = (n, step = 1000, base = 100000) =>
  ['outerwear', 'top', 'bottom', 'shoes', 'accessory'].flatMap((c, ci) => Array.from({ length: n }, (_, i) => item(c, base + ci * 10000 + i * step)));

test('no item with zero free stock in the customer size is ever returned', async () => {
  const stockOf = async (id, size) => {
    const q = db('product_stock').where({ product_id: id }).whereRaw('quantity - reserved > 0');
    if (size) q.where({ size });
    return (await q).length;
  };
  let checked = 0;
  for (const gender of ['male', 'female'])
    for (const size of ['XS', 'S', 'M', 'L', 'XL', 'XXL'])
      for (const shoes of ['38', '42', null])
        for (const temperature of [-10, 5, 15, 30]) {
          const sizes = { top: size, bottom: size, shoes };
          const c = await filterCandidates(db, { storeId: tashkent, gender, sizes, temperature });
          for (const p of c) {
            assert.ok((await stockOf(p.id, p.size)) > 0, `product ${p.id} size ${p.size} has no stock`);
            if (p.category === 'shoes' && shoes) assert.equal(p.size, shoes);
            if (['top', 'outerwear', 'bottom'].includes(p.category)) assert.equal(p.size, size);
            checked++;
          }
        }
  assert.ok(checked > 100, 'seed produced candidates');

  // Sell out (quantity 0) one returned item and fully reserve another: both disappear.
  const sizes = { top: 'M', bottom: 'M', shoes: '42' };
  const [a, b] = await filterCandidates(db, { storeId: tashkent, gender: 'male', sizes, temperature: 5 });
  await db('product_stock').where({ product_id: a.id, size: a.size }).update({ quantity: 0, reserved: 0 });
  await db('product_stock').where({ product_id: b.id, size: b.size }).update({ reserved: db.raw('quantity') });
  const after = await filterCandidates(db, { storeId: tashkent, gender: 'male', sizes, temperature: 5 });
  assert.ok(!after.some((p) => p.id === a.id || p.id === b.id));
  fakeWeather = { ...fakeWeather, temperature: 5, raining: false };
  const res = await recommend({ store_id: tashkent, gender: 'male', sizes });
  const all = res.body.outfits.flatMap((o) => [...ids(o), ...(o.alternative ? ids(o.alternative) : [])]);
  assert.ok(!all.includes(a.id) && !all.includes(b.id));
});

test('weather picks the right categories: −10, 5, 15, 30 °C and rain', async () => {
  const sizes = { top: 'L', bottom: 'L', shoes: '42' };
  const run = async (temperature, raining) => {
    const c = await filterCandidates(db, { storeId: tashkent, gender: 'male', sizes, temperature });
    const r = buildOutfits(c, { temperature, raining });
    assert.ok(r.outfits.length >= 1, `outfit at ${temperature}`);
    for (const o of r.outfits) for (const i of o.items) assert.ok(i.temp_min <= temperature && temperature <= i.temp_max, `${i.name} at ${temperature}`);
    return r.outfits;
  };
  const coat = ['outerwear', 'top', 'bottom', 'shoes'];
  // Live weather is fractional; Postgres refused 11.7 against the integer columns before the cast in filterCandidates.
  for (const t of [-10, 5, 5.5, 11.7, 15]) for (const o of await run(t, false)) assert.deepEqual(cats(o).slice(0, 4), coat, `${t} °C`);
  for (const o of await run(30, false)) {
    assert.ok(!cats(o).includes('outerwear'), 'no outerwear at 30 °C');
    assert.deepEqual(cats(o).slice(0, 3), ['top', 'bottom', 'shoes']);
  }
  // Rain at 20 °C still needs outerwear, and waterproof items come first.
  const [wet] = await run(20, true);
  assert.equal(wet.items[0].category, 'outerwear');
  assert.ok(wet.items[0].waterproof);
  const [dry15] = await run(15, false);
  const [wet15] = await run(15, true);
  assert.ok(!dry15.items.find((i) => i.category === 'shoes').waterproof, 'dry: best temperature match');
  assert.ok(wet15.items.find((i) => i.category === 'shoes').waterproof, 'rain: waterproof shoes first');

  // Pure engine: outerwear rule boundary at 18 °C.
  const p = pool(3);
  assert.ok(cats(buildOutfits(p, { temperature: 17.9, raining: false }).outfits[0]).includes('outerwear'));
  assert.ok(!cats(buildOutfits(p, { temperature: 18, raining: false }).outfits[0]).includes('outerwear'));
  assert.ok(cats(buildOutfits(p, { temperature: 25, raining: true }).outfits[0]).includes('outerwear'));
  assert.deepEqual(buildOutfits(pool(0), { temperature: 5, raining: false }).outfits, [], 'empty store: no outfits');
});

test('discount price is used and outfit totals are exact integers', async () => {
  const top = item('top', 99000, { price: 120000, discount_price: 99000 });
  const bottom = item('bottom', 350000);
  const shoes = item('shoes', 790000, { price: 950000, discount_price: 790000 });
  const r = buildOutfits([top, bottom, shoes], { temperature: 25, raining: false });
  assert.equal(r.outfits[0].total, 99000 + 350000 + 790000);
  assert.ok(Number.isInteger(r.outfits[0].total));

  // From the DB: unit_price = discount_price ?? price for every candidate.
  const c = await filterCandidates(db, { storeId: tashkent, gender: 'female', sizes: { top: 'M', bottom: 'M', shoes: '38' }, temperature: 20 });
  for (const p of c) assert.equal(p.unit_price, p.discount_price ?? p.price);
  assert.ok(c.some((p) => p.discount_price), 'seed has discounted items');

  // Endpoint: total equals the sum of item unit prices.
  fakeWeather = { ...fakeWeather, temperature: -10, raining: false };
  const res = await recommend({ store_id: tashkent, gender: 'male', sizes: { top: 'L', bottom: 'L', shoes: '42' } });
  assert.equal(res.status, 200);
  for (const o of res.body.outfits) {
    assert.equal(o.total, o.items.reduce((s, i) => s + i.unit_price, 0));
    for (const i of o.items) assert.equal(i.unit_price, i.discount_price ?? i.price);
  }
  const puxovik = res.body.outfits.flatMap((o) => o.items).find((i) => i.name === 'Qishki puxovik');
  assert.equal(puxovik?.unit_price, 990000, 'discounted coat priced at 990 000');
});

test('budget: only outfits that fit; none fit → cheapest outfit and how far over', () => {
  const p = pool(3); // outfit i (no outerwear at 25 °C) = top+bottom+shoes at i-th price; accessories cost 140k+
  const full = buildOutfits(p, { temperature: 25, raining: false });
  assert.equal(full.outfits.length, 3);
  const totals = full.outfits.map((o) => o.total - (o.items.find((i) => i.category === 'accessory')?.unit_price ?? 0));
  const bare = buildOutfits(p, { temperature: 25, raining: false, budget: 10 ** 9 });
  assert.equal(bare.over_budget, 0);

  // Budget sorted cheapest first: outfit totals 360k, 363k, 366k without accessory.
  const budget = 363000;
  const r = buildOutfits(p, { temperature: 25, raining: false, budget });
  assert.ok(r.outfits.length >= 1);
  for (const o of r.outfits) assert.ok(o.total <= budget, `${o.total} ≤ ${budget}`);
  assert.equal(r.over_budget, 0);
  assert.ok(r.outfits.every((o) => !o.items.some((i) => i.category === 'accessory')), 'accessory dropped when it breaks the budget');

  const tight = buildOutfits(p, { temperature: 25, raining: false, budget: 300000 });
  assert.equal(tight.outfits.length, 1);
  assert.equal(tight.outfits[0].total, Math.min(...totals));
  assert.equal(tight.over_budget, tight.outfits[0].total - 300000);
  assert.ok(tight.over_budget > 0);
});

test('no item repeats across outfits; each outfit gets one cheaper alternative', () => {
  const p = pool(6, -1000); // later items cheaper, so unused ones can be swapped in
  const r = buildOutfits(p, { temperature: 5, raining: false });
  assert.equal(r.outfits.length, 3);
  const main = r.outfits.flatMap(ids);
  assert.equal(new Set(main).size, main.length, 'no repeats');
  for (const o of r.outfits) {
    assert.ok(o.alternative, 'has an alternative');
    assert.ok(o.alternative.total < o.total, 'alternative is cheaper');
    const swapped = ids(o.alternative).filter((id) => !ids(o).includes(id));
    assert.equal(swapped.length, 1, 'exactly one item swapped');
    assert.ok(!main.includes(swapped[0]), 'swap item is not used by any outfit');
    assert.equal(o.alternative.items.length, o.items.length);
    assert.ok(ids(o).includes(o.alternative.replaces));
  }
  // Nothing cheaper left → no alternative.
  const one = buildOutfits(pool(1), { temperature: 5, raining: false });
  assert.equal(one.outfits[0].alternative, null);
});

test('weather: Open-Meteo parse, rain codes, 10 min cache, offline monthly fallback', async () => {
  let now = Date.UTC(2026, 6, 15, 7); // July
  let calls = 0;
  let reply = { temperature_2m: 31.4, apparent_temperature: 33, precipitation: 0, weather_code: 1, wind_speed_10m: 12 };
  const fakeFetch = async (url) => {
    calls++;
    assert.match(url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=41\.3&longitude=69\.2&/);
    return { ok: true, json: async () => ({ current: reply }) };
  };
  const get = createWeather({ fetch: fakeFetch, now: () => now });
  const store = { lat: 41.3, lon: 69.2 };
  assert.deepEqual(await get(store), { temperature: 31.4, apparent_temperature: 33, raining: false, wind_speed: 12, source: 'live' });
  reply = { ...reply, weather_code: 63 };
  assert.equal((await get(store)).raining, false, 'cached');
  now += CACHE_MS - 1;
  await get(store);
  assert.equal(calls, 1);
  now += 1;
  assert.equal((await get(store)).raining, true, 'refetched after 10 min; code 63 = rain');
  assert.equal(calls, 2);

  // Offline: network error, HTTP error or junk → monthly average, never throws.
  const warn = console.warn;
  console.warn = () => {};
  try {
    const jan = Date.UTC(2026, 0, 10);
    const offline = createWeather({ fetch: async () => { throw new TypeError('fetch failed'); }, now: () => jan });
    assert.deepEqual(await offline(store), { temperature: 3, apparent_temperature: null, raining: false, wind_speed: null, source: 'fallback' });
    const http500 = createWeather({ fetch: async () => ({ ok: false, status: 500 }), now: () => now });
    assert.deepEqual(await http500(store), { temperature: 29, apparent_temperature: null, raining: false, wind_speed: null, source: 'fallback' });
    const junk = createWeather({ fetch: async () => ({ ok: true, json: async () => ({}) }), now: () => now });
    assert.equal((await junk(store)).source, 'fallback');
    // Dec 31 19:30 UTC is already January in Tashkent.
    const nye = createWeather({ fetch: async () => { throw new Error('x'); }, now: () => Date.UTC(2026, 11, 31, 19, 30) });
    assert.equal((await nye(store)).temperature, 3);

    // Whole endpoint works offline.
    const app = createApp(db, { weather: createWeather({ fetch: async () => { throw new TypeError('fetch failed'); } }) }).listen(0);
    await new Promise((r) => app.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${app.address().port}/api/recommend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ store_id: tashkent, gender: 'female', sizes: { top: 'L', bottom: 'L' } }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.weather.source, 'fallback');
      assert.ok(body.outfits.length >= 1);
    } finally {
      app.close();
    }
  } finally {
    console.warn = warn;
  }
});

test('POST /api/recommend validates input and writes recommendation_logs for stats', async () => {
  const sizes = { top: 'm', bottom: 'M', shoes: 42 };
  for (const [body, status] of [
    [{}, 400],
    [{ store_id: tashkent, gender: 'x', sizes }, 400],
    [{ store_id: tashkent, gender: 'male', sizes: { top: 'M' } }, 400],
    [{ store_id: tashkent, gender: 'male', sizes: { ...sizes, shoes: '50' } }, 400],
    [{ store_id: tashkent, gender: 'male', sizes, budget: -5 }, 400],
    [{ store_id: tashkent, gender: 'male', sizes, budget: 1.5 }, 400],
    [{ store_id: tashkent, gender: 'male', sizes, budget: 3e9 }, 400],
    [{ store_id: 9999, gender: 'male', sizes }, 404],
  ]) {
    const res = await recommend(body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.ok(res.body.error);
  }

  await db('recommendation_logs').del();
  fakeWeather = { ...fakeWeather, temperature: 15, raining: true };
  const res = await recommend({ store_id: tashkent, gender: 'male', sizes, budget: 5000000 });
  assert.equal(res.status, 200);
  assert.equal(res.body.weather.raining, true);
  assert.equal(res.body.budget, 5000000);
  for (const o of res.body.outfits) assert.equal(o.items[0].size, 'M');

  const [log] = await db('recommendation_logs');
  assert.equal(log.store_id, tashkent);
  assert.equal(log.source, 'rules');
  assert.equal(log.temperature, 15);
  assert.equal(log.budget, 5000000);
  assert.deepEqual(json(log.sizes), { top: 'M', bottom: 'M', shoes: '42' });
  const logged = json(log.product_ids);
  assert.ok(logged.length > 0 && logged.every(Number.isInteger));
  assert.deepEqual(new Set(logged), new Set(res.body.outfits.flatMap(ids)));
});
