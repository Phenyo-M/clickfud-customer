/* ============================================================
   CLICKFUD — Developer dashboard: business registration
   approvals, shop management (archive/delete), promotion
   approvals, and the administrative audit log.
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Developer = (function () {
  const S = App.Store;
  const U = App.Utils;
  const local = { tab: 'applications', rejectingId: null, archivingId: null, deletingStore: null, deleteStep: 1, deleteReason: '', deleteConfirmed: false, auditLog: [] };

  function pending() { return S.state.stores.filter(s => s.status === 'pending'); }
  function reviewed() { return S.state.stores.filter(s => s.status === 'rejected').sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)); }
  function activeShops() { return S.state.stores.filter(s => s.status === 'approved').sort((a, b) => a.name.localeCompare(b.name)); }
  function archivedShops() { return S.state.stores.filter(s => s.status === 'archived').sort((a, b) => new Date(b.archived_at) - new Date(a.archived_at)); }
  function pendingPromos() { return (S.state.storePromotions || []).filter(p => p.status === 'pending'); }
  function reviewedPromos() { return (S.state.storePromotions || []).filter(p => p.status !== 'pending').sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); }

  // ---------------- Applications ----------------
  function applicationCard(store, opts) {
    opts = opts || {};
    return `
    <div class="card card-pad mb-3">
      <div class="flex justify-between items-start" style="flex-wrap:wrap;gap:8px;">
        <div>
          <h3 class="font-bold">${U.escapeHtml(store.name)}</h3>
          <div class="text-sm text-muted">${U.escapeHtml(store.category || '—')} • ${U.escapeHtml(store.university || 'No university set')} • ${U.escapeHtml(store.campus_location || '—')}</div>
        </div>
        <span class="badge ${store.status === 'approved' ? 'badge-success' : store.status === 'rejected' ? 'badge-error' : 'badge-gray'}">${store.status}</span>
      </div>
      ${store.description ? `<p class="text-sm mt-2">${U.escapeHtml(store.description)}</p>` : ''}
      <div class="text-sm mt-2">
        <div><i data-lucide="phone" style="width:13px;height:13px;"></i> ${U.escapeHtml(store.contact_phone || 'Not provided')}</div>
        <div><i data-lucide="mail" style="width:13px;height:13px;"></i> ${U.escapeHtml(store.contact_email || 'Not provided')}</div>
        <div><i data-lucide="badge-check" style="width:13px;height:13px;"></i> ${store.is_registered_business ? `Registered business${store.registration_date ? ' since ' + U.formatDate(store.registration_date) : ''}` : 'Not yet a registered business'}</div>
      </div>
      <div class="text-xs text-muted mt-2">Submitted ${U.formatDateTime(store.created_at)}</div>
      ${store.status === 'rejected' && store.rejection_reason ? `<div class="text-sm mt-2" style="color:var(--color-error);">Reason: ${U.escapeHtml(store.rejection_reason)}</div>` : ''}
      ${opts.actionable ? `
      <div class="flex gap-2 mt-3">
        <button class="btn btn-success btn-sm" data-action="approve-store" data-id="${store.id}"><i data-lucide="check"></i>Approve</button>
        <button class="btn btn-danger btn-sm" data-action="reject-store" data-id="${store.id}"><i data-lucide="x"></i>Reject</button>
      </div>` : ''}
    </div>`;
  }

  function renderApplications() {
    const pendingList = pending();
    const reviewedList = reviewed();
    return `
    <h2 class="section-title mb-2" style="font-size:16px;">Pending Review (${pendingList.length})</h2>
    ${pendingList.length
      ? pendingList.map(s => applicationCard(s, { actionable: true })).join('')
      : `<div class="empty-state"><h3>No pending applications</h3><p class="text-sm">New business registrations will show up here.</p></div>`}
    ${reviewedList.length ? `
    <h2 class="section-title mb-2 mt-4" style="font-size:16px;">Rejected</h2>
    ${reviewedList.map(s => applicationCard(s, { actionable: false })).join('')}` : ''}`;
  }

  // ---------------- Shop management (active + archived) ----------------
  function shopCard(store, opts) {
    opts = opts || {};
    return `
    <div class="card card-pad mb-3">
      <div class="flex justify-between items-start" style="flex-wrap:wrap;gap:8px;">
        <div>
          <h3 class="font-bold">${U.escapeHtml(store.name)}</h3>
          <div class="text-sm text-muted">${U.escapeHtml(store.category || '—')} • ${U.escapeHtml(store.university || 'No university set')} • ${U.escapeHtml(store.campus_location || '—')}</div>
        </div>
        <span class="badge ${store.status === 'approved' ? 'badge-success' : 'badge-gray'}">${store.status}</span>
      </div>
      ${store.status === 'archived' ? `
      <div class="text-sm mt-2" style="color:var(--color-error);">
        <div>Reason: ${U.escapeHtml(store.archived_reason || '—')}</div>
        <div class="text-xs text-muted mt-1">Archived ${store.archived_at ? U.formatDateTime(store.archived_at) : '—'}</div>
      </div>` : ''}
      <div class="flex gap-2 mt-3">
        ${opts.canArchive ? `<button class="btn btn-secondary btn-sm" data-action="archive-store" data-id="${store.id}" data-name="${U.escapeHtml(store.name)}"><i data-lucide="archive"></i>Archive</button>` : ''}
        ${opts.canUnarchive ? `<button class="btn btn-success btn-sm" data-action="unarchive-store" data-id="${store.id}"><i data-lucide="rotate-ccw"></i>Restore to Active</button>` : ''}
        <button class="btn btn-danger btn-sm" data-action="delete-store" data-id="${store.id}" data-name="${U.escapeHtml(store.name)}"><i data-lucide="trash-2"></i>Delete Permanently</button>
      </div>
    </div>`;
  }

  function renderShops() {
    const active = activeShops();
    const archived = archivedShops();
    return `
    <h2 class="section-title mb-2" style="font-size:16px;">Active Shops (${active.length})</h2>
    ${active.length ? active.map(s => shopCard(s, { canArchive: true })).join('') : `<div class="empty-state"><h3>No active shops</h3></div>`}
    ${archived.length ? `
    <h2 class="section-title mb-2 mt-4" style="font-size:16px;">Archived (${archived.length})</h2>
    ${archived.map(s => shopCard(s, { canUnarchive: true })).join('')}` : ''}`;
  }

  // ---------------- Promotions review ----------------
  function promoReviewCard(p, actionable) {
    const store = App.Stores.getById(p.store_id);
    return `
    <div class="card card-pad mb-3">
      <div class="flex justify-between items-start" style="flex-wrap:wrap;gap:8px;">
        <div>
          <h3 class="font-bold">${U.escapeHtml(p.title)}</h3>
          <div class="text-sm text-muted">${store ? U.escapeHtml(store.name) : 'Unknown store'} • ${U.escapeHtml(p.badge)}</div>
        </div>
        <span class="badge ${p.status === 'approved' ? 'badge-success' : p.status === 'rejected' ? 'badge-error' : 'badge-gray'}">${p.status}</span>
      </div>
      ${p.message ? `<p class="text-sm mt-2">${U.escapeHtml(p.message)}</p>` : ''}
      ${p.image_url ? `<img src="${U.escapeHtml(p.image_url)}" alt="" style="width:100%;max-width:280px;border-radius:10px;margin-top:8px;" />` : ''}
      ${actionable ? `
      <div class="flex gap-2 mt-3">
        <button class="btn btn-success btn-sm" data-action="approve-promo" data-id="${p.id}"><i data-lucide="check"></i>Approve</button>
        <button class="btn btn-danger btn-sm" data-action="reject-promo" data-id="${p.id}"><i data-lucide="x"></i>Reject</button>
      </div>` : ''}
    </div>`;
  }

  function renderPromotions() {
    const pendingList = pendingPromos();
    const reviewedList = reviewedPromos();
    return `
    <h2 class="section-title mb-2" style="font-size:16px;">Pending Review (${pendingList.length})</h2>
    ${pendingList.length ? pendingList.map(p => promoReviewCard(p, true)).join('') : `<div class="empty-state"><h3>No pending promotions</h3><p class="text-sm">Homepage placements submitted by shops will show up here.</p></div>`}
    ${reviewedList.length ? `
    <h2 class="section-title mb-2 mt-4" style="font-size:16px;">Reviewed</h2>
    ${reviewedList.map(p => promoReviewCard(p, false)).join('')}` : ''}`;
  }

  // ---------------- Audit log ----------------
  function renderAuditLog() {
    const rows = local.auditLog;
    return `
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>When</th><th>Action</th><th>Target</th><th>By</th><th>Reason</th></tr></thead>
      <tbody>${rows.length ? rows.map(r => `
        <tr>
          <td class="text-xs text-muted">${U.formatDateTime(r.created_at)}</td>
          <td><span class="badge badge-gray">${U.escapeHtml(r.action)}</span></td>
          <td>${U.escapeHtml(r.target_type)}: ${U.escapeHtml(r.target_name || r.target_id)}</td>
          <td class="text-sm">${U.escapeHtml(r.actor_name || '—')}</td>
          <td class="text-sm text-muted">${U.escapeHtml(r.reason || '—')}</td>
        </tr>`).join('') : `<tr><td colspan="5"><div class="empty-state"><h3>No administrative actions yet</h3></div></td></tr>`}</tbody>
    </table></div>`;
  }

  // ---------------- Router ----------------
  const TABS = [
    { key: 'applications', label: 'Applications', icon: 'clipboard-list' },
    { key: 'shops', label: 'Shop Management', icon: 'store' },
    { key: 'promotions', label: 'Promotions', icon: 'megaphone' },
    { key: 'audit', label: 'Audit Log', icon: 'history' },
  ];

  function tabRow() {
    return `<div class="tab-row">${TABS.map(t => `<button class="tab-btn ${local.tab === t.key ? 'active' : ''}" data-action="navigate" data-view="${t.key}"><i data-lucide="${t.icon}"></i>${t.label}</button>`).join('')}</div>`;
  }

  function render() {
    if (S.state.route.view === 'profile') return App.Shared.renderStaffProfile();
    local.tab = TABS.some(t => t.key === S.state.route.view) ? S.state.route.view : 'applications';
    if (local.tab === 'audit' && !local._auditLoaded) {
      local._auditLoaded = true;
      App.Audit.fetchAll().then(rows => { local.auditLog = rows; App.render(); });
    }
    const bodies = { applications: renderApplications, shops: renderShops, promotions: renderPromotions, audit: renderAuditLog };
    return `<div class="page-wrap"><h1 class="page-title mb-3">Developer Dashboard</h1>${tabRow()}${bodies[local.tab]()}</div>`;
  }

  // ---------------- Modals ----------------
  function rejectReasonModal(id) {
    local.rejectingId = id;
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Reject Application</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="reject-reason-form">
          <div class="field"><label>Reason (shown to the applicant)</label><textarea class="input" name="reason" rows="3" placeholder="e.g. Business details could not be verified" required></textarea></div>
          <div class="modal-footer" style="padding:16px 0 0;"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-danger">Reject Application</button></div>
        </form>
      </div>`);
  }

  function archiveReasonModal(id, name) {
    local.archivingId = id;
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Archive "${U.escapeHtml(name)}"</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <p class="text-sm text-muted mb-3">The shop will stop accepting new orders and disappear from the marketplace. Historical orders and reports are kept, and you can restore it any time.</p>
        <form data-form="archive-reason-form">
          <div class="field"><label>Reason for archiving</label><textarea class="input" name="reason" rows="3" placeholder="e.g. Monthly subscription not paid" required></textarea></div>
          <div class="modal-footer" style="padding:16px 0 0;"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Archive Shop</button></div>
        </form>
      </div>`);
  }

  function deleteStoreModal(id, name) {
    local.deletingStore = { id, name };
    local.deleteStep = 1;
    local.deleteReason = '';
    local.deleteConfirmed = false;
    renderDeleteModal();
  }

  function renderDeleteModal() {
    const { id, name } = local.deletingStore;
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Permanently Delete "${U.escapeHtml(name)}"</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <div class="closed-banner mb-3"><i data-lucide="alert-triangle"></i><span>Permanent deletion will remove this shop/account and may affect associated data. This action cannot be easily undone. If this is about suspension, non-payment, or a rule violation, use Archive instead — it's reversible.</span></div>
        <form data-form="delete-store-form">
          <div class="field"><label>Reason for permanent deletion (required)</label><textarea class="input" name="reason" id="delete-reason-input" rows="3" placeholder="e.g. Shop permanently closed and requested account removal." required></textarea></div>
          <label class="checkbox-row mb-2"><input type="checkbox" id="delete-understand-checkbox" /> I understand this action is permanent and cannot be easily undone.</label>
          <div class="field"><label>Type <strong>DELETE SHOP</strong> to confirm</label><input class="input" name="confirm_phrase" id="delete-phrase-input" placeholder="DELETE SHOP" required /></div>
          <div class="modal-footer" style="padding:16px 0 0;"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-danger">Permanently Delete</button></div>
        </form>
      </div>`);
  }

  function handleAction(action, ds) {
    switch (action) {
      case 'approve-store':
        return App.Modal.confirm({
          title: 'Approve this business?', message: 'It will immediately appear on the customer marketplace.',
          confirmLabel: 'Approve', onConfirm: async () => {
            const r = await App.Stores.approve(ds.id);
            if (r.error) App.Toast.error(r.error); else App.Toast.success('Business approved');
          },
        });
      case 'reject-store': return rejectReasonModal(ds.id);
      case 'archive-store': return archiveReasonModal(ds.id, ds.name);
      case 'unarchive-store':
        return App.Modal.confirm({
          title: 'Restore this shop?', message: 'It will become active on the marketplace again.',
          confirmLabel: 'Restore', onConfirm: async () => {
            const r = await App.Stores.unarchive(ds.id);
            if (r.error) App.Toast.error(r.error); else App.Toast.success('Shop restored to active');
          },
        });
      case 'delete-store': return deleteStoreModal(ds.id, ds.name);
      case 'approve-promo':
        return App.Modal.confirm({
          title: 'Approve this placement?', message: 'It will appear in the "Promotions" carousel on the homepage.',
          confirmLabel: 'Approve', onConfirm: async () => {
            const r = await App.Stores.approvePromotion(ds.id);
            if (r.error) App.Toast.error(r.error); else App.Toast.success('Promotion approved');
          },
        });
      case 'reject-promo':
        return App.Modal.confirm({
          title: 'Reject this placement?', message: 'The shop will be able to edit and resubmit it.',
          confirmLabel: 'Reject', variant: 'danger', onConfirm: async () => {
            const r = await App.Stores.rejectPromotion(ds.id, 'Not approved for the homepage.');
            if (r.error) App.Toast.error(r.error); else App.Toast.success('Promotion rejected');
          },
        });
      default: return;
    }
  }

  async function handleSubmit(formId, data) {
    if (formId === 'reject-reason-form') {
      const r = await App.Stores.reject(local.rejectingId, data.get('reason'));
      if (r.error) { App.Toast.error(r.error); return; }
      App.Modal.close();
      App.Toast.success('Application rejected');
    } else if (formId === 'archive-reason-form') {
      const r = await App.Stores.archive(local.archivingId, data.get('reason'));
      if (r.error) { App.Toast.error(r.error); return; }
      App.Modal.close();
      App.Toast.success('Shop archived');
    } else if (formId === 'delete-store-form') {
      const reason = (data.get('reason') || '').trim();
      const phrase = (data.get('confirm_phrase') || '').trim();
      const understood = document.getElementById('delete-understand-checkbox').checked;
      if (!reason) { App.Toast.error('Please explain why this shop is being permanently deleted.'); return; }
      if (!understood) { App.Toast.error('Please confirm you understand this action is permanent.'); return; }
      if (phrase !== 'DELETE SHOP') { App.Toast.error('Please type DELETE SHOP exactly to confirm.'); return; }
      const { id, name } = local.deletingStore;
      const r = await App.Stores.deletePermanently(id, name, reason);
      if (r.error) { App.Toast.error(r.error); return; }
      App.Modal.close();
      App.Toast.success(`"${name}" has been permanently deleted`);
    }
  }

  return { render, handleAction, handleSubmit, local };
})();
