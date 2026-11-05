import { port } from './config.js';
import { createDb } from './db/index.js';
import { createApp } from './app.js';

const db = createDb();
await db.migrate.latest();
createApp(db).listen(port, () => console.log(`Smart Fit: http://localhost:${port}/api`));
