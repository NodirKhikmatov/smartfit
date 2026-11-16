import { port } from './config.js';
import { installLogging } from './log.js';
import { createDb } from './db/index.js';
import { createApp } from './app.js';
import { releaseExpired } from './cart/cart.js';
import { expirePoints } from './cart/points.js';
import { startNotifications } from './notify/telegram.js';

installLogging();
process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));
process.on('uncaughtException', (err) => {
  console.error('uncaught exception:', err);
  setTimeout(() => process.exit(1), 1000); // let the error webhook go out first
});

const db = createDb();
await db.migrate.latest();
createApp(db, { logRequests: true }).listen(port, () => console.log(`Smart Fit: http://localhost:${port}/api`));

// Expired holds also come back without any cart traffic, so recommendations see the stock again.
setInterval(() => releaseExpired(db).catch((err) => console.error('hold sweep failed:', err.message)), 60_000).unref();

// Task 39: points past their organisation's expiry term become 'expire' ledger rows (safe beside checkouts and other processes).
const sweepPoints = () => expirePoints(db).catch((err) => console.error('points expiry sweep failed:', err.message));
sweepPoints();
setInterval(sweepPoints, 60 * 60_000).unref();

// Order messages to customers (Telegram); off until the bot is configured in .env.
startNotifications(db);
