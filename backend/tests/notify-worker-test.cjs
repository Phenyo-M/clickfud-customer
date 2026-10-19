// Local end-to-end test of supabase/functions/notify-worker: the real
// function in Deno against a local copy of the live structure (PostgREST +
// a tiny gateway), a fake Web Push service, and test VAPID keys (never the
// real ones). Needs a local test CA in tests/lt/certs (git-ignored):
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout ca-key.pem -out ca.pem -days 30 -subj "/CN=ClickFood Test CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
//   openssl req -newkey rsa:2048 -nodes -keyout key.pem -out leaf.csr -subj "/CN=127.0.0.1"
//   openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out cert.pem -days 30 -extfile leaf.ext   (leaf.ext: subjectAltName=IP:127.0.0.1)
// Run:
//   DENO_BIN=.../deno.exe NODE_PATH=tests/lt/node_modules node tests/notify-worker-test.cjs
const path = require('path'); const fs = require('fs'); const http = require('http'); const https = require('https'); const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');

const PG = 55511, PGRST = 3431, GW = 3432, PUSHSRV = 3433, DIR = path.join(LT, 'cfworker');
const SECRET = 'local-worker-secret-not-used-anywhere-else-0123456789abcd';
const WORKER_SECRET = 'test-worker-secret-123';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ exp: Math.floor(Date.now() / 1000) + 7200, ...c }); return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x ? ` (${x})` : '')]);
const procs = []; const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');

(async () => {
  const db = await build(PG, DIR); const q = (s, p) => db.query(s, p);
  await q(`reset role; select set_config('request.jwt.claims', '', false)`);
  for (const f of ['student_sellers.sql', 'seller_review_address.sql', 'approval_emails.sql', 'notification_links.sql', 'student_collection_times.sql', 'student_order_codes.sql', 'notification_queue.sql']) await q(SQL(f));
  await q(`grant usage on schema public to anon, authenticated, service_role; grant all on all tables in schema public to service_role;`);

  const U = { cust: '33333333-3333-4333-8333-333333333333', mgr: '66666666-6666-4666-8666-666666666666', kit: '77777777-7777-4777-8777-777777777777' };
  for (const [k, id] of Object.entries(U)) {
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, `${k}@test.co.za`]);
    await q(`insert into profiles (id, name, email, role, status, active) values ($1, $2, $3, $4, 'approved', true)`, [id, k + ' Tester', `${k}@test.co.za`, k === 'cust' ? 'customer' : k === 'mgr' ? 'manager' : 'kitchen']);
  }
  const shop = (await q(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time)
    values ($1, 'Kota Shop', 'kota-shop', 'Fast Food', 'Hatfield', 'Shop 3', 'University of Pretoria', 'approved', true, '00:00', '00:00') returning id`, [U.mgr])).rows[0].id;
  await q(`update profiles set store_id = $1 where id in ($2, $3)`, [shop, U.mgr, U.kit]);
  const item = (await q(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, 'Kota', 'Lunch', 35, 'x', 'Classic kota with chips', 'approved', true, 500) returning id`, [shop])).rows[0].id;
  const placeOrder = async () => {
    await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U.cust, role: 'authenticated' })]); await q('set role authenticated');
    const r = (await q(`insert into orders (customer_id, store_id, items, payment_method, payment_status, status, status_history, total, delivery_location)
      values (auth.uid(), $1, $2, 'cod', 'pending', 'preparing', '[{"status":"received"},{"status":"preparing"}]', 35, '{"fulfilment":"collection"}') returning *`,
      [shop, JSON.stringify([{ menuItemId: item, name: 'Kota', qty: 2, price: 17.5 }])])).rows[0];
    await q(`reset role; select set_config('request.jwt.claims', '', false)`);
    return r;
  };
  const setStatus = (id, status) => q(`update orders set status = $2, status_history = status_history || jsonb_build_array(jsonb_build_object('status', $2::text)) where id = $1`, [id, status]);

  // fake push service: /ok accepts, /gone says the subscription expired, /down errors
  const pushHits = [];
  // HTTPS like a real push service (web-push only speaks HTTPS); a local
  // self-signed cert in tests/lt/certs, trusted by Deno for 127.0.0.1 only
  const ps = https.createServer({ key: fs.readFileSync(path.join(LT, 'certs/key.pem')), cert: fs.readFileSync(path.join(LT, 'certs/cert.pem')) }, (req, res) => { pushHits.push(req.url); req.resume(); req.on('end', () => {
    if (req.url.startsWith('/ok')) { res.writeHead(201); return res.end(); }
    if (req.url.startsWith('/gone')) { res.writeHead(410); return res.end(); }
    res.writeHead(500); res.end('down');
  }); }).listen(PUSHSRV);
  const devKeys = () => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return { p256dh: e.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }; };
  const addSub = (user, kind) => { const k = devKeys(); return q(`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)`, [user, `https://127.0.0.1:${PUSHSRV}/${kind}/${crypto.randomUUID()}`, k.p256dh, k.auth]); };
  const vapid = crypto.createECDH('prime256v1'); vapid.generateKeys();

  fs.writeFileSync(path.join(LT, 'pgrst-worker.conf'), `db-uri = "postgres://authenticator:authpw@127.0.0.1:${PG}/postgres"\ndb-schemas = "public"\ndb-anon-role = "anon"\njwt-secret = "${SECRET}"\nserver-port = ${PGRST}\nlog-level = "error"\n`);
  const pgrst = spawn(path.join(LT, 'postgrest/postgrest.exe'), [path.join(LT, 'pgrst-worker.conf')], { env: { ...process.env, PATH: BIN + ';' + process.env.PATH } });
  let pgrstLog = ''; pgrst.stderr.on('data', d => pgrstLog += d); pgrst.stdout.on('data', d => pgrstLog += d); procs.push(pgrst);
  const gw = http.createServer((req, res) => {
    const chunks = []; req.on('data', d => chunks.push(d)); req.on('end', () => {
      if (!req.url.startsWith('/rest/v1/')) { res.writeHead(404); return res.end(); }
      const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
      const up = http.request({ host: '127.0.0.1', port: PGRST, path: req.url.slice(8), method: req.method, headers }, (r2) => { res.writeHead(r2.statusCode, r2.headers); r2.pipe(res); });
      up.on('error', e => { res.writeHead(502); res.end(String(e)); }); up.end(Buffer.concat(chunks));
    });
  }).listen(GW);
  let up = false;
  for (let i = 0; i < 75; i++) { try { await fetch(`http://127.0.0.1:${PGRST}/`); up = true; break; } catch { await sleep(200); } }
  if (!up) throw new Error('PostgREST did not start: ' + pgrstLog.slice(-500));
  const fn = spawn(process.env.DENO_BIN || 'deno', ['run', '-A', path.join(__dirname, '../supabase/functions/notify-worker/index.ts')], {
    env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${GW}`, SUPABASE_SERVICE_ROLE_KEY: jwt({ role: 'service_role' }), NOTIFY_WORKER_SECRET: WORKER_SECRET,
           VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: vapid.getPrivateKey().toString('base64url'), VAPID_SUBJECT: 'mailto:test@example.com', DENO_CERT: path.join(LT, 'certs/ca.pem'), NODE_EXTRA_CA_CERTS: path.join(LT, 'certs/ca.pem') },
  });
  procs.push(fn); let log = ''; fn.stderr.on('data', d => log += d); fn.stdout.on('data', d => log += d);
  for (let i = 0; i < 200; i++) { try { await fetch('http://127.0.0.1:8000/', { method: 'GET' }); break; } catch { await sleep(300); } }
  const run = (secret = WORKER_SECRET) => fetch('http://127.0.0.1:8000/', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-worker-secret': secret }, body: '{}' })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const job = (orderId, event, channel, who) => q(`select * from notification_jobs where payload->>'order_id' = $1 and event_type = $2 and channel = $3 and recipient_id = $4`, [orderId, event, channel, who]).then(r => r.rows[0]);

  // ---- devices: manager has a working phone, kitchen's subscription expired ----
  await addSub(U.mgr, 'ok'); await addSub(U.kit, 'gone');

  let r = await run('wrong');
  rec('worker refuses calls without the secret', r.status === 401, String(r.status));
  r = await run('');
  rec('worker refuses calls with no secret', r.status === 401, String(r.status));

  // ---- new order ----
  const o1 = await placeOrder();
  r = await run();
  rec('worker run succeeds', r.status === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 200) + log.slice(-300));
  const n1 = (await q(`select user_id, message, type, job_id from notifications where job_id is not null order by created_at`)).rows;
  rec('in-app notifications written for customer, manager and kitchen', [U.cust, U.mgr, U.kit].every(u => n1.some(n => n.user_id === u)) && n1.length === 3, String(n1.length));
  const jc = await job(o1.id, 'order_placed', 'in_app', U.cust);
  rec('in-app job sent, provider id = the notification row', jc.status === 'sent' && n1.some(n => n.job_id === jc.id) && !!jc.provider_message_id && jc.sent_at);
  const jm = await job(o1.id, 'order_new', 'push', U.mgr);
  rec('manager push sent to the working phone', jm.status === 'sent' && /^push:1\/1$/.test(jm.provider_message_id) && pushHits.some(h => h.startsWith('/ok/')), JSON.stringify({ s: jm.status, e: jm.error, p: jm.provider_message_id }));
  const jk = await job(o1.id, 'order_new', 'push', U.kit);
  const ksub = (await q(`select invalid_at from push_subscriptions where user_id = $1`, [U.kit])).rows[0];
  rec('expired kitchen subscription marked invalid, job skipped (not retried)', jk.status === 'skipped' && ksub.invalid_at !== null, JSON.stringify({ s: jk.status, e: jk.error }));
  rec('a new-order alert has no email fallback (not an important customer event)', (await q(`select count(*)::int n from notification_jobs where payload ? 'fallback_from'`)).rows[0].n === 0);
  r = await run();
  rec('running again sends nothing twice', (await q(`select count(*)::int n from notifications where job_id is not null`)).rows[0].n === 3);

  // ---- ready: customer has no phone -> email fallback ----
  await setStatus(o1.id, 'ready');
  r = await run();
  const jr = await job(o1.id, 'order_ready', 'push', U.cust);
  rec('ready push with no phone: skipped', jr.status === 'skipped' && /No phone/.test(jr.error || ''), JSON.stringify({ s: jr.status, e: jr.error }));
  r = await run();
  const fb = (await q(`select status, provider_message_id from notification_jobs where payload->>'fallback_from' = $1`, [jr.id])).rows[0];
  rec('falls back to an email for "ready", which is sent through the email queue', fb && fb.status === 'sent' && /^email_outbox:/.test(fb.provider_message_id), JSON.stringify(fb));
  const ob1 = fb && (await q(`select kind, recipient_email, data from email_outbox where id = $1`, [fb.provider_message_id.split(':')[1]])).rows[0];
  rec('ready email queued with the order message', ob1 && ob1.kind === 'order_ready' && ob1.recipient_email === 'cust@test.co.za' && /ready for collection/.test(ob1.data.message || ''), ob1 && ob1.kind);

  // ---- collected: receipt email with items, delivery status flows back ----
  await setStatus(o1.id, 'collected');
  r = await run();
  const je = await job(o1.id, 'order_collected', 'email', U.cust);
  const ob2 = je && je.provider_message_id && (await q(`select id, kind, data from email_outbox where id = $1`, [je.provider_message_id.split(':')[1]])).rows[0];
  rec('receipt email queued with the items and total', je && je.status === 'sent' && ob2 && ob2.kind === 'order_collected' && ob2.data.items.length === 1 && Number(ob2.data.total) === Number(o1.total) && ob2.data.shop_name === 'Kota Shop', JSON.stringify(ob2 && ob2.data).slice(0, 160));
  await q(`update email_outbox set status = 'delivered' where id = $1`, [ob2.id]);
  rec('email delivered receipt marks the job delivered', (await job(o1.id, 'order_collected', 'email', U.cust)).status === 'delivered');

  // ---- email turned off: nothing sent ----
  await q(`insert into notification_preferences (user_id, channel, event_type, enabled) values ($1, 'email', '*', false)`, [U.cust]);
  const o2 = await placeOrder();
  await q(`update orders set status = 'cancelled', cancel_reason = 'kitchen_cancelled' where id = $1`, [o2.id]);
  const outboxBefore = (await q(`select count(*)::int n from email_outbox`)).rows[0].n;
  r = await run();
  rec('email off: cancel email skipped, none queued', (await job(o2.id, 'order_cancelled', 'email', U.cust)).status === 'skipped' && (await q(`select count(*)::int n from email_outbox`)).rows[0].n === outboxBefore);
  rec('email off: in-app still sent', (await job(o2.id, 'order_cancelled', 'in_app', U.cust)).status === 'sent');

  // ---- a failing push provider retries with backoff ----
  await addSub(U.cust, 'down');
  const o3 = await placeOrder();
  await setStatus(o3.id, 'ready');
  r = await run();
  const jf = await job(o3.id, 'order_ready', 'push', U.cust);
  const wait = (await q(`select extract(epoch from (next_attempt_at - now()))::int s from notification_jobs where id = $1`, [jf.id])).rows[0].s;
  rec('push service error: job failed, attempt 1, retry in about 30 s', jf.status === 'failed' && jf.attempts === 1 && /HTTP 500/.test(jf.error || '') && wait > 20 && wait <= 30, JSON.stringify({ s: jf.status, a: jf.attempts, e: jf.error, wait }));

  gw.close(); ps.close(); procs.forEach(p => { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { p.kill(); } }); await db.end();
  execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' });
  for (const [s, n] of results) console.log(s, n);
  const failed = results.filter(x => x[0] !== 'PASS').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { for (const [s, n] of results) console.log(s, n); console.error(e); procs.forEach(p => { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { p.kill(); } }); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
