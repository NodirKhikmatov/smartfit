// Task 42: an outfit from the whole mall. Not a second engine: the same rules (ruleOutfits) run over the in-stock items
// of every shown shop of the mall (filterCandidates with storeIds), plus one rule on top, the per-shop cap (MALL_CAPS).
// Nothing ranks by shop: no shop can buy a better place. Each shop stays its own business: every shop with items on the
// screen gets its own recommendation_logs row holding only its own items (its stats, its bundle sets, its funnel), tied
// to the screen by mall_recs, which is all the mall admin counts.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { fail, langOf } from '../admin/routes.js';
import { filterCandidates, ruleOutfits, rankPool, ORDER } from './engine.js';
import { applyStylist, parsePhoto, withDeadline } from './stylist.js';
import { parseRequest, parseSwap, swapAt, keepShown, REC, REC_TTL_MS, dbTime } from './routes.js';

export const MALL_CAPS = [6, 9]; // items of one shop across the shown outfits, tried in order; then no cap
export const STYLIST_MAX = 12; // best candidates per outfit role sent to Claude (≤ 60), however many shops the mall has
const BUNDLE_MIN = 2; // a shop's part of a mall outfit counts as that shop's outfit (task 26 bundle) from 2 items
const token16 = () => randomBytes(16).toString('hex');
const shopsIn = (shops, items) => {
  const ids = new Set(items.map((p) => p.store_id));
  return shops.filter((s) => ids.has(s.id)).map(({ lat, lon, ...s }) => s);
};

export function createMallRecommendRouter(db, { weather, stylist, stylistTimeoutMs, allowAi }) {
  const r = express.Router();

  // The mall, its shown shops, the weather and the customer part of the body. want/own (single items) are a shop's
  // own flow: a mall outfit is whole outfits only.
  async function context(b) {
    if (!Number.isInteger(b.mall_id) || b.mall_id < 1 || b.mall_id > 999_999_999) throw fail(400, 'err.invalid', { field: 'field.mall' });
    if (b.want != null || b.own != null) throw fail(400, 'err.invalid', { field: 'field.want' });
    const q = parseRequest(b);
    const mall = await db('malls').where({ id: b.mall_id }).first('id', 'lat', 'lon');
    if (!mall) throw fail(404, 'err.mall_not_found');
    const shops = await db('stores').where({ mall_id: mall.id, mall_hidden: false }).orderBy('id')
      .select('id', 'name', 'mall_floor as floor', 'mall_unit as unit', 'logo_url', 'bundle_percent', 'lat', 'lon');
    // The shops share the mall's place: its coordinates (task 37), else its first shop's; same cache and offline fallback.
    const w = await weather(mall.lat != null ? mall : shops[0] ?? mall);
    const load = (spread) => filterCandidates(db, { storeIds: shops.map((s) => s.id), gender: b.gender, sizes: q.sizes, temperature: w.temperature, spread, fit: q.fit, audience: q.audience });
    return { ...q, mall, shops, w, load };
  }

  // POST /api/recommend/mall { mall_id, gender, sizes, budget?, fit?, method?, photo?, occasion?, audience?, rec? }
  // → the /recommend outfit answer + cap, rec (the mall screen), recs { store_id: that shop's rec }, shops on the screen.
  r.post('/', async (req, res) => {
    const b = req.body ?? {};
    const { sizes, budget, method, occasion, audience, mall, shops, w, load } = await context(b);
    const photo = audience === 'child' ? null : parsePhoto(b.photo);
    const ctx = { temperature: w.temperature, raining: w.raining, budget, occasion, caps: MALL_CAPS };
    const { candidates, ...rules } = await ruleOutfits(load, ctx);
    let result = { ...rules, style_guess: null, source: 'rules' };
    if (stylist && result.outfits.length && !result.notice && allowAi(req.ip)) {
      // The list grows with the shops: only the best STYLIST_MAX per role go to Claude, and only those may come back.
      const pool = rankPool(candidates, ctx);
      const top = ORDER.flatMap((c) => pool[c].slice(0, STYLIST_MAX));
      const name = new Map(shops.map((s) => [s.id, s.name]));
      try {
        const answer = await withDeadline((signal) => stylist({ photo, weather: w, sizes, budget, occasion, audience, lang: langOf(req),
          candidates: top.map((p) => ({ ...p, shop: name.get(p.store_id) })) }, signal), stylistTimeoutMs);
        const ai = applyStylist(answer, top, { ...ctx, cap: result.cap });
        if (ai) result = { ...result, ...ai, partial: null, source: 'ai' };
        else console.warn('stylist: no valid outfit, using rules');
      } catch (err) {
        console.warn('stylist failed, using rules:', err.status ?? err.name ?? 'error'); // never the error body or the request
      }
    }
    const { outfits, over_budget, partial, relaxed, notice, style_guess, source, cap } = result;
    const sets = outfits.flatMap((o) => [o, ...(o.alternative ? [o.alternative] : [])]).map((o) => o.items);
    const { rec, recs } = await logScreen({ b, mall, w, sizes, budget, method, occasion, source, sets, shown: [...outfits.flatMap((o) => o.items), ...(partial?.items ?? [])] });
    res.json({ mode: 'outfit', mall_id: mall.id, weather: w, budget, over_budget, partial, relaxed, notice, source, style_guess, outfits, cap, rec, recs,
      shops: shopsIn(shops, [...sets.flat(), ...(partial?.items ?? [])]), ...(occasion && { occasion }), ...(audience === 'child' && { audience }) });
  });

  // One mall_recs row per screen (a −/+ re-query with its rec keeps it), and per shop on it one recommendation_logs row
  // with only that shop's items: product_ids = its shown items, outfits = its part (2+ items) of each outfit shown.
  async function logScreen({ b, mall, w, sizes, budget, method, occasion, source, sets, shown }) {
    let screen = typeof b.rec === 'string' && REC.test(b.rec)
      ? await db('mall_recs').where({ token: b.rec, mall_id: mall.id }).where('created_at', '>', dbTime(Date.now() - REC_TTL_MS)).first('id', 'token') : null;
    if (!screen) {
      screen = { token: token16() };
      [{ id: screen.id }] = await db('mall_recs').insert({ mall_id: mall.id, token: screen.token }).returning('id');
    }
    const recs = {};
    for (const storeId of new Set(shown.map((p) => p.store_id))) {
      const mine = (items) => items.filter((p) => p.store_id === storeId).map((p) => p.id);
      const log = {
        temperature: w.temperature, raining: w.raining, gender: b.gender, sizes: JSON.stringify(sizes), budget, size_method: method, source, mode: 'outfit', occasion,
        product_ids: JSON.stringify([...new Set(mine(shown))]),
        outfits: JSON.stringify(sets.map(mine).filter((x) => x.length >= BUNDLE_MIN)),
      };
      const row = await db('recommendation_logs').where({ mall_rec_id: screen.id, store_id: storeId }).first('id', 'token');
      recs[storeId] = row?.token ?? token16();
      if (row) await db('recommendation_logs').where({ id: row.id }).update(log);
      else await db('recommendation_logs').insert({ ...log, store_id: storeId, token: recs[storeId], mall_rec_id: screen.id });
    }
    return { rec: screen.token, recs };
  }

  // POST /api/recommend/mall/swap: the /mall body + { items, replace, exclude, relaxed } → { options, shops }. Options come
  // from the mall's in-stock items like the outfits. With rec, each shop's part (2+ items) of an option joins its sets.
  r.post('/swap', async (req, res) => {
    const b = req.body ?? {};
    const c = await context(b);
    const { outfit, exclude } = parseSwap(b);
    const options = await swapAt(c.load, { b, outfit, exclude, w: c.w, budget: c.budget, occasion: c.occasion });
    const screen = typeof b.rec === 'string' && REC.test(b.rec) ? await db('mall_recs').where({ token: b.rec, mall_id: c.mall.id }).first('id') : null;
    if (screen && options.length) {
      for (const row of await db('recommendation_logs').where({ mall_rec_id: screen.id }).select('id', 'store_id', 'outfits')) {
        const sets = options.map((o) => o.items.filter((p) => p.store_id === row.store_id).map((p) => p.id)).filter((x) => x.length >= BUNDLE_MIN);
        if (sets.length) await keepShown(db, row, sets);
      }
    }
    res.json({ options, shops: shopsIn(c.shops, options.flatMap((o) => o.items)) });
  });
  return r;
}
