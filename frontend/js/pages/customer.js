/* ============================================================
   CLICKFOOD, Customer dashboard: browsing delegates to
   App.Pages.Home (shared with logged-out visitors); this module
   owns food detail, checkout, confirmation, tracking, history,
   favorites, and profile, everything that needs an authenticated
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
    'use-my-location', 'explore-university-reset', 'campus-pick', 'order-mode', 'hero-scroll-location',
  ]);
  const STOREFRONT_INPUTS = new Set(['marketplace-search', 'store-search']);
  const STOREFRONT_CHANGES = new Set(['marketplace-location', 'marketplace-sort', 'explore-university']);

  const local = {
    checkout: null, promptedReviews: new Set(), promptedReviewsFor: null, awaitingPayment: null,
    userCoords: null, // cached once known this session — see ensureUserCoords()
    refunds: {}, // orderId -> { list, loading } (the student's own refund requests)
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

  // Cancelling on PayFast's page doesn't always come back as a fresh
  // redirect to cancel_url — clicking its own "Cancel"/back control (or
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
      App.Toast.error('Your payment was cancelled, your order was not placed.');
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
      ${App.Nav.backButton('home', 'solo')}
      <div class="flex items-center gap-3 mb-4">
        <div class="profile-avatar-lg">${p.avatar_url ? `<img src="${U.escapeHtml(p.avatar_url)}">` : U.escapeHtml(U.initials(p.name))}</div>
        <div>
          <div class="font-bold text-lg">${U.escapeHtml(p.name)}</div>
          <div class="text-muted text-sm">${U.escapeHtml(p.email)}</div>
        </div>
      </div>

      ${App.Seller.isSeller() ? moreMenuItem('store', 'My Shop', 'Products, orders and analytics', 'navigate', ' data-view="sell"') : moreMenuItem('chef-hat', 'Student Entrepreneur Programme', 'Apply to sell your food', 'ent-open')}
      ${(App.Orientation && App.Orientation.Institution && App.Orientation.Institution.available()) ? moreMenuItem('compass', 'My Orientation', 'Find your way around your campus', 'navigate', ' data-view="orientation"') : ''}
      ${moreMenuItem('calendar', 'My Timetable', 'Your classes, reminders and directions', 'navigate', ' data-view="timetable"')}
      ${App.Stores.recessBoxShown() ? moreMenuItem('package', 'RecessBox', 'Book campus storage', 'open-campusbox') : ''}

      <div class="divider" style="margin:16px 0;"></div>

      ${moreMenuItem(isDark ? 'sun' : 'moon', isDark ? 'Light Mode' : 'Dark Mode', null, 'toggle-theme')}
      ${moreMenuItem('user', 'Profile', 'Your details, payment methods and saved cards', 'go-profile')}
      ${moreMenuItem('settings', 'Settings', null, 'go-profile')}

      <div class="divider" style="margin:16px 0;"></div>

      ${moreMenuItem('shield', 'Privacy Policy', null, 'legal-open', ' data-id="privacy"')}
      ${moreMenuItem('file-text', 'Terms of Service', null, 'legal-open', ' data-id="terms"')}

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
    const ownItem = !!(S.state.profile && S.state.profile.store_id && S.state.profile.store_id === item.store_id && isStudentStore(item.store_id));
    App.Modal.open(`
      <div class="food-detail-media media">
        <img crossorigin="anonymous" class="food-detail-img" src="${U.escapeHtml(item.image || '')}" alt="${U.escapeHtml(item.name)}" style="cursor:zoom-in;" data-action="view-food-image" data-id="${item.id}" onerror="this.onerror=null;this.src='icons/clickfood-icon-192.png';this.classList.add('img-fallback')">
        <button class="modal-close" data-action="close-modal" style="position:absolute;top:12px;right:12px;background:rgba(255,255,255,0.9);"><i data-lucide="x"></i></button>
      </div>
      <div class="modal-body" data-item-id="${item.id}">
        <div class="flex justify-between items-start gap-2">
          <h2 class="text-xl font-bold">${U.escapeHtml(item.name)}</h2>
          <button class="menu-fav-btn ${isFav ? 'active' : ''}" style="position:static;" data-action="toggle-favorite" data-id="${item.id}"><i data-lucide="heart" style="${isFav ? 'fill:currentColor' : ''}"></i></button>
        </div>
        <div class="food-meta-row">
          <span class="badge badge-gray">${U.escapeHtml(item.category)}</span>
          <span class="badge ${outOfStock ? 'badge-error' : 'badge-success'}">${outOfStock ? U.escapeHtml(App.Menu.unavailableReason(item)) : 'Available'}</span>
          <span class="badge badge-gray"><i data-lucide="clock" style="width:11px;height:11px;"></i> ${item.preparation_time} min</span>
          <span class="badge badge-gray"><i data-lucide="star" style="width:11px;height:11px;fill:#FFC107;color:#FFC107;"></i> ${(item.rating || 0).toFixed(1)} (${item.rating_count || 0})</span>
        </div>
        <p class="text-sm text-muted mt-2">${U.escapeHtml(item.description || '')}</p>
        ${item.ingredients && item.ingredients.length ? `<div class="mt-3"><strong class="text-sm">Ingredients:</strong> <span class="text-sm text-muted">${item.ingredients.map(U.escapeHtml).join(', ')}</span></div>` : ''}
        ${item.allergens && item.allergens.length ? `<div class="mt-2"><strong class="text-sm">Allergens:</strong> <span class="text-sm text-muted">${item.allergens.map(U.escapeHtml).join(', ')}</span></div>` : ''}
        ${studentSellerBox(item)}

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
        <button class="btn btn-primary btn-block btn-lg" data-action="add-to-cart-detail" data-id="${item.id}" ${outOfStock || ownItem || App.Stores.inTestMode(item.store_id) ? 'disabled' : ''}>
          <i data-lucide="shopping-cart"></i> ${ownItem ? 'Your food' : App.Stores.inTestMode(item.store_id) ? 'Ordering opens soon' : outOfStock ? U.escapeHtml(App.Menu.unavailableReason(item)) : 'Add to Cart'}
        </button>
      </div>`, { size: 'lg' });
  }

  function isStudentStore(storeId) {
    const s = App.Stores.getById(storeId);
    return !!s && s.seller_kind === 'student';
  }

  // Student seller food: who sells it, WhatsApp, and that payment is
  // between buyer and seller (ClickFood takes no payment for it).
  function studentSellerBox(item) {
    const store = App.Stores.getById(item.store_id);
    if (!store || store.seller_kind !== 'student') return '';
    const own = S.state.profile && S.state.profile.store_id === store.id;
    return `
        <div class="seller-detail-box mt-3">
          <div class="flex items-center gap-2">
            <div class="seller-detail-logo media">${store.logo_url ? `<img crossorigin="anonymous" src="${U.escapeHtml(store.logo_url)}" alt="">` : '<i data-lucide="chef-hat"></i>'}</div>
            <div style="min-width:0;"><div class="text-xs text-muted">Sold by a student</div><div class="font-semibold">${U.escapeHtml(store.name)}</div>
            ${App.Stores.pickupLocation(store) ? `<div class="text-xs text-muted"><i data-lucide="map-pin" style="width:11px;height:11px;vertical-align:-1px;"></i> ${U.escapeHtml(App.Stores.pickupLocation(store))}${App.MapPicker.kmToShop(store) != null ? ' · ' + U.escapeHtml(App.MapPicker.distanceLabel(App.MapPicker.kmToShop(store))) : ''}</div>` : ''}</div>
            ${App.MapPicker.directionsUrl(store) ? `<a class="btn btn-secondary btn-sm" style="margin-left:auto;flex-shrink:0;" href="${U.escapeHtml(App.MapPicker.directionsUrl(store))}" target="_blank" rel="noopener"><i data-lucide="navigation"></i>Directions</a>` : ''}
          </div>
          <div class="text-xs text-muted mt-2">Pay the seller directly. ClickFood doesn't take payment for student food.</div>
        </div>`;
  }

  // ---------------- Change home address ----------------
  const addrEdit = { pin: null, saving: false };
  function openAddressModal() {
    const p = S.state.profile;
    addrEdit.pin = p.home_lat != null ? { lat: p.home_lat, lng: p.home_lng } : null;
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">${savedLocationTitle(p)}</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="address-form" novalidate>
          <div class="field"><label for="ad-text">Address</label><input class="input" id="ad-text" name="address" maxlength="160" value="${U.escapeHtml(p.home_address || '')}" placeholder="e.g. Tuks Village, Block C, Room 12" /></div>
          <div class="field"><label>Pin on the map</label><div id="addr-modal-map" class="map-picker"></div></div>
          <button type="submit" class="btn btn-primary btn-block btn-lg">Save address</button>
        </form>
      </div>`, { size: 'lg' });
    App.MapPicker.mount(document.getElementById('addr-modal-map'), addrEdit.pin, (pin, info) => { addrEdit.pin = pin; App.MapPicker.fillIfEmpty('ad-text', info); });
  }
  function savedLocationTitle(p) { return p && p.is_student ? 'Saved university-area location' : 'Saved ordering location'; }
  async function saveAddress(data, form) {
    if (addrEdit.saving) return;
    const text = U.sanitizeText(data.get('address') || '', 160);
    if (text.length < 5) return App.Toast.error('Please enter your address.');
    if (!addrEdit.pin) return App.Toast.error('Please put your address on the map.');
    addrEdit.saving = true;
    const btn = form.querySelector('button[type="submit"]'); if (btn) btn.classList.add('btn-loading');
    const p = S.state.profile;
    const res = await App.Auth.updateProfile({ home_address: text, home_lat: addrEdit.pin.lat, home_lng: addrEdit.pin.lng,
      default_location: Object.assign({}, p.default_location || {}, { residence: text }) });
    addrEdit.saving = false;
    if (btn) btn.classList.remove('btn-loading');
    if (res.error) return App.Toast.error(res.error);
    App.Modal.close();
    App.Toast.success('Location saved');
    App.render();
  }

  // ---------------- Delete account (Settings) ----------------
  function activeOrderCount() {
    return (S.state.orders || []).filter(o => ['received', 'preparing', 'ready', 'out_for_delivery'].includes(o.status)).length;
  }
  function deleteAccountModal() {
    const n = activeOrderCount();
    if (n) return App.Toast.error(`You have ${n} order${n === 1 ? '' : 's'} in progress. Wait until ${n === 1 ? 'it is' : 'they are'} completed or cancelled.`);
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Delete your account?</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="delete-account-form" novalidate>
          <p class="text-sm mb-3">Your login, profile, timetable and saved details will be deleted${App.Seller.isSeller() ? ', and your shop will be closed' : ''}. Past orders stay on record without your name.</p>
          <div class="field"><label>Why are you deleting your account? *</label>
            <div class="delete-reasons">${App.CONST.ACCOUNT_DELETION_REASONS.map(([k, l]) => `<label class="checkbox-row delete-reason"><input type="radio" name="reason" value="${k}" data-action-change="delete-reason" /> ${U.escapeHtml(l)}</label>`).join('')}</div>
          </div>
          <div class="field" id="del-details-wrap"><label for="del-details" id="del-details-label">Anything else you want to tell us? (optional)</label><textarea class="input" id="del-details" name="details" rows="2" maxlength="500"></textarea></div>
          <div class="field"><label for="del-confirm">Type DELETE to confirm</label><input class="input" id="del-confirm" name="confirm" autocomplete="off" autocapitalize="characters" /></div>
          <div class="modal-footer" style="padding:12px 0 0;"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-danger">Delete account</button></div>
        </form>
      </div>`);
  }
  let deleting = false;
  async function deleteAccount(data, form) {
    if (deleting) return;
    const reason = data.get('reason');
    const details = String(data.get('details') || '').trim();
    if (!reason) return App.Toast.error('Please tell us why you are deleting your account.');
    if (reason === 'other' && !details) return App.Toast.error('Please tell us a little more.');
    if (String(data.get('confirm') || '').trim().toUpperCase() !== 'DELETE') return App.Toast.error('Type DELETE to confirm.');
    deleting = true;
    const btn = form.querySelector('button[type="submit"]'); if (btn) btn.classList.add('btn-loading');
    const { error } = await App.sb.rpc('delete_my_account', { p_reason: reason, p_details: details || null });
    deleting = false;
    if (btn) btn.classList.remove('btn-loading');
    if (error) {
      const m = error.message || '';
      return App.Toast.error(/in progress|can't be deleted|tell us/.test(m) ? m : 'Could not delete your account. Please try again.');
    }
    App.Modal.close();
    try { localStorage.removeItem(App.CONST.LS_KEYS.CART + S.state.profile.id); } catch (e) {}
    await App.Auth.signOut().catch(() => {});
    S.set({ forceAuthView: false });
    App.Toast.success('Your account was deleted');
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
    if (App.Stores.inTestMode(store)) { App.Toast.info(App.Stores.testModeMessage(store)); return; }
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
    const testGroup = cartStoreGroups().find(g => App.Stores.inTestMode(g.store));
    if (testGroup) { App.Toast.error(App.Stores.testModeMessage(testGroup.store)); return; }
    const closedGroup = cartStoreGroups().find(g => g.store && (g.store.seller_kind === 'student' ? App.Stores.statusOf(g.store).state === 'paused' : !App.Stores.isOpenNow(g.store)));
    if (closedGroup) { App.Toast.error(App.Stores.closedMessage(closedGroup.store)); return; }
    // ordering distance (the server checks again when the order is saved)
    const far = cartStoreGroups().map(g => ({ g, el: App.Discovery.eligibility(g.store) })).find(x => !x.el.ok);
    if (far) {
      const max = App.Stores.maxOrderKm();
      App.Toast.error(far.el.reason === 'too_far' ? `${far.g.store.name} is ${far.el.km.toFixed(1)} km from your ${App.Discovery.orderMode() === 'current' ? 'current' : 'saved'} location. You can order from shops within ${max} km.`
        : far.el.reason === 'no_pin' ? `${far.g.store.name} hasn't set its location yet, so it can't take orders right now.`
        : 'Choose your ordering location first.');
      return;
    }
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
      phone: S.state.profile?.phone || '', paymentMethod: 'cod', studentNumber: S.state.profile?.student_number || '',
      fulfilment: carriedFulfilment, collectionTimes: {}, collectionDays: {}, notes: {},
      promoCode: '', promoResult: null, promoInput: '', promoError: null,
      placing: false,
      // the ordering location is fixed for this checkout (never switched silently)
      orderLocation: App.Discovery.orderLocationPayload(),
      orderLocationLabel: App.Discovery.orderMode() === 'current' ? 'Your current location' : ((S.state.profile && S.state.profile.is_student ? 'Saved university area' : 'Saved location') + (S.state.profile && S.state.profile.home_address ? ': ' + S.state.profile.home_address : '')),
    };
    S.setRoute({ view: 'checkout' });
    App.forceScrollTop();
  }

  // Earliest a store could realistically have an order ready — now plus
  // its own prep time — rounded up to the next half-hour mark, then
  // offered in 30-minute slots up to closing time, capped at 6 so the
  // picker stays a short, glanceable list instead of a long scrolling
  // row (prep time + opening hours still gate what's selectable, never
  // an arbitrary time).
  // ---- Student shops: pick a day the shop sells, then a time in its hours ----
  // All in South African time (+02:00, no daylight saving).
  const SA_OFFSET = '+02:00';
  function saDate(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  function studentDays(store) {
    const out = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() + i * 86400000);
      const ymd = saDate(d);
      const dow = new Date(ymd + 'T12:00:00' + SA_OFFSET).getUTCDay();
      if (!App.Stores.hoursOn(store, dow)) continue;
      if (studentTimes(store, ymd).length) out.push({ ymd, dow, i });
    }
    return out;
  }
  function studentTimes(store, ymd) {
    const dow = new Date(ymd + 'T12:00:00' + SA_OFFSET).getUTCDay();
    const h = App.Stores.hoursOn(store, dow);
    if (!h) return [];
    const m = (t) => { const [a, b] = String(t).split(':').map(Number); return a * 60 + b; };
    const open = m(h.open), close = m(h.close);
    const end = close > open ? close : 23 * 60 + 30; // all day / past midnight: until 23:30
    let start = open;
    if (ymd === saDate(new Date())) {
      const now = App.Stores.saNow().mins + (Number(store.prep_time_max) || 30);
      start = Math.max(open, Math.ceil(now / 30) * 30);
    } else {
      start = Math.ceil(open / 30) * 30;
    }
    const out = [];
    for (let t = start; t <= end; t += 30) {
      const hh = String(Math.floor(t / 60)).padStart(2, '0'), mm = String(t % 60).padStart(2, '0');
      out.push(new Date(ymd + 'T' + hh + ':' + mm + ':00' + SA_OFFSET));
    }
    return out;
  }
  function dayLabel(d) {
    if (d.i === 0) return 'Today';
    if (d.i === 1) return 'Tomorrow';
    return new Date(d.ymd + 'T12:00:00' + SA_OFFSET).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Johannesburg' });
  }
  function collectWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const day = saDate(d) === saDate(new Date()) ? 'Today' : saDate(d) === saDate(new Date(Date.now() + 86400000)) ? 'Tomorrow'
      : d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Johannesburg' });
    return day + ', ' + U.formatTime(iso);
  }
  function studentCollectionPicker(g, c) {
    const store = g.store;
    const days = studentDays(store);
    if (!days.length) return `<p class="text-sm mb-3" style="color:var(--color-error);">This seller has no collection times this week.</p>`;
    const day = c.collectionDays[g.storeId] && days.some(d => d.ymd === c.collectionDays[g.storeId]) ? c.collectionDays[g.storeId] : null;
    const chosen = c.collectionTimes[g.storeId] || '';
    return `
        <label class="text-sm font-semibold" style="display:block;margin-bottom:6px;">Collection day *</label>
        <div class="collection-time-grid mb-3">${days.map(d => `<button type="button" class="chip collection-time-chip ${day === d.ymd ? 'active' : ''}" data-action="select-collection-day" data-store-id="${U.escapeHtml(g.storeId)}" data-day="${d.ymd}" aria-pressed="${day === d.ymd}">${U.escapeHtml(dayLabel(d))}</button>`).join('')}</div>
        ${day ? `
        <label class="text-sm font-semibold" style="display:block;margin-bottom:6px;">Collection time *</label>
        <div class="collection-time-grid mb-3">${studentTimes(store, day).map(t => `<button type="button" class="chip collection-time-chip ${chosen === t.toISOString() ? 'active' : ''}" data-action="select-collection-time" data-store-id="${U.escapeHtml(g.storeId)}" data-time="${t.toISOString()}" aria-pressed="${chosen === t.toISOString()}">${U.formatTime(t.toISOString())}</button>`).join('')}</div>` : ''}`;
  }

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
    // Open all day (student sellers): midnight isn't a closing time.
    if (!store.weekly_hours && String(store.opening_time || '').slice(0, 5) === String(store.closing_time || '').slice(0, 5)) {
      closing = new Date(earliest.getTime() + 6 * 30 * 60000);
    }

    const slots = [];
    let t = new Date(earliest);
    while (t < closing && slots.length < 6) {
      slots.push(new Date(t));
      t = new Date(t.getTime() + 30 * 60000);
    }
    return slots;
  }

  // The student's number: from their profile, or from their UP email.
  // Checkout never asks for it.
  function accountStudentNumber() {
    const p = S.state.profile;
    return (p && (p.student_number || U.studentNumberFromEmail(p.email))) || '';
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
        ${g.items.map(i => `<div class="cart-summary-row line-with-thumb"><span class="line-main">${lineThumb(i.image, i.name)}<span>${i.qty}x ${U.escapeHtml(i.name)}${i.addons && i.addons.length ? ' (' + i.addons.map(a => U.escapeHtml(typeof a === 'string' ? a : a.name)).join(', ') + ')' : ''}</span></span><span>${U.money((i.price + (i.addonsTotal || 0)) * i.qty)}</span></div>`).join('')}
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

  // Small square picture for a checkout line. The whole picture always shows
  // (no zoom); a non-square photo sits on a blurred copy of itself instead of
  // empty bars (js/media.js, data-fit="art").
  function lineThumb(url, alt) {
    return url
      ? `<span class="line-thumb media" data-fit="art"><img crossorigin="anonymous" src="${U.escapeHtml(url)}" alt="${U.escapeHtml(alt || '')}" loading="lazy" onerror="this.onerror=null;this.src='icons/clickfood-icon-192.png';this.classList.add('img-fallback')" /></span>`
      : '<span class="line-thumb line-thumb-empty"><i data-lucide="utensils"></i></span>';
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
          return `<div class="cart-summary-row line-with-thumb">
            <span class="line-main">${lineThumb(a.image_url, a.name)}<span>${U.escapeHtml(a.name)} <span class="text-muted">(${U.money(a.price)})</span></span></span>
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
        if (store && store.seller_kind === 'student') {
          return `${groups.length > 1 ? `<div class="font-semibold text-sm mb-1">${storeGroupLabel(g)}</div>` : ''}
        <p class="text-sm text-muted mb-3">Collect from ${U.escapeHtml(store.name)}${App.Stores.pickupLocation(store) ? ', ' + U.escapeHtml(App.Stores.pickupLocation(store)) : ''}.</p>
        ${studentCollectionPicker(g, c)}
        <div class="field"><label for="ck-note-${U.escapeHtml(g.storeId)}">Special instructions for the seller</label><textarea class="input" id="ck-note-${U.escapeHtml(g.storeId)}" rows="2" maxlength="300" placeholder="Allergies, or anything you don't want added" data-action-input="checkout-note" data-store-id="${U.escapeHtml(g.storeId)}">${U.escapeHtml((c.notes || {})[g.storeId] || '')}</textarea></div>
        ${gi < groups.length - 1 ? '<div class="divider"></div>' : ''}`;
        }
        const slots = collectionSlots(store);
        const chosen = c.collectionTimes[g.storeId] || '';
        const points = App.Discovery.pickupPointsCached(g.storeId);
        if (points === null) App.Discovery.pickupPointsFor(cartStoreGroups().map(x => x.storeId)).then(() => App.render());
        if (points && points.length === 1) { c.pickupPoints = c.pickupPoints || {}; c.pickupPoints[g.storeId] = points[0].id; }
        const pickHtml = points && points.length ? `<div class="field"><label>Pickup point *</label>${points.length === 1
          ? `<div class="text-sm"><i data-lucide="package" style="width:13px;height:13px;"></i> ${U.escapeHtml(points[0].name)}${points[0].details ? ' · ' + U.escapeHtml(points[0].details) : ''}</div>`
          : `<select class="select" data-action-change="checkout-pickup" data-store-id="${U.escapeHtml(g.storeId)}"><option value="">Choose where to collect</option>${points.map(p => `<option value="${U.escapeHtml(p.id)}" ${(c.pickupPoints || {})[g.storeId] === p.id ? 'selected' : ''}>${U.escapeHtml(p.name)}${p.details ? ' · ' + U.escapeHtml(p.details) : ''}</option>`).join('')}</select>`}</div>` : '';
        return `
        ${groups.length > 1 ? `<div class="font-semibold text-sm mb-1">${storeGroupLabel(g)}</div>` : ''}
        <p class="text-sm text-muted mb-3">Collect your order directly from ${U.escapeHtml(store ? store.name : 'the store')} (${U.escapeHtml(store ? store.campus_location : '')}).</p>
        ${pickHtml}
        <label class="text-sm font-semibold" style="display:block;margin-bottom:6px;">Collection Time *</label>
        ${slots.length ? `
        <div class="collection-time-grid mb-3">
          ${slots.map(t => `<button type="button" class="chip collection-time-chip ${chosen === t.toISOString() ? 'active' : ''}" data-action="select-collection-time" data-store-id="${U.escapeHtml(g.storeId)}" data-time="${t.toISOString()}" aria-pressed="${chosen === t.toISOString() ? 'true' : 'false'}" aria-label="Collection time ${U.formatTime(t.toISOString())}">${U.formatTime(t.toISOString())}</button>`).join('')}
        </div>` : `<p class="text-sm mb-3" style="color:var(--color-error);">No collection times left today. Try again tomorrow.</p>`}
        ${gi < groups.length - 1 ? '<div class="divider"></div>' : ''}`;
      }).join('')}
      <div class="field"><label>Phone Number</label><input class="input" id="ck-phone" type="tel" value="${U.escapeHtml(c.phone)}" placeholder="071 234 5678" /></div>
    </div>`;
  }

  // Order number + collection code side by side: staff ask for both.
  function collectPair(order, hint) {
    return `<div class="collect-pair mb-3">
      <div class="collect-code-box"><div class="text-xs text-muted">Order number</div><div class="collect-order-no">${U.escapeHtml(order.order_number || '')}</div></div>
      <div class="collect-code-box"><div class="text-xs text-muted">Collection code</div><div class="collect-code">${U.escapeHtml(order.collection_code || '')}</div></div>
    </div><div class="text-xs text-muted mb-3" style="text-align:center;">${hint}</div>`;
  }

  function cartHasStudentFood() { return cartStoreGroups().some(g => isStudentStore(g.storeId)); }

  function renderCheckoutStep3() {
    const c = local.checkout;
    if (cartHasStudentFood()) {
      c.paymentMethod = 'cod';
      return `
    <div class="card card-pad">
      <h3 class="font-bold mb-3">Payment</h3>
      <div class="payment-option selected">
        <i data-lucide="hand-coins"></i><div><strong>Pay the seller directly</strong><div class="text-xs text-muted">Cash or transfer, agreed with the seller. ClickFood doesn't take this payment.</div></div>
      </div>
    </div>`;
    }
    const online = App.Stores.onlinePaymentsOn();
    if (!online) c.paymentMethod = 'cod';
    return `
    <div class="card card-pad">
      <h3 class="font-bold mb-3">Payment Method</h3>
      <div class="payment-option ${c.paymentMethod === 'cod' ? 'selected' : ''}" data-action="select-payment" data-method="cod">
        <i data-lucide="banknote"></i><div><strong>Cash ${c.fulfilment === 'delivery' ? 'on Delivery' : 'on Collection'}</strong><div class="text-xs text-muted">Pay when you ${c.fulfilment === 'delivery' ? 'receive your order' : 'collect your order'}</div></div>
      </div>
      ${online ? `<div class="payment-option ${c.paymentMethod === 'card' ? 'selected' : ''}" data-action="select-payment" data-method="card">
        <i data-lucide="credit-card"></i><div><strong>Pay Online</strong><div class="text-xs text-muted">Card, via PayFast</div></div>
      </div>` : ''}
      ${c.paymentMethod === 'card' ? `
      <div class="mt-3 text-sm text-muted" style="display:flex;gap:8px;align-items:flex-start;">
        <i data-lucide="lock" style="width:15px;height:15px;flex-shrink:0;margin-top:2px;color:var(--color-primary);"></i>
        <span>Pay securely on PayFast.</span>
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
        : `<div class="text-sm mb-2" id="ck-order-location"><strong>Ordering location:</strong> ${U.escapeHtml(c.orderLocationLabel || 'Saved location')}</div>` + groups.map(g => `${App.Stores.pickupLocation(g.store) ? `<div class="text-sm mb-1"><strong>Pickup address:</strong> ${U.escapeHtml(App.Stores.pickupLocation(g.store))}</div>` : ''}<div class="text-sm mb-2"><strong>Collect from ${storeGroupLabel(g)}:</strong> ${c.collectionTimes[g.storeId] ? (g.store && g.store.seller_kind === 'student' ? collectWhen(c.collectionTimes[g.storeId]) : U.formatTime(c.collectionTimes[g.storeId])) : '—'}</div>`).join('')}
      <div class="text-sm mb-2"><strong>Phone:</strong> ${U.escapeHtml(c.phone)}</div>
      <div class="text-sm mb-2"><strong>Payment:</strong> ${cartHasStudentFood() ? 'Pay the seller directly' : c.paymentMethod === 'cod' ? 'Cash' : 'Card (PayFast)'}</div>
      <div class="text-sm mb-3"><strong>Total:</strong> <span class="text-primary-c font-bold">${U.money(t.total)}</span></div>
      ${!S.state.connection.online ? `<div class="offline-note"><i data-lucide="wifi-off"></i><span>You're offline.</span></div>` : ''}
      <button class="btn btn-primary btn-block btn-lg ${c.placing ? 'btn-loading' : ''}" data-action="place-order" ${c.placing ? 'disabled aria-busy="true"' : ''}>${c.paymentMethod === 'card' ? (c.placing ? 'Opening PayFast…' : 'Pay ' + U.money(t.total)) : cartHasStudentFood() ? 'Send Order' : 'Place Order'}</button>
    </div>`;
  }

  // ---- Unfinished payment (left PayFast without paying) ----
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
    // Back from PayFast, but PayFast's confirmation hasn't reached us yet:
    // no "Continue payment" here, so nobody pays twice while it arrives.
    if (local.awaitingPayment === u.reference) {
      return `
    <div class="card card-pad mb-3" style="border:2px solid var(--color-primary);" role="status">
      <div class="flex items-center gap-2 mb-1"><span class="spinner-sm" aria-hidden="true"></span><strong>Confirming your payment</strong></div>
      <p class="text-sm text-muted mb-3">This can take a minute.</p>
      <button type="button" class="btn btn-secondary ${resuming ? 'btn-loading' : ''}" data-action="check-payment-now" ${resuming ? 'disabled' : ''}><i data-lucide="refresh-cw"></i>Check again</button>
    </div>`;
    }
    return `
    <div class="card card-pad mb-3" style="border:2px solid var(--color-primary);">
      <div class="flex items-center gap-2 mb-1"><i data-lucide="credit-card" style="width:18px;height:18px;color:var(--color-primary)"></i><strong>You didn't finish paying</strong></div>
      <p class="text-sm text-muted mb-3">Your order details are saved${u.total ? ` (${U.money(u.total)})` : ''}. Continue to finish paying on PayFast.</p>
      <div class="unfinished-pay-actions">
        <button type="button" class="btn btn-primary ${resuming ? 'btn-loading' : ''}" data-action="resume-payment" ${resuming ? 'disabled' : ''}><i data-lucide="lock"></i>Continue payment</button>
        <button type="button" class="btn btn-secondary" data-action="cancel-unfinished-payment" ${resuming ? 'disabled' : ''}>Cancel payment</button>
      </div>
    </div>`;
  }

  // The checkout's step and choices are kept for this tab, so a refresh (or a
  // dropped connection) brings the student back to the same step.
  const CHECKOUT_KEY = 'cf_checkout_v1';
  function saveCheckout(c) {
    try { sessionStorage.setItem(CHECKOUT_KEY, JSON.stringify({ userId: S.state.profile && S.state.profile.id, c: Object.assign({}, c, { placing: false, promoChecking: false }) })); } catch (e) {}
  }
  function restoreCheckout() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(CHECKOUT_KEY) || 'null');
      // the cart may not be loaded into memory yet right after a refresh: check the saved one
      const savedCart = S.state.profile ? JSON.parse(localStorage.getItem(App.CONST.LS_KEYS.CART + S.state.profile.id) || '[]') : [];
      if (saved && saved.c && S.state.profile && saved.userId === S.state.profile.id && (S.state.cart.length || savedCart.length)) { local.checkout = saved.c; return true; }
    } catch (e) {}
    return false;
  }

  function renderCheckout() {
    if (!local.checkout && !restoreCheckout()) { S.setRoute({ view: 'home' }); return renderHome(); }
    const c = local.checkout;
    saveCheckout(c);
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
        const noPoint = cartStoreGroups().find(g => { const pts = App.Discovery.pickupPointsCached(g.storeId); return pts && pts.length && !(c.pickupPoints || {})[g.storeId]; });
        if (noPoint) return `Please choose a pickup point for ${storeGroupLabel(noPoint)}.`;
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
    if ($('ck-student-number')) c.studentNumber = $('ck-student-number').value;
  }

  function selectZone(id) { local.checkout.zoneId = id; App.render(); }
  function selectPayment(method) {
    syncCheckoutFields();
    if (cartHasStudentFood() || !App.Stores.onlinePaymentsOn()) method = 'cod';
    local.checkout.paymentMethod = method === 'card' ? 'card' : 'cod';
    App.render();
  }
  function selectFulfilment(mode) { syncCheckoutFields(); local.checkout.fulfilment = mode; App.render(); }
  function selectCollectionTime(storeId, iso) { local.checkout.collectionTimes[storeId] = iso; App.render(); }
  function selectCollectionDay(storeId, ymd) {
    syncCheckoutFields();
    local.checkout.collectionDays[storeId] = ymd;
    delete local.checkout.collectionTimes[storeId];
    App.render();
  }

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
    if (!result.error && code && S.state.profile) {
      // the customer's own rules (verified student, per-customer limit, campus)
      c.promoChecking = true; App.render();
      const { data: mine } = await App.sb.rpc('check_my_promo', { p_code: code, p_subtotal: S.cartTotals ? S.cartTotals().subtotal : null });
      c.promoChecking = false;
      if (mine && mine.ok === false) {
        c.promoCode = ''; c.promoResult = null; c.promoError = mine.error;
        App.render();
        if (mine.needs_student) return App.StudentVerify.open({ onDone: () => applyPromo() });
        App.Toast.error(mine.error);
        return;
      }
    }
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
  // the chosen pickup point (checked again by the database on the order)
  function pickupFor(c, storeId) {
    const id = (c.pickupPoints || {})[storeId];
    const p = id && (App.Discovery.pickupPointsCached(storeId) || []).find(x => x.id === id);
    return p ? { pickupPointId: p.id, pickupPointName: p.name } : {};
  }

  function groupDeliveryLocation(c, g) {
    // studentNumber is only ever collected for cash orders (see
    // renderCheckoutStep3) — undefined for card, which keeps it out of the
    // stored delivery_location for those orders entirely.
    const own = accountStudentNumber() || c.studentNumber.trim();
    const studentNumber = c.paymentMethod === 'cod' && own ? own : undefined;
    return c.fulfilment === 'delivery'
      ? { campus: c.campus, building: '', zoneId: c.zoneId, room: c.room, instructions: c.instructions, phone: c.phone, fulfilment: 'delivery', studentNumber }
      : { building: g.store ? g.store.name : (g.storeName || ''), room: '', instructions: U.sanitizeText((c.notes || {})[g.storeId] || '', 300), phone: c.phone, fulfilment: 'collection', collectionTime: c.collectionTimes[g.storeId], studentNumber,
          ...(pickupFor(c, g.storeId)), orderLocation: c.orderLocation || { mode: 'saved' } };
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

    // ordering distance from the location chosen for THIS checkout (the database enforces it too)
    for (const g of cartStoreGroups()) {
      const { data: d, error: de } = await App.sb.rpc('check_my_order_distance', { p_store: g.storeId, p_loc: c.orderLocation || { mode: 'saved' } });
      if (!de && d && d.ok === false) { c.placing = false; App.Toast.error(d.error || 'You can\'t order from this shop from your location.'); App.render(); return; }
    }
    c.placing = false;
    const method = c.paymentMethod;
    // Same cart still waiting on an unfinished PayFast payment: finish
    // THAT one rather than starting a second payment for the same food.
    const unfinished = method === 'card' && App.Payments.getUnfinishedCheckout();
    if (unfinished && unfinished.cart === App.Payments.cartSignature(S.state.cart) && App.continueUnfinishedPayment) return App.continueUnfinishedPayment();
    if (method === 'card') return placeOrderOnline();
    return placeOrderCod();
  }

  // PayFast checkout: no order exists yet — the browser only ever sends
  // WHICH items were selected, never a price (create-payfast-payment
  // re-prices everything on the server). The customer pays on PayFast's
  // own page, and the order rows are only created once PayFast's
  // notification has been verified on the server (payfast-itn); js/app.js
  // handlePaymentReturn finds out when the browser comes back.
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
    // student leaves PayFast without paying they can pick up right here.
    const snapshot = JSON.parse(JSON.stringify(Object.assign({}, c, { placing: false, promoChecking: false, step: 4 })));
    const res = await App.Payments.startOnlineCheckout(payloadGroups, c.promoResult ? c.promoCode : null, { checkout: snapshot, total: cartTotals().total });
    if (res.error) {
      c.placing = false;
      App.Toast.error(res.error);
      App.render();
    }
    // On success, startOnlineCheckout() has started navigating to
    // PayFast. Usually this page goes away; but if PayFast opens
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
    App.Pages.Groups.afterCheckout();
    const order = S.state.orders.find(o => o.id === params.orderId);
    if (!order) return renderHome();
    const student = isStudentStore(order.store_id);
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
        <h1 class="page-title">${student ? 'Order Sent!' : 'Order Confirmed! 🎉'}</h1>
        <p class="text-muted mt-2">Your order <strong>${U.escapeHtml(order.order_number)}</strong> has been sent to ${student ? 'the seller' : 'the kitchen'}.</p>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px;text-align:left;margin-top:20px;">
          <div class="card card-pad"><div class="text-xs text-muted">Estimated Prep Time</div><div class="font-bold">${prepTime} min</div></div>
          <div class="card card-pad"><div class="text-xs text-muted">Payment Method</div><div class="font-bold">${student ? 'Pay seller directly' : order.payment_method === 'cod' ? 'Cash' : 'Card'}</div></div>
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

  // Student seller orders: no code or timer, payment and pickup are
  // arranged with the seller.
  // What the buyer's "Message the seller" says, based on where the order is.
  function sellerMessage(order) {
    const p = S.state.profile || {};
    const me = (p.name || '').trim() || 'a ClickFood customer';
    const hist = order.status_history || [];
    const at = (st) => { const h = hist.slice().reverse().find(x => x.status === st); return h ? h.at : null; };
    const when = (iso) => iso ? collectWhen(iso) : '';
    const num = order.order_number || '';
    const dl = order.delivery_location || {};
    const pickup = dl.collectionTime ? ' I chose ' + collectWhen(dl.collectionTime) + ' for collection.' : '';
    switch (order.status) {
      case 'received': return `Hi, I'm ${me}. I placed order ${num} on ClickFood at ${when(order.created_at)} and it hasn't been started yet. Can you confirm you received it?${pickup}`;
      case 'preparing': return `Hi, I'm ${me}. My order ${num} has been preparing since ${when(at('preparing') || order.updated_at)} and it isn't ready yet. How long will it take?`;
      case 'ready': return `Hi, I'm ${me}. My order ${num} is ready.${pickup} Where and when can I collect it?`;
      case 'collected': return `Hi, I'm ${me}. About my order ${num} that I collected: `;
      case 'cancelled': return `Hi, I'm ${me}. My order ${num} was cancelled. Can you tell me why?`;
      default: return `Hi, I'm ${me}. About my order ${num}: `;
    }
  }

  function studentOrderCard(order, store) {
    const STEP = {
      received: ['clock', 'Waiting for the seller to accept'],
      preparing: ['chef-hat', 'The seller is preparing your food'],
      ready: ['package-check', 'Ready. Arrange collection with the seller'],
      collected: ['check-circle-2', 'Completed. Enjoy your meal!'],
      cancelled: ['x-circle', 'Cancelled'],
    }[order.status] || ['receipt', ''];
    const active = ['received', 'preparing', 'ready'].includes(order.status);
    return `<div class="card card-pad mt-3 seller-detail-box" style="text-align:center;">
      <div class="icon-wrap" style="background:rgba(var(--color-primary-rgb),0.12);color:var(--color-primary);margin:0 auto 10px;"><i data-lucide="${STEP[0]}"></i></div>
      <h3 class="font-bold mb-1">${U.escapeHtml(STEP[1])}</h3>
      ${order.status === 'cancelled' && order.cancel_note ? `<p class="text-sm text-muted">${U.escapeHtml(order.cancel_note)}</p>` : ''}
      ${active && order.delivery_location && order.delivery_location.collectionTime ? `<p class="text-sm mb-1"><strong>Collect:</strong> ${U.escapeHtml(collectWhen(order.delivery_location.collectionTime))}</p>` : ''}
      ${order.delivery_location && order.delivery_location.instructions ? `<p class="text-sm mb-1"><strong>Your note:</strong> ${U.escapeHtml(order.delivery_location.instructions)}</p>` : ''}
      ${active ? `<p class="text-sm text-muted mb-2">Pay the seller directly: ${U.money(order.total)}</p>
      ${App.Stores.pickupLocation(store) ? `<div class="text-sm mb-2"><i data-lucide="map-pin" style="width:13px;height:13px;"></i> ${U.escapeHtml(App.Stores.pickupLocation(store))}</div>` : ''}
      ${order.status === 'ready' && order.collection_code ? collectPair(order, 'Show both to the seller when you collect.') : ''}
      <button type="button" class="btn btn-whatsapp btn-block" data-action="contact-seller" data-store-id="${store.id}" data-order-id="${order.id}"><i data-lucide="message-circle"></i>Message the seller</button>` : ''}
      ${order.status === 'collected' && !App.Reviews.hasReviewed(order.id) ? `<button type="button" class="btn btn-primary btn-block mt-2" data-action="rate-order" data-id="${order.id}"><i data-lucide="star"></i>Rate this order</button>` : ''}
    </div>`;
  }

  function renderCollectionCard(order, store) {
    if (store && store.seller_kind === 'student') return studentOrderCard(order, store);
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
        <div class="icon-wrap" style="background:rgba(var(--color-primary-rgb),0.12);color:var(--color-primary);margin:0 auto 10px;"><i data-lucide="chef-hat"></i></div>
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
      <div class="icon-wrap" style="background:rgba(var(--color-primary-rgb),0.12);color:var(--color-primary);margin:0 auto 10px;"><i data-lucide="package-check"></i></div>
      <h3 class="font-bold mb-1">Order Ready for Collection</h3>
      ${awaitingAnswer ? missedCollectionPrompt(order) : ''}
      ${!awaitingAnswer && order.collection_state === 'rescheduled' && order.rescheduled_for ? `<div class="text-sm mb-1">New collection time: <strong>${U.escapeHtml(U.formatTime(order.rescheduled_for))}</strong></div>` : ''}
      ${deadline && !awaitingAnswer ? (expired
        ? `<div class="text-sm mb-3" style="color:var(--color-error);font-weight:600;"><i data-lucide="alert-triangle" style="width:14px;height:14px;"></i> Collection time passed. Check with the shop.</div>`
        : `<div class="mb-3"><span class="text-sm text-muted">Collect within </span><span id="collection-countdown-value" class="font-bold" style="font-size:18px;color:var(--color-primary);">${formatCountdown(msLeft)}</span></div>`
      ) : ''}
      ${order.delivery_location && order.delivery_location.pickupPointName ? `<div class="text-sm mb-2"><i data-lucide="package" style="width:13px;height:13px;"></i> Collect at <strong>${U.escapeHtml(order.delivery_location.pickupPointName)}</strong></div>` : ''}
      ${collectPair(order, 'Show both, or the QR code below, when you collect.')}
      <div style="display:flex;justify-content:center;margin-bottom:10px;">${collectionQR(order)}</div>
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
      <div class="text-sm font-semibold mb-2">Order ${U.escapeHtml(order.order_number)} wasn't collected. Still coming?</div>
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
        <p class="text-sm text-muted mb-3">Pick a new collection time.</p>
        <div class="text-sm mb-3">Order <strong>${U.escapeHtml(order.order_number)}</strong>${original ? ` · original collection: ${U.escapeHtml(original)}` : ''}</div>
        <div class="field">
          <label for="rs-time">New collection time</label>
          <select class="select" id="rs-time">${rescheduleSlots().map(d => `<option value="${d.toISOString()}">${U.escapeHtml(U.formatTime(d.toISOString()))}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label for="rs-reason">Reason (optional)</label>
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
        <p class="text-sm mb-4">Order <strong>${U.escapeHtml(o.order_number)}</strong> wasn't collected. Still coming?</p>
        <div class="flex gap-2" style="flex-wrap:wrap;">
          <button type="button" class="btn btn-primary" data-action="missed-collect-yes" data-id="${o.id}">Yes, I'll still collect</button>
          <button type="button" class="btn btn-secondary" data-action="missed-collect-no" data-id="${o.id}">No, I won't collect</button>
        </div>
      </div>`);
  }

  // ---- Refunds (Phase 2) ----
  // A student can ask the shop for a refund on a finished order they paid
  // for. The shop's manager approves or rejects it; the database makes sure
  // an order can never be refunded for more than was paid.
  const REFUND_LABEL = { requested: 'Waiting for the shop', approved: 'Approved, being paid back', paid: 'Paid back', rejected: 'Not approved', failed: 'Problem paying back' };
  function loadMyRefunds(orderId) {
    const st = local.refunds[orderId] || (local.refunds[orderId] = { list: null, loading: false });
    if (st.loading || st.list) return st;
    st.loading = true;
    App.sb.from('refund_requests').select('id, amount, kind, reason, status, decision_note, created_at, paid_at').eq('order_id', orderId).order('created_at', { ascending: false })
      .then(({ data, error }) => { st.loading = false; st.list = error ? [] : (data || []); App.render(); });
    return st;
  }
  function canAskRefund(order) {
    const paidCard = order.payment_method === 'card' && ['paid', 'refunded'].includes(order.payment_status);
    const finished = ['collected', 'delivered', 'uncollected'].includes(order.status) || (order.payment_method === 'cod' && order.status === 'collected');
    return finished && (paidCard || (order.payment_method === 'cod' && ['collected', 'delivered'].includes(order.status)));
  }
  function renderRefundSection(order) {
    if (!canAskRefund(order) && !local.refunds[order.id]) return '';
    const st = loadMyRefunds(order.id);
    if (!st.list) return '';
    const open = st.list.some(r => ['requested', 'approved'].includes(r.status));
    const paidBack = st.list.filter(r => r.status === 'paid').reduce((n, r) => n + Number(r.amount), 0);
    const left = Number(order.total) - Number(order.refund_amount || 0) - paidBack - st.list.filter(r => r.status === 'approved').reduce((n, r) => n + Number(r.amount), 0);
    return `
    <div class="card card-pad mt-3">
      <h3 class="font-bold mb-2">Refund</h3>
      ${st.list.map(r => `<div class="text-sm mb-2"><strong>${U.money(r.amount)}</strong> · ${REFUND_LABEL[r.status] || r.status}${r.decision_note && r.status === 'rejected' ? `<div class="text-xs text-muted">The shop said: ${U.escapeHtml(r.decision_note)}</div>` : ''}</div>`).join('')}
      ${canAskRefund(order) && !open && left > 0.004
        ? `<button class="btn btn-secondary btn-sm" data-action="ask-refund" data-id="${order.id}"><i data-lucide="rotate-ccw"></i>Ask for a refund</button>`
        : (!st.list.length ? '<p class="text-sm text-muted">No refund requested.</p>' : '')}
    </div>`;
  }
  function askRefundModal(order) {
    const st = local.refunds[order.id] || { list: [] };
    const used = (st.list || []).filter(r => ['approved', 'paid'].includes(r.status)).reduce((n, r) => n + Number(r.amount), 0);
    const max = Math.max(0, Number(order.total) - Number(order.refund_amount || 0) - used);
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Ask for a refund</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="ask-refund-form" data-order-id="${order.id}">
          <p class="text-sm mb-3">Order ${U.escapeHtml(order.order_number)}</p>
          <div class="field"><label>How much (R)</label><input class="input" name="amount" type="number" step="0.01" min="0.01" max="${max.toFixed(2)}" value="${max.toFixed(2)}" required />
            <p class="text-xs text-muted mt-1">Up to ${U.money(max)}</p></div>
          <div class="field"><label>What went wrong?</label><textarea class="input" name="reason" rows="3" maxlength="300" required placeholder="e.g. My kota was missing the chips"></textarea></div>
          <div class="modal-footer" style="padding:16px 0 0;"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Send request</button></div>
        </form>
      </div>`);
  }

  function renderTracking(params) {
    const order = S.state.orders.find(o => o.id === params.orderId);
    if (!order) return `<div class="page-wrap"><div class="empty-state"><h3>Order not found</h3></div></div>`;
    const store = App.Stores.getById(order.store_id);
    return `
    <div class="page-wrap" style="max-width:640px;">
      ${App.Nav.pageHead('Track Order', 'orders', `<span class="badge badge-primary">${U.escapeHtml(order.order_number)}</span>`)}
      ${store ? `<p class="text-sm text-muted mb-2">${U.escapeHtml(store.name)}</p>` : ''}
      <div class="card card-pad">${App.Shared.renderTracker(order)}</div>
      ${renderCollectionCard(order, store)}
      ${renderRefundSection(order)}
      <div class="flex gap-2 mt-3">
        <button class="btn btn-secondary" data-action="view-receipt" data-id="${order.id}"><i data-lucide="receipt"></i>Receipt</button>
        ${App.Orders.canCancel(order) ? `<button class="btn btn-danger" data-action="cancel-order" data-id="${order.id}"><i data-lucide="ban"></i>Cancel Order</button>` : ''}
        <button class="btn btn-ghost" data-action="go-home">Back to Stores</button>
      </div>
    </div>`;
  }

  // A paid "card" order shows the customer exactly what they'll get back
  // before they confirm — the actual fee/refund is always recomputed
  // authoritatively server-side (payfast-cancel-order), this is purely
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
      message = `You paid ${U.money(order.total)} for this order. A ${feePct}% cancellation fee (${U.money(feeAmount)}) applies, ${U.money(refundAmount)} will be refunded to your original payment method. This cannot be undone.`;
    }
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Cancel this order?</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="cancel-order-form" data-id="${U.escapeHtml(order.id)}" novalidate>
          <p class="text-sm mb-3">${U.escapeHtml(message)}</p>
          <div class="field"><label>Why are you cancelling? *</label>
            <div class="delete-reasons">${App.CONST.ORDER_CANCEL_REASONS.map(([k, l]) => `<label class="checkbox-row delete-reason"><input type="radio" name="reason" value="${k}" /> ${U.escapeHtml(l)}</label>`).join('')}</div>
          </div>
          <div class="field"><label for="cancel-note">Anything else? (required for Other)</label><textarea class="input" id="cancel-note" name="note" rows="2" maxlength="200"></textarea></div>
          <div class="modal-footer" style="padding:12px 0 0;"><button type="button" class="btn btn-secondary" data-action="close-modal">Keep order</button><button type="submit" class="btn btn-danger">Cancel order</button></div>
        </form>
      </div>`);
  }
  let cancelling = false;
  async function submitCancelOrder(data, form) {
    if (cancelling) return;
    const order = S.state.orders.find(o => o.id === form.dataset.id);
    if (!order) return App.Modal.close();
    const reason = data.get('reason');
    const note = String(data.get('note') || '').trim();
    if (!reason) return App.Toast.error('Please tell us why you are cancelling.');
    if (reason === 'other' && !note) return App.Toast.error('Please tell us a little more.');
    cancelling = true;
    const btn = form.querySelector('button[type="submit"]'); if (btn) btn.classList.add('btn-loading');
    const res = await App.Orders.cancelOrder(order, reason, note);
    cancelling = false;
    if (btn) btn.classList.remove('btn-loading');
    if (res.error) { App.Toast.error(res.error); return; }
    App.Modal.close();
    // A refund can take a few days to reach the card, so this never
    // says "refunded" (past tense).
    App.Toast.success(res.refundAmount > 0 ? `Order cancelled. ${U.money(res.refundAmount)} will be refunded.` : 'Order cancelled');
  }

  // Collection orders (Phase 1's active path) terminate at 'collected';
  // delivery orders (dormant, historical only) terminate at 'delivered' —
  // both count as a completed, rateable order everywhere that matters.
  function isCompleted(o) { return o.status === 'delivered' || o.status === 'collected'; }

  // ---------------- ORDER HISTORY ----------------
  // ---------------- MY ORDERS: Orders / Transactions (spending, budget, receipts) ----------------
  const HISTORY_TABS = [['orders', 'Orders'], ['transactions', 'Transactions']];
  function historyTabs() {
    const t = local.historyTab && local.historyTab !== 'orders' ? 'transactions' : 'orders';
    return `<div class="filter-bar mb-3">${HISTORY_TABS.map(([k, l]) => `<button class="chip ${t === k ? 'active' : ''}" data-action="spend-tab" data-key="${k}">${l}</button>`).join('')}</div>`;
  }

  // Same rule as the shop's reports: a collected order, or a paid order that
  // was not collected. Cancelled and unpaid orders are never "spent".
  function isSpend(o) {
    return ['collected', 'delivered'].includes(o.status) || (o.status === 'uncollected' && o.payment_status === 'paid');
  }
  const saMonth = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }).slice(0, 7);
  function loadBudget() {
    const b = local.budget || (local.budget = { data: undefined, refunds: [], loading: false });
    if (b.loading || b.data !== undefined) return b;
    b.loading = true;
    Promise.all([
      App.sb.from('customer_budgets').select('*').eq('customer_id', S.state.profile.id).maybeSingle(),
      App.sb.from('refund_requests').select('order_id, amount, status').eq('status', 'paid'),
    ]).then(([bu, rf]) => {
      b.loading = false;
      b.error = bu.error ? 'Could not load your budget. Please try again.' : null;
      b.data = bu.error ? null : (bu.data || null);
      b.refunds = rf.error ? [] : (rf.data || []);
      App.render();
    });
    return b;
  }
  function spendByMonth() {
    const b = local.budget || { refunds: [] };
    const refundsByOrder = {};
    (b.refunds || []).forEach(r => { refundsByOrder[r.order_id] = (refundsByOrder[r.order_id] || 0) + Number(r.amount); });
    const months = {};
    S.state.orders.filter(isSpend).forEach(o => {
      const m = saMonth(o.created_at);
      const row = months[m] || (months[m] = { orders: 0, spent: 0 });
      row.orders += 1;
      row.spent += Number(o.total) - Number(o.refund_amount || 0) - (refundsByOrder[o.id] || 0);
    });
    return months;
  }

  function renderReceipts() {
    const orders = S.state.orders.filter(o => o.status !== 'cancelled' || o.payment_status === 'paid' || o.payment_status === 'refunded')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (!orders.length) return `<div class="empty-state"><div class="icon-wrap"><i data-lucide="receipt"></i></div><h3>No receipts yet</h3></div>`;
    return `<div class="card receipt-list" style="max-width:720px;">${orders.map(o => {
      const store = App.Stores.getById(o.store_id);
      return `<button type="button" class="receipt-list-row" data-action="view-receipt" data-id="${o.id}">
        <span><span class="font-semibold">${U.escapeHtml(o.order_number)}</span><span class="text-xs text-muted"> · ${store ? U.escapeHtml(store.name) : ''}</span>
          <div class="text-xs text-muted">${U.formatDateTime(o.created_at)} · ${o.payment_method === 'cod' ? 'Cash' : 'Card'}, ${U.escapeHtml(o.payment_status)}</div></span>
        <span class="font-semibold">${U.money(o.total)}</span></button>`;
    }).join('')}</div>
    `;
  }

  function renderSpending() {
    const b = loadBudget();
    const months = spendByMonth();
    const now = saMonth(new Date().toISOString());
    const cur = months[now] || { orders: 0, spent: 0 };
    const budget = b.data && b.data.monthly_budget ? Number(b.data.monthly_budget) : null;
    const pct = budget ? Math.min(100, Math.round(cur.spent / budget * 100)) : 0;
    const past = Object.keys(months).sort().reverse().slice(0, 6);
    const monthName = (k) => new Date(k + '-15T12:00:00Z').toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return `
    <div style="max-width:720px;">
      <div class="card card-pad mb-3">
        <div class="flex justify-between items-center mb-2"><h2 class="font-bold">This month</h2></div>
        <div class="spend-stats">
          <div><div class="text-xs text-muted">Orders</div><div class="spend-num">${cur.orders}</div></div>
          <div><div class="text-xs text-muted">Spent</div><div class="spend-num">${U.money(cur.spent)}</div></div>
          <div><div class="text-xs text-muted">Average order</div><div class="spend-num">${cur.orders ? U.money(cur.spent / cur.orders) : 'None yet'}</div></div>
        </div>
        
      </div>

      <div class="card card-pad mb-3">
        <h2 class="font-bold mb-2">Monthly food budget</h2>
        ${b.loading && b.data === undefined ? '<p class="text-sm text-muted">Loading…</p>' : b.error ? `<p class="text-sm mb-2">${U.escapeHtml(b.error)}</p><button class="btn btn-secondary btn-sm" data-action="spend-reload">Try again</button>` : `
        ${budget ? `
          <div class="flex justify-between text-sm mb-1"><span>${U.money(cur.spent)} of ${U.money(budget)}</span><span class="${cur.spent > budget ? 'text-error' : 'text-muted'}">${cur.spent > budget ? `${U.money(cur.spent - budget)} over` : `${U.money(budget - cur.spent)} left`}</span></div>
          <div class="budget-track" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span class="budget-fill ${pct >= 100 ? 'is-over' : pct >= 80 ? 'is-high' : ''}" style="width:${pct}%"></span></div>` : '<p class="text-sm text-muted mb-2">No budget set.</p>'}
        <form data-form="budget-form" class="mt-3">
          <div class="grp-inline-form">
            <input class="input" type="number" name="amount" min="50" max="100000" step="10" value="${budget || ''}" placeholder="e.g. 1500" aria-label="Monthly budget in rand" />
            <button type="submit" class="btn btn-primary">${budget ? 'Update' : 'Set budget'}</button>
          </div>
          <label class="checkbox-row mt-2"><input type="checkbox" name="alerts" ${!b.data || b.data.alerts_enabled ? 'checked' : ''} /> Tell me when I reach 50%, 80% and 100%</label>
        </form>
        ${budget ? '<button class="btn btn-ghost btn-sm mt-2" data-action="spend-clear-budget">Turn off budget</button>' : ''}
        `}
      </div>

      ${past.length ? `<div class="card card-pad">
        <h2 class="font-bold mb-2">Past months</h2>
        <table class="spend-table"><thead><tr><th>Month</th><th>Orders</th><th>Spent</th></tr></thead><tbody>
          ${past.map(k => `<tr><td>${monthName(k)}</td><td>${months[k].orders}</td><td>${U.money(months[k].spent)}</td></tr>`).join('')}
        </tbody></table>
      </div>` : ''}
    </div>`;
  }

  async function saveBudget(data) {
    const amount = Number(data.get('amount'));
    if (!amount || amount < 50 || amount > 100000) return App.Toast.error('Please enter a budget between R50 and R100 000.');
    const row = { customer_id: S.state.profile.id, monthly_budget: Math.round(amount * 100) / 100, alerts_enabled: data.get('alerts') === 'on', updated_at: new Date().toISOString() };
    const { data: saved, error } = await App.sb.from('customer_budgets').upsert(row).select().single();
    if (error) return App.Toast.error('Could not save your budget. Please try again.');
    local.budget.data = saved;
    App.Toast.success('Budget saved');
    App.render();
  }

  function handleSpendingAction(action, ds) {
    if (action === 'spend-tab') { local.historyTab = ds.key; return App.render(); }
    if (action === 'spend-open') { local.historyTab = ds.key; S.setRoute({ view: 'orders', params: {} }); return App.forceScrollTop(); }
    if (action === 'spend-reload') { local.budget = null; return App.render(); }
    if (action === 'spend-clear-budget') {
      return App.sb.from('customer_budgets').delete().eq('customer_id', S.state.profile.id).then(({ error }) => {
        if (error) return App.Toast.error('Could not turn it off. Please try again.');
        local.budget.data = null; App.Toast.success('Budget turned off'); App.render();
      });
    }
  }

  function renderHistory() {
    const tab = local.historyTab || 'orders';
    if (tab !== 'orders') {
      return `<div class="page-wrap"><h1 class="page-title mb-3">My Orders</h1>${historyTabs()}${renderSpending()}<h2 class="section-title mt-4 mb-2">Receipts</h2>${renderReceipts()}</div>`;
    }
    const orders = S.state.orders.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (!orders.length) {
      return `<div class="page-wrap"><h1 class="page-title mb-3">My Orders</h1>${historyTabs()}<div class="empty-state"><div class="icon-wrap"><i data-lucide="receipt"></i></div><h3>No orders yet</h3></div></div>`;
    }
    return `
    <div class="page-wrap">
      <h1 class="page-title mb-3">My Orders</h1>
      ${historyTabs()}
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
      <div class="menu-card-img media">
        <img crossorigin="anonymous" src="${U.escapeHtml(item.image || '')}" alt="${U.escapeHtml(item.name)}" loading="lazy" onerror="this.onerror=null;this.src='icons/clickfood-icon-192.png';this.classList.add('img-fallback')">
        <button class="menu-fav-btn active" data-action="toggle-favorite" data-id="${item.id}" aria-label="Unfavorite"><i data-lucide="heart" style="fill:currentColor"></i></button>
        ${outOfStock ? `<div class="out-of-stock-overlay">${U.escapeHtml(App.Menu.unavailableReason(item))}</div>` : ''}
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
      ${App.Nav.pageHead('My Favorites', 'more')}
      ${items.length ? `<div class="grid grid-menu">${items.map(favMenuCard).join('')}</div>` : `<div class="empty-state"><div class="icon-wrap"><i data-lucide="heart"></i></div><h3>No favorites yet</h3><p>Your favorite meals will appear here.</p></div>`}
    </div>`;
  }

  // ---------------- PROFILE ----------------
  function renderProfile() {
    const p = S.state.profile;
    const loc = p.default_location || {};
    return `
    <div class="page-wrap" style="max-width:560px;">
      ${App.Nav.previousView() === 'more' || App.Seller.isSeller() ? App.Nav.pageHead('My Profile', 'more') : '<h1 class="page-title mb-4">My Profile</h1>'}
      <button type="button" class="card card-pad mb-3" style="text-align:left;width:100%;cursor:pointer;display:flex;align-items:center;gap:12px;" data-action="change-address">
        <div style="width:44px;height:44px;flex-shrink:0;border-radius:50%;background:var(--bg-surface-2);display:flex;align-items:center;justify-content:center;color:var(--color-primary);"><i data-lucide="map-pin"></i></div>
        <div style="flex:1;min-width:0;">
          <div class="font-bold">${savedLocationTitle(p)}</div>
          <div class="text-sm text-muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${U.escapeHtml(p.home_address || 'Add your address')}</div>
        </div>
        <span class="text-sm font-semibold" style="color:var(--color-primary);">Change</span>
      </button>
      ${(App.Orientation && App.Orientation.Institution && App.Orientation.Institution.available()) ? `<button type="button" class="card card-pad mb-3" style="text-align:left;width:100%;cursor:pointer;display:flex;align-items:center;gap:12px;" data-action="navigate" data-view="orientation">
        <div style="width:44px;height:44px;flex-shrink:0;border-radius:50%;background:var(--bg-surface-2);display:flex;align-items:center;justify-content:center;color:var(--color-primary);"><i data-lucide="compass"></i></div>
        <div style="flex:1;">
          <div class="font-bold">My Orientation</div>
          <div class="text-sm text-muted">Find your way around your campus</div>
        </div>
        <i data-lucide="chevron-right" style="color:var(--text-muted);"></i>
      </button>` : ''}
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
                <input type="file" accept="image/*" hidden data-action-change="upload-avatar" />
              </label>
              <span class="image-upload-status text-xs text-muted"></span>
              <input type="hidden" name="avatar_url" value="${U.escapeHtml(p.avatar_url || '')}" />
            </div>
          </div>
          <div class="field"><label>Full Name</label><input class="input" name="name" value="${U.escapeHtml(p.name)}" /></div>
          <div class="field"><label>Phone</label><input class="input" name="phone" value="${U.escapeHtml(p.phone || '')}" /></div>
          ${(() => {
            const isStu = local.profileStudent !== undefined ? local.profileStudent === 'yes' : p.is_student !== false;
            const uniId = local.profileUni || p.home_university_id || '';
            const camps = App.Discovery.campuses().filter(c => c.university_id === uniId);
            const sv = App.StudentVerify.status();
            if (sv === null) App.StudentVerify.load().then(() => App.render());
            return `<div class="field"><label>Are you a student?</label>
              <div class="seg-choice">
                <label class="seg-opt"><input type="radio" name="is_student" value="yes" ${isStu ? 'checked' : ''} data-action-change="profile-student" /><span>Yes</span></label>
                <label class="seg-opt"><input type="radio" name="is_student" value="no" ${isStu ? '' : 'checked'} data-action-change="profile-student" /><span>No</span></label>
              </div></div>
            ${isStu ? `<div class="field"><label>University or college</label><select class="select" name="student_university" data-action-change="profile-university">
                <option value="">Choose your institution</option>${App.Discovery.selectableUniversities().map(u => `<option value="${U.escapeHtml(u.id)}" ${uniId === u.id ? 'selected' : ''}>${U.escapeHtml(u.name)}</option>`).join('')}</select></div>
              ${camps.length ? `<div class="field"><label>Campus</label><select class="select" name="student_campus"><option value="">Choose your campus</option>${camps.map(c => `<option value="${U.escapeHtml(c.id)}" ${p.campus_id === c.id ? 'selected' : ''}>${U.escapeHtml(c.full_name)}</option>`).join('')}</select></div>` : ''}
              <div class="field"><label>Student verification</label><div class="flex items-center gap-2" style="flex-wrap:wrap;">${sv === 'verified' ? '<span class="badge badge-success"><i data-lucide="badge-check" style="width:12px;height:12px;"></i> Verified student</span>'
                : sv === 'pending' ? '<span class="badge badge-yellow">Check your university email</span> <button type="button" class="link-btn" data-action="student-verify-open">Send again</button>'
                : sv === 'needs_review' ? '<span class="badge badge-yellow">Being checked by ClickFood</span>'
                : '<span class="text-sm text-muted">Not verified.</span> <button type="button" class="btn btn-secondary btn-sm" data-action="student-verify-open">Verify my student email</button>'}</div></div>` : ''}`;
          })()}
          ${(() => { const mc = App.Discovery.myCampus(); if (!mc) return ''; if (local.venuesFor !== mc.id) { local.venuesFor = mc.id; local.venues = null; App.sb.from('campus_venues').select('id, name, building_number').eq('campus_id', mc.id).order('name').limit(200).then(({ data }) => { local.venues = data || []; App.render(); }); }
            return (local.venues && local.venues.length) ? `<div class="field"><label>Preferred building (optional)</label><select class="select" name="preferred_venue_id"><option value="">None</option>${local.venues.map(v => `<option value="${U.escapeHtml(v.id)}" ${p.preferred_venue_id === v.id ? 'selected' : ''}>${U.escapeHtml(v.name)}${v.building_number ? ' (Building ' + U.escapeHtml(v.building_number) + ')' : ''}</option>`).join('')}</select></div>` : ''; })()}
          <button type="submit" class="btn btn-primary btn-block">Save Changes</button>
        </form>
      </div>
      <div class="card card-pad mt-3" id="notification-settings">
        <div class="font-bold mb-2">Notifications</div>
        ${notifToggle('in_app', 'In the app')}
        ${notifToggle('push', 'Phone alerts', App.Push && App.Push.blocked() ? 'Blocked in your browser settings' : (App.Push && !App.Push.supported() ? 'Add ClickFood to your home screen first' : ''))}
        ${notifToggle('email', 'Order emails')}
      </div>
      <div class="card card-pad mt-3 danger-card" id="delete-account">
        <div class="font-bold">Delete account</div>
        <div class="text-sm text-muted mb-2">Removes your login and personal details${App.Seller.isSeller() ? ' and closes your shop' : ''}. This can't be undone.</div>
        <button type="button" class="btn btn-danger btn-sm" data-action="delete-account"><i data-lucide="trash-2"></i>Delete my account</button>
      </div>
    </div>`;
  }

  function notifToggle(channel, label, hint) {
    const on = App.Notifications.prefOn(channel);
    return `<label class="checkbox-row mb-2"><input type="checkbox" data-action-change="notif-pref" data-channel="${channel}" ${on ? 'checked' : ''} /> <span>${label}${hint ? ` <span class="text-xs text-muted">(${U.escapeHtml(hint)})</span>` : ''}</span></label>`;
  }
  async function changeNotifPref(channel, on, el) {
    if (channel === 'push' && on) {
      const ok = App.Push ? await App.Push.subscribeIfPossible({ ask: true }) : false;
      if (!ok) {
        if (el) el.checked = false;
        App.Toast.error(App.Push && App.Push.blocked() ? 'Phone alerts are blocked in your browser settings.' : "Phone alerts aren't available on this device.");
        return;
      }
    }
    const r = await App.Notifications.setPref(channel, on);
    if (r.error) { if (el) el.checked = !on; return App.Toast.error(r.error); }
    App.Toast.success(on ? 'Turned on' : 'Turned off');
  }

  // ---------------- Router / dispatch ----------------
  // Screens whose real content is live server data — while offline they
  // still open (showing whatever was already loaded), with a plain note
  // about what needs a connection. Browsing shops/menus needs none.
  const OFFLINE_NOTES = {
    track: 'Live order tracking needs internet, the status shown may be out of date.',
    confirmation: 'Live order status needs internet, the status shown may be out of date.',
    'confirmation-multi': 'Live order status needs internet, the status shown may be out of date.',
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
      case 'campus-directory': return App.Pages.Directory.render();
      case 'orders': return renderHistory();
      case 'groups': case 'group-order': case 'food-list': return App.Pages.Groups.render(route.view, route.params || {});
      case 'campus': return App.Pages.Campus.render();
      case 'favorites': return renderFavorites();
      case 'profile': return renderProfile();
      case 'orientation': return App.Pages.Orientation.render();
      case 'timetable': return App.Pages.Timetable.render();
      case 'more': return renderMorePage();
      case 'legal': return App.Legal.render(route.params);
      case 'entrepreneur': return App.Pages.Entrepreneur.render();
      case 'market': case 'search': return App.Pages.Market.render();
      case 'sell': return App.Pages.Seller.render();
      default: return renderHome();
    }
  }

  function handleAction(action, ds, el) {
    if (STOREFRONT_ACTIONS.has(action)) return App.Pages.Home.handleAction(action, ds);
    if (action.indexOf('orientation-') === 0) return App.Pages.Orientation.handleAction(action, ds);
    if (action.indexOf('ent-') === 0) return App.Pages.Entrepreneur.handleAction(action, ds, el);
    if (action.indexOf('timetable-') === 0) return App.Pages.Timetable.handleAction(action, ds);
    if (action.indexOf('grp-') === 0) return App.Pages.Groups.handleAction(action, ds);
    if (action.indexOf('camp-') === 0) return App.Pages.Campus.handleAction(action, ds);
    if (action.indexOf('dir-') === 0) return App.Pages.Directory.handleAction(action, ds);
    if (action.indexOf('spend-') === 0) return handleSpendingAction(action, ds);
    if (action.indexOf('sell-') === 0) return App.Pages.Seller.handleAction(action, ds, el);
    if (action.indexOf('mkt-') === 0) return App.Pages.Market.handleAction(action, ds);
    if (action === 'change-address') return openAddressModal();
    if (action === 'delete-account') return deleteAccountModal();
    if (action === 'contact-seller') {
      const ord = ds.orderId && (S.state.orders || []).find(o => o.id === ds.orderId);
      return App.Seller.contactSeller(ds.storeId, S.state.menu.find(m => m.id === ds.id), ord ? sellerMessage(ord) : null);
    }
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
      case 'check-payment-now': return App.checkPaymentNow && App.checkPaymentNow();
      case 'go-checkout': App.Slideover.close(); return startCheckout();
      case 'checkout-next': return checkoutNext();
      case 'checkout-back': syncCheckoutFields(); return checkoutBack();
      case 'select-zone': return selectZone(ds.id);
      case 'select-payment': return selectPayment(ds.method);
      case 'select-fulfilment': return selectFulfilment(ds.mode);
      case 'select-collection-time': return selectCollectionTime(ds.storeId, ds.time);
      case 'select-collection-day': return selectCollectionDay(ds.storeId, ds.day);
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
      case 'ask-refund': { const o = S.state.orders.find(x => x.id === ds.id); if (o) askRefundModal(o); return; }
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
    if (kind.indexOf('ent-') === 0) return App.Pages.Entrepreneur.handleInput(kind, value, ds);
    if (kind === 'mkt-search') return App.Pages.Market.handleInput(kind, value);
    if (kind.indexOf('dir-') === 0) return App.Pages.Directory.handleInput(kind, value, ds);
    if (kind.indexOf('sell-') === 0) return App.Pages.Seller.handleInput(kind, value, ds);
    if (kind === 'nav-search') {
      App.Pages.Home.local.search = value;
      if (S.state.route.view !== 'home') S.setRoute({ view: 'home', params: {} });
      else App.render();
      return;
    }
    if (kind === 'update-instructions') { detailState.instructions = value; }
    if (kind === 'checkout-note' && local.checkout) { local.checkout.notes = local.checkout.notes || {}; local.checkout.notes[ds.storeId] = value; }
    if (kind === 'promo-input' && local.checkout) local.checkout.promoInput = value; // kept across re-renders
  }
  function kb(bytes) { return bytes ? (bytes / 1024).toFixed(0) + ' KB' : ''; }

  async function handleChange(kind, ds, value, el) {
    if (kind === 'notif-pref') return changeNotifPref(ds.channel, !!(el && el.checked), el);
    if (STOREFRONT_CHANGES.has(kind)) return App.Pages.Home.handleChange(kind, ds, value);
    if (kind.indexOf('timetable-') === 0) return App.Pages.Timetable.handleChange(kind, ds, value, el);
    if (kind.indexOf('dir-') === 0) return App.Pages.Directory.handleChange(kind, ds, value);
    if (kind.indexOf('ent-') === 0) return App.Pages.Entrepreneur.handleChange(kind, ds, value);
    if (kind === 'profile-student') { local.profileStudent = value; return App.render(); }
    if (kind === 'profile-university') { local.profileUni = value; return App.render(); }
    if (kind === 'checkout-pickup' && local.checkout) { local.checkout.pickupPoints = local.checkout.pickupPoints || {}; local.checkout.pickupPoints[ds.storeId] = value; return; }
    if (kind.indexOf('sell-') === 0) return App.Pages.Seller.handleChange(kind, ds, value, el);
    if (kind === 'toggle-extra') { detailState.extras[ds.key] = !detailState.extras[ds.key]; refreshDetailModal(); return; }
    if (kind === 'upload-avatar') return handleAvatarUpload(value, el);
    if (kind === 'delete-reason') {
      const lbl = document.getElementById('del-details-label');
      if (lbl) lbl.textContent = el.value === 'other' ? 'Tell us why *' : 'Anything else you want to tell us? (optional)';
      return;
    }
  }

  function handleAvatarUpload(file, el) {
    const hidden = el.closest('.image-upload').querySelector('input[type="hidden"][name="avatar_url"]');
    return App.Upload.uploadIntoBox(file, el, { kind: 'avatar' }, (url) => { if (hidden) hidden.value = url; });
  }


  async function handleSubmit(formId, data, form) {
    if (formId.indexOf('grp-') === 0) return App.Pages.Groups.handleSubmit(formId, data, form);
    if (formId.indexOf('sell-') === 0) return App.Pages.Seller.handleSubmit(formId, data, form);
    if (formId === 'ent-form') return App.Pages.Entrepreneur.handleSubmit(formId);
    if (formId === 'address-form') return saveAddress(data, form);
    if (formId === 'cancel-order-form') return submitCancelOrder(data, form);
    if (formId === 'delete-account-form') return deleteAccount(data, form);
    if (formId === 'budget-form') return saveBudget(data);
    if (formId === 'ask-refund-form') {
      const orderId = form.dataset.orderId;
      const reason = (data.get('reason') || '').trim();
      if (reason.length < 3) return App.Toast.error('Please tell the shop what went wrong.');
      const { error } = await App.sb.rpc('request_refund', { p_order_id: orderId, p_amount: Number(data.get('amount')), p_reason: reason });
      if (error) {
        const m = error.message || '';
        return App.Toast.error(/violates|permission|function|JWT|fetch/i.test(m) || !m ? 'Could not send your request. Please try again.' : m);
      }
      App.Modal.close();
      App.Toast.success('Refund request sent to the shop');
      delete local.refunds[orderId];
      return App.render();
    }
    if (formId === 'timetable-form') return App.Pages.Timetable.handleSubmit(formId, data);
    if (formId === 'profile-form') {
      if (App.Upload.busy()) return App.Toast.info('Wait for the photo to finish uploading.');
      const wantStudent = data.get('is_student') !== 'no';
      if (wantStudent && !data.get('student_university')) { App.Toast.error('Please choose your institution.'); return; }
      const res = await App.Auth.updateProfile({
        name: data.get('name'), phone: data.get('phone'), avatar_url: data.get('avatar_url'),
        ...(data.has('preferred_venue_id') ? { preferred_venue_id: data.get('preferred_venue_id') || null } : {}),
      });
      if (res.error) return App.Toast.error(res.error);
      // student status, university and campus: one checked server function
      const pr = S.state.profile || {};
      const newUni = wantStudent ? data.get('student_university') : null, newCampus = wantStudent ? (data.get('student_campus') || null) : null;
      if (wantStudent !== (pr.is_student !== false) || newUni !== (pr.home_university_id || null) || (wantStudent && newCampus !== (pr.campus_id || null))) {
        const { data: r, error: e2 } = await App.sb.rpc('set_my_student_status', { p_is_student: wantStudent, p_university: newUni, p_campus: newCampus });
        if (e2 || !r || !r.ok) return App.Toast.error((r && r.error) || 'Could not save your university.');
        if (r.needs_location && r.message) App.Toast.info(r.message);
        const fresh = await App.Auth.fetchProfile(pr.id);
        if (fresh) S.set({ profile: fresh });
        local.profileStudent = undefined; local.profileUni = undefined;
        App.Discovery.invalidate();
        await App.Bootstrap.loadPublicData();   // the shops this account may see changed
        await App.Discovery.load(true);
        App.Toast.success(wantStudent ? 'Saved. Shops at your university now come first.' : 'Saved.');
        return App.render();
      }
      App.Toast.success('Profile updated'); App.render();
    }
  }

  return {
    render, handleAction, handleInput, handleChange, handleSubmit,
    checkForReviewPrompt, local, resumeUnfinishedCheckout, placeOrder,
  };
})();
