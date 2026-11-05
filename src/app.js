import express from 'express';

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.get('/health', async (req, res) => {
    await db.raw('select 1');
    res.json({ ok: true });
  });
  api.use((req, res) => res.status(404).json({ error: 'Topilmadi' }));
  app.use('/api', api);

  // Express 5 forwards async errors here. Never leak stack traces to clients.
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Server xatosi' : 'Noto\'g\'ri so\'rov' });
  });

  return app;
}
