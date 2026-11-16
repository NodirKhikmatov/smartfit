// Kiosk service worker (task 21), served as /kiosk-sw.js with scope /kiosk.
// Caches the app shell (network first, so updates arrive at once) and /vendor files (cache first; their paths are versioned).
// Never API responses, product photos (/uploads) or anything else: those always go to the network.
const CACHE = 'sf-kiosk-v3';
const SHELL = [
  "/kiosk", "/app/app.js", "/app/flow.js", "/app/mall.js", "/app/offers.js", "/app/idle.js", "/app/keypad.js", "/app/kiosk.js", "/app/pose.js", "/app/tryon.js", "/app/app.css",
  "/shared/ui.css", "/shared/ui.js", "/shared/i18n.js", "/shared/icons.svg", "/shared/favicon.svg", "/favicon.ico",
  "/shared/fonts/onest-latin-wght-normal.woff2", "/shared/fonts/onest-latin-ext-wght-normal.woff2",
  "/shared/fonts/onest-cyrillic-wght-normal.woff2", "/shared/fonts/onest-cyrillic-ext-wght-normal.woff2",
  "/shared/fonts/cormorant-latin-wght-normal.woff2", "/shared/fonts/cormorant-latin-ext-wght-normal.woff2",
  "/shared/fonts/cormorant-cyrillic-wght-normal.woff2", "/shared/fonts/cormorant-cyrillic-ext-wght-normal.woff2"
];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys()
  .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/vendor/')) return e.respondWith(cacheFirst(req));
  if (req.mode === 'navigate' ? url.pathname === '/kiosk' : SHELL.includes(url.pathname)) e.respondWith(networkFirst(req, url.pathname));
});

async function networkFirst(req, key) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(key, res.clone()); // keyed without the query, so /kiosk?store=2 finds the cached /kiosk
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}
