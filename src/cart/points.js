// Task 34: cashback points. Points are integer so'm of one organisation, kept in points_ledger; a balance is the sum
// of the customer's rows, never a stored number. Every row carries a unique ref tied to one order or one return, and is
// inserted with ON CONFLICT DO NOTHING inside the transaction that made the change, so a status set twice, a double
// submit or two parallel requests can't earn, spend or give back twice. The server computes every amount.
// Order of discounts: item price (discount_price) → outfit bundle → promo code → points. Points pay only the goods
// (never the delivery fee), at most points_max_share % of them, and are earned on the money paid for the goods.
import { randomBytes } from 'node:crypto';
import { fail, msOf } from '../admin/routes.js';
import { fmt, t } from '../../public/shared/i18n.js';
import { planState } from '../plans.js';

export const PERCENT_MAX = 20;

// The store's organisation settings, or null when points are off there (cashback 0 %, or a store without an organisation).
export async function pointsConfig(q, storeId) {
  const g = await q('stores as s').join('organizations as g', 'g.id', 's.organization_id').where('s.id', storeId)
    .first('g.id', 'g.cashback_percent', 'g.points_max_share', 'g.plan');
  // Task 45: a plan without points switches earning and spending off; the ledger stays and counts again with the plan.
  return g?.cashback_percent > 0 && planState(g).features.includes('points') ? { orgId: g.id, percent: g.cashback_percent, share: g.points_max_share } : null;
}

export const balanceOf = async (q, profileId) => Number((await q('points_ledger').where({ profile_id: profileId }).sum({ n: 'amount' }))[0].n ?? 0);
// What points may pay of these goods: the share cap, never more than a positive balance.
export const maxSpend = (goods, balance, share) => Math.max(0, Math.min(balance, Math.floor((goods * share) / 100)));

const add = (trx, row) => trx('points_ledger').insert(row).onConflict('ref').ignore();
// Locks the profile row (a no-op UPDATE) for the rest of the transaction; 0 when the profile is gone or another
// organisation's. Spending, the expiry sweep and a correction all take it first, so they queue per customer.
const lockProfile = (trx, profileId, orgId) => trx('customer_profiles').where({ id: profileId, organization_id: orgId }).update({ updated_at: trx.ref('updated_at') });

// Checkout: `want` so'm of points on goods worth `goods` (after bundle and promo). The UPDATE locks the profile row, so
// two checkouts of one customer queue here and the second sees the first one's spend in the balance it reads next.
// Throws 409 rather than charging a different total than the customer saw.
export async function checkSpend(trx, cfg, profileId, goods, want) {
  if (!cfg || !profileId || !(await lockProfile(trx, profileId, cfg.orgId))) {
    throw fail(409, 'err.points_unavailable');
  }
  const cap = Math.floor((goods * cfg.share) / 100);
  if (want > cap) throw fail(409, 'err.points_cap', { sum: fmt.num(cap) });
  if (want > (await balanceOf(trx, profileId))) throw fail(409, 'err.points_balance');
}
export const spend = (trx, cfg, profileId, orderId, amount) =>
  add(trx, { organization_id: cfg.orgId, profile_id: profileId, order_id: orderId, kind: 'spend', amount: -amount, ref: `spend:${orderId}` });

// A cancelled or expired order gives its spent points back. Called by the step that claimed the cancellation.
export async function refundSpent(trx, orderId) {
  const s = await trx('points_ledger').where({ ref: `spend:${orderId}` }).first();
  if (s) await add(trx, { organization_id: s.organization_id, profile_id: s.profile_id, order_id: orderId, kind: 'refund', amount: -s.amount, ref: `refund:${orderId}` });
}

// Handed over / delivered: the organisation's current percent of the money paid for the goods (floor), to the profile
// that logged in at checkout, else this organisation's profile with the order's phone (Telegram-verified).
export async function earnPoints(trx, orderId) {
  const o = await trx('orders as o').join('stores as s', 's.id', 'o.store_id').join('organizations as g', 'g.id', 's.organization_id').where('o.id', orderId)
    .first('o.id', 'o.total', 'o.delivery_fee', 'o.phone', 'o.profile_id', 'g.id as org', 'g.cashback_percent', 'g.plan');
  const amount = o?.cashback_percent > 0 && planState(o).features.includes('points') ? Math.floor(((o.total - o.delivery_fee) * o.cashback_percent) / 100) : 0;
  if (amount < 1) return 0;
  const mine = trx('customer_profiles').where({ organization_id: o.org });
  const p = (o.profile_id && await mine.clone().where({ id: o.profile_id }).first('id')) || await mine.clone().where({ phone: o.phone }).orderBy('id', 'desc').first('id');
  if (!p) return 0;
  await add(trx, { organization_id: o.org, profile_id: p.id, order_id: o.id, kind: 'earn', amount, ref: `earn:${o.id}` });
  return amount;
}

// A return (not an exchange) of a delivered order, after its order_returns row and returned units are written:
// the points spent on these units come back, and the points earned on the refunded money go. Both are cumulative over
// the order's returns, so splitting a return into parts takes and gives exactly what one return of all of it would.
// The balance may go below zero when the earned points were already spent; it then blocks spending until earned back.
export async function returnPoints(trx, ret) {
  if (ret.kind !== 'return') return;
  const line = await trx('order_items').where({ id: ret.order_item_id }).first('quantity', 'points');
  const s = line.points > 0 && await trx('points_ledger').where({ ref: `spend:${ret.order_id}` }).first();
  if (s) {
    const [{ n }] = await trx('order_returns').where({ order_item_id: ret.order_item_id, kind: 'return' }).sum({ n: 'quantity' });
    const after = Number(n), before = after - ret.quantity;
    const back = Math.floor((line.points * after) / line.quantity) - Math.floor((line.points * before) / line.quantity);
    if (back > 0) await add(trx, { organization_id: s.organization_id, profile_id: s.profile_id, order_id: ret.order_id, kind: 'return', amount: back, ref: `return:${ret.id}` });
  }
  const e = await trx('points_ledger').where({ ref: `earn:${ret.order_id}` }).first();
  if (!e) return;
  const o = await trx('orders').where({ id: ret.order_id }).first('total', 'delivery_fee');
  const [{ r }] = await trx('order_returns').where({ order_id: ret.order_id, kind: 'return' }).sum({ r: 'refund' });
  const [{ c }] = await trx('points_ledger').where({ order_id: ret.order_id, kind: 'clawback' }).sum({ c: 'amount' });
  const target = Math.min(e.amount, Math.ceil((e.amount * Number(r)) / (o.total - o.delivery_fee)));
  const take = target + Number(c ?? 0); // clawbacks are negative
  if (take > 0) await add(trx, { organization_id: e.organization_id, profile_id: e.profile_id, order_id: ret.order_id, kind: 'clawback', amount: -take, ref: `clawback:${ret.id}` });
}

// Balance and the newest rows with their order number (none for an expiry or a correction), for the profile page,
// the bot and the admin. A correction shows its reason.
export async function pointsView(q, profileId, limit = 20) {
  const history = await q('points_ledger as l').leftJoin('orders as o', 'o.id', 'l.order_id').leftJoin('stores as s', 's.id', 'o.store_id')
    .where('l.profile_id', profileId).orderBy('l.id', 'desc').limit(limit)
    .select('l.kind', 'l.amount', 'l.created_at', 'l.note', 'o.number', 's.name as store_name');
  return { balance: await balanceOf(q, profileId), history };
}

// --- Task 39: expiry. Points expire N months (organizations.points_expiry_months, 0 = off) after they came in.
// What is left of each incoming row is a "lot", worked out by replaying the customer's ledger in row order (FIFO):
// a positive row (earn, refund, return, a correction up) adds a lot dated by its row; it first pays off any part of
// the balance that is below zero. A negative row (spend, clawback, expire, a correction down) uses up the oldest lots
// first; what no lot covers puts the balance below zero. So the lots always add up to max(0, balance), and a balance
// at or below zero has nothing to expire. Points given back (a cancelled order's spend, a returned unit) and points
// added by a correction come in as new lots with a full term. A lot counts from points_expiry_since at the earliest,
// so points from before expiry was turned on get a full term from that day.
const DAY_MS = 24 * 60 * 60 * 1000;
export const REMIND_DAYS = 7;
export const EXPIRY_MAX = 36;
// Calendar months in UTC; the 31st plus one month is the last day of the shorter month.
export function addMonths(ms, n) {
  const d = new Date(ms), day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  return d.getTime();
}
// rows: the profile's ledger rows in id order → [{ id, left, expires }] oldest first.
export function lotsOf(rows, months, since) {
  const lots = [];
  let debt = 0;
  for (const r of rows) {
    if (r.amount > 0) {
      const paid = Math.min(debt, r.amount);
      debt -= paid;
      if (r.amount > paid) lots.push({ id: r.id, left: r.amount - paid, expires: addMonths(Math.max(msOf(r.created_at), since), months) });
      continue;
    }
    let take = -r.amount;
    while (take > 0 && lots.length) {
      const k = Math.min(take, lots[0].left);
      lots[0].left -= k;
      take -= k;
      if (!lots[0].left) lots.shift();
    }
    debt += take;
  }
  return lots;
}
const ledgerRows = (q, profileId) => q('points_ledger').where({ profile_id: profileId }).orderBy('id').select('id', 'amount', 'created_at');
const sinceOf = (g) => (g.points_expiry_since ? msOf(g.points_expiry_since) : 0);
const expiringOrgs = (db) => db('organizations').where('points_expiry_months', '>', 0).select('id', 'name', 'points_expiry_months', 'points_expiry_since');
// Profiles of the organisation that may have a lot expiring by `until`: a positive balance and a positive row old
// enough (a few days of slack for month lengths; lotsOf decides exactly).
function candidates(db, g, until) {
  const oldest = new Date(Math.min(addMonths(until, -g.points_expiry_months) + 4 * DAY_MS, until)).toISOString();
  if (sinceOf(g) > Date.parse(oldest)) return [];
  return db('points_ledger').where({ organization_id: g.id }).groupBy('profile_id').havingRaw('sum(amount) > 0')
    .whereIn('profile_id', db('points_ledger').where({ organization_id: g.id }).where('amount', '>', 0).where('created_at', '<=', oldest).select('profile_id'))
    .pluck('profile_id');
}

// One customer: the lots due by `now` become one 'expire' row, inside a transaction that holds the profile-row lock
// (the same one checkout spends under), so a sweep beside a checkout sees its spend or makes it fail with 409
// points_balance, never both. The ref names the newest lot expired; a lot is expired whole, so the same ref can't come
// twice and a second or parallel sweep finds nothing left or hits the unique ref.
export function expireProfile(db, g, profileId, now = Date.now()) {
  return db.transaction(async (trx) => {
    if (!(await lockProfile(trx, profileId, g.id))) return 0;
    const due = lotsOf(await ledgerRows(trx, profileId), g.points_expiry_months, sinceOf(g)).filter((l) => l.expires <= now);
    const amount = due.reduce((s, l) => s + l.left, 0);
    if (amount < 1) return 0;
    await add(trx, { organization_id: g.id, profile_id: profileId, order_id: null, kind: 'expire', amount: -amount, ref: `expire:${due.at(-1).id}` });
    return amount;
  });
}
// The sweep (server.js, hourly). Safe to run twice and in several processes. → so'm expired.
// shortcut: one transaction per candidate profile; batch them if an organisation ever has very many points customers.
export async function expirePoints(db, now = Date.now()) {
  let total = 0;
  for (const g of await expiringOrgs(db)) {
    for (const id of await candidates(db, g, now)) total += await expireProfile(db, g, id, now);
  }
  return total;
}

// What expires next: the earliest lot and the ones within a day of it → { amount, at } or null (expiry off / nothing).
export async function nextExpiry(q, profileId, orgId, now = Date.now()) {
  const g = await q('organizations').where({ id: orgId }).first('points_expiry_months', 'points_expiry_since');
  if (!g?.points_expiry_months) return null;
  const lots = lotsOf(await ledgerRows(q, profileId), g.points_expiry_months, sinceOf(g)).filter((l) => l.expires > now);
  if (!lots.length) return null;
  const at = lots[0].expires;
  return { amount: lots.filter((l) => l.expires < at + DAY_MS).reduce((s, l) => s + l.left, 0), at: new Date(at).toISOString() };
}

// The Telegram reminder, REMIND_DAYS before: one message per batch, i.e. per set of lots coming due in that window;
// customer_profiles.points_reminded_lot keeps the newest lot told about, claimed by a conditional UPDATE before the
// message goes, so a second round or process doesn't send it again. A network error gives the claim back (next round
// retries); 400/403 (bot blocked) keeps it. Called from the notifier loop, so only where the bot is on.
export async function remindExpiring(db, telegram, now = Date.now()) {
  if (!telegram) return;
  for (const g of await expiringOrgs(db)) {
    for (const id of await candidates(db, g, now + REMIND_DAYS * DAY_MS)) {
      const p = await db('customer_profiles').where({ id }).first('id', 'telegram_user_id', 'lang', 'points_reminded_lot');
      const soon = lotsOf(await ledgerRows(db, id), g.points_expiry_months, sinceOf(g)).filter((l) => l.expires > now && l.expires <= now + REMIND_DAYS * DAY_MS);
      const last = soon.at(-1)?.id;
      if (!p || !last || last <= (p.points_reminded_lot ?? 0)) continue;
      const mine = () => db('customer_profiles').where({ id });
      if (!(await mine().where((w) => w.whereNull('points_reminded_lot').orWhere('points_reminded_lot', '<', last)).update({ points_reminded_lot: last }))) continue;
      const sum = soon.reduce((s, l) => s + l.left, 0);
      try {
        await telegram(p.telegram_user_id, t('kiosk.bot.points_expire', { org: g.name, sum: fmt.num(sum), date: fmt.date(new Date(soon[0].expires).toISOString()) }, p.lang));
      } catch (err) {
        console.error(`telegram: points reminder for profile ${id} not sent:`, err.message);
        if (err.code !== 403 && err.code !== 400) await mine().where({ points_reminded_lot: last }).update({ points_reminded_lot: p.points_reminded_lot });
      }
    }
  }
}

// --- Task 39: an owner's correction. A signed amount with a reason, under the profile-row lock; it may not take the
// balance below zero (a balance already below zero can still be raised). Added points are a lot like earned ones and
// expire the same way; taken points use up the oldest lots first.
export const ADJUST_MAX = 10_000_000;
export function adjustPoints(db, { orgId, profileId, amount, note, adminId }, audit) {
  return db.transaction(async (trx) => {
    if (!(await lockProfile(trx, profileId, orgId))) throw fail(404, 'err.not_found');
    const before = await balanceOf(trx, profileId);
    if (amount < 0 && before + amount < 0) throw fail(409, 'err.points_below_zero', { sum: fmt.num(Math.max(0, before)) });
    await add(trx, { organization_id: orgId, profile_id: profileId, order_id: null, kind: 'adjust', amount, ref: `adjust:${randomBytes(12).toString('hex')}`, admin_id: adminId, note });
    await audit(trx, { before: { balance: before }, after: { balance: before + amount, amount, reason: note } });
    return before + amount;
  });
}
