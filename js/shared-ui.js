/* ============================================================
   CLICKFUD — shared UI: nav bars, cart, tracker, receipt,
   review modal, notifications panel
   ============================================================ */
window.App = window.App || {};

App.Shared = (function () {
  const S = App.Store;
  const U = App.Utils;

  const STATUS_ICON = {
    received: 'receipt', preparing: 'chef-hat', ready: 'package-check',
    out_for_delivery: 'bike', delivered: 'party-popper', collected: 'party-popper', cancelled: 'x-circle', uncollected: 'clock',
  };

  // Official clickFud brand artwork (the uploaded logo), cropped once into
  // two real image assets under icons/ and used as-is everywhere — never
  // recolored, redrawn, stretched, or recreated as a hand-drawn glyph:
  //   - clickfud-icon-192.png  = icon only (no wordmark), for compact nav
  //     badges/favicons, sized via object-fit: contain so it's never
  //     distorted.
  //   - clickfud-logo-full-512.png = the icon + "clickFud" wordmark
  //     exactly as supplied, stacked together in one image, for
  //     login/splash/landing moments that want the full lockup.
  function logoBadge(size) {
    // No size = let CSS own it (.brand-icon, incl. its mobile media query).
    // A size is only passed for one-off contexts that need to differ from
    // that shared default.
    const sizeStyle = size ? ` style="width:${size}px;height:${size}px;"` : '';
    return `<span class="brand-icon"${sizeStyle}><img src="icons/clickfud-icon-192.png" alt="clickFud" style="width:100%;height:100%;object-fit:contain;display:block;" /></span>`;
  }

  // Reusable branded logo component: size is 'sm' | 'md' | 'lg'. When
  // wordmark is true (the default) this renders the single combined
  // icon+wordmark image, since that image already contains the "clickFud"
  // brand name — pairing it with a separate text label next to it would
  // just duplicate the name beside itself. wordmark:false renders just the
  // icon, for contexts that supply their own text.
  function ClickFudLogo(opts) {
    opts = opts || {};
    const size = opts.size || 'md';
    const wordmark = opts.wordmark !== false;
    if (wordmark) {
      const lockupWidths = { sm: 120, md: 170, lg: 260 };
      const w = lockupWidths[size] || lockupWidths.md;
      return `<img src="icons/clickfud-logo-full-512.png" alt="clickFud" style="width:${w}px;height:${w}px;object-fit:contain;display:block;margin:0 auto;" />`;
    }
    const badgeDims = { sm: 30, md: 56, lg: 96 };
    const px = badgeDims[size] || badgeDims.md;
    return `<span class="cf-logo-badge" style="width:${px}px;height:${px}px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
      <img src="icons/clickfud-icon-192.png" alt="clickFud" style="width:100%;height:100%;object-fit:contain;display:block;" />
    </span>`;
  }

  // ---- Campus tick-boxes (signup, campus setup, profile) ----
  // A student may attend several campuses, so this is a tick-box list, not
  // a dropdown. The ticked state lives here (keyed by `group`), not only
  // in the DOM — App.render() rebuilds the page on every state change
  // (a realtime menu update, a toast…), which would otherwise silently
  // untick boxes the student had just ticked but not yet submitted.
  const campusSelections = {};
  function campusCheckboxes({ group, university, initial }) {
    const campuses = App.CONST.UNIVERSITY_CAMPUSES[university] || [];
    if (!campusSelections[group]) campusSelections[group] = new Set(initial || []);
    const sel = campusSelections[group];
    return `<div class="campus-options" role="group">
      ${campuses.map(c => `
      <label class="campus-option ${sel.has(c) ? 'checked' : ''}">
        <input type="checkbox" name="campuses" value="${U.escapeHtml(c)}" data-campus-group="${U.escapeHtml(group)}" ${sel.has(c) ? 'checked' : ''} />
        <span class="campus-option-box"><i data-lucide="check"></i></span>
        <span>${U.escapeHtml(c)}</span>
      </label>`).join('')}
    </div>`;
  }
  function selectedCampuses(group) { return campusSelections[group] ? [...campusSelections[group]] : []; }
  function resetCampusSelection(group) { delete campusSelections[group]; }
  document.addEventListener('change', (e) => {
    const box = e.target.closest && e.target.closest('input[data-campus-group]');
    if (!box) return;
    const group = box.dataset.campusGroup;
    if (!campusSelections[group]) campusSelections[group] = new Set();
    if (box.checked) campusSelections[group].add(box.value); else campusSelections[group].delete(box.value);
    const label = box.closest('.campus-option');
    if (label) label.classList.toggle('checked', box.checked);
  });

  function defaultRouteForRole(role) {
    switch (role) {
      case 'manager': return { role: 'manager', view: 'dashboard', params: {} };
      case 'kitchen': return { role: 'kitchen', view: 'board', params: {} };
      case 'driver': return { role: 'driver', view: 'available', params: {} };
      case 'developer': return { role: 'developer', view: 'applications', params: {} };
      default: return { role: 'customer', view: 'home', params: {} };
    }
  }

  function avatar(profile, size) {
    size = size || 36;
    const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`;
    if (profile && profile.avatar_url) {
      return `<div class="avatar" style="${style}"><img src="${U.escapeHtml(profile.avatar_url)}" alt="${U.escapeHtml(profile.name)}"></div>`;
    }
    return `<div class="avatar" style="${style}">${U.escapeHtml(U.initials(profile ? profile.name : '?'))}</div>`;
  }

  function greetingText(profile) {
    if (!profile || !profile.name) return 'Welcome!';
    return `Hi, ${U.escapeHtml(profile.name.split(' ')[0])}! 👋`;
  }

  function firstName(profile) {
    if (!profile || !profile.name) return '';
    return profile.name.split(' ')[0];
  }

  // ---------------- Profile dropdown menu ----------------
  // ---------------- Top app nav ----------------
  function renderAppNav() {
    const profile = S.state.profile;
    const cartCount = S.state.cart.reduce((n, c) => n + c.qty, 0);
    const unread = App.Notifications.unreadCount();

    let links = '';
    let actions = '';
    let searchBox = '';
    if (profile) {
      if (profile.role === 'customer') {
        searchBox = `
        <div class="nav-search-wrap">
          <div class="input-group">
            <i data-lucide="search" style="width:16px;height:16px;color:var(--text-secondary);"></i>
            <input type="text" id="nav-search-input" placeholder="Search for food, drinks, or shops..." data-action-input="nav-search" value="${U.escapeHtml((App.Pages.Home && App.Pages.Home.local.search) || '')}" aria-label="Search stores or food" />
          </div>
        </div>`;
      }
      actions += `
        <button class="btn-icon bell-btn" data-action="open-notifications" aria-label="Notifications">
          <i data-lucide="bell"></i>
          ${unread > 0 ? `<span class="bell-dot">${unread > 9 ? '9+' : unread}</span>` : ''}
        </button>`;
      if (profile.role === 'customer') {
        // Everything that isn't notifications/search (RecessBox, My
        // Orientation, My Timetable, theme, profile, settings, logout)
        // lives on its own full "More" page (js/pages/customer.js
        // renderMorePage()) rather than a small dropdown panel. Cart is
        // deliberately NOT a persistent icon here any more — the only
        // cart affordance is the "View Cart • N items" bar (see
        // renderBottomNav()'s floating-cart-btn), which only exists at
        // all while the cart actually has something in it.
        actions += `
        <button type="button" class="btn-icon nav-menu-btn" data-action="navigate" data-view="more" aria-label="More">
          <i data-lucide="menu"></i>
        </button>`;
      } else {
        actions += `<button class="btn-icon" data-action="toggle-theme" aria-label="Toggle theme"><i data-lucide="${S.state.theme === 'dark' ? 'sun' : 'moon'}"></i></button>
        <button class="btn-icon" data-action="go-profile" aria-label="Profile" style="padding:0;border:none;background:none;">${avatar(profile, 36)}</button>
        <button class="btn btn-secondary btn-sm" data-action="logout"><i data-lucide="log-out"></i><span class="hidden-xs">Logout</span></button>`;
      }
    } else {
      actions += `
        <button class="btn-icon" data-action="toggle-theme" aria-label="Toggle theme"><i data-lucide="${S.state.theme === 'dark' ? 'sun' : 'moon'}"></i></button>
        <button class="btn btn-secondary btn-sm" data-action="go-auth" data-tab="login">Log In</button>
        <button class="btn btn-primary btn-sm" data-action="go-auth" data-tab="signup">Sign Up</button>`;
    }

    return `
    <nav class="app-nav">
      <div class="container">
        <div class="brand" data-action="go-home" style="cursor:pointer">
          ${logoBadge()}
          <span class="brand-name">clickFud</span>
        </div>
        ${searchBox}
        ${links}
        <div class="nav-actions">${actions}</div>
      </div>
    </nav>`;
  }

  // ---------------- Desktop sidebar (customer role) ----------------
  function renderCustomerSidebar() {
    const profile = S.state.profile;
    if (!profile || profile.role !== 'customer') return '';
    const route = S.state.route;
    const cartCount = S.state.cart.reduce((n, c) => n + c.qty, 0);
    const items = [
      { view: 'home', icon: 'home', label: 'Home' },
      { view: 'search', icon: 'search', label: 'Search' },
      { view: 'orders', icon: 'receipt', label: 'Orders' },
      { view: 'orientation', icon: 'compass', label: 'My Orientation' },
      { view: 'timetable', icon: 'calendar', label: 'My Timetable' },
      { view: 'cart', icon: 'shopping-cart', label: 'Cart', badge: cartCount, action: 'open-cart' },
      { view: 'profile', icon: 'user', label: 'Profile' },
      { view: 'settings', icon: 'settings', label: 'Settings', action: 'go-profile' },
    ];
    return `
    <aside class="app-sidebar">
      ${items.map(it => `
        <button type="button" class="sidebar-item ${route.view === it.view ? 'active' : ''}" data-action="${it.action || 'navigate'}" data-view="${it.view}">
          <i data-lucide="${it.icon}"></i>
          <span>${it.label}</span>
          ${it.badge ? `<span class="sidebar-badge">${it.badge}</span>` : ''}
        </button>`).join('')}
    </aside>`;
  }

  // ---------------- Bottom mobile nav ----------------
  function renderBottomNav() {
    const profile = S.state.profile;
    const route = S.state.route;
    let items = [];
    if (!profile) {
      // Only on the actual public home page (js/pages/home.js) — hidden
      // again the moment they're on the login/signup screen itself
      // (S.state.forceAuthView), since a second nav there would be
      // redundant. Orders/Favourite/Profile have no real guest data
      // behind them, so each one is honest about that and sends the
      // visitor straight to create an account / log in rather than
      // pretending to show empty lists.
      if (S.state.forceAuthView) return '';
      items = [
        { view: 'home', icon: 'home', label: 'Home', action: 'go-home' },
        { view: 'orders', icon: 'receipt', label: 'Orders', action: 'guest-nav-orders' },
        { view: 'favorites', icon: 'heart', label: 'Saved', action: 'guest-nav-favorites' },
        { view: 'profile', icon: 'user', label: 'Profile', action: 'guest-nav-profile' },
      ];
    } else if (profile.role === 'customer') {
      // Cart is the raised centre FAB (below), same as the guest nav —
      // no separate inline Cart tab.
      items = [
        { view: 'home', icon: 'home', label: 'Home' },
        { view: 'search', icon: 'search', label: 'Search' },
        { view: 'orders', icon: 'receipt', label: 'Orders' },
        { view: 'profile', icon: 'user', label: 'Profile' },
      ];
    } else if (profile.role === 'manager') {
      items = [
        { view: 'dashboard', icon: 'layout-dashboard', label: 'Stats' },
        { view: 'menu', icon: 'utensils', label: 'Menu' },
        { view: 'kitchen', icon: 'chef-hat', label: 'Kitchen' },
        { view: 'orders', icon: 'receipt', label: 'Orders' },
        { view: 'profile', icon: 'user', label: 'Profile' },
      ];
    } else if (profile.role === 'kitchen') {
      items = [{ view: 'board', icon: 'chef-hat', label: 'Board' }, { view: 'profile', icon: 'user', label: 'Profile' }];
    } else if (profile.role === 'driver') {
      items = [
        { view: 'available', icon: 'list', label: 'Available' },
        { view: 'active', icon: 'bike', label: 'Active' },
        { view: 'profile', icon: 'user', label: 'Profile' },
      ];
    } else if (profile.role === 'developer') {
      items = [
        { view: 'applications', icon: 'clipboard-list', label: 'Applications' },
        { view: 'shops', icon: 'store', label: 'Shops' },
        { view: 'promotions', icon: 'megaphone', label: 'Promos' },
        { view: 'profile', icon: 'user', label: 'Profile' },
      ];
    }
    // Raised centre button + scalloped notch — a guest still gets the
    // cart there (no account yet, so no My Orientation to show); a
    // logged-in customer gets My Orientation instead (see section 5/6 of
    // the brief this replaced — the cart must never retake this spot).
    // Both share the exact same raised/notched shell, just a different
    // button inside it.
    const isGuestNav = !profile;
    const isCustomer = !!profile && profile.role === 'customer';
    const usesRaisedNav = isGuestNav || isCustomer;
    const cartCount = (S.state.cart || []).reduce((n, c) => n + c.qty, 0);

    const centerButton = isGuestNav
      ? `<button type="button" class="bottom-nav-fab" data-action="open-cart" aria-label="View cart">
          <i data-lucide="shopping-cart"></i>
          ${cartCount ? `<span class="cart-count">${cartCount}</span>` : ''}
        </button>`
      : isCustomer
      ? `<button type="button" class="bottom-nav-fab bottom-nav-fab-orientation ${route.view === 'orientation' ? 'active' : ''}" data-action="navigate" data-view="orientation" aria-label="My Orientation">
          <span class="bottom-nav-fab-logo"><img src="icons/clickfud-icon-192.png" alt="" /></span>
        </button>`
      : '';

    // Deliberately separate from centerButton above — a customer's cart
    // must never replace My Orientation there. This is just a real,
    // clickable summary of the SAME cart state (S.state.cart), reusing
    // the .floating-cart-btn shell css/home.css already defines (and
    // app.js's updateFixedBottomSpace() already measures) rather than a
    // second cart widget — it only exists while the cart is non-empty,
    // and disappears again the moment it's cleared. A plain text message,
    // not a cart/trolley icon — the feedback for actually adding an item
    // is the "Added to cart" toast at the moment it happens; this bar is
    // just the way back into an already-nonempty cart, not a persistent
    // icon+badge sitting on screen the way the old top-nav cart button did.
    const viewCartBar = (isCustomer && cartCount > 0) ? `
    <button type="button" class="floating-cart-btn" data-action="open-cart">
      <span>View Cart &bull; ${cartCount} item${cartCount === 1 ? '' : 's'}</span>
    </button>` : '';

    return `
    ${viewCartBar}
    <nav class="bottom-nav ${usesRaisedNav ? 'bottom-nav-guest' : ''}">
      ${centerButton}
      ${items.map(it => `
        <button class="bottom-nav-item ${route.view === it.view ? 'active' : ''}" data-action="${it.action || 'navigate'}" data-view="${it.view}">
          <i data-lucide="${it.icon}"></i><span>${it.label}</span>
        </button>`).join('')}
    </nav>`;
  }

  // ---------------- Cart slideover ----------------
  function cartItemRow(item, index) {
    const subtotal = (item.price + (item.addonsTotal || 0)) * item.qty;
    return `
    <div class="cart-item">
      <img src="${U.escapeHtml(item.image || '')}" alt="${U.escapeHtml(item.name)}" onerror="this.style.visibility='hidden'">
      <div class="flex-col" style="flex:1; gap:6px;">
        <div class="flex justify-between items-center">
          <span class="font-semibold text-sm">${U.escapeHtml(item.name)}</span>
          <button class="btn-icon btn-sm" style="width:28px;height:28px;min-width:28px;min-height:28px;" data-action="cart-remove" data-index="${index}" aria-label="Remove"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
        </div>
        ${item.addons && item.addons.length ? `<div class="text-xs text-muted">${item.addons.map(a => `+ ${U.escapeHtml(typeof a === 'string' ? a : a.name)}${typeof a === 'object' && a.price ? ' (' + U.money(a.price) + ')' : ''}`).join(', ')}</div>` : ''}
        ${item.specialInstructions ? `<div class="text-xs text-muted">"${U.escapeHtml(item.specialInstructions)}"</div>` : ''}
        <div class="flex justify-between items-center">
          <div class="qty-control">
            <button class="qty-btn" data-action="cart-qty" data-index="${index}" data-delta="-1" aria-label="Decrease"><i data-lucide="minus" style="width:14px;height:14px;"></i></button>
            <span>${item.qty}</span>
            <button class="qty-btn" data-action="cart-qty" data-index="${index}" data-delta="1" aria-label="Increase"><i data-lucide="plus" style="width:14px;height:14px;"></i></button>
          </div>
          <span class="font-bold text-sm">${U.money(subtotal)}</span>
        </div>
      </div>
    </div>`;
  }

  let openPanelKind = null;

  function refreshOpenPanel() {
    if (!App.Slideover.isOpen()) { openPanelKind = null; return; }
    if (openPanelKind === 'cart') openCart();
    else if (openPanelKind === 'notifications') openNotifications();
  }

  function openCart() {
    openPanelKind = 'cart';
    const cart = S.state.cart;
    const subtotal = cart.reduce((s, i) => s + (i.price + (i.addonsTotal || 0)) * i.qty, 0);
    // Grouped by store (clickFud's cart can hold items from several shops
    // at once) — each row still carries its real index into S.state.cart,
    // since cart-qty/cart-remove act on that flat array, not this grouping.
    const groups = S.cartGroupsByStore();
    const body = cart.length === 0
      ? `<div class="empty-state"><div class="icon-wrap"><i data-lucide="shopping-cart"></i></div><h3>Your cart is empty</h3><p>Add something tasty from the menu.</p></div>`
      : groups.map((g, gi) => `
        ${groups.length > 1 ? `<div class="text-xs font-bold text-muted mb-1" style="text-transform:uppercase;letter-spacing:.03em;padding:0 2px;${gi > 0 ? 'margin-top:14px;' : ''}">${U.escapeHtml(g.storeName || 'Store')}</div>` : ''}
        ${g.items.map(item => cartItemRow(item, item.cartIndex)).join('')}
      `).join('');

    App.Slideover.open(`
      <div class="slideover">
        <div class="slideover-header">
          <span class="modal-title">Your Cart</span>
          <button class="modal-close" data-action="close-cart"><i data-lucide="x"></i></button>
        </div>
        <div class="slideover-body">${body}</div>
        ${cart.length ? `
        <div class="slideover-footer">
          <div class="cart-summary-row"><span>Subtotal</span><span>${U.money(subtotal)}</span></div>
          <div class="text-xs text-muted mb-2">Discounts are applied at checkout.</div>
          <button class="btn btn-secondary btn-block mb-2" data-action="clear-cart"><i data-lucide="trash-2"></i>Clear Cart</button>
          <button class="btn btn-primary btn-block btn-lg" data-action="go-checkout">Checkout <i data-lucide="arrow-right"></i></button>
        </div>` : ''}
      </div>`, { rootId: 'cart-panel-root' });
  }

  // ---------------- Order tracker ----------------
  function renderTracker(order) {
    if (order.status === 'cancelled') {
      return `<div class="closed-banner"><i data-lucide="x-circle"></i><div><strong>Order Cancelled</strong><div class="text-sm">This order will not be prepared.</div></div></div>`;
    }
    if (order.status === 'uncollected') {
      return `<div class="closed-banner"><i data-lucide="clock"></i><div><strong>Not Collected</strong><div class="text-sm">This order wasn't collected in time and has been closed.</div></div></div>`;
    }
    const isCollection = order.delivery_location && order.delivery_location.fulfilment === 'collection';
    const flow = isCollection ? App.CONST.STATUS_FLOW_COLLECTION : App.CONST.STATUS_FLOW;
    const terminal = flow[flow.length - 1];
    const currentIdx = flow.indexOf(order.status);
    const history = order.status_history || [];
    return `<div class="tracker">
      ${flow.map((status, i) => {
        const entry = history.find(h => h.status === status);
        const done = i < currentIdx || (i === currentIdx && status === terminal);
        const current = i === currentIdx && status !== terminal;
        const state = done ? 'done' : current ? 'current' : '';
        return `
        <div class="tracker-step ${state}">
          ${i < flow.length - 1 ? '<div class="tracker-line"></div>' : ''}
          <div class="tracker-dot"><i data-lucide="${done || current ? STATUS_ICON[status] : 'circle'}" style="width:16px;height:16px"></i></div>
          <div class="tracker-content">
            <div class="t-title">${App.CONST.STATUS_LABELS[status]}</div>
            ${entry ? `<div class="t-time">${U.formatTime(entry.at)}</div>` : ''}
            <div class="t-desc">${App.CONST.STATUS_DESCRIPTIONS[status]}${status === 'out_for_delivery' && order.eta ? ` · ETA ${U.formatTime(order.eta)} (${Math.max(0, U.minutesUntil(order.eta))} min)` : ''}</div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }

  // ---------------- Receipt ----------------
  function renderReceipt(order) {
    const items = order.items || [];
    return `
    <div class="receipt">
      <div style="text-align:center;font-weight:800;font-size:15px;">CLICKFUD</div>
      <div style="text-align:center;font-size:11px;" class="text-muted">Campus Food Ordering</div>
      <hr>
      <div class="receipt-row"><span>Order #</span><span>${U.escapeHtml(order.order_number)}</span></div>
      <div class="receipt-row"><span>Date</span><span>${U.formatDateTime(order.created_at)}</span></div>
      <hr>
      ${items.map(it => `
        <div class="receipt-row"><span>${it.qty}x ${U.escapeHtml(it.name)}</span><span>${U.money(it.price * it.qty)}</span></div>
        ${(it.addons || []).map(a => `<div class="receipt-row text-xs text-muted"><span>&nbsp;&nbsp;+ ${U.escapeHtml(typeof a === 'string' ? a : a.name)}</span></div>`).join('')}
      `).join('')}
      <hr>
      <div class="receipt-row"><span>Subtotal</span><span>${U.money(order.subtotal)}</span></div>
      ${Number(order.delivery_fee) > 0 ? `<div class="receipt-row"><span>Delivery Fee</span><span>${U.money(order.delivery_fee)}</span></div>` : ''}
      ${order.discount ? `<div class="receipt-row"><span>Discount ${order.promo_code ? '(' + U.escapeHtml(order.promo_code) + ')' : ''}</span><span>-${U.money(order.discount)}</span></div>` : ''}
      <div class="receipt-row" style="font-weight:800;font-size:15px;"><span>Total</span><span>${U.money(order.total)}</span></div>
      <hr>
      <div class="receipt-row"><span>Payment</span><span>${order.payment_method === 'cod' ? 'Cash' : 'Card'}</span></div>
      <div class="receipt-row"><span>Status</span><span>${paymentStatusLabel(order.payment_status)}</span></div>
    </div>`;
  }

  function paymentStatusLabel(status) {
    const labels = { paid: 'Paid', pending: 'Pending', refund_pending: 'Refund in progress', refunded: 'Refunded', refund_failed: 'Refund failed — contact support' };
    return labels[status] || U.escapeHtml(status || '');
  }

  function openReceiptModal(order) {
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Receipt</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">${renderReceipt(order)}</div>
      <div class="modal-footer"><button class="btn btn-primary btn-block" data-action="print-receipt"><i data-lucide="printer"></i>Print / Save</button></div>`);
  }

  // ---------------- Payment verification modal ----------------
  // The actual wait (Paystack's own verify call, then creating the order)
  // can't be made instant — this replaces the easy-to-miss small toast with
  // an unmissable, undismissable full modal so it's obvious the app is
  // genuinely still working, not stuck or ignoring the tap. Closed by the
  // caller once verification finishes (see js/app.js handlePaystackReturn),
  // either replaced in place by openOrderSuccessModal on success (App.Modal
  // updates the same overlay's content, no flicker) or via App.Modal.close()
  // on failure.
  function openVerifyingPaymentModal() {
    App.Modal.open(`
      <div class="modal-body" style="text-align:center;padding:40px 24px 34px;">
        <div style="width:52px;height:52px;border-radius:50%;border:4px solid var(--bg-surface-2);border-top-color:var(--color-primary);margin:0 auto 20px;animation:spin 0.8s linear infinite;"></div>
        <h2 style="font-size:18px;font-weight:800;margin-bottom:8px;">Verifying your payment</h2>
        <p class="text-muted" style="font-size:14.5px;line-height:1.5;">We're still verifying your payment with Paystack — please wait a few moments. Don't close or refresh this page.</p>
      </div>`, { closeOnOverlay: false });
  }

  // ---------------- Order success modal ----------------
  // A real, full-screen-feeling confirmation after checkout — deliberately
  // NOT just a toast (a toast fades in a couple seconds; a customer who
  // just paid real/test money wants an unmissable "yes, this actually
  // went through" moment, with a real order number, not a small popup
  // they might not even notice).
  // Called AFTER the route has already switched to the confirmation/
  // tracking view underneath, so a single "Got it" is enough — there's
  // nowhere else this needs to send them, the real order status is right
  // there on the page as soon as the modal closes.
  function openOrderSuccessModal({ count, orderNumber }) {
    const title = count > 1 ? `${count} Orders Placed!` : 'Order Placed!';
    const sub = count > 1
      ? `Your ${count} orders have been successfully placed and sent to the kitchens.`
      : orderNumber
      ? `Order ${U.escapeHtml(orderNumber)} has been successfully placed and sent to the kitchen.`
      : 'Your order has been successfully placed and sent to the kitchen.';
    App.Modal.open(`
      <div class="modal-body" style="text-align:center;padding:36px 24px 28px;">
        <div class="icon-wrap" style="width:88px;height:88px;background:rgba(34,197,94,0.14);color:var(--color-success);margin:0 auto 18px;">
          <i data-lucide="check-circle-2" style="width:48px;height:48px;"></i>
        </div>
        <h2 style="font-size:22px;font-weight:800;margin-bottom:8px;">${title}</h2>
        <p class="text-muted" style="font-size:14.5px;line-height:1.5;">${sub}</p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-primary btn-block" data-action="close-modal">Got It</button>
      </div>`, { closeOnOverlay: false });
  }

  // ---------------- Review modal ----------------
  function starPicker(field, value) {
    let html = `<div class="star-row lg" data-field="${field}">`;
    for (let i = 1; i <= 5; i++) {
      html += `<button type="button" class="star-btn ${i <= value ? 'filled' : ''}" data-action="rate-star" data-field="${field}" data-value="${i}"><i data-lucide="star" style="width:22px;height:22px;${i <= value ? 'fill:currentColor' : ''}"></i></button>`;
    }
    return html + '</div>';
  }

  // No "Delivery" rating — this app is pickup/collection-only (Phase
  // 1), there's no delivery experience for a customer to rate.
  const reviewState = { food: 0, overall: 0, comment: '' };

  function openReviewModal(order) {
    const existing = App.Reviews.getForOrder(order.id);
    reviewState.food = existing ? existing.food_rating : 0;
    reviewState.overall = existing ? existing.overall_rating : 0;
    reviewState.comment = existing ? (existing.comment || '') : '';
    renderReviewModal(order.id);
  }

  function renderReviewModal(orderId) {
    const existing = App.Reviews.getForOrder(orderId);
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">${existing ? 'Edit Your Rating' : 'Rate Your Order 🎉'}</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body" data-order-id="${orderId}">
        <div class="mb-3"><label class="text-sm font-semibold mb-1" style="display:block">Food</label>${starPicker('food', reviewState.food)}</div>
        <div class="mb-3"><label class="text-sm font-semibold mb-1" style="display:block">Overall Experience</label>${starPicker('overall', reviewState.overall)}</div>
        <div class="field"><label>Tell us about your experience</label><textarea class="input" rows="3" id="review-comment" placeholder="Optional feedback...">${U.escapeHtml(reviewState.comment || '')}</textarea></div>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" data-action="close-modal">Skip</button><button class="btn btn-primary" data-action="submit-review" data-order-id="${orderId}">${existing ? 'Update Rating' : 'Submit Rating'}</button></div>`, { closeOnOverlay: false });
  }

  async function submitReview(orderId) {
    const overlay = App.Modal.getRoot();
    const comment = overlay ? overlay.querySelector('#review-comment').value : '';
    const order = S.state.orders.find(o => o.id === orderId);
    if (!order) return;
    const wasExisting = !!App.Reviews.getForOrder(orderId);
    const res = await App.Reviews.submitReview(order, {
      foodRating: reviewState.food, overallRating: reviewState.overall, comment,
    });
    if (res.error) { App.Toast.error(res.error); return; }
    App.Modal.close();
    App.Toast.success(wasExisting ? 'Your rating has been updated!' : 'Thanks for your feedback!');
  }

  function setReviewStar(field, value) {
    reviewState[field] = value;
    const overlay = App.Modal.getRoot();
    if (!overlay) return;
    const orderId = overlay.querySelector('[data-order-id]').dataset.orderId;
    const comment = overlay.querySelector('#review-comment');
    const savedComment = comment ? comment.value : '';
    renderReviewModal(orderId);
    const newOverlay = App.Modal.getRoot();
    const newComment = newOverlay.querySelector('#review-comment');
    if (newComment) newComment.value = savedComment;
  }

  // ---------------- Notifications panel ----------------
  function notifIcon(type) {
    const map = {
      order_received: 'receipt', preparing: 'chef-hat', ready: 'package-check',
      out_for_delivery: 'bike', delivered: 'party-popper', order_cancelled: 'x-circle',
      delivery_available: 'bell-ring', promo: 'tag',
      collection_expired: 'alarm-clock', order_rescheduled: 'calendar-clock', order_uncollected: 'clock',
    };
    return map[type] || 'bell';
  }

  // "Are you still going to collect?" is answered right in the notification.
  // The notification names the order; buttons only while the order is still
  // waiting for that answer — afterwards it says what happened instead.
  function missedCollectionReply(n) {
    const num = (String(n.message).match(/ORD-\d{4}-\d+/) || [])[0];
    const o = num && (S.state.orders || []).find(x => x.order_number === num);
    if (!o) return '';
    if (o.status === 'ready' && o.collection_state === 'expired') {
      return `<div class="flex gap-2 mt-2" style="flex-wrap:wrap;">
        <button type="button" class="btn btn-primary btn-sm" data-action="missed-collect-yes" data-id="${o.id}">Yes, I'll still collect</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="missed-collect-no" data-id="${o.id}">No, I won't collect</button>
      </div>`;
    }
    let done = '';
    if (o.status === 'collected') done = 'Collected.';
    else if (o.status === 'uncollected') done = 'Closed — not collected.';
    else if (o.status === 'cancelled') done = "You said you won't collect it. Order cancelled.";
    else if (o.rescheduled_for && (o.collection_state === 'rescheduled' || o.needs_reprep)) done = `Rescheduled for ${U.formatTime(o.rescheduled_for)}.`;
    return done ? `<div class="text-xs mt-1" style="font-weight:600;color:var(--color-primary);">${U.escapeHtml(done)}</div>` : '';
  }

  function openNotifications() {
    openPanelKind = 'notifications';
    const list = App.Notifications.visible();
    const body = list.length === 0
      ? `<div class="empty-state"><div class="icon-wrap"><i data-lucide="bell-off"></i></div><h3>No notifications yet</h3><p>We'll let you know when something happens.</p></div>`
      : list.map(n => `
        <div class="notif-item ${n.read ? '' : 'unread'}" data-action="read-notification" data-id="${n.id}">
          <div class="notif-icon"><i data-lucide="${notifIcon(n.type)}" style="width:16px;height:16px;"></i></div>
          <div style="flex:1">
            <div class="text-sm">${U.escapeHtml(n.message)}</div>
            ${n.type === 'collection_expired' ? missedCollectionReply(n) : ''}
            <div class="text-xs text-muted mt-1">${U.timeAgo(n.created_at)}</div>
          </div>
        </div>`).join('');

    App.Slideover.open(`
      <div class="slideover">
        <div class="slideover-header">
          <span class="modal-title">Notifications</span>
          <div class="flex gap-2">
            ${list.length ? `<button class="btn btn-ghost btn-sm" data-action="mark-all-read">Mark all read</button>` : ''}
            <button class="modal-close" data-action="close-cart"><i data-lucide="x"></i></button>
          </div>
        </div>
        <div class="slideover-body">${body}</div>
      </div>`, { rootId: 'cart-panel-root' });
  }

  // ---------------- Generic staff profile (manager/kitchen/cashier/driver) ----------------
  function renderStaffProfile(extra) {
    const p = S.state.profile;
    return `
    <div class="page-wrap" style="max-width:560px;">
      <h1 class="page-title mb-4">My Profile</h1>
      <div class="card card-pad">
        <div class="profile-header">
          <div class="profile-avatar-lg">${p.avatar_url ? `<img src="${U.escapeHtml(p.avatar_url)}">` : U.escapeHtml(U.initials(p.name))}</div>
          <div><div class="font-bold text-lg">${U.escapeHtml(p.name)}</div><span class="badge badge-primary">${U.escapeHtml(p.role)}</span></div>
        </div>
        <form data-form="staff-profile-form">
          <div class="field"><label>Full Name</label><input class="input" name="name" value="${U.escapeHtml(p.name)}" /></div>
          <div class="field"><label>Email</label><input class="input" value="${U.escapeHtml(p.email)}" disabled /></div>
          <div class="field"><label>Avatar URL</label><input class="input" name="avatar_url" value="${U.escapeHtml(p.avatar_url || '')}" placeholder="https://..." /></div>
          ${extra || ''}
          <button type="submit" class="btn btn-primary btn-block">Save Changes</button>
        </form>
      </div>
    </div>`;
  }

  async function handleStaffProfileSubmit(data) {
    const patch = { name: data.get('name'), avatar_url: data.get('avatar_url') };
    if (data.has('driver_status')) patch.driver_status = data.get('driver_status');
    const res = await App.Auth.updateProfile(patch);
    if (res.error) App.Toast.error(res.error); else { App.Toast.success('Profile updated'); App.render(); }
  }

  return {
    STATUS_ICON, defaultRouteForRole, avatar, greetingText, logoBadge, ClickFudLogo,
    campusCheckboxes, selectedCampuses, resetCampusSelection,
    renderAppNav, renderBottomNav, renderCustomerSidebar,
    openCart, renderTracker, renderReceipt, openReceiptModal, openOrderSuccessModal, openVerifyingPaymentModal,
    openReviewModal, setReviewStar, submitReview,
    openNotifications, refreshOpenPanel, renderStaffProfile, handleStaffProfileSubmit,
  };
})();
