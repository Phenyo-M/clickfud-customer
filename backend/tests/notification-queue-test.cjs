// Local test of supabase/notification_queue.sql against a copy of the live
// structure (no live data): fan-out per event, one job per recipient per
// channel, no duplicates, preferences, retries/backoff/dead, an error in the
// trigger never blocks the order, RLS, rollback. Run:
//   NODE_PATH=tests/lt/node_modules node tests/notification-queue-test.cjs
const path = require('path'); const fs = require('fs');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');

const PORT = 55481, DIR = path.join(LT, 'cfnotify');
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
    catch (e) { rec(name, !re || re.test(e.message), e.message.slice(0, 120)); }
  };

  await admin();
  for (const f of ['student_sellers.sql', 'seller_review_address.sql', 'account_deletion.sql', 'student_application_details.sql', 'approval_emails.sql',
                   'account_deletion_reasons.sql', 'shop_name_fix.sql', 'notification_links.sql', 'student_collection_times.sql', 'student_order_codes.sql',
                   'student_extras.sql', 'seller_whatsapp.sql']) await q(SQL(f));
  await ok('notification migration applies', () => q(SQL('notification_queue.sql')));
  await ok('notification migration applies a second time (safe to re-run)', () => q(SQL('notification_queue.sql')));

  // ---- seed ----
  const U = {
    cust: ['33333333-3333-4333-8333-333333333333', 'u33333333@tuks.co.za', 'customer'],
    cust2: ['44444444-4444-4444-8444-444444444444', 'u44444444@tuks.co.za', 'customer'],
    seller: ['11111111-1111-4111-8111-111111111111', 'u11111111@tuks.co.za', 'customer'],
    mgr: ['66666666-6666-4666-8666-666666666666', 'mgr@shop.co.za', 'manager'],
    kit: ['77777777-7777-4777-8777-777777777777', 'kitchen@shop.co.za', 'kitchen'],
    mgr2: ['88888888-8888-4888-8888-888888888888', 'other@shop.co.za', 'manager'],
    dev: ['99999999-9999-4999-8999-999999999999', 'dev@clickfood.co.za', 'developer'],
  };
  for (const [k, [id, email, role]] of Object.entries(U)) {
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, email]);
    await q(`insert into profiles (id, name, email, role, status, active, university) values ($1, $2, $3, $4, 'approved', true, 'University of Pretoria')`, [id, k + ' Tester', email, role]);
  }
  const shop = (await q(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time)
    values ($1, 'Kota Shop', 'kota-shop', 'Fast Food', 'Hatfield', 'Shop 3, Hatfield Plaza', 'University of Pretoria', 'approved', true, '00:00', '00:00') returning id`, [U.mgr[0]])).rows[0].id;
  const shop2 = (await q(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time)
    values ($1, 'Other Shop', 'other-shop', 'Fast Food', 'Hatfield', 'Shop 9', 'University of Pretoria', 'approved', true, '00:00', '00:00') returning id`, [U.mgr2[0]])).rows[0].id;
  await q(`update profiles set store_id = $1 where id in ($2, $3)`, [shop, U.mgr[0], U.kit[0]]);
  await q(`update profiles set store_id = $1 where id = $2`, [shop2, U.mgr2[0]]);
  const item = (await q(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock)
    values ($1, 'Kota', 'Lunch', 35, 'x.webp', 'Classic kota with chips', 'approved', true, 500) returning id`, [shop])).rows[0].id;

  const jobs = async (orderId) => (await q(`select recipient_id, channel, event_type, status, payload, dedupe_key from notification_jobs where payload->>'order_id' = $1 order by event_type, recipient_id, channel`, [orderId])).rows;
  const sig = (rows) => rows.map(j => `${j.event_type}:${Object.keys(U).find(k => U[k][0] === j.recipient_id)}:${j.channel}`).sort().join(' ');
  const placeOrder = async (who, store, itemId, extra = {}) => {
    await as(U[who][0], U[who][1]);
    const r = (await q(`insert into orders (customer_id, store_id, items, payment_method, payment_status, status, status_history, total, delivery_location)
      values (auth.uid(), $1, $2, 'cod', 'pending', 'preparing', $3, 35, $4) returning *`,
      [store, JSON.stringify([{ menuItemId: itemId, name: 'Kota', qty: 1, price: 35 }]),
       JSON.stringify([{ status: 'received', at: new Date().toISOString() }, { status: 'preparing', at: new Date().toISOString() }]),
       JSON.stringify(Object.assign({ fulfilment: 'collection', phone: '0711112222' }, extra.loc || {}))])).rows[0];
    await admin();
    return r;
  };
  const staffUpdate = async (who, orderId, status) => {
    await as(U[who][0], U[who][1]);
    const r = (await q(`update orders set status = $2, status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('status', $2::text, 'at', now())) where id = $1 returning *`, [orderId, status])).rows[0];
    await admin();
    return r;
  };

  // ---- 1. new partner order ----
  const o1 = await ok('customer places a cash order', () => placeOrder('cust', shop, item));
  const j1 = await jobs(o1.id);
  rec('new order: customer in_app + manager and kitchen in_app and push, nothing else',
    sig(j1) === 'order_new:kit:in_app order_new:kit:push order_new:mgr:in_app order_new:mgr:push order_placed:cust:in_app', sig(j1));
  rec('customer message unchanged', /^Order ORD-\d{4}-\d+ received, the kitchen is preparing it now!$/.test(j1.find(j => j.event_type === 'order_placed').payload.message), j1.find(j => j.event_type === 'order_placed').payload.message);
  rec('shop message names the order and total', /^New order ORD-\d{4}-\d+ from cust: R35\.00\.$/.test(j1.find(j => j.event_type === 'order_new').payload.message), j1.find(j => j.event_type === 'order_new').payload.message);
  rec('other shops hear nothing', !j1.some(j => j.recipient_id === U.mgr2[0]));
  rec('dedupe key has order, event, channel and user', j1.every(j => j.dedupe_key.startsWith('order:' + o1.id + ':') && j.dedupe_key.endsWith(':' + j.channel + ':user:' + j.recipient_id)));
  rec('no notification written directly any more (only queued)', (await q(`select count(*)::int n from notifications where user_id = $1`, [U.cust[0]])).rows[0].n === 0);

  // ---- 2. ready ----
  await ok('kitchen marks it ready', () => staffUpdate('kit', o1.id, 'ready'));
  let j2 = (await jobs(o1.id)).filter(j => j.event_type === 'order_ready');
  rec('ready: customer in_app + push', sig(j2) === 'order_ready:cust:in_app order_ready:cust:push', sig(j2));
  rec('ready message has pickup place and collection window', /ready for collection\. Please collect your order from the pickup location \(Shop 3, Hatfield Plaza, Hatfield Campus\)\. You have 30 minutes to collect it\./.test(j2[0].payload.message), j2[0].payload.message.slice(0, 160));
  // a replay of the same change (no new history entry) creates nothing new
  await admin();
  await q(`update orders set status = 'preparing' where id = $1`, [o1.id]);
  await q(`update orders set status = 'ready' where id = $1`, [o1.id]);
  j2 = (await jobs(o1.id)).filter(j => j.event_type === 'order_ready');
  rec('repeated ready event creates no duplicate jobs', j2.length === 2, String(j2.length));
  rec('ready -> preparing again does not send "kitchen started preparing"', !(await jobs(o1.id)).some(j => j.event_type === 'order_preparing'));
  // prepared again for real (history appended) -> a second "ready" is a new event
  await staffUpdate('kit', o1.id, 'preparing'); await staffUpdate('kit', o1.id, 'ready');
  j2 = (await jobs(o1.id)).filter(j => j.event_type === 'order_ready');
  rec('ready again after a real re-prepare notifies again', j2.length === 4, String(j2.length));

  // ---- 3. collected (confirm_collection) ----
  const code = (await q(`select collection_code from orders where id = $1`, [o1.id])).rows[0].collection_code;
  await as(U.kit[0], U.kit[1]);
  await ok('kitchen confirms collection with the code and cash', () => q(`select * from confirm_collection($1, $2, 35)`, [o1.id, code]));
  await admin();
  const j3 = (await jobs(o1.id)).filter(j => j.event_type === 'order_collected');
  rec('collected: customer in_app + receipt email', sig(j3) === 'order_collected:cust:email order_collected:cust:in_app', sig(j3));
  rec('confirm_collection no longer writes its own notification', (await q(`select count(*)::int n from notifications where user_id = $1`, [U.cust[0]])).rows[0].n === 0);
  rec('paid at collection is not a separate "payment received"', !(await jobs(o1.id)).some(j => j.event_type === 'payment_received'));

  // ---- 4. staff cancel ----
  const o2 = await placeOrder('cust', shop, item);
  await as(U.mgr[0], U.mgr[1]);
  await ok('manager cancels with a reason', () => q(`select * from staff_cancel_order($1, 'product_unavailable', null)`, [o2.id]));
  await admin();
  const j4 = (await jobs(o2.id)).filter(j => j.event_type.startsWith('order_cancelled'));
  rec('shop cancel: customer in_app + push + email', sig(j4) === 'order_cancelled:cust:email order_cancelled:cust:in_app order_cancelled:cust:push', sig(j4));
  rec('cancel message same as before', j4[0].payload.message === `Sorry, Kota Shop cancelled your order ${o2.order_number}. An item in it is no longer available.`, j4[0].payload.message);

  // ---- 5. customer cancels themselves ----
  const o3 = await placeOrder('cust', shop, item);
  await q(`update orders set status = 'cancelled', cancel_reason = 'customer_cancelled', cancel_note = 'Customer: Changed my mind (too slow)' where id = $1`, [o3.id]);
  const j5 = (await jobs(o3.id)).filter(j => j.event_type.startsWith('order_cancelled'));
  rec('customer cancel: the shop manager hears it (in_app + push), the customer does not', sig(j5) === 'order_cancelled_by_customer:mgr:in_app order_cancelled_by_customer:mgr:push', sig(j5));
  rec('shop message keeps the reason', j5[0].payload.message === `Order ${o3.order_number} was cancelled by the customer. Reason: Changed my mind (too slow).`, j5[0].payload.message);

  // ---- 6. cash paid at the counter, 7. collection time passed ----
  const o4 = await placeOrder('cust', shop, item);
  await staffUpdate('kit', o4.id, 'ready');
  await as(U.kit[0], U.kit[1]);
  await q(`update orders set payment_status = 'paid', cash_tendered = 35 where id = $1`, [o4.id]);
  await admin();
  const j6 = (await jobs(o4.id)).filter(j => j.event_type === 'payment_received');
  rec('cash at the counter: customer in_app', sig(j6) === 'payment_received:cust:in_app' && /^Payment of R35\.00 received for order ORD-/.test(j6[0].payload.message), sig(j6));
  await q(`update orders set collection_state = 'expired', collection_expired_at = now() where id = $1`, [o4.id]);
  const j7 = (await jobs(o4.id)).filter(j => j.event_type === 'collection_expired');
  rec('collection time passed: push only (in-app question is separate)', sig(j7) === 'collection_expired:cust:push', sig(j7));

  // ---- 8. student shop ----
  const sshop = (await q(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, seller_kind, opening_time, closing_time, closed_days, pickup_lat, pickup_lng, cover_image_url)
    values ($1, 'Mpho Kitchen', 'mpho', 'Student Food', 'Hatfield', 'Tuks Village', 'University of Pretoria', 'approved', true, 'student', '00:00', '00:00', '{}', -25.75, 28.23, 'https://x/p.webp') returning id`, [U.seller[0]])).rows[0].id;
  await q(`update profiles set store_id = $1 where id = $2`, [sshop, U.seller[0]]);
  await q(`insert into seller_profiles (store_id, owner_id, whatsapp, food_categories, rules_accepted_at) values ($1, $2, '27721234567', '{Lunch}', now())`, [sshop, U.seller[0]]);
  const sitem = (await q(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, 'Pap', 'Lunch', 30, 'x', 'Pap and wors plate', 'approved', true, 50) returning id`, [sshop])).rows[0].id;
  for (const n of ['Wrap', 'Vetkoek', 'Scones', 'Malva']) await q(`insert into menu_items (store_id, name, category, price, image, description, status, available, stock) values ($1, $2, 'Lunch', 20, 'x', 'Fresh and tasty food', 'approved', true, 50)`, [sshop, n]);
  const so = await ok('buyer orders from a student shop', () => placeOrder('cust2', sshop, sitem, { loc: { collectionTime: new Date(Date.now() + 3600000).toISOString() } }));
  const j8 = await jobs(so.id);
  rec('student order: seller in_app + push, buyer in_app', sig(j8) === 'order_new:seller:in_app order_new:seller:push order_placed:cust2:in_app', sig(j8));
  rec('buyer is no longer told "the kitchen is preparing it now"', /was sent to Mpho Kitchen\. You'll get a message when they accept it\.$/.test(j8.find(j => j.event_type === 'order_placed').payload.message), j8.find(j => j.event_type === 'order_placed').payload.message);
  rec('old seller trigger is gone (no direct seller notification)', (await q(`select count(*)::int n from notifications where user_id = $1`, [U.seller[0]])).rows[0].n === 0);
  await as(U.seller[0], U.seller[1]);
  await ok('seller accepts', () => q(`select * from seller_update_order($1, 'accept')`, [so.id]));
  await ok('seller marks ready', () => q(`select * from seller_update_order($1, 'ready')`, [so.id]));
  const scode = (await q(`select collection_code from orders where id = $1`, [so.id])).rows[0];
  await admin();
  const scode2 = (await q(`select collection_code from orders where id = $1`, [so.id])).rows[0].collection_code;
  await as(U.seller[0], U.seller[1]);
  await ok('seller completes with the code', () => q(`select * from seller_update_order($1, 'complete', null, null, $2)`, [so.id, scode2]));
  await admin();
  const j9 = (await jobs(so.id)).filter(j => j.recipient_id === U.cust2[0]).map(j => j.event_type + ':' + j.channel + ':' + j.payload.message);
  rec('seller accept message unchanged', j9.some(s => s === `order_preparing:in_app:Mpho Kitchen accepted your order ${so.order_number} and is preparing it.`), j9.join(' | ').slice(0, 300));
  rec('seller ready message unchanged', j9.some(s => s === `order_ready:in_app:Your order ${so.order_number} from Mpho Kitchen is ready. Show your collection code when you collect it.`));
  rec('seller complete message unchanged', j9.some(s => s === `order_collected:in_app:Order ${so.order_number} collected. Enjoy your meal! Tap here to rate it.`));
  rec('seller_update_order no longer writes notifications itself', (await q(`select count(*)::int n from notifications where user_id = $1`, [U.cust2[0]])).rows[0].n === 0);
  void scode;

  // ---- 9. card order (finalize_paystack_checkout) ----
  await q(`insert into checkout_sessions (reference, customer_id, email, amount, groups, status, provider, environment) values ('ref_test_1', $1, 'u33333333@tuks.co.za', 35, $2, 'pending', 'payfast', 'sandbox')`,
    [U.cust[0], JSON.stringify([{ storeId: shop, items: [{ menuItemId: item, name: 'Kota', qty: 1, price: 35 }], subtotal: 35, total: 35, deliveryLocation: { fulfilment: 'collection' } }])]).catch(e => rec('card session seed', false, e.message.slice(0, 120)));
  const fin = await ok('card payment creates the order', () => q(`select finalize_paystack_checkout('ref_test_1') r`));
  if (fin) {
    const cid = fin.rows[0].r.order_ids[0];
    const j10 = await jobs(cid);
    rec('card order: "Payment successful!" queued once, shop alerted', sig(j10) === 'order_new:kit:in_app order_new:kit:push order_new:mgr:in_app order_new:mgr:push order_placed:cust:in_app'
      && /^Payment successful! Your order ORD-\d{4}-\d+ has been successfully placed\.$/.test(j10.find(j => j.event_type === 'order_placed').payload.message), sig(j10));
    rec('finalize no longer writes the notification itself', (await q(`select count(*)::int n from notifications where user_id = $1 and type = 'order_received'`, [U.cust[0]])).rows[0].n === 0);
  }

  // ---- 10. preferences ----
  await as(U.cust[0], U.cust[1]);
  await ok('customer turns order emails off', () => q(`insert into notification_preferences (user_id, channel, event_type, enabled) values (auth.uid(), 'email', '*', false)`));
  await err('cannot set someone else\'s preference', () => q(`insert into notification_preferences (user_id, channel, event_type, enabled) values ($1, 'email', '*', false)`, [U.cust2[0]]), /row-level security/);
  rec('reads only own preferences', (await q(`select count(*)::int n from notification_preferences`)).rows[0].n === 1);
  await admin();
  rec('SMS is off by default, other channels on', (await q(`select notification_allowed($1, 'sms', 'order_ready') s, notification_allowed($1, 'push', 'order_ready') p, notification_allowed($1, 'email', 'order_ready') e`, [U.cust2[0]])).rows.every(r => r.s === false && r.p === true && r.e === true));
  const claimedEmail = (await q(`select * from claim_notification_jobs('email', 50)`)).rows;
  rec('disabled channel: nothing claimed for that user', !claimedEmail.some(j => j.recipient_id === U.cust[0]), String(claimedEmail.length));
  rec('disabled channel: their jobs are marked skipped with a reason', (await q(`select count(*)::int n from notification_jobs where channel = 'email' and recipient_id = $1 and status = 'skipped' and error = 'Turned off by the user'`, [U.cust[0]])).rows[0].n >= 2);
  rec('other users still get their emails', claimedEmail.some(j => j.recipient_id === U.cust2[0]));

  // ---- 11. claim, retry with backoff, dead ----
  const claimed = (await q(`select * from claim_notification_jobs('in_app', 3)`)).rows;
  rec('claim takes a batch and marks it processing', claimed.length === 3 && claimed.every(j => j.status === 'processing' && j.attempts === 1));
  const again = (await q(`select * from claim_notification_jobs('in_app', 100)`)).rows;
  rec('claimed jobs are not handed out twice', !again.some(j => claimed.some(c => c.id === j.id)));
  const J = claimed[0].id;
  const step = async (n) => {
    await q(`select finish_notification_job($1, false, null, 'Provider down (test)')`, [J]);
    const r = (await q(`select status, attempts, error, extract(epoch from (next_attempt_at - now()))::int s from notification_jobs where id = $1`, [J])).rows[0];
    return r;
  };
  const delays = [];
  let last;
  for (let i = 1; i <= 5; i++) {
    last = await step(i);
    delays.push(last.status + ':' + last.s);
    if (i < 5) { await q(`update notification_jobs set next_attempt_at = now() where id = $1`, [J]); const c = (await q(`select * from claim_notification_jobs('in_app', 200)`)).rows; if (!c.some(x => x.id === J)) rec('failed job is claimed again when due', false, 'try ' + i); }
  }
  rec('backoff 30 s, 2 min, 10 min, 30 min', /^failed:(29|30) failed:(119|120) failed:(599|600) failed:(1799|1800) dead/.test(delays.join(' ')), delays.join(' '));
  rec('after 5 failed attempts the job is dead and keeps the error', last.status === 'dead' && last.attempts === 5 && last.error === 'Provider down (test)', JSON.stringify(last));
  await q(`select finish_notification_job($1, true, 'notif-123')`, [claimed[1].id]);
  rec('success marks sent with the provider id', (await q(`select status, provider_message_id, sent_at is not null s from notification_jobs where id = $1`, [claimed[1].id])).rows[0].status === 'sent');
  // a stuck "processing" job (worker died) is picked up again after 5 minutes
  await q(`update notification_jobs set locked_at = now() - interval '6 minutes' where id = $1`, [claimed[2].id]);
  rec('stuck processing job is reclaimed', (await q(`select * from claim_notification_jobs('in_app', 200)`)).rows.some(j => j.id === claimed[2].id));

  // ---- 12. delivered receipts ----
  const nid = (await q(`insert into notifications (user_id, message, type, job_id) values ($1, 'x', 'info', $2) returning id`, [claimed[1].recipient_id, claimed[1].id])).rows[0].id;
  await q(`update notification_jobs set provider_message_id = $1 where id = $2`, [nid, claimed[1].id]);
  const owner = Object.values(U).find(u => u[0] === claimed[1].recipient_id);
  await as(U.cust2[0], U.cust2[1]);
  const notMine = (await q(`select mark_notifications_delivered($1) n`, [[nid]])).rows[0].n;
  await as(owner[0], owner[1]);
  const mine = (await q(`select mark_notifications_delivered($1) n`, [[nid]])).rows[0].n;
  await admin();
  rec('only the recipient can mark their notification delivered', (owner[0] === U.cust2[0] ? true : notMine === 0) && mine === 1);
  rec('delivered status and time recorded', (await q(`select status, delivered_at is not null d from notification_jobs where id = $1`, [claimed[1].id])).rows[0].d === true);

  // ---- 13. stale: a cancel that was undone is not sent ----
  const o5 = await placeOrder('cust', shop, item);
  await q(`update orders set status = 'cancelled', cancel_reason = 'customer_cancelled', cancel_note = 'Customer: Other (x)' where id = $1`, [o5.id]);
  await q(`update orders set status = 'preparing', cancel_reason = null where id = $1`, [o5.id]);
  await q(`select * from claim_notification_jobs('in_app', 200)`);
  rec('cancel undone (refund failed): shop notice skipped, not sent', (await q(`select status, error from notification_jobs where payload->>'order_id' = $1 and event_type = 'order_cancelled_by_customer' and channel = 'in_app'`, [o5.id])).rows[0].status === 'skipped');

  const o5b = await placeOrder('cust', shop, item);
  await q(`delete from orders where id = $1`, [o5b.id]);
  await q(`select * from claim_notification_jobs('in_app', 200)`);
  rec('jobs for an order that no longer exists are skipped', (await q(`select count(*)::int n from notification_jobs where payload->>'order_id' = $1 and channel = 'in_app' and status = 'skipped' and error = 'Order no longer exists'`, [o5b.id])).rows[0].n >= 1);

  // ---- 14. push fallback to email ----
  const pj = (await q(`select id from notification_jobs where event_type = 'order_ready' and channel = 'push' limit 1`)).rows[0].id;
  await q(`select queue_notification_fallback($1, 'email')`, [pj]);
  await q(`select queue_notification_fallback($1, 'email')`, [pj]);
  rec('push with no device: one email job created for an important event', (await q(`select count(*)::int n from notification_jobs where payload->>'fallback_from' = $1 and channel = 'email'`, [pj])).rows[0].n === 1);

  // ---- 15. an error inside the trigger never blocks the order ----
  await q(`alter table notification_jobs add constraint test_break check (event_type <> 'order_placed') not valid`);
  const o6 = await ok('order still goes through when queueing fails', () => placeOrder('cust', shop, item));
  rec('the order row exists', !!(o6 && (await q(`select 1 from orders where id = $1`, [o6.id])).rows.length));
  rec('the error is recorded for review', (await q(`select count(*)::int n from notification_errors where order_id = $1`, [o6 && o6.id])).rows[0].n === 1);
  await q(`alter table notification_jobs drop constraint test_break`);

  // ---- 16. security ----
  await as(U.cust[0], U.cust[1]);
  await err('a customer cannot read the queue', () => q(`select * from notification_jobs`), /permission denied/);
  await err('a customer cannot write to the queue', () => q(`insert into notification_jobs (recipient_id, channel, event_type, dedupe_key) values (auth.uid(), 'in_app', 'x', 'x')`), /permission denied/);
  await err('a customer cannot claim jobs', () => q(`select * from claim_notification_jobs('in_app', 1)`), /permission denied/);
  await err('a customer cannot write a notification (even to themselves)', () => q(`insert into notifications (user_id, message, type) values (auth.uid(), 'fake', 'info')`), /row-level security/);
  rec('a customer still reads their own notifications', (await q(`select count(*)::int n from notifications`)).rows.length === 1);
  await as(U.mgr[0], U.mgr[1]);
  await err('a manager cannot write a notification to a customer', () => q(`insert into notifications (user_id, message, type) values ($1, 'fake', 'info')`, [U.cust[0]]), /row-level security/);
  await as(U.dev[0], U.dev[1]);
  await ok('the developer can still send a shop notice', () => q(`insert into notifications (user_id, message, type) values ($1, 'Please update your menu', 'store_notice')`, [U.mgr[0]]));
  await admin();

  // ---- 17. rollback, then re-apply ----
  await ok('rollback runs', () => q(SQL('notification_queue_rollback.sql')));
  rec('rollback restores the seller trigger and old policy', (await q(`select count(*)::int n from pg_trigger where tgname = 'trg_notify_student_seller'`)).rows[0].n === 1
    && (await q(`select count(*)::int n from pg_policies where policyname = 'notif insert allowed' and with_check like '%auth.uid()%'`)).rows[0].n === 1);
  const o7 = await placeOrder('cust', shop, item);
  await as(U.kit[0], U.kit[1]);
  await q(`select * from staff_cancel_order($1, 'restaurant_closed', null)`, [o7.id]);
  await admin();
  rec('after rollback, staff_cancel_order writes its own notification again', (await q(`select count(*)::int n from notifications where user_id = $1 and type = 'order_cancelled'`, [U.cust[0]])).rows[0].n === 1);
  await ok('migration re-applies after rollback', () => q(SQL('notification_queue.sql')));

  await db.end();
  execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' });
  for (const [s, n] of results) console.log(s, n);
  const failed = results.filter(r => r[0] !== 'PASS').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
