/* ============================================================
   CLICKFOOD, real device push notifications (customer app only)

   Registers the service worker, requests Notification permission, and
   subscribes to the browser's Push API using the VAPID public key below
   (safe to ship to the client, it's the public half of the keypair;
   the private half only ever lives in the Edge Function secrets
   VAPID_PRIVATE_KEY). The resulting subscription is saved to push_subscriptions
   so the notify-worker Edge Function can target this exact device.

   This module only ever SUBSCRIBES a device. Sending happens on the
   server: the notify-worker Edge Function sends queued order alerts.
   Permission is asked after the first order or from Settings, never
   at login. New key pair 2026-10-13 (the old private key was lost, so
   push never worked); a device subscribed with the old key re-subscribes.
   ============================================================ */
window.App = window.App || {};

App.Push = (function () {
  // Public key only — safe to expose client-side.
  const VAPID_PUBLIC_KEY = 'BA__0tVwOJDvuf2JQC-Sd17AC6NTg4m61u5adOaxydMUq250BAJciCS0OXxqtBmPB5I7D465267cCITt8hjJv6I';

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    try { return await navigator.serviceWorker.register('/sw.js'); }
    catch (e) { console.error('Service worker registration failed', e); return null; }
  }

  async function saveSubscription(sub) {
    const json = sub.toJSON();
    const { error } = await App.sb.from('push_subscriptions').upsert({
      user_id: App.Store.state.profile.id,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      user_agent: navigator.userAgent,
      last_seen_at: new Date().toISOString(),
      invalid_at: null,
    }, { onConflict: 'endpoint' });
    if (error) console.error('Failed to save push subscription', error);
  }

  function sameKey(sub) {
    try {
      const k = sub.options && sub.options.applicationServerKey;
      if (!k) return false;
      const a = new Uint8Array(k), b = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      return a.length === b.length && a.every((v, i) => v === b[i]);
    } catch (e) { return false; }
  }

  // Subscribes this device for phone alerts. ask: false (at login) never
  // shows the permission prompt, it only refreshes an existing permission.
  // Returns true when the device is subscribed. Never throws.
  async function subscribeIfPossible(opts) {
    const ask = !!(opts && opts.ask);
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
    const profile = App.Store.state.profile;
    if (!profile || profile.role !== 'customer') return false;
    if (Notification.permission === 'denied') return false;
    if (Notification.permission === 'default' && !ask) return false;

    const reg = await registerServiceWorker();
    if (!reg) return false;

    if (Notification.permission === 'default') {
      let permission;
      try { permission = await Notification.requestPermission(); } catch (e) { return false; }
      if (permission !== 'granted') return false;
    }
    if (Notification.permission !== 'granted') return false;

    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub)) { try { await sub.unsubscribe(); } catch (e) { /* replaced below */ } sub = null; }
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      } catch (e) { console.error('Push subscribe failed', e); return false; }
    }
    await saveSubscription(sub);
    return true;
  }

  function supported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function blocked() { return supported() && Notification.permission === 'denied'; }

  // After the first order: ask once on this device (a sensible moment,
  // the student is waiting for their food).
  function askAfterOrder() {
    try {
      if (localStorage.getItem('clickfood_push_asked') === '1') return;
      localStorage.setItem('clickfood_push_asked', '1');
    } catch (e) { /* private mode: just ask */ }
    if (App.Notifications && !App.Notifications.prefOn('push')) return;
    subscribeIfPossible({ ask: true });
  }

  return { registerServiceWorker, subscribeIfPossible, askAfterOrder, supported, blocked };
})();
