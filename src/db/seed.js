// Demo data: 2 stores × ~76 items with economy/mid/premium prices, SKUs, descriptions and a demo image each.
// Wipes all data first (dev only). Coverage (3 outfits for every gender × size × store × season) is tested.
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtinRows } from './migrations/023_categories.js';

// Task 37: one demo mall holding both demo shops, so /kiosk?mall=1 shows the mall screen. The demo has one store per
// brand, so the Samarqand brand's store joins it too (a second Tashkent store would change every demo-store test).
export const DEMO_MALL = { name: 'Demo Savdo Markazi', city: 'Toshkent', address: "Amir Temur ko'chasi, 15", lat: 41.2995, lon: 69.2401 };
const MALL_ENTRY = [{ mall_floor: '1', mall_unit: '104' }, { mall_floor: '2', mall_unit: '215' }];
export const STORES = [
  { name: 'Smart Fit Toshkent', city: 'Toshkent', lat: 41.2995, lon: 69.2401, address: 'Amir Temur ko\'chasi, 15', delivery_fee: 25000, free_delivery_threshold: 1000000 },
  { name: 'Smart Fit Samarqand', city: 'Samarqand', lat: 39.6542, lon: 66.9597, address: 'Registon ko\'chasi, 7', delivery_fee: 20000, free_delivery_threshold: 800000 },
];

const CLOTHES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const SHOES = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'];
const ONE = ['ONE'];
// Task 40: children's clothes by height band (size = the tallest height it fits: 116 = 111–116 cm) and children's shoes.
export const KIDS = ['92', '98', '104', '110', '116', '122', '128', '134', '140', '146', '152', '158', '164'];
export const KIDS_SHOES = Array.from({ length: 14 }, (_, i) => String(22 + i));

export const IMAGE_DIR = fileURLToPath(new URL('../../demo/images/', import.meta.url));

// [sku, name, name_ru, category, gender, color, style, price, discount_price, temp_min, temp_max, waterproof, art, stores, description]
// art = demo illustration (demo/make-images.js). stores: T = Toshkent, S = Samarqand.
const ROWS = [
  ['SF-OW-01', 'Qishki puxovik', 'Зимний пуховик', 'outerwear', 'unisex', 'qora', 'casual', 1290000, 990000, -25, 0, true, 'puffer', 'TS', "Qalin pat to'ldirilgan, kapyushonli, suv o'tkazmaydi."],
  ['SF-OW-02', 'Parka', 'Парка', 'outerwear', 'unisex', 'zaytun', 'casual', 1150000, null, -20, 5, true, 'parka', 'TS', "Uzun parka, issiq astarli va kapyushonli."],
  ['SF-OW-03', 'Yengil puxovik', 'Лёгкий пуховик', 'outerwear', 'unisex', "to'q ko'k", 'sport', 690000, null, -12, 10, false, 'puffer', 'TS', "Yengil, yig'ilganda sumkaga sig'adi."],
  ['SF-OW-04', 'Kalta puxovik', 'Короткий пуховик', 'outerwear', 'female', 'bej', 'casual', 890000, 760000, -15, 3, false, 'puffer', 'TS', "Bel chizig'igacha, yumshoq yoqali."],
  ['SF-OW-05', 'Jun palto', 'Шерстяное пальто', 'outerwear', 'female', 'bej', 'classic', 1150000, null, -12, 10, false, 'coat', 'TS', "Jun aralash mato, ikki qator tugmali."],
  ['SF-OW-06', 'Klassik palto', 'Классическое пальто', 'outerwear', 'male', 'kulrang', 'classic', 1390000, null, -12, 10, false, 'coat', 'TS', "To'g'ri bichim, tizzagacha, jun aralash."],
  ['SF-OW-07', 'Charm kurtka', 'Кожаная куртка', 'outerwear', 'male', 'jigarrang', 'classic', 1450000, null, -5, 14, false, 'leather', 'TS', "Tabiiy charm, metall zamokli."],
  ['SF-OW-08', 'Eko-charm kurtka', 'Куртка из экокожи', 'outerwear', 'female', 'qora', 'casual', 520000, 449000, -2, 15, false, 'leather', 'TS', "Eko-charm, qiya zamokli bayker bichim."],
  ['SF-OW-09', 'Plashch', 'Плащ', 'outerwear', 'unisex', 'bej', 'classic', 890000, 750000, 5, 19, true, 'trench', 'TS', "Klassik trench, kamarli, suv o'tkazmaydi."],
  ['SF-OW-10', 'Yengil vetrovka', 'Лёгкая ветровка', 'outerwear', 'unisex', "to'q ko'k", 'sport', 420000, null, 8, 22, true, 'windbreaker', 'TS', "Shamol va yomg'irdan himoya, kapyushonli."],
  ['SF-OW-11', 'Jinsi kurtka', 'Джинсовая куртка', 'outerwear', 'unisex', "ko'k", 'casual', 380000, null, 10, 22, false, 'denim', 'TS', "Paxta denim, ko'krak cho'ntaklari bilan."],
  ['SF-OW-12', "Yomg'irpo'sh", 'Дождевик', 'outerwear', 'unisex', 'sariq', 'casual', 290000, null, 8, 24, true, 'windbreaker', 'TS', "Yengil yomg'irpo'sh, choklari yopishtirilgan."],
  ['SF-OW-13', 'Bomber', 'Бомбер', 'outerwear', 'male', 'zaytun', 'casual', 460000, null, 5, 18, false, 'bomber', 'TS', "Trikotaj manjetli, yengil astarli."],
  ['SF-OW-14', 'Erkaklar pidjagi', 'Мужской пиджак', 'outerwear', 'male', "to'q ko'k", 'classic', 790000, null, 10, 24, false, 'blazer', 'TS', "Ikki tugmali, yarim astarli."],
  ['SF-OW-15', 'Ayollar pidjagi', 'Женский пиджак', 'outerwear', 'female', 'qora', 'classic', 690000, 590000, 10, 24, false, 'blazer', 'TS', "Erkin bichim, bitta tugmali."],
  ['SF-OW-16', 'Issiq jilet', 'Тёплый жилет', 'outerwear', 'unisex', 'qora', 'sport', 350000, null, -5, 12, false, 'gilet', 'TS', "Yengsiz, qavatli, sviter ustidan kiyiladi."],
  ['SF-OW-17', 'Softshell kurtka', 'Куртка софтшелл', 'outerwear', 'unisex', 'kulrang', 'sport', 540000, null, 0, 16, true, 'windbreaker', 'TS', "Ichi flisli, shamol o'tkazmaydi."],
  ['SF-OW-18', 'Qishki palto', 'Зимнее пальто', 'outerwear', 'male', 'qora', 'classic', 1690000, null, -20, 2, false, 'coat', 'T', "Issiq astarli jun palto, tizzadan past."],
  ['SF-OW-19', 'Uzun puxovik', 'Длинный пуховик', 'outerwear', 'female', 'qora', 'casual', 1490000, 1290000, -25, -2, true, 'puffer', 'S', "Tizzagacha, qalin pat, kapyushonli."],

  ['SF-TP-01', 'Issiq sviter', 'Тёплый свитер', 'top', 'unisex', 'kulrang', 'casual', 380000, null, -25, 10, false, 'sweater', 'TS', "Qalin trikotaj, yumshoq jun aralash."],
  ['SF-TP-02', 'Hudi', 'Худи', 'top', 'unisex', 'qora', 'sport', 290000, 240000, -10, 18, false, 'hoodie', 'TS', "Ichi tukli paxta, kenguru cho'ntakli."],
  ['SF-TP-03', "Klassik ko'ylak", 'Классическая рубашка', 'top', 'male', 'oq', 'classic', 260000, null, 5, 30, false, 'shirt', 'TS', "Paxta poplin, tugmali yoqa."],
  ['SF-TP-04', 'Bluzka', 'Блузка', 'top', 'female', 'qizil', 'classic', 240000, null, 10, 32, false, 'blouse', 'TS', "Yengil viskoza, bo'yni bog'ichli."],
  ['SF-TP-05', 'Paxta futbolka', 'Хлопковая футболка', 'top', 'unisex', 'oq', 'casual', 120000, 99000, 18, 40, false, 'tshirt', 'TS', "100% paxta, erkin bichim."],
  ['SF-TP-06', 'Polo', 'Поло', 'top', 'male', 'yashil', 'sport', 180000, null, 18, 38, false, 'polo', 'TS', "Pike trikotaj, uch tugmali."],
  ['SF-TP-07', 'Longsliv', 'Лонгслив', 'top', 'female', 'sariq', 'casual', 160000, null, 0, 22, false, 'longsleeve', 'TS', "Uzun yengli yupqa trikotaj."],
  ['SF-TP-08', 'Vodolazka', 'Водолазка', 'top', 'unisex', 'qora', 'classic', 220000, null, -20, 12, false, 'turtleneck', 'TS', "Baland yoqali, cho'ziluvchan trikotaj."],
  ['SF-TP-09', 'Kashemir sviter', 'Кашемировый свитер', 'top', 'female', 'krem', 'classic', 890000, null, -15, 12, false, 'sweater', 'T', "Kashemir aralash, juda yumshoq."],
  ['SF-TP-10', 'Jun sviter', 'Шерстяной свитер', 'top', 'male', "to'q ko'k", 'classic', 650000, null, -20, 10, false, 'sweater', 'TS', "Merinos jun, dumaloq yoqa."],
  ['SF-TP-11', 'Kardigan', 'Кардиган', 'top', 'female', 'bej', 'casual', 340000, null, 0, 18, false, 'cardigan', 'TS', "Tugmali, yumshoq trikotaj."],
  ['SF-TP-12', "Flanel ko'ylak", 'Фланелевая рубашка', 'top', 'male', 'bordo', 'casual', 280000, null, -5, 18, false, 'shirt', 'S', "Issiq flanel, ikki cho'ntakli."],
  ['SF-TP-13', 'Bazaviy futbolka', 'Базовая футболка', 'top', 'unisex', 'qora', 'casual', 89000, null, 18, 40, false, 'tshirt', 'TS', "Har kunlik paxta futbolka."],
  ['SF-TP-14', "Zig'ir ko'ylak", 'Льняная рубашка', 'top', 'male', 'havorang', 'casual', 330000, null, 22, 40, false, 'shirt', 'T', "Toza zig'ir, issiqda salqin."],
  ['SF-TP-15', 'Top', 'Топ', 'top', 'female', 'pushti', 'casual', 110000, null, 22, 40, false, 'tank', 'TS', "Yengsiz paxta top."],
  ['SF-TP-16', 'Sport futbolka', 'Спортивная футболка', 'top', 'unisex', 'kulrang', 'sport', 140000, null, 15, 40, false, 'tshirt', 'TS', "Ter o'tkazadigan sport mato."],
  ['SF-TP-17', "Oksford ko'ylak", 'Оксфордская рубашка', 'top', 'unisex', 'havorang', 'classic', 290000, null, 8, 28, false, 'shirt', 'TS', "Oksford paxta, tugmali yoqa."],
  ['SF-TP-18', 'Flis kofta', 'Флисовая кофта', 'top', 'unisex', 'zaytun', 'sport', 270000, null, -10, 12, false, 'fleece', 'TS', "Issiq flis, yarim zamokli."],
  ['SF-TP-19', 'Termo longsliv', 'Термолонгслив', 'top', 'unisex', 'oq', 'sport', 150000, null, -20, 8, false, 'longsleeve', 'TS', "Issiqlikni saqlaydigan ichki qatlam."],
  ['SF-TP-20', 'Ipak bluzka', 'Шёлковая блузка', 'top', 'female', 'oq', 'classic', 520000, null, 12, 32, false, 'blouse', 'T', "Tabiiy ipak, yengil va silliq."],

  ['SF-BT-01', 'Isitilgan jinsi', 'Утеплённые джинсы', 'bottom', 'unisex', "to'q ko'k", 'casual', 420000, null, -25, 8, false, 'jeans', 'TS', "Ichi flisli, qishki jinsi."],
  ['SF-BT-02', 'Klassik jinsi', 'Классические джинсы', 'bottom', 'unisex', "ko'k", 'casual', 350000, 290000, -10, 25, false, 'jeans', 'TS', "To'g'ri bichim, paxta denim."],
  ['SF-BT-03', 'Chino shim', 'Брюки чинос', 'bottom', 'male', 'bej', 'classic', 310000, null, 8, 32, false, 'chinos', 'TS', "Paxta twill, toraygan pacha."],
  ['SF-BT-04', 'Midi yubka', 'Юбка миди', 'bottom', 'female', 'qora', 'classic', 270000, null, 10, 32, false, 'skirt', 'TS', "A-siluet, tizzadan past."],
  ['SF-BT-05', 'Shorti', 'Шорты', 'bottom', 'unisex', 'kulrang', 'sport', 150000, null, 22, 40, false, 'shorts', 'TS', "Rezinkali, yengil sport shorti."],
  ['SF-BT-06', 'Jun shim', 'Шерстяные брюки', 'bottom', 'female', 'kulrang', 'classic', 390000, null, -20, 10, false, 'trousers', 'TS', "Jun aralash, dazmol chiziqli."],
  ['SF-BT-07', 'Klassik shim', 'Классические брюки', 'bottom', 'male', 'qora', 'classic', 450000, null, -10, 25, false, 'trousers', 'TS', "Kostyum matosi, dazmol chiziqli."],
  ['SF-BT-08', 'Jogger', 'Джоггеры', 'bottom', 'unisex', 'qora', 'sport', 220000, null, -5, 20, false, 'joggers', 'TS', "Manjetli, yumshoq trikotaj."],
  ['SF-BT-09', 'Issiq jogger', 'Утеплённые джоггеры', 'bottom', 'unisex', 'kulrang', 'sport', 260000, null, -20, 5, false, 'joggers', 'TS', "Ichi tukli, qishki jogger."],
  ['SF-BT-10', 'Keng shim', 'Широкие брюки', 'bottom', 'female', 'krem', 'classic', 360000, null, 12, 32, false, 'wide', 'TS', "Baland belli, keng pachali."],
  ['SF-BT-11', 'Plisse yubka', 'Юбка плиссе', 'bottom', 'female', 'yashil', 'casual', 290000, null, 15, 32, false, 'pleated', 'TS', "Plisse burmali, midi uzunlikda."],
  ['SF-BT-12', "Zig'ir shim", 'Льняные брюки', 'bottom', 'male', 'krem', 'casual', 340000, null, 22, 40, false, 'chinos', 'TS', "Zig'ir aralash, issiqda salqin."],
  ['SF-BT-13', 'Jinsi shorti', 'Джинсовые шорты', 'bottom', 'female', "ko'k", 'casual', 160000, null, 22, 40, false, 'shorts', 'TS', "Deniм shorti, baland belli."],
  ['SF-BT-14', 'Kord shim', 'Вельветовые брюки', 'bottom', 'male', 'jigarrang', 'casual', 380000, null, -10, 15, false, 'chinos', 'S', "Velvet (kord), issiq va yumshoq."],
  ['SF-BT-15', 'Issiq leggings', 'Тёплые леггинсы', 'bottom', 'female', 'qora', 'sport', 180000, null, -15, 10, false, 'leggings', 'TS', "Ichi tukli, cho'ziluvchan."],
  ['SF-BT-16', 'Slim jinsi', 'Джинсы слим', 'bottom', 'female', 'qora', 'casual', 320000, null, -5, 25, false, 'jeans', 'TS', "Tor bichim, cho'ziluvchan denim."],
  ['SF-BT-17', 'Chino shorti', 'Шорты чинос', 'bottom', 'male', "to'q ko'k", 'casual', 190000, null, 22, 40, false, 'shorts', 'TS', "Paxta twill, tizzadan yuqori."],
  ['SF-BT-18', 'Premium jinsi', 'Джинсы премиум', 'bottom', 'male', "to'q ko'k", 'casual', 690000, null, -10, 22, false, 'jeans', 'T', "Yapon denimi, qo'lda ishlov berilgan."],
  ['SF-BT-19', 'Yengil shim', 'Лёгкие брюки', 'bottom', 'male', 'kulrang', 'classic', 330000, null, 18, 38, false, 'trousers', 'TS', "Yozgi kostyum matosi, nafas oladi."],

  ['SF-SH-01', 'Qishki etik', 'Зимние сапоги', 'shoes', 'unisex', 'qora', 'casual', 950000, 790000, -25, 5, true, 'winterboot', 'TS', "Mo'ynali astar, sirpanmaydigan taglik."],
  ['SF-SH-02', 'Charm botinka', 'Кожаные ботинки', 'shoes', 'unisex', 'jigarrang', 'classic', 820000, null, -10, 15, true, 'boot', 'TS', "Tabiiy charm, bog'ichli, suv o'tkazmaydi."],
  ['SF-SH-03', 'Krossovka', 'Кроссовки', 'shoes', 'unisex', 'oq', 'sport', 590000, null, 5, 30, false, 'sneaker', 'TS', "Charm krossovka, yumshoq taglik."],
  ['SF-SH-04', 'Sandal', 'Сандалии', 'shoes', 'unisex', 'bej', 'casual', 230000, null, 22, 40, false, 'sandal', 'TS', "Charm tasmali, yengil taglik."],
  ['SF-SH-05', 'Chelsi', 'Челси', 'shoes', 'unisex', 'qora', 'classic', 690000, null, -5, 18, false, 'chelsea', 'TS', "Rezina qo'yilmali charm chelsi."],
  ['SF-SH-06', 'Lofer', 'Лоферы', 'shoes', 'male', 'jigarrang', 'classic', 520000, null, 10, 32, false, 'loafer', 'TS', "Tabiiy charm, bog'ichsiz."],
  ['SF-SH-07', 'Balerina', 'Балетки', 'shoes', 'female', 'bej', 'classic', 290000, null, 15, 32, false, 'flats', 'TS', "Yumshoq charm, tekis taglik."],
  ['SF-SH-08', 'Yugurish krossovkasi', 'Беговые кроссовки', 'shoes', 'unisex', 'kulrang', 'sport', 450000, null, 5, 32, false, 'runner', 'TS', "Setkali, amortizatsiyali taglik."],
  ['SF-SH-09', 'Keda', 'Кеды', 'shoes', 'unisex', 'oq', 'casual', 180000, null, 15, 35, false, 'canvas', 'TS', "Kanvas mato, rezina taglik."],
  ['SF-SH-10', 'Uzun etik', 'Высокие сапоги', 'shoes', 'female', 'qora', 'classic', 1190000, null, -20, 8, false, 'tallboot', 'T', "Tizzagacha, tabiiy charm."],
  ['SF-SH-11', 'Trekking botinka', 'Треккинговые ботинки', 'shoes', 'unisex', 'jigarrang', 'sport', 740000, null, -15, 12, true, 'boot', 'TS', "Membranali, qalin protektorli."],
  ['SF-SH-12', 'Shippak', 'Шлёпанцы', 'shoes', 'unisex', 'qora', 'sport', 99000, null, 25, 40, false, 'slides', 'TS', "Yumshoq rezina, plyaj va uy uchun."],
  ['SF-SH-13', 'Oksford tufli', 'Оксфорды', 'shoes', 'male', 'qora', 'classic', 640000, null, 5, 28, false, 'oxford', 'TS', "Klassik bog'ichli charm tufli."],
  ['SF-SH-14', 'Qishki krossovka', 'Зимние кроссовки', 'shoes', 'unisex', 'qora', 'sport', 650000, 560000, -10, 10, true, 'runner', 'TS', "Issiq astarli, suv o'tkazmaydi."],
  ['SF-SH-15', 'Tufli', 'Туфли', 'shoes', 'female', 'qora', 'classic', 420000, null, 12, 30, false, 'pump', 'T', "O'rta poshnali klassik tufli."],
  ['SF-SH-16', "Mo'ynali botinka", 'Ботинки с мехом', 'shoes', 'unisex', 'bej', 'casual', 780000, null, -25, 3, true, 'winterboot', 'S', "Zamsh, ichi mo'ynali."],

  ['SF-AC-01', 'Jun sharf', 'Шерстяной шарф', 'accessory', 'unisex', 'qizil', 'casual', 140000, null, -25, 5, false, 'scarf', 'TS', "Yumshoq jun, popukli."],
  ['SF-AC-02', 'Trikotaj shapka', 'Вязаная шапка', 'accessory', 'unisex', 'kulrang', 'casual', 90000, null, -25, 5, false, 'beanie', 'TS', "Qalin trikotaj, qaytarma chetli."],
  ['SF-AC-03', 'Kepka', 'Кепка', 'accessory', 'unisex', 'qora', 'sport', 85000, 70000, 18, 40, false, 'cap', 'TS', "Paxta, sozlanadigan tasmali."],
  ['SF-AC-04', "Charm qo'lqop", 'Кожаные перчатки', 'accessory', 'unisex', 'jigarrang', 'classic', 210000, null, -25, 5, false, 'gloves', 'TS', "Tabiiy charm, issiq astarli."],
  ['SF-AC-05', 'Kashemir sharf', 'Кашемировый шарф', 'accessory', 'female', 'bej', 'classic', 450000, null, -15, 10, false, 'scarf', 'T', "Kashemir aralash, keng."],
  ['SF-AC-06', 'Charm kamar', 'Кожаный ремень', 'accessory', 'male', 'qora', 'classic', 160000, null, -30, 40, false, 'belt', 'TS', "Tabiiy charm, metall to'qa."],
  ['SF-AC-07', 'Tote sumka', 'Сумка-тоут', 'accessory', 'female', 'bej', 'casual', 380000, null, -30, 40, false, 'bag', 'S', "Sig'imli, yumshoq charm."],
  ['SF-AC-08', "Quyosh ko'zoynagi", 'Солнцезащитные очки', 'accessory', 'unisex', 'qora', 'casual', 250000, null, 15, 40, false, 'sunglasses', 'TS', "UV400 himoya, klassik shakl."],
];

// Task 40: a few children's products per demo store, one children's category per role. Seeded after every adult product
// and category of both stores, so the adult ids (and the recorded demo answers) stay as they were.
// [sku, name, name_ru, category, gender, color, style, price, discount_price, temp_min, temp_max, waterproof, image (an adult SKU's demo picture), description]
const KID_ROWS = [
  ['SF-KO-01', 'Bolalar puxovigi', 'Детский пуховик', 'outerwear', 'unisex', 'qizil', 'casual', 590000, 490000, -25, 5, true, 'SF-OW-01', "Issiq, kapyushonli, suv o'tkazmaydi."],
  ['SF-KO-02', 'Bolalar vetrovkasi', 'Детская ветровка', 'outerwear', 'unisex', "ko'k", 'sport', 290000, null, 3, 22, true, 'SF-OW-10', "Yengil, shamol va yomg'irdan himoya."],
  ['SF-KT-01', 'Bolalar sviteri', 'Детский свитер', 'top', 'unisex', 'kulrang', 'casual', 190000, null, -25, 12, false, 'SF-TP-01', 'Yumshoq trikotaj, tikanmaydi.'],
  ['SF-KT-02', 'Bolalar hudisi', 'Детское худи', 'top', 'unisex', "to'q ko'k", 'sport', 160000, null, -10, 20, false, 'SF-TP-02', "Ichi tukli paxta, kapyushonli."],
  ['SF-KT-03', 'Qizlar bluzkasi', 'Блузка для девочки', 'top', 'female', 'pushti', 'classic', 150000, null, 15, 35, false, 'SF-TP-04', 'Yengil paxta, bayramga ham.'],
  ['SF-KT-04', 'Bolalar futbolkasi', 'Детская футболка', 'top', 'unisex', 'oq', 'casual', 69000, null, 15, 40, false, 'SF-TP-05', '100% paxta.'],
  ['SF-KB-01', 'Bolalar isitilgan shimi', 'Детские утеплённые брюки', 'bottom', 'unisex', "to'q ko'k", 'casual', 220000, null, -25, 10, false, 'SF-BT-01', 'Ichi flisli, qishki shim.'],
  ['SF-KB-02', 'Bolalar jinsisi', 'Детские джинсы', 'bottom', 'unisex', "ko'k", 'casual', 180000, 150000, -10, 28, false, 'SF-BT-02', 'Rezinkali belbog\'li, paxta denim.'],
  ['SF-KB-03', 'Bolalar shortisi', 'Детские шорты', 'bottom', 'unisex', 'kulrang', 'sport', 89000, null, 20, 40, false, 'SF-BT-05', 'Yengil sport shorti.'],
  ['SF-KS-01', 'Bolalar qishki etigi', 'Детские зимние сапоги', 'shoes', 'unisex', 'qora', 'casual', 340000, null, -25, 5, true, 'SF-SH-01', "Ichi issiq, suv o'tkazmaydi."],
  ['SF-KS-02', 'Bolalar krossovkasi', 'Детские кроссовки', 'shoes', 'unisex', 'oq', 'sport', 260000, null, 0, 40, false, 'SF-SH-03', 'Yopishqoq bog\'ichli, yengil.'],
];
export const KIDS_CATALOGUE = KID_ROWS.map(([sku, name, name_ru, category, gender, color, style, price, discount_price, temp_min, temp_max, waterproof, image, description]) =>
  ({ sku, name, name_ru, category, gender, color, style, price, discount_price, temp_min, temp_max, waterproof, image, description }));
// The children's categories every demo shop gets (role → names).
export const KIDS_CATEGORIES = [
  { role: 'outerwear', name: 'Bolalar ustki kiyimi', name_ru: 'Детская верхняя одежда' },
  { role: 'top', name: "Bolalar ko'ylak va futbolkalari", name_ru: 'Детские рубашки и футболки' },
  { role: 'bottom', name: 'Bolalar shimlari', name_ru: 'Детские брюки' },
  { role: 'shoes', name: 'Bolalar poyabzali', name_ru: 'Детская обувь' },
];

const KEYS = ['sku', 'name', 'name_ru', 'category', 'gender', 'color', 'style', 'price', 'discount_price', 'temp_min', 'temp_max', 'waterproof', 'art', 'stores', 'description'];
export const CATALOGUE = ROWS.map((r) => Object.fromEntries(KEYS.map((k, i) => [k, r[i]])));

export const sizesFor = (category) => (category === 'shoes' ? SHOES : category === 'accessory' ? ONE : CLOTHES);
// Task 36: a product's sizes. A role-less product keeps its category's list in products.sizes; others go by role.
// Task 40: a children's role product keeps its list there too (92–164 or 22–35), so this stays the one place.
export const sizesOf = (p) => (p.sizes ? p.sizes.split(',') : sizesFor(p.category));

// Deterministic stock: middle sizes deepest, most sizes ≥ 2, and about 1 in 17 sizes sold out (exercises the stock > 0 rule).
const DEPTH = { 6: [2, 3, 5, 5, 3, 2], 10: [2, 2, 3, 4, 4, 5, 5, 4, 3, 2], 1: [6] };
export function stockFor(item, size, storeIdx, sizeCount) {
  const h = (item * 13 + size * 5 + storeIdx * 7) % 17;
  if (sizeCount > 1 && h === 0) return 0;
  return DEPTH[sizeCount][size] + (h % 3);
}

// Demo images are copied per store, so deleting one store's product (which deletes its image) leaves the other's.
// The name is fixed per store + SKU, so re-seeding overwrites instead of piling up files.
const imageName = (storeIdx, sku) => `demo-s${storeIdx + 1}-${sku.toLowerCase()}.svg`;

// Children before parents (SQLite deletes row by row, with foreign keys on).
const WIPE = ['fitting_requests', 'payment_transactions', 'order_items', 'orders', 'recommendation_logs', 'cart_items', 'carts', 'product_stock', 'products', 'categories', 'admins', 'stores', 'organizations', 'malls'];

// uploadDir: where /uploads is served from. Without it (tests) image_url is still set, but no file is copied.
export async function seed(db, { uploadDir } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Seed wipes all data; refusing to run in production');
  if (uploadDir) {
    await mkdir(path.join(uploadDir, 'products'), { recursive: true });
    for (const [storeIdx] of STORES.entries()) {
      for (const p of CATALOGUE.filter((x) => x.stores.includes('TS'[storeIdx]))) await copyFile(path.join(IMAGE_DIR, `${p.sku}.svg`), path.join(uploadDir, 'products', imageName(storeIdx, p.sku)));
      for (const p of KIDS_CATALOGUE) await copyFile(path.join(IMAGE_DIR, `${p.image}.svg`), path.join(uploadDir, 'products', imageName(storeIdx, p.sku)));
    }
  }
  await db.transaction(async (trx) => {
    // Ids restart at 1, so a reseed gives stores 1 and 2 again and printed QR codes (/kiosk?store=1) keep working.
    if (trx.client.config.client === 'pg') await trx.raw(`truncate ${WIPE.map(() => '??').join(', ')} restart identity cascade`, WIPE);
    else for (const t of WIPE) await trx(t).truncate(); // knex's SQLite truncate also clears the table's sqlite_sequence row
    // One demo organisation per store (task 22), so the two demo brands are isolated from each other like real tenants.
    // The landing page's demo links open /kiosk?store=1.
    const [{ id: mallId }] = await trx('malls').insert(DEMO_MALL).returning('id');
    for (const [storeIdx, store] of STORES.entries()) {
      const [{ id: orgId }] = await trx('organizations').insert({ name: store.name }).returning('id');
      const [{ id: storeId }] = await trx('stores').insert({ ...store, organization_id: orgId, mall_id: mallId, ...MALL_ENTRY[storeIdx] }).returning('id');
      await trx('categories').insert(builtinRows(orgId));
      const catIds = Object.fromEntries((await trx('categories').where({ organization_id: orgId }).select('id', 'role')).map((c) => [c.role, c.id]));
      const code = 'TS'[storeIdx];
      for (const [i, { art, stores, ...p }] of CATALOGUE.entries()) {
        if (!stores.includes(code)) continue;
        const [{ id: productId }] = await trx('products')
          .insert({ ...p, store_id: storeId, category_id: catIds[p.category], shelf_location: `${'ABCDE'[i % 5]}-${i + 1}`, image_url: `/uploads/products/${imageName(storeIdx, p.sku)}` })
          .returning('id');
        const sizes = sizesFor(p.category);
        await trx('product_stock').insert(sizes.map((size, s) => ({ product_id: productId, size, quantity: stockFor(i, s, storeIdx, sizes.length) })));
      }
    }
    // Task 40: children's categories and products, after all of the above (see KID_ROWS).
    for (const [storeIdx, { id: storeId, organization_id: orgId }] of (await trx('stores').orderBy('id').select('id', 'organization_id')).entries()) {
      const catIds = {};
      for (const [j, c] of KIDS_CATEGORIES.entries()) {
        const size_kind = c.role === 'shoes' ? 'kids_shoes' : 'kids';
        [{ id: catIds[c.role] }] = await trx('categories').insert({ ...c, organization_id: orgId, sort: 6 + j, size_kind, audience: 'child' }).returning('id');
      }
      for (const [i, { image, ...p }] of KIDS_CATALOGUE.entries()) {
        const sizes = p.category === 'shoes' ? KIDS_SHOES : KIDS;
        const [{ id: productId }] = await trx('products').insert({ ...p, store_id: storeId, category_id: catIds[p.category], sizes: sizes.join(','), audience: 'child',
          shelf_location: `K-${i + 1}`, image_url: `/uploads/products/${imageName(storeIdx, p.sku)}` }).returning('id');
        // Every size in stock (2–4), so the child path finds an outfit at any height and temperature.
        await trx('product_stock').insert(sizes.map((size, s) => ({ product_id: productId, size, quantity: 2 + ((i + s + storeIdx) % 3) })));
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
    await seed(db, { uploadDir: process.env.UPLOAD_DIR || 'uploads' });
    const [{ n }] = await db('products').count({ n: '*' });
    console.log(`Seed: ${STORES.length} do'kon, ${n} kiyim, rasmlar bilan`);
  } finally {
    await db.destroy();
  }
}
