// Staff app (task 28): the shop floor's phone. One poll of GET /api/admin/staff every few seconds: fitting-room requests
// (accept → brought), paid orders to collect with a pick list by shelf, sizes running low and kiosks gone quiet.
// A new request rings and vibrates. Same login and token as admin; the staff role can reach only these routes.
import { t, fmt, initLang, langSwitch, getLang, productName, colorName } from '/shared/i18n.js';
import { icon, toast } from '/shared/ui.js';

export const POLL_MS = 5000;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null && k !== false));
  return n;
};
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
let me = null, data = null, seen = null, timer = 0, tab = 'fitting', audio = null;

async function call(path, opts = {}) {
  let res;
  try {
    res = await fetch('/api/admin' + path, {
      method: opts.method || 'GET',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + store.get('sfToken'), 'accept-language': getLang() },
      body: opts.body && JSON.stringify(opts.body),
    });
  } catch {
    throw Object.assign(new Error(t('adm.offline')), { offline: true });
  }
  if (res.status === 401 && path !== '/login') { store.set('sfToken', null); show(); throw new Error(t('adm.relogin')); }
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || t('common.error'));
  return body;
}

async function show() {
  clearTimeout(timer);
  me = null;
  seen = null;
  if (store.get('sfToken')) { try { me = await call('/me'); } catch {} }
  $('login').hidden = !!me;
  $('app').hidden = !me;
  if (!me) return $('login').email.focus();
  poll();
}

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('loginError').textContent = '';
  try {
    const r = await call('/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
    store.set('sfToken', r.token);
    f.password.value = '';
    show();
  } catch (err) { $('loginError').textContent = err.message; }
});
$('logout').onclick = () => { store.set('sfToken', null); show(); };

// ---------- Polling. Hidden tabs keep polling (a phone in a pocket should still ring); a returning tab polls at once.
async function poll() {
  clearTimeout(timer);
  if (!me) return;
  try {
    const d = await call('/staff');
    $('offline').hidden = true;
    ringOnNew(d);
    data = d;
    render();
  } catch (err) {
    if (!me) return;
    if (err.offline) $('offline').hidden = false;
    else toast(err.message, { tone: 'danger' });
  }
  if (me) timer = setTimeout(poll, POLL_MS);
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && me && poll());

// ---------- Sound and vibration. Browsers allow both only after a tap on the page, hence the one-time button.
const unlock = () => {
  if (!audio) try { audio = new AudioContext(); } catch {}
  audio?.resume?.();
  $('sound').hidden = true;
};
document.addEventListener('pointerdown', unlock, { capture: true, passive: true });
$('soundOn').onclick = () => { unlock(); ring(); };
function ring() {
  navigator.vibrate?.([200, 100, 200]);
  if (!audio) return;
  for (const at of [0, 0.3]) { // two short beeps
    const o = audio.createOscillator(), g = audio.createGain(), t0 = audio.currentTime + at;
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
    o.connect(g).connect(audio.destination);
    o.start(t0);
    o.stop(t0 + 0.26);
  }
}
// New since the last poll: a fitting request, or a paid order nobody has started. The first poll only remembers.
function ringOnNew(d) {
  const keys = [...d.fitting.map((f) => `f${f.id}`), ...d.orders.filter((o) => o.status === 'new').map((o) => `o${o.id}`)];
  const fresh = seen ? keys.filter((k) => !seen.has(k)) : [];
  seen = new Set(keys);
  if (!fresh.length) return;
  ring();
  toast(t(fresh.some((k) => k[0] === 'f') ? 'staff.new_fitting' : 'staff.new_order'));
}

// ---------- Tabs
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  render();
});

// ---------- Render. Re-drawn on every poll, so the focused button (by its data-key) gets focus back.
const many = () => (data?.stores.length ?? 0) > 1;
const storeOf = (x) => (many() ? x.store_name : null);
const waited = (iso) => fmt.countdown(Date.now() - Date.parse(iso)); // m:ss since then
const count = (id, n) => { $(id).hidden = !n; $(id).textContent = n; };

function render() {
  if (!data) return;
  const focused = document.activeElement?.dataset?.key;
  for (const b of $('tabs').querySelectorAll('[data-tab]')) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
  for (const s of document.querySelectorAll('[data-section]')) s.hidden = s.id !== tab;
  count('nFitting', data.fitting.length);
  count('nOrders', data.orders.length);
  count('nLow', data.low.total);
  $('kiosks').replaceChildren(...data.kiosks.map((k) => el('p', { className: 'notice danger' }, icon('alert'),
    el('span', { textContent: t('staff.kiosk_off', { name: t('adm.dash.kiosk_name', { id: k.id }), at: fmt.dateTime(k.last_seen_at) }) }))));
  $('fitList').replaceChildren(...(data.fitting.length ? data.fitting.map(fittingCard) : [empty('staff.fit.empty', 'staff.fit.empty_text')]));
  $('orderList').replaceChildren(...(data.orders.length ? data.orders.map(orderCard) : [empty('staff.orders.empty', 'staff.orders.empty_text')]));
  $('lowList').replaceChildren(data.low.items.length ? lowList(data.low) : empty('staff.low.empty', 'staff.low.empty_text'));
  $('statsBody').replaceChildren(...stats(data.stats));
  if (focused) document.querySelector(`[data-key="${focused}"]`)?.focus();
}

const empty = (title, text) => el('div', { className: 'empty' }, icon('check'), el('h3', { textContent: t(title) }), el('p', { textContent: t(text) }));
const sizeText = (s) => (s === 'ONE' ? t('common.size_one') : s);
const pick = (i) => el('li', {},
  el('span', { className: 'shelf', textContent: i.shelf_location || '—' }),
  el('span', { className: 'what' }, el('strong', { textContent: productName(i) }), el('span', { className: 'muted', textContent: ` · ${colorName(i.color)}` })),
  el('span', { className: 'size', textContent: i.quantity > 1 ? `${sizeText(i.size)} × ${i.quantity}` : sizeText(i.size) }));

function fittingCard(f) {
  const who = f.accepted_at && (f.mine ? t('staff.fit.mine') : t('staff.fit.taken', { who: f.accepted_email?.split('@')[0] ?? '—' }));
  return el('article', { className: `card req${f.mine ? ' mine' : ''}` },
    el('header', {}, el('h3', { textContent: t('adm.fit.cabin', { cabin: f.cabin }) }),
      el('span', { className: `badge ${f.accepted_at ? 'ok' : 'warn'}`, textContent: t('staff.waiting', { t: waited(f.created_at) }) })),
    storeOf(f) && el('p', { className: 'muted', textContent: storeOf(f) }),
    el('ul', { className: 'picks' }, ...f.items.map((i) => pick({ ...i, quantity: 1 }))),
    who && el('p', { className: 'muted who', textContent: who }),
    el('div', { className: 'actions' }, f.accepted_at
      ? act(`fd${f.id}`, t('adm.fit.done'), () => call(`/fitting/${f.id}/done`, { method: 'POST' }), t('staff.fit.done_toast', { cabin: f.cabin }), !f.mine)
      : act(`fa${f.id}`, t('staff.fit.accept'), () => call(`/fitting/${f.id}/accept`, { method: 'POST' }), t('staff.fit.accept_toast', { cabin: f.cabin }))));
}

// Labels for the server's allowed next steps: a pickup order's "delivered" is "handed to the customer".
const handed = (o, s) => s === 'delivered' && o.fulfillment === 'pickup';
const stepLabel = (o, s) => t(handed(o, s) ? 'adm.step.handed' : `adm.step.${s}`);
const statusLabel = (o, s) => t(handed(o, s) ? 'adm.status.handed' : `adm.status.${s}`);
function orderCard(o) {
  return el('article', { className: 'card req' },
    el('header', {}, el('h3', { textContent: `№ ${o.number}` }), el('span', { className: `badge ${o.status === 'new' ? 'warn' : 'ok'}`, textContent: t(`adm.status.${o.status}`) })),
    el('p', { className: 'muted', textContent: [o.customer_name, t(o.fulfillment === 'pickup' ? 'adm.orders.pickup' : 'adm.orders.delivery'), o.instalment_months && t('adm.order.instalment_short', { n: o.instalment_months }), storeOf(o)].filter(Boolean).join(' · ') }),
    el('ul', { className: 'picks' }, ...o.items.map(pick)),
    el('div', { className: 'actions' }, ...o.next.map((s, i) => act(`o${o.id}${s}`, stepLabel(o, s),
      () => call(`/orders/${o.id}/status`, { method: 'POST', body: { status: s } }), t('staff.order_toast', { n: o.number, status: statusLabel(o, s) }), i > 0))));
}

// One action button: disabled while it runs, then a toast and a fresh poll (also after a 409, to show who won).
function act(key, label, run, done, secondary = false) {
  const b = el('button', { type: 'button', className: secondary ? '' : 'primary', textContent: label });
  b.dataset.key = key;
  b.onclick = async () => {
    b.disabled = true;
    try {
      await run();
      toast(done);
    } catch (err) { toast(err.message, { tone: 'danger' }); }
    poll();
  };
  return b;
}

function lowList(low) {
  return el('div', { className: 'card' },
    el('ul', { className: 'picks low' }, ...low.items.map((i) => el('li', {},
      el('span', { className: 'shelf', textContent: i.shelf_location || '—' }),
      el('span', { className: 'what' }, el('strong', { textContent: productName(i) }), many() && el('span', { className: 'muted', textContent: ` · ${data.stores.find((s) => s.id === i.store_id)?.name ?? ''}` })),
      el('span', { className: 'size' }, `${sizeText(i.size)} `, el('span', { className: `badge ${i.free <= 0 ? 'danger' : 'warn'}`, textContent: i.free <= 0 ? t('staff.low.out') : t('staff.low.left', { n: i.free }) }))))),
    low.total > low.items.length && el('p', { className: 'muted', textContent: t('staff.low.more', { n: low.total - low.items.length }) }));
}

function stats(s) {
  const dur = (sec) => (sec == null ? '—' : fmt.countdown(sec * 1000));
  const line = (key, vars) => el('p', { textContent: t(key, vars) });
  return [
    line('staff.stats.count', { total: s.total, done: s.done }),
    line('staff.stats.speed', { accept: dur(s.accept_s), done: dur(s.done_s) }),
    s.by.length > 0 && el('ul', { className: 'plain' }, ...s.by.map((p) => el('li', { textContent: t('staff.stats.person', { who: p.email.split('@')[0], n: p.n, done: dur(p.done_s) }) }))),
    s.recent.length > 0 && el('h4', { textContent: t('staff.stats.recent') }),
    s.recent.length > 0 && el('ul', { className: 'plain muted' }, ...s.recent.map((r) => el('li', { textContent: t('staff.stats.recent_row', {
      cabin: r.cabin, who: r.email?.split('@')[0] ?? '—', done: dur(r.done_s), at: fmt.time(r.done_at) }) }))),
  ].filter(Boolean);
}

initLang();
document.title = `${t('staff.title')} · Smart Fit`;
const switches = [langSwitch(() => relabel(), { short: true }), langSwitch(() => relabel())];
const relabel = () => { document.title = `${t('staff.title')} · Smart Fit`; switches.forEach((s) => s.sync()); render(); };
$('lang').replaceChildren(switches[0]);
$('loginLang').replaceChildren(switches[1]);
navigator.serviceWorker?.register('/staff/sw.js', { scope: '/staff/' }).catch(() => {}); // installable + offline shell; never a blocker
show();
