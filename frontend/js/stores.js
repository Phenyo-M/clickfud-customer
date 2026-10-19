/* ============================================================
   CLICKFOOD, stores (multi-vendor marketplace)
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
  const LIST_COLUMNS = 'id, name, description, category, logo_url, cover_image_url, contact_phone, contact_email, campus_location, address, accepts_delivery, accepts_collection, delivery_fee, prep_time_min, prep_time_max, rating, rating_count, opening_time, closing_time, closed_days, store_closed, closure_reason, status, rejection_reason, university, is_published, rating_breakdown, weekly_hours, busy, busy_extra_minutes, closure_category, verified, atmosphere_tags, seller_kind, pickup_lat, pickup_lng, test_mode, availability, location_type';

  async function fetchAll() {
    let { data, error } = await App.sb.from('stores').select(LIST_COLUMNS).order('name');
    // a database without the newest column (e.g. a migration rolled back)
    // must not leave students with no shops at all
    if (error && error.code === '42703') ({ data, error } = await App.sb.from('stores').select(LIST_COLUMNS.replace(', availability, location_type', '')).order('name'));
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

  // ---------------- Open / Busy / Paused / Closed ----------------
  // Mirrors public.store_status() (supabase/ordering_rules.sql), which is
  // what actually decides whether an order is accepted — this copy only
  // drives what customers see. Always South African time, whatever the
  // phone's own clock/timezone says.
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const CLOSURE_LABELS = { maintenance: 'Kitchen maintenance', staff_shortage: 'Staff shortage', ingredients: 'Ingredients unavailable', other: 'Other' };
  const TAG_LABELS = { music: 'Music', study_friendly: 'Study-friendly', group_friendly: 'Group-friendly', quick_collection: 'Quick collection', seating: 'Seating available' };
  const CLOSING_SOON_MINUTES = 30;

  function saNow() {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Johannesburg', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const get = (t) => (parts.find(p => p.type === t) || {}).value;
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    return { dow, mins: Number(get('hour')) * 60 + Number(get('minute')) };
  }
  const toMins = (t) => { const [h, m] = String(t || '').slice(0, 5).split(':').map(Number); return h * 60 + m; };
  const hhmm = (t) => String(t || '').slice(0, 5);

  /** {open, close} ("HH:MM") for a day of the week (0 = Sunday), or null when closed that day. */
  function hoursOn(store, dow) {
    if (store.weekly_hours) {
      const d = store.weekly_hours[String(dow)];
      return d && d.open && d.close ? { open: d.open, close: d.close } : null;
    }
    if ((store.closed_days || []).includes(dow)) return null;
    if (!store.opening_time || !store.closing_time) return null;
    return { open: hhmm(store.opening_time), close: hhmm(store.closing_time) };
  }

  /** The next time the shop opens, as a short label ("07:00" today, "Mon 07:00" later). */
  function nextOpening(store, now) {
    for (let i = 0; i < 7; i++) {
      const dow = (now.dow + i) % 7;
      const h = hoursOn(store, dow);
      if (!h) continue;
      if (i === 0 && toMins(h.open) <= now.mins) continue;
      return i === 0 ? h.open : `${DAY_NAMES[dow].slice(0, 3)} ${h.open}`;
    }
    return null;
  }

  /**
   * { state: 'open'|'busy'|'paused'|'closed', label, detail, closingSoon }
   *  open    — taking orders
   *  busy    — taking orders, longer wait
   *  paused  — temporarily closed by the shop (reason shown)
   *  closed  — outside opening hours
   */
  function statusOf(store) {
    if (!store) return { state: 'closed', label: 'Closed', detail: "This shop isn't available right now." };
    if (store.store_closed) {
      const reason = (store.closure_reason || '').trim() || CLOSURE_LABELS[store.closure_category] || '';
      return { state: 'paused', label: 'Temporarily closed', detail: reason ? `Reason: ${reason}` : 'Not taking new orders right now.' };
    }
    const now = saNow();
    let closeAt = null;
    const today = hoursOn(store, now.dow);
    if (today) {
      const o = toMins(today.open), c = toMins(today.close);
      const openNow = c > o ? (now.mins >= o && now.mins < c) : now.mins >= o;   // c <= o runs past midnight
      if (openNow) closeAt = c > o ? c : c + 1440;
    }
    if (closeAt === null) {
      const y = hoursOn(store, (now.dow + 6) % 7);
      if (y && toMins(y.close) <= toMins(y.open) && now.mins < toMins(y.close)) closeAt = toMins(y.close);
    }
    if (closeAt === null) {
      const next = nextOpening(store, now);
      return { state: 'closed', label: 'Closed', detail: next ? `Opens ${/^\d/.test(next) ? 'at ' : ''}${next}` : 'Not open this week' };
    }
    const closingSoon = closeAt - now.mins <= CLOSING_SOON_MINUTES;
    const closesLabel = `${String(Math.floor((closeAt % 1440) / 60)).padStart(2, '0')}:${String(closeAt % 60).padStart(2, '0')}`;
    if (store.busy) {
      return { state: 'busy', label: 'Busy', closingSoon, detail: `Taking orders. Expect about ${store.busy_extra_minutes || 15} min extra` };
    }
    return { state: 'open', label: closingSoon ? 'Closing soon' : 'Open', closingSoon, detail: closingSoon ? `Closes at ${closesLabel}` : `Open until ${closesLabel}` };
  }

  /** Mon–Sun rows for the shop profile: [{ day, hours: "07:00–18:00" | "Closed", today }]. */
  function weekHours(store) {
    const today = saNow().dow;
    return [1, 2, 3, 4, 5, 6, 0].map(dow => {
      const h = hoursOn(store, dow);
      return { day: DAY_NAMES[dow], hours: h ? `${h.open}–${h.close}` : 'Closed', today: dow === today };
    });
  }

  function isOpenNow(store) {
    if (!store) return true;
    const s = statusOf(store).state;
    return s === 'open' || s === 'busy';
  }

  function closedMessage(store) {
    if (!store) return "This store isn't available right now.";
    const s = statusOf(store);
    if (s.state === 'paused') return `${store.name} is temporarily closed. ${s.detail}`;
    return `${store.name} is closed right now. ${s.detail}.`;
  }

  /** Badge class for a status (existing badge styles only). */
  function statusBadgeClass(state) {
    return state === 'open' ? 'badge-success' : state === 'busy' ? 'badge-yellow' : state === 'paused' ? 'badge-gray' : 'badge-error';
  }

  /** The shop's pickup address — ignoring the "not yet set" placeholder some shops still have. */
  function pickupLocation(store) {
    const a = (store && store.address || '').trim();
    return a && !/not yet set/i.test(a) ? a : '';
  }

  function tagLabels(store) {
    return (store.atmosphere_tags || []).map(t => TAG_LABELS[t]).filter(Boolean);
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

  // Test mode (stores.test_mode, set by the developer): the shop can be
  // browsed but nobody can order from it. The database refuses the order
  // too (ordering_block_reason); this only keeps the app honest about it.
  function inTestMode(storeOrId) {
    const s = typeof storeOrId === 'string' ? getById(storeOrId) : storeOrId;
    return !!(s && s.test_mode);
  }
  function testModeMessage(store) {
    return `${store && store.name ? store.name : 'This shop'} is in test mode. You can look around, but ordering isn't open yet.`;
  }

  // Business (partner) shops: shown to students only when the developer
  // switches them on (developer app, Shops). Remembered on the phone so the
  // offline shop list matches; App.CONFIG.SHOW_PARTNER_SHOPS is the fallback.
  let partners = null; let online = null; let recess = null;
  let maxKm = 30; let distanceRule = true;   // supabase/order_distance.sql (the server enforces it)
  try { const v = localStorage.getItem('clickfood_show_partner_shops'); if (v !== null) partners = v === '1'; } catch (e) { /* storage blocked */ }
  try { const v = localStorage.getItem('clickfood_online_payments'); if (v !== null) online = v === '1'; } catch (e) { /* storage blocked */ }
  try { const v = localStorage.getItem('clickfood_show_recessbox'); if (v !== null) recess = v === '1'; } catch (e) { /* storage blocked */ }
  async function fetchFlags() {
    try {
      const { data, error } = await App.sb.rpc('public_app_flags');
      if (error || !data) return;
      partners = !!data.show_partner_shops;
      online = data.online_payments !== false;
      recess = data.show_recessbox === true;
      if (data.max_order_km != null) maxKm = Number(data.max_order_km) || 30;
      if (data.distance_rule != null) distanceRule = data.distance_rule !== false;
      try { localStorage.setItem('clickfood_show_recessbox', recess ? '1' : '0'); } catch (e) { /* storage blocked */ }
      try { localStorage.setItem('clickfood_show_partner_shops', partners ? '1' : '0'); localStorage.setItem('clickfood_online_payments', online ? '1' : '0'); } catch (e) { /* storage blocked */ }
    } catch (e) { /* offline: keep the last known value */ }
  }
  function partnersShown() { return partners === null ? !!App.CONFIG.SHOW_PARTNER_SHOPS : partners; }
  // Online payment (PayFast) can be switched off by the developer; the
  // server refuses new online payments then too (create-payfast-payment).
  function onlinePaymentsOn() { return online !== false; }
  // RecessBox stays hidden until the developer shows it (still being built).
  function recessBoxShown() { return recess === true; }
  function maxOrderKm() { return maxKm; }
  function distanceRuleOn() { return distanceRule; }

  return {
    fetchAll, fetchFlags, partnersShown, onlinePaymentsOn, recessBoxShown, maxOrderKm, distanceRuleOn, getById, myStore, create, update, updateHours, approve, reject, archive, unarchive, deletePermanently, isOpenNow, closedMessage, inTestMode, testModeMessage,
    statusOf, statusBadgeClass, weekHours, tagLabels, saNow, pickupLocation, hoursOn,
    fetchPromotions, myPromotions, createPromotion, updatePromotion, removePromotion, approvePromotion, rejectPromotion,
  };
})();
