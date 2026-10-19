// Database test for supabase/multi_university.sql (universities, home
// university, shop availability, discover_shops, permissions). Local copy,
// synthetic data only.
//   NODE_PATH=backend/tests/lt/node_modules node backend/tests/multi-university-test.cjs
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');
const PORT = 55661, DIR = path.join(LT, 'cfmultiuni');
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
                   'ops_monitoring.sql', 'show_partner_shops.sql', 'payment_options.sql']) await q(SQL(f));
  await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
  await q(`update allowed_domains set active = true`);
  // a shop + people that exist BEFORE the migration (backfill)
  const id = () => crypto.randomUUID();
  const U = { up: id(), tut: id(), up2: id(), mgr: id(), mgr2: id(), dev: id(), kit: id() };
  const addUser = async (uid, email, role, uni) => {
    await q(`set session_replication_role = replica`);
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [uid, email]);
    await q(`insert into profiles (id, name, email, role, status, active, university) values ($1, $2, $2, $3, 'approved', true, $4)`, [uid, email, role, uni]);
    await q(`set session_replication_role = origin`);
  };
  await addUser(U.up, 'u11111111@tuks.co.za', 'customer', 'University of Pretoria');
  await addUser(U.mgr, 'mgr@shop.test', 'manager', null);
  const shop = async (name, uni, kind, extra) => (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, rating_count)
     values ($1, $2, $3, 'Fast Food', 'Main', 'Somewhere', $4, $5, $6, '00:00', '23:59', $7, $8) returning id`,
     [extra && extra.mgr || U.mgr, name, name.toLowerCase().replace(/\W+/g, '-'), uni, extra && extra.status || 'approved', extra && extra.pub === false ? false : true, kind || 'business', extra && extra.rc || 0])).id;
  const S = {};
  S.upKota = await shop('UP Kota', 'University of Pretoria', 'business', { rc: 5 });

  try { await q(SQL('multi_university.sql')); rec('migration applies', true); } catch (e) { rec('migration applies', false, e.message); throw e; }
  try { await q(SQL('multi_university.sql')); rec('migration applies a second time', true); } catch (e) { rec('migration applies a second time', false, e.message); }

  const uni = async (n) => (await one(`select id, short_code from universities where name = $1`, [n]));
  const UP = await uni('University of Pretoria'), TUT = await uni('Tshwane University of Technology');
  rec('universities created from the Supported Institutions list with short codes', UP && UP.short_code === 'UP' && TUT && TUT.short_code === 'TUT' && (await uni('University of South Africa')).short_code === 'UNISA');
  rec('existing student got UP as home university (backfill)', (await one(`select home_university_id h from profiles where id = $1`, [U.up])).h === UP.id);
  rec('existing shop is linked to its university (backfill)', !!(await one(`select 1 x from store_universities where store_id = $1 and university_id = $2`, [S.upKota, UP.id])));
  await q(`insert into allowed_domains (institution_name, domain, active) values ('Sefako Makgatho University', 'swave.smu.ac.za', true)`);
  rec('adding an institution adds the university (no code change)', !!(await uni('Sefako Makgatho University')));

  // new students: home university from the email at sign-up
  await addUser(U.tut, 'u222222222@tut4life.ac.za', 'customer', null);
  await q(`update profiles set university = 'Tshwane University of Technology' where id = $1`, [U.tut]);
  rec('a TUT student gets TUT as home university', (await one(`select home_university_id h from profiles where id = $1`, [U.tut])).h === TUT.id);
  await addUser(U.up2, 'u33333333@tuks.co.za', 'customer', null);
  await q(`update profiles set university = 'University of Pretoria' where id = $1`, [U.up2]);   // as the sign-up does, with triggers on
  rec('a UP student gets UP as home university', (await one(`select home_university_id h from profiles where id = $1`, [U.up2])).h === UP.id);

  // shops
  S.tutGrill = await shop('TUT Grill', 'Tshwane University of Technology', 'business', { rc: 9 });
  S.cityPizza = await shop('City Pizza', 'University of Pretoria', 'business', { rc: 3 });
  S.both = await shop('Both Campus Coffee', 'University of Pretoria', 'business', { rc: 1 });
  S.hidden = await shop('Unpublished Place', 'University of Pretoria', 'business', { pub: false });
  S.pending = await shop('Pending Place', 'Tshwane University of Technology', 'business', { status: 'pending' });
  rec('a new shop is linked to its university automatically', !!(await one(`select 1 x from store_universities where store_id = $1 and university_id = $2`, [S.tutGrill, TUT.id])));
  await addUser(U.dev, 'dev@clickfood.test', 'developer', null);
  await as(U.dev);
  rec('developer: City Pizza available to everyone', (await one(`select set_store_universities($1, 'everyone', $2::uuid[]) r`, [S.cityPizza, []])).r.ok === true);
  rec('developer: a shop can serve two universities', (await one(`select set_store_universities($1, 'university', $2::uuid[]) r`, [S.both, [UP.id, TUT.id]])).r.ok === true);
  const noUni = (await one(`select set_store_universities($1, 'university', $2::uuid[]) r`, [S.both, []])).r;
  rec('a university shop needs at least one university', noUni.ok === false);
  await admin();
  await q(`update platform_config set show_partner_shops = true where id = 1`);

  const disc = async (who, p) => { if (who === 'anon') await asAnon(); else await as(who); const r = (await q(`select d.*, s.name from discover_shops($1) d join stores s on s.id = d.store_id order by rank`, [p || null])).rows; await admin(); return r; };
  let r = await disc(U.up);
  const names = (rows) => rows.map(x => `${x.name}:${x.section}`).join(', ');
  rec('UP student: UP shops first, then everyone, then other universities', names(r) === 'UP Kota:mine, Both Campus Coffee:mine, City Pizza:everyone, TUT Grill:other', names(r));
  r = await disc(U.tut);
  rec('TUT student: TUT shops first (incl. the shared shop), then everyone, then UP', names(r) === 'TUT Grill:mine, Both Campus Coffee:mine, City Pizza:everyone, UP Kota:other', names(r));
  rec('unpublished and pending shops are never listed', !r.some(x => /Unpublished|Pending/.test(x.name)));
  rec('a shop serving two universities appears once, with both names', r.filter(x => x.name === 'Both Campus Coffee').length === 1 && r.find(x => x.name === 'Both Campus Coffee').universities.length === 2);
  r = await disc(U.up, TUT.id);
  rec('browsing TUT for now (temporary) does not change the home university', names(r).startsWith('TUT Grill:mine') && (await one(`select home_university_id h from profiles where id = $1`, [U.up])).h === UP.id, names(r));
  r = await disc('anon');
  rec('guests see shops too (everyone first, then the rest)', r.length === 4 && r[0].name === 'City Pizza', names(r));
  await q(`update platform_config set show_partner_shops = false where id = 1`);
  r = await disc(U.up);
  rec('business shops follow the developer\'s show/hide switch', r.length === 0, names(r));
  await q(`update platform_config set show_partner_shops = true where id = 1`);

  // changing the home university
  await as(U.tut);
  const ch = (await one(`select set_my_home_university($1) r`, [UP.id])).r;
  await admin();
  rec('a TUT student changes their home university to UP', ch.ok === true && (await one(`select home_university_id h, university u from profiles where id = $1`, [U.tut])).h === UP.id);
  rec('...the email-based institution is unchanged (still TUT)', (await one(`select university u from profiles where id = $1`, [U.tut])).u === 'Tshwane University of Technology');
  rec('...and their shops now start with UP', (await disc(U.tut))[0].name === 'UP Kota');
  await q(`update universities set active = false where name = 'University of South Africa'`);
  const unisa = await uni('University of South Africa');
  await as(U.tut);
  const bad = (await one(`select set_my_home_university($1) r`, [unisa.id])).r;
  const bad2 = (await one(`select set_my_home_university($1) r`, [crypto.randomUUID()])).r;
  const direct = await tryq(`update profiles set home_university_id = $1 where id = $2`, [unisa.id, U.tut]);
  await admin();
  rec('an inactive or made-up university is refused (function and direct update)', bad.ok === false && bad2.ok === false && !!direct.err, JSON.stringify([bad, bad2, direct.err]));
  await as(U.up);
  const other = await tryq(`update profiles set home_university_id = $1 where id = $2 returning id`, [TUT.id, U.tut]);
  await admin();
  rec('a student cannot change another student\'s home university', !other.err && other.rows.length === 0 && (await one(`select home_university_id h from profiles where id = $1`, [U.tut])).h === UP.id);
  await as(U.up);
  await tryq(`select set_my_home_university($1)`, [TUT.id]);
  const role = (await one(`select role from profiles where id = auth.uid()`)).role;
  await admin();
  rec('changing university never changes the role', role === 'customer');

  // shop availability + links: only the developer
  await addUser(U.mgr2, 'mgr2@shop.test', 'manager', null);
  await as(U.mgr);
  await tryq(`update stores set availability = 'everyone' where id = $1`, [S.upKota]);
  const mset = (await one(`select set_store_universities($1, 'everyone', $2::uuid[]) r`, [S.upKota, []])).r;
  const mins = await tryq(`insert into store_universities (store_id, university_id) values ($1, $2)`, [S.upKota, TUT.id]);
  const mdel = await tryq(`delete from store_universities where store_id = $1 returning store_id`, [S.upKota]);
  await admin();
  rec('a shop manager cannot make their shop "everyone" or change its universities', (await one(`select availability a from stores where id = $1`, [S.upKota])).a === 'university' && mset.ok === false && !!mins.err && (!!mdel.err || mdel.rows.length === 0));
  for (const who of [U.up, 'anon']) {
    if (who === 'anon') await asAnon(); else await as(who);
    const w1 = await tryq(`insert into universities (name, short_code) values ('Fake U', 'FAKE')`);
    const w2 = await tryq(`update universities set active = false returning id`);
    const w3 = await tryq(`select set_store_universities($1, 'everyone', $2::uuid[]) r`, [S.upKota, []]);
    await admin();
    rec(`${who === 'anon' ? 'a guest' : 'a student'} cannot change universities or shop links`, !!w1.err && (!!w2.err || w2.rows.length === 0) && (!!w3.err || w3.rows[0].r.ok === false));
  }
  await asAnon();
  const pub = await tryq(`select count(*)::int n from store_universities`);
  const hiddenLink = await tryq(`select count(*)::int n from store_universities where store_id = $1`, [S.hidden]);
  await admin();
  rec('guests read shop links only for visible shops', pub.rows && hiddenLink.rows[0].n === 0);

  // rollback
  try { await q(SQL('multi_university_rollback.sql')); rec('rollback runs', true); } catch (e) { rec('rollback runs', false, e.message); }
  rec('rollback keeps the existing university names', (await one(`select university u from profiles where id = $1`, [U.up])).u === 'University of Pretoria' && (await one(`select university u from stores where id = $1`, [S.upKota])).u === 'University of Pretoria');
  try { await q(SQL('multi_university.sql')); rec('migration re-applies after rollback', true); } catch (e) { rec('migration re-applies after rollback', false, e.message); }

  await db.end();
  try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {}
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
