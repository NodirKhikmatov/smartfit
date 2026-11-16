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

// ---------- Categories (task 36): each organisation's own, from the server. Owners manage them on their page; the
// product form and the filters pick from them. Names are shop text: always set as textContent, never as HTML.
let cats = [];
const catText = (c) => (getLang() === 'ru' && c.name_ru) || c.name;
// A product or report row → its category's name (rows carry category_name/_ru; a row without a category its role).
const catOf = (x) => (x.category_name ? (getLang() === 'ru' && x.category_name_ru) || x.category_name : cat(x.category));
const orgOfStore = (id) => stores.find((s) => String(s.id) === String(id))?.organization_id;
const catsOf = (storeId) => cats.filter((c) => c.organization_id === orgOfStore(storeId));
async function loadCats() {
  try { cats = await call('/categories'); } catch { cats = []; }
}
// The products filter lists the categories of the picked store's organisation (a super-admin without a store: none).
function fillCatFilter() {
  const list = scope ? catsOf(scope) : me.role === 'super' ? [] : cats;
  pf.category.replaceChildren(el('option', { value: '', textContent: t('common.all') }), ...list.map((c) => el('option', { value: c.id, textContent: catText(c) })));
}

// Task 45: the organisation's plan (me.plan; super and the mall role have none, so everything shows for them).
const feat = (f) => !me?.plan || me.plan.features.includes(f);
const PLAN_NAME = { start: 'adm.plan.n_start', pro: 'adm.plan.n_pro', biznes: 'adm.plan.n_biznes' };
const PLAN_STATE = { active: 'adm.plan.s_active', trial: 'adm.plan.s_trial', paid: 'adm.plan.s_paid', grace: 'adm.plan.s_grace', readonly: 'adm.plan.s_readonly' };
const STATE_TONE = { active: 'ok', paid: 'ok', trial: 'accent', grace: 'warn', readonly: 'off' };
const LIMIT_NAME = { stores: 'adm.plan.l_stores', products: 'adm.plan.l_products', kiosks: 'adm.plan.l_kiosks', team: 'adm.plan.l_team' };
const FEATURE_NAME = { stylist: 'adm.plan.f_stylist', instalments: 'adm.plan.f_instalments', points: 'adm.plan.f_points', tryon: 'adm.plan.f_tryon', offers: 'adm.plan.f_offers' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1); // the limit names are written to sit inside the error sentence
const stateBadge = (state) => el('span', { className: `badge ${STATE_TONE[state]}`, textContent: t(PLAN_STATE[state]) });
function planBanner() {
  const p = me.plan;
  const shown = p && ['trial', 'grace', 'readonly'].includes(p.state);
  $('planBanner').hidden = !shown;
  if (!shown) return;
  $('planBanner').className = `notice plan-banner${p.state === 'grace' ? ' warn' : p.state === 'readonly' ? ' danger' : ''}`;
  $('planBannerText').textContent = t({ trial: 'adm.plan.banner_trial', grace: 'adm.plan.banner_grace', readonly: 'adm.plan.banner_readonly' }[p.state],
    { date: dayText(p.state === 'trial' ? p.ends : p.readonly_from) });
  $('planBannerLink').hidden = me.role !== 'owner'; // the Tarif page is the owner's
}

const roleName = (r) => t({ super: 'adm.role_super', owner: 'adm.role_owner', manager: 'adm.role_manager', staff: 'adm.role_staff', mall: 'adm.role_mall' }[r]);

async function show() {
  me = null;
  if (token()) { try { me = await call('/me'); } catch {} }
  $('invite').hidden = true;
  $('login').hidden = !!me;
  $('app').hidden = !me;
  if (!me) return;
  if (me.role === 'staff') return location.replace('/staff/'); // task 28: the shop-floor role has only the staff app
  // Task 37: a mall admin has no store at all and only the mall page (the server refuses everything else).
  const mallRole = me.role === 'mall';
  stores = mallRole ? [] : await call('/stores');
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
  $('navOrgs').hidden = $('navMalls').hidden = me.role !== 'super';
  $('navCats').hidden = !['owner', 'super'].includes(me.role); // managers only use the categories
  $('navOffers').hidden = !['owner', 'super'].includes(me.role) || !feat('offers'); // offers are the owner's, on a plan with them (task 45)
  planBanner();
  for (const li of $('nav').children) if (!li.id || li.id === 'navSettings') li.hidden = mallRole;
  $('navMall').hidden = !mallRole;
  $('userMenu').querySelector('a[href="#/settings"]').hidden = mallRole;
  document.querySelector('.side-inner > .wordmark').href = mallRole ? '#/mall' : '#/dashboard';
  if (!mallRole) await loadCats();
  $('form').store_id.replaceChildren(...stores.map((s) => el('option', { value: s.id, textContent: s.name })));
  render();
  if (!mallRole) pollBadge();
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
  categories: { title: 'adm.route.categories', load: loadCategories },
  offers: { title: 'adm.route.offers', load: loadOffers }, // task 43
  stats: { title: 'adm.route.stats', load: loadStats },
  demand: { title: 'adm.route.demand', load: loadDemand },
  qr: { title: 'adm.route.qr', load: loadQr },
  settings: { title: 'adm.route.settings', load: loadSettings },
  orgs: { title: 'adm.route.orgs', load: loadOrgs },
  malls: { title: 'adm.route.malls', load: loadMalls },
  mall: { title: 'adm.route.mall', load: loadMall, poll: () => loadMall(true) },
  welcome: { title: 'adm.route.welcome', load: loadWelcome },
};
const ACTIONS = {
  orders: [el('button', { type: 'button', className: 'icon-btn', title: t('adm.export'), ariaLabel: t('adm.export'), onclick: () => exportOrders() }, icon('download'))],
  products: [
    el('button', { type: 'button', className: 'icon-btn', title: t('adm.products.export'), ariaLabel: t('adm.products.export'), onclick: () => download('/products/export?' + qs(scoped({})), 'products.csv') }, icon('download')), // task 45
    el('button', { type: 'button', onclick: () => openImport() }, icon('upload'), el('span', { className: 'label', textContent: t('adm.products.import') })),
    el('button', { type: 'button', className: 'primary', onclick: () => openForm(null) }, icon('plus'), el('span', { className: 'label', textContent: t('adm.products.add') })),
  ],
  categories: [el('button', { type: 'button', className: 'primary', onclick: () => openCat(null) }, icon('plus'), el('span', { className: 'label', textContent: t('adm.cats.add') }))],
  offers: [el('button', { type: 'button', className: 'primary', onclick: () => openOffer(null) }, icon('plus'), el('span', { className: 'label', textContent: t('adm.offers.add') }))],
  stats: [el('button', { type: 'button', className: 'icon-btn', title: t('adm.export'), ariaLabel: t('adm.export'), onclick: () => exportStats() }, icon('download'))],
  demand: [el('button', { type: 'button', className: 'icon-btn', title: t('adm.export'), ariaLabel: t('adm.export'), onclick: () => download('/demand/export?' + qs(scoped({ days: demandDays() })), `talab-${demandDays()}d.csv`) }, icon('download'))],
};

function render() {
  route = parseHash(location.hash);
  // A new owner has no store yet: everything but the wizard and their account waits for it. Only owners add stores.
  const welcome = me.role === 'owner' && !stores.length;
  const mallRole = me.role === 'mall';
  if ((welcome && !['welcome', 'settings'].includes(route.route)) || (route.route === 'welcome' && me.role !== 'owner') || (['orgs', 'malls'].includes(route.route) && me.role !== 'super')
    || (['categories', 'offers'].includes(route.route) && !['owner', 'super'].includes(me.role)) || (route.route === 'offers' && !feat('offers')) || (mallRole !== (route.route === 'mall'))) {
    route = parseHash(welcome ? '#/welcome' : mallRole ? '#/mall' : '#/dashboard');
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
  if (me?.role === 'mall') return; // no orders of their own
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
  if (!quiet) loadChecklist();
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
  $('dashSales').textContent = salesLine(s.sales);
  $('dashTopSub').textContent = t('adm.stats.days', { n: days });
  $('dashTop').replaceChildren(...(d.top_sold.length ? d.top_sold.map((x) => el('li', {},
    thumb(x),
    el('span', { className: 'rank-name' }, el('strong', { textContent: x.name ? productName(x) : t('adm.stats.deleted', { id: x.product_id }) }), el('span', { className: 'muted', textContent: catOf(x) })),
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

// Task 45: the new shop's first-run checklist (owner): each line from real data, linking to its page; gone when every
// line is ticked or the owner hides it.
const CHECK = { store: ['adm.check.store', '#/settings'], categories: ['adm.check.categories', '#/categories'], products: ['adm.check.products', '#/products'],
  kiosk_pin: ['adm.check.kiosk_pin', '#/settings'], qr: ['adm.check.qr', '#/qr'], team: ['adm.check.team', '#/settings?tab=team'] };
async function loadChecklist() {
  if (me.role !== 'owner') return ($('checklist').hidden = true);
  let c;
  try {
    c = await call('/checklist');
  } catch { return; } // the dashboard works without it
  $('checklist').hidden = c.done || c.dismissed;
  if ($('checklist').hidden) return;
  $('checkSub').textContent = t('adm.check.sub', { done: c.items.filter((i) => i.done).length, n: c.items.length });
  $('checkList').replaceChildren(...c.items.map((i) => el('li', { className: i.done ? 'done' : '' },
    i.done ? icon('check') : el('span', { className: 'dot', ariaHidden: 'true' }),
    el('a', { href: CHECK[i.key][1], textContent: t(CHECK[i.key][0]) }),
    i.done ? el('span', { className: 'visually-hidden', textContent: t('adm.check.done') }) : null)));
}
$('checkHide').onclick = async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await call('/checklist/dismiss', { method: 'POST' });
    $('checklist').hidden = true;
    $('main').focus({ preventScroll: true });
  } catch (err) { toast(err.message, { tone: 'danger' }); }
  btn.disabled = false;
};

// Task 30: paid orders of the period by how the customer chose: a whole outfit, single items, or the catalogue.
const salesPart = (x) => t('adm.sales.part', { n: x.orders, sum: money(x.revenue) });
const salesLine = (x) => t('adm.sales.split', { outfit: salesPart(x.outfit), single: salesPart(x.single), other: salesPart(x.other) });

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
        el('td', {}, el('strong', { className: 'num', textContent: `№ ${o.number}` }), groupMark(o)),
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
  $('retItem').textContent = `${productName(i)} · ${sizeText(i.size)} · ${som(i.unit_price)}`;
  rf.quantity.max = left;
  rf.quantity.value = 1;
  rf.new_size.replaceChildren(...(i.sizes ? i.sizes.split(',') : sizesFor(i.category)).filter((s) => s !== i.size).map((s) => el('option', { value: s, textContent: s })));
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
const discountLines = (o) => [...(o.bundle_discount ? [[t('common.bundle_off'), o.bundle_discount]] : []), ...(o.promo_discount ? [[t('common.promo_off', { code: o.promo_code }), o.promo_discount]] : []),
  ...(o.points_discount ? [[t('common.points_off'), o.points_discount]] : [])]; // task 34
function totalsBlock(o) {
  return el('dl', { className: 'totals' },
    el('dt', { textContent: t('adm.receipt.subtotal') }), el('dd', { className: 'num', textContent: money(o.subtotal) }),
    ...discountLines(o).flatMap(([label, sum]) => [el('dt', { textContent: label }), el('dd', { className: 'num', textContent: `−${money(sum)}` })]),
    el('dt', { textContent: t('adm.receipt.fee') }), el('dd', { className: 'num', textContent: money(o.delivery_fee) }),
    el('dt', { className: 'total', textContent: t('adm.receipt.total') }), el('dd', { className: 'num total', textContent: money(o.total) }));
}
const method = (o) => (o.payment_method === 'cashier' ? t('adm.order.cashier') : { click: 'Click', payme: 'Payme' }[o.payment_method] || o.payment_method);
// Task 35: an instalment order. The total stays the price; the term and monthly amount are what was shown at checkout.
const instText = (o) => t('adm.order.instalment', { n: o.instalment_months, sum: money(o.instalment_monthly), pct: o.instalment_percent });
// Task 38: this shop's order is one part of a mall order (the other shops' parts are theirs and never shown here).
const groupMark = (o) => (o.group_number ? el('div', { className: 'sizes', textContent: t('adm.order.mall_group', { n: o.group_number }) }) : null);
const instNotice = (o) => (o.instalment_months ? [el('div', { className: 'notice inst' }, icon('info'),
  el('p', {}, el('strong', { textContent: instText(o) }), ' ', ...(o.payment_status === 'pending' ? [t('adm.order.instalment_note')] : [])))] : []);
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
    groupMark(o), ...instNotice(o), el('h3', { textContent: t('adm.order.items') }), itemsList(o, true), totalsBlock(o), ...returnsList(o));
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
    ...(o.instalment_months ? [mk('p', { textContent: instText(o) })] : []),
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
      el('span', { className: 'pending-who' }, el('span', { textContent: o.customer_name }), el('span', { className: 'muted', textContent: [t(o.fulfillment === 'pickup' ? 'adm.orders.pickup' : 'adm.orders.delivery'), o.instalment_months && t('adm.order.instalment_short', { n: o.instalment_months }), o.group_number && t('adm.order.mall_group', { n: o.group_number }), showStore() && o.store_name].filter(Boolean).join(' · ') })),
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
    groupMark(o),
    ...instNotice(o), itemsList(o), totalsBlock(o), err,
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

// ---------- Categories page (task 36): owners add, rename, reorder, hide, delete (only empty ones) and give each a role,
// a size kind and a photo. A super-admin works on the picked store's organisation.
const catOrg = () => (me.role === 'super' ? orgOfStore(scope) : me.organization_id);
const sizesText = (c) => (c.size_kind === 'one' ? t('common.size_one') : c.sizes.length > 6 ? `${c.sizes[0]} – ${c.sizes.at(-1)} (${c.sizes.length})` : c.sizes.join(', '));
async function loadCategories() {
  const seq = (loads.cats = (loads.cats || 0) + 1);
  stateBox($('catsError'));
  if (!catOrg()) return emptyRow($('catRows'), 5, { ic: 'store', title: t('adm.cats.pick_store'), text: t('adm.cats.pick_store_text') });
  const stop = skeletonRows($('catRows'), 5, 5);
  try {
    cats = await call('/categories');
    stop();
    if (seq !== loads.cats) return;
    const list = cats.filter((c) => c.organization_id === catOrg());
    if (!list.length) return emptyRow($('catRows'), 5, { ic: 'bag', title: t('adm.cats.none'), text: t('adm.cats.none_text') });
    $('catRows').replaceChildren(...list.map((c, i) => el('tr', {},
      el('td', {}, el('span', { className: 'prod' },
        c.image_url ? el('img', { className: 'thumb', src: c.image_url, alt: '', loading: 'lazy' }) : el('span', { className: 'thumb ph' }, icon(c.role || 'hanger')),
        el('span', {},
          el('button', { type: 'button', className: 'name-btn', textContent: catText(c), onclick: () => openCat(c) }),
          el('span', { className: 'sizes' }, getLang() === 'ru' ? c.name : c.name_ru, c.hidden ? el('span', { className: 'badge', textContent: t('adm.cats.hidden') }) : null,
            c.audience === 'child' ? el('span', { className: 'badge', textContent: t('audience.child') }) : null)))),
      el('td', { className: 'hide-sm', textContent: c.role ? cat(c.role) : t('adm.cats.role_none') }),
      el('td', { className: 'hide-sm', textContent: sizesText(c) }),
      el('td', { className: 'num', textContent: c.products }),
      el('td', {}, el('span', { className: 'order' }, moveBtn(list, i, -1), moveBtn(list, i, 1))))));
  } catch (err) {
    stop();
    if (seq === loads.cats) { $('catRows').replaceChildren(); stateBox($('catsError'), err, () => loadCategories()); }
  }
}
// ↑ / ↓ swaps two neighbours; every category whose place changed gets its new position as `sort`.
function moveBtn(list, i, d) {
  const other = list[i + d], up = d < 0;
  return el('button', { type: 'button', className: `icon-btn ghost${up ? ' up' : ''}`, disabled: !other, title: t(up ? 'adm.cats.up' : 'adm.cats.down'),
    ariaLabel: t(up ? 'adm.cats.up_aria' : 'adm.cats.down_aria', { name: catText(list[i]) }), onclick: async () => {
      const next = [...list];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      try {
        for (const [j, c] of next.entries()) if (c.sort !== j + 1) await call(`/categories/${c.id}`, { method: 'PATCH', body: { sort: j + 1 } });
      } catch (err) { toast(err.message, { tone: 'danger' }); }
      loadCategories();
    } }, icon('chevron-down'));
}
const cf = $('catForm');
let editingCat = null;
function openCat(c) {
  editingCat = c;
  cf.reset();
  $('catDlgError').textContent = $('catImgError').textContent = '';
  $('catTitle').textContent = c ? t('adm.cats.edit_title', { name: catText(c) }) : t('adm.cats.add');
  for (const k of ['name', 'name_ru', 'size_kind']) cf[k].value = c?.[k] ?? (k === 'size_kind' ? 'one' : '');
  cf.audience.value = c?.audience ?? 'adult';
  cf.role.value = c?.role ?? '';
  cf.sizes.value = c?.size_kind === 'custom' ? c.sizes.join(', ') : '';
  cf.hidden.checked = Boolean(c?.hidden);
  $('catDelete').hidden = !c || c.products > 0;
  $('catImgWrap').hidden = !c;
  $('catImgNote').hidden = Boolean(c);
  $('catImgFile').value = '';
  showCatImage(c?.image_url);
  catKind();
  $('catDlg').showModal();
}
// A role fixes the size kind (the engine matches the customer's sizes); only a role-less category picks its own.
// Task 40: for children the role's kind is the children's one (92–164 by height, shoes 22–35), and a children's kind
// is always for children.
const KIDS_KINDS = ['kids', 'kids_shoes'];
function catKind() {
  const role = cf.role.value;
  if (role) {
    const kind = { outerwear: 'clothes', top: 'clothes', bottom: 'clothes', shoes: 'shoes', accessory: 'one' }[role];
    cf.size_kind.value = cf.audience.value === 'child' ? { clothes: 'kids', shoes: 'kids_shoes' }[kind] ?? kind : kind;
  } else if (KIDS_KINDS.includes(cf.size_kind.value)) cf.audience.value = 'child';
  cf.audience.disabled = !role && KIDS_KINDS.includes(cf.size_kind.value);
  cf.size_kind.disabled = Boolean(role);
  const custom = cf.size_kind.value === 'custom';
  $('catSizesWrap').hidden = !custom;
  cf.sizes.required = custom;
  $('catSizesHint').textContent = [custom && t('adm.cats.sizes_hint'), editingCat?.products > 0 && t('adm.cats.in_use', { n: editingCat.products })].filter(Boolean).join(' ');
}
cf.role.onchange = cf.size_kind.onchange = cf.audience.onchange = catKind;
$('catCancel').onclick = () => $('catDlg').close();
cf.onsubmit = async (e) => {
  e.preventDefault();
  $('catDlgError').textContent = '';
  if (!cf.reportValidity()) return;
  const body = {
    name: cf.name.value, name_ru: cf.name_ru.value, role: cf.role.value || null, audience: cf.audience.value, size_kind: cf.size_kind.value,
    sizes: cf.size_kind.value === 'custom' ? cf.sizes.value : null, hidden: cf.hidden.checked,
    ...(!editingCat && me.role === 'super' && { organization_id: catOrg() }),
  };
  $('catSave').disabled = true;
  try {
    const c = await call(editingCat ? `/categories/${editingCat.id}` : '/categories', { method: editingCat ? 'PATCH' : 'POST', body });
    toast(t(editingCat ? 'adm.cats.saved' : 'adm.cats.added', { name: catText(c) }), { tone: 'ok' });
    if (editingCat) $('catDlg').close();
    else openCat(c); // a new one stays open for its photo
    loadCategories();
  } catch (err) { $('catDlgError').textContent = err.message; } finally { $('catSave').disabled = false; }
};
$('catDelete').onclick = async () => {
  const c = editingCat;
  if (!(await confirmDialog({ title: t('adm.cats.delete_title', { name: catText(c) }), text: t('adm.cats.delete_text'), ok: t('common.delete'), danger: true }))) return;
  try {
    await call(`/categories/${c.id}`, { method: 'DELETE' });
    $('catDlg').close();
    toast(t('adm.cats.deleted'));
    loadCategories();
  } catch (err) { $('catDlgError').textContent = err.message; }
};
function showCatImage(url) {
  $('catImg').hidden = $('catImgRemove').hidden = !url;
  if (url) $('catImg').src = url;
}
$('catImgUpload').onclick = async () => {
  const file = $('catImgFile').files[0];
  $('catImgError').textContent = '';
  if (!file) return void ($('catImgError').textContent = t('adm.form.image_pick'));
  if (file.size > 2 * 1024 * 1024) return void ($('catImgError').textContent = t('adm.form.image_big'));
  try {
    const r = await call(`/categories/${editingCat.id}/image`, { method: 'POST', raw: file, type: file.type || 'application/octet-stream' });
    editingCat.image_url = r.image_url;
    showCatImage(r.image_url);
    $('catImgFile').value = '';
    loadCategories();
  } catch (err) { $('catImgError').textContent = err.message; }
};
$('catImgRemove').onclick = async () => {
  try {
    await call(`/categories/${editingCat.id}/image`, { method: 'DELETE' });
    editingCat.image_url = null;
    showCatImage(null);
    loadCategories();
  } catch (err) { $('catImgError').textContent = err.message; }
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
  $('productHead').replaceChildren(el('th', { className: 'pick-col' }, el('span', { className: 'visually-hidden', textContent: t('adm.labels.pick') })), th('name', t('adm.products.name')), th('cat', t('adm.products.category'), 'hide-sm'), ...(showStore() ? [th('store', t('common.store'), 'hide-sm')] : []),
    th('price', t('adm.products.price'), 'num hide-sm'), th('stock', t('adm.products.stock')), el('th', { className: 'hide-sm' }, el('span', { className: 'visually-hidden', textContent: t('adm.actions') })));
}

async function loadProducts() {
  const seq = (loads.products = (loads.products || 0) + 1);
  const p = route.params;
  seg($('productTabs'), PRODUCT_TABS.map(([v, k]) => [v, t(k)]), p.filter || '', (v) => setParams({ ...p, filter: v, page: '' }));
  if (document.activeElement !== pf.q) pf.q.value = p.q || '';
  fillCatFilter();
  pf.category.value = p.category || '';
  productHead();
  const cols = showStore() ? 7 : 6;
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
        el('td', { className: 'pick-col' }, labelBox(x)),
        el('td', {}, el('span', { className: 'prod' }, thumb(x), el('span', {},
          el('button', { type: 'button', className: 'name-btn', textContent: productName(x), onclick: () => openForm(x) }),
          el('span', { className: 'sizes' }, x.sku || '', x.image_url ? null : el('span', { className: 'badge warn', textContent: t('adm.products.no_image') })),
          el('span', { className: 'show-sm' }, price(x))))),
        el('td', { className: 'hide-sm', textContent: catOf(x) }),
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
// Task 32: QR labels. Ticked products (kept across pages and filters) print as a sheet, `copies` labels each; every
// code opens that item's page for its store on the customer's phone (GET /labels gives the URL and the SVG).
const labelPick = new Set();
function labelBar() {
  $('labelBar').hidden = !labelPick.size;
  $('labelCount').textContent = t('adm.labels.count', { n: labelPick.size });
}
function labelBox(x) {
  const box = el('input', { type: 'checkbox', checked: labelPick.has(x.id), ariaLabel: t('adm.labels.pick_aria', { name: productName(x) }) });
  box.onchange = () => {
    if (box.checked && labelPick.size >= LABELS_MAX) {
      box.checked = false;
      return toast(t('adm.labels.max', { n: LABELS_MAX }), { tone: 'danger' });
    }
    labelPick[box.checked ? 'add' : 'delete'](x.id);
    labelBar();
  };
  return box;
}
const LABELS_MAX = 100; // the server's cap per sheet
const LABEL_CSS = '@page{size:A4;margin:8mm}*{box-sizing:border-box}body{margin:0;font:9pt/1.25 system-ui,sans-serif;color:black}'
  + '.sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:3mm}.label{display:flex;gap:2.5mm;align-items:center;height:33mm;padding:2.5mm;border:0.3mm dashed #888;break-inside:avoid;overflow:hidden}'
  + '.qr{flex:none;width:28mm;height:28mm}.qr svg{display:block;width:100%;height:100%}.txt{min-width:0}.txt strong{display:block;font-size:10.5pt;overflow-wrap:anywhere}'
  + '.txt small{display:block;color:#333;margin-top:1mm;overflow-wrap:anywhere}';
$('labelClear').onclick = () => {
  labelPick.clear();
  labelBar();
  document.querySelectorAll('#rows .pick-col input').forEach((b) => { b.checked = false; });
};
$('labelPrint').onclick = async () => {
  const copies = Math.min(Math.max(Number.parseInt($('labelCopies').value, 10) || 1, 1), 20);
  $('labelCopies').value = copies;
  $('labelPrint').disabled = true;
  try {
    const { items } = await call('/labels?' + qs({ ids: [...labelPick].join(',') }));
    printFrame(t('adm.labels.doc'), LABEL_CSS, (body, mk) => body.append(mk('div', { className: 'sheet' }, ...items.flatMap((x) => Array.from({ length: copies }, () => {
      const qr = mk('div', { className: 'qr' });
      qr.innerHTML = x.svg; // generated by our server from the label URL (path data only)
      return mk('div', { className: 'label' }, qr, mk('div', { className: 'txt' }, mk('strong', { textContent: productName(x) }),
        mk('small', { textContent: [x.sku, x.store_name].filter(Boolean).join(' · ') }), mk('small', { textContent: t('adm.labels.scan') })));
    })))));
  } catch (err) {
    toast(err.message, { tone: 'danger' });
  } finally {
    $('labelPrint').disabled = false;
  }
};

const reloadProducts = () => (route.route === 'products' ? loadProducts() : route.route === 'dashboard' ? loadDashboard(true) : null);

function renderStock(sizes, stock = []) {
  $('stock').replaceChildren(...sizes.map((size) => {
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
  for (const k of ['name', 'name_ru', 'gender', 'color', 'style', 'price', 'discount_price', 'temp_min', 'temp_max', 'shelf_location', 'sku', 'barcode', 'description', 'description_ru']) f[k].value = p?.[k] ?? '';
  if (!p) f.gender.value = 'unisex';
  // A role-less product is stored as worn in any weather (−60…60): the form shows those as empty.
  if (p && !p.category && p.temp_min === -60 && p.temp_max === 60) f.temp_min.value = f.temp_max.value = '';
  f.waterproof.checked = !!p?.waterproof;
  f.store_id.value = p?.store_id ?? (scope || stores[0]?.id || '');
  f.store_id.disabled = !!p;
  fillFormCats(p);
  renderDetails(p?.details);
  renderFit(p);
  $('imgWrap').hidden = !p;
  $('formDelete').hidden = !p;
  $('imgError').textContent = '';
  $('imgFile').value = '';
  showImage(p?.image_url);
  $('dlg').showModal();
}
// The product's store decides which organisation's categories it can take (a new product: the picked store).
function fillFormCats(p) {
  const f = $('form'), list = catsOf(f.store_id.value);
  f.category.replaceChildren(...list.map((c) => el('option', { value: c.id, textContent: c.hidden ? `${catText(c)} (${t('adm.cats.hidden')})` : catText(c) })));
  const pick = p ? list.find((c) => c.id === p.category_id) ?? list.find((c) => c.role === p.category) : list.find((c) => c.role === 'top') ?? list[0];
  f.category.value = pick?.id ?? '';
  applyCat();
}
const formCat = () => cats.find((c) => String(c.id) === $('form').category.value);
// Temperature and waterproof only matter for a category that is part of an outfit; a role-less one hides them.
function applyCat() {
  const f = $('form'), c = formCat(), outfit = Boolean(c?.role);
  for (const x of f.querySelectorAll('[data-outfit]')) x.hidden = !outfit;
  f.temp_min.required = f.temp_max.required = outfit;
  $('roleNote').hidden = outfit || !c;
  // Task 40: a children's category's genders read boy / girl / any (the same values: male / female / unisex).
  const kid = c?.audience === 'child';
  for (const [id, adult, child] of [['gUnisex', 'gender.unisex', 'adm.form.kid_any'], ['gMale', 'gender.male', 'kiosk.child.boy'], ['gFemale', 'gender.female', 'kiosk.child.girl']]) {
    $(id).dataset.i18n = kid ? child : adult;
    $(id).textContent = t($(id).dataset.i18n);
  }
  renderStock(c?.sizes ?? [], editing?.stock);
}
$('form').category.onchange = applyCat;
$('form').store_id.onchange = () => fillFormCats(null);
const DETAILS_MAX = 10;
function detailRow(d = {}) {
  const row = el('div', { className: 'detail-row' },
    el('input', { maxLength: 40, value: d.name ?? '', ariaLabel: t('field.detail_name'), placeholder: t('adm.form.detail_name_ph') }),
    el('input', { maxLength: 120, value: d.value ?? '', ariaLabel: t('field.detail_value'), placeholder: t('adm.form.detail_value_ph') }),
    el('button', { type: 'button', className: 'icon-btn ghost', title: t('adm.form.detail_remove'), ariaLabel: t('adm.form.detail_remove'), onclick: () => { row.remove(); detailBtn(); } }, icon('close')));
  return row;
}
const detailBtn = () => { $('detailAdd').hidden = $('details').children.length >= DETAILS_MAX; };
function renderDetails(list) {
  $('details').replaceChildren(...(list || []).map(detailRow));
  detailBtn();
}
$('detailAdd').onclick = () => {
  $('details').append(detailRow());
  detailBtn();
  $('details').lastElementChild.querySelector('input').focus();
};
const readDetails = () => [...$('details').children].map((r) => {
  const [name, value] = r.querySelectorAll('input');
  return { name: name.value, value: value.value };
});
$('cancel').onclick = () => $('dlg').close();
$('formDelete').onclick = async () => { if (await remove(editing)) $('dlg').close(); };
$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const num = (v) => (v === '' ? null : Number(v));
  const body = {
    name: f.name.value, name_ru: f.name_ru.value || null, category_id: Number(f.category.value) || null, gender: f.gender.value, color: f.color.value,
    style: f.style.value || null, price: num(f.price.value), discount_price: num(f.discount_price.value),
    temp_min: f.temp_min.required ? num(f.temp_min.value) : null, temp_max: f.temp_max.required ? num(f.temp_max.value) : null,
    waterproof: f.temp_min.required && f.waterproof.checked,
    description: f.description.value.trim() || null, description_ru: f.description_ru.value.trim() || null, details: readDetails(),
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
  $('fitWrap').hidden = !p || !p.category || p.category === 'accessory' || !p.fit;
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

$('importCols').textContent = 'id, sku, barcode, store_id, name, name_ru, category, gender, color, style, price, discount_price, temp_min, temp_max, waterproof, shelf_location, description, description_ru, XS, S, M, L, XL, XXL, 36 … 45, ONE';
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
  $('statsSales').textContent = salesLine(s.sales);
  // Task 35: only once there are instalment orders in the period, so a store without them sees the page as before.
  $('statsInst').hidden = !s.instalments.orders;
  $('statsInst').textContent = t('adm.stats.instalments', { n: s.instalments.orders, share: s.instalments.share, sum: money(s.instalments.avg_total) });
  $('topRows').replaceChildren(...(s.top.length ? s.top.map((x) => el('li', {},
    el('span', { className: 'rank-name' }, el('strong', { textContent: x.name ? productName(x) : t('adm.stats.deleted', { id: x.product_id }) }), el('span', { className: 'muted', textContent: catOf(x) })),
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
  const stop = skeletonRows($('demandRows'), 7);
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
  if (!d.items.length) emptyRow($('demandRows'), 7, { ic: 'check', title: t('adm.demand.empty'), text: t('adm.demand.empty_text') });
  else $('demandRows').replaceChildren(...d.items.map((x) => el('tr', {},
    el('td', {}, el('span', { className: 'demand-name' }, el('strong', { textContent: productName(x) }),
      el('span', { className: 'sizes', textContent: [x.sku || catOf(x), withStore && x.store_name].filter(Boolean).join(' · ') }),
      el('span', { className: 'show-sm', textContent: [`${t('adm.demand.size')}: ${sizeText(x.size)}`, x.waiting && `${t('adm.demand.waiting')}: ${x.waiting}`].filter(Boolean).join(' · ') }))), // phones: size and waiting columns hide
    el('td', { className: 'hide-sm', textContent: sizeText(x.size) }),
    el('td', { className: 'num', textContent: x.missed }),
    el('td', { className: 'num hide-sm', textContent: x.waiting }), // task 31: "Kelganda xabar bering" requests still open
    el('td', { className: 'num hide-sm', textContent: x.sold }),
    el('td', { className: 'num hide-sm', textContent: x.stock }),
    el('td', { className: 'num' }, el('strong', { textContent: x.suggest })))));

  // Task 32: garment labels scanned the most and bought the least first.
  if (!d.scans.length) emptyRow($('scanRows'), 4, { ic: 'qr', title: t('adm.scans.empty'), text: t('adm.scans.empty_text') });
  else $('scanRows').replaceChildren(...d.scans.map((x) => el('tr', {},
    el('td', {}, el('span', { className: 'demand-name' }, el('strong', { textContent: productName(x) }),
      el('span', { className: 'sizes', textContent: [x.sku || catOf(x), withStore && x.store_name].filter(Boolean).join(' · ') }))),
    el('td', { className: 'num', textContent: x.scans }),
    el('td', { className: 'num hide-sm', textContent: x.sold }),
    el('td', { className: 'num' }, el('strong', { textContent: `${x.rate}%` })))));

  $('dropSub').textContent = t('adm.drop.sub', { n: f.total.start });
  if (!f.total.start) $('dropFunnel').replaceChildren(emptyState({ ic: 'sparkle', title: t('adm.drop.empty'), text: t('adm.drop.empty_text') }));
  else funnelChart($('dropFunnel'), DROP.map(([k, label]) => ({ label: t(label), value: f.total[k] })), { pct: (v, base) => (base ? `${dec(share(v, base))}%` : '—') });
  const head = (first) => el('tr', {}, el('th', { textContent: t(first) }), ...DROP.map(([, label]) => el('th', { className: 'num', textContent: t(label) })));
  const cells = (x) => DROP.map(([k]) => el('td', { className: 'num', textContent: x[k] }));
  // Task 30: the same funnel for customers who chose a whole outfit and for those who came for single items.
  $('dropModeHead').replaceChildren(head('adm.drop.mode'));
  $('dropModeRows').replaceChildren(...f.per_mode.map((m) => el('tr', {}, el('td', { textContent: t(MODE_NAME[m.mode]) }), ...cells(m))));
  $('dropKioskHead').replaceChildren(head('adm.drop.kiosk'));
  if (!f.per_kiosk.length) emptyRow($('dropKioskRows'), 6, { ic: 'store', title: t('adm.drop.empty'), text: t('adm.drop.empty_text') });
  else $('dropKioskRows').replaceChildren(...f.per_kiosk.map((k) => el('tr', {},
    el('td', { textContent: [k.kiosk ? t('adm.drop.kiosk_n', { id: k.kiosk }) : t('adm.drop.phone'), withStore && storeName(k.store_id)].filter(Boolean).join(' · ') }), ...cells(k))));
  // Task 29: how the size was found, with the "how did it fit?" answers per way (accuracy = share answered "right").
  $('methodRows').replaceChildren(...d.methods.map((m) => el('tr', {},
    el('td', { textContent: t(METHOD_NAME[m.method]) }), el('td', { className: 'num', textContent: m.customers }), el('td', { className: 'num hide-sm', textContent: m.answers }),
    ...['small', 'right', 'big'].map((k) => el('td', { className: 'num hide-sm', textContent: m[k] })),
    el('td', { className: 'num' }, el('strong', { textContent: m.accuracy === null ? '—' : `${m.accuracy}%` })))));
  // Task 33: customers and paid orders per "Qayerga kiyasiz?" answer (null = not picked).
  $('occasionRows').replaceChildren(...d.occasions.map((o) => el('tr', {},
    el('td', { textContent: t(o.occasion ? `kiosk.occasion.${o.occasion}` : 'adm.occasion.none') }),
    el('td', { className: 'num', textContent: o.customers }), el('td', { className: 'num', textContent: o.orders }))));
  $('dropDayHead').replaceChildren(head('adm.stats.day'));
  $('dropDayRows').replaceChildren(...f.per_day.slice().reverse().map((x) => el('tr', {}, el('td', { textContent: day(x.day) }), ...cells(x))));
}

const MODE_NAME = { outfit: 'adm.drop.mode_outfit', single: 'adm.drop.mode_single' };
const METHOD_NAME = { full: 'adm.method.full', torso: 'adm.method.torso', upper: 'adm.method.upper', usual: 'adm.method.usual', tape: 'adm.method.tape', body: 'adm.method.body', profile: 'adm.method.profile' };

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

const SET_TABS = [['store', 'adm.set.store'], ['team', 'adm.set.team'], ['promo', 'adm.set.promo'], ['points', 'adm.set.points'], ['sync', 'adm.set.sync'], ['audit', 'adm.set.audit'], ['plan', 'adm.set.plan'], ['account', 'adm.set.account']];
function loadSettings() {
  const tabs = SET_TABS.filter(([k]) => (me.role !== 'manager' || ['store', 'points', 'account'].includes(k)) && (k !== 'plan' || me.role === 'owner'));
  const tab = tabs.some(([k]) => k === route.params.tab) ? route.params.tab : stores.length ? 'store' : 'account'; // a new owner has no store yet
  $('setTabs').replaceChildren(...tabs.map(([k, label]) => {
    const a = el('a', { className: 'chip', href: buildHash('settings', k === 'store' ? {} : { tab: k }), textContent: t(label) });
    if (k === tab) a.setAttribute('aria-current', 'page');
    return a;
  }));
  for (const s of document.querySelectorAll('[data-tab]')) s.hidden = s.dataset.tab !== tab;
  ({ store: loadStore, team: loadTeam, promo: loadPromos, points: loadPoints, sync: loadKeys, audit: loadAudit, plan: loadPlan, account: loadAccount })[tab]();
}

// Task 45: the "Tarif" tab (owner): plan and state, the dates, each limit with what counts toward it now, the features.
// No prices here: the team sends the invoice; the button opens the landing page's contact form.
async function loadPlan() {
  const seq = (loads.plan = (loads.plan || 0) + 1);
  let p;
  try {
    p = await call('/plan');
  } catch (err) {
    if (seq === loads.plan) stateBox($('planError'), err, () => loadPlan());
    return;
  }
  if (seq !== loads.plan) return;
  stateBox($('planError'));
  $('planTitle').textContent = t('adm.plan.title', { name: t(PLAN_NAME[p.plan]) });
  $('planState').className = `badge ${STATE_TONE[p.state]}`;
  $('planState').textContent = t(PLAN_STATE[p.state]);
  const fact = (k, v) => [el('dt', { textContent: t(k) }), el('dd', { textContent: v })];
  $('planFacts').replaceChildren(
    ...(p.trial_until ? fact('adm.plan.trial_until', dayText(p.trial_until)) : []),
    ...(p.paid_until ? fact('adm.plan.paid_until', dayText(p.paid_until)) : []),
    ...(p.ends ? [...fact('adm.plan.grace_until', dayText(p.grace_until)), ...fact('adm.plan.readonly_from', dayText(p.readonly_from))] : fact('adm.plan.ends', t('adm.plan.no_end'))));
  $('planLimits').replaceChildren(...Object.entries(p.limits).map(([k, x]) => el('li', {},
    el('span', { className: 'grow' }, el('span', { textContent: cap(t(LIMIT_NAME[k])) }),
      x.used >= x.max ? el('span', { className: 'sizes', textContent: t(x.used > x.max ? 'adm.plan.over' : 'adm.plan.full') }) : null),
    el('meter', { min: 0, max: x.max, value: Math.min(x.used, x.max), high: x.max * 0.8, optimum: 0, ariaLabel: cap(t(LIMIT_NAME[k])) }),
    el('strong', { className: 'num', textContent: t('adm.plan.used', { used: x.used, max: x.max }) }))));
  $('planFeatures').replaceChildren(...Object.entries(p.features).map(([k, on]) => el('li', {},
    el('span', { className: 'grow', textContent: t(FEATURE_NAME[k]) }),
    el('span', { className: `badge ${on ? 'ok' : 'off'}`, textContent: t(on ? 'adm.plan.on' : 'adm.plan.off') }))));
}

// Task 34: cashback points of the organisation the picked store belongs to (owner/super edit; a manager reads), the
// total customers can still spend and the customers with points (a manager: those from orders of their store).
const ptf = $('pointsForm');
const pointsStore = () => scope || String(stores[0]?.id ?? me.store_id ?? '');
// Task 39: the search (name or phone) narrows the list, the KPIs and the CSV alike.
const pointsQuery = () => qs({ store_id: pointsStore(), q: $('pointsFilter').q.value.trim() });
async function loadPoints() {
  const seq = (loads.points = (loads.points || 0) + 1);
  $('pointsError').textContent = '';
  $('pointsFields').disabled = true;
  $('pointsKpis').replaceChildren(...kpiSkeleton(2));
  const stop = skeletonRows($('pointsRows'), 6, 3);
  try {
    const p = await call(`/points?${pointsQuery()}`);
    if (seq !== loads.points) return;
    stateBox($('pointsLoadError'));
    ptf.cashback_percent.value = p.cashback_percent;
    ptf.points_max_share.value = p.points_max_share;
    ptf.points_expiry_months.value = p.points_expiry_months;
    $('pointsFields').disabled = !p.can_edit || !feat('points');
    $('pointsReadOnly').hidden = p.can_edit;
    $('pointsPlanOff').hidden = feat('points'); // task 45: the list and the CSV stay; earning, spending and edits wait for the plan
    $('pointsSave').hidden = !p.can_edit;
    $('pointsKpis').replaceChildren(
      kpi({ label: t('adm.points.outstanding'), value: money(p.outstanding) }),
      kpi({ label: t('adm.points.count'), value: fmt.num(p.count), sub: p.cashback_percent ? t('adm.points.on', { pct: p.cashback_percent }) : t('adm.points.off') }));
    if (!p.customers.length && $('pointsFilter').q.value.trim()) emptyRow($('pointsRows'), 6, { ic: 'search', title: t('adm.points.found_none'), text: t('adm.points.found_none_text') });
    else if (!p.customers.length) emptyRow($('pointsRows'), 6, { ic: 'sparkle', title: t('adm.points.none'), text: t(p.cashback_percent ? 'adm.points.none_text' : 'adm.points.off_text') });
    else {
      $('pointsRows').replaceChildren(...p.customers.map((c) => el('tr', {},
        el('td', {}, el('strong', { textContent: c.name || '—' }), el('div', { className: 'sizes', textContent: c.phone })),
        el('td', { className: 'num', textContent: money(c.balance) }),
        el('td', { className: 'num hide-sm', textContent: money(c.earned) }),
        el('td', { className: 'num hide-sm', textContent: money(c.spent) }),
        el('td', { className: 'hide-sm', textContent: c.last_at ? fmt.dateTime(c.last_at) : '' }),
        el('td', { className: 'pts-act' }, ...(p.can_edit ? [el('button', { type: 'button', className: 'icon-btn ghost', title: t('adm.points.adjust'), ariaLabel: `${t('adm.points.adjust')}: ${c.name || c.phone}`, onclick: (e) => openAdjust(c, e.currentTarget) }, icon('edit'))] : [])))));
    }
    $('pointsMore').textContent = p.count > p.customers.length ? t('adm.points.more', { n: p.customers.length, total: p.count }) : '';
  } catch (err) {
    if (seq !== loads.points) return;
    $('pointsRows').replaceChildren();
    $('pointsKpis').replaceChildren();
    stateBox($('pointsLoadError'), err, () => loadPoints());
  } finally {
    stop?.();
  }
}
ptf.onsubmit = async (e) => {
  e.preventDefault();
  $('pointsError').textContent = '';
  if (!ptf.reportValidity()) return;
  $('pointsSave').disabled = true;
  try {
    await call('/points', { method: 'PATCH', body: { store_id: Number(pointsStore()), cashback_percent: Number(ptf.cashback_percent.value), points_max_share: Number(ptf.points_max_share.value), points_expiry_months: Number(ptf.points_expiry_months.value) } });
    toast(t('adm.points.saved'));
    loadPoints();
  } catch (err) {
    $('pointsError').textContent = err.message;
  } finally {
    $('pointsSave').disabled = false;
  }
};

let pointsTimer;
$('pointsFilter').oninput = () => { clearTimeout(pointsTimer); pointsTimer = setTimeout(loadPoints, 300); };
$('pointsFilter').onsubmit = (e) => { e.preventDefault(); clearTimeout(pointsTimer); loadPoints(); };
$('pointsExport').onclick = () => download(`/points/export?${pointsQuery()}`, `points-${new Date().toLocaleDateString('sv-SE', { timeZone: TZ })}.csv`);

// Task 39: the owner's correction of one customer's balance (+/− with a reason). The server keeps it at or above zero.
const paf = $('pointsAdjForm');
let adjusting = null, adjustFrom = null;
function openAdjust(c, from) {
  adjusting = c;
  adjustFrom = from;
  paf.reset();
  $('pointsDlgError').textContent = '';
  $('pointsDlgWho').textContent = t('adm.points.adjust_for', { name: c.name || c.phone, sum: money(c.balance) });
  $('pointsDlg').showModal();
}
$('pointsDlgCancel').onclick = () => $('pointsDlg').close();
$('pointsDlg').addEventListener('close', () => adjustFrom?.isConnected && adjustFrom.focus());
paf.onsubmit = async (e) => {
  e.preventDefault();
  $('pointsDlgError').textContent = '';
  if (!paf.reportValidity()) return;
  $('pointsDlgSave').disabled = true;
  try {
    const r = await call('/points/adjust', { method: 'POST', body: { store_id: Number(pointsStore()), profile_id: adjusting.id, amount: Number(paf.sign.value) * Number(paf.amount.value), reason: paf.reason.value.trim() } });
    $('pointsDlg').close();
    toast(t('adm.points.adjust_done', { sum: money(r.balance) }));
    loadPoints();
  } catch (err) { $('pointsDlgError').textContent = err.message; } finally { $('pointsDlgSave').disabled = false; }
};

// Store profile. A super-admin picks the store here (defaults to the sidebar's); everyone else has one.
const STORE_FIELDS = ['name', 'city', 'address', 'lat', 'lon', 'opens_at', 'closes_at', 'delivery_fee', 'free_delivery_threshold', 'telegram_chat_id', 'low_stock_threshold', 'report_chat_id', 'bundle_percent', 'tryon_daily_limit'];
const sf = $('storeForm');
// Task 35: one row per possible term (the server's TERM_MONTHS): offered or not, and its markup percent.
const TERM_MONTHS = [3, 6, 9, 12, 18, 24];
$('instTerms').replaceChildren(...TERM_MONTHS.map((n) => el('div', { className: 'inst-term' },
  el('label', { className: 'check' }, el('input', { type: 'checkbox', name: `inst_${n}` }), el('span', { textContent: t('adm.set.instalment_months', { n }) })),
  el('label', { className: 'field' }, el('span', { textContent: t('adm.set.instalment_percent') }),
    el('input', { name: `inst_pct_${n}`, type: 'number', min: 0, max: 100, step: 1, inputMode: 'numeric', value: 0, ariaLabel: `${t('adm.set.instalment_months', { n })}: ${t('adm.set.instalment_percent')}` })))));
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
    sf.instalment_on.checked = s.instalment_on;
    sf.tryon_on.checked = s.tryon_on;
    loadTryon(s.id, seq);
    for (const n of TERM_MONTHS) {
      const term = s.instalment_terms.find((x) => x.months === n);
      sf[`inst_${n}`].checked = Boolean(term);
      sf[`inst_pct_${n}`].value = term?.percent ?? 0;
    }
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
// Task 41: AI try-on pictures per day (the shop pays per picture); a note when the provider's key is not in .env.
async function loadTryon(id, seq) {
  let r;
  try {
    r = await call(`/stores/${id}/tryon`);
  } catch {
    r = null;
  }
  if (seq !== loads.store) return;
  $('tryonNoKey').hidden = !r || r.available;
  $('instPlanOff').hidden = feat('instalments'); // task 45: the setting is kept, the plan switches it off
  $('tryonPlanOff').hidden = feat('tryon');
  const used = r?.days.filter((d) => d.count > 0) ?? [];
  $('tryonUsage').replaceChildren(...(used.length ? used.map((d) => el('li', {}, el('span', { textContent: fmt.date(`${d.day}T12:00:00+05:00`) }), el('strong', { textContent: t('adm.set.tryon_count', { n: d.count }) })))
    : [el('li', { className: 'muted', textContent: r ? t('adm.set.tryon_none') : t('common.error') })]));
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
    instalment_on: sf.instalment_on.checked,
    instalment_terms: TERM_MONTHS.filter((n) => sf[`inst_${n}`].checked).map((n) => ({ months: n, percent: Number(v(`inst_pct_${n}`)) })),
    tryon_on: sf.tryon_on.checked, tryon_daily_limit: Number(v('tryon_daily_limit')),
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

// ---------- Offers (task 43): the shop owner's. Text and pictures go to the mall screen and kiosk after the mall
// admin approves them (a shop outside any mall publishes at once); its own start screen shows them without approval.
let offers = [], editingOffer = null;
const offerText = (o, k = 'title') => (getLang() === 'ru' && o[`${k}_ru`]) || o[k] || '';
const OFFER_STATES = { draft: ['adm.offers.st_draft', 'off'], submitted: ['adm.offers.st_submitted', 'warn'], approved: ['adm.offers.st_approved', 'ok'], rejected: ['adm.offers.st_rejected', 'danger'] };
const offerBadge = (o) => {
  const [key, tone] = o.status === 'approved' && !o.mall_id ? ['adm.offers.st_published', 'ok'] : OFFER_STATES[o.status];
  return el('span', { className: `badge ${tone}`, textContent: t(key) });
};
const offerDates = (o) => el('span', { className: 'offer-dates' }, el('span', { className: 'num', textContent: `${dayText(o.starts_on)} – ${dayText(o.ends_on)}` }),
  el('span', { className: 'sizes', textContent: t(o.live ? 'adm.offers.live' : 'adm.offers.not_live') }));
const offerThumb = (o) => (o.image_url ? el('img', { className: 'thumb', src: o.image_url, alt: '', loading: 'lazy' }) : el('span', { className: 'thumb ph' }, icon('sparkle')));
const offerCounts = (o) => el('td', { className: 'num hide-sm', textContent: `${fmt.num(o.shown)} / ${fmt.num(o.tapped)}` });
async function loadOffers() {
  const seq = (loads.offers = (loads.offers || 0) + 1);
  stateBox($('offersError'));
  const stop = skeletonRows($('offerRows'), 5, 3);
  try {
    const list = await call('/offers?' + qs(scoped({})));
    stop();
    if (seq !== loads.offers) return;
    offers = list;
    if (!list.length) return emptyRow($('offerRows'), 5, { ic: 'sparkle', title: t('adm.offers.none'), text: t('adm.offers.none_text') });
    $('offerRows').replaceChildren(...list.map((o) => el('tr', {},
      el('td', {}, el('span', { className: 'prod' }, offerThumb(o),
        el('span', {}, el('button', { type: 'button', className: 'name-btn', textContent: offerText(o), onclick: () => openOffer(o) }),
          el('span', { className: 'sizes', textContent: [many() && o.store_name, o.link && linkText(o.link)].filter(Boolean).join(' · ') })))),
      el('td', { className: 'hide-sm' }, offerDates(o)),
      el('td', {}, offerBadge(o), o.status === 'rejected' && o.reject_reason ? el('div', { className: 'sizes', textContent: t('adm.offers.reason', { reason: o.reject_reason }) }) : null),
      offerCounts(o),
      el('td', { className: 'row-actions' },
        ['draft', 'rejected'].includes(o.status) ? iconBtn('arrow-right', t(o.in_mall ? 'adm.offers.submit_named' : 'adm.offers.publish_named', { title: offerText(o) }), () => submitOffer(o)) : null,
        iconBtn('edit', t('adm.offers.edit_named', { title: offerText(o) }), () => openOffer(o))))));
  } catch (err) {
    stop();
    if (seq === loads.offers) { $('offerRows').replaceChildren(); stateBox($('offersError'), err, () => loadOffers()); }
  }
}
const linkText = (l) => (l.kind === 'promo' ? t('adm.offers.link_code', { code: l.code ?? '—' }) : productName(l));
async function submitOffer(o) {
  try {
    const r = await call(`/offers/${o.id}/submit`, { method: 'POST' });
    toast(t(r.status === 'submitted' ? 'adm.offers.sent' : 'adm.offers.published'), { tone: 'ok' });
  } catch (err) { toast(err.message, { tone: 'danger' }); }
  loadOffers();
}
const ofm = $('offerForm');
function openOffer(o) {
  editingOffer = o;
  ofm.reset();
  $('offerDlgError').textContent = $('offerImgError').textContent = '';
  $('offerTitle').textContent = o ? t('adm.offers.edit_title', { title: offerText(o) }) : t('adm.offers.add');
  $('offerReason').hidden = !(o?.status === 'rejected' && o.reject_reason);
  $('offerReason').textContent = o?.reject_reason ? t('adm.offers.reason', { reason: o.reject_reason }) : '';
  ofm.store_id.replaceChildren(...stores.map((s) => el('option', { value: s.id, textContent: s.name })));
  ofm.store_id.value = o?.store_id ?? (scope || stores[0]?.id || '');
  ofm.store_id.disabled = Boolean(o); // an offer stays in its store
  $('offerStoreWrap').hidden = !many();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  for (const k of ['title', 'title_ru', 'body', 'body_ru']) ofm[k].value = o?.[k] ?? '';
  ofm.starts_on.value = o?.starts_on ?? today;
  ofm.ends_on.value = o?.ends_on ?? '';
  ofm.link.value = o?.promo_code_id ? 'promo' : o?.product_id ? 'product' : '';
  $('offerDelete').hidden = !o;
  $('offerImgWrap').hidden = !o;
  $('offerImgNote').hidden = Boolean(o);
  $('offerImgFile').value = '';
  showOfferImage(o?.image_url);
  offerLink();
  $('offerDlg').showModal();
}
// The link's own picker: the store's promo codes (shown publicly, the hint says so) or one of its products.
async function offerLink() {
  const kind = ofm.link.value, sid = Number(ofm.store_id.value);
  $('offerPromoWrap').hidden = $('offerPromoHint').hidden = kind !== 'promo';
  $('offerQWrap').hidden = $('offerProductWrap').hidden = $('offerProductHint').hidden = kind !== 'product';
  try {
    if (kind === 'promo') {
      const org = stores.find((s) => s.id === sid)?.organization_id;
      const list = (await call('/promos')).filter((p) => p.organization_id === org && (!p.store_id || p.store_id === sid));
      ofm.promo_code_id.replaceChildren(...list.map((p) => el('option', { value: p.id, textContent: p.active ? p.code : `${p.code} (${t('adm.promo.off')})` })));
      if (editingOffer?.promo_code_id) ofm.promo_code_id.value = editingOffer.promo_code_id;
    } else if (kind === 'product') await offerProducts();
  } catch (err) { $('offerDlgError').textContent = err.message; }
}
async function offerProducts() {
  const r = await call('/products?' + qs({ store_id: ofm.store_id.value, q: ofm.product_q.value.trim(), sort: 'name', limit: 50 }));
  const keep = editingOffer?.product_id && !r.items.some((p) => p.id === editingOffer.product_id) && editingOffer.link?.kind === 'product';
  ofm.product_id.replaceChildren(...(keep ? [el('option', { value: editingOffer.product_id, textContent: productName(editingOffer.link) })] : []),
    ...r.items.map((p) => el('option', { value: p.id, textContent: productName(p) })));
  if (editingOffer?.product_id) ofm.product_id.value = editingOffer.product_id;
}
ofm.link.onchange = offerLink;
ofm.store_id.onchange = offerLink;
let offerQTimer;
ofm.product_q.oninput = () => { clearTimeout(offerQTimer); offerQTimer = setTimeout(() => offerProducts().catch((err) => { $('offerDlgError').textContent = err.message; }), 300); };
function showOfferImage(url) {
  $('offerImg').hidden = !url;
  if (url) $('offerImg').src = url;
}
$('offerCancel').onclick = () => $('offerDlg').close();
ofm.onsubmit = async (e) => {
  e.preventDefault();
  $('offerDlgError').textContent = '';
  if (!ofm.reportValidity()) return;
  const kind = ofm.link.value;
  const body = {
    title: ofm.title.value.trim(), title_ru: ofm.title_ru.value.trim(), body: ofm.body.value.trim() || null, body_ru: ofm.body_ru.value.trim() || null,
    starts_on: ofm.starts_on.value, ends_on: ofm.ends_on.value,
    promo_code_id: kind === 'promo' && ofm.promo_code_id.value ? Number(ofm.promo_code_id.value) : null,
    product_id: kind === 'product' && ofm.product_id.value ? Number(ofm.product_id.value) : null,
    ...(!editingOffer && { store_id: Number(ofm.store_id.value) }),
  };
  $('offerSave').disabled = true;
  try {
    const o = await call(editingOffer ? `/offers/${editingOffer.id}` : '/offers', { method: editingOffer ? 'PATCH' : 'POST', body });
    toast(t('adm.offers.saved'), { tone: 'ok' });
    loadOffers();
    if (editingOffer) $('offerDlg').close();
    else openOffer(o); // the picture comes next
  } catch (err) { $('offerDlgError').textContent = err.message; } finally { $('offerSave').disabled = false; }
};
$('offerImgUpload').onclick = async () => {
  const file = $('offerImgFile').files[0];
  $('offerImgError').textContent = '';
  if (!file) return void ($('offerImgError').textContent = t('adm.form.image_pick'));
  if (file.size > 2 * 1024 * 1024) return void ($('offerImgError').textContent = t('adm.form.image_big'));
  try {
    editingOffer = await call(`/offers/${editingOffer.id}/image`, { method: 'POST', raw: file, type: file.type || 'application/octet-stream' });
    showOfferImage(editingOffer.image_url);
    $('offerImgFile').value = '';
    loadOffers();
  } catch (err) { $('offerImgError').textContent = err.message; }
};
$('offerDelete').onclick = async () => {
  const o = editingOffer;
  if (!(await confirmDialog({ title: t('adm.offers.delete_title'), text: t('adm.offers.delete_text', { title: offerText(o) }), ok: t('common.delete'), cancel: t('common.cancel'), danger: true }))) return;
  try {
    await call(`/offers/${o.id}`, { method: 'DELETE' });
    $('offerDlg').close();
    toast(t('adm.offers.deleted'), { tone: 'ok' });
    loadOffers();
  } catch (err) { $('offerDlgError').textContent = err.message; }
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
  bundle_percent: 'field.bundle_percent', instalment_on: 'adm.set.instalment_on', tryon_on: 'adm.set.tryon_on', tryon_daily_limit: 'field.tryon_limit', instalment_terms: 'field.instalment_terms', store_id: 'common.store', kind: 'field.promo_kind', value: 'field.promo_value', min_order: 'field.promo_min',
  description: 'field.description', description_ru: 'field.description_ru', details: 'field.details', size_kind: 'field.size_kind', sizes: 'field.cat_sizes', audience: 'field.audience',
  hidden: 'adm.cats.hide', sort: 'adm.cats.order',
  title: 'field.offer_title', title_ru: 'field.offer_title_ru', body: 'field.offer_body', body_ru: 'field.offer_body_ru', reject_reason: 'field.offer_reason', // task 43
  promo_code_id: 'adm.offers.link_promo', product_id: 'adm.offers.link_product', seconds: 'field.slide_seconds', order: 'field.slide_order',
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
  if (k === 'role') return CATEGORIES.includes(v) ? cat(v) : roleName(v); // a category's outfit role, or an admin's
  if (k === 'category') return CATEGORIES.includes(v) ? cat(v) : String(v); // older rows: the role; task 36: the name
  if (k === 'size_kind') return t(`adm.cats.kind_${v}`);
  if (k === 'audience') return t(`audience.${v}`);
  if (k === 'details') return Array.isArray(v) ? v.map((d) => `${d.name}: ${d.value}`).join('; ') : String(v);
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
for (const e of ['product', 'category', 'order', 'fitting', 'store', 'team', 'account', 'sync_key', 'stock', 'points']) af.entity.append(el('option', { value: e, textContent: t(`adm.ent.${e}`) }));
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
  const stop = [skeletonRows($('orgRows'), 8, 3), skeletonRows($('demoRows'), 5, 3)];
  const offset = offsetOf(route.params.page, LIMIT);
  try {
    const [orgs, demo] = await Promise.all([call('/orgs'), call('/demo-requests?' + qs({ limit: LIMIT, offset }))]);
    stop.forEach((f) => f());
    if (seq !== loads.orgs) return;
    stateBox($('orgError'));
    stateBox($('demoError'));
    const num = (n, cls = '') => el('td', { className: `num ${cls}`, textContent: n });
    if (!orgs.length) emptyRow($('orgRows'), 8, { ic: 'store', title: t('adm.orgs.empty'), text: t('adm.orgs.empty_text') });
    else $('orgRows').replaceChildren(...orgs.map((o) => el('tr', {}, el('td', {}, el('strong', { textContent: o.name })),
      el('td', {}, el('div', { textContent: t(PLAN_NAME[o.plan]) }), stateBadge(o.state)),
      el('td', { className: 'hide-sm num', textContent: o.ends ? dayText(o.ends) : t('adm.plan.no_end') }),
      num(o.stores), num(o.admins, 'hide-sm'), num(o.invites, 'hide-sm'), el('td', { className: 'hide-sm', textContent: fmt.dateTime(o.created_at) }),
      el('td', { className: 'row-actions' }, el('button', { type: 'button', onclick: (e) => openPlan(o, e.currentTarget) }, t('adm.orgs.plan_edit'))))));
    // Task 45: ending soon = read-only, in grace, or the last paid / trial day within 14 days; the soonest first.
    const soon = addDaysKey(14);
    const ending = orgs.filter((o) => o.ends && (o.state === 'grace' || o.state === 'readonly' || o.ends <= soon)).sort((a, b) => a.ends.localeCompare(b.ends));
    $('orgEnding').replaceChildren(...(ending.length ? ending.map((o) => el('li', {},
      el('div', { className: 'grow' }, el('strong', { textContent: o.name }), el('div', { className: 'sizes', textContent: [t(PLAN_NAME[o.plan]), t('adm.orgs.ends_on', { date: dayText(o.ends) }), o.note].filter(Boolean).join(' · ') })),
      stateBadge(o.state),
      el('button', { type: 'button', onclick: (e) => openPlan(o, e.currentTarget) }, t('adm.orgs.plan_edit')))) :
      [el('li', { className: 'li-empty' }, emptyState({ ic: 'check', title: t('adm.orgs.ending_empty'), text: t('adm.orgs.ending_empty_text') }))]));
    if (!demo.items.length) emptyRow($('demoRows'), 5, { ic: 'user', title: t('adm.demo.empty'), text: t('adm.demo.empty_text') });
    else $('demoRows').replaceChildren(...demo.items.map((d) => el('tr', { className: d.handled_at ? 'done' : '' },
      el('td', { className: 'hide-sm num', textContent: fmt.dateTime(d.created_at) }),
      el('td', {}, el('strong', { textContent: d.company }), el('div', { className: 'sizes', textContent: [d.city, d.stores && t('adm.demo.stores', { n: d.stores }), d.lang.toUpperCase()].filter(Boolean).join(' · ') })),
      el('td', {}, el('div', { textContent: d.name }), el('a', { href: `tel:${d.phone}`, className: 'num', textContent: d.phone })),
      el('td', { className: 'hide-sm msg', textContent: d.message || '—' }),
      el('td', { className: 'row-actions' }, d.handled_at ? null : el('button', { type: 'button', onclick: (e) => openOrg('demo', e.currentTarget, d) }, t('adm.demo.create')),
        el('button', { type: 'button', className: d.handled_at ? 'ghost' : '', onclick: (e) => setHandled(d, !d.handled_at, e.currentTarget) },
          t(d.handled_at ? 'adm.demo.reopen' : 'adm.demo.handle'))))));
    pager($('demoPager'), demo, (page) => setParams({ ...route.params, page }));
  } catch (err) {
    stop.forEach((f) => f());
    if (seq === loads.orgs) { $('orgRows').replaceChildren(); $('demoRows').replaceChildren(); stateBox($('orgError'), err, () => loadOrgs()); }
  }
}
const addDaysKey = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: TZ });

// Task 45: super sets an organisation's plan and paid-until day (the invoice is sent outside the app), with a note
// that goes to the audit log. Empty date = no paid period (the trial's end, if any, counts).
const pf2 = $('planForm');
let planOrg = null;
pf2.plan.replaceChildren(...Object.keys(PLAN_NAME).map((k) => el('option', { value: k, textContent: t(PLAN_NAME[k]) })));
function openPlan(o, opener) {
  planOrg = o;
  pf2.reset();
  $('planDlgError').textContent = '';
  $('planDlgTitle').textContent = t('adm.orgs.plan_title', { name: o.name });
  $('planDlgNow').textContent = [t(PLAN_STATE[o.state]), o.trial_until && t('adm.orgs.trial_on', { date: dayText(o.trial_until) }), o.ends && t('adm.orgs.ends_on', { date: dayText(o.ends) })].filter(Boolean).join(' · ');
  pf2.plan.value = o.plan;
  pf2.paid_until.value = o.paid_until ?? '';
  $('planDlg').opener = opener;
  $('planDlg').showModal();
}
$('planCancel').onclick = () => $('planDlg').close();
$('planDlg').addEventListener('close', () => $('planDlg').opener?.focus());
pf2.onsubmit = async (e) => {
  e.preventDefault();
  $('planDlgError').textContent = '';
  if (!pf2.reportValidity()) return;
  try {
    await call(`/orgs/${planOrg.id}/plan`, { method: 'PATCH', body: { plan: pf2.plan.value, paid_until: pf2.paid_until.value || null, note: pf2.note.value.trim() } });
    $('planDlg').close();
    toast(t('adm.orgs.plan_saved'), { tone: 'ok' });
    loadOrgs();
  } catch (err) { $('planDlgError').textContent = err.message; }
};

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
// Task 37: the same dialog invites a shop into the mall for a mall admin (POST /mall/shops).
// Task 45: and turns a demo request into its organisation and owner invite (kind 'demo', the request's company filled in).
let orgFor = 'orgs', orgDemo = null;
function openOrg(kind, opener, demo = null) {
  orgFor = kind;
  orgDemo = demo;
  of2.reset();
  orgStep(false);
  $('orgDlgError').textContent = '';
  $('orgTitle').textContent = t(kind === 'shops' ? 'adm.mall.invite' : kind === 'demo' ? 'adm.demo.create' : 'adm.orgs.add');
  $('orgAsk').querySelector('p').textContent = t(kind === 'shops' ? 'adm.mall.invite_text' : kind === 'demo' ? 'adm.demo.create_text' : 'adm.orgs.add_text');
  if (demo) of2.name.value = demo.company;
  of2.name.previousElementSibling.textContent = t(kind === 'shops' ? 'field.shop_name' : 'field.org_name');
  $('orgDlg').opener = opener;
  $('orgDlg').showModal();
}
$('orgBtn').onclick = () => openOrg('orgs', $('orgBtn'));
$('shopInviteBtn').onclick = () => openOrg('shops', $('shopInviteBtn'));
$('orgCancel').onclick = () => $('orgDlg').close();
$('orgDlg').addEventListener('close', () => {
  $('orgUrl').value = ''; // the owner's link is shown once
  if (!$('orgDone').hidden) (orgFor === 'shops' ? loadMall(true) : loadOrgs());
  ($('orgDlg').opener ?? $('orgBtn')).focus();
});
of2.onsubmit = async (e) => {
  e.preventDefault();
  $('orgDlgError').textContent = '';
  try {
    const r = await call(orgFor === 'shops' ? '/mall/shops' : orgFor === 'demo' ? `/demo-requests/${orgDemo.id}/org` : '/orgs', { method: 'POST', body: { name: of2.name.value.trim(), owner_email: of2.owner_email.value.trim() } });
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
    $('inviteFor').textContent = t('adm.inv.for', { email: r.email, role: roleName(r.role), store: r.store_name || r.org_name || r.mall_name });
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

// ---------- Task 37: malls. Super: "Savdo markazlari" (malls, their shops and admins). Mall admin: their mall's
// dashboard (summary numbers per shop, the directory entries, shop invites, the mall QR). Names are DB text: textContent only.

let malls = [], editingMall = null, mallMode = 'create';
const iconBtn = (ic, label, onclick) => el('button', { type: 'button', className: 'icon-btn ghost', title: label, ariaLabel: label, onclick }, icon(ic));
const placeOf = (s) => [s.floor && t('adm.mall.floor', { n: s.floor }), s.unit && t('adm.mall.unit', { n: s.unit })].filter(Boolean).join(' · ');

async function loadMalls() {
  const seq = (loads.malls = (loads.malls || 0) + 1);
  const stop = skeletonRows($('mallRows'), 4, 3);
  try {
    const list = await call('/malls');
    stop();
    if (seq !== loads.malls) return;
    malls = list;
    stateBox($('mallsError'));
    if (!malls.length) return emptyRow($('mallRows'), 4, { ic: 'map-pin', title: t('adm.malls.empty'), text: t('adm.malls.empty_text') });
    $('mallRows').replaceChildren(...malls.map((m) => el('tr', {},
      el('td', {}, el('strong', { textContent: m.name }), el('div', { className: 'sizes', textContent: `${m.city}, ${m.address}` })),
      el('td', { textContent: m.stores.map((s) => s.name).join(', ') || '—' }),
      el('td', { className: 'hide-sm', textContent: [...m.admins.map((a) => (a.disabled ? `${a.email} (${t('adm.team.disabled')})` : a.email)),
        m.invites && t('adm.malls.invites', { n: m.invites })].filter(Boolean).join(', ') || '—' }),
      el('td', { className: 'row-actions' },
        iconBtn('edit', t('adm.mall.edit_named', { name: m.name }), () => openMall('edit', m)),
        iconBtn('user', t('adm.malls.invite_admin'), () => openMall('invite', m)),
        iconBtn('trash', t('common.delete'), () => deleteMall(m))))));
  } catch (err) {
    stop();
    if (seq === loads.malls) { $('mallRows').replaceChildren(); stateBox($('mallsError'), err, () => loadMalls()); }
  }
}
async function deleteMall(m) {
  if (!(await confirmDialog({ title: t('adm.malls.delete_title', { name: m.name }), text: t('adm.malls.delete_text'), ok: t('common.delete'), danger: true }))) return;
  try {
    await call(`/malls/${m.id}`, { method: 'DELETE' });
    toast(t('adm.malls.deleted'), { tone: 'ok' });
    loadMalls();
  } catch (err) { toast(err.message, { tone: 'danger' }); }
}

// One dialog, four modes: create (super: profile + admin email → link), edit (super: profile + its stores),
// invite (super: another admin link), self (mall admin: their profile + logo).
const mf = $('mallForm');
const MALL_PARTS = { create: ['profile', 'email'], edit: ['profile', 'stores'], invite: ['email'], self: ['profile', 'logo'] };
function mallStep(done) {
  $('mallAsk').hidden = done;
  $('mallDone').hidden = !done;
  $('mallSave').hidden = done;
  $('mallCopy').hidden = !done;
  $('mallCancel').textContent = t(done ? 'common.close' : 'common.cancel');
}
function openMall(mode, m = null) {
  mallMode = mode;
  editingMall = m;
  mf.reset();
  mallStep(false);
  $('mallDlgError').textContent = $('mallImgError').textContent = '';
  for (const part of mf.querySelectorAll('[data-mall]')) part.hidden = !MALL_PARTS[mode].includes(part.dataset.mall);
  $('mallDlgTitle').textContent = mode === 'create' ? t('adm.malls.add') : mode === 'invite' ? t('adm.malls.invite_admin') : t('adm.mall.edit');
  $('mallDlgText').textContent = mode === 'create' ? t('adm.malls.add_text') : mode === 'invite' ? t('adm.malls.invite_text', { name: m.name }) : '';
  $('mallSave').textContent = t(mode === 'create' || mode === 'invite' ? 'adm.orgs.create' : 'adm.form.save');
  mf.email.required = MALL_PARTS[mode].includes('email');
  if (m) for (const k of ['name', 'city', 'address', 'lat', 'lon']) mf[k].value = m[k] ?? '';
  if (mode === 'edit') {
    // Every store: ticked when in this mall; a store in another mall can't be ticked here (it leaves that one first).
    const elsewhere = new Map(malls.filter((x) => x.id !== m.id).flatMap((x) => x.stores.map((s) => [s.id, x.name])));
    $('mallStores').replaceChildren(...stores.map((s) => el('label', { className: 'check' },
      el('input', { type: 'checkbox', name: 'store', value: s.id, checked: m.stores.some((x) => x.id === s.id), disabled: elsewhere.has(s.id) }),
      el('span', { textContent: elsewhere.has(s.id) ? `${s.name} — ${elsewhere.get(s.id)}` : s.name }))));
  }
  if (mode === 'self') showMallLogo(m.logo_url);
  $('mallDlg').showModal();
}
$('mallAddBtn').onclick = () => openMall('create');
$('mallEditBtn').onclick = () => mallData && openMall('self', mallData.mall);
$('mallCancel').onclick = () => $('mallDlg').close();
$('mallDlg').addEventListener('close', () => {
  $('mallUrl').value = ''; // the admin's link is shown once
  if (!$('mallDone').hidden) loadMalls();
});
mf.onsubmit = async (e) => {
  e.preventDefault();
  $('mallDlgError').textContent = '';
  const profile = Object.fromEntries(['name', 'city', 'address', 'lat', 'lon'].map((k) => [k, mf[k].value.trim() || null]));
  try {
    if (mallMode === 'create' || mallMode === 'invite') {
      const r = mallMode === 'create'
        ? (await call('/malls', { method: 'POST', body: { ...profile, admin_email: mf.email.value.trim() } })).invite
        : await call(`/malls/${editingMall.id}/invites`, { method: 'POST', body: { email: mf.email.value.trim() } });
      $('mallUrl').value = r.url;
      $('mallExpiry').textContent = t('adm.team.link_expiry', { at: fmt.dateTime(r.expires_at) });
      mallStep(true);
      $('mallUrl').focus();
      $('mallUrl').select();
      return;
    }
    if (mallMode === 'edit') {
      const ids = [...mf.querySelectorAll('input[name=store]:checked')].map((i) => Number(i.value));
      await call(`/malls/${editingMall.id}`, { method: 'PATCH', body: { ...profile, store_ids: ids } });
      loadMalls();
    } else {
      await call('/mall', { method: 'PATCH', body: profile });
      loadMall();
    }
    $('mallDlg').close();
    toast(t('adm.form.saved'), { tone: 'ok' });
  } catch (err) { $('mallDlgError').textContent = err.message; }
};
$('mallCopy').onclick = () => navigator.clipboard?.writeText($('mallUrl').value)
  .then(() => toast(t('adm.qr.copied'), { tone: 'ok' }), () => toast(t('common.error'), { tone: 'danger' }));

// Logo uploads (the mall's, a shop's directory logo): same limits as product photos.
async function uploadLogo(fileInput, errBox, path) {
  const file = fileInput.files[0];
  errBox.textContent = '';
  if (!file) return void (errBox.textContent = t('adm.form.image_pick'));
  if (file.size > 2 * 1024 * 1024) return void (errBox.textContent = t('adm.form.image_big'));
  try {
    const r = await call(path, { method: 'POST', raw: file, type: file.type || 'application/octet-stream' });
    fileInput.value = '';
    loadMall(true);
    return r.logo_url;
  } catch (err) { errBox.textContent = err.message; }
}
async function removeLogo(errBox, path) {
  try {
    await call(path, { method: 'DELETE' });
    loadMall(true);
    return true;
  } catch (err) { errBox.textContent = err.message; }
}
function showMallLogo(url) {
  $('mallImg').hidden = $('mallImgRemove').hidden = !url;
  if (url) $('mallImg').src = url;
}
$('mallImgUpload').onclick = async () => {
  const url = await uploadLogo($('mallImgFile'), $('mallImgError'), '/mall/logo');
  if (url) showMallLogo(url);
};
$('mallImgRemove').onclick = async () => (await removeLogo($('mallImgError'), '/mall/logo')) && showMallLogo(null);

// The mall admin's dashboard (#/mall?days=30).
let mallData = null, mallQr = null, editingEntry = null;
async function loadMall(quiet = false) {
  const seq = (loads.mall = (loads.mall || 0) + 1);
  const days = route.params.days === '30' ? 30 : 7;
  seg($('mallDays'), [['7', t('adm.stats.days', { n: 7 })], ['30', t('adm.stats.days', { n: 30 })]], String(days), (v) => setParams({ ...route.params, days: v === '7' ? '' : v }));
  const stop = quiet ? () => {} : skeletonRows($('mallShopRows'), 6, 3);
  try {
    const [d, qr, mo, map] = await Promise.all([call(`/mall?days=${days}`), mallQr ?? call('/mall/qr'), call('/mall/offers'), call('/mall/map')]);
    stop();
    if (seq !== loads.mall) return;
    mallData = d;
    mallQr = qr;
    stateBox($('mallError'));
    drawMall(d, qr);
    drawMallOffers(mo);
    drawMallMap(map);
  } catch (err) {
    stop();
    if (seq === loads.mall) { $('mallShopRows').replaceChildren(); stateBox($('mallError'), err, () => loadMall()); }
  }
}
function drawMall({ mall, days, totals, shops, pending }, qr) {
  const n = (v) => fmt.num(v);
  $('mallKpis').replaceChildren(
    kpi({ label: t('adm.mall.k_shops'), value: n(totals.shops) }),
    kpi({ label: t('adm.mall.k_visits', { n: days }), value: n(totals.visits), sub: t('adm.mall.kiosk_n', { n: totals.kiosk_visits }) }),
    kpi({ label: t('adm.mall.k_orders', { n: days }), value: n(totals.orders) }),
    kpi({ label: t('adm.mall.k_kiosks'), value: n(totals.kiosks_online) }),
    kpi({ label: t('adm.mall.k_outfits', { n: days }), value: n(totals.mall_outfits) })); // task 42
  if (!shops.length) emptyRow($('mallShopRows'), 6, { ic: 'store', title: t('adm.mall.empty'), text: t('adm.mall.empty_text') });
  else $('mallShopRows').replaceChildren(...shops.map((s) => el('tr', {},
    el('td', {}, el('span', { className: 'prod' },
      s.logo_url ? el('img', { className: 'thumb', src: s.logo_url, alt: '' }) : el('span', { className: 'thumb ph' }, icon('store')),
      el('span', {}, el('button', { type: 'button', className: 'name-btn', textContent: s.name, onclick: () => openEntry(s) }),
        el('span', { className: 'sizes' }, s.org_name !== s.name ? s.org_name : null, s.hidden ? el('span', { className: 'badge', textContent: t('adm.mall.hidden') }) : null)))),
    el('td', { className: 'hide-sm', textContent: placeOf(s) || '—' }),
    el('td', { className: 'num', title: t('adm.mall.visits_split', { kiosk: s.visits.kiosk, phone: s.visits.phone }) }, n(s.visits.kiosk + s.visits.phone),
      el('div', { className: 'sizes', textContent: t('adm.mall.kiosk_n', { n: s.visits.kiosk }) })),
    el('td', { className: 'num', textContent: n(s.orders) }),
    el('td', { className: 'hide-sm' }, s.kiosks.count
      ? el('span', { className: `badge ${s.kiosks.online ? 'ok' : 'warn'}`, textContent: t('adm.mall.online_of', { n: s.kiosks.online, of: s.kiosks.count }) })
      : el('span', { className: 'muted', textContent: '—' })),
    el('td', { className: 'row-actions' }, iconBtn('edit', t('adm.mall.entry_named', { name: s.name }), () => openEntry(s))))));
  $('mallPending').replaceChildren(...(pending.length ? [el('h3', { className: 'section-title', textContent: t('adm.mall.pending') }),
    el('ul', { className: 'plain-list' }, ...pending.map((p) => el('li', {}, el('strong', { textContent: p.name }), ' — ',
      el('span', { className: 'muted', textContent: t(p.invite_open ? 'adm.mall.pending_open' : 'adm.mall.pending_expired') }))))] : []));
  $('mallProfile').replaceChildren(...[
    mall.logo_url && el('img', { className: 'cat-photo', src: mall.logo_url, alt: '' }),
    el('p', {}, el('strong', { textContent: mall.name })),
    el('p', { className: 'muted', textContent: `${mall.city}, ${mall.address}` }),
    mall.lat != null && el('p', { className: 'muted num', textContent: `${mall.lat}, ${mall.lon}` })].filter(Boolean));
  const img = el('div', { className: 'qr-img' });
  img.innerHTML = qr.svg; // generated by our server from the mall URL (path data only)
  img.firstElementChild?.setAttribute('aria-hidden', 'true');
  const copy = (url) => navigator.clipboard?.writeText(url).then(() => toast(t('adm.qr.copied')), () => toast(t('common.error'), { tone: 'danger' }));
  $('mallQr').replaceChildren(img, el('p', { className: 'muted qr-url', textContent: qr.url }),
    el('div', { className: 'actions' },
      el('button', { type: 'button', onclick: () => copy(qr.url) }, t('adm.qr.copy')),
      el('button', { type: 'button', className: 'primary', onclick: () => printQr({ ...qr, name: mall.name }) }, icon('print'), t('adm.qrdlg.print'))),
    el('p', { className: 'hint', textContent: t('adm.mall.kiosk_link') }), el('p', { className: 'muted qr-url', textContent: qr.kiosk_url }),
    el('div', { className: 'actions' }, el('button', { type: 'button', onclick: () => copy(qr.kiosk_url) }, t('adm.qr.copy'))));
}

// Task 43: offers shops submitted to this mall. Waiting ones get approve / reject; approved ones are the idle slides,
// in this order (↑ / ↓) and for the seconds below; rejected ones keep their reason (the shop sees it) and can be approved.
let rejecting = null;
function drawMallOffers({ seconds, offers: list }) {
  if (document.activeElement !== $('slideForm').seconds) $('slideForm').seconds.value = seconds;
  if (!list.length) return emptyRow($('mallOfferRows'), 5, { ic: 'sparkle', title: t('adm.mall.offers_none'), text: t('adm.mall.offers_none_text') });
  const shown = list.filter((o) => o.status === 'approved');
  $('mallOfferRows').replaceChildren(...list.map((o) => {
    const name = offerText(o), i = shown.indexOf(o);
    const move = (d) => {
      const b = iconBtn('chevron-down', t(d < 0 ? 'adm.cats.up_aria' : 'adm.cats.down_aria', { name }), async () => {
        const order = shown.map((x) => x.id);
        [order[i], order[i + d]] = [order[i + d], order[i]];
        try { await call('/mall/slides', { method: 'PATCH', body: { order } }); } catch (err) { toast(err.message, { tone: 'danger' }); }
        loadMall(true);
      });
      b.classList.toggle('up', d < 0);
      return b;
    };
    return el('tr', {},
      el('td', {}, el('span', { className: 'prod' }, offerThumb(o),
        el('span', {}, el('strong', { textContent: name }),
          o.body || o.body_ru ? el('span', { className: 'sizes offer-body-cell', textContent: offerText(o, 'body') }) : null,
          el('span', { className: 'sizes', textContent: [o.store_name, placeOf(o), o.link && linkText(o.link)].filter(Boolean).join(' · ') })))),
      el('td', { className: 'hide-sm' }, offerDates(o)),
      el('td', {}, offerBadge(o), o.status === 'rejected' && o.reject_reason ? el('div', { className: 'sizes', textContent: t('adm.offers.reason', { reason: o.reject_reason }) }) : null),
      offerCounts(o),
      el('td', { className: 'row-actions' },
        o.status !== 'approved' ? iconBtn('check', t('adm.mall.approve_named', { title: name }), () => approveOffer(o)) : null,
        o.status !== 'rejected' ? iconBtn('close', t('adm.mall.reject_named', { title: name }), () => openReject(o)) : null,
        i > 0 ? move(-1) : null, i >= 0 && i < shown.length - 1 ? move(1) : null));
  }));
}
async function approveOffer(o) {
  try {
    await call(`/mall/offers/${o.id}/approve`, { method: 'POST' });
    toast(t('adm.mall.approved'), { tone: 'ok' });
  } catch (err) { toast(err.message, { tone: 'danger' }); }
  loadMall(true);
}
const rejf = $('rejectForm');
function openReject(o) {
  rejecting = o;
  rejf.reset();
  $('rejectError').textContent = '';
  $('rejectTitle').textContent = t('adm.mall.reject_named', { title: offerText(o) });
  $('rejectDlg').showModal();
}
$('rejectCancel').onclick = () => $('rejectDlg').close();
rejf.onsubmit = async (e) => {
  e.preventDefault();
  $('rejectError').textContent = '';
  if (!rejf.reportValidity()) return;
  try {
    await call(`/mall/offers/${rejecting.id}/reject`, { method: 'POST', body: { reason: rejf.reason.value.trim() } });
    $('rejectDlg').close();
    toast(t('adm.mall.rejected'), { tone: 'ok' });
    loadMall(true);
  } catch (err) { $('rejectError').textContent = err.message; }
};
$('slideForm').onsubmit = async (e) => {
  e.preventDefault();
  $('slideError').textContent = '';
  if (!e.target.reportValidity()) return;
  try {
    await call('/mall/slides', { method: 'PATCH', body: { seconds: Number(e.target.seconds.value) } });
    toast(t('adm.form.saved'), { tone: 'ok' });
  } catch (err) { $('slideError').textContent = err.message; }
};

// ---------- Task 44: the mall map. One plan picture per floor (the floors are the shops' floor values); a tap on the
// plan opens the pin dialog with that place filled in, for a shop of that floor or a mall kiosk. The pins are buttons
// placed with CSS custom properties (CSSOM: the CSP has no inline styles). No drag-and-drop: mouse and touch tap, and
// a keyboard user opens the same dialog with "Belgi qo'yish" and types the place.
let mapData = null, mapJson = '', mapFloor = null, pinning = null;
const PLAN_BYTES = 2 * 1024 * 1024, PLAN_PX = 4096; // the server's limits (src/admin/malls.js)
const pct = (v) => Math.min(100, Math.max(0, Math.round(v * 100) / 100));
function drawMallMap(d, force = false) {
  const json = getLang() + JSON.stringify(d);
  if (!force && json === mapJson) return; // a quiet poll must not drop a chosen file or the focus
  mapJson = json;
  mapData = d;
  const floor = d.floors.find((f) => f.id === mapFloor) ?? d.floors[0];
  mapFloor = floor?.id ?? null;
  seg($('mapFloorTabs'), d.floors.map((f) => [f.id, t('adm.mall.floor', { n: f.name })]), mapFloor, (v) => { mapFloor = v; drawMallMap(mapData, true); });
  if (!floor) return $('mapBody').replaceChildren(el('p', { className: 'muted', textContent: t('adm.map.no_floors') }));
  const file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' }), err = el('p', { className: 'error', role: 'alert' });
  const upload = el('div', { className: 'bar' },
    el('label', { className: 'grow' }, el('span', { textContent: t('adm.map.plan_hint', { px: PLAN_PX }) }), ' ', file),
    el('button', { type: 'button', onclick: () => uploadPlan(floor, file, err) }, icon('upload'), t(floor.plan_url ? 'adm.map.plan_replace' : 'adm.map.plan_upload')),
    floor.plan_url ? el('button', { type: 'button', className: 'danger', onclick: () => removePlan(floor, err) }, icon('trash'), t('adm.map.plan_remove')) : null);
  if (!floor.plan_url) return $('mapBody').replaceChildren(el('p', { className: 'muted', textContent: t('adm.map.no_plan') }), upload, err);
  const shops = d.shops.filter((s) => s.floor === floor.name), spots = d.spots.filter((k) => k.floor_id === floor.id);
  const plan = el('div', { className: 'plan plan-edit', onclick: (e) => {
    if (e.target.closest('.pin')) return;
    const r = plan.getBoundingClientRect();
    openPin(floor, null, { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 });
  } }, el('img', { src: floor.plan_url, alt: t('adm.map.plan_alt', { n: floor.name }) }));
  plan.style.setProperty('--ratio', `${floor.plan_w} / ${floor.plan_h}`);
  const pin = (p, label, kind, onclick) => {
    const b = el('button', { type: 'button', className: `pin${kind}`, ariaLabel: t('adm.map.pin_named', { name: label }), onclick }, el('span', { className: 'pin-dot' }), el('span', { className: 'pin-label', textContent: label }));
    b.style.setProperty('--x', String(p.x));
    b.style.setProperty('--y', String(p.y));
    b.classList.toggle('to-left', p.x > 70); // near an edge the label hangs inwards, so the plan doesn't cut it
    b.classList.toggle('to-right', p.x < 30);
    return b;
  };
  plan.append(...shops.filter((s) => s.pin).map((s) => pin(s.pin, s.name, s.hidden ? ' off' : '', () => openPin(floor, { shop: s }, s.pin))),
    ...spots.map((k) => pin(k.pin, k.label, ' here', () => openPin(floor, { spot: k }, k.pin))));
  const copy = (url) => navigator.clipboard?.writeText(url).then(() => toast(t('adm.qr.copied')), () => toast(t('common.error'), { tone: 'danger' }));
  $('mapBody').replaceChildren(upload, err, plan,
    el('div', { className: 'bar' }, el('button', { type: 'button', onclick: () => openPin(floor, null, { x: 50, y: 50 }) }, icon('map-pin'), t('adm.map.add')),
      el('p', { className: 'hint grow', textContent: t('adm.map.tap_hint') })),
    el('h3', { className: 'section-title', textContent: t('adm.map.shops') }),
    shops.length ? el('ul', { className: 'plain-list' }, ...shops.map((s) => el('li', {}, el('strong', { textContent: s.name }), ' — ',
      el('span', { className: s.pin ? '' : 'muted', textContent: [s.unit && t('adm.mall.unit', { n: s.unit }), t(s.pin ? 'adm.map.pinned' : 'adm.map.unpinned'), s.hidden && t('adm.mall.hidden')].filter(Boolean).join(' · ') }))))
      : el('p', { className: 'muted', textContent: t('adm.map.no_shops') }),
    el('h3', { className: 'section-title', textContent: t('adm.map.kiosks') }),
    spots.length ? el('ul', { className: 'plain-list' }, ...spots.map((k) => el('li', { className: 'spot-row' }, el('strong', { textContent: k.label }),
      el('span', { className: 'muted qr-url', textContent: k.kiosk_url }), el('button', { type: 'button', onclick: () => copy(k.kiosk_url) }, t('adm.qr.copy')))))
      : el('p', { className: 'muted', textContent: t('adm.map.no_kiosks') }));
}
async function uploadPlan(floor, input, err) {
  const file = input.files[0];
  err.textContent = '';
  if (!file) return void (err.textContent = t('adm.form.image_pick'));
  if (file.size > PLAN_BYTES) return void (err.textContent = t('adm.form.image_big'));
  try {
    await call(`/mall/floors/${floor.id}/plan`, { method: 'POST', raw: file, type: file.type || 'application/octet-stream' });
    toast(t('adm.form.saved'), { tone: 'ok' });
    loadMall(true);
  } catch (e) { err.textContent = e.message; }
}
async function removePlan(floor, err) {
  if (!(await confirmDialog({ title: t('adm.map.plan_remove_title', { n: floor.name }), text: t('adm.map.plan_remove_text'), ok: t('common.delete'), danger: true }))) return;
  try {
    await call(`/mall/floors/${floor.id}/plan`, { method: 'DELETE' });
    loadMall(true);
  } catch (e) { err.textContent = e.message; }
}
const pinf = $('pinForm');
// target: { shop } or { spot } when an existing pin was tapped (then only that one moves or goes), null for a new one.
function openPin(floor, target, at) {
  pinning = { floor, target };
  pinf.reset();
  $('pinError').textContent = '';
  pinf.what.replaceChildren(
    ...mapData.shops.filter((s) => s.floor === floor.name).map((s) => el('option', { value: `s${s.id}`, textContent: [s.name, s.unit, s.pin && t('adm.map.pinned')].filter(Boolean).join(' · ') })),
    ...mapData.spots.filter((k) => k.floor_id === floor.id).map((k) => el('option', { value: `k${k.id}`, textContent: t('adm.map.kiosk_named', { name: k.label }) })),
    el('option', { value: 'new', textContent: t('adm.map.kiosk_new') }));
  pinf.what.value = target?.shop ? `s${target.shop.id}` : target?.spot ? `k${target.spot.id}` : pinf.what.options[0].value;
  pinf.what.disabled = Boolean(target);
  pinf.x.value = pct(at.x);
  pinf.y.value = pct(at.y);
  $('pinRemove').hidden = !target;
  syncPinLabel();
  $('pinDlg').showModal();
}
function syncPinLabel() {
  const v = pinf.what.value, kiosk = v === 'new' || v[0] === 'k';
  $('pinLabelBox').hidden = $('pinLabelHint').hidden = !kiosk;
  pinf.label.required = kiosk;
  pinf.label.value = v[0] === 'k' ? mapData.spots.find((k) => `k${k.id}` === v)?.label ?? '' : '';
}
pinf.what.onchange = syncPinLabel;
$('pinCancel').onclick = () => $('pinDlg').close();
pinf.onsubmit = async (e) => {
  e.preventDefault();
  $('pinError').textContent = '';
  if (!pinf.reportValidity()) return;
  const pin = { x: pct(Number(pinf.x.value)), y: pct(Number(pinf.y.value)) }, v = pinf.what.value, id = Number(v.slice(1)), floorId = pinning.floor.id;
  try {
    if (v[0] === 's') await call(`/mall/stores/${id}`, { method: 'PATCH', body: { pin } });
    else if (v === 'new') await call('/mall/spots', { method: 'POST', body: { floor_id: floorId, label: pinf.label.value.trim(), pin } });
    else await call(`/mall/spots/${id}`, { method: 'PATCH', body: { floor_id: floorId, label: pinf.label.value.trim(), pin } });
    $('pinDlg').close();
    toast(t('adm.form.saved'), { tone: 'ok' });
    loadMall(true);
  } catch (err) { $('pinError').textContent = err.message; }
};
$('pinRemove').onclick = async () => {
  const { target } = pinning;
  try {
    if (target.shop) await call(`/mall/stores/${target.shop.id}`, { method: 'PATCH', body: { pin: null } });
    else {
      if (!(await confirmDialog({ title: t('adm.map.spot_delete', { name: target.spot.label }), text: t('adm.map.spot_delete_text'), ok: t('common.delete'), danger: true }))) return;
      await call(`/mall/spots/${target.spot.id}`, { method: 'DELETE' });
    }
    $('pinDlg').close();
    toast(t('adm.form.saved'), { tone: 'ok' });
    loadMall(true);
  } catch (err) { $('pinError').textContent = err.message; }
};

// A shop's directory entry: floor, unit, shown or hidden, its logo.
const ef = $('entryForm');
function showEntryLogo(url) {
  $('entryImg').hidden = $('entryImgRemove').hidden = !url;
  if (url) $('entryImg').src = url;
}
function openEntry(s) {
  editingEntry = s;
  ef.reset();
  $('entryError').textContent = $('entryImgError').textContent = '';
  $('entryTitle').textContent = s.name;
  ef.floor.value = s.floor ?? '';
  ef.unit.value = s.unit ?? '';
  ef.hidden.checked = s.hidden;
  showEntryLogo(s.logo_url);
  $('entryDlg').showModal();
}
$('entryCancel').onclick = () => $('entryDlg').close();
ef.onsubmit = async (e) => {
  e.preventDefault();
  $('entryError').textContent = '';
  try {
    await call(`/mall/stores/${editingEntry.id}`, { method: 'PATCH', body: { floor: ef.floor.value.trim() || null, unit: ef.unit.value.trim() || null, hidden: ef.hidden.checked } });
    $('entryDlg').close();
    toast(t('adm.form.saved'), { tone: 'ok' });
    loadMall(true);
  } catch (err) { $('entryError').textContent = err.message; }
};
$('entryImgUpload').onclick = async () => {
  const url = await uploadLogo($('entryImgFile'), $('entryImgError'), `/mall/stores/${editingEntry.id}/logo`);
  if (url) showEntryLogo(url);
};
$('entryImgRemove').onclick = async () => (await removeLogo($('entryImgError'), `/mall/stores/${editingEntry.id}/logo`)) && showEntryLogo(null);
