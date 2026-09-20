/* ============================================================
   CLICKFUD — full-screen image viewer (pinch-zoom, drag-pan,
   double-tap), used for menu-item photos. The app disables the
   browser's own pinch-zoom everywhere else (touch-action: manipulation,
   viewport user-scalable=no — see index.html/base.css) so this overlay
   implements its own gesture handling from scratch rather than relying
   on any native zoom the rest of the app deliberately turns off.
   ============================================================ */
window.App = window.App || {};

App.ImageViewer = (function () {
  let cleanup = null;

  function open(url, alt) {
    close();
    if (!url) return;
    const root = document.getElementById('image-viewer-root');
    if (!root) return;

    const overlay = document.createElement('div');
    overlay.className = 'image-viewer-overlay';
    overlay.innerHTML = `
      <button type="button" class="image-viewer-close" aria-label="Close"><i data-lucide="x"></i></button>
      <img class="image-viewer-img" src="${url}" alt="${alt ? String(alt).replace(/"/g, '&quot;') : ''}" draggable="false" />`;
    root.appendChild(overlay);
    if (window.lucide) lucide.createIcons({ context: overlay });

    const img = overlay.querySelector('.image-viewer-img');
    let scale = 1, tx = 0, ty = 0;
    let lastPinchDist = null;
    let dragStart = null;
    let lastTapTime = 0;

    function apply(withTransition) {
      img.style.transition = withTransition ? 'transform 160ms ease' : 'none';
      img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    }
    function clamp() {
      scale = Math.min(5, Math.max(1, scale));
      if (scale === 1) { tx = 0; ty = 0; }
    }
    function toggleZoom() {
      if (scale > 1) { scale = 1; tx = 0; ty = 0; } else { scale = 2.5; }
      apply(true);
    }

    function onTouchStart(e) {
      if (e.touches.length === 2) {
        const [a, b] = e.touches;
        lastPinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      } else if (e.touches.length === 1) {
        dragStart = { x: e.touches[0].clientX - tx, y: e.touches[0].clientY - ty };
      }
    }
    function onTouchMove(e) {
      if (e.touches.length === 2 && lastPinchDist != null) {
        e.preventDefault();
        const [a, b] = e.touches;
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        scale *= dist / lastPinchDist;
        lastPinchDist = dist;
        clamp();
        apply(false);
      } else if (e.touches.length === 1 && dragStart && scale > 1) {
        e.preventDefault();
        tx = e.touches[0].clientX - dragStart.x;
        ty = e.touches[0].clientY - dragStart.y;
        apply(false);
      }
    }
    function onTouchEnd(e) {
      if (e.touches.length < 2) lastPinchDist = null;
      if (e.touches.length === 0) {
        dragStart = null;
        clamp();
        apply(true);
        const now = Date.now();
        if (now - lastTapTime < 300) { toggleZoom(); lastTapTime = 0; } else { lastTapTime = now; }
      }
    }

    // Desktop: wheel to zoom, mouse-drag to pan once zoomed, double-click to toggle.
    let mouseDragStart = null;
    function onWheel(e) {
      e.preventDefault();
      scale += (e.deltaY < 0 ? 0.15 : -0.15) * scale;
      clamp();
      apply(false);
    }
    function onMouseDown(e) {
      if (scale <= 1) return;
      mouseDragStart = { x: e.clientX - tx, y: e.clientY - ty };
    }
    function onMouseMove(e) {
      if (!mouseDragStart) return;
      tx = e.clientX - mouseDragStart.x;
      ty = e.clientY - mouseDragStart.y;
      apply(false);
    }
    function onMouseUp() { mouseDragStart = null; }
    function onDblClick() { toggleZoom(); }
    function onOverlayClick(e) { if (e.target === overlay) close(); }
    // App.Modal (the product-detail modal this viewer usually opens on
    // top of) has its own document-level Escape listener. Both listen on
    // the same document node, so without capture + stopPropagation here,
    // one Escape press would close this viewer AND cascade to close the
    // modal underneath it in the same keystroke. Capture phase always
    // runs before bubble-phase listeners on the same node regardless of
    // which one was registered first, so this reliably wins the race and
    // stops the modal's own (bubble-phase) handler from ever seeing it.
    function onKeydown(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    }

    overlay.addEventListener('touchstart', onTouchStart, { passive: true });
    overlay.addEventListener('touchmove', onTouchMove, { passive: false });
    overlay.addEventListener('touchend', onTouchEnd);
    overlay.addEventListener('wheel', onWheel, { passive: false });
    img.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    img.addEventListener('dblclick', onDblClick);
    overlay.addEventListener('click', onOverlayClick);
    overlay.querySelector('.image-viewer-close').addEventListener('click', close);
    document.addEventListener('keydown', onKeydown, true);

    cleanup = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keydown', onKeydown, true);
    };
  }

  function close() {
    const root = document.getElementById('image-viewer-root');
    if (root) root.innerHTML = '';
    if (cleanup) { cleanup(); cleanup = null; }
  }

  return { open, close };
})();
