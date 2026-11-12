// Task 38: one cart across the shops of a mall. A mall cart is a thin layer over the per-shop carts of task 8: the store
// carts that share one random mall_token (one per shop). Each store cart keeps its own lines, holds, promo code, points
// link and bundle, so every shop's money follows that shop's own rules; the store cart tokens in the view work with the
// /api/cart routes for line, promo and points changes. Checkout makes one order per shop and an order group in one
// transaction. Payment is at each shop's cashier (no online payment for a group: it needs a mall merchant account).
import express from 'express';
import { randomBytes } from 'node:crypto';
import { fail } from '../admin/routes.js';
import { qrSvg, publicBase } from '../qr.js';
import { TOKEN, CASHIER, iso, stamp, releaseExpired, extendGroup, lockCart, openCart, addLines, parseItems, missedThen, cartView, customer, checkoutInput, placeOrder, release } from './cart.js';

const MAX_SHOPS = 10; // shops in one mall cart (each holds up to 20 units, task 8)
const token16 = () => randomBytes(16).toString('hex');
const msLeft = (v) => (v == null ? null : Math.max(0, Date.parse(stamp(v)) - Date.now()));
const shopOf = (s) => ({ id: s.id, name: s.name, floor: s.mall_floor ?? null, unit: s.mall_unit ?? null, logo_url: s.logo_url ?? null });

// → { token, mall_id, hold_ms, count, shops: [{ store, cart }] }; shops whose cart is empty are left out.
async function mallView(db, mallToken) {
  const carts = TOKEN.test(mallToken ?? '') ? await db('carts').where({ mall_token: mallToken }).where('expires_at', '>', iso(Date.now())).orderBy('id') : [];
  if (!carts.length) throw fail(404, 'err.cart_not_found');
  const stores = await db('stores').whereIn('id', carts.map((c) => c.store_id)).select('id', 'name', 'mall_floor', 'mall_unit', 'logo_url');
  const shops = [];
  for (const c of carts) {
    const cart = await cartView(db, c, ['cashier']);
    if (cart.items.length) shops.push({ store: shopOf(stores.find((s) => s.id === c.store_id)), cart });
  }
  return {
    token: mallToken, mall_id: carts[0].mall_id, expires_at: stamp(carts[0].expires_at), hold_ms: msLeft(carts[0].expires_at),
    count: shops.reduce((n, s) => n + s.cart.items.reduce((m, i) => m + i.quantity, 0), 0), shops,
  };
}

// The group as its customer sees it (checkout answer and the public status page): no name, phone or address.
async function groupView(db, g) {
  const mall = await db('malls').where({ id: g.mall_id }).first('id', 'name', 'city', 'address');
  const orders = await db('orders as o').join('stores as s', 's.id', 'o.store_id').where('o.group_id', g.id).orderBy('o.id')
    .select('o.*', 's.name as store_name', 's.mall_floor', 's.mall_unit', 's.logo_url');
  const items = await db('order_items as i').join('products as p', 'p.id', 'i.product_id').whereIn('i.order_id', orders.map((o) => o.id)).orderBy('i.id')
    .select('i.order_id', 'p.name', 'p.name_ru', 'p.category', 'i.size', 'i.quantity', 'i.unit_price');
  return {
    number: g.number, created_at: stamp(g.created_at), mall,
    orders: orders.map((o) => ({
      store: shopOf({ ...o, id: o.store_id, name: o.store_name }), number: o.number, status: o.status, payment_status: o.payment_status, fulfillment: o.fulfillment,
      items: items.filter((i) => i.order_id === o.id).map(({ order_id, ...i }) => i),
      subtotal: o.subtotal, bundle_discount: o.bundle_discount, promo_discount: o.promo_discount, promo_code: o.promo_code, points_discount: o.points_discount,
      delivery_fee: o.delivery_fee, total: o.total, instalment_months: o.instalment_months, instalment_monthly: o.instalment_monthly,
      paid_at: stamp(o.paid_at), expires_at: stamp(o.expires_at), pay_ms: o.payment_status === 'pending' ? msLeft(o.expires_at) : null,
      track: `/order/${o.notify_token}`, // the shop order's own page (Telegram button, fit question)
    })),
  };
}

export function createMallCartRouter(db, { maxOpenCarts = 0 } = {}) {
  const r = express.Router();
  r.use(async (req, res, next) => {
    await releaseExpired(db);
    next();
  });

  // { token?, mall_id, store_id, items, rec?, outfit? } → the mall cart. Only a shown shop of that mall; a missing or
  // dead token (or another mall's) starts a new mall cart. Adding to one shop extends every shop's hold.
  r.post('/items', async (req, res) => {
    const b = req.body ?? {};
    const items = parseItems(b.items);
    const { mall_id: mallId, store_id: storeId } = b;
    if (!Number.isInteger(mallId) || !Number.isInteger(storeId)) throw fail(404, 'err.store_not_found');
    const mallToken = await db.transaction(async (trx) => {
      const store = await trx('stores').where({ id: storeId, mall_id: mallId }).first('id', 'mall_hidden');
      if (!store || store.mall_hidden) throw fail(404, 'err.store_not_found');
      let mt = typeof b.token === 'string' && TOKEN.test(b.token) ? b.token : null;
      if (mt && !(await trx('carts').where({ mall_token: mt, mall_id: mallId }).first('id'))) mt = null;
      if (mt && !(await extendGroup(trx, mt))) mt = null; // every shop's hold ran out
      let cart = null;
      if (mt) {
        const own = await trx('carts').where({ mall_token: mt, store_id: storeId }).first('token');
        cart = own && (await lockCart(trx, own.token));
        if (!cart) {
          const [{ n }] = await trx('carts').where({ mall_token: mt }).count({ n: '*' });
          if (Number(n) >= MAX_SHOPS) throw fail(409, 'err.mall_cart_shops', { max: MAX_SHOPS });
          cart = await openCart(trx, req, storeId, 0, { mall_token: mt, mall_id: mallId }); // the mall cart is already counted
        }
      } else {
        mt = token16();
        cart = await openCart(trx, req, storeId, maxOpenCarts, { mall_token: mt, mall_id: mallId });
      }
      await extendGroup(trx, mt); // the new shop's cart and the others now run out at the very same moment
      await addLines(trx, cart, items, b);
      return mt;
    }).catch(missedThen(db));
    res.json(await mallView(db, mallToken));
  });

  r.get('/:token', async (req, res) => res.json(await mallView(db, req.params.token)));

  // "Savatni tozalash" and the kiosk idle reset: every shop's held units come back at once.
  r.delete('/:token', async (req, res) => {
    if (TOKEN.test(req.params.token)) {
      await db.transaction(async (trx) => {
        for (const c of await trx('carts').where({ mall_token: req.params.token })) {
          const lines = await trx('cart_items').where({ cart_id: c.id }); // read first: deleting the cart cascades to them
          if (await trx('carts').where({ id: c.id }).del()) await release(trx, lines); // 0 = a parallel request took it
        }
      });
    }
    res.status(204).end();
  });

  // { name, phone, shops: [{ store_id, points?, instalment? }] } → one order per shop and the group, all or nothing.
  // Pickup only (decided: the customer is in the mall; delivery from several shops is a follow-up). Each shop's order
  // is priced by that shop's rules (bundle, promo code, points of its organisation, its instalment terms). A problem in
  // one shop (a promo code that stopped working, points changed, a term no longer offered) rolls everything back and
  // the error names that shop (`store`).
  r.post('/:token/checkout', async (req, res) => {
    const b = req.body ?? {};
    const who = { name: b.name, phone: b.phone, fulfillment: 'pickup' };
    customer(who, null); // name and phone first, so their errors name no shop
    const asked = b.shops ?? [];
    if (!Array.isArray(asked) || asked.length > MAX_SHOPS || asked.some((s) => !Number.isInteger(s?.store_id))) throw fail(400, 'err.invalid', { field: 'field.items' });
    const input = new Map(asked.map((s) => [s.store_id, checkoutInput({ points: s.points, instalment: s.instalment }, CASHIER)]));
    const mt = req.params.token;
    const groupId = await db.transaction(async (trx) => {
      if (!TOKEN.test(mt) || !(await extendGroup(trx, mt))) throw fail(404, 'err.cart_not_found'); // locks every shop's cart
      const carts = await trx('carts').where({ mall_token: mt }).where('expires_at', '>', iso(Date.now())).orderBy('id');
      const full = [];
      for (const c of carts) {
        if (await trx('cart_items').where({ cart_id: c.id }).first('id')) full.push(c);
        else await trx('carts').where({ id: c.id }).del(); // a shop whose lines were all removed
      }
      if (!full.length) throw fail(400, 'err.cart_empty');
      const mallId = full[0].mall_id;
      await trx('malls').where({ id: mallId }).increment('order_seq', 1); // locks the mall row: numbers 1, 2, 3… per mall
      const mall = await trx('malls').where({ id: mallId }).first('order_seq');
      if (!mall) throw fail(409, 'err.mall_shop_gone'); // the mall was removed meanwhile
      const number = mall.order_seq;
      const [{ id }] = await trx('order_groups').insert({ mall_id: mallId, number, token: token16() }).returning('id');
      for (const cart of full) {
        const store = await trx('stores').where({ id: cart.store_id }).first('id', 'name', 'mall_id', 'mall_hidden');
        try {
          if (store.mall_id !== mallId || store.mall_hidden) throw fail(409, 'err.mall_shop_gone');
          await placeOrder(trx, cart, who, input.get(cart.store_id) ?? checkoutInput({}, CASHIER), token16(), { group_id: id, group_number: number });
        } catch (err) {
          throw Object.assign(err, { store: { id: store.id, name: store.name } });
        }
      }
      return id;
    });
    const g = await db('order_groups').where({ id: groupId }).first();
    const url = `${publicBase(req)}/mall-order/${g.token}`; // the group status page
    res.status(201).json({ ...(await groupView(db, g)), track: { url, svg: qrSvg(url) } });
  });

  return r;
}

// Public group status page (/mall-order/<token>): each shop's name, floor and unit, order number and status.
export function createOrderGroupRouter(db) {
  const r = express.Router();
  r.get('/:token', async (req, res) => {
    await releaseExpired(db);
    const g = TOKEN.test(req.params.token) ? await db('order_groups').where({ token: req.params.token }).first() : null;
    if (!g) throw fail(404, 'err.order_not_found');
    res.json(await groupView(db, g));
  });
  return r;
}
