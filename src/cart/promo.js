// Task 26: promo codes and the "whole outfit" bundle discount. Every amount is integer so'm computed here, never sent
// by the client. Order: bundle first (on the outfit's items), then at most one promo code on what is left, so the
// customer never gets a percent of money already taken off. Rounding is down (floor), never below 0.
import { fail } from '../admin/routes.js';

export const CODE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
export const normCode = (v) => (typeof v === 'string' ? v.trim().toUpperCase() : '');
const iso = (ms) => new Date(ms).toISOString();

// d split over amounts in proportion (largest remainder), each share ≤ its amount, shares sum to exactly d.
export function spread(amounts, d) {
  const sum = amounts.reduce((a, b) => a + b, 0);
  if (!sum || !d) return amounts.map(() => 0);
  const raw = amounts.map((a) => (a * d) / sum);
  const out = raw.map(Math.floor);
  let left = d - out.reduce((a, b) => a + b, 0);
  for (const i of raw.map((r, i) => i).sort((a, b) => raw[b] - out[b] - (raw[a] - out[a]))) {
    if (!left) break;
    if (out[i] < amounts[i]) { out[i] += 1; left -= 1; }
  }
  return out;
}

// lines: [{ product_id, quantity, unit_price }]; bundles: [[product_id, …]] (recommended outfits added whole);
// promo: a valid promo_codes row or null. → { subtotal, bundle_discount, promo_discount, goods, discounts: [per line] }.
// One unit of each line can be in one bundle; a bundle whose items are not all in the cart (or overlap a bundle
// already counted) gives nothing. minOk is false when the promo's minimum (on the amount after the bundle) is not met.
export function price(lines, { bundles = [], bundlePercent = 0, promo = null } = {}) {
  const amounts = lines.map((l) => l.unit_price * l.quantity);
  const subtotal = amounts.reduce((a, b) => a + b, 0);
  const bundleShare = lines.map(() => 0);
  let bundle_discount = 0;
  if (bundlePercent > 0) {
    const used = new Set();
    for (const ids of bundles) {
      const idx = ids.map((id) => lines.findIndex((l) => l.product_id === id));
      if (!ids.length || idx.some((i) => i < 0 || used.has(i))) continue;
      idx.forEach((i) => used.add(i));
      const d = Math.floor((idx.reduce((s, i) => s + lines[i].unit_price, 0) * bundlePercent) / 100);
      spread(idx.map((i) => lines[i].unit_price), d).forEach((x, k) => { bundleShare[idx[k]] += x; });
      bundle_discount += d;
    }
  }
  const afterBundle = subtotal - bundle_discount;
  const minOk = !promo || afterBundle >= promo.min_order;
  const promo_discount = !promo || !minOk ? 0
    : Math.min(afterBundle, promo.kind === 'percent' ? Math.floor((afterBundle * promo.value) / 100) : promo.value);
  const promoShare = spread(amounts.map((a, i) => a - bundleShare[i]), promo_discount);
  return {
    subtotal, bundle_discount, promo_discount, goods: afterBundle - promo_discount, minOk,
    discounts: lines.map((l, i) => bundleShare[i] + promoShare[i]),
  };
}

// The code as typed at this store: one of this store's codes or an organisation-wide one of its organisation.
// Codes of another store or organisation are simply not found.
export async function findPromo(q, store, code) {
  const c = normCode(code);
  if (!CODE.test(c)) return undefined;
  return q('promo_codes').where({ code: c, organization_id: store.organization_id })
    .where((w) => w.whereNull('store_id').orWhere('store_id', store.id)).first();
}

// Usable right now, ignoring the per-phone limit and the minimum (checked with the cart / the phone).
// → null, or the error key: invalid (off, not started, ended) or used_up.
export function promoProblem(p, now = Date.now()) {
  if (!p || !p.active) return 'err.promo_invalid';
  if (p.starts_at && Date.parse(stampOf(p.starts_at)) > now) return 'err.promo_invalid';
  if (p.ends_at && Date.parse(stampOf(p.ends_at)) <= now) return 'err.promo_invalid';
  if (p.max_uses != null && p.used >= p.max_uses) return 'err.promo_used_up';
  return null;
}
const stampOf = (v) => (typeof v === 'string' && !v.includes('T') ? `${v.replace(' ', 'T')}Z` : v instanceof Date ? v.toISOString() : v);

// Checkout: claims one use. The conditional UPDATE locks the code's row, so concurrent checkouts with the same code
// queue here; the per-phone count after it then sees the orders committed before it. Throws (rolling back) when the
// code can't be used by this phone now.
export async function claimPromo(trx, p, phone, now = Date.now()) {
  const n = await trx('promo_codes').where({ id: p.id, active: true })
    .where((w) => w.whereNull('starts_at').orWhere('starts_at', '<=', iso(now)))
    .where((w) => w.whereNull('ends_at').orWhere('ends_at', '>', iso(now)))
    .where((w) => w.whereNull('max_uses').orWhere('used', '<', trx.ref('max_uses')))
    .increment('used', 1);
  if (!n) throw fail(409, promoProblem(await trx('promo_codes').where({ id: p.id }).first(), now) ?? 'err.promo_invalid');
  if (p.max_per_phone != null) {
    const [{ n: mine }] = await trx('orders').where({ promo_code_id: p.id, phone }).whereNot('status', 'cancelled').count({ n: '*' });
    if (Number(mine) >= p.max_per_phone) throw fail(409, 'err.promo_used_up');
  }
}

// A cancelled or expired order gives its use back. Called only by the step that claimed the cancellation, so once.
export async function releasePromo(trx, orderId) {
  const o = await trx('orders').where({ id: orderId }).first('promo_code_id');
  if (o?.promo_code_id) await trx('promo_codes').where({ id: o.promo_code_id }).where('used', '>', 0).decrement('used', 1);
}

// Outfit sets as stored on a recommendation log / cart: sorted id lists, compared as strings.
export const setKey = (ids) => [...ids].sort((a, b) => a - b).join(',');
export const parseJson = (v, dflt) => (v == null ? dflt : typeof v === 'string' ? JSON.parse(v) : v);
