// Task 37: shopping malls. Super creates malls and their admins; a mall admin runs the mall's profile, the shops'
// directory entries (floor, unit, logo, shown or hidden) and shop invites, and sees per-shop summary numbers only.
// A shop's products, prices, orders, customers, team and settings stay the shop's: the mall role passes only
// MALL_ROUTES (routes.js) and has no store scope at all. Public: the mall screen's directory and search.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fail, text, imageExt, DAY_MS, msOf } from './routes.js';
import { createInvite } from './settings.js';
import { audit, diff } from './audit.js';
import { builtinRows } from '../db/migrations/023_categories.js';
import { qrSvg, publicBase } from '../qr.js';
import { stamp } from '../cart/cart.js';
import { dbTime } from '../recommend/routes.js';
import { visible } from '../recommend/engine.js';
import { COLS, inStock, genders, withSizes, audienceOf } from '../catalog.js';
import { ONLINE_MS } from '../kiosk.js';
import { mallOffers } from './offers.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MALL_COLS = ['id', 'name', 'city', 'address', 'lat', 'lon', 'logo_url'];
export const MALL_SHOPS_MAX = 500; // shops (organisations) one mall may invite: a typo loop can't fill the table
const SEARCH_MAX = 60; // shortcut: one page of search results; add paging when malls get that big
const iso = (ms) => new Date(ms).toISOString();
// A path id that fits an integer column (a longer one would be a database error on Postgres, not a 404).
const idOf = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : 0);

const superOnly = (admin) => {
  if (admin.role !== 'super') throw fail(403, 'err.forbidden');
};
const mallOnly = (admin) => {
  if (admin.role !== 'mall' || !admin.mall_id) throw fail(403, 'err.forbidden');
};
const emailOf = (v) => {
  const email = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 200) throw fail(400, 'err.invalid', { field: 'field.email' });
  return email;
};

// Mall profile (create, or the current row merged with a partial edit). The map point is optional: both or neither.
function validMall(b) {
  const num = (v, min, max) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw fail(400, 'err.invalid', { field: 'field.map_point' });
    return n;
  };
  const none = (v) => v == null || v === '';
  if (none(b.lat) !== none(b.lon)) throw fail(400, 'err.invalid', { field: 'field.map_point' });
  return {
    name: text(b.name, 120, 'field.mall_name', true),
    city: text(b.city, 80, 'field.city', true),
    address: text(b.address, 200, 'field.address', true),
    lat: none(b.lat) ? null : num(b.lat, -90, 90),
    lon: none(b.lon) ? null : num(b.lon, -180, 180),
  };
}
const profileOf = (body, before = {}) => validMall({ ...before, ...Object.fromEntries(Object.entries(body ?? {}).filter(([k]) => ['name', 'city', 'address', 'lat', 'lon'].includes(k))) });

export function mallRoutes(r, db, { uploadDir = 'uploads' } = {}) {
  const imageDir = path.resolve(uploadDir, 'malls');

  // ---------- Super: malls, their shops and their admins

  async function findMall(id) {
    const m = idOf(id) ? await db('malls').where({ id: idOf(id) }).first(MALL_COLS) : undefined;
    if (!m) throw fail(404, 'err.mall_not_found');
    return m;
  }

  r.get('/malls', async (req, res) => {
    superOnly(req.admin);
    const [malls, stores, admins, invites] = await Promise.all([
      db('malls').orderBy('id', 'desc').select(...MALL_COLS, 'created_at'),
      db('stores as s').join('organizations as g', 'g.id', 's.organization_id').whereNotNull('s.mall_id').orderBy('s.name').select('s.id', 's.name', 's.mall_id', 'g.name as org_name'),
      db('admins').where({ role: 'mall' }).orderBy('id').select('id', 'email', 'mall_id', 'disabled_at'),
      db('admin_invites').where({ role: 'mall' }).whereNull('used_at').where('expires_at', '>', iso(Date.now())).select('mall_id').count({ n: '*' }).groupBy('mall_id'),
    ]);
    res.json(malls.map((m) => ({
      ...m, created_at: stamp(m.created_at),
      stores: stores.filter((s) => s.mall_id === m.id).map(({ mall_id, ...s }) => s),
      admins: admins.filter((a) => a.mall_id === m.id).map((a) => ({ id: a.id, email: a.email, disabled: a.disabled_at != null })),
      invites: Number(invites.find((x) => x.mall_id === m.id)?.n ?? 0),
    })));
  });

  // { name, city, address, lat?, lon?, admin_email } → the mall and its admin's one-time link (shown once).
  r.post('/malls', async (req, res) => {
    superOnly(req.admin);
    const m = validMall(req.body ?? {});
    const email = emailOf(req.body?.admin_email);
    const out = await db.transaction(async (trx) => {
      const [{ id }] = await trx('malls').insert(m).returning('id');
      await audit(trx, req.admin, { action: 'mall.create', entityId: id, label: m.name, after: m });
      return { id, ...m, logo_url: null, invite: await createInvite(req, trx, { email, role: 'mall', storeId: null, orgId: null, mallId: id }) };
    });
    res.status(201).json(out);
  });

  // Partial profile edit; store_ids (optional) = the stores in the mall from now on. A store in another mall is a 409:
  // it leaves that one first. A store that leaves loses its floor and unit.
  r.patch('/malls/:id', async (req, res) => {
    superOnly(req.admin);
    const { id, logo_url, ...before } = await findMall(req.params.id);
    const next = profileOf(req.body, before);
    const ids = req.body?.store_ids;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > MALL_SHOPS_MAX || !ids.every((x) => Number.isInteger(x) && x > 0 && x <= 2147483647))) throw fail(400, 'err.invalid', { field: 'field.stores' });
    await db.transaction(async (trx) => {
      const was = (await trx('stores').where({ mall_id: id }).orderBy('id').select('id')).map((s) => s.id);
      let now = was;
      if (ids) {
        now = [...new Set(ids)].sort((a, b) => a - b);
        const rows = await trx('stores').whereIn('id', now).select('id', 'name', 'mall_id');
        if (rows.length !== now.length) throw fail(400, 'err.invalid', { field: 'field.stores' });
        const taken = rows.find((s) => s.mall_id && s.mall_id !== id);
        if (taken) throw fail(409, 'err.store_in_mall', { name: taken.name });
        await trx('stores').where({ mall_id: id }).whereNotIn('id', now).update({ mall_id: null, mall_floor: null, mall_unit: null, mall_hidden: false, updated_at: trx.fn.now() });
        await trx('stores').whereIn('id', now).update({ mall_id: id, updated_at: trx.fn.now() });
      }
      const d = diff({ ...before, stores: was }, { ...next, stores: now });
      if (!d) return;
      await trx('malls').where({ id }).update({ ...next, updated_at: trx.fn.now() });
      await audit(trx, req.admin, { action: 'mall.update', entityId: id, label: next.name, ...d });
    });
    res.json({ id, ...next, logo_url });
  });

  // Only an empty mall goes (its shops leave it first). Its admins and their open links go with it.
  r.delete('/malls/:id', async (req, res) => {
    superOnly(req.admin);
    const m = await findMall(req.params.id);
    await db.transaction(async (trx) => {
      if (await trx('stores').where({ mall_id: m.id }).first('id')) throw fail(409, 'err.mall_in_use');
      const admins = await trx('admins').where({ role: 'mall', mall_id: m.id }).select('email');
      await trx('admin_invites').where({ mall_id: m.id }).del();
      await trx('admins').where({ role: 'mall', mall_id: m.id }).del(); // audit rows keep the email (admin_id is set null)
      await trx('organizations').where({ mall_id: m.id }).update({ mall_id: null });
      await trx('mall_recs').where({ mall_id: m.id }).del(); // task 42: its outfit screens count (no foreign key)
      await trx('malls').where({ id: m.id }).del();
      await audit(trx, req.admin, { action: 'mall.delete', entityId: m.id, label: m.name, before: { ...m, admins: admins.map((a) => a.email) } });
    });
    await removeImage(m.logo_url);
    res.status(204).end();
  });

  // { email } → another admin link for this mall.
  r.post('/malls/:id/invites', async (req, res) => {
    superOnly(req.admin);
    const m = await findMall(req.params.id);
    res.status(201).json(await createInvite(req, db, { email: emailOf(req.body?.email), role: 'mall', storeId: null, orgId: null, mallId: m.id }));
  });

  // ---------- Mall admin: their own mall only (there is no mall id in these paths)

  // ?days=7|30 → the profile, totals, one row per shop (summary numbers only: visits, paid orders count, kiosks online)
  // and the shops invited that have no store yet.
  r.get('/mall', async (req, res) => {
    mallOnly(req.admin);
    const mall = await findMall(req.admin.mall_id);
    const days = req.query.days === '30' ? 30 : 7;
    const now = Date.now(), since = now - days * DAY_MS;
    const shops = await db('stores as s').join('organizations as g', 'g.id', 's.organization_id').where('s.mall_id', mall.id).orderBy('s.name')
      .select('s.id', 's.name', 'g.name as org_name', 's.mall_floor as floor', 's.mall_unit as unit', 's.logo_url', 's.mall_hidden as hidden');
    const ids = shops.map((s) => s.id);
    const [visits, orders, kiosks, pending, [outfits]] = await Promise.all([
      db('funnel_events').whereIn('store_id', ids).where('step', 'start').where('created_at', '>=', dbTime(since))
        .groupByRaw('store_id, case when device is null then 0 else 1 end').select('store_id', db.raw('case when device is null then 0 else 1 end as kiosk')).countDistinct({ n: 'visit' }),
      db('orders').whereIn('store_id', ids).where({ payment_status: 'paid' }).whereNot('status', 'cancelled').where('paid_at', '>=', iso(since))
        .groupBy('store_id').select('store_id').count({ n: '*' }),
      db('kiosks').whereIn('store_id', ids).where('last_seen_at', '>', iso(now - 7 * DAY_MS)).select('store_id', 'last_seen_at'),
      db('organizations as g').where('g.mall_id', mall.id).whereNotExists(db('stores as s').whereRaw('s.organization_id = g.id')).orderBy('g.id', 'desc')
        .select('g.id as organization_id', 'g.name', db('admin_invites as i').whereRaw('i.organization_id = g.id').whereNull('i.used_at').where('i.expires_at', '>', iso(now)).count('*').as('open')),
      // Task 42: "Butun markazdan obraz" results screens (a count only; what was shown stays each shop's).
      db('mall_recs').where({ mall_id: mall.id }).where('created_at', '>=', dbTime(since)).count({ n: '*' }),
    ]);
    const n = (rows, id, kiosk) => Number(rows.find((x) => x.store_id === id && (kiosk === undefined || Number(x.kiosk) === kiosk))?.n ?? 0);
    const rows = shops.map((s) => {
      const k = kiosks.filter((x) => x.store_id === s.id);
      return { ...s, hidden: Boolean(s.hidden), visits: { kiosk: n(visits, s.id, 1), phone: n(visits, s.id, 0) }, orders: n(orders, s.id),
        kiosks: { count: k.length, online: k.filter((x) => now - msOf(x.last_seen_at) < ONLINE_MS).length } };
    });
    const sum = (f) => rows.reduce((a, s) => a + f(s), 0);
    res.json({
      mall, days, shops: rows,
      totals: { shops: rows.length, visits: sum((s) => s.visits.kiosk + s.visits.phone), kiosk_visits: sum((s) => s.visits.kiosk), orders: sum((s) => s.orders), kiosks_online: sum((s) => s.kiosks.online), mall_outfits: Number(outfits.n) },
      pending: pending.map((p) => ({ organization_id: p.organization_id, name: p.name, invite_open: Number(p.open) > 0 })),
    });
  });

  r.patch('/mall', async (req, res) => {
    mallOnly(req.admin);
    const { id, logo_url, ...before } = await findMall(req.admin.mall_id);
    const next = profileOf(req.body, before);
    const d = diff(before, next);
    if (d) {
      await db.transaction(async (trx) => {
        await trx('malls').where({ id }).update({ ...next, updated_at: trx.fn.now() });
        await audit(trx, req.admin, { action: 'mall.update', entityId: id, label: next.name, ...d });
      });
    }
    res.json({ id, ...next, logo_url });
  });

  // The phone link opens the mall screen; the kiosk link is for the mall's own kiosks.
  r.get('/mall/qr', async (req, res) => {
    mallOnly(req.admin);
    const m = await findMall(req.admin.mall_id);
    const url = `${publicBase(req)}/m?mall=${m.id}`;
    res.json({ name: m.name, url, kiosk_url: `${publicBase(req)}/kiosk?mall=${m.id}`, svg: qrSvg(url, 8) });
  });

  // { name, owner_email } → a new shop (organisation) of this mall and its owner's one-time link. The owner makes the
  // store in the wizard, and that first store joins this mall (settings.js, POST /stores).
  r.post('/mall/shops', async (req, res) => {
    mallOnly(req.admin);
    const mall = await findMall(req.admin.mall_id);
    const name = text(req.body?.name, 120, 'field.org_name', true);
    const email = emailOf(req.body?.owner_email);
    if (Number((await db('organizations').where({ mall_id: mall.id }).count({ n: '*' }))[0].n) >= MALL_SHOPS_MAX) throw fail(409, 'err.mall_shops_max', { max: MALL_SHOPS_MAX });
    const out = await db.transaction(async (trx) => {
      const [{ id }] = await trx('organizations').insert({ name, mall_id: mall.id }).returning('id');
      await trx('categories').insert(builtinRows(id)); // task 36: every shop starts with the five built-in categories
      await audit(trx, req.admin, { action: 'org.create', entityId: id, label: name, after: { name, mall: mall.name } });
      return { organization_id: id, name, invite: await createInvite(req, trx, { email, role: 'owner', storeId: null, orgId: id }) };
    });
    res.status(201).json(out);
  });

  // A shop's directory entry: { floor?, unit?, hidden? }. Only a store of this mall (else 404, like any other store).
  async function mallStore(req) {
    const id = idOf(req.params.id);
    const s = id ? await db('stores').where({ id, mall_id: req.admin.mall_id }).first('id', 'name', 'mall_floor', 'mall_unit', 'mall_hidden', 'logo_url') : undefined;
    if (!s) throw fail(404, 'err.store_not_found');
    return s;
  }
  const entryOf = (s) => ({ floor: s.mall_floor ?? null, unit: s.mall_unit ?? null, hidden: Boolean(s.mall_hidden) });

  r.patch('/mall/stores/:id', async (req, res) => {
    mallOnly(req.admin);
    const s = await mallStore(req);
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const before = entryOf(s);
    const next = {
      floor: b.floor === undefined ? before.floor : text(b.floor, 20, 'field.floor', false),
      unit: b.unit === undefined ? before.unit : text(b.unit, 20, 'field.unit', false),
      hidden: b.hidden === undefined ? before.hidden : b.hidden,
    };
    if (typeof next.hidden !== 'boolean') throw fail(400, 'err.invalid', { field: 'field.status' });
    const d = diff(before, next);
    if (d) {
      await db.transaction(async (trx) => {
        await trx('stores').where({ id: s.id }).update({ mall_floor: next.floor, mall_unit: next.unit, mall_hidden: next.hidden, updated_at: trx.fn.now() });
        await audit(trx, req.admin, { action: 'mall.store', storeId: s.id, entityId: s.id, label: s.name, ...d });
      });
    }
    res.json({ id: s.id, name: s.name, ...next, logo_url: s.logo_url ?? null });
  });

  // Logos: same checks as product photos (raw body ≤ 2 MB, type from the magic bytes only), under /uploads/malls/.
  const upload = (handler) => [express.raw({ type: () => true, limit: '2mb' }), async (req, res) => {
    mallOnly(req.admin);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ext = imageExt(buf);
    if (!ext) throw fail(400, 'err.image_type');
    const target = await handler.find(req);
    const file = `${handler.prefix}${target.id}-${randomBytes(8).toString('hex')}.${ext}`;
    await mkdir(imageDir, { recursive: true });
    await writeFile(path.join(imageDir, file), buf);
    const logo_url = `/uploads/malls/${file}`;
    await handler.set(req, target, logo_url);
    res.json({ logo_url });
  }];
  const remove = (handler) => async (req, res) => {
    mallOnly(req.admin);
    await handler.set(req, await handler.find(req), null);
    res.status(204).end();
  };
  const mallLogo = {
    prefix: 'm', find: (req) => findMall(req.admin.mall_id),
    async set(req, m, logo_url) {
      await db.transaction(async (trx) => {
        await trx('malls').where({ id: m.id }).update({ logo_url, updated_at: trx.fn.now() });
        await audit(trx, req.admin, { action: 'mall.logo', entityId: m.id, label: m.name, before: { logo_url: m.logo_url ?? null }, after: { logo_url } });
      });
      await removeImage(m.logo_url);
    },
  };
  const storeLogo = {
    prefix: 's', find: mallStore,
    async set(req, s, logo_url) {
      await db.transaction(async (trx) => {
        await trx('stores').where({ id: s.id }).update({ logo_url, updated_at: trx.fn.now() });
        await audit(trx, req.admin, { action: 'mall.store', storeId: s.id, entityId: s.id, label: s.name, before: { logo_url: s.logo_url ?? null }, after: { logo_url } });
      });
      await removeImage(s.logo_url);
    },
  };
  r.post('/mall/logo', ...upload(mallLogo));
  r.delete('/mall/logo', remove(mallLogo));
  r.post('/mall/stores/:id/logo', ...upload(storeLogo));
  r.delete('/mall/stores/:id/logo', remove(storeLogo));

  async function removeImage(url) {
    if (!url?.startsWith('/uploads/malls/')) return;
    await unlink(path.join(imageDir, path.basename(url))).catch((err) => err.code === 'ENOENT' || console.error(err));
  }
}

// ---------- Public: the mall screen (/kiosk?mall=, /m?mall=). Rate-limited in app.js like the catalogue.
// Only what a shop's own public pages already show (name, shown categories, in-stock items), plus the mall's own
// directory entry (floor, unit, logo). Shops the mall hides are not listed and not searched.
export function createMallRouter(db) {
  const r = express.Router();
  const mallOf = async (id) => {
    const m = idOf(id) ? await db('malls').where({ id: idOf(id) }).first('id', 'name', 'city', 'address', 'logo_url') : undefined;
    if (!m) throw fail(404, 'err.mall_not_found');
    return m;
  };
  const shown = (q, mallId) => q.where('st.mall_id', mallId).where('st.mall_hidden', false);

  // → { id, name, city, address, logo_url, shops: [{ id, name, floor, unit, logo_url, categories: [{ id, name, name_ru, image_url }] }] }
  r.get('/:id', async (req, res) => {
    const m = await mallOf(req.params.id);
    const shops = await shown(db('stores as st'), m.id).orderBy(['st.name', 'st.id']).select('st.id', 'st.name', 'st.mall_floor as floor', 'st.mall_unit as unit', 'st.logo_url', 'st.organization_id');
    const cats = await shown(db('categories as c').join('stores as st', 'st.organization_id', 'c.organization_id'), m.id).where('c.hidden', false)
      .orderBy(['c.sort', 'c.id']).select('st.id as store_id', 'c.id', 'c.name', 'c.name_ru', 'c.image_url');
    res.json({ ...m, shops: shops.map(({ organization_id, ...s }) => ({ ...s, categories: cats.filter((c) => c.store_id === s.id).map(({ store_id, ...c }) => c) })) });
  });

  // Task 43: → { seconds, offers }: the mall's current approved offers in the mall admin's order (the "Aksiyalar"
  // section and the kiosk's idle slides). Asked again each time, so an offer appears and goes on time.
  r.get('/:id/offers', async (req, res) => {
    const m = await mallOf(req.params.id);
    const { slide_seconds } = await db('malls').where({ id: m.id }).first('slide_seconds');
    res.json({ seconds: slide_seconds, offers: await mallOffers(db, m.id) });
  });

  // ?q=<2–60 characters>&gender=male|female&audience=adult|child (task 40; none = adults) → { items }: in-stock items of the mall's shown shops whose name or
  // category matches, each with only the sizes that have free stock and its shop (name, floor, unit).
  r.get('/:id/search', async (req, res) => {
    const m = await mallOf(req.params.id);
    const { q = '', gender = '' } = req.query;
    if (typeof q !== 'string' || q.length > 200 || (gender && !['male', 'female'].includes(gender))) throw fail(400, 'err.invalid', { field: 'field.search' });
    const audience = audienceOf(req.query.audience);
    const term = q.trim();
    if (term.length < 2 || term.length > 60) return res.json({ items: [] });
    // shortcut: SQLite (dev) LIKE ignores case for ASCII only, so a Cyrillic search is case-sensitive there; Postgres ILIKE is fine.
    const like = `%${term}%`;
    const rows = shown(visible(db('products as p')).join('stores as st', 'st.id', 'p.store_id'), m.id).whereExists(inStock(db))
      .where((w) => w.whereILike('p.name', like).orWhereILike('p.name_ru', like).orWhereILike('c.name', like).orWhereILike('c.name_ru', like))
      .orderBy([{ column: 'st.name' }, { column: 'p.id', order: 'desc' }]).limit(SEARCH_MAX)
      .select(...COLS, 'p.store_id', 'st.name as store_name', 'st.mall_floor as floor', 'st.mall_unit as unit');
    if (gender) rows.whereIn('p.gender', genders(gender));
    rows.where('p.audience', audience);
    res.json({ items: await withSizes(db, await rows) });
  });
  return r;
}
