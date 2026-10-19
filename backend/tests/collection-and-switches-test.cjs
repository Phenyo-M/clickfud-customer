// Tests for collection_code_fix.sql, payment_options.sql (online payment +
// RecessBox switches), create-payfast-payment refusing while online payment is
// off, and the customer app screens. Local copy only, synthetic data.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/collection-and-switches-test.cjs <path to playwright>
const path = require('path'); const fs = require('fs'); const http = require('http'); const crypto = require('crypto');
const { startEnv } = require('./login-env.cjs');
const PW_PATH = process.argv[2];
const WEBROOT = path.join(__dirname, '../../frontend');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 220)})` : '')]);

(async () => {
  const E = await startEnv({ fnName: 'create-payfast-payment', fnPorts: [8151], dir: 'cfswitch', pg: 55641, pgrst: 3521, gw: 3522 });
  const { q } = E; const one = async (s, p) => (await q(s, p)).rows[0];
  for (const f of ['shop_test_mode.sql', 'student_extras.sql', 'seller_whatsapp.sql', 'show_partner_shops.sql', 'payment_options.sql', 'collection_code_fix.sql']) {
    try { await q(SQL(f)); } catch (e) { rec('applies ' + f, false, e.message); }
  }
  try { await q(SQL('collection_code_fix.sql')); await q(SQL('payment_options.sql')); rec('migrations apply a second time', true); } catch (e) { rec('migrations apply a second time', false, e.message); }
  await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
  await q(`notify pgrst, 'reload schema'`); await new Promise(r => setTimeout(r, 1500));

  const mgr = await E.addUser('mgr@shop.test', 'x', 'manager');
  const kit = await E.addUser('kitchen@shop.test', 'x', 'kitchen');
  const dev = await E.addUser('dev@clickfood.test', 'x', 'developer');
  const cust = await E.addUser('u12345678@tuks.co.za', 'x', 'customer');
  await q(`update profiles set university = 'University of Pretoria', campus_location = 'Hatfield', student_number = 'u12345678' where id = $1`, [cust]);
  await q(`update profiles set campuses = '{Hatfield}' where id = $1`, [cust]).catch(() => {});
  await q(`update profiles set home_address = 'Hatfield Square, Unit 4', home_lat = -25.751, home_lng = 28.238 where id = $1`, [cust]).catch(() => {});
  const shop = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind)
           values ($1, 'Kota Hub Test', 'kota-hub-test', 'Fast Food', 'Hatfield', 'Hatfield', 'University of Pretoria', 'approved', true, '00:00', '23:59', 'business') returning id`, [mgr])).id;
  await q(`update profiles set store_id = $1 where id in ($2, $3)`, [shop, mgr, kit]).catch(() => {});
  const mkOrder = async (code, extra) => {
    await q(`set session_replication_role = replica`);
    const r = await one(`insert into orders (customer_id, store_id, status, total, payment_method, items, collection_code, collection_token, order_number, delivery_location)
      values ($1, $2, 'ready', 45, 'card', '[]', $3, gen_random_uuid(), $4, '{"fulfilment":"collection"}') returning id, order_number, collection_token`, [cust, shop, code, extra || ('ORD-2026-' + String(Math.floor(Math.random() * 90000) + 10000))]);
    await q(`set session_replication_role = origin`);
    return r;
  };
  const as = async (id) => { await q('reset role'); await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await q('set role authenticated'); };
  const admin = async () => { await q('reset role'); await q(`select set_config('request.jwt.claims', '', false)`); };
  const confirm = async (who, orderId, code) => { await as(who); try { await q(`select confirm_collection($1, $2, null)`, [orderId, code]); await admin(); return 'ok'; } catch (e) { await admin(); return e.message; } };

  // ---------------- collection codes (business shops) ----------------
  let o = await mkOrder('79F06F', 'ORD-2026-00133');
  rec('the exact code works', (await confirm(mgr, o.id, '79F06F')) === 'ok');
  o = await mkOrder('79F06F', 'ORD-2026-00134');
  rec('a letter O typed for the zero works (79FO6F)', (await confirm(mgr, o.id, '79FO6F')) === 'ok');
  o = await mkOrder('A1B0C9', 'ORD-2026-00135');
  rec('lower case, spaces and a dash work (a1b-0 c9)', (await confirm(kit, o.id, ' a1b-0 c9 ')) === 'ok');
  o = await mkOrder('A1B0C9', 'ORD-2026-00136');
  rec('I or L typed for 1 works (AIB0C9 / ALBOC9)', (await confirm(kit, o.id, 'AlBOC9')) === 'ok');
  o = await mkOrder('A1B0C9', 'ORD-2026-00137');
  rec('the QR token still works', (await confirm(mgr, o.id, o.collection_token)) === 'ok');
  o = await mkOrder('A1B0C9', 'ORD-2026-00138');
  rec('a wrong code is still refused', /Invalid collection code/.test(await confirm(mgr, o.id, 'A1B0C8')));
  rec('the order number typed instead gets its own message', /That is the order number/.test(await confirm(mgr, o.id, 'ORD-2026-00138')) && /That is the order number/.test(await confirm(mgr, o.id, '138')));
  rec('an empty code is refused', /Invalid collection code/.test(await confirm(mgr, o.id, '  ')));
  rec('...and the order is still waiting for collection', (await one(`select status from orders where id = $1`, [o.id])).status === 'ready');
  const other = await E.addUser('mgr2@other.test', 'x', 'manager');
  rec('another shop\'s manager still cannot confirm it, even with the right code', !/^ok$/.test(await confirm(other, o.id, 'A1B0C9')));

  // ---------------- student sellers ----------------
  const fnDef = (await one(`select pg_get_functiondef('public.seller_update_order(uuid,text,text,text,text)'::regprocedure) d`)).d;
  rec('student seller check uses the same rule', /collection_code_matches\(o, p_code\)/.test(fnDef) && /is_order_number_entry\(o, p_code\)/.test(fnDef));

  // ---------------- switches ----------------
  await q('reset role'); await q(`select set_config('request.jwt.claims', '{"role":"anon"}', false)`); await q('set role anon');
  const flags = (await one(`select public_app_flags() f`)).f;
  rec('defaults: online payment on, RecessBox hidden, business shops hidden', flags.online_payments === true && flags.show_recessbox === false && flags.show_partner_shops === false, JSON.stringify(flags));
  let anonSet = 'ok'; try { await q(`select set_online_payments(false)`); } catch (e) { anonSet = e.message; }
  await admin();
  rec('a logged-out visitor cannot change a switch', /permission denied/.test(anonSet));
  for (const [who, id] of [['customer', cust], ['manager', mgr]]) {
    await as(id);
    const a = (await one(`select set_online_payments(false) r`)).r, b = (await one(`select set_show_recessbox(true) r`)).r;
    await admin();
    rec(`a ${who} cannot change the switches`, a.ok === false && b.ok === false);
  }
  await as(dev);
  const s1 = (await one(`select set_online_payments(false) r`)).r;
  await admin();
  rec('a developer switches online payment off, and it is audited', s1.ok === true && !!(await one(`select 1 x from ops_audit where action = 'online_payments' and outcome = 'off'`)));

  // the server refuses a new online payment while it is off
  const tok = E.jwt({ sub: cust, role: 'authenticated', email: 'u12345678@tuks.co.za', aud: 'authenticated' });
  const res = await fetch('http://127.0.0.1:8151/', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok, 'cf-connecting-ip': '198.51.100.9' }, body: JSON.stringify({ items: [], storeId: shop }) });
  const rj = await res.json().catch(() => ({}));
  rec('create-payfast-payment refuses new payments while online payment is off', /switched off/.test(rj.error || ''), JSON.stringify(rj));

  // ---------------- customer app ----------------
  const { chromium } = require(PW_PATH);
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp' };
  const web = http.createServer((req, res2) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(WEBROOT, p);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res2.writeHead(404); return res2.end(); } res2.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res2); }).listen(5651);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const userObj = { id: cust, email: 'u12345678@tuks.co.za', aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: {}, email_confirmed_at: new Date().toISOString() };
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
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:5651/'); await p.waitForTimeout(6000);
  rec('the app knows online payment is off and RecessBox is hidden', await p.evaluate(() => !App.Stores.onlinePaymentsOn() && !App.Stores.recessBoxShown()));
  rec('the Group order tile is hidden while online payment is off', await p.evaluate(() => !document.querySelector('[data-view="groups"]')));
  await p.evaluate(() => App.Store.setRoute({ view: 'more', params: {} })); await p.waitForTimeout(800);
  rec('RecessBox is not in the More menu', await p.evaluate(() => !document.querySelector('[data-action="open-campusbox"]')));
  // the ready screen of a real order: order number + code together
  const ro = await mkOrder('79F06F', 'ORD-2026-00199');
  await p.evaluate(() => App.Bootstrap && App.Bootstrap.loadPrivateData && App.Bootstrap.loadPrivateData()); await p.waitForTimeout(2500);
  await p.evaluate(() => { if (App.Modal && App.Modal.isOpen && App.Modal.isOpen()) App.Modal.close(); });   // the rating pop-up for the older test orders
  await p.evaluate((id) => App.Store.setRoute({ view: 'track', params: { orderId: id } }), ro.id); await p.waitForTimeout(1200);
  await p.evaluate(() => { if (App.Modal && App.Modal.isOpen && App.Modal.isOpen()) App.Modal.close(); App.render(); }); await p.waitForTimeout(600);
  const pair = await p.evaluate(() => { const b = document.querySelector('.collect-pair'); return b ? b.innerText : ''; });
  const where = pair ? '' : await p.evaluate(() => { const t = document.querySelector('#app') || document.body; return Array.from(t.querySelectorAll('h3')).map(h => h.textContent).join(' / ') + ' | cards=' + t.querySelectorAll('.card').length; });
  rec('the ready screen shows the order number and the collection code together', /ORD-2026-00199/.test(pair) && /79F06F/.test(pair), pair ? pair.replace(/\s+/g, ' ') : where);
  await p.screenshot({ path: path.join(__dirname, 'lt', 'ready-screen.png'), fullPage: true });
  rec('no page errors', !errs.length, errs.join(' | '));
  await browser.close(); web.close(); await E.stop();
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch(e => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); process.exit(1); });
