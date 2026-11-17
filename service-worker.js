const CACHE = 'boltiv-shell-v70';
const SHELL = [
  '/', '/index.html', '/login.html', '/register.html', '/dashboard.html',
  '/wallet.html', '/airtime.html', '/data.html', '/cable.html', '/electricity.html',
  '/history.html', '/transactions.html', '/profile.html', '/agent-home.html', '/agent-sell.html', '/agent-wallet.html', '/agent-activity.html', '/agent-earnings.html', '/agent-profile.html', '/security.html',
  '/contact.html', '/business.html', '/business.js', '/business-finance.js', '/business-ops.js', '/manifest.webmanifest', '/style.css', '/boltiv-theme.css', '/boltiv-theme.js', '/boltiv-ui.js',
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
  // Business Manager handles money and stock, so always prefer the freshest code when online
  // (an old cached script could disagree with the server). The saved copy is only the offline fallback.
  if (/^\/business(-finance|-ops)?(\.js|\.html)?$/.test(url.pathname)) {
    event.respondWith(fetch(req).then(response => {
      if (response && response.ok && response.type === 'basic') { const copy = response.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return response;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('/business.html') || caches.match('/index.html'))));
    return;
  }
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
