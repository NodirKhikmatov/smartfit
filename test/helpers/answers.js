// Task 33: a grid of /api/recommend requests without an occasion and a compact form of their answers (ids, sizes,
// totals, fallbacks). test/fixtures/no-occasion.json holds the answers recorded before the occasion existed, so a test
// proves requests without one answer exactly as before. Regenerate it only for an intended engine or seed change.
export const WEATHERS = [[-10, false], [5, false], [15, true], [30, false]];
const WHO = { male: { top: 'L', bottom: 'L', shoes: '42' }, female: { top: 'S', bottom: 'S', shoes: '38' } };
const OWN = [{ category: 'bottom', color: 'qizil', style: 'classic' }];

export function noOccasionCases(stores) {
  const out = [];
  for (const store_id of stores) for (const gender of Object.keys(WHO)) for (const [temperature, raining] of WEATHERS) {
    const base = { store_id, gender, sizes: WHO[gender] };
    out.push({ weather: [temperature, raining], body: base }, { weather: [temperature, raining], body: { ...base, budget: 600_000 } });
    out.push({ weather: [temperature, raining], body: { ...base, want: ['outerwear', 'top', 'shoes'], own: OWN } });
    out.push({ weather: [temperature, raining], body: { ...base, want: ['bottom', 'accessory'], budget: 300_000 } });
  }
  return out;
}

const ids = (items) => items.map((i) => [i.id, i.size ?? null]);
export function compact(b) {
  if (b.groups) return { mode: b.mode, keys: Object.keys(b).sort(), relaxed: b.relaxed, source: b.source, groups: b.groups.map((g) => [g.category, g.over_budget, g.items.map((i) => [i.id, i.size ?? null, i.alternative?.id ?? null, i.pairs.map((p) => p.id)])]) };
  return { mode: b.mode, relaxed: b.relaxed, notice: b.notice, source: b.source, over_budget: b.over_budget, keys: Object.keys(b).sort(),
    partial: b.partial && ids(b.partial.items),
    outfits: b.outfits.map((o) => [ids(o.items), o.total, o.alternative && [ids(o.alternative.items), o.alternative.replaces]]) };
}
