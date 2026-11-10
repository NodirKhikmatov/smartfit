// Task 24: missed demand (wanted, but 0 free stock), the customer funnel by step, and the restock suggestion.
// Neither log holds personal data: a random session/visit id, product, size, store, kiosk id and time only.
import express from 'express';
import { fail, dayKey, msOf } from './admin/routes.js';
import { dbTime } from './recommend/routes.js';
import { METHODS } from './size/size.js';

export const FUNNEL_STEPS = ['start', 'size', 'outfits', 'cart', 'order'];
const ID = /^[a-f0-9]{32}$/;
const DEVICE = /^[a-f0-9]{16,32}$/; // the kiosk heartbeat id (kiosk.js)
const iso = (ms) => new Date(ms).toISOString(); // paid_at is written as an ISO string (cart.js)

// Once per session (the results screen's rec token, or the cart token) per product and size; a re-query adds nothing.
// mode (task 30): outfit | single for the results screen, null where it isn't known (cart, catalogue).
export async function logMissed(db, { storeId, session, items, source, mode = null }) {
  if (!items.length || typeof session !== 'string' || !ID.test(session)) return;
  await db('missed_demand').insert(items.map((i) => ({ store_id: storeId, product_id: i.product_id, size: i.size, session, source, mode })))
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
// Task 31: `waiting` = customers with an open "Kelganda xabar bering" request for that size (any age, so a size with
// only old requests is listed too). Each request comes from a sold-out view that was also logged as missed, so the
// suggestion counts the larger of the two, not their sum.
// Task 36: the shop's category name comes along (category_name / _ru) for the Talab page.
const KEYS = ['product_id', 'size', 'p.name', 'p.name_ru', 'p.category', 'c.name', 'c.name_ru', 'p.sku', 'store_id', 'st.name'];
const named = (q, t) => q.join('products as p', 'p.id', `${t}.product_id`).join('stores as st', 'st.id', `${t}.store_id`)
  .leftJoin('categories as c', 'c.id', 'p.category_id')
  .groupBy(KEYS.map((k) => (k.includes('.') ? k : `${t}.${k}`)))
  .select(`${t}.product_id`, `${t}.size`, 'p.name', 'p.name_ru', 'p.category', 'c.name as category_name', 'c.name_ru as category_name_ru', 'p.sku', `${t}.store_id`, 'st.name as store_name');
export async function demandItems(db, scope, { from, to = null, limit = 200, waiting: withWaiting = true }) {
  const missed = await named(range(scope(db('missed_demand as m'), 'm.store_id'), 'm.created_at', dbTime(from), to && dbTime(to)), 'm')
    .count({ missed: '*' })
    .orderBy([{ column: 'missed', order: 'desc' }, { column: 'm.product_id' }, { column: 'm.size' }]).limit(limit);
  const waiting = withWaiting ? await named(scope(db('stock_alerts as a'), 'a.store_id').whereNull('a.notified_at'), 'a').count({ waiting: '*' }) : [];
  const key = (x) => `${x.product_id}:${x.size}`;
  const waitBy = new Map(waiting.map((x) => [key(x), Number(x.waiting)]));
  const listed = new Set(missed.map(key));
  const all = [...missed, ...waiting.filter((x) => !listed.has(key(x))).map(({ waiting: _, ...x }) => ({ ...x, missed: 0 }))];
  if (!all.length) return [];
  const ids = [...new Set(all.map((x) => x.product_id))];
  const sold = await range(db('order_items as i').join('orders as o', 'o.id', 'i.order_id'), 'o.paid_at', iso(from), to && iso(to))
    .whereIn('i.product_id', ids).where('o.payment_status', 'paid').whereNot('o.status', 'cancelled')
    .groupBy('i.product_id', 'i.size').select('i.product_id', 'i.size').sum({ units: 'i.quantity' });
  const stock = await db('product_stock').whereIn('product_id', ids).select('product_id', 'size', db.raw('quantity - reserved as free'));
  const soldBy = new Map(sold.map((x) => [key(x), Number(x.units)]));
  const stockBy = new Map(stock.map((x) => [key(x), Number(x.free)]));
  const rows = all.map((x) => {
    const row = { ...x, missed: Number(x.missed), waiting: waitBy.get(key(x)) ?? 0, sold: soldBy.get(key(x)) ?? 0, stock: stockBy.get(key(x)) ?? 0 };
    return { ...row, suggest: restock({ ...row, missed: Math.max(row.missed, row.waiting) }) };
  });
  const need = (x) => Math.max(x.missed, x.waiting);
  return rows.sort((a, b) => need(b) - need(a) || a.product_id - b.product_id || (a.size < b.size ? -1 : a.size > b.size ? 1 : 0)).slice(0, limit);
}

// Funnel drop-off: a visit counts at every step up to the furthest one it reached (a refresh mid-way starts a new visit
// that may lack the early steps). Per Tashkent day (`keys`, zero-filled; the visit's first event decides the day) and
// per kiosk (short id; null = phone) and (task 30) per mode: the visit's first logged mode, outfit or single; a visit
// that never chose (left at the start) is in neither row.
// shortcut: aggregates in JS over the raw events, like /stats; move to SQL if a period holds ~100k events.
export async function funnelStats(db, scope, { from, to = null, keys = [] }) {
  const rows = await range(scope(db('funnel_events'), 'store_id'), 'created_at', dbTime(from), to && dbTime(to))
    .orderBy('id').select('visit', 'step', 'device', 'store_id', 'mode', 'created_at');
  const visits = new Map();
  for (const r of rows) {
    const v = visits.get(r.visit) ?? { day: dayKey(msOf(r.created_at)), store_id: r.store_id, device: null, mode: null, reach: -1 };
    v.reach = Math.max(v.reach, FUNNEL_STEPS.indexOf(r.step));
    v.device ??= r.device;
    v.mode ??= r.mode;
    visits.set(r.visit, v);
  }
  const zero = () => Object.fromEntries(FUNNEL_STEPS.map((s) => [s, 0]));
  const add = (o, reach) => FUNNEL_STEPS.forEach((s, i) => { if (i <= reach) o[s]++; });
  const total = zero(), perDay = new Map(keys.map((k) => [k, zero()])), perKiosk = new Map();
  const perMode = Object.fromEntries(MODES.map((m) => [m, zero()]));
  for (const v of visits.values()) {
    add(total, v.reach);
    if (perMode[v.mode]) add(perMode[v.mode], v.reach);
    if (perDay.has(v.day)) add(perDay.get(v.day), v.reach);
    const k = `${v.store_id}:${v.device ?? ''}`;
    if (!perKiosk.has(k)) perKiosk.set(k, { store_id: v.store_id, kiosk: v.device ? v.device.slice(0, 6) : null, ...zero() });
    add(perKiosk.get(k), v.reach);
  }
  return {
    total,
    per_day: keys.map((day) => ({ day, ...perDay.get(day) })),
    per_kiosk: [...perKiosk.values()].sort((a, b) => b.start - a.start || a.store_id - b.store_id),
    per_mode: MODES.map((mode) => ({ mode, ...perMode[mode] })),
  };
}

// Task 29: how customers found their size (results screens per method) and the task 23 "how did it fit?" answers of the
// orders made from those screens, so the pilot can see which way is accurate. Methods are zero-filled; null = not told.
export async function methodStats(db, scope, { from, to = null }) {
  const shown = await range(scope(db('recommendation_logs'), 'store_id'), 'created_at', dbTime(from), to && dbTime(to))
    .groupBy('size_method').select('size_method').count({ n: '*' });
  const fits = await range(scope(db('recommendation_logs as r'), 'r.store_id'), 'r.created_at', dbTime(from), to && dbTime(to))
    .join('orders as o', 'o.recommendation_id', 'r.id').join('order_items as i', 'i.order_id', 'o.id').whereNotNull('i.fit')
    .groupBy('r.size_method', 'i.fit').select('r.size_method', 'i.fit').count({ n: '*' });
  return METHODS.map((method) => {
    const row = { method, customers: Number(shown.find((x) => x.size_method === method)?.n ?? 0), small: 0, right: 0, big: 0 };
    for (const f of fits) if (f.size_method === method && ['small', 'right', 'big'].includes(f.fit)) row[f.fit] = Number(f.n);
    const answers = row.small + row.right + row.big;
    return { ...row, answers, accuracy: answers ? Math.round((row.right / answers) * 100) : null };
  });
}

// Public: POST /api/funnel { store_id, visit, step, device?, mode? } → 204, once per visit and step. Rate-limited in app.js.
// mode (task 30): outfit | single, once the customer has chosen.
export const MODES = ['outfit', 'single'];
export function createFunnelRouter(db) {
  const r = express.Router();
  r.post('/', async (req, res) => {
    const { store_id, visit, step, device, mode = null } = req.body ?? {};
    if (typeof visit !== 'string' || !ID.test(visit) || !FUNNEL_STEPS.includes(step) || (mode !== null && !MODES.includes(mode))) throw fail(400, 'err.bad_request');
    if (!Number.isInteger(store_id) || store_id < 1 || !(await db('stores').where({ id: store_id }).first('id'))) throw fail(404, 'err.store_not_found');
    // Only a kiosk this store has heard a heartbeat from counts as one; anything else is a phone.
    const known = typeof device === 'string' && DEVICE.test(device) && (await db('kiosks').where({ store_id, device }).first('id'));
    await db('funnel_events').insert({ store_id, visit, step, device: known ? device : null, mode }).onConflict(['visit', 'step']).ignore();
    res.status(204).end();
  });
  return r;
}
