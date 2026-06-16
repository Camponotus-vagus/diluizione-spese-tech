const CACHE_NAME = 'spese-tech-v4';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  // No skipWaiting(): the new worker waits until the page asks to update,
  // so we can prompt the user instead of swapping versions silently.
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  // No clients.claim(): avoids reloading the page on first install; on updates
  // the page already has a controller and skipWaiting() transfers control to it.
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Network-only (cache fallback) for GitHub API calls
  if (url.hostname === 'api.github.com') {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Network-first for navigations / HTML (always get the latest version)
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(req).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      }).catch(() => caches.match(req).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  // Cache-first only for trusted origins: same-origin assets + Google Fonts.
  // Other origins are left to the browser (no opaque cross-origin cache poisoning).
  if (url.origin === self.location.origin || FONT_ORIGINS.includes(url.origin)) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(response => {
        if (response && (response.ok || response.type === 'opaque')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      }))
    );
  }
});
