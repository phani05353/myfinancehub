// Bumped on each release so stale clients pick up new assets.
const CACHE = 'finance-hub-v18';

const SHELL = [
  '/',
  '/css/style.css',
  '/js/app.js',
  '/js/transactions.js',
  '/js/budget.js',
  '/js/savings.js',
  '/js/subscriptions.js',
  '/js/reminders.js',
  '/js/charts.js',
  '/js/ask.js',
  '/js/import.js',
  '/js/yearreview.js',
  '/js/rules.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Install: pre-cache the shell, but never let a single failed fetch tank the whole SW.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(url => c.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

// Activate: drop any previous-version caches and take control immediately.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
//   - API / auth routes → bypass SW entirely (always live network)
//   - Everything else   → NETWORK-FIRST, cache only as offline fallback.
//
// Network-first means deploys are picked up on the very next request, no
// stale assets after a redeploy. The cache exists purely so the app shell
// still works when the homelab is unreachable.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // Always network for live data
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  e.respondWith((async () => {
    try {
      const fresh = await fetch(e.request);
      if (fresh && fresh.ok) {
        // Update the cache in the background for offline use
        const clone = fresh.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
      }
      return fresh;
    } catch (_) {
      // Network unavailable — fall back to whatever's in cache
      const cached = await caches.match(e.request);
      if (cached) return cached;
      // Last-ditch: serve the shell root so the SPA can boot
      const shell = await caches.match('/');
      if (shell) return shell;
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
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
