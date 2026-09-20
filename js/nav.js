/* ============================================================
   CLICKFUD — back-button navigation (History API) + logout guard

   Every screen change (route.view/params, or entering/leaving the
   login/signup form) is pushed as a history entry so the phone's back
   button steps back through the app's own screens instead of leaving
   the page. The entry created the moment a user logs in is treated as
   "idx 0" — pressing back from there asks to log out instead of
   exiting, and only while logged in; logged-out browsing falls through
   to normal browser back-button behavior once our stack is exhausted.
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

  function showLogoutConfirm() {
    App.Modal.confirm({
      title: 'Log out?',
      message: 'Are you sure you want to log out?',
      confirmLabel: 'Yes',
      cancelLabel: 'No',
      onConfirm: async () => {
        await App.doLogout();
        idx = 0;
        lastSig = currentSignature();
        history.replaceState({ idx, sig: lastSig }, '', location.href);
      },
      // Cancel (or dismiss via overlay/Escape): nothing changes — the guard
      // entry below has already been re-pushed, so the screen stays put.
    });
  }

  window.addEventListener('popstate', (e) => {
    const state = e.state;
    const loggedIn = !!(S.state.session && S.state.profile);

    if (!state || state.idx <= 0) {
      if (loggedIn) {
        // Swallow this back-press: re-plant the guard entry so cancelling
        // leaves the user exactly where they were, then ask to log out.
        idx = 0;
        history.pushState({ idx, sig: lastSig }, '', location.href);
        showLogoutConfirm();
      }
      // Logged out: nothing left in our stack — let the browser's own
      // back behavior take over (it has already navigated by this point).
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
