// Task 58: the whole outfit on the customer's photo with an outfit provider (Gemini). Fake provider and fake fetch only.
// Which items qualify (adult, this shop, in stock, outfit roles, real photo or a browser-drawn PNG of an SVG drawing),
// one picture counts once, FASHN stays one garment, the provider choice, and the Gemini adapter's request and answer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createGeminiTryon, pickTryon, GEMINI_TRYON_MODEL, OUTFIT_MAX } from '../src/tryon.js';
import { tryonOutfitItem } from '../public/app/flow.js';

const db = testDb();
const uploadDir = mkdtempSync(join(tmpdir(), 'smartfit-outfit-'));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 3)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 5)]);
const PNG_URL = 'data:image/png;base64,' + PNG.toString('base64');
const PHOTO = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2000, 9)]).toString('base64');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });

let seen = [];
const outfitFake = { name: 'Gemini', outfit: true, async tryOn(input) { seen.push(input); return JPEG; } };
const oneFake = { name: 'FASHN', async tryOn(input) { seen.push(input); return JPEG; } };

let servers = [], base, fashnBase, store, other, items, kid, otherItem;
const listen = async (app) => {
  const s = app.listen(0);
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${s.address().port}`;
};
const post = async (body, at = base) => {
  const res = await fetch(`${at}/api/tryon`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: store, photo: PHOTO, consent: true, ...body }) });
  return { status: res.status, body: (res.headers.get('content-type') ?? '').startsWith('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const used = async () => Number((await db('tryon_usage').where({ store_id: store, day: today() }).first())?.count ?? 0);
const inStock = (q) => q.whereExists(db('product_stock as s').whereRaw('s.product_id = p.id').whereRaw('s.quantity - s.reserved > 0'));
const first = (sid, category, audience = 'adult') => inStock(db('products as p').where({ 'p.store_id': sid, 'p.category': category, 'p.audience': audience })).orderBy('p.id').first('p.*');

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [store, other] = (await db('stores').orderBy('id').select('id')).map((s) => s.id);
  await db('stores').whereIn('id', [store, other]).update({ tryon_on: true, tryon_daily_limit: 100 });
  // An outfit: a top with a real photo, the rest still on their SVG drawings (the seed's).
  items = { top: await first(store, 'top'), bottom: await first(store, 'bottom'), shoes: await first(store, 'shoes'), outerwear: await first(store, 'outerwear') };
  kid = await first(store, 'top', 'child');
  otherItem = await first(other, 'bottom');
  mkdirSync(join(uploadDir, 'products'));
  items.top.image_url = `/uploads/products/${items.top.id}-0123456789abcdef.jpg`;
  writeFileSync(join(uploadDir, 'products', `${items.top.id}-0123456789abcdef.jpg`), JPEG);
  await db('products').where({ id: items.top.id }).update({ image_url: items.top.image_url });
  const opts = { uploadDir, weather: async () => ({ temperature: 10, apparent_temperature: 10, raining: false, wind_speed: 1, source: 'live' }), stylist: null, telegram: null, limits: { tryon: 0 } };
  base = await listen(createApp(db, { ...opts, tryon: outfitFake }));
  fashnBase = await listen(createApp(db, { ...opts, tryon: oneFake }));
});
after(async () => {
  for (const s of servers) s.close();
  await db.destroy();
  rmSync(uploadDir, { recursive: true, force: true });
});

test('which items an outfit try-on takes', () => {
  assert.equal(items.bottom.image_url.endsWith('.svg'), true, 'the seed is on drawings');
  for (const p of Object.values(items)) assert.ok(tryonOutfitItem(p), p.category);
  assert.equal(tryonOutfitItem(kid), false, "never a child's item");
  assert.equal(tryonOutfitItem({ ...items.top, image_url: 'https://elsewhere/x.jpg' }), false);
  assert.equal(tryonOutfitItem({ ...items.top, category: 'socks' }), false);
});

test('the store tells the app it dresses whole outfits', async () => {
  const s = await (await fetch(`${base}/api/stores/${store}`)).json();
  assert.deepEqual([s.tryon, s.tryon_outfit], ['Gemini', true]);
  const f = await (await fetch(`${fashnBase}/api/stores/${store}`)).json();
  assert.equal(f.tryon, 'FASHN');
  assert.ok(!('tryon_outfit' in f));
});

test('a whole outfit: real photos from our uploads, drawings as browser PNGs, one picture counted once', async () => {
  const before = await used();
  seen = [];
  const ids = [items.outerwear.id, items.top.id, items.bottom.id, items.shoes.id];
  const garments = Object.fromEntries([items.outerwear, items.bottom, items.shoes].map((p) => [p.id, PNG_URL]));
  const r = await post({ product_ids: ids, garments });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, JPEG);
  assert.equal(await used(), before + 1, 'one picture, one count');
  const { person, garments: sent } = seen[0];
  assert.equal(person, PHOTO);
  assert.deepEqual(sent.map((g) => g.category), ['outerwear', 'top', 'bottom', 'shoes'], 'in the order asked, with our roles');
  assert.equal(sent[1].image, 'data:image/jpeg;base64,' + JPEG.toString('base64'), 'the real photo is read from uploads');
  assert.equal(sent[0].image, PNG_URL);
  // A client image for a product with a real photo is ignored: the server reads its own file.
  seen = [];
  assert.equal((await post({ product_ids: [items.top.id], garments: { [items.top.id]: PNG_URL } })).status, 200);
  assert.equal(seen[0].garments[0].image, 'data:image/jpeg;base64,' + JPEG.toString('base64'));
  // product_id alone is an outfit of one.
  assert.equal((await post({ product_id: items.top.id })).status, 200);
  assert.equal(readdirSync(join(uploadDir, 'products')).length, 1, 'nothing written next to the one photo');
});

test('refused: a drawing without its PNG, a non-PNG, too big, a child or another shop, bad ids', async () => {
  const before = await used();
  const svgId = items.bottom.id;
  for (const garments of [undefined, {}, { [svgId]: 'data:image/jpeg;base64,' + JPEG.toString('base64') }, { [svgId]: 'data:image/png;base64,' + Buffer.from('<svg/>').toString('base64') },
    { [svgId]: 'data:image/png;base64,' + Buffer.concat([PNG, Buffer.alloc(240_000)]).toString('base64') }]) {
    assert.equal((await post({ product_ids: [svgId], garments })).status, 404, JSON.stringify(garments)?.slice(0, 60));
  }
  for (const product_ids of [[], [items.top.id, items.top.id], [items.top.id, kid.id], [items.top.id, otherItem.id], [items.top.id, 'x'], [0], Array.from({ length: OUTFIT_MAX + 1 }, (_, i) => i + 1), 'all']) {
    assert.equal((await post({ product_ids })).status, 404, JSON.stringify(product_ids));
  }
  assert.equal((await post({ product_ids: [items.top.id], garments: [PNG_URL] })).status, 400, 'garments is an object');
  assert.equal(await used(), before, 'nothing counted');
});

test('FASHN stays one garment: no product_ids or garments', async () => {
  assert.equal((await post({ product_ids: [items.top.id] }, fashnBase)).status, 400);
  assert.equal((await post({ product_id: items.top.id, garments: {} }, fashnBase)).status, 400);
  seen = [];
  assert.equal((await post({ product_id: items.top.id }, fashnBase)).status, 200);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['category', 'garment', 'person']);
  assert.equal(seen[0].category, 'tops');
});

test('pickTryon: Gemini only when asked for, FASHN as before', () => {
  assert.equal(pickTryon({}), null);
  assert.equal(pickTryon({ GEMINI_API_KEY: 'g' }), null, "the stylist's key alone never turns pictures on");
  assert.equal(pickTryon({ FASHN_API_KEY: 'f' }).name, 'FASHN');
  const g = pickTryon({ TRYON_PROVIDER: 'gemini', GEMINI_API_KEY: 'g', FASHN_API_KEY: 'f' });
  assert.deepEqual([g.name, g.outfit], ['Gemini', true]);
  assert.equal(pickTryon({ TRYON_PROVIDER: 'gemini' }), null);
  assert.equal(GEMINI_TRYON_MODEL, 'gemini-nano-banana-2.1');
});

test('Gemini adapter: Interactions request, key in a header, the picture from the answer', async () => {
  const calls = [];
  let reply;
  const fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: reply[0] < 300, status: reply[0], json: async () => reply[1] }; };
  const g = createGeminiTryon({ apiKey: 'test-key', model: 'm-test', fetch });
  const garments = [{ image: PNG_URL, category: 'top' }, { image: 'data:image/jpeg;base64,' + JPEG.toString('base64'), category: 'shoes' }];
  const out = JPEG.toString('base64');

  reply = [200, { output_image: { data: out } }];
  assert.deepEqual(await g.tryOn({ person: PHOTO, garments }), JPEG);
  const { url, init, body } = calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.ok(!url.includes('test-key'));
  assert.equal(init.headers['x-goog-api-key'], 'test-key');
  assert.equal(body.model, 'm-test');
  assert.equal(body.input[0].type, 'text');
  assert.match(body.input[0].text, /Image 2: top.*\nImage 3: shoes/s);
  assert.deepEqual(body.input.slice(1).map((x) => [x.type, x.mime_type]), [['image', 'image/jpeg'], ['image', 'image/png'], ['image', 'image/jpeg']]);
  assert.equal(body.input[1].data, PHOTO.slice(23), 'image 1 is the customer');
  assert.equal(body.response_format.type, 'image');

  reply = [200, { steps: [{ type: 'user_input', content: [{ type: 'image', data: PHOTO.slice(23) }] }, { type: 'model_output', content: [{ type: 'text', text: 'ok' }, { type: 'image', data: out }] }] }];
  assert.deepEqual(await g.tryOn({ person: PHOTO, garments }), JPEG, 'the model output, never an echoed input');

  for (const [r, msg] of [[[403, { error: { message: 'billing' } }], 'gemini http 403'], [[200, { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'no' }] }] }], 'gemini no image'],
    [[200, { steps: [{ type: 'user_input', content: [{ type: 'image', data: out }] }] }], 'gemini no image']]) {
    reply = r;
    await assert.rejects(g.tryOn({ person: PHOTO, garments }), { message: msg });
  }
  await assert.rejects(g.tryOn({ person: 'data:image/gif;base64,R0lG', garments }), { message: 'gemini bad input' });
  assert.equal(createGeminiTryon({ apiKey: '' }), null);
});
