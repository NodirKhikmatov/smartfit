import express from 'express';
import { fileURLToPath } from 'node:url';
import { createAdminRouter } from './admin/routes.js';
import { createRecommendRouter, createStoreRouter } from './recommend/routes.js';
import { createWeather } from './recommend/weather.js';
import { createSizeRouter } from './size/size.js';

// uploadDir holds product images only. Customer photos are never written anywhere.
export function createApp(db, { uploadDir = process.env.UPLOAD_DIR || 'uploads', weather = createWeather() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.get('/health', async (req, res) => {
    await db.raw('select 1');
    res.json({ ok: true });
  });
  api.use('/admin', createAdminRouter(db, { uploadDir }));
  api.use('/recommend', createRecommendRouter(db, { weather }));
  api.use('/stores', createStoreRouter(db, { weather }));
  api.use('/size', createSizeRouter());
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
