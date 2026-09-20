/* ============================================================
   CLICKFUD — Login / Sign Up / Forgot Password
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Auth = (function () {
  const U = App.Utils;
  const local = { tab: 'login', showForgot: false, error: null, loading: false, passwordIssues: null, passwordTouched: false, confirmError: null, confirmTouched: false };

  function setTab(tab) { clearLockoutInterval(); local.tab = tab; local.showForgot = false; local.error = null; local.passwordTouched = false; local.passwordIssues = null; local.confirmTouched = false; local.confirmError = null; App.render(); }
  function toggleForgot() { clearLockoutInterval(); local.showForgot = !local.showForgot; local.error = null; App.render(); }

  // Counts down a submit-blocking wait, updating the error banner text in
  // place (not via App.render(), which would wipe whatever the user typed
  // into the other fields). Two very different cases use this:
  //  - login-form: untilTs is a REAL timestamp from our own secure-login
  //    Edge Function (5 attempts / 15-minute lockout it enforces itself),
  //    so the countdown is server-accurate.
  //  - signup-form / forgot-form: Supabase's own auth rate limit has no
  //    timestamp or Retry-After header available at all (confirmed against
  //    its actual 429 response), so untilTs there is only an honest guessed
  //    cool-down before we let the user try again — not a promise Supabase
  //    will accept the retry, just a stop to the "click it uselessly over
  //    and over" dead end.
  let lockoutInterval = null;
  function clearLockoutInterval() {
    if (lockoutInterval) { clearInterval(lockoutInterval); lockoutInterval = null; }
  }
  function startLockoutCountdown(formSelector, untilTs, baseMessage) {
    clearLockoutInterval();
    function tick() {
      const remainingMs = untilTs - Date.now();
      const submitBtn = document.querySelector(`${formSelector} button[type="submit"]`);
      if (remainingMs <= 0) {
        clearLockoutInterval();
        local.error = null;
        const banner = document.getElementById('auth-error-banner');
        if (banner) banner.remove();
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
      const totalSec = Math.ceil(remainingMs / 1000);
      const mm = Math.floor(totalSec / 60);
      const ss = String(totalSec % 60).padStart(2, '0');
      local.error = `${baseMessage} ${mm}:${ss}`;
      const bannerText = document.getElementById('auth-error-text');
      if (bannerText) bannerText.textContent = local.error;
      if (submitBtn) submitBtn.disabled = true;
    }
    tick();
    lockoutInterval = setInterval(tick, 1000);
  }

  // A trailing eye/eye-off button inside the input that flips the field
  // between password/text — toggled via direct DOM mutation (togglePassword
  // below), not a re-render, so it doesn't disturb focus or other fields.
  function passwordField(opts) {
    return `
    <div class="field">
      <label for="${opts.id}">${opts.label}</label>
      <div class="input-group">
        <input class="input ${opts.hasError ? 'has-error' : ''}" type="password" id="${opts.id}" name="${opts.name}" required autocomplete="${opts.autocomplete}" style="border:none;" ${opts.dataActionInput ? `data-action-input="${opts.dataActionInput}"` : ''} />
        <button type="button" class="input-group-btn" data-action="toggle-password" data-target="${opts.id}" aria-label="Show password"><i data-lucide="eye" style="width:18px;height:18px;"></i></button>
      </div>
      ${opts.errorHtml || ''}
    </div>`;
  }

  function togglePassword(targetId, btnEl) {
    const input = document.getElementById(targetId);
    if (!input) return;
    const nowShowing = input.type === 'password';
    input.type = nowShowing ? 'text' : 'password';
    if (!btnEl) return;
    const icon = btnEl.querySelector('i');
    if (icon) icon.setAttribute('data-lucide', nowShowing ? 'eye-off' : 'eye');
    btnEl.setAttribute('aria-label', nowShowing ? 'Hide password' : 'Show password');
    if (window.lucide) lucide.createIcons({ context: btnEl.parentElement });
  }

  function render() {
    return `
    <div class="auth-wrap">
      <div class="card auth-card">
        <button type="button" class="btn btn-ghost btn-sm mb-2" data-action="go-home" style="gap:6px;">
          <i data-lucide="arrow-left"></i> Back to browsing
        </button>
        <div class="flex items-center mb-4" style="justify-content:center;">
          ${App.Shared.CampusEatsLogo({ size: 'md', bg: 'white', wordmark: true })}
        </div>
        <div class="auth-tabs">
          <button class="auth-tab ${local.tab === 'login' ? 'active' : ''}" data-action="auth-tab" data-tab="login">Log In</button>
          <button class="auth-tab ${local.tab === 'signup' ? 'active' : ''}" data-action="auth-tab" data-tab="signup">Sign Up</button>
        </div>
        ${local.error ? `<div class="closed-banner" id="auth-error-banner" style="margin-bottom:14px;"><i data-lucide="alert-circle"></i><span id="auth-error-text">${U.escapeHtml(local.error)}</span></div>` : ''}
        ${local.tab === 'login' ? renderLogin() : renderSignup()}
      </div>
    </div>`;
  }

  // Shown instead of everything else the moment a real Supabase
  // PASSWORD_RECOVERY session exists (see js/auth.js restoreSession() and
  // js/app.js mainContent()) — never reachable any other way, so getting
  // here already means Supabase itself verified the reset link.
  function renderResetPassword() {
    return `
    <div class="auth-wrap">
      <div class="card auth-card">
        <div class="flex items-center mb-4" style="justify-content:center;">
          ${App.Shared.CampusEatsLogo({ size: 'md', bg: 'white', wordmark: true })}
        </div>
        <h2 class="section-title mb-1" style="text-align:center;">Create New Password</h2>
        <p class="text-sm text-muted mb-3" style="text-align:center;">Choose a new password for your account.</p>
        ${local.error ? `<div class="closed-banner" style="margin-bottom:14px;"><i data-lucide="alert-circle"></i><span>${U.escapeHtml(local.error)}</span></div>` : ''}
        <form data-form="reset-password-form">
          ${passwordField({
            id: 'rp-password', name: 'password', label: 'New Password', autocomplete: 'new-password',
            hasError: local.passwordTouched && local.passwordIssues && local.passwordIssues.length,
            errorHtml: local.passwordTouched && local.passwordIssues && local.passwordIssues.length
              ? `<div class="field-error">Password needs: ${local.passwordIssues.map(i => U.escapeHtml(i)).join(', ')}</div>` : '',
          })}
          ${passwordField({
            id: 'rp-password-confirm', name: 'password_confirm', label: 'Confirm New Password', autocomplete: 'new-password',
            hasError: local.confirmTouched && local.confirmError,
            errorHtml: local.confirmTouched && local.confirmError ? `<div class="field-error">${U.escapeHtml(local.confirmError)}</div>` : '',
          })}
          <button type="submit" class="btn btn-primary btn-block btn-lg ${local.loading ? 'btn-loading' : ''}">Save New Password</button>
        </form>
      </div>
    </div>`;
  }

  function renderLogin() {
    if (local.showForgot) {
      return `
      <form data-form="forgot-form">
        <p class="text-sm text-muted mb-3">Enter your email and we'll send you a reset link.</p>
        <div class="field"><label for="fp-email">Email</label><input class="input" type="email" id="fp-email" name="email" required autocomplete="email" /></div>
        <button type="submit" class="btn btn-primary btn-block ${local.loading ? 'btn-loading' : ''}">Send Reset Link</button>
        <button type="button" class="btn btn-ghost btn-block mt-2" data-action="toggle-forgot">Back to Log In</button>
      </form>`;
    }
    return `
    <form data-form="login-form">
      <div class="field"><label for="li-email">Email</label><input class="input" type="email" id="li-email" name="email" required autocomplete="email" /></div>
      ${passwordField({ id: 'li-password', name: 'password', label: 'Password', autocomplete: 'current-password' })}
      <button type="submit" class="btn btn-primary btn-block btn-lg ${local.loading ? 'btn-loading' : ''}">Log In</button>
      <button type="button" class="btn btn-ghost btn-block mt-2 text-sm" data-action="toggle-forgot">Forgot password?</button>
    </form>`;
  }

  function renderSignup() {
    return `
    <form data-form="signup-form">
      <div class="field"><label for="su-name">Full Name</label><input class="input" type="text" id="su-name" name="name" required /></div>
      <div class="field"><label for="su-email">Email</label><input class="input" type="email" id="su-email" name="email" required autocomplete="email" /></div>
      <div class="field"><label for="su-phone">Phone</label><input class="input" type="tel" id="su-phone" name="phone" placeholder="071 234 5678" /></div>
      ${passwordField({
        id: 'su-password', name: 'password', label: 'Password', autocomplete: 'new-password',
        dataActionInput: 'signup-password',
        hasError: local.passwordTouched && local.passwordIssues && local.passwordIssues.length,
        errorHtml: local.passwordTouched && local.passwordIssues && local.passwordIssues.length
          ? `<div class="field-error">Password needs: ${local.passwordIssues.map(i => U.escapeHtml(i)).join(', ')}</div>` : '',
      })}
      ${passwordField({
        id: 'su-password-confirm', name: 'password_confirm', label: 'Confirm Password', autocomplete: 'new-password',
        dataActionInput: 'signup-password-confirm',
        hasError: local.confirmTouched && local.confirmError,
        errorHtml: local.confirmTouched && local.confirmError ? `<div class="field-error">${U.escapeHtml(local.confirmError)}</div>` : '',
      })}
      <div class="field" id="university-field">
        <label for="su-university">Which university are you a student at?</label>
        <select class="select" id="su-university" name="university" required>
          ${App.CONST.UNIVERSITIES.map(u => `<option value="${U.escapeHtml(u)}">${U.escapeHtml(u)}</option>`).join('')}
        </select>
      </div>
      <div class="field" id="campus-field">
        <label for="su-campus">Which campus are you at?</label>
        <select class="select" id="su-campus" name="campus_location" required>
          <option value="">Select a campus</option>
          ${(App.CONST.UNIVERSITY_CAMPUSES[App.CONST.UNIVERSITIES[0]] || []).map(c => `<option value="${U.escapeHtml(c)}">${U.escapeHtml(c)}</option>`).join('')}
        </select>
      </div>
      <button type="submit" class="btn btn-primary btn-block btn-lg ${local.loading ? 'btn-loading' : ''}">Create Account</button>
    </form>`;
  }

  // A second 'submit' event firing before the first one's request has
  // resolved — Enter mashed in the password field, a double-click that
  // beats the CSS pointer-events:none from even registering, etc. — used
  // to just fire a second full signIn()/signUp() call. For login that
  // meant one impatient user could burn 2-3 of their 5 allowed attempts
  // off what felt like a single try. This flag makes every concurrent
  // submit while one is already in flight a silent no-op instead.
  let isSubmitting = false;
  async function handleSubmit(formId, data, formEl) {
    if (isSubmitting) return;
    isSubmitting = true;
    try {
      await handleSubmitInner(formId, data, formEl);
    } finally {
      isSubmitting = false;
    }
  }

  async function handleSubmitInner(formId, data, formEl) {
    local.error = null;
    const submitBtn = formEl.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.classList.add('btn-loading');

    if (formId === 'login-form') {
      const res = await App.Auth.signIn(data.get('email'), data.get('password'));
      if (res.error) {
        local.error = res.error; App.render(); App.Toast.error(res.error);
        if (res.lockedUntil) startLockoutCountdown('form[data-form="login-form"]', new Date(res.lockedUntil).getTime(), 'Too many failed attempts. Try again in');
        return;
      }
      App.Toast.success('Welcome back!');
      App.routeToOwnDashboard();
    } else if (formId === 'signup-form') {
      const password = data.get('password');
      const confirmPassword = data.get('password_confirm');
      const issues = U.validatePassword(password);
      if (issues.length) {
        local.passwordTouched = true;
        local.passwordIssues = issues;
        if (submitBtn) submitBtn.classList.remove('btn-loading');
        renderPasswordError();
        return;
      }
      if (password !== confirmPassword) {
        local.confirmTouched = true;
        local.confirmError = 'Passwords do not match';
        if (submitBtn) submitBtn.classList.remove('btn-loading');
        renderConfirmError();
        return;
      }
      if (!data.get('university')) {
        App.Toast.error('Please tell us which university you are a student at.');
        if (submitBtn) submitBtn.classList.remove('btn-loading');
        return;
      }
      if (!data.get('campus_location')) {
        App.Toast.error('Please tell us which campus you are at.');
        if (submitBtn) submitBtn.classList.remove('btn-loading');
        return;
      }
      const res = await App.Auth.signUp({
        email: data.get('email'), password,
        name: data.get('name'), phone: data.get('phone'), role: 'customer',
        university: data.get('university'), campusLocation: data.get('campus_location'),
      });
      if (res.error) { local.error = res.error; App.render(); App.Toast.error(res.error); return; }
      if (res.pendingConfirmation) { App.Toast.info('Account created! Please check your email to confirm before logging in.'); setTab('login'); return; }
      App.Toast.success('Account created! Welcome to clickFud.');
      App.routeToOwnDashboard();
    } else if (formId === 'forgot-form') {
      const res = await App.Auth.forgotPassword(data.get('email'));
      if (res.error) { local.error = res.error; App.render(); App.Toast.error(res.error); return; }
      App.Toast.success('If that email exists, a reset link has been sent.');
      toggleForgot();
    } else if (formId === 'reset-password-form') {
      const password = data.get('password');
      const confirmPassword = data.get('password_confirm');
      const issues = U.validatePassword(password);
      if (issues.length) {
        local.passwordTouched = true;
        local.passwordIssues = issues;
        if (submitBtn) submitBtn.classList.remove('btn-loading');
        App.render();
        return;
      }
      if (password !== confirmPassword) {
        local.confirmTouched = true;
        local.confirmError = 'Passwords do not match';
        if (submitBtn) submitBtn.classList.remove('btn-loading');
        App.render();
        return;
      }
      const res = await App.Auth.updatePassword(password);
      if (res.error) { local.error = res.error; App.render(); App.Toast.error(res.error); return; }
      App.Toast.success('Password updated successfully.');
      App.routeToOwnDashboard();
    }
  }

  function handleAction(action, ds, el) {
    if (action === 'auth-tab') return setTab(ds.tab);
    if (action === 'toggle-forgot') return toggleForgot();
    if (action === 'toggle-password') return togglePassword(ds.target, el);
  }

  function handleInput(kind, value) {
    if (kind === 'signup-password') {
      if (local.passwordTouched) {
        local.passwordIssues = U.validatePassword(value);
        renderPasswordError();
      }
      if (local.confirmTouched) checkConfirmMatch();
      return;
    }
    if (kind === 'signup-password-confirm') {
      if (local.confirmTouched) checkConfirmMatch();
      return;
    }
  }

  function checkConfirmMatch() {
    const pwd = document.getElementById('su-password');
    const confirm = document.getElementById('su-password-confirm');
    if (!pwd || !confirm) return;
    local.confirmError = pwd.value === confirm.value ? null : 'Passwords do not match';
    renderConfirmError();
  }

  // Surgical DOM updates (not App.render()) so re-checking the password
  // doesn't wipe out whatever the user has already typed into the other
  // uncontrolled signup fields (name/email/phone).
  function renderPasswordError() {
    const input = document.getElementById('su-password');
    if (!input) return;
    const field = input.closest('.field');
    const hasIssues = local.passwordTouched && local.passwordIssues && local.passwordIssues.length;
    input.classList.toggle('has-error', !!hasIssues);
    let errEl = field.querySelector('.field-error');
    if (hasIssues) {
      if (!errEl) { errEl = document.createElement('div'); errEl.className = 'field-error'; field.appendChild(errEl); }
      errEl.textContent = 'Password needs: ' + local.passwordIssues.join(', ');
    } else if (errEl) {
      errEl.remove();
    }
  }

  function renderConfirmError() {
    const input = document.getElementById('su-password-confirm');
    if (!input) return;
    const field = input.closest('.field');
    const hasError = local.confirmTouched && local.confirmError;
    input.classList.toggle('has-error', !!hasError);
    let errEl = field.querySelector('.field-error');
    if (hasError) {
      if (!errEl) { errEl = document.createElement('div'); errEl.className = 'field-error'; field.appendChild(errEl); }
      errEl.textContent = local.confirmError;
    } else if (errEl) {
      errEl.remove();
    }
  }

  return { render, renderResetPassword, setTab, toggleForgot, handleSubmit, handleAction, handleInput, local };
})();
