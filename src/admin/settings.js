// Settings API (task 19): store profile, team (one-time invites, disable), my account (password change) and the audit log.
// Roles: super = every store; owner = one store, its settings and its managers; manager = products and orders of one store.
import { randomBytes, createHash } from 'node:crypto';
import { fail, text, int, paging, dateRange, createAdmin, publicAdmin } from './routes.js';
import { hashPassword, verifyPassword, signToken } from './auth.js';
import { audit, diff, AUDIT_ENTITIES } from './audit.js';
import { publicBase } from '../qr.js';
import { stamp } from '../cart/cart.js';

export const ROLES = ['super', 'owner', 'manager'];
export const INVITE_TTL_MS = 48 * 60 * 60 * 1000;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const iso = (ms) => new Date(ms).toISOString(); // written and compared as ISO strings, like cart.js
const isPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 200;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const canEditStore = (admin, storeId) => admin.role === 'super' || (admin.role === 'owner' && admin.store_id === storeId);
const ownerOrSuper = (admin) => {
  if (admin.role === 'manager') throw fail(403, 'err.forbidden');
};
// Who an admin may disable: super → any owner or manager; owner → managers of their own store. Never yourself or a super.
const manages = (admin, target) => target.id !== admin.id && target.role !== 'super'
  && (admin.role === 'super' || (admin.role === 'owner' && target.role === 'manager' && target.store_id === admin.store_id));

// Invite links work without a session: check shows who it is for, accept sets the password and signs in.
export function publicTeamRoutes(r, db, { secret }) {
  const liveInvite = (q, token) => (typeof token === 'string' && /^[0-9a-f]{32}$/.test(token)
    ? q('admin_invites as i').join('stores as s', 's.id', 'i.store_id').where('i.token_hash', sha256(token)).whereNull('i.used_at')
      .where('i.expires_at', '>', iso(Date.now())).first('i.*', 's.name as store_name')
    : undefined);

  // The token travels in the body (never in a path), so it can't land in the request log.
  r.post('/invite/check', async (req, res) => {
    const inv = await liveInvite(db, req.body?.token);
    if (!inv) throw fail(410, 'err.invite_invalid');
    res.json({ email: inv.email, role: inv.role, store_name: inv.store_name });
  });

  r.post('/invite/accept', async (req, res) => {
    const password = req.body?.password;
    if (!isPassword(password)) throw fail(400, 'err.password_len');
    const admin = await db.transaction(async (trx) => {
      const inv = await liveInvite(trx, req.body?.token);
      // The conditional UPDATE claims the invite: of two parallel accepts only one gets the row.
      if (!inv || !(await trx('admin_invites').where({ id: inv.id }).whereNull('used_at').update({ used_at: iso(Date.now()) }))) throw fail(410, 'err.invite_invalid');
      if (await trx('admins').where({ email: inv.email }).first()) throw fail(409, 'err.email_taken');
      const id = await createAdmin(trx, { email: inv.email, password, storeId: inv.store_id, role: inv.role });
      const a = await trx('admins').where({ id }).first();
      await audit(trx, a, { action: 'team.join', storeId: a.store_id, entityId: id, label: a.email, after: { role: a.role } });
      return a;
    });
    res.status(201).json({ ...signToken(secret, admin.id, Date.now(), admin.token_version), admin: publicAdmin(admin) });
  });
}

// Store profile as the settings form edits it.
const STORE_COLS = ['id', 'name', 'city', 'address', 'lat', 'lon', 'delivery_fee', 'free_delivery_threshold', 'opens_at', 'closes_at', 'telegram_chat_id'];
function validStore(b) {
  const num = (v, min, max, field) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw fail(400, 'err.invalid', { field });
    return n;
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
    telegram_chat_id: null,
  };
  if ((s.opens_at === null) !== (s.closes_at === null)) throw fail(400, 'err.invalid', { field: 'field.hours' });
  // Telegram chat ids: up to 13 digits, negative for groups (-100…); 15 digits still fit a double exactly.
  if (b.telegram_chat_id != null && b.telegram_chat_id !== '') {
    if (!/^-?\d{1,15}$/.test(String(b.telegram_chat_id).trim())) throw fail(400, 'err.invalid', { field: 'field.telegram_chat' });
    s.telegram_chat_id = Number(String(b.telegram_chat_id).trim());
  }
  return s;
}

export function settingsRoutes(r, db, { secret, lock, resolveStore }) {
  async function findStore(req) {
    const id = Number(req.params.id);
    if (req.admin.role !== 'super' && id !== req.admin.store_id) throw fail(404, 'err.store_not_found');
    const s = Number.isInteger(id) && id > 0 ? await db('stores').where({ id }).first(STORE_COLS) : undefined;
    if (!s) throw fail(404, 'err.store_not_found');
    return s;
  }

  // A manager may read their store's profile (read-only form); only its owner or a super-admin may change it.
  r.get('/stores/:id', async (req, res) => {
    const s = await findStore(req);
    res.json({ ...s, can_edit: canEditStore(req.admin, s.id) });
  });

  // Partial edit: only known profile fields count (order_seq etc. can't be reached), merged and validated as a whole.
  r.patch('/stores/:id', async (req, res) => {
    const { id, ...before } = await findStore(req);
    if (!canEditStore(req.admin, id)) throw fail(403, 'err.forbidden');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const next = validStore({ ...before, ...Object.fromEntries(Object.entries(body).filter(([k]) => Object.hasOwn(before, k))) });
    const d = diff(before, next);
    if (d) {
      await db.transaction(async (trx) => {
        await trx('stores').where({ id }).update({ ...next, updated_at: trx.fn.now() });
        await audit(trx, req.admin, { action: 'store.update', storeId: id, entityId: id, label: next.name, ...d });
      });
    }
    res.json({ id, ...next, can_edit: true });
  });

  // Store scope for team and audit: an owner is pinned to their store; ?store_id narrows a super-admin.
  const inScope = (req, q, col) => {
    if (req.admin.role !== 'super') q.where(col, req.admin.store_id);
    else if (req.query.store_id) q.where(col, Number(req.query.store_id) || 0);
    return q;
  };

  r.get('/team', async (req, res) => {
    ownerOrSuper(req.admin);
    const members = await inScope(req, db('admins as a').leftJoin('stores as s', 's.id', 'a.store_id').orderBy('a.id')
      .select('a.id', 'a.email', 'a.role', 'a.store_id', 's.name as store_name', 'a.disabled_at', 'a.created_at'), 'a.store_id');
    const invites = await inScope(req, db('admin_invites as i').join('stores as s', 's.id', 'i.store_id').whereNull('i.used_at')
      .where('i.expires_at', '>', iso(Date.now())).orderBy('i.id', 'desc')
      .select('i.id', 'i.email', 'i.role', 'i.store_id', 's.name as store_name', 'i.expires_at', 'i.created_at'), 'i.store_id');
    res.json({
      members: members.map(({ disabled_at, created_at, ...m }) => ({ ...m, disabled: disabled_at != null, created_at: stamp(created_at), can_manage: manages(req.admin, m) })),
      invites: invites.map((i) => ({ ...i, expires_at: stamp(i.expires_at), created_at: stamp(i.created_at), can_revoke: req.admin.role === 'super' || i.role === 'manager' })),
    });
  });

  // { email, role, store_id } → a one-time link, shown once. Owners invite managers to their own store; super invites owners too.
  r.post('/team/invites', async (req, res) => {
    ownerOrSuper(req.admin);
    const b = req.body ?? {};
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 200) throw fail(400, 'err.invalid', { field: 'field.email' });
    const role = b.role ?? 'manager';
    if (!['owner', 'manager'].includes(role)) throw fail(400, 'err.invalid', { field: 'field.role' });
    if (role === 'owner' && req.admin.role !== 'super') throw fail(403, 'err.forbidden');
    const storeId = await resolveStore(db, req.admin, b.store_id);
    if (await db('admins').where({ email }).first()) throw fail(409, 'err.email_taken');
    const token = randomBytes(16).toString('hex');
    const expires = Date.now() + INVITE_TTL_MS;
    const id = await db.transaction(async (trx) => {
      await trx('admin_invites').where({ email, store_id: storeId }).whereNull('used_at').del(); // a fresh link replaces the open one
      const [{ id }] = await trx('admin_invites').insert({ token_hash: sha256(token), email, role, store_id: storeId, created_by: req.admin.id, expires_at: iso(expires) }).returning('id');
      await audit(trx, req.admin, { action: 'team.invite', storeId, entityId: id, label: email, after: { email, role } });
      return id;
    });
    // In the #fragment, so the token never reaches a server log when the link is opened.
    res.status(201).json({ id, email, role, store_id: storeId, expires_at: iso(expires), url: `${publicBase(req)}/admin/#/invite?token=${token}` });
  });

  r.delete('/team/invites/:id', async (req, res) => {
    ownerOrSuper(req.admin);
    const q = db('admin_invites').where({ id: Number(req.params.id) || 0 }).whereNull('used_at');
    if (req.admin.role !== 'super') q.where({ store_id: req.admin.store_id, role: 'manager' });
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
