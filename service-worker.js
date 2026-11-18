const CACHE = 'boltiv-shell-v71';
const SHELL = [
  '/', '/index.html', '/login.html', '/register.html', '/dashboard.html',
  '/wallet.html', '/airtime.html', '/data.html', '/cable.html', '/electricity.html',
  '/history.html', '/transactions.html', '/profile.html', '/agent-home.html', '/agent-sell.html', '/agent-wallet.html', '/agent-activity.html', '/agent-earnings.html', '/agent-profile.html', '/security.html',
  '/contact.html', '/business.html', '/business.js', '/business-finance.js', '/business-ops.js', '/business-docs.js', '/manifest.webmanifest', '/style.css', '/boltiv-theme.css', '/boltiv-theme.js', '/boltiv-ui.js',
  '/boltiv-client.js', '/boltiv-lock.js', '/boltiv-install.js', '/assets/boltiv-icon.png', '/assets/boltiv-icon.webp'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
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
  // Business Manager handles money and stock, so always prefer the freshest code when online
  // (an old cached script could disagree with the server). The saved copy is only the offline fallback.
  if (/^\/business(-finance|-ops|-docs)?(\.js|\.html)?$/.test(url.pathname)) {
    event.respondWith(fetch(req).then(response => {
      if (response && response.ok && response.type === 'basic') { const copy = response.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return response;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('/business.html') || caches.match('/index.html'))));
    return;
  }
  // Pages (HTML) are always fetched fresh first, so a new deploy shows up on the very next visit
  // (this is what stopped the Business Manager card from appearing until site data was cleared).
  // The saved copy is only used when the network is slow or offline.
  const isPage = req.mode === 'navigate' || req.destination === 'document';
  if (isPage) {
    event.respondWith(new Promise(resolve => {
      let settled = false;
      const fallback = () => caches.match(req).then(hit => hit || caches.match('/index.html'));
      const timer = setTimeout(() => { fallback().then(hit => { if (hit && !settled) { settled = true; resolve(hit); } }); }, 4000);
      fetch(req, { cache: 'no-cache' }).then(response => {
        clearTimeout(timer);
        if (response && response.ok && response.type === 'basic') { const copy = response.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
        if (!settled) { settled = true; resolve(response); }
      }).catch(() => { clearTimeout(timer); if (!settled) { settled = true; fallback().then(resolve); } });
    }));
    return;
  }
  // Scripts, styles and images: show the saved copy instantly and refresh it in the background.
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
