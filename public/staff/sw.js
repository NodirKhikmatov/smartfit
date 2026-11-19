// Staff app service worker (task 28), scope /staff/. Makes the app installable and opens its shell without a network
// (network first, so updates arrive at once). Never API responses or anything else: the queue is always live.
const CACHE = 'sf-staff-v3'; // v3: task 49 kirim narxi (v2: task 47 receiving and counts)
const SHELL = [
  '/staff/', '/staff/staff.js', '/staff/staff.css', '/staff/manifest.webmanifest',
  '/shared/ui.css', '/shared/ui.js', '/shared/i18n.js', '/shared/icons.svg', '/shared/favicon.svg', '/favicon.ico',
  '/shared/fonts/onest-latin-wght-normal.woff2', '/shared/fonts/onest-latin-ext-wght-normal.woff2',
  '/shared/fonts/onest-cyrillic-wght-normal.woff2', '/shared/fonts/onest-cyrillic-ext-wght-normal.woff2',
  '/shared/fonts/cormorant-latin-wght-normal.woff2', '/shared/fonts/cormorant-latin-ext-wght-normal.woff2',
  '/shared/fonts/cormorant-cyrillic-wght-normal.woff2', '/shared/fonts/cormorant-cyrillic-ext-wght-normal.woff2',
];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys()
  .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const key = req.mode === 'navigate' ? '/staff/' : url.pathname;
  if (SHELL.includes(key)) e.respondWith(networkFirst(req, key));
});

async function networkFirst(req, key) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}
