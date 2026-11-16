// Task 34: cashback points in admin. The setting belongs to the organisation (all its stores share one balance per
// customer); the store picked in admin names the organisation. The customer list holds names and phones, so it is for
// that organisation's owner and managers (and super) only: a manager sees the customers with points from orders of
// their own store. Staff and mall admins never get here (their route gates deny by default).
// Task 39: the expiry setting, a search by name or phone, the list as CSV (same people as the list), and the owner's
// correction of one customer's balance (owner and super only; reason required; never below zero; audited).
import { fail, int, text, inStores, langOf, phoneText } from './routes.js';
import { audit, diff } from './audit.js';
import { toCsv } from './csv.js';
import { PERCENT_MAX, EXPIRY_MAX, ADJUST_MAX, adjustPoints } from '../cart/points.js';
import { stamp } from '../cart/cart.js';
import { t } from '../../public/shared/i18n.js';

const LIST_MAX = 200; // shortcut: the biggest balances only (a search narrows it); add paging when an organisation outgrows it
const EXPORT_MAX = 10000;
const REASON_MAX = 200;

export function pointsRoutes(r, db, { resolveStore }) {
  async function orgOf(req, storeId) {
    if (!['super', 'owner', 'manager'].includes(req.admin.role)) throw fail(403, 'err.forbidden');
    const s = await db('stores as s').join('organizations as g', 'g.id', 's.organization_id').where('s.id', await resolveStore(db, req.admin, storeId))
      .first('s.id as store_id', 'g.id', 'g.cashback_percent', 'g.points_max_share', 'g.points_expiry_months');
    if (!s) throw fail(404, 'err.store_not_found');
    return s;
  }
  const settingsOf = (g) => ({ cashback_percent: g.cashback_percent, points_max_share: g.points_max_share, points_expiry_months: g.points_expiry_months });

  // The organisation's customers with ledger rows (a manager: those with rows on orders of their store), biggest
  // balance first. ?q matches the name (any case) or the phone digits; % and _ are taken out so they match literally.
  async function customers(req, g) {
    const mine = inStores(req.admin, db('points_ledger as m').join('orders as o', 'o.id', 'm.order_id').where('m.organization_id', g.id), 'o.store_id').select('m.profile_id');
    const q = db('customer_profiles as p').join('points_ledger as l', 'l.profile_id', 'p.id')
      .where('p.organization_id', g.id).whereIn('p.id', mine).groupBy('p.id', 'p.name', 'p.phone')
      .select('p.id', 'p.name', 'p.phone', db.raw('sum(l.amount) as balance'),
        db.raw("sum(case when l.kind = 'earn' then l.amount else 0 end) as earned"),
        db.raw("sum(case when l.kind in ('spend', 'refund') then -l.amount else 0 end) as spent"),
        db.raw("sum(case when l.kind = 'expire' then -l.amount else 0 end) as expired"),
        db.raw("sum(case when l.kind = 'adjust' then l.amount else 0 end) as adjusted"), db.raw('max(l.created_at) as last_at'));
    const term = typeof req.query.q === 'string' ? req.query.q.replace(/[%_\\]/g, '').trim().slice(0, 60) : '';
    if (term) {
      const digits = term.replace(/\D/g, '');
      q.where((w) => {
        w.whereRaw('lower(p.name) like ?', [`%${term.toLowerCase()}%`]);
        if (digits.length >= 2) w.orWhere('p.phone', 'like', `%${digits}%`);
      });
    }
    return (await q).map((c) => ({ ...c, balance: Number(c.balance), earned: Number(c.earned), spent: Number(c.spent), expired: Number(c.expired), adjusted: Number(c.adjusted), last_at: stamp(c.last_at) }))
      .sort((a, b) => b.balance - a.balance || b.id - a.id);
  }

  // ?store_id&q → { cashback_percent, points_max_share, points_expiry_months, can_edit, outstanding, count,
  //   customers: [{ id, name, phone, balance, earned, spent, expired, adjusted, last_at }] } (outstanding/count: of the search)
  r.get('/points', async (req, res) => {
    const g = await orgOf(req, req.query.store_id);
    const rows = await customers(req, g);
    res.json({
      ...settingsOf(g), can_edit: req.admin.role !== 'manager',
      outstanding: rows.reduce((s, c) => s + Math.max(0, c.balance), 0), // what customers can still spend; a negative balance owes nothing
      count: rows.length, customers: rows.slice(0, LIST_MAX),
    });
  });

  // The same list (same scope and search) as a CSV file for Excel; names are customer-typed, toCsv escapes formulas.
  r.get('/points/export', async (req, res) => {
    const g = await orgOf(req, req.query.store_id);
    const tr = (key) => t(key, {}, langOf(req));
    const rows = (await customers(req, g)).slice(0, EXPORT_MAX);
    res.type('text/csv; charset=utf-8').attachment(`points-${new Date().toISOString().slice(0, 10)}.csv`).send(toCsv([
      [tr('adm.points.customer'), tr('adm.csv.phone'), tr('adm.points.balance'), tr('adm.points.earned'), tr('adm.points.spent'), tr('adm.points.expired'), tr('adm.points.adjusted'), tr('adm.points.last')],
      ...rows.map((c) => [c.name, phoneText(c.phone), c.balance, c.earned, c.spent, c.expired, c.adjusted, c.last_at ? new Date(c.last_at).toLocaleString('sv-SE', { timeZone: 'Asia/Tashkent' }).slice(0, 16) : '']),
    ]));
  });

  // { store_id?, profile_id, amount: ±integer (not 0, |amount| ≤ 10 000 000), reason: 3–200 chars } → { balance }.
  // Owner (any store of their organisation) or super; a manager 403; a profile of another organisation 404.
  r.post('/points/adjust', async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const g = await orgOf(req, b.store_id);
    if (req.admin.role === 'manager') throw fail(403, 'err.forbidden');
    const amount = int(b.amount, -ADJUST_MAX, ADJUST_MAX, 'field.points_amount');
    if (!amount) throw fail(400, 'err.invalid', { field: 'field.points_amount' });
    const reason = text(b.reason, REASON_MAX, 'field.points_reason', true);
    if (reason.length < 3) throw fail(400, 'err.invalid', { field: 'field.points_reason' });
    const profileId = Number.isInteger(b.profile_id) ? b.profile_id : 0;
    const balance = await adjustPoints(db, { orgId: g.id, profileId, amount, note: reason, adminId: req.admin.id },
      (trx, d) => audit(trx, req.admin, { action: 'points.adjust', storeId: g.store_id, entityId: profileId, ...d }));
    res.json({ balance });
  });

  // { store_id?, cashback_percent: 0–20 (0 = off), points_max_share: 0–100, points_expiry_months: 0–36 (0 = off) }
  // for the store's organisation. Owner or super. Turning expiry on stamps points_expiry_since (older points count from now).
  r.patch('/points', async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const g = await orgOf(req, b.store_id);
    if (req.admin.role === 'manager') throw fail(403, 'err.forbidden');
    const before = settingsOf(g);
    const next = {
      cashback_percent: int(b.cashback_percent ?? before.cashback_percent, 0, PERCENT_MAX, 'field.cashback_percent'),
      points_max_share: int(b.points_max_share ?? before.points_max_share, 0, 100, 'field.points_max_share'),
      points_expiry_months: int(b.points_expiry_months ?? before.points_expiry_months, 0, EXPIRY_MAX, 'field.points_expiry'),
    };
    const d = diff(before, next);
    if (d) {
      await db.transaction(async (trx) => {
        const on = !before.points_expiry_months && next.points_expiry_months ? { points_expiry_since: new Date().toISOString() } : {};
        await trx('organizations').where({ id: g.id }).update({ ...next, ...on });
        await audit(trx, req.admin, { action: 'org.points', storeId: g.store_id, entityId: g.id, ...d });
      });
    }
    res.json({ ...next, can_edit: true });
  });
}
