// Task 53: mall analytics for the mall admin. Counts only.
// - mall_stats (migration 043) holds counters per mall, Tashkent day and hour, kind, channel (kiosk | phone), shop and
//   normalised search word: no visitor id, device, IP, phone, profile, photo or other customer text.
// - What other tasks already log is read, not logged again: offer views/taps (offer_stats, task 43), mall outfit
//   screens (mall_recs, task 42) and whether one reached the cart (its shops' recommendation_logs.accepted_at), mall
//   orders (order_groups, task 38), each shop's paid orders (the count the mall summary already shows).
// - A mall admin reads only their own mall (no mall id in the paths); everything else (shop owners, managers, super) 403.
import express from 'express';
import { fail, dayKey, dayStart, DAY_MS, langOf } from './admin/routes.js';
import { dbTime } from './recommend/routes.js';
import { toCsv } from './admin/csv.js';
import { searchQuery } from './admin/malls.js';
import { closedOrgs } from './plans.js';
import { t } from '../public/shared/i18n.js';

export const PERIOD_MAX = 366; // days
export const WORD_MAX = 40; // characters kept of a search word
const KINDS = ['visit', 'search', 'shop', 'pin']; // what the mall screen posts ("nothing" is decided here)
const CHANNELS = ['kiosk', 'phone'];
const TOP = 20; // words listed per list
const TZ_MS = 5 * 60 * 60 * 1000; // Asia/Tashkent is UTC+5 all year (no DST)
const iso = (ms) => new Date(ms).toISOString(); // paid_at is an ISO string (cart.js)

// The search word as kept: lower case, Uzbek apostrophes (ʻ ʼ ‘ ’ ` ´) as one ', letters, digits, ' and - only, single
// spaces, ≤ WORD_MAX characters. null = not kept: under 2 characters, or anything that may be personal (an @, or 5+
// digits: a phone or card number typed into the search box).
export function normWord(raw) {
  if (typeof raw !== 'string' || raw.includes('@') || (raw.match(/\d/g) ?? []).length >= 5) return null;
  const w = raw.normalize('NFKC').toLowerCase().replace(/[ʻʼ‘’`´]/g, "'").replace(/[^\p{L}\p{N}' -]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, WORD_MAX).trim();
  return w.length >= 2 ? w : null;
}

// ?from=&to= (Tashkent days, inclusive) or ?days=N (the last N days up to today; 7 by default) → the period and the
// previous one of the same length just before it. 400 on a bad date, from after to, a day after today, or > PERIOD_MAX.
export function periodOf(query = {}, now = Date.now()) {
  const bad = () => fail(400, 'err.invalid', { field: 'field.date' });
  const today = dayKey(now);
  const shift = (key, n) => dayKey(dayStart(key) + n * DAY_MS);
  const day = (v) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(dayStart(v)) || dayKey(dayStart(v)) !== v) throw bad();
    return v;
  };
  let from, to;
  if (query.from || query.to) {
    to = query.to ? day(query.to) : today;
    from = query.from ? day(query.from) : to;
  } else {
    const n = query.days === undefined ? 7 : Number(query.days);
    if (!Number.isInteger(n) || n < 1 || n > PERIOD_MAX) throw bad();
    to = today;
    from = shift(today, 1 - n);
  }
  if (from > to || to > today) throw bad();
  const days = Math.round((dayStart(to) - dayStart(from)) / DAY_MS) + 1;
  if (days > PERIOD_MAX) throw bad();
  const keys = Array.from({ length: days }, (_, i) => shift(from, i));
  return { from, to, days, keys, prev: { from: shift(from, -days), to: shift(from, -1) } };
}

// Record one event: the counter of its hour goes up by one.
async function count(db, row, now) {
  const hour = new Date(now + TZ_MS).getUTCHours();
  await db('mall_stats').insert({ ...row, day: dayKey(now), hour, n: 1 })
    .onConflict(['mall_id', 'day', 'hour', 'kind', 'channel', 'store_id', 'word']).merge({ n: db.raw('mall_stats.n + 1') });
}

// Public: POST /api/mall-events { mall_id, kind, channel, store_id?, word? } → 204. Its own per-IP bucket (app.js).
// visit: the mall screen opened (a phone) or first touched (a kiosk, again after each idle reset).
// search: a word the customer searched and kept on screen; this route itself asks whether any shop of the mall has it
// in stock, and counts it as "nothing" if none has. shop: a shop opened from the directory, the map or a search
// result; pin: a shop's pin tapped on the map. A shop must be one the mall shows; an unknown mall or shop is 404.
export function createMallEventRouter(db, { now = Date.now } = {}) {
  const r = express.Router();
  r.post('/', async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const ok = (v) => Number.isInteger(v) && v > 0 && v <= 2147483647;
    if (!ok(b.mall_id) || !KINDS.includes(b.kind) || !CHANNELS.includes(b.channel)) throw fail(400, 'err.bad_request');
    if (!(await db('malls').where({ id: b.mall_id }).first('id'))) throw fail(404, 'err.mall_not_found');
    const row = { mall_id: b.mall_id, kind: b.kind, channel: b.channel, store_id: 0, word: '' };
    if (b.kind === 'shop' || b.kind === 'pin') {
      if (!ok(b.store_id) || !(await db('stores').where({ id: b.store_id, mall_id: b.mall_id, mall_hidden: false }).first('id'))) throw fail(404, 'err.store_not_found');
      row.store_id = b.store_id;
    } else if (b.kind === 'search') {
      if (typeof b.word !== 'string' || b.word.length > 60) throw fail(400, 'err.invalid', { field: 'field.search' });
      row.word = normWord(b.word);
      if (!row.word) return res.status(204).end(); // too short or possibly personal: not kept
      const found = await searchQuery(db, b.mall_id, b.word.trim(), await closedOrgs(db)).first('p.id');
      if (!found) row.kind = 'nothing';
    } else if (b.store_id !== undefined || b.word !== undefined) throw fail(400, 'err.bad_request');
    await count(db, row, now());
    res.status(204).end();
  });
  return r;
}

// The period's totals (also for the previous period, for the deltas).
async function totals(db, mallId, { from, to }) {
  const start = dayStart(from), end = dayStart(to) + DAY_MS;
  const shops = db('stores').where({ mall_id: mallId }).select('id');
  const [kinds, [offers], [outfits], [toCart], [groups], [orders]] = await Promise.all([
    db('mall_stats').where({ mall_id: mallId }).whereBetween('day', [from, to]).groupBy('kind', 'channel').select('kind', 'channel').sum({ n: 'n' }),
    db('offer_stats as s').join('offers as o', 'o.id', 's.offer_id').where('o.mall_id', mallId).whereBetween('s.day', [from, to]).sum({ shown: 's.shown', tapped: 's.tapped' }),
    db('mall_recs').where({ mall_id: mallId }).where('created_at', '>=', dbTime(start)).where('created_at', '<', dbTime(end)).count({ n: '*' }),
    db('mall_recs as m').where('m.mall_id', mallId).where('m.created_at', '>=', dbTime(start)).where('m.created_at', '<', dbTime(end))
      .whereExists(db('recommendation_logs as r').whereRaw('r.mall_rec_id = m.id').whereNotNull('r.accepted_at')).count({ n: '*' }),
    db('order_groups').where({ mall_id: mallId }).where('created_at', '>=', dbTime(start)).where('created_at', '<', dbTime(end)).count({ n: '*' }),
    db('orders').whereIn('store_id', shops).where({ payment_status: 'paid' }).whereNot('status', 'cancelled').where('paid_at', '>=', iso(start)).where('paid_at', '<', iso(end)).count({ n: '*' }),
  ]);
  const sum = (kind, channel) => kinds.filter((x) => x.kind === kind && (!channel || x.channel === channel)).reduce((a, x) => a + Number(x.n), 0);
  return {
    visits: sum('visit'), kiosk_visits: sum('visit', 'kiosk'), phone_visits: sum('visit', 'phone'),
    searches: sum('search') + sum('nothing'), nothing: sum('nothing'), shop_opens: sum('shop'), pin_opens: sum('pin'),
    offer_shown: Number(offers.shown ?? 0), offer_tapped: Number(offers.tapped ?? 0),
    outfits: Number(outfits.n), outfits_cart: Number(toCart.n), groups: Number(groups.n), orders: Number(orders.n),
  };
}

// → { from, to, days, prev, totals, prev_totals, per_day, per_hour, words, nothing, shops }. Visitors per day and per
// hour of the day (summed over the period), kiosk and phone apart; the most searched words and those that found
// nothing; every shop of the mall with its opens, pin taps and paid orders (most opened first).
export async function mallStats(db, mallId, period) {
  const { from, to, keys } = period;
  const start = dayStart(from), end = dayStart(to) + DAY_MS;
  const inPeriod = () => db('mall_stats').where({ mall_id: mallId }).whereBetween('day', [from, to]);
  const words = (kinds) => inPeriod().whereIn('kind', kinds).groupBy('word').select('word').sum({ n: 'n' })
    .orderBy([{ column: 'n', order: 'desc' }, { column: 'word' }]).limit(TOP);
  const [cur, prev, visits, searched, nothing, opens, shops, orders] = await Promise.all([
    totals(db, mallId, period), totals(db, mallId, period.prev),
    inPeriod().where({ kind: 'visit' }).groupBy('day', 'hour', 'channel').select('day', 'hour', 'channel').sum({ n: 'n' }),
    words(['search', 'nothing']), words(['nothing']),
    inPeriod().whereIn('kind', ['shop', 'pin']).groupBy('store_id', 'kind').select('store_id', 'kind').sum({ n: 'n' }),
    db('stores').where({ mall_id: mallId }).orderBy(['name', 'id']).select('id', 'name', 'mall_floor as floor', 'mall_unit as unit', 'mall_hidden as hidden'),
    db('orders as o').join('stores as st', 'st.id', 'o.store_id').where('st.mall_id', mallId).where('o.payment_status', 'paid').whereNot('o.status', 'cancelled')
      .where('o.paid_at', '>=', iso(start)).where('o.paid_at', '<', iso(end)).groupBy('o.store_id').select('o.store_id').count({ n: '*' }),
  ]);
  const perDay = new Map(keys.map((k) => [k, { day: k, kiosk: 0, phone: 0 }]));
  const perHour = Array.from({ length: 24 }, (_, hour) => ({ hour, kiosk: 0, phone: 0 }));
  for (const v of visits) {
    const n = Number(v.n);
    if (perDay.has(v.day)) perDay.get(v.day)[v.channel] += n;
    perHour[v.hour][v.channel] += n;
  }
  const n = (rows, f) => Number(rows.find(f)?.n ?? 0);
  return {
    from, to, days: period.days, prev: period.prev, totals: cur, prev_totals: prev,
    per_day: [...perDay.values()], per_hour: perHour,
    words: searched.map((w) => ({ word: w.word, n: Number(w.n) })), nothing: nothing.map((w) => ({ word: w.word, n: Number(w.n) })),
    shops: shops.map((s) => ({ ...s, hidden: Boolean(s.hidden), opens: n(opens, (x) => x.store_id === s.id && x.kind === 'shop'),
      pins: n(opens, (x) => x.store_id === s.id && x.kind === 'pin'), orders: n(orders, (x) => x.store_id === s.id) }))
      .sort((a, b) => b.opens - a.opens || b.orders - a.orders || a.id - b.id),
  };
}

// Admin (mall role only, MALL_ROUTES): GET /mall/stats and GET /mall/stats/export (CSV in the admin's language).
export function mallStatsRoutes(r, db, { now = Date.now } = {}) {
  const mine = (req) => {
    if (req.admin.role !== 'mall' || !req.admin.mall_id) throw fail(403, 'err.forbidden');
    return req.admin.mall_id;
  };
  r.get('/mall/stats', async (req, res) => {
    const mallId = mine(req);
    res.json(await mallStats(db, mallId, periodOf(req.query, now())));
  });
  r.get('/mall/stats/export', async (req, res) => {
    const mallId = mine(req);
    const s = await mallStats(db, mallId, periodOf(req.query, now()));
    const lang = langOf(req);
    const tr = (key, vars) => t(key, vars, lang);
    const T = s.totals, P = s.prev_totals;
    const metric = (key, field) => [tr(key), T[field], P[field]];
    const csv = toCsv([
      [tr('adm.ma.metric'), `${s.from} – ${s.to}`, `${s.prev.from} – ${s.prev.to}`],
      metric('adm.ma.visits', 'visits'), metric('adm.ma.kiosk', 'kiosk_visits'), metric('adm.ma.phone', 'phone_visits'),
      metric('adm.ma.searches', 'searches'), metric('adm.ma.nothing', 'nothing'), metric('adm.ma.shop_opens', 'shop_opens'), metric('adm.ma.pin_opens', 'pin_opens'),
      metric('adm.ma.offer_shown', 'offer_shown'), metric('adm.ma.offer_tapped', 'offer_tapped'), metric('adm.ma.outfits', 'outfits'),
      metric('adm.ma.outfits_cart', 'outfits_cart'), metric('adm.ma.groups', 'groups'), metric('adm.ma.orders', 'orders'),
      [],
      [tr('adm.stats.day'), tr('adm.ma.kiosk'), tr('adm.ma.phone')], ...s.per_day.map((d) => [d.day, d.kiosk, d.phone]),
      [],
      [tr('adm.ma.hour'), tr('adm.ma.kiosk'), tr('adm.ma.phone')], ...s.per_hour.map((h) => [`${String(h.hour).padStart(2, '0')}:00`, h.kiosk, h.phone]),
      [],
      [tr('adm.ma.word'), tr('adm.ma.searches')], ...s.words.map((w) => [w.word, w.n]),
      [],
      [tr('adm.ma.word'), tr('adm.ma.nothing')], ...s.nothing.map((w) => [w.word, w.n]),
      [],
      [tr('adm.mall.shop'), tr('adm.ma.shop_opens'), tr('adm.ma.pin_opens'), tr('adm.ma.orders')], ...s.shops.map((x) => [x.name, x.opens, x.pins, x.orders]),
    ]);
    res.type('text/csv; charset=utf-8').attachment(`mall-${s.from}-${s.to}.csv`).send(csv);
  });
}

