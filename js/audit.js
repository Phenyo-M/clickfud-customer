/* ============================================================
   CLICKFUD — developer audit log (records administrative
   actions on shops: approve/reject/archive/delete)
   ============================================================ */
window.App = window.App || {};

App.Audit = (function () {
  const S = App.Store;

  async function log(action, targetType, targetId, targetName, reason) {
    if (!S.state.profile) return;
    await App.sb.from('audit_log').insert({
      actor_id: S.state.profile.id,
      actor_name: S.state.profile.name,
      action, target_type: targetType, target_id: targetId, target_name: targetName,
      reason: reason || null,
    });
  }

  async function fetchAll() {
    const { data, error } = await App.sb.from('audit_log').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) { console.error(error); return []; }
    return data || [];
  }

  return { log, fetchAll };
})();
