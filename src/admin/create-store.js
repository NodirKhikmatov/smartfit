// Usage: npm run store:create -- "<name>" "<city>" <lat> <lon> "<address>" <delivery_fee> [free_delivery_threshold] [organization_id]
// Without organization_id the store joins the only organisation (a new one named after the store on a fresh install).
// Prints the new store id: use it for the kiosk URL (/kiosk?store=<id>), the QR code and admin:create.
import '../config.js';
import { createDb } from '../db/index.js';
import { createStore } from './routes.js';

const [name, city, lat, lon, address, delivery_fee, free_delivery_threshold, orgId] = process.argv.slice(2);
if (!address) {
  console.error('Usage: npm run store:create -- "<name>" "<city>" <lat> <lon> "<address>" <delivery_fee> [free_delivery_threshold] [organization_id]');
  process.exit(1);
}
const db = createDb();
try {
  await db.migrate.latest();
  const id = await createStore(db, { name, city, lat, lon, address, delivery_fee: delivery_fee ?? 0, free_delivery_threshold: free_delivery_threshold || null, orgId: orgId || null });
  console.log(`Do'kon #${id} yaratildi: ${name}. Kiosk: /kiosk?store=${id}, telefon: /m?store=${id}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
