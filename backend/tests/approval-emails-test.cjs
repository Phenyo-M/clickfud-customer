// Local test of supabase/approval_emails.sql + the send-email Edge Function.
// The function runs for real in Deno against a local copy of the live
// structure (PostgREST), with Resend replaced by a local stand-in that
// records every request. Nothing reaches live or sends a real email.
//   NODE_PATH=tests/lt/node_modules node tests/approval-emails-test.cjs
const path = require('path'); const fs = require('fs'); const http = require('http'); const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');

const PG = 55491, PGRST = 3411, GW = 3412, FAKE = 3413, FN = 8000, DIR = path.join(LT, 'cfmail');
const SECRET = 'local-mail-secret-not-used-anywhere-else-0123456789abcdef';
const DISPATCH = 'local-dispatch-secret';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ exp: Math.floor(Date.now() / 1000) + 7200, ...c }); return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const results = []; const rec = (name, ok, extra) => results.push([ok ? 'PASS' : 'FAIL', name + (extra ? ` (${extra})` : '')]);
const procs = []; const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const db = await build(PG, DIR);
  const q = (s, p) => db.query(s, p);
  const admin = async () => { await q(`reset role; select set_config('request.jwt.claims', '', false)`); };
  const as = async (id) => { await q(`reset role`); await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await q(`set role authenticated`); };
  const ok = async (name, fn) => { try { const r = await fn(); rec(name, true); return r; } catch (e) { rec(name, false, e.message.slice(0, 120)); } };
  const err = async (name, fn, re) => { try { await fn(); rec(name, false, 'was allowed'); } catch (e) { rec(name, !re || re.test(e.message), e.message.slice(0, 90)); } };
  await admin();
  for (const f of ['student_sellers.sql', 'seller_review_address.sql', 'approval_emails.sql']) await q(fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8'));
  await q(`grant usage on schema public to anon, authenticated, service_role; grant all on all tables in schema public to service_role;`);
  await q(`insert into email_dispatch_config (id, function_url, secret) values (1, 'http://127.0.0.1:8000/', 'local-dispatch-secret')`);

  const U = {
    dev: ['77777777-7777-4777-8777-777777777777', 'dev@clickfood.co.za', 'developer', 'Phenyo Dev'],
    student: ['11111111-1111-4111-8111-111111111111', 'u11111111@tuks.co.za', 'customer', 'Mpho Seller'],
    mgr: ['66666666-6666-4666-8666-666666666666', 'owner@kotahub.co.za', 'manager', 'Sipho Owner'],
    driver: ['88888888-8888-4888-8888-888888888888', 'driver@gmail.com', 'driver', 'Lerato Driver'],
    buyer: ['33333333-3333-4333-8333-333333333333', 'u33333333@tuks.co.za', 'customer', 'Lebo Buyer'],
  };
  for (const [id, email, role, name] of Object.values(U)) {
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, email]);
    await q(`insert into profiles (id, name, email, role, status, active) values ($1, $2, $3, $4, $5, true)`, [id, name, email, role, role === 'driver' ? 'pending' : 'approved']);
  }
  // student shop (pending review) and a business application (pending)
  await as(U.student[0]);
  const sshop = (await q(`select * from become_student_seller('Mpho''s Kitchen', '072 123 4567', '{Lunch}', null, 'Hatfield', '', null, 'https://x.co/p.webp', 'Tuks Village, Block C', -25.75, 28.23, false, true)`)).rows[0];
  await admin();
  const bshop = (await q(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, manager_email, manager_name)
    values ($1, 'Kota Hub', 'kota-hub', 'Fast Food', 'Hatfield', 'Hatfield', 'University of Pretoria', 'pending', false, 'owner@kotahub.co.za', 'Sipho Owner') returning *`, [U.mgr[0]])).rows[0];
  await q(`update profiles set store_id = $1 where id = $2`, [bshop.id, U.mgr[0]]);
  const rows = async (target) => (await q(`select * from email_outbox where target_id = $1 order by created_at`, [target])).rows;

  // ---------- triggers ----------
  await as(U.dev[0]);
  await q(`update stores set status = 'approved' where id = $1`, [sshop.id]);
  let r = await rows(sshop.id);
  rec('approving a student shop queues one email', r.length === 1 && r[0].kind === 'student_shop_approved' && r[0].recipient_email === 'u11111111@tuks.co.za' && r[0].status === 'queued' && r[0].data.shop_name === "Mpho's Kitchen");
  await q(`update stores set status = 'approved' where id = $1`, [sshop.id]);
  rec('a second approve click adds no email', (await rows(sshop.id)).length === 1);
  await q(`begin; update stores set status = 'approved' where id = $1; rollback;`, [bshop.id]).catch(() => {});
  await admin(); await q(`begin`); await as(U.dev[0]); await q(`update stores set status = 'approved' where id = $1`, [bshop.id]); await q(`rollback`);
  rec('an approval that is rolled back sends nothing', (await rows(bshop.id)).length === 0);
  await as(U.dev[0]);
  await q(`update stores set status = 'approved' where id = $1`, [bshop.id]);
  r = await rows(bshop.id);
  rec('approving a business shop queues the business email', r.length === 1 && r[0].kind === 'business_shop_approved' && r[0].recipient_email === 'owner@kotahub.co.za');
  await admin(); await q(`update stores set publish_requested_at = now() where id = $1`, [bshop.id]);
  await as(U.dev[0]);
  await q(`update stores set is_published = true where id = $1`, [bshop.id]);
  r = await rows(bshop.id);
  rec('approving the publish request queues "now live"', r.length === 2 && r[1].kind === 'business_shop_live');
  await q(`update profiles set status = 'approved' where id = $1`, [U.driver[0]]);
  r = await rows(U.driver[0]);
  rec('approving a driver queues the driver email', r.length === 1 && r[0].kind === 'driver_approved' && r[0].recipient_email === 'driver@gmail.com');
  await q(`update stores set status = 'archived' where id = $1`, [bshop.id]);
  await q(`update stores set status = 'approved' where id = $1`, [bshop.id]);
  rec('restoring an archived shop is not an approval email', (await rows(bshop.id)).length === 2);
  await as(U.student[0]);
  await q(`update stores set address = 'Tuks Village, Block D' where id = $1`, [sshop.id]);
  await admin(); const firstStudentMail = (await rows(sshop.id));
  rec('ordinary shop edits send nothing', firstStudentMail.length === 1);
  await as(U.student[0]);

  // ---------- permissions ----------
  rec('seller cannot read the email log', (await q(`select 1 from email_outbox`)).rows.length === 0);
  await err('seller cannot write the email log', () => q(`insert into email_outbox (kind, target_type, target_id, recipient_email) values ('x', 'store', $1, 'a@b.co')`, [sshop.id]), /permission/);
  await err('seller cannot resend emails', () => q(`select resend_email($1)`, [firstStudentMail[0].id]), /Only ClickFood admins/);
  await err('seller cannot call the internal queue function', () => q(`select queue_email('student_shop_approved', 'store', $1, null, 'a@b.co', 'x', '{}')`, [sshop.id]), /permission/);
  await as(U.buyer[0]);
  rec('customer cannot read the email log', (await q(`select 1 from email_outbox`)).rows.length === 0);
  await err('nobody can read the dispatch secret', () => q(`select * from email_dispatch_config`), /permission/);
  await as(U.dev[0]);
  rec('developer reads the email log', (await q(`select 1 from email_outbox`)).rows.length === 4);

  // ---------- the real function in Deno, fake Resend ----------
  fs.writeFileSync(path.join(LT, 'pgrst-mail.conf'), `db-uri = "postgres://authenticator:authpw@127.0.0.1:${PG}/postgres"\ndb-schemas = "public"\ndb-anon-role = "anon"\njwt-secret = "${SECRET}"\nserver-port = ${PGRST}\nlog-level = "error"\n`);
  procs.push(spawn(path.join(LT, 'postgrest/postgrest.exe'), [path.join(LT, 'pgrst-mail.conf')], { env: { ...process.env, PATH: BIN + ';' + process.env.PATH } }));
  const gw = http.createServer((req, res) => {
    const chunks = []; req.on('data', d => chunks.push(d)); req.on('end', () => {
      if (!req.url.startsWith('/rest/v1/')) { res.writeHead(404); return res.end(); }
      const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
      const up = http.request({ host: '127.0.0.1', port: PGRST, path: req.url.slice(8), method: req.method, headers }, (r2) => { res.writeHead(r2.statusCode, r2.headers); r2.pipe(res); });
      up.on('error', e => { res.writeHead(502); res.end(String(e)); }); up.end(Buffer.concat(chunks));
    });
  }).listen(GW);
  const sent = []; let failNext = false;
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const j = JSON.parse(b || '{}');
      sent.push({ auth: req.headers.authorization, idem: req.headers['idempotency-key'], body: j });
      res.writeHead(failNext ? 422 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(failNext ? { message: 'The from domain is not verified' } : { id: 'msg_' + sent.length }));
      failNext = false;
    });
  }).listen(FAKE);
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PGRST}/`); break; } catch { await sleep(200); } }
  const fn = spawn(process.env.DENO_BIN || 'deno', ['run', '-A', path.join(__dirname, '../supabase/functions/send-email/index.ts')], {
    env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${GW}`, SUPABASE_SERVICE_ROLE_KEY: jwt({ role: 'service_role' }),
      RESEND_API_KEY: 're_test_fake', RESEND_FROM_EMAIL: 'hello@clickfood.co.za', EMAIL_DISPATCH_SECRET: DISPATCH, RESEND_API_URL: `http://127.0.0.1:${FAKE}/emails` },
  });
  procs.push(fn); let fnLog = ''; fn.stderr.on('data', d => fnLog += d); fn.stdout.on('data', d => fnLog += d);
  for (let i = 0; i < 150; i++) { try { await fetch(`http://127.0.0.1:${FN}/`); break; } catch { await sleep(300); } }
  const call = (id, secret = DISPATCH) => fetch(`http://127.0.0.1:${FN}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-email-secret': secret }, body: JSON.stringify({ id }) }).then(r => r.json().then(j => ({ status: r.status, j })));
  await admin();
  const studentMail = (await rows(sshop.id))[0];
  rec('wrong secret refused', (await call(studentMail.id, 'nope')).status === 401);
  rec('nothing sent on a refused call', sent.length === 0);
  const c1 = await call(studentMail.id);
  let row = (await rows(sshop.id))[0];
  rec('student email sent through Resend', c1.j.sent === true && row.status === 'sent' && row.provider_id === 'msg_1' && row.attempts === 1 && row.sent_at, JSON.stringify(c1.j) + ' ' + fnLog.slice(-200));
  const m1 = sent[0] && sent[0].body;
  rec('to the applicant, from ClickFood', m1 && m1.to[0] === 'u11111111@tuks.co.za' && m1.from === 'ClickFood <hello@clickfood.co.za>' && sent[0].auth === 'Bearer re_test_fake');
  rec('personalised: name and shop', m1 && /^Hi Mpho,/.test(m1.text) && m1.subject === "Mpho's Kitchen is approved on ClickFood" && m1.html.includes('Mpho&#39;s Kitchen'));
  rec('student steps: 5 products, publish, not visible yet', m1 && /at least 5 food products/.test(m1.text) && /Publish my shop/.test(m1.text) && /not visible to customers yet/.test(m1.text) && m1.text.includes('https://clickfood.co.za/?view=sell'));
  rec('no raw placeholders', m1 && !/\{\{|\$\{|undefined|null/.test(m1.text + m1.html));
  rec('idempotency key per attempt', sent[0] && sent[0].idem === `${studentMail.id}-1`);
  const c2 = await call(studentMail.id);
  rec('a repeated call does not send twice', c2.j.skipped === true && sent.length === 1);

  const [bizMail, liveMail] = await rows(bshop.id);
  failNext = true;
  await call(bizMail.id);
  row = (await rows(bshop.id))[0];
  rec('provider error is recorded as failed, approval untouched', row.status === 'failed' && /from domain is not verified/.test(row.error) && (await q(`select status from stores where id = $1`, [bshop.id])).rows[0].status === 'approved');
  await as(U.dev[0]);
  await ok('developer resends the failed email', () => q(`select resend_email($1)`, [bizMail.id]));
  await err('resend twice in a row is blocked while it is queued', async () => { await admin(); await q(`update email_outbox set last_attempt_at = now() where id = $1`, [bizMail.id]); await as(U.dev[0]); await q(`select resend_email($1)`, [bizMail.id]); }, /already being sent/);
  await admin();
  await call(bizMail.id);
  row = (await rows(bshop.id))[0];
  const m2 = sent[sent.length - 1];
  rec('retry sent, attempt 2, new idempotency key', row.status === 'sent' && row.attempts === 2 && m2.idem === `${bizMail.id}-2`);
  rec('business email has business steps, not student ones', /ClickFood Manager/.test(m2.body.text) && /Publish request/.test(m2.body.text) && !/student|5 food products|My Shop/i.test(m2.body.text) && /^Hi Sipho,/.test(m2.body.text));
  rec('resend is in the audit log', (await q(`select 1 from audit_log where action = 'resend_email' and target_id = $1`, [bshop.id])).rows.length === 1);
  await call(liveMail.id);
  rec('"now live" email says customers can order', /is now live/.test(sent[sent.length - 1].body.subject) && /Students can find it and order/.test(sent[sent.length - 1].body.text));
  const drv = (await rows(U.driver[0]))[0];
  await call(drv.id);
  rec('driver email sent', sent[sent.length - 1].body.to[0] === 'driver@gmail.com' && /driver account is approved/.test(sent[sent.length - 1].body.subject));

  // no address on file
  await q(`update profiles set email = null where id = $1`, [U.driver[0]]);
  await q(`update profiles set status = 'rejected' where id = $1`, [U.driver[0]]);
  await q(`update profiles set status = 'approved' where id = $1`, [U.driver[0]]);
  const noAddr = (await rows(U.driver[0]))[1];
  rec('no email address: recorded as failed, nothing sent', noAddr && noAddr.status === 'failed' && /No email address/.test(noAddr.error));

  // rollback + re-apply
  await ok('rollback runs', () => q(fs.readFileSync(path.join(__dirname, '../supabase/approval_emails_rollback.sql'), 'utf8')));
  await ok('re-applies', () => q(fs.readFileSync(path.join(__dirname, '../supabase/approval_emails.sql'), 'utf8')));

  fake.close(); gw.close(); procs.forEach(p => { try { require('child_process').execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { p.kill(); } }); await db.end();
  execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' });
  for (const [s, n] of results) console.log(s, n);
  const failed = results.filter(r => r[0] !== 'PASS').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e); procs.forEach(p => { try { require('child_process').execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { p.kill(); } }); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
