# Smart Fit — tasks

One task = one session. Do them in order: each one builds on the previous one. The stage numbers refer to `docs/SPEC.md`.

## [x] 0. Setup
Repo, CLAUDE.md, docs/SPEC.md, TASKS.md, Node 22.

## [x] 1. Foundation + DB (stage 1)
Express server with the `/api` prefix and `.env` config. Tables: stores, products, product_stock, carts, orders, order_items, admins, recommendation_logs (fields as in the spec). SQLite in dev, written so that Postgres can be used later.
Done when:
- The server starts, and `npm test` runs.
- The seed creates 2 stores (Tashkent, Samarkand) with 25 items each, covering all seasons, with stock per size.
- Prices are stored as integer so'm.

Notes: Knex + better-sqlite3 (`src/db`); setting `DATABASE_URL` switches to Postgres (`pg` gets installed in task 11; not run against Postgres yet). The server auto-migrates on start, and `npm run seed` wipes the DB and reseeds it (it refuses when NODE_ENV=production). DB CHECKs: `0 ≤ reserved ≤ quantity`, `discount < price`, `total = subtotal + delivery_fee`, plus enums. Order statuses are stored as codes new/packing/shipping/delivered/cancelled, and the UI maps them to Uzbek. Products have a `style` column (task 7). Sizes: XS–XXL for clothes, 36–45 for shoes, `ONE` for accessories; seed stock is fixed, not random. SQLite returns booleans as 0/1. Not done yet: `cart_items` and reservation rows (task 8), admins (task 2). Product delete in task 2 must handle the FK from `order_items`. The JSON body limit is 100kb.

## [x] 2. Admin: auth + products + stock (stage 2, part)
`/admin`: email + password login (scrypt) with a 12h token. Super-admin sees all stores; a store manager sees only their own. Product list with search and category filter, plus add, edit and delete. Size table (XS–XXL or 36–45) with stock counts.
Done when:
- There is a test that a store manager cannot read or change another store's products.

Notes: API under `/api/admin` (login, me, stores, products GET/POST/PATCH/DELETE), page at `/admin` (`public/admin/index.html`, vanilla JS, token in localStorage). Token = HMAC-SHA256-signed `{sub, exp}` (no JWT dependency), secret `ADMIN_TOKEN_SECRET` in `.env` (random per process in dev if unset, required in production); role and store are re-read from the DB on each request, so a deleted admin loses access at once. Passwords: scrypt with a 16-byte salt. No signup: create admins with `npm run admin:create -- <email> [store_id]` (no store_id = super-admin; password from `ADMIN_PASSWORD` or stdin). A manager gets 404 for another store's product and 403 when creating in another store. Stock is sent as `{ "M": 3 }` with create/PATCH; sizes follow the category (`sizesFor` in seed.js), and switching to a category with a different size group is refused. Stock can't drop below `reserved`; delete is refused (409) when the product is in order_items or held in carts, so the admin sets stock to 0 instead. Login locks an IP for 15 min after 10 failures (in-memory) — task 11 must set Express `trust proxy` behind a reverse proxy or every client shares one IP. Task 3: stats must cope with deleted product IDs in recommendation_logs. Manual: add + search checked in the browser.

## [x] 3. Admin: CSV import, images, stats (stage 2, part)
CSV import of products and stock, image upload, and a stats page (recommendations per day, most-suggested items).
Done when:
- An import test covers bad rows.
- The stats page reads recommendation_logs. It may be empty until task 4.

Notes: `POST /api/admin/products/import` takes the raw CSV as the body (≤1 MB, ≤2000 rows, UTF-8; `,` or `;` is picked from the header so Excel ru/uz exports work; own parser in `src/admin/csv.js`, no dependency). Columns: `id, store_id, name, category, gender, color, style, price, discount_price, temp_min, temp_max, waterproof, shelf_location` plus one stock column per size (`XS…XXL`, `36…45`, `ONE`); unknown columns are refused. An empty `id` creates a product; a filled `id` updates it, and there empty cells keep the old value (so the CSV can't clear a discount; use the form for that). All-or-nothing: any bad row returns 400 with `{line, error}` per row and nothing is saved. It reuses the form's validation and store scoping (a manager can't create in or update another store; super-admin needs `store_id` on new rows). Text cells starting with `= + - @` are refused (spreadsheet formula injection). Images: `POST/DELETE /api/admin/products/:id/image` with the raw file as body (≤2 MB). The type comes from magic bytes (JPEG/PNG/WebP only, no SVG), the file gets a random name in `UPLOAD_DIR/products` (default `./uploads`, gitignored) and is served at `/uploads` with `nosniff`. The old file is removed on replace, image delete and product delete. Files are stored as uploaded (EXIF not stripped; these are product photos, never customer photos). Stats: `GET /api/admin/stats?days=7|30|90&store_id=` returns per-day counts (Asia/Tashkent days, zero-filled), the total, and the top 10 product IDs from `recommendation_logs.product_ids`, counted once per log. Deleted products come back with `name: null` ("O'chirilgan kiyim"). It's store-scoped and aggregated in JS (a shortcut that's fine at pilot volume). **Task 4 must write `product_ids` as a JSON array of integer product IDs.** UI: "CSV yuklash" dialog, image block in the edit dialog, and a "Statistika" tab. The page script passes a syntax check and the API is covered by tests, but the UI was not clicked through in a browser.

## [x] 4. Rule-based recommendation (stage 3)
`POST /api/recommend` without AI. Weather from Open-Meteo by store coordinates, with a 10-minute cache; offline it falls back to the monthly average temperature. Filter: same store + stock > 0 in the customer's size + gender + temp_min ≤ t ≤ temp_max. Waterproof items come first when it rains. Build 2–3 outfits: outerwear when below 18 °C or raining, plus top, bottom, shoes and an optional accessory, with no item repeated across outfits. Each item's price uses the discount price when set, and each outfit has a total. With a budget, return only outfits that fit; if none fit, return the cheapest outfit and how far over budget it is. Each outfit gets one cheaper alternative. Log to recommendation_logs.
Done when there are unit tests for:
- No stock-0 item is ever returned.
- −10, 5, 15 and 30 °C and rain pick the right categories.
- Discount and total maths.
- The budget limit and the over-budget case.
- No repeated items, and the offline weather fallback.

Notes: `src/recommend/` = `weather.js` (Open-Meteo `current=` by store lat/lon, 3 s timeout, 10 min cache per store; on any error → Tashkent monthly normals by Tashkent-time month, `source: 'fallback'`, raining false, cached 1 min so offline kiosks don't wait on every request; one table for all stores, a shortcut), `engine.js` (`filterCandidates` = the CANDIDATES list for task 7, `buildOutfits` pure), `routes.js`. `POST /api/recommend {store_id, gender: male|female, sizes: {top, bottom, shoes?}, budget?}` → `{weather, budget, over_budget, outfits: [{items, total, alternative}]}`; createApp takes an injectable `weather` (tests never hit Open-Meteo). Sizes come in directly for now (tasks 5/6 compute them); top size also covers outerwear; no shoe size → shoes in stock in any size with `size: null` (picked in the cart). "Stock > 0" means `quantity − reserved > 0`, so task 8's holds already count. Rain = precipitation > 0 or a WMO rain/drizzle/shower/thunder code. Ranking per category: waterproof first in rain, then cheapest first with a budget, else closest temperature-range midpoint, then id. Up to 3 outfits = i-th item of each required category (outerwear if t < 18 °C or rain; strict, so no outerwear in stock → no outfits and the UI must say so); the next unused accessory is added only if it keeps the outfit in budget. Alternative = the same outfit with one item swapped for the cheapest unused cheaper item of its category (biggest saving wins; `replaces` = old id; null if none); alternatives may share a swap item with each other, never with a main outfit. Budget 0/null = no budget, max 1e9 (int4). Every call writes a `recommendation_logs` row (`source: 'rules'`, `product_ids` = unique main-outfit IDs as a JSON int array; alternatives not logged). Not done: no rate limit on the public endpoint (one cheap query + one log row per call; add with task 11 if spam shows up in stats). Seed stock is sparse, so most seed sizes get 1 outfit, not 2–3.

## [x] 5. Customer app: screens + QR (stage 4, part)
One app for `/kiosk?store=1` (big buttons) and `/m?store=1` (mobile). Screens: 1) start + weather, 2) gender and height (required), weight, shoe size and budget (optional), 3) camera placeholder (filled in by task 6), 4) results: outfits, item prices, outfit total, "Savatga qo'shish". Use manually entered sizes for now. On the kiosk, return to start and clear the cart after 90 s idle. Admin gets a "print QR" button per store.
Done when:
- The full flow works in the browser with manual sizes.
- There is an idle-reset test.

Notes: `public/app/` (`index.html`, `app.js`, `idle.js`), served at `/kiosk` and `/m` (same HTML; the path picks the mode: `kiosk` = 22 px base size and idle reset, `/m` = 16 px phone layout) with assets under `/app`. New public `GET /api/stores/:id` → `{id, name, city, weather}` for the start screen. Form: gender, height (100–230 cm) and top/bottom size chips are required, weight, shoe size ("Bilmayman" = shoes picked in the cart) and budget optional; validation is client-side with Uzbek messages, the server still validates `/api/recommend`. Height and weight are collected but not sent yet (task 6 uses them). Screen 3 is a text placeholder with "Obrazlarni ko'rish". Results show each item (photo, category, colour, size, shelf), the struck-through price when discounted, the outfit total, the over-budget notice, the cheaper alternative (with its own add button) and an empty state that sends the customer back to change sizes. "Savatga qo'shish" is an in-memory stub (`{product_id, size}` list, count in the header, no stock hold); task 8 replaces it. Kiosk: `watchIdle` resets after 90 s with no pointer/key/input/touch: start screen, cart and form cleared, weather reloaded; "Boshiga" keeps the cart. QR: `qrcode-generator` (MIT, zero deps), server-side SVG at `GET /api/admin/stores/:id/qr` → `{name, url, svg}` (store-scoped like products); the URL is `PUBLIC_URL` (new in `.env.example`) or the host the admin opened, so set `PUBLIC_URL` in production (task 11; behind a proxy `req.protocol` is http until `trust proxy` is set). Admin "QR kodlar" dialog → "QR chop etish" per store prints from an off-screen iframe (no popup to block). Tests: idle reset with mocked timers, `/kiosk`+`/m` serving, the store endpoint, QR scoping and `PUBLIC_URL`. Browser check (in-app Chromium, live Open-Meteo): kiosk flow store 1 (validation → L/L/42 → 1 outfit + alternative → add to cart → after 90 s idle back to start with cart and form empty), phone at 375 px with store 2 and a 500 000 so'm budget (over-budget notice, no horizontal scroll), a wrong store id shows "Do'kon topilmadi", admin QR decoded with BarcodeDetector to `/m?store=1` and the print iframe filled. Not checked: a real phone and a real printer (task 6 covers the phone check).

## [ ] 6. Size from photo (stage 4, part)
MediaPipe Pose Landmarker in the browser. Convert shoulder and hip width to cm using the height. Kiosk gets a 3 s countdown; phone gets a 10 s timer and a gallery picker. The server computes the size (shoulder → top, hip → bottom, blended with weight) and returns a confidence level. Show a clear message and a retry when the full body isn't visible. Add +/- size buttons on results, and a no-photo mode (height + weight only).
Done when:
- Size calculation has unit tests.
- No image or base64 data reaches disk, the DB or the logs.
- Manual: QR + camera + gallery work on a real iPhone and Android phone (record the result in Notes).

## [ ] 7. Claude API stylist (stage 5)
Add `@anthropic-ai/sdk`, with the key in `.env`. Send the photo, weather, sizes, budget and the CANDIDATES from task 4's filter. Use the spec's system prompt and the forced `submit_outfits` tool.
Done when:
- Product IDs not in CANDIDATES are dropped (tested with a fake response).
- Missing required categories are filled by the rules.
- With no valid outfit, no key, an error, or more than 8 s, the rule-based result is returned.
- Prices and totals come from the DB, never from Claude.

## [ ] 8. Cart + reservation + orders (stage 6, part)
Add a whole outfit or single items to the cart, and change sizes there. Show item subtotal, delivery fee and total. Adding an item holds its stock for 15 min, and the hold is released if unpaid. Pickup or delivery (name, phone, address, map pin). Delivery fee comes from store settings: flat fee within the city, free above a threshold. Pay at the cashier. Stock decreases after payment.
Done when:
- A concurrency test shows the last item cannot be sold twice (DB transaction).
- Unit tests cover the delivery fee and the free-delivery threshold.
- The server computes all totals and ignores prices sent by the browser.

## [ ] 9. Click / Payme test mode (stage 6, part)
Online payment with a server callback.
Done when:
- Payment, cancel and callback work in test mode.
- An unpaid order expires after 15 min and its stock comes back.

**Needs merchant test credentials from the user.** If they don't have them yet, park this task; the pilot runs on pickup + cashier payment.

## [ ] 10. Order admin + notifications (stage 6, part)
Orders appear in admin with statuses new → yig'ilmoqda → yo'lda → yetkazildi / bekor qilindi. The customer gets the order number and its status by Telegram bot (SMS later).
Done when:
- A status change sends a message (tested with a mock).
- A store manager cannot change another store's orders.

## [ ] 11. Deploy + pilot report (stage 7)
Dockerfile + docker-compose (app + PostgreSQL), HTTPS (the camera needs it), logs and error monitoring. README covering install, `.env` variables and adding a store. Pilot report: accepted the suggestion → tried it on → bought / ordered delivery, plus average order value.
Done when:
- `docker compose up` works against Postgres.
- The README is complete.
