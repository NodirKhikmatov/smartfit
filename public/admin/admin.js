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
// A super-admin's (or a multi-store owner's) store picker (sidebar) narrows every list and chart; a manager is pinned to
// their store by the server, an owner to their organisation's stores.
const many = () => me?.role === 'super' || stores.length > 1;
const scoped = (params) => (many() && scope ? { ...params, store_id: scope } : params);
const storeName = (id) => stores.find((s) => s.id === id)?.name || '';
const showStore = () => many() && !scope;

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
// Stock per size as small heat cells: size + free units, red when sold out, amber at or below the store's threshold.
function heat(stock, low = 1) {
  return el('span', { className: 'heat' }, ...stock.map((s) => {
    const free = s.quantity - s.reserved;
    return el('span', { className: `cell l${stockLevel(free, low)}`, title: t('adm.products.cell', { size: s.size === 'ONE' ? t('common.size_one') : s.size, n: free }) },
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
  // A constructed sheet, not a <style> element: the frame inherits the page's CSP (no inline styles).
  const sheet = new frame.contentWindow.CSSStyleSheet();
  sheet.replaceSync(css);
  d.adoptedStyleSheets = [sheet];
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

const roleName = (r) => t({ super: 'adm.role_super', owner: 'adm.role_owner', manager: 'adm.role_manager', staff: 'adm.role_staff' }[r]);

async function show() {
  me = null;
  if (token()) { try { me = await call('/me'); } catch {} }
  $('invite').hidden = true;
  $('login').hidden = !!me;
  $('app').hidden = !me;
  if (!me) return;
  if (me.role === 'staff') return location.replace('/staff/'); // task 28: the shop-floor role has only the staff app
  stores = await call('/stores');
  const sup = many();
  scope = sup && stores.some((s) => String(s.id) === store.get('sfAdminStore')) ? store.get('sfAdminStore') : '';
  $('scope').replaceChildren(el('option', { value: '', textContent: t('adm.all_stores') }), ...stores.map((s) => el('option', { value: s.id, textContent: s.name })));
  $('scope').value = scope;
  $('scopeWrap').hidden = !sup;
  $('scopeName').hidden = sup || !stores.length; // a new owner has no store until the wizard makes one
  $('scopeName').querySelector('span').textContent = stores[0]?.name || '';
  $('userEmail').textContent = me.email;
  $('userRole').textContent = roleName(me.role);
  $('avatar').textContent = me.email[0].toUpperCase();
  $('storeWrap').hidden = !sup;
  $('navOrgs').hidden = me.role !== 'super';
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
  team = null;
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
  demand: { title: 'adm.route.demand', load: loadDemand },
  qr: { title: 'adm.route.qr', load: loadQr },
  settings: { title: 'adm.route.settings', load: loadSettings },
  orgs: { title: 'adm.route.orgs', load: loadOrgs },
  welcome: { title: 'adm.route.welcome', load: loadWelcome },
};
const ACTIONS = {
  orders: [el('button', { type: 'button', className: 'icon-btn', title: t('adm.export'), ariaLabel: t('adm.export'), onclick: () => exportOrders() }, icon('download'))],
  products: [
    el('button', { type: 'button', onclick: () => openImport() }, icon('upload'), el('span', { className: 'label', textContent: t('adm.products.import') })),
    el('button', { type: 'button', className: 'primary', onclick: () => openForm(null) }, icon('plus'), el('span', { className: 'label', textContent: t('adm.products.add') })),
  ],
  stats: [el('button', { type: 'button', className: 'icon-btn', title: t('adm.export'), ariaLabel: t('adm.export'), onclick: () => exportStats() }, icon('download'))],
  demand: [el('button', { type: 'button', className: 'icon-btn', title: t('adm.export'), ariaLabel: t('adm.export'), onclick: () => download('/demand/export?' + qs(scoped({ days: demandDays() })), `talab-${demandDays()}d.csv`) }, icon('download'))],
};

function render() {
  route = parseHash(location.hash);
  // A new owner has no store yet: everything but the wizard and their account waits for it. Only owners add stores.
  const welcome = me.role === 'owner' && !stores.length;
  if ((welcome && !['welcome', 'settings'].includes(route.route)) || (route.route === 'welcome' && me.role !== 'owner') || (route.route === 'orgs' && me.role !== 'super')) {
    route = parseHash(welcome ? '#/welcome' : '#/dashboard');
    history.replaceState(null, '', buildHash(route.route));
  }
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
  if (inviteFromHash() || !me) return;
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
    heat(x.stock, x.low_stock_threshold),
    el('button', { type: 'button', className: 'icon-btn ghost', title: t('adm.products.edit'), ariaLabel: t('adm.products.edit_aria', { name: productName(x) }), onclick: () => openForm(x) }, icon('edit')))) :
    [el('li', { className: 'li-empty' }, emptyState({ ic: 'check', title: t('adm.dash.low_empty'), text: t('adm.dash.low_empty_text') }))]));
  const ret = d.returns;
  $('dashReturnsSub').textContent = t('adm.dash.returns_sub', { n: days, units: ret.units, sold: ret.sold });
  $('dashReturnsRate').textContent = ret.sold ? `${dec(Math.round((ret.units / ret.sold) * 1000) / 10)}%` : '—';
  $('dashReturnsRefund').textContent = t('adm.dash.returns_refund', { sum: money(ret.refund) });
  $('dashReturns').replaceChildren(...(ret.reasons.length ? ret.reasons.map((x) => el('li', {},
    el('span', { className: 'rank-name' }, el('strong', { textContent: t(REASON[x.reason]) })),
    el('span', { className: 'rank-num num' }, el('strong', { textContent: t('adm.dash.units', { n: x.units }) })))) :
    [el('li', { className: 'li-empty' }, emptyState({ ic: 'check', title: t('adm.dash.returns_empty'), text: t('adm.dash.returns_empty_text') }))]));
  $('dashKiosks').replaceChildren(...(d.kiosks.length ? d.kiosks.map((k) => el('li', {},
    el('div', { className: 'grow' }, el('strong', { textContent: t('adm.dash.kiosk_name', { id: k.id }) }),
      el('div', { className: 'sizes', textContent: [!scope && many() && stores.find((s) => s.id === k.store_id)?.name, t('adm.dash.seen', { at: fmt.dateTime(k.last_seen_at) })].filter(Boolean).join(' · ') })),
    el('span', { className: `badge ${k.online ? 'ok' : 'off'}`, textContent: t(k.online ? 'adm.dash.online' : 'adm.dash.offline') }))) :
    [el('li', { className: 'li-empty' }, emptyState({ ic: 'info', title: t('adm.dash.kiosks_none'), text: t('adm.dash.kiosks_none_text') }))]));
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

// withReturns: the order drawer adds what came back, the customer's fit answer and a return button per line (task 23).
const FIT_WORD = { small: 'kiosk.track.fit_small', right: 'kiosk.track.fit_right', big: 'kiosk.track.fit_big' };
function itemsList(o, withReturns = false) {
  return el('ul', { className: 'lines' }, ...o.items.map((i) => el('li', {},
    el('span', {}, el('strong', { textContent: productName(i) }), el('span', { className: 'muted', textContent: [i.size === 'ONE' ? t('common.size_one') : i.size, i.shelf_location,
      withReturns && i.returned > 0 && t('adm.ret.returned', { n: i.returned }), withReturns && i.fit && t('adm.ret.fit', { fit: t(FIT_WORD[i.fit]) })].filter(Boolean).join(' · ') }),
    ...(withReturns && o.can_return && i.returned < i.quantity ? [el('button', { type: 'button', className: 'ret-btn', textContent: t('adm.ret.btn'), ariaLabel: t('adm.ret.btn_aria', { name: productName(i) }), onclick: () => openReturn(o, i) })] : [])),
    el('span', { className: 'num' }, `${i.quantity} × ${som(i.unit_price)}`, el('strong', { textContent: som(i.quantity * i.unit_price) })))));
}
const REASON = { too_small: 'adm.ret.reason_too_small', too_big: 'adm.ret.reason_too_big', disliked: 'adm.ret.reason_disliked', defect: 'adm.ret.reason_defect' };
function returnsList(o) {
  if (!o.returns?.length) return [];
  const name = (id) => productName(o.items.find((i) => i.id === id) || {});
  return [el('h3', { textContent: t('adm.dash.returns') }), el('ul', { className: 'lines ret-list' }, ...o.returns.map((r) => el('li', {},
    el('span', {}, el('strong', { textContent: name(r.order_item_id) }), el('span', { className: 'muted', textContent: [
      r.kind === 'exchange' ? t('adm.ret.row_exchange', { qty: r.quantity, size: r.new_size, reason: t(REASON[r.reason]) }) : t('adm.ret.row_return', { qty: r.quantity, reason: t(REASON[r.reason]), sum: money(r.refund) }),
      t(r.restock ? 'adm.ret.restocked' : 'adm.ret.not_restocked'), fmt.dateTime(r.created_at)].join(' · ') })))))];
}

// Return / exchange dialog over the order drawer. One random key per opening: a double submit is answered, not repeated.
let returning = null;
const rf = $('retForm');
function openReturn(o, i) {
  const left = i.quantity - i.returned;
  returning = { o, i, key: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('') };
  rf.reset();
  $('retError').textContent = '';
  $('retItem').textContent = `${productName(i)} · ${i.size} · ${som(i.unit_price)}`;
  rf.quantity.max = left;
  rf.quantity.value = 1;
  rf.new_size.replaceChildren(...sizesFor(i.category).filter((s) => s !== i.size).map((s) => el('option', { value: s, textContent: s })));
  syncReturn();
  $('retDlg').showModal();
}
function syncReturn() {
  const { i } = returning;
  const exchange = rf.kind.value === 'exchange';
  const qty = Math.min(Math.max(Number(rf.quantity.value) || 1, 1), i.quantity - i.returned);
  $('retSizeWrap').hidden = !exchange;
  $('retRefundWrap').hidden = exchange;
  const paid = Math.floor(((i.unit_price * i.quantity - (i.discount || 0)) * qty) / i.quantity); // less the line's discount share, as the server caps it
  rf.refund.max = paid;
  if (!rf.refund.dataset.touched) rf.refund.value = paid;
  $('retRefundMax').textContent = t('adm.ret.refund_max', { sum: money(paid) });
}
rf.addEventListener('change', (e) => {
  if (e.target.name === 'refund') rf.refund.dataset.touched = '1';
  if (e.target.name === 'reason') rf.restock.checked = rf.reason.value !== 'defect';
  syncReturn();
});
rf.quantity.oninput = syncReturn;
rf.addEventListener('reset', () => delete rf.refund.dataset.touched);
$('retCancel').onclick = () => $('retDlg').close();
rf.addEventListener('submit', async (e) => {
  e.preventDefault();
  const { o, i, key } = returning;
  const exchange = rf.kind.value === 'exchange';
  const body = { key, item_id: i.id, kind: rf.kind.value, reason: rf.reason.value, quantity: Number(rf.quantity.value), restock: rf.restock.checked,
    ...(exchange ? { new_size: rf.new_size.value } : { refund: Number(rf.refund.value) }) };
  $('retSave').disabled = true;
  $('retError').textContent = '';
  try {
    const next = await call(`/orders/${o.id}/returns`, { method: 'POST', body });
    $('retDlg').close();
    toast(t('adm.ret.done', { id: o.number }));
    if (openId === o.id) { renderOrder(next); keepFocus(); }
  } catch (err) { $('retError').textContent = err.message; } finally { $('retSave').disabled = false; }
});
// Task 26: the order's discounts as [label, so'm] rows, bundle first (the order the server applies them in).
const discountLines = (o) => [...(o.bundle_discount ? [[t('common.bundle_off'), o.bundle_discount]] : []), ...(o.promo_discount ? [[t('common.promo_off', { code: o.promo_code }), o.promo_discount]] : [])];
function totalsBlock(o) {
  return el('dl', { className: 'totals' },
    el('dt', { textContent: t('adm.receipt.subtotal') }), el('dd', { className: 'num', textContent: money(o.subtotal) }),
    ...discountLines(o).flatMap(([label, sum]) => [el('dt', { textContent: label }), el('dd', { className: 'num', textContent: `−${money(sum)}` })]),
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
    el('h3', { textContent: t('adm.order.items') }), itemsList(o, true), totalsBlock(o), ...returnsList(o));
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
    ...discountLines(o).map(([label, sum]) => mk('tr', {}, mk('td', { textContent: label }), mk('td', { textContent: `−${som(sum)}` }))),
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
        el('td', {}, heat(x.stock, x.low_stock_threshold)),
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
  for (const k of ['name', 'name_ru', 'category', 'gender', 'color', 'style', 'price', 'discount_price', 'temp_min', 'temp_max', 'shelf_location', 'sku', 'barcode']) f[k].value = p?.[k] ?? '';
  if (!p) { f.category.value = 'top'; f.gender.value = 'unisex'; }
  f.waterproof.checked = !!p?.waterproof;
  f.store_id.value = p?.store_id ?? (scope || stores[0]?.id || '');
  f.store_id.disabled = !!p;
  renderStock(f.category.value, p?.stock);
  renderFit(p);
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
    shelf_location: f.shelf_location.value || null, sku: f.sku.value.trim() || null, barcode: f.barcode.value.trim() || null,
    stock: Object.fromEntries([...$('stock').querySelectorAll('input')].map((i) => [i.dataset.size, num(i.value) ?? 0])),
  };
  if (!editing && many()) body.store_id = Number(f.store_id.value);
  $('save').disabled = true;
  try {
    await call(editing ? '/products/' + editing.id : '/products', { method: editing ? 'PATCH' : 'POST', body });
    $('dlg').close();
    toast(t(editing ? 'adm.form.saved' : 'adm.form.added'));
    reloadProducts();
  } catch (err) { $('formError').textContent = err.message; } finally { $('save').disabled = false; }
});
// Task 23: what buyers said about the fit, the automatic offset (≥ 5 answers) and the owner's override.
const FIT_MIN = 5;
const FIT_V = { 1: 'adm.sizefit.v_small', 0: 'adm.sizefit.v_right', '-1': 'adm.sizefit.v_big' };
function renderFit(p) {
  $('fitWrap').hidden = !p || p.category === 'accessory' || !p.fit;
  $('fitError').textContent = '';
  if ($('fitWrap').hidden) return;
  const n = p.fit.small + p.fit.right + p.fit.big;
  $('fitStats').textContent = [t('adm.sizefit.stats', p.fit), t('adm.sizefit.auto', { v: n < FIT_MIN ? t('adm.sizefit.few', { n: FIT_MIN }) : t(FIT_V[p.fit.auto]) })].join('. ');
  $('fitOffset').value = p.fit.override == null ? '' : String(p.fit.override);
  const owner = me?.role !== 'manager';
  $('fitOffset').disabled = $('fitSave').disabled = !owner;
  $('fitNote').textContent = owner ? '' : t('adm.sizefit.owner_only');
}
$('fitSave').onclick = async () => {
  $('fitError').textContent = '';
  const v = $('fitOffset').value;
  try {
    const p = await call(`/products/${editing.id}/fit`, { method: 'PATCH', body: { offset: v === '' ? null : Number(v) } });
    editing.fit = p.fit;
    renderFit(p);
    toast(t('adm.sizefit.saved'));
  } catch (err) { $('fitError').textContent = err.message; }
};
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

$('importCols').textContent = 'id, sku, barcode, store_id, name, name_ru, category, gender, color, style, price, discount_price, temp_min, temp_max, waterproof, shelf_location, XS, S, M, L, XL, XXL, 36 … 45, ONE';
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
    const r = await call('/products/import?' + qs(scoped({})), { method: 'POST', raw: await file.text(), type: 'text/csv' });
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

// ---------- Talab (task 24): missed demand with a restock suggestion, and the customer funnel by step per kiosk and day.

const sizeText = (size) => (size === 'ONE' ? t('common.size_one') : size);
const DROP = [['start', 'adm.drop.start'], ['size', 'adm.drop.size'], ['outfits', 'adm.drop.outfits'], ['cart', 'adm.drop.cart'], ['order', 'adm.drop.order']];
const demandDays = () => (['7', '30'].includes(route.params.days) ? Number(route.params.days) : 14);
async function loadDemand() {
  const seq = (loads.demand = (loads.demand || 0) + 1);
  const p = route.params, days = demandDays();
  seg($('demandDays'), [7, 14, 30].map((n) => [String(n), t('adm.stats.days', { n })]), String(days), (v) => setParams({ ...p, days: v === '14' ? '' : v }));
  const stop = skeletonRows($('demandRows'), 6);
  let d;
  try { d = await call('/demand?' + qs(scoped({ days }))); } catch (err) {
    stop();
    if (seq === loads.demand) stateBox($('demandError'), err, () => loadDemand());
    return;
  }
  stop();
  if (seq !== loads.demand) return;
  stateBox($('demandError'));
  const f = d.funnel, withStore = showStore();
  $('demandRange').textContent = t('adm.stats.range', { from: day(f.per_day[0].day), to: day(f.per_day.at(-1).day), n: d.days });
  if (!d.items.length) emptyRow($('demandRows'), 6, { ic: 'check', title: t('adm.demand.empty'), text: t('adm.demand.empty_text') });
  else $('demandRows').replaceChildren(...d.items.map((x) => el('tr', {},
    el('td', {}, el('span', { className: 'demand-name' }, el('strong', { textContent: productName(x) }),
      el('span', { className: 'sizes', textContent: [x.sku || cat(x.category), withStore && x.store_name].filter(Boolean).join(' · ') }),
      el('span', { className: 'show-sm', textContent: `${t('adm.demand.size')}: ${sizeText(x.size)}` }))), // phones: the size column hides
    el('td', { className: 'hide-sm', textContent: sizeText(x.size) }),
    el('td', { className: 'num', textContent: x.missed }),
    el('td', { className: 'num hide-sm', textContent: x.sold }),
    el('td', { className: 'num hide-sm', textContent: x.stock }),
    el('td', { className: 'num' }, el('strong', { textContent: x.suggest })))));

  $('dropSub').textContent = t('adm.drop.sub', { n: f.total.start });
  if (!f.total.start) $('dropFunnel').replaceChildren(emptyState({ ic: 'sparkle', title: t('adm.drop.empty'), text: t('adm.drop.empty_text') }));
  else funnelChart($('dropFunnel'), DROP.map(([k, label]) => ({ label: t(label), value: f.total[k] })), { pct: (v, base) => (base ? `${dec(share(v, base))}%` : '—') });
  const head = (first) => el('tr', {}, el('th', { textContent: t(first) }), ...DROP.map(([, label]) => el('th', { className: 'num', textContent: t(label) })));
  const cells = (x) => DROP.map(([k]) => el('td', { className: 'num', textContent: x[k] }));
  $('dropKioskHead').replaceChildren(head('adm.drop.kiosk'));
  if (!f.per_kiosk.length) emptyRow($('dropKioskRows'), 6, { ic: 'store', title: t('adm.drop.empty'), text: t('adm.drop.empty_text') });
  else $('dropKioskRows').replaceChildren(...f.per_kiosk.map((k) => el('tr', {},
    el('td', { textContent: [k.kiosk ? t('adm.drop.kiosk_n', { id: k.kiosk }) : t('adm.drop.phone'), withStore && storeName(k.store_id)].filter(Boolean).join(' · ') }), ...cells(k))));
  $('dropDayHead').replaceChildren(head('adm.stats.day'));
  $('dropDayRows').replaceChildren(...f.per_day.slice().reverse().map((x) => el('tr', {}, el('td', { textContent: day(x.day) }), ...cells(x))));
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

// ---------- Settings: store profile, team, audit log, my account (#/settings?tab=…).
// The server decides who may do what; the tabs only hide what a role can't open.

const SET_TABS = [['store', 'adm.set.store'], ['team', 'adm.set.team'], ['promo', 'adm.set.promo'], ['sync', 'adm.set.sync'], ['audit', 'adm.set.audit'], ['account', 'adm.set.account']];
function loadSettings() {
  const tabs = SET_TABS.filter(([k]) => me.role !== 'manager' || k === 'store' || k === 'account');
  const tab = tabs.some(([k]) => k === route.params.tab) ? route.params.tab : stores.length ? 'store' : 'account'; // a new owner has no store yet
  $('setTabs').replaceChildren(...tabs.map(([k, label]) => {
    const a = el('a', { className: 'chip', href: buildHash('settings', k === 'store' ? {} : { tab: k }), textContent: t(label) });
    if (k === tab) a.setAttribute('aria-current', 'page');
    return a;
  }));
  for (const s of document.querySelectorAll('[data-tab]')) s.hidden = s.dataset.tab !== tab;
  ({ store: loadStore, team: loadTeam, promo: loadPromos, sync: loadKeys, audit: loadAudit, account: loadAccount })[tab]();
}

// Store profile. A super-admin picks the store here (defaults to the sidebar's); everyone else has one.
const STORE_FIELDS = ['name', 'city', 'address', 'lat', 'lon', 'opens_at', 'closes_at', 'delivery_fee', 'free_delivery_threshold', 'telegram_chat_id', 'low_stock_threshold', 'report_chat_id', 'bundle_percent'];
const sf = $('storeForm');
const storeId = () => (many() ? $('storePick').value : String(stores[0]?.id ?? me.store_id));
function mapLink() {
  const [lat, lon] = [sf.lat.value, sf.lon.value];
  $('mapLink').hidden = !(lat && lon);
  $('mapLink').href = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lon)}#map=17/${encodeURIComponent(lat)}/${encodeURIComponent(lon)}`;
}
sf.lat.oninput = sf.lon.oninput = mapLink;
async function loadStore() {
  const sup = many();
  $('storePickWrap').hidden = !sup;
  $('storeAdd').hidden = me.role !== 'owner';
  if (sup && $('storePick').options.length !== stores.length) {
    $('storePick').replaceChildren(...stores.map((s) => el('option', { value: s.id, textContent: s.name })));
    $('storePick').value = scope || stores[0]?.id || '';
  }
  const seq = (loads.store = (loads.store || 0) + 1);
  $('storeError').textContent = '';
  $('storeFields').disabled = true;
  try {
    const s = await call(`/stores/${storeId()}`);
    if (seq !== loads.store) return;
    stateBox($('storeLoadError'));
    for (const k of STORE_FIELDS) sf[k].value = s[k] ?? '';
    sf.kiosk_pin.value = '';
    $('pinState').textContent = t(s.kiosk_pin_set ? 'adm.set.pin_on' : 'adm.set.pin_off') + '.';
    $('storeFields').disabled = !s.can_edit;
    $('storeReadOnly').hidden = s.can_edit;
    $('storeSave').hidden = !s.can_edit;
    mapLink();
  } catch (err) {
    if (seq === loads.store) stateBox($('storeLoadError'), err, () => loadStore());
  }
}
$('storePick').onchange = () => loadStore();
sf.onsubmit = async (e) => {
  e.preventDefault();
  $('storeError').textContent = '';
  if (!sf.reportValidity()) return;
  const v = (k) => sf[k].value.trim();
  const body = {
    name: v('name'), city: v('city'), address: v('address'), lat: Number(v('lat')), lon: Number(v('lon')),
    opens_at: v('opens_at') || null, closes_at: v('closes_at') || null,
    delivery_fee: Number(v('delivery_fee')), free_delivery_threshold: v('free_delivery_threshold') ? Number(v('free_delivery_threshold')) : null,
    telegram_chat_id: v('telegram_chat_id') || null, report_chat_id: v('report_chat_id') || null, low_stock_threshold: Number(v('low_stock_threshold')),
    bundle_percent: Number(v('bundle_percent')),
    ...(v('kiosk_pin') && { kiosk_pin: v('kiosk_pin') }),
  };
  try {
    const s = await call(`/stores/${storeId()}`, { method: 'PATCH', body });
    const known = stores.find((x) => x.id === s.id);
    if (known && known.name !== s.name) {
      known.name = s.name; // sidebar picker and store names elsewhere
      show();
    }
    sf.kiosk_pin.value = '';
    $('pinState').textContent = t(s.kiosk_pin_set ? 'adm.set.pin_on' : 'adm.set.pin_off') + '.';
    toast(t('adm.set.saved'), { tone: 'ok' });
  } catch (err) { $('storeError').textContent = err.message; }
};

// Team: members with disable/enable, open invite links with revoke, and the invite dialog.
let team = null; // last /team answer, also feeds the audit "who" filter
async function loadTeam() {
  const seq = (loads.team = (loads.team || 0) + 1);
  const sup = many();
  const stop = skeletonRows($('teamRows'), sup ? 5 : 4, 3);
  $('teamStoreCol').hidden = !sup;
  try {
    const r = (team = await call('/team?' + qs(scoped({}))));
    stop();
    if (seq !== loads.team) return;
    stateBox($('teamError'));
    $('teamRows').replaceChildren(...r.members.map((m) => el('tr', {},
      el('td', {}, el('span', { className: 'cell-email', textContent: m.email }), m.id === me.id && el('span', { className: 'badge', textContent: t('adm.team.you') }),
        el('div', { className: 'sizes show-sm', textContent: [roleName(m.role), sup && m.store_name].filter(Boolean).join(' · ') })),
      el('td', { className: 'hide-sm', textContent: roleName(m.role) }),
      sup ? el('td', { className: 'hide-sm', textContent: m.store_name || t('adm.all_stores') }) : null,
      el('td', {}, el('span', { className: `badge ${m.disabled ? 'off' : 'ok'}`, textContent: t(m.disabled ? 'adm.team.disabled' : 'adm.team.active') })),
      el('td', { className: 'row-actions' }, m.can_manage && el('button', { type: 'button', className: m.disabled ? '' : 'danger ghost', onclick: (e) => setDisabled(m, !m.disabled, e.currentTarget) },
        t(m.disabled ? 'adm.team.enable' : 'adm.team.disable'))))));
    $('inviteList').replaceChildren(...(r.invites.length ? r.invites.map((i) => el('li', { className: 'card invite-row' },
      el('div', { className: 'grow' }, el('strong', { className: 'cell-email', textContent: i.email }),
        el('div', { className: 'sizes', textContent: [roleName(i.role), sup && i.store_name, t('adm.team.expires', { at: fmt.dateTime(i.expires_at) })].filter(Boolean).join(' · ') })),
      i.can_revoke && el('button', { type: 'button', className: 'icon-btn ghost', title: t('adm.team.revoke'), ariaLabel: t('adm.team.revoke'), onclick: () => revokeInvite(i) }, icon('trash'))))
      : [el('li', { className: 'li-empty' }, emptyState({ ic: 'user', title: t('adm.team.no_invites'), text: t('adm.team.no_invites_text') }))]));
  } catch (err) {
    stop();
    if (seq === loads.team) { $('teamRows').replaceChildren(); stateBox($('teamError'), err, () => loadTeam()); }
  }
}
async function setDisabled(m, disabled, btn) {
  if (disabled && !(await confirmDialog({ title: t('adm.team.disable_q', { email: m.email }), text: t('adm.team.disable_text'), ok: t('adm.team.disable'), danger: true }))) return btn.focus();
  btn.disabled = true;
  try {
    await call(`/team/${m.id}`, { method: 'PATCH', body: { disabled } });
    toast(t(disabled ? 'adm.team.disabled_done' : 'adm.team.enabled_done', { email: m.email }), { tone: 'ok' });
    await loadTeam();
  } catch (err) { toast(err.message, { tone: 'danger' }); btn.disabled = false; }
}
async function revokeInvite(i) {
  if (!(await confirmDialog({ title: t('adm.team.revoke_q', { email: i.email }), text: t('adm.team.revoke_text'), ok: t('adm.team.revoke'), danger: true }))) return;
  try {
    await call(`/team/invites/${i.id}`, { method: 'DELETE' });
    loadTeam();
  } catch (err) { toast(err.message, { tone: 'danger' }); }
}

const inv = $('inviteForm');
function inviteStep(done) {
  $('inviteAsk').hidden = done;
  $('inviteDone').hidden = !done;
  $('inviteCreate').hidden = done;
  $('inviteCopy').hidden = !done;
  $('inviteCancel').textContent = t(done ? 'common.close' : 'common.cancel');
}
$('inviteBtn').onclick = () => {
  inv.reset();
  inviteStep(false);
  $('inviteDlgError').textContent = '';
  inv.role.querySelector('[value=owner]').hidden = inv.role.querySelector('[value=owner]').disabled = me.role !== 'super'; // owners invite managers and staff
  $('inviteStoreWrap').hidden = !many();
  inv.store_id.replaceChildren(...stores.map((s) => el('option', { value: s.id, textContent: s.name })));
  inv.store_id.value = scope || stores[0]?.id || '';
  $('inviteDlg').showModal();
};
$('inviteCancel').onclick = () => $('inviteDlg').close();
$('inviteDlg').addEventListener('close', () => {
  $('inviteUrl').value = ''; // the link is shown once; don't leave it in the DOM
  if (!$('inviteDone').hidden) loadTeam();
  $('inviteBtn').focus();
});
inv.onsubmit = async (e) => {
  e.preventDefault();
  $('inviteDlgError').textContent = '';
  const body = { email: inv.email.value.trim(), role: inv.role.value, ...(many() && { store_id: Number(inv.store_id.value) }) };
  try {
    const r = await call('/team/invites', { method: 'POST', body });
    $('inviteUrl').value = r.url;
    $('inviteExpiry').textContent = t('adm.team.link_expiry', { at: fmt.dateTime(r.expires_at) });
    inviteStep(true);
    $('inviteUrl').focus();
    $('inviteUrl').select();
  } catch (err) { $('inviteDlgError').textContent = err.message; }
};
$('inviteCopy').onclick = () => navigator.clipboard?.writeText($('inviteUrl').value)
  .then(() => toast(t('adm.qr.copied'), { tone: 'ok' }), () => toast(t('common.error'), { tone: 'danger' }));

// Stock sync API keys: live keys with revoke, the create dialog (the key is shown once) and a curl sample.
async function loadKeys() {
  const seq = (loads.keys = (loads.keys || 0) + 1);
  const sup = many();
  $('keySample').textContent = `curl -X POST ${location.origin}/api/sync/stock \\\n  -H "Authorization: Bearer sfk_…" -H "Content-Type: application/json" \\\n  -d '{"items":[{"sku":"SF-TP-01","size":"M","quantity":12}]}'`;
  try {
    const keys = await call('/sync-keys?' + qs(scoped({})));
    if (seq !== loads.keys) return;
    stateBox($('keyError'));
    $('keyList').replaceChildren(...(keys.length ? keys.map((k) => el('li', { className: 'card invite-row' },
      el('div', { className: 'grow' }, el('strong', { textContent: k.name }),
        el('div', { className: 'sizes', textContent: [`${k.prefix}…`, sup && k.store_name, t('adm.sync.created', { at: fmt.dateTime(k.created_at) }),
          k.last_used_at ? t('adm.sync.used', { at: fmt.dateTime(k.last_used_at) }) : t('adm.sync.never')].filter(Boolean).join(' · ') })),
      el('button', { type: 'button', className: 'icon-btn ghost', title: t('adm.sync.revoke'), ariaLabel: t('adm.sync.revoke_aria', { name: k.name }), onclick: () => revokeKey(k) }, icon('trash'))))
      : [el('li', { className: 'li-empty' }, emptyState({ ic: 'settings', title: t('adm.sync.none'), text: t('adm.sync.none_text') }))]));
  } catch (err) {
    if (seq === loads.keys) { $('keyList').replaceChildren(); stateBox($('keyError'), err, () => loadKeys()); }
  }
}
async function revokeKey(k) {
  if (!(await confirmDialog({ title: t('adm.sync.revoke_q', { name: k.name }), text: t('adm.sync.revoke_text'), ok: t('adm.sync.revoke'), danger: true }))) return;
  try {
    await call(`/sync-keys/${k.id}`, { method: 'DELETE' });
    toast(t('adm.sync.revoked', { name: k.name }), { tone: 'ok' });
    loadKeys();
  } catch (err) { toast(err.message, { tone: 'danger' }); }
}
const kf = $('keyForm');
function keyStep(done) {
  $('keyAsk').hidden = $('keyCreate').hidden = done;
  $('keyDone').hidden = $('keyCopy').hidden = !done;
  $('keyCancel').textContent = t(done ? 'common.close' : 'common.cancel');
}
$('keyBtn').onclick = () => {
  kf.reset();
  keyStep(false);
  $('keyDlgError').textContent = '';
  $('keyStoreWrap').hidden = !many();
  kf.store_id.replaceChildren(...stores.map((s) => el('option', { value: s.id, textContent: s.name })));
  kf.store_id.value = scope || stores[0]?.id || '';
  $('keyDlg').showModal();
};
$('keyCancel').onclick = () => $('keyDlg').close();
$('keyDlg').addEventListener('close', () => {
  $('keyValue').value = ''; // shown once; don't leave it in the DOM
  if (!$('keyDone').hidden) loadKeys();
  $('keyBtn').focus();
});
kf.onsubmit = async (e) => {
  e.preventDefault();
  $('keyDlgError').textContent = '';
  try {
    const r = await call('/sync-keys', { method: 'POST', body: { name: kf.name.value.trim(), ...(many() && { store_id: Number(kf.store_id.value) }) } });
    $('keyValue').value = r.key;
    keyStep(true);
    $('keyValue').focus();
    $('keyValue').select();
  } catch (err) { $('keyDlgError').textContent = err.message; }
};
$('keyCopy').onclick = () => navigator.clipboard?.writeText($('keyValue').value)
  .then(() => toast(t('adm.qr.copied'), { tone: 'ok' }), () => toast(t('common.error'), { tone: 'danger' }));

// Promo codes (task 26): owner / super-admin. Codes are switched off, never deleted (orders keep them).
let promos = [];
const promoState = (p) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
  if (!p.active) return ['adm.promo.off', 'off'];
  if (p.ends_on && p.ends_on < today) return ['adm.promo.ended', 'off'];
  if (p.max_uses != null && p.used >= p.max_uses) return ['adm.promo.used_up', 'warn'];
  if (p.starts_on && p.starts_on > today) return ['adm.promo.scheduled', 'warn'];
  return ['adm.promo.on', 'ok'];
};
const promoValue = (p) => (p.kind === 'percent' ? `${p.value}%` : money(p.value));
const dayText = (d) => d.split('-').reverse().join('.');
async function loadPromos() {
  const seq = (loads.promo = (loads.promo || 0) + 1);
  const stop = skeletonRows($('promoRows'), 7, 3);
  try {
    promos = await call('/promos');
    if (seq !== loads.promo) return;
    stateBox($('promoError'));
    $('promoRows').replaceChildren(...(promos.length ? promos.map((p) => {
      const [state, tone] = promoState(p);
      const tr = el('tr', {},
        el('td', {}, el('strong', { textContent: p.code })),
        el('td', { textContent: [promoValue(p), p.min_order && t('adm.promo.min_short', { sum: money(p.min_order) })].filter(Boolean).join(' · ') }),
        el('td', { className: 'hide-sm', textContent: p.store_id ? p.store_name : t('adm.promo.all_stores') }),
        el('td', { className: 'hide-sm', textContent: p.starts_on || p.ends_on ? `${p.starts_on ? dayText(p.starts_on) : '…'} – ${p.ends_on ? dayText(p.ends_on) : '…'}` : t('adm.promo.no_dates') }),
        el('td', { className: 'num', textContent: p.max_uses != null ? `${p.used} / ${p.max_uses}` : String(p.used) }),
        el('td', {}, el('span', { className: `badge ${tone}`, textContent: t(state) })),
        el('td', {}, el('button', { type: 'button', className: 'icon-btn ghost', title: t('adm.promo.edit'), ariaLabel: t('adm.promo.edit_aria', { code: p.code }), onclick: () => openPromo(p) }, icon('edit'))));
      return tr;
    }) : [el('tr', {}, el('td', { colSpan: 7 }, emptyState({ ic: 'sparkle', title: t('adm.promo.none'), text: t('adm.promo.none_text') })))]));
  } catch (err) {
    if (seq === loads.promo) { $('promoRows').replaceChildren(); stateBox($('promoError'), err, () => loadPromos()); }
  } finally { stop?.(); }
}
const promoF = $('promoForm');
let editingPromo = null;
function openPromo(p = null) {
  editingPromo = p;
  promoF.reset();
  $('promoDlgError').textContent = '';
  $('promoTitle').textContent = p ? t('adm.promo.edit_title', { code: p.code }) : t('adm.promo.create');
  const owned = stores.filter((s) => !p || s.organization_id === p.organization_id); // an edit stays in the code's organisation
  promoF.store_id.replaceChildren(el('option', { value: '', textContent: t('adm.promo.all_stores') }), ...owned.map((s) => el('option', { value: s.id, textContent: s.name })));
  promoF.code.disabled = Boolean(p); // the code stays; orders keep it
  for (const k of ['code', 'kind', 'value', 'min_order', 'max_uses', 'max_per_phone', 'starts_on', 'ends_on']) promoF[k].value = p?.[k] ?? (k === 'kind' ? 'percent' : '');
  promoF.store_id.value = p?.store_id ?? (p ? '' : scope || '');
  promoF.active.checked = p ? p.active : true;
  $('promoDlg').showModal();
}
$('promoBtn').onclick = () => openPromo();
$('promoCancel').onclick = () => $('promoDlg').close();
$('promoDlg').addEventListener('close', () => $('promoBtn').focus());
promoF.onsubmit = async (e) => {
  e.preventDefault();
  $('promoDlgError').textContent = '';
  if (!promoF.reportValidity()) return;
  const n = (k) => (promoF[k].value === '' ? null : Number(promoF[k].value));
  const body = {
    store_id: promoF.store_id.value ? Number(promoF.store_id.value) : null, kind: promoF.kind.value, value: n('value'), min_order: n('min_order') ?? 0,
    max_uses: n('max_uses'), max_per_phone: n('max_per_phone'), starts_on: promoF.starts_on.value || null, ends_on: promoF.ends_on.value || null, active: promoF.active.checked,
    ...(!editingPromo && { code: promoF.code.value.trim(), ...(me.role === 'super' && !promoF.store_id.value && { organization_id: stores.find((s) => String(s.id) === String(scope))?.organization_id }) }),
  };
  $('promoSave').disabled = true;
  try {
    const p = await call(editingPromo ? `/promos/${editingPromo.id}` : '/promos', { method: editingPromo ? 'PATCH' : 'POST', body });
    $('promoDlg').close();
    toast(t('adm.promo.saved', { code: p.code }), { tone: 'ok' });
    loadPromos();
  } catch (err) { $('promoDlgError').textContent = err.message; } finally { $('promoSave').disabled = false; }
};

// Audit log: newest first, filtered by what / who / dates (all in the hash), paged.
const AUDIT_FIELDS = {
  name: 'field.name', name_ru: 'field.name_ru', category: 'field.category', gender: 'field.gender', color: 'field.color', style: 'field.style',
  price: 'field.price', discount_price: 'field.discount_price', temp_min: 'field.temp_min', temp_max: 'field.temp_max', waterproof: 'field.waterproof',
  shelf_location: 'field.shelf_location', image_url: 'field.photo', stock: 'field.stock', status: 'field.status', payment_status: 'adm.orders.payment',
  city: 'field.city', address: 'field.address', lat: 'adm.set.lat', lon: 'adm.set.lon', opens_at: 'adm.set.opens', closes_at: 'adm.set.closes',
  delivery_fee: 'field.delivery_fee', free_delivery_threshold: 'field.free_threshold', telegram_chat_id: 'field.telegram_chat', report_chat_id: 'field.report_chat',
  sku: 'field.sku', barcode: 'field.barcode', low_stock_threshold: 'field.low_stock', prefix: 'adm.sync.key',
  email: 'field.email', role: 'field.role', disabled: 'adm.team.status',
  bundle_percent: 'field.bundle_percent', store_id: 'common.store', kind: 'field.promo_kind', value: 'field.promo_value', min_order: 'field.promo_min',
  starts_on: 'adm.promo.starts', ends_on: 'adm.promo.ends', max_uses: 'field.promo_max_uses', max_per_phone: 'field.promo_per_phone', active: 'field.promo_active',
};
const MONEY = ['price', 'discount_price', 'delivery_fee', 'free_delivery_threshold', 'min_order'];
function auditValue(k, v) {
  if (v == null || v === '') return '—';
  if (k === 'image_url') return t('adm.audit.photo');
  if (k === 'disabled') return t(v ? 'adm.team.disabled' : 'adm.team.active');
  if (typeof v === 'boolean') return t(v ? 'adm.audit.yes' : 'adm.audit.no');
  if (MONEY.includes(k)) return money(v);
  if (k === 'status') return t(`adm.status.${v}`);
  if (k === 'payment_status') return t(`adm.pay.${v}`);
  if (k === 'role') return roleName(v);
  if (k === 'category') return cat(v);
  if (k === 'store_id') return storeName(v) || `#${v}`;
  if (k === 'kind') return t(v === 'percent' ? 'adm.promo.percent' : 'adm.promo.fixed');
  return String(v);
}
// One line per changed field: "Narxi: 200 000 so'm → 180 000 so'm"; stock lists only the sizes that moved.
function auditLines(l) {
  const b = l.before || {}, a = l.after || {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const one = !l.before || !l.after; // created or deleted: show the values, no arrows
  return keys.flatMap((k) => {
    const label = AUDIT_FIELDS[k] ? t(AUDIT_FIELDS[k]) : k;
    if (k === 'stock') {
      const sb = b.stock || {}, sa = a.stock || {};
      const sizes = [...new Set([...Object.keys(sb), ...Object.keys(sa)])].filter((s) => one ? (sa[s] ?? sb[s]) > 0 : sb[s] !== sa[s]);
      if (!sizes.length) return [];
      const name = (s) => (s === 'ONE' ? t('common.size_one') : s);
      return [`${label}: ${sizes.map((s) => (one ? `${name(s)} ${sa[s] ?? sb[s]}` : `${name(s)} ${sb[s] ?? 0} → ${sa[s] ?? 0}`)).join(', ')}`];
    }
    if (one && (a[k] ?? b[k]) == null) return [];
    return [one ? `${label}: ${auditValue(k, a[k] ?? b[k])}` : `${label}: ${auditValue(k, b[k])} → ${auditValue(k, a[k])}`];
  });
}
const auditSubject = (l) => (l.entity === 'order' ? t('adm.order.title', { id: l.entity_label }) : l.entity === 'fitting' ? t('adm.fit.cabin', { cabin: l.entity_label }) : l.entity_label || '');
const af = $('auditFilters');
for (const e of ['product', 'order', 'fitting', 'store', 'team', 'account', 'sync_key', 'stock']) af.entity.append(el('option', { value: e, textContent: t(`adm.ent.${e}`) }));
af.entity.onchange = af.admin.onchange = af.from.onchange = af.to.onchange = () =>
  setParams({ tab: 'audit', entity: af.entity.value, admin: af.admin.value, from: af.from.value, to: af.to.value });
af.onsubmit = (e) => e.preventDefault();
async function loadAudit() {
  const seq = (loads.audit = (loads.audit || 0) + 1);
  const p = route.params;
  if (!team) { try { team = await call('/team?' + qs(scoped({}))); } catch {} }
  af.admin.replaceChildren(af.admin.options[0], ...(team?.members || []).map((m) => el('option', { value: m.id, textContent: m.email })));
  for (const k of ['entity', 'admin', 'from', 'to']) af[k].value = p[k] || '';
  const stop = skeletonRows($('auditRows'), 4);
  try {
    const r = await call('/audit?' + qs(scoped({ entity: p.entity, admin_id: p.admin, from: p.from, to: p.to, limit: LIMIT, offset: offsetOf(p.page, LIMIT) })));
    stop();
    if (seq !== loads.audit) return;
    stateBox($('auditError'));
    const filtered = ['entity', 'admin', 'from', 'to'].some((k) => p[k]);
    if (!r.items.length) {
      emptyRow($('auditRows'), 4, filtered
        ? { ic: 'search', title: t('adm.audit.none'), text: t('adm.orders.none_text'), action: el('button', { type: 'button', onclick: () => setParams({ tab: 'audit' }) }, t('adm.clear')) }
        : { ic: 'clock', title: t('adm.audit.empty'), text: t('adm.audit.empty_text') });
    } else {
      $('auditRows').replaceChildren(...r.items.map((l) => {
        const lines = auditLines(l);
        const list = (xs) => el('ul', { className: 'changes' }, ...xs.map((x) => el('li', { textContent: x })));
        return el('tr', {},
          el('td', { className: 'num nowrap hide-sm', textContent: fmt.dateTime(l.created_at) }),
          el('td', { className: 'hide-sm' }, el('span', { className: 'cell-email', textContent: l.admin_email }), showStore() && l.store_name && el('div', { className: 'sizes', textContent: l.store_name })),
          el('td', {}, el('strong', { textContent: t(`adm.act.${l.action}`) }), el('div', { className: 'sizes', textContent: auditSubject(l) }),
            el('div', { className: 'sizes show-sm cell-email', textContent: `${fmt.dateTime(l.created_at)} · ${l.admin_email}` })),
          el('td', {}, lines.length > 4
            ? el('details', {}, el('summary', { textContent: t('adm.audit.n_changes', { n: lines.length }) }), list(lines))
            : list(lines)));
      }));
    }
    pager($('auditPager'), r, (page) => { setParams({ ...p, page: page > 1 ? page : '' }); scrollTo(0, 0); });
  } catch (err) {
    stop();
    if (seq !== loads.audit) return;
    stateBox($('auditError'), err, () => loadAudit());
    $('auditRows').replaceChildren();
    $('auditPager').hidden = true;
  }
}

// My account: facts, language, password change (every other session ends; this one gets a fresh token).
function loadAccount() {
  const fact = (k, v) => [el('dt', { textContent: t(k) }), el('dd', { textContent: v })];
  $('accFacts').replaceChildren(...fact('adm.login.email', me.email), ...fact('adm.set.role', roleName(me.role)),
    ...fact('common.store', many() ? t('adm.all_stores') : stores[0]?.name || ''));
  $('pwForm').username.value = me.email;
}
$('pwForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  $('pwError').textContent = '';
  if (f.password.value !== f.repeat.value) { $('pwError').textContent = t('adm.pw.mismatch'); return f.repeat.focus(); }
  try {
    const r = await call('/me/password', { method: 'POST', body: { current: f.current.value, password: f.password.value } });
    store.set('sfToken', r.token);
    f.reset();
    f.username.value = me.email;
    toast(t('adm.pw.done'), { tone: 'ok' });
  } catch (err) { $('pwError').textContent = err.message; }
};

// ---------- Organisations (super-admin): brands with their stores and admins, a new one with its owner's invite link,
// and the landing page's demo requests.

async function loadOrgs() {
  const seq = (loads.orgs = (loads.orgs || 0) + 1);
  const stop = [skeletonRows($('orgRows'), 5, 3), skeletonRows($('demoRows'), 5, 3)];
  const offset = offsetOf(route.params.page, LIMIT);
  try {
    const [orgs, demo] = await Promise.all([call('/orgs'), call('/demo-requests?' + qs({ limit: LIMIT, offset }))]);
    stop.forEach((f) => f());
    if (seq !== loads.orgs) return;
    stateBox($('orgError'));
    stateBox($('demoError'));
    const num = (n, cls = '') => el('td', { className: `num ${cls}`, textContent: n });
    if (!orgs.length) emptyRow($('orgRows'), 5, { ic: 'store', title: t('adm.orgs.empty'), text: t('adm.orgs.empty_text') });
    else $('orgRows').replaceChildren(...orgs.map((o) => el('tr', {}, el('td', {}, el('strong', { textContent: o.name })),
      num(o.stores), num(o.admins, 'hide-sm'), num(o.invites, 'hide-sm'), el('td', { className: 'hide-sm', textContent: fmt.dateTime(o.created_at) }))));
    if (!demo.items.length) emptyRow($('demoRows'), 5, { ic: 'user', title: t('adm.demo.empty'), text: t('adm.demo.empty_text') });
    else $('demoRows').replaceChildren(...demo.items.map((d) => el('tr', { className: d.handled_at ? 'done' : '' },
      el('td', { className: 'hide-sm num', textContent: fmt.dateTime(d.created_at) }),
      el('td', {}, el('strong', { textContent: d.company }), el('div', { className: 'sizes', textContent: [d.city, d.stores && t('adm.demo.stores', { n: d.stores }), d.lang.toUpperCase()].filter(Boolean).join(' · ') })),
      el('td', {}, el('div', { textContent: d.name }), el('a', { href: `tel:${d.phone}`, className: 'num', textContent: d.phone })),
      el('td', { className: 'hide-sm msg', textContent: d.message || '—' }),
      el('td', { className: 'row-actions' }, el('button', { type: 'button', className: d.handled_at ? 'ghost' : '', onclick: (e) => setHandled(d, !d.handled_at, e.currentTarget) },
        t(d.handled_at ? 'adm.demo.reopen' : 'adm.demo.handle'))))));
    pager($('demoPager'), demo, (page) => setParams({ ...route.params, page }));
  } catch (err) {
    stop.forEach((f) => f());
    if (seq === loads.orgs) { $('orgRows').replaceChildren(); $('demoRows').replaceChildren(); stateBox($('orgError'), err, () => loadOrgs()); }
  }
}
async function setHandled(d, handled, btn) {
  btn.disabled = true;
  try {
    await call(`/demo-requests/${d.id}`, { method: 'PATCH', body: { handled } });
    loadOrgs();
  } catch (err) { toast(err.message, { tone: 'danger' }); btn.disabled = false; }
}

const of2 = $('orgForm');
function orgStep(done) {
  $('orgAsk').hidden = done;
  $('orgDone').hidden = !done;
  $('orgCreate').hidden = done;
  $('orgCopy').hidden = !done;
  $('orgCancel').textContent = t(done ? 'common.close' : 'common.cancel');
}
$('orgBtn').onclick = () => {
  of2.reset();
  orgStep(false);
  $('orgDlgError').textContent = '';
  $('orgDlg').showModal();
};
$('orgCancel').onclick = () => $('orgDlg').close();
$('orgDlg').addEventListener('close', () => {
  $('orgUrl').value = ''; // the owner's link is shown once
  if (!$('orgDone').hidden) loadOrgs();
  $('orgBtn').focus();
});
of2.onsubmit = async (e) => {
  e.preventDefault();
  $('orgDlgError').textContent = '';
  try {
    const r = await call('/orgs', { method: 'POST', body: { name: of2.name.value.trim(), owner_email: of2.owner_email.value.trim() } });
    $('orgUrl').value = r.invite.url;
    $('orgExpiry').textContent = t('adm.team.link_expiry', { at: fmt.dateTime(r.invite.expires_at) });
    orgStep(true);
    $('orgUrl').focus();
    $('orgUrl').select();
  } catch (err) { $('orgDlgError').textContent = err.message; }
};
$('orgCopy').onclick = () => navigator.clipboard?.writeText($('orgUrl').value)
  .then(() => toast(t('adm.qr.copied'), { tone: 'ok' }), () => toast(t('common.error'), { tone: 'danger' }));

// ---------- Onboarding wizard (#/welcome?store=ID&step=2|3), owners only: their first store after the invite, or
// another one later from Settings. 1 store profile → 2 products from a CSV (sample file offered) → 3 the QR to print.

const ws = $('wizStore'), wi = $('wizImport');
let wizAt = '';
function loadWelcome() {
  const id = stores.find((s) => String(s.id) === route.params.store)?.id;
  const step = id ? (route.params.step === '3' ? 3 : 2) : 1;
  for (const li of $('wizSteps').children) Number(li.dataset.step) === step ? li.setAttribute('aria-current', 'step') : li.removeAttribute('aria-current');
  for (const c of document.querySelectorAll('[data-wiz]')) c.hidden = Number(c.dataset.wiz) !== step;
  const at = `${id}:${step}`;
  if (at === wizAt) return; // a language switch or poll re-render keeps what was typed
  wizAt = at;
  if (step === 1) {
    ws.reset();
    $('wizStoreError').textContent = '';
  } else if (step === 2) {
    wi.reset();
    $('wizImportDone').hidden = true;
    $('wizImportError').textContent = '';
    $('wizImportErrors').replaceChildren();
    $('wizUpload').hidden = $('wizSkip').hidden = false;
    $('wizNext').hidden = true;
    $('wizSkip').href = $('wizNext').href = buildHash('welcome', { store: id, step: 3 });
  } else loadWizQr(id);
}
ws.onsubmit = async (e) => {
  e.preventDefault();
  $('wizStoreError').textContent = '';
  if (!ws.reportValidity()) return;
  const v = (k) => ws[k].value.trim();
  try {
    const s = await call('/stores', { method: 'POST', body: { name: v('name'), city: v('city'), address: v('address'), lat: Number(v('lat')), lon: Number(v('lon')),
      delivery_fee: Number(v('delivery_fee')), free_delivery_threshold: v('free_delivery_threshold') ? Number(v('free_delivery_threshold')) : null } });
    toast(t('adm.wiz.created', { name: s.name }), { tone: 'ok' });
    history.replaceState(null, '', buildHash('welcome', { store: s.id, step: 2 }));
    show(); // the new store joins the pickers; renders step 2
  } catch (err) { $('wizStoreError').textContent = err.message; }
};
wi.onsubmit = async (e) => {
  e.preventDefault();
  $('wizImportError').textContent = '';
  $('wizImportErrors').replaceChildren();
  const file = wi.file.files[0];
  if (!file) return;
  try {
    const r = await call('/products/import?' + qs({ store_id: route.params.store }), { method: 'POST', raw: await file.text(), type: 'text/csv' });
    $('wizImportDone').querySelector('span').textContent = t('adm.import.done', { created: r.created, updated: r.updated });
    $('wizImportDone').hidden = false;
    $('wizUpload').hidden = $('wizSkip').hidden = true;
    $('wizNext').hidden = false;
    $('wizNext').focus();
  } catch (err) {
    $('wizImportError').textContent = err.message;
    $('wizImportErrors').replaceChildren(...(err.data?.errors || []).map((x) => el('li', { textContent: t('adm.import.line', { line: x.line, error: x.error }) })));
  }
};
async function loadWizQr(id) {
  stateBox($('wizQrError'));
  try {
    const q = await call(`/stores/${id}/qr`);
    $('wizQrImg').innerHTML = q.svg; // generated by our server from the store URL (path data only)
    $('wizQrImg').firstElementChild?.setAttribute('aria-hidden', 'true');
    $('wizQrUrl').textContent = q.url;
    $('wizPhone').href = q.url;
    $('wizKiosk').href = `/kiosk?store=${id}`;
    $('wizPrint').onclick = () => printQr(q);
  } catch (err) { stateBox($('wizQrError'), err, () => loadWizQr(id)); }
}

// ---------- Invite link (/admin/#/invite?token=…): set a password and join, no session needed.

// On load or on a hash change (a signed-in admin pasting the link). The token leaves the address bar at once,
// so it isn't kept in history or shown over a shoulder.
function inviteFromHash() {
  if (!location.hash.startsWith('#/invite')) return false;
  const tok = new URLSearchParams(location.hash.split('?')[1]).get('token');
  history.replaceState(null, '', location.pathname);
  showInvite(tok);
  return true;
}
async function showInvite(tok) {
  const f = $('invite');
  me = null; // stops the background polls while this screen is up
  document.title = `${t('adm.inv.title')} · Smart Fit`;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('inviteFields').hidden = $('inviteSubmit').hidden = false;
  $('inviteLogin').hidden = true;
  $('inviteError').textContent = $('inviteFor').textContent = '';
  $('login').hidden = true;
  $('app').hidden = true;
  f.hidden = false;
  try {
    const r = await call('/invite/check', { method: 'POST', body: { token: tok } });
    $('inviteFor').textContent = t('adm.inv.for', { email: r.email, role: roleName(r.role), store: r.store_name || r.org_name });
    f.username.value = r.email;
    f.password.focus();
  } catch (err) {
    $('inviteFields').hidden = $('inviteSubmit').hidden = true;
    $('inviteLogin').hidden = false;
    $('inviteError').textContent = err.message;
  }
  f.onsubmit = async (e) => {
    e.preventDefault();
    $('inviteError').textContent = '';
    if (f.password.value !== f.repeat.value) { $('inviteError').textContent = t('adm.pw.mismatch'); return f.repeat.focus(); }
    try {
      const r = await call('/invite/accept', { method: 'POST', body: { token: tok, password: f.password.value } });
      store.set('sfToken', r.token);
      f.reset();
      show();
    } catch (err) { $('inviteError').textContent = err.message; }
  };
}

if (!inviteFromHash()) show();
