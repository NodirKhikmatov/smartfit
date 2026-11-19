// Task 52: transfers between the stores of one organisation. A manager (of either store) or the owner drafts the lines
// (the sending store's product, size, units); the sending side sends it, which takes the units out of the sending store
// at once (only free units: a reserved unit can't be sent); the receiving store's staff scan or type what arrived in the
// staff app, and each scan makes those units sellable there at once; "finish" fixes the transfer as received, and what
// never arrived stays recorded on its lines (sent − received), written off, never hidden or sent back.
// A draft, or a sent transfer of which nothing was received yet, can be cancelled: a sent one's units go back to the
// sending store. Every stock change writes a stock movement (reason 'transfer', with the transfer's id).
// Cost (task 49): the sending product's cost is frozen on the line when it is sent; the receiving product's cost becomes
// the weighted average of its stock and the units received at that cost (a cancel averages them back the same way).
// Only inside one organisation: a store of another organisation, or a transfer neither of whose stores is the caller's,
// is 404. The mall role never gets here (its gate); staff only open, scan and finish receiving (STAFF_ROUTES).
import { fail, canSee, int, text } from './routes.js';
import { audit } from './audit.js';
import { moved } from '../movements.js';
import { sizesOf } from '../db/seed.js';
import { stamp } from '../cart/cart.js';
import { averageCost } from './stock.js';

const KEY = /^[A-Za-z0-9-]{16,40}$/;
export const TRANSFER_STATUSES = ['draft', 'sent', 'received', 'cancelled'];
const LINES_MAX = 200;
const UNITS_MAX = 1000; // per line, and per receiving scan
const LIST_MAX = 100;
const COLS = ['t.id', 't.organization_id', 't.from_store_id', 'fs.name as from_store', 't.to_store_id', 'ts.name as to_store', 't.status', 't.note',
  't.created_email', 't.sent_email', 't.received_email', 't.cancelled_email', 't.created_at', 't.sent_at', 't.received_at', 't.cancelled_at'];
const stamped = (x) => ({ ...x, created_at: stamp(x.created_at), sent_at: stamp(x.sent_at), received_at: stamp(x.received_at), cancelled_at: stamp(x.cancelled_at) });
const named = (q) => q('transfers as t').join('stores as fs', 'fs.id', 't.from_store_id').join('stores as ts', 'ts.id', 't.to_store_id');
// A transfer is the caller's when either of its stores is (a super-admin: every one).
const touching = (admin, q) => (admin.stores === null ? q : q.where((w) => w.whereIn('t.from_store_id', admin.stores).orWhereIn('t.to_store_id', admin.stores)));
const label = (t) => `#${t.id} ${t.from_store} → ${t.to_store}`;

// Units per transfer: lines, sent, received.
async function totals(db, ids) {
  if (!ids.length) return {};
  const rows = await db('transfer_items').whereIn('transfer_id', ids).groupBy('transfer_id').select('transfer_id').count({ lines: '*' }).sum({ units: 'quantity', received: 'received' });
  return Object.fromEntries(rows.map((r) => [r.transfer_id, { lines: Number(r.lines), units: Number(r.units), received: Number(r.received) }]));
}
const withTotals = (t, n = { lines: 0, units: 0, received: 0 }) => ({ ...stamped(t), ...n, missing: t.status === 'received' ? n.units - n.received : 0 });

// The caller's transfers, newest first. `to` = only those coming into the caller's stores.
// shortcut: the newest LIST_MAX only, no paging; add it if a shop moves stock more than a few times a day.
export async function listTransfers(db, admin, { status = null, storeId = null, incoming = false } = {}) {
  const q = touching(admin, named(db)).orderBy('t.id', 'desc').limit(LIST_MAX).select(COLS);
  if (status) q.where('t.status', status);
  if (incoming && admin.stores !== null) q.whereIn('t.to_store_id', admin.stores);
  if (storeId != null) q.where((w) => w.where('t.from_store_id', storeId).orWhere('t.to_store_id', storeId));
  const rows = await q;
  const n = await totals(db, rows.map((t) => t.id));
  return rows.map((t) => withTotals(t, n[t.id]));
}

// Task 24 "Talab": per missed size, the organisation's other stores with free units of the same SKU and size (most
// first, at most 3), so the page can offer "Ko'chirish". Same organisation only; nothing for a product without a SKU.
export async function withElsewhere(db, items) {
  const skus = [...new Set(items.map((x) => x.sku).filter(Boolean))];
  if (!skus.length) return items.map((x) => ({ ...x, elsewhere: [] }));
  const orgs = Object.fromEntries((await db('stores').whereIn('id', [...new Set(items.map((x) => x.store_id))]).select('id', 'organization_id')).map((s) => [s.id, s.organization_id]));
  const there = await db('product_stock as ps').join('products as p', 'p.id', 'ps.product_id').join('stores as st', 'st.id', 'p.store_id')
    .whereIn('p.sku', skus).whereNotNull('st.organization_id').whereRaw('ps.quantity - ps.reserved > 0')
    .select('p.id as product_id', 'p.sku', 'ps.size', 'p.store_id', 'st.name as store_name', 'st.organization_id', db.raw('ps.quantity - ps.reserved as free'));
  return items.map((x) => ({
    ...x,
    elsewhere: !x.sku || orgs[x.store_id] == null ? [] : there.filter((r) => r.sku === x.sku && r.size === x.size && r.organization_id === orgs[x.store_id] && r.store_id !== x.store_id)
      .map((r) => ({ store_id: r.store_id, store_name: r.store_name, product_id: r.product_id, free: Number(r.free) })).sort((a, b) => b.free - a.free || a.store_id - b.store_id).slice(0, 3),
  }));
}

export function transferRoutes(r, db) {
  const boss = (admin) => admin.role !== 'staff'; // the gate keeps staff off the drafting routes; checked here as well

  // Two different stores of one organisation, at least one of them the caller's. Anything else is 404 (no leak).
  async function pair(admin, a, b) {
    const ids = [a, b].map((v) => (v === '' || v == null ? NaN : Number(v)));
    if (!ids.every(Number.isInteger)) throw fail(400, 'err.invalid', { field: 'field.store' });
    if (ids[0] === ids[1]) throw fail(400, 'err.transfer_same_store');
    const [from, to] = await Promise.all(ids.map((id) => db('stores').where({ id }).first('id', 'name', 'organization_id')));
    if (!from || !to || !(canSee(admin, from.id) || canSee(admin, to.id)) || from.organization_id == null || from.organization_id !== to.organization_id) throw fail(404, 'err.not_found');
    return { from, to };
  }

  // [{ product_id (the sending store's), size, quantity }] → the same SKU's product in the receiving store, which must
  // have that size: a transfer never creates a product (the manager adds it there first).
  async function readLines(from, to, raw) {
    if (!Array.isArray(raw) || !raw.length || raw.length > LINES_MAX) throw fail(400, 'err.invalid', { field: 'lines' });
    const seen = new Set();
    for (const l of raw) {
      if (!l || !Number.isInteger(l.product_id) || typeof l.size !== 'string' || seen.has(`${l.product_id} ${l.size}`)) throw fail(400, 'err.invalid', { field: 'lines' });
      int(l.quantity, 1, UNITS_MAX, 'field.quantity');
      seen.add(`${l.product_id} ${l.size}`);
    }
    const mine = new Map((await db('products').where({ store_id: from.id }).whereIn('id', raw.map((l) => l.product_id)).select('id', 'name', 'sku', 'category', 'sizes')).map((p) => [p.id, p]));
    const skus = [...mine.values()].map((p) => p.sku).filter(Boolean);
    const theirs = new Map((skus.length ? await db('products').where({ store_id: to.id }).whereIn('sku', skus).select('id', 'sku', 'category', 'sizes') : []).map((p) => [p.sku, p]));
    return raw.map((l) => {
      const p = mine.get(l.product_id);
      if (!p) throw fail(404, 'err.stock_not_here');
      if (!sizesOf(p).includes(l.size)) throw fail(400, 'err.bad_size', { size: l.size.slice(0, 10) });
      const q = p.sku && theirs.get(p.sku);
      if (!q || !sizesOf(q).includes(l.size)) throw fail(409, 'err.transfer_no_product', { name: `${p.name} ${l.size}`, store: to.name });
      return { product_id: p.id, to_product_id: q.id, size: l.size, quantity: l.quantity };
    });
  }

  async function find(req, q = db) {
    const id = Number(req.params.id);
    const t = Number.isInteger(id) ? await touching(req.admin, named(q)).where('t.id', id).first(COLS) : undefined;
    if (!t) throw fail(404, 'err.not_found');
    return t;
  }

  // One transfer with its lines (free = the sending store's free units of that size now) and what the caller may do.
  async function detail(req, t) {
    const lines = (await db('transfer_items as i').join('products as p', 'p.id', 'i.product_id')
      .leftJoin('product_stock as ps', (j) => j.on('ps.product_id', '=', 'i.product_id').andOn('ps.size', '=', 'i.size'))
      .where('i.transfer_id', t.id).orderBy('i.id')
      .select('i.id', 'i.product_id', 'i.to_product_id', 'p.name', 'p.name_ru', 'p.sku', 'p.category', 'p.shelf_location', 'i.size', 'i.quantity', 'i.received',
        db.raw('coalesce(ps.quantity - ps.reserved, 0) as free')))
      .map((l) => ({ ...l, free: Number(l.free) }));
    const n = { lines: lines.length, units: lines.reduce((s, l) => s + l.quantity, 0), received: lines.reduce((s, l) => s + l.received, 0) };
    const a = req.admin, sending = canSee(a, t.from_store_id), receiving = canSee(a, t.to_store_id);
    return { ...withTotals(t, n), lines, can: {
      edit: boss(a) && t.status === 'draft', send: boss(a) && sending && t.status === 'draft',
      cancel: boss(a) && (t.status === 'draft' || (t.status === 'sent' && !n.received)), receive: receiving && t.status === 'sent',
    } };
  }
  const reload = async (req, id) => detail(req, await touching(req.admin, named(db)).where('t.id', id).first(COLS));

  // The caller's organisation's stores (super: every store in an organisation), to pick the other end.
  r.get('/transfers/stores', async (req, res) => {
    const q = db('stores').whereNotNull('organization_id').orderBy('id').select('id', 'name', 'city', 'organization_id');
    if (req.admin.stores !== null) q.whereIn('organization_id', db('stores').whereIn('id', req.admin.stores.length ? req.admin.stores : [0]).select('organization_id'));
    res.json(await q);
  });

  // What can go from one store to the other: the sending store's products whose SKU the receiving store also has, with
  // the sizes both have, free units here and there.
  r.get('/transfers/products', async (req, res) => {
    const { from, to } = await pair(req.admin, req.query.from_store_id, req.query.to_store_id);
    const rows = await db('products as p').join('products as q', (j) => j.on('q.sku', '=', 'p.sku').andOnVal('q.store_id', '=', to.id))
      .where('p.store_id', from.id).whereNotNull('p.sku').orderBy(['p.name', 'p.id'])
      .select('p.id', 'p.name', 'p.name_ru', 'p.sku', 'p.category', 'p.sizes', 'q.id as to_product_id', 'q.category as to_category', 'q.sizes as to_sizes');
    const free = new Map((rows.length ? await db('product_stock').whereIn('product_id', rows.flatMap((p) => [p.id, p.to_product_id])).select('product_id', 'size', db.raw('quantity - reserved as free')) : [])
      .map((s) => [`${s.product_id} ${s.size}`, Math.max(0, Number(s.free))]));
    res.json({ from_store_id: from.id, to_store_id: to.id, products: rows.map((p) => {
      const there = sizesOf({ category: p.to_category, sizes: p.to_sizes });
      return { id: p.id, name: p.name, name_ru: p.name_ru, sku: p.sku, category: p.category,
        sizes: sizesOf(p).filter((s) => there.includes(s)).map((size) => ({ size, free: free.get(`${p.id} ${size}`) ?? 0, there: free.get(`${p.to_product_id} ${size}`) ?? 0 })) };
    }).filter((p) => p.sizes.length) });
  });

  r.get('/transfers', async (req, res) => {
    const status = req.query.status || null;
    if (status && !TRANSFER_STATUSES.includes(status)) throw fail(400, 'err.invalid', { field: 'status' });
    const storeId = req.query.store_id ? Number(req.query.store_id) || 0 : null;
    res.json({ items: await listTransfers(db, req.admin, { status, storeId }) });
  });

  r.get('/transfers/:id', async (req, res) => res.json(await detail(req, await find(req))));

  // { from_store_id, to_store_id, note?, lines } → a draft. A manager of either store or the owner (the receiving side
  // drafts what it wants; the sending side sends it).
  r.post('/transfers', async (req, res) => {
    if (!boss(req.admin)) throw fail(403, 'err.forbidden');
    const b = req.body ?? {};
    const { from, to } = await pair(req.admin, b.from_store_id, b.to_store_id);
    const note = text(b.note, 200, 'field.transfer_note', false);
    const lines = await readLines(from, to, b.lines);
    const id = await db.transaction(async (trx) => {
      const [{ id }] = await trx('transfers').insert({ organization_id: from.organization_id, from_store_id: from.id, to_store_id: to.id, note,
        created_by: req.admin.id, created_email: req.admin.email }).returning('id');
      await trx('transfer_items').insert(lines.map((l) => ({ ...l, transfer_id: id })));
      await audit(trx, req.admin, { action: 'transfer.create', storeId: from.id, entityId: id, label: `#${id} ${from.name} → ${to.name}`, after: { note, lines: lines.length, units: lines.reduce((s, l) => s + l.quantity, 0) } });
      return id;
    });
    res.status(201).json(await reload(req, id));
  });

  // { note?, lines } replaces a draft's lines (the stores stay).
  r.put('/transfers/:id', async (req, res) => {
    if (!boss(req.admin)) throw fail(403, 'err.forbidden');
    const t = await find(req);
    const b = req.body ?? {};
    const note = text(b.note, 200, 'field.transfer_note', false);
    const lines = await readLines({ id: t.from_store_id }, { id: t.to_store_id, name: t.to_store }, b.lines);
    await db.transaction(async (trx) => {
      if (!(await trx('transfers').where({ id: t.id, status: 'draft' }).update({ note, updated_at: trx.fn.now() }))) throw fail(409, 'err.transfer_state');
      await trx('transfer_items').where({ transfer_id: t.id }).del();
      await trx('transfer_items').insert(lines.map((l) => ({ ...l, transfer_id: t.id })));
      await audit(trx, req.admin, { action: 'transfer.update', storeId: t.from_store_id, entityId: t.id, label: label(t), after: { note, lines: lines.length, units: lines.reduce((s, l) => s + l.quantity, 0) } });
    });
    res.json(await reload(req, t.id));
  });

  // The sending side sends: every line's units leave the sending store now (free units only; a reserved unit stays),
  // all or nothing, and each line keeps the product's cost at this moment.
  r.post('/transfers/:id/send', async (req, res) => {
    if (!boss(req.admin)) throw fail(403, 'err.forbidden');
    const t = await find(req);
    if (!canSee(req.admin, t.from_store_id)) throw fail(403, 'err.transfer_sender_only', { store: t.from_store });
    await db.transaction(async (trx) => {
      if (!(await trx('transfers').where({ id: t.id, status: 'draft' }).update({ status: 'sent', sent_at: trx.fn.now(), sent_by: req.admin.id, sent_email: req.admin.email, updated_at: trx.fn.now() }))) {
        throw fail(409, 'err.transfer_state');
      }
      const items = await trx('transfer_items as i').join('products as p', 'p.id', 'i.product_id').where('i.transfer_id', t.id).orderBy('i.id')
        .select('i.id', 'i.product_id', 'i.size', 'i.quantity', 'p.name', 'p.cost');
      const after = {};
      for (const i of items) {
        if (!(await trx('product_stock').where({ product_id: i.product_id, size: i.size }).whereRaw('quantity - reserved >= ?', [i.quantity]).decrement('quantity', i.quantity))) {
          const row = await trx('product_stock').where({ product_id: i.product_id, size: i.size }).first('quantity', 'reserved');
          throw fail(409, 'err.transfer_short', { name: `${i.name} ${i.size}`, n: Math.max(0, (row?.quantity ?? 0) - (row?.reserved ?? 0)), want: i.quantity });
        }
        await trx('transfer_items').where({ id: i.id }).update({ unit_cost: i.cost });
        await moved(trx, { productId: i.product_id, size: i.size, delta: -i.quantity, reason: 'transfer', who: req.admin, ref: { transfer_id: t.id } });
        after[`${i.name} ${i.size}`] = i.quantity;
      }
      await audit(trx, req.admin, { action: 'transfer.send', storeId: t.from_store_id, entityId: t.id, label: label(t), before: { status: 'draft' }, after: { status: 'sent', ...after } });
    });
    res.json(await reload(req, t.id));
  });

  // A draft, or a sent transfer of which nothing was received yet. A sent one's units go back to the sending store.
  // Once the receiving store has scanned anything, it finishes the receiving instead (what's missing is recorded).
  r.post('/transfers/:id/cancel', async (req, res) => {
    if (!boss(req.admin)) throw fail(403, 'err.forbidden');
    const t = await find(req);
    const set = (trx) => ({ status: 'cancelled', cancelled_at: trx.fn.now(), cancelled_by: req.admin.id, cancelled_email: req.admin.email, updated_at: trx.fn.now() });
    await db.transaction(async (trx) => {
      if (await trx('transfers').where({ id: t.id, status: 'draft' }).update(set(trx))) {
        return audit(trx, req.admin, { action: 'transfer.cancel', storeId: t.from_store_id, entityId: t.id, label: label(t), before: { status: 'draft' }, after: { status: 'cancelled' } });
      }
      // Takes the row like a receiving scan does, so a scan and a cancel can't interleave; then reads what was received.
      if (!(await trx('transfers').where({ id: t.id, status: 'sent' }).update(set(trx)))) throw fail(409, 'err.transfer_state');
      const items = await trx('transfer_items').where({ transfer_id: t.id }).orderBy('id').select('product_id', 'size', 'quantity', 'received', 'unit_cost');
      if (items.some((i) => i.received > 0)) throw fail(409, 'err.transfer_partly_received');
      for (const i of items) {
        await averageCost(trx, i.product_id, i.unit_cost, i.quantity);
        if (!(await trx('product_stock').where({ product_id: i.product_id, size: i.size }).increment('quantity', i.quantity))) {
          await trx('product_stock').insert({ product_id: i.product_id, size: i.size, quantity: i.quantity });
        }
        await moved(trx, { productId: i.product_id, size: i.size, delta: i.quantity, reason: 'transfer', who: req.admin, ref: { transfer_id: t.id } });
      }
      await audit(trx, req.admin, { action: 'transfer.cancel', storeId: t.from_store_id, entityId: t.id, label: label(t), before: { status: 'sent' }, after: { status: 'cancelled', back: items.reduce((s, i) => s + i.quantity, 0) } });
    });
    res.json(await reload(req, t.id));
  });

  // The receiving store's staff: { key (the phone's id), transfer_id, product_id (the receiving store's), size, quantity }.
  // The units are sellable here at once; never more than was sent on that line. A replayed key applies nothing.
  r.post('/transfers/scans', async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.key !== 'string' || !KEY.test(b.key)) throw fail(400, 'err.invalid', { field: 'key' });
    const key = b.key;
    const replay = async () => {
      const x = await db('transfer_scans as c').join('transfers as t', 't.id', 'c.transfer_id').join('transfer_items as i', 'i.id', 'c.item_id').where('c.key', key)
        .first('c.id', 'c.transfer_id', 'i.to_product_id', 'i.size', 'c.quantity', 't.to_store_id');
      if (x && !canSee(req.admin, x.to_store_id)) throw fail(409, 'err.stock_key_used');
      return x && { id: x.id, key, transfer_id: x.transfer_id, product_id: x.to_product_id, size: x.size, quantity: x.quantity, replay: true };
    };
    const old = await replay();
    if (old) return res.json(old);
    const t = Number.isInteger(b.transfer_id) ? await touching(req.admin, named(db)).where('t.id', b.transfer_id).first(COLS) : undefined;
    if (!t) throw fail(404, 'err.not_found');
    if (!canSee(req.admin, t.to_store_id)) throw fail(403, 'err.transfer_receiver_only', { store: t.to_store });
    const qty = int(b.quantity, 1, UNITS_MAX, 'field.quantity');
    const item = Number.isInteger(b.product_id) && typeof b.size === 'string'
      ? await db('transfer_items as i').join('products as p', 'p.id', 'i.to_product_id').where({ 'i.transfer_id': t.id, 'i.to_product_id': b.product_id, 'i.size': b.size })
        .first('i.id', 'i.to_product_id', 'i.size', 'i.unit_cost', 'p.name')
      : undefined;
    if (!item) throw fail(404, 'err.transfer_not_in');
    const out = await db.transaction(async (trx) => {
      if (!(await trx('transfers').where({ id: t.id, status: 'sent' }).update({ updated_at: trx.fn.now() }))) throw fail(409, 'err.transfer_state');
      const [row] = await trx('transfer_scans').insert({ key, transfer_id: t.id, item_id: item.id, quantity: qty, admin_id: req.admin.id, admin_email: req.admin.email })
        .onConflict('key').ignore().returning('id');
      if (!row) return null; // a parallel copy of this request got there first and applied it
      if (!(await trx('transfer_items').where({ id: item.id }).whereRaw('received + ? <= quantity', [qty]).increment('received', qty))) {
        const { quantity, received } = await trx('transfer_items').where({ id: item.id }).first('quantity', 'received');
        throw fail(409, 'err.transfer_too_many', { name: `${item.name} ${item.size}`, n: quantity - received });
      }
      await averageCost(trx, item.to_product_id, item.unit_cost, qty);
      if (!(await trx('product_stock').where({ product_id: item.to_product_id, size: item.size }).increment('quantity', qty))) {
        await trx('product_stock').insert({ product_id: item.to_product_id, size: item.size, quantity: qty });
      }
      await moved(trx, { productId: item.to_product_id, size: item.size, delta: qty, reason: 'transfer', who: req.admin, ref: { transfer_id: t.id } });
      const { quantity } = await trx('product_stock').where({ product_id: item.to_product_id, size: item.size }).first('quantity');
      await audit(trx, req.admin, { action: 'transfer.scan', storeId: t.to_store_id, entityId: t.id, label: `${label(t)}: ${item.name}`, before: { [item.size]: quantity - qty }, after: { [item.size]: quantity } });
      return { id: row.id, key, transfer_id: t.id, product_id: item.to_product_id, size: item.size, quantity: qty };
    });
    if (!out) return res.json(await replay());
    res.status(201).json(out);
  });

  // The receiving store says it's done: the transfer is received; what was sent and never scanned stays on the lines
  // as missing (written off: it left the sending store and never arrived), and the audit row lists it.
  r.post('/transfers/:id/receive', async (req, res) => {
    const t = await find(req);
    if (!canSee(req.admin, t.to_store_id)) throw fail(403, 'err.transfer_receiver_only', { store: t.to_store });
    await db.transaction(async (trx) => {
      if (!(await trx('transfers').where({ id: t.id, status: 'sent' }).update({ status: 'received', received_at: trx.fn.now(), received_by: req.admin.id, received_email: req.admin.email, updated_at: trx.fn.now() }))) {
        throw fail(409, 'err.transfer_state');
      }
      const items = await trx('transfer_items as i').join('products as p', 'p.id', 'i.product_id').where('i.transfer_id', t.id).select('p.name', 'i.size', 'i.quantity', 'i.received');
      const short = items.filter((i) => i.received < i.quantity);
      await audit(trx, req.admin, { action: 'transfer.receive', storeId: t.to_store_id, entityId: t.id, label: label(t),
        before: { status: 'sent', ...Object.fromEntries(short.map((i) => [`${i.name} ${i.size}`, i.quantity])) },
        after: { status: 'received', ...Object.fromEntries(short.map((i) => [`${i.name} ${i.size}`, i.received])) } });
    });
    res.json(await reload(req, t.id));
  });
}
