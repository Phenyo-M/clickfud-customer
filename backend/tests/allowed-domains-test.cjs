// Local test of supabase/allowed_domains.sql (Supported Institutions). Run:
//   NODE_PATH=tests/lt/node_modules node tests/allowed-domains-test.cjs
const path = require('path'); const fs = require('fs');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');

const PORT = 55541, DIR = path.join(LT, 'cfdomains');
const results = [];
const rec = (name, ok, extra) => results.push([ok ? 'PASS' : 'FAIL', name + (extra ? ` (${extra})` : '')]);
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');

(async () => {
  const db = await build(PORT, DIR);
  const q = (sql, params) => db.query(sql, params);
  const admin = async () => { await q(`reset role; select set_config('request.jwt.claims', '', false)`); };
  const as = async (id, email) => { await q('reset role'); await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated', email })]); await q('set role authenticated'); };
  const anon = async () => { await q(`reset role; select set_config('request.jwt.claims', '{"role":"anon"}', false); set role anon`); };
  const err = async (name, fn, re) => { try { await fn(); rec(name, false, 'was allowed'); } catch (e) { rec(name, !re || re.test(e.message), e.message.slice(0, 140)); } };
  await admin();
  for (const f of ['student_sellers.sql', 'seller_review_address.sql', 'student_application_details.sql', 'student_number_from_email.sql']) await q(SQL(f));
  try { await q(SQL('allowed_domains.sql')); rec('migration applies', true); } catch (e) { rec('migration applies', false, e.message.slice(0, 200)); }
  try { await q(SQL('allowed_domains.sql')); rec('migration applies a second time', true); } catch (e) { rec('migration applies a second time', false, e.message.slice(0, 200)); }

  // the live sign-up triggers (not part of the local auth stub)
  await q(`alter table auth.users add column if not exists raw_user_meta_data jsonb, add column if not exists raw_app_meta_data jsonb`);
  await q(`drop trigger if exists on_auth_user_created on auth.users; create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
           drop trigger if exists trg_enforce_customer_signup on auth.users; create constraint trigger trg_enforce_customer_signup after insert on auth.users deferrable initially deferred for each row execute function public.enforce_customer_signup();`);
  let n = 10;
  const signUp = async (email, meta) => {
    const id = `00000000-0000-4000-8000-0000000000${n++}`;
    await admin(); await q('begin');
    try {
      await q(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, '{"provider":"email"}')`, [id, email, JSON.stringify(Object.assign({ name: 'Test Student', role: 'customer' }, meta || {}))]);
      await q('commit');
      return { id, error: null, profile: (await q(`select university, student_number from profiles where id = $1`, [id])).rows[0] };
    } catch (e) { await q('rollback').catch(() => {}); return { id, error: e.message }; }
  };

  // ---- the seeded list ----
  const rows = (await q(`select institution_name, domain, active, student_number_digits from allowed_domains order by domain`)).rows;
  rec('five starting institutions, all active', rows.length === 5 && rows.every(r => r.active) && ['mylife.unisa.ac.za', 'rcconnect.edu.za', 'tuks.co.za', 'tut4life.ac.za', 'vossie.net'].every(d => rows.some(r => r.domain === d)), rows.map(r => r.domain).join(', '));

  // ---- sign-up rules ----
  let r = await signUp('u12345678@tuks.co.za');
  rec('UP: student number email signs up (UP, u12345678)', r.error === null && r.profile.university === 'University of Pretoria' && r.profile.student_number === 'u12345678', r.error || JSON.stringify(r.profile));
  r = await signUp('thabo.m@tuks.co.za');
  rec('UP: an address without the student number is refused', /UP_STUDENT_NUMBER_REQUIRED/.test(r.error || ''), r.error);
  r = await signUp('219012345@tut4life.ac.za', { university: 'University of Pretoria' });
  rec('TUT: 9-digit student number email signs up, university TUT (whatever the app sent)', r.error === null && r.profile.university === 'Tshwane University of Technology' && r.profile.student_number === '219012345', r.error || JSON.stringify(r.profile));
  const tutId = r.id;
  r = await signUp('lerato@tut4life.ac.za');
  rec('TUT: an address without the student number is refused', /UP_STUDENT_NUMBER_REQUIRED/.test(r.error || ''), r.error);
  r = await signUp('Jane.Doe@MyLife.Unisa.ac.za');
  rec('Unisa: any address at the domain signs up (case-insensitive)', r.error === null && r.profile.university === 'University of South Africa', r.error || JSON.stringify(r.profile));
  const unisaId = r.id;
  r = await signUp('someone@vossie.net');
  rec('Eduvos signs up', r.error === null && r.profile.university === 'Eduvos', r.error);
  r = await signUp('someone@rcconnect.edu.za');
  rec('Rosebank College signs up', r.error === null && r.profile.university === 'Rosebank College', r.error);
  r = await signUp('someone@gmail.com');
  rec('any other email is refused', /UP_STUDENT_EMAIL_REQUIRED/.test(r.error || ''), r.error);
  r = await signUp('someone@fake.tuks.co.za');
  rec('a lookalike sub-domain is refused (exact match only)', /UP_STUDENT_EMAIL_REQUIRED/.test(r.error || ''), r.error);

  // ---- who may read and change the list ----
  const ids = { cust: tutId, dev: '00000000-0000-4000-8000-000000000099' };
  await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, 'dev@clickfood.co.za', now())`, [ids.dev]);
  await q(`set session_replication_role = replica`); // test setup only: make the developer account directly
  await q(`insert into profiles (id, name, email, role, status, active) values ($1, 'Dev', 'dev@clickfood.co.za', 'developer', 'approved', true) on conflict (id) do update set role = 'developer', name = 'Dev', status = 'approved', active = true`, [ids.dev]);
  await q(`set session_replication_role = origin`);
  await q(`update allowed_domains set active = false where domain = 'vossie.net'`);
  await anon();
  const anonRows = (await q(`select domain from allowed_domains`)).rows.map(x => x.domain);
  rec('logged-out visitors read only active institutions', anonRows.length === 4 && !anonRows.includes('vossie.net'), anonRows.join(', '));
  await err('logged-out visitors cannot add one', () => q(`insert into allowed_domains (institution_name, domain) values ('X', 'x.ac.za')`), /permission|row-level/);
  await as(ids.cust, '219012345@tut4life.ac.za');
  await err('a student cannot add one', () => q(`insert into allowed_domains (institution_name, domain) values ('X', 'x.ac.za')`), /row-level security/);
  rec('a student cannot switch one off', (await q(`update allowed_domains set active = false where domain = 'tuks.co.za' returning 1`)).rows.length === 0);
  rec('a student cannot delete one', (await q(`delete from allowed_domains where domain = 'tuks.co.za' returning 1`)).rows.length === 0);
  await as(ids.dev, 'dev@clickfood.co.za');
  rec('the developer sees inactive ones too', (await q(`select count(*)::int n from allowed_domains`)).rows[0].n === 5);
  try { await q(`insert into allowed_domains (institution_name, domain) values ('New University', 'newuni.ac.za')`); rec('the developer adds an institution', true); } catch (e) { rec('the developer adds an institution', false, e.message); }
  await err('a duplicate domain is refused', () => q(`insert into allowed_domains (institution_name, domain) values ('Again', 'newuni.ac.za')`), /duplicate|unique/);
  await err('an invalid domain is refused', () => q(`insert into allowed_domains (institution_name, domain) values ('Bad', 'not a domain')`), /check constraint/);
  await err('an uppercase domain is refused (the app lowercases it first)', () => q(`insert into allowed_domains (institution_name, domain) values ('Bad', 'UPPER.ac.za')`), /check constraint/);
  await admin();

  // ---- a new institution: sign up, switch off, existing student kept ----
  r = await signUp('first@newuni.ac.za');
  rec('a newly added institution can sign up straight away', r.error === null && r.profile.university === 'New University', r.error);
  const newId = r.id;
  await as(ids.dev, 'dev@clickfood.co.za');
  await q(`update allowed_domains set active = false where domain = 'newuni.ac.za'`);
  await admin();
  r = await signUp('second@newuni.ac.za');
  rec('switched off: new sign-ups from it are blocked', /UP_STUDENT_EMAIL_REQUIRED/.test(r.error || ''), r.error);
  rec('switched off: the existing student is kept', (await q(`select count(*)::int n from profiles where id = $1`, [newId])).rows[0].n === 1);
  rec('switched off: the existing student can still log in (secure-login check)', (await q(`select is_up_student_email('first@newuni.ac.za') ok`)).rows[0].ok === true);
  await as(ids.dev, 'dev@clickfood.co.za');
  await q(`update allowed_domains set active = true where domain = 'newuni.ac.za'`);
  await admin();
  r = await signUp('third@newuni.ac.za');
  rec('switched on again: sign-ups work again', r.error === null, r.error);
  rec('staff accounts are never checked against the list', (await q(`select role from profiles where id = $1`, [ids.dev])).rows[0].role === 'developer');

  // ---- university locked to the email ----
  await q(`update profiles set university = 'University of Pretoria' where id = $1`, [tutId]);
  rec('a student cannot switch their university', (await q(`select university from profiles where id = $1`, [tutId])).rows[0].university === 'Tshwane University of Technology');

  // ---- verified email before ordering ----
  const shop = (await q(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time)
    values ($1, 'Kota Shop', 'kota-shop', 'Fast Food', 'Pretoria', 'Shop 3', 'Tshwane University of Technology', 'approved', true, '00:00', '00:00') returning id`, [ids.dev])).rows[0].id;
  const item = (await q(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, 'Kota', 'Lunch', 35, 'x', 'Classic kota with chips', 'approved', true, 50) returning id`, [shop])).rows[0].id;
  const order = async () => { await as(tutId, '219012345@tut4life.ac.za'); try { return await q(`insert into orders (customer_id, store_id, items, payment_method, total, delivery_location) values (auth.uid(), $1, $2, 'cod', 35, '{"fulfilment":"collection"}')`, [shop, JSON.stringify([{ menuItemId: item, name: 'Kota', qty: 1, price: 35 }])]); } finally { await admin(); } };
  await err('an unverified student cannot order', order, /verify your email/);
  await q(`update auth.users set email_confirmed_at = now() where id = $1`, [tutId]);
  try { await order(); rec('after verifying, the student can order', true); } catch (e) { rec('after verifying, the student can order', false, e.message.slice(0, 140)); }

  // ---- student shop at an institution without a campus list ----
  await q(`update auth.users set email_confirmed_at = now() where id = $1`, [unisaId]);
  await q(`update profiles set status = 'approved', active = true where id = $1`, [unisaId]);
  await as(unisaId, 'jane.doe@mylife.unisa.ac.za');
  let s = null;
  try {
    s = (await q(`select * from become_student_seller('Jane Bakes', '072 123 4567', '{Baked Goods}', null, 'Sunnyside', 'Home baked treats for students', null, 'https://x.supabase.co/storage/v1/object/public/images/avatars/a/shop.webp', 'Sunnyside flat', -25.75, 28.20, false, true, $1)`,
      [JSON.stringify({ business_type: 'bakery', contact_phone: '072 123 4567', contact_email: 'jane@mylife.unisa.ac.za', is_registered: false, manager_phone: '072 123 4567', manager_position: 'owner', open_days: [1, 2, 3], opening_time: '08:00', closing_time: '17:00', products_summary: 'Muffins and scones' })])).rows[0];
    rec('a Unisa student opens a student shop (any campus name)', true);
  } catch (e) { rec('a Unisa student opens a student shop (any campus name)', false, e.message.slice(0, 160)); }
  await admin();
  rec('the shop belongs to their institution', s && s.university === 'University of South Africa', s && s.university);
  await as(tutId, '219012345@tut4life.ac.za');
  await err('a TUT student cannot use a UP campus for their shop', () => q(`select * from become_student_seller('T Kitchen', '072 123 4567', '{Lunch}', null, 'Hatfield', 'Home cooked meals for students', null, 'https://x/p.webp', 'Res', -25.5, 28.1, true, true, '{}')`), /choose your campus/);
  await admin();

  try { await q(SQL('allowed_domains_rollback.sql')); rec('rollback runs', true); } catch (e) { rec('rollback runs', false, e.message.slice(0, 160)); }
  try { await q(SQL('allowed_domains.sql')); rec('migration re-applies after rollback', true); } catch (e) { rec('migration re-applies after rollback', false, e.message.slice(0, 160)); }

  await db.end();
  execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' });
  for (const [st, m] of results) console.log(st, m);
  const failed = results.filter(x => x[0] !== 'PASS').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { for (const [st, m] of results) console.log(st, m); console.error(e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
