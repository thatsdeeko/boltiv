const CACHE = 'boltiv-shell-v64';
const SHELL = [
  '/', '/index.html', '/login.html', '/register.html', '/dashboard.html',
  '/wallet.html', '/airtime.html', '/data.html', '/cable.html', '/electricity.html',
  '/history.html', '/transactions.html', '/profile.html', '/agent-home.html', '/agent-sell.html', '/agent-wallet.html', '/agent-activity.html', '/agent-earnings.html', '/agent-profile.html', '/security.html',
  '/contact.html', '/manifest.webmanifest', '/style.css', '/boltiv-theme.css', '/boltiv-theme.js', '/boltiv-ui.js',
  '/boltiv-client.js', '/boltiv-lock.js', '/boltiv-install.js', '/assets/boltiv-icon.png', '/assets/boltiv-icon.webp'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Stale-while-revalidate: show the saved copy instantly, refresh it in the background
// so the next visit gets the latest version. Falls back to the network on first visit.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(caches.open(CACHE).then(cache => cache.match(req).then(cached => {
    const network = fetch(req).then(response => {
      if (response && response.ok && response.type === 'basic') cache.put(req, response.clone()).catch(() => {});
      return response;
    });
    if (cached) {
      network.catch(() => {});
      return cached;
    }
    return network.catch(() => cache.match('/index.html'));
  })));
});
