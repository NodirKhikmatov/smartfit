// Task 16: customer-app history routing, refresh restore, inline validation and what sessionStorage may hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, allowedScreen, saveRoute, loadRoute, clearRoute, routeData, toRequest, nextError, fieldError } from '../public/app/flow.js';

// A browser history in miniature: push/replace/back, and popstate with the entry's state.
function fakeWindow() {
  const win = new EventTarget();
  const entries = [null];
  let i = 0;
  const pop = () => win.dispatchEvent(Object.assign(new Event('popstate'), { state: entries[i] }));
  win.history = {
    get state() { return entries[i]; },
    pushState(state) { entries.splice(i + 1, Infinity, state); i += 1; },
    replaceState(state) { entries[i] = state; },
    back() { if (i > 0) { i -= 1; pop(); } },
    forward() { if (i < entries.length - 1) { i += 1; pop(); } },
  };
  return win;
}
const fakeStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), dump: () => [...m.values()].join('') };
};
const FORM = { gender: 'female', height: '168', weight: '60', shoes: '38', budget: '1500000' };

// The app in miniature: the same rules as app.js (form submit → camera → results replaces camera; render saves the route).
function app(win = fakeWindow(), storage = fakeStorage()) {
  const s = { win, storage, shown: [], form: { ...FORM }, request: null };
  const state = () => ({ formOk: !!s.request, sizesOk: !!s.request?.sizes.top, orderOk: false });
  s.router = createRouter(win, {
    render: (name) => {
      s.shown.push(name);
      s.screen = name;
      saveRoute({ screen: name, form: s.form, sizes: s.request?.sizes }, storage);
    },
    allowed: (name) => allowedScreen(name, state()),
  });
  return s;
}

test('routing: back from results goes to the form with the values kept; forward returns to the results', () => {
  const s = app();
  s.router.go('start', { replace: true });
  s.router.go('form');
  s.request = toRequest(s.form, 1).request;
  s.router.go('camera');
  Object.assign(s.request.sizes, { top: 'M', bottom: 'S' });
  s.router.go('results', { replace: true }); // the camera step is replaced, so back skips it
  s.win.history.back();
  assert.equal(s.screen, 'form');
  assert.deepEqual(loadRoute(s.storage).form, FORM, 'form values kept');
  s.win.history.forward();
  assert.equal(s.screen, 'results');
  s.win.history.back();
  s.win.history.back();
  assert.equal(s.screen, 'start');
});

test('routing: a history entry the app can no longer show falls back (after a kiosk reset, back never shows old results)', () => {
  const s = app();
  s.router.go('start', { replace: true });
  s.router.go('form');
  s.request = toRequest(s.form, 1).request;
  s.request.sizes.top = 'M';
  s.router.go('results');
  s.request = null; // reset
  s.router.go('start', { replace: true });
  s.win.history.back(); // entry 'form', allowed
  s.win.history.forward(); // entry 'start'
  s.win.history.back();
  assert.equal(s.screen, 'form');
  s.router.go('cart');
  s.win.history.back();
  assert.equal(s.screen, 'form');
  // a 'results' entry with no request in memory is shown as the form, and the entry is rewritten
  const t = app();
  t.win.history.replaceState({ screen: 'results', depth: 1 }, '');
  t.win.history.pushState({ screen: 'cart', depth: 2 }, '');
  t.win.history.back();
  assert.equal(t.screen, 'form');
  assert.equal(t.win.history.state.screen, 'form');
});

test('routing: the in-app back button steps back in history, and on the first entry goes to the parent screen', () => {
  const s = app();
  s.router.go('cart', { replace: true }); // e.g. a refresh restored the cart
  s.router.back('start');
  assert.equal(s.screen, 'start');
  assert.equal(s.win.history.state.depth, 0, 'replaced, so the app never leaves the page');
  s.router.go('form');
  s.router.back('start');
  assert.equal(s.screen, 'start');
});

test('refresh restores the screen and the form from sessionStorage', () => {
  const storage = fakeStorage();
  saveRoute({ screen: 'results', form: FORM, sizes: { top: 'L', bottom: 'M', shoes: '38' }, manual: true }, storage);
  const saved = loadRoute(storage);
  const r = toRequest(saved.form, 2);
  assert.ok(r, 'saved form is valid');
  assert.deepEqual(r.body, { gender: 'female', height: 168, weight: 60 });
  assert.deepEqual(r.request, { store_id: 2, gender: 'female', sizes: { top: null, bottom: null, shoes: '38' }, budget: 1500000 });
  assert.deepEqual(saved.sizes, { top: 'L', bottom: 'M', shoes: '38' });
  assert.equal(saved.manual, true);
  assert.equal(allowedScreen(saved.screen, { formOk: true, sizesOk: true }), 'results');
  // What can't be restored steps back to what can.
  assert.equal(allowedScreen('results', { formOk: true, sizesOk: false }), 'camera');
  assert.equal(allowedScreen('results', {}), 'form');
  assert.equal(allowedScreen('camera', {}), 'form');
  assert.equal(allowedScreen('done', {}), 'start', 'the order is not stored, so done → start');
  assert.equal(allowedScreen('cart', {}), 'cart');
  assert.equal(allowedScreen('admin', {}), 'start');
  clearRoute(storage);
  assert.equal(loadRoute(storage), null);
});

test('privacy: sessionStorage holds only the screen, form numbers and sizes, never a photo, name or phone', () => {
  const storage = fakeStorage();
  saveRoute({
    screen: 'cart', manual: true,
    form: { ...FORM, fullname: 'Dilnoza Karimova', phone: '+998901234567', address: 'Amir Temur 15', photo: 'data:image/jpeg;base64,AAAA' },
    sizes: { top: 'M', bottom: 'M', shoes: null, photo: 'data:image/jpeg;base64,AAAA' },
    photo: 'data:image/jpeg;base64,AAAA', name: 'Dilnoza', phone: '+998901234567', pose: { shoulder: 0.2, hip: 0.18 },
  }, storage);
  const raw = storage.dump();
  for (const bad of ['data:image', 'base64', 'Dilnoza', '998901234567', 'Amir', 'shoulder']) assert.ok(!raw.includes(bad), bad);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['form', 'item', 'manual', 'screen', 'sizes']);
  assert.deepEqual(Object.keys(JSON.parse(raw).form).sort(), ['budget', 'gender', 'height', 'shoes', 'weight']);
  // A tampered or broken entry is cleaned up, not trusted.
  storage.setItem('sfRoute', JSON.stringify({ screen: 'admin', form: { height: 'x'.repeat(500), phone: '+99890' }, sizes: { top: '<b>', bottom: 'M' } }));
  assert.deepEqual(loadRoute(storage), routeData({ screen: 'start', form: { height: 'x'.repeat(12) }, sizes: { bottom: 'M' } }));
  storage.setItem('sfRoute', '{not json');
  assert.equal(loadRoute(storage), null);
  assert.doesNotThrow(() => saveRoute({ screen: 'form' }, { setItem() { throw new Error('quota'); } }), 'storage errors are ignored');
});

test('task 25: item pages keep their product id in history and survive a refresh; a bad id falls back to the catalogue', () => {
  const win = fakeWindow();
  const shown = [];
  const router = createRouter(win, {
    render: (name, data) => shown.push([name, data.item ?? null]),
    allowed: (name, data) => allowedScreen(name, { itemOk: !!data?.item }),
  });
  router.go('catalog', { replace: true });
  router.go('item', { data: { item: 7 } });
  router.go('item', { data: { item: 9 } }); // a "goes well with" tile
  win.history.back();
  assert.deepEqual(shown.at(-1), ['item', 7], 'back shows the previous item, not the last one');
  win.history.back();
  assert.deepEqual(shown.at(-1), ['catalog', null]);
  win.history.forward();
  assert.deepEqual(shown.at(-1), ['item', 7]);
  assert.equal(allowedScreen('item', {}), 'catalog');
  assert.equal(routeData({ screen: 'item', item: 7 }).item, 7);
  for (const bad of [0, -1, 1.5, '7', null]) assert.equal(routeData({ screen: 'item', item: bad }).item, null);
});

test('inline validation: an error clears as soon as the field is fine (no stale error)', () => {
  // Submit with nothing chosen: gender and height are flagged.
  assert.equal(nextError('submit', 'gender', ''), 'kiosk.form.err_gender');
  assert.equal(nextError('submit', 'height', ''), 'kiosk.form.err_height');
  // Picking a gender clears its error at once; the other error stays until that field is fixed.
  assert.equal(nextError('input', 'gender', 'female', 'Jinsingizni tanlang'), '');
  assert.equal(nextError('input', 'height', '1', "Bo'yingizni…"), 'kiosk.form.err_height');
  assert.equal(nextError('input', 'height', '17', "Bo'yingizni…"), 'kiosk.form.err_height');
  assert.equal(nextError('input', 'height', '172', "Bo'yingizni…"), '');
  // Typing into a clean field never shows an error mid-word; leaving it does (blur), unless it is empty.
  assert.equal(nextError('input', 'height', '1', ''), undefined);
  assert.equal(nextError('blur', 'height', '1', ''), 'kiosk.form.err_height');
  assert.equal(nextError('blur', 'height', '', ''), undefined);
  assert.equal(nextError('blur', 'weight', '', ''), undefined);
  // Optional fields and the checkout fields.
  assert.equal(fieldError('weight', ''), '');
  assert.equal(fieldError('weight', '20'), 'kiosk.form.err_weight');
  assert.equal(fieldError('budget', '1 500 000'), '', 'spaces from the keypad or chips are fine');
  assert.equal(fieldError('budget', '1.5'), 'kiosk.form.err_budget');
  assert.equal(fieldError('phone', '+998 90 123 45 67'), '');
  assert.equal(fieldError('phone', '12345'), 'kiosk.checkout.err_phone');
  assert.equal(fieldError('fullname', ' A '), 'kiosk.checkout.err_name');
  assert.equal(fieldError('address', 'Chilonzor 5'), '');
  assert.equal(toRequest({ ...FORM, height: '99' }, 1), null);
  assert.equal(toRequest({ ...FORM, shoes: '99' }, 1).request.sizes.shoes, null, 'unknown shoe size is dropped');
});
