// Database test for supabase/promo_review.sql: a shop manager's promo code
// waits for the developer, customers can't see or use it (checkout drops it)
// until it is approved, changing a code sends it back for review, switching it
// off/on doesn't, the manager can't approve it themselves, and rejecting needs
// a reason. Existing codes stay approved. Local copy, synthetic data.
//   NODE_PATH=backend/tests/lt/node_modules node backend/tests/promo-review-test.cjs
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');
const PORT = 55881, DIR = path.join(LT, 'cfpromoreview');
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
                   'ops_monitoring.sql', 'show_partner_shops.sql', 'payment_options.sql', 'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'engagement_deals.sql', 'poll_review.sql']) await q(SQL(f));
  await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});

  const mk = async (email, role) => {
    const id = crypto.randomUUID();
    await q(`set session_replication_role = replica`);
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, email]);
    await q(`insert into profiles (id, name, email, role, status, active) values ($1, $2, $2, $3, 'approved', true)`, [id, email, role]);
    await q(`set session_replication_role = origin`);
    return id;
  };
  const mgr = await mk('mgr@shop.test', 'manager');
  const dev = await mk('dev@clickfood.test', 'developer');
  const cust = await mk('thandi@gmail.com', 'customer');
  const shop = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind)
    values ($1, 'Deal Kitchen', 'deal-kitchen', 'Fast Food', 'Hatfield', 'x', 'University of Pretoria', 'approved', true, '00:00', '23:59', 'business') returning id`, [mgr])).id;
  await q(`update profiles set store_id = $1 where id = $2`, [shop, mgr]);
  const item = (await one(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, 'Burger', 'Lunch', 50, 'x', 'A burger', 'approved', true, 500) returning id`, [shop])).id;
  // a code that exists before the review rule
  await q(`insert into promotions (code, type, value, active, store_id, menu_item_ids) values ('OLD10', 'fixed', 10, true, $1, array[$2]::uuid[])`, [shop, item]);

  try { await q(SQL('promo_review.sql')); await q(SQL('promo_review.sql')); rec('migration applies (twice)', true); } catch (e) { rec('migration applies (twice)', false, e.message); throw e; }
  rec('codes that already existed stay approved (live codes keep working)', (await one(`select review_status s from promotions where code = 'OLD10'`)).s === 'approved');

  const order = async (code) => run(cust, `insert into orders (customer_id, store_id, items, payment_method, total, promo_code, discount, delivery_location) values (auth.uid(), $1, $2, 'cod', 1, $3, 10, $4) returning promo_code, discount`,
    [shop, JSON.stringify([{ menuItemId: item, name: 'Burger', qty: 1, price: 50 }]), code, JSON.stringify({ fulfilment: 'collection', collectionTime: new Date(Date.now() + 3600000).toISOString() })]);
  let o = await order('OLD10');
  rec('control: an approved code works on a cash order', !o.err && o.rows[0].promo_code === 'OLD10' && Number(o.rows[0].discount) === 10, o.err || JSON.stringify(o.rows));

  // ---------- a manager's new code waits ----------
  let r = await run(mgr, `insert into promotions (code, type, value, active, store_id, menu_item_ids, review_status, is_public, title) values ('NEW20', 'fixed', 20, true, $1, array[$2]::uuid[], 'approved', true, 'Burger R20 off') returning id, review_status`, [shop, item]);
  const pid = r.rows && r.rows[0].id;
  rec('a manager\'s new code is saved as waiting for review (even if the app says "approved")', r.rows && r.rows[0].review_status === 'pending_review', r.err || JSON.stringify(r.rows));
  r = await run(cust, `select count(*)::int n from promotions where code = 'NEW20'`);
  rec('customers cannot see it (not in Campus Deals or the app)', r.rows && r.rows[0].n === 0, r.err);
  o = await order('NEW20');
  rec('checkout refuses it (the code is removed from the order)', !o.err && o.rows[0].promo_code === null && Number(o.rows[0].discount) === 0, o.err || JSON.stringify(o.rows));
  r = await run(cust, `select promo_block_reason('NEW20', 50) b`);
  rec('card payments are refused too (promo_block_reason)', r.rows && r.rows[0].b === 'This promo code is not valid.', JSON.stringify(r.rows));
  r = await run(mgr, `select review_status from promotions where id = $1`, [pid]);
  rec('the manager still sees their code and its status', r.rows && r.rows[0] && r.rows[0].review_status === 'pending_review');
  await run(mgr, `update promotions set review_status = 'approved' where id = $1`, [pid]);
  rec('the manager cannot approve it themselves', (await one(`select review_status s from promotions where id = $1`, [pid])).s === 'pending_review');
  r = await run(mgr, `select dev_review_promo($1, 'approve') r`, [pid]);
  rec('the manager cannot use the developer\'s review', r.rows && r.rows[0].r.ok === false);
  r = await run(cust, `select dev_review_promo($1, 'approve') r`, [pid]);
  rec('a customer cannot approve it', r.rows && r.rows[0].r.ok === false && (await one(`select review_status s from promotions where id = $1`, [pid])).s === 'pending_review');

  // ---------- the developer approves ----------
  r = await run(dev, `select code from promotions where review_status = 'pending_review'`);
  rec('the developer sees it in the review list', r.rows && r.rows.some(x => x.code === 'NEW20'));
  r = await run(dev, `select dev_review_promo($1, 'approve') r`, [pid]);
  rec('approving works', r.rows && r.rows[0].r.ok && (await one(`select review_status s, reviewed_by b from promotions where id = $1`, [pid])).b === dev);
  r = await run(cust, `select count(*)::int n from promotions where code = 'NEW20'`);
  rec('customers now see the approved code', r.rows[0].n === 1);
  o = await order('NEW20');
  rec('...and can use it at checkout', !o.err && o.rows[0].promo_code === 'NEW20', o.err || JSON.stringify(o.rows));
  rec('using it does not send it back for review', (await one(`select review_status s, used_count u from promotions where id = $1`, [pid])).s === 'approved');

  // ---------- changes ----------
  await run(mgr, `update promotions set active = false where id = $1`, [pid]);
  await run(mgr, `update promotions set active = true where id = $1`, [pid]);
  rec('switching it off and on keeps it approved', (await one(`select review_status s from promotions where id = $1`, [pid])).s === 'approved');
  await run(mgr, `update promotions set value = 45 where id = $1`, [pid]);
  rec('changing the discount sends it back for review', (await one(`select review_status s from promotions where id = $1`, [pid])).s === 'pending_review');
  o = await order('NEW20');
  rec('...and it stops working until approved again', !o.err && o.rows[0].promo_code === null, o.err || JSON.stringify(o.rows));
  await run(dev, `select dev_review_promo($1, 'approve')`, [pid]);
  await run(mgr, `update promotions set is_public = false where id = $1`, [pid]);
  rec('changing Campus Deals settings also needs review', (await one(`select review_status s from promotions where id = $1`, [pid])).s === 'pending_review');

  // ---------- rejection ----------
  r = await run(dev, `select dev_review_promo($1, 'reject', '') r`, [pid]);
  rec('rejecting needs a reason', r.rows && r.rows[0].r.ok === false && /reason/.test(r.rows[0].r.error));
  r = await run(dev, `select dev_review_promo($1, 'reject', 'R45 off a R50 burger looks like a mistake.') r`, [pid]);
  rec('rejecting with a reason works', r.rows && r.rows[0].r.ok);
  r = await run(mgr, `select review_status, review_note from promotions where id = $1`, [pid]);
  rec('the manager sees it was not approved and why', r.rows[0].review_status === 'rejected' && /mistake/.test(r.rows[0].review_note));
  r = await run(cust, `select count(*)::int n from promotions where id = $1`, [pid]);
  rec('customers never see a rejected code', r.rows[0].n === 0);
  await run(mgr, `update promotions set value = 15 where id = $1`, [pid]);
  rec('fixing a rejected code sends it for review again', (await one(`select review_status s, review_note n from promotions where id = $1`, [pid])).s === 'pending_review');

  // ---------- developer's own code ----------
  r = await run(dev, `insert into promotions (code, type, value, active, menu_item_ids) values ('CLICK5', 'fixed', 5, true, array[$1]::uuid[]) returning review_status`, [item]);
  rec('the developer still has no direct write access to codes (unchanged; reviews go through dev_review_promo)', !!r.err, r.err || '');

  try { await q(SQL('promo_review_rollback.sql')); await q(SQL('engagement_deals.sql')); await q(SQL('poll_review.sql')); await q(SQL('promo_review.sql')); rec('rollback runs and the file re-applies', true); } catch (e) { rec('rollback runs and the file re-applies', false, e.message); }
  await db.end();
  try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {}
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
