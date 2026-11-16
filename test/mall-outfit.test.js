// Task 42: an outfit from the whole mall. The same engine over every shown shop's in-stock items in the customer's size,
// a per-shop cap on top (with its fallback), the outfit into the mall cart per shop (each shop's own bundle rule), the
// Claude stylist's answer checked against the list it was given, and each shop's statistics holding only its own items.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { json, testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { buildOutfits } from '../src/recommend/engine.js';
import { applyStylist, createStylist } from '../src/recommend/stylist.js';
import { MALL_CAPS, STYLIST_MAX } from '../src/recommend/mall.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, mall, otherMall, s1, s2, sHidden, sOther, owner1, owner2, mallAdmin;
const COLD = { temperature: 5, apparent_temperature: 2, raining: false, wind_speed: 3, source: 'live' };
let weather = COLD;
const asked = []; // what the weather function was asked for
const BODY = { gender: 'male', sizes: { top: 'L', bottom: 'L', shoes: '42' } };

const call = async (method, p, body, token) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const look = (extra = {}, to = base) => fetch(`${to}/api/recommend/mall`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mall_id: mall, ...BODY, ...extra }) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const login = async (email, password) => (await call('POST', '/api/admin/login', { email, password })).body.token;
const items = (r) => [...r.outfits.flatMap((o) => [...o.items, ...(o.alternative?.items ?? [])]), ...(r.partial?.items ?? [])];
const storeOf = async (ids) => new Map((await db('products').whereIn('id', ids).select('id', 'store_id')).map((p) => [p.id, p.store_id]));
const perShop = (list) => list.reduce((m, p) => m.set(p.store_id, (m.get(p.store_id) ?? 0) + 1), new Map());

// A copy of shop 1's adult products, every size in stock, in a new store of shop 1's organisation.
async function cloneStore(name, extra) {
  const org = (await db('stores').where({ id: s1 }).first()).organization_id;
  const [{ id }] = await db('stores').insert({ name, city: 'Toshkent', address: 'Navoiy 5', lat: 41.3, lon: 69.25, organization_id: org, ...extra }).returning('id');
  for (const { id: pid, sku, created_at, updated_at, ...p } of await db('products').where({ store_id: s1, audience: 'adult' }).orderBy('id')) {
    const [{ id: copy }] = await db('products').insert({ ...p, store_id: id, sku: null }).returning('id');
    const stock = await db('product_stock').where({ product_id: pid }).select('size');
    await db('product_stock').insert(stock.map((s) => ({ product_id: copy, size: s.size, quantity: 5, reserved: 0 })));
  }
  return id;
}

before(async () => {
  await db.migrate.latest();
  await seed(db); // two demo shops, both in the demo mall
  [s1, s2] = (await db('stores').orderBy('id')).map((s) => s.id);
  mall = (await db('malls').first()).id;
  await db('stores').where({ id: s1 }).update({ mall_floor: '2', mall_unit: '214' });
  await db('stores').where({ id: s2 }).update({ mall_floor: '1', mall_unit: '105' });
  [{ id: otherMall }] = await db('malls').insert({ name: 'Boshqa markaz', city: 'Toshkent', address: 'Navoiy 1' }).returning('id');
  sHidden = await cloneStore('Yashirin do\'kon', { mall_id: mall, mall_hidden: true });
  sOther = await cloneStore('Boshqa markazdagi do\'kon', { mall_id: otherMall });
  await createAdmin(db, { email: 'owner1@smartfit.uz', password: 'owner-pass-1', storeId: s1 });
  await createAdmin(db, { email: 'owner2@smartfit.uz', password: 'owner-pass-2', storeId: s2 });
  await createAdmin(db, { email: 'mall@smartfit.uz', password: 'mall-pass-1', mallId: mall });
  server = createApp(db, { telegram: null, stylist: null, weather: async (where) => (asked.push(where), weather), limits: { recommend: 0, cart: 0 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner1 = await login('owner1@smartfit.uz', 'owner-pass-1');
  owner2 = await login('owner2@smartfit.uz', 'owner-pass-2');
  mallAdmin = await login('mall@smartfit.uz', 'mall-pass-1');
});
after(async () => {
  server?.close();
  await db.destroy();
});

test('only the shown shops of this mall, only free stock in the customer\'s size; each item names its shop', async () => {
  const shown = new Set([s1, s2]);
  let n = 0;
  for (const [t, raining] of [[-10, false], [5, false], [15, false], [17, true], [30, false]]) {
    weather = { ...COLD, temperature: t, raining };
    for (const gender of ['male', 'female'])
      for (const size of ['S', 'M', 'L', 'XL']) {
        const r = await look({ gender, sizes: { top: size, bottom: size, shoes: gender === 'male' ? '42' : '38' } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.mall_id, mall);
        for (const p of items(r.body)) {
          n++;
          assert.ok(shown.has(p.store_id), `item ${p.id} from store ${p.store_id}`);
          assert.equal((await db('products').where({ id: p.id }).first()).store_id, p.store_id);
          assert.equal(p.size, ['shoes'].includes(p.category) ? (gender === 'male' ? '42' : '38') : p.category === 'accessory' ? p.size : size);
          const free = await db('product_stock').where({ product_id: p.id, size: p.size }).whereRaw('quantity - reserved > 0').first('id');
          assert.ok(free, `${p.id} ${p.size} in stock`);
          const s = r.body.shops.find((x) => x.id === p.store_id);
          assert.ok(s && s.name, 'its shop is in the answer');
        }
        assert.ok(r.body.shops.every((s) => shown.has(s.id) && !('lat' in s) && !('organization_id' in s)));
      }
  }
  assert.ok(n > 100, `checked ${n} items`);
  weather = COLD;
  const r = await look();
  assert.deepEqual(r.body.shops.find((s) => s.id === s1), { id: s1, name: 'Smart Fit Toshkent', floor: '2', unit: '214', logo_url: null, bundle_percent: 0 });
  // A sold-out size never comes back: zero (or all reserved) in L for every top of shop 2.
  const tops = await db('products').where({ store_id: s2, category: 'top' }).pluck('id');
  const before = await db('product_stock').whereIn('product_id', tops).where({ size: 'L' }).select('id', 'quantity', 'reserved');
  await db('product_stock').whereIn('product_id', tops).where({ size: 'L' }).update({ reserved: db.raw('quantity') });
  assert.ok(!items((await look()).body).some((p) => tops.includes(p.id)));
  for (const b of before) await db('product_stock').where({ id: b.id }).update({ reserved: b.reserved });
  // The hidden shop is there only once the mall shows it (its copies are in stock in every size), and never another mall's.
  await db('stores').where({ id: sHidden }).update({ mall_hidden: false });
  const opened = items((await look()).body).map((p) => p.store_id);
  await db('stores').where({ id: sHidden }).update({ mall_hidden: true });
  assert.ok(opened.includes(sHidden), 'the filter is what keeps it out');
  assert.ok(!opened.includes(sOther));
});

test('the per-shop cap: no shop fills the list, and the fallback when too few shops have stock', () => {
  let id = 1;
  const shop = (store_id, n, cats = ['outerwear', 'top', 'bottom', 'shoes', 'accessory']) =>
    cats.flatMap((c) => Array.from({ length: n }, () => ({ id: id++, store_id, category: c, price: 100000, discount_price: null, unit_price: 100000, temp_min: -30, temp_max: 40, waterproof: false })));
  const ctx = { temperature: 5, raining: false, caps: MALL_CAPS };
  const most = (r) => Math.max(...perShop(r.outfits.flatMap((o) => o.items)).values());
  // Three shops with plenty: shop 10 has the lowest ids, so without the cap it would take every place.
  const three = [...shop(10, 5), ...shop(20, 5), ...shop(30, 5)];
  const open = buildOutfits(three, { temperature: 5, raining: false });
  assert.equal(most(open), 15, 'no cap: one shop fills all three outfits');
  const capped = buildOutfits(three, ctx);
  assert.equal(capped.outfits.length, 3);
  assert.equal(capped.cap, 6);
  assert.ok(most(capped) <= 6, 'at most 6 items of one shop across the outfits');
  assert.ok(capped.outfits.every((o) => ['outerwear', 'top', 'bottom', 'shoes'].every((c) => o.items.some((p) => p.category === c))));
  // Too few shops: shop 10 has 3 of each, shop 20 one of each → 6 per shop gives 2 outfits, 9 gives all 3.
  const few = [...shop(10, 3, ['outerwear', 'top', 'bottom', 'shoes']), ...shop(20, 1, ['outerwear', 'top', 'bottom', 'shoes'])];
  const fewR = buildOutfits(few, ctx);
  assert.equal(fewR.outfits.length, 3);
  assert.equal(fewR.cap, 9);
  assert.ok(most(fewR) <= 9);
  // One shop: the cap gives way completely, so a one-shop mall gets the outfits its shop would.
  const one = shop(10, 5);
  const oneR = buildOutfits(one, ctx);
  assert.equal(oneR.cap, null);
  assert.deepEqual(oneR.outfits.map((o) => o.items.map((p) => p.id)), buildOutfits(one, { temperature: 5, raining: false }).outfits.map((o) => o.items.map((p) => p.id)));
  // Budget: the outfits fit it with the cap too; over budget → the cheapest outfit and the partial, as for one shop.
  const priced = three.map((p) => ({ ...p, unit_price: 50000 + (p.id % 7) * 10000 }));
  const inBudget = buildOutfits(priced, { ...ctx, budget: 330000 });
  assert.ok(inBudget.outfits.length && inBudget.outfits.every((o) => o.total <= 330000 && o.total === o.items.reduce((s, p) => s + p.unit_price, 0)));
  const over = buildOutfits(priced, { ...ctx, budget: 100000 });
  assert.equal(over.outfits.length, 1);
  assert.ok(over.over_budget > 0 && over.partial);
});

test('the API: a one-shop mall still gets outfits, budget across shops, children, input checks, the mall\'s weather', async () => {
  // Another mall with one shop: its outfits are exactly what that shop's own flow gives.
  const one = await look({ mall_id: otherMall });
  const own = await call('POST', '/api/recommend', { store_id: sOther, ...BODY });
  assert.ok(one.body.outfits.length >= 1);
  assert.deepEqual(one.body.outfits.map((o) => o.items.map((p) => p.id)), own.body.outfits.map((o) => o.items.map((p) => p.id)));
  assert.ok(items(one.body).every((p) => p.store_id === sOther));
  // Budget across shops: every outfit total (the sum of items from different shops) within it.
  const full = await look();
  const totals = full.body.outfits.map((o) => o.total).sort((a, b) => a - b);
  const budget = totals[0];
  const r = await look({ budget });
  assert.ok(r.body.outfits.length >= 1 && r.body.outfits.every((o) => o.total <= budget));
  for (const o of r.body.outfits) assert.equal(o.total, o.items.reduce((s, p) => s + p.unit_price, 0));
  const tight = await look({ budget: 1000 });
  assert.ok(tight.body.over_budget > 0 && tight.body.outfits.length === 1);
  // A child gets children's items only, from the mall's shops.
  const kid = await look({ audience: 'child', sizes: { top: '116', bottom: '116', shoes: '30' } });
  assert.equal(kid.status, 200);
  assert.equal(kid.body.audience, 'child');
  const kidItems = items(kid.body);
  assert.ok(kidItems.length);
  assert.deepEqual([...new Set((await db('products').whereIn('id', kidItems.map((p) => p.id)).pluck('audience')))], ['child']);
  // Input checks: no or a bad mall, single items, a store id, unknown mall.
  for (const bad of [{ mall_id: undefined }, { mall_id: 'x' }, { mall_id: 1.5 }, { mall_id: 99999999999 }, { want: ['top'] }, { own: [] }, { gender: 'x' }, { audience: 'pet' }]) {
    assert.equal((await look(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await look({ mall_id: 999999 })).status, 404);
  // Weather: the mall's own coordinates; without them its first shop's.
  asked.length = 0;
  await look();
  assert.deepEqual([asked[0].id, asked[0].lat, asked[0].lon], [mall, 41.2995, 69.2401]);
  await db('malls').where({ id: otherMall }).update({ lat: null, lon: null });
  asked.length = 0;
  await look({ mall_id: otherMall });
  assert.equal(asked[0].id, sOther);
});

test('logging per shop: each shop\'s row has only its own items, its stats see only its own, the mall admin one count', async () => {
  await db('recommendation_logs').del();
  await db('mall_recs').del();
  const r = await look();
  const rows = await db('recommendation_logs').whereNotNull('mall_rec_id').orderBy('store_id');
  const stores = [...new Set(items(r.body).map((p) => p.store_id))].sort((a, b) => a - b);
  assert.deepEqual(rows.map((x) => x.store_id), stores, 'one row per shop on the screen');
  assert.deepEqual(Object.keys(r.body.recs).map(Number).sort((a, b) => a - b), stores);
  for (const row of rows) {
    assert.equal(r.body.recs[row.store_id], row.token);
    const ids = [...json(row.product_ids), ...json(row.outfits).flat()];
    const owner = await storeOf(ids);
    assert.ok(ids.every((id) => owner.get(id) === row.store_id), `store ${row.store_id} sees only its own items`);
    assert.ok(json(row.outfits).every((set) => set.length >= 2), 'a 1-item part is no outfit of that shop');
    assert.equal(row.mode, 'outfit');
  }
  // A −/+ re-query with the screen's rec keeps the same rows and counts once.
  const again = await look({ rec: r.body.rec, sizes: { ...BODY.sizes, top: 'XL' } });
  assert.equal(again.body.rec, r.body.rec);
  assert.equal(Number((await db('mall_recs').count({ n: '*' }))[0].n), 1);
  for (const [store, token] of Object.entries(again.body.recs)) if (r.body.recs[store]) assert.equal(token, r.body.recs[store]);
  // Each shop's dashboard: only its own products.
  for (const [token, store] of [[owner1, s1], [owner2, s2]]) {
    const st = await call('GET', '/api/admin/stats?days=7', undefined, token);
    assert.equal(st.status, 200);
    const owner = await storeOf(st.body.top.map((x) => x.product_id));
    assert.ok(st.body.top.length && st.body.top.every((x) => owner.get(x.product_id) === store));
  }
  // The mall admin: one more count, still nothing about products, prices or customers.
  await look();
  const m = await call('GET', '/api/admin/mall?days=7', undefined, mallAdmin);
  assert.equal(m.status, 200);
  assert.equal(m.body.totals.mall_outfits, 2);
  const text = JSON.stringify(m.body);
  for (const p of items(r.body)) assert.ok(!text.includes(p.name), 'no product names');
  assert.ok(!/price|total"|sum|product/.test(text.replace(/"totals"/, '')));
});

test('the outfit reaches the mall cart per shop, each shop\'s bundle by its own rule, all or nothing', async () => {
  await db('stores').where({ id: s1 }).update({ bundle_percent: 10 });
  await db('stores').where({ id: s2 }).update({ bundle_percent: 20 });
  await db('carts').del();
  const r = (await look()).body;
  // An outfit from both shops where one shop has 2+ items (its bundle counts) and the other has one (it doesn't).
  const o = r.outfits.find((x) => perShop(x.items).size === 2 && [...perShop(x.items).values()].sort().join() === '1,3');
  assert.ok(o, 'an outfit with 3 items of one shop and 1 of the other');
  const big = perShop(o.items).get(s1) === 3 ? s1 : s2, small = big === s1 ? s2 : s1;
  const sizeOf = (p) => p.size ?? p.sizes[0];
  const shops = [s1, s2].map((s) => ({ store_id: s, rec: r.recs[s], outfit: o.items.filter((p) => p.store_id === s).map((p) => p.id),
    items: o.items.filter((p) => p.store_id === s).map((p) => ({ product_id: p.id, size: sizeOf(p) })) }));
  // All or nothing: one of shop 2's items sold out since → nothing is held anywhere.
  const gone = shops[1].items[0];
  const stock = await db('product_stock').where({ product_id: gone.product_id, size: gone.size }).first();
  await db('product_stock').where({ id: stock.id }).update({ reserved: stock.quantity });
  const held = async () => Number((await db('product_stock').sum({ n: 'reserved' }))[0].n);
  const before = await held();
  const fail = await call('POST', '/api/mall-cart/items', { mall_id: mall, shops });
  assert.equal(fail.status, 409);
  assert.equal(await held(), before, 'shop 1 holds nothing either');
  assert.equal(Number((await db('carts').count({ n: '*' }))[0].n), 0);
  await db('product_stock').where({ id: stock.id }).update({ reserved: stock.reserved });

  const ok = await call('POST', '/api/mall-cart/items', { mall_id: mall, shops });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const cart = ok.body;
  assert.deepEqual(cart.shops.map((s) => s.store.id), [s1, s2], 'grouped by shop');
  assert.deepEqual(cart.shops.map((s) => [s.store.floor, s.store.unit]), [['2', '214'], ['1', '105']]);
  const part = (s) => o.items.filter((p) => p.store_id === s);
  const sum = (list) => list.reduce((a, p) => a + p.unit_price, 0);
  const c1 = cart.shops[0].cart, c2 = cart.shops[1].cart;
  const pct = { [s1]: 0.1, [s2]: 0.2 }, view = { [s1]: c1, [s2]: c2 };
  assert.ok(view[big].discounts.bundle > 0);
  assert.equal(view[big].discounts.bundle, Math.floor(sum(part(big)) * pct[big]), 'its 3 items of the outfit, its own percent');
  assert.equal(view[small].discounts.bundle, 0, 'a one-item part gets no bundle');
  // Each shop's results screen is now accepted (its pilot funnel), and the cart is tied to it.
  for (const s of [s1, s2]) {
    const row = await db('recommendation_logs').where({ token: r.recs[s] }).first();
    assert.ok(row.accepted_at);
    assert.equal((await db('carts').where({ mall_token: cart.token, store_id: s }).first()).recommendation_id, row.id);
  }
  // The other shop's rec can't stand in (its sets hold only its own ids): no bundle claimed through it.
  await call('DELETE', `/api/mall-cart/${cart.token}`);
  const wrong = await call('POST', '/api/mall-cart/items', { mall_id: mall, shops: [{ ...shops.find((x) => x.store_id === big), rec: r.recs[small] }] });
  assert.equal(wrong.body.shops[0].cart.discounts.bundle, 0);
  await call('DELETE', `/api/mall-cart/${wrong.body.token}`);
  // Bad bodies: the same shop twice, too many parts, an empty list, a hidden shop or another mall's shop.
  for (const bad of [[shops[0], shops[0]], [], [null], 'x', Array.from({ length: 11 }, (_, i) => ({ ...shops[0], store_id: i + 1 }))]) {
    assert.equal((await call('POST', '/api/mall-cart/items', { mall_id: mall, shops: bad })).status, 400);
  }
  assert.equal((await call('POST', '/api/mall-cart/items', { mall_id: mall, shops: [{ ...shops[0], store_id: 99999999999 }] })).status, 404);
  for (const s of [sHidden, sOther]) {
    const p = await db('products').where({ store_id: s }).first('id');
    assert.equal((await call('POST', '/api/mall-cart/items', { mall_id: mall, shops: [{ store_id: s, items: [{ product_id: p.id, size: 'L' }] }] })).status, 404);
  }
  await db('stores').whereIn('id', [s1, s2]).update({ bundle_percent: 0 });
});

test('swap and the cheaper alternative stay inside the mall\'s stock', async () => {
  const r = (await look()).body;
  const mallItems = new Set((await db('products').whereIn('store_id', [s1, s2]).pluck('id')));
  for (const o of r.outfits) if (o.alternative) assert.ok(o.alternative.items.every((p) => mallItems.has(p.id) && [s1, s2].includes(p.store_id)));
  const o = r.outfits[0];
  const p = o.items.find((x) => x.category === 'top');
  const others = [...new Set(r.outfits.slice(1).flatMap((x) => [...x.items, ...(x.alternative?.items ?? [])].map((i) => i.id)))];
  const before = await db('recommendation_logs').where({ mall_rec_id: (await db('mall_recs').where({ token: r.rec }).first()).id }).select('store_id', 'outfits');
  const sw = await call('POST', '/api/recommend/mall/swap', { mall_id: mall, ...BODY, rec: r.rec, items: o.items.map((i) => i.id), replace: p.id, exclude: others, relaxed: r.relaxed });
  assert.equal(sw.status, 200, JSON.stringify(sw.body));
  assert.ok(sw.body.options.length);
  for (const opt of sw.body.options) {
    const x = opt.items.find((i) => i.id === opt.swap);
    assert.ok(mallItems.has(x.id) && x.category === 'top' && x.size === 'L' && !others.includes(x.id));
    assert.ok(sw.body.shops.some((s) => s.id === x.store_id));
    assert.ok(await db('product_stock').where({ product_id: x.id, size: 'L' }).whereRaw('quantity - reserved > 0').first());
  }
  // The options' parts (2+ items) join each shop's shown sets, so their bundles can count.
  const after = await db('recommendation_logs').whereIn('store_id', before.map((b) => b.store_id)).whereNotNull('mall_rec_id').where({ mall_rec_id: (await db('mall_recs').where({ token: r.rec }).first()).id }).select('store_id', 'outfits');
  assert.ok(after.some((a) => json(a.outfits).length > json(before.find((b) => b.store_id === a.store_id).outfits).length));
  // An item of the hidden shop is not an outfit of this mall: stale (409); bad bodies 400.
  const hid = await db('products').where({ store_id: sHidden, category: 'top' }).first('id');
  assert.equal((await call('POST', '/api/recommend/mall/swap', { mall_id: mall, ...BODY, items: [hid.id, ...o.items.slice(1).map((i) => i.id)], replace: hid.id })).status, 409);
  assert.equal((await call('POST', '/api/recommend/mall/swap', { mall_id: mall, ...BODY, items: [1], replace: 2 })).status, 400);
});

test('the Claude stylist: the shop per candidate, a capped list, ids outside it dropped, the per-shop cap kept', async () => {
  // Pure: three outfits all from one shop, but the rules kept a cap of 6 → only the first one survives.
  let id = 1;
  const cand = ['outerwear', 'top', 'bottom', 'shoes'].flatMap((c) => [1, 2, 3].map(() => ({ id: id++, store_id: 7, category: c, unit_price: 1000, temp_min: -30, temp_max: 40, waterproof: false })));
  const same = [0, 1, 2].map((k) => ({ title: 'x', reason: 'y', product_ids: cand.filter((_, i) => i % 3 === k).map((p) => p.id) }));
  assert.equal(applyStylist({ outfits: same }, cand, { temperature: 5, raining: false, cap: 6 }).outfits.length, 1);
  assert.equal(applyStylist({ outfits: same }, cand, { temperature: 5, raining: false }).outfits.length, 3, 'no cap: all three');

  const calls = [];
  let answer = null;
  const fake = { messages: { create: async (params) => (calls.push(params), { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'submit_outfits', input: answer(params) }] }) } };
  const app = createApp(db, { telegram: null, weather: async () => COLD, stylist: createStylist({ client: fake }), stylistTimeoutMs: 1000, limits: { recommend: 0 } }).listen(0);
  await new Promise((r) => app.once('listening', r));
  const to = `http://127.0.0.1:${app.address().port}`;
  try {
    const hidden = await db('products').where({ store_id: sHidden, category: 'top' }).first('id');
    answer = (params) => {
      const c = JSON.parse(params.messages[0].content.at(-1).text.split('\n').at(-1)).CANDIDATES;
      const top = c.find((p) => p.category === 'top' && p.shop === 'Smart Fit Samarqand') ?? c.find((p) => p.category === 'top');
      return { outfits: [{ title: 'Markaz', reason: 'Issiq.', product_ids: [hidden.id, 999999, top.product_id] }] };
    };
    const r = await look({}, to);
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'ai');
    const c = JSON.parse(calls[0].messages[0].content.at(-1).text.split('\n').at(-1)).CANDIDATES;
    const names = new Map((await db('stores').whereIn('id', [s1, s2]).select('id', 'name')).map((s) => [s.name, s.id]));
    assert.ok(c.every((p) => names.has(p.shop)), 'every candidate names its shop, only this mall\'s shown shops');
    for (const cat of ['outerwear', 'top', 'bottom', 'shoes', 'accessory']) assert.ok(c.filter((p) => p.category === cat).length <= STYLIST_MAX);
    assert.ok(c.length <= 5 * STYLIST_MAX);
    const got = items(r.body).map((p) => p.id);
    assert.ok(!got.includes(hidden.id) && !got.includes(999999), 'ids outside the list are dropped');
    assert.ok(got.every((x) => c.some((p) => p.product_id === x)), 'everything comes from the list Claude saw');
    // An answer with nothing valid → the rules, as for one shop.
    answer = () => ({ outfits: [{ title: 'x', reason: 'y', product_ids: [hidden.id] }] });
    assert.equal((await look({}, to)).body.source, 'rules');
  } finally {
    app.close();
  }
});

test('migration 032 down and up', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await m.migrate.down(); // 033
    await m.migrate.down();
    assert.ok(!(await m.schema.hasTable('mall_recs')));
    assert.ok(!('mall_rec_id' in (await m('recommendation_logs').columnInfo())));
    await m.migrate.latest();
    assert.ok(await m.schema.hasTable('mall_recs'));
    assert.ok('mall_rec_id' in (await m('recommendation_logs').columnInfo()));
  } finally {
    await m.destroy();
  }
});
