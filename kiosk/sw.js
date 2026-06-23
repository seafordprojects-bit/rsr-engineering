// ============================================================
//  sw.js — RSR Kiosk service worker
//  Network-first for the page (so new deploys appear automatically),
//  cache fallback for offline. Cross-origin calls (Supabase, AWS,
//  Telegram, CDNs) are NOT intercepted — they pass straight through.
// ============================================================
const CACHE = 'rsr-kiosk-runtime-v1';

self.addEventListener('install', () => {
  // take over right away instead of waiting for old tabs to close
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Let cross-origin requests (Supabase, AWS, Telegram, CDN libs) pass through untouched.
  if (url.origin !== self.location.origin) return;

  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // NETWORK-FIRST: always try to get the freshest page; fall back to cache offline.
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        const cached = await caches.match(req);
        return cached || (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Other same-origin assets: stale-while-revalidate (fast, but refreshes in background).
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.status === 200) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
