// Local test of supabase/functions/payfast-cancel-order with cancel reasons.
// Runs the real function in Deno against a local copy of the live structure
// (PostgREST + a tiny gateway that answers /auth/v1/user from the JWT).
//   DENO_BIN=... NODE_PATH=tests/lt/node_modules node tests/customer-cancel-test.cjs
const path = require('path'); const fs = require('fs'); const http = require('http'); const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');

const PG = 55501, PGRST = 3421, GW = 3422, DIR = path.join(LT, 'cfcancel');
const SECRET = 'local-cancel-secret-not-used-anywhere-else-0123456789abcd';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ exp: Math.floor(Date.now() / 1000) + 7200, ...c }); return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x ? ` (${x})` : '')]);
const procs = []; const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const db = await build(PG, DIR); const q = (s, p) => db.query(s, p);
  await q(`reset role; select set_config('request.jwt.claims', '', false)`);
  for (const f of ['student_sellers.sql', 'seller_review_address.sql', 'student_collection_times.sql', 'student_order_codes.sql', 'approval_emails.sql', 'notification_queue.sql']) await q(fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8'));
  await q(`grant usage on schema public to anon, authenticated, service_role; grant all on all tables in schema public to service_role;`);
  const U = { seller: '11111111-1111-4111-8111-111111111111', buyer: '33333333-3333-4333-8333-333333333333', other: '44444444-4444-4444-8444-444444444444' };
  for (const [k, id] of Object.entries(U)) {
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, `u${k}@tuks.co.za`]);
    await q(`insert into profiles (id, name, email, role, status, active) values ($1, $2, $3, 'customer', 'approved', true)`, [id, k + ' Test', `u${k}@tuks.co.za`]);
  }
  const shop = (await q(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, seller_kind, opening_time, closing_time, closed_days, pickup_lat, pickup_lng, cover_image_url)
    values ($1, 'Mpho Kitchen', 'mpho', 'Student Food', 'Hatfield', 'Tuks Village', 'University of Pretoria', 'approved', true, 'student', '00:00', '00:00', '{}', -25.75, 28.23, 'https://x/p.webp') returning id`, [U.seller])).rows[0].id;
  const item = (await q(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, 'Pap', 'Lunch', 30, 'x', 'Pap and wors plate', 'approved', true, 50) returning id`, [shop])).rows[0].id;
  for (const n of ['Wrap', 'Vetkoek', 'Scones', 'Malva']) await q(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, $2, 'Lunch', 20, 'x', 'Fresh and tasty food', 'approved', true, 50)`, [shop, n]);
  const placeOrder = async () => {
    await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U.buyer, role: 'authenticated' })]); await q('set role authenticated');
    const r = (await q(`insert into orders (customer_id, store_id, items, payment_method, total, delivery_location) values (auth.uid(), $1, $2, 'cod', 1, $3) returning *`,
      [shop, JSON.stringify([{ menuItemId: item, name: 'Pap', qty: 1, price: 30 }]), JSON.stringify({ fulfilment: 'collection', collectionTime: new Date(Date.now() + 3600000).toISOString() })])).rows[0];
    await q(`reset role; select set_config('request.jwt.claims', '', false)`);
    return r;
  };

  fs.writeFileSync(path.join(LT, 'pgrst-cancel.conf'), `db-uri = "postgres://authenticator:authpw@127.0.0.1:${PG}/postgres"\ndb-schemas = "public"\ndb-anon-role = "anon"\njwt-secret = "${SECRET}"\nserver-port = ${PGRST}\nlog-level = "error"\n`);
  procs.push(spawn(path.join(LT, 'postgrest/postgrest.exe'), [path.join(LT, 'pgrst-cancel.conf')], { env: { ...process.env, PATH: BIN + ';' + process.env.PATH } }));
  const gw = http.createServer((req, res) => {
    const chunks = []; req.on('data', d => chunks.push(d)); req.on('end', () => {
      if (req.url.startsWith('/auth/v1/user')) {
        try {
          const [h, p, sg] = (req.headers.authorization || '').replace(/^Bearer /, '').split('.');
          if (crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url') !== sg) throw 0;
          const c = JSON.parse(Buffer.from(p, 'base64url').toString());
          res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: c.sub, aud: 'authenticated', role: 'authenticated' }));
        } catch { res.writeHead(401); return res.end('{}'); }
      }
      if (!req.url.startsWith('/rest/v1/')) { res.writeHead(404); return res.end(); }
      const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
      const up = http.request({ host: '127.0.0.1', port: PGRST, path: req.url.slice(8), method: req.method, headers }, (r2) => { res.writeHead(r2.statusCode, r2.headers); r2.pipe(res); });
      up.on('error', e => { res.writeHead(502); res.end(String(e)); }); up.end(Buffer.concat(chunks));
    });
  }).listen(GW);
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PGRST}/`); break; } catch { await sleep(200); } }
  const fn = spawn(process.env.DENO_BIN || 'deno', ['run', '-A', path.join(__dirname, '../supabase/functions/payfast-cancel-order/index.ts')], {
    env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${GW}`, SUPABASE_ANON_KEY: jwt({ role: 'anon' }), SUPABASE_SERVICE_ROLE_KEY: jwt({ role: 'service_role' }) },
  });
  procs.push(fn); let log = ''; fn.stderr.on('data', d => log += d); fn.stdout.on('data', d => log += d);
  for (let i = 0; i < 150; i++) { try { await fetch('http://127.0.0.1:8000/', { method: 'OPTIONS' }); break; } catch { await sleep(300); } }
  const cancel = (who, body) => fetch('http://127.0.0.1:8000/', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt({ sub: who, role: 'authenticated' }) }, body: JSON.stringify(body) }).then(r => r.json());

  const o1 = await placeOrder();
  let r = await cancel(U.other, { orderId: o1.id, reason: 'too_slow' });
  rec('someone else cannot cancel the order', /does not belong/.test(r.error || ''), r.error);
  r = await cancel(U.buyer, { orderId: o1.id, reason: 'other' });
  rec('"Other" needs a note', /tell us why/.test(r.error || ''), r.error || JSON.stringify(r).slice(0, 80) + log.slice(-200));
  r = await cancel(U.buyer, { orderId: o1.id, reason: 'item_unavailable', note: 'Seller said no pap today' });
  const c1 = (await q(`select status, cancel_reason, cancel_note from orders where id = $1`, [o1.id])).rows[0];
  rec('customer cancels with a reason', r.ok === true && c1.status === 'cancelled' && c1.cancel_reason === 'customer_cancelled', JSON.stringify(c1));
  rec('reason saved on the order', c1.cancel_note === "Customer: The seller doesn't have what I ordered (Seller said no pap today)", c1.cancel_note);
  // the seller hears it from the notification queue (orders trigger), not from the function
  const sn = (await q(`select payload->>'message' message from notification_jobs where recipient_id = $1 and event_type = 'order_cancelled_by_customer' and channel = 'in_app' order by created_at desc limit 1`, [U.seller])).rows[0];
  rec('seller told why', sn && /cancelled by the customer\. Reason: The seller doesn't have what I ordered \(Seller said no pap today\)/.test(sn.message), sn && sn.message);
  r = await cancel(U.buyer, { orderId: o1.id, reason: 'too_slow' });
  rec('cannot cancel twice', /can no longer be cancelled/.test(r.error || ''), r.error);
  const o2 = await placeOrder();
  r = await cancel(U.buyer, { orderId: o2.id });
  rec('older app versions without a reason still work', r.ok === true && (await q(`select cancel_note from orders where id = $1`, [o2.id])).rows[0].cancel_note === 'Customer: No reason given');
  const o3 = await placeOrder();
  await q(`update orders set status = 'ready' where id = $1`, [o3.id]);
  r = await cancel(U.buyer, { orderId: o3.id, reason: 'too_slow' });
  rec('a ready order cannot be cancelled', /can no longer be cancelled/.test(r.error || ''), r.error);

  gw.close(); procs.forEach(p => { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { p.kill(); } }); await db.end();
  execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' });
  for (const [s, n] of results) console.log(s, n);
  const failed = results.filter(x => x[0] !== 'PASS').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { for (const [s, n] of results) console.log(s, n); console.error(e); procs.forEach(p => { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { p.kill(); } }); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
