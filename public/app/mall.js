// Task 37: the mall screen (/kiosk?mall=ID, /m?mall=ID): the shop directory and a search over the in-stock items of
// every shop in the mall. Choosing a shop or an item continues in that shop's own flow (?store=&mall=).
// Task 38: #cart is the mall cart: every shop's part with that shop's own discounts and totals (all from the server),
// one form, and one checkout that makes one order per shop. Shop and mall names come from the database: always set as text.
import { icon, showAfter, skeletonCard, ratingLine } from '/shared/ui.js';
import { t, fmt, getLang, productName } from '/shared/i18n.js';
import { offerCard, countOffers } from './offers.js';
import { openAt, floorsOf, categoriesOf, filterShops } from './directory.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter((k) => k != null && k !== false)); return e; };
const SEARCH_MS = 350; // typing pause before the search runs

const QR_SVG = /^<svg[\s>]/; // the status-page QR is built by our server from our own URL
const OPEN_MS = 60_000; // task 44: the open / closed marks follow the clock while the screen stays up (a kiosk, all day)
const WORD_MS = 2000; // task 53: a search word counts once it stays on screen this long (not every typed prefix)

export function mallScreen({ mallId, api, kiosk, saved }) {
  let mall = null, found = null, seq = 0, timer = null, offers = []; // task 43: the mall's current approved offers
  let cart = null, done = null, holdTimer = null; // task 38: the mall cart view, the last checkout's answer
  const chosen = {}; // per shop: { points: use the linked points, months: '' or an instalment term }
  // Task 44: the directory's filters (also the map's floor), the shop picked on the map (?pin=ID from a mall order's
  // status page), the open / closed marks on screen, this kiosk's own spot ("Siz shu yerdasiz") and the screen shown.
  const filter = { floor: '', category: '' };
  let picked = Number(new URLSearchParams(location.search).get('pin')) || 0, openMarks = [], screen = '';
  const spot = spotOf();
  // Task 53: counts for the mall admin's analytics. Nothing about the visitor or the device goes with them: the mall, what
  // happened, kiosk or phone, and the shop or the search word. A visit counts once per browser session on a phone and
  // once per customer on a kiosk (the first touch; the idle reset starts the next one).
  const channel = kiosk ? 'kiosk' : 'phone', VISIT = `sfMallVisit${channel}${mallId}`;
  let visited = false, wordTimer = null, lastWord = '';
  const countMall = (kind, extra = {}) => fetch('/api/mall-events', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mall_id: mallId, kind, channel, ...extra }) }).catch(() => {});
  function countVisit() {
    if (visited) return;
    visited = true;
    try {
      if (sessionStorage.getItem(VISIT)) return;
      sessionStorage.setItem(VISIT, '1');
    } catch { /* storage off: counted once per page */ }
    countMall('visit');
  }
  function forgetVisit() {
    visited = false;
    try { sessionStorage.removeItem(VISIT); } catch { /* storage off */ }
  }
  function countWord(q) {
    clearTimeout(wordTimer);
    if (q === lastWord || q.length > 60) return;
    lastWord = q;
    countMall('search', { word: q });
  }
  const countShop = (id) => countMall('shop', { store_id: id });
  const shopUrl = (storeId, item) => `${location.pathname}?store=${storeId}&mall=${mallId}${item ? `&item=${item}` : ''}`;
  const where = (s) => [s.floor && t('kiosk.mall.floor', { n: s.floor }), s.unit && t('kiosk.mall.unit', { n: s.unit })].filter(Boolean).join(' · ');
  const catName = (c) => (getLang() === 'ru' && c.name_ru) || c.name;
  const logo = (url, ic) => (url ? el('img', { className: 'shop-logo', src: url, alt: '' }) : el('span', { className: 'shop-logo' }, icon(ic)));
  const price = (p) => el('div', { className: p.discount_price ? 'price sale' : 'price' }, p.discount_price ? el('s', { textContent: fmt.som(p.price) }) : null, fmt.som(p.unit_price));

  function show() {
    window.addEventListener('hashchange', route);
    if (new URLSearchParams(location.search).get('idle') === '1') forgetVisit(); // a kiosk back from an idle shop: the next customer
    if (kiosk) for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, countVisit, true);
    else countVisit();
    $('back').onclick = () => toDirectory();
    $('cartBtn').onclick = () => { location.hash = 'cart'; };
    $('mcForm').onsubmit = place;
    $('mallLook').href = `${location.pathname}?mall=${mallId}&look=1`; // task 42
    route();
    loadCart();
    $('mallSearch').onsubmit = (e) => {
      e.preventDefault();
      clearTimeout(timer);
      search();
    };
    $('mallQ').oninput = () => {
      clearTimeout(timer);
      clearTimeout(wordTimer);
      timer = setTimeout(search, SEARCH_MS);
    };
    $('mallSearch').onchange = (e) => e.target.name === 'audience' && search(); // task 40: adults' or children's items
    for (const b of $('mallViews').children) b.onclick = () => (b.dataset.view === 'map' ? (location.hash = 'map') : toDirectory());
    $('mallFloor').onchange = (e) => { filter.floor = e.target.value; drawShops(); };
    $('mallCat').onchange = (e) => { filter.category = e.target.value; drawShops(); };
    setInterval(() => { for (const [node, s] of openMarks) markOpen(node, s); }, OPEN_MS);
    load();
  }

  // Task 44: a mall kiosk's own spot comes from its link (&spot=ID, from the mall admin's map) and is kept on the
  // device, because the page reloads between the mall screen and the shops. A phone never shows it.
  function spotOf() {
    if (!kiosk) return 0;
    const key = `sfSpot${mallId}`, v = Number(new URLSearchParams(location.search).get('spot'));
    try {
      if (v > 0) localStorage.setItem(key, String(v));
      return v > 0 ? v : Number(localStorage.getItem(key)) || 0;
    } catch {
      return v > 0 ? v : 0;
    }
  }

  // The directory, or #cart.
  function route() {
    const name = location.hash === '#cart' ? 'mallcart' : 'mall';
    for (const s of document.querySelectorAll('[data-screen]')) s.hidden = s.dataset.screen !== name;
    for (const id of ['home', 'steps', 'mallBtn']) $(id).hidden = true;
    $('back').hidden = name === 'mall';
    $('langBox').hidden = false;
    if (name === 'mallcart') {
      drawCart();
      $('mcTitle').focus({ preventScroll: true });
    } else {
      clearInterval(holdTimer);
      done = null;
    }
    syncBtn();
    if (mall && name === 'mall') drawShops(); // task 44: #map is the map view of the directory
    if (mall && mapOn()) $('mallShopsTitle').scrollIntoView({ block: 'start' });
    else if (screen !== name) window.scrollTo(0, 0);
    screen = name;
  }

  async function loadCart() {
    const token = saved();
    if (!token) return setMallCart(null);
    try {
      setMallCart(await api(`/mall-cart/${token}`));
    } catch (err) {
      if (err.status === 404) setMallCart(null);
    }
  }
  function setMallCart(v) {
    cart = v;
    saved(v?.token ?? null);
    syncBtn();
    if (location.hash === '#cart') drawCart();
  }
  function syncBtn() {
    const n = cart?.count ?? 0;
    $('cartBtn').hidden = !n || location.hash === '#cart';
    $('cartBtn').replaceChildren(icon('bag'), el('span', { className: 'cart-label', textContent: t('kiosk.cart') }), el('span', { className: 'count-pill', textContent: n }));
  }

  const row = (label, value, className = '') => el('div', { className }, el('span', { textContent: label }), el('span', { textContent: value }));
  const sizeName = (s) => (s === 'ONE' ? t('common.size_one') : s);
  const lineText = (i) => `${productName(i)} · ${sizeName(i.size)}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`;
  const discountRows = (o) => [
    ...(o.bundle ? [row(t('common.bundle_off'), `−${fmt.som(o.bundle)}`, 'off')] : []),
    ...(o.promo ? [row(t('common.promo_off', { code: o.code }), `−${fmt.som(o.promo)}`, 'off')] : []),
    ...(o.points ? [row(t('common.points_off'), `−${fmt.som(o.points)}`, 'off')] : []),
  ];
  const shopHead = (s, link) => el('div', { className: 'mall-head' }, logo(s.logo_url, 'store'),
    el('div', {}, el('h2', { textContent: s.name }), where(s) ? el('p', { className: 'meta', textContent: where(s) }) : null), link);
  // Points are used when this shop's part is linked to a profile (in the shop's cart screen) and the box is ticked.
  const usePoints = (s) => Boolean(chosen[s.store.id].points && s.cart.points?.linked && s.cart.points.max);
  const totalsOf = (s) => (usePoints(s) ? s.cart.points.totals : s.cart.totals).pickup;

  // One card per shop: its lines, its discounts, points and instalment choice, its total. Edits happen in the shop.
  function shopCard(s) {
    const c = s.cart, ch = (chosen[s.store.id] ??= { points: true, months: '' });
    const sum = totalsOf(s), terms = sum.instalments ?? [];
    if (!terms.some((x) => String(x.months) === ch.months)) ch.months = '';
    const extras = [];
    if (c.points?.linked && c.points.max) {
      extras.push(el('label', { className: 'check' }, el('input', { type: 'checkbox', id: `mcPts${s.store.id}`, checked: ch.points, onchange: (e) => { ch.points = e.target.checked; redrawKeep(e); } }),
        el('span', { textContent: t('kiosk.points.pay', { sum: fmt.som(c.points.max) }) })));
    }
    if (terms.length) {
      const select = el('select', { id: `mcTerm${s.store.id}`, onchange: (e) => { ch.months = e.target.value; redrawKeep(e); } },
        el('option', { value: '', textContent: t('kiosk.checkout.pay_cashier') }),
        ...terms.map((x) => el('option', { value: String(x.months), textContent: t('kiosk.inst.term', { n: x.months, sum: fmt.som(x.monthly) }) })));
      select.value = ch.months;
      extras.push(el('label', { className: 'field' }, el('span', { textContent: t('kiosk.checkout.pay_how') }), select));
    }
    const code = c.discounts.code;
    return el('section', { className: 'card mc-shop' },
      shopHead(s.store, el('a', { className: 'button ghost', href: `${shopUrl(s.store.id)}&open=cart` }, t('kiosk.mcart.edit'))),
      el('div', { className: 'sum' }, ...c.items.map((i) => row(lineText(i), fmt.som(i.line_total))),
        ...discountRows({ bundle: c.discounts.bundle, promo: c.discounts.promo, code: code?.code, points: usePoints(s) ? c.points.max : 0 }),
        row(t('common.total'), fmt.som(sum.total), 'grand')),
      code?.error ? el('p', { className: 'field-error', role: 'alert', textContent: t(code.error, { sum: fmt.num(code.min_order) }) }) : null,
      ...extras);
  }

  const redrawKeep = (e) => { // the totals change; the control keeps the focus
    drawCart();
    $(e.target.id)?.focus();
  };
  const toDirectory = () => {
    history.replaceState(null, '', location.pathname + location.search);
    route();
  };

  function drawCart() {
    clearInterval(holdTimer);
    $('mcHold').hidden = true;
    if (done) return drawDone();
    $('mcTitle').textContent = t('kiosk.mcart.title');
    $('mcForm').hidden = !cart?.shops.length;
    if (!cart?.shops.length) return $('mcBody').replaceChildren(el('div', { className: 'empty' }, icon('bag'), el('p', { textContent: t('kiosk.mcart.empty') })));
    $('mcBody').replaceChildren(...cart.shops.map(shopCard));
    // Every shop's hold runs out at the same moment; the countdown comes from the server's hold_ms.
    const until = Date.now() + cart.hold_ms;
    const tick = () => {
      const left = until - Date.now();
      if (left <= 0) return loadCart();
      $('mcHold').hidden = false;
      $('mcHold').replaceChildren(icon('clock'), el('span', { textContent: t('kiosk.cart.held', { left: fmt.countdown(left) }) }));
    };
    tick();
    holdTimer = setInterval(tick, 1000);
  }

  async function place(e) {
    e.preventDefault();
    const f = $('mcForm');
    $('mcError').textContent = '';
    $('mcPlace').disabled = true;
    try {
      done = await api(`/mall-cart/${cart.token}/checkout`, {
        name: f.fullname.value, phone: f.phone.value,
        shops: cart.shops.map((s) => ({ store_id: s.store.id, ...(usePoints(s) && { points: s.cart.points.max }), ...(chosen[s.store.id].months && { instalment: Number(chosen[s.store.id].months) }) })),
      });
      f.reset(); // a kiosk must not show the last customer's name and phone
      setMallCart(null);
    } catch (err) {
      $('mcError').textContent = err.store ? `${err.store.name}: ${err.message}` : err.message;
      if (err.status === 404) setMallCart(null);
      else if (err.store) loadCart(); // a shop's promo code, points or terms changed: show its new numbers
    } finally {
      $('mcPlace').disabled = false;
    }
  }

  // After checkout: the mall order number, every shop's order (pay at that shop's cashier) and the status page.
  function drawDone() {
    $('mcForm').hidden = true;
    $('mcTitle').textContent = t('kiosk.mcart.done_title');
    const track = kiosk && QR_SVG.test(done.track.svg)
      ? (() => { const qr = el('div', { className: 'tgqr' }); qr.innerHTML = done.track.svg; return el('div', { className: 'notice stack' }, el('p', { textContent: t('kiosk.track.scan') }), qr); })()
      : el('a', { className: 'button primary wide', href: new URL(done.track.url, location.href).pathname, textContent: t('kiosk.track.link') });
    $('mcBody').replaceChildren(
      el('div', { className: 'order-no', textContent: t('kiosk.mcart.number', { n: done.number }) }),
      ...done.orders.map((o) => el('section', { className: 'card mc-shop' }, shopHead(o.store, el('strong', { className: 'num', textContent: t('kiosk.track.title', { n: o.number }) })),
        el('div', { className: 'sum' }, ...o.items.map((i) => row(lineText(i), fmt.som(i.unit_price * i.quantity))),
          ...discountRows({ bundle: o.bundle_discount, promo: o.promo_discount, code: o.promo_code, points: o.points_discount }),
          row(t('common.total'), fmt.som(o.total), 'grand'),
          o.instalment_months ? el('p', { className: 'meta', textContent: t('kiosk.inst.item', { sum: fmt.som(o.instalment_monthly), n: o.instalment_months }) }) : null),
        el('p', { className: 'notice', textContent: t('kiosk.mcart.pay_by', { time: fmt.time(o.expires_at) }) }))),
      track,
      el('button', { type: 'button', className: 'primary wide go', textContent: t('kiosk.home'), onclick: toDirectory }));
  }

  async function load() {
    $('mallStatus').textContent = '';
    $('mallShops').replaceChildren();
    try {
      mall = await api(`/malls/${mallId}`);
    } catch (err) {
      $('mallName').textContent = t(err.status === 404 ? 'kiosk.mall.not_found' : 'kiosk.mall.title');
      $('mallSearch').hidden = true;
      $('mallStatus').textContent = err.status === 404 ? '' : t('kiosk.start.offline');
      if (err.status !== 404) $('mallShops').replaceChildren(el('li', {}, el('button', { type: 'button', className: 'primary', textContent: t('common.retry'), onclick: load })));
      return;
    }
    $('mallSearch').hidden = false;
    const p = mall.shops.find((s) => s.id === picked && s.pin);
    if (p) filter.floor = p.floor;
    else picked = 0;
    draw();
    if (mapOn()) $('mallShopsTitle').scrollIntoView({ block: 'start' });
    loadOffers();
  }

  // Task 43: "Aksiyalar": the mall's current approved offers. A tap opens the item (while it is in stock) or the shop.
  async function loadOffers(count = true) {
    try {
      offers = (await api(`/malls/${mallId}/offers`)).offers;
    } catch {
      offers = []; // the directory works without them
    }
    drawOffers();
    if (count) countOffers({ shown: offers.map((o) => o.id) });
  }
  function drawOffers() {
    $('mallOffers').hidden = !offers.length;
    $('mallOfferList').replaceChildren(...offers.map((o) => el('li', {}, offerCard(o, { href: shopUrl(o.store.id, o.item_id) }))));
  }

  // Header and directory; a language switch calls this again (category names change).
  function draw() {
    if (!mall) return load();
    $('storeName').textContent = mall.name;
    $('mallName').textContent = mall.name;
    $('mallWhere').textContent = [mall.city, mall.address].filter(Boolean).join(', ');
    $('mallLogo').hidden = !mall.logo_url;
    if (mall.logo_url) $('mallLogo').src = mall.logo_url;
    $('mallShopsTitle').textContent = t('kiosk.mall.shops', { n: mall.shops.length });
    drawOffers();
    drawShops();
    if (found) drawFound();
  }

  // Task 44: the directory as a list or (#map, when a floor has a plan) a map, narrowed by floor and category.
  const mapOn = () => Boolean(mall?.floors.length) && location.hash === '#map';
  const options = (sel, list, value) => {
    sel.replaceChildren(...list.map(([v, label]) => el('option', { value: v, textContent: label })));
    sel.value = value;
  };
  function drawShops() {
    const floors = floorsOf(mall.shops), cats = categoriesOf(mall.shops, getLang()), map = mapOn();
    if (!floors.includes(filter.floor)) filter.floor = '';
    if (!cats.some((c) => c.key === filter.category)) filter.category = '';
    $('mallViews').hidden = !mall.floors.length;
    for (const b of $('mallViews').children) b.setAttribute('aria-pressed', String((b.dataset.view === 'map') === map));
    $('floorBox').hidden = map || floors.length < 2; // the map has its own floor tabs
    $('catBox').hidden = cats.length < 2;
    options($('mallFloor'), [['', t('kiosk.map.all_floors')], ...floors.map((f) => [f, t('kiosk.mall.floor', { n: f })])], filter.floor);
    options($('mallCat'), [['', t('kiosk.map.all_cats')], ...cats.map((c) => [c.key, c.label])], filter.category);
    $('mallMap').hidden = !map;
    $('mallShops').hidden = map;
    openMarks = [];
    if (map) return drawMap();
    const list = filterShops(mall.shops, filter, getLang());
    $('mallShops').replaceChildren(...(list.length ? list.map((s) => shopItem(s, true))
      : [el('li', { className: 'empty' }, icon('store'), el('p', { textContent: t(mall.shops.length ? 'kiosk.map.no_match' : 'kiosk.mall.no_shops') }))]));
  }

  // A directory entry: the shop (its place, open / closed by its hours, categories) and, with a pin, "on the map".
  function shopItem(s, mapButton) {
    const state = el('span');
    openMarks.push([state, s]);
    markOpen(state, s);
    return el('li', { className: 'shop-item' },
      el('a', { className: 'button store-link shop-link', href: shopUrl(s.id), onclick: () => countShop(s.id) }, logo(s.logo_url, 'store'),
        el('span', {}, el('strong', { textContent: s.name }), where(s) && el('span', { className: 'meta', textContent: where(s) }), state,
          s.categories.length ? el('span', { className: 'meta cats', textContent: s.categories.slice(0, 6).map(catName).join(' · ') }) : null),
        icon('chevron-right')),
      mapButton && s.pin ? el('button', { type: 'button', className: 'ghost map-btn', ariaLabel: t('kiosk.map.show_named', { name: s.name }), title: t('kiosk.map.show'), onclick: () => showOnMap(s) }, icon('map-pin')) : null);
  }
  // No hours set → nothing (not "closed").
  function markOpen(node, s) {
    const open = openAt(s.opens_at, s.closes_at);
    node.hidden = open === null;
    node.className = `meta open-state${open ? ' is-open' : ''}`;
    node.textContent = open === null ? '' : `${t(open ? 'kiosk.map.open' : 'kiosk.map.closed')} · ${s.opens_at}–${s.closes_at}`;
  }
  function showOnMap(s) {
    picked = s.id;
    filter.floor = s.floor;
    location.hash = 'map';
  }

  // The map: floor tabs (floors with a plan), the plan, one pin per shop (a button named by its label) and, on a mall
  // kiosk, its own "Siz shu yerdasiz". Pins are percentages set as CSS custom properties through the CSSOM (the CSP
  // allows that; no style attribute). A tap shows the shop's entry under the plan. Filters: the category; the floor = the tab.
  function drawMap() {
    const here = mall.spots.find((k) => k.id === spot);
    const floor = mall.floors.find((f) => f.name === filter.floor) ?? mall.floors.find((f) => f.id === here?.floor_id) ?? mall.floors[0];
    filter.floor = floor.name;
    $('mapFloors').hidden = mall.floors.length < 2;
    $('mapFloors').replaceChildren(...mall.floors.map((f) => el('button', { type: 'button', className: 'chip', ariaPressed: String(f === floor), textContent: t('kiosk.mall.floor', { n: f.name }),
      onclick: () => { filter.floor = f.name; picked = 0; drawShops(); } })));
    const box = $('mapPlan'), img = $('mapImg');
    box.style.setProperty('--ratio', `${floor.plan_w} / ${floor.plan_h}`);
    if (img.getAttribute('src') !== floor.plan_url) img.src = floor.plan_url;
    img.alt = t('kiosk.map.plan_alt', { n: floor.name });
    const shops = filterShops(mall.shops, { ...filter, floor: floor.name }, getLang()).filter((s) => s.pin);
    const pin = (p, label, props) => {
      const b = el(props.onclick ? 'button' : 'span', props, el('span', { className: 'pin-dot' }), el('span', { className: 'pin-label', textContent: label }));
      b.style.setProperty('--x', String(p.x));
      b.style.setProperty('--y', String(p.y));
      b.classList.toggle('to-left', p.x > 70); // near an edge the label hangs inwards, so the plan doesn't cut it
      b.classList.toggle('to-right', p.x < 30);
      return b;
    };
    box.replaceChildren(img,
      ...shops.map((s) => pin(s.pin, s.name, { type: 'button', className: `pin${s.id === picked ? ' picked' : ''}`, ariaLabel: [s.name, where(s)].filter(Boolean).join(', '), ariaPressed: String(s.id === picked), onclick: () => pick(s) })),
      ...(here?.floor_id === floor.id ? [pin(here.pin, t('kiosk.map.here'), { className: 'pin here' })] : []));
    const sel = shops.find((s) => s.id === picked);
    $('mapHint').textContent = t(shops.length ? 'kiosk.map.hint' : 'kiosk.map.no_pins');
    $('mapCard').replaceChildren(...(sel ? [shopItem(sel, false)] : []));
  }
  function pick(s) {
    countMall('pin', { store_id: s.id });
    picked = s.id;
    drawMap();
    $('mapPlan').querySelector('.pin.picked')?.focus();
  }

  async function search() {
    const q = $('mallQ').value.trim();
    const mine = ++seq;
    if (q.length < 2) {
      found = null;
      $('mallStatus').textContent = q ? t('kiosk.mall.too_short') : '';
      return $('mallResults').replaceChildren();
    }
    $('mallStatus').textContent = t('kiosk.catalog.loading');
    const done = showAfter(300, () => mine === seq && $('mallResults').replaceChildren(skeletonCard(2), skeletonCard(2), skeletonCard(2)));
    try {
      const r = await api(`/malls/${mallId}/search?${new URLSearchParams({ q, audience: $('mallSearch').elements.audience.value })}`);
      if (mine !== seq) return;
      found = { q, items: r.items };
      drawFound();
      clearTimeout(wordTimer);
      wordTimer = setTimeout(() => countWord(q), WORD_MS);
    } catch (err) {
      if (mine !== seq) return;
      $('mallStatus').textContent = err.message;
      $('mallResults').replaceChildren(el('button', { type: 'button', className: 'primary', textContent: t('common.retry'), onclick: search }));
    } finally {
      done();
    }
  }

  // Result tiles: photo, name, price, the sizes in stock and the shop with its floor. Opens the item in that shop.
  function drawFound() {
    const { q, items } = found;
    $('mallStatus').textContent = items.length ? t('kiosk.mall.found', { n: items.length, q }) : t('kiosk.mall.nothing', { q });
    $('mallResults').replaceChildren(...items.map((p) => el('a', { className: 'button tile', href: shopUrl(p.store_id, p.id), onclick: () => { countWord(q); countShop(p.store_id); } },
      p.image_url ? el('img', { src: p.image_url, alt: '' }) : el('span', { className: 'ph' }, icon(p.category || 'hanger')),
      el('span', { className: 'name', textContent: productName(p) }), price(p), ratingLine(p.rating), // task 46: the catalogue's visible rating
      el('span', { className: 'meta', textContent: p.sizes.map((s) => (s === 'ONE' ? t('common.size_one') : s)).join(' ') }),
      el('span', { className: 'meta shop', textContent: [p.store_name, where(p)].filter(Boolean).join(' · ') }))));
  }

  // Kiosk idle: the next customer gets an empty search at the top of the directory, and the last customer's mall cart
  // gives every shop's held stock back now.
  function reset() {
    const token = saved();
    if (token) api(`/mall-cart/${token}`, null, 'DELETE').catch(() => {});
    $('mcForm').reset();
    $('mcError').textContent = '';
    done = null;
    setMallCart(null);
    toDirectory();
    clearTimeout(timer);
    clearTimeout(wordTimer);
    lastWord = '';
    forgetVisit(); // the next customer's first touch is a new visit
    seq++;
    found = null;
    $('mallSearch').reset(); // the query and the adults/children choice
    filter.floor = filter.category = ''; // task 44
    picked = 0;
    $('mallStatus').textContent = '';
    $('mallResults').replaceChildren();
    draw();
    loadOffers(false); // what runs now, for the next customer (not counted: nobody is looking yet)
    window.scrollTo(0, 0);
  }

  return { show, redraw: () => { draw(); if (location.hash === '#cart') drawCart(); }, reset };
}
