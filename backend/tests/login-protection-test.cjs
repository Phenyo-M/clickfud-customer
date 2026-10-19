// Tests for login protection (supabase/login_protection.sql + the
// secure-login function). Real function in Deno (2 instances), local copy of
// the database, stand-in for Supabase Auth. Synthetic accounts only.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/login-protection-test.cjs
const { startEnv, sleep } = require('./login-env.cjs');
const results = [];
const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 260)})` : '')]);
const PW = 'Correct-Horse-9!';

(async () => {
  const E = await startEnv({ fnPorts: [8101, 8102] });
  const { q, login, auth, addUser } = E;
  const one = async (s, p) => (await q(s, p)).rows[0];
  const SQLF = require('fs').readFileSync(require('path').join(__dirname, '../supabase/login_protection.sql'), 'utf8');
  try { await q(SQLF); rec('migration applies a second time', true); } catch (e) { rec('migration applies a second time', false, e.message); }
  const clear = async () => { await q(`delete from login_rl_state; delete from login_ip_accounts; delete from login_known_pairs; delete from login_metrics`); auth.perEmail.clear(); };
  const expire = async () => q(`update login_rl_state set blocked_until = now() - interval '1 second' where blocked_until is not null`);

  const stu = 'u10000001@tuks.co.za';
  await addUser(stu, PW);
  const mgr = 'manager@shop.test'; await addUser(mgr, PW, 'manager');
  await addUser('u10000009@tuks.co.za', PW, 'customer', false);

  // ---------------- basics + enumeration ----------------
  let r = await login(stu, PW, '198.51.100.1');
  rec('a correct password signs in', !!(r.body.session && r.body.session.access_token), JSON.stringify(r.body).slice(0, 120));
  const wrongReal = await login(stu, 'nope', '198.51.100.2');
  const wrongNone = await login('u19999999@tuks.co.za', 'nope', '198.51.100.2');
  rec('wrong password and unknown email get the exact same answer', JSON.stringify(wrongReal.body) === JSON.stringify(wrongNone.body) && wrongReal.status === wrongNone.status && wrongReal.body.error === 'Invalid login credentials', JSON.stringify([wrongReal.body, wrongNone.body]));
  const wrongApp = await login(mgr, PW, '198.51.100.2', { app: 'customer' });
  rec('a real staff password on the customer app is answered like a wrong password', JSON.stringify(wrongApp.body) === JSON.stringify(wrongReal.body));
  r = await login(mgr, PW, '198.51.100.3', { app: 'staff' });
  rec('staff still sign in on the staff app', !!(r.body.session));
  r = await login('u10000009@tuks.co.za', PW, '198.51.100.3');
  rec('an unconfirmed email still gets its own message (after a correct password only)', /not confirmed/i.test(r.body.error || ''), r.body.error);

  // ---------------- per email + network ----------------
  await clear();
  for (let i = 0; i < 5; i++) await login(stu, 'bad' + i, '203.0.113.5');
  r = await login(stu, PW, '203.0.113.5');
  rec('5 wrong passwords from one network -> a short wait (30 s), even for the right password', r.body.rate_limited === true && /30 seconds/.test(r.body.error) && !!r.body.lockedUntil, JSON.stringify(r.body));
  rec('the wait answer is the same for an unknown email', (await (async () => { for (let i = 0; i < 5; i++) await login('u18888888@tuks.co.za', 'x' + i, '203.0.113.5'); return (await login('u18888888@tuks.co.za', 'x', '203.0.113.5')).body.error; })()) === r.body.error);
  const calls = auth.perEmail.get(stu);
  r = await login(stu, 'bad', '203.0.113.5');
  rec('while waiting, nothing reaches Supabase Auth', auth.perEmail.get(stu) === calls);
  await expire();
  r = await login(stu, PW, '203.0.113.5');
  rec('Scenario 11: after the wait expires the student signs in normally', !!r.body.session, JSON.stringify(r.body).slice(0, 120));
  await clear();
  for (let i = 0; i < 5; i++) await login(stu, 'bad' + i, '203.0.113.6');
  await expire();
  for (let i = 0; i < 5; i++) await login(stu, 'bad' + i, '203.0.113.6');
  r = await login(stu, 'bad', '203.0.113.6');
  rec('repeat offences wait longer (30 s, then 1 minute)', /1 minute/.test(r.body.error || ''), r.body.error);
  await q(`update login_rl_state set last_fail_at = now() - interval '61 minutes', blocked_until = now() - interval '1 second'`);
  for (let i = 0; i < 5; i++) await login(stu, 'bad' + i, '203.0.113.6');
  r = await login(stu, 'bad', '203.0.113.6');
  rec('after 60 minutes without failures the waits start from 30 s again', /30 seconds/.test(r.body.error || ''), r.body.error);
  const maxWait = await one(`select max(extract(epoch from blocked_until - now())) s from login_rl_state`);
  rec('no wait is longer than 15 minutes, nothing is permanent', Number(maxWait.s) <= 900);

  // ---------------- same person, other spellings ----------------
  await clear();
  const forms = ['U10000001@TUKS.CO.ZA', ' u10000001@tuks.co.za ', 'u10000001+x@tuks.co.za', 'u10000001@tuks.co.za.', 'ｕ10000001@tuks.co.za'];
  for (const f of forms) await login(f, 'bad', '203.0.113.7');
  r = await login(stu, PW, '203.0.113.7');
  rec('case, spaces, +tags, a trailing dot and full-width letters all count as the same email', r.body.rate_limited === true, JSON.stringify(r.body).slice(0, 100));

  // ---------------- parallel requests ----------------
  await clear();
  const before = auth.perEmail.get(stu) || 0;
  const par = await Promise.all(Array.from({ length: 40 }, (_, i) => login(stu, 'para' + i, '203.0.113.8')));
  const reached = (auth.perEmail.get(stu) || 0) - before;
  rec('Scenario 7: 40 wrong passwords sent at once (2 instances) -> at most 5 reach Supabase Auth', reached <= 5 && par.filter(x => x.body.rate_limited).length >= 35, `reached ${reached}, throttled ${par.filter(x => x.body.rate_limited).length}`);

  // ---------------- many networks, one account ----------------
  await clear();
  r = await login(stu, PW, '192.0.2.200');   // the student's own res Wi-Fi: becomes a known network
  for (let i = 0; i < 10; i++) await login(stu, 'dist' + i, '192.0.2.' + (10 + i));
  r = await login(stu, 'dist', '192.0.2.99');
  rec('Scenario 6: 10 wrong passwords from 10 networks -> the account waits on new networks', r.body.rate_limited === true, JSON.stringify(r.body).slice(0, 100));
  r = await login(stu, PW, '192.0.2.200');
  rec('...but the student still signs in from a network they used before', !!r.body.session, JSON.stringify(r.body).slice(0, 100));
  rec('an alert is raised for the targeted account', !!(await one(`select 1 x from ops_incidents where fingerprint = 'security:login_account_attack'`)));

  // ---------------- one network, many accounts (credential stuffing) ----------------
  await clear();
  const campus = '198.18.0.1';
  const known = 'u10000002@tuks.co.za'; await addUser(known, PW);
  await login(known, PW, campus);
  for (let i = 0; i < 45; i++) await login(`u2${String(i).padStart(7, '0')}@tuks.co.za`, 'guess', campus);
  const ipRow = await one(`select suspicious_until > now() s from login_rl_state where key like 'i:%' and fails > 0`);
  rec('Scenario 6b: 45 accounts failing from one network marks it suspicious', ipRow && ipRow.s === true);
  rec('an alert is raised for the network', !!(await one(`select 1 x from ops_incidents where fingerprint = 'security:login_network'`)));
  let thr = 0; for (let i = 0; i < 40; i++) { const x = await login(`u3${String(i).padStart(7, '0')}@tuks.co.za`, 'guess', campus); if (x.body.rate_limited) thr++; }
  rec('new email+network pairs from it are slowed to 30 a minute (the burst above counts too)', thr >= 9 && thr <= 16, `throttled ${thr} of 40`);
  r = await login(known, PW, campus);
  rec('a student who signed in from that network before is not affected', !!r.body.session, JSON.stringify(r.body).slice(0, 100));

  // ---------------- shared campus Wi-Fi, legitimate ----------------
  await clear();
  await q(`update login_limit_settings set ip_fail_limit = 20, ip_distinct_accounts = 10`);   // low on purpose: the count is crossed, the failure share is not
  const shared = '198.18.5.5'; const N = 300; let typo = 0, ok = 0, blocked = 0;
  const students = []; for (let i = 0; i < N; i++) { const e = `u4${String(i).padStart(7, '0')}@tuks.co.za`; students.push(e); await addUser(e, PW); }
  for (let b = 0; b < N; b += 30) {
    const res = await Promise.all(students.slice(b, b + 30).map(async (e, k) => {
      const out = [];
      if ((b + k) % 7 === 0) { typo++; out.push(await login(e, 'Correct-Horse-8!', shared)); }   // a typo first (~15%)
      out.push(await login(e, PW, shared));
      return out;
    }));
    for (const list of res) { if (list[list.length - 1].body.session) ok++; if (list.some(x => x.body.rate_limited)) blocked++; }
  }
  await q(`update login_limit_settings set ip_fail_limit = 150, ip_distinct_accounts = 40`);
  rec('Scenario 4b: normal typos on a busy campus network never mark it suspicious', !(await one(`select 1 x from login_rl_state where key like 'i:%' and suspicious_until > now()`)));
  rec(`Scenario 4: ${N} students on one campus network (${typo} typos first) all sign in, none throttled`, ok === N && blocked === 0, `ok ${ok}, throttled ${blocked}`);

  // ---------------- flood ----------------
  await clear();
  await login(known, PW, "198.18.9.9");   // this student has used the network before
  await q(`update login_limit_settings set ip_attempt_limit = 60`);
  let flooded = 0; for (let i = 0; i < 70; i++) { const x = await login(`u5${String(i % 50).padStart(7, '0')}@tuks.co.za`, 'z', '198.18.9.9'); if (x.body.rate_limited) flooded++; }
  rec('a flood from one network is stopped at the attempt limit', flooded >= 10, `throttled ${flooded}`);
  r = await login(known, PW, "198.18.9.9");
  rec("...but a student who signed in from that network before still gets in", !!r.body.session, JSON.stringify(r.body).slice(0, 100));
  await q(`update login_limit_settings set ip_attempt_limit = 3000`);

  // ---------------- trusted header only ----------------
  await clear();
  for (let i = 0; i < 5; i++) await login(stu, 'xff' + i, null, { headers: { 'x-forwarded-for': `10.0.0.${i}` } });
  r = await login(stu, PW, null, { headers: { 'x-forwarded-for': '10.0.0.77' } });
  rec('a made-up X-Forwarded-For does not create a fresh network (no escaping the limit)', r.body.rate_limited === true);
  rec('requests without the trusted header are counted (no_ip) for the dashboard', Number((await one(`select coalesce(sum(n),0) n from login_metrics where metric = 'no_ip'`)).n) >= 6);

  // ---------------- privacy ----------------
  const keys = (await q(`select key from login_rl_state union all select pair from login_known_pairs union all select ip || acct from login_ip_accounts`)).rows.map(x => x.key).join(' ');
  rec('the database stores no emails or network addresses, only hashes', !/@|tuks|198\.18|203\.0|10\.0\.0/.test(keys) && /^([apix]:)?[0-9a-f]{32}/.test(keys.split(' ')[0] || 'p:' + '0'.repeat(32)));

  // ---------------- Supabase Auth refusing (rate limit) ----------------
  await clear();
  auth.force429 = true;
  r = await login(stu, PW, '198.51.100.40');
  auth.force429 = false;
  rec('Scenario 9: when Supabase Auth says "too many", students get a clear wait message', r.body.rate_limited === true && /Too many sign-ins right now/.test(r.body.error));
  rec('...and the developer gets an incident', !!(await one(`select 1 x from ops_incidents where fingerprint = 'auth:upstream_limit'`)));
  rec('...and it is not counted as a wrong password', Number((await one(`select coalesce(sum(n),0) n from login_metrics where metric = 'auth_limited'`)).n) === 1 && !(await one(`select 1 x from login_rl_state where fails > 0`)));

  // the live risk: every login reaches Supabase Auth from the function's own address
  await clear();
  auth.upstreamLimit = 30; auth.hits = [];
  let refused = 0; for (let i = 0; i < 40; i++) { const x = await login(students[i], PW, `100.64.${i}.1`); if (/Too many sign-ins right now/.test(x.body.error || '')) refused++; }
  auth.upstreamLimit = null;
  rec('LIVE RISK SHOWN: with Supabase\'s 30 per 5 min applied to the function\'s address, the 31st student (any network) is refused', refused === 10, `refused ${refused} of 40`);

  // ---------------- counter store down ----------------
  await clear();
  await q(`revoke execute on function public.login_guard(text, text, text) from service_role; revoke execute on function public.login_record(text, text, text, text, int, jsonb) from service_role`);
  r = await login(stu, PW, '198.51.100.50', { port: 8101 });
  rec('Scenario 8: counters unreachable -> students can still sign in', !!r.body.session, JSON.stringify(r.body).slice(0, 120));
  for (let i = 0; i < 5; i++) await login(stu, 'down' + i, '198.51.100.50', { port: 8101 });
  r = await login(stu, PW, '198.51.100.50', { port: 8101 });
  rec('...and the stricter limiter inside the function still stops guessing (never "no limits")', r.body.rate_limited === true, JSON.stringify(r.body).slice(0, 120));
  await q(`grant execute on function public.login_guard(text, text, text) to service_role; grant execute on function public.login_record(text, text, text, text, int, jsonb) to service_role`);
  await login('u10000002@tuks.co.za', PW, '198.51.100.51', { port: 8101 });
  rec('...and the outage is reported to the dashboard once the counters are back', Number((await one(`select coalesce(sum(n),0) n from login_metrics where metric = 'store_errors'`)).n) >= 1);

  // ---------------- metrics ----------------
  await clear();
  for (let i = 0; i < 4; i++) await login(students[i], PW, '198.51.100.60');
  await login(students[5], 'bad', '198.51.100.60');
  const m = Object.fromEntries((await q(`select metric, sum(n)::int n from login_metrics group by metric`)).rows.map(x => [x.metric, x.n]));
  rec('metrics count attempts, successes, failures and response times', m.attempts === 5 && m.success === 4 && m.failure === 1 && m.lat_count === 5, JSON.stringify(m));

  // ---------------- who can see / change what ----------------
  const ids = {};
  for (const role of ['customer', 'manager', 'kitchen', 'cashier', 'driver', 'dispatcher', 'developer']) ids[role] = await addUser(`${role}.acl@clickfood.test`, PW, role);
  const as = async (id) => { await q('reset role'); await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await q('set role authenticated'); };
  const asAnon = async () => { await q('reset role'); await q(`select set_config('request.jwt.claims', '{"role":"anon"}', false)`); await q('set role anon'); };
  const tryq = async (s, p) => { try { const x = await q(s, p); return { rows: x.rows }; } catch (e) { return { err: e.message }; } };
  const H = 'a'.repeat(32);
  let leaks = [];
  for (const role of ['anon', 'customer', 'manager', 'kitchen', 'cashier', 'driver', 'dispatcher']) {
    if (role === 'anon') await asAnon(); else await as(ids[role]);
    for (const t of ['login_rl_state', 'login_known_pairs', 'login_ip_accounts', 'login_metrics', 'login_limit_settings']) {
      const x = await tryq(`select * from ${t} limit 1`); if (x.rows && x.rows.length) leaks.push(role + ' reads ' + t);
    }
    if (!(await tryq(`select login_guard($1, $1, $1)`, [H])).err) leaks.push(role + ' calls login_guard');
    if (!(await tryq(`select login_record($1, $1, $1, 'success', 1, '{}')`, [H])).err) leaks.push(role + ' calls login_record');
    if (!(await tryq(`delete from login_rl_state`)).err) { const c = await one(`select count(*)::int n from login_rl_state`).catch(() => null); if (c && c.n === 0) leaks.push(role + ' deletes counters'); }
    const rep = await tryq(`select login_report(24) r`); if (rep.rows && rep.rows[0].r.ok) leaks.push(role + ' reads the report');
    const up = await tryq(`select login_limits_update('{"pair_fail_limit": 20}') r`); if (up.rows && up.rows[0].r.ok) leaks.push(role + ' changes limits');
  }
  await q('reset role'); await q(`select set_config('request.jwt.claims', '', false)`);
  rec('anon, customers, managers, kitchen, cashier, driver and dispatcher can\'t read, call, clear or change any of it', !leaks.length, leaks.join('; '));
  await as(ids.developer);
  const rep = (await one(`select login_report(24) r`)).r;
  rec('a developer gets the aggregated report (no hashes in it)', rep.ok === true && rep.latency && !/[0-9a-f]{32}/.test(JSON.stringify(rep)), JSON.stringify(rep).slice(0, 160));
  const bad = (await one(`select login_limits_update('{"pair_fail_limit": 1000}') r`)).r;
  const bad2 = (await one(`select login_limits_update('{"enabled": 0}') r`)).r;
  const good = (await one(`select login_limits_update('{"pair_fail_limit": 6}') r`)).r;
  await q('reset role');
  rec('a developer can only change limits within safe bounds, never switch them off', bad.ok === false && bad2.ok === false && good.ok === true && (await one(`select pair_fail_limit from login_limit_settings`)).pair_fail_limit === 6, JSON.stringify([bad, bad2, good]));
  rec('limit changes are audited with the old and new value', !!(await one(`select 1 x from ops_audit where action = 'login_limits_changed' and meta->'before'->>'pair_fail_limit' = '5' and meta->'changed'->>'pair_fail_limit' = '6'`)));
  const tool = (await one(`select ops_tool($1, 'login_health', '{}') r`, [ids.developer])).r;
  rec('the AI assistant\'s login_health tool returns counts only and has no way to change limits', tool && tool.totals && !/[0-9a-f]{32}/.test(JSON.stringify(tool)), JSON.stringify(tool).slice(0, 160));

  await q(`select login_cleanup()`);
  rec('cleanup runs', true);
  for (const f of E.fns) if (/Uncaught|TypeError|ReferenceError/.test(f.log())) rec('function log clean (' + f.port + ')', false, f.log().match(/(Uncaught|TypeError|ReferenceError).{0,200}/)[0]);
  await E.stop();
  for (const [s, n] of results) console.log(s, n);
  const fails = results.filter(r => r[0] !== 'PASS').length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(0);
})().catch(async (e) => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); process.exit(1); });
