const CACHE_NAME = 'anymex-desk-v3';


const STATIC_PRECACHE = [
  '/offline',
  '/favicon.gif',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only intercept GET requests
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Bypass service worker entirely for auth and API routes
  if (
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/upload')
  ) {
    return;
  }

  // Navigation requests: Network-first, fallback to /offline page
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => {
        return caches.match('/offline').then((fallback) => {
          return (
            fallback ||
            new Response('You are offline. Please check your connection.', {
              headers: { 'Content-Type': 'text/plain' },
              status: 503,
            })
          );
        });
      })
    );
    return;
  }

  // Static assets (fonts, icons, CSS, client bundles)
  const isStaticAsset =
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/_astro/') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.gif') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js');

  if (isStaticAsset) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) {
          // Revalidate in background
          fetch(request)
            .then((fresh) => {
              if (fresh && fresh.status === 200) {
                const copy = fresh.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
              }
            })
            .catch(() => {});
          return cached;
        }

        return fetch(request).then((response) => {
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        });
      })
    );
  }
});

// ─────────────────────────────────────────────────────────────
// Native Web Push Notification Handlers
// ─────────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload = {};
  try {
    payload = event.data.json();
  } catch (err) {
    payload = { title: 'AnymeX Desk', body: event.data.text() };
  }

  const title = payload.title || 'AnymeX Desk';
  const options = {
    body: payload.body || 'You have a new update.',
    icon: payload.icon || '/icons/icon-192.png',
    badge: payload.badge || '/icons/icon-maskable-192.png',
    data: {
      url: payload.url || '/',
      ...(payload.data || {}),
    },
    tag: payload.tag || undefined,
    renotify: !!payload.tag,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus existing window if open and navigate to target URL
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          if (client.url !== targetUrl && 'navigate' in client) {
            client.navigate(targetUrl);
          }
          return client.focus();
        }
      }
      // Otherwise open new window
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
