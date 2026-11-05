// Usage: npm run admin:create -- <email> [store_id]
// No store_id → super-admin; with store_id → manager of that store.
// Password comes from ADMIN_PASSWORD or is asked on stdin (kept out of argv/shell history).
import { createInterface } from 'node:readline/promises';
import '../config.js';
import { createDb } from '../db/index.js';
import { createAdmin } from './routes.js';

const [email, store] = process.argv.slice(2);
if (!email) {
  console.error('Usage: npm run admin:create -- <email> [store_id]');
  process.exit(1);
}
let password = process.env.ADMIN_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Parol (kamida 8 belgi): ');
  rl.close();
}
const db = createDb();
try {
  await db.migrate.latest();
  const id = await createAdmin(db, { email, password, storeId: store ? Number(store) : null });
  console.log(`Admin #${id} yaratildi: ${email} (${store ? `do'kon ${store} menejeri` : 'bosh admin'})`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
