/* ============================================================
   CLICKFUD — offline snapshot storage (IndexedDB)

   Holds the last successfully-loaded copy of customer-facing data so
   the app can still open and be browsed with no connection. This is a
   read-only mirror of what Supabase already returned to this browser —
   it is never written back to Supabase, never used to price or create
   an order (the server re-prices every order itself, see
   validate_order_pricing() / paystack-initialize), and never bypasses
   RLS: it can only ever contain rows this browser was already allowed
   to read while online.

   What goes in here (see js/app.js / js/auth.js / js/timetable.js):
     'public:catalog'           shops, menus, add-ons, promos banners,
                                home media, collection zones
     'user:<id>:profile'        a WHITELISTED subset of a customer's own
                                profile (name/university/avatar — no
                                phone, email, or student number)
     'user:<id>:timetable'      that customer's own timetable

   Never stored here: passwords, auth tokens (supabase-js keeps its own
   session exactly as before), payment data, orders, notifications, or
   anything belonging to a staff/manager/developer account.

   Every call fails soft — if IndexedDB is unavailable (private mode,
   blocked storage), the app simply behaves as it did before: online-only.
   ============================================================ */
window.App = window.App || {};

App.OfflineCache = (function () {
  const DB_NAME = 'clickfud-offline';
  const DB_VERSION = 1;
  const STORE = 'snapshots';
  // Profile fields the customer UI actually needs to render offline —
  // everything else on the profile row stays server-only.
  const PROFILE_FIELDS = ['id', 'role', 'name', 'avatar_url', 'university', 'campus_location', 'campuses', 'status'];

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        if (!('indexedDB' in window)) return resolve(null);
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDb().then((db) => new Promise((resolve) => {
      if (!db) return resolve(null);
      try {
        const t = db.transaction(STORE, mode);
        const result = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(result && 'result' in result ? result.result : true);
        t.onerror = () => resolve(null);
        t.onabort = () => resolve(null);
      } catch (e) { resolve(null); }
    }));
  }

  function save(key, data) {
    return tx('readwrite', (store) => { store.put({ key, data, savedAt: Date.now() }); });
  }
  function load(key) {
    return tx('readonly', (store) => store.get(key));
  }
  function remove(key) {
    return tx('readwrite', (store) => { store.delete(key); });
  }

  // ---- Public catalog (shops/menus) ----
  const CATALOG_KEYS = ['stores', 'storePromotions', 'homePageMedia', 'homePageMediaText', 'menu', 'menuItemExtras', 'addons', 'zones'];

  function saveCatalog(state) {
    const data = {};
    CATALOG_KEYS.forEach((k) => { data[k] = state[k]; });
    return save('public:catalog', data);
  }
  function loadCatalog() { return load('public:catalog'); }

  // ---- Per-customer bits ----
  function pickProfile(profile) {
    const out = {};
    PROFILE_FIELDS.forEach((f) => { if (profile[f] !== undefined) out[f] = profile[f]; });
    return out;
  }
  function saveProfile(profile) {
    // Only ever a customer — staff/manager/developer accounts can't use
    // this app anyway (js/auth.js signs them straight back out), but this
    // is the hard guarantee none of their data ever lands in this cache.
    if (!profile || profile.role !== 'customer') return Promise.resolve(null);
    return save('user:' + profile.id + ':profile', pickProfile(profile));
  }
  function loadProfile(userId) { return load('user:' + userId + ':profile'); }

  function saveTimetable(userId, rows) { return save('user:' + userId + ':timetable', rows || []); }
  function loadTimetable(userId) { return load('user:' + userId + ':timetable'); }

  function clearUser(userId) {
    if (!userId) return Promise.resolve(null);
    return Promise.all([remove('user:' + userId + ':profile'), remove('user:' + userId + ':timetable')]);
  }

  return { saveCatalog, loadCatalog, saveProfile, loadProfile, saveTimetable, loadTimetable, clearUser };
})();
