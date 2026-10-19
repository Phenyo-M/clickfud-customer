/* ============================================================
   CLICKFOOD, bot check (Cloudflare Turnstile)

   Gets a one-time token for sign-up, login, password reset and resending
   the verification email. Supabase Auth checks the token (CAPTCHA switched
   on in Supabase with Turnstile's secret key). Turnstile is usually
   invisible; it only shows a box when Cloudflare isn't sure.
   Off until App.CONFIG.TURNSTILE_SITE_KEY is set: token() then returns null
   and everything works as before.
   ============================================================ */
window.App = window.App || {};

App.Captcha = (function () {
  let loading = null;
  let box = null;
  let widget = null;

  function key() { return (App.CONFIG && App.CONFIG.TURNSTILE_SITE_KEY) || ''; }
  function enabled() { return !!key(); }

  function load() {
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => resolve(window.turnstile);
      s.onerror = () => { loading = null; reject(new Error('The security check could not load.')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  // A fresh token (each can be used once), or null when the check is off.
  async function token() {
    if (!enabled()) return null;
    // if Cloudflare can't be reached, carry on without a token: Supabase decides
    // (with its CAPTCHA switched on it refuses, otherwise the login works)
    let ts;
    try { ts = await load(); } catch (e) { return null; }
    if (!ts || typeof ts.render !== 'function') return null;
    if (!box) {
      box = document.createElement('div');
      box.className = 'captcha-box';
      box.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:6000;';
      document.body.appendChild(box);
    }
    box.style.display = '';
    return new Promise((resolve) => {
      let done = false;
      // hide the box once it has answered (a moment to show the tick), so it
      // never stays on screen; the token stays valid after the box is gone
      const finish = (t) => {
        if (done) return; done = true; resolve(t || null);
        setTimeout(() => { try { if (widget !== null) ts.remove(widget); } catch (e) { /* gone */ } widget = null; if (box) box.style.display = 'none'; }, t ? 700 : 0);
      };
      try { if (widget !== null) ts.remove(widget); } catch (e) { /* new one below */ }
      try { widget = ts.render(box, {
        sitekey: key(), appearance: 'interaction-only',
        callback: finish, 'error-callback': () => finish(null), 'expired-callback': () => finish(null),
      }); } catch (e) { return finish(null); }
      setTimeout(() => finish(null), 60000);
    });
  }

  return { enabled, token };
})();
