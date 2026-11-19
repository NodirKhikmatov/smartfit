// Task 47: receiving and stocktake from the staff app ("Ombor"), and each product's stock history in admin.
// A session groups the scans: a receiving (each scan adds stock at once) or a count of a category and/or a shelf (scans
// are only recorded; a manager or owner confirms the differences, which writes the corrections). Sessions and scans
// carry the phone's own id (`key`, unique in the DB), so the offline queue, a double tap or a retry applies once.
// Every quantity change writes a stock_movements row (src/movements.js). The back-in-stock alert (task 31) and the
// low-stock flag are outboxes that read product_stock, so receiving and counts trigger them like the admin form does.
import { fail, canSee, inStores, int, text, paging } from './routes.js';
import { audit } from './audit.js';
import { moved } from '../movements.js';
import { sizesOf } from '../db/seed.js';
import { stamp } from '../cart/cart.js';

const KEY = /^[A-Za-z0-9-]{16,40}$/;
const KINDS = ['receive', 'count'];
const SCAN_MAX = 1000; // units in one scan
const CONFIRM_MAX = 5000; // lines in one confirm
const SESSION_COLS = ['id', 'key', 'store_id', 'kind', 'status', 'note', 'category_id', 'shelf', 'created_email', 'created_at', 'closed_at'];

const keyOf = (v, field) => {
  if (typeof v !== 'string' || !KEY.test(v)) throw fail(400, 'err.invalid', { field });
  return v;
};
const sessionOut = (s, n = {}) => ({ ...s, created_at: stamp(s.created_at), closed_at: stamp(s.closed_at), scans: Number(n.scans ?? 0), units: Number(n.units ?? 0) });
const shelfKey = (v) => String(v ?? '').trim().toLowerCase();
const inScope = (s, p) => (s.category_id == null || p.category_id === s.category_id) && (s.shelf == null || shelfKey(p.shelf_location) === shelfKey(s.shelf));

export function stockRoutes(r, db, { findProduct }) {
  // ?store_id when given (must be one of the caller's), else the caller's only store.
  async function storeFor(admin, raw) {
    if (raw === undefined || raw === null || raw === '') {
      if (admin.stores?.length === 1) return admin.stores[0];
      throw fail(400, 'err.invalid', { field: 'field.store' });
    }
    const id = Number(raw);
    if (!Number.isInteger(id) || !canSee(admin, id) || !(await db('stores').where({ id }).first('id'))) throw fail(404, 'err.not_found');
    return id;
  }

  const counts = async (q, ids) => Object.fromEntries((await q('stock_scans').whereIn('session_id', ids).groupBy('session_id')
    .select('session_id').count({ scans: '*' }).sum({ units: 'quantity' })).map((x) => [x.session_id, x]));
  async function view(q, s) {
    return sessionOut(s, (await counts(q, [s.id]))[s.id]);
  }

  async function findSession(req, q = db) {
    const id = Number(req.params.id);
    const s = Number.isInteger(id) ? await inStores(req.admin, q('stock_sessions'), 'store_id').where({ id }).first(SESSION_COLS) : undefined;
    if (!s) throw fail(404, 'err.not_found');
    return s;
  }

  // A count's lines: every size in its scope with stock or a scan, the counted units (scans added up) and the stock now.
  // The count compares with total stock, not free stock: units held in carts are still on the shelf.
  async function countLines(q, s) {
    const counted = await q('stock_scans').where({ session_id: s.id }).groupBy('product_id', 'size').select('product_id', 'size').sum({ n: 'quantity' });
    const scope = q('product_stock as ps').join('products as p', 'p.id', 'ps.product_id').where('p.store_id', s.store_id)
      .select('ps.product_id', 'ps.size', 'ps.quantity', 'ps.reserved', 'p.name', 'p.name_ru', 'p.sku', 'p.shelf_location', 'p.category', 'p.sizes', 'p.category_id');
    scope.where((w) => {
      w.where((x) => {
        if (s.category_id != null) x.where('p.category_id', s.category_id);
        if (s.shelf != null) x.whereRaw('lower(trim(p.shelf_location)) = ?', [shelfKey(s.shelf)]);
      });
      if (counted.length) w.orWhereIn('ps.product_id', [...new Set(counted.map((c) => c.product_id))]);
    });
    const n = new Map(counted.map((c) => [`${c.product_id} ${c.size}`, Number(c.n)]));
    return (await scope).filter((x) => x.quantity > 0 || n.has(`${x.product_id} ${x.size}`)).map((x) => {
      const c = n.get(`${x.product_id} ${x.size}`) ?? 0;
      return { product_id: x.product_id, name: x.name, name_ru: x.name_ru, sku: x.sku, shelf_location: x.shelf_location, size: x.size,
        counted: c, quantity: x.quantity, reserved: x.reserved, diff: c - x.quantity, blocked: c < x.reserved, order: sizesOf(x).indexOf(x.size) };
    }).sort((a, b) => shelfKey(a.shelf_location).localeCompare(shelfKey(b.shelf_location)) || a.name.localeCompare(b.name) || a.product_id - b.product_id || a.order - b.order)
      .map(({ order, ...x }) => x);
  }

  // The store's products for the phone's own lookup (SKU, barcode, QR label link, name), kept for when the network drops.
  // shortcut: the whole list in one answer (a few hundred KB at 3 000 products); page it if a shop grows past that.
  r.get('/stock/catalog', async (req, res) => {
    const storeId = await storeFor(req.admin, req.query.store_id);
    const { organization_id: org } = await db('stores').where({ id: storeId }).first('organization_id');
    const [products, categories] = await Promise.all([
      db('products').where({ store_id: storeId }).orderBy('id').select('id', 'sku', 'barcode', 'name', 'name_ru', 'category', 'sizes', 'category_id', 'shelf_location'),
      org == null ? [] : db('categories').where({ organization_id: org }).orderBy(['sort', 'id']).select('id', 'name', 'name_ru'),
    ]);
    res.json({ store_id: storeId, categories, products: products.map(({ category, sizes, ...p }) => ({ ...p, sizes: sizesOf({ category, sizes }) })) });
  });

  // The open sessions of the caller's stores, newest first.
  r.get('/stock/sessions', async (req, res) => {
    const open = await inStores(req.admin, db('stock_sessions'), 'store_id').select(SESSION_COLS).where({ status: 'open' }).orderBy('id', 'desc').limit(50);
    const n = await counts(db, open.map((s) => s.id));
    res.json({ open: open.map((s) => sessionOut(s, n[s.id])) });
  });

  r.get('/stock/sessions/:id', async (req, res) => {
    const s = await findSession(req);
    const out = await view(db, s);
    if (s.kind === 'count') {
      out.lines = await countLines(db, s);
      out.can_confirm = req.admin.role !== 'staff' && s.status === 'open';
    } else {
      out.scans = (await db('stock_scans as c').join('products as p', 'p.id', 'c.product_id').where('c.session_id', s.id).orderBy('c.id', 'desc').limit(200)
        .select('c.id', 'c.key', 'c.product_id', 'p.name', 'p.name_ru', 'p.sku', 'c.size', 'c.quantity', 'c.admin_email', 'c.created_at'))
        .map((x) => ({ ...x, created_at: stamp(x.created_at) }));
    }
    res.json(out);
  });

  // { key, kind: receive|count, store_id?, note?, category_id?, shelf? }. A count needs a category or a shelf (or both).
  r.post('/stock/sessions', async (req, res) => {
    const b = req.body ?? {};
    const key = keyOf(b.key, 'key');
    const again = async () => {
      const s = await db('stock_sessions').where({ key }).first(SESSION_COLS);
      if (s && !canSee(req.admin, s.store_id)) throw fail(409, 'err.stock_key_used');
      return s;
    };
    const old = await again();
    if (old) return res.json(await view(db, old));
    if (!KINDS.includes(b.kind)) throw fail(400, 'err.invalid', { field: 'kind' });
    const storeId = await storeFor(req.admin, b.store_id);
    const note = text(b.note, 200, 'field.stock_note', false);
    let categoryId = null, shelf = null;
    if (b.kind === 'count') {
      shelf = text(b.shelf, 40, 'field.shelf_location', false);
      if (b.category_id != null && b.category_id !== '') {
        const { organization_id: org } = await db('stores').where({ id: storeId }).first('organization_id');
        const c = Number.isInteger(b.category_id) ? await db('categories').where({ id: b.category_id, organization_id: org ?? 0 }).first('id') : undefined;
        if (!c) throw fail(400, 'err.invalid', { field: 'field.category' });
        categoryId = c.id;
      }
      if (categoryId == null && shelf == null) throw fail(400, 'err.stock_scope');
    }
    const s = await db.transaction(async (trx) => {
      const [row] = await trx('stock_sessions').insert({ key, store_id: storeId, kind: b.kind, note, category_id: categoryId, shelf, created_by: req.admin.id, created_email: req.admin.email })
        .onConflict('key').ignore().returning('id');
      if (!row) return null; // the same request won a moment ago
      await audit(trx, req.admin, { action: 'stock.open', storeId, entityId: row.id, label: note ?? shelf ?? b.kind, after: { kind: b.kind, note, category_id: categoryId, shelf } });
      return trx('stock_sessions').where({ id: row.id }).first(SESSION_COLS);
    });
    if (!s) return res.json(await view(db, await again()));
    res.status(201).json(await view(db, s));
  });

  // { key, session: the session's key, product_id, size, quantity }. A receiving adds `quantity` (1–1000) to the stock
  // now; a count records it (−1000…1000, a minus takes back a miscount; a line never goes below 0).
  r.post('/stock/scans', async (req, res) => {
    const b = req.body ?? {};
    const key = keyOf(b.key, 'key');
    const replay = async () => {
      const x = await db('stock_scans as c').join('stock_sessions as s', 's.id', 'c.session_id').where('c.key', key).first('c.id', 'c.session_id', 'c.product_id', 'c.size', 'c.quantity', 's.store_id');
      if (x && !canSee(req.admin, x.store_id)) throw fail(409, 'err.stock_key_used');
      return x && { id: x.id, key, session_id: x.session_id, product_id: x.product_id, size: x.size, quantity: x.quantity, replay: true };
    };
    const old = await replay();
    if (old) return res.json(old);
    const s = await inStores(req.admin, db('stock_sessions'), 'store_id').where({ key: keyOf(b.session, 'session') }).first(SESSION_COLS);
    if (!s) throw fail(404, 'err.stock_session_missing');
    const qty = s.kind === 'receive' ? int(b.quantity, 1, SCAN_MAX, 'field.quantity') : int(b.quantity, -SCAN_MAX, SCAN_MAX, 'field.quantity');
    if (!qty) throw fail(400, 'err.invalid', { field: 'field.quantity' });
    // Task 49: "kirim narxi", the unit cost on this delivery (receiving only). Staff never see or set a cost.
    const cost = b.cost === undefined || b.cost === null || b.cost === '' ? null : int(b.cost, 0, 1e9, 'field.cost');
    if (cost !== null && req.admin.role === 'staff') throw fail(403, 'err.forbidden');
    if (cost !== null && s.kind !== 'receive') throw fail(400, 'err.invalid', { field: 'field.cost' });
    // Only this session's store: another store's product (or an unknown id) is refused, never applied.
    const p = Number.isInteger(b.product_id) ? await db('products').where({ id: b.product_id, store_id: s.store_id }).first('id', 'name', 'category', 'sizes', 'category_id', 'shelf_location') : undefined;
    if (!p) throw fail(404, 'err.stock_not_here');
    if (typeof b.size !== 'string' || !sizesOf(p).includes(b.size)) throw fail(400, 'err.bad_size', { size: String(b.size ?? '').slice(0, 10) });
    if (s.kind === 'count' && !inScope(s, p)) throw fail(409, 'err.stock_out_of_scope', { name: p.name });
    const out = await db.transaction(async (trx) => {
      // Takes the session's row: a confirm or close running now waits for this scan, or this scan sees it closed.
      if (!(await trx('stock_sessions').where({ id: s.id, status: 'open' }).update({ updated_at: trx.fn.now() }))) throw fail(409, 'err.stock_session_closed');
      const [row] = await trx('stock_scans').insert({ key, session_id: s.id, product_id: p.id, size: b.size, quantity: qty, admin_id: req.admin.id, admin_email: req.admin.email })
        .onConflict('key').ignore().returning('id');
      if (!row) return null; // a parallel copy of this request got there first and applied it
      if (s.kind === 'count') {
        const [{ n }] = await trx('stock_scans').where({ session_id: s.id, product_id: p.id, size: b.size }).sum({ n: 'quantity' });
        if (Number(n) < 0) throw fail(409, 'err.stock_count_negative');
      } else {
        // The cost becomes the weighted average of the stock on hand (all sizes, before this scan) and these units. The
        // no-op UPDATE takes the product's row first, so two deliveries of one product can't both average the same old cost.
        // An unknown old cost, or no stock left, takes the new cost as it is.
        let costs = null;
        if (cost !== null) {
          await trx('products').where({ id: p.id }).update({ cost: trx.raw('cost') });
          const { cost: old } = await trx('products').where({ id: p.id }).first('cost');
          const [{ n }] = await trx('product_stock').where({ product_id: p.id }).sum({ n: 'quantity' });
          const have = Math.max(Number(n) || 0, 0);
          costs = { before: old, after: old == null || !have ? cost : Math.round((old * have + cost * qty) / (have + qty)) };
          await trx('products').where({ id: p.id }).update({ cost: costs.after, updated_at: trx.fn.now() });
        }
        const up = await trx('product_stock').where({ product_id: p.id, size: b.size }).increment('quantity', qty);
        if (!up) await trx('product_stock').insert({ product_id: p.id, size: b.size, quantity: qty });
        await moved(trx, { productId: p.id, size: b.size, delta: qty, reason: 'receive', who: req.admin, ref: { session_id: s.id } });
        const { quantity } = await trx('product_stock').where({ product_id: p.id, size: b.size }).first('quantity');
        await audit(trx, req.admin, { action: 'stock.receive', storeId: s.store_id, entityId: p.id, label: p.name,
          before: { [b.size]: quantity - qty, ...(costs && { cost: costs.before }) }, after: { [b.size]: quantity, ...(costs && { cost: costs.after }) } });
        if (costs) return { id: row.id, key, session_id: s.id, product_id: p.id, size: b.size, quantity: qty, cost: costs.after };
      }
      return { id: row.id, key, session_id: s.id, product_id: p.id, size: b.size, quantity: qty };
    });
    if (!out) return res.json(await replay());
    res.status(201).json(out);
  });

  // Finishes a receiving (closed) or drops a count without changing stock (cancelled). Anyone of the store.
  r.post('/stock/sessions/:id/close', async (req, res) => {
    const s = await findSession(req);
    const status = s.kind === 'receive' ? 'closed' : 'cancelled';
    const out = await db.transaction(async (trx) => {
      if (!(await trx('stock_sessions').where({ id: s.id, status: 'open' }).update({ status, closed_at: trx.fn.now(), closed_by: req.admin.id, updated_at: trx.fn.now() }))) {
        throw fail(409, 'err.stock_session_closed');
      }
      await audit(trx, req.admin, { action: 'stock.close', storeId: s.store_id, entityId: s.id, label: s.note ?? s.shelf ?? s.kind, before: { status: 'open' }, after: { status } });
      return view(trx, { ...s, ...(await trx('stock_sessions').where({ id: s.id }).first('status', 'closed_at')) });
    });
    res.json(out);
  });

  // A manager or owner (staff never reach this route) applies a count. { lines: [{ product_id, size, quantity }] } = the
  // lines to correct, each with the stock number the manager saw. Compared at confirm time: if the stock moved since
  // (a sale, a return), nothing is applied and the manager looks again (409 stock_changed). A count below what carts
  // and unpaid orders hold is refused (409 stock_below_reserved): stock never drops under the reserved units.
  r.post('/stock/sessions/:id/confirm', async (req, res) => {
    if (req.admin.role === 'staff') throw fail(403, 'err.forbidden'); // the gate already stops staff; kept next to the rule
    const s = await findSession(req);
    if (s.kind !== 'count') throw fail(400, 'err.invalid', { field: 'kind' });
    const lines = req.body?.lines;
    if (!Array.isArray(lines) || lines.length > CONFIRM_MAX) throw fail(400, 'err.invalid', { field: 'lines' });
    const seen = new Set();
    for (const l of lines) {
      if (!l || !Number.isInteger(l.product_id) || typeof l.size !== 'string' || !Number.isInteger(l.quantity) || seen.has(`${l.product_id} ${l.size}`)) throw fail(400, 'err.invalid', { field: 'lines' });
      seen.add(`${l.product_id} ${l.size}`);
    }
    const out = await db.transaction(async (trx) => {
      if (!(await trx('stock_sessions').where({ id: s.id, status: 'open' }).update({ status: 'confirmed', closed_at: trx.fn.now(), closed_by: req.admin.id, updated_at: trx.fn.now() }))) {
        throw fail(409, 'err.stock_session_closed');
      }
      const now = new Map((await countLines(trx, s)).map((x) => [`${x.product_id} ${x.size}`, x]));
      const before = {}, after = {};
      for (const l of lines) {
        const x = now.get(`${l.product_id} ${l.size}`);
        if (!x) throw fail(400, 'err.invalid', { field: 'lines' });
        const name = `${x.name} ${x.size}`;
        if (x.quantity !== l.quantity) throw fail(409, 'err.stock_changed', { name, n: x.quantity });
        if (x.counted < x.reserved) throw fail(409, 'err.stock_below_reserved', { name, n: x.reserved, counted: x.counted });
        if (!x.diff) continue;
        if (!(await trx('product_stock').where({ product_id: x.product_id, size: x.size, quantity: x.quantity }).where('reserved', '<=', x.counted).update({ quantity: x.counted }))) {
          throw fail(409, 'err.stock_changed', { name, n: x.quantity }); // a hold or a sale landed meanwhile
        }
        await moved(trx, { productId: x.product_id, size: x.size, delta: x.diff, reason: 'count', who: req.admin, ref: { session_id: s.id } });
        before[name] = x.quantity;
        after[name] = x.counted;
      }
      await audit(trx, req.admin, { action: 'stock.count', storeId: s.store_id, entityId: s.id, label: s.note ?? s.shelf ?? s.kind, before, after });
      return { applied: Object.keys(after).length, session: await view(trx, { ...s, status: 'confirmed' }) };
    });
    res.json(out);
  });

  // The product's stock history, newest first: who, when, why, before and after.
  r.get('/products/:id/movements', async (req, res) => {
    const p = await findProduct(req);
    const { limit, offset } = paging(req.query);
    const [rows, [{ n }]] = await Promise.all([
      db('stock_movements as m').leftJoin('stock_sessions as s', 's.id', 'm.session_id').leftJoin('orders as o', 'o.id', 'm.order_id')
        .where('m.product_id', p.id).orderBy('m.id', 'desc').limit(limit).offset(offset)
        .select('m.id', 'm.size', 'm.delta', 'm.quantity_before', 'm.quantity_after', 'm.reason', 'm.admin_email', 'm.session_id', 's.kind as session_kind', 's.note as session_note', 'o.number as order_number', 'm.created_at'),
      db('stock_movements').where({ product_id: p.id }).count({ n: '*' }),
    ]);
    res.json({ items: rows.map((x) => ({ ...x, created_at: stamp(x.created_at) })), total: Number(n), limit, offset });
  });
}
