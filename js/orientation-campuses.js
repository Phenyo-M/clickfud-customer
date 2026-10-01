/* ============================================================
   CLICKFUD — My Orientation: campus configuration

   Single source of truth for the 7 University of Pretoria campuses
   this feature supports. Nothing elsewhere in App.Orientation or
   js/pages/orientation.js hard-codes a campus name/coordinate — every
   screen reads from this list, so adding an 8th campus later is a
   one-line change here, not a hunt through the UI code.

   center: approximate campus coordinates, from general public
   knowledge of where each UP campus is — NOT independently verified
   against a live geocoding call (this app has no Google API
   credentials configured yet; see js/orientation-providers.js). Good
   enough to seed "which campus is closest to me" and the mock
   provider's search radius, but treat these as approximate, not
   survey-grade. Once a real Places API key is configured, real
   searches resolve exact coordinates themselves and these stop
   mattering for anything except the initial "closest campus" guess.
   ============================================================ */
window.App = window.App || {};
App.Orientation = App.Orientation || {};

App.Orientation.CAMPUSES = [
  {
    id: 'hatfield',
    name: 'Hatfield',
    fullName: 'University of Pretoria, Hatfield Campus',
    searchContext: 'University of Pretoria Hatfield Campus, Pretoria, South Africa',
    mapUrl: 'https://www.up.ac.za/campuses-maps-directions',
    center: { lat: -25.7545, lng: 28.2314 },
  },
  {
    id: 'hillcrest',
    name: 'Hillcrest / LC de Villiers',
    fullName: 'University of Pretoria, Hillcrest Campus (LC de Villiers Sports Grounds)',
    searchContext: 'University of Pretoria Hillcrest Campus LC de Villiers, Pretoria, South Africa',
    mapUrl: 'https://www.up.ac.za/campuses-maps-directions',
    center: { lat: -25.7602, lng: 28.2367 },
  },
  {
    id: 'groenkloof',
    name: 'Groenkloof',
    fullName: 'University of Pretoria, Groenkloof Campus',
    searchContext: 'University of Pretoria Groenkloof Campus, Pretoria, South Africa',
    mapUrl: 'https://www.up.ac.za/campuses-maps-directions',
    center: { lat: -25.7809, lng: 28.2145 },
  },
  {
    id: 'prinshof',
    name: 'Prinshof',
    fullName: 'University of Pretoria, Prinshof Campus',
    searchContext: 'University of Pretoria Prinshof Campus, Pretoria, South Africa',
    mapUrl: 'https://www.up.ac.za/campuses-maps-directions',
    center: { lat: -25.7305, lng: 28.1975 },
  },
  {
    id: 'onderstepoort',
    name: 'Onderstepoort',
    fullName: 'University of Pretoria, Onderstepoort Campus',
    searchContext: 'University of Pretoria Onderstepoort Campus, Pretoria, South Africa',
    mapUrl: 'https://www.up.ac.za/campuses-maps-directions',
    center: { lat: -25.6497, lng: 28.1858 },
  },
  {
    id: 'mamelodi',
    name: 'Mamelodi',
    fullName: 'University of Pretoria, Mamelodi Campus',
    searchContext: 'University of Pretoria Mamelodi Campus, Pretoria, South Africa',
    mapUrl: 'https://www.up.ac.za/campuses-maps-directions',
    center: { lat: -25.7156, lng: 28.3705 },
  },
  {
    id: 'gibs',
    name: 'GIBS',
    fullName: 'Gordon Institute of Business Science (GIBS), University of Pretoria',
    searchContext: 'Gordon Institute of Business Science GIBS, Illovo, Johannesburg, South Africa',
    mapUrl: 'https://www.up.ac.za/campuses-maps-directions',
    // GIBS is UP's business school, in Illovo, Johannesburg — not one of
    // the Pretoria-area campuses above, deliberately not "approximately
    // near Hatfield" or similar guesswork.
    center: { lat: -26.1315, lng: 28.0436 },
  },
];

App.Orientation.getCampusById = function (id) {
  return App.Orientation.CAMPUSES.find((c) => c.id === id) || null;
};

// Matches a free-text campus name (e.g. a store's own campus_location,
// or a timetable entry's campus field — both drawn from the same 7-name
// list, case-insensitively) back to its full campus config. Used
// wherever a destination needs to be handed to Google Maps and only a
// plain name string is on hand, not a campus id.
App.Orientation.getCampusByName = function (name) {
  if (!name) return null;
  const needle = String(name).trim().toLowerCase();
  return App.Orientation.CAMPUSES.find((c) => c.name.toLowerCase() === needle) || null;
};

// Haversine great-circle distance in metres — used both for "which
// campus is closest to my GPS position" and the wrong-location distance
// shown on the navigation screen. Pure math, no API call, works
// identically for both the mock and real providers.
App.Orientation.distanceMeters = function (a, b) {
  if (!a || !b || typeof a.lat !== 'number' || typeof b.lat !== 'number') return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
};

App.Orientation.closestCampus = function (coords) {
  if (!coords) return null;
  let best = null, bestDist = Infinity;
  App.Orientation.CAMPUSES.forEach((c) => {
    const d = App.Orientation.distanceMeters(coords, c.center);
    if (d !== null && d < bestDist) { bestDist = d; best = c; }
  });
  return best ? { campus: best, distanceMeters: bestDist } : null;
};
