// Public order status page (/order/<token>, audit U7): timeline, items, pay-by countdown. Shows no name or phone.
import { icon, stars } from '/shared/ui.js';
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
      // Task 26: discounts, bundle first (the order the server applies them in).
      ...(o.bundle_discount ? [el('div', { className: 'off' }, el('span', { textContent: t('common.bundle_off') }), el('span', { textContent: `−${fmt.som(o.bundle_discount)}` }))] : []),
      ...(o.promo_discount ? [el('div', { className: 'off' }, el('span', { textContent: t('common.promo_off', { code: o.promo_code }) }), el('span', { textContent: `−${fmt.som(o.promo_discount)}` }))] : []),
      ...(o.points_discount ? [el('div', { className: 'off' }, el('span', { textContent: t('common.points_off') }), el('span', { textContent: `−${fmt.som(o.points_discount)}` }))] : []),
      ...(o.fulfillment === 'delivery' ? [el('div', {}, el('span', { textContent: t('kiosk.done.delivery') }), el('span', { textContent: o.delivery_fee ? fmt.som(o.delivery_fee) : t('common.free') }))] : []),
      el('div', { className: 'grand' }, el('span', { textContent: t('common.total') }), el('span', { textContent: fmt.som(o.total) })),
      // Task 35: the instalment term chosen at checkout (the total is the price; the contract is made at the cashier).
      ...(o.instalment_months ? [el('p', { className: 'meta', textContent: t('kiosk.inst.item', { sum: fmt.som(o.instalment_monthly), n: o.instalment_months }) })] : [])),
    ...(o.fit_open ? [fitBox(o)] : []),
    ...(o.telegram && /^https:\/\/t\.me\//.test(o.telegram) && !['delivered', 'cancelled'].includes(stage) ? [el('a', { className: 'button wide', href: o.telegram, rel: 'noopener', textContent: t('kiosk.done.tg_track') })] : []),
  );
  $('updated').textContent = error || t('kiosk.track.updated', { time: fmt.time(new Date().toISOString()) });
}

// Task 23 / 46: once the order is handed over, each line gets a 1–5 rating, a fit answer (sized items) and an optional
// short text, once. A sent review is shown as sent (with the shop's answer); only that line's card is redrawn.
const FIT = { small: 'kiosk.track.fit_small', right: 'kiosk.track.fit_right', big: 'kiosk.track.fit_big' };
const sizeText = (i) => { const s = i.kept_size ?? i.size; return s === 'ONE' ? t('common.size_one') : s; };
function fitBox(o) {
  return el('section', { className: 'card fit-ask', id: 'review' }, el('h2', { textContent: t('kiosk.track.fit_title') }), el('p', { className: 'muted', textContent: t('kiosk.track.fit_text') }),
    ...o.items.map((i) => reviewItem(i)));
}
function reviewItem(i, said = '') {
  const head = el('div', { className: 'review-head' }, el('strong', { textContent: `${productName(i)} · ${sizeText(i)}` }),
    ...(i.returned ? [el('span', { className: 'badge', textContent: t('kiosk.review.returned') })] : []));
  const box = el('div', { className: 'review-item' }, head);
  const r = i.review;
  if (r) {
    box.append(stars(r.rating),
      ...(r.fit ? [el('p', { className: 'meta', textContent: t('kiosk.review.fit_said', { fit: t(FIT[r.fit]) }) })] : []),
      ...(r.text ? [el('p', { className: 'review-text', textContent: r.text })] : []),
      ...(r.hidden ? [el('p', { className: 'meta', textContent: t('kiosk.review.hidden') })] : []),
      ...(r.reply ? [el('div', { className: 'review-reply' }, el('strong', { textContent: t('kiosk.review.reply') }), el('p', { className: 'review-text', textContent: r.reply }))] : []),
      el('p', { className: 'meta', role: 'status', textContent: said }));
    return box;
  }
  const pick = { rating: 0, fit: i.fit ?? null }; // a task 23 answer given before reviews existed is kept as the default
  const chips = (label, options, key) => {
    const g = el('div', { className: 'size-chips', role: 'group', ariaLabel: label }, ...options.map(([v, text, aria]) => {
      const b = el('button', { type: 'button', className: 'chip', textContent: text });
      if (aria) b.ariaLabel = aria;
      b.setAttribute('aria-pressed', String(pick[key] === v));
      b.onclick = () => {
        pick[key] = v;
        for (const c of g.children) c.setAttribute('aria-pressed', String(c === b));
        err.textContent = '';
      };
      return b;
    }));
    return g;
  };
  const err = el('p', { className: 'field-error', role: 'alert' });
  const id = `rv${i.id}`;
  const area = el('textarea', { id, maxLength: 500, rows: 3 });
  const send = el('button', { type: 'button', className: 'primary', textContent: t('kiosk.review.send') });
  send.onclick = async () => {
    if (!pick.rating) return (err.textContent = t('kiosk.review.need_rating'));
    if (i.sized && !pick.fit) return (err.textContent = t('kiosk.review.need_fit'));
    send.disabled = true; // one submit; the server's unique line also keeps a double tap to one review
    try {
      const res = await fetch(`/api/orders/${token}/reviews`, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': getLang() },
        body: JSON.stringify({ item: i.id, rating: pick.rating, ...(i.sized && { fit: pick.fit }), text: area.value }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && data.code !== 'review_exists') throw new Error(data.error || t('common.error'));
      if (data.review) i.review = data.review;
      else return load(); // sent from another tab meanwhile: show what the server has
      box.replaceWith(reviewItem(i, t('kiosk.track.fit_thanks')));
    } catch (e) {
      err.textContent = e.message;
      send.disabled = false;
    }
  };
  box.append(
    el('div', { className: 'meta', textContent: t('field.rating') }),
    chips(t('kiosk.review.rating_aria', { name: productName(i) }), [1, 2, 3, 4, 5].map((n) => [n, `${n} ★`, t('kiosk.review.stars', { n })]), 'rating'),
    ...(i.sized ? [el('div', { className: 'meta', textContent: t('kiosk.review.fit_q') }),
      chips(t('kiosk.track.fit_aria', { name: productName(i) }), Object.entries(FIT).map(([v, k]) => [v, t(k)]), 'fit')] : []),
    el('label', { htmlFor: id, className: 'meta', textContent: t('kiosk.review.text_label') }), area, err, send);
  return box;
}

await load();
$('title').focus({ preventScroll: true });
if (location.hash === '#review') $('review')?.scrollIntoView(); // task 46: the mall order page's "rate" link
// Follow the order while it is still moving.
setInterval(() => { if (!document.hidden && order && !['delivered', 'cancelled'].includes(stageOf(order))) load(); }, REFRESH_MS);
