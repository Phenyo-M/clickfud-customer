// Local stand-in "staging" for login tests: a local copy of the database
// (embedded Postgres + PostgREST), the REAL secure-login function running in
// Deno (one or more instances), and a stand-in for Supabase Auth's password
// endpoint. Synthetic accounts only; nothing here talks to the live project.
//
// The Auth stand-in can also imitate Supabase's per-address sign-in limit
// (live setting: 30 per 5 minutes). Every function instance reaches it from
// the same local address, the way the deployed function reaches Supabase
// Auth from Supabase's own servers.
const path = require('path'); const fs = require('fs'); const http = require('http'); const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { build, BIN, LT } = require('./load/build-db.cjs');

const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const kill = (p) => { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { try { p.kill(); } catch (__) {} } };

async function startEnv(opts) {
  const o = Object.assign({ fnName: 'secure-login', pg: 55571, pgrst: 3461, gw: 3462, fnPorts: [8101], dir: 'cflogin', dbPool: 10, authLatencyMs: 80 }, opts || {});
  const SECRET = 'local-login-secret-not-used-anywhere-else-0123456789abcdef';
  const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const jwt = (c) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ exp: Math.floor(Date.now() / 1000) + 7200, ...c }); return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
  const procs = [];
  const DIR = path.join(LT, o.dir);
  const db = await build(o.pg, DIR);
  const q = (s, p) => db.query(s, p);
  await q(`reset role; select set_config('request.jwt.claims', '', false)`);
  await q(`create table if not exists cron.job (jobid bigint primary key, jobname text, schedule text);
           create table if not exists cron.job_run_details (jobid bigint, status text, start_time timestamptz, end_time timestamptz, return_message text);
           create table if not exists net._http_response (id bigint generated always as identity, status_code int, error_msg text, timed_out boolean default false, created timestamptz default now());`);
  for (const f of ['student_sellers.sql', 'seller_review_address.sql', 'student_application_details.sql', 'student_number_from_email.sql', 'allowed_domains.sql',
                   'approval_emails.sql', 'notification_links.sql', 'student_collection_times.sql', 'student_order_codes.sql', 'notification_queue.sql', 'shop_test_mode.sql', 'ops_monitoring.sql', 'login_protection.sql']) await q(SQL(f));
  await q(`grant usage on schema public to anon, authenticated, service_role; grant all on all tables in schema public to service_role; grant usage, select on all sequences in schema public to service_role;`);

  // ---- stand-in for Supabase Auth (password grant) ----
  const users = new Map();   // email -> { id, password, confirmed }
  const auth = { calls: 0, perEmail: new Map(), upstreamLimit: null, upstreamWindowMs: 300000, hits: [], force429: false, latencyMs: o.authLatencyMs, inflight: 0, maxInflight: 0 };
  const authToken = async (req, res, raw) => {
    auth.calls++; auth.inflight++; auth.maxInflight = Math.max(auth.maxInflight, auth.inflight);
    const send = (st, b) => { auth.inflight--; res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    let body = {}; try { body = JSON.parse(raw.toString() || '{}'); } catch (_) {}
    const email = String(body.email || '').toLowerCase();
    auth.perEmail.set(email, (auth.perEmail.get(email) || 0) + 1);
    if (auth.force429) return send(429, { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' });
    if (auth.upstreamLimit) {
      const now = Date.now(); auth.hits = auth.hits.filter(t => t > now - auth.upstreamWindowMs);
      if (auth.hits.length >= auth.upstreamLimit) return send(429, { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' });
      auth.hits.push(now);
    }
    await sleep(auth.latencyMs);   // password hashing time
    const u = users.get(email);
    if (!u || u.password !== body.password) return send(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
    if (!u.confirmed) return send(400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
    const t = jwt({ sub: u.id, role: 'authenticated', email, aud: 'authenticated' });
    return send(200, { access_token: t, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r-' + u.id,
      user: { id: u.id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } });
  };

  // ---- PostgREST + gateway ----
  const conf = path.join(LT, `pgrst-${o.dir}.conf`);
  fs.writeFileSync(conf, `db-uri = "postgres://authenticator:authpw@127.0.0.1:${o.pg}/postgres"\ndb-schemas = "public"\ndb-anon-role = "anon"\njwt-secret = "${SECRET}"\nserver-port = ${o.pgrst}\ndb-pool = ${o.dbPool}\nlog-level = "error"\n`);
  const pg = spawn(path.join(LT, 'postgrest/postgrest.exe'), [conf], { env: { ...process.env, PATH: BIN + ';' + process.env.PATH } }); procs.push(pg);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  const gw = http.createServer((req, res) => { const ch = []; req.on('data', d => ch.push(d)); req.on('end', () => {
    const raw = Buffer.concat(ch);
    if (req.url.startsWith('/auth/v1/token')) return authToken(req, res, raw);
    if (req.url.startsWith('/auth/v1/user')) {   // who is this token? (functions that check the caller)
      try { const [h, p, sg] = (req.headers.authorization || '').replace(/^Bearer /, '').split('.'); if (crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64url') !== sg) throw 0;
        const c = JSON.parse(Buffer.from(p, 'base64url').toString()); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: c.sub, aud: 'authenticated', role: 'authenticated', email: c.email })); }
      catch (e) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"msg":"invalid token"}'); }
    }
    if (!req.url.startsWith('/rest/v1/')) { res.writeHead(404); return res.end(); }
    const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
    const up = http.request({ host: '127.0.0.1', port: o.pgrst, path: req.url.slice(8), method: req.method, headers, agent }, (r2) => { res.writeHead(r2.statusCode, r2.headers); r2.pipe(res); });
    up.on('error', e => { res.writeHead(502); res.end(String(e)); }); up.end(raw);
  }); });
  gw.keepAliveTimeout = 60000;
  await new Promise(r => gw.listen(o.gw, r));
  for (let i = 0; i < 75; i++) { try { await fetch(`http://127.0.0.1:${o.pgrst}/`); break; } catch { await sleep(200); } }

  // ---- the real function, N instances ----
  const env = { ...process.env, SUPABASE_URL: `http://127.0.0.1:${o.gw}`, SUPABASE_SERVICE_ROLE_KEY: jwt({ role: 'service_role' }), SUPABASE_ANON_KEY: jwt({ role: 'anon' }), ...(o.env || {}) };
  const fns = [];
  for (const port of o.fnPorts) {
    const p = spawn(process.env.DENO_BIN || 'deno', ['run', '-A', path.join(__dirname, 'fn-port.ts')],
      { env: { ...env, FN_PORT: String(port), FN_ENTRY: pathToFileURL(path.join(__dirname, '../supabase/functions/' + o.fnName + '/index.ts')).href } });
    procs.push(p); let log = ''; p.stderr.on('data', d => { log += d; if (log.length > 200000) log = log.slice(-100000); }); p.stdout.on('data', d => { log += d; });
    for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/`, { method: 'OPTIONS' }); break; } catch { await sleep(300); } }
    fns.push({ port, log: () => log });
  }

  // a login as the browser would send it; `ip` plays Cloudflare's cf-connecting-ip
  const fnAgent = new http.Agent({ keepAlive: true, maxSockets: 2048 });
  let rr = 0;
  function login(email, password, ip, extra) {
    const port = (extra && extra.port) || o.fnPorts[rr++ % o.fnPorts.length];
    const body = JSON.stringify({ email, password, app: (extra && extra.app) || 'customer' });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (ip) headers['cf-connecting-ip'] = ip;
    if (extra && extra.headers) Object.assign(headers, extra.headers);
    const t0 = Date.now();
    return new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/', method: 'POST', headers, agent: fnAgent, timeout: (extra && extra.timeout) || 20000 }, (res) => {
        const ch = []; res.on('data', d => ch.push(d)); res.on('end', () => {
          let j = {}; try { j = JSON.parse(Buffer.concat(ch).toString()); } catch (_) {}
          resolve({ status: res.statusCode, body: j, ms: Date.now() - t0 });
        });
      });
      r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: { error: 'timeout' }, ms: Date.now() - t0 }); });
      r.on('error', (e) => resolve({ status: 0, body: { error: String(e) }, ms: Date.now() - t0 }));
      r.end(body);
    });
  }

  async function addUser(email, password, role, confirmed) {
    const id = crypto.randomUUID();
    users.set(email.toLowerCase(), { id, password, confirmed: confirmed !== false });
    await q(`set session_replication_role = replica`);
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, email.toLowerCase()]);
    await q(`insert into profiles (id, name, email, role, status, active) values ($1, $2, $3, $4, 'approved', true)`, [id, 'Test ' + id.slice(0, 4), email.toLowerCase(), role || 'customer']);
    await q(`set session_replication_role = origin`);
    return id;
  }

  async function stop() {
    for (const p of procs) kill(p);
    gw.close(); agent.destroy(); fnAgent.destroy();
    try { await db.end(); } catch (_) {}
    try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {}
  }
  return { q, db, jwt, auth, users, addUser, login, fns, stop, o, pgrstUrl: `http://127.0.0.1:${o.pgrst}` };
}

module.exports = { startEnv, sleep };
