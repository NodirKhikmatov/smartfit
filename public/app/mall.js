// Task 37: the mall screen (/kiosk?mall=ID, /m?mall=ID): the shop directory and a search over the in-stock items of
// every shop in the mall. Choosing a shop or an item continues in that shop's own flow (?store=&mall=), where the
// cart and the payment are the shop's. Shop and mall names come from the database: always set as text.
import { icon, showAfter, skeletonCard } from '/shared/ui.js';
import { t, fmt, getLang, productName } from '/shared/i18n.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter((k) => k != null && k !== false)); return e; };
const SEARCH_MS = 350; // typing pause before the search runs

export function mallScreen({ mallId, api }) {
  let mall = null, found = null, seq = 0, timer = null;
  const shopUrl = (storeId, item) => `${location.pathname}?store=${storeId}&mall=${mallId}${item ? `&item=${item}` : ''}`;
  const where = (s) => [s.floor && t('kiosk.mall.floor', { n: s.floor }), s.unit && t('kiosk.mall.unit', { n: s.unit })].filter(Boolean).join(' · ');
  const catName = (c) => (getLang() === 'ru' && c.name_ru) || c.name;
  const logo = (url, ic) => (url ? el('img', { className: 'shop-logo', src: url, alt: '' }) : el('span', { className: 'shop-logo' }, icon(ic)));
  const price = (p) => el('div', { className: p.discount_price ? 'price sale' : 'price' }, p.discount_price ? el('s', { textContent: fmt.som(p.price) }) : null, fmt.som(p.unit_price));

  function show() {
    for (const s of document.querySelectorAll('[data-screen]')) s.hidden = s.dataset.screen !== 'mall';
    for (const id of ['home', 'back', 'steps', 'cartBtn', 'mallBtn']) $(id).hidden = true;
    $('langBox').hidden = false;
    $('mallSearch').onsubmit = (e) => {
      e.preventDefault();
      clearTimeout(timer);
      search();
    };
    $('mallQ').oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(search, SEARCH_MS);
    };
    load();
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
      const r = await api(`/malls/${mallId}/search?${new URLSearchParams({ q })}`);
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

  // Kiosk idle: the next customer gets an empty search at the top of the directory.
  function reset() {
    clearTimeout(timer);
    seq++;
    found = null;
    $('mallQ').value = '';
    $('mallStatus').textContent = '';
    $('mallResults').replaceChildren();
    draw();
    window.scrollTo(0, 0);
  }

  return { show, redraw: draw, reset };
}
