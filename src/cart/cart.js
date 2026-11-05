// Task 8: server-side cart, 15-minute stock holds, orders, cashier payment.
// A hold is product_stock.reserved. Every change to it is a conditional UPDATE (never read-then-write),
// so two buyers can't both take the last unit, on SQLite and on Postgres alike.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { fail } from '../admin/routes.js';
import { sizesFor } from '../db/seed.js';
import { unitPrice } from '../recommend/engine.js';

export const HOLD_MS = 15 * 60 * 1000;
const MAX_UNITS = 20; // shortcut: per-cart cap only; anyone can open many carts, add a per-IP limit in task 11 if holds get abused
const DELIVERY_RADIUS_KM = 30; // "within the city" = the map pin is this close to the store
const TOKEN = /^[a-f0-9]{32}$/;
const iso = (ms) => new Date(ms).toISOString(); // ISO strings compare correctly in SQLite text and Postgres timestamptz

// Payment methods offered at checkout. Each returns what the client needs; online ones add a pay `url` (src/cart/payments.js).
const CASHIER = { cashier: async () => ({ method: 'cashier' }) };

// Pickup is free. Delivery: the store's flat city fee, free when the subtotal is above the store's threshold (null = never free).
export function deliveryFee(store, subtotal, fulfillment) {
  if (fulfillment !== 'delivery') return 0;
  return store.free_delivery_threshold != null && subtotal > store.free_delivery_threshold ? 0 : store.delivery_fee;
}
export const totals = (store, subtotal, fulfillment) => {
  const delivery_fee = deliveryFee(store, subtotal, fulfillment);
  return { subtotal, delivery_fee, total: subtotal + delivery_fee };
};

// Takes n units of free stock; false when fewer than n are free.
const hold = async (trx, productId, size, n) =>
  (await trx('product_stock').where({ product_id: productId, size }).whereRaw('quantity - reserved >= ?', [n]).increment('reserved', n)) === 1;
// Clamped at 0 so one inconsistent row (e.g. a hand-edited DB) can't make the sweep, and with it every cart request, fail.
const release = (trx, lines) =>
  Promise.all(lines.map((l) => trx('product_stock').where({ product_id: l.product_id, size: l.size })
    .update({ reserved: trx.raw('case when reserved >= ? then reserved - ? else 0 end', [l.quantity, l.quantity]) })));

// Extends a live cart's hold and returns it. The UPDATE also locks the row against a concurrent expiry sweep.
async function lockCart(trx, token, now = Date.now()) {
  const n = typeof token === 'string' && TOKEN.test(token)
    ? await trx('carts').where({ token }).where('expires_at', '>', iso(now)).update({ expires_at: iso(now + HOLD_MS), updated_at: trx.fn.now() })
    : 0;
  return n ? trx('carts').where({ token }).first() : null;
}
async function liveCart(trx, token) {
  const cart = await lockCart(trx, token);
  if (!cart) throw fail(404, "Savat topilmadi yoki band qilish muddati tugadi");
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
  await trx('payment_transactions').where({ order_id: orderId, state: 1 }).update({ state: -1, reason: 4, cancel_time: now });
  return true;
}

// A paid order is cancelled before it left the store: its stock returns to the shelf. The status UPDATE claims the
// order, so the stock comes back exactly once. payment_status stays 'paid' until the money is refunded.
async function cancelPaid(trx, orderId) {
  const n = await trx('orders').where({ id: orderId, payment_status: 'paid' }).whereIn('status', ['new', 'packing'])
    .update({ status: 'cancelled', updated_at: trx.fn.now() });
  if (!n) return false;
  for (const i of await trx('order_items').where({ order_id: orderId })) {
    await trx('product_stock').where({ product_id: i.product_id, size: i.size }).increment('quantity', i.quantity);
  }
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
export function changeStatus(db, orderId, to) {
  return db.transaction(async (trx) => {
    const o = await trx('orders').where({ id: orderId }).first();
    if (!nextStatuses(o).includes(to)) return false;
    if (to === 'cancelled') return o.payment_status === 'pending' ? cancelPending(trx, o.id) : cancelPaid(trx, o.id);
    return (await trx('orders').where({ id: o.id, status: o.status, payment_status: 'paid' }).update({ status: to, updated_at: trx.fn.now() })) === 1;
  });
}

// Paid → stock leaves the shelf: quantity and reserved both drop. Only a pending, unexpired order can be paid, exactly once.
// The Click/Payme callbacks call it inside their own transaction (knex nests it as a savepoint).
export async function markPaid(db, orderId, now = Date.now()) {
  return db.transaction(async (trx) => {
    const n = await trx('orders').where({ id: orderId, payment_status: 'pending' }).where('expires_at', '>', iso(now))
      .update({ payment_status: 'paid', paid_at: iso(now), expires_at: null, updated_at: trx.fn.now() });
    if (!n) return false;
    for (const i of await trx('order_items').where({ order_id: orderId })) {
      await trx('product_stock').where({ product_id: i.product_id, size: i.size })
        .update({ quantity: trx.raw('quantity - ?', [i.quantity]), reserved: trx.raw('reserved - ?', [i.quantity]) });
    }
    return true;
  });
}

// SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC, which Date would read as local time.
export const stamp = (v) => (v == null ? null : new Date(typeof v === 'string' && !v.includes('T') ? `${v.replace(' ', 'T')}Z` : v).toISOString());
const storeOf = (db, id) => db('stores').where({ id }).first('id', 'name', 'city', 'lat', 'lon', 'delivery_fee', 'free_delivery_threshold');

// Prices always come from the products table, never from the request.
async function cartView(db, cart, payments) {
  const store = await storeOf(db, cart.store_id);
  const rows = await db('cart_items as c').join('products as p', 'p.id', 'c.product_id').where('c.cart_id', cart.id).orderBy('c.id')
    .select('c.id', 'c.product_id', 'c.size', 'c.quantity', 'p.name', 'p.category', 'p.color', 'p.price', 'p.discount_price', 'p.image_url', 'p.shelf_location');
  const free = await db('product_stock').whereIn('product_id', rows.map((r) => r.product_id)).whereRaw('quantity - reserved > 0').select('product_id', 'size');
  const items = rows.map((r) => ({
    ...r,
    unit_price: unitPrice(r),
    line_total: unitPrice(r) * r.quantity,
    sizes: sizesFor(r.category).filter((s) => s === r.size || free.some((f) => f.product_id === r.product_id && f.size === s)),
  }));
  const subtotal = items.reduce((s, i) => s + i.line_total, 0);
  return {
    token: cart.token,
    store_id: store.id,
    expires_at: stamp(cart.expires_at),
    items,
    payments,
    delivery: { city: store.city, lat: store.lat, lon: store.lon, fee: store.delivery_fee, free_over: store.free_delivery_threshold },
    totals: { pickup: totals(store, subtotal, 'pickup'), delivery: totals(store, subtotal, 'delivery') },
  };
}

export async function orderView(db, order) {
  const items = await db('order_items as i').join('products as p', 'p.id', 'i.product_id').where('i.order_id', order.id).orderBy('i.id')
    .select('i.product_id', 'p.name', 'p.category', 'p.color', 'p.shelf_location', 'i.size', 'i.quantity', 'i.unit_price');
  const { id, store_id, customer_name, phone, fulfillment, address, lat, lon, status, payment_status, payment_method, subtotal, delivery_fee, total } = order;
  return {
    id, store_id, customer_name, phone, fulfillment, address, lat, lon, status, payment_status, payment_method, subtotal, delivery_fee, total,
    expires_at: stamp(order.expires_at), paid_at: stamp(order.paid_at), created_at: stamp(order.created_at), items,
  };
}

const km = (a, b) => {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const text = (v, min, max, label) => {
  if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) throw fail(400, `${label} noto'g'ri`);
  return v.trim();
};

// Uzbek mobile: 9 digits, optionally with 998 in front → +998XXXXXXXXX.
export function normalizePhone(v) {
  const d = typeof v === 'string' ? v.replace(/[\s()+-]/g, '') : '';
  const full = /^\d{9}$/.test(d) ? '998' + d : d;
  if (!/^998\d{9}$/.test(full)) throw fail(400, "Telefon raqami noto'g'ri. Masalan: +998 90 123 45 67");
  return '+' + full;
}

function customer(b, store) {
  if (!['pickup', 'delivery'].includes(b.fulfillment)) throw fail(400, "Olish usulini tanlang");
  const c = { customer_name: text(b.name, 2, 80, 'Ism'), phone: normalizePhone(b.phone), fulfillment: b.fulfillment, address: null, lat: null, lon: null };
  if (c.fulfillment === 'pickup') return c;
  c.address = text(b.address, 5, 200, 'Manzil');
  if (b.lat != null || b.lon != null) {
    const ok = (v, lim) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
    if (!ok(b.lat, 90) || !ok(b.lon, 180)) throw fail(400, "Xaritadagi nuqta noto'g'ri");
    if (km(store, { lat: b.lat, lon: b.lon }) > DELIVERY_RADIUS_KM) throw fail(422, `Yetkazib berish faqat ${store.city} shahri ichida`);
    Object.assign(c, { lat: b.lat, lon: b.lon });
  }
  return c;
}

function parseItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 10) throw fail(400, "Kiyimlar ro'yxati noto'g'ri");
  return items.map((i) => {
    if (!Number.isInteger(i?.product_id) || i.product_id < 1 || typeof i.size !== 'string') throw fail(400, 'Kiyim yoki razmer tanlanmagan');
    return { product_id: i.product_id, size: i.size };
  });
}

// Public, keyed by an unguessable cart token. The token is the customer's only handle on the cart.
// `link(notifyToken)` → how the customer subscribes to order messages ({ url, svg } for Telegram), or null when off.
export function createCartRouter(db, { methods = CASHIER, link = () => null } = {}) {
  const r = express.Router();
  const view = (cart) => cartView(db, cart, Object.keys(methods));
  r.use(async (req, res, next) => {
    await releaseExpired(db);
    next();
  });

  // { token?, store_id, items: [{ product_id, size }] }: one item or a whole outfit, all or nothing.
  // A missing or expired token opens a new cart.
  r.post('/items', async (req, res) => {
    const b = req.body ?? {};
    const items = parseItems(b.items);
    const cart = await db.transaction(async (trx) => {
      let cart = await lockCart(trx, b.token);
      if (cart && Number.isInteger(b.store_id) && cart.store_id !== b.store_id) cart = null; // phone scanned another store's QR
      if (!cart) {
        if (!Number.isInteger(b.store_id) || !(await trx('stores').where({ id: b.store_id }).first('id'))) throw fail(404, "Do'kon topilmadi");
        const token = randomBytes(16).toString('hex');
        await trx('carts').insert({ store_id: b.store_id, token, expires_at: iso(Date.now() + HOLD_MS) });
        cart = await trx('carts').where({ token }).first();
      }
      const [{ n }] = await trx('cart_items').where({ cart_id: cart.id }).sum({ n: 'quantity' });
      if (Number(n ?? 0) + items.length > MAX_UNITS) throw fail(409, `Savatga ko'pi bilan ${MAX_UNITS} ta kiyim sig'adi`);
      for (const { product_id, size } of items) {
        const p = await trx('products').where({ id: product_id, store_id: cart.store_id }).first('name', 'category');
        if (!p) throw fail(404, 'Kiyim topilmadi');
        if (!sizesFor(p.category).includes(size)) throw fail(400, `«${p.name}»: razmer noto'g'ri`);
        if (!(await hold(trx, product_id, size, 1))) throw fail(409, `«${p.name}» (${size === 'ONE' ? 'yagona razmer' : size}) qolmadi`);
        await trx('cart_items').insert({ cart_id: cart.id, product_id, size, quantity: 1 })
          .onConflict(['cart_id', 'product_id', 'size']).merge({ quantity: trx.raw('?? + 1', ['cart_items.quantity']) });
      }
      return cart;
    });
    res.json(await view(cart));
  });

  r.get('/:token', async (req, res) => {
    const cart = TOKEN.test(req.params.token) ? await db('carts').where({ token: req.params.token }).first() : null;
    if (!cart) throw fail(404, "Savat topilmadi yoki band qilish muddati tugadi");
    res.json(await view(cart));
  });

  // Change size: hold the new size first, then release the old one.
  r.patch('/:token/items/:id', async (req, res) => {
    const size = req.body?.size;
    const cart = await db.transaction(async (trx) => {
      const cart = await liveCart(trx, req.params.token);
      const line = await trx('cart_items').where({ id: Number(req.params.id) || 0, cart_id: cart.id }).first();
      if (!line) throw fail(404, 'Kiyim savatda yo\'q');
      if (size === line.size) return cart;
      const p = await trx('products').where({ id: line.product_id }).first('category');
      if (typeof size !== 'string' || !sizesFor(p.category).includes(size)) throw fail(400, "Razmer noto'g'ri");
      if (await trx('cart_items').where({ cart_id: cart.id, product_id: line.product_id, size }).first()) throw fail(409, 'Bu razmer savatda bor');
      if (!(await hold(trx, line.product_id, size, line.quantity))) throw fail(409, `${size} razmer qolmadi`);
      await release(trx, [line]);
      await trx('cart_items').where({ id: line.id }).update({ size });
      return cart;
    });
    res.json(await view(cart));
  });

  r.delete('/:token/items/:id', async (req, res) => {
    const cart = await db.transaction(async (trx) => {
      const cart = await liveCart(trx, req.params.token);
      const line = await trx('cart_items').where({ id: Number(req.params.id) || 0, cart_id: cart.id }).first();
      if (!line) throw fail(404, 'Kiyim savatda yo\'q');
      await release(trx, [line]);
      await trx('cart_items').where({ id: line.id }).del();
      return cart;
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

  // { fulfillment, name, phone, address?, lat?, lon?, payment? } → order. The cart's holds move to the order
  // (a fresh 15 minutes to pay); totals are computed here from DB prices.
  r.post('/:token/checkout', async (req, res) => {
    const b = req.body ?? {};
    const method = b.payment ?? 'cashier';
    if (typeof method !== 'string' || !Object.hasOwn(methods, method)) throw fail(400, "To'lov usuli noto'g'ri");
    const notifyToken = randomBytes(16).toString('hex');
    const id = await db.transaction(async (trx) => {
      const cart = await liveCart(trx, req.params.token);
      const store = await storeOf(trx, cart.store_id);
      const c = customer(b, store);
      const lines = await trx('cart_items as c').join('products as p', 'p.id', 'c.product_id').where('c.cart_id', cart.id)
        .orderBy('c.id').select('c.product_id', 'c.size', 'c.quantity', 'p.price', 'p.discount_price');
      if (!lines.length) throw fail(400, "Savat bo'sh");
      const t = totals(store, lines.reduce((s, l) => s + unitPrice(l) * l.quantity, 0), c.fulfillment);
      const [{ id }] = await trx('orders').insert({ store_id: store.id, ...c, ...t, payment_method: method, notify_token: notifyToken, expires_at: iso(Date.now() + HOLD_MS) }).returning('id');
      await trx('order_items').insert(lines.map((l) => ({ order_id: id, product_id: l.product_id, size: l.size, quantity: l.quantity, unit_price: unitPrice(l) })));
      await trx('carts').where({ id: cart.id }).del(); // reserved stays: the order owns the hold now
      return id;
    });
    const order = await orderView(db, await db('orders').where({ id }).first());
    res.status(201).json({ order, payment: await methods[method](order), notify: link(notifyToken) });
  });

  return r;
}
