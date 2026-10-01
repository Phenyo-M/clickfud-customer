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
    showAllShops: false, // "Discover Food Shops" (public marketing home) — false = top 6, true = every real live shop
    guestOrder: null,     // { fulfilment, university, campus } — set once a guest completes "Start Order" below; null = not chosen yet, shops shown unscoped
    guestOrderDraft: null, // in-progress selections while the Start Order modal is open
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
    // A guest who completed the "Start Order" flow below (home page
    // only, no account needed) has told us their campus directly —
    // scope the same way a signed-in customer's own profile would.
    if (!profile && local.guestOrder && local.guestOrder.campus) {
      return stores.filter(s => s.university === local.guestOrder.university && s.campus_location === local.guestOrder.campus);
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
  // A student can attend several campuses (profile.campuses) — a shop at
  // ANY of them ranks first.
  function myCampuses() {
    const profile = S.state.profile;
    return profile && profile.role === 'customer' ? App.Auth.campusesOf(profile) : [];
  }
  function campusRank(store) {
    const mine = myCampuses();
    if (!mine.length) return 0;
    return mine.includes(store.campus_location) ? 0 : 1;
  }
  function myCampusStores() {
    const mine = myCampuses();
    if (!mine.length) return [];
    return sortStores(allStores().filter(s => mine.includes(s.campus_location)));
  }
  function campusesLabel(list) {
    if (list.length <= 1) return list[0] || '';
    return list.slice(0, -1).join(', ') + ' & ' + list[list.length - 1];
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

  // Discovery card, not an ordering widget — tapping it goes straight to
  // the shop that actually sells this item (its menu is the only place
  // that can add it to a cart); there's deliberately no quick-add button
  // here any more (see the file header note on discovery vs. ordering).
  function reorderCard(item) {
    const store = App.Stores.getById(item.store_id);
    return `
      <div class="card card-hover reorder-card" data-action="open-store" data-id="${esc(item.store_id)}">
        <div class="reorder-card-img-wrap">
          ${item.image ? `<img onerror="this.onerror=null;this.src='icons/clickfud-icon-192.png';this.classList.add('img-fallback')" class="fade-img" src="${esc(item.image)}" alt="${esc(item.name)}" loading="lazy" onload="this.classList.add('loaded')" />` : `<div class="store-card-cover-fallback"><i data-lucide="utensils"></i></div>`}
        </div>
        <div class="card-pad" style="padding:12px;">
          <div class="font-semibold" style="font-size:13.5px;line-height:1.3;">${esc(item.name)}</div>
          <div class="text-xs text-muted" style="margin:2px 0 6px;">${store ? esc(store.name) : ''}</div>
          <span class="font-bold" style="font-size:13px;">${money(U.menuItemPrice(item))}</span>
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

  // Deliberately "starts with", not "contains anywhere" — typing "quarter"
  // should surface Quarter Chicken, not every item that happens to mention
  // it in a description. A category name also matches this way ("breakfast"
  // -> every Breakfast-category item), so a customer can search either a
  // dish or a whole meal category from the same box.
  function searchMatchesMenuItem(item, term) {
    const t = term.trim().toLowerCase();
    if (!t) return true;
    return item.name.toLowerCase().startsWith(t) || (item.category || '').toLowerCase().startsWith(t);
  }

  function recommendedItems() {
    const storeIds = visibleStoreIds();
    let items = visibleMenu().filter(m => storeIds.has(m.store_id) && m.available && m.stock > 0);
    if (local.foodCategory !== 'All') items = items.filter(m => m.category === local.foodCategory);
    if (local.search) items = items.filter(m => searchMatchesMenuItem(m, local.search));
    // Food from the student's own campus(es) first, then the rest.
    const itemRank = (m) => { const st = App.Stores.getById(m.store_id); return st ? campusRank(st) : 1; };
    const sorted = [...items].sort((a, b) => itemRank(a) - itemRank(b) || (b.rating || 0) - (a.rating || 0) || (b.rating_count || 0) - (a.rating_count || 0));
    // Only cap to a short row when this is the normal "Popular Near You"
    // teaser — an active search is meant to be the full, scrollable result
    // list, not a preview.
    return local.search ? sorted : sorted.slice(0, 8);
  }

  // Discovery card only — this is "Popular Near You" / search results, not
  // a shop's own menu, so there is deliberately no add-to-cart button
  // here. Tapping it opens the shop that sells the item (App.Stores
  // already owns the item<->store relationship via item.store_id, no new
  // lookup/state needed); the shop's own menu is where it can actually be
  // added, matching a real ordering app's browse->shop->order flow rather
  // than letting a discovery card double as a mini ordering widget.
  function recommendedFoodCard(item) {
    const store = App.Stores.getById(item.store_id);
    const outOfStock = App.Menu.isOutOfStock(item);
    return `
    <div class="card card-hover menu-card" data-action="open-store" data-id="${esc(item.store_id)}">
      <div class="menu-card-img">
        ${item.image ? `<img class="fade-img" src="${esc(item.image)}" alt="${esc(item.name)}" loading="lazy" onload="this.classList.add('loaded')" onerror="this.onerror=null;this.src='icons/clickfud-icon-192.png';this.classList.add('img-fallback'); this.classList.add('loaded');" />`
          : `<div class="home-food-img-fallback"><i data-lucide="utensils"></i></div>`}
        ${outOfStock ? `<div class="out-of-stock-overlay">Out of Stock</div>` : ''}
      </div>
      <div class="menu-card-body">
        <span class="menu-card-name">${esc(item.name)}</span>
        ${store ? `<div class="menu-card-store">${esc(store.name)}${item.rating_count > 0 ? ` · <i data-lucide="star" style="width:11px;height:11px;"></i> ${(item.rating || 0).toFixed(1)}` : ''}</div>` : ''}
        <div class="menu-card-footer">
          <span class="price-tag">${money(U.menuItemPrice(item))}</span>
          ${outOfStock ? `<span class="text-xs text-muted font-semibold">Unavailable</span>` : ''}
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

  // Updates the hero banner's media/link/dots IN PLACE instead of
  // replacing the whole subtree (root.outerHTML used to rebuild it from
  // scratch every single rotation tick). Even with the next image
  // preloaded, a brand-new <img>/<video> element still forces a fresh
  // decode+layout+paint — visible as a flash/flicker every 6 seconds,
  // which is what was actually causing the reported "vibrating" picture,
  // not an illusion. Swapping the existing element's src instead lets the
  // browser reuse the already-decoded, already-preloaded resource with no
  // visible transition at all. Only falls back to replacing the one media
  // element (not the whole hero) when the kind itself changes (e.g.
  // rotating from a video promo to an image promo).
  function refreshHeroDom() {
    const root = document.getElementById('hero-banner-root');
    if (!root) return; // navigated away from the home screen — nothing to update
    const promos = activeStorePromotions();
    if (!promos.length) return;
    const idx = (local.heroIndex || 0) % promos.length;
    const featured = promos[idx];
    preloadNextHeroMedia(promos, idx);

    const mediaWrap = root.querySelector('.hero-banner-media');
    if (!mediaWrap) return;

    const hasStore = !!featured.store_id;
    const applyLink = (el) => {
      el.dataset.action = hasStore ? 'open-store' : 'hero-scroll';
      if (hasStore) el.dataset.id = featured.store_id; else delete el.dataset.id;
    };
    applyLink(mediaWrap);
    const cta = root.querySelector('.hero-cta');
    if (cta) applyLink(cta);

    const wantVideo = featured.media_type === 'video' && !!featured.video_url;
    const wantImage = !wantVideo && !!featured.image_url;
    const existing = mediaWrap.querySelector('.hero-banner-img, .hero-banner-img-placeholder');

    if (wantVideo && existing && existing.tagName === 'VIDEO') {
      if (existing.getAttribute('src') !== featured.video_url) existing.src = featured.video_url;
    } else if (wantImage && existing && existing.tagName === 'IMG') {
      existing.src = featured.image_url;
      existing.alt = featured.title || '';
    } else {
      const html = wantVideo
        ? `<video class="hero-banner-img" src="${esc(featured.video_url)}" autoplay muted loop playsinline></video>`
        : wantImage
        ? `<img class="hero-banner-img" src="${esc(featured.image_url)}" alt="${esc(featured.title || '')}" />`
        : `<div class="hero-banner-img-placeholder"><i data-lucide="megaphone"></i></div>`;
      if (existing) existing.outerHTML = html; else mediaWrap.insertAdjacentHTML('afterbegin', html);
      if (window.lucide) lucide.createIcons({ context: mediaWrap });
    }

    root.querySelectorAll('.hero-dot').forEach((dot, i) => dot.classList.toggle('active', i === idx));
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
      <div class="hero-banner-wrap" id="hero-banner-root" data-hero-key="${esc(featured.id)}">
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

  // A shop's own promo codes — shown only on that shop's page.
  function shopPromos(storeId) {
    return (S.state.promotions || []).filter(p => p.active && p.store_id === storeId &&
      (!p.expires_at || new Date(p.expires_at) > new Date()) &&
      (!p.usage_limit || (p.used_count || 0) < p.usage_limit));
  }
  // "50% off Kota Boss — use code GH3356 at checkout."
  function promoText(p) {
    const amount = p.type === 'percentage' ? `${Number(p.value)}% off` : `${money(p.value)} off`;
    const what = App.Promotions.productName(p);
    return `${amount}${what ? ' ' + esc(what) : ''} — use code <strong>${esc(p.code)}</strong> at checkout.`;
  }

  // ---------------- Store-purchased promotional placements ----------------
  function activeStorePromotions() {
    const now = new Date();
    return (S.state.storePromotions || [])
      .filter(p => p.status === 'approved' && p.active && (!p.start_date || new Date(p.start_date) <= now) && (!p.end_date || new Date(p.end_date) > now))
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
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
        ${store.cover_image_url ? `<img onerror="this.onerror=null;this.src='icons/clickfud-icon-192.png';this.classList.add('img-fallback')" src="${esc(store.cover_image_url)}" alt="${esc(store.name)}" loading="lazy" />` : `<div class="store-mini-img-fallback"><i data-lucide="store"></i></div>`}
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
            ${store.logo_url ? `<img onerror="this.onerror=null;this.src='icons/clickfud-icon-192.png';this.classList.add('img-fallback')" class="store-card-logo" src="${esc(store.logo_url)}" alt="" />` : `<div class="store-card-logo store-card-logo-fallback"><i data-lucide="utensils" style="width:12px;height:12px;"></i></div>`}
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
            ${cover ? `<img onerror="this.onerror=null;this.src='icons/clickfud-icon-192.png';this.classList.add('img-fallback')" class="fade-img" src="${cover}" alt="${esc(store.name)}" loading="lazy" onload="this.classList.add('loaded')" />` : `<div class="store-card-cover-fallback"><i data-lucide="store"></i></div>`}
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
    const mine = myCampuses();
    const campusStores = myCampusStores();
    const pickupLocation = campusesLabel(mine) || locations.find(l => l !== 'All') || 'On campus';
    // Skip whichever promo the hero above is already showing full-size —
    // same real store_promotions rows, just never shown twice on one page.
    const promoRow = activeStorePromotions().slice(1);

    // Actively searching means the customer wants exactly one thing: the
    // matching food, and nothing else competing for their scroll — no
    // shops, no promos, no category browsing. Clearing the box (local.search
    // back to '') snaps straight back to the normal full layout below since
    // everything here is just driven by that one piece of state.
    const isSearching = !!local.search;
    if (isSearching) {
      return `
      <div class="storefront-topbar">
        <div class="storefront-topbar-pills">
          <div class="storefront-topbar-pickup"><i data-lucide="map-pin" style="width:12px;height:12px;"></i> ${esc(pickupLocation)}</div>
          ${eta ? `<div class="storefront-topbar-eta">${esc(eta)}</div>` : ''}
        </div>
      </div>
      <div class="storefront-curved">
        <div class="search-bar mb-3" id="discover-section">
          <i data-lucide="search"></i>
          <input type="text" id="discover-search-input" placeholder="Search food, meals or shops" value="${esc(local.search)}" data-action-input="marketplace-search" aria-label="Search stores or food" />
        </div>
        <div class="flex justify-between items-center mb-2">
          <span class="section-title" style="font-size:16px;">${recommended.length ? `Results for &ldquo;${esc(local.search)}&rdquo;` : ''}</span>
        </div>
        ${recommended.length
          ? `<div class="grid grid-menu">${recommended.map(recommendedFoodCard).join('')}</div>`
          : `<div class="empty-state mb-4"><div class="icon-wrap"><i data-lucide="search-x"></i></div><h3>No matches for "${esc(local.search)}"</h3><p class="text-sm">Try a different search term.</p></div>`}
      </div>`;
    }
    return `
    <div class="storefront-topbar">
      <div class="storefront-topbar-pills">
        <div class="storefront-topbar-pickup"><i data-lucide="map-pin" style="width:12px;height:12px;"></i> ${esc(pickupLocation)}</div>
        ${eta ? `<div class="storefront-topbar-eta">${esc(eta)}</div>` : ''}
      </div>
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

      ${mine.length ? `
      <div class="flex justify-between items-center mb-2" id="my-campus-section">
        <span class="section-title" style="font-size:16px;"><i data-lucide="map-pin" style="width:15px;height:15px;color:var(--color-primary);vertical-align:-2px;"></i> Shops at ${esc(campusesLabel(mine))}</span>
      </div>
      ${campusStores.length
        ? `<div class="store-mini-row mb-4">${campusStores.map(storeMiniCard).join('')}</div>`
        : `<div class="offline-note mb-4"><i data-lucide="store"></i><span>No shops at ${esc(campusesLabel(mine))} on clickFud yet — showing shops at other campuses below.</span></div>`}` : ''}

      ${locations.length > 2 ? `
      <div class="location-select-row mb-3">
        <i data-lucide="map-pin" style="width:14px;height:14px;color:var(--color-primary);"></i>
        <select class="select location-select" data-action-change="marketplace-location">
          ${locations.map(l => `<option value="${esc(l)}" ${local.location === l ? 'selected' : ''}>${l === 'All' ? 'All Campus Locations' : esc(l)}</option>`).join('')}
        </select>
      </div>` : ''}


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
        <img src="${esc(item.image || '')}" alt="${esc(item.name)}" loading="lazy" onerror="this.onerror=null;this.src='icons/clickfud-icon-192.png';this.classList.add('img-fallback')">
        ${outOfStock ? `<div class="out-of-stock-overlay">Out of Stock</div>` : ''}
      </div>
      <div class="shop-prod-body">
        <div class="shop-prod-name">${esc(item.name)}</div>
        ${item.rating_count ? `<div class="shop-prod-rating"><i data-lucide="star" style="width:11px;height:11px;fill:#FFC107;color:#FFC107;"></i> ${Number(item.rating || 0).toFixed(1)} (${item.rating_count})</div>` : ''}
        <div class="shop-prod-footer">
          <span class="shop-prod-price">${money(U.menuItemPrice(item))}</span>
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

  // ---------------- "Start Order" guided flow (public home page only) ----------------
  // Collection only for now (no delivery), so the flow is just: pick your
  // university and campus. The delivery code paths stay dormant in checkout
  // and the schema for a later phase.
  function guestOrderStep2Html() {
    const d = local.guestOrderDraft;
    const campuses = App.CONST.UNIVERSITY_CAMPUSES[d.university] || [];
    return `
    <div class="modal-header"><span class="modal-title">Which university are you at?</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
    <div class="modal-body">
      <div class="field"><label>University</label>
        <select class="select" data-action-change="guest-order-university">
          ${App.CONST.UNIVERSITIES.map(u => `<option value="${esc(u)}" ${d.university === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Campus</label>
        <select class="select" data-action-change="guest-order-campus">
          <option value="">Select a campus</option>
          ${campuses.map(c => `<option value="${esc(c)}" ${d.campus === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="modal-footer" style="padding:16px 0 0;">
      <button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button>
      <button type="button" class="btn btn-primary" data-action="guest-order-continue" ${d.campus ? '' : 'disabled'}>Continue</button>
    </div>`;
  }

  function startOrderFlow() {
    // Collection is the only way to receive an order for now (no delivery),
    // so there's nothing to choose — go straight to picking the campus.
    local.guestOrderDraft = { fulfilment: 'collection', university: App.CONST.UNIVERSITIES[0], campus: (local.guestOrder && local.guestOrder.campus) || null };
    App.Modal.open(guestOrderStep2Html());
  }

  function scrollToDiscoverShops() {
    const el = document.getElementById('discover-shops-section');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      const results = items.filter(m => searchMatchesMenuItem(m, search));
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
        ${store.cover_image_url ? `<img onerror="this.onerror=null;this.src='icons/clickfud-icon-192.png';this.classList.add('img-fallback')" class="fade-img" src="${esc(store.cover_image_url)}" alt="${esc(store.name)}" onload="this.classList.add('loaded')" />` : `<div class="shop-hero-fallback"><i data-lucide="store"></i></div>`}
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
            ${store.logo_url ? `<img onerror="this.onerror=null;this.src='icons/clickfud-icon-192.png';this.classList.add('img-fallback')" class="shop-info-logo" src="${esc(store.logo_url)}" alt="" />` : `<div class="shop-info-logo store-card-logo-fallback"><i data-lucide="utensils" style="width:16px;height:16px;"></i></div>`}
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

        ${shopPromos(storeId).map(p => `<div class="promo-banner mb-3"><i data-lucide="tag"></i><span>${promoText(p)}</span></div>`).join('')}

        <div class="search-bar mb-3">
          <i data-lucide="search"></i>
          <input type="text" id="store-search-input" placeholder="Search ${esc(store.name)}'s menu..." value="${esc(search)}" data-action-input="store-search" data-store-id="${esc(storeId)}" aria-label="Search menu" />
        </div>

        ${menuBody}

        ${store.rating_count ? `<div class="shop-section" style="margin-top:28px;"><h2 class="shop-section-title">Ratings</h2>${ratingBreakdown(store)}</div>` : ''}
      </div>
    </div>`;
  }

  // ---------------- Public marketing homepage (logged-out visitors) ----------------
  // A genuinely separate page from renderBrowser()/renderStoreDetail() above
  // (both untouched — customer.js still calls them directly for the
  // logged-in experience). This is the first thing a guest sees: a real
  // marketing/introduction page, not the functional shop browser. Clicking
  // into an actual shop still uses the same real renderStoreDetail() via
  // the existing 'open-store' action — nothing about that flow changed.
  // Real developer-uploaded photo for this slot (see
  // js/home-page-media.js) — a plain CSS decorative panel otherwise,
  // never a fabricated stock image.
  function homeMediaUrl(slot) { return (S.state.homePageMedia || {})[slot] || null; }
  function homeMediaText(slot) { return (S.state.homePageMediaText || {})[slot] || {}; }

  // Hand-drawn-style curved underline under "Your Click." — an inline
  // SVG path (per spec: not a plain CSS border-bottom), deliberately
  // slightly irregular rather than a straight line.
  function mheroUnderlineSvg() {
    return `<svg class="mhero-underline" width="180" height="18" viewBox="0 0 180 18" fill="none" aria-hidden="true">
      <path d="M2 12C40 4 120 2 178 10" stroke="var(--color-primary)" stroke-width="6" stroke-linecap="round"/>
    </svg>`;
  }

  function mHeroSection() {
    const heroImg = homeMediaUrl('hero');
    return `
    <section class="mhero-full">
      <div class="mhero-full-media">
        ${heroImg
          ? `<img class="mhero-full-img" src="${esc(heroImg)}" alt="" />`
          : `<div class="mhero-full-fallback"></div>`}
        <div class="mhero-full-scrim"></div>
      </div>
      <div class="mhero-full-content container">
        <span class="mhero-pill"><i data-lucide="utensils"></i> Campus Food. Made Easy.</span>
        <h1 class="mhero-title-lg">Your Campus.<br>Your Food.<br><span class="mhero-highlight">Your Click.</span>${mheroUnderlineSvg()}</h1>
        <p class="mhero-sub-lg">Order from your favourite food shops, skip the queue, and collect your meal when it’s ready.</p>
      </div>
    </section>
    <div class="container mhero-below">
      <div class="search-bar mhero-search-floating">
        <i data-lucide="search"></i>
        <input type="text" id="home-search-input" placeholder="Search food, meals or shops" value="${esc(local.search)}" data-action-input="marketplace-search" aria-label="Search food, meals or shops" />
        ${App.Utils.speechRecognitionSupported && App.Utils.speechRecognitionSupported() ? `<button type="button" class="mhero-search-mic" data-action="voice-search" aria-label="Search by voice"><i data-lucide="mic"></i></button>` : ''}
      </div>
      <div class="mhero-actions">
        <button type="button" class="btn btn-primary btn-lg" data-action="start-order">Start Order <i data-lucide="arrow-right"></i></button>
        <button type="button" class="btn btn-secondary btn-lg" data-action="storefront-goto" data-target="discover-shops-section"><i data-lucide="store"></i> Explore Shops</button>
      </div>
      <div class="mbenefits-row">
        <div class="mbenefit-item"><div class="mbenefit-icon"><i data-lucide="shopping-bag"></i></div><div><strong>Collection</strong><span>Pick up easily</span></div></div>
        <div class="mbenefit-divider"></div>
        <div class="mbenefit-item"><div class="mbenefit-icon"><i data-lucide="shield-check"></i></div><div><strong>Safe &amp; Secure</strong><span>Your food, our priority</span></div></div>
      </div>
    </div>`;
  }

  // Real, live counts — never fabricated — pulled from the exact same
  // approved/published store + available-menu-item data every other
  // section on this page already uses.
  function liveStats() {
    const stores = allStores();
    const openCount = stores.filter(s => App.Stores.isOpenNow(s)).length;
    const itemCount = visibleMenu().filter(m => m.available && m.stock > 0).length;
    return { shops: stores.length, open: openCount, items: itemCount };
  }

  function mLiveStatsSection() {
    const stats = liveStats();
    return `
    <section class="mstats mreveal">
      <div class="container mstats-row">
        <div class="mstat"><span class="mstat-value" data-count="${stats.shops}">0</span><span class="mstat-label">Food Shops on clickFud</span></div>
        <div class="mstat"><span class="mstat-value" data-count="${stats.open}">0</span><span class="mstat-label"><span class="live-dot"></span>Open Right Now</span></div>
        <div class="mstat"><span class="mstat-value" data-count="${stats.items}">0</span><span class="mstat-label">Meals Available</span></div>
      </div>
    </section>`;
  }

  // ---------------- Food Categories (real, app-style horizontal chips) ----------------
  // Same real data/icons/action as renderBrowser()'s category row — the
  // guest page now offers actual filtering (of the Popular Food row
  // below), not decorative marketing copy.
  function mCategoriesSection() {
    const cats = foodCategories();
    if (!cats.length) return '';
    return `
    <section class="msection msection-tight mreveal">
      <div class="container">
        <div class="msection-header-row">
          <h2 class="msection-title-sm">Food Categories</h2>
          <button type="button" class="view-all-link" data-action="food-category" data-category="All">View All <i data-lucide="arrow-right" style="width:13px;height:13px;"></i></button>
        </div>
        <div class="category-icon-row">
          <button class="category-icon-card ${local.foodCategory === 'All' ? 'active' : ''}" data-action="food-category" data-category="All">
            <span class="category-icon-badge"><i data-lucide="layout-grid"></i></span><span>All</span>
          </button>
          ${cats.map(c => `
          <button class="category-icon-card ${local.foodCategory === c ? 'active' : ''}" data-action="food-category" data-category="${esc(c)}">
            <span class="category-icon-badge"><i data-lucide="${FOOD_CATEGORY_ICONS[c] || 'utensils'}"></i></span><span>${esc(c)}</span>
          </button>`).join('')}
        </div>
      </div>
    </section>`;
  }

  // ---------------- Promotions (real store promos + the two uploaded
  // brand photos) — a horizontal carousel, app-advertisement style,
  // instead of long-form "About"/"Hungry Between Lectures" editorial
  // sections. The about/lectures uploaded photos still appear here —
  // never dropped — just as promo-style cards instead of side-images
  // next to paragraphs. ----------------
  function brandedPromoCard(title, sub, img, targetId) {
    return `
    <div class="promo-mini-card" data-action="storefront-goto" data-target="${targetId}">
      <div class="promo-mini-img"><img src="${esc(img)}" alt="${esc(title)}" loading="lazy" /></div>
      <div class="promo-mini-title">${esc(title)}</div>
      <div class="promo-mini-sub">${esc(sub)}</div>
    </div>`;
  }

  function mPromotionsSection() {
    const promos = activeStorePromotions();
    const aboutImg = homeMediaUrl('about');
    const lecturesImg = homeMediaUrl('lectures');
    const aboutText = homeMediaText('about');
    const lecturesText = homeMediaText('lectures');
    const brandedCards = [];
    if (aboutImg) brandedCards.push(brandedPromoCard(aboutText.title || 'About clickFud', aboutText.subtitle || 'Local food. Real convenience.', aboutImg, 'discover-shops-section'));
    if (lecturesImg) brandedCards.push(brandedPromoCard(lecturesText.title || 'Hungry Between Lectures?', lecturesText.subtitle || 'Order ahead, skip the queue.', lecturesImg, 'discover-shops-section'));
    if (!promos.length && !brandedCards.length) return '';
    return `
    <section class="msection msection-tight mreveal">
      <div class="container">
        <h2 class="msection-title-sm">Promotions</h2>
        <div class="promo-mini-row">${promos.map(promoMiniCard).join('')}${brandedCards.join('')}</div>
      </div>
    </section>`;
  }

  // ---------------- Popular Food (real menu items) ----------------
  // New on the guest page — reuses the exact same real, tested
  // recommendedItems()/recommendedFoodCard() already powering the
  // logged-in customer's "Popular Near You" row, respecting whatever
  // category/search the customer has picked above.
  function mPopularFoodSection() {
    const isSearching = !!local.search;
    const items = recommendedItems();
    if (!items.length && !isSearching) return '';
    return `
    <section class="msection msection-tight msection-tint mreveal" id="popular-food-section">
      <div class="container">
        <h2 class="msection-title-sm">${isSearching ? `Results for &ldquo;${esc(local.search)}&rdquo;` : 'Popular Food'}</h2>
        ${items.length
          ? `<div class="${isSearching ? 'grid grid-menu' : 'recommended-row'}">${items.map(recommendedFoodCard).join('')}</div>`
          : `<div class="empty-state"><div class="icon-wrap"><i data-lucide="search-x"></i></div><h3>No matches for "${esc(local.search)}"</h3><p class="text-sm">Try a different search term.</p></div>`}
      </div>
    </section>`;
  }

  function landingShopCard(store) {
    const open = App.Stores.isOpenNow(store);
    return `
    <div class="mshop-card" data-action="open-store" data-id="${esc(store.id)}">
      <div class="mshop-card-img">
        ${store.cover_image_url ? `<img onerror="this.onerror=null;this.src='icons/clickfud-icon-192.png';this.classList.add('img-fallback')" src="${esc(store.cover_image_url)}" alt="${esc(store.name)}" loading="lazy" />` : `<div class="mshop-card-img-fallback"><i data-lucide="utensils"></i></div>`}
        <span class="badge ${open ? 'badge-success' : 'badge-error'} mshop-card-status">${open ? '<span class="live-dot"></span>Open' : 'Closed'}</span>
      </div>
      <div class="mshop-card-body">
        <div class="mshop-card-name">${esc(store.name)}</div>
        <div class="text-xs text-muted">${esc(store.category || '')}</div>
        ${store.accepts_collection ? `<div class="mshop-card-fulfil"><i data-lucide="shopping-bag" style="width:11px;height:11px;"></i> Collection</div>` : ''}
      </div>
    </div>`;
  }

  function mDiscoverShopsSection() {
    if (!S.state.dataReady) {
      return `
      <section class="msection msection-tight mreveal" id="discover-shops-section">
        <div class="container">
          <h2 class="msection-title-sm">Featured Shops</h2>
          <div class="store-mini-row">${Array(4).fill(0).map(skeletonStoreCard).join('')}</div>
        </div>
      </section>`;
    }
    // Actively searching hands the whole results area to mPopularFoodSection
    // (food items only, no shop cards competing for scroll) — this section
    // steps aside entirely rather than showing its own separate "Results
    // for X" shop list alongside it.
    if (local.search) return '';
    const shops = local.showAllShops ? sortStores(allStores()) : popularStores();
    return `
    <section class="msection msection-tight mreveal" id="discover-shops-section">
      <div class="container">
        <div class="msection-header-row">
          <h2 class="msection-title-sm">Featured Shops</h2>
          ${!local.showAllShops && allStores().length > shops.length ? `<button type="button" class="view-all-link" data-action="marketplace-view-all">View All</button>` : ''}
        </div>
        ${local.guestOrder ? `
        <div class="guest-order-banner mb-3">
          <i data-lucide="shopping-bag"></i>
          <span>Collection &middot; ${esc(local.guestOrder.campus)}</span>
          <button type="button" data-action="guest-order-change">Change</button>
        </div>` : ''}
        ${shops.length
          ? (local.showAllShops ? `<div class="mshop-grid">${shops.map(landingShopCard).join('')}</div>` : `<div class="store-mini-row">${shops.map(storeMiniCard).join('')}</div>`)
          : `<div class="empty-state"><div class="icon-wrap"><i data-lucide="store"></i></div><h3>No shops live yet</h3><p class="text-sm">Check back soon — new food shops are joining clickFud.</p></div>`}
      </div>
    </section>`;
  }

  function mFooter() {
    return `
    <footer class="home-footer">
      <div class="home-footer-grid home-footer-grid-single container">
        <div>
          <a href="#" class="home-brand" data-action="go-home">${App.Shared.logoBadge()}<span class="home-brand-name">clickFud</span></a>
          <p class="text-sm" style="color:#B6B4C0;margin-top:8px;">Campus food. Made easy.</p>
        </div>
      </div>
    </footer>`;
  }

  // Scroll-reveal for every .mreveal section, plus a real count-up
  // animation for the live stats strip once it scrolls into view — same
  // "disconnect any previous observer first, it's watching stale DOM
  // nodes after a re-render" pattern as initShopScrollSpy() above.
  function initMarketingReveal() {
    if (local._marketingObserver) { local._marketingObserver.disconnect(); local._marketingObserver = null; }
    const els = [...document.querySelectorAll('.mreveal')];
    if (!els.length) return;
    local._marketingObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('mreveal-in');
        if (entry.target.classList.contains('mstats')) animateStatCounts(entry.target);
        local._marketingObserver.unobserve(entry.target);
      });
    }, { threshold: 0.15 });
    els.forEach(el => local._marketingObserver.observe(el));
  }

  function animateStatCounts(root) {
    root.querySelectorAll('.mstat-value[data-count]').forEach(el => {
      const target = Number(el.dataset.count) || 0;
      const start = performance.now();
      const duration = 900;
      function tick(now) {
        const p = Math.min(1, (now - start) / duration);
        el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3)))); // ease-out cubic
        if (p < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  function renderMarketingHome() {
    setTimeout(initMarketingReveal, 0);
    return `
    <div id="home-top"></div>
    ${mHeroSection()}
    ${mLiveStatsSection()}
    ${mCategoriesSection()}
    ${mPromotionsSection()}
    ${mDiscoverShopsSection()}
    ${mPopularFoodSection()}
    ${mFooter()}`;
  }

  function publicHeaderInner() {
    // No cart icon up here — a guest's one cart entry point is the
    // bottom-nav center button (js/shared-ui.js renderBottomNav()); two
    // cart icons on the same screen was redundant clutter.
    return `
    <div class="home-header-inner container">
      <a href="#" class="home-brand mhome-brand-tag" data-action="go-home">
        ${App.Shared.logoBadge()}
        <span>
          <span class="home-brand-name">clickFud</span>
          <span class="mhome-tagline">Good Food. Fast.</span>
        </span>
      </a>
      <nav class="mnav-links">
        <a data-action="storefront-goto" data-target="home-top">Home</a>
        <a data-action="storefront-goto" data-target="discover-shops-section">Food Shops</a>
      </nav>
      <div class="home-header-actions">
        <button type="button" class="btn-icon home-theme-btn" data-action="toggle-theme" aria-label="${S.state.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}">
          <i data-lucide="${S.state.theme === 'dark' ? 'sun' : 'moon'}"></i>
        </button>
        <button type="button" class="btn btn-secondary btn-sm home-login-btn" data-action="go-auth" data-tab="login">Log In</button>
        <button type="button" class="btn btn-primary btn-sm btn-pill" data-action="go-auth" data-tab="signup">Sign Up</button>
      </div>
    </div>`;
  }

  // ---------------- Public (logged-out) full page ----------------
  function categoryChips() { return storeCategories(); } // kept for backward compatibility of naming

  function render() {
    const route = S.state.route;
    const isStoreView = route.view === 'store' && route.params && route.params.storeId;

    if (isStoreView) {
      return `
      <div class="home-page">
        <header class="home-header">${publicHeaderInner()}</header>
        <div class="home-content container">${renderStoreDetail(route.params.storeId)}</div>
      </div>`;
    }

    return `
    <div class="home-page">
      <header class="home-header">${publicHeaderInner()}</header>
      ${renderMarketingHome()}
    </div>`;
  }

  // ---------------- Shared action handling ----------------
  function addStoreItemToCart(id) {
    const item = S.state.menu.find(m => m.id === id);
    if (!item) return;
    if (!item.available || item.stock <= 0) { App.Toast.error(`"${item.name}" is currently unavailable.`); return; }
    const store = App.Stores.getById(item.store_id);
    S.addToCartWithConfirm({
      menuItemId: item.id, name: item.name, price: U.menuItemPrice(item), image: item.image,
      qty: 1, addons: [], specialInstructions: '',
      storeId: item.store_id, storeName: store ? store.name : '',
    }, { onAdded: () => App.Toast.success(`Added "${item.name}" to your cart.`) });
  }

  function handleAction(action, ds, el) {
    switch (action) {
      case 'voice-search': {
        if (el) el.classList.add('listening');
        App.Utils.startVoiceSearch({
          onResult: (transcript) => {
            if (!transcript) return;
            local.search = transcript;
            const input = document.getElementById('home-search-input');
            if (input) input.value = transcript;
            App.render();
          },
          onError: () => { App.Toast.error("Couldn't hear that — please try again or type instead."); },
          onEnd: () => { if (el) el.classList.remove('listening'); },
        });
        return;
      }
      case 'start-order':
        return startOrderFlow();
      case 'guest-order-continue': {
        if (!local.guestOrderDraft.campus) return;
        local.guestOrder = Object.assign({}, local.guestOrderDraft);
        local.guestOrderDraft = null;
        // Carried across the login/signup boundary (js/pages/customer.js
        // startCheckout() reads this once) so a guest who already chose
        // Delivery/Collection here never has to pick it again just
        // because they created an account partway through ordering —
        // same idea as the guest cart merge, one key instead of a table.
        try { localStorage.setItem(App.CONST.LS_KEYS.GUEST_FULFILMENT, local.guestOrder.fulfilment); } catch (e) {}
        App.Modal.close();
        App.render();
        setTimeout(scrollToDiscoverShops, 50);
        return;
      }
      case 'guest-order-change':
        return startOrderFlow();
      case 'open-store': {
        S.setRoute({ view: 'store', params: { storeId: ds.id } });
        App.forceScrollTop();
        return;
      }
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
      case 'marketplace-view-all':
        local.showAllShops = true;
        return App.render();
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
      // The popup's own buttons (+/-, Add to Cart, heart) must be forwarded
      // too — without them a logged-out visitor could open the popup but
      // nothing inside it did anything.
      case 'open-food':
      case 'view-food-image':
      case 'detail-qty':
      case 'add-to-cart-detail':
      case 'toggle-favorite':
        return App.Pages.Customer.handleAction(action, ds);
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

  // The marketing home page now renders a lot more per keystroke than
  // it used to (multiple horizontal carousels, 30+ icons re-run through
  // lucide.createIcons() on every full re-render) — re-rendering the
  // whole page on every single keystroke was measurably slow enough to
  // feel like dropped/delayed characters while typing. local.search
  // itself still updates immediately (nothing about the actual filter
  // logic changes); only the expensive App.render() is debounced, so
  // the results below settle ~180ms after typing pauses instead of
  // fighting to keep up with every keystroke. The input's own visible
  // text is native browser behavior and was never actually the slow
  // part — this only speeds up the re-render, it can't "unblur" typing
  // that was never blurred by CSS.
  const debouncedRender = App.Utils.debounce(() => App.render(), 180);

  function handleInput(kind, value, ds) {
    if (kind === 'marketplace-search') { local.search = value; debouncedRender(); }
    if (kind === 'store-search') { local.storeSearch[ds.storeId] = value; debouncedRender(); }
    if (kind === 'update-instructions') return App.Pages.Customer.handleInput(kind, value, ds); // food popup
  }

  function handleChange(kind, ds, value) {
    if (kind === 'toggle-extra') return App.Pages.Customer.handleChange(kind, ds, value); // food popup
    if (kind === 'marketplace-location') { local.location = value; App.render(); }
    if (kind === 'marketplace-sort') { local.sort = value; App.render(); }
    if (kind === 'guest-order-university') {
      local.guestOrderDraft.university = value;
      local.guestOrderDraft.campus = null;
      return App.Modal.open(guestOrderStep2Html());
    }
    if (kind === 'guest-order-campus') {
      local.guestOrderDraft.campus = value;
      return App.Modal.open(guestOrderStep2Html());
    }
  }

  return {
    render, renderBrowser, renderStoreDetail, handleAction, handleInput, handleChange,
    addStoreItemToCart, local,
  };
})();
