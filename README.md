# Smart Fit

Outfit recommendations for clothing stores, on an in-store kiosk and on the customer's phone (QR). Only items that are
in this store and in stock in the customer's size are suggested and sold. The customer's size comes from a photo (measured
in the browser, the photo is never stored), the outfits fit today's weather and budget, and the customer can put a whole
outfit in the cart, pick it up and pay at the cashier, or order delivery and pay with Click/Payme.

- Landing page: `/` (uz/ru): what it does, a live outfit card, the kiosk and phone demo links (`/kiosk?store=1`,
  `/m?store=1`) and a "Demo so'rash" form (stored, shown to the super-admin, sent to the product owner's Telegram)
- Customer app: `/kiosk?store=<id>` (kiosk, big buttons, resets after 90 s idle) and `/m?store=<id>` (phone)
- Admin: `/admin` (dashboard, products, stock, CSV import, orders, returns, cashier, QR codes, stats and the pilot
  report, Talab (missed demand), promo codes, settings, team, audit log; super-admin: organisations and demo requests)
- Staff app: `/staff/` (installable phone app for the shop floor: fitting-room queue, orders to collect, low stock,
  kiosk-offline alerts; the `staff` role sees nothing else)
- Customer profile page: `/profile/<token>` (sent by the Telegram bot; only when a bot is configured)
- API: `/api/...`, health check `GET /api/health`. Errors are `{ code, error }`: a stable `code` and the message in the
  request's language (`?lang=uz|ru` or `Accept-Language`, default Uzbek)
- Languages: Uzbek (Latin, default) and Russian, one dictionary in `public/shared/i18n.js`; switch on the start screen
  and in the admin header (the kiosk goes back to Uzbek after 90 s idle)
- Full spec: [`docs/SPEC.md`](docs/SPEC.md), build log and decisions: [`TASKS.md`](TASKS.md)

What phase 2 (tasks 13–22) added on top of the pilot:

- **Organisations (SaaS tenants):** a brand is an organisation with one or more stores. Its owner manages every store of
  the organisation and never sees another one; managers work in one store. A new customer is onboarded with an invite
  link and a three-step wizard (store profile → products from CSV with a sample file → QR to print).
- **Design system and languages:** one `ui.css` (tokens, components, self-hosted Onest + Cormorant fonts, icon sprite),
  Uzbek and Russian everywhere, error messages in the request's language.
- **Customer app:** attract screen with today's looks, step bar, outfit cards with photos, on-screen keypad on the kiosk,
  size chips, history routing, store picker, demo catalogue of 82 items with drawn product images.
- **Orders:** per-store order numbers, a public order status page, a live cart hold countdown, kiosk → phone cart handoff
  by QR, and "bring it to the fitting room" requests to the staff Telegram chat.
- **Admin back office:** sidebar shell, dashboard with KPIs and charts, paged/sorted/filtered lists, CSV export, cashier
  page with receipts, store settings, team with one-time invites, roles (super / owner / manager), audit log.
- **Inventory:** SKU and barcode, per-store low-stock threshold with Telegram alerts, a stock sync API for the till/1C.
- **Hardening and kiosk:** strict CSP and security headers, per-IP rate limits, self-hosted MediaPipe/Leaflet/model,
  kiosk PWA (fullscreen, wake lock, attract loop, staff exit PIN) and a kiosk heartbeat in admin.

What phase 3 (tasks 23–28, features seen in similar products) added:

- **Fit learns from returns (23):** returns and size exchanges per order line with a reason, a "how did it fit?"
  question after handover, and a per-product fit offset ("runs small → one size up") used by the size step.
- **Missed demand (24):** every size the recommender wanted but had 0 of is logged (no personal data); admin → Talab
  shows it with restock suggestions, the funnel drop-off by step and kiosk, and a weekly owner report in Telegram.
- **Catalogue (25):** browse with filters, an item page with "Shu bilan yaxshi ketadi", other stores of the organisation
  that have the size (reserve there for pickup), swap one item inside an outfit.
- **Promotions (26):** promo codes per store or organisation and a "whole outfit" bundle discount, computed by the server.
- **Customer profile through Telegram (27):** the shared contact verifies the phone (no SMS); sizes and body numbers
  (never the photo), saved looks, order history, kiosk login by QR, "delete my data".
- **"Kelganda xabar bering" (31):** on a sold-out size (item page, or a result card whose size just sold out) the customer
  asks the bot to tell them; one Telegram message with the item link when that size has free stock again, whatever
  raised it (admin edit, CSV, sync API, a return, a cancelled order). Waiting requests on the profile page (cancel) and
  per product and size on Admin → Talab.
- **Staff app (28):** `/staff/` for the shop floor (see below) and a new `staff` role.
- **Cashback points (34):** per organisation (Admin → Sozlamalar → Ballar; off by default): a percent of the money paid
  for the goods comes back as points when the order is handed over or delivered; at checkout the customer confirms in
  Telegram and points pay up to a set share of the goods (never delivery). Balance and history on the profile page and
  `/points` in the bot; a per-customer list for the owner and managers. Points stay inside one organisation.
- **Points expiry and corrections (39):** optional expiry, 1–36 months (Ballar → "Ballar amal qilish muddati"; off
  by default; points from before it was turned on count from that day). The oldest points are used first; an hourly
  sweep in the server writes the expired part as an `expire` ledger row, and with the bot on the customer gets one
  Telegram reminder 7 days before. The owner can add or remove points for one customer with a reason (never below
  zero; audited). The customer list has a search by name or phone and a CSV export.

Stack: Node.js 22 + Express 5, Knex with PostgreSQL in production (SQLite file in development), vanilla JS frontend,
Caddy for HTTPS.

## Run locally (development)

```bash
nvm use                      # Node 22 (.nvmrc)
npm install
npm run vendor               # pose model for size-from-photo (9 MB, Google's MediaPipe URL, sha256-checked)
cp .env.example .env         # every variable is optional in development
npm run seed                 # demo data: 2 stores × ~75 items + 11 children's items each, with demo images (wipes the DB!)
npm run admin:create -- boss@example.uz   # super-admin; asks for the password
npm start                    # http://localhost:3000/kiosk?store=1  and  /admin
```

Without `DATABASE_URL` the app uses the SQLite file `SQLITE_FILE` (default `./smartfit.db`). Migrations run on every start.

Tests: `npm test` (SQLite in memory). To run the same suite against PostgreSQL, point `TEST_DATABASE_URL` at a
throwaway database (each test file creates its own schema there and leaves it behind):

```bash
docker run -d --rm --name smartfit-testpg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=smartfit_test -p 55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/smartfit_test npm test
docker stop smartfit-testpg
```

## Environment variables (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | HTTP port of the app. |
| `DATABASE_URL` | empty | `postgres://user:pass@host:5432/db` → PostgreSQL. Empty → SQLite. docker compose sets it for you. |
| `SQLITE_FILE` | `./smartfit.db` | SQLite file when `DATABASE_URL` is empty. |
| `ADMIN_TOKEN_SECRET` | random per process | Signs admin login tokens (12 h). **Required in production.** Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `UPLOAD_DIR` | `./uploads` | Product photos uploaded in admin (served at `/uploads`). Customer photos are never saved. |
| `PUBLIC_URL` | empty | Public address, e.g. `https://fit.example.uz`. Used in the store QR codes and the Click/Payme return link. **Set it in production.** |
| `ANTHROPIC_API_KEY` | empty | Claude stylist. Empty → rule-based recommendations only (the app works fully without it). |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | Must accept a forced `tool_choice` and answer within 8 s. |
| `PAYME_MERCHANT_ID`, `PAYME_KEY` | empty | Payme Merchant API. Off (and hidden in the app) until both are set. Use the TEST_KEY while testing. |
| `PAYME_CHECKOUT_URL` | `https://test.paycom.uz` | Set `https://checkout.paycom.uz` for live payments. |
| `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY` | empty | Click SHOP API. Off until all three are set. |
| `FASHN_API_KEY` | empty | AI try-on "O'zimda ko'rish" (see below). Empty → the feature is off and the app looks as before. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | empty | Order status messages to customers, and the customer profile (task 27: "Profilimni saqlash", kiosk "Profil bilan kirish", bot commands `/profile` and `/delete`). Both needed; empty → no messages and no profile buttons. The profile page link in the bot chat needs `PUBLIC_URL`. |
| `TELEGRAM_OWNER_CHAT_ID` | empty | Your own Telegram chat id (the product owner): every landing-page demo request is sent there once. Empty → requests wait in `/admin` → Tashkilotlar and are sent once it is set. Needs the bot above. |
| `POSTGRES_PASSWORD` | — | docker compose only: the database password (compose builds `DATABASE_URL` from it, so letters and digits only, e.g. `openssl rand -hex 24`). Required by compose. |
| `DOMAIN` | `localhost` | docker compose only: the HTTPS domain Caddy serves and gets a certificate for. |
| `NODE_ENV` | empty | `production` requires `ADMIN_TOKEN_SECRET` and blocks `npm run seed`. compose sets it. |
| `TRUST_PROXY` | empty | Number of reverse proxies in front of the app. compose sets `1` (Caddy), so client IPs (login lock, rate limits, open-cart cap) and `https` (QR links) are right. Leave empty when the app is reached directly. |
| `RATE_RECOMMEND_PER_MIN`, `RATE_SIZE_PER_MIN`, `RATE_CART_PER_MIN`, `RATE_LOGIN_PER_MIN`, `RATE_KIOSK_PER_MIN`, `RATE_PIN_PER_MIN`, `RATE_DEMO_PER_MIN`, `RATE_FUNNEL_PER_MIN`, `RATE_CATALOG_PER_MIN`, `RATE_PROMO_PER_MIN`, `RATE_PROFILE_PER_MIN`, `RATE_PROFILE_POLL_PER_MIN`, `RATE_SCAN_PER_MIN`, `RATE_MALL_PER_MIN`, `RATE_TRYON_PER_MIN` | 60, 30, 300, 20, 30, 5, 3, 120, 300, 20, 20, 300, 120, 300, 4 | Per-IP token buckets (requests per minute, bursts up to the same number) on `/api/recommend`, `/api/size`, `/api/cart/*`, admin login, the kiosk heartbeat, the kiosk exit PIN, the landing page's demo form, the customer funnel events (`/api/funnel`), the catalogue (`/api/catalog/*`), promo code tries (`POST /api/cart/:token/promo`), new profile links / kiosk login QRs and the profile page (`/api/profile/*`), the screens waiting for the bot (`GET /api/profile/token/*`), garment QR label scans (`GET /q/*`; over the limit the phone is still redirected, the scan just isn't logged), the mall screen's directory and search (`/api/malls/*`), and AI try-on pictures (`POST /api/tryon`, each one paid). Over the limit → `429` with `Retry-After`. `0` = off. Every phone on the shop Wi-Fi shares the kiosk's public IP, so keep them generous. |
| `MAX_OPEN_CARTS_PER_IP` | 30 | Live carts (each holds stock for 15 min) one client IP may have at once; the next new cart → `429 too_many_carts`. Unpaid other-store reservations (task 25, held 3 h) count against the same cap (`429 too_many_reserves`). `0` = off. |
| `ERROR_WEBHOOK_URL` | empty | Optional error monitoring: every error log line is POSTed as JSON `{text, content, level, time}` (works with Slack, Discord and Mattermost incoming webhooks), at most 10 a minute. |

Secrets live only in `.env` (git-ignored), never in code. The logs redact them anyway (see Logs below).

## Deploy (docker compose: app + PostgreSQL + Caddy HTTPS)

Needs a Linux server with Docker, a domain whose A record points at the server, and ports 80 and 443 open
(the camera on phones only works over HTTPS, and Let's Encrypt checks the domain over port 80).

```bash
git clone <repo> smart-fit && cd smart-fit
cp .env.example .env
# edit .env: POSTGRES_PASSWORD, DOMAIN=fit.example.uz, PUBLIC_URL=https://fit.example.uz, ADMIN_TOKEN_SECRET,
#            plus the optional Claude / Payme / Click / Telegram / ERROR_WEBHOOK_URL values
docker compose up -d --build
docker compose exec app npm run admin:create -- boss@example.uz   # first super-admin (asks for the password)
```

Then open `https://fit.example.uz/admin`. Caddy gets and renews the certificate on its own; the app container
migrates the database on start. Check it: `curl https://fit.example.uz/api/health` → `{"ok":true}`.

- Logs: `docker compose logs -f app`. Update: `git pull && docker compose up -d --build`.
- Backups: `docker compose exec db pg_dump -U smartfit smartfit > backup-$(date +%F).sql` (put it in cron and copy
  it off the server). Restore: `docker compose exec -T db psql -U smartfit smartfit < backup.sql`.
- Run **one** app container: the Telegram long poll, the order outbox and the in-memory rate limits live in that process.
- Product photos are in the `uploads` volume, the database in `pgdata`, certificates in `caddy_data`.
- Demo data on a test server: `docker compose exec -e NODE_ENV=development app npm run seed` (**wipes everything**;
  production refuses to seed).
- Local smoke test of the whole stack: `DOMAIN=localhost` (the default) and `https://localhost` (Caddy's own certificate,
  the browser will warn).

## Onboarding a new customer (organisation)

The usual way, all in the browser:

1. Sign in to `/admin` as super-admin → **Tashkilotlar** → "Tashkilot qo'shish": the brand name and the owner's email.
   You get a one-time link (valid 48 hours, shown once). Send it to the owner.
2. The owner opens it, sets a password and lands in the wizard: **store profile** (name, city, address, map point,
   delivery fee) → **products** ("Namuna faylni yuklab olish" gives a sample CSV in the import format; uploading the
   sample itself adds 52 demo items to try) → **QR code** to print, with the kiosk and phone links.
3. Later the owner adds more stores (Sozlamalar → Do'kon → "Do'kon qo'shish", the same wizard) and invites managers and
   shop-floor staff (Sozlamalar → Jamoa, role "Menejer" or "Sotuvchi"). The owner sees and manages every store of their organisation and nothing of any other.

Demo requests from the landing page show under the same **Tashkilotlar** page ("Ko'rib chiqildi" marks one handled).

## Shopping malls (several shops, one entry screen)

A mall holds shops of different organisations; each shop keeps its own admin, team, products, prices, orders and
payment. The mall gets its own admin, who sees the shops and summary numbers only.

1. Super-admin → **Savdo markazlari** → "Savdo markazi qo'shish": name, city, address (map point optional) and the mall
   admin's email → a one-time link for that admin. The edit dialog puts existing stores in the mall (a store is in one
   mall at most); "Admin taklif qilish" makes another admin link. Only an empty mall can be deleted (its admins go with it).
2. The mall admin (`/admin` → **Savdo markazi**) invites shops ("Do'kon taklif qilish": the shop's name and its owner's
   email → the owner's link). The owner's first store, made in the usual wizard, joins the mall. Per shop the mall admin
   sets the floor, unit and logo and can hide it from the directory, and sees customer visits (kiosk / phone), the paid
   orders count and kiosks online, never sums, products, customers or the team. The page has the mall QR (`/m?mall=ID`)
   and the link for the mall's own kiosks (`/kiosk?mall=ID`).
3. Customers: `/kiosk?mall=ID` and `/m?mall=ID` show the shop directory and a search over every shop's in-stock items.
   A shop or an item opens that shop's usual flow (`?store=&mall=`). A mall kiosk sends no shop heartbeat and has no
   staff PIN exit (close it from the OS). A store outside any mall works exactly as before (`?store=`).
4. **One cart across the mall** (task 38): items picked in several shops go into one mall cart (`/api/mall-cart`), which
   is one ordinary cart per shop under one token. In a shop, the cart screen keeps that shop's lines, promo code and
   points (they belong to the shop's organisation); "Barcha do'konlar bo'yicha rasmiylashtirish" opens the mall cart
   (`?mall=ID#cart`): every shop with its floor/unit, discounts and total, an instalment term per shop where the shop
   offers one, and one name + phone form. Checkout makes **one order per shop** (each with its own number, total and
   15 minutes to pay at **that shop's cashier**) tied by a mall order number and a status page `/mall-order/<token>`.
   All or nothing: if one shop's part fails (a promo code switched off, points changed), nothing is created and the
   message names the shop. Pickup only (no delivery from a mall cart). Each shop's admin, cashier and staff app see only
   their own order, marked "Savdo markazi buyurtmasi № N qismi"; the mall admin still sees counts only. Every shop's
   hold runs out at the same moment; the kiosk idle reset empties the whole mall cart.

The demo seed has one mall, "Demo Savdo Markazi" (id 1), holding both demo stores.

## Adding a store and its staff from the command line

1. Create the store (the id it prints goes into the kiosk URL, the QR code and the manager account):
   ```bash
   docker compose exec app npm run store:create -- "Smart Fit Buxoro" "Buxoro" 39.7747 64.4286 "Navoiy ko'chasi 1" 25000 1000000
   # name, city, lat, lon (for the weather), address, delivery fee in so'm, free delivery above (so'm, optional),
   # organisation id (optional: without it the store joins the only organisation, or a new one on a fresh install)
   ```
   (Without docker: `npm run store:create -- ...`.)
2. Create the store owner: `npm run admin:create -- owner@example.uz <store_id>` (add `manager` or `staff` as a third
   argument for a manager or a shop-floor account instead). No store id → super-admin (sees all stores). The password is asked on stdin, or taken from `ADMIN_PASSWORD`.
   Roles: **super** = every organisation; **owner** = every store of their organisation, plus the stores' settings
   (address, map pin, hours, delivery fee, staff Telegram chat), the team and the audit log; **manager** = products,
   orders and the cashier of one store; **staff** = only the staff app (`/staff/`) of one store: fitting-room requests,
   moving paid orders forward (collect → hand over / ship), low stock and kiosk alerts. No products, prices, settings,
   cashier or cancelling. An owner made with `admin:create` belongs to that store's organisation. After that the
   owner adds staff in `/admin` → Sozlamalar → Jamoa: "Taklif qilish" makes a one-time link (valid 48 hours) to send to the
   new manager, who sets their own password with it.
3. Set up the shop's categories in `/admin` → "Kategoriyalar" (owner): every organisation starts with the five built-in ones
   (Ustki kiyim, Ko'ylak / futbolka, Shim / yubka, Poyabzal, Aksessuar) and can rename, hide, reorder or add its own
   ("Sumkalar", "Atirlar" with their own sizes…). A category's outfit role decides whether its items join whole outfits;
   one without a role shows only in the catalogue and as single items. A category with products can be hidden, not deleted.
   **Children's clothes (task 40):** set a category's "Kimlar uchun" to "Bolalar". With a role, its sizes become the
   children's ones: clothes by height `92, 98 … 164` (the size is the tallest height it fits), shoes `22…35`; accessories stay
   one size. Its products are for children: they are offered only on the kiosk's "Bolaga" path (sized by the child's height,
   no photo, no weight) and in the catalogue / mall search under "Bolalar", never to adults, and adults' items never to a
   child. Boy / girl / any is the product's gender (male / female / unisex).
   Then add products in `/admin` → "Kiyimlar" (form, or "CSV yuklash" for a whole catalogue), set stock per size, upload
   photos, a description in both languages and up to 10 details ("Mato → 100% paxta").
   CSV columns (`,` or `;`, UTF-8, header row): `id, sku, barcode, store_id, name, name_ru, category, audience, gender, color, style, price,
   discount_price, temp_min, temp_max, waterproof, shelf_location, description, description_ru` plus one stock column per size
   (`XS…XXL`, `36…45`, `ONE`, the children's `92…164` and `22…35`, and the shop's own sizes). `audience` (`adult` / `child`) is
   optional: the category decides it, and a filled cell that doesn't match the category is a row error (older files without
   the column import as before). A filled
   `id` updates that product; else a `sku` that already exists in the row's store updates that product; else a new one is
   created. SKUs are unique per store (letters, digits, `. _ - /`, up to 40). `category` is the shop's category by name (Uzbek or
   Russian, any case; the old codes `outerwear/top/…` still work); an unknown name lists the shop's categories. Genders
   `male/female/unisex`, prices in whole so'm. Any bad row rejects the whole file with the line numbers.
4. Kiosk: open `https://<domain>/kiosk?store=<id>` full screen in the kiosk browser (Chrome kiosk mode), allow the camera.
5. Phone: `/admin` → "QR kodlar" → "QR chop etish" and put the print next to the kiosk / in the fitting rooms.

## Online payment (Click, Payme)

Cashier payment always works. A provider appears in the phone app only when all its keys are set.

- **Payme**: in the merchant cabinet set the endpoint `https://<domain>/api/pay/payme` and the account field
  `order_id`. Put the merchant id and key into `PAYME_MERCHANT_ID` / `PAYME_KEY` (the TEST_KEY with
  `PAYME_CHECKOUT_URL=https://test.paycom.uz` for the sandbox; the live key with `https://checkout.paycom.uz` for real money).
  Run the sandbox scenarios at test.paycom.uz before going live.
- **Click**: in the Click merchant cabinet set Prepare `https://<domain>/api/pay/click/prepare` and Complete
  `https://<domain>/api/pay/click/complete`, then fill `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY`.
- The amount is always the server's order total; an order becomes paid only through a verified callback.
  An unpaid order is cancelled after 15 minutes and its stock comes back. Refunds are made in the provider cabinet
  (or cash at the cashier) after cancelling a paid order in admin.

## AI try-on ("O'zimda ko'rish", task 41)

On an item page and on an outfit card the customer can see the garment on their own photo. The picture is made by
**FASHN** (Virtual Try-On v1.6, `https://api.fashn.ai/v1`), so this is the one place a customer photo leaves for a
company other than Anthropic.

- **Switch it on:** put the key from https://app.fashn.ai/api into `FASHN_API_KEY` (buy on-demand credits first), then
  each shop owner ticks "Mijozlarga «O'zimda ko'rish» tugmasini ko'rsatish" in Sozlamalar › Do'kon and sets the daily
  limit (default 30). The same box lists the pictures per day for the last 14 days. Without the key the box says so and
  the app is unchanged.
- **Which items:** adults' outerwear, tops and bottoms with an **uploaded raster photo** (JPG, PNG or WebP) and stock > 0.
  The demo seed's SVG drawings don't qualify, so the button only appears once a shop uploads real product photos.
  On an outfit it tries the outer layer first (outerwear, then top, then bottom). Never on shoes, accessories, a shop's
  role-less categories or anything in the children's path (task 40).
- **Privacy:** the customer agrees every time, in a dialog that names FASHN and says the picture is approximate. The
  photo (a ≤ 1280 px JPEG made in the browser) goes to our server and on to FASHN in memory only; the picture comes back
  as bytes, is shown as a `blob:` image and is never stored. Neither is written to disk, the database or any log (only a
  short reason like `fashn PoseError` is logged on a failure). The database keeps one number per shop per day.
  "Boshiga", any screen change and the kiosk idle reset drop the photo and the picture.
- **Cost guards (server side):** the shop's daily limit (a conditional count, so parallel requests can't pass it),
  `RATE_TRYON_PER_MIN` per IP (default 4), at most 4 pictures in flight per server (FASHN's default account
  concurrency is 6), a 1.5 MB photo cap and a 45 s deadline. Every request sent to FASHN counts, so the counter is an
  upper bound of the bill (failed predictions are free).

**Provider choice (researched 2026-11-16):**

| | FASHN (chosen) | Google Vertex AI Virtual Try-On | Kling Kolors try-on |
|---|---|---|---|
| API | Public docs, `POST /v1/run` + `GET /v1/status/<id>`, Bearer key | Vertex AI `virtual-try-on-001`, needs a Google Cloud project and service-account OAuth | Kling's own API doc says the feature retired on 2026-09-15; still sold through resellers such as fal.ai |
| Price per picture | $0.075 (1 credit; minimum top-up $7.50 = 100 credits; failed runs free) | ~$0.06 by third-party price trackers; Google's page only points to the Imagen section | $0.07 on fal.ai |
| Speed | ~8 s ("balanced" mode) | not checked | not checked |
| Uploaded photos | Base64 inputs: the processing copy is deleted when the request finishes (1-day cleanup backstop). Base64 outputs: 60 min. Not used for training unless you opt in. A request record (time, model, parameters, placeholders for base64 inputs, status) is kept with no deletion endpoint. | Not reviewed in depth; trackers list a deprecation date of 2027-03-15 | Two companies (reseller + model) see the photo |

FASHN won on a documented API we could code exactly with a few lines of `fetch`, the clearest retention terms for
base64 uploads, no training on customer photos, and free failed runs. Sources: [FASHN data retention](https://docs.fashn.ai/api-overview/data-retention-privacy),
[Try-On v1.6](https://docs.fashn.ai/api-reference/tryon-v1-6), [API fundamentals](https://docs.fashn.ai/api-overview/api-fundamentals),
[API pricing](https://help.fashn.ai/plans-and-pricing/api-pricing), [Vertex AI Virtual Try-On](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/imagen/virtual-try-on-001),
[Kling virtual try-on](https://kling.ai/document-api/api/image/virtual-try-on.md), [fal.ai Kolors try-on](https://fal.ai/models/fal-ai/kling/v1-5/kolors-virtual-try-on/api).
Another provider replaces `createFashn` in `src/tryon.js` (one function: photo + garment in, picture out).

## Telegram notifications

1. Create a bot with @BotFather, put its token in `TELEGRAM_BOT_TOKEN` and its username (without @) in
   `TELEGRAM_BOT_USERNAME`, restart (`docker compose up -d`).
2. After an order the phone shows "Holatini Telegram'da kuzatish" (the kiosk shows a QR). The customer presses Start in
   the bot and then gets a message on every status change.
3. The app long-polls the bot, so don't set a webhook on it and run only one app instance.

4. Low stock: when a size's free units (stock minus what carts hold) drop to the store's threshold (Sozlamalar → Do'kon →
   "Kam qoldi chegarasi", default 1), the staff chat gets one message listing the sizes that crossed. It comes again only
   after the size went above the threshold and back down. The same sizes show on the dashboard under "sizes running out".
5. Weekly owner report: put the owner's chat id in Sozlamalar → Do'kon → "Haftalik hisobot uchun Telegram chat ID".
   Every Monday at 09:00 Tashkent time that chat gets last week's sales, conversion, best sellers, the top 5 missed sizes
   and the low-stock sizes, once per week. Set mid-week, it gets last week's report right away. Admin → Talab shows the
   same missed demand with restock suggestions, the funnel by step and a CSV export.

SMS is a stub (`src/notify/sms.js`): return a `(phone, text)` sender there to switch it on.

## Stock sync API (POS / 1C)

A store's cash register or ERP can push on-hand quantities instead of typing them in. The store owner (or super-admin)
creates a key in `/admin` → Sozlamalar → Ombor API → "Kalit yaratish"; the key (`sfk_…`) is shown once, only its SHA-256
is stored, and it works for that one store until it is deleted there. Every key create/delete and every sync that changed
something lands in the audit log.

```bash
curl -X POST https://<domain>/api/sync/stock \
  -H "Authorization: Bearer sfk_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"sku":"SF-TP-01","size":"M","quantity":12},{"sku":"SF-SH-03","size":"42","quantity":0}]}'
# → 200 {"updated":2,"unchanged":0}
```

- `quantity` is the absolute count on hand for that SKU and size (an integer 0–100 000), not a delta. Sizes are
  `XS…XXL`, `36…45`, `ONE` or the shop's own list, depending on the product's category. Products themselves (name, price…) are not created here:
  add them in admin or by CSV with the same SKU first.
- Up to 1000 items per request. The batch is all-or-nothing: any bad row → `400 {"code":"sync_rows","errors":[{index,sku,size,code,error}]}`
  and nothing changes. Row codes: `sync_sku` (no such SKU in this key's store), `bad_size`, `invalid_qty`, `sync_dup`
  (same SKU + size twice), `size_reserved` (the new quantity is below what customers' carts hold right now; retry later
  or send at least that many).
- A missing, wrong or deleted key → `401 {"code":"sync_key"}`. Errors are in Uzbek, or Russian with `?lang=ru`.

## Kiosk (PWA, self-hosted assets, security headers)

- Open `https://<domain>/kiosk?store=<id>` on the kiosk (Chrome: "Install app", or start it with `--kiosk`). It installs as a
  fullscreen app (`/kiosk.webmanifest`), keeps the screen on (Wake Lock), re-enters fullscreen on the next touch, and a
  service worker (`/kiosk-sw.js`) caches the app shell and `/vendor` files, never API answers or photos.
- After 90 s without a touch it resets for the next customer and the start screen plays a slow attract loop.
- **Staff exit:** hold the logo for 3 s and type the store's kiosk PIN (Sozlamalar › Do'kon, 4–8 digits; stored hashed,
  each change is in the audit log). It leaves fullscreen until the page is reloaded. A browser started with `--kiosk`
  needs the OS to close it; the PIN only covers the in-page lock.
- Every kiosk pings `/api/kiosk/ping` once a minute; the admin dashboard lists them as online (seen in the last 3 min) or
  offline with the last-seen time.
- MediaPipe (size from photo) and Leaflet (delivery map) are served from `/vendor/...@<version>` out of their pinned npm
  packages, the pose model from `vendor/` (`npm run vendor`; the Docker build does it and fails on a checksum mismatch).
  Only OpenStreetMap map tiles still come from the internet.
- Every response carries a Content-Security-Policy (same origin only, plus `tile.openstreetmap.org` images,
  `frame-ancestors 'none'`), `Referrer-Policy`, `Permissions-Policy: camera=(self)`, `X-Content-Type-Options` and
  `X-Frame-Options`. New UI code must not use inline `<script>`, `<style>` or `style="…"` (set styles from JS instead).

## Staff app (shop floor)

`/staff/` is a phone app for the people on the floor; owners and managers can use it too (signing in to `/admin` with a
staff account goes straight there). Add it to the home screen (Android Chrome: "Add to Home screen", iPhone Safari:
"Add to Home Screen"); it opens full screen, and its shell works offline (its service worker never caches the API).

- **Kabinalar:** fitting-room requests from the kiosk/phone ("Kabinaga olib keling"), with the items and shelf.
  "Qabul qilish" takes one (one person per request; others see who has it), "Olib borildi" closes it. The "Bugun" card
  shows today's count, the average time to accept and to bring, per person, and the last few.
- **Buyurtmalar:** paid orders to collect, oldest payment first, with a pick list sorted by shelf. Buttons are the server's
  allowed next steps, the same rules as admin (Yig'ishni boshlash → Mijozga topshirildi, or → Yo'lga chiqarish →
  Yetkazildi); each step updates the customer's status page and Telegram message. Staff can't cancel (a refund) or take
  payment: that stays with a manager (Kassa).
- **Ombor:** sizes at or below the store's low-stock threshold, sold out first.
- **Alerts:** a red line when a kiosk seen in the last day has been quiet for 3 minutes.
- The app polls every 5 s. A new request or a newly paid order rings twice and vibrates, after one tap on "Ovozni
  yoqish" (browsers allow sound only after a tap). With the screen off, phones pause web pages, so keep the staff
  Telegram chat (Sozlamalar → Do'kon) as the backup channel.

## Logs and error monitoring

The server writes one JSON line per event to stdout/stderr (`{time, level, msg, ...}`), one line per request
(`method, path, status, ms, ip`, no query strings or bodies). Before anything is written, values of secret variables,
`data:` URLs, long base64 runs and 32+ hex tokens (cart, order, recommendation tokens) are replaced with
`[secret]`, `[data]`, `[base64]`, `[token]`. Customer photos are never logged or stored in the first place.
Set `ERROR_WEBHOOK_URL` to get every error (500s, failed callbacks, crashes) in a Slack/Discord/Mattermost channel.

## Pilot report

`/admin` → "Statistika" → "Pilot hisoboti", per period (7/30/90 days) and store:

| Step | How it is counted |
|---|---|
| Tavsiya ko'rsatildi | results screens shown (one per customer: the −/+ size changes update the same row) |
| Taklifni qabul qildi | the customer added at least one suggested item to the cart from that screen |
| Kiyib ko'rdi | the customer tapped "Kiyib ko'rdim" under the outfits |
| Sotib oldi | a paid (not refunded) order came from a cart filled from that screen |

Below it: paid orders, how many of them are delivery orders, revenue and the average order value (paid, not
cancelled orders in the period). "Tried on" depends on customers tapping the button, so ask staff to remind them.
Purchases rung up only on the store's own till (not through the app) are not counted.

## Launch checklist

Everything below was left manual or pending while building (see the Notes in `TASKS.md`). Tick them before and during
the 2-week pilot.

**Server and HTTPS**
- [ ] Server with Docker, a domain and DNS A record, ports 80/443 open; `DOMAIN`, `PUBLIC_URL`, `POSTGRES_PASSWORD`,
      `ADMIN_TOKEN_SECRET` set; `https://<domain>/api/health` answers.
- [ ] Real store created with `store:create`, its manager account, the real catalogue and stock (CSV), product photos.
      The demo seed is not used in production.
- [ ] Daily `pg_dump` backup copied off the server.
- [ ] `ERROR_WEBHOOK_URL` set and one test error seen in the channel.
- [ ] Stock is kept current: the shelf and the database must match (a daily stock update or a sync with the store's
      till; the spec lists stale stock as a risk).

**Phones, kiosk, camera**
- [ ] QR → `/m` → camera with the 10 s timer → gallery picker on a real iPhone (Safari) and a real Android (Chrome), over HTTPS.
- [ ] Size accuracy on 20 people: the size from the photo matches the real size in ≥ 70 % of cases. The size chart and
      factors in `src/size/size.js` are marked `shortcut:` guesses; recalibrate them from these measurements.
- [ ] Speed: photo to results in under 15 s on the kiosk and a mid-range phone.
- [ ] Kiosk placement: light and background good enough for MediaPipe; the 90 s idle reset empties the cart
      (browser-check it on the kiosk).
- [ ] MediaPipe model and wasm load from jsDelivr / Google Storage: the kiosk needs internet, or self-host them
      (`public/app/pose.js`) if the kiosk can be offline.
- [ ] Print the store QR on the real printer.
- [ ] The kiosk QR on the order screen scans to the Telegram bot.

**Claude stylist**
- [ ] Live `ANTHROPIC_API_KEY`: run real requests, check the answer comes within the 8 s limit and the Uzbek titles and
      reasons read well. Turn the internet / key off once and check the rule-based fallback.

**AI try-on (task 41, only if a shop wants it)**
- [ ] Live `FASHN_API_KEY` with credits; switch one shop on; on a real phone and the kiosk: item with a real product photo →
      "O'zimda ko'rish" → consent → photo → the picture arrives within ~15 s and reads as the right garment; the counter
      in Sozlamalar shows it. Check the status path `/v1/status/<id>` and the base64 output shape against the live API
      (the docs don't show a full example of either).
- [ ] Read FASHN's current Terms and Data Retention page once more and keep the consent text in step with them.

**Payments (only if delivery/online payment is in the pilot; the spec says start with pickup + cashier)**
- [ ] Payme sandbox (test.paycom.uz, TEST_KEY) and Click test service: payment, cancel, callback, 15-min expiry.
- [ ] Payment choice and pay link checked in a phone browser.
- [ ] Switch to live keys and `PAYME_CHECKOUT_URL=https://checkout.paycom.uz`.
- [ ] Click: a Complete that arrives after the order expired is answered with an error (no automatic reversal); watch
      for it in the Click cabinet and refund by hand.

**Telegram**
- [ ] Bot created with @BotFather, `TELEGRAM_BOT_TOKEN` + `TELEGRAM_BOT_USERNAME` set; order on a phone → Start →
      change the status in admin → the message arrives.
- [ ] Back-in-stock (task 31) with the live bot and `PUBLIC_URL` set: sold-out size on the phone → "Kelganda xabar
      bering" → Start + share the contact → raise the stock in admin → one message arrives, its link opens the item page.

**Store process**
- [ ] Return and exchange terms written and shown to delivery customers (risk: wrong size delivered).
- [ ] Staff know the cashier dialog ("Kassa"), the order statuses and that a cancelled paid order needs a manual refund.
- [ ] Consent text on the camera screen reviewed (photo not saved; a small copy goes to Claude when the key is set).

**Landing page and organisations (task 22)**
- [ ] The landing's demo links open `/kiosk?store=1` and `/m?store=1`. On a fresh production install, create a demo
      organisation and store first (so it gets id 1) and fill it with the sample CSV; on the migrated pilot database
      store 1 is the real pilot store, so either accept that or change the two links in `public/landing/index.html`.
- [ ] `TELEGRAM_OWNER_CHAT_ID` set and one demo request seen in your chat.
- [ ] The demo form collects a name and a phone number: add a short privacy note / personal-data consent text that fits
      Uzbek law, and decide how long requests are kept.
- [ ] After the migration, all existing stores sit in one organisation named "Smart Fit": rename it if needed (SQL for
      now, `update organizations set name = … where id = 1`) and check Sozlamalar → Jamoa: every former store owner is
      now an owner of the whole organisation and can manage all its stores. Demote or disable anyone who should not.
- [ ] Replace the landing screenshots (`public/landing/img/*.jpg`, taken from the demo store) with photos or
      screenshots of a real store when there is one, and confirm the sample texts in the onboarding fragment
      ("Bunyodkor ko'chasi 1", the 52-item count) still read right.

**Phase 3 features (tasks 23–28)**
- [ ] Customer profiles need the real Telegram bot (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`) and `PUBLIC_URL`:
      on a real phone save a profile from the results screen → share the contact in the bot → the profile link
      arrives; kiosk "Profil bilan kirish" QR scanned with a real phone fills the form; `/delete` removes it. (Task 27
      was checked with simulated bot updates only.)
- [ ] Profile consent text and the delete rule (finished orders keep number, items, sums and phone, lose name and
      address) reviewed against Uzbek personal-data law.
- [ ] Fit feedback: with `PUBLIC_URL` set, a handed-over order's status page and Telegram message ask "how did it fit?";
      check a product's fit offset only after it has ≥ 5 answers. Refunds for returns are paid back by hand (cash or the
      Payme/Click cabinet); staff know this.
- [ ] Cashback points: decide the percent and the share points may pay; tell cashiers that a returned item gives back
      its points share as points (not cash) and takes back the points it earned, and that "delete my data" forfeits
      the balance. Add `/points` to the bot's command list in @BotFather.
- [ ] Points expiry: decide whether points expire (and after how many months) before turning it on, and tell
      customers; turning it on later is safe (old points get the full term from that day).
- [ ] "Muddatli to'lov" (task 35): there is **no Uzum Nasiya / Alif Nasiya API integration** (it needs a merchant
      agreement). Each store that turns it on needs its own Nasiya terminal and contract; enter the terms and markup
      percents the provider really charges (the screens show "~" figures computed from them). Tell cashiers: an order
      flagged "muddatli · N oy" is settled by making the contract on the terminal, then "Pul olindi: to'landi"; the
      order total stays the shelf price. The order still expires 15 min after checkout, like every cashier order, so a
      slow contract may need the order placed again. A later API integration would replace the manual step.
- [ ] Mall cart (task 38): **online payment (Click / Payme) for a mall order is off**: it needs a mall-level merchant
      account and a split of the money between the shops' accounts. Until then each shop's part is paid at that shop's
      cashier. Delivery from a mall cart and moving a mall cart from the kiosk to the phone (QR) are not built: a
      customer who wants delivery orders in one shop's own flow. Tell cashiers that an order marked "Savdo markazi
      buyurtmasi № N" is only their shop's part: the customer pays the other shops separately.
- [ ] Promo codes: decide the codes, dates and limits. The per-phone limit uses the typed phone (not verified), and
      Telegram order messages show only the total.
- [ ] Missed demand and funnel logs have no cleanup yet: decide a retention period. The funnel endpoint is public
      (rate-limited), so treat its counts as indicative.
- [ ] Other-store reserve works only between stores of one organisation; a reservation shows in the target store's
      admin as an ordinary pending pickup order: tell that store's staff.
- [ ] Staff app: invite every floor employee as "Sotuvchi"; install `/staff/` on the real staff phones (Android +
      iPhone), tap "Ovozni yoqish", send a fitting request from the kiosk and hear it ring; collect → hand over an order
      and see the customer's status page change. Real push notifications (screen off) are not built: keep the staff
      Telegram chat set as the backup.

**Known limits to watch during the pilot**
- Per-IP rate limits and the open-cart cap (task 21) count a whole store's Wi-Fi as one client. If customers see
  "So'rovlar juda ko'p", raise the `RATE_*` / `MAX_OPEN_CARTS_PER_IP` values.
- One app instance only (Telegram long poll, outbox, in-memory limits).
