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
};

App.CONST = {
  ROLES: ['customer', 'manager', 'kitchen', 'driver', 'developer'],
  CATEGORIES: ['Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Drinks', 'Desserts', 'Specials'],
  ADDON_CATEGORIES: ['Drinks', 'Snacks', 'Sides', 'Desserts', 'Other'],
  ORDER_STATUSES: ['received', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'collected', 'cancelled'],
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
  },
  STATUS_DESCRIPTIONS: {
    received: 'Your order has been sent to the kitchen.',
    preparing: 'The kitchen is preparing your food.',
    ready: 'Your order is packed and ready for pickup.',
    out_for_delivery: 'A driver is on the way to you.',
    delivered: 'Your order has arrived. Enjoy your meal!',
    collected: 'Order collected. Enjoy your meal!',
    cancelled: 'This order was cancelled.',
  },
  LS_KEYS: {
    THEME: 'cfe_theme',
    CART: 'cfe_cart_',        // + userId
    FAVORITES: 'cfe_favs_',   // + userId
    FAVORITE_STORES: 'cfe_fav_stores_', // + userId
  },
  ETA_MINUTES: 15,
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
    'University of Pretoria': ['Hatfield', 'Groenkloof', 'Prinshof', 'Mamelodi', 'Onderstepoort'],
  },
};
