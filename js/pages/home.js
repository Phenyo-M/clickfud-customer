/* ============================================================
   CLICKFUD — Marketplace storefront: store discovery (used by
   logged-out visitors AND logged-in customers) + store detail page.

   App.Pages.Home owns the actual browsing/store-detail markup via
   renderBrowser()/renderStoreDetail(); render() wraps that with the
   full public header/footer for logged-out visitors. Customer.js
   (authenticated) calls renderBrowser()/renderStoreDetail() directly
   and wraps them with the normal in-app nav instead — one shared
   implementation, two shells.
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Home = (function () {
  const S = App.Store;
  const U = App.Utils;

  const local = {
    category: 'All',
    location: 'All',
    search: '',
    openNowOnly: false,
    sort: 'recommended',
    foodCategory: 'All', // menu-item category filter for "Food Categories" / "Recommended for You"
    storeSearch: {},   // per-store search term, keyed by storeId
    heroIndex: 0,      // which active store promotion the hero banner is showing
  };

  const FOOD_CATEGORY_ICONS = {
    Breakfast: 'coffee', Lunch: 'sandwich', Dinner: 'utensils-crossed',
    Snacks: 'cookie', Drinks: 'cup-soda', Desserts: 'cake', Specials: 'sparkles',
  };

  function esc(s) { return U.escapeHtml(String(s == null ? '' : s)); }
  function money(n) { return 'R' + (Number(n) || 0).toFixed(2); }

  // A shop with zero ratings must never look like it scored 0 (reads as a
  // terrible shop) or 5 (falsely implies real 5-star reviews) — "No
  // ratings yet" is the only honest option until a real one exists.
  function ratingBadge(store) {
    if (!store.rating_count) return `<span class="text-muted">No ratings yet</span>`;
    return `<i data-lucide="star" style="width:13px;height:13px;color:var(--color-yellow);"></i> ${Number(store.rating).toFixed(1)} (${store.rating_count})`;
  }

  // Per-star counts come from stores.rating_breakdown — a public aggregate
  // kept in sync by the same DB trigger that maintains rating/rating_count
  // — not from the reviews table itself, whose individual rows correctly
  // stay private to the reviewer and that shop's staff under RLS.
  function ratingBreakdown(store) {
    if (!store.rating_count) return '';
    const bd = store.rating_breakdown || {};
    const max = Math.max(1, ...[5, 4, 3, 2, 1].map(star => Number(bd[star] || bd[String(star)] || 0)));
    return `<div class="mt-2">${[5, 4, 3, 2, 1].map(star => {
      const count = Number(bd[star] || bd[String(star)] || 0);
      return `<div class="hbar-row">
        <span class="hbar-label" style="width:50px;">${'★'.repeat(star)}${'☆'.repeat(5 - star)}</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:${(count / max) * 100}%"></span></span>
        <span class="hbar-value">${count}</span>
      </div>`;
    }).join('')}</div>`;
  }

  // ---------------- Store helpers ----------------
  function allStores() {
    // A store must be developer-approved AND have its manager explicitly
    // publish it (js/pages/manager.js renderPublishBanner()) before it's
    // shown here — this used to be missing entirely, so pending/rejected/
    // archived stores were visible to every customer. The "stores select
    // all" RLS policy (schema.sql) now enforces the same rule server-side
    // too, so this isn't the only thing standing between an unpublished
    // store and public view.
    const stores = (S.state.stores || []).filter(s => s.status === 'approved' && s.is_published);
    // Customers only browse shops registered at their own university/college.
    // Logged-out visitors and staff/developer roles see everything (of
    // what's actually live, per the filter above).
    const profile = S.state.profile;
    if (profile && profile.role === 'customer' && profile.university) {
      return stores.filter(s => s.university === profile.university);
    }
    return stores;
  }

  // Belt-and-braces alongside the real enforcement: RLS ("menu select",
  // schema.sql) already means a customer session's S.state.menu can only
  // ever contain approved rows (or a manager's own store's, which never
  // applies here) — this filter just keeps every browse/discovery
  // surface below explicitly correct even if that ever changes, the same
  // pattern allStores() uses for stores.
  function visibleMenu() {
    return (S.state.menu || []).filter(m => m.status === 'approved');
  }

  function matchesStoreSearch(store, term) {
    if (!term) return true;
    const t = term.toLowerCase();
    if (store.name.toLowerCase().includes(t) ||
        (store.category || '').toLowerCase().includes(t) ||
        (store.description || '').toLowerCase().includes(t)) return true;
    // A shop also matches if any of its own menu items match — searching
    // "chicken" should surface the store that sells chicken, not just
    // stores literally named or categorized "chicken".
    return visibleMenu().some(m => m.store_id === store.id &&
      (m.name.toLowerCase().includes(t) || (m.description || '').toLowerCase().includes(t)));
  }

  // Same-campus shops rank ahead of other campuses' — never hides them,
  // just orders them after, so a Hatfield student sees Hatfield shops
  // first but can still scroll to see Mamelodi's, Groenkloof's, etc.
  function campusRank(store) {
    const profile = S.state.profile;
    const myCampus = profile && profile.role === 'customer' ? profile.campus_location : null;
    if (!myCampus) return 0;
    return store.campus_location === myCampus ? 0 : 1;
  }

  function popularStores() {
    const stores = allStores();
    return [...stores]
      .sort((a, b) => campusRank(a) - campusRank(b) || (b.rating_count || 0) - (a.rating_count || 0) || (b.rating || 0) - (a.rating || 0))
      .slice(0, 6);
  }

  function filteredStores() {
    const list = allStores().filter(store => {
      if (local.category !== 'All' && store.category !== local.category) return false;
      if (local.location !== 'All' && store.campus_location !== local.location) return false;
      if (local.openNowOnly && !App.Stores.isOpenNow(store)) return false;
      if (!matchesStoreSearch(store, local.search)) return false;
      return true;
    });
    return sortStores(list);
  }

  function sortStores(list) {
    const sorted = [...list];
    let cmp;
    if (local.sort === 'rating') {
      cmp = (a, b) => (b.rating || 0) - (a.rating || 0) || (b.rating_count || 0) - (a.rating_count || 0);
    } else if (local.sort === 'fastest') {
      cmp = (a, b) => (a.prep_time_min || 99) - (b.prep_time_min || 99);
    } else {
      cmp = (a, b) => (b.rating_count || 0) - (a.rating_count || 0) || (b.rating || 0) - (a.rating || 0);
    }
    sorted.sort((a, b) => campusRank(a) - campusRank(b) || cmp(a, b));
    return sorted;
  }

  // ---------------- Reorder (logged-in customers with past orders) ----------------
  function reorderItems() {
    if (!S.state.profile || !S.state.orders || !S.state.orders.length) return [];
    const seen = new Set();
    const picks = [];
    const orders = [...S.state.orders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    for (const order of orders) {
      for (const it of order.items || []) {
        if (seen.has(it.menuItemId)) continue;
        const menuItem = visibleMenu().find(m => m.id === it.menuItemId);
        if (!menuItem || !menuItem.available || menuItem.stock <= 0) continue;
        seen.add(it.menuItemId);
        picks.push(menuItem);
        if (picks.length >= 6) return picks;
      }
    }
    return picks;
  }

  function reorderCard(item) {
    const store = App.Stores.getById(item.store_id);
    return `
      <div class="card card-hover reorder-card" data-action="open-food" data-id="${esc(item.id)}">
        <div class="reorder-card-img-wrap">
          ${item.image ? `<img class="fade-img" src="${esc(item.image)}" alt="${esc(item.name)}" loading="lazy" onload="this.classList.add('loaded')" />` : `<div class="store-card-cover-fallback"><i data-lucide="utensils"></i></div>`}
        </div>
        <div class="card-pad" style="padding:12px;">
          <div class="font-semibold" style="font-size:13.5px;line-height:1.3;">${esc(item.name)}</div>
          <div class="text-xs text-muted" style="margin:2px 0 6px;">${store ? esc(store.name) : ''}</div>
          <div class="flex justify-between items-center">
            <span class="font-bold" style="font-size:13px;">${money(item.price)}</span>
            <button type="button" class="btn-icon" style="width:30px;height:30px;min-width:30px;min-height:30px;" data-action="reorder-quick-add" data-id="${esc(item.id)}" aria-label="Add again"><i data-lucide="plus" style="width:15px;height:15px;"></i></button>
          </div>
        </div>
      </div>`;
  }

  function storeCategories() {
    const cats = new Set(allStores().map(s => s.category).filter(Boolean));
    return ['All', ...cats];
  }

  // ---------------- Food categories + "Recommended for You" ----------------
  // Real menu-item categories (the same fixed list menu_items.category is
  // constrained to in the database) — not fabricated, and not the same
  // concept as storeCategories() above (that filters shops; this filters
  // food items, both here and in "Recommended for You").
  function foodCategories() {
    const present = new Set(visibleMenu().map(m => m.category).filter(Boolean));
    return App.CONST.CATEGORIES.filter(c => present.has(c));
  }

  function visibleStoreIds() {
    return new Set(allStores().map(s => s.id));
  }

  function recommendedItems() {
    const storeIds = visibleStoreIds();
    let items = visibleMenu().filter(m => storeIds.has(m.store_id) && m.available && m.stock > 0);
    if (local.foodCategory !== 'All') items = items.filter(m => m.category === local.foodCategory);
    if (local.search) {
      const t = local.search.toLowerCase();
      items = items.filter(m => m.name.toLowerCase().includes(t) || (m.description || '').toLowerCase().includes(t));
    }
    return [...items]
      .sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.rating_count || 0) - (a.rating_count || 0))
      .slice(0, 8);
  }

  function recommendedFoodCard(item) {
    const store = App.Stores.getById(item.store_id);
    const outOfStock = App.Menu.isOutOfStock(item);
    return `
    <div class="card card-hover menu-card" data-action="open-food" data-id="${esc(item.id)}">
      <div class="menu-card-img">
        ${item.image ? `<img class="fade-img" src="${esc(item.image)}" alt="${esc(item.name)}" loading="lazy" onload="this.classList.add('loaded')" onerror="this.src='https://placehold.co/400x300?text=Campus+Eats'; this.classList.add('loaded');" />`
          : `<div class="home-food-img-fallback"><i data-lucide="utensils"></i></div>`}
        ${outOfStock ? `<div class="out-of-stock-overlay">Out of Stock</div>` : ''}
      </div>
      <div class="menu-card-body">
        <div class="menu-card-title-row"><span class="font-bold">${esc(item.name)}</span></div>
        ${item.rating_count > 0 ? `<div class="rating-inline"><i data-lucide="star" style="width:12px;height:12px;"></i> ${(item.rating || 0).toFixed(1)} <span class="text-muted" style="font-weight:500;">(${item.rating_count})</span></div>` : ''}
        ${store ? `<div class="text-xs text-muted" style="margin:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(store.name)}</div>` : ''}
        <p class="menu-card-desc">${esc(item.description || '')}</p>
        <div class="menu-card-footer">
          <span class="price-tag">${money(item.price)}</span>
          <button class="btn btn-primary btn-sm" data-action="store-quick-add" data-id="${esc(item.id)}" ${outOfStock ? 'disabled' : ''}>
            ${outOfStock ? 'Unavailable' : '<i data-lucide="plus"></i>Add'}
          </button>
        </div>
      </div>
    </div>`;
  }

  function skeletonFoodCard() {
    return `<div class="card">
      <div class="skeleton" style="aspect-ratio:4/3;border-radius:16px 16px 0 0;"></div>
      <div style="padding:14px;">
        <div class="skeleton" style="height:14px;width:70%;margin-bottom:8px;"></div>
        <div class="skeleton" style="height:11px;width:90%;margin-bottom:6px;"></div>
        <div class="skeleton" style="height:16px;width:35%;"></div>
      </div>
    </div>`;
  }

  // ---------------- Hero ----------------
  // Rotates through every currently-approved store promotion (not just
  // the top one) — each fills the fixed-size media box edge-to-edge via
  // a real <img>/<video> (object-fit: cover, css/home.css), so a
  // portrait, square or landscape ad never leaves black/empty bars; a
  // mismatched aspect ratio is center-cropped instead.
  //
  // The rotation timer used to call the app's full App.render(), which
  // replaces #app's entire innerHTML — every 6 seconds, regardless of
  // where the user was scrolled to or what they were doing. That's a
  // real, measured cause of the whole page visibly jumping/flickering on
  // rotation (destroying and recreating every DOM node on the page,
  // restarting every icon and animation, is real reflow work, not an
  // illusion). refreshHeroDom() instead replaces ONLY the
  // #hero-banner-root subtree, so nothing else on the page is ever
  // touched by a rotation tick — scroll position is therefore
  // structurally impossible to disturb, since nothing above or below the
  // hero box changes size or gets torn down.
  function startHeroRotation() {
    if (local._heroRotationStarted) return;
    local._heroRotationStarted = true;
    setInterval(() => {
      const promos = activeStorePromotions();
      if (promos.length > 1) {
        local.heroIndex = (local.heroIndex + 1) % promos.length;
        refreshHeroDom();
      }
    }, 6000);
  }

  function refreshHeroDom() {
    const root = document.getElementById('hero-banner-root');
    if (!root) return; // navigated away from the home screen — nothing to update
    // Clicking a hero dot leaves IT focused; outerHTML then destroys that
    // very button, and the browser's default focus-fallback to <body>
    // scrolls the page back to the top — a real, measured scroll jump,
    // not a hypothetical one. Restoring scrollY right after the replace
    // closes that gap regardless of what triggered the refresh (the
    // 6-second timer never has this problem since nothing is focused,
    // but a manual dot click always does).
    const scrollY = window.scrollY;
    root.outerHTML = heroSection();
    window.scrollTo(0, scrollY);
    if (window.lucide) lucide.createIcons();
  }

  // Fires off the next promo's media request ahead of time so the
  // rotation's <video>/<img> swap loads from the browser's cache instead
  // of starting a fresh network request the moment it becomes visible.
  // Never appended to the page — this element only exists to make the
  // browser fetch and buffer the file.
  function preloadNextHeroMedia(promos, idx) {
    if (promos.length < 2) return;
    const next = promos[(idx + 1) % promos.length];
    if (next.media_type === 'video' && next.video_url) {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.src = next.video_url; v.load();
    } else if (next.image_url) {
      new Image().src = next.image_url;
    }
  }

  // Features every real, developer-approved store promotion when at least
  // one exists; otherwise a plain static branded section (no fake/AI
  // imagery either way). Shows only the media itself plus the Order Now
  // button — no badge/title/shop-name text overlay, per spec, which also
  // means there's no readability gradient sitting over the photo/video
  // dulling it.
  function heroSection() {
    startHeroRotation();
    const promos = activeStorePromotions();
    if (promos.length) {
      const idx = (local.heroIndex || 0) % promos.length;
      const featured = promos[idx];
      preloadNextHeroMedia(promos, idx);
      // A company-wide placement (schema.sql section 26) has no store_id
      // at all — there's no specific shop to open, so the whole card and
      // its button just scroll down to the store list instead, same as
      // the no-promotion fallback below.
      const linkAction = featured.store_id ? `data-action="open-store" data-id="${esc(featured.store_id)}"` : `data-action="hero-scroll"`;
      return `
      <div class="hero-banner-wrap" id="hero-banner-root">
        <div class="hero-banner-media" ${linkAction}>
          ${featured.media_type === 'video' && featured.video_url
            ? `<video class="hero-banner-img" src="${esc(featured.video_url)}" autoplay muted loop playsinline></video>`
            : featured.image_url
            ? `<img class="hero-banner-img" src="${esc(featured.image_url)}" alt="${esc(featured.title)}" />`
            : `<div class="hero-banner-img-placeholder"><i data-lucide="megaphone"></i></div>`}
          ${promos.length > 1 ? `
          <div class="hero-dots">
            ${promos.map((p, i) => `<button type="button" class="hero-dot ${i === idx ? 'active' : ''}" data-action="hero-goto" data-index="${i}" aria-label="Show advertisement ${i + 1} of ${promos.length}"></button>`).join('')}
          </div>` : ''}
          <div class="hero-banner-info">
            <button type="button" class="btn btn-primary btn-lg hero-cta" ${linkAction}>Order Now <i data-lucide="arrow-right"></i></button>
          </div>
        </div>
      </div>`;
    }
    return `
    <div class="hero-banner-wrap">
      <div class="hero-banner-static" data-action="hero-scroll">
        <h1 class="hero-title">Good Food<br>Great Vibes</h1>
        <p class="hero-sub">Fresh food • Fast service • Right on campus</p>
        <button type="button" class="btn btn-primary btn-lg hero-cta" data-action="hero-scroll">Order Now <i data-lucide="arrow-right"></i></button>
      </div>
    </div>`;
  }

  function storeLocations() {
    const locs = new Set(allStores().map(s => s.campus_location).filter(Boolean));
    return ['All', ...locs];
  }

  function activePromo() {
    const promos = (S.state.promotions || []).filter(p => p.active &&
      (!p.expires_at || new Date(p.expires_at) > new Date()) &&
      (!p.usage_limit || (p.used_count || 0) < p.usage_limit));
    return promos[0] || null;
  }

  // ---------------- Store-purchased promotional placements ----------------
  function activeStorePromotions() {
    const now = new Date();
    return (S.state.storePromotions || [])
      .filter(p => p.status === 'approved' && p.active && (!p.start_date || new Date(p.start_date) <= now) && (!p.end_date || new Date(p.end_date) > now))
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  function cartCount() {
    return (S.state.cart || []).reduce((sum, c) => sum + (c.qty || 0), 0);
  }

  // A real aggregate across every currently visible shop's own real
  // prep_time_min/max — never a fabricated single "ETA" number. Shown in
  // the homepage's location/pickup-time strip.
  function pickupEtaRange() {
    const stores = allStores();
    if (!stores.length) return null;
    const min = Math.min(...stores.map(s => s.prep_time_min || 99));
    const max = Math.max(...stores.map(s => s.prep_time_max || 0));
    if (!isFinite(min) || !isFinite(max) || max <= 0) return null;
    return `${min}-${max} min`;
  }

  // Compact horizontal shop card for the "Popular Shops" row — distinct
  // from storeCard() (the full-width list card used in "All stores on
  // campus"), same real fields (logo/cover, name, rating, prep time,
  // open state), just laid out for a horizontal scroller.
  function storeMiniCard(store) {
    const open = App.Stores.isOpenNow(store);
    return `
    <div class="store-mini-card" data-action="open-store" data-id="${esc(store.id)}">
      <div class="store-mini-img">
        ${store.cover_image_url ? `<img src="${esc(store.cover_image_url)}" alt="${esc(store.name)}" loading="lazy" />` : `<div class="store-mini-img-fallback"><i data-lucide="store"></i></div>`}
        <span class="badge ${open ? 'badge-success' : 'badge-error'} store-mini-status">${open ? 'OPEN' : 'CLOSED'}</span>
      </div>
      <div class="store-mini-body">
        <div class="store-mini-name">${esc(store.name)}</div>
        <div class="store-mini-meta">${ratingBadge(store)}<span class="dot">•</span><span>${store.prep_time_min}-${store.prep_time_max} min</span></div>
      </div>
    </div>`;
  }

  // Horizontal "Promotions" row — real store_promotions rows only,
  // developer-controlled end to end (RLS blocks any manager write —
  // schema.sql section 27), never something a shop manager can add here.
  function promoMiniCard(promo) {
    const store = promo.store_id ? App.Stores.getById(promo.store_id) : null;
    const linkAction = promo.store_id ? `data-action="open-store" data-id="${esc(promo.store_id)}"` : `data-action="hero-scroll"`;
    return `
    <div class="promo-mini-card" ${linkAction}>
      <div class="promo-mini-img">
        ${promo.media_type === 'video' && promo.video_url
          ? `<video src="${esc(promo.video_url)}" muted loop playsinline autoplay></video>`
          : promo.image_url ? `<img src="${esc(promo.image_url)}" alt="${esc(promo.title)}" loading="lazy" />` : ''}
      </div>
      <div class="promo-mini-title">${esc(promo.title)}</div>
      <div class="promo-mini-sub">${esc(promo.message || (store ? `From ${store.name}` : 'From clickFud'))}</div>
    </div>`;
  }

  // Shop listing card — info sits OUTSIDE/above a compact, wide, short
  // cover image (never overlaid on top of it), same structure the
  // marketplace-app reference used: availability line, name + heart,
  // rating/category row, then the image. One shared function used by
  // every shop listing (Popular Shops, All Stores, search/category
  // results all just filter/sort the same array before this same call)
  // so this design applies everywhere automatically.
  function storeCard(store) {
    const open = App.Stores.isOpenNow(store);
    const cover = store.cover_image_url ? esc(store.cover_image_url) : '';
    const isFav = (S.state.favoriteStores || []).includes(store.id);
    const availability = open ? 'Open now' : `Opens at ${esc(String(store.opening_time || '').slice(0, 5))}`;
    return `
      <div class="card card-hover store-card" data-action="open-store" data-id="${esc(store.id)}">
        <div class="store-card-info">
          <div class="store-card-avail ${open ? 'is-open' : ''}">${availability}</div>
          <div class="store-card-name-row">
            ${store.logo_url ? `<img class="store-card-logo" src="${esc(store.logo_url)}" alt="" />` : `<div class="store-card-logo store-card-logo-fallback"><i data-lucide="utensils" style="width:12px;height:12px;"></i></div>`}
            <h3 class="store-card-name">${esc(store.name)}</h3>
            <button type="button" class="store-card-fav-btn ${isFav ? 'active' : ''}" data-action="toggle-favorite-store" data-id="${esc(store.id)}" aria-label="${isFav ? 'Remove from favorites' : 'Add to favorites'}">
              <i data-lucide="heart" style="${isFav ? 'fill:currentColor' : ''}"></i>
            </button>
          </div>
          <div class="store-card-rating-row">
            <span>${ratingBadge(store)}</span>
            <span class="dot">•</span>
            <span class="text-muted">${esc(store.category)}</span>
          </div>
        </div>
        <div class="store-card-cover">
          <div class="store-card-cover-img-wrap">
            ${cover ? `<img class="fade-img" src="${cover}" alt="${esc(store.name)}" loading="lazy" onload="this.classList.add('loaded')" />` : `<div class="store-card-cover-fallback"><i data-lucide="store"></i></div>`}
          </div>
          <span class="badge ${open ? 'badge-success' : 'badge-error'} store-card-status">${open ? 'OPEN' : 'CLOSED'}</span>
        </div>
      </div>`;
  }

  function skeletonStoreCard() {
    return `<div class="card">
      <div class="skeleton" style="aspect-ratio:16/9;border-radius:20px 20px 0 0;"></div>
      <div style="padding:14px;">
        <div class="skeleton" style="height:16px;width:65%;margin-bottom:10px;"></div>
        <div class="skeleton" style="height:11px;width:40%;margin-bottom:8px;"></div>
        <div class="skeleton" style="height:11px;width:80%;"></div>
      </div>
    </div>`;
  }

  // ---------------- Browser (store discovery) ----------------
  function renderBrowser() {
    if (!S.state.dataReady) {
      return `
      <div class="storefront-topbar skeleton" style="height:110px;border-radius:0;"></div>
      <div class="storefront-curved">
        <div class="skeleton" style="height:46px;border-radius:999px;margin-bottom:14px;"></div>
        <div class="category-icon-row mb-4">${Array(6).fill(0).map(() => `<div class="skeleton" style="width:64px;height:64px;border-radius:50%;flex-shrink:0;"></div>`).join('')}</div>
        <div class="skeleton hero-banner-skeleton mb-4"></div>
        <div class="grid grid-menu mb-4">${Array(4).fill(0).map(skeletonFoodCard).join('')}</div>
        <div class="grid grid-menu">${Array(6).fill(0).map(skeletonStoreCard).join('')}</div>
      </div>`;
    }

    const promo = activePromo();
    const popular = popularStores();
    // "All stores on campus" shouldn't repeat a shop's large cover image
    // right after "Popular Shops" already showed it — but only while the
    // customer hasn't actually asked to search/filter/sort anything. The
    // moment they type a search term, pick a category/location, or turn
    // on "Open now", that's explicit intent to find a specific shop, so
    // every match (including ones featured above) must still show up —
    // matches by real store.id, never by name/image, and never touches
    // the underlying stores array or any other page's data.
    const isDefaultBrowse = local.search === '' && local.category === 'All' && local.location === 'All' && !local.openNowOnly;
    const popularIds = new Set(popular.map(s => s.id));
    let stores = filteredStores();
    if (isDefaultBrowse) {
      const deduped = stores.filter(s => !popularIds.has(s.id));
      // Never let this de-dup step empty the section entirely — with
      // only a handful of real shops live (a new/testing marketplace),
      // every single one can legitimately also be "popular", and hiding
      // all of them here made "All" look broken/empty instead of just
      // skipping one repeated big card. A little repetition is far
      // better than an apparently-empty storefront.
      if (deduped.length) stores = deduped;
    }
    const locations = storeLocations();
    const reorder = reorderItems();
    const foodCats = foodCategories();
    const recommended = recommendedItems();
    const eta = pickupEtaRange();
    const pickupLocation = (S.state.profile && S.state.profile.campus_location) || locations.find(l => l !== 'All') || 'On campus';
    // Skip whichever promo the hero above is already showing full-size —
    // same real store_promotions rows, just never shown twice on one page.
    const promoRow = activeStorePromotions().slice(1);

    // The Top Advert is a single developer-controlled slot, entirely
    // separate from store_promotions/activeStorePromotions above — RLS
    // (schema.sql section 28) means this can only ever be null or an
    // already published+active row, never a draft, so no extra status
    // check is needed here. While null, the topbar is just its plain
    // black pills row. Once an advert exists, its image/video IS the
    // topbar's own full-bleed background — not a separate inset box
    // with black space around it — and the pickup/ETA pills sit on top
    // of it directly, so the real photo fills the whole area edge to
    // edge.
    const advert = S.state.topAdvert;
    const hasAdvert = !!(advert && advert.media_url);
    return `
    <div class="storefront-topbar${hasAdvert ? ' has-media' : ''}">
      ${hasAdvert ? `
      <div class="storefront-topbar-media">
        ${advert.media_type === 'video'
          ? `<video src="${esc(advert.media_url)}" autoplay muted loop playsinline></video>`
          : `<img src="${esc(advert.media_url)}" alt="${esc(advert.title || 'Advertisement')}" />`}
      </div>` : ''}
      <div class="storefront-topbar-pills">
        <div class="storefront-topbar-pickup"><i data-lucide="map-pin" style="width:12px;height:12px;"></i> ${esc(pickupLocation)}</div>
        ${eta ? `<div class="storefront-topbar-eta">${esc(eta)}</div>` : ''}
      </div>
      ${hasAdvert && (advert.title || advert.promo_text) ? `
      <div class="storefront-advert-caption">
        ${advert.title ? `<div class="storefront-advert-title">${esc(advert.title)}</div>` : ''}
        ${advert.promo_text ? `<div class="storefront-advert-sub">${esc(advert.promo_text)}</div>` : ''}
      </div>` : ''}
    </div>
    <div class="storefront-curved">
      ${S.state.dataLoadError ? `
      <div class="closed-banner mb-3">
        <i data-lucide="alert-circle"></i>
        <div style="flex:1;"><strong>Unable to load food right now.</strong><div class="text-sm">Please check your connection and try again.</div></div>
        <button type="button" class="btn btn-secondary btn-sm" data-action="retry-load">Retry</button>
      </div>` : ''}

      <div class="search-bar mb-3" id="discover-section">
        <i data-lucide="search"></i>
        <input type="text" id="discover-search-input" placeholder="Search food, meals or shops" value="${esc(local.search)}" data-action-input="marketplace-search" aria-label="Search stores or food" />
      </div>

      ${locations.length > 2 ? `
      <div class="location-select-row mb-3">
        <i data-lucide="map-pin" style="width:14px;height:14px;color:var(--color-primary);"></i>
        <select class="select location-select" data-action-change="marketplace-location">
          ${locations.map(l => `<option value="${esc(l)}" ${local.location === l ? 'selected' : ''}>${l === 'All' ? 'All Campus Locations' : esc(l)}</option>`).join('')}
        </select>
      </div>` : ''}

      ${promo ? `<div class="promo-banner mb-3"><i data-lucide="tag"></i>${promo.type === 'percentage' ? `${promo.value}% off` : `${money(promo.value)} off`} with code <strong>${esc(promo.code)}</strong> — applied at checkout!</div>` : ''}

      ${foodCats.length ? `
      <div class="flex justify-between items-center mb-2">
        <span class="section-title" style="font-size:16px;">Food Categories</span>
      </div>
      <div class="category-icon-row mb-4">
        <button class="category-icon-card ${local.foodCategory === 'All' ? 'active' : ''}" data-action="food-category" data-category="All">
          <span class="category-icon-badge"><i data-lucide="layout-grid"></i></span><span>All</span>
        </button>
        ${foodCats.map(c => `
        <button class="category-icon-card ${local.foodCategory === c ? 'active' : ''}" data-action="food-category" data-category="${esc(c)}">
          <span class="category-icon-badge"><i data-lucide="${FOOD_CATEGORY_ICONS[c] || 'utensils'}"></i></span><span>${esc(c)}</span>
        </button>`).join('')}
      </div>` : ''}

      ${heroSection()}

      ${popular.length ? `
      <div class="flex justify-between items-center mb-2">
        <span class="section-title" style="font-size:16px;">Popular Shops</span>
        <button type="button" class="view-all-link" data-action="storefront-goto" data-target="all-stores-section">View All</button>
      </div>
      <div class="store-mini-row mb-4">${popular.map(storeMiniCard).join('')}</div>` : ''}

      ${reorder.length ? `
      <div class="flex justify-between items-center mb-2">
        <span class="section-title" style="font-size:16px;">Order it again</span>
      </div>
      <div class="reorder-row mb-4">${reorder.map(reorderCard).join('')}</div>` : ''}

      <div class="flex justify-between items-center mb-2">
        <span class="section-title" style="font-size:16px;">Popular Near You</span>
        <button type="button" class="view-all-link" data-action="storefront-goto" data-target="explore-categories-section">View All</button>
      </div>
      ${recommended.length
        ? `<div class="recommended-row mb-4">${recommended.map(recommendedFoodCard).join('')}</div>`
        : `<div class="empty-state mb-4"><div class="icon-wrap"><i data-lucide="utensils-crossed"></i></div><h3>No recommendations yet</h3><p class="text-sm">We couldn't find recommended meals right now.</p></div>`}

      ${promoRow.length ? `
      <div class="flex justify-between items-center mb-2">
        <span class="section-title" style="font-size:16px;">Promotions</span>
      </div>
      <div class="promo-mini-row mb-4">${promoRow.map(promoMiniCard).join('')}</div>` : ''}

      <div class="flex justify-between items-center mb-2" id="explore-categories-section">
        <span class="section-title" style="font-size:15px;">Explore categories</span>
      </div>
      <div class="chip-row mb-4">
        ${storeCategories().map(c => `<button class="chip ${local.category === c ? 'active' : ''}" data-action="marketplace-category" data-category="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>

      ${stores.length ? `
      <div class="flex justify-between items-center mb-2" id="all-stores-section" style="flex-wrap:wrap;gap:8px;">
        <span class="section-title" style="font-size:16px;">All stores on campus</span>
        <div class="flex items-center gap-2" style="flex-wrap:wrap;">
          <select class="select" style="min-height:34px;padding:6px 10px;font-size:12.5px;" data-action-change="marketplace-sort">
            <option value="recommended" ${local.sort === 'recommended' ? 'selected' : ''}>Recommended</option>
            <option value="rating" ${local.sort === 'rating' ? 'selected' : ''}>Top Rated</option>
            <option value="fastest" ${local.sort === 'fastest' ? 'selected' : ''}>Fastest Pickup</option>
          </select>
          <button class="chip ${local.openNowOnly ? 'active' : ''}" data-action="marketplace-toggle-open"><i data-lucide="clock" style="width:13px;height:13px;"></i> Open now</button>
        </div>
      </div>
      <div class="grid grid-menu">${stores.map(storeCard).join('')}</div>` : ''}
    </div>`;
  }

  // ---------------- Store detail (shop page) ----------------
  // Real distinct category names, in first-appearance order — never
  // hard-coded. A manager's own category names (however they spelled
  // them) are exactly what shows up here and in the section headings
  // below.
  function storeMenuCategoryNames(storeId) {
    const items = visibleMenu().filter(m => m.store_id === storeId);
    const names = [];
    items.forEach(m => { if (m.category && !names.includes(m.category)) names.push(m.category); });
    return names;
  }

  // "Most Liked" reuses the exact same real signal this app already used
  // for its previous single "Popular" filter (rating_count) — not a new
  // invented metric, just shown as its own horizontal row now instead of
  // gating out every other category. With zero ratings yet, this still
  // surfaces the shop's own items (never fabricated stats) rather than
  // showing nothing.
  function storeMostLiked(items) {
    return [...items].sort((a, b) => (b.rating_count || 0) - (a.rating_count || 0)).slice(0, 8);
  }

  function shopProductCard(item) {
    const outOfStock = App.Menu.isOutOfStock(item);
    return `
    <div class="shop-prod-card" data-action="open-food" data-id="${esc(item.id)}">
      <div class="shop-prod-img">
        <img src="${esc(item.image || '')}" alt="${esc(item.name)}" loading="lazy" onerror="this.src='https://placehold.co/400x300?text=Campus+Eats'">
        ${outOfStock ? `<div class="out-of-stock-overlay">Out of Stock</div>` : ''}
      </div>
      <div class="shop-prod-body">
        <div class="shop-prod-name">${esc(item.name)}</div>
        ${item.rating_count ? `<div class="shop-prod-rating"><i data-lucide="star" style="width:11px;height:11px;fill:#FFC107;color:#FFC107;"></i> ${Number(item.rating || 0).toFixed(1)} (${item.rating_count})</div>` : ''}
        <div class="shop-prod-footer">
          <span class="shop-prod-price">${money(item.price)}</span>
          <button class="shop-prod-add" data-action="store-quick-add" data-id="${esc(item.id)}" ${outOfStock ? 'disabled' : ''} aria-label="Add ${esc(item.name)} to cart">
            <i data-lucide="plus"></i>
          </button>
        </div>
      </div>
    </div>`;
  }

  // Re-run every time the shop page renders (search, cart updates, etc.
  // all re-render #app) — always disconnects any previous observer
  // first since the DOM nodes it was watching no longer exist after a
  // re-render. Purely visual (which nav chip is "active"); never touches
  // app state or triggers a re-render itself, so scrolling the menu never
  // re-renders the whole page just to update a highlight.
  function initShopScrollSpy() {
    if (local._shopObserver) { local._shopObserver.disconnect(); local._shopObserver = null; }
    const sections = [...document.querySelectorAll('.shop-section[data-nav-index]')];
    if (!sections.length) return;
    const setActive = (idx) => {
      document.querySelectorAll('.shop-cat-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.navIndex === String(idx));
      });
    };
    local._shopObserver = new IntersectionObserver((entries) => {
      const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length) setActive(visible[0].target.dataset.navIndex);
    }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });
    sections.forEach(sec => local._shopObserver.observe(sec));
  }

  // Every shop's own shareable deep link — reading it back is handled at
  // boot (js/app.js parseSharedStoreLink()), which routes straight to
  // this same store detail view. Built fresh per shop, never hard-coded.
  function shareUrlForStore(storeId) {
    const url = new URL(window.location.href);
    url.search = ''; url.hash = '';
    url.searchParams.set('store', storeId);
    return url.toString();
  }

  function shareStore(store) {
    const url = shareUrlForStore(store.id);
    const text = `Check out ${store.name} on clickFud!`;
    if (navigator.share) {
      navigator.share({ title: `${store.name} — clickFud`, text, url }).catch(() => {});
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(`${text} ${url}`)
        .then(() => App.Toast.success('Link copied to clipboard'))
        .catch(() => App.Toast.info(url));
      return;
    }
    App.Toast.info(url);
  }

  function storeInfoModal(store) {
    const open = App.Stores.isOpenNow(store);
    const rows = [
      ['Address', esc(store.campus_location || store.university || '—')],
      ['Rating', store.rating_count ? `${Number(store.rating || 0).toFixed(1)} ★ (${store.rating_count})` : 'No ratings yet'],
      ['Hours', `${esc(String(store.opening_time || '').slice(0, 5))} – ${esc(String(store.closing_time || '').slice(0, 5))}`],
      ['Status', open ? 'Open now' : 'Closed'],
      ['Prep time', `${store.prep_time_min}-${store.prep_time_max} min`],
    ];
    rows.push(['Pickup', store.accepts_collection ? 'Available' : 'Not available']);
    if (store.contact_phone) rows.push(['Phone', esc(store.contact_phone)]);
    if (store.contact_email) rows.push(['Email', esc(store.contact_email)]);
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">${esc(store.name)}</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        ${rows.map(([label, value]) => `<div class="store-info-row"><span class="store-info-row-label">${label}</span><span class="store-info-row-value">${value}</span></div>`).join('')}
      </div>`);
  }

  function shopOptionsSheet(storeId) {
    const store = App.Stores.getById(storeId);
    if (!store) return;
    const isFav = (S.state.favoriteStores || []).includes(storeId);
    App.Modal.open(`
      <button type="button" class="sheet-item" data-action="sheet-search-store"><i data-lucide="search"></i><span class="sheet-item-label">Search this store</span></button>
      <button type="button" class="sheet-item ${isFav ? 'active-fav' : ''}" data-action="sheet-toggle-favorite" data-id="${esc(storeId)}"><i data-lucide="heart" style="${isFav ? 'fill:currentColor' : ''}"></i><span class="sheet-item-label">${isFav ? 'Remove from favourites' : 'Add to favourites'}</span></button>
      <button type="button" class="sheet-item" data-action="sheet-group-order"><i data-lucide="users"></i><span class="sheet-item-label">Group order</span></button>
      <button type="button" class="sheet-item" data-action="sheet-share" data-id="${esc(storeId)}"><i data-lucide="share-2"></i><span class="sheet-item-label">Share</span></button>
      <button type="button" class="sheet-item" data-action="sheet-store-info" data-id="${esc(storeId)}">
        <i data-lucide="info"></i>
        <span><span class="sheet-item-label">Store info</span><div class="sheet-item-sub">Address, ratings and more</div></span>
      </button>`, { sheet: true });
  }

  function renderStoreDetail(storeId) {
    const store = App.Stores.getById(storeId);
    if (!store) {
      // A shared-link visit (?store=<id>) opens straight into this view
      // before App.Bootstrap.loadPublicData() has actually fetched any
      // stores yet — that's a normal loading gap, not a real 404, so it
      // gets a skeleton instead of a dead-end "not found" message that
      // would otherwise flash for a moment on every cold load.
      if (!S.state.dataReady) return `<div class="storefront"><div class="skeleton hero-banner-skeleton mb-4"></div></div>`;
      return `<div class="page-wrap"><div class="empty-state"><div class="icon-wrap"><i data-lucide="store"></i></div><h3>Store not found</h3><button class="btn btn-secondary mt-3" data-action="go-home">Back to stores</button></div></div>`;
    }
    const open = App.Stores.isOpenNow(store);
    const search = local.storeSearch[storeId] || '';
    const isShopFav = (S.state.favoriteStores || []).includes(storeId);
    let items = visibleMenu().filter(m => m.store_id === storeId);

    let menuBody;
    if (search) {
      // Search collapses the categorized layout into one flat results
      // grid — existing search behavior, just restyled onto the new card.
      const t = search.toLowerCase();
      const results = items.filter(m => m.name.toLowerCase().includes(t) || (m.description || '').toLowerCase().includes(t));
      menuBody = results.length
        ? `<div class="shop-menu-grid">${results.map(shopProductCard).join('')}</div>`
        : `<div class="empty-state"><div class="icon-wrap"><i data-lucide="utensils-crossed"></i></div><h3>No matches</h3><p class="text-sm">Try a different search term.</p></div>`;
    } else if (!items.length) {
      menuBody = `<div class="empty-state"><div class="icon-wrap"><i data-lucide="utensils-crossed"></i></div><h3>No items here yet</h3><p class="text-sm">${esc(store.name)} hasn't added menu items yet.</p></div>`;
    } else {
      const catNames = storeMenuCategoryNames(storeId);
      const mostLiked = storeMostLiked(items);
      const navChips = ['Most Liked', ...catNames];
      setTimeout(initShopScrollSpy, 0);
      menuBody = `
      <div class="shop-cat-nav">
        ${navChips.map((c, i) => `<button type="button" class="shop-cat-chip" data-action="shop-goto-category" data-nav-index="${i}">${esc(c)}</button>`).join('')}
      </div>
      <section class="shop-section" id="shop-sec-0" data-nav-index="0">
        <h2 class="shop-section-title">Most Liked</h2>
        <div class="shop-popular-row">${mostLiked.map(shopProductCard).join('')}</div>
      </section>
      ${catNames.map((cat, i) => `
      <section class="shop-section" id="shop-sec-${i + 1}" data-nav-index="${i + 1}">
        <h2 class="shop-section-title">${esc(cat)}</h2>
        <div class="shop-menu-grid">${items.filter(m => m.category === cat).map(shopProductCard).join('')}</div>
      </section>`).join('')}`;
    }

    return `
    <div class="store-detail">
      <div class="shop-hero">
        ${store.cover_image_url ? `<img class="fade-img" src="${esc(store.cover_image_url)}" alt="${esc(store.name)}" onload="this.classList.add('loaded')" />` : `<div class="shop-hero-fallback"><i data-lucide="store"></i></div>`}
        <div class="shop-hero-actions">
          <button type="button" class="shop-hero-icon-btn" data-action="go-home" aria-label="Back to stores"><i data-lucide="arrow-left"></i></button>
          <div class="shop-hero-actions-right">
            <button type="button" class="shop-hero-icon-btn" data-action="shop-focus-search" aria-label="Search this menu"><i data-lucide="search"></i></button>
            <button type="button" class="shop-hero-icon-btn ${isShopFav ? 'active' : ''}" data-action="toggle-favorite-store" data-id="${esc(storeId)}" aria-label="${isShopFav ? 'Remove from favourites' : 'Add to favourites'}"><i data-lucide="heart" style="${isShopFav ? 'fill:currentColor' : ''}"></i></button>
            <button type="button" class="shop-hero-icon-btn" data-action="shop-open-menu" data-id="${esc(storeId)}" aria-label="More options"><i data-lucide="more-vertical"></i></button>
          </div>
        </div>
      </div>
      <div class="storefront-curved">
        <div class="shop-info-card">
          <div class="shop-info-name-row">
            ${store.logo_url ? `<img class="shop-info-logo" src="${esc(store.logo_url)}" alt="" />` : `<div class="shop-info-logo store-card-logo-fallback"><i data-lucide="utensils" style="width:16px;height:16px;"></i></div>`}
            <h1 class="shop-info-name">${esc(store.name)}</h1>
          </div>
          ${store.category ? `<div class="text-sm text-muted mb-1">${esc(store.category)}</div>` : ''}
          <div class="shop-info-meta-row">
            <span class="shop-info-rating">${ratingBadge(store)}</span>
            <span class="dot">•</span>
            <span>${store.prep_time_min}-${store.prep_time_max} min</span>
            <span class="dot">•</span>
            <span class="${open ? '' : 'text-muted'}" style="${open ? 'color:var(--color-success);font-weight:700;' : ''}">${open ? 'Open now' : 'Closed'}</span>
          </div>
          <div class="shop-info-meta-row mt-1">
            <span class="shop-info-location"><i data-lucide="map-pin" style="width:12px;height:12px;flex-shrink:0;"></i> ${esc(store.campus_location || store.university || '')}</span>
          </div>
          <div class="shop-info-badges">
            ${store.accepts_collection ? `<span class="shop-fulfil-chip"><i data-lucide="shopping-bag" style="width:12px;height:12px;"></i> Pickup</span>` : ''}
          </div>
        </div>

        ${!open ? `<div class="closed-banner"><i data-lucide="clock"></i><div><strong>${esc(store.name)} is closed</strong><div class="text-sm">${esc(App.Stores.closedMessage(store))}</div></div></div>` : ''}

        <div class="search-bar mb-3">
          <i data-lucide="search"></i>
          <input type="text" id="store-search-input" placeholder="Search ${esc(store.name)}'s menu..." value="${esc(search)}" data-action-input="store-search" data-store-id="${esc(storeId)}" aria-label="Search menu" />
        </div>

        ${menuBody}

        ${store.rating_count ? `<div class="shop-section" style="margin-top:28px;"><h2 class="shop-section-title">Ratings</h2>${ratingBreakdown(store)}</div>` : ''}
      </div>
    </div>`;
  }

  // ---------------- Public (logged-out) full page ----------------
  function categoryChips() { return storeCategories(); } // kept for backward compatibility of naming

  function render() {
    const route = S.state.route;
    const isStoreView = route.view === 'store' && route.params && route.params.storeId;
    const count = cartCount();

    return `
    <div class="home-page">
      <header class="home-header">
        <div class="home-header-inner container">
          <a href="#" class="home-brand" data-action="go-home">
            ${App.Shared.logoBadge()}
            <span class="home-brand-name">clickFud</span>
          </a>
          <div class="home-header-actions">
            <button type="button" class="btn-icon home-cart-btn" data-action="open-cart" aria-label="Cart">
              <i data-lucide="shopping-cart"></i>
              ${count > 0 ? `<span class="home-cart-badge">${count}</span>` : ''}
            </button>
            <button type="button" class="btn-icon" data-action="toggle-theme" aria-label="Toggle theme"><i data-lucide="sun-moon"></i></button>
            <button type="button" class="btn btn-secondary btn-sm home-login-btn" data-action="go-auth" data-tab="login">Login</button>
            <button type="button" class="btn btn-primary btn-sm" data-action="go-auth" data-tab="signup">Sign Up</button>
          </div>
        </div>
      </header>

      <div class="home-content container">
        ${isStoreView ? renderStoreDetail(route.params.storeId) : renderBrowser()}
      </div>
    </div>`;
  }

  // ---------------- Shared action handling ----------------
  function addStoreItemToCart(id) {
    const item = S.state.menu.find(m => m.id === id);
    if (!item) return;
    if (!item.available || item.stock <= 0) { App.Toast.error(`"${item.name}" is currently unavailable.`); return; }
    const store = App.Stores.getById(item.store_id);
    S.addToCartWithConfirm({
      menuItemId: item.id, name: item.name, price: item.price, image: item.image,
      qty: 1, addons: [], specialInstructions: '',
      storeId: item.store_id, storeName: store ? store.name : '',
    }, { onAdded: () => App.Toast.success(`Added "${item.name}" to your cart.`) });
  }

  function handleAction(action, ds) {
    switch (action) {
      case 'open-store':
        // setRoute() never touches scroll position on its own — without
        // this, opening a shop from partway down a long store list left
        // the new (much shorter, differently laid out) shop page scrolled
        // to whatever pixel offset the list happened to be at, hiding its
        // own header/banner/category nav entirely on load.
        window.scrollTo(0, 0);
        return S.setRoute({ view: 'store', params: { storeId: ds.id } });
      case 'toggle-favorite-store':
        return S.toggleFavoriteStore(ds.id);
      case 'shop-open-menu':
        return shopOptionsSheet(ds.id);
      case 'sheet-search-store':
        App.Modal.close();
        return handleAction('shop-focus-search', {});
      case 'sheet-toggle-favorite':
        S.toggleFavoriteStore(ds.id);
        return App.Modal.close();
      case 'sheet-group-order':
        App.Modal.close();
        App.Toast.info('Group ordering is coming soon!');
        return;
      case 'sheet-share': {
        const store = App.Stores.getById(ds.id);
        App.Modal.close();
        if (store) shareStore(store);
        return;
      }
      case 'sheet-store-info': {
        const store = App.Stores.getById(ds.id);
        App.Modal.close();
        if (store) storeInfoModal(store);
        return;
      }
      case 'marketplace-category':
        local.category = ds.category;
        return App.render();
      case 'marketplace-toggle-open':
        local.openNowOnly = !local.openNowOnly;
        return App.render();
      case 'food-category':
        local.foodCategory = ds.category;
        return App.render();
      case 'retry-load':
        return App.Bootstrap.loadPublicData();
      case 'hero-scroll': {
        const el = document.getElementById('discover-section');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      case 'storefront-goto': {
        const el = document.getElementById(ds.target);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      case 'hero-goto':
        local.heroIndex = Number(ds.index) || 0;
        return refreshHeroDom();
      // Product detail/customization is owned by Customer (cart, add-ons,
      // favorites all live there) even though a logged-out guest can
      // reach this same card via Home — customer.js is always loaded
      // regardless of login state, so this just forwards to its existing
      // handler instead of duplicating it. Pre-existing gap (this action
      // was never wired up for guests before this page's redesign
      // either) fixed here since "product details/customization" is
      // exactly what this page must keep working for every visitor.
      case 'open-food':
        return App.Pages.Customer.handleAction('open-food', ds);
      case 'view-food-image':
        return App.Pages.Customer.handleAction('view-food-image', ds);
      case 'shop-goto-category': {
        const el = document.getElementById(`shop-sec-${ds.navIndex}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      case 'shop-focus-search': {
        const el = document.getElementById('store-search-input');
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
        return;
      }
      case 'store-quick-add':
      case 'home-add-cart':
      case 'reorder-quick-add':
        return addStoreItemToCart(ds.id);
      // A logged-out visitor can browse and build a cart, but there's no
      // account to attach an order to — App.Pages.Customer (which owns
      // real checkout) never even loads for a guest, so without this the
      // Checkout button in the cart slideover silently did nothing. Send
      // them to log in/sign up instead; their cart stays in localStorage
      // (keyed to the guest cart, not a user id) so it's still there once
      // they're signed in and can press Checkout again for real.
      case 'go-checkout':
        App.Slideover.close();
        App.Toast.info('Please log in or create an account to check out.');
        S.set({ forceAuthView: true });
        return App.Pages.Auth.setTab('login');
      default: return;
    }
  }

  function handleInput(kind, value, ds) {
    if (kind === 'marketplace-search') { local.search = value; App.render(); }
    if (kind === 'store-search') { local.storeSearch[ds.storeId] = value; App.render(); }
  }

  function handleChange(kind, ds, value) {
    if (kind === 'marketplace-location') { local.location = value; App.render(); }
    if (kind === 'marketplace-sort') { local.sort = value; App.render(); }
  }

  return {
    render, renderBrowser, renderStoreDetail, handleAction, handleInput, handleChange,
    addStoreItemToCart, local,
  };
})();
