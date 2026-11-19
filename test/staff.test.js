// Task 28: the staff role and the shop-floor app (/staff/): invitable by an owner, reaches only the staff routes (route
// walk), stays in its own store, moves orders by the admin's own rules, and the fitting queue with response times.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testDb, isPg } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin, createAdminRouter, responseStats, STAFF_ROUTES } from '../src/admin/routes.js';
import { nextStatuses } from '../src/cart/cart.js';
import { stageOf } from '../src/notify/telegram.js';
import { dbTime } from '../src/recommend/routes.js';
import { accountWalk, PUBLIC_ACCOUNT } from './helpers/account.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, a1, a2, b1, ownerA, managerA1, staff1, staff2, staffA2;

const call = async (method, p, body, token) => {
  const res = await fetch(base + p, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
};
const admin = (method, p, body, token) => call(method, `/api/admin${p}`, body, token);
const login = async (email, password) => (await admin('POST', '/login', { email, password })).body.token;
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// A pickup order in `store`, paid at the cashier by its manager unless `paid` is false. → { order, track }
async function order(store, { paid = true, token = managerA1 } = {}) {
  const p = await db('products').where({ store_id: store, category: 'top' }).orderBy('id').first();
  await db('product_stock').where({ product_id: p.id, size: 'M' }).update({ quantity: 50 });
  const cart = await call('POST', '/api/cart/items', { store_id: store, items: [{ product_id: p.id, size: 'M' }] });
  const r = await call('POST', `/api/cart/${cart.body.token}/checkout`, { fulfillment: 'pickup', name: 'Dilnoza', phone: '+998907776655' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (paid) assert.equal((await admin('POST', `/orders/${r.body.order.id}/pay`, { method: 'cash' }, token)).status, 200);
  return { order: r.body.order, track: new URL(r.body.track.url).pathname.split('/').pop() };
}
// created_at as each database writes CURRENT_TIMESTAMP (SQLite: 'YYYY-MM-DD HH:MM:SS' in UTC).
const at = (ms) => (isPg() ? dbTime(ms) : dbTime(ms).slice(0, 19));
const fitting = async (store, agoMs = 0, cabin = 5) => {
  const p = await db('products').where({ store_id: store, category: 'top' }).orderBy('id').first();
  return (await db('fitting_requests').insert({ store_id: store, cabin, items: JSON.stringify([{ product_id: p.id, size: 'M' }]), created_at: at(Date.now() - agoMs) }).returning('id'))[0].id;
};

before(async () => {
  await db.migrate.latest();
  await seed(db); // two organisations, one store each
  [a1, b1] = (await db('stores').orderBy('id')).map((s) => s.id);
  const orgA = (await db('stores').where({ id: a1 }).first()).organization_id;
  [{ id: a2 }] = await db('stores').insert({ name: 'A filial', city: 'Toshkent', address: 'Chilonzor 1', lat: 41.28, lon: 69.2, organization_id: orgA }).returning('id');
  const { id: _, created_at, updated_at, ...p } = await db('products').where({ store_id: a1, category: 'top' }).orderBy('id').first();
  const [{ id: pA2 }] = await db('products').insert({ ...p, store_id: a2, sku: null }).returning('id');
  await db('product_stock').insert({ product_id: pA2, size: 'M', quantity: 5 });
  await createAdmin(db, { email: 'owner.a@smartfit.uz', password: 'owner-pass-1', storeId: a1 });
  await createAdmin(db, { email: 'mgr.a1@smartfit.uz', password: 'mgr-pass-1', storeId: a1, role: 'manager' });
  await createAdmin(db, { email: 'nodira@smartfit.uz', password: 'staff-pass-2', storeId: a1, role: 'staff' });
  await createAdmin(db, { email: 'a2.staff@smartfit.uz', password: 'staff-pass-3', storeId: a2, role: 'staff' });
  server = createApp(db, { telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  ownerA = await login('owner.a@smartfit.uz', 'owner-pass-1');
  managerA1 = await login('mgr.a1@smartfit.uz', 'mgr-pass-1');
  staff2 = await login('nodira@smartfit.uz', 'staff-pass-2');
  staffA2 = await login('a2.staff@smartfit.uz', 'staff-pass-3');
});
after(async () => {
  server.close();
  await db.destroy();
});

test('an owner invites staff to a store; the invite makes a staff account; managers can\'t invite; the owner manages staff', async () => {
  const inv = await admin('POST', '/team/invites', { email: 'aziz@smartfit.uz', role: 'staff', store_id: a1 }, ownerA);
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const token = new URL(inv.body.url).hash.split('token=')[1];
  assert.equal((await admin('POST', '/invite/check', { token })).body.role, 'staff');
  const joined = await admin('POST', '/invite/accept', { token, password: 'staff-pass-1' });
  assert.equal(joined.status, 201);
  assert.deepEqual([joined.body.admin.role, joined.body.admin.store_id], ['staff', a1]);
  staff1 = joined.body.token;

  assert.equal((await admin('POST', '/team/invites', { email: 'x@smartfit.uz', role: 'staff' }, managerA1)).status, 403, 'a manager does not invite');
  assert.equal((await admin('POST', '/team/invites', { email: 'x@smartfit.uz', role: 'owner', store_id: a1 }, ownerA)).status, 403);
  assert.equal((await admin('POST', '/team/invites', { email: 'x@smartfit.uz', role: 'boss', store_id: a1 }, ownerA)).status, 400);
  // The owner sees, revokes and disables staff like managers.
  const open = await admin('POST', '/team/invites', { email: 'later@smartfit.uz', role: 'staff', store_id: a2 }, ownerA);
  const team = (await admin('GET', '/team', undefined, ownerA)).body;
  assert.ok(team.invites.find((i) => i.id === open.body.id).can_revoke);
  assert.ok(team.members.find((m) => m.email === 'aziz@smartfit.uz').can_manage);
  assert.equal((await admin('DELETE', `/team/invites/${open.body.id}`, undefined, ownerA)).status, 204);
  await createAdmin(db, { email: 'gone.staff@smartfit.uz', password: 'gone-pass-1', storeId: a1, role: 'staff' });
  const gone = await login('gone.staff@smartfit.uz', 'gone-pass-1');
  const id = (await db('admins').where({ email: 'gone.staff@smartfit.uz' }).first()).id;
  assert.equal((await admin('PATCH', `/team/${id}`, { disabled: true }, ownerA)).status, 200);
  assert.equal((await admin('GET', '/staff', undefined, gone)).status, 401, 'a disabled staff member is out at once');
  // The CHECK: staff always belong to a store.
  await assert.rejects(db('admins').insert({ email: 'nostore@smartfit.uz', password_hash: 'x', role: 'staff', organization_id: 1 }));
});

// The route walk: every admin route, called with a staff token. Only the staff routes answer; everything else is 403
// before it runs (nothing written). A new admin route is covered automatically: it is 403 for staff unless listed.
test('route walk: the staff role can call only the staff routes', async () => {
  const { order: o } = await order(a1);
  const f = await fitting(a1, 0, 7);
  const product = await db('products').where({ store_id: a1 }).first();
  const ids = { '/products/:id': product.id, '/orders/:id': o.id, '/fitting/:id': f, '/stores/:id': a1, '/team/:id': 1, '/team/invites/:id': 1, '/sync-keys/:id': 1, '/promos/:id': 1, '/demo-requests/:id': 1 };
  // Task 47: a receiving of a1 for the stock routes (staff open, scan, look and close; confirming is a manager's).
  const uid = () => `walk-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const recv = (await admin('POST', '/stock/sessions', { key: uid(), kind: 'receive' }, managerA1)).body;
  // Task 52: a transfer sent from a2 to a1 (rows written directly: the walk is about the gate) for staff to receive.
  const size = (await db('product_stock').where({ product_id: product.id }).first()).size;
  const pA2 = await db('products').where({ store_id: a2 }).first();
  const [{ id: tr }] = await db('transfers').insert({ organization_id: (await db('stores').where({ id: a1 }).first()).organization_id, from_store_id: a2, to_store_id: a1, status: 'sent' }).returning('id');
  await db('transfer_items').insert({ transfer_id: tr, product_id: pA2.id, to_product_id: product.id, size, quantity: 2 });
  ids['/transfers/:id'] = tr;
  const fill = (path) => path.replace('/stock/sessions/:id', `/stock/sessions/${recv.id}`).replace(/^(\/[a-z-]+(?:\/invites)?)\/:id/, (m, head) => `${head}/${ids[`${head}/:id`]}`);
  const PUBLIC = ['POST /login', 'POST /invite/check', 'POST /invite/accept', ...PUBLIC_ACCOUNT]; // before the auth middleware, no token used
  const ALLOWED = {
    'GET /stock/catalog': async () => assert.equal((await admin('GET', '/stock/catalog', undefined, staff1)).body.store_id, a1),
    'GET /stock/sessions': async () => assert.ok((await admin('GET', '/stock/sessions', undefined, staff1)).body.open.some((s) => s.id === recv.id)),
    'GET /stock/sessions/:id': async () => assert.equal((await admin('GET', `/stock/sessions/${recv.id}`, undefined, staff1)).body.kind, 'receive'),
    'POST /stock/sessions': async () => assert.equal((await admin('POST', '/stock/sessions', { key: uid(), kind: 'count', shelf: 'A-1' }, staff1)).status, 201),
    'POST /stock/scans': async () => assert.equal((await admin('POST', '/stock/scans', { key: uid(), session: recv.key, product_id: product.id, size: (await db('product_stock').where({ product_id: product.id }).first()).size, quantity: 1 }, staff1)).status, 201),
    'POST /stock/sessions/:id/close': async () => assert.equal((await admin('POST', `/stock/sessions/${recv.id}/close`, {}, staff1)).body.status, 'closed'),
    'GET /transfers/:id': async () => assert.deepEqual((await admin('GET', `/transfers/${tr}`, undefined, staff1)).body.can, { edit: false, send: false, cancel: false, receive: true }),
    'POST /transfers/scans': async () => assert.equal((await admin('POST', '/transfers/scans', { key: uid(), transfer_id: tr, product_id: product.id, size, quantity: 1 }, staff1)).status, 201),
    'POST /transfers/:id/receive': async () => assert.equal((await admin('POST', `/transfers/${tr}/receive`, {}, staff1)).body.status, 'received'),
    'GET /me': async () => assert.equal((await admin('GET', '/me', undefined, staff1)).body.role, 'staff'),
    'GET /me/sales': async () => assert.equal((await admin('GET', '/me/sales', undefined, staff1)).status, 200), // task 50: their own numbers
    'GET /staff': async () => assert.equal((await admin('GET', '/staff', undefined, staff1)).status, 200),
    'POST /orders/:id/pay': async () => { // task 51: staff take payments at the till
      const { order: u } = await order(a1, { paid: false });
      const r = await admin('POST', `/orders/${u.id}/pay`, { method: 'card' }, staff1);
      assert.deepEqual([r.status, r.body.payment_status, r.body.paid_with, 'phone' in r.body], [200, 'paid', 'card', false]);
    },
    'POST /fitting/:id/accept': async () => assert.equal((await admin('POST', `/fitting/${f}/accept`, {}, staff1)).status, 204),
    'POST /fitting/:id/done': async () => assert.equal((await admin('POST', `/fitting/${f}/done`, {}, staff1)).status, 204),
    'POST /orders/:id/status': async () => {
      assert.equal((await admin('POST', `/orders/${o.id}/status`, { status: 'cancelled' }, staff1)).status, 403, 'staff never cancel (refunds)');
      const r = await admin('POST', `/orders/${o.id}/status`, { status: 'packing' }, staff1);
      assert.deepEqual(r.body, { id: o.id, status: 'packing' }, 'no phone, address or totals back');
    },
    'POST /me/password': async () => {
      const r = await admin('POST', '/me/password', { current: 'staff-pass-2', password: 'staff-pass-2b' }, staff2);
      assert.equal(r.status, 200);
      staff2 = r.body.token;
    },
    ...accountWalk(admin, () => staff2, (t) => { staff2 = t; }, () => 'staff-pass-2b'), // task 54
  };
  const routes = createAdminRouter(db).stack.filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).filter((m) => m !== '_all' && m !== 'head').map((m) => [m.toUpperCase(), l.route.path]));
  const names = routes.map(([m, p]) => `${m} ${p}`);
  for (const r of Object.keys(ALLOWED)) assert.ok(names.includes(r), `${r} exists`);
  // The gate's patterns allow exactly these routes, no more.
  assert.deepEqual(routes.filter(([m, p]) => STAFF_ROUTES.some((re) => re.test(`${m} ${fill(p)}`))).map(([m, p]) => `${m} ${p}`).sort(), Object.keys(ALLOWED).sort());

  const auditBefore = (await db('audit_log').max({ id: 'id' }))[0].id;
  const snapshot = async () => JSON.stringify([await db('products').where({ id: product.id }).first(), await db('stores').where({ id: a1 }).first(), await db('orders').where({ id: o.id }).first('status', 'payment_status')]);
  const was = await snapshot();
  let refused = 0;
  for (const [m, p] of routes) {
    const name = `${m} ${p}`;
    if (PUBLIC.includes(name) || ALLOWED[name]) continue;
    const r = await admin(m, fill(p), m === 'GET' ? undefined : { name: 'X', price: 1, status: 'cancelled', disabled: true, email: 'x@smartfit.uz', role: 'staff', code: 'STAFF1', kind: 'percent', value: 50, handled: true }, staff1);
    assert.equal(r.status, 403, `${name} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    assert.equal(r.body.code, 'forbidden');
    refused++;
  }
  assert.ok(refused > 35, `walked ${refused} refused routes`);
  assert.equal(await snapshot(), was, 'nothing changed');
  assert.equal((await db('audit_log').max({ id: 'id' }))[0].id, auditBefore, 'no audit row: nothing ran');
  assert.equal((await admin('GET', '/nope', undefined, staff1)).status, 403, 'unknown paths too');
  for (const [name, check] of Object.entries(ALLOWED)) await check().catch((err) => { err.message = `${name}: ${err.message}`; throw err; });
});

test('store isolation: staff see and change only their own store, also inside the same organisation', async () => {
  const fA2 = await fitting(a2, 0, 9);
  const { order: oA2 } = await order(a2, { token: ownerA });
  const fB = await fitting(b1, 0, 11);
  const mine = (await admin('GET', '/staff', undefined, staff1)).body;
  assert.deepEqual(mine.stores.map((s) => s.id), [a1]);
  for (const list of [mine.fitting, mine.orders, mine.low.items]) assert.ok(list.every((x) => x.store_id === a1), JSON.stringify(list[0]));
  assert.ok(mine.low.items.length > 0, 'the seeded store has low sizes to show');
  for (const [p, id] of [['fitting', fA2], ['fitting', fB]]) {
    assert.equal((await admin('POST', `/${p}/${id}/accept`, {}, staff1)).status, 404);
    assert.equal((await admin('POST', `/${p}/${id}/done`, {}, staff1)).status, 404);
  }
  assert.equal((await admin('POST', `/orders/${oA2.id}/status`, { status: 'packing' }, staff1)).status, 404);
  assert.equal((await db('orders').where({ id: oA2.id }).first()).status, 'new');
  assert.equal((await db('fitting_requests').where({ id: fA2 }).first()).accepted_at, null);
  // a2's own staff do see it; kiosks too are per store.
  await db('kiosks').insert([{ store_id: a1, device: 'a'.repeat(16), last_seen_at: new Date(Date.now() - 10 * 60e3).toISOString() },
    { store_id: a2, device: 'b'.repeat(16), last_seen_at: new Date(Date.now() - 10 * 60e3).toISOString() },
    { store_id: a1, device: 'c'.repeat(16), last_seen_at: new Date().toISOString() },
    { store_id: a1, device: 'd'.repeat(16), last_seen_at: new Date(Date.now() - 2 * 86400e3).toISOString() }]); // retired: no alert after a day
  const other = (await admin('GET', '/staff', undefined, staffA2)).body;
  assert.ok(other.fitting.some((f) => f.id === fA2) && other.orders.some((o) => o.id === oA2.id));
  assert.deepEqual(other.kiosks.map((k) => k.id), ['bbbbbb']);
  assert.deepEqual((await admin('GET', '/staff', undefined, staff1)).body.kiosks.map((k) => k.id), ['aaaaaa'], 'only the offline kiosk of a1');
});

test('order steps: the same rules as admin, forward only, and they drive the customer status page and messages', async () => {
  const { order: o, track } = await order(a1);
  const { order: unpaid } = await order(a1, { paid: false });
  let q = (await admin('GET', '/staff', undefined, staff1)).body;
  assert.ok(!q.orders.some((x) => x.id === unpaid.id), 'unpaid orders wait at the cashier, not on the floor');
  for (const x of q.orders) {
    const row = await db('orders').where({ id: x.id }).first();
    assert.deepEqual(x.next, nextStatuses(row).filter((s) => s !== 'cancelled'), `№ ${x.number}`);
    assert.deepEqual(Object.keys(x).filter((k) => ['phone', 'address', 'lat', 'lon', 'total'].includes(k)), [], 'no contact details or sums');
  }
  const card = q.orders.find((x) => x.id === o.id);
  assert.deepEqual(card.next, ['packing']);
  assert.ok(card.items.length === 1 && 'shelf_location' in card.items[0], 'pick list with the shelf');
  // A step the rules don't allow is the admin's 409; unpaid is the admin's pay-first 409.
  const skip = await admin('POST', `/orders/${o.id}/status`, { status: 'delivered' }, staff1);
  assert.deepEqual([skip.status, skip.body.code], [409, 'status_conflict']);
  assert.deepEqual([(await admin('POST', `/orders/${unpaid.id}/status`, { status: 'packing' }, staff1)).body.code], ['pay_first']);
  assert.equal((await admin('POST', `/orders/${o.id}/status`, { status: 'packing' }, staff1)).status, 200);
  const page = await call('GET', `/api/orders/${track}`);
  assert.equal(page.body.status, 'packing', 'the customer status page shows "being collected"');
  assert.equal(stageOf(await db('orders').where({ id: o.id }).first()), 'packing', 'the notifier sends the packing message');
  q = (await admin('GET', '/staff', undefined, staff1)).body;
  assert.deepEqual(q.orders.find((x) => x.id === o.id).next, ['delivered']);
  assert.equal((await admin('POST', `/orders/${o.id}/status`, { status: 'delivered' }, staff1)).status, 200);
  assert.equal((await call('GET', `/api/orders/${track}`)).body.status, 'delivered');
  assert.ok(!(await admin('GET', '/staff', undefined, staff1)).body.orders.some((x) => x.id === o.id), 'handed over: off the list');
  const log = await db('audit_log').where({ action: 'order.status', entity_id: o.id }).orderBy('id');
  assert.deepEqual(log.map((l) => l.admin_email), ['aziz@smartfit.uz', 'aziz@smartfit.uz'], 'who moved it');
  // Delivery: packing → shipping → delivered, the same as admin.
  const { order: d } = await order(a1);
  await db('orders').where({ id: d.id }).update({ fulfillment: 'delivery' });
  for (const s of ['packing', 'shipping', 'delivered']) {
    const before = (await admin('GET', '/staff', undefined, staff1)).body.orders.find((x) => x.id === d.id);
    assert.deepEqual(before.next, [s]);
    assert.equal((await admin('POST', `/orders/${d.id}/status`, { status: s }, staff1)).status, 200, s);
  }
});

test('fitting: accept → brought, one taker per request, who and how fast', async () => {
  const f = await fitting(a1, 90_000, 4);
  assert.equal((await admin('POST', `/fitting/${f}/accept`, {}, staff1)).status, 204);
  const taken = await admin('POST', `/fitting/${f}/accept`, {}, staff2);
  assert.deepEqual([taken.status, taken.body.code], [409, 'fitting_taken']);
  assert.equal((await admin('POST', `/fitting/${f}/accept`, {}, staff1)).status, 204, 'the same person again is a no-op');
  assert.equal((await db('audit_log').where({ action: 'fitting.accept', entity_id: f })).length, 1);
  const view = async (tok) => (await admin('GET', '/staff', undefined, tok)).body.fitting.find((x) => x.id === f);
  assert.deepEqual([(await view(staff1)).mine, (await view(staff2)).mine, (await view(staff2)).accepted_email], [true, false, 'aziz@smartfit.uz']);
  assert.ok((await view(staff1)).items[0].name, 'what to bring');
  assert.ok((await admin('GET', '/fitting', undefined, managerA1)).body.some((x) => x.id === f && x.accepted_email === 'aziz@smartfit.uz'), 'admin sees who took it');
  // Anyone in the store may close it (someone else brought it, or a manager).
  assert.equal((await admin('POST', `/fitting/${f}/done`, {}, staff2)).status, 204);
  assert.equal((await admin('POST', `/fitting/${f}/accept`, {}, staff1)).status, 409, 'done is done');
  const row = await db('fitting_requests').where({ id: f }).first();
  assert.equal(row.done_by, (await db('admins').where({ email: 'nodira@smartfit.uz' }).first()).id);
  const { stats } = (await admin('GET', '/staff', undefined, staff1)).body;
  const r = stats.recent.find((x) => x.cabin === 4);
  assert.ok(r.accept_s >= 85 && r.accept_s < 120 && r.done_s >= r.accept_s, JSON.stringify(r));
  assert.equal(r.email, 'aziz@smartfit.uz', 'counted for whoever took it');
  assert.ok(stats.by.some((p) => p.email === 'aziz@smartfit.uz' && p.n >= 1));
  assert.ok(stats.total >= stats.done && stats.done >= 1);
});

test('response time stats: counts, averages, per person, newest first', () => {
  const t0 = Date.parse('2026-11-10T05:00:00Z');
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const s = responseStats([
    { cabin: 1, created_at: at(0), accepted_at: at(30), done_at: at(120), email: 'a@x.uz' },
    { cabin: 2, created_at: at(100), accepted_at: at(160), done_at: at(400), email: 'b@x.uz' },
    { cabin: 3, created_at: at(200), accepted_at: null, done_at: at(260), email: 'a@x.uz' }, // closed without accepting
    { cabin: 4, created_at: at(300), accepted_at: at(390), done_at: null, email: 'b@x.uz' }, // on the way
    { cabin: 5, created_at: '2026-11-10 05:10:00', accepted_at: null, done_at: null, email: null }, // SQLite text, waiting
  ]);
  assert.deepEqual([s.total, s.done, s.accept_s, s.done_s], [5, 3, 60, 160]);
  assert.deepEqual(s.by, [{ email: 'a@x.uz', n: 2, done_s: 90 }, { email: 'b@x.uz', n: 1, done_s: 300 }]);
  assert.deepEqual(s.recent.map((r) => r.cabin), [2, 3, 1]);
  assert.deepEqual(responseStats([]), { total: 0, done: 0, accept_s: null, done_s: null, by: [], recent: [] });
});

test('the staff app: served under /staff/, installable, its service worker never caches the API; admin sends staff there', async () => {
  assert.equal((await call('GET', '/staff')).status, 301, '/staff → /staff/ so the worker scope covers the page');
  const page = await fetch(`${base}/staff/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const m = await call('GET', '/staff/manifest.webmanifest');
  assert.match(m.headers.get('content-type'), /application\/manifest\+json/);
  assert.deepEqual([m.body.start_url, m.body.scope, m.body.display], ['/staff/', '/staff/', 'standalone']);
  for (const i of m.body.icons) assert.equal((await fetch(base + i.src)).status, 200, i.src);
  const sw = read('public/staff/sw.js');
  const shell = JSON.parse(sw.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  for (const p of shell) {
    assert.doesNotMatch(p, /^\/(api|uploads)\b/, p);
    assert.equal((await fetch(base + p, { method: 'HEAD' })).status, 200, p);
  }
  assert.doesNotMatch(sw.replace(/^\s*\/\/.*$/gm, ''), /\/api\/|\/uploads/, 'only the shell list is ever cached');
  assert.match(read('public/staff/staff.js'), /serviceWorker\?\.register\('\/staff\/sw\.js', \{ scope: '\/staff\/' \}\)/);
  assert.match(read('public/admin/admin.js'), /me\.role === 'staff' && !location\.hash\.startsWith\('#\/settings'\)\) return location\.replace\('\/staff\/'\)/); // task 54: but their account page
});
