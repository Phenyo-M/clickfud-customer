/* ============================================================
   CLICKFUD — per-product extras/customizations, read-only for
   customers (schema.sql section 29). Deliberately separate from
   App.Addons (menu_addons — a store-wide checkout upsell catalog,
   unrelated). Fetches the public.menu_item_extras_public view, which
   is already scoped to "linked to this menu item AND currently
   available" server-side — nothing here ever shows an extra a manager
   hasn't explicitly assigned to this exact product.
   ============================================================ */
window.App = window.App || {};

App.ItemExtras = (function () {
  const S = App.Store;

  async function fetchAll() {
    const { data, error } = await App.sb.from('menu_item_extras_public').select('*');
    if (error) { console.error(error); return; }
    S.set({ menuItemExtras: data || [] });
  }

  // Only the extras this exact menu item has been assigned — never a
  // category/store default. Empty array means "no Add-ons section".
  function forMenuItem(menuItemId) {
    return (S.state.menuItemExtras || []).filter(e => e.menu_item_id === menuItemId);
  }

  return { fetchAll, forMenuItem };
})();
