/* ============================================================
   CLICKFUD — service worker

   Two jobs:
   1. Web Push — receive push events, show a real OS notification, and
      focus/open the app when one is tapped (unchanged, see below).
   2. Offline app shell — cache the files needed to OPEN the customer
      app with no connection, plus images the customer has actually
      viewed. Structured data (shops, menus, prices) is NOT cached here;
      that lives in IndexedDB (js/offline-cache.js), written by the app.

   Never cached here: any Supabase API call (REST, auth, realtime, Edge
   Functions — orders, payments, profiles all stay live-only), any
   non-GET request, signed/private storage URLs, or video.

   Strategies:
   - Page loads (navigations): network-first, falls back to the cached
     app shell when offline.
   - Versioned JS/CSS (?v=…): cache-first — a new deploy changes the
     ?v= value, which is a different URL, so it's fetched fresh.
   - Other same-origin files + CDN libraries: stale-while-revalidate.
   - Images: cache-first, only once actually displayed, capped at
     MAX_IMAGES entries (oldest dropped first).

   Updating: bump CACHE_VERSION on a significant release; activate
   deletes every clickfud-* cache that isn't current.
   ============================================================ */
const CACHE_VERSION = 'clickfud-v2';
const SHELL_CACHE = CACHE_VERSION + '-shell';
const RUNTIME_CACHE = CACHE_VERSION + '-runtime';
const IMAGE_CACHE = 'clickfud-images-v2'; // separate so an app update doesn't throw away viewed images
const KEEP_CACHES = [SHELL_CACHE, RUNTIME_CACHE, IMAGE_CACHE];
const MAX_IMAGES = 150;
const MAX_RUNTIME = 120;
const NAV_TIMEOUT_MS = 5000;

const SUPABASE_ORIGIN = 'https://ctxnwjjpqxecidzblyok.supabase.co';
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const SHELL_URLS = ['/', '/index.html', '/manifest.json', '/icons/clickfud-logo-full-512.png', '/icons/clickfud-icon-192.png'];

// Precache the shell plus every script/stylesheet index.html references
// (read from index.html itself, so this list can never drift from it).
async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(SHELL_URLS.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
  try {
    const res = await fetch('/index.html', { cache: 'reload' });
    const html = await res.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)(?:\?[^"]*)?)"/g)].map((m) => m[1]);
    const runtime = await caches.open(RUNTIME_CACHE);
    await Promise.all(assets.map((a) => {
      const url = new URL(a, self.location.origin);
      const sameOrigin = url.origin === self.location.origin;
      if (!sameOrigin && !CDN_HOSTS.includes(url.hostname)) return null;
      return runtime.add(new Request(url.href, { mode: sameOrigin ? 'same-origin' : 'cors', credentials: 'omit' })).catch(() => {});
    }));
  } catch (e) { /* offline during install — runtime caching fills in later */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('clickfud-') && !KEEP_CACHES.includes(n))
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

function isCacheableResponse(res) {
  return res && res.ok && (res.type === 'basic' || res.type === 'cors');
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NAV_TIMEOUT_MS);
    const res = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    // The SPA is one page — keep the freshest copy as the offline shell.
    const url = new URL(request.url);
    if (isCacheableResponse(res) && (url.pathname === '/' || url.pathname === '/index.html')) {
      cache.put('/index.html', res.clone());
    } else if (isCacheableResponse(res)) {
      cache.put(request.url.split('?')[0], res.clone());
    }
    return res;
  } catch (e) {
    const url = new URL(request.url);
    return (await cache.match(url.pathname)) || (await cache.match('/index.html')) || (await cache.match('/')) || offlineFallbackPage();
  }
}

function offlineFallbackPage() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>clickFud</title>' +
    '<body style="font-family:system-ui,sans-serif;background:#FAF9F6;color:#1E1E24;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center">' +
    '<div><h1 style="color:#FF6B00;margin:0 0 8px">clickFud</h1><p>You\'re offline. Connect to the internet to open clickFud for the first time.</p></div></body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

async function cacheFirst(request, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (isCacheableResponse(res)) {
    await cache.put(request, res.clone());
    if (max) trimCache(cacheName, max);
  }
  return res;
}

async function staleWhileRevalidate(event, request, cacheName, asCors) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const update = fetch(asCors ? new Request(request.url, { mode: 'cors', credentials: 'omit' }) : request).then((res) => {
    if (isCacheableResponse(res)) return cache.put(request, res.clone()).then(() => trimCache(cacheName, MAX_RUNTIME)).then(() => res);
    return res;
  });
  if (hit) {
    event.waitUntil(update.catch(() => {}));
    return hit;
  }
  return update;
}

// Images are requested by <img> in no-cors mode, whose opaque responses
// can't be size-checked and bloat storage quota — re-request them as
// CORS (Supabase Storage allows it) so what's cached is a normal response.
async function cachedImage(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  try {
    const res = await fetch(new Request(request.url, { mode: 'cors', credentials: 'omit' }));
    if (isCacheableResponse(res)) {
      await cache.put(request.url, res.clone());
      trimCache(IMAGE_CACHE, MAX_IMAGES);
    }
    return res;
  } catch (e) {
    // Host doesn't allow CORS (or we're offline with no copy) — load it
    // the normal way, just without caching.
    return fetch(request);
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === SUPABASE_ORIGIN) {
    // Only PUBLIC storage objects (shop/menu photos) — never REST, auth,
    // realtime, Edge Functions, or signed/private storage.
    if (/^\/storage\/v1\/(object|render\/image)\/public\//.test(url.pathname) && request.destination !== 'video') {
      event.respondWith(cachedImage(request));
    }
    return;
  }

  if (request.mode === 'navigate') {
    if (url.origin === self.location.origin) event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (url.origin === self.location.origin) {
    if (request.destination === 'image') { event.respondWith(cacheFirst(request, IMAGE_CACHE, MAX_IMAGES)); return; }
    if (url.pathname === '/sw.js') return;
    if (url.searchParams.has('v') && /\.(js|css)$/.test(url.pathname)) {
      event.respondWith(cacheFirst(request, RUNTIME_CACHE, MAX_RUNTIME));
      return;
    }
    if (/\.(js|css|json|png|svg|webp|ico|woff2?)$/.test(url.pathname) || url.pathname.startsWith('/legal/')) {
      event.respondWith(staleWhileRevalidate(event, request, RUNTIME_CACHE));
    }
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(event, request, RUNTIME_CACHE, true));
    return;
  }

  // Other hosts' images (e.g. a shop photo URL pasted from elsewhere).
  if (request.destination === 'image') event.respondWith(cachedImage(request));
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { title: 'clickFud', body: event.data ? event.data.text() : '' }; }

  const title = payload.title || 'clickFud';
  const options = {
    body: payload.body || '',
    tag: payload.tag || 'clickfud',
    data: payload.data || {},
    renotify: false,
    // No vibration feature was ever intentionally built for this app —
    // left unset, the OS/browser applies its own default buzz pattern to
    // every push shown. Explicitly empty so a new notification is silent
    // on the device side (still shows normally; this only controls haptics).
    vibrate: [],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const route = event.notification.data && event.notification.data.route;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if ('focus' in client) {
          // An already-open tab can't be navigated by URL from here (an
          // SPA route, not a real page) — tell it which screen to switch
          // to instead; js/app.js listens for this and calls S.setRoute.
          if (route && 'postMessage' in client) client.postMessage({ type: 'navigate', route });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        const url = route ? `${self.registration.scope}?view=${encodeURIComponent(route)}` : self.registration.scope;
        return self.clients.openWindow(url);
      }
    })
  );
});
