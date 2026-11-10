// Task 29: size from a partial photo (full / torso / upper), the usual-size and tape ways, the fit preference, the
// size method log without personal data, and accuracy per method.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createAdmin } from '../src/admin/routes.js';
import { estimateSize, METHODS, FIT_PREFS } from '../src/size/size.js';
import { filterCandidates } from '../src/recommend/engine.js';
import { bodyNumbers } from '../src/profile.js';
import { poseRatios, poseParts, framingHint } from '../public/app/pose.js';
import { METHODS as APP_METHODS, FITS as APP_FITS, routeData } from '../public/app/flow.js';

// 33 MediaPipe landmarks of a person standing upright, with the proportions pose.js assumes (eye 0.91, shoulder 0.80,
// hip joint 0.50 of stature above the heel), so every segment stands for the same eye-to-heel span.
// span: eye-to-heel in px; shoulder/hip: widths as a share of that span; a 1000×1000 frame.
function body({ eyeY = 100, span = 800, shoulder = 0.23, hip = 0.145, vis = 0.95, eyesVis = vis } = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: vis }));
  const set = (i, x, y) => Object.assign(lm[i], { x: x / 1000, y: y / 1000 });
  const at = (share) => eyeY + span * ((0.91 - share) / 0.91); // y of a point `share` of stature above the heel
  set(2, 480, eyeY); set(5, 520, eyeY);
  lm[2].visibility = lm[5].visibility = eyesVis;
  const sw = (shoulder * span) / 2, hw = (hip * span) / 2;
  set(11, 500 - sw, at(0.8)); set(12, 500 + sw, at(0.8));
  set(23, 500 - hw, at(0.5)); set(24, 500 + hw, at(0.5));
  set(27, 470, at(0.04)); set(28, 530, at(0.04));
  set(29, 470, at(0)); set(30, 530, at(0));
  return lm;
}
const FULL = { kind: 'full', shoulder: 0.23, hip: 0.145 };

test('poseRatios: each kind from its segment gives the full-body ratios', () => {
  assert.deepEqual(poseRatios(body(), 1000, 1000), FULL);
  assert.deepEqual(poseRatios(body({ eyesVis: 0.1 }), 1000, 1000), FULL, 'face hidden (mirror selfie): shoulder → heel');
  // Knee-up: the body runs off the bottom of the frame, the hips are in it.
  assert.deepEqual(poseRatios(body({ span: 1400 }), 1000, 1000), { ...FULL, kind: 'torso' }, 'legs cut: eye → hip');
  assert.deepEqual(poseRatios(body({ span: 1400, eyesVis: 0.1 }), 1000, 1000), { ...FULL, kind: 'torso' }, 'legs cut, face hidden: shoulder → hip');
  // Waist-up: the hips are only guessed just below the frame; the scale comes from them, the hip width does not.
  const waistUp = body({ span: 2200 });
  assert.ok(waistUp[23].y > 1 && waistUp[23].y < 1.5);
  assert.deepEqual(poseRatios(waistUp, 1000, 1000), { kind: 'upper', shoulder: 0.23 }, 'hips cut');
  assert.deepEqual(poseRatios(body({ span: 2200, eyesVis: 0.1 }), 1000, 1000), { kind: 'upper', shoulder: 0.23 }, 'hips cut, face hidden');
  // Scale-free: the same framing in a bigger photo.
  assert.deepEqual(poseRatios(body({ span: 1400 }), 2000, 2000), { ...FULL, kind: 'torso' });
});

test('poseRatios refuses lying, tipped over, wide stance, too far and nothing usable', () => {
  const turn = (lm) => lm.map((p) => ({ ...p, x: p.y, y: p.x })); // lying on the side
  assert.equal(poseRatios(turn(body()), 1000, 1000), null, 'lying, whole body');
  assert.equal(poseRatios(turn(body({ span: 1400 })), 1000, 1000), null, 'lying, legs out of frame');
  const tipped = body({ span: 1400 });
  for (const i of [23, 24]) tipped[i].x += 0.4; // hips far to the side of the eyes
  assert.equal(poseRatios(tipped, 1000, 1000), null, 'torso tipped over');
  const lunge = body();
  lunge[29].x = 0.2;
  lunge[30].x = 0.8;
  assert.equal(poseRatios(lunge, 1000, 1000), null, 'legs spread wide');
  assert.equal(poseRatios(body({ eyeY: 450, span: 100 }), 1000, 1000), null, 'too far away');
  const noShoulders = body();
  noShoulders[11].visibility = 0.2;
  assert.equal(poseRatios(noShoulders, 1000, 1000), null, 'no shoulders');
  assert.equal(poseRatios(body({ span: 4000 }), 1000, 1000), null, 'only a face: the hips guess is far below the frame');
  assert.equal(poseRatios(body({ eyeY: 900, span: -800 }), 1000, 1000), null, 'upside down');
  assert.equal(poseRatios([], 1000, 1000), null, 'no landmarks');
});

test('live framing hint: the parts seen and what to say', () => {
  assert.deepEqual(poseParts(body()), { eyes: true, shoulders: true, hips: true, feet: true });
  assert.deepEqual(poseParts(body({ span: 1400 })), { eyes: true, shoulders: true, hips: true, feet: false });
  assert.deepEqual(poseParts(undefined), { eyes: false, shoulders: false, hips: false, feet: false });
  assert.equal(framingHint(poseParts(body())), 'kiosk.camera.hint_ok');
  assert.equal(framingHint(poseParts(body({ eyesVis: 0.1 }))), 'kiosk.camera.hint_ok', 'a hidden face is fine');
  assert.equal(framingHint(poseParts(body({ span: 1400 }))), 'kiosk.camera.hint_feet');
  assert.equal(framingHint(poseParts(body({ span: 2200 }))), 'kiosk.camera.hint_hips');
  assert.equal(framingHint(poseParts(undefined)), 'kiosk.camera.hint_none');
});

// Ratios the chart reads as M for a 176 cm man (as in size.test.js).
const M = { shoulder: 0.227, hip: 0.145 };
const man = { gender: 'male', height: 176 };

test('size per kind: what is measured, the rest from height+weight, confidence full > torso > upper', () => {
  const full = estimateSize({ ...man, weight: 72, pose: { kind: 'full', ...M } });
  const torso = estimateSize({ ...man, weight: 72, pose: { kind: 'torso', ...M } });
  const upper = estimateSize({ ...man, weight: 72, pose: { kind: 'upper', shoulder: M.shoulder } });
  for (const r of [full, torso, upper]) assert.deepEqual(r.sizes, { top: 'M', bottom: 'M' });
  assert.deepEqual([full.confidence, torso.confidence, upper.confidence], ['high', 'medium', 'low']);
  assert.deepEqual([full.method, torso.method, upper.method], ['full', 'torso', 'upper']);
  assert.deepEqual(torso.measured, ['top', 'bottom']);
  assert.deepEqual(upper.measured, ['top']);
  assert.deepEqual(upper.measurements, { shoulder_cm: 40, hip_cm: null });
  // upper: the bottom is the height+weight size, whatever the shoulders say.
  const broad = estimateSize({ ...man, weight: 72, pose: { kind: 'upper', shoulder: 0.26 } });
  assert.equal(broad.sizes.bottom, estimateSize({ ...man, weight: 72 }).sizes.bottom);
  assert.equal(estimateSize({ ...man, pose: { kind: 'upper', shoulder: 0.26 } }).sizes.bottom, estimateSize(man).sizes.bottom, 'no weight: from the height');
  // A partial photo counts less against the weight: very broad shoulders move the top less.
  const pull = (kind) => estimateSize({ ...man, weight: 72, pose: { kind, shoulder: 0.29, ...(kind !== 'upper' && { hip: M.hip }) } }).sizes.top;
  assert.deepEqual([pull('full'), pull('upper')], ['XXL', 'XL']);
  // Without a weight every kind drops a level; never below low.
  assert.deepEqual(['full', 'torso', 'upper'].map((kind) => estimateSize({ ...man, pose: { kind, ...M, ...(kind === 'upper' && { hip: undefined }) } }).confidence), ['medium', 'low', 'low']);
  assert.deepEqual(estimateSize({ ...man, pose: { kind: 'upper', shoulder: 0.05 } }), { error: 'implausible' });
});

test('usual size and tape: blended with height+weight, clamped, with a confidence', () => {
  // Usual top + jeans waist that agree with the weight: high; one part only: at most medium.
  let r = estimateSize({ ...man, weight: 72, usual: { top: 'M', waist: 32 } });
  assert.deepEqual([r.sizes, r.confidence, r.method, r.measured], [{ top: 'M', bottom: 'M' }, 'high', 'usual', ['top', 'bottom']]);
  r = estimateSize({ ...man, weight: 72, usual: { top: 'L' } });
  assert.deepEqual([r.sizes, r.confidence, r.measured], [{ top: 'L', bottom: 'M' }, 'medium', ['top']]);
  r = estimateSize({ ...man, usual: { waist: 34 } });
  assert.deepEqual([r.sizes.bottom, r.confidence, r.measured], ['L', 'medium', ['bottom']]);
  assert.deepEqual(estimateSize({ ...man, usual: { top: 'XXL', waist: 40 } }).sizes, { top: 'XXL', bottom: 'XXL' }, 'clamped at XXL');
  assert.deepEqual(estimateSize({ ...man, usual: { top: 'XS', waist: 26 } }).sizes, { top: 'XS', bottom: 'XS' }, 'clamped at XS');
  assert.equal(estimateSize({ gender: 'female', height: 164, usual: { waist: 28 } }).sizes.bottom, 'M');
  // The usual size disagreeing with the weight by more than a size: the blend moves, the confidence drops.
  r = estimateSize({ ...man, weight: 110, usual: { top: 'S', waist: 30 } });
  assert.equal(r.confidence, 'medium');
  assert.equal(r.sizes.top, 'L');

  // Tape: chest → top, hip (and waist) → bottom.
  r = estimateSize({ ...man, weight: 72, tape: { chest: 98, waist: 84, hip: 100 } });
  assert.deepEqual([r.sizes, r.confidence, r.method, r.source, r.measurements], [{ top: 'M', bottom: 'M' }, 'high', 'tape', 'tape', null]);
  r = estimateSize({ ...man, tape: { chest: 110 } });
  assert.deepEqual([r.sizes, r.confidence, r.measured], [{ top: 'XL', bottom: 'M' }, 'medium', ['top']]);
  assert.deepEqual(estimateSize({ ...man, tape: { waist: 96 } }).sizes.bottom, 'XL');
  assert.deepEqual(estimateSize({ ...man, tape: { chest: 160, hip: 170 } }).sizes, { top: 'XXL', bottom: 'XXL' }, 'clamped');
  assert.deepEqual(estimateSize({ ...man, tape: { chest: 60, hip: 60 } }).sizes, { top: 'XS', bottom: 'XS' }, 'clamped');
  assert.deepEqual(estimateSize({ gender: 'female', height: 164, tape: { chest: 92, hip: 98 } }).sizes, { top: 'M', bottom: 'M' });
});

test('client and server agree on the method and fit lists', () => {
  assert.deepEqual(APP_METHODS, METHODS);
  assert.deepEqual(APP_FITS, Object.keys(FIT_PREFS));
  // Refresh keeps how the size was found and the fit preference, nothing else; tampered values are dropped.
  assert.deepEqual([routeData({ method: 'tape', fit: 'loose' }).method, routeData({ method: 'tape', fit: 'loose' }).fit], ['tape', 'loose']);
  assert.deepEqual([routeData({ method: 'x', fit: { chest: 98 } }).method, routeData({ method: 'x', fit: { chest: 98 } }).fit], [null, null]);
});

// --- API, fit preference, method log, accuracy per method
process.env.ADMIN_TOKEN_SECRET = 'test-secret';
const db = testDb();
let server, base, store, other, superToken, top;

const call = async (method, p, body, token) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const setStock = (productId, size, quantity) => db('product_stock').where({ product_id: productId, size }).update({ quantity, reserved: 0 });
const recommend = (extra = {}) => call('POST', '/api/recommend', { store_id: store, gender: 'male', sizes: { top: 'M', bottom: 'M' }, ...extra });

before(async () => {
  await db.migrate.latest();
  await seed(db);
  [store, other] = (await db('stores').orderBy('id')).map((s) => s.id);
  await createAdmin(db, { email: 'boss@smartfit.uz', password: 'boss-pass-1' });
  server = createApp(db, { telegram: null, stylist: null, limits: { size: 0, recommend: 0, cart: 0 }, weather: async () => ({ temperature: 15, raining: false, source: 'live' }) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  superToken = (await call('POST', '/api/admin/login', { email: 'boss@smartfit.uz', password: 'boss-pass-1' })).body.token;
  top = await db('products').where({ store_id: store, category: 'top' }).whereIn('gender', ['male', 'unisex'])
    .where('temp_min', '<=', 15).where('temp_max', '>=', 15).orderBy('id').first();
});
after(async () => {
  server.close();
  await db.destroy();
});

test('POST /api/size validates each way', async () => {
  const ok = { gender: 'male', height: 176, weight: 72 };
  const good = [
    { pose: { kind: 'full', ...M } }, { pose: { kind: 'torso', ...M } }, { pose: { kind: 'upper', shoulder: 0.227 } },
    { pose: M }, // a full-body client from before task 29
    { usual: { top: 'M' } }, { usual: { waist: 32 } }, { usual: { top: 'XS', waist: 26 } },
    { tape: { chest: 98 } }, { tape: { waist: 50, hip: 170 } }, { tape: { chest: 160, waist: 160, hip: 60 } },
  ];
  for (const b of good) assert.equal((await call('POST', '/api/size', { ...ok, ...b })).status, 200, JSON.stringify(b));
  const r = await call('POST', '/api/size', { ...ok, pose: { kind: 'upper', shoulder: 0.227 } });
  assert.deepEqual([r.body.method, r.body.measured, r.body.sizes], ['upper', ['top'], { top: 'M', bottom: 'M' }]);
  const bad = [
    { pose: { kind: 'upper', shoulder: 0.227, hip: 0.145 } }, // upper has no hip
    { pose: { kind: 'torso', shoulder: 0.227 } },
    { pose: { kind: 'legs', ...M } }, { pose: { kind: 1, ...M } }, { pose: { kind: 'upper' } }, { pose: { kind: 'upper', shoulder: 1 } },
    { usual: {} }, { usual: { top: 'XXXL' } }, { usual: { waist: 25 } }, { usual: { waist: 41 } }, { usual: { waist: 32.5 } },
    { usual: { waist: '32' } }, { usual: { top: 'M', photo: 'x' } }, { usual: 'M' }, { usual: ['M'] },
    { tape: {} }, { tape: { chest: 59 } }, { tape: { waist: 161 } }, { tape: { hip: 171 } }, { tape: { chest: '98' } }, { tape: { chest: 98.5 } },
    { tape: { chest: 98, neck: 40 } }, { tape: [98] },
    { pose: { kind: 'full', ...M }, usual: { top: 'M' } }, { usual: { top: 'M' }, tape: { chest: 98 } },
  ];
  // A key that exists on every object's prototype is still an unknown key (400, not a crash).
  for (const raw of ['{"gender":"male","height":176,"usual":{"__proto__":1}}', '{"gender":"male","height":176,"tape":{"constructor":98}}']) {
    const res = await fetch(base + '/api/size', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    assert.equal(res.status, 400, raw);
  }
  for (const b of bad) assert.equal((await call('POST', '/api/size', { ...ok, ...b })).status, 400, JSON.stringify(b));
  assert.equal((await call('POST', '/api/size', { ...ok, pose: { kind: 'upper', shoulder: 0.05 } })).status, 422);
});

test('fit preference: one size within the product\'s sizes, on top of the fit offset, only sizes in stock', async () => {
  for (const s of ['XS', 'S', 'M', 'L', 'XL', 'XXL']) await setStock(top.id, s, 3);
  const pick = async (sizes, fit) => (await filterCandidates(db, { storeId: store, gender: 'male', sizes, temperature: 15, fit })).find((p) => p.id === top.id);
  const M2 = { top: 'M', bottom: 'M' };
  assert.equal((await pick(M2, null)).size, 'M');
  assert.equal((await pick(M2, 'regular')).size, 'M');
  assert.equal((await pick(M2, 'loose')).size, 'L');
  assert.equal((await pick(M2, 'tight')).size, 'S');
  assert.equal((await pick({ top: 'XXL', bottom: 'M' }, 'loose')).size, 'XXL', 'clamped at the end');
  assert.equal((await pick({ top: 'XS', bottom: 'M' }, 'tight')).size, 'XS', 'clamped at the start');
  // Never a size with nothing free, and no fallback to the unpreferred one.
  await setStock(top.id, 'L', 0);
  assert.equal(await pick(M2, 'loose'), undefined);
  await setStock(top.id, 'L', 3);
  // The product's own offset (runs small: +1) comes on top; fit_from is the customer's preferred size.
  await db('products').where({ id: top.id }).update({ fit_offset: 1 });
  const p = await pick(M2, 'loose');
  assert.deepEqual([p.size, p.fit_from, p.fit_offset], ['XL', 'L', 1]);
  await db('products').where({ id: top.id }).update({ fit_offset: null });
  // Shoes don't move with the clothing preference.
  const shoes = (await filterCandidates(db, { storeId: store, gender: 'male', sizes: { ...M2, shoes: '42' }, temperature: 15, fit: 'loose' })).filter((x) => x.category === 'shoes');
  assert.ok(shoes.length && shoes.every((x) => x.size === '42'));
  // Through the API: the outfits use it, a bad value is refused.
  const r = await recommend({ fit: 'loose' });
  assert.equal(r.status, 200);
  assert.ok(r.body.outfits.flatMap((o) => o.items).filter((i) => ['top', 'bottom', 'outerwear'].includes(i.category)).every((i) => i.size === 'L'));
  assert.equal((await recommend({ fit: 'baggy' })).status, 400);
  assert.equal((await recommend({ fit: 1 })).status, 400);
  assert.equal((await recommend({ fit: ['loose'] })).status, 400, 'an array is not a fit');
});

test('size method log: the method only, no personal data; a bad method is refused', async () => {
  const r = await recommend({ method: 'upper', fit: 'tight', photo: undefined, tape: { chest: 123 }, height: 187, weight: 81 });
  assert.equal(r.status, 200);
  const row = await db('recommendation_logs').where({ token: r.body.rec }).first();
  assert.equal(row.size_method, 'upper');
  for (const [col, v] of Object.entries(row)) {
    assert.ok(!/height|weight|chest|waist|hip|photo|phone|name|shoulder/.test(col), col);
    assert.ok(!['123', '187', '81'].includes(String(v)), `${col} holds a body number`);
  }
  // A −/+ re-query keeps the same row and method; a request without one is logged as unknown.
  await recommend({ rec: r.body.rec, method: 'upper', sizes: { top: 'L', bottom: 'M' } });
  assert.equal((await db('recommendation_logs').where({ token: r.body.rec }).first()).size_method, 'upper');
  assert.equal((await db('recommendation_logs').where({ token: (await recommend()).body.rec }).first()).size_method, null);
  for (const method of ['photo', 'height', 1, { kind: 'full' }]) assert.equal((await recommend({ method })).status, 400, JSON.stringify(method));
});

test('profile keeps the no-photo numbers, never anything else', () => {
  assert.deepEqual(
    Object.fromEntries(['fit', 'jeans', 'chest', 'waist', 'hips'].map((k) => [k, bodyNumbers({ fit: 'loose', jeans: 32, chest: 98, waist: 84, hips: 100, photo: 'data:image/jpeg;base64,AAAA' })[k]])),
    { fit: 'loose', jeans: 32, chest: 98, waist: 84, hips: 100 });
  assert.equal(bodyNumbers({ fit: ['loose'] }).fit, null);
  const bad = bodyNumbers({ fit: 'baggy', jeans: 50, chest: 'data:image/png;base64,AAAA', waist: 10, hips: 999 });
  assert.deepEqual([bad.fit, bad.jeans, bad.chest, bad.waist, bad.hips], [null, null, null, null, null]);
  assert.ok(!('photo' in bodyNumbers({ photo: 'x' })));
});

async function order(rec, fit) {
  await setStock(top.id, 'M', 5);
  const cart = await call('POST', '/api/cart/items', { store_id: store, items: [{ product_id: top.id, size: 'M' }], rec });
  assert.equal(cart.status, 200);
  const r = await call('POST', `/api/cart/${cart.body.token}/checkout`, { fulfillment: 'pickup', name: 'Aziz', phone: '+998901234567' });
  assert.equal(r.status, 201);
  if (fit) await db('order_items').where({ order_id: r.body.order.id }).update({ fit });
  return r.body.order;
}

test('accuracy per method on the Talab page: customers per way and their "how did it fit?" answers, store-scoped', async () => {
  await db('orders').update({ recommendation_id: null });
  await db('carts').update({ recommendation_id: null });
  await db('recommendation_logs').del();
  const recs = {};
  for (const m of ['upper', 'upper', 'full', 'usual', 'tape']) (recs[m] ??= []).push((await recommend({ method: m })).body.rec);
  await recommend(); // no method: counted nowhere
  await order(recs.upper[0], 'small');
  await order(recs.upper[1], 'right');
  await order(recs.full[0], 'right');
  await order(recs.usual[0]); // bought, no answer yet

  const d = (await call('GET', '/api/admin/demand', undefined, superToken)).body;
  const by = Object.fromEntries(d.methods.map((m) => [m.method, m]));
  assert.deepEqual(d.methods.map((m) => m.method), METHODS, 'every method, zero-filled');
  assert.deepEqual(by.upper, { method: 'upper', customers: 2, small: 1, right: 1, big: 0, answers: 2, accuracy: 50 });
  assert.deepEqual(by.full, { method: 'full', customers: 1, small: 0, right: 1, big: 0, answers: 1, accuracy: 100 });
  assert.deepEqual([by.usual.customers, by.usual.answers, by.usual.accuracy], [1, 0, null]);
  assert.deepEqual([by.tape.customers, by.torso.customers], [1, 0]);
  // Another store's view sees none of it.
  const o = (await call('GET', `/api/admin/demand?store_id=${other}`, undefined, superToken)).body;
  assert.ok(o.methods.every((m) => m.customers === 0 && m.answers === 0));
});
