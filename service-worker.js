const CACHE = 'boltiv-shell-v54';
const SHELL = [
  '/', '/index.html', '/login.html', '/register.html', '/dashboard.html',
  '/wallet.html', '/airtime.html', '/data.html', '/cable.html', '/electricity.html',
  '/history.html', '/transactions.html', '/profile.html', '/security.html',
  '/contact.html', '/manifest.webmanifest', '/style.css', '/boltiv-ui.js',
  '/boltiv-client.js', '/boltiv-lock.js', '/boltiv-install.js', '/assets/boltiv-icon.png', '/assets/boltiv-icon.webp'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(req).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
    return response;
  }).catch(() => caches.match(req).then(cached => cached || caches.match('/index.html'))));
});
