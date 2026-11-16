// Task 36: each shop's own categories (name uz/ru, photo, order, hidden, outfit role, size kind), products in them with
// details and a Russian description, and every place the fixed list was used: product form, CSV, sync API, catalogue,
// "Nima kerak?", recommendations. Org isolation of the admin routes is in the task 22 walk (orgs.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDb } from './helpers/db.js';
import { demoGrid } from './helpers/demo-grid.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, uploadDir, tashkent, samarkand, orgT, orgS, owner, manager, staff, samOwner, superToken;
let weather = { temperature: 15, apparent_temperature: 15, raining: false, wind_speed: 2, source: 'live' };
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

const call = async (method, p, body, headers = {}, raw) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': raw ? raw.type : 'application/json', ...headers }, body: raw ? raw.data : body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
};
const admin = (method, p, body, token = owner, raw) => call(method, `/api/admin${p}`, body, { authorization: `Bearer ${token}` }, raw);
const login = async (email, password) => (await call('POST', '/api/admin/login', { email, password })).body.token;
const recommend = (extra) => call('POST', '/api/recommend', { store_id: tashkent, gender: 'male', sizes: { top: 'M', bottom: 'M', shoes: '42' }, ...extra });
const product = (extra) => ({ name: 'Test', gender: 'unisex', color: 'qora', price: 100000, ...extra });
const newCat = async (body, token = owner) => {
  const r = await admin('POST', '/categories', body, token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [tashkent, samarkand] = (await db('stores').orderBy('id')).map((s) => s.id);
  [orgT, orgS] = (await db('stores').orderBy('id')).map((s) => s.organization_id);
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  await createAdmin(db, { email: 'own@smartfit.uz', password: 'own-pass-1', storeId: tashkent });
  await createAdmin(db, { email: 'mgr@smartfit.uz', password: 'mgr-pass-1', storeId: tashkent, role: 'manager' });
  await createAdmin(db, { email: 'staff@smartfit.uz', password: 'staff-pass-1', storeId: tashkent, role: 'staff' });
  await createAdmin(db, { email: 'sam@smartfit.uz', password: 'sam-pass-1', storeId: samarkand });
  uploadDir = await mkdtemp(path.join(tmpdir(), 'sf-cats-'));
  server = createApp(db, { uploadDir, stylist: null, weather: async () => weather, telegram: null, limits: { recommend: 0, catalog: 0 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  [superToken, owner, manager, staff, samOwner] = await Promise.all([login('boss@smartfit.uz', 'boss-pass-1'), login('own@smartfit.uz', 'own-pass-1'),
    login('mgr@smartfit.uz', 'mgr-pass-1'), login('staff@smartfit.uz', 'staff-pass-1'), login('sam@smartfit.uz', 'sam-pass-1')]);
});
after(async () => {
  server.close();
  await db.destroy();
  await rm(uploadDir, { recursive: true, force: true });
});

test('migration 023: every organisation gets the five built-in categories, products point at theirs; down restores the column; up again', async () => {
  const m = testDb();
  try {
    for (let i = 0; i < 22; i++) await m.migrate.up(); // up to 022_qr_scans
    const ins = async (t, row) => (await m(t).insert(row).returning('id'))[0].id;
    const orgs = [await ins('organizations', { name: 'A' }), await ins('organizations', { name: 'B' })];
    const stores = [];
    for (const org of orgs) stores.push(await ins('stores', { name: `S${org}`, city: 'Toshkent', lat: 41, lon: 69, address: 'A', organization_id: org }));
    const base = { gender: 'male', color: 'oq', price: 1000, temp_min: 0, temp_max: 30 };
    const coat = await ins('products', { ...base, store_id: stores[0], name: 'Palto', category: 'outerwear' });
    const boots = await ins('products', { ...base, store_id: stores[1], name: 'Etik', category: 'shoes' });
    await m('product_stock').insert([{ product_id: coat, size: 'M', quantity: 2 }, { product_id: boots, size: '42', quantity: 1 }]);
    await m.migrate.up();
    for (const org of orgs) {
      const cats = await m('categories').where({ organization_id: org }).orderBy('sort');
      assert.deepEqual(cats.map((c) => [c.role, c.name, c.name_ru, c.sort, c.size_kind, Boolean(c.hidden)]), [
        ['outerwear', 'Ustki kiyim', 'Верхняя одежда', 1, 'clothes', false], ['top', "Ko'ylak / futbolka", 'Рубашка / футболка', 2, 'clothes', false],
        ['bottom', 'Shim / yubka', 'Брюки / юбка', 3, 'clothes', false], ['shoes', 'Poyabzal', 'Обувь', 4, 'shoes', false], ['accessory', 'Aksessuar', 'Аксессуар', 5, 'one', false]]);
    }
    const catOf = async (id) => m('categories').where({ id: (await m('products').where({ id }).first()).category_id }).first();
    assert.deepEqual([(await catOf(coat)).role, (await catOf(coat)).organization_id], ['outerwear', orgs[0]], 'each product → its own organisation\'s category');
    assert.deepEqual([(await catOf(boots)).role, (await catOf(boots)).organization_id], ['shoes', orgs[1]]);
    assert.equal((await m('product_stock').where({ product_id: coat }).first()).quantity, 2, 'stock rows survive the SQLite rebuild');
    // A role-less product is possible now; down turns it into an accessory (kept, not deleted) and the NOT NULL is back.
    const own = await ins('categories', { organization_id: orgs[0], name: 'Atirlar', name_ru: 'Духи', size_kind: 'custom', sizes: '50ml,100ml', sort: 6 });
    const perfume = await ins('products', { ...base, store_id: stores[0], name: 'Atir', category: null, category_id: own, sizes: '50ml,100ml', details: '[{"name":"Hajm","value":"50 ml"}]' });
    await m('product_stock').insert({ product_id: perfume, size: '50ml', quantity: 3 });
    await m.migrate.down();
    assert.ok(!(await m.schema.hasTable('categories')));
    const row = await m('products').where({ id: perfume }).first();
    assert.equal(row.category, 'accessory');
    for (const col of ['category_id', 'sizes', 'details', 'description_ru']) assert.ok(!(col in row), `${col} dropped`);
    assert.equal((await m('product_stock').where({ product_id: perfume }).first()).quantity, 3);
    await assert.rejects(m('products').insert({ ...base, store_id: stores[0], name: 'X', category: null }), 'category NOT NULL again');
    await m.migrate.up();
    assert.equal((await catOf(perfume)).role, 'accessory');
    assert.equal((await m('categories')).length, 10);
  } finally {
    await m.destroy();
  }
});

test('category CRUD: validation, unique names per organisation, owners manage, managers read, staff nothing', async () => {
  const list = await admin('GET', '/categories');
  assert.equal(list.status, 200);
  // Task 40: the demo shop also has one children's category per clothing role (sort 6–9).
  assert.deepEqual(list.body.map((c) => [c.role, c.audience]), [...['outerwear', 'top', 'bottom', 'shoes', 'accessory'].map((r) => [r, 'adult']), ...['outerwear', 'top', 'bottom', 'shoes'].map((r) => [r, 'child'])]);
  assert.ok(list.body.every((c) => c.organization_id === orgT && c.products > 0));
  const bags = await newCat({ name: 'Sumkalar', name_ru: 'Сумки', size_kind: 'one' });
  assert.deepEqual([bags.sort, bags.sizes, bags.role, bags.hidden, bags.products], [10, ['ONE'], null, false, 0]);
  for (const [body, code] of [
    [{ name: 'sumkalar', name_ru: 'Другое', size_kind: 'one' }, 'category_taken'], // any case
    [{ name: 'Obuv', name_ru: 'обувь', size_kind: 'one' }, 'category_taken'], // the Russian name of another one
    [{ name: 'X', size_kind: 'one' }, 'required'],
    [{ name: 'X', name_ru: 'Y'.repeat(61), size_kind: 'one' }, 'invalid'],
    [{ name: 'X', name_ru: 'Y', role: 'hat' }, 'invalid'],
    [{ name: 'X', name_ru: 'Y', size_kind: 'big' }, 'invalid'],
    [{ name: 'X', name_ru: 'Y', size_kind: 'custom' }, 'invalid'],
    [{ name: 'X', name_ru: 'Y', size_kind: 'custom', sizes: '98,98' }, 'invalid'],
    [{ name: 'X', name_ru: 'Y', size_kind: 'custom', sizes: '=1+2,98' }, 'invalid'],
    [{ name: 'X', name_ru: 'Y', size_kind: 'custom', sizes: Array.from({ length: 31 }, (_, i) => String(i + 1)) }, 'invalid'],
    [{ name: 'X', name_ru: 'Y', size_kind: 'one', hidden: 'yes' }, 'invalid'],
  ]) {
    const r = await admin('POST', '/categories', body);
    assert.equal(r.status, code === 'category_taken' ? 409 : 400, JSON.stringify(body));
    assert.equal(r.body.code, code);
  }
  // A role fixes the size kind; a custom list is cleaned.
  const shirts = await newCat({ name: "Ko'ylaklar", name_ru: 'Рубашки', role: 'top', size_kind: 'custom', sizes: '1,2' });
  assert.deepEqual([shirts.size_kind, shirts.sizes], ['clothes', ['XS', 'S', 'M', 'L', 'XL', 'XXL']]);
  const kids = await newCat({ name: 'Bolalar kiyimi', name_ru: 'Детская одежда', size_kind: 'custom', sizes: ' 98, 104;110 ' });
  assert.deepEqual(kids.sizes, ['98', '104', '110']);
  // Rename, reorder, hide.
  const r = await admin('PATCH', `/categories/${bags.id}`, { name: 'Sumkalar va hamyonlar', sort: 0, hidden: true });
  assert.deepEqual([r.body.name, r.body.sort, r.body.hidden, r.body.name_ru], ['Sumkalar va hamyonlar', 0, true, 'Сумки']);
  assert.equal((await admin('PATCH', `/categories/${bags.id}`, { name_ru: 'Обувь' })).status, 409);
  await admin('PATCH', `/categories/${bags.id}`, { name: 'Sumkalar', sort: 6, hidden: false });
  // Roles: managers only read, staff has no admin routes but its own.
  assert.equal((await admin('GET', '/categories', undefined, manager)).body.length, (await admin('GET', '/categories')).body.length);
  assert.equal((await admin('POST', '/categories', { name: 'M', name_ru: 'M', size_kind: 'one' }, manager)).status, 403);
  assert.equal((await admin('PATCH', `/categories/${bags.id}`, { hidden: true }, manager)).status, 403);
  assert.equal((await admin('DELETE', `/categories/${bags.id}`, undefined, manager)).status, 403);
  assert.equal((await admin('POST', `/categories/${bags.id}/image`, undefined, manager, { type: 'image/png', data: png })).status, 403);
  assert.equal((await admin('GET', '/categories', undefined, staff)).status, 403);
  // Super works on a named organisation (or a store of it) and sees every one without.
  assert.equal((await admin('POST', '/categories', { name: 'S', name_ru: 'S', size_kind: 'one' }, superToken)).status, 400);
  const sup = await newCat({ name: 'Atirlar', name_ru: 'Духи', size_kind: 'custom', sizes: '50ml,100ml', store_id: samarkand }, superToken);
  assert.equal(sup.organization_id, orgS);
  assert.ok((await admin('GET', '/categories', undefined, superToken)).body.some((c) => c.organization_id === orgT));
  assert.ok((await admin('GET', `/categories?store_id=${samarkand}`, undefined, superToken)).body.every((c) => c.organization_id === orgS));
  // Photo: same checks as product photos.
  assert.equal((await admin('POST', `/categories/${bags.id}/image`, undefined, owner, { type: 'image/png', data: Buffer.from('<svg onload=alert(1)>xxxxxxxxx') })).status, 400);
  const img = await admin('POST', `/categories/${bags.id}/image`, undefined, owner, { type: 'image/png', data: png });
  assert.match(img.body.image_url, /^\/uploads\/categories\/\d+-[a-f0-9]{16}\.png$/);
  assert.deepEqual(await readFile(path.join(uploadDir, 'categories', path.basename(img.body.image_url))), png);
  // Delete: refused while products are in it (hide instead), fine when empty.
  const top = list.body.find((c) => c.role === 'top');
  const busy = await admin('DELETE', `/categories/${top.id}`);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'category_in_use');
  const empty = await newCat({ name: "Bo'sh", name_ru: 'Пусто', size_kind: 'one' });
  assert.equal((await admin('DELETE', `/categories/${empty.id}`)).status, 204);
  assert.equal(await db('categories').where({ id: empty.id }).first(), undefined);
  assert.ok((await db('audit_log').where({ action: 'category.delete', entity_id: empty.id }).first()), 'audited');
  // At most 100 per organisation.
  const filler = Array.from({ length: 100 }, (_, i) => ({ organization_id: orgS, name: `F${i}`, name_ru: `Ф${i}`, size_kind: 'one', sort: 50 + i }));
  await db('categories').insert(filler);
  assert.equal((await admin('POST', '/categories', { name: 'Ortiqcha', name_ru: 'Лишняя', size_kind: 'one' }, samOwner)).body.code, 'categories_max');
  await db('categories').where({ organization_id: orgS }).whereLike('name', 'F%').del();
});

test('products take only their own shop\'s category; details, Russian description; temperature only for outfit roles', async () => {
  const cats = (await admin('GET', '/categories')).body;
  const bags = cats.find((c) => c.name === 'Sumkalar'), top = cats.find((c) => c.role === 'top');
  const perfume = (await admin('GET', `/categories?store_id=${samarkand}`, undefined, superToken)).body.find((c) => c.name === 'Atirlar');
  const r = await admin('POST', '/products', product({ name: 'Charm sumka', category_id: bags.id, stock: { ONE: 3 }, description: 'Tabiiy charm', description_ru: 'Натуральная кожа',
    details: [{ name: 'Mato', value: '100% charm' }, { name: '', value: ' ' }, { name: 'Brend', value: 'Smart' }] }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.category, r.body.category_id, r.body.temp_min, r.body.temp_max, r.body.waterproof], [null, bags.id, -60, 60, false], 'no role: any weather');
  assert.deepEqual(r.body.details, [{ name: 'Mato', value: '100% charm' }, { name: 'Brend', value: 'Smart' }], 'blank rows dropped');
  assert.deepEqual(r.body.stock.map((s) => [s.size, s.quantity]), [['ONE', 3]]);
  // Another organisation's category: refused by id, and its name is unknown here.
  for (const body of [{ category_id: perfume.id }, { category: 'Atirlar' }, { category_id: 999999 }]) {
    const bad = await admin('POST', '/products', product({ ...body, temp_min: 0, temp_max: 30 }));
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.equal(bad.body.code, 'category_unknown');
    assert.ok(bad.body.error.includes('Sumkalar') && !bad.body.error.includes('Atirlar'), 'lists this shop\'s categories only');
  }
  assert.equal((await admin('PATCH', `/products/${r.body.id}`, { category_id: perfume.id })).status, 400);
  // An outfit role needs the temperature range; an old role code still works and lands in that role's first category.
  assert.equal((await admin('POST', '/products', product({ category_id: top.id }))).body.code, 'invalid');
  const old = await admin('POST', '/products', product({ category: 'top', temp_min: 0, temp_max: 30 }));
  assert.equal(old.body.category_id, top.id);
  // Switching to a category with other sizes would orphan the stock rows.
  assert.equal((await admin('PATCH', `/products/${old.body.id}`, { category_id: bags.id })).body.code, 'category_locked');
  assert.equal((await admin('PATCH', `/products/${old.body.id}`, { category_id: cats.find((c) => c.name === "Ko'ylaklar").id })).status, 200, 'same sizes: fine');
  // Details: at most 10, both cells, capped lengths.
  for (const details of [Array.from({ length: 11 }, (_, i) => ({ name: `N${i}`, value: 'v' })), [{ name: 'Mato', value: '' }], [{ name: 'x'.repeat(41), value: 'v' }], 'nope', [['a', 'b']]]) {
    assert.equal((await admin('PATCH', `/products/${r.body.id}`, { details })).status, 400, JSON.stringify(details).slice(0, 60));
  }
  // The item page shows them as data (the app sets them as text), in both languages.
  const item = await call('GET', `/api/catalog/${tashkent}/items/${r.body.id}`);
  assert.deepEqual([item.body.item.description, item.body.item.description_ru, item.body.item.details, item.body.item.all_sizes, item.body.item.category_name],
    ['Tabiiy charm', 'Натуральная кожа', [{ name: 'Mato', value: '100% charm' }, { name: 'Brend', value: 'Smart' }], ['ONE'], 'Sumkalar']);
  assert.deepEqual(item.body.pairs, [], 'a role-less item has no "goes well with"');
  // Audit keeps the category by name and the details.
  const log = await db('audit_log').where({ action: 'product.create', entity_id: r.body.id }).first();
  const after = typeof log.after === 'string' ? JSON.parse(log.after) : log.after;
  assert.deepEqual([after.category, after.details.length], ['Sumkalar', 2]);
});

test('role-less and custom-size categories: never in an outfit, but in the catalogue, single items and "Nima kerak?"; stock > 0 only', async () => {
  const cats = (await admin('GET', '/categories')).body;
  const kids = cats.find((c) => c.name === 'Bolalar kiyimi'), bags = cats.find((c) => c.name === 'Sumkalar');
  const jacket = (await admin('POST', '/products', product({ name: 'Bolalar kurtkasi', category_id: kids.id, stock: { 98: 2, 104: 0, 110: 1 } }))).body;
  assert.deepEqual(jacket.stock.map((s) => s.size), ['98', '104', '110']);
  const bagIds = (await db('products').where({ category_id: bags.id })).map((p) => p.id);
  const mine = new Set([jacket.id, ...bagIds]);
  // The start screen lists the shop's shown categories in its order, with role and photo.
  const store = (await call('GET', `/api/stores/${tashkent}`)).body;
  assert.deepEqual(store.categories.map((c) => [c.id, c.name, c.name_ru, c.role]), cats.filter((c) => !c.hidden).map((c) => [c.id, c.name, c.name_ru, c.role]));
  assert.deepEqual(store.categories.filter((c) => c.audience === 'adult').slice(5).map((c) => [c.name, c.role]), [['Sumkalar', null], ["Ko'ylaklar", 'top'], ['Bolalar kiyimi', null]]);
  // Whole outfits at every weather: never a role-less item.
  for (const [temperature, raining] of [[-10, false], [5, false], [15, false], [17, true], [30, false]]) {
    weather = { ...weather, temperature, raining };
    const r = await recommend({});
    assert.equal(r.status, 200);
    assert.ok(r.body.outfits.length);
    for (const o of r.body.outfits) for (const p of [...o.items, ...(o.alternative?.items ?? [])]) assert.ok(!mine.has(p.id) && p.category, `${p.name} has a role`);
  }
  weather = { ...weather, temperature: 15, raining: false };
  // Single items by category id: only sizes with free stock, picked on the card (no customer size needed).
  const single = await recommend({ sizes: {}, want: [kids.id, bags.id] });
  assert.equal(single.status, 200, JSON.stringify(single.body));
  assert.deepEqual(single.body.groups.map((g) => g.category), [bags.id, kids.id], 'in the shop\'s order, not the order asked');
  const card = single.body.groups[1].items.find((i) => i.id === jacket.id);
  assert.deepEqual([card.size, card.sizes, card.pairs], [null, ['98', '110'], []]);
  assert.ok(single.body.groups[0].items.some((i) => bagIds.includes(i.id)));
  await db('product_stock').where({ product_id: jacket.id, size: '110' }).update({ reserved: 1 });
  assert.deepEqual((await recommend({ sizes: {}, want: [kids.id] })).body.groups[0].items.find((i) => i.id === jacket.id).sizes, ['98'], 'a fully held size is gone');
  // A role category id behaves like its role: the size it needs is asked.
  assert.equal((await recommend({ sizes: {}, want: [cats.find((c) => c.role === 'top').id] })).body.code, 'required');
  // Catalogue: by category id, sizes with free stock only; the item page knows every size.
  const cat = await call('GET', `/api/catalog/${tashkent}?category=${kids.id}`);
  assert.deepEqual(cat.body.items.map((p) => [p.id, p.sizes, p.category_name]), [[jacket.id, ['98'], 'Bolalar kiyimi']]);
  assert.deepEqual((await call('GET', `/api/catalog/${tashkent}?size=110`)).body.items.filter((p) => p.id === jacket.id), [], 'held size filtered out');
  assert.deepEqual((await call('GET', `/api/catalog/${tashkent}/items/${jacket.id}`)).body.item.all_sizes, ['98', '104', '110']);
  // Cart: the shop's own sizes, stock > 0 only.
  const add = (size, token) => call('POST', '/api/cart/items', { store_id: tashkent, token, items: [{ product_id: jacket.id, size }] });
  const cart = await add('98');
  assert.ok(cart.status < 300, JSON.stringify(cart.body));
  assert.deepEqual([cart.body.items[0].category_name, cart.body.items[0].sizes], ['Bolalar kiyimi', ['98']]);
  assert.equal((await add('104', cart.body.token)).status, 409);
  assert.equal((await add('M', cart.body.token)).status, 400);
  // Hidden: gone for customers everywhere, still in admin.
  await admin('PATCH', `/categories/${kids.id}`, { hidden: true });
  assert.ok(!(await call('GET', `/api/stores/${tashkent}`)).body.categories.some((c) => c.id === kids.id));
  assert.equal((await recommend({ sizes: {}, want: [kids.id] })).status, 400);
  assert.ok(!(await call('GET', `/api/catalog/${tashkent}`)).body.items.some((p) => p.id === jacket.id));
  assert.equal((await call('GET', `/api/catalog/${tashkent}/items/${jacket.id}`)).status, 404);
  await admin('PATCH', `/categories/${kids.id}`, { hidden: false });
  // Another shop's category can't be wanted here.
  const perfume = (await admin('GET', `/categories?store_id=${samarkand}`, undefined, superToken)).body.find((c) => c.name === 'Atirlar');
  assert.equal((await recommend({ sizes: {}, want: [perfume.id] })).status, 400);
  // Growing the list adds stock rows at 0; shrinking or reordering is refused while products are in it.
  assert.equal((await admin('PATCH', `/categories/${kids.id}`, { sizes: '98,110' })).body.code, 'category_sizes_locked');
  assert.deepEqual((await admin('PATCH', `/categories/${kids.id}`, { sizes: '98,104,110,116' })).body.sizes, ['98', '104', '110', '116']);
  assert.deepEqual((await db('product_stock').where({ product_id: jacket.id }).orderBy('id')).map((s) => [s.size, s.quantity]), [['98', 2], ['104', 0], ['110', 1], ['116', 0]]);
  assert.equal((await db('products').where({ id: jacket.id }).first()).sizes, '98,104,110,116');
  // A role change keeps the sizes and moves the products into (or out of) outfits.
  const plain = await newCat({ name: 'Futbolkalar', name_ru: 'Футболки', size_kind: 'clothes' });
  const tee = (await admin('POST', '/products', product({ name: 'Oddiy futbolka', category_id: plain.id, stock: { M: 4 } }))).body;
  assert.equal((await admin('PATCH', `/categories/${plain.id}`, { role: 'shoes' })).body.code, 'category_sizes_locked', 'other sizes');
  await admin('PATCH', `/categories/${plain.id}`, { role: 'top' });
  assert.deepEqual(Object.values(await db('products').where({ id: tee.id }).first('category', 'sizes')), ['top', null]);
  await admin('PATCH', `/categories/${plain.id}`, { role: null });
  assert.deepEqual(Object.values(await db('products').where({ id: tee.id }).first('category', 'sizes')), [null, 'XS,S,M,L,XL,XXL']);
});

test('CSV import by category name (Uzbek or Russian, any case, or an old role code), the shop\'s own size columns; unknown names list the shop\'s', async () => {
  const cats = (await admin('GET', '/categories')).body;
  const id = (name) => cats.find((c) => c.name === name).id;
  const csv = (rows) => admin('POST', '/products/import', undefined, owner, { type: 'text/csv', data: rows.join('\n') });
  await newCat({ name: 'Narxli', name_ru: 'С ценой', size_kind: 'custom', sizes: 'price,id' }); // sizes named like columns stay columns
  const ok = await csv(['sku,name,category,gender,color,price,temp_min,temp_max,ONE,98,M',
    'CSV-1,Hamyon,sumkalar,unisex,qora,90000,,,4,,', 'CSV-2,Ryukzak,СУМКИ,unisex,qora,190000,,,1,,',
    'CSV-3,Bolalar shimi,Bolalar kiyimi,unisex,qora,150000,,,,5,', 'CSV-4,Futbolka,top,male,oq,80000,0,30,,,2']);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.created, 4);
  const got = Object.fromEntries((await db('products').whereLike('sku', 'CSV-%').select('sku', 'category_id', 'category')).map((p) => [p.sku, [p.category_id, p.category]]));
  assert.deepEqual(got, { 'CSV-1': [id('Sumkalar'), null], 'CSV-2': [id('Sumkalar'), null], 'CSV-3': [id('Bolalar kiyimi'), null], 'CSV-4': [cats.find((c) => c.role === 'top').id, 'top'] });
  const kidsStock = await db('product_stock').join('products as p', 'p.id', 'product_stock.product_id').where('p.sku', 'CSV-3').where('size', '98').first();
  assert.equal(kidsStock.quantity, 5);
  // Unknown name, or another shop's: a row error listing this shop's categories; nothing is imported.
  const bad = await csv(['name,category,gender,color,price,ONE', 'Atir,Atirlar,unisex,qora,90000,1', "Atir 2,Yo'q,unisex,qora,90000,1"]);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors.map((e) => e.code), ['category_unknown', 'category_unknown']);
  assert.ok(bad.body.errors[0].error.includes('Sumkalar') && bad.body.errors[0].error.includes('Bolalar kiyimi') && !bad.body.errors[0].error.includes('Atirlar'));
  // A size column of another shop's own list is not a column here; a size not in the row's category is refused.
  assert.equal((await csv(['name,category,gender,color,price,100ml', 'Atir,Sumkalar,unisex,qora,90000,1'])).body.code, 'csv_unknown');
  assert.equal((await csv(['name,category,gender,color,price,98', 'Hamyon 2,Sumkalar,unisex,qora,90000,1'])).body.errors[0].code, 'bad_size');
  // The sample file uses the built-in names and still imports.
  const sample = await readFile(new URL('../public/admin/sample-products.csv', import.meta.url), 'utf8');
  assert.ok(sample.includes(';Ustki kiyim;') && !sample.includes(';outerwear;'));
});

test('stock sync API: a product in a shop\'s own size list syncs by those sizes', async () => {
  const kids = (await admin('GET', '/categories')).body.find((c) => c.name === 'Bolalar kiyimi');
  await admin('POST', '/products', product({ name: 'Sync kurtka', sku: 'SYNC-KIDS', category_id: kids.id }));
  const key = (await admin('POST', '/sync-keys', { name: 'Kassa' })).body.key;
  const sync = (items) => call('POST', '/api/sync/stock', { items }, { authorization: `Bearer ${key}` });
  const r = await sync([{ sku: 'SYNC-KIDS', size: '104', quantity: 7 }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await db('product_stock').join('products as p', 'p.id', 'product_stock.product_id').where({ 'p.sku': 'SYNC-KIDS', size: '104' }).first()).quantity, 7);
  assert.equal((await sync([{ sku: 'SYNC-KIDS', size: 'M', quantity: 1 }])).body.errors[0].code, 'bad_size');
});

test('recommendations for the demo stores are unchanged (outfits, single items, catalogue), also when wanted by category id', async () => {
  const m = testDb();
  let w;
  const app = createApp(m, { stylist: null, weather: async () => w, telegram: null, limits: { recommend: 0, catalog: 0 } }).listen(0);
  await new Promise((r) => app.once('listening', r)); // before any await: on Postgres it would already have fired
  try {
    await m.migrate.latest();
    await seed(m);
    const url = `http://127.0.0.1:${app.address().port}`;
    const fixture = JSON.parse(await readFile(new URL('./fixtures/demo-recommendations.json', import.meta.url), 'utf8'));
    assert.deepEqual(await demoGrid(url, (x) => { w = x; }), fixture, 'same answers as before task 36');
    // "Nima kerak?" now sends the shop's category ids: for the demo's built-in categories the answer is the same.
    const byId = async (role, store) => [(await m('categories as c').join('stores as s', 's.organization_id', 'c.organization_id').where({ 's.id': store, 'c.role': role }).first('c.id')).id];
    const grid = await demoGrid(url, (x) => { w = x; }, byId);
    for (const k of Object.keys(fixture).filter((x) => x.startsWith('single'))) assert.deepEqual(grid[k], fixture[k], k);
  } finally {
    app.close();
    await m.destroy();
  }
});
