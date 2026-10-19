// Browser test for poll_review.sql: a manager sends a poll for review in the
// Staff app, students don't see it on the Campus page, the developer sees it
// in Pending Tasks and the review list, approves it, and only then students
// see and vote in it. A rejected poll shows the reason to the manager.
// Local copy, synthetic data.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/poll-review-ui-test.cjs <path to playwright>
const path = require('path'); const fs = require('fs'); const http = require('http');
const { startEnv } = require('./login-env.cjs');
const PW_PATH = process.argv[2];
const CUST = path.join(__dirname, '../../frontend');
const STAFF = path.join(__dirname, '../../../Campus Eats Staff/frontend');
const DEV = path.join(__dirname, '../../../Campus Eats Developer/frontend');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 260)})` : '')]);

(async () => {
  const E = await startEnv({ fnPorts: [8211], dir: 'cfpollui', pg: 55791, pgrst: 3631, gw: 3632 });
  const { q } = E; const one = async (s, p) => (await q(s, p)).rows[0];
  let browser; const servers = [];
  try {
    for (const f of ['show_partner_shops.sql', 'payment_options.sql', 'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'shop_locations.sql', 'privacy_legal.sql', 'student_entrepreneurs.sql', 'engagement_deals.sql', 'poll_review.sql', 'promo_review.sql']) await q(SQL(f));
    await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
    await q(`notify pgrst, 'reload schema'`); await new Promise(r => setTimeout(r, 1500));
    const mgr = await E.addUser('mgr@shop.test', 'x', 'manager');
    const shop = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, location_type, logo_url, cover_image_url)
      values ($1, 'Hatfield Kota', 'hatfield-kota', 'Fast Food', 'Hatfield', 'Shop 4, Student Centre', 'University of Pretoria', 'approved', true, '00:00', '23:59', 'business', 'campus', 'https://x/l.webp', 'https://x/c.webp') returning id`, [mgr])).id;
    await q(`update profiles set store_id = $1 where id = $2`, [shop, mgr]);
    const item = (await one(`insert into menu_items (store_id, name, category, price, status, available, stock, image, description) values ($1, 'Cheese Kota', 'Lunch', 45, 'approved', true, 50, 'https://x/i.webp', 'Kota') returning id`, [shop])).id;
    const dev = await E.addUser('dev@clickfood.test', 'x', 'developer');
    const stu = await E.addUser('lerato@gmail.com', 'x', 'customer');
    const UP = (await one(`select id from universities where name = 'University of Pretoria'`)).id;
    await q(`update profiles set is_student = true, university = 'University of Pretoria', campus_location = 'Hatfield', home_university_id = $2, home_address = 'Hatfield Square', home_lat = -25.751, home_lng = 28.238 where id = $1`, [stu, UP]);
    await q(`insert into legal_acceptances (user_id, document, version) values ($1, 'terms', '2026-10-17.2'), ($1, 'privacy', '2026-10-17.2')`, [stu]);

    const { chromium } = require(PW_PATH);
    const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
    const serve = (root, port) => { const s = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(port); servers.push(s); };
    serve(STAFF, 5701); serve(DEV, 5702); serve(CUST, 5703);
    browser = await chromium.launch();
    async function open(port, user, email) {
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
      await p.goto(`http://localhost:${port}/`); await p.waitForTimeout(6000);
      p.ctx = ctx; return p;
    }
    const text = (p) => p.evaluate(() => document.body.innerText);
    const go = (p, view) => p.evaluate((v) => App.Store.setRoute({ view: v, params: {} }), view);
    const toast = (p) => p.evaluate(() => Array.from(document.querySelectorAll('.toast')).map(t => t.innerText).join(' | '));
    const studentPolls = async () => {
      const s = await open(5703, stu, 'lerato@gmail.com');
      await go(s, 'campus'); await s.waitForTimeout(1500);
      await s.click('[data-action="camp-tab"][data-key="polls"]'); await s.waitForTimeout(1500);
      return s;
    };

    // ---------------- manager sends a poll ----------------
    let p = await open(5701, mgr, 'mgr@shop.test');
    await go(p, 'promotions'); await p.waitForTimeout(1500);
    await p.waitForSelector('[data-action="poll-new"]', { timeout: 15000 });
    await p.click('[data-action="poll-new"]'); await p.waitForTimeout(500);
    rec('the manager\'s poll button says "Send for review"', (await p.evaluate(() => document.querySelector('form[data-form="poll-form"] button[type="submit"]').innerText.trim())) === 'Send for review');
    await p.fill('form[data-form="poll-form"] [name="question"]', 'Which new kota should we add?');
    const opts = await p.$$('form[data-form="poll-form"] [name="option"]');
    await opts[0].fill('Cheese kota'); await opts[1].fill('Russian kota');
    await p.click('form[data-form="poll-form"] button[type="submit"]'); await p.waitForTimeout(1500);
    const row = await one(`select id, status from polls where store_id = $1`, [shop]);
    rec('saving sends it for review (database status pending_review)', row && row.status === 'pending_review' && /Poll sent for review/.test(await toast(p)), JSON.stringify(row) + ' ' + await toast(p));
    rec('the manager sees "Waiting for review"', (await text(p)).includes('Waiting for review') && !!(await p.$('[data-poll-status="pending_review"]')));
    rec('no page errors (manager)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();

    // ---------------- students don't see it yet ----------------
    let s = await studentPolls();
    rec('students do not see the poll before review', !(await text(s)).includes('Which new kota should we add?'));
    await s.ctx.close();

    // ---------------- developer reviews ----------------
    p = await open(5702, dev, 'dev@clickfood.test');
    await go(p, 'promotions'); await p.waitForTimeout(2000);
    await go(p, 'dashboard'); await p.waitForTimeout(1000);
    const tasksText = await text(p);
    await go(p, 'promotions'); await p.waitForTimeout(1500);
    let t = await text(p);
    rec('the developer sees it under "Polls waiting for review" with the shop name and options', t.includes('Polls waiting for review') && t.includes('Which new kota should we add?') && t.includes('Hatfield Kota') && t.includes('Russian kota'));
    rec('Pending Tasks counts it', /Shop polls awaiting review/.test(tasksText) || (await p.evaluate(() => App.Campaigns.pendingCount())) === 1, tasksText.slice(0, 120));
    await p.click(`[data-action="cmp-poll-approve"][data-id="${row.id}"]`); await p.waitForTimeout(500);
    await p.click('[data-confirm-ok]'); await p.waitForTimeout(1500);
    rec('approving publishes it', (await one(`select status from polls where id = $1`, [row.id])).status === 'published' && !(await text(p)).includes('Polls waiting for review'), await toast(p));
    rec('no page errors (developer)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();

    // ---------------- students see and vote ----------------
    s = await studentPolls();
    rec('after approval students see the poll', (await text(s)).includes('Which new kota should we add?'));
    await s.click(`[data-action="camp-vote"][data-id="${row.id}"][data-option="1"]`); await s.waitForTimeout(1500);
    rec('a student votes', (await one(`select count(*)::int n from poll_votes where poll_id = $1`, [row.id])).n === 1 && (await text(s)).includes('(your vote)'));
    rec('no page errors (student)', s.errs.length === 0, s.errs.join(' | '));
    await s.ctx.close();

    // ---------------- a rejected poll ----------------
    const p2 = (await one(`insert into polls (question, options, store_id, created_by) values ('Rate us from one to three', array['1','2','3'], $1, $2) returning id`, [shop, mgr])).id;
    p = await open(5702, dev, 'dev@clickfood.test');
    await go(p, 'promotions'); await p.waitForTimeout(2000);
    await p.click(`[data-action="cmp-poll-reject"][data-id="${p2}"]`); await p.waitForTimeout(500);
    await p.fill('form[data-form="cmp-poll-reject-form"] [name="note"]', 'Please ask about food, not ratings.');
    await p.click('form[data-form="cmp-poll-reject-form"] button[type="submit"]'); await p.waitForTimeout(1500);
    rec('the developer rejects with a reason', (await one(`select status, review_note from polls where id = $1`, [p2])).status === 'rejected');
    await p.ctx.close();
    p = await open(5701, mgr, 'mgr@shop.test');
    await go(p, 'promotions'); await p.waitForTimeout(2000);
    t = await text(p);
    rec('the manager sees "Not approved" and the reason', t.includes('Not approved') && t.includes('Please ask about food, not ratings.'));
    rec('...and the approved one as Published', t.includes('Published'));
    await p.ctx.close();
    s = await studentPolls();
    rec('students never see the rejected poll', !(await text(s)).includes('Rate us from one to three'));
    await s.ctx.close();

    // ================= promo codes =================
    p = await open(5701, mgr, 'mgr@shop.test');
    await go(p, 'promotions'); await p.waitForTimeout(1500);
    const made = await p.evaluate(async (itemId) => {
      const r = await App.Promotions.create({ code: 'KOTA15', type: 'fixed', value: 15, active: true, menu_item_ids: [itemId], is_public: true, title: 'Lunch Kota R15 off', deal_tags: ['lunch'], audience: 'everyone' });
      App.render(); return r.error || (r.data && r.data.review_status);
    }, item);
    await p.waitForTimeout(800);
    rec('promo: a manager\'s new code is saved as waiting for review', made === 'pending_review', made);
    rec('promo: the manager sees "Waiting for review" on the code', !!(await p.$('[data-promo-review="pending_review"]')) && (await text(p)).includes('KOTA15'));
    rec('promo: no page errors (manager)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();
    const deals = async () => { const c = await open(5703, stu, 'lerato@gmail.com'); await go(c, 'campus'); await c.waitForTimeout(1500); return c; };
    s = await deals();
    rec('promo: students do not see it in Campus Deals before review', !(await text(s)).includes('Lunch Kota R15 off'));
    const early = await s.evaluate(() => App.Promotions.validateCode('KOTA15', [{ menuItemId: 'x', price: 45, qty: 1 }]).error || 'accepted');
    rec('promo: typing the code at checkout is refused', /not valid/.test(early), early);
    await s.ctx.close();
    p = await open(5702, dev, 'dev@clickfood.test');
    await go(p, 'promotions'); await p.waitForTimeout(2500);
    t = await text(p);
    rec('promo: the developer sees it under "Promo codes waiting for review" with shop, discount and product', t.includes('Promo codes waiting for review') && t.includes('KOTA15') && t.includes('Hatfield Kota') && t.includes('Cheese Kota') && /R\s?15/.test(t));
    const pr = (await one(`select id from promotions where code = 'KOTA15'`)).id;
    await p.click(`[data-action="prv-approve"][data-id="${pr}"]`); await p.waitForTimeout(500);
    await p.click('[data-confirm-ok]'); await p.waitForTimeout(1500);
    rec('promo: approving it works', (await one(`select review_status s from promotions where id = $1`, [pr])).s === 'approved' && !(await text(p)).includes('Promo codes waiting for review'));
    rec('promo: no page errors (developer)', p.errs.length === 0, p.errs.join(' | '));
    await p.ctx.close();
    s = await deals();
    rec('promo: after approval students see it in Campus Deals', (await text(s)).includes('Lunch Kota R15 off'));
    rec('promo: no page errors (student)', s.errs.length === 0, s.errs.join(' | '));
    await s.ctx.close();
    // a change goes back to review and the manager is told
    await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: mgr, role: 'authenticated' })]);
    await q(`update promotions set value = 40 where id = $1`, [pr]);
    await q(`select set_config('request.jwt.claims', '', false)`);
    rec('promo: changing the discount sends it back for review', (await one(`select review_status s from promotions where id = $1`, [pr])).s === 'pending_review');
    p = await open(5702, dev, 'dev@clickfood.test');
    await go(p, 'promotions'); await p.waitForTimeout(2500);
    await p.click(`[data-action="prv-reject"][data-id="${pr}"]`); await p.waitForTimeout(500);
    await p.fill('form[data-form="prv-reject-form"] [name="note"]', 'R40 off a R45 kota looks like a mistake.');
    await p.click('form[data-form="prv-reject-form"] button[type="submit"]'); await p.waitForTimeout(1500);
    rec('promo: the developer rejects the change with a reason', (await one(`select review_status s from promotions where id = $1`, [pr])).s === 'rejected');
    await p.ctx.close();
    p = await open(5701, mgr, 'mgr@shop.test');
    await go(p, 'promotions'); await p.waitForTimeout(1500);
    t = await text(p);
    rec('promo: the manager sees "Not approved" and the reason', t.includes('Not approved') && t.includes('looks like a mistake'));
    await p.ctx.close();
  } catch (e) { rec('test run', false, e.stack || e.message); }
  finally {
    try { if (browser) await browser.close(); } catch (e) {}
    for (const s of servers) s.close();
    await E.stop();
  }
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})();
