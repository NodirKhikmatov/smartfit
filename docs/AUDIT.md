# Smart Fit — audit after tasks 0–11 (task 12)

Date: 2026-11-09. Scope: every screen of the customer app (`/kiosk`, `/m`), the admin panel, the API, the seed data, and the code under `src/` and `public/`.

How it was checked:
- The app ran on port 3071 against a copy of `smartfit.db`, with live Open-Meteo weather (17 °C and rain in Tashkent, 15 °C in Samarkand).
- Customer flow clicked through at 1280×800 (kiosk) and 375×812 (phone): start, form, validation, camera (blocked in the audit browser, so the denied path was tested), no-photo results, shoe size, add outfit, cart, pickup checkout, order screen, wrong and missing store.
- `/api/recommend` was called for every size × gender × store.
- **Admin was reviewed from the code, not in a browser.** The audit browser wasn't allowed to sign in, so the admin findings below come from `public/admin/index.html` and `src/admin/routes.js`. Task 18 must click through admin once it is rebuilt.

Severity:
- **S1**: blocks selling it or makes the pilot look broken.
- **S2**: a clear product gap that a store owner will notice.
- **S3**: polish.

IDs (D = design, R = recommendations, U = UX, A = admin, I = i18n, X = security/performance/reliability) are used by the phase-2 tasks in `TASKS.md`.

## S1 — critical

| ID | Screen | What's wrong | Why it matters | Fix |
|---|---|---|---|---|
| R1 | Results | Every size and gender gets **at most 1 outfit** at 17 °C plus rain, in both stores. Toshkent XL gets **0 outfits** (empty state). Measured: store 1 male/female XS–XXL = 1,1,1,1,0,1; store 2 = 1 everywhere. The spec promises 2–3. | The core promise ("2–3 outfits for today's weather") fails on the first try. It looks broken. | Two causes. (a) The seed has only 25 items, about 2 per category per temperature band (for example, the only male bottoms valid at 17 °C are Klassik jinsi and Chino, and Chino M has 0 stock). (b) `buildOutfits` makes outfit *i* from the i-th item of every category, so the outfit count is the minimum over categories. Fix: a realistic catalogue (task 15), plus a fallback that widens the temperature window by ±3 °C step by step until 3 outfits exist or ±6 °C is reached, marked in the response. Also, when outerwear is required but missing, return outfits without it and show a note instead of nothing. |
| R2 | Results, cart | **No product photos anywhere.** Every item shows an empty grey square, and the cart reserves the space but shows nothing. | Clothing is sold visually. Without photos it isn't a real store, and the AI "outfit" means nothing to the customer. | Seed demo images for every product (license-free, committed under a demo folder, copied to `UPLOAD_DIR` by the seed). Show a category icon placeholder when there is no image. In admin, flag products without a photo. |
| D1 | All | **No design system.** There are two separate inline `<style>` blocks with different tokens (the app has `--card`/`--accent-soft`, admin has hard-coded 15 px/13 px/`#fff`). Type is the system font only. There is no logo, icons, weather icon, imagery or favicon (`/favicon.ico` → 404). Every surface is a white card with a 1 px border. | The user's words: "it doesn't look like a real SaaS app." First impressions with store owners decide the sale. | A shared `public/shared/ui.css` with tokens (colour, 4/8 spacing, type scale, radius, elevation, motion), components (button, chip, field, card, badge, table, dialog, toast, skeleton), an icon set (inline SVG sprite), a wordmark and a favicon. Both apps use it. |
| D2 | Kiosk, all screens | The kiosk at 1280 px uses the phone's 760 px single column, so two-thirds of the screen is empty. The start screen is a heading, a text card and a button. There is no attract state, no imagery and no sense of "kiosk". | A kiosk has to draw people in from 2 m away and work at arm's length. Right now it reads as a web form. | A kiosk layout: a full-height attract screen (store name, big weather with an icon, "Boshlash"), a step progress bar, results as a 2–3 column visual grid of outfit cards with large photos, and a sticky cart/total bar. |
| A1 | Admin shell | Admin is a single page. Tabs are plain buttons with no URL routing (a refresh always lands on "Kiyimlar"). "Kassa" and "QR kodlar" are header buttons that open dialogs. There is no dashboard and no sidebar. Stats are tables with CSS bars. | A store owner opening the back office expects a SaaS dashboard: today's sales, orders waiting, low stock, conversion. This is what they'll judge the product by. | A sidebar shell with hash routes (`#/dashboard`, `#/products`, `#/orders`, `#/stats`, `#/settings`), a dashboard home with KPI tiles and charts (task 18). |
| U1 | `/` | The root URL returns `Cannot GET /` (Express default 404 page). | Anyone who types the domain sees an error. There is nothing to show a prospect. | A landing page at `/` (task 22). For now, at least redirect to it or to `/admin`. |

## S2 — major

### Recommendation quality and data

| ID | Screen | What's wrong | Why it matters | Fix |
|---|---|---|---|---|
| R3 | Results with budget | A 500 000 so'm budget gives "the cheapest outfit is 1 020 000 so'm over". There is no in-budget suggestion at all. The seed's cheapest full outfit is about 1.5 M, while the form's own placeholder budget is 1 500 000. | Budget is a headline feature. It shouldn't answer "nothing fits" for typical Uzbek budgets. | Seed prices across real tiers (economy/mid/premium). When nothing fits, also offer a **partial** outfit inside the budget (required items only, cheapest first) next to the over-budget one. |
| R4 | Seed | All stores have the same 25 generic items ("Hudi", "Polo"). There is no brand, description, material, SKU/barcode or colour variant. Stock is a deterministic 0–5 pattern with gaps. | Demo data is the sales demo. Thin, identical data makes the AI look dumb and hides bugs (R1). | At least 60 items per store, with gender/temperature/style/price coverage checked by a test, per-store variation, SKUs and images (task 15). |
| R5 | Results | The "Arzonroq variant" repeats the whole outfit to save 20 000 so'm. It is visually as big as the main outfit. | It adds noise and doubles the scroll for little value. | Show it as one compact "swap X for Y, save N" row with its own add button. |
| R6 | Results | The AI path (`source: ai`, titles, reasons) has never been seen live (no key). | Unknown latency and Uzbek copy quality. | Kept on the launch checklist (needs the user's key). Not a phase-2 code task. |

### Customer app UX

| ID | Screen | What's wrong | Why it matters | Fix |
|---|---|---|---|---|
| U2 | Phone, all | There is no history routing. The browser/Android **back button leaves the app** and loses everything except the cart, and a refresh starts over. | On a phone, back is the most-used control. | `history.pushState` per screen, a `popstate` handler, and the current screen restored from `sessionStorage` (no photo, no personal data). |
| U3 | Form | Validation shows one error at a time at the bottom. A fixed error stays: "Jinsingizni tanlang" stayed after choosing gender. | Customers don't know what to fix. A stale error looks like a bug. | Errors inline under each field (`aria-describedby`), validated on blur, and cleared as soon as the field is valid. |
| U4 | Kiosk form, checkout | Height, weight, budget, name and phone are free-text `type=number` inputs. A kiosk touch screen may have no OS keyboard. The number spinners are tiny at 1.5 m. | It can block the whole kiosk flow. | On the kiosk: a large on-screen numeric keypad or ±steppers with presets (height in 1 cm steps, budget chips). For checkout, a "Telefonda davom etish" QR that moves the cart to the customer's phone (task 17), so no name or phone is typed on a shared screen. |
| U5 | All | There is no step indicator (start → about you → photo → outfits → cart → done). | People abandon flows when they don't know how long they are. | A progress bar component (task 16). |
| U6 | Camera | It is text only: no pose illustration, no frame guide over the video, no example of a good photo. | Size accuracy depends on the pose. Text alone won't get a full-body, arms-out photo. | A silhouette guide over the preview and a small illustration of the pose. |
| U7 | Order done | The only status channel is Telegram (needs the bot). There is no order status page, and order numbers are global and sequential (№ 1, № 2…). | Customers who don't use the bot can't see their status. Sequential numbers reveal sales volume to competitors. | A public `/order/<token>` status page (random token, already have `notify_token`) with a timeline, and a per-store display number (task 17). |
| U8 | Cart | The hold is shown as an absolute time ("22:39 gacha") with no countdown. When it expires the cart just fails. | Customers don't track clock times. A silent expiry loses the sale. | A live countdown, a warning at 2 min, and "extend" (each change already extends the hold). |
| U9 | Phone 375 px | In the form, the "Vazn" hint wraps to 2 lines, so the weight input sits lower than the height input. In results, the item meta wraps to 3–4 lines next to the price. | It looks unfinished on the main device. | Hints under the input, not in the label. Item rows stack the price under the name below 400 px. |
| U10 | Wrong/missing store | `/m?store=99` and `/m` show an error and nothing else: a dead end, with the start button hidden. | People who mistype or use an old QR get stuck. | List the stores to choose from (public, names only). |
| U11 | Results, kiosk | The shoe size picker is a small native `<select>`. The "pick a size" error appears below the add button, out of view. | It is hard to tap on a kiosk, and the error is easy to miss. | Size chips, and scroll to and focus the missing picker. |
| U12 | Labels | The same category has different names: admin calls `top` "Ustki (top)" and `outerwear` "Ustki kiyim", while the app says "Ko'ylak / futbolka" and its size stepper says "Ustki" for the top size. | Staff and customers get confused. "Ustki" means outer. | One label set, kept in the i18n dictionary (task 14). |

### Admin as a SaaS back office (from code)

| ID | Area | What's wrong | Fix |
|---|---|---|---|
| A2 | Products | `GET /api/admin/products` returns every product with no paging, and there is no sort. Stock is shown as a text line "XS:3 S:0 …". There is no low-stock or no-photo filter and no bulk actions. | Server paging (`limit/offset`, total), sortable columns, filters (low stock, out of stock, no image), and a stock heat cell per size. |
| A3 | Orders | It shows only the newest 200, with no search by number or phone, no date range and no export. New orders appear by a 30 s poll with no sound or badge. | Paging, search, a date filter, CSV export, and an unseen-orders badge in the nav. |
| A4 | Stats | There are no charts, no revenue over time, no funnel visual, no comparison between periods and no export. | Charts (line for revenue/recommendations, funnel bars), deltas against the previous period, and CSV export (task 18). |
| A5 | Settings | Stores, admins and delivery fees exist only as CLI commands (`store:create`, `admin:create`). There is no password change, no "forgot password", and no way to edit a store's address, coordinates or delivery fee. | A settings area: store profile (address, map pin, hours, delivery fee/threshold), team (invite or create managers, role, disable), and my account (password change) (task 19). |
| A6 | Audit | Nobody can see who changed a price or stock or cancelled an order. | An `audit_log` table (admin, action, entity, before/after JSON, time) written by every admin mutation, with a viewer (task 19). |
| A7 | Kassa | Lookup is by the global order number in a dialog. There is no receipt and no list of "orders waiting for payment". | A cashier page: a list of pending orders with a countdown, search, and a printable receipt (task 18). |

### i18n

| ID | What's wrong | Fix |
|---|---|---|
| I1 | Every string is hard-coded Uzbek Latin in `index.html`, `app.js`, admin, and in server error messages (`'Server xatosi'`, validation texts). There is no Russian, which a large share of Tashkent and Samarkand shoppers and many store staff prefer. | A small dictionary module (`uz`, `ru`; Uzbek Cyrillic optional later). A language switch on the start screen and in admin. The server returns stable error `code`s with the message chosen by `Accept-Language`/`lang`. A test checks that every key exists in every language (task 14). |
| I2 | Number, date and time formatting uses `ru-RU`/browser time zone ad hoc (`hhmm`). | One `fmt` helper: `Intl` with `Asia/Tashkent`, so'm grouping, and plural rules. |
| I3 | Product names, colours and the AI's titles/reasons are single-language. | Optional `name_ru` column (CSV column too). The stylist prompt gets the customer's language (the spec prompt stays Uzbek by default). |

### Security, performance and reliability

| ID | What's wrong | Why it matters | Fix |
|---|---|---|---|
| X1 | There are no security headers: no CSP, `frame-ancestors`, `Referrer-Policy` or `Permissions-Policy`. The admin token lives in `localStorage`. | Any XSS means admin takeover, and the kiosk/admin pages can be framed. | Set the headers in `app.js` (no dependency), with a CSP allowing only the self-hosted assets and OSM tiles, and `Permissions-Policy: camera=(self)` (task 21). |
| X2 | There is no per-IP rate limit on public `/api/recommend`, `/api/size` or `/api/cart/items` (noted as shortcuts in tasks 4, 8 and 11). | One script can open carts that hold all stock for 15 min each (an inventory denial of service), and fill `recommendation_logs`. | A small in-memory token bucket per IP and route, plus max open carts per IP (task 21). |
| X3 | Runtime third-party CDNs: MediaPipe (jsDelivr + Google Storage), Leaflet (cdnjs), OSM tiles. | An offline or filtered kiosk loses photo mode and the map. A CDN change can break the kiosk. | Self-host the MediaPipe wasm and model and Leaflet under `/vendor` with SRI-free same-origin loading. OSM tiles stay online-only, with the existing fallback (task 21). |
| X4 | Static files are served with `max-age=0` and no compression. | Slow first load on mobile data. | `immutable` cache for versioned `/vendor` and assets, `etag` for HTML. Compression is left to Caddy (already in front). |
| X5 | Stock is updated only by hand or CSV. There is no POS sync and no low-stock signal. | SPEC's own risk list: an item that exists in the DB but not on the shelf gets sold. | Low-stock alerts plus a token-protected stock sync API (task 20). |
| X6 | The login lockout, the AI cap and the Telegram outbox are per process (documented). | It's fine for one container. | Keep, and note it in the README (already there). No task. |

## S3 — polish

- **U13 Results:** `aria-live="polite"` wraps the whole results list, so screen readers read every item after each −/+ change. Announce a one-line summary instead.
- **U14 Start screen:** the weather has no icon, and "Bugun ustki kiyim ham tavsiya qilamiz" is the only hint. A weather icon and a one-line outfit hint ("Yomg'ir: suv o'tkazmaydigan kiyim") make it feel alive.
- **U15 Buttons:** "Boshiga" sits next to "Savat: 4" with the same weight, so a kiosk user can wipe their session by mistake. Use an icon button, and ask for confirmation when the cart is not empty.
- **U16 Loading:** "Ob-havo yuklanmoqda…" is plain text, and the results request has no skeleton. Use skeleton cards when a load takes over 300 ms.
- **D3 Focus:** focus rings exist (`:focus-visible`). Keep them in the new design system, and check contrast for the accent on soft backgrounds (AA).

## What is already good (keep it)

- The server owns every price and total, holds use conditional UPDATEs, and the concurrency, payment and privacy tests are strong.
- The photo never leaves memory except the one stylist JPEG, which is not stored.
- Semantic HTML: wrapped labels, fieldset/legend, `role=alert` errors, visible focus.
- No horizontal scroll at 375 px. The response time of `/api/recommend` is about 0.4 s with live weather.

## New features — what a retail SaaS of this kind needs

Each idea was judged by whether it helps the **pilot** (one real store, two weeks) or **selling to the next stores**.

| Feature | Verdict | Why |
|---|---|---|
| Landing page with a live demo and a "request a demo" form | **Keep** (task 22) | `/` is a 404 today. Prospects need a URL to see what it is. It is cheap. |
| Organisations (brand → stores) with invite-based onboarding | **Keep, without billing** (task 22) | Selling to a second chain needs tenant isolation above stores. Invite links avoid email verification infrastructure. |
| Subscription plans and billing | **Defer** | Needs a merchant agreement and legal terms from the user, and no pilot customer pays through the app yet. Record plan limits as data later. |
| Store settings, team and audit log UI | **Keep** (task 19) | Today everything is CLI. A store can't run itself, and owners ask "who changed this price". |
| Dashboard and analytics (sales, funnel, top items, hours) | **Keep** (task 18) | This proves ROI to the store owner. It is the sales pitch for renewal. |
| Low-stock alerts and a stock sync API (SKU upsert) | **Keep** (task 20) | It closes the SPEC risk "sold but not on the shelf". A generic API lets any POS (1C, MoySklad) push stock. The concrete 1C connector waits for a real store's system. |
| Kiosk PWA: fullscreen, wake lock, offline shell, attract loop, heartbeat | **Keep** (task 21) | A kiosk that shows browser chrome, sleeps, or dies offline looks amateur. A heartbeat tells the owner the kiosk is down. |
| Order status page and kiosk → phone handoff | **Keep** (task 17) | It gives status without Telegram, and keeps the customer's name and phone off the shared screen. |
| Russian language | **Keep** (task 14) | Needed for a large share of urban customers and staff. |
| Fitting-room request ("bring size L to cabin 2" → staff Telegram/admin) | **Keep, small** (in task 17) | It is unique to in-store kiosks, turns "tried on" into a real signal for the pilot report, and needs no new provider. |
| Customer accounts and order history | **Defer** | Phone login needs an SMS/OTP provider (paid, user's account). Walk-in pilot customers don't need it, and the status page covers the order. |
| Promotions and promo codes | **Defer** | `discount_price` already covers sales. Promo codes add checkout and abuse surface with no pilot need. Revisit after the pilot. |
| Loyalty and CRM export | **Defer** | No customer identity yet (see accounts). |

## Out of scope for code (needs the user)

These are tracked in the README launch checklist and are not phase-2 tasks:
- live Claude key check
- Click/Payme sandbox and live keys
- Telegram bot
- a real domain and HTTPS
- real iPhone and Android camera checks
- the 20-person size accuracy check
- the real printer
- the POS vendor for a concrete stock connector
