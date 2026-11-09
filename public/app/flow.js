// Customer-app flow without the DOM (task 16): field rules for inline validation, history routing, and the only
// route data kept in session storage. Tested in test/flow.test.js.
export const SCREENS = ['start', 'form', 'camera', 'results', 'cart', 'done'];
export const CLOTHES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
export const SHOES = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'];
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

// Form values (strings from the inputs) → the /api/size body and the /api/recommend request, or null if a field is wrong.
export function toRequest(v, storeId) {
  if (FORM.some((k) => fieldError(k, v[k]))) return null;
  const num = (x) => (str(x) ? int(x) : null);
  return {
    body: { gender: v.gender, height: num(v.height), weight: num(v.weight) },
    request: { store_id: storeId, gender: v.gender, sizes: { top: null, bottom: null, shoes: SHOES.includes(v.shoes) ? v.shoes : null }, budget: num(v.budget) },
  };
}

// The whitelist of what survives a refresh: the screen, the form's numbers and the chosen sizes.
// Never the photo, the name, the phone or the address.
export function routeData({ screen, form = {}, sizes = {}, manual = false } = {}) {
  return {
    screen: SCREENS.includes(screen) ? screen : 'start',
    form: Object.fromEntries(FORM.map((k) => [k, str(form?.[k]).slice(0, 12)])),
    sizes: {
      top: CLOTHES.includes(sizes?.top) ? sizes.top : null,
      bottom: CLOTHES.includes(sizes?.bottom) ? sizes.bottom : null,
      shoes: SHOES.includes(sizes?.shoes) ? sizes.shoes : null,
    },
    manual: manual === true,
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
export function allowedScreen(screen, { formOk = false, sizesOk = false, orderOk = false } = {}) {
  if (screen === 'camera') return formOk ? 'camera' : 'form';
  if (screen === 'results') return formOk && sizesOk ? 'results' : formOk ? 'camera' : 'form';
  if (screen === 'done') return orderOk ? 'done' : 'start';
  return SCREENS.includes(screen) ? screen : 'start';
}

// One history entry per screen. Back/forward arrive through popstate and pass `allowed` first.
// Each entry keeps its depth, so the in-app back button (the kiosk has no browser back) never leaves the app.
export function createRouter(win, { render, allowed }) {
  let depth = win.history.state?.depth ?? 0;
  win.addEventListener('popstate', (e) => {
    depth = e.state?.depth ?? 0;
    const want = e.state?.screen ?? 'start';
    const to = allowed(want);
    if (to !== want) win.history.replaceState({ screen: to, depth }, '');
    render(to);
  });
  const router = {
    go(screen, { replace = false } = {}) {
      if (!replace) depth += 1;
      win.history[replace ? 'replaceState' : 'pushState']({ screen, depth }, '');
      render(screen);
    },
    back(fallback) {
      if (depth > 0) win.history.back();
      else router.go(fallback, { replace: true });
    },
  };
  return router;
}
