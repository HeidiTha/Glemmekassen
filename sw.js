const CACHE = 'glemmekassen-v3';
const ASSETS = ['/Glemmekassen/', '/Glemmekassen/hittegods.html'];

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
  // Ikke cache API-kall
  if (e.request.url.includes('supabase') || 
      e.request.url.includes('anthropic') ||
      e.request.url.includes('sveve') ||
      e.request.url.includes('countapi')) {
    return;
  }
  // Alltid hent fersk versjon fra nett, fall tilbake på cache
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
