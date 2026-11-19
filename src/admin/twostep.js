// Task 54: two-step login. TOTP per RFC 6238 (HMAC-SHA1, 30 s steps, 6 digits, the RFC 4226 truncation) on Node's crypto,
// the secret encrypted at rest, and one-time recovery codes. No dependency.
import { createHmac, createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const STEP_MS = 30_000;
export const RECOVERY_CODES = 10;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits ? out + B32[(value << (5 - bits)) & 31] : out;
}

export function fromBase32(s) {
  const bytes = [];
  let bits = 0, value = 0;
  for (const ch of String(s).toLowerCase().replace(/[\s=-]/g, '')) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export const stepOf = (ms) => Math.floor(ms / STEP_MS);

export function totp(key, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// The step a 6-digit code belongs to (now ±1 step, for clock drift), only if it is newer than lastStep; else null.
export function matchStep(key, code, now, lastStep = null) {
  if (!/^\d{6}$/.test(code)) return null;
  const s = stepOf(now);
  let found = null;
  for (const step of [s - 1, s, s + 1]) { // all three compared every time: constant work whichever matches
    if (timingSafeEqual(Buffer.from(totp(key, step)), Buffer.from(code)) && (lastStep == null || step > lastStep)) found ??= step;
  }
  return found;
}

export const newSecret = () => base32(randomBytes(20)); // 160 bits, the RFC's recommended length
export const validSecret = (s) => typeof s === 'string' && /^[a-z2-7]{32}$/.test(s);
export const otpauthUri = (secret, email) =>
  `otpauth://totp/${encodeURIComponent(`Smart Fit:${email}`)}?secret=${secret.toUpperCase()}&issuer=${encodeURIComponent('Smart Fit')}&algorithm=SHA1&digits=6&period=30`;

// AES-256-GCM with a key derived from ADMIN_TOKEN_SECRET, so a database dump alone can't produce codes.
// Changing ADMIN_TOKEN_SECRET makes stored secrets unreadable: those admins sign in with a recovery code (or get a reset link).
const keyOf = (secret) => Buffer.from(hkdfSync('sha256', secret, 'smart-fit', 'totp-secret-v1', 32));
export function seal(secret, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map((x) => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
}
export function unseal(secret, sealed) {
  try {
    const [v, iv, tag, ct] = String(sealed).split('.');
    if (v !== 'v1') return null;
    const d = createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// Recovery codes: 80 random bits as "abcd-efgh-ijkl-mnop"; only the sha256 is stored (80 bits can't be brute-forced from it).
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const newRecoveryCode = () => base32(randomBytes(10)).match(/.{4}/g).join('-');
export const normCode = (s) => String(s ?? '').toLowerCase().replace(/[\s-]/g, '');
export const isRecoveryCode = (s) => /^[a-z2-7]{16}$/.test(normCode(s));
