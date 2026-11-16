import express from 'express';
import { randomBytes } from 'node:crypto';
import { sizesFor, sizesOf, KIDS, KIDS_SHOES } from '../db/seed.js';
import { fail, langOf } from '../admin/routes.js';
import { filterCandidates, ruleOutfits, ruleSingles, missedItems, swapOptions, SPREADS, ORDER, OCCASIONS, sizeKey, visible } from './engine.js';
import { logMissed } from '../demand.js';
import { isFit, METHODS } from '../size/size.js';
import { parseJson } from '../cart/promo.js';
import { parsePhoto, applyStylist, applyRanking, withDeadline, TIMEOUT_MS } from './stylist.js';
import { COLORS, STYLES } from '../../public/shared/i18n.js';
import { tryonOpen } from '../tryon.js';

const pick = (v, allowed, label, required) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw fail(400, 'err.required', { field: label });
    return null;
  }
  const s = String(v).toUpperCase();
  if (!allowed.includes(s)) throw fail(400, 'err.invalid', { field: label });
  return s;
};

// Task 30: want = the categories wanted as single items (none = a whole outfit, as before); own = what the customer
// already has, from fixed lists, for single items only. → { want: [..] | null, own: [{ category, color, style }] }.
// Task 36: a want entry is a role code or the id of one of the store's shown categories (cats); role codes first in
// the engine's order, then ids in the shop's category order.
function parseWant(b, cats, audience) {
  if (b.want === undefined || b.want === null) {
    if (b.own !== undefined && b.own !== null) throw fail(400, 'err.invalid', { field: 'field.own' });
    return { want: null, own: [] };
  }
  const w = b.want;
  // Task 40: a category id must be for the request's audience (a child's request never names an adult category).
  const known = (c) => ORDER.includes(c) || (Number.isInteger(c) && cats.some((x) => x.id === c && x.audience === audience));
  if (!Array.isArray(w) || !w.length || w.length > 20 || !w.every(known) || new Set(w).size !== w.length) throw fail(400, 'err.invalid', { field: 'field.want' });
  const o = b.own ?? [];
  const ok = (x) => x && typeof x === 'object' && ORDER.includes(x.category) && COLORS.includes(x.color) && (x.style == null || STYLES.includes(x.style));
  if (!Array.isArray(o) || o.length > 5 || !o.every(ok)) throw fail(400, 'err.invalid', { field: 'field.own' });
  return { want: [...ORDER, ...cats.map((x) => x.id)].filter((c) => w.includes(c)), own: o.map((x) => ({ category: x.category, color: x.color, style: x.style ?? null })) };
}

// The store's categories a customer can pick (not hidden), in the shop's order. Task 36.
export const shownCategories = (db, storeId) => db('categories as c').join('stores as st', 'st.organization_id', 'c.organization_id')
  .where('st.id', storeId).where('c.hidden', false).orderBy(['c.sort', 'c.id']).select('c.id', 'c.name', 'c.name_ru', 'c.role', 'c.audience', 'c.image_url', 'c.size_kind', 'c.sizes');
const catsFor = (db, b) => (Array.isArray(b.want) && b.want.some(Number.isInteger) && Number.isInteger(b.store_id) && b.store_id > 0 ? shownCategories(db, b.store_id) : []);

// The customer part of a /recommend body: store, gender, sizes, budget and (task 30) want/own. A single-item request
// needs only the sizes of the wanted categories (top for outerwear/top, bottom for bottom; shoes stay optional).
// Task 40: audience 'child' (absent = 'adult', as before): sizes are the children's height sizes (92–164) and shoe
// sizes (22–35); gender male / female is the boy / girl choice.
function parseRequest(b, cats = []) {
  if (!Number.isInteger(b.store_id) || b.store_id < 1) throw fail(400, 'err.invalid', { field: 'field.store' });
  if (!['male', 'female'].includes(b.gender)) throw fail(400, 'err.invalid', { field: 'field.gender' });
  const audience = b.audience ?? 'adult';
  if (audience !== 'adult' && audience !== 'child') throw fail(400, 'err.invalid', { field: 'field.audience' });
  const child = audience === 'child';
  const { want, own } = parseWant(b, cats, audience);
  const role = (c) => (Number.isInteger(c) ? cats.find((x) => x.id === c).role : c);
  const needs = (key) => !want || want.some((c) => sizeKey[role(c)] === key);
  const sizes = {
    top: pick(b.sizes?.top, child ? KIDS : sizesFor('top'), 'field.top_size', needs('top')),
    bottom: pick(b.sizes?.bottom, child ? KIDS : sizesFor('bottom'), 'field.bottom_size', needs('bottom')),
    shoes: pick(b.sizes?.shoes, child ? KIDS_SHOES : sizesFor('shoes'), 'field.shoe_size', false),
  };
  const budget = b.budget === undefined || b.budget === null || b.budget === 0 ? null : b.budget;
  if (budget !== null && (!Number.isInteger(budget) || budget < 1 || budget > 1e9)) throw fail(400, 'err.invalid', { field: 'field.budget' });
  // Task 29: fit preference (shifts clothes per product) and how the size was found (pilot accuracy per method).
  const fit = b.fit ?? null, method = b.method ?? null;
  if (fit !== null && !isFit(fit)) throw fail(400, 'err.invalid', { field: 'field.fit_pref' });
  if (method !== null && !METHODS.includes(method)) throw fail(400, 'err.bad_request');
  // Task 33: where it will be worn, from the fixed list (own property only: "constructor" is not an occasion).
  const occasion = b.occasion ?? null;
  if (occasion !== null && (typeof occasion !== 'string' || !Object.hasOwn(OCCASIONS, occasion))) throw fail(400, 'err.invalid', { field: 'field.occasion' });
  return { sizes, budget, fit, method, want, own, occasion, audience };
}

// shortcut: in-memory per-IP cap on paid Claude calls (over it → rules, never an error); one process only.
const AI_PER_MINUTE = 30;
export const REC = /^[a-f0-9]{32}$/;
const MAX_CABIN = 99;
const MAX_OPEN_FITTING = 3;
const MAX_SHOWN = 60; // outfit sets kept per results screen (shortcut: a concurrent swap on one screen can drop one set; one customer per kiosk) // per results screen, so one customer can't flood the staff chat
const REC_TTL_MS = 2 * 60 * 60 * 1000; // a re-query after this starts a new log row (a new customer at the kiosk)
// Compares right against DB-default created_at: SQLite stores 'YYYY-MM-DD HH:MM:SS' (UTC) text, Postgres timestamptz.
export const dbTime = (ms) => `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)}+00:00`;

// Public: POST /api/recommend { store_id, gender, sizes: { top, bottom, shoes? }, budget?, fit?, method?, photo?, want?, own?, occasion? }
// With want (task 30) the answer has `groups` (single items per category) and no outfits.
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
    const cats = await catsFor(db, b);
    const { sizes, budget, fit, method, want, own, occasion, audience } = parseRequest(b, cats);
    // memory only: goes to Claude for this request, never stored or logged. Task 40: never a child's photo (the app
    // has no photo step for a child; one sent anyway is dropped here).
    const photo = audience === 'child' ? null : parsePhoto(b.photo);

    const store = await db('stores').where({ id: b.store_id }).first('id', 'lat', 'lon', 'bundle_percent');
    if (!store) throw fail(404, 'err.store_not_found');
    const w = await weather(store);
    const ctx = { temperature: w.temperature, raining: w.raining, budget, occasion };
    const load = (spread) => filterCandidates(db, { storeId: store.id, gender: b.gender, sizes, temperature: w.temperature, spread, fit, audience });
    const mode = want ? 'single' : 'outfit';
    // `audience` is in the answer only for a child, so an adult request gets exactly the answer it got before task 40.
    const kid = audience === 'child' ? { audience } : {};
    if (want) return single(req, res, { b, store, w, sizes, budget, method, fit, want, own, occasion, photo, load, cats, audience, kid });
    const { candidates, ...rules } = await ruleOutfits(load, ctx);
    let result = { ...rules, style_guess: null, source: 'rules' };
    // No rule outfit means a required category is empty, so Claude could not build one either. Without outerwear
    // (notice) applyStylist rejects every AI outfit, so the rules answer stands. Claude sees the relaxed candidates.
    if (stylist && result.outfits.length && !result.notice && allowAi(req.ip)) {
      try {
        const answer = await withDeadline((signal) => stylist({ photo, weather: w, sizes, budget, occasion, audience, candidates, lang: langOf(req) }, signal), stylistTimeoutMs);
        const ai = applyStylist(answer, candidates, ctx);
        if (ai) result = { ...result, ...ai, partial: null, source: 'ai' };
        else console.warn('stylist: no valid outfit, using rules');
      } catch (err) {
        console.warn('stylist failed, using rules:', err.status ?? err.name ?? 'error'); // never the error body or the request
      }
    }
    const { outfits, over_budget, partial, relaxed, notice, style_guess, source } = result;

    const rec = await logResults({ b, store, w, sizes, budget, method, fit, occasion, audience, source, mode,
      shown: [...outfits, ...(partial ? [partial] : [])].flatMap((o) => o.items),
      // Task 26: the whole outfits shown (and their cheaper variants), so the cart can trust an "outfit" for the bundle discount.
      outfits: outfits.flatMap((o) => [o, ...(o.alternative ? [o.alternative] : [])]).map((o) => o.items.map((i) => i.id)) });
    // `occasion` only when one was asked for: a request without it gets exactly the answer it got before task 33.
    res.json({ mode, weather: w, budget, over_budget, partial, relaxed, notice, source, style_guess, outfits, rec, bundle_percent: store.bundle_percent, ...(occasion && { occasion }), ...kid });
  });

  // Task 30, single items: rule picks per wanted category; Claude (when there) only re-orders the items the rules chose.
  async function single(req, res, { b, store, w, sizes, budget, method, fit, want, own, occasion, photo, load, cats, audience, kid }) {
    const ctx = { temperature: w.temperature, raining: w.raining, budget, want, own, occasion };
    let { groups, relaxed } = await ruleSingles(load, ctx);
    let style_guess = null, source = 'rules';
    const shownItems = () => groups.flatMap((g) => g.items);
    if (stylist && shownItems().length && allowAi(req.ip)) {
      try {
        const answer = await withDeadline((signal) => stylist({ mode: 'single', photo, weather: w, sizes, budget, own, occasion, audience,
          want: want.map((c) => (Number.isInteger(c) ? cats.find((x) => x.id === c).name : c)), candidates: shownItems(), lang: langOf(req) }, signal), stylistTimeoutMs);
        const ai = applyRanking(answer, groups);
        if (ai) {
          ({ groups, style_guess } = ai);
          source = 'ai';
        } else console.warn('stylist: no valid ranking, using rules');
      } catch (err) {
        console.warn('stylist failed, using rules:', err.status ?? err.name ?? 'error'); // never the error body or the request
      }
    }
    // outfits: [] — no whole outfit was shown, so the task 26 bundle discount can never apply to these items.
    const rec = await logResults({ b, store, w, sizes, budget, method, fit, want, occasion, audience, source, mode: 'single', shown: shownItems(), outfits: [] });
    res.json({ mode: 'single', weather: w, budget, relaxed, source, style_guess, groups, outfits: [], over_budget: 0, partial: null, notice: null, rec, bundle_percent: 0, ...(occasion && { occasion }), ...kid });
  }

  // One recommendation_logs row per results screen (stats need product_ids as a JSON int array; no photo or body data),
  // then the task 24 missed demand under its rec. → rec.
  async function logResults({ b, store, w, sizes, budget, method, fit, want = null, occasion = null, audience = 'adult', source, mode, shown, outfits }) {
    const log = {
      temperature: w.temperature,
      raining: w.raining,
      gender: b.gender,
      sizes: JSON.stringify(sizes),
      budget,
      product_ids: JSON.stringify([...new Set(shown.map((i) => i.id))]),
      source,
      size_method: method,
      mode,
      occasion,
      outfits: JSON.stringify(outfits),
    };
    // A −/+ re-query sends back its `rec` and updates the same row, so one customer counts once in the pilot report.
    let rec = typeof b.rec === 'string' && REC.test(b.rec) ? b.rec : null;
    if (!rec || !(await db('recommendation_logs').where({ token: rec, store_id: store.id }).where('created_at', '>', dbTime(Date.now() - REC_TTL_MS)).update(log))) {
      rec = randomBytes(16).toString('hex');
      await db('recommendation_logs').insert({ ...log, store_id: store.id, token: rec });
    }
    // Task 24: what this customer wanted but the shelf has none of, once per results screen (rec). Never fails the answer.
    await missedItems(db, { storeId: store.id, gender: b.gender, sizes, temperature: w.temperature, fit, want, audience })
      .then((items) => logMissed(db, { storeId: store.id, session: rec, items, source: 'recommend', mode }))
      .catch((err) => console.error('missed demand not logged:', err.message));
    return rec;
  }

  // Task 25: swap one item of a shown outfit. The / body (no photo) plus { items: [this outfit's ids], replace,
  // exclude: [ids in the other outfits shown], relaxed } → { options: [{ swap, items, total }] }, priced here from the
  // same in-stock candidates (customer's sizes, the answer's temperature window). With `rec`, the options are kept for the bundle rule.
  r.post('/swap', async (req, res) => {
    const b = req.body ?? {};
    const { sizes, budget, fit, occasion, audience } = parseRequest(b, await catsFor(db, b));
    const ids = (v, max) => {
      if (!Array.isArray(v) || v.length > max || !v.every((x) => Number.isInteger(x) && x > 0) || new Set(v).size !== v.length) throw fail(400, 'err.invalid', { field: 'field.items' });
      return v;
    };
    const outfit = ids(b.items, 6), exclude = ids(b.exclude ?? [], 30);
    if (!outfit.includes(b.replace)) throw fail(400, 'err.invalid', { field: 'field.items' });
    const store = await db('stores').where({ id: b.store_id }).first('id', 'lat', 'lon');
    if (!store) throw fail(404, 'err.store_not_found');
    const w = await weather(store);
    // Nothing in the outfit's window → widen it like the outfits do (R1: ±3, then ±6 °C); in-window items still rank first.
    let options = [];
    for (const spread of SPREADS.filter((x) => x >= (SPREADS.includes(b.relaxed) ? b.relaxed : 0))) {
      const candidates = await filterCandidates(db, { storeId: store.id, gender: b.gender, sizes, temperature: w.temperature, spread, fit, audience });
      const byId = new Map(candidates.map((p) => [p.id, p]));
      const items = outfit.map((id) => byId.get(id));
      if (items.some((p) => !p)) throw fail(409, 'err.outfit_stale'); // sold out or resized since the outfit was shown
      options = swapOptions(candidates, { items, replace: b.replace, exclude, budget, temperature: w.temperature, raining: w.raining, occasion });
      if (options.length) break;
    }
    // Task 26: a swapped outfit is a recommended outfit too (bundle discount). Kept on its results screen's log row, newest 60.
    const rec = typeof b.rec === 'string' && REC.test(b.rec) ? await db('recommendation_logs').where({ token: b.rec, store_id: store.id }).first('id', 'outfits') : null;
    if (rec && options.length) {
      const shown = [...parseJson(rec.outfits, []), ...options.map((o) => o.items.map((i) => i.id))].slice(-MAX_SHOWN);
      await db('recommendation_logs').where({ id: rec.id }).update({ outfits: JSON.stringify(shown) });
    }
    res.json({ options });
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
  // Task 32: from a garment label's item page there is no results screen, so `scan` (the label scan token) stands in for rec.
  r.post('/fitting', async (req, res) => {
    const b = req.body ?? {};
    const byScan = b.rec === undefined;
    const token = byScan ? b.scan : b.rec;
    if (typeof token !== 'string' || !REC.test(token)) throw fail(400, 'err.bad_request');
    if (!Number.isInteger(b.cabin) || b.cabin < 1 || b.cabin > MAX_CABIN) throw fail(400, 'err.cabin', { max: MAX_CABIN });
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 6) throw fail(400, 'err.invalid', { field: 'field.items' });
    const row = byScan ? await db('qr_scans').where({ token }).first('id', 'store_id') : await db('recommendation_logs').where({ token }).first('id', 'store_id', 'tried_at');
    if (!row) throw fail(404, 'err.rec_not_found');
    const items = [];
    for (const i of b.items) {
      if (!Number.isInteger(i?.product_id) || typeof i.size !== 'string') throw fail(400, 'err.item_missing');
      const p = await db('products').where({ id: i.product_id, store_id: row.store_id }).first('name', 'name_ru', 'category', 'sizes');
      if (!p) throw fail(404, 'err.product_not_found');
      if (!sizesOf(p).includes(i.size)) throw fail(400, 'err.product_size', { product: p });
      // Main rule: only what is on the shelf now (free stock > 0) is offered, for a try-on as well.
      const free = await db('product_stock').where({ product_id: i.product_id, size: i.size }).whereRaw('quantity - reserved > 0').first('id');
      if (!free) throw fail(409, 'err.out_of_stock', { product: p, size: i.size === 'ONE' ? 'common.size_one' : i.size });
      items.push({ product_id: i.product_id, size: i.size });
    }
    const own = byScan ? { scan_id: row.id } : { recommendation_id: row.id };
    const [{ n }] = await db('fitting_requests').where({ ...own, status: 'new' }).count({ n: '*' });
    if (Number(n) >= MAX_OPEN_FITTING) throw fail(429, 'err.fitting_busy');
    const [{ id }] = await db('fitting_requests').insert({ store_id: row.store_id, ...own, cabin: b.cabin, items: JSON.stringify(items) }).returning('id');
    if (!byScan && !row.tried_at) await db('recommendation_logs').where({ id: row.id }).whereNull('tried_at').update({ tried_at: new Date().toISOString() });
    res.status(201).json({ id, cabin: b.cabin });
  });
  return r;
}

// Public: GET /api/stores/:id → store name and current weather for the customer start screen.
// Public store list for the customer app's store picker (audit U10): names only.
// GET /:id also gives the attract screen up to 4 photos of items in stock now that suit today's weather.
const LOOK = ['outerwear', 'top', 'bottom', 'shoes'];
export function createStoreRouter(db, { weather, profiles = false, tryon = null }) {
  const r = express.Router();
  r.get('/', async (req, res) => {
    res.json(await db('stores').orderBy('id').select('id', 'name', 'city'));
  });
  r.get('/:id', async (req, res) => {
    const id = Number(req.params.id);
    const store = Number.isInteger(id) && id > 0 ? await db('stores').where({ id }).first('id', 'name', 'city', 'lat', 'lon', 'organization_id', 'tryon_on', 'tryon_daily_limit') : undefined;
    if (!store) throw fail(404, 'err.store_not_found');
    const w = await weather(store);
    const rows = await visible(db('products as p'))
      .where('p.store_id', id).where('p.audience', 'adult').whereIn('p.category', LOOK).whereNotNull('p.image_url')
      .whereRaw('p.temp_min <= cast(? as real) and p.temp_max >= cast(? as real)', [w.temperature, w.temperature])
      .whereExists(db('product_stock as s').whereRaw('s.product_id = p.id').whereRaw('s.quantity - s.reserved > 0'))
      .orderBy('p.id').select('p.category', 'p.image_url');
    const looks = LOOK.map((c) => rows.find((p) => p.category === c)).filter(Boolean);
    // profile: show the task 27 buttons (needs the Telegram bot and an organisation to scope the profile to).
    // categories (task 36): the shop's shown categories for the catalogue filter and the "Nima kerak?" chips.
    res.json({ id: store.id, name: store.name, city: store.city, weather: w, looks, profile: profiles && store.organization_id != null,
      categories: await shownCategories(db, id),
      ...((await tryonOpen(db, tryon, store)) && { tryon: tryon.name }) }); // task 41: the provider's name, for the consent text
  });
  return r;
}
