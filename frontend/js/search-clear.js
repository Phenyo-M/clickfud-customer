/* ============================================================
   CLICKFOOD, the X that clears a search box

   One behaviour for every search field: any input inside .search-bar or a
   .search-clear-wrap gets a small X while it has text. Tapping it empties
   the box and sends the field's normal "input" event, so each page's own
   search handler shows its default results again and keeps every other
   filter (university, campus, category) as it was. A search that only runs
   on submit (a form without data-action-input) is submitted again.
   ============================================================ */
window.App = window.App || {};

App.SearchClear = (function () {
  const SEL = '.search-bar input:not([type="hidden"]):not([type="checkbox"]), .search-clear-wrap input';

  function ensure(input) {
    const box = input.closest('.search-bar, .search-clear-wrap');
    if (!box) return null;
    let btn = box.querySelector(':scope > .search-clear');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'search-clear';
      btn.setAttribute('aria-label', 'Clear search');
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
      input.insertAdjacentElement('afterend', btn);
    }
    btn.hidden = !input.value;
    return btn;
  }
  function enhance(root) {
    (root || document).querySelectorAll(SEL).forEach(ensure);
  }
  function clear(btn) {
    const box = btn.closest('.search-bar, .search-clear-wrap');
    const input = box && box.querySelector('input');
    if (!input) return;
    const id = input.id;
    input.value = '';
    btn.hidden = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const form = input.form;
    if (form && /search/.test(form.dataset.form || '') && !input.dataset.actionInput) {
      if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    // the page may have redrawn: keep typing in the (new) box
    const again = (id && document.getElementById(id)) || input;
    if (again && again.isConnected) again.focus();
  }

  document.addEventListener('input', (e) => { if (e.target.matches && e.target.matches(SEL)) ensure(e.target); }, true);
  document.addEventListener('focusin', (e) => { if (e.target.matches && e.target.matches(SEL)) ensure(e.target); });
  // keep the keyboard open: the box doesn't lose focus when the X is pressed
  document.addEventListener('mousedown', (e) => { if (e.target.closest && e.target.closest('.search-clear')) e.preventDefault(); }, true);
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.search-clear');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    clear(btn);
  }, true);

  return { enhance };
})();
