// Task 48: a shop's own size chart. Validation, sizing with and without a chart (a copy of the built-in table changes
// nothing), the fit offset on top, two shops with different charts in one mall outfit and search, children's sizes,
// the item page's table, and org isolation of the admin routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { filterCandidates } from '../src/recommend/engine.js';
import { CHART_KINDS, chartSize, validChart } from '../src/size/chart.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, s1, s2, org1, mall, owner1, manager1, staff1, owner2, mallAdmin, superToken;
const WEATHER = { temperature: 5, apparent_temperature: 2, raining: false, wind_speed: 3, source: 'live' };

const call = async (method, p, body, token) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (email, password) => (await call('POST', '/api/admin/login', { email, password })).body.token;
const builtin = (kind) => structuredClone(CHART_KINDS[kind].builtin);
// A brand cut `d` cm smaller: every range moves down by d, so the customer lands one size up when d is one step.
const smaller = (kind, d) => Object.fromEntries(Object.entries(builtin(kind)).map(([g, rows]) => [g, rows.map((r) => Object.fromEntries(Object.entries(r)
  .map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => Math.round((x - d) * 10) / 10) : v])))]));
const save = (scope, data, token = owner1) => call('PUT', `/api/admin/size-charts/${scope}`, { data }, token);
const items = (r) => [...r.outfits.flatMap((o) => [...o.items, ...(o.alternative?.items ?? [])]), ...(r.partial?.items ?? [])];

before(async () => {
  await db.migrate.latest();
  await seed(db); // two demo shops of two organisations, both in the demo mall
  [s1, s2] = (await db('stores').orderBy('id')).map((s) => s.id);
  org1 = (await db('stores').where({ id: s1 }).first()).organization_id;
  mall = (await db('malls').first()).id;
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  await createAdmin(db, { email: 'own1@smartfit.uz', password: 'own-pass-1', storeId: s1 });
  await createAdmin(db, { email: 'mgr1@smartfit.uz', password: 'mgr-pass-1', storeId: s1, role: 'manager' });
  await createAdmin(db, { email: 'staff1@smartfit.uz', password: 'staff-pass-1', storeId: s1, role: 'staff' });
  await createAdmin(db, { email: 'own2@smartfit.uz', password: 'own-pass-2', storeId: s2 });
  await createAdmin(db, { email: 'mall@smartfit.uz', password: 'mall-pass-1', mallId: mall });
  server = createApp(db, { telegram: null, stylist: null, weather: async () => WEATHER, limits: { recommend: 0, catalog: 0, cart: 0 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  [superToken, owner1, manager1, staff1, owner2, mallAdmin] = await Promise.all([login('boss@smartfit.uz', 'boss-pass-1'), login('own1@smartfit.uz', 'own-pass-1'),
    login('mgr1@smartfit.uz', 'mgr-pass-1'), login('staff1@smartfit.uz', 'staff-pass-1'), login('own2@smartfit.uz', 'own-pass-2'), login('mall@smartfit.uz', 'mall-pass-1')]);
});
after(async () => {
  server?.close();
  await db.destroy();
});

test('pure: a copy of the built-in table gives every size back; a smaller cut moves one size up; bottoms take the larger of waist and hips', () => {
  for (const [kind, k] of Object.entries(CHART_KINDS)) {
    for (const g of k.groups) {
      const gender = g === 'all' ? 'male' : g;
      for (const cat of ['top', 'bottom', 'outerwear', 'shoes']) {
        for (const s of k.sizes) assert.equal(chartSize(kind, builtin(kind), cat, gender, s), s, `${kind} ${g} ${cat} ${s}`);
      }
    }
  }
  const step = { clothes: 6, kids: 6, shoes: 0.7, kids_shoes: 0.7 };
  for (const kind of Object.keys(CHART_KINDS)) {
    const sizes = CHART_KINDS[kind].sizes, cat = kind.endsWith('shoes') ? 'shoes' : 'top';
    assert.equal(chartSize(kind, smaller(kind, step[kind]), cat, 'female', sizes[2]), sizes[3], kind);
    assert.equal(chartSize(kind, smaller(kind, step[kind]), cat, 'female', sizes.at(-1)), sizes.at(-1), `${kind}: clamped to the last size`);
  }
  assert.equal(chartSize('clothes', builtin('clothes'), 'top', 'male', '42'), '42', 'an unknown size stays as it is');
  // Only the hips run small: the bottom goes up, the top (chest) stays.
  const hips = builtin('clothes');
  for (const r of hips.male) r.hips = r.hips.map((x) => x - 6);
  assert.equal(chartSize('clothes', hips, 'bottom', 'male', 'M'), 'L');
  assert.equal(chartSize('clothes', hips, 'top', 'male', 'M'), 'M');
  // A gap between two rows goes to the bigger size.
  const gap = builtin('clothes');
  gap.male[2].chest = [95, 97];
  assert.equal(chartSize('clothes', gap, 'top', 'male', 'M'), 'L');
});

test('validation: every size of the kind in order, ranges in order with min < max, no overlap, cm with one decimal', () => {
  assert.deepEqual(validChart('clothes', builtin('clothes')), builtin('clothes'));
  const bad = (kind, fn, code) => {
    const d = builtin(kind);
    fn(d);
    assert.throws(() => validChart(kind, d), (e) => e.publicKey === code, code);
  };
  bad('clothes', (d) => delete d.female, 'err.chart_sizes');
  bad('clothes', (d) => (d.extra = []), 'err.chart_sizes');
  bad('clothes', (d) => d.male.pop(), 'err.chart_sizes');
  bad('clothes', (d) => ([d.male[0], d.male[1]] = [d.male[1], d.male[0]]), 'err.chart_sizes');
  bad('shoes', (d) => (d.all[0].size = '35'), 'err.chart_sizes');
  bad('clothes', (d) => (d.male[2].chest = [101, 95]), 'err.chart_range');
  bad('clothes', (d) => (d.male[2].chest = [95, 95]), 'err.chart_range');
  bad('clothes', (d) => (d.male[2].chest = [95.25, 101]), 'err.chart_range');
  bad('clothes', (d) => (d.male[2].chest = ['95', 101]), 'err.chart_range');
  bad('clothes', (d) => delete d.male[2].waist, 'err.chart_range');
  bad('kids', (d) => (d.all[0].height = [0, 92]), 'err.chart_range');
  bad('clothes', (d) => (d.male[3].chest = [100, 107]), 'err.chart_order'); // starts inside M's range
  bad('kids_shoes', (d) => (d.all[5].foot = [d.all[4].foot[0], d.all[5].foot[1]]), 'err.chart_order');
  // Extra keys are dropped, not stored.
  const d = builtin('kids');
  d.all[0].note = 'x';
  assert.equal(validChart('kids', d).all[0].note, undefined);
});

test('admin: owner and manager save and reset; the editor starts from the built-in table; staff, the mall admin and another shop cannot', async () => {
  const g = await call('GET', '/api/admin/size-charts', undefined, owner1);
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.kinds.clothes.builtin, builtin('clothes'));
  assert.deepEqual(g.body.charts, []);

  const cat = await db('categories').where({ organization_id: org1, role: 'top', audience: 'adult' }).first();
  let r = await save(cat.id, smaller('clothes', 6), manager1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.scope, r.body.kind, r.body.category_id], [`c${cat.id}`, 'clothes', cat.id]);
  r = await save('kids', smaller('kids', 6));
  assert.equal(r.status, 200);
  assert.equal((await save('clothes', { male: [] })).status, 400);
  assert.equal((await save('shoes', builtin('clothes'))).status, 400, 'the kind decides the sizes');
  const oneCat = await db('categories').where({ organization_id: org1, role: 'accessory' }).first();
  assert.equal((await save(oneCat.id, builtin('clothes'))).status, 400, 'one size: no chart');
  assert.equal((await save('hats', builtin('clothes'))).status, 404);
  assert.deepEqual((await call('GET', '/api/admin/size-charts', undefined, owner1)).body.charts.map((c) => c.scope).sort(), [`c${cat.id}`, 'kids']);
  const log = await db('audit_log').where({ action: 'size_chart.save' }).orderBy('id');
  assert.equal(log.length, 2);
  assert.equal(log[0].store_id, s1);

  // Another organisation: its own empty list; org 1's category is a 404 to read or write.
  assert.deepEqual((await call('GET', '/api/admin/size-charts', undefined, owner2)).body.charts, []);
  assert.equal((await save(cat.id, builtin('clothes'), owner2)).status, 404);
  assert.equal((await call('DELETE', `/api/admin/size-charts/${cat.id}`, undefined, owner2)).status, 404);
  assert.equal((await call('DELETE', '/api/admin/size-charts/kids', undefined, owner2)).status, 204, 'its own (none): nothing to do');
  assert.ok(await db('size_charts').where({ organization_id: org1, scope: 'kids' }).first(), 'org 1 keeps its chart');
  for (const tok of [staff1, mallAdmin]) {
    assert.equal((await call('GET', '/api/admin/size-charts', undefined, tok)).status, 403);
    assert.equal((await save('clothes', builtin('clothes'), tok)).status, 403);
  }
  // Super names the organisation.
  assert.equal((await call('GET', '/api/admin/size-charts', undefined, superToken)).status, 400);
  assert.equal((await call('GET', `/api/admin/size-charts?store_id=${s1}`, undefined, superToken)).body.charts.length, 2);

  assert.equal((await call('DELETE', `/api/admin/size-charts/${cat.id}`, undefined, owner1)).status, 204);
  assert.equal((await call('DELETE', '/api/admin/size-charts/kids', undefined, owner1)).status, 204);
  assert.equal(await db('size_charts').count({ n: '*' }).first().then((x) => Number(x.n)), 0);
  assert.equal((await db('audit_log').where({ action: 'size_chart.delete' })).length, 2);
});

// A top of shop 1 with every size in stock, worn at 5 °C.
async function topOf(store, extra = {}) {
  const p = await db('products').where({ store_id: store, category: 'top', audience: 'adult', gender: 'male' }).where('temp_min', '<=', 5).where('temp_max', '>=', 5).orderBy('id').first();
  await db('product_stock').where({ product_id: p.id }).update({ quantity: 5, reserved: 0 });
  if (Object.keys(extra).length) await db('products').where({ id: p.id }).update(extra);
  return p;
}
const find = async (store, p, sizes, audience = 'adult') =>
  (await filterCandidates(db, { storeId: store, gender: 'male', sizes, temperature: 5, audience })).find((x) => x.id === p.id);

test('sizing: built-in without a chart, the shop\'s chart with one (category beats the default), a copy changes nothing, the fit offset on top', async () => {
  const p = await topOf(s1, { fit_offset: null });
  const sizes = { top: 'M', bottom: 'M', shoes: '42' };
  let x = await find(s1, p, sizes);
  assert.equal(x.size, 'M');
  assert.equal(x.chart_from, undefined, 'no chart: the item looks exactly as before');

  await save('clothes', builtin('clothes'));
  x = await find(s1, p, sizes);
  assert.equal(x.size, 'M');
  assert.equal(x.chart_from, undefined);

  await save('clothes', smaller('clothes', 6));
  x = await find(s1, p, sizes);
  assert.deepEqual([x.size, x.chart_from, x.chart_size], ['L', 'M', 'L']);
  await save(p.category_id, builtin('clothes'));
  assert.equal((await find(s1, p, sizes)).size, 'M', 'the category\'s own chart wins over the default');
  await call('DELETE', `/api/admin/size-charts/${p.category_id}`, undefined, owner1);

  // Runs small (+1): one more size up from the shop's size.
  await db('products').where({ id: p.id }).update({ fit_offset: 1 });
  x = await find(s1, p, sizes);
  assert.deepEqual([x.size, x.fit_from, x.chart_from], ['XL', 'L', 'M']);
  await db('products').where({ id: p.id }).update({ fit_offset: null });

  // Missed demand asks for the shop's size too.
  await db('product_stock').where({ product_id: p.id, size: 'L' }).update({ quantity: 0 });
  const r = await call('POST', '/api/recommend', { store_id: s1, gender: 'male', sizes, want: ['top'] });
  assert.equal(r.status, 200);
  const missed = await db('missed_demand').where({ product_id: p.id }).select('size');
  assert.ok(missed.length && missed.every((m) => m.size === 'L'), JSON.stringify(missed));
  await db('product_stock').where({ product_id: p.id }).update({ quantity: 5 });
  await call('DELETE', '/api/admin/size-charts/clothes', undefined, owner1);
});

test('children: a kids chart moves the height size; adults are untouched by it', async () => {
  const kid = await db('products').where({ store_id: s1, category: 'top', audience: 'child' }).orderBy('id').first();
  await db('product_stock').where({ product_id: kid.id }).update({ quantity: 5, reserved: 0 });
  await db('products').where({ id: kid.id }).update({ gender: 'unisex', temp_min: -30, temp_max: 40, fit_offset: null });
  const sizes = { top: '116', bottom: '116', shoes: null };
  assert.equal((await find(s1, kid, sizes, 'child')).size, '116');
  await save('kids', smaller('kids', 6));
  const x = await find(s1, kid, sizes, 'child');
  assert.deepEqual([x.size, x.chart_from], ['122', '116']);
  const adult = await topOf(s1, { fit_offset: null });
  assert.equal((await find(s1, adult, { top: 'M', bottom: 'M' })).size, 'M');
  await call('DELETE', '/api/admin/size-charts/kids', undefined, owner1);
});

test('mall: one outfit, two shops, two charts; the search sizes each item in its own shop', async () => {
  await save('clothes', smaller('clothes', 6)); // shop 1 cuts small; shop 2 has no chart
  const r = await call('POST', '/api/recommend/mall', { mall_id: mall, gender: 'male', sizes: { top: 'M', bottom: 'M', shoes: '42' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const clothes = items(r.body).filter((p) => ['outerwear', 'top', 'bottom'].includes(p.category));
  const by = (s) => clothes.filter((p) => p.store_id === s);
  assert.ok(by(s1).length && by(s2).length, 'both shops are on the screen');
  for (const p of by(s1)) assert.deepEqual([p.chart_from, p.chart_size], ['M', 'L'], p.name);
  for (const p of by(s2)) assert.equal(p.chart_from, undefined, p.name);
  for (const p of by(s2).filter((x) => !x.fit_offset)) assert.equal(p.size, 'M');

  // A term both shops' items share; the search matches names and categories.
  const term = 'ko';
  const s = await call('GET', `/api/malls/${mall}/search?q=${term}&gender=male&top=M&bottom=M`);
  assert.equal(s.status, 200);
  const tops = s.body.items.filter((p) => ['top', 'outerwear', 'bottom'].includes(p.category));
  for (const p of tops) {
    if (p.my_size === null) continue; // that size is sold out here
    assert.equal(p.chart_from, p.store_id === s1 ? 'M' : null, p.name);
  }
  const plain = await call('GET', `/api/malls/${mall}/search?q=${term}`);
  assert.ok(plain.body.items.every((p) => !('my_size' in p) && !('fit_offset' in p)), 'without sizes: as before');
  await call('DELETE', '/api/admin/size-charts/clothes', undefined, owner1);
});

test('item page: "O\'lchamlar jadvali" with the customer\'s row, from the shop\'s chart or the built-in one', async () => {
  const p = await topOf(s1, { fit_offset: null });
  const get = (qs = '') => call('GET', `/api/catalog/${s1}/items/${p.id}${qs}`);
  let r = await get('?gender=male&top=M&bottom=M');
  assert.equal(r.status, 200);
  let c = r.body.item.size_chart;
  assert.deepEqual([c.kind, c.own, c.gender, c.mine, c.my_size, c.chart_from], ['clothes', false, 'male', 'M', 'M', null]);
  assert.deepEqual(c.measures, ['chest', 'waist', 'hips']);
  assert.deepEqual(c.rows, builtin('clothes').male);

  await save('clothes', smaller('clothes', 6));
  c = (await get('?gender=male&top=M')).body.item.size_chart;
  assert.deepEqual([c.own, c.mine, c.my_size, c.chart_from], [true, 'L', 'L', 'M']);
  assert.deepEqual(c.rows, smaller('clothes', 6).male);
  await db('products').where({ id: p.id }).update({ fit_offset: 1 });
  c = (await get('?gender=male&top=M')).body.item.size_chart;
  assert.deepEqual([c.mine, c.my_size], ['L', 'XL'], 'the row is the chart\'s; the size to pick has the fit offset');
  await db('products').where({ id: p.id }).update({ fit_offset: null });

  c = (await get()).body.item.size_chart;
  assert.deepEqual([c.mine, c.my_size, c.gender], [null, null, 'male'], 'no customer: the table only');
  c = (await get('?gender=female&top=M&bottom=<script>')).body.item.size_chart;
  assert.equal(c.gender, 'female');
  // Shop 2 has no chart: the built-in table.
  const p2 = await topOf(s2);
  c = (await call('GET', `/api/catalog/${s2}/items/${p2.id}?gender=male&top=M`)).body.item.size_chart;
  assert.deepEqual([c.own, c.mine], [false, 'M']);
  const acc = await db('products').where({ store_id: s1, category: 'accessory' }).whereExists(db('product_stock').whereRaw('product_id = products.id').where('quantity', '>', 0)).first();
  assert.equal((await call('GET', `/api/catalog/${s1}/items/${acc.id}`)).body.item.size_chart, null, 'one size: no table');
  await call('DELETE', '/api/admin/size-charts/clothes', undefined, owner1);
});
