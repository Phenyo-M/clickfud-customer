/* ============================================================
   CLICKFUD — Login / Sign Up / Forgot Password
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Auth = (function () {
  const U = App.Utils;
  const local = { tab: 'login', showForgot: false, error: null, loading: false, passwordIssues: null, passwordTouched: false, confirmError: null, confirmTouched: false, pendingVerificationEmail: null, prefillEmail: null, googleLoading: false };

  function setTab(tab) { clearLockoutInterval(); clearForgotCooldown(); local.tab = tab; local.showForgot = false; local.error = null; local.passwordTouched = false; local.passwordIssues = null; local.confirmTouched = false; local.confirmError = null; App.render(); }
  function toggleForgot() { clearLockoutInterval(); clearForgotCooldown(); local.showForgot = !local.showForgot; local.error = null; App.render(); }

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
  // Disables just the "Send Reset Link" button with a visible countdown —
  // a real per-click cooldown independent of (and in addition to)
  // Supabase's own account-wide auth rate limit, so a customer can't spam
  // this form. Direct DOM update, not App.render(), so it doesn't disturb
  // the email field's value or focus.
  let forgotCooldownInterval = null;
  function clearForgotCooldown() {
    if (forgotCooldownInterval) { clearInterval(forgotCooldownInterval); forgotCooldownInterval = null; }
  }
  // Same pattern, for the "Resend verification email" button — a separate
  // timer/target so the two cooldowns (forgot-password vs. resend-signup-
  // verification) never interfere with each other.
  let resendCooldownInterval = null;
  function clearResendCooldown() {
    if (resendCooldownInterval) { clearInterval(resendCooldownInterval); resendCooldownInterval = null; }
  }
  function startResendVerificationCooldown(seconds) {
    clearResendCooldown();
    const until = Date.now() + seconds * 1000;
    const btn = document.querySelector('[data-action="resend-verification"]');
    if (!btn) return;
    const originalLabel = 'Resend verification email';
    function tick() {
      const remaining = Math.ceil((until - Date.now()) / 1000);
      if (remaining <= 0) {
        clearInterval(resendCooldownInterval);
        resendCooldownInterval = null;
        btn.disabled = false;
        btn.textContent = originalLabel;
        return;
      }
      btn.disabled = true;
      btn.textContent = `Resend available in ${remaining}s`;
    }
    tick();
    resendCooldownInterval = setInterval(tick, 1000);
  }

  // Races a request against a hard ceiling so a slow/hung Supabase or
  // Brevo call can never leave a submit button spinning forever — the UI
  // only ever waits for the API to ACCEPT the request, never for the
  // actual email to land in an inbox (that happens well after this
  // resolves either way).
  function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('Request timed out');
        err.isTimeout = true;
        reject(err);
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
  function startForgotPasswordCooldown(seconds) {
    clearForgotCooldown();
    const until = Date.now() + seconds * 1000;
    const btn = document.querySelector('form[data-form="forgot-form"] button[type="submit"]');
    if (!btn) return;
    const originalLabel = 'Send Reset Link';
    function tick() {
      const remaining = Math.ceil((until - Date.now()) / 1000);
      if (remaining <= 0) {
        clearInterval(forgotCooldownInterval);
        forgotCooldownInterval = null;
        btn.disabled = false;
        btn.textContent = originalLabel;
        return;
      }
      btn.disabled = true;
      btn.textContent = `Resend available in ${remaining}s`;
    }
    tick();
    forgotCooldownInterval = setInterval(tick, 1000);
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
    // Restore focus/cursor to the input itself — the click that got here
    // moved focus to the button, and the spec requires typing to be able
    // to continue uninterrupted right after toggling.
    input.focus();
    try { const len = input.value.length; input.setSelectionRange(len, len); } catch (e) {}
    if (!btnEl) return;
    // '[data-lucide]' (not 'i') because App.render() already ran
    // lucide.createIcons() once before this can ever be clicked, which
    // replaces the original <i data-lucide="eye"> placeholder with an
    // inline <svg data-lucide="eye">  — querying for an 'i' tag here
    // always found nothing, so the icon never visually changed even
    // though the input's type was toggling correctly underneath it.
    const icon = btnEl.querySelector('[data-lucide]');
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
          ${App.Shared.ClickFudLogo({ size: 'md', bg: 'white', wordmark: true })}
        </div>
        ${renderGoogleButton()}
        <div class="auth-divider"><span>or</span></div>
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
          ${App.Shared.ClickFudLogo({ size: 'md', bg: 'white', wordmark: true })}
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

  // Google's own multi-colour "G" mark, inline (official path data — never
  // recoloured/altered, per Google's Sign In branding guidelines), so the
  // button renders correctly with zero extra image assets to ship. Works
  // identically on Android and iOS: this is a plain redirect button in a
  // web page, not a native control, so there is no platform-specific
  // variant to build.
  function googleIcon() {
    return `<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.16.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"/>
    </svg>`;
  }

  function renderGoogleButton() {
    return `
    <button type="button" class="btn btn-google btn-block ${local.googleLoading ? 'btn-loading' : ''}" data-action="continue-with-google" ${local.googleLoading ? 'disabled' : ''}>
      ${local.googleLoading ? '' : googleIcon()} Continue with Google
    </button>`;
  }

  async function continueWithGoogle(btnEl) {
    if (local.googleLoading) return; // guards a repeat tap while the redirect is starting
    local.googleLoading = true;
    if (btnEl) { btnEl.classList.add('btn-loading'); btnEl.disabled = true; }
    try {
      const res = await App.Auth.signInWithGoogle();
      if (res.error) {
        local.googleLoading = false;
        if (btnEl) { btnEl.classList.remove('btn-loading'); btnEl.disabled = false; }
        App.Toast.error(res.error);
      }
      // On success the browser is already navigating to Google — nothing
      // left to restore the button for.
    } catch (e) {
      local.googleLoading = false;
      if (btnEl) { btnEl.classList.remove('btn-loading'); btnEl.disabled = false; }
      App.Toast.error("Couldn't reach Google right now. Please check your connection and try again.");
    }
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
    ${local.pendingVerificationEmail ? `
      <div class="closed-banner" style="margin-bottom:14px;">
        <i data-lucide="mail"></i>
        <span>We sent a verification link to <strong>${U.escapeHtml(local.pendingVerificationEmail)}</strong>. Didn't get it?</span>
      </div>
      <button type="button" class="btn btn-ghost btn-block mb-3 text-sm" data-action="resend-verification">Resend verification email</button>
    ` : ''}
    <form data-form="login-form">
      <div class="field"><label for="li-email">UP Student Email</label><input class="input" type="email" id="li-email" name="email" value="${local.prefillEmail ? U.escapeHtml(local.prefillEmail) : ''}" placeholder="u12345678@${U.escapeHtml(App.CONFIG.UP_STUDENT_EMAIL_DOMAIN)}" required autocomplete="email" /></div>
      ${passwordField({ id: 'li-password', name: 'password', label: 'Password', autocomplete: 'current-password' })}
      <button type="submit" class="btn btn-primary btn-block btn-lg ${local.loading ? 'btn-loading' : ''}">Log In</button>
      <button type="button" class="btn btn-ghost btn-block mt-2 text-sm" data-action="toggle-forgot">Forgot password?</button>
    </form>`;
  }

  function renderSignup() {
    return `
    <form data-form="signup-form">
      <div class="field"><label for="su-name">Full Name</label><input class="input" type="text" id="su-name" name="name" required /></div>
      <div class="field">
        <label for="su-email">UP Student Email</label>
        <input class="input" type="email" id="su-email" name="email" placeholder="u12345678@${U.escapeHtml(App.CONFIG.UP_STUDENT_EMAIL_DOMAIN)}" required autocomplete="email" />
        <div class="text-xs text-muted mt-1">Use your University of Pretoria student email address. We'll send a link to it to confirm it's yours.</div>
      </div>
      <div class="field">
        <label for="su-student-number">Student Number</label>
        <input class="input" type="text" id="su-student-number" name="student_number" placeholder="Enter your student number" required autocomplete="off" maxlength="12" />
      </div>
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
        <label>Which campus(es) do you attend?</label>
        <div class="text-xs text-muted mb-2">Tick every campus you attend.</div>
        ${App.Shared.campusCheckboxes({ group: 'signup', university: App.CONST.UNIVERSITIES[0], initial: [] })}
      </div>
      <div class="field">
        <label for="su-residence">Residence <span class="text-muted" style="font-weight:400;">(optional)</span></label>
        <input class="input" id="su-residence" name="residence" placeholder="e.g. Tuks Village" maxlength="80" />
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
    } catch (err) {
      // Last-resort safety net — whatever branch threw, the button must
      // never end this function still stuck showing its spinner.
      console.error('handleSubmit', err);
      const submitBtn = formEl && formEl.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.classList.remove('btn-loading');
      App.Toast.error('Something went wrong. Please try again.');
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
      // Instant feedback only — the database makes the real decision.
      if (!App.Utils.isUpStudentEmail(data.get('email'))) {
        App.Toast.error('Please use your University of Pretoria student email address (e.g. u12345678@' + App.CONFIG.UP_STUDENT_EMAIL_DOMAIN + ').');
        if (submitBtn) submitBtn.classList.remove('btn-loading');
        return;
      }
      if (!App.Utils.normalizeStudentNumber(data.get('student_number'))) {
        App.Toast.error('Please enter your UP student number (8 digits, e.g. u12345678).');
        if (submitBtn) submitBtn.classList.remove('btn-loading');
        return;
      }
      if (!data.get('university')) {
        App.Toast.error('Please tell us which university you are a student at.');
        if (submitBtn) submitBtn.classList.remove('btn-loading');
        return;
      }
      const campuses = App.Shared.selectedCampuses('signup');
      if (!campuses.length) {
        App.Toast.error('Please tick at least one campus you attend.');
        if (submitBtn) submitBtn.classList.remove('btn-loading');
        return;
      }
      const res = await App.Auth.signUp({
        email: data.get('email'), password,
        name: data.get('name'), phone: data.get('phone'), role: 'customer',
        university: data.get('university'), campuses, residence: data.get('residence'), studentNumber: data.get('student_number'),
      });
      if (res.error) {
        if (res.emailSendFailed) {
          // The account genuinely exists in Supabase already — send them
          // to the resend flow instead of leaving them on a form that
          // would just hit "already registered" if they tried again.
          local.pendingVerificationEmail = res.email;
          App.Toast.error(res.error);
          setTab('login');
          return;
        }
        if (res.alreadyExists) {
          // One email = one account, enforced by Supabase's own auth.users
          // uniqueness — send them to Log In with the email pre-filled
          // rather than leaving them stuck re-submitting a form that can
          // never succeed for this address.
          local.prefillEmail = data.get('email');
          App.Toast.error(res.error);
          setTab('login');
          return;
        }
        local.error = res.error; App.render(); App.Toast.error(res.error); return;
      }
      if (res.pendingConfirmation) {
        local.pendingVerificationEmail = res.email;
        App.Toast.info('Account created! Please check your email to confirm before logging in.');
        setTab('login');
        return;
      }
      App.Toast.success('Account created! Welcome to clickFud.');
      App.routeToOwnDashboard();
    } else if (formId === 'forgot-form') {
      const email = data.get('email');
      let res;
      try {
        res = await withTimeout(App.Auth.forgotPassword(email), 12000);
      } catch (err) {
        // Hung request (timeout) or a thrown network error — either way
        // the spinner must stop here, not wait indefinitely.
        if (submitBtn) submitBtn.classList.remove('btn-loading');
        local.error = err && err.isTimeout
          ? 'The request took too long. Please try again.'
          : "We couldn't send the email right now. Please try again.";
        App.render();
        App.Toast.error(local.error);
        return;
      }
      // This is the actual bug fix: every other branch in this function
      // reaches an App.render() (or a full navigation) on every path,
      // which is what clears the btn-loading class added above — this
      // was the one branch that didn't on success, so the button never
      // stopped spinning even though the request had already succeeded.
      if (submitBtn) submitBtn.classList.remove('btn-loading');
      if (res.error) {
        // Preserve the two specific, actionable messages (bad email
        // format caught before any network call, and Supabase's own
        // account-wide rate limit) — everything else collapses to one
        // generic message rather than surfacing a raw backend error.
        const keepSpecific = res.rateLimited || /valid email/i.test(res.error);
        local.error = keepSpecific ? res.error : "We couldn't send the email right now. Please try again.";
        App.render();
        App.Toast.error(local.error);
        return;
      }
      App.Toast.success('Reset link sent. Please check your email.');
      if (formEl) formEl.reset();
      // A real client-side cooldown, independent of Supabase's own
      // account-wide rate limit — without this, nothing stopped a
      // customer (or a script) submitting this form as fast as it
      // resolves, e.g. before Brevo's own sending limits kick in.
      // Genuine, legitimate retries (spelled the email wrong, etc.) are
      // still possible, just not instantly.
      startForgotPasswordCooldown(60);
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
      let res;
      try {
        res = await withTimeout(App.Auth.updatePassword(password), 12000);
      } catch (err) {
        if (submitBtn) submitBtn.classList.remove('btn-loading');
        local.error = err && err.isTimeout
          ? 'The request took too long. Please try again.'
          : 'Something went wrong. Please try again.';
        App.render();
        App.Toast.error(local.error);
        return;
      }
      if (res.error) { if (submitBtn) submitBtn.classList.remove('btn-loading'); local.error = res.error; App.render(); App.Toast.error(res.error); return; }
      App.Toast.success('Password updated successfully.');
      App.routeToOwnDashboard();
    }
  }

  // Direct DOM button state (not App.render()) — same reasoning as the
  // forgot-password cooldown above: this is a standalone button, not a
  // form submit, so there's no submitBtn/btn-loading lifecycle to hook
  // into, and a full re-render isn't needed here anyway.
  let isResending = false;
  async function resendVerificationEmail(btnEl) {
    if (isResending || !local.pendingVerificationEmail) return;
    isResending = true;
    const originalLabel = (btnEl && btnEl.textContent) || 'Resend verification email';
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Sending…'; }
    try {
      const res = await withTimeout(App.Auth.resendVerification(local.pendingVerificationEmail), 12000);
      if (res.error) {
        const keepSpecific = res.rateLimited || /valid email/i.test(res.error);
        App.Toast.error(keepSpecific ? res.error : "We couldn't resend the email right now. Please try again.");
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = originalLabel; }
        return;
      }
      App.Toast.success('Verification email resent. Please check your inbox.');
      startResendVerificationCooldown(60); // takes over the button's disabled/text state itself
    } catch (err) {
      App.Toast.error(err && err.isTimeout ? 'The request took too long. Please try again.' : "We couldn't resend the email right now. Please try again.");
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = originalLabel; }
    } finally {
      isResending = false;
    }
  }

  function handleAction(action, ds, el) {
    if (action === 'auth-tab') return setTab(ds.tab);
    if (action === 'toggle-forgot') return toggleForgot();
    if (action === 'toggle-password') return togglePassword(ds.target, el);
    if (action === 'resend-verification') return resendVerificationEmail(el);
    if (action === 'continue-with-google') return continueWithGoogle(el);
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
