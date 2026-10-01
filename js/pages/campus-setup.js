/* ============================================================
   CLICKFUD — "Where do you study?" (mandatory campus setup)

   Shown instead of the whole app to any signed-in student whose profile
   has no university or no campus yet (App.Auth.needsCampusSetup) — most
   often a Google sign-up, which never sees the signup form's own
   university/campus fields. js/app.js mainContent() routes here; there is
   no way into the rest of the app until this is saved.

   University and at least one campus are required (a student can tick
   several); residence is optional. The campuses chosen here drive which
   shops appear first on the home page (js/pages/home.js campusRank).
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.CampusSetup = (function () {
  const S = App.Store;
  const U = App.Utils;
  const GROUP = 'campus-setup';
  const local = { saving: false, residence: null, university: null, studentNumber: '', password: '', passwordConfirm: '' };

  // Same look as the sign-up form's password fields (eye button included).
  function passwordField(id, label, kind, value) {
    return `
          <div class="field">
            <label for="${id}">${label} <span class="required-mark">*</span></label>
            <div class="input-group">
              <input class="input" type="password" id="${id}" value="${U.escapeHtml(value)}" autocomplete="new-password" style="border:none;" data-action-input="${kind}" />
              <button type="button" class="input-group-btn" data-action="toggle-password" data-target="${id}" aria-label="Show password"><i data-lucide="eye" style="width:18px;height:18px;"></i></button>
            </div>
          </div>`;
  }

  function render() {
    const p = S.state.profile || {};
    const universities = App.CONST.UNIVERSITIES;
    if (local.university === null) local.university = p.university || universities[0];
    if (local.residence === null) local.residence = (p.default_location && p.default_location.residence) || '';
    const firstName = (p.name || '').split(' ')[0];
    return `
    <div class="auth-wrap">
      <div class="card auth-card campus-setup-card">
        <div class="flex items-center mb-3" style="justify-content:center;">
          ${App.Shared.ClickFudLogo({ size: 'sm', bg: 'white', wordmark: true })}
        </div>
        <h1 class="campus-setup-title">${firstName ? `Welcome, ${U.escapeHtml(firstName)}!` : 'Welcome!'}</h1>
        <p class="text-sm text-muted mb-4" style="text-align:center;">Tell us where you study so we can show you the food shops on your campus first.</p>
        <form data-form="campus-setup-form" novalidate>
          <div class="field">
            <label for="cs-university">University <span class="required-mark">*</span></label>
            <select class="select" id="cs-university" name="university" data-action-change="campus-setup-university" required>
              ${universities.map(u => `<option value="${U.escapeHtml(u)}" ${local.university === u ? 'selected' : ''}>${U.escapeHtml(u)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Which campus(es) do you attend? <span class="required-mark">*</span></label>
            <div class="text-xs text-muted mb-2">Tick every campus you attend.</div>
            ${App.Shared.campusCheckboxes({ group: GROUP, university: local.university, initial: App.Auth.campusesOf(p) })}
          </div>
          ${App.Auth.needsStudentNumber(p) ? `
          <div class="field">
            <label for="cs-student-number">Student Number <span class="required-mark">*</span></label>
            <input class="input" id="cs-student-number" name="student_number" value="${U.escapeHtml(local.studentNumber)}" placeholder="Enter your student number" maxlength="12" autocomplete="off" data-action-input="campus-setup-student-number" />
          </div>` : ''}
          ${App.Auth.needsPassword(p) ? `
          <div class="text-sm mb-2" style="font-weight:600;">Create a password</div>
          <div class="text-xs text-muted mb-2">So you can also log in with your UP student email and this password next time, not only with Google.</div>
          ${passwordField('cs-password', 'Password', 'campus-setup-password', local.password)}
          ${passwordField('cs-password-confirm', 'Confirm Password', 'campus-setup-password-confirm', local.passwordConfirm)}` : ''}
          <div class="field">
            <label for="cs-residence">Residence <span class="text-muted" style="font-weight:400;">(optional)</span></label>
            <input class="input" id="cs-residence" name="residence" value="${U.escapeHtml(local.residence)}" placeholder="e.g. Tuks Village" maxlength="80" data-action-input="campus-setup-residence" />
          </div>
          <button type="submit" class="btn btn-primary btn-block btn-lg ${local.saving ? 'btn-loading' : ''}">Continue</button>
        </form>
        <button type="button" class="btn btn-ghost btn-block btn-sm mt-2" data-action="logout">Log out</button>
      </div>
    </div>`;
  }

  async function save() {
    if (local.saving) return;
    const campuses = App.Shared.selectedCampuses(GROUP);
    if (!local.university) { App.Toast.error('Please choose your university.'); return; }
    if (!campuses.length) { App.Toast.error('Please tick at least one campus you attend.'); return; }
    const askStudentNumber = App.Auth.needsStudentNumber(S.state.profile);
    if (askStudentNumber && !U.normalizeStudentNumber(local.studentNumber)) { App.Toast.error('Please enter your UP student number (8 digits, e.g. u12345678).'); return; }
    const askPassword = App.Auth.needsPassword(S.state.profile);
    if (askPassword) {
      const issues = U.validatePassword(local.password);
      if (issues.length) { App.Toast.error('Password needs: ' + issues.join(', ')); return; }
      if (local.password !== local.passwordConfirm) { App.Toast.error('The two passwords do not match.'); return; }
    }
    if (!S.state.connection.online) { App.Toast.error('You are offline. Connect to the internet to save your campus.'); return; }
    local.saving = true; App.render();
    // Password first: if it fails nothing else is saved and they just retry.
    if (askPassword) {
      const pw = await App.Auth.createPassword(local.password);
      if (pw.error) { local.saving = false; App.Toast.error(pw.error); App.render(); return; }
      local.password = ''; local.passwordConfirm = '';
    }
    const p = S.state.profile;
    const residence = U.sanitizeText(local.residence || '', 80);
    const res = await App.Auth.updateProfile({
      university: local.university,
      campuses,
      default_location: Object.assign({}, p.default_location || {}, { residence }),
      ...(askStudentNumber ? { student_number: local.studentNumber } : {}),
    });
    local.saving = false;
    if (res.error) { App.Toast.error(res.error); App.render(); return; }
    App.Shared.resetCampusSelection(GROUP);
    local.residence = null; local.university = null; local.studentNumber = ''; local.password = ''; local.passwordConfirm = '';
    S.rescopeStoresRealtime(res.data.university);
    S.setRoute({ view: 'home', params: {} });
    App.Toast.success(`You're all set! Showing shops at ${App.Auth.campusesOf(res.data).join(', ')} first.`);
  }

  function handleInput(kind, value) {
    if (kind === 'campus-setup-residence') local.residence = value;
    if (kind === 'campus-setup-student-number') local.studentNumber = value;
    if (kind === 'campus-setup-password') local.password = value;
    if (kind === 'campus-setup-password-confirm') local.passwordConfirm = value;
  }
  function handleChange(kind, ds, value) {
    if (kind === 'campus-setup-university' && value !== local.university) {
      local.university = value;
      App.Shared.resetCampusSelection(GROUP); // a different university has different campuses
      App.render();
    }
  }
  function handleSubmit(formId) {
    if (formId === 'campus-setup-form') save();
  }
  function handleAction(action, ds, el) {
    if (action === 'toggle-password') App.Pages.Auth.handleAction(action, ds, el);
  }

  return { render, handleAction, handleInput, handleChange, handleSubmit };
})();
