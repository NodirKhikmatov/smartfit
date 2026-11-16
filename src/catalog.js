// Task 25: catalogue for the kiosk and the phone, the item page with "goes well with", stock of the same item in the
// organisation's other stores, and a pickup reservation there. Public; only items and sizes with free stock are shown.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { fail, CATEGORIES } from './admin/routes.js';
import { sizesOf } from './db/seed.js';
import { unitPrice, pairWith, visible } from './recommend/engine.js';
import { fitOf } from './size/size.js';
import { logMissed } from './demand.js';
import { hold, customer, insertOrder, orderView, releaseExpired, storeOf, planInstalments } from './cart/cart.js';
import { termsOf, plan } from './cart/instalment.js';
import { clientKey } from './limits.js';
import { qrSvg, publicBase } from './qr.js';
import { ratingsOf, withRatings, publicReviews, visibleRatings, byRating } from './reviews.js';

export const RESERVE_MS = 3 * 60 * 60 * 1000; // pay at that store's cashier within 3 h, then the hold is released
const MAX_LIST = 200; // shortcut: one page (category order, newest first); add paging when a store has more items
const SIZE = /^[A-Za-z0-9][A-Za-z0-9./-]{0,9}$/; // any size a shop may use (task 36: its own lists too)
// Task 36: the category's name comes along for the tiles; products of a hidden category are not shown (visible()).
export const COLS = ['p.id', 'p.name', 'p.name_ru', 'p.category', 'p.category_id', 'p.sizes', 'c.name as category_name', 'c.name_ru as category_name_ru',
  'p.audience', 'p.gender', 'p.color', 'p.style', 'p.price', 'p.discount_price', 'p.temp_min', 'p.temp_max', 'p.image_url'];
// Task 40: ?audience=adult|child. None → adults only (the default view), except a shop category picked by id, which
// is for one audience already. Never a mix: adults don't get children's items, nor the reverse.
export function audienceOf(v, category = null) {
  if (v === undefined || v === '') return category && /^\d+$/.test(category) ? null : 'adult';
  if (v !== 'adult' && v !== 'child') throw fail(400, 'err.invalid', { field: 'field.audience' });
  return v;
}
const free = 'quantity - reserved > 0';
export const inStock = (db) => db('product_stock as s').whereRaw('s.product_id = p.id').whereRaw(`s.${free}`);
export const genders = (g) => (g === 'unisex' ? ['male', 'female', 'unisex'] : [g, 'unisex']);
const posInt = (v) => Number.isInteger(v) && v > 0;
const iso = (ms) => new Date(ms).toISOString();

// Products → tiles with the sizes that have free stock now, in size order.
export async function withSizes(db, rows) {
  const stock = rows.length ? await db('product_stock').whereIn('product_id', rows.map((p) => p.id)).whereRaw(free).select('product_id', 'size') : [];
  return rows.map(({ temp_min, temp_max, style, ...p }) => ({
    ...p, unit_price: unitPrice(p), sizes: sizesOf(p).filter((s) => stock.some((x) => x.product_id === p.id && x.size === s)),
  })).filter((p) => p.sizes.length);
}

async function storeById(db, id) {
  const store = posInt(id) ? await db('stores').where({ id }).first('id', 'organization_id', 'instalment_on', 'instalment_terms') : null;
  if (!store) throw fail(404, 'err.store_not_found');
  return planInstalments(db, store);
}

export function createCatalogRouter(db, { link = () => null, maxOpen = 0 } = {}) {
  const r = express.Router();

  // GET /:store?category=&gender=male|female&size=&min=&max=&audience= → { items }. Price filters the price the customer pays.
  // category = one of the shop's category ids (task 36), or a role code (older clients).
  r.get('/:store', async (req, res) => {
    const store = await storeById(db, Number(req.params.store));
    const q = req.query;
    const one = (v) => (typeof v === 'string' && v !== '' ? v : null);
    const int = (v, field) => {
      if (one(v) === null) return null;
      if (!/^\d{1,10}$/.test(v)) throw fail(400, 'err.invalid', { field });
      return Number(v);
    };
    const category = one(q.category), gender = one(q.gender), size = one(q.size);
    if (category && !CATEGORIES.includes(category) && !/^\d{1,10}$/.test(category)) throw fail(400, 'err.invalid', { field: 'field.category' });
    if (gender && !['male', 'female'].includes(gender)) throw fail(400, 'err.invalid', { field: 'field.gender' });
    if (size && !SIZE.test(size)) throw fail(400, 'err.invalid', { field: 'field.size' });
    const min = int(q.min, 'field.price'), max = int(q.max, 'field.price');
    const audience = audienceOf(q.audience, category);
    const sort = one(q.sort);
    if (sort && sort !== 'rating') throw fail(400, 'err.invalid', { field: 'field.sort' });
    const rows = visible(db('products as p')).where('p.store_id', store.id)
      .whereExists(size ? inStock(db).where('s.size', size) : inStock(db));
    // Task 46: ?sort=rating puts the best visible average first (only from REVIEW_MIN reviews), then the usual order.
    if (sort) byRating(rows.leftJoin(visibleRatings(db).as('rv'), 'rv.product_id', 'p.id'));
    rows.orderByRaw(`c.sort, case p.category ${CATEGORIES.map((c, i) => `when '${c}' then ${i}`).join(' ')} end, p.id desc`).limit(MAX_LIST).select(COLS);
    if (category) /^\d+$/.test(category) ? rows.where('p.category_id', Number(category)) : rows.where('p.category', category);
    if (gender) rows.whereIn('p.gender', genders(gender));
    if (audience) rows.where('p.audience', audience);
    if (min !== null) rows.whereRaw('coalesce(p.discount_price, p.price) >= ?', [min]);
    if (max !== null) rows.whereRaw('coalesce(p.discount_price, p.price) <= ?', [max]);
    res.json({ items: await withRatings(db, await withSizes(db, await rows)) });
  });

  // GET /:store/items/:id → { item, pairs }: the item with its in-stock sizes and fit hint, and 2–4 in-stock items
  // that go with it (rules; same store, matching gender). 404 when the item has no free stock in any size.
  // Task 36: also every size it comes in (all_sizes), the Russian description and the shop's free details.
  r.get('/:store/items/:id', async (req, res) => {
    const store = await storeById(db, Number(req.params.store));
    const id = Number(req.params.id);
    const row = posInt(id) ? await visible(db('products as p')).where({ 'p.id': id, 'p.store_id': store.id })
      .first(...COLS, 'p.description', 'p.description_ru', 'p.details', 'p.shelf_location', 'p.fit_offset') : null;
    const [item] = row ? await withSizes(db, [row]) : [];
    if (!item) throw fail(404, 'err.product_not_found');
    const pool = await visible(db('products as p')).where('p.store_id', store.id).whereNot('p.id', id).where('p.audience', row.audience).whereIn('p.gender', genders(row.gender))
      .whereExists(inStock(db)).orderBy('p.id').select(COLS);
    const pairs = pairWith(row, pool).map((p) => p.id);
    const { fit_offset, details, ...rest } = item;
    // Task 46: the visible average, count and fit summary (null below REVIEW_MIN) and the newest visible reviews.
    res.json({
      item: { ...rest, all_sizes: sizesOf(row), rating: (await ratingsOf(db, [id])).get(id), reviews: await publicReviews(db, id), details: details ? JSON.parse(details) : [], fit_offset: (await fitOf(db, [row])).get(id).offset,
        ...(termsOf(store) && { instalments: plan(termsOf(store), rest.unit_price) }) }, // task 35: per-month figures, server-made
      pairs: await withRatings(db, await withSizes(db, pool.filter((p) => pairs.includes(p.id)).sort((a, b) => pairs.indexOf(a.id) - pairs.indexOf(b.id)))),
    });
  });

  // POST /elsewhere { store_id, product_id, size, session? } → { here, stores: [{ store_id, product_id, name, city,
  // address, count }] }: the same item (same SKU) with free stock in this size in the organisation's other stores, never
  // outside it. A size with nothing free here is logged as missed demand once per session (the visit id).
  r.post('/elsewhere', async (req, res) => {
    const b = req.body ?? {};
    const store = await storeById(db, b.store_id);
    const p = posInt(b.product_id) ? await db('products').where({ id: b.product_id, store_id: store.id }).first('id', 'sku', 'category', 'sizes') : null;
    if (!p) throw fail(404, 'err.product_not_found');
    if (!sizesOf(p).includes(b.size)) throw fail(400, 'err.invalid', { field: 'field.size' });
    const row = await db('product_stock').where({ product_id: p.id, size: b.size }).first(db.raw('quantity - reserved as n'));
    const here = Math.max(0, Number(row?.n ?? 0));
    if (!here) {
      await logMissed(db, { storeId: store.id, session: b.session, items: [{ product_id: p.id, size: b.size }], source: 'catalog' })
        .catch((err) => console.error('missed demand not logged:', err.message));
    }
    const stores = store.organization_id == null || !p.sku ? [] : await db('products as p')
      .join('stores as st', 'st.id', 'p.store_id').join('product_stock as s', 's.product_id', 'p.id')
      .where({ 'st.organization_id': store.organization_id, 'p.sku': p.sku, 's.size': b.size }).whereNot('st.id', store.id)
      .whereRaw(`s.${free}`).orderBy([{ column: 'count', order: 'desc' }, { column: 'st.id' }])
      .select('st.id as store_id', 'p.id as product_id', 'st.name', 'st.city', 'st.address', db.raw('s.quantity - s.reserved as count'));
    res.json({ here, stores: stores.map((s) => ({ ...s, count: Number(s.count) })) });
  });

  // POST /reserve { from_store_id, product_id, size, name, phone } → 201: a pickup order on the product's store, which
  // must be another store of the same organisation. One unit is held there for RESERVE_MS, paid at that store's cashier.
  r.post('/reserve', async (req, res) => {
    const b = req.body ?? {};
    await releaseExpired(db);
    const from = await storeById(db, b.from_store_id);
    const notifyToken = randomBytes(16).toString('hex');
    const client = clientKey(req.ip);
    const id = await db.transaction(async (trx) => {
      const p = posInt(b.product_id) ? await trx('products as p').join('stores as st', 'st.id', 'p.store_id').where('p.id', b.product_id)
        .first('p.id', 'p.name', 'p.name_ru', 'p.category', 'p.sizes', 'p.price', 'p.discount_price', 'p.store_id', 'st.organization_id') : null;
      // Same answer for another organisation's item as for a missing one: the lookup never leaves the organisation.
      if (!p || from.organization_id == null || p.organization_id !== from.organization_id || p.store_id === from.id) throw fail(404, 'err.product_not_found');
      if (!sizesOf(p).includes(b.size)) throw fail(400, 'err.invalid', { field: 'field.size' });
      const store = await storeOf(trx, p.store_id);
      const c = customer({ ...b, fulfillment: 'pickup' }, store);
      // Inventory DoS guard (X2), shared with carts: one client can't hold stock in too many places at once.
      if (maxOpen) {
        const live = iso(Date.now());
        const [{ n: carts }] = await trx('carts').where({ client }).where('expires_at', '>', live).select(trx.raw('count(distinct coalesce(mall_token, token)) as n')); // a mall cart counts once (task 38)
        const [{ n: orders }] = await trx('orders').where({ client, payment_status: 'pending' }).where('expires_at', '>', live).count({ n: '*' });
        if (Number(carts) + Number(orders) >= maxOpen) throw fail(429, 'err.too_many_reserves');
      }
      if (!(await hold(trx, p.id, b.size, 1))) throw fail(409, 'err.out_of_stock', { product: p, size: b.size === 'ONE' ? 'common.size_one' : b.size });
      return insertOrder(trx, store, c, [{ product_id: p.id, size: b.size, quantity: 1, unit_price: unitPrice(p) }], { notifyToken, holdMs: RESERVE_MS, client });
    });
    const order = await db('orders').where({ id }).first();
    const url = `${publicBase(req)}/order/${notifyToken}`;
    res.status(201).json({
      order: await orderView(db, order),
      store: await db('stores').where({ id: order.store_id }).first('name', 'city', 'address'),
      track: { url, svg: qrSvg(url) }, notify: link(notifyToken),
    });
  });
  return r;
}
