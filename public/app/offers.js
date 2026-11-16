// Task 43: shop offers on customer screens. The mall screen's "Aksiyalar" and a shop's own start screen show cards;
// a mall kiosk's idle screen rotates the mall's approved offers until any touch. Offer text and pictures come from
// shops: always set as text / image src, never as HTML. Counts (shown, tapped) are numbers only, sent without any id.
import { t, getLang } from '/shared/i18n.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter((k) => k != null && k !== false)); return e; };
const loc = (o, k) => (getLang() === 'ru' && o[`${k}_ru`]) || o[k] || '';
export const offerWhere = (s) => [s.name, s.floor && t('kiosk.mall.floor', { n: s.floor }), s.unit && t('kiosk.mall.unit', { n: s.unit })].filter(Boolean).join(' · ');

// Fire and forget; keepalive lets a tap's count leave while the page navigates away.
export function countOffers(body) {
  if (!body.shown?.length && !body.tapped) return;
  fetch('/api/offers/events', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}

// A card: picture, title, text, the shop's place (mall only), the promo code the shop chose to show.
// href → a link; onOpen → a button; neither → plain.
export function offerCard(o, { href, onOpen, place = true } = {}) {
  const tap = () => countOffers({ tapped: o.id });
  const props = href ? { href, onclick: tap } : onOpen ? { type: 'button', onclick: () => { tap(); onOpen(); } } : {};
  return el(href ? 'a' : onOpen ? 'button' : 'div', { className: 'offer-card', ...props },
    o.image_url ? el('img', { src: o.image_url, alt: '', loading: 'lazy' }) : null,
    el('span', { className: 'offer-text' },
      el('strong', { textContent: loc(o, 'title') }),
      loc(o, 'body') ? el('span', { className: 'offer-body', textContent: loc(o, 'body') }) : null,
      place ? el('span', { className: 'meta', textContent: offerWhere(o.store) }) : null,
      o.code ? el('span', { className: 'offer-code', textContent: t('kiosk.offer.code', { code: o.code }) }) : null));
}

// The mall kiosk's idle screen: after the idle reset (the customer's data is already gone), the mall's approved offers
// one by one, in the mall admin's order and time, asked again every round so they come and go on time. Any touch or
// key ends it (kiosk.js turns the attract loop off) and the start screen is under it. No offers → the start screen.
// No sound, ever (pictures only); prefers-reduced-motion drops the fade (app.css).
export function idleSlides({ mallId, api }) {
  const box = $('slides');
  let timer = null, seq = 0;
  const on = () => document.documentElement.classList.contains('attract-loop');

  async function start() {
    stop();
    const mine = ++seq, counted = new Set();
    let data = null, i = 0;
    const load = async () => {
      try { data = await api(`/malls/${mallId}/offers`); } catch { data = null; }
      return mine === seq && on() && data?.offers.length > 0;
    };
    const next = async () => {
      if (i >= data.offers.length) {
        i = 0;
        if (!(await load())) return stop();
      }
      const o = data.offers[i++];
      box.replaceChildren(el('div', { className: 'slide' },
        o.image_url ? el('img', { src: o.image_url, alt: '' }) : null,
        el('div', { className: 'slide-text' },
          el('h2', { textContent: loc(o, 'title') }),
          loc(o, 'body') ? el('p', { textContent: loc(o, 'body') }) : null,
          el('p', { className: 'meta', textContent: offerWhere(o.store) }),
          o.code ? el('p', { className: 'offer-code', textContent: t('kiosk.offer.code', { code: o.code }) }) : null)),
      el('p', { className: 'slide-hint', textContent: t('kiosk.offer.touch') }));
      if (!counted.has(o.id)) countOffers({ shown: [o.id] }); // once per offer per idle session
      counted.add(o.id);
      timer = setTimeout(next, data.seconds * 1000);
    };
    if (!(await load())) return;
    box.hidden = false;
    next();
  }
  function stop() {
    seq++;
    clearTimeout(timer);
    box.hidden = true;
    box.replaceChildren();
  }
  document.addEventListener('attract', (e) => (e.detail ? start() : stop()));
  return { start };
}
