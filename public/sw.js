// Service worker: makes the game installable and lets the shell open instantly.
// The universe itself is never cached - every /api call goes to the server.
const CACHE = 'tnf-shell-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'gesture.js', 'config.js', 'manifest.webmanifest',
  'fonts/instrument-serif-latin-400-normal.woff2', 'fonts/instrument-serif-latin-400-italic.woff2', 'fonts/familjen-grotesk-latin-wght-normal.woff2',
  'icons/icon-192.png'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return; // live data: straight to the network
  // Shell files: try the network first so updates arrive, fall back to the cache when offline.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html'))));
});
