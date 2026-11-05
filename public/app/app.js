import { watchIdle } from './idle.js';
import { loadPose, measure } from './pose.js';

// One app: /kiosk (big buttons, idle reset) and /m (phone, opened from the store QR).
const kiosk = location.pathname.startsWith('/kiosk');
document.documentElement.classList.add(kiosk ? 'kiosk' : 'mobile');
const storeId = Number(new URLSearchParams(location.search).get('store'));

const CATS = { outerwear: 'Ustki kiyim', top: "Ko'ylak / futbolka", bottom: 'Shim / yubka', shoes: 'Poyabzal', accessory: 'Aksessuar' };
const CLOTHES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const SHOES = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'];

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const som = (n) => n.toLocaleString('ru-RU').replace(/\s/g, '\u00a0') + "\u00a0so'm";
const form = $('form');

// shortcut: in-memory cart stub (product + size); task 8 replaces it with the server cart and stock holds.
let cart = [];
let request = null; // POST /api/recommend body
let body = null; // { gender, height, weight } for POST /api/size
let sizeInfo = null; // last /api/size answer: confidence for the results screen
let store = null;

form.shoes.append(...SHOES.map((s) => el('option', { value: s, textContent: s })));

function show(name) {
  if (name !== 'camera') stopCamera();
  for (const s of document.querySelectorAll('[data-screen]')) s.hidden = s.dataset.screen !== name;
  $('home').hidden = name === 'start';
  window.scrollTo(0, 0);
  document.querySelector(`[data-screen="${name}"] h1`).focus({ preventScroll: true });
}

function renderCart() {
  $('cartCount').textContent = cart.length ? `Savatda: ${cart.length} ta` : '';
}

const weatherLine = (w) => `${Math.round(w.temperature)}°C${w.raining ? ", yomg'ir" : ''}`;

async function api(path, body) {
  const res = await fetch('/api' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Xatolik yuz berdi. Qayta urinib ko'ring"), { status: res.status });
  return data;
}

async function loadStore() {
  $('startError').textContent = '';
  $('start').disabled = true;
  if (!Number.isInteger(storeId) || storeId < 1) {
    $('weather').hidden = $('start').hidden = true;
    $('startError').textContent = "Do'kon ko'rsatilmagan. Do'kondagi QR kodni qayta skanerlang.";
    return;
  }
  try {
    store = await api('/stores/' + storeId);
  } catch (err) {
    $('weather').hidden = true;
    $('startError').textContent = err.status === 404 ? "Do'kon topilmadi. Do'kondagi QR kodni qayta skanerlang." : "Ulanishda xatolik. Bir ozdan keyin qayta urinib ko'ring.";
    $('start').hidden = err.status === 404; // a wrong store link won't fix itself
    $('start').disabled = false;
    $('start').textContent = 'Qayta urinish';
    return;
  }
  const w = store.weather;
  $('storeName').textContent = store.name;
  $('start').textContent = 'Boshlash';
  $('start').disabled = false;
  $('weather').hidden = false;
  $('weather').replaceChildren(
    el('div', { className: 'muted', textContent: `${store.city}, hozir` }),
    el('div', { className: 'temp', textContent: weatherLine(w) }),
    ...(w.apparent_temperature !== null ? [el('div', { className: 'muted', textContent: `His qilinishi ${Math.round(w.apparent_temperature)}°C` })] : []),
    ...(w.source === 'fallback' ? [el('div', { className: 'muted', textContent: "Taxminiy: shu oyning o'rtacha harorati" })] : []),
    el('p', { style: 'margin:.5rem 0 0', textContent: w.temperature < 18 || w.raining ? 'Bugun ustki kiyim ham tavsiya qilamiz.' : 'Bugun yengil kiyim mos keladi.' }),
  );
}

$('start').onclick = () => (store ? show('form') : loadStore());

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = form;
  const n = (v) => (v.trim() === '' ? null : Number(v));
  const height = n(f.height.value), weight = n(f.weight.value), budget = n(f.budget.value);
  const check = [
    [!f.gender.value, f.querySelector('[name=gender]'), 'Jinsingizni tanlang'],
    [!Number.isInteger(height) || height < 100 || height > 230, f.height, "Bo'yingizni 100–230 sm oralig'ida kiriting"],
    [weight !== null && (!Number.isInteger(weight) || weight < 30 || weight > 250), f.weight, "Vaznni 30–250 kg oralig'ida kiriting yoki bo'sh qoldiring"],
    [budget !== null && (!Number.isInteger(budget) || budget < 1 || budget > 1e9), f.budget, "Byudjetni butun so'mda kiriting yoki bo'sh qoldiring"],
  ].find(([bad]) => bad);
  $('formError').textContent = check ? check[2] : '';
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
  $('shoot').textContent = 'Rasmga tushish';
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
    const why = err.name === 'NotAllowedError' ? 'Kameraga ruxsat berilmadi.' : 'Kamera ishlamayapti.';
    return status(kiosk ? `${why} Rasmsiz davom eting.` : `${why} Galereyadan rasm tanlang yoki rasmsiz davom eting.`);
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
    return status("Bu rasmni ochib bo'lmadi. Boshqa rasm tanlang.");
  }
  try {
    await analyse(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
};

$('noPhoto').onclick = () => findSizes(null);

async function analyse(source, w, h) {
  status('Rasm tahlil qilinmoqda…');
  let pose;
  try {
    pose = await measure(source, w, h);
  } catch {
    stopCamera();
    return status("Rasmni tahlil qilib bo'lmadi (internet yo'q bo'lishi mumkin). Qayta urinib ko'ring yoki rasmsiz davom eting.");
  }
  stopCamera();
  if (cameraScreen.hidden) return; // kiosk reset or "Orqaga" while the model was working
  if (!pose) {
    $('shoot').textContent = 'Qayta urinish';
    return status("Butun tanangiz ko'rinmadi. Oyoqlarni yaqin qo'yib tik turing, boshdan oyoqqacha kadrga tushadigan qilib uzoqroq turing va yorug' joyda qayta urinib ko'ring.");
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
    $('shoot').textContent = 'Qayta urinish';
    return status(err.message);
  }
  setBusy(false);
  if (cameraScreen.hidden) return;
  Object.assign(request.sizes, sizeInfo.sizes);
  request.photo = photo ?? undefined; // undefined is left out of the JSON
  loadResults();
}

// --- Screen 4: results, with - / + to correct the estimated size.
const CONFIDENCE = {
  high: "Rasm va vazningiz bo'yicha aniqlandi.",
  medium: 'Taxminiy razmer.',
  low: "Taxminiy razmer: faqat bo'yingiz bo'yicha.",
};

function renderSizes() {
  const stepper = (key, label) => {
    const i = CLOTHES.indexOf(request.sizes[key]);
    const move = (d) => () => {
      request.sizes[key] = CLOTHES[i + d];
      sizeInfo.manual = true;
      loadResults();
    };
    return el('div', { className: 'stepper' }, el('span', { textContent: label }),
      el('button', { type: 'button', textContent: '−', ariaLabel: `${label}: kichikroq razmer`, disabled: i <= 0, onclick: move(-1) }),
      el('strong', { textContent: request.sizes[key] }),
      el('button', { type: 'button', textContent: '+', ariaLabel: `${label}: kattaroq razmer`, disabled: i >= CLOTHES.length - 1, onclick: move(1) }));
  };
  $('sizeBar').replaceChildren(
    el('div', { className: 'row' }, stepper('top', 'Ustki'), stepper('bottom', 'Shim')),
    el('p', { className: 'meta', style: 'margin:.5rem 0 0', textContent: sizeInfo.manual ? "Razmerni o'zingiz tanladingiz." : `${CONFIDENCE[sizeInfo.confidence]} Mos kelmasa, − / + bilan o'zgartiring.` }),
  );
}

async function loadResults() {
  show('results');
  renderSizes();
  $('resultsWeather').textContent = '';
  $('results').replaceChildren(el('p', { className: 'muted', textContent: 'Obrazlar tanlanmoqda…' }));
  let r;
  try {
    r = await api('/recommend', request);
  } catch (err) {
    $('results').replaceChildren(el('p', { className: 'error', textContent: err.message }), el('button', { className: 'primary', textContent: 'Qayta urinish', onclick: loadResults }));
    return;
  }
  $('resultsWeather').textContent = `Ob-havo: ${weatherLine(r.weather)}` + (r.budget ? ` · Byudjet: ${som(r.budget)}` : '');
  if (!r.outfits.length) {
    $('results').replaceChildren(el('div', { className: 'notice warn', textContent: "Hozir sizning razmeringizda bugungi ob-havoga mos to'liq obraz yo'q. − / + bilan boshqa razmerni tanlab ko'ring yoki do'kon xodimidan so'rang." }));
    return;
  }
  $('results').replaceChildren(
    ...(r.style_guess ? [el('p', { className: 'muted', textContent: `Uslub: ${r.style_guess}` })] : []),
    ...(r.over_budget > 0 ? [el('div', { className: 'notice warn', textContent: `Byudjetingizga mos obraz topilmadi. Eng arzon obraz byudjetdan ${som(r.over_budget)} qimmat.` })] : []),
    ...r.outfits.map((o, i) => outfitCard(o, i + 1)),
  );
}

function itemRow(p) {
  const size = p.size ? (p.size === 'ONE' ? 'yagona razmer' : `razmer ${p.size}`) : 'razmer savatda tanlanadi';
  return el('li', {},
    p.image_url ? el('img', { className: 'thumb', src: p.image_url, alt: '' }) : el('div', { className: 'thumb' }),
    el('div', {}, el('div', { textContent: p.name }), el('div', { className: 'meta', textContent: [CATS[p.category], p.color, size, p.shelf_location && `javon ${p.shelf_location}`].filter(Boolean).join(' · ') })),
    el('div', { className: 'price' }, ...(p.discount_price ? [el('s', { textContent: som(p.price) })] : []), som(p.unit_price)),
  );
}

function addButton(items) {
  const keys = items.map((p) => `${p.id}:${p.size}`);
  const inCart = () => keys.every((k) => cart.some((c) => `${c.product_id}:${c.size}` === k));
  const b = el('button', { className: 'primary', textContent: "Savatga qo'shish" });
  const sync = () => { b.disabled = inCart(); b.textContent = b.disabled ? "Savatga qo'shildi ✓" : "Savatga qo'shish"; };
  b.onclick = () => {
    for (const p of items) if (!cart.some((c) => c.product_id === p.id && c.size === p.size)) cart.push({ product_id: p.id, size: p.size });
    renderCart();
    sync();
  };
  sync();
  return b;
}

function outfitCard(o, n) {
  const card = el('article', { className: 'outfit' },
    el('h2', { textContent: o.title ? `${n}-obraz: ${o.title}` : `${n}-obraz` }),
    ...(o.reason ? [el('p', { className: 'muted', textContent: o.reason })] : []),
    el('ul', { className: 'items' }, ...o.items.map(itemRow)),
    el('div', { className: 'total' }, el('span', {}, 'Jami: ', el('strong', { textContent: som(o.total) })), addButton(o.items)),
  );
  if (o.alternative) {
    const swapped = o.alternative.items.find((p) => !o.items.some((x) => x.id === p.id));
    const old = o.items.find((p) => p.id === o.alternative.replaces);
    card.append(el('div', { className: 'alt' },
      el('h2', { textContent: 'Arzonroq variant' }),
      el('p', { className: 'muted', textContent: `«${old.name}» o'rniga — ${som(o.total - o.alternative.total)} tejaysiz` }),
      el('ul', { className: 'items' }, itemRow(swapped)),
      el('div', { className: 'total' }, el('span', {}, 'Jami: ', el('strong', { textContent: som(o.alternative.total) })), addButton(o.alternative.items)),
    ));
  }
  return card;
}

// Back to start keeps the cart; only the kiosk idle reset clears it for the next customer.
$('home').onclick = () => { show('start'); loadStore(); };

function reset() {
  cart = [];
  request = body = sizeInfo = null;
  form.reset();
  $('formError').textContent = '';
  $('results').replaceChildren();
  renderCart();
  show('start');
  loadStore();
}
if (kiosk) watchIdle(document, { onIdle: reset });

show('start');
loadStore();
