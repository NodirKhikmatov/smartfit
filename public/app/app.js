import { watchIdle } from './idle.js';
import { loadPose, measure, framing, framingHint } from './pose.js';
import { keypad } from './keypad.js';
import { kioskShell, attract, kioskDevice, randomId } from './kiosk.js';
import { CLOTHES, SHOES, KIDS, KIDS_SHOES, ageHint, JEANS, WANT, nextError, fieldError, toRequest, sizeQuery, sizeNeeds, sizesReady, cleanWant, setCategories, categoryRoles, saveRoute, loadRoute, clearRoute, allowedScreen, createRouter } from './flow.js';
import { mallScreen } from './mall.js';
import { createTryon } from './tryon.js';
import { offerCard, countOffers, idleSlides } from './offers.js';
import { icon, confirmDialog, showAfter, skeletonCard, toast, stars, ratingLine } from '/shared/ui.js';
import { t, fmt, initLang, setLang, getLang, langSwitch, productName, colorName, COLORS, STYLES } from '/shared/i18n.js';

// One app: /kiosk (big buttons, idle reset) and /m (phone, opened from the store QR).
const kiosk = location.pathname.startsWith('/kiosk');
document.documentElement.classList.add(kiosk ? 'kiosk' : 'mobile');
const params = new URLSearchParams(location.search);
const storeId = Number(params.get('store'));
// Task 37: ?mall=ID. Without a store it is the mall screen (directory + search); with one, that shop's flow inside the mall.
const mallId = Number(params.get('mall'));
const inMall = Number.isInteger(mallId) && mallId > 0;
// Task 42: ?mall=ID&look=1 is "Butun markazdan obraz": this app's questionnaire and size step once, outfits from every
// shown shop of the mall (/api/recommend/mall), added to the mall cart per shop. No store of its own (no funnel visit).
const mallLook = inMall && !(storeId > 0) && params.get('look') === '1';
const mallHome = inMall && !(storeId > 0) && !mallLook;

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const som = (n) => fmt.som(n);
const cat = (c) => (c ? t(`cat.${c}`) : '');
// Task 36: the store's own categories. Their names are shop text from the database, always set as text.
const shownCats = () => store?.categories ?? [];
const catName = (c) => (getLang() === 'ru' && c.name_ru) || c.name;
const catOf = (p) => (p.category_name ? (getLang() === 'ru' && p.category_name_ru) || p.category_name : cat(p.category)); // a product's
const wantName = (w) => (Number.isInteger(w) ? catName(shownCats().find((c) => c.id === w) ?? { name: '' }) : cat(w)); // a want entry
// The sizes a category comes in: by its kind (clothes, shoes, one size) or the shop's own list.
const KIND_SIZES = { shoes: SHOES, one: [], kids: KIDS, kids_shoes: KIDS_SHOES };
const catSizes = (c) => (c.size_kind === 'custom' ? String(c.sizes ?? '').split(',').filter(Boolean) : KIND_SIZES[c.size_kind] ?? CLOTHES);
// Task 40: a category is for adults or children; the form, the "Nima kerak?" chips and the catalogue show one audience.
const forAudience = (a) => shownCats().filter((c) => (c.audience ?? 'adult') === a);
// The /recommend body; a mall outfit names the mall instead of a store and is whole outfits only.
const toReq = (v) => {
  const r = toRequest(v, storeId);
  if (r && mallLook) {
    delete r.request.store_id;
    delete r.request.want;
    r.request.mall_id = mallId;
  }
  return r;
};
const formAudience = () => (form.audience.value === 'child' ? 'child' : 'adult');
const form = $('form');
const tryon = createTryon({ storeId, kiosk, snapshot }); // task 41: "O'zimda ko'rish" (only when the shop has it on)

// Server cart (task 8): each item holds its stock for 15 min. The phone keeps the token across reloads; the kiosk never stores it.
// Task 38: in a mall it is the mall cart's token instead, also on a mall kiosk (the page reloads between the mall screen
// and its shops); the kiosk idle reset deletes that cart and the token.
const CART_KEY = 'sfCart'; // the only thing the app stores in the browser: the phone's cart token
let cart = null;
let mallCart = null; // task 38: the mall cart view; `cart` is this shop's part of it
let usePoints = true; // task 34: the cart screen's "pay with points" switch
let syncs = new Set(); // add-to-cart buttons on the results screen
const savedCart = (t) => {
  if (kiosk && !inMall) return null;
  try {
    if (t === undefined) return sessionStorage.getItem(CART_KEY);
    t ? sessionStorage.setItem(CART_KEY, t) : sessionStorage.removeItem(CART_KEY);
  } catch {}
  return null;
};
let current = 'start';
let request = null; // POST /api/recommend body
let scanToken = null; // task 32: opened from a garment label; lets the item page ask for a fitting room (memory only)
let body = null; // { gender, height, weight } for POST /api/size
let sizeInfo = null; // last /api/size answer: confidence for the results screen
let sizeInput = null; // task 29: the usual size or tape numbers sent to /api/size (memory only; saved to a profile on request)
let store = null;
let lastOrder = null; // the done screen's order, in memory only
let holdTimer = null, holdDeadline = 0; // cart hold countdown (cart screen)

// Shoe size chips (U11: chips, not a <select>) and budget shortcuts. Task 40: children's shoe sizes for a child.
function shoeChips() {
  const list = formAudience() === 'child' ? KIDS_SHOES : SHOES;
  const now = form.shoes.value;
  $('shoeChips').replaceChildren($('shoeChips').firstElementChild, ...list.map((s) => el('label', {}, el('input', { type: 'radio', name: 'shoes', value: s, checked: s === now }), el('span', { textContent: s }))));
  if (!list.includes(now)) form.shoes.value = '';
}
shoeChips();
// Task 30, "Nima kerak?": a whole outfit (the default) or one or more categories as single items. Picking "To'liq obraz"
// clears the categories, picking a category clears it, and with nothing picked it comes back.
// Task 36: the chips are the store's own shown categories (by id), drawn when the store loads; a ticked one stays ticked.
function renderWantChips(want = formWant()) {
  const cats = forAudience(formAudience());
  const kept = want?.filter((w) => cats.some((c) => c.id === w)); // task 40: a switch of audience drops the other one's picks
  want = kept?.length ? kept : null;
  $('wantChips').replaceChildren(...[['outfit', t('kiosk.want.outfit')], ...cats.map((c) => [String(c.id), catName(c)])].map(([v, text]) =>
    el('label', {}, el('input', { type: 'checkbox', name: 'want', value: v, checked: want ? want.includes(Number(v)) : v === 'outfit' }), el('span', { textContent: text }))));
  applyNeeds();
}
let restoredWant = null; // a refresh's choice, until the store's chips exist
const wantBoxes = () => [...document.getElementsByName('want')];
const formWant = () => (wantBoxes().length > 1 ? cleanWant(wantBoxes().filter((b) => b.checked).map((b) => b.value)) : restoredWant);
$('wantChips').addEventListener('change', (e) => {
  const boxes = wantBoxes();
  if (e.target.value === 'outfit') boxes.forEach((b) => (b.checked = b === e.target));
  else boxes[0].checked = !boxes.some((b) => b.value !== 'outfit' && b.checked);
  applyNeeds();
});
renderWantChips(null);
// Only the inputs the choice needs show (form: height/weight for the size step, shoe sizes; size step: top or bottom parts).
// Task 40: for a child, the child's height (and age as a hint) instead of height/weight, boy / girl, children's shoes.
function applyNeeds() {
  const child = formAudience() === 'child';
  const n = sizeNeeds(formWant(), formAudience());
  for (const x of document.querySelectorAll('[data-need]')) x.classList.toggle('need-off', !n[x.dataset.need]);
  if (!n.photo) for (const f of ['height', 'weight']) showError(f, '');
  if (!n.kid) showError('kidHeight', '');
  $('whoHint').hidden = !child;
  for (const [id, adult, kid] of [['genderMale', 'gender.male', 'kiosk.child.boy'], ['genderFemale', 'gender.female', 'kiosk.child.girl']]) {
    $(id).dataset.i18n = child ? kid : adult;
    $(id).textContent = t($(id).dataset.i18n);
  }
  const h = ageHint(form.kidAge.value);
  $('kidAgeHint').textContent = h ? t('kiosk.child.age_typical', { h }) : t('kiosk.child.age_hint');
}
const formFields = () => {
  const n = sizeNeeds(formWant(), formAudience());
  return FORM_FIELDS.filter((f) => (f !== 'height' && f !== 'weight') || n.photo).filter((f) => f !== 'kidHeight' || n.kid);
};
form.kidAge.addEventListener('input', applyNeeds);
$('whoChips').addEventListener('change', () => {
  shoeChips();
  renderWantChips();
});

const BUDGETS = [500_000, 1_000_000, 2_000_000];
function budgetChips() {
  const now = form.budget.value.replace(/\s/g, '');
  $('budgetQuick').replaceChildren(...[...BUDGETS.map((b) => [String(b), fmt.num(b)]), ['', t('kiosk.form.budget_any')]].map(([v, label]) => {
    const b = el('button', { type: 'button', className: 'chip', textContent: label });
    b.setAttribute('aria-pressed', String(now === v));
    b.onclick = () => {
      form.budget.value = v;
      form.budget.dispatchEvent(new Event('input', { bubbles: true }));
    };
    return b;
  }));
}
form.budget.addEventListener('input', budgetChips);
initLang();
if (kiosk) keypad();
// Language switch on the start screen. Whatever is already drawn (weather, cart button, results) is redrawn in place.
const switcher = langSwitch(() => {
  if (mallHome) return mall.redraw();
  for (const id of ['cartError', 'checkoutError']) $(id).textContent = '';
  store ? renderWeather() : loadStore(); // loadStore redraws a start error (no store, offline) in the new language
  if (store) renderWantChips();
  if (store) drawOffers(false);
  setCart(cart);
  budgetChips();
  if (lastResult) renderResults(lastResult);
}, { short: !kiosk }); // the phone's topbar has room for "UZ / RU" only
$('langBox').replaceChildren(switcher);

// History routing (U2): one entry per screen, so the phone's back button steps back inside the app.
const formValues = () => ({ gender: form.gender.value, height: form.height.value, weight: form.weight.value, shoes: form.shoes.value, budget: form.budget.value, want: formWant(), occasion: form.occasion.value,
  audience: formAudience(), kidHeight: form.kidHeight.value });
const appState = () => ({ formOk: !!request, sizesOk: !!request && sizesReady(request.sizes, request.want), orderOk: !!lastOrder });
const remember = () => saveRoute({ screen: current, form: formValues(), sizes: request?.sizes, manual: sizeInfo?.manual, method: request?.method, fit: request?.fit, item: current === 'item' ? itemId : null, own: request?.own, roles: categoryRoles() });
const ENTER = {
  camera: () => showCamera(),
  results: () => (lastResult ? renderResults(lastResult) : loadResults()),
  cart: () => (mallLook ? toMallCart() : renderCartScreen()),
  catalog: () => loadCatalog(),
  item: (data) => loadItem(data.item ?? itemId),
};
const PARENT = { form: 'start', camera: 'form', results: 'form', cart: () => (request ? 'results' : 'start'), done: 'start', catalog: 'start', item: 'catalog' };
// Funnel drop-off (task 24): one random id per customer visit, one event per step reached (the server keeps the first).
// Only ids and the step: no sizes, photo, name or phone. Forgotten at the kiosk reset.
const FUNNEL = { form: 'start', catalog: 'start', item: 'start', camera: 'size', results: 'outfits', cart: 'cart', done: 'order' };
let visit = null;
function track(name) {
  if (!FUNNEL[name] || !(storeId > 0)) return;
  visit ??= randomId();
  // mode (task 30): whole outfit or single items, on the steps after the form (on 'start' it is not chosen yet).
  const mode = request && FUNNEL[name] !== 'start' ? { mode: request.want ? 'single' : 'outfit' } : {};
  api('/funnel', { store_id: storeId, visit, step: FUNNEL[name], ...(kiosk && { device: kioskDevice() }), ...mode }).catch(() => {});
}
const NO_STEPS = ['start', 'done', 'catalog', 'item']; // the catalogue is outside the four-step flow
function render(name, data = {}) {
  if (mallHome) return; // task 38: the mall screen routes itself by its #cart hash (mall.js); no shop screen here
  track(name);
  tryon.clear(); // a try-on photo or picture never outlives its screen
  if (name !== 'camera') stopCamera();
  if (name !== 'cart') clearInterval(holdTimer);
  current = name;
  for (const s of document.querySelectorAll('[data-screen]')) s.hidden = s.dataset.screen !== name;
  $('home').hidden = name === 'start';
  $('back').hidden = name === 'start' || name === 'done';
  $('langBox').hidden = name !== 'start'; // the language is picked before starting
  $('steps').hidden = NO_STEPS.includes(name);
  for (const li of $('steps').children) li.dataset.step === name ? li.setAttribute('aria-current', 'step') : li.removeAttribute('aria-current');
  window.scrollTo(0, 0);
  document.querySelector(`[data-screen="${name}"] h1`).focus({ preventScroll: true });
  ENTER[name]?.(data);
  syncCartUi();
  remember();
}
const router = createRouter(window, { render, allowed: (s, data) => allowedScreen(s, { ...appState(), itemOk: !!data?.item }) });
const go = (name, opts) => router.go(name, opts);
$('back').onclick = () => router.back(typeof PARENT[current] === 'function' ? PARENT[current]() : PARENT[current] ?? 'start');
form.addEventListener('input', () => remember());
form.addEventListener('change', () => remember());

function setCart(c) {
  if (c?.token !== cart?.token) { // another cart (or none): the next customer starts with points on and no QR waiting
    usePoints = true;
    delete $('pointsBox').dataset.waiting;
  }
  cart = c;
  savedCart(inMall ? mallCart?.token ?? null : c?.token ?? null);
  syncCartUi();
  syncs.forEach((f) => f());
  if (current === 'cart') renderCartScreen();
}
// Task 38: a mall cart from the server; this shop's part becomes the cart the shop screens work with.
function setMall(v) {
  mallCart = v;
  setCart(v?.shops.find((s) => s.store.id === storeId)?.cart ?? null);
}
// Topbar bag button, or on the results screen a sticky bar with the count and the running total (D2).
// Task 42: a mall outfit has no shop of its own, so the bar shows the whole mall cart (count and the shops' totals).
const mallSum = () => mallCart?.shops.reduce((a, s) => a + s.cart.totals.pickup.total, 0) ?? 0;
function syncCartUi() {
  const n = mallLook ? mallCart?.count ?? 0 : cart ? cart.items.reduce((s, i) => s + i.quantity, 0) : 0;
  const bar = n > 0 && current === 'results';
  $('cartBar').hidden = !bar;
  document.documentElement.classList.toggle('has-bar', bar);
  $('cartBtn').hidden = !n || bar || current === 'cart';
  $('cartBtn').replaceChildren(icon('bag'), el('span', { className: 'cart-label', textContent: t('kiosk.cart') }), el('span', { className: 'count-pill', textContent: n }));
  if (!n) return;
  $('barCount').textContent = t('kiosk.bar.count', { n });
  $('barTotal').textContent = som(mallLook ? mallSum() : cart.totals.pickup.total); // after the bundle / promo discounts
}
const toMallCart = () => location.assign(`${location.pathname}?mall=${mallId}#cart`);
$('barGo').onclick = () => (mallLook ? toMallCart() : go('cart'));

// Start-screen weather: an icon and a one-line outfit hint from the same rules the engine uses (rain, cold, cool, warm).
const weatherIcon = (w) => (w.raining ? 'rain' : w.temperature < 5 ? 'snow' : w.temperature < 18 ? 'cloud-sun' : 'sun');
const weatherHint = (w) => (w.raining ? ['umbrella', 'kiosk.weather.rain']
  : w.temperature < 5 ? ['outerwear', 'kiosk.weather.cold']
  : w.temperature < 18 ? ['outerwear', 'kiosk.weather.cool']
  : ['top', 'kiosk.weather.warm']);
const weatherLine = (w) => t(w.raining ? 'kiosk.weather.line_rain' : 'kiosk.weather.line', { t: Math.round(w.temperature) });

async function api(path, body, method = body ? 'POST' : 'GET') {
  // The server answers errors in this language (Accept-Language is a fetch-settable header).
  const headers = { 'accept-language': getLang(), ...(body && { 'content-type': 'application/json' }) };
  const res = await fetch('/api' + path, { method, headers, ...(body && { body: JSON.stringify(body) }) });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || t('common.error')), { status: res.status, code: data.code, item: data.item, store: data.store });
  return data;
}

let refused = ''; // task 45: the heartbeat's refusal message, if the plan has no room for this kiosk
async function loadStore() {
  tryon.setProvider(null); // until this store says it has try-on on
  $('startError').textContent = '';
  $('catalogBtn').hidden = $('profileLogin').hidden = true;
  $('storePicker').hidden = $('shopOffers').hidden = true;
  $('start').disabled = true;
  if (mallLook) return loadMallLook();
  if (!Number.isInteger(storeId) || storeId < 1) return showPicker('kiosk.start.no_store');
  try {
    store = await api('/stores/' + storeId);
  } catch (err) {
    if (err.status === 404) return showPicker('kiosk.start.store_404');
    $('weather').hidden = $('lookbook').hidden = true;
    $('startError').textContent = t('kiosk.start.offline');
    $('start').disabled = false;
    $('startLabel').textContent = t('common.retry');
    return;
  }
  $('storeName').textContent = store.name;
  // Task 45: a read-only shop (its plan ended) or a kiosk its plan has no room for: no flow starts here.
  if (store.paused || refused) {
    $('weather').hidden = $('lookbook').hidden = true;
    $('startError').textContent = store.paused ? t('kiosk.start.paused') : refused;
    $('startLabel').textContent = t('kiosk.start.go');
    return;
  }
  tryon.setProvider(store.tryon, store.tryon_outfit, store.tryon_roles); // task 41: the provider's name, absent when try-on is off here (no key, switched off, today's limit)
  setCategories(store.categories.map((c) => [c.id, c.role]));
  renderWantChips(formWant());
  restoredWant = null;
  if (lastResult?.groups) renderResults(lastResult); // a refresh drew the single items before their category names came
  $('startLabel').textContent = t('kiosk.start.go');
  $('start').disabled = false;
  $('catalogBtn').hidden = false;
  $('profileLogin').hidden = !(kiosk && store.profile); // task 27: only with the Telegram bot
  renderWeather();
  $('lookbook').replaceChildren(...store.looks.map((l) => el('img', { src: l.image_url, alt: '' })));
  $('lookbook').hidden = store.looks.length < 2;
  drawOffers(true);
}

// Task 43: the shop's own current offers on its start screen (no mall approval needed here). One linked to an item in
// stock opens it; the others are just shown. Counted as shown once per start screen load.
function drawOffers(count) {
  const list = store?.offers ?? [];
  $('shopOffers').hidden = !list.length;
  $('shopOfferList').replaceChildren(...list.map((o) => offerCard(o, { place: false, onOpen: o.item_id ? () => go('item', { data: { item: o.item_id } }) : null })));
  if (count) countOffers({ shown: list.map((o) => o.id) });
}

// Task 42: the start screen of a mall outfit: the mall's name and the start button (the weather comes with the results).
async function loadMallLook() {
  $('weather').hidden = $('lookbook').hidden = true;
  const h1 = document.querySelector('[data-screen="start"] h1');
  h1.dataset.i18n = 'kiosk.mall.look'; // kept for the language switch
  h1.textContent = t(h1.dataset.i18n);
  try {
    const m = await api('/malls/' + mallId);
    store = { name: m.name, city: m.city, categories: [], looks: [] };
  } catch (err) {
    if (err.status === 404) return location.replace(`${location.pathname}?mall=${mallId}`); // the mall screen says it is gone
    $('startError').textContent = t('kiosk.start.offline');
    $('start').disabled = false;
    $('startLabel').textContent = t('common.retry');
    return;
  }
  $('storeName').textContent = store.name;
  document.querySelector('fieldset.want').hidden = true; // whole outfits only
  setCategories([]);
  restoredWant = null;
  renderWantChips(null);
  $('startLabel').textContent = t('kiosk.start.go');
  $('start').disabled = false;
}

// U10: a missing or wrong store in the link is not a dead end: list the stores (public, names only).
async function showPicker(why) {
  if (current !== 'start') go('start', { replace: true }); // a saved route for a store that no longer exists
  $('weather').hidden = $('start').hidden = $('lookbook').hidden = true;
  let stores;
  try {
    stores = await api('/stores');
  } catch {
    $('start').hidden = $('start').disabled = false;
    $('startLabel').textContent = t('common.retry');
    $('startError').textContent = t('kiosk.start.offline');
    return;
  }
  $('storePicker').hidden = false;
  $('storePicker').replaceChildren(
    el('h2', { textContent: t('kiosk.picker.title') }),
    el('p', { className: 'muted', textContent: t(why) }),
    el('ul', { className: 'store-list', ariaLabel: t('kiosk.picker.aria') }, ...stores.map((s) => el('li', {},
      el('a', { className: 'button store-link', href: `${location.pathname}?store=${s.id}` }, icon('store'),
        el('span', {}, el('strong', { textContent: s.name }), el('span', { className: 'meta', textContent: s.city })), icon('chevron-right'))))),
  );
}

function renderWeather() {
  const w = store.weather;
  if (!w) return; // task 42: a mall outfit's start screen has none
  $('weather').hidden = $('start').hidden = false;
  $('weather').classList.remove('loading');
  $('weather').removeAttribute('aria-busy');
  const [hintIcon, hintKey] = weatherHint(w);
  $('weather').replaceChildren(
    icon(weatherIcon(w)),
    el('div', { className: 'muted', textContent: t('kiosk.weather.now', { city: store.city }) }),
    el('div', { className: 'temp', textContent: weatherLine(w) }),
    el('div', { className: 'muted feels', textContent: [w.apparent_temperature !== null && t('kiosk.weather.feels', { t: Math.round(w.apparent_temperature) }), w.source === 'fallback' && t('kiosk.weather.fallback')].filter(Boolean).join(' · ') }),
    el('p', { className: 'hint-line' }, icon(hintIcon), t(hintKey)),
  );
}

$('start').onclick = () => (store ? go('form') : loadStore());
$('catalogBtn').onclick = () => go('catalog');

// Inline validation (U3): a field is checked when it is left with a value, and its error clears as soon as it is fine.
// The error keeps its key in data-i18n, so a language switch translates it too.
function showError(name, key) {
  const box = $(`${name}Err`);
  key ? (box.dataset.i18n = key) : delete box.dataset.i18n;
  box.textContent = key ? t(key) : '';
  for (const i of document.getElementsByName(name)) i.setAttribute('aria-invalid', String(!!key));
}
function inline(f, names) {
  const on = (event) => (e) => {
    const n = e.target.name;
    if (!names.includes(n)) return;
    const key = nextError(event, n, f.elements[n].value, $(`${n}Err`).textContent);
    if (key !== undefined) showError(n, key);
  };
  f.addEventListener('focusout', on('blur'));
  f.addEventListener('input', on('input'));
  f.addEventListener('change', on('input'));
}
// On submit: every error at once, focus on the first one.
function checkAll(f, names) {
  const bad = names.filter((n) => {
    const key = nextError('submit', n, f.elements[n].value);
    showError(n, key);
    return key;
  });
  if (bad.length) (f.elements[bad[0]][0] ?? f.elements[bad[0]]).focus();
  return !bad.length;
}
const FORM_FIELDS = ['gender', 'height', 'weight', 'budget', 'kidHeight'];
inline(form, FORM_FIELDS);

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!checkAll(form, formFields())) return;
  ({ body, request } = toReq(formValues()));
  sizeInfo = sizeInput = lastResult = null;
  // Task 30: shoes (the form's chips) and accessories need no size step. Task 40: a child never gets it (no photo).
  if (!sizeNeeds(request.want, request.audience).photo) return go('results');
  go('camera');
});

$('changeSizes').onclick = () => go('form');

// --- Screen 3: size from photo. Kiosk: 3 s countdown. Phone: 10 s timer (to step back) or a gallery photo.
const COUNTDOWN = kiosk ? 3 : 10;
const video = $('video');
const cameraScreen = document.querySelector('[data-screen="camera"]');
let stream = null;
let timer = null;
let busy = false;
let attempt = 0; // bumped on every stop, so a late camera permission can't start a stale countdown

function status(text) {
  $('cameraStatus').hidden = !text;
  $('cameraStatus').textContent = text || '';
}

function setBusy(on) {
  busy = on;
  for (const id of ['shoot', 'galleryBtn', 'noPhoto', 'wayNext']) $(id).disabled = on;
  if (on) clearPartial();
}

function showCamera() {
  status('');
  showWay(cameraScreen.dataset.mode);
  $('shootLabel').textContent = t('kiosk.camera.shoot');
  $('galleryBtn').hidden = kiosk;
  loadPose().catch(() => {}); // start the model download while the customer gets ready
}

function stopCamera() {
  attempt += 1;
  clearInterval(timer);
  timer = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  video.hidden = true;
  stopFraming();
  clearPartial();
  $('frame').classList.remove('live');
  $('count').textContent = '';
  setBusy(false);
}

$('shoot').onclick = async () => {
  if (busy) return;
  setBusy(true);
  status('');
  const mine = attempt;
  let s;
  try {
    s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
  } catch (err) {
    // No mediaDevices at all on plain http (not localhost): the camera needs HTTPS.
    stopCamera();
    const why = t(err.name === 'NotAllowedError' ? 'kiosk.camera.denied' : 'kiosk.camera.broken');
    return status(t(kiosk ? 'kiosk.camera.then_kiosk' : 'kiosk.camera.then_phone', { why }));
  }
  if (mine !== attempt) return s.getTracks().forEach((t) => t.stop()); // left the screen during the permission prompt
  stream = s;
  video.srcObject = stream;
  video.hidden = false;
  $('frame').classList.add('live'); // the pose figure becomes a guide line over the live picture (U6)
  await video.play().catch(() => {});
  startFraming(mine);
  let left = COUNTDOWN;
  $('count').textContent = left;
  timer = setInterval(() => {
    left -= 1;
    $('count').textContent = left || '';
    if (left > 0) return;
    clearInterval(timer);
    stopFraming(); // the hint must not keep reading the last frame while the photo is analysed
    const canvas = document.createElement('canvas'); // in memory only, dropped right after measuring
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    stream.getTracks().forEach((t) => t.stop());
    analyse(canvas, canvas.width, canvas.height).finally(() => { canvas.width = canvas.height = 0; });
  }, 1000);
};

$('galleryBtn').onclick = () => $('gallery').click();
$('gallery').onchange = async () => {
  const file = $('gallery').files[0];
  $('gallery').value = ''; // the same photo can be picked again after a retry
  if (!file || busy) return;
  setBusy(true);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    setBusy(false);
    return status(t('kiosk.camera.bad_file'));
  }
  try {
    await analyse(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
};

$('noPhoto').onclick = () => findSizes({});

async function analyse(source, w, h) {
  status(t('kiosk.camera.analysing'));
  let pose;
  try {
    pose = await measure(source, w, h);
  } catch {
    stopCamera();
    return status(t('kiosk.camera.failed'));
  }
  stopCamera();
  if (cameraScreen.hidden) return; // kiosk reset or "Orqaga" while the model was working
  if (!pose) {
    $('shootLabel').textContent = t('common.retry');
    return status(t('kiosk.camera.no_body'));
  }
  await findSizes({ pose }, snapshot(source, w, h));
}

// The stylist (task 7) gets one small JPEG: in memory only, sent with /api/recommend, dropped on reset.
// Task 41: the try-on asks for a bigger one (tryon.js), sent once and dropped.
function snapshot(source, w, h, max = 512, quality = 0.7) {
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  const jpeg = c.toDataURL('image/jpeg', quality);
  c.width = c.height = 0;
  return jpeg;
}

// input: {} (height + weight only), { pose }, { usual } or { tape }.
async function findSizes(input, photo = null) {
  setBusy(true);
  try {
    sizeInfo = await api('/size', { ...body, ...input });
  } catch (err) {
    setBusy(false);
    if (input.usual || input.tape) return wayError(err.message);
    $('shootLabel').textContent = t('common.retry');
    return status(err.message);
  }
  setBusy(false);
  if (cameraScreen.hidden) return;
  sizeInput = input.usual || input.tape ? input : null;
  // Task 29: a partial photo says what it measured; the customer retakes it or goes on with it.
  // An upper-body photo measured the top; when only the top is wanted (task 30) there is nothing to ask.
  if (sizeInfo.method === 'torso' || (sizeInfo.method === 'upper' && sizeNeeds(request.want).bottom)) return askPartial(photo);
  toResults(photo);
}
function toResults(photo) {
  const n = sizeNeeds(request.want); // task 30: only the sizes this choice needs
  for (const k of ['top', 'bottom']) if (n[k]) request.sizes[k] = sizeInfo.sizes[k];
  request.method = sizeInfo.method;
  request.photo = photo ?? undefined; // undefined is left out of the JSON
  lastResult = null;
  go('results', { replace: true }); // back from the outfits goes to the form, not to the camera
}

// The JPEG for the stylist waits in these buttons only; any other step on this screen drops them.
function askPartial(photo) {
  const text = partialText();
  status('');
  const again = el('button', { type: 'button', onclick: () => {
    clearPartial();
    $('shootLabel').textContent = t('common.retry');
    $('shoot').focus();
  } }, icon('camera'), el('span', { textContent: t('kiosk.size.retake') }));
  $('partial').replaceChildren(el('div', { className: 'notice', role: 'status' }, icon('info'), el('p', { textContent: text })),
    el('div', { className: 'stack-actions' }, el('button', { type: 'button', className: 'primary', onclick: () => toResults(photo) }, t('kiosk.size.go_on')), again));
  $('partial').hidden = false;
}
function clearPartial() {
  $('partial').replaceChildren();
  $('partial').hidden = true;
}

// Task 29: live framing hint. The model looks at the live video every FRAMING_MS (never a copy of it) and lights up the
// parts it sees. A slow device stops after two slow frames and only checks the photo after capture.
const FRAMING_MS = 700, SLOW_MS = 250;
let framingTimer = null, slowFrames = 0;
function startFraming(mine) {
  if (slowFrames >= 2) return;
  const tick = async () => {
    if (mine !== attempt || !stream) return;
    if (video.readyState >= 2) {
      let parts, ms;
      try {
        await loadPose(); // the download doesn't count as slow
        const t0 = performance.now();
        parts = await framing(video);
        ms = performance.now() - t0;
      } catch {
        return stopFraming();
      }
      if (mine !== attempt) return;
      for (const p of $('parts').querySelectorAll('[data-part]')) p.classList.toggle('on', parts[p.dataset.part]);
      $('framing').textContent = t(framingHint(parts));
      $('parts').removeAttribute('hidden'); // an <svg> has no .hidden property
      $('framing').hidden = false;
      if (ms > SLOW_MS && ++slowFrames >= 2) return stopFraming();
    }
    framingTimer = setTimeout(tick, FRAMING_MS);
  };
  framingTimer = setTimeout(tick, FRAMING_MS);
}
function stopFraming() {
  clearTimeout(framingTimer);
  framingTimer = null;
  $('parts').setAttribute('hidden', '');
  $('framing').hidden = true;
}

// Task 29: three ways to a size on this screen: a photo, the usual size, or tape measurements.
const wayForm = $('wayForm');
const radioChips = (box, name, options) => box.append(...options.map(([v, text]) => el('label', {}, el('input', { type: 'radio', name, value: v }), el('span', { textContent: text }))));
radioChips($('usualTopChips'), 'usualTop', CLOTHES.map((s) => [s, s]));
radioChips($('jeansChips'), 'jeans', JEANS.map((w) => [String(w), `W${w}`]));
function showWay(mode) {
  cameraScreen.dataset.mode = mode;
  for (const r of document.getElementsByName('way')) r.checked = r.value === mode;
  for (const box of cameraScreen.querySelectorAll('[data-way]')) box.hidden = !box.dataset.way.split(' ').includes(mode);
}
cameraScreen.querySelector('.ways').addEventListener('change', (e) => {
  if (busy) return showWay(cameraScreen.dataset.mode); // measuring: stay on this way
  stopCamera();
  status('');
  wayError('');
  showWay(e.target.value);
});
function wayError(text) {
  $('wayErr').textContent = text;
}
// Like the form (U3): a pick or a keystroke clears the error at once; submit checks again.
for (const ev of ['input', 'change']) wayForm.addEventListener(ev, () => wayError(''));
const TAPE = [['chest', 'chest', 60, 160], ['tapeWaist', 'waist', 50, 160], ['hips', 'hip', 60, 170]];
wayForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) return;
  const f = wayForm.elements;
  let input;
  if (cameraScreen.dataset.mode === 'usual') {
    const usual = { ...(f.usualTop.value && { top: f.usualTop.value }), ...(f.jeans.value && { waist: Number(f.jeans.value) }) };
    if (!Object.keys(usual).length) return wayError(t('kiosk.size.err_usual'));
    input = { usual };
  } else {
    const tape = {};
    for (const [name, key, lo, hi] of TAPE) {
      const v = f[name].value.trim();
      if (!v) continue;
      if (!/^\d+$/.test(v) || Number(v) < lo || Number(v) > hi) return wayError(t('kiosk.size.err_tape'));
      tape[key] = Number(v);
    }
    if (!Object.keys(tape).length) return wayError(t('kiosk.size.err_tape'));
    input = { tape };
  }
  wayError('');
  request.fit = f.fit.value || null;
  findSizes(input);
});

// --- Screen 4: results, with - / + to correct the estimated size.
const CONFIDENCE = { high: 'kiosk.conf.high', medium: 'kiosk.conf.medium', low: 'kiosk.conf.low' };

function renderSizes() {
  const want = request.want;
  const list = request.audience === 'child' ? KIDS : CLOTHES; // task 40: a child steps through the height sizes
  const stepper = (key) => {
    const label = cat(key === 'top' && want && !want.includes('top') ? 'outerwear' : key); // task 30: only a jacket wanted
    const i = list.indexOf(request.sizes[key]);
    const move = (d) => () => {
      request.sizes[key] = list[i + d];
      sizeInfo = { ...sizeInfo, manual: true };
      loadResults();
    };
    return el('div', { className: 'stepper' }, el('span', { textContent: label }),
      el('button', { type: 'button', ariaLabel: t('kiosk.size.smaller', { label }), disabled: i <= 0, onclick: move(-1) }, icon('minus')),
      el('strong', { textContent: request.sizes[key] }),
      el('button', { type: 'button', ariaLabel: t('kiosk.size.bigger', { label }), disabled: i >= list.length - 1, onclick: move(1) }, icon('plus')));
  };
  const keys = ['top', 'bottom'].filter((k) => sizeNeeds(want)[k]);
  if (!keys.length) return $('sizeBar').replaceChildren(); // task 30: shoes or accessories only
  $('sizeBar').replaceChildren(
    el('div', { className: 'row' }, ...keys.map(stepper)),
    // After a refresh the confidence is gone (it is not stored), so only the − / + hint is left.
    el('p', { className: 'meta', textContent: sizeInfo?.manual ? t('kiosk.size.manual') : request.audience === 'child' ? t('kiosk.child.size_note') : t('kiosk.size.adjust', { conf: sizeNote() }).trim() }),
  );
}

// A partial photo says what it measured (task 29); otherwise the confidence.
function sizeNote() {
  if (sizeInfo?.method === 'upper' || sizeInfo?.method === 'torso') return partialText();
  return CONFIDENCE[sizeInfo?.confidence] ? t(CONFIDENCE[sizeInfo.confidence]) : '';
}
const partialText = () => (sizeInfo.method === 'upper' ? t('kiosk.size.measured_upper', { from: t(body?.weight ? 'kiosk.size.from_hw' : 'kiosk.size.from_h') }) : t('kiosk.size.measured_torso'));

let loadSeq = 0; // only the newest /recommend answer may draw (fast − / + taps)
let lastResult = null; // kept so a language switch can redraw without asking again
async function loadResults() {
  const seq = ++loadSeq;
  lastResult = null;
  syncs = new Set();
  chosen.clear();
  remember();
  renderSizes();
  $('resultsWeather').textContent = '';
  // Screen readers get one summary line per load (U13), not the whole list again after every − / +.
  $('resultsStatus').textContent = t('kiosk.results.loading');
  $('results').replaceChildren();
  const done = showAfter(300, () => seq === loadSeq && $('results').replaceChildren(el('div', { className: 'outfits' }, skeletonCard(5), skeletonCard(5), skeletonCard(5))));
  let r;
  try {
    r = await api(mallLook ? '/recommend/mall' : '/recommend', request);
  } catch (err) {
    done();
    if (seq !== loadSeq) return;
    $('resultsStatus').textContent = err.message;
    $('results').replaceChildren(el('p', { className: 'error', textContent: err.message }), el('button', { className: 'primary', textContent: t('common.retry'), onclick: loadResults }));
    return;
  }
  done();
  if (seq !== loadSeq) return;
  request.rec = r.rec; // −/+ re-queries update the same pilot log row
  renderResults(r);
}

function renderResults(r) {
  lastResult = r;
  syncs = new Set();
  renderSizes();
  $('resultsWeather').textContent = [t('kiosk.results.weather', { weather: weatherLine(r.weather) }), r.budget && t(r.groups ? 'kiosk.single.budget' : 'kiosk.results.budget', { sum: som(r.budget) }),
    r.occasion && t('kiosk.results.occasion', { occasion: t(`kiosk.occasion.${r.occasion}`) })].filter(Boolean).join(' · '); // task 33
  const h1 = document.querySelector('[data-screen="results"] h1');
  h1.dataset.i18n = r.groups ? 'kiosk.single.title' : 'kiosk.results.title'; // kept for the language switch
  h1.textContent = t(h1.dataset.i18n);
  if (r.groups) return renderSingles(r);
  $('resultsStatus').textContent = r.outfits.length ? t('kiosk.results.found', { n: r.outfits.length }) : t('kiosk.results.none');
  if (!r.outfits.length) {
    $('results').replaceChildren(el('div', { className: 'empty' }, icon('hanger'), el('p', { textContent: t('kiosk.results.empty') })));
    return;
  }
  const warn = (key, vars) => el('div', { className: 'notice warn' }, icon('info'), el('p', { textContent: t(key, vars) }));
  $('results').replaceChildren(
    ...(r.style_guess ? [el('p', { className: 'muted', textContent: t('kiosk.results.style', { style: r.style_guess }) })] : []),
    ...(r.notice === 'no_outerwear' ? [warn('kiosk.results.no_outerwear')] : []),
    ...(r.relaxed ? [el('p', { className: 'muted', textContent: t('kiosk.results.relaxed', { n: r.relaxed }) })] : []),
    ...(r.over_budget > 0 ? [warn('kiosk.results.over_budget', { sum: som(r.over_budget) })] : []),
    // Task 60: "AI ko'zgu" over every item of these outfits (never for a child), the in-store try-on mirror.
    ...(r.audience ? [] : [tryon.mirrorButton([...new Map(r.outfits.flatMap((o) => o.items).map((p) => [p.id, p])).values()].filter((p) => sizeOf(p)), (p) => addButton([p], $('results')))]),
    el('div', { className: 'outfits' }, ...(r.partial ? [partialCard(r.partial)] : []), ...r.outfits.map((o, i) => outfitCard(o, i + 1))),
    ...(mallLook ? [] : [triedCard()]), // task 42: "Kiyib ko'rdim" belongs to one shop's results screen
    ...(store?.profile && !kiosk && !r.audience ? [profileBox(r.outfits.map((o) => o.items.map((i) => i.id)))] : []), // phone flow: keep sizes + these looks (an adult's: a child's sizes never go into the profile)
  );
}

// Task 30: single items, one section per wanted category (best first, in the customer's size, within budget per item).
function renderSingles(r) {
  const n = r.groups.reduce((a, g) => a + g.items.length, 0);
  $('resultsStatus').textContent = n ? t('kiosk.single.found', { n }) : t('kiosk.results.none');
  const warn = (key, vars) => el('div', { className: 'notice warn' }, icon('info'), el('p', { textContent: t(key, vars) }));
  $('results').replaceChildren(
    ownBox(),
    ...(r.style_guess ? [el('p', { className: 'muted', textContent: t('kiosk.results.style', { style: r.style_guess }) })] : []),
    ...(r.relaxed ? [el('p', { className: 'muted', textContent: t('kiosk.results.relaxed', { n: r.relaxed }) })] : []),
    ...r.groups.map((g) => el('section', { className: 'single-group' }, el('h2', { textContent: wantName(g.category) }),
      ...(g.over_budget > 0 ? [warn('kiosk.single.over_budget', { sum: som(g.over_budget) })] : []),
      g.items.length ? el('div', { className: 'outfits' }, ...g.items.map(singleCard))
        : el('div', { className: 'empty' }, icon('hanger'), el('p', { textContent: t('kiosk.single.empty', { cat: wantName(g.category) }) })))),
    ...(n ? [triedCard()] : []),
    ...(store?.profile && !kiosk && !r.audience ? [profileBox()] : []), // phone: keep the sizes (no outfit to keep; not a child's)
  );
}

// One item: the outfit card's photo, row, add and cabin buttons, plus its cheaper variant and "Shu bilan yaxshi ketadi"
// as optional extras (opened on their item page, never put in the cart for the customer).
function singleCard(p) {
  const c = card(productName(p), [p], p.unit_price, '', null);
  c.querySelector('.items .name').remove(); // the heading already names it
  c.querySelector('.total').remove(); // one item: its price is the total
  const body = c.querySelector('.outfit-body');
  const alt = p.alternative;
  if (alt) {
    body.append(el('div', { className: 'alt' }, thumb(alt),
      el('div', {}, el('strong', { textContent: t('kiosk.outfit.alt') }),
        el('div', { className: 'meta', textContent: t('kiosk.single.alt_save', { swap: productName(alt), sum: som(p.unit_price - alt.unit_price) }) })),
      picker(alt),
      addButton([alt], c, '', 'kiosk.outfit.alt_add')));
  }
  if (p.pairs.length) {
    body.append(el('div', { className: 'pairs-mini' }, el('div', { className: 'meta', textContent: t('kiosk.item.pairs') }),
      el('ul', {}, ...p.pairs.map((x) => el('li', {}, el('button', { type: 'button', className: 'ghost', onclick: () => go('item', { data: { item: x.id } }) },
        thumb(x), el('span', { className: 'name', textContent: productName(x) }), el('span', { className: 'meta', textContent: som(x.unit_price) })))))));
  }
  return c;
}

// Task 30, "Bor kiyimimga mos": what the customer already has, from fixed lists (category, colour, optional style). Each
// change asks the server again: the same in-stock items are re-ranked to go with it.
const OWN_MAX = 3;
const ownName = (x) => [cat(x.category), colorName(x.color), x.style && t(`kiosk.style.${x.style}`)].filter(Boolean).join(', ');
function setOwn(own) {
  request.own = own;
  loadResults();
}
function ownBox() {
  const own = request.own ?? [];
  const box = el('section', { className: 'card own' }, el('h2', { textContent: t('kiosk.own.title') }), el('p', { className: 'muted', textContent: t('kiosk.own.hint') }),
    ...(own.length ? [el('ul', { className: 'own-list' }, ...own.map((x, i) => el('li', {}, el('span', { textContent: ownName(x) }),
      el('button', { type: 'button', className: 'icon-btn ghost', ariaLabel: t('kiosk.own.remove', { name: ownName(x) }), onclick: () => setOwn(own.filter((_, j) => j !== i)) }, icon('close')))))] : []));
  if (own.length < OWN_MAX) {
    const open = el('button', { type: 'button', className: 'secondary' }, icon('plus'), t('kiosk.own.add'));
    open.onclick = () => {
      const f = ownForm();
      open.replaceWith(f);
      f.querySelector('.chip').focus();
    };
    box.append(open);
  }
  return box;
}
function ownForm() {
  const pick = { category: null, color: null, style: null };
  const err = el('p', { className: 'field-error', role: 'alert' });
  const row = (key, label, options) => el('div', { className: 'own-row' }, el('div', { className: 'meta', textContent: t(label) }),
    chipRow(options, null, t(label), (v) => { pick[key] = v; err.textContent = ''; }));
  return el('div', { className: 'own-form' },
    row('category', 'kiosk.own.category', WANT.map((c) => [c, cat(c)])),
    row('color', 'kiosk.own.color', COLORS.map((c) => [c, colorName(c)])),
    row('style', 'kiosk.own.style', STYLES.map((x) => [x, t(`kiosk.style.${x}`)])),
    el('button', { type: 'button', className: 'primary', onclick: () => {
      if (!pick.category || !pick.color) return void (err.textContent = t('kiosk.own.err'));
      setOwn([...(request.own ?? []), pick]);
    } }, t('kiosk.own.save')), err);
}

// Pilot report: the customer says they tried the suggestion on (the shelf numbers are on each item above).
function triedCard() {
  const b = el('button', { type: 'button', textContent: t('kiosk.tried.btn') });
  b.onclick = async () => {
    b.disabled = true;
    try {
      await api('/recommend/tried', { rec: request.rec });
      b.replaceChildren(icon('check'), t('kiosk.tried.thanks'));
    } catch {
      b.disabled = false;
    }
  };
  return el('div', { className: 'notice stack' }, el('p', { style: 'margin:0 0 var(--s-3)', textContent: t('kiosk.tried.ask') }), b);
}

const sizeName = (s) => (s === 'ONE' ? t('common.size_one') : s);
const thumb = (p) => (p.image_url ? el('img', { className: 'thumb', src: p.image_url, alt: '' }) : el('div', { className: 'thumb' }, icon(p.category || 'hanger')));
const chosen = new Map(); // product id → shoe size picked on the results screen (shared by an outfit and its cheaper variant)

// Chips (U11): one pressed chip per group; onPick gets the value. options: [[value, text]].
function chipRow(options, current, label, onPick) {
  const group = el('div', { className: 'size-chips', role: 'group', ariaLabel: label });
  group.append(...options.map(([s, text]) => {
    const b = el('button', { type: 'button', className: 'chip', textContent: text });
    b.setAttribute('aria-pressed', String(s === current));
    b.onclick = () => {
      group.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
      onPick(s);
    };
    return b;
  }));
  return group;
}
const sizeChips = (sizes, current, label, onPick) => chipRow(sizes.map((s) => [s, sizeName(s)]), current, label, onPick);

// Photo collage of an outfit (D2): the clothes, not the accessory, up to four.
function look(items) {
  const pics = items.filter((p) => p.category !== 'accessory').slice(0, 4);
  return el('div', { className: `look n${pics.length}` }, ...pics.map((p) => (p.image_url ? el('img', { src: p.image_url, alt: '' }) : el('div', { className: 'ph' }, icon(p.category || 'hanger')))));
}

// Unknown shoe size: the customer picks one of the in-stock sizes before adding (addButton finds it by data-pick).
function picker(p) {
  if (p.size || !p.sizes) return '';
  const err = el('p', { className: 'field-error' });
  const box = el('div', { className: 'pick' }, el('div', { className: 'meta', textContent: t('kiosk.size.pick') }),
    sizeChips(p.sizes, chosen.get(p.id), t('kiosk.size.aria', { name: productName(p) }), (s) => {
      chosen.set(p.id, s);
      err.textContent = '';
      syncs.forEach((f) => f());
    }), err);
  box.dataset.pick = p.id;
  return box;
}

const lowest = (terms) => terms.reduce((a, b) => (b.monthly < a.monthly ? b : a)); // task 35: the smallest monthly amount
const priceEl = (p) => el('div', { className: p.discount_price ? 'price sale' : 'price' }, ...(p.discount_price ? [el('s', { textContent: som(p.price) })] : []), som(p.unit_price));

// swap(p, li): an outfit card's "Almashtirish" for this item (task 25); none on the partial card.
function itemRow(p, swap) {
  const size = p.size ? (p.size === 'ONE' ? t('common.size_one') : t('kiosk.size.value', { size: p.size })) : '';
  // The photo above shows the category, so the line says colour, size and shelf.
  const li = el('li', {},
    el('div', { className: 'name', textContent: productName(p) }),
    priceEl(p),
    el('div', { className: 'meta', textContent: [colorName(p.color), size, p.shelf_location && t('kiosk.shelf', { shelf: p.shelf_location })].filter(Boolean).join(' · ') }),
    shopLine(p),
    chartHint(p),
    fitHint(p),
    picker(p),
  );
  if (swap) {
    const b = el('button', { type: 'button', className: 'ghost swap', ariaLabel: t('kiosk.outfit.swap_aria', { name: productName(p) }) }, icon('refresh'), t('kiosk.outfit.swap'));
    b.setAttribute('aria-expanded', 'false');
    b.onclick = () => swap(p, li, b);
    li.append(b);
  }
  return li;
}

// Task 42: on a mall outfit every item names its shop, floor and unit.
const shopOfItem = (p) => (p.store_id && lastResult?.shops?.find((s) => s.id === p.store_id)) || null;
function shopLine(p) {
  const s = shopOfItem(p);
  if (!s) return '';
  return el('div', { className: 'meta shop-line' }, icon('store'),
    el('span', { textContent: [s.name, s.floor && t('kiosk.mall.floor', { n: s.floor }), s.unit && t('kiosk.mall.unit', { n: s.unit })].filter(Boolean).join(' · ') }));
}

// Task 48: this shop's own size chart put the customer in another size than their usual one (the screen says which).
const chartHint = (p) => (p.chart_from ? el('div', { className: 'fit-hint chart-hint' }, icon('ruler'),
  el('span', { textContent: t('kiosk.chart.shifted', { size: p.chart_size, from: p.chart_from }) })) : '');

// Task 23: this model runs small or big (learnt from buyers' answers and returns); the server already shifted the size.
function fitHint(p) {
  if (!p.fit_offset) return '';
  const text = [t(p.fit_offset > 0 ? 'kiosk.fit.small' : 'kiosk.fit.big'), p.fit_from && t('kiosk.fit.shifted', { from: p.fit_from, size: p.size })].filter(Boolean).join(': ');
  return el('div', { className: 'fit-hint' }, icon('info'), el('span', { textContent: text }));
}

// card: the outfit card, where a missing size picker is looked up.
const sizeOf = (p) => p.size ?? chosen.get(p.id);
const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
// An item without a size yet: take the customer to its picker (U11) instead of an error under the button. True if one was missing.
function needSize(items, card, msg) {
  const missing = items.find((p) => !sizeOf(p));
  if (!missing) return false;
  const pick = card.querySelector(`[data-pick="${missing.id}"]`);
  const text = t('kiosk.add.pick_size', { name: productName(missing) });
  if (!pick) return void (msg.textContent = text) || true;
  pick.querySelector('.field-error').textContent = text;
  pick.scrollIntoView({ block: 'center', behavior: smooth() });
  pick.querySelector('.chip').focus({ preventScroll: true });
  return true;
}

function addButton(items, card, className = 'primary wide', label = 'kiosk.add.btn', rec = request?.rec) {
  const size = sizeOf;
  const lines = () => (mallLook ? mallCart?.shops.flatMap((s) => s.cart.items) ?? [] : cart?.items ?? []);
  const has = (p) => lines().some((c) => c.product_id === p.id && (!size(p) || c.size === size(p)));
  const b = el('button', { className });
  const msg = el('p', { className: 'field-error', role: 'alert' });
  const sync = () => { b.disabled = items.every(has); b.replaceChildren(...(b.disabled ? [icon('check'), t('kiosk.add.done')] : [icon('bag'), t(label)])); };
  b.onclick = async () => {
    if (needSize(items, card, msg)) return;
    msg.textContent = '';
    b.disabled = true;
    try {
      const todo = items.filter((p) => !has(p)).map((p) => ({ product_id: p.id, size: size(p) }));
      // outfit (task 26): the whole card, so the server can match it to an outfit it showed (bundle discount).
      const add = { store_id: storeId, items: todo, rec, ...(rec && { outfit: items.map((p) => p.id) }) };
      if (mallLook) setMall(await api('/mall-cart/items', { token: mallCart?.token, mall_id: mallId, shops: byShop(items, todo) }));
      else if (inMall) setMall(await api('/mall-cart/items', { ...add, token: mallCart?.token, mall_id: mallId }));
      else setCart(await api('/cart/items', { ...add, token: cart?.token }));
    } catch (err) {
      msg.textContent = err.message;
      // Task 31: that size just sold out → offer to wait for it (once per card).
      const gone = err.code === 'out_of_stock' && store?.profile && items.find((p) => p.id === err.item?.product_id);
      if (gone && !wrap.querySelector('.alert-box')) wrap.append(alertBox(gone, err.item.size));
    }
    sync();
  };
  syncs.add(sync);
  sync();
  const wrap = el('div', { className: 'add' }, b, msg);
  return wrap;
}

// Task 42: a mall outfit goes to the mall cart as one part per shop, each with that shop's rec and its items of the card
// (its outfit part, for that shop's own bundle rule).
function byShop(items, todo) {
  return [...new Set(items.map((p) => p.store_id))].map((id) => ({
    store_id: id, items: todo.filter((x) => items.find((p) => p.id === x.product_id).store_id === id),
    rec: lastResult.recs[id], outfit: items.filter((p) => p.store_id === id).map((p) => p.id),
  })).filter((x) => x.items.length);
}
// Task 42: the bundle hint per shop whose part of this outfit (2+ items) earns that shop's own discount.
const shopBundles = (items) => (lastResult?.shops ?? []).filter((s) => s.bundle_percent && items.filter((p) => p.store_id === s.id).length >= 2);

function card(heading, items, total, reason, swap) {
  const c = el('article', { className: 'outfit card' });
  const pct = swap && !mallLook && lastResult?.bundle_percent; // task 26: only whole outfits (not the partial card) get the bundle discount
  const hint = (text) => el('p', { className: 'bundle-hint' }, icon('check'), text);
  const body = el('div', { className: 'outfit-body' },
    el('h2', { textContent: heading, tabIndex: -1 }),
    ...(reason ? [el('p', { className: 'muted reason', textContent: reason })] : []),
    ...(pct ? [hint(t('kiosk.bundle.hint', { pct }))] : []),
    ...(swap && mallLook ? shopBundles(items).map((s) => hint(t('kiosk.mall.bundle_hint', { shop: s.name, pct: s.bundle_percent }))) : []),
    el('ul', { className: 'items' }, ...items.map((p) => itemRow(p, swap))),
    el('div', { className: 'outfit-foot' }, el('div', { className: 'total' }, el('span', { textContent: t('common.total') }), el('strong', { textContent: som(total) })), addButton(items, c), mallLook ? '' : fittingBox(items, c))); // task 42: no one shop's staff for a mall outfit
  c.append(look(items), body);
  return c;
}

// "Kabinaga olib keling": staff bring the outfit in the picked sizes to the customer's cabin (also counts as tried).
function fittingBox(items, card, from = { rec: request?.rec }) {
  const box = el('div', { className: 'fit' });
  const msg = el('p', { className: 'field-error', role: 'alert' });
  const open = el('button', { type: 'button', className: 'ghost wide' }, icon('hanger'), t('kiosk.fit.btn'));
  open.onclick = () => {
    if (needSize(items, card, msg)) return;
    msg.textContent = '';
    const id = `cabin-${Math.random().toString(36).slice(2)}`;
    const input = el('input', { id, inputMode: 'numeric', autocomplete: 'off', maxLength: 2 });
    input.dataset.keys = 'digits';
    input.setAttribute('aria-describedby', `${id}-hint ${id}-err`);
    msg.id = `${id}-err`;
    const send = el('button', { type: 'submit', className: 'primary' }, t('kiosk.fit.send'));
    const f = el('form', { className: 'fit-form', noValidate: true },
      el('label', { className: 'field', htmlFor: id }, el('span', { textContent: t('kiosk.fit.cabin') }), input, el('span', { className: 'hint', id: `${id}-hint`, textContent: t('kiosk.fit.hint') })),
      send);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const cabin = Number(input.value);
      if (!/^\d{1,2}$/.test(input.value) || cabin < 1) {
        msg.textContent = t('kiosk.fit.err');
        input.setAttribute('aria-invalid', 'true');
        return input.focus();
      }
      input.setAttribute('aria-invalid', 'false');
      send.disabled = true;
      try {
        await api('/recommend/fitting', { ...from, cabin, items: items.map((p) => ({ product_id: p.id, size: sizeOf(p) })) });
        box.replaceChildren(el('p', { className: 'notice', role: 'status' }, icon('check'), t('kiosk.fit.sent', { cabin })));
      } catch (err) {
        msg.textContent = err.message;
        send.disabled = false;
      }
    };
    box.replaceChildren(f, msg);
    input.focus();
  };
  box.append(open, msg);
  return box;
}

function outfitCard(o, n) {
  const c = card(o.title ? t('kiosk.outfit.n_title', { n, title: o.title }) : t('kiosk.outfit.n', { n }), o.items, o.total, o.reason, (p, li, b) => swapBox(o, n, p, li, b));
  c.dataset.outfit = n;
  if (!lastResult?.audience) c.querySelector('.outfit-foot').append(tryon.button(o.items)); // task 41: never for a child; task 58: the whole outfit with Gemini
  // R5: the cheaper variant is one compact "swap X for Y, save N" row, not a second outfit.
  if (o.alternative) {
    const swap = o.alternative.items.find((p) => !o.items.some((x) => x.id === p.id));
    const old = o.items.find((p) => p.id === o.alternative.replaces);
    c.querySelector('.outfit-body').append(el('div', { className: 'alt' },
      thumb(swap),
      el('div', {}, el('strong', { textContent: t('kiosk.outfit.alt') }),
        el('div', { className: 'meta', textContent: t('kiosk.outfit.alt_save', { name: productName(old), swap: productName(swap), sum: som(o.total - o.alternative.total) }) }), shopLine(swap)),
      picker(swap),
      addButton(o.alternative.items, c, '', 'kiosk.outfit.alt_add'),
    ));
  }
  return c;
}

// Task 25: other items of the same category for one item of this outfit, picked and priced by the server (in stock in
// the customer's size, within budget, not in another outfit shown). Picking one redraws the results with the new outfit.
async function swapBox(o, n, p, li, btn) {
  const open = li.querySelector('.swap-box');
  btn.setAttribute('aria-expanded', String(!open));
  if (open) return open.remove();
  const box = el('div', { className: 'swap-box' }, el('p', { className: 'meta', role: 'status', textContent: t('kiosk.catalog.loading') }));
  li.append(box);
  const others = [...new Set(lastResult.outfits.filter((x) => x !== o).flatMap((x) => [...x.items, ...(x.alternative?.items ?? [])].map((i) => i.id)))];
  let r;
  try {
    r = await api(mallLook ? '/recommend/mall/swap' : '/recommend/swap', { ...request, photo: undefined, items: o.items.map((i) => i.id), replace: p.id, exclude: others, relaxed: lastResult.relaxed });
  } catch (err) {
    return box.replaceChildren(el('p', { className: 'field-error', role: 'alert', textContent: err.message }));
  }
  if (!r.options.length) return box.replaceChildren(el('p', { className: 'meta', role: 'status', textContent: t('kiosk.outfit.swap_none') }));
  if (r.shops) lastResult.shops = [...lastResult.shops, ...r.shops.filter((s) => !lastResult.shops.some((x) => x.id === s.id))]; // task 42
  box.replaceChildren(el('div', { className: 'meta', textContent: t('kiosk.outfit.swap_title') }), el('ul', { className: 'swap-list' }, ...r.options.map((opt) => {
    const x = opt.items.find((i) => i.id === opt.swap);
    const pick = () => {
      Object.assign(o, { items: opt.items, total: opt.total, alternative: null, reason: null }); // the old reason may name the old item
      renderResults(lastResult);
      $('results').querySelector(`[data-outfit="${n}"] h2`)?.focus();
    };
    return el('li', {}, thumb(x),
      el('div', {}, el('div', { className: 'name', textContent: productName(x) }),
        el('div', { className: 'meta', textContent: [shopOfItem(x)?.name, colorName(x.color), som(x.unit_price), t('kiosk.outfit.swap_total', { sum: som(opt.total) })].filter(Boolean).join(' · ') })),
      el('button', { type: 'button', className: 'secondary', onclick: pick }, t('kiosk.outfit.swap_pick')));
  })));
}

// Nothing fits the budget: the required items that do fit, cheapest first (the full cheapest outfit follows).
function partialCard(p) {
  return card(t('kiosk.partial.title'), p.items, p.total, p.missing.length ? t('kiosk.partial.missing', { cats: p.missing.map(cat).join(', ') }) : '');
}

// --- Task 25: catalogue and item page. The server sends only items and sizes with free stock now.
const PRICE_BANDS = [[null, 300_000], [300_000, 800_000], [800_000, null]]; // what the customer pays (discount price first)
const NO_FILTER = { audience: 'adult', category: '', gender: '', size: '', price: '', sort: '' }; // task 40: adults' items unless asked; task 46: sort
let filters = { ...NO_FILTER };
let itemId = null; // the open item page
let catalogSeq = 0, itemSeq = 0; // only the newest answer may draw

const bandName = ([lo, hi]) => (lo === null ? t('kiosk.catalog.price_upto', { sum: fmt.num(hi) })
  : hi === null ? t('kiosk.catalog.price_from', { sum: fmt.num(lo) }) : `${fmt.num(lo)} – ${fmt.num(hi)}`);
function renderFilters() {
  const f = filters;
  const child = f.audience === 'child';
  const cats = forAudience(f.audience);
  const picked = cats.find((c) => String(c.id) === f.category);
  const sizes = picked ? catSizes(picked) : child ? KIDS : CLOTHES;
  const all = ['', t('common.all')];
  const group = (key, label, options) => {
    const g = el('div', { className: 'filter' }, el('div', { className: 'meta', textContent: label }), chipRow([all, ...options], f[key], label, (v) => {
      filters = { ...filters, [key]: v, ...(key === 'category' && { size: '' }) };
      loadCatalog();
      $('catalogFilters').querySelector(`[data-group="${key}"] [aria-pressed="true"]`)?.focus(); // the chips were redrawn
    }));
    g.dataset.group = key;
    return g;
  };
  const catRow = group('category', t('field.category'), cats.map((c) => [String(c.id), catName(c)]));
  // Task 36: a category's photo (optional) leads its chip; the first chip is "all".
  catRow.querySelectorAll('.chip').forEach((b, i) => cats[i - 1]?.image_url && b.prepend(el('img', { className: 'chip-img', src: cats[i - 1].image_url, alt: '' })));
  // Task 40: adults or children, never both at once (no "all" chip); a switch starts the other filters over.
  const who = el('div', { className: 'filter' }, el('div', { className: 'meta', textContent: t('kiosk.catalog.section') }),
    chipRow([['adult', t('audience.adult')], ['child', t('audience.child')]], f.audience, t('kiosk.catalog.section'), (v) => {
      filters = { ...NO_FILTER, audience: v };
      loadCatalog();
      $('catalogFilters').querySelector('[data-group="audience"] [aria-pressed="true"]')?.focus();
    }));
  who.dataset.group = 'audience';
  $('catalogFilters').replaceChildren(
    who,
    catRow,
    group('gender', t('kiosk.catalog.gender'), [['male', t(child ? 'kiosk.child.boy' : 'gender.male')], ['female', t(child ? 'kiosk.child.girl' : 'gender.female')]]),
    group('price', t('field.price'), PRICE_BANDS.map((b, i) => [String(i), bandName(b)])),
    ...(sizes.length ? [group('size', t('kiosk.catalog.size'), sizes.map((x) => [x, x]))] : []),
    sortRow(),
  );
}
// Task 46: the shop's usual order, or the best visible rating first (the server sorts; unrated items follow).
function sortRow() {
  const g = el('div', { className: 'filter' }, el('div', { className: 'meta', textContent: t('field.sort') }),
    chipRow([['', t('kiosk.catalog.sort_default')], ['rating', t('kiosk.catalog.sort_rating')]], filters.sort, t('field.sort'), (v) => {
      filters = { ...filters, sort: v };
      loadCatalog();
      $('catalogFilters').querySelector('[data-group="sort"] [aria-pressed="true"]')?.focus();
    }));
  g.dataset.group = 'sort';
  return g;
}

async function loadCatalog() {
  const seq = ++catalogSeq;
  renderFilters();
  const band = PRICE_BANDS[filters.price] ?? [null, null];
  const q = new URLSearchParams(Object.entries({ audience: filters.audience, category: filters.category, gender: filters.gender, size: filters.size, min: band[0] ?? '', max: band[1] ?? '', sort: filters.sort })
    .filter(([, v]) => v !== ''));
  $('catalogStatus').textContent = t('kiosk.catalog.loading');
  const done = showAfter(300, () => seq === catalogSeq && $('catalogGrid').replaceChildren(skeletonCard(2), skeletonCard(2), skeletonCard(2)));
  let r;
  try {
    r = await api(`/catalog/${storeId}?${q}`);
  } catch (err) {
    done();
    if (seq !== catalogSeq) return;
    $('catalogStatus').textContent = err.message;
    $('catalogGrid').replaceChildren(el('button', { className: 'primary', textContent: t('common.retry'), onclick: loadCatalog }));
    return;
  }
  done();
  if (seq !== catalogSeq) return;
  $('catalogStatus').textContent = t('kiosk.catalog.found', { n: r.items.length });
  if (r.items.length) return $('catalogGrid').replaceChildren(...r.items.map(tile));
  $('catalogGrid').replaceChildren(el('div', { className: 'empty' }, icon('search'), el('p', { textContent: t('kiosk.catalog.empty') }),
    el('button', { type: 'button', onclick: () => { filters = { ...NO_FILTER }; loadCatalog(); } }, t('kiosk.catalog.reset'))));
}

// A catalogue or "goes well with" tile: photo, name, price and the sizes in stock. Opens the item page.
const tile = (p) => el('button', { type: 'button', className: 'tile', onclick: () => go('item', { data: { item: p.id } }) },
  p.image_url ? el('img', { src: p.image_url, alt: '' }) : el('span', { className: 'ph' }, icon(p.category || 'hanger')),
  el('span', { className: 'name', textContent: productName(p) }), priceEl(p), ratingLine(p.rating) ?? '', // task 46: from 3 visible reviews
  el('span', { className: 'meta', textContent: p.sizes.map(sizeName).join(' ') }));

async function loadItem(id) {
  if (!id) return go('catalog', { replace: true });
  itemId = id;
  remember();
  const seq = ++itemSeq;
  $('itemName').textContent = '';
  $('itemBody').replaceChildren();
  const done = showAfter(300, () => seq === itemSeq && $('itemBody').replaceChildren(skeletonCard(5)));
  let r;
  try {
    r = await api(`/catalog/${storeId}/items/${id}${sizeQuery(request?.gender, request?.sizes)}`); // task 48: the customer's row
  } catch (err) {
    done();
    if (seq !== itemSeq) return;
    $('itemName').textContent = err.status === 404 ? t('kiosk.item.gone') : err.message;
    $('itemBody').replaceChildren(el('div', { className: 'empty' }, icon('hanger'),
      el('button', { type: 'button', className: 'primary', onclick: () => go('catalog') }, t('kiosk.item.to_catalog'))));
    return;
  }
  done();
  if (seq === itemSeq) renderItem(r.item, r.pairs);
}

const description = (p) => (getLang() === 'ru' && p.description_ru) || p.description;
// Every size of the item: the ones in stock add to the cart, a sold-out one shows the organisation's other stores.
function renderItem(p, pairs) {
  syncs = new Set();
  $('itemName').textContent = productName(p);
  const all = p.all_sizes; // task 36: every size it comes in (the shop's own list too)
  chosen.delete(p.id);
  if (all.length === 1) chosen.set(p.id, p.sizes[0]);
  else if (p.size_chart?.my_size) chosen.set(p.id, p.size_chart.my_size); // task 48: their size in this shop, if it is free
  const other = el('div', { className: 'elsewhere' });
  const err = el('p', { className: 'field-error' });
  const chips = chipRow(all.map((x) => [x, sizeName(x)]), chosen.get(p.id), t('kiosk.size.aria', { name: productName(p) }), (x) => {
    err.textContent = '';
    if (p.sizes.includes(x)) {
      chosen.set(p.id, x);
      other.replaceChildren();
    } else {
      chosen.delete(p.id);
      elsewhere(p, x, other);
    }
    syncs.forEach((f) => f());
  });
  [...chips.children].forEach((c, i) => {
    if (p.sizes.includes(all[i])) return;
    c.classList.add('out');
    c.ariaLabel = t('kiosk.item.size_out', { size: sizeName(all[i]) });
  });
  const pick = el('div', { className: 'pick' }, el('div', { className: 'meta', textContent: t('kiosk.size.pick') }), chips, err);
  pick.dataset.pick = p.id;
  const page = $('itemBody');
  page.replaceChildren(
    el('div', { className: 'item-page' },
      p.image_url ? el('img', { className: 'item-photo', src: p.image_url, alt: '' }) : el('div', { className: 'item-photo ph' }, icon(p.category || 'hanger')),
      el('div', { className: 'item-info card' }, priceEl(p), reviewSum(p),
        // Task 35: the lowest monthly amount the store offers for this price (server-made).
        ...(p.instalments ? [el('p', { className: 'meta inst-line', textContent: t('kiosk.inst.item', { sum: som(lowest(p.instalments).monthly), n: lowest(p.instalments).months }) })] : []),
        el('p', { className: 'meta', textContent: [catOf(p), colorName(p.color), p.shelf_location && t('kiosk.shelf', { shelf: p.shelf_location })].filter(Boolean).join(' · ') }),
        ...(description(p) ? [el('p', { textContent: description(p) })] : []),
        // Task 36: the shop's free details ("Mato: 100% paxta"), as text.
        ...(p.details.length ? [el('dl', { className: 'details' }, ...p.details.flatMap((d) => [el('dt', { textContent: d.name }), el('dd', { textContent: d.value })]))] : []),
        chartHint({ chart_from: p.size_chart?.chart_from, chart_size: p.size_chart?.mine }), fitHint(p), reviewFit(p), pick, other,
        addButton([{ ...p, size: null }], page, 'primary wide', 'kiosk.add.btn', null),
        tryon.button(p), // task 41: '' for a child's item, an item without a photo, or when the shop has it off
        ...(scanToken ? [fittingBox([{ ...p, size: null }], page, { scan: scanToken })] : []))), // task 32: in the shop, from a label
    sizeTable(p.size_chart),
    ...(pairs.length ? [el('section', { className: 'pairs' }, el('h2', { textContent: t('kiosk.item.pairs') }), el('div', { className: 'catalog-grid' }, ...pairs.map(tile)))] : []),
    reviewList(p),
  );
}

// Task 48: "O'lchamlar jadvali": the shop's own chart (or the built-in one) in cm, the customer's row marked.
const cm = ([a, b]) => `${fmt.num(a)}–${fmt.num(b)}`;
function sizeTable(c) {
  if (!c) return '';
  const sub = [t(c.own ? 'kiosk.chart.own' : 'kiosk.chart.builtin'), c.gender && t(`gender.${c.gender}`)].filter(Boolean).join(' · ');
  return el('section', { className: 'size-chart' }, el('h2', { textContent: t('kiosk.chart.title') }), el('p', { className: 'meta', textContent: sub }),
    el('div', { className: 'chart-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', { scope: 'col', textContent: t('kiosk.chart.size') }), ...c.measures.map((m) => el('th', { scope: 'col', textContent: t(`common.chart.${m}`) })))),
      el('tbody', {}, ...c.rows.map((r) => {
        const mine = r.size === c.mine;
        const tr = el('tr', { className: mine ? 'mine' : '' }, el('th', { scope: 'row' }, el('span', { textContent: r.size }),
          ...(mine ? [el('span', { className: 'badge', textContent: t('kiosk.chart.mine') })] : [])), ...c.measures.map((m) => el('td', { textContent: cm(r[m]) })));
        if (mine) tr.setAttribute('aria-current', 'true');
        return tr;
      })))));
}

// Task 46: the average and count (only from the server's minimum of visible reviews; below it just the count), the
// buyers' fit summary as a hint line (it never changes a size), and the newest reviews: "Xaridor", never a name.
const FIT_SUM = { small: 'kiosk.review.fit_small', big: 'kiosk.review.fit_big', right: 'kiosk.review.fit_right', mixed: 'kiosk.review.fit_mixed' };
const FIT_SAID = { small: 'kiosk.track.fit_small', right: 'kiosk.track.fit_right', big: 'kiosk.track.fit_big' };
function reviewSum(p) {
  const r = p.rating;
  if (!r?.count) return '';
  return el('p', { className: 'review-sum' }, ratingLine(r) ?? el('span', { className: 'meta', textContent: t('kiosk.review.count', { n: r.count }) }));
}
const reviewFit = (p) => (p.rating?.fit ? el('div', { className: 'fit-hint' }, icon('info'), el('span', { textContent: t(FIT_SUM[p.rating.fit]) })) : '');
function reviewList(p) {
  if (!p.reviews?.length) return '';
  return el('section', { className: 'reviews' }, el('h2', { textContent: t('kiosk.review.list') }), ...p.reviews.map((r) => {
    const box = el('div', { className: 'review-item' },
      el('div', { className: 'review-head' }, el('strong', { textContent: t('kiosk.review.buyer') }), stars(r.rating),
        el('span', { className: 'meta', textContent: [sizeName(r.size), fmt.date(r.created_at)].join(' · ') })));
    if (r.returned) box.querySelector('.review-head').append(el('span', { className: 'badge', textContent: t('kiosk.review.returned') }));
    if (r.fit) box.append(el('p', { className: 'meta', textContent: t('kiosk.review.fit_said', { fit: t(FIT_SAID[r.fit]) }) }));
    if (r.text) box.append(el('p', { className: 'review-text', textContent: r.text }));
    if (r.reply) box.append(el('div', { className: 'review-reply' }, el('strong', { textContent: t('kiosk.review.reply') }), el('p', { className: 'review-text', textContent: r.reply })));
    return box;
  }));
}

// The chosen size has none free here: where else in this organisation it is (logged as missed demand by the server).
async function elsewhere(p, size, box) {
  box.dataset.size = size;
  box.replaceChildren(el('p', { className: 'meta', role: 'status', textContent: t('kiosk.catalog.loading') }));
  let r;
  try {
    r = await api('/catalog/elsewhere', { store_id: storeId, product_id: p.id, size, ...(visit && { session: visit }) });
  } catch (err) {
    return box.replaceChildren(el('p', { className: 'field-error', role: 'alert', textContent: err.message }));
  }
  if (box.dataset.size !== size) return; // another size was picked meanwhile
  const head = el('p', { className: 'notice warn', role: 'status' }, icon('info'), el('span', { textContent: t('kiosk.item.size_out', { size: sizeName(size) }) }));
  const wait = store?.profile ? [alertBox(p, size)] : []; // task 31, only with the Telegram bot
  if (!r.stores.length) return box.replaceChildren(head, el('p', { className: 'meta', textContent: t('kiosk.item.nowhere') }), ...wait);
  box.replaceChildren(head, ...wait, el('h3', { textContent: t('kiosk.item.elsewhere') }), el('ul', { className: 'store-stock' }, ...r.stores.map((s) => {
    const li = el('li', {}, el('div', {}, el('strong', { textContent: s.name }), el('div', { className: 'meta', textContent: [s.city, s.address].filter(Boolean).join(', ') })),
      el('span', { className: 'stock-count', textContent: t('kiosk.item.count', { n: s.count }) }));
    const b = el('button', { type: 'button', className: 'secondary wide' }, icon('store'), t('kiosk.item.reserve'));
    b.onclick = () => reserveForm(p, size, s, li, b);
    li.append(b);
    return li;
  })));
}

// Pickup reservation in another store of the organisation: name and phone, then an unpaid order there (held 3 h).
// Inline, not a dialog, so the kiosk's on-screen keyboard keeps working.
function reserveForm(p, size, s, li, btn) {
  const id = `res-${s.store_id}`;
  const field = (name, label, props, keys) => {
    const input = el('input', { id: `${id}-${name}`, name, ...props });
    input.dataset.keys = keys;
    input.setAttribute('aria-describedby', `${id}-${name}-err`);
    const error = el('span', { className: 'field-error', id: `${id}-${name}-err` });
    return { input, error, label: el('label', { className: 'field', htmlFor: input.id }, el('span', { textContent: t(label) }), input, error) };
  };
  const fields = [field('fullname', 'kiosk.checkout.name', { autocomplete: 'name', maxLength: 80 }, 'letters'),
    field('phone', 'kiosk.checkout.phone', { type: 'tel', inputMode: 'tel', autocomplete: 'tel', placeholder: '+998 90 123 45 67', maxLength: 20 }, 'phone')];
  const msg = el('p', { className: 'field-error', role: 'alert' });
  const send = el('button', { type: 'submit', className: 'primary wide' }, t('kiosk.reserve.go'));
  const f = el('form', { className: 'reserve-form', noValidate: true }, el('p', { className: 'meta', textContent: t('kiosk.reserve.text') }), ...fields.map((x) => x.label), msg, send);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const bad = fields.filter(({ input, error }) => {
      const key = fieldError(input.name, input.value);
      error.textContent = key ? t(key) : '';
      input.setAttribute('aria-invalid', String(!!key));
      return key;
    });
    if (bad.length) return bad[0].input.focus();
    msg.textContent = '';
    send.disabled = true;
    try {
      const r = await api('/catalog/reserve', { from_store_id: storeId, product_id: s.product_id, size, name: fields[0].input.value, phone: fields[1].input.value });
      li.replaceChildren(el('div', { className: 'notice stack', role: 'status' },
        el('strong', { textContent: t('kiosk.reserve.done', { n: r.order.number }) }),
        el('p', { textContent: t('kiosk.reserve.until', { store: r.store.name, address: r.store.address, time: fmt.time(r.order.expires_at) }) }),
        el('div', { className: 'sum' }, sumRow(`${productName(p)} · ${sizeName(size)}`, som(r.order.total))),
        trackBlock(r.track)));
    } catch (err) {
      msg.textContent = err.message;
      send.disabled = false;
    }
  };
  btn.remove();
  li.append(f);
  fields[0].input.focus();
}

// --- Cart and checkout. Every number shown here comes from the server; the browser sends no prices.
const sumRow = (label, value, className = '') => el('div', { className }, el('span', { textContent: label }), el('span', { textContent: value }));
const checkout = $('checkout');

$('cartBtn').onclick = () => (mallLook ? toMallCart() : go('cart'));
$('cartBack').onclick = () => go(request ? 'results' : 'start');
checkout.addEventListener('change', (e) => ['fulfillment', 'payment', 'term'].includes(e.target.name) && renderSum());

async function cartAction(call) {
  $('cartError').textContent = '';
  try {
    setCart(await call());
  } catch (err) {
    if (err.status === 404) setCart(null);
    $('cartError').textContent = err.status === 404 ? t('kiosk.cart.expired') : err.message;
    renderCartScreen();
  }
}

function cartLine(i) {
  const url = `/cart/${cart.token}/items/${i.id}`;
  const name = productName(i);
  return el('li', {},
    thumb(i),
    el('div', { className: 'name', textContent: i.quantity > 1 ? `${name} × ${i.quantity}` : name }),
    el('div', { className: i.discount_price ? 'price sale' : 'price' }, ...(i.discount_price ? [el('s', { textContent: som(i.price * i.quantity) })] : []), som(i.line_total)),
    el('div', { className: 'meta', textContent: [catOf(i), colorName(i.color), i.sizes.length < 2 && sizeName(i.size), i.shelf_location && t('kiosk.shelf', { shelf: i.shelf_location })].filter(Boolean).join(' · ') }),
    ...(i.sizes.length > 1 ? [sizeChips(i.sizes, i.size, t('kiosk.size.aria', { name }), (s) => cartAction(() => api(url, { size: s }, 'PATCH')))] : []),
    el('button', { type: 'button', className: 'ghost danger remove', ariaLabel: t('kiosk.cart.remove_aria', { name }), onclick: () => cartAction(() => api(url, null, 'DELETE')) }, icon('trash'), t('common.delete')),
  );
}

// Live hold countdown (U8): a warning with "extend" in the last 2 minutes; at 0 the cart is gone.
// The deadline comes from the server's hold_ms, so a wrong device clock doesn't shift it.
const WARN_MS = 2 * 60_000;
function holdTick() {
  const left = holdDeadline - Date.now();
  if (!cart || left <= 0) {
    clearInterval(holdTimer);
    if (cart && left <= 0) return cartAction(() => Promise.reject(Object.assign(new Error(''), { status: 404 })));
    return;
  }
  const warn = left <= WARN_MS;
  const note = $('holdNote');
  if (note.classList.contains('warn') !== warn || !note.firstChild) {
    note.classList.toggle('warn', warn);
    note.replaceChildren(icon('clock'), el('span', { className: 'hold-text' }),
      ...(warn ? [el('button', { type: 'button', className: 'primary', onclick: extendHold }, t('kiosk.cart.extend'))] : []));
  }
  note.querySelector('.hold-text').textContent = t(warn ? 'kiosk.cart.hold_warn' : 'kiosk.cart.held', { left: fmt.countdown(left) });
}
function startHold() {
  clearInterval(holdTimer);
  $('holdNote').replaceChildren();
  if (!cart?.items.length || current !== 'cart') return;
  holdDeadline = Date.now() + cart.hold_ms;
  holdTick();
  holdTimer = setInterval(holdTick, 1000);
}
async function extendHold() {
  await cartAction(() => api(`/cart/${cart.token}/extend`, {}));
  if (cart) toast(t('kiosk.cart.extended'));
}

function renderCartScreen() {
  const empty = !cart?.items.length;
  checkout.hidden = $('holdNote').hidden = $('handoffBtn').hidden = empty;
  if (!kiosk || inMall) $('handoffBtn').hidden = true; // task 38: a mall cart moves to the phone as a whole, not built
  startHold();
  if (empty) return $('cartBody').replaceChildren(el('div', { className: 'empty' }, icon('bag'), el('p', { textContent: t('kiosk.cart.empty') })));
  $('cartBody').replaceChildren(el('ul', { className: 'items lines' }, ...cart.items.map(cartLine)));
  renderPromo();
  renderPoints();
  renderSum();
}

// Kiosk → phone (task 17): a one-time QR opens this cart on the customer's phone, where they check out.
// The kiosk watches its cart: once the phone claims it, the kiosk's token stops working and the kiosk starts over.
let handoff = null; // { dlg, timers } while the QR is on screen
function stopHandoff() {
  if (!handoff) return;
  handoff.timers.forEach(clearInterval);
  if (handoff.dlg.open) handoff.dlg.close();
  handoff.dlg.remove();
  handoff = null;
}
$('handoffBtn').onclick = async () => {
  stopHandoff();
  const dlg = el('dialog', { className: 'handoff' });
  dlg.setAttribute('aria-labelledby', 'handoffTitle');
  handoff = { dlg, timers: [] };
  dlg.addEventListener('close', () => handoff?.dlg === dlg && stopHandoff());
  document.body.append(dlg);
  const qr = el('div', { className: 'tgqr' });
  const left = el('p', { className: 'meta', role: 'status' });
  const close = el('button', { type: 'button', onclick: stopHandoff }, t('common.close'));
  dlg.append(el('h2', { id: 'handoffTitle', textContent: t('kiosk.handoff.title') }), el('p', { className: 'muted', textContent: t('kiosk.handoff.text') }), qr, left, el('div', { className: 'dialog-actions' }, close));
  dlg.showModal();
  let h;
  try {
    h = await api(`/cart/${cart.token}/handoff`, {});
  } catch (err) {
    left.textContent = err.message;
    return;
  }
  if (handoff?.dlg !== dlg) return; // closed or reset meanwhile
  qr.innerHTML = h.svg; // built by our server from our own URL
  const until = Date.now() + h.ms, token = cart.token, holdUntil = Date.now() + cart.hold_ms;
  const count = () => {
    const ms = until - Date.now();
    if (ms > 0) return void (left.textContent = t('kiosk.handoff.left', { left: fmt.countdown(ms) }));
    handoff.timers.forEach(clearInterval);
    qr.replaceChildren();
    left.replaceChildren(t('kiosk.handoff.expired'), ' ', el('button', { type: 'button', className: 'primary', onclick: () => $('handoffBtn').click() }, t('kiosk.handoff.new')));
  };
  count();
  handoff.timers.push(setInterval(count, 1000), setInterval(async () => {
    try {
      await api(`/cart/${token}`);
    } catch (err) {
      // 404 while the hold was still live = the phone took the cart (an expired cart is handled by the hold timer).
      if (err.status !== 404 || Date.now() >= holdUntil || handoff?.dlg !== dlg) return;
      handoff.timers.forEach(clearInterval);
      cart = null; // the server cart now belongs to the phone; reset() must not delete it
      dlg.replaceChildren(el('div', { className: 'done' }, icon('check'), el('h2', { textContent: t('kiosk.handoff.done') })));
      setTimeout(reset, 4000);
    }
  }, 2000));
};

// Click/Payme only on the phone (no card entry on a shared kiosk) and only when the server has them configured.
// Task 35: "Muddatli to'lov (kassada)" when the shown totals carry instalment terms (the store offers them and
// something is left to pay); it is a cashier order with a term, and the terms' monthly amounts come from the server.
const PAY = { cashier: 'kiosk.checkout.pay_cashier', instalment: 'kiosk.inst.pay', click: 'Click', payme: 'Payme' }; // brand names stay as they are
const picked = (name) => checkout[name]?.value || '';
// Radios are rebuilt only when their set changes, so picking one keeps the focus on it.
function radios(box, name, opts, fallback) {
  const key = opts.map(([v, label]) => `${v}:${label}`).join('|');
  if (box.dataset.opts === key && picked(name)) return;
  const was = picked(name);
  const on = opts.some(([v]) => String(v) === was) ? was : String(fallback);
  box.dataset.opts = key;
  box.replaceChildren(...opts.map(([v, label, sub]) => el('label', {}, el('input', { type: 'radio', name, value: v, checked: String(v) === on }),
    el('span', {}, label, ...(sub ? [el('small', { textContent: sub })] : [])))));
}
function renderPay(s) {
  const online = kiosk ? [] : cart.payments.filter((m) => m !== 'cashier' && PAY[m]);
  const opts = ['cashier', ...(s.instalments ? ['instalment'] : []), ...online];
  $('payFields').hidden = opts.length < 2;
  $('payNote').textContent = t(online.length ? 'kiosk.checkout.note_online' : 'kiosk.checkout.note_cashier');
  radios($('payChoices'), 'payment', opts.map((m) => [m, t(PAY[m])]), 'cashier');
  const terms = picked('payment') === 'instalment' ? s.instalments : null;
  $('termFields').hidden = !terms;
  if (terms) radios($('termChoices'), 'term', terms.map((x) => [x.months, t('kiosk.inst.term', { n: x.months, sum: som(x.monthly) }), x.percent ? t('kiosk.inst.markup', { pct: x.percent }) : t('kiosk.inst.no_markup')]), terms[0].months);
  return terms ? terms.find((x) => String(x.months) === picked('term')) : null;
}

// Task 26: one promo code per cart. The server checks it and computes every discount; the kiosk shows what comes back.
function renderPromo() {
  const c = cart.discounts.code;
  $('promoAsk').hidden = Boolean(c);
  $('promoOn').hidden = !c;
  if (c) $('promoOnText').textContent = t('kiosk.promo.on', { code: c.code });
  $('promoMsg').textContent = c?.error ? t(c.error, { sum: fmt.num(c.min_order) }) : '';
}
async function applyPromo() {
  const input = $('promoInput'), code = input.value.trim();
  if (!code) {
    $('promoMsg').textContent = t('kiosk.promo.empty');
    return input.focus();
  }
  $('promoApply').disabled = true;
  try {
    setCart(await api(`/cart/${cart.token}/promo`, { code }));
    input.value = '';
    toast(t('kiosk.promo.applied', { code: cart.discounts.code.code }));
  } catch (err) {
    if (err.status === 404) return cartAction(() => Promise.reject(err));
    $('promoMsg').textContent = err.message;
    input.focus();
  } finally {
    $('promoApply').disabled = false;
  }
}
$('promoApply').onclick = applyPromo;
$('promoInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault(); // Enter here applies the code; it must not place the order
  applyPromo();
});
$('promoRemove').onclick = () => cartAction(() => api(`/cart/${cart.token}/promo`, null, 'DELETE'));
// Discount rows in the order the server applies them: bundle, then the promo code, then points (task 34).
const discountRows = (bundle, promo, code, points = 0) => [
  ...(bundle ? [sumRow(t('common.bundle_off'), `−${som(bundle)}`, 'off')] : []),
  ...(promo ? [sumRow(t('common.promo_off', { code }), `−${som(promo)}`, 'off')] : []),
  ...(points ? [sumRow(t('common.points_off'), `−${som(points)}`, 'off')] : []),
];

// Task 34: cashback points. The customer confirms "use my points" in their own Telegram (the same one-time login as
// the kiosk's, with this cart's token); the server links the profile to the cart and computes how much may be used
// (cart.points.max) and the totals with it. The screen only chooses whether to use that amount.
const pointsUsed = () => (usePoints && cart?.points?.linked ? cart.points.max : 0);
function renderPoints() {
  const p = cart.points, box = $('pointsBox');
  box.hidden = !p || (!p.linked && !store?.profile); // linking needs the Telegram bot
  if (box.hidden || box.dataset.waiting) return; // keep the QR / link on screen while the customer is in Telegram
  if (!p.linked) {
    return box.replaceChildren(el('p', { className: 'muted', textContent: t('kiosk.points.ask', { pct: p.share }) }),
      el('button', { type: 'button', className: 'secondary wide', onclick: linkPoints }, icon('sparkle'), el('span', { textContent: t('kiosk.points.use') })));
  }
  const toggle = el('input', { type: 'checkbox', checked: usePoints && p.max > 0, disabled: !p.max, onchange: (e) => { usePoints = e.target.checked; renderSum(); } });
  box.replaceChildren(
    el('label', { className: 'check' }, toggle, el('span', { textContent: p.max ? t('kiosk.points.pay', { sum: som(p.max) }) : t('kiosk.points.none') })),
    el('p', { className: 'meta', textContent: t('kiosk.points.balance', { sum: som(p.balance), pct: p.share }) }),
    el('button', { type: 'button', className: 'ghost', onclick: () => cartAction(() => api(`/cart/${cart.token}/points`, null, 'DELETE')) }, t('kiosk.points.unlink')));
}
async function linkPoints(e) {
  const box = $('pointsBox');
  e.currentTarget.disabled = true;
  let r;
  try {
    r = await api('/profile/login', { store_id: storeId, lang: getLang(), cart: cart.token });
  } catch (err) {
    renderPoints();
    return toast(err.message, { tone: 'danger' });
  }
  const qr = el('div', { className: 'tgqr' });
  qr.innerHTML = r.svg; // built by our server from the bot's t.me link
  const goTo = kiosk ? [el('p', { textContent: t('kiosk.profile.scan') }), qr]
    : /^https:\/\/t\.me\//.test(r.url) ? [el('a', { className: 'button primary wide', href: r.url, target: '_blank', rel: 'noopener' }, t('kiosk.profile.open_tg'))] : [];
  box.dataset.waiting = '1';
  box.replaceChildren(el('p', { className: 'meta', textContent: t('kiosk.points.confirm') }), ...goTo, el('p', { className: 'meta', role: 'status', textContent: t('kiosk.profile.waiting') }));
  pollProfile(r.poll, async (s) => {
    if (!box.isConnected || !cart) return stopProfilePoll();
    if (['new', 'opened'].includes(s.state)) return; // still in Telegram
    delete box.dataset.waiting;
    if (s.state === 'done') {
      usePoints = true;
      return cartAction(() => api(`/cart/${cart.token}`));
    }
    renderPoints();
    box.append(el('p', { className: 'field-error', role: 'alert', textContent: t(s.state === 'missing' ? 'kiosk.profile.login_missing' : 'kiosk.profile.expired') }));
  });
}

function renderSum() {
  const delivery = checkout.fulfillment.value === 'delivery';
  const used = pointsUsed(), d = cart.delivery, dc = cart.discounts;
  const s = (used ? cart.points.totals : cart.totals)[delivery ? 'delivery' : 'pickup'];
  $('deliveryFields').hidden = !delivery;
  const term = renderPay(s), longest = s.instalments && lowest(s.instalments);
  $('cartSum').replaceChildren(
    sumRow(t('kiosk.checkout.items'), som(s.subtotal)),
    ...discountRows(dc.bundle, dc.promo, dc.code?.code, used),
    ...(delivery ? [sumRow(t('kiosk.checkout.delivery_in', { city: d.city }), s.delivery_fee ? som(s.delivery_fee) : t('common.free'))] : []),
    sumRow(t('common.total'), som(s.total), 'grand'),
    // Task 35: the chosen term, else the lowest monthly amount on offer.
    ...((term || longest) ? [el('p', { className: 'meta inst-line', textContent: t('kiosk.inst.item', { sum: som((term || longest).monthly), n: (term || longest).months }) })] : []),
    ...(delivery && s.delivery_fee && d.free_over !== null ? [el('p', { className: 'meta', style: 'margin:.35rem 0 0', textContent: t('kiosk.checkout.free_over', { sum: som(d.free_over) }) })] : []),
  );
  if (delivery) loadMap();
}

// Map pin for delivery: Leaflet + OpenStreetMap tiles, loaded only when delivery is picked. Without it the address alone is enough.
const LEAFLET = '/vendor/leaflet@1.9.4/'; // self-hosted (src/vendor.js); tiles still come from OpenStreetMap
let leaflet = null, map = null, marker = null, pin = null;
function loadMap() {
  leaflet ??= new Promise((ok, no) => {
    document.head.append(el('link', { rel: 'stylesheet', href: LEAFLET + 'leaflet.css' }));
    document.head.append(el('script', { src: LEAFLET + 'leaflet.js', onload: ok, onerror: no }));
  });
  leaflet.then(() => {
    if (map) return map.invalidateSize();
    map = L.map('map').setView([cart.delivery.lat, cart.delivery.lon], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    map.on('click', (e) => {
      pin = e.latlng;
      marker ? marker.setLatLng(pin) : (marker = L.marker(pin).addTo(map));
    });
  }, () => {
    $('map').hidden = true;
    $('mapHint').textContent = t('kiosk.checkout.map_failed');
  });
}
function clearCheckout() {
  checkout.reset(); // a kiosk must not show the last customer's name and phone
  pin = null;
  marker?.remove();
  marker = null;
  $('cartError').textContent = $('checkoutError').textContent = '';
  for (const n of CHECKOUT_FIELDS) showError(n, '');
}
const CHECKOUT_FIELDS = ['fullname', 'phone', 'address'];
inline(checkout, CHECKOUT_FIELDS);

checkout.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = checkout, delivery = f.fulfillment.value === 'delivery';
  $('checkoutError').textContent = '';
  if (!delivery) showError('address', '');
  if (!checkAll(f, delivery ? CHECKOUT_FIELDS : ['fullname', 'phone'])) return;
  $('placeOrder').disabled = true;
  try {
    const r = await api(`/cart/${cart.token}/checkout`, {
      fulfillment: f.fulfillment.value, name: f.fullname.value, phone: f.phone.value, points: pointsUsed(),
      ...(picked('payment') === 'instalment' ? { payment: 'cashier', instalment: Number(picked('term')) } : { payment: picked('payment') || 'cashier' }),
      ...(delivery && { address: f.address.value, ...(pin && { lat: pin.lat, lon: pin.lng }) }),
    });
    setCart(null);
    clearCheckout();
    showDone(r.order, r.payment, r.notify, r.track);
  } catch (err) {
    if (err.status === 404) return cartAction(() => Promise.reject(err));
    if (/^points_|^instalment_/.test(err.code)) await cartAction(() => api(`/cart/${cart.token}`)); // the balance or cap changed: show the new numbers
    $('checkoutError').textContent = err.message;
  } finally {
    $('placeOrder').disabled = false;
  }
});

function showDone(o, pay = { method: 'cashier' }, notify = null, track = null) {
  const online = pay.url && /^https:\/\//.test(pay.url);
  lastOrder = o;
  $('orderNo').textContent = `№ ${o.number}`;
  $('doneBody').replaceChildren(
    el('div', { className: 'sum card' },
      ...o.items.map((i) => sumRow(`${productName(i)} · ${sizeName(i.size)}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`, som(i.unit_price * i.quantity))),
      ...discountRows(o.bundle_discount, o.promo_discount, o.promo_code, o.points_discount),
      ...(o.fulfillment === 'delivery' ? [sumRow(t('kiosk.done.delivery'), o.delivery_fee ? som(o.delivery_fee) : t('common.free'))] : []),
      sumRow(t('common.total'), som(o.total), 'grand'),
      ...(o.instalment_months ? [el('p', { className: 'meta', textContent: t('kiosk.inst.item', { sum: som(o.instalment_monthly), n: o.instalment_months }) })] : [])),
    el('p', { className: 'notice', textContent: t('kiosk.done.pay_note', { what: online ? t('kiosk.done.pay_online', { method: t(PAY[pay.method]) }) : t(o.instalment_months ? 'kiosk.done.pay_instalment' : 'kiosk.done.pay_cashier'), time: fmt.time(o.expires_at) }) }),
    ...(online ? [el('a', { className: 'button primary wide', href: pay.url, rel: 'noopener', textContent: t('kiosk.done.pay_btn', { method: t(PAY[pay.method]) }) })] : []),
    el('p', { textContent: o.fulfillment === 'pickup' ? t('kiosk.done.next_pickup') : t('kiosk.done.next_delivery', { phone: o.phone }) }),
    ...(track ? [trackBlock(track)] : []),
    ...(notify && !kiosk ? [telegramBlock(notify)] : []), // the kiosk's status-page QR has the Telegram button
    ...(store?.profile ? [profileBox()] : []), // at checkout: kiosk shows a QR, the phone a button
  );
  go('done', { replace: true }); // back from here goes to the outfits, not to a spent checkout
}
// Order status by Telegram (phone only): the bot link.
function telegramBlock(n) {
  if (!/^https:\/\/t\.me\//.test(n.url)) return el('div');
  return el('a', { className: 'button wide', href: n.url, rel: 'noopener', textContent: t('kiosk.done.tg_track') });
}
// The public status page (U7): a link on the phone, a QR on the kiosk. The SVG is built by our server from our own URL.
function trackBlock(tr) {
  const path = new URL(tr.url, location.href).pathname;
  if (!kiosk) return el('a', { className: 'button primary wide', href: path, textContent: t('kiosk.track.link') });
  const qr = el('div', { className: 'tgqr' });
  qr.innerHTML = tr.svg;
  return el('div', { className: 'notice stack' }, el('p', { textContent: t('kiosk.track.scan') }), qr);
}
$('doneHome').onclick = () => reset();

// --- Task 27: profile through Telegram. "Profilimni saqlash" opens the bot with a one-time link (a QR on the kiosk);
// the bot asks for the contact. The screen only learns "saved": the profile page link goes to the bot chat alone.
let profilePoll = null; // the one link a screen is waiting on
const stopProfilePoll = () => {
  clearInterval(profilePoll);
  profilePoll = null;
};
function pollProfile(poll, onState) {
  stopProfilePoll();
  const id = profilePoll = setInterval(async () => {
    let s;
    try {
      s = await api(`/profile/token/${poll}`);
    } catch (err) {
      if (err.status !== 404) return; // offline for a moment: ask again
      s = { state: 'expired' };
    }
    if (profilePoll !== id) return; // stopped meanwhile
    if (!['new', 'opened'].includes(s.state)) stopProfilePoll();
    onState(s);
  }, 3000);
}
// Numbers only (form, chosen sizes, the photo's cm estimates); never the photo, name or phone.
function profileNumbers() {
  const m = sizeInfo?.measurements, u = sizeInput?.usual, tp = sizeInput?.tape;
  return { ...body, ...(request && { top: request.sizes.top, bottom: request.sizes.bottom, shoes: request.sizes.shoes, fit: request.fit }),
    ...(m && { shoulder: m.shoulder_cm, hip: m.hip_cm }), ...(u && { jeans: u.waist }), ...(tp && { chest: tp.chest, waist: tp.waist, hips: tp.hip }) };
}
// The same bot hand-off for "Profilimni saqlash" (task 27) and "Kelganda xabar bering" (task 31): path + body make the
// one-time link, `saved` is what the box says once the customer finished in Telegram.
function profileBox(looks = null) {
  return tgBox({ className: 'card profile-box', hint: 'kiosk.profile.save_hint', label: 'kiosk.profile.save', ic: 'user', saved: 'kiosk.profile.saved',
    path: '/profile/link', body: () => ({ store_id: storeId, lang: getLang(), ...profileNumbers(), ...(looks && { rec: request?.rec, looks }) }) });
}
const alertBox = (p, size) => tgBox({ className: 'alert-box', hint: 'kiosk.alert.hint', label: 'kiosk.alert.btn', ic: 'clock', saved: 'kiosk.alert.saved',
  path: '/profile/alert', body: () => ({ store_id: storeId, product_id: p.id, size, lang: getLang() }) });
function tgBox({ className, hint, label, ic, saved, path, body }) {
  const box = el('div', { className });
  const intro = () => box.replaceChildren(el('p', { className: 'muted', textContent: t(hint) }),
    el('button', { type: 'button', className: 'secondary wide', onclick: open }, icon(ic), el('span', { textContent: t(label) })));
  async function open(e) {
    e.currentTarget.disabled = true;
    let r;
    try {
      r = await api(path, body());
    } catch (err) {
      intro();
      return toast(err.message, { tone: 'danger' });
    }
    const qr = el('div', { className: 'tgqr' });
    qr.innerHTML = r.svg; // built by our server from the bot's t.me link
    const goTo = kiosk ? [el('p', { textContent: t('kiosk.profile.scan') }), qr]
      : /^https:\/\/t\.me\//.test(r.url) ? [el('a', { className: 'button primary wide', href: r.url, target: '_blank', rel: 'noopener' }, t('kiosk.profile.open_tg'))] : [];
    box.replaceChildren(el('p', { className: 'meta', textContent: t('kiosk.profile.consent') }), ...goTo, el('p', { className: 'meta', role: 'status', textContent: t('kiosk.profile.waiting') }));
    pollProfile(r.poll, (s) => {
      if (!box.isConnected) return stopProfilePoll();
      if (s.state === 'done') box.replaceChildren(el('div', { className: 'notice' }, icon('check'), el('p', { textContent: t(saved) })));
      else if (s.state === 'expired') box.replaceChildren(el('p', { className: 'meta', textContent: t('kiosk.profile.expired') }), el('button', { type: 'button', className: 'secondary', onclick: open }, t('kiosk.profile.again')));
    });
  }
  intro();
  return box;
}

// Kiosk: "Profil bilan kirish" → one-time QR → the customer's Telegram confirms → the sizes arrive once.
let loginDlg = null;
function stopLogin() {
  stopProfilePoll();
  const dlg = loginDlg;
  loginDlg = null;
  if (dlg?.open) dlg.close();
  dlg?.remove();
}
$('profileLogin').onclick = async () => {
  stopLogin();
  const dlg = loginDlg = el('dialog', { className: 'handoff' });
  dlg.setAttribute('aria-labelledby', 'loginTitle');
  dlg.addEventListener('close', () => loginDlg === dlg && stopLogin());
  const qr = el('div', { className: 'tgqr' }), status = el('p', { className: 'meta', role: 'status' });
  dlg.append(el('h2', { id: 'loginTitle', textContent: t('kiosk.profile.login') }), el('p', { className: 'muted', textContent: t('kiosk.profile.login_text') }),
    qr, status, el('div', { className: 'dialog-actions' }, el('button', { type: 'button', onclick: stopLogin }, t('common.close'))));
  document.body.append(dlg);
  dlg.showModal();
  let r;
  try {
    r = await api('/profile/login', { store_id: storeId, lang: getLang() });
  } catch (err) {
    status.textContent = err.message;
    return;
  }
  if (loginDlg !== dlg) return; // closed or reset meanwhile
  qr.innerHTML = r.svg;
  pollProfile(r.poll, (s) => {
    if (loginDlg !== dlg) return;
    if (s.state === 'done') {
      stopLogin();
      applyProfile(s.profile);
    } else if (s.state === 'missing' || s.state === 'expired') {
      qr.replaceChildren();
      status.replaceChildren(t(s.state === 'missing' ? 'kiosk.profile.login_missing' : 'kiosk.profile.expired'), ' ',
        el('button', { type: 'button', className: 'primary', onclick: () => $('profileLogin').click() }, t('kiosk.profile.again')));
    }
  });
};
// Fill the form from the profile; with both clothing sizes known the camera step is skipped.
function applyProfile(p) {
  if (p.lang !== getLang()) {
    setLang(p.lang);
    switcher.sync();
  }
  form.reset();
  shoeChips();
  renderWantChips(null);
  budgetChips();
  form.gender.value = p.gender ?? '';
  form.height.value = p.height ?? '';
  form.weight.value = p.weight ?? '';
  form.shoes.value = p.shoes ?? '';
  toast(t('kiosk.profile.loaded'));
  const r = toRequest(formValues(), storeId);
  if (!r) return go('form');
  ({ body, request } = r);
  sizeInfo = sizeInput = lastResult = null;
  request.fit = p.fit ?? null;
  if (!p.top || !p.bottom) return go('form');
  Object.assign(request.sizes, { top: p.top, bottom: p.bottom });
  request.method = 'profile';
  sizeInfo = { manual: true };
  go('results');
}

// Task 37: back to the mall screen. Task 38: this shop's cart stays in the mall cart, so leaving asks nothing; the kiosk
// idle reset gives every shop's held stock back and the next customer starts at the mall screen in Uzbek.
$('mallBtn').hidden = !inMall || mallHome;
document.documentElement.classList.toggle('in-mall', inMall && !mallHome);
$('mallBtn').onclick = () => leaveShop(false);
$('mallGo').onclick = toMallCart;
async function leaveShop(idle) {
  clearRoute();
  if (idle) {
    const token = mallCart?.token ?? savedCart();
    mallCart = null;
    setCart(null);
    setLang('uz');
    if (token) await api(`/mall-cart/${token}`, null, 'DELETE').catch(() => {});
  }
  location.replace(`${location.pathname}?mall=${mallId}${idle && kiosk ? '&idle=1' : ''}`); // task 43: the idle slides start there
}

// Back to start keeps the cart; only the kiosk idle reset clears it for the next customer.
// Icon button, so it is not mistaken for the cart (U15); with items in the cart it asks first.
$('home').onclick = async () => {
  if (cart?.items.length && !(await confirmDialog({ title: t('kiosk.leave.title'), text: t('kiosk.leave.text'), ok: t('kiosk.leave.ok'), cancel: t('kiosk.leave.stay') }))) return;
  go('start');
  loadStore();
};

function reset() {
  tryon.clear(); // the photo and the picture go before anything else
  if (mallHome) { // the mall screen: clear the search, back to Uzbek (no reload: the idle timer fires on an untouched screen too)
    setLang('uz');
    switcher.sync();
    return mall.reset();
  }
  if (inMall) return leaveShop(true); // a mall kiosk's next customer starts at the mall screen
  stopHandoff();
  stopLogin();
  $('doneBody').replaceChildren(); // its profile QR must not wait for the next customer
  if (cart) api(`/cart/${cart.token}`, null, 'DELETE').catch(() => {}); // give the held stock back now, not in 15 min
  setCart(null);
  request = body = sizeInfo = sizeInput = lastResult = lastOrder = visit = null;
  loadSeq++; // a results request still in flight must not draw for the next customer
  if (kiosk) {
    setLang('uz'); // the next customer starts in Uzbek
    switcher.sync();
  }
  form.reset();
  shoeChips(); // task 40: the last customer may have been a child
  renderWantChips(null);
  wayForm.reset();
  wayError('');
  showWay('photo');
  budgetChips();
  clearCheckout();
  for (const n of FORM_FIELDS) showError(n, '');
  $('results').replaceChildren();
  $('itemBody').replaceChildren(); // the reserve form may hold the last customer's name and phone
  filters = { ...NO_FILTER };
  itemId = null;
  clearRoute();
  go('start', { replace: true });
  loadStore();
}
if (kiosk) {
  watchIdle(document, { onIdle: () => { reset(); attract(true); } });
  kioskShell({ storeId, mallId: inMall ? mallId : 0, api, onRefused: (msg) => { refused = msg; loadStore(); } });
  attract(true);
}

const mall = mallHome ? mallScreen({ mallId, api, kiosk, saved: savedCart }) : null;
if (mallHome) {
  clearRoute(); // a shop's saved screen must not open in the next shop picked here
  mall.show();
  // Task 43: a mall kiosk's idle screen rotates the mall's approved offers. After an idle reset in a shop the page
  // comes back here with &idle=1 (the customer's cart was deleted first) and the slides start at once.
  if (kiosk) {
    const slides = idleSlides({ mallId, api });
    if (params.get('idle') === '1') slides.start();
  }
  if (params.has('idle')) history.replaceState(null, '', `${location.pathname}?mall=${mallId}`);
}
else startShop();

function startShop() {
  // Refresh: restore the saved screen and the form's numbers (never a photo, name or phone), then ask the server again.
  const saved = loadRoute();
  if (saved) {
    form.audience.value = saved.form.audience; // task 40: first, so the children's shoe chips exist for the saved size
    shoeChips();
    for (const [k, v] of Object.entries(saved.form)) {
      if (k === 'want') continue;
      const f = form.elements[k];
      if (f instanceof RadioNodeList) for (const r of f) r.checked = r.value === v;
      else f.value = v;
    }
    setCategories(saved.roles);
    restoredWant = saved.form.want;
    for (const b of wantBoxes()) b.checked = !restoredWant;
    applyNeeds();
    const r = toReq(saved.form);
    if (r) {
      ({ body, request } = r);
      if (request.want && saved.own.length) request.own = saved.own;
      if (sizesReady(saved.sizes, request.want)) {
        const n = sizeNeeds(request.want);
        for (const k of ['top', 'bottom']) if (n[k]) request.sizes[k] = saved.sizes[k];
        Object.assign(request, { method: saved.method, fit: saved.fit });
        sizeInfo = { manual: saved.manual };
      }
    }
  }
  budgetChips();
  // ?item=<id> (task 31: the bot's "back in stock" link; task 32: a garment's QR label, with &scan=) opens that item page.
  const linkItem = Number(params.get('item'));
  if (!kiosk && /^[a-f0-9]{32}$/.test(params.get('scan') ?? '')) scanToken = params.get('scan');
  params.delete('scan');
  if (storeId > 0 && Number.isInteger(linkItem) && linkItem > 0) {
    go('item', { replace: true, data: { item: linkItem } });
    params.delete('item'); // once: a later refresh restores the saved route instead
    history.replaceState(history.state, '', `${location.pathname}?${params}`);
  } else go(storeId > 0 || mallLook ? allowedScreen(saved?.screen ?? 'start', { ...appState(), itemOk: !!saved?.item }) : 'start', { replace: true, data: { item: saved?.item } });
  loadStore();
  const handoffToken = params.get('handoff');
  if (!kiosk && handoffToken) {
    // Opened from the kiosk's QR: take over that cart once, then drop the one-time token from the address bar.
    params.delete('handoff');
    history.replaceState(history.state, '', `${location.pathname}?${params}`);
    const own = savedCart();
    api('/cart/claim', { handoff: handoffToken }).then((c) => {
      if (own) api(`/cart/${own}`, null, 'DELETE').catch(() => {}); // the phone's own earlier cart gives its stock back
      setCart(c);
      toast(t('kiosk.handoff.claimed'));
      go('cart');
    }, (err) => {
      $('startError').textContent = err.message;
      if (savedCart()) api('/cart/' + savedCart()).then((c) => setCart(c.store_id === storeId ? c : null), () => setCart(null));
    });
  } else if (inMall) {
    // Task 38: ?open=cart (the mall cart's "Do'konda o'zgartirish") opens this shop's part of the cart once.
    if (params.get('open') === 'cart') {
      params.delete('open');
      history.replaceState(history.state, '', `${location.pathname}?${params}`);
      go('cart', { replace: true });
    }
    if (savedCart()) api('/mall-cart/' + savedCart()).then(setMall, () => setMall(null));
  } else if (savedCart()) api('/cart/' + savedCart()).then((c) => setCart(c.store_id === storeId ? c : null), () => setCart(null));
}
