/* ============================================================
   CLICKFOOD, notifications
   ============================================================ */
window.App = window.App || {};

App.Notifications = (function () {
  const S = App.Store;

  // A notification you never opened doesn't stay "new" forever — past this
  // age it's stale (an old order you already collected/forgot about, a
  // leftover from testing, etc.) and shouldn't keep re-flagging the bell
  // and re-alerting you on every single login. Swept to read automatically
  // below; still fully visible in the panel, just no longer counted as
  // unread. Genuinely recent notifications are untouched.
  const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

  async function fetchForCurrentUser() {
    if (!S.state.profile) { S.set({ notifications: [] }); return; }
    const { data, error } = await App.sb.from('notifications')
      .select('*').eq('user_id', S.state.profile.id)
      .order('created_at', { ascending: false }).limit(50);
    if (error) { console.error(error); return; }
    const list = data || [];
    S.set({ notifications: list });
    markDelivered(list);

    const staleCutoff = Date.now() - STALE_AFTER_MS;
    const staleIds = list.filter(n => !n.read && new Date(n.created_at).getTime() < staleCutoff).map(n => n.id);
    if (staleIds.length) {
      list.forEach(n => { if (staleIds.includes(n.id)) n.read = true; });
      S.notify();
      const { error: sweepError } = await App.sb.from('notifications')
        .update({ read: true }).in('id', staleIds).eq('user_id', S.state.profile.id);
      if (sweepError) console.error('stale notification sweep', sweepError);
    }
  }

  // Notifications are written by the server only (the order queue,
  // supabase/notification_queue.sql, and database functions). The app
  // reads, shows and marks them read.

  // Delivery receipts: tell the queue an in-app notification reached the
  // screen (notification_jobs -> delivered). Batched, never blocks.
  let pendingDelivered = [];
  let deliveredTimer = null;
  const delivered = new Set();
  function markDelivered(list) {
    (list || []).forEach(n => { if (n && n.job_id && !delivered.has(n.id)) { delivered.add(n.id); pendingDelivered.push(n.id); } });
    if (!pendingDelivered.length || deliveredTimer) return;
    deliveredTimer = setTimeout(async () => {
      const ids = pendingDelivered; pendingDelivered = []; deliveredTimer = null;
      const { error } = await App.sb.rpc('mark_notifications_delivered', { p_ids: ids });
      if (error) console.error('mark delivered', error);
    }, 1500);
  }

  // A notification that just arrived live: a short toast, once.
  const toasted = new Set();
  function onIncoming(n) {
    if (!n || n.read || toasted.has(n.id)) return;
    toasted.add(n.id);
    markDelivered([n]);
    if (!stillRelevant(n)) return;
    const msg = String(n.message || '');
    App.Toast.info(msg.length > 140 ? msg.slice(0, 137) + '...' : msg);
  }

  // ---- preferences (notification_preferences; missing row = on, SMS off) ----
  async function loadPrefs() {
    if (!S.state.profile) return;
    const { data, error } = await App.sb.from('notification_preferences')
      .select('channel, event_type, enabled').eq('user_id', S.state.profile.id).eq('event_type', '*');
    if (error) { console.error('notification prefs', error); return; }
    const prefs = {};
    (data || []).forEach(r => { prefs[r.channel] = r.enabled; });
    S.set({ notifPrefs: prefs });
  }
  function prefOn(channel) {
    const p = (S.state.notifPrefs || {})[channel];
    return p === undefined ? channel !== 'sms' : !!p;
  }
  async function setPref(channel, enabled) {
    if (!S.state.profile) return { error: 'Please sign in.' };
    S.set({ notifPrefs: Object.assign({}, S.state.notifPrefs || {}, { [channel]: !!enabled }) });
    const { error } = await App.sb.from('notification_preferences').upsert({
      user_id: S.state.profile.id, channel, event_type: '*', enabled: !!enabled, updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,channel,event_type' });
    if (error) { console.error('notification prefs', error); return { error: 'Could not save this setting.' }; }
    return { data: true };
  }

  async function markRead(id) {
    S.upsertIn('notifications', { id, read: true });
    const { error } = await App.sb.from('notifications').update({ read: true }).eq('id', id);
    if (error) console.error(error);
  }

  async function markAllRead() {
    if (!S.state.profile) return;
    S.state.notifications.forEach(n => n.read = true);
    S.notify();
    const { error } = await App.sb.from('notifications').update({ read: true })
      .eq('user_id', S.state.profile.id).eq('read', false);
    if (error) console.error(error);
  }

  // "Your collection time has passed — are you still going to collect?" is
  // only shown while that order is still waiting for the answer. Once it's
  // rescheduled, collected, cancelled or closed, the question goes away (the
  // reschedule confirmation etc. is its own notification).
  function stillRelevant(n) {
    if (n.type !== 'collection_expired') return true;
    const num = (String(n.message).match(/ORD-\d{4}-\d+/) || [])[0];
    const o = num && (S.state.orders || []).find(x => x.order_number === num);
    if (!o) return !S.state.privateDataFor; // orders not loaded yet: keep it for now
    return o.status === 'ready' && o.collection_state === 'expired';
  }
  function visible() {
    return S.state.notifications.filter(stillRelevant);
  }

  function unreadCount() {
    return visible().filter(n => !n.read).length;
  }

  // Where tapping a notification goes (notifications.link is filled in by
  // the database: supabase/notification_links.sql). null = nowhere to go.
  function target(n) {
    const L = n.link || {};
    const t = n.type || '';
    const st = S.state;
    const shop = App.Seller && App.Seller.myShop();
    if (L.order_id) {
      if ((st.orders || []).some(o => o.id === L.order_id)) return { view: 'track', params: { orderId: L.order_id } };
      if (shop && L.store_id === shop.id) return { view: 'sell', params: { tab: 'orders' } };
      return { view: 'orders', params: {} };
    }
    if (t === 'seller_order') return { view: 'sell', params: { tab: 'orders' } };
    if (t.indexOf('student_') === 0) return { view: 'profile', params: {} };
    if (t === 'entrepreneur_decision') { if (App.Pages.Entrepreneur) App.Pages.Entrepreneur.reset(); return { view: 'entrepreneur', params: {} }; }
    if (L.kind === 'menu_item' || t.indexOf('menu_') === 0) return { view: 'sell', params: { tab: 'products' } };
    if (['store_approved', 'store_rejected', 'store_removed', 'shop_hidden'].includes(t)) return { view: 'sell', params: {} };
    if (t.indexOf('refund') === 0 || t.indexOf('order_') === 0 || ['ready', 'preparing', 'delivered', 'collection_expired'].includes(t)) return { view: 'orders', params: {} };
    if (t.indexOf('group') === 0) return { view: 'groups', params: {} };
    if (t.indexOf('budget') === 0) return { view: 'orders', params: {} };
    if (t.indexOf('timetable') === 0) return { view: 'timetable', params: {} };
    return null;
  }

  return { fetchForCurrentUser, markRead, markAllRead, unreadCount, visible, target, onIncoming, markDelivered, loadPrefs, prefOn, setPref };
})();
