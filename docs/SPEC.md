# Smart Fit — asl reja (manba: .docx, 2026-11-05)

Smart Fit: kiyim tanlash tizimini Claude bilan qurish rejasi
Nov 5, 2026 · @Nodir
Maqsad
Kiyim do'konlari uchun tizim quriladi. U do'kondagi kioskda ham, mijozning o'z telefonida ham (QR kod orqali) ishlaydi. Mijoz rasmga tushadi, tizim uning razmerini aniqlaydi va bugungi ob-havoga mos 2–3 ta to'liq obraz taklif qiladi. Taklif qilinadigan kiyimlar faqat shu do'konda, shu razmerda qoldig'i bor kiyimlardan olinadi.
	•	Foydalanuvchilar: mijoz (do'kondagi kioskdan yoki QR orqali o'z telefonidan) va do'kon xodimi (admin panel orqali).
	•	Narxlar: har bir kiyimning narxi va obrazning umumiy narxi ko'rsatiladi. Mijoz byudjet kiritsa, faqat shu byudjetga sig'adigan obrazlar taklif qilinadi.
	•	Xarid va yetkazib berish: mijoz obrazni yoki alohida kiyimni savatga soladi va onlayn to'laydi. Keyin uni uyiga yetkazib berishni buyurtma qiladi yoki do'kondan o'zi olib ketadi.
	•	MVP natijasi: 1 ta do'konda, 50 ta demo kiyim bilan ishlaydigan tizim. Mijoz rasmga tushgandan keyin 15 soniyadan kam vaqtda tavsiya oladi.
	•	Asosiy qoida: do'konda yo'q yoki qoldig'i 0 bo'lgan kiyim hech qachon ko'rsatilmaydi va sotilmaydi.
Arxitektura va texnologiyalar
Tizim 8 qismdan iborat. Kiosk va telefon bitta veb-ilovani ishlatadi. Barcha qarorlar backend'da qabul qilinadi: narx hisoblash, qoldiqni band qilish va buyurtma ham shu yerda. Ekran faqat o'lchaydi va natijani ko'rsatadi.

tizim arxitekturasi · 8 qism
Qism
Texnologiya
Narxi
Kiosk, telefon va admin panel
Bitta veb-ilova (HTML, CSS, JavaScript), telefonda QR orqali ochiladi
Bepul
Tana o'lchovi
MediaPipe Pose Landmarker (brauzerda)
Bepul
Backend
Node.js 22 + Express
Bepul
Baza
PostgreSQL (sinovda SQLite)
Bepul
Ob-havo
Open-Meteo API, kalit kerak emas
Bepul
Obraz tanlash
Claude API
Har so'rov uchun to'lov
Onlayn to'lov
Click yoki Payme (ulanishdan oldin shartlarini aniqlang)
Har to'lovdan foiz
Yetkazib berish
Do'konning o'z kuryeri yoki yetkazib berish xizmati API
Har buyurtma uchun
Claude bilan ishlash tartibi
Kodni Claude Code'da yozing: u loyiha papkasida ishlaydi, fayllarni o'zi yaratadi va testlarni ishga tushiradi. Har bosqich alohida sessiyada, bitta aniq maqsad bilan bajariladi.
Tayyorgarlik (bir marta):
	•	Kompyuterga Node.js 22+, Git va Claude Code o'rnating.
	•	smart-fit papkasini oching va git init qiling.
	•	Papka ildiziga CLAUDE.md faylini qo'ying. Claude uni har sessiyada o'qiydi va loyiha qoidalarini eslab qoladi.
# Smart Fit — loyiha qoidalari - Kiosk orqali kiyim tavsiya qiluvchi tizim (kiyim do'konlari uchun). - Stack: Node.js 22 + Express, PostgreSQL (dev: SQLite), vanilla JS frontend. - Interfeys tili: o'zbek (lotin). Kod va izohlar: ingliz. - ASOSIY QOIDA: faqat do'konda bor va qoldig'i > 0 kiyim taklif qilinadi. - Mijoz rasmi diskka yoki bazaga saqlanmaydi. - Har yangi funksiya uchun test yoziladi (node --test). - Maxfiy kalitlar faqat .env faylida, kodda emas.
Har bosqich sikli:
	•	Reja: promptni bering va avval reja so'rang (“kod yozma, avval reja ber”). Rejani o'qib, kerak bo'lsa tuzating.
	•	Kod: rejani tasdiqlang, Claude kodni yozadi.
	•	Sinov: Claude'dan testlarni ishga tushirishni so'rang, keyin o'zingiz brauzerda tekshiring.
	•	Ko'rib chiqish: “Shu bosqichdagi o'zgarishlarni xato va xavfsizlik bo'yicha tekshir” deb so'rang.
	•	Saqlash: git commit qiling. Keyingi bosqich yangi sessiyada boshlanadi.
Bosqichlar va promptlar
Ish 7 bosqichdan iborat. Har bosqich oldingisiga tayanadi, shuning uchun tartibni buzmang. Promptlarni Claude Code'ga o'zgartirmasdan yoki o'z ehtiyojingizga moslab bering.
1. Loyiha asosi va ma'lumotlar bazasi
Natija: server ishga tushadi, bazada 2 ta do'kon va 50 ta demo kiyim bor.
Smart Fit loyihasining asosini qur (CLAUDE.md ni o'qi). - Express server, /api prefiksi, .env orqali sozlash. - Jadvallar: stores (nom, shahar, lat, lon, manzil, yetkazish narxi),   products (do'kon, nom, kategoriya: outerwear/top/bottom/shoes/accessory,   jins, rang, narx, chegirmali narx, temp_min, temp_max, waterproof,   javondagi joyi, rasm), product_stock (kiyim, razmer, soni, band qilingan),   carts, orders (ism, telefon, olish usuli, manzil, holat, to'lov holati,   jami summa), order_items, admins, recommendation_logs. - Narxlar so'mda, butun son bo'lib saqlansin. - Seed skript: Toshkent va Samarqanddagi 2 ta do'kon, har biriga 25 ta   har xil fasldagi demo kiyim, narxi va razmer bo'yicha qoldig'i bilan. - Avval reja ber, kod yozma.
2. Admin panel
Natija: xodim tizimga kiradi, kiyim qo'shadi, razmer bo'yicha qoldiqni o'zgartiradi va Excel/CSV yuklaydi.
Admin panel qo'sh (/admin). - Login: email + parol (scrypt), token 12 soat amal qiladi. - Rollar: bosh admin barcha do'konlarni ko'radi, do'kon menejeri faqat o'zinikini. - Kiyimlar ro'yxati: qidiruv, kategoriya filtri, qo'shish, tahrirlash, o'chirish. - Har kiyim uchun razmer jadvali (XS-XXL yoki 36-45) va soni. - CSV import va rasm yuklash. - Statistika: kunlik tavsiyalar soni va eng ko'p taklif qilingan kiyimlar.
3. Ob-havo va qoidalar asosida tavsiya
Natija: POST /api/recommend AI'siz ham to'g'ri obraz qaytaradi.
Tavsiya mexanizmini AI'siz, qoidalar asosida yoz. - Ob-havo: Open-Meteo API, do'kon koordinatalari bo'yicha, 10 daqiqa kesh.   Internet bo'lmasa oylik o'rtacha haroratni ishlat. - Filtr: shu do'kon + mijoz razmerida qoldig'i > 0 + jinsiga mos +   temp_min <= harorat <= temp_max. - Yomg'irda suv o'tkazmaydigan kiyim birinchi o'rinda. - 2-3 ta obraz tuz: ustki kiyim (18°C dan past yoki yomg'irda), ko'ylak,   shim, poyabzal, kerak bo'lsa aksessuar. Obrazlarda kiyimlar takrorlanmasin. - Har kiyim narxini (chegirma bo'lsa chegirmali narxni) va obrazning jami   narxini hisobla. - Mijoz byudjet kiritsa, jami narxi byudjetdan oshmaydigan obrazlar tuz.   Sig'adigani bo'lmasa, eng arzon obrazni va byudjetdan qancha oshishini ko'rsat. - Har obrazga bitta arzonroq muqobil taklif qil. - Har qoida uchun unit test yoz.
4. Kiosk, telefon (QR) va razmer aniqlash
Natija: mijoz kioskda yoki o'z telefonida rasmga tushadi, 5 soniyada razmerini va narxlari bilan obrazlarni ko'radi.
Mijoz ilovasini qur. Bitta ilova kioskda (/kiosk?store=1) ham, telefonda (/m?store=1, QR orqali ochiladi) ham ishlasin. Kioskda katta tugmalar, telefonda mobil dizayn. Ekranlar: 1) boshlash + ob-havo, 2) jins, bo'y (majburiy), vazn, poyabzal razmeri va byudjet (ixtiyoriy), 3) kamera: kioskda 3 soniyalik sanoq, telefonda 10 soniyalik taymer va galereyadan rasm tanlash, 4) natija: obrazlar, har kiyim narxi, obrazning jami narxi, "Savatga qo'shish". - MediaPipe Pose Landmarker (brauzerda) bilan yelka va son kengligini   bo'y orqali santimetrga aylantir. - Butun tana ko'rinmasa, aniq xabar chiqar va qayta olishni taklif qil. - Razmerni serverda hisobla (yelka -> ustki kiyim, son -> shim, vazn bilan   aralashtir), ishonch darajasini ham qaytar. - Natijada razmerni +/- tugmalari bilan o'zgartirish mumkin bo'lsin. - Kioskda 90 soniya harakatsizlikdan keyin boshiga qayt va savatni   tozala. Rasm hech qayerda saqlanmasin. - Admin panelda har do'kon uchun QR kodni chop etish tugmasi bo'lsin.
5. Claude API bilan aqlli tanlash
Natija: obrazlar rang va uslub bo'yicha mos tushadi, har biriga qisqa izoh beriladi.
Tavsiyaga Claude API'ni qo'sh (@anthropic-ai/sdk, kalit .env da). - Claude'ga rasm, ob-havo, razmer va 3-bosqichdagi filtrdan o'tgan   kiyimlar ro'yxatini (id, nom, kategoriya, rang, uslub, narx) va   mijoz byudjetini yubor. - Javobni tool use orqali qat'iy JSON shaklida ol (sxema rejada). - Har product_id ni filtrlangan ro'yxat bilan solishtir, ro'yxatda   yo'qlarini olib tashla. - Xato, kalit yo'qligi yoki 8 soniyadan uzoq kutish bo'lsa, qoidalar   asosidagi tavsiyaga qayt.
6. Savat, to'lov va yetkazib berish
Natija: mijoz obrazni sotib oladi, keyin yetkazib berishni yoki do'kondan olib ketishni tanlaydi.
Savat va buyurtma tizimini qo'sh. - Savat: obrazni bitta tugma bilan yoki kiyimlarni alohida qo'shish,   razmerni almashtirish, kiyimlar summasi, yetkazish narxi, jami to'lov. - Savatga qo'shilgan kiyim qoldig'i 15 daqiqaga band qilinsin; to'lov   bo'lmasa band bekor qilinsin. Oxirgi dona ikki kishiga sotilmasin   (bazada tranzaksiya bilan). - Olish usuli: (a) do'kondan olib ketish, (b) yetkazib berish: ism,   telefon, manzil, xaritadan nuqta. Yetkazish narxi do'kon sozlamasidan:   shahar ichida qat'iy narx, belgilangan summadan oshsa bepul. - To'lov: Click yoki Payme (avval test rejimida) yoki kassada to'lash.   To'lov tasdig'i serverga callback orqali kelsin. Jami summani doim   server hisoblasin, brauzerdan kelgan narxga ishonma. - To'lovdan keyin qoldiq kamaysin, buyurtma admin panelda chiqsin.   Holatlar: yangi -> yig'ilmoqda -> yo'lda -> yetkazildi / bekor qilindi. - Mijozga buyurtma raqami va holati SMS yoki Telegram bot orqali borsin.
7. Pilot va ishga tushirish
Natija: tizim serverda ishlaydi, 1 ta haqiqiy do'konda 2 hafta sinovdan o'tadi.
Loyihani ishga tushirishga tayyorla. - Dockerfile va docker-compose (app + PostgreSQL). - HTTPS (kamera faqat HTTPS'da ishlaydi), loglar, xatolar monitoringi. - README: o'rnatish, .env o'zgaruvchilari, yangi do'kon qo'shish. - Pilot uchun: tavsiyani mijoz qabul qildimi, kiyimni sinab ko'rdimi,   sotib oldimi yoki yetkazib berishga buyurtma qildimi — shularni yozib boradigan oddiy hisobot.
Tavsiya uchun Claude API prompti
Claude kiyimni o'zi “o'ylab topmaydi”. U faqat server bergan ro'yxatdan tanlaydi, server esa javobni yana bir bor tekshiradi. Shu ikki qatlam do'konda yo'q kiyim taklif qilinishining oldini oladi.
System prompt:
Sen kiyim do'konidagi stilistsan. Vazifang: mijozga bugungi ob-havoga mos 2-3 ta to'liq obraz tuzish. Qoidalar: - Faqat CANDIDATES ro'yxatidagi product_id larni ishlat. Boshqa kiyim   o'ylab topma. - Har obrazda: top, bottom, shoes majburiy; outerwear harorat 18°C dan   past yoki yomg'ir bo'lsa majburiy; accessory ixtiyoriy. - Ranglar mos bo'lsin: neytral ranglar (qora, oq, kulrang, to'q ko'k,   bej) hammasi bilan; ikkita yorqin rangni bir obrazga qo'yma. - Rasmga qarab mijozning uslubini taxmin qil (klassik, sport, kundalik). - BUDGET berilgan bo'lsa, obrazdagi narxlar yig'indisi undan oshmasin. - Mijozning tashqi ko'rinishi haqida baho berma, faqat kiyim haqida yoz. - Izohlar o'zbek tilida, har biri 1-2 gap.
Foydalanuvchi xabari (server to'ldiradi): mijoz rasmi, ob-havo (harorat, his qilinishi, yomg'ir, shamol), razmerlar, byudjet va CANDIDATES ro'yxati JSON shaklida.
Javob sxemasi (submit_outfits tool, tool_choice bilan majburiy):
{   "name": "submit_outfits",   "input_schema": {     "type": "object",     "required": ["outfits"],     "properties": {       "style_guess": { "type": "string" },       "outfits": {         "type": "array", "minItems": 1, "maxItems": 3,         "items": {           "type": "object",           "required": ["title", "product_ids", "reason"],           "properties": {             "title": { "type": "string" },             "product_ids": { "type": "array", "items": { "type": "integer" } },             "reason": { "type": "string" }           }         }       }     }   } }
Serverdagi tekshiruv: har bir product_id CANDIDATES ichida bo'lishi shart. Majburiy kategoriyasi yetishmagan obraz qoidalar asosida to'ldiriladi. Bitta ham to'g'ri obraz qolmasa, butun javob qoidalar asosidagi tavsiya bilan almashtiriladi. Narxlar va jami summani Claude emas, server bazadan hisoblaydi.
Sinov va sifat nazorati
Har bosqich quyidagi tekshiruvlardan o'tmaguncha keyingisiga o'tilmaydi.
	•	☐ Qoldiq qoidasi: qoldig'i 0 bo'lgan kiyim hech bir tavsiyada chiqmaydi (avtomatik test).
	•	☐ Begona ID: Claude ro'yxatda yo'q ID qaytarsa, u olib tashlanadi (soxta javob bilan test).
	•	☐ Ob-havo: -10°C, 5°C, 15°C, 30°C va yomg'irli kun uchun to'g'ri kategoriyalar tanlanadi.
	•	☐ Narx: obraz jami narxi, chegirma, yetkazish narxi va bepul yetkazish chegarasi to'g'ri hisoblanadi (unit test).
	•	☐ Byudjet: byudjet kiritilganda jami narxi undan oshadigan obraz chiqmaydi.
	•	☐ Oxirgi dona: ikki mijoz bir vaqtda oxirgi donani sotib olmoqchi bo'lsa, faqat bittasi muvaffaqiyatli bo'ladi.
	•	☐ To'lov: test rejimida to'lov, bekor qilish va callback ishlaydi. To'lovsiz buyurtma 15 daqiqadan keyin bekor bo'ladi va qoldiq qaytadi.
	•	☐ Yetkazish: buyurtma admin panelda chiqadi, holat o'zgarganda mijozga xabar boradi.
	•	☐ Telefon: QR kod iPhone va Android'da ochiladi, kamera va galereyadan rasm tanlash ishlaydi.
	•	☐ Razmer aniqligi: 20 kishida o'lchanadi, rasmdan chiqqan razmer haqiqiy razmer bilan kamida 70% holatda mos keladi.
	•	☐ Zaxira rejim: internet yoki Claude API o'chirilganda ham tavsiya beriladi.
	•	☐ Tezlik: rasmga tushishdan natijagacha 15 soniyadan kam.
	•	☐ Maxfiylik: server loglarida va bazada rasm yoki base64 ma'lumot yo'q.
	•	☐ Huquqlar: do'kon menejeri boshqa do'kon kiyimi va buyurtmalarini o'zgartira olmaydi.
Xavflar
Xavf
Oqibati
Yechim
Rasmdan razmer noaniq (±1 razmer)
Mijozga kiyim to'g'ri kelmaydi
Vazn bilan aralashtirish, “taxminiy” belgisi, +/- tugmasi
Qoldiq bazada eskirgan
Bazada bor, javonda yo'q kiyim sotiladi
Kassa tizimi bilan sinxronlash, bo'lmasa kunlik yangilash
Oxirgi dona ikki kishiga sotiladi
Buyurtma bekor qilinadi, mijoz norozi
Savatda 15 daqiqalik band qilish va bazada tranzaksiya
Yetkazilgan kiyim razmeri to'g'ri kelmaydi
Qaytarish va qo'shimcha yetkazish xarajati
Aniq qaytarish shartlari, razmer jadvalini ko'rsatish, avval do'konda kiyib ko'rishni taklif qilish
To'lov tizimiga ulanish kechikadi
Yetkazib berish ishga tushmaydi
Pilotni “do'kondan olib ketish + kassada to'lov” bilan boshlash
Claude API sekin yoki ishlamaydi
Mijoz kutib qoladi
8 soniya limit va qoidalar asosidagi zaxira
Mijoz rasmga tushishni istamaydi
Tizimdan foydalanmaydi
Rasmsiz rejim: faqat bo'y va vazn bilan
Shaxsiy ma'lumot (rasm, manzil, telefon)
Huquqiy va obro' xavfi
Rasm saqlanmaydi, manzil faqat buyurtma uchun, ekranda rozilik
Yorug'lik va fon yomon
MediaPipe tanani topa olmaydi
Kiosk joyini tanlash, aniq xato xabari va qayta urinish
Vaqt jadvali
Bir kishi har kuni 3–4 soat ishlasa, MVP 9 haftada tayyor bo'ladi. Keyingi 2 hafta haqiqiy do'konda pilot o'tkaziladi.

ish rejasi · 7 bosqich, 11 hafta
Pilot natijalari (taklifni qabul qilganlar, kiyimni sinab ko'rganlar va xarid qilganlar ulushi, yetkazib berishga buyurtmalar soni, o'rtacha chek) investorlarga ko'rsatiladigan asosiy dalil bo'ladi.
