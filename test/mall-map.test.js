// Task 44: the mall map. Plan upload limits; pins only by this mall's admin, only for its own shops and kiosks, as
// percentages; a hidden shop has no public pin; floors follow the shops' floor values; open / closed at the edges of
// the hours and across midnight; the directory filters; the mall order page's map link; mall isolation; the seed;
// migration 034 up and down.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDb, json } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { imageSize, PLAN_PX_MAX, SPOTS_MAX } from '../src/admin/malls.js';
import { openAt, floorsOf, categoriesOf, filterShops } from '../public/app/directory.js';

process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, uploadDir, s1, s2, s3, mallA, mallB, floor1, floor2, mallTokenA, mallTokenB, ownerA;

const call = async (method, p, body, token, { raw, type } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': type || 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
};
const admin = (method, p, body, token, opts) => call(method, `/api/admin${p}`, body, token, opts);
const login = async (email, password) => (await admin('POST', '/login', { email, password })).body.token;

// Image headers with a real size: PNG (IHDR), JPEG (an APP0 segment, then SOF0), WebP (VP8X, VP8L, VP8).
const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (w, h) => { const b = Buffer.alloc(33); MAGIC.copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0, 0, 0, 0, 0, 0]);
const webp = (kind, w, h) => {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write(kind, 12, 'latin1');
  if (kind === 'VP8X') { b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); }
  if (kind === 'VP8 ') { b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); }
  if (kind === 'VP8L') { const v = (w - 1) | ((h - 1) << 14); b[20] = 0x2f; b.writeUInt32LE(v >>> 0, 21); }
  return b;
};
// Tashkent wall-clock time on a fixed day → ms (UTC+5).
const at = (hhmm) => Date.parse(`2026-11-16T${hhmm}:00+05:00`);

before(async () => {
  await db.migrate.latest();
  await seed(db); // the demo mall: two floors with plans, the two shops pinned, one kiosk spot
  [s1, s2] = (await db('stores').orderBy('id')).map((s) => s.id);
  mallA = (await db('malls').first()).id;
  [floor1, floor2] = (await db('mall_floors').where({ mall_id: mallA }).orderBy('name')).map((f) => f.id);
  [{ id: mallB }] = await db('malls').insert({ name: 'Ikkinchi markaz', city: 'Toshkent', address: 'Navoiy 5' }).returning('id');
  const orgA = (await db('stores').where({ id: s1 }).first()).organization_id;
  [{ id: s3 }] = await db('stores').insert({ name: 'B markaz do\'koni', city: 'Toshkent', address: 'Navoiy 5', lat: 41.3, lon: 69.25, organization_id: orgA, mall_id: mallB, mall_floor: '1' }).returning('id');
  await createAdmin(db, { email: 'mall.a@smartfit.uz', password: 'mall-pass-1', mallId: mallA });
  await createAdmin(db, { email: 'mall.b@smartfit.uz', password: 'mall-pass-2', mallId: mallB });
  await createAdmin(db, { email: 'owner.a@smartfit.uz', password: 'owner-pass-1', storeId: s1 });
  uploadDir = await mkdtemp(path.join(tmpdir(), 'sf-map-'));
  server = createApp(db, { uploadDir, telegram: null, stylist: null, weather: async () => ({ temperature: 15, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  mallTokenA = await login('mall.a@smartfit.uz', 'mall-pass-1');
  mallTokenB = await login('mall.b@smartfit.uz', 'mall-pass-2');
  ownerA = await login('owner.a@smartfit.uz', 'owner-pass-1');
});

after(async () => {
  server?.close();
  await db.destroy();
  await rm(uploadDir, { recursive: true, force: true });
});

test('seed: the demo mall has two floors with plans, both shops pinned, one kiosk spot and opening hours', async () => {
  const r = (await call('GET', `/api/malls/${mallA}`)).body;
  assert.deepEqual(r.floors.map((f) => [f.name, f.plan_url, f.plan_w, f.plan_h]), [['1', '/uploads/malls/demo-plan-1.svg', 1200, 800], ['2', '/uploads/malls/demo-plan-2.svg', 1200, 800]]);
  assert.ok(r.shops.every((s) => s.pin && s.pin.x > 0 && s.pin.x < 100 && s.pin.y > 0 && s.pin.y < 100));
  assert.deepEqual([s1, s2].map((id) => r.shops.find((s) => s.id === id)).map((s) => [s.floor, s.opens_at, s.closes_at]), [['1', '10:00', '22:00'], ['2', '09:00', '21:00']]);
  assert.deepEqual(r.spots, [{ id: 1, floor_id: floor1, pin: { x: 50, y: 75 } }], 'no admin label on the public map');
  // Seed counts other tests rely on stay as they were.
  assert.equal((await db('stores')).length, 3); // + this file's mall B store
  assert.equal((await db('offers')).length, 3);
  // With an upload directory the generated plans are written as files.
  const dir = await mkdtemp(path.join(tmpdir(), 'sf-map-seed-'));
  const m = testDb();
  try {
    await m.migrate.latest();
    await seed(m, { uploadDir: dir });
    assert.deepEqual((await readdir(path.join(dir, 'malls'))).sort(), ['demo-plan-1.svg', 'demo-plan-2.svg']);
    assert.match(await readFile(path.join(dir, 'malls', 'demo-plan-2.svg'), 'utf8'), /^<svg[^>]+viewBox="0 0 1200 800"[\s\S]*>215</);
  } finally {
    await m.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test('image size from the header: PNG, JPEG, WebP (VP8, VP8L, VP8X); a cut-off header is null', () => {
  assert.deepEqual(imageSize(png(1600, 900), 'png'), { w: 1600, h: 900 });
  assert.deepEqual(imageSize(jpeg(1024, 768), 'jpg'), { w: 1024, h: 768 });
  for (const kind of ['VP8 ', 'VP8L', 'VP8X']) assert.deepEqual(imageSize(webp(kind, 800, 600), 'webp'), { w: 800, h: 600 }, kind);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'jpg'), null);
  assert.equal(imageSize(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from('not a segment')]), 'jpg'), null);
});

test('plan upload: raster only, ≤ 2 MB, ≤ 4096 px a side, a random name, the old file removed; only this mall\'s floors', async () => {
  const up = (buf, token = mallTokenA, floor = floor1) => admin('POST', `/mall/floors/${floor}/plan`, undefined, token, { raw: buf, type: 'application/octet-stream' });
  assert.equal((await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status, 400, 'no SVG');
  assert.equal((await up(Buffer.from('GIF89a' + 'x'.repeat(20)))).status, 400, 'no GIF');
  assert.equal((await up(png(0, 10))).status, 400, 'a zero size is not an image');
  let r = await up(png(PLAN_PX_MAX + 1, 100));
  assert.deepEqual([r.status, r.body.code], [400, 'plan_big']);
  assert.match(r.body.error, /4096/);
  assert.equal((await up(jpeg(100, PLAN_PX_MAX + 1))).status, 400);
  assert.equal((await up(Buffer.concat([png(100, 100), Buffer.alloc(2 * 1024 * 1024)]))).status, 413, 'over 2 MB');
  r = await up(png(PLAN_PX_MAX, 2000));
  assert.equal(r.status, 200);
  assert.match(r.body.plan_url, new RegExp(`^/uploads/malls/f${floor1}-[0-9a-f]{16}\\.png$`));
  assert.deepEqual([r.body.plan_w, r.body.plan_h], [PLAN_PX_MAX, 2000]);
  const first = r.body.plan_url;
  r = await up(webp('VP8X', 1200, 800));
  assert.match(r.body.plan_url, /\.webp$/);
  const files = await readdir(path.join(uploadDir, 'malls'));
  assert.ok(!files.includes(path.basename(first)) && files.includes(path.basename(r.body.plan_url)), 'the replaced plan file is gone');
  const audit = await db('audit_log').where({ action: 'mall.map' }).orderBy('id', 'desc').first();
  assert.deepEqual([audit.entity, audit.entity_id, audit.store_id, audit.entity_label], ['mall', mallA, null, '1']);
  // Another mall's floor is 404 both ways; a shop owner is refused.
  assert.equal((await up(png(10, 10), mallTokenB)).status, 404);
  assert.equal((await up(png(10, 10), ownerA)).status, 403);
  assert.equal((await admin('DELETE', `/mall/floors/${floor1}/plan`, undefined, mallTokenB)).status, 404);
  assert.equal((await admin('POST', '/mall/floors/99999999999/plan', undefined, mallTokenA, { raw: png(10, 10), type: 'image/png' })).status, 404);
});

test('pins: percentages 0–100 kept to 2 decimals; only this mall\'s shops; a plan is needed; a new floor drops the pin', async () => {
  const pin = (store, body, token = mallTokenA) => admin('PATCH', `/mall/stores/${store}`, body, token);
  for (const bad of [{ x: -0.01, y: 5 }, { x: 5, y: 100.01 }, { x: '5', y: 5 }, { x: 5 }, null, 'here', { x: NaN, y: 1 }]) {
    if (bad === null) continue; // null removes the pin (below)
    const r = await pin(s1, { pin: bad });
    assert.deepEqual([r.status, r.body.code], [400, 'invalid'], JSON.stringify(bad));
  }
  let r = await pin(s1, { pin: { x: 12.345, y: 99.999 } });
  assert.deepEqual(r.body.pin, { x: 12.35, y: 100 });
  assert.deepEqual(await db('stores').where({ id: s1 }).first('map_x', 'map_y'), { map_x: 1235, map_y: 10000 });
  assert.deepEqual((await pin(s1, { pin: { x: 0, y: 0 } })).body.pin, { x: 0, y: 0 }, 'the edges are on the plan');
  assert.deepEqual(json((await db('audit_log').where({ action: 'mall.store', store_id: s1 }).orderBy('id', 'desc').first()).after), { pin: { x: 0, y: 0 } });
  // Only this mall's shops: another mall's store is 404, mall B never reaches mall A, a shop owner is refused.
  assert.equal((await pin(s3, { pin: { x: 1, y: 1 } })).status, 404);
  assert.equal((await pin(s1, { pin: { x: 1, y: 1 } }, mallTokenB)).status, 404);
  assert.equal((await pin(s1, { pin: { x: 1, y: 1 } }, ownerA)).status, 403);
  // A floor without a plan can't take a pin; a new floor drops the old pin (it was a point on another picture).
  r = await pin(s1, { floor: '7', pin: { x: 5, y: 5 } });
  assert.deepEqual([r.status, r.body.code], [409, 'map_no_plan']);
  r = await pin(s1, { floor: '7' });
  assert.equal(r.body.pin, null);
  assert.ok(await db('mall_floors').where({ mall_id: mallA, name: '7' }).first(), 'the new floor got a row');
  r = await pin(s1, { floor: '1', pin: { x: 40, y: 30 } });
  assert.deepEqual(r.body.pin, { x: 40, y: 30 });
  assert.equal(await db('mall_floors').where({ mall_id: mallA, name: '7' }).first(), undefined, 'an unused floor without a plan goes');
  r = await pin(s1, { unit: '105' });
  assert.deepEqual(r.body.pin, { x: 40, y: 30 }, 'other edits keep the pin');
  assert.equal((await pin(s1, { pin: null })).body.pin, null);
  await pin(s1, { pin: { x: 57.78, y: 23.13 } });
  // A shop on a floor with no shops left and a plan keeps the floor row (the plan is the mall admin's work).
  assert.ok(await db('mall_floors').where({ id: floor2 }).first());
});

test('the public map: a hidden shop has no pin; floors without a plan are not tabs and their pins don\'t show', async () => {
  let r = (await call('GET', `/api/malls/${mallA}`)).body;
  assert.ok(r.shops.find((s) => s.id === s2).pin);
  assert.equal((await admin('PATCH', `/mall/stores/${s2}`, { hidden: true }, mallTokenA)).status, 200);
  r = (await call('GET', `/api/malls/${mallA}`)).body;
  assert.deepEqual(r.shops.map((s) => s.id), [s1], 'a hidden shop is not listed, so it has no pin');
  assert.ok(!JSON.stringify(r).includes('Samarqand'));
  await admin('PATCH', `/mall/stores/${s2}`, { hidden: false }, mallTokenA);
  // Floor 2's plan removed: no tab, s2's pin kept in the database but not shown; kiosk spots of that floor not shown.
  const [{ id: spot2 }] = await db('mall_spots').insert({ mall_id: mallA, floor_id: floor2, label: 'Ikkinchi qavat', x: 100, y: 100 }).returning('id');
  assert.ok((await call('GET', `/api/malls/${mallA}`)).body.spots.some((k) => k.id === spot2));
  assert.equal((await admin('DELETE', `/mall/floors/${floor2}/plan`, undefined, mallTokenA)).status, 204);
  r = (await call('GET', `/api/malls/${mallA}`)).body;
  assert.deepEqual(r.floors.map((f) => f.name), ['1']);
  assert.equal(r.shops.find((s) => s.id === s2).pin, null);
  assert.ok(!r.spots.some((k) => k.id === spot2));
  assert.notEqual((await db('stores').where({ id: s2 }).first()).map_x, null, 'the pin waits for a new plan');
  assert.ok(await db('mall_floors').where({ id: floor2 }).first(), 'a floor with shops stays');
  // No plan anywhere: the directory answers exactly as before, plus empty floors / spots and no pins.
  await db('mall_floors').where({ id: floor1 }).update({ plan_url: null });
  r = (await call('GET', `/api/malls/${mallA}`)).body;
  assert.deepEqual([r.floors, r.spots, r.shops.map((s) => s.pin)], [[], [], [null, null]]);
  await db('mall_floors').where({ id: floor1 }).update({ plan_url: '/uploads/malls/demo-plan-1.svg' });
  await db('mall_floors').where({ id: floor2 }).update({ plan_url: '/uploads/malls/demo-plan-2.svg', plan_w: 1200, plan_h: 800 });
  await db('mall_spots').where({ id: spot2 }).del();
  // Mall B's directory never shows mall A's floors, pins or spots.
  r = (await call('GET', `/api/malls/${mallB}`)).body;
  assert.deepEqual([r.floors, r.spots, r.shops.map((s) => s.id)], [[], [], [s3]]);
});

test('kiosk spots: on a floor with a plan of this mall, label required, ≤ 50; the kiosk link carries the spot id', async () => {
  const post = (body, token = mallTokenA) => admin('POST', '/mall/spots', body, token);
  let r = await post({ floor_id: floor1, label: 'Kirish', pin: { x: 10.5, y: 90 } });
  assert.equal(r.status, 201);
  const id = r.body.id;
  assert.deepEqual([r.body.floor_id, r.body.label, r.body.pin], [floor1, 'Kirish', { x: 10.5, y: 90 }]);
  assert.match(r.body.kiosk_url, new RegExp(`/kiosk\\?mall=${mallA}&spot=${id}$`));
  for (const [bad, code] of [[{ floor_id: floor1, pin: { x: 1, y: 1 } }, 'required'], [{ floor_id: floor1, label: 'x'.repeat(61), pin: { x: 1, y: 1 } }, 'invalid'],
    [{ floor_id: floor1, label: 'X', pin: { x: 101, y: 1 } }, 'invalid'], [{ floor_id: '1', label: 'X', pin: { x: 1, y: 1 } }, 'invalid'], [{ floor_id: 99999999999, label: 'X', pin: { x: 1, y: 1 } }, 'invalid']]) {
    assert.equal((await post(bad)).body.code, code, JSON.stringify(bad));
  }
  const [{ id: bare }] = await db('mall_floors').insert({ mall_id: mallA, name: '9' }).returning('id');
  assert.equal((await post({ floor_id: bare, label: 'X', pin: { x: 1, y: 1 } })).status, 409, 'no plan on that floor');
  await db('mall_floors').where({ id: bare }).del();
  const [{ id: floorB }] = await db('mall_floors').insert({ mall_id: mallB, name: '1', plan_url: '/uploads/malls/b.png', plan_w: 10, plan_h: 10 }).returning('id');
  assert.equal((await post({ floor_id: floorB, label: 'X', pin: { x: 1, y: 1 } })).status, 400, 'another mall\'s floor');
  // PATCH moves it (floor, place, label); another mall's admin gets 404; DELETE removes it.
  r = await admin('PATCH', `/mall/spots/${id}`, { floor_id: floor2, pin: { x: 20, y: 30 } }, mallTokenA);
  assert.deepEqual([r.body.floor_id, r.body.label, r.body.pin], [floor2, 'Kirish', { x: 20, y: 30 }]);
  assert.equal((await admin('PATCH', `/mall/spots/${id}`, { floor_id: floorB }, mallTokenA)).status, 400);
  assert.equal((await admin('PATCH', `/mall/spots/${id}`, { label: 'Y' }, mallTokenB)).status, 404);
  assert.equal((await admin('DELETE', `/mall/spots/${id}`, undefined, mallTokenB)).status, 404);
  assert.equal((await admin('DELETE', `/mall/spots/${id}`, undefined, mallTokenA)).status, 204);
  assert.equal(await db('mall_spots').where({ id }).first(), undefined);
  assert.deepEqual((await db('audit_log').where({ action: 'mall.map' }).orderBy('id', 'desc').limit(3)).map((a) => [a.before === null, a.after === null]), [[false, true], [false, false], [true, false]]);
  // The limit counts per mall.
  const have = Number((await db('mall_spots').where({ mall_id: mallA }).count({ n: '*' }))[0].n);
  await db('mall_spots').insert(Array.from({ length: SPOTS_MAX - have }, (_, i) => ({ mall_id: mallA, floor_id: floor1, label: `K${i}`, x: 1, y: 1 })));
  r = await post({ floor_id: floor1, label: 'Ortiqcha', pin: { x: 1, y: 1 } });
  assert.deepEqual([r.status, r.body.code], [409, 'spots_max']);
  assert.equal((await post({ floor_id: floorB, label: 'B', pin: { x: 1, y: 1 } }, mallTokenB)).status, 201, 'mall B has its own count');
  await db('mall_spots').where({ mall_id: mallA }).where('label', 'like', 'K%').del();
  // The admin's map view: its own floors, shops (with hidden ones, for the admin) and spots only.
  const map = (await admin('GET', '/mall/map', undefined, mallTokenA)).body;
  assert.deepEqual(map.floors.map((f) => f.name), ['1', '2']);
  assert.deepEqual(map.shops.map((s) => s.id).sort(), [s1, s2].sort());
  assert.ok(map.spots.every((k) => k.kiosk_url.endsWith(`&spot=${k.id}`)));
  assert.equal((await admin('GET', '/mall/map', undefined, ownerA)).status, 403);
});

test('floors follow the shops: the migration fills them from floor values; a store leaving the mall loses its pin', async () => {
  const m = testDb();
  try {
    for (let i = 0; i < 33; i++) await m.migrate.up(); // up to 033_offers
    const ins = async (t, row) => (await m(t).insert(row).returning('id'))[0].id;
    const org = await ins('organizations', { name: 'Brend' });
    const mall = await ins('malls', { name: 'M', city: 'T', address: 'A' });
    const other = await ins('malls', { name: 'N', city: 'T', address: 'A' });
    const store = (name, mallId, floor) => ins('stores', { name, city: 'T', address: 'A', lat: 41, lon: 69, organization_id: org, mall_id: mallId, mall_floor: floor });
    await store('A', mall, '1');
    await store('B', mall, '1');
    await store('C', mall, '-1');
    await store('D', mall, null);
    await store('E', other, '1');
    await store('F', null, '3'); // no mall: no floor row
    await m.migrate.up();
    assert.deepEqual((await m('mall_floors').orderBy(['mall_id', 'name']).select('mall_id', 'name', 'plan_url')).map((f) => [f.mall_id, f.name, f.plan_url]),
      [[mall, '-1', null], [mall, '1', null], [other, '1', null]]);
    assert.deepEqual(Object.keys(await m('stores').first()).filter((k) => k.startsWith('map_')), ['map_x', 'map_y']);
    await m('mall_spots').insert({ mall_id: mall, floor_id: (await m('mall_floors').first()).id, label: 'K', x: 1, y: 1 });
    await m.migrate.down();
    assert.ok(!(await m.schema.hasTable('mall_floors')) && !(await m.schema.hasTable('mall_spots')));
    assert.ok(!('map_x' in (await m('stores').first())));
    assert.equal((await m('stores')).length, 6, 'stores kept');
    await m.migrate.latest();
  } finally {
    await m.destroy();
  }
  // Super moves a store out of the mall: its floor, unit and pin go.
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  const superToken = await login('boss@smartfit.uz', 'boss-pass-1');
  assert.equal((await admin('PATCH', `/malls/${mallA}`, { store_ids: [s1] }, superToken)).status, 200);
  assert.deepEqual(await db('stores').where({ id: s2 }).first('mall_id', 'mall_floor', 'map_x', 'map_y'), { mall_id: null, mall_floor: null, map_x: null, map_y: null });
  assert.ok(await db('mall_floors').where({ id: floor2 }).first(), 'floor 2 has a plan, so it stays for the mall admin');
  assert.equal((await admin('PATCH', `/malls/${mallA}`, { store_ids: [s1, s2] }, superToken)).status, 200);
  await admin('PATCH', `/mall/stores/${s2}`, { floor: '2', unit: '215', pin: { x: 73.33, y: 23.13 } }, mallTokenA);
  // Deleting an empty mall takes its floors, spots and plan files along.
  const [{ id: empty }] = await db('malls').insert({ name: 'Bo\'sh', city: 'T', address: 'A' }).returning('id');
  const [{ id: f }] = await db('mall_floors').insert({ mall_id: empty, name: '1', plan_url: '/uploads/malls/gone.png', plan_w: 1, plan_h: 1 }).returning('id');
  await db('mall_spots').insert({ mall_id: empty, floor_id: f, label: 'K', x: 1, y: 1 });
  assert.equal((await admin('DELETE', `/malls/${empty}`, undefined, superToken)).status, 204);
  assert.deepEqual([(await db('mall_floors').where({ mall_id: empty })).length, (await db('mall_spots').where({ mall_id: empty })).length], [0, 0]);
});

test('open / closed: from the first minute to the closing minute, across midnight, all day, and nothing without hours', () => {
  assert.equal(openAt('10:00', '22:00', at('09:59')), false);
  assert.equal(openAt('10:00', '22:00', at('10:00')), true, 'open at its first minute');
  assert.equal(openAt('10:00', '22:00', at('21:59')), true);
  assert.equal(openAt('10:00', '22:00', at('22:00')), false, 'closed from its closing minute');
  // Closing after midnight (22:00–02:00).
  assert.equal(openAt('22:00', '02:00', at('21:59')), false);
  assert.equal(openAt('22:00', '02:00', at('22:00')), true);
  assert.equal(openAt('22:00', '02:00', at('23:59')), true);
  assert.equal(openAt('22:00', '02:00', at('00:00')), true);
  assert.equal(openAt('22:00', '02:00', at('01:59')), true);
  assert.equal(openAt('22:00', '02:00', at('02:00')), false);
  assert.equal(openAt('22:00', '02:00', at('12:00')), false);
  assert.equal(openAt('09:00', '00:00', at('23:59')), true, 'closing at midnight');
  assert.equal(openAt('09:00', '00:00', at('00:00')), false);
  assert.equal(openAt('00:00', '00:00', at('03:00')), true, 'equal times: open all day');
  // No hours (or half of them): nothing, not "closed".
  for (const [o, c] of [[null, null], ['10:00', null], [null, '22:00'], ['', '']]) assert.equal(openAt(o, c, at('12:00')), null);
  // Tashkent time, whatever the device's zone: 05:00 UTC = 10:00 in Tashkent.
  assert.equal(openAt('10:00', '22:00', Date.parse('2026-11-16T05:00:00Z')), true);
  assert.equal(openAt('10:00', '22:00', Date.parse('2026-11-16T04:59:00Z')), false);
});

test('directory filters: floor and category together, one category name across shops, natural floor order', () => {
  const cat = (name, name_ru) => ({ id: name.length, name, name_ru, image_url: null });
  const shops = [
    { id: 1, floor: '1', categories: [cat('Ustki kiyim', 'Верхняя одежда'), cat('Poyabzal', 'Обувь')] },
    { id: 2, floor: '2', categories: [cat('ustki kiyim ', 'Верхняя одежда'), cat('Sumkalar', 'Сумки')] },
    { id: 3, floor: '10', categories: [cat('Poyabzal', 'Обувь')] },
    { id: 4, floor: null, categories: [] },
    { id: 5, floor: '-1', categories: [cat('Poyabzal', null)] },
  ];
  assert.deepEqual(floorsOf(shops), ['-1', '1', '2', '10']);
  assert.deepEqual(categoriesOf(shops, 'uz').map((c) => c.key), ['poyabzal', 'sumkalar', 'ustki kiyim'], 'one choice per name (case and spaces ignored)');
  assert.deepEqual(categoriesOf(shops, 'ru').map((c) => c.label), ['Верхняя одежда', 'Обувь', 'Poyabzal', 'Сумки'].sort((a, b) => a.localeCompare(b, 'ru')));
  const ids = (f, lang) => filterShops(shops, f, lang).map((s) => s.id);
  assert.deepEqual(ids({}), [1, 2, 3, 4, 5], 'no filter: every shop');
  assert.deepEqual(ids({ floor: '1' }), [1]);
  assert.deepEqual(ids({ category: 'ustki kiyim' }), [1, 2]);
  assert.deepEqual(ids({ category: 'poyabzal' }), [1, 3, 5]);
  assert.deepEqual(ids({ floor: '10', category: 'poyabzal' }), [3], 'both at once');
  assert.deepEqual(ids({ floor: '2', category: 'poyabzal' }), []);
  assert.deepEqual(ids({ category: 'обувь' }, 'ru'), [1, 3], 'by the shown language (a shop without a Russian name keeps its own)');
});

test('the mall order page links each pinned shop to the map; a hidden or unpinned shop gets no link', async () => {
  const product = async (store) => db('products as p').join('product_stock as k', 'k.product_id', 'p.id').where('p.store_id', store).where('k.quantity', '>', 0).where('p.audience', 'adult').first('p.id', 'k.size');
  const add = async (token, store) => {
    const p = await product(store);
    return (await call('POST', '/api/mall-cart/items', { token, mall_id: mallA, store_id: store, items: [{ product_id: p.id, size: p.size }] })).body;
  };
  let cart = await add(undefined, s1);
  cart = await add(cart.token, s2);
  const done = await call('POST', `/api/mall-cart/${cart.token}/checkout`, { name: 'Ali', phone: '+998901234567', shops: [{ store_id: s1 }, { store_id: s2 }] });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  const token = done.body.track.url.split('/').pop();
  const page = async () => Object.fromEntries((await call('GET', `/api/order-groups/${token}`)).body.orders.map((o) => [o.store.id, o.store.map]));
  assert.deepEqual(await page(), { [s1]: true, [s2]: true });
  await admin('PATCH', `/mall/stores/${s2}`, { hidden: true }, mallTokenA);
  await admin('PATCH', `/mall/stores/${s1}`, { pin: null }, mallTokenA);
  assert.deepEqual(await page(), { [s1]: false, [s2]: false });
  await admin('PATCH', `/mall/stores/${s2}`, { hidden: false }, mallTokenA);
  await admin('PATCH', `/mall/stores/${s1}`, { pin: { x: 57.78, y: 23.13 } }, mallTokenA);
  // The link opens the map view of the mall screen on that shop (group.js), and the mall screen reads ?pin= and #map.
  const group = await readFile('public/app/group.js', 'utf8');
  assert.match(group, /o\.store\.map \? el\('a', \{ className: 'map-link', href: `\/m\?mall=\$\{group\.mall\.id\}&pin=\$\{o\.store\.id\}#map` \}/);
});

test('mall screen code: pins are buttons placed by CSS custom properties (no inline style); "Siz shu yerdasiz" only on a kiosk', async () => {
  const mall = await readFile('public/app/mall.js', 'utf8');
  const adminJs = await readFile('public/admin/admin.js', 'utf8');
  for (const src of [mall, adminJs]) {
    assert.ok(!/setAttribute\(\s*'style'|\.style\.cssText|style=/.test(src), 'no inline style attribute');
    assert.match(src, /style\.setProperty\('--x', String\(p\.x\)\)/);
  }
  assert.match(mall, /function spotOf\(\) \{\n\s+if \(!kiosk\) return 0;/, 'a phone never shows the kiosk spot');
  assert.match(mall, /el\(props\.onclick \? 'button' : 'span', props/, 'shop pins are buttons; the kiosk spot is a label');
  assert.match(await readFile('public/shared/ui.css', 'utf8'), /\.pin \{\n\s+position: absolute; left: calc\(var\(--x\) \* 1%\); top: calc\(var\(--y\) \* 1%\)/);
});
