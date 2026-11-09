// Rule-based outfits. filterCandidates is the only source of items: task 7 sends its output to Claude as CANDIDATES.

export const ORDER = ['outerwear', 'top', 'bottom', 'shoes', 'accessory'];
export const OUTERWEAR_BELOW = 18;
const MAX_OUTFITS = 3;

const sizeKey = { outerwear: 'top', top: 'top', bottom: 'bottom', shoes: 'shoes' };
export const unitPrice = (p) => p.discount_price ?? p.price;
export const totalOf = (items) => items.reduce((sum, i) => sum + i.unit_price, 0);

// Items in this store, for this gender, worn at this temperature, with free stock (quantity − reserved > 0) in the customer's size.
// sizes = { top, bottom, shoes? }. No shoe size → shoes with stock in any size (size: null, picked in the cart).
export async function filterCandidates(db, { storeId, gender, sizes, temperature }) {
  const rows = await db('products as p')
    .join('product_stock as s', 's.product_id', 'p.id')
    .where('p.store_id', storeId)
    .whereIn('p.gender', [gender, 'unisex'])
    // Live weather is fractional (11.7 °C); Postgres would type the parameter as the integer column and refuse it.
    .whereRaw('p.temp_min <= cast(? as real) and p.temp_max >= cast(? as real)', [temperature, temperature])
    .whereRaw('s.quantity - s.reserved > 0')
    .where((q) => {
      for (const [cat, key] of Object.entries(sizeKey)) {
        if (sizes[key]) q.orWhere((w) => w.where('p.category', cat).where('s.size', sizes[key]));
        else q.orWhere('p.category', cat);
      }
      q.orWhere((w) => w.where('p.category', 'accessory').where('s.size', 'ONE'));
    })
    .orderBy(['p.id', 's.id'])
    .select('p.id', 'p.name', 'p.name_ru', 'p.category', 'p.gender', 'p.color', 'p.style', 'p.price', 'p.discount_price', 'p.temp_min', 'p.temp_max', 'p.waterproof', 'p.image_url', 'p.shelf_location', 's.size');
  const byId = new Map();
  for (const r of rows) {
    const known = r.category === 'accessory' || sizes[sizeKey[r.category]];
    // Several rows per item only when the shoe size is unknown: `sizes` lists them so the customer picks one.
    if (byId.has(r.id)) {
      byId.get(r.id).sizes.push(r.size);
      continue;
    }
    byId.set(r.id, { ...r, waterproof: Boolean(r.waterproof), size: known ? r.size : null, ...(known ? {} : { sizes: [r.size] }), unit_price: unitPrice(r) });
  }
  return [...byId.values()];
}

// Pure: builds up to 3 outfits from candidates, no item shared between outfits.
// Returns { outfits: [{ items, total, alternative }], over_budget } — over_budget > 0 only when nothing fits the budget.
export function buildOutfits(candidates, { temperature, raining, budget = null }) {
  const required = requiredCategories(temperature, raining);
  const pool = rankPool(candidates, { temperature, raining, budget });

  const count = Math.min(MAX_OUTFITS, ...required.map((c) => pool[c].length));
  const used = new Set();
  let outfits = [];
  for (let i = 0; i < count; i++) {
    const items = required.map((c) => pool[c][i]);
    items.forEach((p) => used.add(p.id));
    outfits.push(items);
  }
  // Optional accessory: next unused one, and only if it keeps the outfit within budget.
  for (const items of outfits) {
    const acc = pool.accessory.find((p) => !used.has(p.id));
    if (acc && (!budget || totalOf(items) + acc.unit_price <= budget)) {
      items.push(acc);
      used.add(acc.id);
    }
  }
  outfits = outfits.map((items) => ({ items, total: totalOf(items), alternative: cheaperAlternative(items, pool, used) }));

  let over_budget = 0;
  if (budget) {
    const fits = outfits.filter((o) => o.total <= budget);
    if (fits.length || !outfits.length) outfits = fits;
    else {
      const cheapest = outfits.reduce((a, b) => (b.total < a.total ? b : a));
      outfits = [cheapest];
      over_budget = cheapest.total - budget;
    }
  }
  return { outfits, over_budget };
}

export const requiredCategories = (temperature, raining) =>
  temperature < OUTERWEAR_BELOW || raining ? ['outerwear', 'top', 'bottom', 'shoes'] : ['top', 'bottom', 'shoes'];

// Candidates per category, best first: waterproof first in rain; with a budget cheapest first, otherwise the best temperature match.
export function rankPool(candidates, { temperature, raining, budget = null }) {
  const fit = (p) => Math.abs(temperature - (p.temp_min + p.temp_max) / 2);
  const rank = (a, b) =>
    (raining ? b.waterproof - a.waterproof : 0) || (budget ? a.unit_price - b.unit_price : fit(a) - fit(b)) || a.id - b.id;
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
