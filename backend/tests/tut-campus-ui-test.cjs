// Browser test of TUT campus features in the customer and developer apps:
// campus chips + empty campus message, explore filter, campus directory,
// sign-up campus list, preferred building, checkout pickup point, developer
// Campus Directory tab. Local copy only, synthetic people and shops.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/tut-campus-ui-test.cjs <path to playwright>
const path = require('path'); const fs = require('fs'); const http = require('http');
const { startEnv } = require('./login-env.cjs');
const PW_PATH = process.argv[2];
const CUST_ROOT = path.join(__dirname, '../../frontend');
const DEV_ROOT = path.join(__dirname, '../../../Campus Eats Developer/frontend');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 260)})` : '')]);

(async () => {
  const E = await startEnv({ fnPorts: [8171], dir: 'cftutui', pg: 55691, pgrst: 3541, gw: 3542 });
  global.__E = E;
  const { q } = E; const one = async (s, p) => (await q(s, p)).rows[0];
  for (const f of ['show_partner_shops.sql', 'payment_options.sql', 'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql']) await q(SQL(f));
  await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
  await q(`update platform_config set show_partner_shops = true where id = 1; update allowed_domains set active = true`);
  await q(`notify pgrst, 'reload schema'`); await new Promise(r => setTimeout(r, 1500));
  const camp = async (code) => (await one(`select id from campuses where code = $1`, [code])).id;
  const mgr = await E.addUser('mgr@shop.test', 'x', 'manager');
  const mkShop = async (name, uni, campus) => (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind)
     values ($1, $2, $3, 'Fast Food', $4, 'Somewhere', $5, 'approved', true, '00:00', '23:59', 'business') returning id`, [mgr, name, name.toLowerCase().replace(/\W+/g, '-'), campus, uni])).id;
  const S = {
    north: await mkShop('North Bites', 'Tshwane University of Technology', 'Soshanguve North'),
    south: await mkShop('South Grill', 'Tshwane University of Technology', 'Soshanguve South'),
    pta: await mkShop('Pretoria Kota', 'Tshwane University of Technology', 'Pretoria'),
    up: await mkShop('UP Wraps', 'University of Pretoria', 'Hatfield'),
    unisa: await mkShop('Unisa Deli', 'University of South Africa', 'Muckleneuk'),
  };
  await q(`update stores set pickup_lat = -25.48, pickup_lng = 28.10 where id = $1`, [S.north]);   // test shop location (synthetic)
  await q(`insert into menu_items (store_id, name, category, price, status, available, stock, image) values ($1, 'North Burger', 'Lunch', 40, 'approved', true, 50, 'https://x/b.webp')`, [S.north]);
  const northLib = (await one(`select id from campus_venues where code = 'tut-sosh-north-library'`)).id;
  await q(`insert into pickup_points (store_id, campus_id, venue_id, name, details, active) values ($1, $2, $3, 'Library entrance', 'Main doors', true)`, [S.north, await camp('tut-soshanguve-north'), northLib]);

  const cust = await E.addUser('222222222@tut4life.ac.za', 'x', 'customer');
  await q(`update profiles set is_student = true, university = 'Tshwane University of Technology', campus_location = 'Soshanguve North', student_number = '222222222', home_address = 'Block H', home_lat = -25.48, home_lng = 28.09 where id = $1`, [cust]);
  rec('setup: TUT student, home TUT, campus Soshanguve North', (await one(`select c.name from profiles p join campuses c on c.id = p.campus_id where p.id = $1`, [cust])).name === 'Soshanguve North');
  const dev = await E.addUser('dev@clickfood.test', 'x', 'developer');

  const { chromium } = require(PW_PATH);
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
  const serve = (root, port) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(port);
  const w1 = serve(CUST_ROOT, 5671), w2 = serve(DEV_ROOT, 5672);
  const browser = await chromium.launch();
  async function open(url, user) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const tok = user ? E.jwt({ sub: user.id, role: 'authenticated', email: user.email, aud: 'authenticated' }) : null;
    const userObj = user ? { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: {}, email_confirmed_at: new Date().toISOString() } : null;
    await ctx.addInitScript(({ tok, userObj }) => { try { localStorage.setItem('clickfud_onboarding_completed', 'true'); if (tok) localStorage.setItem('sb-ctxnwjjpqxecidzblyok-auth-token', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer', expires_in: 7200, expires_at: Math.floor(Date.now() / 1000) + 7200, user: userObj })); } catch (e) {} }, { tok, userObj });
    try { await ctx.routeWebSocket(/supabase\.co/, (ws) => ws.close()); } catch (e) {}
    await ctx.route(/supabase\.co/, async (route) => {
      const req = route.request(); const u = new URL(req.url());
      if (u.pathname.startsWith('/rest/v1/')) {
        const headers = { ...req.headers() }; headers.authorization = 'Bearer ' + (tok && /Bearer eyJ/.test(headers.authorization || '') ? tok : E.jwt({ role: 'anon' })); delete headers.apikey; delete headers.host;
        try { return route.fulfill({ response: await route.fetch({ url: `${E.pgrstUrl}${u.pathname.slice(8)}${u.search}`, headers }) }); } catch (e) { return route.abort(); }
      }
      if (u.pathname.startsWith('/auth/v1/user')) return route.fulfill({ json: userObj || {} });
      return route.fulfill({ json: {} });
    });
    const p = await ctx.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message));
    await p.goto(url); await p.waitForTimeout(6000);
    await p.evaluate(() => { if (App.Modal && App.Modal.isOpen && App.Modal.isOpen()) App.Modal.close(); App.render(); }); await p.waitForTimeout(400);
    p.ctx = ctx; return p;
  }
  const names = (p, sel) => p.evaluate((sel) => Array.from(document.querySelectorAll(sel + ' .store-mini-name')).map(n => n.textContent.trim()), sel);
  const click = async (p, sel) => { await p.click(sel); await p.waitForTimeout(500); };

  // ---------------- customer: TUT student ----------------
  let p = await open('http://localhost:5671/', { id: cust, email: '222222222@tut4life.ac.za' });
  rec('"Shops at TUT" starts on the student\'s own campus (Soshanguve North only)', JSON.stringify(await names(p, '#my-university-section')) === '["North Bites"]', JSON.stringify(await names(p, '#my-university-section')));
  const chips = await p.evaluate(() => Array.from(document.querySelectorAll('[data-action="campus-pick"]')).map(b => b.textContent.trim()));
  rec('campus chips list the six TUT campuses (+ All), nothing outside Tshwane', chips.join('|') === 'All campuses|Pretoria|Arcadia|Arts|Ga-Rankuwa|Soshanguve North|Soshanguve South', chips.join('|'));
  const southId = await camp('tut-soshanguve-south'), artsId = await camp('tut-arts');
  await click(p, `[data-action="campus-pick"][data-id="${southId}"]`);
  rec('Soshanguve South shows only its own shop (North and South never mixed)', JSON.stringify(await names(p, '#my-university-section')) === '["South Grill"]');
  await click(p, `[data-action="campus-pick"][data-id="${artsId}"]`);
  rec('a campus with no shops shows the agreed message', /No active ClickFood shops are available at this campus yet\. Please check back soon\./.test(await p.evaluate(() => document.getElementById('my-university-section').innerText)));
  await click(p, '[data-action="campus-pick"][data-id=""]');
  rec('"All campuses" lists every TUT shop', (await names(p, '#my-university-section')).sort().join() === 'North Bites,Pretoria Kota,South Grill');
  rec('cards show the full campus name', /Tshwane University of Technology · Soshanguve North Campus/.test(await p.evaluate(() => document.body.innerText)));
  // explore other universities (two of them), temporary only
  const unisaId = (await one(`select id from universities where name = 'University of South Africa'`)).id;
  rec('other universities are listed', (await names(p, '#other-universities-section')).sort().join() === 'UP Wraps,Unisa Deli');
  await p.selectOption('select[data-action-change="explore-university"]', unisaId); await p.waitForTimeout(500);
  rec('the explore filter narrows to one university', JSON.stringify(await names(p, '#other-universities-section')) === '["Unisa Deli"]' && /Viewing shops at University of South Africa/.test(await p.evaluate(() => document.body.innerText)));
  await click(p, '[data-action="explore-university-reset"]');
  rec('...and resets', (await names(p, '#other-universities-section')).length === 2);
  const hasLoc = await p.evaluate(() => !!document.querySelector('[data-action="order-mode"][data-mode="current"]'));
  if (hasLoc) { await p.click('[data-action="order-mode"][data-mode="current"]'); await p.waitForTimeout(1500); }
  const locMsg = await p.evaluate(() => [...document.querySelectorAll('#toast-root > *')].map(t => t.innerText).join(' | ') + ' state=' + App.Discovery.locationState());
  rec('"Current location" with permission refused: a clear message, the page keeps working', hasLoc && (/Location is off|Couldn.t get your location/.test(locMsg) && /state=(denied|unavailable)/.test(locMsg)), locMsg);

  // directory
  // (2026-10-17) the dashboard "Campus directory" button was removed at the user's request; the page itself stays
  rec('no Campus directory button on the dashboard', !(await p.$('[data-action="dir-open"]')) && !/Campus directory/.test(await p.evaluate(() => document.body.innerText)));
  await p.evaluate(() => App.Pages.Directory.handleAction('dir-open', { campus: (App.Discovery.myCampus() || {}).id })); await p.waitForTimeout(800);
  let t = await p.evaluate(() => document.body.innerText);
  rec('campus directory opens on Soshanguve North with its address', /Soshanguve North Campus · Aubrey Matlala Drive, Block H, Soshanguve/.test(t), t.slice(0, 200));
  rec('it lists the library and Building 16 iCentres, marked verified, with sources', /Soshanguve North Library/.test(t) && /iCentres, Building 16/.test(t) && /Verified/.test(t) && await p.evaluate(() => document.querySelectorAll('.dir-venue a[href^="https://libraries.tut.ac.za"]').length >= 2));
  rec('pickup points are listed separately', /Pickup points[\s\S]*Library entrance[\s\S]*Buildings and places/.test(t));
  await p.fill('input[data-action-input="dir-search"]', '16'); await p.waitForTimeout(1200);
  t = await p.evaluate(() => Array.from(document.querySelectorAll('.dir-venue .font-bold')).map(x => x.textContent).join('|'));
  rec('search by building number finds Building 16 only', t === 'iCentres, Building 16', t);
  await p.fill('input[data-action-input="dir-search"]', ''); await p.waitForTimeout(800);
  await p.selectOption('select[data-action-change="dir-cat"]', 'library'); await p.waitForTimeout(800);
  t = await p.evaluate(() => Array.from(document.querySelectorAll('.dir-venue .font-bold')).map(x => x.textContent).join('|'));
  rec('category filter shows libraries only', t === 'Soshanguve North Library', t);
  await p.selectOption('select[data-action-change="dir-cat"]', '');
  await p.selectOption('select[data-action-change="dir-campus"]', await camp('tut-pretoria')); await p.waitForTimeout(1000);
  t = await p.evaluate(() => document.body.innerText);
  rec('Pretoria Campus lists its iCentre buildings; the unverified admissions record is hidden', /iCentre, Building 44/.test(t) && /Room 30-117, 30-119/.test(t) && !/Admissions/.test(t));
  await p.screenshot({ path: path.join(__dirname, 'lt', 'tut-directory.png'), fullPage: true });

  // profile: optional building
  await p.evaluate(() => App.Store.setRoute({ view: 'profile', params: {} })); await p.waitForTimeout(1500);
  const opts = await p.evaluate(() => { const s = document.querySelector('select[name="preferred_venue_id"]'); return s ? Array.from(s.options).map(o => o.textContent) : null; });
  rec('Profile offers an optional building from the student\'s campus only', opts && opts[0] === 'None' && opts.some(o => /Soshanguve North Library/.test(o)) && !opts.some(o => /Building 44|Soshanguve South/.test(o)), JSON.stringify(opts));
  await p.selectOption('select[name="preferred_venue_id"]', northLib);
  await click(p, 'form[data-form="profile-form"] button[type="submit"]'); await p.waitForTimeout(1500);
  rec('saving keeps the building', (await one(`select preferred_venue_id v from profiles where id = $1`, [cust])).v === northLib);

  // checkout: the shop's active pickup point
  await p.evaluate(() => { const m = App.Store.state.menu.find(x => x.name === 'North Burger'); App.Pages.Home.addStoreItemToCart(m.id); App.Modal.close(); App.Pages.Customer.handleAction('go-checkout', {}); });
  await p.waitForTimeout(800);
  const ckState = await p.evaluate(() => ({ cart: App.Store.state.cart.length, ck: !!App.Pages.Customer.local.checkout, toast: [...document.querySelectorAll('#toast-root > *')].map(t => t.innerText).join(' | '), view: App.Store.state.route.view }));
  if (!ckState.ck) rec('checkout opened', false, JSON.stringify(ckState));
  else { await p.evaluate(() => { App.Pages.Customer.local.checkout.step = 2; App.render(); }); await p.waitForTimeout(1500); }
  t = await p.evaluate(() => document.body.innerText);
  rec('checkout shows the shop\'s pickup point', /Pickup point \*[\s\S]*Library entrance/.test(t), 'step ' + (await p.evaluate(() => App.Pages.Customer.local.checkout && App.Pages.Customer.local.checkout.step)) + ': ' + t.slice(Math.max(0, t.indexOf('Collection')), Math.max(0, t.indexOf('Collection')) + 400).replace(/\s+/g, ' '));
  rec('no page errors (TUT student)', !p.errs.length, p.errs.join(' | '));
  await p.ctx.close();

  // ---------------- sign-up: TUT campus list ----------------
  p = await open('http://localhost:5671/', null);
  await p.evaluate(() => { App.Store.set({ forceAuthView: true }); App.render(); }); await p.waitForTimeout(500);
  await p.click('[data-action="auth-tab"][data-tab="signup"]').catch(() => {}); await p.waitForTimeout(500);
  // (2026-10-17) sign-up no longer asks for a campus; "Are you a student?" does, after sign-in
  rec('sign-up asks no campus (asked after sign-in)', !(await p.$('#su-campus-options')));
  await p.ctx.close();
  const newbie = { id: await E.addUser('new@gmail.com', 'x', 'customer'), email: 'new@gmail.com' };
  await q(`update profiles set home_address = 'Pretoria', home_lat = -25.73, home_lng = 28.16 where id = $1`, [newbie.id]);
  p = await open('http://localhost:5671/', newbie);
  await p.click('[data-action="student-setup-pick"][data-v="yes"]'); await p.waitForTimeout(400);
  const tutId = await p.evaluate(() => (App.Discovery.universities().find(u => u.name === 'Tshwane University of Technology') || {}).id);
  await p.selectOption('#ss-uni', tutId); await p.waitForTimeout(500);
  const su = await p.evaluate(() => Array.from(document.querySelectorAll('#ss-campus option')).map(o => o.textContent.trim()).filter(x => !/^Choose/.test(x)));
  rec('choosing TUT offers the six campuses by full name', ['Pretoria Campus', 'Arcadia Campus', 'Arts Campus (Arts and Design Learning Site)', 'Ga-Rankuwa Campus', 'Soshanguve North Campus', 'Soshanguve South Campus'].every(c => su.includes(c)) && su.length === 6, su.join('|'));
  const upId = await p.evaluate(() => (App.Discovery.universities().find(u => u.name === 'University of Pretoria') || {}).id);
  await p.selectOption('#ss-uni', upId); await p.waitForTimeout(500);
  const su2 = await p.evaluate(() => Array.from(document.querySelectorAll('#ss-campus option')).map(o => o.textContent.trim()));
  rec('choosing UP gets the UP campuses', su2.includes('Hatfield Campus') && !su2.some(x => /Soshanguve/.test(x)), su2.join('|'));
  rec('no page errors (sign-up)', !p.errs.length, p.errs.join(' | '));
  await p.ctx.close();

  // ---------------- developer: Campus Directory tab ----------------
  p = await open('http://localhost:5672/', { id: dev, email: 'dev@clickfood.test' });
  await p.evaluate(() => App.Store.setRoute({ view: 'campus-directory', params: {} })); await p.waitForTimeout(2000);
  t = await p.evaluate(() => document.body.innerText);
  rec('developer sees every Pretoria record incl. the unverified admissions office', /Central Admissions Office, Building 21/.test(t) && /Unverified/.test(t) && /address not on an official page/.test(t));
  await click(p, '[data-action="cadm-venue"][data-id=""]');
  await p.fill('form[data-form="cadm-venue-form"] input[name="name"]', 'Building 99 test');
  await p.fill('form[data-form="cadm-venue-form"] input[name="building_number"]', '99');
  await click(p, 'form[data-form="cadm-venue-form"] button[type="submit"]'); await p.waitForTimeout(1200);
  rec('developer adds a venue (saved as unverified)', (await one(`select verification v from campus_venues where name = 'Building 99 test'`) || {}).v === 'unverified');
  await p.selectOption('select[data-action-change="cadm-campus"]', await camp('tut-soshanguve-north')); await p.waitForTimeout(1500);
  const ppId = (await one(`select id from pickup_points where name = 'Library entrance'`)).id;
  await click(p, `[data-action="cadm-point-toggle"][data-id="${ppId}"]`);
  await click(p, '#modal-root [data-confirm-ok]'); await p.waitForTimeout(1200);
  rec('developer switches a pickup point off (asks first)', (await one(`select active a from pickup_points where id = $1`, [ppId])).a === false);
  rec('no page errors (developer)', !p.errs.length, p.errs.join(' | '));
  await p.ctx.close();

  await browser.close(); w1.close(); w2.close(); await E.stop();
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch(async e => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); try { if (global.__E) await global.__E.stop(); } catch (_) {} process.exit(1); });
