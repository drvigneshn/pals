/* PALS Companion service worker — offline cache.
   Bump CACHE on every release. Same-origin files are fetched from the network first (so phone and
   monitor always run the same, latest version) and fall back to the cache when offline. */
const CACHE = 'pals-v0.5.1';
const ASSETS = ['./', 'index.html', 'privacy.html', 'about.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'lib/mqtt.min.js', 'lib/qrcode.js', 'js/core.js', 'js/scenarios.js', 'js/corecases.js', 'js/monitor.js', 'js/controller.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(e.request, { cache: 'no-cache', signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch {
      return (await c.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
