/* ============================================================
   CLICKFOOD, campus directory (supabase/tut_campuses.sql)

   Buildings and places on a campus, from researched sources: libraries,
   computer centres (iCentres), academic and other buildings. Only current,
   verified places are readable (RLS). Searched and filtered in the database,
   30 at a time. Pickup points are listed separately: a building in the
   directory is NOT a pickup point unless a developer has switched one on.
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Directory = (function () {
  const S = App.Store;
  const U = App.Utils;
  const esc = (v) => U.escapeHtml(v == null ? '' : String(v));
  const PAGE = 30;
  const CATS = [['', 'All places'], ['library', 'Libraries'], ['computer_centre', 'Computer centres'], ['academic_building', 'Academic buildings'],
    ['lecture_hall', 'Lecture halls'], ['student_centre', 'Student centres'], ['cafeteria', 'Cafeterias'], ['food_court', 'Food courts'],
    ['restaurant', 'Restaurants'], ['administrative', 'Administration'], ['residence', 'Residences'], ['other', 'Other']];
  const CAT_LABEL = Object.fromEntries(CATS.filter(c => c[0]));
  const ICON = { library: 'library', computer_centre: 'monitor', academic_building: 'school', lecture_hall: 'presentation', student_centre: 'users',
    cafeteria: 'coffee', food_court: 'utensils', restaurant: 'utensils', administrative: 'building-2', residence: 'bed', pickup_point: 'package', other: 'map-pin' };
  const st = { campusId: null, q: '', cat: '', rows: null, more: false, loading: false, error: null, pickups: null, key: '' };
  let timer = null;

  function campuses() {
    const home = App.Discovery.homeUniversity();
    return App.Discovery.campuses().filter(c => !home || c.university_id === home.id);
  }
  function defaultCampus() {
    const list = campuses();
    const mine = App.Discovery.myCampus();
    return (mine && list.find(c => c.id === mine.id)) || list[0] || null;
  }

  async function load(append) {
    if (!st.campusId) return;
    const key = [st.campusId, st.q, st.cat].join('|');
    st.loading = true; st.error = null; if (!append) { st.rows = null; st.key = key; }
    App.render();
    let qb = App.sb.from('campus_venues')
      .select('id, name, alt_names, category, building_number, rooms, address, description, last_verified, source_url, pickup_suitable')
      .eq('campus_id', st.campusId);
    if (st.cat) qb = qb.eq('category', st.cat);
    const term = st.q.trim().replace(/[%,()*]/g, ' ').slice(0, 60);
    if (term) qb = qb.or(`name.ilike.%${term}%,building_number.ilike.%${term}%,rooms.ilike.%${term}%,description.ilike.%${term}%`);
    const from = append && st.rows ? st.rows.length : 0;
    const { data, error } = await qb.order('category').order('name').range(from, from + PAGE);
    if (st.key !== key) return;   // a newer search finished first
    st.loading = false;
    if (error) { st.error = 'Couldn\'t load the directory. Check your connection and try again.'; return App.render(); }
    const page = (data || []).slice(0, PAGE);
    st.more = (data || []).length > PAGE;
    st.rows = append && st.rows ? st.rows.concat(page) : page;
    if (!append) loadPickups();
    App.render();
  }
  async function loadPickups() {
    const { data } = await App.sb.from('pickup_points').select('id, name, details, store_id, venue_id').eq('campus_id', st.campusId).eq('active', true).order('name');
    st.pickups = data || [];
    App.render();
  }

  function render() {
    if (!App.Discovery.campuses().length) { App.Discovery.loadUniversities().then(() => App.render()); return '<div class="page-wrap"><div class="text-muted text-sm">Loading…</div></div>'; }
    if (!st.campusId) { const d = defaultCampus(); st.campusId = d && d.id; }
    if (st.campusId && st.rows === null && !st.loading && !st.error) load(false);
    const list = campuses();
    const campus = App.Discovery.campus(st.campusId);
    const venue = (v) => `
      <div class="card card-pad mb-2 dir-venue">
        <div class="flex gap-2" style="align-items:flex-start;">
          <span class="dir-icon"><i data-lucide="${ICON[v.category] || 'map-pin'}"></i></span>
          <div style="min-width:0;">
            <div class="font-bold">${esc(v.name)}</div>
            <div class="text-xs text-muted">${esc(CAT_LABEL[v.category] || 'Place')}${v.building_number ? ' · Building ' + esc(v.building_number) : ''}${v.rooms ? ' · Room ' + esc(v.rooms) : ''}</div>
            ${v.description ? `<div class="text-sm mt-1">${esc(v.description)}</div>` : ''}
            ${v.address ? `<div class="text-xs text-muted mt-1"><i data-lucide="map-pin" style="width:11px;height:11px;"></i> ${esc(v.address)}</div>` : ''}
            <div class="text-xs mt-1"><span class="badge badge-success">Verified</span> <span class="text-muted">${v.last_verified ? 'checked ' + esc(U.formatDate ? U.formatDate(v.last_verified) : v.last_verified) : ''}${v.source_url ? ` · <a href="${esc(v.source_url)}" target="_blank" rel="noopener">source</a>` : ''}</span></div>
          </div>
        </div>
      </div>`;
    return `
    <div class="page-wrap" style="max-width:720px;">
      ${App.Nav.backButton('home', 'solo')}
      <h1 class="page-title mb-1">Campus directory</h1>
      ${campus ? `<div class="text-sm text-muted mb-3">${esc(campus.full_name)}${campus.address ? ' · ' + esc(campus.address) : ''}</div>` : ''}
      ${!list.length ? '<div class="empty-state"><div class="icon-wrap"><i data-lucide="map"></i></div><h3>No campus directory for your university yet</h3></div>' : `
      <div class="grid mb-3" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;">
        <select class="select" data-action-change="dir-campus" aria-label="Campus">${list.map(c => `<option value="${esc(c.id)}" ${c.id === st.campusId ? 'selected' : ''}>${esc(c.full_name)}</option>`).join('')}</select>
        <select class="select" data-action-change="dir-cat" aria-label="Type of place">${CATS.map(([k, l]) => `<option value="${k}" ${st.cat === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <div class="search-bar mb-3"><i data-lucide="search"></i><input type="text" placeholder="Building name or number" value="${esc(st.q)}" data-action-input="dir-search" aria-label="Search buildings" /></div>
      ${st.pickups && st.pickups.length ? `
      <div class="section-title mb-2" style="font-size:15px;">Pickup points</div>
      ${st.pickups.map(p => `<div class="card card-pad mb-2"><div class="font-bold"><i data-lucide="package" style="width:14px;height:14px;color:var(--color-primary);"></i> ${esc(p.name)}</div><div class="text-xs text-muted">${esc((App.Stores.getById(p.store_id) || {}).name || '')}${p.details ? ' · ' + esc(p.details) : ''}</div></div>`).join('')}
      <div class="section-title mb-2 mt-3" style="font-size:15px;">Buildings and places</div>` : ''}
      ${st.error ? `<div class="card card-pad mb-2" style="color:var(--color-error);">${esc(st.error)} <button type="button" class="link-btn" data-action="dir-retry">Retry</button></div>` : ''}
      ${st.rows === null ? Array(3).fill('<div class="skeleton mb-2" style="height:74px;border-radius:14px;"></div>').join('')
        : st.rows.length ? st.rows.map(venue).join('') : '<div class="empty-state"><div class="icon-wrap"><i data-lucide="search-x"></i></div><h3>No places found</h3></div>'}
      ${st.more ? `<button type="button" class="btn btn-secondary btn-block mt-2 ${st.loading ? 'btn-loading' : ''}" data-action="dir-more">Show more</button>` : ''}`}
    </div>`;
  }

  function open(campusId) { if (campusId) { st.campusId = campusId; st.rows = null; } S.setRoute({ view: 'campus-directory', params: {} }); }
  function handleAction(action, ds) {
    if (action === 'dir-open') return open(ds.campus);
    if (action === 'dir-more') return load(true);
    if (action === 'dir-retry') { st.error = null; return load(false); }
  }
  function handleInput(kind, value) {
    if (kind === 'dir-search') { st.q = value; clearTimeout(timer); timer = setTimeout(() => load(false), 300); }
  }
  function handleChange(kind, ds, value) {
    if (kind === 'dir-campus') { st.campusId = value; st.pickups = null; return load(false); }
    if (kind === 'dir-cat') { st.cat = value; return load(false); }
  }
  return { render, open, handleAction, handleInput, handleChange };
})();
