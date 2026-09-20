/* ============================================================
   CLICKFUD — ratings & feedback
   ============================================================ */
window.App = window.App || {};

App.Reviews = (function () {
  const S = App.Store;

  async function fetchAll() {
    const { data, error } = await App.sb.from('reviews').select('*').order('created_at', { ascending: false });
    if (error) { console.error(error); return; }
    S.set({ reviews: data || [] });
  }

  function hasReviewed(orderId) {
    return S.state.reviews.some(r => r.order_id === orderId);
  }

  function getForOrder(orderId) {
    return S.state.reviews.find(r => r.order_id === orderId);
  }

  // delivery_rating is no longer collected — this app is pickup/
  // collection-only (Phase 1), there's no delivery experience for a
  // customer to actually rate. The column stays nullable on the DB
  // side (schema.sql) so a future delivery phase can reuse it without
  // a migration; new reviews just never populate it.
  async function submitReview(order, { foodRating, overallRating, comment }) {
    if (!S.state.profile) return { error: 'Please sign in to leave a review.' };
    for (const [label, v] of [['food', foodRating], ['overall', overallRating]]) {
      if (!Number.isInteger(v) || v < 1 || v > 5) return { error: `Please give a ${label} rating.` };
    }
    // upsert on order_id (unique per order) rather than insert: re-rating
    // an already-reviewed order replaces that one row in place instead of
    // adding a second one, which is what actually keeps the shop average
    // correct on an edit (the DB rollup trigger recalculates from whatever
    // rows exist, so a stray duplicate would double-count the same order).
    const { data, error } = await App.sb.from('reviews').upsert({
      order_id: order.id,
      customer_id: S.state.profile.id,
      food_rating: foodRating,
      overall_rating: overallRating,
      comment: App.Utils.sanitizeText(comment, 500),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'order_id' }).select().single();
    if (error) return { error: error.message };
    S.upsertIn('reviews', data);
    // Both the per-item (menu_items) and per-shop (stores) rating rollups
    // happen server-side via triggers (customers can't UPDATE either table
    // themselves under RLS) — realtime delivers the updated rows back to
    // every open tab automatically; store_id is derived from the order by
    // the DB itself, never sent from here.
    return { data };
  }

  // storeId is optional so existing callers keep working unfiltered
  // (correct today only because RLS already pre-scopes a manager's loaded
  // reviews to their own store) — pass it explicitly wherever the caller
  // isn't guaranteed to only ever hold one store's reviews.
  function averageOverall(storeId) {
    const list = storeId ? S.state.reviews.filter(r => r.store_id === storeId) : S.state.reviews;
    if (!list.length) return 0;
    const sum = list.reduce((s, r) => s + r.overall_rating, 0);
    return Math.round((sum / list.length) * 10) / 10;
  }

  return { fetchAll, hasReviewed, getForOrder, submitReview, averageOverall };
})();
