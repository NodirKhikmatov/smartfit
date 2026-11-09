import { watchIdle } from './idle.js';
import { loadPose, measure } from './pose.js';
import { icon, confirmDialog, showAfter, skeletonCard } from '/shared/ui.js';
import { t, fmt, initLang, setLang, getLang, langSwitch, productName, colorName } from '/shared/i18n.js';

// One app: /kiosk (big buttons, idle reset) and /m (phone, opened from the store QR).
const kiosk = location.pathname.startsWith('/kiosk');
document.documentElement.classList.add(kiosk ? 'kiosk' : 'mobile');
const storeId = Number(new URLSearchParams(location.search).get('store'));

const CLOTHES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const SHOES = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'];

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const som = (n) => fmt.som(n);
const cat = (c) => t(`cat.${c}`);
const form = $('form');

// Server cart (task 8): each item holds its stock for 15 min. The phone keeps the token across reloads; the kiosk never stores it.
const CART_KEY = 'sfCart'; // the only thing the app stores in the browser: the phone's cart token
let cart = null;
let syncs = new Set(); // add-to-cart buttons on the results screen
const savedCart = (t) => {
  if (kiosk) return null;
  try {
    if (t === undefined) return sessionStorage.getItem(CART_KEY);
    t ? sessionStorage.setItem(CART_KEY, t) : sessionStorage.removeItem(CART_KEY);
  } catch {}
  return null;
};
let current = 'start';
let request = null; // POST /api/recommend body
let body = null; // { gender, height, weight } for POST /api/size
let sizeInfo = null; // last /api/size answer: confidence for the results screen
let store = null;

form.shoes.append(...SHOES.map((s) => el('option', { value: s, textContent: s })));
initLang();
// Language switch on the start screen. Whatever is already drawn (weather, cart button, results) is redrawn in place.
const switcher = langSwitch(() => {
  for (const id of ['formError', 'cartError', 'checkoutError']) $(id).textContent = '';
  store ? renderWeather() : loadStore(); // loadStore redraws a start error (no store, offline) in the new language
  setCart(cart);
  if (lastResult) renderResults(lastResult);
});
$('langBox').replaceChildren(switcher);

function show(name) {
  if (name !== 'camera') stopCamera();
  current = name;
  for (const s of document.querySelectorAll('[data-screen]')) s.hidden = s.dataset.screen !== name;
  $('home').hidden = name === 'start';
  window.scrollTo(0, 0);
  document.querySelector(`[data-screen="${name}"] h1`).focus({ preventScroll: true });
}

function setCart(c) {
  cart = c;
  savedCart(c?.token ?? null);
  const n = c ? c.items.reduce((s, i) => s + i.quantity, 0) : 0;
  $('cartBtn').hidden = !n;
  $('cartBtn').replaceChildren(icon('bag'), el('span', { className: 'cart-label', textContent: t('kiosk.cart') }), el('span', { className: 'count-pill', textContent: n }));
  syncs.forEach((f) => f());
  if (current === 'cart') renderCartScreen();
}

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
  if (!res.ok) throw Object.assign(new Error(data.error || t('common.error')), { status: res.status, code: data.code });
  return data;
}

async function loadStore() {
  $('startError').textContent = '';
  $('start').disabled = true;
  if (!Number.isInteger(storeId) || storeId < 1) {
    $('weather').hidden = $('start').hidden = true;
    $('startError').textContent = t('kiosk.start.no_store');
    return;
  }
  try {
    store = await api('/stores/' + storeId);
  } catch (err) {
    $('weather').hidden = true;
    $('startError').textContent = t(err.status === 404 ? 'kiosk.start.store_404' : 'kiosk.start.offline');
    $('start').hidden = err.status === 404; // a wrong store link won't fix itself
    $('start').disabled = false;
    $('start').textContent = t('common.retry');
    return;
  }
  $('storeName').textContent = store.name;
  $('start').textContent = t('kiosk.start.go');
  $('start').disabled = false;
  renderWeather();
}

function renderWeather() {
  const w = store.weather;
  $('weather').hidden = false;
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

$('start').onclick = () => (store ? show('form') : loadStore());

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = form;
  const n = (v) => (v.trim() === '' ? null : Number(v));
  const height = n(f.height.value), weight = n(f.weight.value), budget = n(f.budget.value);
  const check = [
    [!f.gender.value, f.querySelector('[name=gender]'), 'kiosk.form.err_gender'],
    [!Number.isInteger(height) || height < 100 || height > 230, f.height, 'kiosk.form.err_height'],
    [weight !== null && (!Number.isInteger(weight) || weight < 30 || weight > 250), f.weight, 'kiosk.form.err_weight'],
    [budget !== null && (!Number.isInteger(budget) || budget < 1 || budget > 1e9), f.budget, 'kiosk.form.err_budget'],
  ].find(([bad]) => bad);
  $('formError').textContent = check ? t(check[2]) : '';
  if (check) return check[1].focus();
  body = { gender: f.gender.value, height, weight };
  request = { store_id: storeId, gender: f.gender.value, sizes: { top: null, bottom: null, shoes: f.shoes.value || null }, budget };
  showCamera();
});

$('cameraBack').onclick = () => show('form');
$('changeSizes').onclick = () => show('form');

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
  for (const id of ['shoot', 'galleryBtn', 'noPhoto']) $(id).disabled = on;
}

function showCamera() {
  status('');
  $('shoot').textContent = t('kiosk.camera.shoot');
  $('galleryBtn').hidden = kiosk;
  show('camera');
  loadPose().catch(() => {}); // start the model download while the customer gets ready
}

function stopCamera() {
  attempt += 1;
  clearInterval(timer);
  timer = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  $('preview').hidden = true;
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
  $('preview').hidden = false;
  await video.play().catch(() => {});
  let left = COUNTDOWN;
  $('count').textContent = left;
  timer = setInterval(() => {
    left -= 1;
    $('count').textContent = left || '';
    if (left > 0) return;
    clearInterval(timer);
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

$('noPhoto').onclick = () => findSizes(null);

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
    $('shoot').textContent = t('common.retry');
    return status(t('kiosk.camera.no_body'));
  }
  await findSizes(pose, snapshot(source, w, h));
}

// The stylist (task 7) gets one small JPEG: in memory only, sent with /api/recommend, dropped on reset.
function snapshot(source, w, h) {
  const k = Math.min(1, 512 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  const jpeg = c.toDataURL('image/jpeg', 0.7);
  c.width = c.height = 0;
  return jpeg;
}

async function findSizes(pose, photo = null) {
  setBusy(true);
  try {
    sizeInfo = await api('/size', { ...body, pose });
  } catch (err) {
    setBusy(false);
    $('shoot').textContent = t('common.retry');
    return status(err.message);
  }
  setBusy(false);
  if (cameraScreen.hidden) return;
  Object.assign(request.sizes, sizeInfo.sizes);
  request.photo = photo ?? undefined; // undefined is left out of the JSON
  loadResults();
}

// --- Screen 4: results, with - / + to correct the estimated size.
const CONFIDENCE = { high: 'kiosk.conf.high', medium: 'kiosk.conf.medium', low: 'kiosk.conf.low' };

function renderSizes() {
  const stepper = (key) => {
    const label = cat(key);
    const i = CLOTHES.indexOf(request.sizes[key]);
    const move = (d) => () => {
      request.sizes[key] = CLOTHES[i + d];
      sizeInfo.manual = true;
      loadResults();
    };
    return el('div', { className: 'stepper' }, el('span', { textContent: label }),
      el('button', { type: 'button', ariaLabel: t('kiosk.size.smaller', { label }), disabled: i <= 0, onclick: move(-1) }, icon('minus')),
      el('strong', { textContent: request.sizes[key] }),
      el('button', { type: 'button', ariaLabel: t('kiosk.size.bigger', { label }), disabled: i >= CLOTHES.length - 1, onclick: move(1) }, icon('plus')));
  };
  $('sizeBar').replaceChildren(
    el('div', { className: 'row' }, stepper('top'), stepper('bottom')),
    el('p', { className: 'meta', style: 'margin:var(--s-2) 0 0', textContent: sizeInfo.manual ? t('kiosk.size.manual') : t('kiosk.size.adjust', { conf: t(CONFIDENCE[sizeInfo.confidence]) }) }),
  );
}

let loadSeq = 0; // only the newest /recommend answer may draw (fast − / + taps)
let lastResult = null; // kept so a language switch can redraw without asking again
async function loadResults() {
  const seq = ++loadSeq;
  lastResult = null;
  syncs = new Set();
  show('results');
  renderSizes();
  $('resultsWeather').textContent = '';
  // Screen readers get one summary line per load (U13), not the whole list again after every − / +.
  $('resultsStatus').textContent = t('kiosk.results.loading');
  $('results').replaceChildren();
  const done = showAfter(300, () => seq === loadSeq && $('results').replaceChildren(skeletonCard(4), skeletonCard(4)));
  let r;
  try {
    r = await api('/recommend', request);
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
  $('resultsStatus').textContent = r.outfits.length ? t('kiosk.results.found', { n: r.outfits.length }) : t('kiosk.results.none');
  $('resultsWeather').textContent = [t('kiosk.results.weather', { weather: weatherLine(r.weather) }), r.budget && t('kiosk.results.budget', { sum: som(r.budget) })].filter(Boolean).join(' · ');
  if (!r.outfits.length) {
    $('results').replaceChildren(el('div', { className: 'notice warn', textContent: t('kiosk.results.empty') }));
    return;
  }
  $('results').replaceChildren(
    ...(r.style_guess ? [el('p', { className: 'muted', textContent: t('kiosk.results.style', { style: r.style_guess }) })] : []),
    ...(r.notice === 'no_outerwear' ? [el('div', { className: 'notice warn', textContent: t('kiosk.results.no_outerwear') })] : []),
    ...(r.relaxed ? [el('p', { className: 'muted', textContent: t('kiosk.results.relaxed', { n: r.relaxed }) })] : []),
    ...(r.over_budget > 0 ? [el('div', { className: 'notice warn', textContent: t('kiosk.results.over_budget', { sum: som(r.over_budget) }) })] : []),
    ...(r.partial ? [partialCard(r.partial)] : []),
    ...r.outfits.map((o, i) => outfitCard(o, i + 1)),
    triedCard(),
  );
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
const thumb = (p) => (p.image_url ? el('img', { className: 'thumb', src: p.image_url, alt: '' }) : el('div', { className: 'thumb' }, icon(p.category)));

function itemRow(p) {
  // Unknown shoe size: the customer picks one of the in-stock sizes before adding (stored on the item as `chosen`).
  const pick = !p.size && p.sizes
    ? el('div', { className: 'line-actions' }, el('select', { ariaLabel: t('kiosk.size.aria', { name: productName(p) }), onchange: (e) => { p.chosen = e.target.value; syncs.forEach((f) => f()); } },
      el('option', { value: '', textContent: t('kiosk.size.pick') }), ...p.sizes.map((s) => el('option', { value: s, textContent: s, selected: s === p.chosen }))))
    : '';
  const size = p.size ? (p.size === 'ONE' ? t('common.size_one') : t('kiosk.size.value', { size: p.size })) : '';
  return el('li', {},
    thumb(p),
    el('div', {}, el('div', { textContent: productName(p) }), el('div', { className: 'meta', textContent: [cat(p.category), colorName(p.color), size, p.shelf_location && t('kiosk.shelf', { shelf: p.shelf_location })].filter(Boolean).join(' · ') }), pick),
    el('div', { className: p.discount_price ? 'price sale' : 'price' }, ...(p.discount_price ? [el('s', { textContent: som(p.price) })] : []), som(p.unit_price)),
  );
}

function addButton(items) {
  const size = (p) => p.size ?? p.chosen;
  const has = (p) => cart?.items.some((c) => c.product_id === p.id && (!size(p) || c.size === size(p)));
  const b = el('button', { className: 'primary', textContent: t('kiosk.add.btn') });
  const msg = el('p', { className: 'error', style: 'margin:0;min-height:0', role: 'alert' });
  const sync = () => { b.disabled = items.every(has); b.replaceChildren(...(b.disabled ? [icon('check'), t('kiosk.add.done')] : [icon('bag'), t('kiosk.add.btn')])); };
  b.onclick = async () => {
    const missing = items.find((p) => !size(p));
    if (missing) return void (msg.textContent = t('kiosk.add.pick_size', { name: productName(missing) }));
    msg.textContent = '';
    b.disabled = true;
    try {
      const todo = items.filter((p) => !has(p)).map((p) => ({ product_id: p.id, size: size(p) }));
      setCart(await api('/cart/items', { token: cart?.token, store_id: storeId, items: todo, rec: request?.rec }));
    } catch (err) {
      msg.textContent = err.message;
    }
    sync();
  };
  syncs.add(sync);
  sync();
  return el('div', {}, b, msg);
}

function outfitCard(o, n) {
  const card = el('article', { className: 'outfit card' },
    el('h2', { textContent: o.title ? t('kiosk.outfit.n_title', { n, title: o.title }) : t('kiosk.outfit.n', { n }) }),
    ...(o.reason ? [el('p', { className: 'muted', textContent: o.reason })] : []),
    el('ul', { className: 'items' }, ...o.items.map(itemRow)),
    el('div', { className: 'total' }, el('span', {}, `${t('common.total')}: `, el('strong', { textContent: som(o.total) })), addButton(o.items)),
  );
  // R5: the cheaper variant is one compact "swap X for Y, save N" row, not a second outfit.
  if (o.alternative) {
    const swap = o.alternative.items.find((p) => !o.items.some((x) => x.id === p.id));
    const old = o.items.find((p) => p.id === o.alternative.replaces);
    card.append(el('div', { className: 'alt' },
      thumb(swap),
      el('div', {}, el('strong', { textContent: t('kiosk.outfit.alt') }),
        el('div', { className: 'meta', textContent: t('kiosk.outfit.alt_save', { name: productName(old), swap: productName(swap), sum: som(o.total - o.alternative.total) }) })),
      addButton(o.alternative.items),
    ));
  }
  return card;
}

// Nothing fits the budget: the required items that do fit, cheapest first (the full cheapest outfit follows).
function partialCard(p) {
  return el('article', { className: 'outfit card' },
    el('h2', { textContent: t('kiosk.partial.title') }),
    ...(p.missing.length ? [el('p', { className: 'muted', textContent: t('kiosk.partial.missing', { cats: p.missing.map(cat).join(', ') }) })] : []),
    el('ul', { className: 'items' }, ...p.items.map(itemRow)),
    el('div', { className: 'total' }, el('span', {}, `${t('common.total')}: `, el('strong', { textContent: som(p.total) })), addButton(p.items)),
  );
}

// --- Cart and checkout. Every number shown here comes from the server; the browser sends no prices.
const sumRow = (label, value, className = '') => el('div', { className }, el('span', { textContent: label }), el('span', { textContent: value }));
const checkout = $('checkout');

$('cartBtn').onclick = () => { show('cart'); renderCartScreen(); };
$('cartBack').onclick = () => show(request ? 'results' : 'start');
checkout.addEventListener('change', (e) => e.target.name === 'fulfillment' && renderSum());

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
  const sel = el('select', { ariaLabel: t('kiosk.size.aria', { name }), disabled: i.sizes.length < 2, onchange: () => cartAction(() => api(url, { size: sel.value }, 'PATCH')) },
    ...i.sizes.map((s) => el('option', { value: s, textContent: sizeName(s), selected: s === i.size })));
  return el('li', {},
    thumb(i),
    el('div', {},
      el('div', { textContent: i.quantity > 1 ? `${name} × ${i.quantity}` : name }),
      el('div', { className: 'meta', textContent: [cat(i.category), colorName(i.color), i.shelf_location && t('kiosk.shelf', { shelf: i.shelf_location })].filter(Boolean).join(' · ') }),
      el('div', { className: 'line-actions' }, sel, el('button', { type: 'button', textContent: t('common.delete'), ariaLabel: t('kiosk.cart.remove_aria', { name }), onclick: () => cartAction(() => api(url, null, 'DELETE')) }))),
    el('div', { className: i.discount_price ? 'price sale' : 'price' }, ...(i.discount_price ? [el('s', { textContent: som(i.price * i.quantity) })] : []), som(i.line_total)),
  );
}

function renderCartScreen() {
  const empty = !cart?.items.length;
  checkout.hidden = $('holdNote').hidden = empty;
  if (empty) return $('cartBody').replaceChildren(el('p', { className: 'muted', textContent: t('kiosk.cart.empty') }));
  $('holdNote').textContent = t('kiosk.cart.held', { time: fmt.time(cart.expires_at) });
  $('cartBody').replaceChildren(el('ul', { className: 'items' }, ...cart.items.map(cartLine)));
  renderPay();
  renderSum();
}

// Click/Payme only on the phone (no card entry on a shared kiosk) and only when the server has them configured.
const PAY = { cashier: 'kiosk.checkout.pay_cashier', click: 'Click', payme: 'Payme' }; // brand names stay as they are
function renderPay() {
  const online = kiosk ? [] : cart.payments.filter((m) => m !== 'cashier' && PAY[m]);
  $('payFields').hidden = !online.length;
  $('payNote').textContent = t(online.length ? 'kiosk.checkout.note_online' : 'kiosk.checkout.note_cashier');
  if (!online.length) return;
  const picked = checkout.payment?.value || 'cashier';
  $('payChoices').replaceChildren(...['cashier', ...online].map((m) =>
    el('label', {}, el('input', { type: 'radio', name: 'payment', value: m, checked: m === picked }), el('span', { textContent: t(PAY[m]) }))));
}

function renderSum() {
  const delivery = checkout.fulfillment.value === 'delivery';
  const s = cart.totals[delivery ? 'delivery' : 'pickup'], d = cart.delivery;
  $('deliveryFields').hidden = !delivery;
  $('cartSum').replaceChildren(
    sumRow(t('kiosk.checkout.items'), som(s.subtotal)),
    ...(delivery ? [sumRow(t('kiosk.checkout.delivery_in', { city: d.city }), s.delivery_fee ? som(s.delivery_fee) : t('common.free'))] : []),
    sumRow(t('common.total'), som(s.total), 'grand'),
    ...(delivery && s.delivery_fee && d.free_over !== null ? [el('p', { className: 'meta', style: 'margin:.35rem 0 0', textContent: t('kiosk.checkout.free_over', { sum: som(d.free_over) }) })] : []),
  );
  if (delivery) loadMap();
}

// Map pin for delivery: Leaflet + OpenStreetMap tiles, loaded only when delivery is picked. Without it the address alone is enough.
const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
let leaflet = null, map = null, marker = null, pin = null;
function loadMap() {
  leaflet ??= new Promise((ok, no) => {
    document.head.append(el('link', { rel: 'stylesheet', href: LEAFLET + 'leaflet.css', integrity: 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H', crossOrigin: 'anonymous' }));
    document.head.append(el('script', { src: LEAFLET + 'leaflet.js', integrity: 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH', crossOrigin: 'anonymous', onload: ok, onerror: no }));
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
}

checkout.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = checkout, delivery = f.fulfillment.value === 'delivery';
  const check = [
    [f.fullname.value.trim().length < 2, f.fullname, 'kiosk.checkout.err_name'],
    [!/^(\+?998)?\d{9}$/.test(f.phone.value.replace(/[\s()-]/g, '')), f.phone, 'kiosk.checkout.err_phone'],
    [delivery && f.address.value.trim().length < 5, f.address, 'kiosk.checkout.err_address'],
  ].find(([bad]) => bad);
  $('checkoutError').textContent = check ? t(check[2]) : '';
  if (check) return check[1].focus();
  $('placeOrder').disabled = true;
  try {
    const r = await api(`/cart/${cart.token}/checkout`, {
      fulfillment: f.fulfillment.value, name: f.fullname.value, phone: f.phone.value, payment: f.payment?.value || 'cashier',
      ...(delivery && { address: f.address.value, ...(pin && { lat: pin.lat, lon: pin.lng }) }),
    });
    setCart(null);
    clearCheckout();
    showDone(r.order, r.payment, r.notify);
  } catch (err) {
    if (err.status === 404) return cartAction(() => Promise.reject(err));
    $('checkoutError').textContent = err.message;
  } finally {
    $('placeOrder').disabled = false;
  }
});

function showDone(o, pay = { method: 'cashier' }, notify = null) {
  const online = pay.url && /^https:\/\//.test(pay.url);
  $('orderNo').textContent = `№ ${o.id}`;
  $('doneBody').replaceChildren(
    el('div', { className: 'sum card' },
      ...o.items.map((i) => sumRow(`${productName(i)} · ${sizeName(i.size)}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`, som(i.unit_price * i.quantity))),
      ...(o.fulfillment === 'delivery' ? [sumRow(t('kiosk.done.delivery'), o.delivery_fee ? som(o.delivery_fee) : t('common.free'))] : []),
      sumRow(t('common.total'), som(o.total), 'grand')),
    el('p', { className: 'notice', textContent: t('kiosk.done.pay_note', { what: online ? t('kiosk.done.pay_online', { method: t(PAY[pay.method]) }) : t('kiosk.done.pay_cashier'), time: fmt.time(o.expires_at) }) }),
    ...(online ? [el('a', { className: 'button primary wide', href: pay.url, rel: 'noopener', textContent: t('kiosk.done.pay_btn', { method: t(PAY[pay.method]) }) })] : []),
    el('p', { textContent: o.fulfillment === 'pickup' ? t('kiosk.done.next_pickup') : t('kiosk.done.next_delivery', { phone: o.phone }) }),
    ...(notify ? [telegramBlock(notify)] : []),
  );
  show('done');
}
// Order status by Telegram: the phone opens the bot link; the kiosk shows it as a QR to scan with the customer's phone.
// The SVG is built by our server from our own t.me link.
function telegramBlock(n) {
  if (!/^https:\/\/t\.me\//.test(n.url)) return el('div');
  if (!kiosk) return el('a', { className: 'button wide', href: n.url, rel: 'noopener', textContent: t('kiosk.done.tg_track') });
  const qr = el('div', { className: 'tgqr' });
  qr.innerHTML = n.svg;
  return el('div', { className: 'notice stack' }, el('p', { textContent: t('kiosk.done.tg_scan') }), qr);
}
$('doneHome').onclick = () => reset();

// Back to start keeps the cart; only the kiosk idle reset clears it for the next customer.
// Icon button, so it is not mistaken for the cart (U15); with items in the cart it asks first.
$('home').onclick = async () => {
  if (cart?.items.length && !(await confirmDialog({ title: t('kiosk.leave.title'), text: t('kiosk.leave.text'), ok: t('kiosk.leave.ok'), cancel: t('kiosk.leave.stay') }))) return;
  show('start');
  loadStore();
};

function reset() {
  if (cart) api(`/cart/${cart.token}`, null, 'DELETE').catch(() => {}); // give the held stock back now, not in 15 min
  setCart(null);
  request = body = sizeInfo = lastResult = null;
  loadSeq++; // a results request still in flight must not draw for the next customer
  if (kiosk) {
    setLang('uz'); // the next customer starts in Uzbek
    switcher.sync();
  }
  form.reset();
  clearCheckout();
  $('formError').textContent = '';
  $('results').replaceChildren();
  show('start');
  loadStore();
}
if (kiosk) watchIdle(document, { onIdle: reset });

show('start');
loadStore();
if (savedCart()) api('/cart/' + savedCart()).then((c) => setCart(c.store_id === storeId ? c : null), () => setCart(null));
