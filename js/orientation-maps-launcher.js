/* ============================================================
   CLICKFUD — My Orientation: Google Maps hand-off

   My Orientation performs zero mapping/routing/navigation itself. Its
   only job is finding the right University of Pretoria destination and
   handing it to the real Google Maps app/website, using Google's own
   public, keyless "Maps URLs" scheme (https://developers.google.com/
   maps/documentation/urls/get-started) — NOT the Maps JavaScript API,
   Places API or Routes API. No API key, no Google Cloud project, no
   billing: this is a plain URL, exactly like a mailto: or tel: link.

   Google's own documented behaviour for this URL format is what
   delivers "opens the Google Maps app if installed, falls back to
   Google Maps on the web otherwise" — universally, without this file
   needing to detect the platform, try a custom comgoogle­maps:// scheme,
   or run its own fallback timer. That's the "official Google Maps
   URLs approach" the app owner asked for.
   ============================================================ */
window.App = window.App || {};
App.Orientation = App.Orientation || {};

App.Orientation.MapsLauncher = (function () {
  // Accuracy: deliberately NEVER sends this app's own approximate mock
  // coordinates as the destination — those are offset guesses for
  // on-screen distance context only (see orientation-providers.js), not
  // survey-accurate positions. A well-formed text query (building name +
  // full official campus name) lets Google's own, genuinely accurate
  // Maps database resolve the real building — the same as if the
  // student had typed it into Google Maps themselves. If a Place ID is
  // ever wired in later (there isn't one today — Places API was
  // deliberately removed from this app), destination_place_id would be
  // added here to pin the exact place; until then, name+campus text is
  // the most accurate input this app can honestly provide.
  function destinationQuery(destination, campus) {
    const name = (destination && destination.name || '').trim();
    if (!name) return null;
    const campusLabel = campus && campus.fullName ? campus.fullName : '';
    return campusLabel ? `${name}, ${campusLabel}` : name;
  }

  // A real GPS fix (from App.Orientation.LocationService, "lat,lng") is
  // Google's own documented way to pin an exact origin on this URL
  // scheme — more reliable than leaving origin blank, since that instead
  // depends on Google Maps' OWN separate location permission (which may
  // differ from this page's) being granted at the moment it opens.
  function originParam(userCoords) {
    if (!userCoords || typeof userCoords.lat !== 'number' || typeof userCoords.lng !== 'number') return null;
    return `${userCoords.lat},${userCoords.lng}`;
  }

  // Builds Google's documented Directions URL — api=1 is required by
  // that spec; travelmode=walking matches this feature's walking-only
  // scope; dir_action=navigate drops the student straight into
  // turn-by-turn mode instead of just previewing the route. origin is
  // set to the student's real current position when it's already known
  // (userCoords); otherwise it's left out entirely and Google Maps falls
  // back to asking for/using the device's own current location itself —
  // either way, directions always start from where the student actually
  // is, never from a fixed campus point.
  function buildDirectionsUrl(destination, campus, userCoords) {
    const query = destinationQuery(destination, campus);
    if (!query) return { error: 'insufficient_info', message: "This destination doesn't have enough information for accurate directions." };
    const params = new URLSearchParams({
      api: '1',
      destination: query,
      travelmode: 'walking',
      dir_action: 'navigate',
    });
    const origin = originParam(userCoords);
    if (origin) params.set('origin', origin);
    return { url: `https://www.google.com/maps/dir/?${params.toString()}` };
  }

  // Builds Google's documented Search URL — the same keyless "Maps
  // URLs" family as buildDirectionsUrl above, just search/?api=1 instead
  // of dir/?api=1. This is the fallback for anything NOT in this app's
  // own UP destination database (see js/orientation-providers.js): it
  // never tries to look the query up itself, never scrapes a result —
  // it just hands the raw query + campus context to Google's own search,
  // exactly as if the student had typed it into Google Maps directly.
  function buildSearchUrl(query, campus) {
    const text = String(query || '').trim();
    if (!text) return { error: 'empty_query', message: 'Please enter something to search for.' };
    // searchContext (not fullName) — already formatted exactly as
    // "University of Pretoria Hatfield Campus, Pretoria, South Africa",
    // including the city/country suffix a plain Google Maps search
    // benefits from that the Directions flow above doesn't strictly need.
    const campusLabel = campus && campus.searchContext ? campus.searchContext : (campus && campus.fullName) || '';
    const fullQuery = campusLabel ? `${text}, ${campusLabel}` : text;
    const params = new URLSearchParams({ api: '1', query: fullQuery });
    return { url: `https://www.google.com/maps/search/?${params.toString()}` };
  }

  // "Find Directions" — destination = the student's own free-typed
  // text, exactly as specified: this never requires the destination to
  // exist in this app's own database at all. Origin prefers the
  // student's real current position (userCoords) when it's already
  // known, so directions genuinely start from wherever they actually
  // are; the selected campus's name is only a fallback for when location
  // isn't available at all, since a free-text destination Google Maps
  // has never seen before still needs SOME origin context to anchor it
  // to the right part of Pretoria.
  function buildFreeTextDirectionsUrl(campus, destinationText, userCoords) {
    const destination = String(destinationText || '').trim();
    if (!destination) return { error: 'empty_query', message: 'Please enter a destination.' };
    const origin = originParam(userCoords) || (campus && campus.searchContext ? campus.searchContext : (campus && campus.fullName) || '');
    const params = new URLSearchParams({ api: '1', destination, travelmode: 'walking', dir_action: 'navigate' });
    if (origin) params.set('origin', origin);
    return { url: `https://www.google.com/maps/dir/?${params.toString()}` };
  }

  // Opens the URL. On a phone, Google's universal link handling takes
  // over from here (native app if installed, google.com/maps in the
  // browser if not) — nothing else to detect or branch on. Using
  // location.href rather than window.open: on mobile this lets the OS
  // intercept the navigation and hand off to the native app cleanly,
  // rather than opening (and then abandoning) a blank browser tab.
  function open(url) {
    window.location.href = url;
  }

  // The one function js/pages/orientation.js actually calls for
  // navigation. Never throws — a destination missing even a name is
  // reported back as a clear error instead of silently opening Google
  // Maps with an empty or nonsensical destination.
  function launch(destination, campus, userCoords) {
    const built = buildDirectionsUrl(destination, campus, userCoords);
    if (built.error) return built;
    open(built.url);
    return { ok: true, url: built.url };
  }

  // The search-fallback equivalent of launch() above — for a query that
  // isn't (or might not be) in this app's own UP destination database.
  // Same never-throws contract: an empty query is reported back as a
  // clear error instead of opening a blank/meaningless Google Maps search.
  function launchSearch(query, campus) {
    const built = buildSearchUrl(query, campus);
    if (built.error) return built;
    open(built.url);
    return { ok: true, url: built.url };
  }

  // "Find Directions" launch — see buildFreeTextDirectionsUrl above.
  function launchFreeTextDirections(campus, destinationText, userCoords) {
    const built = buildFreeTextDirectionsUrl(campus, destinationText, userCoords);
    if (built.error) return built;
    open(built.url);
    return { ok: true, url: built.url };
  }

  return {
    buildDirectionsUrl, buildSearchUrl, buildFreeTextDirectionsUrl,
    launch, launchSearch, launchFreeTextDirections, destinationQuery,
  };
})();
