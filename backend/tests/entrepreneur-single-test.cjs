// Database test for supabase/entrepreneur_single_application.sql: ONE
// eligibility application per student (draft -> submit -> review on the same
// record, reopened after a rejection), database shop-setup drafts (owner only,
// approved applicants only, removed when the shop is created), and the shop
// itself staying a separate step. Local copy, synthetic data.
//   NODE_PATH=backend/tests/lt/node_modules node backend/tests/entrepreneur-single-test.cjs
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');
const PORT = 55861, DIR = path.join(LT, 'cfentsingle');
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
                   'ops_monitoring.sql', 'show_partner_shops.sql', 'payment_options.sql', 'customer_tools.sql', 'group_payments.sql',
                   'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'shop_locations.sql', 'privacy_legal.sql', 'student_entrepreneurs.sql', 'order_distance.sql', 'institutions_v2.sql', 'student_shops_open.sql']) await q(SQL(f));
  await q(`update allowed_domains set active = true`);
  await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
  await q(`update platform_config set order_distance_rule = false where id = 1`);
  try { await q(SQL('entrepreneur_single_application.sql')); await q(SQL('entrepreneur_single_application.sql')); rec('migration applies (twice)', true); } catch (e) { rec('migration applies (twice)', false, e.message); throw e; }

  const UP = (await one(`select id from universities where short_code = 'UP'`)).id;
  const mk = async (email, role, student) => {
    const id = crypto.randomUUID();
    await q(`set session_replication_role = replica`);
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, email]);
    await q(`insert into profiles (id, name, email, role, status, active, is_student, home_university_id, university, campus_location) values ($1, $2, $2, $3, 'approved', true, $4, $5, $6, $7)`,
      [id, email, role || 'customer', !!student, student ? UP : null, student ? 'University of Pretoria' : null, student ? 'Hatfield' : null]);
    await q(`set session_replication_role = origin`);
    return id;
  };
  const stu = await mk('u12345678@tuks.co.za', 'customer', true);
  const other = await mk('u87654321@tuks.co.za', 'customer', true);
  const dev = await mk('dev@clickfood.test', 'developer');
  const full = { full_name: 'Thabo M', phone: '072 123 4567', year_of_study: 'second', expected_stay: '3', years_left: '2', business_name: 'Thabo Kota', categories: ['lunch'],
    description: 'Kotas made fresh every weekday for students near Hatfield campus.', why_choose: 'Big portions, fair prices and always on time between lectures.',
    food_safety: 'Clean kitchen, food kept hot in insulated boxes, sold the same day.', available_days: [1, 3, 5], available_periods: ['midday'], confirm_accurate: true, accept_terms: true, ack_privacy: true };
  const save = async (u, p, submit) => { await as(u); const r = await tryq(`select save_entrepreneur_application($1::jsonb, $2) r`, [JSON.stringify(p), !!submit]); await admin(); return r.err ? { err: r.err } : r.rows[0].r; };
  const count = async (u) => (await one(`select count(*)::int n from entrepreneur_applications where user_id = $1`, [u])).n;

  // ---------------- one application ----------------
  let r = await save(stu, { full_name: 'Thabo' }, false);
  let r2 = await save(stu, { full_name: 'Thabo M', business_name: 'Thabo Kota' }, false);
  rec('Save as Draft keeps updating the same record', r.ok && r2.ok && r.id === r2.id && await count(stu) === 1, JSON.stringify([r, r2]));
  rec('a draft is not submitted for review', ((await one(`select status from entrepreneur_applications where user_id = $1`, [stu])) || {}).status === 'draft');
  const both = await Promise.all([save(stu, full, true), save(stu, full, true)]).catch(e => [{ err: e.message }]);
  rec('Send for Review tapped twice: still one application, now pending review', await count(stu) === 1 && (await one(`select status from entrepreneur_applications where user_id = $1`, [stu])).status === 'pending_review', JSON.stringify(both));
  const dup = await tryq(`insert into entrepreneur_applications (user_id, status) values ($1, 'draft')`, [stu]);
  rec('the database refuses a second application record for the same student', !!dup.err, dup.err);
  // rejection -> reopen the same record
  await as(dev); await one(`select dev_review_entrepreneur($1, 'reject', 'Please add more about storage.', true) r`, [r.id]); await admin();
  r = await save(stu, Object.assign({}, full, { food_safety: 'Fridge at 4 degrees, hot boxes, labelled with the time, sold the same day.' }), false);
  rec('after a rejection, editing reopens THE SAME record as a draft (no duplicate)', r.ok && r.id === r2.id && await count(stu) === 1 && (await one(`select status from entrepreneur_applications where user_id = $1`, [stu])).status === 'draft', JSON.stringify(r));
  await as(stu); const st = (await one(`select my_entrepreneur_status() r`)).r; await admin();
  rec('...and the last review note is still shown to the student', /storage/.test(st.application.decision_reason || ''), JSON.stringify(st.application.decision_reason));
  r = await save(stu, full, true);
  rec('resubmitting changes that record back to pending review', r.ok && await count(stu) === 1 && (await one(`select status from entrepreneur_applications where user_id = $1`, [stu])).status === 'pending_review');
  // non-student
  const non = await mk('non@gmail.com', 'customer', false);
  r = await save(non, { full_name: 'Non' }, false);
  rec('a non-student cannot start an application', (r.err && /student accounts/.test(r.err)) || (r.ok === false && /student accounts/.test(r.error)), JSON.stringify(r));

  // ---------------- shop setup drafts ----------------
  await as(stu); const d0 = (await one(`select save_shop_setup_draft('{"business_name":"Thabo Kota"}'::jsonb) r`)).r; await admin();
  rec('a pending applicant cannot save a shop draft (not approved yet)', d0.ok === false && /approved first/.test(d0.error), JSON.stringify(d0));
  await as(dev); await one(`select dev_review_entrepreneur($1, 'approve') r`, [r2.id]); await admin();
  await as(stu);
  const d1 = (await one(`select save_shop_setup_draft($1::jsonb) r`, [JSON.stringify({ business_name: 'Thabo Kota', whatsapp: '072 123 4567', cover: 'https://x/c.webp', pin: { lat: -25.75, lng: 28.23 }, details: { business_type: 'home_kitchen', opening_time: '08:00' }, status: 'approved', store_id: 'x' })])).r;
  const d2 = (await one(`select save_shop_setup_draft('{"business_name":"Thabo Kota 2"}'::jsonb) r`)).r;
  const mine = await tryq(`select data from shop_setup_drafts`);
  await admin();
  rec('the approved student saves a shop draft (updated, not duplicated)', d1.ok && d2.ok && mine.rows.length === 1 && mine.rows[0].data.business_name === 'Thabo Kota 2', JSON.stringify(mine.rows));
  rec('only shop-setup answers are kept (nothing that grants anything)', !('status' in (await one(`select data from shop_setup_drafts where user_id = $1`, [stu])).data) && !('store_id' in (await one(`select data from shop_setup_drafts where user_id = $1`, [stu])).data));
  await as(other); const peek = await tryq(`select count(*)::int n from shop_setup_drafts`); const w = await tryq(`insert into shop_setup_drafts (user_id, data) values ($1, '{}')`, [stu]); await admin();
  rec('another student cannot read or write someone else\'s draft', peek.rows && peek.rows[0].n === 0 && !!w.err);
  rec('approval did not create a second application', await count(stu) === 1);
  // the shop is created: draft removed, application linked, still one application
  const shop = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, location_type, pickup_lat, pickup_lng)
    values ($1, 'Thabo Kota', 'thabo-kota', 'Student Food', 'Hatfield', 'Res', 'University of Pretoria', 'pending', false, '08:00', '17:00', 'student', 'campus', -25.75, 28.23) returning id`, [stu])).id;
  rec('creating the shop removes the draft and links the shop to the same application', !(await one(`select 1 x from shop_setup_drafts where user_id = $1`, [stu])) && (await one(`select store_id from entrepreneur_applications where user_id = $1`, [stu])).store_id === shop && await count(stu) === 1);
  rec('the shop has its own review status (pending), separate from the approved application', (await one(`select status from stores where id = $1`, [shop])).status === 'pending' && (await one(`select status from entrepreneur_applications where user_id = $1`, [stu])).status === 'approved');
  await as(stu); const again = await save(stu, full, false); await admin();
  rec('an approved student with a shop is never sent back to the application', again.ok === false || again.err, JSON.stringify(again));

  try { await q(SQL('entrepreneur_single_application_rollback.sql')); await q(SQL('entrepreneur_single_application.sql')); rec('rollback runs and the file re-applies', true); } catch (e) { rec('rollback runs and the file re-applies', false, e.message); }
  await db.end();
  try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {}
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
