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
    checkout: null, promptedReviews: new Set(), promptedReviewsFor: null, paymentMethods: null,
    userCoords: null, // cached once known this session — see ensureUserCoords()
  };

  // Directions (order pickup, My Orientation, My Timetable) should start
  // from where the student actually IS, not a fixed campus/shop point —
  // reuses a coordinate we already have, otherwise makes one silent,
  // best-effort attempt to get it (prompting for permission if needed).
  // Never blocks or fails the actual directions hand-off: if location is
  // denied/unavailable/slow, this just resolves null and the launcher
  // falls back to its existing behaviour.
  async function ensureUserCoords() {
    if (local.userCoords) return local.userCoords;
    const res = await App.Orientation.LocationService.getCurrentPosition({ timeout: 4000 });
    if (res.error) return null;
    local.userCoords = res.coords;
    return local.userCoords;
  }

  // Lazily loaded once per app session and cached — both checkout step 3
  // and the Profile page's "Saved Cards" section read from the same
  // local.paymentMethods, so removing/adding a card in one place is
  // reflected in the other without a second round trip.
  async function ensurePaymentMethodsLoaded() {
    if (local.paymentMethods) return;
    local.paymentMethods = await App.Payments.fetchPaymentMethods();
    App.render();
  }
  async function refreshPaymentMethods() {
    local.paymentMethods = await App.Payments.fetchPaymentMethods();
    App.render();
  }

  // Cancelling on Paystack's page doesn't always come back as a fresh
  // redirect to callback_url — clicking its own "Cancel"/back control (or
  // just using the browser's back button) can instead restore THIS exact
  // page from the browser's back-forward cache (bfcache), frozen exactly
  // as it was the instant window.location.href = authorization_url ran —
  // meaning the "Place Order" button is left stuck showing its loading
  // spinner forever, with nothing ever telling the customer their order
  // was never placed. `pageshow` with event.persisted=true is the real,
  // standard signal that a page just came back from bfcache rather than a
  // fresh load — nothing else here can detect that case.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    if (local.checkout && local.checkout.placing) {
      local.checkout.placing = false;
      App.Toast.error('Your payment was cancelled — your order was not placed.');
      App.render();
    }
  });

  // ---------------- HOME (delegates to the shared storefront) ----------------
  // The greeting now lives in the header ("Hey, {name}"), so this is just a
  // thin wrapper around the real browsing UI — no separate/duplicate one here.
  function renderHome() {
    return `
    <div class="page-wrap">
      ${nextClassBanner()}
      ${App.Pages.Home.renderBrowser()}
    </div>`;
  }

  // My Timetable's own Next/Current Class card, reused here so the
  // home screen and the Timetable page never show two different
  // implementations of the same "what's next" logic. Timetable data is
  // loaded once at login (App.Bootstrap.loadPrivateData) — nothing to
  // lazy-fetch here. Silent if the student has no classes at all yet,
  // rather than nagging an empty prompt on every visit to Home.
  function nextClassBanner() {
    if (!S.state.timetable.length) return '';
    return `<div class="mb-3">${App.Pages.Timetable.nextClassCard()}</div>`;
  }

  // ---------------- More (full page — replaces the old small dropdown) ----------------
  // Everything that isn't a primary bottom-nav tab lives here: RecessBox,
  // My Orientation, My Timetable, theme, profile/settings, logout. My
  // Orientation deliberately lives ONLY here now, not as its own banner
  // on the Home screen — Home stays focused on browsing/ordering food.
  function moreMenuItem(icon, label, sublabel, action, ds, extra) {
    return `<button type="button" class="card card-pad mb-2" style="text-align:left;width:100%;cursor:pointer;display:flex;align-items:center;gap:12px;" data-action="${action}"${ds || ''}>
      <div style="width:40px;height:40px;flex-shrink:0;border-radius:50%;background:var(--bg-surface-2);display:flex;align-items:center;justify-content:center;color:var(--color-primary);"><i data-lucide="${icon}"></i></div>
      <div style="flex:1;">
        <div class="font-bold" style="font-size:14px;">${U.escapeHtml(label)}</div>
        ${sublabel ? `<div class="text-xs text-muted">${U.escapeHtml(sublabel)}</div>` : ''}
      </div>
      ${extra || '<i data-lucide="chevron-right" style="color:var(--text-muted);"></i>'}
    </button>`;
  }

  // Same look as moreMenuItem, but a plain external link (opens the static
  // legal document) rather than an app action — no handleAction wiring
  // needed for these two.
  function moreMenuLink(icon, label, href) {
    return `<a href="${U.escapeHtml(href)}" target="_blank" rel="noopener" class="card card-pad mb-2" style="text-align:left;width:100%;cursor:pointer;display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;">
      <div style="width:40px;height:40px;flex-shrink:0;border-radius:50%;background:var(--bg-surface-2);display:flex;align-items:center;justify-content:center;color:var(--color-primary);"><i data-lucide="${icon}"></i></div>
      <div class="font-bold" style="font-size:14px;flex:1;">${U.escapeHtml(label)}</div>
      <i data-lucide="external-link" style="color:var(--text-muted);width:16px;height:16px;"></i>
    </a>`;
  }

  function renderMorePage() {
    const p = S.state.profile;
    const isDark = S.state.theme === 'dark';
    return `
    <div class="page-wrap" style="max-width:560px;">
      <button type="button" class="btn-icon mb-3" data-action="go-home" aria-label="Back"><i data-lucide="arrow-left"></i></button>
      <div class="flex items-center gap-3 mb-4">
        <div class="profile-avatar-lg">${p.avatar_url ? `<img src="${U.escapeHtml(p.avatar_url)}">` : U.escapeHtml(U.initials(p.name))}</div>
        <div>
          <div class="font-bold text-lg">${U.escapeHtml(p.name)}</div>
          <div class="text-muted text-sm">${U.escapeHtml(p.email)}</div>
        </div>
      </div>

      ${moreMenuItem('compass', 'My Orientation', 'Get walking directions around your UP campus', 'navigate', ' data-view="orientation"')}
      ${moreMenuItem('calendar', 'My Timetable', 'Your classes, reminders and directions', 'navigate', ' data-view="timetable"')}
      ${moreMenuItem('package', 'RecessBox', 'Book campus storage', 'open-campusbox')}

      <div class="divider" style="margin:16px 0;"></div>

      ${moreMenuItem(isDark ? 'sun' : 'moon', isDark ? 'Light Mode' : 'Dark Mode', null, 'toggle-theme')}
      ${moreMenuItem('user', 'Profile', 'Your details, payment methods and saved cards', 'go-profile')}
      ${moreMenuItem('settings', 'Settings', null, 'go-profile')}

      <div class="divider" style="margin:16px 0;"></div>

      ${moreMenuLink('shield', 'Privacy Policy', '/legal/privacy-policy.html')}
      ${moreMenuLink('file-text', 'Terms of Service', '/legal/terms-of-service.html')}

      <div class="divider" style="margin:16px 0;"></div>

      <button type="button" class="card card-pad" style="text-align:left;width:100%;cursor:pointer;display:flex;align-items:center;gap:12px;color:var(--color-error);" data-action="logout">
        <div style="width:40px;height:40px;flex-shrink:0;border-radius:50%;background:rgba(239,68,68,0.1);display:flex;align-items:center;justify-content:center;"><i data-lucide="log-out"></i></div>
        <div class="font-bold" style="font-size:14px;">Logout</div>
      </button>
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
        <img class="food-detail-img" src="${U.escapeHtml(item.image || '')}" alt="${U.escapeHtml(item.name)}" style="cursor:zoom-in;" data-action="view-food-image" data-id="${item.id}" onerror="this.onerror=null;this.src='icons/clickfud-icon-192.png';this.classList.add('img-fallback')">
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
          <span class="text-lg font-bold text-primary-c">${U.money((U.menuItemPrice(item) + extrasTotal) * detailState.qty)}</span>
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
      menuItemId: item.id, name: item.name, price: U.menuItemPrice(item), image: item.image,
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
        menuItemId: it.menuItemId, name: it.name, price: U.menuItemPrice(menuItem), image: menuItem.image,
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
    // If they chose Delivery/Collection on the home page's "Start Order"
    // flow before creating an account, honor that instead of defaulting
    // back to Collection and making them pick it again — consumed once
    // (removed right after reading) so it only ever applies to this
    // first checkout, never a later unrelated order.
    let carriedFulfilment = 'collection';
    try {
      const stored = localStorage.getItem(App.CONST.LS_KEYS.GUEST_FULFILMENT);
      // Collection only for now — an old saved 'delivery' choice is ignored.
      localStorage.removeItem(App.CONST.LS_KEYS.GUEST_FULFILMENT);
    } catch (e) {}
    local.checkout = {
      step: 1, campus: 'Main Campus', zoneId: S.state.zones[0]?.id || '', room: '', instructions: '',
      phone: S.state.profile?.phone || '', paymentMethod: 'cod', selectedMethodId: null, studentNumber: S.state.profile?.student_number || '',
      fulfilment: carriedFulfilment, collectionTimes: {},
      promoCode: '', promoResult: null, promoInput: '', promoError: null,
      placing: false,
    };
    S.setRoute({ view: 'checkout' });
    App.forceScrollTop();
    ensurePaymentMethodsLoaded();
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
    let closing = new Date(now.getFullYear(), now.getMonth(), now.getDate(), ch, cm);
    // Overnight closing time (e.g. 01:00/02:00) lands on TODAY's calendar
    // date by the math above, which is already in the past the moment
    // anyone checks out later that same day — the slot loop below would
    // then never run at all. Roll it forward to the closing time that's
    // actually still ahead (same fix as App.Stores.isOpenNow()).
    if (closing <= now) closing = new Date(closing.getTime() + 24 * 60 * 60000);

    const slots = [];
    let t = new Date(earliest);
    while (t < closing && slots.length < 6) {
      slots.push(new Date(t));
      t = new Date(t.getTime() + 30 * 60000);
    }
    return slots;
  }

  // The student number the student signed up with (profiles.student_number) —
  // checkout never asks for it again. Only older accounts without one
  // still get the field.
  function accountStudentNumber() {
    return (S.state.profile && S.state.profile.student_number) || '';
  }

  function cartTotals() {
    const c = local.checkout;
    const subtotal = S.state.cart.reduce((s, i) => s + (i.price + (i.addonsTotal || 0)) * i.qty, 0);
    const deliveryFee = 0;
    // Re-worked out from the live cart: changing the product's quantity
    // (or removing it) after applying a code updates the discount too.
    let discount = 0;
    if (c.promoResult) {
      const r = App.Promotions.validateCode(c.promoCode, S.state.cart);
      discount = r.error ? 0 : r.discount;
    }
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
          <input class="input ${c.promoError ? 'has-error' : ''}" id="promo-input" placeholder="e.g. CAMPUS10" value="${U.escapeHtml(c.promoInput)}" data-action-input="promo-input" autocapitalize="characters" />
          <button type="button" class="btn btn-secondary ${c.promoChecking ? 'btn-loading' : ''}" data-action="apply-promo" ${c.promoChecking ? 'disabled' : ''}>Apply</button>
        </div>
        ${c.promoError ? `<div class="field-error mt-1"><i data-lucide="alert-circle" style="width:14px;height:14px"></i> ${U.escapeHtml(c.promoError)}</div>` : ''}
        ${c.promoResult ? `<div class="text-sm text-success mt-1"><i data-lucide="check-circle-2" style="width:14px;height:14px"></i> ${U.escapeHtml(c.promoCode)} applied${c.promoResult.productName ? ' to ' + U.escapeHtml(c.promoResult.productName) : ''}: you save ${U.money(c.promoResult.discount)}</div>` : ''}
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

  function cardLabel(m) {
    const brand = m.card_type ? m.card_type.toUpperCase() : 'Card';
    return `${U.escapeHtml(brand)} •••• ${U.escapeHtml(m.last4 || '----')}`;
  }

  function renderCheckoutStep3() {
    const c = local.checkout;
    const savedMethods = local.paymentMethods || [];
    const hasSaved = savedMethods.length > 0;
    return `
    <div class="card card-pad">
      <h3 class="font-bold mb-3">Payment Method</h3>
      <div class="payment-option ${c.paymentMethod === 'cod' ? 'selected' : ''}" data-action="select-payment" data-method="cod">
        <i data-lucide="banknote"></i><div><strong>Cash ${c.fulfilment === 'delivery' ? 'on Delivery' : 'on Collection'}</strong><div class="text-xs text-muted">Pay when you ${c.fulfilment === 'delivery' ? 'receive your order' : 'collect your order'}</div></div>
      </div>
      ${savedMethods.map(m => `
      <div class="payment-option ${c.paymentMethod === 'saved' && c.selectedMethodId === m.id ? 'selected' : ''}" data-action="select-payment" data-method="saved" data-payment-method-id="${m.id}">
        <i data-lucide="credit-card"></i><div><strong>${cardLabel(m)}</strong><div class="text-xs text-muted">${U.escapeHtml(m.bank || 'Saved card')}${m.is_default ? ' · Default' : ''}</div></div>
      </div>`).join('')}
      <div class="payment-option ${c.paymentMethod === 'card' ? 'selected' : ''}" data-action="select-payment" data-method="card">
        <i data-lucide="credit-card"></i><div><strong>${hasSaved ? 'Use a Different Card' : 'Pay Online'}</strong><div class="text-xs text-muted">Card, via Paystack</div></div>
      </div>
      ${c.paymentMethod === 'card' ? `
      <div class="mt-3 text-sm text-muted" style="display:flex;gap:8px;align-items:flex-start;">
        <i data-lucide="lock" style="width:15px;height:15px;flex-shrink:0;margin-top:2px;color:var(--color-primary);"></i>
        <span>You'll be securely redirected to Paystack to complete your payment, then brought straight back here.</span>
      </div>` : ''}
      ${c.paymentMethod === 'saved' ? `
      <div class="mt-3 text-sm text-muted" style="display:flex;gap:8px;align-items:flex-start;">
        <i data-lucide="lock" style="width:15px;height:15px;flex-shrink:0;margin-top:2px;color:var(--color-primary);"></i>
        <span>Charged directly to this saved card — no redirect needed. If it can't be charged, we'll fall back to Paystack checkout automatically.</span>
      </div>` : ''}
      ${c.paymentMethod === 'cod' && !accountStudentNumber() ? `
      <div class="field mt-3">
        <label>University of Pretoria Student Number</label>
        <input class="input" id="ck-student-number" value="${U.escapeHtml(c.studentNumber)}" placeholder="e.g. u12345678" />
        <div class="text-xs text-muted mt-1">Shown to staff when you collect your order, for confirmation.</div>
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
      <div class="text-sm mb-2"><strong>Payment:</strong> ${c.paymentMethod === 'cod' ? 'Cash' : c.paymentMethod === 'saved' ? 'Saved Card (' + cardLabel((local.paymentMethods || []).find(m => m.id === c.selectedMethodId) || {}) + ')' : 'Card'}</div>
      <div class="text-sm mb-3"><strong>Total:</strong> <span class="text-primary-c font-bold">${U.money(t.total)}</span></div>
      ${!S.state.connection.online ? `<div class="offline-note"><i data-lucide="wifi-off"></i><span>You are currently offline. Connect to the internet to place your order.</span></div>` : ''}
      <button class="btn btn-primary btn-block btn-lg ${c.placing ? 'btn-loading' : ''}" data-action="place-order">Place Order</button>
    </div>`;
  }

  // ---- Unfinished payment (left Paystack without paying) ----
  // Puts back everything they typed at checkout and opens the last step.
  function resumeUnfinishedCheckout() {
    const u = App.Payments.getUnfinishedCheckout();
    if (!u || !S.state.cart.length) return false;
    if (!local.checkout) startCheckout();
    local.checkout = Object.assign({}, local.checkout, u.checkout || {}, { placing: false, promoChecking: false, step: 4 });
    if (S.state.route.view !== 'checkout') S.setRoute({ view: 'checkout' });
    App.render();
    App.forceScrollTop();
    return true;
  }

  function unfinishedPaymentCard() {
    const u = App.Payments.getUnfinishedCheckout();
    if (!u || !S.state.cart.length) return '';
    const resuming = !!local.resumingPayment;
    return `
    <div class="card card-pad mb-3" style="border:2px solid var(--color-primary);">
      <div class="flex items-center gap-2 mb-1"><i data-lucide="credit-card" style="width:18px;height:18px;color:var(--color-primary)"></i><strong>You didn't finish paying</strong></div>
      <p class="text-sm text-muted mb-3">Your order details are saved${u.total ? ` (${U.money(u.total)})` : ''}. Continue to complete your payment on Paystack.</p>
      <div class="flex gap-2">
        <button type="button" class="btn btn-primary ${resuming ? 'btn-loading' : ''}" data-action="resume-payment" ${resuming ? 'disabled' : ''}><i data-lucide="lock"></i>Continue payment</button>
        <button type="button" class="btn btn-secondary" data-action="cancel-unfinished-payment" ${resuming ? 'disabled' : ''}>Cancel payment</button>
      </div>
    </div>`;
  }

  function renderCheckout() {
    if (!local.checkout) { S.setRoute({ view: 'home' }); return renderHome(); }
    const c = local.checkout;
    const stepRenderers = [renderCheckoutStep1, renderCheckoutStep2, renderCheckoutStep3, renderCheckoutStep4];
    return `
    <div class="page-wrap" style="max-width:900px;">
      <h1 class="page-title mb-3">Checkout</h1>
      ${unfinishedPaymentCard()}
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
    if (step === 3 && c.paymentMethod === 'cod') {
      if (!accountStudentNumber() && !c.studentNumber.trim()) return 'Please enter your University of Pretoria student number.';
    }
    if (step === 3 && c.paymentMethod === 'saved' && !c.selectedMethodId) {
      return 'Please select a saved card.';
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
    if ($('ck-student-number')) c.studentNumber = $('ck-student-number').value;
  }

  function selectZone(id) { local.checkout.zoneId = id; App.render(); }
  function selectPayment(method, paymentMethodId) {
    syncCheckoutFields();
    local.checkout.paymentMethod = method;
    local.checkout.selectedMethodId = paymentMethodId || null;
    App.render();
  }
  function selectFulfilment(mode) { syncCheckoutFields(); local.checkout.fulfilment = mode; App.render(); }
  function selectCollectionTime(storeId, iso) { local.checkout.collectionTimes[storeId] = iso; App.render(); }

  async function applyPromo() {
    const c = local.checkout;
    if (c.promoChecking) return;
    const input = document.getElementById('promo-input');
    const code = (input ? input.value : c.promoInput).trim();
    c.promoInput = code;
    // The list of codes is otherwise only loaded when the app opens, so a
    // code a manager created or switched on since then would be "not
    // valid". Always check against the latest codes.
    if (code) {
      c.promoChecking = true; App.render();
      const fresh = await App.Promotions.fetchAll();
      c.promoChecking = false;
      if (fresh && fresh.error) {
        c.promoCode = ''; c.promoResult = null;
        c.promoError = "We couldn't check this code right now. Please check your connection and try again.";
        App.Toast.error(c.promoError);
        App.render();
        return;
      }
    }
    const result = App.Promotions.validateCode(code, S.state.cart);
    if (result.error) {
      // A wrong code must never leave an earlier code's discount in place,
      // and the reason stays visible under the box (a toast alone is easy
      // to miss behind the phone keyboard).
      c.promoCode = ''; c.promoResult = null; c.promoError = result.error;
      App.Toast.error(result.error);
      App.render();
      return;
    }
    c.promoCode = code.toUpperCase(); c.promoInput = c.promoCode;
    c.promoResult = result; c.promoError = null;
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
    // studentNumber is only ever collected for cash orders (see
    // renderCheckoutStep3) — undefined for card, which keeps it out of the
    // stored delivery_location for those orders entirely.
    const own = accountStudentNumber() || c.studentNumber.trim();
    const studentNumber = c.paymentMethod === 'cod' && own ? own : undefined;
    return c.fulfilment === 'delivery'
      ? { campus: c.campus, building: '', zoneId: c.zoneId, room: c.room, instructions: c.instructions, phone: c.phone, fulfilment: 'delivery', studentNumber }
      : { building: g.store ? g.store.name : (g.storeName || ''), room: '', instructions: '', phone: c.phone, fulfilment: 'collection', collectionTime: c.collectionTimes[g.storeId], studentNumber };
  }

  // ---- Duplicate-order protection ----
  // One idempotency key per (customer, shop, exact cart contents), kept in
  // localStorage so it survives a reload/app close mid-checkout. Retrying
  // the SAME order — after a dropped connection, a double tap, reopening
  // the app — reuses the same key, and the database's unique index (see
  // App.Orders.insertOrderIdempotent) turns a would-be duplicate into
  // "here's the order you already placed". Changing the cart changes the
  // signature, which correctly means a genuinely new order/key.
  const ORDER_KEYS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  function orderKeysStorageKey() { return 'cfe_order_keys_' + (S.state.profile ? S.state.profile.id : 'guest'); }
  function readOrderKeys() {
    try { return JSON.parse(localStorage.getItem(orderKeysStorageKey()) || '{}'); } catch (e) { return {}; }
  }
  function writeOrderKeys(keys) {
    try { localStorage.setItem(orderKeysStorageKey(), JSON.stringify(keys)); } catch (e) {}
  }
  function newRequestId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    // RFC4122 v4 fallback for older browsers without randomUUID.
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (ch) =>
      (ch ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (ch / 4)))).toString(16));
  }
  function orderSignature(parts) { return JSON.stringify(parts); }
  function orderRequestKey(scope, parts) {
    const keys = readOrderKeys();
    const sig = orderSignature(parts);
    const now = Date.now();
    Object.keys(keys).forEach((k) => { if (now - keys[k].at > ORDER_KEYS_MAX_AGE_MS) delete keys[k]; });
    if (!keys[scope] || keys[scope].sig !== sig) keys[scope] = { key: newRequestId(), sig, at: now };
    writeOrderKeys(keys);
    return keys[scope].key;
  }
  function clearOrderRequestKey(scope) {
    const keys = readOrderKeys();
    delete keys[scope];
    writeOrderKeys(keys);
  }
  function groupSignatureParts(c, g) {
    return {
      method: c.paymentMethod,
      fulfilment: c.fulfilment,
      items: g.items.map(it => [it.menuItemId, it.qty, it.addons || [], it.specialInstructions || '', !!it.isAddon]),
    };
  }

  // The one gate every payment method goes through. Offline (or Supabase
  // unreachable) means no order attempt at all — nothing is saved locally
  // as a "pending" order, and nothing is ever shown as placed.
  async function placeOrder() {
    const c = local.checkout;
    if (!c || c.placing) return; // already submitting — ignore repeat taps
    c.placing = true; App.render();

    const reachable = navigator.onLine && await App.Connectivity.checkBackend();
    if (!reachable) {
      App.Connectivity.reportNetworkFailure();
      c.placing = false;
      App.Toast.error('You are currently offline. Connect to the internet to place your order.');
      App.render();
      return;
    }
    // Never check out against the offline snapshot — reload live prices/
    // availability first. (The server re-prices every order regardless;
    // this just keeps what the customer sees in line with what they pay.)
    if (S.state.connection.usingCachedData) {
      await App.Bootstrap.loadPublicData();
      if (S.state.connection.usingCachedData) {
        c.placing = false;
        App.Toast.error("We couldn't load the latest menu and prices. Please try again in a moment.");
        App.render();
        return;
      }
    }

    c.placing = false;
    const method = c.paymentMethod;
    // Same cart still waiting on an unfinished Paystack payment: finish
    // THAT one rather than starting a second payment for the same food.
    const unfinished = method === 'card' && App.Payments.getUnfinishedCheckout();
    if (unfinished && unfinished.cart === App.Payments.cartSignature(S.state.cart) && App.continueUnfinishedPayment) return App.continueUnfinishedPayment();
    if (method === 'card') return placeOrderOnline();
    if (method === 'saved') return placeOrderSaved();
    return placeOrderCod();
  }

  // Charges a saved card directly (no redirect) via paystack-charge-saved,
  // then follows the exact same confirm/clear-cart/refresh sequence as
  // handlePaystackReturn() in app.js for the redirect path — one paid
  // order should look and feel identical to the customer no matter which
  // channel actually charged the card.
  async function placeOrderSaved() {
    const c = local.checkout;
    if (!c.selectedMethodId) { App.Toast.error('Please select a saved card.'); return; }
    c.placing = true; App.render();
    App.Shared.openVerifyingPaymentModal();

    const groups = cartStoreGroups();
    const payloadGroups = groups.map(g => ({
      storeId: g.storeId,
      items: g.items.map(it => ({
        menuItemId: it.menuItemId, qty: it.qty, isAddon: !!it.isAddon,
        addons: it.addons || [], specialInstructions: it.specialInstructions || '',
      })),
      deliveryLocation: groupDeliveryLocation(c, g),
    }));

    // Same key for every retry of this exact charge — paystack-charge-saved
    // turns it into the Paystack reference, so a repeat after a lost
    // response returns the original result instead of charging again.
    const keyScope = 'saved:' + c.selectedMethodId;
    const idempotencyKey = orderRequestKey(keyScope, {
      promo: c.promoResult ? c.promoCode : null,
      groups: groups.map(g => [g.storeId, groupSignatureParts(c, g)]),
    });

    let res;
    try {
      res = await App.Payments.chargeSavedCard(c.selectedMethodId, payloadGroups, c.promoResult ? c.promoCode : null, idempotencyKey);
    } catch (e) {
      App.Modal.close();
      c.placing = false;
      App.Toast.error("Something went wrong charging your saved card. Please try again.");
      App.render();
      return;
    }
    App.Modal.close();
    // A definitive answer (paid or declined) retires the key; only a
    // transport failure (no answer at all) keeps it for the retry.
    if (!res.transient) clearOrderRequestKey(keyScope);

    if (!res.ok) {
      if (res.fallbackToCheckout) {
        // The saved card genuinely couldn't be charged without a browser
        // present (declined, needs re-authentication, etc.) — this is a
        // normal, expected case, not an app error. Drop back to the real
        // Paystack Checkout redirect rather than leaving the customer stuck.
        App.Toast.warning((res.error || 'Your saved card could not be charged.') + ' Redirecting you to a secure checkout instead…');
        c.paymentMethod = 'card';
        return placeOrderOnline();
      }
      c.placing = false;
      App.Toast.error(res.error || 'Unable to complete your payment.');
      App.render();
      return;
    }

    c.placing = false;
    const orderIds = res.orderIds || [];
    if (!orderIds.length) {
      App.Toast.success('Payment verified.');
      App.render();
      return;
    }
    S.clearCart();
    local.checkout = null;
    if (orderIds.length === 1) {
      S.setRoute({ view: 'confirmation', params: { orderId: orderIds[0] } });
      App.Shared.openOrderSuccessModal({ count: 1, orderNumber: null });
    } else {
      S.setRoute({ view: 'confirmation-multi', params: { orderIds } });
      App.Shared.openOrderSuccessModal({ count: orderIds.length });
    }
    App.forceScrollTop();
    App.Bootstrap.loadPrivateData().catch((e) => console.error('loadPrivateData after saved-card payment failed', e));
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
    // Everything typed at checkout is saved with the payment, so if the
    // student leaves Paystack without paying they can pick up right here.
    const snapshot = JSON.parse(JSON.stringify(Object.assign({}, c, { placing: false, promoChecking: false, step: 4 })));
    const res = await App.Payments.startPaystackCheckout(payloadGroups, c.promoResult ? c.promoCode : null, { checkout: snapshot, total: cartTotals().total });
    if (res.error) {
      c.placing = false;
      App.Toast.error(res.error);
      App.render();
    }
    // On success, startPaystackCheckout() has started navigating to
    // Paystack. Usually this page goes away; but if Paystack opens
    // somewhere else instead (the installed app hands it to a separate
    // browser) this window stays here — watch for the result so it
    // confirms on its own when the student comes back (js/app.js).
    if (res.pending && App.watchPendingPayment) App.watchPendingPayment();
  }

  async function placeOrderCod() {
    const c = local.checkout;
    c.placing = true; App.render();

    const groups = cartStoreGroups();
    let discount = 0, appliedPromo = null;
    if (c.promoResult) {
      await App.Promotions.fetchAll(); // a code switched off since it was applied must not be used
      const result = App.Promotions.validateCode(c.promoCode, S.state.cart);
      if (result.error) {
        c.placing = false; c.promoResult = null; c.promoCode = ''; c.promoError = result.error;
        App.Toast.error(result.error);
        App.render();
        return;
      }
      discount = result.discount;
      appliedPromo = result.promo;
    }

    // The discount goes to the shop(s) whose lines it was worked out on —
    // for a product code that's only the product's own shop.
    const eligibleByGroup = groups.map(g => appliedPromo ? App.Promotions.eligibleTotal(appliedPromo, g.items) : 0);
    const eligibleAll = eligibleByGroup.reduce((a, b) => a + b, 0);
    const lastEligible = eligibleByGroup.map(e => e > 0).lastIndexOf(true);
    const results = [];
    let discountLeft = discount;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const groupDiscount = !discount || !eligibleByGroup[i] ? 0
        : (i === lastEligible ? discountLeft : App.Orders.round2(discount * (eligibleByGroup[i] / eligibleAll)));
      if (i !== lastEligible) discountLeft = App.Orders.round2(discountLeft - groupDiscount);

      const items = g.items.map(it => ({ menuItemId: it.menuItemId, name: it.name, price: it.price, qty: it.qty, image: it.image, addons: it.addons, addonsTotal: it.addonsTotal, specialInstructions: it.specialInstructions, isAddon: !!it.isAddon }));
      const keyScope = 'cod:' + g.storeId;
      const res = await App.Orders.createOrder({
        clientRequestId: orderRequestKey(keyScope, groupSignatureParts(c, g)),
        items,
        storeId: g.storeId,
        deliveryLocation: groupDeliveryLocation(c, g),
        paymentMethod: c.paymentMethod,
        discountOverride: groupDiscount,
        promoCode: appliedPromo && groupDiscount > 0 ? appliedPromo.code : null,
        deliveryFee: 0,
      });
      // The key is only retired once this shop's order definitely exists;
      // after a lost connection it's kept, so the retry can't duplicate.
      if (!res.error) clearOrderRequestKey(keyScope);
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
    // many stores it was split across. Best-effort: the order(s) above are
    // already real and placed, so a hiccup incrementing a promo counter must
    // never throw and silently kill the confirmation modal/cart-clear below
    // for an order that genuinely succeeded.
    if (appliedPromo) {
      try { await App.Promotions.incrementUsage(appliedPromo.id); } catch (e) { console.error('incrementUsage failed', e); }
    }
    if (failed.length) {
      App.Toast.warning(`Couldn't order from ${failed.map(f => f.storeName).join(', ')}: ${failed[0].error}. Those items are still in your cart.`);
    } else {
      // Every group in this checkout succeeded — each App.Orders.createOrder()
      // call above already removed its own store's items, but clearing the
      // whole cart here too is a hard guarantee against any leftover: with
      // nothing failed, there is nothing left that should still be sitting
      // in the cart for something that was just paid for.
      S.clearCart();
    }
    local.checkout = null;
    if (succeeded.length === 1) {
      S.setRoute({ view: 'confirmation', params: { orderId: succeeded[0].order.id } });
    } else {
      S.setRoute({ view: 'confirmation-multi', params: { orderIds: succeeded.map(s => s.order.id) } });
    }
    App.forceScrollTop();
    App.Shared.openOrderSuccessModal({
      count: succeeded.length,
      orderNumber: succeeded.length === 1 ? succeeded[0].order.order_number : null,
    });
  }

  // ---------------- CONFIRMATION ----------------
  function renderConfirmation(params) {
    const order = S.state.orders.find(o => o.id === params.orderId);
    if (!order) return renderHome();
    // A real, server-computed estimate (migration_governance.sql section
    // 38) that already accounts for how many other orders are ahead of
    // this one in the kitchen's actual queue — not just this order's own
    // items' prep time, which is all the old client-side estimate knew
    // about. Falls back to the old per-item calculation only if a legacy
    // order somehow has no estimated_ready_at on record.
    const prepTime = order.estimated_ready_at
      ? Math.max(1, Math.round((new Date(order.estimated_ready_at) - new Date(order.created_at)) / 60000))
      : Math.max(...(order.items || []).map(it => {
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

  // A store's pickup location is only ever real address text — never
  // routed through App.Orientation's UP-specific campus list (a shop
  // can belong to a different university entirely; see the Staff app's
  // full UNIVERSITY_CAMPUSES), and never an approximate guess. Returns
  // null (not a broken button) when the shop hasn't configured a real
  // location yet — see migration_governance.sql section 44.
  function orderDirectionsButton(store) {
    if (!store || !store.address || store.address === App.CONST.PLACEHOLDER_PICKUP_ADDRESS) return '';
    return `<button type="button" class="btn btn-primary ${local.orderDirectionsLaunching ? 'btn-loading' : ''}" data-action="order-directions" data-store-id="${U.escapeHtml(store.id)}" ${local.orderDirectionsLaunching ? 'disabled' : ''}>
      <i data-lucide="navigation"></i> Get Directions
    </button>`;
  }

  async function getOrderDirections(storeId) {
    const store = App.Stores.getById(storeId);
    if (!store || !store.address || store.address === App.CONST.PLACEHOLDER_PICKUP_ADDRESS) {
      App.Toast.error("This shop hasn't set up a pickup location yet.");
      return;
    }
    if (local.orderDirectionsLaunching) return;
    local.orderDirectionsLaunching = true;
    App.render();
    const coords = await ensureUserCoords();
    const campusLabel = [store.campus_location ? store.campus_location + ' Campus' : '', store.university].filter(Boolean).join(', ');
    const res = App.Orientation.MapsLauncher.launch({ name: store.address }, { fullName: campusLabel }, coords);
    if (res.error) App.Toast.error(res.message || "Couldn't open Google Maps right now.");
    setTimeout(() => { local.orderDirectionsLaunching = false; App.render(); }, 1500);
  }

  // No new column needed — every order already logs a real {status:'ready',
  // at:<timestamp>} entry in status_history the moment the kitchen marks
  // it ready (see the Staff app's js/orders.js markReady()), so the
  // deadline is just that timestamp + the same COLLECTION_WINDOW_MINUTES
  // constant both apps share. Returns null for anything that was never
  // marked ready (or isn't a collection order at all).
  function collectionDeadline(order) {
    const isCollection = order.delivery_location && order.delivery_location.fulfilment === 'collection';
    if (!isCollection) return null;
    // Set by the server (track_collection_window, supabase/missed_collection.sql)
    // — the real ready time + window, or a rescheduled time + window.
    if (order.collection_deadline) return new Date(order.collection_deadline).getTime();
    const entry = (order.status_history || []).slice().reverse().find(h => h.status === 'ready');
    if (!entry) return null;
    return new Date(entry.at).getTime() + App.CONST.COLLECTION_WINDOW_MINUTES * 60000;
  }

  function formatCountdown(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const mm = Math.floor(totalSec / 60);
    const ss = String(totalSec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  // Ticks the countdown's own text once a second via a direct DOM update
  // (never App.render() — replacing the whole page every second for a
  // clock digit is exactly the kind of unnecessary re-render this app's
  // other screens were already fixed to avoid). The one moment this
  // needs a real render is when time actually runs out, since the card
  // switches to a different message/tone at that point.
  let collectionTickInterval = null;
  function startCollectionCountdown(deadline) {
    stopCollectionCountdown();
    collectionTickInterval = setInterval(() => {
      const el = document.getElementById('collection-countdown-value');
      if (!el || S.state.route.view !== 'track') { stopCollectionCountdown(); return; }
      const msLeft = deadline - Date.now();
      if (msLeft <= 0) { App.render(); return; }
      el.textContent = formatCountdown(msLeft);
    }, 1000);
  }
  function stopCollectionCountdown() {
    if (collectionTickInterval) { clearInterval(collectionTickInterval); collectionTickInterval = null; }
  }

  function renderCollectionCard(order, store) {
    const isCollection = order.delivery_location && order.delivery_location.fulfilment === 'collection';
    if (!isCollection) return '';
    if (order.status === 'uncollected') {
      stopCollectionCountdown();
      return `<div class="card card-pad mt-3" style="text-align:center;">
        <div class="icon-wrap" style="background:rgba(239,68,68,0.12);color:var(--color-error);margin:0 auto 10px;"><i data-lucide="clock"></i></div>
        <h3 class="font-bold">Not collected</h3><p class="text-sm text-muted">This order wasn't collected in time and has been closed.</p>
      </div>`;
    }
    if (order.status === 'preparing' && order.needs_reprep) {
      return `<div class="card card-pad mt-3" style="text-align:center;">
        <div class="icon-wrap" style="background:rgba(255,107,0,0.12);color:var(--color-primary);margin:0 auto 10px;"><i data-lucide="chef-hat"></i></div>
        <h3 class="font-bold mb-1">Being prepared again</h3>
        <p class="text-sm text-muted">${order.rescheduled_for ? `Your new collection time is <strong>${U.escapeHtml(U.formatTime(order.rescheduled_for))}</strong>. ` : ''}We'll let you know when it's ready.</p>
      </div>`;
    }
    if (order.status === 'collected') {
      stopCollectionCountdown();
      return `<div class="card card-pad mt-3" style="text-align:center;">
        <div class="icon-wrap" style="background:rgba(34,197,94,0.14);color:var(--color-success);margin:0 auto 10px;"><i data-lucide="check-circle-2"></i></div>
        <h3 class="font-bold">Collected</h3><p class="text-sm text-muted">Enjoy your meal!</p>
      </div>`;
    }
    if (order.status !== 'ready' || !order.collection_token) return '';
    const directionsBtn = orderDirectionsButton(store);
    const deadline = collectionDeadline(order);
    const msLeft = deadline ? deadline - Date.now() : null;
    const awaitingAnswer = order.collection_state === 'expired';
    const expired = awaitingAnswer || (msLeft !== null && msLeft <= 0);
    if (deadline && !expired) startCollectionCountdown(deadline);
    return `<div class="card card-pad mt-3" style="text-align:center;">
      <div class="icon-wrap" style="background:rgba(255,107,0,0.12);color:var(--color-primary);margin:0 auto 10px;"><i data-lucide="package-check"></i></div>
      <h3 class="font-bold mb-1">Order Ready for Collection</h3>
      ${awaitingAnswer ? missedCollectionPrompt(order) : ''}
      ${!awaitingAnswer && order.collection_state === 'rescheduled' && order.rescheduled_for ? `<div class="text-sm mb-1">New collection time: <strong>${U.escapeHtml(U.formatTime(order.rescheduled_for))}</strong></div>` : ''}
      ${deadline && !awaitingAnswer ? (expired
        ? `<div class="text-sm mb-3" style="color:var(--color-error);font-weight:600;"><i data-lucide="alert-triangle" style="width:14px;height:14px;"></i> Your collection time has passed — please check with the shop, as your order may have been given to someone else.</div>`
        : `<div class="mb-3"><span class="text-sm text-muted">Collect within </span><span id="collection-countdown-value" class="font-bold" style="font-size:18px;color:var(--color-primary);">${formatCountdown(msLeft)}</span></div>`
      ) : ''}
      <p class="text-sm text-muted mb-3">Show this QR code (or the code below) to staff to collect your order.</p>
      <div style="display:flex;justify-content:center;margin-bottom:10px;">${collectionQR(order)}</div>
      <div class="font-bold" style="font-size:24px;letter-spacing:4px;">${U.escapeHtml(order.collection_code || '')}</div>
      ${store && store.address && store.address !== App.CONST.PLACEHOLDER_PICKUP_ADDRESS ? `
      <div class="divider" style="margin:14px 0;"></div>
      <div class="text-sm text-muted mb-1"><i data-lucide="map-pin" style="width:13px;height:13px;"></i> ${U.escapeHtml(store.address)}${store.campus_location ? `, ${U.escapeHtml(store.campus_location)} Campus` : ''}</div>
      <p class="text-sm font-semibold mb-2">Need help finding the shop?</p>
      ${directionsBtn}` : ''}
    </div>`;
  }

  // ---- Missed collection (server marks collection_state 'expired') ----
  function missedCollectionPrompt(order) {
    return `<div class="mb-3" style="text-align:left;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:var(--radius-md);padding:12px 14px;">
      <div class="text-sm font-semibold mb-2">Your collection time for order ${U.escapeHtml(order.order_number)} has passed and it hasn't been collected. Are you still going to collect your order?</div>
      <div class="flex gap-2" style="flex-wrap:wrap;">
        <button type="button" class="btn btn-primary btn-sm" data-action="missed-collect-yes" data-id="${order.id}">Yes, I'll still collect</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="missed-collect-no" data-id="${order.id}">No, I won't collect</button>
      </div>
    </div>`;
  }

  // Times every 15 minutes, from ~15 min from now, up to 4 hours ahead
  // (the server accepts up to 6 hours).
  function rescheduleSlots() {
    const out = [];
    const t = new Date(Date.now() + 15 * 60000);
    t.setSeconds(0, 0);
    t.setMinutes(Math.ceil(t.getMinutes() / 15) * 15);
    for (let i = 0; i < 16; i++) out.push(new Date(t.getTime() + i * 15 * 60000));
    return out;
  }

  function openRescheduleModal(orderId) {
    const order = S.state.orders.find(o => o.id === orderId);
    if (!order) return;
    const original = (order.delivery_location && order.delivery_location.collectionTime) || (order.original_ready_at ? U.formatTime(order.original_ready_at) : '');
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Reschedule collection</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <p class="text-sm text-muted mb-3">Your original collection time has passed. Please choose a new time to collect your order.</p>
        <div class="text-sm mb-3">Order <strong>${U.escapeHtml(order.order_number)}</strong>${original ? ` · original collection: ${U.escapeHtml(original)}` : ''}</div>
        <div class="field">
          <label for="rs-time">New collection time</label>
          <select class="select" id="rs-time">${rescheduleSlots().map(d => `<option value="${d.toISOString()}">${U.escapeHtml(U.formatTime(d.toISOString()))}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label for="rs-reason">Reason for missing your collection time (optional)</label>
          <textarea class="input" id="rs-reason" rows="3" maxlength="300" placeholder="Tell us why you couldn't collect your order..."></textarea>
        </div>
        <div class="modal-footer" style="padding:16px 0 0;">
          <button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button>
          <button type="button" class="btn btn-primary" data-action="missed-collect-confirm" data-id="${order.id}">Confirm new time</button>
        </div>
      </div>`);
  }

  async function confirmReschedule(orderId, btn) {
    const time = document.getElementById('rs-time')?.value;
    const reason = document.getElementById('rs-reason')?.value || '';
    if (!time) return;
    if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); }
    const { data, error } = await App.sb.rpc('respond_missed_collection', { p_order_id: orderId, p_will_collect: true, p_new_time: time, p_reason: reason });
    if (error) {
      if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); }
      App.Toast.error(friendlyRpcError(error));
      return;
    }
    S.upsertIn('orders', data);
    missedAnsweredAt = Date.now();
    App.Modal.close();
    App.Toast.success(`Your collection has been rescheduled for ${U.formatTime(data.rescheduled_for)}. Your order number remains ${data.order_number}.`);
  }

  function confirmWontCollect(orderId) {
    const order = S.state.orders.find(o => o.id === orderId);
    if (!order) return;
    const paidCard = order.payment_method === 'card' && order.payment_status === 'paid';
    App.Modal.confirm({
      title: "Won't collect this order?",
      message: `Order ${order.order_number} will be cancelled. ${paidCard ? "It was already prepared, so the payment can't be refunded." : "You won't be charged."}`,
      variant: 'danger', confirmLabel: 'Cancel order', cancelLabel: 'Go back',
      onConfirm: async () => {
        const { data, error } = await App.sb.rpc('respond_missed_collection', { p_order_id: orderId, p_will_collect: false });
        if (error) { App.Toast.error(friendlyRpcError(error)); return; }
        S.upsertIn('orders', data);
        missedAnsweredAt = Date.now();
        App.Toast.success(`Order ${data.order_number} has been cancelled.`);
      },
    });
  }

  function friendlyRpcError(error) {
    const m = String((error && error.message) || '');
    if (/already been collected|can no longer be rescheduled|cannot be rescheduled again|not waiting for a new collection time|within the next 6 hours/i.test(m)) return m;
    return "We couldn't update your order right now. Please try again.";
  }

  // Asks once per missed collection (per visit) wherever the student is in
  // the app; the order screen keeps the same question until it's answered.
  const missedAsked = new Set();
  let missedAnsweredAt = 0; // just answered one: don't pop straight up with another
  function checkMissedCollections() {
    if (!S.state.profile || S.state.profile.role !== 'customer' || App.Modal.getRoot()) return;
    if (Date.now() - missedAnsweredAt < 10 * 60 * 1000) return;
    const o = (S.state.orders || []).find(x => x.customer_id === S.state.profile.id && x.status === 'ready' && x.collection_state === 'expired' && !missedAsked.has(x.id + (x.collection_expired_at || '')));
    if (!o) return;
    missedAsked.add(o.id + (o.collection_expired_at || ''));
    App.Modal.open(`
      <div class="modal-body" style="padding:24px 22px 20px;">
        <h2 style="font-size:18px;font-weight:800;margin-bottom:8px;">Collection time passed</h2>
        <p class="text-sm mb-4">Your collection time for order <strong>${U.escapeHtml(o.order_number)}</strong> has passed and it hasn't been collected. Are you still going to collect your order?</p>
        <div class="flex gap-2" style="flex-wrap:wrap;">
          <button type="button" class="btn btn-primary" data-action="missed-collect-yes" data-id="${o.id}">Yes, I'll still collect</button>
          <button type="button" class="btn btn-secondary" data-action="missed-collect-no" data-id="${o.id}">No, I won't collect</button>
        </div>
      </div>`);
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
      ${renderCollectionCard(order, store)}
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
        // Paystack only QUEUES a refund at this point — it isn't instantly
        // complete, so this deliberately doesn't say "refunded" (past
        // tense). The order's payment status flips to 'refunded' only once
        // paystack-webhook gets Paystack's own refund.processed event.
        App.Toast.success(res.refundAmount > 0 ? `Order cancelled — ${U.money(res.refundAmount)} refund initiated, it can take a few days to reflect` : 'Order cancelled');
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
              <span class="badge ${isCompleted(o) ? 'badge-success' : (o.status === 'cancelled' || o.status === 'uncollected') ? 'badge-error' : 'badge-primary'}">${App.CONST.STATUS_LABELS[o.status]}</span>
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

  // How long after an order completes it's still worth interrupting the
  // customer to rate it. Without this, an old order that was simply never
  // rated (easy to forget) would pop the rating modal on every single
  // fresh app load forever — local.promptedReviews only guards against
  // re-prompting again within the SAME already-loaded session, it resets
  // on every reload/login. Recent orders are genuinely worth asking about;
  // one from weeks ago showing up out of nowhere just reads as a glitch.
  const REVIEW_PROMPT_WINDOW_MS = 72 * 60 * 60 * 1000;

  function completedAt(o) {
    const entry = (o.status_history || []).slice().reverse().find(h => h.status === o.status);
    return new Date((entry && entry.at) || o.updated_at || o.created_at).getTime();
  }

  // Each completed order is asked about ONCE, ever (per device) — whether
  // the student rates it or just closes the box. Remembered in
  // localStorage, not just memory: the old in-memory set reset on every
  // reload/login, so a dismissed prompt came back every time the app
  // opened. They can still rate later from My Orders ("Rate Order").
  function promptedStorageKey() { return 'cfe_review_prompted_' + S.state.profile.id; }
  function promptedOrders() {
    if (local.promptedReviewsFor !== S.state.profile.id) {
      let ids = [];
      try { ids = JSON.parse(localStorage.getItem(promptedStorageKey()) || '[]'); } catch (e) { ids = []; }
      local.promptedReviews = new Set(ids);
      local.promptedReviewsFor = S.state.profile.id;
    }
    return local.promptedReviews;
  }
  function rememberPrompted(orderId) {
    const set = promptedOrders();
    set.add(orderId);
    try { localStorage.setItem(promptedStorageKey(), JSON.stringify([...set].slice(-200))); } catch (e) {}
  }

  function checkForReviewPrompt() {
    if (!S.state.profile || S.state.profile.role !== 'customer') return;
    // Only once BOTH orders and reviews have loaded for this user —
    // otherwise an already-rated order looks unrated for a moment after
    // sign-in and the prompt fires for it.
    if (S.state.privateDataFor !== S.state.profile.id) return;
    if (App.Modal.isOpen()) return;
    const cutoff = Date.now() - REVIEW_PROMPT_WINDOW_MS;
    const prompted = promptedOrders();
    const toReview = S.state.orders.find(o =>
      isCompleted(o) && !App.Reviews.hasReviewed(o.id) && !prompted.has(o.id) && completedAt(o) >= cutoff
    );
    if (toReview) { rememberPrompted(toReview.id); App.Shared.openReviewModal(toReview); }
  }

  // ---------------- FAVORITES ----------------
  function favMenuCard(item) {
    const outOfStock = App.Menu.isOutOfStock(item);
    const store = App.Stores.getById(item.store_id);
    return `
    <div class="card card-hover menu-card" data-action="open-food" data-id="${item.id}">
      <div class="menu-card-img">
        <img src="${U.escapeHtml(item.image || '')}" alt="${U.escapeHtml(item.name)}" loading="lazy" onerror="this.onerror=null;this.src='icons/clickfud-icon-192.png';this.classList.add('img-fallback')">
        <button class="menu-fav-btn active" data-action="toggle-favorite" data-id="${item.id}" aria-label="Unfavorite"><i data-lucide="heart" style="fill:currentColor"></i></button>
        ${outOfStock ? `<div class="out-of-stock-overlay">Out of Stock</div>` : ''}
      </div>
      <div class="menu-card-body">
        <div class="menu-card-title-row"><span class="font-bold">${U.escapeHtml(item.name)}</span></div>
        <p class="menu-card-desc">${store ? U.escapeHtml(store.name) : ''}</p>
        <div class="menu-card-footer">
          <span class="price-tag">${U.money(U.menuItemPrice(item))}</span>
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
  function renderSavedCardsCard() {
    if (local.paymentMethods === null) { ensurePaymentMethodsLoaded(); }
    const methods = local.paymentMethods || [];
    return `
    <div class="card card-pad mt-3">
      <h3 class="font-bold mb-3">Saved Cards</h3>
      ${methods.length ? methods.map(m => `
        <div class="payment-option" style="cursor:default;">
          <i data-lucide="credit-card"></i>
          <div style="flex:1;">
            <strong>${cardLabel(m)}</strong>
            <div class="text-xs text-muted">${U.escapeHtml(m.bank || 'Saved card')}${m.exp_month && m.exp_year ? ` · Expires ${U.escapeHtml(m.exp_month)}/${U.escapeHtml(m.exp_year)}` : ''}${m.is_default ? ' · Default' : ''}</div>
          </div>
          <div class="flex gap-2">
            ${!m.is_default ? `<button type="button" class="btn btn-secondary btn-sm" data-action="set-default-payment-method" data-id="${m.id}">Set Default</button>` : ''}
            <button type="button" class="btn btn-secondary btn-sm" data-action="remove-payment-method" data-id="${m.id}"><i data-lucide="trash-2" style="width:14px;height:14px"></i></button>
          </div>
        </div>`).join('') : `<p class="text-sm text-muted">No saved cards yet — a card is saved automatically the first time you pay online and Paystack reports it as reusable.</p>`}
    </div>`;
  }

  async function setDefaultPaymentMethodAction(id) {
    const res = await App.Payments.setDefaultPaymentMethod(id);
    if (res.error) { App.Toast.error(res.error); return; }
    await refreshPaymentMethods();
  }

  function removePaymentMethod(id) {
    const method = (local.paymentMethods || []).find(m => m.id === id);
    App.Modal.confirm({
      title: 'Remove this card?',
      message: method ? `${cardLabel(method)} will be removed from your saved cards. This cannot be undone.` : 'This card will be removed from your saved cards.',
      variant: 'danger', confirmLabel: 'Remove Card', cancelLabel: 'Keep Card',
      onConfirm: async () => {
        const res = await App.Payments.deletePaymentMethod(id);
        if (res.error) { App.Toast.error(res.error); return; }
        App.Toast.success('Card removed.');
        await refreshPaymentMethods();
      },
    });
  }

  function renderProfile() {
    const p = S.state.profile;
    const loc = p.default_location || {};
    return `
    <div class="page-wrap" style="max-width:560px;">
      <h1 class="page-title mb-4">My Profile</h1>
      <button type="button" class="card card-pad mb-3" style="text-align:left;width:100%;cursor:pointer;display:flex;align-items:center;gap:12px;" data-action="navigate" data-view="orientation">
        <div style="width:44px;height:44px;flex-shrink:0;border-radius:50%;background:var(--bg-surface-2);display:flex;align-items:center;justify-content:center;color:var(--color-primary);"><i data-lucide="compass"></i></div>
        <div style="flex:1;">
          <div class="font-bold">My Orientation</div>
          <div class="text-sm text-muted">Find your way around your UP campus</div>
        </div>
        <i data-lucide="chevron-right" style="color:var(--text-muted);"></i>
      </button>
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
          <div class="field">
            <label>My Campus(es)</label>
            <div class="text-xs text-muted mb-2">Shops at these campuses show first on your home page.</div>
            ${App.Shared.campusCheckboxes({ group: 'profile', university: p.university || App.CONST.UNIVERSITIES[0], initial: App.Auth.campusesOf(p) })}
          </div>
          <div class="field"><label>Residence Name <span class="text-muted" style="font-weight:400;">(optional)</span></label><input class="input" name="residence" value="${U.escapeHtml(loc.residence || '')}" placeholder="e.g. Residence A" /></div>
          <div class="field"><label>Street</label><input class="input" name="street" value="${U.escapeHtml(loc.street || '')}" placeholder="e.g. Kirkness Street" /></div>
          <button type="submit" class="btn btn-primary btn-block">Save Changes</button>
        </form>
      </div>
      ${renderSavedCardsCard()}
    </div>`;
  }

  // ---------------- Router / dispatch ----------------
  // Screens whose real content is live server data — while offline they
  // still open (showing whatever was already loaded), with a plain note
  // about what needs a connection. Browsing shops/menus needs none.
  const OFFLINE_NOTES = {
    track: 'Live order tracking needs internet — the status shown may be out of date.',
    confirmation: 'Live order status needs internet — the status shown may be out of date.',
    'confirmation-multi': 'Live order status needs internet — the status shown may be out of date.',
    orders: 'Your orders need internet to update.',
    profile: 'Account changes and payment methods need internet.',
    timetable: 'Showing your saved timetable. Adding or editing classes needs internet.',
  };

  function render() {
    setTimeout(checkMissedCollections, 0);
    const note = !S.state.connection.online && OFFLINE_NOTES[S.state.route.view];
    const html = renderView();
    return note ? `<div class="offline-note offline-note-page"><i data-lucide="wifi-off"></i><span>${U.escapeHtml(note)}</span></div>${html}` : html;
  }

  function renderView() {
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
      case 'orientation': return App.Pages.Orientation.render();
      case 'timetable': return App.Pages.Timetable.render();
      case 'more': return renderMorePage();
      default: return renderHome();
    }
  }

  function handleAction(action, ds, el) {
    if (STOREFRONT_ACTIONS.has(action)) return App.Pages.Home.handleAction(action, ds);
    if (action.indexOf('orientation-') === 0) return App.Pages.Orientation.handleAction(action, ds);
    if (action.indexOf('timetable-') === 0) return App.Pages.Timetable.handleAction(action, ds);
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
      case 'missed-collect-yes': App.Slideover.close(); App.Modal.close(); return openRescheduleModal(ds.id);
      case 'missed-collect-no': App.Slideover.close(); App.Modal.close(); return confirmWontCollect(ds.id);
      case 'missed-collect-confirm': return confirmReschedule(ds.id, el);
      case 'open-unfinished-checkout': return resumeUnfinishedCheckout();
      case 'resume-payment': return App.continueUnfinishedPayment && App.continueUnfinishedPayment();
      case 'cancel-unfinished-payment': return App.cancelUnfinishedPayment && App.cancelUnfinishedPayment();
      case 'go-checkout': App.Slideover.close(); return startCheckout();
      case 'checkout-next': return checkoutNext();
      case 'checkout-back': syncCheckoutFields(); return checkoutBack();
      case 'select-zone': return selectZone(ds.id);
      case 'select-payment': return selectPayment(ds.method, ds.paymentMethodId);
      case 'remove-payment-method': return removePaymentMethod(ds.id);
      case 'set-default-payment-method': return setDefaultPaymentMethodAction(ds.id);
      case 'select-fulfilment': return selectFulfilment(ds.mode);
      case 'select-collection-time': return selectCollectionTime(ds.storeId, ds.time);
      case 'apply-promo': return applyPromo();
      case 'add-addon-to-cart': return addAddonToCart(ds.id);
      case 'addon-qty': return changeAddonQty(ds.id, ds.delta);
      case 'place-order': return placeOrder();
      case 'track-order':
        App.Modal.close();
        S.setRoute({ view: 'track', params: { orderId: ds.id } });
        return App.forceScrollTop();
      case 'view-receipt': {
        const order = S.state.orders.find(o => o.id === ds.id);
        if (order) App.Shared.openReceiptModal(order);
        return;
      }
      case 'cancel-order': return cancelOrderConfirm(ds.id);
      case 'order-directions': return getOrderDirections(ds.storeId);
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
    if (kind === 'orientation-search') return App.Pages.Orientation.handleInput(kind, value, ds);
    if (kind === 'nav-search') {
      App.Pages.Home.local.search = value;
      if (S.state.route.view !== 'home') S.setRoute({ view: 'home', params: {} });
      else App.render();
      return;
    }
    if (kind === 'update-instructions') { detailState.instructions = value; }
    if (kind === 'promo-input' && local.checkout) local.checkout.promoInput = value; // kept across re-renders
  }
  function kb(bytes) { return bytes ? (bytes / 1024).toFixed(0) + ' KB' : ''; }

  async function handleChange(kind, ds, value, el) {
    if (STOREFRONT_CHANGES.has(kind)) return App.Pages.Home.handleChange(kind, ds, value);
    if (kind.indexOf('timetable-') === 0) return App.Pages.Timetable.handleChange(kind, ds, value, el);
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
    if (formId === 'timetable-form') return App.Pages.Timetable.handleSubmit(formId, data);
    if (formId === 'profile-form') {
      // University + at least one campus stay mandatory here too — emptying
      // them would just send the student straight back to campus setup.
      const campuses = App.Shared.selectedCampuses('profile');
      if (!data.get('university')) { App.Toast.error('Please choose your university.'); return; }
      if (!campuses.length) { App.Toast.error('Please tick at least one campus you attend.'); return; }
      const res = await App.Auth.updateProfile({
        name: data.get('name'), phone: data.get('phone'), avatar_url: data.get('avatar_url'),
        university: data.get('university'), campuses,
        default_location: { residence: data.get('residence'), street: data.get('street') },
      });
      if (res.error) App.Toast.error(res.error);
      else { App.Shared.resetCampusSelection('profile'); App.Toast.success('Profile updated'); App.render(); }
    }
  }

  return {
    render, handleAction, handleInput, handleChange, handleSubmit,
    checkForReviewPrompt, local, resumeUnfinishedCheckout, placeOrder,
  };
})();
