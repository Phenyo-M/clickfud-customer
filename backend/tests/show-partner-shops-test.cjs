// Test for supabase/show_partner_shops.sql + the customer app's shop list.
// Local copy of the database, real customer app in a browser. Synthetic data.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/show-partner-shops-test.cjs <path to playwright>
const path = require('path'); const fs = require('fs'); const http = require('http');
const { startEnv } = require('./login-env.cjs');
const PW_PATH = process.argv[2];
const WEBROOT = path.join(__dirname, '../../frontend');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x ? ` (${String(x).slice(0, 200)})` : '')]);

(async () => {
  const E = await startEnv({ fnPorts: [8141], dir: 'cfpartner', pg: 55631, pgrst: 3511, gw: 3512 });
  const { q } = E; const one = async (s, p) => (await q(s, p)).rows[0];
  await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
  await q(fs.readFileSync(path.join(__dirname, '../supabase/show_partner_shops.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(__dirname, '../supabase/show_partner_shops.sql'), 'utf8'));
  await q(`notify pgrst, 'reload schema'`); await new Promise(r => setTimeout(r, 1500));
  rec('migration applies twice', true);
  const dev = await E.addUser('dev@clickfood.test', 'x', 'developer');
  const cust = await E.addUser('u12345678@tuks.co.za', 'x', 'customer');
  const mgr = await E.addUser('mgr@shop.test', 'x', 'manager');
  await q(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind)
           values ($1, 'Kota Hub Test', 'kota-hub-test', 'Fast Food', 'Hatfield', 'Hatfield', 'University of Pretoria', 'approved', true, '00:00', '23:59', 'business')`, [mgr]);
  const as = async (who, id) => { await q('reset role'); await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(who === 'anon' ? { role: 'anon' } : { sub: id, role: 'authenticated' })]); await q(who === 'anon' ? 'set role anon' : 'set role authenticated'); };
  const tryq = async (s) => { try { return { rows: (await q(s)).rows }; } catch (e) { return { err: e.message }; } };

  await as('anon');
  rec('a guest can read the switch', (await tryq(`select public_app_flags() r`)).rows[0].r.show_partner_shops === false);
  rec('a guest cannot change it', !!(await tryq(`select set_show_partner_shops(true)`)).err);
  await as('auth', cust);
  rec('a customer cannot change it', (await tryq(`select set_show_partner_shops(true) r`)).rows[0].r.ok === false);
  await as('auth', mgr);
  rec('a shop manager cannot change it', (await tryq(`select set_show_partner_shops(true) r`)).rows[0].r.ok === false);
  await q('reset role'); await q(`select set_config('request.jwt.claims', '', false)`);
  rec('...and it is still off', (await one(`select show_partner_shops s from platform_config where id = 1`)).s === false);

  // ---- the real customer app, off then on ----
  const { chromium } = require(PW_PATH);
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
  const web = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(WEBROOT, p);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(5641);
  const browser = await chromium.launch();
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => { try { localStorage.setItem('clickfud_onboarding_completed', 'true'); } catch (e) {} });
    try { await ctx.routeWebSocket(/supabase\.co/, (ws) => ws.close()); } catch (e) {}
    await ctx.route(/supabase\.co/, async (route) => {
      const req = route.request(); const u = new URL(req.url());
      if (u.pathname.startsWith('/rest/v1/')) {
        const headers = { ...req.headers() }; headers.authorization = 'Bearer ' + E.jwt({ role: 'anon' }); delete headers.apikey; delete headers.host;
        try { return route.fulfill({ response: await route.fetch({ url: `${E.pgrstUrl}${u.pathname.slice(8)}${u.search}`, headers }) }); } catch (e) { return route.abort(); }
      }
      return route.fulfill({ json: {} });
    });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:5641/'); await p.waitForTimeout(5000);
    const shown = await p.evaluate(() => App.Pages.Home.allStores().some(s => s.name === 'Kota Hub Test'));
    const flag = await p.evaluate(() => App.Stores.partnersShown());
    if (flag !== shown) errs.push('flag ' + flag + ' but shown ' + shown);
    await ctx.close(); return { shown, errs };
  };
  let r = await open();
  rec('switch off: business shops stay hidden in the customer app', r.shown === false);
  await as('auth', dev);
  const set = (await tryq(`select set_show_partner_shops(true) r`)).rows[0].r;
  await q('reset role'); await q(`select set_config('request.jwt.claims', '', false)`);
  rec('a developer switches it on, and it is audited', set.ok === true && !!(await one(`select 1 x from ops_audit where action = 'show_partner_shops' and outcome = 'shown'`)));
  r = await open();
  rec('switch on: the business shop appears in the customer app', r.shown === true);
  rec('no page errors', !r.errs.length, r.errs.join(' | '));
  await browser.close(); web.close(); await E.stop();
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); process.exit(1); });
