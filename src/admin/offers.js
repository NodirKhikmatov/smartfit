// Task 43: shop offers (aksiyalar). A shop owner writes an offer for one of its stores: title and text in uz/ru, a
// picture, Tashkent days, optionally one of its promo codes or one of that store's products. States:
// draft → submitted → approved | rejected (with the mall admin's reason). A store outside any mall has no approval
// step: submitting publishes it. The mall admin sees only what shops submitted to its mall (never drafts, products,
// prices, orders or customers) and approves, rejects and orders the idle slides. Offer text and pictures are
// untrusted: the apps set them as text, and the picture passes the same magic-byte check as product photos.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fail, text, imageExt, inStores, canSee, dayKey, DAY_MS } from './routes.js';
import { audit, diff } from './audit.js';
import { stamp } from '../cart/cart.js';
import { visible } from '../recommend/engine.js';
import { inStock } from '../catalog.js';

const TZ_OFFSET = '+05:00'; // Asia/Tashkent, no DST: an offer runs from the start of its first day to the end of its last
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const OFFER_TEXT = { title: 60, body: 160, reason: 200 }; // the kiosk slide and the mall card hold these in both languages
export const SLIDE_SECONDS = { min: 4, max: 30 };
const OFFERS_MAX = 200; // per organisation: a typo loop can't fill the table
const EVENT_IDS_MAX = 20; // offers counted per request
const COOLDOWN_MS = 30_000; // one shown / one tap per offer and IP every 30 s
const EDITABLE = ['title', 'title_ru', 'body', 'body_ru', 'starts_on', 'ends_on', 'promo_code_id', 'product_id'];
const SHOP_LIVE = ['submitted', 'approved']; // on the shop's own screens no approval is needed; a rejected offer is gone
const iso = (ms) => new Date(ms).toISOString();
const dayStart = (d) => new Date(`${d}T00:00:00${TZ_OFFSET}`).toISOString();
const tashDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
const idOf = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : 0); // fits an integer column
const live = (q, now = Date.now()) => q.where('o.starts_at', '<=', iso(now)).where('o.ends_at', '>', iso(now));

// The one "may this shop post offers" check (task 45 will put plans behind it): the shop's owner, or super.
export function canPostOffers(admin) {
  if (!['owner', 'super'].includes(admin.role)) throw fail(403, 'err.forbidden');
}

function validOffer(b) {
  const day = (v) => {
    if (typeof v !== 'string' || !DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw fail(400, 'err.invalid', { field: 'field.offer_dates' });
    return v;
  };
  const id = (v, field) => {
    if (v == null || v === '') return null;
    if (!Number.isInteger(v) || v < 1 || v > 2147483647) throw fail(400, 'err.invalid', { field });
    return v;
  };
  const o = {
    title: text(b.title, OFFER_TEXT.title, 'field.offer_title', true),
    title_ru: text(b.title_ru, OFFER_TEXT.title, 'field.offer_title_ru', true),
    body: text(b.body, OFFER_TEXT.body, 'field.offer_body', false),
    body_ru: text(b.body_ru, OFFER_TEXT.body, 'field.offer_body_ru', false),
    starts_on: day(b.starts_on),
    ends_on: day(b.ends_on),
    promo_code_id: id(b.promo_code_id, 'field.offer_link'),
    product_id: id(b.product_id, 'field.offer_link'),
  };
  if (o.ends_on < o.starts_on) throw fail(400, 'err.invalid', { field: 'field.offer_dates' });
  if (o.promo_code_id && o.product_id) throw fail(400, 'err.invalid', { field: 'field.offer_link' }); // one link at most
  return o;
}
const columns = ({ starts_on, ends_on, ...o }) => ({ ...o, starts_at: dayStart(starts_on), ends_at: iso(Date.parse(dayStart(ends_on)) + DAY_MS) });
const formOf = (o) => ({
  title: o.title, title_ru: o.title_ru, body: o.body ?? null, body_ru: o.body_ru ?? null,
  starts_on: tashDay(Date.parse(stamp(o.starts_at))), ends_on: tashDay(Date.parse(stamp(o.ends_at)) - 1),
  promo_code_id: o.promo_code_id ?? null, product_id: o.product_id ?? null,
});

// A linked promo code must be the store's organisation's (for every store, or this one); a product this store's.
async function checkLink(db, store, o) {
  if (o.promo_code_id) {
    const c = await db('promo_codes').where({ id: o.promo_code_id, organization_id: store.organization_id })
      .where((w) => w.whereNull('store_id').orWhere('store_id', store.id)).first('id');
    if (!c) throw fail(400, 'err.invalid', { field: 'field.offer_link' });
  }
  if (o.product_id && !(await db('products').where({ id: o.product_id, store_id: store.id }).first('id'))) throw fail(400, 'err.invalid', { field: 'field.offer_link' });
}

// shown / tapped per offer over the last 30 Tashkent days (today included).
async function countsOf(db, ids) {
  if (!ids.length) return new Map();
  const rows = await db('offer_stats').whereIn('offer_id', ids).where('day', '>=', dayKey(Date.now() - 29 * DAY_MS))
    .groupBy('offer_id').select('offer_id').sum({ shown: 'shown' }).sum({ tapped: 'tapped' });
  return new Map(rows.map((r) => [r.offer_id, { shown: Number(r.shown), tapped: Number(r.tapped) }]));
}
// What a link shows to an admin: the code's text or the product's name (no price).
async function linksOf(db, rows) {
  const ids = (k) => [...new Set(rows.map((o) => o[k]).filter(Boolean))];
  const [codes, products] = await Promise.all([
    db('promo_codes').whereIn('id', ids('promo_code_id')).select('id', 'code'),
    db('products').whereIn('id', ids('product_id')).select('id', 'name', 'name_ru'),
  ]);
  return (o) => {
    if (o.promo_code_id) return { kind: 'promo', code: codes.find((c) => c.id === o.promo_code_id)?.code ?? null };
    if (o.product_id) { const p = products.find((x) => x.id === o.product_id); return { kind: 'product', name: p?.name ?? null, name_ru: p?.name_ru ?? null }; }
    return null;
  };
}
async function views(db, rows) {
  const [counts, link] = await Promise.all([countsOf(db, rows.map((o) => o.id)), linksOf(db, rows)]);
  const now = Date.now();
  return rows.map((o) => ({
    id: o.id, organization_id: o.organization_id, store_id: o.store_id, store_name: o.store_name, mall_id: o.mall_id ?? null, in_mall: o.store_mall != null,
    floor: o.floor ?? null, unit: o.unit ?? null, ...formOf(o), image_url: o.image_url ?? null, link: link(o),
    status: o.status, reject_reason: o.reject_reason ?? null, sort: o.sort,
    live: Date.parse(stamp(o.starts_at)) <= now && Date.parse(stamp(o.ends_at)) > now, ...(counts.get(o.id) ?? { shown: 0, tapped: 0 }),
  }));
}

export function offerRoutes(r, db, { uploadDir = 'uploads' } = {}) {
  const imageDir = path.resolve(uploadDir, 'offers');
  const list = () => db('offers as o').join('stores as st', 'st.id', 'o.store_id')
    .select('o.*', 'st.name as store_name', 'st.mall_floor as floor', 'st.mall_unit as unit', 'st.mall_id as store_mall');

  // ---------- The shop (owner of the organisation, or super)

  async function findOffer(req) {
    canPostOffers(req.admin);
    const id = idOf(req.params.id);
    const o = id ? await inStores(req.admin, list().where('o.id', id), 'o.store_id').first() : undefined;
    if (!o) throw fail(404, 'err.not_found');
    return o;
  }
  const one = async (id) => (await views(db, [await list().where('o.id', id).first()]))[0];

  // ?store_id narrows → [offer] newest first, with 30-day counts.
  r.get('/offers', async (req, res) => {
    canPostOffers(req.admin);
    const q = inStores(req.admin, list(), 'o.store_id').orderBy('o.id', 'desc').limit(OFFERS_MAX);
    if (req.query.store_id) q.where('o.store_id', idOf(req.query.store_id));
    res.json(await views(db, await q));
  });

  // { store_id, title, title_ru, body?, body_ru?, starts_on, ends_on, promo_code_id? | product_id? } → a draft.
  r.post('/offers', async (req, res) => {
    canPostOffers(req.admin);
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const sid = idOf(b.store_id);
    const store = sid && canSee(req.admin, sid) ? await db('stores').where({ id: sid }).first('id', 'name', 'organization_id') : undefined;
    if (!store) throw fail(404, 'err.store_not_found');
    const o = validOffer(b);
    await checkLink(db, store, o);
    const [{ n }] = await db('offers').where({ organization_id: store.organization_id }).count({ n: '*' });
    if (Number(n) >= OFFERS_MAX) throw fail(409, 'err.offers_max', { max: OFFERS_MAX });
    const id = await db.transaction(async (trx) => {
      const [{ id }] = await trx('offers').insert({ organization_id: store.organization_id, store_id: store.id, ...columns(o) }).returning('id');
      await audit(trx, req.admin, { action: 'offer.create', storeId: store.id, entityId: id, label: o.title, after: o });
      return id;
    });
    res.status(201).json(await one(id));
  });

  // Partial edit. Inside a mall, changing an approved offer's text, link or start, or moving its end later, sends it
  // back for approval; ending it sooner does not (decided: the mall approved what it shows and for how long at most).
  r.patch('/offers/:id', async (req, res) => {
    const old = await findOffer(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const before = formOf(old);
    const next = validOffer({ ...before, ...Object.fromEntries(Object.entries(body).filter(([k]) => EDITABLE.includes(k))) });
    await checkLink(db, { id: old.store_id, organization_id: old.organization_id }, next);
    const d = diff(before, next);
    if (d) {
      const shorter = Object.keys(d.after).every((k) => k === 'ends_on') && next.ends_on < before.ends_on;
      const review = old.status === 'approved' && old.store_mall && !shorter;
      await db.transaction(async (trx) => {
        await trx('offers').where({ id: old.id }).update({ ...columns(next), ...(review && { status: 'submitted', mall_id: old.store_mall, reviewed_at: null }), updated_at: trx.fn.now() });
        await audit(trx, req.admin, { action: 'offer.update', storeId: old.store_id, entityId: old.id, label: next.title,
          before: { ...d.before, ...(review && { status: old.status }) }, after: { ...d.after, ...(review && { status: 'submitted' }) } });
      });
    }
    res.json(await one(old.id));
  });

  // Draft, rejected or approved → submitted (in a mall) or approved (no mall). Needs a picture: it is a kiosk slide.
  r.post('/offers/:id/submit', async (req, res) => {
    const o = await findOffer(req);
    if (o.status === 'submitted') throw fail(409, 'err.offer_state');
    if (!o.image_url) throw fail(400, 'err.offer_image');
    const status = o.store_mall ? 'submitted' : 'approved';
    await db.transaction(async (trx) => {
      await trx('offers').where({ id: o.id }).update({ status, mall_id: o.store_mall ?? null, reject_reason: null, reviewed_at: null, updated_at: trx.fn.now() });
      await audit(trx, req.admin, { action: 'offer.submit', storeId: o.store_id, entityId: o.id, label: o.title, before: { status: o.status }, after: { status } });
    });
    res.json(await one(o.id));
  });

  r.delete('/offers/:id', async (req, res) => {
    const o = await findOffer(req);
    await db.transaction(async (trx) => {
      await trx('offer_stats').where({ offer_id: o.id }).del();
      await trx('offers').where({ id: o.id }).del();
      await audit(trx, req.admin, { action: 'offer.delete', storeId: o.store_id, entityId: o.id, label: o.title, before: { ...formOf(o), status: o.status } });
    });
    await removeImage(o.image_url);
    res.status(204).end();
  });

  // The picture: raw body ≤ 2 MB, type from the magic bytes only (JPEG/PNG/WebP, never SVG), a random file name under
  // /uploads/offers/. It can be replaced, not removed (a submitted offer needs one). A new picture on an approved offer
  // inside a mall sends it back for approval.
  r.post('/offers/:id/image', express.raw({ type: () => true, limit: '2mb' }), async (req, res) => {
    const o = await findOffer(req);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ext = imageExt(buf);
    if (!ext) throw fail(400, 'err.image_type');
    const file = `${o.id}-${randomBytes(8).toString('hex')}.${ext}`;
    await mkdir(imageDir, { recursive: true });
    await writeFile(path.join(imageDir, file), buf);
    const image_url = `/uploads/offers/${file}`;
    const review = o.status === 'approved' && o.store_mall;
    await db.transaction(async (trx) => {
      await trx('offers').where({ id: o.id }).update({ image_url, ...(review && { status: 'submitted', mall_id: o.store_mall, reviewed_at: null }), updated_at: trx.fn.now() });
      await audit(trx, req.admin, { action: 'offer.image', storeId: o.store_id, entityId: o.id, label: o.title,
        before: { image_url: o.image_url ?? null, ...(review && { status: o.status }) }, after: { image_url, ...(review && { status: 'submitted' }) } });
    });
    await removeImage(o.image_url);
    res.json(await one(o.id));
  });

  async function removeImage(url) {
    if (!url?.startsWith('/uploads/offers/')) return;
    await unlink(path.join(imageDir, path.basename(url))).catch((err) => err.code === 'ENOENT' || console.error(err));
  }

  // ---------- The mall admin: only offers submitted to their own mall by shops still in it (no mall id in the paths)

  const mallList = (admin) => list().where('o.mall_id', admin.mall_id).where('st.mall_id', admin.mall_id).whereNot('o.status', 'draft');
  async function mallOffer(req) {
    if (req.admin.role !== 'mall' || !req.admin.mall_id) throw fail(403, 'err.forbidden');
    const id = idOf(req.params.id);
    const o = id ? await mallList(req.admin).where('o.id', id).first() : undefined;
    if (!o) throw fail(404, 'err.not_found');
    return o;
  }

  // → { seconds, offers }: waiting first, then approved in slide order, then rejected.
  r.get('/mall/offers', async (req, res) => {
    if (req.admin.role !== 'mall' || !req.admin.mall_id) throw fail(403, 'err.forbidden');
    const m = await db('malls').where({ id: req.admin.mall_id }).first('slide_seconds');
    const rows = await mallList(req.admin).orderByRaw("case o.status when 'submitted' then 0 when 'approved' then 1 else 2 end").orderBy(['o.sort', 'o.id']);
    res.json({ seconds: m.slide_seconds, offers: (await views(db, rows)).map(({ organization_id, ...o }) => o) });
  });

  // Submitted or rejected → approved (last in the slide order).
  r.post('/mall/offers/:id/approve', async (req, res) => {
    const o = await mallOffer(req);
    if (o.status === 'approved') throw fail(409, 'err.offer_state');
    await db.transaction(async (trx) => {
      const [{ n }] = await trx('offers').where({ mall_id: o.mall_id, status: 'approved' }).max({ n: 'sort' });
      await trx('offers').where({ id: o.id }).update({ status: 'approved', reject_reason: null, sort: (Number(n) || 0) + 1, reviewed_at: iso(Date.now()), updated_at: trx.fn.now() });
      // On the shop's store: its owner sees the decision in their own audit log.
      await audit(trx, req.admin, { action: 'offer.approve', storeId: o.store_id, entityId: o.id, label: o.title, before: { status: o.status }, after: { status: 'approved' } });
    });
    res.json((await views(db, [await list().where('o.id', o.id).first()]))[0]);
  });

  // { reason } (shown to the shop) → rejected. An approved offer can be taken down this way too.
  r.post('/mall/offers/:id/reject', async (req, res) => {
    const o = await mallOffer(req);
    if (o.status === 'rejected') throw fail(409, 'err.offer_state');
    const reason = text(req.body?.reason, OFFER_TEXT.reason, 'field.offer_reason', true);
    await db.transaction(async (trx) => {
      await trx('offers').where({ id: o.id }).update({ status: 'rejected', reject_reason: reason, reviewed_at: iso(Date.now()), updated_at: trx.fn.now() });
      await audit(trx, req.admin, { action: 'offer.reject', storeId: o.store_id, entityId: o.id, label: o.title, before: { status: o.status }, after: { status: 'rejected', reject_reason: reason } });
    });
    res.json((await views(db, [await list().where('o.id', o.id).first()]))[0]);
  });

  // { seconds?: 4–30, order?: [approved offer ids of this mall, first slide first] }.
  r.patch('/mall/slides', async (req, res) => {
    if (req.admin.role !== 'mall' || !req.admin.mall_id) throw fail(403, 'err.forbidden');
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const m = await db('malls').where({ id: req.admin.mall_id }).first('id', 'name', 'slide_seconds');
    const seconds = b.seconds === undefined ? m.slide_seconds : b.seconds;
    if (!Number.isInteger(seconds) || seconds < SLIDE_SECONDS.min || seconds > SLIDE_SECONDS.max) throw fail(400, 'err.invalid', { field: 'field.slide_seconds' });
    const approved = await mallList(req.admin).where('o.status', 'approved').orderBy(['o.sort', 'o.id']).select('o.id');
    const was = approved.map((o) => o.id);
    let order = was;
    if (b.order !== undefined) {
      if (!Array.isArray(b.order) || b.order.length > was.length || new Set(b.order).size !== b.order.length || !b.order.every((id) => was.includes(id))) {
        throw fail(400, 'err.invalid', { field: 'field.slide_order' });
      }
      order = [...b.order, ...was.filter((id) => !b.order.includes(id))]; // ones left out keep their order after them
    }
    const d = diff({ seconds: m.slide_seconds, order: was }, { seconds, order });
    if (d) {
      await db.transaction(async (trx) => {
        await trx('malls').where({ id: m.id }).update({ slide_seconds: seconds, updated_at: trx.fn.now() });
        for (const [i, id] of order.entries()) await trx('offers').where({ id }).update({ sort: i + 1 });
        await audit(trx, req.admin, { action: 'mall.slides', entityId: m.id, label: m.name, ...d });
      });
    }
    res.json({ seconds, order });
  });
}

// ---------- Public

// What a customer screen gets: the texts, the picture, the shop's place, a promo code the shop chose to show, and an
// item to open only while it is shown and in stock (else the offer opens the shop).
async function publicOffers(db, rows) {
  const codes = await db('promo_codes').whereIn('id', rows.map((o) => o.promo_code_id).filter(Boolean)).where({ active: true })
    .where((w) => w.whereNull('ends_at').orWhere('ends_at', '>', iso(Date.now()))).select('id', 'code');
  const items = await visible(db('products as p')).whereIn('p.id', rows.map((o) => o.product_id).filter(Boolean)).whereExists(inStock(db)).select('p.id');
  return rows.map((o) => ({
    id: o.id, title: o.title, title_ru: o.title_ru, body: o.body ?? null, body_ru: o.body_ru ?? null, image_url: o.image_url ?? null,
    store: { id: o.store_id, name: o.store_name, floor: o.floor ?? null, unit: o.unit ?? null },
    code: codes.find((c) => c.id === o.promo_code_id)?.code ?? null,
    item_id: items.some((p) => p.id === o.product_id) ? o.product_id : null,
  }));
}
const publicList = (db) => db('offers as o').join('stores as st', 'st.id', 'o.store_id')
  .select('o.id', 'o.title', 'o.title_ru', 'o.body', 'o.body_ru', 'o.image_url', 'o.promo_code_id', 'o.product_id', 'o.store_id', 'st.name as store_name', 'st.mall_floor as floor', 'st.mall_unit as unit');

// The mall screen's "Aksiyalar" and the idle slides: approved, inside their dates, of shown shops still in this mall.
export async function mallOffers(db, mallId) {
  const rows = await live(publicList(db)).where({ 'o.mall_id': mallId, 'o.status': 'approved', 'st.mall_id': mallId, 'st.mall_hidden': false }).orderBy(['o.sort', 'o.id']);
  return publicOffers(db, rows);
}
// A shop's own start screen: its offers inside their dates, waiting for the mall or approved (no approval needed here).
export async function storeOffers(db, storeId) {
  const rows = await live(publicList(db)).where('o.store_id', storeId).whereIn('o.status', SHOP_LIVE).orderBy('o.id', 'desc').limit(10);
  return publicOffers(db, rows);
}

// POST /api/offers/events { shown?: [ids], tapped?: id } → 204. Counts only (no customer, device or IP stored), only
// for offers live somewhere, each at most once per IP every 30 s, behind the app's per-IP bucket.
export function createOfferRouter(db, { now = Date.now } = {}) {
  const r = express.Router();
  const seen = new Map(); // `${ip}|${kind}|${id}` → last counted (ms). shortcut: per process, like the rate buckets
  r.post('/events', async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const shown = b.shown ?? [];
    const tapped = b.tapped ?? null;
    const ok = (v) => Number.isInteger(v) && v > 0 && v <= 2147483647;
    if (!Array.isArray(shown) || shown.length > EVENT_IDS_MAX || !shown.every(ok) || (tapped !== null && !ok(tapped))) throw fail(400, 'err.invalid', { field: 'field.offer' });
    const t = now();
    if (seen.size > 50_000) for (const [k, at] of seen) if (t - at >= COOLDOWN_MS) seen.delete(k);
    const fresh = (kind, id) => {
      const k = `${req.ip}|${kind}|${id}`;
      if (t - (seen.get(k) ?? -Infinity) < COOLDOWN_MS) return false;
      seen.set(k, t);
      return true;
    };
    const ids = [...new Set([...shown, ...(tapped ? [tapped] : [])])];
    const liveIds = ids.length ? (await live(db('offers as o'), t).whereIn('o.id', ids).whereIn('o.status', SHOP_LIVE).select('o.id')).map((o) => o.id) : [];
    const day = dayKey(t);
    for (const [kind, list] of [['shown', [...new Set(shown)]], ['tapped', tapped ? [tapped] : []]]) {
      for (const id of list.filter((x) => liveIds.includes(x) && fresh(kind, x))) {
        await db('offer_stats').insert({ offer_id: id, day, [kind]: 1 }).onConflict(['offer_id', 'day']).merge({ [kind]: db.raw(`offer_stats.${kind} + 1`) });
      }
    }
    res.status(204).end();
  });
  return r;
}
