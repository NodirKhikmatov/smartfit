// Customer-app flow without the DOM (task 16): field rules for inline validation, history routing, and the only
// route data kept in session storage. Tested in test/flow.test.js.
export const SCREENS = ['start', 'form', 'camera', 'results', 'cart', 'done', 'catalog', 'item'];
export const CLOTHES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
export const SHOES = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'];
// Task 40, "Bolaga": children's sizes by height (same lists as src/db/seed.js, a test keeps them equal). A size is the
// tallest height it fits, each band 6 cm (116 = 111–116 cm), so a child's height rounds UP to the next size: never too
// small. Below the first band there are no sizes here; above the last, adult sizes fit.
export const KIDS = ['92', '98', '104', '110', '116', '122', '128', '134', '140', '146', '152', '158', '164'];
export const KIDS_SHOES = Array.from({ length: 14 }, (_, i) => String(22 + i));
export const KID_MIN = 87, KID_MAX = 164; // heights with a children's size (87 cm → 92, 164 cm → 164)
// → the size for a child's height in cm, or null outside KID_MIN…KID_MAX. Age never enters it (only a hint on the form).
export const childSize = (height) => (Number.isFinite(height) && height >= KID_MIN && height <= KID_MAX ? KIDS.find((s) => Number(s) >= height) : null);
// The typical height at an age (WHO medians, rounded), only for the hint under the height field.
const AGE_HEIGHT = [null, 76, 87, 96, 103, 110, 116, 122, 128, 133, 138, 144, 149, 156, 162];
export const ageHint = (age) => (/^\d{1,2}$/.test(String(age ?? '').trim()) ? AGE_HEIGHT[Number(age)] ?? null : null);
// Task 29 (same lists as src/size/size.js, a test keeps them equal): usual jeans waist, fit preference, size methods.
export const JEANS = Array.from({ length: 15 }, (_, i) => 26 + i);
export const FITS = ['tight', 'regular', 'loose'];
export const METHODS = ['full', 'torso', 'upper', 'usual', 'tape', 'body', 'profile'];
// Task 30: the categories a customer can come for as single items (same order as the engine's ORDER).
export const WANT = ['outerwear', 'top', 'bottom', 'shoes', 'accessory'];
// Task 33, "Qayerga kiyasiz?": the optional occasion (same codes as the engine's OCCASIONS, a test keeps them equal).
export const OCCASIONS = ['daily', 'work', 'party', 'sport', 'travel'];
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
  // Task 40: a child's height. Too short or too tall for children's sizes says so (taller → adult sizes).
  kidHeight: (v) => (!within(v, 40, 250) ? 'kiosk.child.err_height' : int(v) < KID_MIN ? 'kiosk.child.err_small' : int(v) > KID_MAX ? 'kiosk.child.err_tall' : ''),
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
const FORM = ['gender', 'height', 'weight', 'shoes', 'budget', 'kidHeight'];
const isChild = (v) => v?.audience === 'child';

// Task 30: which sizes a choice needs. want = null (whole outfit: as before) or categories. Outerwear/top → the top
// size, bottom → the bottom size, shoes → the shoe size (the form's chips: a photo can't measure feet), accessories →
// none. `photo` = the size step (photo / usual size / tape) is shown at all; height and weight are asked only for it.
// Task 40: a child (audience 'child') never gets the size step: `kid` = the child's height is asked instead (the
// photo rule: the app never asks for a child's photo).
export function sizeNeeds(want = null, audience = 'adult') {
  const n = want ? (() => {
    const roles = want.map(roleOf);
    const top = roles.includes('outerwear') || roles.includes('top'), bottom = roles.includes('bottom');
    return { top, bottom, shoes: roles.includes('shoes'), photo: top || bottom };
  })() : { top: true, bottom: true, shoes: true, photo: true };
  return audience === 'child' ? { ...n, photo: false, kid: n.photo } : n; // an adult's: no `kid` (falsy), as before
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
// Task 40: for a child the sizes come from the child's height here (no /api/size, no photo); body is then null.
export function toRequest(v, storeId) {
  const want = cleanWant(v.want);
  const child = isChild(v);
  const n = sizeNeeds(want, child ? 'child' : 'adult');
  const skip = [...(n.photo ? [] : ['height', 'weight']), ...(n.kid ? [] : ['kidHeight'])];
  if (FORM.some((k) => !skip.includes(k) && fieldError(k, v[k]))) return null;
  const num = (x) => (str(x) ? int(x) : null);
  const occasion = OCCASIONS.includes(v.occasion) ? v.occasion : null;
  if (child) {
    const size = n.kid ? childSize(int(v.kidHeight)) : null;
    return {
      body: null,
      request: { store_id: storeId, gender: v.gender, audience: 'child', sizes: { top: n.top ? size : null, bottom: n.bottom ? size : null, shoes: KIDS_SHOES.includes(v.shoes) ? v.shoes : null },
        budget: num(v.budget), ...(want && { want }), ...(occasion && { occasion }) },
    };
  }
  return {
    body: { gender: v.gender, height: n.photo ? num(v.height) : null, weight: n.photo ? num(v.weight) : null },
    request: { store_id: storeId, gender: v.gender, sizes: { top: null, bottom: null, shoes: SHOES.includes(v.shoes) ? v.shoes : null }, budget: num(v.budget), ...(want && { want }), ...(occasion && { occasion }) },
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
    form: { ...Object.fromEntries(FORM.map((k) => [k, str(form?.[k]).slice(0, 12)])), want: cleanWant(form?.want), occasion: OCCASIONS.includes(form?.occasion) ? form.occasion : '',
      audience: isChild(form) ? 'child' : 'adult' },
    own: Array.isArray(own) ? own.filter(ownItem).slice(0, 5).map((x) => ({ category: x.category, color: x.color, style: x.style ?? null })) : [],
    // Task 40: a child's route keeps children's sizes only, an adult's adult sizes only.
    sizes: (([clothes, shoes]) => ({
      top: clothes.includes(sizes?.top) ? sizes.top : null,
      bottom: clothes.includes(sizes?.bottom) ? sizes.bottom : null,
      shoes: shoes.includes(sizes?.shoes) ? sizes.shoes : null,
    }))(isChild(form) ? [KIDS, KIDS_SHOES] : [CLOTHES, SHOES]),
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
