// Browser test of the map place search (js/map-picker.js): search an
// address, pick a result, the pin goes THERE (not to the phone's position),
// the empty address box is filled, Enter and the clear X never submit the
// form around the map, and the place is saved. Customer saved location +
// manager Shop Settings. OpenStreetMap search is answered by a stand-in.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/map-search-ui-test.cjs <path to playwright>
const path = require('path'); const fs = require('fs'); const http = require('http');
const { startEnv } = require('./login-env.cjs');
const PW_PATH = process.argv[2];
const CUST = path.join(__dirname, '../../frontend');
const STAFF = path.join(__dirname, '../../../Campus Eats Staff/frontend');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 260)})` : '')]);
const PLACE = { lat: '-25.74870', lon: '28.23710', display_name: 'Hatfield Plaza, 1122 Burnett Street, Hatfield, Pretoria, Gauteng, 0083, South Africa' };

(async () => {
  const E = await startEnv({ fnPorts: [8231], dir: 'cfmapui', pg: 55841, pgrst: 3651, gw: 3652 });
  const { q } = E; const one = async (s, p) => (await q(s, p)).rows[0];
  let browser; const servers = [];
  try {
    for (const f of ['show_partner_shops.sql', 'payment_options.sql', 'customer_tools.sql', 'group_payments.sql', 'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'shop_locations.sql', 'privacy_legal.sql', 'student_entrepreneurs.sql', 'order_distance.sql', 'institutions_v2.sql', 'student_shops_open.sql']) await q(SQL(f));
    await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
    await q(`notify pgrst, 'reload schema'`); await new Promise(r => setTimeout(r, 1500));
    const cust = await E.addUser('non@gmail.com', 'x', 'customer');
    await q(`update profiles set is_student = false, home_address = 'Old place', home_lat = -26.2, home_lng = 28.04 where id = $1`, [cust]);
    await q(`insert into legal_acceptances (user_id, document, version) values ($1, 'terms', public.legal_versions()->>'terms'), ($1, 'privacy', public.legal_versions()->>'privacy')`, [cust]);
    const mgr = await E.addUser('mgr@shop.test', 'x', 'manager');
    const shop = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, location_type, logo_url, cover_image_url)
      values ($1, 'Town Grill', 'town-grill', 'Fast Food', '', 'x', null, 'approved', true, '00:00', '23:59', 'business', 'campus', 'https://x/l.webp', 'https://x/c.webp') returning id`, [mgr])).id;
    await q(`update stores set location_type = 'campus', university = 'University of Pretoria', campus_location = 'Hatfield', address = '' where id = $1`, [shop]).catch(() => {});
    await q(`update profiles set store_id = $1 where id = $2`, [shop, mgr]);

    const { chromium } = require(PW_PATH);
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
    const serve = (root, port) => { const s = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(port); servers.push(s); };
    serve(CUST, 5721); serve(STAFF, 5722);
    browser = await chromium.launch();
    const searches = [];
    async function open(port, user, email) {
      const tok = E.jwt({ sub: user, role: 'authenticated', email, aud: 'authenticated' });
      // the phone is somewhere else entirely (a taxi in Johannesburg): the pin must NOT go here
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', geolocation: { latitude: -26.1, longitude: 28.05 }, permissions: ['geolocation'] });
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
      await ctx.route(/nominatim\.openstreetmap\.org/, (route) => { const u = new URL(route.request().url()); searches.push(u.searchParams.get('q') + '|' + u.searchParams.get('countrycodes')); return route.fulfill({ json: /nothing/.test(u.searchParams.get('q')) ? [] : [PLACE] }); });
      await ctx.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) }));
      const p = await ctx.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message));
      await p.goto(`http://localhost:${port}/`); await p.waitForTimeout(6000);
      p.ctx = ctx; return p;
    }

    // ---------------- customer: saved location ----------------
    let p = await open(5721, cust, 'non@gmail.com');
    await p.evaluate(() => App.Store.setRoute({ view: 'profile', params: {} })); await p.waitForTimeout(800);
    await p.click('[data-action="change-address"]'); await p.waitForTimeout(1500);
    await p.waitForSelector('#addr-modal-map .map-picker-q', { timeout: 15000 });
    rec('the location box has a place search above the map', !!(await p.$('#addr-modal-map .map-picker-go')));
    await p.fill('#ad-text', '');
    await p.fill('#addr-modal-map .map-picker-q', 'Hatfield Plaza');
    await p.press('#addr-modal-map .map-picker-q', 'Enter'); await p.waitForTimeout(1200);
    rec('Enter searches (and does not save the form)', searches.some(s => s.startsWith('Hatfield Plaza|za')) && (await one(`select home_address from profiles where id = $1`, [cust])).home_address === 'Old place', JSON.stringify(searches));
    const res = await p.evaluate(() => Array.from(document.querySelectorAll('#addr-modal-map .map-picker-result')).map(b => b.innerText));
    rec('results are listed (South Africa only)', res.length === 1 && /Hatfield Plaza/.test(res[0]), JSON.stringify(res));
    await p.click('#addr-modal-map .map-picker-result'); await p.waitForTimeout(600);
    rec('picking a result fills the empty address box', (await p.evaluate(() => document.getElementById('ad-text').value)) === 'Hatfield Plaza, 1122 Burnett Street, Hatfield');
    await p.click('form[data-form="address-form"] button[type="submit"]'); await p.waitForTimeout(1500);
    const prof = await one(`select home_address, home_lat, home_lng from profiles where id = $1`, [cust]);
    rec('the saved pin is the searched place, not where the phone is', Math.abs(prof.home_lat - (-25.7487)) < 1e-4 && Math.abs(prof.home_lng - 28.2371) < 1e-4 && prof.home_address.startsWith('Hatfield Plaza'), JSON.stringify(prof));
    await p.click('[data-action="change-address"]'); await p.waitForTimeout(1500);
    await p.waitForSelector('#addr-modal-map .map-picker-q', { timeout: 15000 });
    await p.fill('#addr-modal-map .map-picker-q', 'nothing here'); await p.click('#addr-modal-map .map-picker-go'); await p.waitForTimeout(1000);
    rec('no results: a clear message', /No places found/.test(await p.evaluate(() => document.querySelector('#addr-modal-map .map-picker-results').innerText)));
    rec('no page errors (customer)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();

    // ---------------- manager: shop location ----------------
    p = await open(5722, mgr, 'mgr@shop.test');
    await p.evaluate(() => App.Store.setRoute({ view: 'store', params: {} })); await p.waitForTimeout(2000);
    await p.click('[data-action="loc-type"][data-v="off_campus"]');
    await p.fill('#loc-address', '');
    await p.waitForSelector('#store-map .map-picker-q', { timeout: 15000 });
    await p.fill('#store-map .map-picker-q', 'Hatfield Plaza'); await p.press('#store-map .map-picker-q', 'Enter'); await p.waitForTimeout(1200);
    rec('manager: Enter in the map search does not save Shop Settings', (await one(`select location_type from stores where id = $1`, [shop])).location_type === 'campus');
    await p.click('#store-map .map-picker-result'); await p.waitForTimeout(600);
    const lat = await p.evaluate(() => document.getElementById('loc-lat').value);
    rec('manager: picking the result sets the shop pin to it and fills the address', Math.abs(Number(lat) - (-25.7487)) < 1e-4 && (await p.evaluate(() => document.getElementById('loc-address').value)).startsWith('Hatfield Plaza'), lat);
    await p.click('form[data-form="store-form"] button[type="submit"]'); await p.waitForTimeout(1500);
    const st = await one(`select location_type, pickup_lat, pickup_lng, address from stores where id = $1`, [shop]);
    rec('manager: the shop is saved at the searched place (not the phone\'s position)', st.location_type === 'off_campus' && Math.abs(st.pickup_lat - (-25.7487)) < 1e-4 && st.address.startsWith('Hatfield Plaza'), JSON.stringify(st));
    rec('no page errors (manager)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();
  } catch (e) { rec('test run', false, e.stack || e.message); }
  if (browser) await browser.close();
  servers.forEach(s => s.close());
  await E.stop();
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})();
