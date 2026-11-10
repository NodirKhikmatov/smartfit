// Task 34: cashback points. Points are integer so'm of one organisation, kept in points_ledger; a balance is the sum
// of the customer's rows, never a stored number. Every row carries a unique ref tied to one order or one return, and is
// inserted with ON CONFLICT DO NOTHING inside the transaction that made the change, so a status set twice, a double
// submit or two parallel requests can't earn, spend or give back twice. The server computes every amount.
// Order of discounts: item price (discount_price) → outfit bundle → promo code → points. Points pay only the goods
// (never the delivery fee), at most points_max_share % of them, and are earned on the money paid for the goods.
import { fail } from '../admin/routes.js';
import { fmt } from '../../public/shared/i18n.js';

export const PERCENT_MAX = 20;

// The store's organisation settings, or null when points are off there (cashback 0 %, or a store without an organisation).
export async function pointsConfig(q, storeId) {
  const g = await q('stores as s').join('organizations as g', 'g.id', 's.organization_id').where('s.id', storeId)
    .first('g.id', 'g.cashback_percent', 'g.points_max_share');
  return g?.cashback_percent > 0 ? { orgId: g.id, percent: g.cashback_percent, share: g.points_max_share } : null;
}

export const balanceOf = async (q, profileId) => Number((await q('points_ledger').where({ profile_id: profileId }).sum({ n: 'amount' }))[0].n ?? 0);
// What points may pay of these goods: the share cap, never more than a positive balance.
export const maxSpend = (goods, balance, share) => Math.max(0, Math.min(balance, Math.floor((goods * share) / 100)));

const add = (trx, row) => trx('points_ledger').insert(row).onConflict('ref').ignore();

// Checkout: `want` so'm of points on goods worth `goods` (after bundle and promo). The UPDATE locks the profile row, so
// two checkouts of one customer queue here and the second sees the first one's spend in the balance it reads next.
// Throws 409 rather than charging a different total than the customer saw.
export async function checkSpend(trx, cfg, profileId, goods, want) {
  if (!cfg || !profileId || !(await trx('customer_profiles').where({ id: profileId, organization_id: cfg.orgId }).update({ updated_at: trx.ref('updated_at') }))) {
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
    .first('o.id', 'o.total', 'o.delivery_fee', 'o.phone', 'o.profile_id', 'g.id as org', 'g.cashback_percent');
  const amount = o?.cashback_percent > 0 ? Math.floor(((o.total - o.delivery_fee) * o.cashback_percent) / 100) : 0;
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

// Balance and the newest rows with their order number, for the profile page, the bot and the admin.
export async function pointsView(q, profileId, limit = 20) {
  const history = await q('points_ledger as l').join('orders as o', 'o.id', 'l.order_id').join('stores as s', 's.id', 'o.store_id')
    .where('l.profile_id', profileId).orderBy('l.id', 'desc').limit(limit)
    .select('l.kind', 'l.amount', 'l.created_at', 'o.number', 's.name as store_name');
  return { balance: await balanceOf(q, profileId), history };
}
