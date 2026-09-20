/* ============================================================
   CLICKFUD — Manager dashboard
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Manager = (function () {
  const S = App.Store;
  const U = App.Utils;

  const local = {
    tab: 'dashboard',
    orderFilter: 'all', selectedOrderId: null,
    profilesCache: {},
    reportFrom: null, reportTo: null,
    menuFormId: null, storePromoFormId: null, reapplying: false,
  };

  function ensureProfiles(ids) {
    const missing = [...new Set(ids)].filter(id => id && !local.profilesCache[id]);
    if (!missing.length) return;
    App.sb.from('profiles').select('id,name,email,role,phone').in('id', missing).then(({ data }) => {
      (data || []).forEach(p => local.profilesCache[p.id] = p);
      App.render();
    });
  }

  function nonCancelled() { return S.state.orders.filter(o => o.status !== 'cancelled'); }

  function stats() {
    const orders = S.state.orders;
    const revenueOrders = nonCancelled();
    const totalRevenue = revenueOrders.reduce((s, o) => s + Number(o.total), 0);
    const today = new Date().toDateString();
    const todaysRevenue = revenueOrders.filter(o => new Date(o.created_at).toDateString() === today).reduce((s, o) => s + Number(o.total), 0);
    const active = orders.filter(o => ['received', 'preparing', 'ready', 'out_for_delivery'].includes(o.status)).length;
    const completed = orders.filter(o => o.status === 'delivered').length;
    const cancelled = orders.filter(o => o.status === 'cancelled').length;
    const avgOrderValue = revenueOrders.length ? totalRevenue / revenueOrders.length : 0;
    const popularity = {};
    revenueOrders.forEach(o => (o.items || []).forEach(it => { popularity[it.name] = (popularity[it.name] || 0) + it.qty; }));
    const popularEntries = Object.entries(popularity).sort((a, b) => b[1] - a[1]);
    const mostPopular = popularEntries[0] ? popularEntries[0][0] : '—';
    return { totalRevenue, todaysRevenue, active, completed, cancelled, avgOrderValue, mostPopular, popularEntries, revenueOrders };
  }

  function statTile(icon, color, label, value, sub) {
    return `<div class="card stat-tile">
      <div class="stat-icon" style="background:${color}22;color:${color}"><i data-lucide="${icon}"></i></div>
      <div class="stat-value">${value}</div>
      <div class="stat-label">${label}</div>
      ${sub ? `<div class="stat-delta text-muted">${sub}</div>` : ''}
    </div>`;
  }

  function revenueByDayChart(orders) {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      days.push({ label: d.toLocaleDateString('en-ZA', { weekday: 'short' }), key: d.toDateString(), total: 0 });
    }
    orders.forEach(o => {
      const key = new Date(o.created_at).toDateString();
      const day = days.find(d => d.key === key);
      if (day) day.total += Number(o.total);
    });
    const max = Math.max(1, ...days.map(d => d.total));
    return `<div class="bar-chart">
      ${days.map(d => `<div class="bar-col"><div class="bar" style="height:${Math.max(4, (d.total / max) * 100)}%" title="${U.money(d.total)}"></div><div class="bar-label">${d.label}</div></div>`).join('')}
    </div>`;
  }

  function hbarList(entries, max) {
    const top = entries.slice(0, 5);
    const cap = Math.max(1, ...top.map(e => e[1]));
    return top.map(([label, value]) => `
      <div class="hbar-row">
        <span class="hbar-label">${U.escapeHtml(label)}</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:${(value / cap) * 100}%"></span></span>
        <span class="hbar-value">${value}</span>
      </div>`).join('') || `<p class="text-muted text-sm">No data yet.</p>`;
  }

  function renderDashboard() {
    const st = stats();
    return `
      <div class="page-header"><h1 class="page-title">Manager Dashboard</h1></div>
      <div class="stats-grid">
        ${statTile('dollar-sign', '#FF6B00', 'Total Revenue', U.money(st.totalRevenue))}
        ${statTile('trending-up', '#22C55E', "Today's Revenue", U.money(st.todaysRevenue))}
        ${statTile('activity', '#FFC107', 'Active Orders', st.active)}
        ${statTile('check-circle-2', '#22C55E', 'Completed Orders', st.completed)}
        ${statTile('x-circle', '#EF4444', 'Cancelled Orders', st.cancelled)}
        ${statTile('bar-chart-3', '#6B7280', 'Avg Order Value', U.money(st.avgOrderValue))}
        ${statTile('flame', '#FF6B00', 'Most Popular Food', st.mostPopular)}
        ${statTile('star', '#FFC107', 'Average Rating', (App.Reviews.averageOverall() || 0).toFixed(1) + ' / 5')}
      </div>
      <div class="reports-grid">
        <div class="card card-pad"><h3 class="font-bold mb-2">Revenue — Last 7 Days</h3>${revenueByDayChart(st.revenueOrders)}</div>
        <div class="card card-pad"><h3 class="font-bold mb-2">Top Selling Items</h3>${hbarList(st.popularEntries)}</div>
      </div>`;
  }

  function myMenu() { return S.state.menu.filter(m => m.store_id === S.state.profile.store_id); }

  // ---------------- MENU MANAGEMENT ----------------
  function renderMenuTab() {
    const rows = myMenu().map(m => `
      <tr>
        <td><div class="flex items-center gap-2"><img src="${U.escapeHtml(m.image || '')}" style="width:36px;height:36px;border-radius:8px;object-fit:cover;" onerror="this.style.visibility='hidden'"><span class="font-semibold">${U.escapeHtml(m.name)}</span></div></td>
        <td><span class="badge badge-gray">${U.escapeHtml(m.category)}</span></td>
        <td>${U.money(m.price)}</td>
        <td>${m.stock}</td>
        <td><button class="btn btn-sm ${m.available ? 'btn-success' : 'btn-secondary'}" data-action="toggle-available" data-id="${m.id}">${m.available ? 'In Stock' : 'Out of Stock'}</button></td>
        <td class="flex gap-2">
          <button class="btn-icon" data-action="edit-food" data-id="${m.id}" aria-label="Edit"><i data-lucide="pencil"></i></button>
          <button class="btn-icon" data-action="delete-food" data-id="${m.id}" aria-label="Delete"><i data-lucide="trash-2"></i></button>
        </td>
      </tr>`).join('');
    return `
    <div class="page-header"><h2 class="section-title">Menu Management</h2><button class="btn btn-primary" data-action="add-food"><i data-lucide="plus"></i>Add Food</button></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Item</th><th>Category</th><th>Price</th><th>Stock</th><th>Availability</th><th>Actions</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6"><div class="empty-state"><h3>No menu items yet</h3></div></td></tr>`}</tbody>
    </table></div>`;
  }

  function kb(bytes) { return bytes ? (bytes / 1024).toFixed(0) + ' KB' : ''; }

  function imageUploadField(opts) {
    const { label, name, value, shopId, kind, itemId } = opts;
    return `
    <div class="field">
      <label>${label}</label>
      <div class="image-upload" data-image-upload="${name}">
        <div class="image-upload-preview" ${value ? '' : 'style="display:none;"'}>
          ${value ? `<img src="${U.escapeHtml(value)}" alt="" />` : ''}
        </div>
        <div class="image-upload-progress" style="display:none;"><div class="image-upload-progress-bar"></div></div>
        <label class="btn btn-secondary btn-sm image-upload-btn">
          <i data-lucide="upload"></i> <span class="image-upload-label">${value ? 'Change Image' : 'Upload Image'}</span>
          <input type="file" accept="image/jpeg,image/png,image/webp" hidden data-action-change="upload-image" data-field="${name}" data-shop-id="${U.escapeHtml(shopId || '')}" data-kind="${kind}" data-item-id="${U.escapeHtml(itemId || '')}" />
        </label>
        <span class="image-upload-status text-xs text-muted"></span>
        <input type="hidden" name="${name}" value="${U.escapeHtml(value || '')}" />
      </div>
    </div>`;
  }

  async function handleChange(kind, ds, value, el) {
    if (kind === 'onboarding-registered-toggle') {
      const field = document.getElementById('registration-date-field');
      if (field) field.style.display = value === 'yes' ? '' : 'none';
      return;
    }
    if (kind !== 'upload-image') return;
    if (!value) return;
    if (value.size > App.Upload.MAX_UPLOAD_BYTES) { App.Toast.error('Image must be smaller than 10MB.'); return; }

    const wrap = el.closest('.image-upload');
    const statusEl = wrap.querySelector('.image-upload-status');
    const hiddenInput = wrap.querySelector(`input[type="hidden"][name="${ds.field}"]`);
    const previewWrap = wrap.querySelector('.image-upload-preview');
    const labelEl = wrap.querySelector('.image-upload-label');
    const progressWrap = wrap.querySelector('.image-upload-progress');
    const progressBar = wrap.querySelector('.image-upload-progress-bar');

    // Show the original immediately so the manager can compare it against
    // the optimized result once the upload finishes.
    const beforeUrl = URL.createObjectURL(value);
    previewWrap.innerHTML = `<img src="${beforeUrl}" alt="" />`;
    previewWrap.style.display = '';
    progressWrap.style.display = '';
    progressBar.style.width = '0%';
    statusEl.textContent = `Optimizing… (original ${kb(value.size)})`;

    const res = await App.Upload.uploadImage(value, {
      shopId: ds.shopId, kind: ds.kind, itemId: ds.itemId || null,
      onProgress: (pct) => { progressBar.style.width = pct + '%'; statusEl.textContent = `Uploading… ${pct}%`; },
    });
    URL.revokeObjectURL(beforeUrl);
    progressWrap.style.display = 'none';

    if (res.error) { statusEl.textContent = ''; App.Toast.error(res.error); return; }

    hiddenInput.value = res.data.url;
    previewWrap.innerHTML = `<img src="${U.escapeHtml(res.data.url)}" alt="" />`;
    if (labelEl) labelEl.textContent = 'Change Image';
    const savedPct = res.data.originalSize > res.data.optimizedSize
      ? Math.round((1 - res.data.optimizedSize / res.data.originalSize) * 100) + '% smaller'
      : 'optimized';
    statusEl.textContent = `${kb(res.data.originalSize)} → ${kb(res.data.optimizedSize)} (${savedPct})`;
  }

  function foodFormModal(item) {
    local.menuFormId = item ? item.id : null;
    const v = item || { name: '', category: App.CONST.CATEGORIES[0], price: '', image: '', description: '', ingredients: [], allergens: [], preparation_time: 15, available: true, stock: 20, low_stock_threshold: 10 };
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">${item ? 'Edit Food' : 'Add Food'}</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="food-form">
          <div class="field"><label>Title</label><input class="input" name="name" value="${U.escapeHtml(v.name)}" required /></div>
          <div class="flex gap-2">
            <div class="field" style="flex:1"><label>Category</label><select class="select" name="category">${App.CONST.CATEGORIES.map(c => `<option value="${c}" ${v.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
            <div class="field" style="flex:1"><label>Price (R)</label><input class="input" name="price" type="number" step="0.01" min="0" value="${v.price}" required /></div>
          </div>
          ${imageUploadField({ label: 'Food Image', name: 'image', value: v.image, shopId: S.state.profile.store_id, kind: 'menu_item', itemId: local.menuFormId })}
          <div class="field"><label>Description</label><textarea class="input" name="description" rows="2">${U.escapeHtml(v.description || '')}</textarea></div>
          <div class="field"><label>Ingredients (comma separated)</label><input class="input" name="ingredients" value="${U.escapeHtml((v.ingredients || []).join(', '))}" /></div>
          <div class="field"><label>Allergens (comma separated)</label><input class="input" name="allergens" value="${U.escapeHtml((v.allergens || []).join(', '))}" /></div>
          <div class="flex gap-2">
            <div class="field" style="flex:1"><label>Prep Time (min)</label><input class="input" name="preparation_time" type="number" min="0" value="${v.preparation_time}" /></div>
            <div class="field" style="flex:1"><label>Stock</label><input class="input" name="stock" type="number" min="0" value="${v.stock}" /></div>
            <div class="field" style="flex:1"><label>Low Stock Alert</label><input class="input" name="low_stock_threshold" type="number" min="0" value="${v.low_stock_threshold || 10}" /></div>
          </div>
          <label class="checkbox-row"><input type="checkbox" name="available" ${v.available ? 'checked' : ''}/> Available</label>
          <div class="modal-footer" style="padding:16px 0 0;"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">${item ? 'Save Changes' : 'Add Food'}</button></div>
        </form>
      </div>`);
  }

  async function handleFoodFormSubmit(data) {
    const existing = local.menuFormId ? S.state.menu.find(m => m.id === local.menuFormId) : null;
    const oldImage = existing ? existing.image : null;
    const payload = {
      name: data.get('name'), category: data.get('category'), price: data.get('price'),
      image: data.get('image'), description: data.get('description'),
      ingredients: data.get('ingredients').split(',').map(s => s.trim()).filter(Boolean),
      allergens: data.get('allergens').split(',').map(s => s.trim()).filter(Boolean),
      preparation_time: data.get('preparation_time'), stock: data.get('stock'),
      low_stock_threshold: data.get('low_stock_threshold'), available: data.get('available') === 'on',
    };
    const res = local.menuFormId ? await App.Menu.update(local.menuFormId, payload) : await App.Menu.create(payload);
    if (res.error) { App.Toast.error(res.error); return; }
    if (oldImage && oldImage !== payload.image) App.Upload.deleteImageByUrl(oldImage);
    App.Modal.close();
    App.Toast.success(local.menuFormId ? 'Menu item updated' : 'Menu item added');
  }

  function deleteFoodConfirm(id) {
    const item = S.state.menu.find(m => m.id === id);
    App.Modal.confirm({
      title: 'Delete this item?', message: `"${item ? item.name : ''}" will be permanently removed from the menu.`,
      variant: 'danger', confirmLabel: 'Delete',
      onConfirm: async () => {
        const res = await App.Menu.remove(id);
        if (res.error) App.Toast.error(res.error); else App.Toast.success('Menu item deleted');
      },
    });
  }

  // ---------------- INVENTORY ----------------
  function renderInventoryTab() {
    const rows = myMenu().map(m => {
      const low = App.Menu.isLowStock(m);
      const out = App.Menu.isOutOfStock(m);
      return `<tr>
        <td class="font-semibold">${U.escapeHtml(m.name)}</td>
        <td>${m.stock}</td>
        <td>${out ? `<span class="badge badge-error">Out of Stock</span>` : low ? `<span class="badge badge-yellow">Low Stock</span>` : `<span class="badge badge-success">OK</span>`}</td>
        <td class="flex gap-2 items-center">
          <input class="input" style="width:90px;min-height:36px;" type="number" min="0" id="stock-${m.id}" value="${m.stock}" />
          <button class="btn btn-secondary btn-sm" data-action="update-stock" data-id="${m.id}">Update</button>
        </td>
      </tr>`;
    }).join('');
    return `
    <h2 class="section-title mb-3">Inventory</h2>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Item</th><th>Stock</th><th>Status</th><th>Adjust</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ---------------- ORDERS ----------------
  const ORDER_FILTERS = [
    { key: 'all', label: 'All' }, { key: 'received', label: 'New' }, { key: 'preparing', label: 'Preparing' },
    { key: 'ready', label: 'Ready' }, { key: 'out_for_delivery', label: 'Out for Delivery' },
    { key: 'delivered', label: 'Completed' }, { key: 'cancelled', label: 'Cancelled' },
  ];

  function renderKitchenTab() {
    return `<h2 class="section-title mb-3">Kitchen</h2>${App.Pages.Kitchen.renderBoard()}`;
  }

  function renderOrdersTab() {
    const orders = S.state.orders.filter(o => local.orderFilter === 'all' || o.status === local.orderFilter)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const selected = S.state.orders.find(o => o.id === local.selectedOrderId) || orders[0];
    if (selected) ensureProfiles([selected.customer_id, selected.assigned_driver]);
    return `
    <h2 class="section-title mb-3">Order Management</h2>
    <div class="filter-bar">${ORDER_FILTERS.map(f => `<button class="chip ${local.orderFilter === f.key ? 'active' : ''}" data-action="filter-order" data-key="${f.key}">${f.label}</button>`).join('')}</div>
    <div class="split-layout">
      <div class="list-col">
        ${orders.length ? orders.map(o => `
          <div class="card order-row-card ${selected && selected.id === o.id ? 'selected' : ''}" data-action="select-order" data-id="${o.id}">
            <div class="order-row-head"><span class="font-bold">${U.escapeHtml(o.order_number)}</span><span class="badge badge-primary">${App.CONST.STATUS_LABELS[o.status]}</span></div>
            <div class="order-row-meta">${U.money(o.total)} · ${U.timeAgo(o.created_at)}</div>
          </div>`).join('') : `<div class="empty-state"><h3>No orders in this filter</h3></div>`}
      </div>
      <div>${selected ? renderOrderDetail(selected) : ''}</div>
    </div>`;
  }

  function renderOrderDetail(o) {
    const customer = local.profilesCache[o.customer_id];
    const driver = o.assigned_driver ? local.profilesCache[o.assigned_driver] : null;
    return `
    <div class="card card-pad">
      <div class="flex justify-between items-center mb-2"><h3 class="font-bold">${U.escapeHtml(o.order_number)}</h3><span class="badge badge-primary">${App.CONST.STATUS_LABELS[o.status]}</span></div>
      <div class="text-sm mb-1"><strong>Customer:</strong> ${customer ? U.escapeHtml(customer.name) + ' · ' + U.escapeHtml(customer.phone || '') : 'Loading...'}</div>
      <div class="text-sm mb-1"><strong>Delivery:</strong> ${U.escapeHtml(o.delivery_location.building || '')}, Room ${U.escapeHtml(o.delivery_location.room || '')}</div>
      <div class="text-sm mb-1"><strong>Payment:</strong> ${o.payment_method === 'cod' ? 'Cash on Delivery' : 'Card'} (${o.payment_status})</div>
      <div class="text-sm mb-2"><strong>Driver:</strong> ${driver ? U.escapeHtml(driver.name) : 'Not yet assigned'}</div>
      <div class="divider"></div>
      <div class="mb-2">${(o.items || []).map(it => `<div class="cart-summary-row"><span>${it.qty}x ${U.escapeHtml(it.name)}</span><span>${U.money(it.price * it.qty)}</span></div>`).join('')}</div>
      <div class="cart-summary-row total"><span>Total</span><span>${U.money(o.total)}</span></div>
      <div class="mt-3">${App.Shared.renderTracker(o)}</div>
    </div>`;
  }

  // ---------------- PROMOTIONS ----------------
  function renderPromotionsTab() {
    const rows = S.state.promotions.map(p => `
      <tr>
        <td class="font-bold">${U.escapeHtml(p.code)}</td>
        <td>${p.type === 'percentage' ? p.value + '%' : U.money(p.value)}</td>
        <td>${p.used_count}${p.usage_limit ? ' / ' + p.usage_limit : ''}</td>
        <td>${p.expires_at ? U.formatDate(p.expires_at) : '—'}</td>
        <td><button class="btn btn-sm ${p.active ? 'btn-success' : 'btn-secondary'}" data-action="toggle-promo" data-id="${p.id}">${p.active ? 'Active' : 'Inactive'}</button></td>
        <td class="flex gap-2"><button class="btn-icon" data-action="edit-promo" data-id="${p.id}"><i data-lucide="pencil"></i></button><button class="btn-icon" data-action="delete-promo" data-id="${p.id}"><i data-lucide="trash-2"></i></button></td>
      </tr>`).join('');
    return `
    <div class="page-header"><h2 class="section-title">Promotions & Discounts</h2><button class="btn btn-primary" data-action="add-promo"><i data-lucide="plus"></i>New Promo</button></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Code</th><th>Discount</th><th>Usage</th><th>Expires</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows || `<tr><td colspan="6"><div class="empty-state"><h3>No promotions yet</h3></div></td></tr>`}</tbody></table></div>

    <div class="page-header mt-6"><h2 class="section-title">Homepage Advertising</h2><button class="btn btn-primary" data-action="add-store-promo"><i data-lucide="plus"></i>New Placement</button></div>
    <p class="text-sm text-muted mb-3">Featured placements shown in the "Promotions" carousel on the clickFud homepage.</p>
    ${renderStorePromoList()}`;
  }

  function renderStorePromoList() {
    const mine = App.Stores.myPromotions();
    if (!mine.length) return `<div class="empty-state"><div class="icon-wrap"><i data-lucide="megaphone"></i></div><h3>No placements yet</h3><p class="text-sm">Create one to feature your store on the homepage.</p></div>`;
    return `<div class="grid grid-menu">${mine.map(p => `
      <div class="card card-pad">
        <div class="flex justify-between items-start gap-2">
          <span class="badge badge-yellow">${U.escapeHtml(p.badge)}</span>
          <button class="btn btn-sm ${p.active ? 'btn-success' : 'btn-secondary'}" data-action="toggle-store-promo" data-id="${p.id}">${p.active ? 'Active' : 'Inactive'}</button>
        </div>
        <h3 class="font-bold mt-2">${U.escapeHtml(p.title)}</h3>
        <p class="text-sm text-muted">${U.escapeHtml(p.message)}</p>
        <span class="badge ${p.status === 'approved' ? 'badge-success' : p.status === 'rejected' ? 'badge-error' : 'badge-gray'} mt-2">${p.status === 'approved' ? 'Approved — live on homepage' : p.status === 'rejected' ? 'Rejected by clickFud' : 'Pending clickFud review'}</span>
        <div class="flex gap-2 mt-3">
          <button class="btn-icon" data-action="edit-store-promo" data-id="${p.id}"><i data-lucide="pencil"></i></button>
          <button class="btn-icon" data-action="delete-store-promo" data-id="${p.id}"><i data-lucide="trash-2"></i></button>
        </div>
      </div>`).join('')}</div>`;
  }

  function storePromoFormModal(promo) {
    local.storePromoFormId = promo ? promo.id : null;
    const v = promo || { title: '', message: '', badge: 'Featured', image_url: '', promo_type: 'featured', active: true, priority: 0 };
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">${promo ? 'Edit Placement' : 'New Placement'}</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="store-promo-form">
          <div class="field"><label>Title</label><input class="input" name="title" value="${U.escapeHtml(v.title)}" placeholder="e.g. New Kota Flavours" required /></div>
          <div class="field"><label>Message</label><input class="input" name="message" value="${U.escapeHtml(v.message)}" placeholder="e.g. Bigger. Juicier. Better." /></div>
          <div class="flex gap-2">
            <div class="field" style="flex:1"><label>Badge</label><input class="input" name="badge" value="${U.escapeHtml(v.badge)}" placeholder="e.g. New Menu" required /></div>
            <div class="field" style="flex:1"><label>Type</label>
              <select class="select" name="promo_type">
                ${['featured', 'new_menu', 'special_offer', 'discount', 'new_store'].map(t => `<option value="${t}" ${v.promo_type === t ? 'selected' : ''}>${t.replace('_', ' ')}</option>`).join('')}
              </select>
            </div>
          </div>
          ${imageUploadField({ label: 'Placement Image', name: 'image_url', value: v.image_url, shopId: S.state.profile.store_id, kind: 'promotion', itemId: local.storePromoFormId })}
          <label class="checkbox-row mb-2"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}/> Active</label>
          <div class="modal-footer" style="padding:16px 0 0;"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">${promo ? 'Save Changes' : 'Create Placement'}</button></div>
        </form>
      </div>`);
  }

  async function handleStorePromoFormSubmit(data) {
    const existing = local.storePromoFormId ? (S.state.storePromotions || []).find(p => p.id === local.storePromoFormId) : null;
    const oldImage = existing ? existing.image_url : null;
    const payload = { title: data.get('title'), message: data.get('message'), badge: data.get('badge'), image_url: data.get('image_url'), promo_type: data.get('promo_type'), active: data.get('active') === 'on' };
    const res = local.storePromoFormId ? await App.Stores.updatePromotion(local.storePromoFormId, payload) : await App.Stores.createPromotion(payload);
    if (res.error) { App.Toast.error(res.error); return; }
    if (oldImage && oldImage !== payload.image_url) App.Upload.deleteImageByUrl(oldImage);
    App.Modal.close();
    App.Toast.success(local.storePromoFormId ? 'Placement updated' : 'Placement created');
  }

  function promoFormModal(promo) {
    local.menuFormId = promo ? promo.id : null;
    const v = promo || { code: '', type: 'percentage', value: '', active: true, expires_at: '', usage_limit: '' };
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">${promo ? 'Edit Promo' : 'New Promo'}</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="promo-form">
          <div class="field"><label>Code</label><input class="input" name="code" value="${U.escapeHtml(v.code)}" required /></div>
          <div class="flex gap-2">
            <div class="field" style="flex:1"><label>Type</label><select class="select" name="type"><option value="percentage" ${v.type === 'percentage' ? 'selected' : ''}>Percentage</option><option value="fixed" ${v.type === 'fixed' ? 'selected' : ''}>Fixed Amount</option></select></div>
            <div class="field" style="flex:1"><label>Value</label><input class="input" name="value" type="number" step="0.01" min="0" value="${v.value}" required /></div>
          </div>
          <div class="flex gap-2">
            <div class="field" style="flex:1"><label>Expires (optional)</label><input class="input" name="expires_at" type="date" value="${v.expires_at ? String(v.expires_at).slice(0, 10) : ''}" /></div>
            <div class="field" style="flex:1"><label>Usage Limit (optional)</label><input class="input" name="usage_limit" type="number" min="1" value="${v.usage_limit || ''}" /></div>
          </div>
          <label class="checkbox-row"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}/> Active</label>
          <div class="modal-footer" style="padding:16px 0 0;"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">${promo ? 'Save Changes' : 'Create Promo'}</button></div>
        </form>
      </div>`);
  }

  async function handlePromoFormSubmit(data) {
    const payload = { code: data.get('code'), type: data.get('type'), value: data.get('value'), expires_at: data.get('expires_at') || null, usage_limit: data.get('usage_limit') || null, active: data.get('active') === 'on' };
    const res = local.menuFormId ? await App.Promotions.update(local.menuFormId, payload) : await App.Promotions.create(payload);
    if (res.error) { App.Toast.error(res.error); return; }
    App.Modal.close();
    App.Toast.success(local.menuFormId ? 'Promotion updated' : 'Promotion created');
  }

  // ---------------- ZONES ----------------
  function renderZonesTab() {
    const rows = S.state.zones.map(z => `
      <tr>
        <td><input class="input" style="min-height:36px" id="zone-name-${z.id}" value="${U.escapeHtml(z.name)}" /></td>
        <td><input class="input" style="min-height:36px;width:110px" type="number" step="0.01" id="zone-fee-${z.id}" value="${z.fee}" /></td>
        <td class="flex gap-2"><button class="btn btn-secondary btn-sm" data-action="save-zone" data-id="${z.id}">Save</button><button class="btn-icon" data-action="delete-zone" data-id="${z.id}"><i data-lucide="trash-2"></i></button></td>
      </tr>`).join('');
    return `
    <div class="page-header"><h2 class="section-title">Campus Delivery Zones</h2><button class="btn btn-primary" data-action="add-zone"><i data-lucide="plus"></i>Add Zone</button></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Zone</th><th>Fee (R)</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ---------------- BUSINESS HOURS (per store) ----------------
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function renderHoursTab() {
    const st = App.Stores.myStore() || {};
    return `
    <h2 class="section-title mb-3">Business Hours</h2>
    <div class="card card-pad mb-4">
      <form data-form="hours-form">
        <div class="flex gap-2">
          <div class="field" style="flex:1"><label>Opening Time</label><input class="input" type="time" name="opening_time" value="${(st.opening_time || '08:00').slice(0, 5)}" /></div>
          <div class="field" style="flex:1"><label>Closing Time</label><input class="input" type="time" name="closing_time" value="${(st.closing_time || '21:00').slice(0, 5)}" /></div>
        </div>
        <label class="text-sm font-semibold" style="display:block;margin-bottom:6px;">Closed Days</label>
        <div class="hours-grid mb-3">${DAY_NAMES.map((d, i) => `<div class="day-toggle ${!(st.closed_days || []).includes(i) ? 'open' : ''}" data-action="toggle-closed-day" data-day="${i}">${d}</div>`).join('')}</div>
        <button type="submit" class="btn btn-primary">Save Hours</button>
      </form>
    </div>
    <div class="card card-pad">
      <h3 class="font-bold mb-2">Temporary Store Closure</h3>
      <form data-form="closure-form">
        <label class="checkbox-row mb-2"><input type="checkbox" name="store_closed" ${st.store_closed ? 'checked' : ''}/> Store is currently closed</label>
        <div class="field"><label>Reason (shown to customers)</label><input class="input" name="closure_reason" value="${U.escapeHtml(st.closure_reason || '')}" placeholder="e.g. Kitchen maintenance" /></div>
        <button type="submit" class="btn btn-danger">Save Closure Status</button>
      </form>
    </div>`;
  }

  // ---------------- STORE SETTINGS ----------------
  function renderStoreTab() {
    const st = App.Stores.myStore();
    if (!st) return `<div class="empty-state"><h3>No store found</h3></div>`;
    return `
    <h2 class="section-title mb-3">Store Settings</h2>
    <div class="card card-pad">
      <form data-form="store-form">
        <div class="field"><label>Store Name</label><input class="input" name="name" value="${U.escapeHtml(st.name)}" required /></div>
        <div class="flex gap-2">
          <div class="field" style="flex:1"><label>Category</label><input class="input" name="category" value="${U.escapeHtml(st.category)}" placeholder="e.g. Fast Food" required /></div>
          <div class="field" style="flex:1"><label>Campus Location</label><input class="input" name="campus_location" value="${U.escapeHtml(st.campus_location)}" placeholder="e.g. South Campus" required /></div>
        </div>
        <div class="field"><label>Description</label><textarea class="input" name="description" rows="2">${U.escapeHtml(st.description || '')}</textarea></div>
        <div class="flex gap-2">
          <div class="field" style="flex:1"><label>Contact Phone</label><input class="input" name="contact_phone" value="${U.escapeHtml(st.contact_phone || '')}" placeholder="e.g. 011 234 5678" /></div>
          <div class="field" style="flex:1"><label>Contact Email</label><input class="input" name="contact_email" type="email" value="${U.escapeHtml(st.contact_email || '')}" placeholder="e.g. store@campuseats.com" /></div>
        </div>
        <h3 class="font-bold mb-2" style="margin-top:8px;">Store Branding</h3>
        <div class="flex gap-2">
          <div style="flex:1">${imageUploadField({ label: 'Store Profile Logo', name: 'logo_url', value: st.logo_url, shopId: st.id, kind: 'logo' })}</div>
          <div style="flex:1">${imageUploadField({ label: 'Store Cover Image', name: 'cover_image_url', value: st.cover_image_url, shopId: st.id, kind: 'cover' })}</div>
        </div>
        <div class="flex gap-2" style="flex-wrap:wrap;">
          <div class="field" style="flex:1 1 140px;min-width:0;"><label>Prep Time Min (min)</label><input class="input" name="prep_time_min" type="number" min="0" value="${st.prep_time_min}" /></div>
          <div class="field" style="flex:1 1 140px;min-width:0;"><label>Prep Time Max (min)</label><input class="input" name="prep_time_max" type="number" min="0" value="${st.prep_time_max}" /></div>
          <div class="field" style="flex:1 1 140px;min-width:0;"><label>Delivery Fee (R)</label><input class="input" name="delivery_fee" type="number" step="0.01" min="0" value="${st.delivery_fee}" /></div>
        </div>
        <label class="checkbox-row mb-2"><input type="checkbox" name="accepts_delivery" ${st.accepts_delivery ? 'checked' : ''}/> Offer delivery</label>
        <label class="checkbox-row mb-3"><input type="checkbox" name="accepts_collection" ${st.accepts_collection ? 'checked' : ''}/> Offer collection</label>
        <button type="submit" class="btn btn-primary">Save Store Settings</button>
      </form>
    </div>`;
  }

  // ---------------- ONBOARDING (no store yet, or resubmitting after rejection) ----------------
  function renderOnboarding(existingStore) {
    const v = existingStore || { name: '', category: '', campus_location: '', university: '', contact_phone: '', contact_email: '', description: '', is_registered_business: null, registration_date: '' };
    const isReg = v.is_registered_business;
    return `
    <div class="page-wrap" style="max-width:520px;">
      <h1 class="page-title mb-2">Register Your Business</h1>
      <p class="text-muted text-sm mb-4">Tell us about your business. A clickFud admin will review and approve it before it goes live.</p>
      <div class="card card-pad">
        <form data-form="onboarding-store-form">
          <div class="field"><label>Business Name</label><input class="input" name="name" value="${U.escapeHtml(v.name)}" placeholder="e.g. Campus Grill" required /></div>
          <div class="field"><label>What do you sell?</label><input class="input" name="category" value="${U.escapeHtml(v.category)}" placeholder="e.g. Fast Food, Coffee, Bakery" required /></div>
          <div class="field"><label>University / College</label><input class="input" name="university" value="${U.escapeHtml(v.university || '')}" list="university-options" placeholder="e.g. University of Pretoria" required /><datalist id="university-options"><option value="University of Pretoria"></option><option value="University of Johannesburg"></option><option value="University of the Witwatersrand"></option><option value="University of South Africa (UNISA)"></option><option value="Tshwane University of Technology"></option><option value="Stellenbosch University"></option><option value="University of Cape Town"></option><option value="North-West University"></option></datalist></div>
          <div class="field"><label>Campus Location</label><input class="input" name="campus_location" value="${U.escapeHtml(v.campus_location)}" placeholder="e.g. South Campus" required /></div>
          <div class="flex gap-2">
            <div class="field" style="flex:1"><label>Business Phone</label><input class="input" name="contact_phone" value="${U.escapeHtml(v.contact_phone || '')}" placeholder="e.g. 011 234 5678" required /></div>
            <div class="field" style="flex:1"><label>Business Email</label><input class="input" type="email" name="contact_email" value="${U.escapeHtml(v.contact_email || '')}" placeholder="e.g. store@campuseats.com" required /></div>
          </div>
          <div class="field">
            <label>Is your business officially registered?</label>
            <select class="select" name="is_registered_business" data-action-change="onboarding-registered-toggle">
              <option value="">Select an answer</option>
              <option value="yes" ${isReg === true ? 'selected' : ''}>Yes</option>
              <option value="no" ${isReg === false ? 'selected' : ''}>No, not yet</option>
            </select>
          </div>
          <div class="field" id="registration-date-field" ${isReg ? '' : 'style="display:none;"'}>
            <label>When was it registered?</label>
            <input class="input" type="date" name="registration_date" value="${v.registration_date || ''}" max="${new Date().toISOString().slice(0, 10)}" />
          </div>
          <div class="field"><label>Briefly describe your product</label><textarea class="input" name="description" rows="2" placeholder="Tell students what you serve, e.g. burgers, wraps and sides">${U.escapeHtml(v.description || '')}</textarea></div>
          <button type="submit" class="btn btn-primary btn-block btn-lg">${existingStore ? 'Resubmit Application' : 'Register Your Business'}</button>
        </form>
      </div>
    </div>`;
  }

  function renderApplicationStatus(store) {
    if (store.status === 'archived') {
      return `
      <div class="page-wrap" style="max-width:520px;">
        <div class="card card-pad" style="text-align:center;">
          <div class="icon-wrap" style="background:rgba(107,114,128,0.14);color:var(--text-secondary);margin:0 auto 14px;"><i data-lucide="archive"></i></div>
          <h2 class="section-title mb-2">Shop Archived</h2>
          <p class="text-muted text-sm mb-3">${U.escapeHtml(store.name)} has been archived by clickFud and is not visible to customers. Your menu, orders and reports are kept safe.</p>
          ${store.archived_reason ? `<div class="text-sm" style="color:var(--color-error);">Reason: ${U.escapeHtml(store.archived_reason)}</div>` : ''}
          <p class="text-muted text-sm mt-3">Contact clickFud support to have your shop reinstated.</p>
        </div>
      </div>`;
    }
    if (store.status === 'rejected') {
      return `
      <div class="page-wrap" style="max-width:520px;">
        <div class="card card-pad" style="text-align:center;">
          <div class="icon-wrap" style="background:rgba(239,68,68,0.12);color:var(--color-error);margin:0 auto 14px;"><i data-lucide="x-circle"></i></div>
          <h2 class="section-title mb-2">Application Not Approved</h2>
          <p class="text-muted text-sm mb-3">${U.escapeHtml(store.rejection_reason || 'Your business registration was not approved.')}</p>
          <button class="btn btn-primary" data-action="reapply">Submit a New Application</button>
        </div>
      </div>`;
    }
    return `
    <div class="page-wrap" style="max-width:520px;">
      <div class="card card-pad" style="text-align:center;">
        <div class="icon-wrap" style="background:rgba(255,107,0,0.12);color:var(--color-primary);margin:0 auto 14px;"><i data-lucide="clock"></i></div>
        <h2 class="section-title mb-2">Application Under Review</h2>
        <p class="text-muted text-sm">Thanks for registering <strong>${U.escapeHtml(store.name)}</strong>. A clickFud admin is reviewing your business details and will approve it shortly.</p>
      </div>
    </div>`;
  }

  // ---------------- REPORTS ----------------
  function renderReportsTab() {
    const from = local.reportFrom ? new Date(local.reportFrom) : new Date(Date.now() - 30 * 86400000);
    const to = local.reportTo ? new Date(local.reportTo) : new Date();
    to.setHours(23, 59, 59, 999);
    const orders = nonCancelled().filter(o => { const d = new Date(o.created_at); return d >= from && d <= to; });
    const revenue = orders.reduce((s, o) => s + Number(o.total), 0);
    const avgOrder = orders.length ? revenue / orders.length : 0;
    const byCategory = {};
    orders.forEach(o => (o.items || []).forEach(it => {
      const menuItem = S.state.menu.find(m => m.id === it.menuItemId);
      const cat = menuItem ? menuItem.category : 'Other';
      byCategory[cat] = (byCategory[cat] || 0) + it.price * it.qty;
    }));
    const popularity = {};
    orders.forEach(o => (o.items || []).forEach(it => { popularity[it.name] = (popularity[it.name] || 0) + it.qty; }));
    const completed = S.state.orders.filter(o => o.status === 'delivered' && new Date(o.created_at) >= from && new Date(o.created_at) <= to).length;
    const cancelled = S.state.orders.filter(o => o.status === 'cancelled' && new Date(o.created_at) >= from && new Date(o.created_at) <= to).length;

    return `
    <h2 class="section-title mb-3">Reports</h2>
    <div class="card card-pad mb-4">
      <div class="flex gap-2" style="flex-wrap:wrap;align-items:end;">
        <div class="field" style="margin:0;"><label>From</label><input class="input" type="date" id="report-from" value="${from.toISOString().slice(0, 10)}" /></div>
        <div class="field" style="margin:0;"><label>To</label><input class="input" type="date" id="report-to" value="${to.toISOString().slice(0, 10)}" /></div>
        <button class="btn btn-primary" data-action="run-report">Apply</button>
      </div>
    </div>
    <div class="stats-grid">
      ${statTile('dollar-sign', '#FF6B00', 'Revenue in Range', U.money(revenue))}
      ${statTile('shopping-bag', '#6B7280', 'Orders in Range', orders.length)}
      ${statTile('bar-chart-3', '#FFC107', 'Avg Order Value', U.money(avgOrder))}
      ${statTile('check-circle-2', '#22C55E', 'Completed', completed)}
      ${statTile('x-circle', '#EF4444', 'Cancelled', cancelled)}
      ${statTile('star', '#FFC107', 'Avg Rating', (App.Reviews.averageOverall() || 0).toFixed(1))}
    </div>
    <div class="reports-grid">
      <div class="card card-pad"><h3 class="font-bold mb-2">Most Ordered Meals</h3>${hbarList(Object.entries(popularity).sort((a, b) => b[1] - a[1]))}</div>
      <div class="card card-pad"><h3 class="font-bold mb-2">Revenue by Category</h3>${hbarList(Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v)]))}</div>
    </div>`;
  }

  // ---------------- Router ----------------
  const TABS = [
    { key: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
    { key: 'menu', label: 'Menu', icon: 'utensils' },
    { key: 'inventory', label: 'Inventory', icon: 'package' },
    { key: 'kitchen', label: 'Kitchen', icon: 'chef-hat' },
    { key: 'orders', label: 'Orders', icon: 'receipt' },
    { key: 'promotions', label: 'Promotions', icon: 'tag' },
    { key: 'zones', label: 'Delivery Zones', icon: 'map-pin' },
    { key: 'hours', label: 'Business Hours', icon: 'clock' },
    { key: 'store', label: 'Store Settings', icon: 'store' },
    { key: 'reports', label: 'Reports', icon: 'bar-chart-3' },
  ];

  function render() {
    const view = S.state.route.view;
    if (view === 'profile') return App.Shared.renderStaffProfile();
    if (!S.state.profile.store_id) return renderOnboarding();
    const myStore = App.Stores.myStore();
    if (myStore && myStore.status !== 'approved') {
      return local.reapplying ? renderOnboarding(myStore) : renderApplicationStatus(myStore);
    }
    local.tab = ['dashboard', 'menu', 'inventory', 'kitchen', 'orders', 'promotions', 'zones', 'hours', 'store', 'reports'].includes(view) ? view : 'dashboard';
    const bodies = {
      dashboard: renderDashboard, menu: renderMenuTab, inventory: renderInventoryTab,
      kitchen: renderKitchenTab, orders: renderOrdersTab, promotions: renderPromotionsTab, zones: renderZonesTab,
      hours: renderHoursTab, store: renderStoreTab, reports: renderReportsTab,
    };
    return `<div class="page-wrap">${tabRow()}${bodies[local.tab]()}</div>`;
  }

  function tabRow() {
    return `<div class="tab-row">${TABS.map(t => `<button class="tab-btn ${local.tab === t.key ? 'active' : ''}" data-action="navigate" data-view="${t.key}"><i data-lucide="${t.icon}"></i>${t.label}</button>`).join('')}</div>`;
  }

  const KITCHEN_ACTIONS = new Set(['start-preparing', 'mark-ready', 'dispatch-drivers', 'set-priority']);

  function handleAction(action, ds) {
    if (KITCHEN_ACTIONS.has(action)) return App.Pages.Kitchen.handleAction(action, ds);
    switch (action) {
      case 'add-food': return foodFormModal(null);
      case 'edit-food': return foodFormModal(S.state.menu.find(m => m.id === ds.id));
      case 'delete-food': return deleteFoodConfirm(ds.id);
      case 'toggle-available': {
        const item = S.state.menu.find(m => m.id === ds.id);
        return App.Menu.toggleAvailable(ds.id, !item.available).then(() => App.Toast.success('Menu item updated'));
      }
      case 'update-stock': {
        const input = document.getElementById('stock-' + ds.id);
        return App.Menu.setStock(ds.id, input.value).then(() => App.Toast.success('Stock updated'));
      }
      case 'filter-order': local.orderFilter = ds.key; return App.render();
      case 'select-order': local.selectedOrderId = ds.id; return App.render();
      case 'add-promo': return promoFormModal(null);
      case 'edit-promo': return promoFormModal(S.state.promotions.find(p => p.id === ds.id));
      case 'delete-promo': return App.Modal.confirm({ title: 'Delete promo?', message: 'This promo code will be removed.', variant: 'danger', confirmLabel: 'Delete', onConfirm: async () => { const r = await App.Promotions.remove(ds.id); if (r.error) App.Toast.error(r.error); else App.Toast.success('Promo deleted'); } });
      case 'toggle-promo': {
        const p = S.state.promotions.find(pp => pp.id === ds.id);
        return App.Promotions.toggleActive(ds.id, !p.active).then(() => App.Toast.success('Promotion updated'));
      }
      case 'add-store-promo': return storePromoFormModal(null);
      case 'edit-store-promo': return storePromoFormModal(App.Stores.myPromotions().find(p => p.id === ds.id));
      case 'delete-store-promo': return App.Modal.confirm({ title: 'Delete placement?', message: 'This homepage placement will be removed.', variant: 'danger', confirmLabel: 'Delete', onConfirm: async () => { const r = await App.Stores.removePromotion(ds.id); if (r.error) App.Toast.error(r.error); else App.Toast.success('Placement deleted'); } });
      case 'toggle-store-promo': {
        const p = App.Stores.myPromotions().find(pp => pp.id === ds.id);
        return App.Stores.updatePromotion(ds.id, { ...p, active: !p.active }).then(r => { if (r.error) App.Toast.error(r.error); else App.Toast.success('Placement updated'); });
      }
      case 'add-zone': return App.Settings.createZone('New Zone', 0).then(r => { if (r.error) App.Toast.error(r.error); else App.render(); });
      case 'save-zone': {
        const name = document.getElementById('zone-name-' + ds.id).value;
        const fee = document.getElementById('zone-fee-' + ds.id).value;
        return App.Settings.updateZone(ds.id, name, fee).then(r => { if (r.error) App.Toast.error(r.error); else App.Toast.success('Zone updated'); });
      }
      case 'delete-zone': return App.Modal.confirm({ title: 'Delete zone?', message: 'This delivery zone will be removed.', variant: 'danger', confirmLabel: 'Delete', onConfirm: async () => { const r = await App.Settings.removeZone(ds.id); if (r.error) App.Toast.error(r.error); else App.Toast.success('Zone deleted'); } });
      case 'toggle-closed-day': {
        const day = Number(ds.day);
        const store = App.Stores.myStore();
        const closed = new Set(store.closed_days || []);
        closed.has(day) ? closed.delete(day) : closed.add(day);
        store.closed_days = [...closed];
        return App.render();
      }
      case 'run-report': {
        local.reportFrom = document.getElementById('report-from').value;
        local.reportTo = document.getElementById('report-to').value;
        return App.render();
      }
      case 'reapply': local.reapplying = true; return App.render();
      default: return;
    }
  }

  async function handleSubmit(formId, data) {
    if (formId === 'food-form') return handleFoodFormSubmit(data);
    if (formId === 'promo-form') return handlePromoFormSubmit(data);
    if (formId === 'store-promo-form') return handleStorePromoFormSubmit(data);
    if (formId === 'staff-profile-form') return App.Shared.handleStaffProfileSubmit(data);
    if (formId === 'hours-form') {
      const store = App.Stores.myStore();
      const res = await App.Stores.updateHours(store.id, { opening_time: data.get('opening_time'), closing_time: data.get('closing_time'), closed_days: store.closed_days || [] });
      if (res.error) App.Toast.error(res.error); else App.Toast.success('Business hours updated');
    }
    if (formId === 'closure-form') {
      const store = App.Stores.myStore();
      const res = await App.Stores.updateHours(store.id, { store_closed: data.get('store_closed') === 'on', closure_reason: data.get('closure_reason') });
      if (res.error) App.Toast.error(res.error); else App.Toast.success('Store status updated');
    }
    if (formId === 'store-form') {
      const store = App.Stores.myStore();
      const oldLogo = store.logo_url, oldCover = store.cover_image_url;
      const newLogo = data.get('logo_url'), newCover = data.get('cover_image_url');
      const res = await App.Stores.update(store.id, {
        name: data.get('name'), category: data.get('category'), campus_location: data.get('campus_location'),
        description: data.get('description'), logo_url: newLogo, cover_image_url: newCover,
        contact_phone: data.get('contact_phone'), contact_email: data.get('contact_email'),
        prep_time_min: data.get('prep_time_min'), prep_time_max: data.get('prep_time_max'), delivery_fee: data.get('delivery_fee'),
        accepts_delivery: data.get('accepts_delivery') === 'on', accepts_collection: data.get('accepts_collection') === 'on',
      });
      if (res.error) { App.Toast.error(res.error); return; }
      if (oldLogo && oldLogo !== newLogo) App.Upload.deleteImageByUrl(oldLogo);
      if (oldCover && oldCover !== newCover) App.Upload.deleteImageByUrl(oldCover);
      App.Toast.success('Store settings updated'); App.render();
    }
    if (formId === 'onboarding-store-form') {
      const registeredAnswer = data.get('is_registered_business');
      if (!registeredAnswer) { App.Toast.error('Please answer whether your business is registered.'); return; }
      const payload = {
        name: data.get('name'), category: data.get('category'), campus_location: data.get('campus_location'),
        university: data.get('university'),
        contact_phone: data.get('contact_phone'), contact_email: data.get('contact_email'), description: data.get('description'),
        is_registered_business: registeredAnswer === 'yes',
        registration_date: registeredAnswer === 'yes' ? (data.get('registration_date') || null) : null,
      };
      const existingStore = App.Stores.myStore();
      const res = local.reapplying && existingStore
        ? await App.Stores.update(existingStore.id, { ...payload, status: 'pending' })
        : await App.Stores.create(payload);
      if (res.error) { App.Toast.error(res.error); return; }
      local.reapplying = false;
      App.Toast.success('Application submitted! A clickFud admin will review it shortly.');
      App.render();
    }
  }

  return { render, handleAction, handleSubmit, handleChange, local };
})();
