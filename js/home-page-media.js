/* ============================================================
   CLICKFUD — "Home Page Media": three developer-uploaded images that
   fill the hero/about/"Hungry Between Lectures" panels on the public
   marketing homepage (js/pages/home.js). Public read (RLS: select
   using (true)), developer-only write — enforced server-side by
   supabase/migration_governance.sql section 40, not just by what the
   Developer app's UI shows. Slots stay a plain CSS graphic until a
   developer actually uploads something for that slot — nothing here
   is ever auto-populated.

   title/subtitle (section 41) are the developer's own caption for the
   About/Lectures cards, kept in a separate homePageMediaText state map
   so homePageMedia[slot] (a plain url) never changes shape for its
   existing callers.
   ============================================================ */
window.App = window.App || {};

App.HomePageMedia = (function () {
  const S = App.Store;

  async function fetchAll() {
    const { data, error } = await App.sb.from('home_page_media').select('slot,image_url,title,subtitle');
    if (error) { console.error('HomePageMedia.fetchAll failed:', error); return; }
    const map = {}; const textMap = {};
    (data || []).forEach(row => {
      map[row.slot] = row.image_url || null;
      textMap[row.slot] = { title: row.title || '', subtitle: row.subtitle || '' };
    });
    S.set({ homePageMedia: map, homePageMediaText: textMap });
  }

  return { fetchAll };
})();
