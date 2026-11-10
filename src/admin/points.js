// Task 34: cashback points in admin. The setting belongs to the organisation (all its stores share one balance per
// customer); the store picked in admin names the organisation. The customer list holds names and phones, so it is for
// that organisation's owner and managers (and super) only: a manager sees the customers with points from orders of
// their own store. Staff and mall admins never get here (their route gates deny by default).
import { fail, int, inStores } from './routes.js';
import { audit, diff } from './audit.js';
import { PERCENT_MAX } from '../cart/points.js';
import { stamp } from '../cart/cart.js';

const LIST_MAX = 200; // shortcut: the biggest balances only, no search or paging; add both when an organisation outgrows it

export function pointsRoutes(r, db, { resolveStore }) {
  async function orgOf(req, storeId) {
    if (!['super', 'owner', 'manager'].includes(req.admin.role)) throw fail(403, 'err.forbidden');
    const s = await db('stores as s').join('organizations as g', 'g.id', 's.organization_id').where('s.id', await resolveStore(db, req.admin, storeId))
      .first('s.id as store_id', 'g.id', 'g.cashback_percent', 'g.points_max_share');
    if (!s) throw fail(404, 'err.store_not_found');
    return s;
  }
  const settingsOf = (g) => ({ cashback_percent: g.cashback_percent, points_max_share: g.points_max_share });

  // ?store_id → { cashback_percent, points_max_share, can_edit, outstanding, count, customers: [{ id, name, phone, balance, earned, spent, last_at }] }
  r.get('/points', async (req, res) => {
    const g = await orgOf(req, req.query.store_id);
    const mine = inStores(req.admin, db('points_ledger as m').join('orders as o', 'o.id', 'm.order_id').where('m.organization_id', g.id), 'o.store_id').select('m.profile_id');
    const rows = (await db('customer_profiles as p').join('points_ledger as l', 'l.profile_id', 'p.id')
      .where('p.organization_id', g.id).whereIn('p.id', mine).groupBy('p.id', 'p.name', 'p.phone')
      .select('p.id', 'p.name', 'p.phone', db.raw('sum(l.amount) as balance'),
        db.raw("sum(case when l.kind = 'earn' then l.amount else 0 end) as earned"),
        db.raw("sum(case when l.kind in ('spend', 'refund') then -l.amount else 0 end) as spent"), db.raw('max(l.created_at) as last_at')))
      .map((c) => ({ ...c, balance: Number(c.balance), earned: Number(c.earned), spent: Number(c.spent), last_at: stamp(c.last_at) }))
      .sort((a, b) => b.balance - a.balance || b.id - a.id);
    res.json({
      ...settingsOf(g), can_edit: req.admin.role !== 'manager',
      outstanding: rows.reduce((s, c) => s + Math.max(0, c.balance), 0), // what customers can still spend; a negative balance owes nothing
      count: rows.length, customers: rows.slice(0, LIST_MAX),
    });
  });

  // { store_id?, cashback_percent: 0–20 (0 = off), points_max_share: 0–100 } for the store's organisation. Owner or super.
  r.patch('/points', async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const g = await orgOf(req, b.store_id);
    if (req.admin.role === 'manager') throw fail(403, 'err.forbidden');
    const before = settingsOf(g);
    const next = {
      cashback_percent: int(b.cashback_percent ?? before.cashback_percent, 0, PERCENT_MAX, 'field.cashback_percent'),
      points_max_share: int(b.points_max_share ?? before.points_max_share, 0, 100, 'field.points_max_share'),
    };
    const d = diff(before, next);
    if (d) {
      await db.transaction(async (trx) => {
        await trx('organizations').where({ id: g.id }).update(next);
        await audit(trx, req.admin, { action: 'org.points', storeId: g.store_id, entityId: g.id, ...d });
      });
    }
    res.json({ ...next, can_edit: true });
  });
}
