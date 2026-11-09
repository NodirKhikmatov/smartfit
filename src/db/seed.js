// Demo data: 2 stores × 25 items covering all seasons. Wipes all data first (dev only).
import { pathToFileURL } from 'node:url';

export const STORES = [
  { name: 'Smart Fit Toshkent', city: 'Toshkent', lat: 41.2995, lon: 69.2401, address: 'Amir Temur ko\'chasi, 15', delivery_fee: 25000, free_delivery_threshold: 1000000 },
  { name: 'Smart Fit Samarqand', city: 'Samarqand', lat: 39.6542, lon: 66.9597, address: 'Registon ko\'chasi, 7', delivery_fee: 20000, free_delivery_threshold: 800000 },
];

const CLOTHES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const SHOES = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'];
const ONE = ['ONE'];

// [name, category, gender, color, style, price, discount_price, temp_min, temp_max, waterproof, name_ru]
// Ranges give ≥2 items per required category and gender at −10, 5, 15 and 30 °C.
export const CATALOGUE = [
  ['Qishki puxovik', 'outerwear', 'unisex', 'qora', 'casual', 1290000, 990000, -25, 0, true, 'Зимний пуховик'],
  ['Jun palto', 'outerwear', 'female', 'bej', 'classic', 1150000, null, -15, 8, false, 'Шерстяное пальто'],
  ['Charm kurtka', 'outerwear', 'male', 'jigarrang', 'classic', 1450000, null, -15, 10, false, 'Кожаная куртка'],
  ['Plashch', 'outerwear', 'unisex', 'bej', 'classic', 890000, 750000, 5, 17, true, 'Плащ'],
  ['Yengil vetrovka', 'outerwear', 'unisex', 'to\'q ko\'k', 'sport', 420000, null, 8, 20, true, 'Лёгкая ветровка'],
  ['Issiq sviter', 'top', 'unisex', 'kulrang', 'casual', 380000, null, -25, 10, false, 'Тёплый свитер'],
  ['Hudi', 'top', 'unisex', 'qora', 'sport', 290000, 240000, -10, 18, false, 'Худи'],
  ['Klassik ko\'ylak', 'top', 'male', 'oq', 'classic', 260000, null, 8, 30, false, 'Классическая рубашка'],
  ['Bluzka', 'top', 'female', 'qizil', 'classic', 240000, null, 10, 32, false, 'Блузка'],
  ['Paxta futbolka', 'top', 'unisex', 'oq', 'casual', 120000, 99000, 18, 40, false, 'Хлопковая футболка'],
  ['Polo', 'top', 'male', 'yashil', 'sport', 180000, null, 18, 38, false, 'Поло'],
  ['Longsliv', 'top', 'female', 'sariq', 'casual', 160000, null, 0, 22, false, 'Лонгслив'],
  ['Isitilgan jinsi', 'bottom', 'unisex', 'to\'q ko\'k', 'casual', 420000, null, -25, 8, false, 'Утеплённые джинсы'],
  ['Klassik jinsi', 'bottom', 'unisex', 'ko\'k', 'casual', 350000, 290000, -10, 25, false, 'Классические джинсы'],
  ['Chino shim', 'bottom', 'male', 'bej', 'classic', 310000, null, 10, 32, false, 'Брюки чинос'],
  ['Midi yubka', 'bottom', 'female', 'qora', 'classic', 270000, null, 12, 32, false, 'Юбка миди'],
  ['Shorti', 'bottom', 'unisex', 'kulrang', 'sport', 150000, null, 22, 40, false, 'Шорты'],
  ['Jun shim', 'bottom', 'female', 'kulrang', 'classic', 390000, null, -20, 10, false, 'Шерстяные брюки'],
  ['Qishki etik', 'shoes', 'unisex', 'qora', 'casual', 950000, 790000, -25, 5, true, 'Зимние сапоги'],
  ['Charm botinka', 'shoes', 'unisex', 'jigarrang', 'classic', 820000, null, -10, 15, true, 'Кожаные ботинки'],
  ['Krossovka', 'shoes', 'unisex', 'oq', 'sport', 590000, null, 5, 30, false, 'Кроссовки'],
  ['Sandal', 'shoes', 'unisex', 'bej', 'casual', 230000, null, 22, 40, false, 'Сандалии'],
  ['Jun sharf', 'accessory', 'unisex', 'qizil', 'casual', 140000, null, -25, 5, false, 'Шерстяной шарф'],
  ['Trikotaj shapka', 'accessory', 'unisex', 'kulrang', 'casual', 90000, null, -25, 5, false, 'Вязаная шапка'],
  ['Kepka', 'accessory', 'unisex', 'qora', 'sport', 85000, 70000, 18, 40, false, 'Кепка'],
];

export const sizesFor = (category) => (category === 'shoes' ? SHOES : category === 'accessory' ? ONE : CLOTHES);

// Deterministic stock 0–5 per size, so some sizes are sold out (exercises the stock > 0 rule).
const stockFor = (item, size, storeIdx, sizeCount) => (sizeCount === 1 ? 5 : (item * 7 + size * 5 + storeIdx * 3) % 6);

export async function seed(db) {
  if (process.env.NODE_ENV === 'production') throw new Error('Seed wipes all data; refusing to run in production');
  await db.transaction(async (trx) => {
    for (const t of ['payment_transactions', 'order_items', 'orders', 'recommendation_logs', 'cart_items', 'carts', 'product_stock', 'products', 'admins', 'stores']) {
      await trx(t).del();
    }
    for (const [storeIdx, store] of STORES.entries()) {
      const [{ id: storeId }] = await trx('stores').insert(store).returning('id');
      for (const [i, [name, category, gender, color, style, price, discount_price, temp_min, temp_max, waterproof, name_ru]] of CATALOGUE.entries()) {
        const [{ id: productId }] = await trx('products')
          .insert({ store_id: storeId, name, name_ru, category, gender, color, style, price, discount_price, temp_min, temp_max, waterproof, shelf_location: `${'ABCDE'[i % 5]}-${i + 1}` })
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
