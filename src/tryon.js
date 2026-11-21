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
import { tryonGarment, tryonOutfitItem, TRYON_ROLES } from '../public/app/flow.js';
import { allows } from './plans.js';

export const TRYON_TIMEOUT_MS = 45_000; // FASHN "balanced" takes ~8 s; queueing gets the rest
export const TRYON_PHOTO_MAX = 1_500_000; // base64 chars (~1.1 MB JPEG); the app sends ≤ 1280 px, usually 150–400 KB
export const TRYON_PARALLEL = 4; // pictures in flight per process; FASHN's default account concurrency is 6
export const OUTFIT_MAX = 6; // items in one outfit picture (task 58); the outfit engine gives at most 5
export const GARMENT_MAX = 300_000; // base64 chars of one browser-drawn PNG of a demo drawing (task 58); usually 20–60 KB
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

// Task 58: Google's image model (Nano Banana) dresses the customer in the whole outfit in one picture. Same interface
// with `outfit: true`: tryOn({ person, garments: [{ image, category }] }, signal) → Buffer. REST Interactions API, no SDK;
// the key goes in a header, never the URL. Image models have no free tier: the key needs billing (paid content isn't used
// to improve Google's products, which the consent text says).
export const GEMINI_TRYON_MODEL = 'gemini-nano-banana-2.1'; // stable, up to 14 input images, ~$0.034 per 1K picture
const GEMINI_ROLE = { outerwear: 'outerwear (jacket or coat)', top: 'top (shirt, T-shirt or sweater)', bottom: 'trousers or skirt', shoes: 'shoes', accessory: 'accessory' };
const TRYON_PROMPT = 'Virtual try-on for a clothing store. Image 1 is a photo of the customer. The other images are garments from the store. '
  + 'Make one realistic photo of the same person wearing all of these garments together as one outfit. Keep the face, hair, skin tone, body shape, '
  + 'pose and background of image 1 unchanged; keep each garment\'s colour, pattern and cut; show the whole outfit, full body if the photo allows. '
  + 'Do not add other clothes, text or logos.\n';
const dataPart = (url) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!m) throw new Error('gemini bad input');
  return { type: 'image', mime_type: m[1], data: m[2] };
};
// The picture in an Interactions answer: `output_image`, or the image block of a model_output step. Never another image
// block (an answer could echo the inputs, and the customer's own photo must not come back as "the picture").
const outputImage = (j) => j?.output_image?.data ?? (Array.isArray(j?.steps) ? j.steps : []).filter((s) => s?.type === 'model_output')
  .flatMap((s) => (Array.isArray(s.content) ? s.content : [])).find((c) => c?.type === 'image' && typeof c.data === 'string')?.data;

export function createGeminiTryon({ apiKey = process.env.GEMINI_API_KEY?.trim(), model = process.env.GEMINI_TRYON_MODEL || GEMINI_TRYON_MODEL, fetch = globalThis.fetch } = {}) {
  if (!apiKey) return null;
  return {
    name: 'Gemini',
    outfit: true,
    async tryOn({ person, garments }, signal) {
      const list = garments.map((g, i) => `Image ${i + 2}: ${GEMINI_ROLE[g.category] ?? 'garment'}`).join('\n');
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey, 'Api-Revision': '2026-05-20' },
        body: JSON.stringify({
          model,
          input: [{ type: 'text', text: TRYON_PROMPT + list }, dataPart(person), ...garments.map((g) => dataPart(g.image))],
          response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '3:4', image_size: '1K' },
        }),
      });
      if (!r.ok) throw new Error(`gemini http ${r.status}`); // the body is never read into a log
      const data = outputImage(await r.json());
      if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('gemini no image'); // blocked, refused or text only
      return Buffer.from(data, 'base64');
    },
  };
}

// Task 59, testing only: the public IDM-VTON demo Space on Hugging Face (free, no key, a queue, ~25 s). The photo goes to
// a public demo server, so this provider never exists in production. shortcut: it dresses one upper-body garment (the
// outer layer: outerwear, else the top) and ignores the rest; switch to Gemini (billing) for the whole outfit.
const HF_SPACE = 'https://yisol-idm-vton.hf.space';
const HF_WHAT = { outerwear: 'jacket', top: 'shirt' };
const blobOf = (url) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!m) throw new Error('hf bad input');
  return new Blob([Buffer.from(m[2], 'base64')], { type: m[1] });
};
export function createHfDemoTryon({ fetch = globalThis.fetch, env = process.env } = {}) {
  if (env.NODE_ENV === 'production') return null;
  // A free Hugging Face account token raises the anonymous GPU quota (a couple of pictures, then errors for a while).
  const auth = env.HF_TOKEN?.trim() ? { authorization: `Bearer ${env.HF_TOKEN.trim()}` } : {};
  return {
    name: 'Hugging Face',
    outfit: true,
    roles: ['outerwear', 'top'], // task 60: what the app may offer in the mirror
    async tryOn({ person, garments }, signal) {
      const g = garments.find((x) => x.category === 'outerwear') ?? garments.find((x) => x.category === 'top');
      if (!g) throw new Error('hf no upper garment');
      const form = new FormData();
      form.append('files', blobOf(person), 'person.jpg');
      form.append('files', blobOf(g.image), 'garment.png');
      const up = await fetch(`${HF_SPACE}/upload`, { method: 'POST', body: form, signal, headers: auth });
      if (!up.ok) throw new Error(`hf http ${up.status}`);
      const [pPath, gPath] = await up.json();
      const file = (path) => ({ path, meta: { _type: 'gradio.FileData' } });
      // Gradio 4: start the job, then read its server-sent events until "complete" or "error".
      const call = await fetch(`${HF_SPACE}/call/tryon`, {
        method: 'POST', signal, headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ data: [{ background: file(pPath), layers: [], composite: null }, file(gPath), HF_WHAT[g.category], true, true, 30, 42] }),
      });
      if (!call.ok) throw new Error(`hf http ${call.status}`);
      const { event_id: id } = await call.json();
      const events = await (await fetch(`${HF_SPACE}/call/tryon/${encodeURIComponent(id)}`, { signal, headers: auth })).text();
      const done = /event: complete\ndata: (.+)/.exec(events);
      if (!done) throw new Error('hf failed'); // a queue limit or a model error; its text never reaches a log
      const out = JSON.parse(done[1])?.[0];
      const pic = await fetch(out?.url ?? `${HF_SPACE}/file=${out?.path}`, { signal, headers: auth });
      if (!pic.ok) throw new Error(`hf http ${pic.status}`);
      return Buffer.from(await pic.arrayBuffer());
    },
  };
}

// Task 58: TRYON_PROVIDER=gemini picks Gemini (it needs a billed GEMINI_API_KEY); otherwise FASHN as before (off without its key).
// Explicit, so the stylist's Gemini key never turns paid pictures on by itself.
export function pickTryon(env = process.env) {
  if (env.TRYON_PROVIDER === 'hf-demo') return createHfDemoTryon({ env }); // task 59: free, testing only
  if (env.TRYON_PROVIDER === 'gemini') return createGeminiTryon({ apiKey: env.GEMINI_API_KEY?.trim(), model: env.GEMINI_TRYON_MODEL || GEMINI_TRYON_MODEL });
  return createFashn({ apiKey: env.FASHN_API_KEY?.trim() });
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
const reasonOf = (err) => (/^((?:fashn|gemini|hf) [\w ]{1,40}|timeout|aborted)$/.test(err?.message) ? err.message : err?.name ?? 'Error');

// A demo drawing (SVG) turned into a PNG by the browser (task 58): only for a product whose own image is an SVG, a PNG by its
// bytes, size-capped. A real photo is always read from our own uploads, never taken from the client.
function drawnPng(v) {
  const m = typeof v === 'string' && v.length <= GARMENT_MAX && /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  const buf = m && Buffer.from(m[1], 'base64');
  return buf && imageExt(buf) === 'png' ? buf : null;
}
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// POST / { store_id, product_id, photo: JPEG data URL, consent: true } → the picture's bytes (Cache-Control: no-store).
// Task 58, an outfit provider (Gemini): { store_id, product_ids: [1–6 ids], photo, consent, garments?: { id: PNG data URL } }
// (product_id alone also works: an outfit of one); every item must qualify, and the picture counts once against the limit.
export function createTryonRouter(db, { provider, uploadDir, timeoutMs = TRYON_TIMEOUT_MS, now = Date.now }) {
  const r = express.Router();
  const KEYS = ['store_id', 'product_id', 'product_ids', 'photo', 'consent', 'garments'];
  const outfit = !!provider.outfit;
  let running = 0;
  r.post('/', async (req, res) => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !KEYS.includes(k))) throw fail(400, 'err.bad_request');
    if (b.consent !== true) throw fail(400, 'err.tryon_consent'); // asked every time, in the app's dialog
    const photo = parsePhoto(b.photo, TRYON_PHOTO_MAX);
    if (!photo) throw fail(400, 'err.invalid', { field: 'field.photo' });
    const store = Number.isInteger(b.store_id) && b.store_id > 0 ? await db('stores').where({ id: b.store_id }).first('id', 'organization_id', 'tryon_on', 'tryon_daily_limit') : null;
    if (!store) throw fail(404, 'err.store_not_found');
    if (!outfit && (b.product_ids !== undefined || b.garments !== undefined)) throw fail(400, 'err.bad_request'); // FASHN: one garment
    if (b.garments !== undefined && !plain(b.garments)) throw fail(400, 'err.bad_request');
    if (!(await tryonOpen(db, provider, store, now()))) throw fail(403, 'err.tryon_off');
    const ids = outfit && b.product_ids !== undefined ? b.product_ids : [b.product_id];
    const idsOk = Array.isArray(ids) && ids.length >= 1 && ids.length <= OUTFIT_MAX && new Set(ids).size === ids.length && ids.every((x) => Number.isInteger(x) && x > 0);
    // Items this shop shows and sells right now (stock > 0), usable for a try-on (never a child's).
    const rows = idsOk ? await visible(db('products as p')).whereIn('p.id', ids).where({ 'p.store_id': store.id })
      .whereExists(inStock(db)).select('p.id', 'p.category', 'p.audience', 'p.image_url') : [];
    if (!idsOk || rows.length !== ids.length || !rows.every(outfit ? tryonOutfitItem : tryonGarment)) throw fail(404, 'err.product_not_found');
    const garments = [];
    for (const id of ids) {
      const p = rows.find((x) => x.id === id);
      const buf = p.image_url.endsWith('.svg') ? drawnPng(b.garments?.[id])
        : await readFile(path.join(uploadDir, 'products', path.basename(p.image_url))).catch(() => null);
      const ext = buf && imageExt(buf); // the type from the file's bytes, as on upload
      if (!ext) throw fail(404, 'err.product_not_found');
      garments.push({ image: `data:${MIME[ext]};base64,${buf.toString('base64')}`, category: outfit ? p.category : TRYON_ROLES[p.category] });
    }
    if (running >= TRYON_PARALLEL) throw fail(429, 'err.tryon_busy');
    if (!(await claim(db, store, tashDay(now())))) throw fail(429, 'err.tryon_limit');
    running++;
    const gone = new AbortController(); // the customer left (closed the dialog, the kiosk reset): stop polling
    res.on('close', () => res.writableEnded || gone.abort());
    try {
      const person = `data:image/jpeg;base64,${photo}`;
      const input = outfit ? { person, garments } : { person, garment: garments[0].image, category: garments[0].category };
      const pic = await withDeadline((signal) => provider.tryOn(input, AbortSignal.any([signal, gone.signal])), timeoutMs);
      const type = Buffer.isBuffer(pic) && imageExt(pic);
      if (!type) throw new Error(`${outfit ? 'gemini' : 'fashn'} bad output`);
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
