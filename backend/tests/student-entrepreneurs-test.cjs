// Database test for supabase/student_entrepreneurs.sql (Student Entrepreneur
// Programme): eligibility by VERIFIED UP student email, draft / submit
// checks, one open application, RLS, developer-only review and population
// group, the shop gate (only approved applicants get a student shop),
// retention and account deletion. Local copy, synthetic data.
//   NODE_PATH=backend/tests/lt/node_modules node backend/tests/student-entrepreneurs-test.cjs
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');
const PORT = 55771, DIR = path.join(LT, 'cfentre');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 240)})` : '')]);

(async () => {
  const db = await build(PORT, DIR); const q = (s, p) => db.query(s, p); const one = async (s, p) => (await q(s, p)).rows[0];
  const admin = async () => { await q('reset role'); await q(`select set_config('request.jwt.claims', '', false)`); };
  const as = async (id) => { await q('reset role'); await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await q('set role authenticated'); };
  const tryq = async (s, p) => { try { return { rows: (await q(s, p)).rows }; } catch (e) { return { err: e.message }; } };
  await admin();
  await q(`create table if not exists cron.job (jobid bigint primary key, jobname text, schedule text);
           create table if not exists cron.job_run_details (jobid bigint, status text, start_time timestamptz, end_time timestamptz, return_message text);
           create table if not exists net._http_response (id bigint generated always as identity, status_code int, error_msg text, timed_out boolean default false, created timestamptz default now());`);
  for (const f of ['student_sellers.sql', 'seller_review_address.sql', 'student_application_details.sql', 'student_number_from_email.sql', 'allowed_domains.sql',
                   'approval_emails.sql', 'notification_links.sql', 'student_collection_times.sql', 'student_order_codes.sql', 'notification_queue.sql', 'shop_test_mode.sql',
                   'ops_monitoring.sql', 'show_partner_shops.sql', 'payment_options.sql', 'account_deletion.sql', 'account_deletion_reasons.sql', 'shop_name_fix.sql',
                   'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'shop_locations.sql', 'privacy_legal.sql']) await q(SQL(f));
  await q(`update allowed_domains set active = true where domain in ('tuks.co.za', 'tut4life.ac.za')`);
  await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
  await q(`alter table auth.users add column if not exists email_change text, add column if not exists phone text, add column if not exists encrypted_password text,
             add column if not exists raw_user_meta_data jsonb default '{}', add column if not exists banned_until timestamptz, add column if not exists deleted_at timestamptz;
           create table if not exists auth.identities (user_id uuid); create table if not exists auth.mfa_factors (user_id uuid);
           create table if not exists auth.one_time_tokens (user_id uuid); create table if not exists auth.refresh_tokens (user_id text); create table if not exists auth.sessions (user_id uuid);`);
  try { await q(SQL('student_entrepreneurs.sql')); await q(SQL('student_entrepreneurs.sql')); rec('migration applies (twice)', true); } catch (e) { rec('migration applies (twice)', false, e.message); throw e; }

  const mkUser = async (email, role, confirmed = true) => {
    const id = crypto.randomUUID();
    await q(`set session_replication_role = replica`);
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, $3)`, [id, email, confirmed ? new Date() : null]);
    await q(`insert into profiles (id, name, email, role, status, active) values ($1, $2, $2, $3, 'approved', true)`, [id, email, role || 'customer']);
    await q(`set session_replication_role = origin`);
    return id;
  };
  const UP = (await one(`select id from universities where name = 'University of Pretoria'`)).id;
  const TUT = (await one(`select id from universities where name = 'Tshwane University of Technology'`)).id;
  const gmail = await mkUser('thandi@gmail.com');                 // personal login email, no student verification
  const verified = await mkUser('lerato@gmail.com');              // personal login, verified UP student email
  await q(`insert into student_verifications (user_id, email, university_id, status, verified_at) values ($1, 'u23456789@tuks.co.za', $2, 'verified', now())`, [verified, UP]);
  const tuksLogin = await mkUser('u34567890@tuks.co.za');          // confirmed UP login email
  const tuksUnconfirmed = await mkUser('u45678901@tuks.co.za', 'customer', false);
  const tutStudent = await mkUser('sipho@gmail.com');
  await q(`insert into student_verifications (user_id, email, university_id, status, verified_at) values ($1, '222222222@tut4life.ac.za', $2, 'verified', now())`, [tutStudent, TUT]);
  const pendingVer = await mkUser('pending@gmail.com');
  await q(`insert into student_verifications (user_id, email, university_id, status, token_hash, token_expires_at) values ($1, 'u56789012@tuks.co.za', $2, 'pending', repeat('a', 64), now() + interval '1 day')`, [pendingVer, UP]);
  const dev = await mkUser('dev@clickfood.test', 'developer');

  // ---------------- eligibility ----------------
  const elig = async (u) => (await one(`select public.entrepreneur_email($1) e`, [u])).e;
  rec('a personal email (Gmail) alone is not eligible', await elig(gmail) === null);
  rec('a VERIFIED UP student email (proved by the link) is eligible, even with a Gmail login', await elig(verified) === 'u23456789@tuks.co.za');
  rec('a confirmed UP login email is eligible', await elig(tuksLogin) === 'u34567890@tuks.co.za');
  rec('an UNCONFIRMED UP login email is not (a matching domain is not enough)', await elig(tuksUnconfirmed) === null);
  rec('a pending (not yet confirmed) UP verification is not eligible', await elig(pendingVer) === null);
  rec('a verified TUT student is not eligible (programme starts with UP only)', await elig(tutStudent) === null);
  await q(`update allowed_domains set entrepreneur_eligible = true where domain = 'tut4life.ac.za'`);
  rec('switching an institution on in the config makes its verified students eligible', await elig(tutStudent) === '222222222@tut4life.ac.za');
  await q(`update allowed_domains set entrepreneur_eligible = false where domain = 'tut4life.ac.za'`);

  // ---------------- drafts and submission ----------------
  const full = {
    full_name: 'Lerato Mokoena', phone: '072 123 4567', year_of_study: 'second', expected_stay: '3', years_left: '2',
    business_name: 'Lerato Bakes', categories: ['baked', 'snacks', 'other'], other_category: 'Fruit cups',
    description: 'Fresh muffins, scones and fruit cups baked every morning for students on Hatfield campus.',
    why_choose: 'Affordable homemade baking, made fresh daily, cheaper than campus cafes and always on time.',
    food_safety: 'Baked in a clean kitchen, stored in sealed containers, sold the same day.',
    available_days: [1, 2, 3, 4, 5], available_periods: ['morning', 'midday'],
    population_group: 'black_african', population_group_consent: true,
    confirm_accurate: true, accept_terms: true, ack_privacy: true,
  };
  const save = async (u, p, submit) => { await as(u); const r = await tryq(`select save_entrepreneur_application($1::jsonb, $2) r`, [JSON.stringify(p), !!submit]); await admin(); return r.err ? { err: r.err } : r.rows[0].r; };
  let r = await save(gmail, { full_name: 'Thandi', business_name: 'Thandi Kota' }, false);
  rec('anyone signed in can save a draft', r.ok === true && r.status === 'draft', JSON.stringify(r));
  r = await save(gmail, full, true);
  rec('submitting without a verified UP student email is refused with a clear message', r.ok === false && r.needs_email === true && /official university student email/.test(r.error), JSON.stringify(r));
  rec('...and the application stays a draft', (await one(`select status from entrepreneur_applications where user_id = $1`, [gmail])).status === 'draft');
  r = await save(verified, Object.assign({}, full, { description: 'Too short' }), true);
  rec('a too-short description is refused', r.ok === false && /describe your food business/.test(r.error), r.error);
  r = await save(verified, Object.assign({}, full, { accept_terms: false }), true);
  rec('the Terms must be accepted to submit', r.ok === false && /Terms of Service/.test(r.error), r.error);
  r = await save(verified, Object.assign({}, full, { ack_privacy: false }), true);
  rec('the Privacy Policy must be acknowledged to submit', r.ok === false && /Privacy Policy/.test(r.error), r.error);
  r = await save(verified, Object.assign({}, full, { categories: ['weapons'] }), true);
  rec('unknown categories are refused', r.ok === false, r.error);
  r = await save(verified, Object.assign({}, full, { business_name: 'Cheap Phone Cases' }), true);
  rec('non-food businesses are refused', r.ok === false && /food sellers only/.test(r.error || ''), r.error);
  r = await save(verified, Object.assign({}, full, { year_of_study: 'masters' }), true);
  rec('an invalid year of study is refused', r.ok === false, r.error);
  r = await save(verified, full, true);
  const app = await one(`select * from entrepreneur_applications where user_id = $1 and status = 'pending_review'`, [verified]);
  rec('a complete application from a verified UP student is submitted (pending review)', r.ok === true && !!app, JSON.stringify(r));
  rec('the server copies the VERIFIED student email (not anything typed)', app.student_email === 'u23456789@tuks.co.za' && app.university === 'University of Pretoria');
  rec('food business fields saved correctly', app.business_name === 'Lerato Bakes' && app.categories.sort().join() === 'baked,other,snacks' && app.other_category === 'Fruit cups' && app.available_days.length === 5 && app.year_of_study === 'second' && app.years_left === '2' && app.expected_stay === '3' && app.phone === '27721234567');
  rec('Terms and Privacy versions and times are recorded', app.terms_version === '2026-10-17.2' && app.privacy_version === '2026-10-17.2' && !!app.terms_accepted_at && !!app.privacy_acknowledged_at && !!app.info_confirmed_at);
  rec('no degree / course / subject column exists', !(await one(`select 1 x from information_schema.columns where table_name = 'entrepreneur_applications' and column_name ~ 'degree|course|subject|qualification|faculty|programme_of'`)));
  rec('population group is stored separately (only with its own consent)', (await one(`select population_group p from entrepreneur_demographics where application_id = $1`, [app.id])).p === 'black_african');
  rec('developers are notified', (await one(`select count(*)::int n from notifications where user_id = $1 and type = 'entrepreneur_review'`, [dev])).n === 1);
  r = await save(verified, full, true);
  rec('a second submission is refused (already submitted)', r.ok === false && /already been submitted/.test(r.error), r.error);
  const dup = await tryq(`insert into entrepreneur_applications (user_id, status) values ($1, 'draft')`, [verified]);
  rec('the database itself allows only one open application per student', !!dup.err, dup.err);
  r = await save(tuksLogin, Object.assign({}, full, { business_name: 'Tuks Grill', population_group: 'white', population_group_consent: false }), true);
  rec('a student with a confirmed UP login email can submit too', r.ok === true, JSON.stringify(r));
  const tg = await one(`select id from entrepreneur_applications where user_id = $1`, [tuksLogin]);
  rec('population group without its consent is not stored', !(await one(`select 1 x from entrepreneur_demographics where application_id = $1`, [tg.id])));

  // ---------------- security ----------------
  await as(gmail);
  const peek = await tryq(`select id from entrepreneur_applications where user_id <> auth.uid()`);
  const st = await tryq(`update entrepreneur_applications set status = 'approved' where user_id = auth.uid() returning id`);
  const ins = await tryq(`insert into entrepreneur_applications (user_id, status) values (auth.uid(), 'approved')`);
  const dem = await tryq(`select * from entrepreneur_demographics`);
  const rev = await tryq(`select dev_review_entrepreneur($1, 'approve') r`, [app.id]);
  const role = await tryq(`update profiles set role = 'developer' where id = auth.uid() returning role`);
  await admin();
  rec('an applicant cannot read another student\'s application', !peek.err && peek.rows.length === 0, peek.err);
  rec('an applicant cannot change their status or insert an approved application', !!st.err && !!ins.err, [st.err, ins.err].join(' | '));
  rec('an applicant cannot read population-group data', !!dem.err || dem.rows.length === 0, dem.err);
  rec('an applicant cannot review applications', rev.err || rev.rows[0].r.ok === false);
  rec('an applicant cannot make themselves a developer', (await one(`select role from profiles where id = $1`, [gmail])).role === 'customer', role.err);
  await as(verified); const own = (await one(`select my_entrepreneur_status() r`)).r; await admin();
  rec('the applicant sees their own status (no reviewer fields)', own.application.status === 'pending_review' && !('reviewed_by' in own.application) && own.eligible_email === 'u23456789@tuks.co.za', JSON.stringify(own).slice(0, 200));

  // ---------------- shop gate before approval ----------------
  const become = async (u, name) => { await as(u); const res = await tryq(`select id from become_student_seller($1, '072 123 4567', array['Lunch','Baked Goods'], null, 'Hatfield', 'Home cooked meals and baking', null,
      'https://x.supabase.co/storage/v1/object/public/images/avatars/a/shop.webp', 'Tuks Village, Block C', -25.7535, 28.2295, true, true, $2::jsonb)`, [name, JSON.stringify({ business_type: 'takeaway', contact_phone: '072 123 4567', contact_email: 'mama@tuks.co.za', is_registered: false, manager_phone: '072 123 4567', manager_position: 'owner', open_days: [1, 2, 3, 4, 5], opening_time: '08:00', closing_time: '17:00', products_summary: 'Home cooked lunch plates and baked goods' })]); await admin(); return res; };
  let b = await become(verified, 'Lerato Bakes');
  rec('a PENDING applicant cannot open a student shop (direct request refused)', !!b.err && /must be approved/.test(b.err), b.err);

  // ---------------- developer review ----------------
  await as(dev);
  const list = await tryq(`select a.id, a.business_name, d.population_group from entrepreneur_applications a left join entrepreneur_demographics d on d.application_id = a.id where a.status = 'pending_review'`);
  const rj0 = (await one(`select dev_review_entrepreneur($1, 'reject', null) r`, [tg.id])).r;
  const s1 = (await one(`select dev_review_entrepreneur($1, 'start') r`, [app.id])).r;
  const a1 = (await one(`select dev_review_entrepreneur($1, 'approve', 'Great plan', true) r`, [app.id])).r;
  const rj = (await one(`select dev_review_entrepreneur($1, 'reject', 'Please add more detail about food storage.', true) r`, [tg.id])).r;
  const again = (await one(`select dev_review_entrepreneur($1, 'approve') r`, [tg.id])).r;
  await admin();
  rec('the developer lists pending applications (with population group)', !list.err && list.rows.length === 2 && list.rows.some(x => x.population_group === 'black_african'), list.err);
  rec('rejecting needs a recorded reason', rj0.ok === false && /reason/.test(rj0.error));
  rec('start review -> approve works', s1.ok && a1.ok && (await one(`select status from entrepreneur_applications where id = $1`, [app.id])).status === 'approved');
  rec('reject with a reason works; a decided application cannot be changed again', rj.ok && again.ok === false);
  rec('the applicant is told the decision (notification)', (await one(`select count(*)::int n from notifications where user_id in ($1, $2) and type = 'entrepreneur_decision'`, [verified, tuksLogin])).n === 2);
  rec('decisions are audited', (await one(`select count(*)::int n from ops_audit where action like 'entrepreneur_%'`)).n >= 3);
  await as(tuksLogin); const rjv = (await one(`select my_entrepreneur_status() r`)).r; await admin();
  rec('a shared rejection reason is shown to the applicant', rjv.application.status === 'rejected' && /food storage/.test(rjv.application.decision_reason || ''));
  b = await become(tuksLogin, 'Tuks Grill');
  rec('a REJECTED applicant cannot open a shop', !!b.err && /must be approved/.test(b.err), b.err);
  r = await save(tuksLogin, Object.assign({}, full, { business_name: 'Tuks Grill Again' }), false);
  rec('after a rejection the student can start a new application', r.ok === true && r.status === 'draft', JSON.stringify(r));

  // ---------------- after approval ----------------
  b = await become(verified, 'Lerato Bakes');
  const shop = b.rows && b.rows[0] && b.rows[0].id;
  rec('the APPROVED applicant can set up their student shop (existing flow, goes to shop review)', !b.err && !!shop && (await one(`select status from stores where id = $1`, [shop])).status === 'pending', b.err);
  rec('the shop is linked to the application', (await one(`select store_id from entrepreneur_applications where id = $1`, [app.id])).store_id === shop);
  b = await become(verified, 'Lerato Bakes Two');
  rec('one approval gives one shop (a second is refused)', !!b.err, b.err);
  await as(verified); const after = (await one(`select my_entrepreneur_status() r`)).r; await admin();
  rec('status shows the student now has a shop', after.has_shop === true);
  // a business manager is not affected
  const mgr = await mkUser('mgr@shop.test', 'manager');
  await as(mgr);
  const biz = await tryq(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, opening_time, closing_time) values (auth.uid(), 'Biz Grill', 'biz-grill', 'Fast Food', 'Hatfield', 'Shop 1', 'University of Pretoria', 'pending', '08:00', '20:00') returning id`);
  await admin();
  rec('business (non-student) shop registration is unaffected', !biz.err, biz.err);

  // ---------------- withdraw / retention / deletion ----------------
  await as(tuksLogin); const wd = (await one(`select withdraw_entrepreneur_application() r`)).r; await admin();
  rec('an applicant can withdraw an open application', wd.ok && (await one(`select count(*)::int n from entrepreneur_applications where user_id = $1 and status = 'withdrawn'`, [tuksLogin])).n === 1);
  await q(`update entrepreneur_applications set reviewed_at = now() - interval '91 days' where id = $1`, [app.id]);
  await q(`select purge_entrepreneur_sensitive()`);
  rec('population group is deleted 90 days after a decision', !(await one(`select 1 x from entrepreneur_demographics where application_id = $1`, [app.id])));
  await as(gmail); const del = await tryq(`select delete_my_account('not_using', null)`); await admin();
  rec('deleting an account deletes its applications', !del.err && (await one(`select count(*)::int n from entrepreneur_applications where user_id = $1`, [gmail])).n === 0, del.err);

  try { await q(SQL('student_entrepreneurs_rollback.sql')); await q(SQL('student_entrepreneurs.sql')); rec('rollback runs and the file re-applies', true); } catch (e) { rec('rollback runs and the file re-applies', false, e.message); }

  await db.end();
  try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {}
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
