import express from 'express';
import { randomBytes } from 'node:crypto';
import { sizesFor } from '../db/seed.js';
import { fail, langOf } from '../admin/routes.js';
import { filterCandidates, ruleOutfits } from './engine.js';
import { parsePhoto, applyStylist, withDeadline, TIMEOUT_MS } from './stylist.js';

const pick = (v, allowed, label, required) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw fail(400, 'err.required', { field: label });
    return null;
  }
  const s = String(v).toUpperCase();
  if (!allowed.includes(s)) throw fail(400, 'err.invalid', { field: label });
  return s;
};

// shortcut: in-memory per-IP cap on paid Claude calls (over it → rules, never an error); one process only.
const AI_PER_MINUTE = 30;
export const REC = /^[a-f0-9]{32}$/;
const MAX_CABIN = 99;
const MAX_OPEN_FITTING = 3; // per results screen, so one customer can't flood the staff chat
const REC_TTL_MS = 2 * 60 * 60 * 1000; // a re-query after this starts a new log row (a new customer at the kiosk)
// Compares right against DB-default created_at: SQLite stores 'YYYY-MM-DD HH:MM:SS' (UTC) text, Postgres timestamptz.
export const dbTime = (ms) => `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)}+00:00`;

// Public: POST /api/recommend { store_id, gender, sizes: { top, bottom, shoes? }, budget?, photo? }
// stylist (task 7) is null without ANTHROPIC_API_KEY → rules only.
export function createRecommendRouter(db, { weather, stylist = null, stylistTimeoutMs = TIMEOUT_MS }) {
  const r = express.Router();
  const hits = new Map();
  let windowEnd = 0;
  const allowAi = (ip) => {
    if (Date.now() > windowEnd) {
      hits.clear();
      windowEnd = Date.now() + 60_000;
    }
    hits.set(ip, (hits.get(ip) ?? 0) + 1);
    return hits.get(ip) <= AI_PER_MINUTE;
  };

  r.post('/', async (req, res) => {
    const b = req.body ?? {};
    if (!Number.isInteger(b.store_id) || b.store_id < 1) throw fail(400, 'err.invalid', { field: 'field.store' });
    if (!['male', 'female'].includes(b.gender)) throw fail(400, 'err.invalid', { field: 'field.gender' });
    const sizes = {
      top: pick(b.sizes?.top, sizesFor('top'), 'field.top_size', true),
      bottom: pick(b.sizes?.bottom, sizesFor('bottom'), 'field.bottom_size', true),
      shoes: pick(b.sizes?.shoes, sizesFor('shoes'), 'field.shoe_size', false),
    };
    const budget = b.budget === undefined || b.budget === null || b.budget === 0 ? null : b.budget;
    if (budget !== null && (!Number.isInteger(budget) || budget < 1 || budget > 1e9)) throw fail(400, 'err.invalid', { field: 'field.budget' });
    const photo = parsePhoto(b.photo); // memory only: goes to Claude for this request, never stored or logged

    const store = await db('stores').where({ id: b.store_id }).first('id', 'lat', 'lon');
    if (!store) throw fail(404, 'err.store_not_found');
    const w = await weather(store);
    const ctx = { temperature: w.temperature, raining: w.raining, budget };
    const load = (spread) => filterCandidates(db, { storeId: store.id, gender: b.gender, sizes, temperature: w.temperature, spread });
    const { candidates, ...rules } = await ruleOutfits(load, ctx);
    let result = { ...rules, style_guess: null, source: 'rules' };
    // No rule outfit means a required category is empty, so Claude could not build one either. Without outerwear
    // (notice) applyStylist rejects every AI outfit, so the rules answer stands. Claude sees the relaxed candidates.
    if (stylist && result.outfits.length && !result.notice && allowAi(req.ip)) {
      try {
        const answer = await withDeadline((signal) => stylist({ photo, weather: w, sizes, budget, candidates, lang: langOf(req) }, signal), stylistTimeoutMs);
        const ai = applyStylist(answer, candidates, ctx);
        if (ai) result = { ...result, ...ai, partial: null, source: 'ai' };
        else console.warn('stylist: no valid outfit, using rules');
      } catch (err) {
        console.warn('stylist failed, using rules:', err.status ?? err.name ?? 'error'); // never the error body or the request
      }
    }
    const { outfits, over_budget, partial, relaxed, notice, style_guess, source } = result;

    // Stats (task 3) need product_ids as a JSON array of integers. No photo or body data here.
    const log = {
      temperature: w.temperature,
      raining: w.raining,
      gender: b.gender,
      sizes: JSON.stringify(sizes),
      budget,
      product_ids: JSON.stringify([...new Set([...outfits, ...(partial ? [partial] : [])].flatMap((o) => o.items.map((i) => i.id)))]),
      source,
    };
    // A −/+ re-query sends back its `rec` and updates the same row, so one customer counts once in the pilot report.
    let rec = typeof b.rec === 'string' && REC.test(b.rec) ? b.rec : null;
    if (!rec || !(await db('recommendation_logs').where({ token: rec, store_id: store.id }).where('created_at', '>', dbTime(Date.now() - REC_TTL_MS)).update(log))) {
      rec = randomBytes(16).toString('hex');
      await db('recommendation_logs').insert({ ...log, store_id: store.id, token: rec });
    }
    res.json({ weather: w, budget, over_budget, partial, relaxed, notice, source, style_guess, outfits, rec });
  });

  // Pilot funnel: the customer tapped "Kiyib ko'rdim" (tried the suggestion on). { rec } → 204, once per results screen.
  r.post('/tried', async (req, res) => {
    const rec = req.body?.rec;
    if (typeof rec !== 'string' || !REC.test(rec)) throw fail(400, 'err.bad_request');
    const row = await db('recommendation_logs').where({ token: rec }).first('id', 'tried_at');
    if (!row) throw fail(404, 'err.rec_not_found');
    if (!row.tried_at) await db('recommendation_logs').where({ id: row.id }).whereNull('tried_at').update({ tried_at: new Date().toISOString() });
    res.status(204).end();
  });

  // "Kabinaga olib keling": staff bring these items in these sizes to the cabin. { rec, cabin, items: [{ product_id, size }] }.
  // Goes to the admin orders screen and the store's Telegram chat (notifier loop), and counts as tried for the pilot.
  r.post('/fitting', async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.rec !== 'string' || !REC.test(b.rec)) throw fail(400, 'err.bad_request');
    if (!Number.isInteger(b.cabin) || b.cabin < 1 || b.cabin > MAX_CABIN) throw fail(400, 'err.cabin', { max: MAX_CABIN });
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 6) throw fail(400, 'err.invalid', { field: 'field.items' });
    const row = await db('recommendation_logs').where({ token: b.rec }).first('id', 'store_id', 'tried_at');
    if (!row) throw fail(404, 'err.rec_not_found');
    const items = [];
    for (const i of b.items) {
      if (!Number.isInteger(i?.product_id) || typeof i.size !== 'string') throw fail(400, 'err.item_missing');
      const p = await db('products').where({ id: i.product_id, store_id: row.store_id }).first('name', 'name_ru', 'category');
      if (!p) throw fail(404, 'err.product_not_found');
      if (!sizesFor(p.category).includes(i.size)) throw fail(400, 'err.product_size', { product: p });
      // Main rule: only what is on the shelf now (free stock > 0) is offered, for a try-on as well.
      const free = await db('product_stock').where({ product_id: i.product_id, size: i.size }).whereRaw('quantity - reserved > 0').first('id');
      if (!free) throw fail(409, 'err.out_of_stock', { product: p, size: i.size === 'ONE' ? 'common.size_one' : i.size });
      items.push({ product_id: i.product_id, size: i.size });
    }
    const [{ n }] = await db('fitting_requests').where({ recommendation_id: row.id, status: 'new' }).count({ n: '*' });
    if (Number(n) >= MAX_OPEN_FITTING) throw fail(429, 'err.fitting_busy');
    const [{ id }] = await db('fitting_requests').insert({ store_id: row.store_id, recommendation_id: row.id, cabin: b.cabin, items: JSON.stringify(items) }).returning('id');
    if (!row.tried_at) await db('recommendation_logs').where({ id: row.id }).whereNull('tried_at').update({ tried_at: new Date().toISOString() });
    res.status(201).json({ id, cabin: b.cabin });
  });
  return r;
}

// Public: GET /api/stores/:id → store name and current weather for the customer start screen.
// Public store list for the customer app's store picker (audit U10): names only.
// GET /:id also gives the attract screen up to 4 photos of items in stock now that suit today's weather.
const LOOK = ['outerwear', 'top', 'bottom', 'shoes'];
export function createStoreRouter(db, { weather }) {
  const r = express.Router();
  r.get('/', async (req, res) => {
    res.json(await db('stores').orderBy('id').select('id', 'name', 'city'));
  });
  r.get('/:id', async (req, res) => {
    const id = Number(req.params.id);
    const store = Number.isInteger(id) && id > 0 ? await db('stores').where({ id }).first('id', 'name', 'city', 'lat', 'lon') : undefined;
    if (!store) throw fail(404, 'err.store_not_found');
    const w = await weather(store);
    const rows = await db('products as p')
      .where('p.store_id', id).whereIn('p.category', LOOK).whereNotNull('p.image_url')
      .whereRaw('p.temp_min <= cast(? as real) and p.temp_max >= cast(? as real)', [w.temperature, w.temperature])
      .whereExists(db('product_stock as s').whereRaw('s.product_id = p.id').whereRaw('s.quantity - s.reserved > 0'))
      .orderBy('p.id').select('p.category', 'p.image_url');
    const looks = LOOK.map((c) => rows.find((p) => p.category === c)).filter(Boolean);
    res.json({ id: store.id, name: store.name, city: store.city, weather: w, looks });
  });
  return r;
}
