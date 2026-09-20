/* ============================================================
   CLICKFUD — Supabase client bootstrap
   ============================================================ */
window.App = window.App || {};

App.sb = supabase.createClient(App.CONFIG.SUPABASE_URL, App.CONFIG.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Required for email verification and password-reset links to work at
    // all: this is what makes the client notice the ?code=/#access_token=
    // Supabase puts on the URL when it redirects back here, exchange it
    // for a real session, and fire the matching onAuthStateChange event
    // (SIGNED_IN for verification, PASSWORD_RECOVERY for a reset link).
    // With this off (as it was), those parameters just sat in the URL
    // unused and no session was ever established from the link.
    detectSessionInUrl: true,
  },
});
