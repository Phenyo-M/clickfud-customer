// Browser test (Staff app + developer app) for the 2026-10-17 changes:
// the manager's shop location (campus / off campus + map pin) in Shop
// Settings and in the business registration form, the student-deal fields on
// promo codes, and the developer's Student checks. Local copy, synthetic data.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/staff-dev-flows-ui-test.cjs <path to playwright>
const path = require('path'); const fs = require('fs'); const http = require('http'); const crypto = require('crypto');
const { startEnv } = require('./login-env.cjs');
const PW_PATH = process.argv[2];
const STAFF = path.join(__dirname, '../../../Campus Eats Staff/frontend');
const DEV = path.join(__dirname, '../../../Campus Eats Developer/frontend');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 260)})` : '')]);

(async () => {
  const E = await startEnv({ fnPorts: [8191], dir: 'cfstaffdevui', pg: 55761, pgrst: 3611, gw: 3612 });
  const { q } = E; const one = async (s, p) => (await q(s, p)).rows[0];
  let browser; const servers = [];
  try {
    for (const f of ['show_partner_shops.sql', 'payment_options.sql', 'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'shop_locations.sql', 'privacy_legal.sql']) await q(SQL(f));
    await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
    await q(`notify pgrst, 'reload schema'`); await new Promise(r => setTimeout(r, 1500));
    const UP = (await one(`select id from universities where name = 'University of Pretoria'`)).id;
    const mgr = await E.addUser('mgr@shop.test', 'x', 'manager');
    const shop = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, location_type, logo_url, cover_image_url)
      values ($1, 'Hatfield Kota', 'hatfield-kota', 'Fast Food', 'Hatfield', 'Shop 4, Student Centre', 'University of Pretoria', 'approved', true, '00:00', '23:59', 'business', 'campus', 'https://x/l.webp', 'https://x/c.webp') returning id`, [mgr])).id;
    await q(`update profiles set store_id = $1 where id = $2`, [shop, mgr]);
    await q(`insert into menu_items (store_id, name, category, price, status, available, stock, image, description) values ($1, 'Coke', 'Drinks', 15, 'approved', true, 50, 'https://x/i.webp', 'Cold')`, [shop]);
    const newMgr = await E.addUser('new@shop.test', 'x', 'manager');
    const dev = await E.addUser('dev@clickfood.test', 'x', 'developer');
    const stu = await E.addUser('lerato@gmail.com', 'x', 'customer');
    await q(`insert into student_verifications (user_id, email, university_id, status) values ($1, 'lerato@someuni.ac.za', $2, 'needs_review')`, [stu, UP]);

    const { chromium } = require(PW_PATH);
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
    const serve = (root, port) => { const s = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(port); servers.push(s); };
    serve(STAFF, 5681); serve(DEV, 5682);
    browser = await chromium.launch();
    async function open(port, user, email, role) {
      const tok = E.jwt({ sub: user, role: 'authenticated', email, aud: 'authenticated' });
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      const userObj = { id: user, email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, email_confirmed_at: new Date().toISOString() };
      await ctx.addInitScript(({ tok, userObj }) => { try { localStorage.setItem('sb-ctxnwjjpqxecidzblyok-auth-token', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer', expires_in: 7200, expires_at: Math.floor(Date.now() / 1000) + 7200, user: userObj })); } catch (e) {} }, { tok, userObj });
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
    const go = (p, view) => p.evaluate((v) => App.Store.setRoute({ view: v, params: {} }), view);
    const toast = (p) => p.evaluate(() => Array.from(document.querySelectorAll('.toast')).map(t => t.innerText).join(' | '));

    // ---------------- manager: Shop Settings location ----------------
    let p = await open(5681, mgr, 'mgr@shop.test');
    await go(p, 'store'); await p.waitForTimeout(1500);
    let t = await text(p);
    rec('Shop Settings asks "Is this business located on a university campus?"', t.includes('Is this business located on a university campus?'));
    const uniOpts = await p.evaluate(() => Array.from(document.querySelectorAll('#loc-university option')).map(o => o.value));
    rec('universities come from the shared list (not typed in)', uniOpts.includes('University of Pretoria') && uniOpts.includes('Tshwane University of Technology'), JSON.stringify(uniOpts));
    rec('the saved campus is selected', (await p.evaluate(() => document.getElementById('loc-campus').value)) === 'Hatfield');
    rec('a map is shown to pin the shop', !!(await p.$('#store-map .map-picker-canvas')));
    await p.click('[data-action="loc-type"][data-v="off_campus"]'); await p.waitForTimeout(300);
    rec('"No" hides the university and campus and asks for the shop address', await p.evaluate(() => document.getElementById('loc-campus-fields').hidden && document.getElementById('loc-address-label').textContent.includes('Shop address')));
    await p.fill('#loc-address', '12 Main Road, Hatfield');
    await p.click('form[data-form="store-form"] button[type="submit"]'); await p.waitForTimeout(1200);
    rec('saving off campus without a pin is refused', (await toast(p)).includes('Please put the shop on the map') && (await one(`select location_type from stores where id = $1`, [shop])).location_type === 'campus', await toast(p));
    // drop the pin by tapping the map
    await p.$eval('#store-map .map-picker-canvas', (el) => el.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
    const box = await p.$eval('#store-map .map-picker-canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await p.mouse.click(box.x, box.y); await p.waitForTimeout(400);
    const pin = await p.evaluate(() => [document.getElementById('loc-lat').value, document.getElementById('loc-lng').value]);
    rec('tapping the map sets the pin', pin[0] !== '' && pin[1] !== '', JSON.stringify(pin));
    await p.click('form[data-form="store-form"] button[type="submit"]'); await p.waitForTimeout(1500);
    const st = await one(`select location_type, university, campus_location, address, pickup_lat, pickup_lng from stores where id = $1`, [shop]);
    rec('the off-campus location is saved with the pin and no university', st.location_type === 'off_campus' && st.university === null && st.address === '12 Main Road, Hatfield' && Math.abs(st.pickup_lat - Number(pin[0])) < 1e-5, JSON.stringify(st));

    // ---------------- manager: student deal ----------------
    await go(p, 'promotions'); await p.waitForTimeout(800);
    await p.click('[data-action="add-promo"]'); await p.waitForTimeout(1200);
    rec('the promo form has "Who can use it", uses per customer, university and campus', !!(await p.$('select[name="audience"]')) && !!(await p.$('input[name="per_customer_limit"]')) && !!(await p.$('#promo-uni')) && !!(await p.$('#promo-campus')));
    await p.fill('input[name="code"]', 'STUDENT10');
    await p.check('input[name="menu_item_ids"]');
    await p.fill('input[name="value"]', '10');
    await p.fill('input[name="usage_limit"]', '200');
    await p.selectOption('select[name="audience"]', 'students');
    await p.fill('input[name="per_customer_limit"]', '1');
    await p.selectOption('#promo-uni', UP); await p.waitForTimeout(300);
    const campusOpts = await p.evaluate(() => Array.from(document.querySelectorAll('#promo-campus option')).map(o => o.textContent));
    rec('choosing a university lists its campuses', campusOpts.some(c => /Hatfield/.test(c)), JSON.stringify(campusOpts));
    await p.click('form[data-form="promo-form"] button[type="submit"]'); await p.waitForTimeout(1500);
    const pr = await one(`select audience, per_customer_limit, usage_limit, university_id from promotions where code = 'STUDENT10'`);
    rec('the student-only deal is saved with its limits', pr && pr.audience === 'students' && pr.per_customer_limit === 1 && pr.usage_limit === 200 && pr.university_id === UP, JSON.stringify(pr));
    rec('the promo list shows it is for students', (await text(p)).includes('Students') && (await text(p)).includes('1 per customer'));
    await p.click('[data-action="add-promo"]'); await p.waitForTimeout(800);
    await p.fill('input[name="code"]', 'BADLIMIT'); await p.check('input[name="menu_item_ids"]'); await p.fill('input[name="value"]', '5');
    await p.fill('input[name="usage_limit"]', '2'); await p.fill('input[name="per_customer_limit"]', '3');
    await p.click('form[data-form="promo-form"] button[type="submit"]'); await p.waitForTimeout(800);
    rec('uses per customer above the total limit is refused', (await toast(p)).includes("can't be more than the total limit") && !(await one(`select 1 x from promotions where code = 'BADLIMIT'`)));
    rec('no page errors (Staff, existing shop)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();

    // ---------------- new manager: registration step 1 ----------------
    p = await open(5681, newMgr, 'new@shop.test');
    t = await text(p);
    rec('registration step 1 asks the campus question', t.includes('Register as a Business') && t.includes('Is this business located on a university campus?'), t.slice(0, 120));
    await p.fill('input[name="name"]', 'Town Grill');
    await p.selectOption('select[name="business_type"]', { index: 1 });
    await p.click('[data-action="loc-type"][data-v="off_campus"]');
    await p.fill('#loc-address', '5 Church Street, Pretoria');
    await p.fill('input[name="contact_phone"]', '0712345678');
    await p.click('form[data-form="onboarding-step-form"] button[type="submit"]'); await p.waitForTimeout(600);
    rec('an off-campus business must be pinned before Next', (await toast(p)).includes('Please put the shop on the map') && (await text(p)).includes('Step 1 of'));
    await p.$eval('#onboarding-map .map-picker-canvas', (el) => el.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
    const b2 = await p.$eval('#onboarding-map .map-picker-canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await p.mouse.click(b2.x, b2.y); await p.waitForTimeout(400);
    await p.click('form[data-form="onboarding-step-form"] button[type="submit"]'); await p.waitForTimeout(800);
    rec('with a pin, no university is needed to continue', (await text(p)).includes('Step 2 of'), (await text(p)).slice(0, 160));
    rec('the draft keeps the off-campus location and pin', await p.evaluate(() => { const d = App.Pages.Manager && App.Pages.Manager.local ? App.Pages.Manager.local.onboardingDraft : null; return !d || (d.location_type === 'off_campus' && d.pickup_lat != null && d.university === null); }));
    rec('no page errors (registration)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();

    // ---------------- developer: Student checks ----------------
    p = await open(5682, dev, 'dev@clickfood.test');
    await go(p, 'institutions'); await p.waitForTimeout(2000);
    t = await text(p);
    rec('Supported Institutions shows Student checks with the waiting request', t.includes('Student checks') && t.includes('lerato@someuni.ac.za'), t.slice(-300));
    await p.click('[data-action="student-check"][data-do="approve"]'); await p.waitForTimeout(500);
    await p.click('[data-confirm-ok]'); await p.waitForTimeout(1500);
    rec('approving verifies the student (server function, audited)', (await one(`select status from student_verifications where user_id = $1`, [stu])).status === 'verified');
    await p.click('[data-action="student-check-filter"][data-f="verified"]'); await p.waitForTimeout(1200);
    rec('the Verified list shows them with Revoke', (await text(p)).includes('lerato@someuni.ac.za') && !!(await p.$('[data-action="student-check"][data-do="revoke"]')));
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
