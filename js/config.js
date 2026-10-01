/* ============================================================
   CLICKFUD — global config & constants
   ============================================================ */
window.App = window.App || {};

App.CONFIG = {
  SUPABASE_URL: 'https://ctxnwjjpqxecidzblyok.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_W5valI71yTGlEeJOPAxzig_aVk6VR-R',
  // An account that lands here by mistake gets pointed back to the right one.
  STAFF_APP_URL: 'https://clickfud-staff.vercel.app',
  DEVELOPER_APP_URL: 'https://clickfud-developer.vercel.app',
  // RecessBox is a separate app/product (student storage booking) on its
  // own Supabase project — deployed independently on Vercel. (Variable/
  // infra name kept as CAMPUSBOX_URL — that's an internal identifier, not
  // the product's display name.)
  CAMPUSBOX_URL: 'https://campusbox-three.vercel.app',
  // Customer accounts need a University of Pretoria student email on this
  // domain (TuksMail: u12345678@tuks.co.za). This copy is ONLY for the
  // sign-up form's instant messages — the authoritative rule is enforced
  // server-side by public.up_student_email_domains() /
  // is_up_student_email() (supabase/up_student_auth.sql), used by account
  // creation and by secure-login. Change both together.
  UP_STUDENT_EMAIL_DOMAIN: 'tuks.co.za',
};

App.CONST = {
  ROLES: ['customer', 'manager', 'kitchen', 'driver', 'developer'],
  CATEGORIES: ['Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Drinks', 'Desserts', 'Specials'],
  ADDON_CATEGORIES: ['Drinks', 'Snacks', 'Sides', 'Desserts', 'Other'],
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
  PLACEHOLDER_PICKUP_ADDRESS: 'Pickup location not yet set — please update in Store Settings',
  // Deliberately just University of Pretoria for now — the platform is
  // launching there first, so signup doesn't offer any other university
  // yet. Add more here (and to UNIVERSITY_CAMPUSES below) when the
  // rollout actually expands past UP.
  UNIVERSITIES: [
    'University of Pretoria',
  ],
  // Real campuses per university, for the signup "Campus" dropdown (which
  // campus of that university the student is at) — same list the Staff
  // app's manager business-registration screen uses for a shop's own
  // campus_location, so a customer's and a store's campus values line up.
  UNIVERSITY_CAMPUSES: {
    'University of Pretoria': ['Hatfield', 'Hillcrest', 'Groenkloof', 'Prinshof', 'Mamelodi', 'Onderstepoort', 'GIBS'],
  },
};
