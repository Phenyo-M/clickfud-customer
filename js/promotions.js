/* ============================================================
   CLICKFUD — promotions & discount codes
   ============================================================ */
window.App = window.App || {};

App.Promotions = (function () {
  const S = App.Store;

  async function fetchAll() {
    const { data, error } = await App.sb.from('promotions').select('*').order('created_at', { ascending: false });
    if (error) { console.error(error); return; }
    S.set({ promotions: data || [] });
  }

  function validatePayload(payload) {
    if (!payload.code || !App.Utils.sanitizeText(payload.code)) return 'Please enter a promo code.';
    if (!['percentage', 'fixed'].includes(payload.type)) return 'Please choose a discount type.';
    if (!App.Utils.isValidPrice(payload.value) || Number(payload.value) <= 0) return 'Please enter a valid discount value.';
    if (payload.type === 'percentage' && Number(payload.value) > 100) return 'Percentage discount cannot exceed 100%.';
    return null;
  }

  async function create(payload) {
    const err = validatePayload(payload);
    if (err) return { error: err };
    const { data, error } = await App.sb.from('promotions').insert({
      code: App.Utils.sanitizeText(payload.code, 30).toUpperCase(),
      type: payload.type,
      value: Number(payload.value),
      active: payload.active !== false,
      expires_at: payload.expires_at || null,
      usage_limit: payload.usage_limit ? Number(payload.usage_limit) : null,
    }).select().single();
    if (error) return { error: /duplicate/i.test(error.message) ? 'A promo code with that name already exists.' : error.message };
    S.upsertIn('promotions', data);
    return { data };
  }

  async function update(id, payload) {
    const err = validatePayload(payload);
    if (err) return { error: err };
    const { data, error } = await App.sb.from('promotions').update({
      code: App.Utils.sanitizeText(payload.code, 30).toUpperCase(),
      type: payload.type,
      value: Number(payload.value),
      active: payload.active !== false,
      expires_at: payload.expires_at || null,
      usage_limit: payload.usage_limit ? Number(payload.usage_limit) : null,
    }).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('promotions', data);
    return { data };
  }

  async function remove(id) {
    const { error } = await App.sb.from('promotions').delete().eq('id', id);
    if (error) return { error: error.message };
    S.removeFrom('promotions', id);
    return { ok: true };
  }

  async function toggleActive(id, active) {
    const { data, error } = await App.sb.from('promotions').update({ active }).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('promotions', data);
    return { data };
  }

  function validateCode(code, subtotal) {
    code = String(code || '').trim().toUpperCase();
    if (!code) return { error: 'Please enter a promo code.' };
    const promo = S.state.promotions.find(p => p.code === code);
    if (!promo) return { error: 'This promo code is not valid.' };
    if (!promo.active) return { error: 'This promo code is no longer active.' };
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) return { error: 'This promo code has expired.' };
    if (promo.usage_limit && promo.used_count >= promo.usage_limit) return { error: 'This promo code has reached its usage limit.' };
    const discount = promo.type === 'percentage'
      ? Math.round(subtotal * (promo.value / 100) * 100) / 100
      : Math.min(promo.value, subtotal);
    return { promo, discount };
  }

  async function incrementUsage(id) {
    const promo = S.state.promotions.find(p => p.id === id);
    if (!promo) return;
    const { data, error } = await App.sb.from('promotions').update({ used_count: (promo.used_count || 0) + 1 }).eq('id', id).select().single();
    if (!error) S.upsertIn('promotions', data);
  }

  return { fetchAll, create, update, remove, toggleActive, validateCode, incrementUsage };
})();
