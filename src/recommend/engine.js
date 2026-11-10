import { sizesFor } from '../db/seed.js';
import { fitOf, wantSize } from '../size/size.js';

// Rule-based outfits. filterCandidates is the only source of items: task 7 sends its output to Claude as CANDIDATES.

export const ORDER = ['outerwear', 'top', 'bottom', 'shoes', 'accessory'];
// Task 36: products of a hidden category are offered nowhere. category_id null = a row from before categories (tests).
export const visible = (q) => q.leftJoin('categories as c', 'c.id', 'p.category_id').where((w) => w.whereNull('c.hidden').orWhere('c.hidden', false));
// A want entry (task 30/36): a role code (every category with that role) or a category id (that category only).
export const inWant = (w) => (Number.isInteger(w) ? (p) => p.category_id === w : (p) => p.category === w);
export const OUTERWEAR_BELOW = 18;
const MAX_OUTFITS = 3;

export const sizeKey = { outerwear: 'top', top: 'top', bottom: 'bottom', shoes: 'shoes' }; // which customer size a category needs
export const unitPrice = (p) => p.discount_price ?? p.price;
export const totalOf = (items) => items.reduce((sum, i) => sum + i.unit_price, 0);

// Items in this store, for this gender, worn at this temperature, with free stock (quantity − reserved > 0) in the customer's size.
// sizes = { top, bottom, shoes? }. No shoe size → shoes with stock in any size (size: null, picked in the cart).
// Each item carries fit_offset (+1 runs small, -1 runs big) and fit_from (the customer's size when it was shifted).
// spread widens the temperature window to ±spread °C (the relaxation fallback in ruleOutfits).
// fit (task 29): the customer's preference tight|regular|loose shifts clothes one size first; fit_from is relative to that.
export async function filterCandidates(db, { storeId, gender, sizes, temperature, spread = 0, fit = null }) {
  const rows = await visible(db('products as p'))
    .join('product_stock as s', 's.product_id', 'p.id')
    .where('p.store_id', storeId)
    .whereIn('p.gender', [gender, 'unisex'])
    // Live weather is fractional (11.7 °C); Postgres would type the parameter as the integer column and refuse it.
    .whereRaw('p.temp_min <= cast(? as real) and p.temp_max >= cast(? as real)', [temperature + spread, temperature - spread])
    .whereRaw('s.quantity - s.reserved > 0')
    .orderBy(['p.id', 's.id'])
    .select('p.id', 'p.name', 'p.name_ru', 'p.category', 'p.category_id', 'p.gender', 'p.color', 'p.style', 'p.price', 'p.discount_price', 'p.temp_min', 'p.temp_max', 'p.waterproof', 'p.image_url', 'p.shelf_location', 'p.fit_offset', 's.size');
  // Task 23: a product that runs small or big is offered one size up or down (clamped to its sizes), and only if that
  // size has free stock: never the customer's own size, which is known not to fit.
  const fits = await fitOf(db, [...new Map(rows.map((r) => [r.id, r])).values()]);
  const byId = new Map();
  for (const { fit_offset, ...r } of rows) {
    const own = sizes[sizeKey[r.category]];
    const offset = fits.get(r.id).offset;
    const { base, want } = own ? wantSize(sizesFor(r.category), r.category, own, offset, fit) : {};
    if (want && r.size !== want) continue;
    const known = r.category === 'accessory' || own;
    // Several rows per item only when the shoe size is unknown: `sizes` lists them so the customer picks one.
    if (byId.has(r.id)) {
      byId.get(r.id).sizes.push(r.size);
      continue;
    }
    byId.set(r.id, { ...r, waterproof: Boolean(r.waterproof), size: known ? r.size : null, ...(known ? {} : { sizes: [r.size] }), unit_price: unitPrice(r),
      fit_offset: offset, fit_from: want && want !== base ? base : null });
  }
  return [...byId.values()];
}

// Task 24, missed demand: items this weather and gender would have been offered, but whose size (the customer's,
// after the fit shift) has no free stock. Accessories and shoes without a size are left out: no size was asked for.
// → [{ product_id, size }].
// want (task 30): only the categories the customer came for.
export async function missedItems(db, { storeId, gender, sizes, temperature, fit = null, want = null }) {
  const q = db('products as p').leftJoin('product_stock as s', 's.product_id', 'p.id')
    .where('p.store_id', storeId)
    .whereIn('p.gender', [gender, 'unisex'])
    .whereIn('p.category', Object.keys(sizeKey).filter((c) => sizes[sizeKey[c]]));
  if (want) q.where((w) => w.whereIn('p.category', want.filter((x) => !Number.isInteger(x))).orWhereIn('p.category_id', want.filter(Number.isInteger)));
  const rows = await q
    .whereRaw('p.temp_min <= cast(? as real) and p.temp_max >= cast(? as real)', [temperature, temperature])
    .orderBy(['p.id', 's.id'])
    .select('p.id', 'p.category', 'p.fit_offset', 's.size', db.raw('s.quantity - s.reserved as free'));
  const free = new Map(rows.map((r) => [`${r.id}:${r.size}`, Number(r.free)]));
  const products = [...new Map(rows.map((r) => [r.id, r])).values()];
  const fits = await fitOf(db, products);
  return products.flatMap((p) => {
    const size = wantSize(sizesFor(p.category), p.category, sizes[sizeKey[p.category]], fits.get(p.id).offset, fit).want;
    return (free.get(`${p.id}:${size}`) ?? 0) > 0 ? [] : [{ product_id: p.id, size }];
  });
}

// Spec colour rule: neutrals go with anything, never two bright colours in one outfit. Brown, cream, olive and
// denim blue count as neutral here too (wardrobe basics).
const NEUTRAL = new Set(['qora', 'oq', 'kulrang', "to'q ko'k", 'bej', 'jigarrang', 'krem', 'zaytun', "ko'k"]);
const bright = (p) => Boolean(p.color) && !NEUTRAL.has(p.color.toLowerCase());

// Task 33, "Qayerga kiyasiz?": the product styles that suit each occasion. An item of another style ranks
// OCCASION_PENALTY places lower (a soft weight: it only reorders, so the stock and budget rules are untouched); an item
// without a style is never pushed down. No occasion → 0, so the answer is exactly what it was before.
export const OCCASIONS = { daily: ['casual'], work: ['classic'], party: ['classic'], sport: ['sport'], travel: ['casual', 'sport'] };
const OCCASION_PENALTY = 5;
const offOccasion = (p, occasion) => (occasion && p.style && !OCCASIONS[occasion].includes(p.style) ? OCCASION_PENALTY : 0);

// Lower is better. Rank order first (rain/budget/temperature), then a matching style, and a colour clash only as a last resort.
function pickScore(p, idx, outfit, raining, occasion = null) {
  const clash = bright(p) && outfit.some(bright);
  const style = outfit.length && p.style && outfit[0].style && p.style !== outfit[0].style;
  return idx + (style ? 2 : 0) + (raining && !p.waterproof ? 10 : 0) + (clash ? 50 : 0) + offOccasion(p, occasion);
}
const bestFor = (list, outfit, raining, occasion = null) => list.reduce((best, p, i) => {
  const s = pickScore(p, i, outfit, raining, occasion);
  return !best || s < best.s ? { p, s } : best;
}, null)?.p;
const byOrder = (a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category);

// Pure: builds up to 3 outfits from candidates, no item shared between outfits (spec). Each outfit is composed:
// the first item sets the style, later ones prefer the same style and a colour that goes with what is already picked.
// skip: categories to leave out (outerwear when the store has none). Returns { outfits, over_budget, partial }:
// over_budget > 0 only when nothing fits the budget, and then `partial` is the required items that do fit.
export function buildOutfits(candidates, { temperature, raining, budget = null, skip = [], occasion = null }) {
  const required = requiredCategories(temperature, raining).filter((c) => !skip.includes(c));
  const pool = rankPool(candidates, { temperature, raining, budget });
  const used = new Set();
  const free = (c) => pool[c].filter((p) => !used.has(p.id));

  let outfits = [];
  while (outfits.length < MAX_OUTFITS) {
    const items = [];
    for (const c of required) {
      const p = bestFor(free(c), items, raining, occasion);
      if (!p) break;
      items.push(p);
    }
    if (items.length < required.length) break;
    items.forEach((p) => used.add(p.id));
    outfits.push(items);
  }
  // Optional accessory: the best unused one that goes with the outfit, only if it keeps the outfit within budget.
  for (const items of outfits) {
    const acc = bestFor(free('accessory').filter((p) => !budget || totalOf(items) + p.unit_price <= budget), items, false, occasion);
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
export function ranker({ temperature, raining, budget = null }) {
  const fit = (p) => Math.abs(temperature - (p.temp_min + p.temp_max) / 2);
  const out = (p) => Math.max(0, p.temp_min - temperature, temperature - p.temp_max);
  return (a, b) => out(a) - out(b) || (raining ? b.waterproof - a.waterproof : 0) || (budget ? a.unit_price - b.unit_price : fit(a) - fit(b)) || a.id - b.id;
}
export function rankPool(candidates, ctx) {
  const rank = ranker(ctx);
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

// Task 25, "Shu bilan yaxshi ketadi": one item per other category that is worn in the same temperature window, closest
// season first, then picked by the outfit rules (same style, never a second bright colour). Outerwear only for an item
// worn below OUTERWEAR_BELOW. The item itself and repeats can't appear (one per category). Caller filters gender + stock.
const mid = (p) => (p.temp_min + p.temp_max) / 2;
export function pairWith(item, candidates, max = 4) {
  if (!item.category) return []; // task 36: a role-less item is not part of an outfit, so it has no pairs either
  const cats = ORDER.filter((c) => c !== item.category && (c !== 'outerwear' || mid(item) < OUTERWEAR_BELOW));
  const picked = [item];
  for (const c of cats) {
    const list = candidates.filter((p) => p.category === c && p.id !== item.id && p.temp_min <= item.temp_max && p.temp_max >= item.temp_min)
      .sort((a, b) => Math.abs(mid(a) - mid(item)) - Math.abs(mid(b) - mid(item)) || a.id - b.id);
    const p = bestFor(list, picked, false);
    if (p) picked.push(p);
  }
  return picked.slice(1, max + 1);
}

// Task 25: what can take `replace`'s place in a shown outfit. Same category (so the outfit keeps its required
// categories), not in this outfit or another shown one (`exclude`), and within budget; an outfit that is already over
// budget (the cheapest-outfit fallback) only gets cheaper items. Best first by the outfit rules.
// → [{ swap, items, total }]: the whole new outfit, priced from the candidate rows (DB).
export function swapOptions(candidates, { items, replace, exclude = [], budget = null, temperature, raining = false, limit = 4, occasion = null }) {
  const old = items.find((p) => p.id === replace);
  if (!old) return [];
  const rest = items.filter((p) => p.id !== replace);
  const used = new Set([...items.map((p) => p.id), ...exclude]);
  const over = budget && totalOf(items) > budget;
  const fits = (p) => !budget || (over ? p.unit_price < old.unit_price : totalOf(rest) + p.unit_price <= budget);
  const list = rankPool(candidates, { temperature, raining, budget })[old.category].filter((p) => !used.has(p.id) && fits(p));
  return list.map((p, i) => ({ p, s: pickScore(p, i, rest, raining, occasion) })).sort((a, b) => a.s - b.s).slice(0, limit)
    .map(({ p }) => {
      const next = [...rest, p].sort(byOrder);
      return { swap: p.id, items: next, total: totalOf(next) };
    });
}

// Task 30, single items: up to MAX_SINGLE best items per wanted category instead of whole outfits. Same in-stock
// candidates and rank (weather, rain, budget) as the outfits; within budget per item, and when nothing in a category
// fits, its cheapest items with `over_budget` = how far the cheapest one is over. own = [{ category, color, style }] the
// customer already has: re-ranks with the outfit style/colour rules (a style none of them has +2, a second bright colour
// +50), so it only changes the order (never adds an item). Every owned item's style counts, not just the first.
// Each item gets its cheapest cheaper unshown item of the category (`alternative`) and the task 25 pairs.
// → [{ category, items: [{ ...item, alternative, pairs }], over_budget }].
export const MAX_SINGLE = 6;
export function singleItems(candidates, { want, own = [], temperature, raining, budget = null, occasion = null }) {
  const rank = ranker({ temperature, raining, budget });
  const styles = new Set(own.map((x) => x.style).filter(Boolean)), clash = own.some(bright);
  const score = (p, i) => i + (styles.size && p.style && !styles.has(p.style) ? 2 : 0) + (raining && !p.waterproof ? 10 : 0) + (clash && bright(p) ? 50 : 0) + offOccasion(p, occasion);
  return want.map((category) => {
    const all = candidates.filter(inWant(category)).sort(rank);
    const fits = budget ? all.filter((p) => p.unit_price <= budget) : all;
    const list = fits.length ? fits : all;
    const items = list.map((p, i) => ({ p, s: score(p, i) })).sort((a, b) => a.s - b.s).slice(0, MAX_SINGLE).map(({ p }) => p);
    const shown = new Set(items.map((p) => p.id));
    const cheaper = (p) => all.filter((x) => !shown.has(x.id) && x.unit_price < p.unit_price).sort((a, b) => a.unit_price - b.unit_price || a.id - b.id)[0] ?? null;
    return {
      category,
      items: items.map((p) => ({ ...p, alternative: cheaper(p), pairs: pairWith(p, candidates, 3) })),
      over_budget: budget && !fits.length && all.length ? Math.min(...all.map((p) => p.unit_price)) - budget : 0,
    };
  });
}

// singleItems with the R1 window fallback: widen to ±3, then ±6 °C until every wanted category has 3 in-budget items
// (in-window items still rank first). Keeps the narrowest window with the most of them. → { groups, relaxed, candidates }.
export async function ruleSingles(load, ctx) {
  const score = (groups) => groups.reduce((n, g) => n + (g.over_budget ? 0 : Math.min(g.items.length, 3)), 0);
  let best;
  for (const spread of SPREADS) {
    const candidates = await load(spread);
    const groups = singleItems(candidates, ctx);
    if (!best || score(groups) > score(best.groups)) best = { groups, relaxed: spread, candidates };
    if (score(best.groups) === ctx.want.length * 3) break;
  }
  return best;
}
