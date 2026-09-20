/* ============================================================
   CLICKFUD — campus-wide delivery zones (platform-level, not
   per-store). Business hours / closure now live on each store row
   — see js/stores.js (App.Stores.isOpenNow/closedMessage/updateHours).
   ============================================================ */
window.App = window.App || {};

App.Settings = (function () {
  const S = App.Store;

  async function fetchZones() {
    const { data, error } = await App.sb.from('delivery_zones').select('*').order('name');
    if (error) { console.error(error); return; }
    S.set({ zones: data || [] });
  }

  async function createZone(name, fee) {
    name = App.Utils.sanitizeText(name, 60);
    if (!name) return { error: 'Please enter a zone name.' };
    if (!App.Utils.isValidPrice(fee)) return { error: 'Please enter a valid delivery fee.' };
    const { data, error } = await App.sb.from('delivery_zones').insert({ name, fee: Number(fee) }).select().single();
    if (error) return { error: error.message };
    S.upsertIn('zones', data);
    return { data };
  }

  async function updateZone(id, name, fee) {
    name = App.Utils.sanitizeText(name, 60);
    if (!name) return { error: 'Please enter a zone name.' };
    if (!App.Utils.isValidPrice(fee)) return { error: 'Please enter a valid delivery fee.' };
    const { data, error } = await App.sb.from('delivery_zones').update({ name, fee: Number(fee) }).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('zones', data);
    return { data };
  }

  async function removeZone(id) {
    const { error } = await App.sb.from('delivery_zones').delete().eq('id', id);
    if (error) return { error: error.message };
    S.removeFrom('zones', id);
    return { ok: true };
  }

  return { fetchZones, createZone, updateZone, removeZone };
})();
