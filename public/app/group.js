// Task 38: the mall order's public status page (/mall-order/<token>): every shop's order with its shop name, floor and
// unit, number, status and total (task 44: and a link to the shop on the mall map). Each one links to that shop order's own page (timeline, Telegram, fit question).
// Shows no name or phone. Shop and mall names come from the database: always set as text.
import { icon } from '/shared/ui.js';
import { t, fmt, initLang, getLang, langSwitch, productName } from '/shared/i18n.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter((k) => k != null && k !== false)); return e; };
const token = location.pathname.split('/').pop();
const REFRESH_MS = 20_000;
let group = null, error = '';

initLang();
$('langBox').replaceChildren(langSwitch(() => render(), { short: true }));

// The stage names of the order page (pending → paid → packing → shipping → delivered/handed, or cancelled).
function status(o) {
  if (o.status === 'cancelled') return t('kiosk.group.cancelled');
  if (o.status === 'new') return o.payment_status === 'paid' ? t('kiosk.track.step.paid') : t('kiosk.group.pending');
  return t(`kiosk.track.step.${o.status === 'delivered' && o.fulfillment === 'pickup' ? 'handed' : o.status}`);
}
const where = (s) => [s.floor && t('kiosk.mall.floor', { n: s.floor }), s.unit && t('kiosk.mall.unit', { n: s.unit })].filter(Boolean).join(' · ');
const open = (o) => !['delivered', 'cancelled'].includes(o.status);

async function load() {
  try {
    const res = await fetch(`/api/order-groups/${token}`, { headers: { 'accept-language': getLang() } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('common.error'));
    group = data;
    error = '';
  } catch (err) {
    error = err.message;
  }
  render();
}

function render() {
  if (!group) {
    $('title').textContent = 'Smart Fit';
    return $('body').replaceChildren(el('div', { className: 'empty' }, icon('receipt'), el('p', { textContent: error })));
  }
  const title = t('kiosk.mcart.number', { n: group.number });
  document.title = `${title} · Smart Fit`;
  $('storeName').textContent = group.mall.name;
  $('title').textContent = title;
  $('where').textContent = [group.mall.city, group.mall.address].filter(Boolean).join(', ');
  $('body').replaceChildren(...group.orders.map((o) => el('section', { className: 'card mc-shop' },
    el('div', { className: 'mall-head' },
      o.store.logo_url ? el('img', { className: 'shop-logo', src: o.store.logo_url, alt: '' }) : el('span', { className: 'shop-logo' }, icon('store')),
      el('div', {}, el('h2', { textContent: o.store.name }), where(o.store) ? el('p', { className: 'meta', textContent: where(o.store) }) : null,
        // Task 44: the shop on its floor plan (the mall screen's map view).
        o.store.map ? el('a', { className: 'map-link', href: `/m?mall=${group.mall.id}&pin=${o.store.id}#map` }, icon('map-pin'), el('span', { textContent: t('kiosk.map.show') })) : null),
      el('strong', { className: 'num', textContent: t('kiosk.track.title', { n: o.number }) })),
    el('div', { className: 'sum' },
      ...o.items.map((i) => el('div', {}, el('span', { textContent: `${productName(i)} · ${i.size === 'ONE' ? t('common.size_one') : i.size}${i.quantity > 1 ? ` × ${i.quantity}` : ''}` }), el('span', { textContent: fmt.som(i.unit_price * i.quantity) }))),
      el('div', { className: 'grand' }, el('span', { textContent: t('common.total') }), el('span', { textContent: fmt.som(o.total) }))),
    el('p', { className: `badge${o.status === 'cancelled' ? ' danger' : ''}`, textContent: status(o) }),
    o.payment_status === 'pending' && o.expires_at ? el('p', { className: 'meta', textContent: t('kiosk.mcart.pay_by', { time: fmt.time(o.expires_at) }) }) : null,
    // Task 46: once this shop's part is handed over, its own page asks for the ratings (per shop order).
    o.status === 'delivered' && o.payment_status === 'paid' ? el('a', { className: 'button primary wide', href: `${o.track}#review`, textContent: t('kiosk.review.group_rate') })
      : el('a', { className: 'button wide', href: o.track, textContent: t('kiosk.group.open') }))));
  $('updated').textContent = error || t('kiosk.track.updated', { time: fmt.time(new Date().toISOString()) });
}

await load();
$('title').focus({ preventScroll: true });
// Follow the orders while any of them is still moving.
setInterval(() => { if (!document.hidden && group?.orders.some(open)) load(); }, REFRESH_MS);
