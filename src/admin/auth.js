import { scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

// Stored as "scrypt$<salt hex>$<hash hex>".
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

// Used when the email is unknown, so login takes the same time either way.
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

export function tokenSecret() {
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') throw new Error('ADMIN_TOKEN_SECRET is required in production');
  console.warn('ADMIN_TOKEN_SECRET not set: using a random one, admin tokens die on restart');
  return randomBytes(32).toString('hex');
}

const sign = (secret, data) => createHmac('sha256', secret).update(data).digest('base64url');

// Token = base64url({sub, ver, sid, exp}) + "." + HMAC. Role, store and token_version are re-read from the DB on every request,
// so bumping admins.token_version (password change, disable, reset, "hamma joydan chiqish") kills every older token.
// A token without ver counts as 0. sid (task 54) = the admin_logins row it came from, only to mark "this device".
export function signToken(secret, adminId, now = Date.now(), ver = 0, { sid, ttl = TOKEN_TTL_MS } = {}) {
  const exp = now + ttl;
  const payload = Buffer.from(JSON.stringify({ sub: adminId, ver, ...(sid && { sid }), exp })).toString('base64url');
  return { token: `${payload}.${sign(secret, payload)}`, expires_at: new Date(exp).toISOString() };
}

// → { sub, ver, sid } or null.
export function verifyToken(secret, token, now = Date.now()) {
  const [payload, mac] = String(token).split('.');
  if (!payload || !mac) return null;
  const a = Buffer.from(mac);
  const b = Buffer.from(sign(secret, payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { sub, ver = 0, sid = null, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Number.isInteger(sub) && Number.isInteger(ver) && exp > now ? { sub, ver, sid: Number.isInteger(sid) ? sid : null } : null;
  } catch {
    return null;
  }
}
