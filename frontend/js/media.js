/* ============================================================
   CLICKFOOD — shared image fitting
   Every image box in the app is a `.media` wrapper with a fixed
   aspect-ratio (set per context in CSS, so nothing jumps while loading).
   Once a photo loads:
   1. Baked-in bars. Some uploads are a phone photo pasted onto a flat
      grey/black canvas (the bars are part of the file). We look for flat,
      matching bands on opposite edges and treat only the real photo
      inside them as the picture. Near-white bands are left alone: a
      product cut-out on white is meant to look like that.
   2. Shape: never blurred, never on bands. See data-fit below.
   data-fit on the wrapper picks the rule:
     auto  (default) product tiles and photos inside cards keep a fixed
           square box and the photo fills it, centred (only the edges are
           trimmed; user chose same-size tiles, no bands, no blur). A photo
           on its own (food popup, shop header) takes the photo's shape
           (capped 0.6 to 2.4), so the whole picture shows.
     art   promo artwork that may carry text: show it whole unless the
           crop would be tiny
     cover always fill (full-bleed backgrounds with text on top)
   The uploaded file itself is never changed. Pixel reading needs the
   <img> to carry crossorigin="anonymous" (Supabase storage allows it);
   without it step 1 is skipped.
   ============================================================ */
window.App = window.App || {};

App.Media = (function () {
  const KEEP = { auto: 0.97, art: 0.97, cover: 0 };
  // product tiles + any photo inside a card: same-size box, photo fills it
  // (shop cards in the home rows too: every shop image in a row is the same size)
  const TILES = '.card, .shop-prod-img, .menu-card-img, .reorder-card-img-wrap, .store-mini-card, .mshop-card';
  // logos always show whole (CSS: object-fit contain, css/base.css); never trimmed here
  const LOGOS = '.seller-logo, .seller-detail-logo';
  const bands = new Map(); // src -> { x0, x1, y0, y1 } as fractions of the file, or null

  // ---- 1. baked-in bars ----
  function scanBands(img) {
    const SIZE = 160;
    const s = SIZE / Math.max(img.naturalWidth, img.naturalHeight);
    const W = Math.max(8, Math.round(img.naturalWidth * s)), H = Math.max(8, Math.round(img.naturalHeight * s));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data; // throws if the image isn't CORS-readable
    const px = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
    const near = (a, b) => Math.abs(a[0] - b[0]) <= 18 && Math.abs(a[1] - b[1]) <= 18 && Math.abs(a[2] - b[2]) <= 18;
    const flatLine = (n, get, ref) => { let ok = 0; for (let i = 0; i < n; i++) if (near(get(i), ref)) ok++; return ok >= n * 0.96; };
    const isBarColour = (p) => p[3] > 250 && !(p[0] > 232 && p[1] > 232 && p[2] > 232);

    function edge(len, n, get, ref) { // how many lines from this edge are flat bar colour
      if (!isBarColour(ref)) return 0;
      let k = 0; while (k < len * 0.45 && flatLine(n, (i) => get(k, i), ref)) k++;
      return k;
    }
    const l = edge(W, H, (x, y) => px(x, y), px(0, Math.floor(H / 2)));
    const r = edge(W, H, (x, y) => px(W - 1 - x, y), px(W - 1, Math.floor(H / 2)));
    const t = edge(H, W, (y, x) => px(x, y), px(Math.floor(W / 2), 0));
    const b = edge(H, W, (y, x) => px(x, H - 1 - y), px(Math.floor(W / 2), H - 1));
    // letterboxing comes in matching pairs; one flat edge is just a plain background
    const pair = (a, z, len) => a >= len * 0.04 && z >= len * 0.04 && Math.abs(a - z) <= Math.max(a, z) * 0.5;
    const out = { x0: 0, x1: 1, y0: 0, y1: 1 };
    if (pair(l, r, W)) { out.x0 = (l + 1) / W; out.x1 = 1 - (r + 1) / W; }
    if (pair(t, b, H)) { out.y0 = (t + 1) / H; out.y1 = 1 - (b + 1) / H; }
    if (out.x1 - out.x0 < 0.25 || out.y1 - out.y0 < 0.25) return null;
    return (out.x0 || out.y0) ? out : null;
  }

  function bandsFor(img) {
    const src = img.currentSrc || img.src;
    if (bands.has(src)) return bands.get(src);
    let v = null;
    if (img.crossOrigin === 'anonymous' && !src.startsWith(location.origin)) {
      try { v = scanBands(img); } catch (e) { v = null; }
    }
    bands.set(src, v);
    return v;
  }

  // ---- 2. shape ----
  function clearPlacement(el) {
    if (el.dataset.placed) { ['position', 'left', 'top', 'width', 'height', 'maxWidth', 'objectFit'].forEach((k) => { el.style[k] = ''; }); delete el.dataset.placed; }
  }

  function fit(el) {
    const box = el.closest('.media');
    if (!box) return;
    const isVideo = el.tagName === 'VIDEO';
    const w = isVideo ? el.videoWidth : el.naturalWidth;
    const h = isVideo ? el.videoHeight : el.naturalHeight;
    if (!w || !h || el.classList.contains('img-fallback')) {
      box.classList.remove('media--fit', 'media--portrait');
      clearPlacement(el);
      return;
    }
    const crop = isVideo ? null : bandsFor(el);
    const cw = w * (crop ? crop.x1 - crop.x0 : 1), ch = h * (crop ? crop.y1 - crop.y0 : 1);
    const ir = cw / ch;
    // Set first: some boxes change shape for portrait pictures (a taller
    // shop cover on phones), and the fit decision must use the final shape.
    box.classList.toggle('media--portrait', ir < 0.9);
    const mode = box.dataset.fit in KEEP ? box.dataset.fit : 'auto';
    if (box.matches(LOGOS)) { box.classList.remove('media--fit', 'media--contain'); return clearPlacement(el); }
    // Product tiles and photos inside cards (user, 2026-10-13): every box
    // in a row/grid is the same square size and the photo FILLS it, centred
    // (no bands, no blur, no different sizes); only the outer edges are
    // trimmed. The whole photo shows when the food is opened.
    // Photos on their own (food popup, shop header): the box takes the
    // photo's own shape (capped 0.6 to 2.4), so the whole picture shows.
    const tile = mode !== 'cover' && !!box.closest(TILES);
    box.classList.remove('media--contain');
    box.style.backgroundColor = '';
    if (mode !== 'cover' && !tile && box.clientWidth >= 140) {
      const shape = Math.min(2.4, Math.max(0.6, ir));
      box.style.aspectRatio = String(shape);
      box.style.height = 'auto';
      box.style.maxHeight = 'none';
    }
    const bw = box.clientWidth, bh = box.clientHeight;
    if (!bw || !bh) return;
    box.classList.remove('media--fit');

    if (!crop) return clearPlacement(el);
    // Place the file so only the real picture (inside any baked-in bars) fills the box.
    const k = crop;
    const scale = Math.max(bw / cw, bh / ch);
    const cx = (k.x0 + k.x1) / 2 * w * scale, cy = (k.y0 + k.y1) / 2 * h * scale;
    Object.assign(el.style, {
      position: 'absolute', maxWidth: 'none', objectFit: 'fill',
      width: `${w * scale}px`, height: `${h * scale}px`,
      left: `${bw / 2 - cx}px`, top: `${bh / 2 - cy}px`,
    });
    el.dataset.placed = '1';
  }

  function refitAll() {
    document.querySelectorAll('.media > img, .media > video').forEach((el) => {
      if ((el.tagName === 'IMG' && el.complete) || (el.tagName === 'VIDEO' && el.readyState >= 1)) fit(el);
    });
  }

  // One listener for the whole app: load events don't bubble, so capture.
  document.addEventListener('load', (e) => { if (e.target.tagName === 'IMG') fit(e.target); }, true);
  document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') setTimeout(() => fit(e.target), 0); }, true);
  document.addEventListener('loadedmetadata', (e) => { if (e.target.tagName === 'VIDEO') fit(e.target); }, true);

  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(refitAll, 150); });

  return { fit, refitAll };
})();
