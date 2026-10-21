/*
 * LWC Platform — service worker (PWA shell + offline fallback).
 *
 * Rules (deliberately conservative — this app carries live customer data):
 *   • only same-origin GET requests are intercepted;
 *   • /api/*  → NEVER cached (network only, no stale conversations/menu);
 *   • /webhook → NEVER intercepted (Meta callback must always reach the API);
 *   • navigations → network first, cached page as fallback, offline page last;
 *   • static assets (/_next/static, /icons, css/js/fonts) → cache first.
 *
 * Bump VERSION on every release to purge old caches.
 */
const VERSION = 'lwc-pwa-v1';
const STATIC_CACHE = `${VERSION}-static`;
const PAGES_CACHE = `${VERSION}-pages`;
const OFFLINE_URL = '/offline.html';

const PRECACHE = [
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png'
];

/** @returns {boolean} true for assets that are safe to serve from cache. */
function isStaticAsset(pathname) {
  if (pathname.startsWith('/_next/static/')) return true;
  if (pathname.startsWith('/icons/')) return true;
  return /\.(?:png|svg|ico|webp|jpg|jpeg|gif|css|js|map|woff|woff2|ttf)$/i.test(pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // Individually, so one missing file cannot break the whole install.
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch (err) {
            /* offline during install — the runtime cache will pick it up later */
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/webhook')) return;
  if (url.pathname.startsWith('/health')) return;

  const accept = request.headers.get('accept') || '';

  // ---- navigations (HTML documents) → network first ----
  if (request.mode === 'navigate' || accept.includes('text/html')) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response && response.ok) {
            const cache = await caches.open(PAGES_CACHE);
            cache.put(request, response.clone()).catch(() => undefined);
          }
          return response;
        } catch (err) {
          const cached = await caches.match(request);
          if (cached) return cached;
          const offline = await caches.match(OFFLINE_URL);
          if (offline) return offline;
          return new Response('<h1>Offline</h1>', {
            status: 503,
            headers: { 'content-type': 'text/html; charset=utf-8' }
          });
        }
      })()
    );
    return;
  }

  // ---- static assets → cache first ----
  if (isStaticAsset(url.pathname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        const network = fetch(request)
          .then(async (response) => {
            if (response && response.ok) {
              const cache = await caches.open(STATIC_CACHE);
              cache.put(request, response.clone()).catch(() => undefined);
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })()
    );
  }
});
