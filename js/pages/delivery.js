/* ============================================================
   CLICKFUD — Delivery (driver) dashboard
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Delivery = (function () {
  const S = App.Store;
  const U = App.Utils;
  const codState = {};

  function estDistanceKm(order) {
    const fee = Number(order.delivery_fee) || 5;
    return Math.round((0.3 + fee / 10) * 10) / 10;
  }

  function statusBar() {
    const status = S.state.profile.driver_status || 'offline';
    const opts = [
      { key: 'available', icon: 'check-circle-2', label: 'Available' },
      { key: 'busy', icon: 'clock', label: 'Busy' },
      { key: 'offline', icon: 'power-off', label: 'Offline' },
    ];
    return `<div class="status-select-row mb-4">
      ${opts.map(o => `<button class="status-pill-btn ${status === o.key ? 'active' : ''}" data-action="set-driver-status" data-status="${o.key}"><i data-lucide="${o.icon}"></i>${o.label}</button>`).join('')}
    </div>`;
  }

  function availableCard(order) {
    const store = App.Stores.getById(order.store_id);
    return `
    <div class="card delivery-card">
      <div class="flex justify-between items-center mb-2"><span class="font-bold">${U.escapeHtml(order.order_number)}</span><span class="font-bold text-primary-c">${U.money(order.total)}</span></div>
      <div class="route-row"><div class="route-dot"></div><span>Pickup: ${U.escapeHtml(store ? store.name : 'Store')}${store ? ' · ' + U.escapeHtml(store.campus_location) : ''}</span></div>
      <div class="route-line-v"></div>
      <div class="route-row"><div class="route-dot" style="background:var(--color-success)"></div><span>Deliver to: ${U.escapeHtml(order.delivery_location.building || '')}, Rm ${U.escapeHtml(order.delivery_location.room || '')}</span></div>
      <div class="flex gap-2 mt-2 text-xs text-muted">
        <span><i data-lucide="route" style="width:12px;height:12px"></i> ${estDistanceKm(order)} km</span>
        <span><i data-lucide="clock" style="width:12px;height:12px"></i> ~${App.CONST.ETA_MINUTES} min</span>
        <span><i data-lucide="wallet" style="width:12px;height:12px"></i> ${order.payment_method === 'cod' ? 'Cash on Delivery' : 'Card (Paid)'}</span>
      </div>
      <button class="btn btn-primary btn-block mt-3" data-action="accept-delivery" data-id="${order.id}"><i data-lucide="bike"></i>Accept Delivery</button>
    </div>`;
  }

  function codCalculator(order) {
    const s = codState[order.id] || (codState[order.id] = { tendered: '' });
    const result = s.tendered !== '' ? App.Orders.calcChange(order.total, s.tendered) : null;
    return `
    <div class="cod-calc card card-pad mt-2">
      <h4 class="font-semibold text-sm mb-2">Cash on Delivery Calculator</h4>
      <div class="field"><label>Order Total</label><input class="input" value="${U.money(order.total)}" disabled /></div>
      <div class="field"><label>Cash Tendered</label><input class="input" id="cod-tendered-${order.id}" type="number" step="0.01" min="0" data-action-input="cod-tendered" data-id="${order.id}" value="${s.tendered}" placeholder="e.g. 100.00" /></div>
      ${result ? `<div class="cod-result ${result.insufficient ? 'bad' : 'ok'}">${result.insufficient ? 'Insufficient Cash' : result.exact ? 'Exact Payment ✓' : `Change to Return: ${U.money(result.change)}`}</div>` : ''}
    </div>`;
  }

  function activeCard(order) {
    const mins = Math.max(0, U.minutesUntil(order.eta));
    const store = App.Stores.getById(order.store_id);
    return `
    <div class="card delivery-card">
      <div class="flex justify-between items-center mb-2"><span class="font-bold">${U.escapeHtml(order.order_number)}</span><span class="badge badge-primary">Out for Delivery</span></div>
      ${store ? `<div class="text-sm mb-1"><strong>From:</strong> ${U.escapeHtml(store.name)}</div>` : ''}
      <div class="text-sm mb-1"><strong>Deliver to:</strong> ${U.escapeHtml(order.delivery_location.building || '')}, Rm ${U.escapeHtml(order.delivery_location.room || '')}</div>
      <div class="text-sm mb-1"><strong>Phone:</strong> ${U.escapeHtml(order.delivery_location.phone || '')}</div>
      <div class="text-sm mb-1"><strong>ETA:</strong> ${mins} min</div>
      <div class="text-sm mb-1"><strong>Total:</strong> ${U.money(order.total)} (${order.payment_method === 'cod' ? 'Cash on Delivery' : 'Card'})</div>
      ${order.payment_method === 'cod' ? codCalculator(order) : ''}
      <button class="btn btn-success btn-block mt-3" data-action="mark-delivered" data-id="${order.id}"><i data-lucide="check-check"></i>Mark as Delivered</button>
    </div>`;
  }

  function tabRow(active) {
    return `<div class="tab-row">
      <button class="tab-btn ${active === 'available' ? 'active' : ''}" data-action="navigate" data-view="available"><i data-lucide="list"></i>Available</button>
      <button class="tab-btn ${active === 'active' ? 'active' : ''}" data-action="navigate" data-view="active"><i data-lucide="bike"></i>Active Deliveries</button>
    </div>`;
  }

  function renderAvailable() {
    const available = S.state.orders.filter(o => o.status === 'ready' && !o.assigned_driver);
    const isAvailable = S.state.profile.driver_status === 'available';
    return `
    <div class="page-wrap">
      <h1 class="page-title mb-3">Available Deliveries</h1>
      ${tabRow('available')}
      ${statusBar()}
      ${!isAvailable ? `<div class="empty-state"><div class="icon-wrap"><i data-lucide="power-off"></i></div><h3>You're currently ${U.escapeHtml(S.state.profile.driver_status)}</h3><p>Set your status to Available to see new deliveries.</p></div>`
        : available.length ? `<div class="grid grid-menu">${available.map(availableCard).join('')}</div>`
        : `<div class="empty-state"><div class="icon-wrap"><i data-lucide="package-x"></i></div><h3>No deliveries available right now</h3><p>Check back soon.</p></div>`}
    </div>`;
  }

  function renderActive() {
    const mine = S.state.orders.filter(o => o.assigned_driver === S.state.profile.id && o.status === 'out_for_delivery');
    return `
    <div class="page-wrap">
      <h1 class="page-title mb-3">Active Deliveries</h1>
      ${tabRow('active')}
      ${mine.length ? `<div class="grid grid-menu">${mine.map(activeCard).join('')}</div>` : `<div class="empty-state"><div class="icon-wrap"><i data-lucide="bike"></i></div><h3>No active deliveries</h3><p>Accept a delivery to get started.</p></div>`}
    </div>`;
  }

  function renderProfile() {
    const st = S.state.profile.driver_status || 'offline';
    const extra = `<div class="field"><label>Driver Status</label><select class="select" name="driver_status">
      <option value="available" ${st === 'available' ? 'selected' : ''}>Available</option>
      <option value="busy" ${st === 'busy' ? 'selected' : ''}>Busy</option>
      <option value="offline" ${st === 'offline' ? 'selected' : ''}>Offline</option>
    </select></div>`;
    return App.Shared.renderStaffProfile(extra);
  }

  function render() {
    const view = S.state.route.view;
    if (view === 'profile') return renderProfile();
    return view === 'active' ? renderActive() : renderAvailable();
  }

  function handleAction(action, ds) {
    const order = S.state.orders.find(o => o.id === ds.id);
    switch (action) {
      case 'set-driver-status': return App.Auth.updateProfile({ driver_status: ds.status }).then(r => r.error ? App.Toast.error(r.error) : App.Toast.success('Status updated'));
      case 'accept-delivery': return App.Orders.acceptDelivery(order).then(r => r.error ? App.Toast.error(r.error) : App.Toast.success('Delivery accepted'));
      case 'mark-delivered': return App.Modal.confirm({
        title: 'Confirm Delivery', message: 'Are you sure this order has been delivered?', variant: 'info', confirmLabel: 'Yes, Delivered',
        onConfirm: async () => {
          const s = codState[order.id];
          const res = await App.Orders.markDelivered(order, s ? s.tendered : undefined);
          if (res.error) App.Toast.error(res.error); else App.Toast.success('Order marked as delivered');
        },
      });
      default: return;
    }
  }

  function handleInput(kind, value, ds) {
    if (kind === 'cod-tendered') { codState[ds.id] = codState[ds.id] || {}; codState[ds.id].tendered = value; App.render(); }
  }

  async function handleSubmit(formId, data) {
    if (formId === 'staff-profile-form') return App.Shared.handleStaffProfileSubmit(data);
  }

  return { render, handleAction, handleInput, handleSubmit };
})();
