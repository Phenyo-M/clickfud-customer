/* ============================================================
   CLICKFOOD, app error reporting (monitoring)

   Sends crashes, unhandled promise errors and failed Supabase requests to
   the monitoring system (RPC ops_report_client_error), which groups them
   into incidents for the developer dashboard. Never sends passwords,
   tokens, emails, phone numbers or query strings (removed here AND again on
   the server). At most one report per error per minute and 20 per visit, so
   a broken page can't flood anything. Reporting can never break the app.
   ============================================================ */
window.App = window.App || {};

App.Monitor = (function () {
  const APP = 'customer';
  const CORRELATION = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).slice(0, 36);
  const sentAt = new Map();
  let sent = 0;
  let busy = false;

  function redact(s) {
    return String(s || '')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
      .replace(/eyJ[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+){0,2}/g, '[token]')
      .replace(/(sb_(publishable|secret)_|sk-ant-|sk-|sk_live_|sk_test_)[A-Za-z0-9_-]{6,}/g, '[secret]')
      .replace(/(bearer|apikey|password|token|secret)(["':= ]+)[^\s"',&]+/gi, '$1$2[redacted]')
      .replace(/[0-9][0-9 -]{5,}[0-9]/g, '[number]')
      .slice(0, 500);
  }
  function route() {
    try { return (App.Store && App.Store.state.route && App.Store.state.route.view) || location.pathname; } catch (e) { return location.pathname; }
  }
  // login / checkout problems are the ones that stop students, so they are marked as such
  function kindFor(base) {
    const r = route();
    if (r === 'checkout' || r === 'confirmation') return 'checkout_error';
    if (/login|auth|signup/.test(r) || (App.Store && App.Store.state && App.Store.state.forceAuthView)) return base === 'api_error' ? 'auth_error' : 'login_error';
    return base;
  }

  function report(kind, message, fingerprint, context) {
    try {
      if (sent >= 20) return;
      const fp = String(fingerprint || message || '').slice(0, 120);
      const last = sentAt.get(fp) || 0;
      if (Date.now() - last < 60000) return;
      sentAt.set(fp, Date.now());
      sent++;
      if (!App.sb || busy) return;
      busy = true;
      App.sb.rpc('ops_report_client_error', {
        p_app: APP, p_kind: kindFor(kind), p_message: redact(message), p_route: '/' + route(),
        p_fingerprint: redact(fp), p_context: context || {}, p_correlation: CORRELATION,
      }).then(() => { busy = false; }, () => { busy = false; });
    } catch (e) { busy = false; }
  }

  window.addEventListener('error', (e) => {
    if (!e || !e.message || e.target !== window) return;   // image load errors etc. are not crashes
    const src = String(e.filename || '').replace(location.origin, '').replace(/\?.*$/, '');
    report('error', e.message, e.message + '@' + src + ':' + (e.lineno || ''), { source: src, line: String(e.lineno || ''), online: String(navigator.onLine) });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    const msg = r && (r.message || String(r));
    if (!msg || /AbortError|The user aborted|Failed to fetch dynamically/i.test(msg)) return;
    report('unhandled_rejection', msg, msg, { online: String(navigator.onLine) });
  });

  // Failed requests to Supabase (5xx, or no answer while online). Not 4xx:
  // those are normal answers (wrong password, not allowed, validation).
  if (window.fetch) {
    const realFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = String((input && input.url) || input || '');
      const watched = /supabase\.co\/(rest|functions|auth)\//.test(url) && !/ops_report_client_error/.test(url);
      const p = realFetch(input, init);
      if (!watched) return p;
      const endpoint = url.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '').slice(0, 120);
      return p.then((res) => {
        if (res && res.status >= 500) report('api_error', 'Server error ' + res.status + ' from ' + endpoint, 'http' + res.status + ' ' + endpoint, { status: String(res.status), endpoint, online: String(navigator.onLine) });
        return res;
      }, (err) => {
        if (navigator.onLine) report('network_error', 'Request failed: ' + endpoint, 'net ' + endpoint, { endpoint, online: 'true' });
        throw err;
      });
    };
  }

  return { report, correlationId: CORRELATION };
})();
