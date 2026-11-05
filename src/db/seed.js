// Demo data: 2 stores × 25 items covering all seasons. Wipes all data first (dev only).
import { pathToFileURL } from 'node:url';

export const STORES = [
  { name: 'Smart Fit Toshkent', city: 'Toshkent', lat: 41.2995, lon: 69.2401, address: 'Amir Temur ko\'chasi, 15', delivery_fee: 25000, free_delivery_threshold: 1000000 },
  { name: 'Smart Fit Samarqand', city: 'Samarqand', lat: 39.6542, lon: 66.9597, address: 'Registon ko\'chasi, 7', delivery_fee: 20000, free_delivery_threshold: 800000 },
];

const CLOTHES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const SHOES = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'];
const ONE = ['ONE'];

// [name, category, gender, color, style, price, discount_price, temp_min, temp_max, waterproof]
// Ranges give ≥2 items per required category and gender at −10, 5, 15 and 30 °C.
export const CATALOGUE = [
  ['Qishki puxovik', 'outerwear', 'unisex', 'qora', 'casual', 1290000, 990000, -25, 0, true],
  ['Jun palto', 'outerwear', 'female', 'bej', 'classic', 1150000, null, -15, 8, false],
  ['Charm kurtka', 'outerwear', 'male', 'jigarrang', 'classic', 1450000, null, -15, 10, false],
  ['Plashch', 'outerwear', 'unisex', 'bej', 'classic', 890000, 750000, 5, 17, true],
  ['Yengil vetrovka', 'outerwear', 'unisex', 'to\'q ko\'k', 'sport', 420000, null, 8, 20, true],
  ['Issiq sviter', 'top', 'unisex', 'kulrang', 'casual', 380000, null, -25, 10, false],
  ['Hudi', 'top', 'unisex', 'qora', 'sport', 290000, 240000, -10, 18, false],
  ['Klassik ko\'ylak', 'top', 'male', 'oq', 'classic', 260000, null, 8, 30, false],
  ['Bluzka', 'top', 'female', 'qizil', 'classic', 240000, null, 10, 32, false],
  ['Paxta futbolka', 'top', 'unisex', 'oq', 'casual', 120000, 99000, 18, 40, false],
  ['Polo', 'top', 'male', 'yashil', 'sport', 180000, null, 18, 38, false],
  ['Longsliv', 'top', 'female', 'sariq', 'casual', 160000, null, 0, 22, false],
  ['Isitilgan jinsi', 'bottom', 'unisex', 'to\'q ko\'k', 'casual', 420000, null, -25, 8, false],
  ['Klassik jinsi', 'bottom', 'unisex', 'ko\'k', 'casual', 350000, 290000, -10, 25, false],
  ['Chino shim', 'bottom', 'male', 'bej', 'classic', 310000, null, 10, 32, false],
  ['Midi yubka', 'bottom', 'female', 'qora', 'classic', 270000, null, 12, 32, false],
  ['Shorti', 'bottom', 'unisex', 'kulrang', 'sport', 150000, null, 22, 40, false],
  ['Jun shim', 'bottom', 'female', 'kulrang', 'classic', 390000, null, -20, 10, false],
  ['Qishki etik', 'shoes', 'unisex', 'qora', 'casual', 950000, 790000, -25, 5, true],
  ['Charm botinka', 'shoes', 'unisex', 'jigarrang', 'classic', 820000, null, -10, 15, true],
  ['Krossovka', 'shoes', 'unisex', 'oq', 'sport', 590000, null, 5, 30, false],
  ['Sandal', 'shoes', 'unisex', 'bej', 'casual', 230000, null, 22, 40, false],
  ['Jun sharf', 'accessory', 'unisex', 'qizil', 'casual', 140000, null, -25, 5, false],
  ['Trikotaj shapka', 'accessory', 'unisex', 'kulrang', 'casual', 90000, null, -25, 5, false],
  ['Kepka', 'accessory', 'unisex', 'qora', 'sport', 85000, 70000, 18, 40, false],
];

const sizesFor = (category) => (category === 'shoes' ? SHOES : category === 'accessory' ? ONE : CLOTHES);

// Deterministic stock 0–5 per size, so some sizes are sold out (exercises the stock > 0 rule).
const stockFor = (item, size, storeIdx, sizeCount) => (sizeCount === 1 ? 5 : (item * 7 + size * 5 + storeIdx * 3) % 6);

export async function seed(db) {
  if (process.env.NODE_ENV === 'production') throw new Error('Seed wipes all data; refusing to run in production');
  await db.transaction(async (trx) => {
    for (const t of ['order_items', 'orders', 'recommendation_logs', 'carts', 'product_stock', 'products', 'admins', 'stores']) {
      await trx(t).del();
    }
    for (const [storeIdx, store] of STORES.entries()) {
      const [{ id: storeId }] = await trx('stores').insert(store).returning('id');
      for (const [i, [name, category, gender, color, style, price, discount_price, temp_min, temp_max, waterproof]] of CATALOGUE.entries()) {
        const [{ id: productId }] = await trx('products')
          .insert({ store_id: storeId, name, category, gender, color, style, price, discount_price, temp_min, temp_max, waterproof, shelf_location: `${'ABCDE'[i % 5]}-${i + 1}` })
          .returning('id');
        const sizes = sizesFor(category);
        await trx('product_stock').insert(sizes.map((size, s) => ({ product_id: productId, size, quantity: stockFor(i, s, storeIdx, sizes.length) })));
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import('../config.js');
  const { createDb } = await import('./index.js');
  const db = createDb();
  try {
    await db.migrate.latest();
    await seed(db);
    console.log(`Seed: ${STORES.length} do'kon, ${STORES.length * CATALOGUE.length} kiyim`);
  } finally {
    await db.destroy();
  }
}
