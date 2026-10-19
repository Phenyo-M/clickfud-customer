/* ============================================================
   CLICKFOOD, Marketplace: every published food from student sellers
   (plus partner shops when App.CONFIG.SHOW_PARTNER_SHOPS is on), as a
   product grid with search and category filters. Tapping a card opens
   the normal food detail (order request + WhatsApp seller).
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Market = (function () {
  const S = App.Store;
  const U = App.Utils;
  const H = () => App.Pages.Home;
  const esc = (s) => U.escapeHtml(String(s == null ? '' : s));
  const local = { search: '', category: 'All', availableOnly: false };

  function items() {
    const shopIds = new Set(H().allStores().map(s => s.id));
    const t = local.search.trim().toLowerCase();
    return H().visibleMenu()
      .filter(m => shopIds.has(m.store_id))
      .filter(m => local.category === 'All' || m.category === local.category)
      .filter(m => !local.availableOnly || !App.Menu.isOutOfStock(m))
      .filter(m => {
        if (!t) return true;
        const shop = App.Stores.getById(m.store_id);
        return [m.name, m.description, m.category, H().categoryLabel(m.category), shop && shop.name]
          .some(v => String(v || '').toLowerCase().includes(t));
      })
      .sort((a, b) => Number(App.Menu.isOutOfStock(a)) - Number(App.Menu.isOutOfStock(b))
        || km(a) - km(b) || (b.rating_count || 0) - (a.rating_count || 0) || new Date(b.created_at) - new Date(a.created_at));
  }

  // Closest first, from the student's home pin (unknown distance last).
  function km(m) { const k = App.MapPicker.kmToShop(App.Stores.getById(m.store_id)); return k == null ? 9999 : k; }

  function categories() {
    const present = new Set(H().visibleMenu().map(m => m.category));
    return App.CONST.STUDENT_FOOD_CATEGORIES.concat(App.CONST.CATEGORIES).filter((c, i, a) => a.indexOf(c) === i && present.has(c));
  }

  function card(m) {
    const shop = App.Stores.getById(m.store_id);
    const out = App.Menu.isOutOfStock(m);
    return `
    <button type="button" class="card card-hover menu-card market-card" data-action="open-food" data-id="${esc(m.id)}">
      <div class="menu-card-img media">
        <img crossorigin="anonymous" class="fade-img" src="${esc(m.image || '')}" alt="${esc(m.name)}" loading="lazy" onload="this.classList.add('loaded')" onerror="this.onerror=null;this.src='icons/clickfood-icon-192.png';this.classList.add('img-fallback','loaded');" />
        ${out ? `<div class="out-of-stock-overlay">${esc(App.Menu.unavailableReason(m))}</div>` : ''}
      </div>
      <div class="menu-card-body">
        <span class="menu-card-name">${esc(m.name)}</span>
        ${shop ? `<div class="menu-card-store">${esc(shop.name)}${km(m) < 9999 ? ` · ${esc(App.MapPicker.distanceLabel(km(m)).replace(' away', ''))}` : ''}</div>` : ''}
        <div class="menu-card-footer">
          <span class="price-tag">${U.money(U.menuItemPrice(m))}</span>
          <span class="text-xs text-muted menu-card-cat">${esc(H().categoryLabel(m.category))}</span>
        </div>
      </div>
    </button>`;
  }

  function render() {
    if (!S.state.dataReady) {
      return `<div class="page-wrap"><div class="grid grid-menu">${Array(6).fill('<div class="card skeleton" style="height:220px;"></div>').join('')}</div></div>`;
    }
    const list = items();
    const cats = categories();
    const icons = H().FOOD_CATEGORY_ICONS;
    const p = S.state.profile;
    const sellCta = p && p.role === 'customer' && !App.Seller.isSeller();
    return `
    <div class="page-wrap">
      <div class="flex justify-between items-center mb-3 gap-2">
        <h1 class="page-title">Marketplace</h1>
        ${sellCta ? `<button type="button" class="btn btn-secondary btn-sm" data-action="ent-open"><i data-lucide="chef-hat"></i>Sell food</button>` : ''}
      </div>
      <div class="search-bar mb-3">
        <i data-lucide="search"></i>
        <input type="text" id="market-search-input" placeholder="Search food or sellers" value="${esc(local.search)}" data-action-input="mkt-search" aria-label="Search food" />
      </div>
      ${cats.length ? `
      <div class="category-icon-row mb-3">
        <button type="button" class="category-icon-card ${local.category === 'All' ? 'active' : ''}" data-action="mkt-cat" data-category="All"><span class="category-icon-badge"><i data-lucide="layout-grid"></i></span><span>All</span></button>
        ${cats.map(c => `<button type="button" class="category-icon-card ${local.category === c ? 'active' : ''}" data-action="mkt-cat" data-category="${esc(c)}"><span class="category-icon-badge"><i data-lucide="${icons[c] || 'utensils'}"></i></span><span>${esc(H().categoryLabel(c))}</span></button>`).join('')}
      </div>` : ''}
      <div class="flex justify-between items-center mb-2">
        <span class="text-sm text-muted">${list.length} ${list.length === 1 ? 'item' : 'items'}</span>
        <button type="button" class="chip ${local.availableOnly ? 'active' : ''}" data-action="mkt-available">Available now</button>
      </div>
      ${list.length
        ? `<div class="grid grid-menu market-grid">${list.map(card).join('')}</div>`
        : `<div class="empty-state"><div class="icon-wrap"><i data-lucide="utensils-crossed"></i></div><h3>${local.search || local.category !== 'All' ? 'No matches' : 'No food listed yet'}</h3></div>`}
    </div>`;
  }

  function handleAction(action, ds) {
    if (action === 'mkt-cat') { local.category = ds.category; return App.render(); }
    if (action === 'mkt-available') { local.availableOnly = !local.availableOnly; return App.render(); }
  }
  function handleInput(kind, value) {
    if (kind === 'mkt-search') { local.search = value; App.render(); }
  }

  return { render, handleAction, handleInput, local };
})();
