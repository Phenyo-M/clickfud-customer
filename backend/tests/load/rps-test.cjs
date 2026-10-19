// Requests-per-second load test (LOCAL stand-in for staging; never production).
//
// What runs: a local copy of the database (embedded Postgres + PostgREST,
// pool 10), 4 instances of the real secure-login function, a stand-in for
// Supabase Auth (80 ms per password check), synthetic campus data.
// Traffic replays the exact requests the real customer app sends
// (app-requests.json, captured from the app itself).
//
// Open model: requests are STARTED at the target rate whatever the replies
// do, so slow replies show up as latency and backlog instead of quietly
// lowering the rate. RPS here = HTTP requests started per second; it is NOT
// a number of users.
//
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/load/rps-test.cjs [quick]
const path = require('path'); const fs = require('fs'); const http = require('http'); const os = require('os');
const { startEnv, sleep } = require('../login-env.cjs');
const { seedApp } = require('./seed-app.cjs');

const QUICK = process.argv.includes('quick');
const ONLY = ((process.argv.find(a => a.startsWith('only=')) || '').slice(5)) || 'ABC';
const SUSTAIN_S = QUICK ? 60 : 15 * 60;
const STEP_S = QUICK ? 20 : 60;
const STOP = { errorRate: 0.05, p95ms: 5000, backlog: 3000, rssMB: 3000 };   // safety limits per 10 s window
const PW = 'Correct-Horse-9!';
const reqs = JSON.parse(fs.readFileSync(path.join(__dirname, 'app-requests.json'), 'utf8'));

(async () => {
  const E = await startEnv({ fnPorts: [8121, 8122, 8123, 8124], dir: 'cfrps', pg: 55611, pgrst: 3491, gw: 3492, dbPool: 10, authLatencyMs: 80 });
  const seed = await seedApp(E.q, { stores: 40, itemsPerStore: 25, students: 3000, orders: 30000 });
  for (const s of seed.students) E.users.set(s.email, { id: s.id, password: PW, confirmed: true });
  const tokens = seed.students.map(s => ({ id: s.id, email: s.email, jwt: E.jwt({ sub: s.id, role: 'authenticated', email: s.email, aud: 'authenticated' }) }));
  const ANON = E.jwt({ role: 'anon' });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1024 });

  // ---------- one request ----------
  let inflight = 0;
  function send(port, method, p, body, headers) {
    inflight++;
    const t0 = process.hrtime.bigint();
    return new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent, timeout: 15000 }, (res) => {
        const ch = []; res.on('data', d => ch.push(d)); res.on('end', () => { inflight--; resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6, body: Buffer.concat(ch) }); });
      });
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', (e) => { inflight--; resolve({ status: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, err: String(e.message || e) }); });
      if (body) r.end(body); else r.end();
    });
  }
  const pgrst = (r, tok) => {
    const headers = { Authorization: 'Bearer ' + (r.auth === 'user' ? tok.jwt : ANON), Accept: 'application/json' };
    if (r.prefer) headers.Prefer = r.prefer;
    const p = r.path.replace(/^\/rest\/v1/, '').split('{{UID}}').join(tok ? tok.id : '');
    if (r.body) headers['Content-Type'] = 'application/json';
    return send(E.o.pgrst, r.method, p, r.body ? r.body.split('{{UID}}').join(tok ? tok.id : '') : null, headers);
  };
  const campusIps = ['198.18.10.1', '198.18.10.2', '198.18.20.1', '198.18.30.1', '198.18.40.1'];
  let rr = 0;
  const loginReq = (email, password, ip) => {
    const body = JSON.stringify({ email, password, app: 'customer' });
    const port = E.o.fnPorts[rr++ % E.o.fnPorts.length];
    return send(port, 'POST', '/', body, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'cf-connecting-ip': ip });
  };

  // ---------- traffic types (each returns a list of request promises) ----------
  // app: what a phone does when a student opens the app or comes back to it
  const appUnit = () => {
    const x = Math.random(); const tok = tokens[(Math.random() * tokens.length) | 0];
    if (x < 0.5) return reqs.student_open.map(r => ({ kind: 'app', p: pgrst(r, tok) }));                        // signed-in open: 15 calls
    if (x < 0.75) return reqs.guest_open.map(r => ({ kind: 'app', p: pgrst(r, null) }));                        // guest open: 9 calls
    return reqs.student_open.filter(r => /\/(orders|notifications)\?/.test(r.path)).map(r => ({ kind: 'app', p: pgrst(r, tok) }));   // back to check an order: 2
  };
  // login: legitimate students, mostly on a few campus networks (shared Wi-Fi)
  const loginUnit = () => {
    const tok = tokens[(Math.random() * tokens.length) | 0];
    const ip = Math.random() < 0.7 ? campusIps[(Math.random() * campusIps.length) | 0] : `100.${64 + ((Math.random() * 60) | 0)}.${(Math.random() * 255) | 0}.${1 + ((Math.random() * 250) | 0)}`;
    const typo = Math.random() < 0.08;
    return [{ kind: typo ? 'login_typo' : 'login', p: loginReq(tok.email, typo ? 'Correct-Horse-8!' : PW, ip) }];
  };
  // abuse: credential stuffing from one network + guessing one account from many
  let stuffN = 0, distN = 0;
  const stuffUnit = () => [{ kind: 'abuse_stuffing', p: loginReq(`u9${String(stuffN++ % 100000).padStart(7, '0')}@tuks.co.za`, 'Password1!', '203.0.113.66') }];
  const distUnit = () => [{ kind: 'abuse_distributed', p: loginReq(tokens[0].email, 'guess' + distN, `192.0.2.${(distN++ % 250) + 1}`) }];

  // ---------- run a step at a request rate ----------
  const steps = [];
  let stopped = null;
  async function step(name, seconds, mix) {
    // mix: [{ unit, rps }] where rps counts HTTP requests
    const st = { name, seconds, target_rps: mix.reduce((a, m) => a + m.rps, 0), started: 0, byKind: {}, windows: [], stopped: null };
    const results = [];
    const cpu0 = os.cpus().map(c => c.times);
    const tStart = Date.now();
    const db0 = (await E.q(`select xact_commit + xact_rollback x from pg_stat_database where datname = current_database()`)).rows[0].x;
    let maxConn = 0;
    const connTimer = setInterval(async () => { try { const n = (await E.q(`select count(*)::int n from pg_stat_activity where datname = current_database() and state = 'active'`)).rows[0].n; maxConn = Math.max(maxConn, n); } catch (_) {} }, 1000);
    // per-unit request counts, to turn request rates into unit rates
    const sizes = new Map();
    for (const m of mix) { if (!sizes.has(m.unit)) { sizes.set(m.unit, m.size || 1); } }
    const acc = mix.map(() => 0);
    let lastWin = Date.now(); let winResults = [];
    const tick = 20;   // ms (Windows timers are coarser; the real elapsed time is used)
    let lastTick = Date.now();
    while (Date.now() - tStart < seconds * 1000) {
      const nowT = Date.now(); const dt = nowT - lastTick; lastTick = nowT;
      for (let i = 0; i < mix.length; i++) {
        acc[i] += mix[i].rps / (mix[i].size || 1) * dt / 1000;
        while (acc[i] >= 1) {
          acc[i] -= 1;
          for (const u of mix[i].unit()) {
            st.started++;
            u.p.then((r) => { const row = { kind: u.kind, status: r.status, ms: r.ms, body: u.kind.startsWith('login') || u.kind.startsWith('abuse') ? r.body : null, err: r.err }; results.push(row); winResults.push(row); });
          }
        }
      }
      await sleep(tick);
      if (Date.now() - lastWin >= 10000) {
        const w = summarize(winResults.filter(x => x.kind === 'app' || x.kind === 'login'));
        w.backlog = inflight; w.rssMB = Math.round(process.memoryUsage().rss / 1048576);
        st.windows.push(w); winResults = []; lastWin = Date.now();
        const why = w.count && (w.errorRate > STOP.errorRate ? `error rate ${(w.errorRate * 100).toFixed(1)}%` : w.p95 > STOP.p95ms ? `p95 ${w.p95} ms` : null)
          || (inflight > STOP.backlog ? `backlog ${inflight}` : null) || (w.rssMB > STOP.rssMB ? `memory ${w.rssMB} MB` : null);
        if (why) { st.stopped = why; stopped = `${name}: ${why}`; console.log('SAFETY STOP', name, why); break; }
      }
    }
    const elapsed = (Date.now() - tStart) / 1000;
    for (let i = 0; i < 300 && inflight > 0; i++) await sleep(100);   // let replies finish (max 30 s)
    clearInterval(connTimer);
    const cpu1 = os.cpus().map(c => c.times);
    let busy = 0, all = 0; cpu1.forEach((t, i) => { const d = (k) => t[k] - cpu0[i][k]; const tot = d('user') + d('nice') + d('sys') + d('idle') + d('irq'); all += tot; busy += tot - d('idle'); });
    const db1 = (await E.q(`select xact_commit + xact_rollback x from pg_stat_database where datname = current_database()`)).rows[0].x;
    st.elapsed_s = Math.round(elapsed);
    st.achieved_rps = +(st.started / elapsed).toFixed(1);
    st.completed_rps = +(results.length / elapsed).toFixed(1);
    st.machine_cpu_pct = Math.round(busy / all * 100);
    st.db_tx_per_s = Math.round((Number(db1) - Number(db0)) / elapsed);
    st.db_max_active_connections = maxConn;
    for (const k of [...new Set(results.map(r => r.kind))]) st.byKind[k] = summarize(results.filter(r => r.kind === k));
    st.unfinished = inflight;
    steps.push(st);
    const a = st.byKind.app || st.byKind.login || {};
    console.log(`${name.padEnd(28)} target ${String(st.target_rps).padStart(4)} achieved ${String(st.achieved_rps).padStart(6)} rps | ` +
      Object.entries(st.byKind).map(([k, v]) => `${k}: n=${v.count} p50=${v.p50} p95=${v.p95} p99=${v.p99} err=${(v.errorRate * 100).toFixed(2)}% 429=${v.s429} wait=${v.throttled}`).join(' ; ') +
      ` | cpu ${st.machine_cpu_pct}% db ${st.db_tx_per_s} tx/s conn ${st.db_max_active_connections}${st.stopped ? ' | STOPPED ' + st.stopped : ''}`);
    return st;
  }
  function pct(a, q) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.ceil(s.length * q) - 1)]); }
  function summarize(rows) {
    const ms = rows.map(r => r.ms);
    let throttled = 0, signedIn = 0, wrong = 0, other = 0, errors = 0;
    for (const r of rows) {
      let b = null; if (r.body) { try { b = JSON.parse(r.body.toString()); } catch (_) {} }
      const ok = r.status >= 200 && r.status < 300;
      if (!ok) errors++;
      if (b) { if (b.rate_limited) throttled++; else if (b.session) signedIn++; else if (b.error === 'Invalid login credentials') wrong++; else other++; }
    }
    return { count: rows.length, p50: pct(ms, 0.5), p95: pct(ms, 0.95), p99: pct(ms, 0.99), max: ms.length ? Math.round(Math.max(...ms)) : null,
      errorRate: rows.length ? errors / rows.length : 0, s429: rows.filter(r => r.status === 429).length, timeouts: rows.filter(r => r.status === 0).length, throttled, signedIn, wrong, other };
  }

  const appSize = 0.5 * reqs.student_open.length + 0.25 * reqs.guest_open.length + 0.25 * 2;
  const app = (rps) => ({ unit: appUnit, rps, size: appSize });
  const lg = (rps) => ({ unit: loginUnit, rps, size: 1 });
  console.log(`app mix: ${appSize.toFixed(2)} requests per visit on average; ${tokens.length} students, ${seed.items.length} menu items, 30000 past orders`);
  await sleep(2000);

  // ---------- A. ordinary app traffic ----------
  if (ONLY.includes('A')) for (const r of [10, 25, 50, 75, 100]) { if (stopped) break; await step(`A app ramp ${r}`, STEP_S, [app(r)]); }
  if (ONLY.includes('A') && !stopped) await step(`A app sustain 100 (${SUSTAIN_S / 60} min)`, SUSTAIN_S, [app(100)]);
  if (ONLY.includes('A')) for (const r of [150, 200, 300]) { if (stopped) break; await step(`A app burst ${r} (30 s)`, 30, [app(r)]); if (!stopped) await step('A app recover 100', 30, [app(100)]); }
  const appStopped = stopped; stopped = null;

  // ---------- B. login traffic on its own (with attackers alongside) ----------
  await E.q(`delete from login_rl_state; delete from login_ip_accounts; delete from login_known_pairs; delete from login_metrics`);
  if (ONLY.includes('B')) for (const r of [10, 25, 50, 75, 100]) { if (stopped) break; await step(`B login ramp ${r}`, STEP_S, [lg(r), { unit: stuffUnit, rps: 5 }, { unit: distUnit, rps: 1 }]); }
  if (ONLY.includes('B') && !stopped) await step('B login burst 150 (30 s)', 30, [lg(150), { unit: stuffUnit, rps: 5 }, { unit: distUnit, rps: 1 }]);
  const loginStopped = stopped; stopped = null;

  // ---------- C. mixed: 100 rps total, 5 % logins ----------
  if (ONLY.includes('C')) await step(`C mixed 100 (95 app + 5 login)`, QUICK ? 30 : 300, [app(95), lg(5)]);

  // rate-limit store latency, measured directly (login_guard + login_record through PostgREST)
  const svc = E.jwt({ role: 'service_role' }); const lat = [];
  for (let i = 0; i < 200; i++) {
    const h = (c) => require('crypto').createHash('md5').update(c + i).digest('hex');
    const t0 = Date.now();
    await send(E.o.pgrst, 'POST', '/rpc/login_guard', JSON.stringify({ p_acct: h('a'), p_ip: h('i'), p_pair: h('p') }), { Authorization: 'Bearer ' + svc, 'Content-Type': 'application/json' });
    await send(E.o.pgrst, 'POST', '/rpc/login_record', JSON.stringify({ p_acct: h('a'), p_ip: h('i'), p_pair: h('p'), p_outcome: 'success', p_latency_ms: 1, p_flags: {} }), { Authorization: 'Bearer ' + svc, 'Content-Type': 'application/json' });
    lat.push(Date.now() - t0);
  }
  const storeLatency = { p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99) };
  console.log('rate-limit store (guard + record, idle):', JSON.stringify(storeLatency));
  const metrics = Object.fromEntries((await E.q(`select metric, sum(n)::bigint n from login_metrics group by 1`)).rows.map(r => [r.metric, Number(r.n)]));
  const out = { at: new Date().toISOString(), quick: QUICK, machine: { cpus: os.cpus().length, model: os.cpus()[0].model, ramGB: Math.round(os.totalmem() / 1e9) },
    setup: 'local: embedded Postgres + PostgREST (pool 10), 4 secure-login instances (Deno), Supabase Auth stand-in 80 ms', stop_limits: STOP,
    appStopped, loginStopped, steps, storeLatency, loginMetrics: metrics };
  const file = path.join(__dirname, `rps-results${QUICK ? '-quick' : ''}${ONLY !== 'ABC' ? '-' + ONLY : ''}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log('saved', file);
  await E.stop(); process.exit(0);
})().catch(e => { console.error(e.stack || e); process.exit(1); });
