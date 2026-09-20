/* ============================================================
   CLICKFUD — Customer dashboard: browsing delegates to
   App.Pages.Home (shared with logged-out visitors); this module
   owns food detail, checkout, confirmation, tracking, history,
   favorites, and profile — everything that needs an authenticated
   customer.
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Customer = (function () {
  const S = App.Store;
  const U = App.Utils;

  // Actions/input-kinds owned by the shared storefront module (Home) that
  // must be delegated here too, since a logged-in customer's current page
  // module is Customer, not Home, even while browsing/store-detail HTML
  // (produced by Home's renderers) is what's on screen.
  const STOREFRONT_ACTIONS = new Set([
    'open-store', 'toggle-favorite-store', 'marketplace-category', 'marketplace-toggle-open', 'shop-goto-category', 'shop-focus-search', 'store-quick-add', 'reorder-quick-add',
    'food-category', 'retry-load', 'hero-scroll', 'hero-goto', 'storefront-goto',
    'shop-open-menu', 'sheet-search-store', 'sheet-toggle-favorite', 'sheet-group-order', 'sheet-share', 'sheet-store-info',
  ]);
  const STOREFRONT_INPUTS = new Set(['marketplace-search', 'store-search']);
  const STOREFRONT_CHANGES = new Set(['marketplace-location', 'marketplace-sort']);

  const local = {
    checkout: null, promptedReviews: new Set(),
  };

  // ---------------- HOME (delegates to the shared storefront) ----------------
  // The greeting now lives in the header ("Hey, {name}"), so this is just a
  // thin wrapper around the real browsing UI — no separate/duplicate one here.
  function renderHome() {
    return `
    <div class="page-wrap">
      ${App.Pages.Home.renderBrowser()}
    </div>`;
  }

  function renderStore(params) {
    return `<div class="page-wrap">${App.Pages.Home.renderStoreDetail(params.storeId)}</div>`;
  }

  // ---------------- FOOD DETAIL MODAL ----------------
  // extras is keyed by the selected item_extras.id (uuid), never a
  // hardcoded key — see App.ItemExtras.forMenuItem(), which only ever
  // returns extras a manager explicitly assigned to THIS product
  // (public.menu_item_extras_public, schema.sql section 29).
  const detailState = { qty: 1, extras: {}, instructions: '' };

  function openFoodDetail(id) {
    const item = S.state.menu.find(m => m.id === id);
    if (!item) return;
    detailState.qty = 1; detailState.extras = {}; detailState.instructions = '';
    renderFoodDetail(item);
  }

  function renderFoodDetail(item) {
    const outOfStock = App.Menu.isOutOfStock(item);
    const isFav = S.state.favorites.includes(item.id);
    const availableExtras = App.ItemExtras.forMenuItem(item.id);
    const extrasTotal = availableExtras.filter(e => detailState.extras[e.extra_id]).reduce((s, e) => s + Number(e.price), 0);
    App.Modal.open(`
      <div style="position:relative;">
        <img class="food-detail-img" src="${U.escapeHtml(item.image || '')}" alt="${U.escapeHtml(item.name)}" style="cursor:zoom-in;" data-action="view-food-image" data-id="${item.id}" onerror="this.src='https://placehold.co/700x400?text=Campus+Eats'">
        <button class="modal-close" data-action="close-modal" style="position:absolute;top:12px;right:12px;background:rgba(255,255,255,0.9);"><i data-lucide="x"></i></button>
      </div>
      <div class="modal-body" data-item-id="${item.id}">
        <div class="flex justify-between items-start gap-2">
          <h2 class="text-xl font-bold">${U.escapeHtml(item.name)}</h2>
          <button class="menu-fav-btn ${isFav ? 'active' : ''}" style="position:static;" data-action="toggle-favorite" data-id="${item.id}"><i data-lucide="heart" style="${isFav ? 'fill:currentColor' : ''}"></i></button>
        </div>
        <div class="food-meta-row">
          <span class="badge badge-gray">${U.escapeHtml(item.category)}</span>
          <span class="badge ${outOfStock ? 'badge-error' : 'badge-success'}">${outOfStock ? 'Out of Stock' : 'Available'}</span>
          <span class="badge badge-gray"><i data-lucide="clock" style="width:11px;height:11px;"></i> ${item.preparation_time} min</span>
          <span class="badge badge-gray"><i data-lucide="star" style="width:11px;height:11px;fill:#FFC107;color:#FFC107;"></i> ${(item.rating || 0).toFixed(1)} (${item.rating_count || 0})</span>
        </div>
        <p class="text-sm text-muted mt-2">${U.escapeHtml(item.description || '')}</p>
        ${item.ingredients && item.ingredients.length ? `<div class="mt-3"><strong class="text-sm">Ingredients:</strong> <span class="text-sm text-muted">${item.ingredients.map(U.escapeHtml).join(', ')}</span></div>` : ''}
        ${item.allergens && item.allergens.length ? `<div class="mt-2"><strong class="text-sm">Allergens:</strong> <span class="text-sm text-muted">${item.allergens.map(U.escapeHtml).join(', ')}</span></div>` : ''}

        ${availableExtras.length ? `
        <div class="divider"></div>
        <strong class="text-sm">Add-ons</strong>
        <div class="mt-2" style="display:flex;flex-direction:column;gap:8px;">
          ${availableExtras.map(e => `
          <label class="checkbox-row">
            <input type="checkbox" data-action-change="toggle-extra" data-key="${e.extra_id}" ${detailState.extras[e.extra_id] ? 'checked' : ''} />
            ${U.escapeHtml(e.name)} <span class="text-muted">(+${U.money(e.price)})</span>
          </label>`).join('')}
        </div>` : ''}

        <div class="field mt-3">
          <label for="special-instructions">Special instructions</label>
          <textarea class="input" id="special-instructions" rows="2" placeholder="e.g. Please don't add onions" data-action-input="update-instructions">${U.escapeHtml(detailState.instructions)}</textarea>
        </div>

        <div class="flex justify-between items-center mt-3">
          <div class="qty-stepper">
            <button class="qty-btn" data-action="detail-qty" data-delta="-1"><i data-lucide="minus"></i></button>
            <span class="qty-val">${detailState.qty}</span>
            <button class="qty-btn" data-action="detail-qty" data-delta="1"><i data-lucide="plus"></i></button>
          </div>
          <span class="text-lg font-bold text-primary-c">${U.money((item.price + extrasTotal) * detailState.qty)}</span>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary btn-block btn-lg" data-action="add-to-cart-detail" data-id="${item.id}" ${outOfStock ? 'disabled' : ''}>
          <i data-lucide="shopping-cart"></i> ${outOfStock ? 'Out of Stock' : 'Add to Cart'}
        </button>
      </div>`, { size: 'lg' });
  }

  function refreshDetailModal() {
    const overlay = App.Modal.getRoot();
    if (!overlay) return;
    const id = overlay.querySelector('[data-item-id]')?.dataset.itemId;
    const item = S.state.menu.find(m => m.id === id);
    if (item) renderFoodDetail(item);
  }

  // Cart items grouped by store, each group's own store row attached — the
  // single source of truth checkout uses to render and to split into one
  // order per store in placeOrder().
  function cartStoreGroups() {
    return S.cartGroupsByStore().map(g => Object.assign({ store: App.Stores.getById(g.storeId) }, g));
  }

  function addToCartFromDetail(id) {
    const item = S.state.menu.find(m => m.id === id);
    if (!item) return;
    const selected = App.ItemExtras.forMenuItem(item.id).filter(e => detailState.extras[e.extra_id]);
    const store = App.Stores.getById(item.store_id);
    S.addToCartWithConfirm({
      menuItemId: item.id, name: item.name, price: item.price, image: item.image,
      qty: detailState.qty,
      addons: selected.map(e => ({ id: e.extra_id, name: e.name, price: Number(e.price) })),
      addonsTotal: selected.reduce((s, e) => s + Number(e.price), 0),
      specialInstructions: detailState.instructions,
      storeId: item.store_id, storeName: store ? store.name : '',
    }, { onAdded: () => App.Toast.success('Added to cart') });
    App.Modal.close();
  }

  function reorder(orderId) {
    const order = S.state.orders.find(o => o.id === orderId);
    if (!order) return;
    const store = App.Stores.getById(order.store_id);
    let added = 0, unavailable = [];
    (order.items || []).forEach(it => {
      const menuItem = S.state.menu.find(m => m.id === it.menuItemId);
      if (!menuItem || App.Menu.isOutOfStock(menuItem)) { unavailable.push(it.name); return; }
      S.addToCartWithConfirm({
        menuItemId: it.menuItemId, name: it.name, price: menuItem.price, image: menuItem.image,
        qty: it.qty, addons: it.addons || [], addonsTotal: 0, specialInstructions: it.specialInstructions || '',
        storeId: order.store_id, storeName: store ? store.name : '',
      });
      added++;
    });
    if (added) App.Toast.success(`${added} item(s) added to cart`);
    if (unavailable.length) App.Toast.warning(`Unavailable now: ${unavailable.join(', ')}`);
  }

  // ---------------- CHECKOUT ----------------
  // Phase 1 is collection-only — delivery (accepts_delivery, driver
  // assignment, out_for_delivery) stays intact in the schema for a later
  // phase, it's just never offered here as an active checkout path.
  function startCheckout() {
    if (!S.state.cart.length) { App.Toast.error('Your cart is empty.'); return; }
    const closedGroup = cartStoreGroups().find(g => g.store && !App.Stores.isOpenNow(g.store));
    if (closedGroup) { App.Toast.error(App.Stores.closedMessage(closedGroup.store)); return; }
    local.checkout = {
      step: 1, campus: 'Main Campus', zoneId: S.state.zones[0]?.id || '', room: '', instructions: '',
      phone: S.state.profile?.phone || '', paymentMethod: 'cod',
      fulfilment: 'collection', collectionTimes: {},
      promoCode: '', promoResult: null,
      placing: false,
    };
    S.setRoute({ view: 'checkout' });
  }

  // Earliest a store could realistically have an order ready — now plus
  // its own prep time — rounded up to the next half-hour mark, then
  // offered in 30-minute slots up to closing time, capped at 6 so the
  // picker stays a short, glanceable list instead of a long scrolling
  // row (prep time + opening hours still gate what's selectable, never
  // an arbitrary time).
  function collectionSlots(store) {
    if (!store) return [];
    const now = new Date();
    const prepMins = Number(store.prep_time_max) || 20;
    const earliest = new Date(now.getTime() + prepMins * 60000);
    earliest.setSeconds(0, 0);
    earliest.setMinutes(Math.ceil(earliest.getMinutes() / 30) * 30);

    const [ch, cm] = String(store.closing_time || '21:00').split(':').map(Number);
    const closing = new Date(now.getFullYear(), now.getMonth(), now.getDate(), ch, cm);

    const slots = [];
    let t = new Date(earliest);
    while (t < closing && slots.length < 6) {
      slots.push(new Date(t));
      t = new Date(t.getTime() + 30 * 60000);
    }
    return slots;
  }

  function cartTotals() {
    const c = local.checkout;
    const subtotal = S.state.cart.reduce((s, i) => s + (i.price + (i.addonsTotal || 0)) * i.qty, 0);
    const deliveryFee = 0;
    const discount = c.promoResult ? c.promoResult.discount : 0;
    const total = Math.max(0, subtotal + deliveryFee - discount);
    return { subtotal, deliveryFee, discount, total };
  }

  function stepIndicator() {
    const steps = ['Summary', local.checkout.fulfilment === 'delivery' ? 'Delivery' : 'Collection', 'Payment', 'Confirm'];
    return `<div class="step-indicator">
      ${steps.map((label, i) => {
        const n = i + 1; const state = n < local.checkout.step ? 'done' : n === local.checkout.step ? 'active' : '';
        return `<div class="step ${state}"><div class="circle">${n < local.checkout.step ? '<i data-lucide=\"check\" style=\"width:14px;height:14px\"></i>' : n}</div><span class="step-label">${label}</span></div>${i < steps.length - 1 ? `<div class="step-line ${n < local.checkout.step ? 'done' : ''}"></div>` : ''}`;
      }).join('')}
    </div>`;
  }

  function storeGroupLabel(g) { return U.escapeHtml(g.store ? g.store.name : (g.storeName || 'Store')); }

  function summaryCard() {
    const t = cartTotals();
    const groups = cartStoreGroups();
    return `<div class="card card-pad summary-card">
      <h3 class="font-bold mb-1">${groups.length > 1 ? `Order Summary (${groups.length} shops)` : (groups[0] ? storeGroupLabel(groups[0]) : 'Order Summary')}</h3>
      <div class="divider" style="margin:8px 0;"></div>
      ${groups.map(g => `
        ${groups.length > 1 ? `<div class="text-xs font-bold text-muted mb-1" style="text-transform:uppercase;letter-spacing:.03em;">${storeGroupLabel(g)}</div>` : ''}
        ${g.items.map(i => `<div class="cart-summary-row"><span>${i.qty}x ${U.escapeHtml(i.name)}</span><span>${U.money((i.price + (i.addonsTotal || 0)) * i.qty)}</span></div>`).join('')}
      `).join('')}
      <div class="cart-summary-row"><span>Subtotal</span><span>${U.money(t.subtotal)}</span></div>
      <div class="cart-summary-row"><span>${local.checkout.fulfilment === 'delivery' ? 'Delivery Fee' : 'Collection'}</span><span>${t.deliveryFee ? U.money(t.deliveryFee) : 'Free'}</span></div>
      ${t.discount ? `<div class="cart-summary-row" style="color:var(--color-success)"><span>Discount</span><span>-${U.money(t.discount)}</span></div>` : ''}
      <div class="cart-summary-row total"><span>Total</span><span>${U.money(t.total)}</span></div>
    </div>`;
  }

  function renderCheckoutStep1() {
    const c = local.checkout;
    const groups = cartStoreGroups();
    return `
    <div class="card card-pad">
      <h3 class="font-bold mb-3">Review Your Order</h3>
      ${groups.map((g, gi) => `
        ${groups.length > 1 ? `<div class="text-xs font-bold text-muted mb-1" style="text-transform:uppercase;letter-spacing:.03em;">${storeGroupLabel(g)}</div>` : ''}
        ${g.items.map(i => `<div class="cart-summary-row"><span>${i.qty}x ${U.escapeHtml(i.name)}${i.addons && i.addons.length ? ' (' + i.addons.map(a => U.escapeHtml(typeof a === 'string' ? a : a.name)).join(', ') + ')' : ''}</span><span>${U.money((i.price + (i.addonsTotal || 0)) * i.qty)}</span></div>`).join('')}
        ${renderCheckoutAddonSuggestions(g.storeId)}
        ${gi < groups.length - 1 ? '<div class="divider"></div>' : ''}
      `).join('')}
      <div class="divider"></div>
      <div class="field">
        <label>Promo Code</label>
        <div class="flex gap-2">
          <input class="input" id="promo-input" placeholder="e.g. CAMPUS10" value="${U.escapeHtml(c.promoCode)}" />
          <button type="button" class="btn btn-secondary" data-action="apply-promo">Apply</button>
        </div>
        ${c.promoResult ? `<div class="text-sm text-success mt-1"><i data-lucide="check-circle-2" style="width:14px;height:14px"></i> Promo applied successfully!</div>` : ''}
      </div>
    </div>`;
  }

  // Shop-specific drinks/snacks/sides upsell, sourced entirely from
  // App.Addons (real per-store data, never hard-coded). Renders nothing at
  // all if the current shop has no available add-ons — no empty section,
  // no placeholder categories.
  function renderCheckoutAddonSuggestions(storeId) {
    if (!storeId) return '';
    const groups = App.Addons.groupedForStore(storeId);
    if (!groups.length) return '';
    return `
    <div class="divider"></div>
    <h4 class="font-bold mb-2">Would you like to add something?</h4>
    ${groups.map(g => `
      <div class="mb-2">
        <div class="text-xs font-bold text-muted mb-1" style="text-transform:uppercase;letter-spacing:.03em;">${U.escapeHtml(g.category)}</div>
        ${g.items.map(a => {
          const inCart = S.state.cart.find(ci => ci.menuItemId === a.id && ci.isAddon);
          return `<div class="cart-summary-row" style="align-items:center;">
            <span>${U.escapeHtml(a.name)} <span class="text-muted">(${U.money(a.price)})</span></span>
            ${inCart
              ? `<div class="qty-control">
                  <button type="button" class="qty-btn" data-action="addon-qty" data-id="${a.id}" data-delta="-1"><i data-lucide="minus" style="width:14px;height:14px"></i></button>
                  <span class="qty-val">${inCart.qty}</span>
                  <button type="button" class="qty-btn" data-action="addon-qty" data-id="${a.id}" data-delta="1"><i data-lucide="plus" style="width:14px;height:14px"></i></button>
                </div>`
              : `<button type="button" class="btn btn-secondary btn-sm" data-action="add-addon-to-cart" data-id="${a.id}">Add</button>`}
          </div>`;
        }).join('')}
      </div>`).join('')}`;
  }

  function addAddonToCart(id) {
    const addon = S.state.addons.find(a => a.id === id);
    if (!addon || !addon.is_available) { App.Toast.error('This item is no longer available.'); return; }
    const store = App.Stores.getById(addon.store_id);
    S.addToCart({
      menuItemId: addon.id, name: addon.name, price: Number(addon.price), image: addon.image_url,
      qty: 1, storeId: addon.store_id, storeName: store ? store.name : '',
      addons: [], addonsTotal: 0, specialInstructions: '', isAddon: true,
    });
    App.render();
  }

  function changeAddonQty(id, delta) {
    const index = S.state.cart.findIndex(ci => ci.menuItemId === id && ci.isAddon);
    if (index === -1) return;
    S.updateCartQty(index, S.state.cart[index].qty + Number(delta));
    App.render();
  }

  function renderCheckoutStep2() {
    const c = local.checkout;
    // Phase 1: always the collection branch (fulfilment never becomes
    // 'delivery' — see startCheckout()). The delivery block below is kept,
    // not deleted, so re-enabling it later is just restoring the toggle.
    if (c.fulfilment === 'delivery') {
      return `
      <div class="card card-pad">
        <h3 class="font-bold mb-3">Delivery Details</h3>
        <div class="field"><label>Campus</label><input class="input" id="ck-campus" value="${U.escapeHtml(c.campus)}" /></div>
        <label class="text-sm font-semibold" style="display:block;margin-bottom:6px;">Residence / Building</label>
        ${S.state.zones.map(z => `
          <div class="zone-option ${c.zoneId === z.id ? 'selected' : ''}" data-action="select-zone" data-id="${z.id}">
            <span>${U.escapeHtml(z.name)}</span>
          </div>`).join('')}
        <div class="field mt-2"><label>Room Number</label><input class="input" id="ck-room" value="${U.escapeHtml(c.room)}" placeholder="e.g. B204" /></div>
        <div class="field"><label>Delivery Instructions (optional)</label><textarea class="input" id="ck-instructions" rows="2">${U.escapeHtml(c.instructions)}</textarea></div>
        <div class="field"><label>Phone Number</label><input class="input" id="ck-phone" type="tel" value="${U.escapeHtml(c.phone)}" placeholder="071 234 5678" /></div>
      </div>`;
    }
    const groups = cartStoreGroups();
    return `
    <div class="card card-pad">
      <h3 class="font-bold mb-3">Collection Details</h3>
      ${groups.map((g, gi) => {
        const store = g.store;
        const slots = collectionSlots(store);
        const chosen = c.collectionTimes[g.storeId] || '';
        return `
        ${groups.length > 1 ? `<div class="font-semibold text-sm mb-1">${storeGroupLabel(g)}</div>` : ''}
        <p class="text-sm text-muted mb-3">Collect your order directly from ${U.escapeHtml(store ? store.name : 'the store')} (${U.escapeHtml(store ? store.campus_location : '')}).</p>
        <label class="text-sm font-semibold" style="display:block;margin-bottom:6px;">Collection Time *</label>
        ${slots.length ? `
        <div class="collection-time-grid mb-3">
          ${slots.map(t => `<button type="button" class="chip collection-time-chip ${chosen === t.toISOString() ? 'active' : ''}" data-action="select-collection-time" data-store-id="${U.escapeHtml(g.storeId)}" data-time="${t.toISOString()}" aria-pressed="${chosen === t.toISOString() ? 'true' : 'false'}" aria-label="Collection time ${U.formatTime(t.toISOString())}">${U.formatTime(t.toISOString())}</button>`).join('')}
        </div>` : `<p class="text-sm mb-3" style="color:var(--color-error);">No collection slots available before closing time today for ${U.escapeHtml(store ? store.name : 'this store')}. Please try again tomorrow.</p>`}
        ${gi < groups.length - 1 ? '<div class="divider"></div>' : ''}`;
      }).join('')}
      <div class="field"><label>Phone Number</label><input class="input" id="ck-phone" type="tel" value="${U.escapeHtml(c.phone)}" placeholder="071 234 5678" /></div>
    </div>`;
  }

  function renderCheckoutStep3() {
    const c = local.checkout;
    return `
    <div class="card card-pad">
      <h3 class="font-bold mb-3">Payment Method</h3>
      <div class="payment-option ${c.paymentMethod === 'cod' ? 'selected' : ''}" data-action="select-payment" data-method="cod">
        <i data-lucide="banknote"></i><div><strong>Cash ${c.fulfilment === 'delivery' ? 'on Delivery' : 'on Collection'}</strong><div class="text-xs text-muted">Pay when you ${c.fulfilment === 'delivery' ? 'receive your order' : 'collect your order'}</div></div>
      </div>
      <div class="payment-option ${c.paymentMethod === 'card' ? 'selected' : ''}" data-action="select-payment" data-method="card">
        <i data-lucide="credit-card"></i><div><strong>Pay Online</strong><div class="text-xs text-muted">Card, via Paystack</div></div>
      </div>
      ${c.paymentMethod === 'card' ? `
      <div class="mt-3 text-sm text-muted" style="display:flex;gap:8px;align-items:flex-start;">
        <i data-lucide="lock" style="width:15px;height:15px;flex-shrink:0;margin-top:2px;color:var(--color-primary);"></i>
        <span>You'll be securely redirected to Paystack to complete your payment, then brought straight back here.</span>
      </div>` : ''}
    </div>`;
  }

  function renderCheckoutStep4() {
    const c = local.checkout;
    const t = cartTotals();
    const groups = cartStoreGroups();
    return `
    <div class="card card-pad">
      <h3 class="font-bold mb-3">Confirm Your Order</h3>
      ${c.fulfilment === 'delivery'
        ? `<div class="text-sm mb-2"><strong>Deliver to:</strong> ${U.escapeHtml(c.campus)}, Room ${U.escapeHtml(c.room)}</div>`
        : groups.map(g => `<div class="text-sm mb-2"><strong>Collect from ${storeGroupLabel(g)}:</strong> ${c.collectionTimes[g.storeId] ? U.formatTime(c.collectionTimes[g.storeId]) : '—'}</div>`).join('')}
      <div class="text-sm mb-2"><strong>Phone:</strong> ${U.escapeHtml(c.phone)}</div>
      <div class="text-sm mb-2"><strong>Payment:</strong> ${c.paymentMethod === 'cod' ? 'Cash' : 'Card'}</div>
      <div class="text-sm mb-3"><strong>Total:</strong> <span class="text-primary-c font-bold">${U.money(t.total)}</span></div>
      <button class="btn btn-primary btn-block btn-lg ${c.placing ? 'btn-loading' : ''}" data-action="place-order">Place Order</button>
    </div>`;
  }

  function renderCheckout() {
    if (!local.checkout) { S.setRoute({ view: 'home' }); return renderHome(); }
    const c = local.checkout;
    const stepRenderers = [renderCheckoutStep1, renderCheckoutStep2, renderCheckoutStep3, renderCheckoutStep4];
    return `
    <div class="page-wrap" style="max-width:900px;">
      <h1 class="page-title mb-3">Checkout</h1>
      ${stepIndicator()}
      <div class="checkout-grid">
        <div>${stepRenderers[c.step - 1]()}
          <div class="flex justify-between mt-3">
            ${c.step > 1 ? `<button class="btn btn-secondary" data-action="checkout-back"><i data-lucide="arrow-left"></i>Back</button>` : `<button class="btn btn-secondary" data-action="navigate" data-view="home"><i data-lucide="arrow-left"></i>Cancel</button>`}
            ${c.step < 4 ? `<button class="btn btn-primary" data-action="checkout-next">Continue<i data-lucide="arrow-right"></i></button>` : ''}
          </div>
        </div>
        ${summaryCard()}
      </div>
    </div>`;
  }

  function validateStep(step) {
    const c = local.checkout;
    if (step === 2) {
      if (c.fulfilment === 'delivery') {
        if (!c.campus.trim()) return 'Please enter your campus.';
        if (!c.zoneId) return 'Please select a residence/building.';
        if (!c.room.trim()) return 'Please enter your room number.';
      }
      if (c.fulfilment === 'collection') {
        const missing = cartStoreGroups().find(g => !c.collectionTimes[g.storeId]);
        if (missing) return `Please choose a collection time for ${storeGroupLabel(missing)}.`;
      }
      if (!U.isValidPhone(c.phone)) return 'Please enter a valid phone number.';
    }
    return null;
  }

  function checkoutNext() {
    const c = local.checkout;
    syncCheckoutFields();
    const err = validateStep(c.step);
    if (err) { App.Toast.error(err); return; }
    c.step = Math.min(4, c.step + 1);
    App.render();
  }
  function checkoutBack() { local.checkout.step = Math.max(1, local.checkout.step - 1); App.render(); }

  function syncCheckoutFields() {
    const c = local.checkout;
    const $ = (id) => document.getElementById(id);
    if ($('ck-campus')) c.campus = $('ck-campus').value;
    if ($('ck-room')) c.room = $('ck-room').value;
    if ($('ck-instructions')) c.instructions = $('ck-instructions').value;
    if ($('ck-phone')) c.phone = $('ck-phone').value;
  }

  function selectZone(id) { local.checkout.zoneId = id; App.render(); }
  function selectPayment(method) { syncCheckoutFields(); local.checkout.paymentMethod = method; App.render(); }
  function selectFulfilment(mode) { syncCheckoutFields(); local.checkout.fulfilment = mode; App.render(); }
  function selectCollectionTime(storeId, iso) { local.checkout.collectionTimes[storeId] = iso; App.render(); }

  function applyPromo() {
    const input = document.getElementById('promo-input');
    const code = input ? input.value : '';
    const t = cartTotals();
    const result = App.Promotions.validateCode(code, t.subtotal);
    if (result.error) { App.Toast.error(result.error); return; }
    local.checkout.promoCode = code.toUpperCase();
    local.checkout.promoResult = result;
    App.Toast.success('Promo applied successfully!');
    App.render();
  }

  // Splits the (possibly multi-store) cart into one createOrder() call per
  // store — each order row still holds only that store's items, exactly as
  // App.Orders.createOrder and the "orders select"/"orders staff update" RLS
  // policies (store_id = current_store_id()) already require. A combined
  // promo discount is re-validated once here (against the real, live promo
  // row and the fresh combined subtotal — not just trusted from apply-time)
  // then allocated proportionally by each store's share of the subtotal, so
  // splitting across shops can't change what the customer is actually
  // charged in total, and the promo's usage count is only ever incremented
  // once per checkout no matter how many stores it spanned.
  function groupDeliveryLocation(c, g) {
    return c.fulfilment === 'delivery'
      ? { campus: c.campus, building: '', zoneId: c.zoneId, room: c.room, instructions: c.instructions, phone: c.phone, fulfilment: 'delivery' }
      : { building: g.store ? g.store.name : (g.storeName || ''), room: '', instructions: '', phone: c.phone, fulfilment: 'collection', collectionTime: c.collectionTimes[g.storeId] };
  }

  function placeOrder() {
    return local.checkout.paymentMethod === 'card' ? placeOrderOnline() : placeOrderCod();
  }

  // Real Paystack TEST-mode checkout: no order exists yet — the browser
  // only ever sends WHICH items were selected, never a price (see
  // paystack-initialize). It re-prices everything server-side, opens a
  // real Paystack-hosted payment page, and the actual order rows are
  // only ever created after paystack-verify independently confirms the
  // payment with Paystack using the secret key (see js/app.js's
  // handlePaystackReturn, which runs when the browser comes back).
  async function placeOrderOnline() {
    const c = local.checkout;
    c.placing = true; App.render();
    const groups = cartStoreGroups();
    const payloadGroups = groups.map(g => ({
      storeId: g.storeId,
      items: g.items.map(it => ({
        menuItemId: it.menuItemId, qty: it.qty, isAddon: !!it.isAddon,
        addons: it.addons || [], specialInstructions: it.specialInstructions || '',
      })),
      deliveryLocation: groupDeliveryLocation(c, g),
    }));
    const res = await App.Payments.startPaystackCheckout(payloadGroups, c.promoResult ? c.promoCode : null);
    if (res.error) {
      c.placing = false;
      App.Toast.error(res.error);
      App.render();
    }
    // On success, startPaystackCheckout() has already navigated the
    // browser away to Paystack — nothing left to do here.
  }

  async function placeOrderCod() {
    const c = local.checkout;
    c.placing = true; App.render();

    const groups = cartStoreGroups();
    const subtotal = S.state.cart.reduce((s, i) => s + (i.price + (i.addonsTotal || 0)) * i.qty, 0);

    let discount = 0, appliedPromo = null;
    if (c.promoResult) {
      const result = App.Promotions.validateCode(c.promoCode, subtotal);
      if (result.error) {
        c.placing = false; c.promoResult = null; c.promoCode = '';
        App.Toast.error(result.error);
        App.render();
        return;
      }
      discount = result.discount;
      appliedPromo = result.promo;
    }

    const results = [];
    let discountLeft = discount;
    let subtotalLeft = subtotal;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const groupSubtotal = g.items.reduce((s, it) => s + (it.price + (it.addonsTotal || 0)) * it.qty, 0);
      const isLast = i === groups.length - 1;
      const groupDiscount = isLast ? discountLeft : (subtotalLeft > 0 ? App.Orders.round2(discount * (groupSubtotal / subtotal)) : 0);
      if (!isLast) discountLeft = App.Orders.round2(discountLeft - groupDiscount);
      subtotalLeft -= groupSubtotal;

      const items = g.items.map(it => ({ menuItemId: it.menuItemId, name: it.name, price: it.price, qty: it.qty, image: it.image, addons: it.addons, addonsTotal: it.addonsTotal, specialInstructions: it.specialInstructions, isAddon: !!it.isAddon }));
      const res = await App.Orders.createOrder({
        items,
        storeId: g.storeId,
        deliveryLocation: groupDeliveryLocation(c, g),
        paymentMethod: c.paymentMethod,
        discountOverride: groupDiscount,
        promoCode: appliedPromo ? appliedPromo.code : null,
        deliveryFee: 0,
      });
      results.push(res.error
        ? { storeName: storeGroupLabel(g), error: res.error }
        : { storeName: storeGroupLabel(g), order: res.data });
    }

    c.placing = false;
    const succeeded = results.filter(r => r.order);
    const failed = results.filter(r => r.error);

    if (!succeeded.length) {
      App.Toast.error(failed[0] ? failed[0].error : 'Unable to place order.');
      App.render();
      return;
    }
    // Increment usage exactly once for the whole checkout, regardless of how
    // many stores it was split across.
    if (appliedPromo) await App.Promotions.incrementUsage(appliedPromo.id);
    if (failed.length) {
      App.Toast.warning(`Couldn't order from ${failed.map(f => f.storeName).join(', ')}: ${failed[0].error}. Those items are still in your cart.`);
    }
    local.checkout = null;
    App.Toast.success(succeeded.length > 1 ? `${succeeded.length} orders placed successfully` : 'Order placed successfully');
    if (succeeded.length === 1) {
      S.setRoute({ view: 'confirmation', params: { orderId: succeeded[0].order.id } });
    } else {
      S.setRoute({ view: 'confirmation-multi', params: { orderIds: succeeded.map(s => s.order.id) } });
    }
  }

  // ---------------- CONFIRMATION ----------------
  function renderConfirmation(params) {
    const order = S.state.orders.find(o => o.id === params.orderId);
    if (!order) return renderHome();
    const prepTime = Math.max(...(order.items || []).map(it => {
      const m = S.state.menu.find(mi => mi.id === it.menuItemId); return m ? m.preparation_time : 15;
    }), 10);
    return `
    <div class="page-wrap" style="max-width:640px;">
      <div class="card confirm-hero">
        <div class="big-check"><i data-lucide="check-circle-2"></i></div>
        <h1 class="page-title">Order Confirmed! 🎉</h1>
        <p class="text-muted mt-2">Your order <strong>${U.escapeHtml(order.order_number)}</strong> has been sent to the kitchen.</p>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px;text-align:left;margin-top:20px;">
          <div class="card card-pad"><div class="text-xs text-muted">Estimated Prep Time</div><div class="font-bold">${prepTime} min</div></div>
          <div class="card card-pad"><div class="text-xs text-muted">Payment Method</div><div class="font-bold">${order.payment_method === 'cod' ? 'Cash' : 'Card'}</div></div>
          <div class="card card-pad"><div class="text-xs text-muted">Total</div><div class="font-bold">${U.money(order.total)}</div></div>
          <div class="card card-pad"><div class="text-xs text-muted">${order.delivery_location.fulfilment === 'collection' ? 'Collection From' : 'Delivery Location'}</div><div class="font-bold">${U.escapeHtml(order.delivery_location.building)}${order.delivery_location.room ? ', Rm ' + U.escapeHtml(order.delivery_location.room) : ''}</div></div>
        </div>
        <button class="btn btn-primary btn-block btn-lg mt-4" data-action="track-order" data-id="${order.id}"><i data-lucide="map-pin"></i>Track My Order</button>
        <button class="btn btn-secondary btn-block mt-2" data-action="go-home">Back to Stores</button>
      </div>
    </div>`;
  }

  // A checkout spanning several stores produces several order rows (one
  // per store, same as any other order — see placeOrder()); this just
  // gives the customer one combined receipt-style view listing all of them
  // instead of only being able to see the first.
  function renderConfirmationMulti(params) {
    const orders = (params.orderIds || []).map(id => S.state.orders.find(o => o.id === id)).filter(Boolean);
    if (!orders.length) return renderHome();
    const total = orders.reduce((s, o) => s + Number(o.total), 0);
    return `
    <div class="page-wrap" style="max-width:640px;">
      <div class="card confirm-hero">
        <div class="big-check"><i data-lucide="check-circle-2"></i></div>
        <h1 class="page-title">Orders Confirmed! 🎉</h1>
        <p class="text-muted mt-2">Your order was split across ${orders.length} shops and sent to each kitchen.</p>
      </div>
      <div class="grid" style="grid-template-columns:1fr;gap:12px;margin-top:16px;">
        ${orders.map(o => {
          const store = App.Stores.getById(o.store_id);
          return `
          <div class="card card-pad">
            <div class="flex justify-between items-start">
              <div>
                <div class="font-bold">${store ? U.escapeHtml(store.name) : ''}</div>
                <div class="text-xs text-muted">${U.escapeHtml(o.order_number)}</div>
              </div>
              <span class="font-bold">${U.money(o.total)}</span>
            </div>
            <button class="btn btn-secondary btn-sm mt-2" data-action="track-order" data-id="${o.id}"><i data-lucide="map-pin"></i>Track</button>
          </div>`;
        }).join('')}
      </div>
      <div class="card card-pad mt-3 flex justify-between items-center"><strong>Total</strong><strong>${U.money(total)}</strong></div>
      <button class="btn btn-secondary btn-block mt-3" data-action="go-home">Back to Stores</button>
    </div>`;
  }

  // ---------------- TRACKING ----------------
  // Renders a real QR (encoding the DB-generated collection_token) plus
  // the same value's short, typeable form (collection_code) — either one
  // resolves the order in confirm_collection() server-side. Both are only
  // ever set by the DB trigger once an order becomes ready; nothing here
  // invents or guesses a code client-side.
  function collectionQR(order) {
    if (!order.collection_token || typeof qrcode !== 'function') return '';
    const qr = qrcode(0, 'M');
    qr.addData(String(order.collection_token));
    qr.make();
    return qr.createSvgTag(5, 4);
  }

  function renderCollectionCard(order) {
    const isCollection = order.delivery_location && order.delivery_location.fulfilment === 'collection';
    if (!isCollection) return '';
    if (order.status === 'collected') {
      return `<div class="card card-pad mt-3" style="text-align:center;">
        <div class="icon-wrap" style="background:rgba(34,197,94,0.14);color:var(--color-success);margin:0 auto 10px;"><i data-lucide="check-circle-2"></i></div>
        <h3 class="font-bold">Collected</h3><p class="text-sm text-muted">Enjoy your meal!</p>
      </div>`;
    }
    if (order.status !== 'ready' || !order.collection_token) return '';
    return `<div class="card card-pad mt-3" style="text-align:center;">
      <h3 class="font-bold mb-1">Ready for Collection 🎉</h3>
      <p class="text-sm text-muted mb-3">Show this QR code (or the code below) to staff to collect your order.</p>
      <div style="display:flex;justify-content:center;margin-bottom:10px;">${collectionQR(order)}</div>
      <div class="font-bold" style="font-size:24px;letter-spacing:4px;">${U.escapeHtml(order.collection_code || '')}</div>
    </div>`;
  }

  function renderTracking(params) {
    const order = S.state.orders.find(o => o.id === params.orderId);
    if (!order) return `<div class="page-wrap"><div class="empty-state"><h3>Order not found</h3></div></div>`;
    const store = App.Stores.getById(order.store_id);
    return `
    <div class="page-wrap" style="max-width:640px;">
      <div class="flex justify-between items-center mb-3">
        <h1 class="page-title">Track Order</h1>
        <span class="badge badge-primary">${U.escapeHtml(order.order_number)}</span>
      </div>
      ${store ? `<p class="text-sm text-muted mb-2">${U.escapeHtml(store.name)}</p>` : ''}
      <div class="card card-pad">${App.Shared.renderTracker(order)}</div>
      ${renderCollectionCard(order)}
      <div class="flex gap-2 mt-3">
        <button class="btn btn-secondary" data-action="view-receipt" data-id="${order.id}"><i data-lucide="receipt"></i>Receipt</button>
        ${App.Orders.canCancel(order) ? `<button class="btn btn-danger" data-action="cancel-order" data-id="${order.id}"><i data-lucide="ban"></i>Cancel Order</button>` : ''}
        <button class="btn btn-ghost" data-action="go-home">Back to Stores</button>
      </div>
    </div>`;
  }

  // A paid "card" order shows the customer exactly what they'll get back
  // before they confirm — the actual fee/refund is always recomputed
  // authoritatively server-side (paystack-cancel-order), this is purely
  // an accurate preview using the same real platform_config percentage.
  async function cancelOrderConfirm(id) {
    const order = S.state.orders.find(o => o.id === id);
    if (!order) return;
    const isPaidCard = order.payment_method === 'card' && order.payment_status === 'paid';
    let message = `Order ${order.order_number} will be cancelled and cannot be undone.`;
    if (isPaidCard) {
      const { data: config } = await App.sb.from('platform_config').select('cancellation_fee_percent').eq('id', 1).single();
      const feePct = Number(config?.cancellation_fee_percent ?? 20);
      const feeAmount = App.Orders.round2(Number(order.total) * (feePct / 100));
      const refundAmount = App.Orders.round2(Math.max(0, Number(order.total) - feeAmount));
      message = `You paid ${U.money(order.total)} for this order. A ${feePct}% cancellation fee (${U.money(feeAmount)}) applies — ${U.money(refundAmount)} will be refunded to your original payment method. This cannot be undone.`;
    }
    App.Modal.confirm({
      title: 'Cancel this order?', message,
      variant: 'danger', confirmLabel: 'Cancel Order', cancelLabel: 'Keep Order',
      onConfirm: async () => {
        const res = await App.Orders.cancelOrder(order);
        if (res.error) { App.Toast.error(res.error); return; }
        App.Toast.success(res.refundAmount > 0 ? `Order cancelled — ${U.money(res.refundAmount)} refunded` : 'Order cancelled');
      },
    });
  }

  // Collection orders (Phase 1's active path) terminate at 'collected';
  // delivery orders (dormant, historical only) terminate at 'delivered' —
  // both count as a completed, rateable order everywhere that matters.
  function isCompleted(o) { return o.status === 'delivered' || o.status === 'collected'; }

  // ---------------- ORDER HISTORY ----------------
  function renderHistory() {
    const orders = S.state.orders.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (!orders.length) {
      return `<div class="page-wrap"><h1 class="page-title mb-4">My Orders</h1><div class="empty-state"><div class="icon-wrap"><i data-lucide="receipt"></i></div><h3>You haven't placed any orders yet</h3><p>Your order history will show up here.</p></div></div>`;
    }
    return `
    <div class="page-wrap">
      <h1 class="page-title mb-4">My Orders</h1>
      <div class="grid" style="grid-template-columns:1fr;gap:12px;max-width:720px;">
        ${orders.map(o => {
          const review = App.Reviews.getForOrder(o.id);
          const store = App.Stores.getById(o.store_id);
          return `
          <div class="card history-card">
            <div class="flex justify-between items-start">
              <div>
                <div class="font-bold">${U.escapeHtml(o.order_number)}${store ? ` · ${U.escapeHtml(store.name)}` : ''}</div>
                <div class="text-xs text-muted">${U.formatDateTime(o.created_at)}</div>
              </div>
              <span class="badge ${isCompleted(o) ? 'badge-success' : o.status === 'cancelled' ? 'badge-error' : 'badge-primary'}">${App.CONST.STATUS_LABELS[o.status]}</span>
            </div>
            <div class="text-sm text-muted mt-2">${(o.items || []).map(it => `${it.qty}x ${U.escapeHtml(it.name)}`).join(', ')}</div>
            <div class="flex justify-between items-center mt-2">
              <span class="font-bold">${U.money(o.total)}</span>
              <span class="text-xs text-muted">${o.payment_method === 'cod' ? 'Cash' : 'Card'}</span>
            </div>
            ${review ? `<div class="text-xs text-success mt-1">${U.starIcons(review.overall_rating, 12)} Rated</div>` : ''}
            <div class="flex gap-2 mt-3" style="flex-wrap:wrap;">
              ${['received', 'preparing', 'ready', 'out_for_delivery'].includes(o.status) ? `<button class="btn btn-secondary btn-sm" data-action="track-order" data-id="${o.id}"><i data-lucide="map-pin"></i>Track</button>` : ''}
              <button class="btn btn-secondary btn-sm" data-action="view-receipt" data-id="${o.id}"><i data-lucide="receipt"></i>Receipt</button>
              <button class="btn btn-secondary btn-sm" data-action="reorder" data-id="${o.id}"><i data-lucide="repeat-2"></i>Reorder</button>
              ${isCompleted(o) && !review ? `<button class="btn btn-primary btn-sm" data-action="rate-order" data-id="${o.id}"><i data-lucide="star"></i>Rate Order</button>` : ''}
              ${isCompleted(o) && review ? `<button class="btn btn-secondary btn-sm" data-action="rate-order" data-id="${o.id}"><i data-lucide="pencil"></i>Edit Rating</button>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  function checkForReviewPrompt() {
    if (!S.state.profile || S.state.profile.role !== 'customer') return;
    if (App.Modal.isOpen()) return;
    const toReview = S.state.orders.find(o => isCompleted(o) && !App.Reviews.hasReviewed(o.id) && !local.promptedReviews.has(o.id));
    if (toReview) { local.promptedReviews.add(toReview.id); App.Shared.openReviewModal(toReview); }
  }

  // ---------------- FAVORITES ----------------
  function favMenuCard(item) {
    const outOfStock = App.Menu.isOutOfStock(item);
    const store = App.Stores.getById(item.store_id);
    return `
    <div class="card card-hover menu-card" data-action="open-food" data-id="${item.id}">
      <div class="menu-card-img">
        <img src="${U.escapeHtml(item.image || '')}" alt="${U.escapeHtml(item.name)}" loading="lazy" onerror="this.src='https://placehold.co/400x300?text=Campus+Eats'">
        <button class="menu-fav-btn active" data-action="toggle-favorite" data-id="${item.id}" aria-label="Unfavorite"><i data-lucide="heart" style="fill:currentColor"></i></button>
        ${outOfStock ? `<div class="out-of-stock-overlay">Out of Stock</div>` : ''}
      </div>
      <div class="menu-card-body">
        <div class="menu-card-title-row"><span class="font-bold">${U.escapeHtml(item.name)}</span></div>
        <p class="menu-card-desc">${store ? U.escapeHtml(store.name) : ''}</p>
        <div class="menu-card-footer">
          <span class="price-tag">${U.money(item.price)}</span>
          <button class="btn btn-primary btn-sm" data-action="fav-quick-add" data-id="${item.id}" ${outOfStock ? 'disabled' : ''}>${outOfStock ? 'Unavailable' : '<i data-lucide="plus"></i>Add'}</button>
        </div>
      </div>
    </div>`;
  }

  function renderFavorites() {
    // Same reasoning as js/pages/home.js visibleMenu() — a favorited item
    // that's since gone back to pending/rejected/suspended shouldn't show
    // up as orderable (RLS already means it wouldn't even be present in
    // S.state.menu for a customer session, this is belt-and-braces).
    const items = S.state.menu.filter(m => S.state.favorites.includes(m.id) && m.status === 'approved');
    return `
    <div class="page-wrap">
      <h1 class="page-title mb-4">My Favorites</h1>
      ${items.length ? `<div class="grid grid-menu">${items.map(favMenuCard).join('')}</div>` : `<div class="empty-state"><div class="icon-wrap"><i data-lucide="heart"></i></div><h3>No favorites yet</h3><p>Your favorite meals will appear here.</p></div>`}
    </div>`;
  }

  // ---------------- PROFILE ----------------
  function renderProfile() {
    const p = S.state.profile;
    const loc = p.default_location || {};
    return `
    <div class="page-wrap" style="max-width:560px;">
      <h1 class="page-title mb-4">My Profile</h1>
      <div class="card card-pad">
        <div class="profile-header">
          <div class="profile-avatar-lg">${p.avatar_url ? `<img src="${U.escapeHtml(p.avatar_url)}">` : U.escapeHtml(U.initials(p.name))}</div>
          <div><div class="font-bold text-lg">${U.escapeHtml(p.name)}</div><div class="text-muted text-sm">${U.escapeHtml(p.email)}</div></div>
        </div>
        <form data-form="profile-form">
          <div class="field">
            <label>Profile Picture</label>
            <div class="image-upload" data-image-upload="avatar_url">
              <div class="image-upload-preview" ${p.avatar_url ? '' : 'style="display:none;"'}>
                ${p.avatar_url ? `<img src="${U.escapeHtml(p.avatar_url)}" alt="" />` : ''}
              </div>
              <div class="image-upload-progress" style="display:none;"><div class="image-upload-progress-bar"></div></div>
              <label class="btn btn-secondary btn-sm image-upload-btn">
                <i data-lucide="upload"></i> <span class="image-upload-label">${p.avatar_url ? 'Change Photo' : 'Upload Photo'}</span>
                <input type="file" accept="image/jpeg,image/png,image/webp" hidden data-action-change="upload-avatar" />
              </label>
              <span class="image-upload-status text-xs text-muted"></span>
              <input type="hidden" name="avatar_url" value="${U.escapeHtml(p.avatar_url || '')}" />
            </div>
          </div>
          <div class="field"><label>Full Name</label><input class="input" name="name" value="${U.escapeHtml(p.name)}" /></div>
          <div class="field"><label>Phone</label><input class="input" name="phone" value="${U.escapeHtml(p.phone || '')}" /></div>
          <div class="field">
            <label>University / College</label>
            <select class="select" name="university">
              <option value="">Select a university</option>
              ${App.CONST.UNIVERSITIES.map(u => `<option value="${U.escapeHtml(u)}" ${p.university === u ? 'selected' : ''}>${U.escapeHtml(u)}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Residence Name</label><input class="input" name="residence" value="${U.escapeHtml(loc.residence || '')}" placeholder="e.g. Residence A" /></div>
          <div class="field"><label>Street</label><input class="input" name="street" value="${U.escapeHtml(loc.street || '')}" placeholder="e.g. Kirkness Street" /></div>
          <button type="submit" class="btn btn-primary btn-block">Save Changes</button>
        </form>
      </div>
    </div>`;
  }

  // ---------------- Router / dispatch ----------------
  function render() {
    const route = S.state.route;
    switch (route.view) {
      case 'store': return renderStore(route.params);
      case 'checkout': return renderCheckout();
      case 'confirmation': return renderConfirmation(route.params);
      case 'confirmation-multi': return renderConfirmationMulti(route.params);
      case 'track': return renderTracking(route.params);
      case 'orders': return renderHistory();
      case 'favorites': return renderFavorites();
      case 'profile': return renderProfile();
      default: return renderHome();
    }
  }

  function handleAction(action, ds) {
    if (STOREFRONT_ACTIONS.has(action)) return App.Pages.Home.handleAction(action, ds);
    switch (action) {
      case 'open-food': return openFoodDetail(ds.id);
      case 'view-food-image': {
        const item = S.state.menu.find(m => m.id === ds.id);
        if (item && item.image) App.ImageViewer.open(item.image, item.name);
        return;
      }
      case 'fav-quick-add': return App.Pages.Home.addStoreItemToCart(ds.id);
      case 'toggle-favorite': S.toggleFavorite(ds.id); refreshDetailModal(); return;
      case 'reorder': return reorder(ds.id);
      case 'detail-qty': {
        detailState.qty = U.clamp(detailState.qty + Number(ds.delta), 1, 20);
        return refreshDetailModal();
      }
      case 'add-to-cart-detail': return addToCartFromDetail(ds.id);
      case 'go-checkout': App.Slideover.close(); return startCheckout();
      case 'checkout-next': return checkoutNext();
      case 'checkout-back': syncCheckoutFields(); return checkoutBack();
      case 'select-zone': return selectZone(ds.id);
      case 'select-payment': return selectPayment(ds.method);
      case 'select-fulfilment': return selectFulfilment(ds.mode);
      case 'select-collection-time': return selectCollectionTime(ds.storeId, ds.time);
      case 'apply-promo': return applyPromo();
      case 'add-addon-to-cart': return addAddonToCart(ds.id);
      case 'addon-qty': return changeAddonQty(ds.id, ds.delta);
      case 'place-order': return placeOrder();
      case 'track-order': App.Modal.close(); return S.setRoute({ view: 'track', params: { orderId: ds.id } });
      case 'view-receipt': {
        const order = S.state.orders.find(o => o.id === ds.id);
        if (order) App.Shared.openReceiptModal(order);
        return;
      }
      case 'cancel-order': return cancelOrderConfirm(ds.id);
      case 'rate-order': {
        const order = S.state.orders.find(o => o.id === ds.id);
        if (order) App.Shared.openReviewModal(order);
        return;
      }
      default: return;
    }
  }

  function handleInput(kind, value, ds) {
    if (STOREFRONT_INPUTS.has(kind)) return App.Pages.Home.handleInput(kind, value, ds);
    if (kind === 'nav-search') {
      App.Pages.Home.local.search = value;
      if (S.state.route.view !== 'home') S.setRoute({ view: 'home', params: {} });
      else App.render();
      return;
    }
    if (kind === 'update-instructions') { detailState.instructions = value; }
  }
  function kb(bytes) { return bytes ? (bytes / 1024).toFixed(0) + ' KB' : ''; }

  async function handleChange(kind, ds, value, el) {
    if (STOREFRONT_CHANGES.has(kind)) return App.Pages.Home.handleChange(kind, ds, value);
    if (kind === 'toggle-extra') { detailState.extras[ds.key] = !detailState.extras[ds.key]; refreshDetailModal(); return; }
    if (kind === 'upload-avatar') return handleAvatarUpload(value, el);
  }

  async function handleAvatarUpload(file, el) {
    if (!file) return;
    if (file.size > App.Upload.MAX_UPLOAD_BYTES) { App.Toast.error('Image must be smaller than 10MB.'); return; }

    const wrap = el.closest('.image-upload');
    const statusEl = wrap.querySelector('.image-upload-status');
    const hiddenInput = wrap.querySelector('input[type="hidden"][name="avatar_url"]');
    const previewWrap = wrap.querySelector('.image-upload-preview');
    const labelEl = wrap.querySelector('.image-upload-label');
    const progressWrap = wrap.querySelector('.image-upload-progress');
    const progressBar = wrap.querySelector('.image-upload-progress-bar');

    const beforeUrl = URL.createObjectURL(file);
    previewWrap.innerHTML = `<img src="${beforeUrl}" alt="" />`;
    previewWrap.style.display = '';
    progressWrap.style.display = '';
    progressBar.style.width = '0%';
    statusEl.textContent = `Optimizing… (original ${kb(file.size)})`;

    const res = await App.Upload.uploadImage(file, {
      kind: 'avatar',
      onProgress: (pct) => { progressBar.style.width = pct + '%'; statusEl.textContent = `Uploading… ${pct}%`; },
    });
    URL.revokeObjectURL(beforeUrl);
    progressWrap.style.display = 'none';

    if (res.error) { statusEl.textContent = ''; App.Toast.error(res.error); return; }

    hiddenInput.value = res.data.url;
    previewWrap.innerHTML = `<img src="${U.escapeHtml(res.data.url)}" alt="" />`;
    if (labelEl) labelEl.textContent = 'Change Photo';
    statusEl.textContent = 'Uploaded';
  }

  async function handleSubmit(formId, data) {
    if (formId === 'profile-form') {
      const res = await App.Auth.updateProfile({
        name: data.get('name'), phone: data.get('phone'), avatar_url: data.get('avatar_url'),
        university: data.get('university'),
        default_location: { residence: data.get('residence'), street: data.get('street') },
      });
      if (res.error) App.Toast.error(res.error); else { App.Toast.success('Profile updated'); App.render(); }
    }
  }

  return {
    render, handleAction, handleInput, handleChange, handleSubmit,
    checkForReviewPrompt, local,
  };
})();
