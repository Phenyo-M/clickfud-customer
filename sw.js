/* ============================================================
   CLICKFUD — service worker
   Only job right now: receive Web Push events and show a real OS
   notification, and focus/open the app when one is tapped. Runs
   independently of any open tab, so this fires even while the app is
   backgrounded, minimized, or closed (device/browser dependent).
   ============================================================ */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { title: 'clickFud', body: event.data ? event.data.text() : '' }; }

  const title = payload.title || 'clickFud';
  const options = {
    body: payload.body || '',
    tag: payload.tag || 'campus-eats',
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
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(self.registration.scope);
    })
  );
});
