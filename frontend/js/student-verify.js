/* ============================================================
   CLICKFOOD, student verification (for student-only deals)

   The customer's login email never changes. A separate university email
   proves student status: the server emails a one-time link to it
   (Edge Function student-verify); opening that link while signed in
   confirms it. Everything is decided on the server; this file only shows
   the steps. Used from checkout (a student-only code) and from Profile.
   The link is https://clickfood.co.za/?student_verify=<token>; if the
   student isn't signed in yet, the token waits in this tab until they are.
   ============================================================ */
window.App = window.App || {};

App.StudentVerify = (function () {
  const S = App.Store;
  const U = App.Utils;
  const esc = (v) => U.escapeHtml(v == null ? '' : String(v));
  const KEY = 'clickfood_student_verify_token';
  let state = null;          // { status, email, university }
  let onDone = null;         // e.g. re-apply the promo after success
  let ctx = {};              // { universityName, message } from the caller
  let sending = false; let cooldownUntil = 0;

  async function load() {
    const { data, error } = await App.sb.rpc('my_student_verification');
    state = error || !data ? { status: 'none' } : data;
    return state;
  }
  function status() { return state ? state.status : null; }
  function isVerified() { return status() === 'verified'; }

  function campusOptions(uniId, chosen) {
    const list = App.Discovery.campuses().filter(c => c.university_id === uniId);
    if (!list.length) return '';
    // the campus chosen in Profile is used as it is (not asked again)
    const mine = chosen && list.find(c => c.id === chosen);
    if (mine) return `<div class="field"><label>Campus</label><div class="font-semibold">${esc(mine.full_name)}</div><input type="hidden" id="sv-campus" value="${esc(mine.id)}" /></div>`;
    return `<div class="field"><label for="sv-campus">Campus</label><select class="select" id="sv-campus"><option value="">Choose your campus</option>${list.map(c => `<option value="${esc(c.id)}" ${chosen === c.id ? 'selected' : ''}>${esc(c.full_name)}</option>`).join('')}</select></div>`;
  }

  // the "Verify Your Student Status" box
  async function open(opts) {
    onDone = (opts && opts.onDone) || null;
    ctx = opts || {};
    if (!App.Discovery.universities().length) await App.Discovery.loadUniversities();
    await load();
    if (isVerified()) { if (onDone) onDone(); return; }
    render();
  }
  function render() {
    const p = S.state.profile || {};
    const unis = App.Discovery.universities();
    const pendingEmail = state && (state.status === 'pending' || state.status === 'needs_review') ? state.email : '';
    const wanted = ctx.universityName && unis.find(u => u.name === ctx.universityName);
    const uniId = (document.getElementById('sv-university') || {}).value || (wanted && wanted.id) || p.home_university_id || (unis[0] && unis[0].id) || '';
    const body = state && state.status === 'needs_review'
      ? `<p class="text-sm">Your email <strong>${esc(state.email)}</strong> is confirmed. Your university isn't on our list yet, so ClickFood will check it and let you know.</p>`
      : `
        <p class="text-sm mb-3">${esc(ctx.message || 'This offer is available to verified students. Enter your university email address so we can confirm your student status.')}</p>
        ${pendingEmail ? `<div class="sv-pending mb-3"><i data-lucide="mail-check"></i><span>We've sent a verification email to <strong>${esc(pendingEmail)}</strong>. Open the email and follow the instructions to confirm your student status.</span></div>` : ''}
        <form data-form="student-verify-form" novalidate>
          <div class="field"><label for="sv-email">University email</label><input class="input" type="email" id="sv-email" required autocomplete="off" value="${esc(pendingEmail)}" placeholder="e.g. u12345678@tuks.co.za" /></div>
          <div class="field"><label for="sv-university">University</label><select class="select" id="sv-university" data-action-change="sv-university">${unis.map(u => `<option value="${esc(u.id)}" ${uniId === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
          <div id="sv-campus-wrap">${campusOptions(uniId, p.campus_id)}</div>
          <button type="submit" class="btn btn-primary btn-block ${sending ? 'btn-loading' : ''}" ${sending ? 'disabled' : ''}>${pendingEmail ? 'Send the email again' : 'Verify Student Email'}</button>
          <div class="text-xs text-muted mt-2">Your login email stays the same.</div>
        </form>`;
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Verify Your Student Status</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">${body}</div>`, { size: 'sm' });
  }

  async function submit() {
    if (sending) return;
    const email = String((document.getElementById('sv-email') || {}).value || '').trim().toLowerCase();
    const university_id = (document.getElementById('sv-university') || {}).value || null;
    const campus_id = (document.getElementById('sv-campus') || {}).value || null;
    if (!U.isValidEmail(email)) return App.Toast.error('Please enter a valid email address.');
    if (Date.now() < cooldownUntil) return App.Toast.error('Please wait a minute before sending another email.');
    sending = true; render();
    const { data, error } = await App.sb.functions.invoke('student-verify', { body: { action: 'start', email, university_id, campus_id } });
    sending = false;
    let r = data;
    if (error) { try { r = await error.context.json(); } catch (e) { r = null; } }
    if (!r || !r.ok) {
      if (r && r.already) { await load(); App.Modal.close(); App.Toast.success('You are already a verified student.'); if (onDone) onDone(); return; }
      App.Toast.error((r && r.error) || "We couldn't verify your student email. Check the address and try again.");
      return render();
    }
    cooldownUntil = Date.now() + 60000;
    state = { status: 'pending', email };
    render();
    App.Toast.success('Email sent. Check your university inbox.');
  }

  // the link from the email
  async function confirmToken(token) {
    const { data, error } = await App.sb.functions.invoke('student-verify', { body: { action: 'confirm', token } });
    let r = data;
    if (error) { try { r = await error.context.json(); } catch (e) { r = null; } }
    try { sessionStorage.removeItem(KEY); } catch (e) { /* storage blocked */ }
    if (r && r.ok && r.status === 'verified') {
      await load();
      if (App.Pages.Entrepreneur) App.Pages.Entrepreneur.reset();
      if (S.state.profile) S.set({ profile: Object.assign({}, S.state.profile, { is_student: true }) });
      App.Modal.open(`<div class="modal-body" style="text-align:center;padding-top:26px;"><div class="confirm-icon info"><i data-lucide="badge-check"></i></div>
        <h3 class="text-lg font-bold mb-2">Student email verified</h3>
        <p class="text-muted text-sm">Your student email has been verified. You can now claim eligible student promotions, subject to each offer's rules.</p></div>
        <div class="modal-footer"><button type="button" class="btn btn-primary" data-action="close-modal">Continue</button></div>`, { size: 'sm' });
    } else if (r && r.ok && r.status === 'needs_review') {
      App.Toast.success('Email confirmed. ClickFood will check your university and let you know.');
    } else {
      App.Toast.error((r && r.error) || "We couldn't verify your student email. Check the address and try again.");
    }
  }
  // on start: take ?student_verify=… off the address bar and keep it until signed in
  function captureFromUrl() {
    const u = new URL(window.location.href);
    const t = u.searchParams.get('student_verify');
    if (!t) return;
    try { sessionStorage.setItem(KEY, t); } catch (e) { /* storage blocked: lost on refresh */ window.__svToken = t; }
    u.searchParams.delete('student_verify');
    history.replaceState({}, '', u.pathname + (u.search ? u.search : '') + u.hash);
  }
  function pendingToken() { try { return sessionStorage.getItem(KEY) || window.__svToken || null; } catch (e) { return window.__svToken || null; } }
  // called once a customer is signed in
  function afterSignIn() {
    const t = pendingToken();
    if (t && S.state.profile && S.state.profile.role === 'customer') { window.__svToken = null; confirmToken(t); }
  }

  function handleChange(kind, ds, value) {
    if (kind === 'sv-university') { const w = document.getElementById('sv-campus-wrap'); if (w) { w.innerHTML = campusOptions(value, null); } }
  }
  function handleSubmit(formId) { if (formId === 'student-verify-form') return submit(); }

  captureFromUrl();
  return { load, status, isVerified, open, afterSignIn, pendingToken, handleChange, handleSubmit };
})();
