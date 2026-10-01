/* ============================================================
   CLICKFUD — My Orientation: campus navigation layer

   A student-friendly UP destination finder — this module owns campus
   selection, destination search and the destination card. It performs
   NO mapping, routing or turn-by-turn navigation itself: once a
   destination is chosen, pressing Navigate hands it straight to the
   real Google Maps app/website via App.Orientation.MapsLauncher (a
   plain Google Maps URL — no API key, no in-app map, no mock route).

   Delegated into from App.Pages.Customer exactly like Home's storefront
   markup is (see js/pages/customer.js's STOREFRONT_ACTIONS) — this is
   still a customer-only feature, not a new top-level role/app.
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Orientation = (function () {
  const S = App.Store;
  const U = App.Utils;
  const O = App.Orientation;

  const local = {
    step: 'start', // 'start' | 'destination' | 'card'
    campus: null,
    userCoords: null,
    locationStatus: 'idle', // 'idle' | 'loading' | 'granted' | 'denied' | 'error'
    locationMessage: null,
    query: '',
    searchResults: null, // null = not searched yet, [] = searched, no results
    searchError: null,
    destination: null,
    launching: false, // true for the brief moment between pressing Navigate and the browser handing off to Google Maps — guards against a duplicate/double-tap re-triggering the hand-off
    findDirectionsLaunching: false, // duplicate-tap guard for the "Find Directions" button
    appliedProfileDefault: false, // has the student's own signup campus already been applied as the default, this session?
  };

  function reset() {
    local.step = 'start'; local.campus = null; local.userCoords = null;
    local.locationStatus = 'idle'; local.locationMessage = null;
    local.query = ''; local.searchResults = null; local.searchError = null;
    local.destination = null; local.launching = false; local.findDirectionsLaunching = false;
  }

  // The campus a student picked at signup (profiles.campus_location —
  // the same field/values used for a shop's own campus_location, and the
  // same names as App.Orientation.CAMPUSES) is treated as already
  // selected the first time My Orientation opens this session — exactly
  // as if they'd tapped it themselves. They can still change it via the
  // existing "Change Campus" button; this only ever runs once and only
  // when nothing has been picked yet, so it never overrides a deliberate
  // in-session choice.
  function applyProfileDefaultCampus() {
    if (local.appliedProfileDefault) return;
    local.appliedProfileDefault = true;
    if (local.campus || local.step !== 'start') return;
    const campusLocation = S.state.profile && S.state.profile.campus_location;
    if (!campusLocation) return;
    const matched = O.getCampusByName(campusLocation);
    if (matched) { local.campus = matched; local.step = 'destination'; }
  }

  // Real, campus-specific quick-search chips — never a fixed list. Pulled
  // fresh (per render, so a "Change Campus" tap updates them immediately)
  // from the exact same LOCATIONS dataset the search box itself queries,
  // via App.Orientation.Providers.Places.suggestedSearches() — see that
  // function for how a representative destination is picked per useful
  // category, and why a smaller campus naturally shows fewer chips
  // instead of padded-out placeholders.
  function exampleSearchesForCampus(campus) {
    return O.Providers.Places.suggestedSearches(campus);
  }

  // ---------------- Location ----------------
  async function useCurrentLocation() {
    local.locationStatus = 'loading'; local.locationMessage = null;
    App.render();
    const res = await O.LocationService.getCurrentPosition();
    if (res.error) {
      local.locationStatus = res.error === 'denied' ? 'denied' : 'error';
      local.locationMessage = res.message;
      App.render();
      return;
    }
    local.userCoords = res.coords;
    local.locationStatus = 'granted';
    const closest = O.closestCampus(res.coords);
    if (closest) {
      local.campus = closest.campus;
      App.Toast.success(`You're closest to ${closest.campus.name} campus.`);
      local.step = 'destination';
    }
    App.render();
  }

  // Re-checks GPS only — there's no in-app route to recalculate any
  // more (Google Maps owns that entirely once Navigate is pressed).
  // This just refreshes the "how far are you from your destination"
  // context shown on the destination card.
  async function recheckLocation() {
    const res = await O.LocationService.getCurrentPosition();
    if (res.error) {
      local.locationMessage = res.message;
      App.render();
      return;
    }
    local.userCoords = res.coords;
    App.render();
  }

  // ---------------- Campus selection ----------------
  function selectCampus(id) {
    const campus = O.getCampusById(id);
    if (!campus) return;
    local.campus = campus;
    local.step = 'destination';
    local.query = ''; local.searchResults = null; local.searchError = null;
    App.render();
  }

  function changeCampus() {
    local.step = 'start';
    local.query = ''; local.searchResults = null; local.searchError = null; local.destination = null;
    App.render();
  }

  // ---------------- Search ----------------
  const debouncedSearch = U.debounce(() => runSearch(), 350);

  // NOTE ON FOCUS: js/app.js's own App.render() already captures
  // document.activeElement by id and restores focus + cursor position
  // after every re-render, generically, for any input/textarea anywhere
  // in the app (search box included, since it has a real id). An earlier
  // version of this file duplicated that same logic locally and called
  // it AFTER App.render() already did it — meaning every render was
  // calling .focus()/.setSelectionRange() on the same element TWICE in a
  // row, which is what was actually causing the reported jitter/vibrate
  // (a redundant double focus-restore, not a keyboard/viewport issue).
  // Fixed by removing the duplicate and just calling App.render()
  // directly everywhere below — the app's existing, already-correct
  // mechanism handles it once, cleanly.

  function handleSearchInput(value) {
    local.query = value;
    local.searchError = null;
    if (!value.trim()) { local.searchResults = null; App.render(); return; }
    debouncedSearch();
  }

  // Strictly scoped to the student's own selected campus — searchPlaces
  // only ever looks inside LOCATIONS[campus.id] (js/orientation-
  // providers.js), never any other campus's data, so a search never
  // surfaces (and Find Directions/Navigate never sends someone toward) a
  // location outside the campus they actually chose. An earlier version
  // of this screen also ran a secondary "other UP campuses" search as a
  // fallback when the current campus came up thin — removed: a student
  // who has already told the app which campus they're on should only
  // ever see results from that one campus, never a building somewhere
  // else across Pretoria.
  //
  // One render at the end, not one before the lookup and another after —
  // App.Orientation.Providers.Places' searchPlaces() searches a small
  // in-memory list of this app's own UP locations, not a real remote
  // database call, so there's nothing genuinely asynchronous to show a
  // loading state for; rendering a "Searching…" card and then replacing
  // it a moment later was the actual cause of the reported vibration —
  // two full re-renders in quick succession, each changing the height of
  // the area right under the input the student was still typing into.
  // query/campus are captured up front and re-checked once the lookup
  // resolves so a slower, earlier search (e.g. "Law") can never clobber
  // a newer one the student has already moved on to (e.g. "Library").
  async function runSearch() {
    const query = local.query;
    const campus = local.campus;
    if (!query.trim() || !campus) return;
    try {
      const res = await O.Providers.Places.searchPlaces({ query, campus });
      if (local.query !== query || local.campus !== campus) return; // stale — the student moved on
      if (res.error) {
        local.searchResults = null;
        local.searchError = res.message || "Search isn't available right now. Please try again.";
      } else {
        local.searchResults = (res.results || []).map((r) => ({ ...r, campus: r.campus || campus.name }));
        local.searchError = null;
      }
    } catch (e) {
      if (local.query !== query || local.campus !== campus) return;
      local.searchResults = null;
      local.searchError = "Search isn't available right now. Please try again.";
    }
    App.render();
  }

  function runExampleSearch(q) {
    local.query = q;
    runSearch();
  }

  function selectResult(id) {
    // Always a result from local.campus itself — searchPlaces above never
    // looks anywhere else — so there's no other campus to switch context to.
    const result = (local.searchResults || []).find((r) => r.id === id);
    if (!result) return;
    local.destination = result;
    local.step = 'card';
    App.render();
  }

  // Directions should always start from where the student actually IS,
  // not a fixed campus point — reuses local.userCoords if it's already
  // known (e.g. "Use My Location" was tapped earlier this session),
  // otherwise makes one best-effort, silent attempt to get it right now
  // (prompting for permission if needed). Never blocks or fails the
  // actual directions hand-off: if location is denied/unavailable/slow,
  // this just resolves null and the launcher below falls back to its
  // existing behaviour (Google Maps' own device-location default for a
  // resolved destination, or the campus name for free text).
  async function ensureUserCoords() {
    if (local.userCoords) return local.userCoords;
    const res = await O.LocationService.getCurrentPosition({ timeout: 4000 });
    if (res.error) return null;
    local.userCoords = res.coords;
    return local.userCoords;
  }

  // ---------------- Navigate (hand off to Google Maps) ----------------
  async function navigate() {
    if (local.launching || !local.destination) return; // guards a double-tap from firing two hand-offs
    local.launching = true;
    App.render();
    const coords = await ensureUserCoords();
    const res = O.MapsLauncher.launch(local.destination, local.campus, coords);
    if (res.error) {
      // Flagged plainly rather than silently opening an inaccurate/empty
      // Google Maps URL — matches this feature's accuracy requirement.
      local.launching = false;
      App.Toast.error(res.message || "This destination can't be sent to Google Maps right now.");
      App.render();
      return;
    }
    // window.location.href = ... (inside MapsLauncher.launch) is already
    // navigating the page away at this point on most mobile browsers; on
    // desktop it stays on this tab, so the lock is released shortly
    // after so a genuine retry isn't permanently stuck if nothing
    // actually happened (e.g. a popup/navigation blocker).
    setTimeout(() => { local.launching = false; App.render(); }, 1500);
  }

  // "Find Directions" — always available once there's typed text,
  // completely independent of whether the local database found any
  // matches. Never fires on its own while typing (only ever called from
  // an explicit button tap). Origin prefers the student's real current
  // location (see ensureUserCoords) and only falls back to the selected
  // campus's name when location isn't available — destination is
  // exactly what the student typed either way, so a place that isn't in
  // this app's own database (e.g. "Menlyn Maine") still works perfectly.
  async function findDirections() {
    const q = local.query.trim();
    if (local.findDirectionsLaunching || !q || !local.campus) return;
    local.findDirectionsLaunching = true;
    App.render();
    const coords = await ensureUserCoords();
    const res = O.MapsLauncher.launchFreeTextDirections(local.campus, q, coords);
    if (res.error) {
      local.findDirectionsLaunching = false;
      App.Toast.error(res.message || "Couldn't open Google Maps right now.");
      App.render();
      return;
    }
    setTimeout(() => { local.findDirectionsLaunching = false; App.render(); }, 1500);
  }

  // ---------------- Rendering ----------------
  function formatDistance(m) {
    if (m == null) return '—';
    return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
  }

  function header(title, onBack) {
    return `<div class="flex items-center gap-2 mb-3">
      ${onBack ? `<button type="button" class="btn-icon" data-action="${onBack}" aria-label="Back"><i data-lucide="arrow-left"></i></button>` : ''}
      <h1 class="page-title" style="margin:0;">${U.escapeHtml(title)}</h1>
    </div>`;
  }

  function renderStart() {
    const locBtnLabel = local.locationStatus === 'loading' ? 'Getting your location…' : 'Use my current location';
    return `
    <div class="page-wrap" style="max-width:640px;">
      ${header('My Orientation')}
      <button type="button" class="card card-pad mb-3" style="text-align:left;width:100%;cursor:pointer;display:flex;align-items:center;gap:12px;" data-action="navigate" data-view="timetable">
        <div style="width:40px;height:40px;flex-shrink:0;border-radius:50%;background:var(--color-primary);display:flex;align-items:center;justify-content:center;color:#fff;"><i data-lucide="calendar" style="width:20px;height:20px;"></i></div>
        <div style="flex:1;">
          <div class="font-bold" style="font-size:14px;">My Timetable</div>
          <div class="text-xs text-muted">See your next class and get directions</div>
        </div>
        <i data-lucide="chevron-right" style="color:var(--text-muted);"></i>
      </button>
      <div class="card card-pad mb-3">
        <h3 class="font-bold mb-1">Where are you?</h3>
        <p class="text-sm text-muted mb-3">Find any building, venue or facility around your UP campus, then get directions in Google Maps.</p>
        <button type="button" class="btn btn-primary btn-block mb-3 ${local.locationStatus === 'loading' ? 'btn-loading' : ''}" data-action="orientation-use-location" ${local.locationStatus === 'loading' ? 'disabled' : ''}>
          <i data-lucide="map-pin"></i> ${U.escapeHtml(locBtnLabel)}
        </button>
        ${local.locationStatus === 'denied' || local.locationStatus === 'error' ? `<div class="text-sm mb-3" style="color:var(--color-error);"><i data-lucide="alert-circle" style="width:14px;height:14px;"></i> ${U.escapeHtml(local.locationMessage)}</div>` : ''}
        <div class="divider" style="margin:14px 0;"></div>
        <label class="text-sm font-semibold" style="display:block;margin-bottom:10px;">Or select your campus</label>
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;">
          ${O.CAMPUSES.map((c) => `
            <button type="button" class="payment-option" style="flex-direction:column;align-items:flex-start;gap:4px;text-align:left;margin-bottom:0;" data-action="orientation-select-campus" data-id="${c.id}">
              <i data-lucide="building-2"></i>
              <strong style="font-size:13px;">${U.escapeHtml(c.name)}</strong>
            </button>`).join('')}
        </div>
      </div>
    </div>`;
  }

  function renderDestinationSearch() {
    const c = local.campus;
    const hasQuery = !!local.query.trim();
    return `
    <div class="page-wrap" style="max-width:640px;">
      ${header('My Orientation', 'orientation-back-to-start')}
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2 text-sm"><i data-lucide="map-pin" style="width:15px;height:15px;color:var(--color-primary);"></i> <strong>${U.escapeHtml(c.name)}</strong> campus</div>
        <button type="button" class="btn btn-secondary btn-sm" data-action="orientation-change-campus">Change Campus</button>
      </div>
      <div class="card card-pad mb-3">
        <h3 class="font-bold mb-2">Where are you going?</h3>
        <div class="field" style="margin-bottom:8px;">
          <input id="orientation-search-input" class="input" style="font-size:16px;padding:14px;" placeholder="e.g. Engineering 1, Library, Student Centre…" value="${U.escapeHtml(local.query)}" data-action-input="orientation-search" autocomplete="off" />
        </div>
        <div class="flex gap-2" style="flex-wrap:wrap;">
          ${exampleSearchesForCampus(c).map((q) => `<button type="button" class="chip" data-action="orientation-example-search" data-q="${U.escapeHtml(q)}">${U.escapeHtml(q)}</button>`).join('')}
        </div>
        ${hasQuery ? `
        <div class="divider" style="margin:14px 0;"></div>
        <button type="button" class="btn btn-primary btn-block ${local.findDirectionsLaunching ? 'btn-loading' : ''}" data-action="orientation-find-directions" ${local.findDirectionsLaunching ? 'disabled' : ''}>
          <i data-lucide="navigation"></i> Find Directions
        </button>
        ` : ''}
      </div>
      ${renderSearchResults()}
    </div>`;
  }

  function formatKm(m) {
    if (m == null) return '';
    return m >= 1000 ? `${(m / 1000).toFixed(1)} km away` : `${Math.round(m)} m away`;
  }

  function resultCard(r) {
    const distance = r.distanceFromCurrentMeters != null ? formatKm(r.distanceFromCurrentMeters) : '';
    return `
      <button type="button" class="card card-pad" style="text-align:left;cursor:pointer;" data-action="orientation-select-result" data-id="${U.escapeHtml(r.id)}">
        <div class="flex justify-between items-start gap-2">
          <div>
            <div class="font-bold">${U.escapeHtml(r.name)}</div>
            <div class="text-sm text-muted">${U.escapeHtml(r.campus)} Campus${r.category ? ' · ' + U.escapeHtml(r.category) : ''}${distance ? ' · ' + distance : ''}</div>
            ${r.address ? `<div class="text-xs text-muted mt-1">${U.escapeHtml(r.address)}</div>` : ''}
          </div>
          <i data-lucide="chevron-right" style="flex-shrink:0;color:var(--text-muted);"></i>
        </div>
      </button>`;
  }

  // Purely supplementary — the "Find Directions" button above always
  // works regardless of what (if anything) shows here. This is just "does
  // My Orientation already know a matching UP-specific location", shown
  // as optional suggestions a student can tap for the fuller destination
  // card (address, wrong-location check, etc.) instead of the plain
  // free-text hand-off. A search with no local match renders nothing at
  // all here (no "no results"/"not found" message) — that's expected and
  // normal, not an error state, since Find Directions never needed a
  // local match in the first place.
  function renderSearchResults() {
    if (local.searchError) {
      return `<div class="card card-pad"><div class="text-sm" style="color:var(--color-error);"><i data-lucide="alert-circle" style="width:14px;height:14px;"></i> ${U.escapeHtml(local.searchError)}</div></div>`;
    }
    if (!local.searchResults || !local.searchResults.length) return '';
    return `
    <div class="text-xs font-bold text-muted mb-2" style="text-transform:uppercase;letter-spacing:.03em;">Suggestions</div>
    <div class="flex flex-col gap-2">
      ${local.searchResults.map(resultCard).join('')}
    </div>`;
  }

  function renderDestinationCard() {
    const d = local.destination;
    // "Wrong location" context: only ever shown when there's a real GPS
    // fix to compare against — never guessed. Pure on-device distance
    // math (haversine against this app's own approximate campus/mock
    // coordinates), entirely separate from the real navigation Google
    // Maps performs once Navigate is pressed — this is just "does it
    // look like you're already there", not a routed distance.
    const distToDestination = local.userCoords && d.coords ? O.distanceMeters(local.userCoords, d.coords) : null;
    const ARRIVED_THRESHOLD_M = 30;
    const notThereYet = distToDestination !== null && distToDestination > ARRIVED_THRESHOLD_M;

    return `
    <div class="page-wrap" style="max-width:640px;">
      ${header('My Orientation', 'orientation-back-to-search')}
      <div class="text-xs font-bold text-muted mb-2" style="text-transform:uppercase;letter-spacing:.03em;">Destination</div>
      <div class="card card-pad mb-3">
        <h2 class="text-xl font-bold">${U.escapeHtml(d.name)}</h2>
        <div class="text-sm text-muted mt-1">${U.escapeHtml(local.campus.fullName)}</div>
        ${d.address ? `<div class="text-sm text-muted mt-1"><i data-lucide="map-pin" style="width:13px;height:13px;"></i> ${U.escapeHtml(d.address)}</div>` : ''}
        <div class="badge badge-gray mt-3"><i data-lucide="footprints" style="width:13px;height:13px;"></i> Walking</div>

        ${local.userCoords ? `
        <div class="divider" style="margin:14px 0;"></div>
        ${notThereYet ? `
          <div class="flex items-center gap-2 mb-1"><i data-lucide="alert-triangle" style="color:var(--color-primary);"></i><strong style="font-size:14px;">You're not at your destination yet.</strong></div>
          <p class="text-sm text-muted">You're approximately ${formatDistance(distToDestination)} from your destination.</p>
        ` : distToDestination !== null ? `
          <div class="flex items-center gap-2"><i data-lucide="check-circle-2" style="color:var(--color-success);"></i><strong style="font-size:14px;">You've arrived at your destination.</strong></div>
        ` : ''}
        ` : ''}

        <button type="button" class="btn btn-primary btn-block btn-lg mt-3 ${local.launching ? 'btn-loading' : ''}" data-action="orientation-navigate" ${local.launching ? 'disabled' : ''}>
          <i data-lucide="navigation"></i> Show Directions
        </button>

        <div class="flex gap-2 mt-3" style="flex-wrap:wrap;">
          ${local.userCoords
            ? `<button type="button" class="btn btn-secondary btn-sm" data-action="orientation-recalculate"><i data-lucide="rotate-ccw"></i> Recalculate</button>`
            : `<button type="button" class="btn btn-secondary btn-sm" data-action="orientation-use-location"><i data-lucide="map-pin"></i> Use My Location</button>`}
        </div>
      </div>
    </div>`;
  }

  function render() {
    applyProfileDefaultCampus();
    switch (local.step) {
      case 'destination': return local.campus ? renderDestinationSearch() : renderStart();
      case 'card': return local.destination ? renderDestinationCard() : renderStart();
      default: return renderStart();
    }
  }

  // ---------------- Dispatch ----------------
  function handleAction(action, ds) {
    switch (action) {
      case 'orientation-use-location': return useCurrentLocation();
      case 'orientation-select-campus': return selectCampus(ds.id);
      case 'orientation-change-campus': return changeCampus();
      case 'orientation-back-to-start': return changeCampus();
      case 'orientation-example-search': return runExampleSearch(ds.q);
      case 'orientation-select-result': return selectResult(ds.id);
      case 'orientation-find-directions': return findDirections();
      case 'orientation-back-to-search': local.step = 'destination'; local.destination = null; return App.render();
      case 'orientation-navigate': return navigate();
      case 'orientation-recalculate': return recheckLocation();
      default: return;
    }
  }

  function handleInput(kind, value) {
    if (kind !== 'orientation-search') return;
    handleSearchInput(value);
  }

  return { render, handleAction, handleInput, reset, local };
})();
