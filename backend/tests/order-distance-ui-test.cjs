// Browser test of the ordering location + distance rule: the "Ordering from"
// bar (saved university area / current location), Near you sorted by
// distance and limited to 30 km, a far shop labelled and blocked, the
// "no eligible shops" message when travelling, switching back to the saved
// location, checkout showing the location and pickup address and saving the
// order with mode + km only, "Suggest my campus", the campus check on the
// saved location, and the developer's distance + campus pin tools.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/order-distance-ui-test.cjs <path to playwright>
const path = require('path'); const fs = require('fs'); const http = require('http');
const { startEnv } = require('./login-env.cjs');
const PW_PATH = process.argv[2];
const CUST = path.join(__dirname, '../../frontend');
const DEV = path.join(__dirname, '../../../Campus Eats Developer/frontend');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 260)})` : '')]);
const KM_PER_DEG = 6371.0088 * Math.PI / 180;

(async () => {
  const E = await startEnv({ fnPorts: [8211], dir: 'cfdistui', pg: 55801, pgrst: 3631, gw: 3632 });
  const { q } = E; const one = async (s, p) => (await q(s, p)).rows[0];
  let browser; const servers = [];
  try {
    for (const f of ['show_partner_shops.sql', 'payment_options.sql', 'customer_tools.sql', 'group_payments.sql', 'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'shop_locations.sql', 'privacy_legal.sql', 'student_entrepreneurs.sql', 'order_distance.sql']) await q(SQL(f));
    await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
    await q(`update platform_config set show_partner_shops = true where id = 1; update allowed_domains set active = true`);
    await q(`notify pgrst, 'reload schema'`); await new Promise(r => setTimeout(r, 1500));
    const UP = (await one(`select id from universities where name = 'University of Pretoria'`)).id;
    const HAT = (await one(`select id from campuses where code = 'up-hatfield'`)).id;
    const H = { lat: -25.7545, lng: 28.2314 };
    await q(`update campuses set latitude = $1, longitude = $2 where id = $3`, [H.lat, H.lng, HAT]);   // test pin (live pins are set by a developer with a source)
    const north = (km) => H.lat + km / KM_PER_DEG;
    const mgr = await E.addUser('mgr@shop.test', 'x', 'manager');
    const mkShop = async (name, lat, lng) => (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, pickup_lat, pickup_lng)
      values ($1, $2, $3, 'Fast Food', 'Hatfield', $4, 'University of Pretoria', 'approved', true, '00:00', '23:59', 'business', $5, $6) returning id`, [mgr, name, name.toLowerCase().replace(/\W+/g, '-'), name + ' counter, Hatfield', lat, lng])).id;
    const S = { two: await mkShop('Two Km Kota', north(2), H.lng), ten: await mkShop('Ten Km Grill', north(10), H.lng), far: await mkShop('Far Pizza', north(31), H.lng), nopin: await mkShop('No Pin Cafe', null, null) };
    for (const id of Object.values(S)) await q(`insert into menu_items (store_id, name, category, price, status, available, stock, image, description) values ($1, 'Burger', 'Lunch', 45, 'approved', true, 50, 'https://x/i.webp', 'Nice')`, [id]);
    const cust = await E.addUser('thandi@gmail.com', 'x', 'customer');
    await q(`update profiles set is_student = true, university = 'University of Pretoria', campus_location = 'Hatfield', home_university_id = $2, home_address = 'Hatfield Square', home_lat = $3, home_lng = $4 where id = $1`, [cust, UP, H.lat, H.lng]);
    const fresh = await E.addUser('new@gmail.com', 'x', 'customer');
    const dev = await E.addUser('dev@clickfood.test', 'x', 'developer');
    for (const u of [cust, fresh]) await q(`insert into legal_acceptances (user_id, document, version) values ($1, 'terms', public.legal_versions()->>'terms'), ($1, 'privacy', public.legal_versions()->>'privacy')`, [u]);

    const { chromium } = require(PW_PATH);
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
    const serve = (root, port) => { const s = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(port); servers.push(s); };
    serve(CUST, 5701); serve(DEV, 5702);
    browser = await chromium.launch();
    async function open(port, user, email, geo) {
      const tok = E.jwt({ sub: user, role: 'authenticated', email, aud: 'authenticated' });
      const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }, geo ? { geolocation: geo, permissions: ['geolocation'] } : {}));
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
      await ctx.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) }));
      const p = await ctx.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message));
      await p.goto(`http://localhost:${port}/`); await p.waitForTimeout(6000);
      p.ctx = ctx; return p;
    }
    const text = (p) => p.evaluate(() => document.body.innerText);
    const toast = (p) => p.evaluate(() => Array.from(document.querySelectorAll('#toast-root > *, .toast')).map(t => t.innerText).join(' | '));
    const near = (p) => p.evaluate(() => { const el = document.getElementById('near-you-section'); return el ? Array.from(el.querySelectorAll('.store-mini-name')).map(n => n.textContent.trim()) : null; });

    // ---------------- saved university-area location ----------------
    let p = await open(5701, cust, 'thandi@gmail.com', { latitude: -29.85, longitude: 31.02 });   // phone in Durban
    let t = await text(p);
    rec('the "Ordering from" bar shows the saved university area as active', /Ordering from/.test(t) && (await p.$eval('[data-action="order-mode"][data-mode="saved"]', b => b.classList.contains('active'))) && t.includes('Hatfield Square'));
    rec('...with the rule shown (30 km)', t.includes('You can order from shops within 30 km of this location.'));
    let n = await near(p);
    rec('Near you: eligible shops nearest first, the 31 km shop and the shop without a pin left out', JSON.stringify(n) === JSON.stringify(['Two Km Kota', 'Ten Km Grill']), JSON.stringify(n));
    rec('approximate distances are shown', /2 km away|2\.0 km away|1\.9 km away|2\.1 km away/.test(await p.evaluate(() => document.getElementById('near-you-section').innerText)));
    rec('the far shop is labelled "Too far to order" and the shop without a pin "Location not set"', t.includes('Too far to order (31.0 km)') && t.includes('Location not set'));
    // travelling: current location (Durban)
    await p.click('[data-action="order-mode"][data-mode="current"]'); await p.waitForTimeout(1500);
    t = await text(p);
    rec('switching to Current location uses the phone (shown as active)', (await p.$eval('[data-action="order-mode"][data-mode="current"]', b => b.classList.contains('active'))) && t.includes('Your current location'));
    rec('far from Pretoria: the friendly "no eligible shops within 30 km" message', t.includes('Sorry, there are no eligible ClickFood shops within 30 km of your selected location. Try choosing another eligible location or check back later.'));
    await p.click('[data-action="order-mode"][data-mode="saved"]'); await p.waitForTimeout(800);
    rec('switching back to the saved university area brings the shops back (not pretending they are on campus)', JSON.stringify(await near(p)) === JSON.stringify(['Two Km Kota', 'Ten Km Grill']) && (await text(p)).includes('Saved university area'));
    // far shop page
    await p.evaluate((id) => App.Store.setRoute({ view: 'store', params: { storeId: id } }), S.far); await p.waitForTimeout(800);
    rec('the far shop page explains it can\'t take your order and offers to change location', (await text(p)).includes('This shop is 31.0 km from your saved location. You can order from shops within 30 km.'));
    // checkout gate (client) for the far shop
    const added = await p.evaluate((id) => { const m = App.Store.state.menu.find(x => x.store_id === id); return m ? App.Store.addToCart({ menuItemId: m.id, storeId: id, name: m.name, price: Number(m.price), qty: 1, addons: [], specialInstructions: '', image: m.image }) : false; }, S.far);
    await p.evaluate(() => App.Pages.Customer.handleAction('go-checkout', {})); await p.waitForTimeout(800);
    rec('checkout refuses the far shop with the reason', added === true && (await p.evaluate(() => App.Store.state.route.view)) !== 'checkout' && /31\.0 km from your saved location/.test(await toast(p)), (await toast(p)) + ' cart=' + added);
    await p.evaluate(() => App.Store.clearCart());
    // checkout for the 10 km shop: shows the ordering location + pickup address; the order keeps mode + km only
    await p.evaluate((id) => { const m = App.Store.state.menu.find(x => x.store_id === id); return m ? App.Store.addToCart({ menuItemId: m.id, storeId: id, name: m.name, price: Number(m.price), qty: 1, addons: [], specialInstructions: '', image: m.image }) : false; }, S.ten);
    await p.evaluate(() => App.Pages.Customer.handleAction('go-checkout', {}));
    await p.waitForTimeout(600);
    const started = await p.evaluate(() => App.Store.state.route.view === 'checkout' && !!App.Pages.Customer.local.checkout);
    rec('checkout opens for the 10 km shop', started);
    if (started) {
      await p.evaluate((id) => { const c = App.Pages.Customer.local.checkout; c.step = 4; c.phone = '0712345678'; c.collectionTimes[id] = new Date(Date.now() + 2 * 3600000).toISOString(); App.render(); }, S.ten);
      await p.waitForTimeout(500);
      t = await text(p);
      rec('the confirm step shows the ordering location and the shop\'s pickup address', t.includes('Ordering location: Saved university area: Hatfield Square') && t.includes('Pickup address: Ten Km Grill counter, Hatfield'), t.slice(t.indexOf('Confirm'), t.indexOf('Confirm') + 300));
      await p.evaluate(() => App.Pages.Customer.placeOrder()); await p.waitForTimeout(3000);
      const o = await one(`select delivery_location d from orders where customer_id = $1 order by created_at desc limit 1`, [cust]);
      rec('the order is saved with the confirmed ordering location (mode + km, no coordinates)', o && o.d.orderLocation && o.d.orderLocation.mode === 'saved' && Math.abs(Number(o.d.orderLocation.km) - 10) < 0.1 && !('lat' in o.d.orderLocation), JSON.stringify(o && o.d.orderLocation) + ' ' + (await toast(p)));
    }
    rec('no page errors (ordering location)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();

    // ---------------- new student: suggest my campus + saved location near campus ----------------
    p = await open(5701, fresh, 'new@gmail.com', { latitude: -25.7550, longitude: 28.2330 });   // near Hatfield
    await p.click('[data-action="student-setup-pick"][data-v="yes"]'); await p.waitForTimeout(400);
    await p.selectOption('#ss-uni', UP); await p.waitForTimeout(500);
    rec('"Suggest my campus" is offered (a campus of UP has a pin)', !!(await p.$('[data-action="student-setup-suggest"]')));
    await p.click('[data-action="student-setup-suggest"]'); await p.waitForTimeout(1500);
    const sel = await p.evaluate(() => { const s = document.getElementById('ss-campus'); return s && s.options[s.selectedIndex].text; });
    rec('it suggests Hatfield Campus and says the student can choose another', sel === 'Hatfield Campus' && /Suggested: Hatfield Campus/.test(await text(p)), sel);
    await p.selectOption('#ss-campus', { label: 'Groenkloof Campus' }); await p.waitForTimeout(200);
    rec('the student can pick a different campus by hand', (await p.evaluate(() => { const s = document.getElementById('ss-campus'); return s.options[s.selectedIndex].text; })) === 'Groenkloof Campus');
    await p.selectOption('#ss-campus', { label: 'Hatfield Campus' });
    await p.click('form[data-form="student-setup-form"] button[type="submit"]'); await p.waitForTimeout(2500);
    t = await text(p);
    rec('next: "Where do you stay while at university?" with the campus limit', t.includes('Where do you stay while at university?') && t.includes('within 30 km of Hatfield Campus'), t.slice(0, 200));
    await p.fill('#as-address', 'Johannesburg flat');
    // the page saves the location through App.Auth.updateProfile; the database decides
    const farRes = await p.evaluate(async (lat) => App.Auth.updateProfile({ home_address: 'Johannesburg flat', home_lat: lat, home_lng: 28.2314 }), north(-50));
    rec('a saved location more than 30 km from the campus is refused (by the database, with the reason)', !!farRes.error && /within 30 km of your campus/.test(farRes.error) && (await one(`select home_lat from profiles where id = $1`, [fresh])).home_lat === null, JSON.stringify(farRes).slice(0, 200));
    const nearRes = await p.evaluate(async (lat) => App.Auth.updateProfile({ home_address: 'Hatfield flat', home_lat: lat, home_lng: 28.2314 }), north(3));
    rec('a saved location 3 km from the campus is accepted', !nearRes.error && (await one(`select home_lat from profiles where id = $1`, [fresh])).home_lat !== null, JSON.stringify(nearRes.error || ''));
    rec('no page errors (new student)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();

    // ---------------- location denied: still choose a campus ----------------
    p = await open(5701, fresh, 'new@gmail.com');
    await p.evaluate(() => { navigator.geolocation.getCurrentPosition = (ok, err) => err({ code: 1, message: 'denied' }); });
    await q(`update profiles set is_student = null where id = $1`, [fresh]);
    await p.evaluate(async () => { const f = await App.Auth.fetchProfile(App.Store.state.profile.id); App.Store.set({ profile: f }); App.render(); }); await p.waitForTimeout(800);
    await p.click('[data-action="student-setup-pick"][data-v="yes"]'); await p.waitForTimeout(300);
    await p.selectOption('#ss-uni', UP); await p.waitForTimeout(400);
    await p.click('[data-action="student-setup-suggest"]'); await p.waitForTimeout(800);
    rec('with location denied, the student is asked to choose (and can)', (await text(p)).includes('Location is off. Please choose your campus.') && !!(await p.$('#ss-campus')));
    await p.ctx.close();

    // ---------------- developer tools ----------------
    p = await open(5702, dev, 'dev@clickfood.test');
    await p.evaluate(() => App.Store.setRoute({ view: 'campus-directory', params: {} })); await p.waitForTimeout(2000);
    t = await text(p);
    rec('developer: Ordering distance setting and the list of live shops without a location', t.includes('Ordering distance') && t.includes('No Pin Cafe'));
    await p.fill('#cadm-km', '35'); await p.click('form[data-form="cadm-rule-form"] button[type="submit"]'); await p.waitForTimeout(400);
    await p.click('[data-confirm-ok]'); await p.waitForTimeout(1200);
    rec('developer: changing the limit saves (server function)', Number((await one(`select max_order_distance_km k from platform_config where id = 1`)).k) === 35);
    await q(`update platform_config set max_order_distance_km = 30 where id = 1`);
    await p.evaluate((id) => { const s = document.querySelector('[data-action-change="cadm-campus"]'); s.value = id; s.dispatchEvent(new Event('change', { bubbles: true })); }, HAT); await p.waitForTimeout(1200);
    rec('developer: the campus shows its pin with a button to move it', /Campus pin: -25\.75450, 28\.23140/.test(await text(p)) && !!(await p.$('[data-action="cadm-pin"]')));
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
