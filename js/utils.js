/* ============================================================
   CLICKFUD — utilities: formatting, validation, sanitization
   ============================================================ */
window.App = window.App || {};

App.Utils = (function () {

  function money(n) {
    const v = Number(n) || 0;
    return 'R' + v.toFixed(2);
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Strip anything resembling markup from free-text user input before storing.
  function sanitizeText(str, maxLen) {
    if (!str) return '';
    let s = String(str).replace(/<[^>]*>/g, '').trim();
    if (maxLen) s = s.slice(0, maxLen);
    return s;
  }

  function formatDate(dateLike) {
    const d = new Date(dateLike);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function formatTime(dateLike) {
    const d = new Date(dateLike);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
  }

  function formatDateTime(dateLike) {
    return formatDate(dateLike) + ', ' + formatTime(dateLike);
  }

  function timeAgo(dateLike) {
    const d = new Date(dateLike);
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function minutesUntil(dateLike) {
    const d = new Date(dateLike);
    const diff = Math.round((d.getTime() - Date.now()) / 60000);
    return diff;
  }

  function debounce(fn, wait) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait || 250);
    };
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
  }

  function isValidPhone(phone) {
    return /^[0-9+\s-]{7,15}$/.test(String(phone || '').trim());
  }

  function isValidPrice(n) {
    const v = Number(n);
    return Number.isFinite(v) && v >= 0;
  }

  function isValidQty(n) {
    const v = Number(n);
    return Number.isInteger(v) && v >= 1;
  }

  // Returns an array of unmet rule messages; empty array means the
  // password passes every rule.
  function validatePassword(password) {
    const pwd = String(password || '');
    const issues = [];
    if (pwd.length < 8) issues.push('at least 8 characters');
    if (!/[A-Z]/.test(pwd)) issues.push('at least one uppercase letter');
    if (!/[a-z]/.test(pwd)) issues.push('at least one lowercase letter');
    if (!/[0-9]/.test(pwd)) issues.push('at least one number');
    if (!/[!@#$%^&*()\-_+=?]/.test(pwd)) issues.push('at least one special character (! @ # $ % ^ & * ( ) - _ + = ?)');
    if (hasSequentialDigits(pwd)) issues.push('no simple sequential numbers (e.g. 1234)');
    return issues;
  }

  function hasSequentialDigits(str) {
    const digitRuns = String(str || '').match(/\d+/g) || [];
    return digitRuns.some(run => {
      if (run.length < 4) return false;
      for (let start = 0; start <= run.length - 4; start++) {
        let ascending = true, descending = true;
        for (let i = start; i < start + 3; i++) {
          const a = Number(run[i]), b = Number(run[i + 1]);
          if (b !== a + 1) ascending = false;
          if (b !== a - 1) descending = false;
        }
        if (ascending || descending) return true;
      }
      return false;
    });
  }

  function initials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function uid() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function starIcons(rating, size) {
    const full = Math.round(rating || 0);
    let html = '';
    for (let i = 1; i <= 5; i++) {
      html += `<i data-lucide="star" style="width:${size || 14}px;height:${size || 14}px;${i <= full ? 'fill:#FFC107;color:#FFC107' : 'color:var(--border-strong)'}"></i>`;
    }
    return html;
  }

  function qs(obj) {
    return Object.keys(obj).filter(k => obj[k] !== undefined && obj[k] !== null).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(obj[k])}`).join('&');
  }

  return {
    money, escapeHtml, sanitizeText, formatDate, formatTime, formatDateTime, timeAgo,
    minutesUntil, debounce, isValidEmail, isValidPhone, isValidPrice, isValidQty,
    initials, uid, clamp, starIcons, qs, validatePassword,
  };
})();
