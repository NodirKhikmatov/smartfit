import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';

const db = createDb({ databaseUrl: '', sqliteFile: ':memory:' });
let server, base;

before(async () => {
  await db.migrate.latest();
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await db.destroy();
});

test('GET /api/health checks the DB', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('unknown /api route returns JSON 404', async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error);
});

test('malformed JSON body returns 400 without a stack trace', async () => {
  const res = await fetch(`${base}/api/health`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.ok(!text.includes('at '), 'no stack trace');
});
