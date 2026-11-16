// Task 41: AI try-on, the customer's photo + the garment's photo → a picture of them wearing it, made by an outside
// image provider (FASHN, https://docs.fashn.ai). The one place a customer photo goes to a third party other than Claude:
// it passes through this process in memory only (never disk, DB or logs), the picture is streamed back and not kept,
// and the provider's job id lives in one local variable for the length of the request. Off without FASHN_API_KEY.
import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fail, imageExt, errorBody, langOf } from './admin/routes.js';
import { withDeadline, parsePhoto } from './recommend/stylist.js';
import { visible } from './recommend/engine.js';
import { inStock } from './catalog.js';
import { tryonGarment, TRYON_ROLES } from '../public/app/flow.js';
import { allows } from './plans.js';

export const TRYON_TIMEOUT_MS = 45_000; // FASHN "balanced" takes ~8 s; queueing gets the rest
export const TRYON_PHOTO_MAX = 1_500_000; // base64 chars (~1.1 MB JPEG); the app sends ≤ 1280 px, usually 150–400 KB
export const TRYON_PARALLEL = 4; // pictures in flight per process; FASHN's default account concurrency is 6
const FASHN = 'https://api.fashn.ai/v1';
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const tashDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' }); // YYYY-MM-DD

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('aborted'));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});

// The provider interface: { name, tryOn({ person, garment, category }, signal) → Buffer }, where person and garment are
// image data URLs, category is 'tops' | 'bottoms', and the Buffer is a JPEG/PNG/WebP picture. Another provider replaces
// this function only. FASHN is asynchronous: POST /run → id, then GET /status/<id> until completed or failed.
export function createFashn({ apiKey = process.env.FASHN_API_KEY?.trim(), fetch = globalThis.fetch, pollMs = 1500 } = {}) {
  if (!apiKey) return null;
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const call = async (url, init, signal) => {
    const r = await fetch(url, { ...init, headers, signal });
    if (!r.ok) throw new Error(`fashn http ${r.status}`); // the body is never read into a log
    return r.json();
  };
  return {
    name: 'FASHN',
    async tryOn({ person, garment, category }, signal) {
      // return_base64: the picture comes back in the status answer and FASHN keeps it 60 min instead of 3 days on its CDN.
      const inputs = { model_image: person, garment_image: garment, category, mode: 'balanced', num_samples: 1, output_format: 'jpeg', return_base64: true };
      const run = await call(`${FASHN}/run`, { method: 'POST', body: JSON.stringify({ model_name: 'tryon-v1.6', inputs }) }, signal);
      if (run?.error || typeof run?.id !== 'string') throw new Error('fashn run refused');
      for (;;) {
        await sleep(pollMs, signal);
        const s = await call(`${FASHN}/status/${encodeURIComponent(run.id)}`, { method: 'GET' }, signal);
        if (s?.status === 'failed') throw new Error(`fashn ${/^\w{1,40}$/.test(s.error?.name ?? '') ? s.error.name : 'failed'}`);
        if (s?.status !== 'completed') continue; // starting, in_queue, processing
        // The docs show output as an array of images; with return_base64 each is a data URL.
        const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(Array.isArray(s.output) ? s.output[0] : s.output);
        if (!m) throw new Error('fashn bad output');
        return Buffer.from(m[1], 'base64');
      }
    },
  };
}

// The one on/off check: a provider key, the shop's switch, the plan (task 45: has try-on, not read-only) and today's count.
export async function tryonOpen(db, provider, store, now = Date.now()) {
  if (!provider || !store?.tryon_on || !(await allows(db, store.organization_id, 'tryon', now))) return false;
  const row = await db('tryon_usage').where({ store_id: store.id, day: tashDay(now) }).first('count');
  return Number(row?.count ?? 0) < store.tryon_daily_limit;
}

// Takes one of today's pictures, or false when the limit is reached (a conditional UPDATE, so parallel requests can't overshoot).
async function claim(db, store, day) {
  await db('tryon_usage').insert({ store_id: store.id, day, count: 0 }).onConflict(['store_id', 'day']).ignore();
  return (await db('tryon_usage').where({ store_id: store.id, day }).where('count', '<', store.tryon_daily_limit).increment('count', 1)) > 0;
}

// Only our own short reasons reach the log, never a provider message or body (it could echo the request).
const reasonOf = (err) => (/^(fashn [\w ]{1,40}|timeout|aborted)$/.test(err?.message) ? err.message : err?.name ?? 'Error');

// POST / { store_id, product_id, photo: JPEG data URL, consent: true } → the picture's bytes (Cache-Control: no-store).
export function createTryonRouter(db, { provider, uploadDir, timeoutMs = TRYON_TIMEOUT_MS, now = Date.now }) {
  const r = express.Router();
  const KEYS = ['store_id', 'product_id', 'photo', 'consent'];
  let running = 0;
  r.post('/', async (req, res) => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !KEYS.includes(k))) throw fail(400, 'err.bad_request');
    if (b.consent !== true) throw fail(400, 'err.tryon_consent'); // asked every time, in the app's dialog
    const photo = parsePhoto(b.photo, TRYON_PHOTO_MAX);
    if (!photo) throw fail(400, 'err.invalid', { field: 'field.photo' });
    const store = Number.isInteger(b.store_id) && b.store_id > 0 ? await db('stores').where({ id: b.store_id }).first('id', 'organization_id', 'tryon_on', 'tryon_daily_limit') : null;
    if (!store) throw fail(404, 'err.store_not_found');
    if (!(await tryonOpen(db, provider, store, now()))) throw fail(403, 'err.tryon_off');
    // An item this shop shows and sells right now (stock > 0), usable for a try-on (never a child's).
    const p = Number.isInteger(b.product_id) && b.product_id > 0 ? await visible(db('products as p')).where({ 'p.id': b.product_id, 'p.store_id': store.id })
      .whereExists(inStock(db)).first('p.id', 'p.category', 'p.audience', 'p.image_url') : null;
    if (!p || !tryonGarment(p)) throw fail(404, 'err.product_not_found');
    const garment = await readFile(path.join(uploadDir, 'products', path.basename(p.image_url))).catch(() => null);
    const ext = garment && imageExt(garment); // the type from the file's bytes, as on upload
    if (!ext) throw fail(404, 'err.product_not_found');
    if (running >= TRYON_PARALLEL) throw fail(429, 'err.tryon_busy');
    if (!(await claim(db, store, tashDay(now())))) throw fail(429, 'err.tryon_limit');
    running++;
    const gone = new AbortController(); // the customer left (closed the dialog, the kiosk reset): stop polling
    res.on('close', () => res.writableEnded || gone.abort());
    try {
      const pic = await withDeadline((signal) => provider.tryOn({
        person: `data:image/jpeg;base64,${photo}`, garment: `data:${MIME[ext]};base64,${garment.toString('base64')}`, category: TRYON_ROLES[p.category],
      }, AbortSignal.any([signal, gone.signal])), timeoutMs);
      const type = Buffer.isBuffer(pic) && imageExt(pic);
      if (!type) throw new Error('fashn bad output');
      res.set('Cache-Control', 'no-store').type(MIME[type]).send(pic);
    } catch (err) {
      console.warn({ msg: 'tryon failed', reason: reasonOf(err) });
      // Answered here: the app's error handler hides 5xx reasons and alerts on them; a failed picture is routine.
      const status = err?.message === 'timeout' ? 504 : 502;
      if (!res.headersSent) res.status(status).json(errorBody(langOf(req), fail(status, 'err.tryon_failed')));
    } finally {
      running--;
    }
  });
  return r;
}

// Admin: pictures per Tashkent day for one store, the last `days` days (zero-filled, newest first).
export async function tryonUsage(db, storeId, { days = 14, now = Date.now() } = {}) {
  const keys = Array.from({ length: days }, (_, i) => tashDay(now - i * 86_400_000));
  const rows = await db('tryon_usage').where({ store_id: storeId }).whereIn('day', keys).select('day', 'count');
  const by = new Map(rows.map((x) => [x.day, Number(x.count)]));
  return keys.map((day) => ({ day, count: by.get(day) ?? 0 }));
}
