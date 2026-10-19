// Browser test of the multi-institution upgrade: My Orientation shows the
// student's OWN institution (TUT, UP, Rosebank College), with that
// institution's campuses and buildings, a fallback when a campus has no
// building list, and Google Maps directions with the right campus; shops
// follow the institution rule; non-students have no My Orientation (and
// the page refuses them); Student Entrepreneurs is inclusive; the
// developer manages institutions. Local copy only, synthetic data.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/institutions-ui-test.cjs <path to playwright>
const path = require('path'); const fs = require('fs'); const http = require('http');
const { startEnv } = require('./login-env.cjs');
const PW_PATH = process.argv[2];
const CUST = path.join(__dirname, '../../frontend');
const DEV = path.join(__dirname, '../../../Campus Eats Developer/frontend');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 260)})` : '')]);

(async () => {
  const E = await startEnv({ fnPorts: [8221], dir: 'cfinstui', pg: 55821, pgrst: 3641, gw: 3642 });
  const { q } = E; const one = async (s, p) => (await q(s, p)).rows[0];
  let browser; const servers = [];
  try {
    for (const f of ['show_partner_shops.sql', 'payment_options.sql', 'customer_tools.sql', 'group_payments.sql', 'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'shop_locations.sql', 'privacy_legal.sql', 'student_entrepreneurs.sql', 'order_distance.sql', 'institutions_v2.sql', 'student_shops_open.sql']) await q(SQL(f));
    await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
    await q(`update platform_config set show_partner_shops = true, order_distance_rule = false where id = 1; update allowed_domains set active = true`);
    await q(`notify pgrst, 'reload schema'`); await new Promise(r => setTimeout(r, 1500));
    const U = {}; for (const r of (await q(`select id, short_code from universities`)).rows) U[r.short_code] = r.id;
    const camp = async (code) => (await one(`select id from campuses where code = $1`, [code])).id;
    const student = async (email, uni, code) => {
      const id = await E.addUser(email, 'x', 'customer');
      await q(`update profiles set is_student = true, home_university_id = $2, university = (select name from universities where id = $2), campus_location = (select name from campuses where id = $3),
               home_address = 'Res', home_lat = -25.75, home_lng = 28.2 where id = $1`, [id, U[uni], await camp(code)]);
      await q(`insert into legal_acceptances (user_id, document, version) values ($1, 'terms', public.legal_versions()->>'terms'), ($1, 'privacy', public.legal_versions()->>'privacy')`, [id]);
      return id;
    };
    const tut = await student('tut@gmail.com', 'TUT', 'tut-arcadia');
    const up = await student('up@gmail.com', 'UP', 'up-hatfield');
    const rc = await student('rc@gmail.com', 'RC', 'rc-braamfontein');
    const non = await E.addUser('non@gmail.com', 'x', 'customer');
    await q(`update profiles set is_student = false, home_address = 'Home', home_lat = -25.75, home_lng = 28.2 where id = $1`, [non]);
    await q(`insert into legal_acceptances (user_id, document, version) values ($1, 'terms', public.legal_versions()->>'terms'), ($1, 'privacy', public.legal_versions()->>'privacy')`, [non]);
    const dev = await E.addUser('dev@clickfood.test', 'x', 'developer');
    const mgr = await E.addUser('mgr@shop.test', 'x', 'manager');
    const shop = async (name, uni, loc) => { const id = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, location_type, pickup_lat, pickup_lng)
      values ($1, $2, $3, 'Fast Food', 'X', 'X', $4, 'approved', true, '00:00', '23:59', 'business', $5, -25.75, 28.2) returning id`, [mgr, name, name.toLowerCase().replace(/\W+/g, '-'), uni, loc])).id;
      await q(`insert into menu_items (store_id, name, category, price, status, available, stock, image, description) values ($1, $2, 'Lunch', 40, 'approved', true, 50, 'https://x/i.webp', 'Nice')`, [id, name + ' Meal']); return id; };
    await shop('UP Kota', 'University of Pretoria', 'campus');
    await shop('TUT Grill', 'Tshwane University of Technology', 'campus');
    await shop('Town Pizza', null, 'off_campus');
    // a UP student's own shop (student shops: everyone sees them)
    const seller = await student('u12121212@tuks.co.za', 'UP', 'up-hatfield');
    await q(`insert into entrepreneur_applications (user_id, status, business_name, submitted_at) values ($1, 'approved', 'Mama Bakes', now())`, [seller]);
    const sshop = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, location_type, pickup_lat, pickup_lng)
      values ($1, 'Mama Bakes', 'mama-bakes', 'Student Food', 'Hatfield', 'Res', 'University of Pretoria', 'approved', true, '00:00', '23:59', 'student', 'campus', -25.75, 28.2) returning id`, [seller])).id;
    await q(`insert into menu_items (store_id, name, category, price, status, available, stock, image, description) values ($1, 'Muffin', 'Breakfast', 15, 'approved', true, 50, 'https://x/i.webp', 'Fresh blueberry muffin')`, [sshop]);

    const { chromium } = require(PW_PATH);
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
    const serve = (root, port) => { const s = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(port); servers.push(s); };
    serve(CUST, 5711); serve(DEV, 5712);
    browser = await chromium.launch();
    async function open(port, user, email, vp) {
      const tok = E.jwt({ sub: user, role: 'authenticated', email, aud: 'authenticated' });
      const ctx = await browser.newContext({ viewport: vp || { width: 390, height: 844 }, serviceWorkers: 'block' });
      const userObj = { id: user, email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, email_confirmed_at: new Date().toISOString() };
      await ctx.addInitScript(({ tok, userObj }) => { try { localStorage.setItem('clickfud_onboarding_completed', 'true'); localStorage.setItem('sb-ctxnwjjpqxecidzblyok-auth-token', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer', expires_in: 7200, expires_at: Math.floor(Date.now() / 1000) + 7200, user: userObj })); } catch (e) {} }, { tok, userObj });
      try { await ctx.routeWebSocket(/supabase\.co/, (ws) => ws.close()); } catch (e) {}
      await ctx.route(/supabase\.co/, async (route) => {
        const req = route.request(); const u = new URL(req.url());
        if (u.pathname.startsWith('/rest/v1/')) {
          const headers = { ...req.headers() }; headers.authorization = 'Bearer ' + (/Bearer eyJ/.test(headers.authorization || '') ? tok : E.jwt({ role: 'anon' })); delete headers.apikey; delete headers.host;
          try { return route.fulfill({ response: await route.fetch({ url: `${E.pgrstUrl}${u.pathname.slice(8)}${u.search}`, headers }) }); } catch (e) { return route.abort(); }
        }
        if (u.pathname.startsWith('/auth/v1/user')) return route.fulfill({ json: userObj });
        return route.fulfill({ json: {} });
      });
      const p = await ctx.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message));
      await p.goto(`http://localhost:${port}/`); await p.waitForTimeout(6000);
      p.ctx = ctx; return p;
    }
    const text = (p) => p.evaluate(() => document.body.innerText);
    const go = (p, view) => p.evaluate((v) => App.Store.setRoute({ view: v, params: {} }), view);
    const campusButtons = (p) => p.evaluate(() => Array.from(document.querySelectorAll('[data-action="orientation-select-campus"]')).map(b => b.innerText.trim()));
    const homeShops = (p) => p.evaluate(() => Array.from(document.querySelectorAll('.store-mini-name, .shop-card-name, .store-name')).map(n => n.textContent.trim()));

    // ---------------- TUT student ----------------
    let p = await open(5711, tut, 'tut@gmail.com');
    rec('TUT student: the My Orientation button is in the bottom bar', !!(await p.$('.bottom-nav-fab-orientation')));
    let shops = await p.evaluate(() => App.Stores && (App.Store.state.stores || []).map(s => s.name));
    rec('TUT student: TUT shop, general shop and the UP student\'s shop load; the UP campus business shop does not', shops.includes('TUT Grill') && shops.includes('Town Pizza') && shops.includes('Mama Bakes') && !shops.includes('UP Kota'), JSON.stringify(shops));
    await go(p, 'orientation'); await p.waitForTimeout(1200);
    let t = await text(p);
    rec('TUT student: My Orientation names TUT and opens on their own campus (Arcadia)', t.includes('Tshwane University of Technology') && t.includes('Arcadia') && !!(await p.$('#orientation-search-input')), t.slice(0, 200));
    await p.click('[data-action="orientation-change-campus"]'); await p.waitForTimeout(500);
    const tutCampuses = await campusButtons(p);
    rec('TUT student: the campus list is TUT\'s six campuses, no UP campus', tutCampuses.length === 6 && tutCampuses.includes('Soshanguve North') && !tutCampuses.some(c => /Hatfield|Groenkloof|GIBS/.test(c)), JSON.stringify(tutCampuses));
    await p.click('[data-action="orientation-select-campus"]:has-text("Arcadia")'); await p.waitForTimeout(1200);
    await p.fill('#orientation-search-input', 'library'); await p.waitForTimeout(1200);
    const sug = await p.evaluate(() => Array.from(document.querySelectorAll('[data-action="orientation-select-result"]')).map(b => b.innerText.split('\n')[0]));
    rec('TUT student: searching "library" suggests the TUT Arcadia library (from the campus building list)', sug.some(s => /Arcadia \(Science\) Library/.test(s)) && !sug.some(s => /Merensky/.test(s)), JSON.stringify(sug));
    await p.click('[data-action="orientation-select-result"]'); await p.waitForTimeout(500);
    const url = await p.evaluate(() => { const L = App.Pages.Orientation.local; return App.Orientation.MapsLauncher.buildDirectionsUrl(L.destination, L.campus, null).url; });
    rec('TUT student: directions go to Google Maps with the TUT campus in the destination', /Arcadia%20Campus%2C\+?Tshwane|Arcadia\+Campus%2C\+Tshwane|Arcadia.*Campus.*Tshwane/.test(decodeURIComponent(url).replace(/\+/g, ' ')) && /google\.com\/maps\/dir/.test(url), decodeURIComponent(url));
    rec('no page errors (TUT)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();

    // ---------------- UP student ----------------
    p = await open(5711, up, 'up@gmail.com');
    shops = await p.evaluate(() => (App.Store.state.stores || []).map(s => s.name));
    rec('UP student: UP shop and general shop; the TUT campus shop is hidden', shops.includes('UP Kota') && shops.includes('Town Pizza') && !shops.includes('TUT Grill'), JSON.stringify(shops));
    await go(p, 'orientation'); await p.waitForTimeout(1200);
    t = await text(p);
    rec('UP student: My Orientation names UP and opens on Hatfield', t.includes('University of Pretoria') && t.includes('Hatfield'), t.slice(0, 160));
    await p.fill('#orientation-search-input', 'Merensky'); await p.waitForTimeout(1200);
    const upSug = await p.evaluate(() => Array.from(document.querySelectorAll('[data-action="orientation-select-result"]')).map(b => b.innerText.split('\n')[0]));
    rec('UP student: UP buildings still come up (existing UP building index)', upSug.some(s => /Merensky/.test(s)), JSON.stringify(upSug));
    await p.ctx.close();

    // ---------------- Rosebank College student ----------------
    p = await open(5711, rc, 'rc@gmail.com');
    await go(p, 'orientation'); await p.waitForTimeout(1500);
    t = await text(p);
    rec('Rosebank College student: My Orientation names Rosebank College and opens on Braamfontein', t.includes('Rosebank College') && t.includes('Braamfontein'), t.slice(0, 160));
    rec('...and says honestly there is no building list yet (no pretend map)', !!(await p.$('#orientation-no-buildings')));
    await p.fill('#orientation-search-input', 'Student services'); await p.waitForTimeout(800);
    rec('...Find Directions still works for any typed place', !!(await p.$('[data-action="orientation-find-directions"]')));
    await p.click('[data-action="orientation-change-campus"]'); await p.waitForTimeout(500);
    const rcCampuses = await campusButtons(p);
    rec('...the campus list is Rosebank College\'s eight campuses', rcCampuses.length === 8 && rcCampuses.includes('Polokwane'), JSON.stringify(rcCampuses));
    shops = await p.evaluate(() => (App.Store.state.stores || []).map(s => s.name));
    rec('Rosebank College student: general and student shops only (no UP/TUT campus business shops)', JSON.stringify(shops.sort()) === JSON.stringify(['Mama Bakes', 'Town Pizza']), JSON.stringify(shops));
    await go(p, 'home'); await p.waitForTimeout(800);
    t = await text(p);
    rec('Student Entrepreneurs card is inclusive (no "University of Pretoria" wording)', t.includes('Student Entrepreneurs') && t.includes('Are you a university or college student') && !/University of Pretoria student/.test(t));
    rec('no page errors (Rosebank College)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();

    // ---------------- non-student ----------------
    p = await open(5711, non, 'non@gmail.com');
    rec('non-student: no My Orientation button in the bottom bar', !(await p.$('.bottom-nav-fab-orientation')) && !(await p.$('.bottom-nav-fab')));
    await go(p, 'more'); await p.waitForTimeout(500);
    rec('non-student: My Orientation is not in More', !/My Orientation/.test(await text(p)));
    await go(p, 'profile'); await p.waitForTimeout(800);
    rec('non-student: My Orientation is not on Profile', !/My Orientation/.test(await p.evaluate(() => document.querySelector('.page-wrap').innerText)));
    await go(p, 'orientation'); await p.waitForTimeout(800);
    rec('non-student: opening My Orientation directly is refused with a clear message', (await text(p)).includes('My Orientation is available to student accounts.') && !(await p.$('#orientation-search-input')));
    const venues = await p.evaluate(async () => { const { data, error } = await App.sb.from('campus_venues').select('id'); return error ? 'error' : data.length; });
    rec('non-student: campus building data is refused by the database too', venues === 0 || venues === 'error', String(venues));
    await go(p, 'home'); await p.waitForTimeout(800);
    t = await text(p);
    rec('non-student: no Student Entrepreneurs card; sees student shops and general shops, not campus business shops', !t.includes('Apply as a Student Entrepreneur') && (await p.evaluate(() => JSON.stringify((App.Store.state.stores || []).map(s => s.name).sort()))) === JSON.stringify(['Mama Bakes', 'Town Pizza']), await p.evaluate(() => JSON.stringify((App.Store.state.stores || []).map(s => s.name))));
    const changeRole = await p.evaluate(async () => { const { error } = await App.sb.from('profiles').update({ is_student: true, home_university_id: App.Discovery.universities()[0].id }).eq('id', App.Store.state.profile.id); return error ? error.message : 'changed'; });
    rec('non-student: cannot make themselves a student of an institution with a direct request', /Change your student status/.test(changeRole), changeRole);
    rec('no page errors (non-student)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();

    // ---------------- developer: institutions ----------------
    p = await open(5712, dev, 'dev@clickfood.test', { width: 1280, height: 900 });
    await go(p, 'institutions'); await p.waitForTimeout(2500);
    t = await text(p);
    rec('developer: all five institutions are listed with their settings', ['University of Pretoria', 'Tshwane University of Technology', 'Rosebank College', 'Eduvos', 'University of South Africa'].every(n => t.includes(n)) && t.includes('Registration: on') && t.includes('Student Entrepreneurs: on'));
    await p.fill('#ia-name', 'Boston City Campus'); await p.fill('#ia-code', 'BCC');
    await p.click('form[data-form="ia-new-form"] button[type="submit"]'); await p.waitForTimeout(2000);
    const bcc = await one(`select id, registration_open, active from universities where name = 'Boston City Campus'`);
    rec('developer: a new institution is saved, closed for registration', !!bcc && bcc.registration_open === false && bcc.active === true);
    await p.click('[data-institution="BCC"] [data-action="ia-campus"]'); await p.waitForTimeout(500);
    await p.fill('form[data-form="ia-campus-form"] input[name="name"]', 'Pretoria');
    await p.fill('form[data-form="ia-campus-form"] input[name="source_url"]', 'https://www.bostoncitycampus.ac.za/campuses');
    await p.selectOption('form[data-form="ia-campus-form"] select[name="verification"]', 'verified_current');
    await p.click('form[data-form="ia-campus-form"] button[type="submit"]'); await p.waitForTimeout(1500);
    rec('developer: a campus is added to it', (await one(`select count(*)::int n from campuses where university_id = $1`, [bcc.id])).n === 1);
    await p.fill('[data-institution="BCC"] form[data-form="ia-domain-form"] input[name="domain"]', 'students.bostoncitycampus.ac.za');
    await p.click('[data-institution="BCC"] form[data-form="ia-domain-form"] button[type="submit"]'); await p.waitForTimeout(1500);
    rec('developer: an email domain is added to it', (await one(`select count(*)::int n from allowed_domains where university_id = $1`, [bcc.id])).n === 1);
    await p.click('[data-institution="BCC"] [data-action="ia-toggle"][data-field="registration_open"]'); await p.waitForTimeout(1500);
    rec('developer: registration opens when ready', (await one(`select registration_open from universities where id = $1`, [bcc.id])).registration_open === true);
    await go(p, 'student-sellers'); await p.waitForTimeout(2000);
    t = await p.evaluate(() => (document.getElementById('student-sellers-table') || {}).innerText || '');
    rec('developer: Student Sellers lists student accounts with shops (student details + orders), not business shops', t.includes('Mama Bakes') && t.includes('u12121212@tuks.co.za') && t.includes('University of Pretoria') && t.includes('Student email verified') && !t.includes('Town Pizza') && !t.includes('UP Kota'), t.slice(0, 300));
    rec('no page errors (developer)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();
  } catch (e) { rec('test run', false, e.stack || e.message); }
  if (browser) await browser.close();
  servers.forEach(s => s.close());
  await E.stop();
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})();
