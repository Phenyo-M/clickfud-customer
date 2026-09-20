/* ============================================================
   CLICKFUD — shown when a staff or developer account logs in
   here instead of its own app.
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.WrongApp = (function () {
  function render() {
    const S = App.Store;
    const role = S.state.profile ? S.state.profile.role : null;
    const isDeveloper = role === 'developer';
    const url = isDeveloper ? App.CONFIG.DEVELOPER_APP_URL : App.CONFIG.STAFF_APP_URL;
    const dest = isDeveloper ? 'the clickFud Developer app' : 'the clickFud Staff app';
    return `
    <div class="auth-wrap">
      <div class="card auth-card" style="text-align:center;">
        <div class="flex items-center mb-4" style="justify-content:center;">
          ${App.Shared.CampusEatsLogo({ size: 'md', bg: 'white', wordmark: true })}
        </div>
        <h2 class="section-title mb-2">Wrong app for this account</h2>
        <p class="text-sm text-muted mb-4">
          This account signs in on ${dest}${url ? `, at <strong>${App.Utils.escapeHtml(url)}</strong>` : ''}, not here.
        </p>
        <button class="btn btn-secondary btn-block" data-action="logout">Log Out</button>
      </div>
    </div>`;
  }
  return { render };
})();
