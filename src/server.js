import { port } from './config.js';
import { createDb } from './db/index.js';
import { createApp } from './app.js';
import { releaseExpired } from './cart/cart.js';

const db = createDb();
await db.migrate.latest();
createApp(db).listen(port, () => console.log(`Smart Fit: http://localhost:${port}/api`));

// Expired holds also come back without any cart traffic, so recommendations see the stock again.
setInterval(() => releaseExpired(db).catch((err) => console.error('hold sweep failed:', err.message)), 60_000).unref();
