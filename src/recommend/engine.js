import { sizesFor } from '../db/seed.js';
import { fitOf, shiftSize } from '../size/size.js';

// Rule-based outfits. filterCandidates is the only source of items: task 7 sends its output to Claude as CANDIDATES.

export const ORDER = ['outerwear', 'top', 'bottom', 'shoes', 'accessory'];
export const OUTERWEAR_BELOW = 18;
const MAX_OUTFITS = 3;

const sizeKey = { outerwear: 'top', top: 'top', bottom: 'bottom', shoes: 'shoes' };
export const unitPrice = (p) => p.discount_price ?? p.price;
export const totalOf = (items) => items.reduce((sum, i) => sum + i.unit_price, 0);

// Items in this store, for this gender, worn at this temperature, with free stock (quantity − reserved > 0) in the customer's size.
// sizes = { top, bottom, shoes? }. No shoe size → shoes with stock in any size (size: null, picked in the cart).
// Each item carries fit_offset (+1 runs small, -1 runs big) and fit_from (the customer's size when it was shifted).
// spread widens the temperature window to ±spread °C (the relaxation fallback in ruleOutfits).
export async function filterCandidates(db, { storeId, gender, sizes, temperature, spread = 0 }) {
  const rows = await db('products as p')
    .join('product_stock as s', 's.product_id', 'p.id')
    .where('p.store_id', storeId)
    .whereIn('p.gender', [gender, 'unisex'])
    // Live weather is fractional (11.7 °C); Postgres would type the parameter as the integer column and refuse it.
    .whereRaw('p.temp_min <= cast(? as real) and p.temp_max >= cast(? as real)', [temperature + spread, temperature - spread])
    .whereRaw('s.quantity - s.reserved > 0')
    .orderBy(['p.id', 's.id'])
    .select('p.id', 'p.name', 'p.name_ru', 'p.category', 'p.gender', 'p.color', 'p.style', 'p.price', 'p.discount_price', 'p.temp_min', 'p.temp_max', 'p.waterproof', 'p.image_url', 'p.shelf_location', 'p.fit_offset', 's.size');
  // Task 23: a product that runs small or big is offered one size up or down (clamped to its sizes), and only if that
  // size has free stock: never the customer's own size, which is known not to fit.
  const fits = await fitOf(db, [...new Map(rows.map((r) => [r.id, r])).values()]);
  const byId = new Map();
  for (const { fit_offset, ...r } of rows) {
    const own = sizes[sizeKey[r.category]];
    const offset = fits.get(r.id).offset;
    const want = own ? shiftSize(sizesFor(r.category), own, offset) : null;
    if (want && r.size !== want) continue;
    const known = r.category === 'accessory' || own;
    // Several rows per item only when the shoe size is unknown: `sizes` lists them so the customer picks one.
    if (byId.has(r.id)) {
      byId.get(r.id).sizes.push(r.size);
      continue;
    }
    byId.set(r.id, { ...r, waterproof: Boolean(r.waterproof), size: known ? r.size : null, ...(known ? {} : { sizes: [r.size] }), unit_price: unitPrice(r),
      fit_offset: offset, fit_from: want && want !== own ? own : null });
  }
  return [...byId.values()];
}

// Spec colour rule: neutrals go with anything, never two bright colours in one outfit. Brown, cream, olive and
// denim blue count as neutral here too (wardrobe basics).
const NEUTRAL = new Set(['qora', 'oq', 'kulrang', "to'q ko'k", 'bej', 'jigarrang', 'krem', 'zaytun', "ko'k"]);
const bright = (p) => Boolean(p.color) && !NEUTRAL.has(p.color.toLowerCase());

// Lower is better. Rank order first (rain/budget/temperature), then a matching style, and a colour clash only as a last resort.
function pickScore(p, idx, outfit, raining) {
  const clash = bright(p) && outfit.some(bright);
  const style = outfit.length && p.style && outfit[0].style && p.style !== outfit[0].style;
  return idx + (style ? 2 : 0) + (raining && !p.waterproof ? 10 : 0) + (clash ? 50 : 0);
}
const bestFor = (list, outfit, raining) => list.reduce((best, p, i) => {
  const s = pickScore(p, i, outfit, raining);
  return !best || s < best.s ? { p, s } : best;
}, null)?.p;
const byOrder = (a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category);

// Pure: builds up to 3 outfits from candidates, no item shared between outfits (spec). Each outfit is composed:
// the first item sets the style, later ones prefer the same style and a colour that goes with what is already picked.
// skip: categories to leave out (outerwear when the store has none). Returns { outfits, over_budget, partial }:
// over_budget > 0 only when nothing fits the budget, and then `partial` is the required items that do fit.
export function buildOutfits(candidates, { temperature, raining, budget = null, skip = [] }) {
  const required = requiredCategories(temperature, raining).filter((c) => !skip.includes(c));
  const pool = rankPool(candidates, { temperature, raining, budget });
  const used = new Set();
  const free = (c) => pool[c].filter((p) => !used.has(p.id));

  let outfits = [];
  while (outfits.length < MAX_OUTFITS) {
    const items = [];
    for (const c of required) {
      const p = bestFor(free(c), items, raining);
      if (!p) break;
      items.push(p);
    }
    if (items.length < required.length) break;
    items.forEach((p) => used.add(p.id));
    outfits.push(items);
  }
  // Optional accessory: the best unused one that goes with the outfit, only if it keeps the outfit within budget.
  for (const items of outfits) {
    const acc = bestFor(free('accessory').filter((p) => !budget || totalOf(items) + p.unit_price <= budget), items, false);
    if (acc) {
      items.push(acc);
      used.add(acc.id);
    }
  }
  outfits = outfits.map((items) => ({ items: items.sort(byOrder), total: totalOf(items), alternative: cheaperAlternative(items, pool, used) }));

  let over_budget = 0;
  let partial = null;
  if (budget) {
    const fits = outfits.filter((o) => o.total <= budget);
    if (fits.length || !outfits.length) outfits = fits;
    else {
      const cheapest = outfits.reduce((a, b) => (b.total < a.total ? b : a));
      outfits = [cheapest];
      over_budget = cheapest.total - budget;
      partial = partialOutfit(pool, required, budget);
    }
  }
  return { outfits, over_budget, partial };
}

// The cheapest item of each required category, cheapest first, while the sum stays within budget.
// Returns { items, total, missing: [categories left out] } or null when not even one item fits.
export function partialOutfit(pool, required, budget) {
  const cheapest = required.map((c) => pool[c].reduce((a, p) => (!a || p.unit_price < a.unit_price ? p : a), null)).filter(Boolean);
  const items = [];
  for (const p of cheapest.sort((a, b) => a.unit_price - b.unit_price)) {
    if (totalOf(items) + p.unit_price > budget) break;
    items.push(p);
  }
  if (!items.length) return null;
  return { items: items.sort(byOrder), total: totalOf(items), missing: required.filter((c) => !items.some((p) => p.category === c)) };
}

// Rule outfits with the R1 fallbacks. load(spread) → candidates within ±spread °C of the temperature.
// Fewer than 3 outfits → widen the window to ±3, then ±6 °C (`relaxed` = the spread used; prefers the narrowest
// window with the most in-budget outfits). No outfit at all because the store has no outerwear for this weather →
// outfits without it and notice 'no_outerwear'. Returns { outfits, over_budget, partial, relaxed, notice, candidates }.
export const SPREADS = [0, 3, 6];
export async function ruleOutfits(load, ctx) {
  // In-budget outfits count most; an over-budget outfit (with its partial) still beats nothing.
  const score = (r) => (r.over_budget ? 0 : r.outfits.length) * 4 + r.outfits.length;
  const attempt = async (skip) => {
    let best;
    for (const spread of SPREADS) {
      const candidates = await load(spread);
      const r = { ...buildOutfits(candidates, { ...ctx, skip }), relaxed: spread, candidates };
      if (!best || score(r) > score(best)) best = r;
      if (!best.over_budget && best.outfits.length >= MAX_OUTFITS) break;
    }
    return best;
  };
  const result = await attempt([]);
  if (result.outfits.length || !requiredCategories(ctx.temperature, ctx.raining).includes('outerwear') || result.candidates.some((p) => p.category === 'outerwear')) {
    return { ...result, notice: null };
  }
  const bare = await attempt(['outerwear']);
  return { ...bare, notice: bare.outfits.length ? 'no_outerwear' : null };
}

export const requiredCategories = (temperature, raining) =>
  temperature < OUTERWEAR_BELOW || raining ? ['outerwear', 'top', 'bottom', 'shoes'] : ['top', 'bottom', 'shoes'];

// Candidates per category, best first: items inside the temperature window before relaxed ones (closest first),
// then waterproof first in rain; with a budget cheapest first, otherwise the best temperature match.
export function rankPool(candidates, { temperature, raining, budget = null }) {
  const fit = (p) => Math.abs(temperature - (p.temp_min + p.temp_max) / 2);
  const out = (p) => Math.max(0, p.temp_min - temperature, temperature - p.temp_max);
  const rank = (a, b) =>
    out(a) - out(b) || (raining ? b.waterproof - a.waterproof : 0) || (budget ? a.unit_price - b.unit_price : fit(a) - fit(b)) || a.id - b.id;
  return Object.fromEntries(ORDER.map((c) => [c, candidates.filter((p) => p.category === c).sort(rank)]));
}

// Same outfit with one item swapped for the cheapest unused item of its category; the biggest saving wins.
export function cheaperAlternative(items, pool, used) {
  let best = null;
  for (const [idx, item] of items.entries()) {
    const swap = pool[item.category].filter((p) => !used.has(p.id) && p.unit_price < item.unit_price).sort((a, b) => a.unit_price - b.unit_price || a.id - b.id)[0];
    if (swap && (!best || item.unit_price - swap.unit_price > best.saving)) best = { idx, swap, saving: item.unit_price - swap.unit_price };
  }
  if (!best) return null;
  const alt = items.map((p, i) => (i === best.idx ? best.swap : p));
  return { items: alt, total: totalOf(alt), replaces: items[best.idx].id };
}
