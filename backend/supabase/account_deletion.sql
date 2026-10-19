-- ============================================================
-- ClickFood: delete my account / delete my shop (2026-10-12)
-- Runs after student_sellers.sql and seller_review_address.sql.
--
-- delete_student_shop(): a student closes their own shop. Refused while
--   any of its orders is still in progress. Products are deleted, the
--   private WhatsApp row is deleted, the shop row is kept (archived,
--   archived_by = owner) only because past orders point at it. The
--   student can open a new shop later.
--
-- delete_my_account(): a student deletes their account. Refused while any
--   of their orders (or their shop's orders) is in progress. Their shop is
--   closed as above, personal data is removed, the profile becomes an
--   anonymous 'deleted' row (past orders and reviews keep pointing at it,
--   as order records must), and the login is removed: email freed,
--   password, identities, sessions and refresh tokens deleted.
--
-- Safe to run more than once. Rollback: account_deletion_rollback.sql
-- ============================================================

-- 'deleted' role for anonymised accounts
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role = any (array[
  'customer', 'manager', 'kitchen', 'cashier', 'driver', 'developer', 'dispatcher', 'deleted']));

-- A shop closed by its own student no longer counts as "their shop".
drop index if exists public.stores_one_student_shop_per_owner;
create unique index stores_one_student_shop_per_owner on public.stores (manager_id)
  where seller_kind = 'student' and archived_by is distinct from manager_id;

-- Same trigger as before, plus one escape hatch used only inside the two
-- functions below (a transaction-local setting the API can't set).
create or replace function public.prevent_role_change()
returns trigger language plpgsql as $function$
declare v_actor uuid := auth.uid(); v_actor_role text;
begin
  if current_setting('clickfood.account_cleanup', true) = 'on' then return new; end if;
  if new.role is distinct from old.role then
    new.role := old.role;
  end if;
  if old.store_id is not null and new.store_id is distinct from old.store_id then
    new.store_id := old.store_id;
  end if;

  if v_actor is null then return new; end if;               -- the server
  v_actor_role := public.current_role();
  if v_actor_role = 'developer' then return new; end if;

  if old.store_id is null and new.store_id is not null
     and not exists (select 1 from public.stores s where s.id = new.store_id and s.manager_id = new.id) then
    new.store_id := null;
  end if;

  if v_actor = old.id then
    -- your own account: personal details only
    new.active := old.active;
    new.status := old.status;
    new.rejection_reason := old.rejection_reason;
    new.email := old.email;
  else
    -- a manager editing their kitchen staff (the policy limits whose row)
    if v_actor_role is distinct from 'manager' then new.active := old.active; end if;
    new.status := old.status;
    new.rejection_reason := old.rejection_reason;
    new.email := old.email;
  end if;
  return new;
end;
$function$;

create or replace function public.active_order_statuses()
returns text[] language sql immutable as $$ select array['received', 'preparing', 'ready', 'out_for_delivery'] $$;

-- The student's current (not self-closed) student shop, any status.
create or replace function public.my_student_shop_id(p_uid uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.stores
   where manager_id = p_uid and seller_kind = 'student' and archived_by is distinct from manager_id
   limit 1
$$;

-- Does the closing; callers have already checked who is asking.
create or replace function public.close_student_shop_internal(p_store uuid, p_owner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_claims text := current_setting('request.jwt.claims', true);
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('clickfood.account_cleanup', 'on', true);
  delete from public.menu_items where store_id = p_store;
  update public.stores
     set status = 'archived', is_published = false, store_closed = true,
         archived_by = p_owner, archived_at = now(), archived_reason = 'Deleted by the student'
   where id = p_store;
  delete from public.seller_profiles where store_id = p_store;
  update public.profiles set store_id = null where id = p_owner and store_id = p_store;
  perform set_config('clickfood.account_cleanup', 'off', true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
end $$;
revoke all on function public.close_student_shop_internal(uuid, uuid) from public, anon, authenticated;

create or replace function public.delete_student_shop()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_store uuid;
  n int;
begin
  if v_uid is null then raise exception 'Please sign in first.'; end if;
  v_store := public.my_student_shop_id(v_uid);
  if v_store is null then raise exception 'You don''t have a shop.'; end if;
  select count(*) into n from public.orders where store_id = v_store and status = any (public.active_order_statuses());
  if n > 0 then
    raise exception 'Your shop has % order(s) in progress. Complete or cancel them first.', n;
  end if;
  perform public.close_student_shop_internal(v_store, v_uid);
end $$;
revoke all on function public.delete_student_shop() from public, anon;
grant execute on function public.delete_student_shop() to authenticated;

create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = public, auth as $$
declare
  v_uid uuid := auth.uid();
  v_prof public.profiles;
  v_store uuid;
  v_claims text := current_setting('request.jwt.claims', true);
  n int;
begin
  if v_uid is null then raise exception 'Please sign in first.'; end if;
  select * into v_prof from public.profiles where id = v_uid;
  if not found or v_prof.role <> 'customer' then
    raise exception 'This account can''t be deleted here. Contact ClickFood.';
  end if;
  select count(*) into n from public.orders where customer_id = v_uid and status = any (public.active_order_statuses());
  if n > 0 then
    raise exception 'You have % order(s) in progress. Wait until they are completed or cancelled.', n;
  end if;
  v_store := public.my_student_shop_id(v_uid);
  if v_store is not null then
    select count(*) into n from public.orders where store_id = v_store and status = any (public.active_order_statuses());
    if n > 0 then
      raise exception 'Your shop has % order(s) in progress. Complete or cancel them first.', n;
    end if;
    perform public.close_student_shop_internal(v_store, v_uid);
  end if;

  perform set_config('request.jwt.claims', '', true);
  perform set_config('clickfood.account_cleanup', 'on', true);

  -- personal data that has no reason to outlive the account
  delete from public.notifications where user_id = v_uid;
  delete from public.timetable_entries where student_id = v_uid;
  delete from public.timetable_shares where owner_id = v_uid;
  delete from public.push_subscriptions where user_id = v_uid;
  delete from public.payment_methods where customer_id = v_uid;
  delete from public.customer_budgets where customer_id = v_uid;
  delete from public.budget_alerts_sent where customer_id = v_uid;
  delete from public.food_list_members where user_id = v_uid;
  delete from public.food_lists where owner_id = v_uid;
  delete from public.login_events where user_id = v_uid;
  update public.reviews set comment = '' where customer_id = v_uid;
  update public.stores set manager_name = 'Deleted student', manager_email = null where manager_id = v_uid and seller_kind = 'student';

  -- the profile stays only as an anonymous row for past orders
  update public.profiles set
    role = 'deleted', name = 'Deleted student', email = null, phone = null, avatar_url = null,
    student_number = null, default_location = null, home_address = null, home_lat = null, home_lng = null,
    university = null, campus_location = null, store_id = null, active = false
   where id = v_uid;

  -- the login: email freed, nothing left to sign in with
  update auth.users set
    email = 'deleted-' || v_uid::text || '@deleted.invalid', email_change = '', phone = null,
    encrypted_password = null, raw_user_meta_data = '{}'::jsonb,
    banned_until = 'infinity', deleted_at = now()
   where id = v_uid;
  delete from auth.identities where user_id = v_uid;
  delete from auth.mfa_factors where user_id = v_uid;
  delete from auth.one_time_tokens where user_id = v_uid;
  delete from auth.refresh_tokens where user_id = v_uid::text;
  delete from auth.sessions where user_id = v_uid;

  perform set_config('clickfood.account_cleanup', 'off', true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- No "your shop was removed" message when the student closed it themselves.
create or replace function public.notify_student_shop_review()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.seller_kind <> 'student' or new.status is not distinct from old.status then return new; end if;
  if new.status = 'approved' then
    insert into public.notifications (user_id, message, type) values (new.manager_id,
      'Your shop ' || new.name || ' is approved. Add ' || public.student_shop_min_products() || ' products, and publish once they are approved.', 'store_approved');
  elsif new.status = 'rejected' then
    insert into public.notifications (user_id, message, type) values (new.manager_id,
      'Your shop ' || new.name || ' was not approved' || coalesce(': ' || nullif(btrim(new.rejection_reason), ''), '.') , 'store_rejected');
  elsif new.status = 'archived' and new.archived_by is distinct from new.manager_id then
    insert into public.notifications (user_id, message, type) values (new.manager_id, 'Your shop ' || new.name || ' was removed from ClickFood.', 'store_removed');
  end if;
  return new;
end $$;
