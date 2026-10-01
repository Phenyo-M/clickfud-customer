/* ============================================================
   CLICKFUD — defensive fallback only. js/auth.js applySignedInSession()
   now rejects a non-customer account before it ever reaches app state
   (password login, Google sign-in, and restoring an already-persisted
   session all go through that one guarded function) — this screen
   should therefore never actually be reachable any more. Kept as a
   last-resort safety net in case some future code path ever sets a
   profile without going through that guard, which is why its own
   message is deliberately as generic as the login rejection itself:
   never naming another app/URL, since a stray non-customer account
   reaching here at all would be exactly the same information leak this
   whole guard exists to prevent.
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.WrongApp = (function () {
  function render() {
    return `
    <div class="auth-wrap">
      <div class="card auth-card" style="text-align:center;">
        <div class="flex items-center mb-4" style="justify-content:center;">
          ${App.Shared.ClickFudLogo({ size: 'md', bg: 'white', wordmark: true })}
        </div>
        <h2 class="section-title mb-2">Unable to sign in</h2>
        <p class="text-sm text-muted mb-4">This account can't be used here.</p>
        <button class="btn btn-secondary btn-block" data-action="logout">Log Out</button>
      </div>
    </div>`;
  }
  return { render };
})();
