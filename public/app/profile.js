// Task 27: the customer's profile page (/profile/<token>, linked only from their own Telegram bot chat).
// Shows the numbers kept (never a photo), saved looks, orders in this organisation, and "delete my data".
import { icon, confirmDialog } from '/shared/ui.js';
import { t, fmt, initLang, getLang, langSwitch, productName } from '/shared/i18n.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const token = location.pathname.split('/').pop();
let profile = null, error = '';

initLang();
$('langBox').replaceChildren(langSwitch(() => render(), { short: true }));

async function call(method = 'GET', path = '') {
  const res = await fetch(`/api/profile/me/${token}${path}`, { method, headers: { 'accept-language': getLang() } });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || t('common.error'));
  return data;
}
async function load() {
  try {
    profile = await call();
  } catch (err) {
    error = err.message;
  }
  render();
}

const row = (label, value, className = '') => el('div', { className }, el('span', { textContent: label }), el('span', { textContent: value }));
const none = () => t('kiosk.profile.none');
const sizeName = (s) => (s === 'ONE' ? t('common.size_one') : s);
const stage = (o) => (o.status === 'cancelled' ? t('kiosk.profile.cancelled')
  : o.status === 'new' ? t(`kiosk.track.step.${o.payment_status === 'paid' ? 'paid' : 'placed'}`)
    : t(`kiosk.track.step.${o.status === 'delivered' && o.fulfillment === 'pickup' ? 'handed' : o.status}`));

function render() {
  if (!profile) return $('body').replaceChildren(el('div', { className: 'empty' }, icon('user'), el('p', { textContent: error })));
  const p = profile;
  $('storeName').textContent = p.organization || 'Smart Fit';
  $('org').textContent = p.organization;
  const n = (v, key) => (v != null ? t(key, { n: v }) : none());
  $('body').replaceChildren(
    el('section', { className: 'sum card' }, el('h2', { textContent: t('kiosk.profile.contact') }),
      row(p.name ?? none(), p.phone)),
    el('section', { className: 'sum card' }, el('h2', { textContent: t('kiosk.profile.sizes') }),
      row(t('kiosk.profile.gender'), p.gender ? t(`gender.${p.gender}`) : none()),
      row(t('kiosk.profile.height'), n(p.height, 'kiosk.profile.cm')),
      row(t('kiosk.profile.weight'), n(p.weight, 'kiosk.profile.kg')),
      row(t('cat.top'), p.top ?? none()), row(t('cat.bottom'), p.bottom ?? none()), row(t('cat.shoes'), p.shoes ?? none()),
      row(t('kiosk.profile.shoulder'), n(p.shoulder, 'kiosk.profile.cm')),
      row(t('kiosk.profile.hip'), n(p.hip, 'kiosk.profile.cm')),
      // Task 29: the no-photo ways, shown only when the customer used them.
      ...(p.fit ? [row(t('kiosk.size.fit'), t(`kiosk.size.fit_${p.fit}`))] : []),
      ...(p.jeans ? [row(t('kiosk.size.jeans'), `W${p.jeans}`)] : []),
      ...['chest', 'waist', 'hips'].filter((k) => p[k] != null).map((k) => row(t(`kiosk.size.${k}`), n(p[k], 'kiosk.profile.cm')))),
    // Task 34: cashback balance and history, only when the organisation has points (or had, and rows are left).
    ...(p.points ? [el('section', { className: 'sum card' }, el('h2', { textContent: t('kiosk.points.title') }),
      row(t('kiosk.points.balance_label'), fmt.som(p.points.balance), 'grand'),
      ...(p.points.next ? [el('p', { className: 'meta', textContent: t('kiosk.points.next', { date: fmt.date(p.points.next.at), sum: fmt.som(p.points.next.amount) }) })] : []),
      ...(p.points.percent ? [el('p', { className: 'meta', textContent: t('kiosk.points.rule', { pct: p.points.percent }) })] : []),
      ...(p.points.expiry_months ? [el('p', { className: 'meta', textContent: t('kiosk.points.expiry_rule', { n: p.points.expiry_months }) })] : []),
      ...(p.points.history.length ? p.points.history.map((h) => row([t(`kiosk.points.kind.${h.kind}`), h.number && `№ ${h.number}`, h.note, fmt.dateTime(h.created_at)].filter(Boolean).join(' · '),
        `${h.amount > 0 ? '+' : '−'}${fmt.som(Math.abs(h.amount))}`, h.amount > 0 ? 'off' : '')) // green = points received
        : [el('p', { className: 'muted', textContent: t('kiosk.points.history_none') })]))] : []),
    el('section', { className: 'sum card' }, el('h2', { textContent: t('kiosk.profile.looks') }),
      ...(p.looks.length ? p.looks.flatMap((l) => [
        el('p', { className: 'meta', textContent: `${l.store.name} · ${fmt.dateTime(l.created_at)}` }),
        ...l.items.map((i) => row(i.in_stock ? productName(i) : `${productName(i)} · ${t('kiosk.profile.sold_out')}`, fmt.som(i.unit_price), i.in_stock ? '' : 'muted')),
      ]) : [el('p', { className: 'muted', textContent: t('kiosk.profile.looks_none') })])),
    // Task 31: sizes waited for ("Kelganda xabar bering"); each can be cancelled.
    el('section', { className: 'card alerts' }, el('h2', { textContent: t('kiosk.profile.alerts') }),
      ...(p.alerts.length ? [el('ul', { className: 'alert-list' }, ...p.alerts.map((a) => el('li', {},
        el('span', {}, el('strong', { textContent: productName(a) }), el('span', { className: 'meta', textContent: `${sizeName(a.size)} · ${a.store_name} · ${fmt.dateTime(a.created_at)}` })),
        el('button', { type: 'button', className: 'secondary', ariaLabel: t('kiosk.profile.alert_cancel_aria', { name: productName(a), size: sizeName(a.size) }), onclick: (e) => cancel(a, e.currentTarget) },
          t('kiosk.profile.alert_cancel')))))] : [el('p', { className: 'muted', textContent: t('kiosk.profile.alerts_none') })])),
    el('section', { className: 'card' }, el('h2', { textContent: t('kiosk.profile.orders') }),
      ...(p.orders.length ? [el('ul', { className: 'store-list' }, ...p.orders.map((o) => el('li', {},
        el(o.url ? 'a' : 'div', { className: 'button store-link', ...(o.url && { href: o.url }) }, icon('receipt'),
          el('span', {}, el('strong', { textContent: `№ ${o.number} · ${o.store_name}` }), el('span', { className: 'meta', textContent: `${fmt.dateTime(o.created_at)} · ${fmt.som(o.total)} · ${stage(o)}` })),
          ...(o.url ? [icon('chevron-right')] : [])))))] : [el('p', { className: 'muted', textContent: t('kiosk.profile.orders_none') })])),
    el('p', { className: 'meta', textContent: t('kiosk.profile.consent_at', { date: fmt.dateTime(p.consent_at) }) }),
    el('button', { type: 'button', className: 'danger wide', onclick: remove }, icon('trash'), el('span', { textContent: t('kiosk.profile.delete') })),
  );
}

async function cancel(a, btn) {
  btn.disabled = true;
  try {
    await call('DELETE', `/alerts/${a.id}`);
  } catch (err) {
    btn.disabled = false;
    return $('body').prepend(el('p', { className: 'error', role: 'alert', textContent: err.message }));
  }
  profile.alerts = profile.alerts.filter((x) => x !== a);
  render();
}

async function remove() {
  if (!(await confirmDialog({ title: t('kiosk.profile.delete_title'), text: t('kiosk.profile.delete_text'), ok: t('kiosk.profile.delete'), cancel: t('common.cancel'), danger: true }))) return;
  try {
    await call('DELETE');
  } catch (err) {
    return $('body').prepend(el('p', { className: 'error', role: 'alert', textContent: err.message }));
  }
  profile = null;
  error = t('kiosk.profile.deleted');
  render();
}

await load();
$('title').focus({ preventScroll: true });
