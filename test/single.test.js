// Task 30: single items ("Faqat bitta kiyim kerak"): want/own validation, stock in the asked size, weather and budget
// per category, the "Bor kiyimimga mos" re-rank, no bundle discount, the size step per category, mode logging, the
// AI re-rank with its fallback, the sales split, and full-outfit requests unchanged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { json, testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { filterCandidates, ruleOutfits, singleItems, MAX_SINGLE } from '../src/recommend/engine.js';
import { applyRanking } from '../src/recommend/stylist.js';
import { weeklyReport } from '../src/notify/telegram.js';
import { funnelStats } from '../src/demand.js';
import { sizeNeeds, sizesReady, toRequest, routeData } from '../public/app/flow.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, aiServer, base, aiBase, store, token;
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
const recommend = (extra = {}, at = base) => call('POST', '/api/recommend', { store_id: store, gender: 'male', ...extra }, null, at);
const free = async (id, size) => (await db('product_stock').where({ product_id: id }).modify((q) => size && q.where({ size })).whereRaw('quantity - reserved > 0')).length;
const shown = (r) => r.body.groups.flatMap((g) => g.items);

before(async () => {
  await db.migrate.latest();
  await seed(db);
  store = (await db('stores').orderBy('id').first()).id;
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

// Pure engine candidates: everything in stock and worn all year unless said otherwise.
let nextId = 1000;
const item = (category, unit_price, extra = {}) => ({ id: nextId++, category, price: unit_price, discount_price: null, unit_price, temp_min: -30, temp_max: 40, waterproof: false, color: 'qora', style: 'casual', ...extra });

test('want validation: categories once each, own only with want and from fixed lists; only the wanted sizes are required', async () => {
  const sizes = { top: 'M', bottom: 'M' };
  for (const want of ['top', [], ['hat'], ['top', 'top'], [999999], [1.5], { 0: 'top' }]) {
    const r = await recommend({ sizes, want });
    assert.equal(r.status, 400, JSON.stringify(want));
    assert.equal(r.body.code, 'invalid');
  }
  for (const own of [[{ category: 'bottom', color: 'qora' }]]) assert.equal((await recommend({ sizes, own })).status, 400, 'own without want');
  for (const own of ['qora', [{ category: 'bottom' }], [{ category: 'hat', color: 'qora' }], [{ category: 'bottom', color: 'neon' }],
    [{ category: 'bottom', color: 'qora', style: 'punk' }], Array(6).fill({ category: 'bottom', color: 'qora' }), [null]]) {
    assert.equal((await recommend({ sizes, want: ['top'], own })).status, 400, JSON.stringify(own));
  }
  // Only what the choice needs: shoes or accessories need no clothing size; the top size for outerwear/top, bottom for bottom.
  assert.equal((await recommend({ sizes: {}, want: ['shoes', 'accessory'] })).status, 200);
  assert.equal((await recommend({ sizes: { bottom: 'M' }, want: ['outerwear'] })).status, 400);
  assert.equal((await recommend({ sizes: { top: 'M' }, want: ['bottom'] })).status, 400);
  assert.equal((await recommend({ sizes: { top: 'M' }, want: ['top', 'outerwear'] })).status, 200);
  assert.equal((await recommend({ sizes: { top: 'Q' }, want: ['shoes'] })).status, 400, 'a given size is still checked');
  const ok = await recommend({ sizes: { top: 'M' }, want: ['top', 'outerwear'], own: [{ category: 'bottom', color: "to'q ko'k", style: 'casual' }, { category: 'shoes', color: 'oq' }] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.mode, 'single');
  assert.deepEqual(ok.body.groups.map((g) => g.category), ['outerwear', 'top'], 'in category order, whatever order was sent');
  assert.deepEqual(ok.body.outfits, []);
});

test('only stock > 0 in the asked size, for every item, cheaper variant and pair; a sold-out size disappears', async () => {
  let checked = 0;
  for (const temperature of [-10, 5, 15, 30])
    for (const size of ['S', 'M', 'XL']) {
      weather = { ...weather, temperature };
      const r = await recommend({ sizes: { top: size, bottom: size, shoes: '42' }, want: ['outerwear', 'top', 'bottom', 'shoes', 'accessory'] });
      assert.equal(r.status, 200);
      for (const g of r.body.groups) {
        assert.ok(g.items.length <= MAX_SINGLE);
        for (const p of g.items) {
          assert.equal(p.category, g.category);
          for (const x of [p, ...(p.alternative ? [p.alternative] : [])]) {
            assert.ok((await free(x.id, x.size)) > 0, `${x.id} ${x.size}`);
            if (['outerwear', 'top', 'bottom'].includes(x.category)) assert.equal(x.size, size);
            if (x.category === 'shoes') assert.equal(x.size, '42');
            checked++;
          }
          for (const x of p.pairs) assert.ok((await free(x.id, x.size)) > 0, `pair ${x.id}`);
        }
      }
    }
  assert.ok(checked > 50, 'the seed gave single items');
  weather = { ...weather, temperature: 5 };
  const before = shown(await recommend({ sizes: { top: 'M' }, want: ['top'] }));
  const [a, b] = before;
  await db('product_stock').where({ product_id: a.id, size: 'M' }).update({ quantity: 0, reserved: 0 });
  await db('product_stock').where({ product_id: b.id, size: 'M' }).update({ reserved: db.raw('quantity') });
  const ids = shown(await recommend({ sizes: { top: 'M' }, want: ['top'] })).flatMap((p) => [p.id, p.alternative?.id]);
  assert.ok(!ids.includes(a.id) && !ids.includes(b.id));
});

test('weather ranking per category: −10, 15, 30 °C and rain', async () => {
  const coat = item('outerwear', 900000, { temp_min: -30, temp_max: 0 });
  const jacket = item('outerwear', 600000, { temp_min: 5, temp_max: 20 });
  const rainJacket = item('outerwear', 500000, { temp_min: 5, temp_max: 35, waterproof: true });
  const sweater = item('top', 300000, { temp_min: -15, temp_max: 12 });
  const tee = item('top', 100000, { temp_min: 18, temp_max: 40 });
  const all = [coat, jacket, rainJacket, sweater, tee];
  const order = (temperature, raining = false) => Object.fromEntries(singleItems(all, { want: ['outerwear', 'top'], temperature, raining }).map((g) => [g.category, g.items.map((p) => p.id)]));
  assert.deepEqual(order(-10), { outerwear: [coat.id, jacket.id, rainJacket.id], top: [sweater.id, tee.id] }, 'cold: the coat and the sweater first');
  assert.deepEqual(order(15), { outerwear: [jacket.id, rainJacket.id, coat.id], top: [tee.id, sweater.id] }, '15 °C: closest window first, the coat last');
  assert.deepEqual(order(15, true).outerwear, [rainJacket.id, jacket.id, coat.id], 'rain: waterproof first');
  assert.deepEqual(order(30).top, [tee.id, sweater.id], 'heat: the tee first');

  // Through the API (the DB filter): every item's temperature window holds today's temperature, widened only by `relaxed`.
  for (const [temperature, raining] of [[-10, false], [15, false], [30, false], [12, true]]) {
    weather = { ...weather, temperature, raining };
    const r = await recommend({ sizes: { top: 'L', bottom: 'L' }, want: ['outerwear', 'top', 'bottom'] });
    for (const g of r.body.groups) {
      const relaxed = r.body.relaxed;
      for (const p of g.items) assert.ok(p.temp_min - relaxed <= temperature && p.temp_max + relaxed >= temperature, `${p.id} at ${temperature}`);
      const inWindow = g.items.map((p) => p.temp_min <= temperature && p.temp_max >= temperature);
      assert.deepEqual(inWindow, [...inWindow].sort((x, y) => y - x), 'in-window items before relaxed ones');
      if (raining) {
        const wp = g.items.map((p) => p.waterproof && p.temp_min <= temperature && p.temp_max >= temperature);
        assert.ok(wp.indexOf(false) === -1 || !wp.slice(wp.indexOf(false)).includes(true), 'rain: in-window waterproof first');
      }
    }
  }
  weather = { ...weather, temperature: 5, raining: false };
});

test('per-item budget: items over it are left out; nothing in budget → the cheapest and how far over', async () => {
  const cheap = item('bottom', 100000), mid = item('bottom', 200000), dear = item('bottom', 300000), shoe = item('shoes', 400000);
  const [b, s] = singleItems([dear, mid, cheap, shoe], { want: ['bottom', 'shoes'], temperature: 10, raining: false, budget: 250000 });
  assert.deepEqual(b.items.map((p) => p.id), [cheap.id, mid.id], 'cheapest first within the budget');
  assert.equal(b.over_budget, 0);
  assert.deepEqual(s.items.map((p) => p.id), [shoe.id], 'fallback: the cheapest shoes anyway');
  assert.equal(s.over_budget, 150000);
  assert.equal(b.items[1].alternative, null, 'the cheaper one is already shown');
  const [only] = singleItems([dear, mid, cheap], { want: ['bottom'], temperature: 10, raining: false });
  assert.equal(only.items.length, 3);
  // Seven items: six shown, the cheapest unshown cheaper item is the variant.
  const many = Array.from({ length: 7 }, (_, i) => item('top', 100000 + i * 1000, { temp_min: i === 0 ? 30 : -30, temp_max: 40 }));
  const [g] = singleItems(many, { want: ['top'], temperature: 10, raining: false });
  assert.equal(g.items.length, MAX_SINGLE);
  assert.ok(!g.items.some((p) => p.id === many[0].id), 'the out-of-window one is seventh');
  assert.equal(g.items[0].alternative.id, many[0].id);

  // API: every item within the budget, or the fallback with over_budget.
  const r = await recommend({ sizes: { top: 'M', bottom: 'M' }, want: ['top', 'bottom', 'shoes'], budget: 250000 });
  for (const grp of r.body.groups) {
    if (grp.over_budget) assert.equal(Math.min(...grp.items.map((p) => p.unit_price)) - 250000, grp.over_budget);
    else for (const p of grp.items) assert.ok(p.unit_price <= 250000);
  }
  const none = await recommend({ sizes: { top: 'M' }, want: ['top'], budget: 1 });
  assert.ok(none.body.groups[0].over_budget > 0 && none.body.groups[0].items.length > 0);
});

test('"Bor kiyimimga mos": own changes the order, never the stock rule', async () => {
  const red = item('top', 100000, { color: 'qizil', style: 'sport' });
  const black = item('top', 110000, { color: 'qora', style: 'classic' });
  const grey = item('top', 120000, { color: 'kulrang', style: 'casual' });
  const ids = (own) => singleItems([red, black, grey], { want: ['top'], own, temperature: 10, raining: false, budget: 1e6 })[0].items.map((p) => p.id);
  assert.deepEqual(ids([]), [red.id, black.id, grey.id], 'without own: the rank (cheapest first with a budget)');
  assert.deepEqual(ids([{ category: 'bottom', color: 'sariq', style: null }]), [black.id, grey.id, red.id], 'a bright item owned: no second bright colour first');
  assert.deepEqual(ids([{ category: 'bottom', color: 'qora', style: 'classic' }]), [black.id, red.id, grey.id], 'same style first');
  // Casual owned first, classic second: the classic black top is not pushed back (only the first style used to count).
  assert.deepEqual(ids([{ category: 'shoes', color: 'oq', style: 'casual' }, { category: 'bottom', color: 'qora', style: 'classic' }]), [black.id, red.id, grey.id],
    'every owned style counts, not only the first');

  const sizes = { top: 'M', bottom: 'M' };
  const plain = shown(await recommend({ sizes, want: ['top', 'bottom'] }));
  const withOwn = shown(await recommend({ sizes, want: ['top', 'bottom'], own: [{ category: 'shoes', color: 'qizil', style: 'classic' }] }));
  assert.notDeepEqual(withOwn.map((p) => p.id), plain.map((p) => p.id), 'the order changed');
  for (const p of withOwn) assert.ok((await free(p.id, p.size)) > 0);
  const bright = (p) => !['qora', 'oq', 'kulrang', "to'q ko'k", 'bej', 'jigarrang', 'krem', 'zaytun', "ko'k"].includes(p.color);
  for (const cat of ['top', 'bottom']) {
    const list = withOwn.filter((p) => p.category === cat).map(bright);
    assert.deepEqual(list, [...list].sort((x, y) => x - y), `${cat}: bright ones after the rest`);
  }
});

test('no bundle discount on single items: the cart never trusts a single-item screen as an outfit', async () => {
  await db('stores').where({ id: store }).update({ bundle_percent: 20 });
  const r = await recommend({ sizes: { top: 'M', bottom: 'M', shoes: '42' }, want: ['outerwear', 'top', 'bottom', 'shoes'] });
  assert.equal(r.body.bundle_percent, 0);
  assert.deepEqual(json((await db('recommendation_logs').where({ token: r.body.rec }).first()).outfits), []);
  const pick = r.body.groups.map((g) => g.items[0]).filter(Boolean);
  assert.ok(pick.length >= 3);
  const items = pick.map((p) => ({ product_id: p.id, size: p.size ?? p.sizes[0] }));
  const cart = await call('POST', '/api/cart/items', { store_id: store, items, rec: r.body.rec, outfit: pick.map((p) => p.id) });
  assert.equal(cart.status, 200);
  assert.equal(cart.body.discounts.bundle, 0);
  assert.equal(cart.body.totals.pickup.total, pick.reduce((a, p) => a + p.unit_price, 0), 'full price, totals from the server');
  // The same store still gives the bundle on a whole outfit.
  const whole = (await recommend({ sizes: { top: 'M', bottom: 'M', shoes: '42' } })).body;
  const o = whole.outfits[0];
  const c2 = await call('POST', '/api/cart/items', { store_id: store, items: o.items.map((p) => ({ product_id: p.id, size: p.size ?? p.sizes[0] })), rec: whole.rec, outfit: o.items.map((p) => p.id) });
  assert.ok(c2.body.discounts.bundle > 0);
  for (const t of [cart.body.token, c2.body.token]) await call('DELETE', `/api/cart/${t}`);
  await db('stores').where({ id: store }).update({ bundle_percent: 0 });
});

test('size step per category: what the choice needs, and the form skips height for shoes or accessories', () => {
  assert.deepEqual(sizeNeeds(null), { top: true, bottom: true, shoes: true, photo: true }, 'whole outfit: as before');
  assert.deepEqual(sizeNeeds(['outerwear']), { top: true, bottom: false, shoes: false, photo: true });
  assert.deepEqual(sizeNeeds(['top']), { top: true, bottom: false, shoes: false, photo: true });
  assert.deepEqual(sizeNeeds(['bottom']), { top: false, bottom: true, shoes: false, photo: true });
  assert.deepEqual(sizeNeeds(['shoes']), { top: false, bottom: false, shoes: true, photo: false }, 'shoes: the shoe size only, no photo');
  assert.deepEqual(sizeNeeds(['accessory']), { top: false, bottom: false, shoes: false, photo: false }, 'accessories: no size step');
  assert.deepEqual(sizeNeeds(['outerwear', 'shoes']), { top: true, bottom: false, shoes: true, photo: true });
  assert.equal(sizesReady({ top: 'M', bottom: null }, ['top']), true);
  assert.equal(sizesReady({ top: 'M', bottom: null }, null), false);
  assert.equal(sizesReady({}, ['shoes', 'accessory']), true);
  assert.equal(sizesReady({ top: null }, ['outerwear']), false);

  const v = { gender: 'female', height: '', weight: '', shoes: '38', budget: '', want: ['shoes'] };
  const r = toRequest(v, 1);
  assert.deepEqual(r.request, { store_id: 1, gender: 'female', sizes: { top: null, bottom: null, shoes: '38' }, budget: null, want: ['shoes'] });
  assert.equal(toRequest({ ...v, want: ['top'] }, 1), null, 'a clothing size needs the height');
  assert.equal(toRequest({ ...v, want: null }, 1), null, 'whole outfit: as before');
  assert.deepEqual(toRequest({ ...v, height: '170', want: ['hat', 'top', 'top'] }, 1).request.want, ['top'], 'unknown and repeated categories dropped');
  assert.equal('want' in toRequest({ ...v, height: '170', want: null }, 1).request, false, 'no want key for a whole outfit');
  // The route keeps the choice and what the customer owns, from the lists only.
  const saved = routeData({ screen: 'results', form: { ...v, want: ['bottom', 'x'] }, own: [{ category: 'top', color: 'qora', style: 'sport', name: 'X' }, { category: 'hat', color: 'qora' }] });
  assert.deepEqual(saved.form.want, ['bottom']);
  assert.deepEqual(saved.own, [{ category: 'top', color: 'qora', style: 'sport' }]);
});

test('mode logging: results, funnel and missed demand carry outfit|single and nothing personal', async () => {
  const visit = 'a'.repeat(32);
  assert.equal((await call('POST', '/api/funnel', { store_id: store, visit, step: 'outfits', mode: 'single' })).status, 204);
  assert.equal((await call('POST', '/api/funnel', { store_id: store, visit, step: 'cart', mode: 'both' })).status, 400);
  assert.equal((await call('POST', '/api/funnel', { store_id: store, visit, step: 'start' })).status, 204, 'mode optional (start screen)');
  const ev = await db('funnel_events').where({ visit }).orderBy('id');
  assert.deepEqual(ev.map((e) => [e.step, e.mode]), [['outfits', 'single'], ['start', null]]);
  // The funnel per mode: a visit counts under its chosen mode at every step it reached; one that never chose is in neither.
  const other = 'b'.repeat(32), none = 'c'.repeat(32);
  for (const step of ['size', 'outfits', 'cart']) await call('POST', '/api/funnel', { store_id: store, visit: other, step, mode: 'outfit' });
  await call('POST', '/api/funnel', { store_id: store, visit: none, step: 'start' });
  const f = await funnelStats(db, (q, col) => q.where(col, store), { from: Date.now() - 3600_000 });
  assert.deepEqual(f.per_mode, [
    { mode: 'outfit', start: 1, size: 1, outfits: 1, cart: 1, order: 0 },
    { mode: 'single', start: 1, size: 1, outfits: 1, cart: 0, order: 0 },
  ]);
  assert.equal(f.total.start, 3);
  assert.deepEqual((await call('GET', '/api/admin/demand?days=7', undefined, token)).body.funnel.per_mode, f.per_mode, 'on the Talab page');

  // A size with no free stock of a wanted category is missed demand with mode single; other categories are not logged.
  const top = await db('products').where({ store_id: store, category: 'top' }).where('temp_min', '<=', 5).where('temp_max', '>=', 5).whereIn('gender', ['male', 'unisex']).orderBy('id').first();
  await db('product_stock').where({ product_id: top.id, size: 'XXL' }).update({ quantity: 0, reserved: 0 });
  weather = { ...weather, temperature: 5, raining: false };
  const s = await recommend({ sizes: { top: 'XXL', bottom: 'XXL' }, want: ['top'] });
  const missed = await db('missed_demand').where({ session: s.body.rec });
  assert.ok(missed.some((m) => m.product_id === top.id && m.size === 'XXL'));
  assert.ok(missed.every((m) => m.mode === 'single'));
  const cats = await db('products').whereIn('id', missed.map((m) => m.product_id)).distinct('category');
  assert.deepEqual(cats.map((c) => c.category), ['top'], 'only the wanted category');
  const o = await recommend({ sizes: { top: 'XXL', bottom: 'XXL' } });
  assert.ok((await db('missed_demand').where({ session: o.body.rec })).every((m) => m.mode === 'outfit'));

  const logs = await db('recommendation_logs').whereIn('token', [s.body.rec, o.body.rec]).orderBy('id');
  assert.deepEqual(logs.map((l) => l.mode), ['single', 'outfit']);
  assert.deepEqual(json(logs[0].product_ids), shown(s).map((p) => p.id));
  for (const t of ['recommendation_logs', 'funnel_events', 'missed_demand']) {
    const cols = Object.keys(await db(t).columnInfo());
    assert.ok(!cols.some((c) => /phone|name|photo|height|weight|address/.test(c)), `${t}: ${cols}`);
  }
});

test('Claude for single items only re-orders the rule picks; unknown IDs ignored; any failure → rules', async () => {
  const body = { sizes: { top: 'M', bottom: 'M' }, want: ['top', 'bottom'], own: [{ category: 'shoes', color: 'oq' }] };
  const rules = await recommend(body);
  const ids = shown(rules).map((p) => p.id);
  const lastTop = rules.body.groups[0].items.at(-1).id;
  stylistAnswer = { style_guess: 'kundalik', product_ids: [999999, lastTop, 'x', lastTop] };
  const ai = await recommend(body, aiBase);
  assert.equal(ai.body.source, 'ai');
  assert.equal(ai.body.style_guess, 'kundalik');
  assert.equal(ai.body.groups[0].items[0].id, lastTop, 'Claude\'s pick first');
  assert.deepEqual(shown(ai).map((p) => p.id).sort(), [...ids].sort(), 'same items, nothing added or dropped');
  assert.equal(stylistSeen.mode, 'single');
  assert.deepEqual(stylistSeen.own, [{ category: 'shoes', color: 'oq', style: null }], 'own normalised to the three fields');
  assert.deepEqual(stylistSeen.candidates.map((p) => p.id).sort(), [...ids].sort(), 'Claude sees only the shown items');
  assert.equal((await db('recommendation_logs').where({ token: ai.body.rec }).first()).source, 'ai');

  for (const answer of [{ product_ids: [999999] }, { outfits: [] }, null, new Error('boom')]) {
    stylistAnswer = answer;
    const r = await recommend(body, aiBase);
    assert.equal(r.body.source, 'rules');
    assert.deepEqual(shown(r).map((p) => p.id), ids);
  }
  stylistAnswer = null;
  // Pure: ties keep the rules order, and a group Claude didn't mention keeps its order.
  const g = [{ category: 'top', items: [{ id: 1 }, { id: 2 }, { id: 3 }] }, { category: 'bottom', items: [{ id: 4 }, { id: 5 }] }];
  assert.deepEqual(applyRanking({ product_ids: [3] }, g).groups.map((x) => x.items.map((p) => p.id)), [[3, 1, 2], [4, 5]]);
});

test('sales split: outfit vs single vs other in /stats and the weekly report; old full-outfit requests unchanged', async () => {
  // Old request (no want): exactly what the outfit rules give, plus mode outfit.
  weather = { ...weather, temperature: 5, raining: false };
  const sizes = { top: 'L', bottom: 'L', shoes: '42' };
  const old = await recommend({ sizes });
  const load = (spread) => filterCandidates(db, { storeId: store, gender: 'male', sizes, temperature: 5, spread });
  const { candidates, ...expected } = await ruleOutfits(load, { temperature: 5, raining: false, budget: null });
  assert.deepEqual(old.body.outfits, JSON.parse(JSON.stringify(expected.outfits)));
  assert.equal(old.body.mode, 'outfit');
  assert.equal('groups' in old.body, false);

  await db('orders').update({ recommendation_id: null });
  await db('carts').update({ recommendation_id: null });
  const order = async (rec, p) => {
    const cart = await call('POST', '/api/cart/items', { store_id: store, items: [{ product_id: p.id, size: p.size ?? p.sizes[0] }], ...(rec && { rec }) });
    const r = await call('POST', `/api/cart/${cart.body.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '+998901234567' });
    assert.equal(r.status, 201);
    assert.equal((await call('POST', `/api/admin/orders/${r.body.order.id}/pay`, {}, token)).status, 200);
    return r.body.order.total;
  };
  const single = await recommend({ sizes: { top: 'M' }, want: ['top'] });
  const outfit = await recommend({ sizes });
  const a = await order(single.body.rec, single.body.groups[0].items[0]);
  const b = await order(outfit.body.rec, outfit.body.outfits[0].items[0]);
  const c = await order(null, single.body.groups[0].items[1]);
  const s = (await call('GET', '/api/admin/stats?days=7', undefined, token)).body;
  assert.deepEqual(s.sales.single, { orders: 1, revenue: a });
  assert.ok(s.sales.outfit.orders >= 1 && s.sales.outfit.revenue >= b);
  assert.ok(s.sales.other.orders >= 1 && s.sales.other.revenue >= c);
  // A log from before task 30 (no mode) counts as an outfit.
  await db('recommendation_logs').where({ token: outfit.body.rec }).update({ mode: null });
  assert.deepEqual((await call('GET', '/api/admin/stats?days=7', undefined, token)).body.sales.outfit, s.sales.outfit);

  const local = new Date(Date.now() + 5 * 3600 * 1000);
  const next = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - ((local.getUTCDay() + 6) % 7) + 7)).toISOString().slice(0, 10);
  const text = await weeklyReport(db, await db('stores').where({ id: store }).first(), next);
  assert.match(text, /\nObraz: \d+ ta, alohida kiyim: 1 ta, katalog: \d+ ta\n/);
});
