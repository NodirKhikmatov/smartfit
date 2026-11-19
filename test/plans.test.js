// Task 45: plans, the 14-day trial, grace and the read-only state, feature switches, super's plan list, the owner's
// "Tarif" view, the first-run checklist and the demo request → organisation step.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin, createAdminRouter, READONLY_ROUTES, dayKey } from '../src/admin/routes.js';
import { planState, addDays, PLANS, closedOrgs } from '../src/plans.js';
import { pointsConfig } from '../src/cart/points.js';
import { DICT } from '../public/shared/i18n.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, tashkent, samarkand, orgA, orgB, superToken, ownerA, clock = null, stylistCalls = 0;

const call = async (method, p, body, token, { raw, type, lang } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': type || 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...(lang && { 'accept-language': lang }) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
};
const admin = (method, p, body, token, opts) => call(method, `/api/admin${p}`, body, token, opts);
const login = async (email, password) => (await admin('POST', '/login', { email, password })).body.token;
const tokenOf = (url) => new URL(url).hash.split('token=')[1];
const today = () => dayKey(Date.now());
const STORE = { name: 'Moda Yunusobod', city: 'Toshkent', address: 'Amir Temur 1', lat: 41.33, lon: 69.28 };
const TOP = { name: 'Futbolka', category: 'top', gender: 'male', color: 'oq', price: 90000, temp_min: 0, temp_max: 30, stock: { M: 3 } };
const setPlan = (orgId, row) => db('organizations').where({ id: orgId }).update(row);
const fakeTryon = { name: 'FASHN', tryOn: async () => Buffer.from('x') };

// A brand-new shop: super makes the organisation (14-day Pro trial), the owner accepts and adds a store.
async function newShop(name, email) {
  const org = (await admin('POST', '/orgs', { name, owner_email: email }, superToken)).body;
  const acc = await admin('POST', '/invite/accept', { token: tokenOf(org.invite.url), password: 'shop-pass-1' });
  const token = acc.body.token;
  const store = (await admin('POST', '/stores', STORE, token)).body;
  return { orgId: org.id, token, storeId: store.id };
}

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [tashkent, samarkand] = (await db('stores').orderBy('id')).map((s) => s.id);
  [orgA, orgB] = (await db('stores').orderBy('id')).map((s) => s.organization_id);
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  await createAdmin(db, { email: 'owner.a@smartfit.uz', password: 'owner-pass-1', storeId: tashkent });
  const stylist = async () => { stylistCalls++; throw new Error('stub'); };
  server = createApp(db, { telegram: null, stylist, tryon: fakeTryon, now: () => clock ?? Date.now(),
    weather: async () => ({ temperature: 15, apparent_temperature: 15, raining: false, wind_speed: 1, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  superToken = await login('boss@smartfit.uz', 'boss-pass-1');
  ownerA = await login('owner.a@smartfit.uz', 'owner-pass-1');
});
after(async () => {
  server.close();
  await db.destroy();
});

test('dates: trial → grace → read-only → paid again, at the Tashkent day edges', () => {
  const at = (iso) => Date.parse(iso);
  const org = { plan: 'pro', trial_until: '2026-12-01', paid_until: null };
  assert.equal(planState(org, at('2026-12-01T23:59:59.999+05:00')).state, 'trial', 'the last trial day counts whole');
  assert.equal(planState(org, at('2026-12-01T19:30:00Z')).state, 'grace', '00:30 Tashkent is the next day already');
  assert.equal(planState(org, at('2026-12-02T00:00:00+05:00')).state, 'grace');
  assert.equal(planState(org, at('2026-12-08T23:59:59+05:00')).state, 'grace', 'seven days of grace');
  const ro = planState(org, at('2026-12-09T00:00:00+05:00'));
  assert.equal(ro.state, 'readonly');
  assert.deepEqual([ro.ends, ro.grace_until, ro.readonly_from], ['2026-12-01', '2026-12-08', '2026-12-09']);
  const paid = { ...org, paid_until: '2027-01-31' };
  assert.equal(planState(paid, at('2026-12-20T12:00:00+05:00')).state, 'paid', 'paid again');
  assert.equal(planState(paid, at('2026-11-20T12:00:00+05:00')).state, 'paid', 'paid during the trial wins');
  assert.equal(planState({ ...org, paid_until: '2026-11-25' }, at('2026-11-28T12:00:00+05:00')).state, 'trial', 'the later date counts');
  assert.equal(planState({ plan: 'start' }, at('2099-01-01T00:00:00Z')).state, 'active', 'no end date never locks');
  assert.equal(planState({ plan: 'nonsense' }).plan, 'biznes', 'an unknown plan never limits');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
});

test('migration: every existing organisation (the demo ones too) gets a plan with no end; down and up keep the data', async () => {
  const m = testDb();
  try {
    for (let i = 0; i < 34; i++) await m.migrate.up(); // up to 034_mall_map
    const [{ id }] = await m('organizations').insert({ name: 'Pilot brend' }).returning('id');
    await m.migrate.up();
    const g = await m('organizations').where({ id }).first();
    assert.deepEqual([g.plan, g.trial_until, g.paid_until], ['biznes', null, null]);
    assert.equal(planState(g).state, 'active');
    await m.migrate.down();
    assert.ok(!('plan' in (await m('organizations').where({ id }).first())));
    await m.migrate.latest();
    assert.equal((await m('organizations').where({ id }).first()).plan, 'biznes');
  } finally {
    await m.destroy();
  }
  for (const o of await db('organizations').whereIn('id', [orgA, orgB])) assert.equal(planState(o).state, 'active', 'the seeded demo never locks');
});

test('a new organisation starts a 14-day Pro trial; /me and the "Tarif" view say so; only super changes a plan', async () => {
  const shop = await newShop('Trial brend', 'trial.owner@smartfit.uz');
  const g = await db('organizations').where({ id: shop.orgId }).first();
  assert.deepEqual([g.plan, g.trial_until, g.paid_until], ['pro', addDays(today(), 13), null]);
  const me = (await admin('GET', '/me', undefined, shop.token)).body;
  assert.equal(me.plan.state, 'trial');
  assert.deepEqual(me.plan.features, PLANS.pro.features);
  assert.equal((await admin('GET', '/me', undefined, superToken)).body.plan, undefined, 'super has no plan');
  const plan = (await admin('GET', '/plan', undefined, shop.token)).body;
  assert.equal(plan.plan, 'pro');
  assert.deepEqual(plan.limits.stores, { used: 1, max: 3 });
  assert.deepEqual(plan.limits.team, { used: 1, max: 15 });
  assert.equal(plan.features.points, true);
  // Only super; the owner, a manager and the mall's admin are refused.
  await createAdmin(db, { email: 'trial.mgr@smartfit.uz', password: 'mgr-pass-1', storeId: shop.storeId, role: 'manager' });
  const mgr = await login('trial.mgr@smartfit.uz', 'mgr-pass-1');
  for (const tok of [shop.token, mgr]) assert.equal((await admin('PATCH', `/orgs/${shop.orgId}/plan`, { plan: 'biznes', paid_until: '2030-01-01', note: 'Men o\'zim' }, tok)).status, 403);
  assert.equal((await admin('GET', '/plan', undefined, mgr)).status, 403);
  for (const bad of [{ plan: 'gold', note: 'abc' }, { plan: 'pro', paid_until: '2026-02-30', note: 'abc' }, { plan: 'pro', paid_until: '31.12.2026', note: 'abc' }, { plan: 'pro', note: 'ab' }, { plan: 'pro' }]) {
    assert.equal((await admin('PATCH', `/orgs/${shop.orgId}/plan`, bad, superToken)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await admin('PATCH', '/orgs/99999999/plan', { plan: 'pro', note: 'abc' }, superToken)).status, 404);
  const r = await admin('PATCH', `/orgs/${shop.orgId}/plan`, { plan: 'start', paid_until: '2030-06-30', note: 'Hisob-faktura 12' }, superToken);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.plan, r.body.state, r.body.paid_until], ['start', 'paid', '2030-06-30']);
  const row = await db('audit_log').where({ action: 'org.plan', entity_id: shop.orgId }).orderBy('id', 'desc').first();
  const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  assert.deepEqual(json(row.before), { plan: 'pro', paid_until: null });
  assert.deepEqual(json(row.after), { plan: 'start', paid_until: '2030-06-30', note: 'Hisob-faktura 12' });
  const list = (await admin('GET', '/orgs', undefined, superToken)).body.find((o) => o.id === shop.orgId);
  assert.deepEqual([list.plan, list.state, list.ends, list.note], ['start', 'paid', '2030-06-30', 'Hisob-faktura 12']);
});

test('each limit at its edge (Start: 1 store, 300 products, 2 kiosks, 3 in the team); over the limit only adding is refused', async () => {
  const shop = await newShop('Limit brend', 'limit.owner@smartfit.uz');
  await setPlan(shop.orgId, { plan: 'start', paid_until: '2030-12-31' });
  const lim = (r, what) => {
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'plan_limit');
    assert.ok(r.body.error.includes('Start') && r.body.error.includes(DICT.uz[`adm.plan.l_${what}`]), `names the plan and the limit: ${r.body.error}`);
  };
  // Stores: the first is there, a second is refused; super (the team) is never limited.
  lim(await admin('POST', '/stores', { ...STORE, name: 'Ikkinchi' }, shop.token), 'stores');
  const ru = await admin('POST', '/stores', { ...STORE, name: 'Ikkinchi' }, shop.token, { lang: 'ru' });
  assert.match(ru.body.error, /Старт/);
  assert.equal((await admin('POST', '/stores', { ...STORE, name: 'Super qo\'shdi', organization_id: shop.orgId }, superToken)).status, 201);
  // Products: 299 there → the 300th goes in, the 301st is refused; a CSV that would pass the limit adds nothing.
  const cat = await db('categories').where({ organization_id: shop.orgId, role: 'top' }).first('id');
  await db.batchInsert('products', Array.from({ length: 299 }, (_, i) => ({ store_id: shop.storeId, name: `P${i}`, category: 'top', category_id: cat.id, gender: 'male', color: 'oq', price: 1000, temp_min: 0, temp_max: 30 })), 100);
  assert.equal((await admin('POST', '/products', TOP, shop.token)).status, 201, 'the 300th');
  lim(await admin('POST', '/products', TOP, shop.token), 'products');
  await db('products').where({ store_id: shop.storeId, name: 'P0' }).del();
  const csv = 'name;category;gender;color;price;temp_min;temp_max\nA;top;male;oq;1000;0;30\nB;top;male;oq;1000;0;30\n';
  const imp = await admin('POST', '/products/import', undefined, shop.token, { raw: csv, type: 'text/csv' });
  assert.equal(imp.status, 400);
  assert.deepEqual(imp.body.errors.map((e) => [e.line, e.code]), [[3, 'plan_limit']]);
  assert.equal(Number((await db('products').where({ store_id: shop.storeId }).count({ n: '*' }))[0].n), 299, 'all or nothing');
  const p = await db('products').where({ store_id: shop.storeId }).first('id');
  assert.equal((await admin('PATCH', `/products/${p.id}`, { price: 2000 }, shop.token)).status, 200, 'editing is not adding');
  // Team: owner + 2 invites = 3; a fourth is refused, a fresh link for someone already invited is not; revoking frees a slot.
  const inv1 = await admin('POST', '/team/invites', { email: 'l1@smartfit.uz' }, shop.token);
  assert.equal((await admin('POST', '/team/invites', { email: 'l2@smartfit.uz' }, shop.token)).status, 201);
  lim(await admin('POST', '/team/invites', { email: 'l3@smartfit.uz' }, shop.token), 'team');
  assert.equal((await admin('POST', '/team/invites', { email: 'l1@smartfit.uz' }, shop.token)).status, 201, 'a new link for l1');
  const open = await db('admin_invites').where({ email: 'l1@smartfit.uz' }).whereNull('used_at').first('id');
  assert.ok(inv1.status === 201 && open);
  assert.equal((await admin('DELETE', `/team/invites/${open.id}`, undefined, shop.token)).status, 204);
  await createAdmin(db, { email: 'l4@smartfit.uz', password: 'mgr-pass-1', storeId: shop.storeId, role: 'manager' });
  const l4 = await db('admins').where({ email: 'l4@smartfit.uz' }).first('id');
  assert.equal((await admin('PATCH', `/team/${l4.id}`, { disabled: true }, shop.token)).status, 200);
  assert.equal((await admin('POST', '/team/invites', { email: 'l5@smartfit.uz' }, shop.token)).status, 201, 'the disabled one frees a slot');
  lim(await admin('PATCH', `/team/${l4.id}`, { disabled: false }, shop.token), 'team');
  // Kiosks: two devices register, a third is refused; the two keep pinging.
  const ping = (device) => call('POST', '/api/kiosk/ping', { store_id: shop.storeId, device });
  assert.equal((await ping('a'.repeat(16))).status, 204);
  assert.equal((await ping('b'.repeat(16))).status, 204);
  lim(await ping('c'.repeat(16)), 'kiosks');
  assert.equal((await ping('a'.repeat(16))).status, 204);
  // A downgrade below what exists keeps everything working; the "Tarif" view shows it.
  const plan = (await admin('GET', '/plan', undefined, shop.token)).body;
  assert.deepEqual(plan.limits.stores, { used: 2, max: 1 });
  assert.deepEqual(plan.limits.kiosks, { used: 2, max: 2 });
  assert.equal((await admin('PATCH', `/stores/${shop.storeId}`, { city: 'Toshkent sh.' }, shop.token)).status, 200);
});

test('trial → grace → read-only → paid again, on the server clock (writes work through grace, stop at read-only, come back)', async () => {
  const shop = await newShop('Muddat brend', 'clock.owner@smartfit.uz');
  await setPlan(shop.orgId, { trial_until: '2026-12-01' });
  const add = () => admin('POST', '/products', TOP, shop.token);
  try {
    clock = Date.parse('2026-12-01T23:59:59+05:00');
    assert.equal((await add()).status, 201, 'last trial day');
    clock = Date.parse('2026-12-02T00:00:00+05:00');
    assert.equal((await admin('GET', '/me', undefined, shop.token)).body.plan.state, 'grace');
    assert.equal((await add()).status, 201, 'grace still works');
    clock = Date.parse('2026-12-08T23:59:59+05:00');
    assert.equal((await add()).status, 201, 'last grace day');
    clock = Date.parse('2026-12-09T00:00:00+05:00');
    const ro = await add();
    assert.deepEqual([ro.status, ro.body.code], [403, 'plan_readonly']);
    assert.equal((await admin('GET', '/products', undefined, shop.token)).body.total, 3, 'reads everything, nothing deleted');
    assert.equal((await admin('PATCH', `/orgs/${shop.orgId}/plan`, { plan: 'pro', paid_until: '2027-01-31', note: 'To\'landi' }, superToken)).status, 200, 'super is never locked');
    assert.equal((await admin('GET', '/me', undefined, shop.token)).body.plan.state, 'paid');
    assert.equal((await add()).status, 201, 'paid again');
  } finally {
    clock = null;
  }
});

test('read-only: every admin write is refused in one place, except finishing orders already placed; exports still work', async () => {
  const shop = await newShop('Yopiq brend', 'ro.owner@smartfit.uz');
  const product = (await admin('POST', '/products', { ...TOP, stock: { M: 5 } }, shop.token)).body;
  const order = async () => {
    const cart = await call('POST', '/api/cart/items', { store_id: shop.storeId, items: [{ product_id: product.id, size: 'M' }] });
    return (await call('POST', `/api/cart/${cart.body.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '+998901234567' })).body.order;
  };
  const [o1, o2] = [await order(), await order()];
  const early = await call('POST', '/api/cart/items', { store_id: shop.storeId, items: [{ product_id: product.id, size: 'M' }] });
  const s2 = (await admin('POST', '/stores', { ...STORE, name: 'Ikkinchi filial' }, shop.token)).body; // for an "other store" reservation
  const p2 = (await admin('POST', '/products', { ...TOP, store_id: s2.id }, shop.token)).body;
  await createAdmin(db, { email: 'ro.staff@smartfit.uz', password: 'staff-pass-1', storeId: shop.storeId, role: 'staff' });
  const staff = await login('ro.staff@smartfit.uz', 'staff-pass-1');
  await setPlan(shop.orgId, { trial_until: addDays(today(), -8) }); // grace ended yesterday
  assert.equal((await admin('GET', '/me', undefined, shop.token)).body.plan.state, 'readonly');

  // The walk: every non-GET admin route with the read-only owner's token is 403 plan_readonly before it runs.
  const routes = createAdminRouter(db).stack.filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).filter((m) => !['_all', 'get', 'head'].includes(m)).map((m) => [m.toUpperCase(), l.route.path]));
  const PUBLIC = ['POST /login', 'POST /invite/check', 'POST /invite/accept'];
  const ALLOWED = ['POST /cash/close', 'POST /me/password', 'POST /orders/:id/status', 'POST /orders/:id/pay', 'POST /orders/:id/returns', 'POST /fitting/:id/accept', 'POST /fitting/:id/done'];
  assert.deepEqual(routes.map(([m, p]) => `${m} ${p}`).filter((r) => READONLY_ROUTES.some((re) => re.test(r.replace(/:id/g, '1')))).sort(), [...ALLOWED].sort(), 'the allow-list is exactly these');
  const snapshot = async () => JSON.stringify([await db('products').where({ store_id: shop.storeId }).select('id', 'price', 'updated_at'), await db('stores').where({ id: shop.storeId }).first(),
    await db('admin_invites').where({ organization_id: shop.orgId }).count({ n: '*' }), await db('organizations').where({ id: shop.orgId }).first()]);
  const was = await snapshot();
  const auditBefore = (await db('audit_log').max({ id: 'id' }))[0].id;
  let refused = 0;
  for (const [m, p] of routes) {
    const name = `${m} ${p}`;
    if (PUBLIC.includes(name) || ALLOWED.includes(name)) continue;
    const r = await admin(m, p.replace(/:id/g, String(product.id)), { name: 'X', price: 1, email: 'x@smartfit.uz', handled: true, disabled: true, plan: 'biznes', note: 'abc', store_id: shop.storeId }, shop.token);
    assert.deepEqual([r.status, r.body?.code], [403, 'plan_readonly'], `${name} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    refused++;
  }
  assert.ok(refused > 45, `walked ${refused} routes`);
  assert.equal(await snapshot(), was, 'nothing changed');
  assert.equal((await db('audit_log').max({ id: 'id' }))[0].id, auditBefore, 'no audit row: nothing ran');
  const ru = await admin('POST', '/products', TOP, shop.token, { lang: 'ru' });
  assert.match(ru.body.error, /только для чтения/);

  // Reads, exports and the "Tarif" view work.
  for (const p of ['/products', '/orders', '/plan', '/points', '/team', '/audit']) assert.equal((await admin('GET', p, undefined, shop.token)).status, 200, p);
  const ordersCsv = await admin('GET', '/orders/export', undefined, shop.token);
  assert.ok(ordersCsv.status === 200 && ordersCsv.body.includes('Aziz'));
  const productsCsv = await admin('GET', '/products/export', undefined, shop.token);
  assert.ok(productsCsv.status === 200 && productsCsv.body.includes('Futbolka'));
  assert.equal((await admin('GET', '/points/export', undefined, shop.token)).status, 200);
  // Orders already placed are finished: paid, handed over, returned; a staff member moves them too.
  assert.equal((await admin('POST', `/orders/${o1.id}/pay`, { method: 'cash' }, shop.token)).status, 200);
  assert.equal((await admin('POST', `/orders/${o1.id}/status`, { status: 'packing' }, shop.token)).status, 200);
  assert.equal((await admin('POST', `/orders/${o1.id}/status`, { status: 'delivered' }, shop.token)).status, 200);
  const line = (await admin('GET', `/orders/${o1.id}`, undefined, shop.token)).body.items[0];
  assert.equal((await admin('POST', `/orders/${o1.id}/returns`, { key: 'f'.repeat(32), item_id: line.id, kind: 'return', reason: 'too_small', quantity: 1, restock: true }, shop.token)).status, 201);
  assert.equal((await admin('POST', `/orders/${o2.id}/pay`, { method: 'cash' }, shop.token)).status, 200);
  assert.equal((await admin('POST', `/orders/${o2.id}/status`, { status: 'packing' }, staff)).status, 200);
  const pw = await admin('POST', '/me/password', { current: 'shop-pass-1', password: 'shop-pass-2' }, shop.token);
  assert.equal(pw.status, 200, 'its own password');
  shop.token = pw.body.token;

  // The customer side: the kiosk and the phone say "vaqtincha ishlamayapti" and take no orders.
  const info = await call('GET', `/api/stores/${shop.storeId}`);
  assert.deepEqual(info.body, { id: shop.storeId, name: STORE.name, city: STORE.city, paused: true });
  const paused = (r) => assert.deepEqual([r.status, r.body.code], [403, 'shop_paused'], JSON.stringify(r.body));
  paused(await call('POST', '/api/cart/items', { store_id: shop.storeId, items: [{ product_id: product.id, size: 'M' }] }));
  paused(await call('POST', `/api/cart/${early.body.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '+998901234567' }));
  paused(await call('POST', '/api/catalog/reserve', { from_store_id: shop.storeId, product_id: p2.id, size: 'M', name: 'Aziz', phone: '+998901234567' }));
  assert.equal((await call('POST', '/api/kiosk/ping', { store_id: shop.storeId, device: 'd'.repeat(16) })).body.code, 'plan_readonly');
  // The POS stock push is a write too.
  const key = (await (async () => {
    await setPlan(shop.orgId, { trial_until: null }); // a moment of no end, to make a key
    const k = (await admin('POST', '/sync-keys', { name: 'Kassa', store_id: shop.storeId }, shop.token)).body;
    await setPlan(shop.orgId, { trial_until: addDays(today(), -8) });
    return k;
  })()).key;
  const sync = await call('POST', '/api/sync/stock', undefined, undefined, { raw: JSON.stringify({ items: [{ sku: 'X', size: 'M', quantity: 1 }] }), type: 'application/json' });
  assert.equal(sync.status, 401, 'no key');
  const res = await fetch(`${base}/api/sync/stock`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ items: [{ sku: 'X', size: 'M', quantity: 1 }] }) });
  assert.deepEqual([res.status, (await res.json()).code], [403, 'plan_readonly']);
  assert.ok((await closedOrgs(db)).includes(shop.orgId));
});

test('a paused shop leaves the mall: directory, search and outfits; it comes back when paid', async () => {
  const mallId = (await db('stores').where({ id: samarkand }).first('mall_id')).mall_id;
  const shown = async () => (await call('GET', `/api/malls/${mallId}`)).body.shops.map((s) => s.id);
  assert.ok((await shown()).includes(samarkand));
  await setPlan(orgB, { trial_until: addDays(today(), -8) });
  try {
    assert.ok(!(await shown()).includes(samarkand));
    assert.ok((await shown()).includes(tashkent), 'the other shop stays');
    const search = (await call('GET', `/api/malls/${mallId}/search?q=a`)).body;
    const s2 = (await call('GET', `/api/malls/${mallId}/search?q=ko`)).body.items;
    assert.ok([...search.items, ...s2].every((i) => i.store_id !== samarkand));
    const outfit = await call('POST', '/api/recommend/mall', { mall_id: mallId, gender: 'male', sizes: { top: 'L', bottom: 'L', shoes: '42' } });
    assert.equal(outfit.status, 200);
    assert.ok(outfit.body.outfits.flatMap((o) => o.items).every((i) => i.store_id !== samarkand));
  } finally {
    await setPlan(orgB, { trial_until: null });
  }
  assert.ok((await shown()).includes(samarkand));
});

test('feature switches: a plan without a feature hides it and blocks it on the server; its data stays and comes back', async () => {
  const shop = await newShop('Start brend', 'start.owner@smartfit.uz');
  const product = (await admin('POST', '/products', { ...TOP, stock: { M: 9 } }, shop.token)).body;
  await db('stores').where({ id: shop.storeId }).update({ instalment_on: true, instalment_terms: JSON.stringify([{ months: 3, percent: 0 }]), tryon_on: true });
  await db('organizations').where({ id: shop.orgId }).update({ cashback_percent: 5, points_max_share: 50 });
  const [{ id: profileId }] = await db('customer_profiles').insert({ organization_id: shop.orgId, telegram_user_id: 777001, phone: '+998901234567', name: 'Aziz', consent_at: new Date().toISOString() }).returning('id');
  await db('points_ledger').insert({ organization_id: shop.orgId, profile_id: profileId, kind: 'adjust', amount: 7000, ref: 'test:gift' });
  const [{ id: offerId }] = await db('offers').insert({ organization_id: shop.orgId, store_id: shop.storeId, title: 'Chegirma', title_ru: 'Скидка', status: 'approved',
    starts_at: new Date(Date.now() - 86400000).toISOString(), ends_at: new Date(Date.now() + 86400000).toISOString() }).returning('id');
  const look = async () => {
    const info = (await call('GET', `/api/stores/${shop.storeId}`)).body;
    const item = (await call('GET', `/api/catalog/${shop.storeId}/items/${product.id}`)).body;
    const cart = await call('POST', '/api/cart/items', { store_id: shop.storeId, items: [{ product_id: product.id, size: 'M' }] });
    await call('DELETE', `/api/cart/${cart.body.token}`);
    stylistCalls = 0;
    await call('POST', '/api/recommend', { store_id: shop.storeId, gender: 'male', sizes: { top: 'M', bottom: 'M', shoes: '42' }, want: ['top'] }); // single items: the stylist re-orders them
    return { tryon: info.tryon ?? null, offers: info.offers.map((o) => o.id), itemInst: Boolean(item.item.instalments), cartInst: Boolean(cart.body.totals?.pickup?.instalments), stylist: stylistCalls };
  };
  const on = await look();
  assert.deepEqual(on, { tryon: 'FASHN', offers: [offerId], itemInst: true, cartInst: true, stylist: 1 }, 'Pro (trial) has all five');
  assert.ok(await pointsConfig(db, shop.storeId));

  // Start keeps instalments; for this test it has none at all, so every switch is seen off.
  const saved = PLANS.start.features;
  PLANS.start.features = [];
  await setPlan(shop.orgId, { plan: 'start' });
  try {
    assert.deepEqual(await look(), { tryon: null, offers: [], itemInst: false, cartInst: false, stylist: 0 });
    assert.equal(await pointsConfig(db, shop.storeId), null, 'no earning or spending');
    const feature = (r, key) => {
      assert.deepEqual([r.status, r.body.code], [403, 'plan_feature'], JSON.stringify(r.body));
      assert.ok(r.body.error.includes(DICT.uz[`adm.plan.f_${key}`]) && r.body.error.includes('Start'), r.body.error);
    };
    feature(await admin('POST', '/offers', { store_id: shop.storeId, title: 'X', title_ru: 'X', starts_on: today(), ends_on: today() }, shop.token), 'offers');
    feature(await admin('GET', '/offers', undefined, shop.token), 'offers');
    feature(await admin('POST', '/points/adjust', { store_id: shop.storeId, profile_id: profileId, amount: 100, reason: 'Sovg\'a' }, shop.token), 'points');
    feature(await admin('PATCH', '/points', { store_id: shop.storeId, cashback_percent: 3 }, shop.token), 'points');
    assert.equal((await admin('GET', `/points?store_id=${shop.storeId}`, undefined, shop.token)).status, 200, 'the list stays readable');
    assert.equal((await admin('GET', `/points/export?store_id=${shop.storeId}`, undefined, shop.token)).status, 200);
    assert.equal((await db('offers').where({ id: offerId }).first()).status, 'approved', 'the offer is kept');
    const tr = await call('POST', '/api/tryon', { store_id: shop.storeId, product_id: product.id, photo: 'data:image/jpeg;base64,/9j/AAAA', consent: true });
    assert.equal(tr.body.code, 'tryon_off');
    // An order placed on this plan earns nothing on hand-over, and takes nothing.
    const cart = await call('POST', '/api/cart/items', { store_id: shop.storeId, items: [{ product_id: product.id, size: 'M' }] });
    const o = (await call('POST', `/api/cart/${cart.body.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '+998901234567' })).body.order;
    await admin('POST', `/orders/${o.id}/pay`, { method: 'cash' }, shop.token);
    await admin('POST', `/orders/${o.id}/status`, { status: 'packing' }, shop.token);
    assert.equal((await admin('POST', `/orders/${o.id}/status`, { status: 'delivered' }, shop.token)).status, 200);
    assert.equal(Number((await db('points_ledger').where({ profile_id: profileId }).sum({ n: 'amount' }))[0].n), 7000, 'no cashback, nothing taken');
  } finally {
    PLANS.start.features = saved;
  }
  await setPlan(shop.orgId, { plan: 'pro' });
  assert.deepEqual(await look(), on, 'back with the plan');
  assert.equal(Number((await db('points_ledger').where({ profile_id: profileId }).sum({ n: 'amount' }))[0].n), 7000, 'the same balance, nothing expired or lost');
});

test('the first-run checklist ticks itself from real data, per organisation, and goes when done or hidden', async () => {
  const org = (await admin('POST', '/orgs', { name: 'Checklist brend', owner_email: 'check.owner@smartfit.uz' }, superToken)).body;
  const token = (await admin('POST', '/invite/accept', { token: tokenOf(org.invite.url), password: 'shop-pass-1' })).body.token;
  const ticks = async () => Object.fromEntries((await admin('GET', '/checklist', undefined, token)).body.items.map((i) => [i.key, i.done]));
  assert.deepEqual(await ticks(), { store: false, categories: false, products: false, kiosk_pin: false, qr: false, team: false });
  const store = (await admin('POST', '/stores', STORE, token)).body;
  assert.equal((await ticks()).store, false, 'no hours yet');
  await admin('PATCH', `/stores/${store.id}`, { opens_at: '10:00', closes_at: '21:00' }, token);
  assert.equal((await ticks()).store, true);
  await admin('POST', '/categories', { name: 'Ro\'mollar', name_ru: 'Платки', size_kind: 'one' }, token);
  assert.deepEqual([(await ticks()).categories, (await ticks()).products], [true, false]);
  await admin('POST', '/products', TOP, token);
  assert.equal((await ticks()).products, true);
  await admin('PATCH', `/stores/${store.id}`, { kiosk_pin: '4321' }, token);
  assert.equal((await ticks()).kiosk_pin, true);
  await call('POST', '/api/kiosk/ping', { store_id: store.id, device: 'e'.repeat(16) });
  assert.equal((await ticks()).qr, true);
  const inv = (await admin('POST', '/team/invites', { email: 'check.mgr@smartfit.uz' }, token)).body;
  assert.equal((await ticks()).team, false, 'an invite is not a colleague yet');
  await admin('POST', '/invite/accept', { token: tokenOf(inv.url), password: 'mgr-pass-12' });
  const done = (await admin('GET', '/checklist', undefined, token)).body;
  assert.deepEqual([done.done, done.dismissed], [true, false]);
  // Another organisation's checklist is its own; hiding it is per organisation and audited.
  assert.equal((await admin('GET', '/checklist', undefined, ownerA)).body.dismissed, false);
  assert.equal((await admin('POST', '/checklist/dismiss', undefined, ownerA)).status, 204);
  assert.equal((await admin('GET', '/checklist', undefined, ownerA)).body.dismissed, true);
  assert.equal((await admin('GET', '/checklist', undefined, token)).body.dismissed, false);
  assert.ok(await db('audit_log').where({ action: 'org.checklist', entity_id: orgA }).first());
  assert.equal((await admin('GET', '/checklist', undefined, superToken)).status, 403, 'the owner\'s');
});

test('demo request → organisation + owner invite in one step for super; the public form never creates a tenant', async () => {
  const count = async () => Number((await db('organizations').count({ n: '*' }))[0].n);
  const before = await count();
  const d = await call('POST', '/api/demo-requests', { name: 'Dilnoza', phone: '+998901234500', company: 'Lola Moda', city: 'Namangan' });
  assert.equal(d.status, 201);
  assert.equal(await count(), before, 'the form alone makes nothing');
  assert.equal((await admin('POST', `/demo-requests/${d.body.id}/org`, { owner_email: 'lola@smartfit.uz' }, ownerA)).status, 403);
  assert.equal((await admin('POST', `/demo-requests/${d.body.id}/org`, { owner_email: 'not-an-email' }, superToken)).status, 400);
  assert.equal((await admin('POST', '/demo-requests/99999999/org', { owner_email: 'lola@smartfit.uz' }, superToken)).status, 404);
  const r = await admin('POST', `/demo-requests/${d.body.id}/org`, { owner_email: 'lola@smartfit.uz' }, superToken);
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Lola Moda', 'named after the request');
  assert.match(r.body.invite.url, /#\/invite\?token=[0-9a-f]{32}$/);
  assert.equal(await count(), before + 1);
  const g = await db('organizations').where({ id: r.body.id }).first();
  assert.deepEqual([g.plan, g.trial_until], ['pro', addDays(today(), 13)]);
  assert.ok((await db('demo_requests').where({ id: d.body.id }).first()).handled_at, 'marked handled');
  assert.equal(Number((await db('categories').where({ organization_id: r.body.id }).count({ n: '*' }))[0].n), 5, 'built-in categories');
  const check = await admin('POST', '/invite/check', { token: tokenOf(r.body.invite.url) });
  assert.deepEqual([check.body.role, check.body.org_name], ['owner', 'Lola Moda']);
});

test('products CSV: the export re-imports as is (same ids, no change)', async () => {
  const csv = (await admin('GET', `/products/export?store_id=${tashkent}`, undefined, ownerA)).body;
  const lines = csv.trim().split('\r\n');
  assert.match(lines[0], /^"id";"store_id";"sku";"barcode";"name";"name_ru";"category"/);
  const n = Number((await db('products').where({ store_id: tashkent }).count({ n: '*' }))[0].n);
  assert.equal(lines.length - 1, n);
  const cols = ['id', 'price', 'name', 'name_ru', 'category_id', 'temp_min', 'temp_max', 'audience', 'gender', 'sku'];
  const before = await db('products').where({ store_id: tashkent }).orderBy('id').select(cols);
  const stock = await db('product_stock').whereIn('product_id', before.map((p) => p.id)).orderBy('id').select('product_id', 'size', 'quantity');
  const r = await admin('POST', '/products/import', undefined, ownerA, { raw: csv, type: 'text/csv' });
  assert.deepEqual([r.status, r.body.created, r.body.updated], [200, 0, n], JSON.stringify(r.body).slice(0, 300));
  assert.deepEqual(await db('products').where({ store_id: tashkent }).orderBy('id').select(cols), before);
  assert.deepEqual(await db('product_stock').whereIn('product_id', before.map((p) => p.id)).orderBy('id').select('product_id', 'size', 'quantity'), stock);
});
