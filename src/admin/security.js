// Task 54: account security. Sign-in (password, then the authenticator code when two-step login is on), the login lock,
// password change and reset links, two-step login with recovery codes, the sign-in log ("Kirishlar") and "hamma joydan chiqish".
// Sessions = admins.token_version (task 19), re-read on every request: bumping it ends every token of that account at once.
import { randomBytes } from 'node:crypto';
import { fail, publicAdmin } from './routes.js';
import { hashPassword, verifyPassword, DUMMY_HASH, signToken, verifyToken } from './auth.js';
import { audit } from './audit.js';
import { ownerOrSuper, manages, isPassword } from './settings.js';
import { publicBase, qrSvg } from '../qr.js';
import { stamp } from '../cart/cart.js';
import { matchStep, fromBase32, newSecret, validSecret, otpauthUri, seal, unseal, sha256, newRecoveryCode, normCode, isRecoveryCode, RECOVERY_CODES } from './twostep.js';

export const RESET_TTL_MS = 24 * 60 * 60 * 1000;
const TICKET_MS = 5 * 60 * 1000; // between the password and the code
const LOCK_MS = 15 * 60 * 1000;
// Wrong tries per key within LOCK_MS, then that key is locked for the rest of the window:
// ip = every login/code/password try from one address; pw = one email from one address (so a stranger elsewhere
// can't lock the owner out of their own shop); code = the second step of one account (reached only with its password).
const MAX_FAILS = { ip: 10, pw: 5, code: 5 };
const LOGINS_KEEP = 50; // sign-in log rows per account
const iso = (ms) => new Date(ms).toISOString();

// shortcut: per-process memory, like the rate limits; move to a shared store if we run several instances.
export function createLock() {
  const fails = new Map(); // key -> { count, until }
  const live = (k, t) => {
    const f = fails.get(k);
    return f && f.until > t ? f : null;
  };
  return {
    check(...keys) {
      const t = Date.now();
      for (const k of keys) if ((live(k, t)?.count ?? 0) >= MAX_FAILS[k.split(':')[0]]) throw fail(429, 'err.too_many_attempts');
    },
    // → true when one of the keys has just become locked (worth an audit row).
    miss(...keys) {
      const t = Date.now();
      if (fails.size > 10_000) for (const [k, f] of fails) if (f.until <= t) fails.delete(k);
      let locked = false;
      for (const k of keys) {
        const f = live(k, t);
        const next = f ? { count: f.count + 1, until: f.until } : { count: 1, until: t + LOCK_MS };
        fails.set(k, next);
        if (next.count === MAX_FAILS[k.split(':')[0]]) locked = true;
      }
      return locked;
    },
    clear(...keys) {
      for (const k of keys) fails.delete(k);
    },
  };
}

const logRow = (req, adminId, method, ok) => ({ admin_id: adminId, method, ok, ip: String(req.ip ?? '').slice(0, 64), agent: String(req.get('user-agent') ?? '').slice(0, 200) });
async function prune(q, adminId) {
  const old = await q('admin_logins').where({ admin_id: adminId }).orderBy('id', 'desc').offset(LOGINS_KEEP).first('id');
  if (old) await q('admin_logins').where({ admin_id: adminId }).where('id', '<=', old.id).del();
}
// A failed try on a known account: a row in its sign-in log, and an audit row when it just got locked.
async function logFail(db, req, admin, method, locked) {
  await db.transaction(async (trx) => {
    await trx('admin_logins').insert(logRow(req, admin.id, method, false));
    await prune(trx, admin.id);
    if (locked) await audit(trx, admin, { action: 'account.locked', storeId: admin.store_id, entityId: admin.id, label: admin.email, after: { step: method === 'password' ? 1 : 2 } });
  });
}
// Every way in (password, code, invite, reset) ends here: a sign-in log row and a token that knows it (sid = "this device").
export async function signIn(q, req, secret, admin, method) {
  const [{ id: sid }] = await q('admin_logins').insert(logRow(req, admin.id, method, true)).returning('id');
  await prune(q, admin.id);
  return { ...signToken(secret, admin.id, Date.now(), admin.token_version, { sid }), admin: publicAdmin(admin) };
}

export const orgRequires = async (db, orgId) => orgId != null && Boolean((await db('organizations').where({ id: orgId }).first('require_two_step'))?.require_two_step);
const codesLeft = async (q, adminId) => Number((await q('admin_recovery_codes').where({ admin_id: adminId }).whereNull('used_at').count({ n: '*' }))[0].n);
async function newCodes(trx, adminId) {
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  await trx('admin_recovery_codes').where({ admin_id: adminId }).del();
  await trx('admin_recovery_codes').insert(codes.map((c) => ({ admin_id: adminId, code_hash: sha256(normCode(c)) })));
  return codes;
}
const TWO_STEP_OFF = { totp_secret: null, totp_enabled_at: null, totp_last_step: null };

// Before the auth middleware: sign-in and reset links work without a session.
export function securityPublicRoutes(r, db, { secret, lock, now }) {
  const ticketSecret = `${secret}\0two-step-ticket`; // a ticket is never a session token, nor the other way round

  // { email, password } → a token, or { two_step: true, ticket } when the account has two-step login on.
  r.post('/login', async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 200) : '';
    const password = typeof req.body?.password === 'string' && req.body.password.length <= 200 ? req.body.password : '';
    const keys = [`ip:${req.ip}`, `pw:${email}|${req.ip}`];
    lock.check(...keys);
    const admin = email ? await db('admins').where({ email }).first() : undefined;
    const ok = (await verifyPassword(password, admin?.password_hash ?? DUMMY_HASH)) && admin && password;
    if (!ok) {
      const locked = lock.miss(...keys);
      if (admin) await logFail(db, req, admin, 'password', locked);
      throw fail(401, 'err.bad_login');
    }
    lock.clear(...keys);
    // Said only after the right password, so it reveals nothing to a guesser.
    if (admin.disabled_at) throw fail(403, 'err.account_disabled');
    if (admin.totp_secret) return res.json({ two_step: true, ticket: signToken(ticketSecret, admin.id, Date.now(), admin.token_version, { ttl: TICKET_MS }).token });
    res.json(await signIn(db, req, secret, admin, 'password'));
  });

  // { ticket, code }: the 6 digits from the authenticator app (now ±30 s, each code once) or one recovery code.
  r.post('/login/code', async (req, res) => {
    const tok = verifyToken(ticketSecret, String(req.body?.ticket ?? ''));
    const admin = tok ? await db('admins').where({ id: tok.sub }).first() : undefined;
    if (!admin || admin.disabled_at || admin.token_version !== tok.ver || !admin.totp_secret) throw fail(401, 'err.login_again');
    const keys = [`ip:${req.ip}`, `code:${admin.id}`];
    lock.check(...keys);
    const code = typeof req.body?.code === 'string' ? req.body.code.trim().slice(0, 40) : '';
    const method = await db.transaction(async (trx) => {
      if (/^\d{6}$/.test(code)) {
        const key = fromBase32(unseal(secret, admin.totp_secret) ?? '');
        const step = key?.length ? matchStep(key, code, now(), admin.totp_last_step) : null;
        // Conditional on the step: of two parallel sign-ins with one code only one moves it forward.
        const won = step != null && await trx('admins').where({ id: admin.id }).where((q) => q.whereNull('totp_last_step').orWhere('totp_last_step', '<', step)).update({ totp_last_step: step });
        return won ? 'two_step' : null;
      }
      if (!isRecoveryCode(code)) return null;
      const row = await trx('admin_recovery_codes').where({ admin_id: admin.id, code_hash: sha256(normCode(code)) }).whereNull('used_at').first('id');
      if (!row || !(await trx('admin_recovery_codes').where({ id: row.id }).whereNull('used_at').update({ used_at: iso(now()) }))) return null;
      await audit(trx, admin, { action: 'account.recovery_used', storeId: admin.store_id, entityId: admin.id, label: admin.email, after: { left: await codesLeft(trx, admin.id) } });
      return 'recovery';
    });
    if (!method) {
      await logFail(db, req, admin, 'two_step', lock.miss(...keys));
      throw fail(400, 'err.bad_code');
    }
    lock.clear(`code:${admin.id}`);
    res.json(await signIn(db, req, secret, admin, method));
  });

  // Reset links: the token travels in the body (never in a path), so it can't land in the request log.
  const liveReset = (q, token) => (typeof token === 'string' && /^[0-9a-f]{32}$/.test(token)
    ? q('admin_resets as x').join('admins as a', 'a.id', 'x.admin_id').where('x.token_hash', sha256(token)).whereNull('x.used_at')
      .where('x.expires_at', '>', iso(Date.now())).whereNull('a.disabled_at').first('x.id', 'x.admin_id', 'a.email')
    : undefined);

  r.post('/reset/check', async (req, res) => {
    const x = await liveReset(db, req.body?.token);
    if (!x) throw fail(410, 'err.reset_invalid');
    res.json({ email: x.email });
  });

  // { token, password }: the new password; every session of the account ends, and two-step login is turned off
  // (the usual reason is a lost phone too). An organisation that requires it asks for a new setup right after.
  r.post('/reset/accept', async (req, res) => {
    const password = req.body?.password;
    if (!isPassword(password)) throw fail(400, 'err.password_len');
    const hash = await hashPassword(password);
    const out = await db.transaction(async (trx) => {
      const x = await liveReset(trx, req.body?.token);
      // The conditional UPDATE claims the link: of two parallel uses only one gets it.
      if (!x || !(await trx('admin_resets').where({ id: x.id }).whereNull('used_at').update({ used_at: iso(Date.now()) }))) throw fail(410, 'err.reset_invalid');
      await trx('admins').where({ id: x.admin_id }).update({ password_hash: hash, token_version: trx.raw('token_version + 1'), ...TWO_STEP_OFF, updated_at: trx.fn.now() });
      await trx('admin_recovery_codes').where({ admin_id: x.admin_id }).del();
      await trx('admin_resets').where({ admin_id: x.admin_id }).whereNull('used_at').del();
      const a = await trx('admins').where({ id: x.admin_id }).first();
      await audit(trx, a, { action: 'account.reset', storeId: a.store_id, entityId: a.id, label: a.email });
      return signIn(trx, req, secret, a, 'reset');
    });
    res.json(out);
  });
}

// After the auth middleware: the signed-in admin's own account, the owner's organisation rule, reset links for the team.
export function securityRoutes(r, db, { secret, lock, now }) {
  const ipKey = (req) => `ip:${req.ip}`;
  async function checkPassword(req, password) {
    lock.check(ipKey(req));
    if (typeof password !== 'string' || password.length > 200 || !(await verifyPassword(password, req.admin.password_hash))) {
      lock.miss(ipKey(req));
      throw fail(400, 'err.bad_password'); // 400, not 401: a wrong password must not sign the user out
    }
  }
  // A security change that ends every other session: bump the version (conditional, so two parallel changes can't
  // both win) and hand this device a fresh token with its own sid.
  async function bump(trx, req, extra = {}) {
    if (!(await trx('admins').where({ id: req.admin.id, token_version: req.admin.token_version }).update({ token_version: req.admin.token_version + 1, ...extra, updated_at: trx.fn.now() }))) {
      throw fail(401, 'err.login_again');
    }
    return signToken(secret, req.admin.id, Date.now(), req.admin.token_version + 1, { sid: req.sid ?? undefined });
  }
  const own = (req) => ({ storeId: req.admin.store_id, entityId: req.admin.id, label: req.admin.email });

  // { current, password } → a fresh token for this session; every other token of this admin stops working.
  r.post('/me/password', async (req, res) => {
    const { current, password } = req.body ?? {};
    if (!isPassword(password)) throw fail(400, 'err.password_len');
    await checkPassword(req, current);
    const hash = await hashPassword(password);
    res.json(await db.transaction(async (trx) => {
      const out = await bump(trx, req, { password_hash: hash });
      await audit(trx, req.admin, { action: 'account.password', ...own(req) });
      return out;
    }));
  });

  // "Kirishlar": the last sign-ins (and failed tries) of this account, two-step state, and the owner's organisation rule.
  r.get('/me/security', async (req, res) => {
    const rows = await db('admin_logins').where({ admin_id: req.admin.id }).orderBy('id', 'desc').limit(20);
    const required = await orgRequires(db, req.admin.organization_id);
    res.json({
      two_step: { on: Boolean(req.admin.totp_secret), required, codes_left: req.admin.totp_secret ? await codesLeft(db, req.admin.id) : 0 },
      ...(req.admin.role === 'owner' && { org: { require_two_step: required } }),
      logins: rows.map((l) => ({ id: l.id, method: l.method, ok: Boolean(l.ok), ip: l.ip, agent: l.agent, created_at: stamp(l.created_at), current: l.id === req.sid })),
    });
  });

  // A fresh secret to scan (QR of the otpauth:// link) or type in. Nothing is stored until a code from it is confirmed.
  r.get('/me/two-step/new', async (req, res) => {
    if (req.admin.totp_secret) throw fail(409, 'err.two_step_on');
    const secret2 = newSecret();
    const uri = otpauthUri(secret2, req.admin.email);
    res.json({ secret: secret2, uri, svg: qrSvg(uri, 5) });
  });

  // { secret, code } → two-step login on, and the recovery codes (shown this once).
  r.post('/me/two-step', async (req, res) => {
    const { secret: s, code } = req.body ?? {};
    if (!validSecret(s)) throw fail(400, 'err.invalid', { field: 'field.two_step_secret' });
    if (req.admin.totp_secret) throw fail(409, 'err.two_step_on');
    lock.check(ipKey(req));
    const step = matchStep(fromBase32(s), typeof code === 'string' ? code.trim() : '', now());
    if (step == null) {
      lock.miss(ipKey(req));
      throw fail(400, 'err.bad_code');
    }
    const codes = await db.transaction(async (trx) => {
      if (!(await trx('admins').where({ id: req.admin.id }).whereNull('totp_secret').update({ totp_secret: seal(secret, s), totp_enabled_at: iso(now()), totp_last_step: step, updated_at: trx.fn.now() }))) {
        throw fail(409, 'err.two_step_on');
      }
      await audit(trx, req.admin, { action: 'account.two_step_on', ...own(req) });
      return newCodes(trx, req.admin.id);
    });
    res.status(201).json({ recovery_codes: codes });
  });

  // { password } → a new set of recovery codes; the old ones stop working.
  r.post('/me/two-step/codes', async (req, res) => {
    await checkPassword(req, req.body?.password);
    if (!req.admin.totp_secret) throw fail(409, 'err.two_step_off');
    const codes = await db.transaction(async (trx) => {
      await audit(trx, req.admin, { action: 'account.recovery_new', ...own(req) });
      return newCodes(trx, req.admin.id);
    });
    res.status(201).json({ recovery_codes: codes });
  });

  // { password } → off (not while the organisation requires it). The recovery codes go too.
  r.post('/me/two-step/off', async (req, res) => {
    await checkPassword(req, req.body?.password);
    if (!req.admin.totp_secret) throw fail(409, 'err.two_step_off');
    if (await orgRequires(db, req.admin.organization_id)) throw fail(409, 'err.two_step_org');
    await db.transaction(async (trx) => {
      await trx('admins').where({ id: req.admin.id }).update({ ...TWO_STEP_OFF, updated_at: trx.fn.now() });
      await trx('admin_recovery_codes').where({ admin_id: req.admin.id }).del();
      await audit(trx, req.admin, { action: 'account.two_step_off', ...own(req) });
    });
    res.status(204).end();
  });

  // "Hamma joydan chiqish": every token of this account dies; this device gets a fresh one.
  r.post('/me/logout-all', async (req, res) => {
    res.json(await db.transaction(async (trx) => {
      const out = await bump(trx, req);
      await audit(trx, req.admin, { action: 'account.logout_all', ...own(req) });
      return out;
    }));
  });

  // { required } — the owner's rule for everyone in their organisation. The owner turns it on for themselves first.
  r.patch('/org/two-step', async (req, res) => {
    if (req.admin.role !== 'owner') throw fail(403, 'err.forbidden');
    const required = req.body?.required;
    if (typeof required !== 'boolean') throw fail(400, 'err.invalid', { field: 'field.two_step_rule' });
    if (required && !req.admin.totp_secret) throw fail(409, 'err.two_step_self');
    const was = await orgRequires(db, req.admin.organization_id);
    if (was !== required) {
      await db.transaction(async (trx) => {
        await trx('organizations').where({ id: req.admin.organization_id }).update({ require_two_step: required });
        await audit(trx, req.admin, { action: 'org.two_step', storeId: req.admin.store_id, entityId: req.admin.organization_id, before: { require_two_step: was }, after: { require_two_step: required } });
      });
    }
    res.json({ require_two_step: required });
  });

  // A one-time reset link for a team member (shown once, valid 24 h; a new one replaces the open one).
  // Same rule as disabling: owner → managers and staff of their organisation; super → anyone but a super. Never yourself.
  r.post('/team/:id/reset', async (req, res) => {
    ownerOrSuper(req.admin);
    const target = await db('admins').where({ id: Number(req.params.id) || 0 }).first();
    if (!target || !manages(req.admin, target)) throw fail(404, 'err.not_found');
    if (target.disabled_at) throw fail(409, 'err.account_disabled');
    const token = randomBytes(16).toString('hex');
    const expires = Date.now() + RESET_TTL_MS;
    await db.transaction(async (trx) => {
      await trx('admin_resets').where({ admin_id: target.id }).whereNull('used_at').del();
      await trx('admin_resets').insert({ admin_id: target.id, token_hash: sha256(token), created_by: req.admin.id, expires_at: iso(expires) });
      await audit(trx, req.admin, { action: 'team.reset_link', storeId: target.store_id, entityId: target.id, label: target.email });
    });
    // In the #fragment, so the token never reaches a server log when the link is opened.
    res.status(201).json({ email: target.email, expires_at: iso(expires), url: `${publicBase(req)}/admin/#/reset?token=${token}` });
  });
}
