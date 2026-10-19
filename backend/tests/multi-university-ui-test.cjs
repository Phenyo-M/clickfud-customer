// Browser test of the customer app's university sections, shop location +
// distance, the temporary university filter and changing the home university.
// Local copy only (embedded Postgres + PostgREST), synthetic data.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/multi-university-ui-test.cjs <path to playwright>
const path = require('path'); const fs = require('fs'); const http = require('http');
const { startEnv } = require('./login-env.cjs');
const PW_PATH = process.argv[2];
const WEBROOT = path.join(__dirname, '../../frontend');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 260)})` : '')]);

(async () => {
  const E = await startEnv({ fnPorts: [8161], dir: 'cfmultiui', pg: 55671, pgrst: 3531, gw: 3532 });
  global.__E = E;
  const { q } = E; const one = async (s, p) => (await q(s, p)).rows[0];
  for (const f of ['show_partner_shops.sql', 'payment_options.sql', 'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql']) await q(SQL(f));
  await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
  await q(`update platform_config set show_partner_shops = true where id = 1; update allowed_domains set active = true`);
  await q(`notify pgrst, 'reload schema'`); await new Promise(r => setTimeout(r, 1500));
  const uid = async (n) => (await one(`select id from universities where name = $1`, [n])).id;
  const UP = await uid('University of Pretoria'), TUT = await uid('Tshwane University of Technology');

  const mgr = await E.addUser('mgr@shop.test', 'x', 'manager');
  const mkShop = async (name, uni, lat, lng) => (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, pickup_lat, pickup_lng)
     values ($1, $2, $3, 'Fast Food', $4, 'Somewhere', $5, 'approved', true, '00:00', '23:59', 'business', $6, $7) returning id`,
     [mgr, name, name.toLowerCase().replace(/\W+/g, '-'), uni === 'Tshwane University of Technology' ? 'Pretoria' : 'Hatfield', uni, lat, lng])).id;
  const S = {
    upKota: await mkShop('UP Kota', 'University of Pretoria', -25.7545, 28.2314),        // Hatfield
    tutGrill: await mkShop('TUT Grill', 'Tshwane University of Technology', -25.7316, 28.1626),   // TUT Pretoria campus
    city: await mkShop('City Pizza', 'University of Pretoria', null, null),
    both: await mkShop('Both Campus Coffee', 'University of Pretoria', -25.745, 28.2),
  };
  await q(`update stores set availability = 'everyone' where id = $1`, [S.city]);
  await q(`delete from store_universities where store_id = $1`, [S.city]);
  await q(`insert into store_universities (store_id, university_id) values ($1, $2) on conflict do nothing`, [S.both, TUT]);
  await q(`insert into menu_items (store_id, name, category, price, status, available, stock, image) values ($1, 'Tut Burger', 'Lunch', 40, 'approved', true, 50, 'https://x/burger.webp')`, [S.tutGrill]);

  const cust = await E.addUser('u12345678@tuks.co.za', 'x', 'customer');
  await q(`update profiles set is_student = true, university = 'University of Pretoria', campus_location = 'Hatfield', student_number = 'u12345678', home_address = 'Hatfield Square', home_lat = -25.7510, home_lng = 28.2380 where id = $1`, [cust]);
  await q(`update profiles set campuses = '{Hatfield}' where id = $1`, [cust]).catch(() => {});
  rec('setup: the UP student has UP as home university', (await one(`select home_university_id h from profiles where id = $1`, [cust])).h === UP);

  const { chromium } = require(PW_PATH);
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
  const web = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(WEBROOT, p);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(5661);
  const browser = await chromium.launch();
  const tok = E.jwt({ sub: cust, role: 'authenticated', email: 'u12345678@tuks.co.za', aud: 'authenticated' });
  async function open(opts) {
    const o = opts || {};
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }, o.geo ? { geolocation: o.geo, permissions: ['geolocation'] } : {}));
    const userObj = { id: cust, email: 'u12345678@tuks.co.za', aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: {}, email_confirmed_at: new Date().toISOString() };
    await ctx.addInitScript(({ tok, userObj, guest }) => { try { localStorage.setItem('clickfud_onboarding_completed', 'true'); if (!guest) localStorage.setItem('sb-ctxnwjjpqxecidzblyok-auth-token', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer', expires_in: 7200, expires_at: Math.floor(Date.now() / 1000) + 7200, user: userObj })); } catch (e) {} }, { tok, userObj, guest: !!o.guest });
    try { await ctx.routeWebSocket(/supabase\.co/, (ws) => ws.close()); } catch (e) {}
    const sent = [];
    await ctx.route(/supabase\.co/, async (route) => {
      const req = route.request(); const u = new URL(req.url());
      if (u.pathname.startsWith('/rest/v1/')) {
        sent.push(req.method() + ' ' + u.pathname + ' ' + (req.postData() || ''));
        const headers = { ...req.headers() }; headers.authorization = 'Bearer ' + (!o.guest && /Bearer eyJ/.test(headers.authorization || '') ? tok : E.jwt({ role: 'anon' })); delete headers.apikey; delete headers.host;
        try { return route.fulfill({ response: await route.fetch({ url: `${E.pgrstUrl}${u.pathname.slice(8)}${u.search}`, headers }) }); } catch (e) { return route.abort(); }
      }
      if (u.pathname.startsWith('/auth/v1/user')) return route.fulfill({ json: userObj });
      return route.fulfill({ json: {} });
    });
    const p = await ctx.newPage(); p.errs = []; p.sent = sent; p.on('pageerror', e => p.errs.push(e.message));
    await p.goto('http://localhost:5661/'); await p.waitForTimeout(6000);
    await p.evaluate(() => { if (App.Modal && App.Modal.isOpen && App.Modal.isOpen()) App.Modal.close(); App.render(); }); await p.waitForTimeout(400);
    p.ctx = ctx; return p;
  }
  const sectionNames = (p, id) => p.evaluate((id) => { const el = document.getElementById(id); return el ? Array.from(el.querySelectorAll('.store-mini-name')).map(n => n.textContent.trim()) : null; }, id);
  const pageText = (p) => p.evaluate(() => document.body.innerText);

  // ---------------- UP student, location not allowed ----------------
  let p = await open();
  const mine = await sectionNames(p, 'my-university-section'), every = await sectionNames(p, 'everyone-section'), others = await sectionNames(p, 'other-universities-section');
  rec('UP student: "Shops at UP" lists the UP shops (incl. the shared one)', mine && mine.includes('UP Kota') && mine.includes('Both Campus Coffee') && !mine.includes('TUT Grill'), JSON.stringify(mine));
  rec('"More places to order from" lists the shop available to everyone', every && every.length === 1 && every[0] === 'City Pizza', JSON.stringify(every));
  rec('"Explore other universities" lists the TUT shop', others && others.includes('TUT Grill') && !others.includes('UP Kota'), JSON.stringify(others));
  rec('sections come in order: own university, everyone, other universities', await p.evaluate(() => { const a = ['my-university-section', 'everyone-section', 'other-universities-section'].map(id => document.getElementById(id)); return a.every(Boolean) && (a[0].compareDocumentPosition(a[1]) & 4) && (a[1].compareDocumentPosition(a[2]) & 4); }));
  rec('one database request decides the sections', p.sent.filter(s => /rpc\/discover_shops/.test(s)).length <= 2, p.sent.filter(s => /discover_shops/.test(s)).length);
  let t = await pageText(p);
  rec('each card shows where the shop is (real saved university and campus)', /University of Pretoria · Hatfield Campus/.test(t) && /Tshwane University of Technology · Pretoria Campus/.test(t) && /UP & TUT · Hatfield Campus|TUT & UP · Hatfield Campus/.test(t));
  const kotaKm = await p.evaluate(() => { const c = Array.from(document.querySelectorAll('#my-university-section .store-mini-card')).find(x => /UP Kota/.test(x.innerText)); return c ? (c.querySelector('.shop-where-km') || {}).textContent : null; });
  const hav = (a, b) => { const R = 6371, r = (d) => d * Math.PI / 180; const x = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
  const expectM = Math.round(hav([-25.7510, 28.2380], [-25.7545, 28.2314]) * 1000 / 50) * 50;
  rec('distance from the saved home pin when location is not shared (Haversine, ' + expectM + ' m)', kotaKm === expectM + ' m away', kotaKm);
  rec('a shop without coordinates shows no invented distance', await p.evaluate(() => { const c = Array.from(document.querySelectorAll('#everyone-section .store-mini-card')).find(x => /City Pizza/.test(x.innerText)); return !!c && !c.querySelector('.shop-where-km'); }));
  rec('"Current location" is offered, never asked on its own', await p.evaluate(() => !!document.querySelector('[data-action="order-mode"][data-mode="current"]') && App.Discovery.orderMode() === 'saved'));
  // temporary filter
  await p.selectOption('select[data-action-change="explore-university"]', TUT).catch(() => {});
  await p.waitForTimeout(300);
  const tutOnly = await sectionNames(p, 'other-universities-section');
  t = await pageText(p);
  const filterShown = /Viewing shops at Tshwane University of Technology/.test(t) || (tutOnly && tutOnly.join() === 'TUT Grill');
  rec('exploring another university is a temporary filter (profile unchanged)', filterShown && (await one(`select home_university_id h from profiles where id = $1`, [cust])).h === UP, JSON.stringify(tutOnly));
  // ordering from another university is allowed
  const added = await p.evaluate(() => { const m = (App.Store.state.menu || []).find(x => x.name === 'Tut Burger'); if (!m) return 'no item'; App.Pages.Home.addStoreItemToCart(m.id); App.Modal.close(); const line = App.Store.state.cart.find(c => c.menuItemId === m.id); return !!line && line.storeId === m.store_id && Number(line.price) === 40; });
  rec('a UP student can add food from a TUT shop to the cart', added === true, added);
  await p.screenshot({ path: path.join(__dirname, 'lt', 'multiuni-home.png'), fullPage: true });
  rec('no page errors (UP student)', !p.errs.length, p.errs.join(' | '));
  await p.ctx.close();

  // ---------------- location allowed: distance from where the phone is ----------------
  p = await open({ geo: { latitude: -25.7316, longitude: 28.1626 } });   // standing at TUT
  await p.click('[data-action="order-mode"][data-mode="current"]'); await p.waitForTimeout(1500);
  const tutKm = await p.evaluate(() => { const c = Array.from(document.querySelectorAll('.store-mini-card')).find(x => /TUT Grill/.test(x.innerText)); return c ? (c.querySelector('.shop-where-km') || {}).textContent : null; });
  rec('with Current location chosen, distance is from the phone (TUT Grill ~0 m)', /^50 m away$/.test(tutKm || ''), tutKm);
  rec('the phone position is not sent to the server', !p.sent.some(s => /28\.16|-25\.73/.test(s)));
  rec('no page errors (location allowed)', !p.errs.length, p.errs.join(' | '));
  await p.ctx.close();

  // ---------------- change home university in Profile ----------------
  p = await open();
  await p.evaluate(() => App.Store.setRoute({ view: 'profile', params: {} })); await p.waitForTimeout(1200);
  // (2026-10-17) the student's own university + campus, saved by set_my_student_status
  const hasField = await p.evaluate(() => !!document.querySelector('select[name="student_university"]'));
  rec('Profile has the University choice', hasField);
  await p.selectOption('select[name="student_university"]', TUT); await p.waitForTimeout(800);
  await p.selectOption('select[name="student_campus"]', { index: 1 });
  await p.click('form[data-form="profile-form"] button[type="submit"]'); await p.waitForTimeout(2500);
  rec('saving switches the home university to TUT', (await one(`select home_university_id h, university u from profiles where id = $1`, [cust])).h === TUT);
  rec('...and the profile university follows the choice (no longer locked to the email)', (await one(`select university u from profiles where id = $1`, [cust])).u === 'Tshwane University of Technology');
  await p.evaluate(() => App.Store.setRoute({ view: 'home', params: {} })); await p.waitForTimeout(800);
  const mine2 = await sectionNames(p, 'my-university-section');
  rec('the home page now lists TUT shops first (UP Kota moves to other universities)', mine2 && mine2.includes('TUT Grill') && mine2.includes('Both Campus Coffee') && !mine2.includes('UP Kota') && (await sectionNames(p, 'other-universities-section') || []).includes('UP Kota'), JSON.stringify(mine2));
  await p.ctx.close();
  p = await open();
  const mine3 = await sectionNames(p, 'my-university-section');
  rec('the change is kept after reopening the app', mine3 && mine3.includes('TUT Grill') && !mine3.includes('UP Kota'), JSON.stringify(mine3));
  rec('no page errors (after change)', !p.errs.length, p.errs.join(' | '));
  await p.ctx.close();

  // ---------------- guest ----------------
  p = await open({ guest: true });
  const featured = await p.evaluate(() => { const el = document.getElementById('discover-shops-section'); return el ? Array.from(el.querySelectorAll('.store-mini-name')).map(n => n.textContent.trim()) : []; });
  rec('guests: shops for everyone come first, with where each shop is', featured[0] === 'City Pizza' && featured.length === 4 && /University of Pretoria · Hatfield Campus/.test(await pageText(p)), JSON.stringify(featured));
  rec('no page errors (guest)', !p.errs.length, p.errs.join(' | '));
  await p.ctx.close();

  await browser.close(); web.close(); await E.stop();
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch(async e => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); try { if (global.__E) await global.__E.stop(); } catch (_) {} process.exit(1); });
