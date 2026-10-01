/* ============================================================
   CLICKFUD — promotions & discount codes
   ============================================================ */
window.App = window.App || {};

App.Promotions = (function () {
  const S = App.Store;

  async function fetchAll() {
    const { data, error } = await App.sb.from('promotions').select('*').order('created_at', { ascending: false });
    if (error) { console.error(error); return { error }; }
    S.set({ promotions: data || [] });
    return { ok: true };
  }

  function validatePayload(payload) {
    if (!payload.code || !App.Utils.sanitizeText(payload.code)) return 'Please enter a promo code.';
    if (!['percentage', 'fixed'].includes(payload.type)) return 'Please choose a discount type.';
    if (!App.Utils.isValidPrice(payload.value) || Number(payload.value) <= 0) return 'Please enter a valid discount value.';
    if (payload.type === 'percentage' && Number(payload.value) > 100) return 'Percentage discount cannot exceed 100%.';
    if (!Array.isArray(payload.menu_item_ids) || !payload.menu_item_ids.length) return 'Please choose at least one product this promo code is for.';
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
      menu_item_ids: payload.menu_item_ids && payload.menu_item_ids.length ? payload.menu_item_ids : null,
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
      menu_item_ids: payload.menu_item_ids && payload.menu_item_ids.length ? payload.menu_item_ids : null,
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

  function productIds(promo) {
    return promo && Array.isArray(promo.menu_item_ids) ? promo.menu_item_ids : [];
  }
  // "Kota Boss", "Kota Boss and Burgers", "Kota Boss, Burgers and Hot dog"
  function productName(promo) {
    const names = productIds(promo).map(id => (S.state.menu || []).find(m => m.id === id)).filter(Boolean).map(m => String(m.name).trim().replace(/\.+$/, '')); // "Burgers." -> "Burgers" inside sentences
    if (!names.length) return null;
    return names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  // What the code's discount is worked out on: only the lines of the
  // products the code was made for (price + extras, x qty). A legacy code
  // with no products counts the whole cart. Same rule as validate_order_pricing (SQL) and
  // the paystack-initialize / paystack-charge-saved functions.
  function eligibleTotal(promo, items) {
    return (items || []).reduce((s, it) => {
      const ids = productIds(promo);
      if (ids.length && (it.isAddon || !ids.includes(it.menuItemId))) return s;
      return s + (Number(it.price) + Number(it.addonsTotal || 0)) * Number(it.qty || 1);
    }, 0);
  }

  function discountFor(promo, eligible) {
    if (eligible <= 0) return 0;
    return promo.type === 'percentage'
      ? Math.round(eligible * (promo.value / 100) * 100) / 100
      : Math.min(Number(promo.value), eligible);
  }

  // items: the cart lines ({ menuItemId, price, addonsTotal, qty, isAddon }).
  function validateCode(code, items) {
    code = String(code || '').trim().toUpperCase();
    if (!code) return { error: 'Please enter a promo code.' };
    const promo = S.state.promotions.find(p => p.code === code);
    if (!promo) return { error: 'This promo code is not valid.' };
    if (!promo.active) return { error: 'This promo code is no longer active.' };
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) return { error: 'This promo code has expired.' };
    if (promo.usage_limit && promo.used_count >= promo.usage_limit) return { error: 'This promo code has reached its usage limit.' };
    const eligible = eligibleTotal(promo, items);
    if (eligible <= 0) {
      const name = productName(promo);
      return { error: name ? `This promo code is only for ${name}. Add ${productIds(promo).length > 1 ? 'one of them' : 'it'} to your cart to use it.` : 'This promo code does not apply to anything in your cart.' };
    }
    return { promo, discount: discountFor(promo, eligible), productName: productName(promo) };
  }

  async function incrementUsage(id) {
    const promo = S.state.promotions.find(p => p.id === id);
    if (!promo) return;
    const { data, error } = await App.sb.from('promotions').update({ used_count: (promo.used_count || 0) + 1 }).eq('id', id).select().single();
    if (!error) S.upsertIn('promotions', data);
  }

  return { fetchAll, create, update, remove, toggleActive, validateCode, eligibleTotal, discountFor, productName, incrementUsage };
})();
