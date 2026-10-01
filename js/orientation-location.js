/* ============================================================
   CLICKFUD — My Orientation: browser geolocation service

   Thin promise wrapper around navigator.geolocation. Never assumes a
   location — every caller gets back either real coordinates or a
   typed error it can show a clear message for (unsupported/denied/
   unavailable/timeout), and nothing here silently falls back to a
   guessed position.
   ============================================================ */
window.App = window.App || {};
App.Orientation = App.Orientation || {};

App.Orientation.LocationService = (function () {
  function getCurrentPosition(options) {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) {
        resolve({ error: 'unsupported', message: 'Your browser/device does not support location services.' });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({
            coords: { lat: pos.coords.latitude, lng: pos.coords.longitude },
            accuracyMeters: pos.coords.accuracy != null ? Math.round(pos.coords.accuracy) : null,
          });
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) {
            resolve({ error: 'denied', message: 'Location permission was denied. You can still choose your campus manually below.' });
          } else if (err.code === err.POSITION_UNAVAILABLE) {
            resolve({ error: 'unavailable', message: 'Your location could not be determined right now (GPS unavailable). Please choose your campus manually.' });
          } else if (err.code === err.TIMEOUT) {
            resolve({ error: 'timeout', message: 'Getting your location took too long. Please try again or choose your campus manually.' });
          } else {
            resolve({ error: 'unknown', message: 'Something went wrong getting your location. Please choose your campus manually.' });
          }
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000, ...options }
      );
    });
  }

  return { getCurrentPosition };
})();
