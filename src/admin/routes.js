import express from 'express';
import qrcode from 'qrcode-generator';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { sizesFor } from '../db/seed.js';
import { parseCsv } from './csv.js';
import { hashPassword, verifyPassword, DUMMY_HASH, tokenSecret, signToken, verifyToken } from './auth.js';
import { releaseExpired, markPaid, orderView, nextStatuses, changeStatus, stamp } from '../cart/cart.js';

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

// CSV import: one row = one product, stock in one column per size. A filled `id` cell updates that product.
const PRODUCT_COLS = ['name', 'category', 'gender', 'color', 'style', 'price', 'discount_price', 'temp_min', 'temp_max', 'waterproof', 'shelf_location'];
const SIZE_COLS = [...sizesFor('top'), ...sizesFor('shoes'), ...sizesFor('accessory')];
const IMPORT_COLS = ['id', 'store_id', ...PRODUCT_COLS, ...SIZE_COLS];
const TEXT_COLS = ['name', 'color', 'style', 'shelf_location'];
const MAX_IMPORT_ROWS = 2000;
const YES = ['1', 'true', 'ha', 'yes'], NO = ['0', 'false', "yo'q", 'yoq', 'no'];

// Empty cell = empty value. Bad numbers stay strings so validProduct reports them with the field name.
function importCell(col, raw) {
  const v = raw.trim();
  // Spreadsheet formula injection: a cell starting with these runs as a formula when the data is opened in Excel.
  if (TEXT_COLS.includes(col) && /^[=+\-@]/.test(v)) throw fail(400, `${col}: = + - @ belgisi bilan boshlanmasin`);
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
const dayKey = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: STATS_TZ });

export function createAdminRouter(db, { uploadDir = 'uploads' } = {}) {
  const imageDir = path.resolve(uploadDir, 'products');
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

  // QR for the phone app (/m?store=ID), printed and placed next to the kiosk. Built offline as SVG.
  r.get('/stores/:id/qr', async (req, res) => {
    const id = Number(req.params.id);
    if (req.admin.role !== 'super' && id !== req.admin.store_id) throw fail(404, "Do'kon topilmadi");
    const store = Number.isInteger(id) ? await db('stores').where({ id }).first('id', 'name') : undefined;
    if (!store) throw fail(404, "Do'kon topilmadi");
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const url = `${base}/m?store=${store.id}`;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    res.json({ name: store.name, url, svg: qr.createSvgTag({ cellSize: 8, margin: 4, scalable: true }) });
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

  // `storeId` undefined = not given. Super-admin must name an existing store; a manager may only name their own.
  async function resolveStore(q, admin, storeId) {
    if (admin.role !== 'super') {
      if (storeId !== undefined && Number(storeId) !== admin.store_id) throw fail(403, "Boshqa do'konga ruxsat yo'q");
      return admin.store_id;
    }
    const id = Number(storeId);
    if (storeId === undefined || !Number.isInteger(id) || !(await q('stores').where({ id }).first())) throw fail(400, "Do'kon noto'g'ri");
    return id;
  }

  async function insertProduct(trx, admin, body) {
    const product = validProduct(body);
    const stock = validStock(body.stock, product.category);
    const storeId = await resolveStore(trx, admin, body.store_id);
    const [{ id }] = await trx('products').insert({ ...product, store_id: storeId }).returning('id');
    await trx('product_stock').insert(sizesFor(product.category).map((size) => ({ product_id: id, size, quantity: 0 })));
    await applyStock(trx, id, stock);
    return id;
  }

  // Partial edit: only the given fields change, plus optional `stock`. store_id cannot change.
  async function updateProduct(trx, existing, body) {
    if (body.store_id !== undefined && Number(body.store_id) !== existing.store_id) throw fail(400, "Do'konni o'zgartirib bo'lmaydi");
    const product = validProduct({ ...existing, ...body });
    // Sizes depend on category group; switching group would orphan the stock rows.
    if (sizesFor(product.category) !== sizesFor(existing.category)) throw fail(400, "Bu kategoriyaga o'zgartirib bo'lmaydi (razmerlar boshqa)");
    const stock = validStock(body.stock, product.category);
    await trx('products').where({ id: existing.id }).update({ ...product, updated_at: trx.fn.now() });
    await applyStock(trx, existing.id, stock);
  }

  r.post('/products', async (req, res) => {
    const id = await db.transaction((trx) => insertProduct(trx, req.admin, req.body ?? {}));
    const [p] = await withStock([await db('products').where({ id }).first()]);
    res.status(201).json(p);
  });

  r.patch('/products/:id', async (req, res) => {
    const existing = await findProduct(req);
    await db.transaction((trx) => updateProduct(trx, existing, req.body ?? {}));
    const [p] = await withStock([await db('products').where({ id: existing.id }).first()]);
    res.json(p);
  });

  r.delete('/products/:id', async (req, res) => {
    const p = await findProduct(req);
    if (await db('order_items').where({ product_id: p.id }).first()) throw fail(409, "Bu kiyim buyurtmalarda bor. O'chirish o'rniga qoldiqni 0 qiling");
    if (await db('product_stock').where({ product_id: p.id }).andWhere('reserved', '>', 0).first()) throw fail(409, "Bu kiyim savatlarda band. Keyinroq urining");
    await db('products').where({ id: p.id }).del();
    await removeImage(p.image_url);
    res.status(204).end();
  });

  // Body is the raw CSV file. All-or-nothing: any bad row rolls back the whole import.
  r.post('/products/import', express.text({ type: () => true, limit: '1mb' }), async (req, res) => {
    if (typeof req.body !== 'string' || !req.body.trim()) throw fail(400, 'CSV fayl bo\'sh');
    if (req.body.includes('\uFFFD')) throw fail(400, 'Faylni "CSV UTF-8" formatida saqlang');
    let rows;
    try {
      rows = parseCsv(req.body);
    } catch {
      throw fail(400, 'CSV buzilgan: yopilmagan qo\'shtirnoq');
    }
    const header = rows.shift().map((h) => h.trim());
    while (header.length && !header.at(-1)) header.pop(); // Excel often adds empty trailing columns
    const cols = header.map((h) => IMPORT_COLS.find((c) => c.toLowerCase() === h.toLowerCase()));
    const unknown = header.filter((h, i) => !cols[i]);
    if (unknown.length) throw fail(400, `Noma'lum ustun: ${unknown.join(', ')}`);
    if (new Set(cols).size !== cols.length) throw fail(400, 'Ustun nomi takrorlangan');
    const data = rows.map((cells, i) => ({ line: i + 2, cells })).filter((r) => r.cells.some((c) => c.trim()));
    if (!data.length) throw fail(400, "CSV faylda kiyim yo'q");
    if (data.length > MAX_IMPORT_ROWS) throw fail(400, `Bir faylda ko'pi bilan ${MAX_IMPORT_ROWS} qator`);

    const errors = [], seenIds = new Set();
    let created = 0, updated = 0;
    const rollback = new Error('import rollback');
    try {
      await db.transaction(async (trx) => {
        for (const { line, cells } of data) {
          try {
            if (cells.slice(cols.length).some((c) => c.trim())) throw fail(400, 'Ustunlar soni sarlavhadan ko\'p');
            const body = {}, stock = {};
            let id, storeId;
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
            if (id === undefined) {
              await insertProduct(trx, req.admin, body);
              created++;
            } else {
              const n = Number(id);
              const existing = Number.isInteger(n) ? await scoped(req.admin).transacting(trx).where({ id: n }).first() : undefined;
              if (!existing) throw fail(400, `Kiyim topilmadi: id ${id}`);
              if (seenIds.has(n)) throw fail(400, `id ${n} faylda takrorlangan`);
              seenIds.add(n);
              // Update rows: an empty cell keeps the current value, so a stock-only row needs just id + sizes.
              await updateProduct(trx, existing, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null)));
              updated++;
            }
          } catch (err) {
            if (!err.publicMessage) throw err; // DB errors are bugs, not bad rows
            errors.push({ line, error: err.publicMessage });
          }
        }
        if (errors.length) throw rollback;
      });
    } catch (err) {
      if (err !== rollback) throw err;
      return res.status(400).json({ error: `${errors.length} ta qatorda xato. Hech narsa yuklanmadi`, errors: errors.slice(0, 100) });
    }
    res.json({ created, updated });
  });

  // Body is the raw image file. The type comes from its magic bytes, never from the client's header or name.
  r.post('/products/:id/image', express.raw({ type: () => true, limit: '2mb' }), async (req, res) => {
    const p = await findProduct(req);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ext = buf.length >= 12 && IMAGE_TYPES.find(([, is]) => is(buf))?.[0];
    if (!ext) throw fail(400, 'Faqat JPEG, PNG yoki WebP rasm');
    const file = `${p.id}-${randomBytes(8).toString('hex')}.${ext}`;
    await mkdir(imageDir, { recursive: true });
    await writeFile(path.join(imageDir, file), buf);
    const image_url = `/uploads/products/${file}`;
    await db('products').where({ id: p.id }).update({ image_url, updated_at: db.fn.now() });
    await removeImage(p.image_url);
    res.json({ image_url });
  });

  r.delete('/products/:id/image', async (req, res) => {
    const p = await findProduct(req);
    await db('products').where({ id: p.id }).update({ image_url: null, updated_at: db.fn.now() });
    await removeImage(p.image_url);
    res.status(204).end();
  });

  async function removeImage(url) {
    if (!url?.startsWith('/uploads/products/')) return;
    // The DB change already happened; a leftover file is only wasted disk, so log instead of failing the request.
    await unlink(path.join(imageDir, path.basename(url))).catch((err) => err.code === 'ENOENT' || console.error(err));
  }

  // Orders: newest first, store-scoped, optional status/store filter. Capped; older ones are opened by number.
  r.get('/orders', async (req, res) => {
    await releaseExpired(db);
    const q = db('orders as o').join('stores as s', 's.id', 'o.store_id').orderBy('o.id', 'desc').limit(200)
      .select('o.id', 'o.store_id', 's.name as store_name', 'o.customer_name', 'o.phone', 'o.fulfillment', 'o.status', 'o.payment_status',
        'o.payment_method', 'o.total', 'o.created_at', 'o.telegram_chat_id');
    if (req.admin.role !== 'super') q.where('o.store_id', req.admin.store_id);
    if (req.query.store_id) q.where('o.store_id', Number(req.query.store_id) || 0);
    if (req.query.status) q.where('o.status', String(req.query.status));
    res.json((await q).map(({ telegram_chat_id, created_at, ...o }) => ({
      ...o, created_at: stamp(created_at),
      telegram: telegram_chat_id != null, next: nextStatuses(o),
    })));
  });

  // Cashier (task 8): look up an order by its number and mark it paid.
  const findOrder = async (req) => {
    await releaseExpired(db);
    const id = Number(req.params.id);
    const q = db('orders').where({ id: Number.isInteger(id) && id > 0 ? id : 0 });
    if (req.admin.role !== 'super') q.where('store_id', req.admin.store_id);
    const o = await q.first();
    if (!o) throw fail(404, 'Buyurtma topilmadi');
    return o;
  };
  const adminView = async (o) => ({ ...(await orderView(db, o)), telegram: o.telegram_chat_id != null, next: nextStatuses(o) });
  r.get('/orders/:id', async (req, res) => res.json(await adminView(await findOrder(req))));
  // { status }: one step along the flow in nextStatuses. Cancelling releases holds (unpaid) or restocks (paid), once.
  // The customer's Telegram message goes out from the notifier loop, so it can't slow or fail this request.
  r.post('/orders/:id/status', async (req, res) => {
    const o = await findOrder(req);
    const to = req.body?.status;
    if (!['new', 'packing', 'shipping', 'delivered', 'cancelled'].includes(to)) throw fail(400, "Holat noto'g'ri");
    if (!(await changeStatus(db, o.id, to))) {
      throw fail(409, o.payment_status === 'pending' && to !== 'cancelled' ? "Avval to'lov olinishi kerak" : "Bu holatga o'tkazib bo'lmaydi. Sahifani yangilang");
    }
    res.json(await adminView(await db('orders').where({ id: o.id }).first()));
  });
  r.post('/orders/:id/pay', async (req, res) => {
    const o = await findOrder(req);
    if (!(await markPaid(db, o.id))) {
      const now = await db('orders').where({ id: o.id }).first('payment_status');
      throw fail(409, now.payment_status === 'paid' ? "Bu buyurtma allaqachon to'langan" : "Buyurtma bekor qilingan: 15 daqiqada to'lanmadi");
    }
    res.json(await adminView(await db('orders').where({ id: o.id }).first()));
  });

  // Recommendations per day (Tashkent time, zero-filled) and the most-suggested products.
  r.get('/stats', async (req, res) => {
    const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 30, 1), 90);
    const keys = Array.from({ length: days }, (_, i) => dayKey(Date.now() - (days - 1 - i) * 86400000));
    const since = new Date(`${keys[0]}T00:00:00+05:00`).toISOString().replace('T', ' ').slice(0, 19) + '+00:00';
    // shortcut: aggregates in JS over the raw rows; fine for pilot volume, move to SQL GROUP BY if logs reach ~100k/90 days.
    const inScope = (q, col = 'store_id') => {
      if (req.admin.role !== 'super') q.where(col, req.admin.store_id);
      if (req.query.store_id) q.where(col, Number(req.query.store_id) || 0);
      return q;
    };
    const logs = await inScope(db('recommendation_logs').select('id', 'product_ids', 'created_at', 'accepted_at', 'tried_at').where('created_at', '>=', since));
    // Pilot: paid orders that weren't cancelled afterwards (a cancelled paid order is a refund).
    const orders = await inScope(db('orders').select('recommendation_id', 'fulfillment', 'total').where({ payment_status: 'paid' })
      .whereNot('status', 'cancelled').where('created_at', '>=', since));
    const perDay = Object.fromEntries(keys.map((k) => [k, 0]));
    const counts = new Map();
    for (const log of logs) {
      // SQLite gives 'YYYY-MM-DD HH:MM:SS' (UTC) strings, Postgres gives Date objects.
      const at = log.created_at instanceof Date ? log.created_at : new Date(`${String(log.created_at).replace(' ', 'T')}Z`);
      const k = dayKey(at.getTime());
      if (k in perDay) perDay[k]++;
      let ids = log.product_ids;
      try {
        if (typeof ids === 'string') ids = JSON.parse(ids);
      } catch {
        ids = [];
      }
      for (const id of new Set(Array.isArray(ids) ? ids : [])) if (Number.isInteger(id)) counts.set(id, (counts.get(id) || 0) + 1);
    }
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 10);
    // Logged products may since have been deleted: they come back with name null.
    const names = await scoped(req.admin).whereIn('id', top.map(([id]) => id)).select('id', 'name', 'category');
    const fromRec = orders.filter((o) => o.recommendation_id != null);
    const ids = new Set(logs.map((l) => l.id));
    res.json({
      days,
      total: Object.values(perDay).reduce((a, b) => a + b, 0),
      // Funnel per results screen: shown → accepted (added to cart) → tried on → bought (paid order from it).
      pilot: {
        shown: logs.length,
        accepted: logs.filter((l) => l.accepted_at != null).length,
        tried: logs.filter((l) => l.tried_at != null).length,
        bought: new Set(fromRec.map((o) => o.recommendation_id).filter((id) => ids.has(id))).size,
        orders: orders.length,
        delivery_orders: orders.filter((o) => o.fulfillment === 'delivery').length,
        revenue: orders.reduce((a, o) => a + o.total, 0),
        avg_order: orders.length ? Math.round(orders.reduce((a, o) => a + o.total, 0) / orders.length) : 0,
      },
      per_day: keys.map((day) => ({ day, count: perDay[day] })),
      top: top.map(([product_id, count]) => {
        const p = names.find((x) => x.id === product_id);
        return { product_id, name: p?.name ?? null, category: p?.category ?? null, count };
      }),
    });
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

// New store (CLI: npm run store:create). Weather comes from lat/lon; the delivery fee is a flat city fee in so'm,
// free above free_delivery_threshold (empty = never free).
export async function createStore(db, { name, city, lat, lon, address, delivery_fee = 0, free_delivery_threshold = null }) {
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
  if (!Number.isInteger(fee) || (free !== null && !Number.isInteger(free))) throw new Error("Prices are whole so'm");
  const [{ id }] = await db('stores').insert({
    name: str(name, 'name'), city: str(city, 'city'), address: str(address, 'address'),
    lat: num(lat, -90, 90, 'lat'), lon: num(lon, -180, 180, 'lon'), delivery_fee: fee, free_delivery_threshold: free,
  }).returning('id');
  return id;
}
