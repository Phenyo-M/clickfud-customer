// Database test for supabase/student_shops_open.sql: student shops are seen
// by everyone (non-students, every institution, visitors), campus business
// shops only by students of their institution, and the developer-only
// report of student sellers with their orders. Local copy, synthetic data.
//   NODE_PATH=backend/tests/lt/node_modules node backend/tests/student-shops-open-test.cjs
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');
const PORT = 55831, DIR = path.join(LT, 'cfstuopen');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 240)})` : '')]);

(async () => {
  const db = await build(PORT, DIR); const q = (s, p) => db.query(s, p); const one = async (s, p) => (await q(s, p)).rows[0];
  const admin = async () => { await q('reset role'); await q(`select set_config('request.jwt.claims', '', false)`); };
  const as = async (id) => { await q('reset role'); await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(id ? { sub: id, role: 'authenticated' } : { role: 'anon' })]); await q(id ? 'set role authenticated' : 'set role anon'); };
  const tryq = async (s, p) => { try { return { rows: (await q(s, p)).rows }; } catch (e) { return { err: e.message }; } };
  await admin();
  await q(`create table if not exists cron.job (jobid bigint primary key, jobname text, schedule text);
           create table if not exists cron.job_run_details (jobid bigint, status text, start_time timestamptz, end_time timestamptz, return_message text);
           create table if not exists net._http_response (id bigint generated always as identity, status_code int, error_msg text, timed_out boolean default false, created timestamptz default now());`);
  for (const f of ['student_sellers.sql', 'seller_review_address.sql', 'student_application_details.sql', 'student_number_from_email.sql', 'allowed_domains.sql',
                   'approval_emails.sql', 'notification_links.sql', 'student_collection_times.sql', 'student_order_codes.sql', 'notification_queue.sql', 'shop_test_mode.sql',
                   'ops_monitoring.sql', 'show_partner_shops.sql', 'payment_options.sql', 'customer_tools.sql', 'group_payments.sql',
                   'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'shop_locations.sql', 'privacy_legal.sql', 'student_entrepreneurs.sql', 'order_distance.sql', 'institutions_v2.sql']) await q(SQL(f));
  await q(`update allowed_domains set active = true`);
  await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
  await q(`update platform_config set order_distance_rule = false where id = 1`);
  try { await q(SQL('student_shops_open.sql')); await q(SQL('student_shops_open.sql')); rec('migration applies (twice)', true); } catch (e) { rec('migration applies (twice)', false, e.message); throw e; }

  const U = {}; for (const r of (await q(`select id, short_code from universities`)).rows) U[r.short_code] = r.id;
  const mk = async (email, role, confirmed = true) => {
    const id = crypto.randomUUID();
    await q(`set session_replication_role = replica`);
    await q(`insert into auth.users (id, email, email_confirmed_at, created_at) values ($1, $2, $3, now())`, [id, email, confirmed ? new Date() : null]);
    await q(`insert into profiles (id, name, email, role, status, active) values ($1, $2, $2, $3, 'approved', true)`, [id, email, role || 'customer']);
    await q(`set session_replication_role = origin`);
    return id;
  };
  const stu = async (email, uni) => { const id = await mk(email); await q(`set session_replication_role = replica`); await q(`update profiles set is_student = true, home_university_id = $2, university = (select name from universities where id = $2), campus_location = 'Hatfield' where id = $1`, [id, U[uni]]); await q(`set session_replication_role = origin`); return id; };
  const up = await stu('up@gmail.com', 'UP'), tut = await stu('tut@gmail.com', 'TUT');
  const non = await mk('non@gmail.com'); await q(`update profiles set is_student = false where id = $1`, [non]).catch(() => {});
  const seller = await stu('u12345678@tuks.co.za', 'UP');
  const dev = await mk('dev@clickfood.test', 'developer');
  const mgr = await mk('mgr@shop.test', 'manager');
  const mkShop = async (owner, name, kind, loc, avail) => (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, location_type, availability, pickup_lat, pickup_lng)
    values ($1, $2, $3, 'Food', 'Hatfield', 'Res', 'University of Pretoria', 'approved', true, '00:00', '23:59', $4, $5, $6, -25.75, 28.23) returning id`, [owner, name, name.toLowerCase().replace(/\W+/g, '-'), kind, loc, avail || 'university'])).id;
  await q(`insert into entrepreneur_applications (user_id, status, business_name, submitted_at) values ($1, 'approved', 'Mama Bakes', now())`, [seller]);
  const S = { student: await mkShop(seller, 'Mama Bakes', 'student', 'campus'), campusBiz: await mkShop(mgr, 'UP Kota', 'business', 'campus'), general: await mkShop(mgr, 'Town Pizza', 'business', 'off_campus') };
  await q(`insert into seller_profiles (store_id, owner_id, whatsapp, food_categories, rules_accepted_at) values ($1, $2, '27721234567', array['Lunch'], now())`, [S.student, seller]);
  const seen = async (id) => { await as(id); const r = (await q(`select name from stores where id = any($1::uuid[])`, [Object.values(S)])).rows.map(x => x.name).sort(); await admin(); return r; };
  rec('non-student: student shops + general shops, not the campus business shop', JSON.stringify(await seen(non)) === JSON.stringify(['Mama Bakes', 'Town Pizza']), JSON.stringify(await seen(non)));
  rec('visitor (signed out): the same', JSON.stringify(await seen(null)) === JSON.stringify(['Mama Bakes', 'Town Pizza']), JSON.stringify(await seen(null)));
  rec('TUT student: the UP student shop too, but not the UP campus business shop', JSON.stringify(await seen(tut)) === JSON.stringify(['Mama Bakes', 'Town Pizza']), JSON.stringify(await seen(tut)));
  rec('UP student: everything', JSON.stringify(await seen(up)) === JSON.stringify(['Mama Bakes', 'Town Pizza', 'UP Kota']), JSON.stringify(await seen(up)));
  await as(non); const menu = (await one(`select count(*)::int n from menu_items m join stores s on s.id = m.store_id where s.id = $1`, [S.student])).n; await admin();
  const item = (await one(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, 'Muffin', 'Breakfast', 15, 'x', 'Fresh muffin', 'approved', true, 50) returning id`, [S.student])).id;
  await as(non);
  const o = await tryq(`insert into orders (customer_id, store_id, items, payment_method, total, delivery_location) values (auth.uid(), $1, $2, 'cod', 15, $3) returning id`, [S.student, JSON.stringify([{ menuItemId: item, name: 'Muffin', qty: 1, price: 15 }]), JSON.stringify({ fulfilment: 'collection', collectionTime: new Date(Date.now() + 3600000).toISOString() })]);
  const waR = await tryq(`select seller_contact($1) w`, [S.student]); const wa = waR.rows ? waR.rows[0].w : waR.err;
  const blocked = await tryq(`insert into orders (customer_id, store_id, items, payment_method, total, delivery_location) values (auth.uid(), $1, '[{"name":"x","qty":1,"price":1}]', 'cod', 1, '{"fulfilment":"collection"}') returning id`, [S.campusBiz]);
  await admin();
  rec('a non-student can order from a student shop and get the seller\'s WhatsApp', !o.err && wa === '27721234567', o.err);
  rec('...but still not from the campus business shop', !!blocked.err && /isn't available to your account/.test(blocked.err), blocked.err);

  // ---------------- developer report ----------------
  await q(`update orders set status = 'collected' where store_id = $1`, [S.student]);
  await as(dev); const rows = (await q(`select * from dev_student_sellers()`)).rows; await admin();
  const r = rows.find(x => x.shop_name === 'Mama Bakes');
  rec('developer report: one row per student account with a shop (business shops not included)', rows.length === 1 && !!r, JSON.stringify(rows.map(x => x.shop_name)));
  rec('...with student details (institution, campus, verified student email, WhatsApp, application)', r.institution === 'University of Pretoria' && r.campus === 'Hatfield' && r.is_student === true && r.student_email_verified === true && r.verified_email === 'u12345678@tuks.co.za' && r.whatsapp === '27721234567' && r.application_status === 'approved', JSON.stringify(r));
  rec('...and the shop\'s orders (1 completed, R15 sales)', r.orders_total === 1 && r.orders_completed === 1 && Number(r.sales) === 15 && !!r.last_order_at, JSON.stringify({ t: r.orders_total, c: r.orders_completed, s: r.sales }));
  for (const [who, id] of [['a customer', non], ['the seller', seller], ['a manager', mgr]]) {
    await as(id); const x = await tryq(`select count(*)::int n from dev_student_sellers()`); await admin();
    rec(`${who} gets nothing from the report`, !x.err && x.rows[0].n === 0, x.err);
  }
  // ---------------- hustleUP: UP only (hustleup_up_only.sql) ----------------
  await q(SQL('hustleup_up_only.sql')); await q(SQL('hustleup_up_only.sql'));
  await q(`update seller_profiles set hustleup_member = true where store_id = $1`, [S.student]);
  rec('hustleUP: a UP student seller can be a member', (await one(`select hustleup_member h from seller_profiles where store_id = $1`, [S.student])).h === true);
  const tutSeller = await stu('219999999@tut4life.ac.za', 'TUT');
  await q(`insert into entrepreneur_applications (user_id, status, business_name, submitted_at) values ($1, 'approved', 'TUT Bakes', now())`, [tutSeller]);
  const tshop = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, location_type, pickup_lat, pickup_lng)
    values ($1, 'TUT Bakes', 'tut-bakes', 'Food', 'Arcadia', 'Res', 'Tshwane University of Technology', 'approved', true, '00:00', '23:59', 'student', 'campus', -25.74, 28.2) returning id`, [tutSeller])).id;
  await q(`insert into seller_profiles (store_id, owner_id, whatsapp, food_categories, rules_accepted_at, hustleup_member) values ($1, $2, '27731234567', array['Lunch'], now(), true)`, [tshop, tutSeller]);
  rec('hustleUP: a TUT student seller is never saved as a member (even if the request says yes)', (await one(`select hustleup_member h from seller_profiles where store_id = $1`, [tshop])).h === false);
  await q(`update seller_profiles set hustleup_member = true where store_id = $1`, [tshop]);
  rec('hustleUP: ...not by a later change either', (await one(`select hustleup_member h from seller_profiles where store_id = $1`, [tshop])).h === false);

  try { await q(SQL('student_shops_open_rollback.sql')); await q(SQL('student_shops_open.sql')); rec('rollback runs and the file re-applies', true); } catch (e) { rec('rollback runs and the file re-applies', false, e.message); }
  await db.end();
  try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {}
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
