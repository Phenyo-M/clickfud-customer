/* ============================================================
   CLICKFOOD, back-button navigation (History API)

   Every screen change (route.view/params, or entering/leaving the
   login/signup form) is pushed as a history entry so the phone's back
   button steps back through the app's own screens instead of leaving
   the page. The entry created the moment a user logs in is "idx 0" —
   pressing back once the stack is exhausted from there sends a logged-
   in student to Home (never a logout prompt: logging out only ever
   happens from the explicit Logout button in More, see js/app.js
   confirmLogout(), an earlier version of this file also asked to log
   out here, which is exactly the "pressing back logs me out" behaviour
   this was changed to stop). Already on Home, or logged out: nothing
   useful left in our own stack, so real browser back-button behavior
   (e.g. exiting the app) takes over, same as any normal app's root
   screen.
   ============================================================ */
window.App = window.App || {};

App.Nav = (function () {
  const S = App.Store;
  let idx = 0;
  let restoring = false;
  let lastSig = null;
  // the screen before this one (for "came from More" and the back arrow)
  let prevSig = null;

  // ---- Same screen after a refresh ----
  // The screen you're on is kept for this browser tab (sessionStorage survives
  // a refresh, not closing the tab). After a refresh, once you're signed back
  // in, the app opens that same screen instead of the start page. It is not
  // used when the page was opened from a link (a shop, a notification, a
  // PayFast return…), and it is cleared when you log out.
  const SAVED_KEY = 'cf_screen_v1';
  const OPENED_FROM_LINK = /[?&#](store|view|group|list|tt|reference|trxref|code|token_hash|access_token|type|error)=/.test(location.search + location.hash);
  let pending = null;
  let startedAt = 0;
  function saveScreen(sig) { try { sessionStorage.setItem(SAVED_KEY, JSON.stringify(sig)); } catch (e) {} }
  function readScreen() { try { return JSON.parse(sessionStorage.getItem(SAVED_KEY) || 'null'); } catch (e) { return null; } }
  function clearScreen() { try { sessionStorage.removeItem(SAVED_KEY); } catch (e) {} }

  function currentSignature() {
    const loggedIn = !!(S.state.session && S.state.profile);
    return {
      loggedIn,
      role: loggedIn ? S.state.profile.role : null,
      forceAuthView: !!S.state.forceAuthView,
      view: S.state.route.view,
      params: S.state.route.params || {},
      routeRole: S.state.route.role || null,
      userId: loggedIn ? S.state.profile.id : null,
    };
  }

  function sameSignature(a, b) {
    if (!a || !b) return false;
    return a.loggedIn === b.loggedIn && a.role === b.role && a.forceAuthView === b.forceAuthView &&
      a.view === b.view && JSON.stringify(a.params) === JSON.stringify(b.params);
  }

  function applySignature(sig) {
    restoring = true;
    S.set({ forceAuthView: sig.forceAuthView });
    S.setRoute(sig.routeRole ? { role: sig.routeRole, view: sig.view, params: sig.params } : { view: sig.view, params: sig.params });
    restoring = false;
  }

  // Call after every render to notice real screen changes (ignores
  // realtime-driven re-renders, which don't touch route/forceAuthView).
  function sync() {
    let sig = currentSignature();
    if (sameSignature(sig, lastSig)) return;

    if (restoring) { lastSig = sig; saveScreen(sig); return; }

    const justLoggedIn = sig.loggedIn && (!lastSig || !lastSig.loggedIn);
    const justLoggedOut = !sig.loggedIn && lastSig && lastSig.loggedIn;

    if (justLoggedIn || justLoggedOut) {
      // signed back in right after a refresh, still on the start screen: reopen the saved screen
      if (justLoggedIn && pending && pending.userId === sig.userId && pending.role === sig.role
          && sig.view === pending.startView && Date.now() - startedAt < 60000) {
        applySignature(pending);
        sig = currentSignature();
      }
      pending = null;
      if (justLoggedOut) clearScreen();
      idx = 0;
      history.replaceState({ idx, sig }, '', location.href);
    } else {
      idx += 1;
      history.pushState({ idx, sig, prev: lastSig }, '', location.href);
    }
    prevSig = justLoggedIn || justLoggedOut ? null : lastSig;
    lastSig = sig;
    if (!justLoggedOut) saveScreen(sig);
  }

  window.addEventListener('popstate', (e) => {
    const state = e.state;
    const loggedIn = !!(S.state.session && S.state.profile);

    if (!state || state.idx <= 0) {
      if (loggedIn && S.state.route.view !== 'home') {
        // Nothing left in this app's own back-stack, but we're deep in
        // some other screen (e.g. Track Order) — go Home instead of
        // prompting to log out. sync() (called automatically after this
        // render, via onStateChange) pushes a fresh "idx 0 = Home" guard
        // entry on its own — nothing else to do here.
        idx = 0;
        S.setRoute({ view: 'home', params: {} });
      }
      return;
    }

    idx = state.idx;
    prevSig = state.prev || null;
    applySignature(state.sig);
    App.render();
  });

  // ---- Back arrow (top left of secondary screens) ----
  // Where a screen goes when there is no earlier in-app screen (opened from
  // a link or after a refresh): its parent, never the login page.
  const PARENT = {
    profile: 'more', favorites: 'more', timetable: 'more', orientation: 'more', legal: 'more', sell: 'more',
    track: 'orders', confirmation: 'orders', 'confirmation-multi': 'orders',
    'group-order': 'groups', 'food-list': 'groups', groups: 'home', campus: 'home', 'campus-directory': 'home',
    store: 'home', checkout: 'home', more: 'home', search: 'home', entrepreneur: 'home',
  };
  function previousView() { return prevSig && prevSig.view; }
  function back(fallback) {
    // history.back() returns to the exact screen (and tab) the person came from
    if (idx > 0 && prevSig && prevSig.loggedIn === !!(S.state.session && S.state.profile)) { history.back(); return; }
    const view = fallback || PARENT[S.state.route.view] || 'home';
    S.setRoute({ view, params: {} });
    window.scrollTo(0, 0);
  }
  function backButton(fallback, extraClass) {
    return `<button type="button" class="page-back ${extraClass || ''}" data-action="nav-back"${fallback ? ` data-fallback="${fallback}"` : ''} aria-label="Back"><i data-lucide="arrow-left"></i></button>`;
  }
  // title row: back arrow + page title
  function pageHead(title, fallback, right) {
    return `<div class="page-head">${backButton(fallback)}<h1 class="page-title">${title}</h1>${right ? `<div class="page-head-right">${right}</div>` : ''}</div>`;
  }

  function init() {
    startedAt = Date.now();
    const saved = OPENED_FROM_LINK ? null : readScreen();
    const start = currentSignature();
    if (saved && saved.view) {
      if (saved.loggedIn) pending = Object.assign({}, saved, { startView: start.view });
      else if (!start.loggedIn && (saved.view !== start.view || saved.forceAuthView !== start.forceAuthView)) applySignature(saved);
    }
    lastSig = currentSignature();
    history.replaceState({ idx: 0, sig: lastSig }, '', location.href);
  }

  return { init, sync, back, backButton, pageHead, previousView };
})();
