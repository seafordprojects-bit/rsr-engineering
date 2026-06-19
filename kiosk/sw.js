/* RSR Kiosk service worker — offline cache + auto-update.
   Bump CACHE_VERSION on every kiosk update so tablets fetch fresh files. */
const CACHE_VERSION = 'rsr-kiosk-v6';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './supabase.js',
  './icon-192.png',
  './icon-512.png'
];

// Install: pre-cache the app shell, then become the waiting worker.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
});

// Activate: delete old caches so we don't serve stale versions.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Let the page tell us to activate immediately (the "Update now" button).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET requests for our own origin's static files.
  // NEVER cache or intercept Supabase / API / cross-origin calls — those
  // must always hit the live network; the kiosk's own offline queue
  // handles them when offline.
  if (req.method !== 'GET') return;                 // skip POST/PATCH (Supabase writes)
  if (url.origin !== self.location.origin) return;  // skip Supabase, CDNs, etc.
  if (url.pathname.includes('/rest/') ||
      url.pathname.includes('/auth/') ||
      url.pathname.includes('/realtime/')) return;  // safety: skip any API-ish path

  // Network-first for the page itself (so updates show up when online),
  // falling back to cache when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        // refresh the cached copy on every successful online fetch
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
