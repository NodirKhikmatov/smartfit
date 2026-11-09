import express from 'express';
import { qrSvg, publicBase } from '../qr.js';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { sizesFor } from '../db/seed.js';
import { parseCsv, toCsv } from './csv.js';
import { hashPassword, verifyPassword, DUMMY_HASH, tokenSecret, signToken, verifyToken } from './auth.js';
import { releaseExpired, markPaid, orderView, nextStatuses, changeStatus, stamp } from '../cart/cart.js';
import { LANGS, errorText, t } from '../../public/shared/i18n.js';
import { dbTime } from '../recommend/routes.js';
import { audit, diff } from './audit.js';
import { kioskStatus } from '../kiosk.js';
import { publicTeamRoutes, settingsRoutes, ROLES } from './settings.js';
import { orgRoutes } from './orgs.js';
import { fitOf } from '../size/size.js';
import { demandItems, funnelStats } from '../demand.js';

export const CATEGORIES = ['outerwear', 'top', 'bottom', 'shoes', 'accessory'];
export const GENDERS = ['male', 'female', 'unisex'];
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;

// Client errors carry a dictionary key ('err.…') and its vars; app.js answers { code, error } in the request's language.
export const fail = (status, key, vars = {}) => Object.assign(new Error(key), { status, publicKey: key, vars });
// The apps send their UI language as Accept-Language (or ?lang=); anything else gets Uzbek.
export const langOf = (req) => (LANGS.includes(req.query?.lang) ? req.query.lang : req.acceptsLanguages(...LANGS) || 'uz');
export const errorBody = (lang, err) => ({ code: err.publicKey.slice(4), error: errorText(lang, err.publicKey, err.vars) });

export const publicAdmin = ({ id, email, role, store_id, organization_id }) => ({ id, email, role, store_id, organization_id });

// Store scope (task 22): admin.stores is null for a super-admin (every store), every store of the organisation for an
// owner, and the one store for a manager. Every admin query that touches store data goes through these two.
export const canSee = (admin, storeId) => admin.stores === null || admin.stores.includes(Number(storeId));
export const inStores = (admin, q, col) => (admin.stores === null ? q : q.whereIn(col, admin.stores));
export async function storesOf(db, admin) {
  if (admin.role === 'super') return null;
  if (admin.role === 'manager') return [admin.store_id];
  return (await db('stores').where({ organization_id: admin.organization_id }).orderBy('id').select('id')).map((s) => s.id);
}

export const text = (v, max, label, required) => {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (required) throw fail(400, 'err.required', { field: label });
    return null;
  }
  if (typeof v !== 'string' || v.trim().length > max) throw fail(400, 'err.invalid', { field: label });
  return v.trim();
};
export const int = (v, min, max, label) => {
  if (!Number.isInteger(v) || v < min || v > max) throw fail(400, 'err.invalid', { field: label });
  return v;
};

// SKU / barcode: letters, digits and . _ - / (no spaces), not starting with a symbol (also keeps CSV formulas out).
export const SKU = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,39}$/;
const code = (v, label) => {
  const c = text(v, 40, label, false);
  if (c !== null && !SKU.test(c)) throw fail(400, 'err.invalid', { field: label });
  return c;
};

// Validates a full product (create, or existing row merged with a partial edit).
function validProduct(b) {
  const p = {
    name: text(b.name, 120, 'field.name', true),
    name_ru: text(b.name_ru, 120, 'field.name_ru', false),
    category: b.category,
    gender: b.gender,
    color: text(b.color, 40, 'field.color', true),
    style: text(b.style, 40, 'field.style', false),
    price: int(b.price, 1, 1e9, 'field.price'),
    discount_price: b.discount_price ?? null,
    temp_min: int(b.temp_min, -60, 60, 'field.temp_min'),
    temp_max: int(b.temp_max, -60, 60, 'field.temp_max'),
    waterproof: b.waterproof ?? false,
    shelf_location: text(b.shelf_location, 40, 'field.shelf_location', false),
    sku: code(b.sku, 'field.sku'),
    barcode: code(b.barcode, 'field.barcode'),
  };
  if (!CATEGORIES.includes(p.category)) throw fail(400, 'err.invalid', { field: 'field.category' });
  if (!GENDERS.includes(p.gender)) throw fail(400, 'err.invalid', { field: 'field.gender' });
  if (p.discount_price !== null) int(p.discount_price, 1, p.price - 1, 'field.discount_price');
  if (p.temp_min > p.temp_max) throw fail(400, 'err.temp_range');
  if (typeof p.waterproof !== 'boolean' && p.waterproof !== 0 && p.waterproof !== 1) throw fail(400, 'err.invalid', { field: 'field.waterproof' });
  p.waterproof = Boolean(p.waterproof);
  return p;
}

// stock = { "M": 3, "L": 0 } → validated entries for this category's sizes.
function validStock(stock, category) {
  if (stock === undefined) return [];
  if (!stock || typeof stock !== 'object' || Array.isArray(stock)) throw fail(400, 'err.invalid', { field: 'field.stock' });
  const sizes = sizesFor(category);
  return Object.entries(stock).map(([size, qty]) => {
    if (!sizes.includes(size)) throw fail(400, 'err.bad_size', { size });
    if (!Number.isInteger(qty) || qty < 0 || qty > 100000) throw fail(400, 'err.invalid_qty', { size });
    return [size, qty];
  });
}

async function applyStock(trx, productId, entries) {
  const current = await trx('product_stock').where({ product_id: productId });
  for (const [size, quantity] of entries) {
    const row = current.find((r) => r.size === size);
    if (row && row.reserved > quantity) throw fail(409, 'err.size_reserved', { size, n: row.reserved });
    await trx('product_stock').insert({ product_id: productId, size, quantity }).onConflict(['product_id', 'size']).merge(['quantity']);
  }
}

// What the audit log keeps of a product: its editable fields, image and stock per size ({ M: 3 }).
async function snapProduct(q, id) {
  const p = await q('products').where({ id }).first();
  const stock = await q('product_stock').where({ product_id: id }).orderBy('id');
  return {
    ...Object.fromEntries(PRODUCT_COLS.map((c) => [c, c === 'waterproof' ? Boolean(p[c]) : p[c] ?? null])),
    image_url: p.image_url ?? null,
    stock: Object.fromEntries(stock.map((s) => [s.size, s.quantity])),
  };
}

// CSV import: one row = one product, stock in one column per size. A filled `id` cell, or else a `sku` already in
// that store, updates that product; other rows create one.
const PRODUCT_COLS = ['sku', 'barcode', 'name', 'name_ru', 'category', 'gender', 'color', 'style', 'price', 'discount_price', 'temp_min', 'temp_max', 'waterproof', 'shelf_location'];
const SIZE_COLS = [...sizesFor('top'), ...sizesFor('shoes'), ...sizesFor('accessory')];
const IMPORT_COLS = ['id', 'store_id', ...PRODUCT_COLS, ...SIZE_COLS];
const TEXT_COLS = ['sku', 'barcode', 'name', 'name_ru', 'color', 'style', 'shelf_location'];
const MAX_IMPORT_ROWS = 2000;
const YES = ['1', 'true', 'ha', 'yes'], NO = ['0', 'false', "yo'q", 'yoq', 'no'];

// Empty cell = empty value. Bad numbers stay strings so validProduct reports them with the field name.
function importCell(col, raw) {
  const v = raw.trim();
  // Spreadsheet formula injection: a cell starting with these runs as a formula when the data is opened in Excel.
  if (TEXT_COLS.includes(col) && /^[=+\-@]/.test(v)) throw fail(400, 'err.csv_formula', { col });
  if (v === '') return null;
  if (TEXT_COLS.includes(col)) return v;
  if (col === 'waterproof') return YES.includes(v.toLowerCase()) ? true : NO.includes(v.toLowerCase()) ? false : v;
  if (col === 'category' || col === 'gender') return v.toLowerCase();
  const n = Number(v.replace(/\s/g, ''));
  return Number.isInteger(n) ? n : v;
}

const IMAGE_TYPES = [
  ['jpg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['webp', (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
];
const STATS_TZ = 'Asia/Tashkent'; // every store is in Uzbekistan (UTC+5, no DST)
export const DAY_MS = 86400000;
export const dayKey = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: STATS_TZ });
export const dayStart = (key) => Date.parse(`${key}T00:00:00+05:00`);
const iso = (ms) => new Date(ms).toISOString(); // paid_at / expires_at are written as ISO strings (cart.js)
// SQLite gives 'YYYY-MM-DD HH:MM:SS' (UTC) strings, Postgres gives Date objects.
export const msOf = (v) => (v instanceof Date ? v.getTime() : Date.parse(`${String(v).replace(' ', 'T')}${String(v).includes('Z') || String(v).includes('+') ? '' : 'Z'}`));

// ?from&to = Tashkent days (YYYY-MM-DD, inclusive) on a created_at column.
export function dateRange(q, col, { from, to }) {
  const day = (v) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(dayStart(v))) throw fail(400, 'err.invalid', { field: 'field.date' });
    return dayStart(v);
  };
  if (from) q.where(col, '>=', dbTime(day(from)));
  if (to) q.where(col, '<', dbTime(day(to) + DAY_MS));
  return q;
}

// List paging: limit 1–100 (default 25), offset ≥ 0. Out-of-range values are clamped, not refused.
export const PAGE_MAX = 100;
export function paging(query) {
  const n = (v) => Number.parseInt(v, 10);
  return { limit: Math.min(Math.max(n(query.limit) || 25, 1), PAGE_MAX), offset: Math.max(n(query.offset) || 0, 0) };
}
// One of a fixed list; empty = the first (default). Anything else is a 400, never SQL.
const pick = (v, allowed, field) => {
  if (v === undefined || v === '') return allowed[0];
  if (!allowed.includes(v)) throw fail(400, 'err.invalid', { field });
  return v;
};
const ORDER_STATUSES = ['new', 'packing', 'shipping', 'delivered', 'cancelled'];
export const RETURN_REASONS = ['too_small', 'too_big', 'disliked', 'defect'];
const EXPORT_MAX = 10000;
// '+998901234567' → '998 90 123 45 67': readable, and Excel keeps it as text (no leading '+', no 12-digit number).
const phoneText = (p) => String(p ?? '').replace(/^\+?998(\d{2})(\d{3})(\d{2})(\d{2})$/, '998 $1 $2 $3 $4');
const PRODUCT_SORT = { created: 'p.id', name: 'p.name', price: 'coalesce(p.discount_price, p.price)', stock: 'coalesce(s.free, 0)' };
// Per product: free units over all sizes, and how many sizes are running out (≤ the store's low_stock_threshold free).
const stockTotals = (db) => db('product_stock as ps').join('products as pp', 'pp.id', 'ps.product_id').join('stores as st', 'st.id', 'pp.store_id')
  .select('ps.product_id')
  .sum({ free: db.raw('ps.quantity - ps.reserved') })
  .sum({ thin: db.raw('case when ps.quantity - ps.reserved <= st.low_stock_threshold then 1 else 0 end') })
  .groupBy('ps.product_id');

export function createAdminRouter(db, { uploadDir = 'uploads' } = {}) {
  const imageDir = path.resolve(uploadDir, 'products');
  const secret = tokenSecret();
  // shortcut: per-process, per-IP lockout map; move to a shared store if we run several instances.
  const fails = new Map();
  // Wrong passwords (login and password change) count per IP: MAX_FAILS within LOCK_MS locks it out for the rest of the window.
  const lock = {
    check(ip) {
      const f = fails.get(ip);
      if (f && f.until > Date.now() && f.count >= MAX_FAILS) throw fail(429, 'err.too_many_attempts');
    },
    miss(ip) {
      const f = fails.get(ip), now = Date.now();
      fails.set(ip, f && f.until > now ? { count: f.count + 1, until: f.until } : { count: 1, until: now + LOCK_MS });
    },
  };
  const r = express.Router();

  r.post('/login', async (req, res) => {
    lock.check(req.ip);
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' && req.body.password.length <= 200 ? req.body.password : '';
    const admin = email ? await db('admins').where({ email }).first() : undefined;
    const ok = (await verifyPassword(password, admin?.password_hash ?? DUMMY_HASH)) && admin && password;
    if (!ok) {
      lock.miss(req.ip);
      throw fail(401, 'err.bad_login');
    }
    fails.delete(req.ip);
    // Said only after the right password, so it reveals nothing to a guesser.
    if (admin.disabled_at) throw fail(403, 'err.account_disabled');
    res.json({ ...signToken(secret, admin.id, Date.now(), admin.token_version), admin: publicAdmin(admin) });
  });

  publicTeamRoutes(r, db, { secret });

  r.use(async (req, res, next) => {
    const auth = req.get('authorization') || '';
    const tok = auth.startsWith('Bearer ') ? verifyToken(secret, auth.slice(7)) : null;
    const admin = tok ? await db('admins').where({ id: tok.sub }).first() : undefined;
    // A disabled admin, or a token from before the last password change / disable, is out at once.
    if (!admin || admin.disabled_at || tok.ver !== admin.token_version) throw fail(401, 'err.login_again');
    admin.stores = await storesOf(db, admin);
    req.admin = admin;
    next();
  });

  // Every product query goes through this: an owner sees their organisation's stores, a manager their own store.
  const scoped = (admin) => inStores(admin, db('products'), 'store_id');

  async function findProduct(req) {
    const id = Number(req.params.id);
    const p = Number.isInteger(id) ? await scoped(req.admin).where({ id }).first() : undefined;
    if (!p) throw fail(404, 'err.product_not_found');
    return p;
  }

  async function withStock(products) {
    const rows = await db('product_stock').whereIn('product_id', products.map((p) => p.id));
    const low = Object.fromEntries((await db('stores').whereIn('id', [...new Set(products.map((p) => p.store_id))]).select('id', 'low_stock_threshold'))
      .map((s) => [s.id, s.low_stock_threshold]));
    const fits = await fitOf(db, products);
    return products.map((p) => {
      const sizes = sizesFor(p.category);
      const stock = rows
        .filter((s) => s.product_id === p.id)
        .sort((a, b) => sizes.indexOf(a.size) - sizes.indexOf(b.size))
        .map(({ size, quantity, reserved }) => ({ size, quantity, reserved }));
      return { ...p, waterproof: Boolean(p.waterproof), low_stock_threshold: low[p.store_id], stock, fit: fits.get(p.id) };
    });
  }

  r.get('/me', (req, res) => res.json(publicAdmin(req.admin)));

  r.get('/stores', async (req, res) => {
    const q = db('stores').select('id', 'name', 'city').orderBy('id');
    res.json(await inStores(req.admin, q, 'id'));
  });

  // QR for the phone app (/m?store=ID), printed and placed next to the kiosk. Built offline as SVG.
  r.get('/stores/:id/qr', async (req, res) => {
    const id = Number(req.params.id);
    if (!canSee(req.admin, id)) throw fail(404, 'err.store_not_found');
    const store = Number.isInteger(id) ? await db('stores').where({ id }).first('id', 'name') : undefined;
    if (!store) throw fail(404, 'err.store_not_found');
    const url = `${publicBase(req)}/m?store=${store.id}`;
    res.json({ name: store.name, url, svg: qrSvg(url, 8) });
  });

  // Paged list: ?q&category&store_id&filter=low|out|no_image&sort=created|name|price|stock&dir=asc|desc&limit&offset
  // → { items, total, limit, offset }. Sort and filter come from fixed lists, so nothing from the query reaches raw SQL.
  r.get('/products', async (req, res) => {
    const { limit, offset } = paging(req.query);
    const sort = pick(req.query.sort, Object.keys(PRODUCT_SORT), 'field.sort');
    const dir = pick(req.query.dir, sort === 'name' ? ['asc', 'desc'] : ['desc', 'asc'], 'field.sort');
    const filter = pick(req.query.filter, ['', 'low', 'out', 'no_image'], 'field.filter');
    const q = db('products as p').leftJoin(stockTotals(db).as('s'), 's.product_id', 'p.id');
    inStores(req.admin, q, 'p.store_id');
    if (req.query.store_id) q.where('p.store_id', Number(req.query.store_id) || 0);
    if (req.query.category) q.where('p.category', String(req.query.category));
    if (req.query.q) {
      // shortcut: SQLite (dev) LIKE ignores case for ASCII only, so a Cyrillic search is case-sensitive there; Postgres ILIKE is fine.
      const like = `%${String(req.query.q).trim().slice(0, 100)}%`;
      q.where((w) => w.whereILike('p.name', like).orWhereILike('p.name_ru', like).orWhereILike('p.sku', like));
    }
    if (filter === 'out') q.whereRaw('coalesce(s.free, 0) = 0');
    if (filter === 'low') q.where('s.thin', '>', 0); // any size at or below the threshold, fully sold-out ones included: the restock list
    if (filter === 'no_image') q.whereNull('p.image_url');
    const [{ n }] = await q.clone().count({ n: '*' });
    const rows = await q.select('p.*').orderByRaw(`${PRODUCT_SORT[sort]} ${dir}, p.id ${dir}`).limit(limit).offset(offset);
    res.json({ items: await withStock(rows), total: Number(n), limit, offset });
  });

  r.get('/products/:id', async (req, res) => {
    const [p] = await withStock([await findProduct(req)]);
    res.json(p);
  });

  // `storeId` undefined = not given. Super-admin must name an existing store; an owner or manager may only name one of
  // theirs, and without one gets their own store (an owner's first one, or the only one).
  async function resolveStore(q, admin, storeId) {
    if (admin.role !== 'super') {
      if (storeId !== undefined && !canSee(admin, storeId)) throw fail(403, 'err.store_forbidden');
      const id = storeId !== undefined ? Number(storeId) : canSee(admin, admin.store_id) ? admin.store_id : admin.stores[0];
      if (!id) throw fail(400, 'err.invalid', { field: 'field.store' }); // an owner who has no store yet
      return id;
    }
    const id = Number(storeId);
    if (storeId === undefined || !Number.isInteger(id) || !(await q('stores').where({ id }).first())) throw fail(400, 'err.invalid', { field: 'field.store' });
    return id;
  }

  // A friendly 409 before the unique index would turn it into a 500.
  async function skuFree(trx, storeId, sku, exceptId = 0) {
    if (sku !== null && (await trx('products').where({ store_id: storeId, sku }).whereNot('id', exceptId).first())) throw fail(409, 'err.sku_taken', { sku });
  }

  async function insertProduct(trx, admin, body) {
    const product = validProduct(body);
    const stock = validStock(body.stock, product.category);
    const storeId = await resolveStore(trx, admin, body.store_id);
    await skuFree(trx, storeId, product.sku);
    const [{ id }] = await trx('products').insert({ ...product, store_id: storeId }).returning('id');
    await trx('product_stock').insert(sizesFor(product.category).map((size) => ({ product_id: id, size, quantity: 0 })));
    await applyStock(trx, id, stock);
    await audit(trx, admin, { action: 'product.create', storeId, entityId: id, label: product.name, after: await snapProduct(trx, id) });
    return id;
  }

  // Partial edit: only the given fields change, plus optional `stock`. store_id cannot change.
  async function updateProduct(trx, existing, body, admin) {
    if (body.store_id !== undefined && Number(body.store_id) !== existing.store_id) throw fail(400, 'err.store_locked');
    const product = validProduct({ ...existing, ...body });
    // Sizes depend on category group; switching group would orphan the stock rows.
    if (sizesFor(product.category) !== sizesFor(existing.category)) throw fail(400, 'err.category_locked');
    const stock = validStock(body.stock, product.category);
    await skuFree(trx, existing.store_id, product.sku, existing.id);
    const before = await snapProduct(trx, existing.id);
    await trx('products').where({ id: existing.id }).update({ ...product, updated_at: trx.fn.now() });
    await applyStock(trx, existing.id, stock);
    const d = diff(before, await snapProduct(trx, existing.id));
    if (d) await audit(trx, admin, { action: 'product.update', storeId: existing.store_id, entityId: existing.id, label: product.name, ...d });
  }

  r.post('/products', async (req, res) => {
    const id = await db.transaction((trx) => insertProduct(trx, req.admin, req.body ?? {}));
    const [p] = await withStock([await db('products').where({ id }).first()]);
    res.status(201).json(p);
  });

  r.patch('/products/:id', async (req, res) => {
    const existing = await findProduct(req);
    await db.transaction((trx) => updateProduct(trx, existing, req.body ?? {}, req.admin));
    const [p] = await withStock([await db('products').where({ id: existing.id }).first()]);
    res.json(p);
  });

  r.delete('/products/:id', async (req, res) => {
    const p = await findProduct(req);
    if (await db('order_items').where({ product_id: p.id }).first()) throw fail(409, 'err.product_in_orders');
    if (await db('product_stock').where({ product_id: p.id }).andWhere('reserved', '>', 0).first()) throw fail(409, 'err.product_in_carts');
    await db.transaction(async (trx) => {
      await audit(trx, req.admin, { action: 'product.delete', storeId: p.store_id, entityId: p.id, label: p.name, before: await snapProduct(trx, p.id) });
      await trx('products').where({ id: p.id }).del();
    });
    await removeImage(p.image_url);
    res.status(204).end();
  });

  // Task 23: the owner's fit override. { offset: -1 (runs big) | 0 (true to size) | 1 (runs small) | null (automatic) }.
  r.patch('/products/:id/fit', async (req, res) => {
    if (req.admin.role === 'manager') throw fail(403, 'err.forbidden');
    const p = await findProduct(req);
    const offset = req.body?.offset ?? null;
    if (offset !== null && ![-1, 0, 1].includes(offset)) throw fail(400, 'err.invalid', { field: 'field.fit_offset' });
    if (p.category === 'accessory') throw fail(400, 'err.invalid', { field: 'field.fit_offset' });
    if ((p.fit_offset ?? null) !== offset) {
      await db.transaction(async (trx) => {
        await trx('products').where({ id: p.id }).update({ fit_offset: offset, updated_at: trx.fn.now() });
        await audit(trx, req.admin, { action: 'product.fit', storeId: p.store_id, entityId: p.id, label: p.name, before: { fit_offset: p.fit_offset ?? null }, after: { fit_offset: offset } });
      });
    }
    const [out] = await withStock([await db('products').where({ id: p.id }).first()]);
    res.json(out);
  });

  // Body is the raw CSV file. All-or-nothing: any bad row rolls back the whole import.
  r.post('/products/import', express.text({ type: () => true, limit: '1mb' }), async (req, res) => {
    if (typeof req.body !== 'string' || !req.body.trim()) throw fail(400, 'err.csv_empty');
    if (req.body.includes('\uFFFD')) throw fail(400, 'err.csv_encoding');
    let rows;
    try {
      rows = parseCsv(req.body);
    } catch {
      throw fail(400, 'err.csv_quote');
    }
    const header = rows.shift().map((h) => h.trim());
    while (header.length && !header.at(-1)) header.pop(); // Excel often adds empty trailing columns
    const cols = header.map((h) => IMPORT_COLS.find((c) => c.toLowerCase() === h.toLowerCase()));
    const unknown = header.filter((h, i) => !cols[i]);
    if (unknown.length) throw fail(400, 'err.csv_unknown', { cols: unknown.join(', ') });
    if (new Set(cols).size !== cols.length) throw fail(400, 'err.csv_dup_col');
    const data = rows.map((cells, i) => ({ line: i + 2, cells })).filter((r) => r.cells.some((c) => c.trim()));
    if (!data.length) throw fail(400, 'err.csv_no_rows');
    if (data.length > MAX_IMPORT_ROWS) throw fail(400, 'err.csv_too_many', { max: MAX_IMPORT_ROWS });

    const errors = [], seenIds = new Set();
    let created = 0, updated = 0;
    const rollback = new Error('import rollback');
    try {
      await db.transaction(async (trx) => {
        for (const { line, cells } of data) {
          try {
            if (cells.slice(cols.length).some((c) => c.trim())) throw fail(400, 'err.csv_extra');
            const body = {}, stock = {};
            let id, storeId = req.query.store_id || undefined; // a row's store_id column wins over ?store_id
            cols.forEach((col, j) => {
              const raw = cells[j] ?? '';
              if (SIZE_COLS.includes(col)) {
                if (raw.trim()) stock[col] = importCell('stock', raw);
              } else if (col === 'id') id = raw.trim() || undefined;
              else if (col === 'store_id') storeId = raw.trim() || undefined;
              else body[col] = importCell(col, raw);
            });
            if (Object.keys(stock).length) body.stock = stock;
            if (storeId !== undefined) body.store_id = storeId;
            // No id: a SKU that already exists in the row's store picks the product to update.
            const bySku = id === undefined && body.sku
              ? await trx('products').where({ store_id: await resolveStore(trx, req.admin, storeId), sku: body.sku }).first() : undefined;
            if (id === undefined && !bySku) {
              seenIds.add(await insertProduct(trx, req.admin, body)); // a later row with the same SKU is a duplicate, not an update
              created++;
            } else {
              const n = bySku ? bySku.id : Number(id);
              const existing = bySku ?? (Number.isInteger(n) ? await scoped(req.admin).transacting(trx).where({ id: n }).first() : undefined);
              if (!existing) throw fail(400, 'err.csv_id_missing', { id });
              if (seenIds.has(n)) throw fail(400, 'err.csv_id_dup', { id: n });
              seenIds.add(n);
              // Update rows: an empty cell keeps the current value, so a stock-only row needs just id + sizes.
              await updateProduct(trx, existing, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null)), req.admin);
              updated++;
            }
          } catch (err) {
            if (!err.publicKey) throw err; // DB errors are bugs, not bad rows
            errors.push({ line, ...errorBody(langOf(req), err) });
          }
        }
        if (errors.length) throw rollback;
      });
    } catch (err) {
      if (err !== rollback) throw err;
      return res.status(400).json({ ...errorBody(langOf(req), fail(400, 'err.csv_rows', { n: errors.length })), errors: errors.slice(0, 100) });
    }
    res.json({ created, updated });
  });

  // Body is the raw image file. The type comes from its magic bytes, never from the client's header or name.
  r.post('/products/:id/image', express.raw({ type: () => true, limit: '2mb' }), async (req, res) => {
    const p = await findProduct(req);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ext = buf.length >= 12 && IMAGE_TYPES.find(([, is]) => is(buf))?.[0];
    if (!ext) throw fail(400, 'err.image_type');
    const file = `${p.id}-${randomBytes(8).toString('hex')}.${ext}`;
    await mkdir(imageDir, { recursive: true });
    await writeFile(path.join(imageDir, file), buf);
    const image_url = `/uploads/products/${file}`;
    await setImage(req, p, image_url);
    res.json({ image_url });
  });

  r.delete('/products/:id/image', async (req, res) => {
    const p = await findProduct(req);
    await setImage(req, p, null);
    res.status(204).end();
  });

  async function setImage(req, p, image_url) {
    await db.transaction(async (trx) => {
      await trx('products').where({ id: p.id }).update({ image_url, updated_at: trx.fn.now() });
      await audit(trx, req.admin, { action: image_url ? 'product.image' : 'product.image_delete', storeId: p.store_id, entityId: p.id, label: p.name,
        before: { image_url: p.image_url }, after: { image_url } });
    });
    await removeImage(p.image_url);
  }

  async function removeImage(url) {
    if (!url?.startsWith('/uploads/products/')) return;
    // The DB change already happened; a leftover file is only wasted disk, so log instead of failing the request.
    await unlink(path.join(imageDir, path.basename(url))).catch((err) => err.code === 'ENOENT' || console.error(err));
  }

  // Orders, store-scoped. Filters: status, payment, store_id, number (the cashier's display-number lookup),
  // q (digits = number or phone, else customer name), from/to (Tashkent days, YYYY-MM-DD, inclusive).
  function ordersQuery(req) {
    const f = req.query;
    const q = db('orders as o').join('stores as s', 's.id', 'o.store_id');
    inStores(req.admin, q, 'o.store_id');
    if (f.store_id) q.where('o.store_id', Number(f.store_id) || 0);
    if (f.status) q.where('o.status', pick(f.status, ORDER_STATUSES, 'field.status'));
    if (f.payment) q.where('o.payment_status', pick(f.payment, ['pending', 'paid', 'cancelled'], 'field.payment'));
    if (f.number) q.where('o.number', Number(f.number) || 0);
    const text = typeof f.q === 'string' ? f.q.trim().slice(0, 80) : '';
    if (/^[\d\s+()-]+$/.test(text) && /\d/.test(text)) {
      // Up to 6 digits is a display number; 7+ is (part of) a phone. Otherwise "5" would match every phone with a 5 in it.
      const digits = text.replace(/\D/g, '');
      if (digits.length <= 6) q.where('o.number', Number(digits));
      else q.where('o.phone', 'like', `%${digits.slice(-12)}%`);
    } else if (text) q.whereILike('o.customer_name', `%${text}%`);
    return dateRange(q, 'o.created_at', f);
  }
  const ORDER_COLS = ['o.id', 'o.number', 'o.store_id', 's.name as store_name', 'o.customer_name', 'o.phone', 'o.fulfillment', 'o.address', 'o.status',
    'o.payment_status', 'o.payment_method', 'o.subtotal', 'o.delivery_fee', 'o.total', 'o.created_at', 'o.expires_at', 'o.telegram_chat_id'];

  // → { items, total, limit, offset }, newest first (dir=asc: oldest first, so the cashier sees the soonest to expire on top).
  r.get('/orders', async (req, res) => {
    await releaseExpired(db);
    const { limit, offset } = paging(req.query);
    const dir = pick(req.query.dir, ['desc', 'asc'], 'field.sort');
    const q = ordersQuery(req);
    const [{ n }] = await q.clone().count({ n: '*' });
    const rows = await q.select(ORDER_COLS).orderBy('o.id', dir).limit(limit).offset(offset);
    res.json({
      items: rows.map(({ telegram_chat_id, created_at, expires_at, ...o }) => ({
        ...o, created_at: stamp(created_at), expires_at: stamp(expires_at),
        pay_ms: o.payment_status === 'pending' && expires_at ? Math.max(0, msOf(expires_at) - Date.now()) : null,
        telegram: telegram_chat_id != null, next: nextStatuses(o),
      })),
      total: Number(n), limit, offset,
    });
  });

  // Same filters as the list, as a CSV file for Excel. Customer-typed text (name, address) is escaped against formulas.
  r.get('/orders/export', async (req, res) => {
    await releaseExpired(db);
    const lang = langOf(req);
    const tr = (key) => t(key, {}, lang);
    // shortcut: one capped query held in memory; stream it if a store ever exports more than this.
    const rows = await ordersQuery(req).select(ORDER_COLS).orderBy('o.id', 'desc').limit(EXPORT_MAX);
    const tashkent = (v) => new Date(msOf(v)).toLocaleString('sv-SE', { timeZone: STATS_TZ }).slice(0, 16);
    const csv = toCsv([
      ['№', tr('adm.orders.time'), tr('common.store'), tr('adm.orders.customer'), tr('adm.csv.phone'), tr('adm.orders.fulfillment'), tr('field.address'),
        tr('adm.csv.subtotal'), tr('adm.csv.fee'), tr('adm.csv.total'), tr('field.payment'), tr('adm.orders.payment'), tr('adm.orders.status')],
      ...rows.map((o) => [o.number, tashkent(o.created_at), o.store_name, o.customer_name, phoneText(o.phone), tr(o.fulfillment === 'pickup' ? 'adm.orders.pickup' : 'adm.orders.delivery'), o.address,
        o.subtotal, o.delivery_fee, o.total, o.payment_method === 'cashier' ? tr('adm.order.cashier') : { click: 'Click', payme: 'Payme' }[o.payment_method] ?? o.payment_method, tr(`adm.pay.${o.payment_status}`),
        tr(o.status === 'delivered' && o.fulfillment === 'pickup' ? 'adm.status.handed' : `adm.status.${o.status}`)]),
    ]);
    res.type('text/csv; charset=utf-8').attachment(`orders-${dayKey(Date.now())}.csv`).send(csv);
  });

  // Unseen-orders badge: how many orders (not cancelled) came in after the last one this admin saw, and the newest id.
  r.get('/orders/unseen', async (req, res) => {
    const q = db('orders').whereNot('status', 'cancelled');
    inStores(req.admin, q, 'store_id');
    const since = Math.max(Number.parseInt(req.query.since, 10) || 0, 0);
    const [{ n }] = await q.clone().where('id', '>', since).count({ n: '*' });
    const [{ latest }] = await q.clone().max({ latest: 'id' });
    res.json({ count: Number(n), latest: latest ?? 0 });
  });

  // Cashier (task 8): look up an order by its number and mark it paid.
  const findOrder = async (req) => {
    await releaseExpired(db);
    const id = Number(req.params.id);
    const q = db('orders').where({ id: Number.isInteger(id) && id > 0 ? id : 0 });
    inStores(req.admin, q, 'store_id');
    const o = await q.first();
    if (!o) throw fail(404, 'err.order_not_found');
    return o;
  };
  const adminView = async (o) => ({
    ...(await orderView(db, o)), telegram: o.telegram_chat_id != null, next: nextStatuses(o),
    can_return: o.payment_status === 'paid' && o.status === 'delivered',
    returns: (await db('order_returns').where({ order_id: o.id }).orderBy('id')
      .select('id', 'order_item_id', 'kind', 'reason', 'quantity', 'refund', 'restock', 'new_size', 'created_at'))
      .map((x) => ({ ...x, restock: Boolean(x.restock), created_at: stamp(x.created_at) })),
  });
  r.get('/orders/:id', async (req, res) => res.json(await adminView(await findOrder(req))));
  // { status }: one step along the flow in nextStatuses. Cancelling releases holds (unpaid) or restocks (paid), once.
  // The customer's Telegram message goes out from the notifier loop, so it can't slow or fail this request.
  r.post('/orders/:id/status', async (req, res) => {
    const o = await findOrder(req);
    const to = req.body?.status;
    if (!ORDER_STATUSES.includes(to)) throw fail(400, 'err.invalid', { field: 'field.status' });
    if (!(await orderStep(req, o, 'order.status', (trx) => changeStatus(trx, o.id, to)))) {
      throw fail(409, o.payment_status === 'pending' && to !== 'cancelled' ? 'err.pay_first' : 'err.status_conflict');
    }
    res.json(await adminView(await db('orders').where({ id: o.id }).first()));
  });
  r.post('/orders/:id/pay', async (req, res) => {
    const o = await findOrder(req);
    if (!(await orderStep(req, o, 'order.pay', (trx) => markPaid(trx, o.id)))) {
      const now = await db('orders').where({ id: o.id }).first('payment_status');
      throw fail(409, now.payment_status === 'paid' ? 'err.already_paid' : 'err.order_expired');
    }
    res.json(await adminView(await db('orders').where({ id: o.id }).first()));
  });
  // Task 23: a return or a size exchange on one line of a delivered order.
  // { key, item_id, kind: return|exchange, reason, quantity, restock, refund? (return; default the full line share), new_size? (exchange) }.
  // `key` is the dialog's one-time id: a double submit finds the first row and changes nothing. Units are claimed with a
  // conditional UPDATE, so returned never passes the line's quantity and stock comes back once.
  r.post('/orders/:id/returns', async (req, res) => {
    const o = await findOrder(req);
    const b = req.body ?? {};
    if (typeof b.key !== 'string' || !/^[a-f0-9]{32}$/.test(b.key)) throw fail(400, 'err.bad_request');
    const done = async () => (await db('order_returns').where({ request_key: b.key }).first('order_id'))?.order_id === o.id;
    if (await done()) return res.json(await adminView(o));
    if (o.payment_status !== 'paid' || o.status !== 'delivered') throw fail(409, 'err.return_not_delivered');
    if (!['return', 'exchange'].includes(b.kind)) throw fail(400, 'err.invalid', { field: 'field.return_kind' });
    if (!RETURN_REASONS.includes(b.reason)) throw fail(400, 'err.invalid', { field: 'field.return_reason' });
    if (typeof b.restock !== 'boolean') throw fail(400, 'err.invalid', { field: 'field.restock' });
    const line = Number.isInteger(b.item_id) ? await db('order_items').where({ id: b.item_id, order_id: o.id }).first() : undefined;
    if (!line) throw fail(404, 'err.not_found');
    const p = await db('products').where({ id: line.product_id }).first('name', 'name_ru', 'category');
    const qty = int(b.quantity, 1, line.quantity, 'field.quantity');
    const refund = b.kind === 'exchange' ? int(b.refund ?? 0, 0, 0, 'field.refund') : int(b.refund ?? qty * line.unit_price, 0, qty * line.unit_price, 'field.refund');
    const newSize = b.kind === 'exchange' ? b.new_size : null;
    if (b.kind === 'exchange' && (!sizesFor(p.category).includes(newSize) || newSize === line.size)) throw fail(400, 'err.invalid', { field: 'field.size' });
    try {
      await db.transaction(async (trx) => {
        // The key row first: a parallel double submit waits on its unique index, then fails and is answered below.
        await trx('order_returns').insert({ order_id: o.id, order_item_id: line.id, store_id: o.store_id, kind: b.kind, reason: b.reason, quantity: qty,
          refund, restock: b.restock, new_size: newSize, request_key: b.key, admin_id: req.admin.id });
        if (!(await trx('order_items').where({ id: line.id }).whereRaw('returned + ? <= quantity', [qty]).increment('returned', qty))) {
          const { returned } = await trx('order_items').where({ id: line.id }).first('returned');
          throw fail(409, 'err.return_too_many', { n: line.quantity - returned });
        }
        if (b.restock) await trx('product_stock').where({ product_id: line.product_id, size: line.size }).increment('quantity', qty);
        // Main rule: the new size must be on the shelf (free stock), and it leaves the shelf now.
        if (newSize && !(await trx('product_stock').where({ product_id: line.product_id, size: newSize }).whereRaw('quantity - reserved >= ?', [qty]).decrement('quantity', qty))) {
          throw fail(409, 'err.out_of_stock', { product: p, size: newSize });
        }
        await audit(trx, req.admin, { action: 'order.return', storeId: o.store_id, entityId: o.id, label: o.number,
          after: { product: p.name, size: line.size, kind: b.kind, reason: b.reason, quantity: qty, refund, restock: b.restock, new_size: newSize } });
      });
    } catch (err) {
      if (!err.publicKey && (await done())) return res.json(await adminView(o)); // lost the race to the same submit
      throw err;
    }
    res.status(201).json(await adminView(await db('orders').where({ id: o.id }).first()));
  });

  // Runs one order change (changeStatus / markPaid nest as a savepoint) and logs it in the same transaction.
  const orderStep = (req, o, action, change) => db.transaction(async (trx) => {
    if (!(await change(trx))) return false;
    const now = await trx('orders').where({ id: o.id }).first('status', 'payment_status');
    await audit(trx, req.admin, { action, storeId: o.store_id, entityId: o.id, label: o.number,
      before: { status: o.status, payment_status: o.payment_status }, after: now });
    return true;
  });

  // Fitting-room requests (task 17): open ones from the last 2 hours, oldest first, with what to bring from which shelf.
  r.get('/fitting', async (req, res) => {
    const q = db('fitting_requests as f').join('stores as s', 's.id', 'f.store_id').where('f.status', 'new')
      .where('f.created_at', '>', dbTime(Date.now() - FITTING_TTL_MS)).orderBy('f.id').limit(50)
      .select('f.id', 'f.store_id', 's.name as store_name', 'f.cabin', 'f.items', 'f.created_at');
    inStores(req.admin, q, 'f.store_id');
    res.json(await fittingView(db, await q));
  });
  r.post('/fitting/:id/done', async (req, res) => {
    const q = db('fitting_requests').where({ id: Number(req.params.id) || 0 });
    inStores(req.admin, q, 'store_id');
    const f = await q.first();
    if (!f) throw fail(404, 'err.not_found');
    await db.transaction(async (trx) => {
      if (!(await trx('fitting_requests').where({ id: f.id, status: 'new' }).update({ status: 'done' }))) return; // already done: nothing changed
      await audit(trx, req.admin, { action: 'fitting.done', storeId: f.store_id, entityId: f.id, label: f.cabin, before: { status: 'new' }, after: { status: 'done' } });
    });
    res.status(204).end();
  });

  settingsRoutes(r, db, { secret, lock, resolveStore });
  orgRoutes(r, db);

  // Store scope for the analytics endpoints: a manager is always pinned to their store; ?store_id narrows a super-admin.
  const inScope = (req, q, col = 'store_id') => {
    inStores(req.admin, q, col);
    if (req.query.store_id) q.where(col, Number(req.query.store_id) || 0);
    return q;
  };

  // Recommendations per day (Tashkent time, zero-filled) with paid revenue per day, the pilot funnel, the most-suggested
  // products, and the same funnel for the previous period of equal length (`prev`) for the deltas.
  r.get('/stats', async (req, res) => {
    const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 30, 1), 90);
    const keys = Array.from({ length: days }, (_, i) => dayKey(Date.now() - (days - 1 - i) * DAY_MS));
    const since = dayStart(keys[0]), prevSince = since - days * DAY_MS;
    // shortcut: aggregates in JS over the raw rows; fine for pilot volume, move to SQL GROUP BY if logs reach ~100k/90 days.
    const allLogs = await inScope(req, db('recommendation_logs').select('id', 'product_ids', 'created_at', 'accepted_at', 'tried_at').where('created_at', '>=', dbTime(prevSince)));
    // Pilot: paid orders that weren't cancelled afterwards (a cancelled paid order is a refund).
    const allOrders = await inScope(req, db('orders').select('recommendation_id', 'fulfillment', 'total', 'created_at').where({ payment_status: 'paid' })
      .whereNot('status', 'cancelled').where('created_at', '>=', dbTime(prevSince)));
    const cur = (x) => msOf(x.created_at) >= since;
    const logs = allLogs.filter(cur), orders = allOrders.filter(cur);
    const perDay = Object.fromEntries(keys.map((k) => [k, { count: 0, revenue: 0, orders: 0 }]));
    const counts = new Map();
    for (const log of logs) {
      const k = dayKey(msOf(log.created_at));
      if (k in perDay) perDay[k].count++;
      let ids = log.product_ids;
      try {
        if (typeof ids === 'string') ids = JSON.parse(ids);
      } catch {
        ids = [];
      }
      for (const id of new Set(Array.isArray(ids) ? ids : [])) if (Number.isInteger(id)) counts.set(id, (counts.get(id) || 0) + 1);
    }
    for (const o of orders) {
      const k = dayKey(msOf(o.created_at));
      if (k in perDay) { perDay[k].revenue += o.total; perDay[k].orders++; }
    }
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 10);
    // Logged products may since have been deleted: they come back with name null.
    const names = await scoped(req.admin).whereIn('id', top.map(([id]) => id)).select('id', 'name', 'name_ru', 'category');
    const prevLogs = allLogs.filter((x) => !cur(x)), prevOrders = allOrders.filter((x) => !cur(x));
    res.json({
      days,
      total: logs.length,
      pilot: funnel(logs, orders),
      prev: { total: prevLogs.length, pilot: funnel(prevLogs, prevOrders) },
      per_day: keys.map((day) => ({ day, ...perDay[day] })),
      top: top.map(([product_id, count]) => {
        const p = names.find((x) => x.id === product_id);
        return { product_id, name: p?.name ?? null, name_ru: p?.name_ru ?? null, category: p?.category ?? null, count };
      }),
    });
  });

  // Task 24 "Talab": missed demand by product and size with the restock suggestion, and the funnel by step per day and
  // per kiosk, over the last `days` (7, 14 or 30; 14 by default, the window the restock suggestion is meant for).
  const demandWindow = (req) => {
    const days = [7, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 14;
    const keys = Array.from({ length: days }, (_, i) => dayKey(Date.now() - (days - 1 - i) * DAY_MS));
    return { days, keys, from: dayStart(keys[0]), scope: (q, col) => inScope(req, q, col) };
  };
  r.get('/demand', async (req, res) => {
    const { days, keys, from, scope } = demandWindow(req);
    res.json({ days, items: await demandItems(db, scope, { from }), funnel: await funnelStats(db, scope, { from, keys }) });
  });
  r.get('/demand/export', async (req, res) => {
    const { days, from, scope } = demandWindow(req);
    const lang = langOf(req);
    const tr = (key) => t(key, {}, lang);
    const items = await demandItems(db, scope, { from, limit: EXPORT_MAX });
    const csv = toCsv([
      [tr('adm.demand.product'), tr('field.sku'), tr('common.store'), tr('adm.demand.size'), tr('adm.demand.missed'), tr('adm.demand.sold'), tr('adm.demand.stock'), tr('adm.demand.suggest')],
      ...items.map((x) => [(lang === 'ru' && x.name_ru) || x.name, x.sku, x.store_name, x.size === 'ONE' ? tr('common.size_one') : x.size, x.missed, x.sold, x.stock, x.suggest]),
    ]);
    res.type('text/csv; charset=utf-8').attachment(`talab-${days}d-${dayKey(Date.now())}.csv`).send(csv);
  });

  // Dashboard home: today so far against yesterday up to the same time, the orders that need work now, the best sellers
  // of the last `days` (7 or 30), and products running out of sizes. The chart and the funnel come from /stats.
  r.get('/dashboard', async (req, res) => {
    await releaseExpired(db);
    const days = req.query.days === '30' ? 30 : 7;
    const now = Date.now(), today = dayStart(dayKey(now));
    const paidIn = async (from, to) => {
      const rows = await inScope(req, db('orders').where({ payment_status: 'paid' }).whereNot('status', 'cancelled')
        .where('paid_at', '>=', iso(from)).where('paid_at', '<', iso(to)).select('total'));
      return { revenue: rows.reduce((a, o) => a + o.total, 0), paid: rows.length };
    };
    const recsIn = async (from, to) => Number((await inScope(req, db('recommendation_logs').where('created_at', '>=', dbTime(from))
      .where('created_at', '<', dbTime(to)).count({ n: '*' })))[0].n);
    const [cur, prev, recs, recsPrev] = await Promise.all([paidIn(today, now + 1000), paidIn(today - DAY_MS, now - DAY_MS), recsIn(today, now + 1000), recsIn(today - DAY_MS, now - DAY_MS)]);
    // Work queue: not finished, not cancelled. Unpaid ones wait at the cashier.
    const open = await inScope(req, db('orders').whereIn('status', ['new', 'packing', 'shipping']).whereNot('payment_status', 'cancelled')
      .select('payment_status'));
    const sold = await inScope(req, db('order_items as i').join('orders as o', 'o.id', 'i.order_id').join('products as p', 'p.id', 'i.product_id')
      .where('o.payment_status', 'paid').whereNot('o.status', 'cancelled').where('o.paid_at', '>=', iso(now - days * DAY_MS))
      .groupBy('i.product_id', 'p.name', 'p.name_ru', 'p.category', 'p.image_url')
      .select('i.product_id', 'p.name', 'p.name_ru', 'p.category', 'p.image_url')
      .sum({ units: 'i.quantity' }).sum({ revenue: db.raw('i.quantity * i.unit_price') })
      .orderBy([{ column: 'units', order: 'desc' }, { column: 'i.product_id' }]).limit(5), 'o.store_id');
    // Task 23: units returned or exchanged in the period against units sold in it, and why.
    const since = dbTime(now - days * DAY_MS);
    const reasons = await inScope(req, db('order_returns').where('created_at', '>=', since).groupBy('reason').select('reason')
      .sum({ units: 'quantity' }).sum({ refund: 'refund' }).orderBy([{ column: 'units', order: 'desc' }, { column: 'reason' }]));
    const [{ units: soldUnits }] = await inScope(req, db('order_items as i').join('orders as o', 'o.id', 'i.order_id').where('o.payment_status', 'paid')
      .whereNot('o.status', 'cancelled').where('o.paid_at', '>=', iso(now - days * DAY_MS)).sum({ units: 'i.quantity' }), 'o.store_id');
    const returned = reasons.reduce((a, x) => a + Number(x.units), 0);
    const lowQ = inScope(req, db('products as p').join(stockTotals(db).as('s'), 's.product_id', 'p.id').where('s.thin', '>', 0), 'p.store_id');
    const [{ n: lowTotal }] = await lowQ.clone().count({ n: '*' });
    const low = await lowQ.select('p.*').orderByRaw('case when s.free = 0 then 0 else 1 end, s.thin desc, s.free, p.id').limit(6);
    res.json({
      days,
      today: { ...cur, recs, prev: { ...prev, recs: recsPrev } },
      waiting: { total: open.length, unpaid: open.filter((o) => o.payment_status === 'pending').length },
      top_sold: sold.map((x) => ({ ...x, units: Number(x.units), revenue: Number(x.revenue) })),
      low_stock: { total: Number(lowTotal), items: await withStock(low) },
      kiosks: await kioskStatus(inScope(req, db('kiosks'))),
      returns: { units: returned, sold: Number(soldUnits ?? 0), refund: reasons.reduce((a, x) => a + Number(x.refund), 0),
        reasons: reasons.map((x) => ({ reason: x.reason, units: Number(x.units) })) },
    });
  });

  return r;
}

// Funnel per results screen: shown → accepted (added to cart) → tried on → bought (a paid order from it), plus order totals.
function funnel(logs, orders) {
  const ids = new Set(logs.map((l) => l.id));
  const revenue = orders.reduce((a, o) => a + o.total, 0);
  return {
    shown: logs.length,
    accepted: logs.filter((l) => l.accepted_at != null).length,
    tried: logs.filter((l) => l.tried_at != null).length,
    bought: new Set(orders.map((o) => o.recommendation_id).filter((id) => id != null && ids.has(id))).size,
    orders: orders.length,
    delivery_orders: orders.filter((o) => o.fulfillment === 'delivery').length,
    revenue,
    avg_order: orders.length ? Math.round(revenue / orders.length) : 0,
  };
}

const FITTING_TTL_MS = 2 * 60 * 60 * 1000; // an unanswered request older than this is stale (the customer has left)
// Rows → items with name, category and shelf, for the admin list and the staff Telegram message.
export async function fittingView(db, rows) {
  const parsed = rows.map((r) => ({ ...r, items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items, created_at: stamp(r.created_at) }));
  const ids = [...new Set(parsed.flatMap((r) => r.items.map((i) => i.product_id)))];
  const products = await db('products').whereIn('id', ids).select('id', 'name', 'name_ru', 'category', 'color', 'shelf_location');
  return parsed.map((r) => ({ ...r, items: r.items.map((i) => ({ ...products.find((p) => p.id === i.product_id), size: i.size })) }));
}

// No store and no organisation = super-admin. An owner belongs to an organisation (store optional: their first store,
// made in the onboarding wizard); a manager to one store. With a store, the organisation is that store's.
export async function createAdmin(db, { email, password, storeId = null, orgId = null, role = storeId || orgId ? 'owner' : 'super' }) {
  email = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email');
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new Error('Password must be 8–200 characters');
  if (storeId !== null) {
    const s = Number.isInteger(storeId) && storeId > 0 ? await db('stores').where({ id: storeId }).first('organization_id') : undefined;
    if (!s?.organization_id || (orgId !== null && orgId !== s.organization_id)) throw new Error('Invalid store_id');
    orgId = s.organization_id;
  } else if (orgId !== null && !(Number.isInteger(orgId) && (await db('organizations').where({ id: orgId }).first()))) throw new Error('Invalid organization');
  const ok = role === 'super' ? orgId === null : role === 'owner' ? orgId !== null : role === 'manager' && storeId !== null;
  if (!ok) throw new Error('Invalid role: super has no store; an owner needs an organisation, a manager a store');
  const [{ id }] = await db('admins').insert({ email, password_hash: await hashPassword(password), role, store_id: storeId, organization_id: orgId }).returning('id');
  return id;
}

// The CLI's organisation: the one given, else the only one, else a new one named after the store (a fresh install).
async function orgFor(db, orgId, name) {
  if (orgId != null) {
    if (!(await db('organizations').where({ id: Number(orgId) || 0 }).first())) throw new Error('organization_id: no such organisation');
    return Number(orgId);
  }
  const orgs = await db('organizations').limit(2).select('id');
  if (orgs.length > 1) throw new Error('Several organisations exist: pass organization_id');
  return orgs[0]?.id ?? (await db('organizations').insert({ name: String(name ?? '').trim().slice(0, 120) || 'Smart Fit' }).returning('id'))[0].id;
}

// New store (CLI: npm run store:create). Weather comes from lat/lon; the delivery fee is a flat city fee in so'm,
// free above free_delivery_threshold (empty = never free).
export async function createStore(db, { name, city, lat, lon, address, delivery_fee = 0, free_delivery_threshold = null, orgId }) {
  const str = (v, label) => {
    const s = String(v ?? '').trim();
    if (!s || s.length > 200) throw new Error(`${label}: 1–200 characters`);
    return s;
  };
  const num = (v, min, max, label) => {
    const n = Number(v);
    if (v === '' || v == null || !Number.isFinite(n) || n < min || n > max) throw new Error(`${label}: ${min}…${max}`);
    return n;
  };
  const fee = num(delivery_fee, 0, 1e9, 'delivery_fee');
  const free = free_delivery_threshold === '' || free_delivery_threshold == null ? null : num(free_delivery_threshold, 1, 1e9, 'free_delivery_threshold');
  if (!Number.isInteger(fee) || (free !== null && !Number.isInteger(free))) throw new Error('Prices must be whole numbers');
  const [{ id }] = await db('stores').insert({
    name: str(name, 'name'), city: str(city, 'city'), address: str(address, 'address'),
    lat: num(lat, -90, 90, 'lat'), lon: num(lon, -180, 180, 'lon'), delivery_fee: fee, free_delivery_threshold: free, organization_id: await orgFor(db, orgId, name),
  }).returning('id');
  return id;
}
