const CACHE_PREFIX = 'spese-tech-';
const CACHE_NAME = CACHE_PREFIX + 'v8';
const STATIC_ASSETS = [
  './',
  './index.html',
  './theme.js',
  './app.js',
  './app.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const NETWORK_TIMEOUT = 4000;
const FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(
    // cache: 'reload' bypasses the HTTP cache so the precache holds the deployed
    // files, not whatever the browser cached up to max-age ago
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS.map(a => new Request(a, { cache: 'reload' }))))
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

  // Network-first for navigations and the app shell (HTML/JS/CSS). The page and
  // its scripts/styles are separate files, so each one is revalidated with the
  // server (cache: 'no-cache' skips the HTTP cache, which GitHub Pages fills for
  // max-age=600) and they all come from the same deploy; the service worker
  // cache is only the offline fallback
  const isNavigate = req.mode === 'navigate';
  const isAppShell = url.origin === self.location.origin && /(\/|\.html|\.js|\.css)$/.test(url.pathname);
  if (isNavigate || isAppShell) {
    const network = fetch(req, { cache: 'no-cache' }).then(response => {
      // Store under a query-less key so ?x=N links don't grow the cache unbounded
      if (response.ok && url.origin === self.location.origin) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(url.origin + url.pathname, clone));
      }
      return response;
    });
    const fromCache = () => caches.match(req, { ignoreSearch: true });
    event.respondWith(new Promise(resolve => {
      let done = false;
      const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
      // Poor connection: after NETWORK_TIMEOUT serve the cached copy if there is
      // one, otherwise keep waiting for the network
      const timer = setTimeout(() => fromCache().then(c => { if (c) finish(c); }), NETWORK_TIMEOUT);
      network.then(finish).catch(() => fromCache().then(c =>
        // Offline and not cached: a navigation falls back to the app page, an
        // asset gets a proper network error (not an undefined Response)
        finish(c || (isNavigate ? caches.match('./index.html') : Response.error()))));
    }));
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
