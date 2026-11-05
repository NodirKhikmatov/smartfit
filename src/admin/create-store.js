// Usage: npm run store:create -- "<name>" "<city>" <lat> <lon> "<address>" <delivery_fee> [free_delivery_threshold]
// Prints the new store id: use it for the kiosk URL (/kiosk?store=<id>), the QR code and admin:create.
import '../config.js';
import { createDb } from '../db/index.js';
import { createStore } from './routes.js';

const [name, city, lat, lon, address, delivery_fee, free_delivery_threshold] = process.argv.slice(2);
if (!address) {
  console.error('Usage: npm run store:create -- "<name>" "<city>" <lat> <lon> "<address>" <delivery_fee> [free_delivery_threshold]');
  process.exit(1);
}
const db = createDb();
try {
  await db.migrate.latest();
  const id = await createStore(db, { name, city, lat, lon, address, delivery_fee: delivery_fee ?? 0, free_delivery_threshold });
  console.log(`Do'kon #${id} yaratildi: ${name}. Kiosk: /kiosk?store=${id}, telefon: /m?store=${id}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
