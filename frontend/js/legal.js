/* ============================================================
   CLICKFOOD, Privacy Policy and Terms inside the app

   The text lives only in legal/privacy-policy.html and
   legal/terms-of-service.html (also opened on their own, e.g. from the
   sign-up form). This shows the same file's <main id="doc"> as an app
   screen with the normal back arrow, and asks a signed-in person to agree
   when the versions change (supabase/privacy_legal.sql: every acceptance
   is a new row, older ones are kept).
   ============================================================ */
window.App = window.App || {};

App.Legal = (function () {
  const S = App.Store;
  const DOCS = { privacy: { file: 'legal/privacy-policy.html', title: 'Privacy Policy' }, terms: { file: 'legal/terms-of-service.html', title: 'Terms of Service' } };
  const cache = {};
  const failed = {};
  let pending = false;   // new versions not agreed yet

  function load(doc) {
    if (cache[doc] || failed[doc] === 'loading') return;
    failed[doc] = 'loading';
    fetch(DOCS[doc].file + '?v=' + encodeURIComponent((window.CLICKFOOD_BUILD || '20261018a')), { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
      .then(html => {
        const d = new DOMParser().parseFromString(html, 'text/html');
        const main = d.getElementById('doc');
        if (!main) throw new Error('no #doc');
        main.querySelectorAll('script, style, link').forEach(n => n.remove());
        cache[doc] = main.innerHTML;
        failed[doc] = null;
        App.render();
      })
      .catch(() => { failed[doc] = 'error'; App.render(); });
  }

  // the "legal" view: params.id = 'privacy' | 'terms'
  function render(params) {
    const doc = DOCS[(params || {}).id] ? params.id : 'privacy';
    if (!cache[doc]) load(doc);
    const body = cache[doc]
      ? cache[doc].replace(/<h1[^>]*>[\s\S]*?<\/h1>/, '')
      : failed[doc] === 'error'
        ? `<div class="empty-state"><h3>Couldn't load this page</h3><button type="button" class="btn btn-secondary btn-sm mt-2" data-action="legal-retry" data-id="${doc}">Try again</button></div>`
        : '<div class="skeleton" style="height:240px;"></div>';
    const agree = pending && cache[doc] ? '<div class="legal-agree"><button type="button" class="btn btn-primary btn-block" data-action="legal-accept">I agree to the Terms and Privacy Policy</button></div>' : '';
    return `<div class="page-wrap" style="max-width:720px;">${App.Nav.pageHead(DOCS[doc].title, 'more')}<article class="legal-doc">${body}</article>${agree}</div>`;
  }
  function retry(doc) { failed[doc] = null; load(doc); }

  // after sign-in: agree to new versions once
  let asked = false;
  async function afterSignIn() {
    if (asked || !S.state.profile || S.state.profile._fromOfflineCache) return;
    // not on top of the first sign-in setup: ask once it is finished
    if (App.Auth.needsCampusSetup(S.state.profile)) { setTimeout(afterSignIn, 2000); return; }
    asked = true;
    const { data, error } = await App.sb.rpc('my_legal_status');
    if (error || !data || (!data.terms && !data.privacy)) return;
    const meta = (S.state.session && S.state.session.user && S.state.session.user.user_metadata) || {};
    // signed up with these versions (the sign-up form says so): record it
    if (meta.legal_version && data.versions && meta.legal_version === data.versions.terms && meta.legal_version === data.versions.privacy) {
      await App.sb.rpc('accept_legal');
      return;
    }
    pending = true;
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Updated Terms and Privacy Policy</span></div>
      <div class="modal-body">
        <p class="text-sm mb-3">Please read and agree to continue.</p>
        <div class="flex gap-2" style="flex-wrap:wrap;">
          <button type="button" class="btn btn-secondary btn-sm" data-action="legal-open" data-id="terms">Terms of Service</button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="legal-open" data-id="privacy">Privacy Policy</button>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" data-action="close-modal">Later</button>
        <button type="button" class="btn btn-primary" data-action="legal-accept">I agree</button>
      </div>`, { size: 'sm' });
  }
  async function accept(el) {
    if (el) el.classList.add('btn-loading');
    const { data, error } = await App.sb.rpc('accept_legal');
    if (el) el.classList.remove('btn-loading');
    if (error || !data || !data.ok) return App.Toast.error('Could not save. Please try again.');
    pending = false;
    App.Modal.close();
    App.Toast.success('Thanks');
    App.render();
  }
  function reset() { asked = false; pending = false; }

  function handleAction(action, ds, el) {
    if (action === 'legal-open') { App.Modal.close(); return S.setRoute({ view: 'legal', params: { id: ds.id } }); }
    if (action === 'legal-accept') return accept(el);
    if (action === 'legal-retry') return retry(ds.id);
  }

  return { render, afterSignIn, handleAction, reset };
})();
