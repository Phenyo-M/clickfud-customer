/* ============================================================
   CLICKFUD — notifications
   ============================================================ */
window.App = window.App || {};

App.Notifications = (function () {
  const S = App.Store;

  async function fetchForCurrentUser() {
    if (!S.state.profile) { S.set({ notifications: [] }); return; }
    const { data, error } = await App.sb.from('notifications')
      .select('*').eq('user_id', S.state.profile.id)
      .order('created_at', { ascending: false }).limit(50);
    if (error) { console.error(error); return; }
    S.set({ notifications: data || [] });
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

  function unreadCount() {
    return S.state.notifications.filter(n => !n.read).length;
  }

  return { fetchForCurrentUser, create, markRead, markAllRead, unreadCount };
})();
