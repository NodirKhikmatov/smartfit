// Staff app (task 28): the shop floor's phone. One poll of GET /api/admin/staff every few seconds: fitting-room requests
// (accept → brought), paid orders to collect with a pick list by shelf, sizes running low and kiosks gone quiet.
// A new request rings and vibrates. Same login and token as admin; the staff role can reach only these routes.
import { t, fmt, initLang, langSwitch, getLang, productName, colorName } from '/shared/i18n.js';
import { icon, toast, confirmDialog } from '/shared/ui.js';

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
  if (!res.ok) throw Object.assign(new Error(body.error || t('common.error')), { status: res.status, code: body.code });
  return body;
}

async function show() {
  clearTimeout(timer);
  me = null;
  seen = null;
  if (store.get('sfToken')) { try { me = await call('/me'); } catch {} }
  $('login').hidden = !!me;
  $('app').hidden = !me;
  stopCam();
  current = detail = null;
  sessions = [];
  $('stockSession').hidden = $('sessionForm').hidden = true;
  $('stockHome').hidden = false;
  if (!me) return $('login').email.focus();
  renderStock();
  $('salesBody').replaceChildren(); // another person may have signed in
  if (tab === 'sales') loadSales();
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
    if (queue().length) flush(); // task 47: scans waiting since the network dropped
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
  if (tab === 'low') loadSessions();
  else stopCam();
  if (tab === 'sales') loadSales();
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
    el('p', { className: 'muted', textContent: [o.customer_name, t(o.fulfillment === 'pickup' ? 'adm.orders.pickup' : 'adm.orders.delivery'), o.instalment_months && t('adm.order.instalment_short', { n: o.instalment_months }), o.group_number && t('adm.order.mall_group', { n: o.group_number }), storeOf(o)].filter(Boolean).join(' · ') }),
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

// ---------- Task 50: "Mening sotuvlarim". Loaded when the tab opens or the period changes (not on every poll).
const PERIODS = { today: 'staff.sales.today', month: 'staff.sales.month', last_month: 'staff.sales.last_month' };
let salesPeriod = 'month', salesSeq = 0;
async function loadSales() {
  const seq = ++salesSeq;
  $('salesPeriod').replaceChildren(...Object.entries(PERIODS).map(([p, key]) => {
    const b = el('button', { type: 'button', className: 'chip', textContent: t(key), onclick: () => { salesPeriod = p; loadSales(); } });
    b.setAttribute('aria-pressed', String(p === salesPeriod));
    return b;
  }));
  $('salesError').textContent = '';
  let r;
  try { r = await call(`/me/sales?period=${salesPeriod}`); } catch (err) {
    if (seq === salesSeq) $('salesError').textContent = err.message;
    return;
  }
  if (seq !== salesSeq) return;
  const row = (label, value, sub, cls) => [el('dt', { textContent: label, className: cls || '' }), el('dd', { className: cls || '' }, value, sub && el('small', { textContent: sub }))];
  const range = r.from === r.to ? fmt.date(`${r.from}T12:00:00+05:00`) : `${fmt.date(`${r.from}T12:00:00+05:00`)} – ${fmt.date(`${r.to}T12:00:00+05:00`)}`;
  $('salesBody').replaceChildren(
    ...row(t('staff.sales.range'), range),
    ...row(t('staff.sales.orders'), String(r.orders)),
    ...row(t('staff.sales.sum'), fmt.som(r.sum)),
    ...row(t('staff.sales.returns'), t('staff.sales.units', { n: r.returns }), r.refunded ? `−${fmt.som(r.refunded)}` : null),
    ...row(t('staff.sales.commission'), fmt.som(r.commission), r.percent ? t('staff.sales.pct', { n: r.percent }) : t('staff.sales.off'), 'total'));
}

// ---------- Task 47: "Qabul qilish" (receiving) and "Inventarizatsiya" (a count), in the Ombor tab.
// Every session and scan gets an id made on this phone and goes through a queue kept in localStorage, sent in order;
// the server applies each id once, so a resend after a dropped connection is harmless. A scan the server refuses
// (unknown item, another store's label, a closed session) is shown here and dropped, never retried forever.
// The store's product list is cached per store, so codes can be looked up with no network.
const SCAN_FORMATS = ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf'];
const canScan = 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia); // needs HTTPS or localhost
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const loadJson = (k, d) => { try { return JSON.parse(store.get(k)) ?? d; } catch { return d; } };
const saveJson = (k, v) => store.set(k, JSON.stringify(v));
const qKey = () => `sfStockQueue:${me?.id}`, rKey = () => `sfStockRejected:${me?.id}`, cKey = (id) => `sfStockCatalog:${id}`;
const queue = () => (me ? loadJson(qKey(), []) : []);
let sessions = [], current = null, detail = null, catalog = null, picked = null, sending = false, cam = null, diffMode = false;
let unticked = new Set(); // diff lines the manager unticked; kept when the list re-renders after a sync

function enqueue(op) {
  saveJson(qKey(), [...queue(), op]);
  renderQueue();
  flush();
}
// Sends the queue in order. Offline, a 401, 429 or 5xx: stop and keep it (tried again on the next poll or `online`).
async function flush() {
  if (sending || !me) return;
  sending = true;
  let sent = 0;
  try {
    for (let op = queue()[0]; op; op = queue()[0]) {
      try {
        await call(op.path, { method: 'POST', body: op.body });
      } catch (err) {
        if (err.offline || !err.status || err.status === 401 || err.status === 429 || err.status >= 500) break;
        saveJson(rKey(), [...loadJson(rKey(), []), { id: op.body.key, label: op.label, error: err.message }]);
        toast(t('staff.stock.rejected_toast', { what: op.label }), { tone: 'danger' });
      }
      saveJson(qKey(), queue().filter((x) => x.body.key !== op.body.key));
      sent++;
    }
  } finally { sending = false; }
  renderQueue();
  if (sent) loadSessions();
}
window.addEventListener('online', () => flush());

function renderQueue() {
  const n = queue().length;
  $('queueNote').hidden = !n;
  $('queueNote').querySelector('span').textContent = t('staff.stock.queued', { n });
  const bad = me ? loadJson(rKey(), []) : [];
  $('rejectedList').replaceChildren(...bad.map((r) => el('div', { className: 'notice danger' }, icon('alert'),
    el('span', { className: 'grow' }, el('strong', { textContent: r.label }), el('br'), r.error),
    el('button', { type: 'button', textContent: t('staff.stock.dismiss'), onclick: () => { saveJson(rKey(), loadJson(rKey(), []).filter((x) => x.id !== r.id)); renderQueue(); } }))));
  if (current) renderSession();
}

const kindText = (k) => t(k === 'receive' ? 'staff.stock.receive' : 'staff.stock.count');
const scopeText = (s) => [s.category_id && catName(s.category_id), s.shelf && t('staff.stock.shelf', { shelf: s.shelf }), s.note].filter(Boolean).join(' · ');
const catName = (id) => { const c = catalog?.categories.find((x) => x.id === id); return c ? (getLang() === 'ru' ? c.name_ru : c.name) : ''; };
const nameOf = (p) => productName(p);

async function loadSessions() {
  try {
    sessions = (await call('/stock/sessions')).open;
  } catch { /* offline: the last list and the queue still show */ }
  if (current && !current.id) current.id = sessions.find((s) => s.key === current.key)?.id;
  renderStock();
  if (current?.id && !diffMode) loadDetail();
}
// Server sessions plus the ones still in the queue (made offline).
function allSessions() {
  const queued = queue().filter((o) => o.path === '/stock/sessions' && !sessions.some((s) => s.key === o.body.key)).map((o) => ({ ...o.body, queued: true, scans: 0, units: 0 }));
  return [...queued, ...sessions];
}

function renderStock() {
  if (!me) return;
  renderQueue();
  const list = allSessions();
  $('sessionList').replaceChildren(...list.map((s) => el('article', { className: 'card req' },
    el('header', {}, el('h3', { textContent: kindText(s.kind) }), el('span', { className: `badge ${s.queued ? 'warn' : 'ok'}`, textContent: s.queued ? t('staff.stock.not_sent') : t('staff.stock.open') })),
    el('p', { className: 'muted', textContent: [scopeText(s), many() && data?.stores.find((x) => x.id === s.store_id)?.name].filter(Boolean).join(' · ') || '—' }),
    !s.queued && el('p', { textContent: t('staff.stock.summary', { n: s.scans, units: s.units, who: s.created_email?.split('@')[0] ?? '—' }) }),
    el('div', { className: 'actions' }, el('button', { type: 'button', className: 'primary', textContent: t('staff.stock.continue'), onclick: () => openSession(s) })))));
  if (current) renderSession();
}

// ---- New session form
const sf = $('sessionForm');
let sfKind = 'receive';
async function openForm(kind) {
  sfKind = kind;
  sf.reset();
  $('sfError').textContent = '';
  $('sfTitle').textContent = kindText(kind);
  $('sfText').textContent = t(kind === 'receive' ? 'staff.stock.receive_text' : 'staff.stock.count_text');
  $('sfNoteHint').textContent = t(kind === 'receive' ? 'staff.stock.note_hint' : 'staff.stock.note_hint_count');
  for (const x of sf.querySelectorAll('[data-count]')) x.hidden = kind !== 'count';
  const stores = data?.stores ?? [];
  $('sfStoreWrap').hidden = stores.length < 2;
  sf.store.replaceChildren(...stores.map((s) => el('option', { value: s.id, textContent: s.name })));
  $('stockHome').hidden = true;
  sf.hidden = false;
  if (kind === 'count') await fillCats();
  (stores.length > 1 ? sf.store : kind === 'count' ? sf.category : sf.note).focus();
}
async function fillCats() {
  const c = await catalogFor(Number(sf.store.value));
  sf.category.replaceChildren(el('option', { value: '', textContent: t('staff.stock.any_cat') }),
    ...(c?.categories ?? []).map((x) => el('option', { value: x.id, textContent: getLang() === 'ru' ? x.name_ru : x.name })));
}
sf.store.onchange = () => sfKind === 'count' && fillCats();
$('newReceive').onclick = () => openForm('receive');
$('newCount').onclick = () => openForm('count');
$('sfCancel').onclick = () => { sf.hidden = true; $('stockHome').hidden = false; };
sf.onsubmit = (e) => {
  e.preventDefault();
  const category = sfKind === 'count' && sf.category.value ? Number(sf.category.value) : null;
  const shelf = sfKind === 'count' ? sf.shelf.value.trim() || null : null;
  if (sfKind === 'count' && !category && !shelf) { $('sfError').textContent = t('err.stock_scope'); return sf.category.focus(); }
  const body = { key: newId(), kind: sfKind, store_id: Number(sf.store.value) || data?.stores[0]?.id, note: sf.note.value.trim() || null, category_id: category, shelf };
  enqueue({ path: '/stock/sessions', body, label: kindText(sfKind) });
  sf.hidden = true;
  openSession(body);
};

// ---- One session: scan, the list, and (a count) the differences
async function catalogFor(storeId) {
  try {
    const c = await call(`/stock/catalog?store_id=${storeId}`);
    saveJson(cKey(storeId), c);
    return c;
  } catch { return loadJson(cKey(storeId), null); }
}
async function openSession(s) {
  current = { key: s.key, id: s.id ?? sessions.find((x) => x.key === s.key)?.id, kind: s.kind, store_id: s.store_id, note: s.note, category_id: s.category_id, shelf: s.shelf };
  detail = null;
  diffMode = false;
  catalog = loadJson(cKey(s.store_id), null);
  $('stockHome').hidden = true;
  sf.hidden = true;
  $('stockSession').hidden = false;
  resetScan();
  $('camBtn').hidden = !canScan;
  $('codeHint').textContent = t(canScan ? 'staff.stock.code_hint_cam' : 'staff.stock.code_hint');
  $('qtyHint').textContent = current.kind === 'count' ? t('staff.stock.qty_hint_count') : '';
  // Task 49: "kirim narxi" for a manager or owner receiving; staff never set or see a cost.
  $('costWrap').hidden = current.kind !== 'receive' || me?.role === 'staff';
  renderSession();
  $('scanForm').code.focus();
  catalog = (await catalogFor(s.store_id)) ?? catalog;
  if (current?.key === s.key) { renderSession(); if (current.id) loadDetail(); }
}
function closeSession() {
  stopCam();
  current = detail = null;
  $('stockSession').hidden = true;
  $('stockHome').hidden = false;
  loadSessions();
}
$('ssBack').onclick = () => (diffMode ? (diffMode = false, renderSession()) : closeSession());
async function loadDetail() {
  if (!current?.id) return;
  try {
    const d = await call(`/stock/sessions/${current.id}`);
    if (d.key === current.key) { detail = d; renderSession(); }
  } catch (err) {
    if (err.status === 404) closeSession(); // closed or confirmed meanwhile
  }
}

function resetScan() {
  const f = $('scanForm');
  f.code.value = '';
  f.qty.value = '1';
  f.cost.value = '';
  f.qty.min = current?.kind === 'count' ? -1000 : 1;
  f.qty.max = 1000;
  picked = null;
  $('scanPick').hidden = true;
  $('scanError').textContent = '';
  $('scanMatches').replaceChildren();
}
// A code is a garment's QR label link (/q/<store>/<product>), a SKU or a barcode; else a part of the name.
function lookup(code) {
  const c = code.trim();
  const m = c.match(/\/q\/(\d+)\/(\d+)(?:[/?#]|$)/);
  if (m) return Number(m[1]) !== current.store_id ? 'other' : catalog.products.filter((p) => p.id === Number(m[2]));
  const exact = catalog.products.filter((p) => p.sku?.toUpperCase() === c.toUpperCase() || p.barcode === c);
  if (exact.length || c.length < 3) return exact;
  const lc = c.toLowerCase();
  return catalog.products.filter((p) => p.name.toLowerCase().includes(lc) || p.name_ru?.toLowerCase().includes(lc)).slice(0, 6);
}
function find() {
  const code = $('scanForm').code.value;
  $('scanError').textContent = '';
  $('scanMatches').replaceChildren();
  $('scanPick').hidden = true;
  if (!code.trim()) return $('scanForm').code.focus();
  if (!catalog) { $('scanError').textContent = t('staff.stock.no_catalog'); return; }
  const found = lookup(code);
  if (found === 'other') $('scanError').textContent = t('staff.stock.other_store');
  else if (!found.length) $('scanError').textContent = t('staff.stock.not_found', { code: code.trim().slice(0, 60) });
  else if (found.length === 1) choose(found[0]);
  else $('scanMatches').replaceChildren(...found.map((p) => el('button', { type: 'button', className: 'match', textContent: [nameOf(p), p.sku].filter(Boolean).join(' · '), onclick: () => { $('scanMatches').replaceChildren(); choose(p); } })));
}
$('scanForm').onsubmit = (e) => { e.preventDefault(); find(); };
function choose(p) {
  picked = { p, size: p.sizes.length === 1 ? p.sizes[0] : null };
  $('pickName').textContent = [nameOf(p), p.sku, p.shelf_location].filter(Boolean).join(' · ');
  $('pickSizes').replaceChildren(...p.sizes.map((size) => {
    const b = el('button', { type: 'button', className: 'chip', textContent: sizeText(size) });
    b.setAttribute('aria-pressed', String(size === picked.size));
    b.onclick = () => { picked.size = size; for (const x of $('pickSizes').children) x.setAttribute('aria-pressed', String(x === b)); $('scanForm').qty.focus(); };
    return b;
  }));
  $('scanPick').hidden = false;
  ($('pickSizes').querySelector('[aria-pressed="false"]') && !picked.size ? $('pickSizes').firstElementChild : $('scanForm').qty).focus();
}
$('scanAdd').onclick = () => {
  const qty = Number($('scanForm').qty.value);
  const max = 1000, min = current.kind === 'count' ? -1000 : 1;
  if (!picked?.size) { $('scanError').textContent = t('staff.stock.pick_size'); return $('pickSizes').firstElementChild?.focus(); }
  if (!Number.isInteger(qty) || !qty || qty < min || qty > max) { $('scanError').textContent = t('staff.stock.bad_qty', { min, max }); return $('scanForm').qty.focus(); }
  const costText = $('costWrap').hidden ? '' : $('scanForm').cost.value.trim();
  const cost = costText === '' ? null : Number(costText);
  if (cost !== null && (!Number.isInteger(cost) || cost < 0 || cost > 1e9)) { $('scanError').textContent = t('staff.stock.bad_cost'); return $('scanForm').cost.focus(); }
  const label = `${nameOf(picked.p)} · ${sizeText(picked.size)} · ${qty > 0 && current.kind === 'count' ? '+' : ''}${qty}${cost === null ? '' : ` · ${fmt.som(cost)}`}`;
  enqueue({ path: '/stock/scans', session: current.key, body: { key: newId(), session: current.key, product_id: picked.p.id, size: picked.size, quantity: qty, ...(cost !== null && { cost }) }, label });
  toast(t('staff.stock.added', { what: label }));
  navigator.vibrate?.(40);
  resetScan();
  $('scanForm').code.focus();
};

// Camera: BarcodeDetector reads QR labels and barcodes; elsewhere the SKU is typed (the button stays hidden).
$('camBtn').onclick = () => (cam ? stopCam() : startCam());
async function startCam() {
  $('scanError').textContent = '';
  try {
    const formats = (await BarcodeDetector.getSupportedFormats()).filter((f) => SCAN_FORMATS.includes(f));
    const detector = new BarcodeDetector({ formats });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const v = $('camView');
    cam = { stream, timer: 0 };
    v.srcObject = stream;
    v.hidden = false;
    $('camBtn').setAttribute('aria-pressed', 'true');
    await v.play();
    const tick = async () => {
      if (!cam) return;
      try {
        const [hit] = await detector.detect(v);
        if (hit?.rawValue) {
          stopCam();
          navigator.vibrate?.(60);
          $('scanForm').code.value = hit.rawValue;
          return find();
        }
      } catch {}
      if (cam) cam.timer = setTimeout(tick, 250);
    };
    tick();
  } catch {
    stopCam();
    $('scanError').textContent = t('staff.stock.cam_error');
  }
}
function stopCam() {
  if (!cam) return;
  clearTimeout(cam.timer);
  cam.stream.getTracks().forEach((x) => x.stop());
  cam = null;
  $('camView').srcObject = null;
  $('camView').hidden = true;
  $('camBtn').setAttribute('aria-pressed', 'false');
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && stopCam());

function renderSession() {
  if (!current) return;
  $('ssTitle').textContent = kindText(current.kind);
  $('ssSub').textContent = scopeText(current) || t('staff.stock.no_note');
  $('scanForm').hidden = diffMode;
  const pending = queue().filter((o) => o.session === current.key);
  const waiting = pending.length || queue().some((o) => o.body.key === current.key);
  const row = (what, sub, num, cls = '') => el('li', { className: cls }, el('span', { className: 'what' }, el('strong', { textContent: what }), sub && el('small', { textContent: sub })), el('span', { className: 'num', textContent: num }));
  const pendingRows = pending.map((o) => {
    const p = catalog?.products.find((x) => x.id === o.body.product_id);
    return row(p ? nameOf(p) : '…', t('staff.stock.not_sent'), `${sizeText(o.body.size)} × ${o.body.quantity}`);
  });
  const body = [];
  if (diffMode && detail) body.push(...diffView(detail));
  else if (current.kind === 'receive') {
    const sent = (detail?.scans ?? []).map((x) => row(nameOf(x), `${x.admin_email?.split('@')[0] ?? ''} · ${fmt.time(x.created_at)}`, `${sizeText(x.size)} × ${x.quantity}`));
    body.push(el('section', { className: 'card stock-card' }, el('h3', { textContent: t('staff.stock.received', { n: (detail?.units ?? 0) }) }),
      pendingRows.length + sent.length ? el('ul', { className: 'lines plain-rows' }, ...pendingRows, ...sent) : el('p', { className: 'muted', textContent: t('staff.stock.empty_receive') })));
  } else {
    const counted = (detail?.lines ?? []).filter((l) => l.counted > 0).map((l) => row(nameOf(l), l.shelf_location, `${sizeText(l.size)} × ${l.counted}`));
    body.push(el('section', { className: 'card stock-card' }, el('h3', { textContent: t('staff.stock.counted_title') }),
      pendingRows.length + counted.length ? el('ul', { className: 'lines plain-rows' }, ...pendingRows, ...counted) : el('p', { className: 'muted', textContent: t('staff.stock.empty_count') })));
  }
  $('ssBody').replaceChildren(...body);
  const acts = [];
  if (waiting) acts.push(el('p', { className: 'hint', textContent: t('staff.stock.wait_send') }));
  else if (current.id && !diffMode) {
    if (current.kind === 'count') acts.push(el('button', { type: 'button', className: 'primary', textContent: t('staff.stock.show_diff'), onclick: async () => { await loadDetail(); unticked = new Set(); diffMode = true; renderSession(); } }));
    acts.push(el('button', { type: 'button', className: current.kind === 'count' ? 'danger ghost' : 'primary', textContent: t(current.kind === 'count' ? 'staff.stock.cancel_count' : 'staff.stock.finish'), onclick: finish }));
  }
  $('ssActions').replaceChildren(...acts);
}
async function finish() {
  const count = current.kind === 'count';
  if (count && !(await confirmDialog({ title: t('staff.stock.cancel_title'), text: t('staff.stock.cancel_text'), ok: t('staff.stock.cancel_count'), danger: true }))) return;
  try {
    await call(`/stock/sessions/${current.id}/close`, { method: 'POST' });
    toast(t(count ? 'staff.stock.cancelled' : 'staff.stock.finished'));
    closeSession();
  } catch (err) { toast(err.message, { tone: 'danger' }); loadDetail(); }
}

// The differences: stock now vs counted, per size. A manager ticks what to correct; a line under the reserved units
// can't be ticked (carts and unpaid orders hold them). Staff see the same list and wait for a manager.
function diffView(d) {
  const lines = d.lines.filter((l) => l.diff);
  const ticks = [];
  const items = lines.map((l) => {
    const k = `${l.product_id} ${l.size}`;
    const box = el('input', { type: 'checkbox', checked: !l.blocked && !unticked.has(k), disabled: !d.can_confirm || l.blocked });
    box.onchange = () => (box.checked ? unticked.delete(k) : unticked.add(k));
    box.setAttribute('aria-label', `${nameOf(l)} ${sizeText(l.size)}`);
    if (d.can_confirm && !l.blocked) ticks.push([box, l]);
    return el('li', {}, box,
      el('span', { className: 'what' }, el('strong', { textContent: `${nameOf(l)} · ${sizeText(l.size)}` }),
        el('small', { textContent: [l.shelf_location, t('staff.stock.diff_line', { q: l.quantity, c: l.counted })].filter(Boolean).join(' · ') }),
        l.blocked && el('span', { className: 'blocked', textContent: t('staff.stock.blocked', { n: l.reserved }) })),
      el('span', { className: `badge ${l.diff > 0 ? 'ok' : 'warn'}`, textContent: l.diff > 0 ? `+${l.diff}` : `−${-l.diff}` }));
  });
  const out = [el('section', { className: 'card stock-card' }, el('h3', { textContent: t('staff.stock.diff_title', { n: lines.length }) }),
    el('p', { className: 'muted', textContent: t('staff.stock.diff_text') }),
    lines.length ? el('ul', { className: 'lines' }, ...items) : el('p', { textContent: t('staff.stock.no_diff') }))];
  if (d.can_confirm) {
    const go = el('button', { type: 'button', className: 'primary', textContent: t('staff.stock.confirm') });
    go.onclick = async () => {
      go.disabled = true;
      try {
        const body = { lines: ticks.filter(([b]) => b.checked).map(([, l]) => ({ product_id: l.product_id, size: l.size, quantity: l.quantity })) };
        const r = await call(`/stock/sessions/${current.id}/confirm`, { method: 'POST', body });
        toast(t('staff.stock.confirmed', { n: r.applied }));
        closeSession();
      } catch (err) {
        toast(err.message, { tone: 'danger' });
        go.disabled = false;
        await loadDetail(); // the stock moved or a hold landed: show the numbers again
      }
    };
    out.push(el('div', { className: 'actions' }, go));
  } else out.push(el('p', { className: 'notice' }, icon('info'), el('span', { textContent: t('staff.stock.manager_confirms') })));
  return out;
}

initLang();
document.title = `${t('staff.title')} · Smart Fit`;
const switches = [langSwitch(() => relabel(), { short: true }), langSwitch(() => relabel())];
const relabel = () => { document.title = `${t('staff.title')} · Smart Fit`; switches.forEach((s) => s.sync()); render(); renderStock(); if (tab === 'sales') loadSales(); };
$('lang').replaceChildren(switches[0]);
$('loginLang').replaceChildren(switches[1]);
navigator.serviceWorker?.register('/staff/sw.js', { scope: '/staff/' }).catch(() => {}); // installable + offline shell; never a blocker
show();
