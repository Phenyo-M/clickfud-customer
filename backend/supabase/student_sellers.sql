-- ============================================================
-- ClickFood: student food sellers (2026-10-11)
--
-- A student seller keeps their normal customer account (verified
-- @tuks.co.za, so they can still buy food) and owns ONE "student shop":
-- a stores row with seller_kind = 'student'. That reuses the existing
-- menu approval workflow, cart, orders, live tracking and reviews.
--
-- What is different for a student shop:
--   * food only: fixed categories + a non-food word check (server side)
--   * no online payment: orders are requests the customer pays the
--     seller for directly; ClickFood never marks them paid
--   * no platform fee, no promo codes, no timed collection window
--   * the seller moves orders on with seller_update_order() only
--   * WhatsApp number lives in seller_profiles (not public) and is only
--     handed to signed-in students through seller_contact()
--
-- Safe to run more than once. Rollback: student_sellers_rollback.sql
-- ============================================================

-- ---------- 1. Columns ----------
alter table public.stores add column if not exists seller_kind text not null default 'business';
do $$ begin
  alter table public.stores add constraint stores_seller_kind_check check (seller_kind in ('business', 'student'));
exception when duplicate_object then null; end $$;
create unique index if not exists stores_one_student_shop_per_owner on public.stores (manager_id) where seller_kind = 'student';

alter table public.menu_items add column if not exists other_food_detail text;

-- Wider category list (old values kept so existing shops are untouched).
alter table public.menu_items drop constraint if exists menu_items_category_check;
alter table public.menu_items add constraint menu_items_category_check check (category = any (array[
  'Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Drinks', 'Desserts', 'Specials',
  'Fast Food', 'Traditional', 'Baked Goods', 'Other Food']));

-- ---------- 2. Helpers ----------
create or replace function public.student_food_categories()
returns text[] language sql immutable as $$
  select array['Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Fast Food', 'Traditional',
               'Baked Goods', 'Desserts', 'Drinks', 'Other Food']::text[]
$$;

create or replace function public.is_student_store(p_store uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.stores where id = p_store and seller_kind = 'student')
$$;

-- The caller's own student shop, while it hasn't been removed.
create or replace function public.current_seller_store_id()
returns uuid language sql stable security definer set search_path = public as $$
  select s.id from public.stores s
   where s.manager_id = auth.uid() and s.seller_kind = 'student' and s.status <> 'archived'
   limit 1
$$;

-- South African mobile -> 27XXXXXXXXX, or null when it isn't one.
create or replace function public.normalize_sa_whatsapp(p text)
returns text language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g');
begin
  if d ~ '^0[6-8][0-9]{8}$' then d := '27' || substr(d, 2); end if;
  if d ~ '^27[6-8][0-9]{8}$' then return d; end if;
  return null;
end $$;

-- Returns the offending word when text looks like a non-food listing.
-- Words that also appear in normal food ("jacket potatoes", "mushroom
-- caps", "onion rings") are left out on purpose; developer review is
-- the second check.
create or replace function public.non_food_word(p text)
returns text language sql immutable as $$
  select (regexp_match(lower(coalesce(p, '')),
    '\m(t-?shirts?|shirts?|hoodies?|jeans|dress|dresses|skirts?|sneakers?|shoes|socks|clothing|clothes|'
    || 'watch|watches|jewel(le)?ry|necklaces?|bracelets?|earrings?|accessories|handbags?|wallets?|sunglasses|wigs?|'
    || 'perfumes?|lipsticks?|make-?up|cosmetics|nail polish|'
    || 'phones?|iphones?|chargers?|earphones|headphones|airpods|laptops?|cables?|electronics|'
    || 'stationery|pens|pencils?|notebooks?|calculators?|textbooks?|'
    || 'cigarettes?|vapes?|vaping|hookah|tobacco|weed|dagga|cannabis|edibles)\M'))[1]
$$;

-- Alcohol: checked on the product name, and on the description of drinks
-- (so "red wine sauce" in a dinner description is still fine).
create or replace function public.alcohol_word(p text)
returns text language sql immutable as $$
  select (regexp_match(lower(coalesce(p, '')),
    '\m(beers?|wines?|vodka|whisk(e)?y|gin|brandy|rum|tequila|liquor|alcohol|alcoholic|ciders?|champagne|cocktails?|shots)\M'))[1]
$$;

-- ---------- 3. Seller profile (private) ----------
create table if not exists public.seller_profiles (
  store_id uuid primary key references public.stores(id) on delete cascade,
  owner_id uuid not null unique references public.profiles(id) on delete cascade,
  whatsapp text not null check (whatsapp ~ '^27[6-8][0-9]{8}$'),
  food_categories text[] not null check (cardinality(food_categories) > 0 and food_categories <@ public.student_food_categories()),
  other_food text check (other_food is null or length(other_food) <= 120),
  rules_accepted_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.seller_profiles enable row level security;
drop policy if exists "seller profile own or developer" on public.seller_profiles;
create policy "seller profile own or developer" on public.seller_profiles for select
  using (owner_id = auth.uid() or public."current_role"() = 'developer');
-- no insert/update/delete policies: writes go through the functions below
revoke all on public.seller_profiles from anon;
revoke insert, update, delete on public.seller_profiles from authenticated;
grant select on public.seller_profiles to authenticated;

-- ---------- 4. Becoming a seller ----------
create or replace function public.become_student_seller(
  p_business_name text, p_whatsapp text, p_categories text[], p_other_food text,
  p_campus text, p_description text, p_logo_url text, p_accept_rules boolean)
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
  if v_user.email_confirmed_at is null then
    raise exception 'Please verify your email address first.';
  end if;
  if exists (select 1 from public.stores where manager_id = v_uid) then
    raise exception 'You already have a shop.';
  end if;
  if length(v_name) < 2 or length(v_name) > 60 then
    raise exception 'Please enter your food business name (2 to 60 characters).';
  end if;
  if coalesce(public.non_food_word(v_name), public.alcohol_word(v_name)) is not null then
    raise exception 'ClickFood is for food sellers only.';
  end if;
  if v_wa is null then
    raise exception 'Please enter a valid South African WhatsApp number.';
  end if;
  select array_agg(distinct c) into v_cats from unnest(coalesce(p_categories, '{}')) c where c is not null;
  if v_cats is null or not (v_cats <@ public.student_food_categories()) then
    raise exception 'Please choose the food categories you sell.';
  end if;
  if 'Other Food' = any (v_cats) and v_other is null then
    raise exception 'Please say what other food you sell.';
  end if;
  if public.non_food_word(v_other) is not null then
    raise exception 'ClickFood is for food sellers only.';
  end if;
  if v_campus is null or not (v_campus = any (array['Hatfield', 'Hillcrest', 'Groenkloof', 'Prinshof', 'Mamelodi', 'Onderstepoort', 'GIBS'])) then
    raise exception 'Please choose your campus.';
  end if;
  if not coalesce(p_accept_rules, false) then
    raise exception 'Please accept the seller rules.';
  end if;

  v_slug := trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g')) || '-' || substr(replace(v_uid::text, '-', ''), 1, 6);

  -- Act as the server for these writes, so the shop starts approved and
  -- live (its products still each need developer approval).
  perform set_config('request.jwt.claims', '', true);
  insert into public.stores (manager_id, name, slug, description, category, logo_url, campus_location, address,
                             university, seller_kind, status, is_published, commission_percent,
                             accepts_delivery, accepts_collection, delivery_fee, prep_time_min, prep_time_max,
                             opening_time, closing_time, closed_days, weekly_hours, business_type,
                             product_categories, terms_accepted_at, manager_name, manager_email)
  values (v_uid, v_name, v_slug, btrim(left(coalesce(p_description, ''), 300)), 'Student Food',
          nullif(btrim(left(coalesce(p_logo_url, ''), 500)), ''), v_campus, v_campus || ' campus',
          'University of Pretoria', 'student', 'approved', true, 0,
          false, true, 0, 10, 30,
          '00:00', '00:00', '{}', null, 'other',
          v_cats, now(), v_prof.name, v_user.email)
  returning * into s;
  insert into public.seller_profiles (store_id, owner_id, whatsapp, food_categories, other_food, rules_accepted_at)
  values (s.id, v_uid, v_wa, v_cats, case when 'Other Food' = any (v_cats) then v_other end, now());
  update public.profiles set store_id = s.id where id = v_uid and store_id is null;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return s;
end $$;
revoke all on function public.become_student_seller(text, text, text[], text, text, text, text, boolean) from public, anon;
grant execute on function public.become_student_seller(text, text, text[], text, text, text, text, boolean) to authenticated;

create or replace function public.update_seller_profile(p_whatsapp text, p_categories text[], p_other_food text)
returns public.seller_profiles
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.current_seller_store_id();
  v_wa text := public.normalize_sa_whatsapp(p_whatsapp);
  v_cats text[];
  v_other text := nullif(btrim(left(coalesce(p_other_food, ''), 120)), '');
  sp public.seller_profiles;
begin
  if v_store is null then raise exception 'You don''t have a student shop.'; end if;
  if v_wa is null then raise exception 'Please enter a valid South African WhatsApp number.'; end if;
  select array_agg(distinct c) into v_cats from unnest(coalesce(p_categories, '{}')) c where c is not null;
  if v_cats is null or not (v_cats <@ public.student_food_categories()) then
    raise exception 'Please choose the food categories you sell.';
  end if;
  if 'Other Food' = any (v_cats) and v_other is null then raise exception 'Please say what other food you sell.'; end if;
  if public.non_food_word(v_other) is not null then raise exception 'ClickFood is for food sellers only.'; end if;
  update public.seller_profiles
     set whatsapp = v_wa, food_categories = v_cats,
         other_food = case when 'Other Food' = any (v_cats) then v_other end, updated_at = now()
   where store_id = v_store returning * into sp;
  update public.stores set product_categories = v_cats where id = v_store;
  return sp;
end $$;
revoke all on function public.update_seller_profile(text, text[], text) from public, anon;
grant execute on function public.update_seller_profile(text, text[], text) to authenticated;

-- WhatsApp number of a live student shop, for signed-in users only.
create or replace function public.seller_contact(p_store_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select sp.whatsapp from public.seller_profiles sp
    join public.stores s on s.id = sp.store_id
   where sp.store_id = p_store_id and auth.uid() is not null
     and s.seller_kind = 'student' and s.status = 'approved' and s.is_published
$$;
revoke all on function public.seller_contact(uuid) from public, anon;
grant execute on function public.seller_contact(uuid) to authenticated;

-- ---------- 5. Shop row protection ----------
-- Only the server/developer may change which kind of shop a row is, and a
-- student shop never earns ClickFood commission.
create or replace function public.protect_store_seller_kind()
returns trigger language plpgsql as $$
begin
  if auth.uid() is null or public."current_role"() = 'developer' then return new; end if;
  if tg_op = 'INSERT' then
    new.seller_kind := 'business';
  elsif new.seller_kind is distinct from old.seller_kind then
    new.seller_kind := old.seller_kind;
  end if;
  if new.seller_kind = 'student' then
    new.commission_percent := 0;
    new.accepts_delivery := false;
    new.delivery_fee := 0;
  end if;
  return new;
end $$;
drop trigger if exists trg_protect_store_seller_kind on public.stores;
create trigger trg_protect_store_seller_kind before insert or update on public.stores
  for each row execute function public.protect_store_seller_kind();

-- ---------- 6. Products: food only ----------
create or replace function public.enforce_student_menu_item()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_word text;
begin
  if not public.is_student_store(new.store_id) then return new; end if;
  new.platform_fee_amount := 0;
  if not (new.category = any (public.student_food_categories())) then
    raise exception 'Please choose a food category.' using errcode = 'P0001';
  end if;
  new.other_food_detail := nullif(btrim(left(coalesce(new.other_food_detail, ''), 120)), '');
  if new.category = 'Other Food' and new.other_food_detail is null then
    raise exception 'Please say what food this is.' using errcode = 'P0001';
  end if;
  if new.category <> 'Other Food' then new.other_food_detail := null; end if;
  if new.price is null or new.price <= 0 or new.price > 1000 then
    raise exception 'Please enter a price between R1 and R1000.' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(new.name, ''))) < 2 then
    raise exception 'Please enter the food name.' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(new.description, ''))) < 10 then
    raise exception 'Please describe the food (at least 10 characters).' using errcode = 'P0001';
  end if;
  v_word := coalesce(public.non_food_word(new.name), public.non_food_word(new.description), public.non_food_word(new.other_food_detail),
                     public.alcohol_word(new.name), public.alcohol_word(new.other_food_detail),
                     case when new.category = 'Drinks' then public.alcohol_word(new.description) end);
  if v_word is not null then
    raise exception 'Only food can be sold on ClickFood ("%" isn''t allowed).', v_word using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_enforce_student_menu_item on public.menu_items;
create trigger trg_enforce_student_menu_item before insert or update on public.menu_items
  for each row execute function public.enforce_student_menu_item();

drop policy if exists "menu student seller insert" on public.menu_items;
create policy "menu student seller insert" on public.menu_items for insert
  with check (public."current_role"() = 'customer' and store_id = public.current_seller_store_id());
drop policy if exists "menu student seller update" on public.menu_items;
create policy "menu student seller update" on public.menu_items for update
  using (public."current_role"() = 'customer' and store_id = public.current_seller_store_id())
  with check (public."current_role"() = 'customer' and store_id = public.current_seller_store_id());
drop policy if exists "menu student seller delete" on public.menu_items;
create policy "menu student seller delete" on public.menu_items for delete
  using (public."current_role"() = 'customer' and store_id = public.current_seller_store_id());

-- ---------- 7. Orders ----------
drop policy if exists "orders select student seller" on public.orders;
create policy "orders select student seller" on public.orders for select
  using (store_id = public.current_seller_store_id());

-- Runs right after guard_customer_order_insert (trigger names sort).
create or replace function public.student_order_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  select manager_id into v_owner from public.stores where id = new.store_id and seller_kind = 'student';
  if not found then return new; end if;
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
drop trigger if exists trg_ab_student_order_insert on public.orders;
create trigger trg_ab_student_order_insert before insert on public.orders
  for each row execute function public.student_order_insert();

create or replace function public.notify_student_seller()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  select manager_id into v_owner from public.stores where id = new.store_id and seller_kind = 'student';
  if v_owner is not null then
    insert into public.notifications (user_id, message, type)
    values (v_owner, 'New order ' || coalesce(new.order_number, '') || ' from ' || public.first_name_of(new.customer_id) || '.', 'seller_order');
  end if;
  return new;
end $$;
drop trigger if exists trg_notify_student_seller on public.orders;
create trigger trg_notify_student_seller after insert on public.orders
  for each row execute function public.notify_student_seller();

-- Seller moves an order on: accept -> ready -> complete, or cancel.
-- Never touches payment: ClickFood doesn't know if the seller was paid.
create or replace function public.seller_update_order(p_order_id uuid, p_action text, p_reason text default null, p_note text default null)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.current_seller_store_id();
  o public.orders;
  v_new text;
  v_msg text;
  v_shop text;
begin
  if v_store is null then raise exception 'You don''t have a student shop.'; end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found or o.store_id is distinct from v_store then raise exception 'Order not found.'; end if;
  select name into v_shop from public.stores where id = v_store;

  if p_action = 'accept' and o.status = 'received' then
    v_new := 'preparing'; v_msg := v_shop || ' accepted your order ' || o.order_number || ' and is preparing it.';
  elsif p_action = 'ready' and o.status in ('received', 'preparing') then
    v_new := 'ready'; v_msg := 'Your order ' || o.order_number || ' from ' || v_shop || ' is ready. Arrange collection with the seller.';
  elsif p_action = 'complete' and o.status = 'ready' then
    v_new := 'collected'; v_msg := 'Order ' || o.order_number || ' completed. Enjoy your meal!';
  elsif p_action = 'cancel' and o.status in ('received', 'preparing', 'ready') then
    if p_reason is null or p_reason not in ('product_unavailable', 'kitchen_cancelled', 'other') then
      raise exception 'Please choose a reason.';
    end if;
    v_new := 'cancelled';
    v_msg := 'Sorry, ' || v_shop || ' cancelled your order ' || o.order_number || '.'
      || case when p_reason = 'product_unavailable' then ' An item is no longer available.'
              when nullif(btrim(coalesce(p_note, '')), '') is not null then ' ' || left(btrim(p_note), 200)
              else '' end;
  else
    raise exception 'This order can''t be changed like that any more.';
  end if;

  update public.orders set
    status = v_new,
    cancel_reason = case when v_new = 'cancelled' then p_reason else cancel_reason end,
    cancel_note = case when v_new = 'cancelled' then nullif(left(btrim(coalesce(p_note, '')), 200), '') else cancel_note end,
    status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object('status', v_new, 'at', now(), 'by', 'seller')
   where id = o.id returning * into o;
  insert into public.notifications (user_id, message, type)
  values (o.customer_id, v_msg, case v_new when 'cancelled' then 'order_cancelled' when 'collected' then 'delivered' else v_new end);
  return o;
end $$;
revoke all on function public.seller_update_order(uuid, text, text, text) from public, anon;
grant execute on function public.seller_update_order(uuid, text, text, text) to authenticated;

-- ---------- 8. No timed collection window / code for student orders ----------
create or replace function public.generate_collection_code()
returns trigger language plpgsql set search_path = public as $function$
begin
  if public.is_student_store(new.store_id) then return new; end if;
  if new.status = 'ready' and old.status is distinct from 'ready'
     and coalesce(new.delivery_location->>'fulfilment', '') = 'collection' then
    if new.collection_token is null then
      new.collection_token := gen_random_uuid();
    end if;
    if new.collection_code is null then
      new.collection_code := upper(substr(replace(coalesce(new.collection_token, gen_random_uuid())::text, '-', ''), 1, 6));
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.track_collection_window()
returns trigger language plpgsql security definer set search_path = public as $function$
declare
  v_deadline timestamptz;
begin
  if coalesce(new.delivery_location->>'fulfilment', '') <> 'collection' then
    return new;
  end if;
  if public.is_student_store(new.store_id) then return new; end if;
  if new.status = 'ready' and old.status is distinct from 'ready' then
    v_deadline := greatest(now(), coalesce(new.rescheduled_for, now()))
                  + make_interval(mins => public.collection_setting('window'));
    new.ready_at := now();
    new.original_ready_at := coalesce(old.original_ready_at, now());
    new.collection_deadline := v_deadline;
    new.original_collection_deadline := coalesce(old.original_collection_deadline, v_deadline);
    new.collection_state := case when coalesce(new.reschedule_count, 0) > 0 then 'rescheduled' else 'window' end;
    new.collection_response_deadline := null;
    new.needs_reprep := false;
    new.released_at := null; -- freshly made: this food is here
  end if;
  if new.status = 'collected' and old.status is distinct from 'collected' then
    new.collection_state := 'collected';
    new.collection_response_deadline := null;
  end if;
  return new;
end;
$function$;
