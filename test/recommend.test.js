import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { json, testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { filterCandidates, buildOutfits, ruleOutfits } from '../src/recommend/engine.js';
import { createWeather, CACHE_MS } from '../src/recommend/weather.js';

const db = testDb();
let server, base, tashkent;
let fakeWeather = { temperature: 5, apparent_temperature: 2, raining: false, wind_speed: 3, source: 'live' };

before(async () => {
  await db.migrate.latest();
  await seed(db);
  tashkent = (await db('stores').orderBy('id').first()).id;
  server = createApp(db, { weather: async () => fakeWeather, limits: { recommend: 0 } }).listen(0); // the coverage test sends 120 requests at once
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
  const sale = res.body.outfits.flatMap((o) => o.items).find((i) => i.discount_price);
  assert.ok(sale, 'a discounted item in the outfits');
  assert.equal(sale.unit_price, sale.discount_price);
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

// Free stock (quantity − reserved) of every returned item in the size it was offered in; unknown shoe size → every listed size.
async function assertInStock(items) {
  for (const i of items) {
    for (const size of i.size ? [i.size] : i.sizes) {
      const row = await db('product_stock').where({ product_id: i.id, size }).first();
      assert.ok(row && row.quantity - row.reserved > 0, `${i.name} ${size} has no free stock`);
    }
  }
}
const SHOE = { male: { XS: '39', S: '40', M: '41', L: '42', XL: '43', XXL: '44' }, female: { XS: '36', S: '37', M: '38', L: '39', XL: '40', XXL: '41' } };

test('coverage: 3 outfits for every gender × size × store at −10, 5, 15, 17 (rain) and 30 °C', async () => {
  const stores = await db('stores').orderBy('id');
  const weathers = [[-10, false], [5, false], [15, false], [17, true], [30, false]];
  const misses = [];
  for (const store of stores)
    for (const gender of ['male', 'female'])
      for (const size of ['XS', 'S', 'M', 'L', 'XL', 'XXL'])
        for (const [temperature, raining] of weathers) {
          fakeWeather = { ...fakeWeather, temperature, raining };
          const { status, body } = await recommend({ store_id: store.id, gender, sizes: { top: size, bottom: size, shoes: SHOE[gender][size] } });
          assert.equal(status, 200);
          const where = `${store.city} ${gender} ${size} ${temperature} °C${raining ? ' rain' : ''}`;
          if (body.outfits.length !== 3 || body.relaxed || body.notice) misses.push(`${where}: ${body.outfits.length} outfits, relaxed ${body.relaxed}, ${body.notice}`);
          const all = body.outfits.flatMap((o) => o.items);
          assert.equal(new Set(all.map((i) => i.id)).size, all.length, `${where}: no item repeats`);
          for (const o of body.outfits) {
            const c = cats(o);
            for (const need of [...(temperature < 18 || raining ? ['outerwear'] : []), 'top', 'bottom', 'shoes']) assert.ok(c.includes(need), `${where}: ${need}`);
            for (const i of o.items) assert.ok(i.temp_min <= temperature && temperature <= i.temp_max, `${where}: ${i.name} worn at ${temperature}`);
          }
          await assertInStock([...all, ...body.outfits.flatMap((o) => o.alternative?.items ?? [])]);
        }
  // Exact weather match everywhere: the catalogue alone covers it, no relaxation needed.
  assert.deepEqual(misses, []);
});

// Synthetic items with a temperature window, for the relaxation tests.
const worn = (category, temp_min, temp_max, extra = {}) => item(category, 100000 + nextId * 10, { temp_min, temp_max, ...extra });
const loader = (list, temperature) => async (spread) => list.filter((p) => p.temp_min <= temperature + spread && p.temp_max >= temperature - spread);

test('relaxation: ±3 °C, then ±6 °C, flagged as relaxed; in-window items first', async () => {
  const t = 10;
  const exact = ['top', 'bottom', 'shoes', 'outerwear'].map((c) => worn(c, 5, 15)); // one of each fits exactly
  const near = ['top', 'bottom', 'shoes', 'outerwear'].flatMap((c) => [worn(c, 12, 20), worn(c, 0, 8)]); // 2 or 2 °C away
  const far = ['top', 'bottom', 'shoes', 'outerwear'].flatMap((c) => [worn(c, 15, 25), worn(c, -10, 5)]); // 5 °C away
  const ctx = { temperature: t, raining: false };

  const one = await ruleOutfits(loader(exact, t), ctx);
  assert.equal(one.outfits.length, 1);
  assert.equal(one.relaxed, 0, 'nothing more to widen into: keeps the exact answer');

  const three = await ruleOutfits(loader([...exact, ...near, ...far], t), ctx);
  assert.equal(three.outfits.length, 3);
  assert.equal(three.relaxed, 3);
  assert.deepEqual(new Set(three.outfits[0].items.map((i) => i.id)), new Set(exact.map((i) => i.id)), 'the exact items make outfit 1');
  for (const i of three.outfits.flatMap((o) => o.items)) assert.ok(i.temp_min <= t + 3 && i.temp_max >= t - 3, 'within ±3 °C');

  const six = await ruleOutfits(loader([...exact, ...far], t), ctx);
  assert.equal(six.outfits.length, 3);
  assert.equal(six.relaxed, 6);
  for (const i of six.outfits.flatMap((o) => o.items)) assert.ok(i.temp_min <= t + 6 && i.temp_max >= t - 6, 'within ±6 °C');
  assert.equal(six.notice, null);

  // Enough exact items → no relaxation, and the loader is called once.
  let calls = 0;
  const plenty = ['top', 'bottom', 'shoes', 'outerwear'].flatMap((c) => [worn(c, 5, 15), worn(c, 5, 15), worn(c, 5, 15)]);
  const r = await ruleOutfits(async (spread) => { calls++; return loader(plenty, t)(spread); }, ctx);
  assert.equal(r.outfits.length, 3);
  assert.equal(r.relaxed, 0);
  assert.equal(calls, 1);
});

test('relaxation and missing outerwear from the DB: stock 0 stays out in every case', async () => {
  const sizes = { top: 'L', bottom: 'L', shoes: '42' };
  // Colder than any item: nothing at −28 or ±3 → the −25 °C winter items at ±3, and ±6 at −31.
  fakeWeather = { ...fakeWeather, temperature: -28, raining: false };
  const r3 = (await recommend({ store_id: tashkent, gender: 'male', sizes })).body;
  assert.ok(r3.outfits.length >= 1);
  assert.equal(r3.relaxed, 3);
  for (const i of r3.outfits.flatMap((o) => o.items)) assert.ok(i.temp_min <= -25, `${i.name} within ±3 °C`);
  await assertInStock(r3.outfits.flatMap((o) => o.items));
  fakeWeather = { ...fakeWeather, temperature: -31 };
  const r6 = (await recommend({ store_id: tashkent, gender: 'male', sizes })).body;
  assert.equal(r6.relaxed, 6);
  assert.ok(r6.outfits.length >= 1);

  // Sell out (quantity 0) or fully reserve every outerwear in L: outfits come back without it, with a notice.
  const coats = await db('products').where({ store_id: tashkent, category: 'outerwear' }).whereIn('gender', ['male', 'unisex']).pluck('id');
  const saved = await db('product_stock').whereIn('product_id', coats).where({ size: 'L' });
  try {
    for (const [n, row] of saved.entries()) await db('product_stock').where({ id: row.id }).update(n % 2 ? { quantity: 0, reserved: 0 } : { reserved: row.quantity });
    fakeWeather = { ...fakeWeather, temperature: 5 };
    const bare = (await recommend({ store_id: tashkent, gender: 'male', sizes })).body;
    assert.equal(bare.notice, 'no_outerwear');
    assert.equal(bare.outfits.length, 3);
    for (const o of bare.outfits) {
      assert.ok(!cats(o).includes('outerwear'));
      assert.deepEqual(cats(o).slice(0, 3), ['top', 'bottom', 'shoes']);
    }
    await assertInStock(bare.outfits.flatMap((o) => o.items));
    // Another size still has coats: no notice there.
    assert.equal((await recommend({ store_id: tashkent, gender: 'male', sizes: { ...sizes, top: 'M' } })).body.notice, null);
  } finally {
    for (const row of saved) await db('product_stock').where({ id: row.id }).update({ quantity: row.quantity, reserved: row.reserved });
  }
});

test('missing outerwear (pure): outfits without it plus a notice; other gaps still give nothing', async () => {
  const ctx = { temperature: 5, raining: false };
  const noCoat = pool(3).filter((p) => p.category !== 'outerwear');
  const r = await ruleOutfits(async () => noCoat, ctx);
  assert.equal(r.notice, 'no_outerwear');
  assert.equal(r.outfits.length, 3);
  assert.ok(r.outfits.every((o) => !cats(o).includes('outerwear')));
  // At 25 °C outerwear isn't required, so its absence needs no notice.
  assert.equal((await ruleOutfits(async () => noCoat, { temperature: 25, raining: false })).notice, null);
  // No tops either → nothing, and no misleading notice.
  const r2 = await ruleOutfits(async () => noCoat.filter((p) => p.category !== 'top'), ctx);
  assert.deepEqual(r2.outfits, []);
  assert.equal(r2.notice, null);
});

test('budget: nothing fits → also a partial in-budget outfit of the required items, cheapest first', async () => {
  const top = item('top', 90000), bottom = item('bottom', 200000), shoes = item('shoes', 150000), coat = item('outerwear', 400000);
  const r = buildOutfits([top, bottom, shoes, coat], { temperature: 5, raining: false, budget: 300000 });
  assert.equal(r.outfits.length, 1, 'the cheapest full outfit is still shown');
  assert.equal(r.over_budget, 840000 - 300000);
  assert.deepEqual(r.partial.items.map((i) => i.id), [top.id, shoes.id], 'cheapest first: 90k + 150k, the 200k bottom would pass 300k');
  assert.equal(r.partial.total, 240000);
  assert.deepEqual(r.partial.missing, ['outerwear', 'bottom']);
  assert.equal(buildOutfits([top, bottom, shoes, coat], { temperature: 5, raining: false, budget: 50000 }).partial, null, 'not even one item fits');
  assert.equal(buildOutfits([top, bottom, shoes, coat], { temperature: 5, raining: false, budget: 900000 }).partial, null, 'fits: no partial');

  // Endpoint: 17 °C rain with a 500 000 budget (audit R3) → an in-budget partial of in-stock items.
  fakeWeather = { ...fakeWeather, temperature: 17, raining: true };
  const res = (await recommend({ store_id: tashkent, gender: 'male', sizes: { top: 'M', bottom: 'M', shoes: '42' }, budget: 500000 })).body;
  assert.ok(res.over_budget > 0);
  assert.ok(res.partial.items.length >= 1 && res.partial.total <= 500000);
  assert.equal(res.partial.total, res.partial.items.reduce((s, i) => s + i.unit_price, 0));
  await assertInStock(res.partial.items);
  // A realistic budget gets full outfits and no partial.
  const ok = (await recommend({ store_id: tashkent, gender: 'male', sizes: { top: 'M', bottom: 'M', shoes: '42' }, budget: 1500000 })).body;
  assert.ok(ok.outfits.length >= 2 && ok.outfits.every((o) => o.total <= 1500000));
  assert.equal(ok.partial, null);
  assert.equal(ok.over_budget, 0);
});

test('outfits are composed: one bright colour at most, same style preferred, rank order otherwise', () => {
  const red = item('top', 100000, { color: 'qizil', style: 'classic' });
  const yellow = item('bottom', 100000, { color: 'sariq', style: 'classic' }); // ranks first, but clashes with red
  const black = item('bottom', 100500, { color: 'qora', style: 'classic' });
  const sportShoe = item('shoes', 100000, { color: 'oq', style: 'sport' }); // ranks first, wrong style
  const classicShoe = item('shoes', 100500, { color: 'qora', style: 'classic' });
  const r = buildOutfits([red, yellow, black, sportShoe, classicShoe], { temperature: 25, raining: false, budget: 10 ** 7 });
  assert.deepEqual(ids(r.outfits[0]), [red.id, black.id, classicShoe.id]);
  // Only a clashing item left → still used (an outfit beats none).
  const r2 = buildOutfits([red, yellow, sportShoe], { temperature: 25, raining: false });
  assert.deepEqual(ids(r2.outfits[0]), [red.id, yellow.id, sportShoe.id]);
});
