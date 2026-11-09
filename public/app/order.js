// Public order status page (/order/<token>, audit U7): timeline, items, pay-by countdown. Shows no name or phone.
import { icon } from '/shared/ui.js';
import { t, fmt, initLang, getLang, langSwitch, productName } from '/shared/i18n.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const token = location.pathname.split('/').pop();
const PAY = { click: 'Click', payme: 'Payme' };
const REFRESH_MS = 20_000;
let order = null, deadline = 0, tick = null, error = '';

initLang();
$('langBox').replaceChildren(langSwitch(() => render(), { short: true }));

// The same stages as the Telegram messages: pending → paid → packing → (shipping) → delivered, or cancelled.
const stageOf = (o) => (o.status === 'new' ? (o.payment_status === 'paid' ? 'paid' : 'pending') : o.status);
function steps(o) {
  const all = ['placed', 'paid', 'packing', ...(o.fulfillment === 'delivery' ? ['shipping'] : []), 'delivered'];
  const reached = { pending: 1, paid: 2, packing: 3, shipping: 4, delivered: all.length, cancelled: o.paid_at ? 2 : 1 }[stageOf(o)];
  return all.map((s, i) => ({ s, done: i < reached, current: i === reached - 1 }));
}
const stepName = (o, s) => t(`kiosk.track.step.${s === 'delivered' && o.fulfillment === 'pickup' ? 'handed' : s}`);

async function load() {
  try {
    const res = await fetch(`/api/orders/${token}`, { headers: { 'accept-language': getLang() } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('common.error'));
    order = data;
    error = '';
    deadline = order.pay_ms != null ? Date.now() + order.pay_ms : 0;
  } catch (err) {
    error = err.message;
  }
  render();
}

function render() {
  clearInterval(tick);
  if (!order) {
    $('title').textContent = 'Smart Fit';
    return $('body').replaceChildren(el('div', { className: 'empty' }, icon('receipt'), el('p', { textContent: error })));
  }
  const o = order;
  document.title = `${t('kiosk.track.title', { n: o.number })} · Smart Fit`;
  $('storeName').textContent = o.store.name;
  $('title').textContent = t('kiosk.track.title', { n: o.number });
  $('where').textContent = o.fulfillment === 'pickup' ? t('kiosk.track.pickup_at', { address: [o.store.city, o.store.address].filter(Boolean).join(', ') }) : t('kiosk.done.delivery');
  const stage = stageOf(o);
  const timeline = el('ol', { className: `timeline${stage === 'cancelled' ? ' off' : ''}` }, ...steps(o).map(({ s, done, current }) => {
    const li = el('li', { className: done ? 'done' : '' }, el('span', { className: 'dot' }, done ? icon('check') : ''), el('span', { textContent: stepName(o, s) }));
    if (current) li.setAttribute('aria-current', 'step');
    return li;
  }));
  const pay = el('div');
  const payNow = () => {
    const left = deadline - Date.now();
    if (left <= 0) return load(); // the server cancels it; show that
    pay.replaceChildren(el('div', { className: `notice${left < 2 * 60_000 ? ' warn' : ''}` }, icon('clock'), el('div', {},
      el('strong', { textContent: t('kiosk.track.pay_left', { left: fmt.countdown(left) }) }),
      el('p', { textContent: o.pay_url ? t('kiosk.done.pay_online', { method: PAY[o.payment_method] }) : t('kiosk.track.pay_cashier', { n: `№ ${o.number}` }) }))),
    ...(o.pay_url && /^https:\/\//.test(o.pay_url) ? [el('a', { className: 'button primary wide', href: o.pay_url, rel: 'noopener', textContent: t('kiosk.done.pay_btn', { method: PAY[o.payment_method] }) })] : []));
  };
  if (stage === 'pending' && deadline) {
    payNow();
    tick = setInterval(payNow, 1000);
  }
  $('body').replaceChildren(
    ...(stage === 'cancelled' ? [el('div', { className: 'notice danger' }, icon('alert'), el('p', { textContent: [t('kiosk.track.cancelled'), o.payment_status === 'paid' && t('kiosk.track.refund')].filter(Boolean).join(' ') }))] : []),
    pay,
    timeline,
    el('div', { className: 'sum card' },
      ...o.items.map((i) => el('div', {}, el('span', { textContent: `${productName(i)} · ${i.size === 'ONE' ? t('common.size_one') : i.size}${i.quantity > 1 ? ` × ${i.quantity}` : ''}` }), el('span', { textContent: fmt.som(i.unit_price * i.quantity) }))),
      ...(o.fulfillment === 'delivery' ? [el('div', {}, el('span', { textContent: t('kiosk.done.delivery') }), el('span', { textContent: o.delivery_fee ? fmt.som(o.delivery_fee) : t('common.free') }))] : []),
      el('div', { className: 'grand' }, el('span', { textContent: t('common.total') }), el('span', { textContent: fmt.som(o.total) }))),
    ...(o.fit_open ? [fitBox(o)] : []),
    ...(o.telegram && /^https:\/\/t\.me\//.test(o.telegram) && !['delivered', 'cancelled'].includes(stage) ? [el('a', { className: 'button wide', href: o.telegram, rel: 'noopener', textContent: t('kiosk.done.tg_track') })] : []),
  );
  $('updated').textContent = error || t('kiosk.track.updated', { time: fmt.time(new Date().toISOString()) });
}

// Task 23: "how did it fit?" per sized item, once the order is handed over. Redraws only itself (the page is a live region).
const FIT = { small: 'kiosk.track.fit_small', right: 'kiosk.track.fit_right', big: 'kiosk.track.fit_big' };
function fitBox(o, said = '') {
  const items = o.items.filter((i) => i.category !== 'accessory');
  const box = el('section', { className: 'card fit-ask', id: 'fit' }, el('h2', { textContent: t('kiosk.track.fit_title') }), el('p', { className: 'muted', textContent: t('kiosk.track.fit_text') }),
    ...items.map((i) => {
      const chips = el('div', { className: 'size-chips', role: 'group', ariaLabel: t('kiosk.track.fit_aria', { name: productName(i) }) }, ...Object.entries(FIT).map(([fit, key]) => {
        const b = el('button', { type: 'button', className: 'chip', textContent: t(key) });
        b.setAttribute('aria-pressed', String(i.fit === fit));
        b.onclick = () => answer(o, i, fit, box);
        return b;
      }));
      return el('div', { className: 'fit-row' }, el('span', { textContent: `${productName(i)} · ${i.size}` }), chips);
    }),
    el('p', { className: 'meta', role: 'status', textContent: said }));
  return box;
}
async function answer(o, item, fit, box) {
  let said;
  try {
    const res = await fetch(`/api/orders/${token}/fit`, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': getLang() }, body: JSON.stringify({ item: item.id, fit }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t('common.error'));
    item.fit = fit;
    said = t('kiosk.track.fit_thanks');
  } catch (err) {
    said = err.message;
  }
  const next = fitBox(o, said);
  box.replaceWith(next);
  const row = next.querySelectorAll('.fit-row')[o.items.filter((i) => i.category !== 'accessory').indexOf(item)];
  (row?.querySelector('[aria-pressed="true"]') ?? row?.querySelector('.chip'))?.focus();
}

await load();
$('title').focus({ preventScroll: true });
// Follow the order while it is still moving.
setInterval(() => { if (!document.hidden && order && !['delivered', 'cancelled'].includes(stageOf(order))) load(); }, REFRESH_MS);
