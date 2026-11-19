// Task 51: closing the day at the cashier ("Kassani yopish"). Per store and Tashkent day: sales by method, points spent,
// discounts, refunds and the cash that should be in the drawer; the manager types the counted cash, and the difference
// and a note are saved with a copy of the numbers. A closed day is fixed: its report is that copy from then on.
//
// The day: Asia/Tashkent midnight to midnight, cut by closings. A day closed before midnight ends at its closing, and
// what happens after it (a late sale, a refund) belongs to the next day. Every event counts at its own time: a sale when
// it was paid (paid_at), a return when it was made, a paid order's cancel (its whole total back) when it was cancelled.
// Method: the cashier's (cash | card | instalment), else the online provider (click | payme); a cashier order paid before
// this task has none ("unknown": counted in the totals, never in the drawer). A refund goes back the way the order was
// paid, so only a cash order's refund leaves the drawer: expected cash = cash sales − cash refunds (no opening float).
// Owners, managers and supers read and close their stores (canSee); staff and the mall role never reach these routes.
import { fail, canSee, inStores, dayKey, dayStart, msOf, DAY_MS, text, int, paging } from './routes.js';
import { COST_ROLES } from './profit.js';
import { dbTime } from '../recommend/routes.js';
import { audit } from './audit.js';

export const METHODS = ['cash', 'card', 'click', 'payme', 'instalment', 'unknown'];
export const PAID_WITH = ['cash', 'card', 'instalment']; // what the cashier can say
const COUNTED_MAX = 2_000_000_000; // integer column
const iso = (ms) => new Date(ms).toISOString(); // paid_at / cancelled_at are written as ISO strings (cart.js)
export const methodOf = (o) => {
  const m = o.paid_with ?? (o.payment_method === 'cashier' ? 'unknown' : o.payment_method);
  return METHODS.includes(m) ? m : 'unknown';
};

// dbTime keeps whole seconds; Postgres keeps milliseconds. Both bounds round up, so a cut at "now" still takes this
// second's returns and two days that meet at a cut neither overlap nor leave a gap.
const upSec = (ms) => Math.ceil(ms / 1000) * 1000;

// The numbers for one store over [start, end).
export async function dayNumbers(db, storeId, { start, end }) {
  const sales = Object.fromEntries(METHODS.map((m) => [m, { orders: 0, sum: 0 }]));
  const refunds = Object.fromEntries(METHODS.map((m) => [m, 0]));
  let points = 0, discounts = 0;
  const cols = ['total', 'paid_with', 'payment_method'];
  for (const o of await db('orders').where({ store_id: storeId }).where('paid_at', '>=', iso(start)).where('paid_at', '<', iso(end))
    .select(...cols, 'points_discount', 'bundle_discount', 'promo_discount')) {
    const s = sales[methodOf(o)];
    s.orders++;
    s.sum += o.total;
    points += o.points_discount;
    discounts += o.bundle_discount + o.promo_discount;
  }
  for (const o of await db('orders').where({ store_id: storeId }).where('cancelled_at', '>=', iso(start)).where('cancelled_at', '<', iso(end)).select(...cols)) {
    refunds[methodOf(o)] += o.total;
  }
  for (const x of await db('order_returns as x').join('orders as o', 'o.id', 'x.order_id').where('o.store_id', storeId).where('x.kind', 'return')
    .where('x.created_at', '>=', dbTime(upSec(start))).where('x.created_at', '<', dbTime(upSec(end))).select('x.refund', 'o.paid_with', 'o.payment_method')) {
    refunds[methodOf(x)] += x.refund;
  }
  const sum = (vals) => vals.reduce((a, b) => a + b, 0);
  const salesTotal = sum(Object.values(sales).map((s) => s.sum)), refundsTotal = sum(Object.values(refunds));
  return { sales, refunds, points, discounts, sales_total: salesTotal, refunds_total: refundsTotal, net: salesTotal - refundsTotal, expected_cash: sales.cash.sum - refunds.cash };
}

// Where the day starts: midnight, or the previous day's closing if that came before midnight.
async function windowOf(db, storeId, day) {
  let start = dayStart(day);
  const prev = await db('cash_closings').where({ store_id: storeId, day: dayKey(start - DAY_MS) }).first('closed_at');
  if (prev && msOf(prev.closed_at) < start) start = msOf(prev.closed_at);
  return { start, end: dayStart(day) + DAY_MS };
}

const closingView = (c) => ({ id: c.id, store_id: c.store_id, store_name: c.store_name, day: c.day, closed_at: iso(msOf(c.closed_at)), closed_by: c.closed_by, closed_email: c.closed_email ?? null,
  expected_cash: c.expected_cash, counted_cash: c.counted_cash, difference: c.difference, note: c.note });
const closings = (db) => db('cash_closings as c').join('stores as s', 's.id', 'c.store_id').leftJoin('admins as a', 'a.id', 'c.closed_by')
  .select('c.*', 's.name as store_name', 'a.email as closed_email');

export function cashRoutes(r, db) {
  // { store_id?, day? } → a store the caller sees (the only one if they have one) and a Tashkent day up to today.
  async function target(req, src) {
    if (!COST_ROLES.includes(req.admin.role)) throw fail(403, 'err.forbidden');
    const only = req.admin.stores?.length === 1 ? req.admin.stores[0] : null;
    const storeId = src.store_id == null || src.store_id === '' ? only : Number(src.store_id);
    if (storeId == null) throw fail(400, 'err.required', { field: 'common.store' });
    if (!Number.isInteger(storeId) || !canSee(req.admin, storeId) || !(await db('stores').where({ id: storeId }).first('id'))) throw fail(404, 'err.store_not_found');
    const today = dayKey(Date.now()), day = src.day || today;
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(dayStart(day)) || dayKey(dayStart(day)) !== day || day > today) {
      throw fail(400, 'err.invalid', { field: 'field.date' });
    }
    return { storeId, day };
  }
  async function report(storeId, day, now = Date.now()) {
    const c = await closings(db).where({ 'c.store_id': storeId, 'c.day': day }).first();
    if (c) return { ...JSON.parse(c.report), closed: closingView(c) };
    const w = await windowOf(db, storeId, day);
    w.end = Math.min(w.end, now);
    return { store_id: storeId, day, from: iso(w.start), to: iso(Math.max(w.start, w.end)), ...(await dayNumbers(db, storeId, w)), closed: null };
  }

  r.get('/cash', async (req, res) => {
    const { storeId, day } = await target(req, req.query);
    res.json(await report(storeId, day));
  });

  // { store_id?, day?, counted, note? }: once per store and day; the report is copied as it is now.
  r.post('/cash/close', async (req, res) => {
    const b = req.body ?? {};
    const { storeId, day } = await target(req, b);
    const counted = int(b.counted, 0, COUNTED_MAX, 'field.counted_cash');
    const note = text(b.note, 500, 'field.note', false);
    const taken = () => db('cash_closings').where({ store_id: storeId, day }).first('id');
    if (await taken()) throw fail(409, 'err.day_closed');
    const now = Date.now(); // the cut: a day closed before midnight ends here, and the next one starts here
    const { closed: _, ...rep } = await report(storeId, day, now);
    try {
      await db.transaction(async (trx) => {
        const row = { store_id: storeId, day, closed_at: iso(now), closed_by: req.admin.id, expected_cash: rep.expected_cash, counted_cash: counted,
          difference: counted - rep.expected_cash, note, report: JSON.stringify(rep) };
        const [{ id }] = await trx('cash_closings').insert(row).returning('id');
        await audit(trx, req.admin, { action: 'cash.close', storeId, entityId: id, label: day,
          after: { expected_cash: row.expected_cash, counted_cash: counted, difference: row.difference, note } });
      });
    } catch (err) {
      if (await taken()) throw fail(409, 'err.day_closed'); // lost the race to a second click
      throw err;
    }
    res.status(201).json(await report(storeId, day));
  });

  // History, newest day first. ?store_id narrows; it never widens past the caller's stores.
  r.get('/cash/closings', async (req, res) => {
    if (!COST_ROLES.includes(req.admin.role)) throw fail(403, 'err.forbidden');
    const { limit, offset } = paging(req.query);
    const q = inStores(req.admin, db('cash_closings as c'), 'c.store_id');
    if (req.query.store_id) q.where('c.store_id', Number(req.query.store_id) || 0);
    const [{ n }] = await q.clone().count({ n: '*' });
    const items = await closings(db).whereIn('c.id', q.clone().select('c.id')).orderBy('c.day', 'desc').orderBy('c.id', 'desc').limit(limit).offset(offset);
    res.json({ total: Number(n), limit, offset, items: items.map(closingView) });
  });
}
