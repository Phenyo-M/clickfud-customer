-- ============================================================
-- ClickFood: addresses on a map + student shop review (2026-10-12)
-- Runs after student_sellers.sql.
--
--  * every student keeps a home address with a map pin
--    (profiles.home_address / home_lat / home_lng); the app sorts food
--    by distance from it
--  * student shops have a pickup address + pin and a required shop photo
--  * "Are you a hustleUP member?" is stored on seller_profiles
--  * a new student shop waits for developer review (status 'pending')
--  * after approval the seller publishes it, which needs 5 products the
--    developer approved; dropping below 5 hides the shop again
--
-- Safe to run more than once. Rollback: seller_review_address_rollback.sql
-- ============================================================

-- ---------- 1. Columns ----------
alter table public.profiles add column if not exists home_address text;
alter table public.profiles add column if not exists home_lat double precision;
alter table public.profiles add column if not exists home_lng double precision;
do $$ begin
  alter table public.profiles add constraint profiles_home_pin_valid check (
    (home_lat is null and home_lng is null)
    or (home_lat between -90 and 90 and home_lng between -180 and 180));
exception when duplicate_object then null; end $$;

alter table public.stores add column if not exists pickup_lat double precision;
alter table public.stores add column if not exists pickup_lng double precision;
do $$ begin
  alter table public.stores add constraint stores_pickup_pin_valid check (
    (pickup_lat is null and pickup_lng is null)
    or (pickup_lat between -90 and 90 and pickup_lng between -180 and 180));
exception when duplicate_object then null; end $$;

alter table public.seller_profiles add column if not exists hustleup_member boolean not null default false;

-- Roughly South Africa: a pin outside it is a mistake.
create or replace function public.pin_in_sa(p_lat double precision, p_lng double precision)
returns boolean language sql immutable as $$
  select p_lat between -35.5 and -21.5 and p_lng between 16 and 33.5
$$;

create or replace function public.student_shop_min_products()
returns integer language sql immutable as $$ select 5 $$;

create or replace function public.approved_product_count(p_store uuid)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from public.menu_items where store_id = p_store and status = 'approved'
$$;

-- ---------- 2. Becoming a seller: now goes to review ----------
drop function if exists public.become_student_seller(text, text, text[], text, text, text, text, boolean);

create or replace function public.become_student_seller(
  p_business_name text, p_whatsapp text, p_categories text[], p_other_food text,
  p_campus text, p_description text, p_logo_url text, p_cover_url text,
  p_address text, p_lat double precision, p_lng double precision,
  p_hustleup boolean, p_accept_rules boolean)
returns public.stores
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_prof public.profiles;
  v_user record;
  v_name text := btrim(coalesce(p_business_name, ''));
  v_wa text := public.normalize_sa_whatsapp(p_whatsapp);
  v_cats text[];
  v_other text := nullif(btrim(left(coalesce(p_other_food, ''), 120)), '');
  v_campus text := nullif(btrim(coalesce(p_campus, '')), '');
  v_cover text := nullif(btrim(left(coalesce(p_cover_url, ''), 500)), '');
  v_address text := btrim(left(coalesce(p_address, ''), 160));
  v_claims text := current_setting('request.jwt.claims', true);
  v_slug text;
  s public.stores;
begin
  if v_uid is null then raise exception 'Please sign in first.'; end if;
  select * into v_prof from public.profiles where id = v_uid;
  if not found or v_prof.role <> 'customer' or not coalesce(v_prof.active, true) then
    raise exception 'Only student accounts can open a student food shop.';
  end if;
  select email, email_confirmed_at into v_user from auth.users where id = v_uid;
  if not public.is_up_student_email(v_user.email) then
    raise exception 'Student entrepreneur registration requires an official University of Pretoria student email address.';
  end if;
  if v_user.email_confirmed_at is null then raise exception 'Please verify your email address first.'; end if;
  -- a shop the student closed themselves (account_deletion.sql) doesn't count
  if exists (select 1 from public.stores where manager_id = v_uid and archived_by is distinct from manager_id) then raise exception 'You already have a shop.'; end if;
  if length(v_name) < 2 or length(v_name) > 60 then
    raise exception 'Please enter your food business name (2 to 60 characters).';
  end if;
  if coalesce(public.non_food_word(v_name), public.alcohol_word(v_name)) is not null then
    raise exception 'ClickFood is for food sellers only.';
  end if;
  if v_wa is null then raise exception 'Please enter a valid South African WhatsApp number.'; end if;
  select array_agg(distinct c) into v_cats from unnest(coalesce(p_categories, '{}')) c where c is not null;
  if v_cats is null or not (v_cats <@ public.student_food_categories()) then
    raise exception 'Please choose the food categories you sell.';
  end if;
  if 'Other Food' = any (v_cats) and v_other is null then raise exception 'Please say what other food you sell.'; end if;
  if public.non_food_word(v_other) is not null then raise exception 'ClickFood is for food sellers only.'; end if;
  if v_campus is null or not (v_campus = any (array['Hatfield', 'Hillcrest', 'Groenkloof', 'Prinshof', 'Mamelodi', 'Onderstepoort', 'GIBS'])) then
    raise exception 'Please choose your campus.';
  end if;
  if v_cover is null or v_cover !~ '^https://' then raise exception 'Please add a photo of your shop.'; end if;
  if length(v_address) < 5 then raise exception 'Please enter your pickup address.'; end if;
  if p_lat is null or p_lng is null or not public.pin_in_sa(p_lat, p_lng) then
    raise exception 'Please put your pickup point on the map.';
  end if;
  if p_hustleup is null then raise exception 'Please say if you are a hustleUP member.'; end if;
  if not coalesce(p_accept_rules, false) then raise exception 'Please accept the seller rules.'; end if;

  v_slug := trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g')) || '-' || substr(replace(v_uid::text, '-', ''), 1, 6);

  -- Act as the server for these writes. The shop starts PENDING and
  -- unpublished: the developer reviews it first.
  perform set_config('request.jwt.claims', '', true);
  insert into public.stores (manager_id, name, slug, description, category, logo_url, cover_image_url, campus_location, address,
                             pickup_lat, pickup_lng, university, seller_kind, status, is_published, commission_percent,
                             accepts_delivery, accepts_collection, delivery_fee, prep_time_min, prep_time_max,
                             opening_time, closing_time, closed_days, weekly_hours, business_type,
                             product_categories, terms_accepted_at, manager_name, manager_email)
  values (v_uid, v_name, v_slug, btrim(left(coalesce(p_description, ''), 300)), 'Student Food',
          nullif(btrim(left(coalesce(p_logo_url, ''), 500)), ''), v_cover, v_campus, v_address,
          p_lat, p_lng, 'University of Pretoria', 'student', 'pending', false, 0,
          false, true, 0, 10, 30,
          '00:00', '00:00', '{}', null, 'other',
          v_cats, now(), v_prof.name, v_user.email)
  returning * into s;
  insert into public.seller_profiles (store_id, owner_id, whatsapp, food_categories, other_food, rules_accepted_at, hustleup_member)
  values (s.id, v_uid, v_wa, v_cats, case when 'Other Food' = any (v_cats) then v_other end, now(), p_hustleup);
  update public.profiles set store_id = s.id where id = v_uid and store_id is null;
  insert into public.notifications (user_id, message, type)
  select id, 'New student shop to review: ' || v_name || case when p_hustleup then ' (hustleUP member)' else '' end || '.', 'store_review'
    from public.profiles where role = 'developer';
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return s;
end $$;
revoke all on function public.become_student_seller(text, text, text[], text, text, text, text, text, text, double precision, double precision, boolean, boolean) from public, anon;
grant execute on function public.become_student_seller(text, text, text[], text, text, text, text, text, text, double precision, double precision, boolean, boolean) to authenticated;

create or replace function public.set_hustleup_member(p_member boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.current_seller_store_id();
begin
  if v_store is null then raise exception 'You don''t have a student shop.'; end if;
  update public.seller_profiles set hustleup_member = coalesce(p_member, false), updated_at = now() where store_id = v_store;
end $$;
revoke all on function public.set_hustleup_member(boolean) from public, anon;
grant execute on function public.set_hustleup_member(boolean) to authenticated;

-- ---------- 3. A student shop can't lose its photo or pickup pin ----------
-- (Shops opened before this rule may not have them yet: they can add them
-- one at a time; publishing needs both.)
create or replace function public.validate_student_shop()
returns trigger language plpgsql as $$
begin
  if new.seller_kind <> 'student' or auth.uid() is null or public."current_role"() = 'developer' then return new; end if;
  if coalesce(btrim(new.cover_image_url), '') = '' and coalesce(btrim(old.cover_image_url), '') <> '' then
    raise exception 'Please add a photo of your shop.' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(new.address, ''))) < 5 and length(btrim(coalesce(old.address, ''))) >= 5 then
    raise exception 'Please enter your pickup address.' using errcode = 'P0001';
  end if;
  if (new.pickup_lat is null or new.pickup_lng is null) and old.pickup_lat is not null then
    raise exception 'Please put your pickup point on the map.' using errcode = 'P0001';
  end if;
  if new.pickup_lat is not null and not public.pin_in_sa(new.pickup_lat, new.pickup_lng) then
    raise exception 'Please put your pickup point on the map.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_validate_student_shop on public.stores;
create trigger trg_validate_student_shop before update on public.stores
  for each row execute function public.validate_student_shop();

-- ---------- 4. Publishing: approved shop + 5 approved products ----------
create or replace function public.publish_student_shop()
returns public.stores
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.current_seller_store_id();
  v_claims text := current_setting('request.jwt.claims', true);
  s public.stores;
  n int;
begin
  if v_store is null then raise exception 'You don''t have a student shop.'; end if;
  select * into s from public.stores where id = v_store;
  if s.status <> 'approved' then raise exception 'Your shop is still being reviewed.'; end if;
  if coalesce(btrim(s.cover_image_url), '') = '' or s.pickup_lat is null then
    raise exception 'Add a shop photo and your pickup point first (Shop tab).';
  end if;
  n := public.approved_product_count(v_store);
  if n < public.student_shop_min_products() then
    raise exception 'You need % approved products to publish (you have %).', public.student_shop_min_products(), n;
  end if;
  perform set_config('request.jwt.claims', '', true);
  update public.stores set is_published = true, publish_rejection_reason = null where id = v_store returning * into s;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return s;
end $$;
revoke all on function public.publish_student_shop() from public, anon;
grant execute on function public.publish_student_shop() to authenticated;

-- Fewer than 5 approved products (deleted, rejected, suspended, edited
-- back to pending): the shop is hidden until it has 5 again.
create or replace function public.recheck_student_shop_published()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := coalesce(new.store_id, old.store_id);
  v_claims text;
  v_owner uuid;
begin
  if not exists (select 1 from public.stores where id = v_store and seller_kind = 'student' and is_published) then
    return null;
  end if;
  if public.approved_product_count(v_store) >= public.student_shop_min_products() then return null; end if;
  v_claims := current_setting('request.jwt.claims', true);
  perform set_config('request.jwt.claims', '', true);
  update public.stores set is_published = false where id = v_store returning manager_id into v_owner;
  insert into public.notifications (user_id, message, type)
  values (v_owner, 'Your shop is hidden until it has ' || public.student_shop_min_products() || ' approved products again.', 'shop_hidden');
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return null;
end $$;
drop trigger if exists trg_recheck_student_shop_published on public.menu_items;
create trigger trg_recheck_student_shop_published after update or delete on public.menu_items
  for each row execute function public.recheck_student_shop_published();

-- ---------- 5. Orders only for live student shops ----------
create or replace function public.student_order_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_published boolean;
begin
  select manager_id, is_published into v_owner, v_published from public.stores where id = new.store_id and seller_kind = 'student';
  if not found then return new; end if;
  if not coalesce(v_published, false) then
    raise exception 'This shop isn''t open on ClickFood yet.' using errcode = 'P0001';
  end if;
  if new.customer_id = v_owner then
    raise exception 'You can''t order from your own shop.' using errcode = 'P0001';
  end if;
  new.status := 'received';
  new.payment_method := 'cod';
  new.payment_status := 'pending';
  new.promo_code := null;
  new.discount := 0;
  new.delivery_fee := 0;
  new.platform_fee_amount := 0;
  new.delivery_location := coalesce(new.delivery_location, '{}'::jsonb)
    || jsonb_build_object('fulfilment', 'collection', 'payment', 'direct',
                          'customerName', public.first_name_of(new.customer_id));
  return new;
end $$;

-- ---------- 6. Tell the seller when the developer decides ----------
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
  elsif new.status = 'archived' then
    insert into public.notifications (user_id, message, type) values (new.manager_id, 'Your shop ' || new.name || ' was removed from ClickFood.', 'store_removed');
  end if;
  return new;
end $$;
drop trigger if exists trg_notify_student_shop_review on public.stores;
create trigger trg_notify_student_shop_review after update of status on public.stores
  for each row execute function public.notify_student_shop_review();
