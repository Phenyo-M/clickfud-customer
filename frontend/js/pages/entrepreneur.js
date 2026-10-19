/* ============================================================
   CLICKFOOD, Student Entrepreneur Programme (customer app)

   A student applies to sell food: verified student email of any
   institution with the Student Entrepreneurs feature on (developer app,
   Supported Institutions) -> application (draft / submit) -> a developer
   reviews -> once approved, the existing shop setup (js/pages/seller.js)
   opens. Every rule is checked by the database
   (supabase/student_entrepreneurs.sql); this page only shows the steps.
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Entrepreneur = (function () {
  const S = App.Store;
  const U = App.Utils;
  const esc = (v) => U.escapeHtml(v == null ? '' : String(v));

  const YEARS = [['first', 'First year'], ['second', 'Second year'], ['third', 'Third year'], ['fourth', 'Fourth year'], ['fifth', 'Fifth year'], ['sixth_plus', 'Sixth year or above'], ['other', 'Other']];
  const STAY = [['lt1', 'Less than one year'], ['1', 'One year'], ['2', 'Two years'], ['3', 'Three years'], ['4', 'Four years'], ['5plus', 'Five years or more'], ['unsure', 'Not sure yet']];
  const LEFT = [['lt1', 'Less than one year'], ['1', 'One year'], ['2', 'Two years'], ['3', 'Three years'], ['4', 'Four years'], ['5plus', 'Five years or more'], ['unsure', 'Not sure yet']];
  const CATS = [['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snacks', 'Snacks and light meals'], ['baked', 'Baked goods and desserts'], ['drinks', 'Drinks'], ['other', 'Other']];
  const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
  const PERIODS = [['morning', 'Morning'], ['midday', 'Lunch time'], ['afternoon', 'Afternoon'], ['evening', 'Evening']];
  const GROUPS = [['', 'Choose (optional)'], ['black_african', 'Black African'], ['coloured', 'Coloured'], ['indian_asian', 'Indian or Asian'], ['white', 'White'], ['other', 'Other'], ['prefer_not', 'Prefer not to say']];
  const STATUS = { draft: 'Draft', pending_review: 'Pending review', under_review: 'Under review', approved: 'Approved', rejected: 'Not approved', withdrawn: 'Withdrawn' };

  const st = { data: null, loading: false, error: null, f: null, busy: false, justSubmitted: false };

  async function load(force) {
    if (st.loading || (st.data && !force)) return;
    st.loading = true;
    const { data, error } = await App.sb.rpc('my_entrepreneur_status');
    st.loading = false;
    if (error) { st.error = "Couldn't load the programme. Please try again."; App.render(); return; }
    st.error = null; st.data = data;
    const a = data && data.application;
    if (!st.f || force) {
      const p = S.state.profile || {};
      const open = a && a.status === 'draft' ? a : null;
      st.f = {
        full_name: (open && open.full_name) || p.name || '', phone: (open && open.phone) || p.phone || '',
        year_of_study: (open && open.year_of_study) || '', expected_stay: (open && open.expected_stay) || '', years_left: (open && open.years_left) || '',
        business_name: (open && open.business_name) || '', categories: (open && open.categories) || [], other_category: (open && open.other_category) || '',
        description: (open && open.description) || '', why_choose: (open && open.why_choose) || '', food_safety: (open && open.food_safety) || '',
        available_days: (open && open.available_days) || [], available_periods: (open && open.available_periods) || [],
        population_group: (open && open.population_group) || '', population_group_consent: !!(open && open.population_group),
        confirm_accurate: false, accept_terms: false, ack_privacy: false,
      };
    }
    App.render();
  }
  function reset() { st.data = null; st.f = null; st.justSubmitted = false; }
  function status() { return st.data; }

  // ---------------- small pieces ----------------
  const field = (label, html, hint) => `<div class="field"><label>${label}</label>${hint ? `<div class="text-xs text-muted mb-1">${hint}</div>` : ''}${html}</div>`;
  const select = (key, opts, id) => `<select class="select" id="${id || 'ent-' + key}" data-action-change="ent-field" data-key="${key}">${['', ...opts].map(o => Array.isArray(o)
    ? `<option value="${esc(o[0])}" ${st.f[key] === o[0] ? 'selected' : ''}>${esc(o[1])}</option>` : '<option value="">Choose</option>').join('')}</select>`;
  const text = (key, max, ph, type) => `<input class="input" id="ent-${key}" ${type ? `type="${type}"` : ''} maxlength="${max}" value="${esc(st.f[key])}" placeholder="${esc(ph || '')}" data-action-input="ent-field" data-key="${key}" />`;
  const area = (key, max, ph) => `<textarea class="input" id="ent-${key}" rows="4" maxlength="${max}" placeholder="${esc(ph || '')}" data-action-input="ent-field" data-key="${key}">${esc(st.f[key])}</textarea><div class="text-xs text-muted ent-count" data-count="${key}">${(st.f[key] || '').length}/${max}</div>`;
  const checks = (key, opts) => `<div class="day-check-row">${opts.map(([v, l]) => `<label class="day-check"><input type="checkbox" data-action-change="ent-toggle" data-key="${key}" data-value="${esc(v)}" ${(st.f[key] || []).map(String).includes(String(v)) ? 'checked' : ''} /><span>${esc(l)}</span></label>`).join('')}</div>`;
  const tick = (key, html) => `<label class="checkbox-row ent-ack"><input type="checkbox" data-action-change="ent-flag" data-key="${key}" ${st.f[key] ? 'checked' : ''} /><span>${html}</span></label>`;
  const legal = (id, label) => `<button type="button" class="link-btn" data-action="legal-open" data-id="${id}">${label}</button>`;

  function shell(inner) {
    return `<div class="page-wrap ent-wrap" style="max-width:640px;">${App.Nav.pageHead('Student Entrepreneurs', 'home')}${inner}</div>`;
  }

  // ---------------- views ----------------
  function render() {
    if (!S.state.profile) {
      return shell(`<div class="card card-pad"><p class="mb-3">Sign in or create a ClickFood account to apply.</p><button type="button" class="btn btn-primary btn-block" data-action="go-auth">Sign in or create an account</button></div>`);
    }
    if (!st.data) { load(false); return shell(st.error ? `<div class="closed-banner"><i data-lucide="alert-circle"></i><div style="flex:1;">${esc(st.error)}</div><button class="btn btn-secondary btn-sm" data-action="ent-reload">Try again</button></div>` : '<div class="card skeleton" style="height:220px;"></div>'); }
    const d = st.data; const a = d.application;
    if (d.is_student === false && !d.has_shop) return shell(`<div class="card card-pad" id="ent-not-student"><p class="mb-2">Student Entrepreneurs is for student accounts.</p><p class="text-sm text-muted">Selling as a business? Register your shop at <a href="https://manager.clickfood.co.za" target="_blank" rel="noopener">manager.clickfood.co.za</a>.</p></div>`);
    if (d.has_shop) return shell(`<div class="card card-pad"><div class="font-bold mb-1">You have a student shop</div><button type="button" class="btn btn-primary btn-block mt-2" data-action="navigate" data-view="sell">Go to My Shop</button></div>`);
    if (st.justSubmitted || (a && (a.status === 'pending_review' || a.status === 'under_review'))) return shell(renderSubmitted(a));
    // approved: straight to shop setup (the shop is a separate step with its own review)
    if (a && a.status === 'approved') return App.Pages.Seller.render();
    if (!d.eligible_email) return shell(renderVerify(d, a));
    return shell(renderForm(d, a));
  }

  function renderSubmitted(a) {
    return `
    <div class="card card-pad ent-status">
      <div class="confirm-icon info"><i data-lucide="badge-check"></i></div>
      <h2 class="text-lg font-bold mb-1">${st.justSubmitted ? 'Application submitted' : 'Your application'}</h2>
      ${a ? `<div class="mb-2"><span class="badge badge-yellow">${esc(STATUS[a.status] || a.status)}</span></div>
      <p class="text-sm mb-1"><strong>${esc(a.business_name)}</strong></p>
      ${a.submitted_at ? `<p class="text-xs text-muted mb-3">Submitted ${esc(U.formatDateTime(a.submitted_at))}</p>` : ''}` : ''}
      <p class="text-sm mb-3">ClickFood will review your application. You'll get a notification with the decision.</p>
      <button type="button" class="btn btn-secondary btn-block" data-action="ent-withdraw">Withdraw application</button>
    </div>`;
  }
  function renderVerify(d, a) {
    const p = S.state.profile || {};
    const doms = d.programme_domains || [];
    const knowsInstitution = doms.some(x => x.university_id);   // older database: no institution on the list
    const mine = knowsInstitution ? doms.filter(x => x.university_id === p.home_university_id) : doms;
    const example = mine.map(x => (x.prefix || '') + (x.digits ? '12345678901'.slice(0, x.digits) : 'name') + '@' + x.domain).join(' or ');
    if (knowsInstitution && p.home_university_id && !mine.length) {
      return `<div class="card card-pad">Student Entrepreneurs isn't open to students of your institution yet.</div>`;
    }
    return `
    ${a && a.status === 'rejected' ? rejectedNote(a) : ''}
    <div class="card card-pad mb-3">
      <p class="mb-3">Are you a university or college student who wants to start or grow your own food business? Apply to become a ClickFood Student Entrepreneur and sell your food to fellow students through the ClickFood platform.</p>
      <div class="font-bold mb-1">Step 1: verify your student email</div>
      <p class="text-sm mb-3">An official university student email is required${example ? ` (for example ${esc(example)})` : ''}. Personal emails such as Gmail or Outlook can't be used for the programme.</p>
      <button type="button" class="btn btn-primary btn-block" data-action="ent-verify">Verify my student email</button>
    </div>
    ${a && a.status === 'draft' ? '<p class="text-xs text-muted">Your draft is saved. You can finish it after verifying.</p>' : ''}`;
  }
  function rejectedNote(a) {
    return `<div class="closed-banner mb-3"><i data-lucide="info"></i><div style="flex:1;"><div class="font-bold">Your last application was not approved</div>${a.decision_reason ? `<div class="text-sm">${esc(a.decision_reason)}</div>` : ''}<div class="text-sm">You can apply again.</div></div></div>`;
  }

  function renderForm(d, a) {
    const f = st.f;
    return `
    ${a && a.status === 'rejected' ? rejectedNote(a) : ''}
    ${a && a.status === 'draft' && a.decision_reason ? `<div class="closed-banner mb-3"><i data-lucide="info"></i><div style="flex:1;"><div class="font-bold">Last review</div><div class="text-sm">${esc(a.decision_reason)}</div></div></div>` : ''}
    <p class="text-sm text-muted mb-3">Verified student email: <strong>${esc(d.eligible_email)}</strong></p>
    <form data-form="ent-form" novalidate>
      <div class="card card-pad mb-3">
        <h2 class="ent-h">Personal information</h2>
        ${field('Full name *', text('full_name', 80, '', 'text'))}
        ${field('Student email', `<input class="input" value="${esc(d.eligible_email)}" disabled />`)}
        ${field('Phone number *', text('phone', 20, '072 123 4567', 'tel'))}
        ${field('University or college', `<input class="input" value="${esc(institutionOf(d, d.eligible_email) || '')}" disabled />`)}
        ${field('Population group (optional)', select('population_group', GROUPS.slice(1)), 'Only used to understand who the programme reaches. Never used to approve or reject an application. Only ClickFood reviewers can see it, and it is deleted 90 days after a decision.')}
        ${f.population_group && f.population_group !== 'prefer_not' ? tick('population_group_consent', 'I agree that ClickFood may keep my population group for the purpose above.') : ''}
      </div>
      <div class="card card-pad mb-3">
        <h2 class="ent-h">University</h2>
        <p class="text-xs text-muted mb-2">Estimates are fine.</p>
        ${field('Which year are you currently in at university? *', select('year_of_study', YEARS))}
        ${field('How long do you expect to remain at university? *', select('expected_stay', STAY))}
        ${field('How many years do you have left at university? *', select('years_left', LEFT))}
      </div>
      <div class="card card-pad mb-3">
        <h2 class="ent-h">Food business</h2>
        ${field('Food business name *', text('business_name', 60, "e.g. Mpho's Kitchen", 'text'), 'The name customers will see on ClickFood.')}
        ${field('What will you be selling? *', checks('categories', CATS))}
        ${(f.categories || []).includes('other') ? field('Other food *', text('other_category', 120, 'e.g. Fruit cups', 'text')) : ''}
        ${field('Describe your food business *', area('description', 1000, 'The food you will sell, who your customers are and how you will operate.'))}
        ${field('Why would your business be a good choice for ClickFood students? *', area('why_choose', 1000, 'What makes it different: quality, price, reliability…'))}
        ${field('How will you prepare, store and supply your food safely? *', area('food_safety', 800, 'e.g. where you cook, how food is kept cold or hot, how you package it.'))}
        ${field('Days you expect to sell *', checks('available_days', DAYS))}
        ${field('Times of day', checks('available_periods', PERIODS))}
      </div>
      <div class="card card-pad mb-3">
        <h2 class="ent-h">Before you submit</h2>
        <p class="text-sm mb-2">Read the ${legal('terms', 'Terms of Service')} and the ${legal('privacy', 'Privacy Policy')} (Student Entrepreneur Programme sections).</p>
        ${tick('confirm_accurate', 'My information is true and complete.')}
        ${tick('accept_terms', 'I agree to the Terms of Service, including the Student Entrepreneur Programme terms.')}
        ${tick('ack_privacy', 'I have read the Privacy Policy and understand how my application information is used.')}
        <p class="text-xs text-muted">Submitting does not guarantee approval.</p>
      </div>
      <div class="ent-actions">
        <button type="submit" class="btn btn-primary btn-block btn-lg ${st.busy === 'submit' ? 'btn-loading' : ''}" ${st.busy ? 'disabled' : ''}>Send for Review</button>
        <button type="button" class="btn btn-secondary btn-block ${st.busy === 'draft' ? 'btn-loading' : ''}" data-action="ent-save" ${st.busy ? 'disabled' : ''}>Save as Draft</button>
      </div>
      ${a && a.status === 'draft' && a.updated_at ? `<div class="text-xs text-muted mt-2" id="ent-draft-saved">Draft saved ${esc(U.formatDateTime(a.updated_at))}</div>` : ''}
      ${a && a.status === 'draft' ? `<button type="button" class="btn btn-ghost btn-block btn-sm mt-2" data-action="ent-withdraw">Delete draft</button>` : ''}
    </form>`;
  }

  // ---------------- actions ----------------
  async function save(submit) {
    if (st.busy) return;
    if (!S.state.connection.online) return App.Toast.error('You are offline. Connect to the internet and try again.');
    st.busy = submit ? 'submit' : 'draft'; App.render();
    const { data, error } = await App.sb.rpc('save_entrepreneur_application', { p: st.f, p_submit: !!submit });
    st.busy = false;
    if (error || !data) { App.Toast.error('Could not save. Please try again.'); return App.render(); }
    if (!data.ok) {
      App.Toast.error(data.error || 'Could not save.');
      if (data.needs_email) await load(true); else App.render();
      return;
    }
    if (submit) { st.justSubmitted = true; await load(true); window.scrollTo(0, 0); return; }
    App.Toast.success('Draft saved successfully.');
    await load(false); App.render();
  }
  function withdraw() {
    const draft = st.data && st.data.application && st.data.application.status === 'draft';
    App.Modal.confirm({
      title: draft ? 'Delete your draft?' : 'Withdraw your application?', message: draft ? 'Your answers will be removed.' : 'ClickFood will stop reviewing it. You can apply again later.',
      confirmLabel: draft ? 'Delete' : 'Withdraw', cancelLabel: 'Keep', variant: 'warn',
      onConfirm: async () => {
        const { data, error } = await App.sb.rpc('withdraw_entrepreneur_application');
        if (error || !data || !data.ok) return App.Toast.error((data && data.error) || 'Could not withdraw.');
        st.justSubmitted = false; App.Toast.success(draft ? 'Draft deleted' : 'Application withdrawn');
        await load(true);
      },
    });
  }

  function handleAction(action, ds) {
    if (action === 'ent-save') return save(false);
    if (action === 'ent-withdraw') return withdraw();
    if (action === 'ent-reload') { st.error = null; return load(true); }
    if (action === 'ent-verify') {
      const u = App.Orientation && App.Orientation.Institution ? App.Orientation.Institution.university() : null;
      return App.StudentVerify.open({ universityName: u ? u.name : null, message: `Enter your official ${u ? u.name + ' ' : ''}student email. We will email you a link to confirm it.`, onDone: () => load(true) });
    }
  }
  function handleInput(kind, value, ds) {
    if (kind !== 'ent-field' || !st.f) return;
    st.f[ds.key] = value;
    const c = document.querySelector(`[data-count="${ds.key}"]`);
    if (c) c.textContent = c.textContent.replace(/^\d+/, String(value.length));
  }
  function handleChange(kind, ds, value) {
    if (!st.f) return;
    if (kind === 'ent-field') { st.f[ds.key] = value; if (ds.key === 'population_group') { if (!value || value === 'prefer_not') st.f.population_group_consent = false; App.render(); } return; }
    if (kind === 'ent-flag') { st.f[ds.key] = !!value; return; }
    if (kind === 'ent-toggle') {
      const v = ds.key === 'available_days' ? Number(ds.value) : ds.value;
      const list = (st.f[ds.key] || []).filter(x => String(x) !== String(v));
      if (value) list.push(v);
      st.f[ds.key] = list;
      if (ds.key === 'categories' && ds.value === 'other') App.render();
    }
  }
  function handleSubmit(formId) { if (formId === 'ent-form') return save(true); }

  // the card on the home page and in More
  // the institution of a verified student email (from the programme list)
  function institutionOf(d, email) {
    const dom = String(email || '').split('@')[1];
    const m = (d.programme_domains || []).find(x => x.domain === dom);
    return m ? m.institution : '';
  }

  function card() {
    if (App.Seller && App.Seller.isSeller()) return '';
    const p = S.state.profile;
    if (p && p.role === 'customer' && p.is_student === false) return '';
    return `
    <div class="card card-pad ent-card mb-4">
      <div class="ent-card-icon"><i data-lucide="chef-hat"></i></div>
      <div style="min-width:0;flex:1;">
        <div class="font-bold mb-1">Student Entrepreneurs</div>
        <p class="text-sm mb-3">Are you a university or college student who wants to start or grow your own food business? Apply to become a ClickFood Student Entrepreneur and sell your food to fellow students through the ClickFood platform.</p>
        <button type="button" class="btn btn-primary btn-sm" data-action="ent-open">Apply as a Student Entrepreneur</button>
      </div>
    </div>`;
  }
  function open() {
    if (!S.state.profile) { App.Toast.info('Sign in or create an account to apply.'); S.set({ forceAuthView: true }); return App.Pages.Auth.setTab('signup'); }
    S.setRoute({ view: 'entrepreneur', params: {} });
    window.scrollTo(0, 0);
  }

  return { render, load, reset, status, card, open, handleAction, handleInput, handleChange, handleSubmit };
})();
