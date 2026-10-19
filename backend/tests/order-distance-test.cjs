// Database test for supabase/order_distance.sql: the configurable 30 km
// ordering rule (straight-line km, ordering location vs shop pin), saved vs
// current location, shops without a pin, direct-request bypass attempts,
// campus pins, saved location near the campus, campus change, group orders.
//   NODE_PATH=backend/tests/lt/node_modules node backend/tests/order-distance-test.cjs
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');
const PORT = 55791, DIR = path.join(LT, 'cfdistance');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 240)})` : '')]);
const KM_PER_DEG = 6371.0088 * Math.PI / 180;   // km per degree of latitude on this sphere

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
                   'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql', 'shop_locations.sql', 'privacy_legal.sql']) await q(SQL(f));
  await q(`insert into platform_config (id) values (1) on conflict (id) do nothing`).catch(() => {});
  try { await q(SQL('order_distance.sql')); await q(SQL('order_distance.sql')); rec('migration applies (twice)', true); } catch (e) { rec('migration applies (twice)', false, e.message); throw e; }

  const mkUser = async (email, role) => {
    const id = crypto.randomUUID();
    await q(`set session_replication_role = replica`);
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, email]);
    await q(`insert into profiles (id, name, email, role, status, active) values ($1, $2, $2, $3, 'approved', true)`, [id, email, role || 'customer']);
    await q(`set session_replication_role = origin`);
    return id;
  };
  // Hatfield-ish home pin
  const H = { lat: -25.7545, lng: 28.2314 };
  const north = (km) => ({ lat: H.lat + km / KM_PER_DEG, lng: H.lng });
  const mgr = await mkUser('mgr@shop.test', 'manager');
  const mkShop = async (name, pin) => (await one(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time, seller_kind, pickup_lat, pickup_lng)
    values ($1, $2, $3, 'Fast Food', 'Hatfield', 'Somewhere', 'University of Pretoria', 'approved', true, '00:00', '23:59', 'business', $4, $5) returning id`, [mgr, name, name.toLowerCase().replace(/\W+/g, '-'), pin ? pin.lat : null, pin ? pin.lng : null])).id;
  const S = { near: await mkShop('Ten Km Grill', north(10)), edge: await mkShop('Edge Kota', north(29.999)), over: await mkShop('Far Pizza', north(30.01)), nopin: await mkShop('No Pin Cafe', null) };
  const exact = await mkShop('Exact Thirty', north(30));
  const item = {};
  for (const [k, id] of Object.entries(Object.assign({ exact }, S))) item[k] = (await one(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, 'Burger', 'Lunch', 50, 'x', 'A burger', 'approved', true, 500) returning id`, [id])).id;
  const cust = await mkUser('thandi@gmail.com');
  await q(`update profiles set home_address = 'Hatfield', home_lat = $1, home_lng = $2 where id = $3`, [H.lat, H.lng, cust]);

  const chk = async (u, store, loc) => { await as(u); const r = (await one(`select check_my_order_distance($1, $2::jsonb) r`, [store, JSON.stringify(loc)])).r; await admin(); return r; };
  const order = async (u, key, loc) => {
    await as(u);
    const r = await tryq(`insert into orders (customer_id, store_id, items, payment_method, total, delivery_location) values (auth.uid(), $1, $2, 'cod', 50, $3) returning id, delivery_location`,
      [key === 'exact' ? exact : S[key], JSON.stringify([{ menuItemId: item[key], name: 'Burger', qty: 1, price: 50 }]), JSON.stringify(Object.assign({ fulfilment: 'collection', collectionTime: new Date(Date.now() + 3600000).toISOString() }, loc === undefined ? {} : { orderLocation: loc }))]);
    await admin(); return r;
  };

  // ---------------- distance + rule ----------------
  const km = (await one(`select km_between(-25.7545, 28.2314, -26.2041, 28.0473) k`)).k;
  rec('straight-line distance is correct (Hatfield to Johannesburg CBD about 53 km)', km > 50 && km < 56, km.toFixed(2));
  let r = await chk(cust, S.near, { mode: 'saved' });
  rec('a shop 10 km away is eligible (km reported)', r.ok === true && Math.abs(Number(r.km) - 10) < 0.05, JSON.stringify(r));
  r = await chk(cust, S.edge, { mode: 'saved' });
  rec('a shop at 29.999 km is eligible', r.ok === true, JSON.stringify(r));
  r = await chk(cust, exact, { mode: 'saved' });
  rec('a shop placed at exactly 30 km (to the stored precision) is eligible: the rule is "at or below"', r.ok === true && Math.abs(Number(r.km) - 30) < 0.01, JSON.stringify(r));
  r = await chk(cust, S.over, { mode: 'saved' });
  rec('a shop more than 30 km away (30.01) is not eligible, with a clear message', r.ok === false && r.code === 'too_far' && /within 30 km/.test(r.error), JSON.stringify(r));
  r = await chk(cust, S.nopin, { mode: 'saved' });
  rec('a shop without a pin is never treated as nearby', r.ok === false && r.code === 'shop_no_location', JSON.stringify(r));

  // ---------------- enforced on the order ----------------
  let o = await order(cust, 'near', { mode: 'saved' });
  rec('ordering from the 10 km shop works', !o.err, o.err);
  rec('the order keeps only the mode and km (no coordinates)', o.rows && o.rows[0].delivery_location.orderLocation.mode === 'saved' && !('lat' in o.rows[0].delivery_location.orderLocation), o.rows && JSON.stringify(o.rows[0].delivery_location.orderLocation));
  o = await order(cust, 'over', { mode: 'saved' });
  rec('a direct order to the 30.01 km shop is refused by the database', !!o.err && /within 30 km/.test(o.err), o.err);
  o = await order(cust, 'over', { mode: 'saved', lat: north(30.01).lat, lng: H.lng });
  rec('"saved" mode ignores coordinates sent in the request (the profile is used)', !!o.err, o.err);
  o = await order(cust, 'over', undefined);
  rec('an order with no ordering location uses the saved location (old app versions are checked too)', !!o.err, o.err);
  o = await order(cust, 'nopin', { mode: 'saved' });
  rec('ordering from a shop without a pin is refused', !!o.err && /hasn't set its location/.test(o.err), o.err);
  // current location (travelling)
  const away = { lat: -29.85, lng: 31.02 };   // Durban, far from Pretoria
  r = await chk(cust, S.near, { mode: 'current', lat: away.lat, lng: away.lng });
  rec('from a far CURRENT location, the Hatfield shop is not eligible', r.ok === false && r.code === 'too_far', JSON.stringify(r));
  r = await chk(cust, S.near, { mode: 'saved' });
  rec('...switching to the SAVED university-area location makes it eligible again', r.ok === true);
  o = await order(cust, 'near', { mode: 'current', lat: north(9).lat, lng: H.lng });
  rec('a current-location order nearby works and the coordinates are not stored', !o.err && !('lat' in o.rows[0].delivery_location.orderLocation) && o.rows[0].delivery_location.orderLocation.mode === 'current', o.err);
  o = await order(cust, 'near', { mode: 'current', lat: 'abc', lng: 999 });
  rec('a broken current location is refused', !!o.err, o.err);

  // ---------------- settings ----------------
  await as(cust);
  const sett = await tryq(`update platform_config set max_order_distance_km = 500 where id = 1 returning id`);
  const sett2 = await tryq(`select dev_set_order_distance(500, false) r`);
  const shopMove = await tryq(`update stores set pickup_lat = $1 where id = $2 returning id`, [H.lat, S.over]);
  await admin();
  rec('a customer cannot change the distance limit or switch the rule off', (sett.err || sett.rows.length === 0) && sett2.rows && sett2.rows[0].r.ok === false && Number((await one(`select max_order_distance_km k from platform_config where id = 1`)).k) === 30, sett.err);
  rec('a customer cannot move a shop\'s pin', (shopMove.err || shopMove.rows.length === 0));
  const dev = await mkUser('dev@clickfood.test', 'developer');
  await as(dev); const d1 = (await one(`select dev_set_order_distance(40, true) r`)).r; await admin();
  rec('a developer can change the limit (now 40 km: the 30.01 km shop is eligible)', d1.ok && (await chk(cust, S.over, { mode: 'saved' })).ok === true);
  await as(dev); await one(`select dev_set_order_distance(30, false) r`); await admin();
  rec('with the rule switched off, even a shop without a pin can take orders', (await chk(cust, S.nopin, { mode: 'saved' })).ok === true);
  await as(dev); await one(`select dev_set_order_distance(30, true) r`); await admin();
  rec('the app can read the limit and switch (public flags)', (await one(`select public_app_flags() f`)).f.max_order_km == 30 && (await one(`select public_app_flags() f`)).f.distance_rule === true);

  // ---------------- campus pins + saved location ----------------
  const UP = (await one(`select id from universities where name = 'University of Pretoria'`)).id;
  const HAT = (await one(`select id from campuses where code = 'up-hatfield'`)).id;
  const MAM = (await one(`select id from campuses where code = 'up-mamelodi'`)).id;
  await as(cust); const cp0 = await tryq(`select dev_set_campus_location($1, -25.75, 28.23, 'x') r`, [HAT]); await admin();
  rec('a customer cannot set campus coordinates', cp0.err || cp0.rows[0].r.ok === false);
  await as(dev);
  const cp1 = (await one(`select dev_set_campus_location($1, -25.7545, 28.2314, null) r`, [HAT])).r;
  const cp2 = (await one(`select dev_set_campus_location($1, -25.7545, 28.2314, 'UP campus map page') r`, [HAT])).r;
  const cp3 = (await one(`select dev_set_campus_location($1, -25.7130, 28.3950, 'UP campus map page') r`, [MAM])).r;
  await admin();
  rec('a campus pin needs a source, then saves', cp1.ok === false && cp2.ok && cp3.ok, JSON.stringify([cp1, cp2]));
  // student with a campus
  const stu = await mkUser('lerato@gmail.com');
  await q(`update profiles set home_address = 'Hatfield', home_lat = $1, home_lng = $2 where id = $3`, [H.lat + 0.01, H.lng, stu]);
  await as(stu); const s1 = (await one(`select set_my_student_status(true, $1, $2) r`, [UP, HAT])).r; await admin();
  rec('a student chooses Hatfield; their nearby saved location is kept', s1.ok && !s1.needs_location && (await one(`select home_lat from profiles where id = $1`, [stu])).home_lat !== null, JSON.stringify(s1));
  const far = north(-60);   // 60 km south of Hatfield
  await as(stu); const bad = await tryq(`update profiles set home_lat = $1, home_lng = $2 where id = auth.uid()`, [far.lat, far.lng]); await admin();
  rec('a saved university-area location more than 30 km from the campus is rejected', !!bad.err && /within 30 km of your campus/.test(bad.err), bad.err);
  const ok29 = north(-25);
  await as(stu); const good = await tryq(`update profiles set home_lat = $1, home_lng = $2 where id = auth.uid()`, [ok29.lat, ok29.lng]); await admin();
  rec('a saved location 25 km from the campus is accepted', !good.err, good.err);
  // change campus to Mamelodi (the 25 km-south location is ~ 40 km from Mamelodi)
  await as(stu); const s2 = (await one(`select set_my_student_status(true, $1, $2) r`, [UP, MAM])).r; await admin();
  const after = await one(`select campus_location, home_lat from profiles where id = $1`, [stu]);
  rec('changing campus re-checks the saved location: too far -> cleared and the app asks for a new one', s2.ok && s2.needs_location === true && after.campus_location === 'Mamelodi' && after.home_lat === null, JSON.stringify(s2));
  // campuses without coordinates: no guessing
  const GIBS = (await one(`select id from campuses where code = 'up-gibs'`)).id;
  rec('a campus without coordinates is never used to accept or reject a location', (await one(`select saved_location_problem($1, -33.9, 18.4) p`, [GIBS])).p === null);
  // non-student
  await q(`update profiles set is_student = false where id = $1`, [cust]);
  await as(cust); const ns = await tryq(`update profiles set home_lat = -33.92, home_lng = 18.42 where id = auth.uid()`); await admin();
  rec('a non-student can save any location (no campus needed)', !ns.err, ns.err);
  rec('...and then only shops within 30 km of it are eligible', (await chk(cust, S.near, { mode: 'saved' })).ok === false);
  // suggest a campus
  const sug = (await one(`select nearest_campus($1, -25.7560, 28.2330, 5) s`, [UP])).s;
  const none = (await one(`select nearest_campus($1, -29.85, 31.02, 5) s`, [UP])).s;
  rec('"suggest my campus": a phone near Hatfield suggests Hatfield; far away suggests nothing', sug && /Hatfield/.test(sug.name) && none === null, JSON.stringify([sug, none]));

  // ---------------- group orders ----------------
  await as(cust); const g = await tryq(`select create_group_order($1, 'Lunch', 'leader') r`, [S.near]); await admin();
  rec('a leader whose saved location is too far cannot start a group order there', !!g.err && /km from your saved location/.test(g.err), g.err);
  await as(stu);
  await q(`update profiles set home_lat = -25.7180, home_lng = 28.3900 where id = auth.uid()`).catch(() => {});
  await admin();
  const shopMam = await mkShop('Mamelodi Grill', { lat: -25.7150, lng: 28.3960 });
  await as(stu); const g2 = await tryq(`select create_group_order($1, 'Lunch', 'leader') r`, [shopMam]); await admin();
  rec('a nearby leader can start a group order', !g2.err, g2.err);

  try { await q(SQL('order_distance_rollback.sql')); await q(SQL('order_distance.sql')); rec('rollback runs and the file re-applies', true); } catch (e) { rec('rollback runs and the file re-applies', false, e.message); }
  await db.end();
  try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {}
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
