import express from 'express';
import { sizesFor } from '../db/seed.js';
import { fail } from '../admin/routes.js';
import { filterCandidates, buildOutfits } from './engine.js';

const pick = (v, allowed, label, required) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw fail(400, `${label} majburiy`);
    return null;
  }
  const s = String(v).toUpperCase();
  if (!allowed.includes(s)) throw fail(400, `${label} noto'g'ri`);
  return s;
};

// Public: POST /api/recommend { store_id, gender, sizes: { top, bottom, shoes? }, budget? }
export function createRecommendRouter(db, { weather }) {
  const r = express.Router();
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

    const store = await db('stores').where({ id: b.store_id }).first('id', 'lat', 'lon');
    if (!store) throw fail(404, "Do'kon topilmadi");
    const w = await weather(store);
    const candidates = await filterCandidates(db, { storeId: store.id, gender: b.gender, sizes, temperature: w.temperature });
    const { outfits, over_budget } = buildOutfits(candidates, { temperature: w.temperature, raining: w.raining, budget });

    // Stats (task 3) need product_ids as a JSON array of integers. No photo or body data here.
    await db('recommendation_logs').insert({
      store_id: store.id,
      temperature: w.temperature,
      raining: w.raining,
      gender: b.gender,
      sizes: JSON.stringify(sizes),
      budget,
      product_ids: JSON.stringify([...new Set(outfits.flatMap((o) => o.items.map((i) => i.id)))]),
      source: 'rules',
    });
    res.json({ weather: w, budget, over_budget, outfits });
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
