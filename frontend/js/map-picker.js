/* ============================================================
   CLICKFOOD, map pin picker (Leaflet + OpenStreetMap, loaded on first
   use) and distance helpers.

   App.MapPicker.mount(el, { lat, lng }, onChange) draws a map with a
   draggable pin; tapping the map moves it, "Use my location" asks the
   phone. onChange({ lat, lng }) fires on every move.
   ============================================================ */
window.App = window.App || {};

App.MapPicker = (function () {
  const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
  const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
  const HATFIELD = { lat: -25.7545, lng: 28.2314 };
  let loading = null;

  function load() {
    if (window.L) return Promise.resolve(window.L);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = LEAFLET_CSS;
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = LEAFLET_JS;
      js.onload = () => resolve(window.L);
      js.onerror = () => { loading = null; reject(new Error('Map could not load')); };
      document.head.appendChild(js);
    });
    return loading;
  }

  function validPin(p) { return !!p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)); }

  // ---------------- Place search (OpenStreetMap Nominatim) ----------------
  // Free, no key. Only runs when the person presses Search or Enter (never
  // while typing), one request at a time, South Africa first, nearer places
  // first. What is typed is sent to OpenStreetMap; nothing else.
  const SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
  async function searchPlaces(text, near) {
    const params = new URLSearchParams({ format: 'jsonv2', q: text, countrycodes: 'za', limit: '6', 'accept-language': 'en' });
    if (near) {   // prefer results around the map's current area (not a hard limit)
      const d = 0.6;
      params.set('viewbox', [near.lng - d, near.lat + d, near.lng + d, near.lat - d].join(','));
    }
    const res = await fetch(`${SEARCH_URL}?${params.toString()}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('search ' + res.status);
    const rows = await res.json();
    return (Array.isArray(rows) ? rows : []).map(r => ({ lat: Number(r.lat), lng: Number(r.lon), label: String(r.display_name || '') }))
      .filter(r => validPin(r));
  }

  async function mount(el, start, onChange) {
    if (!el) return null;
    el.innerHTML = `<div class="map-picker-search">
        <div class="search-clear-wrap"><input type="search" class="input map-picker-q" placeholder="Search an address or place" aria-label="Search an address or place" autocomplete="off" enterkeyhint="search" /></div>
        <button type="button" class="btn btn-secondary map-picker-go"><i data-lucide="search"></i>Search</button>
      </div>
      <div class="map-picker-results" hidden></div>
      <div class="map-picker-stage">
        <div class="map-picker-canvas"></div>
        <button type="button" class="btn btn-secondary btn-sm map-picker-locate"><i data-lucide="locate-fixed"></i>Use my location</button>
      </div>
      <div class="map-picker-hint text-xs text-muted">Search for the place, or tap the map. Drag the pin to the exact spot.</div>`;
    if (window.lucide) lucide.createIcons();
    let L;
    try { L = await load(); } catch (e) {
      el.querySelector('.map-picker-canvas').innerHTML = `<div class="map-picker-error">Map couldn't load. Check your connection and try again.</div>`;
      return null;
    }
    const canvas = el.querySelector('.map-picker-canvas');
    if (!canvas || !canvas.isConnected) return null;
    const has = validPin(start);
    const pos = has ? [Number(start.lat), Number(start.lng)] : [HATFIELD.lat, HATFIELD.lng];
    const map = L.map(canvas, { zoomControl: true, attributionControl: true }).setView(pos, has ? 17 : 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    const icon = L.divIcon({ className: 'map-pin-icon', html: '<span></span>', iconSize: [30, 42], iconAnchor: [15, 40] });
    let marker = null;
    // onChange(pin, info): info.label is the found place's name when the pin came from a search
    const set = (lat, lng, pan, info) => {
      if (!marker) marker = L.marker([lat, lng], { draggable: true, icon }).addTo(map).on('dragend', () => { const p = marker.getLatLng(); onChange({ lat: p.lat, lng: p.lng }, {}); });
      else marker.setLatLng([lat, lng]);
      if (pan) map.setView([lat, lng], Math.max(map.getZoom(), 17));
      onChange({ lat, lng }, info || {});
    };
    if (has) set(pos[0], pos[1], false);
    map.on('click', (e) => set(e.latlng.lat, e.latlng.lng, false));

    // place search: the pin goes to the chosen place, not where the phone is
    const qEl = el.querySelector('.map-picker-q'), goEl = el.querySelector('.map-picker-go'), listEl = el.querySelector('.map-picker-results');
    let busy = false; let found = [];
    const showList = (html) => { listEl.innerHTML = html; listEl.hidden = !html; };
    async function runSearch() {
      const text = qEl.value.trim();
      if (busy) return;
      if (text.length < 3) return App.Toast.error('Type at least 3 letters of the address or place.');
      busy = true; goEl.classList.add('btn-loading');
      try {
        const c = map.getCenter();
        found = await searchPlaces(text, { lat: c.lat, lng: c.lng });
        showList(found.length
          ? found.map((r, i) => `<button type="button" class="map-picker-result" data-i="${i}"><i data-lucide="map-pin"></i><span>${App.Utils.escapeHtml(r.label)}</span></button>`).join('')
          : '<div class="map-picker-none text-sm text-muted">No places found. Try a street name and area, or tap the map.</div>');
        if (window.lucide) lucide.createIcons();
      } catch (e) {
        showList('<div class="map-picker-none text-sm text-muted">Couldn\'t search right now. Tap the map instead.</div>');
      } finally { busy = false; goEl.classList.remove('btn-loading'); }
    }
    goEl.addEventListener('click', runSearch);
    // Enter searches; it must never submit the form the map sits in
    qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); runSearch(); } });
    listEl.addEventListener('click', (e) => {
      const b = e.target.closest('.map-picker-result'); if (!b) return;
      const r = found[Number(b.dataset.i)]; if (!r) return;
      showList('');
      set(r.lat, r.lng, true, { label: r.label, source: 'search' });
    });
    el.querySelector('.map-picker-locate').addEventListener('click', (ev) => {
      const btn = ev.currentTarget;
      if (!navigator.geolocation) return App.Toast.error("Your phone can't share its location here.");
      btn.classList.add('btn-loading');
      navigator.geolocation.getCurrentPosition(
        (g) => { btn.classList.remove('btn-loading'); set(g.coords.latitude, g.coords.longitude, true, { source: 'gps' }); },
        () => { btn.classList.remove('btn-loading'); App.Toast.error('Location is off. Search for the place or tap the map instead.'); },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });   // a fresh reading, never an old one
    });
    // The map is often drawn inside a modal that is still animating in.
    setTimeout(() => map.invalidateSize(), 250);
    return map;
  }

  /** Mounts once into #id (a container App.render keeps across redraws). */
  function ensure(id, start, onChange) {
    setTimeout(() => {
      const el = document.getElementById(id);
      if (!el || el.dataset.mounted) return;
      el.dataset.mounted = "1";
      mount(el, start, onChange);
    }, 0);
  }

  // ---------------- Distance ----------------
  function distanceKm(a, b) {
    if (!validPin(a) || !validPin(b)) return null;
    const R = 6371, rad = (d) => d * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function distanceLabel(km) {
    if (km == null) return '';
    return km < 1 ? `${Math.max(50, Math.round(km * 1000 / 50) * 50)} m away` : `${km.toFixed(km < 10 ? 1 : 0)} km away`;
  }
  /** The active ordering location (saved or current, js/discovery.js), or null. */
  function myPin() {
    if (App.Discovery && App.Discovery.activePin) return App.Discovery.activePin();
    const p = App.Store.state.profile;
    return p && validPin({ lat: p.home_lat, lng: p.home_lng }) && p.home_lat != null ? { lat: Number(p.home_lat), lng: Number(p.home_lng) } : null;
  }
  function shopPin(store) {
    return store && store.pickup_lat != null && store.pickup_lng != null ? { lat: Number(store.pickup_lat), lng: Number(store.pickup_lng) } : null;
  }
  /** Distance from the student's home to a shop's pickup point, in km (null if unknown). */
  function kmToShop(store) { return distanceKm(myPin(), shopPin(store)); }
  function directionsUrl(store) {
    const p = shopPin(store);
    return p ? `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}` : '';
  }

  function shortLabel(label) { return String(label || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 3).join(', ').slice(0, 160); }
  // fill an empty address box from a searched place (never overwrites what was typed)
  function fillIfEmpty(inputId, info) {
    const el = document.getElementById(inputId);
    if (!el || !info || !info.label || el.value.trim()) return null;
    el.value = shortLabel(info.label);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  }

  return { load, mount, ensure, shortLabel, fillIfEmpty, distanceKm, distanceLabel, myPin, shopPin, kmToShop, directionsUrl, validPin };
})();
