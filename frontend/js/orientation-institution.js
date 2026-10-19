/* ============================================================
   CLICKFOOD, My Orientation: the student's own institution (2026-10-17)

   One layer for every institution, no per-institution copies:
   - campuses: the database list (public.campuses) for the institution on
     the student's profile (profiles.home_university_id), never a fixed
     UP list;
   - destinations: the database buildings for that campus
     (public.campus_venues, readable only by that institution's students)
     plus, for UP campuses, the existing UP building index
     (js/orientation-providers.js, keyed by the old campus ids);
   - a campus with no building list says so, and "Find Directions" still
     hands the typed place to Google Maps together with the campus name.
   Coordinates are only used when they exist (a developer-pinned campus or
   the old approximate UP centres for "closest campus"); none are invented.
   ============================================================ */
window.App = window.App || {};
App.Orientation = App.Orientation || {};

App.Orientation.Institution = (function () {
  const S = App.Store;
  // database campus code -> the old UP campus id used by the UP building index
  const UP_LEGACY = { 'up-hatfield': 'hatfield', 'up-hillcrest': 'hillcrest', 'up-groenkloof': 'groenkloof', 'up-prinshof': 'prinshof',
                      'up-onderstepoort': 'onderstepoort', 'up-mamelodi': 'mamelodi', 'up-gibs': 'gibs' };
  const venueCache = {};   // campusId -> rows | 'loading' | 'error'

  function university() {
    const p = S.state.profile;
    return p && p.home_university_id ? App.Discovery.university(p.home_university_id) : null;
  }
  function isStudent() { const p = S.state.profile; return !!(p && p.role === 'customer' && p.is_student); }
  // My Orientation is for student accounts of an institution that has it switched on
  function access() {
    if (!S.state.profile) return { ok: false, reason: 'signed_out' };
    if (!isStudent()) return { ok: false, reason: 'not_student' };
    const u = university();
    if (!u) return { ok: false, reason: 'no_institution' };
    if (u.features && u.features.orientation === false) return { ok: false, reason: 'off', university: u };
    return { ok: true, university: u };
  }
  function available() { return access().ok; }

  function toCampus(c, u) {
    const legacy = UP_LEGACY[c.code] ? App.Orientation.getCampusById(UP_LEGACY[c.code]) : null;
    const pin = App.Discovery.campusPin(c);
    return {
      id: c.id, code: c.code, name: c.name, legacy,
      fullName: legacy ? legacy.fullName : `${c.full_name}, ${u.name}`,
      searchContext: legacy ? legacy.searchContext : [c.full_name, u.name, c.address, 'South Africa'].filter(Boolean).join(', '),
      address: c.address || null,
      center: pin || (legacy ? legacy.center : null),
    };
  }
  function campuses() {
    const u = university();
    if (!u) return [];
    return App.Discovery.campuses().filter(c => c.university_id === u.id).map(c => toCampus(c, u));
  }
  function campusById(id) { return campuses().find(c => c.id === id) || null; }
  function profileCampus() { const p = S.state.profile; return p && p.campus_id ? campusById(p.campus_id) : null; }
  function closest(coords) {
    let best = null;
    for (const c of campuses()) {
      if (!c.center) continue;
      const d = App.Orientation.distanceMeters(coords, c.center);
      if (d != null && (!best || d < best.distanceMeters)) best = { campus: c, distanceMeters: d };
    }
    return best;
  }

  // ---------------- buildings ----------------
  function loadVenues(campus) {
    if (!campus || venueCache[campus.id]) return;
    venueCache[campus.id] = 'loading';
    App.sb.from('campus_venues').select('id, name, category, building_number, rooms, address, description').eq('campus_id', campus.id).order('name').limit(500)
      .then(({ data, error }) => { venueCache[campus.id] = error ? 'error' : (data || []); App.render(); });
  }
  function venues(campus) { const v = campus && venueCache[campus.id]; return Array.isArray(v) ? v : []; }
  function venuesLoading(campus) { return !!campus && venueCache[campus.id] === 'loading'; }
  const LABEL = { academic_building: 'Academic building', lecture_hall: 'Lecture hall', library: 'Library', computer_centre: 'Computer centre', student_centre: 'Student centre',
                  cafeteria: 'Cafeteria', food_court: 'Food court', restaurant: 'Restaurant', administrative: 'Administration', residence: 'Residence', pickup_point: 'Pickup point', other: 'Place' };
  function venueRecord(campus, v) {
    return { id: 'v-' + v.id, name: v.name, campus: campus.name, category: LABEL[v.category] || 'Place',
             address: [v.building_number ? 'Building ' + v.building_number : '', v.address || '', campus.fullName].filter(Boolean).join(', ') };
  }
  function matches(v, tokens) {
    const hay = [v.name, LABEL[v.category] || '', v.building_number || '', v.description || ''].join(' ').toLowerCase();
    return tokens.every(t => hay.includes(t));
  }

  // how much this campus knows: legacy UP index entries + database buildings
  function coverage(campus) {
    if (!campus) return 0;
    const legacyCount = campus.legacy ? (App.Orientation.Providers.Places.allVenueNames(campus.legacy) || []).length : 0;
    return legacyCount + venues(campus).length;
  }
  async function search(query, campus) {
    const q = String(query || '').trim().toLowerCase();
    if (!q || !campus) return { results: [] };
    const out = [];
    if (campus.legacy) {
      const res = await App.Orientation.Providers.Places.searchPlaces({ query, campus: campus.legacy });
      if (res && res.results) out.push(...res.results.map(r => ({ ...r, campus: campus.name })));
    }
    const tokens = q.split(/\s+/).filter(Boolean);
    for (const v of venues(campus)) if (matches(v, tokens)) out.push(venueRecord(campus, v));
    const seen = new Set();
    return { results: out.filter(r => { const k = r.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 25) };
  }
  function suggested(campus) {
    if (!campus) return [];
    if (campus.legacy) return App.Orientation.Providers.Places.suggestedSearches(campus.legacy) || [];
    const seen = new Set(); const out = [];
    for (const v of venues(campus)) { if (seen.has(v.category)) continue; seen.add(v.category); out.push(v.name); if (out.length >= 5) break; }
    return out;
  }

  return { university, access, available, campuses, campusById, profileCampus, closest, loadVenues, venues, venuesLoading, coverage, search, suggested };
})();
