/* ============================================================
   CLICKFUD — reactive state store, LocalStorage bits (cart,
   favorites, theme) and Supabase Realtime wiring
   ============================================================ */
window.App = window.App || {};

App.Store = (function () {
  const LS = App.CONST.LS_KEYS;

  const state = {
    session: null,
    profile: null,        // row from public.profiles
    authReady: false,      // becomes true once initial session check completes
    dataReady: false,      // becomes true once the initial public data fetch completes
    dataLoadError: false,  // set if stores/menu failed to load, cleared on retry
    stores: [],
    storePromotions: [],
    topAdvert: null,
    menu: [],
    menuItemExtras: [],
    addons: [],
    orders: [],
    notifications: [],
    reviews: [],
    promotions: [],
    zones: [],
    settings: {},
    cart: [],              // [{menuItemId,name,price,image,qty,addons,specialInstructions}]
    favorites: [],         // [menuItemId]
    favoriteStores: [],    // [storeId]
    theme: 'light',
    route: { role: null, view: 'home', params: {} },
    ui: { cartOpen: false, notifPanelOpen: false, loading: {} },
    // Logged-out visitors see the public homepage by default; this flips
    // true only when they explicitly choose Login/Sign Up from it.
    forceAuthView: false,
    // Set true only by a real Supabase PASSWORD_RECOVERY auth event (the
    // user clicked a genuine password-reset email link) — while true, the
    // app shows the Create New Password screen instead of any normal
    // page, regardless of role/login state. Never set this any other way.
    passwordRecovery: false,
    // Cosmetic only: what the splash screen says while authReady is still
    // false, based on what's in the URL right after landing here from an
    // email link — set once at boot from the URL, never authoritative.
    authCallbackHint: null,
    authCallbackError: null,
  };

  const listeners = [];
  function subscribe(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i > -1) listeners.splice(i, 1); }; }
  function notify() { listeners.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } }); }
  function set(patch) { Object.assign(state, patch); notify(); }
  function setUI(patch) { Object.assign(state.ui, patch); notify(); }
  function setRoute(route) { state.route = Object.assign({}, state.route, route); notify(); }

  function upsertIn(key, row, idField) {
    idField = idField || 'id';
    const list = state[key];
    const i = list.findIndex(r => r[idField] === row[idField]);
    if (i > -1) list[i] = Object.assign({}, list[i], row); else list.unshift(row);
    notify();
  }
  function removeFrom(key, id, idField) {
    idField = idField || 'id';
    state[key] = state[key].filter(r => r[idField] !== id);
    notify();
  }

  // ---------------- Theme ----------------
  function loadTheme() {
    let theme = 'system';
    try { theme = localStorage.getItem(LS.THEME) || 'system'; } catch (e) {}
    applyTheme(theme, false);
  }
  function applyTheme(theme, persist) {
    const root = document.documentElement;
    if (theme === 'light') root.setAttribute('data-theme', 'light');
    else if (theme === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    state.theme = theme;
    if (persist !== false) { try { localStorage.setItem(LS.THEME, theme); } catch (e) {} }
    notify();
  }
  function toggleTheme() {
    const current = state.theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : state.theme;
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  // ---------------- Cart (per-user, LocalStorage) ----------------
  function cartKey() { return LS.CART + (state.profile ? state.profile.id : 'guest'); }
  function loadCart() {
    try { state.cart = JSON.parse(localStorage.getItem(cartKey()) || '[]'); } catch (e) { state.cart = []; }
    mergeGuestCartIfNeeded();
    notify();
  }
  function saveCart() {
    try { localStorage.setItem(cartKey(), JSON.stringify(state.cart)); } catch (e) {}
    notify();
  }
  // Items added while browsing as a guest are saved under the shared
  // 'guest' cart key. The first time a real account's cart is loaded
  // (right after logging in or registering), fold any leftover guest-cart
  // items into it once — so a guest who was sent to log in/sign up from
  // Checkout comes back to the cart they actually built, not an empty one.
  function mergeGuestCartIfNeeded() {
    if (!state.profile) return; // still browsing as a guest — nothing to merge yet
    const guestKey = LS.CART + 'guest';
    let guestCart = [];
    try { guestCart = JSON.parse(localStorage.getItem(guestKey) || '[]'); } catch (e) { guestCart = []; }
    if (!guestCart.length) return;
    guestCart.forEach(item => {
      const existing = state.cart.find(c =>
        c.menuItemId === item.menuItemId &&
        c.specialInstructions === item.specialInstructions &&
        JSON.stringify(c.addons || []) === JSON.stringify(item.addons || [])
      );
      if (existing) existing.qty += item.qty; else state.cart.push(item);
    });
    try { localStorage.removeItem(guestKey); } catch (e) {}
    saveCart();
  }
  function addToCart(item) {
    const existing = state.cart.find(c =>
      c.menuItemId === item.menuItemId &&
      c.specialInstructions === item.specialInstructions &&
      JSON.stringify(c.addons || []) === JSON.stringify(item.addons || [])
    );
    if (existing) existing.qty += item.qty;
    else state.cart.push(item);
    saveCart();
  }
  function updateCartQty(index, qty) {
    if (!state.cart[index]) return;
    if (qty <= 0) { state.cart.splice(index, 1); } else { state.cart[index].qty = qty; }
    saveCart();
  }
  function removeCartItem(index) { state.cart.splice(index, 1); saveCart(); }
  function clearCart() { state.cart = []; saveCart(); }

  // clickFud is a multi-vendor marketplace — a single cart can hold items
  // from several stores at once. Every cart item carries its own
  // storeId/storeName, and checkout (App.Pages.Customer.placeOrder) splits
  // the cart back into one order per store before it ever reaches the
  // database, so each store still only ever receives its own items.
  function getCartStoreId() { return state.cart.length ? state.cart[0].storeId : null; }
  function getCartStoreName() { return state.cart.length ? state.cart[0].storeName : null; }

  // Unique store IDs currently represented in the cart, in first-seen order.
  function getCartStoreIds() {
    const seen = new Set(); const ids = [];
    state.cart.forEach(c => { if (c.storeId && !seen.has(c.storeId)) { seen.add(c.storeId); ids.push(c.storeId); } });
    return ids;
  }

  // Groups cart items by store while preserving each item's real index in
  // state.cart (as cartIndex) — callers that render per-item qty/remove
  // controls must keep using cartIndex with updateCartQty/removeCartItem,
  // since those operate on the flat array, not the grouped view.
  function cartGroupsByStore() {
    const map = {}; const groups = [];
    state.cart.forEach((item, index) => {
      const sid = item.storeId;
      if (!map[sid]) { map[sid] = { storeId: sid, storeName: item.storeName, items: [] }; groups.push(map[sid]); }
      map[sid].items.push(Object.assign({ cartIndex: index }, item));
    });
    return groups;
  }

  // Removes only one store's items from the cart — used after that store's
  // split order is successfully created, so a failure on another store's
  // order (e.g. an item went out of stock mid-checkout) leaves its items
  // safely in the cart instead of losing them.
  function removeCartItemsByStore(storeId) {
    state.cart = state.cart.filter(c => c.storeId !== storeId);
    saveCart();
  }

  function addToCartWithConfirm(item, opts) {
    opts = opts || {};
    addToCart(item);
    if (opts.onAdded) opts.onAdded();
  }

  // ---------------- Favorites (per-user, LocalStorage) ----------------
  function favKey() { return LS.FAVORITES + (state.profile ? state.profile.id : 'guest'); }
  function loadFavorites() {
    try { state.favorites = JSON.parse(localStorage.getItem(favKey()) || '[]'); } catch (e) { state.favorites = []; }
    notify();
  }
  function saveFavorites() {
    try { localStorage.setItem(favKey(), JSON.stringify(state.favorites)); } catch (e) {}
    notify();
  }
  function toggleFavorite(menuItemId) {
    const i = state.favorites.indexOf(menuItemId);
    if (i > -1) state.favorites.splice(i, 1); else state.favorites.push(menuItemId);
    saveFavorites();
  }

  // ---------------- Favorite stores (per-user, LocalStorage — same pattern as menu-item favorites above, never synced to Supabase) ----------------
  function favStoreKey() { return LS.FAVORITE_STORES + (state.profile ? state.profile.id : 'guest'); }
  function loadFavoriteStores() {
    try { state.favoriteStores = JSON.parse(localStorage.getItem(favStoreKey()) || '[]'); } catch (e) { state.favoriteStores = []; }
    notify();
  }
  function saveFavoriteStores() {
    try { localStorage.setItem(favStoreKey(), JSON.stringify(state.favoriteStores)); } catch (e) {}
    notify();
  }
  function toggleFavoriteStore(storeId) {
    const i = state.favoriteStores.indexOf(storeId);
    if (i > -1) state.favoriteStores.splice(i, 1); else state.favoriteStores.push(storeId);
    saveFavoriteStores();
  }

  // ---------------- Cross-tab sync for LocalStorage-backed bits ----------------
  window.addEventListener('storage', (e) => {
    if (e.key === LS.THEME) { loadTheme(); }
    if (e.key === cartKey()) { loadCart(); }
    if (e.key === favKey()) { loadFavorites(); }
    if (e.key === favStoreKey()) { loadFavoriteStores(); }
  });

  // ---------------- Supabase Realtime wiring ----------------
  // Public tables (menu_items, stores) sync live for everyone, logged in or
  // not — set up once at boot. Private/RLS-scoped tables (orders,
  // notifications, reviews) are only subscribed after login.
  let publicChannels = [];
  let channels = [];

  function initPublicRealtime() {
    if (publicChannels.length) return;
    const chMenu = App.sb.channel('menu-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_items' }, (payload) => {
        if (payload.eventType === 'DELETE') removeFrom('menu', payload.old.id);
        else upsertIn('menu', payload.new);
      }).subscribe();

    const chStores = App.sb.channel('stores-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stores' }, (payload) => {
        if (payload.eventType === 'DELETE') removeFrom('stores', payload.old.id);
        else upsertIn('stores', payload.new);
      }).subscribe();

    const chStorePromos = App.sb.channel('store-promotions-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'store_promotions' }, (payload) => {
        if (payload.eventType === 'DELETE') removeFrom('storePromotions', payload.old.id);
        else upsertIn('storePromotions', payload.new);
      }).subscribe();

    publicChannels = [chMenu, chStores, chStorePromos];
  }

  function teardownRealtime() {
    channels.forEach(ch => App.sb.removeChannel(ch));
    channels = [];
  }
  function initRealtime() {
    teardownRealtime();
    const chOrders = App.sb.channel('orders-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
        if (payload.eventType === 'DELETE') removeFrom('orders', payload.old.id);
        else upsertIn('orders', payload.new);
      }).subscribe();

    const chNotif = App.sb.channel('notifications-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, (payload) => {
        if (payload.eventType === 'DELETE') removeFrom('notifications', payload.old.id);
        else upsertIn('notifications', payload.new);
      }).subscribe();

    const chReviews = App.sb.channel('reviews-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reviews' }, (payload) => {
        if (payload.eventType !== 'DELETE') upsertIn('reviews', payload.new);
      }).subscribe();

    channels = [chOrders, chNotif, chReviews];
  }

  return {
    state, subscribe, notify, set, setUI, setRoute, upsertIn, removeFrom,
    loadTheme, applyTheme, toggleTheme,
    loadCart, saveCart, addToCart, addToCartWithConfirm, getCartStoreId, getCartStoreName,
    getCartStoreIds, cartGroupsByStore, removeCartItemsByStore,
    updateCartQty, removeCartItem, clearCart,
    loadFavorites, saveFavorites, toggleFavorite,
    loadFavoriteStores, saveFavoriteStores, toggleFavoriteStore,
    initRealtime, teardownRealtime, initPublicRealtime,
  };
})();
