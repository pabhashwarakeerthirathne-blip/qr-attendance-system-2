/**
 * UniAttend Service Worker
 * Provides fast application shell caching and offline UI readiness.
 */

const CACHE_NAME = 'uniattend-shell-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/css/responsive.css',
  '/css/scanner.css',
  '/js/utils.js',
  '/js/supabase.js',
  '/js/auth.js',
  '/js/students.js',
  '/js/attendance.js',
  '/js/scanner.js',
  '/js/dashboard.js',
  '/js/reports.js',
  '/js/app.js',
  '/assets/icons/icon-192.svg',
  '/assets/icons/icon-512.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept non-GET requests or Supabase REST/Realtime/Auth calls
  if (
    request.method !== 'GET' ||
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('supabase.in')
  ) {
    return;
  }

  // Network-first for HTML navigation, stale-while-revalidate for static assets
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && url.origin === self.location.origin) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
