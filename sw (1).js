const CACHE = 'glemmekassen-v4';
const ASSETS = [
  '/Glemmekassen/',
  '/Glemmekassen/index.html',
  '/Glemmekassen/hittegods.html',
  '/Glemmekassen/bilde.html',
  '/Glemmekassen/manifest.json',
  '/Glemmekassen/icon-192.png',
  '/Glemmekassen/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Aldri cache API-kall
  if (url.includes('supabase') ||
      url.includes('anthropic') ||
      url.includes('tinyurl') ||
      url.includes('twilio') ||
      url.includes('nominatim')) {
    return;
  }

  // For app-sider: prøv nett først, fall tilbake på cache
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
