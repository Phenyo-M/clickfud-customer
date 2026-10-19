// Access matrix for the monitoring, AI assistant and login protection data.
// Reproduces Supabase's default privileges (every new table and function is
// granted to anon + authenticated unless revoked, confirmed on the live
// project 2026-10-16), then checks every role against every table and every
// function. Synthetic data only.
//   NODE_PATH=backend/tests/lt/node_modules node backend/tests/ops-access-test.cjs
const path = require('path'); const fs = require('fs');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');
const PORT = 55591, DIR = path.join(LT, 'cfaccess');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x ? ` (${String(x).slice(0, 400)})` : '')]);

(async () => {
  const db = await build(PORT, DIR); const q = (s, p) => db.query(s, p); const one = async (s, p) => (await q(s, p)).rows[0];
  const admin = async () => q(`reset role; select set_config('request.jwt.claims', '', false); select set_config('request.headers', '', false)`);
  await admin();
  await q(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
           alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
           alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  await q(`create table if not exists cron.job (jobid bigint primary key, jobname text, schedule text);
           create table if not exists cron.job_run_details (jobid bigint, status text, start_time timestamptz, end_time timestamptz, return_message text);
           create table if not exists net._http_response (id bigint generated always as identity, status_code int, error_msg text, timed_out boolean default false, created timestamptz default now());`);
  for (const f of ['student_sellers.sql', 'seller_review_address.sql', 'approval_emails.sql', 'notification_links.sql', 'student_collection_times.sql', 'student_order_codes.sql', 'notification_queue.sql', 'ops_monitoring.sql', 'login_protection.sql']) await q(SQL(f));

  const roles = ['customer', 'manager', 'kitchen', 'cashier', 'driver', 'dispatcher', 'devA', 'devB', 'devNoPerm'];
  const id = {}; let n = 1;
  await q(`set session_replication_role = replica`);
  for (const r of roles) {
    id[r] = `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`;
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id[r], r.toLowerCase() + '@clickfood.test']);
    await q(`insert into profiles (id, name, email, role, status, active) values ($1, $2, $3, $4, 'approved', true)`, [id[r], r, r.toLowerCase() + '@clickfood.test', r.startsWith('dev') ? 'developer' : r]);
  }
  await q(`set session_replication_role = origin`);
  await q(`insert into ops_permissions (user_id, can_view, can_approve, can_chat) values ($1, false, false, false)`, [id.devNoPerm]);

  // ---- seed one of everything ----
  const inc = (await one(`select ops_signal('test:access', 'orders', 'high', 'Order flow', 'Test incident', 'x', '{}') i`)).i;
  await q(`select ops_request_recovery($1, 'retry_dead_notifications', 'ai', 'test')`, [inc]);
  await q(`select ops_save_report($1, true, '{"root_cause":"x"}', 'm', 1, 1, null)`, [inc]);
  await q(`insert into ops_function_config (id, investigate_url, secret) values (1, 'http://x', 'super-secret-worker-key') on conflict (id) do update set secret = excluded.secret`).catch(async () => {
    const cols = (await q(`select column_name from information_schema.columns where table_name = 'ops_function_config'`)).rows.map(r => r.column_name);
    throw new Error('ops_function_config columns: ' + cols.join(','));
  });
  await q(`select rl_hit('ip:abc', 'login', 1, 60); select rl_hit('ip:abc', 'login', 1, 60)`);
  await q(`select login_guard($1, $2, $3)`, ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)]);
  await q(`select login_record($1, $2, $3, 'failure', 10, '{}')`, ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)]);
  const conv = (await one(`insert into ai_conversations (developer_id, title) values ($1, 'B private chat') returning id`, [id.devB])).id;
  await q(`insert into ai_messages (conversation_id, role, content) values ($1, 'user', 'devB secret question')`, [conv]);
  await q(`select ops_record_usage('assistant', 10, 10, 0, null)`);
  await q(`select ops_run_checks()`);

  const tables = (await q(`select tablename t from pg_tables where schemaname = 'public' and (tablename like 'ops\\_%' or tablename like 'rl\\_%' or tablename like 'login\\_%' or tablename like 'ai\\_%' or tablename = 'security_events') order by 1`)).rows.map(r => r.t);
  const counts = {}; for (const t of tables) counts[t] = (await one(`select count(*)::int n from ${t}`)).n;
  const fns = (await q(`select p.oid::regprocedure::text sig, p.proname, pg_get_function_identity_arguments(p.oid) args, p.pronargs
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and (p.proname like 'ops\\_%' or p.proname like 'rl\\_%' or p.proname like 'login\\_%') order by 1`)).rows;
  const PUBLIC_FNS = new Set(['ops_report_client_error', 'ops_redact', 'ops_sev_rank', 'ops_client_key', 'ops_can', 'login_pctl']);   // harmless or meant for everyone
  const SELF_CHECKING = new Set(['ops_dev', 'login_report', 'login_limits_update']);   // callable, refuse inside unless permitted
  const DEV_READ = new Set(['ops_settings', 'ops_permissions', 'ops_incidents', 'ops_events', 'ops_reports', 'ops_actions', 'ops_recovery_attempts', 'ops_audit', 'ops_ai_usage', 'ops_check_runs', 'security_events', 'login_metrics', 'login_limit_settings']);

  const as = async (who) => {
    await q('reset role');
    if (who === 'anon') { await q(`select set_config('request.jwt.claims', '{"role":"anon"}', false)`); await q('set role anon'); return; }
    await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id[who], role: 'authenticated' })]); await q('set role authenticated');
  };
  const tryq = async (s, p) => { try { await q('savepoint sp'); const x = await q(s, p); await q('release savepoint sp'); return { rows: x.rows, count: x.rowCount }; } catch (e) { try { await q('rollback to savepoint sp'); } catch (_) {} return { err: e.message }; } };
  await q('begin');
  const problems = {};
  for (const who of ['anon', 'customer', 'manager', 'kitchen', 'cashier', 'driver', 'dispatcher', 'devNoPerm', 'devA']) {
    await as(who); const bad = []; const isDev = who === 'devA';
    for (const t of tables) {
      const sel = await tryq(`select * from ${t}`);
      const readable = sel.rows && sel.rows.length > 0;
      if (readable && !(isDev && DEV_READ.has(t)) && !(isDev && t === 'ai_conversations' && sel.rows.every(r => r.developer_id === id.devA))) bad.push('reads ' + t);
      if (isDev && t === 'ai_messages' && readable) bad.push('reads another developer\'s messages');
      const ins = await tryq(`insert into ${t} default values`); if (!ins.err) bad.push('inserts into ' + t);
      const up = await tryq(`update ${t} set ${t === 'login_metrics' ? 'n = n' : 'ctid = ctid'} where false`); // privilege check only
      if (!up.err && !/ctid/.test(up.err || '')) { const u2 = await tryq(`delete from ${t}`); if (!u2.err && u2.count > 0) bad.push('deletes from ' + t); }
      else { const u2 = await tryq(`delete from ${t}`); if (!u2.err && u2.count > 0) bad.push('deletes from ' + t); }
    }
    for (const f of fns) {
      if (PUBLIC_FNS.has(f.proname)) continue;
      const call = `select ${f.sig.replace(/\(.*$/, '')}(${Array.from({ length: f.pronargs }, () => 'null').join(', ')})`;
      const r = await tryq(call);
      const denied = r.err && /permission denied/.test(r.err);
      if (SELF_CHECKING.has(f.proname)) {
        if (!r.err) { const v = Object.values(r.rows[0])[0]; if (v && v.ok !== false && !(isDev && f.proname === 'login_report')) bad.push(f.proname + ' answered ' + JSON.stringify(v).slice(0, 60)); }
      } else if (!denied) bad.push('can call ' + f.proname + (r.err ? ' (' + r.err.slice(0, 50) + ')' : ''));
    }
    problems[who] = bad;
  }
  await q('rollback');
  await admin();
  for (const [who, bad] of Object.entries(problems)) rec(`${who}: no access beyond what the role needs`, !bad.length, bad.join('; '));
  const after = {}; for (const t of tables) after[t] = (await one(`select count(*)::int n from ${t}`)).n;
  rec('nothing was changed by any of the attempts', JSON.stringify(after) === JSON.stringify(counts), JSON.stringify(Object.keys(after).filter(t => after[t] !== counts[t])));
  rec(`checked ${tables.length} tables and ${fns.length} functions for 9 roles`, tables.length >= 20 && fns.length >= 30, tables.length + ' / ' + fns.length);

  // devA specifically
  await q('begin');
  await as('devA');
  const cfg = await tryq(`select secret from ops_function_config`);
  rec('a developer cannot read the worker secret', (!!cfg.err && /permission denied/.test(cfg.err)) || (cfg.rows && !cfg.rows.length), cfg.err);
  const other = await tryq(`select * from ai_messages where content like '%devB%'`);
  rec('a developer cannot read another developer\'s assistant messages', !!(other.rows && !other.rows.length), other.err);
  const del = await tryq(`delete from ai_conversations where id = $1`, [conv]);
  rec('a developer cannot delete another developer\'s conversation', !del.err && del.count === 0, del.err);
  const ok = await tryq(`select count(*)::int n from ops_incidents`);
  rec('a developer with permission reads incidents', ok.rows && ok.rows[0].n >= 1);
  await as('devNoPerm');
  const np = await tryq(`select ops_dev('run_checks', null, '{}') r`);
  rec('a developer whose permission was removed is refused by ops_dev', np.rows && np.rows[0].r.ok === false);
  await q('rollback');
  await admin();

  await db.end();
  try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {}
  for (const [s, nme] of results) console.log(s, nme);
  const fails = results.filter(r => r[0] !== 'PASS').length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
