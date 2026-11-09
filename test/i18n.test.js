import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin, CATEGORIES } from '../src/admin/routes.js';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../src/admin/audit.js';
import { createStylist } from '../src/recommend/stylist.js';
import { DICT, LANGS, t, fmt, errorText, productName, colorName } from '../public/shared/i18n.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const srcFiles = (dir = 'src') => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? srcFiles(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []));

// Every file with user-facing text. i18n.js counts only below the dictionary (its helpers use keys too).
const PAGES = ['public/app/index.html', 'public/app/order.html', 'public/app/profile.html', 'public/admin/index.html', 'public/landing/index.html', 'public/staff/index.html'];
const SCRIPTS = ['public/app/app.js', 'public/app/idle.js', 'public/app/pose.js', 'public/app/flow.js', 'public/app/keypad.js', 'public/app/kiosk.js', 'public/app/order.js', 'public/app/profile.js', 'public/admin/admin.js', 'public/admin/util.js', 'public/admin/charts.js', 'public/shared/ui.js', 'public/landing/landing.js', 'public/staff/staff.js', ...srcFiles()];
const i18nSrc = read('public/shared/i18n.js');
const sources = Object.fromEntries([...PAGES, ...SCRIPTS].map((f) => [f, read(f)]));
sources['public/shared/i18n.js#helpers'] = i18nSrc.slice(i18nSrc.indexOf('export const DICT'));

// String, template and comment aware scan: returns the contents of every string/template literal (comments skipped).
function literals(code) {
  const out = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') i = code.indexOf('\n', i) === -1 ? code.length : code.indexOf('\n', i);
    else if (c === '/' && code[i + 1] === '*') i = code.indexOf('*/', i + 2) + 1;
    else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1, s = '';
      while (j < code.length && code[j] !== c) {
        if (code[j] === '\\') s += code[j++];
        s += code[j++];
      }
      out.push(s);
      i = j;
    }
  }
  return out;
}
const scripts = (f, text) => (f.endsWith('.html') ? [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n') : text);

test('both languages have exactly the same keys, placeholders and plural forms', () => {
  const [uz, ru] = [DICT.uz, DICT.ru];
  assert.deepEqual(Object.keys(ru).filter((k) => !(k in uz)), [], 'ru keys missing in uz');
  assert.deepEqual(Object.keys(uz).filter((k) => !(k in ru)), [], 'uz keys missing in ru');
  const holes = (v) => [...new Set(JSON.stringify(v).match(/\{\w+\}/g) ?? [])].sort().join();
  for (const k of Object.keys(uz)) {
    assert.equal(holes(ru[k]), holes(uz[k]), `${k}: same {placeholders}`);
    for (const v of [uz[k], ru[k]]) {
      if (typeof v === 'object') assert.deepEqual(Object.keys(v).sort(), ['few', 'many', 'one'], `${k}: plural forms`);
      else assert.ok(typeof v === 'string' && v.trim(), `${k}: not empty`);
    }
  }
  assert.deepEqual(LANGS, ['uz', 'ru']);
});

test('no key is written twice in one language (a later copy would silently win)', () => {
  const counts = {};
  for (const [, k] of i18nSrc.matchAll(/^  '([^']+)':/gm)) counts[k] = (counts[k] ?? 0) + 1;
  assert.deepEqual(Object.keys(counts).filter((k) => counts[k] > 2), [], 'uz + ru = 2 definitions per key');
});

test('every key used in code exists, and every dictionary key is used', () => {
  const NS = /^(err|field|cat|gender|lang|common|kiosk|adm|land|staff)\.[a-z0-9_.]+$/;
  const used = new Set();
  for (const [f, text] of Object.entries(sources)) {
    // Quoted keys anywhere, including inside ${…} of a template literal.
    for (const m of scripts(f, text).matchAll(/['"]([a-z]+\.[a-z0-9_.]+)['"]/g)) if (NS.test(m[1])) used.add(m[1]);
    if (f.endsWith('.html')) for (const m of text.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);
  }
  // Keys built at run time from an enum: `cat.${c}` etc. Each family must appear in code and cover its enum.
  const FAMILIES = {
    cat: CATEGORIES, lang: LANGS,
    'adm.status': ['new', 'packing', 'shipping', 'delivered', 'cancelled'],
    'adm.step': ['packing', 'shipping', 'delivered', 'cancelled'],
    'adm.pay': ['pending', 'paid', 'cancelled'],
    'kiosk.track.step': ['placed', 'paid', 'packing', 'shipping', 'delivered', 'handed'],
    'adm.ent': AUDIT_ENTITIES, 'adm.act': AUDIT_ACTIONS,
  };
  const all = Object.values(sources).join('\n');
  for (const [prefix, members] of Object.entries(FAMILIES)) {
    assert.ok(all.includes('`' + prefix + '.${'), `family ${prefix} is used`);
    for (const m of members) used.add(`${prefix}.${m}`);
  }
  assert.deepEqual([...used].filter((k) => !(k in DICT.uz)).sort(), [], 'keys used in code but missing in the dictionary');
  assert.deepEqual(Object.keys(DICT.uz).filter((k) => !used.has(k)).sort(), [], 'dictionary keys nobody uses');
});

// Uzbek Latin (o'/g' letters or common words) or any Cyrillic.
const LOOKS_LOCAL = /[Ѐ-ӿ]|\b\w*[oOgG]['ʻ‘’]\w|\b(va|yoki|uchun|bilan|kiyim\w*|razmer\w*|savat\w*|buyurtma\w*|xato\w*|qayta|tanlang|kiriting|jami|narx\w*|soni|rasm\w*|gacha|haqida|hozir|bugun|topilmadi|majburiy|kerak|emas|yuklash|saqlash|bekor|tahrirlash|kirish|chiqish|yangi|davom|boshlash|ob-havo|kassa\w*|holat\w*|mijoz\w*|ta)\b/i;

test('no Uzbek or Russian text outside the dictionary (pages, browser JS, server)', () => {
  // Not app UI: the spec's Uzbek stylist prompt (task 7), Payme's ru/uz/en protocol messages, demo seed data, the
  // operator CLI, Telegram order messages (still Uzbek only, see TASKS.md task 14 Notes).
  const EXEMPT = ['src/recommend/stylist.js', 'src/cart/payments.js', 'src/db/seed.js', 'src/notify/telegram.js', 'src/admin/create-store.js'];
  // Values staff type, not text we show: a CSV "waterproof" value and colour names (the engine's neutral colours).
  const INPUT_WORDS = ["yo'q", "to'q ko'k", "ko'k"];
  assert.ok(LOOKS_LOCAL.test("Do'kon topilmadi") && LOOKS_LOCAL.test('Корзина') && LOOKS_LOCAL.test('Savat bo‘sh') && !LOOKS_LOCAL.test('application/json'), 'detector works');
  const hits = [];
  for (const [f, text] of Object.entries(sources)) {
    if (EXEMPT.includes(f)) continue;
    for (const s of literals(scripts(f, text))) if (LOOKS_LOCAL.test(s) && !INPUT_WORDS.includes(s)) hits.push(`${f}: ${s.slice(0, 60)}`);
    if (!f.endsWith('.html')) continue;
    // Markup: text nodes and labelled attributes come from data-i18n*, except the brand and symbols.
    const markup = text.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of markup.matchAll(/>([^<]+)</g)) {
      const s = m[1].trim();
      if (s && !['Smart Fit', 'Smart Fit — Admin', '№', 'Telegram', 'Click', 'Payme', 'Excel', 'API', 'Open-Meteo', '© 2026 Smart Fit'].includes(s)) hits.push(`${f} text: ${s.slice(0, 60)}`);
    }
    // A format hint like the phone placeholder has no words to translate.
    for (const m of markup.matchAll(/\s(aria-label|title|placeholder|alt)="([^"]+)"/g)) if (/\p{L}/u.test(m[2])) hits.push(`${f} ${m[1]}: ${m[2]}`);
  }
  assert.deepEqual(hits, []);
});

test('fmt and t: so\'m, Tashkent time, Russian plurals, names and colours', () => {
  assert.equal(fmt.som(1250000, 'uz'), "1 250 000 so'm");
  assert.equal(fmt.som(1250000, 'ru'), '1 250 000 сум');
  assert.equal(fmt.num(990000), '990 000');
  // 10:05 UTC is 15:05 in Tashkent whatever the machine's zone.
  assert.equal(fmt.time('2026-11-09T10:05:00Z'), '15:05');
  assert.equal(fmt.dateTime('2026-11-09T20:30:00Z'), '10.11, 01:30');
  assert.equal(t('kiosk.results.found', { n: 1 }, 'ru'), 'Подобран 1 образ');
  assert.equal(t('kiosk.results.found', { n: 3 }, 'ru'), 'Подобрано 3 образа');
  assert.equal(t('kiosk.results.found', { n: 5 }, 'ru'), 'Подобрано 5 образов');
  assert.equal(t('kiosk.results.found', { n: 3 }, 'uz'), '3 ta obraz topildi');
  assert.equal(t('adm.stats.days', { n: 30 }, 'ru'), '30 дней');
  assert.equal(t('no.such.key'), 'no.such.key', 'a missing key shows itself');
  assert.equal(productName({ name: 'Hudi', name_ru: 'Худи' }, 'ru'), 'Худи');
  assert.equal(productName({ name: 'Hudi', name_ru: null }, 'ru'), 'Hudi', 'falls back to the Uzbek name');
  assert.equal(productName({ name: 'Hudi', name_ru: 'Худи' }, 'uz'), 'Hudi');
  assert.equal(colorName("to'q ko'k", 'ru'), 'тёмно-синий');
  assert.equal(colorName('zangori', 'ru'), 'zangori', 'unknown colour stays as typed');
  assert.equal(errorText('ru', 'err.required', { field: 'field.name' }), 'Заполните поле «Название»');
  assert.equal(errorText('ru', 'err.out_of_stock', { product: { name: 'Hudi', name_ru: 'Худи' }, size: 'common.size_one' }), '«Худи» (единый размер) закончился');
});

// --- API: same error, same code, message in the request's language.
process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
const weather = { temperature: 5, apparent_temperature: 2, raining: false, wind_speed: 3, source: 'live' };
const calls = [];
const fake = { messages: { create: async (params) => (calls.push(params), { stop_reason: 'refusal', content: [] }) } };
let server, base, storeId, token;

const call = async (path, { lang, method = 'GET', body, raw, type = 'application/json', auth } = {}) => {
  const headers = { 'content-type': type, ...(lang && { 'accept-language': lang }), ...(auth && { authorization: `Bearer ${auth}` }) };
  const res = await fetch(base + path, { method, headers, body: raw ?? (body && JSON.stringify(body)) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const both = async (path, opts) => Promise.all(['uz', 'ru'].map((lang) => call(path, { ...opts, lang })));

before(async () => {
  await db.migrate.latest();
  await seed(db);
  storeId = (await db('stores').orderBy('id').first('id')).id;
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'super-pass-1' });
  server = createApp(db, { weather: async () => weather, stylist: createStylist({ client: fake }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await call('/api/admin/login', { method: 'POST', body: { email: 'boss@smartfit.uz', password: 'super-pass-1' } })).body.token;
});
after(async () => {
  server.close();
  await db.destroy();
});

test('API errors: same code in uz and ru, message in the asked language', async () => {
  const soldOut = await db('product_stock as s').join('products as p', 'p.id', 's.product_id')
    .where({ 'p.store_id': storeId }).where('s.quantity', 0).first('p.id', 'p.name', 'p.name_ru', 's.size');
  const cases = [
    ['/api/stores/999999', {}, 404, 'store_not_found', "Do'kon topilmadi", 'Магазин не найден'],
    ['/api/nope', {}, 404, 'not_found', 'Topilmadi', 'Не найдено'],
    ['/api/admin/login', { method: 'POST', body: { email: 'boss@smartfit.uz', password: 'wrong' } }, 401, 'bad_login', "Email yoki parol noto'g'ri", 'Неверный email или пароль'],
    ['/api/size', { method: 'POST', body: { gender: 'male', height: 20 } }, 400, 'invalid', "Bo'y noto'g'ri", 'Проверьте поле «Рост»'],
    ['/api/admin/products', { method: 'POST', body: { category: 'top' }, auth: 'x' }, 401, 'login_again', 'Qayta kiring', 'Войдите снова'],
    ['/api/cart/items', { method: 'POST', body: { store_id: storeId, items: [{ product_id: soldOut.id, size: soldOut.size }] } }, 409, 'out_of_stock',
      `«${soldOut.name}» (${soldOut.size}) qolmadi`, `«${soldOut.name_ru}» (${soldOut.size}) закончился`],
  ];
  for (const [path, opts, status, code, uzText, ruText] of cases) {
    const [uz, ru] = await both(path, opts);
    assert.equal(uz.status, status, path);
    assert.equal(ru.status, status, path);
    assert.deepEqual(uz.body, { code, error: uzText }, `${path} uz`);
    assert.deepEqual(ru.body, { code, error: ruText }, `${path} ru`);
  }
  // Request data that names an Object.prototype member is just text, never a crash.
  const proto = await call('/api/admin/products', { method: 'POST', auth: token, lang: 'ru', body: { name: 'x', category: 'top', gender: 'unisex', color: 'oq', price: 1, temp_min: 0, temp_max: 1, store_id: storeId, stock: { constructor: 1 } } });
  assert.deepEqual(proto, { status: 400, body: { code: 'bad_size', error: 'Неверный размер: constructor' } });
  assert.equal(t('constructor'), 'constructor');
  assert.equal(colorName('constructor', 'ru'), 'constructor');
  // Field errors carry the field name in the same language.
  const [uz, ru] = await both('/api/admin/products', { method: 'POST', auth: token, body: { category: 'top', gender: 'unisex', color: 'oq', price: 1, temp_min: 0, temp_max: 1, store_id: storeId } });
  assert.deepEqual([uz.body, ru.body], [{ code: 'required', error: 'Nomi majburiy' }, { code: 'required', error: 'Заполните поле «Название»' }]);
});

test('language choice: ?lang= wins, Accept-Language counts, anything else is Uzbek', async () => {
  const msg = async (path, lang) => (await call(path, { lang })).body.error;
  assert.equal(await msg('/api/stores/999999?lang=ru'), 'Магазин не найден');
  assert.equal(await msg('/api/stores/999999?lang=ru', 'uz'), 'Магазин не найден');
  assert.equal(await msg('/api/stores/999999', 'ru-RU,ru;q=0.9'), 'Магазин не найден');
  assert.equal(await msg('/api/stores/999999', 'en-US,en;q=0.9'), "Do'kon topilmadi");
  assert.equal(await msg('/api/stores/999999?lang=fr'), "Do'kon topilmadi");
  // Body parser errors are localised too.
  const bad = await call('/api/size', { method: 'POST', raw: '{', lang: 'ru' });
  assert.deepEqual(bad, { status: 400, body: { code: 'bad_request', error: 'Некорректный запрос' } });
});

test('CSV import: per-row errors and the summary come in the asked language with codes', async () => {
  const csv = 'name,name_ru,category,gender,color,price,temp_min,temp_max,store_id\nKo\'ylak,Рубашка,top,unisex,oq,abc,0,20,' + storeId + '\n';
  const r = await call('/api/admin/products/import', { method: 'POST', raw: csv, type: 'text/csv', auth: token, lang: 'ru' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'csv_rows');
  assert.equal(r.body.error, 'Ошибки в строках: 1. Ничего не загружено');
  assert.deepEqual(r.body.errors, [{ line: 2, code: 'invalid', error: 'Проверьте поле «Цена»' }]);
});

test('name_ru: optional on products (form and CSV), searchable, sent to the apps', async () => {
  const base = { name: 'Test palto', category: 'outerwear', gender: 'unisex', color: 'qora', price: 500000, temp_min: -5, temp_max: 10, store_id: storeId, stock: { M: 2 } };
  const created = await call('/api/admin/products', { method: 'POST', auth: token, body: { ...base, name_ru: '  Тестовое пальто ' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.name_ru, 'Тестовое пальто');
  const none = await call('/api/admin/products', { method: 'POST', auth: token, body: { ...base, name: 'Test palto 2' } });
  assert.equal(none.body.name_ru, null, 'optional');
  const long = await call('/api/admin/products', { method: 'POST', auth: token, lang: 'ru', body: { ...base, name_ru: 'я'.repeat(121) } });
  assert.deepEqual(long.body, { code: 'invalid', error: 'Проверьте поле «Название на русском»' });
  const found = await call(`/api/admin/products?q=${encodeURIComponent('Тестовое')}`, { auth: token }); // same case: SQLite LIKE
  assert.deepEqual(found.body.items.map((p) => p.id), [created.body.id], 'admin search matches the Russian name');

  const csv = `id,name_ru\n${none.body.id},Пальто два\n`;
  const imp = await call('/api/admin/products/import', { method: 'POST', raw: csv, type: 'text/csv', auth: token });
  assert.deepEqual(imp.body, { created: 0, updated: 1 });
  assert.equal((await db('products').where({ id: none.body.id }).first()).name_ru, 'Пальто два');

  const rec = await call('/api/recommend', { method: 'POST', body: { store_id: storeId, gender: 'male', sizes: { top: 'L', bottom: 'L', shoes: '42' } } });
  const items = rec.body.outfits.flatMap((o) => o.items);
  assert.ok(items.length && items.every((p) => 'name_ru' in p), 'recommend items carry name_ru');
  assert.ok(items.some((p) => p.name_ru), 'seed items have Russian names');
});

test('stylist gets the customer language: Russian names and one extra line, Uzbek unchanged', async () => {
  const body = { store_id: storeId, gender: 'male', sizes: { top: 'L', bottom: 'L', shoes: '42' } };
  calls.length = 0;
  await call('/api/recommend', { method: 'POST', body, lang: 'ru' });
  await call('/api/recommend', { method: 'POST', body, lang: 'uz' });
  const [ru, uz] = calls.map((p) => p.messages[0].content.at(-1).text);
  assert.match(ru, /rus tilida yozilsin/);
  assert.doesNotMatch(uz, /rus tilida/);
  const names = (text) => JSON.parse(text.split('\n').at(-1)).CANDIDATES.map((c) => c.name);
  assert.ok(names(ru).some((n) => /[Ѐ-ӿ]/.test(n)), 'Russian candidate names');
  assert.ok(!names(uz).some((n) => /[Ѐ-ӿ]/.test(n)), 'Uzbek candidate names');
});
