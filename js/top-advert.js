/* ============================================================
   CLICKFUD — "Top Advert": read-only fetch of the single published+
   active advert (if any) for the customer home screen's top banner.
   Entirely separate from store_promotions (the "Promotions" carousel)
   — this table starts empty and stays empty until a developer
   explicitly publishes something (see the Developer app's
   js/top-advert.js and schema.sql section 28). RLS guarantees this
   fetch can only ever see a row that is both status='published' and
   active=true; a draft or unpublished advert is invisible here even
   if one exists.
   ============================================================ */
window.App = window.App || {};

App.TopAdvert = (function () {
  const S = App.Store;

  async function fetchCurrent() {
    const { data, error } = await App.sb.from('top_adverts').select('*').order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (error) { console.error('TopAdvert.fetchCurrent failed:', error); return; }
    S.set({ topAdvert: data || null });
  }

  return { fetchCurrent };
})();
