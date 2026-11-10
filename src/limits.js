// Per-IP token buckets for the public API (audit X2). Limits are requests per minute, from env (0 = off).
// The bucket holds `perMin` tokens and refills continuously, so a burst of perMin is fine and then 1 per 60/perMin s.
// shortcut: per-process memory, like the login lockout; move to a shared store if we run several instances.
import { createHash } from 'node:crypto';
import { fail } from './admin/routes.js';

const env = (name, dflt) => {
  const v = process.env[name];
  return v != null && /^\d+$/.test(v.trim()) ? Number(v) : dflt;
};

// Defaults sized for a store: every phone on the shop Wi-Fi shares one public IP with the kiosk.
export function limitConfig() {
  return {
    recommend: env('RATE_RECOMMEND_PER_MIN', 60),
    size: env('RATE_SIZE_PER_MIN', 30),
    cart: env('RATE_CART_PER_MIN', 300),
    catalog: env('RATE_CATALOG_PER_MIN', 300), // catalogue browsing, item pages and other-store reservations
    mall: env('RATE_MALL_PER_MIN', 300), // task 37: the mall screen's directory and search (a mall's kiosks share one IP)
    login: env('RATE_LOGIN_PER_MIN', 20),
    kiosk: env('RATE_KIOSK_PER_MIN', 30), // heartbeat: 1/min per kiosk
    pin: env('RATE_PIN_PER_MIN', 5), // staff exit PIN tries: a 4-digit PIN takes ~33 h to guess from one IP
    funnel: env('RATE_FUNNEL_PER_MIN', 120), // ≤ 5 events per customer visit, every device on the shop IP shares it
    scan: env('RATE_SCAN_PER_MIN', 120), // task 32: garment label scans (logged; over the limit still redirected, not logged)
    demo: env('RATE_DEMO_PER_MIN', 3), // landing page "Demo so'rash" form
    promo: env('RATE_PROMO_PER_MIN', 20), // task 26: promo code tries (right or wrong), on top of the cart bucket
    profile: env('RATE_PROFILE_PER_MIN', 20), // task 27: new profile links / kiosk login QRs, the profile page
    profilePoll: env('RATE_PROFILE_POLL_PER_MIN', 300), // the screens waiting for the bot poll every 3 s
    openCarts: env('MAX_OPEN_CARTS_PER_IP', 30),
  };
}

// Express middleware. `now` is injectable for tests.
export function rateLimit(perMin, { now = Date.now } = {}) {
  if (!perMin) return (req, res, next) => next();
  const buckets = new Map(); // ip -> { tokens, at }
  const rate = perMin / 60_000; // tokens per ms
  return (req, res, next) => {
    const t = now();
    if (buckets.size > 10_000) for (const [ip, b] of buckets) if (b.tokens + (t - b.at) * rate >= perMin) buckets.delete(ip); // full again = forget
    const b = buckets.get(req.ip) ?? { tokens: perMin, at: t };
    b.tokens = Math.min(perMin, b.tokens + (t - b.at) * rate);
    b.at = t;
    buckets.set(req.ip, b);
    if (b.tokens < 1) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000))));
      throw fail(429, 'err.rate_limited');
    }
    b.tokens -= 1;
    next();
  };
}

// Short, non-reversible-at-a-glance key for "who opened this cart"; only used to count open carts.
export const clientKey = (ip) => createHash('sha256').update(String(ip)).digest('hex').slice(0, 16);
