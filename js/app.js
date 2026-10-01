/* ============================================================
   CLICKFUD — bootstrap, routing, event delegation
   ============================================================ */
window.App = window.App || {};

// Forces the page to the very top after any route/content swap — a
// single window.scrollTo(0,0) right after the swap was NOT reliably
// sticking (confirmed by live testing: opening a shop from partway down
// a long page still landed scrolled near the bottom). Something else —
// most likely a focused element's native browser auto-scroll-into-view,
// or the old scrollY simply getting clamped to the new, shorter page's
// max before a single reset runs — was winning the race. Repeating the
// reset across several animation frames plus a couple of short
// timeouts, and touching window/documentElement/body (older mobile
// browsers use the latter), is a deliberately over-engineered belt-and-
// braces fix for that race rather than a single well-timed call.
// Shared app-wide (not just the home page) — every "switch to a
// different view" action should use this, not its own one-off fix.
App.forceScrollTop = function () {
  function reset() {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }
  reset();
  requestAnimationFrame(() => { reset(); requestAnimationFrame(reset); });
  setTimeout(reset, 50);
  setTimeout(reset, 200);
};

App.Bootstrap = (function () {
  const S = App.Store;

  // Shows the last saved catalog (IndexedDB) immediately, before/without
  // Supabase — only ever used to fill an empty screen, never to overwrite
  // data that already came from Supabase this session.
  async function hydrateFromOfflineCache() {
    const snap = await App.OfflineCache.loadCatalog();
    if (!snap || !snap.data || S.state.stores.length) return false;
    S.set(Object.assign({}, snap.data, {
      dataReady: true,
      connection: Object.assign({}, S.state.connection, { usingCachedData: true, lastSyncedAt: snap.savedAt }),
    }));
    return true;
  }

  async function loadPublicData() {
    S.set({ dataLoadError: false });
    // A quick local read (milliseconds) BEFORE the network load, so a
    // slow/absent connection still gets the saved shops on screen
    // straight away; the Supabase results below then replace it.
    const usedCache = S.state.stores.length ? false : await hydrateFromOfflineCache();
    await Promise.all([
      App.Stores.fetchAll(),
      App.Stores.fetchPromotions(),
      App.HomePageMedia.fetchAll(),
      App.Menu.fetchAll(),
      App.ItemExtras.fetchAll(),
      App.Addons.fetchAll(),
      App.Settings.fetchZones(),
      App.Promotions.fetchAll(),
      App.Reviews.fetchAll(),
    ]);

    if (S.state.dataLoadError) {
      // The core shops/menu fetch failed. If it's a connection problem and
      // a saved copy exists, show that (with the offline banner) instead
      // of the "couldn't load" error — reconnecting reloads the real data.
      const haveCache = usedCache || S.state.connection.usingCachedData || await hydrateFromOfflineCache();
      const reachable = await App.Connectivity.checkBackend();
      if (!reachable) App.Connectivity.reportNetworkFailure();
      if (haveCache && !reachable) S.set({ dataLoadError: false });
    } else {
      // A clean, full Supabase load — this is now the current data, and
      // the new offline snapshot.
      S.set({ connection: Object.assign({}, S.state.connection, { online: true, usingCachedData: false, lastSyncedAt: Date.now() }) });
      App.OfflineCache.saveCatalog(S.state);
    }
    S.initPublicRealtime();
    S.set({ dataReady: true });
  }
  async function loadPrivateData() {
    // Reviews are RLS-scoped to the caller's identity (own reviews, or all
    // for staff) — the anonymous pre-login fetch in loadPublicData() always
    // returns empty, so it must be re-fetched after every login/account
    // switch or "already reviewed" checks and manager rating stats break.
    const uid = App.Store.state.profile && App.Store.state.profile.id;
    await Promise.all([
      App.Orders.fetchAll(),
      App.Notifications.fetchForCurrentUser(),
      App.Reviews.fetchAll(),
      App.Timetable.fetchAll(),
    ]);
    // Orders AND reviews are now both loaded for this user — only from
    // here on can "has this completed order been rated?" be answered
    // correctly (js/pages/customer.js checkForReviewPrompt). Before, orders
    // often arrived first and every already-rated order looked unrated.
    if (uid && App.Store.state.profile && App.Store.state.profile.id === uid) App.Store.set({ privateDataFor: uid });
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

  // First-time welcome screen ("Page 0") — a pure one-time gate, entirely
  // independent of auth state, computed once at boot. If localStorage is
  // blocked/unavailable, fail OPEN (skip onboarding) rather than trap
  // someone who can't persist the flag on a screen with no other way out.
  let onboardingActive = (function () {
    // ?welcome in the URL shows it again on demand (for checking how it looks).
    if (/[?&]welcome\b/.test(location.search)) return true;
    try { return localStorage.getItem(App.CONST.LS_KEYS.ONBOARDING_COMPLETE) !== 'true'; }
    catch (e) { return false; }
  })();
  function completeOnboarding() {
    onboardingActive = false;
    try { localStorage.setItem(App.CONST.LS_KEYS.ONBOARDING_COMPLETE, 'true'); } catch (e) {}
    App.render();
  }

  function currentPageModule() {
    // Mirrors mainContent()'s own routing below: a real Supabase
    // PASSWORD_RECOVERY session sets both session and profile, so
    // loggedOut() is false here even though the New Password screen
    // (App.Pages.Auth.renderResetPassword()) is what's actually on
    // screen — without this check, clicks on that screen (e.g. its
    // eye/show-password buttons) were routed to the signed-in role's
    // own page module instead, which has no handler for them.
    if (S.state.passwordRecovery) return App.Pages.Auth;
    if (loggedOut()) return S.state.forceAuthView ? App.Pages.Auth : App.Pages.Home;
    // A student with no university/campus yet (e.g. a fresh Google sign-up)
    // gets nothing but the campus setup screen until they complete it.
    if (App.Auth.needsCampusSetup(S.state.profile)) return App.Pages.CampusSetup;
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
      ${App.Shared.ClickFudLogo({ size: 'lg', bg: 'white', wordmark: true })}
      ${hint ? `<p class="text-sm text-muted mt-3">${App.Utils.escapeHtml(hint)}</p>` : ''}
    </div>`;
  }

  function mainContent() {
    if (onboardingActive) return App.Pages.Onboarding.render();
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
      // Google sign-in with a non-UP email: the database refused to create
      // the customer account (supabase/up_student_auth.sql) and Supabase
      // redirects back with only a generic "Database error saving new user".
      const message = /database error saving new user|UP_STUDENT/i.test(get('error_description') || '')
        ? `Please sign in with your University of Pretoria student Google account (…@${App.CONFIG.UP_STUDENT_EMAIL_DOMAIN}).`
        : /expired/i.test(code) || /expired/i.test(get('error_description') || '')
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

  // A tapped push notification opened a fresh window/tab with
  // ?view=<route> (see sw.js's notificationclick — e.g. the 10-minute
  // class reminder) — same one-time-entry-point pattern as
  // parseSharedStoreLink above.
  function parseNotificationRoute() {
    const url = new URL(window.location.href);
    const view = url.searchParams.get('view');
    if (!view) return;
    S.setRoute({ view, params: {} });
    url.searchParams.delete('view');
    history.replaceState({}, '', url.pathname + url.search + url.hash);
  }

  // The same notification click, but an already-open tab was focused
  // instead of a new one opening — sw.js posts a message here rather
  // than navigating a URL, since this is an SPA route, not a real page.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'navigate' && event.data.route) {
        S.setRoute({ view: event.data.route, params: {} });
        App.forceScrollTop();
      }
    });
  }

  // Reserves exactly as much bottom space as the fixed bars actually on
  // screen occupy right now, measured after they're in the DOM rather than
  // assumed — so it stays correct whether it's the bottom nav alone, the
  // floating cart bar alone, both stacked, or neither. Measures real
  // on-screen position (viewport height minus the topmost bar's own
  // .top) rather than adding up heights + a guessed gap, since the
  // raised centre FAB (My Orientation for a customer, cart for a guest —
  // css/components.css .bottom-nav-fab) pokes above the nav's own box,
  // and the floating cart bar sits with a deliberate gap above THAT (see
  // css/home.css .floating-cart-btn) — a fixed constant can't track both.
  function updateFixedBottomSpace() {
    const nav = document.querySelector('.bottom-nav');
    const cartBar = document.querySelector('.floating-cart-btn');
    const fab = nav ? nav.querySelector('.bottom-nav-fab') : null;
    let top = null;
    [cartBar, fab, nav].forEach((el) => {
      if (!el) return;
      const t = el.getBoundingClientRect().top;
      if (top === null || t < top) top = t;
    });
    const total = top === null ? 0 : Math.max(0, window.innerHeight - top);
    document.documentElement.style.setProperty('--fixed-bottom-space', total ? (total + 12) + 'px' : '0px');
  }

  // Slim, in-flow (scrolls away, never covers anything) notice while the
  // app is showing its saved offline copy instead of live Supabase data.
  function renderOfflineBanner() {
    const c = S.state.connection;
    if (c.online) return '';
    const saved = c.usingCachedData && c.lastSyncedAt
      ? ` Saved ${App.Utils.escapeHtml(App.Utils.timeAgo(c.lastSyncedAt))} — prices and availability may have changed.`
      : '';
    return `<div class="offline-banner" role="status">
      <i data-lucide="wifi-off"></i>
      <span><strong>You're offline.</strong> Showing saved information.${saved}</span>
    </div>`;
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

    // The hero banner's own rotation timer (js/pages/home.js
    // startHeroRotation/refreshHeroDom) already updates its <img>/<video>
    // in place rather than going through App.render() — but that only
    // ever protected against ITS OWN 6-second tick. Any OTHER reason this
    // function runs (a cart change, a realtime store/menu update, opening
    // a modal, anything) still wipes and rebuilds the entire page via
    // appEl.innerHTML below, which tears down and recreates the hero's
    // <video>/<img> element too — a brand-new <video> restarts playback
    // from a blank frame every time, which is what actually reads as the
    // hero "reloading/shaking" so often, not a real bug in the promo
    // content itself. Preserving the exact same DOM node across a re-
    // render (the same trick used for focusInfo below, just for a whole
    // subtree instead of one input) means the browser never has to
    // redecode/restart it just because something unrelated changed.
    const oldHero = document.getElementById('hero-banner-root');
    const oldHeroKey = oldHero && oldHero.dataset.heroKey;

    const isPublicHome = S.state.authReady && showingPublicHome();
    // Campus setup is a full-screen gate: no nav bars, nothing to navigate to.
    const needsSetup = S.state.authReady && !S.state.passwordRecovery && App.Auth.needsCampusSetup(S.state.profile);
    const bare = onboardingActive || !S.state.authReady || isPublicHome || needsSetup;
    // Before the initial session check resolves, mainContent() is just
    // the splash screen (skeleton()) — no nav bar, sidebar, or bottom nav
    // should render alongside it at all, since the splash is meant to be
    // the only thing on screen while the app is still loading.
    document.getElementById('app-nav-root').innerHTML = bare ? '' : App.Shared.renderAppNav();
    document.getElementById('sidebar-root').innerHTML = bare ? '' : App.Shared.renderCustomerSidebar();
    document.getElementById('mobile-nav-root').innerHTML = (!onboardingActive && S.state.authReady && !needsSetup) ? App.Shared.renderBottomNav() : '';
    document.getElementById('offline-banner-root').innerHTML = onboardingActive ? '' : renderOfflineBanner();
    appEl.innerHTML = mainContent();

    if (oldHero) {
      const newHero = document.getElementById('hero-banner-root');
      // Same promo, same slot — swap the freshly-built (but not yet
      // painted/decoded) node back out for the one that was already
      // playing/decoded, so nothing about it visibly restarts.
      if (newHero && newHero.dataset.heroKey === oldHeroKey) newHero.replaceWith(oldHero);
    }

    document.body.classList.toggle('has-bottomnav', (!bare && !!S.state.profile) || (!onboardingActive && isPublicHome));
    document.body.classList.toggle('has-sidebar', !bare && !!(S.state.profile && S.state.profile.role === 'customer'));
    document.body.classList.toggle('no-app-nav', onboardingActive || isPublicHome || needsSetup);

    if (window.lucide) lucide.createIcons();
    updateFixedBottomSpace();

    if (focusInfo) {
      const el = document.getElementById(focusInfo.id);
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        // preventScroll: restoring cursor position after a re-render must
        // never also force-scroll the page to that field — some browsers
        // do this by default on any .focus() call.
        el.focus({ preventScroll: true });
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
    // A friend's shared-timetable link waiting to be previewed/accepted
    // (js/timetable-share.js) — no-op unless one is pending.
    if (!onboardingActive) App.TimetableShare.checkPending();
    App.Nav.sync();
  }

  // ---------------- Global actions (available regardless of current page) ----------------
  const GLOBAL_ACTIONS = new Set([
    'toggle-theme', 'open-cart', 'close-cart', 'open-notifications', 'mark-all-read', 'read-notification',
    'go-home', 'go-auth', 'go-profile', 'logout', 'navigate', 'close-modal', 'cart-qty', 'cart-remove',
    'clear-cart', 'rate-star', 'submit-review', 'print-receipt', 'open-campusbox',
    'guest-nav-orders', 'guest-nav-favorites', 'guest-nav-profile', 'onboarding-next',
  ]);

  // Opens RecessBox (a separate app/product — internal identifiers like
  // CAMPUSBOX_URL/campusbox-bridge below are unchanged infra names, not
  // the product's display name) in a new tab. Signed-in customers get
  // bridged straight into a matching RecessBox account via the
  // campusbox-bridge Edge Function (see that function's own comments for
  // why a token round-trip is required instead of just sharing a
  // session); anyone else just lands on RecessBox's own sign-in page.
  async function openCampusBox() {
    const win = window.open('', '_blank');
    if (!S.state.profile || S.state.profile.role !== 'customer') {
      if (win) win.location = App.CONFIG.CAMPUSBOX_URL;
      return;
    }
    try {
      const { data, error } = await App.sb.functions.invoke('campusbox-bridge');
      if (error || !data || !data.token) throw error || new Error('no token');
      if (win) win.location = `${App.CONFIG.CAMPUSBOX_URL}/api/bridge?token=${encodeURIComponent(data.token)}`;
    } catch (e) {
      console.error('RecessBox bridge failed', e);
      if (win) win.location = App.CONFIG.CAMPUSBOX_URL;
      App.Toast.error("Couldn't connect your RecessBox account automatically — taking you to RecessBox to sign in.");
    }
  }

  // (No background RecessBox account creation any more: RecessBox now asks
  // the student "Use your clickFud account?" the first time they open it,
  // and only creates the account if they say yes.)

  async function doLogout() {
    await App.Auth.signOut();
    S.set({ forceAuthView: false });
    App.Toast.info('Logged out');
  }
  App.doLogout = doLogout;

  // Only ever reached from an explicit "Logout" tap (data-action="logout")
  // — never from going back/navigating away, which uses entirely
  // different actions (go-home, navigate, etc.) that this never hooks
  // into. Same confirm-dialog pattern already used for clear-cart above.
  function confirmLogout() {
    App.Modal.confirm({
      title: 'Log out?', message: 'Are you sure you want to log out?', variant: 'warn',
      confirmLabel: 'Log Out', cancelLabel: 'Cancel', onConfirm: doLogout,
    });
  }

  function handleGlobalAction(action, ds, el) {
    switch (action) {
      case 'onboarding-next': return completeOnboarding();
      case 'toggle-theme': return S.toggleTheme();
      case 'open-cart': return App.Shared.openCart();
      case 'close-cart': return App.Slideover.close();
      case 'open-notifications': return App.Shared.openNotifications();
      case 'mark-all-read': return App.Notifications.markAllRead().then(() => App.Shared.openNotifications());
      case 'read-notification': return App.Notifications.markRead(ds.id).then(() => App.Shared.openNotifications());
      case 'open-campusbox': return openCampusBox();
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
      case 'logout': return confirmLogout();
      case 'navigate':
        S.setRoute({ view: ds.view, params: {} });
        return App.forceScrollTop();
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
    // Timetable sharing can appear on any page (a friend's link opens a
    // preview wherever the student lands), so it's routed globally.
    if (action.indexOf('ttshare-') === 0) { App.TimetableShare.handleAction(action, el.dataset, el); return; }
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

  // ---------------- Paystack: confirming a payment ----------------
  // How a card payment reaches "Order Placed!":
  //   paystack-webhook (Paystack -> server, signed) creates the order the
  //   moment Paystack confirms the charge — the student's browser plays no
  //   part in that. What the browser needs is to FIND OUT, however the
  //   student gets back to this window. Relying only on Paystack's redirect
  //   landing in this same window failed often in production (installed
  //   home-screen app hands Paystack to a separate browser without the
  //   student's login; tab closed; app reopened later) — the order existed
  //   but the student never saw it confirmed.
  //
  // So the reference is saved BEFORE leaving for Paystack (App.Payments.
  // startPaystackCheckout), and checkPendingPayment() asks paystack-verify
  // about it whenever there's a reason to believe it may have finished:
  //   - Paystack's redirect lands here (?reference=)      -> with a visible "verifying" modal
  //   - the app/tab becomes visible again or is restored  -> silently
  //   - a live update shows an order for that reference   -> silently, instantly
  //   - a short backoff re-check while the app is visible -> silently
  // Only ever confirms on the SERVER's answer — the reference itself proves
  // nothing (the server re-checks with Paystack using the secret key).
  const PAYMENT_WATCH_MS = 15 * 60 * 1000;  // stop background re-checks this long after checkout started
  let paymentCheckInFlight = false;
  let paymentPollTimer = null;
  let paymentPollDelay = 2000;
  let waitingNoticeShown = false;

  function resetCheckoutButton() {
    const c = App.Pages.Customer.local.checkout;
    if (c && c.placing) { c.placing = false; App.render(); }
  }

  function showPaidOrders(orderIds) {
    App.Payments.clearPendingReference();
    App.Payments.clearUnfinishedCheckout();
    stopPaymentWatch();
    if (!orderIds.length) {
      // Shouldn't happen on a real ok:true response, but never leave the
      // "verifying" modal stuck on screen if it somehow does.
      App.Modal.close();
      App.Toast.success('Payment verified.');
      return;
    }
    // A Paystack checkout is all-or-nothing — every store group in it was
    // paid for in the one transaction — so the whole cart was just paid for.
    S.clearCart();
    App.Pages.Customer.local.checkout = null;
    // Confirm immediately: the order rows already exist server-side; the
    // page underneath fills in real details when loadPrivateData lands.
    if (orderIds.length === 1) {
      S.setRoute({ view: 'confirmation', params: { orderId: orderIds[0] } });
      App.Shared.openOrderSuccessModal({ count: 1, orderNumber: null });
    } else {
      S.setRoute({ view: 'confirmation-multi', params: { orderIds } });
      App.Shared.openOrderSuccessModal({ count: orderIds.length });
    }
    App.forceScrollTop();
    App.Bootstrap.loadPrivateData().catch((e) => console.error('loadPrivateData after payment failed', e));
  }

  async function checkPendingPayment(opts) {
    const interactive = !!(opts && opts.interactive);
    const reference = App.Payments.getPendingReference();
    if (!reference) { stopPaymentWatch(); return; }
    if (!S.state.profile) return;                              // stays saved; checked once signed in
    if (!navigator.onLine || !S.state.connection.online) return; // reconnect handler re-checks
    if (paymentCheckInFlight) return;
    paymentCheckInFlight = true;
    try {
      if (interactive) App.Shared.openVerifyingPaymentModal();
      const res = await App.Payments.verifyReturn(reference, 1, interactive ? 4 : 1);
      if (res.ok) { showPaidOrders(res.orderIds || []); return; }
      if (interactive) App.Modal.close();

      if (res.pending && res.paystackStatus === 'abandoned' && offerUnfinishedPayment(reference)) {
        // Paystack says nothing was paid yet — they left its page. Their
        // checkout is back on screen with "Continue payment" (same Paystack
        // payment). Still watched, in case they finish it in another tab.
        startPaymentWatch();
        return;
      }
      if (res.pending || res.transient) {
        // No final answer yet (still on Paystack's page, bank still
        // processing, or our function unreachable). Keep it saved and keep
        // watching; let the student retry if they didn't actually pay.
        resetCheckoutButton();
        if (interactive || (res.pending && !waitingNoticeShown && document.visibilityState === 'visible' && S.state.route.view === 'checkout')) {
          waitingNoticeShown = true;
          App.Toast.info(res.transient
            ? "We couldn't reach the server to confirm your payment yet — we'll keep trying. You can also check My Orders shortly."
            : "Waiting for Paystack to confirm your payment. Your order will appear here the moment it's confirmed.");
        }
        startPaymentWatch();
        return;
      }

      // A definitive "no": declined, not this account's payment, unknown
      // reference. Safe to stop; the student can simply try again.
      App.Payments.clearPendingReference();
      stopPaymentWatch();
      resetCheckoutButton();
      if (res.httpStatus === 403) return; // another account's payment on a shared device — nothing to tell this user
      App.Toast.error(res.error || 'Payment failed. Please try again.');
      offerUnfinishedPayment(reference); // their details are still saved: "Continue payment" starts a new one
    } catch (e) {
      console.error('checkPendingPayment failed', e);
      if (interactive) {
        App.Modal.close();
        App.Toast.error("Your payment may have gone through, but we couldn't confirm it here — please check My Orders.");
      }
      startPaymentWatch();
    } finally {
      paymentCheckInFlight = false;
    }
  }

  // Short backoff re-checks (2s, 3s, 4s … capped at 8s) while the app is
  // on screen, for at most PAYMENT_WATCH_MS after checkout started. Paused
  // while hidden — becoming visible triggers an immediate check instead.
  // Brings the saved checkout back on screen (once per payment per visit —
  // never traps them there; the home page keeps a link back to it).
  const unfinishedOffered = new Set();
  function offerUnfinishedPayment(reference) {
    const u = App.Payments.getUnfinishedCheckout();
    if (!u || u.reference !== reference || !S.state.cart.length || S.state.profile?.role !== 'customer') return false;
    resetCheckoutButton();
    if (unfinishedOffered.has(reference)) return true; // already brought back once this visit
    unfinishedOffered.add(reference);
    App.Pages.Customer.resumeUnfinishedCheckout(); // the checkout's own card explains what to do
    return true;
  }

  // "Continue payment": if Paystack has it as unpaid, reopen the SAME
  // Paystack payment (so there's never a second charge); if it turns out
  // it was paid after all, show the order; if it failed, or the cart has
  // changed since, start a new payment with the saved details.
  App.continueUnfinishedPayment = async function () {
    const u = App.Payments.getUnfinishedCheckout();
    const cust = App.Pages.Customer;
    if (!u) return;
    if (!S.state.cart.length) { App.Payments.clearUnfinishedCheckout(); App.render(); return; }
    if (!navigator.onLine || !S.state.connection.online) { App.Toast.error('You are offline. Connect to the internet to continue your payment.'); return; }
    cust.local.resumingPayment = true; App.render();
    try {
      const res = await App.Payments.verifyReturn(u.reference, 1, 2);
      if (res.ok) { showPaidOrders(res.orderIds || []); return; }
      const sameCart = App.Payments.cartSignature(S.state.cart) === u.cart;
      if (res.pending && sameCart && u.url) {
        App.Payments.savePendingReference(u.reference);
        window.location.href = u.url;
        return;
      }
      if (res.transient) { App.Toast.error("We couldn't reach the server right now. Please try again."); return; }
      // Failed, or the cart changed: a fresh payment with the saved details.
      App.Payments.clearUnfinishedCheckout();
      cust.resumeUnfinishedCheckout();
      cust.local.checkout = Object.assign({}, cust.local.checkout || {}, u.checkout || {}, { placing: false, step: 4 });
      cust.local.resumingPayment = false;
      await cust.placeOrder();
    } finally {
      cust.local.resumingPayment = false;
      App.render();
    }
  };

  App.cancelUnfinishedPayment = function () {
    App.Payments.clearUnfinishedCheckout();
    App.Payments.clearPendingReference();
    stopPaymentWatch();
    App.render();
    App.Toast.info('Payment cancelled. Your cart is still saved.');
  };

  function startPaymentWatch() {
    if (paymentPollTimer) return;
    const tick = () => {
      paymentPollTimer = null;
      const savedAt = App.Payments.pendingReferenceSavedAt();
      if (!App.Payments.getPendingReference() || !savedAt || Date.now() - savedAt > PAYMENT_WATCH_MS) { stopPaymentWatch(); return; }
      if (document.visibilityState === 'visible') checkPendingPayment();
      paymentPollDelay = Math.min(8000, paymentPollDelay + 1000);
      paymentPollTimer = setTimeout(tick, paymentPollDelay);
    };
    paymentPollTimer = setTimeout(tick, paymentPollDelay);
  }
  function stopPaymentWatch() {
    if (paymentPollTimer) clearTimeout(paymentPollTimer);
    paymentPollTimer = null;
    paymentPollDelay = 2000;
    waitingNoticeShown = false;
  }
  App.watchPendingPayment = startPaymentWatch;

  // Coming back to the app (from Paystack's tab/browser, from the home
  // screen, or a back-navigation restoring this page) is exactly when a
  // payment has most likely just finished.
  function onReturnToApp() { if (App.Payments.getPendingReference()) checkPendingPayment(); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onReturnToApp(); });
  window.addEventListener('focus', onReturnToApp);
  window.addEventListener('pageshow', (e) => { if (e.persisted) onReturnToApp(); });
  // Live update (js/store.js orders channel): the webhook just created the
  // order for the payment we're waiting on — confirm without waiting.
  App.onOwnOrderChange = function (row) {
    const ref = App.Payments.getPendingReference();
    if (row && ref && row.payment_reference === ref) checkPendingPayment();
  };

  // On load: Paystack's redirect back here (?reference=), or a payment
  // saved earlier that hasn't reached a final answer yet.
  async function handlePaystackReturn() {
    const fromUrl = App.Payments.pendingReferenceFromUrl();
    if (fromUrl) {
      App.Payments.savePendingReference(fromUrl);
      App.Payments.clearReferenceFromUrl();
    }
    if (!App.Payments.getPendingReference()) return;
    if (!S.state.profile) {
      // Paystack sent the student back to a browser where they aren't
      // signed in (typically: the installed app opened Paystack in a
      // separate browser). This page can't check the payment — but the
      // app window they started from can, and will, on its own.
      if (fromUrl) {
        App.Modal.open(`
          <div class="modal-body" style="text-align:center;padding:32px 24px 26px;">
            <h2 style="font-size:18px;font-weight:800;margin-bottom:8px;">Payment submitted</h2>
            <p class="text-muted" style="font-size:14.5px;line-height:1.5;margin-bottom:18px;">Go back to the clickFud app to see your order — it confirms automatically once Paystack approves the payment. You can close this page.</p>
            <button type="button" class="btn btn-primary btn-block" data-action="close-modal">OK</button>
          </div>`);
      }
      return;
    }
    await checkPendingPayment({ interactive: !!fromUrl });
  }

  // ---------------- Boot ----------------
  // Registered on every visit (not only once push is enabled, as before)
  // so the app shell gets cached for offline use — same single sw.js,
  // same '/' scope, so push keeps working exactly as it did.
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((e) => console.error('Service worker registration failed', e));
    });
  }

  // Back online (a real Supabase round trip succeeded — see
  // js/connectivity.js): replace every saved/offline copy with live data.
  App.Connectivity.onReconnect(async () => {
    await App.Bootstrap.loadPublicData();
    await App.Auth.refreshAfterReconnect();
    if (S.state.profile) await App.Bootstrap.loadPrivateData();
    // A Paystack return that couldn't be verified while offline is
    // retried now rather than waiting for the next app open.
    await handlePaystackReturn();
  });

  function boot() {
    parseAuthCallback();
    parseSharedStoreLink();
    App.TimetableShare.parseLink();
    parseNotificationRoute();
    S.loadTheme();
    S.subscribe(onStateChange);
    App.Connectivity.init();
    registerServiceWorker();
    App.render();
    App.Nav.init();
    App.Bootstrap.loadPublicData();
    // The Paystack check must run even if restoring the login throws —
    // a failure there used to silently skip it (see js/auth.js
    // applySignedInSession). And a payment saved before leaving for
    // Paystack is watched from the start, as a second safety net.
    App.Auth.restoreSession()
      .catch((e) => console.error('restoreSession failed', e))
      .then(handlePaystackReturn)
      .catch((e) => console.error('handlePaystackReturn failed', e));
    if (App.Payments.getPendingReference()) startPaymentWatch();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
