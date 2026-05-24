const CACHE = 'memotalk-v4';
const ASSETS = [
  './index.html', './style.css', './app.js',
  './manifest.json', './manifest-sakura.json',
  './firebase-config.js',
  './icon-192-asa.png', './icon-512-asa.png',
  './icon-192-sakura.png', './icon-512-sakura.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.allSettled(ASSETS.map(a => c.add(a)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
