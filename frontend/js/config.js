/* ============================================================
   CLICKFOOD, global config & constants
   ============================================================ */
window.App = window.App || {};

App.CONFIG = {
  SUPABASE_URL: 'https://ctxnwjjpqxecidzblyok.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_W5valI71yTGlEeJOPAxzig_aVk6VR-R',
  // Cloudflare Turnstile site key (public, like the anon key). Empty = bot check off.
  TURNSTILE_SITE_KEY: '0x4AAAAAAFZD5T3Vf15wyuqx',
  // An account that lands here by mistake gets pointed back to the right one.
  STAFF_APP_URL: 'https://manager.clickfood.co.za',
  DEVELOPER_APP_URL: 'https://clickfud-developer.vercel.app',
  // RecessBox is a separate app/product (student storage booking) on its
  // own Supabase project — deployed independently on Vercel. (Variable/
  // infra name kept as CAMPUSBOX_URL — that's an internal identifier, not
  // the product's display name.)
  CAMPUSBOX_URL: 'https://campusbox-three.vercel.app',
  // Student email domains are managed in the developer app (Supported
  // Institutions, table allowed_domains), never here: see js/institutions.js.
  // Partner shops (stores.seller_kind = 'business') are hidden from
  // customers while ClickFood runs on student sellers only. Their data and
  // old orders are untouched; set true to show them again.
  SHOW_PARTNER_SHOPS: false,
};

App.CONST = {
  ROLES: ['customer', 'manager', 'kitchen', 'driver', 'developer'],
  CATEGORIES: ['Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Drinks', 'Desserts', 'Specials'],
  ADDON_CATEGORIES: ['Drinks', 'Snacks', 'Sides', 'Desserts', 'Other'],
  // Student sellers: food only. Same list as public.student_food_categories().
  STUDENT_FOOD_CATEGORIES: ['Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Fast Food', 'Traditional', 'Baked Goods', 'Desserts', 'Drinks', 'Other Food'],
  FOOD_CATEGORY_LABELS: {
    Snacks: 'Snacks & Light Meals', Traditional: 'Traditional Food', Desserts: 'Desserts & Sweets', Drinks: 'Drinks',
  },
  // Same keys as supabase/functions/payfast-cancel-order.
  ORDER_CANCEL_REASONS: [
    ['item_unavailable', "The seller doesn't have what I ordered"],
    ['too_slow', "It's taking too long"],
    ['cant_collect', "I can't collect at the chosen time"],
    ['by_mistake', 'I ordered by mistake'],
    ['change_order', 'I want to change my order'],
    ['found_elsewhere', 'I found food somewhere else'],
    ['too_expensive', "It's too expensive"],
    ['seller_problem', 'A problem with the seller'],
    ['other', 'Other'],
  ],
  // Same keys as public.account_deletion_reasons() (supabase/account_deletion_reasons.sql).
  ACCOUNT_DELETION_REASONS: [
    ['not_using', 'I don\x27t use ClickFood any more'],
    ['graduated', 'I graduated or left UP'],
    ['another_account', 'I made another account'],
    ['few_shops', 'Not enough food or shops near me'],
    ['prices', 'The food is too expensive'],
    ['order_problems', 'Problems with orders or collection'],
    ['payment_problems', 'Payment problems'],
    ['app_problems', 'The app is hard to use or has bugs'],
    ['privacy', 'Privacy concerns'],
    ['too_many_messages', 'Too many notifications or emails'],
    ['stopped_selling', 'I stopped selling food'],
    ['other', 'Other'],
  ],
  SELLER_RULES: [
    'I only sell food and non-alcoholic drinks I make or prepare myself.',
    'My photos, prices and descriptions are honest, and I list allergens.',
    'I prepare and store food hygienically and keep it safe to eat.',
    'No alcohol, tobacco, medicine or anything illegal.',
    'Payment and collection are arranged between me and the buyer.',
    'ClickFood can review, reject or remove my listings.',
  ],
  ORDER_STATUSES: ['received', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'collected', 'cancelled', 'uncollected'],
  // Phase 1 is collection-only (delivery stays dormant but intact for a
  // later phase) — the tracker picks whichever of these two flows matches
  // the order's own delivery_location.fulfilment, so historical delivery
  // orders still render correctly.
  STATUS_FLOW: ['received', 'preparing', 'ready', 'out_for_delivery', 'delivered'],
  STATUS_FLOW_COLLECTION: ['received', 'preparing', 'ready', 'collected'],
  STATUS_LABELS: {
    received: 'Order Received',
    preparing: 'Preparing Order',
    ready: 'Order Ready',
    out_for_delivery: 'Out for Delivery',
    delivered: 'Delivered & Completed',
    collected: 'Collected & Completed',
    cancelled: 'Cancelled',
    uncollected: 'Not Collected',
  },
  STATUS_DESCRIPTIONS: {
    received: 'Your order has been sent to the kitchen.',
    preparing: 'The kitchen is preparing your food.',
    ready: 'Your order is packed and ready for pickup.',
    out_for_delivery: 'A driver is on the way to you.',
    delivered: 'Your order has arrived. Enjoy your meal!',
    collected: 'Order collected. Enjoy your meal!',
    cancelled: 'This order was cancelled.',
    uncollected: 'This order was not collected in time and has been closed.',
  },
  // Terms / Privacy version on the sign-up form (= legal_versions() in supabase/privacy_legal.sql)
  LEGAL_VERSION: "2026-10-17.2",
  LS_KEYS: {
    THEME: 'cfe_theme',
    CART: 'cfe_cart_',        // + userId
    FAVORITES: 'cfe_favs_',   // + userId
    FAVORITE_STORES: 'cfe_fav_stores_', // + userId
    ONBOARDING_COMPLETE: 'clickfud_onboarding_completed',
    GUEST_FULFILMENT: 'cfe_guest_fulfilment', // set by the home page's "Start Order" flow, consumed once at checkout start
  },
  ETA_MINUTES: 15,
  // How long a student has to physically collect a 'ready' collection
  // order before the shop is entitled to give it to someone else. Purely
  // a countdown/messaging constant — nothing here auto-cancels or auto-
  // reassigns an order once it passes; that stays a real decision made
  // by the shop/kitchen staff, same as any other order exception today.
  COLLECTION_WINDOW_MINUTES: 30,
  // My Timetable (js/timetable.js) — index matches JS Date.getDay()
  // (0=Sunday..6=Saturday) exactly, so a day picked here needs no
  // translation anywhere it's compared against a real Date.
  DAYS: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  // Backfilled onto any store whose pickup address was missing when
  // that column became required (migration_governance.sql section 44)
  // — deliberately obvious placeholder text, never a guessed real
  // location. Anywhere Get Directions would use a store's address,
  // this exact value means "not configured yet", not a real pickup spot.
  PLACEHOLDER_PICKUP_ADDRESS: 'Pickup location not yet set. Please update it in Store Settings',
  // Institutions ClickFood has campus lists for (the student's email decides
  // the institution; one without a list here simply has no campus question).
  UNIVERSITIES: [
    'University of Pretoria',
    'Tshwane University of Technology',
  ],
  // Real campuses per university, for the signup "Campus" dropdown (which
  // campus of that university the student is at) — same list the Staff
  // app's manager business-registration screen uses for a shop's own
  // campus_location, so a customer's and a store's campus values line up.
  UNIVERSITY_CAMPUSES: {
    'University of Pretoria': ['Hatfield', 'Hillcrest', 'Groenkloof', 'Prinshof', 'Mamelodi', 'Onderstepoort', 'GIBS'],
    // Pretoria/Tshwane campuses only (the live list comes from the campuses table)
    'Tshwane University of Technology': ['Pretoria', 'Arcadia', 'Arts', 'Ga-Rankuwa', 'Soshanguve North', 'Soshanguve South'],
  },
};
