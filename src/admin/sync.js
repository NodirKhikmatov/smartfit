// Stock sync API (task 20): a store's POS or ERP pushes on-hand quantities by SKU + size.
// POST /api/sync/stock, Authorization: Bearer sfk_…, body { items: [{ sku, size, quantity }] } → { updated, unchanged }.
// The key decides the store; a batch is all-or-nothing; a quantity below what carts hold is refused per row.
import express from 'express';
import { createHash } from 'node:crypto';
import { fail, langOf, errorBody } from './routes.js';
import { sizesOf } from '../db/seed.js';
import { audit } from './audit.js';
import { mayDo } from '../plans.js';

export const SYNC_MAX_ITEMS = 1000;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const KEY = /^sfk_[A-Za-z0-9_-]{32}$/;

export function createSyncRouter(db) {
  const r = express.Router();

  r.use(async (req, res, next) => {
    const auth = req.get('authorization') || '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const k = KEY.test(key) ? await db('sync_keys').where({ key_hash: sha256(key) }).whereNull('revoked_at').first() : undefined;
    if (!k) throw fail(401, 'err.sync_key');
    // Task 45: a read-only organisation's POS can't push stock either (it is a write like any other).
    await mayDo(db, (await db('stores').where({ id: k.store_id }).first('organization_id'))?.organization_id, 'write');
    req.syncKey = k;
    next();
  });

  r.post('/stock', async (req, res) => {
    const items = req.body?.items;
    if (!Array.isArray(items) || !items.length) throw fail(400, 'err.invalid', { field: 'items' });
    if (items.length > SYNC_MAX_ITEMS) throw fail(400, 'err.sync_too_many', { max: SYNC_MAX_ITEMS });
    const key = req.syncKey, lang = langOf(req);
    const errors = [], seen = new Set(), before = {}, after = {};
    let updated = 0, unchanged = 0;
    const rollback = new Error('sync rollback');
    try {
      await db.transaction(async (trx) => {
        for (const [index, it] of items.entries()) {
          const sku = typeof it?.sku === 'string' ? it.sku.trim() : '';
          const size = typeof it?.size === 'string' ? it.size.trim().toUpperCase() : '';
          const { quantity } = it ?? {};
          const row = (err) => errors.push({ index, sku: sku.slice(0, 40), size: size.slice(0, 10), ...errorBody(lang, err) });
          if (!sku || sku.length > 40 || !size) { row(fail(400, 'err.invalid', { field: 'sku/size' })); continue; }
          if (!Number.isInteger(quantity) || quantity < 0 || quantity > 100000) { row(fail(400, 'err.invalid_qty', { size })); continue; }
          if (seen.has(`${sku}\n${size}`)) { row(fail(400, 'err.sync_dup')); continue; }
          seen.add(`${sku}\n${size}`);
          // The key's store only: another store's SKU is simply unknown here.
          const p = await trx('products').where({ store_id: key.store_id, sku }).first('id', 'category', 'sizes');
          if (!p) { row(fail(400, 'err.sync_sku', { sku })); continue; }
          if (!sizesOf(p).includes(size)) { row(fail(400, 'err.bad_size', { size })); continue; }
          const cur = await trx('product_stock').where({ product_id: p.id, size }).first();
          if (cur?.quantity === quantity) { unchanged++; continue; }
          // Conditional on reserved, so a cart hold that lands meanwhile can't be pushed under (the CHECK would 500).
          const n = cur
            ? await trx('product_stock').where({ id: cur.id }).where('reserved', '<=', quantity).update({ quantity })
            : (await trx('product_stock').insert({ product_id: p.id, size, quantity }), 1);
          if (!n) {
            const { reserved } = await trx('product_stock').where({ id: cur.id }).first('reserved');
            row(fail(409, 'err.size_reserved', { size, n: reserved }));
            continue;
          }
          before[`${sku} ${size}`] = cur?.quantity ?? 0;
          after[`${sku} ${size}`] = quantity;
          updated++;
        }
        if (errors.length) throw rollback;
        // One audit row per sync that changed something (a POS polling every minute with no news writes nothing).
        if (updated) await audit(trx, { id: null, email: `API: ${key.name}` }, { action: 'stock.sync', storeId: key.store_id, entityId: key.id, label: key.name, before, after });
        await trx('sync_keys').where({ id: key.id }).update({ last_used_at: new Date().toISOString() });
      });
    } catch (err) {
      if (err !== rollback) throw err;
      return res.status(400).json({ ...errorBody(lang, fail(400, 'err.sync_rows', { n: errors.length })), errors: errors.slice(0, 100) });
    }
    res.json({ updated, unchanged });
  });

  return r;
}
