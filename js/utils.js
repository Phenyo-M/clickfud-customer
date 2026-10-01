/* ============================================================
   CLICKFUD — utilities: formatting, validation, sanitization
   ============================================================ */
window.App = window.App || {};

App.Utils = (function () {

  function money(n) {
    const v = Number(n) || 0;
    return 'R' + v.toFixed(2);
  }

  // The one customer-facing price for a menu item — shop price plus the
  // developer's own per-item platform fee (set at menu approval; see
  // migration_governance.sql section 41). Every place a menu item's price
  // is shown to or charged from a customer goes through this, so it can
  // never drift from what paystack-initialize/paystack-charge-saved/
  // orders.js actually charge server-side.
  function menuItemPrice(item) {
    return Math.round((Number(item?.price || 0) + Number(item?.platform_fee_amount || 0)) * 100) / 100;
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

  // Customer sign-up helpers — for instant feedback only; the server
  // (supabase/up_student_auth.sql) makes the real decision.
  function isUpStudentEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) && e.split('@')[1] === String(App.CONFIG.UP_STUDENT_EMAIL_DOMAIN).toLowerCase();
  }
  // "U12345678", "12345678", "u1234 5678" -> "u12345678"; null if not 8 digits.
  function normalizeStudentNumber(value) {
    const digits = String(value || '').replace(/[^0-9]/g, '');
    return /^[0-9]{8}$/.test(digits) && /^\s*u?\s*[0-9\s]+$/i.test(String(value || '')) ? 'u' + digits : null;
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

  // Real browser Speech Recognition (no external service, no key) — used
  // by the home page's search mic button. The button itself is only
  // ever rendered when this returns true, so there's no dead/fake mic
  // icon shown on browsers that don't support it (mainly desktop
  // Firefox as of this writing).
  function speechRecognitionSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  // opts: { onResult(transcript), onError(), onEnd() } — a single
  // one-shot listen, not continuous dictation.
  function startVoiceSearch(opts) {
    opts = opts || {};
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { if (opts.onError) opts.onError('not_supported'); return null; }
    const rec = new Recognition();
    rec.lang = 'en-ZA';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const transcript = e.results && e.results[0] && e.results[0][0] ? e.results[0][0].transcript : '';
      if (opts.onResult) opts.onResult(transcript);
    };
    rec.onerror = () => { if (opts.onError) opts.onError('recognition_failed'); };
    rec.onend = () => { if (opts.onEnd) opts.onEnd(); };
    rec.start();
    return rec;
  }

  return {
    money, menuItemPrice, escapeHtml, sanitizeText, formatDate, formatTime, formatDateTime, timeAgo,
    minutesUntil, debounce, isValidEmail, isUpStudentEmail, normalizeStudentNumber, isValidPhone, isValidPrice, isValidQty,
    initials, uid, clamp, starIcons, qs, validatePassword,
    speechRecognitionSupported, startVoiceSearch,
  };
})();
