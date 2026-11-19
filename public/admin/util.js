// Pure helpers for the admin (no DOM): hash routes, paging text, deltas, chart scales. Tested in test/admin-ui.test.js.

export const ROUTES = ['dashboard', 'orders', 'cashier', 'closing', 'products', 'categories', 'sizes', 'offers', 'stats', 'profit', 'sellers', 'demand', 'reviews', 'qr', 'settings', 'orgs', 'malls', 'mall', 'welcome'];

// '#/products?filter=low&page=2' → { route: 'products', params: { filter: 'low', page: '2' } }. Unknown routes → dashboard.
export function parseHash(hash) {
  const [path, qs = ''] = String(hash || '').replace(/^#\/?/, '').split('?');
  const route = path.split('/')[0];
  return { route: ROUTES.includes(route) ? route : 'dashboard', params: Object.fromEntries(new URLSearchParams(qs)) };
}

// Empty values are left out, so the default view has a clean '#/orders'.
export function buildHash(route, params = {}) {
  const p = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null && v !== false).map(([k, v]) => [k, String(v)]));
  const qs = p.toString();
  return `#/${route}${qs ? `?${qs}` : ''}`;
}

// Page number (1-based, from the hash) → API offset, and the "21–40 of 77" numbers for the footer.
export const offsetOf = (page, limit) => (Math.max(Number.parseInt(page, 10) || 1, 1) - 1) * limit;
export function pageInfo({ offset, limit, total }) {
  return {
    from: total ? offset + 1 : 0,
    to: Math.min(offset + limit, total),
    page: Math.floor(offset / limit) + 1,
    pages: Math.max(1, Math.ceil(total / limit)),
    prev: offset > 0,
    next: offset + limit < total,
  };
}

// Change against the previous period in whole percent; null when there is nothing to compare with.
export function delta(cur, prev) {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

// Share in percent with one decimal below 10 (3.4%), whole above (42%); null when the base is 0.
export function share(part, whole) {
  if (!whole) return null;
  const p = (part / whole) * 100;
  return p < 10 ? Math.round(p * 10) / 10 : Math.round(p);
}

// Axis top and ticks: 0 and 3–4 more at a 1/2/2.5/5 × 10^n step, top ≥ max.
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

// 1 250 000 → '1,3' + million unit; 12 500 → '12,5' + thousand unit; below 10 000 in full. Units come from the dictionary.
export function compact(n, { k, m }) {
  const abs = Math.abs(n);
  const one = (v) => String(Math.round(v * 10) / 10).replace('.', ',');
  if (abs >= 1e6) return `${one(n / 1e6)} ${m}`;
  if (abs >= 1e4) return `${one(n / 1e3)} ${k}`;
  return new Intl.NumberFormat('ru-RU').format(n);
}

// Stock heat level of one size: 0 = sold out, 1 = running out (≤ low), 2 = fine.
export const stockLevel = (free, low = 1) => (free <= 0 ? 0 : free <= low ? 1 : 2);
