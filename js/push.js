/* ============================================================
   CLICKFUD — real device push notifications (customer app only)

   Registers the service worker, requests Notification permission, and
   subscribes to the browser's Push API using the VAPID public key below
   (safe to ship to the client — it's the public half of the keypair;
   the private half only ever lives in the send-push Edge Function's
   secrets). The resulting subscription is saved to push_subscriptions
   so the Edge Function can target this exact device later.

   This module only ever SUBSCRIBES a device. Sending happens
   server-side, from App.Orders (createOrder / markReady /
   acceptDelivery) calling the send-push Edge Function directly.
   ============================================================ */
window.App = window.App || {};

App.Push = (function () {
  // Public key only — safe to expose client-side.
  const VAPID_PUBLIC_KEY = 'BKS5NzZ3Wye4pgb1mw8ePRCwQZ1wMl5qSAp3_guvSWVFdEdzm1UERQahPfSYeICtReqFIlqMTLTHgpze0k4zKGQ';

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
    }, { onConflict: 'endpoint' });
    if (error) console.error('Failed to save push subscription', error);
  }

  // Called once a customer is signed in. Silently does nothing if the
  // browser doesn't support push, permission was already denied, or the
  // user isn't a customer — never nags, never throws for an unsupported
  // browser (Web Push isn't available in every context, e.g. plain
  // Safari tabs on iOS before the app is added to the home screen).
  async function subscribeIfPossible() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    const profile = App.Store.state.profile;
    if (!profile || profile.role !== 'customer') return;
    if (Notification.permission === 'denied') return;

    const reg = await registerServiceWorker();
    if (!reg) return;

    if (Notification.permission === 'default') {
      let permission;
      try { permission = await Notification.requestPermission(); } catch (e) { return; }
      if (permission !== 'granted') return;
    }
    if (Notification.permission !== 'granted') return;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      } catch (e) { console.error('Push subscribe failed', e); return; }
    }
    await saveSubscription(sub);
  }

  return { registerServiceWorker, subscribeIfPossible };
})();
