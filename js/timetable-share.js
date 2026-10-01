/* ============================================================
   CLICKFUD — share My Timetable with friends

   Sharing: "Share" on My Timetable creates a link
   (…/?timetable=<id>) and opens the phone's share sheet (WhatsApp etc.),
   with WhatsApp / Copy link fallbacks.

   Receiving: opening the link saves it (so it survives having to log in
   or sign up first), shows who shared it and their classes, and lets the
   student use it — "Add to my timetable" (keeps their own classes, skips
   duplicates) or "Replace my timetable". The classes are copied into
   their own timetable, so reminders/directions/editing work as normal.
   Data layer + privacy rules: js/timetable.js, supabase/timetable_sharing.sql.
   ============================================================ */
window.App = window.App || {};

App.TimetableShare = (function () {
  const S = App.Store;
  const U = App.Utils;
  const PENDING_KEY = 'cfe_pending_timetable_share';
  const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const local = { busy: false, guestShownFor: null, guestModalOpen: false, lastLink: null, preview: null };

  // ---------------- pending link (survives login/sign-up) ----------------
  function savePending(id) { try { localStorage.setItem(PENDING_KEY, JSON.stringify({ id, savedAt: Date.now() })); } catch (e) {} }
  function clearPending() { try { localStorage.removeItem(PENDING_KEY); } catch (e) {} local.preview = null; local.guestShownFor = null; }
  function pendingId() {
    try {
      const raw = localStorage.getItem(PENDING_KEY); if (!raw) return null;
      const { id, savedAt } = JSON.parse(raw);
      if (!id || Date.now() - savedAt > PENDING_MAX_AGE_MS) { clearPending(); return null; }
      return id;
    } catch (e) { return null; }
  }

  // Called once at boot (js/app.js): read ?timetable=<id>, remember it, and
  // strip it from the address bar so a later refresh doesn't re-trigger it.
  function parseLink() {
    const url = new URL(window.location.href);
    const id = url.searchParams.get('timetable');
    if (!id) return;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) savePending(id);
    url.searchParams.delete('timetable');
    history.replaceState({}, '', url.pathname + url.search + url.hash);
  }

  function linkFor(id) { return `${window.location.origin}/?timetable=${id}`; }
  function shareMessage(link) {
    const name = S.state.profile && S.state.profile.name ? S.state.profile.name.split(' ')[0] : 'I';
    return `${name === 'I' ? "Here's my" : name + "'s"} class timetable on clickFud 📅 — tap to use it: ${link}`;
  }

  // ---------------- owner: create + share ----------------
  async function openShareSheet() {
    if (!S.state.connection.online) { App.Toast.error('You are offline. Connect to the internet to share your timetable.'); return; }
    if (local.busy) return;
    local.busy = true;
    const btn = document.querySelector('[data-action="ttshare-open"]');
    if (btn) btn.classList.add('btn-loading');
    const res = await App.Timetable.createShare();
    local.busy = false;
    if (btn) btn.classList.remove('btn-loading');
    if (res.error) { App.Toast.error(res.error); return; }
    const link = linkFor(res.id);
    local.lastLink = link;
    const msg = shareMessage(link);
    const count = (S.state.timetable || []).length;
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Share your timetable</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <p class="text-sm text-muted mb-3">Friends who open this link can copy your ${count} class${count === 1 ? '' : 'es'} into their own timetable. Your notes stay private, and later changes you make aren't shared. The link works for 30 days.</p>
        <div class="tt-share-link" id="tt-share-link">${U.escapeHtml(link)}</div>
        <div class="tt-share-actions">
          ${navigator.share ? `<button type="button" class="btn btn-primary btn-block" data-action="ttshare-native"><i data-lucide="share-2"></i> Share…</button>` : ''}
          <a class="btn btn-whatsapp btn-block" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener"><i data-lucide="message-circle"></i> Send on WhatsApp</a>
          <button type="button" class="btn btn-secondary btn-block" data-action="ttshare-copy"><i data-lucide="copy"></i> Copy link</button>
        </div>
      </div>`);
  }
  async function nativeShare() {
    if (!local.lastLink || !navigator.share) return;
    try { await navigator.share({ title: 'My clickFud timetable', text: shareMessage(local.lastLink), url: local.lastLink }); }
    catch (e) { /* cancelled by the user — nothing to do */ }
  }
  async function copyLink() {
    if (!local.lastLink) return;
    try { await navigator.clipboard.writeText(shareMessage(local.lastLink)); App.Toast.success('Link copied — paste it in any chat.'); }
    catch (e) {
      const el = document.getElementById('tt-share-link');
      if (el) { const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
      App.Toast.info('Press and hold the link to copy it.');
    }
  }

  // ---------------- receiver: preview + accept ----------------
  function previewList(entries) {
    const byDay = {};
    (entries || []).forEach(e => { (byDay[e.day_of_week] = byDay[e.day_of_week] || []).push(e); });
    return DAY_ORDER.filter(d => byDay[d]).map(d => `
      <div class="tt-share-day">
        <div class="tt-share-day-name">${DAYS[d]}</div>
        ${byDay[d].map(e => `
          <div class="tt-share-class">
            <span class="tt-share-time">${U.escapeHtml(e.start_time)}–${U.escapeHtml(e.end_time)}</span>
            <span><strong>${U.escapeHtml(e.module)}</strong>${e.module_code ? ' · ' + U.escapeHtml(e.module_code) : ''} <span class="text-muted">· ${U.escapeHtml(e.class_type)} · ${U.escapeHtml(e.venue)}</span></span>
          </div>`).join('')}
      </div>`).join('');
  }

  // Runs on every state change (js/app.js) — cheap unless a link is pending.
  async function checkPending() {
    const id = pendingId();
    if (!id || local.busy || !S.state.authReady) return;
    // Signed in while our signed-out preview was still open (any sign-in
    // route): swap it for the real "use this timetable" preview.
    if (S.state.profile && local.guestModalOpen) { local.guestModalOpen = false; App.Modal.close(); }
    if (App.Modal.isOpen()) return;                          // e.g. payment confirmation — try again next change
    const profile = S.state.profile;
    if (profile && App.Auth.needsCampusSetup(profile)) return; // campus setup first
    if (profile && S.state.privateDataFor !== profile.id) return; // wait until their timetable has loaded
    if (!profile && local.guestShownFor === id) return;

    local.busy = true;
    try {
      if (!local.preview || local.preview.id !== id) {
        const res = await App.Timetable.getShare(id);
        if (res.error) { App.Toast.error(res.error); return; }
        if (!res.share) { clearPending(); App.Toast.error('This timetable link has expired or is no longer available. Ask your friend to share it again.'); return; }
        local.preview = { id, ...res.share };
      }
      const p = local.preview;
      if (App.Modal.isOpen()) return;
      const header = `<div class="modal-header"><span class="modal-title">📅 ${U.escapeHtml(p.owner_name)} shared a timetable</span><button class="modal-close" data-action="ttshare-dismiss"><i data-lucide="x"></i></button></div>`;
      const intro = `<p class="text-sm text-muted mb-2">${p.class_count} class${p.class_count === 1 ? '' : 'es'} a week. Using it copies these classes into your own timetable — you get class reminders and can edit them any time.</p>`;
      if (!profile) {
        local.guestShownFor = id;
        local.guestModalOpen = true;
        App.Modal.open(`${header}<div class="modal-body">${intro}<div class="tt-share-preview">${previewList(p.entries)}</div>
          <p class="text-sm mt-3 mb-3">Log in or create a free account to use this timetable.</p>
          <div class="tt-share-actions">
            <button type="button" class="btn btn-primary btn-block" data-action="ttshare-login">Log In</button>
            <button type="button" class="btn btn-secondary btn-block" data-action="ttshare-signup">Create Account</button>
          </div></div>`, { closeOnOverlay: false });
        return;
      }
      if (p.is_own) { clearPending(); App.Toast.info("That's your own timetable link — send it to a friend so they can use it."); return; }
      const hasOwn = (S.state.timetable || []).length > 0;
      App.Modal.open(`${header}<div class="modal-body">${intro}<div class="tt-share-preview">${previewList(p.entries)}</div>
        <div class="tt-share-actions mt-3">
          ${hasOwn ? `
            <button type="button" class="btn btn-primary btn-block" data-action="ttshare-accept" data-mode="add"><i data-lucide="plus"></i> Add to my timetable</button>
            <button type="button" class="btn btn-secondary btn-block" data-action="ttshare-accept" data-mode="replace"><i data-lucide="refresh-cw"></i> Replace my timetable</button>
            <p class="text-xs text-muted" style="text-align:center;">"Add" keeps your ${(S.state.timetable || []).length} current class${(S.state.timetable || []).length === 1 ? '' : 'es'} and skips duplicates. "Replace" removes them first.</p>`
          : `<button type="button" class="btn btn-primary btn-block" data-action="ttshare-accept" data-mode="add"><i data-lucide="check"></i> Use this timetable</button>`}
          <button type="button" class="btn btn-ghost btn-block" data-action="ttshare-dismiss">Not now</button>
        </div></div>`, { closeOnOverlay: false });
    } finally {
      local.busy = false;
    }
  }

  async function accept(mode) {
    const id = pendingId();
    if (!id || local.busy) return;
    if (mode === 'replace') {
      const n = (S.state.timetable || []).length;
      if (!window.confirm(`Replace your timetable? Your ${n} current class${n === 1 ? '' : 'es'} will be removed.`)) return;
    }
    if (!S.state.connection.online) { App.Toast.error('You are offline. Connect to the internet to add this timetable.'); return; }
    local.busy = true;
    document.querySelectorAll('[data-action="ttshare-accept"]').forEach(b => b.classList.add('btn-loading'));
    const res = await App.Timetable.acceptShare(id, mode);
    local.busy = false;
    if (res.error) {
      document.querySelectorAll('[data-action="ttshare-accept"]').forEach(b => b.classList.remove('btn-loading'));
      if (/expired|no longer|own timetable/i.test(res.error)) { clearPending(); App.Modal.close(); }
      App.Toast.error(res.error);
      return;
    }
    const owner = local.preview ? local.preview.owner_name : 'your friend';
    clearPending();
    App.Modal.close();
    S.setRoute({ view: 'timetable', params: {} });
    App.forceScrollTop();
    App.Toast.success(res.added > 0
      ? `Added ${res.added} class${res.added === 1 ? '' : 'es'} from ${owner}'s timetable.`
      : `You already have all of ${owner}'s classes.`);
  }

  function handleAction(action, ds) {
    if (/^ttshare-(login|signup|dismiss)$/.test(action)) local.guestModalOpen = false;
    switch (action) {
      case 'ttshare-open': return openShareSheet();
      case 'ttshare-native': return nativeShare();
      case 'ttshare-copy': return copyLink();
      case 'ttshare-accept': return accept(ds.mode === 'replace' ? 'replace' : 'add');
      case 'ttshare-dismiss': clearPending(); return App.Modal.close();
      case 'ttshare-login':
      case 'ttshare-signup':
        // keep the link pending — it reopens right after they sign in
        App.Modal.close();
        S.set({ forceAuthView: true });
        return App.Pages.Auth.setTab(action === 'ttshare-login' ? 'login' : 'signup');
      default: return;
    }
  }

  return { parseLink, checkPending, handleAction, openShareSheet };
})();
