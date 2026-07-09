// KOBOrush service worker
// Strategy: cache the app shell (index.html + icons) for fast/offline
// loading, but ALWAYS go to the network for everything else — Firebase,
// ClubKonnect/Paystack APIs, fonts, etc. This avoids ever serving stale
// data for balances, transactions, or live API responses.

const CACHE_NAME = 'koborush-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests for our own origin's app-shell files.
  // Everything else (Firestore, Auth, ClubKonnect API, Paystack, fonts,
  // CDN scripts, recaptcha, CORS proxies) goes straight to the network,
  // untouched — never cached, never served stale.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline fallback to cached shell

      // Cache-first for instant loads, but always refresh cache in background
      return cached || networkFetch;
    })
  );
});
