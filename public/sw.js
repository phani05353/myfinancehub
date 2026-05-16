const CACHE = 'finance-hub-v4';

const SHELL = [
  '/',
  '/css/style.css',
  '/js/app.js',
  '/js/transactions.js',
  '/js/budget.js',
  '/js/subscriptions.js',
  '/js/reminders.js',
  '/js/charts.js',
  '/js/import.js',
  '/js/yearreview.js',
  '/js/rules.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Install: cache the app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// Activate: remove old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
//   - API / auth routes → network only (never serve stale financial data)
//   - Static assets    → cache first, fall back to network
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Skip non-GET and cross-origin
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network-only for API and auth
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  // Cache-first for everything else
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        if (res.ok) {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      });
      return cached || networkFetch;
    })
  );
});

// ── Web Push: incoming notification ─────────────────────────────────────────
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { title: 'Home Finance', body: e.data?.text() || '' }; }
  const title = data.title || 'Home Finance';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'default',
    renotify: !!data.tag,
    data: data.data || {}
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Notification click — focus existing window or open one at the deep-link route
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const route = e.notification.data?.route || '#/dashboard';
  const target = new URL(route.startsWith('#') ? '/' + route : route, self.location.origin).href;

  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.location.origin)) {
        c.focus();
        c.navigate(target).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
