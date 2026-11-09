// Smart Fit admin: sidebar shell with hash routes (#/dashboard, #/orders, #/cashier, #/products, #/stats, #/qr, #/settings).
// Filters, sort and page live in the hash, so a refresh or a shared link opens the same view.
import { icon, toast, confirmDialog, showAfter } from '/shared/ui.js';
import { t, fmt, initLang, getLang, langSwitch, productName } from '/shared/i18n.js';
import { parseHash, buildHash, offsetOf, pageInfo, delta, share, compact, stockLevel } from './util.js';
import { lineChart, funnelChart } from './charts.js';

const CATEGORIES = ['outerwear', 'top', 'bottom', 'shoes', 'accessory'];
const STATUSES = ['new', 'packing', 'shipping', 'delivered', 'cancelled'];
const SIZES = { shoes: ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'], accessory: ['ONE'] };
const sizesFor = (c) => SIZES[c] || ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const LIMIT = 25;
const LOW_LEFT = 1; // same as src/admin/routes.js
const TZ = 'Asia/Tashkent';
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k != null && k !== false));
  return e;
};
const cat = (c) => (c ? t(`cat.${c}`) : '—');
const som = (n) => fmt.num(n); // bare number where the column names the currency
const money = (n) => fmt.som(n);
const short = (n) => compact(n, { k: t('adm.unit.k'), m: t('adm.unit.m') });
const dec = (n) => String(n).replace('.', ','); // 9.1 → 9,1 (uz and ru)
const day = (key) => `${key.slice(8, 10)}.${key.slice(5, 7)}`; // 2026-11-10 → 10.11
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)])).toString();
let me = null, stores = [], scope = '', editing = null, route = parseHash(location.hash);
const loads = {}; // per page: the newest request wins, a slower older answer is dropped

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
const token = () => store.get('sfToken');

async function call(path, opts = {}) {
  let res;
  try {
    res = await fetch('/api/admin' + path, {
      method: opts.method || 'GET',
      headers: { 'content-type': opts.type || 'application/json', authorization: 'Bearer ' + token(), 'accept-language': getLang() },
      body: opts.raw ?? (opts.body && JSON.stringify(opts.body)),
    });
  } catch {
    throw new Error(t('adm.offline')); // the browser's own text ("Failed to fetch") is English and says nothing useful
  }
  if (res.status === 401 && path !== '/login') { store.set('sfToken', null); show(); throw new Error(t('adm.relogin')); }
  if (opts.blob && res.ok) return res.blob();
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || t('common.error')), { data });
  return data;
}
// A super-admin's store picker (sidebar) narrows every list and chart; a manager is pinned to their store by the server.
const scoped = (params) => (me?.role === 'super' && scope ? { ...params, store_id: scope } : params);
const storeName = (id) => stores.find((s) => s.id === id)?.name || '';
const showStore = () => me?.role === 'super' && !scope;

// ---------- Small building blocks

// Error box with a retry button; empty call clears it.
function stateBox(box, err, retry) {
  box.replaceChildren(...(err ? [el('div', { className: 'notice danger', role: 'alert' }, icon('alert'),
    el('div', {}, el('p', { textContent: err.message }), retry && el('button', { type: 'button', onclick: retry }, icon('refresh'), t('adm.retry'))))] : []));
}
// Skeleton rows, only if the request takes longer than 200 ms (fast loads don't flash).
function skeletonRows(tbody, cols, n = 6) {
  return showAfter(200, () => tbody.replaceChildren(...Array.from({ length: n }, () => el('tr', { className: 'skel-row', ariaHidden: 'true' },
    ...Array.from({ length: cols }, () => el('td', {}, el('span', { className: 'skeleton line' })))))));
}
function emptyState({ ic, title, text, action }) {
  return el('div', { className: 'empty' }, icon(ic), el('h3', { textContent: title }), text && el('p', { textContent: text }), action);
}
const emptyRow = (tbody, cols, opts) => tbody.replaceChildren(el('tr', { className: 'empty-tr' }, el('td', { colSpan: cols }, emptyState(opts))));
// Pressed-state button group; value strings.
function seg(box, options, current, onPick) {
  box.replaceChildren(...options.map(([value, label]) => {
    const b = el('button', { type: 'button', className: 'chip', textContent: label, onclick: () => value !== current && onPick(value) });
    b.setAttribute('aria-pressed', String(value === current));
    return b;
  }));
}
function pager(nav, r, go) {
  const p = pageInfo(r);
  nav.hidden = r.total <= r.limit;
  if (nav.hidden) return nav.replaceChildren();
  const btn = (dir, enabled, page) => {
    const b = el('button', { type: 'button', className: 'icon-btn', disabled: !enabled, title: t(dir === 'prev' ? 'adm.page_prev' : 'adm.page_next'), onclick: () => go(page) }, icon(dir === 'prev' ? 'chevron-left' : 'chevron-right'));
    b.setAttribute('aria-label', b.title);
    return b;
  };
  nav.replaceChildren(el('span', { className: 'muted num', textContent: t('adm.page_of', { from: p.from, to: p.to, total: r.total }) }), btn('prev', p.prev, p.page - 1), btn('next', p.next, p.page + 1));
}
function deltaBadge(d, unit = '%') {
  if (d == null) return null;
  const dir = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  return el('span', { className: `delta ${dir}` }, icon(dir === 'up' ? 'trend-up' : dir === 'down' ? 'trend-down' : 'minus'), `${d > 0 ? '+' : ''}${dec(d)}${unit}`);
}
function kpi({ label, value, suffix, d, unit, sub, href, exact }) {
  return el(href ? 'a' : 'div', { className: 'kpi card', ...(href && { href }), ...(exact && { title: exact }) },
    el('span', { className: 'kpi-label', textContent: label }),
    el('strong', { className: 'kpi-value num' }, el('span', { textContent: value }), suffix && el('small', { className: 'kpi-unit', textContent: suffix })),
    el('span', { className: 'kpi-foot' }, deltaBadge(d, unit), sub && el('span', { className: 'muted', textContent: sub })));
}
const kpiSkeleton = (n) => Array.from({ length: n }, () => el('div', { className: 'kpi card', ariaHidden: 'true' },
  el('span', { className: 'skeleton line short' }), el('span', { className: 'skeleton block' })));
const thumb = (p) => (p.image_url ? el('img', { className: 'thumb', src: p.image_url, alt: '', loading: 'lazy' }) : el('span', { className: 'thumb ph' }, icon(p.category || 'hanger')));
// Stock per size as small heat cells: size + free units, red when sold out, amber when running out.
function heat(stock) {
  return el('span', { className: 'heat' }, ...stock.map((s) => {
    const free = s.quantity - s.reserved;
    return el('span', { className: `cell l${stockLevel(free, LOW_LEFT)}`, title: t('adm.products.cell', { size: s.size === 'ONE' ? t('common.size_one') : s.size, n: free }) },
      s.size === 'ONE' ? null : el('span', { textContent: s.size }), el('b', { textContent: free }));
  }));
}
function setParams(params) {
  route.params = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null));
  history.replaceState(null, '', buildHash(route.route, route.params));
  PAGES[route.route].load();
}
async function download(path, name) {
  try {
    const blob = await call(path, { blob: true });
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) { toast(err.message, { tone: 'danger' }); }
}
// Prints from an off-screen iframe (no popup to block). Content goes in as text nodes; the QR SVG is generated by our server.
function printFrame(title, css, fill) {
  $('printFrame')?.remove();
  const frame = el('iframe', { id: 'printFrame', title, className: 'print-frame' });
  document.body.append(frame);
  const d = frame.contentDocument;
  d.title = title;
  d.head.append(Object.assign(d.createElement('style'), { textContent: css }));
  const mk = (tag, props = {}, ...kids) => {
    const e = Object.assign(d.createElement(tag), props);
    e.append(...kids.filter((k) => k != null));
    return e;
  };
  fill(d.body, mk);
  frame.contentWindow.focus();
  frame.contentWindow.print();
}

// ---------- Sign-in and shell

initLang();
$('loginLang').replaceChildren(langSwitch(() => location.reload()));
$('menuLang').replaceChildren(langSwitch(() => location.reload(), { short: true }));
$('setLang').replaceChildren(langSwitch(() => location.reload()));
for (const v of CATEGORIES) {
  $('productFilters').category.append(el('option', { value: v, textContent: cat(v) }));
  $('form').category.append(el('option', { value: v, textContent: cat(v) }));
}

async function show() {
  me = null;
  if (token()) { try { me = await call('/me'); } catch {} }
  $('login').hidden = !!me;
  $('app').hidden = !me;
  if (!me) return;
  stores = await call('/stores');
  const sup = me.role === 'super';
  scope = sup && stores.some((s) => String(s.id) === store.get('sfAdminStore')) ? store.get('sfAdminStore') : '';
  $('scope').replaceChildren(el('option', { value: '', textContent: t('adm.all_stores') }), ...stores.map((s) => el('option', { value: s.id, textContent: s.name })));
  $('scope').value = scope;
  $('scopeWrap').hidden = !sup;
  $('scopeName').hidden = sup;
  $('scopeName').querySelector('span').textContent = stores[0]?.name || '';
  $('userEmail').textContent = me.email;
  $('userRole').textContent = sup ? t('adm.super') : t('adm.manager');
  $('avatar').textContent = me.email[0].toUpperCase();
  $('storeWrap').hidden = !sup;
  $('form').store_id.replaceChildren(...stores.map((s) => el('option', { value: s.id, textContent: s.name })));
  render();
  pollBadge();
}

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  try {
    const f = e.target;
    const r = await call('/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
    store.set('sfToken', r.token);
    f.password.value = '';
    show();
  } catch (err) { $('loginError').textContent = err.message; }
});
$('logout').onclick = () => { $('userMenu').hidePopover?.(); store.set('sfToken', null); show(); };
$('scope').onchange = (e) => {
  scope = e.target.value;
  store.set('sfAdminStore', scope || null);
  if (route.params.page) delete route.params.page;
  setParams(route.params);
};
// Popover menu: arrow keys move between its items; it closes on Esc and outside clicks by itself.
$('userMenu').addEventListener('toggle', (e) => {
  $('userBtn').setAttribute('aria-expanded', String(e.newState === 'open'));
  if (e.newState === 'open') $('userMenu').querySelector('button, a')?.focus();
});
$('userMenu').addEventListener('click', (e) => e.target.closest('a') && $('userMenu').hidePopover());

// Phone and tablet: the sidebar moves into a modal drawer (focus trap and Esc come with <dialog>).
$('menuBtn').onclick = () => {
  $('navDrawer').append($('sideInner'));
  $('navDrawer').showModal();
};
// Cleanup runs directly too: some browsers skip the 'close' event after a scripted close(); the event covers Esc.
const drawerBack = () => $('sidebar').append($('sideInner'));
$('navDrawer').addEventListener('close', drawerBack);
$('navDrawer').addEventListener('click', (e) => {
  if (e.target !== $('navDrawer') && !e.target.closest('a')) return;
  $('navDrawer').close();
  drawerBack();
});

const PAGES = {
  dashboard: { title: 'adm.route.dashboard', load: loadDashboard, poll: () => loadDashboard(true) },
  orders: { title: 'adm.route.orders', load: loadOrders, poll: () => loadOrders(true) },
  cashier: { title: 'adm.route.cashier', load: loadCashier, poll: () => loadPending(true) },
  products: { title: 'adm.route.products', load: loadProducts },
  stats: { title: 'adm.route.stats', load: loadStats },
  qr: { title: 'adm.route.qr', load: loadQr },
  settings: { title: 'adm.route.settings', load: loadSettings },
};
const ACTIONS = {
  orders: [el('button', { type: 'button', className: 'icon-btn', title: t('adm.export'), ariaLabel: t('adm.export'), onclick: () => exportOrders() }, icon('download'))],
  products: [
    el('button', { type: 'button', onclick: () => openImport() }, icon('upload'), el('span', { className: 'label', textContent: t('adm.products.import') })),
    el('button', { type: 'button', className: 'primary', onclick: () => openForm(null) }, icon('plus'), el('span', { className: 'label', textContent: t('adm.products.add') })),
  ],
  stats: [el('button', { type: 'button', className: 'icon-btn', title: t('adm.export'), ariaLabel: t('adm.export'), onclick: () => exportStats() }, icon('download'))],
};

function render() {
  route = parseHash(location.hash);
  const name = route.route;
  for (const s of document.querySelectorAll('[data-page]')) s.hidden = s.dataset.page !== name;
  for (const a of document.querySelectorAll('#nav a')) a.dataset.route === name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  const title = t(PAGES[name].title);
  $('pageTitle').textContent = title;
  document.title = `${title} · Smart Fit`;
  $('topActions').replaceChildren(...(ACTIONS[name] || []));
  if (name === 'orders') markSeen();
  PAGES[name].load();
}
// The skip link's #main is not a route: move focus without touching the hash.
document.querySelector('.skip').onclick = (e) => {
  e.preventDefault();
  $('main').focus();
};
window.addEventListener('hashchange', () => {
  if (!me) return;
  render();
  $('main').focus({ preventScroll: true });
  scrollTo(0, 0);
});

// Unseen-orders badge: orders that came in after the newest one this admin saw on this device.
// shortcut: "seen" is per device (localStorage); a per-admin column would sync it across devices.
const seenKey = () => `sfSeenOrder:${me.id}`;
let latestOrder = 0;
async function pollBadge() {
  try {
    const since = Number(store.get(seenKey())) || 0;
    const r = await call(`/orders/unseen?since=${since}`);
    latestOrder = r.latest;
    if (!since || route.route === 'orders') store.set(seenKey(), String(r.latest)); // first visit: nothing is "new"
    const n = !since || route.route === 'orders' ? 0 : r.count;
    $('ordersBadge').hidden = !n;
    $('ordersBadge').textContent = n > 99 ? '99+' : n;
    $('ordersBadge').title = t('adm.unseen', { n });
    document.title = `${n ? `(${n}) ` : ''}${t(PAGES[route.route].title)} · Smart Fit`;
  } catch {}
}
function markSeen() {
  if (latestOrder) store.set(seenKey(), String(latestOrder));
  $('ordersBadge').hidden = true;
}

// One timer for every countdown on screen (cashier list, order drawer): deadlines are local clock + server pay_ms.
setInterval(() => {
  for (const node of document.querySelectorAll('[data-deadline]')) {
    const left = Number(node.dataset.deadline) - Date.now();
    node.textContent = fmt.countdown(left);
    node.classList.toggle('late', left < 2 * 60 * 1000);
  }
}, 1000);
const countdown = (ms) => el('span', { className: `countdown num${ms < 120000 ? ' late' : ''}`, textContent: fmt.countdown(ms) });
function deadline(ms) {
  const c = countdown(ms);
  c.dataset.deadline = String(Date.now() + ms);
  return c;
}
// Background refresh while the page is open and nothing is being edited.
setInterval(() => {
  if (!me || document.hidden) return;
  pollBadge();
  const busy = document.querySelector('dialog[open]') || document.activeElement?.closest('table, .pending, .toolbar, .chart-frame');
  if (!busy) PAGES[route.route].poll?.();
}, 15000);

// ---------- Dashboard

async function loadDashboard(quiet) {
  const seq = (loads.dashboard = (loads.dashboard || 0) + 1);
  const p = route.params;
  const days = p.days === '30' ? 30 : 7;
  const metric = p.metric === 'recs' ? 'recs' : 'revenue';
  seg($('dashDays'), [['7', t('adm.stats.days', { n: 7 })], ['30', t('adm.stats.days', { n: 30 })]], String(days), (v) => setParams({ ...p, days: v === '7' ? '' : v }));
  seg($('dashMetric'), [['revenue', t('adm.dash.revenue')], ['recs', t('adm.dash.recs')]], metric, (v) => setParams({ ...p, metric: v === 'revenue' ? '' : v }));
  $('dashDate').textContent = t('adm.dash.today', { date: new Date().toLocaleDateString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }) });
  const stop = quiet ? () => {} : showAfter(200, () => $('kpis').replaceChildren(...kpiSkeleton(5)));
  let d, s;
  try {
    [d, s] = await Promise.all([call('/dashboard?' + qs(scoped({ days }))), call('/stats?' + qs(scoped({ days })))]);
  } catch (err) {
    stop();
    if (seq === loads.dashboard) stateBox($('dashError'), err, () => loadDashboard());
    return;
  }
  stop();
  if (seq !== loads.dashboard) return;
  stateBox($('dashError'));
  const conv = share(s.pilot.bought, s.pilot.shown), convPrev = share(s.prev.pilot.bought, s.prev.pilot.shown);
  $('kpis').replaceChildren(
    kpi({ label: t('adm.dash.k_revenue'), value: short(d.today.revenue), suffix: t('common.som'), exact: money(d.today.revenue), d: delta(d.today.revenue, d.today.prev.revenue), sub: t('adm.dash.yesterday', { v: money(d.today.prev.revenue) }) }),
    kpi({ label: t('adm.dash.k_waiting'), value: String(d.waiting.total), sub: t('adm.dash.unpaid', { n: d.waiting.unpaid }), href: '#/orders' }),
    kpi({ label: t('adm.dash.k_paid'), value: String(d.today.paid), d: delta(d.today.paid, d.today.prev.paid), sub: t('adm.dash.yesterday', { v: d.today.prev.paid }) }),
    kpi({ label: t('adm.dash.k_recs'), value: String(d.today.recs), d: delta(d.today.recs, d.today.prev.recs), sub: t('adm.dash.yesterday', { v: d.today.prev.recs }) }),
    kpi({ label: t('adm.dash.k_conv', { n: days }), value: conv == null ? '—' : `${dec(conv)}%`, d: conv != null && convPrev != null ? Math.round((conv - convPrev) * 10) / 10 : null, unit: ` ${t('adm.pp')}`, sub: t('adm.dash.conv_sub', { bought: s.pilot.bought, shown: s.pilot.shown }) }),
  );
  drawTrend($('dashChart'), $('dashChartTitle'), $('dashChartSub'), s, metric);
  $('dashFunnelSub').textContent = t('adm.stats.days', { n: days });
  drawFunnel($('dashFunnel'), s.pilot);
  $('dashTopSub').textContent = t('adm.stats.days', { n: days });
  $('dashTop').replaceChildren(...(d.top_sold.length ? d.top_sold.map((x) => el('li', {},
    thumb(x),
    el('span', { className: 'rank-name' }, el('strong', { textContent: x.name ? productName(x) : t('adm.stats.deleted', { id: x.product_id }) }), el('span', { className: 'muted', textContent: cat(x.category) })),
    el('span', { className: 'rank-num num' }, el('strong', { textContent: t('adm.dash.units', { n: x.units }) }), el('span', { className: 'muted', textContent: short(x.revenue) })))) :
    [el('li', { className: 'li-empty' }, emptyState({ ic: 'bag', title: t('adm.dash.top_empty'), text: t('adm.dash.top_empty_text') }))]));
  $('dashLowSub').textContent = t('adm.dash.low_sub', { n: d.low_stock.total });
  $('dashLowAll').hidden = !d.low_stock.total;
  $('dashLow').replaceChildren(...(d.low_stock.items.length ? d.low_stock.items.map((x) => el('li', {},
    thumb(x),
    el('span', { className: 'rank-name' }, el('strong', { textContent: productName(x) }), el('span', { className: 'muted', textContent: [x.sku, showStore() && storeName(x.store_id)].filter(Boolean).join(' · ') })),
    heat(x.stock),
    el('button', { type: 'button', className: 'icon-btn ghost', title: t('adm.products.edit'), ariaLabel: t('adm.products.edit_aria', { name: productName(x) }), onclick: () => openForm(x) }, icon('edit')))) :
    [el('li', { className: 'li-empty' }, emptyState({ ic: 'check', title: t('adm.dash.low_empty'), text: t('adm.dash.low_empty_text') }))]));
}

// Line chart of revenue or recommendations per day, with the period total and its change against the previous period.
function drawTrend(box, title, sub, s, metric) {
  const rev = metric === 'revenue';
  title.textContent = t(rev ? 'adm.dash.revenue_chart' : 'adm.dash.recs_chart');
  const total = rev ? s.pilot.revenue : s.total, prev = rev ? s.prev.pilot.revenue : s.prev.total;
  const d = deltaBadge(delta(total, prev));
  sub.replaceChildren(el('strong', { className: 'num', textContent: rev ? money(total) : t('adm.dash.recs_n', { n: total }) }), ...(d ? [d, el('span', { className: 'muted', textContent: t('adm.dash.vs_prev', { n: s.days }) })] : []));
  const points = s.per_day.map((p) => ({ label: day(p.day), value: rev ? p.revenue : p.count }));
  if (!points.some((p) => p.value)) {
    box.classList.remove('chart');
    box.chartObserver?.disconnect();
    return box.replaceChildren(emptyState({ ic: 'chart', title: t(rev ? 'adm.dash.top_empty' : 'adm.stats.empty_title'), text: t(rev ? 'adm.dash.revenue_empty' : 'adm.stats.empty_text') }));
  }
  lineChart(box, points, { label: title.textContent, format: rev ? money : (v) => t('adm.dash.recs_n', { n: v }), tick: short });
}
function drawFunnel(box, f) {
  if (!f.shown) return box.replaceChildren(emptyState({ ic: 'sparkle', title: t('adm.stats.empty_title'), text: t('adm.stats.empty_text') }));
  funnelChart(box, [
    { label: t('adm.stats.shown'), value: f.shown }, { label: t('adm.stats.accepted'), value: f.accepted },
    { label: t('adm.stats.tried'), value: f.tried }, { label: t('adm.stats.bought'), value: f.bought },
  ], { pct: (v, base) => (base ? `${dec(share(v, base))}%` : '—') });
}

// ---------- Orders

const pay = (o) => t(`adm.pay.${o.payment_status}`);
const handed = (o, s) => s === 'delivered' && o.fulfillment === 'pickup'; // a pickup order is handed over, not delivered
const statusName = (o) => t(handed(o, o.status) ? 'adm.status.handed' : `adm.status.${o.status}`);
const stepName = (o, s) => t(handed(o, s) ? 'adm.step.handed' : `adm.step.${s}`);
const badge = (o) => el('span', { className: 'badge ' + ({ new: 'warn', packing: 'accent', shipping: 'accent', delivered: 'ok', cancelled: 'off' }[o.status] || ''), textContent: statusName(o) });
const payBadge = (o) => el('span', { className: `badge ${o.payment_status === 'paid' ? 'ok' : o.payment_status === 'pending' ? 'warn' : 'off'}`, textContent: pay(o) });
const orderFilters = () => ({ status: route.params.status, q: route.params.q, from: route.params.from, to: route.params.to });

const of = $('ordersFilters');
let qTimer;
of.q.oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(() => setParams({ ...route.params, q: of.q.value.trim(), page: '' }), 300); };
of.from.onchange = of.to.onchange = () => setParams({ ...route.params, from: of.from.value, to: of.to.value, page: '' });
of.onsubmit = (e) => e.preventDefault();

async function loadOrders(quiet) {
  const seq = (loads.orders = (loads.orders || 0) + 1);
  const p = route.params;
  seg($('ordersTabs'), [['', t('common.all')], ...STATUSES.map((s) => [s, t(`adm.status.${s}`)])], p.status || '', (v) => setParams({ ...p, status: v, page: '' }));
  for (const k of ['q', 'from', 'to']) if (document.activeElement !== of[k]) of[k].value = p[k] || '';
  const stop = quiet ? () => {} : skeletonRows($('orderRows'), 7);
  loadFitting();
  try {
    const r = await call('/orders?' + qs(scoped({ ...orderFilters(), limit: LIMIT, offset: offsetOf(p.page, LIMIT) })));
    stop();
    if (seq !== loads.orders) return;
    stateBox($('ordersError'));
    const filtered = Object.values(orderFilters()).some(Boolean);
    if (!r.items.length) {
      emptyRow($('orderRows'), 7, filtered
        ? { ic: 'search', title: t('adm.orders.none'), text: t('adm.orders.none_text'), action: el('button', { type: 'button', onclick: () => setParams({}) }, t('adm.clear')) }
        : { ic: 'receipt', title: t('adm.orders.empty_title'), text: t('adm.orders.empty') });
    } else {
      $('orderRows').replaceChildren(...r.items.map((o) => el('tr', { tabIndex: 0, id: `order-${o.id}`, onclick: () => openOrder(o.id), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openOrder(o.id)) },
        el('td', {}, el('strong', { className: 'num', textContent: `№ ${o.number}` })),
        el('td', { className: 'num nowrap hide-sm', textContent: fmt.dateTime(o.created_at) }),
        el('td', {}, o.customer_name, el('div', { className: 'sizes hide-sm', textContent: [o.phone, showStore() && o.store_name].filter(Boolean).join(' · ') }),
          el('div', { className: 'sizes show-sm', textContent: fmt.dateTime(o.created_at) })),
        el('td', { className: 'hide-sm', textContent: t(o.fulfillment === 'pickup' ? 'adm.orders.pickup' : 'adm.orders.delivery') }),
        el('td', { className: 'num', textContent: som(o.total) }),
        el('td', { className: 'hide-sm' }, payBadge(o)),
        el('td', {}, badge(o)))));
    }
    pager($('ordersPager'), r, (page) => { setParams({ ...p, page: page > 1 ? page : '' }); scrollTo(0, 0); });
  } catch (err) {
    stop();
    if (seq !== loads.orders) return;
    stateBox($('ordersError'), err, () => loadOrders());
    if (!quiet) { $('orderRows').replaceChildren(); $('ordersPager').hidden = true; }
  }
}
function exportOrders() {
  download('/orders/export?' + qs(scoped(orderFilters())), `orders-${new Date().toLocaleDateString('sv-SE', { timeZone: TZ })}.csv`);
}

// Fitting-room requests (task 17): bring these sizes to this cabin, then tick it off.
async function loadFitting() {
  let list;
  try { list = await call('/fitting'); } catch { return; } // the orders table shows any connection error
  list = scope ? list.filter((f) => String(f.store_id) === scope) : list;
  $('fitting').hidden = !list.length;
  $('fittingList').replaceChildren(...list.map((f) => el('li', {},
    el('div', {}, el('strong', { textContent: t('adm.fit.cabin', { cabin: f.cabin }) }), el('span', { className: 'sizes', textContent: ` · ${fmt.time(f.created_at)}${showStore() ? ' · ' + f.store_name : ''}` }),
      el('div', { className: 'sizes', textContent: f.items.map((i) => `${productName(i)} — ${i.size === 'ONE' ? t('common.size_one') : i.size}${i.shelf_location ? ` (${i.shelf_location})` : ''}`).join(', ') })),
    el('button', { type: 'button', onclick: async () => {
      try { await call(`/fitting/${f.id}/done`, { method: 'POST' }); loadFitting(); } catch (err) { toast(err.message, { tone: 'danger' }); }
    } }, icon('check'), t('adm.fit.done')))));
}

// Order drawer: details, one button per allowed next status (the server decides which), cashier payment and receipt.
let openId = null;
async function openOrder(id) {
  $('orderError').textContent = '';
  try {
    renderOrder(await call('/orders/' + id));
    openId = id;
    if (!$('orderDlg').open) $('orderDlg').showModal();
  } catch (err) { toast(err.message, { tone: 'danger' }); }
}
$('orderClose').onclick = () => { $('orderDlg').close(); orderClosed(); };
// Re-rendered buttons drop the focus. It goes to the heading (which now reads the new status), not to the next step,
// so a double Enter can't move the order two steps.
const keepFocus = () => $('orderTitle').focus();
// The list may have been redrawn meanwhile, so focus goes back to this order's row by id, not to the old element.
function orderClosed() {
  if (openId == null) return;
  const row = $(`order-${openId}`);
  openId = null;
  row?.focus();
}
$('orderDlg').addEventListener('close', orderClosed);

function itemsList(o) {
  return el('ul', { className: 'lines' }, ...o.items.map((i) => el('li', {},
    el('span', {}, el('strong', { textContent: productName(i) }), el('span', { className: 'muted', textContent: [i.size === 'ONE' ? t('common.size_one') : i.size, i.shelf_location].filter(Boolean).join(' · ') })),
    el('span', { className: 'num' }, `${i.quantity} × ${som(i.unit_price)}`, el('strong', { textContent: som(i.quantity * i.unit_price) })))));
}
function totalsBlock(o) {
  return el('dl', { className: 'totals' },
    el('dt', { textContent: t('adm.receipt.subtotal') }), el('dd', { className: 'num', textContent: money(o.subtotal) }),
    el('dt', { textContent: t('adm.receipt.fee') }), el('dd', { className: 'num', textContent: money(o.delivery_fee) }),
    el('dt', { className: 'total', textContent: t('adm.receipt.total') }), el('dd', { className: 'num total', textContent: money(o.total) }));
}
const method = (o) => (o.payment_method === 'cashier' ? t('adm.order.cashier') : { click: 'Click', payme: 'Payme' }[o.payment_method] || o.payment_method);
function renderOrder(o) {
  $('orderTitle').replaceChildren(t('adm.order.title', { id: o.number }), ' ', badge(o));
  const fact = (k, ...v) => [el('dt', { textContent: t(k) }), el('dd', {}, ...v)];
  $('orderInfo').replaceChildren(
    ...(o.status === 'cancelled' && o.payment_status === 'paid' ? [el('div', { className: 'notice warn' }, icon('alert'), el('p', { textContent: t('adm.order.refund') }))] : []),
    el('dl', { className: 'facts' },
      ...fact('adm.orders.time', fmt.dateTime(o.created_at)),
      ...(showStore() ? fact('common.store', storeName(o.store_id)) : []),
      ...fact('adm.orders.customer', o.customer_name),
      ...fact('adm.csv.phone', el('a', { href: `tel:${o.phone}`, textContent: o.phone })),
      ...fact('adm.orders.fulfillment', o.fulfillment === 'pickup' ? t('adm.orders.pickup') : t('adm.order.delivery_to', { address: o.address })),
      ...fact('adm.orders.payment', payBadge(o), ` ${method(o)}`, ...(o.payment_status === 'pending' && o.expires_at ? [' · ', deadline(Math.max(0, Date.parse(o.expires_at) - Date.now()))] : [])),
      ...fact('adm.order.tg', t(o.telegram ? 'adm.order.tg_on' : 'adm.order.tg_off'))),
    el('h3', { textContent: t('adm.order.items') }), itemsList(o), totalsBlock(o));
  $('orderActions').replaceChildren(
    ...(o.payment_status === 'pending' ? [el('button', { type: 'button', className: 'primary', onclick: (e) => markPaid(o, e.currentTarget) }, icon('cash'), t('adm.paydlg.confirm'))] : []),
    ...o.next.map((s) => el('button', { type: 'button', className: s === 'cancelled' ? 'danger' : 'primary', textContent: stepName(o, s), onclick: (e) => setStatus(o, s, e.currentTarget) })),
    ...(o.payment_status === 'paid' ? [el('button', { type: 'button', onclick: () => printReceipt(o) }, icon('print'), t('adm.receipt.print'))] : []));
}
async function setStatus(o, s, btn) {
  if (s === 'cancelled' && !(await confirmDialog({ title: t('adm.order.cancel_title', { id: o.number }), text: t(o.payment_status === 'paid' ? 'adm.order.cancel_paid' : 'adm.order.cancel_unpaid'), ok: t('adm.step.cancelled'), cancel: t('common.back'), danger: true }))) return;
  $('orderError').textContent = '';
  btn.disabled = true;
  try {
    const next = await call(`/orders/${o.id}/status`, { method: 'POST', body: { status: s } });
    renderOrder(next);
    keepFocus();
    toast(t('adm.order.changed', { id: o.number, status: statusName(next) }));
    refreshAfterOrder();
  } catch (err) {
    $('orderError').textContent = err.message;
    btn.disabled = false;
  }
}
async function markPaid(o, btn, out = $('orderError')) {
  out.textContent = '';
  btn.disabled = true;
  try {
    const next = await call(`/orders/${o.id}/pay`, { method: 'POST' });
    toast(t('adm.paydlg.done', { id: o.number }));
    if (openId === o.id) { renderOrder(next); keepFocus(); }
    if (route.route === 'cashier') renderPay(next);
    refreshAfterOrder();
  } catch (err) {
    out.textContent = err.message;
    btn.disabled = false;
  }
}
const refreshAfterOrder = () => (route.route === 'orders' ? loadOrders(true) : route.route === 'cashier' ? loadPending(true) : null);

// 80 mm thermal receipt. Not a fiscal receipt: the store's online cash register still issues that.
const RECEIPT_CSS = '@page{size:80mm auto;margin:4mm}body{font:12px/1.4 system-ui,sans-serif;width:72mm;margin:0;color:black}h1{font-size:16px;margin:0 0 2px;text-align:center}'
  + 'p{margin:0 0 6px;text-align:center}table{width:100%;border-collapse:collapse}td{padding:3px 0;vertical-align:top}td:last-child{text-align:right;white-space:nowrap}'
  + '.sum td{border-top:1px dashed gray}.big td{font-size:15px;font-weight:700}small{color:gray}';
function printReceipt(o) {
  printFrame(t('adm.receipt.doc', { id: o.number }), RECEIPT_CSS, (body, mk) => body.append(
    mk('h1', { textContent: storeName(o.store_id) || 'Smart Fit' }),
    mk('p', { textContent: `${t('adm.order.title', { id: o.number })} · ${fmt.dateTime(o.paid_at || o.created_at)}` }),
    mk('table', {}, ...o.items.map((i) => mk('tr', {},
      mk('td', {}, productName(i), mk('br'), mk('small', { textContent: `${i.size === 'ONE' ? t('common.size_one') : i.size} · ${i.quantity} × ${som(i.unit_price)}` })),
      mk('td', { textContent: som(i.quantity * i.unit_price) }))),
    mk('tr', { className: 'sum' }, mk('td', { textContent: t('adm.receipt.subtotal') }), mk('td', { textContent: som(o.subtotal) })),
    mk('tr', {}, mk('td', { textContent: t('adm.receipt.fee') }), mk('td', { textContent: som(o.delivery_fee) })),
    mk('tr', { className: 'big' }, mk('td', { textContent: t('adm.receipt.total') }), mk('td', { textContent: money(o.total) }))),
    mk('p', { textContent: `${pay(o)} · ${method(o)}` }),
    mk('p', {}, mk('small', { textContent: t('adm.receipt.note') })),
    mk('p', { textContent: t('adm.receipt.thanks') }),
  ));
}

// ---------- Cashier: orders waiting for payment (soonest to expire first), lookup by number, mark paid, receipt.

let payOrder = null;
function loadCashier() {
  renderPay(payOrder);
  loadPending();
}
async function loadPending(quiet) {
  const seq = (loads.cashier = (loads.cashier || 0) + 1);
  const stop = quiet ? () => {} : showAfter(200, () => $('pendingList').replaceChildren(...Array.from({ length: 3 }, () => el('li', { className: 'skel', ariaHidden: 'true' }, el('span', { className: 'skeleton block' })))));
  try {
    const r = await call('/orders?' + qs(scoped({ payment: 'pending', status: 'new', dir: 'asc', limit: 50 })));
    stop();
    if (seq !== loads.cashier) return;
    stateBox($('cashError'));
    $('pendingCount').textContent = r.total;
    $('pendingList').replaceChildren(...(r.items.length ? r.items.map((o) => el('li', {}, el('button', { type: 'button', id: `pay-${o.id}`, className: `pending-item${payOrder?.id === o.id ? ' on' : ''}`, onclick: () => selectPay(o.id) },
      el('strong', { className: 'pending-no num', textContent: `№ ${o.number}` }),
      el('span', { className: 'pending-who' }, el('span', { textContent: o.customer_name }), el('span', { className: 'muted', textContent: [t(o.fulfillment === 'pickup' ? 'adm.orders.pickup' : 'adm.orders.delivery'), showStore() && o.store_name].filter(Boolean).join(' · ') })),
      el('span', { className: 'pending-sum' }, el('strong', { className: 'num', textContent: som(o.total) }), deadline(o.pay_ms ?? 0))))) :
      [el('li', { className: 'li-empty' }, emptyState({ ic: 'cash', title: t('adm.cash.none'), text: t('adm.cash.none_text') }))]));
  } catch (err) {
    stop();
    if (seq === loads.cashier) stateBox($('cashError'), err, () => loadPending());
  }
}
async function selectPay(id) {
  $('payFindError').textContent = '';
  try {
    renderPay(await call('/orders/' + id));
    if (matchMedia('(max-width: 63.99em)').matches) $('payPanel').scrollIntoView({ block: 'start' }); // one column: the panel is below the list
  } catch (err) { $('payFindError').textContent = err.message; }
}
function renderPay(o) {
  payOrder = o;
  for (const b of document.querySelectorAll('.pending-item')) b.classList.toggle('on', b.id === `pay-${o?.id}`);
  const panel = $('payPanel');
  if (!o) return panel.replaceChildren(emptyState({ ic: 'cash', title: t('adm.cash.pick'), text: t('adm.cash.pick_text') }));
  const err = el('p', { className: 'error', role: 'alert' });
  panel.replaceChildren(
    el('div', { className: 'pay-head' }, el('h2', { textContent: t('adm.order.title', { id: o.number }) }), payBadge(o),
      o.payment_status === 'pending' && o.expires_at ? deadline(Math.max(0, Date.parse(o.expires_at) - Date.now())) : null),
    el('p', { className: 'muted', textContent: [o.customer_name, o.phone, o.fulfillment === 'pickup' ? t('adm.orders.pickup') : t('adm.order.delivery_to', { address: o.address })].join(' · ') }),
    itemsList(o), totalsBlock(o), err,
    el('div', { className: 'actions' },
      o.payment_status === 'pending' ? el('button', { type: 'button', className: 'primary', onclick: (e) => markPaid(o, e.currentTarget, err) }, icon('cash'), t('adm.paydlg.confirm')) : null,
      o.payment_status === 'paid' ? el('button', { type: 'button', className: 'primary', onclick: () => printReceipt(o) }, icon('print'), t('adm.receipt.print')) : null,
      el('button', { type: 'button', onclick: () => openOrder(o.id) }, t('adm.cash.details'))));
}
$('payFind').onsubmit = async (e) => {
  e.preventDefault();
  $('payFindError').textContent = '';
  const no = Number($('payFind').no.value);
  try {
    // Customers say the per-store display number; a super-admin may find it in several stores and picks one.
    const found = (await call('/orders?' + qs(scoped({ number: no, limit: 10 })))).items;
    if (!found.length) throw new Error(t('err.order_not_found'));
    if (found.length === 1) return renderPay(await call('/orders/' + found[0].id));
    $('payPanel').replaceChildren(el('h2', { textContent: t('adm.paydlg.pick') }), el('div', { className: 'actions start' }, ...found.map((o) =>
      el('button', { type: 'button', textContent: `№ ${o.number} · ${o.store_name}`, onclick: () => selectPay(o.id) }))));
  } catch (err) { $('payFindError').textContent = err.message; }
};

// ---------- Products

const PRODUCT_TABS = [['', 'common.all'], ['low', 'adm.products.f_low'], ['out', 'adm.products.f_out'], ['no_image', 'adm.products.f_noimg']];
const SORTABLE = { name: 'adm.products.name', price: 'adm.products.price', stock: 'adm.products.stock' };
const pf = $('productFilters');
let pqTimer;
pf.q.oninput = () => { clearTimeout(pqTimer); pqTimer = setTimeout(() => setParams({ ...route.params, q: pf.q.value.trim(), page: '' }), 300); };
pf.category.onchange = () => setParams({ ...route.params, category: pf.category.value, page: '' });
pf.onsubmit = (e) => e.preventDefault();

function productHead() {
  const p = route.params, sort = p.sort || 'created', dir = p.dir || (sort === 'name' ? 'asc' : 'desc');
  const th = (key, label, cls = '') => {
    if (!SORTABLE[key]) return el('th', { className: cls, textContent: label });
    const on = sort === key;
    const cell = el('th', { className: cls }, el('button', { type: 'button', className: 'sort', onclick: () => setParams({ ...p, sort: key, dir: on ? (dir === 'asc' ? 'desc' : 'asc') : '', page: '' }) }, label, icon(on ? 'chevron-down' : 'sort')));
    cell.setAttribute('aria-sort', on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
    if (on && dir === 'asc') cell.classList.add('asc');
    return cell;
  };
  $('productHead').replaceChildren(th('name', t('adm.products.name')), th('cat', t('adm.products.category'), 'hide-sm'), ...(showStore() ? [th('store', t('common.store'), 'hide-sm')] : []),
    th('price', t('adm.products.price'), 'num hide-sm'), th('stock', t('adm.products.stock')), el('th', { className: 'hide-sm' }, el('span', { className: 'visually-hidden', textContent: t('adm.actions') })));
}

async function loadProducts() {
  const seq = (loads.products = (loads.products || 0) + 1);
  const p = route.params;
  seg($('productTabs'), PRODUCT_TABS.map(([v, k]) => [v, t(k)]), p.filter || '', (v) => setParams({ ...p, filter: v, page: '' }));
  if (document.activeElement !== pf.q) pf.q.value = p.q || '';
  pf.category.value = p.category || '';
  productHead();
  const cols = showStore() ? 6 : 5;
  const stop = skeletonRows($('rows'), cols);
  try {
    const r = await call('/products?' + qs(scoped({ q: p.q, category: p.category, filter: p.filter, sort: p.sort, dir: p.dir, limit: LIMIT, offset: offsetOf(p.page, LIMIT) })));
    stop();
    if (seq !== loads.products) return;
    stateBox($('listError'));
    if (!r.items.length) {
      const filtered = p.q || p.category || p.filter;
      emptyRow($('rows'), cols, filtered
        ? { ic: 'search', title: t('adm.products.none'), text: t('adm.products.none_text'), action: el('button', { type: 'button', onclick: () => setParams({}) }, t('adm.clear')) }
        : { ic: 'hanger', title: t('adm.products.empty_title'), text: t('adm.products.empty'), action: el('button', { type: 'button', className: 'primary', onclick: () => openForm(null) }, icon('plus'), t('adm.products.add')) });
    } else {
      const price = (x) => (x.discount_price ? el('span', { className: 'price sale' }, som(x.discount_price), el('s', { textContent: som(x.price) })) : el('span', { className: 'price', textContent: som(x.price) }));
      // The name opens the editor (on phones it is the only way in: the price moves under it and the action column hides).
      $('rows').replaceChildren(...r.items.map((x) => el('tr', {},
        el('td', {}, el('span', { className: 'prod' }, thumb(x), el('span', {},
          el('button', { type: 'button', className: 'name-btn', textContent: productName(x), onclick: () => openForm(x) }),
          el('span', { className: 'sizes' }, x.sku || '', x.image_url ? null : el('span', { className: 'badge warn', textContent: t('adm.products.no_image') })),
          el('span', { className: 'show-sm' }, price(x))))),
        el('td', { className: 'hide-sm', textContent: cat(x.category) }),
        ...(showStore() ? [el('td', { className: 'hide-sm', textContent: storeName(x.store_id) })] : []),
        el('td', { className: 'num hide-sm' }, price(x)),
        el('td', {}, heat(x.stock)),
        el('td', { className: 'row-actions hide-sm' },
          el('button', { type: 'button', className: 'icon-btn ghost', title: t('adm.products.edit'), ariaLabel: t('adm.products.edit_aria', { name: productName(x) }), onclick: () => openForm(x) }, icon('edit')),
          el('button', { type: 'button', className: 'icon-btn ghost danger', title: t('common.delete'), ariaLabel: t('adm.products.delete_aria', { name: productName(x) }), onclick: () => remove(x) }, icon('trash'))))));
    }
    pager($('productsPager'), r, (page) => { setParams({ ...p, page: page > 1 ? page : '' }); scrollTo(0, 0); });
  } catch (err) {
    stop();
    if (seq !== loads.products) return;
    stateBox($('listError'), err, () => loadProducts());
    $('rows').replaceChildren();
    $('productsPager').hidden = true;
  }
}
const reloadProducts = () => (route.route === 'products' ? loadProducts() : route.route === 'dashboard' ? loadDashboard(true) : null);

function renderStock(category, stock = []) {
  $('stock').replaceChildren(...sizesFor(category).map((size) => {
    const row = stock.find((s) => s.size === size);
    const input = el('input', { type: 'number', min: row?.reserved || 0, step: 1, value: row?.quantity ?? 0 });
    input.dataset.size = size;
    return el('label', { textContent: size }, input);
  }));
}
function openForm(p) {
  editing = p;
  const f = $('form');
  f.reset();
  $('formError').textContent = '';
  $('formTitle').textContent = t(p ? 'adm.form.edit' : 'adm.form.new');
  for (const k of ['name', 'name_ru', 'category', 'gender', 'color', 'style', 'price', 'discount_price', 'temp_min', 'temp_max', 'shelf_location']) f[k].value = p?.[k] ?? '';
  if (!p) { f.category.value = 'top'; f.gender.value = 'unisex'; }
  f.waterproof.checked = !!p?.waterproof;
  f.store_id.value = p?.store_id ?? (scope || stores[0]?.id || '');
  f.store_id.disabled = !!p;
  renderStock(f.category.value, p?.stock);
  $('imgWrap').hidden = !p;
  $('formDelete').hidden = !p;
  $('imgError').textContent = '';
  $('imgFile').value = '';
  showImage(p?.image_url);
  $('dlg').showModal();
}
$('form').category.onchange = (e) => renderStock(e.target.value, editing?.stock);
$('cancel').onclick = () => $('dlg').close();
$('formDelete').onclick = async () => { if (await remove(editing)) $('dlg').close(); };
$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const num = (v) => (v === '' ? null : Number(v));
  const body = {
    name: f.name.value, name_ru: f.name_ru.value || null, category: f.category.value, gender: f.gender.value, color: f.color.value,
    style: f.style.value || null, price: num(f.price.value), discount_price: num(f.discount_price.value),
    temp_min: num(f.temp_min.value), temp_max: num(f.temp_max.value), waterproof: f.waterproof.checked,
    shelf_location: f.shelf_location.value || null,
    stock: Object.fromEntries([...$('stock').querySelectorAll('input')].map((i) => [i.dataset.size, num(i.value) ?? 0])),
  };
  if (!editing && me.role === 'super') body.store_id = Number(f.store_id.value);
  $('save').disabled = true;
  try {
    await call(editing ? '/products/' + editing.id : '/products', { method: editing ? 'PATCH' : 'POST', body });
    $('dlg').close();
    toast(t(editing ? 'adm.form.saved' : 'adm.form.added'));
    reloadProducts();
  } catch (err) { $('formError').textContent = err.message; } finally { $('save').disabled = false; }
});
function showImage(url) {
  $('imgPreview').hidden = !url;
  $('imgRemove').hidden = !url;
  if (url) $('imgPreview').src = url;
}
$('imgUpload').onclick = async () => {
  const file = $('imgFile').files[0];
  $('imgError').textContent = '';
  if (!file) { $('imgError').textContent = t('adm.form.image_pick'); return; }
  if (file.size > 2 * 1024 * 1024) { $('imgError').textContent = t('adm.form.image_big'); return; }
  try {
    const r = await call('/products/' + editing.id + '/image', { method: 'POST', raw: file, type: file.type || 'application/octet-stream' });
    editing.image_url = r.image_url;
    showImage(r.image_url);
    $('imgFile').value = '';
    reloadProducts();
  } catch (err) { $('imgError').textContent = err.message; }
};
$('imgRemove').onclick = async () => {
  try {
    await call('/products/' + editing.id + '/image', { method: 'DELETE' });
    editing.image_url = null;
    showImage(null);
    reloadProducts();
  } catch (err) { $('imgError').textContent = err.message; }
};
// true when the product is gone.
async function remove(p) {
  if (!(await confirmDialog({ title: t('adm.products.delete_title', { name: productName(p) }), text: t('adm.products.delete_text'), ok: t('common.delete'), danger: true }))) return false;
  try {
    await call('/products/' + p.id, { method: 'DELETE' });
    reloadProducts();
    toast(t('adm.products.deleted'));
    return true;
  } catch (err) {
    toast(err.message, { tone: 'danger' });
    return false;
  }
}

$('importCols').textContent = 'id, store_id, name, name_ru, category, gender, color, style, price, discount_price, temp_min, temp_max, waterproof, shelf_location, XS, S, M, L, XL, XXL, 36 … 45, ONE';
function openImport() {
  $('importForm').reset();
  $('importError').textContent = '';
  $('importErrors').replaceChildren();
  $('importDlg').showModal();
}
$('importCancel').onclick = () => $('importDlg').close();
$('importForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('importError').textContent = '';
  $('importErrors').replaceChildren();
  const file = e.target.file.files[0];
  if (!file) return;
  try {
    const r = await call('/products/import', { method: 'POST', raw: await file.text(), type: 'text/csv' });
    $('importDlg').close();
    toast(t('adm.import.done', { created: r.created, updated: r.updated }));
    reloadProducts();
  } catch (err) {
    $('importError').textContent = err.message;
    $('importErrors').replaceChildren(...(err.data?.errors || []).map((x) => el('li', { textContent: t('adm.import.line', { line: x.line, error: x.error }) })));
  }
});

// ---------- Stats: period KPIs with deltas, trend, funnel, most-suggested items, CSV of the days.

let lastStats = null;
async function loadStats() {
  const seq = (loads.stats = (loads.stats || 0) + 1);
  const p = route.params;
  const days = ['7', '90'].includes(p.days) ? Number(p.days) : 30;
  const metric = p.metric === 'revenue' ? 'revenue' : 'recs';
  seg($('statsDays'), [7, 30, 90].map((n) => [String(n), t('adm.stats.days', { n })]), String(days), (v) => setParams({ ...p, days: v === '30' ? '' : v }));
  seg($('statsMetric'), [['recs', t('adm.dash.recs')], ['revenue', t('adm.dash.revenue')]], metric, (v) => setParams({ ...p, metric: v === 'recs' ? '' : v }));
  const stop = showAfter(200, () => $('statsKpis').replaceChildren(...kpiSkeleton(6)));
  let s;
  try { s = await call('/stats?' + qs(scoped({ days }))); } catch (err) {
    stop();
    if (seq === loads.stats) stateBox($('statsError'), err, () => loadStats());
    return;
  }
  stop();
  if (seq !== loads.stats) return;
  lastStats = s;
  stateBox($('statsError'));
  $('statsRange').textContent = t('adm.stats.range', { from: day(s.per_day[0].day), to: day(s.per_day.at(-1).day), n: s.days });
  const f = s.pilot, pf0 = s.prev.pilot;
  const vs = t('adm.dash.vs_prev', { n: s.days });
  const k = (label, cur, prev, money) => kpi({ label: t(label), value: money ? short(cur) : String(cur), suffix: money && t('common.som'), exact: money && fmt.som(cur), d: delta(cur, prev), sub: delta(cur, prev) == null ? null : vs });
  $('statsKpis').replaceChildren(
    k('adm.stats.shown', f.shown, pf0.shown), k('adm.stats.accepted', f.accepted, pf0.accepted), k('adm.stats.tried', f.tried, pf0.tried),
    k('adm.stats.bought', f.bought, pf0.bought), k('adm.dash.revenue', f.revenue, pf0.revenue, true), k('adm.stats.avg', f.avg_order, pf0.avg_order, true));
  drawTrend($('statsChart'), $('statsChartTitle'), $('statsChartSub'), s, metric);
  $('dayRows').replaceChildren(...s.per_day.slice().reverse().map((d) => el('tr', {},
    el('td', { textContent: d.day }), el('td', { className: 'num', textContent: d.count }), el('td', { className: 'num', textContent: d.orders }), el('td', { className: 'num', textContent: som(d.revenue) }))));
  $('statsFunnelSub').textContent = t('adm.stats.orders', { orders: f.orders, delivery: f.delivery_orders });
  drawFunnel($('statsFunnel'), f);
  $('topRows').replaceChildren(...(s.top.length ? s.top.map((x) => el('li', {},
    el('span', { className: 'rank-name' }, el('strong', { textContent: x.name ? productName(x) : t('adm.stats.deleted', { id: x.product_id }) }), el('span', { className: 'muted', textContent: cat(x.category) })),
    el('span', { className: 'rank-num num' }, el('strong', { textContent: t('adm.stats.times_n', { n: x.count }) })))) :
    [el('li', { className: 'li-empty' }, emptyState({ ic: 'sparkle', title: t('adm.stats.empty_title'), text: t('adm.stats.empty_text') }))]));
}
// Numbers and ISO days only, so no cell can start a formula.
function exportStats() {
  if (!lastStats) return;
  const rows = [[t('adm.stats.day'), t('adm.stats.count'), t('adm.dash.paid'), t('adm.dash.revenue')], ...lastStats.per_day.map((d) => [d.day, d.count, d.orders, d.revenue])];
  const blob = new Blob(['﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n')], { type: 'text/csv' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `stats-${lastStats.days}d.csv` });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- QR codes for the phone app, one card per store.

async function loadQr() {
  const seq = (loads.qr = (loads.qr || 0) + 1);
  const list = scope ? stores.filter((s) => String(s.id) === scope) : stores;
  $('qrGrid').replaceChildren(...list.map(() => el('div', { className: 'card qr-card', ariaHidden: 'true' }, el('span', { className: 'skeleton qr-skel' }))));
  try {
    const codes = await Promise.all(list.map((s) => call(`/stores/${s.id}/qr`)));
    if (seq !== loads.qr) return;
    stateBox($('qrError'));
    $('qrGrid').replaceChildren(...codes.map((q) => {
      const img = el('div', { className: 'qr-img' });
      img.innerHTML = q.svg; // generated by our server from the store URL (path data only)
      img.firstElementChild?.setAttribute('aria-hidden', 'true');
      return el('section', { className: 'card qr-card' }, el('h2', { textContent: q.name }), img, el('p', { className: 'muted qr-url', textContent: q.url }),
        el('div', { className: 'actions' },
          el('button', { type: 'button', onclick: () => navigator.clipboard?.writeText(q.url).then(() => toast(t('adm.qr.copied')), () => toast(t('common.error'), { tone: 'danger' })) }, t('adm.qr.copy')),
          el('button', { type: 'button', className: 'primary', onclick: () => printQr(q) }, icon('print'), t('adm.qrdlg.print'))));
    }));
  } catch (err) {
    if (seq === loads.qr) { $('qrGrid').replaceChildren(); stateBox($('qrError'), err, () => loadQr()); }
  }
}
function printQr(q) {
  printFrame(`QR — ${q.name}`, 'body{font-family:system-ui,sans-serif;text-align:center;margin:40px}div{width:320px;margin:24px auto}p{font-size:20px}small{color:gray}', (body, mk) => {
    const box = mk('div');
    box.innerHTML = q.svg;
    body.append(mk('h1', { textContent: q.name }), mk('p', { textContent: t('adm.qrdlg.scan') }), box, mk('small', { textContent: q.url }));
  });
}

// ---------- Settings (task 19 adds store profile, team and audit log here).

function loadSettings() {
  const fact = (k, v) => [el('dt', { textContent: t(k) }), el('dd', { textContent: v })];
  $('accFacts').replaceChildren(...fact('adm.login.email', me.email), ...fact('adm.set.role', me.role === 'super' ? t('adm.super') : t('adm.manager')),
    ...fact('common.store', me.role === 'super' ? t('adm.all_stores') : stores[0]?.name || ''));
}

show();
