// Browser test (customer app) for the 2026-10-17 changes: open sign-up
// wording, "Are you a student?", student verification box, Profile student
// fields, student shop gate, shop place row (on/off campus, distance,
// directions), "Use my location" -> Near you, back arrows, the clear-search
// X and the in-app Privacy Policy / Terms with versioned acceptance.
// Local copy only (embedded Postgres + PostgREST), synthetic data.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/customer-flows-ui-test.cjs <path to playwright>
const path = require('path'); const fs = require('fs'); const http = require('http');
const { startEnv } = require('./login-env.cjs');
const PW_PATH = process.argv[2];
const WEBROOT = path.join(__dirname, '../../frontend');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 260)})` : '')]);

(async () => {
  const E = await startEnv({ fnPorts: [8181], dir: 'cfflowsui', pg: 55751, pgrst: 3601, gw: 3602 });
  const { q } = E; const one = async (s, p) => (await q(s, p)).rows[0];
  let browser;
  try {
    for (const f of ['show_partner_shops.sql', 'payment_options.sql', 'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'shop_locations.sql', 'privacy_legal.sql', 'student_entrepreneurs.sql']) await q(SQL(f));
    await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
    await q(`update platform_config set show_partner_shops = true where id = 1; update allowed_domains set active = true`);
    await q(`notify pgrst, 'reload schema'`); await new Promise(r => setTimeout(r, 1500));
    const UP = (await one(`select id from universities where name = 'University of Pretoria'`)).id;
    const HAT = (await one(`select id from campuses where code = 'up-hatfield'`)).id;

    const mgr = await E.addUser('mgr@shop.test', 'x', 'manager'), mgr2 = await E.addUser('mgr2@shop.test', 'x', 'manager');
    const campusShop = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, location_type, pickup_lat, pickup_lng)
      values ($1, 'Hatfield Kota', 'hatfield-kota', 'Fast Food', 'Hatfield', 'Shop 4, Student Centre', 'University of Pretoria', 'approved', true, '00:00', '23:59', 'business', 'campus', -25.7545, 28.2314) returning id`, [mgr])).id;
    const townShop = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, location_type, pickup_lat, pickup_lng)
      values ($1, 'Town Pizza', 'town-pizza', 'Pizza', '', '12 Main Road, Hatfield', null, 'approved', true, '00:00', '23:59', 'business', 'off_campus', -25.7480, 28.2400) returning id`, [mgr2])).id;
    for (const [n, pr] of [['Coke', 15], ['Burger', 45], ['Chips', 20]]) await q(`insert into menu_items (store_id, name, category, price, status, available, stock, image, description) values ($1, $2, 'Lunch', $3, 'approved', true, 50, 'https://x/i.webp', 'Nice')`, [campusShop, n, pr]);
    const coke = (await one(`select id from menu_items where name = 'Coke'`)).id;
    await q(`insert into promotions (code, type, value, active, store_id, title, audience, per_customer_limit, menu_item_ids) values ('STUDENT10', 'fixed', 5, true, $1, 'Student deal', 'students', 1, array[$2]::uuid[])`, [campusShop, coke]);

    // a returning Gmail student (already set up) and a brand new customer
    const cust = await E.addUser('thandi.test@gmail.com', 'x', 'customer');
    await q(`update profiles set is_student = true, university = 'University of Pretoria', campus_location = 'Hatfield', home_university_id = $2, home_address = 'Hatfield Square', home_lat = -25.7510, home_lng = 28.2380 where id = $1`, [cust, UP]);
    const fresh = await E.addUser('new.person@outlook.com', 'x', 'customer');
    await q(`update profiles set home_address = 'Arcadia', home_lat = -25.746, home_lng = 28.21 where id = $1`, [fresh]);

    const { chromium } = require(PW_PATH);
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
    const web = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(WEBROOT, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(5671);
    browser = await chromium.launch();
    async function open(user, email, opts) {
      const o = opts || {};
      const tok = user ? E.jwt({ sub: user, role: 'authenticated', email, aud: 'authenticated' }) : null;
      const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }, o.geo ? { geolocation: o.geo, permissions: ['geolocation'] } : {}));
      const userObj = user ? { id: user, email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: o.meta || {}, email_confirmed_at: new Date().toISOString() } : null;
      await ctx.addInitScript(({ tok, userObj }) => { try { localStorage.setItem('clickfud_onboarding_completed', 'true'); if (tok) localStorage.setItem('sb-ctxnwjjpqxecidzblyok-auth-token', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer', expires_in: 7200, expires_at: Math.floor(Date.now() / 1000) + 7200, user: userObj })); } catch (e) {} }, { tok, userObj });
      try { await ctx.routeWebSocket(/supabase\.co/, (ws) => ws.close()); } catch (e) {}
      const fnCalls = [];
      await ctx.route(/supabase\.co/, async (route) => {
        const req = route.request(); const u = new URL(req.url());
        if (u.pathname.startsWith('/rest/v1/')) {
          const headers = { ...req.headers() }; headers.authorization = 'Bearer ' + (tok && /Bearer eyJ/.test(headers.authorization || '') ? tok : E.jwt({ role: 'anon' })); delete headers.apikey; delete headers.host;
          try { return route.fulfill({ response: await route.fetch({ url: `${E.pgrstUrl}${u.pathname.slice(8)}${u.search}`, headers }) }); } catch (e) { return route.abort(); }
        }
        if (u.pathname.startsWith('/functions/v1/')) { fnCalls.push(u.pathname + ' ' + (req.postData() || '')); return route.fulfill({ json: o.fnReply || { ok: true } }); }
        if (u.pathname.startsWith('/auth/v1/user')) return route.fulfill({ json: userObj || {} });
        return route.fulfill({ json: {} });
      });
      const p = await ctx.newPage(); p.errs = []; p.fnCalls = fnCalls; p.on('pageerror', e => p.errs.push(e.message));
      await p.goto('http://localhost:5671/' + (o.path || '')); await p.waitForTimeout(6000);
      p.ctx = ctx; return p;
    }
    const text = (p) => p.evaluate(() => document.body.innerText);
    const route = (p, view, params) => p.evaluate(([v, pr]) => { App.Store.setRoute({ view: v, params: pr || {} }); }, [view, params]);
    const noSideScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    const closeModal = (p) => p.evaluate(() => { if (App.Modal.isOpen()) App.Modal.close(); });

    // ---------------- guest: sign-up / log-in wording ----------------
    let p = await open(null);
    await p.evaluate(() => { App.Store.set({ forceAuthView: true }); App.Pages.Auth.setTab('signup'); App.render(); }); await p.waitForTimeout(400);
    let t = await text(p);
    rec('sign-up says "Create your ClickFood account using your email address."', t.includes('Create your ClickFood account using your email address.'));
    rec('sign-up has no campus, residence or student-number fields', !(await p.$('#campus-field')) && !(await p.$('#su-residence')) && !/student number|campus\(es\)/i.test(t), t.match(/campus[^\n]*/i));
    rec('sign-up links the Terms and Privacy Policy', !!(await p.$('a[href="legal/terms-of-service.html"]')) && !!(await p.$('a[href="legal/privacy-policy.html"]')));
    await p.evaluate(() => { App.Pages.Auth.setTab('login'); App.render(); }); await p.waitForTimeout(300);
    t = await text(p);
    rec('log-in says "Enter your email address and password." and the field is just "Email"', t.includes('Enter your email address and password.') && !/student email/i.test(t));
    await p.ctx.close();

    // ---------------- brand new customer: "Are you a student?" + Terms ----------------
    p = await open(fresh, 'new.person@outlook.com');
    t = await text(p);
    rec('a new customer is asked "Are you a student?" with both answers', t.includes('Are you a student?') && t.includes('Yes, I am a student') && t.includes('No, I am not a student'), t.slice(0, 200));
    await p.click('[data-action="student-setup-pick"][data-v="yes"]'); await p.waitForTimeout(300);
    rec('"Yes" asks for university (and campus)', !!(await p.$('#ss-uni')));
    await p.click('[data-action="student-setup-pick"][data-v="no"]'); await p.waitForTimeout(300);
    rec('"No" asks for no university', !(await p.$('#ss-uni')));
    await p.click('form[data-form="student-setup-form"] button[type="submit"]'); await p.waitForTimeout(2500);
    const fr = await one(`select is_student, university from profiles where id = $1`, [fresh]);
    rec('"No" is saved (not a student, no university)', fr.is_student === false && fr.university === null, JSON.stringify(fr));
    t = await text(p);
    rec('...and the home page opens', /More places to order from|Near you|Use my location|Town Pizza/.test(t), t.slice(0, 160));
    rec('the updated Terms box asks the existing customer to agree', t.includes('Updated Terms and Privacy Policy'));
    await p.click('[data-action="legal-accept"]'); await p.waitForTimeout(1500);
    rec('"I agree" is recorded for both documents (current versions)', (await one(`select count(*)::int n from legal_acceptances where user_id = $1 and version = public.legal_versions()->>'terms'`, [fresh])).n === 2);
    rec('a non-student sees the off-campus shop labelled "Off campus"', (await text(p)).includes('Off campus'));
    await p.ctx.close();

    // ---------------- returning Gmail student ----------------
    await q(`insert into legal_acceptances (user_id, document, version) values ($1, 'terms', public.legal_versions()->>'terms'), ($1, 'privacy', public.legal_versions()->>'privacy')`, [cust]);
    p = await open(cust, 'thandi.test@gmail.com', { geo: { latitude: -25.7500, longitude: 28.2350 } });
    t = await text(p);
    rec('a returning student is not asked again', !t.includes('Are you a student?') && !t.includes('Updated Terms and Privacy Policy'));
    // location was allowed before in this browser: the app reads it quietly (no button needed)
    await p.click('[data-action="order-mode"][data-mode="current"]'); await p.waitForTimeout(1500);
    const near = await p.evaluate(() => { const el = document.getElementById('near-you-section'); return el ? Array.from(el.querySelectorAll('.store-mini-name')).map(n => n.textContent.trim()) : null; });
    rec('after allowing location, "Near you" lists the closest shops', Array.isArray(near) && near[0] === 'Town Pizza' && near.includes('Hatfield Kota'), JSON.stringify(near));
    rec('shop cards show a real distance', /\d+ m away|\d+(\.\d)? km away/.test(await p.evaluate(() => (document.getElementById('near-you-section') || {}).innerText || '')));
    rec('no "Campus Directions" button on the dashboard', !/campus directions/i.test(await text(p)));
    // shop page: place row + directions
    await p.evaluate((id) => App.Store.setRoute({ view: 'store', params: { storeId: id } }), campusShop); await p.waitForTimeout(800);
    const row = await p.evaluate(() => { const r = document.querySelector('.shop-place-row'); return r ? { t: r.innerText, href: (r.querySelector('a') || {}).href } : null; });
    rec('the shop page shows "On campus", the distance and Directions to the saved pin', row && /On campus/.test(row.t) && /away/.test(row.t) && /destination=-25\.7545,28\.2314/.test(row.href), JSON.stringify(row));
    // clear-search X on the menu search
    const menuNames = () => p.evaluate(() => document.body.innerText);
    await p.fill('#store-search-input', 'Coke'); await p.waitForTimeout(700);
    let m = await menuNames();
    const xVisible = await p.evaluate(() => { const b = document.querySelector('#store-search-input + .search-clear'); return !!b && !b.hidden && b.getAttribute('aria-label') === 'Clear search' && b.getBoundingClientRect().width >= 28; });
    rec('menu search: typing filters and shows the X', m.includes('Coke') && !m.includes('Burger') && xVisible, xVisible + ' ' + m.replace(/s+/g, ' ').slice(0, 600));
    await p.click('#store-search-input + .search-clear'); await p.waitForTimeout(700);
    m = await menuNames();
    const after = await p.evaluate(() => ({ v: document.getElementById('store-search-input').value, focused: document.activeElement && document.activeElement.id, x: (document.querySelector('#store-search-input + .search-clear') || {}).hidden }));
    rec('tapping X clears the search, brings back the full menu and keeps typing in the box', after.v === '' && m.includes('Burger') && m.includes('Chips') && after.focused === 'store-search-input' && after.x === true, JSON.stringify(after));
    await p.keyboard.type('zzz'); await p.waitForTimeout(700);
    rec('a new search works right after clearing (no results case)', (await p.evaluate(() => document.getElementById('store-search-input').value)) === 'zzz' && !(await menuNames()).includes('Burger'));
    await p.click('#store-search-input + .search-clear'); await p.waitForTimeout(600);
    rec('the shop page has a back arrow', !!(await p.$('[data-action="nav-back"]')));
    await p.click('[data-action="nav-back"]'); await p.waitForTimeout(800);
    rec('back from the shop returns to the home page', (await p.evaluate(() => App.Store.state.route.view)) === 'home');
    // home search X keeps the university/campus filter
    await p.evaluate(() => { App.Pages.Home.local.campusPick = undefined; });
    const homeInput = (await p.$('#home-search-input')) ? '#home-search-input' : '#discover-search-input';
    await p.fill(homeInput, 'Pizza'); await p.waitForTimeout(800);
    await p.click(homeInput + ' + .search-clear'); await p.waitForTimeout(800);
    rec('home search X clears only the search text', (await p.evaluate((s) => document.querySelector(s).value, homeInput)) === '' && (await p.evaluate(() => App.Pages.Home.local.search)) === '');

    // ---------------- back arrows ----------------
    await route(p, 'more'); await p.waitForTimeout(400);
    await p.click('.page-wrap [data-action="go-profile"]'); await p.waitForTimeout(500);
    rec('Profile opened from More has a back arrow', !!(await p.$('.page-head [data-action="nav-back"]')));
    await p.click('.page-head [data-action="nav-back"]'); await p.waitForTimeout(600);
    rec('...which returns to More', (await p.evaluate(() => App.Store.state.route.view)) === 'more');
    await p.click('.page-wrap [data-view="timetable"]'); await p.waitForTimeout(500);
    await p.click('.page-wrap [data-action="nav-back"]'); await p.waitForTimeout(600);
    rec('Timetable back arrow returns to More', (await p.evaluate(() => App.Store.state.route.view)) === 'more');
    await p.click('.page-wrap [data-action="legal-open"][data-id="privacy"]'); await p.waitForTimeout(1500);
    t = await text(p);
    rec('Privacy Policy opens inside the app with its content', t.includes('Privacy Policy') && t.includes('Who we are') && t.includes('How long we keep it'), t.slice(0, 120));
    rec('...readable at phone width (no sideways scroll)', await noSideScroll(p));
    await p.goBack(); await p.waitForTimeout(700);
    rec('the phone/browser back button also returns to More', (await p.evaluate(() => App.Store.state.route.view)) === 'more');
    await p.click('.page-wrap [data-action="legal-open"][data-id="terms"]'); await p.waitForTimeout(1500);
    rec('Terms open inside the app', (await text(p)).includes('Cancellations and refunds'));
    await p.click('.page-wrap [data-action="nav-back"]'); await p.waitForTimeout(600);
    rec('Terms back arrow returns to More', (await p.evaluate(() => App.Store.state.route.view)) === 'more');
    // opened directly (no earlier screen): sensible parent
    await p.evaluate(() => { history.replaceState({ idx: 0 }, '', location.href); });
    await p.evaluate(() => App.Nav.back('more'));
    await p.waitForTimeout(400);
    rec('with no earlier screen, back goes to the parent page (not log-in)', ['more', 'home'].includes(await p.evaluate(() => App.Store.state.route.view)) && !!(await p.evaluate(() => App.Store.state.profile)));

    // ---------------- Profile: student fields ----------------
    await route(p, 'profile'); await p.waitForTimeout(900);
    t = await text(p);
    rec('Profile: "Are you a student?", university, campus and "Verify my student email"', t.includes('Are you a student?') && !!(await p.$('select[name="student_university"]')) && !!(await p.$('select[name="student_campus"]')) && t.includes('Verify my student email'));
    rec('Profile: the old campus tick-boxes are gone (one campus control)', (await p.$$('input[type="checkbox"][name^="campus"]')).length === 0);
    // student verification box
    await p.click('[data-action="student-verify-open"]'); await p.waitForTimeout(800);
    t = await text(p);
    rec('verification box: title, message and button', t.includes('Verify Your Student Status') && t.includes('This offer is available to verified students. Enter your university email address so we can confirm your student status.') && t.includes('Verify Student Email'));
    await p.fill('#sv-email', 'u12345678@tuks.co.za');
    await p.click('form[data-form="student-verify-form"] button[type="submit"]'); await p.waitForTimeout(1200);
    t = await text(p);
    rec('submitting calls student-verify and shows the pending message', p.fnCalls.some(c => /student-verify/.test(c) && /u12345678@tuks\.co\.za/.test(c)) && t.includes("We've sent a verification email to"), p.fnCalls.join(' | '));
    rec('the browser cannot mark itself verified (still not verified in the database)', (await one(`select count(*)::int n from student_verifications where user_id = $1 and status = 'verified'`, [cust])).n === 0);
    await closeModal(p);
    // the promo check the checkout uses
    const chk = await p.evaluate(async () => (await App.sb.rpc('check_my_promo', { p_code: 'STUDENT10', p_subtotal: 15 })).data);
    rec('checkout check: an unverified student is asked to verify for the student deal', chk && chk.ok === false && chk.needs_student === true, JSON.stringify(chk));
    // student shop gate
    await route(p, 'sell'); await p.waitForTimeout(900);
    t = await text(p);
    rec('a Gmail student goes to Student Entrepreneurs (student email step) instead of a shop form', t.includes('Student Entrepreneurs') && !!(await p.$('[data-action="ent-verify"]')) && !(await p.$('form[data-form="sell-setup-form"]')));
    rec('no page errors', p.errs.length === 0, p.errs.join(' | '));
    rec('home and profile have no sideways scroll at 390px', await (async () => { await route(p, 'home'); await p.waitForTimeout(500); const a = await noSideScroll(p); await route(p, 'profile'); await p.waitForTimeout(500); return a && await noSideScroll(p); })());
    await p.ctx.close();

    // ---------------- location denied ----------------
    p = await open(cust, 'thandi.test@gmail.com');
    rec('"Current location" is offered in the ordering location bar', !!(await p.$('[data-action="order-mode"][data-mode="current"]')));
    await p.ctx.clearPermissions();
    await p.evaluate(() => { navigator.geolocation.getCurrentPosition = (ok, err) => err({ code: 1, message: 'denied' }); });
    await p.click('[data-action="order-mode"][data-mode="current"]'); await p.waitForTimeout(800);
    t = await text(p);
    rec('location denied: the page keeps working (shops still listed, says location is off, saved location still available)', t.includes('Hatfield Kota') && t.includes('Location is off') && !!(await p.$('[data-action="order-mode"][data-mode="saved"]')) && p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();

    // ---------------- standalone legal page ----------------
    p = await open(null, null, { path: 'legal/privacy-policy.html' });
    rec('the standalone Privacy Policy page has a back link and no sideways scroll', !!(await p.$('[data-legal-back]')) && await noSideScroll(p));
    await p.ctx.close();
    web.close();
  } catch (e) { rec('test run', false, e.stack || e.message); }
  if (browser) await browser.close();
  await E.stop();
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})();
