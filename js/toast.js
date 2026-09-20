/* ============================================================
   CLICKFUD — toast notifications, modal shell, confirm dialog
   ============================================================ */
window.App = window.App || {};

App.Toast = (function () {
  const ICONS = { success: 'check-circle-2', error: 'x-circle', warning: 'alert-triangle', info: 'info' };

  function show(message, type, opts) {
    type = type || 'info';
    opts = opts || {};
    const root = document.getElementById('toast-root');
    if (!root) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', 'status');
    el.innerHTML = `<i class="toast-icon" data-lucide="${ICONS[type] || ICONS.info}"></i><span>${App.Utils.escapeHtml(message)}</span>`;
    root.appendChild(el);
    if (window.lucide) lucide.createIcons({ nameAttr: 'data-lucide', attrs: {} , context: el});
    const life = opts.duration || 3200;
    const timer = setTimeout(() => dismiss(el), life);
    el.addEventListener('click', () => { clearTimeout(timer); dismiss(el); });
    return el;
  }
  function dismiss(el) {
    if (!el || !el.parentNode) return;
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 180);
  }

  return {
    show,
    success: (m, o) => show(m, 'success', o),
    error: (m, o) => show(m, 'error', o),
    warning: (m, o) => show(m, 'warning', o),
    info: (m, o) => show(m, 'info', o),
  };
})();

App.Modal = (function () {
  let current = null;

  function renderIcons(scope) { if (window.lucide) lucide.createIcons({ context: scope || document }); }

  function open(html, opts) {
    opts = opts || {};
    const sizeClass = `${opts.size === 'lg' ? 'modal-lg' : ''}${opts.sheet ? ' sheet-panel' : ''}`.trim();

    // If this exact modal is already open, update its content in place
    // instead of tearing down and rebuilding the whole overlay. A modal
    // that re-renders itself on every interaction (e.g. every star tap
    // in the review modal, every checkbox toggle in an extras/add-ons
    // form) used to call open() again each time — destroying and
    // recreating the DOM replayed the CSS entrance animation on every
    // single interaction, which looked like the modal repeatedly
    // jumping/vibrating instead of calmly refreshing, and the
    // programmatic .focus() below kept stealing focus away from
    // whatever the user was doing (typing, tapping the next star).
    // Same fix already applied to App.Slideover for the identical
    // symptom on the cart/notifications panel.
    if (current) {
      const modalEl = current.querySelector('.modal');
      if (modalEl) {
        modalEl.className = `modal ${sizeClass}`.trim();
        modalEl.innerHTML = `${opts.sheet ? '<div class="sheet-handle"></div>' : ''}${html}`;
        renderIcons(current);
      }
      return current;
    }

    const root = document.getElementById('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay' + (opts.sheet ? ' sheet' : '');
    overlay.innerHTML = `<div class="modal ${sizeClass}" role="dialog" aria-modal="true" tabindex="-1">${opts.sheet ? '<div class="sheet-handle"></div>' : ''}${html}</div>`;
    root.appendChild(overlay);
    current = overlay;
    renderIcons(overlay);

    if (opts.closeOnOverlay !== false) {
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    }
    // Swipe-down-to-close for the bottom sheet — drag the panel itself
    // down past a small threshold and release to dismiss, same gesture
    // as every native bottom sheet. Ignored entirely for a normal
    // centered modal (opts.sheet not set). Only ever wired up once, on
    // this first real creation — an in-place content refresh above
    // keeps the same panel element, so these listeners are still bound.
    if (opts.sheet) {
      const panel = overlay.querySelector('.modal');
      let startY = null;
      panel.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; panel.style.transition = 'none'; }, { passive: true });
      panel.addEventListener('touchmove', (e) => {
        if (startY == null) return;
        const dy = e.touches[0].clientY - startY;
        if (dy > 0) panel.style.transform = `translateY(${dy}px)`;
      }, { passive: true });
      panel.addEventListener('touchend', (e) => {
        if (startY == null) return;
        const dy = e.changedTouches[0].clientY - startY;
        panel.style.transition = '';
        panel.style.transform = '';
        startY = null;
        if (dy > 80) close();
      });
    }
    document.addEventListener('keydown', escHandler);
    const modalEl = overlay.querySelector('.modal');
    if (modalEl) modalEl.focus();
    return overlay;
  }
  function escHandler(e) { if (e.key === 'Escape') close(); }
  function close() {
    if (current) { current.remove(); current = null; }
    document.removeEventListener('keydown', escHandler);
  }
  function isOpen() { return !!current; }
  function getRoot() { return current; }

  function confirm(opts) {
    opts = opts || {};
    const variant = opts.variant || 'info';
    const iconName = variant === 'danger' ? 'trash-2' : variant === 'warn' ? 'alert-triangle' : 'help-circle';
    const html = `
      <div class="modal-body" style="text-align:center; padding-top:26px;">
        <div class="confirm-icon ${variant}"><i data-lucide="${iconName}"></i></div>
        <h3 class="text-lg font-bold mb-2">${App.Utils.escapeHtml(opts.title || 'Are you sure?')}</h3>
        <p class="text-muted text-sm">${App.Utils.escapeHtml(opts.message || '')}</p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-confirm-cancel>${App.Utils.escapeHtml(opts.cancelLabel || 'Cancel')}</button>
        <button type="button" class="btn ${variant === 'danger' ? 'btn-danger' : 'btn-primary'}" data-confirm-ok>${App.Utils.escapeHtml(opts.confirmLabel || 'Confirm')}</button>
      </div>`;
    const overlay = open(html, { size: 'sm' });
    overlay.querySelector('[data-confirm-ok]').addEventListener('click', () => { close(); if (opts.onConfirm) opts.onConfirm(); });
    overlay.querySelector('[data-confirm-cancel]').addEventListener('click', () => { close(); if (opts.onCancel) opts.onCancel(); });
  }

  return { open, close, isOpen, getRoot, confirm, renderIcons };
})();

App.Slideover = (function () {
  let current = null;
  function open(html, opts) {
    opts = opts || {};
    const rootId = opts.rootId || 'cart-panel-root';

    // If this same panel (cart, notifications, ...) is already open,
    // update its content in place instead of tearing down and rebuilding
    // the whole overlay. Every quantity change, item removal, or even an
    // unrelated realtime update while the panel is open calls back into
    // here — recreating the .slideover element every time replayed its
    // CSS slide-in entrance animation on every single one of those, which
    // looked like the panel repeatedly jumping/vibrating rather than
    // calmly refreshing its contents.
    if (current && current.rootId === rootId) {
      const temp = document.createElement('div');
      temp.innerHTML = html;
      const newPanel = temp.firstElementChild;
      const existingPanel = current.overlay.firstElementChild;
      if (newPanel && existingPanel) {
        existingPanel.innerHTML = newPanel.innerHTML;
        existingPanel.className = newPanel.className;
      } else {
        current.overlay.innerHTML = html;
      }
      if (window.lucide) lucide.createIcons({ context: current.overlay });
      return current.overlay;
    }

    close();
    const root = document.getElementById(rootId);
    const overlay = document.createElement('div');
    overlay.className = 'slideover-overlay';
    overlay.innerHTML = html;
    root.appendChild(overlay);
    current = { overlay, rootId };
    if (window.lucide) lucide.createIcons({ context: overlay });
    if (opts.closeOnOverlay !== false) {
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    }
    return overlay;
  }
  function close() {
    if (current) { current.overlay.remove(); current = null; }
  }
  function isOpen() { return !!current; }
  return { open, close, isOpen };
})();
