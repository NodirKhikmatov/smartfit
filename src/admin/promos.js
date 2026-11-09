// Task 26: promo codes in admin. An owner makes codes for one store or every store of their organisation; a super-admin
// for any organisation. Managers don't see them (store settings are the owner's). Codes are never deleted, only switched
// off, because orders keep a reference to the code they used.
import { fail, int, canSee } from './routes.js';
import { audit, diff } from './audit.js';
import { CODE, normCode } from '../cart/promo.js';
import { stamp } from '../cart/cart.js';

const TZ_OFFSET = '+05:00'; // Asia/Tashkent, no DST: a code runs from the start of its first day to the end of its last
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PROMOS_MAX = 500; // per organisation
const dayStart = (d) => new Date(`${d}T00:00:00${TZ_OFFSET}`).toISOString();
const tashDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
const EDITABLE = ['store_id', 'kind', 'value', 'min_order', 'starts_on', 'ends_on', 'max_uses', 'max_per_phone', 'active'];

const ownerOrSuper = (admin) => {
  if (admin.role === 'manager') throw fail(403, 'err.forbidden');
};

// A row as the admin form edits it: dates as Tashkent days (ends_on inclusive).
export function promoView(p) {
  return {
    id: p.id, organization_id: p.organization_id, store_id: p.store_id, store_name: p.store_name ?? null, code: p.code, kind: p.kind, value: p.value,
    min_order: p.min_order, max_uses: p.max_uses, max_per_phone: p.max_per_phone, used: p.used, active: Boolean(p.active),
    starts_on: p.starts_at ? tashDay(Date.parse(stamp(p.starts_at))) : null,
    ends_on: p.ends_at ? tashDay(Date.parse(stamp(p.ends_at)) - 1) : null,
  };
}

function validPromo(b) {
  const opt = (v, min, max, field) => (v == null || v === '' ? null : int(v, min, max, field));
  const day = (v, field) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string' || !DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw fail(400, 'err.invalid', { field });
    return v;
  };
  if (!['percent', 'fixed'].includes(b.kind)) throw fail(400, 'err.invalid', { field: 'field.promo_kind' });
  const p = {
    kind: b.kind,
    value: int(b.value, 1, b.kind === 'percent' ? 100 : 1e9, 'field.promo_value'),
    min_order: int(b.min_order ?? 0, 0, 1e9, 'field.promo_min'),
    starts_on: day(b.starts_on, 'field.promo_dates'),
    ends_on: day(b.ends_on, 'field.promo_dates'),
    max_uses: opt(b.max_uses, 1, 1e7, 'field.promo_max_uses'),
    max_per_phone: opt(b.max_per_phone, 1, 1000, 'field.promo_per_phone'),
    active: b.active ?? true,
  };
  if (typeof p.active !== 'boolean') throw fail(400, 'err.invalid', { field: 'field.promo_active' });
  if (p.starts_on && p.ends_on && p.ends_on < p.starts_on) throw fail(400, 'err.invalid', { field: 'field.promo_dates' });
  return p;
}
const columns = ({ starts_on, ends_on, ...p }) => ({
  ...p,
  starts_at: starts_on ? dayStart(starts_on) : null,
  ends_at: ends_on ? new Date(Date.parse(dayStart(ends_on)) + 86_400_000).toISOString() : null,
});

export function promoRoutes(r, db) {
  // Which organisation and store a new code (or an edit) belongs to. Unknown or foreign stores are 404, like elsewhere.
  async function placeOf(req, b, orgId = null) {
    const storeId = b.store_id == null || b.store_id === '' ? null : Number(b.store_id);
    if (storeId !== null) {
      const s = Number.isInteger(storeId) && canSee(req.admin, storeId) ? await db('stores').where({ id: storeId }).first('id', 'organization_id') : undefined;
      if (!s || (orgId && s.organization_id !== orgId)) throw fail(404, 'err.store_not_found');
      return { store_id: s.id, organization_id: s.organization_id };
    }
    if (orgId) return { store_id: null, organization_id: orgId };
    if (req.admin.role !== 'super') return { store_id: null, organization_id: req.admin.organization_id };
    const org = await db('organizations').where({ id: Number(b.organization_id) || 0 }).first('id');
    if (!org) throw fail(400, 'err.invalid', { field: 'field.org' });
    return { store_id: null, organization_id: org.id };
  }
  // The audit row needs a store so the owner's (store-scoped) audit viewer shows it: the code's store, else the org's first.
  const auditStore = async (q, p) => p.store_id ?? (await q('stores').where({ organization_id: p.organization_id }).orderBy('id').first('id'))?.id ?? null;
  const list = () => db('promo_codes as c').leftJoin('stores as s', 's.id', 'c.store_id').select('c.*', 's.name as store_name');
  async function findPromo(req) {
    ownerOrSuper(req.admin);
    const q = list().where('c.id', Number(req.params.id) || 0);
    if (req.admin.role !== 'super') q.where('c.organization_id', req.admin.organization_id);
    const p = await q.first();
    if (!p) throw fail(404, 'err.not_found');
    return p;
  }

  // → [promo], newest first. An owner gets their organisation's codes; a super-admin every one (?organization_id narrows).
  r.get('/promos', async (req, res) => {
    ownerOrSuper(req.admin);
    const q = list().orderBy('c.id', 'desc').limit(PROMOS_MAX);
    if (req.admin.role !== 'super') q.where('c.organization_id', req.admin.organization_id);
    else if (req.query.organization_id) q.where('c.organization_id', Number(req.query.organization_id) || 0);
    res.json((await q).map(promoView));
  });

  r.post('/promos', async (req, res) => {
    ownerOrSuper(req.admin);
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const code = normCode(b.code);
    if (!CODE.test(code)) throw fail(400, 'err.invalid', { field: 'field.promo_code' });
    const place = await placeOf(req, b);
    const p = validPromo(b);
    const [{ n }] = await db('promo_codes').where({ organization_id: place.organization_id }).count({ n: '*' });
    if (Number(n) >= PROMOS_MAX) throw fail(409, 'err.promos_max', { max: PROMOS_MAX });
    if (await db('promo_codes').where({ organization_id: place.organization_id, code }).first('id')) throw fail(409, 'err.promo_taken');
    const id = await db.transaction(async (trx) => {
      const [{ id }] = await trx('promo_codes').insert({ ...place, code, ...columns(p) }).returning('id');
      await audit(trx, req.admin, { action: 'promo.create', storeId: await auditStore(trx, place), entityId: id, label: code, after: { store_id: place.store_id, ...p } });
      return id;
    }).catch((err) => {
      if (/unique|constraint/i.test(err.message) && !err.publicKey) throw fail(409, 'err.promo_taken'); // a parallel create won
      throw err;
    });
    res.status(201).json(promoView(await list().where('c.id', id).first()));
  });

  // Partial edit (the active switch is one): code and organisation stay; the rest is merged and validated as a whole.
  r.patch('/promos/:id', async (req, res) => {
    const old = await findPromo(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const before = Object.fromEntries(EDITABLE.map((k) => [k, promoView(old)[k]]));
    const merged = { ...before, ...Object.fromEntries(Object.entries(body).filter(([k]) => EDITABLE.includes(k))) };
    const place = await placeOf(req, merged, old.organization_id);
    const next = { store_id: place.store_id, ...validPromo(merged) };
    const d = diff(before, next);
    if (d) {
      await db.transaction(async (trx) => {
        await trx('promo_codes').where({ id: old.id }).update({ ...columns(next), updated_at: trx.fn.now() });
        await audit(trx, req.admin, { action: 'promo.update', storeId: await auditStore(trx, { ...old, ...place }), entityId: old.id, label: old.code, ...d });
      });
    }
    res.json(promoView(await list().where('c.id', old.id).first()));
  });
}
