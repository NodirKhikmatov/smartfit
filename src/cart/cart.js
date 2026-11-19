// Task 8: server-side cart, 15-minute stock holds, orders, cashier payment.
// A hold is product_stock.reserved. Every change to it is a conditional UPDATE (never read-then-write),
// so two buyers can't both take the last unit, on SQLite and on Postgres alike.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { fail } from '../admin/routes.js';
import { sizesOf } from '../db/seed.js';
import { unitPrice } from '../recommend/engine.js';
import { REC } from '../recommend/routes.js';
import { qrSvg, publicBase } from '../qr.js';
import { clientKey } from '../limits.js';
import { FITS } from '../size/size.js';
import { logMissed } from '../demand.js';
import { price, findPromo, promoProblem, claimPromo, releasePromo, setKey, parseJson, spread } from './promo.js';
import { fmt } from '../../public/shared/i18n.js';
import { pointsConfig, balanceOf, maxSpend, checkSpend, spend, refundSpent, earnPoints } from './points.js';
import { termsOf, plan, monthly } from './instalment.js';
import { allows, shopOpen } from '../plans.js';
import { orderLines } from '../reviews.js';
import { moved } from '../movements.js';

export const HOLD_MS = 15 * 60 * 1000;
export const HANDOFF_MS = 5 * 60 * 1000; // how long the kiosk's "continue on your phone" QR works
const MAX_UNITS = 20; // per cart; open carts per client are capped by maxOpenCarts (task 21)
const DELIVERY_RADIUS_KM = 30; // "within the city" = the map pin is this close to the store
export const TOKEN = /^[a-f0-9]{32}$/;
export const iso = (ms) => new Date(ms).toISOString(); // ISO strings compare correctly in SQLite text and Postgres timestamptz

// Payment methods offered at checkout. Each returns what the client needs; online ones add a pay `url` (src/cart/payments.js).
export const CASHIER = { cashier: async () => ({ method: 'cashier' }) };

// Pickup is free. Delivery: the store's flat city fee, free when the goods amount is above the store's threshold (null = never free).
export function deliveryFee(store, subtotal, fulfillment) {
  if (fulfillment !== 'delivery') return 0;
  return store.free_delivery_threshold != null && subtotal > store.free_delivery_threshold ? 0 : store.delivery_fee;
}
// discount (task 26) = bundle + promo; the free-delivery threshold looks at what the customer pays for the goods.
// points (task 34) pay part of the goods after that; they don't change the delivery fee and never pay it.
export const totals = (store, subtotal, fulfillment, discount = 0, points = 0) => {
  const delivery_fee = deliveryFee(store, subtotal - discount, fulfillment);
  return { subtotal, delivery_fee, total: subtotal - discount - points + delivery_fee };
};

// Takes n units of free stock; false when fewer than n are free.
export const hold = async (trx, productId, size, n) =>
  (await trx('product_stock').where({ product_id: productId, size }).whereRaw('quantity - reserved >= ?', [n]).increment('reserved', n)) === 1;
// Clamped at 0 so one inconsistent row (e.g. a hand-edited DB) can't make the sweep, and with it every cart request, fail.
export const release = (trx, lines) =>
  Promise.all(lines.map((l) => trx('product_stock').where({ product_id: l.product_id, size: l.size })
    .update({ reserved: trx.raw('case when reserved >= ? then reserved - ? else 0 end', [l.quantity, l.quantity]) })));

// Task 38: extends every live store cart of one mall cart, so all its shops' holds run out at the same moment.
// One UPDATE over the whole group locks its rows in one go (the same order for every caller, so no deadlock on Postgres).
export const extendGroup = (trx, mallToken, now = Date.now()) =>
  trx('carts').where({ mall_token: mallToken }).where('expires_at', '>', iso(now)).update({ expires_at: iso(now + HOLD_MS), updated_at: trx.fn.now() });

// Extends a live cart's hold and returns it. The UPDATE also locks the row against a concurrent expiry sweep.
export async function lockCart(trx, token, now = Date.now()) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const { mall_token: mallToken } = (await trx('carts').where({ token }).first('mall_token')) ?? {};
  if (mallToken) await extendGroup(trx, mallToken, now);
  const n = await trx('carts').where({ token }).where('expires_at', '>', iso(now)).update({ expires_at: iso(now + HOLD_MS), updated_at: trx.fn.now() });
  return n ? trx('carts').where({ token }).first() : null;
}
async function liveCart(trx, token) {
  const cart = await lockCart(trx, token);
  if (!cart) throw fail(404, 'err.cart_not_found');
  return cart;
}

// Releases holds of expired carts and unpaid orders. Runs lazily on cart/order requests and every minute from server.js.
export async function releaseExpired(db, now = Date.now()) {
  const at = iso(now);
  for (const id of await db('carts').where('expires_at', '<=', at).pluck('id')) {
    await db.transaction(async (trx) => {
      if (!(await trx('carts').where({ id }).where('expires_at', '<=', at).update({ updated_at: trx.fn.now() }))) return; // extended meanwhile
      await release(trx, await trx('cart_items').where({ cart_id: id }));
      await trx('carts').where({ id }).del();
    });
  }
  for (const id of await db('orders').where({ payment_status: 'pending' }).where('expires_at', '<=', at).pluck('id')) {
    await db.transaction((trx) => cancelPending(trx, id, now, { expiredOnly: true }));
  }
}

// Unpaid order → cancelled: its holds come back and any open Click/Payme transaction ends with it (Payme reason 4).
// False when it wasn't pending (or, with expiredOnly, hadn't expired yet).
export async function cancelPending(trx, orderId, now = Date.now(), { expiredOnly = false } = {}) {
  let q = trx('orders').where({ id: orderId, payment_status: 'pending' });
  if (expiredOnly) q = q.where('expires_at', '<=', iso(now));
  if (!(await q.update({ payment_status: 'cancelled', status: 'cancelled', expires_at: null, updated_at: trx.fn.now() }))) return false;
  await release(trx, await trx('order_items').where({ order_id: orderId }));
  await releasePromo(trx, orderId);
  await refundSpent(trx, orderId);
  await trx('payment_transactions').where({ order_id: orderId, state: 1 }).update({ state: -1, reason: 4, cancel_time: now });
  return true;
}

// A paid order is cancelled before it left the store: its stock returns to the shelf. The status UPDATE claims the
// order, so the stock comes back exactly once. payment_status stays 'paid' until the money is refunded.
async function cancelPaid(trx, orderId) {
  const n = await trx('orders').where({ id: orderId, payment_status: 'paid' }).whereIn('status', ['new', 'packing'])
    .update({ status: 'cancelled', cancelled_at: iso(Date.now()), updated_at: trx.fn.now() }); // task 51: the refund's day
  if (!n) return false;
  for (const i of await trx('order_items').where({ order_id: orderId })) {
    await trx('product_stock').where({ product_id: i.product_id, size: i.size }).increment('quantity', i.quantity);
    await moved(trx, { productId: i.product_id, size: i.size, delta: i.quantity, reason: 'cancel', ref: { order_id: orderId } });
  }
  await releasePromo(trx, orderId);
  await refundSpent(trx, orderId);
  return true;
}

// The provider took the money back (Payme cancel after perform). Works whether or not a manager already cancelled
// the order (then the stock is already back); refused once the order has left the store (shipping/delivered).
export async function refundPaid(trx, orderId) {
  await cancelPaid(trx, orderId);
  return (await trx('orders').where({ id: orderId, payment_status: 'paid', status: 'cancelled' })
    .update({ payment_status: 'cancelled', updated_at: trx.fn.now() })) === 1;
}

// Order flow: new → packing → shipping → delivered, or cancelled. Pickup goes packing → delivered (handed over).
// Work starts only after payment; an unpaid order can only be cancelled. Nothing leaves shipping except delivered.
export function nextStatuses(o) {
  if (o.payment_status === 'pending') return o.status === 'new' ? ['cancelled'] : [];
  if (o.payment_status !== 'paid') return [];
  if (o.status === 'new') return ['packing', 'cancelled'];
  if (o.status === 'packing') return [o.fulfillment === 'delivery' ? 'shipping' : 'delivered', 'cancelled'];
  if (o.status === 'shipping') return ['delivered'];
  return [];
}

// Each step is a conditional UPDATE on the status read here, so two staff clicking at once can't both move it.
// Task 50: `who` = the team member making the step; the one who hands it over becomes its seller if it has none yet.
export function changeStatus(db, orderId, to, who = null) {
  return db.transaction(async (trx) => {
    const o = await trx('orders').where({ id: orderId }).first();
    if (!nextStatuses(o).includes(to)) return false;
    if (to === 'cancelled') return o.payment_status === 'pending' ? cancelPending(trx, o.id) : cancelPaid(trx, o.id);
    if (!(await trx('orders').where({ id: o.id, status: o.status, payment_status: 'paid' }).update({ status: to, updated_at: trx.fn.now() }))) return false;
    if (to === 'delivered') {
      await earnPoints(trx, o.id); // task 34: only the step that moved it here earns
      await setSeller(trx, o.id, who);
    }
    return true;
  });
}

// Paid → stock leaves the shelf: quantity and reserved both drop. Only a pending, unexpired order can be paid, exactly once.
// The Click/Payme callbacks call it inside their own transaction (knex nests it as a savepoint).
// Task 49: the sale copies each product's cost price onto its order line, so a later change never rewrites old reports.
export const freezeCost = (trx, orderId) => trx('order_items').where({ order_id: orderId })
  .update({ unit_cost: trx.raw('(select p.cost from products p where p.id = order_items.product_id)') });

// Task 50: an order's seller, set once and never overwritten. The one who served its fitting-room request (same store,
// same recommendation; who accepted it, else who closed it) comes first, then `who` (the cashier, or whoever hands it
// over). Only a team member of the order's organisation (owner, manager, staff) can be one: a super-admin never is.
// The percent in force now (personal, else the store's) is frozen on the order with it.
export const SELLER_ROLES = ['owner', 'manager', 'staff'];
export async function setSeller(trx, orderId, who = null, now = Date.now()) {
  const o = await trx('orders').where({ id: orderId }).first('store_id', 'recommendation_id', 'seller_id');
  if (o.seller_id != null) return;
  const fit = o.recommendation_id && await trx('fitting_requests').where({ store_id: o.store_id, recommendation_id: o.recommendation_id })
    .where((q) => q.whereNotNull('accepted_by').orWhereNotNull('done_by')).orderBy('id', 'desc').first('accepted_by', 'done_by');
  for (const id of [fit?.accepted_by, fit?.done_by, who]) {
    if (id == null) continue;
    const a = await trx('admins as a').join('stores as s', 's.organization_id', 'a.organization_id').where({ 'a.id': id, 's.id': o.store_id })
      .whereIn('a.role', SELLER_ROLES).first('a.commission_percent', 's.commission_percent as store_percent');
    if (!a) continue;
    await trx('orders').where({ id: orderId }).whereNull('seller_id').update({ seller_id: id, seller_at: iso(now), seller_percent: a.commission_percent ?? a.store_percent });
    return;
  }
}

// `who` = the team member taking the money at the cashier (Click/Payme pass none: an online order gets its seller at hand-over).
// Task 51: `paidWith` = how the cashier took it (cash | card | instalment); Click/Payme leave it null.
export async function markPaid(db, orderId, now = Date.now(), who = null, paidWith = null) {
  return db.transaction(async (trx) => {
    const n = await trx('orders').where({ id: orderId, payment_status: 'pending' }).where('expires_at', '>', iso(now))
      .update({ payment_status: 'paid', paid_at: iso(now), paid_with: paidWith, expires_at: null, updated_at: trx.fn.now() });
    if (!n) return false;
    await freezeCost(trx, orderId);
    if (who != null) await setSeller(trx, orderId, who, now);
    for (const i of await trx('order_items').where({ order_id: orderId })) {
      await trx('product_stock').where({ product_id: i.product_id, size: i.size })
        .update({ quantity: trx.raw('quantity - ?', [i.quantity]), reserved: trx.raw('reserved - ?', [i.quantity]) });
      await moved(trx, { productId: i.product_id, size: i.size, delta: -i.quantity, reason: 'sale', ref: { order_id: orderId } });
    }
    return true;
  });
}

// SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC, which Date would read as local time.
export const stamp = (v) => (v == null ? null : new Date(typeof v === 'string' && !v.includes('T') ? `${v.replace(' ', 'T')}Z` : v).toISOString());
const msLeft = (v) => (v == null ? null : Math.max(0, Date.parse(stamp(v)) - Date.now()));
export const storeOf = async (db, id) => planInstalments(db, await db('stores').where({ id }).first('id', 'organization_id', 'name', 'city', 'lat', 'lon', 'delivery_fee', 'free_delivery_threshold', 'bundle_percent', 'instalment_on', 'instalment_terms'));
// Task 45: instalments count as off (termsOf → null) when the organisation's plan lacks them; the shop's own switch stays as set.
export async function planInstalments(q, store) {
  if (store?.instalment_on && !(await allows(q, store.organization_id, 'instalments'))) store.instalment_on = false;
  return store;
}

// Task 26: the cart's discounts. → { ...price(), promo: { code, value, kind, error, sum } | null }. A promo that no longer
// applies (switched off, used up, under its minimum after a removal) stays on the cart with its error and takes nothing off.
async function pricing(q, cart, store, lines) {
  const p = cart.promo_code_id ? await q('promo_codes').where({ id: cart.promo_code_id }).first() : null;
  const problem = p && promoProblem(p);
  const r = price(lines, { bundles: parseJson(cart.bundles, []), bundlePercent: store.bundle_percent, promo: p && !problem ? p : null });
  const error = problem || (p && !r.minOk ? 'err.promo_min' : null);
  return { ...r, promo: p ? { ...p, error } : null }; // the whole row: checkout's claim needs its limits
}
const promoError = (pr) => fail(409, pr.promo.error, pr.promo.error === 'err.promo_min' ? { sum: fmt.num(pr.promo.min_order) } : {});

// Prices always come from the products table, never from the request.
export async function cartView(db, cart, payments) {
  const store = await storeOf(db, cart.store_id);
  const rows = await db('cart_items as c').join('products as p', 'p.id', 'c.product_id').leftJoin('categories as k', 'k.id', 'p.category_id')
    .where('c.cart_id', cart.id).orderBy('c.id')
    .select('c.id', 'c.product_id', 'c.size', 'c.quantity', 'p.name', 'p.name_ru', 'p.category', 'k.name as category_name', 'k.name_ru as category_name_ru', 'p.sizes as size_list', 'p.color', 'p.price', 'p.discount_price', 'p.image_url', 'p.shelf_location');
  const free = await db('product_stock').whereIn('product_id', rows.map((r) => r.product_id)).whereRaw('quantity - reserved > 0').select('product_id', 'size');
  const items = rows.map(({ size_list, ...r }) => ({
    ...r,
    unit_price: unitPrice(r),
    line_total: unitPrice(r) * r.quantity,
    sizes: sizesOf({ category: r.category, sizes: size_list }).filter((s) => s === r.size || free.some((f) => f.product_id === r.product_id && f.size === s)),
  }));
  const pr = await pricing(db, cart, store, items);
  const off = pr.subtotal - pr.goods;
  const points = await cartPoints(db, cart, store, pr.goods);
  // Task 35: with instalments on, every totals object carries each term's monthly amount for its own total.
  const terms = termsOf(store);
  const sums = (f, pts = 0) => {
    const t = totals(store, pr.subtotal, f, off, pts);
    const instalments = plan(terms, t.total);
    return instalments ? { ...t, instalments } : t;
  };
  const withPoints = (f) => sums(f, points?.max ?? 0);
  return {
    token: cart.token,
    store_id: store.id,
    expires_at: stamp(cart.expires_at),
    hold_ms: msLeft(cart.expires_at), // the countdown runs from this, so a wrong kiosk clock doesn't matter
    items,
    payments,
    delivery: { city: store.city, lat: store.lat, lon: store.lon, fee: store.delivery_fee, free_over: store.free_delivery_threshold },
    discounts: { bundle: pr.bundle_discount, bundle_percent: store.bundle_percent, promo: pr.promo_discount, code: pr.promo && { code: pr.promo.code, error: pr.promo.error, min_order: pr.promo.min_order } },
    totals: { pickup: sums('pickup'), delivery: sums('delivery') },
    // Task 34: null when points are off in this organisation. linked = a profile confirmed "use my points" for this cart;
    // max = what checkout accepts as `points` now, and totals = the totals when that much is used.
    ...(points && { points: { ...points, totals: { pickup: withPoints('pickup'), delivery: withPoints('delivery') } } }),
  };
}

async function cartPoints(q, cart, store, goods) {
  const cfg = await pointsConfig(q, store.id);
  if (!cfg) return null;
  const linked = cart.profile_id ? Boolean(await q('customer_profiles').where({ id: cart.profile_id, organization_id: cfg.orgId }).first('id')) : false;
  const balance = linked ? await balanceOf(q, cart.profile_id) : 0;
  return { percent: cfg.percent, share: cfg.share, linked, balance, max: linked ? maxSpend(goods, balance, cfg.share) : 0 };
}

export async function orderView(db, order) {
  const items = await db('order_items as i').join('products as p', 'p.id', 'i.product_id').where('i.order_id', order.id).orderBy('i.id')
    .select('i.id', 'i.product_id', 'p.name', 'p.name_ru', 'p.category', 'p.sizes', 'p.color', 'p.shelf_location', 'i.size', 'i.quantity', 'i.unit_price', 'i.discount', 'i.returned', 'i.fit');
  const { id, number, store_id, customer_name, phone, fulfillment, address, lat, lon, status, payment_status, payment_method, subtotal, delivery_fee, total, promo_code, promo_discount, bundle_discount, points_discount,
    instalment_months, instalment_percent, instalment_monthly, group_number, paid_with } = order;
  return {
    id, number, store_id, customer_name, phone, fulfillment, address, lat, lon, status, payment_status, payment_method, paid_with: paid_with ?? null, subtotal, delivery_fee, total,
    promo_code, promo_discount, bundle_discount, points_discount, instalment_months, instalment_percent, instalment_monthly,
    group_number: group_number ?? null, // task 38: the mall order this shop's order is part of
    expires_at: stamp(order.expires_at), paid_at: stamp(order.paid_at), created_at: stamp(order.created_at), items,
  };
}

const km = (a, b) => {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const text = (v, min, max, label) => {
  if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) throw fail(400, 'err.invalid', { field: label });
  return v.trim();
};

// Uzbek mobile: 9 digits, optionally with 998 in front → +998XXXXXXXXX.
export function normalizePhone(v) {
  const d = typeof v === 'string' ? v.replace(/[\s()+-]/g, '') : '';
  const full = /^\d{9}$/.test(d) ? '998' + d : d;
  if (!/^998\d{9}$/.test(full)) throw fail(400, 'err.phone');
  return '+' + full;
}

export function customer(b, store) {
  if (!['pickup', 'delivery'].includes(b.fulfillment)) throw fail(400, 'err.fulfillment');
  const c = { customer_name: text(b.name, 2, 80, 'field.customer_name'), phone: normalizePhone(b.phone), fulfillment: b.fulfillment, address: null, lat: null, lon: null };
  if (c.fulfillment === 'pickup') return c;
  c.address = text(b.address, 5, 200, 'field.address');
  if (b.lat != null || b.lon != null) {
    const ok = (v, lim) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
    if (!ok(b.lat, 90) || !ok(b.lon, 180)) throw fail(400, 'err.invalid', { field: 'field.map_point' });
    if (km(store, { lat: b.lat, lon: b.lon }) > DELIVERY_RADIUS_KM) throw fail(422, 'err.delivery_city', { city: store.city });
    Object.assign(c, { lat: b.lat, lon: b.lon });
  }
  return c;
}

export function parseItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 10) throw fail(400, 'err.invalid', { field: 'field.items' });
  return items.map((i) => {
    if (!Number.isInteger(i?.product_id) || i.product_id < 1 || typeof i.size !== 'string') throw fail(400, 'err.item_missing');
    return { product_id: i.product_id, size: i.size };
  });
}

// One order from lines priced from the DB ({ product_id, size, quantity, unit_price, discount? }); the caller already holds
// their stock. pr (task 26) = price() of these lines and the claimed promo row, or nothing (no discounts).
// points (task 34) = so'm of points spent and the profile they come from; split over the lines after the discounts.
// Per-store display number: the UPDATE locks the store row, so parallel orders get 1, 2, 3… with no gaps or repeats.
export async function insertOrder(trx, store, c, lines, { method = 'cashier', notifyToken, recommendationId = null, holdMs = HOLD_MS, client = null, pr = null, promo = null, points = 0, profileId = null, instalment = null, group = {} }) {
  await shopOpen(trx, store.id); // task 45: a read-only shop takes no order (every order of every route is made here)
  const subtotal = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0);
  const d = pr ? { bundle_discount: pr.bundle_discount, promo_discount: pr.promo_discount, promo_code_id: promo?.id ?? null, promo_code: promo?.code ?? null } : {};
  const off = lines.map((l, i) => pr?.discounts[i] ?? 0);
  const pts = spread(lines.map((l, i) => l.unit_price * l.quantity - off[i]), points);
  const t = totals(store, subtotal, c.fulfillment, (d.bundle_discount ?? 0) + (d.promo_discount ?? 0), points);
  // Task 35: the chosen term as it is now; the monthly amount is a shown figure, total stays the price paid.
  const inst = instalment ? { instalment_months: instalment.months, instalment_percent: instalment.percent, instalment_monthly: monthly(t.total, instalment.months, instalment.percent) } : {};
  await trx('stores').where({ id: store.id }).increment('order_seq', 1);
  const { order_seq: number } = await trx('stores').where({ id: store.id }).first('order_seq');
  const [{ id }] = await trx('orders').insert({ store_id: store.id, number, ...c, ...t, ...d, ...inst, points_discount: points, profile_id: profileId, payment_method: method, notify_token: notifyToken, recommendation_id: recommendationId, client, ...group, expires_at: iso(Date.now() + holdMs) }).returning('id');
  // discount = everything taken off the line (points too), so a return refunds the money paid; points = the points part.
  await trx('order_items').insert(lines.map((l, i) => ({ order_id: id, product_id: l.product_id, size: l.size, quantity: l.quantity, unit_price: l.unit_price, discount: off[i] + pts[i], points: pts[i] })));
  return id;
}

// A 409 carrying `missed` (task 24) is logged as missed demand after its transaction rolled back, then rethrown.
export const missedThen = (db) => async (err) => {
  if (err.missed) await logMissed(db, { ...err.missed, source: 'cart' }).catch((e) => console.error('missed demand not logged:', e.message));
  throw err;
};

// A new store cart. Inventory DoS guard (X2): one client can't hold stock in more than maxOpenCarts live carts
// (0 = no check); task 38: a mall cart counts once however many shops it spans. `extra` = { mall_token, mall_id }.
export async function openCart(trx, req, storeId, maxOpenCarts, extra = {}) {
  const client = clientKey(req.ip);
  if (maxOpenCarts) {
    const [{ n }] = await trx('carts').where({ client }).where('expires_at', '>', iso(Date.now())).select(trx.raw('count(distinct coalesce(mall_token, token)) as n'));
    if (Number(n) >= maxOpenCarts) throw fail(429, 'err.too_many_carts');
  }
  const token = randomBytes(16).toString('hex');
  await trx('carts').insert({ store_id: storeId, token, client, ...extra, expires_at: iso(Date.now() + HOLD_MS) });
  return trx('carts').where({ token }).first();
}

// Adds parsed items to a locked cart, all or nothing (the caller's transaction rolls back on a throw).
// b.rec / b.outfit (task 26): the results screen the items came from and the outfit card's product ids.
export async function addLines(trx, cart, items, b) {
  await shopOpen(trx, cart.store_id); // task 45: nor holds stock for one (store cart, mall cart)
  const [{ n }] = await trx('cart_items').where({ cart_id: cart.id }).sum({ n: 'quantity' });
  if (Number(n ?? 0) + items.length > MAX_UNITS) throw fail(409, 'err.cart_full', { max: MAX_UNITS });
  for (const { product_id, size } of items) {
    const p = await trx('products').where({ id: product_id, store_id: cart.store_id }).first('name', 'name_ru', 'category', 'sizes');
    if (!p) throw fail(404, 'err.product_not_found');
    if (!sizesOf(p).includes(size)) throw fail(400, 'err.product_size', { product: p });
    if (!(await hold(trx, product_id, size, 1))) {
      // Task 24: logged after the rollback (missedThen) as missed demand, once per results screen or cart.
      throw Object.assign(fail(409, 'err.out_of_stock', { product: p, size: size === 'ONE' ? 'common.size_one' : size }),
        { item: { product_id, size }, // task 31: the app offers "Kelganda xabar bering" for this size
          missed: { storeId: cart.store_id, session: typeof b.rec === 'string' && REC.test(b.rec) ? b.rec : cart.token, items: [{ product_id, size }] } });
    }
    await trx('cart_items').insert({ cart_id: cart.id, product_id, size, quantity: 1 })
      .onConflict(['cart_id', 'product_id', 'size']).merge({ quantity: trx.raw('?? + 1', ['cart_items.quantity']) });
  }
  // Pilot funnel: added from a results screen (`rec`) → that suggestion was accepted; the order inherits it.
  const rec = typeof b.rec === 'string' && REC.test(b.rec) ? await trx('recommendation_logs').where({ token: b.rec, store_id: cart.store_id }).first('id', 'accepted_at', 'outfits') : null;
  if (rec) {
    if (!rec.accepted_at) await trx('recommendation_logs').where({ id: rec.id }).update({ accepted_at: iso(Date.now()) });
    await trx('carts').where({ id: cart.id }).update({ recommendation_id: rec.id });
    const shown = parseJson(rec.outfits, []);
    const key = Array.isArray(b.outfit) && b.outfit.length <= 6 && b.outfit.every((x) => Number.isInteger(x)) ? setKey(b.outfit) : null;
    const bundles = parseJson((await trx('carts').where({ id: cart.id }).first('bundles')).bundles, []);
    if (key && shown.some((o) => setKey(o) === key) && !bundles.some((o) => setKey(o) === key) && bundles.length < MAX_UNITS) {
      await trx('carts').where({ id: cart.id }).update({ bundles: JSON.stringify([...bundles, [...b.outfit].sort((x, y) => x - y)]) });
    }
  }
  return trx('carts').where({ id: cart.id }).first(); // fresh: the view prices with the bundles just saved
}

// Checkout options from the body, checked before any transaction: { method, want (so'm of points), months (term or null) }.
export function checkoutInput(b, methods) {
  const method = b.payment ?? 'cashier';
  if (typeof method !== 'string' || !Object.hasOwn(methods, method)) throw fail(400, 'err.invalid', { field: 'field.payment' });
  const want = b.points ?? 0;
  if (!Number.isInteger(want) || want < 0 || want > 1e9) throw fail(400, 'err.invalid', { field: 'field.points' });
  // Task 35: instalment = the term in months; only at the cashier (the store's Nasiya terminal), never online.
  const months = b.instalment ?? null;
  if (months !== null && (!Number.isInteger(months) || method !== 'cashier')) throw fail(400, 'err.invalid', { field: 'field.instalment' });
  return { method, want, months };
}

// A locked cart → one order, inside the caller's transaction (task 38: the mall checkout calls it once per shop, with
// `group` = { group_id, group_number }). The cart's holds move to the order; it gets a fresh 15 minutes to pay.
export async function placeOrder(trx, cart, b, { method, want, months }, notifyToken, group = {}) {
  const store = await storeOf(trx, cart.store_id);
  const c = customer(b, store);
  const lines = await trx('cart_items as c').join('products as p', 'p.id', 'c.product_id').where('c.cart_id', cart.id)
    .orderBy('c.id').select('c.product_id', 'c.size', 'c.quantity', 'p.price', 'p.discount_price');
  if (!lines.length) throw fail(400, 'err.cart_empty');
  const priced = lines.map((l) => ({ ...l, unit_price: unitPrice(l) }));
  const pr = await pricing(trx, cart, store, priced);
  if (pr.promo?.error) throw promoError(pr);
  if (pr.promo) await claimPromo(trx, pr.promo, c.phone);
  const cfg = await pointsConfig(trx, store.id);
  if (want) await checkSpend(trx, cfg, cart.profile_id, pr.goods, want);
  const owed = totals(store, pr.subtotal, c.fulfillment, pr.subtotal - pr.goods, want).total;
  // Payme/Click can't take 0 so'm: a fully discounted order is settled at the cashier.
  if (method !== 'cashier' && owed < 1) throw fail(400, 'err.invalid', { field: 'field.payment' });
  // A term the store doesn't offer (or instalments off, or nothing left to pay) is refused, never silently dropped.
  const instalment = months === null ? null : termsOf(store)?.find((x) => x.months === months);
  if (months !== null && (!instalment || owed < 1)) throw fail(409, 'err.instalment_term');
  const profileId = cfg && cart.profile_id ? cart.profile_id : null; // earns on hand-over even when no points were spent
  const id = await insertOrder(trx, store, c, priced, { method, notifyToken, recommendationId: cart.recommendation_id, pr, promo: pr.promo, points: want, profileId, instalment, group });
  if (want) await spend(trx, cfg, cart.profile_id, id, want);
  await trx('carts').where({ id: cart.id }).del(); // reserved stays: the order owns the hold now
  return id;
}

// Public, keyed by an unguessable cart token. The token is the customer's only handle on the cart.
// `link(notifyToken)` → how the customer subscribes to order messages ({ url, svg } for Telegram), or null when off.
export function createCartRouter(db, { methods = CASHIER, link = () => null, maxOpenCarts = 0, promoLimit = (req, res, next) => next() } = {}) {
  const r = express.Router();
  const view = (cart) => cartView(db, cart, Object.keys(methods));
  r.use(async (req, res, next) => {
    await releaseExpired(db);
    next();
  });

  // { token?, store_id, items: [{ product_id, size }], rec?, outfit? }: one item or a whole outfit, all or nothing.
  // A missing or expired token opens a new cart. outfit (task 26) = every product id of the outfit card the items came
  // from; when that set is one the results screen `rec` really showed, the cart remembers it for the bundle discount.
  r.post('/items', async (req, res) => {
    const b = req.body ?? {};
    const items = parseItems(b.items);
    const cart = await db.transaction(async (trx) => {
      let cart = await lockCart(trx, b.token);
      if (cart && Number.isInteger(b.store_id) && cart.store_id !== b.store_id) cart = null; // phone scanned another store's QR
      if (!cart) {
        if (!Number.isInteger(b.store_id) || !(await trx('stores').where({ id: b.store_id }).first('id'))) throw fail(404, 'err.store_not_found');
        cart = await openCart(trx, req, b.store_id, maxOpenCarts);
      }
      return addLines(trx, cart, items, b);
    }).catch(missedThen(db));
    res.json(await view(cart));
  });

  r.get('/:token', async (req, res) => {
    const cart = TOKEN.test(req.params.token) ? await db('carts').where({ token: req.params.token }).first() : null;
    if (!cart) throw fail(404, 'err.cart_not_found');
    res.json(await view(cart));
  });

  // Change size: hold the new size first, then release the old one.
  r.patch('/:token/items/:id', async (req, res) => {
    const size = req.body?.size;
    const cart = await db.transaction(async (trx) => {
      const cart = await liveCart(trx, req.params.token);
      const line = await trx('cart_items').where({ id: Number(req.params.id) || 0, cart_id: cart.id }).first();
      if (!line) throw fail(404, 'err.not_in_cart');
      if (size === line.size) return cart;
      const p = await trx('products').where({ id: line.product_id }).first('category', 'sizes');
      if (typeof size !== 'string' || !sizesOf(p).includes(size)) throw fail(400, 'err.invalid', { field: 'field.size' });
      if (await trx('cart_items').where({ cart_id: cart.id, product_id: line.product_id, size }).first()) throw fail(409, 'err.size_in_cart');
      if (!(await hold(trx, line.product_id, size, line.quantity))) {
        // Missed demand only when that size has none left (one unit wanted), not when there are fewer than the line needs.
        throw Object.assign(fail(409, 'err.size_sold_out', { size }),
          line.quantity === 1 && { missed: { storeId: cart.store_id, session: cart.token, items: [{ product_id: line.product_id, size }] } });
      }
      await release(trx, [line]);
      await trx('cart_items').where({ id: line.id }).update({ size });
      return cart;
    }).catch(missedThen(db));
    res.json(await view(cart));
  });

  r.delete('/:token/items/:id', async (req, res) => {
    const cart = await db.transaction(async (trx) => {
      const cart = await liveCart(trx, req.params.token);
      const line = await trx('cart_items').where({ id: Number(req.params.id) || 0, cart_id: cart.id }).first();
      if (!line) throw fail(404, 'err.not_in_cart');
      await release(trx, [line]);
      await trx('cart_items').where({ id: line.id }).del();
      return cart;
    });
    res.json(await view(cart));
  });

  // "Extend" on the 2-minute warning: any live-cart request extends the hold, this one changes nothing else.
  r.post('/:token/extend', async (req, res) => {
    res.json(await view(await db.transaction((trx) => liveCart(trx, req.params.token))));
  });

  // Kiosk → phone: a one-time QR. Claiming it gives the phone a new cart token, so the kiosk's copy stops working.
  r.post('/:token/handoff', async (req, res) => {
    const handoff = randomBytes(16).toString('hex');
    const expires = Date.now() + HANDOFF_MS;
    const cart = await db.transaction(async (trx) => {
      const cart = await liveCart(trx, req.params.token);
      await trx('carts').where({ id: cart.id }).update({ handoff_token: handoff, handoff_expires_at: iso(expires) });
      return cart;
    });
    const url = `${publicBase(req)}/m?store=${cart.store_id}&handoff=${handoff}`;
    res.json({ url, svg: qrSvg(url), expires_at: iso(expires), ms: HANDOFF_MS });
  });
  r.post('/claim', async (req, res) => {
    const handoff = req.body?.handoff;
    const token = randomBytes(16).toString('hex');
    const now = Date.now();
    // One conditional UPDATE: a second scan (or a race) finds no row.
    const n = typeof handoff === 'string' && TOKEN.test(handoff)
      ? await db('carts').where({ handoff_token: handoff }).where('handoff_expires_at', '>', iso(now)).where('expires_at', '>', iso(now))
        .update({ token, client: clientKey(req.ip), mall_token: null, mall_id: null, handoff_token: null, handoff_expires_at: null, expires_at: iso(now + HOLD_MS), updated_at: db.fn.now() })
      : 0;
    if (!n) throw fail(404, 'err.handoff_invalid');
    res.json(await view(await db('carts').where({ token }).first()));
  });

  // Task 26: { code } puts a promo code on the cart (one at a time; a new one replaces it). Codes of another store or
  // organisation, switched off or out of dates are all "doesn't work", so a guesser learns nothing; tries are rate-limited.
  r.post('/:token/promo', promoLimit, async (req, res) => {
    const cart = await db.transaction(async (trx) => {
      const cart = await liveCart(trx, req.params.token);
      const store = await storeOf(trx, cart.store_id);
      const p = await findPromo(trx, store, req.body?.code);
      const problem = promoProblem(p);
      if (problem) throw fail(409, problem);
      await trx('carts').where({ id: cart.id }).update({ promo_code_id: p.id });
      return { ...cart, promo_code_id: p.id };
    });
    res.json(await view(cart));
  });
  r.delete('/:token/promo', async (req, res) => {
    const cart = await db.transaction(async (trx) => {
      const cart = await liveCart(trx, req.params.token);
      await trx('carts').where({ id: cart.id }).update({ promo_code_id: null });
      return { ...cart, promo_code_id: null };
    });
    res.json(await view(cart));
  });

  // Task 34: stop using points on this cart (using them again needs a new Telegram confirmation).
  r.delete('/:token/points', async (req, res) => {
    const cart = await db.transaction(async (trx) => {
      const cart = await liveCart(trx, req.params.token);
      await trx('carts').where({ id: cart.id }).update({ profile_id: null });
      return { ...cart, profile_id: null };
    });
    res.json(await view(cart));
  });

  // Kiosk idle reset and "Savatni tozalash": give every held unit back at once.
  r.delete('/:token', async (req, res) => {
    await db.transaction(async (trx) => {
      const cart = await lockCart(trx, req.params.token);
      if (!cart) return; // already gone
      await release(trx, await trx('cart_items').where({ cart_id: cart.id }));
      await trx('carts').where({ id: cart.id }).del();
    });
    res.status(204).end();
  });

  // { fulfillment, name, phone, address?, lat?, lon?, payment?, points? } → order. The cart's holds move to the order
  // (a fresh 15 minutes to pay); totals and discounts are computed here from DB prices (any amount in the body is ignored).
  // points (task 34) = so'm of the linked profile's points to spend (the cart view's points.max); checked here against
  // the cap and the balance, 409 when either changed, so the customer is never charged a total they didn't see.
  r.post('/:token/checkout', async (req, res) => {
    const b = req.body ?? {};
    const input = checkoutInput(b, methods);
    const { method } = input;
    const notifyToken = randomBytes(16).toString('hex');
    const id = await db.transaction(async (trx) => placeOrder(trx, await liveCart(trx, req.params.token), b, input, notifyToken));
    const order = await orderView(db, await db('orders').where({ id }).first());
    const url = `${publicBase(req)}/order/${notifyToken}`; // the public status page
    res.status(201).json({ order, payment: await methods[method]({ ...order, notify_token: notifyToken }), notify: link(notifyToken), track: { url, svg: qrSvg(url) } });
  });

  return r;
}

// Public order status page (/order/<notify_token>): no name, phone or address, only what the customer needs to follow it.
export function createOrderRouter(db, { methods = CASHIER, link = () => null } = {}) {
  const r = express.Router();
  r.get('/:token', async (req, res) => {
    await releaseExpired(db);
    const o = TOKEN.test(req.params.token) ? await db('orders').where({ notify_token: req.params.token }).first() : null;
    if (!o) throw fail(404, 'err.order_not_found');
    const v = await orderView(db, o);
    const store = await db('stores').where({ id: o.store_id }).first('name', 'city', 'address');
    const online = o.payment_status === 'pending' && o.payment_method !== 'cashier' && Object.hasOwn(methods, o.payment_method);
    const pay = online ? await methods[o.payment_method]({ ...v, notify_token: o.notify_token }) : null;
    res.json({
      number: v.number, store, status: v.status, payment_status: v.payment_status, payment_method: v.payment_method, fulfillment: v.fulfillment,
      // Task 46: per line its review (the customer's own, also when the shop hid it), the kept size and returned units.
      items: (await orderLines(db, o, v.items)).map((x, n) => {
        const { id, name, name_ru, category, color, size, quantity, unit_price, fit } = v.items[n];
        return { id, name, name_ru, category, color, size, quantity, unit_price, fit, ...x };
      }),
      fit_open: fitOpen(o),
      subtotal: v.subtotal, bundle_discount: v.bundle_discount, promo_discount: v.promo_discount, promo_code: v.promo_code, points_discount: v.points_discount,
      instalment_months: v.instalment_months, instalment_monthly: v.instalment_monthly,
      delivery_fee: v.delivery_fee, total: v.total, created_at: v.created_at, paid_at: v.paid_at, expires_at: v.expires_at,
      pay_ms: o.payment_status === 'pending' ? msLeft(o.expires_at) : null, pay_url: pay?.url ?? null, telegram: link(o.notify_token)?.url ?? null,
    });
  });

  // Task 23: "how did it fit?" for one line of this order: { item, fit: small|right|big }. Only the holder of the status
  // token can answer, only once the order is handed over or delivered, and a new answer replaces the old one.
  r.post('/:token/fit', async (req, res) => {
    const o = TOKEN.test(req.params.token) ? await db('orders').where({ notify_token: req.params.token }).first('id', 'status', 'payment_status') : null;
    if (!o) throw fail(404, 'err.order_not_found');
    if (!fitOpen(o)) throw fail(409, 'err.fit_not_yet');
    const { item, fit } = req.body ?? {};
    if (!FITS.includes(fit)) throw fail(400, 'err.invalid', { field: 'field.fit' });
    const line = Number.isInteger(item) ? await db('order_items as i').join('products as p', 'p.id', 'i.product_id').where({ 'i.id': item, 'i.order_id': o.id }).first('i.id', 'p.category') : null;
    if (!line || line.category === 'accessory') throw fail(404, 'err.not_found');
    await db('order_items').where({ id: line.id }).update({ fit, fit_at: iso(Date.now()) });
    res.json({ item: line.id, fit });
  });
  return r;
}
const fitOpen = (o) => o.status === 'delivered' && o.payment_status === 'paid';
