import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { filterCandidates, buildOutfits } from '../src/recommend/engine.js';
import { createStylist, applyStylist, parsePhoto, SYSTEM_PROMPT, TIMEOUT_MS, DEFAULT_MODEL } from '../src/recommend/stylist.js';

// --- Pure: applyStylist
let nextId = 1;
const item = (category, unit_price, extra = {}) => ({ id: nextId++, category, price: unit_price, discount_price: null, unit_price, temp_min: -30, temp_max: 40, waterproof: false, ...extra });
const C = Object.fromEntries(['outerwear', 'top', 'bottom', 'shoes', 'accessory'].map((c, i) => [c, [0, 1, 2].map((k) => item(c, 100000 + i * 10000 + k * 1000))]));
const all = Object.values(C).flat();
const warm = { temperature: 25, raining: false };
const cold = { temperature: 5, raining: false };
const ids = (o) => o.items.map((p) => p.id);

test('product IDs that are not in CANDIDATES are dropped', () => {
  const answer = { outfits: [{ title: 'A', reason: 'r', product_ids: [9999, C.top[1].id, String(C.bottom[1].id), -1, C.shoes[1].id, 1.5] }] };
  const r = applyStylist(answer, all, warm);
  for (const id of ids(r.outfits[0])) assert.ok(all.some((p) => p.id === id), `${id} is a candidate`);
  assert.ok(!ids(r.outfits[0]).includes(9999));
  assert.equal(r.outfits[0].items.find((p) => p.category === 'top').id, C.top[1].id, "Claude's valid pick is kept");
  assert.equal(r.outfits[0].items.find((p) => p.category === 'bottom').id, C.bottom[0].id, 'the string ID was dropped and the rules filled bottom');
  assert.equal(applyStylist({ outfits: [{ title: 'x', reason: 'y', product_ids: [9999, 8888] }] }, all, warm), null, 'only foreign IDs → no valid outfit');
});

test('missing required categories are filled by the rules', () => {
  const r = applyStylist({ outfits: [{ title: 'Kuz', reason: 'Issiq.', product_ids: [C.top[2].id] }] }, all, cold);
  const o = r.outfits[0];
  assert.deepEqual(o.items.map((p) => p.category), ['outerwear', 'top', 'bottom', 'shoes'], 'outerwear required below 18 °C');
  const rules = buildOutfits(all, cold).outfits[0];
  assert.equal(o.items[0].id, rules.items[0].id, 'fill = the rules’ best item');
  assert.equal(o.items[1].id, C.top[2].id);
  assert.deepEqual(applyStylist({ outfits: [{ product_ids: [C.top[0].id] }] }, all, { temperature: 25, raining: true }).outfits[0].items[0].category, 'outerwear', 'rain needs outerwear too');
  const noShoes = all.filter((p) => p.category !== 'shoes');
  assert.equal(applyStylist({ outfits: [{ product_ids: [C.top[0].id, C.bottom[0].id] }] }, noShoes, warm), null, 'cannot be filled → no outfit');
});

test('prices and totals come from the DB rows, never from Claude', () => {
  const disc = item('top', 90000, { price: 120000, discount_price: 90000 });
  const answer = { outfits: [{ title: 'A', reason: 'r', product_ids: [disc.id, C.bottom[0].id, C.shoes[0].id], total: 1, price: 1, prices: [1, 1, 1] }] };
  const r = applyStylist(answer, [...all, disc], warm);
  const o = r.outfits[0];
  assert.equal(o.total, 90000 + C.bottom[0].unit_price + C.shoes[0].unit_price);
  assert.equal(o.items[0].unit_price, 90000, 'discount price used');
  assert.equal(o.items[0].price, 120000);
  assert.deepEqual(Object.keys(o).sort(), ['alternative', 'items', 'reason', 'title', 'total']);
});

test('no item twice, one per category, budget respected, text trimmed', () => {
  const answer = {
    style_guess: '  kundalik '.padEnd(200, 'x'),
    outfits: [
      { title: 'A', reason: 'r', product_ids: [C.top[0].id, C.top[1].id, C.bottom[0].id, C.shoes[0].id] },
      { title: 'B', reason: 'r', product_ids: [C.top[0].id, C.bottom[1].id, C.shoes[1].id] },
      { title: 'C', reason: 'r', product_ids: [C.top[2].id] },
      { title: 'D', reason: 'r', product_ids: [C.top[2].id] },
    ],
  };
  const r = applyStylist(answer, all, warm);
  assert.equal(r.outfits.length, 3, 'at most 3');
  const seen = r.outfits.flatMap(ids);
  assert.equal(new Set(seen).size, seen.length, 'no repeats across outfits');
  assert.equal(r.outfits[0].items.filter((p) => p.category === 'top').length, 1);
  assert.equal(r.outfits[1].items.find((p) => p.category === 'top').id, C.top[1].id, 'a used top is replaced by the rules');
  assert.equal(r.style_guess.length, 40);
  for (const o of r.outfits) if (o.alternative) assert.ok(o.alternative.items.every((p) => !seen.includes(p.id) || ids(o).includes(p.id)));

  const cheap = C.top[0].unit_price + C.bottom[0].unit_price + C.shoes[0].unit_price;
  const b = applyStylist({ outfits: [{ product_ids: [C.top[2].id, C.bottom[2].id, C.shoes[2].id] }, { product_ids: [C.top[0].id] }] }, all, { ...warm, budget: cheap });
  assert.deepEqual(b.outfits.map((o) => o.total), [cheap], 'over-budget outfit dropped, filled one fits');
  assert.equal(applyStylist({ outfits: [{ product_ids: [C.top[2].id, C.bottom[2].id, C.shoes[2].id] }] }, all, { ...warm, budget: cheap }), null);
  for (const bad of [null, {}, { outfits: 'x' }, { outfits: [] }, { outfits: [null, { product_ids: 'x' }] }]) assert.equal(applyStylist(bad, all, warm), null);
});

test('photo: JPEG data URL only, capped', () => {
  const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
  assert.equal(parsePhoto(jpeg), jpeg.slice(23));
  assert.equal(parsePhoto(undefined), null);
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  for (const bad of [png, 'data:image/jpeg;base64,' + Buffer.from('<svg>').toString('base64'), jpeg.slice(23), 'data:image/jpeg;base64,/9j/@@', 42, { a: 1 }, 'data:image/jpeg;base64,/9j/' + 'A'.repeat(300_000)])
    assert.throws(() => parsePhoto(bad), { status: 400 });
});

test('no key → no stylist; defaults', () => {
  assert.equal(createStylist({ apiKey: '' }), null);
  assert.equal(createStylist({ apiKey: undefined }), null);
  assert.equal(TIMEOUT_MS, 8000);
  assert.equal(DEFAULT_MODEL, 'claude-haiku-5-5');
});

// --- API with a fake Anthropic client (never the real API)
const db = createDb({ databaseUrl: '', sqliteFile: ':memory:' });
const weather = { temperature: 5, apparent_temperature: 2, raining: false, wind_speed: 3, source: 'live' };
const calls = [];
let behave; // (params, opts) => response promise
const fake = { messages: { create: (params, opts) => (calls.push({ params, opts }), behave(params, opts)) } };
const toolAnswer = (input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'submit_outfits', input }] });
const candidatesOf = (params) => JSON.parse(params.messages[0].content.at(-1).text.split('\n')[1]).CANDIDATES;
let server, base, storeId;
const BODY = { gender: 'male', sizes: { top: 'L', bottom: 'L', shoes: '42' } };
const PHOTO = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20_000, 9)]).toString('base64');

const recommend = async (extra = {}, raw) => {
  const res = await fetch(`${base}/api/recommend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify({ store_id: storeId, ...BODY, ...extra }) });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  await db.migrate.latest();
  await seed(db);
  storeId = (await db('stores').orderBy('id').first('id')).id;
  server = createApp(db, { weather: async () => weather, stylist: createStylist({ client: fake }), stylistTimeoutMs: 100 }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await db.destroy();
});

const rulesBody = async () => {
  const candidates = await filterCandidates(db, { storeId, gender: 'male', sizes: BODY.sizes, temperature: weather.temperature });
  return { candidates, ...buildOutfits(candidates, { temperature: 5, raining: false, budget: null }) };
};

test('API: Claude picks from CANDIDATES, server fills, prices and logs', async () => {
  const { candidates, outfits: rules } = await rulesBody();
  assert.ok(rules.length >= 1, 'seed gives a rule outfit for L/L/42 at 5 °C');
  behave = async (params) => {
    const c = candidatesOf(params);
    const top = c.find((p) => p.category === 'top');
    return toolAnswer({ style_guess: 'kundalik', outfits: [{ title: 'Shahar', reason: "Issiq va qulay.", product_ids: [top.product_id, 999999] }] });
  };
  calls.length = 0;
  const r = await recommend({ photo: PHOTO });
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'ai');
  assert.equal(r.body.style_guess, 'kundalik');
  const o = r.body.outfits[0];
  assert.equal(o.title, 'Shahar');
  assert.deepEqual(o.items.map((p) => p.category).slice(0, 4), ['outerwear', 'top', 'bottom', 'shoes']);
  for (const p of o.items) {
    const db = candidates.find((x) => x.id === p.id);
    assert.ok(db, `${p.id} is a candidate`);
    assert.equal(p.unit_price, db.unit_price);
  }
  assert.equal(o.total, o.items.reduce((s, p) => s + p.unit_price, 0));

  const { params, opts } = calls[0];
  assert.equal(params.system, SYSTEM_PROMPT);
  assert.deepEqual(params.tool_choice, { type: 'tool', name: 'submit_outfits' });
  assert.equal(params.tools[0].name, 'submit_outfits');
  assert.deepEqual(params.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PHOTO.slice(23) } });
  assert.deepEqual(new Set(candidatesOf(params).map((p) => p.product_id)), new Set(candidates.map((p) => p.id)), 'CANDIDATES = task 4 filter');
  assert.equal(opts.maxRetries, 0);
  assert.ok(opts.signal instanceof AbortSignal);

  const log = await db('recommendation_logs').orderBy('id', 'desc').first();
  assert.equal(log.source, 'ai');
  assert.deepEqual(JSON.parse(log.product_ids), [...new Set(r.body.outfits.flatMap((x) => x.items.map((p) => p.id)))]);
});

test('API: no valid outfit, an error, a refusal or a timeout → the rule-based result', async () => {
  const { outfits: rules } = await rulesBody();
  const cases = {
    'foreign IDs only': async () => toolAnswer({ outfits: [{ title: 'x', reason: 'y', product_ids: [999999] }] }),
    'no tool call': async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }),
    refusal: async () => ({ stop_reason: 'refusal', content: [] }),
    error: async () => { throw Object.assign(new Error('boom'), { status: 529 }); },
    timeout: (params, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    'ignores the abort signal': () => new Promise(() => {}),
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const [name, fn] of Object.entries(cases)) {
      behave = fn;
      const t = Date.now();
      const r = await recommend();
      assert.equal(r.status, 200, name);
      assert.equal(r.body.source, 'rules', name);
      assert.deepEqual(r.body.outfits.map((o) => o.items.map((p) => p.id)), rules.map((o) => o.items.map((p) => p.id)), name);
      assert.ok(Date.now() - t < 2000, `${name}: deadline holds`);
    }
  } finally {
    console.warn = warn;
  }
  assert.equal((await db('recommendation_logs').orderBy('id', 'desc').first()).source, 'rules');
});

test('API: photo is validated, never stored or logged, and only sent to Claude', async () => {
  assert.equal((await recommend({ photo: 'data:image/png;base64,iVBORw0KGgo=' })).status, 400);
  assert.equal((await recommend({ photo: 'data:image/jpeg;base64,/9j/' + 'A'.repeat(500_000) })).status, 413);
  const logged = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const saved = methods.map((m) => console[m]);
  for (const m of methods) console[m] = (...a) => logged.push(a.map(String).join(' '));
  try {
    behave = async () => { throw Object.assign(new Error('bad request ' + PHOTO), { status: 400 }); };
    assert.equal((await recommend({ photo: PHOTO })).body.source, 'rules');
    behave = async () => toolAnswer({ outfits: [{ title: PHOTO, reason: PHOTO, product_ids: [] }] });
    assert.equal((await recommend({ photo: PHOTO })).status, 200);
  } finally {
    methods.forEach((m, i) => (console[m] = saved[i]));
  }
  const leak = (s) => /data:image|base64|[A-Za-z0-9+/=]{200,}/.test(s);
  assert.ok(logged.length >= 1);
  for (const line of logged) assert.ok(!leak(line), line.slice(0, 120));
  for (const t of (await db.raw("select name from sqlite_master where type = 'table'")).map((x) => x.name))
    for (const row of await db(t)) for (const [col, v] of Object.entries(row)) assert.ok(!(typeof v === 'string' && leak(v)), `${t}.${col}`);
});

test('API: at most 30 paid Claude calls per IP per minute, then rules', async () => {
  behave = async (params) => toolAnswer({ outfits: [{ title: 'A', reason: 'r', product_ids: [candidatesOf(params)[0].product_id] }] });
  calls.length = 0;
  let last;
  for (let i = 0; i < 31; i++) last = await recommend();
  assert.ok(calls.length <= 30, `${calls.length} calls`);
  assert.equal(last.body.source, 'rules');
});
