/* ============================================================
   CLICKFUD — authentication (Supabase Auth) & role guards
   ============================================================ */
window.App = window.App || {};

App.Auth = (function () {
  const S = App.Store;

  async function fetchProfile(userId) {
    const { data, error } = await App.sb.from('profiles').select('*').eq('id', userId).single();
    if (error) { console.error('fetchProfile', error); return null; }
    return data;
  }

  async function applySignedInSession(session) {
    const profile = await fetchProfile(session.user.id);
    S.set({ session, profile, authReady: true });
    S.loadCart(); S.loadFavorites(); S.loadFavoriteStores();
    S.initRealtime();
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
        S.set({ session: null, profile: null, orders: [], notifications: [], passwordRecovery: false });
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
    if (/invalid login credentials/i.test(msg)) return { message: 'Incorrect email or password.' };
    if (/email not confirmed/i.test(msg)) return { message: 'Please confirm your email address first — check your inbox for the confirmation link we sent you.' };
    if (/already registered|already exists/i.test(msg)) return { message: 'An account with this email already exists.' };
    if (/password should be at least/i.test(msg)) return { message: 'Password must contain at least 6 characters.' };
    // Deliberately worded nothing like the login-lockout message below —
    // this is Supabase's own email-sending limit (unrelated to any
    // password or account), and the two got confused for the same
    // restriction more than once purely because both said "too many
    // attempts" in the UI.
    if (/rate limit/i.test(msg)) return { message: "We've hit a temporary limit on emails sent from this app (unrelated to your password). Please wait a few minutes and try again.", rateLimited: true };
    return { message: msg };
  }

  async function signUp({ email, password, name, phone, role, university, campusLocation }) {
    email = String(email || '').trim().toLowerCase();
    name = App.Utils.sanitizeText(name, 80);
    phone = App.Utils.sanitizeText(phone, 20);
    university = App.Utils.sanitizeText(university, 120);
    campusLocation = App.Utils.sanitizeText(campusLocation, 120);
    if (!App.Utils.isValidEmail(email)) return { error: 'Please enter a valid email address.' };
    if (!name) return { error: 'Please enter your name.' };
    if (!password || password.length < 6) return { error: 'Password must contain at least 6 characters.' };
    const { data, error } = await App.sb.auth.signUp({
      email, password,
      options: {
        data: { name, phone, role: role || 'customer', university: university || null, campus_location: campusLocation || null },
        // One Supabase project backs three separately-deployed apps — without
        // this, the confirmation link would send everyone to whichever single
        // "Site URL" happens to be configured in the Supabase dashboard,
        // regardless of which app they actually signed up on.
        emailRedirectTo: window.location.origin,
      },
    });
    if (error) { const fe = friendlyError(error); return { error: fe.message, rateLimited: fe.rateLimited }; }
    if (!data.session) {
      return { pendingConfirmation: true };
    }
    return { data };
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
    const { data, error } = await App.sb.functions.invoke('secure-login', { body: { email, password } });
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
    await App.sb.auth.signOut();
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
    const { error } = await App.sb.auth.updateUser({ password: newPassword });
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
    if (patch.default_location !== undefined) clean.default_location = patch.default_location;
    if (patch.driver_status !== undefined) clean.driver_status = patch.driver_status;
    // store_id can only ever be set once — the DB trigger (prevent_role_change
    // in schema.sql) silently ignores any attempt to change it once non-null.
    if (patch.store_id !== undefined) clean.store_id = patch.store_id;
    const { data, error } = await App.sb.from('profiles').update(clean).eq('id', S.state.profile.id).select().single();
    if (error) return { error: friendlyError(error).message };
    S.set({ profile: data });
    return { data };
  }

  function hasRole(role) { return S.state.profile && S.state.profile.role === role; }
  function currentRole() { return S.state.profile ? S.state.profile.role : null; }

  return {
    restoreSession, signUp, signIn, signOut, forgotPassword, updatePassword, updateProfile,
    hasRole, currentRole, fetchProfile,
  };
})();
