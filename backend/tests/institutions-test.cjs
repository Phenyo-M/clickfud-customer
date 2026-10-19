// Database test for supabase/institutions_v2.sql: campuses of all five
// institutions, institution-aware shop visibility (RLS, menus, discovery,
// orders, groups, seller contact), the account type / institution lock,
// Student Entrepreneurs for every institution, campus buildings per
// institution, and developer institution management. Local copy only.
//   NODE_PATH=backend/tests/lt/node_modules node backend/tests/institutions-test.cjs
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');
const PORT = 55811, DIR = path.join(LT, 'cfinst');
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
                   'ops_monitoring.sql', 'show_partner_shops.sql', 'payment_options.sql', 'customer_tools.sql', 'group_payments.sql', 'account_deletion.sql', 'account_deletion_reasons.sql',
                   'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'shop_locations.sql', 'privacy_legal.sql', 'student_entrepreneurs.sql', 'order_distance.sql']) await q(SQL(f));
  await q(`update allowed_domains set active = true`);
  await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
  await q(`update platform_config set order_distance_rule = false where id = 1`);   // distance is tested elsewhere
  try { await q(SQL('institutions_v2.sql')); await q(SQL('institutions_v2.sql')); rec('migration applies (twice)', true); } catch (e) { rec('migration applies (twice)', false, e.message); throw e; }

  const U = {}; for (const r of (await q(`select id, short_code from universities`)).rows) U[r.short_code] = r.id;
  const camp = async (code) => (await one(`select id from campuses where code = $1`, [code])).id;
  // ---------------- campuses ----------------
  const counts = Object.fromEntries((await q(`select u.short_code k, count(c.*)::int n, count(c.*) filter (where c.source_url is null and c.code not like 'up-%')::int nosrc from universities u left join campuses c on c.university_id = u.id group by 1`)).rows.map(r => [r.k, r]));
  rec('every institution has its own campuses (UP 7, TUT 6, Rosebank 8, Eduvos 12, UNISA 3)', counts.UP.n === 7 && counts.TUT.n === 6 && counts.RC.n === 8 && counts.EDUVOS.n === 12 && counts.UNISA.n === 3, JSON.stringify(counts));
  rec('the new campuses all carry their official source', counts.RC.nosrc === 0 && counts.EDUVOS.nosrc === 0 && counts.UNISA.nosrc === 0);
  rec('no coordinates were invented for the new campuses', (await one(`select count(*)::int n from campuses where code ~ '^(rc|edu|unisa)-' and latitude is not null`)).n === 0);

  // ---------------- people ----------------
  const mk = async (email, role) => {
    const id = crypto.randomUUID();
    await q(`set session_replication_role = replica`);
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, email]);
    await q(`insert into profiles (id, name, email, role, status, active) values ($1, $2, $2, $3, 'approved', true)`, [id, email, role || 'customer']);
    await q(`set session_replication_role = origin`);
    return id;
  };
  const student = async (email, uni, campusCode) => {
    const id = await mk(email);
    await as(id); const r = (await one(`select set_my_student_status(true, $1, $2) r`, [U[uni], campusCode ? await camp(campusCode) : null])).r; await admin();
    if (!r.ok) throw new Error('student setup ' + email + ' ' + r.error);
    return id;
  };
  const up = await student('up@gmail.com', 'UP', 'up-hatfield');
  const tut = await student('tut@gmail.com', 'TUT', 'tut-arcadia');
  const rc = await student('rc@gmail.com', 'RC', 'rc-braamfontein');
  const edu = await student('edu@gmail.com', 'EDUVOS', 'edu-pretoria');
  const unisa = await student('unisa@gmail.com', 'UNISA', 'unisa-muckleneuk');
  const non = await mk('non@gmail.com'); await as(non); await one(`select set_my_student_status(false) r`); await admin();
  const dev = await mk('dev@clickfood.test', 'developer');
  const mgrUp = await mk('mgrup@shop.test', 'manager'), mgrTut = await mk('mgrtut@shop.test', 'manager'), mgrGen = await mk('mgrgen@shop.test', 'manager'), mgrX = await mk('mgrx@shop.test', 'manager');
  const shop = async (mgr, name, uni, loc, avail) => {
    const id = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, location_type, availability, pickup_lat, pickup_lng)
      values ($1, $2, $3, 'Fast Food', 'Somewhere', 'Somewhere', $4, 'approved', true, '00:00', '23:59', 'business', $5, $6, -25.75, 28.23) returning id`, [mgr, name, name.toLowerCase().replace(/\W+/g, '-'), uni, loc, avail || 'university'])).id;
    await q(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, $2, 'Lunch', 40, 'x', 'Food', 'approved', true, 50)`, [id, name + ' Burger']);
    return id;
  };
  const S = {
    up: await shop(mgrUp, 'UP Kota', 'University of Pretoria', 'campus'),
    tut: await shop(mgrTut, 'TUT Grill', 'Tshwane University of Technology', 'campus'),
    gen: await shop(mgrGen, 'Town Pizza', null, 'off_campus'),
    every: await shop(mgrX, 'Open Coffee', 'University of Pretoria', 'campus', 'everyone'),
  };
  const mgrU = await mk('mgru@shop.test', 'manager');
  S.unclassified = await shop(mgrU, 'Mystery Stall', null, 'campus');
  await q(`update profiles set store_id = $1 where id = $2`, [S.up, mgrUp]);
  const kitchen = await mk('kitchen@shop.test', 'kitchen'); await q(`update profiles set store_id = $1 where id = $2`, [S.up, kitchen]);

  // ---------------- shop visibility ----------------
  const seen = async (id) => { await as(id); const r = (await q(`select name from stores where id = any($1::uuid[])`, [Object.values(S)])).rows.map(x => x.name).sort(); await admin(); return r; };
  rec('TUT student: TUT shop + general shops; not the UP shop or the unclassified one', JSON.stringify(await seen(tut)) === JSON.stringify(['Open Coffee', 'TUT Grill', 'Town Pizza']), JSON.stringify(await seen(tut)));
  rec('UP student: UP shop + general shops; not the TUT shop', JSON.stringify(await seen(up)) === JSON.stringify(['Open Coffee', 'Town Pizza', 'UP Kota']), JSON.stringify(await seen(up)));
  for (const [k, id] of [['Rosebank College', rc], ['Eduvos', edu], ['UNISA', unisa]]) rec(`${k} student: only general shops (no UP/TUT campus shops)`, JSON.stringify(await seen(id)) === JSON.stringify(['Open Coffee', 'Town Pizza']), JSON.stringify(await seen(id)));
  rec('non-student: general shops only', JSON.stringify(await seen(non)) === JSON.stringify(['Open Coffee', 'Town Pizza']), JSON.stringify(await seen(non)));
  rec('logged-out visitor: general shops only', JSON.stringify(await seen(null)) === JSON.stringify(['Open Coffee', 'Town Pizza']), JSON.stringify(await seen(null)));
  rec('the developer sees everything', (await seen(dev)).length === 5);
  rec('the shop\'s own manager and kitchen staff still see it', (await seen(mgrUp)).includes('UP Kota') && (await seen(kitchen)).includes('UP Kota'));
  await as(tut);
  const direct = await tryq(`select id from stores where id = $1`, [S.up]);
  const menu = await tryq(`select count(*)::int n from menu_items where store_id = $1`, [S.up]);
  const search = await tryq(`select name from stores where name ilike '%kota%'`);
  const disc = await tryq(`select store_id from discover_shops(null)`);
  await admin();
  rec('a TUT student asking for the UP shop by id gets nothing', !direct.err && direct.rows.length === 0);
  rec('...nor its menu', menu.rows && menu.rows[0].n === 0);
  rec('...nor finds it by searching', search.rows && search.rows.length === 0);
  rec('...nor in discovery', disc.rows && !disc.rows.some(r => r.store_id === S.up));
  const order = async (u, store) => { await as(u); const it = (await one(`select id, name from menu_items where store_id = $1`, [store]).catch(() => null)) || {}; const r = await tryq(`insert into orders (customer_id, store_id, items, payment_method, total, delivery_location) values (auth.uid(), $1, $3, 'cod', 40, $2) returning id`, [store, JSON.stringify({ fulfilment: 'collection', collectionTime: new Date(Date.now() + 3600000).toISOString() }), JSON.stringify([{ menuItemId: it.id, name: 'Burger', qty: 1, price: 40 }])]); await admin(); return r; };
  let o = await order(tut, S.up);
  rec('a TUT student cannot order from the UP campus shop (direct request)', !!o.err && /isn't available to your account/.test(o.err), o.err);
  await as(tut); const g = await tryq(`select create_group_order($1, 'Lunch', 'leader')`, [S.up]); await admin();
  rec('...nor start a group order there', !!g.err, g.err);
  rec('the dev list shows the unclassified campus shop to fix', await (async () => { await as(dev); const r = (await q(`select name from dev_unclassified_shops()`)).rows.map(x => x.name); await admin(); return r.includes('Mystery Stall'); })());
  // history: a customer who ordered before keeps seeing the shop
  await q(`set session_replication_role = replica`); await q(`insert into orders (customer_id, store_id, items, payment_method, total, delivery_location) values ($1, $2, '[{"name":"Burger","qty":1,"price":40}]', 'cod', 40, '{"fulfilment":"collection"}')`, [non, S.up]); await q(`set session_replication_role = origin`);
  rec('a customer with an earlier order at a campus shop still sees it (order history keeps working)', (await seen(non)).includes('UP Kota'));
  // student seller audience
  const seller = await student('u55555555@tuks.co.za', 'UP', 'up-hatfield');
  await q(`insert into entrepreneur_applications (user_id, status, business_name) values ($1, 'approved', 'Seller Bakes')`, [seller]);
  const sshop = (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, location_type, pickup_lat, pickup_lng)
    values ($1, 'Seller Bakes', 'seller-bakes', 'Student Food', 'Hatfield', 'Res', 'University of Pretoria', 'approved', true, '00:00', '23:59', 'student', 'campus', -25.75, 28.23) returning id`, [seller])).id;
  const sseen = async (u) => { await as(u); const r = (await q(`select 1 from stores where id = $1`, [sshop])).rows.length; await admin(); return r; };
  rec('a student entrepreneur shop at UP is, by default, for UP students only', await sseen(up) === 1 && await sseen(tut) === 0);
  await as(tut); const aud0 = (await one(`select set_my_shop_audience('everyone') r`)).r; await admin();
  await as(seller); const aud = (await one(`select set_my_shop_audience('everyone') r`)).r; await admin();
  rec('only the owner can open it to everyone, then students of every institution see it', aud0.ok === false && aud.ok && await sseen(tut) === 1 && await sseen(rc) === 1);

  // ---------------- account type / institution lock ----------------
  await as(tut);
  const d1 = await tryq(`update profiles set home_university_id = $1 where id = auth.uid()`, [U.UP]);
  const d2 = await tryq(`update profiles set is_student = false where id = auth.uid()`);
  const d3 = await tryq(`update profiles set university = 'University of Pretoria' where id = auth.uid()`);
  const d4 = await tryq(`update profiles set name = 'TUT Student' where id = auth.uid() returning name`);
  await admin();
  rec('a student cannot change their institution or account type with a direct update', !!d1.err && !!d2.err && !!d3.err, [d1.err, d2.err, d3.err].join(' | '));
  rec('...other profile fields still save', !d4.err && d4.rows[0].name === 'TUT Student');
  await q(`insert into student_verifications (user_id, email, university_id, status, verified_at) values ($1, '219999999@tut4life.ac.za', $2, 'verified', now())`, [tut, U.TUT]);
  await as(tut);
  const v1 = (await one(`select set_my_student_status(true, $1, $2) r`, [U.UP, await camp('up-hatfield')])).r;
  const v2 = (await one(`select set_my_student_status(false) r`)).r;
  const v3 = (await one(`select set_my_student_status(true, $1, $2) r`, [U.TUT, await camp('tut-pretoria')])).r;
  await admin();
  rec('a verified TUT student cannot switch to UP or to a non-student account', v1.ok === false && /belongs to Tshwane/.test(v1.error) && v2.ok === false, JSON.stringify([v1, v2]));
  rec('...but can change campus within TUT', v3.ok === true);

  // ---------------- Student Entrepreneurs: all five ----------------
  const elig = async (u) => (await one(`select public.entrepreneur_email($1) e`, [u])).e;
  const verify = async (u, email, uni) => q(`insert into student_verifications (user_id, email, university_id, status, verified_at) values ($1, $2, $3, 'verified', now()) on conflict do nothing`, [u, email, U[uni]]);
  await verify(rc, 'thandi@rcconnect.edu.za', 'RC'); await verify(edu, 'sipho@vossie.net', 'EDUVOS'); await verify(unisa, '12345678@mylife.unisa.ac.za', 'UNISA'); await verify(up, 'u66666666@tuks.co.za', 'UP');
  const all5 = [await elig(up), await elig(tut), await elig(rc), await elig(edu), await elig(unisa)];
  rec('verified students of all five institutions can apply to Student Entrepreneurs', all5.every(Boolean), JSON.stringify(all5));
  await as(dev); await one(`select dev_save_institution($1, '{"name":"Eduvos","short_code":"EDUVOS","features":{"entrepreneurs":false}}') r`, [U.EDUVOS]); await admin();
  rec('switching the feature off for one institution stops new applications from it', await elig(edu) === null);
  await as(dev); await one(`select dev_save_institution($1, '{"name":"Eduvos","short_code":"EDUVOS","features":{"entrepreneurs":true}}') r`, [U.EDUVOS]); await admin();
  rec('the domain must match exactly (a look-alike domain is not accepted)', await (async () => { const x = await mk('x@gmail.com'); await as(x); await one(`select set_my_student_status(true, $1, $2) r`, [U.UNISA, await camp('unisa-sunnyside')]); await admin(); await q(`insert into student_verifications (user_id, email, university_id, status, verified_at) values ($1, 'a@mylife.unisa.ac.za.evil.com', $2, 'verified', now())`, [x, U.UNISA]); return await elig(x) === null; })());
  await as(non); const ne = await tryq(`select save_entrepreneur_application('{"full_name":"Non"}'::jsonb, false) r`); await admin();
  rec('a non-student cannot start a Student Entrepreneur application', !!ne.err && /student accounts/.test(ne.err), ne.err || JSON.stringify(ne.rows));

  // ---------------- campus buildings ----------------
  const venues = async (u) => { await as(u); const r = await tryq(`select count(*)::int n from campus_venues`); await admin(); return r.err ? 'err' : r.rows[0].n; };
  const tutV = await venues(tut), upV = await venues(up), nonV = await venues(non), anonV = await venues(null);
  rec('TUT buildings: TUT students see them; UP students, non-students and visitors do not', tutV > 0 && upV === 0 && nonV === 0 && (anonV === 0 || anonV === 'err'), JSON.stringify([tutV, upV, nonV, anonV]));

  // ---------------- developer: new institution ----------------
  await as(up); const c1 = (await one(`select dev_save_institution(null, '{"name":"Sneaky College","short_code":"SNK"}') r`)).r; await admin();
  await as(dev);
  const ni = (await one(`select dev_save_institution(null, '{"name":"Boston City Campus","short_code":"BCC"}') r`)).r;
  const nc0 = (await one(`select dev_save_campus(null, $1::jsonb) r`, [JSON.stringify({ university_id: ni.id, name: 'Pretoria', verification: 'verified_current' })])).r;
  const nc = (await one(`select dev_save_campus(null, $1::jsonb) r`, [JSON.stringify({ university_id: ni.id, name: 'Pretoria', verification: 'verified_current', source_url: 'https://example.ac.za/campuses' })])).r;
  await admin();
  rec('only a developer can add an institution', c1.ok === false && ni.ok === true, JSON.stringify(c1));
  const newU = await one(`select registration_open, features from universities where id = $1`, [ni.id]);
  rec('a new institution starts closed, with features off until configured', newU.registration_open === false && newU.features.orientation === false && newU.features.entrepreneurs === false);
  rec('a verified campus needs a source; then it saves under the new institution', nc0.ok === false && nc.ok === true);
  const stu = await mk('bcc@gmail.com');
  await as(stu); const r1 = (await one(`select set_my_student_status(true, $1, $2) r`, [ni.id, nc.id])).r; await admin();
  rec('students can\'t pick it before registration opens', r1.ok === false && /can't join ClickFood yet/.test(r1.error), JSON.stringify(r1));
  await as(dev); await one(`select dev_save_institution($1, '{"name":"Boston City Campus","short_code":"BCC","registration_open":true,"features":{"orientation":true}}') r`, [ni.id]); await admin();
  await as(stu); const r2 = (await one(`select set_my_student_status(true, $1, $2) r`, [ni.id, nc.id])).r; await admin();
  rec('after the developer opens registration, its students can join (no code change)', r2.ok === true, JSON.stringify(r2));
  await as(dev); await one(`select dev_save_institution($1, '{"name":"Boston City Campus","short_code":"BCC","active":false}') r`, [ni.id]); await admin();
  rec('disabling an institution keeps its students\' accounts', (await one(`select home_university_id from profiles where id = $1`, [stu])).home_university_id === ni.id);
  await as(up); const w = await tryq(`insert into universities (name, short_code) values ('Hack U', 'HCK')`); const w2 = await tryq(`update campuses set name = 'X' returning id`); await admin();
  rec('customers cannot write institutions or campuses directly', !!w.err && (!!w2.err || w2.rows.length === 0), [w.err, w2.err].join(' | '));
  rec('orders are kept (none deleted)', (await one(`select count(*)::int n from orders`)).n >= 1);

  try { await q(SQL('institutions_v2_rollback.sql')); await q(SQL('institutions_v2.sql')); rec('rollback runs and the file re-applies', true); } catch (e) { rec('rollback runs and the file re-applies', false, e.message); }
  await db.end();
  try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {}
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
