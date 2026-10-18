const CACHE_PREFIX = 'spese-tech-';
const CACHE_NAME = CACHE_PREFIX + 'v6';
const STATIC_ASSETS = [
  './',
  './index.html',
  './app.js',
  './app.css',
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
      Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map(k => caches.delete(k)))
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

  // Network-only for GitHub API calls (never cached: they carry the auth token)
  if (url.hostname === 'api.github.com') {
    event.respondWith(fetch(req));
    return;
  }

  // Network-first for navigations and the app shell (HTML/JS/CSS), so the page
  // and its script are always the same version; the cache is the offline fallback
  const isNavigate = req.mode === 'navigate';
  const isAppShell = url.origin === self.location.origin && /(\/|\.html|\.js|\.css)$/.test(url.pathname);
  if (isNavigate || isAppShell) {
    event.respondWith(
      fetch(req).then(response => {
        // Store under a query-less key so ?x=N links don't grow the cache unbounded
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(url.origin + url.pathname, clone));
        }
        return response;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then(c => c || (isNavigate ? caches.match('./index.html') : c)))
    );
    return;
  }

  // Cache-first only for trusted origins: same-origin assets + Google Fonts.
  // Other origins are left to the browser (no opaque cross-origin cache poisoning).
  if (url.origin === self.location.origin || FONT_ORIGINS.includes(url.origin)) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(response => {
        // Opaque responses hide their status: don't pin a possible error forever
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      }))
    );
  }
});
