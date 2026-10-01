/* ============================================================
   CLICKFUD — stores (multi-vendor marketplace)
   ============================================================ */
window.App = window.App || {};

App.Stores = (function () {
  const S = App.Store;

  // Column list, not select('*') — this runs on every page load for
  // every visitor (App.Bootstrap.loadPublicData()), so it's the single
  // hottest query in the app. Audited against every file this app
  // actually loads (index.html) for real field usage — manager_id/slug
  // are write-only (never read off a fetched row), updated_at/
  // publish_requested_at/publish_rejection_reason aren't read anywhere
  // live. Never remove a column from here without re-checking that
  // audit; leftover role-page files elsewhere in js/pages/ (developer.js,
  // manager.js, etc.) are NOT loaded by index.html and don't count.
  const LIST_COLUMNS = 'id, name, description, category, logo_url, cover_image_url, contact_phone, contact_email, campus_location, accepts_delivery, accepts_collection, delivery_fee, prep_time_min, prep_time_max, rating, rating_count, opening_time, closing_time, closed_days, store_closed, closure_reason, status, rejection_reason, university, is_published, rating_breakdown';

  async function fetchAll() {
    const { data, error } = await App.sb.from('stores').select(LIST_COLUMNS).order('name');
    if (error) { console.error(error); S.set({ dataLoadError: true }); return; }
    S.set({ stores: data || [] });
  }

  function getById(id) {
    return S.state.stores.find(s => s.id === id) || null;
  }

  function myStore() {
    if (!S.state.profile || !S.state.profile.store_id) return null;
    return getById(S.state.profile.store_id);
  }

  function slugify(name) {
    return String(name || '').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  function validate(payload) {
    if (!payload.name || !App.Utils.sanitizeText(payload.name)) return 'Please enter a store name.';
    if (!payload.category || !App.Utils.sanitizeText(payload.category)) return 'Please enter a store category.';
    if (!payload.campus_location || !App.Utils.sanitizeText(payload.campus_location)) return 'Please enter a campus location.';
    if (payload.university !== undefined && !payload.university.trim()) return 'Please enter the university or college this shop belongs to.';
    if (payload.delivery_fee !== undefined && !App.Utils.isValidPrice(payload.delivery_fee)) return 'Please enter a valid delivery fee.';
    return null;
  }

  function cleanPayload(payload) {
    const out = {
      name: App.Utils.sanitizeText(payload.name, 60),
      category: App.Utils.sanitizeText(payload.category, 40),
      campus_location: App.Utils.sanitizeText(payload.campus_location, 60),
      description: App.Utils.sanitizeText(payload.description, 300),
    };
    if (payload.university !== undefined) out.university = App.Utils.sanitizeText(payload.university, 120);
    if (payload.logo_url !== undefined) out.logo_url = App.Utils.sanitizeText(payload.logo_url, 500) || null;
    if (payload.cover_image_url !== undefined) out.cover_image_url = App.Utils.sanitizeText(payload.cover_image_url, 500) || null;
    if (payload.contact_phone !== undefined) out.contact_phone = App.Utils.sanitizeText(payload.contact_phone, 20) || null;
    if (payload.contact_email !== undefined) out.contact_email = App.Utils.sanitizeText(payload.contact_email, 120) || null;
    if (payload.accepts_delivery !== undefined) out.accepts_delivery = !!payload.accepts_delivery;
    if (payload.accepts_collection !== undefined) out.accepts_collection = !!payload.accepts_collection;
    if (payload.delivery_fee !== undefined) out.delivery_fee = Number(payload.delivery_fee) || 0;
    if (payload.prep_time_min !== undefined) out.prep_time_min = Number(payload.prep_time_min) || 10;
    if (payload.prep_time_max !== undefined) out.prep_time_max = Number(payload.prep_time_max) || 25;
    if (payload.status !== undefined) out.status = payload.status;
    if (payload.is_registered_business !== undefined) out.is_registered_business = !!payload.is_registered_business;
    if (payload.registration_date !== undefined) out.registration_date = payload.registration_date || null;
    return out;
  }

  async function create(payload) {
    const err = validate(payload);
    if (err) return { error: err };
    if (!S.state.profile) return { error: 'Please sign in first.' };
    const clean = cleanPayload(payload);
    clean.manager_id = S.state.profile.id;
    clean.slug = slugify(clean.name);
    const { data, error } = await App.sb.from('stores').insert(clean).select().single();
    if (error) return { error: /duplicate/i.test(error.message) ? 'A store with that name already exists.' : error.message };
    S.upsertIn('stores', data);
    const linkRes = await App.Auth.updateProfile({ store_id: data.id });
    if (linkRes.error) return { error: linkRes.error };
    return { data };
  }

  async function update(id, payload) {
    const err = validate(payload);
    if (err) return { error: err };
    const { data, error } = await App.sb.from('stores').update(cleanPayload(payload)).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('stores', data);
    return { data };
  }

  async function updateHours(id, patch) {
    const { data, error } = await App.sb.from('stores').update(patch).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('stores', data);
    return { data };
  }

  // Developer-only moderation actions on a pending business application —
  // enforced server-side by the "stores update developer" RLS policy and
  // the enforce_store_status trigger, not just by hiding these in the UI.
  async function approve(id) {
    const { data, error } = await App.sb.from('stores').update({ status: 'approved', rejection_reason: null }).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('stores', data);
    await App.Audit.log('approve', 'store', id, data.name, null);
    return { data };
  }

  async function reject(id, reason) {
    const { data, error } = await App.sb.from('stores').update({ status: 'rejected', rejection_reason: reason || null }).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('stores', data);
    await App.Audit.log('reject', 'store', id, data.name, reason);
    return { data };
  }

  async function archive(id, reason) {
    if (!reason || !reason.trim()) return { error: 'A reason is required to archive a shop.' };
    const { data, error } = await App.sb.from('stores')
      .update({ status: 'archived', archived_reason: reason.trim(), archived_by: S.state.profile.id, archived_at: new Date().toISOString() })
      .eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('stores', data);
    await App.Audit.log('archive', 'store', id, data.name, reason.trim());
    return { data };
  }

  async function unarchive(id) {
    const { data, error } = await App.sb.from('stores')
      .update({ status: 'approved', archived_reason: null, archived_by: null, archived_at: null })
      .eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('stores', data);
    await App.Audit.log('unarchive', 'store', id, data.name, null);
    return { data };
  }

  async function deletePermanently(id, name, reason) {
    if (!reason || !reason.trim()) return { error: 'A deletion reason is required.' };
    // Logged before the delete completes so the record survives even if the
    // delete itself fails partway (e.g. blocked by existing order history).
    await App.Audit.log('delete', 'store', id, name, reason.trim());
    const { error } = await App.sb.from('stores').delete().eq('id', id);
    if (error) return { error: /foreign key|violates/i.test(error.message) ? 'This shop has existing orders and cannot be permanently deleted. Archive it instead.' : error.message };
    S.set({ stores: S.state.stores.filter(s => s.id !== id) });
    return { data: true };
  }

  function isOpenNow(store) {
    if (!store) return true;
    if (store.store_closed) return false;
    const now = new Date();
    if ((store.closed_days || []).includes(now.getDay())) return false;
    const [oh, om] = store.opening_time.split(':').map(Number);
    const [ch, cm] = store.closing_time.split(':').map(Number);
    const openMins = oh * 60 + om, closeMins = ch * 60 + cm;
    const nowMins = now.getHours() * 60 + now.getMinutes();
    // Overnight hours (e.g. 20:00-02:00) — closing time is numerically
    // earlier than opening time because it's really "the next day". The
    // plain nowMins >= openMins && nowMins < closeMins check below can
    // never be true for ANY time in that case (nothing is both >= 1200
    // and < 120), so the shop would look permanently closed no matter
    // what hours were actually set. Split into two ranges instead: open
    // from opening time through midnight, then midnight through closing.
    if (closeMins <= openMins) return nowMins >= openMins || nowMins < closeMins;
    return nowMins >= openMins && nowMins < closeMins;
  }

  function closedMessage(store) {
    if (!store) return "This store isn't available right now.";
    if (store.store_closed) return store.closure_reason ? `${store.name} is temporarily closed: ${store.closure_reason}` : `${store.name} is temporarily closed.`;
    return `${store.name} is currently closed. Orders will reopen at ${String(store.opening_time).slice(0, 5)}.`;
  }

  // ---------------- Store promotional placements ("Promotions" carousel) ----------------
  async function fetchPromotions() {
    const { data, error } = await App.sb.from('store_promotions').select('*').order('priority', { ascending: false });
    if (error) { console.error(error); return; }
    S.set({ storePromotions: data || [] });
  }

  function myPromotions() {
    if (!S.state.profile) return [];
    const mine = myStore();
    if (!mine) return [];
    return S.state.storePromotions.filter(p => p.store_id === mine.id);
  }

  function validatePromoPayload(payload) {
    if (!payload.title || !App.Utils.sanitizeText(payload.title)) return 'Please enter a promotion title.';
    if (!payload.badge || !App.Utils.sanitizeText(payload.badge)) return 'Please enter a badge label.';
    return null;
  }

  function cleanPromoPayload(payload) {
    return {
      title: App.Utils.sanitizeText(payload.title, 80),
      message: App.Utils.sanitizeText(payload.message, 160),
      badge: App.Utils.sanitizeText(payload.badge, 30),
      image_url: App.Utils.sanitizeText(payload.image_url, 500) || null,
      promo_type: payload.promo_type || 'featured',
      start_date: payload.start_date || null,
      end_date: payload.end_date || null,
      active: payload.active !== false,
      priority: Number(payload.priority) || 0,
    };
  }

  async function createPromotion(payload) {
    const err = validatePromoPayload(payload);
    if (err) return { error: err };
    if (!S.state.profile || !S.state.profile.store_id) return { error: 'You need a store set up first.' };
    const clean = cleanPromoPayload(payload);
    clean.store_id = S.state.profile.store_id;
    clean.status = 'pending';
    const { data, error } = await App.sb.from('store_promotions').insert(clean).select().single();
    if (error) return { error: /duplicate/i.test(error.message) ? 'You already have a promotion with that title.' : error.message };
    S.upsertIn('storePromotions', data);
    return { data };
  }

  async function updatePromotion(id, payload) {
    const err = validatePromoPayload(payload);
    if (err) return { error: err };
    // Editing content sends it back for re-review — a store can't sneak an
    // approved placement's copy/image past the developer after the fact.
    const clean = cleanPromoPayload(payload);
    clean.status = 'pending';
    const { data, error } = await App.sb.from('store_promotions').update(clean).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('storePromotions', data);
    return { data };
  }

  async function removePromotion(id) {
    const { error } = await App.sb.from('store_promotions').delete().eq('id', id);
    if (error) return { error: error.message };
    S.removeFrom('storePromotions', id);
    return { ok: true };
  }

  async function approvePromotion(id) {
    const { data, error } = await App.sb.from('store_promotions').update({ status: 'approved' }).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('storePromotions', data);
    await App.Audit.log('approve', 'promotion', id, data.title, null);
    return { data };
  }

  async function rejectPromotion(id, reason) {
    const { data, error } = await App.sb.from('store_promotions').update({ status: 'rejected' }).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('storePromotions', data);
    await App.Audit.log('reject', 'promotion', id, data.title, reason);
    return { data };
  }

  return {
    fetchAll, getById, myStore, create, update, updateHours, approve, reject, archive, unarchive, deletePermanently, isOpenNow, closedMessage,
    fetchPromotions, myPromotions, createPromotion, updatePromotion, removePromotion, approvePromotion, rejectPromotion,
  };
})();
