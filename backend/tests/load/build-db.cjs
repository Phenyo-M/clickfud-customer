// Builds a LOCAL Postgres copy of ClickFood's live structure (no data).
// Exported by export-schema.sql. Usage: node build-db.cjs <port> <datadir>
const { execFileSync } = require('child_process');
const fs = require('fs'); const path = require('path'); const { Client } = require('pg');
const LT = path.join(__dirname, '../lt');
const BIN = path.join(LT, 'node_modules/@embedded-postgres/windows-x64/native/bin');

async function build(port, dataDir) {
  if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(LT, 'cfpw.txt'), 'postgres');
  execFileSync(path.join(BIN, 'initdb.exe'), ['-D', dataDir, '-U', 'postgres', '--pwfile', path.join(LT, 'cfpw.txt'), '-A', 'md5', '-E', 'UTF8'], { stdio: 'ignore' });
  fs.appendFileSync(path.join(dataDir, 'postgresql.conf'), '\nmax_connections = 200\nshared_buffers = 256MB\n');
  execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', dataDir, '-o', `-p ${port}`, '-l', path.join(dataDir, '..', path.basename(dataDir) + '.log'), 'start', '-w'], { stdio: 'ignore' });
  const db = new Client({ host: 'localhost', port, user: 'postgres', password: 'postgres', database: 'postgres' });
  await db.connect();
  const r = require('./schema-export.json')[0].r;
  const steps = [
    ['roles + auth stubs', `create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create role authenticator login password 'authpw' noinherit; grant anon, authenticated, service_role to authenticator;
      create role supabase_auth_admin nologin; create role supabase_admin nologin; create role postgres_fdw nologin;
      create schema auth; create schema extensions; create schema net; create schema cron; create schema storage;
      grant usage on schema public, auth, extensions to anon, authenticated, service_role;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}', email_confirmed_at timestamptz, created_at timestamptz default now());
      create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid, status text);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'sub', '')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::json->>'role' $$;
      create function auth.email() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::json->>'email' $$;
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
      create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 1000) returns bigint language sql as $$ select 1::bigint $$;
      create extension if not exists pgcrypto with schema extensions;
      set check_function_bodies = off;`],
    ['types', r.types], ['sequences', r.seqs], ['tables', r.tables], ['functions', r.funcs], ['views', r.views],
    ['constraints', r.cons], ['indexes', r.idx], ['triggers', r.trg], ['rls', r.rls], ['policies', r.pol],
    ['grants', `grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
      grant usage, select on all sequences in schema public to anon, authenticated, service_role;
      grant execute on all functions in schema public to anon, authenticated, service_role;`],
    // re-apply the live grants that matter for the tests (revokes done on live)
    ['live revokes', fs.readFileSync(path.join(__dirname, '../../supabase/security_phase1.sql'), 'utf8') + `
      revoke all on function public.finalize_paystack_checkout(text) from public, anon, authenticated;
      revoke all on function public.apply_payfast_payment(text, text, numeric, text) from public, anon, authenticated;`],
  ];
  const problems = [];
  for (const [name, sql] of steps) {
    if (!sql) continue;
    try { await db.query('set check_function_bodies = off; ' + sql); }
    catch (e) {
      // fall back to statement by statement so one oddity doesn't stop the build
      const parts = name === 'functions' ? sql.split(/;\n\n(?=CREATE OR REPLACE)/) : sql.split(/;\n/);
      let bad = 0;
      for (const p of parts) { try { await db.query('set check_function_bodies = off; ' + p); } catch (e2) { bad++; if (problems.length < 25) problems.push(`${name}: ${e2.message.slice(0, 140)}`); } }
      console.log(`${name}: ${parts.length - bad}/${parts.length} statements ok`);
      continue;
    }
    console.log(`${name}: ok`);
  }
  if (problems.length) console.log('problems:\n  ' + problems.join('\n  '));
  return db;
}
module.exports = { build, BIN, LT };
if (require.main === module) {
  build(Number(process.argv[2] || 55460), process.argv[3] || path.join(LT, 'cfload')).then(async (db) => {
    const c = await db.query(`select (select count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r') tables, (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal) triggers, (select count(*) from pg_policies where schemaname='public') policies`);
    console.log(c.rows[0]); await db.end();
    execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', process.argv[3] || path.join(LT, 'cfload'), 'stop', '-m', 'fast'], { stdio: 'ignore' });
  }).catch((e) => { console.error(e); process.exit(1); });
}
