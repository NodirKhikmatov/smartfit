// Task 49: what the shop earned. Sold lines = paid orders not cancelled, by payment day (Tashkent), over the last
// `days` (7, 30 or 90). Per line: revenue = price × units − the line's discounts (bundle, promo, points) − refunds of its
// returns; cost = the cost copied onto the line at the sale × units kept (a return put back on the shelf gives its cost
// back, one written off doesn't). A line sold before its product had a cost is counted apart, never as 100 % profit.
// Exchanges move a size, not money, so they change nothing here. Delivery fees are not goods and stay out.
// Only super, owner and manager reach this (the staff and mall gates refuse it; checked again below).
import { fail, inStores, dayKey, dayStart, msOf, DAY_MS } from './routes.js';

const iso = (ms) => new Date(ms).toISOString(); // paid_at is written as an ISO string (cart.js)
const BELOW_MAX = 50;
const PRODUCTS_MAX = 100;
export const COST_ROLES = ['super', 'owner', 'manager'];

const margin = (profit, revenue) => (revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : null);
const bucket = () => ({ units: 0, revenue: 0, cost: 0, profit: 0, no_cost_units: 0, no_cost_revenue: 0 });
function add(b, l) {
  if (l.cost === null) {
    b.no_cost_units += l.units;
    b.no_cost_revenue += l.revenue;
  } else {
    b.units += l.units;
    b.revenue += l.revenue;
    b.cost += l.cost;
    b.profit += l.revenue - l.cost;
  }
}
const out = (b) => ({ ...b, margin: margin(b.profit, b.revenue) });

// One sold line → its numbers (see the top of the file).
export function lineProfit(x) {
  const back = Number(x.back_units ?? 0), restocked = Number(x.restocked ?? 0), refund = Number(x.refund ?? 0);
  const paid = x.unit_price * x.quantity - x.discount;
  return {
    units: x.quantity - back,
    revenue: paid - refund,
    cost: x.unit_cost == null ? null : x.unit_cost * (x.quantity - restocked),
    below: x.unit_cost != null && paid < x.unit_cost * x.quantity,
    paid,
  };
}

export function profitRoutes(r, db) {
  const scope = (req, q, col) => {
    inStores(req.admin, q, col);
    if (req.query.store_id) q.where(col, Number(req.query.store_id) || 0);
    return q;
  };

  r.get('/profit', async (req, res) => {
    if (!COST_ROLES.includes(req.admin.role)) throw fail(403, 'err.forbidden');
    const days = [7, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const keys = Array.from({ length: days }, (_, i) => dayKey(Date.now() - (days - 1 - i) * DAY_MS));
    const from = iso(dayStart(keys[0])), to = iso(dayStart(keys.at(-1)) + DAY_MS);
    const sold = (q) => scope(req, q, 'o.store_id').where('o.payment_status', 'paid').whereNot('o.status', 'cancelled')
      .where('o.paid_at', '>=', from).where('o.paid_at', '<', to);
    const back = db('order_returns').where('kind', 'return').groupBy('order_item_id').select('order_item_id')
      .sum({ back_units: 'quantity' }).sum({ refund: 'refund' }).sum({ restocked: db.raw('case when restock then quantity else 0 end') });
    // shortcut: totals in JS over the sold lines; fine for a shop's 90 days, move to SQL GROUP BY past ~100k lines.
    const rows = await sold(db('order_items as i').join('orders as o', 'o.id', 'i.order_id').join('products as p', 'p.id', 'i.product_id')
      .leftJoin('categories as c', 'c.id', 'p.category_id').leftJoin(back.as('b'), 'b.order_item_id', 'i.id'))
      .orderBy('o.paid_at', 'desc').orderBy('i.id', 'desc')
      .select('i.id', 'i.order_id', 'o.number', 'o.store_id', 'o.paid_at', 'i.product_id', 'p.name', 'p.name_ru', 'p.sku', 'p.category', 'p.category_id',
        'c.name as category_name', 'c.name_ru as category_name_ru', 'i.size', 'i.quantity', 'i.unit_price', 'i.discount', 'i.unit_cost', 'b.back_units', 'b.refund', 'b.restocked');
    const total = bucket(), perDay = new Map(keys.map((k) => [k, bucket()])), cats = new Map(), prods = new Map(), below = [];
    for (const x of rows) {
      const l = lineProfit(x);
      add(total, l);
      const d = perDay.get(dayKey(msOf(x.paid_at)));
      if (d) add(d, l);
      const ck = x.category_id ?? `r:${x.category ?? ''}`;
      if (!cats.has(ck)) cats.set(ck, { category_id: x.category_id ?? null, name: x.category_name ?? null, name_ru: x.category_name_ru ?? null, category: x.category ?? null, ...bucket() });
      add(cats.get(ck), l);
      if (!prods.has(x.product_id)) prods.set(x.product_id, { product_id: x.product_id, name: x.name, name_ru: x.name_ru, sku: x.sku, category: x.category, store_id: x.store_id, ...bucket() });
      add(prods.get(x.product_id), l);
      if (l.below && below.length < BELOW_MAX) {
        below.push({ order_id: x.order_id, number: x.number, store_id: x.store_id, product_id: x.product_id, name: x.name, name_ru: x.name_ru, sku: x.sku, size: x.size,
          quantity: x.quantity, unit_paid: Math.floor(l.paid / x.quantity), unit_cost: x.unit_cost, loss: x.unit_cost * x.quantity - l.paid });
      }
    }
    const byProfit = (a, b) => b.profit - a.profit || b.no_cost_revenue - a.no_cost_revenue;
    // What the discounts cost: the bundle discount, promo codes (per code) and points spent, on the same orders.
    const orders = sold(db('orders as o'));
    const [d] = await orders.clone().sum({ bundle: 'o.bundle_discount' }).sum({ promo: 'o.promo_discount' }).sum({ points: 'o.points_discount' });
    const codes = await orders.clone().whereNotNull('o.promo_code').where('o.promo_discount', '>', 0).groupBy('o.promo_code').select('o.promo_code as code')
      .count({ orders: '*' }).sum({ sum: 'o.promo_discount' }).orderBy([{ column: 'sum', order: 'desc' }, { column: 'code' }]).limit(20);
    // Stock value at cost now (on hand, reserved units included: they are still the shop's until paid).
    const stock = await scope(req, db('product_stock as ps').join('products as p', 'p.id', 'ps.product_id'), 'p.store_id').where('ps.quantity', '>', 0)
      .groupByRaw('case when p.cost is null then 1 else 0 end').select(db.raw('case when p.cost is null then 1 else 0 end as unknown'))
      .sum({ units: 'ps.quantity' }).sum({ value: db.raw('ps.quantity * coalesce(p.cost, 0)') }).countDistinct({ products: 'p.id' });
    const known = stock.find((s) => !Number(s.unknown)), unknown = stock.find((s) => Number(s.unknown));
    const discounts = { bundle: Number(d.bundle ?? 0), promo: Number(d.promo ?? 0), points: Number(d.points ?? 0) };
    res.json({
      days, from: keys[0], to: keys.at(-1),
      totals: out(total),
      discounts: { ...discounts, total: discounts.bundle + discounts.promo + discounts.points,
        promo_codes: codes.map((c) => ({ code: c.code, orders: Number(c.orders), sum: Number(c.sum) })) },
      per_day: keys.map((day) => ({ day, ...out(perDay.get(day)) })),
      categories: [...cats.values()].sort(byProfit).map(out),
      products: [...prods.values()].sort(byProfit).slice(0, PRODUCTS_MAX).map(out),
      below_cost: below,
      stock: { value: Number(known?.value ?? 0), units: Number(known?.units ?? 0), no_cost_units: Number(unknown?.units ?? 0), no_cost_products: Number(unknown?.products ?? 0) },
    });
  });
}
