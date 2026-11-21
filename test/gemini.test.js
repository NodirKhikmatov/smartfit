// Task 56: the Gemini stylist (fake fetch only, never the real API) and the provider choice.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './helpers/db.js';
import { createApp } from '../src/app.js';
import { seed } from '../src/db/seed.js';
import { createGeminiStylist, pickStylist, SYSTEM_PROMPT, SINGLE_PROMPT, GEMINI_MODEL } from '../src/recommend/stylist.js';

test('pickStylist: AI_PROVIDER wins, else Claude, else Gemini, else none', () => {
  assert.equal(pickStylist({}), null);
  assert.equal(pickStylist({ GEMINI_API_KEY: 'g' }).provider, 'gemini');
  assert.equal(pickStylist({ ANTHROPIC_API_KEY: 'a' }).provider, 'claude');
  assert.equal(pickStylist({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' }).provider, 'claude');
  assert.equal(pickStylist({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', AI_PROVIDER: 'gemini' }).provider, 'gemini');
  assert.equal(pickStylist({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', AI_PROVIDER: 'claude' }).provider, 'claude');
  assert.equal(pickStylist({ ANTHROPIC_API_KEY: 'a', AI_PROVIDER: 'gemini' }), null, 'chosen provider without its key → rules');
  assert.equal(createGeminiStylist({ apiKey: '' }), null);
  assert.equal(GEMINI_MODEL, 'gemini-3.5-flash-lite');
});

const calls = [];
let reply; // (body) => { status, json }
const fakeFetch = async (url, init) => {
  calls.push({ url, init, body: JSON.parse(init.body) });
  const r = await reply(JSON.parse(init.body));
  return { ok: r.status === 200, status: r.status, json: async () => r.json };
};
const callAnswer = (name, args) => ({ status: 200, json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking…' }, { functionCall: { id: 'x', name, args } }] } }] } });
const candidatesOf = (body) => JSON.parse(body.contents[0].parts.at(-1).text.split('\n')[1]).CANDIDATES;

const db = testDb();
const weather = { temperature: 5, apparent_temperature: 2, raining: false, wind_speed: 3, source: 'live' };
const BODY = { gender: 'male', sizes: { top: 'L', bottom: 'L', shoes: '42' } };
const PHOTO = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 9)]).toString('base64');
let server, base, storeId;
const recommend = async (extra = {}) => {
  const res = await fetch(`${base}/api/recommend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ store_id: storeId, ...BODY, ...extra }) });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  await db.migrate.latest();
  await seed(db);
  storeId = (await db('stores').orderBy('id').first('id')).id;
  const stylist = createGeminiStylist({ apiKey: 'test-key', model: 'gemini-test', fetchFn: fakeFetch });
  server = createApp(db, { weather: async () => weather, stylist, stylistTimeoutMs: 200 }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await db.destroy();
});

test('Gemini: request shape, key in a header, answer checked like Claude\'s', async () => {
  reply = (body) => {
    const top = candidatesOf(body).find((p) => p.category === 'top');
    return callAnswer('submit_outfits', { style_guess: 'kundalik', outfits: [{ title: 'Shahar', reason: 'Issiq.', product_ids: [top.product_id, 999999] }] });
  };
  calls.length = 0;
  const r = await recommend({ photo: PHOTO });
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'ai');
  assert.equal(r.body.outfits[0].title, 'Shahar');
  assert.ok(!r.body.outfits.flatMap((o) => o.items).some((p) => p.id === 999999), 'an ID not in CANDIDATES is dropped');
  assert.deepEqual(r.body.outfits[0].items.map((p) => p.category).slice(0, 4), ['outerwear', 'top', 'bottom', 'shoes'], 'missing categories filled by the rules');

  const { url, init, body } = calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  assert.ok(!url.includes('test-key'), 'the key never goes in the URL');
  assert.equal(init.headers['x-goog-api-key'], 'test-key');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(body.systemInstruction.parts[0].text, SYSTEM_PROMPT);
  assert.deepEqual(body.contents[0].parts[0], { inlineData: { mimeType: 'image/jpeg', data: PHOTO.slice(23) } });
  assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['submit_outfits'] } });
  assert.equal(body.tools[0].functionDeclarations[0].name, 'submit_outfits');
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
});

test('Gemini: no photo → no image part; single items use the ranking prompt', async () => {
  reply = () => ({ status: 200, json: { candidates: [] } });
  calls.length = 0;
  await recommend();
  assert.equal(calls[0].body.contents[0].parts.length, 1);
  assert.ok(calls[0].body.contents[0].parts[0].text.startsWith("Mijoz rasmi yo'q"));

  const ask = createGeminiStylist({ apiKey: 'k', fetchFn: fakeFetch });
  reply = () => callAnswer('submit_ranking', { product_ids: [3, 1] });
  calls.length = 0;
  const out = await ask({ weather, sizes: {}, budget: null, candidates: [], mode: 'single', want: ['top'] });
  assert.deepEqual(out, { product_ids: [3, 1] });
  assert.equal(calls[0].body.systemInstruction.parts[0].text, SINGLE_PROMPT);
});

test('Gemini: error status, blocked prompt, no call, timeout → rules', async () => {
  for (const r of [
    { status: 429, json: { error: { message: 'quota' } } },
    { status: 200, json: { promptFeedback: { blockReason: 'SAFETY' } } },
    { status: 200, json: { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] } },
    { status: 200, json: { candidates: [{ content: { parts: [{ text: 'no tool call' }] } }] } },
  ]) {
    reply = () => r;
    const res = await recommend();
    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'rules');
    assert.ok(res.body.outfits.length > 0);
  }
  reply = () => new Promise(() => {}); // never answers: the 200 ms deadline in this test app aborts it
  const slow = await recommend();
  assert.equal(slow.body.source, 'rules');
});
