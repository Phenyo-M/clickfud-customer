// Local test of supabase/shop_test_mode.sql: a shop in test mode can be
// seen but not ordered from; only the developer can switch it. Run:
//   NODE_PATH=tests/lt/node_modules node tests/shop-test-mode-test.cjs
const path = require('path'); const fs = require('fs');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');

const PORT = 55521, DIR = path.join(LT, 'cftestmode');
const results = [];
const rec = (name, ok, extra) => results.push([ok ? 'PASS' : 'FAIL', name + (extra ? ` (${extra})` : '')]);
const SQL = (f) => fs.readFileSync(path.join(__dirname, '../supabase', f), 'utf8');

(async () => {
  const db = await build(PORT, DIR);
  const q = (sql, params) => db.query(sql, params);
  const admin = async () => { await q(`reset role; select set_config('request.jwt.claims', '', false)`); };
  const as = async (id, email) => {
    await q(`reset role`);
    await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated', email })]);
    await q(`set role authenticated`);
  };
  const ok = async (name, fn) => { try { const r = await fn(); rec(name, true); return r; } catch (e) { rec(name, false, e.message.slice(0, 160)); } };
  const err = async (name, fn, re) => {
    try { await fn(); rec(name, false, 'was allowed'); }
    catch (e) { rec(name, !re || re.test(e.message), e.message.slice(0, 140)); }
  };

  await admin();
  for (const f of ['student_sellers.sql', 'seller_review_address.sql', 'student_collection_times.sql', 'student_order_codes.sql']) await q(SQL(f));
  await ok('test mode migration applies', () => q(SQL('shop_test_mode.sql')));
  await ok('test mode migration applies a second time', () => q(SQL('shop_test_mode.sql')));

  const U = {
    cust: ['33333333-3333-4333-8333-333333333333', 'u33333333@tuks.co.za', 'customer'],
    seller: ['11111111-1111-4111-8111-111111111111', 'u11111111@tuks.co.za', 'customer'],
    mgr: ['66666666-6666-4666-8666-666666666666', 'mgr@shop.co.za', 'manager'],
    dev: ['99999999-9999-4999-8999-999999999999', 'dev@clickfood.co.za', 'developer'],
  };
  for (const [k, [id, email, role]] of Object.entries(U)) {
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, email]);
    await q(`insert into profiles (id, name, email, role, status, active, university) values ($1, $2, $3, $4, 'approved', true, 'University of Pretoria')`, [id, k + ' Tester', email, role]);
  }
  const shop = (await q(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time)
    values ($1, 'Kota Shop', 'kota-shop', 'Fast Food', 'Hatfield', 'Shop 3', 'University of Pretoria', 'approved', true, '00:00', '00:00') returning id`, [U.mgr[0]])).rows[0].id;
  await q(`update profiles set store_id = $1 where id = $2`, [shop, U.mgr[0]]);
  const item = (await q(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, 'Kota', 'Lunch', 35, 'x', 'Classic kota with chips', 'approved', true, 500) returning id`, [shop])).rows[0].id;
  const sshop = (await q(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, seller_kind, opening_time, closing_time, closed_days, pickup_lat, pickup_lng, cover_image_url)
    values ($1, 'Mpho Kitchen', 'mpho', 'Student Food', 'Hatfield', 'Tuks Village', 'University of Pretoria', 'approved', true, 'student', '00:00', '00:00', '{}', -25.75, 28.23, 'https://x/p.webp') returning id`, [U.seller[0]])).rows[0].id;
  await q(`update profiles set store_id = $1 where id = $2`, [sshop, U.seller[0]]);
  const sitem = (await q(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, 'Pap', 'Lunch', 30, 'x', 'Pap and wors plate', 'approved', true, 50) returning id`, [sshop])).rows[0].id;
  for (const n of ['Wrap', 'Vetkoek', 'Scones', 'Malva']) await q(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, $2, 'Lunch', 20, 'x', 'Fresh and tasty food', 'approved', true, 50)`, [sshop, n]);

  const order = async (store, itemId, student) => {
    await as(U.cust[0], U.cust[1]);
    try {
      return (await q(`insert into orders (customer_id, store_id, items, payment_method, payment_status, status, total, delivery_location) values (auth.uid(), $1, $2, 'cod', 'pending', 'preparing', 1, $3) returning id`,
        [store, JSON.stringify([{ menuItemId: itemId, name: 'x', qty: 1, price: 1 }]), JSON.stringify(Object.assign({ fulfilment: 'collection' }, student ? { collectionTime: new Date(Date.now() + 3600000).toISOString() } : {}))])).rows[0];
    } finally { await admin(); }
  };

  rec('new shops are not in test mode', (await q(`select test_mode from stores where id = $1`, [shop])).rows[0].test_mode === false);
  await ok('orders work before test mode', () => order(shop, item));

  // only the developer can switch it
  await as(U.mgr[0], U.mgr[1]);
  await q(`update stores set test_mode = true where id = $1`, [shop]);
  await admin();
  rec('a shop manager cannot switch test mode', (await q(`select test_mode from stores where id = $1`, [shop])).rows[0].test_mode === false);
  await as(U.seller[0], U.seller[1]);
  await q(`update stores set test_mode = true where id = $1`, [sshop]);
  await admin();
  rec('a student seller cannot switch test mode', (await q(`select test_mode from stores where id = $1`, [sshop])).rows[0].test_mode === false);
  await as(U.dev[0], U.dev[1]);
  await ok('the developer puts both shops in test mode', () => q(`update stores set test_mode = true where id in ($1, $2)`, [shop, sshop]));
  await admin();
  rec('both shops are in test mode', (await q(`select count(*)::int n from stores where test_mode`)).rows[0].n === 2);

  // browsing still works, ordering does not
  await as(U.cust[0], U.cust[1]);
  rec('customers can still see the shops and their menus', (await q(`select count(*)::int n from stores where id in ($1, $2)`, [shop, sshop])).rows[0].n === 2
    && (await q(`select count(*)::int n from menu_items where store_id in ($1, $2)`, [shop, sshop])).rows[0].n === 6);
  await admin();
  await err('a business shop in test mode refuses orders', () => order(shop, item), /Kota Shop is in test mode\. You can look around, but ordering isn't open yet\./);
  await err('a student shop in test mode refuses orders', () => order(sshop, sitem, true), /Mpho Kitchen is in test mode/);
  rec('card checkout and group orders get the same answer (ordering_block_reason)', /is in test mode/.test((await q(`select ordering_block_reason($1, $2) r`, [shop, [item]])).rows[0].r || ''));
  await as(U.mgr[0], U.mgr[1]);
  await q(`update stores set test_mode = false, store_closed = false where id = $1`, [shop]);
  await admin();
  rec('a manager editing the shop cannot end test mode either', (await q(`select test_mode from stores where id = $1`, [shop])).rows[0].test_mode === true);

  // ending test mode
  await as(U.dev[0], U.dev[1]);
  await q(`update stores set test_mode = false where id = $1`, [shop]);
  await admin();
  await ok('after test mode ends, orders work again', () => order(shop, item));
  rec('the other shop stays in test mode', (await q(`select test_mode from stores where id = $1`, [sshop])).rows[0].test_mode === true);
  await q(`update stores set test_mode = false where id = $1`, [sshop]);
  rec('the server (no user) can switch it too', (await q(`select test_mode from stores where id = $1`, [sshop])).rows[0].test_mode === false);

  await ok('rollback runs', async () => { await q(SQL('shop_test_mode_rollback.sql')); await q(SQL('student_collection_times.sql')); });
  await ok('migration re-applies after rollback', () => q(SQL('shop_test_mode.sql')));

  await db.end();
  execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' });
  for (const [s, n] of results) console.log(s, n);
  const failed = results.filter(r => r[0] !== 'PASS').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { for (const [s, n] of results) console.log(s, n); console.error(e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
