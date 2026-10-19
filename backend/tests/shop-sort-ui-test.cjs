// Browser test of the home page "All shops" sort and filter: Top Rated puts
// the best average first (unrated last), Fastest Pickup puts shops you can
// order from now first, then the shortest wait (busy adds its extra time),
// Open now hides closed and test shops, Recommended keeps the nearby order.
// Local copy, synthetic data.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/shop-sort-ui-test.cjs <path to playwright>
const path = require('path'); const fs = require('fs'); const http = require('http');
const { startEnv } = require('./login-env.cjs');
const PW_PATH = process.argv[2];
const CUST = path.join(__dirname, '../../frontend');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 400)})` : '')]);

(async () => {
  const E = await startEnv({ fnPorts: [8231], dir: 'cfshopsort', pg: 55811, pgrst: 3651, gw: 3652 });
  const { q } = E; const one = async (s, p) => (await q(s, p)).rows[0];
  let browser; const servers = [];
  try {
    for (const f of ['show_partner_shops.sql', 'payment_options.sql', 'customer_tools.sql', 'group_payments.sql', 'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'shop_locations.sql',
                     'privacy_legal.sql', 'student_entrepreneurs.sql', 'order_distance.sql', 'institutions_v2.sql', 'student_shops_open.sql', 'shop_test_mode.sql']) await q(SQL(f));
    await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
    await q(`update platform_config set show_partner_shops = true, order_distance_rule = true where id = 1`);
    await q(`notify pgrst, 'reload schema'`); await new Promise(r => setTimeout(r, 1500));
    const UP = (await one(`select id from universities where short_code = 'UP'`)).id;
    const hat = (await one(`select id from campuses where code = 'up-hatfield'`)).id;
    const stu = await E.addUser('thandi@gmail.com', 'x', 'customer');
    await q(`update profiles set is_student = true, home_university_id = $2, campus_id = $3, university = 'University of Pretoria', campus_location = 'Hatfield', home_address = 'Hatfield Square', home_lat = -25.7516, home_lng = 28.2386 where id = $1`, [stu, UP, hat]);
    await q(`insert into legal_acceptances (user_id, document, version) values ($1, 'terms', public.legal_versions()->>'terms'), ($1, 'privacy', public.legal_versions()->>'privacy')`, [stu]);
    // name, km north of the student (roughly), rating, reviews, prep min, prep max, busy, test mode, closed
    const SHOPS = [
      ['Near Kota',   0.2, 3.0, 2,  20, 30, false, false, false],
      ['Far Star',    3.0, 5.0, 4,  15, 25, false, false, false],
      ['Mid Grill',   1.0, 4.5, 10, 5,  15, true,  false, false],   // busy: 5 + 15 = 20 minutes
      ['New Wraps',   1.5, 0,   0,  8,  20, false, false, false],   // no ratings yet
      ['Test Bakes',  0.5, 4.9, 3,  3,  10, false, true,  false],   // test mode: can't order
      ['Shut Cafe',   0.8, 4.8, 6,  2,  10, false, false, true],    // temporarily closed
    ];
    let i = 0;
    for (const [name, km, rating, n, pmin, pmax, busy, test, closed] of SHOPS) {
      const mgr = await E.addUser(`m${i++}@shop.test`, 'x', 'manager');
      const id = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, location_type, availability,
          pickup_lat, pickup_lng, prep_time_min, prep_time_max, busy, busy_extra_minutes, test_mode, store_closed)
        values ($1, $2, $3, 'Fast Food', 'Hatfield', 'Hatfield', 'University of Pretoria', 'approved', true, '00:00', '23:59', 'business', 'campus', 'university', $4, 28.2386, $5, $6, $7, 15, $8, $9) returning id`,
        [mgr, name, name.toLowerCase().replace(/\W+/g, '-'), -25.7516 + km / 111, pmin, pmax, busy, test, closed])).id;
      // as if from reviews (the database keeps these columns in step with the reviews)
      await q(`set session_replication_role = replica`); await q(`update stores set rating = $2, rating_count = $3 where id = $1`, [id, rating, n]); await q(`set session_replication_role = origin`);
      await q(`insert into menu_items (store_id, name, category, price, status, available, stock, image, description) values ($1, $2, 'Lunch', 40, 'approved', true, 50, 'https://x/i.webp', 'Fresh and tasty lunch meal')`, [id, name + ' Meal']);
    }
    const back = (await q(`select name, rating, rating_count from stores order by name`)).rows;

    const { chromium } = require(PW_PATH);
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
    const serve = (root, port) => { const s = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(port); servers.push(s); };
    serve(CUST, 5731);
    browser = await chromium.launch();
    const tok = E.jwt({ sub: stu, role: 'authenticated', email: 'thandi@gmail.com', aud: 'authenticated' });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const userObj = { id: stu, email: 'thandi@gmail.com', aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, email_confirmed_at: new Date().toISOString() };
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
    await p.goto('http://localhost:5731/'); await p.waitForTimeout(7000);
    const order = () => p.evaluate(() => { const h = document.getElementById('all-stores-section'); const g = h && h.nextElementSibling;
      return g ? Array.from(g.querySelectorAll('.store-card-name')).map(e => e.textContent.trim()) : []; });
    const sortBy = async (v) => { await p.selectOption('[data-action-change="marketplace-sort"]', v); await p.waitForTimeout(600); return order(); };

    let o = await order();
    rec('Recommended: the nearest shop first (nearby order)', o[0] === 'Near Kota' && o.length === 6, JSON.stringify(o) + ' db:' + JSON.stringify(back));
    o = await sortBy('rating');
    rec('Top Rated: best average first, unrated shop last', JSON.stringify(o) === JSON.stringify(['Far Star', 'Test Bakes', 'Shut Cafe', 'Mid Grill', 'Near Kota', 'New Wraps']), JSON.stringify(o));
    o = await sortBy('fastest');
    rec('Fastest Pickup: orderable shops first, shortest wait first, busy adds its extra time', JSON.stringify(o.slice(0, 4)) === JSON.stringify(['New Wraps', 'Far Star', 'Near Kota', 'Mid Grill']) && o.slice(4).sort().join() === 'Shut Cafe,Test Bakes', JSON.stringify(o));
    await p.click('[data-action="marketplace-toggle-open"]'); await p.waitForTimeout(600);
    o = await order();
    rec('Open now: closed and test shops are hidden', o.length === 4 && !o.includes('Shut Cafe') && !o.includes('Test Bakes'), JSON.stringify(o));
    o = await sortBy('rating');
    rec('Open now + Top Rated work together', JSON.stringify(o) === JSON.stringify(['Far Star', 'Mid Grill', 'Near Kota', 'New Wraps']), JSON.stringify(o));
    await p.click('[data-action="marketplace-toggle-open"]'); await p.waitForTimeout(600);
    o = await sortBy('recommended');
    rec('back to Recommended: nearby order again, all 6 shops', o[0] === 'Near Kota' && o.length === 6, JSON.stringify(o));
    rec('no page errors', p.errs.length === 0, p.errs.join(' | '));
    await ctx.close();
  } catch (e) { rec('test run', false, e.stack || e.message); }
  if (browser) await browser.close();
  servers.forEach(s => s.close());
  await E.stop();
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})();
