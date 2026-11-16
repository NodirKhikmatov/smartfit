// Task 37: the mall screen (/kiosk?mall=ID, /m?mall=ID): the shop directory and a search over the in-stock items of
// every shop in the mall. Choosing a shop or an item continues in that shop's own flow (?store=&mall=).
// Task 38: #cart is the mall cart: every shop's part with that shop's own discounts and totals (all from the server),
// one form, and one checkout that makes one order per shop. Shop and mall names come from the database: always set as text.
import { icon, showAfter, skeletonCard } from '/shared/ui.js';
import { t, fmt, getLang, productName } from '/shared/i18n.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter((k) => k != null && k !== false)); return e; };
const SEARCH_MS = 350; // typing pause before the search runs

const QR_SVG = /^<svg[\s>]/; // the status-page QR is built by our server from our own URL

export function mallScreen({ mallId, api, kiosk, saved }) {
  let mall = null, found = null, seq = 0, timer = null;
  let cart = null, done = null, holdTimer = null; // task 38: the mall cart view, the last checkout's answer
  const chosen = {}; // per shop: { points: use the linked points, months: '' or an instalment term }
  const shopUrl = (storeId, item) => `${location.pathname}?store=${storeId}&mall=${mallId}${item ? `&item=${item}` : ''}`;
  const where = (s) => [s.floor && t('kiosk.mall.floor', { n: s.floor }), s.unit && t('kiosk.mall.unit', { n: s.unit })].filter(Boolean).join(' · ');
  const catName = (c) => (getLang() === 'ru' && c.name_ru) || c.name;
  const logo = (url, ic) => (url ? el('img', { className: 'shop-logo', src: url, alt: '' }) : el('span', { className: 'shop-logo' }, icon(ic)));
  const price = (p) => el('div', { className: p.discount_price ? 'price sale' : 'price' }, p.discount_price ? el('s', { textContent: fmt.som(p.price) }) : null, fmt.som(p.unit_price));

  function show() {
    window.addEventListener('hashchange', route);
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
      timer = setTimeout(search, SEARCH_MS);
    };
    $('mallSearch').onchange = (e) => e.target.name === 'audience' && search(); // task 40: adults' or children's items
    load();
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
    window.scrollTo(0, 0);
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
    draw();
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
    $('mallShops').replaceChildren(...(mall.shops.length ? mall.shops.map((s) => el('li', {},
      el('a', { className: 'button store-link shop-link', href: shopUrl(s.id) }, logo(s.logo_url, 'store'),
        el('span', {}, el('strong', { textContent: s.name }), where(s) && el('span', { className: 'meta', textContent: where(s) }),
          s.categories.length ? el('span', { className: 'meta cats', textContent: s.categories.slice(0, 6).map(catName).join(' · ') }) : null),
        icon('chevron-right'))))
      : [el('li', { className: 'empty' }, icon('store'), el('p', { textContent: t('kiosk.mall.no_shops') }))]));
    if (found) drawFound();
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
    $('mallResults').replaceChildren(...items.map((p) => el('a', { className: 'button tile', href: shopUrl(p.store_id, p.id) },
      p.image_url ? el('img', { src: p.image_url, alt: '' }) : el('span', { className: 'ph' }, icon(p.category || 'hanger')),
      el('span', { className: 'name', textContent: productName(p) }), price(p),
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
    seq++;
    found = null;
    $('mallSearch').reset(); // the query and the adults/children choice
    $('mallStatus').textContent = '';
    $('mallResults').replaceChildren();
    draw();
    window.scrollTo(0, 0);
  }

  return { show, redraw: () => { draw(); if (location.hash === '#cart') drawCart(); }, reset };
}
