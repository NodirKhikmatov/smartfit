// Task 55: the landing page tells what Smart Fit is today. It renders in uz and ru, every link on it resolves, every
// feature it names has a route, the "ulanadi" ones are really off without a key, the plans come from src/plans.js,
// and the demo form still works under its rate limit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed, DEMO_MALL } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { PLANS, FEATURES } from '../src/plans.js';
import { landingPlans } from '../src/landing.js';
import { DICT, LANGS, t } from '../public/shared/i18n.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const HTML = read('public/landing/index.html');
const JS = read('public/landing/landing.js');
let server, base, superToken;

before(async () => {
  await db.migrate.latest();
  await seed(db);
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  // No Telegram bot, no Click/Payme, no Claude, no FASHN: the page must hold true for a fresh install.
  server = createApp(db, { telegram: null, stylist: null, tryon: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  superToken = (await (await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'boss@smartfit.uz', password: 'boss-pass-1' }) })).json()).token;
});
after(async () => {
  server.close();
  await db.destroy();
});

test('the page renders in uz and ru: every key it uses has text in both, plans and plurals included', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  const keys = new Set([...HTML.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]));
  for (const m of JS.matchAll(/'((?:land|adm|common|err)\.[a-z0-9_.]+)'/g)) keys.add(m[1]);
  for (const f of FEATURES) keys.add(`adm.plan.f_${f}`);
  for (const p of Object.keys(PLANS)) keys.add(`adm.plan.n_${p}`);
  assert.ok(keys.size > 100);
  const plans = landingPlans();
  for (const lang of LANGS) {
    for (const k of keys) assert.ok(typeof DICT[lang][k] === 'string' || typeof DICT[lang][k] === 'object', `${lang}: ${k}`);
    // What landing.js writes for the plans: no placeholder left, the numbers in it.
    const trial = t('land.plans.trial', { n: plans.trial_days, plan: t(`adm.plan.n_${plans.trial_plan}`, {}, lang) }, lang);
    assert.match(trial, new RegExp(`${plans.trial_days}.*${t(`adm.plan.n_${plans.trial_plan}`, {}, lang)}`));
    for (const k of ['stores', 'products', 'kiosks', 'team']) {
      for (const n of [1, 3, 15, 300]) assert.doesNotMatch(t(`land.plans.${k}`, { n, count: String(n) }, lang), /[{}]/, `${lang} ${k} ${n}`);
    }
    for (const k of ['land.plans.grace', 'land.plans.trial']) assert.doesNotMatch(t(k, { n: 7, plan: 'Pro' }, lang), /[{}]/);
  }
  assert.equal(t('land.plans.products', { n: 3000, count: '3 000' }, 'ru'), '3 000 товаров');
  assert.equal(t('land.plans.stores', { n: 1, count: '1' }, 'ru'), '1 магазин');
  // Nothing on the page is typed outside the dictionary except brand names (the i18n test checks that too).
  assert.doesNotMatch(HTML, /<script>|style="|\son[a-z]+="/, 'CSP: no inline script, style or handler');
});

test('every link on the page resolves: anchors to an id, paths to a 200, demo links to the seeded mall and store', async () => {
  const ids = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const refs = new Set([...HTML.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1].replaceAll('&amp;', '&')));
  assert.ok(refs.has('/m?mall=1') && refs.has('/kiosk?mall=1'), 'mall demo links');
  assert.ok(refs.has('/kiosk?store=1') && refs.has('/m?store=1'), 'shop demo links');
  for (const ref of refs) {
    if (ref.startsWith('#')) { assert.ok(ids.has(ref.slice(1)), `anchor ${ref}`); continue; }
    assert.ok(ref.startsWith('/'), `only own links: ${ref}`);
    const path = ref.split('#')[0];
    assert.equal((await fetch(base + path)).status, 200, ref);
  }
  // The ids behind the demo links are the seed's: mall 1 is the demo mall, store 1 is in it, and both answer.
  const mall = await (await fetch(`${base}/api/malls/1`)).json();
  assert.equal(mall.name ?? mall.mall?.name, DEMO_MALL.name);
  assert.equal((await db('stores').where({ id: 1 }).first()).mall_id, 1);
  // Links landing.js draws: the plans' "ask" button goes to the form.
  assert.match(JS, /href: '#demo'/);
  assert.ok(ids.has('demo'));
});

// Every feature the page names (a point's heading or an integration tile) → routes that do it. A new point without an
// entry here fails, and so does an entry whose route is gone (404).
const FEATURE_ROUTES = {
  'land.mall.dir': ['GET /api/malls/1', 'GET /api/malls/1/search?q=kurtka', 'GET /api/admin/mall/map'],
  'land.mall.cart': ['POST /api/mall-cart/items', 'POST /api/recommend/mall', 'GET /mall-order/x'],
  'land.mall.offers': ['GET /api/malls/1/offers', 'GET /api/admin/offers', 'PATCH /api/admin/mall/slides'],
  'land.mall.stats': ['GET /api/admin/mall/stats', 'GET /api/admin/mall/stats/export', 'POST /api/mall-events'],
  'land.shop.fit': ['POST /api/recommend', 'POST /api/size'],
  'land.shop.catalog': ['GET /api/catalog/1', 'GET /api/admin/categories', 'GET /api/admin/size-charts', 'GET /api/admin/reviews', 'GET /api/admin/labels', 'GET /api/catalog/1/items/1'],
  'land.shop.cashier': ['GET /api/admin/cash', 'GET /api/admin/cash/closings', 'GET /api/admin/promos'],
  'land.shop.staff': ['GET /staff/', 'GET /api/admin/fitting', 'GET /api/admin/stock/sessions', 'GET /api/admin/transfers', 'GET /api/admin/me/sales'],
  'land.shop.owner': ['GET /api/admin/profit', 'GET /api/admin/sellers', 'GET /api/admin/demand', 'GET /api/admin/me/security'],
  'land.tile.excel': ['GET /api/admin/products/export', 'POST /api/admin/products/import'],
  'land.tile.api': ['POST /api/sync/stock'],
  'land.tile.weather': ['POST /api/recommend'],
  'land.tile.tablet': ['GET /kiosk?store=1', 'GET /kiosk.webmanifest'],
  'land.tile.telegram': ['GET /api/admin/points'], // the bot's own routes (/api/profile/*) exist only with a bot: next test
  'land.tile.pay': ['GET /api/admin/orders'], // the Click/Payme callbacks exist only with merchant keys: next test
  'land.tile.claude': ['POST /api/recommend'],
  'land.tile.fashn': ['GET /api/admin/stores/1/tryon'],
  'land.plans.title': ['GET /api/admin/plan?organization_id=1', 'GET /landing/plans.json'],
};

test('no feature is named that has no route', async () => {
  // Named features: each point's heading, each integration tile, and the plans.
  const keys = new Set([...HTML.matchAll(/<h3 data-i18n="([^"]+)"/g)].map((m) => m[1]));
  for (const m of HTML.matchAll(/<div class="tile">.*?<p data-i18n="(land\.tile\.[a-z]+)"/g)) keys.add(m[1]);
  if (HTML.includes('id="plans"')) keys.add('land.plans.title');
  assert.deepEqual([...keys].sort(), Object.keys(FEATURE_ROUTES).sort(), 'every named feature has its routes listed');
  // The walk can tell: a route that isn't there is a 404 for super too, not a 401/403 that would hide it.
  for (const p of ['/api/admin/nope', '/api/nope']) assert.equal((await fetch(base + p, { headers: { authorization: `Bearer ${superToken}` } })).status, 404, p);
  for (const [key, routes] of Object.entries(FEATURE_ROUTES)) {
    for (const route of routes) {
      const [method, path] = route.split(' ');
      const res = await fetch(base + path, {
        method, headers: { 'content-type': 'application/json', ...(path.startsWith('/api/admin') && { authorization: `Bearer ${superToken}` }) },
        body: method === 'GET' ? undefined : '{}',
      });
      assert.notEqual(res.status, 404, `${key}: ${route} exists`);
    }
  }
});

test('"ulanadi" is true: those features are off without their key, and the page says so', async () => {
  const badge = (name) => HTML.match(new RegExp(`<p data-i18n="land\\.tile\\.${name}"></p><span class="badge (\\w+)" data-i18n="land\\.tile\\.(\\w+)"`))?.slice(1);
  for (const n of ['telegram', 'pay', 'claude', 'fashn']) assert.deepEqual(badge(n), ['off', 'connect'], n);
  for (const n of ['excel', 'api', 'weather', 'tablet']) assert.deepEqual(badge(n), ['ok', 'ready'], n);
  // Without a Telegram bot there are no customer profiles; without a FASHN key no try-on; without Click/Payme the
  // store offers only paying at the cashier; without a Claude key the outfits still come (from the rules).
  for (const p of ['/api/profile/link', '/api/profile/alert', '/api/pay/payme']) assert.equal((await fetch(base + p, { method: 'POST' })).status, 404, p);
  assert.equal((await fetch(`${base}/api/tryon`, { method: 'POST' })).status, 404);
  const store = await (await fetch(`${base}/api/stores/1`)).json();
  assert.ok(!JSON.stringify(store.payment_methods ?? store.methods ?? []).match(/click|payme/), 'no online payment without merchant keys');
  const rec = await fetch(`${base}/api/recommend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: 1, gender: 'male', sizes: { top: 'M', bottom: 'M', shoes: '42' } }) });
  assert.equal(rec.status, 200);
  assert.ok((await rec.json()).outfits.length > 0, 'rule-based outfits without a Claude key');
});

test('plans: the page shows the enforced table, and asks for a price because none is set', async () => {
  const plans = await (await fetch(`${base}/landing/plans.json`)).json();
  assert.deepEqual(plans, JSON.parse(JSON.stringify(landingPlans())));
  assert.deepEqual(plans.plans.map(({ name, ...p }) => [name, p]), Object.entries(PLANS));
  // src/plans.js sets no price today, so every card asks; a plan that gets a price shows it instead.
  assert.ok(plans.plans.some((p) => !p.price));
  assert.match(JS, /p\.price \? .* : el\('a', \{ className: 'button big', href: '#demo', textContent: t\('land\.plans\.ask'\) \}\)/);
});

test('the demo form still works and keeps its rate limit', async () => {
  // The fields the page has are the ones landing.js sends and the server takes.
  for (const f of ['name', 'phone', 'company', 'city', 'stores', 'message']) assert.match(HTML, new RegExp(`name="${f}"`));
  const post = (body) => fetch(`${base}/api/demo-requests`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.55' }, body: JSON.stringify(body) });
  const ok = { name: 'Dilnoza', phone: '+998 90 123 45 67', company: 'Demo Savdo Markazi', city: 'Toshkent', stores: 40, message: null };
  assert.equal((await post({ ...ok, phone: '123' })).status, 400);
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await post(ok)).status);
  assert.deepEqual(statuses.slice(0, 2), [201, 201]);
  assert.equal(statuses.at(-1), 429, 'the per-IP limit still holds');
  assert.ok((await db('demo_requests').where({ company: 'Demo Savdo Markazi' })).length >= 2);
});
