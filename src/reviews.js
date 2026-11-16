// Task 46: ratings and reviews after a purchase. A review comes only through the order's status token, once per
// handed-over order line (unique order_item_id), and stores no phone, profile or name: the item page shows "Xaridor".
// Text is untrusted and public: plain text, length-limited, always drawn with textContent, and the shop can hide it.
import express from 'express';
import { fail, inStores, text as adminText, paging } from './admin/routes.js';
import { audit } from './admin/audit.js';
import { TOKEN, iso, stamp } from './cart/cart.js';
import { sizesOf } from './db/seed.js';
import { FITS } from './size/size.js';

export const REVIEW_MIN = 3; // an average (and a fit summary) is shown only from this many visible reviews
export const REVIEW_TEXT_MAX = 500;
const LIST_MAX = 20; // newest visible reviews on the item page (shortcut: no paging)
export const reviewOpen = (o) => o.status === 'delivered' && o.payment_status === 'paid'; // handed over (pickup) or delivered

// Control characters (newlines kept), zero-width and bidi-override characters out, at most one empty line in a row.
export function reviewText(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw fail(400, 'err.invalid', { field: 'field.review_text' });
  const s = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > REVIEW_TEXT_MAX) throw fail(400, 'err.review_text', { max: REVIEW_TEXT_MAX });
  return s || null;
}
const sized = (p) => sizesOf(p).length > 1; // one-size items (accessories) get a rating and text, no fit answer

// Task 23 returns of these order lines: whether any unit went back for money, and the size kept after an exchange.
export async function lineFacts(db, itemIds) {
  const m = new Map();
  if (!itemIds.length) return m;
  for (const r of await db('order_returns').whereIn('order_item_id', itemIds).orderBy('id').select('order_item_id', 'kind', 'quantity', 'new_size')) {
    const f = m.get(r.order_item_id) ?? { returned: 0, size: null };
    if (r.kind === 'return') f.returned += r.quantity;
    else if (r.new_size) f.size = r.new_size;
    m.set(r.order_item_id, f);
  }
  return m;
}

// small / big / right when more than half of at least REVIEW_MIN answers say so, else mixed; null below the minimum.
export function fitSummary({ small = 0, right = 0, big = 0 }) {
  const n = small + right + big;
  if (n < REVIEW_MIN) return null;
  return ['small', 'big', 'right'].find((k) => ({ small, right, big })[k] * 2 > n) ?? 'mixed';
}

// Visible reviews per product, as a subquery (product_id, ravg, rn) for sorting by rating in SQL.
export const visibleRatings = (db) => db('product_reviews').whereNull('hidden_at').groupBy('product_id')
  .select('product_id', db.raw('avg(rating) as ravg'), db.raw('count(*) as rn'));
// Rated first (from REVIEW_MIN reviews), best average first, then more reviews; `rv` = visibleRatings joined.
export const byRating = (q) => q.orderByRaw('case when rv.rn >= ? then 0 else 1 end, case when rv.rn >= ? then rv.ravg end desc, rv.rn desc', [REVIEW_MIN, REVIEW_MIN]);

// product id → { avg, count, fit } from visible reviews only. avg (1 decimal) and fit are null below REVIEW_MIN.
export async function ratingsOf(db, productIds) {
  const ids = [...new Set(productIds)];
  const rows = ids.length ? await db('product_reviews').whereIn('product_id', ids).whereNull('hidden_at').groupBy('product_id')
    .select('product_id', db.raw('count(*) as n'), db.raw('avg(rating) as a'),
      ...FITS.map((f) => db.raw(`sum(case when fit = '${f}' then 1 else 0 end) as ${f}`))) : [];
  const out = new Map(ids.map((id) => [id, { avg: null, count: 0, fit: null }]));
  for (const r of rows) {
    const count = Number(r.n);
    out.set(r.product_id, { avg: count >= REVIEW_MIN ? Math.round(Number(r.a) * 10) / 10 : null, count,
      fit: fitSummary({ small: Number(r.small), right: Number(r.right), big: Number(r.big) }) });
  }
  return out;
}
export const withRatings = async (db, items) => {
  const m = await ratingsOf(db, items.map((p) => p.id));
  return items.map((p) => ({ ...p, rating: m.get(p.id) }));
};

// The newest visible reviews of one product for the item page: no order, phone or name, only the size the customer kept.
export async function publicReviews(db, productId) {
  const rows = await db('product_reviews as r').join('order_items as i', 'i.id', 'r.order_item_id').where('r.product_id', productId).whereNull('r.hidden_at')
    .orderBy('r.id', 'desc').limit(LIST_MAX).select('r.order_item_id', 'r.rating', 'r.fit', 'r.text', 'r.reply', 'r.created_at', 'i.size');
  const facts = await lineFacts(db, rows.map((r) => r.order_item_id));
  return rows.map(({ order_item_id: id, size, created_at, ...r }) => ({ ...r, size: facts.get(id)?.size ?? size, returned: Boolean(facts.get(id)?.returned), created_at: stamp(created_at) }));
}

// For the status page: each line's own review (also when the shop hid it: the customer sees that, not the reason),
// whether it can be reviewed (sized = asks the fit), the kept size and whether units went back.
export async function orderLines(db, o, items) {
  const ids = items.map((i) => i.id);
  const reviews = new Map((ids.length ? await db('product_reviews').whereIn('order_item_id', ids).select('order_item_id', 'rating', 'fit', 'text', 'reply', 'hidden_at') : [])
    .map(({ order_item_id: id, hidden_at, ...r }) => [id, { ...r, hidden: hidden_at != null }]));
  const facts = await lineFacts(db, ids);
  return items.map((i) => ({ id: i.id, sized: sized(i), kept_size: facts.get(i.id)?.size ?? null, returned: Boolean(facts.get(i.id)?.returned), review: reviews.get(i.id) ?? null }));
}

const unique = (err) => err?.code === '23505' || err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';

// POST /api/orders/:token/reviews { item, rating 1–5, fit?, text? } → 201. Rate-limited per IP (`limit`).
// Decided: no editing; a review is final (the shop's answer refers to it). A read-only shop's customers can still
// review what they bought. The fit answer also becomes the task 23 answer of the line (size offset, accuracy).
export function createReviewRouter(db, { limit = (req, res, next) => next() } = {}) {
  const r = express.Router();
  r.post('/:token/reviews', limit, async (req, res) => {
    const o = TOKEN.test(req.params.token) ? await db('orders').where({ notify_token: req.params.token }).first('id', 'store_id', 'status', 'payment_status') : null;
    if (!o) throw fail(404, 'err.order_not_found');
    if (!reviewOpen(o)) throw fail(409, 'err.review_not_yet');
    const b = req.body ?? {};
    const line = Number.isInteger(b.item) ? await db('order_items as i').join('products as p', 'p.id', 'i.product_id').where({ 'i.id': b.item, 'i.order_id': o.id })
      .first('i.id', 'i.product_id', 'p.category', 'p.sizes') : null;
    if (!line) throw fail(404, 'err.not_found');
    if (!Number.isInteger(b.rating) || b.rating < 1 || b.rating > 5) throw fail(400, 'err.invalid', { field: 'field.rating' });
    const fit = b.fit ?? null;
    if (sized(line) ? !FITS.includes(fit) : fit !== null) throw fail(400, 'err.invalid', { field: 'field.fit' });
    const row = { order_item_id: line.id, order_id: o.id, store_id: o.store_id, product_id: line.product_id, rating: b.rating, fit, text: reviewText(b.text) };
    if (await db('product_reviews').where({ order_item_id: line.id }).first('id')) throw fail(409, 'err.review_exists');
    try {
      await db.transaction(async (trx) => {
        await trx('product_reviews').insert(row);
        if (fit) await trx('order_items').where({ id: line.id }).update({ fit, fit_at: iso(Date.now()) });
      });
    } catch (err) {
      if (unique(err)) throw fail(409, 'err.review_exists'); // a parallel submit won
      throw err;
    }
    res.status(201).json({ item: line.id, review: { rating: row.rating, fit, text: row.text, reply: null, hidden: false } });
  });
  return r;
}

// Admin. Scoped like orders: super every store, an owner the organisation's stores, a manager their store; staff and
// the mall role never reach these (STAFF_ROUTES / MALL_ROUTES). Decided: the owner (and super) hides and shows again,
// with a reason, audited; owner and manager may answer, once.
const SHOWS = ['all', 'unanswered', 'low', 'hidden'];
export function reviewRoutes(r, db) {
  const scoped = (req) => {
    const q = inStores(req.admin, db('product_reviews as r'), 'r.store_id');
    if (req.query?.store_id) q.where('r.store_id', Number(req.query.store_id) || 0);
    return q;
  };
  async function findReview(req) {
    const id = Number(req.params.id);
    const row = Number.isInteger(id) && id > 0 && id < 2 ** 31 ? await scoped({ admin: req.admin }).join('products as p', 'p.id', 'r.product_id').where('r.id', id).first('r.*', 'p.name') : null;
    if (!row) throw fail(404, 'err.not_found');
    return row;
  }
  const view = async (rows) => {
    const facts = await lineFacts(db, rows.map((x) => x.order_item_id));
    return rows.map(({ order_item_id: id, size, created_at, hidden_at, reply_at, ...x }) => ({ ...x, size: facts.get(id)?.size ?? size, returned: Boolean(facts.get(id)?.returned),
      created_at: stamp(created_at), hidden_at: stamp(hidden_at), reply_at: stamp(reply_at) }));
  };

  // GET /reviews?show=all|unanswered|low|hidden&store_id=&limit=&offset= → { items, total, products }: newest first;
  // products = the report: per product its visible average, count and fit answers, lowest average first.
  r.get('/reviews', async (req, res) => {
    const show = req.query.show || 'all';
    if (!SHOWS.includes(show)) throw fail(400, 'err.invalid', { field: 'field.filter' });
    const { limit, offset } = paging(req.query);
    const q = scoped(req);
    if (show === 'unanswered') q.whereNull('r.reply').whereNull('r.hidden_at');
    if (show === 'low') q.where('r.rating', '<=', 2);
    if (show === 'hidden') q.whereNotNull('r.hidden_at');
    const [{ n }] = await q.clone().count({ n: '*' });
    const rows = await q.join('products as p', 'p.id', 'r.product_id').join('order_items as i', 'i.id', 'r.order_item_id').join('orders as o', 'o.id', 'r.order_id')
      .orderBy('r.id', 'desc').limit(limit).offset(offset)
      .select('r.id', 'r.order_item_id', 'r.store_id', 'r.product_id', 'r.rating', 'r.fit', 'r.text', 'r.created_at', 'r.hidden_at', 'r.hidden_reason', 'r.reply', 'r.reply_at',
        'p.name', 'p.name_ru', 'p.category', 'p.image_url', 'i.size', 'o.number as order_number', 'o.id as order_id');
    res.json({ items: await view(rows), total: Number(n), limit, offset, products: await report(db, scoped(req)) });
  });

  // { reason 3–200 } → hidden from the item page, the averages and the catalogue sort. Owner and super only.
  r.post('/reviews/:id/hide', async (req, res) => {
    if (req.admin.role === 'manager') throw fail(403, 'err.forbidden');
    const rv = await findReview(req);
    const reason = adminText(req.body?.reason, 200, 'field.hide_reason', true);
    if (reason.length < 3) throw fail(400, 'err.invalid', { field: 'field.hide_reason' });
    await db.transaction(async (trx) => {
      if (!(await trx('product_reviews').where({ id: rv.id }).whereNull('hidden_at').update({ hidden_at: iso(Date.now()), hidden_reason: reason, hidden_by: req.admin.id }))) throw fail(409, 'err.review_hidden');
      await audit(trx, req.admin, { action: 'review.hide', storeId: rv.store_id, entityId: rv.id, label: rv.name, before: { rating: rv.rating, text: rv.text }, after: { hidden_reason: reason } });
    });
    res.json({ id: rv.id, hidden: true });
  });
  r.post('/reviews/:id/show', async (req, res) => {
    if (req.admin.role === 'manager') throw fail(403, 'err.forbidden');
    const rv = await findReview(req);
    await db.transaction(async (trx) => {
      if (!(await trx('product_reviews').where({ id: rv.id }).whereNotNull('hidden_at').update({ hidden_at: null, hidden_reason: null, hidden_by: null }))) throw fail(409, 'err.review_shown');
      await audit(trx, req.admin, { action: 'review.show', storeId: rv.store_id, entityId: rv.id, label: rv.name, before: { hidden_reason: rv.hidden_reason } });
    });
    res.json({ id: rv.id, hidden: false });
  });

  // { text 2–500 } → the shop's public answer, once (a conditional UPDATE, so two clicks answer once).
  r.post('/reviews/:id/reply', async (req, res) => {
    const rv = await findReview(req);
    const reply = reviewText(adminText(req.body?.text, REVIEW_TEXT_MAX, 'field.reply', true));
    if (!reply || reply.length < 2) throw fail(400, 'err.invalid', { field: 'field.reply' });
    await db.transaction(async (trx) => {
      if (!(await trx('product_reviews').where({ id: rv.id }).whereNull('reply').update({ reply, reply_at: iso(Date.now()), reply_by: req.admin.id }))) throw fail(409, 'err.review_replied');
      await audit(trx, req.admin, { action: 'review.reply', storeId: rv.store_id, entityId: rv.id, label: rv.name, after: { reply } });
    });
    res.json({ id: rv.id, reply });
  });
}

// Lowest-rated products first (visible reviews), with the fit answers; `q` = the admin's scoped product_reviews as r.
export async function report(db, q, limit = 20) {
  const rows = await q.whereNull('r.hidden_at').join('products as p', 'p.id', 'r.product_id')
    .groupBy('r.product_id', 'p.name', 'p.name_ru', 'p.category', 'p.image_url', 'p.store_id')
    .select('r.product_id', 'p.name', 'p.name_ru', 'p.category', 'p.image_url', 'p.store_id', db.raw('count(*) as n'), db.raw('avg(r.rating) as a'),
      ...FITS.map((f) => db.raw(`sum(case when r.fit = '${f}' then 1 else 0 end) as ${f}`)))
    .orderByRaw('avg(r.rating), count(*) desc, r.product_id').limit(limit);
  return rows.map(({ n, a, small, right, big, ...p }) => {
    const fit = { small: Number(small), right: Number(right), big: Number(big) };
    return { ...p, count: Number(n), avg: Math.round(Number(a) * 10) / 10, fit, fit_summary: fitSummary(fit) };
  });
}
