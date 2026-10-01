/* ============================================================
   CLICKFUD — notifications
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

  async function create(userId, message, type) {
    const { error } = await App.sb.from('notifications').insert({
      user_id: userId, message: App.Utils.sanitizeText(message, 300), type: type || 'info',
    });
    if (error) console.error('notify create', error);
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

  return { fetchForCurrentUser, create, markRead, markAllRead, unreadCount, visible };
})();
