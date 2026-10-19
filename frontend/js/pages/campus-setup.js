/* ============================================================
   CLICKFOOD, first sign-in setup: "Are you a student?" (+ university and
   campus), a password for Google sign-ups, then "Where do you stay?".
   The older "Where do you study?" form below only shows for old profiles.

   Shown instead of the whole app to any signed-in student whose profile
   has no university or no campus yet (App.Auth.needsCampusSetup), most
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
  const local = { saving: false, residence: null, university: null, password: '', passwordConfirm: '', student: null, uniId: null, campusId: null };

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

  // ---- Step 2: home address on a map (App.Auth.needsAddress) ----
  const addr = { text: null, pin: null, saving: false };

  function renderAddress() {
    const p = S.state.profile || {};
    if (addr.text === null) addr.text = p.home_address || (p.default_location && p.default_location.residence) || '';
    if (!addr.pin && p.home_lat != null) addr.pin = { lat: p.home_lat, lng: p.home_lng };
    App.MapPicker.ensure('addr-map', addr.pin, (pin, info) => { addr.pin = pin; const t = App.MapPicker.fillIfEmpty('as-address', info); if (t) addr.text = t; });
    return `
    <div class="auth-wrap">
      <div class="card auth-card campus-setup-card">
        <div class="flex items-center mb-3" style="justify-content:center;">
          ${App.Shared.ClickFoodLogo({ size: 'sm', bg: 'white', wordmark: true })}
        </div>
        <h1 class="campus-setup-title">${p.is_student ? 'Where do you stay while at university?' : 'Where do you stay?'}</h1>
        <p class="text-sm text-muted mb-3" style="text-align:center;">${campusLimitText(p) || 'We show the food closest to you first.'}</p>
        <form data-form="address-setup-form" novalidate>
          <div class="field">
            <label for="as-address">Your address <span class="required-mark">*</span></label>
            <input class="input" id="as-address" value="${U.escapeHtml(addr.text)}" placeholder="e.g. 12 Main Road, Hatfield" maxlength="160" autocomplete="street-address" data-action-input="address-setup-text" />
          </div>
          <div class="field">
            <label>Pin on the map <span class="required-mark">*</span></label>
            <div id="addr-map" class="map-picker" data-hero-key="map"></div>
          </div>
          <button type="submit" class="btn btn-primary btn-block btn-lg ${addr.saving ? 'btn-loading' : ''}">Save address</button>
        </form>
        <button type="button" class="btn btn-ghost btn-block btn-sm mt-2" data-action="logout">Log out</button>
      </div>
    </div>`;
  }

  // students: the saved location must be within the ordering distance of their campus (when the campus has a pin)
  function campusLimitText(p) {
    const c = p && p.is_student ? App.Discovery.myCampus() : null;
    return c && App.Discovery.campusPin(c) ? `Choose a place within ${App.Stores.maxOrderKm()} km of ${c.full_name}. You can still use it when you're away from campus.` : '';
  }
  function campusProblem(p, pin) {
    const c = p && p.is_student ? App.Discovery.myCampus() : null;
    const cp = App.Discovery.campusPin(c);
    if (!cp || !pin) return null;
    const km = Math.round(App.MapPicker.distanceKm(cp, pin) * 1000) / 1000;
    return km > App.Stores.maxOrderKm() ? `That place is ${km.toFixed(1)} km from ${c.full_name}. Choose a place within ${App.Stores.maxOrderKm()} km of your campus.` : null;
  }

  async function saveAddress() {
    if (addr.saving) return;
    const text = U.sanitizeText(addr.text || '', 160);
    if (text.length < 5) return App.Toast.error('Please enter your address.');
    if (!addr.pin) return App.Toast.error('Please put your address on the map.');
    const far = campusProblem(S.state.profile, addr.pin);
    if (far) return App.Toast.error(far);
    if (!S.state.connection.online) return App.Toast.error('You are offline. Connect to the internet to save your address.');
    addr.saving = true; App.render();
    const p = S.state.profile;
    const res = await App.Auth.updateProfile({
      home_address: text, home_lat: addr.pin.lat, home_lng: addr.pin.lng,
      default_location: Object.assign({}, p.default_location || {}, { residence: text }),
    });
    addr.saving = false;
    if (res.error) { App.Toast.error(res.error); App.render(); return; }
    addr.text = null; addr.pin = null;
    // A new seller has already been sent to their shop setup (js/app.js syncSeller).
    if (S.state.route.view !== 'sell') S.setRoute({ view: 'home', params: {} });
    App.Toast.success('Address saved');
  }

  // ---- Step 1: student or not (2026-10-17) ----
  function renderStudent() {
    const p = S.state.profile || {};
    const unis = App.Discovery.selectableUniversities();
    if (!App.Discovery.universities().length) App.Discovery.loadUniversities().then(() => App.render());
    if (local.student === null && p.is_student !== null && p.is_student !== undefined) local.student = p.is_student ? 'yes' : 'no';
    const camps = App.Discovery.campuses().filter(c => c.university_id === local.uniId);
    const firstName = (p.name || '').split(' ')[0];
    return `
    <div class="auth-wrap">
      <div class="card auth-card campus-setup-card">
        <div class="flex items-center mb-3" style="justify-content:center;">${App.Shared.ClickFoodLogo({ size: 'sm', bg: 'white', wordmark: true })}</div>
        <h1 class="campus-setup-title">${firstName ? `Welcome, ${U.escapeHtml(firstName)}!` : 'Welcome!'}</h1>
        <form data-form="student-setup-form" novalidate>
          <div class="field"><label>Are you a student?</label>
            <div class="student-choice">
              <button type="button" class="student-opt ${local.student === 'yes' ? 'active' : ''}" data-action="student-setup-pick" data-v="yes"><i data-lucide="graduation-cap"></i><span>Yes, I am a student</span></button>
              <button type="button" class="student-opt ${local.student === 'no' ? 'active' : ''}" data-action="student-setup-pick" data-v="no"><i data-lucide="user"></i><span>No, I am not a student</span></button>
            </div>
          </div>
          ${local.student === 'yes' ? `
          <div class="field"><label for="ss-uni">University or college <span class="required-mark">*</span></label>
            <select class="select" id="ss-uni" data-action-change="student-setup-uni"><option value="">Choose your institution</option>${unis.map(u => `<option value="${U.escapeHtml(u.id)}" ${local.uniId === u.id ? 'selected' : ''}>${U.escapeHtml(u.name)}</option>`).join('')}</select></div>
          ${camps.length ? `<div class="field"><label for="ss-campus">Campus <span class="required-mark">*</span></label>
            <select class="select" id="ss-campus" data-action-change="student-setup-campus"><option value="">Choose your campus</option>${camps.map(c => `<option value="${U.escapeHtml(c.id)}" ${local.campusId === c.id ? 'selected' : ''}>${U.escapeHtml(c.full_name)}</option>`).join('')}</select>
            ${camps.some(c => c.latitude != null) ? `<button type="button" class="btn btn-ghost btn-sm mt-2 ${local.suggesting ? 'btn-loading' : ''}" data-action="student-setup-suggest"><i data-lucide="locate"></i>Suggest my campus</button>` : ''}
            ${local.suggestNote ? `<div class="text-xs mt-1 ${local.suggestOk ? 'text-muted' : ''}" id="ss-suggest-note">${U.escapeHtml(local.suggestNote)}</div>` : ''}</div>` : ''}` : ''}
          ${App.Auth.needsPassword(p) ? `
          <div class="text-sm mb-2" style="font-weight:600;">Create a password</div>
          ${passwordField('cs-password', 'Password', 'campus-setup-password', local.password)}
          ${passwordField('cs-password-confirm', 'Confirm Password', 'campus-setup-password-confirm', local.passwordConfirm)}` : ''}
          <button type="submit" class="btn btn-primary btn-block btn-lg ${local.saving ? 'btn-loading' : ''}" ${local.student ? '' : 'disabled'}>Continue</button>
        </form>
        <button type="button" class="btn btn-ghost btn-block btn-sm mt-2" data-action="logout">Log out</button>
      </div>
    </div>`;
  }
  async function saveStudent() {
    if (local.saving || !local.student) return;
    const isStu = local.student === 'yes';
    if (isStu && !local.uniId) return App.Toast.error('Please choose your institution.');
    const camps = App.Discovery.campuses().filter(c => c.university_id === local.uniId);
    if (isStu && camps.length && !local.campusId) return App.Toast.error('Please choose your campus.');
    const askPassword = App.Auth.needsPassword(S.state.profile);
    if (askPassword) {
      const issues = U.validatePassword(local.password);
      if (issues.length) return App.Toast.error('Password needs: ' + issues.join(', '));
      if (local.password !== local.passwordConfirm) return App.Toast.error('The two passwords do not match.');
    }
    if (!S.state.connection.online) return App.Toast.error('You are offline. Connect to the internet and try again.');
    local.saving = true; App.render();
    if (askPassword) {
      const pw = await App.Auth.createPassword(local.password);
      if (pw.error) { local.saving = false; App.Toast.error(pw.error); return App.render(); }
      local.password = ''; local.passwordConfirm = '';
    }
    const { data: r, error } = await App.sb.rpc('set_my_student_status', { p_is_student: isStu, p_university: isStu ? local.uniId : null, p_campus: isStu ? (local.campusId || null) : null });
    local.saving = false;
    if (error || !r || !r.ok) { App.Toast.error((r && r.error) || 'Could not save. Please try again.'); return App.render(); }
    if (r.needs_location && r.message) App.Toast.info(r.message);
    const fresh = await App.Auth.fetchProfile(S.state.profile.id);
    if (fresh) S.set({ profile: fresh });
    // which shops (and their menus and deals) this account may see depends on
    // its student status and university, so load them again for the new answer
    App.Discovery.invalidate();
    App.Bootstrap.loadPublicData().then(() => App.Discovery.load(true)).then(() => App.render());
    if (fresh && App.Auth.needsAddress(fresh)) return App.render();   // next: where do you stay?
    S.setRoute({ view: 'home', params: {} });
  }

  // one location reading, only when the student asks; the choice stays theirs
  async function suggestCampus() {
    if (local.suggesting || !local.uniId) return;
    local.suggesting = true; local.suggestNote = ''; App.render();
    const pos = await App.Discovery.locateOnce();
    local.suggesting = false;
    if (pos.error) {
      local.suggestOk = false;
      local.suggestNote = pos.error === 'denied' ? 'Location is off. Please choose your campus.' : "We couldn't get your location. Please choose your campus.";
      return App.render();
    }
    const best = App.Discovery.suggestCampus(local.uniId, pos, 5);
    if (best) { local.campusId = best.campus.id; local.suggestOk = true; local.suggestNote = `Suggested: ${best.campus.full_name} (${best.km.toFixed(1)} km away). You can choose another one.`; }
    else { local.suggestOk = false; local.suggestNote = "We couldn't find a campus near you. Please choose your campus."; }
    App.render();
  }

  function render() {
    const p = S.state.profile || {};
    if (p.is_student === null || (App.Auth.needsPassword(p) && p.is_student !== undefined)) return renderStudent();
    if (!App.Auth.needsCampusDetails(p)) return renderAddress();
    const own = U.universityOfEmail(p.email);
    const universities = own ? [own] : App.CONST.UNIVERSITIES;
    if (local.university === null) local.university = own || p.university || universities[0];
    if (local.residence === null) local.residence = (p.default_location && p.default_location.residence) || '';
    const firstName = (p.name || '').split(' ')[0];
    return `
    <div class="auth-wrap">
      <div class="card auth-card campus-setup-card">
        <div class="flex items-center mb-3" style="justify-content:center;">
          ${App.Shared.ClickFoodLogo({ size: 'sm', bg: 'white', wordmark: true })}
        </div>
        <h1 class="campus-setup-title">${firstName ? `Welcome, ${U.escapeHtml(firstName)}!` : 'Welcome!'}</h1>
        <p class="text-sm text-muted mb-4" style="text-align:center;">Where do you study?</p>
        <form data-form="campus-setup-form" novalidate>
          <div class="field">
            <label for="cs-university">University <span class="required-mark">*</span></label>
            <select class="select" id="cs-university" name="university" data-action-change="campus-setup-university" required>
              ${universities.map(u => `<option value="${U.escapeHtml(u)}" ${local.university === u ? 'selected' : ''}>${U.escapeHtml(u)}</option>`).join('')}
            </select>
          </div>
          <div class="field" ${App.Auth.hasCampusList(local.university) ? '' : 'hidden'}>
            <label>Which campus(es) do you attend? <span class="required-mark">*</span></label>
            <div class="text-xs text-muted mb-2">Tick every campus you attend.</div>
            ${App.Shared.campusCheckboxes({ group: GROUP, university: local.university, initial: App.Auth.campusesOf(p) })}
          </div>
          ${App.Auth.needsPassword(p) ? `
          <div class="text-sm mb-2" style="font-weight:600;">Create a password</div>
          ${passwordField('cs-password', 'Password', 'campus-setup-password', local.password)}
          ${passwordField('cs-password-confirm', 'Confirm Password', 'campus-setup-password-confirm', local.passwordConfirm)}` : ''}
          <button type="submit" class="btn btn-primary btn-block btn-lg ${local.saving ? 'btn-loading' : ''}">Continue</button>
        </form>
        <button type="button" class="btn btn-ghost btn-block btn-sm mt-2" data-action="logout">Log out</button>
      </div>
    </div>`;
  }

  async function save() {
    if (local.saving) return;
    const campuses = App.Shared.selectedCampuses(GROUP);
    if (!local.university) { App.Toast.error('Please choose your institution.'); return; }
    if (!campuses.length && App.Auth.hasCampusList(local.university)) { App.Toast.error('Please tick at least one campus you attend.'); return; }
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
    const res = await App.Auth.updateProfile({
      university: local.university,
      campuses,
    });
    local.saving = false;
    if (res.error) { App.Toast.error(res.error); App.render(); return; }
    App.Shared.resetCampusSelection(GROUP);
    local.residence = null; local.university = null; local.password = ''; local.passwordConfirm = '';
    S.rescopeStoresRealtime(res.data.university);
    if (App.Auth.needsAddress(res.data)) return App.render(); // next: where do you stay?
    S.setRoute({ view: 'home', params: {} });
    App.Toast.success(`You're all set! Showing shops at ${App.Auth.campusesOf(res.data).join(', ')} first.`);
  }

  function handleInput(kind, value) {
    if (kind === 'campus-setup-residence') local.residence = value;
    if (kind === 'address-setup-text') addr.text = value;
    if (kind === 'campus-setup-password') local.password = value;
    if (kind === 'campus-setup-password-confirm') local.passwordConfirm = value;
  }
  function handleChange(kind, ds, value) {
    if (kind === 'student-setup-uni') { local.uniId = value || null; local.campusId = null; return App.render(); }
    if (kind === 'student-setup-campus') { local.campusId = value || null; return; }
    if (kind === 'campus-setup-university' && value !== local.university) {
      local.university = value;
      App.Shared.resetCampusSelection(GROUP); // a different university has different campuses
      App.render();
    }
  }
  function handleSubmit(formId) {
    if (formId === 'student-setup-form') return saveStudent();
    if (formId === 'campus-setup-form') save();
    if (formId === 'address-setup-form') saveAddress();
  }
  function handleAction(action, ds, el) {
    if (action === 'student-setup-pick') { local.student = ds.v; return App.render(); }
    if (action === 'student-setup-suggest') return suggestCampus();
    if (action === 'toggle-password') App.Pages.Auth.handleAction(action, ds, el);
  }

  return { render, handleAction, handleInput, handleChange, handleSubmit };
})();
