// Task 52: transfers between an organisation's stores. Stock and movements at each state (draft, sent, received,
// cancelled); reserved units can't be sent; a cancel before and after sending; receiving less than was sent (recorded,
// written off); a replayed receiving scan applies once (also in parallel); the cost moves with the units; only inside
// one organisation, a manager of neither store is refused; the back-in-stock alert; "Ko'chirish" on the Talab page;
// the product's history; the staff app's incoming list; migration 042.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { testDb, json } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed, sizesOf } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { flushStockAlerts } from '../src/notify/telegram.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, a1, a2, a3, b1, orgA, ownerA, managerA1, managerA2, managerA3, staffA1, staffA2, ownerB, superToken, mallToken;

const call = async (method, p, body, token) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const admin = (method, p, body, token) => call(method, `/api/admin${p}`, body, token);
const login = async (email, password) => (await admin('POST', '/login', { email, password })).body.token;
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const stock = async (productId, size) => db('product_stock').where({ product_id: productId, size }).first('quantity', 'reserved');
const qty = async (productId, size) => (await stock(productId, size))?.quantity ?? 0;
const setStock = async (productId, size, quantity, reserved = 0) => {
  if (!(await db('product_stock').where({ product_id: productId, size }).update({ quantity, reserved }))) await db('product_stock').insert({ product_id: productId, size, quantity, reserved });
};
const moves = (productId) => db('stock_movements').where({ product_id: productId }).orderBy('id');
// The n-th top of store a1 and its copy (same SKU) in another store of organisation A.
const pair = async (n, to = a2) => {
  const p = await db('products').where({ store_id: a1, category: 'top' }).orderBy('id').offset(n).first();
  const q = await db('products').where({ store_id: to, sku: p.sku }).first();
  return [p, q];
};
const draft = async (token, lines, from = a1, to = a2, note) => {
  const r = await admin('POST', '/transfers', { from_store_id: from, to_store_id: to, note, lines }, token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const scan = (token, t, product, size, quantity, key = randomUUID()) => admin('POST', '/transfers/scans', { key, transfer_id: t.id, product_id: product.id, size, quantity }, token);

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [a1, b1] = (await db('stores').orderBy('id')).map((s) => s.id);
  orgA = (await db('stores').where({ id: a1 }).first()).organization_id;
  // Two more stores of organisation A carrying copies (same SKU) of a1's first six tops; a3 is "neither store".
  for (const name of ['A Chilonzor', 'A Yunusobod']) {
    const [{ id }] = await db('stores').insert({ name, city: 'Toshkent', address: name, lat: 41.28, lon: 69.2, organization_id: orgA }).returning('id');
    for (const { id: _, created_at, updated_at, ...p } of await db('products').where({ store_id: a1, category: 'top' }).orderBy('id').limit(6)) {
      const [{ id: pid }] = await db('products').insert({ ...p, store_id: id, barcode: null, cost: null }).returning('id');
      await db('product_stock').insert(['S', 'M', 'L'].map((size) => ({ product_id: pid, size, quantity: 0 })));
    }
    if (name === 'A Chilonzor') a2 = id; else a3 = id;
  }
  const mall = (await db('malls').first())?.id;
  await createAdmin(db, { email: 'owner.a@smartfit.uz', password: 'owner-pass-1', storeId: a1 });
  await createAdmin(db, { email: 'mgr.a1@smartfit.uz', password: 'mgr-pass-1', storeId: a1, role: 'manager' });
  await createAdmin(db, { email: 'mgr.a2@smartfit.uz', password: 'mgr-pass-2', storeId: a2, role: 'manager' });
  await createAdmin(db, { email: 'mgr.a3@smartfit.uz', password: 'mgr-pass-3', storeId: a3, role: 'manager' });
  await createAdmin(db, { email: 'staff.a1@smartfit.uz', password: 'staff-pass-1', storeId: a1, role: 'staff' });
  await createAdmin(db, { email: 'staff.a2@smartfit.uz', password: 'staff-pass-2', storeId: a2, role: 'staff' });
  await createAdmin(db, { email: 'owner.b@smartfit.uz', password: 'owner-pass-2', storeId: b1 });
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  if (mall) await createAdmin(db, { email: 'mall@smartfit.uz', password: 'mall-pass-1', mallId: mall });
  server = createApp(db, { telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  ownerA = await login('owner.a@smartfit.uz', 'owner-pass-1');
  managerA1 = await login('mgr.a1@smartfit.uz', 'mgr-pass-1');
  managerA2 = await login('mgr.a2@smartfit.uz', 'mgr-pass-2');
  managerA3 = await login('mgr.a3@smartfit.uz', 'mgr-pass-3');
  staffA1 = await login('staff.a1@smartfit.uz', 'staff-pass-1');
  staffA2 = await login('staff.a2@smartfit.uz', 'staff-pass-2');
  ownerB = await login('owner.b@smartfit.uz', 'owner-pass-2');
  superToken = await login('boss@smartfit.uz', 'boss-pass-1');
  if (mall) mallToken = await login('mall@smartfit.uz', 'mall-pass-1');
});
after(async () => {
  server.close();
  await db.destroy();
});

test('draft → sent → received: stock, movements and cost at each step; receiving less than was sent is recorded', async () => {
  const [p, q] = await pair(0);
  await setStock(p.id, 'M', 6);
  await setStock(p.id, 'L', 4);
  await setStock(q.id, 'M', 2);
  await db('products').where({ id: p.id }).update({ cost: 100000 });
  await db('products').where({ id: q.id }).update({ cost: 130000 });

  // The receiving side drafts what it wants: nothing moves yet.
  const t = await draft(managerA2, [{ product_id: p.id, size: 'M', quantity: 3 }, { product_id: p.id, size: 'L', quantity: 2 }], a1, a2, '  Shanba savdosi uchun ');
  assert.deepEqual([t.status, t.note, t.from_store_id, t.to_store_id, t.units, t.lines.length, t.created_email], ['draft', 'Shanba savdosi uchun', a1, a2, 5, 2, 'mgr.a2@smartfit.uz']);
  assert.deepEqual(t.lines.map((l) => [l.product_id, l.to_product_id, l.size, l.quantity, l.received, l.free]), [[p.id, q.id, 'M', 3, 0, 6], [p.id, q.id, 'L', 2, 0, 4]]);
  assert.deepEqual(t.can, { edit: true, send: false, cancel: true, receive: false }, 'the receiving side can\'t send');
  assert.deepEqual([await qty(p.id, 'M'), await qty(q.id, 'M'), (await moves(p.id)).length], [6, 2, 0]);
  assert.equal(t.lines[0].unit_cost, undefined, 'no cost in the answer');

  // Only the sending side sends.
  const no = await admin('POST', `/transfers/${t.id}/send`, undefined, managerA2);
  assert.deepEqual([no.status, no.body.code], [403, 'transfer_sender_only']);
  const sent = await admin('POST', `/transfers/${t.id}/send`, undefined, managerA1);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual([sent.body.status, sent.body.sent_email, sent.body.can.send, sent.body.can.receive], ['sent', 'mgr.a1@smartfit.uz', false, false]);
  assert.deepEqual([await qty(p.id, 'M'), await qty(p.id, 'L'), await qty(q.id, 'M'), await qty(q.id, 'L')], [3, 2, 2, 0], 'out of a1 at once, not yet in a2');
  assert.deepEqual((await moves(p.id)).map((m) => [m.reason, m.size, m.delta, m.quantity_before, m.quantity_after, m.transfer_id, m.admin_email]),
    [['transfer', 'M', -3, 6, 3, t.id, 'mgr.a1@smartfit.uz'], ['transfer', 'L', -2, 4, 2, t.id, 'mgr.a1@smartfit.uz']]);
  assert.deepEqual((await db('transfer_items').where({ transfer_id: t.id })).map((l) => l.unit_cost), [100000, 100000], 'the cost leaves with the units');
  assert.equal((await admin('POST', `/transfers/${t.id}/send`, undefined, managerA1)).body.code, 'transfer_state', 'sent once');
  assert.equal((await admin('PUT', `/transfers/${t.id}`, { lines: [{ product_id: p.id, size: 'M', quantity: 1 }] }, managerA1)).body.code, 'transfer_state', 'a sent transfer is not edited');

  // The receiving store's staff see it in the staff app and scan what arrived.
  const floor = (await admin('GET', '/staff', undefined, staffA2)).body;
  assert.deepEqual(floor.incoming.map((x) => [x.id, x.from_store, x.units]), [[t.id, (await db('stores').where({ id: a1 }).first()).name, 5]]);
  assert.deepEqual((await admin('GET', '/staff', undefined, staffA1)).body.incoming, [], 'the sending store has nothing to receive');
  const seen = (await admin('GET', `/transfers/${t.id}`, undefined, staffA2)).body;
  assert.deepEqual(seen.can, { edit: false, send: false, cancel: false, receive: true });
  assert.equal((await admin('GET', `/transfers/${t.id}`, undefined, staffA1)).body.can.receive, false);
  const wrong = await scan(staffA1, t, q, 'M', 1);
  assert.deepEqual([wrong.status, wrong.body.code], [403, 'transfer_receiver_only'], 'the sending store can\'t receive');

  const key = randomUUID();
  const first = await scan(staffA2, t, q, 'M', 2, key);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual([await qty(q.id, 'M'), (await db('products').where({ id: q.id }).first()).cost], [4, 115000], 'sellable at once; cost (130 000 × 2 + 100 000 × 2) / 4');
  // The phone's queue resends the same scan: applied once. Five parallel copies of a new one: one 201.
  const again = await scan(staffA2, t, q, 'M', 2, key);
  assert.deepEqual([again.status, again.body.replay, await qty(q.id, 'M')], [200, true, 4]);
  const k2 = randomUUID();
  const copies = await Promise.all(Array.from({ length: 5 }, () => scan(staffA2, t, q, 'M', 1, k2)));
  assert.deepEqual(copies.map((r) => r.status).sort(), [200, 200, 200, 200, 201]);
  assert.equal(await qty(q.id, 'M'), 5);
  // Never more than was sent on a line; an item not in the transfer; a bad quantity.
  const over = await scan(staffA2, t, q, 'L', 3);
  assert.deepEqual([over.status, over.body.code], [409, 'transfer_too_many']);
  assert.match(over.body.error, /2/);
  assert.equal((await scan(staffA2, t, q, 'S', 1)).body.code, 'transfer_not_in');
  assert.equal((await scan(staffA2, t, p, 'M', 1)).body.code, 'transfer_not_in', 'the sending store\'s product id is not this store\'s');
  assert.equal((await scan(staffA2, t, q, 'L', 0)).status, 400);
  assert.equal((await scan(staffA2, t, q, 'L', 1)).status, 201);
  assert.deepEqual([await qty(q.id, 'L'), (await db('transfer_scans').where({ transfer_id: t.id })).length], [1, 3]);
  // Something was received: it can't be cancelled any more, only finished.
  assert.equal((await admin('POST', `/transfers/${t.id}/cancel`, undefined, managerA1)).body.code, 'transfer_partly_received');

  // Finished with M 3/3 and L 1/2: the missing unit is recorded, a1 doesn't get it back, a2 has what arrived.
  const done = await admin('POST', `/transfers/${t.id}/receive`, undefined, staffA2);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.status, done.body.received_email, done.body.units, done.body.received, done.body.missing], ['received', 'staff.a2@smartfit.uz', 5, 4, 1]);
  assert.deepEqual(done.body.lines.map((l) => [l.size, l.quantity, l.received]), [['M', 3, 3], ['L', 2, 1]]);
  assert.deepEqual([await qty(p.id, 'M'), await qty(p.id, 'L'), await qty(q.id, 'M'), await qty(q.id, 'L')], [3, 2, 5, 1]);
  assert.deepEqual((await moves(q.id)).map((m) => [m.reason, m.size, m.delta, m.transfer_id]), [['transfer', 'M', 2, t.id], ['transfer', 'M', 1, t.id], ['transfer', 'L', 1, t.id]]);
  const log = await db('audit_log').where({ action: 'transfer.receive', entity_id: t.id }).first();
  assert.equal(log.store_id, a2);
  assert.deepEqual([json(log.before), json(log.after)], [{ status: 'sent', [`${p.name} L`]: 2 }, { status: 'received', [`${p.name} L`]: 1 }]);
  assert.equal((await scan(staffA2, t, q, 'L', 1)).body.code, 'transfer_state', 'nothing more after receiving');
  assert.equal((await admin('POST', `/transfers/${t.id}/receive`, undefined, staffA2)).body.code, 'transfer_state');
  assert.equal((await admin('POST', `/transfers/${t.id}/cancel`, undefined, ownerA)).body.code, 'transfer_state');
  for (const action of ['transfer.create', 'transfer.send', 'transfer.scan']) assert.ok(await db('audit_log').where({ action, entity_id: t.id }).first(), action);
});

test('reserved units can\'t be sent; a send is all or nothing', async () => {
  const [p] = await pair(1);
  await setStock(p.id, 'M', 5);
  await setStock(p.id, 'S', 3, 2); // two held in a cart: one free
  const t = await draft(managerA1, [{ product_id: p.id, size: 'M', quantity: 2 }, { product_id: p.id, size: 'S', quantity: 2 }]);
  assert.deepEqual(t.lines.map((l) => l.free), [5, 1]);
  const r = await admin('POST', `/transfers/${t.id}/send`, undefined, managerA1);
  assert.deepEqual([r.status, r.body.code], [409, 'transfer_short']);
  assert.match(r.body.error, /1/);
  assert.equal((await db('transfers').where({ id: t.id }).first()).status, 'draft');
  assert.deepEqual([await stock(p.id, 'M'), await stock(p.id, 'S'), (await moves(p.id)).length], [{ quantity: 5, reserved: 0 }, { quantity: 3, reserved: 2 }, 0], 'nothing moved');
  // Fix the draft to what is free, then it goes; the held units stay.
  const fixed = await admin('PUT', `/transfers/${t.id}`, { note: 'faqat bo\'shi', lines: [{ product_id: p.id, size: 'M', quantity: 2 }, { product_id: p.id, size: 'S', quantity: 1 }] }, managerA1);
  assert.deepEqual([fixed.status, fixed.body.units, fixed.body.note], [200, 3, 'faqat bo\'shi']);
  assert.equal((await admin('POST', `/transfers/${t.id}/send`, undefined, ownerA)).status, 200, 'the owner sends too');
  assert.deepEqual(await stock(p.id, 'S'), { quantity: 2, reserved: 2 });
});

test('cancel: a draft moves nothing; a sent one brings the units (and their cost) back; only before anything is received', async () => {
  const [p, q] = await pair(2);
  await db('product_stock').where({ product_id: p.id }).update({ quantity: 0, reserved: 0 });
  await setStock(p.id, 'M', 4);
  await db('products').where({ id: p.id }).update({ cost: 80000 });
  const d = await draft(managerA1, [{ product_id: p.id, size: 'M', quantity: 2 }]);
  const c = await admin('POST', `/transfers/${d.id}/cancel`, undefined, managerA2);
  assert.deepEqual([c.status, c.body.status, c.body.cancelled_email], [200, 'cancelled', 'mgr.a2@smartfit.uz'], 'either side may drop a draft');
  assert.deepEqual([await qty(p.id, 'M'), (await moves(p.id)).length], [4, 0]);
  assert.equal((await admin('POST', `/transfers/${d.id}/send`, undefined, managerA1)).body.code, 'transfer_state');

  const t = await draft(managerA1, [{ product_id: p.id, size: 'M', quantity: 3 }]);
  await admin('POST', `/transfers/${t.id}/send`, undefined, managerA1);
  assert.equal(await qty(p.id, 'M'), 1);
  // Meanwhile a1's cost changed (a delivery at 110 000): the 3 units come back at the 80 000 they left with.
  await db('products').where({ id: p.id }).update({ cost: 110000 });
  const back = await admin('POST', `/transfers/${t.id}/cancel`, undefined, managerA1);
  assert.deepEqual([back.status, back.body.status, back.body.can.receive], [200, 'cancelled', false]);
  assert.deepEqual([await qty(p.id, 'M'), await qty(q.id, 'M')], [4, 0]);
  assert.equal((await db('products').where({ id: p.id }).first()).cost, 87500, '(110 000 × 1 + 80 000 × 3) / 4');
  assert.deepEqual((await moves(p.id)).map((m) => [m.delta, m.quantity_after, m.transfer_id]), [[-3, 1, t.id], [3, 4, t.id]]);
  assert.equal((await scan(staffA2, t, q, 'M', 1)).body.code, 'transfer_state', 'a cancelled transfer is not received');
  assert.equal((await admin('POST', `/transfers/${t.id}/cancel`, undefined, managerA1)).body.code, 'transfer_state');
  assert.equal((await admin('POST', `/transfers/${t.id}/cancel`, undefined, staffA1)).status, 403, 'staff don\'t cancel');
});

test('only inside one organisation: another organisation, a manager of neither store, staff, the mall admin', async () => {
  const [p, q] = await pair(3);
  await setStock(p.id, 'M', 5);
  const bProduct = await db('products').where({ store_id: b1 }).first();
  // Drafting: two stores of one organisation, one of them the caller's; the receiving store must carry the SKU and size.
  assert.equal((await admin('POST', '/transfers', { from_store_id: a1, to_store_id: b1, lines: [{ product_id: p.id, size: 'M', quantity: 1 }] }, ownerA)).status, 404, 'into another organisation');
  assert.equal((await admin('POST', '/transfers', { from_store_id: b1, to_store_id: a1, lines: [{ product_id: bProduct.id, size: 'M', quantity: 1 }] }, ownerA)).status, 404, 'out of another organisation');
  assert.equal((await admin('POST', '/transfers', { from_store_id: a1, to_store_id: a2, lines: [{ product_id: p.id, size: 'M', quantity: 1 }] }, ownerB)).status, 404);
  assert.equal((await admin('POST', '/transfers', { from_store_id: a1, to_store_id: a2, lines: [{ product_id: p.id, size: 'M', quantity: 1 }] }, managerA3)).status, 404, 'a manager of neither store');
  assert.equal((await admin('POST', '/transfers', { from_store_id: a1, to_store_id: a1, lines: [{ product_id: p.id, size: 'M', quantity: 1 }] }, ownerA)).body.code, 'transfer_same_store');
  assert.equal((await admin('POST', '/transfers', { from_store_id: a1, to_store_id: a2, lines: [{ product_id: bProduct.id, size: 'M', quantity: 1 }] }, ownerA)).body.code, 'stock_not_here');
  const lonely = await db('products').where({ store_id: a1, category: 'bottom' }).first(); // a2 carries tops only
  assert.equal((await admin('POST', '/transfers', { from_store_id: a1, to_store_id: a2, lines: [{ product_id: lonely.id, size: sizesOf(lonely)[0], quantity: 1 }] }, ownerA)).body.code, 'transfer_no_product');
  await db('products').where({ id: q.id }).update({ sizes: 'S,M,L' });
  assert.equal((await admin('POST', '/transfers', { from_store_id: a1, to_store_id: a2, lines: [{ product_id: p.id, size: 'XXL', quantity: 1 }] }, ownerA)).body.code, 'transfer_no_product', 'a size the receiving store lacks');
  for (const lines of [[], [{ product_id: p.id, size: 'M', quantity: 1001 }], [{ product_id: p.id, size: 'M', quantity: 1 }, { product_id: p.id, size: 'M', quantity: 2 }], 'x']) {
    assert.equal((await admin('POST', '/transfers', { from_store_id: a1, to_store_id: a2, lines }, ownerA)).status, 400, JSON.stringify(lines));
  }
  assert.equal((await admin('POST', '/transfers', { from_store_id: a1, to_store_id: a2, lines: [{ product_id: p.id, size: 'M', quantity: 1 }] }, staffA2)).status, 403, 'staff don\'t draft');

  const t = await draft(ownerA, [{ product_id: p.id, size: 'M', quantity: 2 }]);
  for (const tok of [managerA3, ownerB]) {
    assert.equal((await admin('GET', `/transfers/${t.id}`, undefined, tok)).status, 404);
    assert.equal((await admin('PUT', `/transfers/${t.id}`, { lines: [{ product_id: p.id, size: 'M', quantity: 1 }] }, tok)).status, 404);
    assert.equal((await admin('POST', `/transfers/${t.id}/send`, undefined, tok)).status, 404);
    assert.equal((await admin('POST', `/transfers/${t.id}/cancel`, undefined, tok)).status, 404);
    assert.ok(!(await admin('GET', '/transfers', undefined, tok)).body.items.some((x) => x.id === t.id));
    assert.equal((await admin('GET', `/transfers/products?from_store_id=${a1}&to_store_id=${a2}`, undefined, tok)).status, 404);
  }
  assert.deepEqual((await admin('GET', '/transfers/stores', undefined, ownerB)).body.map((s) => s.id), [b1], 'org B sees only its own store');
  assert.deepEqual((await admin('GET', '/transfers/stores', undefined, managerA2)).body.map((s) => s.id), [a1, a2, a3], 'a manager picks the other end in the organisation');
  for (const tok of [ownerA, managerA1, managerA2, superToken]) assert.ok((await admin('GET', '/transfers', undefined, tok)).body.items.some((x) => x.id === t.id));
  assert.ok((await admin('GET', `/transfers?store_id=${a2}&status=draft`, undefined, ownerA)).body.items.some((x) => x.id === t.id));
  assert.ok(!(await admin('GET', `/transfers?store_id=${a3}`, undefined, ownerA)).body.items.some((x) => x.id === t.id));
  assert.equal((await admin('GET', '/transfers?status=lost', undefined, ownerA)).status, 400);
  const opts = (await admin('GET', `/transfers/products?from_store_id=${a1}&to_store_id=${a2}`, undefined, managerA2)).body;
  const line = opts.products.find((x) => x.id === p.id);
  assert.deepEqual(line.sizes.find((s) => s.size === 'M'), { size: 'M', free: 5, there: await qty(q.id, 'M') });
  assert.ok(!line.sizes.some((s) => s.size === 'XXL'), 'only sizes both stores carry');
  assert.ok(opts.products.every((x) => !('cost' in x)));
  // Staff: no list, no drafting, no sending; the mall admin: nothing at all.
  for (const [m, path] of [['GET', '/transfers'], ['GET', '/transfers/stores'], ['POST', `/transfers/${t.id}/send`], ['PUT', `/transfers/${t.id}`]]) {
    assert.equal((await admin(m, path, m === 'GET' ? undefined : {}, staffA1)).status, 403, `staff ${m} ${path}`);
  }
  if (mallToken) for (const path of ['/transfers', `/transfers/${t.id}`]) assert.equal((await admin('GET', path, undefined, mallToken)).status, 403);
  // A manager of neither store can't receive a sent one either; a key of another store's scan is not answered.
  await admin('POST', `/transfers/${t.id}/send`, undefined, managerA1);
  assert.equal((await scan(managerA3, t, q, 'M', 1)).status, 404);
  assert.equal((await admin('POST', `/transfers/${t.id}/receive`, undefined, managerA3)).status, 404);
  const key = randomUUID();
  assert.equal((await scan(managerA2, t, q, 'M', 1, key)).status, 201);
  assert.equal((await admin('POST', '/transfers/scans', { key, transfer_id: t.id, product_id: q.id, size: 'M', quantity: 1 }, ownerB)).body.code, 'stock_key_used');
  assert.equal((await admin('GET', `/transfers/${t.id}`, undefined, superToken)).body.received, 1, 'super sees it');
});

test('the back-in-stock alert fires when a received transfer brings a size back, once', async () => {
  const [p, q] = await pair(4);
  await setStock(p.id, 'L', 3);
  await setStock(q.id, 'L', 0);
  const [{ id: profile }] = await db('customer_profiles').insert({ organization_id: orgA, telegram_user_id: 525001, phone: '+998901234552', name: 'Malika', consent_at: new Date().toISOString() }).returning('id');
  await db('stock_alerts').insert({ profile_id: profile, store_id: a2, product_id: q.id, size: 'L', lang: 'uz' });
  const out = [];
  const tg = async (to, text) => void out.push({ to, text });
  const t = await draft(managerA1, [{ product_id: p.id, size: 'L', quantity: 3 }]);
  await admin('POST', `/transfers/${t.id}/send`, undefined, managerA1);
  await flushStockAlerts(db, tg);
  assert.equal(out.length, 0, 'sent is not here yet');
  assert.equal((await scan(staffA2, t, q, 'L', 3)).status, 201);
  await flushStockAlerts(db, tg);
  await flushStockAlerts(db, tg);
  assert.deepEqual(out.map((m) => m.to), [525001]);
  assert.match(out[0].text, /yana sotuvda/);
});

test('Talab offers "Ko\'chirish" from another store of the organisation; the product history shows the transfer', async () => {
  const [p, q] = await pair(5);
  await setStock(p.id, 'S', 4, 1);
  await setStock(q.id, 'S', 0);
  await db('missed_demand').insert({ store_id: a2, product_id: q.id, size: 'S', session: 'f'.repeat(32), source: 'catalog' });
  const row = (await admin('GET', '/demand', undefined, managerA2)).body.items.find((x) => x.product_id === q.id && x.size === 'S');
  assert.deepEqual(row.elsewhere, [{ store_id: a1, store_name: (await db('stores').where({ id: a1 }).first()).name, product_id: p.id, free: 3 }]);
  // Another organisation's store with the same SKU is never offered.
  const bp = await db('products').where({ store_id: b1, sku: p.sku }).first();
  if (bp) await setStock(bp.id, 'S', 9);
  assert.ok((await admin('GET', '/demand', undefined, managerA2)).body.items.find((x) => x.product_id === q.id).elsewhere.every((e) => e.store_id !== b1));

  const t = await draft(managerA2, [{ product_id: row.elsewhere[0].product_id, size: 'S', quantity: 2 }]);
  await admin('POST', `/transfers/${t.id}/send`, undefined, managerA1);
  await scan(staffA2, t, q, 'S', 2);
  const h = (await admin('GET', `/products/${q.id}/movements`, undefined, managerA2)).body.items[0];
  assert.deepEqual([h.reason, h.delta, h.transfer_id, h.transfer_from, h.transfer_to], ['transfer', 2, t.id, (await db('stores').where({ id: a1 }).first()).name, 'A Chilonzor']);
  assert.equal((await admin('GET', `/products/${p.id}/movements`, undefined, managerA1)).body.items[0].delta, -2);
});

test('admin and staff pages ship the transfer screens with no inline code', () => {
  const adminJs = read('public/admin/admin.js'), adminHtml = read('public/admin/index.html'), staffJs = read('public/staff/staff.js'), sw = read('public/staff/sw.js');
  assert.match(adminHtml, /data-page="transfers"/);
  assert.match(adminJs, /\/transfers\/products/);
  assert.match(staffJs, /\/transfers\/scans/);
  assert.match(sw, /const CACHE = 'sf-staff-v4'/);
  for (const html of [adminHtml, read('public/staff/index.html')]) assert.doesNotMatch(html, /<script(?![^>]*src=)|style=/);
  assert.doesNotMatch(staffJs, /innerHTML/);
});

test('migration 042: down drops the transfer tables and the reason, up brings them back', async () => {
  const m = testDb();
  try {
    await m.migrate.latest();
    await m.migrate.down(); // 044
    await m.migrate.down(); // 043
    await m.migrate.down();
    for (const t of ['transfers', 'transfer_items', 'transfer_scans']) assert.equal(await m.schema.hasTable(t), false, t);
    assert.equal(await m.schema.hasColumn('stock_movements', 'transfer_id'), false);
    await seed(m);
    const p = await m('products').first();
    const row = { store_id: p.store_id, product_id: p.id, size: 'M', delta: 1, quantity_before: 0, quantity_after: 1 };
    await assert.rejects(m('stock_movements').insert({ ...row, reason: 'transfer' }));
    await m('stock_movements').insert({ ...row, reason: 'admin' });
    await m.migrate.latest();
    assert.equal((await m('stock_movements').count({ n: '*' }))[0].n, 1, 'movements kept through the rebuild');
    await m('stock_movements').insert({ ...row, reason: 'transfer', transfer_id: 1 });
    await assert.rejects(m('stock_movements').insert({ ...row, reason: 'gift' }));
  } finally {
    await m.destroy();
  }
});
