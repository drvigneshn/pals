/* PALS Companion service worker — offline cache.
   Bump CACHE on every release: that is what pushes the update to installed users. */
const CACHE = 'pals-v0.4.0';
const ASSETS = ['./', 'index.html', 'privacy.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'about.html', 'lib/mqtt.min.js', 'lib/qrcode.js', 'js/core.js', 'js/scenarios.js', 'js/corecases.js', 'js/monitor.js', 'js/controller.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
/* Same-origin GETs: serve from cache, refresh in the background. Everything else (relays) goes to the network. */
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
