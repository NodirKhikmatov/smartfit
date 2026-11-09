// Task 24: missed demand (wanted, but 0 free stock), the customer funnel by step, and the restock suggestion.
// Neither log holds personal data: a random session/visit id, product, size, store, kiosk id and time only.
import express from 'express';
import { fail, dayKey, msOf } from './admin/routes.js';
import { dbTime } from './recommend/routes.js';

export const FUNNEL_STEPS = ['start', 'size', 'outfits', 'cart', 'order'];
const ID = /^[a-f0-9]{32}$/;
const DEVICE = /^[a-f0-9]{16,32}$/; // the kiosk heartbeat id (kiosk.js)
const iso = (ms) => new Date(ms).toISOString(); // paid_at is written as an ISO string (cart.js)

// Once per session (the results screen's rec token, or the cart token) per product and size; a re-query adds nothing.
export async function logMissed(db, { storeId, session, items, source }) {
  if (!items.length || typeof session !== 'string' || !ID.test(session)) return;
  await db('missed_demand').insert(items.map((i) => ({ store_id: storeId, product_id: i.product_id, size: i.size, session, source })))
    .onConflict(['session', 'product_id', 'size']).ignore();
}

// Pure: what to order so the next two weeks don't run out: missed + sold − free stock, never below 0.
export const restock = ({ missed, sold, stock }) => Math.max(0, missed + sold - Math.max(0, stock));

const range = (q, col, from, to) => {
  q.where(col, '>=', from);
  if (to != null) q.where(col, '<', to);
  return q;
};

// Missed demand by product and size in [from, to), most missed first, with units sold in the same window, free stock
// now and the restock suggestion. scope(q, col) narrows to the caller's stores.
export async function demandItems(db, scope, { from, to = null, limit = 200 }) {
  const missed = await range(scope(db('missed_demand as m'), 'm.store_id'), 'm.created_at', dbTime(from), to && dbTime(to))
    .join('products as p', 'p.id', 'm.product_id').join('stores as st', 'st.id', 'm.store_id')
    .groupBy('m.product_id', 'm.size', 'p.name', 'p.name_ru', 'p.category', 'p.sku', 'm.store_id', 'st.name')
    .select('m.product_id', 'm.size', 'p.name', 'p.name_ru', 'p.category', 'p.sku', 'm.store_id', 'st.name as store_name')
    .count({ missed: '*' })
    .orderBy([{ column: 'missed', order: 'desc' }, { column: 'm.product_id' }, { column: 'm.size' }]).limit(limit);
  if (!missed.length) return [];
  const ids = [...new Set(missed.map((x) => x.product_id))];
  const sold = await range(db('order_items as i').join('orders as o', 'o.id', 'i.order_id'), 'o.paid_at', iso(from), to && iso(to))
    .whereIn('i.product_id', ids).where('o.payment_status', 'paid').whereNot('o.status', 'cancelled')
    .groupBy('i.product_id', 'i.size').select('i.product_id', 'i.size').sum({ units: 'i.quantity' });
  const stock = await db('product_stock').whereIn('product_id', ids).select('product_id', 'size', db.raw('quantity - reserved as free'));
  const key = (x) => `${x.product_id}:${x.size}`;
  const soldBy = new Map(sold.map((x) => [key(x), Number(x.units)]));
  const stockBy = new Map(stock.map((x) => [key(x), Number(x.free)]));
  return missed.map((x) => {
    const row = { ...x, missed: Number(x.missed), sold: soldBy.get(key(x)) ?? 0, stock: stockBy.get(key(x)) ?? 0 };
    return { ...row, suggest: restock(row) };
  });
}

// Funnel drop-off: a visit counts at every step up to the furthest one it reached (a refresh mid-way starts a new visit
// that may lack the early steps). Per Tashkent day (`keys`, zero-filled; the visit's first event decides the day) and
// per kiosk (short id; null = phone).
// shortcut: aggregates in JS over the raw events, like /stats; move to SQL if a period holds ~100k events.
export async function funnelStats(db, scope, { from, to = null, keys = [] }) {
  const rows = await range(scope(db('funnel_events'), 'store_id'), 'created_at', dbTime(from), to && dbTime(to))
    .orderBy('id').select('visit', 'step', 'device', 'store_id', 'created_at');
  const visits = new Map();
  for (const r of rows) {
    const v = visits.get(r.visit) ?? { day: dayKey(msOf(r.created_at)), store_id: r.store_id, device: null, reach: -1 };
    v.reach = Math.max(v.reach, FUNNEL_STEPS.indexOf(r.step));
    v.device ??= r.device;
    visits.set(r.visit, v);
  }
  const zero = () => Object.fromEntries(FUNNEL_STEPS.map((s) => [s, 0]));
  const add = (o, reach) => FUNNEL_STEPS.forEach((s, i) => { if (i <= reach) o[s]++; });
  const total = zero(), perDay = new Map(keys.map((k) => [k, zero()])), perKiosk = new Map();
  for (const v of visits.values()) {
    add(total, v.reach);
    if (perDay.has(v.day)) add(perDay.get(v.day), v.reach);
    const k = `${v.store_id}:${v.device ?? ''}`;
    if (!perKiosk.has(k)) perKiosk.set(k, { store_id: v.store_id, kiosk: v.device ? v.device.slice(0, 6) : null, ...zero() });
    add(perKiosk.get(k), v.reach);
  }
  return {
    total,
    per_day: keys.map((day) => ({ day, ...perDay.get(day) })),
    per_kiosk: [...perKiosk.values()].sort((a, b) => b.start - a.start || a.store_id - b.store_id),
  };
}

// Public: POST /api/funnel { store_id, visit, step, device? } → 204, once per visit and step. Rate-limited in app.js.
export function createFunnelRouter(db) {
  const r = express.Router();
  r.post('/', async (req, res) => {
    const { store_id, visit, step, device } = req.body ?? {};
    if (typeof visit !== 'string' || !ID.test(visit) || !FUNNEL_STEPS.includes(step)) throw fail(400, 'err.bad_request');
    if (!Number.isInteger(store_id) || store_id < 1 || !(await db('stores').where({ id: store_id }).first('id'))) throw fail(404, 'err.store_not_found');
    // Only a kiosk this store has heard a heartbeat from counts as one; anything else is a phone.
    const known = typeof device === 'string' && DEVICE.test(device) && (await db('kiosks').where({ store_id, device }).first('id'));
    await db('funnel_events').insert({ store_id, visit, step, device: known ? device : null }).onConflict(['visit', 'step']).ignore();
    res.status(204).end();
  });
  return r;
}
