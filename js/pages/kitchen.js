/* ============================================================
   CLICKFUD — Kitchen dashboard: order-ticket kanban board
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Kitchen = (function () {
  const S = App.Store;
  const U = App.Utils;

  function estPrepTime(order) {
    return Math.max(10, ...(order.items || []).map(it => {
      const m = S.state.menu.find(mi => mi.id === it.menuItemId);
      return m ? m.preparation_time : 15;
    }));
  }

  function priorityRow(order) {
    return `<div class="priority-select">
      ${['normal', 'high', 'urgent'].map(p => `<button class="priority-btn ${order.priority === p ? 'active ' + p : ''}" data-action="set-priority" data-id="${order.id}" data-priority="${p}">${p}</button>`).join('')}
    </div>`;
  }

  function ticket(order) {
    const anyInstructions = (order.items || []).find(it => it.specialInstructions);
    let actionBtn = '';
    if (order.status === 'received') actionBtn = `<button class="btn btn-primary btn-sm btn-block mt-2" data-action="start-preparing" data-id="${order.id}"><i data-lucide="flame"></i>Start Preparing</button>`;
    else if (order.status === 'preparing') actionBtn = `<button class="btn btn-success btn-sm btn-block mt-2" data-action="mark-ready" data-id="${order.id}"><i data-lucide="check"></i>Mark Order Ready</button>`;
    else if (order.status === 'ready') actionBtn = `<button class="btn btn-secondary btn-sm btn-block mt-2" data-action="dispatch-drivers" data-id="${order.id}"><i data-lucide="send"></i>Dispatch to Drivers</button>`;

    return `
    <div class="ticket priority-${order.priority}">
      <div class="ticket-head">
        <span class="font-bold">${U.escapeHtml(order.order_number)}</span>
        <span class="text-xs text-muted">${U.formatTime(order.created_at)}</span>
      </div>
      <div class="text-xs text-muted">Est. ${estPrepTime(order)} min</div>
      <ul class="ticket-items">
        ${(order.items || []).map(it => `<li><span>${it.qty}x ${U.escapeHtml(it.name)}</span></li>`).join('')}
      </ul>
      ${anyInstructions ? (order.items || []).filter(it => it.specialInstructions).map(it => `<div class="ticket-note"><i data-lucide="message-square" style="width:12px;height:12px"></i> ${U.escapeHtml(it.name)}: "${U.escapeHtml(it.specialInstructions)}"</div>`).join('') : ''}
      ${priorityRow(order)}
      ${actionBtn}
    </div>`;
  }

  function column(title, icon, orders) {
    return `
    <div class="kanban-col">
      <div class="kanban-col-title"><span><i data-lucide="${icon}" style="width:14px;height:14px"></i> ${title}</span><span class="badge badge-gray">${orders.length}</span></div>
      ${orders.length ? orders.map(ticket).join('') : `<div class="empty-state" style="padding:24px 8px;"><p class="text-sm">No orders here.</p></div>`}
    </div>`;
  }

  // Reusable board markup — RLS already scopes S.state.orders to the
  // caller's own store for both the 'kitchen' and 'manager' roles, so this
  // is safe to embed directly inside the Manager dashboard's Kitchen tab.
  function renderBoard() {
    const orders = S.state.orders.slice().sort((a, b) => {
      const rank = { urgent: 0, high: 1, normal: 2 };
      return rank[a.priority] - rank[b.priority] || new Date(a.created_at) - new Date(b.created_at);
    });
    const newOrders = orders.filter(o => o.status === 'received');
    const preparing = orders.filter(o => o.status === 'preparing');
    const ready = orders.filter(o => o.status === 'ready');
    return `
    <div class="kanban">
      ${column('New Orders', 'inbox', newOrders)}
      ${column('Preparing', 'flame', preparing)}
      ${column('Ready', 'package-check', ready)}
    </div>`;
  }

  function render() {
    if (S.state.route.view === 'profile') return App.Shared.renderStaffProfile();
    const myStore = App.Stores.myStore();
    return `
    <div class="page-wrap">
      <h1 class="page-title mb-1">Kitchen Board</h1>
      ${myStore ? `<p class="text-muted text-sm mb-4">${U.escapeHtml(myStore.name)}</p>` : ''}
      ${renderBoard()}
    </div>`;
  }

  function handleAction(action, ds) {
    const order = S.state.orders.find(o => o.id === ds.id);
    switch (action) {
      case 'start-preparing': return App.Orders.startPreparing(order).then(r => r.error ? App.Toast.error(r.error) : App.Toast.success('Order status updated'));
      case 'mark-ready': return App.Orders.markReady(order).then(r => r.error ? App.Toast.error(r.error) : App.Toast.success('Order status updated'));
      case 'dispatch-drivers': return App.Orders.dispatchToDrivers(order).then(r => r.error ? App.Toast.error(r.error) : App.Toast.success(`Notified ${r.count} available driver(s)`));
      case 'set-priority': return App.Orders.setPriority(order, ds.priority).then(r => r.error && App.Toast.error(r.error));
      default: return;
    }
  }

  async function handleSubmit(formId, data) {
    if (formId === 'staff-profile-form') return App.Shared.handleStaffProfileSubmit(data);
  }

  return { render, renderBoard, handleAction, handleSubmit };
})();
