// Database test for supabase/poll_review.sql: a shop manager's poll always
// waits for the developer, students can't see or vote in it until it is
// published, the developer approves (publishes) or rejects with a reason,
// and a saved poll's question/options can't be changed. Local copy, synthetic data.
//   NODE_PATH=backend/tests/lt/node_modules node backend/tests/poll-review-test.cjs
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');
const PORT = 55871, DIR = path.join(LT, 'cfpollreview');
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');
const results = []; const rec = (n, ok, x) => results.push([ok ? 'PASS' : 'FAIL', n + (x !== undefined && x !== '' ? ` (${String(x).slice(0, 240)})` : '')]);

(async () => {
  const db = await build(PORT, DIR); const q = (s, p) => db.query(s, p); const one = async (s, p) => (await q(s, p)).rows[0];
  const admin = async () => { await q('reset role'); await q(`select set_config('request.jwt.claims', '', false)`); };
  const as = async (id) => { await q('reset role'); await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated' })]); await q('set role authenticated'); };
  const tryq = async (s, p) => { try { return { rows: (await q(s, p)).rows }; } catch (e) { return { err: e.message }; } };
  const run = async (u, s, p) => { await as(u); const r = await tryq(s, p); await admin(); return r; };
  await admin();
  await q(SQL('engagement_deals.sql'));
  try { await q(SQL('poll_review.sql')); await q(SQL('poll_review.sql')); rec('migration applies (twice)', true); } catch (e) { rec('migration applies (twice)', false, e.message); throw e; }

  const mk = async (email, role, storeId) => {
    const id = crypto.randomUUID();
    await q(`set session_replication_role = replica`);
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, email]);
    await q(`insert into profiles (id, name, email, role, status, active, store_id) values ($1, $2, $2, $3, 'approved', true, $4)`, [id, email, role, storeId || null]);
    await q(`set session_replication_role = origin`);
    return id;
  };
  const store = crypto.randomUUID(), store2 = crypto.randomUUID();
  await q(`set session_replication_role = replica`);
  for (const [id, n] of [[store, 'Kota Hub T'], [store2, 'Coffee T']]) await q(`insert into stores (id, name, slug, status, is_published, category, campus_location, address, opening_time, closing_time) values ($1, $2, $3, 'approved', true, 'Food', 'Hatfield', 'Res', '08:00', '17:00')`, [id, n, n.toLowerCase().replace(/ /g, '-')]);
  await q(`set session_replication_role = origin`);
  const mgr = await mk('mgr@shop.test', 'manager', store);
  const mgr2 = await mk('mgr2@shop.test', 'manager', store2);
  const dev = await mk('dev@clickfood.test', 'developer');
  const stu = await mk('stu@tuks.co.za', 'customer');

  // ---------- a manager's poll waits ----------
  let r = await run(mgr, `insert into polls (question, options, store_id, created_by, status, ends_at) values ('Which new kota should we add?', array['Cheese', 'Russian'], $1, $2, 'published', now() + interval '3 days') returning id, status`, [store, mgr]);
  const pid = r.rows && r.rows[0].id;
  rec('a manager\'s new poll is saved as waiting for review (even if the app says "published")', r.rows && r.rows[0].status === 'pending_review', r.err || JSON.stringify(r.rows));
  r = await run(stu, `select count(*)::int n from polls where id = $1`, [pid]);
  rec('students cannot see a poll waiting for review', r.rows && r.rows[0].n === 0, r.err);
  r = await run(stu, `select vote_poll($1, 0)`, [pid]);
  rec('...and cannot vote in it', !!r.err && /not found/i.test(r.err), r.err);
  r = await run(mgr, `select status from polls where id = $1`, [pid]);
  rec('the manager still sees their poll and its status', r.rows && r.rows[0] && r.rows[0].status === 'pending_review');
  r = await run(mgr2, `select count(*)::int n from polls where id = $1`, [pid]);
  rec('another shop\'s manager cannot see it', r.rows && r.rows[0].n === 0);
  r = await run(mgr, `update polls set status = 'published' where id = $1`, [pid]);
  rec('the manager cannot publish it themselves', !!r.err || (await one(`select status from polls where id = $1`, [pid])).status === 'pending_review', r.err);
  r = await run(mgr, `select dev_review_poll($1, 'approve') r`, [pid]);
  rec('the manager cannot use the developer\'s review', r.rows && r.rows[0].r.ok === false && (await one(`select status from polls where id = $1`, [pid])).status === 'pending_review');
  r = await run(mgr, `update polls set options = array['Cheese', 'Russian', 'Vienna'] where id = $1`, [pid]);
  rec('a saved poll\'s options cannot be changed', !!r.err, r.err);

  // ---------- the developer reviews ----------
  r = await run(dev, `select id from polls where status = 'pending_review'`);
  rec('the developer sees the poll in the review list', r.rows && r.rows.some(x => x.id === pid));
  await q(`update polls set starts_at = now() - interval '2 days', ends_at = now() - interval '1 hour' where id = $1`, [pid]);  // reviewed late: the 3-day window already passed
  r = await run(dev, `select dev_review_poll($1, 'approve') r`, [pid]);
  const pub = await one(`select status, starts_at <= now() s, ends_at > now() + interval '1 day' e, reviewed_by from polls where id = $1`, [pid]);
  rec('approving publishes it, starting then, for the time the manager chose', r.rows && r.rows[0].r.ok && pub.status === 'published' && pub.s && pub.e && pub.reviewed_by === dev, JSON.stringify(pub));
  r = await run(stu, `select count(*)::int n from polls where id = $1`, [pid]);
  rec('students now see the published poll', r.rows && r.rows[0].n === 1);
  r = await run(stu, `select vote_poll($1, 1)`, [pid]);
  const res = await run(stu, `select poll_results($1) r`, [pid]);
  rec('a student votes and sees the result', !r.err && res.rows[0].r.total === 1 && res.rows[0].r.mine === 1, r.err);
  r = await run(stu, `select vote_poll($1, 0)`, [pid]);
  rec('...only once', !!r.err && /already voted/.test(r.err));
  r = await run(dev, `select dev_review_poll($1, 'reject', 'Too late') r`, [pid]);
  rec('a reviewed poll cannot be reviewed again', r.rows && r.rows[0].r.ok === false && /already been reviewed/.test(r.rows[0].r.error));
  r = await run(mgr, `update polls set ends_at = now() where id = $1`, [pid]);
  rec('the manager can still end their published poll', !r.err, r.err);
  r = await run(mgr, `update polls set ends_at = now() + interval '30 days' where id = $1`, [pid]);
  rec('...but cannot extend it', !!r.err);

  // ---------- rejection ----------
  r = await run(mgr, `insert into polls (question, options, store_id, created_by) values ('Rate our burgers from one to three', array['1', '2', '3'], $1, $2) returning id`, [store, mgr]);
  const p2 = r.rows[0].id;
  r = await run(dev, `select dev_review_poll($1, 'reject', '') r`, [p2]);
  rec('rejecting needs a reason', r.rows && r.rows[0].r.ok === false && /reason/.test(r.rows[0].r.error));
  r = await run(dev, `select dev_review_poll($1, 'reject', 'Please ask about food, not ratings.') r`, [p2]);
  rec('rejecting with a reason works', r.rows && r.rows[0].r.ok);
  r = await run(mgr, `select status, review_note from polls where id = $1`, [p2]);
  rec('the manager sees it was not approved and why', r.rows[0].status === 'rejected' && /food, not ratings/.test(r.rows[0].review_note));
  r = await run(stu, `select count(*)::int n from polls where id = $1`, [p2]);
  rec('students never see a rejected poll', r.rows[0].n === 0);
  r = await run(mgr, `delete from polls where id = $1`, [p2]);
  rec('the manager can delete a rejected poll', !r.err && !(await one(`select 1 x from polls where id = $1`, [p2])));

  // ---------- the developer's own campus poll ----------
  r = await run(dev, `insert into polls (question, options, store_id, created_by) values ('What should ClickFood add next?', array['More shops', 'Late night'], null, $1) returning status`, [dev]);
  rec('the developer\'s campus poll is published straight away (as before)', r.rows && r.rows[0].status === 'published', r.err);
  r = await run(mgr, `insert into polls (question, options, store_id, created_by) values ('A campus poll from a manager', array['A', 'B'], null, $1)`, [mgr]);
  rec('a manager cannot create a campus-wide poll', !!r.err);
  rec('existing polls stay published', (await one(`select count(*)::int n from polls where status = 'published'`)).n >= 2);

  try { await q(SQL('poll_review_rollback.sql')); await q(SQL('engagement_deals.sql')); await q(SQL('poll_review.sql')); rec('rollback runs and the file re-applies', true); } catch (e) { rec('rollback runs and the file re-applies', false, e.message); }
  await db.end();
  try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {}
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(x => x[0] === 'PASS').length}/${results.length} passed`);
  process.exit(0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e.stack || e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
