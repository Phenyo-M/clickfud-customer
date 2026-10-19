/* ============================================================
   CLICKFOOD, supported institutions (public.allowed_domains)

   Which student email domains can sign up is managed by the developer in
   the developer app (Supported Institutions), never in this code. The
   active rows are readable by everyone, so the sign-up page can list them
   and warn early. The database makes the real decision (sign-up trigger,
   supabase/allowed_domains.sql); this copy is only for instant messages.
   ============================================================ */
window.App = window.App || {};

App.Institutions = (function () {
  let list = null; // null = not loaded (then the app lets the server decide)

  async function load() {
    const { data, error } = await App.sb.from('allowed_domains')
      .select('institution_name, domain, student_number_digits, student_number_prefix')
      .eq('active', true).order('institution_name');
    if (error) { console.error('institutions', error); return list; }
    list = data || [];
    return list;
  }
  function loaded() { return list !== null; }
  function all() { return list || []; }
  function ruleFor(email) {
    const domain = String(email || '').trim().toLowerCase().split('@')[1] || '';
    return all().find(r => r.domain === domain) || null;
  }
  // an example address, e.g. u12345678@tuks.co.za or 123456789@tut4life.ac.za
  function example(rule) {
    if (!rule) return '';
    const local = rule.student_number_digits ? (rule.student_number_prefix || '') + '1234567890123'.slice(0, rule.student_number_digits) : 'yourname';
    return local + '@' + rule.domain;
  }
  function names() { return all().map(r => r.institution_name); }

  return { load, loaded, all, ruleFor, example, names };
})();
