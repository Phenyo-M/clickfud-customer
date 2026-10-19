/* ============================================================
   CLICKFOOD, student food sellers: data + server calls.
   A seller is a normal (student) customer account that owns one
   student shop (stores.seller_kind = 'student'). Every rule here is
   also enforced in the database (supabase/student_sellers.sql); this
   file only gives instant feedback.
   ============================================================ */
window.App = window.App || {};

App.Seller = (function () {
  const S = App.Store;
  const U = App.Utils;

  const data = { forUser: null, loading: false, loaded: false, profile: null, items: [], orders: [], extras: [], extraLinks: [], error: null };
  let channel = null;

  function uid() { return S.state.profile && S.state.profile.id; }

  /** The signed-in student's own student shop row (any status), or null. */
  function myShop() {
    const p = S.state.profile;
    if (!p || p.role !== 'customer' || !p.store_id) return null;
    const s = App.Stores.getById(p.store_id);
    return s && s.seller_kind === 'student' ? s : null;
  }
  function isSeller() { return !!myShop(); }
  function isRemoved() { const s = myShop(); return !!s && s.status === 'archived'; }

  /** Seller details typed on the sign-up form, waiting to be turned into a shop. */
  function pendingSignup() {
    const u = S.state.session && S.state.session.user;
    const m = u && u.user_metadata && u.user_metadata.seller_signup;
    return m && typeof m === 'object' ? m : null;
  }

  // South African mobile -> 27XXXXXXXXX (same rule as normalize_sa_whatsapp()).
  function normalizeWhatsApp(v) {
    let d = String(v || '').replace(/\D/g, '');
    if (/^0[6-8]\d{8}$/.test(d)) d = '27' + d.slice(1);
    return /^27[6-8]\d{8}$/.test(d) ? d : null;
  }
  function formatWhatsApp(n) {
    const d = normalizeWhatsApp(n);
    return d ? `0${d.slice(2, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : '';
  }

  function friendly(error, fallback) {
    const m = (error && error.message) || '';
    if (!m || /JWT|fetch|network|violates row-level|permission denied|function .* does not exist/i.test(m)) return fallback || 'Something went wrong. Please try again.';
    return m.replace(/^.*?ERROR:\s*/, '');
  }

  // ---------------- Loading ----------------
  async function load(force) {
    const me = uid();
    if (!me || !myShop()) return;
    if (data.loading || (data.loaded && data.forUser === me && !force)) return;
    data.loading = true; data.error = null;
    const shopId = myShop().id;
    const [p, i, o] = await Promise.all([
      App.sb.from('seller_profiles').select('*').eq('store_id', shopId).maybeSingle(),
      App.sb.from('menu_items').select('*').eq('store_id', shopId).order('created_at', { ascending: false }),
      App.sb.from('orders').select('*').eq('store_id', shopId).order('created_at', { ascending: false }).limit(500),
    ]);
    data.loading = false;
    if (p.error || i.error || o.error) { data.error = 'Could not load your shop.'; console.error(p.error || i.error || o.error); App.render(); return; }
    Object.assign(data, { forUser: me, loaded: true, profile: p.data, items: i.data || [], orders: o.data || [] });
    loadExtras();
    refreshShop();
    subscribe(shopId);
    App.render();
  }

  function subscribe(shopId) {
    if (channel) { App.sb.removeChannel(channel); channel = null; }
    channel = App.sb.channel('seller-' + shopId + '-' + Date.now())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `store_id=eq.${shopId}` }, (payload) => {
        if (payload.eventType === 'DELETE') data.orders = data.orders.filter(o => o.id !== payload.old.id);
        else {
          const isNew = !data.orders.some(o => o.id === payload.new.id);
          upsert(data.orders, payload.new, true);
          if (isNew && payload.eventType === 'INSERT') App.Toast.success(`New order ${payload.new.order_number || ''}`);
        }
        App.render();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_items', filter: `store_id=eq.${shopId}` }, (payload) => {
        if (payload.eventType === 'DELETE') data.items = data.items.filter(m => m.id !== payload.old.id);
        else upsert(data.items, payload.new, true);
        App.render();
      })
      .subscribe();
  }

  function reset() {
    if (channel) { App.sb.removeChannel(channel); channel = null; }
    Object.assign(data, { forUser: null, loading: false, loaded: false, profile: null, items: [], orders: [], extras: [], extraLinks: [], error: null });
  }

  function upsert(list, row, toFront) {
    const i = list.findIndex(x => x.id === row.id);
    if (i >= 0) list[i] = Object.assign({}, list[i], row);
    else if (toFront) list.unshift(row); else list.push(row);
  }

  // ---------------- Application answers (same questions the developer sees) ----------------
  const BUSINESS_TYPES = [['fast_food', 'Fast food'], ['kota_shop', 'Kota shop'], ['takeaway', 'Takeaway / home kitchen'], ['bakery', 'Bakery'], ['other', 'Other']];
  const POSITIONS = [['owner', 'Owner'], ['manager', 'Manager'], ['other', 'Other']];
  function checkDetails(d) {
    if (!BUSINESS_TYPES.some(([k]) => k === d.business_type)) return 'Please choose your business type.';
    if (!normalizeWhatsApp(d.contact_phone)) return 'Please enter a valid business phone number.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d.contact_email || '').trim())) return 'Please enter a valid business email address.';
    if (!normalizeWhatsApp(d.manager_phone)) return 'Please enter a valid phone number for yourself.';
    if (!POSITIONS.some(([k]) => k === d.manager_position)) return 'Please choose your role in the business.';
    if (d.is_registered && !d.registration_date) return 'Please enter the date your business was registered.';
    if (!d.open_days || !d.open_days.length) return 'Please choose the days you sell.';
    if (!d.opening_time || !d.closing_time) return 'Please enter your opening and closing times.';
    if (String(d.products_summary || '').trim().length < 3) return 'Please say what food you sell.';
    return null;
  }
  function cleanDetails(d) {
    return {
      business_type: d.business_type, contact_phone: normalizeWhatsApp(d.contact_phone), contact_email: String(d.contact_email || '').trim().toLowerCase(),
      is_registered: !!d.is_registered, registration_date: d.is_registered ? d.registration_date : null,
      manager_phone: normalizeWhatsApp(d.manager_phone), manager_position: d.manager_position,
      open_days: (d.open_days || []).map(Number), opening_time: d.opening_time, closing_time: d.closing_time,
      products_summary: U.sanitizeText(d.products_summary || '', 300),
    };
  }
  async function updateDetails(description, d) {
    if (String(description || '').trim().length < 10) return { error: 'Please describe your food business (at least 10 characters).' };
    const err = checkDetails(d);
    if (err) return { error: err };
    const { data: row, error } = await App.sb.rpc('update_student_shop_details', { p_description: description.trim(), p_details: cleanDetails(d) });
    if (error) return { error: friendly(error) };
    S.upsertIn('stores', Array.isArray(row) ? row[0] : row);
    return { data: row };
  }

  // ---------------- Becoming a seller ----------------
  async function becomeSeller(f) {
    const wa = normalizeWhatsApp(f.whatsapp);
    if (!f.businessName || f.businessName.trim().length < 2) return { error: 'Please enter your food business name.' };
    if (!wa) return { error: 'Please enter a valid South African WhatsApp number.' };
    if (!f.categories || !f.categories.length) return { error: 'Please choose the food categories you sell.' };
    if (f.categories.includes('Other Food') && !(f.otherFood || '').trim()) return { error: 'Please say what other food you sell.' };
    if (!f.campus) return { error: 'Please choose your campus.' };
    if (String(f.description || '').trim().length < 10) return { error: 'Please describe your food business (at least 10 characters).' };
    const detailsErr = checkDetails(f.details || {});
    if (detailsErr) return { error: detailsErr };
    if (f.hustleup !== true && f.hustleup !== false) return { error: 'Please say if you are a hustleUP member.' };
    if (!f.coverUrl) return { error: 'Please add a photo of your shop.' };
    if (!f.address || f.address.trim().length < 5) return { error: 'Please enter your pickup address.' };
    if (!f.pin) return { error: 'Please put your pickup point on the map.' };
    if (!f.acceptRules) return { error: 'Please accept the seller rules.' };
    const { data: shop, error } = await App.sb.rpc('become_student_seller', {
      p_business_name: f.businessName.trim(), p_whatsapp: wa, p_categories: f.categories,
      p_other_food: (f.otherFood || '').trim() || null, p_campus: f.campus,
      p_description: (f.description || '').trim() || null, p_logo_url: f.logoUrl || null, p_cover_url: f.coverUrl,
      p_address: f.address.trim(), p_lat: f.pin.lat, p_lng: f.pin.lng, p_hustleup: f.hustleup, p_accept_rules: true, p_details: cleanDetails(f.details),
    });
    if (error) return { error: friendly(error, 'Could not open your shop. Please try again.') };
    const row = Array.isArray(shop) ? shop[0] : shop;
    S.upsertIn('stores', row);
    S.set({ profile: Object.assign({}, S.state.profile, { store_id: row.id }) });
    // The sign-up details have been used; don't offer them again.
    if (pendingSignup()) App.sb.auth.updateUser({ data: { seller_signup: null } }).catch(() => {});
    reset();
    load();
    return { data: row };
  }

  async function saveProfile(f) {
    const wa = normalizeWhatsApp(f.whatsapp);
    if (!wa) return { error: 'Please enter a valid South African WhatsApp number.' };
    if (!f.categories || !f.categories.length) return { error: 'Please choose the food categories you sell.' };
    if (f.categories.includes('Other Food') && !(f.otherFood || '').trim()) return { error: 'Please say what other food you sell.' };
    const { data: sp, error } = await App.sb.rpc('update_seller_profile', { p_whatsapp: wa, p_categories: f.categories, p_other_food: (f.otherFood || '').trim() || null });
    if (error) return { error: friendly(error) };
    data.profile = Array.isArray(sp) ? sp[0] : sp;
    return { data: data.profile };
  }

  async function saveWhatsApp(v) {
    const wa = normalizeWhatsApp(v);
    if (!wa) return { error: 'Please enter a valid South African WhatsApp number.' };
    const { data: sp, error } = await App.sb.rpc('update_seller_whatsapp', { p_whatsapp: wa });
    if (error) return { error: friendly(error) };
    data.profile = Array.isArray(sp) ? sp[0] : sp;
    return { data: data.profile };
  }

  /** Approved shop + MIN_PRODUCTS approved products: goes live. */
  const MIN_PRODUCTS = 5;
  function approvedCount() { return data.items.filter(m => m.status === 'approved').length; }
  async function publish() {
    const { data: row, error } = await App.sb.rpc('publish_student_shop');
    if (error) return { error: friendly(error, 'Could not publish your shop.') };
    S.upsertIn('stores', Array.isArray(row) ? row[0] : row);
    return { data: row };
  }
  async function setHustleUp(member) {
    const { error } = await App.sb.rpc('set_hustleup_member', { p_member: !!member });
    if (error) return { error: friendly(error) };
    if (data.profile) data.profile.hustleup_member = !!member;
    return { data: true };
  }
  async function refreshShop() {
    const shop = myShop();
    if (!shop) return;
    const { data: row } = await App.sb.from('stores').select('*').eq('id', shop.id).maybeSingle();
    if (row) S.upsertIn('stores', row);
  }

  async function deleteShop() {
    const shop = myShop();
    const { error } = await App.sb.rpc('delete_student_shop');
    if (error) return { error: friendly(error, 'Could not delete your shop.') };
    if (shop) S.upsertIn('stores', Object.assign({}, shop, { status: 'archived', is_published: false, archived_by: S.state.profile.id }));
    S.set({ profile: Object.assign({}, S.state.profile, { store_id: null }) });
    reset();
    return { data: true };
  }

  // Per-day selling hours: { "0".."6": { open, close } | null }. Also keeps
  // opening_time / closing_time / closed_days in step (earliest open,
  // latest close, days off) for anything that reads those.
  async function saveSchedule(days) {
    const weekly = {};
    let on = 0, earliest = null, latest = null;
    for (let i = 0; i < 7; i++) {
      const d = days[i];
      if (!d || !d.on) { weekly[String(i)] = null; continue; }
      if (!/^\d{2}:\d{2}$/.test(d.open || '') || !/^\d{2}:\d{2}$/.test(d.close || '')) return { error: 'Please set both times for each day you sell.' };
      if (d.open === d.close) return { error: 'Opening and closing time can\'t be the same.' };
      weekly[String(i)] = { open: d.open, close: d.close };
      on++;
      if (!earliest || d.open < earliest) earliest = d.open;
      if (!latest || d.close > latest) latest = d.close;
    }
    if (!on) return { error: 'Choose at least one day you sell. Use Pause orders for a break.' };
    const closed = [0, 1, 2, 3, 4, 5, 6].filter(i => !weekly[String(i)]);
    return updateShop({ weekly_hours: weekly, opening_time: earliest, closing_time: latest, closed_days: closed });
  }

  // ---------------- Extras (e.g. "Extra cheese +R5") ----------------
  async function loadExtras() {
    const shop = myShop();
    if (!shop) return;
    const { data: ex } = await App.sb.from('item_extras').select('*').eq('store_id', shop.id).order('created_at');
    data.extras = ex || [];
    const ids = data.extras.map(e => e.id);
    if (ids.length) {
      const { data: links } = await App.sb.from('item_extra_links').select('*').in('item_extra_id', ids);
      data.extraLinks = links || [];
    } else data.extraLinks = [];
    App.render();
  }
  function foodsFor(extraId) { return data.extraLinks.filter(l => l.item_extra_id === extraId).map(l => l.menu_item_id); }
  async function saveExtra(f, id) {
    const name = U.sanitizeText(f.name || '', 40);
    const price = Math.round(Number(f.price) * 100) / 100;
    if (name.length < 2) return { error: 'Please name the extra.' };
    if (!(price >= 0 && price <= 200)) return { error: 'Extras cost between R0 and R200.' };
    const shop = myShop();
    const row = { name, price, available: !!f.available };
    const q = id ? App.sb.from('item_extras').update(row).eq('id', id).select().single()
                 : App.sb.from('item_extras').insert(Object.assign({ store_id: shop.id }, row)).select().single();
    const { data: saved, error } = await q;
    if (error) return { error: friendly(error, 'Could not save this extra.') };
    // which foods offer it
    const want = new Set(f.foods || []);
    const have = new Set(foodsFor(saved.id));
    const add = [...want].filter(x => !have.has(x)).map(menu_item_id => ({ menu_item_id, item_extra_id: saved.id }));
    const remove = [...have].filter(x => !want.has(x));
    if (add.length) { const r = await App.sb.from('item_extra_links').insert(add); if (r.error) return { error: friendly(r.error) }; }
    if (remove.length) { const r = await App.sb.from('item_extra_links').delete().eq('item_extra_id', saved.id).in('menu_item_id', remove); if (r.error) return { error: friendly(r.error) }; }
    await loadExtras();
    if (App.ItemExtras) App.ItemExtras.fetchAll();
    return { data: saved };
  }
  async function deleteExtra(id) {
    await App.sb.from('item_extra_links').delete().eq('item_extra_id', id);
    const { error } = await App.sb.from('item_extras').delete().eq('id', id);
    if (error) return { error: friendly(error, 'Could not remove this extra.') };
    await loadExtras();
    if (App.ItemExtras) App.ItemExtras.fetchAll();
    return { data: true };
  }

  async function updateShop(patch) {
    const shop = myShop();
    if (!shop) return { error: 'No shop.' };
    const { data: row, error } = await App.sb.from('stores').update(patch).eq('id', shop.id).select().single();
    if (error) return { error: friendly(error) };
    S.upsertIn('stores', row);
    return { data: row };
  }

  // ---------------- Products ----------------
  function validateItem(f) {
    if (!f.image) return 'Please add a photo of the food.';
    if (!f.name || f.name.trim().length < 2) return 'Please enter the food name.';
    if (!App.CONST.STUDENT_FOOD_CATEGORIES.includes(f.category)) return 'Please choose a food category.';
    if (f.category === 'Other Food' && !(f.otherFoodDetail || '').trim()) return 'Please say what food this is.';
    if (!f.description || f.description.trim().length < 10) return 'Please describe the food (at least 10 characters).';
    const price = Number(f.price);
    if (!(price >= 1 && price <= 1000)) return 'Please enter a price between R1 and R1000.';
    const stock = Number(f.stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > 999) return 'Please enter how many you have (0 to 999).';
    return null;
  }

  async function saveItem(f, id) {
    const err = validateItem(f);
    if (err) return { error: err };
    const shop = myShop();
    if (!shop) return { error: 'No shop.' };
    const row = {
      name: U.sanitizeText(f.name, 60),
      category: f.category,
      other_food_detail: f.category === 'Other Food' ? U.sanitizeText(f.otherFoodDetail, 120) : null,
      description: U.sanitizeText(f.description, 400),
      price: Math.round(Number(f.price) * 100) / 100,
      stock: Number(f.stock),
      image: f.image,
      allergens: String(f.allergens || '').split(',').map(a => a.trim()).filter(Boolean).slice(0, 12),
      available: !!f.available,
      preparation_time: Math.max(0, Math.min(240, Number(f.prepTime) || 20)),
    };
    const q = id
      ? App.sb.from('menu_items').update(row).eq('id', id).select().single()
      : App.sb.from('menu_items').insert(Object.assign({ store_id: shop.id }, row)).select().single();
    const { data: saved, error } = await q;
    if (error) return { error: friendly(error, 'Could not save this product.') };
    upsert(data.items, saved, true);
    return { data: saved };
  }

  async function setAvailable(id, available) {
    const { data: saved, error } = await App.sb.from('menu_items').update({ available }).eq('id', id).select().single();
    if (error) return { error: friendly(error) };
    upsert(data.items, saved);
    if (saved.status === 'approved') S.upsertIn('menu', saved);
    return { data: saved };
  }

  async function deleteItem(id) {
    const { error } = await App.sb.from('menu_items').delete().eq('id', id);
    if (error) return { error: friendly(error, 'Could not remove this product.') };
    data.items = data.items.filter(m => m.id !== id);
    S.removeFrom('menu', id);
    return { data: true };
  }

  /** What the seller sees for a listing. */
  function listingStatus(item) {
    if (item.status === 'pending') return { label: 'Pending review', cls: 'badge-yellow' };
    if (item.status === 'rejected') return { label: 'Rejected', cls: 'badge-error' };
    if (item.status === 'suspended') return { label: 'Removed', cls: 'badge-error' };
    if (!item.available || item.stock <= 0) return { label: 'Unavailable', cls: 'badge-gray' };
    return { label: 'Published', cls: 'badge-success' };
  }

  // ---------------- Orders ----------------
  async function orderAction(orderId, action, reason, note, code) {
    const { data: row, error } = await App.sb.rpc('seller_update_order', { p_order_id: orderId, p_action: action, p_reason: reason || null, p_note: note || null, p_code: code || null });
    if (error) return { error: friendly(error, 'Could not update this order.') };
    const o = Array.isArray(row) ? row[0] : row;
    upsert(data.orders, o);
    return { data: o };
  }

  // ---------------- Stats ----------------
  function stats() {
    const items = data.items, orders = data.orders;
    const count = (st) => orders.filter(o => o.status === st).length;
    const live = orders.filter(o => o.status !== 'cancelled');
    const popular = {};
    live.forEach(o => (o.items || []).forEach(it => {
      if (it.isAddon) return;
      popular[it.name] = (popular[it.name] || 0) + (Number(it.qty) || 1);
    }));
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      const next = new Date(d.getTime() + 86400000);
      days.push({ date: d, count: orders.filter(o => { const t = new Date(o.created_at); return t >= d && t < next; }).length });
    }
    return {
      products: items.length,
      active: items.filter(m => listingStatus(m).label === 'Published').length,
      pending: items.filter(m => m.status === 'pending').length,
      received: orders.length,
      newOrders: count('received'),
      preparing: count('preparing'),
      ready: count('ready'),
      completed: count('collected'),
      cancelled: count('cancelled'),
      completedValue: orders.filter(o => o.status === 'collected').reduce((s, o) => s + Number(o.total || 0), 0),
      popular: Object.entries(popular).sort((a, b) => b[1] - a[1]).slice(0, 5),
      days,
    };
  }

  // ---------------- WhatsApp (buyer side) ----------------
  // The window is opened straight away (inside the tap) so phones don't
  // block it, then pointed at WhatsApp once the number arrives.
  async function contactSeller(storeId, item, customText) {
    if (!S.state.profile) {
      App.Toast.info('Log in to contact sellers.');
      S.set({ forceAuthView: true });
      return App.Pages.Auth.setTab('login');
    }
    const win = window.open('', '_blank');
    const { data: num, error } = await App.sb.rpc('seller_contact', { p_store_id: storeId });
    const wa = !error && normalizeWhatsApp(num);
    if (!wa) {
      if (win) win.close();
      App.Toast.error("This seller's WhatsApp number isn't available right now.");
      return;
    }
    const text = customText ? customText : item
      ? `Hi, I found your food on ClickFood. I am interested in ${item.name}, listed at ${U.money(U.menuItemPrice(item))}. Is it available?`
      : 'Hi, I found your food on ClickFood.';
    const url = `https://wa.me/${wa}?text=${encodeURIComponent(text)}`;
    if (win) win.location = url; else window.location.href = url;
  }

  return {
    data, myShop, isSeller, isRemoved, pendingSignup, normalizeWhatsApp, formatWhatsApp,
    load, reset, becomeSeller, saveProfile, saveWhatsApp, updateShop, saveExtra, deleteExtra, foodsFor, loadExtras, saveSchedule, updateDetails, BUSINESS_TYPES, POSITIONS, deleteShop, publish, setHustleUp, refreshShop, approvedCount, MIN_PRODUCTS,
    saveItem, setAvailable, deleteItem, listingStatus, orderAction, stats, contactSeller,
  };
})();
