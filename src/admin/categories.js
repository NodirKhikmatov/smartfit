// Task 36: each organisation's own categories. Owners (and super) add, rename, reorder, hide, delete and give them a
// role, a size kind and a photo; managers only read the list (the product form). Every query is scoped to the
// caller's organisation; another organisation's category is a 404, like a missing one.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fail, text, int, imageExt } from './routes.js';
import { audit, diff } from './audit.js';
import { sizesFor } from '../db/seed.js';
import { ROLES, SIZE_KINDS, ROLE_KIND } from '../db/migrations/023_categories.js';

export const CATEGORIES_MAX = 100; // per organisation
const SIZES_MAX = 30;
const SIZE = /^[A-Za-z0-9][A-Za-z0-9./-]{0,9}$/; // no comma (the list separator), no spaces, no CSV formula start
const KIND_SIZES = { clothes: sizesFor('top'), shoes: sizesFor('shoes'), one: sizesFor('accessory') };
export const catSizes = (c) => (c.size_kind === 'custom' ? String(c.sizes ?? '').split(',').filter(Boolean) : KIND_SIZES[c.size_kind]);
const EDITABLE = ['name', 'name_ru', 'role', 'size_kind', 'sizes', 'sort', 'hidden'];

export const categoryView = (c) => ({
  id: c.id, organization_id: c.organization_id, name: c.name, name_ru: c.name_ru, image_url: c.image_url ?? null, sort: c.sort,
  hidden: Boolean(c.hidden), role: c.role ?? null, size_kind: c.size_kind, sizes: catSizes(c), products: Number(c.products ?? 0),
});

// A role fixes the size kind (the engine matches the customer's XS–XXL / 36–45 sizes); only a role-less category picks
// its own, including the shop's own list of sizes.
function validCategory(b) {
  const role = b.role ?? null;
  if (role !== null && !ROLES.includes(role)) throw fail(400, 'err.invalid', { field: 'field.cat_role' });
  const size_kind = role ? ROLE_KIND[role] : b.size_kind;
  if (!SIZE_KINDS.includes(size_kind)) throw fail(400, 'err.invalid', { field: 'field.size_kind' });
  let sizes = null;
  if (size_kind === 'custom') {
    const raw = Array.isArray(b.sizes) ? b.sizes : typeof b.sizes === 'string' ? b.sizes.split(/[,;\s]+/) : [];
    const list = raw.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
    if (!list.length || list.length > SIZES_MAX || !list.every((s) => SIZE.test(s)) || new Set(list.map((s) => s.toUpperCase())).size !== list.length) {
      throw fail(400, 'err.invalid', { field: 'field.cat_sizes' });
    }
    sizes = list.join(',');
  }
  const hidden = b.hidden ?? false;
  if (typeof hidden !== 'boolean') throw fail(400, 'err.invalid', { field: 'field.cat_hidden' });
  return { name: text(b.name, 60, 'field.name', true), name_ru: text(b.name_ru, 60, 'field.name_ru', true), role, size_kind, sizes, sort: int(b.sort, 0, 9999, 'field.sort'), hidden };
}

// The category a product body names, which must be one of its store's organisation's. `category_id` wins; else
// `category` is a name (Uzbek or Russian, any case: the CSV column) or a role code (older API clients and CSV files:
// the organisation's first category with that role). Unknown → 400 listing the shop's categories.
export async function categoryFor(q, storeId, b) {
  const store = await q('stores').where({ id: storeId }).first('organization_id');
  const all = await q('categories').where({ organization_id: store?.organization_id ?? 0 }).orderBy(['sort', 'id']);
  let c;
  if (b.category_id != null && b.category_id !== '') c = all.find((x) => x.id === Number(b.category_id));
  else if (typeof b.category === 'string' && b.category.trim()) {
    const v = b.category.trim().toLowerCase();
    c = all.find((x) => x.name.toLowerCase() === v || x.name_ru.toLowerCase() === v) ?? all.find((x) => x.role === v);
  }
  if (!c) {
    if (b.category_id == null && b.category == null) throw fail(400, 'err.required', { field: 'field.category' });
    throw fail(400, 'err.category_unknown', { list: all.map((x) => x.name).join(', ') || '—' });
  }
  return c;
}

const ownerOrSuper = (admin) => {
  if (!['owner', 'super'].includes(admin.role)) throw fail(403, 'err.forbidden');
};

export function categoryRoutes(r, db, { uploadDir = 'uploads' } = {}) {
  const imageDir = path.resolve(uploadDir, 'categories');
  const counted = () => db('categories as c').select('c.*', db('products as p').whereRaw('p.category_id = c.id').count('*').as('products'));
  // The audit row needs a store so the owner's (store-scoped) audit viewer shows it: the organisation's first store.
  const auditStore = async (q, orgId) => (await q('stores').where({ organization_id: orgId }).orderBy('id').first('id'))?.id ?? null;

  async function findCategory(req) {
    const id = Number(req.params.id);
    const q = counted().where('c.id', Number.isInteger(id) ? id : 0);
    if (req.admin.role !== 'super') q.where('c.organization_id', req.admin.organization_id);
    const c = await q.first();
    if (!c) throw fail(404, 'err.not_found');
    return c;
  }

  // Organisation of a new category: the owner's own; a super-admin names it (organization_id, or a store_id of it).
  async function orgOf(req, b) {
    if (req.admin.role !== 'super') return req.admin.organization_id;
    const org = b.store_id != null
      ? (await db('stores').where({ id: Number(b.store_id) || 0 }).first('organization_id'))?.organization_id
      : (await db('organizations').where({ id: Number(b.organization_id) || 0 }).first('id'))?.id;
    if (!org) throw fail(400, 'err.invalid', { field: 'field.org' });
    return org;
  }

  // Names (Uzbek and Russian, any case) are unique within the organisation, so the CSV can find a category by name.
  async function nameFree(q, orgId, c, exceptId = 0) {
    const others = await q('categories').where({ organization_id: orgId }).whereNot('id', exceptId).select('name', 'name_ru');
    const taken = new Set(others.flatMap((x) => [x.name.toLowerCase(), x.name_ru.toLowerCase()]));
    for (const name of [c.name, c.name_ru]) if (taken.has(name.toLowerCase())) throw fail(409, 'err.category_taken', { name });
  }

  // → [category] in the shop's order, with the number of products in each. Owners, managers (product form) and super
  // (?organization_id or ?store_id narrows; none = every organisation's). Staff never get here (task 28 route list).
  r.get('/categories', async (req, res) => {
    const q = counted().orderBy(['c.organization_id', 'c.sort', 'c.id']).limit(1000);
    if (req.admin.role !== 'super') q.where('c.organization_id', req.admin.organization_id);
    else if (req.query.organization_id || req.query.store_id) q.where('c.organization_id', await orgOf(req, req.query));
    res.json((await q).map(categoryView));
  });

  r.post('/categories', async (req, res) => {
    ownerOrSuper(req.admin);
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const orgId = await orgOf(req, b);
    const [{ n, top }] = await db('categories').where({ organization_id: orgId }).count({ n: '*' }).max({ top: 'sort' });
    if (Number(n) >= CATEGORIES_MAX) throw fail(409, 'err.categories_max', { max: CATEGORIES_MAX });
    const c = validCategory({ ...b, sort: b.sort ?? Math.min(9999, Number(top ?? 0) + 1) });
    const id = await db.transaction(async (trx) => {
      await nameFree(trx, orgId, c);
      const [{ id }] = await trx('categories').insert({ ...c, organization_id: orgId }).returning('id');
      await audit(trx, req.admin, { action: 'category.create', storeId: await auditStore(trx, orgId), entityId: id, label: c.name, after: c });
      return id;
    });
    res.status(201).json(categoryView(await counted().where('c.id', id).first()));
  });

  // Partial edit. With products in it, the size list may only grow at the end (new sizes get stock rows at 0), and a
  // role change keeps the same sizes; products follow the role (products.category) in the same transaction.
  r.patch('/categories/:id', async (req, res) => {
    ownerOrSuper(req.admin);
    const old = await findCategory(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const before = Object.fromEntries(EDITABLE.map((k) => [k, k === 'hidden' ? Boolean(old[k]) : old[k] ?? null]));
    const next = validCategory({ ...before, ...Object.fromEntries(Object.entries(body).filter(([k]) => EDITABLE.includes(k))) });
    const was = catSizes(old), now = catSizes(next);
    if (old.products > 0 && !was.every((s, i) => now[i] === s)) throw fail(409, 'err.category_sizes_locked');
    const d = diff(before, next);
    if (d) {
      await db.transaction(async (trx) => {
        await nameFree(trx, old.organization_id, next, old.id);
        await trx('categories').where({ id: old.id }).update({ ...next, updated_at: trx.fn.now() });
        if (old.products > 0 && (next.role !== (old.role ?? null) || now.length !== was.length)) {
          await trx('products').where({ category_id: old.id }).update({ category: next.role, sizes: next.role ? null : now.join(','), updated_at: trx.fn.now() });
          const added = now.slice(was.length);
          const ids = (await trx('products').where({ category_id: old.id }).select('id')).map((p) => p.id);
          for (const size of added) {
            for (const product_id of ids) await trx('product_stock').insert({ product_id, size, quantity: 0 }).onConflict(['product_id', 'size']).ignore();
          }
        }
        await audit(trx, req.admin, { action: 'category.update', storeId: await auditStore(trx, old.organization_id), entityId: old.id, label: next.name, ...d });
      });
    }
    res.json(categoryView(await counted().where('c.id', old.id).first()));
  });

  // A category with products can be hidden, not deleted.
  r.delete('/categories/:id', async (req, res) => {
    ownerOrSuper(req.admin);
    const c = await findCategory(req);
    if (c.products > 0) throw fail(409, 'err.category_in_use', { n: c.products });
    await db.transaction(async (trx) => {
      if (await trx('products').where({ category_id: c.id }).first('id')) throw fail(409, 'err.category_in_use', { n: 1 }); // added meanwhile
      await audit(trx, req.admin, { action: 'category.delete', storeId: await auditStore(trx, c.organization_id), entityId: c.id, label: c.name, before: categoryView(c) });
      await trx('categories').where({ id: c.id }).del();
    });
    await removeImage(c.image_url);
    res.status(204).end();
  });

  // Photo: same checks as product photos (raw body ≤ 2 MB, type from the magic bytes only).
  r.post('/categories/:id/image', express.raw({ type: () => true, limit: '2mb' }), async (req, res) => {
    ownerOrSuper(req.admin);
    const c = await findCategory(req);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ext = imageExt(buf);
    if (!ext) throw fail(400, 'err.image_type');
    const file = `${c.id}-${randomBytes(8).toString('hex')}.${ext}`;
    await mkdir(imageDir, { recursive: true });
    await writeFile(path.join(imageDir, file), buf);
    const image_url = `/uploads/categories/${file}`;
    await setImage(req, c, image_url);
    res.json({ image_url });
  });

  r.delete('/categories/:id/image', async (req, res) => {
    ownerOrSuper(req.admin);
    await setImage(req, await findCategory(req), null);
    res.status(204).end();
  });

  async function setImage(req, c, image_url) {
    await db.transaction(async (trx) => {
      await trx('categories').where({ id: c.id }).update({ image_url, updated_at: trx.fn.now() });
      await audit(trx, req.admin, { action: 'category.image', storeId: await auditStore(trx, c.organization_id), entityId: c.id, label: c.name,
        before: { image_url: c.image_url ?? null }, after: { image_url } });
    });
    await removeImage(c.image_url);
  }

  async function removeImage(url) {
    if (!url?.startsWith('/uploads/categories/')) return;
    await unlink(path.join(imageDir, path.basename(url))).catch((err) => err.code === 'ENOENT' || console.error(err));
  }
}
