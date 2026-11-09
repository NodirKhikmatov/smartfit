import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, tableNames } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { estimateSize } from '../src/size/size.js';
import { poseRatios, MEDIAPIPE, MODEL as POSE_MODEL } from '../public/app/pose.js';
import { VENDOR, MODEL } from '../src/vendor.js';

// Ratios that the size chart reads as M for a 176 cm man (shoulder 40 cm, hip 33.7 cm).
const M_POSE = { shoulder: 0.227, hip: 0.145 };

test('no photo, no weight: size from height only, low confidence', () => {
  assert.deepEqual(estimateSize({ gender: 'male', height: 176 }), { sizes: { top: 'M', bottom: 'M' }, confidence: 'low', source: 'height', measurements: null });
  assert.deepEqual(estimateSize({ gender: 'female', height: 164 }).sizes, { top: 'M', bottom: 'M' });
  assert.equal(estimateSize({ gender: 'male', height: 160 }).sizes.top, 'XS');
  assert.equal(estimateSize({ gender: 'male', height: 192 }).sizes.top, 'XL');
  assert.deepEqual(estimateSize({ gender: 'male', height: 100 }).sizes, { top: 'XS', bottom: 'XS' }, 'clamped at XS');
  assert.deepEqual(estimateSize({ gender: 'male', height: 230 }).sizes, { top: 'XXL', bottom: 'XXL' }, 'clamped at XXL');
});

test('no-photo mode: height + weight, medium confidence', () => {
  const cases = [
    ['male', 176, 72, 'M'],
    ['male', 176, 60, 'S'],
    ['male', 176, 90, 'XL'],
    ['male', 176, 105, 'XXL'],
    ['male', 190, 80, 'L'], // tall: longer sleeves push the size up
    ['male', 165, 60, 'S'],
    ['female', 164, 58, 'M'],
    ['female', 160, 48, 'XS'],
    ['female', 164, 75, 'XL'],
  ];
  for (const [gender, height, weight, size] of cases) {
    const r = estimateSize({ gender, height, weight });
    assert.deepEqual(r.sizes, { top: size, bottom: size }, `${gender} ${height}/${weight}`);
    assert.equal(r.confidence, 'medium');
    assert.equal(r.source, 'weight');
  }
  assert.equal(estimateSize({ gender: 'male', height: 150, weight: 30 }).sizes.top, 'XS');
  assert.equal(estimateSize({ gender: 'male', height: 200, weight: 250 }).sizes.top, 'XXL');
});

test('photo: shoulder → top, hip → bottom, converted to cm with the height', () => {
  const r = estimateSize({ gender: 'male', height: 176, pose: M_POSE });
  assert.deepEqual(r.sizes, { top: 'M', bottom: 'M' });
  assert.equal(r.confidence, 'medium');
  assert.equal(r.source, 'photo');
  assert.deepEqual(r.measurements, { shoulder_cm: 40, hip_cm: 33.7 });

  // Same ratios on a taller body are more centimetres, so a bigger size.
  assert.deepEqual(estimateSize({ gender: 'male', height: 196, pose: M_POSE }).sizes, { top: 'XL', bottom: 'XL' });
  // Broad shoulders, narrow hips: top and bottom are sized separately.
  assert.deepEqual(estimateSize({ gender: 'male', height: 176, pose: { shoulder: 0.25, hip: 0.135 } }).sizes, { top: 'XL', bottom: 'S' });
});

test('photo + weight: blended, high confidence only when they agree within one size', () => {
  const agree = estimateSize({ gender: 'male', height: 176, weight: 72, pose: M_POSE });
  assert.deepEqual(agree.sizes, { top: 'M', bottom: 'M' });
  assert.equal(agree.confidence, 'high');
  assert.equal(agree.source, 'photo+weight');

  // Photo says M, weight says far above XXL: the 60/40 blend lands between, and confidence drops.
  const clash = estimateSize({ gender: 'male', height: 176, weight: 110, pose: M_POSE });
  assert.deepEqual(clash.sizes, { top: 'XL', bottom: 'XL' });
  assert.equal(clash.confidence, 'medium');
});

test('photo widths no adult body has are refused', () => {
  for (const pose of [{ shoulder: 0.05, hip: 0.145 }, { shoulder: 0.5, hip: 0.145 }, { shoulder: 0.227, hip: 0.05 }, { shoulder: 0.227, hip: 0.4 }]) {
    assert.deepEqual(estimateSize({ gender: 'male', height: 176, pose }), { error: 'implausible' }, JSON.stringify(pose));
  }
});

// 33 MediaPipe landmarks of a person standing in a 1000×1000 frame: eyes at y=100, heels at y=900.
function body({ shoulderPx = 186, hipPx = 116, eyeY = 100, heelY = 900, vis = 0.95 } = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: vis }));
  const set = (i, x, y) => Object.assign(lm[i], { x: x / 1000, y: y / 1000 });
  set(2, 480, eyeY); set(5, 520, eyeY);
  set(11, 500 - shoulderPx / 2, 250); set(12, 500 + shoulderPx / 2, 250);
  set(23, 500 - hipPx / 2, 500); set(24, 500 + hipPx / 2, 500);
  set(27, 460, heelY - 20); set(28, 540, heelY - 20);
  set(29, 460, heelY); set(30, 540, heelY);
  return lm;
}

test('poseRatios: widths divided by the eye-to-heel span; null when the full body is not visible', () => {
  assert.deepEqual(poseRatios(body(), 1000, 1000), { shoulder: 0.233, hip: 0.145 });
  // Scale-free: the same body twice as large in a bigger photo gives the same ratios.
  assert.deepEqual(poseRatios(body(), 2000, 2000), { shoulder: 0.233, hip: 0.145 });

  assert.equal(poseRatios(undefined, 1000, 1000), null, 'nobody in the photo');
  const noHeels = body();
  noHeels[29].visibility = 0.2;
  assert.equal(poseRatios(noHeels, 1000, 1000), null, 'feet cut off');
  const headOut = body();
  headOut[2].y = -0.05;
  assert.equal(poseRatios(headOut, 1000, 1000), null, 'head out of frame');
  assert.equal(poseRatios(body({ eyeY: 400, heelY: 600 }), 1000, 1000), null, 'too far away');
  assert.equal(poseRatios(body({ eyeY: 900, heelY: 100 }), 1000, 1000), null, 'upside down');
  const lunge = body();
  lunge[29].x = 0.3;
  lunge[30].x = 0.75;
  assert.equal(poseRatios(lunge, 1000, 1000), null, 'legs spread wide');
});

test('MediaPipe loads from the self-hosted, exact pinned version (task 21)', () => {
  assert.equal(MEDIAPIPE, VENDOR.mediapipe.path);
  assert.match(MEDIAPIPE, /^\/vendor\/tasks-vision@\d+\.\d+\.\d+$/);
  assert.equal(POSE_MODEL, MODEL.path);
});

// --- API and privacy
process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
const uploadDir = mkdtempSync(join(tmpdir(), 'smartfit-size-'));
const weather = { temperature: 12, apparent_temperature: 10, raining: false, wind_speed: 4, source: 'live' };
let server, base, storeId;

const post = async (path, body, raw) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

before(async () => {
  await db.migrate.latest();
  await seed(db);
  storeId = (await db('stores').orderBy('id').first('id')).id;
  server = createApp(db, { uploadDir, weather: async () => weather }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await db.destroy();
  rmSync(uploadDir, { recursive: true, force: true });
});

test('POST /api/size: photo, weight-only and height-only modes', async () => {
  let r = await post('/api/size', { gender: 'male', height: 176, weight: 72, pose: M_POSE });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { sizes: { top: 'M', bottom: 'M' }, confidence: 'high', source: 'photo+weight', measurements: { shoulder_cm: 40, hip_cm: 33.7 } });
  r = await post('/api/size', { gender: 'female', height: 164, weight: 58, pose: null });
  assert.deepEqual([r.status, r.body.sizes, r.body.source], [200, { top: 'M', bottom: 'M' }, 'weight']);
  r = await post('/api/size', { gender: 'male', height: 176, weight: null });
  assert.deepEqual([r.status, r.body.confidence], [200, 'low']);
});

test('POST /api/size validates every field', async () => {
  const ok = { gender: 'male', height: 176 };
  const bad = [
    {},
    { ...ok, gender: 'x' },
    { ...ok, height: 99 },
    { ...ok, height: 231 },
    { ...ok, height: 175.5 },
    { ...ok, height: '176' },
    { ...ok, weight: 29 },
    { ...ok, weight: 251 },
    { ...ok, pose: { shoulder: 0.2 } },
    { ...ok, pose: { shoulder: 0.2, hip: 0 } },
    { ...ok, pose: { shoulder: 0.2, hip: 1 } },
    { ...ok, pose: { shoulder: '0.2', hip: 0.1 } },
    { ...ok, pose: [0.2, 0.1] },
    { ...ok, pose: { shoulder: 0.2, hip: 0.1, extra: 1 } },
    { ...ok, store_id: 1 },
  ];
  for (const b of bad) assert.equal((await post('/api/size', b)).status, 400, JSON.stringify(b));
  assert.equal((await post('/api/size', null, '[1,2]')).status, 400);
  const r = await post('/api/size', { ...ok, pose: { shoulder: 0.05, hip: 0.145 } });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /qayta urinib/);
});

test('no image or base64 data reaches disk, the DB or the logs', async () => {
  const image = 'data:image/jpeg;base64,' + Buffer.alloc(10_000, 7).toString('base64');
  const b64 = image.slice(23);
  const logged = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const saved = methods.map((m) => console[m]);
  for (const m of methods) console[m] = (...a) => logged.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' '));
  try {
    // Whatever a modified client tries to send, the image is refused or ignored and never kept.
    assert.equal((await post('/api/size', { gender: 'male', height: 176, image })).status, 400);
    assert.equal((await post('/api/size', { gender: 'male', height: 176, pose: image })).status, 400);
    assert.equal((await post('/api/size', { gender: 'male', height: 176, pose: { shoulder: image, hip: b64 } })).status, 400);
    assert.equal((await post('/api/size', null, 'not json ' + image)).status, 400);
    const big = 'data:image/jpeg;base64,' + Buffer.alloc(200_000, 7).toString('base64');
    assert.equal((await post('/api/size', { gender: 'male', height: 176, image: big })).status, 413, 'over the 100 kb JSON limit');
    // /api/recommend logs a row; extra fields must not end up in it.
    const r = await post('/api/recommend', { store_id: storeId, gender: 'male', sizes: { top: 'L', bottom: 'L', top_image: image }, budget: null, image });
    assert.equal(r.status, 200);
    // The stylist photo (task 7) must be a JPEG data URL; anything else is refused. No key here, so it is just dropped.
    assert.equal((await post('/api/recommend', { store_id: storeId, gender: 'male', sizes: { top: 'L', bottom: 'L' }, photo: b64 })).status, 400);
    const jpeg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(10_000, 7)]).toString('base64');
    assert.equal((await post('/api/recommend', { store_id: storeId, gender: 'male', sizes: { top: 'L', bottom: 'L' }, photo: jpeg })).status, 200);
  } finally {
    methods.forEach((m, i) => (console[m] = saved[i]));
  }

  const leak = (s) => /data:image|base64|[A-Za-z0-9+/=]{200,}/.test(s);
  for (const line of logged) assert.ok(!leak(line), `log line: ${line.slice(0, 120)}`);
  const tables = await tableNames(db);
  for (const t of tables) {
    for (const row of await db(t)) for (const [col, v] of Object.entries(row)) assert.ok(!(typeof v === 'string' && leak(v)), `${t}.${col}`);
  }
  assert.ok((await db('recommendation_logs').count({ n: '*' }))[0].n >= 1, 'the recommend call was logged');
  assert.deepEqual(readdirSync(uploadDir), [], 'nothing written to the upload dir');

  // The browser encodes pixels in one place only: the small JPEG for the stylist (task 7). No uploads or other encoders.
  for (const f of ['app.js', 'pose.js', 'flow.js', 'keypad.js']) {
    // Task 8: the phone keeps only its cart token, under one key. Task 16: flow.js keeps the whitelisted route
    // (routeData, tested in test/flow.test.js) under one key.
    const src = readFileSync(new URL(`../public/app/${f}`, import.meta.url), 'utf8')
      .replace(/sessionStorage\.(getItem|removeItem)\(CART_KEY\)|sessionStorage\.setItem\(CART_KEY, t\)/g, '')
      .replace(/storage = globalThis\.sessionStorage/g, '');
    assert.ok(!/toBlob|FormData|readAsDataURL|getImageData|btoa\(|localStorage|sessionStorage|indexedDB/.test(src), f);
    assert.equal(src.match(/toDataURL/g)?.length ?? 0, f === 'app.js' ? 1 : 0, f);
  }
});
