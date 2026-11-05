import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, entry, installLogging } from '../src/log.js';
import { createApp } from '../src/app.js';

const env = { ANTHROPIC_API_KEY: 'sk-ant-live-secret-123', TELEGRAM_BOT_TOKEN: '123:bot-secret', DATABASE_URL: 'postgres://u:pw@db/x' };

test('redact: secrets, data URLs, base64 runs and tokens never reach the log', () => {
  const photo = `data:image/jpeg;base64,${'A'.repeat(500)}`;
  const s = redact(`key sk-ant-live-secret-123 bot 123:bot-secret db postgres://u:pw@db/x photo ${photo} raw ${'Zm9v'.repeat(80)} cart /api/cart/${'ab'.repeat(16)}/items`, env);
  for (const bad of ['sk-ant', 'bot-secret', 'pw@db', 'data:image', 'Zm9vZm9v', 'abababab']) assert.ok(!s.includes(bad), bad);
  assert.match(s, /\[secret\].*\[secret\].*\[secret\].*\[data\].*\[base64\].*\/api\/cart\/\[token\]\/items/);
  assert.equal(redact('GET /api/health 200', env), 'GET /api/health 200');
});

test('entry: one JSON object; Errors keep the stack, objects keep their fields, all redacted', () => {
  const e = entry('error', ['boom:', new Error('sk-ant-live-secret-123 leaked')], env);
  assert.equal(e.level, 'error');
  assert.ok(!Number.isNaN(Date.parse(e.time)));
  assert.match(e.msg, /^boom: Error: \[secret\] leaked\n\s+at /);
  const r = entry('info', [{ msg: 'request', path: `/api/cart/${'f'.repeat(32)}`, status: 200 }], env);
  assert.deepEqual({ ...r, time: 0 }, { time: 0, level: 'info', msg: 'request', path: '/api/cart/[token]', status: 200 });
});

test('installLogging: JSON lines; errors go to the webhook, at most 10 a minute; restore puts console back', async () => {
  const lines = [];
  const posts = [];
  const before = console.error;
  const restore = installLogging({ webhook: 'https://hooks.example/x', env, write: (level, line) => lines.push([level, line]), post: async (url, init) => { posts.push([url, JSON.parse(init.body)]); return { ok: true }; } });
  try {
    console.log('hello', 1);
    console.warn('careful');
    for (let i = 0; i < 12; i++) console.error(new Error(`fail ${i} sk-ant-live-secret-123`));
  } finally {
    restore();
  }
  assert.equal(console.error, before);
  assert.deepEqual(lines.slice(0, 2).map(([l, line]) => [l, JSON.parse(line).msg]), [['info', 'hello 1'], ['warn', 'careful']]);
  assert.equal(lines.length, 14);
  assert.equal(posts.length, 10);
  assert.equal(posts[0][0], 'https://hooks.example/x');
  assert.match(posts[0][1].text, /^\[smart-fit\] Error: fail 0 \[secret\]/);
  assert.equal(posts[0][1].content, posts[0][1].text);
  assert.ok(!JSON.stringify(lines).includes('sk-ant'));
});

test('installLogging: no webhook → nothing posted; a failing webhook only warns', async () => {
  const lines = [];
  let posted = 0;
  let restore = installLogging({ webhook: '', write: (l, line) => lines.push(line), post: async () => { posted++; } });
  console.error('x');
  restore();
  assert.equal(posted, 0);
  restore = installLogging({ webhook: 'https://hooks.example/x', write: (l, line) => lines.push(line), post: async () => { throw new TypeError('offline'); } });
  console.error('y');
  restore();
  await new Promise((r) => setImmediate(r));
  assert.match(lines.at(-1), /error webhook failed: TypeError/);
});

test('request log: full path with tokens redacted, no query string, status and time', async () => {
  const lines = [];
  const restore = installLogging({ webhook: '', write: (level, line) => lines.push(JSON.parse(line)) });
  const server = createApp(null, { logRequests: true, weather: null, stylist: null, telegram: null }).listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    await fetch(`http://127.0.0.1:${server.address().port}/api/cart/${'c'.repeat(32)}/nope?phone=998901234567`);
  } finally {
    server.close();
    restore();
  }
  const req = lines.find((l) => l.msg === 'request');
  assert.equal(req.path, '/api/cart/[token]/nope');
  assert.equal(req.method, 'GET');
  assert.equal(typeof req.status, 'number');
  assert.ok(Number.isInteger(req.ms));
  assert.ok(!JSON.stringify(lines).includes('998901234567'));
});
