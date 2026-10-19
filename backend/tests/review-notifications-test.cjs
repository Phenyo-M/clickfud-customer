// Database test for supabase/review_notifications.sql: every review request
// reaches the developer's bell, every decision reaches the right shop or
// student, nobody else gets them, and a decision that isn't saved notifies
// no one. Local copy, synthetic data.
//   NODE_PATH=backend/tests/lt/node_modules node backend/tests/review-notifications-test.cjs
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');
const PORT = 55891, DIR = path.join(LT, 'cfreviewnotif');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 240)})` : '')]);

(async () => {
  const db = await build(PORT, DIR); const q = (s, p) => db.query(s, p); const one = async (s, p) => (await q(s, p)).rows[0];
  const admin = async () => { await q('reset role'); await q(`select set_config('request.jwt.claims', '', false)`); };
  const as = async (id) => { await q('reset role'); await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await q('set role authenticated'); };
  const tryq = async (s, p) => { try { return { rows: (await q(s, p)).rows }; } catch (e) { return { err: e.message }; } };
  const run = async (u, s, p) => { await as(u); const r = await tryq(s, p); await admin(); return r; };
  await admin();
  await q(`create table if not exists cron.job (jobid bigint primary key, jobname text, schedule text);
           create table if not exists cron.job_run_details (jobid bigint, status text, start_time timestamptz, end_time timestamptz, return_message text);
           create table if not exists net._http_response (id bigint generated always as identity, status_code int, error_msg text, timed_out boolean default false, created timestamptz default now());`);
  for (const f of ['student_sellers.sql', 'seller_review_address.sql', 'student_application_details.sql', 'student_number_from_email.sql', 'allowed_domains.sql',
                   'approval_emails.sql', 'notification_links.sql', 'student_collection_times.sql', 'student_order_codes.sql', 'notification_queue.sql', 'shop_test_mode.sql',
                   'ops_monitoring.sql', 'show_partner_shops.sql', 'payment_options.sql', 'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql',
                   'engagement_deals.sql', 'poll_review.sql', 'promo_review.sql']) await q(SQL(f));
  await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
  try { await q(SQL('review_notifications.sql')); await q(SQL('review_notifications.sql')); rec('migration applies (twice)', true); } catch (e) { rec('migration applies (twice)', false, e.message); throw e; }

  const mk = async (email, role) => {
    const id = crypto.randomUUID();
    await q(`set session_replication_role = replica`);
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, email]);
    await q(`insert into profiles (id, name, email, role, status, active) values ($1, $2, $2, $3, 'approved', true)`, [id, email, role]);
    await q(`set session_replication_role = origin`);
    return id;
  };
  const mgr = await mk('mgr@shop.test', 'manager');
  const other = await mk('other@shop.test', 'manager');
  const dev = await mk('dev@clickfood.test', 'developer');
  const cust = await mk('thandi@gmail.com', 'customer');
  const seller = await mk('u12345678@tuks.co.za', 'customer');
  const all = [mgr, other, dev, cust, seller];
  const snap = async () => { const r = {}; for (const u of all) r[u] = (await one(`select count(*)::int n from notifications where user_id = $1`, [u])).n; return r; };
  // run fn, then return the new notifications per user
  const delta = async (fn) => {
    const before = await snap(); const t0 = (await one(`select now() t`)).t;
    await fn();
    const rows = (await q(`select user_id, type, message, link from notifications where created_at >= $1 order by created_at`, [t0])).rows;
    const after = await snap();
    return { rows, n: (u) => after[u] - before[u], of: (u) => rows.filter(x => x.user_id === u) };
  };
  const only = (d, u, type) => d.of(u).length === 1 && d.of(u)[0].type === type && all.filter(x => x !== u).every(x => d.n(x) === 0);

  // ---------------- business shop ----------------
  let shop;
  let d = await delta(async () => { shop = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind)
    values ($1, 'Kota Hub T', 'kota-hub-t', 'Fast Food', 'Hatfield', 'x', 'University of Pretoria', 'pending', false, '00:00', '23:59', 'business') returning id`, [mgr])).id; });
  rec('business application -> developer (unchanged)', only(d, dev, 'store_review'), JSON.stringify(d.rows));
  await q(`update profiles set store_id = $1 where id = $2`, [shop, mgr]);
  d = await delta(() => q(`update stores set status = 'rejected', rejection_reason = 'Please add a real address.' where id = $1`, [shop]));
  rec('application not approved -> the manager, with the reason', only(d, mgr, 'store_rejected') && /real address/.test(d.of(mgr)[0].message), JSON.stringify(d.rows));
  d = await delta(() => q(`update stores set status = 'approved', rejection_reason = null where id = $1`, [shop]));
  rec('application approved -> the manager', only(d, mgr, 'store_approved') && d.of(mgr)[0].link.store_id === shop, JSON.stringify(d.rows));
  d = await delta(() => q(`update stores set publish_requested_at = now() where id = $1`, [shop]));
  rec('publish request -> developer (unchanged)', only(d, dev, 'publish_request'), JSON.stringify(d.rows));
  d = await delta(() => q(`update stores set publish_rejection_reason = 'Add product photos first.' where id = $1`, [shop]));
  rec('publish request not approved -> the manager, with the reason', only(d, mgr, 'publish_rejected') && /photos/.test(d.of(mgr)[0].message), JSON.stringify(d.rows));
  d = await delta(() => q(`update stores set is_published = true, publish_rejection_reason = null where id = $1`, [shop]));
  rec('publish request approved -> the manager', only(d, mgr, 'publish_approved'), JSON.stringify(d.rows));
  d = await delta(() => q(`update stores set address = 'Shop 4' where id = $1`, [shop]));
  rec('an ordinary shop edit notifies no one', d.rows.length === 0, JSON.stringify(d.rows));

  // ---------------- products ----------------
  let item;
  d = await delta(async () => { item = (await one(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, 'Cheese Kota', 'Lunch', 45, 'x', 'Kota', 'pending', true, 50) returning id`, [shop])).id; });
  rec('product sent for review -> developer (unchanged)', only(d, dev, 'menu_review'), JSON.stringify(d.rows));
  d = await delta(() => q(`update menu_items set status = 'rejected', rejection_reason = 'Photo is blurry.' where id = $1`, [item]));
  rec('product not approved -> the manager, with the reason', only(d, mgr, 'menu_rejected') && /blurry/.test(d.of(mgr)[0].message), JSON.stringify(d.rows));
  d = await delta(() => q(`update menu_items set status = 'approved', rejection_reason = null, platform_fee_amount = 2.5 where id = $1`, [item]));
  rec('product approved -> the manager, with the platform fee', only(d, mgr, 'menu_approved') && /R2\.50/.test(d.of(mgr)[0].message) && d.of(mgr)[0].link.menu_item_id === item, JSON.stringify(d.rows));
  d = await delta(() => q(`update menu_items set status = 'suspended', suspension_reason = 'Customer complaints this week.' where id = $1`, [item]));
  rec('product suspended -> the manager, with the reason', only(d, mgr, 'menu_suspended') && /complaints/.test(d.of(mgr)[0].message), JSON.stringify(d.rows));
  d = await delta(() => q(`update menu_items set status = 'approved', suspension_reason = null where id = $1`, [item]));
  rec('product back on sale -> the manager', only(d, mgr, 'menu_approved') && /back on sale/.test(d.of(mgr)[0].message), JSON.stringify(d.rows));
  d = await delta(() => q(`update menu_items set price = 50 where id = $1`, [item]));
  rec('an ordinary product edit notifies no one', d.rows.length === 0);
  // a decision that is rolled back notifies no one
  await q('begin'); await q(`update menu_items set status = 'rejected', rejection_reason = 'x' where id = $1`, [item]); await q('rollback');
  rec('a decision that is not saved sends nothing', (await one(`select count(*)::int n from notifications where user_id = $1 and message like '%not approved: x'`, [mgr])).n === 0);

  // ---------------- polls ----------------
  let pid;
  d = await delta(async () => { pid = (await run(mgr, `insert into polls (question, options, store_id, created_by) values ('Which new kota should we add?', array['Cheese', 'Russian'], $1, $2) returning id`, [shop, mgr])).rows[0].id; });
  rec('poll sent for review -> developer', only(d, dev, 'poll_review') && d.of(dev)[0].link.poll_id === pid, JSON.stringify(d.rows));
  d = await delta(() => run(dev, `select dev_review_poll($1, 'approve')`, [pid]));
  rec('poll approved -> the manager who made it', only(d, mgr, 'poll_approved'), JSON.stringify(d.rows));
  const p2 = (await run(mgr, `insert into polls (question, options, store_id, created_by) values ('Rate us from one to three', array['1', '2'], $1, $2) returning id`, [shop, mgr])).rows[0].id;
  d = await delta(() => run(dev, `select dev_review_poll($1, 'reject', 'Ask about food instead.')`, [p2]));
  rec('poll not approved -> the manager, with the reason', only(d, mgr, 'poll_rejected') && /food instead/.test(d.of(mgr)[0].message), JSON.stringify(d.rows));
  d = await delta(() => run(dev, `insert into polls (question, options, store_id, created_by) values ('What should ClickFood add next?', array['A', 'B'], null, $1)`, [dev]));
  rec('the developer\'s own campus poll notifies no one', d.rows.length === 0, JSON.stringify(d.rows));

  // ---------------- promo codes ----------------
  let prid;
  d = await delta(async () => { prid = (await run(mgr, `insert into promotions (code, type, value, active, store_id, menu_item_ids) values ('KOTA15', 'fixed', 15, true, $1, array[$2]::uuid[]) returning id`, [shop, item])).rows[0].id; });
  rec('promo code sent for review -> developer', only(d, dev, 'promo_review') && d.of(dev)[0].link.promotion_id === prid, JSON.stringify(d.rows));
  d = await delta(() => run(dev, `select dev_review_promo($1, 'approve')`, [prid]));
  rec('promo code approved -> the shop\'s manager', only(d, mgr, 'promo_approved') && /KOTA15/.test(d.of(mgr)[0].message), JSON.stringify(d.rows));
  d = await delta(() => run(mgr, `update promotions set active = false where id = $1`, [prid]));
  rec('switching a code off notifies no one', d.rows.length === 0);
  d = await delta(() => run(mgr, `update promotions set value = 40 where id = $1`, [prid]));
  rec('changing an approved code -> developer again', only(d, dev, 'promo_review'), JSON.stringify(d.rows));
  d = await delta(() => run(mgr, `update promotions set value = 41 where id = $1`, [prid]));
  rec('...but not again for each edit while it is still waiting', d.rows.length === 0, JSON.stringify(d.rows));
  d = await delta(() => run(dev, `select dev_review_promo($1, 'reject', 'R41 off a R45 kota looks like a mistake.')`, [prid]));
  rec('promo code not approved -> the manager, with the reason', only(d, mgr, 'promo_rejected') && /mistake/.test(d.of(mgr)[0].message), JSON.stringify(d.rows));

  // ---------------- student shop (already covered: exactly one notification, not two) ----------------
  const sshop = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind)
    values ($1, 'Thabo Treats', 'thabo-treats', 'Student Food', 'Hatfield', 'Res', 'University of Pretoria', 'pending', false, '00:00', '23:59', 'student') returning id`, [seller])).id;
  d = await delta(() => q(`update stores set status = 'approved' where id = $1`, [sshop]));
  rec('student shop approved -> the student, once (no double message)', only(d, seller, 'store_approved'), JSON.stringify(d.rows));

  // ---------------- student email check ----------------
  const UP = (await one(`select id from universities where short_code = 'UP'`)).id;
  const sv = (await one(`insert into student_verifications (user_id, email, university_id, status) values ($1, 'thandi@someuni.ac.za', $2, 'needs_review') returning id`, [cust, UP])).id;
  d = await delta(() => run(dev, `select dev_review_student($1, 'reject', 'Not an official student email.')`, [sv]));
  rec('student email not approved -> the student, with the reason', only(d, cust, 'student_rejected') && /official/.test(d.of(cust)[0].message), JSON.stringify(d.rows));
  const sv2 = (await one(`insert into student_verifications (user_id, email, university_id, status) values ($1, 'thandi2@someuni.ac.za', $2, 'needs_review') returning id`, [cust, UP])).id;
  d = await delta(() => run(dev, `select dev_review_student($1, 'approve', 'Checked the student card.')`, [sv2]));
  rec('student email approved -> the student', only(d, cust, 'student_verified'), JSON.stringify(d.rows));

  // ---------------- privacy ----------------
  const peek = await run(other, `select count(*)::int n from notifications where user_id <> auth.uid()`);
  rec('nobody can read another person\'s notifications', peek.rows && peek.rows[0].n === 0);
  rec('the other shop\'s manager received nothing at all', (await one(`select count(*)::int n from notifications where user_id = $1`, [other])).n === 0);
  const fake = await run(mgr, `insert into notifications (user_id, message, type) values ($1, 'You won!', 'info')`, [cust]);
  rec('a manager cannot send a notification to someone directly', !!fake.err);

  try { await q(SQL('review_notifications_rollback.sql')); await q(SQL('review_notifications.sql')); rec('rollback runs and the file re-applies', true); } catch (e) { rec('rollback runs and the file re-applies', false, e.message); }
  await db.end();
  try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {}
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
