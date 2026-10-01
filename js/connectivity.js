/* ============================================================
   CLICKFUD — online/offline detection

   navigator.onLine only says whether the device has SOME network — it
   is true on Wi-Fi with no internet, behind a captive portal, or when
   Supabase itself is unreachable. So it is only used as a fast "we are
   definitely offline" signal; being back "online" is only ever decided
   by actually reaching Supabase (checkBackend() below).

   State lives in App.Store as state.connection:
     online          last known backend reachability
     usingCachedData true while the screen is showing the IndexedDB
                     snapshot instead of a fresh Supabase load
     lastSyncedAt    when the catalog was last loaded from Supabase
   ============================================================ */
window.App = window.App || {};

App.Connectivity = (function () {
  const S = App.Store;
  const POLL_MS = 20000;
  let pollTimer = null;
  let reconnecting = false;
  const reconnectHandlers = [];

  function state() { return S.state.connection; }
  function isOnline() { return state().online; }

  // A real round trip to Supabase — the auth health endpoint is tiny,
  // public (anon key only), and never cached by sw.js.
  async function checkBackend(timeoutMs) {
    if (!navigator.onLine) return false;
    const controller = 'AbortController' in window ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs || 5000) : null;
    try {
      const res = await fetch(App.CONFIG.SUPABASE_URL + '/auth/v1/health', {
        headers: { apikey: App.CONFIG.SUPABASE_ANON_KEY },
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      });
      return res.ok;
    } catch (e) {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function setConnection(patch) {
    S.set({ connection: Object.assign({}, state(), patch) });
  }

  function goOffline() {
    if (!isOnline()) { startPolling(); return; }
    setConnection({ online: false });
    startPolling();
  }

  // Only ever called once checkBackend() has actually succeeded.
  async function goOnline() {
    stopPolling();
    const wasOffline = !isOnline();
    if (wasOffline) setConnection({ online: true });
    if (!wasOffline || reconnecting) return;
    reconnecting = true;
    try {
      App.Toast.success("You're back online.");
      for (const fn of reconnectHandlers) {
        try { await fn(); } catch (e) { console.error('reconnect handler failed', e); }
      }
    } finally {
      reconnecting = false;
    }
  }

  async function recheck() {
    if (await checkBackend()) goOnline(); else goOffline();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      // While the device reports no network at all, the 'online' event
      // below is the signal — no point probing until then.
      if (navigator.onLine) recheck();
    }, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // Called by data loaders when a Supabase request fails in a way that
  // looks like a connection problem (not an RLS/validation error).
  function reportNetworkFailure() {
    if (!navigator.onLine) { goOffline(); return; }
    checkBackend().then((ok) => { if (!ok) goOffline(); });
  }

  // supabase-js reports a dropped connection as an error whose message
  // is the underlying fetch TypeError ("Failed to fetch", "NetworkError
  // when attempting to fetch resource", "Load failed" on Safari).
  // functions.invoke() wraps the same thing in a FunctionsFetchError
  // ("Failed to send a request to the Edge Function").
  function isNetworkError(error) {
    if (!error) return false;
    if (error.name === 'FunctionsFetchError') return true;
    const msg = String(error.message || error);
    return /failed to fetch|networkerror|load failed|network request failed|fetch failed|failed to send a request/i.test(msg);
  }

  function onReconnect(fn) { reconnectHandlers.push(fn); }

  function init() {
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', recheck);
    if (!navigator.onLine) goOffline();
  }

  return { init, isOnline, checkBackend, reportNetworkFailure, isNetworkError, onReconnect, setConnection };
})();
