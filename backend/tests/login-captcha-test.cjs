// secure-login checks the Cloudflare Turnstile token itself (Supabase skips
// CAPTCHA on the server's own sign-in calls). A local stand-in plays
// Cloudflare's siteverify; no real keys are used.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/login-captcha-test.cjs
const http = require('http');
const { startEnv } = require('./login-env.cjs');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 200)})` : '')]);

(async () => {
  let cfUp = true; const seen = [];
  const cf = http.createServer((req, res) => {
    const ch = []; req.on('data', d => ch.push(d)); req.on('end', () => {
      const f = new URLSearchParams(Buffer.concat(ch).toString()); seen.push({ secret: f.get('secret'), response: f.get('response'), remoteip: f.get('remoteip') });
      if (!cfUp) { req.socket.destroy(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: f.get('secret') === 'test-secret' && f.get('response') === 'good-token' }));
    });
  }).listen(3561);
  const E = await startEnv({ fnPorts: [8191], dir: 'cfcaptcha', pg: 55711, pgrst: 3562, gw: 3563,
    env: { TURNSTILE_SECRET_KEY: 'test-secret', TURNSTILE_VERIFY_URL: 'http://127.0.0.1:3561/' } });
  global.__E = E;
  const PW = 'Correct-Horse-9!';
  await E.addUser('u10000001@tuks.co.za', PW);
  const login = (tok, ip) => new Promise((resolve) => {
    const body = JSON.stringify({ email: 'u10000001@tuks.co.za', password: PW, app: 'customer', ...(tok ? { captcha_token: tok } : {}) });
    const r = http.request({ host: '127.0.0.1', port: 8191, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'cf-connecting-ip': ip || '198.51.100.7' } }, (res) => {
      const ch = []; res.on('data', d => ch.push(d)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString())); } catch (e) { resolve({}); } });
    });
    r.on('error', () => resolve({ error: 'conn' })); r.end(body);
  });
  const callsBefore = E.auth.calls;
  let r = await login(null);
  rec('no robot-check token: refused before Supabase Auth is asked', r.captcha_failed === true && E.auth.calls === callsBefore, JSON.stringify(r));
  r = await login('bad-token');
  rec('a bad token: refused', r.captcha_failed === true, JSON.stringify(r));
  r = await login('good-token', '203.0.113.20');
  rec('a good token: the student signs in', !!(r.session && r.session.access_token), JSON.stringify(r).slice(0, 120));
  rec('the secret and the student\'s network address go to Cloudflare', seen.some(s => s.secret === 'test-secret' && s.response === 'good-token' && s.remoteip === '203.0.113.20'));
  cfUp = false;
  r = await login('any-token');
  rec('Cloudflare unreachable: the login carries on (limits still apply)', !!(r.session), JSON.stringify(r).slice(0, 120));
  await E.stop(); cf.close();
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch(async e => { console.error(e); try { if (global.__E) await global.__E.stop(); } catch (_) {} process.exit(1); });
