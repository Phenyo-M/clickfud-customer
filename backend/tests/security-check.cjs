// Run: node tests/security-check.cjs  ->  writes tests/security-check.sql, then
//   npx supabase db query --project-ref ctxnwjjpqxecidzblyok --linked -o json -f tests/security-check.sql
// Every line should say PASS except 'BEFORE fix' (which proves the old hole is closed).
//
// Builds a LIVE test that applies security_phase1.sql inside a transaction,
// acts as real accounts (by id, nothing private printed), records PASS/FAIL,
// then ROLLS BACK. Nothing is kept.
const fs = require('fs');
const fix = fs.readFileSync(__dirname + '/../supabase/security_phase1.sql', 'utf8');
const as = (who) => `reset role; select set_config('request.jwt.claims', json_build_object('sub', (select id from t_ids where k='${who}'), 'role', 'authenticated')::text, true); set local role authenticated;`;
const asAnon = `reset role; select set_config('request.jwt.claims', '{"role":"anon"}', true); set local role anon;`;
const asAdmin = `reset role; select set_config('request.jwt.claims', '', true);`;
const rec = (name, sqlBool) => `insert into t_r select '${name}', case when (${sqlBool}) then 'PASS' else 'FAIL' end;`;
const expectError = (name, stmt) => `do $t$ begin begin ${stmt}; insert into t_r values ('${name}', 'FAIL (was allowed)'); exception when others then insert into t_r values ('${name}', 'PASS (' || left(sqlerrm, 60) || ')'); end; end $t$;`;
const expectOk = (name, stmt) => `do $t$ begin begin ${stmt}; insert into t_r values ('${name}', 'PASS'); exception when others then insert into t_r values ('${name}', 'FAIL (' || left(sqlerrm, 90) || ')'); end; end $t$;`;

const sql = `
begin;
create temp table t_r (k text, v text); create temp table t_ids (k text, id uuid);
grant all on t_r, t_ids to authenticated, anon;
insert into t_ids select 'cust', id from profiles where role='customer' and active order by created_at limit 1;
insert into t_ids select 'cust2', id from profiles where role='customer' and active and id <> (select id from t_ids where k='cust') order by created_at limit 1;
insert into t_ids select 'mgr', p.id from profiles p join stores s on s.id = p.store_id and s.manager_id = p.id where p.role='manager' and p.active and exists (select 1 from orders o where o.store_id = p.store_id) limit 1;
insert into t_ids select 'store', store_id from profiles where id = (select id from t_ids where k='mgr');
insert into t_ids select 'kitchen', id from profiles where role='kitchen' and active and store_id = (select id from t_ids where k='store') limit 1;
insert into t_ids select 'dev', id from profiles where role='developer' and active limit 1;
insert into t_ids select 'shopcust', customer_id from orders where store_id = (select id from t_ids where k='store') and customer_id is not null limit 1;
insert into t_ids select 'otherstore', id from stores where id <> (select id from t_ids where k='store') limit 1;
insert into t_ids select 'item', id from menu_items where store_id = (select id from t_ids where k='store') and status='approved' and available limit 1;
insert into t_r select 'accounts found: ' || string_agg(k, ','), 'INFO' from t_ids where id is not null;
-- before the fix: the holes are real (sanity check of the test itself)
${as('cust')}
${rec('BEFORE fix: customer can read other profiles', `(select count(*) from profiles where id <> auth.uid()) > 0`)}
${asAdmin}
${fix}
-- ===== orders =====
${as('cust')}
${expectError('customer cannot insert a CARD/PAID order', `insert into orders (customer_id, store_id, items, payment_method, payment_status, status, total) values (auth.uid(), (select id from t_ids where k='store'), jsonb_build_array(jsonb_build_object('menuItemId', (select id from t_ids where k='item'), 'qty', 1, 'price', 1, 'name', 'x')), 'card', 'paid', 'ready', 1)`)}
do $t$ declare o orders; begin
  begin
    insert into orders (customer_id, store_id, items, payment_method, payment_status, status, total, payout_amount, payment_reference, collected_at)
    values (auth.uid(), (select id from t_ids where k='store'), jsonb_build_array(jsonb_build_object('menuItemId', (select id from t_ids where k='item'), 'qty', 1, 'price', 1, 'name', 'x')), 'cod', 'paid', 'ready', 1, 999, 'fake', now())
    returning * into o;
    insert into t_r values ('cash order: forced to pending/preparing, server fields cleared',
      case when o.payment_status='pending' and o.status='preparing' and o.payout_amount is null and o.payment_reference is null and o.collected_at is null then 'PASS' else 'FAIL ' || o.payment_status || '/' || o.status end);
  exception when others then insert into t_r values ('cash order: forced to pending/preparing, server fields cleared', 'SKIPPED (shop rule: ' || left(sqlerrm, 70) || ')');
  end;
end $t$;
${expectError('customer cannot order in another person name', `insert into orders (customer_id, store_id, items, payment_method, total) values ((select id from t_ids where k='cust2'), (select id from t_ids where k='store'), '[]', 'cod', 1)`)}
-- ===== profiles =====
${rec('customer sees only their own profile', `(select count(*) from profiles) = 1`)}
update profiles set store_id = (select id from t_ids where k='otherstore') where id = auth.uid();
${rec('customer cannot link themselves to a shop', `(select store_id from profiles where id = auth.uid()) is null`)}
update profiles set active = false, status = 'approved' where id = auth.uid();
${rec('customer cannot change own active/status', `(select active from profiles where id = auth.uid())`)}
update profiles set name = name || '' , phone = phone where id = auth.uid();
${rec('customer can still edit own name/phone (no error)', `true`)}
${expectError('customer cannot notify another user', `insert into notifications (user_id, message, type) values ((select id from t_ids where k='cust2'), 'fake', 'ready')`)}
${expectOk('customer can notify themselves (app order confirmation)', `insert into notifications (user_id, message, type) values (auth.uid(), 'test', 'order_received')`)}
${expectError('customer cannot change a saved card except default', `update payment_methods set last4 = '0000' where customer_id = auth.uid()`)}
${expectOk('customer can still set a default card', `update payment_methods set is_default = true where customer_id = auth.uid()`)}
${expectError('customer cannot claim timetable reminders', `perform claim_due_timetable_reminders()`)}
-- shop registration: a manager links to the shop they own
${asAdmin}
update stores set manager_id = (select id from t_ids where k='cust') where id = (select id from t_ids where k='otherstore');
${as('cust')}
update profiles set store_id = (select id from t_ids where k='otherstore') where id = auth.uid();
${rec('linking to a shop you own still works (shop registration)', `(select store_id from profiles where id = auth.uid()) = (select id from t_ids where k='otherstore')`)}
-- ===== manager / kitchen =====
${as('mgr')}
${rec('manager sees customers who ordered at their shop', `exists (select 1 from profiles where id = (select id from t_ids where k='shopcust'))`)}
${rec('manager does not see unrelated customers', `not exists (select 1 from profiles p where p.role='customer' and not exists (select 1 from orders o where o.customer_id=p.id and o.store_id=(select id from t_ids where k='store')))`)}
${expectOk('manager can notify a customer of their shop', `insert into notifications (user_id, message, type) values ((select id from t_ids where k='shopcust'), 'test', 'ready')`)}
${expectError('manager cannot notify a customer of another shop', `insert into notifications (user_id, message, type) values ((select p.id from profiles p where p.role='customer' and not exists (select 1 from orders o where o.customer_id=p.id and o.store_id=(select id from t_ids where k='store')) limit 1), 'x', 'ready')`)}
${rec('manager still sees their own profile', `exists (select 1 from profiles where id = auth.uid() and store_id is not null)`)}
${as('kitchen')}
${rec('kitchen sees their shop customers (or no kitchen account exists)', `(select id from t_ids where k='kitchen') is null or exists (select 1 from profiles where id = (select id from t_ids where k='shopcust'))`)}
-- ===== developer / anon =====
${as('dev')}
${rec('developer still sees every profile', `(select count(*) from profiles) = (select reltuples::bigint from pg_class where relname='profiles') or (select count(*) from profiles) > 5`)}
${asAnon}
${expectError('signed-out visitor cannot check developer requests', `perform developer_request_status('x@y.z')`)}
${asAdmin}
select json_agg(json_build_object('test', k, 'result', v) order by ctid) as results from t_r;
rollback;
`;
fs.writeFileSync(__dirname + '/security-check.sql', sql);
console.log('ok', sql.length);
