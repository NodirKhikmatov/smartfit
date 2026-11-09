// Landing page (task 22): language switch, the live outfit card (the real engine's pick per temperature, from
// /landing/looks.json), the band switches, the demo request form, Tashkent time, and section entrances.
import { t, fmt, initLang, getLang, langSwitch, productName, colorName } from '/shared/i18n.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k != null && k !== false));
  return e;
};
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

document.documentElement.classList.add('js-motion');
initLang();
const title = () => { document.title = `${t('land.doc_title')} · Smart Fit`; };
title();
$('lang').append(langSwitch(() => { title(); drawLook(false); }, { short: true }));

// ---------- The outfit card: pick a temperature, the card answers with what the kiosk would show.
let looks = [], at = 2; // 15 °C first: the spring/autumn look most stores sell
const WEATHER_ICON = (temp) => (temp <= 0 ? 'snow' : temp < 18 ? 'cloud-sun' : 'sun');
function drawLook(animate = true) {
  const look = looks[at];
  if (!look) return;
  for (const [i, b] of [...$('temps').children].entries()) {
    b.setAttribute('aria-checked', String(i === at));
    b.tabIndex = i === at ? 0 : -1;
  }
  $('lookIcon').firstElementChild.setAttribute('href', `/shared/icons.svg#${WEATHER_ICON(look.t)}`);
  // Crossfade: the new collage fades in over the old one, which is then removed.
  const frame = el('div', { className: 'frame' }, ...look.items.slice(0, 4).map((p) => el('img', { src: p.image, alt: '', width: 300, height: 225 })));
  const old = [...$('lookPhotos').children];
  if (!animate) frame.classList.add('on'); // first draw and language switch: no fade
  $('lookPhotos').append(frame);
  if (animate) requestAnimationFrame(() => requestAnimationFrame(() => frame.classList.add('on')));
  setTimeout(() => old.forEach((o) => o.remove()), animate && !reduced ? 1700 : 0);
  $('lookRows').replaceChildren(...look.items.map((p) => el('li', {},
    el('span', { className: 'name', textContent: productName(p) }),
    el('span', { className: 'price', textContent: fmt.som(p.unit_price) }),
    el('span', { className: 'meta', textContent: [colorName(p.color), p.category === 'accessory' ? t('common.size_one') : t('land.look.size', { size: p.category === 'shoes' ? '42' : 'M' }), t('land.look.shelf', { shelf: p.shelf })].join(' · ') }))));
  $('lookTotal').textContent = fmt.som(look.items.reduce((s, p) => s + p.unit_price, 0));
  setAdded(false);
}
function setAdded(on) {
  $('lookAdd').querySelector('span').textContent = t(on ? 'land.look.added' : 'land.look.add');
  $('lookAdd').querySelector('use').setAttribute('href', `/shared/icons.svg#${on ? 'check' : 'bag'}`);
  $('lookAdd').setAttribute('aria-pressed', String(on));
}
$('lookAdd').onclick = () => setAdded($('lookAdd').getAttribute('aria-pressed') !== 'true');
function pick(i) {
  if (i === at || !looks[i]) return;
  at = i;
  drawLook();
}
// A radio group: arrows move and choose, as in the kiosk's own chips.
$('temps').addEventListener('keydown', (e) => {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  pick((at + step + looks.length) % looks.length);
  $('temps').children[at].focus();
});
fetch('/landing/looks.json').then((r) => r.json()).then((data) => {
  looks = data;
  $('temps').replaceChildren(...looks.map((l, i) => el('button', { type: 'button', role: 'radio', className: 'chip num', textContent: `${l.t > 0 ? '+' : l.t < 0 ? '−' : ''}${Math.abs(l.t)}°`, onclick: () => pick(i) })));
  drawLook(false);
}).catch(() => {});

// ---------- Bands: each switch opens the sentence's consequence.
for (const s of document.querySelectorAll('#bands .switch')) {
  s.onclick = () => {
    const on = s.getAttribute('aria-checked') !== 'true';
    s.setAttribute('aria-checked', String(on));
    s.closest('.band').toggleAttribute('data-on', on);
  };
}

// ---------- Demo request: the server validates and answers { code, error } in the page's language.
const f = $('demoForm');
const FIELD = { customer_name: 'name', phone: 'phone', company: 'company', city: 'city', stores: 'stores', message: 'message' };
f.addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));
f.onsubmit = async (e) => {
  e.preventDefault();
  $('demoError').textContent = '';
  for (const i of f.querySelectorAll('[aria-invalid]')) i.removeAttribute('aria-invalid');
  const bad = [...f.elements].find((i) => i.willValidate && !i.checkValidity());
  if (bad) {
    bad.setAttribute('aria-invalid', 'true');
    $('demoError').textContent = t('err.required', { field: bad.closest('label').querySelector('span').textContent });
    return bad.focus();
  }
  const v = (k) => f[k].value.trim();
  $('demoSubmit').disabled = true;
  try {
    const res = await fetch('/api/demo-requests', {
      method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': getLang() },
      body: JSON.stringify({ name: v('name'), phone: v('phone'), company: v('company'), city: v('city') || null, stores: v('stores') ? Number(v('stores')) : null, message: v('message') || null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const field = data.code === 'phone' ? 'phone' : Object.entries(FIELD).find(([k]) => data.error && data.code === 'invalid' && data.error.includes(t(`field.${k}`)))?.[1];
      if (field) { f[field].setAttribute('aria-invalid', 'true'); f[field].focus(); }
      throw new Error(data.error || t('common.error'));
    }
    f.reset();
    for (const i of f.querySelectorAll('.ask-grid, #demoSubmit')) i.hidden = true;
    $('demoDone').hidden = false;
    $('demoDone').focus?.();
  } catch (err) {
    $('demoError').textContent = err.message === 'Failed to fetch' ? t('common.error') : err.message;
  } finally {
    $('demoSubmit').disabled = false;
  }
};

// ---------- Tashkent time in the footer.
const tick = () => { $('clock').textContent = fmt.time(new Date().toISOString()); };
tick();
setInterval(tick, 15_000);

// ---------- Entrances: heading, then text, then picture, 80 ms apart, once per section.
// The hero is not here: the first screen never waits for a script or an animation.
const parts = '.bands .section-h, .screens .section-h, .calls .section-h, .ask .section-h, .screens-head p, .shot, .call, .call-final, .tile, .ask-prompt, #demoForm, .ask-links > div, .foot-tile';
const groups = new Map();
for (const n of document.querySelectorAll(parts)) {
  const sec = n.closest('section, footer');
  const list = groups.get(sec) ?? [];
  n.dataset.rise = '';
  n.style.setProperty('--i', String(list.length % 8));
  groups.set(sec, [...list, n]);
}
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}, { rootMargin: '0px 0px -8% 0px' });
for (const n of document.querySelectorAll('[data-rise]')) io.observe(n);
