// Database test for shop_locations.sql (campus / off-campus shops) and
// privacy_legal.sql (order clean-up on account deletion, versioned Terms /
// Privacy acceptance), plus parts of open_signup_students.sql the first test
// doesn't cover: the developer notice for unlisted institutions, managers
// saving student-deal settings, and the TOTAL claim limit with two different
// students ordering at the same moment. Local copy, synthetic data.
//   NODE_PATH=backend/tests/lt/node_modules node backend/tests/locations-legal-test.cjs
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Client } = require('pg');
const { build, BIN, LT } = require('./load/build-db.cjs');
const PORT = 55731, DIR = path.join(LT, 'cflocations');
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
                   'ops_monitoring.sql', 'show_partner_shops.sql', 'payment_options.sql', 'account_deletion.sql', 'account_deletion_reasons.sql', 'shop_name_fix.sql',
                   'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'shop_locations.sql']) await q(SQL(f));
  await q(`update allowed_domains set active = true where domain in ('tuks.co.za', 'tut4life.ac.za')`);
  try { await q(SQL('privacy_legal.sql')); await q(SQL('privacy_legal.sql')); rec('privacy_legal.sql applies (twice)', true); } catch (e) { rec('privacy_legal.sql applies (twice)', false, e.message); throw e; }
  await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
  // the parts of Supabase's auth schema that delete_my_account touches (the local copy only mirrors public)
  await q(`alter table auth.users add column if not exists email_change text, add column if not exists phone text, add column if not exists encrypted_password text,
             add column if not exists raw_user_meta_data jsonb default '{}', add column if not exists banned_until timestamptz, add column if not exists deleted_at timestamptz;
           create table if not exists auth.identities (user_id uuid); create table if not exists auth.mfa_factors (user_id uuid);
           create table if not exists auth.one_time_tokens (user_id uuid); create table if not exists auth.refresh_tokens (user_id text);
           create table if not exists auth.sessions (user_id uuid);`);

  const mkUser = async (email, role, name) => {
    const id = crypto.randomUUID();
    await q(`set session_replication_role = replica`);
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, email]);
    await q(`insert into profiles (id, name, email, role, status, active) values ($1, $2, $3, $4, 'approved', true)`, [id, name || email, email, role]);
    await q(`set session_replication_role = origin`);
    return id;
  };
  const mgr = await mkUser('mgr@shop.test', 'manager', 'Mgr');
  const mgr2 = await mkUser('mgr2@shop.test', 'manager', 'Other Mgr');
  const dev = await mkUser('dev@clickfood.test', 'developer', 'Dev');
  const UP = (await one(`select id from universities where name = 'University of Pretoria'`)).id;

  // ---------------- shop locations ----------------
  const base = `insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, location_type, pickup_lat, pickup_lng)`;
  await as(mgr);
  const c1 = await tryq(`${base} values (auth.uid(), 'Campus Grill', 'campus-grill', 'Fast Food', 'Hatfield', 'Shop 4, Student Centre', 'University of Pretoria', 'pending', false, '00:00', '23:59', 'business', 'campus', null, null) returning id`);
  rec('a manager registers a campus shop (university + campus, no pin needed)', !c1.err, c1.err);
  const o1 = await tryq(`${base} values (auth.uid(), 'Town Pizza', 'town-pizza', 'Pizza', '', '12 Main Road, Hatfield', null, 'pending', false, '00:00', '23:59', 'business', 'off_campus', null, null) returning id`);
  rec('an off-campus shop without a map pin is refused', !!o1.err && /on the map/.test(o1.err), o1.err);
  await admin();
  await as(mgr2);
  const o2 = await tryq(`${base} values (auth.uid(), 'Town Pizza', 'town-pizza', 'Pizza', '', '12 Main Road, Hatfield', null, 'pending', false, '00:00', '23:59', 'business', 'off_campus', -25.75, 28.24) returning id, university, location_type`);
  rec('an off-campus shop with an address and pin is saved with no university', !o2.err && o2.rows[0].university === null && o2.rows[0].location_type === 'off_campus', o2.err || JSON.stringify(o2.rows));
  const bad = await tryq(`update stores set pickup_lat = 200 where id = $1 returning id`, [o2.rows && o2.rows[0].id]);
  rec('an impossible pin is refused', !!bad.err, bad.err);
  await admin();
  const campusShop = c1.rows[0].id, townShop = o2.rows[0].id;
  // someone else's shop
  await as(mgr);
  const steal = await tryq(`update stores set pickup_lat = -25.1, pickup_lng = 28.1, address = 'moved' where id = $1 returning id`, [townShop]);
  await admin();
  rec('a manager cannot move another manager\'s shop', !steal.err && steal.rows.length === 0, steal.err || steal.rows.length);
  await q(`update stores set status = 'approved', is_published = true where id in ($1, $2)`, [campusShop, townShop]);
  await q(`update platform_config set show_partner_shops = true where id = 1`).catch(() => {});
  const cust = await mkUser('thandi@gmail.com', 'customer', 'Thandi');
  await q(`update profiles set home_university_id = $1, is_student = true where id = $2`, [UP, cust]);
  await as(cust); const disc = (await q(`select store_id, section from discover_shops(null) where store_id in ($1, $2)`, [campusShop, townShop])).rows; await admin();
  const sec = Object.fromEntries(disc.map(r => [r.store_id, r.section]));
  rec('discovery: the UP campus shop is "mine" for a UP student, the off-campus shop is for everyone', sec[campusShop] === 'mine' && sec[townShop] === 'everyone', JSON.stringify(sec));
  const nonStu = await mkUser('sipho@outlook.com', 'customer', 'Sipho');
  await as(nonStu); const disc2 = (await q(`select store_id, section from discover_shops(null) where store_id = $1`, [townShop])).rows; await admin();
  rec('a non-student (no university) also sees the off-campus shop', disc2.length === 1 && disc2[0].section === 'everyone', JSON.stringify(disc2));
  // switching a shop to off campus later
  await as(mgr); const sw = await tryq(`update stores set location_type = 'off_campus', university = null, campus_location = '', pickup_lat = -25.76, pickup_lng = 28.23 where id = $1 returning location_type`, [campusShop]); await admin();
  rec('a manager can change their shop to off campus later (with a pin)', !sw.err && sw.rows[0].location_type === 'off_campus', sw.err);

  // ---------------- manager: student-deal settings ----------------
  const item = (await one(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, 'Pizza', 'Lunch', 80, 'x', 'A pizza', 'approved', true, 500) returning id`, [townShop])).id;
  await q(`update profiles set store_id = $1 where id = $2`, [townShop, mgr2]);
  await as(mgr2);
  const pr = await tryq(`insert into promotions (code, type, value, active, store_id, title, audience, per_customer_limit, usage_limit, university_id, menu_item_ids) values ('LAST1', 'fixed', 10, true, $1, 'Last one', 'students', 1, 1, null, array[$2]::uuid[]) returning audience, per_customer_limit, usage_limit`, [townShop, item]);
  const prBad = await tryq(`insert into promotions (code, type, value, active, store_id, audience, menu_item_ids) values ('BADAUD', 'fixed', 5, true, $1, 'vips', array[$2]::uuid[]) returning id`, [townShop, item]);
  await admin();
  rec('a manager saves a student-only deal with per-customer and total limits', !pr.err && pr.rows[0].audience === 'students' && pr.rows[0].per_customer_limit === 1 && pr.rows[0].usage_limit === 1, pr.err);
  rec('an unknown audience is refused', !!prBad.err, prBad.err);
  // two different verified students take the LAST deal at the same moment
  const s1 = await mkUser('a1@tuks.co.za', 'customer', 'A1'), s2 = await mkUser('a2@tuks.co.za', 'customer', 'A2');
  for (const s of [s1, s2]) await q(`insert into student_verifications (user_id, email, university_id, status, verified_at) values ($1, $2, $3, 'verified', now())`, [s, 'x' + s.slice(0, 8) + '@tuks.co.za', UP]);
  const order = async (user, code, c) => {
    await as(user, c);
    const r = await tryq(`insert into orders (customer_id, store_id, items, payment_method, total, promo_code, discount, delivery_location) values (auth.uid(), $1, $2, 'cod', 1, $3, 10, $4) returning id`,
      [townShop, JSON.stringify([{ menuItemId: item, name: 'Pizza', qty: 1, price: 80 }]), code, JSON.stringify({ fulfilment: 'collection', collectionTime: new Date(Date.now() + 3600000).toISOString(), phone: '0711234567', customerName: 'Real Name', room: '12' })], c);
    await admin(c); return r;
  };
  const c2 = new Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database: 'postgres' }); await c2.connect();
  const both = await Promise.all([order(s1, 'LAST1', db), order(s2, 'LAST1', c2)]);
  rec('the last deal, two students at the same moment: only one gets it', both.filter(x => !x.err).length === 1 && both.filter(x => x.err).length === 1, both.map(x => x.err || 'ok').join(' | '));
  rec('used count never goes over the total limit', (await one(`select used_count n from promotions where code = 'LAST1'`)).n === 1);

  // ---------------- unlisted institution -> developer notice ----------------
  const stu = await mkUser('lerato@gmail.com', 'customer', 'Lerato');
  await q(`select student_verify_start($1, 'lerato@someuni.ac.za', null, null, $2)`, [stu, sha('tok-1')]);
  const cf = (await one(`select student_verify_confirm($1, $2) r`, [stu, sha('tok-1')])).r;
  const note = await one(`select count(*)::int n from notifications where user_id = $1 and type = 'student_review'`, [dev]);
  rec('an unlisted institution waits for review and the developer is notified', cf.status === 'needs_review' && note.n === 1, JSON.stringify(cf) + ' / ' + note.n);
  await as(dev); const list = await tryq(`select v.id, v.email, v.status, u.name uni, p.name from student_verifications v left join universities u on u.id = v.university_id left join profiles p on p.id = v.user_id where v.status = 'needs_review'`); await admin();
  rec('the developer can list it (Student checks)', !list.err && list.rows.length === 1, list.err);
  await as(cust); const peek = await tryq(`select id from student_verifications where status = 'needs_review'`); await admin();
  rec('another customer cannot see it', !peek.err ? peek.rows.length === 0 : true, peek.err);

  // ---------------- legal acceptance ----------------
  await as(cust);
  const st0 = (await one(`select my_legal_status() r`)).r;
  const acc = (await one(`select accept_legal() r`)).r;
  const st1 = (await one(`select my_legal_status() r`)).r;
  const forge = await tryq(`insert into legal_acceptances (user_id, document, version) values (auth.uid(), 'terms', '2030-01-01')`);
  const others = await tryq(`select count(*)::int n from legal_acceptances where user_id <> auth.uid()`);
  await admin();
  rec('a new customer must accept; after accepting nothing is pending', st0.terms === true && st0.privacy === true && acc.ok && st1.terms === false && st1.privacy === false, JSON.stringify([st0, st1]));
  rec('acceptances can only be added through accept_legal (no direct insert)', !!forge.err, forge.err);
  rec('a customer sees only their own acceptances', !others.err && others.rows[0].n === 0, others.err);
  await as(cust); await one(`select accept_legal() r`); await admin();
  rec('accepting twice keeps one row per version', (await one(`select count(*)::int n from legal_acceptances where user_id = $1`, [cust])).n === 2);
  // a new version: the old acceptance stays, the person is asked again
  await q(`create or replace function public.legal_versions() returns jsonb language sql immutable as $$ select '{"terms": "2026-12-01", "privacy": "2026-10-17"}'::jsonb $$`);
  await as(cust); const st2 = (await one(`select my_legal_status() r`)).r; await one(`select accept_legal() r`); await admin();
  rec('a new Terms version asks again and keeps the old record', st2.terms === true && st2.privacy === false && (await one(`select count(*)::int n from legal_acceptances where user_id = $1`, [cust])).n === 3, JSON.stringify(st2));

  // ---------------- account deletion clean-up ----------------
  const winner = both.findIndex(x => !x.err) === 0 ? s1 : s2;
  const ord = (await one(`select id from orders where customer_id = $1`, [winner])).id;
  await q(`update orders set status = 'collected' where id = $1`, [ord]);
  await as(winner);
  const del = await tryq(`select delete_my_account('not_using', null) r`);
  await admin();
  const after = await one(`select delivery_location d, customer_id from orders where id = $1`, [ord]);
  rec('deleting an account keeps the order', !del.err && !!after && after.customer_id === winner, del.err || JSON.stringify(del.rows));
  rec('...but removes the phone, name and room copied onto it', !del.err && !('phone' in after.d) && !('customerName' in after.d) && !('room' in after.d) && after.d.fulfilment === 'collection', del.err || JSON.stringify(after.d));
  rec('...and removes their student verification', (await one(`select count(*)::int n from student_verifications where user_id = $1`, [winner])).n === 0);
  rec('the promo claim stays (no personal data) so limits stay right', (await one(`select count(*)::int n from promo_claims where customer_id = $1`, [winner])).n === 1);

  // rollback
  try { await q(SQL('privacy_legal_rollback.sql')); await q(SQL('privacy_legal.sql')); rec('rollback runs and the file re-applies', true); } catch (e) { rec('rollback runs and the file re-applies', false, e.message); }

  await c2.end(); await db.end();
  try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {}
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
