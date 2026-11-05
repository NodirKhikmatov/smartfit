import express from 'express';
import { sizesFor } from '../db/seed.js';
import { hashPassword, verifyPassword, DUMMY_HASH, tokenSecret, signToken, verifyToken } from './auth.js';

export const CATEGORIES = ['outerwear', 'top', 'bottom', 'shoes', 'accessory'];
export const GENDERS = ['male', 'female', 'unisex'];
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;

// Errors with publicMessage are shown to the client as-is (see app.js).
export const fail = (status, message) => Object.assign(new Error(message), { status, publicMessage: message });

const publicAdmin = ({ id, email, role, store_id }) => ({ id, email, role, store_id });

const text = (v, max, label, required) => {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (required) throw fail(400, `${label} majburiy`);
    return null;
  }
  if (typeof v !== 'string' || v.trim().length > max) throw fail(400, `${label} noto'g'ri`);
  return v.trim();
};
const int = (v, min, max, label) => {
  if (!Number.isInteger(v) || v < min || v > max) throw fail(400, `${label} noto'g'ri`);
  return v;
};

// Validates a full product (create, or existing row merged with a partial edit).
function validProduct(b) {
  const p = {
    name: text(b.name, 120, 'Nomi', true),
    category: b.category,
    gender: b.gender,
    color: text(b.color, 40, 'Rangi', true),
    style: text(b.style, 40, 'Uslubi', false),
    price: int(b.price, 1, 1e9, 'Narxi'),
    discount_price: b.discount_price ?? null,
    temp_min: int(b.temp_min, -60, 60, 'Min harorat'),
    temp_max: int(b.temp_max, -60, 60, 'Max harorat'),
    waterproof: b.waterproof ?? false,
    shelf_location: text(b.shelf_location, 40, 'Javondagi joyi', false),
  };
  if (!CATEGORIES.includes(p.category)) throw fail(400, "Kategoriya noto'g'ri");
  if (!GENDERS.includes(p.gender)) throw fail(400, "Jins noto'g'ri");
  if (p.discount_price !== null) int(p.discount_price, 1, p.price - 1, 'Chegirmali narx');
  if (p.temp_min > p.temp_max) throw fail(400, 'Min harorat max haroratdan katta');
  if (typeof p.waterproof !== 'boolean' && p.waterproof !== 0 && p.waterproof !== 1) throw fail(400, "Suv o'tkazmasligi noto'g'ri");
  p.waterproof = Boolean(p.waterproof);
  return p;
}

// stock = { "M": 3, "L": 0 } → validated entries for this category's sizes.
function validStock(stock, category) {
  if (stock === undefined) return [];
  if (!stock || typeof stock !== 'object' || Array.isArray(stock)) throw fail(400, "Qoldiq noto'g'ri");
  const sizes = sizesFor(category);
  return Object.entries(stock).map(([size, qty]) => {
    if (!sizes.includes(size)) throw fail(400, `Razmer noto'g'ri: ${size}`);
    return [size, int(qty, 0, 100000, `${size} soni`)];
  });
}

async function applyStock(trx, productId, entries) {
  const current = await trx('product_stock').where({ product_id: productId });
  for (const [size, quantity] of entries) {
    const row = current.find((r) => r.size === size);
    if (row && row.reserved > quantity) throw fail(409, `${size}: ${row.reserved} dona savatlarda band, undan kam qilib bo'lmaydi`);
    await trx('product_stock').insert({ product_id: productId, size, quantity }).onConflict(['product_id', 'size']).merge(['quantity']);
  }
}

export function createAdminRouter(db) {
  const secret = tokenSecret();
  // shortcut: per-process, per-IP lockout map; move to a shared store if we run several instances.
  const fails = new Map();
  const r = express.Router();

  r.post('/login', async (req, res) => {
    const now = Date.now();
    const f = fails.get(req.ip);
    if (f && f.until > now && f.count >= MAX_FAILS) throw fail(429, "Juda ko'p urinish. 15 daqiqadan keyin qayta urining");
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' && req.body.password.length <= 200 ? req.body.password : '';
    const admin = email ? await db('admins').where({ email }).first() : undefined;
    const ok = (await verifyPassword(password, admin?.password_hash ?? DUMMY_HASH)) && admin && password;
    if (!ok) {
      fails.set(req.ip, f && f.until > now ? { count: f.count + 1, until: f.until } : { count: 1, until: now + LOCK_MS });
      throw fail(401, "Email yoki parol noto'g'ri");
    }
    fails.delete(req.ip);
    res.json({ ...signToken(secret, admin.id), admin: publicAdmin(admin) });
  });

  r.use(async (req, res, next) => {
    const auth = req.get('authorization') || '';
    const id = auth.startsWith('Bearer ') ? verifyToken(secret, auth.slice(7)) : null;
    const admin = id ? await db('admins').where({ id }).first() : undefined;
    if (!admin) throw fail(401, 'Qayta kiring');
    req.admin = admin;
    next();
  });

  // Every product query goes through this: a manager only ever sees their own store.
  const scoped = (admin) => (admin.role === 'super' ? db('products') : db('products').where('store_id', admin.store_id));

  async function findProduct(req) {
    const id = Number(req.params.id);
    const p = Number.isInteger(id) ? await scoped(req.admin).where({ id }).first() : undefined;
    if (!p) throw fail(404, 'Kiyim topilmadi');
    return p;
  }

  async function withStock(products) {
    const rows = await db('product_stock').whereIn('product_id', products.map((p) => p.id));
    return products.map((p) => {
      const sizes = sizesFor(p.category);
      const stock = rows
        .filter((s) => s.product_id === p.id)
        .sort((a, b) => sizes.indexOf(a.size) - sizes.indexOf(b.size))
        .map(({ size, quantity, reserved }) => ({ size, quantity, reserved }));
      return { ...p, waterproof: Boolean(p.waterproof), stock };
    });
  }

  r.get('/me', (req, res) => res.json(publicAdmin(req.admin)));

  r.get('/stores', async (req, res) => {
    const q = db('stores').select('id', 'name', 'city').orderBy('id');
    res.json(req.admin.role === 'super' ? await q : await q.where({ id: req.admin.store_id }));
  });

  r.get('/products', async (req, res) => {
    const q = scoped(req.admin).orderBy('id');
    if (req.query.store_id) q.where('store_id', Number(req.query.store_id) || 0);
    if (req.query.category) q.where('category', String(req.query.category));
    if (req.query.q) q.whereILike('name', `%${String(req.query.q).trim()}%`);
    res.json(await withStock(await q));
  });

  r.get('/products/:id', async (req, res) => {
    const [p] = await withStock([await findProduct(req)]);
    res.json(p);
  });

  r.post('/products', async (req, res) => {
    const body = req.body ?? {};
    const product = validProduct(body);
    const stock = validStock(body.stock, product.category);
    let storeId = req.admin.store_id;
    if (req.admin.role === 'super') {
      storeId = Number(body.store_id);
      if (!Number.isInteger(storeId) || !(await db('stores').where({ id: storeId }).first())) throw fail(400, "Do'kon noto'g'ri");
    } else if (body.store_id !== undefined && Number(body.store_id) !== storeId) {
      throw fail(403, "Boshqa do'konga ruxsat yo'q");
    }
    const id = await db.transaction(async (trx) => {
      const [{ id }] = await trx('products').insert({ ...product, store_id: storeId }).returning('id');
      await trx('product_stock').insert(sizesFor(product.category).map((size) => ({ product_id: id, size, quantity: 0 })));
      await applyStock(trx, id, stock);
      return id;
    });
    const [p] = await withStock([await db('products').where({ id }).first()]);
    res.status(201).json(p);
  });

  // Partial edit: send only the fields to change, plus optional `stock`. store_id cannot change.
  r.patch('/products/:id', async (req, res) => {
    const existing = await findProduct(req);
    const body = req.body ?? {};
    if (body.store_id !== undefined && Number(body.store_id) !== existing.store_id) throw fail(400, "Do'konni o'zgartirib bo'lmaydi");
    const product = validProduct({ ...existing, ...body });
    // Sizes depend on category group; switching group would orphan the stock rows.
    if (sizesFor(product.category) !== sizesFor(existing.category)) throw fail(400, "Bu kategoriyaga o'zgartirib bo'lmaydi (razmerlar boshqa)");
    const stock = validStock(body.stock, product.category);
    await db.transaction(async (trx) => {
      await trx('products').where({ id: existing.id }).update({ ...product, updated_at: trx.fn.now() });
      await applyStock(trx, existing.id, stock);
    });
    const [p] = await withStock([await db('products').where({ id: existing.id }).first()]);
    res.json(p);
  });

  r.delete('/products/:id', async (req, res) => {
    const p = await findProduct(req);
    if (await db('order_items').where({ product_id: p.id }).first()) throw fail(409, "Bu kiyim buyurtmalarda bor. O'chirish o'rniga qoldiqni 0 qiling");
    if (await db('product_stock').where({ product_id: p.id }).andWhere('reserved', '>', 0).first()) throw fail(409, "Bu kiyim savatlarda band. Keyinroq urining");
    await db('products').where({ id: p.id }).del();
    res.status(204).end();
  });

  return r;
}

export async function createAdmin(db, { email, password, storeId = null }) {
  email = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email');
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new Error('Password must be 8–200 characters');
  if (storeId !== null && !(Number.isInteger(storeId) && storeId > 0)) throw new Error('Invalid store_id');
  const [{ id }] = await db('admins')
    .insert({ email, password_hash: await hashPassword(password), role: storeId ? 'manager' : 'super', store_id: storeId || null })
    .returning('id');
  return id;
}
