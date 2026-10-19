-- ============================================================
-- CLICKFOOD, ordering distance rule + campus coordinates (2026-10-17)
-- Needs open_signup_students.sql (set_my_student_status) and
-- tut_campuses.sql (campuses.latitude/longitude) first.
--
-- * platform_config.max_order_distance_km (default 30) and
--   order_distance_rule (on/off): developer only (dev_set_order_distance).
-- * Distance = straight-line (great-circle, Haversine) km between the
--   customer's ORDERING LOCATION and the shop's pickup pin. <= max is OK.
-- * Ordering location, chosen per order (orders.delivery_location
--   ->'orderLocation'):
--     {"mode":"saved"}                 the profile's saved location
--                                      (home_lat/home_lng), read HERE,
--                                      never taken from the request
--     {"mode":"current","lat":..,"lng":..}  the phone's position at checkout
--   The coordinates are checked, then removed from the order (only the mode
--   and the km are kept): no GPS history is stored.
-- * A shop without a pin can't take orders while the rule is on.
-- * Students: the saved location must be within the max distance of their
--   campus, when that campus has coordinates. Changing campus re-checks it.
-- * Campus coordinates: only set by a developer (dev_set_campus_location),
--   with a source; never guessed.
-- Safe to run more than once. Rollback: order_distance_rollback.sql
-- ============================================================

alter table public.platform_config add column if not exists max_order_distance_km numeric(6,2) not null default 30;
alter table public.platform_config add column if not exists order_distance_rule boolean not null default true;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'platform_config_max_order_distance_check') then
    alter table public.platform_config add constraint platform_config_max_order_distance_check check (max_order_distance_km between 1 and 500);
  end if;
end $$;

-- everyone may read the rule (the app shows it); only developers change it
create or replace function public.public_app_flags()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'show_partner_shops', coalesce((select show_partner_shops from public.platform_config where id = 1), false),
    'online_payments', coalesce((select online_payments_enabled from public.platform_config where id = 1), true),
    'show_recessbox', coalesce((select show_recessbox from public.platform_config where id = 1), false),
    'max_order_km', coalesce((select max_order_distance_km from public.platform_config where id = 1), 30),
    'distance_rule', coalesce((select order_distance_rule from public.platform_config where id = 1), true))
$$;
revoke all on function public.public_app_flags() from public;
grant execute on function public.public_app_flags() to anon, authenticated;

create or replace function public.dev_set_order_distance(p_km numeric, p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if public."current_role"() is distinct from 'developer' then return jsonb_build_object('ok', false, 'error', 'Not allowed.'); end if;
  if p_km is null or p_km < 1 or p_km > 500 then return jsonb_build_object('ok', false, 'error', 'Choose a distance between 1 and 500 km.'); end if;
  insert into public.platform_config (id) values (1) on conflict (id) do nothing;
  update public.platform_config set max_order_distance_km = round(p_km, 2), order_distance_rule = coalesce(p_on, true) where id = 1;
  begin perform public.ops_audit_add(null, 'developer', auth.uid(), 'order_distance', 'saved', jsonb_build_object('km', p_km, 'on', p_on)); exception when others then null; end;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.dev_set_order_distance(numeric, boolean) from public, anon;
grant execute on function public.dev_set_order_distance(numeric, boolean) to authenticated;

-- ---------- distance ----------
create or replace function public.km_between(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select case when lat1 is null or lng1 is null or lat2 is null or lng2 is null then null else
    2 * 6371.0088 * asin(least(1, sqrt(power(sin(radians(lat2 - lat1) / 2), 2)
      + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))) end
$$;
grant execute on function public.km_between(double precision, double precision, double precision, double precision) to anon, authenticated;

create or replace function public.valid_pin(lat double precision, lng double precision)
returns boolean language sql immutable as $$ select lat is not null and lng is not null and lat between -90 and 90 and lng between -180 and 180 and not (lat = 0 and lng = 0) $$;

-- can THIS customer order from THIS shop from THIS ordering location?
create or replace function public.order_distance_check(p_customer uuid, p_store uuid, p_loc jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_on boolean; v_max numeric; s record; p record; v_mode text := coalesce(nullif(p_loc->>'mode', ''), 'saved');
  v_lat double precision; v_lng double precision; v_km double precision;
begin
  select coalesce(order_distance_rule, true), coalesce(max_order_distance_km, 30) into v_on, v_max from public.platform_config where id = 1;
  v_on := coalesce(v_on, true); v_max := coalesce(v_max, 30);
  if not v_on then return jsonb_build_object('ok', true, 'rule', false); end if;
  select id, name, pickup_lat, pickup_lng into s from public.stores where id = p_store;
  if not found then return jsonb_build_object('ok', false, 'error', 'This shop is no longer available.'); end if;
  if not public.valid_pin(s.pickup_lat, s.pickup_lng) then
    return jsonb_build_object('ok', false, 'code', 'shop_no_location', 'error', s.name || ' hasn''t set its location yet, so it can''t take orders right now.');
  end if;
  if v_mode = 'current' then
    begin v_lat := (p_loc->>'lat')::double precision; v_lng := (p_loc->>'lng')::double precision; exception when others then v_lat := null; end;
    if not public.valid_pin(v_lat, v_lng) then return jsonb_build_object('ok', false, 'code', 'no_location', 'error', 'We couldn''t read your current location. Try again or use your saved location.'); end if;
  elsif v_mode = 'saved' then
    select home_lat, home_lng into p from public.profiles where id = p_customer;
    v_lat := p.home_lat; v_lng := p.home_lng;
    if not public.valid_pin(v_lat, v_lng) then return jsonb_build_object('ok', false, 'code', 'no_location', 'error', 'Please set your saved ordering location first.'); end if;
  else
    return jsonb_build_object('ok', false, 'error', 'Please choose an ordering location.');
  end if;
  -- measured to the nearest metre, so "exactly 30 km" is not lost to rounding
  v_km := round(public.km_between(v_lat, v_lng, s.pickup_lat, s.pickup_lng)::numeric, 3);
  if v_km > v_max then
    return jsonb_build_object('ok', false, 'code', 'too_far', 'km', round(v_km::numeric, 2), 'max', v_max,
      'error', s.name || ' is ' || case when round(v_km::numeric, 1) <= v_max then round(v_km::numeric, 2) else round(v_km::numeric, 1) end || ' km from your ' || case when v_mode = 'current' then 'current' else 'saved' end || ' location. You can order from shops within ' || trim(to_char(v_max, 'FM999990.##')) || ' km.');
  end if;
  return jsonb_build_object('ok', true, 'km', round(v_km::numeric, 2), 'mode', v_mode, 'max', v_max);
end $$;
revoke all on function public.order_distance_check(uuid, uuid, jsonb) from public, anon;
grant execute on function public.order_distance_check(uuid, uuid, jsonb) to authenticated, service_role;

-- the app asks before checkout (same rule as the order)
create or replace function public.check_my_order_distance(p_store uuid, p_loc jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then jsonb_build_object('ok', false, 'error', 'Please sign in.')
              else public.order_distance_check(auth.uid(), p_store, p_loc) end
$$;
revoke all on function public.check_my_order_distance(uuid, jsonb) from public, anon;
grant execute on function public.check_my_order_distance(uuid, jsonb) to authenticated;

-- ---------- enforced on every order ----------
create or replace function public.enforce_order_distance()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_loc jsonb := coalesce(new.delivery_location->'orderLocation', '{"mode":"saved"}'::jsonb); r jsonb;
begin
  -- group orders were checked when the leader created the group (below)
  if new.customer_id is not null and auth.uid() is not null and not (coalesce(new.delivery_location, '{}'::jsonb) ? 'group_code') then
    r := public.order_distance_check(new.customer_id, new.store_id, v_loc);
    if not coalesce((r->>'ok')::boolean, false) then raise exception '%', r->>'error' using errcode = 'P0001'; end if;
    new.delivery_location := coalesce(new.delivery_location, '{}'::jsonb)
      || jsonb_build_object('orderLocation', jsonb_build_object('mode', coalesce(r->>'mode', v_loc->>'mode', 'saved'), 'km', r->'km'));
  elsif new.delivery_location ? 'orderLocation' then
    -- saved by the server (card payment, checked before payment): keep only mode + km
    new.delivery_location := new.delivery_location || jsonb_build_object('orderLocation',
      jsonb_strip_nulls(jsonb_build_object('mode', new.delivery_location->'orderLocation'->>'mode', 'km', new.delivery_location->'orderLocation'->'km')));
  end if;
  return new;
end $$;
revoke all on function public.enforce_order_distance() from public, anon, authenticated;
drop trigger if exists trg_b5_enforce_order_distance on public.orders;
create trigger trg_b5_enforce_order_distance before insert on public.orders
  for each row execute function public.enforce_order_distance();

-- a group order: the leader's saved location
create or replace function public.enforce_group_distance()
returns trigger language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if auth.uid() is not null then
    r := public.order_distance_check(new.leader_id, new.store_id, '{"mode":"saved"}');
    if not coalesce((r->>'ok')::boolean, false) then raise exception '%', r->>'error' using errcode = 'P0001'; end if;
  end if;
  return new;
end $$;
revoke all on function public.enforce_group_distance() from public, anon, authenticated;
drop trigger if exists trg_enforce_group_distance on public.group_orders;
create trigger trg_enforce_group_distance before insert on public.group_orders
  for each row execute function public.enforce_group_distance();

-- ---------- campus coordinates (developer, with a source) ----------
create or replace function public.dev_set_campus_location(p_campus uuid, p_lat double precision, p_lng double precision, p_source text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_src text := nullif(btrim(left(coalesce(p_source, ''), 300)), '');
begin
  if public."current_role"() is distinct from 'developer' then return jsonb_build_object('ok', false, 'error', 'Not allowed.'); end if;
  if p_lat is null and p_lng is null then
    update public.campuses set latitude = null, longitude = null, updated_at = now() where id = p_campus;
  else
    if not public.valid_pin(p_lat, p_lng) or not public.pin_in_sa(p_lat, p_lng) then return jsonb_build_object('ok', false, 'error', 'Put the pin on the campus in South Africa.'); end if;
    if v_src is null then return jsonb_build_object('ok', false, 'error', 'Say where the location comes from (for example the university''s map page).'); end if;
    update public.campuses set latitude = round(p_lat::numeric, 6), longitude = round(p_lng::numeric, 6),
      notes = left(trim(both ' ' from coalesce(notes, '') || ' Pin: ' || v_src || ' (' || to_char(now(), 'YYYY-MM-DD') || ')'), 1000), updated_at = now()
     where id = p_campus;
  end if;
  if not found then return jsonb_build_object('ok', false, 'error', 'Campus not found.'); end if;
  begin perform public.ops_audit_add(null, 'developer', auth.uid(), 'campus_location', 'saved', jsonb_build_object('campus', p_campus)); exception when others then null; end;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.dev_set_campus_location(uuid, double precision, double precision, text) from public, anon;
grant execute on function public.dev_set_campus_location(uuid, double precision, double precision, text) to authenticated;

-- ---------- a student's saved location stays near their campus ----------
-- null = fine (or the campus has no coordinates yet), else the problem
create or replace function public.saved_location_problem(p_campus uuid, p_lat double precision, p_lng double precision)
returns text language plpgsql stable security definer set search_path = public as $$
declare c record; v_max numeric; v_km double precision;
begin
  if p_campus is null or not public.valid_pin(p_lat, p_lng) then return null; end if;
  select full_name, latitude::double precision lat, longitude::double precision lng into c from public.campuses where id = p_campus;
  if not found or c.lat is null then return null; end if;
  select coalesce(max_order_distance_km, 30) into v_max from public.platform_config where id = 1;
  v_km := round(public.km_between(p_lat, p_lng, c.lat, c.lng)::numeric, 3);
  if v_km > coalesce(v_max, 30) then
    return 'Your saved location is ' || round(v_km::numeric, 1) || ' km from ' || c.full_name || '. Choose a place within ' || trim(to_char(coalesce(v_max, 30), 'FM999990.##')) || ' km of your campus.';
  end if;
  return null;
end $$;
grant execute on function public.saved_location_problem(uuid, double precision, double precision) to authenticated;

create or replace function public.check_saved_location()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_problem text;
begin
  if new.role = 'customer' and coalesce(new.is_student, false) and new.campus_id is not null
     and (new.home_lat is distinct from old.home_lat or new.home_lng is distinct from old.home_lng) then
    v_problem := public.saved_location_problem(new.campus_id, new.home_lat, new.home_lng);
    if v_problem is not null then raise exception '%', v_problem using errcode = 'P0001'; end if;
  end if;
  return new;
end $$;
revoke all on function public.check_saved_location() from public, anon, authenticated;
drop trigger if exists trg_check_saved_location on public.profiles;
create trigger trg_check_saved_location before update of home_lat, home_lng on public.profiles
  for each row execute function public.check_saved_location();

-- the student changes campus: if the saved location is now too far, it is
-- cleared and the app asks for a new one (set_my_student_status, adds the check)
create or replace function public.set_my_student_status(p_is_student boolean, p_university uuid default null, p_campus uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_uni public.universities; v_campus public.campuses; v_prof public.profiles; v_problem text;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid and role = 'customer') then
    return jsonb_build_object('ok', false, 'error', 'Please sign in.');
  end if;
  if p_is_student is null then return jsonb_build_object('ok', false, 'error', 'Please choose an answer.'); end if;
  if not p_is_student then
    update public.profiles set is_student = false, university = null, campus_location = null, home_university_id = null, preferred_venue_id = null where id = v_uid;
    return jsonb_build_object('ok', true, 'is_student', false);
  end if;
  select * into v_uni from public.universities where id = p_university and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'Please choose your university.'); end if;
  if p_campus is not null then
    select * into v_campus from public.campuses where id = p_campus and university_id = v_uni.id and active;
    if not found then return jsonb_build_object('ok', false, 'error', 'Please choose a campus of your university.'); end if;
  elsif exists (select 1 from public.campuses where university_id = v_uni.id and active) then
    return jsonb_build_object('ok', false, 'error', 'Please choose your campus.');
  end if;
  select * into v_prof from public.profiles where id = v_uid;
  v_problem := public.saved_location_problem(v_campus.id, v_prof.home_lat, v_prof.home_lng);
  if v_problem is not null then
    -- the old saved location doesn't fit the new campus: ask for a new one
    update public.profiles set home_lat = null, home_lng = null where id = v_uid;
  end if;
  update public.profiles set is_student = true, university = v_uni.name, campus_location = v_campus.name, home_university_id = v_uni.id
   where id = v_uid;
  return jsonb_build_object('ok', true, 'is_student', true, 'university', v_uni.name, 'campus', v_campus.name,
    'needs_location', v_problem is not null, 'message', v_problem);
end $$;
revoke all on function public.set_my_student_status(boolean, uuid, uuid) from public, anon;
grant execute on function public.set_my_student_status(boolean, uuid, uuid) to authenticated;

-- a campus near a point (for "suggest my campus"): only campuses with a pin,
-- only when one is clearly close (<= p_within_km)
create or replace function public.nearest_campus(p_university uuid, p_lat double precision, p_lng double precision, p_within_km numeric default 5)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('id', c.id, 'name', c.full_name, 'km', round(public.km_between(p_lat, p_lng, c.latitude, c.longitude)::numeric, 1))
                     from public.campuses c
                    where c.university_id = p_university and c.active and c.latitude is not null and public.valid_pin(p_lat, p_lng)
                      and public.km_between(p_lat, p_lng, c.latitude, c.longitude) <= p_within_km
                    order by public.km_between(p_lat, p_lng, c.latitude, c.longitude) limit 1), 'null'::jsonb)
$$;
grant execute on function public.nearest_campus(uuid, double precision, double precision, numeric) to authenticated;
