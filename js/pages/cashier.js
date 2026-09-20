/* ============================================================
   CLICKFUD — Cashier (POS) dashboard
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Cashier = (function () {
  const S = App.Store;
  const U = App.Utils;
  const local = { filter: 'pending', profilesCache: {}, cashInputs: {} };

  function ensureProfiles(ids) {
    const missing = [...new Set(ids)].filter(id => id && !local.profilesCache[id]);
    if (!missing.length) return;
    App.sb.from('profiles').select('id,name').in('id', missing).then(({ data }) => {
      (data || []).forEach(p => local.profilesCache[p.id] = p);
      App.render();
    });
  }

  function row(order) {
    const customer = local.profilesCache[order.customer_id];
    const isCod = order.payment_method === 'cod';
    const cashVal = local.cashInputs[order.id] !== undefined ? local.cashInputs[order.id] : '';
    const result = isCod && cashVal !== '' ? App.Orders.calcChange(order.total, cashVal) : null;
    return `
    <div class="card card-pad mb-3">
      <div class="flex justify-between items-center">
        <div>
          <span class="font-bold">${U.escapeHtml(order.order_number)}</span>
          <span class="text-sm text-muted"> · ${customer ? U.escapeHtml(customer.name) : '...'}</span>
        </div>
        <span class="badge ${order.payment_status === 'paid' ? 'badge-success' : 'badge-yellow'}">${order.payment_status}</span>
      </div>
      <div class="flex gap-3 text-sm text-muted mt-1" style="flex-wrap:wrap;">
        <span><i data-lucide="receipt" style="width:12px;height:12px"></i> ${U.money(order.total)}</span>
        <span><i data-lucide="wallet" style="width:12px;height:12px"></i> ${isCod ? 'Cash on Delivery' : 'Card'}</span>
        <span><i data-lucide="tag" style="width:12px;height:12px"></i> ${App.CONST.STATUS_LABELS[order.status]}</span>
      </div>
      ${isCod && order.payment_status !== 'paid' ? `
      <div class="flex gap-2 items-end mt-3" style="flex-wrap:wrap;">
        <div class="field" style="margin:0;flex:1;min-width:140px;"><label>Cash Received</label><input class="input" id="cashier-cash-${order.id}" type="number" step="0.01" min="0" data-action-input="cashier-cash" data-id="${order.id}" value="${cashVal}" placeholder="R0.00" /></div>
        <button class="btn btn-success" data-action="confirm-payment" data-id="${order.id}"><i data-lucide="check"></i>Confirm Payment</button>
        <button class="btn btn-secondary" data-action="payment-pending" data-id="${order.id}">Payment Pending</button>
      </div>
      ${result ? `<div class="cod-result ${result.insufficient ? 'bad' : 'ok'}">${result.insufficient ? 'Insufficient Cash' : result.exact ? 'Exact Payment ✓' : `Change Required: ${U.money(result.change)}`}</div>` : ''}
      ` : ''}
    </div>`;
  }

  function render() {
    if (S.state.route.view === 'profile') return App.Shared.renderStaffProfile();
    const orders = S.state.orders.filter(o => o.status !== 'cancelled').filter(o => {
      if (local.filter === 'all') return true;
      return o.payment_status === local.filter;
    }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    ensureProfiles(orders.map(o => o.customer_id));
    const myStore = App.Stores.myStore();
    return `
    <div class="page-wrap" style="max-width:760px;">
      <h1 class="page-title mb-1">Cashier — Payments</h1>
      ${myStore ? `<p class="text-muted text-sm mb-3">${U.escapeHtml(myStore.name)}</p>` : ''}
      <div class="filter-bar">
        ${['pending', 'paid', 'all'].map(f => `<button class="chip ${local.filter === f ? 'active' : ''}" data-action="cashier-filter" data-key="${f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}
      </div>
      ${orders.length ? orders.map(row).join('') : `<div class="empty-state"><div class="icon-wrap"><i data-lucide="banknote"></i></div><h3>No orders here</h3></div>`}
    </div>`;
  }

  function handleAction(action, ds) {
    const order = S.state.orders.find(o => o.id === ds.id);
    switch (action) {
      case 'cashier-filter': local.filter = ds.key; return App.render();
      case 'confirm-payment': {
        const cash = local.cashInputs[ds.id];
        if (order.payment_method === 'cod' && (cash === undefined || cash === '')) { App.Toast.error('Please enter the cash received.'); return; }
        if (order.payment_method === 'cod') {
          const result = App.Orders.calcChange(order.total, cash);
          if (result.insufficient) { App.Toast.error('Insufficient Cash'); return; }
        }
        return App.Orders.confirmPayment(order, cash).then(r => r.error ? App.Toast.error(r.error) : App.Toast.success('Payment confirmed'));
      }
      case 'payment-pending': return App.sb.from('orders').update({ payment_status: 'pending' }).eq('id', order.id).select().single().then(({ data, error }) => {
        if (error) return App.Toast.error(error.message);
        S.upsertIn('orders', data);
        App.Toast.info('Payment marked as pending');
      });
      default: return;
    }
  }

  function handleInput(kind, value, ds) {
    if (kind === 'cashier-cash') { local.cashInputs[ds.id] = value; App.render(); }
  }

  async function handleSubmit(formId, data) {
    if (formId === 'staff-profile-form') return App.Shared.handleStaffProfileSubmit(data);
  }

  return { render, handleAction, handleInput, handleSubmit };
})();
