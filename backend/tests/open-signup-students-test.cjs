// Database test for supabase/open_signup_students.sql: open sign-up,
// student status, student email verification, student-only deals with
// per-customer limits (incl. two orders at the same moment). Synthetic data.
//   NODE_PATH=backend/tests/lt/node_modules node backend/tests/open-signup-students-test.cjs
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Client } = require('pg');
const { build, BIN, LT } = require('./load/build-db.cjs');
const PORT = 55721, DIR = path.join(LT, 'cfopensignup');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 240)})` : '')]);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  const db = await build(PORT, DIR); const q = (s, p) => db.query(s, p); const one = async (s, p) => (await q(s, p)).rows[0];
  const admin = async (c) => { c = c || db; await c.query('reset role'); await c.query(`select set_config('request.jwt.claims', '', false)`); };
  const as = async (id, c) => { c = c || db; await c.query('reset role'); await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await c.query('set role authenticated'); };
  const tryq = async (s, p, c) => { try { return { rows: (await (c || db).query(s, p)).rows }; } catch (e) { return { err: e.message }; } };
  await admin();
  await q(`create table if not exists cron.job (jobid bigint primary key, jobname text, schedule text);
           create table if not exists cron.job_run_details (jobid bigint, status text, start_time timestamptz, end_time timestamptz, return_message text);
           create table if not exists net._http_response (id bigint generated always as identity, status_code int, error_msg text, timed_out boolean default false, created timestamptz default now());`);
  for (const f of ['student_sellers.sql', 'seller_review_address.sql', 'student_application_details.sql', 'student_number_from_email.sql', 'allowed_domains.sql',
                   'approval_emails.sql', 'notification_links.sql', 'student_collection_times.sql', 'student_order_codes.sql', 'notification_queue.sql', 'shop_test_mode.sql',
                   'ops_monitoring.sql', 'show_partner_shops.sql', 'payment_options.sql', 'multi_university.sql', 'tut_campuses.sql']) await q(SQL(f));
  await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
  await q(`update allowed_domains set active = true where domain in ('tuks.co.za', 'tut4life.ac.za')`);
  // the live auth.users triggers (the local copy only mirrors the public schema)
  await q(`alter table auth.users add column if not exists email_change text, add column if not exists raw_app_meta_data jsonb default '{}', add column if not exists raw_user_meta_data jsonb default '{}'`);
  await q(`drop trigger if exists on_auth_user_created on auth.users; create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
           drop trigger if exists trg_enforce_customer_signup on auth.users; create constraint trigger trg_enforce_customer_signup after insert on auth.users deferrable initially deferred for each row execute function public.enforce_customer_signup();
           drop trigger if exists trg_enforce_customer_email_change on auth.users; create trigger trg_enforce_customer_email_change before update of email, email_change on auth.users for each row execute function public.enforce_customer_email_change();`);
  // an existing UP student from before (backfill)
  const oldStudent = crypto.randomUUID();
  await q(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, 'u11111111@tuks.co.za', now(), '{}')`, [oldStudent]);
  await q(`update profiles set university = 'University of Pretoria', campus_location = 'Hatfield' where id = $1`, [oldStudent]);

  try { await q(SQL('open_signup_students.sql')); rec('migration applies', true); } catch (e) { rec('migration applies', false, e.message); throw e; }
  try { await q(SQL('open_signup_students.sql')); rec('migration applies a second time', true); } catch (e) { rec('migration applies a second time', false, e.message); }
  rec('an existing student is not asked again (is_student = true)', (await one(`select is_student s from profiles where id = $1`, [oldStudent])).s === true);

  // ---------------- open sign-up ----------------
  const signUp = async (email) => { const id = crypto.randomUUID(); await q('begin'); try { await q(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, '{"name":"New Person"}', '{"provider":"email"}')`, [id, email]); await q('commit'); return { id }; } catch (e) { await q('rollback'); return { err: e.message }; } };
  const gm = await signUp('thandi.test@gmail.com');
  const ol = await signUp('sipho.test@outlook.com');
  const uni = await signUp('u22222222@tuks.co.za');
  const named = await signUp('thabo.m@tuks.co.za');
  rec('Gmail, Outlook and university emails can all sign up', !gm.err && !ol.err && !uni.err && !named.err, [gm.err, ol.err, uni.err, named.err].filter(Boolean).join(' | '));
  const gp = await one(`select role, university, is_student, student_number from profiles where id = $1`, [gm.id]);
  rec('a new account has no university or student number forced on it, and is asked later', gp.role === 'customer' && gp.university === null && gp.is_student === null && gp.student_number === null, JSON.stringify(gp));
  await q(`update auth.users set email = 'thandi.new@yahoo.com' where id = $1`, [gm.id]).then(() => rec('changing to a personal email is allowed', true), (e) => rec('changing to a personal email is allowed', false, e.message));
  await q(`update auth.users set email = 'thandi.test@gmail.com' where id = $1`, [gm.id]);

  // ---------------- student status ----------------
  const UPid = (await one(`select id from universities where name = 'University of Pretoria'`)).id;
  const TUTid = (await one(`select id from universities where name = 'Tshwane University of Technology'`)).id;
  const hat = (await one(`select id from campuses where code = 'up-hatfield'`)).id;
  const arc = (await one(`select id from campuses where code = 'tut-arcadia'`)).id;
  await as(gm.id);
  const s1 = (await one(`select set_my_student_status(true, $1, $2) r`, [TUTid, arc])).r;
  const s2 = (await one(`select set_my_student_status(true, $1, $2) r`, [UPid, arc])).r;
  await admin();
  const g2 = await one(`select is_student, university, campus_location, home_university_id, campus_id from profiles where id = $1`, [gm.id]);
  rec('a Gmail student picks TUT Arcadia (university/campus saved, home university set)', s1.ok && g2.is_student && g2.university === 'Tshwane University of Technology' && g2.campus_location === 'Arcadia' && g2.home_university_id === TUTid && g2.campus_id === arc, JSON.stringify(g2));
  rec('a campus of another university is refused', s2.ok === false);
  rec('choosing a university is not student verification', (await one(`select public.is_verified_student($1) v`, [gm.id])).v === false);
  await as(ol.id);
  const s3 = (await one(`select set_my_student_status(false) r`)).r;
  await admin();
  rec('"Not a student" saves without any university', s3.ok && (await one(`select is_student s, university u from profiles where id = $1`, [ol.id])).s === false);

  // ---------------- student verification ----------------
  const start = async (user, email, uniId, token) => (await one(`select student_verify_start($1, $2, $3, null, $4) r`, [user, email, uniId, sha(token)])).r;
  const confirm = async (user, token) => (await one(`select student_verify_confirm($1, $2) r`, [user, sha(token)])).r;
  let r = await start(gm.id, 'thandi@tuks.co.za', UPid, 'tok-a');
  rec('a UP email without the student number is refused (institution rule)', r.ok === false && /student-number/.test(r.error), r.error);
  r = await start(gm.id, '222222223@tut4life.ac.za', UPid, 'tok-a');
  rec('an email of a different university than chosen is refused', r.ok === false && /different university/.test(r.error), r.error);
  r = await start(gm.id, '222222223@tut4life.ac.za', TUTid, 'tok-a');
  rec('a valid TUT student email starts verification', r.ok === true && r.supported === true, JSON.stringify(r));
  r = await start(gm.id, '222222223@tut4life.ac.za', TUTid, 'tok-b');
  rec('resending within a minute is refused (rate limit)', r.ok === false && r.retry_after > 0, JSON.stringify(r));
  rec('the token is stored only as a hash', (await one(`select token_hash h from student_verifications where user_id = $1`, [gm.id])).h === sha('tok-a'));
  rec('someone else can\'t use the link', (await confirm(ol.id, 'tok-a')).ok === false);
  rec('a wrong token does not verify', (await confirm(gm.id, 'tok-zzz')).ok === false);
  rec('still not a verified student', (await one(`select is_verified_student($1) v`, [gm.id])).v === false);
  r = await confirm(gm.id, 'tok-a');
  rec('the right student opening the link is verified', r.ok === true && r.status === 'verified' && (await one(`select is_verified_student($1) v`, [gm.id])).v === true, JSON.stringify(r));
  rec('...and stays verified until revoked (no expiry)', (await one(`select expires_at e from student_verifications where user_id = $1 and status = 'verified'`, [gm.id])).e === null);
  r = await start(ol.id, '222222223@tut4life.ac.za', TUTid, 'tok-c');
  rec('the same university email can\'t prove a second account', r.ok === false && /another ClickFood account/.test(r.error), r.error);
  // unknown institution -> needs a developer
  r = await start(ol.id, 'student@someuni.ac.za', null, 'tok-d');
  const r2 = await confirm(ol.id, 'tok-d');
  rec('an unlisted institution needs a developer\'s approval after the link', r.ok && r2.status === 'needs_review' && (await one(`select is_verified_student($1) v`, [ol.id])).v === false, JSON.stringify(r2));
  // students can't touch verification directly
  await as(ol.id);
  const f1 = await tryq(`select student_verify_confirm($1, $2)`, [ol.id, sha('x')]);
  const f2 = await tryq(`update student_verifications set status = 'verified' where user_id = auth.uid() returning id`);
  const f3 = await tryq(`insert into student_verifications (user_id, email, status) values (auth.uid(), 'fake@uni.ac.za', 'verified')`);
  const f4 = await tryq(`select token_hash from student_verifications`);
  const f5 = await tryq(`select status from student_verifications where user_id <> auth.uid()`);
  const f6 = await tryq(`select dev_review_student(id, 'approve', null) r from student_verifications limit 1`);
  await admin();
  rec('a customer can\'t verify themselves (functions, update, insert all refused)', !!f1.err && (!!f2.err || f2.rows.length === 0) && !!f3.err, [f1.err, f2.err, f3.err].join(' | '));
  rec('a customer can\'t read token hashes or other people\'s records', !!f4.err && (f5.rows && f5.rows.length === 0), f4.err);
  rec('a customer can\'t approve reviews', !f6.rows || f6.rows.every(x => x.r.ok === false));
  const dev = crypto.randomUUID();
  await q(`set session_replication_role = replica`); await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, 'dev@clickfood.test', now())`, [dev]); await q(`insert into profiles (id, name, email, role, status, active) values ($1, 'Dev', 'dev@clickfood.test', 'developer', 'approved', true)`, [dev]); await q(`set session_replication_role = origin`);
  const nr = (await one(`select id from student_verifications where user_id = $1 and status = 'needs_review'`, [ol.id])).id;
  await as(dev); const ap = (await one(`select dev_review_student($1, 'approve', 'checked student card') r`, [nr])).r; await admin();
  rec('a developer approves it (and it is audited)', ap.ok === true && (await one(`select is_verified_student($1) v`, [ol.id])).v === true && !!(await one(`select 1 x from ops_audit where action = 'student_verification_approve'`)));

  // ---------------- student-only deal ----------------
  const mgr = crypto.randomUUID();
  await q(`set session_replication_role = replica`); await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, 'mgr@shop.test', now())`, [mgr]); await q(`insert into profiles (id, name, email, role, status, active) values ($1, 'Mgr', 'mgr@shop.test', 'manager', 'approved', true)`, [mgr]); await q(`set session_replication_role = origin`);
  const shop = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind)
    values ($1, 'Deal Kitchen', 'deal-kitchen', 'Fast Food', 'Arcadia', 'x', 'Tshwane University of Technology', 'approved', true, '00:00', '23:59', 'business') returning id`, [mgr])).id;
  await q(`update profiles set store_id = $1 where id = $2`, [shop, mgr]);
  const item = (await one(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, 'Burger', 'Lunch', 50, 'x', 'A burger', 'approved', true, 500) returning id`, [shop])).id;
  await q(`insert into promotions (code, type, value, active, store_id, title, audience, per_customer_limit, usage_limit, menu_item_ids) values ('STUDENT10', 'fixed', 10, true, $1, 'Student R10 off', 'students', 1, 200, array[$2]::uuid[])`, [shop, item]);
  await q(`insert into promotions (code, type, value, active, store_id, title, audience, per_customer_limit, campus_id, menu_item_ids) values ('ARCADIA5', 'fixed', 5, true, $1, 'Arcadia R5 off', 'everyone', 2, $2, array[$3]::uuid[])`, [shop, arc, item]);
  for (const id of [gm.id, ol.id, uni.id]) await q(`update auth.users set email_confirmed_at = now() where id = $1`, [id]);
  const order = async (user, code, c) => {
    await as(user, c);
    const r = await tryq(`insert into orders (customer_id, store_id, items, payment_method, total, promo_code, discount, delivery_location) values (auth.uid(), $1, $2, 'cod', 1, $3, 10, $4) returning id, promo_code, discount`,
      [shop, JSON.stringify([{ menuItemId: item, name: 'Burger', qty: 1, price: 50 }]), code, JSON.stringify({ fulfilment: 'collection', collectionTime: new Date(Date.now() + 3600000).toISOString() })], c);
    await admin(c); return r;
  };
  await as(uni.id); const chk = (await one(`select check_my_promo('STUDENT10', 50) r`)).r; await admin();
  rec('check before checkout: an unverified customer is asked to verify', chk.ok === false && chk.needs_student === true && /verified students/.test(chk.error), JSON.stringify(chk));
  let o = await order(uni.id, 'STUDENT10');
  rec('an unverified customer can\'t claim the student deal (order refused)', !!o.err && /verified students/.test(o.err), o.err);
  o = await order(gm.id, 'STUDENT10');
  rec('the verified student claims it', !o.err && o.rows[0].promo_code === 'STUDENT10' && Number(o.rows[0].discount) === 10, o.err || JSON.stringify(o.rows));
  rec('the claim is recorded', (await one(`select count(*)::int n from promo_claims c join promotions p on p.id = c.promotion_id where p.code = 'STUDENT10' and c.customer_id = $1`, [gm.id])).n === 1);
  o = await order(gm.id, 'STUDENT10');
  rec('a second claim is refused (1 per customer)', !!o.err && /already used/.test(o.err), o.err);
  // two orders at the same moment (verified student ol), limit 1
  const c2 = new Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database: 'postgres' }); await c2.connect();
  const both = await Promise.all([order(ol.id, 'STUDENT10', db), order(ol.id, 'STUDENT10', c2)]);
  rec('two orders sent at the same moment: only one gets the deal', both.filter(x => !x.err).length === 1 && both.filter(x => x.err && /already used/.test(x.err)).length === 1, both.map(x => x.err || 'ok').join(' | '));
  rec('total count matches the claims', (await one(`select used_count n from promotions where code = 'STUDENT10'`)).n === 2);
  // cancel releases the claim
  const firstOrder = (await one(`select o.id from orders o where o.customer_id = $1 and o.promo_code = 'STUDENT10'`, [gm.id])).id;
  await q(`update orders set status = 'cancelled', cancel_reason = 'customer_cancelled' where id = $1`, [firstOrder]);
  rec('a cancelled order gives the claim back', (await one(`select released_at is not null r from promo_claims where order_id = $1`, [firstOrder])).r === true);
  // campus deal (everyone, Arcadia only, 2 per customer)
  o = await order(uni.id, 'ARCADIA5');
  rec('a campus deal is refused for a student of another campus', !!o.err && /only for/.test(o.err), o.err);
  const a1 = await order(gm.id, 'ARCADIA5'), a2 = await order(gm.id, 'ARCADIA5'), a3 = await order(gm.id, 'ARCADIA5');
  rec('an Arcadia student can use it twice, not three times', !a1.err && !a2.err && !!a3.err, [a1.err, a2.err, a3.err].join(' | '));
  // expired deal
  await q(`update promotions set expires_at = now() - interval '1 minute' where code = 'ARCADIA5'`);
  await as(gm.id); const ex = (await one(`select check_my_promo('ARCADIA5', 50) r`)).r; await admin();
  rec('an expired deal can\'t be claimed', ex.ok === false && /expired/.test(ex.error));
  rec('a manager can see claims for their own shop', await (async () => { await as(mgr); const r = await tryq(`select count(*)::int n from promo_claims`); await admin(); return r.rows && r.rows[0].n >= 3; })());
  // ordering without a deal still works for a personal-email customer
  o = await order(uni.id, null);
  rec('a customer with no student status orders normally', !o.err, o.err);

  // rollback
  try { await q(SQL('open_signup_students_rollback.sql')); rec('rollback runs', true); } catch (e) { rec('rollback runs', false, e.message); }
  rec('rollback restores the student-email sign-up rule', !!(await signUp('someone@gmail.com')).err);
  try { await q(SQL('open_signup_students.sql')); rec('migration re-applies after rollback', true); } catch (e) { rec('migration re-applies after rollback', false, e.message); }

  await c2.end(); await db.end();
  try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {}
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
