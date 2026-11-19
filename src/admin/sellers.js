// Task 50: who sold it. Per seller over a period: the orders they got (counted when the order got its seller), the sum,
// the units returned and the commission. The sum is what the customer paid for the goods: the order total (already after
// the bundle, promo code and points) without the delivery fee. Commission per order = floor(sum × percent / 100), the
// percent frozen on the order when its seller was set. A return (not an exchange) takes commission back in the period it
// is made, so that the order keeps floor(percent × (sum − every refund so far)): partial returns add up to a full one.
// Owners and managers read the report for their stores (?store_id narrows); every team member reads only their own
// numbers through /me/sales. The staff and mall gates refuse /sellers; COST_ROLES is checked again here.
import { fail, inStores, dayKey, dayStart, msOf, langOf, DAY_MS } from './routes.js';
import { COST_ROLES } from './profit.js';
import { dbTime } from '../recommend/routes.js';
import { toCsv } from './csv.js';
import { t } from '../../public/shared/i18n.js';

const iso = (ms) => new Date(ms).toISOString(); // seller_at / paid_at are written as ISO strings (cart.js)
const RANGE_MAX = 366;
export const commission = (sum, percent) => Math.floor((Math.max(0, sum) * (percent ?? 0)) / 100);

// ?from&to = Tashkent days (inclusive); default this month so far.
function period({ from, to }) {
  const today = dayKey(Date.now());
  const p = { from: from || `${today.slice(0, 8)}01`, to: to || today };
  const ok = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(dayStart(v)) && dayKey(dayStart(v)) === v;
  if (!ok(p.from) || !ok(p.to) || p.to < p.from || (dayStart(p.to) - dayStart(p.from)) / DAY_MS >= RANGE_MAX) throw fail(400, 'err.invalid', { field: 'field.date' });
  return { ...p, start: dayStart(p.from), end: dayStart(p.to) + DAY_MS };
}
// The staff app's chips: today, this month, last month.
export const STAFF_PERIODS = ['today', 'month', 'last_month'];
function staffPeriod(v = 'month') {
  if (!STAFF_PERIODS.includes(v)) throw fail(400, 'err.invalid', { field: 'field.period' });
  const today = dayKey(Date.now()), monthStart = `${today.slice(0, 8)}01`;
  if (v === 'today') return period({ from: today, to: today });
  if (v === 'month') return period({ from: monthStart, to: today });
  const lastDay = dayKey(dayStart(monthStart) - DAY_MS);
  return period({ from: `${lastDay.slice(0, 8)}01`, to: lastDay });
}

const blank = (id) => ({ seller_id: id, orders: 0, sum: 0, returns: 0, refunded: 0, commission: 0 });
// → Map seller id → numbers. scope(q) narrows `o` (orders) to the caller's stores; sellerId = one person only.
export async function sellerNumbers(db, scope, { start, end }, sellerId = null) {
  const own = (q) => (sellerId == null ? q.whereNotNull('o.seller_id') : q.where('o.seller_id', sellerId));
  const rows = new Map();
  const row = (id) => rows.get(id) ?? rows.set(id, blank(id)).get(id);
  const sales = await own(scope(db('orders as o'))).where('o.payment_status', 'paid').whereNot('o.status', 'cancelled')
    .where('o.seller_at', '>=', iso(start)).where('o.seller_at', '<', iso(end)).select('o.seller_id', 'o.total', 'o.delivery_fee', 'o.seller_percent');
  for (const o of sales) {
    const r = row(o.seller_id), sum = o.total - o.delivery_fee;
    r.orders++;
    r.sum += sum;
    r.commission += commission(sum, o.seller_percent);
  }
  // Every return of the orders that had one in the period, oldest first, for the refunds made before each.
  const hit = own(scope(db('order_returns as x').join('orders as o', 'o.id', 'x.order_id'))).where('x.kind', 'return')
    .where('x.created_at', '>=', dbTime(start)).where('x.created_at', '<', dbTime(end)).distinct('x.order_id');
  const back = await db('order_returns as x').join('orders as o', 'o.id', 'x.order_id').where('x.kind', 'return').whereIn('x.order_id', hit)
    .whereNot('o.status', 'cancelled').orderBy('x.id').select('x.order_id', 'x.quantity', 'x.refund', 'x.created_at', 'o.seller_id', 'o.total', 'o.delivery_fee', 'o.seller_percent');
  const refunded = new Map();
  for (const x of back) {
    const sum = x.total - x.delivery_fee, before = refunded.get(x.order_id) ?? 0, after = before + x.refund;
    refunded.set(x.order_id, after);
    const at = msOf(x.created_at);
    if (at < start || at >= end) continue;
    const r = row(x.seller_id);
    r.returns += x.quantity;
    r.refunded += x.refund;
    r.commission -= commission(sum - before, x.seller_percent) - commission(sum - after, x.seller_percent);
  }
  return rows;
}

export function sellerRoutes(r, db) {
  const scoped = (req) => (q) => {
    inStores(req.admin, q, 'o.store_id');
    if (req.query.store_id) q.where('o.store_id', Number(req.query.store_id) || 0);
    return q;
  };
  async function report(req) {
    if (!COST_ROLES.includes(req.admin.role)) throw fail(403, 'err.forbidden');
    const p = period(req.query);
    const scope = scoped(req);
    const rows = await sellerNumbers(db, scope, p);
    const people = rows.size ? await db('admins as a').leftJoin('stores as s', 's.id', 'a.store_id').whereIn('a.id', [...rows.keys()])
      .select('a.id', 'a.email', 'a.role', 'a.store_id', 'a.disabled_at', 'a.commission_percent', 's.commission_percent as store_percent') : [];
    const who = new Map(people.map((a) => [a.id, a]));
    const sellers = [...rows.values()].map((x) => {
      const a = who.get(x.seller_id) ?? {};
      return { ...x, email: a.email ?? null, role: a.role ?? null, store_id: a.store_id ?? null, disabled: a.disabled_at != null,
        personal_percent: a.commission_percent ?? null, percent: a.commission_percent ?? a.store_percent ?? null };
    }).sort((a, b) => b.commission - a.commission || b.sum - a.sum || a.seller_id - b.seller_id);
    // Paid orders nobody sold yet (online, not handed over), counted on their payment day.
    const [none] = await scope(db('orders as o')).whereNull('o.seller_id').where('o.payment_status', 'paid').whereNot('o.status', 'cancelled')
      .where('o.paid_at', '>=', iso(p.start)).where('o.paid_at', '<', iso(p.end)).count({ n: '*' }).sum({ sum: db.raw('o.total - o.delivery_fee') });
    const totals = sellers.reduce((s, x) => {
      for (const k of ['orders', 'sum', 'returns', 'refunded', 'commission']) s[k] += x[k];
      return s;
    }, blank(undefined));
    delete totals.seller_id;
    return { from: p.from, to: p.to, sellers, totals, no_seller: { orders: Number(none.n), sum: Number(none.sum ?? 0) } };
  }

  r.get('/sellers', async (req, res) => res.json(await report(req)));
  r.get('/sellers/export', async (req, res) => {
    const rep = await report(req);
    const tr = (key) => t(key, {}, langOf(req));
    const csv = toCsv([
      [tr('adm.sellers.seller'), tr('field.role'), tr('adm.sellers.orders'), tr('adm.sellers.sum'), tr('adm.sellers.returns'), tr('adm.sellers.refunded'), tr('adm.sellers.percent'), tr('adm.sellers.commission')],
      ...rep.sellers.map((x) => [x.email, x.role && tr(`adm.role_${x.role}`), x.orders, x.sum, x.returns, x.refunded, x.percent, x.commission]),
      [tr('adm.sellers.total'), '', rep.totals.orders, rep.totals.sum, rep.totals.returns, rep.totals.refunded, '', rep.totals.commission],
      [tr('adm.sellers.none'), '', rep.no_seller.orders, rep.no_seller.sum, '', '', '', ''],
    ]);
    res.type('text/csv; charset=utf-8').attachment(`sellers-${rep.from}-${rep.to}.csv`).send(csv);
  });

  // "Mening sotuvlarim": the caller's own numbers, whoever they are; nobody else's ever.
  r.get('/me/sales', async (req, res) => {
    const p = staffPeriod(req.query.period);
    const n = (await sellerNumbers(db, (q) => inStores(req.admin, q, 'o.store_id'), p, req.admin.id)).get(req.admin.id) ?? blank(req.admin.id);
    const a = await db('admins as a').leftJoin('stores as s', 's.id', 'a.store_id').where('a.id', req.admin.id).first('a.commission_percent', 's.commission_percent as store_percent');
    const { seller_id: _, ...own } = n;
    res.json({ period: req.query.period ?? 'month', from: p.from, to: p.to, ...own, percent: a.commission_percent ?? a.store_percent ?? null });
  });
}
