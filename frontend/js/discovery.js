/* ============================================================
   CLICKFOOD, university-aware shop discovery + distance

   Sections come from ONE database function, discover_shops()
   (supabase/multi_university.sql): shops at the student's home university,
   then shops available to everyone, then other universities. Only approved,
   published shops are listed; stores RLS still applies.
   The home university is a browsing preference (Profile); the student email
   decides the institution and never changes here. A temporary "explore"
   filter lives only in the page, never in the profile.

   Distance: the phone's current position when the student allows it (kept
   in memory only, never saved or sent anywhere), otherwise the home pin
   they set, otherwise no distance. Straight-line, never road distance.
   ============================================================ */
window.App = window.App || {};

App.Discovery = (function () {
  const S = App.Store;
  let unis = null;            // [{id, name, short_code, ...}], active only
  let allUnis = null;         // every institution, incl. disabled ones (names for old profiles)
  let camps = null;           // [{id, university_id, code, name, full_name, address}], active only
  let sections = null;        // Map storeId -> { section, university_ids, universities }
  let sectionsFor = undefined; // which home university the sections belong to
  let loading = null;
  let gps = null;             // { lat, lng } in memory only
  let gpsState = 'unknown';   // unknown | asking | on | denied | unavailable

  async function loadUniversities() {
    let [u, c] = await Promise.all([
      App.sb.from('universities').select('id, name, short_code, active, registration_open, features').order('name'),
      App.sb.from('campuses').select('id, university_id, code, name, full_name, address, latitude, longitude').eq('active', true).order('sort').order('name'),
    ]);
    // a database without the newer columns (before institutions_v2.sql / order_distance.sql): basic lists
    if (u.error && u.error.code === '42703') u = await App.sb.from('universities').select('id, name, short_code').eq('active', true).order('name');
    if (c.error && c.error.code === '42703') c = await App.sb.from('campuses').select('id, university_id, code, name, full_name, address').eq('active', true).order('sort').order('name');
    if (!u.error && u.data) { allUnis = u.data; unis = u.data.filter(x => x.active !== false); }
    if (!c.error && c.data) {
      camps = c.data;
      // the campus lists sign-up and Profile use now come from the database
      for (const uni of unis || []) {
        const names = camps.filter(x => x.university_id === uni.id).map(x => x.name);
        if (names.length) App.CONST.UNIVERSITY_CAMPUSES[uni.name] = names;
      }
    }
    return unis || [];
  }
  function campuses() { return camps || []; }
  function campus(id) { return (camps || []).find(c => c.id === id) || null; }
  // "Soshanguve North" -> "Soshanguve North Campus" for a university's list
  function campusLabel(universityName, name) {
    const u = (unis || []).find(x => x.name === universityName);
    const c = u && (camps || []).find(x => x.university_id === u.id && x.name === name);
    return c ? c.full_name : name;
  }
  // the student's own campus (the one they picked at their email university)
  function myCampus() {
    const p = S.state.profile;
    if (!p || p.role !== 'customer') return null;
    if (p.campus_id) return campus(p.campus_id);
    const u = (unis || []).find(x => x.name === p.university);
    return u ? (camps || []).find(x => x.university_id === u.id && x.name === p.campus_location) || null : null;
  }
  function campusIdsOf(store) {
    const r = sections && sections.get(store.id);
    if (r && r.campus_ids && r.campus_ids.length) return r.campus_ids;
    const u = (unis || []).find(x => x.name === store.university);
    const c = u && (camps || []).find(x => x.university_id === u.id && x.name === store.campus_location);
    return c ? [c.id] : [];
  }
  // active pickup points for some shops (checkout); cached per shop
  const pickupCache = new Map();
  async function pickupPointsFor(storeIds) {
    const need = storeIds.filter(id => !pickupCache.has(id));
    if (need.length) {
      const { data, error } = await App.sb.from('pickup_points').select('id, name, details, store_id, campus_id, venue_id').in('store_id', need).eq('active', true).order('name');
      if (!error) for (const id of need) pickupCache.set(id, (data || []).filter(p => p.store_id === id));
    }
    return Object.fromEntries(storeIds.map(id => [id, pickupCache.get(id) || []]));
  }
  function pickupPointsCached(storeId) { return pickupCache.get(storeId) || null; }
  function universities() { return unis || []; }
  function university(id) { return (allUnis || unis || []).find(u => u.id === id) || null; }
  // institutions a student can choose now (plus the one already on the profile)
  function selectableUniversities() {
    const mine = S.state.profile && S.state.profile.home_university_id;
    return (unis || []).filter(u => u.registration_open !== false || u.id === mine);
  }

  function homeUniversityId() {
    const p = S.state.profile;
    return p && p.role === 'customer' ? (p.home_university_id || null) : null;
  }
  function homeUniversity() { return university(homeUniversityId()); }

  // Loads (or reloads) the sections. Called after the shops load and after
  // the home university changes; one request, never per shop.
  async function load(force) {
    const key = homeUniversityId();
    if (!force && sections && sectionsFor === key) return sections;
    if (loading) return loading;
    loading = (async () => {
      try {
        const [{ data, error }] = await Promise.all([App.sb.rpc('discover_shops', { p_university: null }), unis ? null : loadUniversities()]);
        if (error) throw error;
        const m = new Map();
        for (const r of data || []) m.set(r.store_id, { section: r.section, rank: r.rank, university_ids: r.university_ids || [], universities: r.universities || [], campus_ids: r.campus_ids || [] });
        sections = m; sectionsFor = key;
      } catch (e) {
        sections = null;   // the page falls back to the shops' own university below
      }
      loading = null;
      return sections;
    })();
    return loading;
  }
  function invalidate() { sections = null; sectionsFor = undefined; }

  // 'mine' | 'everyone' | 'other'. Falls back to the shop's own fields when
  // the sections couldn't load (offline), so the page never breaks.
  function sectionOf(store) {
    if (!store) return 'other';
    const r = sections && sections.get(store.id);
    if (r) return r.section;
    const home = homeUniversity();
    if (home && store.university === home.name) return 'mine';
    if (store.availability === 'everyone' || store.location_type === 'off_campus' || store.seller_kind === 'student') return 'everyone';   // student shops: everyone (student_shops_open.sql)
    return 'other';
  }
  function sectionRank(store) { return { mine: 0, everyone: 1, other: 2 }[sectionOf(store)]; }
  function universitiesOf(store) {
    const r = sections && sections.get(store.id);
    if (r && r.universities.length) return r.universities;
    return store && store.university ? [store.university] : [];
  }
  function universityIdsOf(store) {
    const r = sections && sections.get(store.id);
    return r ? r.university_ids : [];
  }
  function shortName(name) { const u = (unis || []).find(x => x.name === name); return u ? u.short_code : name; }

  // "University of Pretoria · Hatfield Campus" / "UP & TUT · Hatfield Campus" / "For all students"
  function locationLine(store) {
    if (store.location_type === 'off_campus') return ['Off campus', store.address].filter(Boolean).join(' · ');
    const list = universitiesOf(store);
    const uniText = store.availability === 'everyone' && !list.length ? 'For all students'
      : list.length > 1 ? list.map(shortName).join(' & ') : (list[0] || '');
    const c = campusIdsOf(store).map(campus).filter(Boolean)[0];
    const place = c ? c.full_name : (store.campus_location ? `${store.campus_location} Campus` : '');
    return [uniText, place].filter(Boolean).join(' · ');
  }

  // ---------------- ordering location (2026-10-17) ----------------
  // "saved": the profile's saved location (home pin; for students their
  // university-area location). "current": the phone's position right now
  // (memory only). The ordering rule and the distances use the ACTIVE one;
  // the choice is kept on this device per account.
  const MODE_KEY = 'clickfood_order_mode_';
  function modeKey() { const p = S.state.profile; return MODE_KEY + (p ? p.id : 'guest'); }
  function orderMode() {
    let m = null; try { m = localStorage.getItem(modeKey()); } catch (e) { /* storage blocked */ }
    return m === 'current' ? 'current' : 'saved';
  }
  function setOrderMode(m) {
    try { localStorage.setItem(modeKey(), m === 'current' ? 'current' : 'saved'); } catch (e) { /* storage blocked */ }
    if (m === 'current' && !gps) readPosition(false);
    App.render();
  }
  function savedPin() {
    const p = S.state.profile;
    return p && p.home_lat != null && p.home_lng != null ? { lat: Number(p.home_lat), lng: Number(p.home_lng) } : null;
  }
  function activePin() { return orderMode() === 'current' ? gps : savedPin(); }
  // what an order sends (the server reads the saved location itself)
  function orderLocationPayload() {
    return orderMode() === 'current' && gps ? { mode: 'current', lat: gps.lat, lng: gps.lng } : { mode: 'saved' };
  }
  // can this customer order from this shop from the active location? (the server checks again)
  function eligibility(store) {
    if (!App.Stores.distanceRuleOn()) return { ok: true };
    const pin = App.MapPicker.shopPin(store);
    if (!pin) return { ok: false, reason: 'no_pin', label: 'Location not set' };
    const me = activePin();
    if (!me) return { ok: false, reason: 'no_location', label: orderMode() === 'current' ? 'Turn on location' : 'Set your location' };
    const km = Math.round(App.MapPicker.distanceKm(me, pin) * 1000) / 1000;   // to the metre, like the server
    const max = App.Stores.maxOrderKm();
    return km <= max ? { ok: true, km } : { ok: false, reason: 'too_far', km, label: `Too far to order (${km.toFixed(1)} km)` };
  }
  // a likely campus from the phone's position (only campuses with a pin, only when clearly close)
  function suggestCampus(universityId, pos, withinKm) {
    let best = null;
    for (const c of campuses().filter(x => x.university_id === universityId && x.latitude != null && x.longitude != null)) {
      const km = App.MapPicker.distanceKm(pos, { lat: Number(c.latitude), lng: Number(c.longitude) });
      if (km <= (withinKm || 5) && (!best || km < best.km)) best = { campus: c, km };
    }
    return best;
  }
  function campusPin(c) { return c && c.latitude != null && c.longitude != null ? { lat: Number(c.latitude), lng: Number(c.longitude) } : null; }
  // one reading for "suggest my campus" (never kept)
  function locateOnce() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({ error: 'unavailable' });
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        (err) => resolve({ error: err && err.code === 1 ? 'denied' : err && err.code === 3 ? 'timeout' : 'unavailable' }),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    });
  }

  // ---------------- location ----------------
  function gpsPin() { return gps; }
  function locationState() { return gpsState; }
  function canAskLocation() { return !!navigator.geolocation && (gpsState === 'unknown'); }
  function readPosition(quiet) {
    if (!navigator.geolocation) { gpsState = 'unavailable'; return; }
    gpsState = 'asking';
    navigator.geolocation.getCurrentPosition((pos) => {
      gps = { lat: Math.round(pos.coords.latitude * 1e5) / 1e5, lng: Math.round(pos.coords.longitude * 1e5) / 1e5 };
      gpsState = 'on';
      App.render();
    }, (err) => {
      gpsState = err && err.code === 1 ? 'denied' : 'unavailable';
      // no position: back to the saved location (said out loud, never during checkout)
      const wasCurrent = orderMode() === 'current' && S.state.route.view !== 'checkout';
      if (wasCurrent) { try { localStorage.setItem(modeKey(), 'saved'); } catch (e) { /* storage blocked */ } }
      if (!quiet || wasCurrent) App.Toast.info(gpsState === 'denied' ? 'Location is off. Using your saved location.' : 'Couldn\'t get your location right now. Using your saved location.');
      App.render();
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 });
  }
  // Only when the student taps "Use my location"; never on its own.
  function askLocation() { readPosition(false); }
  // If the student already allowed location before, use it quietly (no pop-up).
  async function resumeLocation() {
    try {
      if (!navigator.permissions || !navigator.geolocation) return;
      const st = await navigator.permissions.query({ name: 'geolocation' });
      if (st.state === 'granted') readPosition(true);
      else {
        if (st.state === 'denied') gpsState = 'denied';
        // "current" was chosen before but there is no permission now: use the saved location
        if (orderMode() === 'current') { try { localStorage.setItem(modeKey(), 'saved'); } catch (e) { /* storage blocked */ } }
      }
    } catch (e) { /* not supported: wait for the button */ }
  }

  return {
    loadUniversities, universities, university, selectableUniversities, homeUniversityId, homeUniversity, load, invalidate,
    sectionOf, sectionRank, universitiesOf, universityIdsOf, shortName, locationLine,
    campuses, campus, campusLabel, myCampus, campusIdsOf, pickupPointsFor, pickupPointsCached,
    gpsPin, locationState, canAskLocation, askLocation, resumeLocation,
    orderMode, setOrderMode, savedPin, activePin, orderLocationPayload, eligibility, suggestCampus, campusPin, locateOnce,
  };
})();
