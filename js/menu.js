/* ============================================================
   CLICKFUD — menu CRUD, availability, inventory
   ============================================================ */
window.App = window.App || {};

App.Menu = (function () {
  const S = App.Store;

  // Column list, not select('*') — same reasoning as js/stores.js
  // fetchAll(): this runs on every page load for every visitor, and this
  // is usually the larger of the two payloads (many items per store).
  // Ordering by created_at still works with it left out of the select —
  // PostgREST sorts server-side against the real column regardless of
  // projection. submitted_at/approved_at/rejected_at/suspended_at/
  // rejection_reason/created_at are moderation-queue fields only ever
  // read by the developer app's own separate copy of this file, never
  // this one.
  const LIST_COLUMNS = 'id, name, category, price, platform_fee_amount, image, description, ingredients, allergens, preparation_time, available, stock, low_stock_threshold, rating, rating_count, store_id, status';

  async function fetchAll() {
    const { data, error } = await App.sb.from('menu_items').select(LIST_COLUMNS).order('created_at', { ascending: true });
    if (error) { console.error(error); S.set({ dataLoadError: true }); return; }
    S.set({ menu: data || [] });
  }

  function validate(payload) {
    if (!payload.name || !App.Utils.sanitizeText(payload.name)) return 'Please enter a food name.';
    if (!App.CONST.CATEGORIES.includes(payload.category)) return 'Please choose a valid category.';
    if (!App.Utils.isValidPrice(payload.price)) return 'Please enter a valid price.';
    if (!Number.isInteger(Number(payload.stock)) || Number(payload.stock) < 0) return 'Please enter a valid stock quantity.';
    if (!Number.isInteger(Number(payload.preparation_time)) || Number(payload.preparation_time) < 0) return 'Please enter a valid preparation time.';
    return null;
  }

  function cleanPayload(payload) {
    return {
      name: App.Utils.sanitizeText(payload.name, 80),
      category: payload.category,
      price: Number(payload.price),
      image: App.Utils.sanitizeText(payload.image, 500) || null,
      description: App.Utils.sanitizeText(payload.description, 500),
      ingredients: (payload.ingredients || []).map(s => App.Utils.sanitizeText(s, 40)).filter(Boolean),
      allergens: (payload.allergens || []).map(s => App.Utils.sanitizeText(s, 40)).filter(Boolean),
      preparation_time: Number(payload.preparation_time),
      available: !!payload.available,
      stock: Number(payload.stock),
      low_stock_threshold: Number(payload.low_stock_threshold) || 10,
    };
  }

  async function create(payload) {
    const err = validate(payload);
    if (err) return { error: err };
    if (!S.state.profile || !S.state.profile.store_id) return { error: 'You need a store set up before adding menu items.' };
    const clean = cleanPayload(payload);
    clean.store_id = S.state.profile.store_id;
    const { data, error } = await App.sb.from('menu_items').insert(clean).select().single();
    if (error) return { error: /duplicate/i.test(error.message) ? 'An item with that name already exists.' : error.message };
    S.upsertIn('menu', data);
    return { data };
  }

  async function update(id, payload) {
    const err = validate(payload);
    if (err) return { error: err };
    const { data, error } = await App.sb.from('menu_items').update(cleanPayload(payload)).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('menu', data);
    return { data };
  }

  async function remove(id) {
    const { error } = await App.sb.from('menu_items').delete().eq('id', id);
    if (error) return { error: error.message };
    S.removeFrom('menu', id);
    return { ok: true };
  }

  async function toggleAvailable(id, available) {
    const { data, error } = await App.sb.from('menu_items').update({ available }).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('menu', data);
    return { data };
  }

  async function setStock(id, stock) {
    stock = App.Utils.clamp(Math.round(Number(stock) || 0), 0, 999999);
    const available = stock > 0;
    const { data, error } = await App.sb.from('menu_items').update({ stock, available }).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('menu', data);
    return { data };
  }

  function isLowStock(item) {
    return item.available && item.stock <= (item.low_stock_threshold || 10);
  }
  function isOutOfStock(item) {
    return !item.available || item.stock <= 0;
  }

  return {
    fetchAll, create, update, remove, toggleAvailable, setStock,
    isLowStock, isOutOfStock,
  };
})();
