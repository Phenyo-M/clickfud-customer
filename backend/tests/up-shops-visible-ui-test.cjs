// Browser test: a University of Pretoria student sees the UP business shops
// (like Kota Hub and Coffee Grill) as well as the student entrepreneurs'
// shops, with the live settings (distance rule on, a test-mode shop, a shop
// without a map pin). Local copy, synthetic data.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/up-shops-visible-ui-test.cjs <path to playwright>
const path = require('path'); const fs = require('fs'); const http = require('http');
const { startEnv } = require('./login-env.cjs');
const PW_PATH = process.argv[2];
const CUST = path.join(__dirname, '../../frontend');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 400)})` : '')]);

(async () => {
  const E = await startEnv({ fnPorts: [8221], dir: 'cfupshops', pg: 55801, pgrst: 3641, gw: 3642 });
  const { q } = E; const one = async (s, p) => (await q(s, p)).rows[0];
  let browser; const servers = [];
  try {
    for (const f of ['show_partner_shops.sql', 'payment_options.sql', 'customer_tools.sql', 'group_payments.sql', 'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'shop_locations.sql',
                     'privacy_legal.sql', 'student_entrepreneurs.sql', 'order_distance.sql', 'institutions_v2.sql', 'student_shops_open.sql', 'shop_test_mode.sql']) await q(SQL(f));
    await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
    await q(`update platform_config set show_partner_shops = true, order_distance_rule = true where id = 1; update allowed_domains set active = true`);
    await q(`notify pgrst, 'reload schema'`); await new Promise(r => setTimeout(r, 1500));
    const UP = (await one(`select id from universities where short_code = 'UP'`)).id;
    const hat = (await one(`select id from campuses where code = 'up-hatfield'`)).id;
    const student = async (email) => {
      const id = await E.addUser(email, 'x', 'customer');
      await q(`update profiles set is_student = true, home_university_id = $2, campus_id = $3, university = 'University of Pretoria', campus_location = 'Hatfield',
               home_address = 'Hatfield Square', home_lat = -25.7516, home_lng = 28.2386 where id = $1`, [id, UP, hat]);
      await q(`insert into legal_acceptances (user_id, document, version) values ($1, 'terms', public.legal_versions()->>'terms'), ($1, 'privacy', public.legal_versions()->>'privacy')`, [id]);
      return id;
    };
    const gmail = await student('thandi@gmail.com');        // UP student, Gmail login, email not verified
    const tuks = await student('u26651344@tuks.co.za');     // UP student, university login
    // a brand-new account: not a student yet (answers the question after signing in)
    const fresh = await E.addUser('newup@gmail.com', 'x', 'customer');
    await q(`update profiles set is_student = null, home_university_id = null, university = null, campus_location = null, home_address = 'Hatfield Square', home_lat = -25.7516, home_lng = 28.2386 where id = $1`, [fresh]);
    await q(`insert into legal_acceptances (user_id, document, version) values ($1, 'terms', public.legal_versions()->>'terms'), ($1, 'privacy', public.legal_versions()->>'privacy')`, [fresh]);
    const mgr = await E.addUser('mgr@shop.test', 'x', 'manager');
    const mgr2 = await E.addUser('mgr2@shop.test', 'x', 'manager');
    const shop = async (owner, name, kind, test, pin) => {
      const id = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, location_type, availability, test_mode, pickup_lat, pickup_lng)
        values ($1, $2, $3, 'Fast Food', 'Hatfield', 'Hatfield', 'University of Pretoria', 'approved', true, '00:00', '23:59', $4, 'campus', 'university', $5, $6, $7) returning id`,
        [owner, name, name.toLowerCase().replace(/\W+/g, '-'), kind, test, pin ? -25.7542 : null, pin ? 28.2318 : null])).id;
      await q(`insert into menu_items (store_id, name, category, price, status, available, stock, image, description) values ($1, $2, 'Lunch', 40, 'approved', true, 50, 'https://x/i.webp', 'Fresh and tasty lunch meal')`, [id, name + ' Meal']);
      return id;
    };
    await shop(mgr, 'Kota Hub', 'business', false, true);
    await shop(mgr2, 'Coffee Grill', 'business', true, false);
    const seller = await student('u12121212@tuks.co.za');
    await q(`insert into entrepreneur_applications (user_id, status, business_name, submitted_at) values ($1, 'approved', 'JunkFoody', now())`, [seller]);
    await shop(seller, 'JunkFoody', 'student', false, true);

    const { chromium } = require(PW_PATH);
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
    const serve = (root, port) => { const s = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(port); servers.push(s); };
    serve(CUST, 5721);
    browser = await chromium.launch();
    async function open(user, email) {
      const tok = E.jwt({ sub: user, role: 'authenticated', email, aud: 'authenticated' });
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      const userObj = { id: user, email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, email_confirmed_at: new Date().toISOString() };
      await ctx.addInitScript(({ tok, userObj }) => { try { localStorage.setItem('clickfud_onboarding_completed', 'true'); localStorage.setItem('sb-ctxnwjjpqxecidzblyok-auth-token', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer', expires_in: 7200, expires_at: Math.floor(Date.now() / 1000) + 7200, user: userObj })); } catch (e) {} }, { tok, userObj });
      try { await ctx.routeWebSocket(/supabase\.co/, (ws) => ws.close()); } catch (e) {}
      await ctx.route(/supabase\.co/, async (route) => {
        const req = route.request(); const u = new URL(req.url());
        if (u.pathname.startsWith('/rest/v1/')) {
          const headers = { ...req.headers() }; headers.authorization = 'Bearer ' + (/Bearer eyJ/.test(headers.authorization || '') ? tok : E.jwt({ role: 'anon' })); delete headers.apikey; delete headers.host;
          try { return route.fulfill({ response: await route.fetch({ url: `${E.pgrstUrl}${u.pathname.slice(8)}${u.search}`, headers }) }); } catch (e) { return route.abort(); }
        }
        if (u.pathname.startsWith('/functions/v1/')) return route.fulfill({ json: { ok: true } });
        if (u.pathname.startsWith('/auth/v1/user')) return route.fulfill({ json: userObj });
        return route.fulfill({ json: {} });
      });
      await ctx.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) }));
      const p = await ctx.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message));
      await p.goto(`http://localhost:5721/`); await p.waitForTimeout(7000);
      p.ctx = ctx; return p;
    }
    for (const [who, id, email] of [['Gmail UP student', gmail, 'thandi@gmail.com'], ['tuks UP student', tuks, 'u26651344@tuks.co.za']]) {
      const p = await open(id, email);
      const info = await p.evaluate(() => ({
        loaded: (App.Store.state.stores || []).map(s => s.name).sort(),
        mine: Array.from(document.querySelectorAll('#my-university-section [data-id], #my-university-section .store-mini-card')).map(e => (e.innerText || '').split('\n')[0]).filter(Boolean),
        text: document.body.innerText.slice(0, 900),
      }));
      const mineText = await p.evaluate(() => (document.getElementById('my-university-section') || {}).innerText || '');
      rec(`${who}: the app loads Kota Hub and Coffee Grill`, info.loaded.includes('Kota Hub') && info.loaded.includes('Coffee Grill'), JSON.stringify(info.loaded));
      rec(`${who}: "Shops at UP" shows Kota Hub, Coffee Grill and JunkFoody`, /Kota Hub/.test(mineText) && /Coffee Grill/.test(mineText) && /JunkFoody/.test(mineText), mineText.replace(/\s+/g, ' ').slice(0, 300) || info.text.replace(/\s+/g, ' '));
      rec(`${who}: no page errors`, p.errs.length === 0, p.errs.join(' | '));
      await p.ctx.close();
    }

    // ---------------- the reported case: a new account says "Yes, I am a student" at UP ----------------
    const p = await open(fresh, 'newup@gmail.com');
    rec('new account: asked "Are you a student?" first', /Are you a student/.test(await p.evaluate(() => document.body.innerText)));
    const before = await p.evaluate(() => (App.Store.state.stores || []).map(s => s.name).sort());
    rec('new account: before answering, only student and general shops load (as the rules say)', !before.includes('Kota Hub') && before.includes('JunkFoody'), JSON.stringify(before));
    await p.click('[data-action="student-setup-pick"][data-v="yes"]'); await p.waitForTimeout(500);
    const upId = await p.evaluate(() => Array.from(document.querySelectorAll('#ss-uni option')).find(o => /Pretoria/.test(o.textContent)).value);
    await p.selectOption('#ss-uni', upId); await p.waitForTimeout(500);
    const hatId = await p.evaluate(() => Array.from(document.querySelectorAll('#ss-campus option')).find(o => /Hatfield/.test(o.textContent)).value);
    await p.selectOption('#ss-campus', hatId); await p.waitForTimeout(300);
    await p.click('form[data-form="student-setup-form"] button[type="submit"]'); await p.waitForTimeout(4000);
    const after = await p.evaluate(() => (App.Store.state.stores || []).map(s => s.name).sort());
    const mineNow = await p.evaluate(() => (document.getElementById('my-university-section') || {}).innerText || '');
    rec('new account: right after choosing UP, Kota Hub and Coffee Grill load (no app restart)', after.includes('Kota Hub') && after.includes('Coffee Grill'), JSON.stringify(after));
    rec('new account: "Shops at UP" shows Kota Hub, Coffee Grill and JunkFoody', /Kota Hub/.test(mineNow) && /Coffee Grill/.test(mineNow) && /JunkFoody/.test(mineNow), mineNow.replace(/\s+/g, ' ').slice(0, 300));
    rec('new account: no page errors', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();
  } catch (e) { rec('test run', false, e.stack || e.message); }
  if (browser) await browser.close();
  servers.forEach(s => s.close());
  await E.stop();
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})();
