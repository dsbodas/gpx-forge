/**
 * Service worker: makes the app shell available offline so the installed PWA
 * opens instantly and keeps working without a connection.
 *
 * Routing and elevation obviously still need the network — but an offline
 * launch can import a GPX file, re-analyse it and export a new one, which is
 * genuinely useful on a train.
 */

const VERSION = 'gpx-forge-v1';
const SHELL = [
  '.',
  'index.html',
  'css/style.css',
  'manifest.webmanifest',
  'vendor/leaflet.js',
  'vendor/leaflet.css',
  'vendor/images/marker-icon.png',
  'vendor/images/marker-icon-2x.png',
  'vendor/images/marker-shadow.png',
  'vendor/images/layers.png',
  'vendor/images/layers-2x.png',
  'js/app.js',
  'js/analysis.js',
  'js/elevation.js',
  'js/gpx.js',
  'js/map.js',
  'js/net.js',
  'js/parsers.js',
  'js/profile.js',
  'js/routing.js',
  'js/surface.js',
  'js/timemodel.js',
  'js/util.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      // addAll is all-or-nothing; a single 404 would leave us with no cache at
      // all, so each entry is added independently.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept API calls or anything cross-origin (map tiles, routing).
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network first so a deployed update is picked up promptly,
  // falling back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.match('index.html').then((r) => r || caches.match('.')))
    );
    return;
  }

  // Code and styles: network first, cache as fallback.
  //
  // Cache-first would be faster, but it serves the *previous* build until a
  // second reload — which silently hides every update from the user and makes
  // the app maddening to develop against. Offline still works via the cache.
  const isCode = /\.(?:js|css|webmanifest)$/.test(url.pathname);

  if (isCode) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Immutable assets (icons, Leaflet images): cache first is safe.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy));
        }
        return res;
      });
    })
  );
});
