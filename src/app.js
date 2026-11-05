import express from 'express';
import { fileURLToPath } from 'node:url';
import { createAdminRouter } from './admin/routes.js';
import { createRecommendRouter, createStoreRouter } from './recommend/routes.js';
import { createWeather } from './recommend/weather.js';
import { createStylist } from './recommend/stylist.js';
import { createSizeRouter } from './size/size.js';
import { createCartRouter } from './cart/cart.js';
import { paymentConfig, paymentMethods, createPaymentRouter } from './cart/payments.js';
import { telegramConfig, telegramLink } from './notify/telegram.js';

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
  api.use('/recommend', createRecommendRouter(db, { weather, stylist, stylistTimeoutMs }));
  api.use('/stores', createStoreRouter(db, { weather }));
  api.use('/size', createSizeRouter());
  api.use('/cart', createCartRouter(db, { methods: paymentMethods(payments), link: telegramLink(telegram) }));
  api.use((req, res) => res.status(404).json({ error: 'Topilmadi' }));
  app.use('/api', api);
  app.use('/admin', express.static(fileURLToPath(new URL('../public/admin', import.meta.url))));
  // Customer app: one page for the kiosk and the phone; app.js picks the mode from the path.
  const customer = fileURLToPath(new URL('../public/app', import.meta.url));
  app.get(['/kiosk', '/m'], (req, res) => res.sendFile('index.html', { root: customer }));
  app.use('/app', express.static(customer, { index: false }));
  app.use('/uploads', express.static(uploadDir, { index: false, setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff') }));

  // Express 5 forwards async errors here. Never leak stack traces to clients.
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    const message = err.type === 'entity.too.large' ? 'Fayl juda katta' : err.publicMessage || 'Noto\'g\'ri so\'rov';
    res.status(status).json({ error: status >= 500 ? 'Server xatosi' : message });
  });

  return app;
}
