/* ============================================================
   CLICKFOOD, Student Seller dashboard ("My Shop").
   Lives inside the customer app: the same student account can buy
   and sell. Views: setup (no shop yet), then Overview / Products /
   Orders / Analytics / Shop tabs. Data: js/seller.js.
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Seller = (function () {
  const S = App.Store;
  const U = App.Utils;
  const SL = App.Seller;
  const esc = (s) => U.escapeHtml(String(s == null ? '' : s));

  const photoPick = {}; // newest photo pick per field wins
  const local = { orderFilter: 'active', busy: false, setupCats: null, editing: null };

  const TABS = [
    { key: 'overview', label: 'Overview', icon: 'layout-dashboard' },
    { key: 'products', label: 'Products', icon: 'utensils' },
    { key: 'orders', label: 'Orders', icon: 'receipt' },
    { key: 'analytics', label: 'Analytics', icon: 'bar-chart-3' },
    { key: 'shop', label: 'Shop', icon: 'store' },
  ];

  function catLabel(c) { return (App.CONST.FOOD_CATEGORY_LABELS || {})[c] || c; }
  function tab() { const t = (S.state.route.params || {}).tab; return TABS.some(x => x.key === t) ? t : 'overview'; }

  function render() {
    const shop = SL.myShop();
    if (!shop) return renderSetup();
    if (shop.status === 'archived') {
      return `<div class="page-wrap" style="max-width:560px;"><div class="empty-state"><div class="icon-wrap"><i data-lucide="store"></i></div><h3>Your shop was removed</h3><p class="text-sm">Contact ClickFood support if you think this is a mistake.</p></div></div>`;
    }
    SL.load();
    const d = SL.data;
    const newCount = d.orders.filter(o => o.status === 'received').length;
    return `
    <div class="page-wrap seller-wrap">
      <div class="seller-head">
        <div class="seller-logo media">${shop.logo_url ? `<img crossorigin="anonymous" src="${esc(shop.logo_url)}" alt="">` : `<i data-lucide="chef-hat"></i>`}</div>
        <div style="min-width:0;">
          <div class="text-xs text-muted">My Shop</div>
          <h1 class="seller-title">${esc(shop.name)}</h1>
        </div>
        ${headBadge(shop)}
      </div>
      <div class="tab-row mb-3">
        ${TABS.map(t => `<button type="button" class="tab-btn ${tab() === t.key ? 'active' : ''}" data-action="sell-tab" data-tab="${t.key}">${t.label}${t.key === 'orders' && newCount ? ` <span class="seller-dot">${newCount}</span>` : ''}</button>`).join('')}
      </div>
      ${d.loaded ? statusBanner(shop) : ''}
      ${d.error ? `<div class="closed-banner mb-3"><i data-lucide="alert-circle"></i><div style="flex:1;">${esc(d.error)}</div><button type="button" class="btn btn-secondary btn-sm" data-action="sell-reload">Retry</button></div>` : ''}
      ${!d.loaded && !d.error ? `<div class="stats-grid">${Array(4).fill('<div class="card skeleton" style="height:96px;"></div>').join('')}</div>` : renderTab(shop)}
    </div>`;
  }

  function headBadge(shop) {
    const [label, cls] = shop.status === 'pending' ? ['In review', 'badge-yellow']
      : shop.status === 'rejected' ? ['Not approved', 'badge-error']
      : !shop.is_published ? ['Not live yet', 'badge-gray']
      : shop.store_closed ? ['Paused', 'badge-gray'] : ['Live', 'badge-success'];
    return `<span class="badge ${cls}" style="margin-left:auto;">${label}</span>`;
  }

  // Review / publish steps: pending -> approved -> 5 approved products -> Publish.
  function statusBanner(shop) {
    const min = SL.MIN_PRODUCTS, n = SL.approvedCount();
    if (shop.status === 'pending') {
      return `<div class="seller-step mb-3"><i data-lucide="hourglass"></i><div><div class="font-bold">Your shop is being reviewed</div>
        <div class="text-sm text-muted">Add your food while you wait.</div></div></div>`;
    }
    if (shop.status === 'rejected') {
      return `<div class="seller-step seller-step-error mb-3"><i data-lucide="alert-circle"></i><div style="flex:1;"><div class="font-bold">Your shop wasn't approved</div>
        ${shop.rejection_reason ? `<div class="text-sm">${esc(shop.rejection_reason)}</div>` : ''}
        <button type="button" class="btn btn-primary btn-sm mt-2" data-action="sell-resubmit">Send for review again</button></div></div>`;
    }
    if (!shop.is_published) {
      const ready = n >= min;
      return `<div class="seller-step mb-3"><i data-lucide="rocket"></i><div style="flex:1;">
        <div class="font-bold">${ready ? 'Ready to go live' : `Get ${min} products approved to go live`}</div>
        <div class="seller-progress"><span style="width:${Math.min(100, (n / min) * 100)}%"></span></div>
        <div class="text-sm text-muted">${Math.min(n, min)} of ${min} approved</div>
        <div class="flex gap-2 mt-2" style="flex-wrap:wrap;">
          ${ready ? `<button type="button" class="btn btn-primary btn-sm" data-action="sell-publish"><i data-lucide="rocket"></i>Publish my shop</button>`
                  : `<button type="button" class="btn btn-primary btn-sm" data-action="sell-add-item"><i data-lucide="plus"></i>Add food</button>`}
        </div></div></div>`;
    }
    return '';
  }

  function renderTab(shop) {
    switch (tab()) {
      case 'products': return renderProducts();
      case 'orders': return renderOrders();
      case 'analytics': return renderAnalytics();
      case 'shop': return renderShopSettings(shop);
      default: return renderOverview();
    }
  }

  function tile(icon, label, value, tabKey) {
    return `<button type="button" class="card stat-tile seller-tile" ${tabKey ? `data-action="sell-tab" data-tab="${tabKey}"` : ''}>
      <div class="stat-icon" style="background:rgba(var(--color-primary-rgb),0.12);color:var(--color-primary);"><i data-lucide="${icon}"></i></div>
      <div class="stat-value">${value}</div><div class="stat-label">${label}</div></button>`;
  }

  // ---------------- Overview ----------------
  function renderOverview() {
    const st = SL.stats();
    const recent = SL.data.orders.slice(0, 5);
    return `
    <div class="stats-grid seller-stats">
      ${tile('utensils', 'Products listed', st.products, 'products')}
      ${tile('badge-check', 'Published', st.active, 'products')}
      ${tile('bell', 'New orders', st.newOrders, 'orders')}
      ${tile('chef-hat', 'Preparing', st.preparing, 'orders')}
      ${tile('package-check', 'Ready', st.ready, 'orders')}
      ${tile('check-circle-2', 'Completed', st.completed, 'analytics')}
    </div>
    ${!st.products ? `
    <div class="card card-pad mb-4 seller-empty-cta">
      <div class="font-bold mb-1">Add your first food</div>
      <button type="button" class="btn btn-primary" data-action="sell-add-item"><i data-lucide="plus"></i>Add food</button>
    </div>` : ''}
    <div class="flex justify-between items-center mb-2"><span class="section-title" style="font-size:16px;">Recent orders</span>
      ${recent.length ? `<button type="button" class="view-all-link" data-action="sell-tab" data-tab="orders">View all</button>` : ''}</div>
    ${recent.length ? recent.map(orderCard).join('') : `<div class="empty-state"><h3>No orders yet</h3></div>`}`;
  }

  // ---------------- Products ----------------
  function renderProducts() {
    const items = SL.data.items;
    return `
    <div class="flex justify-between items-center mb-3">
      <span class="section-title" style="font-size:16px;">My food (${items.length})</span>
      <button type="button" class="btn btn-primary btn-sm" data-action="sell-add-item"><i data-lucide="plus"></i>Add food</button>
    </div>
    ${items.length ? `<div class="seller-items">${items.map(itemRow).join('')}</div>` : `<div class="empty-state"><div class="icon-wrap"><i data-lucide="utensils"></i></div><h3>No food listed yet</h3></div>`}
    ${extrasSection()}`;
  }

  // ---- Extras ----
  function extrasSection() {
    const ex = SL.data.extras || [];
    return `
    <div class="flex justify-between items-center mb-2 mt-4">
      <span class="section-title" style="font-size:16px;">Extras (${ex.length})</span>
      <button type="button" class="btn btn-secondary btn-sm" data-action="sell-add-extra" ${SL.data.items.length ? '' : 'disabled'}><i data-lucide="plus"></i>Add extra</button>
    </div>
    ${ex.length ? `<div class="extra-list">${ex.map(e => {
      const n = SL.foodsFor(e.id).length;
      return `<div class="card card-pad extra-row">
        <div style="min-width:0;"><div class="font-bold">${esc(e.name)} <span class="text-muted" style="font-weight:600;">+${U.money(e.price)}</span></div>
        <div class="text-xs text-muted">${n ? `On ${n} food${n === 1 ? '' : 's'}` : 'Not on any food yet'}${e.available ? '' : ' · Off'}</div></div>
        <span class="flex gap-2"><button type="button" class="btn btn-secondary btn-sm" data-action="sell-edit-extra" data-id="${e.id}"><i data-lucide="pencil"></i>Edit</button>
        <button type="button" class="btn btn-ghost btn-sm" style="color:var(--color-error);" data-action="sell-delete-extra" data-id="${e.id}" aria-label="Remove"><i data-lucide="trash-2"></i></button></span>
      </div>`;
    }).join('')}</div>` : (SL.data.items.length ? '<div class="text-sm text-muted mb-2">No extras yet</div>' : '')}`;
  }
  function extraModal(extra) {
    const foods = extra ? SL.foodsFor(extra.id) : SL.data.items.map(m => m.id);
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">${extra ? 'Edit extra' : 'Add extra'}</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="sell-extra-form" data-id="${extra ? esc(extra.id) : ''}" novalidate>
          <div class="grid seller-two-col">
            <div class="field"><label for="ex-name">Extra *</label><input class="input" id="ex-name" name="name" maxlength="40" value="${esc(extra ? extra.name : '')}" placeholder="e.g. Extra cheese" /></div>
            <div class="field"><label for="ex-price">Price (R) *</label><input class="input" id="ex-price" name="price" type="number" min="0" max="200" step="0.50" inputmode="decimal" value="${extra ? esc(extra.price) : ''}" /></div>
          </div>
          <label class="checkbox-row mb-3"><input type="checkbox" name="available" ${!extra || extra.available ? 'checked' : ''} /> Available</label>
          <div class="field"><label>Offer it on</label>
            <div class="seller-cat-grid">${SL.data.items.map(m => `<label class="seller-cat"><input type="checkbox" name="foods" value="${m.id}" ${foods.includes(m.id) ? 'checked' : ''} /><span>${esc(m.name)}</span></label>`).join('')}</div>
          </div>
          <button type="submit" class="btn btn-primary btn-block btn-lg">Save extra</button>
        </form>
      </div>`);
  }
  async function submitExtra(data, form) {
    if (local.busy) return;
    local.busy = true;
    const res = await SL.saveExtra({ name: data.get('name'), price: data.get('price'), available: data.get('available') === 'on', foods: data.getAll('foods') }, form.dataset.id || null);
    local.busy = false;
    if (res.error) return App.Toast.error(res.error);
    App.Modal.close();
    App.Toast.success('Extra saved');
  }


  function itemRow(m) {
    const st = SL.listingStatus(m);
    return `
    <div class="card seller-item">
      <div class="seller-item-img media">${m.image ? `<img crossorigin="anonymous" src="${esc(m.image)}" alt="${esc(m.name)}" loading="lazy">` : ''}</div>
      <div class="seller-item-body">
        <div class="flex justify-between items-start gap-2">
          <div class="font-bold" style="font-size:14.5px;">${esc(m.name)}</div>
          <span class="badge ${st.cls}">${st.label}</span>
        </div>
        <div class="text-xs text-muted">${esc(catLabel(m.category))}${m.other_food_detail ? ': ' + esc(m.other_food_detail) : ''} · ${m.stock} left</div>
        <div class="font-bold mt-1">${U.money(m.price)}</div>
        ${m.status === 'rejected' && m.rejection_reason ? `<div class="text-xs mt-1" style="color:var(--color-error);">${esc(m.rejection_reason)}</div>` : ''}
        <div class="seller-item-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="sell-edit-item" data-id="${m.id}"><i data-lucide="pencil"></i>Edit</button>
          ${m.status === 'approved' ? `<button type="button" class="btn btn-ghost btn-sm" data-action="sell-toggle-item" data-id="${m.id}">${m.available ? 'Mark sold out' : 'Mark available'}</button>` : ''}
          <button type="button" class="btn btn-ghost btn-sm" style="color:var(--color-error);" data-action="sell-delete-item" data-id="${m.id}"><i data-lucide="trash-2"></i></button>
        </div>
      </div>
    </div>`;
  }

  function itemModal(item) {
    const m = item || { category: '', available: true, stock: 10, preparation_time: 20, allergens: [] };
    local.editing = { id: item ? item.id : null, image: m.image || '' };
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">${item ? 'Edit food' : 'Add food'}</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="sell-item-form" novalidate>
          <div class="field">
            <label>Photo *</label>
            <div class="image-upload">
              <div class="image-upload-preview seller-photo-preview" ${m.image ? '' : 'style="display:none;"'}>${m.image ? `<img src="${esc(m.image)}" alt="">` : ''}</div>
              <div class="image-upload-progress" style="display:none;"><div class="image-upload-progress-bar"></div></div>
              <label class="btn btn-secondary btn-sm image-upload-btn"><i data-lucide="camera"></i> <span class="image-upload-label">${m.image ? 'Change photo' : 'Add photo'}</span>
                <input type="file" accept="image/*" hidden data-action-change="sell-item-photo" /></label>
              <span class="image-upload-status text-xs text-muted"></span>
            </div>
          </div>
          <div class="field"><label for="si-name">Food name *</label><input class="input" id="si-name" name="name" maxlength="60" value="${esc(m.name || '')}" placeholder="e.g. Chicken Wrap" /></div>
          <div class="field"><label for="si-cat">Category *</label>
            <select class="select" id="si-cat" name="category" data-action-change="sell-item-cat">
              <option value="">Choose</option>
              ${App.CONST.STUDENT_FOOD_CATEGORIES.map(c => `<option value="${esc(c)}" ${m.category === c ? 'selected' : ''}>${esc(catLabel(c))}</option>`).join('')}
            </select></div>
          <div class="field" id="si-other-wrap" ${m.category === 'Other Food' ? '' : 'hidden'}><label for="si-other">What food is it? *</label><input class="input" id="si-other" name="other_food_detail" maxlength="120" value="${esc(m.other_food_detail || '')}" /></div>
          <div class="field"><label for="si-desc">Description *</label><textarea class="input" id="si-desc" name="description" rows="3" maxlength="400" placeholder="What's in it, portion size">${esc(m.description || '')}</textarea></div>
          <div class="grid seller-two-col">
            <div class="field"><label for="si-price">Price (R) *</label><input class="input" id="si-price" name="price" type="number" min="1" max="1000" step="0.50" inputmode="decimal" value="${m.price != null ? esc(m.price) : ''}" /></div>
            <div class="field"><label for="si-stock">Quantity available *</label><input class="input" id="si-stock" name="stock" type="number" min="0" max="999" step="1" inputmode="numeric" value="${esc(m.stock)}" /></div>
          </div>
          <div class="field"><label for="si-prep">Prep time (minutes)</label><input class="input" id="si-prep" name="prep_time" type="number" min="0" max="240" inputmode="numeric" value="${esc(m.preparation_time || 20)}" /></div>
          <div class="field"><label for="si-allergens">Allergens</label><input class="input" id="si-allergens" name="allergens" maxlength="200" value="${esc((m.allergens || []).join(', '))}" placeholder="e.g. nuts, milk, eggs, gluten" /></div>
          <label class="checkbox-row mb-3"><input type="checkbox" name="available" ${m.available ? 'checked' : ''} /> Available to order</label>
          ${item && item.status === 'approved' ? `<p class="text-xs text-muted mb-2">Changing the photo, name, description, category or price sends it for review again.</p>` : ''}
          <button type="submit" class="btn btn-primary btn-block btn-lg">${item ? 'Save' : 'Submit for review'}</button>
        </form>
      </div>`, { size: 'lg' });
  }

  function uploadItemPhoto(file, el) {
    if (!file) return;
    const shop = SL.myShop();
    const editing = local.editing;
    const mine = (photoPick.item = (photoPick.item || 0) + 1);
    return App.Upload.uploadIntoBox(file, el, { shopId: shop.id, kind: 'menu_item', itemId: editing && editing.id }, (url) => {
      if (editing && local.editing === editing && photoPick.item === mine) editing.image = url;
    });
  }

  function waitForUploads() {
    if (App.Upload.busy()) { App.Toast.info('Wait for the photo to finish uploading.'); return true; }
    return false;
  }

  async function submitItem(data) {
    if (local.busy || !local.editing || waitForUploads()) return;
    local.busy = true;
    const res = await SL.saveItem({
      image: local.editing.image, name: data.get('name'), category: data.get('category'),
      otherFoodDetail: data.get('other_food_detail'), description: data.get('description'),
      price: data.get('price'), stock: data.get('stock'), prepTime: data.get('prep_time'),
      allergens: data.get('allergens'), available: data.get('available') === 'on',
    }, local.editing.id);
    local.busy = false;
    if (res.error) return App.Toast.error(res.error);
    App.Modal.close();
    App.Toast.success(res.data.status === 'pending' ? 'Sent for review' : 'Saved');
    App.render();
  }

  // ---------------- Orders ----------------
  const ORDER_FILTERS = [
    { key: 'active', label: 'Active', test: o => ['received', 'preparing', 'ready'].includes(o.status) },
    { key: 'received', label: 'New', test: o => o.status === 'received' },
    { key: 'done', label: 'Completed', test: o => o.status === 'collected' },
    { key: 'cancelled', label: 'Cancelled', test: o => o.status === 'cancelled' },
    { key: 'all', label: 'All', test: () => true },
  ];
  const SELLER_STATUS = {
    received: ['New', 'badge-primary'], preparing: ['Preparing', 'badge-yellow'], ready: ['Ready for collection', 'badge-success'],
    collected: ['Completed', 'badge-gray'], cancelled: ['Cancelled', 'badge-error'],
  };

  function renderOrders() {
    const f = ORDER_FILTERS.find(x => x.key === local.orderFilter) || ORDER_FILTERS[0];
    const list = SL.data.orders.filter(f.test);
    return `
    <div class="chip-row mb-2">${ORDER_FILTERS.map(x => `<button type="button" class="chip ${x.key === f.key ? 'active' : ''}" data-action="sell-order-filter" data-key="${x.key}">${x.label} (${SL.data.orders.filter(x.test).length})</button>`).join('')}</div>
    ${list.length ? list.map(orderCard).join('') : `<div class="empty-state"><h3>No orders</h3></div>`}`;
  }

  function orderCard(o) {
    const st = SELLER_STATUS[o.status] || [o.status, 'badge-gray'];
    const dl = o.delivery_location || {};
    const notes = [dl.instructions].concat((o.items || []).map(it => it.specialInstructions)).filter(Boolean);
    const phone = SL.normalizeWhatsApp(dl.phone);
    return `
    <div class="card card-pad seller-order mb-2">
      <div class="flex justify-between items-center gap-2">
        <div class="font-bold">${esc(o.order_number || '')}</div>
        <span class="badge ${st[1]}">${st[0]}</span>
      </div>
      <div class="text-xs text-muted mb-2">${esc(U.formatDateTime(o.created_at))}${dl.collectionTime ? ` · Collect ${esc(new Date(dl.collectionTime).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Johannesburg' }))}, ${esc(U.formatTime(dl.collectionTime))}` : ''}</div>
      <ul class="seller-order-items">${(o.items || []).map(it => `<li><span>${Number(it.qty) || 1} × ${esc(it.name)}</span><span>${U.money((Number(it.price) || 0) * (Number(it.qty) || 1))}</span></li>`).join('')}</ul>
      ${notes.length ? `<div class="text-sm mt-1"><strong>Note:</strong> ${notes.map(esc).join(' · ')}</div>` : ''}
      <div class="flex justify-between items-center mt-2 gap-2" style="flex-wrap:wrap;">
        <div class="text-sm"><i data-lucide="user" style="width:13px;height:13px;vertical-align:-2px;"></i> ${esc(dl.customerName || 'Student')}${phone ? ` · <a href="https://wa.me/${phone}" target="_blank" rel="noopener">${esc(SL.formatWhatsApp(phone))}</a>` : ''}</div>
        <div class="font-bold">${U.money(o.total)}</div>
      </div>
      ${['received', 'preparing', 'ready'].includes(o.status) ? `
      <div class="seller-order-actions">
        ${o.status === 'received' ? `<button type="button" class="btn btn-primary btn-sm" data-action="sell-order" data-id="${o.id}" data-op="accept">Accept</button>` : ''}
        ${o.status === 'preparing' ? `<button type="button" class="btn btn-primary btn-sm" data-action="sell-order" data-id="${o.id}" data-op="ready">Ready for collection</button>` : ''}
        ${o.status === 'ready' ? `<button type="button" class="btn btn-success btn-sm" data-action="sell-order" data-id="${o.id}" data-op="complete">Completed</button>` : ''}
        <button type="button" class="btn btn-ghost btn-sm" style="color:var(--color-error);" data-action="sell-cancel-order" data-id="${o.id}">${o.status === 'received' ? 'Decline' : 'Cancel'}</button>
      </div>` : ''}
      ${o.status === 'cancelled' && o.cancel_reason === 'customer_cancelled' ? `<div class="text-xs text-muted mt-1">Cancelled by the customer${o.cancel_note ? ': ' + esc(String(o.cancel_note).replace(/^Customer: /, '')) : ''}</div>` : ''}
    </div>`;
  }

  function cancelModal(orderId) {
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Cancel order</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="sell-cancel-form" data-id="${esc(orderId)}">
          <div class="field"><label for="sc-reason">Reason</label>
            <select class="select" id="sc-reason" name="reason">
              <option value="product_unavailable">Food not available</option>
              <option value="kitchen_cancelled">Can't make it in time</option>
              <option value="other">Other</option>
            </select></div>
          <div class="field"><label for="sc-note">Message to the customer</label><input class="input" id="sc-note" name="note" maxlength="200" /></div>
          <div class="modal-footer" style="padding:12px 0 0;"><button type="button" class="btn btn-secondary" data-action="close-modal">Back</button><button type="submit" class="btn btn-danger">Cancel order</button></div>
        </form>
      </div>`);
  }

  function completeModal(orderId) {
    const o = SL.data.orders.find(x => x.id === orderId);
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Order collected?</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="sell-complete-form" data-id="${esc(orderId)}" novalidate>
          <p class="text-sm mb-3">Ask ${esc((o && o.delivery_location && o.delivery_location.customerName) || 'the buyer')} for the collection code on their order${o ? ' ' + esc(o.order_number) : ''}.</p>
          <div class="field"><label for="sc-code">Collection code</label><input class="input collect-code-input" id="sc-code" name="code" maxlength="36" autocomplete="off" autocapitalize="characters" inputmode="text" placeholder="e.g. 7F3A9C" /></div>
          <div class="modal-footer" style="padding:12px 0 0;"><button type="button" class="btn btn-secondary" data-action="close-modal">Back</button><button type="submit" class="btn btn-success">Mark collected</button></div>
        </form>
      </div>`);
    setTimeout(() => { const i = document.getElementById('sc-code'); if (i) i.focus(); }, 50);
  }

  async function runOrder(id, op, reason, note, btn, code) {
    if (local.busy) return;
    local.busy = true;
    if (btn) btn.classList.add('btn-loading');
    if (op === 'complete' && !code) { local.busy = false; if (btn) btn.classList.remove('btn-loading'); return App.Toast.error("Enter the buyer's collection code."); }
    const res = await SL.orderAction(id, op, reason, note, code);
    local.busy = false;
    if (res.error) { if (btn) btn.classList.remove('btn-loading'); return App.Toast.error(res.error); }
    App.Modal.close();
    App.render();
  }

  // ---------------- Analytics ----------------
  function renderAnalytics() {
    const st = SL.stats();
    const maxDay = Math.max(1, ...st.days.map(d => d.count));
    const maxPop = Math.max(1, ...st.popular.map(p => p[1]));
    return `
    <div class="stats-grid seller-stats four">
      ${tile('utensils', 'Products listed', st.products)}
      ${tile('receipt', 'Orders received', st.received)}
      ${tile('check-circle-2', 'Completed', st.completed)}
      ${tile('x-circle', 'Cancelled', st.cancelled)}
    </div>
    <div class="card card-pad mb-3">
      <div class="font-bold mb-1">Completed order value</div>
      <div class="stat-value" style="font-size:24px;font-weight:700;">${U.money(st.completedValue)}</div>
      <div class="text-xs text-muted">From order prices. ClickFood doesn't see your payments.</div>
    </div>
    ${st.popular.length ? `
    <div class="card card-pad mb-3">
      <div class="font-bold mb-2">Popular food</div>
      ${st.popular.map(([name, n]) => `<div class="hbar-row"><span class="hbar-label">${esc(name)}</span><span class="hbar-track"><span class="hbar-fill" style="width:${(n / maxPop) * 100}%"></span></span><span class="hbar-value">${n}</span></div>`).join('')}
    </div>` : ''}
    ${st.received ? `
    <div class="card card-pad mb-3">
      <div class="font-bold mb-2">Orders, last 14 days</div>
      <div class="seller-days">${st.days.map(d => `<div class="seller-day" title="${esc(d.date.toLocaleDateString())}: ${d.count}"><span style="height:${Math.round((d.count / maxDay) * 100)}%"></span><em>${d.date.getDate()}</em></div>`).join('')}</div>
    </div>` : ''}`;
  }

  // ---------------- Shop settings ----------------
  function renderShopSettings(shop) {
    const p = SL.data.profile || {};
    const cats = p.food_categories || shop.product_categories || [];
    return `
    <div class="card card-pad mb-3">
      <div class="flex justify-between items-center gap-2">
        <div><div class="font-bold">${shop.store_closed ? 'Shop is paused' : 'Taking orders'}</div></div>
        <button type="button" class="btn ${shop.store_closed ? 'btn-primary' : 'btn-secondary'} btn-sm" data-action="sell-toggle-open">${shop.store_closed ? 'Open shop' : 'Pause orders'}</button>
      </div>
    </div>
    ${scheduleCard(shop)}
    <div class="card card-pad mb-3">
      <div class="font-bold mb-2">Shop photo</div>
      ${photoField('shopcover', 'Shown to buyers', shop.cover_image_url, true)}
    </div>
    <div class="card card-pad mb-3">
      <div class="flex justify-between items-start gap-2">
        <div style="min-width:0;"><div class="font-bold">Pickup address</div><div class="text-sm text-muted">${esc(shop.address || '')}</div></div>
        <button type="button" class="btn btn-secondary btn-sm" data-action="sell-edit-pickup"><i data-lucide="map-pin"></i>Change</button>
      </div>
    </div>
    ${shop.university === UP_NAME ? `<div class="card card-pad mb-3" id="hustleup-card">
      <div class="font-bold mb-2">Are you a hustleUP member?</div>
      <div class="seg-choice">
        <label class="seg-opt"><input type="radio" name="hustleup_edit" value="yes" ${p.hustleup_member ? 'checked' : ''} data-action-change="sell-hustle" /><span>Yes</span></label>
        <label class="seg-opt"><input type="radio" name="hustleup_edit" value="no" ${p.hustleup_member === false ? 'checked' : ''} data-action-change="sell-hustle" /><span>No</span></label>
      </div>
    </div>` : ''}
    <form data-form="sell-wa-form" class="card card-pad mb-3" novalidate>
      <div class="font-bold mb-2">WhatsApp number</div>
      <div class="flex gap-2 items-end">
        <input class="input" name="whatsapp" type="tel" aria-label="WhatsApp number" value="${esc(SL.formatWhatsApp(p.whatsapp))}" placeholder="072 123 4567" style="flex:1;min-width:0;" />
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
    <form data-form="sell-shop-form" class="card card-pad mb-3">
      <div class="font-bold mb-2">Shop details</div>
      <div class="field"><label>Business name</label><input class="input" name="name" maxlength="60" value="${esc(shop.name)}" /></div>
      <div class="field"><label>Describe your food business</label><textarea class="input" name="description" rows="2" maxlength="300">${esc(shop.description || '')}</textarea></div>
      ${detailsFields({
        business_type: shop.business_type || '', contact_phone: SL.formatWhatsApp(shop.contact_phone) || shop.contact_phone || '', contact_email: shop.contact_email || '',
        is_registered: !!shop.is_registered_business, registration_date: shop.registration_date || '',
        manager_phone: SL.formatWhatsApp(shop.manager_phone) || shop.manager_phone || '', manager_position: shop.manager_position || 'owner',
        open_days: [0, 1, 2, 3, 4, 5, 6].filter(i => !(shop.closed_days || []).includes(i)),
        opening_time: String(shop.opening_time || '').slice(0, 5), closing_time: String(shop.closing_time || '').slice(0, 5), products_summary: shop.products_summary || '',
      }, 'shop')}
      <div class="field"><label>Food you sell</label>${categoryChecks('shop', cats)}</div>
      <div class="field" data-other-for="shop" ${cats.includes('Other Food') ? '' : 'hidden'}><label>Other food</label><input class="input" name="other_food" maxlength="120" value="${esc(p.other_food || '')}" /></div>
      <button type="submit" class="btn btn-primary btn-block">Save</button>
    </form>
    <div class="card card-pad mb-3 danger-card">
      <div class="font-bold">Delete shop</div>
      <div class="text-sm text-muted mb-2">Removes your shop and all its food from ClickFood. Not possible while orders are in progress.</div>
      <button type="button" class="btn btn-danger btn-sm" data-action="sell-delete-shop"><i data-lucide="trash-2"></i>Delete my shop</button>
    </div>
    <div class="card card-pad">
      <div class="font-bold mb-2">Seller rules</div>
      <ul class="seller-rules">${App.CONST.SELLER_RULES.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
    </div>`;
  }

  function categoryChecks(group, selected) {
    return `<div class="seller-cat-grid">${App.CONST.STUDENT_FOOD_CATEGORIES.map(c => `
      <label class="seller-cat"><input type="checkbox" name="cat" value="${esc(c)}" data-group="${group}" data-action-change="sell-cat" ${selected.includes(c) ? 'checked' : ''} /><span>${esc(catLabel(c))}</span></label>`).join('')}</div>`;
  }

  // ---------------- Setup (become a seller) ----------------
  // Setup form state lives here (not only in the DOM) so a redraw never
  // loses what the student typed or uploaded.
  const setup = { v: null };
  function setupState() {
    if (setup.v) return setup.v;
    const p = S.state.profile || {};
    const pre = SL.pendingSignup() || {};
    setup.v = {
      business_name: pre.businessName || '', whatsapp: SL.formatWhatsApp(pre.whatsapp) || p.phone || '',
      campus: pre.campus || App.Auth.campusesOf(p)[0] || p.campus_location || 'Hatfield',
      cats: pre.categories || [], other_food: pre.otherFood || '', description: pre.description || '',
      address: p.home_address || '', pin: p.home_lat != null ? { lat: p.home_lat, lng: p.home_lng } : null,
      cover: '', logo: '', hustleup: null, rules: !!pre.acceptRules,
      details: {
        business_type: '', contact_phone: SL.formatWhatsApp(pre.whatsapp) || p.phone || '', contact_email: p.email || '',
        is_registered: false, registration_date: '', manager_phone: SL.formatWhatsApp(pre.whatsapp) || p.phone || '', manager_position: 'owner',
        open_days: [1, 2, 3, 4, 5], opening_time: '08:00', closing_time: '17:00', products_summary: '',
      },
    };
    return setup.v;
  }

  function photoField(key, label, url, required) {
    return `<div class="field">
      <label>${label}${required ? ' *' : ' <span class="text-muted" style="font-weight:400;">(optional)</span>'}</label>
      <div class="image-upload">
        <div class="image-upload-preview ${key === 'cover' ? 'seller-cover-preview' : ''}" ${url ? '' : 'style="display:none;"'}>${url ? `<img src="${esc(url)}" alt="">` : ''}</div>
        <label class="btn btn-secondary btn-sm image-upload-btn"><i data-lucide="camera"></i> <span class="image-upload-label">${url ? 'Change' : 'Add photo'}</span>
          <input type="file" accept="image/*" hidden data-action-change="${key === 'shopcover' ? 'sell-shop-cover' : 'sell-setup-photo'}" data-key="${key}" /></label>
        <span class="image-upload-status text-xs text-muted"></span>
      </div>
    </div>`;
  }

  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // The business questions the developer sees on every application.
  // ctx 'setup' keeps answers in setupState(); 'shop' reads them from the form.
  function detailsFields(d, ctx) {
    const inp = (key) => ctx === 'setup' ? `data-action-input="sell-detail" data-key="${key}"` : `name="${key}"`;
    const chg = (key) => ctx === 'setup' ? `data-action-change="sell-detail-change" data-key="${key}"` : `name="${key}"`;
    return `
        <div class="field"><label>Business type *</label>
          <select class="select" ${chg('business_type')}><option value="">Choose</option>${SL.BUSINESS_TYPES.map(([k, l]) => `<option value="${k}" ${d.business_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="grid seller-two-col">
          <div class="field"><label>Business phone *</label><input class="input" type="tel" value="${esc(d.contact_phone)}" placeholder="072 123 4567" ${inp('contact_phone')} /></div>
          <div class="field"><label>Business email *</label><input class="input" type="email" value="${esc(d.contact_email)}" ${inp('contact_email')} /></div>
        </div>
        <div class="grid seller-two-col">
          <div class="field"><label>Your phone *</label><input class="input" type="tel" value="${esc(d.manager_phone)}" placeholder="072 123 4567" ${inp('manager_phone')} /></div>
          <div class="field"><label>Your role *</label>
            <select class="select" ${chg('manager_position')}>${SL.POSITIONS.map(([k, l]) => `<option value="${k}" ${d.manager_position === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        </div>
        <div class="field">
          <label>Is your business registered (CIPC)? *</label>
          <div class="seg-choice">
            <label class="seg-opt"><input type="radio" name="${ctx}_is_registered" value="yes" ${d.is_registered ? 'checked' : ''} data-action-change="sell-detail-reg" data-ctx="${ctx}" /><span>Yes</span></label>
            <label class="seg-opt"><input type="radio" name="${ctx}_is_registered" value="no" ${!d.is_registered ? 'checked' : ''} data-action-change="sell-detail-reg" data-ctx="${ctx}" /><span>No</span></label>
          </div>
        </div>
        <div class="field" data-reg-date="${ctx}" ${d.is_registered ? '' : 'hidden'}><label>Registration date *</label><input class="input" type="date" max="${new Date().toISOString().slice(0, 10)}" value="${esc(d.registration_date || '')}" ${inp('registration_date')} /></div>
        ${ctx === 'setup' ? `<div class="field"><label>Days you sell *</label>
          <div class="seller-days-pick">${DAY_SHORT.map((n, i) => `<label class="seller-cat"><input type="checkbox" value="${i}" ${(d.open_days || []).includes(i) ? 'checked' : ''} ${ctx === 'setup' ? 'data-action-change="sell-detail-day"' : 'name="open_days"'} /><span>${n}</span></label>`).join('')}</div></div>
        <div class="grid seller-two-col">
          <div class="field"><label>Opening time *</label><input class="input" type="time" value="${esc(d.opening_time)}" ${inp('opening_time')} /></div>
          <div class="field"><label>Closing time *</label><input class="input" type="time" value="${esc(d.closing_time)}" ${inp('closing_time')} /></div>
        </div>
        <div class="text-xs text-muted mb-3">You can set different times for each day later in My Shop.</div>` : ''}
        <div class="field"><label>What food do you sell? *</label><input class="input" maxlength="300" value="${esc(d.products_summary)}" placeholder="e.g. Kotas, vetkoek and cold drinks" ${inp('products_summary')} /></div>`;
  }

  // ---- My selling times: a different time for each day ----
  const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function shopSchedule(shop) {
    return [0, 1, 2, 3, 4, 5, 6].map(i => {
      const h = App.Stores.hoursOn(shop, i);
      return h ? { on: true, open: h.open, close: h.close } : { on: false, open: '', close: '' };
    });
  }
  function scheduleCard(shop) {
    const days = shopSchedule(shop);
    return `
    <form data-form="sell-schedule-form" class="card card-pad mb-3" novalidate>
      <div class="font-bold mb-2">My selling times</div>
      <div class="sched-list">
        ${days.map((d, i) => `
        <div class="sched-row ${d.on ? '' : 'sched-off'}" data-day="${i}">
          <label class="sched-day"><input type="checkbox" name="on_${i}" ${d.on ? 'checked' : ''} data-action-change="sell-sched-toggle" data-day="${i}" /><span>${DAY_LONG[i]}</span></label>
          <span class="sched-times">
            <input class="input" type="time" name="open_${i}" value="${esc(d.open || '08:00')}" aria-label="${DAY_LONG[i]} from" ${d.on ? '' : 'disabled'} />
            <span class="text-muted">to</span>
            <input class="input" type="time" name="close_${i}" value="${esc(d.close || '17:00')}" aria-label="${DAY_LONG[i]} until" ${d.on ? '' : 'disabled'} />
          </span>
        </div>`).join('')}
      </div>
      <button type="submit" class="btn btn-primary btn-block mt-3">Save selling times</button>
    </form>`;
  }
  async function saveScheduleForm(data, form) {
    if (local.busy) return;
    const days = [0, 1, 2, 3, 4, 5, 6].map(i => ({ on: data.get('on_' + i) === 'on', open: data.get('open_' + i) || form.querySelector(`[name="open_${i}"]`).value, close: data.get('close_' + i) || form.querySelector(`[name="close_${i}"]`).value }));
    local.busy = true;
    const res = await SL.saveSchedule(days);
    local.busy = false;
    if (res.error) return App.Toast.error(res.error);
    App.Toast.success('Selling times saved');
    App.render();
  }

  // (2026-10-17) a student shop needs an APPROVED Student Entrepreneur
  // application (the database refuses the shop otherwise); until then the
  // programme page shows the student where they are
  const UP_NAME = 'University of Pretoria';
  const APP_CATS = { breakfast: ['Breakfast'], lunch: ['Lunch'], dinner: ['Dinner'], snacks: ['Snacks'], baked: ['Baked Goods', 'Desserts'], drinks: ['Drinks'], other: ['Other Food'] };
  function approvedApplication() {
    const es = App.Pages.Entrepreneur.status();
    if (!es) { App.Pages.Entrepreneur.load(false); return undefined; }
    const a = es.application;
    return a && a.status === 'approved' ? a : null;
  }
  // the approved application fills in what it already answered
  function prefillFromApplication(v, a) {
    if (setup.prefilled === a.id) return;
    setup.prefilled = a.id;
    if (!v.business_name) v.business_name = a.business_name || '';
    if (!v.cats.length) v.cats = [...new Set((a.categories || []).flatMap(c => APP_CATS[c] || []))];
    if (!v.other_food && a.other_category) v.other_food = a.other_category;
    if (!v.description && a.description) v.description = a.description.slice(0, 300);
    if (a.phone && !v.whatsapp) v.whatsapp = SL.formatWhatsApp(a.phone);
    if (a.available_days && a.available_days.length) v.details.open_days = a.available_days.slice();
    // contact details and "what you sell" come from the application too (the server still checks them)
    const p = S.state.profile || {};
    const phone = a.phone ? SL.formatWhatsApp(a.phone) : (p.phone || '');
    v.details.contact_phone = v.details.contact_phone || phone;
    v.details.manager_phone = v.details.manager_phone || phone;
    v.details.contact_email = v.details.contact_email || p.email || '';
    v.details.manager_position = v.details.manager_position || 'owner';
    if (!v.details.products_summary) v.details.products_summary = String(a.description || a.business_name || '').slice(0, 300);
  }

  // ---- shop setup draft, saved in the database (supabase/entrepreneur_single_application.sql) ----
  const DRAFT_KEYS = ['business_name', 'whatsapp', 'campus', 'address', 'pin', 'cover', 'logo', 'hustleup', 'details'];
  function loadShopDraft(v) {
    if (setup.draftLoaded) return;
    setup.draftLoaded = 'loading';
    App.sb.from('shop_setup_drafts').select('data, updated_at').maybeSingle().then(({ data, error }) => {
      setup.draftLoaded = true;
      if (error || !data || !data.data) return App.render();
      const d = data.data;
      for (const k of DRAFT_KEYS) {
        if (d[k] === undefined || d[k] === null || d[k] === '') continue;
        if (k === 'details') v.details = Object.assign({}, v.details, d.details);
        else v[k] = d[k];
      }
      setup.draftSavedAt = data.updated_at;
      App.render();
    });
  }
  async function saveShopDraft(btn) {
    if (local.busy) return;
    const v = setupState();
    if (!S.state.connection.online) return App.Toast.error('You are offline. Connect to the internet to save your draft.');
    local.busy = true; if (btn) btn.classList.add('btn-loading');
    const payload = {}; for (const k of DRAFT_KEYS) payload[k] = v[k];
    const { data, error } = await App.sb.rpc('save_shop_setup_draft', { p: payload });
    local.busy = false; if (btn) btn.classList.remove('btn-loading');
    if (error || !data || !data.ok) return App.Toast.error((data && data.error) || 'Could not save your draft. Please try again.');
    setup.draftSavedAt = data.saved_at;
    App.Toast.success('Draft saved successfully.');
    App.render();
  }

  // the shop's own details (the application already answered the rest)
  function setupDetailsFields(d) {
    const inp = (key) => `data-action-input="sell-detail" data-key="${key}"`;
    return `
        <div class="field"><label>Business type *</label>
          <select class="select" data-action-change="sell-detail-change" data-key="business_type"><option value="">Choose</option>${SL.BUSINESS_TYPES.map(([k, l]) => `<option value="${k}" ${d.business_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field">
          <label>Is your business registered (CIPC)? *</label>
          <div class="seg-choice">
            <label class="seg-opt"><input type="radio" name="setup_is_registered" value="yes" ${d.is_registered ? 'checked' : ''} data-action-change="sell-detail-reg" data-ctx="setup" /><span>Yes</span></label>
            <label class="seg-opt"><input type="radio" name="setup_is_registered" value="no" ${!d.is_registered ? 'checked' : ''} data-action-change="sell-detail-reg" data-ctx="setup" /><span>No</span></label>
          </div>
        </div>
        <div class="field" data-reg-date="setup" ${d.is_registered ? '' : 'hidden'}><label>Registration date *</label><input class="input" type="date" max="${new Date().toISOString().slice(0, 10)}" value="${esc(d.registration_date || '')}" ${inp('registration_date')} /></div>
        <div class="field"><label>Days you sell *</label>
          <div class="seller-days-pick">${DAY_SHORT.map((n, i) => `<label class="seller-cat"><input type="checkbox" value="${i}" ${(d.open_days || []).includes(i) ? 'checked' : ''} data-action-change="sell-detail-day" /><span>${n}</span></label>`).join('')}</div></div>
        <div class="grid seller-two-col">
          <div class="field"><label>Opening time *</label><input class="input" type="time" value="${esc(d.opening_time)}" ${inp('opening_time')} /></div>
          <div class="field"><label>Closing time *</label><input class="input" type="time" value="${esc(d.closing_time)}" ${inp('closing_time')} /></div>
        </div>`;
  }

  function renderSetup() {
    const approved = approvedApplication();
    if (approved === undefined) return '<div class="page-wrap"><div class="card skeleton" style="height:200px;"></div></div>';
    if (!approved) return App.Pages.Entrepreneur.render();
    const v = setupState();
    prefillFromApplication(v, approved);
    loadShopDraft(v);
    if (setup.draftLoaded === 'loading') return '<div class="page-wrap"><div class="card skeleton" style="height:200px;"></div></div>';
    const p0 = S.state.profile || {};
    // hustleUP is a University of Pretoria programme: only UP students are asked (the database enforces it too)
    const upSeller = (approved.university || p0.university) === UP_NAME;
    if (!upSeller) v.hustleup = false;
    const shopUni = approved.university || U.universityOfEmail(p0.email) || p0.university || UP_NAME;
    const campuses = App.CONST.UNIVERSITY_CAMPUSES[shopUni] || [];
    // the campus already chosen in Profile is used, not asked again; otherwise the shown option is the saved one
    if (campuses.length && !campuses.includes(v.campus)) v.campus = campuses.includes(p0.campus_location) ? p0.campus_location : campuses[0];
    const campusFromProfile = campuses.length && p0.campus_location && v.campus === p0.campus_location && !setup.changeCampus;
    const inp = (key) => `data-action-input="sell-setup-field" data-key="${key}"`;
    App.MapPicker.ensure('shop-map', v.pin, (pin, info) => { v.pin = pin; const t = App.MapPicker.fillIfEmpty('ss-addr', info); if (t) v.address = t; });
    return `
    <div class="page-wrap" style="max-width:560px;">
      ${App.Nav.backButton('more', 'solo')}
      <h1 class="page-title mb-1">Set up your shop</h1>
      <div class="mb-3"><span class="badge badge-success"><i data-lucide="badge-check" style="width:12px;height:12px;"></i> Student Entrepreneur approved</span></div>
      <div class="card card-pad mb-3" id="setup-from-application">
        <div class="font-bold mb-1">From your approved application</div>
        <div class="text-sm"><b>Food:</b> ${esc(v.cats.map(catLabel).concat(v.other_food ? [v.other_food] : []).join(', ') || 'Not set')}</div>
        <div class="text-sm text-muted mt-1">${esc(v.description)}</div>
      </div>
      <form data-form="sell-setup-form" class="card card-pad" novalidate>
        <div class="field"><label for="ss-name">Food business name *</label><input class="input" id="ss-name" maxlength="60" value="${esc(v.business_name)}" placeholder="e.g. Mpho's Kitchen" ${inp('business_name')} /></div>
        <div class="field"><label for="ss-wa">WhatsApp number *</label><input class="input" id="ss-wa" type="tel" value="${esc(v.whatsapp)}" placeholder="072 123 4567" ${inp('whatsapp')} /></div>
        ${upSeller ? `<div class="field" id="hustleup-field">
          <label>Are you a hustleUP member? *</label>
          <div class="seg-choice">
            <label class="seg-opt"><input type="radio" name="hustleup" value="yes" ${v.hustleup === true ? 'checked' : ''} data-action-change="sell-setup-hustle" /><span>Yes</span></label>
            <label class="seg-opt"><input type="radio" name="hustleup" value="no" ${v.hustleup === false ? 'checked' : ''} data-action-change="sell-setup-hustle" /><span>No</span></label>
          </div>
        </div>` : ''}
        ${photoField('cover', 'Photo of your shop', v.cover, true)}
        <div class="field"><label for="ss-addr">Pickup address *</label><input class="input" id="ss-addr" maxlength="160" value="${esc(v.address)}" placeholder="e.g. Tuks Village, Block C, Room 12" ${inp('address')} /></div>
        <div class="field"><label>Pickup point on the map *</label><div id="shop-map" class="map-picker" data-hero-key="map"></div></div>
        ${campusFromProfile ? `<div class="field" id="ss-campus-fixed"><label>Campus</label><div class="flex items-center gap-2"><span class="font-semibold">${esc(App.Discovery.campusLabel(shopUni, v.campus))}</span><button type="button" class="link-btn" data-action="sell-change-campus">Change</button></div></div>` : `<div class="field"><label for="ss-campus">Campus *</label>
          ${campuses.length ? `<select class="select" id="ss-campus" data-action-change="sell-setup-select" data-key="campus">${campuses.map(c => `<option value="${esc(c)}" ${c === v.campus ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>` : `<input class="input" id="ss-campus" maxlength="60" value="${esc(campuses.includes(v.campus) ? v.campus : (v.campus === 'Hatfield' ? '' : v.campus || ''))}" placeholder="Your campus or area" ${inp('campus')} />`}</div>`}
        ${setupDetailsFields(v.details)}
        ${photoField('logo', 'Logo', v.logo, false)}
        <div class="seller-rules-box mb-3">
          <div class="font-bold mb-1">Seller rules</div>
          <ul class="seller-rules">${App.CONST.SELLER_RULES.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
          <label class="checkbox-row mt-2"><input type="checkbox" ${v.rules ? 'checked' : ''} data-action-change="sell-setup-rules" /> I agree to the seller rules</label>
        </div>
        <button type="submit" class="btn btn-primary btn-block btn-lg">Send for Review</button>
        <button type="button" class="btn btn-secondary btn-block mt-2" data-action="sell-setup-draft">Save as Draft</button>
        ${setup.draftSavedAt ? `<div class="text-xs text-muted mt-2" id="setup-draft-saved">Draft saved ${esc(U.formatDateTime(setup.draftSavedAt))}</div>` : ''}
      </form>
    </div>`;
  }

  // Before the shop exists there is no shop folder, so setup photos go in
  // the student's own folder; the shop keeps their public URLs.
  function uploadSetupPhoto(file, el, key) {
    if (!file) return;
    const mine = (photoPick[key] = (photoPick[key] || 0) + 1);
    return App.Upload.uploadIntoBox(file, el, { kind: 'avatar' }, (url) => { if (photoPick[key] === mine) setupState()[key] = url; });
  }

  function checkedCats(form) {
    return [...form.querySelectorAll('input[name="cat"]:checked')].map(i => i.value);
  }

  async function submitSetup(data, form) {
    if (local.busy || waitForUploads()) return;
    const v = setupState();
    local.busy = true;
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.classList.add('btn-loading');
    const res = await SL.becomeSeller({
      businessName: v.business_name, whatsapp: v.whatsapp, campus: v.campus,
      categories: v.cats, otherFood: v.other_food, description: v.description, details: v.details,
      logoUrl: v.logo, coverUrl: v.cover, address: v.address, pin: v.pin, hustleup: v.hustleup,
      acceptRules: v.rules,
    });
    local.busy = false;
    if (btn) btn.classList.remove('btn-loading');
    if (res.error) return App.Toast.error(res.error);
    setup.v = null;
    App.Toast.success('Sent for review');
    if (App.Pages.Entrepreneur) App.Pages.Entrepreneur.reset();
    S.setRoute({ view: 'sell', params: { tab: 'products' } });
  }

  async function submitShop(data, form) {
    if (local.busy || waitForUploads()) return;
    local.busy = true;
    const prof = await SL.saveProfile({ whatsapp: (SL.data.profile || {}).whatsapp, categories: checkedCats(form), otherFood: data.get('other_food') });
    let res = prof;
    if (!prof.error) {
      const name = U.sanitizeText(data.get('name'), 60);
      if (!name || name.length < 2) res = { error: 'Please enter your business name.' };
      else res = await SL.updateShop({ name });
      if (!res.error) res = await SL.updateDetails(U.sanitizeText(data.get('description'), 300) || '', {
        business_type: data.get('business_type'), contact_phone: data.get('contact_phone'), contact_email: data.get('contact_email'),
        is_registered: data.get('shop_is_registered') === 'yes', registration_date: data.get('registration_date'),
        manager_phone: data.get('manager_phone'), manager_position: data.get('manager_position'),
        open_days: [0, 1, 2, 3, 4, 5, 6].filter(i => !(SL.myShop().closed_days || []).includes(i)), opening_time: String(SL.myShop().opening_time || '08:00').slice(0, 5), closing_time: String(SL.myShop().closing_time || '17:00').slice(0, 5),
        products_summary: data.get('products_summary'),
      });
    }
    local.busy = false;
    if (res.error) return App.Toast.error(res.error);
    App.Toast.success('Saved');
    App.render();
  }

  // ---------------- Pickup address on a map ----------------
  const pickup = { pin: null, busy: false };
  function pickupModal() {
    const shop = SL.myShop();
    pickup.pin = shop.pickup_lat != null ? { lat: shop.pickup_lat, lng: shop.pickup_lng } : null;
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Pickup address</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="sell-pickup-form" novalidate>
          <div class="field"><label for="sp-addr">Address</label><input class="input" id="sp-addr" name="address" maxlength="160" value="${esc(shop.address || '')}" /></div>
          <div class="field"><label>Pickup point on the map</label><div id="pickup-modal-map" class="map-picker"></div></div>
          <button type="submit" class="btn btn-primary btn-block btn-lg">Save</button>
        </form>
      </div>`, { size: 'lg' });
    App.MapPicker.mount(document.getElementById('pickup-modal-map'), pickup.pin, (pin, info) => { pickup.pin = pin; App.MapPicker.fillIfEmpty('sp-addr', info); });
  }
  async function savePickup(data, form) {
    if (pickup.busy) return;
    const address = U.sanitizeText(data.get('address') || '', 160);
    if (address.length < 5) return App.Toast.error('Please enter your pickup address.');
    if (!pickup.pin) return App.Toast.error('Please put your pickup point on the map.');
    pickup.busy = true;
    const res = await SL.updateShop({ address, pickup_lat: pickup.pin.lat, pickup_lng: pickup.pin.lng });
    pickup.busy = false;
    if (res.error) return App.Toast.error(res.error);
    App.Modal.close();
    App.Toast.success('Pickup address saved');
    App.render();
  }
  function uploadShopCover(file, el) {
    return App.Upload.uploadIntoBox(file, el, { kind: 'cover', shopId: SL.myShop().id }, async (url) => {
      const r = await SL.updateShop({ cover_image_url: url });
      if (r.error) return App.Toast.error(r.error);
      App.Toast.success('Shop photo saved');
    });
  }

  async function deleteShop(data, form) {
    if (local.busy) return;
    if (String(data.get('confirm') || '').trim().toUpperCase() !== 'DELETE') return App.Toast.error('Type DELETE to confirm.');
    local.busy = true;
    const btn = form.querySelector('button[type="submit"]'); if (btn) btn.classList.add('btn-loading');
    const res = await SL.deleteShop();
    local.busy = false;
    if (btn) btn.classList.remove('btn-loading');
    if (res.error) return App.Toast.error(res.error);
    App.Modal.close();
    App.Toast.success('Your shop was deleted');
    S.setRoute({ view: 'home', params: {} });
  }

  // ---------------- Events ----------------
  function handleAction(action, ds, el) {
    switch (action) {
      case 'sell-edit-pickup': return pickupModal();
      case 'sell-change-campus': setup.changeCampus = true; return App.render();
      case 'sell-setup-draft': return saveShopDraft(el);
      case 'sell-add-extra': return extraModal(null);
      case 'sell-edit-extra': { const e = (SL.data.extras || []).find(x => x.id === ds.id); if (e) extraModal(e); return; }
      case 'sell-delete-extra': {
        const e = (SL.data.extras || []).find(x => x.id === ds.id);
        if (!e) return;
        return App.Modal.confirm({ title: 'Remove this extra?', message: e.name, variant: 'warn', confirmLabel: 'Remove', cancelLabel: 'Keep',
          onConfirm: async () => { const r = await SL.deleteExtra(e.id); if (r.error) App.Toast.error(r.error); } });
      }
      case 'sell-delete-shop': {
        const n = SL.data.orders.filter(o => ['received', 'preparing', 'ready'].includes(o.status)).length;
        if (n) return App.Toast.error(`You have ${n} order${n === 1 ? '' : 's'} in progress. Complete or cancel ${n === 1 ? 'it' : 'them'} first.`);
        return App.Modal.open(`
          <div class="modal-header"><span class="modal-title">Delete your shop?</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
          <div class="modal-body">
            <form data-form="sell-delete-shop-form" novalidate>
              <p class="text-sm mb-3">${esc(SL.myShop().name)} and all its food will be removed. You can open a new shop later.</p>
              <div class="field"><label for="ds-confirm">Type DELETE to confirm</label><input class="input" id="ds-confirm" name="confirm" autocomplete="off" autocapitalize="characters" /></div>
              <div class="modal-footer" style="padding:12px 0 0;"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-danger">Delete shop</button></div>
            </form>
          </div>`);
      }
      case 'sell-tab': S.setRoute({ view: 'sell', params: { tab: ds.tab } }); return App.forceScrollTop();
      case 'sell-reload': SL.reset(); return SL.load(true);
      case 'sell-publish': {
        if (local.busy) return;
        local.busy = true; el && el.classList.add('btn-loading');
        return SL.publish().then(r => { local.busy = false; if (r.error) { el && el.classList.remove('btn-loading'); return App.Toast.error(r.error); } App.Toast.success('Your shop is live'); App.render(); });
      }
      case 'sell-resubmit':
        return SL.updateShop({ status: 'pending', rejection_reason: null }).then(r => { if (r.error) App.Toast.error(r.error); else App.Toast.success('Sent for review'); App.render(); });
      case 'sell-add-item': return itemModal(null);
      case 'sell-edit-item': { const m = SL.data.items.find(x => x.id === ds.id); if (m) itemModal(m); return; }
      case 'sell-toggle-item': {
        const m = SL.data.items.find(x => x.id === ds.id);
        if (!m) return;
        return SL.setAvailable(m.id, !m.available).then(r => { if (r.error) App.Toast.error(r.error); App.render(); });
      }
      case 'sell-delete-item': {
        const m = SL.data.items.find(x => x.id === ds.id);
        if (!m) return;
        return App.Modal.confirm({
          title: 'Remove this food?', message: m.name, variant: 'warn', confirmLabel: 'Remove', cancelLabel: 'Keep',
          onConfirm: async () => { const r = await SL.deleteItem(m.id); if (r.error) App.Toast.error(r.error); App.render(); },
        });
      }
      case 'sell-order-filter': local.orderFilter = ds.key; return App.render();
      case 'sell-order':
        if (ds.op === 'complete') return completeModal(ds.id);
        return runOrder(ds.id, ds.op, null, null, el);
      case 'sell-cancel-order': return cancelModal(ds.id);
      case 'sell-toggle-open': {
        const shop = SL.myShop();
        return SL.updateShop({ store_closed: !shop.store_closed, closure_reason: null }).then(r => { if (r.error) App.Toast.error(r.error); App.render(); });
      }
      default: return;
    }
  }

  function handleChange(kind, ds, value, el) {
    if (kind === 'sell-item-photo') return uploadItemPhoto(value, el);
    if (kind === 'sell-setup-photo') return uploadSetupPhoto(value, el, ds.key);
    if (kind === 'sell-shop-cover') return uploadShopCover(value, el);
    if (kind === 'sell-setup-hustle') { setupState().hustleup = el.value === 'yes'; return; }
    if (kind === 'sell-setup-rules') { setupState().rules = !!value; return; }
    if (kind === 'sell-setup-select') { setupState()[ds.key] = value; return; }
    if (kind === 'sell-detail-change') { setupState().details[ds.key] = value; return; }
    if (kind === 'sell-sched-toggle') {
      const row = el.closest('.sched-row');
      row.classList.toggle('sched-off', !value);
      row.querySelectorAll('input[type="time"]').forEach(i => { i.disabled = !value; });
      return;
    }
    if (kind === 'sell-detail-reg') {
      const yes = el.value === 'yes';
      if (ds.ctx === 'setup') setupState().details.is_registered = yes;
      const box = document.querySelector(`[data-reg-date="${ds.ctx}"]`); if (box) box.hidden = !yes;
      return;
    }
    if (kind === 'sell-detail-day') {
      const days = [...el.closest('.seller-days-pick').querySelectorAll('input:checked')].map(i => Number(i.value));
      setupState().details.open_days = days;
      return;
    }
    if (kind === 'sell-hustle') return SL.setHustleUp(el.value === 'yes').then(r => { if (r.error) App.Toast.error(r.error); else App.Toast.success('Saved'); });
    if (kind === 'sell-item-cat') {
      const w = document.getElementById('si-other-wrap');
      if (w) w.hidden = value !== 'Other Food';
      return;
    }
    if (kind === 'sell-cat') {
      const form = el.closest('form');
      const other = form && form.querySelector(`[data-other-for="${ds.group}"]`);
      if (other) other.hidden = !form.querySelector('input[name="cat"][value="Other Food"]:checked');
      if (ds.group === 'setup' && form) setupState().cats = checkedCats(form);
    }
  }

  function handleSubmit(formId, data, form) {
    if (formId === 'sell-setup-form') return submitSetup(data, form);
    if (formId === 'sell-item-form') return submitItem(data);
    if (formId === 'sell-shop-form') return submitShop(data, form);
    if (formId === 'sell-pickup-form') return savePickup(data, form);
    if (formId === 'sell-wa-form') return (async () => {
      if (local.busy) return;
      local.busy = true;
      const r = await SL.saveWhatsApp(data.get('whatsapp'));
      local.busy = false;
      if (r.error) return App.Toast.error(r.error);
      App.Toast.success('WhatsApp number saved');
      App.render();
    })();
    if (formId === 'sell-extra-form') return submitExtra(data, form);
    if (formId === 'sell-schedule-form') return saveScheduleForm(data, form);
    if (formId === 'sell-delete-shop-form') return deleteShop(data, form);
    if (formId === 'sell-complete-form') return runOrder(form.dataset.id, 'complete', null, null, form.querySelector('button[type="submit"]'), String(data.get('code') || '').trim());
    if (formId === 'sell-cancel-form') return runOrder(form.dataset.id, 'cancel', data.get('reason'), data.get('note'), form.querySelector('button[type="submit"]'));
  }

  function handleInput(kind, value, ds) {
    if (kind === 'sell-setup-field') setupState()[ds.key] = value;
    if (kind === 'sell-detail') setupState().details[ds.key] = value;
  }

  return { render, handleAction, handleChange, handleInput, handleSubmit };
})();
