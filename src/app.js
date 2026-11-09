import express from 'express';
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

// uploadDir holds product images only. Customer photos are never written anywhere.
export function createApp(db, { uploadDir = process.env.UPLOAD_DIR || 'uploads', weather = createWeather(), stylist = createStylist(), stylistTimeoutMs, payments = paymentConfig(), telegram = telegramConfig(), trustProxy = process.env.TRUST_PROXY, logRequests = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
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
  api.use('/admin', createAdminRouter(db, { uploadDir }));
  api.use('/sync', createSyncRouter(db)); // POS / ERP stock push, per-store API key
  api.use('/recommend', createRecommendRouter(db, { weather, stylist, stylistTimeoutMs }));
  api.use('/stores', createStoreRouter(db, { weather }));
  api.use('/size', createSizeRouter());
  const methods = paymentMethods(payments), link = telegramLink(telegram);
  api.use('/cart', createCartRouter(db, { methods, link }));
  api.use('/orders', createOrderRouter(db, { methods, link }));
  api.use(() => { throw fail(404, 'err.not_found'); });
  app.use('/api', api);
  // Design system (ui.css, ui.js, icons, fonts) shared by the customer app and admin.
  const shared = fileURLToPath(new URL('../public/shared', import.meta.url));
  app.use('/shared', express.static(shared, { index: false }));
  app.get('/favicon.ico', (req, res) => res.sendFile('favicon.ico', { root: shared, maxAge: '7d' }));
  // Dev page showing every component; not part of the product, so not served in production.
  if (process.env.NODE_ENV !== 'production') app.get('/styleguide', (req, res) => res.sendFile('styleguide.html', { root: shared }));
  app.use('/admin', express.static(fileURLToPath(new URL('../public/admin', import.meta.url))));
  // Customer app: one page for the kiosk and the phone; app.js picks the mode from the path.
  const customer = fileURLToPath(new URL('../public/app', import.meta.url));
  app.get(['/kiosk', '/m'], (req, res) => res.sendFile('index.html', { root: customer }));
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
