// Task 48: a shop's own size chart. The customer's size is still found against the built-in table (size.js); a shop
// with its own chart then translates it: the built-in size → the middle of its built-in range (cm) → the first row of
// the shop's chart whose range reaches that value. A chart that is a copy of the built-in table gives the same size
// back, and a shop without a chart never gets here, so it behaves exactly as before.
import { fail } from '../admin/routes.js';
import { sizesFor, KIDS, KIDS_SHOES } from '../db/seed.js';
import { CHART, SIZES } from './size.js';

const round1 = (n) => Math.round(n * 10) / 10;
const footMax = (n) => round1((Number(n) * 2) / 3 - 1); // EU (Paris point = 2/3 cm) → the longest foot it fits
const shoeRows = (list) => list.map((s) => ({ size: s, foot: [footMax(Number(s) - 1), footMax(s)] }));
// Built-in clothes: size i spans half a step either side of the value the size maths uses for it.
const band = ([xs, step], i) => [xs + step * (i - 0.5), xs + step * (i + 0.5)];
const clothes = (g) => SIZES.map((size, i) => ({ size, chest: band(CHART[g].chest, i), waist: band(CHART[g].waist, i), hips: band(CHART[g].hips, i) }));

// Per size kind: its sizes, groups (clothes differ by gender) and measures, and the built-in table.
export const CHART_KINDS = {
  clothes: { sizes: SIZES, groups: ['male', 'female'], measures: ['chest', 'waist', 'hips'], builtin: { male: clothes('male'), female: clothes('female') } },
  shoes: { sizes: sizesFor('shoes'), groups: ['all'], measures: ['foot'], builtin: { all: shoeRows(sizesFor('shoes')) } },
  // A children's size is the tallest height it fits (task 40: 116 = 111–116 cm).
  kids: { sizes: KIDS, groups: ['all'], measures: ['height'], builtin: { all: KIDS.map((s) => ({ size: s, height: [Number(s) - 6, Number(s)] })) } },
  kids_shoes: { sizes: KIDS_SHOES, groups: ['all'], measures: ['foot'], builtin: { all: shoeRows(KIDS_SHOES) } },
};
const MAX_CM = 300;

// The chart kind of a product's role and audience; null for accessories and role-less items (no customer size).
export function kindOf(category, audience) {
  if (!['outerwear', 'top', 'bottom', 'shoes'].includes(category)) return null;
  if (category === 'shoes') return audience === 'child' ? 'kids_shoes' : 'shoes';
  return audience === 'child' ? 'kids' : 'clothes';
}
export const groupOf = (kind, gender) => (kind === 'clothes' ? (gender === 'female' ? 'female' : 'male') : 'all');
// Which measures decide a role's size: tops by the chest, bottoms by the waist and hips (the larger wins).
const measuresFor = (kind, category) => (kind === 'clothes' ? (category === 'bottom' ? ['waist', 'hips'] : ['chest']) : CHART_KINDS[kind].measures);

// Pure: the customer's built-in `size` → that size in `data` (a shop's chart of this kind). Unknown size → unchanged.
export function chartSize(kind, data, category, gender, size) {
  const group = groupOf(kind, gender);
  const base = CHART_KINDS[kind]?.builtin[group], rows = data?.[group];
  const at = base ? base.findIndex((r) => r.size === size) : -1;
  if (!rows || at < 0) return size;
  const idx = Math.max(...measuresFor(kind, category).map((m) => {
    const v = (base[at][m][0] + base[at][m][1]) / 2;
    const i = rows.findIndex((r) => v <= r[m][1]); // a gap between two rows goes to the bigger size
    return i < 0 ? rows.length - 1 : i;
  }));
  return rows[idx].size;
}

const isCm = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_CM && Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// A chart from the admin: exactly the kind's groups, each with every size of the kind in order, each measure a
// [min, max] range in cm (one decimal) with min < max, and every range ending where the next size's starts or before
// (in order, no overlap). → the clean data, or a 400 naming the size.
export function validChart(kind, data) {
  const k = CHART_KINDS[kind];
  if (!plain(data) || Object.keys(data).length !== k.groups.length || !k.groups.every((g) => Array.isArray(data[g]))) throw fail(400, 'err.chart_sizes');
  const out = {};
  for (const g of k.groups) {
    const rows = data[g];
    if (rows.length !== k.sizes.length || rows.some((r, i) => !plain(r) || r.size !== k.sizes[i])) throw fail(400, 'err.chart_sizes');
    out[g] = rows.map((r, i) => {
      const row = { size: r.size };
      for (const m of k.measures) {
        const v = r[m];
        if (!Array.isArray(v) || v.length !== 2 || !v.every(isCm) || v[0] >= v[1]) throw fail(400, 'err.chart_range', { size: r.size });
        if (i > 0 && v[0] < rows[i - 1][m][1]) throw fail(400, 'err.chart_order', { size: r.size });
        row[m] = [round1(v[0]), round1(v[1])];
      }
      return row;
    });
  }
  return out;
}

// The size charts of these stores' organisations → (store_id, category_id, kind) → that shop's data or null. A
// category's own chart wins (while it is of the category's kind), then the organisation's default for the kind.
export async function chartLookup(db, storeIds) {
  const rows = storeIds.length ? await db('size_charts as h').join('stores as st', 'st.organization_id', 'h.organization_id')
    .whereIn('st.id', [...new Set(storeIds)]).select('st.id as store_id', 'h.scope', 'h.kind', 'h.data') : [];
  if (!rows.length) return () => null;
  const by = new Map(rows.map((r) => [`${r.store_id}:${r.scope}`, r]));
  const parsed = new Map();
  return (storeId, categoryId, kind) => {
    const own = by.get(`${storeId}:c${categoryId}`);
    const r = own?.kind === kind ? own : by.get(`${storeId}:${kind}`);
    if (!r) return null;
    if (!parsed.has(r)) parsed.set(r, JSON.parse(r.data));
    return parsed.get(r);
  };
}

// The customer's size for one product in its shop (before their fit preference and the product's fit offset).
export const shopSize = (lookup, p, { storeId = p.store_id, audience, gender, own }) => {
  const kind = own ? kindOf(p.category, audience) : null;
  const data = kind ? lookup(storeId, p.category_id, kind) : null;
  return data ? chartSize(kind, data, p.category, gender, own) : own;
};
