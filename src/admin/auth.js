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

// Token = base64url({sub, exp}) + "." + HMAC. Role and store are re-read from the DB on every request.
export function signToken(secret, adminId, now = Date.now()) {
  const exp = now + TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ sub: adminId, exp })).toString('base64url');
  return { token: `${payload}.${sign(secret, payload)}`, expires_at: new Date(exp).toISOString() };
}

export function verifyToken(secret, token, now = Date.now()) {
  const [payload, mac] = String(token).split('.');
  if (!payload || !mac) return null;
  const a = Buffer.from(mac);
  const b = Buffer.from(sign(secret, payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Number.isInteger(sub) && exp > now ? sub : null;
  } catch {
    return null;
  }
}
