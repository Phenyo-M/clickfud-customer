/* ============================================================
   CLICKFUD — bootstrap, routing, event delegation
   ============================================================ */
window.App = window.App || {};

App.Bootstrap = (function () {
  async function loadPublicData() {
    App.Store.set({ dataLoadError: false });
    await Promise.all([
      App.Stores.fetchAll(),
      App.Stores.fetchPromotions(),
      App.TopAdvert.fetchCurrent(),
      App.Menu.fetchAll(),
      App.ItemExtras.fetchAll(),
      App.Addons.fetchAll(),
      App.Settings.fetchZones(),
      App.Promotions.fetchAll(),
      App.Reviews.fetchAll(),
    ]);
    App.Store.initPublicRealtime();
    App.Store.set({ dataReady: true });
  }
  async function loadPrivateData() {
    // Reviews are RLS-scoped to the caller's identity (own reviews, or all
    // for staff) — the anonymous pre-login fetch in loadPublicData() always
    // returns empty, so it must be re-fetched after every login/account
    // switch or "already reviewed" checks and manager rating stats break.
    await Promise.all([
      App.Orders.fetchAll(),
      App.Notifications.fetchForCurrentUser(),
      App.Reviews.fetchAll(),
    ]);
  }
  return { loadPublicData, loadPrivateData };
})();

(function () {
  const S = App.Store;
  const PAGE_MODULES = {
    customer: () => App.Pages.Customer,
  };

  function loggedOut() { return !S.state.session || !S.state.profile; }
  function showingPublicHome() { return loggedOut() && !S.state.forceAuthView; }

  function currentPageModule() {
    if (loggedOut()) return S.state.forceAuthView ? App.Pages.Auth : App.Pages.Home;
    const factory = PAGE_MODULES[S.state.profile.role];
    return factory ? factory() : App.Pages.WrongApp;
  }

  App.routeToOwnDashboard = function () {
    if (!S.state.profile) return;
    S.set({ forceAuthView: false });
    S.setRoute(App.Shared.defaultRouteForRole(S.state.profile.role));
  };

  function skeleton() {
    const hint = S.state.authCallbackHint;
    return `<div class="splash-screen">
      ${App.Shared.CampusEatsLogo({ size: 'lg', bg: 'white', wordmark: true })}
      ${hint ? `<p class="text-sm text-muted mt-3">${App.Utils.escapeHtml(hint)}</p>` : ''}
    </div>`;
  }

  function mainContent() {
    if (!S.state.authReady) return skeleton();
    // A real Supabase PASSWORD_RECOVERY event (see js/auth.js) — shown
    // regardless of role/login state until the password is actually saved.
    if (S.state.passwordRecovery) return App.Pages.Auth.renderResetPassword();
    return currentPageModule().render();
  }

  // Reads whatever Supabase put on the URL when it redirected back here
  // from an email link (verification or password-reset), purely to show a
  // specific "Verifying your email…" / "Preparing your password reset…"
  // message on the splash screen instead of a blank one, and to catch a
  // link Supabase itself already rejected (expired/invalid/already used)
  // as a clear message instead of silently doing nothing.
  //
  // IMPORTANT: this must never strip code/access_token/token_hash from
  // the URL itself — detectSessionInUrl (js/supabaseClient.js) still needs
  // to read those to actually establish the session, and does its own
  // history.replaceState cleanup once it succeeds. Only the error case
  // (nothing left to exchange — Supabase already rejected the link) is
  // ours to clean up here.
  function parseAuthCallback() {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const query = new URLSearchParams(window.location.search);
    const get = (key) => query.get(key) || hash.get(key);

    const error = get('error') || get('error_code');
    const type = get('type');
    const hasAuthParams = !!(error || type || get('code') || get('access_token') || get('token_hash'));
    if (!hasAuthParams) return;

    if (error) {
      const code = get('error_code') || '';
      const message = /expired/i.test(code) || /expired/i.test(get('error_description') || '')
        ? 'This link has expired. Please request a new one.'
        : /otp_disabled|invalid/i.test(code)
        ? 'This link is invalid. Please request a new one.'
        : 'We couldn’t complete authentication. Please try again.';
      App.Toast.error(message);
      const url = new URL(window.location.href);
      url.hash = '';
      ['error', 'error_code', 'error_description'].forEach((k) => url.searchParams.delete(k));
      history.replaceState({}, '', url.pathname + url.search);
    } else if (type === 'recovery') {
      S.set({ authCallbackHint: 'Preparing your password reset…' });
    } else {
      S.set({ authCallbackHint: 'Verifying your email…' });
    }
  }

  // A shop's Share sheet action (js/pages/home.js shareUrlForStore()) links
  // back here with ?store=<id> — reading it at boot routes straight into
  // that shop's page instead of the default home/dashboard route. The
  // store itself may not be loaded into state yet at this point (that
  // fetch hasn't run); renderStoreDetail() shows a loading skeleton
  // rather than "not found" until it arrives, then this same route just
  // renders correctly once App.Bootstrap.loadPublicData() resolves.
  //
  // IMPORTANT: the param is stripped from the URL immediately after being
  // read, in the same tick — without this, it would sit in the address
  // bar forever, and every later refresh (from anywhere else in the app,
  // on an entirely different tab) would silently reopen this same shop
  // again instead of wherever the user actually was. This is a one-time
  // entry point, not a persistent "current route" the URL tracks.
  function parseSharedStoreLink() {
    const url = new URL(window.location.href);
    const storeId = url.searchParams.get('store');
    if (!storeId) return;
    S.setRoute({ view: 'store', params: { storeId } });
    url.searchParams.delete('store');
    history.replaceState({}, '', url.pathname + url.search + url.hash);
  }

  // Reserves exactly as much bottom space as the fixed bars actually on
  // screen occupy right now, measured after they're in the DOM rather than
  // assumed — so it stays correct whether it's the bottom nav alone, the
  // floating cart bar alone (logged-out guest), both stacked, or neither.
  function updateFixedBottomSpace() {
    const nav = document.querySelector('.bottom-nav');
    const cartBar = document.querySelector('.floating-cart-btn');
    const navH = nav ? nav.getBoundingClientRect().height : 0;
    const cartH = cartBar ? cartBar.getBoundingClientRect().height : 0;
    const total = navH + cartH;
    document.documentElement.style.setProperty('--fixed-bottom-space', total ? (total + 12) + 'px' : '0px');
  }

  App.render = function () {
    const active = document.activeElement;
    const appEl = document.getElementById('app');
    // Covers inputs inside #app as well as the persistent header (e.g. the
    // nav search box) and sidebar — anything with a stable id that survives
    // a full re-render should keep focus/cursor position across it.
    const focusInfo = (active && active.id && document.body.contains(active))
      ? { id: active.id, start: active.selectionStart, end: active.selectionEnd }
      : null;

    const isPublicHome = S.state.authReady && showingPublicHome();
    // Before the initial session check resolves, mainContent() is just
    // the splash screen (skeleton()) — no nav bar, sidebar, or bottom nav
    // should render alongside it at all, since the splash is meant to be
    // the only thing on screen while the app is still loading.
    document.getElementById('app-nav-root').innerHTML = (!S.state.authReady || isPublicHome) ? '' : App.Shared.renderAppNav();
    document.getElementById('sidebar-root').innerHTML = (!S.state.authReady || isPublicHome) ? '' : App.Shared.renderCustomerSidebar();
    document.getElementById('mobile-nav-root').innerHTML = S.state.authReady ? App.Shared.renderBottomNav() : '';
    appEl.innerHTML = mainContent();
    App.FudBot.render(); // customer-only; no-ops (and tears itself down) for every other role — see js/fudbot.js

    document.body.classList.toggle('has-bottomnav', !!S.state.profile || isPublicHome);
    document.body.classList.toggle('has-sidebar', !!(S.state.profile && S.state.profile.role === 'customer'));
    document.body.classList.toggle('no-app-nav', isPublicHome);

    if (window.lucide) lucide.createIcons();
    updateFixedBottomSpace();

    if (focusInfo) {
      const el = document.getElementById(focusInfo.id);
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        el.focus();
        if (typeof focusInfo.start === 'number' && el.setSelectionRange) {
          try { el.setSelectionRange(focusInfo.start, focusInfo.end); } catch (e) {}
        }
      }
    }
  };

  function onStateChange() {
    App.render();
    App.Shared.refreshOpenPanel();
    App.Pages.Customer.checkForReviewPrompt();
    App.Nav.sync();
  }

  // ---------------- Global actions (available regardless of current page) ----------------
  const GLOBAL_ACTIONS = new Set([
    'toggle-theme', 'open-cart', 'close-cart', 'open-notifications', 'mark-all-read', 'read-notification',
    'go-home', 'go-auth', 'go-profile', 'toggle-profile-menu', 'logout', 'navigate', 'close-modal', 'cart-qty', 'cart-remove',
    'clear-cart', 'rate-star', 'submit-review', 'print-receipt', 'open-fudbot',
    'guest-nav-orders', 'guest-nav-favorites', 'guest-nav-profile',
  ]);

  async function doLogout() {
    await App.Auth.signOut();
    S.set({ forceAuthView: false });
    App.Toast.info('Logged out');
  }
  App.doLogout = doLogout;

  function handleGlobalAction(action, ds, el) {
    switch (action) {
      case 'toggle-theme': return S.toggleTheme();
      case 'open-fudbot': return App.FudBot.open();
      case 'open-cart': return App.Shared.openCart();
      case 'close-cart': return App.Slideover.close();
      case 'open-notifications': return App.Shared.openNotifications();
      case 'toggle-profile-menu': return App.Shared.toggleProfileMenu(el);
      case 'mark-all-read': return App.Notifications.markAllRead().then(() => App.Shared.openNotifications());
      case 'read-notification': return App.Notifications.markRead(ds.id).then(() => App.Shared.openNotifications());
      case 'go-home':
        S.set({ forceAuthView: false });
        window.scrollTo(0, 0);
        return S.setRoute(S.state.profile ? App.Shared.defaultRouteForRole(S.state.profile.role) : { view: 'home' });
      // Guest bottom-nav items (js/shared-ui.js renderBottomNav()) — none
      // of these have real data to show a logged-out visitor, so each
      // says so plainly and sends them straight to create an account /
      // log in, rather than a dead end or a fake empty state.
      case 'guest-nav-orders':
        App.Toast.info('Create an account to view your orders.');
        S.set({ forceAuthView: true });
        return App.Pages.Auth.setTab('signup');
      case 'guest-nav-favorites':
        App.Toast.info('Log in to save and view your favourites.');
        S.set({ forceAuthView: true });
        return App.Pages.Auth.setTab('login');
      case 'guest-nav-profile':
        S.set({ forceAuthView: true });
        return App.Pages.Auth.setTab('login');
      case 'go-auth':
        S.set({ forceAuthView: true });
        return App.Pages.Auth.setTab(ds.tab);
      case 'go-profile': return S.setRoute({ view: 'profile' });
      case 'logout': return doLogout();
      case 'navigate': return S.setRoute({ view: ds.view, params: {} });
      case 'close-modal': return App.Modal.close();
      case 'cart-qty': {
        const idx = Number(ds.index);
        const item = S.state.cart[idx];
        if (!item) return;
        return S.updateCartQty(idx, item.qty + Number(ds.delta));
      }
      case 'cart-remove': return S.removeCartItem(Number(ds.index));
      case 'clear-cart': return App.Modal.confirm({
        title: 'Clear your cart?', message: 'All items will be removed from your cart.', variant: 'warn',
        confirmLabel: 'Clear Cart', onConfirm: () => S.clearCart(),
      });
      case 'rate-star': return App.Shared.setReviewStar(ds.field, Number(ds.value));
      case 'submit-review': return App.Shared.submitReview(ds.orderId);
      case 'print-receipt': return window.print();
      default: return;
    }
  }

  // ---------------- Event delegation ----------------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (GLOBAL_ACTIONS.has(action)) { handleGlobalAction(action, el.dataset, el); return; }
    const mod = currentPageModule();
    if (mod && mod.handleAction) mod.handleAction(action, el.dataset, el);
  });

  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-action-input]');
    if (!el) return;
    const kind = el.dataset.actionInput;
    const mod = currentPageModule();
    if (mod && mod.handleInput) mod.handleInput(kind, el.value, el.dataset);
  });

  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-action-change]');
    if (!el) return;
    const kind = el.dataset.actionChange;
    const value = el.type === 'checkbox' ? el.checked : (el.type === 'file' ? el.files[0] : el.value);
    const mod = currentPageModule();
    if (mod && mod.handleChange) mod.handleChange(kind, el.dataset, value, el);
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const formId = form.dataset.form;
    const data = new FormData(form);
    const isAuthForm = ['login-form', 'signup-form', 'forgot-form', 'reset-password-form'].includes(formId);
    const mod = isAuthForm ? App.Pages.Auth : currentPageModule();
    if (mod && mod.handleSubmit) mod.handleSubmit(formId, data, form);
  });

  // Runs once on load if the browser was just redirected back from
  // Paystack's hosted checkout (?reference=...&trxref=...). The presence
  // of this param is never itself trusted as "payment succeeded" — it
  // only tells us which reference to ask paystack-verify to actually
  // check with Paystack, server-side, before any order is created.
  async function handlePaystackReturn() {
    const reference = App.Payments.pendingReferenceFromUrl();
    if (!reference) return;
    App.Payments.clearReferenceFromUrl();
    if (!S.state.profile) return;

    App.Toast.info('Verifying your payment…');
    const res = await App.Payments.verifyReturn(reference);
    if (!res.ok) {
      App.Toast.error(res.error || 'Payment failed. Please try again.');
      return;
    }

    await App.Bootstrap.loadPrivateData();
    const orderIds = res.orderIds || [];
    orderIds.forEach((id) => {
      const order = S.state.orders.find((o) => o.id === id);
      if (order) S.removeCartItemsByStore(order.store_id);
    });
    App.Toast.success(orderIds.length > 1 ? `${orderIds.length} orders placed successfully` : 'Order placed successfully');
    if (orderIds.length === 1) {
      S.setRoute({ view: 'confirmation', params: { orderId: orderIds[0] } });
    } else if (orderIds.length > 1) {
      S.setRoute({ view: 'confirmation-multi', params: { orderIds } });
    }
  }

  // ---------------- Boot ----------------
  function boot() {
    parseAuthCallback();
    parseSharedStoreLink();
    S.loadTheme();
    S.subscribe(onStateChange);
    App.render();
    App.Nav.init();
    App.Bootstrap.loadPublicData();
    App.Auth.restoreSession().then(handlePaystackReturn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
