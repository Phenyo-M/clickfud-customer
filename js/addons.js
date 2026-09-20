/* ============================================================
   CLICKFUD — shop add-ons CRUD (drinks, snacks, sides, etc.)
   Same shape/pattern as App.Menu, scoped per store.
   ============================================================ */
window.App = window.App || {};

App.Addons = (function () {
  const S = App.Store;

  async function fetchAll() {
    // Add-ons are a supplementary checkout upsell, not core food data — a
    // failure here (e.g. the migration not run yet) must never trip the
    // same dataLoadError banner that blocks browsing the actual menu.
    const { data, error } = await App.sb.from('menu_addons').select('*').order('created_at', { ascending: true });
    if (error) { console.error(error); return; }
    S.set({ addons: data || [] });
  }

  function validate(payload) {
    if (!payload.name || !App.Utils.sanitizeText(payload.name)) return 'Please enter an item name.';
    if (!App.CONST.ADDON_CATEGORIES.includes(payload.category)) return 'Please choose a valid category.';
    if (!App.Utils.isValidPrice(payload.price)) return 'Please enter a valid price.';
    return null;
  }

  function cleanPayload(payload) {
    return {
      name: App.Utils.sanitizeText(payload.name, 80),
      category: payload.category,
      price: Number(payload.price),
      image_url: App.Utils.sanitizeText(payload.image_url, 500) || null,
      is_available: !!payload.is_available,
    };
  }

  async function create(payload) {
    const err = validate(payload);
    if (err) return { error: err };
    if (!S.state.profile || !S.state.profile.store_id) return { error: 'You need a store set up before adding add-ons.' };
    const clean = cleanPayload(payload);
    clean.store_id = S.state.profile.store_id;
    const { data, error } = await App.sb.from('menu_addons').insert(clean).select().single();
    if (error) return { error: error.message };
    S.upsertIn('addons', data);
    return { data };
  }

  async function update(id, payload) {
    const err = validate(payload);
    if (err) return { error: err };
    const { data, error } = await App.sb.from('menu_addons').update(cleanPayload(payload)).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('addons', data);
    return { data };
  }

  async function remove(id) {
    const { error } = await App.sb.from('menu_addons').delete().eq('id', id);
    if (error) return { error: error.message };
    S.removeFrom('addons', id);
    return { ok: true };
  }

  async function toggleAvailable(id, is_available) {
    const { data, error } = await App.sb.from('menu_addons').update({ is_available }).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('addons', data);
    return { data };
  }

  // Only what a customer should ever see for a given store: available
  // add-ons belonging to that exact store, grouped by category so empty
  // categories (and empty stores) never render a section at all.
  function availableForStore(storeId) {
    return S.state.addons.filter(a => a.store_id === storeId && a.is_available);
  }

  function groupedForStore(storeId) {
    const items = availableForStore(storeId);
    const groups = [];
    App.CONST.ADDON_CATEGORIES.forEach(cat => {
      const inCat = items.filter(a => a.category === cat);
      if (inCat.length) groups.push({ category: cat, items: inCat });
    });
    return groups;
  }

  return {
    fetchAll, create, update, remove, toggleAvailable,
    availableForStore, groupedForStore,
  };
})();
