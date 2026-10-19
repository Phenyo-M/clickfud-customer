// Database test for supabase/tut_campuses.sql (campuses, venue directory,
// shop campuses, pickup points, student campus). Local copy, synthetic people.
//   NODE_PATH=backend/tests/lt/node_modules node backend/tests/tut-campuses-test.cjs
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');
const PORT = 55681, DIR = path.join(LT, 'cftutcampus');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 240)})` : '')]);

(async () => {
  const db = await build(PORT, DIR); const q = (s, p) => db.query(s, p); const one = async (s, p) => (await q(s, p)).rows[0];
  const admin = async () => { await q('reset role'); await q(`select set_config('request.jwt.claims', '', false)`); };
  const as = async (id) => { await q('reset role'); await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await q('set role authenticated'); };
  const asAnon = async () => { await q('reset role'); await q(`select set_config('request.jwt.claims', '{"role":"anon"}', false)`); await q('set role anon'); };
  const tryq = async (s, p) => { try { return { rows: (await q(s, p)).rows }; } catch (e) { return { err: e.message }; } };
  await admin();
  await q(`create table if not exists cron.job (jobid bigint primary key, jobname text, schedule text);
           create table if not exists cron.job_run_details (jobid bigint, status text, start_time timestamptz, end_time timestamptz, return_message text);
           create table if not exists net._http_response (id bigint generated always as identity, status_code int, error_msg text, timed_out boolean default false, created timestamptz default now());`);
  for (const f of ['student_sellers.sql', 'seller_review_address.sql', 'student_application_details.sql', 'student_number_from_email.sql', 'allowed_domains.sql',
                   'approval_emails.sql', 'notification_links.sql', 'student_collection_times.sql', 'student_order_codes.sql', 'notification_queue.sql', 'shop_test_mode.sql',
                   'ops_monitoring.sql', 'show_partner_shops.sql', 'payment_options.sql', 'multi_university.sql']) await q(SQL(f));
  await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
  const id = () => crypto.randomUUID();
  const U = { tut: id(), tut2: id(), up: id(), mgr: id(), dev: id() };
  const addUser = async (uid, email, role) => {
    await q(`set session_replication_role = replica`);
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [uid, email]);
    await q(`insert into profiles (id, name, email, role, status, active) values ($1, $2, $2, $3, 'approved', true)`, [uid, email, role]);
    await q(`set session_replication_role = origin`);
  };
  for (const [k, e, r] of [['tut', '222222222@tut4life.ac.za', 'customer'], ['tut2', '333333333@tut4life.ac.za', 'customer'], ['up', 'u11111111@tuks.co.za', 'customer'], ['mgr', 'mgr@shop.test', 'manager'], ['dev', 'dev@clickfood.test', 'developer']]) await addUser(U[k], e, r);
  // a shop that exists before the migration, at TUT Soshanguve North
  // a student who already has a campus BEFORE the migration (backfill)
  await q(`set session_replication_role = replica`); await q(`update profiles set university = 'Tshwane University of Technology', campus_location = 'Arcadia' where id = $1`, [U.tut2]); await q(`set session_replication_role = origin`);
  const shopId = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time)
     values ($1, 'North Bites', 'north-bites', 'Fast Food', 'Soshanguve North', 'Block H', 'Tshwane University of Technology', 'approved', true, '00:00', '23:59') returning id`, [U.mgr])).id;

  try { await q(SQL('tut_campuses.sql')); rec('migration applies', true); } catch (e) { rec('migration applies', false, e.message); throw e; }
  try { await q(SQL('tut_campuses.sql')); rec('migration applies a second time (no duplicates)', true); } catch (e) { rec('migration applies a second time (no duplicates)', false, e.message); }
  try { await q(SQL('multi_university.sql')); await q(SQL('tut_campuses.sql')); rec('both migrations re-run in order safely', true); } catch (e) { rec('both migrations re-run in order safely', false, e.message); }

  const tutCampuses = (await q(`select c.name, c.code from campuses c join universities u on u.id = c.university_id where u.name = 'Tshwane University of Technology' order by c.sort`)).rows;
  rec('TUT has exactly the six Pretoria/Tshwane campuses', tutCampuses.map(c => c.name).join('|') === 'Pretoria|Arcadia|Arts|Ga-Rankuwa|Soshanguve North|Soshanguve South', tutCampuses.map(c => c.name).join('|'));
  rec('no eMalahleni, Mbombela or Polokwane anywhere', (await one(`select count(*)::int n from campuses where name ~* 'emalahleni|mbombela|polokwane'`)).n === 0);
  rec('the campus list function now reads the table', (await one(`select university_campuses('Tshwane University of Technology') c`)).c.length === 6 && (await one(`select university_campuses('University of Pretoria') c`)).c.includes('Hatfield'));
  rec('Soshanguve North and South are separate records', (await one(`select count(distinct id)::int n from campuses where name in ('Soshanguve North', 'Soshanguve South')`)).n === 2);
  const venues = (await q(`select v.code, v.name, v.verification, v.building_number, c.name campus from campus_venues v join campuses c on c.id = v.campus_id order by c.sort, v.code`)).rows;
  rec('every venue belongs to a TUT campus and has a source', venues.length >= 12 && (await one(`select count(*)::int n from campus_venues where source_url is null`)).n === 0, venues.length + ' venues');
  rec('venues are on the right campus (Building 16 iCentres at Soshanguve North, library Building 6 at South)',
    venues.find(v => v.code === 'tut-sosh-north-icentre-16').campus === 'Soshanguve North' && venues.find(v => v.code === 'tut-sosh-south-library').campus === 'Soshanguve South' && venues.find(v => v.code === 'tut-sosh-south-library').building_number === '6');
  rec('no venue has invented coordinates', (await one(`select count(*)::int n from campus_venues where latitude is not null or longitude is not null`)).n === 0);
  rec('no food outlets were added (none could be verified)', (await one(`select count(*)::int n from campus_venues where is_food_service or category in ('cafeteria','food_court','restaurant')`)).n === 0);
  const dup = await tryq(`insert into campus_venues (campus_id, code, name, category, building_number, source_url) select campus_id, 'dup-test', 'iCentre B44 again', 'computer_centre', '44', 'x' from campus_venues where code = 'tut-pretoria-icentre-44'`);
  rec('the same building can\'t be added twice under another name', !!dup.err);
  rec('no pickup point is active', (await one(`select count(*)::int n from pickup_points where active`)).n === 0);
  rec('a student who already had a campus is linked by the migration', (await one(`select c.name from profiles p join campuses c on c.id = p.campus_id where p.id = $1`, [U.tut2])||{}).name === 'Arcadia');
  rec('an existing shop is linked to its own campus only', (await q(`select c.name from store_campuses sc join campuses c on c.id = sc.campus_id where sc.store_id = $1`, [shopId])).rows.map(r => r.name).join() === 'Soshanguve North');

  // students: campus from what they pick, at their email's university
  await q(`update profiles set university = 'Tshwane University of Technology', campus_location = 'Soshanguve North' where id = $1`, [U.tut]);
  rec('a TUT student picking Soshanguve North gets that campus', (await one(`select c.name from profiles p join campuses c on c.id = p.campus_id where p.id = $1`, [U.tut])).name === 'Soshanguve North');
  for (const name of ['Pretoria', 'Arcadia', 'Arts', 'Ga-Rankuwa', 'Soshanguve South']) {
    await q(`update profiles set university = 'Tshwane University of Technology', campus_location = $2 where id = $1`, [U.tut2, name]);
    if ((await one(`select c.name from profiles p join campuses c on c.id = p.campus_id where p.id = $1`, [U.tut2])).name !== name) rec('campus ' + name, false);
  }
  rec('each of the other five TUT campuses can be chosen', !results.some(r => r[1].startsWith('campus ')));
  await q(`update profiles set university = 'University of Pretoria', campus_location = 'Hatfield' where id = $1`, [U.up]);
  rec('a UP student still gets their UP campus', (await one(`select c.name from profiles p join campuses c on c.id = p.campus_id where p.id = $1`, [U.up])).name === 'Hatfield');
  await q(`update profiles set campus_location = 'Mbombela' where id = $1`, [U.tut2]);
  rec('an out-of-scope campus name never links (no lock-out either)', (await one(`select campus_id c from profiles where id = $1`, [U.tut2])).c === null);
  await q(`update profiles set campus_location = 'Pretoria' where id = $1`, [U.tut2]);

  // preferred building
  const lib = (await one(`select id from campus_venues where code = 'tut-sosh-north-library'`)).id;
  const southLib = (await one(`select id from campus_venues where code = 'tut-sosh-south-library'`)).id;
  const adm = (await one(`select id from campus_venues where code = 'tut-pretoria-admissions-21'`)).id;
  await as(U.tut);
  rec('a student may pick a building on their campus (optional)', !(await tryq(`update profiles set preferred_venue_id = $1 where id = auth.uid()`, [lib])).err);
  rec('...but not a building on another campus', !!(await tryq(`update profiles set preferred_venue_id = $1 where id = auth.uid()`, [southLib])).err);
  const campusDirect = await tryq(`update profiles set campus_id = (select id from campuses where name = 'Arcadia') where id = auth.uid() returning campus_id`);
  await admin();
  rec('campus_id can\'t be set around the campus choice', (await one(`select c.name from profiles p join campuses c on c.id = p.campus_id where p.id = $1`, [U.tut])).name === 'Soshanguve North', JSON.stringify(campusDirect));
  await q(`update profiles set campus_location = 'Soshanguve South' where id = $1`, [U.tut]);
  rec('changing campus clears a building from the old campus', (await one(`select preferred_venue_id v from profiles where id = $1`, [U.tut])).v === null);
  await as(U.tut2);
  rec('an unverified research record can\'t be picked', !!(await tryq(`update profiles set preferred_venue_id = $1 where id = auth.uid()`, [adm])).err);
  const other = await tryq(`update profiles set campus_location = 'Arts' where id = $1 returning id`, [U.tut]);
  await admin();
  rec('a student cannot change another student\'s campus', !other.err && other.rows.length === 0);

  // reading
  await asAnon();
  const pubVenues = (await q(`select code, verification from campus_venues`)).rows;
  await admin();
  rec('the public directory shows only current verified venues', pubVenues.length > 0 && pubVenues.every(v => v.verification === 'verified_current') && !pubVenues.some(v => v.code === 'tut-pretoria-admissions-21'));

  // who can change what
  const blocked = [];
  for (const [who, uid] of [['student', U.tut], ['manager', U.mgr], ['guest', null]]) {
    if (uid) await as(uid); else await asAnon();
    if (!(await tryq(`insert into campus_venues (campus_id, code, name, category, verification) select id, 'x-${who}', 'Fake Cafe', 'cafeteria', 'verified_current' from campuses limit 1`)).err) blocked.push(who + ' inserts a venue');
    if (!(await tryq(`update campus_venues set verification = 'verified_current' where code = 'tut-pretoria-admissions-21' returning id`)).err) { const r2 = await tryq(`select 1 from campus_venues where code = 'tut-pretoria-admissions-21' and verification = 'verified_current'`); if (r2.rows && r2.rows.length) blocked.push(who + ' verifies a venue'); }
    const v1 = await tryq(`select dev_save_venue(null, '{"name":"Fake","campus_id":"00000000-0000-0000-0000-000000000000"}'::jsonb) r`);
    if (v1.rows && v1.rows[0].r.ok) blocked.push(who + ' dev_save_venue');
    if (!(await tryq(`insert into pickup_points (store_id, campus_id, name, active) select $1, campus_id, 'Fake point', true from store_campuses where store_id = $1 limit 1`, [shopId])).err) blocked.push(who + ' adds a pickup point');
    const pp = await tryq(`select dev_save_pickup_point(null, '{}'::jsonb) r`); if (pp.rows && pp.rows[0].r.ok) blocked.push(who + ' dev_save_pickup_point');
    const sc = await tryq(`select set_store_campuses($1, '{}'::uuid[], null) r`, [shopId]); if (sc.rows && sc.rows[0].r.ok) blocked.push(who + ' changes shop campuses');
    if (!(await tryq(`insert into store_campuses (store_id, campus_id) select $1, id from campuses where name = 'Arts'`, [shopId])).err) blocked.push(who + ' links a shop to a campus');
    if (who === 'manager') { await tryq(`update stores set venue_id = $2 where id = $1`, [shopId, lib]); }
    if (!(await tryq(`update stores set status = 'approved', is_published = true where id = $1 and status <> 'approved' returning id`, [shopId])).err) { /* status gate is checked elsewhere */ }
    await admin();
  }
  rec('students, managers and guests can\'t add/verify venues, add pickup points or relink shops', !blocked.length, blocked.join('; '));
  rec('a manager can\'t move their shop into a building', (await one(`select venue_id v from stores where id = $1`, [shopId])).v === null);

  // developer
  await as(U.dev);
  const nv = (await one(`select dev_save_venue(null, jsonb_build_object('name', 'Test Building 99', 'campus_id', (select id from campuses where code = 'tut-arcadia'), 'category', 'academic_building', 'building_number', '99', 'verification', 'unverified', 'source_url', 'https://example.org')) r`)).r;
  const north = (await one(`select id from campuses where code = 'tut-soshanguve-north'`)).id;
  const scok = (await one(`select set_store_campuses($1, array[$2]::uuid[], $3) r`, [shopId, north, lib])).r;
  const scbad = (await one(`select set_store_campuses($1, array[$2]::uuid[], $3) r`, [shopId, north, southLib])).r;
  const ppNew = (await one(`select dev_save_pickup_point(null, jsonb_build_object('store_id', $1::text, 'campus_id', $2::text, 'venue_id', $3::text, 'name', 'Library entrance', 'active', false)) r`, [shopId, north, lib])).r;
  const ppWrong = (await one(`select dev_save_pickup_point(null, jsonb_build_object('store_id', $1::text, 'campus_id', (select id from campuses where code = 'tut-arts')::text, 'name', 'Arts gate', 'active', true)) r`, [shopId])).r;
  await admin();
  rec('a developer adds a venue (unverified until checked)', nv.ok === true && (await one(`select verification v from campus_venues where id = $1`, [nv.id])).v === 'unverified');
  rec('a developer links a shop to a campus and building; a building on another campus is refused', scok.ok === true && scbad.ok === false, JSON.stringify([scok, scbad]));
  rec('a new pickup point starts switched off; one on a campus the shop doesn\'t serve is refused', ppNew.ok === true && (await one(`select active a from pickup_points where id = $1`, [ppNew.id])).a === false && ppWrong.ok === false, JSON.stringify(ppWrong));
  const cust = U.tut;
  const orderTry = async (ppId) => { await as(cust); const r = await tryq(`insert into orders (customer_id, store_id, status, total, payment_method, items, delivery_location) values ($1, $2, 'received', 10, 'cod', '[]', $3) returning id`, [cust, shopId, JSON.stringify({ fulfilment: 'collection', pickupPointId: ppId })]); await admin(); return r; };
  const off = await orderTry(ppNew.id);
  rec('an order can\'t use a switched-off pickup point', !!off.err && /pickup point/.test(off.err), off.err);
  await as(U.dev); await q(`select dev_save_pickup_point($1, '{"active": true}'::jsonb)`, [ppNew.id]); await admin();
  await asAnon();
  const seen = (await q(`select name from pickup_points`)).rows;
  await admin();
  rec('once switched on, everyone can see it', seen.length === 1 && seen[0].name === 'Library entrance');
  const on = await orderTry(ppNew.id);
  rec('...and an order may use it (other order rules still apply)', !on.err || !/pickup point/.test(on.err), on.err);

  // discovery returns campuses
  await q(`update platform_config set show_partner_shops = true where id = 1`);
  await as(U.tut);
  const d = (await q(`select store_id, campus_ids from discover_shops(null)`)).rows;
  await admin();
  rec('shop discovery returns each shop\'s campuses (one request)', d.length === 1 && d[0].campus_ids.length === 1 && d[0].campus_ids[0] === north);

  // rollback
  try { await q(SQL('tut_campuses_rollback.sql')); await q(SQL('multi_university.sql')); rec('rollback runs (then the multi-university step re-applies)', true); } catch (e) { rec('rollback runs', false, e.message); }
  rec('rollback keeps the campus text on profiles and shops', (await one(`select campus_location c from profiles where id = $1`, [U.tut])).c === 'Soshanguve South' && (await one(`select campus_location c from stores where id = $1`, [shopId])).c === 'Soshanguve North');
  try { await q(SQL('tut_campuses.sql')); rec('migration re-applies after rollback', true); } catch (e) { rec('migration re-applies after rollback', false, e.message); }

  await db.end();
  try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {}
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
