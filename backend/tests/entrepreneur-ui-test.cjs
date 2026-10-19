// Browser test of the Student Entrepreneur Programme: sign-up has no Buy/Sell
// choice, the programme card, the UP-email step, the application form (no
// degree/course field), submission, pending applicants can't reach shop
// setup, developer approval, then shop setup pre-filled. Local copy only.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/entrepreneur-ui-test.cjs <path to playwright>
const path = require('path'); const fs = require('fs'); const http = require('http');
const { startEnv } = require('./login-env.cjs');
const PW_PATH = process.argv[2];
const CUST = path.join(__dirname, '../../frontend');
const DEV = path.join(__dirname, '../../../Campus Eats Developer/frontend');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 260)})` : '')]);

(async () => {
  const E = await startEnv({ fnPorts: [8201], dir: 'cfentui', pg: 55781, pgrst: 3621, gw: 3622 });
  const { q } = E; const one = async (s, p) => (await q(s, p)).rows[0];
  let browser; const servers = [];
  try {
    for (const f of ['show_partner_shops.sql', 'payment_options.sql', 'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'shop_locations.sql', 'privacy_legal.sql', 'student_entrepreneurs.sql', 'entrepreneur_single_application.sql']) await q(SQL(f));
    await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
    await q(`update allowed_domains set active = true where domain in ('tuks.co.za', 'tut4life.ac.za')`);
    await q(`grant all on all tables in schema public to service_role`);
    await q(`notify pgrst, 'reload schema'`); await new Promise(r => setTimeout(r, 1500));
    const UP = (await one(`select id from universities where name = 'University of Pretoria'`)).id;
    const setStudent = (id) => q(`update profiles set is_student = true, university = 'University of Pretoria', campus_location = 'Hatfield', home_university_id = $2, home_address = 'Hatfield Square', home_lat = -25.751, home_lng = 28.238 where id = $1`, [id, UP]);
    const gmail = await E.addUser('thandi@gmail.com', 'x', 'customer'); await setStudent(gmail);
    const tuks = await E.addUser('u34567890@tuks.co.za', 'x', 'customer'); await setStudent(tuks);
    const dev = await E.addUser('dev@clickfood.test', 'x', 'developer');
    for (const u of [gmail, tuks]) await q(`insert into legal_acceptances (user_id, document, version) values ($1, 'terms', '2026-10-17.2'), ($1, 'privacy', '2026-10-17.2')`, [u]);

    const { chromium } = require(PW_PATH);
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
    const serve = (root, port) => { const s = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(port); servers.push(s); };
    serve(CUST, 5691); serve(DEV, 5692);
    browser = await chromium.launch();
    async function open(port, user, email, vp) {
      const tok = user ? E.jwt({ sub: user, role: 'authenticated', email, aud: 'authenticated' }) : null;
      const ctx = await browser.newContext({ viewport: vp || { width: 390, height: 844 }, serviceWorkers: 'block' });
      const userObj = user ? { id: user, email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, email_confirmed_at: new Date().toISOString() } : null;
      await ctx.addInitScript(({ tok, userObj }) => { try { localStorage.setItem('clickfud_onboarding_completed', 'true'); if (tok) localStorage.setItem('sb-ctxnwjjpqxecidzblyok-auth-token', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer', expires_in: 7200, expires_at: Math.floor(Date.now() / 1000) + 7200, user: userObj })); } catch (e) {} }, { tok, userObj });
      try { await ctx.routeWebSocket(/supabase\.co/, (ws) => ws.close()); } catch (e) {}
      await ctx.route(/supabase\.co/, async (route) => {
        const req = route.request(); const u = new URL(req.url());
        if (u.pathname.startsWith('/rest/v1/')) {
          const headers = { ...req.headers() }; headers.authorization = 'Bearer ' + (tok && /Bearer eyJ/.test(headers.authorization || '') ? tok : E.jwt({ role: 'anon' })); delete headers.apikey; delete headers.host;
          try { return route.fulfill({ response: await route.fetch({ url: `${E.pgrstUrl}${u.pathname.slice(8)}${u.search}`, headers }) }); } catch (e) { return route.abort(); }
        }
        if (u.pathname.startsWith('/functions/v1/')) return route.fulfill({ json: { ok: true } });
        if (u.pathname.startsWith('/auth/v1/user')) return route.fulfill({ json: userObj || {} });
        return route.fulfill({ json: {} });
      });
      await ctx.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) }));
      const p = await ctx.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message));
      await p.goto(`http://localhost:${port}/`); await p.waitForTimeout(6000);
      p.ctx = ctx; return p;
    }
    const text = (p) => p.evaluate(() => document.body.innerText);
    const toast = (p) => p.evaluate(() => Array.from(document.querySelectorAll('#toast-root > *, .toast')).map(t => t.innerText).join(' | '));
    const noSide = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

    // ---------------- guest: sign-up ----------------
    let p = await open(5691, null);
    await p.evaluate(() => { App.Store.set({ forceAuthView: true }); App.Pages.Auth.setTab('signup'); App.render(); }); await p.waitForTimeout(400);
    let t = await text(p);
    rec('sign-up has no "I want to" / Buy food / Sell food choice', !/I want to|Buy food|Sell food/.test(t) && !(await p.$('input[name="account_type"]')));
    rec('sign-up still has name, email, phone and password', !!(await p.$('#su-name')) && !!(await p.$('#su-email')) && !!(await p.$('#su-password')) && !!(await p.$('#su-password-confirm')));
    await p.ctx.close();

    // ---------------- Gmail customer: card + email step ----------------
    p = await open(5691, gmail, 'thandi@gmail.com');
    t = await text(p);
    rec('the home page shows the Student Entrepreneurs card (inclusive wording)', t.includes('Student Entrepreneurs') && t.includes('Are you a university or college student who wants to start or grow your own food business? Apply to become a ClickFood Student Entrepreneur and sell your food to fellow students through the ClickFood platform.') && t.includes('Apply as a Student Entrepreneur'));
    await p.click('.ent-card [data-action="ent-open"]'); await p.waitForTimeout(1200);
    t = await text(p);
    rec('a Gmail student is asked to verify an official university student email first', t.includes('verify your student email') && /official university student email is required/i.test(t) && !(await p.$('form[data-form="ent-form"]')), t.slice(0, 200));
    await p.click('[data-action="ent-verify"]'); await p.waitForTimeout(1000);
    const uni = await p.evaluate(() => { const s = document.getElementById('sv-university'); return s && s.options[s.selectedIndex].text; });
    rec('the verification box opens with the University of Pretoria chosen', uni === 'University of Pretoria' && (await text(p)).includes('official University of Pretoria student email'), uni);
    await p.evaluate(() => App.Modal.close());
    await p.evaluate(() => App.Store.setRoute({ view: 'sell', params: {} })); await p.waitForTimeout(800);
    rec('the old "Sell" page sends a non-approved student to the programme (no shop form)', !(await p.$('form[data-form="sell-setup-form"]')) && (await text(p)).includes('Student Entrepreneurs'));
    rec('no page errors (Gmail student)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();

    // ---------------- UP student: the form ----------------
    p = await open(5691, tuks, 'u34567890@tuks.co.za');
    await p.evaluate(() => App.Pages.Entrepreneur.open()); await p.waitForTimeout(1500);
    t = await text(p);
    rec('a verified UP student sees the application form', !!(await p.$('form[data-form="ent-form"]')) && t.includes('u34567890@tuks.co.za'));
    const labels = await p.evaluate(() => Array.from(document.querySelectorAll('form[data-form="ent-form"] label')).map(l => l.innerText).join(' | '));
    rec('the year, remaining-time and years-left questions are there', /Which year are you currently in at university/.test(labels) && /How long do you expect to remain at university/.test(labels) && /How many years do you have left/.test(labels));
    rec('no degree, course or subject question', !/degree|course|subject|what are you studying|qualification/i.test(labels), labels.match(/degree|course|subject/i));
    rec('food business questions are there', ['Food business name', 'What will you be selling', 'Describe your food business', 'good choice for ClickFood students', 'prepare, store and supply your food safely', 'Days you expect to sell'].every(s => labels.includes(s)));
    rec('population group is optional and explained', /Population group \(optional\)/.test(labels) && (await text(p)).includes('Never used to approve or reject'));
    rec('the form links the Terms and the Privacy Policy', !!(await p.$('form [data-action="legal-open"][data-id="terms"]')) && !!(await p.$('form [data-action="legal-open"][data-id="privacy"]')));
    rec('the form fits a phone screen (no sideways scroll)', await noSide(p));
    await p.fill('#ent-full_name', 'Thabo Mokoena'); await p.fill('#ent-phone', '072 555 1234');
    await p.selectOption('#ent-year_of_study', 'second'); await p.selectOption('#ent-expected_stay', '3'); await p.selectOption('#ent-years_left', '2');
    await p.fill('#ent-business_name', 'Thabo Kota');
    await p.check('[data-key="categories"][data-value="lunch"]'); await p.check('[data-key="categories"][data-value="snacks"]');
    await p.fill('#ent-description', 'Kotas and chips made fresh every weekday for students around Hatfield campus.');
    await p.fill('#ent-why_choose', 'Big portions at student prices, ready on time between lectures every single day.');
    await p.fill('#ent-food_safety', 'Cooked in my clean flat kitchen, kept hot in insulated boxes, sold the same day.');
    for (const d of ['1', '3', '5']) await p.check(`[data-key="available_days"][data-value="${d}"]`);
    await p.check('[data-key="available_periods"][data-value="midday"]');
    await p.click('[data-action="ent-save"]'); await p.waitForTimeout(1200);
    rec('Save as Draft saves to the database and says so', (await one(`select status, business_name from entrepreneur_applications where user_id = $1`, [tuks])).business_name === 'Thabo Kota' && /Draft saved successfully/.test(await toast(p)), await toast(p));
    const order = await p.evaluate(() => Array.from(document.querySelectorAll('.ent-actions button')).map(b => b.innerText.trim()));
    rec('Save as Draft sits directly under Send for Review', order.join('|') === 'Send for Review|Save as Draft', order.join('|'));
    const rz = await p.evaluate(() => Array.from(document.querySelectorAll('textarea')).map(t => getComputedStyle(t).resize));
    rec('text boxes have no resize handle', rz.length > 0 && rz.every(r => r === 'none'), rz.join());
    await p.reload(); await p.waitForTimeout(6000);
    await p.evaluate(() => App.Pages.Entrepreneur.open()); await p.waitForTimeout(1800);
    const back = await p.evaluate(() => [document.getElementById('ent-business_name').value, document.getElementById('ent-description').value, document.querySelectorAll('[data-key="available_days"]:checked').length]);
    rec('the draft comes back after a reload', back[0] === 'Thabo Kota' && /Kotas and chips/.test(back[1]) && back[2] === 3 && !!(await p.$('#ent-draft-saved')), JSON.stringify(back));
    await p.click('[data-action="ent-save"]'); await p.waitForTimeout(1200);
    rec('saving again updates the same draft (one record)', (await one(`select count(*)::int n from entrepreneur_applications where user_id = $1`, [tuks])).n === 1);
    await p.click('form[data-form="ent-form"] button[type="submit"]'); await p.waitForTimeout(1200);
    rec('submitting without the acknowledgements is refused', /confirm that your information is accurate/.test(await toast(p)) && (await one(`select status from entrepreneur_applications where user_id = $1`, [tuks])).status === 'draft', await toast(p));
    await p.check('[data-key="confirm_accurate"]'); await p.check('[data-key="accept_terms"]'); await p.check('[data-key="ack_privacy"]');
    await p.click('form[data-form="ent-form"] button[type="submit"]'); await p.waitForTimeout(1800);
    t = await text(p);
    const row = await one(`select * from entrepreneur_applications where user_id = $1`, [tuks]);
    rec('submitting shows the success page and saves the application for review', t.includes('Application submitted') && row.status === 'pending_review' && row.categories.sort().join() === 'lunch,snacks' && row.available_days.length === 3 && row.terms_version === '2026-10-17.2', JSON.stringify({ s: row.status }));
    await p.evaluate(() => App.Store.setRoute({ view: 'sell', params: {} })); await p.waitForTimeout(800);
    rec('a PENDING applicant cannot open the shop setup', !(await p.$('form[data-form="sell-setup-form"]')) && (await text(p)).includes('Pending review'));
    rec('no page errors (UP student)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();

    // ---------------- developer approves ----------------
    p = await open(5692, dev, 'dev@clickfood.test');
    await p.evaluate(() => App.Store.setRoute({ view: 'applications', params: {} })); await p.waitForTimeout(1800);
    t = await text(p);
    rec('the developer sees the application in Applications', t.includes('Student Entrepreneur applications') && t.includes('Thabo Kota') && t.includes('Second year'));
    await p.click('[data-action="ent-review"][data-do="approve"]'); await p.waitForTimeout(500);
    await p.click('form[data-form="ent-decision-form"] button[type="submit"]'); await p.waitForTimeout(1500);
    rec('approving works (server function)', (await one(`select status from entrepreneur_applications where user_id = $1`, [tuks])).status === 'approved');
    rec('no page errors (developer)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();

    // ---------------- approved: shop setup ----------------
    p = await open(5691, tuks, 'u34567890@tuks.co.za');
    await p.evaluate(() => App.Pages.Entrepreneur.open()); await p.waitForTimeout(2000);
    const name = await p.evaluate(() => (document.getElementById('ss-name') || {}).value);
    t = await text(p);
    rec('approved: the programme opens shop setup directly, pre-filled with the approved business name', !!(await p.$('form[data-form="sell-setup-form"]')) && name === 'Thabo Kota' && t.includes('Set up your shop') && t.includes('Student Entrepreneur approved'), name);
    rec('shop setup does not ask the application questions again', !(await p.$('#ss-desc')) && !(await p.$('#ss-other')) && !(await p.$('form[data-form="sell-setup-form"] [data-key="categories"]')) && !/Describe your food business|Food you sell \*/.test(t) && t.includes('From your approved application'));
    const sorder = await p.evaluate(() => Array.from(document.querySelectorAll('form[data-form="sell-setup-form"] > button')).map(b => b.innerText.trim()));
    rec('shop setup: Save as Draft directly under Send for Review', sorder.join('|') === 'Send for Review|Save as Draft', sorder.join('|'));
    const gap = await p.evaluate(() => { const b = document.body, w = document.querySelector('.page-wrap'); window.scrollTo(0, 1e6); b.scrollTop = 1e6;
      return { html: document.documentElement.scrollHeight - window.innerHeight, blank: Math.round(b.scrollHeight - (w.getBoundingClientRect().bottom + b.scrollTop)) }; });
    rec('the page ends at the content (no big blank space under it)', gap.html <= 1 && gap.blank <= 140, JSON.stringify(gap));
    await p.fill('#ss-name', 'Thabo Kota Express');
    await p.click('[data-action="sell-setup-draft"]'); await p.waitForTimeout(1200);
    const sd = await one(`select data from shop_setup_drafts where user_id = $1`, [tuks]);
    rec('shop setup Save as Draft saves to the database', !!sd && sd.data.business_name === 'Thabo Kota Express' && /Draft saved successfully/.test(await toast(p)), JSON.stringify(sd && sd.data.business_name));
    await p.reload(); await p.waitForTimeout(6000);
    await p.evaluate(() => App.Store.setRoute({ view: 'sell', params: {} })); await p.waitForTimeout(2000);
    rec('the shop draft comes back after a reload', (await p.evaluate(() => (document.getElementById('ss-name') || {}).value)) === 'Thabo Kota Express' && !!(await p.$('#setup-draft-saved')));
    // a failed save never says it worked
    await p.ctx.route(/rpc\/save_shop_setup_draft/, (r) => r.fulfill({ status: 500, json: { message: 'boom' } }));
    await p.click('[data-action="sell-setup-draft"]'); await p.waitForTimeout(1200);
    rec('a failed draft save shows an error, not success', /Could not save your draft/.test(await toast(p)) && !/Draft saved successfully/.test(await toast(p)), await toast(p));
    await p.ctx.unroute(/rpc\/save_shop_setup_draft/);
    await q(`delete from shop_setup_drafts where user_id = $1`, [tuks]);
    rec('a UP student is asked the hustleUP question', !!(await p.$('#hustleup-field')));
    // the same student approved as a TUT student: no hustleUP question
    await q(`update entrepreneur_applications set university = 'Tshwane University of Technology' where user_id = $1`, [tuks]);
    await p.evaluate(() => { App.Pages.Entrepreneur.reset(); App.Store.setRoute({ view: 'home', params: {} }); });
    await p.waitForTimeout(400);
    await p.evaluate(() => App.Store.setRoute({ view: 'sell', params: {} })); await p.waitForTimeout(1800);
    rec('a student from another institution is not asked about hustleUP', !!(await p.$('form[data-form="sell-setup-form"]')) && !(await p.$('#hustleup-field')) && !/hustleUP/.test(await text(p)));
    await q(`update entrepreneur_applications set university = 'University of Pretoria' where user_id = $1`, [tuks]);
    rec('no page errors (approved student)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();

    // ---------------- campus already chosen: not asked again, and accepted ----------------
    // a Gmail student with a verified UP student email, approved, campus Hatfield in Profile
    await q(`insert into student_verifications (user_id, email, university_id, status, verified_at) values ($1, 'u77777777@tuks.co.za', $2, 'verified', now())`, [gmail, UP]);
    await q(`insert into entrepreneur_applications (user_id, status, business_name, university, submitted_at) values ($1, 'approved', 'Thandi Treats', 'University of Pretoria', now())`, [gmail]);
    p = await open(5691, gmail, 'thandi@gmail.com');
    await p.evaluate(() => App.Store.setRoute({ view: 'sell', params: {} })); await p.waitForTimeout(2000);
    const fixed = await p.evaluate(() => (document.getElementById('ss-campus-fixed') || {}).innerText || '');
    rec('shop setup uses the campus from Profile (shown, not asked again)', /Hatfield/.test(fixed) && !(await p.$('#ss-campus')), fixed);
    await p.click('[data-action="sell-change-campus"]'); await p.waitForTimeout(400);
    rec('...and the student can still change it', !!(await p.$('#ss-campus')) && (await p.evaluate(() => document.getElementById('ss-campus').value)) === 'Hatfield');
    // the database accepts exactly that campus for this student (same institution as the form)
    const made = await p.evaluate(async () => { const { data, error } = await App.sb.rpc('become_student_seller', { p_business_name: 'Thandi Treats', p_whatsapp: '0721234567', p_categories: ['Lunch'], p_other_food: null, p_campus: 'Hatfield',
      p_description: 'Home cooked lunch plates', p_logo_url: null, p_cover_url: 'https://x.supabase.co/storage/v1/object/public/images/a/shop.webp', p_address: 'Tuks Village, Block C', p_lat: -25.7535, p_lng: 28.2295, p_hustleup: false, p_accept_rules: true,
      p_details: { business_type: 'takeaway', contact_phone: '072 123 4567', contact_email: 'thandi@gmail.com', is_registered: false, manager_phone: '072 123 4567', manager_position: 'owner', open_days: [1, 2, 3], opening_time: '08:00', closing_time: '17:00', products_summary: 'Home cooked lunch plates' } });
      return error ? error.message : 'ok'; });
    rec('the shop is saved with that campus (no "Please choose your campus")', made === 'ok' && (await one(`select campus_location c from stores where manager_id = $1`, [gmail])).c === 'Hatfield', made);
    p = await open(5691, tuks, 'u34567890@tuks.co.za');
    await p.evaluate(() => App.Store.setRoute({ view: 'legal', params: { id: 'privacy' } })); await p.waitForTimeout(1500);
    rec('the Privacy Policy covers the programme', (await text(p)).includes('Student Entrepreneur Programme applications'));
    await p.evaluate(() => App.Store.setRoute({ view: 'legal', params: { id: 'terms' } })); await p.waitForTimeout(1500);
    rec('the Terms cover the programme', (await text(p)).includes('Submitting an application does not guarantee approval'));
    await p.ctx.close();
    // desktop
    p = await open(5691, tuks, 'u34567890@tuks.co.za', { width: 1280, height: 900 });
    rec('the card shows on desktop too, no sideways scroll', (await text(p)).includes('Apply as a Student Entrepreneur') && await noSide(p));
    await p.ctx.close();
  } catch (e) { rec('test run', false, e.stack || e.message); }
  if (browser) await browser.close();
  servers.forEach(s => s.close());
  await E.stop();
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})();
