import express from 'express';
import { sizesFor } from '../db/seed.js';
import { fail } from '../admin/routes.js';
import { filterCandidates, buildOutfits } from './engine.js';
import { parsePhoto, applyStylist, withDeadline, TIMEOUT_MS } from './stylist.js';

const pick = (v, allowed, label, required) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw fail(400, `${label} majburiy`);
    return null;
  }
  const s = String(v).toUpperCase();
  if (!allowed.includes(s)) throw fail(400, `${label} noto'g'ri`);
  return s;
};

// shortcut: in-memory per-IP cap on paid Claude calls (over it → rules, never an error); one process only.
const AI_PER_MINUTE = 30;

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
    if (!Number.isInteger(b.store_id) || b.store_id < 1) throw fail(400, "Do'kon noto'g'ri");
    if (!['male', 'female'].includes(b.gender)) throw fail(400, "Jins noto'g'ri");
    const sizes = {
      top: pick(b.sizes?.top, sizesFor('top'), 'Ustki razmer', true),
      bottom: pick(b.sizes?.bottom, sizesFor('bottom'), 'Shim razmeri', true),
      shoes: pick(b.sizes?.shoes, sizesFor('shoes'), 'Oyoq kiyim razmeri', false),
    };
    const budget = b.budget === undefined || b.budget === null || b.budget === 0 ? null : b.budget;
    if (budget !== null && (!Number.isInteger(budget) || budget < 1 || budget > 1e9)) throw fail(400, "Byudjet noto'g'ri");
    const photo = parsePhoto(b.photo); // memory only: goes to Claude for this request, never stored or logged

    const store = await db('stores').where({ id: b.store_id }).first('id', 'lat', 'lon');
    if (!store) throw fail(404, "Do'kon topilmadi");
    const w = await weather(store);
    const candidates = await filterCandidates(db, { storeId: store.id, gender: b.gender, sizes, temperature: w.temperature });
    const ctx = { temperature: w.temperature, raining: w.raining, budget };
    let result = { ...buildOutfits(candidates, ctx), style_guess: null, source: 'rules' };
    // No rule outfit means a required category is empty, so Claude could not build one either.
    if (stylist && result.outfits.length && allowAi(req.ip)) {
      try {
        const answer = await withDeadline((signal) => stylist({ photo, weather: w, sizes, budget, candidates }, signal), stylistTimeoutMs);
        const ai = applyStylist(answer, candidates, ctx);
        if (ai) result = { ...ai, source: 'ai' };
        else console.warn('stylist: no valid outfit, using rules');
      } catch (err) {
        console.warn('stylist failed, using rules:', err.status ?? err.name ?? 'error'); // never the error body or the request
      }
    }
    const { outfits, over_budget, style_guess, source } = result;

    // Stats (task 3) need product_ids as a JSON array of integers. No photo or body data here.
    await db('recommendation_logs').insert({
      store_id: store.id,
      temperature: w.temperature,
      raining: w.raining,
      gender: b.gender,
      sizes: JSON.stringify(sizes),
      budget,
      product_ids: JSON.stringify([...new Set(outfits.flatMap((o) => o.items.map((i) => i.id)))]),
      source,
    });
    res.json({ weather: w, budget, over_budget, source, style_guess, outfits });
  });
  return r;
}

// Public: GET /api/stores/:id → store name and current weather for the customer start screen.
export function createStoreRouter(db, { weather }) {
  const r = express.Router();
  r.get('/:id', async (req, res) => {
    const id = Number(req.params.id);
    const store = Number.isInteger(id) && id > 0 ? await db('stores').where({ id }).first('id', 'name', 'city', 'lat', 'lon') : undefined;
    if (!store) throw fail(404, "Do'kon topilmadi");
    res.json({ id: store.id, name: store.name, city: store.city, weather: await weather(store) });
  });
  return r;
}
