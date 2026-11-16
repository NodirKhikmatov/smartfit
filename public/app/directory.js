// Task 44: the mall directory without the DOM (no imports, so node tests load it as is): open / closed from a
// store's hours, the floor and category filters. Tested in test/mall-map.test.js.

const TZ_MS = 5 * 3600000; // Asia/Tashkent is UTC+5 all year (no DST); store hours are Tashkent time (task 19)
const DAY_MS = 86400000;
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// → true / false, or null for a store without hours (the directory then says nothing). Opens at its first minute,
// closed from its closing minute; closing at or before opening means it closes after midnight; equal = all day.
export function openAt(opens, closes, ms = Date.now()) {
  if (!opens || !closes) return null;
  const now = Math.floor((((ms + TZ_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60000);
  const o = minutes(opens), c = minutes(closes);
  if (o === c) return true;
  return o < c ? now >= o && now < c : now >= o || now < c;
}

// Floor names in a natural order ("-1", "1", "2", "10", "B").
export const byFloor = (a, b) => a.localeCompare(b, 'en', { numeric: true });
export const floorsOf = (shops) => [...new Set(shops.map((s) => s.floor).filter(Boolean))].sort(byFloor);

// Every shop has its own categories (task 36); one name across shops is one choice, by the shown language's name.
const catName = (c, lang) => (lang === 'ru' && c.name_ru) || c.name;
const keyOf = (s) => s.trim().toLocaleLowerCase();
export function categoriesOf(shops, lang) {
  const seen = new Map();
  for (const c of shops.flatMap((s) => s.categories)) if (!seen.has(keyOf(catName(c, lang)))) seen.set(keyOf(catName(c, lang)), catName(c, lang).trim());
  return [...seen].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label, lang));
}

// { floor: '' | a floor name, category: '' | a key from categoriesOf } → the shops that match both.
export const filterShops = (shops, { floor = '', category = '' } = {}, lang = 'uz') => shops.filter((s) =>
  (!floor || s.floor === floor) && (!category || s.categories.some((c) => keyOf(catName(c, lang)) === category)));
