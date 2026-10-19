// Test of the real student-verify Edge Function (Deno) against a local
// database, PostgREST and a fake Resend. Synthetic data.
//   DENO_BIN=.../deno.exe NODE_PATH=backend/tests/lt/node_modules node backend/tests/student-verify-fn-test.cjs
const path = require('path'); const fs = require('fs'); const http = require('http'); const crypto = require('crypto');
const { startEnv } = require('./login-env.cjs');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 240)})` : '')]);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  // fake Resend: records every email, can be told to fail
  const sent = []; let resendFails = false;
  const fake = http.createServer((req, res) => { const ch = []; req.on('data', d => ch.push(d)); req.on('end', () => {
    const b = JSON.parse(Buffer.concat(ch).toString() || '{}'); sent.push({ auth: req.headers.authorization, body: b });
    if (resendFails) { res.writeHead(500); return res.end('{"message":"down"}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'em_' + sent.length }));
  }); });
  await new Promise(r => fake.listen(3591, r));
  const E = await startEnv({ fnName: 'student-verify', fnPorts: [8171], dir: 'cfsvfn', pg: 55741, pgrst: 3581, gw: 3582,
    env: { RESEND_API_KEY: 're_test_key', RESEND_FROM_EMAIL: 'noreply@clickfood.test', RESEND_API_URL: 'http://127.0.0.1:3591/emails', APP_URL: 'https://app.test' } });
  const { q } = E; const one = async (s, p) => (await q(s, p)).rows[0];
  try {
    for (const f of ['show_partner_shops.sql', 'payment_options.sql', 'multi_university.sql', 'tut_campuses.sql', 'open_signup_students.sql']) await q(SQL(f));
    await q(`grant all on all tables in schema public to service_role; grant execute on all functions in schema public to service_role`);
    await q(`update allowed_domains set active = true where domain in ('tuks.co.za', 'tut4life.ac.za')`);
    await q(`notify pgrst, 'reload schema'`); await new Promise(r => setTimeout(r, 1500));
    const UP = (await one(`select id from universities where name = 'University of Pretoria'`)).id;
    const a = await E.addUser('thandi@gmail.com', 'x', 'customer'), b = await E.addUser('sipho@outlook.com', 'x', 'customer');
    const tok = (id, email) => E.jwt({ sub: id, role: 'authenticated', email, aud: 'authenticated' });
    const call = async (body, token) => {
      const r = await fetch('http://127.0.0.1:8171/', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), 'cf-connecting-ip': '10.0.0.' + (token ? 1 : 2) }, body: JSON.stringify(body) });
      let j = {}; try { j = await r.json(); } catch (_) {}
      return { status: r.status, body: j, retry: r.headers.get('retry-after') };
    };
    const TA = tok(a, 'thandi@gmail.com'), TB = tok(b, 'sipho@outlook.com');

    let r = await call({ action: 'start', email: 'u12345678@tuks.co.za' });
    rec('not signed in: refused', r.status === 401, r.status);
    r = await call({ action: 'start', email: 'u12345678@tuks.co.za', university_id: UP }, TA);
    rec('a signed-in Gmail customer starts verification', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
    const mail = sent[sent.length - 1];
    const link = mail && (mail.body.text.match(/https:\/\/app\.test\/\?student_verify=([A-Za-z0-9_-]+)/) || [])[1];
    rec('the email goes to the university address, from ClickFood, with a one-time link', !!mail && mail.body.to[0] === 'u12345678@tuks.co.za' && /ClickFood/.test(mail.body.from) && !!link && mail.auth === 'Bearer re_test_key', mail && JSON.stringify(mail.body.to));
    const row = await one(`select token_hash, status, email from student_verifications where user_id = $1`, [a]);
    rec('only a hash of the link\'s code is stored', row.token_hash === sha(link) && row.token_hash !== link && row.status === 'pending');
    rec('the login email is unchanged', (await one(`select email from profiles where id = $1`, [a])).email === 'thandi@gmail.com');
    r = await call({ action: 'start', email: 'u12345678@tuks.co.za', university_id: UP }, TA);
    rec('sending again at once is refused with a wait time (429)', r.status === 429 && Number(r.retry) > 0 && r.body.ok === false, r.status + ' ' + r.retry);
    r = await call({ action: 'confirm', token: link }, TB);
    rec('another account opening the link is not verified', r.body.ok === false && (await one(`select public.is_verified_student($1) v`, [b])).v === false, JSON.stringify(r.body));
    r = await call({ action: 'confirm', token: link, p_user: a }, TB);
    rec('naming someone else in the request changes nothing (identity comes from the sign-in)', r.body.ok === false && (await one(`select public.is_verified_student($1) v`, [a])).v === false);
    r = await call({ action: 'confirm', token: 'not a token!' }, TA);
    rec('a broken link is refused', r.body.ok === false, JSON.stringify(r.body));
    r = await call({ action: 'confirm', token: link }, TA);
    rec('the right student opening the link is verified', r.body.ok === true && r.body.status === 'verified' && (await one(`select public.is_verified_student($1) v`, [a])).v === true, JSON.stringify(r.body));
    r = await call({ action: 'confirm', token: link }, TA);
    rec('using the link again is harmless (still verified)', r.body.ok === true);
    r = await call({ action: 'start', email: 'u12345678@tuks.co.za', university_id: UP }, TB);
    rec('the same university email can\'t verify a second account', r.body.ok === false && /another ClickFood account/.test(r.body.error || ''), JSON.stringify(r.body));
    resendFails = true;
    r = await call({ action: 'start', email: '123456789@tut4life.ac.za' }, TB);
    rec('if the email can\'t be sent, the customer is told (no fake success)', r.body.ok === false && /couldn't send/i.test(r.body.error || ''), JSON.stringify(r.body));
    r = await call({ action: 'nonsense' }, TA);
    rec('unknown actions are refused', r.status === 400);
  } catch (e) { rec('test run', false, e.stack || e.message); }
  const log = E.fns[0].log();
  rec('no university emails or tokens in the function log', !/tuks\.co\.za|student_verify=/.test(log), log.slice(-300));
  await E.stop(); fake.close();
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})();
