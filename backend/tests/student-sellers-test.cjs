// Local test of supabase/student_sellers.sql against a copy of the live
// structure (no live data). Needs tests/load/schema-export.json and
// tests/lt/node_modules (embedded-postgres, pg). Run:
//   NODE_PATH=tests/lt/node_modules node tests/student-sellers-test.cjs
const path = require('path'); const fs = require('fs');
const { execFileSync } = require('child_process');
const { build, BIN, LT } = require('./load/build-db.cjs');

const PORT = 55471, DIR = path.join(LT, 'cfseller');
const results = [];
const rec = (name, ok, extra) => results.push([ok ? 'PASS' : 'FAIL', name + (extra ? ` (${extra})` : '')]);

(async () => {
  const db = await build(PORT, DIR);
  const q = (sql, params) => db.query(sql, params);
  const admin = async () => { await q(`reset role; select set_config('request.jwt.claims', '', false)`); };
  const as = async (id, email) => {
    await q(`reset role`);
    await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: 'authenticated', email })]);
    await q(`set role authenticated`);
  };
  const anon = async () => { await q(`reset role; select set_config('request.jwt.claims', '{"role":"anon"}', false); set role anon`); };
  const ok = async (name, fn) => { try { const r = await fn(); rec(name, true); return r; } catch (e) { rec(name, false, e.message.slice(0, 120)); } };
  const err = async (name, fn, re) => {
    try { await fn(); rec(name, false, 'was allowed'); }
    catch (e) { rec(name, !re || re.test(e.message), e.message.slice(0, 90)); }
  };

  // ---- seed (as the server) ----
  await admin();
  await q(fs.readFileSync(path.join(__dirname, '../supabase/student_sellers.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(__dirname, '../supabase/seller_review_address.sql'), 'utf8'));
  await q(`alter table auth.users add column if not exists email_change text, add column if not exists phone text,
      add column if not exists encrypted_password text, add column if not exists banned_until timestamptz, add column if not exists deleted_at timestamptz;
    create table if not exists auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid);
    create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid);
    create table if not exists auth.refresh_tokens (id bigserial primary key, user_id varchar(255));
    create table if not exists auth.one_time_tokens (id uuid primary key default gen_random_uuid(), user_id uuid);`);
  await q(fs.readFileSync(path.join(__dirname, '../supabase/account_deletion.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(__dirname, '../supabase/student_application_details.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(__dirname, '../supabase/approval_emails.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(__dirname, '../supabase/account_deletion_reasons.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(__dirname, '../supabase/shop_name_fix.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(__dirname, '../supabase/notification_links.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(__dirname, '../supabase/student_collection_times.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(__dirname, '../supabase/student_order_codes.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(__dirname, '../supabase/student_extras.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(__dirname, '../supabase/seller_whatsapp.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(__dirname, '../supabase/notification_queue.sql'), 'utf8'));
  // stands in for notify-worker's in-app step (claim, write, finish); the
  // real Edge Function is tested in tests/notify-worker-test.cjs
  const deliverInApp = async () => {
    const claims = await q("select current_setting('request.jwt.claims', true) c, current_user u");
    await q("reset role; select set_config('request.jwt.claims', '', false)");
    for (const j of (await q("select * from claim_notification_jobs('in_app', 200)")).rows) {
      const n = (await q('insert into notifications (user_id, message, type, job_id) values ($1, $2, $3, $4) returning id', [j.recipient_id, j.payload.message, j.payload.type, j.id])).rows[0];
      await q('select finish_notification_job($1, true, $2)', [j.id, n.id]);
    }
    const c = claims.rows[0];
    if (c.c) { await q("select set_config('request.jwt.claims', $1, false)", [c.c]); }
    if (c.u !== 'postgres') await q('set role ' + c.u);
  };
  const U = {
    sellA: ['11111111-1111-4111-8111-111111111111', 'u11111111@tuks.co.za', true],
    sellB: ['22222222-2222-4222-8222-222222222222', 'u22222222@tuks.co.za', true],
    buyer: ['33333333-3333-4333-8333-333333333333', 'u33333333@tuks.co.za', true],
    gmail: ['44444444-4444-4444-8444-444444444444', 'someone@gmail.com', true],
    unconf: ['55555555-5555-4555-8555-555555555555', 'u55555555@tuks.co.za', false],
    mgr: ['66666666-6666-4666-8666-666666666666', 'mgr@shop.co.za', true],
    dev: ['77777777-7777-4777-8777-777777777777', 'dev@clickfood.co.za', true],
  };
  for (const [k, [id, email, conf]] of Object.entries(U)) {
    const role = k === 'mgr' ? 'manager' : k === 'dev' ? 'developer' : 'customer';
    await q(`insert into auth.users (id, email, email_confirmed_at, encrypted_password) values ($1, $2, $3, 'hash')`, [id, email, conf ? new Date() : null]);
    await q(`insert into auth.identities (user_id) values ($1); insert into auth.sessions (user_id) values ($1); insert into auth.refresh_tokens (user_id) values ($1)`.replace(/\$1/g, `'${id}'`));
    await q(`insert into profiles (id, name, email, role, status, active, university) values ($1, $2, $3, $4, 'approved', true, 'University of Pretoria')`, [id, k + ' Test', email, role]);
  }
  const shop = (await q(`insert into stores (manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time)
    values ($1, 'Kota Test', 'kota-test', 'Fast Food', 'Hatfield', 'Hatfield', 'University of Pretoria', 'approved', true, '00:00', '00:00') returning id`, [U.mgr[0]])).rows[0].id;
  await q(`update profiles set store_id = $1 where id = $2`, [shop, U.mgr[0]]);
  const shopItem = (await q(`insert into menu_items (store_id, name, category, price, image, description, status, available)
    values ($1, 'Kota', 'Lunch', 35, 'x.webp', 'Classic kota with chips', 'approved', true) returning id`, [shop])).rows[0].id;

  const become = (who, over = {}) => {
    const a = Object.assign({ name: 'Mama Kitchen ' + who, wa: '072 123 4567', cats: ['Lunch', 'Baked Goods'], other: null, campus: 'Hatfield', desc: 'Home cooked meals', logo: null,
      cover: 'https://x.supabase.co/storage/v1/object/public/images/avatars/a/shop.webp', address: 'Tuks Village, Block C', lat: -25.7535, lng: 28.2295, hustle: true, rules: true,
      details: { business_type: 'takeaway', contact_phone: '072 123 4567', contact_email: 'mama@tuks.co.za', is_registered: false, manager_phone: '072 123 4567', manager_position: 'owner', open_days: [1, 2, 3, 4, 5], opening_time: '08:00', closing_time: '17:00', products_summary: 'Home cooked lunch plates and baked goods' } }, over);
    if (over.details) a.details = Object.assign({}, { business_type: 'takeaway', contact_phone: '072 123 4567', contact_email: 'mama@tuks.co.za', is_registered: false, manager_phone: '072 123 4567', manager_position: 'owner', open_days: [1, 2, 3, 4, 5], opening_time: '08:00', closing_time: '17:00', products_summary: 'Home cooked lunch plates' }, over.details);
    return q(`select * from become_student_seller($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, [a.name, a.wa, a.cats, a.other, a.campus, a.desc, a.logo, a.cover, a.address, a.lat, a.lng, a.hustle, a.rules, JSON.stringify(a.details)]);
  };

  // ---- 1. registration rules ----
  await as(U.gmail[0], U.gmail[1]);
  await err('gmail account cannot become a seller', () => become('G'), /University of Pretoria/);
  await as(U.unconf[0], U.unconf[1]);
  await err('unverified email cannot become a seller', () => become('U'), /verify/);
  await as(U.mgr[0], U.mgr[1]);
  await err('manager account cannot open a student shop', () => become('M'), /student accounts/);
  await as(U.sellA[0], U.sellA[1]);
  await err('invalid WhatsApp refused', () => become('A', { wa: '12345' }), /WhatsApp/);
  await err('Other Food needs detail', () => become('A', { cats: ['Other Food'] }), /other food/);
  await err('non-food category refused', () => become('A', { cats: ['Clothing'] }), /categories/);
  await err('rules must be accepted', () => become('A', { rules: false }), /rules/);
  await err('non-food business name refused', () => become('A', { name: 'Tuks Phone Chargers' }), /food sellers only/);
  await err('shop photo required', () => become('A', { cover: null }), /photo of your shop/);
  await err('pickup address required', () => become('A', { address: '' }), /pickup address/);
  await err('map pin required', () => become('A', { lat: null, lng: null }), /on the map/);
  await err('pin outside South Africa refused', () => become('A', { lat: 51.5, lng: -0.1 }), /on the map/);
  await err('hustleUP answer required', () => become('A', { hustle: null }), /hustleUP/);
  await err('description required', () => become('A', { desc: 'short' }), /describe your food business/);
  await err('business type required', () => become('A', { details: { business_type: '' } }), /business type/);
  await err('business email checked', () => become('A', { details: { contact_email: 'nope' } }), /business email/);
  await err('own phone checked', () => become('A', { details: { manager_phone: '123' } }), /phone number for yourself/);
  await err('role required', () => become('A', { details: { manager_position: '' } }), /role/);
  await err('registration date needed if registered', () => become('A', { details: { is_registered: true } }), /registered/);
  await err('operating days required', () => become('A', { details: { open_days: [] } }), /days you sell/);
  await err('opening times required', () => become('A', { details: { opening_time: '' } }), /opening and closing/);
  await err('what you sell required', () => become('A', { details: { products_summary: '' } }), /what food you sell/);
  await err('what you sell must be food', () => become('A', { details: { products_summary: 'phone chargers' } }), /food sellers only/);
  const storeA = (await ok('UP student opens a student shop', () => become('A')))?.rows[0];
  rec('new shop waits for review: pending, unpublished, 0% commission', storeA && storeA.seller_kind === 'student' && storeA.status === 'pending' && !storeA.is_published && Number(storeA.commission_percent) === 0);
  rec('pickup pin + address saved', storeA && storeA.pickup_lat === -25.7535 && storeA.address === 'Tuks Village, Block C');
  rec('application answers saved on the shop', storeA && storeA.business_type === 'takeaway' && storeA.contact_phone === '27721234567' && storeA.contact_email === 'mama@tuks.co.za' && storeA.manager_position === 'owner' && storeA.manager_phone === '27721234567' && storeA.products_summary && String(storeA.opening_time).startsWith('08:00') && JSON.stringify(storeA.closed_days) === '[0,6]' && storeA.description === 'Home cooked meals');
  await ok('seller edits application answers later', () => q(`select * from update_student_shop_details('Fresh home cooked food daily', $1)`, [JSON.stringify({ business_type: 'bakery', contact_phone: '0821112222', contact_email: 'shop@tuks.co.za', is_registered: true, registration_date: '2025-02-01', manager_phone: '0821112222', manager_position: 'manager', open_days: [0,1,2,3,4,5,6], opening_time: '07:00', closing_time: '22:00', products_summary: 'Cakes and muffins' })]));
  const edited = (await q(`select business_type, is_registered_business, registration_date, closed_days from stores where id = $1`, [storeA.id])).rows[0];
  rec('edited answers saved', edited.business_type === 'bakery' && edited.is_registered_business === true && JSON.stringify(edited.closed_days) === '[]');
  await as(U.sellB[0], U.sellB[1]);
  await err('another student cannot edit it', () => q(`select update_student_shop_details('x', '{}')`), /don.t have a student shop/);
  await as(U.sellA[0], U.sellA[1]);
  await err('cannot publish before review', () => q(`select publish_student_shop()`), /being reviewed/);
  await q(`update stores set status = 'approved', is_published = true where id = $1`, [storeA.id]);
  const selfApprove = (await q(`select status, is_published from stores where id = $1`, [storeA.id])).rows[0];
  rec('seller cannot approve or publish own shop directly', selfApprove.status === 'pending' && !selfApprove.is_published);
  await err('seller cannot remove the shop photo', () => q(`update stores set cover_image_url = null where id = $1`, [storeA.id]), /photo of your shop/);
  await ok('seller can change pickup address + pin', () => q(`update stores set address = 'Hatfield Square, Unit 4', pickup_lat = -25.7489, pickup_lng = 28.2380 where id = $1`, [storeA.id]));
  await err('second shop refused', () => become('A', { name: 'Another' }), /already have/);
  await as(U.sellB[0], U.sellB[1]);
  await err('another student cannot take the same name', () => become('A', { wa: '082 555 1234' }), /already taken/);
  await as(U.sellA[0], U.sellA[1]);
  const sp = (await q(`select * from seller_profiles`)).rows;
  rec('seller sees own profile; WhatsApp normalised; hustleUP saved', sp.length === 1 && sp[0].whatsapp === '27721234567' && sp[0].hustleup_member === true);
  await ok('student saves home address with map pin', () => q(`update profiles set home_address = 'Tuks Village, Block C', home_lat = -25.7535, home_lng = 28.2295 where id = auth.uid()`));
  rec('profile linked to shop', (await q(`select store_id from profiles where id = auth.uid()`)).rows[0].store_id === storeA.id);

  await as(U.sellB[0], U.sellB[1]);
  const storeB = (await ok('second student opens a shop', () => become('B', { wa: '+27 82 555 1234' })))?.rows[0];
  rec('seller B cannot read seller A profile', (await q(`select * from seller_profiles where store_id = $1`, [storeA.id])).rows.length === 0);

  await as(U.buyer[0], U.buyer[1]);
  rec('buyer cannot see a shop under review', (await q(`select 1 from stores where id = $1`, [storeA.id])).rows.length === 0);
  await as(U.dev[0], U.dev[1]);
  rec('developer was told about the new shops', (await q(`select count(*)::int n from notifications where user_id = auth.uid() and type = 'store_review'`)).rows[0].n === 2);
  await ok('developer approves both shops', () => q(`update stores set status = 'approved' where id = any($1)`, [[storeA.id, storeB.id]]));
  await as(U.sellA[0], U.sellA[1]);
  rec('seller told the shop is approved', (await q(`select 1 from notifications where user_id = auth.uid() and type = 'store_approved'`)).rows.length === 1);
  await err('approved shop cannot publish with 0 approved products', () => q(`select publish_student_shop()`), /need 5 approved products/);
  await as(U.buyer[0], U.buyer[1]);
  rec('approved but unpublished shop still hidden', (await q(`select 1 from stores where id = $1`, [storeA.id])).rows.length === 0);

  // ---- 3. products ----
  await as(U.sellA[0], U.sellA[1]);
  const ins = (o) => q(`insert into menu_items (store_id, name, category, price, image, description, status, platform_fee_amount, other_food_detail)
    values ($1, $2, $3, $4, 'img.webp', $5, $6, $7, $8) returning *`, [o.store || storeA.id, o.name, o.cat || 'Lunch', o.price ?? 45, o.desc || 'Pap, wors and chakalaka', o.status || 'approved', o.fee || 9, o.other || null]);
  const item = (await ok('seller adds a food product', () => ins({ name: 'Pap and Wors' })))?.rows[0];
  rec('new product is pending review with no fee', item && item.status === 'pending' && Number(item.platform_fee_amount) === 0);
  await ok('jacket potato / wine sauce dinner is allowed', () => ins({ name: 'Jacket Potato', cat: 'Dinner', desc: 'Baked jacket potato with red wine sauce' }));
  await err('"Specials" not a student category', () => ins({ name: 'Mystery', cat: 'Specials' }), /food category/);
  await err('non-food product name refused', () => ins({ name: 'iPhone charger' }), /Only food/);
  await err('non-food in description refused', () => ins({ name: 'Bundle', desc: 'Lunch plate plus free earphones' }), /Only food/);
  await err('alcohol drink refused', () => ins({ name: 'Wine', cat: 'Drinks', desc: 'Red wine by the glass' }), /Only food/);
  await err('Other Food needs a description', () => ins({ name: 'Thing', cat: 'Other Food' }), /what food/);
  await ok('Other Food with detail allowed', () => ins({ name: 'Samoosas', cat: 'Other Food', other: 'Samoosas' }));
  await err('price 0 refused', () => ins({ name: 'Free food', price: 0 }), /price/);
  await err('seller cannot add to another shop', () => ins({ name: 'Sneaky', store: storeB.id }), /row-level security/);
  await err('seller cannot add to a business shop', () => ins({ name: 'Sneaky', store: shop }), /row-level security/);
  await q(`update menu_items set status = 'approved', approved_at = now() where id = $1`, [item.id]);
  rec('seller cannot approve own product', (await q(`select status from menu_items where id = $1`, [item.id])).rows[0].status === 'pending');
  await as(U.sellB[0], U.sellB[1]);
  const r1 = await q(`update menu_items set price = 1 where id = $1`, [item.id]);
  rec('seller B cannot edit seller A product', r1.rowCount === 0);
  rec('seller B cannot delete seller A product', (await q(`delete from menu_items where id = $1`, [item.id])).rowCount === 0);
  await as(U.buyer[0], U.buyer[1]);
  rec('buyer cannot see pending product', (await q(`select 1 from menu_items where id = $1`, [item.id])).rows.length === 0);
  await as(U.dev[0], U.dev[1]);
  await ok('developer approves product', () => q(`update menu_items set status = 'approved', approved_at = now(), platform_fee_amount = 5 where id = $1`, [item.id]));
  rec('student product fee stays 0 even if developer sets one', Number((await q(`select platform_fee_amount from menu_items where id = $1`, [item.id])).rows[0].platform_fee_amount) === 0);
  await as(U.buyer[0], U.buyer[1]);
  // five approved products, then publish
  await as(U.sellA[0], U.sellA[1]);
  const more = [];
  for (const nm of ['Chicken Wrap', 'Vetkoek', 'Malva Pudding', 'Scones']) more.push((await ins({ name: nm, cat: nm === 'Malva Pudding' ? 'Desserts' : 'Lunch' })).rows[0].id);
  await err('still cannot publish with 1 approved', () => q(`select publish_student_shop()`), /you have 1/);
  await admin();
  await q(`update menu_items set status = 'approved', approved_at = now() where id = any($1)`, [more]);
  await as(U.sellA[0], U.sellA[1]);
  const pub = (await ok('publishes with 5 approved products', () => q(`select * from publish_student_shop()`)))?.rows[0];
  rec('shop is now published', pub && pub.is_published === true);
  await as(U.buyer[0], U.buyer[1]);
  rec('buyer now sees the shop', (await q(`select 1 from stores where id = $1`, [storeA.id])).rows.length === 1);
  await as(U.buyer[0], U.buyer[1]);
  rec('signed-in student gets seller WhatsApp', (await q(`select seller_contact($1) w`, [storeA.id])).rows[0].w === '27721234567');
  rec('buyer cannot read seller_profiles table', (await q(`select * from seller_profiles`)).rows.length === 0);
  rec('business shop has no WhatsApp contact', (await q(`select seller_contact($1) w`, [shop])).rows[0].w === null);
  await anon();
  await err('guest cannot get seller WhatsApp', () => q(`select seller_contact($1)`, [storeA.id]), /permission/);

  await as(U.buyer[0], U.buyer[1]);
  await err('cannot order from an unpublished student shop', () => q(`insert into orders (customer_id, store_id, items, payment_method, total) values (auth.uid(), $1, $2, 'cod', 1)`, [storeB.id, JSON.stringify([{ menuItemId: item.id, qty: 1, price: 1, name: 'x' }])]), /open on ClickFood|no longer available/);
  rec('buyer sees approved product', (await q(`select 1 from menu_items where id = $1`, [item.id])).rows.length === 1);

  // ---- 4. shop row protection ----
  await as(U.sellA[0], U.sellA[1]);
  await q(`update stores set seller_kind = 'business', status = 'approved', commission_percent = 20, is_published = true, verified = true where id = $1`, [storeA.id]);
  const sA = (await q(`select seller_kind, commission_percent, verified from stores where id = $1`, [storeA.id])).rows[0];
  rec('seller cannot change shop kind, commission or verified badge', sA.seller_kind === 'student' && Number(sA.commission_percent) === 0 && !sA.verified);
  await as(U.mgr[0], U.mgr[1]);
  await q(`update stores set seller_kind = 'student' where id = $1`, [shop]);
  rec('manager cannot turn a business shop into a student shop', (await q(`select seller_kind from stores where id = $1`, [shop])).rows[0].seller_kind === 'business');

  // ---- 5. orders ----
  const order = (who, store, itemId, extra = {}) => q(`insert into orders (customer_id, store_id, items, payment_method, payment_status, status, total, promo_code, delivery_location)
    values (auth.uid(), $1, $2, 'cod', $3, $4, 1, $5, $6) returning *`,
    [store, JSON.stringify([{ menuItemId: itemId, name: 'x', qty: 2, price: 1 }]), extra.pay || 'paid', extra.status || 'ready', extra.promo || null, JSON.stringify(Object.assign({ fulfilment: 'collection', phone: '0711112222', collectionTime: new Date(Date.now() + 3600000).toISOString() }, extra.loc || {}))]);
  // collection day/time rules (shop sells Mon-Fri 08:00-17:00 in this block)
  await admin();
  await q(`update stores set opening_time = '08:00', closing_time = '17:00', closed_days = '{0,6}' where id = $1`, [storeA.id]);
  const saAt = (dayOffset, hhmm) => { const d = new Date(Date.now() + dayOffset * 86400000); const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(d); return new Date(ymd + 'T' + hhmm + ':00+02:00'); };
  const nextDow = (want) => { for (let i = 1; i <= 7; i++) { const d = saAt(i, '12:00'); if (d.getUTCDay() === want) return i; } };
  await as(U.buyer[0], U.buyer[1]);
  await err('student order needs a collection time', () => order('buyer', storeA.id, item.id, { loc: { collectionTime: null } }), /choose a collection day and time/);
  await err('a Saturday collection is refused (shop sells Mon-Fri)', () => order('buyer', storeA.id, item.id, { loc: { collectionTime: saAt(nextDow(6), '12:00').toISOString() } }), /isn.t one this shop sells/);
  await err('a time after closing is refused', () => order('buyer', storeA.id, item.id, { loc: { collectionTime: saAt(nextDow(3), '19:00').toISOString() } }), /isn.t one this shop sells/);
  await err('more than a week ahead is refused', () => order('buyer', storeA.id, item.id, { loc: { collectionTime: saAt(10, '12:00').toISOString() } }), /isn.t one this shop sells/);
  const ahead = await ok('ordering ahead for Wednesday 12:00 works, even while closed now', () => order('buyer', storeA.id, item.id, { loc: { collectionTime: saAt(nextDow(3), '12:00').toISOString() } }));
  await admin();
  if (ahead) { await q(`delete from orders where id = $1`, [ahead.rows[0].id]); await q(`delete from notifications where type = 'seller_order' and user_id = $1`, [U.sellA[0]]); }
  await q(`update stores set opening_time = '00:00', closing_time = '00:00', closed_days = '{}' where id = $1`, [storeA.id]);
  await as(U.buyer[0], U.buyer[1]);
  const o1 = (await ok('buyer places an order request', () => order('buyer', storeA.id, item.id, { promo: 'FREE50' })))?.rows[0];
  rec('order starts as NEW (received), unpaid, pay seller directly, no promo', o1 && o1.status === 'received' && o1.payment_status === 'pending' && o1.delivery_location.payment === 'direct' && o1.promo_code === null);
  rec('order price comes from the menu (2 x R45)', o1 && Number(o1.total) === 90);
  rec('order carries customer first name for the seller', o1 && o1.delivery_location.customerName === 'buyer');
  await as(U.sellA[0], U.sellA[1]);
  await err('seller cannot order from own shop', () => order('sellA', storeA.id, item.id), /own shop/);
  rec('seller sees the order', (await q(`select 1 from orders where id = $1`, [o1.id])).rows.length === 1);
  await deliverInApp();
  rec('seller got a new-order notification', (await q(`select 1 from notifications where user_id = auth.uid() and type = 'seller_order'`)).rows.length === 1);
  rec('seller cannot update orders directly', (await q(`update orders set status = 'collected', payment_status = 'paid' where id = $1`, [o1.id])).rowCount === 0);
  await as(U.sellB[0], U.sellB[1]);
  rec('seller B cannot see seller A order', (await q(`select 1 from orders where id = $1`, [o1.id])).rows.length === 0);
  await err('seller B cannot move seller A order', () => q(`select seller_update_order($1, 'accept')`, [o1.id]), /not found/);
  await as(U.buyer[0], U.buyer[1]);
  await err('buyer cannot move the order', () => q(`select seller_update_order($1, 'complete')`, [o1.id]), /student shop/);
  await as(U.sellA[0], U.sellA[1]);
  await err('cannot complete before ready', () => q(`select seller_update_order($1, 'complete')`, [o1.id]), /can't be changed/);
  await ok('seller accepts', () => q(`select seller_update_order($1, 'accept')`, [o1.id]));
  await ok('seller marks ready', () => q(`select seller_update_order($1, 'ready')`, [o1.id]));
  const oR = (await q(`select * from orders where id = $1`, [o1.id])).rows[0];
  rec('ready student order gets a collection code but no timer', oR.status === 'ready' && /^[0-9A-F]{6}$/.test(oR.collection_code || '') && oR.collection_deadline === null && oR.collection_state === null, oR.collection_code);
  await as(U.buyer[0], U.buyer[1]);
  rec('buyer can see their collection code', (await q(`select collection_code from orders where id = $1`, [o1.id])).rows[0].collection_code === oR.collection_code);
  await as(U.sellA[0], U.sellA[1]);
  await err('completing needs the code', () => q(`select seller_update_order($1, 'complete')`, [o1.id]), /collection code/);
  await err('a wrong code is refused', () => q(`select seller_update_order($1, 'complete', null, null, 'ZZZZZZ')`, [o1.id]), /doesn.t match/);
  await ok('seller completes with the buyer code (any case)', () => q(`select seller_update_order($1, 'complete', null, null, $2)`, [o1.id, oR.collection_code.toLowerCase()]));
  const oC = (await q(`select status, payment_status from orders where id = $1`, [o1.id])).rows[0];
  rec('completed order is NOT marked paid', oC.status === 'collected' && oC.payment_status === 'pending');
  await admin();
  await deliverInApp();
  const dn = (await q(`select type, link from notifications where user_id = $1 order by created_at`, [U.dev[0]])).rows;
  rec('developer told about the new student shop, with a link to it', dn.some(n => n.type === 'store_review' && n.link && n.link.store_id === storeA.id), JSON.stringify(dn.filter(n => n.type === 'store_review').map(n => n.link)));
  rec('developer told about each product to review, with a link to it', dn.some(n => n.type === 'menu_review' && n.link && n.link.menu_item_id === item.id));
  const sn = (await q(`select link from notifications where user_id = $1 and type = 'seller_order' limit 1`, [U.sellA[0]])).rows[0];
  rec('seller new-order notification links to the order', sn && sn.link && sn.link.order_id === o1.id && sn.link.store_id === storeA.id);
  await as(U.buyer[0], U.buyer[1]);
  const bn = (await q(`select link from notifications where user_id = auth.uid() order by created_at limit 1`)).rows[0];
  rec('buyer order notification links to the order', bn && bn.link && bn.link.order_id === o1.id);
  rec('buyer sees order sent + accepted, ready, collected as notifications', (await q(`select count(*)::int n from notifications where user_id = auth.uid()`)).rows[0].n === 4);
  await ok('buyer can review a completed student order', () => q(`insert into reviews (order_id, customer_id, food_rating, overall_rating, store_id) values ($1, auth.uid(), 5, 5, $2)`, [o1.id, storeA.id]));
  const o2 = (await order('buyer', storeA.id, item.id)).rows[0];
  await as(U.sellA[0], U.sellA[1]);
  await err('cancel needs a reason', () => q(`select seller_update_order($1, 'cancel')`, [o2.id]), /reason/);
  await ok('seller cancels with a reason', () => q(`select seller_update_order($1, 'cancel', 'product_unavailable')`, [o2.id]));

  // pause shop
  await q(`update stores set store_closed = true, closure_reason = 'Sold out today' where id = $1`, [storeA.id]);
  await as(U.buyer[0], U.buyer[1]);
  await err('paused student shop takes no orders', () => order('buyer', storeA.id, item.id), /temporarily closed/);
  await as(U.sellA[0], U.sellA[1]);
  await q(`update stores set store_closed = false where id = $1`, [storeA.id]);

  // ---- 6. existing shops unchanged ----
  await as(U.buyer[0], U.buyer[1]);
  const o3 = (await ok('business shop order still works', () => order('buyer', shop, shopItem)))?.rows[0];
  rec('business order keeps old behaviour (preparing)', o3 && o3.status === 'preparing' && !o3.delivery_location.payment);
  await as(U.mgr[0], U.mgr[1]);
  await q(`update orders set status = 'ready' where id = $1`, [o3.id]);
  const o3r = (await q(`select collection_code, collection_deadline from orders where id = $1`, [o3.id])).rows[0];
  rec('business order still gets collection code + timer', !!o3r.collection_code && !!o3r.collection_deadline);
  rec('manager cannot see student orders', (await q(`select 1 from orders where id = $1`, [o1.id])).rows.length === 0);

  // ---- 6b. dropping below 5 hides the shop ----
  await as(U.sellA[0], U.sellA[1]);
  await q(`delete from menu_items where id = $1`, [more[3]]);
  rec('deleting to 4 approved products unpublishes the shop', (await q(`select is_published from stores where id = $1`, [storeA.id])).rows[0].is_published === false);
  rec('seller told the shop is hidden', (await q(`select 1 from notifications where user_id = auth.uid() and type = 'shop_hidden'`)).rows.length === 1);

  // ---- 6c. deleting a shop / an account ----
  await as(U.sellB[0], U.sellB[1]);
  const bItem = (await ins({ name: 'B Wrap', store: storeB.id })).rows[0].id;
  await admin();
  await q(`update menu_items set status = 'approved', approved_at = now() where id = $1`, [bItem]);
  await q(`update stores set is_published = true where id = $1`, [storeB.id]); // test shortcut past the 5-product rule
  await q(`update stores set opening_time = '00:00', closing_time = '00:00', closed_days = '{}' where id = $1`, [storeB.id]);
  await as(U.buyer[0], U.buyer[1]);
  const bOrder = (await order('buyer', storeB.id, bItem)).rows[0];
  await err('buyer cannot delete account with an order in progress', () => q(`select delete_my_account('not_using')`), /in progress/);
  await as(U.sellB[0], U.sellB[1]);
  await err('seller cannot delete shop with pending orders', () => q(`select delete_student_shop()`), /in progress/);
  await err('seller cannot delete account with pending shop orders', () => q(`select delete_my_account('not_using')`), /in progress/);
  await q(`select seller_update_order($1, 'cancel', 'other')`, [bOrder.id]);
  await ok('seller deletes shop once nothing is pending', () => q(`select delete_student_shop()`));
  const delShop = (await q(`select status, is_published, archived_by from stores where id = $1`, [storeB.id])).rows[0];
  rec('deleted shop is closed and hidden', delShop.status === 'archived' && !delShop.is_published && delShop.archived_by === U.sellB[0]);
  rec('its products and WhatsApp row are gone', (await q(`select count(*)::int n from menu_items where store_id = $1`, [storeB.id])).rows[0].n === 0
    && (await q(`select count(*)::int n from seller_profiles where store_id = $1`, [storeB.id])).rows[0].n === 0);
  rec('profile unlinked from the shop', (await q(`select store_id from profiles where id = auth.uid()`)).rows[0].store_id === null);
  rec('no "removed" message for a shop the student deleted', (await q(`select count(*)::int n from notifications where user_id = auth.uid() and type = 'store_removed'`)).rows[0].n === 0);
  rec('seller no longer sees the closed shop orders', (await q(`select 1 from orders where id = $1`, [bOrder.id])).rows.length === 0);
  await admin();
  rec('past order still points at the closed shop', (await q(`select store_id from orders where id = $1`, [bOrder.id])).rows[0]?.store_id === storeB.id);
  await admin();
  const closedName = (await q(`select name from stores where id = $1`, [storeB.id])).rows[0].name;
  rec('closed shop name is freed', / \(closed [0-9a-f]{6}\)$/.test(closedName), closedName);
  await as(U.sellB[0], U.sellB[1]);
  await ok('student reopens with the same name as the shop they deleted', () => become('B', { wa: '082 555 1234' }));
  await err('a taken shop name gives a clear message', () => q(`update stores set name = 'mama kitchen a' where manager_id = auth.uid() and status <> 'archived'`), /already taken/);
  await q(`select delete_student_shop()`);
  await ok('student can open a new shop after deleting one', () => become('B2', { wa: '082 555 1234' }));
  await err('second delete of an already deleted shop target refused when none left', async () => { await q(`select delete_student_shop()`); await q(`select delete_student_shop()`); }, /don't have a shop/);

  await admin(); // their partner-shop order from section 6 finishes too
  await q(`update orders set status = 'collected' where customer_id = $1 and status = any (active_order_statuses())`, [U.buyer[0]]);
  await as(U.buyer[0], U.buyer[1]);
  await err('deleting needs a reason', () => q(`select delete_my_account(null)`), /why you are deleting/);
  await err('unknown reason refused', () => q(`select delete_my_account('because')`), /why you are deleting/);
  await err('Other needs a note', () => q(`select delete_my_account('other')`), /little more/);
  await ok('buyer deletes account once nothing is pending', () => q(`select delete_my_account('not_using')`));
  await admin();
  const gone = (await q(`select role, name, email, phone, student_number, home_address, active from profiles where id = $1`, [U.buyer[0]])).rows[0];
  rec('profile anonymised', gone.role === 'deleted' && gone.name === 'Deleted student' && gone.email === null && gone.student_number === null && gone.home_address === null && !gone.active);
  const au = (await q(`select email, encrypted_password, deleted_at from auth.users where id = $1`, [U.buyer[0]])).rows[0];
  rec('login removed (email freed, no password)', /@deleted\.invalid$/.test(au.email) && au.encrypted_password === null && au.deleted_at !== null);
  rec('identities, sessions and tokens deleted', (await q(`select (select count(*) from auth.identities where user_id = $1) + (select count(*) from auth.sessions where user_id = $1) + (select count(*) from auth.refresh_tokens where user_id = $1::text) n`, [U.buyer[0]])).rows[0].n == 0);
  rec('their past orders are kept for the shops', (await q(`select count(*)::int n from orders where customer_id = $1`, [U.buyer[0]])).rows[0].n > 0);
  const why = (await q(`select * from account_deletions order by created_at desc limit 1`)).rows[0];
  rec('reason saved without the person', why && why.reason === 'not_using' && !('user_id' in why));
  const devNote = (await q(`select message from notifications where user_id = $1 and type = 'account_deleted' order by created_at desc limit 1`, [U.dev[0]])).rows[0];
  rec('developer told in the app with the reason', devNote && /buyer deleted their account. Reason: I don.t use ClickFood any more/.test(devNote.message), devNote && devNote.message);
  const devMail = (await q(`select * from email_outbox where kind = 'account_deleted_notice' order by created_at desc limit 1`)).rows[0];
  rec('developer emailed with the reason', devMail && devMail.recipient_email === 'dev@clickfood.co.za' && devMail.data.reason === 'I don\'t use ClickFood any more');
  rec('their notifications are deleted', (await q(`select count(*)::int n from notifications where user_id = $1`, [U.buyer[0]])).rows[0].n === 0);
  await as(U.mgr[0], U.mgr[1]);
  await err('a manager cannot use student account deletion', () => q(`select delete_my_account('not_using')`), /can't be deleted here/);
  await anon();
  await err('guest cannot call delete functions', () => q(`select delete_my_account('not_using')`), /permission|sign in/);

  // ---- 6b. WhatsApp number, extras, note for the seller ----
  await admin();
  await q(`update stores set status = 'approved', is_published = true, opening_time = '00:00', closing_time = '00:00', closed_days = '{}', weekly_hours = null where id = $1`, [storeA.id]);
  for (let i = 0; i < 5; i++) await q(`insert into menu_items (store_id, name, category, price, image, description, status, available) values ($1, $2, 'Lunch', 30, 'x.webp', 'Home cooked plate of food', 'approved', true)`, [storeA.id, 'Plate ' + i]);
  await as(U.sellA[0], U.sellA[1]);
  const catsBefore = (await q(`select food_categories from seller_profiles where store_id = $1`, [storeA.id])).rows[0].food_categories;
  await ok('seller changes only the WhatsApp number', () => q(`select * from update_seller_whatsapp('083 999 0000')`));
  const sp2 = (await q(`select whatsapp, food_categories from seller_profiles where store_id = $1`, [storeA.id])).rows[0];
  rec('new number saved, nothing else changed', sp2.whatsapp === '27839990000' && JSON.stringify(sp2.food_categories) === JSON.stringify(catsBefore));
  await err('invalid new number refused', () => q(`select update_seller_whatsapp('123')`), /WhatsApp/);
  await as(U.sellB[0], U.sellB[1]);
  await err('student without a shop cannot set a number', () => q(`select update_seller_whatsapp('0831112222')`), /don.t have a student shop/);
  rec('buyers get the latest number', (await q(`select seller_contact($1) w`, [storeA.id])).rows[0].w === '27839990000');
  const noted = (await ok('order with a note for the seller', () => order('sellB', storeA.id, item.id, { status: 'received', loc: { instructions: '  No onions please, nut allergy  ' } })))?.rows[0];
  rec('note kept (trimmed) on the order', noted && noted.delivery_location.instructions === 'No onions please, nut allergy', noted && noted.delivery_location.instructions);
  const big = (await ok('very long note accepted', () => order('sellB', storeA.id, item.id, { status: 'received', loc: { instructions: 'x'.repeat(900) } })))?.rows[0];
  rec('long note cut to 300 characters', big && big.delivery_location.instructions.length === 300);
  await admin();
  await q(`update stores set is_published = false where id = $1`, [storeA.id]);
  await as(U.sellB[0], U.sellB[1]);
  rec('buyer with an order still reaches an unlisted shop', (await q(`select seller_contact($1) w`, [storeA.id])).rows[0].w === '27839990000');
  await as(U.gmail[0], U.gmail[1]);
  rec('others cannot get the number of an unlisted shop', (await q(`select seller_contact($1) w`, [storeA.id])).rows[0].w === null);
  await admin();
  await q(`update stores set is_published = true where id = $1`, [storeA.id]);
  await q(`update orders set status = 'cancelled' where store_id = $1 and customer_id = $2 and status = any (active_order_statuses())`, [storeA.id, U.sellB[0]]);

  await as(U.sellA[0], U.sellA[1]);
  const ex = (await ok('student seller adds an extra', () => q(`insert into item_extras (store_id, name, price, available) values ($1, ' Extra cheese ', 5, true) returning *`, [storeA.id])))?.rows[0];
  rec('extra name trimmed', ex && ex.name === 'Extra cheese');
  await ok('student seller puts it on their food', () => q(`insert into item_extra_links (menu_item_id, item_extra_id) values ($1, $2)`, [item.id, ex.id]));
  await err('extra over R200 refused', () => q(`insert into item_extras (store_id, name, price, available) values ($1, 'Gold leaf', 250, true)`, [storeA.id]), /R0 and R200/);
  await err('non-food extra refused', () => q(`insert into item_extras (store_id, name, price, available) values ($1, 'Phone charger', 5, true)`, [storeA.id]), /Only food/);
  await err('extra cannot go on another shop food', () => q(`insert into item_extra_links (menu_item_id, item_extra_id) values ($1, $2)`, [shopItem, ex.id]), /row-level security/);
  await ok('seller edits the extra', () => q(`update item_extras set price = 7 where id = $1`, [ex.id]));
  await as(U.sellB[0], U.sellB[1]);
  await err('another student cannot add extras to that shop', () => q(`insert into item_extras (store_id, name, price, available) values ($1, 'Sauce', 2, true)`, [storeA.id]), /row-level security/);
  rec('another student cannot change it', (await q(`update item_extras set price = 0 where id = $1 returning 1`, [ex.id])).rows.length === 0);
  rec('buyers see the extra on the food', (await q(`select count(*)::int n from menu_item_extras_public where menu_item_id = $1`, [item.id])).rows[0].n >= 1);
  await as(U.sellA[0], U.sellA[1]);
  await ok('seller removes the extra', async () => { await q(`delete from item_extra_links where item_extra_id = $1`, [ex.id]); await q(`delete from item_extras where id = $1`, [ex.id]); });

  // ---- 7. removal ----
  await as(U.dev[0], U.dev[1]);
  await q(`update stores set status = 'archived' where id = $1`, [storeA.id]);
  await as(U.sellA[0], U.sellA[1]);
  await err('removed seller cannot add products', () => ins({ name: 'After removal' }), /row-level security/);
  await as(U.buyer[0], U.buyer[1]);
  await err('removed shop takes no orders', () => order('buyer', storeA.id, item.id), /row-level security|open on ClickFood/);
  rec('removed shop has no WhatsApp contact', (await q(`select seller_contact($1) w`, [storeA.id])).rows[0].w === null);

  // ---- 8. rollback file applies cleanly ----
  await admin();
  await ok('extras + WhatsApp rollbacks run', async () => { await q(fs.readFileSync(path.join(__dirname, '../supabase/seller_whatsapp_rollback.sql'), 'utf8')); await q(fs.readFileSync(path.join(__dirname, '../supabase/student_extras_rollback.sql'), 'utf8')); });
  await ok('rollback runs', () => q(fs.readFileSync(path.join(__dirname, '../supabase/student_sellers_rollback.sql'), 'utf8')));
  await ok('migration re-applies after rollback', () => q(fs.readFileSync(path.join(__dirname, '../supabase/student_sellers.sql'), 'utf8')));
  await ok('review migration rollback runs', () => q(fs.readFileSync(path.join(__dirname, '../supabase/seller_review_address_rollback.sql'), 'utf8')));
  await ok('review migration re-applies', () => q(fs.readFileSync(path.join(__dirname, '../supabase/seller_review_address.sql'), 'utf8')));
  await ok('deletion rollback runs', () => q(fs.readFileSync(path.join(__dirname, '../supabase/account_deletion_rollback.sql'), 'utf8')));
  await ok('deletion migration re-applies', () => q(fs.readFileSync(path.join(__dirname, '../supabase/account_deletion.sql'), 'utf8')));

  await db.end();
  execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' });
  for (const [s, n] of results) console.log(s, n);
  const failed = results.filter(r => r[0] !== 'PASS').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DIR, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch (_) {} process.exit(1); });
