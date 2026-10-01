/* ============================================================
   CLICKFUD — back-button navigation (History API)

   Every screen change (route.view/params, or entering/leaving the
   login/signup form) is pushed as a history entry so the phone's back
   button steps back through the app's own screens instead of leaving
   the page. The entry created the moment a user logs in is "idx 0" —
   pressing back once the stack is exhausted from there sends a logged-
   in student to Home (never a logout prompt: logging out only ever
   happens from the explicit Logout button in More, see js/app.js
   confirmLogout() — an earlier version of this file also asked to log
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

  function currentSignature() {
    const loggedIn = !!(S.state.session && S.state.profile);
    return {
      loggedIn,
      role: loggedIn ? S.state.profile.role : null,
      forceAuthView: !!S.state.forceAuthView,
      view: S.state.route.view,
      params: S.state.route.params || {},
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
    S.setRoute({ view: sig.view, params: sig.params });
    restoring = false;
  }

  // Call after every render to notice real screen changes (ignores
  // realtime-driven re-renders, which don't touch route/forceAuthView).
  function sync() {
    const sig = currentSignature();
    if (sameSignature(sig, lastSig)) return;

    if (restoring) { lastSig = sig; return; }

    const justLoggedIn = sig.loggedIn && (!lastSig || !lastSig.loggedIn);
    const justLoggedOut = !sig.loggedIn && lastSig && lastSig.loggedIn;

    if (justLoggedIn || justLoggedOut) {
      idx = 0;
      history.replaceState({ idx, sig }, '', location.href);
    } else {
      idx += 1;
      history.pushState({ idx, sig }, '', location.href);
    }
    lastSig = sig;
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
    applySignature(state.sig);
    App.render();
  });

  function init() {
    lastSig = currentSignature();
    history.replaceState({ idx: 0, sig: lastSig }, '', location.href);
  }

  return { init, sync };
})();
