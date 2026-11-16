// Kiosk endpoints (task 21): the heartbeat behind "online / last seen" in admin, and the staff exit PIN check.
import express from 'express';
import { fail } from './admin/routes.js';
import { verifyPassword } from './admin/auth.js';
import { stamp } from './cart/cart.js';
import { mayDo } from './plans.js';

export const KIOSKS_MAX = 20; // per store; rows not seen for a week make room
export const ONLINE_MS = 3 * 60 * 1000; // the kiosk pings every minute
const DEVICE = /^[a-f0-9]{16,32}$/;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const storeOf = async (db, id) => (Number.isInteger(id) && id > 0 ? db('stores').where({ id }).first('id', 'organization_id', 'kiosk_pin_hash') : undefined);

export function createKioskRouter(db) {
  const r = express.Router();

  // { store_id, device } → 204. Unauthenticated (a kiosk has no login), so it only ever writes a timestamp.
  r.post('/ping', async (req, res) => {
    const { store_id, device } = req.body ?? {};
    if (typeof device !== 'string' || !DEVICE.test(device)) throw fail(400, 'err.bad_request');
    const store = await storeOf(db, store_id);
    if (!store) throw fail(404, 'err.store_not_found');
    const now = Date.now();
    if (await db('kiosks').where({ store_id, device }).update({ last_seen_at: iso(now) })) return res.status(204).end();
    await db('kiosks').where({ store_id }).where('last_seen_at', '<', iso(now - WEEK_MS)).del();
    await mayDo(db, store.organization_id, 'kiosks', { now }); // task 45: a kiosk the plan has no room for is not registered (403)
    const [{ n }] = await db('kiosks').where({ store_id }).count({ n: '*' });
    if (Number(n) >= KIOSKS_MAX) throw fail(429, 'err.rate_limited');
    await db('kiosks').insert({ store_id, device, last_seen_at: iso(now) }).onConflict(['store_id', 'device']).merge({ last_seen_at: iso(now) });
    res.status(204).end();
  });

  // { store_id, pin } → 204 when the PIN matches the store's. The kiosk then leaves fullscreen until reloaded.
  r.post('/exit', async (req, res) => {
    const { store_id, pin } = req.body ?? {};
    const store = await storeOf(db, store_id);
    if (!store) throw fail(404, 'err.store_not_found');
    if (!store.kiosk_pin_hash) throw fail(409, 'err.kiosk_pin_unset');
    const ok = await verifyPassword(typeof pin === 'string' ? pin.slice(0, 20) : '', store.kiosk_pin_hash);
    if (!ok) throw fail(403, 'err.bad_pin');
    res.status(204).end();
  });

  return r;
}

// Admin view of a store's kiosks: short id, last seen, online. Newest first.
export async function kioskStatus(q, now = Date.now()) {
  const rows = await q.orderBy('last_seen_at', 'desc').limit(KIOSKS_MAX).select('device', 'store_id', 'last_seen_at');
  return rows.map((k) => {
    const last_seen_at = stamp(k.last_seen_at);
    return { id: k.device.slice(0, 6), store_id: k.store_id, last_seen_at, online: now - Date.parse(last_seen_at) < ONLINE_MS };
  });
}
