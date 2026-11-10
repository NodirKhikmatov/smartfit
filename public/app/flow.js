// Customer-app flow without the DOM (task 16): field rules for inline validation, history routing, and the only
// route data kept in session storage. Tested in test/flow.test.js.
export const SCREENS = ['start', 'form', 'camera', 'results', 'cart', 'done', 'catalog', 'item'];
export const CLOTHES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
export const SHOES = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'];
// Task 29 (same lists as src/size/size.js, a test keeps them equal): usual jeans waist, fit preference, size methods.
export const JEANS = Array.from({ length: 15 }, (_, i) => 26 + i);
export const FITS = ['tight', 'regular', 'loose'];
export const METHODS = ['full', 'torso', 'upper', 'usual', 'tape', 'body', 'profile'];
// Task 30: the categories a customer can come for as single items (same order as the engine's ORDER).
export const WANT = ['outerwear', 'top', 'bottom', 'shoes', 'accessory'];
// Task 36: the store's own categories are wanted by id; their outfit role (or none) decides which sizes are asked.
// Filled from the store (GET /api/stores/:id) and, until it loads after a refresh, from the saved route.
const ROLES = new Map(); // category id → role | null
export function setCategories(list) {
  ROLES.clear();
  for (const [id, role] of list) if (Number.isInteger(id) && id > 0) ROLES.set(id, WANT.includes(role) ? role : null);
}
export const categoryRoles = () => [...ROLES];
const roleOf = (c) => (Number.isInteger(c) ? ROLES.get(c) ?? null : c);
const ROUTE_KEY = 'sfRoute';

const str = (v) => String(v ?? '').trim();
const int = (v) => (/^\d+$/.test(str(v).replace(/\s/g, '')) ? Number(str(v).replace(/\s/g, '')) : NaN);
const within = (v, lo, hi) => int(v) >= lo && int(v) <= hi;

// Each rule gives an i18n error key, or '' when the value is fine. Shared by the inline (blur) checks and submit.
export const RULES = {
  gender: (v) => (['male', 'female'].includes(v) ? '' : 'kiosk.form.err_gender'),
  height: (v) => (within(v, 100, 230) ? '' : 'kiosk.form.err_height'),
  weight: (v) => (!str(v) || within(v, 30, 250) ? '' : 'kiosk.form.err_weight'),
  budget: (v) => (!str(v) || within(v, 1, 1e9) ? '' : 'kiosk.form.err_budget'),
  fullname: (v) => (str(v).length >= 2 ? '' : 'kiosk.checkout.err_name'),
  phone: (v) => (/^(\+?998)?\d{9}$/.test(str(v).replace(/[\s()-]/g, '')) ? '' : 'kiosk.checkout.err_phone'),
  address: (v) => (str(v).length >= 5 ? '' : 'kiosk.checkout.err_address'),
};
export const fieldError = (name, value) => RULES[name]?.(value) ?? '';
// What a field's inline error becomes after an event (U3): leaving ('blur') checks a filled-in field, typing or picking
// ('input') only updates an error already shown, so it clears the moment the value is fine; 'submit' checks everything.
// undefined = leave the field as it is.
export function nextError(event, name, value, shown) {
  if (event === 'submit') return fieldError(name, value);
  if (event === 'blur') return str(value) ? fieldError(name, value) : undefined;
  return shown ? fieldError(name, value) : undefined;
}
const FORM = ['gender', 'height', 'weight', 'shoes', 'budget'];

// Task 30: which sizes a choice needs. want = null (whole outfit: as before) or categories. Outerwear/top → the top
// size, bottom → the bottom size, shoes → the shoe size (the form's chips: a photo can't measure feet), accessories →
// none. `photo` = the size step (photo / usual size / tape) is shown at all; height and weight are asked only for it.
export function sizeNeeds(want = null) {
  if (!want) return { top: true, bottom: true, shoes: true, photo: true };
  const roles = want.map(roleOf);
  const top = roles.includes('outerwear') || roles.includes('top'), bottom = roles.includes('bottom');
  return { top, bottom, shoes: roles.includes('shoes'), photo: top || bottom };
}
// The sizes a request still lacks for its choice (the results screen can show only when this is true).
export const sizesReady = (sizes, want = null) => {
  const n = sizeNeeds(want);
  return (!n.top || !!sizes?.top) && (!n.bottom || !!sizes?.bottom);
};
// A want list from untrusted input (form, saved route): role codes (in order) and category ids (task 36: "12" or 12,
// in the order given), once each, at most 20; none → null.
export function cleanWant(w) {
  if (!Array.isArray(w)) return null;
  const ids = [...new Set(w.filter((c) => /^\d{1,9}$/.test(String(c)) && Number(c) > 0).map(Number))];
  const out = [...WANT.filter((c) => w.includes(c)), ...ids].slice(0, 20);
  return out.length ? out : null;
}

// Form values (strings from the inputs) → the /api/size body and the /api/recommend request, or null if a field is wrong.
// Height and weight are checked only when the choice needs the size step.
export function toRequest(v, storeId) {
  const want = cleanWant(v.want);
  const skip = sizeNeeds(want).photo ? [] : ['height', 'weight'];
  if (FORM.some((k) => !skip.includes(k) && fieldError(k, v[k]))) return null;
  const num = (x) => (str(x) ? int(x) : null);
  return {
    body: { gender: v.gender, height: skip.length ? null : num(v.height), weight: skip.length ? null : num(v.weight) },
    request: { store_id: storeId, gender: v.gender, sizes: { top: null, bottom: null, shoes: SHOES.includes(v.shoes) ? v.shoes : null }, budget: num(v.budget), ...(want && { want }) },
  };
}

// The whitelist of what survives a refresh: the screen, the form's numbers, the chosen sizes, how they were found, the
// fit preference and the open item page.
// Never the photo, the name, the phone or the address.
// Task 30: the single-item choice (want) and what the customer owns (own: category + colour + style, from fixed lists;
// the server checks the lists again).
const ownItem = (x) => x && typeof x === 'object' && WANT.includes(x.category) && typeof x.color === 'string' && x.color.length <= 20
  && (x.style == null || (typeof x.style === 'string' && x.style.length <= 10));
export function routeData({ screen, form = {}, sizes = {}, manual = false, method = null, fit = null, item = null, own = [], roles = [] } = {}) {
  const known = new Map(Array.isArray(roles) ? roles.filter((x) => Array.isArray(x) && Number.isInteger(x[0])) : []);
  return {
    screen: SCREENS.includes(screen) ? screen : 'start',
    form: { ...Object.fromEntries(FORM.map((k) => [k, str(form?.[k]).slice(0, 12)])), want: cleanWant(form?.want) },
    own: Array.isArray(own) ? own.filter(ownItem).slice(0, 5).map((x) => ({ category: x.category, color: x.color, style: x.style ?? null })) : [],
    sizes: {
      top: CLOTHES.includes(sizes?.top) ? sizes.top : null,
      bottom: CLOTHES.includes(sizes?.bottom) ? sizes.bottom : null,
      shoes: SHOES.includes(sizes?.shoes) ? sizes.shoes : null,
    },
    manual: manual === true,
    method: METHODS.includes(method) ? method : null,
    fit: FITS.includes(fit) ? fit : null,
    item: Number.isInteger(item) && item > 0 ? item : null,
    // Task 36: the outfit role of each wanted category id, so a refresh asks the right sizes before the store loads.
    roles: (cleanWant(form?.want) ?? []).filter(Number.isInteger).map((id) => [id, WANT.includes(known.get(id)) ? known.get(id) : null]),
  };
}
export function saveRoute(route, storage = globalThis.sessionStorage) {
  try { storage.setItem(ROUTE_KEY, JSON.stringify(routeData(route))); } catch {}
}
export function loadRoute(storage = globalThis.sessionStorage) {
  try {
    const r = JSON.parse(storage.getItem(ROUTE_KEY));
    return r && typeof r === 'object' ? routeData(r) : null;
  } catch { return null; }
}
export function clearRoute(storage = globalThis.sessionStorage) {
  try { storage.removeItem(ROUTE_KEY); } catch {}
}

// Which screen may show, for a refresh or a back/forward step, given what the app holds in memory.
export function allowedScreen(screen, { formOk = false, sizesOk = false, orderOk = false, itemOk = false } = {}) {
  if (screen === 'camera') return formOk ? 'camera' : 'form';
  if (screen === 'results') return formOk && sizesOk ? 'results' : formOk ? 'camera' : 'form';
  if (screen === 'done') return orderOk ? 'done' : 'start';
  if (screen === 'item') return itemOk ? 'item' : 'catalog';
  return SCREENS.includes(screen) ? screen : 'start';
}

// One history entry per screen. Back/forward arrive through popstate and pass `allowed` first.
// Each entry keeps its depth, so the in-app back button (the kiosk has no browser back) never leaves the app.
// An entry may carry `data` (the item page's product id), handed back to render and allowed on back/forward.
export function createRouter(win, { render, allowed }) {
  let depth = win.history.state?.depth ?? 0;
  win.addEventListener('popstate', (e) => {
    depth = e.state?.depth ?? 0;
    const want = e.state?.screen ?? 'start';
    const data = { item: e.state?.item ?? null };
    const to = allowed(want, data);
    if (to !== want) win.history.replaceState({ screen: to, depth }, '');
    render(to, to === want ? data : {});
  });
  const router = {
    go(screen, { replace = false, data = {} } = {}) {
      if (!replace) depth += 1;
      win.history[replace ? 'replaceState' : 'pushState']({ ...data, screen, depth }, '');
      render(screen, data);
    },
    back(fallback) {
      if (depth > 0) win.history.back();
      else router.go(fallback, { replace: true });
    },
  };
  return router;
}
