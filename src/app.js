import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAdminRouter } from './admin/routes.js';
import { createSyncRouter } from './admin/sync.js';
import { createRecommendRouter, createStoreRouter } from './recommend/routes.js';
import { createWeather } from './recommend/weather.js';
import { createStylist } from './recommend/stylist.js';
import { createSizeRouter } from './size/size.js';
import { createCartRouter, createOrderRouter } from './cart/cart.js';
import { paymentConfig, paymentMethods, createPaymentRouter } from './cart/payments.js';
import { telegramConfig, telegramLink } from './notify/telegram.js';
import { fail, langOf, errorBody } from './admin/routes.js';
import { limitConfig, rateLimit } from './limits.js';
import { createKioskRouter } from './kiosk.js';
import { createDemoRouter } from './admin/orgs.js';
import { createLandingRouter } from './landing.js';
import { createFunnelRouter } from './demand.js';
import { createCatalogRouter } from './catalog.js';
import { VENDOR, MODEL } from './vendor.js';

// X1: same-origin only, plus OpenStreetMap tiles for the delivery map. 'wasm-unsafe-eval' lets MediaPipe compile its wasm
// (it can't run JS from strings). No 'unsafe-inline': styles are files or CSSOM, scripts are modules.
export const CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'", "img-src 'self' data: blob: https://tile.openstreetmap.org",
  "font-src 'self'", "connect-src 'self'", "media-src 'self' blob:", "worker-src 'self'", "manifest-src 'self'",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self), screen-wake-lock=(self)',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', // frame-ancestors for old browsers
};
const IMMUTABLE = { maxAge: '365d', immutable: true, index: false }; // /vendor paths carry the version

// uploadDir holds product images only. Customer photos are never written anywhere.
export function createApp(db, { uploadDir = process.env.UPLOAD_DIR || 'uploads', weather = createWeather(), stylist = createStylist(), stylistTimeoutMs, payments = paymentConfig(), telegram = telegramConfig(), trustProxy = process.env.TRUST_PROXY, logRequests = false, limits = {}, now } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });
  const lim = { ...limitConfig(), ...limits };
  const bucket = (name) => rateLimit(lim[name], { now });
  // Behind Caddy: TRUST_PROXY=1 (one hop) so req.ip / req.protocol are the client's, for the login lock, the AI cap and QR URLs.
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  // One line per request: method, path without query, status, time. Tokens in paths are redacted by src/log.js.
  if (logRequests) {
    app.use((req, res, next) => {
      const start = performance.now();
      const path = req.originalUrl.split('?')[0]; // read now: mounted routers rewrite req.url
      res.on('finish', () => console.info({ msg: 'request', method: req.method, path, status: res.statusCode, ms: Math.round(performance.now() - start), ip: req.ip }));
      next();
    });
  }
  app.use('/api/pay', createPaymentRouter(db, payments)); // Click/Payme callbacks parse their own bodies
  // /api/recommend may carry one small customer photo for the stylist (capped again in stylist.js); everything else 100 kb.
  app.use('/api/recommend', express.json({ limit: '400kb' }));
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.get('/health', async (req, res) => {
    await db.raw('select 1');
    res.json({ ok: true });
  });
  api.post('/admin/login', bucket('login')); // on top of the wrong-password lockout
  api.use('/admin', createAdminRouter(db, { uploadDir }));
  api.use('/sync', createSyncRouter(db)); // POS / ERP stock push, per-store API key
  api.use('/recommend', bucket('recommend'), createRecommendRouter(db, { weather, stylist, stylistTimeoutMs }));
  api.use('/stores', createStoreRouter(db, { weather }));
  api.use('/size', bucket('size'), createSizeRouter());
  const methods = paymentMethods(payments), link = telegramLink(telegram);
  api.use('/cart', bucket('cart'), createCartRouter(db, { methods, link, maxOpenCarts: lim.openCarts }));
  api.post('/kiosk/exit', bucket('pin'));
  api.use('/kiosk', bucket('kiosk'), createKioskRouter(db));
  api.use('/catalog', bucket('catalog'), createCatalogRouter(db, { link, maxOpen: lim.openCarts })); // task 25
  api.use('/funnel', bucket('funnel'), createFunnelRouter(db)); // task 24: drop-off by step
  api.use('/orders', createOrderRouter(db, { methods, link }));
  api.use('/demo-requests', bucket('demo'), createDemoRouter(db));
  api.use(() => { throw fail(404, 'err.not_found'); });
  app.use('/api', api);
  // Design system (ui.css, ui.js, icons, fonts) shared by the customer app and admin.
  const shared = fileURLToPath(new URL('../public/shared', import.meta.url));
  app.use('/shared', express.static(shared, { index: false }));
  app.get('/favicon.ico', (req, res) => res.sendFile('favicon.ico', { root: shared, maxAge: '7d' }));
  // Dev page showing every component; not part of the product, so not served in production. Its demo uses inline code.
  if (process.env.NODE_ENV !== 'production') {
    app.get('/styleguide', (req, res) => res.set('Content-Security-Policy', CSP.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")).sendFile('styleguide.html', { root: shared }));
  }
  // X3: MediaPipe and Leaflet from their pinned npm packages, the pose model from vendor/ (npm run vendor). Same origin, cached for a year.
  for (const v of Object.values(VENDOR)) app.use(v.path, express.static(v.dir, IMMUTABLE));
  app.get(MODEL.path, (req, res, next) => (existsSync(MODEL.file) ? res.sendFile(MODEL.file, { ...IMMUTABLE, headers: { 'Content-Type': 'application/octet-stream' } }) : next()));
  app.use('/admin', express.static(fileURLToPath(new URL('../public/admin', import.meta.url))));
  app.use(createLandingRouter()); // / and /landing/*
  // Customer app: one page for the kiosk and the phone; app.js picks the mode from the path.
  const customer = fileURLToPath(new URL('../public/app', import.meta.url));
  app.get(['/kiosk', '/m'], (req, res) => res.sendFile('index.html', { root: customer }));
  // Kiosk PWA: the service worker at the root (its scope must cover /kiosk) and a manifest that starts at this store's kiosk.
  app.get('/kiosk-sw.js', (req, res) => res.set('Cache-Control', 'no-cache').sendFile('sw.js', { root: customer }));
  app.get('/kiosk.webmanifest', (req, res) => {
    const store = Number(req.query.store);
    res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify({
      name: 'Smart Fit', short_name: 'Smart Fit', lang: 'uz', display: 'fullscreen', background_color: '#f6f3ee', theme_color: '#1f5a46',
      start_url: Number.isInteger(store) && store > 0 ? `/kiosk?store=${store}` : '/kiosk', scope: '/kiosk',
      icons: [{ src: '/shared/favicon.svg', sizes: 'any', type: 'image/svg+xml' }, { src: '/shared/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    }));
  });
  // Order status page; the token in its URL must not leak to the payment provider through Referer.
  app.get('/order/:token', (req, res) => res.set('Referrer-Policy', 'no-referrer').sendFile('order.html', { root: customer }));
  app.use('/app', express.static(customer, { index: false }));
  app.use('/uploads', express.static(uploadDir, { index: false, setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff') }));

  // Express 5 forwards async errors here. Never leak stack traces to clients. Body: { code, error } in the request's language.
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    const key = status >= 500 ? 'err.server' : err.type === 'entity.too.large' ? 'err.too_large' : err.publicKey || 'err.bad_request';
    res.status(status).json(errorBody(langOf(req), { publicKey: key, vars: err.vars }));
  });

  return app;
}
