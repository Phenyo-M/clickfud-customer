// Local test of supabase/student_number_from_email.sql: sign-up needs no
// typed student number; it comes from the UP email. Run:
//   NODE_PATH=tests/lt/node_modules node tests/student-number-test.cjs
const path = require('path'); const fs = require('fs');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');

const PORT = 55531, DIR = path.join(LT, 'cfstudentno');
const results = [];
const rec = (name, ok, extra) => results.push([ok ? 'PASS' : 'FAIL', name + (extra ? ` (${extra})` : '')]);
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');

(async () => {
  const db = await build(PORT, DIR);
  const q = (sql, params) => db.query(sql, params);
  await q(`reset role; select set_config('request.jwt.claims', '', false)`);
  // a customer from before the change, with no student number yet
  await q(`insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-000000000001', 'u11122233@tuks.co.za', now())`);
  await q(`insert into profiles (id, name, email, role, status, active) values ('00000000-0000-4000-8000-000000000001', 'Old Student', 'u11122233@tuks.co.za', 'customer', 'approved', true) on conflict (id) do update set student_number = null`);
  await q(`update profiles set student_number = null where id = '00000000-0000-4000-8000-000000000001'`);

  try { await q(SQL('student_number_from_email.sql')); rec('migration applies', true); } catch (e) { rec('migration applies', false, e.message.slice(0, 200)); }
  try { await q(SQL('student_number_from_email.sql')); rec('migration applies a second time', true); } catch (e) { rec('migration applies a second time', false, e.message.slice(0, 200)); }

  const cases = [['u12345678@tuks.co.za', 'u12345678'], ['U12345678@TUKS.CO.ZA', 'u12345678'], ['12345678@tuks.co.za', 'u12345678'], ['thabo.m@tuks.co.za', null], ['u1234567@tuks.co.za', null], [null, null]];
  for (const [email, want] of cases) {
    const got = (await q(`select public.student_number_from_email($1) n`, [email])).rows[0].n;
    rec(`number from "${email}" is ${want}`, got === want, String(got));
  }
  rec('existing customer without a number gets it from their email', (await q(`select student_number from profiles where id = '00000000-0000-4000-8000-000000000001'`)).rows[0].student_number === 'u11122233');

  // sign-up as the auth service does it (trigger on auth.users, deferred check at commit)
  // the live sign-up triggers on auth.users (not part of the local auth stub)
  await q(`alter table auth.users add column if not exists raw_user_meta_data jsonb, add column if not exists raw_app_meta_data jsonb`);
  await q(`drop trigger if exists on_auth_user_created on auth.users; create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
           drop trigger if exists trg_enforce_customer_signup on auth.users; create constraint trigger trg_enforce_customer_signup after insert on auth.users deferrable initially deferred for each row execute function public.enforce_customer_signup();`);
  const hasTrigger = (await q(`select count(*)::int n from pg_trigger where tgname in ('on_auth_user_created', 'trg_enforce_customer_signup')`)).rows[0].n;
  if (hasTrigger === 2) {
    const signUp = async (id, email, meta) => {
      await q('begin');
      try {
        await q(`insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, '{"provider":"email"}')`, [id, email, JSON.stringify(meta)]);
        await q('commit');
        return null;
      } catch (e) { await q('rollback').catch(() => {}); return e.message; }
    };
    let e = await signUp('00000000-0000-4000-8000-000000000002', 'u22233344@tuks.co.za', { name: 'New Student', role: 'customer' });
    rec('a UP student signs up without typing a student number', e === null, e);
    rec('their student number comes from the email', (await q(`select student_number from profiles where id = '00000000-0000-4000-8000-000000000002'`)).rows[0]?.student_number === 'u22233344');
    e = await signUp('00000000-0000-4000-8000-000000000003', 'u33344455@tuks.co.za', { name: 'Older App', role: 'customer', student_number: 'u33344455' });
    rec('an older app that still sends the number keeps working', e === null && (await q(`select student_number from profiles where id = '00000000-0000-4000-8000-000000000003'`)).rows[0]?.student_number === 'u33344455', e);
    e = await signUp('00000000-0000-4000-8000-000000000005', 'thabo.m@tuks.co.za', { name: 'Named Address', role: 'customer' });
    rec('a UP email without a student number in it is refused', /UP_STUDENT_NUMBER_REQUIRED/.test(e || ''), e);
    e = await signUp('00000000-0000-4000-8000-000000000006', 'thabo.m@tuks.co.za', { name: 'Older App', role: 'customer', student_number: 'u44455566' });
    rec('even when an older app sends a typed student number', /UP_STUDENT_NUMBER_REQUIRED/.test(e || ''), e);
    e = await signUp('00000000-0000-4000-8000-000000000004', 'someone@gmail.com', { name: 'Not UP', role: 'customer' });
    rec('a non-UP email is still refused', /UP_STUDENT_EMAIL_REQUIRED/.test(e || ''), e);
  } else {
    rec('sign-up triggers present in the local copy', false, 'missing: ' + hasTrigger);
  }

  try { await q(SQL('student_number_from_email_rollback.sql')); rec('rollback runs', true); } catch (e) { rec('rollback runs', false, e.message.slice(0, 160)); }
  try { await q(SQL('student_number_from_email.sql')); rec('migration re-applies after rollback', true); } catch (e) { rec('migration re-applies after rollback', false, e.message.slice(0, 160)); }

  await db.end();
  execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' });
  for (const [s, n] of results) console.log(s, n);
  const failed = results.filter(r => r[0] !== 'PASS').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
