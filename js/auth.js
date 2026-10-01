/* ============================================================
   CLICKFUD — authentication (Supabase Auth) & role guards
   ============================================================ */
window.App = window.App || {};

App.Auth = (function () {
  const S = App.Store;
  const UP_EMAIL_MESSAGE = 'Please use your University of Pretoria student email address (e.g. u12345678@' + App.CONFIG.UP_STUDENT_EMAIL_DOMAIN + ').';

  async function fetchProfile(userId) {
    const { data, error } = await App.sb.from('profiles').select('*').eq('id', userId).single();
    if (error) {
      console.error('fetchProfile', error);
      // Offline with a still-valid saved Supabase session: fall back to
      // the whitelisted customer profile snapshot so the customer's own
      // dashboard can still open for browsing. Only ever a customer
      // snapshot (App.OfflineCache.saveProfile refuses anything else),
      // and it grants nothing server-side — every real request still
      // goes through Supabase Auth + RLS once back online.
      if (App.Connectivity.isNetworkError(error)) {
        App.Connectivity.reportNetworkFailure();
        const cached = await App.OfflineCache.loadProfile(userId);
        if (cached && cached.data && cached.data.role === 'customer') {
          return Object.assign({}, cached.data, { _fromOfflineCache: true });
        }
      }
      return null;
    }
    App.OfflineCache.saveProfile(data);
    return data;
  }

  // Once back online, swap a cached profile for the real row (and load
  // everything that couldn't be fetched while offline).
  async function refreshAfterReconnect() {
    const session = S.state.session;
    if (!session || !S.state.profile || !S.state.profile._fromOfflineCache) return;
    const profile = await fetchProfile(session.user.id);
    if (!profile || profile._fromOfflineCache) return;
    if (profile.role !== 'customer') { await signOut(); return; }
    S.set({ profile });
    S.rescopeStoresRealtime(profile.university);
    if (App.Push) App.Push.subscribeIfPossible();
  }

  // An email sign-up already answered university/campuses/residence on the
  // signup form — carry those onto the profile the first time they sign
  // in, so they aren't asked twice. (A Google sign-up has none of this,
  // and gets the campus setup screen instead — js/pages/campus-setup.js.)
  async function applySignupCampusMetadata(session) {
    const profile = S.state.profile;
    if (!needsCampusSetup(profile) || profile._fromOfflineCache) return;
    const meta = (session.user && session.user.user_metadata) || {};
    const university = profile.university || meta.university;
    const campuses = Array.isArray(meta.campuses) && meta.campuses.length ? meta.campuses : (meta.campus_location ? [meta.campus_location] : []);
    if (!university || !campuses.length) return;
    const patch = { university, campuses };
    if (meta.residence) patch.default_location = Object.assign({}, profile.default_location || {}, { residence: meta.residence });
    const res = await updateProfile(patch);
    if (res.error) console.error('applySignupCampusMetadata', res.error);
  }

  // restoreSession() reaches this from TWO places at once on every app
  // load with a saved login: its own getSession() check, and Supabase's
  // onAuthStateChange event firing in parallel (neither sees the other's
  // S.state.session yet). Running the whole setup twice concurrently set up
  // the same realtime channels twice — the second attempt THROWS ("cannot
  // add postgres_changes callbacks ... after subscribe()"), which aborted
  // restoreSession() before handlePaystackReturn ran. That is why a
  // student's 2nd+ Paystack payment never showed "Verifying your payment".
  // One run per user at a time; a concurrent caller just awaits it.
  let applyInFlight = null;
  let applyInFlightFor = null;
  function applySignedInSession(session) {
    const uid = session && session.user && session.user.id;
    if (applyInFlight && applyInFlightFor === uid) return applyInFlight;
    applyInFlightFor = uid;
    applyInFlight = doApplySignedInSession(session).finally(() => { applyInFlight = null; applyInFlightFor = null; });
    return applyInFlight;
  }

  async function doApplySignedInSession(session) {
    const profile = await fetchProfile(session.user.id);
    // secure-login already rejects a non-customer account at the
    // password-login step itself (never even establishing a session) —
    // but Google sign-in (App.Auth.signInWithGoogle) goes straight
    // through Supabase's own OAuth flow and never touches secure-login,
    // and a session can also already exist in the browser from before
    // that fix (or from a password-reset link). This is the backstop for
    // both: whatever got a real session established, a staff/manager/
    // kitchen/driver/developer account must still never actually land in
    // the customer app, and — same as the password case — without
    // revealing that a different account/app exists.
    if (profile && profile.role !== 'customer') {
      await App.sb.auth.signOut();
      S.set({ session: null, profile: null, authReady: true });
      App.Toast.error('Incorrect email or password.');
      return;
    }
    // Same backstop for the UP-student rule: password sign-in is already
    // refused server-side (secure-login), but a session can also come from
    // Google or a password-reset link. A customer account without a UP
    // student email never gets into the customer app.
    if (profile && profile.role === 'customer' && !App.Utils.isUpStudentEmail(session.user.email)) {
      await App.sb.auth.signOut();
      S.set({ session: null, profile: null, authReady: true });
      App.Toast.error(UP_EMAIL_MESSAGE);
      return;
    }
    S.set({ session, profile, authReady: true });
    await applySignupCampusMetadata(session);
    S.loadCart(); S.loadFavorites(); S.loadFavoriteStores();
    S.initRealtime();
    // Now that a real university is known, narrow the platform-wide
    // stores realtime feed down to just this customer's campus — see
    // js/store.js rescopeStoresRealtime() for what is/isn't achievable.
    S.rescopeStoresRealtime(S.state.profile && S.state.profile.role === 'customer' ? S.state.profile.university : null);
    if (App.Bootstrap) App.Bootstrap.loadPrivateData();
    if (App.Push) App.Push.subscribeIfPossible();
  }

  async function restoreSession() {
    // Registered BEFORE the initial getSession() check below, not after —
    // detectSessionInUrl (js/supabaseClient.js) processes a ?code=/
    // #access_token= from an email link asynchronously right around here,
    // and it must never fire while nothing is listening yet. This is what
    // actually catches PASSWORD_RECOVERY (a password-reset link) and
    // SIGNED_IN (an email-verification link) events coming from the URL,
    // not just from a normal in-app sign-in.
    App.sb.auth.onAuthStateChange(async (event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        // A real Supabase-verified password-reset session now exists —
        // show the Create New Password screen instead of routing anywhere
        // by role. See js/app.js mainContent() and js/pages/auth-pages.js
        // renderResetPassword(). Profile is fetched (so the nav shows the
        // real signed-in identity) but cart/realtime/push init are
        // deliberately skipped until the reset is actually completed.
        const profile = await fetchProfile(session.user.id);
        S.set({ session, profile, authReady: true, passwordRecovery: true });
        return;
      }
      if (event === 'SIGNED_OUT') {
        S.teardownRealtime();
        S.rescopeStoresRealtime(null); // back to the unfiltered guest feed
        S.set({ session: null, profile: null, orders: [], notifications: [], reviews: [], privateDataFor: null, passwordRecovery: false });
        S.loadCart(); S.loadFavorites(); S.loadFavoriteStores();
        return;
      }
      if (session && (!S.state.session || S.state.session.user.id !== session.user.id)) {
        await applySignedInSession(session);
      } else if (session) {
        S.set({ session, authReady: true });
      }
    });

    const { data: { session } } = await App.sb.auth.getSession();
    if (S.state.passwordRecovery) return; // already handled by the listener above — don't overwrite it
    if (session) {
      await applySignedInSession(session);
    } else {
      S.set({ session: null, profile: null, authReady: true });
      S.loadCart(); S.loadFavorites(); S.loadFavoriteStores();
    }
  }

  // rateLimited flags Supabase's own auth rate limit (signUp,
  // resetPasswordForEmail) — unlike our own login lockout below, Supabase
  // gives no timestamp or Retry-After header for this at all (checked:
  // neither is present on the 429 response), so callers can only start an
  // honest client-side cool-down, never a server-confirmed one.
  function friendlyError(error) {
    if (!error) return { message: 'Something went wrong. Please try again.' };
    const msg = error.message || String(error);
    // The database refused the sign-up (supabase/up_student_auth.sql) —
    // Supabase only reports this generically, never with our reason.
    if (/database error saving new user|UP_STUDENT/i.test(msg)) return { message: UP_EMAIL_MESSAGE + ' Make sure your student number is also filled in.' };
    if (/invalid login credentials/i.test(msg)) return { message: 'Incorrect email or password.' };
    if (/email not confirmed/i.test(msg)) return { message: 'Please confirm your email address first — check your inbox for the confirmation link we sent you.' };
    if (/already registered|already exists/i.test(msg)) return { message: 'An account with this email already exists. Please log in instead, or use a different email address.', alreadyExists: true };
    if (/password should be at least/i.test(msg)) return { message: 'Password must contain at least 6 characters.' };
    // Deliberately worded nothing like the login-lockout message below —
    // this is Supabase's own email-sending limit (unrelated to any
    // password or account), and the two got confused for the same
    // restriction more than once purely because both said "too many
    // attempts" in the UI.
    if (/rate limit/i.test(msg)) return { message: "We've hit a temporary limit on emails sent from this app (unrelated to your password). Please wait a few minutes and try again.", rateLimited: true };
    return { message: msg };
  }

  async function signUp({ email, password, name, phone, role, university, campuses, residence, studentNumber }) {
    email = String(email || '').trim().toLowerCase();
    name = App.Utils.sanitizeText(name, 80);
    phone = App.Utils.sanitizeText(phone, 20);
    university = App.Utils.sanitizeText(university, 120);
    const allowed = App.CONST.UNIVERSITY_CAMPUSES[university] || [];
    campuses = [...new Set((campuses || []).filter(c => allowed.includes(c)))];
    residence = App.Utils.sanitizeText(residence || '', 80);
    const campusLocation = campuses[0] || null;
    if (!App.Utils.isValidEmail(email)) return { error: 'Please enter a valid email address.' };
    // Instant feedback only — the database refuses any non-UP customer
    // sign-up itself (supabase/up_student_auth.sql), whatever this code does.
    if (!App.Utils.isUpStudentEmail(email)) return { error: UP_EMAIL_MESSAGE };
    const cleanStudentNumber = App.Utils.normalizeStudentNumber(studentNumber);
    if (!cleanStudentNumber) return { error: 'Please enter your UP student number (8 digits, e.g. u12345678).' };
    if (!name) return { error: 'Please enter your name.' };
    if (!password || password.length < 6) return { error: 'Password must contain at least 6 characters.' };
    const { data, error } = await App.sb.auth.signUp({
      email, password,
      options: {
        // campuses/residence aren't copied by the database's own
        // handle_new_user(); applySignedInSession() applies them to the
        // profile on first sign-in (see applySignupCampusMetadata).
        data: { name, phone, role: role || 'customer', university: university || null, campus_location: campusLocation, campuses, residence: residence || null, student_number: cleanStudentNumber },
        // One Supabase project backs three separately-deployed apps — without
        // this, the confirmation link would send everyone to whichever single
        // "Site URL" happens to be configured in the Supabase dashboard,
        // regardless of which app they actually signed up on.
        emailRedirectTo: window.location.origin,
      },
    });
    if (error) {
      // GoTrue creates the auth user row BEFORE attempting to send the
      // confirmation email, so a failure at the email-send step (e.g. the
      // SMTP provider rejecting it) still comes back as an error here even
      // though an account now genuinely exists — re-registering with the
      // same email would then confusingly hit "already registered" instead
      // of just needing a resend. Detected so the caller can say so
      // honestly instead of a generic failure message, and point at
      // Resend rather than Sign Up again.
      if (/error sending confirmation|error sending.*email|email.*could not be sent/i.test(error.message || '')) {
        return { error: "Your account was created, but we couldn't send the verification email. Please try resending it below.", emailSendFailed: true, email };
      }
      const fe = friendlyError(error);
      return { error: fe.message, rateLimited: fe.rateLimited, alreadyExists: fe.alreadyExists };
    }
    if (!data.session) {
      return { pendingConfirmation: true, email };
    }
    return { data };
  }

  // Supabase's own resend endpoint — re-sends the same real confirmation
  // link for an account that already exists but hasn't verified yet, no
  // separate token/verification system of our own. Enumeration-safe by
  // construction: Supabase returns success/no-error here regardless of
  // whether the email belongs to a real unverified account, an already-
  // verified one, or no account at all, so the caller can always show the
  // same generic message without leaking which case it was.
  async function resendVerification(email) {
    email = String(email || '').trim().toLowerCase();
    if (!App.Utils.isValidEmail(email)) return { error: 'Please enter a valid email address.' };
    const { error } = await App.sb.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) { const fe = friendlyError(error); return { error: fe.message, rateLimited: fe.rateLimited }; }
    return { ok: true };
  }

  // Routed through the secure-login Edge Function rather than calling
  // signInWithPassword directly, so failed attempts can be counted and
  // locked out per email server-side (5 attempts, 15-minute lockout) —
  // a client-side-only counter would be trivially bypassed by refreshing
  // the page or clearing storage.
  async function signIn(email, password) {
    email = String(email || '').trim().toLowerCase();
    if (!App.Utils.isValidEmail(email)) return { error: 'Please enter a valid email address.' };
    if (!password) return { error: 'Please enter your password.' };
    // 'app' tells the shared secure-login function which real account
    // roles belong here — this same function is also used by the
    // separate Staff and Developer apps against the same Supabase
    // project, each with their own value here.
    const { data, error } = await App.sb.functions.invoke('secure-login', { body: { email, password, app: 'customer' } });
    if (error) return { error: friendlyError(error).message };
    if (data.error) {
      // lockedUntil (see supabase/functions/secure-login) is a real,
      // server-computed timestamp — our own lockout, not Supabase's, so
      // unlike the rate-limited cases below the caller can build an
      // accurate countdown from it instead of a guessed one.
      if (data.lockedUntil) return { error: data.error, lockedUntil: data.lockedUntil };
      return { error: friendlyError({ message: data.error }).message };
    }
    const { error: setErr } = await App.sb.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    if (setErr) return { error: friendlyError(setErr).message };
    return { data: { session: data.session, user: data.user } };
  }

  async function signOut() {
    // Drop this customer's offline snapshot (profile + timetable) so the
    // next person on a shared phone can't browse it offline.
    const userId = S.state.profile && S.state.profile.id;
    if (userId) await App.OfflineCache.clearUser(userId);
    await App.sb.auth.signOut();
  }

  // "Continue with Google" — a full-page redirect to Google's own consent
  // screen (Supabase's signInWithOAuth, not a popup), which is what makes
  // this identical code work on both Android and iOS: there's no native
  // SDK involved, just the same browser navigation either platform's
  // browser/PWA already handles. Supabase itself never sees or stores the
  // student's Google password — Google authenticates the account and
  // hands Supabase back a signed token, which is all this function starts.
  //
  // Returning to the app: detectSessionInUrl (js/supabaseClient.js) and
  // the onAuthStateChange listener in restoreSession() above already
  // handle the redirect back generically (same code path as an email
  // verification/reset link) — a session appearing there calls
  // applySignedInSession() exactly as it does for a password sign-in, so
  // no separate OAuth-callback handling was needed.
  //
  // Duplicate accounts: Supabase Auth links a new Google sign-in to an
  // EXISTING account automatically when the email matches an already-
  // verified account on this project, rather than creating a second one
  // — this is Supabase's own built-in identity-linking behaviour, not
  // something this app implements itself. A brand-new Google-only
  // student instead gets a new row via the existing handle_new_user()
  // database trigger (supabase/migration_governance.sql), the same
  // trigger every email/password signup already goes through.
  async function signInWithGoogle() {
    const { error } = await App.sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    // Only a same-tick failure (e.g. the provider isn't enabled, or the
    // browser blocked the navigation) ever reaches here — success means
    // the browser is already navigating to Google and this code doesn't
    // get to run any further.
    if (error) return { error: friendlyError(error).message };
    return { ok: true };
  }

  async function forgotPassword(email) {
    email = String(email || '').trim().toLowerCase();
    if (!App.Utils.isValidEmail(email)) return { error: 'Please enter a valid email address.' };
    // Without redirectTo, Supabase sends the reset link to whatever its
    // account-level Site URL is set to — this app's three separately-
    // deployed domains can't all be that one setting, so it has to be
    // supplied per-request here, exactly like emailRedirectTo in signUp().
    const { error } = await App.sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
    // This used to be discarded unconditionally, always reporting success
    // even when Supabase actually rejected the request (e.g. its email
    // rate limit) — the UI would claim "reset link sent" when nothing was
    // sent at all.
    if (error) { const fe = friendlyError(error); return { error: fe.message, rateLimited: fe.rateLimited }; }
    return { ok: true };
  }

  // Only valid to call while S.state.passwordRecovery is true — that flag
  // is only ever set by a real PASSWORD_RECOVERY event (see
  // restoreSession() above), i.e. Supabase has already verified the reset
  // link itself before this is reachable at all.
  async function updatePassword(newPassword) {
    const issues = App.Utils.validatePassword(newPassword);
    if (issues.length) return { error: 'Password needs: ' + issues.join(', ') };
    const { error } = await App.sb.auth.updateUser({ password: newPassword, data: { password_set: true } });
    if (error) return { error: friendlyError(error).message };
    S.set({ passwordRecovery: false });
    // The recovery session deliberately skipped the normal sign-in side
    // effects (cart, realtime, push) since the user wasn't actually
    // continuing into the app yet — now that the password is genuinely
    // set, run them for real so they land in a fully working dashboard.
    if (S.state.session) await applySignedInSession(S.state.session);
    return { ok: true };
  }

  async function updateProfile(patch) {
    if (!S.state.profile) return { error: 'Not signed in.' };
    const clean = {};
    if (patch.name !== undefined) clean.name = App.Utils.sanitizeText(patch.name, 80);
    if (patch.phone !== undefined) clean.phone = App.Utils.sanitizeText(patch.phone, 20);
    if (patch.avatar_url !== undefined) clean.avatar_url = App.Utils.sanitizeText(patch.avatar_url, 500);
    if (patch.university !== undefined) clean.university = App.Utils.sanitizeText(patch.university, 120);
    if (patch.campus_location !== undefined) clean.campus_location = App.Utils.sanitizeText(patch.campus_location, 120) || null;
    if (patch.campuses !== undefined) {
      // Only real campuses of the chosen university, de-duplicated.
      const university = clean.university || S.state.profile.university;
      const allowed = App.CONST.UNIVERSITY_CAMPUSES[university] || [];
      clean.campuses = [...new Set((patch.campuses || []).filter(c => allowed.includes(c)))];
      // campus_location stays the first campus, so every screen that only
      // knows about one campus (My Orientation, collection labels) still works.
      clean.campus_location = clean.campuses[0] || null;
    }
    if (patch.student_number !== undefined) {
      clean.student_number = App.Utils.normalizeStudentNumber(patch.student_number);
      if (!clean.student_number) return { error: 'Please enter your UP student number (8 digits, e.g. u12345678).' };
    }
    if (patch.default_location !== undefined) clean.default_location = patch.default_location;
    if (patch.driver_status !== undefined) clean.driver_status = patch.driver_status;
    // store_id can only ever be set once — the DB trigger (prevent_role_change
    // in schema.sql) silently ignores any attempt to change it once non-null.
    if (patch.store_id !== undefined) clean.store_id = patch.store_id;
    let { data, error } = await App.sb.from('profiles').update(clean).eq('id', S.state.profile.id).select().single();
    if (error && clean.campuses && /campuses/.test(error.message || '')) {
      // student_campuses.sql not run yet — save the first campus the old
      // way so the student is never stuck; extra campuses need the column.
      console.warn('profiles.campuses missing — run supabase/student_campuses.sql');
      delete clean.campuses;
      ({ data, error } = await App.sb.from('profiles').update(clean).eq('id', S.state.profile.id).select().single());
    }
    if (error) return { error: friendlyError(error).message };
    S.set({ profile: data });
    App.OfflineCache.saveProfile(data);
    return { data };
  }

  // A student can attend more than one campus (profiles.campuses, see
  // supabase/student_campuses.sql). Older profiles — and a database where
  // that SQL hasn't run yet — only have the single campus_location, so
  // this is the one place that reads either shape.
  function campusesOf(profile) {
    if (!profile) return [];
    if (Array.isArray(profile.campuses) && profile.campuses.length) return profile.campuses;
    return profile.campus_location ? [profile.campus_location] : [];
  }

  // Every student must say which university and campus(es) they attend
  // before using the app — including Google sign-ups, which never see
  // the signup form's own university/campus fields.
  function needsCampusSetup(profile) {
    return !!profile && profile.role === 'customer' && (!profile.university || !campusesOf(profile).length || needsStudentNumber(profile) || needsPassword(profile));
  }
  // A Google sign-up has no password, so it can't log in with email +
  // password later. The setup screen makes them create one once. Accounts
  // that signed up with the email form already have one ('email' provider);
  // password_set marks a Google account that has since created one.
  function needsPassword(profile) {
    const user = S.state.session && S.state.session.user;
    if (!user || !profile || profile.role !== 'customer' || profile._fromOfflineCache) return false;
    const app = user.app_metadata || {};
    const providers = Array.isArray(app.providers) ? app.providers : [app.provider || 'email'];
    return !providers.includes('email') && !(user.user_metadata && user.user_metadata.password_set);
  }
  async function createPassword(newPassword) {
    const issues = App.Utils.validatePassword(newPassword);
    if (issues.length) return { error: 'Password needs: ' + issues.join(', ') };
    const { data, error } = await App.sb.auth.updateUser({ password: newPassword, data: { password_set: true } });
    if (error) return { error: friendlyError(error).message };
    if (data && data.user && S.state.session) S.set({ session: Object.assign({}, S.state.session, { user: data.user }) });
    return { ok: true };
  }
  // Google sign-ups have no sign-up form, so their student number is asked
  // for once on the setup screen. ('in' check: the offline profile cache
  // doesn't carry it, and must never trap a student offline.)
  function needsStudentNumber(profile) {
    return !!profile && profile.role === 'customer' && ('student_number' in profile) && !profile.student_number;
  }

  function hasRole(role) { return S.state.profile && S.state.profile.role === role; }
  function currentRole() { return S.state.profile ? S.state.profile.role : null; }

  return {
    restoreSession, refreshAfterReconnect, signUp, signIn, signOut, signInWithGoogle, forgotPassword, updatePassword, updateProfile,
    resendVerification,
    hasRole, currentRole, fetchProfile, campusesOf, needsCampusSetup, needsStudentNumber, needsPassword, createPassword,
  };
})();
