// Settings API (task 19): store profile, team (one-time invites, disable), my account (password change) and the audit log.
// Roles: super = every organisation; owner = every store of one organisation (task 22), their settings and managers;
// manager = products and orders of one store; staff (task 28) = the shop-floor app of one store, nothing else.
import { randomBytes, createHash } from 'node:crypto';
import { fail, text, int, paging, dateRange, createAdmin, publicAdmin, canSee, inStores } from './routes.js';
import { hashPassword, verifyPassword, signToken } from './auth.js';
import { audit, diff, AUDIT_ENTITIES } from './audit.js';
import { publicBase } from '../qr.js';
import { stamp } from '../cart/cart.js';

export const ROLES = ['super', 'owner', 'manager', 'staff', 'mall'];
const STORE_ROLES = ['manager', 'staff']; // bound to one store; an owner invites and manages these
export const INVITE_TTL_MS = 48 * 60 * 60 * 1000;
const SYNC_KEYS_MAX = 10; // live keys per store
const STORES_MAX = 50; // per organisation: a typo loop can't fill the table
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const iso = (ms) => new Date(ms).toISOString(); // written and compared as ISO strings, like cart.js
const isPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 200;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const canEditStore = (admin, storeId) => admin.role === 'super' || (admin.role === 'owner' && canSee(admin, storeId));
const ownerOrSuper = (admin) => {
  if (admin.role !== 'super' && admin.role !== 'owner') throw fail(403, 'err.forbidden');
};
// Who an admin may disable: super → any owner, manager or staff; owner → managers and staff of their organisation. Never yourself or a super.
const manages = (admin, target) => target.id !== admin.id && target.role !== 'super'
  && (admin.role === 'super' || (admin.role === 'owner' && STORE_ROLES.includes(target.role) && target.organization_id === admin.organization_id));

// Invite links work without a session: check shows who it is for, accept sets the password and signs in.
export function publicTeamRoutes(r, db, { secret }) {
  const liveInvite = (q, token) => (typeof token === 'string' && /^[0-9a-f]{32}$/.test(token)
    ? q('admin_invites as i').leftJoin('stores as s', 's.id', 'i.store_id').leftJoin('organizations as g', 'g.id', 'i.organization_id').leftJoin('malls as m', 'm.id', 'i.mall_id')
      .where('i.token_hash', sha256(token)).whereNull('i.used_at').where('i.expires_at', '>', iso(Date.now())).first('i.*', 's.name as store_name', 'g.name as org_name', 'm.name as mall_name')
    : undefined);

  // The token travels in the body (never in a path), so it can't land in the request log.
  r.post('/invite/check', async (req, res) => {
    const inv = await liveInvite(db, req.body?.token);
    if (!inv) throw fail(410, 'err.invite_invalid');
    res.json({ email: inv.email, role: inv.role, store_name: inv.store_name, org_name: inv.org_name, ...(inv.mall_name && { mall_name: inv.mall_name }) });
  });

  r.post('/invite/accept', async (req, res) => {
    const password = req.body?.password;
    if (!isPassword(password)) throw fail(400, 'err.password_len');
    const admin = await db.transaction(async (trx) => {
      const inv = await liveInvite(trx, req.body?.token);
      // The conditional UPDATE claims the invite: of two parallel accepts only one gets the row.
      if (!inv || !(await trx('admin_invites').where({ id: inv.id }).whereNull('used_at').update({ used_at: iso(Date.now()) }))) throw fail(410, 'err.invite_invalid');
      if (await trx('admins').where({ email: inv.email }).first()) throw fail(409, 'err.email_taken');
      const id = await createAdmin(trx, { email: inv.email, password, storeId: inv.store_id, orgId: inv.organization_id, mallId: inv.mall_id ?? null, role: inv.role });
      const a = await trx('admins').where({ id }).first();
      await audit(trx, a, { action: 'team.join', storeId: a.store_id, entityId: id, label: a.email, after: { role: a.role } });
      return a;
    });
    res.status(201).json({ ...signToken(secret, admin.id, Date.now(), admin.token_version), admin: publicAdmin(admin) });
  });
}

// A one-time invite link (shown once; only its sha256 is stored). A fresh link replaces the open one for that email.
export async function createInvite(req, q, { email, role, storeId, orgId, mallId = null }) {
  if (await q('admins').where({ email }).first()) throw fail(409, 'err.email_taken');
  const token = randomBytes(16).toString('hex');
  const expires = Date.now() + INVITE_TTL_MS;
  const run = async (trx) => {
    await trx('admin_invites').where(mallId ? { email, mall_id: mallId } : { email, organization_id: orgId }).whereNull('used_at').del();
    const [{ id }] = await trx('admin_invites').insert({ token_hash: sha256(token), email, role, store_id: storeId, organization_id: orgId, mall_id: mallId, created_by: req.admin.id, expires_at: iso(expires) }).returning('id');
    await audit(trx, req.admin, { action: 'team.invite', storeId, entityId: id, label: email, after: { email, role } });
    return id;
  };
  const id = q.isTransaction ? await run(q) : await q.transaction(run);
  // In the #fragment, so the token never reaches a server log when the link is opened.
  return { id, email, role, store_id: storeId, organization_id: orgId, ...(mallId && { mall_id: mallId }), expires_at: iso(expires), url: `${publicBase(req)}/admin/#/invite?token=${token}` };
}

// Store profile as the settings form edits it.
const STORE_COLS = ['id', 'name', 'city', 'address', 'lat', 'lon', 'delivery_fee', 'free_delivery_threshold', 'opens_at', 'closes_at', 'telegram_chat_id', 'low_stock_threshold', 'report_chat_id', 'bundle_percent'];
function validStore(b) {
  const num = (v, min, max, field) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw fail(400, 'err.invalid', { field });
    return n;
  };
  // Telegram chat ids: up to 13 digits, negative for groups (-100…); 15 digits still fit a double exactly.
  const chat = (v, field) => {
    if (v == null || v === '') return null;
    if (!/^-?\d{1,15}$/.test(String(v).trim())) throw fail(400, 'err.invalid', { field });
    return Number(String(v).trim());
  };
  const time = (v, field) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw fail(400, 'err.invalid', { field });
    return v;
  };
  const s = {
    name: text(b.name, 120, 'field.name', true),
    city: text(b.city, 80, 'field.city', true),
    address: text(b.address, 200, 'field.address', true),
    lat: num(b.lat, -90, 90, 'field.map_point'),
    lon: num(b.lon, -180, 180, 'field.map_point'),
    delivery_fee: int(b.delivery_fee, 0, 1e9, 'field.delivery_fee'),
    free_delivery_threshold: b.free_delivery_threshold == null || b.free_delivery_threshold === '' ? null : int(b.free_delivery_threshold, 1, 1e9, 'field.free_threshold'),
    opens_at: time(b.opens_at, 'field.hours'),
    closes_at: time(b.closes_at, 'field.hours'),
    telegram_chat_id: chat(b.telegram_chat_id, 'field.telegram_chat'),
    report_chat_id: chat(b.report_chat_id, 'field.report_chat'), // task 24: the owner's weekly report
    low_stock_threshold: int(typeof b.low_stock_threshold === 'string' && b.low_stock_threshold.trim() !== '' ? Number(b.low_stock_threshold) : b.low_stock_threshold, 0, 1000, 'field.low_stock'),
    bundle_percent: int(b.bundle_percent ?? 0, 0, 90, 'field.bundle_percent'), // task 26: "whole outfit" discount, 0 = off
  };
  if ((s.opens_at === null) !== (s.closes_at === null)) throw fail(400, 'err.invalid', { field: 'field.hours' });
  return s;
}

export function settingsRoutes(r, db, { secret, lock, resolveStore }) {
  async function findStore(req) {
    const id = Number(req.params.id);
    if (!canSee(req.admin, id)) throw fail(404, 'err.store_not_found');
    const s = Number.isInteger(id) && id > 0 ? await db('stores').where({ id }).first(STORE_COLS) : undefined;
    if (!s) throw fail(404, 'err.store_not_found');
    return s;
  }

  // A manager may read their store's profile (read-only form); only its owner or a super-admin may change it.
  const pinSet = async (id) => (await db('stores').where({ id }).first('kiosk_pin_hash')).kiosk_pin_hash != null;
  r.get('/stores/:id', async (req, res) => {
    const s = await findStore(req);
    res.json({ ...s, kiosk_pin_set: await pinSet(s.id), can_edit: canEditStore(req.admin, s.id) });
  });

  // Partial edit: only known profile fields count (order_seq etc. can't be reached), merged and validated as a whole.
  r.patch('/stores/:id', async (req, res) => {
    const { id, ...before } = await findStore(req);
    if (!canEditStore(req.admin, id)) throw fail(403, 'err.forbidden');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const next = validStore({ ...before, ...Object.fromEntries(Object.entries(body).filter(([k]) => Object.hasOwn(before, k))) });
    // Kiosk staff exit PIN (task 21): 4–8 digits, stored like a password; empty = unchanged. The audit row never holds it.
    const pin = body.kiosk_pin;
    if (pin != null && pin !== '' && (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin))) throw fail(400, 'err.invalid', { field: 'field.kiosk_pin' });
    const pinHash = pin ? await hashPassword(pin) : null;
    const d = diff(before, next);
    if (d || pinHash) {
      await db.transaction(async (trx) => {
        await trx('stores').where({ id }).update({ ...next, ...(pinHash && { kiosk_pin_hash: pinHash }), updated_at: trx.fn.now() });
        if (d) await audit(trx, req.admin, { action: 'store.update', storeId: id, entityId: id, label: next.name, ...d });
        if (pinHash) await audit(trx, req.admin, { action: 'store.kiosk_pin', storeId: id, entityId: id, label: next.name });
      });
    }
    res.json({ id, ...next, kiosk_pin_set: await pinSet(id), can_edit: true });
  });

  // New store (onboarding wizard step 1, or "add a store" later): an owner adds one to their organisation, a super-admin
  // to the organisation they name. The owner's first store becomes their own (store_id), the default for imports etc.
  r.post('/stores', async (req, res) => {
    ownerOrSuper(req.admin);
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const orgId = req.admin.role === 'super' ? (await db('organizations').where({ id: Number(b.organization_id) || 0 }).first('id'))?.id : req.admin.organization_id;
    if (!orgId) throw fail(400, 'err.invalid', { field: 'field.org' });
    const s = validStore({ ...Object.fromEntries(STORE_COLS.map((k) => [k, b[k]])), delivery_fee: b.delivery_fee ?? 0, low_stock_threshold: b.low_stock_threshold ?? 1, bundle_percent: b.bundle_percent ?? 0 });
    if (Number((await db('stores').where({ organization_id: orgId }).count({ n: '*' }))[0].n) >= STORES_MAX) throw fail(409, 'err.stores_max', { max: STORES_MAX });
    // Task 37: a shop a mall invited puts its first store in that mall (later stores may be anywhere).
    const org = await db('organizations as g').leftJoin('malls as m', 'm.id', 'g.mall_id').where('g.id', orgId).first('m.id as mall_id');
    const first = !(await db('stores').where({ organization_id: orgId }).first('id'));
    const mall = org.mall_id && first ? { mall_id: org.mall_id } : {};
    const id = await db.transaction(async (trx) => {
      const [{ id }] = await trx('stores').insert({ ...s, organization_id: orgId, ...mall }).returning('id');
      if (req.admin.role === 'owner' && !req.admin.store_id) await trx('admins').where({ id: req.admin.id }).update({ store_id: id, updated_at: trx.fn.now() });
      await audit(trx, req.admin, { action: 'store.create', storeId: id, entityId: id, label: s.name, after: s });
      return id;
    });
    res.status(201).json({ id, ...s, organization_id: orgId, mall_id: mall.mall_id ?? null, kiosk_pin_set: false, can_edit: true });
  });

  // Store scope for sync keys and audit: an owner sees their organisation's stores; ?store_id narrows further.
  const inScope = (req, q, col) => {
    inStores(req.admin, q, col);
    if (req.query.store_id) q.where(col, Number(req.query.store_id) || 0);
    return q;
  };
  // Team members and invites belong to an organisation (an owner may have no store yet); ?store_id narrows to one store.
  const teamScope = (req, q, a) => {
    if (req.admin.role !== 'super') q.where(`${a}.organization_id`, req.admin.organization_id);
    if (req.query.store_id) q.where(`${a}.store_id`, Number(req.query.store_id) || 0);
    return q;
  };

  r.get('/team', async (req, res) => {
    ownerOrSuper(req.admin);
    const members = await teamScope(req, db('admins as a').leftJoin('stores as s', 's.id', 'a.store_id').leftJoin('organizations as g', 'g.id', 'a.organization_id').orderBy('a.id')
      .select('a.id', 'a.email', 'a.role', 'a.store_id', 'a.organization_id', 's.name as store_name', 'g.name as org_name', 'a.disabled_at', 'a.created_at'), 'a');
    const invites = await teamScope(req, db('admin_invites as i').leftJoin('stores as s', 's.id', 'i.store_id').join('organizations as g', 'g.id', 'i.organization_id')
      .whereNull('i.used_at').where('i.expires_at', '>', iso(Date.now())).orderBy('i.id', 'desc')
      .select('i.id', 'i.email', 'i.role', 'i.store_id', 's.name as store_name', 'g.name as org_name', 'i.expires_at', 'i.created_at'), 'i');
    res.json({
      members: members.map(({ disabled_at, created_at, ...m }) => ({ ...m, disabled: disabled_at != null, created_at: stamp(created_at), can_manage: manages(req.admin, m) })),
      invites: invites.map((i) => ({ ...i, expires_at: stamp(i.expires_at), created_at: stamp(i.created_at), can_revoke: req.admin.role === 'super' || STORE_ROLES.includes(i.role) })),
    });
  });

  // { email, role, store_id, organization_id } → a one-time link, shown once. Owners invite managers and staff to a store of their
  // organisation; super also invites owners, to an organisation (store_id optional: without it they make one in the wizard).
  r.post('/team/invites', async (req, res) => {
    ownerOrSuper(req.admin);
    const b = req.body ?? {};
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 200) throw fail(400, 'err.invalid', { field: 'field.email' });
    const role = b.role ?? 'manager';
    if (!['owner', ...STORE_ROLES].includes(role)) throw fail(400, 'err.invalid', { field: 'field.role' });
    if (role === 'owner' && req.admin.role !== 'super') throw fail(403, 'err.forbidden');
    const ownerOrg = role === 'owner' && b.store_id == null;
    const storeId = ownerOrg ? null : await resolveStore(db, req.admin, b.store_id);
    const orgId = ownerOrg ? (await db('organizations').where({ id: Number(b.organization_id) || 0 }).first('id'))?.id
      : (await db('stores').where({ id: storeId }).first('organization_id')).organization_id;
    if (!orgId) throw fail(400, 'err.invalid', { field: 'field.org' });
    res.status(201).json(await createInvite(req, db, { email, role, storeId, orgId }));
  });

  r.delete('/team/invites/:id', async (req, res) => {
    ownerOrSuper(req.admin);
    const q = db('admin_invites').where({ id: Number(req.params.id) || 0 }).whereNull('used_at');
    if (req.admin.role !== 'super') q.where({ organization_id: req.admin.organization_id }).whereIn('role', STORE_ROLES);
    const inv = await q.first();
    if (!inv) throw fail(404, 'err.not_found');
    await db.transaction(async (trx) => {
      await trx('admin_invites').where({ id: inv.id }).del();
      await audit(trx, req.admin, { action: 'team.invite_revoke', storeId: inv.store_id, entityId: inv.id, label: inv.email, before: { email: inv.email, role: inv.role } });
    });
    res.status(204).end();
  });

  // { disabled: true|false }. Disabling ends the member's sessions at once and kills the invite links they sent.
  r.patch('/team/:id', async (req, res) => {
    ownerOrSuper(req.admin);
    const target = await db('admins').where({ id: Number(req.params.id) || 0 }).first();
    if (!target || !manages(req.admin, target)) throw fail(404, 'err.not_found');
    const disabled = req.body?.disabled;
    if (typeof disabled !== 'boolean') throw fail(400, 'err.invalid', { field: 'field.status' });
    if (disabled !== (target.disabled_at != null)) {
      await db.transaction(async (trx) => {
        await trx('admins').where({ id: target.id }).update(disabled
          ? { disabled_at: iso(Date.now()), token_version: trx.raw('token_version + 1'), updated_at: trx.fn.now() }
          : { disabled_at: null, updated_at: trx.fn.now() });
        if (disabled) await trx('admin_invites').where({ created_by: target.id }).whereNull('used_at').del();
        await audit(trx, req.admin, { action: disabled ? 'team.disable' : 'team.enable', storeId: target.store_id, entityId: target.id, label: target.email,
          before: { disabled: !disabled }, after: { disabled } });
      });
    }
    res.json({ id: target.id, email: target.email, role: target.role, store_id: target.store_id, disabled });
  });

  // Stock sync API keys (task 20): owner of the store or super. The key is returned once; only its sha256 is kept.
  r.get('/sync-keys', async (req, res) => {
    ownerOrSuper(req.admin);
    const keys = await inScope(req, db('sync_keys as k').join('stores as s', 's.id', 'k.store_id').whereNull('k.revoked_at').orderBy('k.id', 'desc')
      .select('k.id', 'k.name', 'k.prefix', 'k.store_id', 's.name as store_name', 'k.created_at', 'k.last_used_at'), 'k.store_id');
    res.json(keys.map((k) => ({ ...k, created_at: stamp(k.created_at), last_used_at: k.last_used_at && stamp(k.last_used_at) })));
  });

  r.post('/sync-keys', async (req, res) => {
    ownerOrSuper(req.admin);
    const name = text(req.body?.name, 60, 'field.key_name', true);
    const storeId = await resolveStore(db, req.admin, req.body?.store_id);
    if (Number((await db('sync_keys').where({ store_id: storeId }).whereNull('revoked_at').count({ n: '*' }))[0].n) >= SYNC_KEYS_MAX) throw fail(409, 'err.sync_keys_max', { max: SYNC_KEYS_MAX });
    const key = `sfk_${randomBytes(24).toString('base64url')}`;
    const prefix = key.slice(0, 10);
    const id = await db.transaction(async (trx) => {
      const [{ id }] = await trx('sync_keys').insert({ store_id: storeId, name, key_hash: sha256(key), prefix, created_by: req.admin.id }).returning('id');
      await audit(trx, req.admin, { action: 'sync_key.create', storeId, entityId: id, label: name, after: { name, prefix } });
      return id;
    });
    res.status(201).json({ id, name, prefix, store_id: storeId, key });
  });

  // Revoked keys stay as rows (revoked_at) so the audit log and last use still make sense; they never work again.
  r.delete('/sync-keys/:id', async (req, res) => {
    ownerOrSuper(req.admin);
    const q = db('sync_keys').where({ id: Number(req.params.id) || 0 }).whereNull('revoked_at');
    const k = await inStores(req.admin, q, 'store_id').first();
    if (!k) throw fail(404, 'err.not_found');
    await db.transaction(async (trx) => {
      await trx('sync_keys').where({ id: k.id }).update({ revoked_at: iso(Date.now()) });
      await audit(trx, req.admin, { action: 'sync_key.revoke', storeId: k.store_id, entityId: k.id, label: k.name, before: { name: k.name, prefix: k.prefix } });
    });
    res.status(204).end();
  });

  // { current, password } → a fresh token for this session; every other token of this admin stops working.
  r.post('/me/password', async (req, res) => {
    lock.check(req.ip);
    const { current, password } = req.body ?? {};
    if (!isPassword(password)) throw fail(400, 'err.password_len');
    // 400, not 401: a wrong current password must not sign the user out.
    if (typeof current !== 'string' || current.length > 200 || !(await verifyPassword(current, req.admin.password_hash))) {
      lock.miss(req.ip);
      throw fail(400, 'err.bad_password');
    }
    const ver = req.admin.token_version + 1;
    const hash = await hashPassword(password);
    await db.transaction(async (trx) => {
      // Conditional on the version this request saw, so two parallel changes can't both win.
      if (!(await trx('admins').where({ id: req.admin.id, token_version: req.admin.token_version }).update({ password_hash: hash, token_version: ver, updated_at: trx.fn.now() }))) {
        throw fail(401, 'err.login_again');
      }
      await audit(trx, req.admin, { action: 'account.password', storeId: req.admin.store_id, entityId: req.admin.id, label: req.admin.email });
    });
    res.json(signToken(secret, req.admin.id, Date.now(), ver));
  });

  // Audit viewer: ?entity&entity_id&admin_id&store_id&from&to&limit&offset → { items, total, limit, offset }, newest first.
  r.get('/audit', async (req, res) => {
    ownerOrSuper(req.admin);
    const { limit, offset } = paging(req.query);
    const f = req.query;
    const q = inScope(req, db('audit_log as l').leftJoin('stores as s', 's.id', 'l.store_id'), 'l.store_id');
    if (f.entity) {
      if (!AUDIT_ENTITIES.includes(f.entity)) throw fail(400, 'err.invalid', { field: 'field.filter' });
      q.where('l.entity', f.entity);
    }
    if (f.entity_id) q.where('l.entity_id', Number(f.entity_id) || 0);
    if (f.admin_id) q.where('l.admin_id', Number(f.admin_id) || 0);
    dateRange(q, 'l.created_at', f);
    const [{ n }] = await q.clone().count({ n: '*' });
    const rows = await q.select('l.*', 's.name as store_name').orderBy('l.id', 'desc').limit(limit).offset(offset);
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    res.json({ items: rows.map((l) => ({ ...l, before: parse(l.before), after: parse(l.after), created_at: stamp(l.created_at) })), total: Number(n), limit, offset });
  });
}
