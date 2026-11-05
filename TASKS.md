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

## [ ] 2. Admin: auth + products + stock (stage 2, part)
`/admin`: email + password login (scrypt) with a 12h token. Super-admin sees all stores; a store manager sees only their own. Product list with search and category filter, plus add, edit and delete. Size table (XS–XXL or 36–45) with stock counts.
Done when:
- There is a test that a store manager cannot read or change another store's products.

## [ ] 3. Admin: CSV import, images, stats (stage 2, part)
CSV import of products and stock, image upload, and a stats page (recommendations per day, most-suggested items).
Done when:
- An import test covers bad rows.
- The stats page reads recommendation_logs. It may be empty until task 4.

## [ ] 4. Rule-based recommendation (stage 3)
`POST /api/recommend` without AI. Weather from Open-Meteo by store coordinates, with a 10-minute cache; offline it falls back to the monthly average temperature. Filter: same store + stock > 0 in the customer's size + gender + temp_min ≤ t ≤ temp_max. Waterproof items come first when it rains. Build 2–3 outfits: outerwear when below 18 °C or raining, plus top, bottom, shoes and an optional accessory, with no item repeated across outfits. Each item's price uses the discount price when set, and each outfit has a total. With a budget, return only outfits that fit; if none fit, return the cheapest outfit and how far over budget it is. Each outfit gets one cheaper alternative. Log to recommendation_logs.
Done when there are unit tests for:
- No stock-0 item is ever returned.
- −10, 5, 15 and 30 °C and rain pick the right categories.
- Discount and total maths.
- The budget limit and the over-budget case.
- No repeated items, and the offline weather fallback.

## [ ] 5. Customer app: screens + QR (stage 4, part)
One app for `/kiosk?store=1` (big buttons) and `/m?store=1` (mobile). Screens: 1) start + weather, 2) gender and height (required), weight, shoe size and budget (optional), 3) camera placeholder (filled in by task 6), 4) results: outfits, item prices, outfit total, "Savatga qo'shish". Use manually entered sizes for now. On the kiosk, return to start and clear the cart after 90 s idle. Admin gets a "print QR" button per store.
Done when:
- The full flow works in the browser with manual sizes.
- There is an idle-reset test.

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
