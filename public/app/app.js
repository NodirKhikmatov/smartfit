import { watchIdle } from './idle.js';

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
let request = null;
let store = null;

for (const box of document.querySelectorAll('[data-sizes]')) {
  box.append(...CLOTHES.map((s) => el('label', {}, el('input', { type: 'radio', name: box.dataset.sizes, value: s }), el('span', { textContent: s }))));
}
form.shoes.append(...SHOES.map((s) => el('option', { value: s, textContent: s })));

function show(name) {
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
    [!f.top.value, f.querySelector('[name=top]'), 'Ustki kiyim razmerini tanlang'],
    [!f.bottom.value, f.querySelector('[name=bottom]'), 'Shim razmerini tanlang'],
    [budget !== null && (!Number.isInteger(budget) || budget < 1 || budget > 1e9), f.budget, "Byudjetni butun so'mda kiriting yoki bo'sh qoldiring"],
  ].find(([bad]) => bad);
  $('formError').textContent = check ? check[2] : '';
  if (check) return check[1].focus();
  // Height and weight are kept for task 6 (size from photo); the rule engine only needs sizes.
  request = { store_id: storeId, gender: f.gender.value, sizes: { top: f.top.value, bottom: f.bottom.value, shoes: f.shoes.value || null }, budget };
  show('camera');
});

$('cameraBack').onclick = () => show('form');
$('changeSizes').onclick = () => show('form');
$('recommend').onclick = loadResults;

async function loadResults() {
  show('results');
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
    $('results').replaceChildren(el('div', { className: 'notice warn', textContent: "Hozir sizning razmeringizda bugungi ob-havoga mos to'liq obraz yo'q. Boshqa razmer tanlab ko'ring yoki do'kon xodimidan so'rang." }));
    return;
  }
  $('results').replaceChildren(
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
    el('h2', { textContent: `${n}-obraz` }),
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
  request = null;
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
